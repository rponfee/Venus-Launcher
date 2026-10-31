-- Venus Launcher · 0015 · Bucket público "descargas" para el instalador del launcher (lo enlaza la página web, web/index.html).
-- Lectura pública por URL (/storage/v1/object/public/descargas/<archivo>). Nadie puede subir ni cambiar archivos
-- desde la API pública: se suben desde el panel de Supabase (Storage) o con la service role.
-- Idempotente: se puede volver a ejecutar.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('descargas', 'descargas', true, 314572800, array['application/octet-stream', 'application/x-msdownload', 'application/vnd.microsoft.portable-executable'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
