-- 0022_temas.sql · Venus 2.0 · Temas del launcher compartidos por la comunidad
-- Guía: docs/temas.md. Se aplica después de 0012 (moderation_social_block, is_admin). Idempotente.
--
-- Un tema es solo apariencia: color de acento (preset o propio), tinte, fondo de estrellas o un fondo de la galería
-- de Venus (por id), oscurecido y desenfoque. Nunca rutas de la PC ni imágenes propias. Cualquier sesión los lista;
-- se publican con theme_publish (hasta 10 por cuenta, nombre de 2 a 40 caracteres) y se cuentan los usos una vez
-- por cuenta (theme_use). Lo borra su dueño o un admin.

create table if not exists public.community_themes (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 2 and 40),
  data jsonb not null check (jsonb_typeof(data) = 'object' and pg_column_size(data) < 2048),
  uses integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists community_themes_uses on public.community_themes (uses desc, created_at desc);
create index if not exists community_themes_owner on public.community_themes (owner);
alter table public.community_themes enable row level security;
drop policy if exists "community_themes_select" on public.community_themes;
create policy "community_themes_select" on public.community_themes for select to authenticated using (true);
revoke all on public.community_themes from anon, authenticated;
grant select on public.community_themes to authenticated;

create table if not exists public.community_theme_uses (
  theme_id uuid not null references public.community_themes (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  primary key (theme_id, user_id)
);
alter table public.community_theme_uses enable row level security;
revoke all on public.community_theme_uses from anon, authenticated;

create or replace function private.theme_valid(d jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(d) = 'object'
     and not exists (select 1 from jsonb_object_keys(d) k where k not in ('accent', 'customColor', 'tint', 'background', 'wallpaper', 'bgDim', 'bgBlur'))
     and (not d ? 'accent' or (d ->> 'accent') in ('venus', 'mars', 'neptune', 'jupiter', 'earth', 'saturn', 'custom'))
     and (not d ? 'customColor' or (jsonb_typeof(d -> 'customColor') = 'string' and (d ->> 'customColor') ~ '^#[0-9a-fA-F]{6}$'))
     and (not d ? 'tint' or (jsonb_typeof(d -> 'tint') = 'number' and (d ->> 'tint')::numeric between 0 and 100))
     and (not d ? 'background' or (d ->> 'background') in ('stars', 'wallpaper'))
     and (not d ? 'wallpaper' or (jsonb_typeof(d -> 'wallpaper') = 'string' and (d ->> 'wallpaper') ~ '^[A-Za-z0-9._-]{1,80}$'))
     and (not d ? 'bgDim' or (jsonb_typeof(d -> 'bgDim') = 'number' and (d ->> 'bgDim')::numeric between 0 and 100))
     and (not d ? 'bgBlur' or (jsonb_typeof(d -> 'bgBlur') = 'number' and (d ->> 'bgBlur')::numeric between 0 and 100))
$$;

-- Publicar un tema. Errores (22023): bad_name, bad_theme, too_many_themes; 42501: user_banned / user_muted.
create or replace function public.theme_publish(p_name text, p_data jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_name text := btrim(coalesce(p_name, ''));
  v_block text;
  v_id uuid;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  v_block := public.moderation_social_block(me);
  if v_block is not null then raise exception '%', v_block using errcode = '42501'; end if;
  if char_length(v_name) not between 2 and 40 or v_name ~ '[\x00-\x1f<>]' then raise exception 'bad_name' using errcode = '22023'; end if;
  if p_data is null or pg_column_size(p_data) >= 2048 or not private.theme_valid(p_data) then raise exception 'bad_theme' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext('themes:' || me::text));
  if (select count(*) from public.community_themes where owner = me) >= 10 then raise exception 'too_many_themes' using errcode = '22023'; end if;
  insert into public.community_themes (owner, name, data) values (me, v_name, p_data) returning id into v_id;
  return v_id;
end $$;

-- Lista para la galería: { id, name, data, uses, createdAt, owner: { id, username, displayName }, mine }.
create or replace function public.theme_list(p_sort text default 'popular', p_limit integer default 60, p_offset integer default 0)
returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(x.j order by x.o1 desc, x.o2 desc), '[]'::jsonb)
  from (
    select jsonb_build_object('id', t.id, 'name', t.name, 'data', t.data, 'uses', t.uses, 'createdAt', t.created_at,
             'owner', jsonb_build_object('id', p.id, 'username', p.username, 'displayName', p.display_name),
             'mine', t.owner = auth.uid()) as j,
           case when p_sort = 'new' then extract(epoch from t.created_at) else t.uses end as o1,
           extract(epoch from t.created_at) as o2
      from public.community_themes t
      join public.profiles p on p.id = t.owner
     where auth.uid() is not null
       and public.moderation_social_block(t.owner) is distinct from 'user_banned'
     order by case when p_sort = 'new' then extract(epoch from t.created_at) else t.uses end desc, t.created_at desc
     limit least(greatest(coalesce(p_limit, 60), 1), 100) offset greatest(coalesce(p_offset, 0), 0)
  ) x
$$;

-- Cuenta un uso (una vez por cuenta). Devuelve los usos.
create or replace function public.theme_use(p_id uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); v_uses integer;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  insert into public.community_theme_uses (theme_id, user_id) values (p_id, me) on conflict do nothing;
  if found then update public.community_themes set uses = uses + 1 where id = p_id; end if;
  select uses into v_uses from public.community_themes where id = p_id;
  return coalesce(v_uses, 0);
end $$;

-- Borra un tema propio (o cualquiera si sos admin).
create or replace function public.theme_delete(p_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  delete from public.community_themes where id = p_id and (owner = me or public.is_admin());
  return found;
end $$;

revoke all on function public.theme_publish(text, jsonb), public.theme_list(text, integer, integer), public.theme_use(uuid),
  public.theme_delete(uuid) from public, anon;
revoke all on function private.theme_valid(jsonb) from public, anon, authenticated;
grant execute on function public.theme_publish(text, jsonb), public.theme_list(text, integer, integer), public.theme_use(uuid),
  public.theme_delete(uuid) to authenticated;
