-- 0021_puntos.sql · Venus 2.0 · Venus Points, invitaciones, logros, tienda y estilo de la insignia
-- Guía: docs/venus-points.md. Se aplica después de 0020 (shop_items, user_items, venus_is_premium) y 0019 (mc_badges).
-- Idempotente.
--
--   * Puntos: un libro (points_ledger) donde cada premio tiene (motivo, ref) único: el mismo premio nunca se da dos
--     veces. El saldo es la suma. Premium duplica lo diario y los logros (no las invitaciones).
--   * Invitaciones: cada usuario tiene un código VP-XXXXXX. Quien se crea una cuenta lo canjea en sus primeros 14 días.
--     Los puntos llegan recién cuando el invitado verifica una cuenta de Minecraft con Mojang (Edge Function
--     mcverify o al activar la insignia) que nunca se usó en otra invitación y que el que invita nunca verificó.
--     Así una cuenta de Venus nueva sin Minecraft real no da nada.
--   * Logros: los que el servidor puede comprobar se comprueban; los de la PC (horas jugadas, primera captura...) se
--     aceptan una sola vez y con pocos puntos, como mucho 10 por día.
--   * Tienda: cosméticos que se compran con puntos (marcos, efectos del nombre, estilos de la insignia, títulos). Los
--     marcados premium_only vienen incluidos con premium y no se compran.
--   * badge_styles(): como badge_lookup (0019) pero con el estilo de cada insignia ('gold' para premium o el comprado).

-- ---------- Libro de puntos ----------
create table if not exists public.points_ledger (
  id bigserial primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  delta integer not null check (delta between -1000000 and 1000000 and delta <> 0),
  reason text not null check (reason in ('daily', 'achievement', 'referral', 'referred', 'shop', 'admin')),
  ref text not null check (char_length(ref) between 1 and 80),
  created_at timestamptz not null default now(),
  unique (user_id, reason, ref)
);
create index if not exists points_ledger_user on public.points_ledger (user_id, created_at desc);
alter table public.points_ledger enable row level security;
drop policy if exists "points_ledger_select_own" on public.points_ledger;
create policy "points_ledger_select_own" on public.points_ledger for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.points_ledger from anon, authenticated;
grant select on public.points_ledger to authenticated;

create or replace function private.points_balance(p_user uuid) returns integer
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(l.delta), 0)::integer from public.points_ledger l where l.user_id = p_user
$$;

create or replace function private.points_mult(p_user uuid) returns integer
language sql stable security definer set search_path = '' as $$
  select case when public.venus_is_premium(p_user) then 2 else 1 end
$$;

-- Da puntos una sola vez por (motivo, ref). Devuelve los puntos dados (0 si ya estaban).
create or replace function private.points_award(p_user uuid, p_delta integer, p_reason text, p_ref text) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_id bigint;
begin
  insert into public.points_ledger (user_id, delta, reason, ref) values (p_user, p_delta, p_reason, p_ref)
  on conflict (user_id, reason, ref) do nothing
  returning id into v_id;
  return case when v_id is null then 0 else p_delta end;
end $$;

-- ---------- Cuentas de Minecraft verificadas con Mojang ----------
create table if not exists public.mc_verified (
  mc_uuid uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  verified_at timestamptz not null default now()
);
create index if not exists mc_verified_user on public.mc_verified (user_id);
alter table public.mc_verified enable row level security;
revoke all on public.mc_verified from anon, authenticated;

-- Historial (solo se agrega): quién verificó cada cuenta alguna vez. Sin FK: tiene que sobrevivir a borrar cuentas.
create table if not exists public.mc_verify_log (
  mc_uuid uuid not null,
  user_id uuid not null,
  at timestamptz not null default now(),
  primary key (mc_uuid, user_id)
);
alter table public.mc_verify_log enable row level security;
revoke all on public.mc_verify_log from anon, authenticated;

-- ---------- Invitaciones ----------
create table if not exists public.referral_codes (
  user_id uuid primary key references auth.users (id) on delete cascade,
  code text not null unique check (code ~ '^VP-[A-HJ-NP-Z2-9]{6}$'),
  created_at timestamptz not null default now()
);
alter table public.referral_codes enable row level security;
revoke all on public.referral_codes from anon, authenticated;

create table if not exists public.referrals (
  referred uuid primary key references auth.users (id) on delete cascade,
  referrer uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  mc_uuid uuid unique,
  rewarded_at timestamptz,
  check (referred <> referrer)
);
create index if not exists referrals_referrer on public.referrals (referrer, created_at desc);
alter table public.referrals enable row level security;
revoke all on public.referrals from anon, authenticated;

-- Premia una invitación pendiente si el invitado ya tiene una cuenta de Minecraft verificada que sirva.
create or replace function private.referral_try_reward(p_user uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_uuid uuid;
begin
  select * into r from public.referrals where referred = p_user and rewarded_at is null for update;
  if not found then return false; end if;
  if public.moderation_social_block(r.referrer) = 'user_banned' then return false; end if;
  -- Tope: 100 invitaciones premiadas por cuenta
  if (select count(*) from public.referrals x where x.referrer = r.referrer and x.rewarded_at is not null) >= 100 then return false; end if;
  select v.mc_uuid into v_uuid
    from public.mc_verified v
   where v.user_id = p_user
     and not exists (select 1 from public.referrals x where x.mc_uuid = v.mc_uuid)
     and not exists (select 1 from public.mc_verify_log lg where lg.mc_uuid = v.mc_uuid and lg.user_id = r.referrer)
   order by v.verified_at
   limit 1;
  if v_uuid is null then return false; end if;
  update public.referrals set mc_uuid = v_uuid, rewarded_at = now() where referred = p_user;
  perform private.points_award(r.referrer, 500, 'referral', p_user::text);
  perform private.points_award(p_user, 200, 'referred', r.referrer::text);
  return true;
end $$;

-- Registra una cuenta de Minecraft verificada con Mojang (la llaman la Edge Function mcverify y badge_enroll).
create or replace function public.mc_verify_record(p_user uuid, p_uuid uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_rewarded boolean;
begin
  if public.moderation_social_block(p_user) = 'user_banned' then return jsonb_build_object('result', 'user_banned'); end if;
  insert into public.mc_verified (mc_uuid, user_id, verified_at) values (p_uuid, p_user, now())
  on conflict (mc_uuid) do update set user_id = excluded.user_id, verified_at = now();
  insert into public.mc_verify_log (mc_uuid, user_id) values (p_uuid, p_user) on conflict do nothing;
  v_rewarded := private.referral_try_reward(p_user);
  return jsonb_build_object('result', 'ok', 'rewarded', v_rewarded);
end $$;

-- La insignia (0019) también prueba que la cuenta es de quien la anota: cuenta como verificación.
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
  perform public.mc_verify_record(p_user, p_uuid);
  return 'ok';
end $$;

-- Código de invitación propio (lo crea la primera vez).
create or replace function public.referral_my_code() returns text
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_code text;
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  i integer;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  select code into v_code from public.referral_codes where user_id = me;
  if v_code is not null then return v_code; end if;
  loop
    v_code := 'VP-';
    for i in 1..6 loop
      v_code := v_code || substr(alphabet, 1 + (get_byte(extensions.gen_random_bytes(1), 0) % 32), 1);
    end loop;
    begin
      insert into public.referral_codes (user_id, code) values (me, v_code);
      return v_code;
    exception when unique_violation then
      select code into v_code from public.referral_codes where user_id = me;
      if v_code is not null then return v_code; end if;
    end;
  end loop;
end $$;

-- Canjear el código de quien te invitó. Errores (22023): bad_code, own_code, already_referred, too_late, loop.
create or replace function public.referral_claim(p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_referrer uuid;
  v_created timestamptz;
  v_rewarded boolean;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if public.moderation_social_block(me) = 'user_banned' then raise exception 'user_banned' using errcode = '42501'; end if;
  select user_id into v_referrer from public.referral_codes where code = upper(btrim(coalesce(p_code, '')));
  if v_referrer is null then raise exception 'bad_code' using errcode = '22023'; end if;
  if v_referrer = me then raise exception 'own_code' using errcode = '22023'; end if;
  if exists (select 1 from public.referrals where referred = me) then raise exception 'already_referred' using errcode = '22023'; end if;
  select created_at into v_created from auth.users where id = me;
  if v_created < now() - interval '14 days' then raise exception 'too_late' using errcode = '22023'; end if;
  if exists (select 1 from public.referrals where referred = v_referrer and referrer = me) then raise exception 'loop' using errcode = '22023'; end if;
  insert into public.referrals (referred, referrer) values (me, v_referrer);
  v_rewarded := private.referral_try_reward(me);
  return jsonb_build_object('ok', true, 'rewarded', v_rewarded);
end $$;

-- ---------- Logros ----------
create table if not exists public.achievements (
  id text primary key check (id ~ '^[a-z0-9_]{2,40}$'),
  points integer not null check (points between 0 and 10000),
  check_kind text not null check (check_kind in ('server', 'client')),
  sort integer not null default 0,
  active boolean not null default true
);
alter table public.achievements enable row level security;
drop policy if exists "achievements_select" on public.achievements;
create policy "achievements_select" on public.achievements for select to authenticated using (active);
revoke all on public.achievements from anon, authenticated;
grant select on public.achievements to authenticated;

create table if not exists public.user_achievements (
  user_id uuid not null references auth.users (id) on delete cascade,
  achievement_id text not null references public.achievements (id) on update cascade on delete cascade,
  unlocked_at timestamptz not null default now(),
  primary key (user_id, achievement_id)
);
alter table public.user_achievements enable row level security;
drop policy if exists "user_achievements_select_own" on public.user_achievements;
create policy "user_achievements_select_own" on public.user_achievements for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.user_achievements from anon, authenticated;
grant select on public.user_achievements to authenticated;

insert into public.achievements (id, points, check_kind, sort) values
  ('first_launch', 50, 'client', 10),
  ('playtime_10h', 100, 'client', 20),
  ('playtime_100h', 400, 'client', 30),
  ('instances_5', 50, 'client', 40),
  ('first_screenshot', 25, 'client', 50),
  ('first_clip', 50, 'client', 60),
  ('first_party', 75, 'client', 70),
  ('skin_created', 50, 'client', 80),
  ('profile_complete', 100, 'server', 90),
  ('first_friend', 50, 'server', 100),
  ('five_friends', 150, 'server', 110),
  ('mc_verified', 100, 'server', 120),
  ('badge_on', 50, 'server', 130),
  ('first_share', 50, 'server', 140),
  ('first_referral', 200, 'server', 150),
  ('five_referrals', 1000, 'server', 160),
  ('theme_published', 100, 'server', 170),
  ('premium', 300, 'server', 180)
on conflict (id) do update set points = excluded.points, check_kind = excluded.check_kind, sort = excluded.sort;

create or replace function private.achievement_met(p_user uuid, p_id text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  return case p_id
    when 'profile_complete' then exists (select 1 from public.profiles p where p.id = p_user and p.bio is not null
      and (p.pronouns is not null or p.theme <> '{}'::jsonb) and p.banner_style <> '{}'::jsonb)
    when 'first_friend' then (select count(*) from public.friendships f where f.status = 'accepted' and p_user in (f.requester, f.addressee)) >= 1
    when 'five_friends' then (select count(*) from public.friendships f where f.status = 'accepted' and p_user in (f.requester, f.addressee)) >= 5
    when 'mc_verified' then exists (select 1 from public.mc_verified v where v.user_id = p_user)
    when 'badge_on' then exists (select 1 from public.mc_badges b where b.user_id = p_user)
    when 'first_share' then exists (select 1 from public.shared_media m where m.owner = p_user)
    when 'first_referral' then (select count(*) from public.referrals r where r.referrer = p_user and r.rewarded_at is not null) >= 1
    when 'five_referrals' then (select count(*) from public.referrals r where r.referrer = p_user and r.rewarded_at is not null) >= 5
    when 'theme_published' then exists (select 1 from public.community_themes t where t.owner = p_user)
    when 'premium' then public.venus_is_premium(p_user)
    else false
  end;
end $$;

-- Desbloquea un logro y da sus puntos. Errores (22023): bad_achievement, not_met, too_many_today.
create or replace function public.achievement_claim(p_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  a record;
  v_points integer;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if public.moderation_social_block(me) = 'user_banned' then raise exception 'user_banned' using errcode = '42501'; end if;
  select * into a from public.achievements where id = p_id and active;
  if not found then raise exception 'bad_achievement' using errcode = '22023'; end if;
  if exists (select 1 from public.user_achievements where user_id = me and achievement_id = p_id) then
    return jsonb_build_object('unlocked', true, 'points', 0, 'already', true);
  end if;
  if a.check_kind = 'server' then
    if not private.achievement_met(me, p_id) then raise exception 'not_met' using errcode = '22023'; end if;
  elsif (select count(*) from public.user_achievements ua join public.achievements x on x.id = ua.achievement_id
          where ua.user_id = me and x.check_kind = 'client' and ua.unlocked_at > now() - interval '1 day') >= 10 then
    raise exception 'too_many_today' using errcode = '22023';
  end if;
  insert into public.user_achievements (user_id, achievement_id) values (me, p_id) on conflict do nothing;
  v_points := private.points_award(me, a.points * private.points_mult(me), 'achievement', p_id);
  return jsonb_build_object('unlocked', true, 'points', v_points, 'balance', private.points_balance(me));
end $$;

-- ---------- Premio diario ----------
-- 10 puntos por día (UTC) + 5 por cada día seguido, hasta +25; premium x2. Devuelve { points, streak, balance }.
create or replace function public.points_daily_claim() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  today date := (now() at time zone 'utc')::date;
  v_streak integer := 0;
  d date;
  v_points integer;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if public.moderation_social_block(me) = 'user_banned' then raise exception 'user_banned' using errcode = '42501'; end if;
  if exists (select 1 from public.points_ledger where user_id = me and reason = 'daily' and ref = today::text) then
    return jsonb_build_object('points', 0, 'already', true, 'balance', private.points_balance(me));
  end if;
  d := today - 1;
  while v_streak < 30 and exists (select 1 from public.points_ledger where user_id = me and reason = 'daily' and ref = d::text) loop
    v_streak := v_streak + 1;
    d := d - 1;
  end loop;
  v_points := private.points_award(me, (10 + least(v_streak * 5, 25)) * private.points_mult(me), 'daily', today::text);
  return jsonb_build_object('points', v_points, 'streak', v_streak + 1, 'balance', private.points_balance(me));
end $$;

-- ---------- Resumen para la interfaz ----------
create or replace function public.points_me() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  today date := (now() at time zone 'utc')::date;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  return jsonb_build_object(
    'balance', private.points_balance(me),
    'premium', public.venus_is_premium(me),
    'multiplier', private.points_mult(me),
    'dailyClaimed', exists (select 1 from public.points_ledger where user_id = me and reason = 'daily' and ref = today::text),
    'referralCode', (select code from public.referral_codes where user_id = me),
    'referredBy', (select jsonb_build_object('username', p.username, 'rewarded', r.rewarded_at is not null)
                     from public.referrals r join public.profiles p on p.id = r.referrer where r.referred = me),
    'canClaimReferral', not exists (select 1 from public.referrals where referred = me)
                        and (select created_at from auth.users where id = me) > now() - interval '14 days',
    'referrals', jsonb_build_object(
      'total', (select count(*) from public.referrals where referrer = me),
      'rewarded', (select count(*) from public.referrals where referrer = me and rewarded_at is not null)),
    'mcVerified', exists (select 1 from public.mc_verified where user_id = me),
    'achievements', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'points', a.points, 'kind', a.check_kind,
                                'unlockedAt', ua.unlocked_at) order by a.sort)
                                from public.achievements a
                                left join public.user_achievements ua on ua.achievement_id = a.id and ua.user_id = me
                               where a.active), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(ui.item_id) from public.user_items ui where ui.user_id = me), '[]'::jsonb),
    'history', coalesce((select jsonb_agg(jsonb_build_object('delta', l.delta, 'reason', l.reason, 'ref', l.ref, 'at', l.created_at)
                                order by l.created_at desc)
                           from (select * from public.points_ledger where user_id = me order by created_at desc limit 30) l), '[]'::jsonb));
end $$;

-- ---------- Tienda ----------
insert into public.shop_items (id, kind, price, premium_only, sort, data) values
  ('frame_pixel', 'frame', 500, false, 10, '{"style":"pixel"}'),
  ('frame_neon', 'frame', 800, false, 20, '{"style":"neon"}'),
  ('frame_gold', 'frame', 1500, false, 30, '{"style":"gold"}'),
  ('frame_venus', 'frame', 0, true, 40, '{"style":"venus"}'),
  ('effect_shimmer', 'name_effect', 1200, false, 50, '{"effect":"shimmer"}'),
  ('effect_rainbow', 'name_effect', 2000, false, 60, '{"effect":"rainbow"}'),
  ('effect_fire', 'name_effect', 2500, false, 70, '{"effect":"fire"}'),
  ('badge_nebula', 'badge_style', 1000, false, 80, '{"style":"nebula"}'),
  ('badge_ice', 'badge_style', 1000, false, 90, '{"style":"ice"}'),
  ('badge_gold', 'badge_style', 0, true, 100, '{"style":"gold"}'),
  ('title_explorer', 'title', 300, false, 110, '{"title":"explorer"}'),
  ('title_builder', 'title', 300, false, 120, '{"title":"builder"}'),
  ('title_redstoner', 'title', 600, false, 130, '{"title":"redstoner"}'),
  ('title_legend', 'title', 3000, false, 140, '{"title":"legend"}'),
  ('title_supporter', 'title', 0, true, 150, '{"title":"supporter"}')
on conflict (id) do update set kind = excluded.kind, price = excluded.price, premium_only = excluded.premium_only,
  sort = excluded.sort, data = excluded.data;

-- Comprar con puntos. Errores (22023): bad_item, premium_item, owned, not_enough_points.
create or replace function public.shop_buy(p_item text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  it record;
  v_balance integer;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if public.moderation_social_block(me) = 'user_banned' then raise exception 'user_banned' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtext('points:' || me::text));
  select * into it from public.shop_items where id = p_item and active;
  if not found then raise exception 'bad_item' using errcode = '22023'; end if;
  if it.premium_only then raise exception 'premium_item' using errcode = '22023'; end if;
  if exists (select 1 from public.user_items where user_id = me and item_id = p_item) then raise exception 'owned' using errcode = '22023'; end if;
  v_balance := private.points_balance(me);
  if v_balance < it.price then raise exception 'not_enough_points' using errcode = '22023'; end if;
  if it.price > 0 then perform private.points_award(me, -it.price, 'shop', p_item); end if;
  insert into public.user_items (user_id, item_id) values (me, p_item);
  return jsonb_build_object('ok', true, 'balance', private.points_balance(me));
end $$;

-- ---------- Estilo de la insignia en el juego ----------
-- Como badge_lookup (0019) pero con el estilo: 'gold' para premium, el comprado y equipado, o 'default'.
create or replace function public.badge_styles(p_uuids uuid[])
returns table (mc_uuid uuid, style text)
language sql stable security definer set search_path = '' as $$
  select b.mc_uuid,
         case
           when public.venus_is_premium(b.user_id) and coalesce(p.equipped ->> 'badgeStyle', 'badge_gold') = 'badge_gold' then 'gold'
           when si.id is not null then coalesce(si.data ->> 'style', 'default')
           else 'default'
         end
    from public.mc_badges b
    join public.profiles p on p.id = b.user_id
    left join public.shop_items si on si.id = p.equipped ->> 'badgeStyle' and si.kind = 'badge_style'
         and (exists (select 1 from public.user_items ui where ui.user_id = b.user_id and ui.item_id = si.id)
              or (si.premium_only and public.venus_is_premium(b.user_id)))
   where b.mc_uuid = any (coalesce(p_uuids[1:100], '{}'))
     and public.moderation_social_block(b.user_id) is distinct from 'user_banned'
$$;

-- ---------- Permisos ----------
-- En Supabase las funciones nuevas de public quedan ejecutables por anon y authenticated: se les quita y se da lo justo.
revoke all on function public.mc_verify_record(uuid, uuid) from public, anon, authenticated;
revoke all on function public.badge_enroll(uuid, uuid) from public, anon, authenticated;
revoke all on function public.referral_my_code() from public, anon;
revoke all on function public.referral_claim(text) from public, anon;
revoke all on function public.achievement_claim(text) from public, anon;
revoke all on function public.points_daily_claim() from public, anon;
revoke all on function public.points_me() from public, anon;
revoke all on function public.shop_buy(text) from public, anon;
revoke all on function public.badge_styles(uuid[]) from public;
revoke all on function private.points_balance(uuid), private.points_mult(uuid), private.points_award(uuid, integer, text, text),
  private.referral_try_reward(uuid), private.achievement_met(uuid, text) from public, anon, authenticated;
grant execute on function public.mc_verify_record(uuid, uuid) to service_role;
grant execute on function public.badge_enroll(uuid, uuid) to service_role;
grant execute on function public.referral_my_code() to authenticated;
grant execute on function public.referral_claim(text) to authenticated;
grant execute on function public.achievement_claim(text) to authenticated;
grant execute on function public.points_daily_claim() to authenticated;
grant execute on function public.points_me() to authenticated;
grant execute on function public.shop_buy(text) to authenticated;
grant execute on function public.badge_styles(uuid[]) to anon, authenticated;
