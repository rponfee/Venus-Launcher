-- 0036_extensiones.sql · Venus 3.4 · Catálogo de extensiones de la comunidad.
-- Guía: docs/extensiones.md · Por dentro: docs/implementacion/extensiones.md. Depende de 0012 y 0014 (moderación, admin, esquema
-- private). No depende de 0028 a 0035. Idempotente.
--
--   * community_extensions: una fila por id de extensión, con su dueño y su estado. El nombre y la descripción públicos
--     salen de la última versión aprobada: lo que manda el autor no se muestra a nadie hasta que un admin lo apruebe.
--   * community_extension_versions: cada versión enviada, con sha-256, tamaño, manifiesto, estado y nota de revisión.
--     Estados: pending, approved, rejected, blocked.
--   * Bucket privado extension-packages: <uid>/<id>/<versión>.venusext, 5 MB. El autor sube una vez y no puede reemplazar
--     ni borrar. Descargan: su autor, los admins y, si está aprobada y no bloqueada, cualquier sesión.
--   * Nadie lee ni escribe las tablas directo: todo por RPC. Lista de aprobadas y envíos con sesión; lista de bloqueadas
--     también sin sesión, porque una extensión peligrosa se tiene que apagar aunque nadie haya iniciado sesión.
--   * Cuentas baneadas o silenciadas no envían. Tope: 5 envíos por día y 20 extensiones por cuenta.
--   * Solo un admin aprueba, rechaza o bloquea, y queda en admin_log (admin_actions).

-- ---------- Tablas ----------
create table if not exists public.community_extensions (
  id text primary key check (id ~ '^[a-z0-9-]{3,40}$'),
  -- Sin cascada: si el autor borra su cuenta, una extensión bloqueada tiene que seguir bloqueada
  owner uuid references auth.users (id) on delete set null,
  name text not null check (char_length(name) between 1 and 40),
  author text not null check (char_length(author) between 1 and 60),
  description text not null default '' check (char_length(description) <= 300),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'blocked')),
  block_reason text check (char_length(block_reason) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists community_extensions_owner on public.community_extensions (owner);
create index if not exists community_extensions_status on public.community_extensions (status, name);
alter table public.community_extensions enable row level security;
revoke all on public.community_extensions from public, anon, authenticated;

create table if not exists public.community_extension_versions (
  id uuid primary key default gen_random_uuid(),
  extension_id text not null references public.community_extensions (id) on delete cascade,
  version text not null check (char_length(version) <= 32),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'blocked')),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes integer not null check (size_bytes between 1 and 5242880),
  manifest jsonb not null check (jsonb_typeof(manifest) = 'object' and pg_column_size(manifest) < 16384),
  permissions text[] not null default '{}',
  storage_path text not null unique check (char_length(storage_path) <= 200),
  review_note text check (char_length(review_note) <= 300),
  submitted_by uuid references auth.users (id) on delete set null,
  submitted_at timestamptz not null default now(),
  reviewed_by uuid references auth.users (id) on delete set null,
  reviewed_at timestamptz,
  unique (extension_id, version)
);
create index if not exists community_extension_versions_status on public.community_extension_versions (status, submitted_at desc);
create index if not exists community_extension_versions_submitter on public.community_extension_versions (submitted_by, submitted_at desc);
create index if not exists community_extension_versions_sha on public.community_extension_versions (sha256) where status = 'blocked';
alter table public.community_extension_versions enable row level security;
revoke all on public.community_extension_versions from public, anon, authenticated;

-- ---------- Validación (la misma que hace el launcher en extensions/manifest.js) ----------
create or replace function private.extension_permissions() returns text[]
language sql immutable set search_path = '' as $$
  select array['storage', 'notify', 'read.instances', 'read.gameState', 'action.openPage', 'action.launchInstance']
$$;

-- Controles, invisibles, marcas de dirección y signos de HTML: un texto no se puede disfrazar.
create or replace function private.extension_text_ok(p_text text, p_min integer, p_max integer) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(char_length(p_text) between p_min and p_max
    and p_text = btrim(p_text)
    and p_text !~ E'[\\x01-\\x1f\\x7f-\\x9f\\u00ad\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\ufeff<>]', false)
$$;

-- Una extensión no se presenta como parte del launcher ni de quienes hacen el juego.
create or replace function private.extension_name_ok(p_text text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(regexp_replace(lower(regexp_replace(normalize(p_text, NFKD), E'[\\u0300-\\u036f]', '', 'g')), '[^a-z0-9]', '', 'g')
    !~ '(venus|oficial|official|mojang|microsoft)', false)
$$;

create or replace function private.extension_version_ok(p_version text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(char_length(p_version) <= 32
    and p_version ~ '^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}(-[0-9A-Za-z.-]{1,16})?$'
    and p_version !~ '\.\.', false)
$$;

create or replace function private.extension_page_ok(v jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_typeof(v) = 'string'
    and char_length(v #>> '{}') <= 180
    and (v #>> '{}') ~* '^[^/\\:]+(/[^/\\:]+)*\.html$'
    and (v #>> '{}') !~ '(^|/)\.', false)
$$;

-- El manifiesto tiene que ser exactamente lo que el launcher acepta: esquema cerrado.
create or replace function private.extension_manifest_ok(p_id text, p_version text, m jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_typeof(m) = 'object'
    and pg_column_size(m) < 16384
    and not exists (select 1 from jsonb_object_keys(m) k where k not in ('manifestVersion', 'id', 'name', 'version', 'author', 'description', 'minLauncherVersion', 'permissions', 'entry', 'homeCard'))
    and m -> 'manifestVersion' = '1'::jsonb
    and m ->> 'id' = p_id
    and m ->> 'version' = p_version
    and jsonb_typeof(m -> 'name') = 'string' and private.extension_text_ok(m ->> 'name', 1, 40)
    and jsonb_typeof(m -> 'author') = 'string' and private.extension_text_ok(m ->> 'author', 1, 60)
    and (not (m ? 'description') or jsonb_typeof(m -> 'description') = 'string' and private.extension_text_ok(m ->> 'description', 0, 300))
    and jsonb_typeof(m -> 'minLauncherVersion') = 'string' and private.extension_version_ok(m ->> 'minLauncherVersion')
    and jsonb_typeof(m -> 'permissions') = 'array'
    and not exists (select 1 from jsonb_array_elements(m -> 'permissions') p where jsonb_typeof(p) <> 'string' or not ((p #>> '{}') = any (private.extension_permissions())))
    and (select count(*) = count(distinct p) from jsonb_array_elements_text(m -> 'permissions') p)
    and private.extension_page_ok(m -> 'entry')
    and (not (m ? 'homeCard') or jsonb_typeof(m -> 'homeCard') = 'null' or private.extension_page_ok(m -> 'homeCard')), false)
$$;

-- ---------- Lo que consultan las políticas del bucket ----------
-- Descargar: el autor, un admin, o cualquier sesión si la versión está aprobada y la extensión no está bloqueada.
create or replace function private.extension_can_read(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and (
    split_part(p_name, '/', 1) = auth.uid()::text
    or public.admin_is_admin_user(auth.uid())
    or exists (
      select 1 from public.community_extension_versions v
        join public.community_extensions e on e.id = v.extension_id
       where v.storage_path = p_name and v.status = 'approved' and e.status = 'approved'
         and public.moderation_social_block(e.owner) is distinct from 'user_banned'))
$$;

-- Subir: solo el archivo de un envío propio en revisión, y una sola vez (no hay política de update ni de delete).
create or replace function private.extension_can_upload(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null
    and public.moderation_social_block(auth.uid()) is null
    and split_part(p_name, '/', 1) = auth.uid()::text
    and exists (select 1 from public.community_extension_versions v
                 where v.storage_path = p_name and v.submitted_by = auth.uid() and v.status = 'pending')
$$;

-- ---------- Catálogo ----------
/**
 * Extensiones aprobadas, con su última versión aprobada. p_ids: solo esas (para buscar actualizaciones).
 * Devuelve [{ id, name, author, description, version, permissions, sizeBytes, sha256, path, minLauncherVersion, homeCard, updatedAt }].
 */
create or replace function public.extension_catalog(p_search text default null, p_ids text[] default null, p_limit integer default 60, p_offset integer default 0)
returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(x.j order by x.o), '[]'::jsonb)
  from (
    select jsonb_build_object(
             'id', e.id, 'name', v.manifest ->> 'name', 'author', v.manifest ->> 'author',
             'description', coalesce(v.manifest ->> 'description', ''), 'version', v.version,
             'permissions', to_jsonb(v.permissions), 'sizeBytes', v.size_bytes, 'sha256', v.sha256,
             'path', v.storage_path, 'minLauncherVersion', v.manifest ->> 'minLauncherVersion',
             'homeCard', coalesce(jsonb_typeof(v.manifest -> 'homeCard') = 'string', false), 'updatedAt', v.reviewed_at) as j,
           lower(v.manifest ->> 'name') as o
      from public.community_extensions e
      cross join lateral (
        select * from public.community_extension_versions x
         where x.extension_id = e.id and x.status = 'approved'
         order by x.reviewed_at desc nulls last limit 1) v
     where auth.uid() is not null
       and e.status = 'approved'
       and public.moderation_social_block(e.owner) is distinct from 'user_banned'
       and (p_ids is null or e.id = any (p_ids))
       and (nullif(btrim(coalesce(p_search, '')), '') is null
            or strpos(lower(v.manifest ->> 'name'), lower(btrim(p_search))) > 0
            or strpos(lower(coalesce(v.manifest ->> 'description', '')), lower(btrim(p_search))) > 0)
     order by lower(v.manifest ->> 'name')
     limit least(greatest(coalesce(p_limit, 60), 1), 100) offset greatest(coalesce(p_offset, 0), 0)
  ) x
$$;

-- Lista de bloqueadas: { ids: [...], hashes: [...] }. No trae motivos ni autores.
create or replace function public.extension_blocklist() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'ids', coalesce((select jsonb_agg(e.id) from public.community_extensions e where e.status = 'blocked'), '[]'::jsonb),
    'hashes', coalesce((select jsonb_agg(v.sha256) from public.community_extension_versions v where v.status = 'blocked'), '[]'::jsonb))
$$;

/**
 * Envía una versión. Devuelve { id, path, bucket }: el launcher sube el paquete a esa ruta. Errores (22023): bad_id,
 * bad_manifest, bad_name, bad_sha256, bad_size, not_owner, extension_blocked, version_exists, too_many_today,
 * too_many_extensions; user_banned / user_muted / not_authenticated (42501).
 * Si el paquete todavía no se subió, volver a mandar la misma versión corrige el envío (por si la subida falló).
 */
create or replace function public.extension_submit(p_id text, p_version text, p_manifest jsonb, p_sha256 text, p_size integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_block text;
  v_ext record;
  v_old record;
  v_path text;
  v_vid uuid;
  v_perms text[];
begin
  if me is null or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  v_block := public.moderation_social_block(me);
  if v_block is not null then raise exception '%', v_block using errcode = '42501'; end if;
  if coalesce(p_id, '') !~ '^[a-z0-9-]{3,40}$' or p_id ~ '^-|-$' then raise exception 'bad_id' using errcode = '22023'; end if;
  if not private.extension_version_ok(p_version) or not private.extension_manifest_ok(p_id, p_version, p_manifest) then
    raise exception 'bad_manifest' using errcode = '22023';
  end if;
  if not private.extension_name_ok(p_id) or not private.extension_name_ok(p_manifest ->> 'name') or not private.extension_name_ok(p_manifest ->> 'author') then
    raise exception 'bad_name' using errcode = '22023';
  end if;
  if coalesce(p_sha256, '') !~ '^[0-9a-f]{64}$' then raise exception 'bad_sha256' using errcode = '22023'; end if;
  if coalesce(p_size, 0) not between 1 and 5242880 then raise exception 'bad_size' using errcode = '22023'; end if;

  perform pg_advisory_xact_lock(hashtext('extensions:' || me::text));
  perform pg_advisory_xact_lock(hashtext('extension:' || p_id));

  select * into v_ext from public.community_extensions e where e.id = p_id;
  if found then
    if v_ext.owner is distinct from me then raise exception 'not_owner' using errcode = '22023'; end if;
    if v_ext.status = 'blocked' then raise exception 'extension_blocked' using errcode = '22023'; end if;
  end if;

  v_path := me::text || '/' || p_id || '/' || p_version || '.venusext';
  select array_agg(p) into v_perms from jsonb_array_elements_text(p_manifest -> 'permissions') p;

  select * into v_old from public.community_extension_versions v where v.extension_id = p_id and v.version = p_version;
  if found then
    if v_old.status <> 'pending' or v_old.submitted_by is distinct from me
       or exists (select 1 from storage.objects o where o.bucket_id = 'extension-packages' and o.name = v_old.storage_path) then
      raise exception 'version_exists' using errcode = '22023';
    end if;
    update public.community_extension_versions
       set sha256 = p_sha256, size_bytes = p_size, manifest = p_manifest, permissions = coalesce(v_perms, '{}')
     where id = v_old.id;
    return jsonb_build_object('id', v_old.id, 'path', v_old.storage_path, 'bucket', 'extension-packages');
  end if;

  if (select count(*) from public.community_extension_versions v where v.submitted_by = me and v.submitted_at > now() - interval '1 day') >= 5 then
    raise exception 'too_many_today' using errcode = '22023';
  end if;
  if v_ext.id is null then
    if (select count(*) from public.community_extensions e where e.owner = me) >= 20 then
      raise exception 'too_many_extensions' using errcode = '22023';
    end if;
    insert into public.community_extensions (id, owner, name, author, description)
    values (p_id, me, p_manifest ->> 'name', p_manifest ->> 'author', coalesce(p_manifest ->> 'description', ''));
  end if;
  insert into public.community_extension_versions (extension_id, version, sha256, size_bytes, manifest, permissions, storage_path, submitted_by)
  values (p_id, p_version, p_sha256, p_size, p_manifest, coalesce(v_perms, '{}'), v_path, me)
  returning id into v_vid;
  return jsonb_build_object('id', v_vid, 'path', v_path, 'bucket', 'extension-packages');
end $$;

-- Lo que mandé y en qué quedó (las últimas 50 versiones, con la nota de la revisión).
create or replace function public.extension_my_submissions() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', v.extension_id, 'name', v.manifest ->> 'name', 'version', v.version,
                            'status', case when e.status = 'blocked' then 'blocked' else v.status end,
                            'note', v.review_note, 'at', v.submitted_at) order by v.submitted_at desc)
                     from (select * from public.community_extension_versions x where x.submitted_by = me order by x.submitted_at desc limit 50) v
                     join public.community_extensions e on e.id = v.extension_id), '[]'::jsonb);
end $$;

-- ---------- Panel de administración ----------
-- Versiones en ese estado (hasta 200), con quién las mandó y si el paquete ya se subió y coincide en tamaño.
create or replace function public.admin_extensions(p_status text default 'pending') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.admin_guard();
  if coalesce(p_status, '') not in ('pending', 'approved', 'rejected', 'blocked') then raise exception 'bad_status' using errcode = '22023'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'versionId', v.id, 'id', v.extension_id, 'name', v.manifest ->> 'name', 'author', v.manifest ->> 'author',
      'description', coalesce(v.manifest ->> 'description', ''), 'version', v.version, 'status', v.status,
      'extensionStatus', e.status, 'blockReason', e.block_reason, 'permissions', to_jsonb(v.permissions),
      'manifest', v.manifest, 'sha256', v.sha256, 'sizeBytes', v.size_bytes, 'path', v.storage_path, 'note', v.review_note,
      'at', v.submitted_at, 'reviewedAt', v.reviewed_at,
      'uploaded', exists (select 1 from storage.objects o where o.bucket_id = 'extension-packages' and o.name = v.storage_path
                           and (o.metadata ->> 'size')::bigint = v.size_bytes),
      'submitter', jsonb_build_object('id', p.id, 'username', p.username, 'displayName', p.display_name)) order by v.submitted_at desc)
    from (select * from public.community_extension_versions x
           where x.status = p_status or (p_status = 'blocked' and exists (select 1 from public.community_extensions y where y.id = x.extension_id and y.status = 'blocked'))
           order by x.submitted_at desc limit 200) v
    join public.community_extensions e on e.id = v.extension_id
    left join public.profiles p on p.id = v.submitted_by), '[]'::jsonb);
end $$;

/**
 * Revisa una versión. p_action: approve (exige el paquete subido y del tamaño declarado), reject o block (con motivo).
 * Errores (22023): not_found, bad_action, not_uploaded, not_pending, note_required, extension_blocked.
 * Aprobar actualiza el nombre público con el del manifiesto aprobado. Queda en el registro de acciones.
 */
create or replace function public.admin_extension_review(p_version uuid, p_action text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v record;
  e record;
begin
  perform public.admin_guard();
  select * into v from public.community_extension_versions x where x.id = p_version for update;
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
  select * into e from public.community_extensions x where x.id = v.extension_id for update;
  if v_note is not null and char_length(v_note) > 300 then raise exception 'bad_note' using errcode = '22023'; end if;

  if p_action = 'approve' then
    if v.status not in ('pending', 'rejected') then raise exception 'not_pending' using errcode = '22023'; end if;
    if e.status = 'blocked' then raise exception 'extension_blocked' using errcode = '22023'; end if;
    if not exists (select 1 from storage.objects o where o.bucket_id = 'extension-packages' and o.name = v.storage_path
                    and (o.metadata ->> 'size')::bigint = v.size_bytes) then
      raise exception 'not_uploaded' using errcode = '22023';
    end if;
    update public.community_extension_versions set status = 'approved', review_note = v_note, reviewed_by = me, reviewed_at = now() where id = v.id;
    update public.community_extensions
       set status = 'approved', name = v.manifest ->> 'name', author = v.manifest ->> 'author',
           description = coalesce(v.manifest ->> 'description', ''), updated_at = now()
     where id = v.extension_id;
  elsif p_action = 'reject' then
    if v.status <> 'pending' then raise exception 'not_pending' using errcode = '22023'; end if;
    if v_note is null then raise exception 'note_required' using errcode = '22023'; end if;
    update public.community_extension_versions set status = 'rejected', review_note = v_note, reviewed_by = me, reviewed_at = now() where id = v.id;
    update public.community_extensions set status = 'rejected', updated_at = now()
     where id = v.extension_id and status = 'pending'
       and not exists (select 1 from public.community_extension_versions x where x.extension_id = v.extension_id and x.status in ('approved', 'pending'));
  elsif p_action = 'block' then
    if v_note is null then raise exception 'note_required' using errcode = '22023'; end if;
    update public.community_extension_versions set status = 'blocked', review_note = v_note, reviewed_by = me, reviewed_at = now() where id = v.id;
    -- Si era la única aprobada, la extensión deja de estar en el catálogo
    update public.community_extensions set status = 'rejected', updated_at = now()
     where id = v.extension_id and status = 'approved'
       and not exists (select 1 from public.community_extension_versions x where x.extension_id = v.extension_id and x.status = 'approved');
  else
    raise exception 'bad_action' using errcode = '22023';
  end if;

  perform public.admin_log(me, (select email from auth.users where id = me), 'extension.' || p_action, v.submitted_by,
    jsonb_build_object('extension', v.extension_id, 'version', v.version, 'sha256', v.sha256, 'note', v_note));
  return jsonb_build_object('ok', true, 'versionId', v.id, 'action', p_action);
end $$;

-- Bloquea o desbloquea una extensión entera: entra en la lista de bloqueadas y se apaga en todos los launchers.
create or replace function public.admin_extension_block(p_id text, p_blocked boolean, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  e record;
  v_status text;
begin
  perform public.admin_guard();
  select * into e from public.community_extensions x where x.id = p_id for update;
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
  if coalesce(p_blocked, false) then
    if v_reason is null then raise exception 'note_required' using errcode = '22023'; end if;
    if char_length(v_reason) > 300 then raise exception 'bad_note' using errcode = '22023'; end if;
    v_status := 'blocked';
  else
    v_status := case
      when exists (select 1 from public.community_extension_versions x where x.extension_id = p_id and x.status = 'approved') then 'approved'
      when exists (select 1 from public.community_extension_versions x where x.extension_id = p_id and x.status = 'pending') then 'pending'
      else 'rejected' end;
    v_reason := null;
  end if;
  update public.community_extensions set status = v_status, block_reason = v_reason, updated_at = now() where id = p_id;
  perform public.admin_log(me, (select email from auth.users where id = me), case when p_blocked then 'extension.blockAll' else 'extension.unblockAll' end, e.owner,
    jsonb_build_object('extension', p_id, 'reason', v_reason));
  return jsonb_build_object('ok', true, 'id', p_id, 'status', v_status);
end $$;

-- ---------- Bucket privado con los paquetes ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('extension-packages', 'extension-packages', false, 5242880, array['application/zip', 'application/octet-stream'])
on conflict (id) do update
  set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "extension_packages_select" on storage.objects;
create policy "extension_packages_select" on storage.objects
  for select to authenticated
  using (bucket_id = 'extension-packages' and private.extension_can_read(name));
drop policy if exists "extension_packages_insert" on storage.objects;
create policy "extension_packages_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'extension-packages' and private.extension_can_upload(name));
-- Sin update ni delete: una versión aprobada no se puede cambiar por debajo.

-- ---------- Permisos ----------
revoke all on function private.extension_permissions(), private.extension_text_ok(text, integer, integer), private.extension_name_ok(text),
  private.extension_version_ok(text), private.extension_page_ok(jsonb), private.extension_manifest_ok(text, text, jsonb),
  private.extension_can_read(text), private.extension_can_upload(text) from public, anon, authenticated;
grant execute on function private.extension_can_read(text), private.extension_can_upload(text) to authenticated;
revoke all on function public.extension_catalog(text, text[], integer, integer) from public, anon;
revoke all on function public.extension_blocklist() from public;
revoke all on function public.extension_submit(text, text, jsonb, text, integer) from public, anon;
revoke all on function public.extension_my_submissions() from public, anon;
revoke all on function public.admin_extensions(text) from public, anon;
revoke all on function public.admin_extension_review(uuid, text, text) from public, anon;
revoke all on function public.admin_extension_block(text, boolean, text) from public, anon;
grant execute on function public.extension_catalog(text, text[], integer, integer) to authenticated;
grant execute on function public.extension_blocklist() to anon, authenticated;
grant execute on function public.extension_submit(text, text, jsonb, text, integer) to authenticated;
grant execute on function public.extension_my_submissions() to authenticated;
grant execute on function public.admin_extensions(text) to authenticated;
grant execute on function public.admin_extension_review(uuid, text, text) to authenticated;
grant execute on function public.admin_extension_block(text, boolean, text) to authenticated;
