-- 0030_stickers.sql · Venus 3.3 · Stickers y emojis propios de Mensajes.
-- Guía: docs/wip/mensajes-voz-33.md. Se aplica después de 0027. Idempotente.
--
--   * user_stickers: los stickers de cada cuenta. Cada uno tiene un nombre (sirve como :nombre: en el texto) y un archivo
--     en el bucket. Hasta 30 por cuenta, 100 con Premium. Sin acceso directo: todo por RPC security definer.
--   * Bucket público stickers: PNG, WebP o GIF de hasta 256 KB, en <uid>/<id>.<ext>. El archivo se sube primero (con las
--     políticas de abajo) y sticker_create lo registra leyendo el tamaño y el tipo de storage.objects, no lo que diga el
--     cliente. El archivo queda público por URL: lo que se borra deja de resolverse en los clientes (sticker_resolve).
--   * Baneados y muteados no pueden subir (ni el archivo ni el registro); sí pueden borrar lo suyo.
--   * Panel: admin_stickers y admin_sticker_delete (con admin_guard y registro en admin_log). Los admins pueden borrar
--     cualquier archivo del bucket. Denuncias: profile_report de 0027, motivo content, con "sticker:<id>" en el texto.

create schema if not exists private;

-- ---------- Tabla ----------
create table if not exists public.user_stickers (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (name ~ '^[a-z0-9_]{2,24}$'),
  path text not null unique check (char_length(path) <= 120),
  mime text not null check (mime in ('image/png', 'image/webp', 'image/gif')),
  bytes integer not null check (bytes between 1 and 262144),
  created_at timestamptz not null default now(),
  unique (user_id, name)
);
create index if not exists user_stickers_user on public.user_stickers (user_id, created_at desc);
alter table public.user_stickers enable row level security;
revoke all on public.user_stickers from public, anon, authenticated;

-- ---------- Ayudantes ----------
-- Tope de la cuenta: 30, o 100 con Premium
create or replace function private.sticker_max(p_user uuid) returns integer
language sql stable security definer set search_path = '' as $$
  select case when public.venus_is_premium(p_user) then 100 else 30 end
$$;

-- Lo que pide la política de subida: cuenta sin baneo ni silencio y lugar en la carpeta (también frena archivos sueltos)
create or replace function private.sticker_can_upload(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.moderation_social_block(p_user) is null
     and (select count(*) from storage.objects o
           where o.bucket_id = 'stickers' and (storage.foldername(o.name))[1] = p_user::text) < private.sticker_max(p_user)
$$;

create or replace function private.sticker_json(s public.user_stickers) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', s.id, 'userId', s.user_id, 'name', s.name, 'path', s.path, 'mime', s.mime, 'bytes', s.bytes, 'createdAt', s.created_at)
$$;

-- ---------- RPC del launcher ----------
-- Mis stickers (lo más nuevo primero), con el tope que me toca.
create or replace function public.sticker_mine() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(private.sticker_json(s) order by s.created_at desc, s.id) from public.user_stickers s where s.user_id = me), '[]'::jsonb),
    'max', private.sticker_max(me),
    'premium', public.venus_is_premium(me),
    'blocked', public.moderation_social_block(me));
end $$;

-- Resuelve stickers por id (hasta 60), para mostrar los de otros. Lo que no aparece ya no existe.
create or replace function public.sticker_resolve(p_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if p_ids is null then return '[]'::jsonb; end if;
  if cardinality(p_ids) > 60 then raise exception 'too_many' using errcode = '22023'; end if;
  return coalesce((select jsonb_agg(private.sticker_json(s)) from public.user_stickers s where s.id = any (p_ids)), '[]'::jsonb);
end $$;

-- Emojis :nombre: de un mensaje: se buscan solo en la lista del que escribió (hasta 40 nombres).
create or replace function public.sticker_emojis(p_user uuid, p_names text[]) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if p_user is null or p_names is null then return '[]'::jsonb; end if;
  if cardinality(p_names) > 40 then raise exception 'too_many' using errcode = '22023'; end if;
  return coalesce((select jsonb_agg(private.sticker_json(s)) from public.user_stickers s where s.user_id = p_user and s.name = any (p_names)), '[]'::jsonb);
end $$;

-- Registra un archivo ya subido a <uid>/<p_id>.<p_ext>. Errores (22023): bad_id, bad_name, bad_type, too_big, no_file,
-- name_taken, limit_reached; user_banned / user_muted (42501).
create or replace function public.sticker_create(p_id uuid, p_name text, p_ext text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_block text;
  v_name text := lower(btrim(coalesce(p_name, '')));
  v_ext text := lower(coalesce(p_ext, ''));
  v_want text;
  v_path text;
  v_meta jsonb;
  v_bytes bigint;
  s public.user_stickers;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  v_block := public.moderation_social_block(me);
  if v_block is not null then raise exception '%', v_block using errcode = '42501'; end if;
  if p_id is null then raise exception 'bad_id' using errcode = '22023'; end if;
  if v_name !~ '^[a-z0-9_]{2,24}$' then raise exception 'bad_name' using errcode = '22023'; end if;
  v_want := case v_ext when 'png' then 'image/png' when 'webp' then 'image/webp' when 'gif' then 'image/gif' end;
  if v_want is null then raise exception 'bad_type' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext('stickers:' || me::text));
  if (select count(*) from public.user_stickers x where x.user_id = me) >= private.sticker_max(me) then
    raise exception 'limit_reached' using errcode = '22023';
  end if;
  if exists (select 1 from public.user_stickers x where x.user_id = me and x.name = v_name) then raise exception 'name_taken' using errcode = '22023'; end if;
  if exists (select 1 from public.user_stickers x where x.id = p_id) then raise exception 'bad_id' using errcode = '22023'; end if;
  v_path := me::text || '/' || p_id::text || '.' || v_ext;
  select o.metadata into v_meta from storage.objects o where o.bucket_id = 'stickers' and o.name = v_path;
  if not found then raise exception 'no_file' using errcode = '22023'; end if;
  -- El tamaño y el tipo salen del servidor de archivos, no de lo que diga el cliente
  if (v_meta ->> 'mimetype') is distinct from v_want then raise exception 'bad_type' using errcode = '22023'; end if;
  v_bytes := coalesce((v_meta ->> 'size')::bigint, 0);
  if v_bytes < 1 or v_bytes > 262144 then raise exception 'too_big' using errcode = '22023'; end if;
  insert into public.user_stickers (id, user_id, name, path, mime, bytes)
  values (p_id, me, v_name, v_path, v_want, v_bytes)
  returning * into s;
  return private.sticker_json(s);
end $$;

-- Borra un sticker propio. Devuelve la ruta para que el cliente borre el archivo.
create or replace function public.sticker_delete(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_path text;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  delete from public.user_stickers s where s.id = p_id and s.user_id = me returning s.path into v_path;
  if v_path is null then raise exception 'not_found' using errcode = '22023'; end if;
  return jsonb_build_object('ok', true, 'path', v_path);
end $$;

-- ---------- Panel de administración ----------
-- Lista con búsqueda por nombre, usuario o id (del sticker o de la cuenta).
create or replace function public.admin_stickers(p_query text default null, p_limit integer default 100, p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_q text := nullif(btrim(coalesce(p_query, '')), '');
  v_uuid uuid := null;
  v_like text;
  v_limit integer := greatest(1, least(coalesce(p_limit, 100), 200));
  v_offset integer := greatest(0, coalesce(p_offset, 0));
  v_total bigint;
  v_items jsonb;
begin
  perform public.admin_guard();
  if v_q is not null and char_length(v_q) > 80 then raise exception 'bad_query' using errcode = '22023'; end if;
  if v_q ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then v_uuid := v_q::uuid; end if;
  v_like := '%' || replace(replace(replace(coalesce(v_q, ''), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  select count(*) into v_total
    from public.user_stickers s left join public.profiles p on p.id = s.user_id
   where v_q is null or s.id = v_uuid or s.user_id = v_uuid or s.name ilike v_like or p.username ilike v_like;
  select coalesce(jsonb_agg(r.j order by r.created_at desc, r.id), '[]'::jsonb) into v_items from (
    select s.id, s.created_at, private.sticker_json(s) || jsonb_build_object('username', p.username, 'displayName', p.display_name) as j
      from public.user_stickers s left join public.profiles p on p.id = s.user_id
     where v_q is null or s.id = v_uuid or s.user_id = v_uuid or s.name ilike v_like or p.username ilike v_like
     order by s.created_at desc, s.id limit v_limit offset v_offset) r;
  return jsonb_build_object('items', v_items, 'total', v_total);
end $$;

-- Borra un sticker ajeno y lo anota en el registro. Devuelve la ruta: el panel borra el archivo con su sesión.
create or replace function public.admin_sticker_delete(p_id uuid, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  s public.user_stickers;
begin
  perform public.admin_guard();
  if p_note is not null and char_length(p_note) > 300 then raise exception 'bad_note' using errcode = '22023'; end if;
  delete from public.user_stickers x where x.id = p_id returning * into s;
  if s.id is null then raise exception 'not_found' using errcode = '22023'; end if;
  perform public.admin_log(me, (select u.email from auth.users u where u.id = me), 'sticker.delete', s.user_id,
    jsonb_build_object('sticker', s.id, 'name', s.name, 'path', s.path, 'note', nullif(btrim(coalesce(p_note, '')), '')));
  return jsonb_build_object('ok', true, 'path', s.path);
end $$;

-- ---------- Bucket público stickers ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('stickers', 'stickers', true, 262144, array['image/png', 'image/webp', 'image/gif'])
on conflict (id) do update
  set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Cada uno escribe solo <su uid>/<uuid>.<png|webp|gif>. Los archivos no se pisan: un sticker nuevo es un archivo nuevo.
drop policy if exists "stickers_insert_own" on storage.objects;
create policy "stickers_insert_own" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'stickers'
    and name ~ ('^' || (select auth.uid())::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|webp|gif)$')
    and private.sticker_can_upload((select auth.uid()))
  );
drop policy if exists "stickers_delete_own" on storage.objects;
create policy "stickers_delete_own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'stickers' and ((storage.foldername(name))[1] = (select auth.uid())::text or public.is_admin()));
drop policy if exists "stickers_select_own" on storage.objects;
create policy "stickers_select_own" on storage.objects
  for select to authenticated
  using (bucket_id = 'stickers' and ((storage.foldername(name))[1] = (select auth.uid())::text or public.is_admin()));

-- ---------- Permisos ----------
grant usage on schema private to authenticated;
revoke all on function private.sticker_max(uuid) from public, anon, authenticated;
revoke all on function private.sticker_can_upload(uuid) from public, anon;
grant execute on function private.sticker_can_upload(uuid) to authenticated;
revoke all on function private.sticker_json(public.user_stickers) from public, anon, authenticated;
revoke all on function public.sticker_mine() from public, anon;
revoke all on function public.sticker_resolve(uuid[]) from public, anon;
revoke all on function public.sticker_emojis(uuid, text[]) from public, anon;
revoke all on function public.sticker_create(uuid, text, text) from public, anon;
revoke all on function public.sticker_delete(uuid) from public, anon;
revoke all on function public.admin_stickers(text, integer, integer) from public, anon;
revoke all on function public.admin_sticker_delete(uuid, text) from public, anon;
grant execute on function public.sticker_mine() to authenticated;
grant execute on function public.sticker_resolve(uuid[]) to authenticated;
grant execute on function public.sticker_emojis(uuid, text[]) to authenticated;
grant execute on function public.sticker_create(uuid, text, text) to authenticated;
grant execute on function public.sticker_delete(uuid) to authenticated;
grant execute on function public.admin_stickers(text, integer, integer) to authenticated;
grant execute on function public.admin_sticker_delete(uuid, text) to authenticated;
