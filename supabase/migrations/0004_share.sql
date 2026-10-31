-- Venus Launcher · 0004 · Compartir: modpacks por código corto, grupos con sincronización automática
-- y copias de mundos y configuraciones en la nube. Requiere 0001_base.sql (profiles).
-- Se puede volver a ejecutar sin romper nada.
--
-- Modelo de seguridad (RLS activado en todas las tablas):
--   * shared_packs: la ven su dueño y los miembros del grupo. Cualquiera con sesión que conozca el código
--     la lee con get_shared_pack(code), con límite de intentos fallidos para que no se puedan adivinar códigos.
--     Se crea con create_shared_pack(), se publica una revisión nueva con publish_revision() (solo el dueño)
--     y el dueño puede renombrarla, convertirla en grupo o borrarla.
--   * shared_pack_members: cada fila la ven el miembro, el dueño y los demás miembros del grupo.
--     Se entra con join_shared_pack(code) y cada uno marca su sincronización con mark_pack_synced().
--     Se sale borrando la propia fila; el dueño también puede sacar a alguien.
--   * cloud_saves: metadatos de las copias en la nube (mundos y configuraciones). Cada fila es solo de su dueño.
--   * Storage "world-saves" (privado): cada usuario lee y escribe solo dentro de "<su id>/...", con una cuota.
--   * share_throttle: límites de intentos. Sin acceso directo.

create extension if not exists pgcrypto with schema extensions;

-- =====================================================================
-- Tablas
-- =====================================================================
create table if not exists public.shared_packs (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^PACK-[A-HJ-NP-Z2-9]{6}$'),
  owner uuid not null references public.profiles (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 60),
  revision int not null default 1 check (revision >= 1),
  manifest jsonb not null check (jsonb_typeof(manifest) = 'object' and octet_length(manifest::text) <= 3145728),
  is_group boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists shared_packs_owner_idx on public.shared_packs (owner);

create table if not exists public.shared_pack_members (
  pack_id uuid not null references public.shared_packs (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  revision_synced int not null default 0 check (revision_synced >= 0),
  last_sync timestamptz,
  joined_at timestamptz not null default now(),
  primary key (pack_id, user_id)
);
create index if not exists shared_pack_members_user_idx on public.shared_pack_members (user_id);

create table if not exists public.share_throttle (
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null,
  window_start timestamptz not null default now(),
  hits int not null default 0,
  primary key (user_id, kind)
);

create table if not exists public.cloud_saves (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  kind text not null default 'world' check (kind in ('world', 'config')),
  instance_key text not null check (instance_key ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  name text not null check (char_length(name) between 1 and 255),
  label text check (char_length(label) <= 120),
  storage_prefix text not null check (char_length(storage_prefix) <= 400),
  version int not null default 1 check (version >= 1),
  sha1 text not null check (sha1 ~ '^[0-9a-f]{40}$'),
  size bigint not null check (size >= 0),
  parts int not null check (parts between 1 and 400),
  device text check (char_length(device) <= 64),
  device_id text check (char_length(device_id) <= 64),
  meta jsonb check (meta is null or (jsonb_typeof(meta) = 'object' and octet_length(meta::text) <= 8192)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cloud_saves_key unique (owner, kind, instance_key, name),
  -- las partes viven siempre dentro de la carpeta del dueño en Storage
  constraint cloud_saves_prefix_own check (split_part(storage_prefix, '/', 1) = owner::text)
);
create index if not exists cloud_saves_owner_idx on public.cloud_saves (owner, instance_key);

alter table public.shared_packs enable row level security;
alter table public.shared_pack_members enable row level security;
alter table public.share_throttle enable row level security;
alter table public.cloud_saves enable row level security;

-- =====================================================================
-- Funciones auxiliares (security definer: no dependen de las políticas, así no hay recursión)
-- =====================================================================
create or replace function public.share_is_owner(p_pack uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.shared_packs p where p.id = p_pack and p.owner = (select auth.uid()));
$$;

create or replace function public.share_is_member(p_pack uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.shared_pack_members m where m.pack_id = p_pack and m.user_id = (select auth.uid()));
$$;

-- Límite de intentos por usuario y tipo
create or replace function public.share__throttled(p_kind text, p_limit int, p_window interval) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.share_throttle t
                  where t.user_id = (select auth.uid()) and t.kind = p_kind
                    and t.window_start > now() - p_window and t.hits >= p_limit);
$$;

create or replace function public.share__hit(p_kind text, p_window interval) returns void
language sql security definer set search_path = public as $$
  insert into public.share_throttle as t (user_id, kind, window_start, hits)
  values ((select auth.uid()), p_kind, now(), 1)
  on conflict (user_id, kind) do update set
    hits = case when t.window_start <= now() - p_window then 1 else t.hits + 1 end,
    window_start = case when t.window_start <= now() - p_window then now() else t.window_start end;
$$;

-- Código legible PACK-XXXXXX (sin I, O, 0 ni 1)
create or replace function public.share__new_code() returns text
language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_bytes bytea;
  v_code text;
begin
  loop
    v_bytes := gen_random_bytes(6);
    v_code := 'PACK-';
    for i in 0..5 loop
      v_code := v_code || substr(alphabet, 1 + (get_byte(v_bytes, i) % 32), 1);
    end loop;
    exit when not exists (select 1 from public.shared_packs p where p.code = v_code);
  end loop;
  return v_code;
end $$;

-- "pack-ab12cd", " AB12CD " -> "PACK-AB12CD"
create or replace function public.share__normalize_code(p_code text) returns text
language sql immutable set search_path = public as $$
  select case
    when v ~ '^[A-Z0-9]{6}$' then 'PACK-' || v
    when v ~ '^PACK[A-Z0-9]{6}$' then 'PACK-' || substr(v, 5)
    else v
  end
  from (select upper(regexp_replace(coalesce(p_code, ''), '\s', '', 'g')) as v) s;
$$;

-- Modpack en JSON para la interfaz (el manifiesto solo si se pide)
create or replace function public.share__pack_json(p public.shared_packs, p_manifest boolean) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', p.id,
    'code', p.code,
    'name', p.name,
    'revision', p.revision,
    'is_group', p.is_group,
    'owner', p.owner,
    'owner_name', (select coalesce(nullif(btrim(pr.display_name), ''), pr.username) from public.profiles pr where pr.id = p.owner),
    'owner_mc', (select pr.mc_name from public.profiles pr where pr.id = p.owner),
    'created_at', p.created_at,
    'updated_at', p.updated_at,
    'member_count', (select count(*) from public.shared_pack_members m where m.pack_id = p.id),
    'is_owner', p.owner = (select auth.uid()),
    'is_member', exists (select 1 from public.shared_pack_members m where m.pack_id = p.id and m.user_id = (select auth.uid())),
    'manifest', case when p_manifest then p.manifest else null end
  );
$$;

-- Cuota de la nube por usuario (suma del tamaño de sus archivos en "world-saves"). Ajustable: 2 GB.
-- plpgsql + execute: no falla al crearse aunque el esquema de Storage todavía no exista.
create or replace function public.cloud_saves_quota_ok() returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  used bigint := 0;
begin
  if to_regclass('storage.objects') is null then
    return true;
  end if;
  execute $q$
    select coalesce(sum(coalesce((o.metadata ->> 'size')::bigint, 0)), 0)
      from storage.objects o
     where o.bucket_id = 'world-saves' and (storage.foldername(o.name))[1] = $1
  $q$ into used using (select auth.uid())::text;
  return used < 2147483648;
end $$;

-- =====================================================================
-- Políticas
-- =====================================================================
drop policy if exists "shared_packs_select" on public.shared_packs;
create policy "shared_packs_select" on public.shared_packs
  for select to authenticated
  using (owner = (select auth.uid()) or public.share_is_member(id));

drop policy if exists "shared_packs_update_owner" on public.shared_packs;
create policy "shared_packs_update_owner" on public.shared_packs
  for update to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));

drop policy if exists "shared_packs_delete_owner" on public.shared_packs;
create policy "shared_packs_delete_owner" on public.shared_packs
  for delete to authenticated
  using (owner = (select auth.uid()));

drop policy if exists "shared_pack_members_select" on public.shared_pack_members;
create policy "shared_pack_members_select" on public.shared_pack_members
  for select to authenticated
  using (user_id = (select auth.uid()) or public.share_is_owner(pack_id) or public.share_is_member(pack_id));

drop policy if exists "shared_pack_members_delete" on public.shared_pack_members;
create policy "shared_pack_members_delete" on public.shared_pack_members
  for delete to authenticated
  using (user_id = (select auth.uid()) or public.share_is_owner(pack_id));

drop policy if exists "cloud_saves_select_own" on public.cloud_saves;
create policy "cloud_saves_select_own" on public.cloud_saves
  for select to authenticated
  using (owner = (select auth.uid()));

drop policy if exists "cloud_saves_insert_own" on public.cloud_saves;
create policy "cloud_saves_insert_own" on public.cloud_saves
  for insert to authenticated
  with check (owner = (select auth.uid()));

drop policy if exists "cloud_saves_update_own" on public.cloud_saves;
create policy "cloud_saves_update_own" on public.cloud_saves
  for update to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));

drop policy if exists "cloud_saves_delete_own" on public.cloud_saves;
create policy "cloud_saves_delete_own" on public.cloud_saves
  for delete to authenticated
  using (owner = (select auth.uid()));

-- Permisos de tabla: las altas de modpacks y miembros pasan solo por las funciones de abajo.
revoke all on public.shared_packs from anon, authenticated;
grant select on public.shared_packs to authenticated;
grant update (name, is_group) on public.shared_packs to authenticated;
grant delete on public.shared_packs to authenticated;

revoke all on public.shared_pack_members from anon, authenticated;
grant select, delete on public.shared_pack_members to authenticated;

revoke all on public.share_throttle from anon, authenticated;

revoke all on public.cloud_saves from anon, authenticated;
grant select, delete on public.cloud_saves to authenticated;
grant insert (kind, instance_key, name, label, storage_prefix, version, sha1, size, parts, device, device_id, meta, updated_at)
  on public.cloud_saves to authenticated;
grant update (label, storage_prefix, version, sha1, size, parts, device, device_id, meta, updated_at)
  on public.cloud_saves to authenticated;

-- Fecha de modificación al renombrar o cambiar el tipo de un modpack
create or replace function public.share__touch() returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists shared_packs_touch on public.shared_packs;
create trigger shared_packs_touch
  before update on public.shared_packs
  for each row execute function public.share__touch();

-- =====================================================================
-- Funciones para la interfaz (devuelven { error: '<codigo>' } en los casos esperables)
-- =====================================================================

-- Crea un modpack compartido con un código único.
create or replace function public.create_shared_pack(p_name text, p_manifest jsonb, p_is_group boolean default false)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  v_name text := btrim(coalesce(p_name, ''));
  v_pack public.shared_packs;
begin
  if me is null then
    return jsonb_build_object('error', 'auth');
  end if;
  if char_length(v_name) not between 1 and 60 then
    return jsonb_build_object('error', 'bad_name');
  end if;
  if p_manifest is null or jsonb_typeof(p_manifest) <> 'object' then
    return jsonb_build_object('error', 'bad_manifest');
  end if;
  if octet_length(p_manifest::text) > 3145728 then
    return jsonb_build_object('error', 'too_large');
  end if;
  if (select count(*) from public.shared_packs p where p.owner = me) >= 30 then
    return jsonb_build_object('error', 'too_many_packs');
  end if;
  if public.share__throttled('create', 20, interval '1 hour') then
    return jsonb_build_object('error', 'throttled');
  end if;
  perform public.share__hit('create', interval '1 hour');
  insert into public.shared_packs (code, owner, name, manifest, is_group)
  values (public.share__new_code(), me, v_name, p_manifest, coalesce(p_is_group, false))
  returning * into v_pack;
  return jsonb_build_object('pack', public.share__pack_json(v_pack, false));
end $$;

-- Datos de un modpack para quien conoce el código (vista previa antes de importarlo).
create or replace function public.get_shared_pack(p_code text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  v_code text := public.share__normalize_code(p_code);
  v_pack public.shared_packs;
begin
  if me is null then
    return jsonb_build_object('error', 'auth');
  end if;
  if v_code !~ '^PACK-[A-HJ-NP-Z2-9]{6}$' then
    return jsonb_build_object('error', 'bad_code');
  end if;
  if public.share__throttled('lookup', 30, interval '10 minutes') then
    return jsonb_build_object('error', 'throttled');
  end if;
  select * into v_pack from public.shared_packs p where p.code = v_code;
  if not found then
    perform public.share__hit('lookup', interval '10 minutes');
    return jsonb_build_object('error', 'not_found');
  end if;
  return jsonb_build_object('pack', public.share__pack_json(v_pack, true));
end $$;

-- Entra a un grupo (modpack con sincronización automática).
create or replace function public.join_shared_pack(p_code text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  v_code text := public.share__normalize_code(p_code);
  v_pack public.shared_packs;
  v_already boolean;
begin
  if me is null then
    return jsonb_build_object('error', 'auth');
  end if;
  if v_code !~ '^PACK-[A-HJ-NP-Z2-9]{6}$' then
    return jsonb_build_object('error', 'bad_code');
  end if;
  if public.share__throttled('lookup', 30, interval '10 minutes') then
    return jsonb_build_object('error', 'throttled');
  end if;
  select * into v_pack from public.shared_packs p where p.code = v_code;
  if not found then
    perform public.share__hit('lookup', interval '10 minutes');
    return jsonb_build_object('error', 'not_found');
  end if;
  if not v_pack.is_group then
    return jsonb_build_object('error', 'not_group');
  end if;
  v_already := exists (select 1 from public.shared_pack_members m where m.pack_id = v_pack.id and m.user_id = me);
  if not v_already then
    if (select count(*) from public.shared_pack_members m where m.pack_id = v_pack.id) >= 50 then
      return jsonb_build_object('error', 'group_full');
    end if;
    if (select count(*) from public.shared_pack_members m where m.user_id = me) >= 40 then
      return jsonb_build_object('error', 'too_many_groups');
    end if;
    insert into public.shared_pack_members (pack_id, user_id) values (v_pack.id, me) on conflict do nothing;
  end if;
  return jsonb_build_object('pack', public.share__pack_json(v_pack, true));
end $$;

-- Publica una revisión nueva (solo el dueño). p_name opcional para renombrar al mismo tiempo.
create or replace function public.publish_revision(p_pack_id uuid, p_manifest jsonb, p_name text default null)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  v_pack public.shared_packs;
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
begin
  if me is null then
    return jsonb_build_object('error', 'auth');
  end if;
  if p_manifest is null or jsonb_typeof(p_manifest) <> 'object' then
    return jsonb_build_object('error', 'bad_manifest');
  end if;
  if octet_length(p_manifest::text) > 3145728 then
    return jsonb_build_object('error', 'too_large');
  end if;
  if v_name is not null and char_length(v_name) > 60 then
    return jsonb_build_object('error', 'bad_name');
  end if;
  select * into v_pack from public.shared_packs p where p.id = p_pack_id for update;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_pack.owner <> me then
    return jsonb_build_object('error', 'not_owner');
  end if;
  update public.shared_packs
     set manifest = p_manifest, revision = revision + 1, name = coalesce(v_name, name), updated_at = now()
   where id = p_pack_id
  returning * into v_pack;
  -- si el dueño también sigue el grupo desde otra PC, esta queda al día
  update public.shared_pack_members
     set revision_synced = v_pack.revision, last_sync = now()
   where pack_id = v_pack.id and user_id = me;
  return jsonb_build_object('pack', public.share__pack_json(v_pack, false));
end $$;

-- Cada miembro avisa hasta qué revisión sincronizó (lo ve el dueño en la lista de miembros).
create or replace function public.mark_pack_synced(p_pack_id uuid, p_revision int) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  v_rev int;
begin
  if me is null then
    return jsonb_build_object('error', 'auth');
  end if;
  update public.shared_pack_members m
     set revision_synced = greatest(0, least(coalesce(p_revision, 0), p.revision)), last_sync = now()
    from public.shared_packs p
   where p.id = m.pack_id and m.pack_id = p_pack_id and m.user_id = me
  returning m.revision_synced into v_rev;
  if not found then
    return jsonb_build_object('error', 'not_member');
  end if;
  return jsonb_build_object('revision_synced', v_rev);
end $$;

-- Permisos de las funciones
revoke all on function public.share_is_owner(uuid) from public, anon;
revoke all on function public.share_is_member(uuid) from public, anon;
revoke all on function public.share__throttled(text, int, interval) from public, anon, authenticated;
revoke all on function public.share__hit(text, interval) from public, anon, authenticated;
revoke all on function public.share__new_code() from public, anon, authenticated;
revoke all on function public.share__normalize_code(text) from public, anon, authenticated;
revoke all on function public.share__pack_json(public.shared_packs, boolean) from public, anon, authenticated;
revoke all on function public.share__touch() from public, anon, authenticated;
revoke all on function public.cloud_saves_quota_ok() from public, anon;
revoke all on function public.create_shared_pack(text, jsonb, boolean) from public, anon;
revoke all on function public.get_shared_pack(text) from public, anon;
revoke all on function public.join_shared_pack(text) from public, anon;
revoke all on function public.publish_revision(uuid, jsonb, text) from public, anon;
revoke all on function public.mark_pack_synced(uuid, int) from public, anon;

-- Las de las políticas también las evalúa el rol authenticated
grant execute on function public.share_is_owner(uuid) to authenticated;
grant execute on function public.share_is_member(uuid) to authenticated;
grant execute on function public.cloud_saves_quota_ok() to authenticated;
grant execute on function public.create_shared_pack(text, jsonb, boolean) to authenticated;
grant execute on function public.get_shared_pack(text) to authenticated;
grant execute on function public.join_shared_pack(text) to authenticated;
grant execute on function public.publish_revision(uuid, jsonb, text) to authenticated;
grant execute on function public.mark_pack_synced(uuid, int) to authenticated;

-- =====================================================================
-- Storage: bucket privado "world-saves" (partes de 45 MB: el límite gratuito por archivo es 50 MB)
-- Rutas: <userId>/<instancia>/<mundo>/<subida>/part-000
-- =====================================================================
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('world-saves', 'world-saves', false, 52428800, array['application/octet-stream', 'application/zip'])
    on conflict (id) do update
      set public = false,
          file_size_limit = excluded.file_size_limit,
          allowed_mime_types = excluded.allowed_mime_types;
  end if;
  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists "world_saves_select_own" on storage.objects';
    execute $policy$
      create policy "world_saves_select_own" on storage.objects
        for select to authenticated
        using (bucket_id = 'world-saves' and (storage.foldername(name))[1] = (select auth.uid())::text)
    $policy$;
    execute 'drop policy if exists "world_saves_insert_own" on storage.objects';
    execute $policy$
      create policy "world_saves_insert_own" on storage.objects
        for insert to authenticated
        with check (bucket_id = 'world-saves'
                    and (storage.foldername(name))[1] = (select auth.uid())::text
                    and public.cloud_saves_quota_ok())
    $policy$;
    execute 'drop policy if exists "world_saves_update_own" on storage.objects';
    execute $policy$
      create policy "world_saves_update_own" on storage.objects
        for update to authenticated
        using (bucket_id = 'world-saves' and (storage.foldername(name))[1] = (select auth.uid())::text)
        with check (bucket_id = 'world-saves' and (storage.foldername(name))[1] = (select auth.uid())::text)
    $policy$;
    execute 'drop policy if exists "world_saves_delete_own" on storage.objects';
    execute $policy$
      create policy "world_saves_delete_own" on storage.objects
        for delete to authenticated
        using (bucket_id = 'world-saves' and (storage.foldername(name))[1] = (select auth.uid())::text)
    $policy$;
  end if;
end $$;
