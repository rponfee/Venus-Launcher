-- 0020_perfiles.sql · Venus 2.0 · Perfiles a fondo y Venus Premium
-- Guía: docs/perfiles.md. Se aplica después de 0019 (usa ai_effective_plan de 0008 y moderation_social_block de 0012).
-- Idempotente.
--
--   * Premium = tener un plan de Venus vigente (ai_effective_plan, el mismo que habilita la IA). venus_is_premium()
--     lo dice para cualquier usuario: es público como la insignia del perfil.
--   * Perfil: pronombres, colores del degradado, estilo del nombre (tipografía, efecto, color y brillo), banner
--     (preset, imagen o animado), servidores favoritos, estadísticas publicadas (opt-in), capturas destacadas y los
--     cosméticos equipados (de la tienda de 0021). Se leen como el resto del perfil (cualquier sesión) y se escriben
--     SOLO con profile_customize(), que valida todo del lado del servidor (formatos, largos, premium y lo comprado).
--   * Bucket público profile-media (banners y capturas destacadas): cada usuario escribe solo en su carpeta, hasta 12
--     archivos de 4 MB; los GIF (banners animados) solo con premium.

create schema if not exists private;

-- ---------- Premium ----------
create or replace function public.venus_is_premium(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_user is not null and public.ai_effective_plan(p_user) is not null
$$;

-- ---------- Columnas nuevas del perfil ----------
alter table public.profiles add column if not exists pronouns text check (char_length(pronouns) <= 24);
-- { from: '#rrggbb', to: '#rrggbb', angle: 0..360 } (el "fade" del perfil)
alter table public.profiles add column if not exists theme jsonb not null default '{}'::jsonb;
-- { font, effect, color: '#rrggbb', glow: 0..100 }
alter table public.profiles add column if not exists name_style jsonb not null default '{}'::jsonb;
-- { kind: 'preset' | 'image' | 'animated', preset?, url? }
alter table public.profiles add column if not exists banner_style jsonb not null default '{}'::jsonb;
-- [{ address, name? }] hasta 5
alter table public.profiles add column if not exists favorite_servers jsonb not null default '[]'::jsonb;
-- null = no publica; { hours, sessions, topVersion, topLoader, since, updatedAt }
alter table public.profiles add column if not exists public_stats jsonb;
-- [{ url, title? }] hasta 3 capturas en profile-media
alter table public.profiles add column if not exists featured jsonb not null default '[]'::jsonb;
-- { frame?, nameEffect?, badgeStyle?, title? }: ids de shop_items (0021) que el usuario tiene
alter table public.profiles add column if not exists equipped jsonb not null default '{}'::jsonb;
alter table public.profiles add column if not exists customized_at timestamptz;

-- Tamaño razonable de los jsonb (por si alguien llega a escribirlos por otro camino)
do $$ begin
  alter table public.profiles add constraint profiles_custom_size check (
    pg_column_size(theme) < 512 and pg_column_size(name_style) < 512 and pg_column_size(banner_style) < 1024
    and pg_column_size(favorite_servers) < 2048 and coalesce(pg_column_size(public_stats), 0) < 1024
    and pg_column_size(featured) < 2048 and pg_column_size(equipped) < 512);
exception when duplicate_object then null; end $$;

-- ---------- Cosméticos (el catálogo y las compras con Venus Points están en 0021) ----------
create table if not exists public.shop_items (
  id text primary key check (id ~ '^[a-z0-9_-]{2,40}$'),
  kind text not null check (kind in ('frame', 'name_effect', 'badge_style', 'title', 'banner')),
  price integer not null check (price >= 0),
  premium_only boolean not null default false,
  active boolean not null default true,
  sort integer not null default 0,
  data jsonb not null default '{}'::jsonb check (pg_column_size(data) < 1024),
  created_at timestamptz not null default now()
);
alter table public.shop_items enable row level security;
drop policy if exists "shop_items_select" on public.shop_items;
create policy "shop_items_select" on public.shop_items for select to authenticated using (active);
revoke all on public.shop_items from anon, authenticated;
grant select on public.shop_items to authenticated;

create table if not exists public.user_items (
  user_id uuid not null references auth.users (id) on delete cascade,
  item_id text not null references public.shop_items (id) on update cascade on delete cascade,
  acquired_at timestamptz not null default now(),
  primary key (user_id, item_id)
);
alter table public.user_items enable row level security;
drop policy if exists "user_items_select_own" on public.user_items;
create policy "user_items_select_own" on public.user_items for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.user_items from anon, authenticated;
grant select on public.user_items to authenticated;

-- ---------- Validación ----------
create or replace function private.hex_color(v jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(v) = 'string' and (v #>> '{}') ~ '^#[0-9a-fA-F]{6}$'
$$;

-- URL pública de profile-media de ese usuario (lo único que se acepta como banner o captura destacada)
create or replace function private.own_media_url(p_user uuid, v jsonb) returns boolean
language sql stable set search_path = '' as $$
  select jsonb_typeof(v) = 'string'
     and char_length(v #>> '{}') <= 400
     and (v #>> '{}') ~ ('^https://[a-z0-9]+\.supabase\.co/storage/v1/object/public/profile-media/' || p_user::text || '/[A-Za-z0-9._-]{1,80}$')
$$;

-- Fuentes y efectos que conoce el launcher (los premium marcados con *: solo premium o comprados en la tienda)
create or replace function private.profile_fonts() returns text[]
language sql immutable set search_path = '' as $$ select array['default', 'pixel', 'outfit', 'serif', 'mono', 'rounded', 'condensed'] $$;
create or replace function private.profile_effects() returns text[]
language sql immutable set search_path = '' as $$ select array['none', 'glow', 'gradient', 'shimmer', 'rainbow', 'fire'] $$;
create or replace function private.profile_effects_premium() returns text[]
language sql immutable set search_path = '' as $$ select array['shimmer', 'rainbow', 'fire'] $$;
create or replace function private.profile_banners() returns text[]
language sql immutable set search_path = '' as $$ select array['stars', 'sunset', 'nebula', 'forest', 'ocean', 'nether', 'end', 'aurora'] $$;

/**
 * Cambia la personalización del perfil de quien llama. p_patch solo trae lo que cambia:
 *   pronouns, bio, theme, nameStyle, banner, favoriteServers, publicStats (objeto o null), featured, equipped.
 * Devuelve el perfil personalizado. Errores (errcode 22023): 'bad_<campo>', 'premium_required:<campo>',
 * 'not_owned:<item>'; 'user_banned' / 'user_muted' (42501) para quien no puede usar lo social.
 */
create or replace function public.profile_customize(p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  premium boolean;
  v jsonb;
  k text;
  el jsonb;
  n integer;
  v_block text;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  v_block := public.moderation_social_block(me);
  if v_block is not null then raise exception '%', v_block using errcode = '42501'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or pg_column_size(p_patch) > 8192 then
    raise exception 'bad_request' using errcode = '22023';
  end if;
  premium := public.venus_is_premium(me);

  for k in select jsonb_object_keys(p_patch) loop
    if k not in ('pronouns', 'bio', 'theme', 'nameStyle', 'banner', 'favoriteServers', 'publicStats', 'featured', 'equipped') then
      raise exception 'bad_field:%', k using errcode = '22023';
    end if;
  end loop;

  if p_patch ? 'pronouns' then
    v := p_patch -> 'pronouns';
    if jsonb_typeof(v) = 'null' or btrim(v #>> '{}') = '' then
      update public.profiles set pronouns = null where id = me;
    elsif jsonb_typeof(v) <> 'string' or char_length(btrim(v #>> '{}')) > 24 or (v #>> '{}') ~ '[\x00-\x1f<>]' then
      raise exception 'bad_pronouns' using errcode = '22023';
    else
      update public.profiles set pronouns = btrim(v #>> '{}') where id = me;
    end if;
  end if;

  if p_patch ? 'bio' then
    v := p_patch -> 'bio';
    if jsonb_typeof(v) = 'null' then
      update public.profiles set bio = null where id = me;
    elsif jsonb_typeof(v) <> 'string' or char_length(v #>> '{}') > 200 then
      raise exception 'bad_bio' using errcode = '22023';
    else
      update public.profiles set bio = nullif(btrim(v #>> '{}'), '') where id = me;
    end if;
  end if;

  if p_patch ? 'theme' then
    v := p_patch -> 'theme';
    if jsonb_typeof(v) <> 'object'
       or (v ? 'from' and not private.hex_color(v -> 'from'))
       or (v ? 'to' and not private.hex_color(v -> 'to'))
       or (v ? 'angle' and (jsonb_typeof(v -> 'angle') <> 'number' or (v ->> 'angle')::numeric not between 0 and 360))
       or exists (select 1 from jsonb_object_keys(v) x where x not in ('from', 'to', 'angle')) then
      raise exception 'bad_theme' using errcode = '22023';
    end if;
    update public.profiles set theme = v where id = me;
  end if;

  if p_patch ? 'nameStyle' then
    v := p_patch -> 'nameStyle';
    if jsonb_typeof(v) <> 'object'
       or (v ? 'font' and (jsonb_typeof(v -> 'font') <> 'string' or not ((v ->> 'font') = any (private.profile_fonts()))))
       or (v ? 'effect' and (jsonb_typeof(v -> 'effect') <> 'string' or not ((v ->> 'effect') = any (private.profile_effects()))))
       or (v ? 'color' and not private.hex_color(v -> 'color'))
       or (v ? 'glow' and (jsonb_typeof(v -> 'glow') <> 'number' or (v ->> 'glow')::numeric not between 0 and 100))
       or exists (select 1 from jsonb_object_keys(v) x where x not in ('font', 'effect', 'color', 'glow')) then
      raise exception 'bad_nameStyle' using errcode = '22023';
    end if;
    if (v ->> 'effect') = any (private.profile_effects_premium()) and not premium
       and not exists (select 1 from public.user_items ui join public.shop_items si on si.id = ui.item_id
                        where ui.user_id = me and si.kind = 'name_effect' and si.data ->> 'effect' = v ->> 'effect') then
      raise exception 'premium_required:nameStyle' using errcode = '22023';
    end if;
    update public.profiles set name_style = v where id = me;
  end if;

  if p_patch ? 'banner' then
    v := p_patch -> 'banner';
    if jsonb_typeof(v) <> 'object' or not (v ? 'kind') then raise exception 'bad_banner' using errcode = '22023'; end if;
    if v ->> 'kind' = 'preset' then
      if not ((v ->> 'preset') = any (private.profile_banners())) then raise exception 'bad_banner' using errcode = '22023'; end if;
      v := jsonb_build_object('kind', 'preset', 'preset', v ->> 'preset');
    elsif v ->> 'kind' in ('image', 'animated') then
      if not private.own_media_url(me, v -> 'url') then raise exception 'bad_banner' using errcode = '22023'; end if;
      if v ->> 'kind' = 'animated' and not premium then raise exception 'premium_required:banner' using errcode = '22023'; end if;
      v := jsonb_build_object('kind', v ->> 'kind', 'url', v ->> 'url');
    elsif v ->> 'kind' = 'none' then
      v := '{}'::jsonb;
    else
      raise exception 'bad_banner' using errcode = '22023';
    end if;
    update public.profiles set banner_style = v where id = me;
  end if;

  if p_patch ? 'favoriteServers' then
    v := p_patch -> 'favoriteServers';
    if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) > 5 then raise exception 'bad_favoriteServers' using errcode = '22023'; end if;
    for el in select * from jsonb_array_elements(v) loop
      if jsonb_typeof(el) <> 'object'
         or jsonb_typeof(el -> 'address') <> 'string'
         or (el ->> 'address') !~ '^[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?$'
         or (el ? 'name' and (jsonb_typeof(el -> 'name') <> 'string' or char_length(el ->> 'name') > 40 or (el ->> 'name') ~ '[\x00-\x1f<>]'))
         or exists (select 1 from jsonb_object_keys(el) x where x not in ('address', 'name')) then
        raise exception 'bad_favoriteServers' using errcode = '22023';
      end if;
    end loop;
    update public.profiles set favorite_servers = v where id = me;
  end if;

  if p_patch ? 'publicStats' then
    v := p_patch -> 'publicStats';
    if jsonb_typeof(v) = 'null' then
      update public.profiles set public_stats = null where id = me;
    elsif jsonb_typeof(v) <> 'object'
       or exists (select 1 from jsonb_object_keys(v) x where x not in ('hours', 'sessions', 'topVersion', 'topLoader', 'since'))
       or (v ? 'hours' and (jsonb_typeof(v -> 'hours') <> 'number' or (v ->> 'hours')::numeric not between 0 and 1000000))
       or (v ? 'sessions' and (jsonb_typeof(v -> 'sessions') <> 'number' or (v ->> 'sessions')::numeric not between 0 and 10000000))
       or (v ? 'topVersion' and (jsonb_typeof(v -> 'topVersion') <> 'string' or char_length(v ->> 'topVersion') > 32))
       or (v ? 'topLoader' and (jsonb_typeof(v -> 'topLoader') <> 'string' or char_length(v ->> 'topLoader') > 16))
       or (v ? 'since' and (jsonb_typeof(v -> 'since') <> 'string' or char_length(v ->> 'since') > 32)) then
      raise exception 'bad_publicStats' using errcode = '22023';
    else
      update public.profiles set public_stats = v || jsonb_build_object('updatedAt', now()) where id = me;
    end if;
  end if;

  if p_patch ? 'featured' then
    v := p_patch -> 'featured';
    if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) > 3 then raise exception 'bad_featured' using errcode = '22023'; end if;
    for el in select * from jsonb_array_elements(v) loop
      if jsonb_typeof(el) <> 'object' or not private.own_media_url(me, el -> 'url')
         or (el ? 'title' and (jsonb_typeof(el -> 'title') <> 'string' or char_length(el ->> 'title') > 60))
         or exists (select 1 from jsonb_object_keys(el) x where x not in ('url', 'title')) then
        raise exception 'bad_featured' using errcode = '22023';
      end if;
    end loop;
    update public.profiles set featured = v where id = me;
  end if;

  if p_patch ? 'equipped' then
    v := p_patch -> 'equipped';
    if jsonb_typeof(v) <> 'object' then raise exception 'bad_equipped' using errcode = '22023'; end if;
    for k in select jsonb_object_keys(v) loop
      if k not in ('frame', 'nameEffect', 'badgeStyle', 'title') then raise exception 'bad_equipped' using errcode = '22023'; end if;
      if jsonb_typeof(v -> k) = 'null' then continue; end if;
      -- Solo cosas compradas (o premium: lo premium de la tienda viene incluido)
      if not exists (
        select 1 from public.shop_items si
         where si.id = v ->> k and si.active
           and si.kind = case k when 'frame' then 'frame' when 'nameEffect' then 'name_effect' when 'badgeStyle' then 'badge_style' else 'title' end
           and ((si.premium_only and premium) or exists (select 1 from public.user_items ui where ui.user_id = me and ui.item_id = si.id))
      ) then
        raise exception 'not_owned:%', v ->> k using errcode = '22023';
      end if;
    end loop;
    update public.profiles set equipped = jsonb_strip_nulls(v) where id = me;
  end if;

  update public.profiles set customized_at = now() where id = me;
  select jsonb_build_object(
    'pronouns', p.pronouns, 'bio', p.bio, 'theme', p.theme, 'nameStyle', p.name_style, 'banner', p.banner_style,
    'favoriteServers', p.favorite_servers, 'publicStats', p.public_stats, 'featured', p.featured,
    'equipped', p.equipped, 'premium', premium)
    into v from public.profiles p where p.id = me;
  return v;
end $$;

-- Perfil de cualquier usuario con lo personalizado y si es premium (lo que dibuja la tarjeta de perfil).
create or replace function public.profile_public(p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', p.id, 'username', p.username, 'displayName', p.display_name, 'friendCode', p.friend_code,
    'mcName', p.mc_name, 'bio', p.bio, 'badges', to_jsonb(p.badges), 'pronouns', p.pronouns, 'theme', p.theme,
    'nameStyle', p.name_style, 'banner', p.banner_style, 'favoriteServers', p.favorite_servers,
    'publicStats', p.public_stats, 'featured', p.featured, 'equipped', p.equipped,
    'premium', public.venus_is_premium(p.id), 'createdAt', p.created_at)
  from public.profiles p
  where p.id = p_user and auth.uid() is not null
$$;

-- ---------- Bucket público profile-media ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('profile-media', 'profile-media', true, 4194304, array['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
on conflict (id) do update
  set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create or replace function private.profile_media_count(p_user uuid) returns integer
language sql stable security definer set search_path = '' as $$
  select count(*)::integer from storage.objects o
   where o.bucket_id = 'profile-media' and (storage.foldername(o.name))[1] = p_user::text
$$;
revoke all on function private.profile_media_count(uuid) from public, anon;
grant execute on function private.profile_media_count(uuid) to authenticated;
grant usage on schema private to authenticated;

drop policy if exists "profile_media_insert_own" on storage.objects;
create policy "profile_media_insert_own" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'profile-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and array_length(storage.foldername(name), 1) = 1
    and storage.filename(name) ~ '^[A-Za-z0-9._-]{1,80}$'
    and private.profile_media_count((select auth.uid())) < 12
    and (lower(storage.extension(name)) <> 'gif' or public.venus_is_premium((select auth.uid())))
  );

drop policy if exists "profile_media_update_own" on storage.objects;
create policy "profile_media_update_own" on storage.objects
  for update to authenticated
  using (bucket_id = 'profile-media' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (
    bucket_id = 'profile-media' and (storage.foldername(name))[1] = (select auth.uid())::text
    and (lower(storage.extension(name)) <> 'gif' or public.venus_is_premium((select auth.uid())))
  );

drop policy if exists "profile_media_delete_own" on storage.objects;
create policy "profile_media_delete_own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'profile-media' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- Listar la carpeta propia (el bucket es público para leer cada archivo por URL, no para listar)
drop policy if exists "profile_media_select_own" on storage.objects;
create policy "profile_media_select_own" on storage.objects
  for select to authenticated
  using (bucket_id = 'profile-media' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- ---------- Permisos ----------
revoke all on function public.venus_is_premium(uuid) from public, anon;
grant execute on function public.venus_is_premium(uuid) to authenticated, service_role;
revoke all on function public.profile_customize(jsonb) from public, anon;
grant execute on function public.profile_customize(jsonb) to authenticated;
revoke all on function public.profile_public(uuid) from public, anon;
grant execute on function public.profile_public(uuid) to authenticated;
revoke all on function private.hex_color(jsonb), private.own_media_url(uuid, jsonb), private.profile_fonts(),
  private.profile_effects(), private.profile_effects_premium(), private.profile_banners() from public, anon;
