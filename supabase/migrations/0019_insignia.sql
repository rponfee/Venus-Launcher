-- 0019_insignia.sql · Venus 1.0.19 · Insignia de Venus dentro del juego
-- Lista opt-in de cuentas de Minecraft (UUID) que muestran el planeta de Venus junto al nombre a otros jugadores
-- que tienen el mod "Venus Badge" (mod/venus-badge). Guía: docs/insignia.md.
--
--   * Anotarse: el launcher pide un desafío (badge_challenge), el juego "entra" al servidor de sesiones de Mojang
--     con ese desafío (como al entrar a un servidor premium) y la Edge Function "badge" le pregunta a Mojang si esa
--     cuenta entró con ese desafío (hasJoined). Así nadie puede anotar un UUID ajeno y el token de Minecraft nunca
--     sale de la PC del jugador. El desafío es de un solo uso, vence a los 2 minutos y se pide uno cada 10 s.
--   * Consultar (badge_lookup): anon o con sesión, hasta 100 UUID por pedido; devuelve solo los que tienen la
--     insignia. Nunca la lista completa ni datos de la cuenta de Venus. Las cuentas baneadas no se muestran.
--   * Borrarse (badge_remove) y ver lo propio (badge_mine): solo con la sesión de la cuenta de Venus dueña.
--   * Las tablas no se leen ni se escriben directo (RLS sin políticas): todo pasa por estas funciones.
-- Se aplica después de 0012 (usa moderation_social_block). Idempotente.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.mc_badges (
  mc_uuid uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  verified_at timestamptz not null default now()
);
create index if not exists mc_badges_user on public.mc_badges (user_id);
alter table public.mc_badges enable row level security;
revoke all on public.mc_badges from anon, authenticated;

create table if not exists public.mc_badge_challenges (
  user_id uuid primary key references auth.users (id) on delete cascade,
  server_id text not null check (server_id ~ '^[0-9a-f]{40}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
alter table public.mc_badge_challenges enable row level security;
revoke all on public.mc_badge_challenges from anon, authenticated;

-- ---------- Consultar (el mod, sin sesión) ----------
create or replace function public.badge_lookup(p_uuids uuid[]) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select b.mc_uuid
    from public.mc_badges b
   where b.mc_uuid = any (coalesce(p_uuids[1:100], '{}'))
     and public.moderation_social_block(b.user_id) is distinct from 'user_banned'
$$;

-- ---------- Con la sesión de Venus ----------
-- Desafío nuevo para anotarse (reemplaza el anterior). Un pedido cada 10 s.
create or replace function public.badge_challenge() returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_id text;
begin
  if v_user is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if public.moderation_social_block(v_user) = 'user_banned' then raise exception 'user_banned' using errcode = '42501'; end if;
  if exists (select 1 from public.mc_badge_challenges c where c.user_id = v_user and c.created_at > now() - interval '10 seconds') then
    raise exception 'too_many_requests' using errcode = '54000';
  end if;
  v_id := encode(extensions.gen_random_bytes(20), 'hex');
  insert into public.mc_badge_challenges (user_id, server_id, created_at, expires_at)
  values (v_user, v_id, now(), now() + interval '2 minutes')
  on conflict (user_id) do update set server_id = excluded.server_id, created_at = excluded.created_at, expires_at = excluded.expires_at;
  return v_id;
end $$;

-- Cuentas de Minecraft anotadas por quien llama.
create or replace function public.badge_mine() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select b.mc_uuid from public.mc_badges b where b.user_id = auth.uid() order by b.created_at
$$;

-- Borra una cuenta anotada por quien llama, o todas con null. Devuelve cuántas borró.
create or replace function public.badge_remove(p_uuid uuid default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  delete from public.mc_badges b where b.user_id = auth.uid() and (p_uuid is null or b.mc_uuid = p_uuid);
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- ---------- Solo la Edge Function "badge" (service role; anon y authenticated no pueden ejecutarlas) ----------
-- Gasta el desafío: true si era de ese usuario y no había vencido. Se gasta aunque después falle Mojang.
create or replace function public.badge_take_challenge(p_user uuid, p_server_id text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_found boolean;
begin
  delete from public.mc_badge_challenges c
   where c.user_id = p_user and c.server_id = p_server_id and c.expires_at > now()
  returning true into v_found;
  delete from public.mc_badge_challenges c where c.user_id = p_user and c.expires_at <= now();
  return coalesce(v_found, false);
end $$;

-- Anota (o renueva) la cuenta de Minecraft ya verificada con Mojang. Si estaba anotada por otra cuenta de Venus,
-- pasa a esta: quien prueba que es dueño de la cuenta de Minecraft ahora es quien manda.
create or replace function public.badge_enroll(p_user uuid, p_uuid uuid) returns text
language plpgsql security definer set search_path = '' as $$
begin
  if public.moderation_social_block(p_user) = 'user_banned' then return 'user_banned'; end if;
  perform pg_advisory_xact_lock(hashtext('mc_badges:' || p_user::text));
  if not exists (select 1 from public.mc_badges b where b.mc_uuid = p_uuid and b.user_id = p_user)
     and (select count(*) from public.mc_badges b where b.user_id = p_user) >= 5 then -- tope de cuentas por usuario
    return 'too_many_accounts';
  end if;
  insert into public.mc_badges (mc_uuid, user_id, created_at, verified_at)
  values (p_uuid, p_user, now(), now())
  on conflict (mc_uuid) do update
    set user_id = excluded.user_id,
        verified_at = now(),
        created_at = case when public.mc_badges.user_id = excluded.user_id then public.mc_badges.created_at else now() end;
  return 'ok';
end $$;

-- ---------- Permisos ----------
-- En Supabase las funciones nuevas de public quedan ejecutables por anon y authenticated: se les quita a todos y se
-- da solo lo justo.
revoke all on function public.badge_lookup(uuid[]) from public, anon, authenticated;
revoke all on function public.badge_challenge() from public, anon, authenticated;
revoke all on function public.badge_mine() from public, anon, authenticated;
revoke all on function public.badge_remove(uuid) from public, anon, authenticated;
revoke all on function public.badge_take_challenge(uuid, text) from public, anon, authenticated;
revoke all on function public.badge_enroll(uuid, uuid) from public, anon, authenticated;
grant execute on function public.badge_lookup(uuid[]) to anon, authenticated;
grant execute on function public.badge_challenge() to authenticated;
grant execute on function public.badge_mine() to authenticated;
grant execute on function public.badge_remove(uuid) to authenticated;
grant execute on function public.badge_take_challenge(uuid, text) to service_role;
grant execute on function public.badge_enroll(uuid, uuid) to service_role;
