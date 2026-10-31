-- Venus Launcher · 0005 · Capturas y clips compartidos (módulo de mundos).
--
-- Decisión de diseño (links para compartir):
--   * Buckets PRIVADOS 'screenshots' (imágenes, hasta 15 MB) y 'clips' (videos, hasta 50 MB).
--   * Cada archivo se guarda en <userId>/<uuid>.<ext>: el uuid lo genera el launcher y no se puede adivinar.
--   * Nadie puede listar ni leer archivos ajenos: las políticas de storage.objects limitan todo a la carpeta
--     del dueño. Para compartir, el launcher crea un link firmado (createSignedUrl) que dura 1 año; quien
--     tenga ese link ve ese archivo y nada más. El dueño lo renueva desde el launcher cuando vence y lo
--     revoca borrando el objeto ("Dejar de compartir").
--   * public.shared_media guarda una fila por archivo compartido (solo la ve y la cambia su dueño).
--   * Límite por usuario: 500 capturas y 100 clips (se controla al subir).
-- Idempotente: se puede volver a aplicar sin romper nada.

-- ---------- Tabla de archivos compartidos ----------
create table if not exists public.shared_media (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind text not null check (kind in ('screenshot', 'clip')),
  bucket text not null check (bucket in ('screenshots', 'clips')),
  path text not null unique check (char_length(path) between 3 and 300),
  file_name text not null check (char_length(file_name) between 1 and 200),
  world text check (char_length(world) <= 120),
  instance_name text check (char_length(instance_name) <= 120),
  size_bytes bigint not null default 0 check (size_bytes >= 0),
  width integer check (width is null or width between 1 and 32768),
  height integer check (height is null or height between 1 and 32768),
  taken_at timestamptz,
  expires_at timestamptz,
  url text check (url is null or (char_length(url) <= 2000 and url ~ '^https://')),
  created_at timestamptz not null default now(),
  -- La ruta siempre empieza con la carpeta del dueño y coincide con el bucket del tipo de archivo
  constraint shared_media_path_owner check (split_part(path, '/', 1) = owner::text),
  constraint shared_media_kind_bucket check ((kind = 'screenshot' and bucket = 'screenshots') or (kind = 'clip' and bucket = 'clips'))
);

create index if not exists shared_media_owner_created on public.shared_media (owner, created_at desc);

alter table public.shared_media enable row level security;

drop policy if exists "shared_media_select_own" on public.shared_media;
create policy "shared_media_select_own" on public.shared_media
  for select to authenticated using (owner = auth.uid());

drop policy if exists "shared_media_insert_own" on public.shared_media;
create policy "shared_media_insert_own" on public.shared_media
  for insert to authenticated with check (owner = auth.uid());

drop policy if exists "shared_media_update_own" on public.shared_media;
create policy "shared_media_update_own" on public.shared_media
  for update to authenticated using (owner = auth.uid()) with check (owner = auth.uid());

drop policy if exists "shared_media_delete_own" on public.shared_media;
create policy "shared_media_delete_own" on public.shared_media
  for delete to authenticated using (owner = auth.uid());

revoke all on public.shared_media from anon;
revoke update on public.shared_media from authenticated;
grant select, insert, delete on public.shared_media to authenticated;
-- Al renovar el link solo cambian estas columnas
grant update (url, expires_at, world, instance_name) on public.shared_media to authenticated;

-- ---------- Buckets ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('screenshots', 'screenshots', false, 15728640, array['image/png', 'image/jpeg', 'image/webp']),
  ('clips', 'clips', false, 52428800, array['video/mp4', 'video/webm', 'video/x-matroska', 'video/quicktime'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Cantidad de archivos del usuario en un bucket (sin pasar por RLS para no recursar en las políticas)
create or replace function public.venus_media_count(p_bucket text) returns integer
language sql stable security definer set search_path = '' as $$
  select count(*)::integer
  from storage.objects o
  where o.bucket_id = p_bucket
    and (storage.foldername(o.name))[1] = (select auth.uid())::text
$$;

revoke all on function public.venus_media_count(text) from public, anon;
grant execute on function public.venus_media_count(text) to authenticated;

-- ---------- Políticas de storage.objects (solo la carpeta propia) ----------
drop policy if exists "venus_media_select_own" on storage.objects;
create policy "venus_media_select_own" on storage.objects
  for select to authenticated
  using (bucket_id in ('screenshots', 'clips') and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "venus_media_insert_own" on storage.objects;
create policy "venus_media_insert_own" on storage.objects
  for insert to authenticated
  with check (
    bucket_id in ('screenshots', 'clips')
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and array_length(storage.foldername(name), 1) = 1
    and public.venus_media_count(bucket_id) < (case bucket_id when 'clips' then 100 else 500 end)
  );

drop policy if exists "venus_media_update_own" on storage.objects;
create policy "venus_media_update_own" on storage.objects
  for update to authenticated
  using (bucket_id in ('screenshots', 'clips') and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id in ('screenshots', 'clips') and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "venus_media_delete_own" on storage.objects;
create policy "venus_media_delete_own" on storage.objects
  for delete to authenticated
  using (bucket_id in ('screenshots', 'clips') and (storage.foldername(name))[1] = (select auth.uid())::text);
