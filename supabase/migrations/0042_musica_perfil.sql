-- 0042_musica_perfil.sql · Venus 4.6 · Música de perfil: la canción se elige de Openverse, ya no se sube.
-- Guía: docs/wip/musica-perfil-46.md y docs/perfiles.md. Se aplica después de 0027 (y de lo que haya hasta 0041).
-- Idempotente. No toca profile_customize ni profile_public: los dos siguen llamando a private.card_song_ok(me, v -> 'song')
-- y a la columna card_style -> 'song', que ahora tiene este formato (el cliente lo arma con features/profile-editor/music-logic.js):
--
--   cardStyle.song = null | {
--     provider: 'openverse',                     el catálogo; hoy es el único
--     id:       uuid de la pista en Openverse,
--     title:    texto de 1 a 80 caracteres (sin control ni < >),
--     creator:  texto de hasta 60 caracteres (puede ir vacío si la fuente no lo dice),
--     license:  'by' | 'by-sa' | 'by-nd' | 'cc0' | 'pdm'      (solo licencias que permiten uso comercial; nada de NC),
--     licenseVersion: '1.0' | '2.0' | '2.5' | '3.0' | '4.0'   (cc0 y pdm: '1.0'),
--     licenseUrl: https://creativecommons.org/... en su forma canónica (coherente con license y licenseVersion),
--     landing:  página de la pista en su sitio (https, del mismo sitio que el audio),
--     url:      el audio (https, solo estos hosts y estos formatos):
--                 Jamendo:   https://prod-1.storage.jamendo.com/?trackid=<n>&format=mp31|mp32      (landing https://www.jamendo.com/track/<n>)
--                 Wikimedia: https://upload.wikimedia.org/wikipedia/commons/<x>/<xx>/<archivo>.ogg|oga|opus|mp3
--                            (landing https://commons.wikimedia.org/w/index.php?curid=<n> o /wiki/File:<archivo>)
--     start:    segundo donde empieza el tramo (entero, 0 a 86400),
--     len:      segundos que suena (entero, 1 a 30)
--   }
--   exactamente esas claves, todas presentes, y el JSON entero de hasta 1400 bytes (card_style completo queda debajo de los 2 KB
--   que fija profiles_custom3_size).
--
--   * Se redefine solo private.card_song_ok(uuid, jsonb) (misma firma; p_user ya no se usa).
--   * El bucket profile-audio deja de aceptar subidas: se sacan las políticas de insertar y actualizar. Quedan la de leer y la de
--     borrar para quien ya tenga archivos (hoy ninguna cuenta tiene canción). El bucket y private.profile_audio_url(uuid, jsonb)
--     quedan sin uso; se pueden borrar en una migración futura cuando el bucket esté vacío.

create or replace function private.card_song_ok(p_user uuid, v jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(
    jsonb_typeof(v) = 'null'
    or (
      jsonb_typeof(v) = 'object'
      and octet_length(v::text) <= 1400
      -- exactamente estas claves, todas presentes
      and not exists (select 1 from jsonb_object_keys(v) k
                       where k not in ('provider', 'id', 'title', 'creator', 'license', 'licenseVersion', 'licenseUrl', 'landing', 'url', 'start', 'len'))
      and v ?& array['provider', 'id', 'title', 'creator', 'license', 'licenseVersion', 'licenseUrl', 'landing', 'url', 'start', 'len']
      -- tipos
      and jsonb_typeof(v -> 'provider') = 'string' and jsonb_typeof(v -> 'id') = 'string'
      and jsonb_typeof(v -> 'title') = 'string' and jsonb_typeof(v -> 'creator') = 'string'
      and jsonb_typeof(v -> 'license') = 'string' and jsonb_typeof(v -> 'licenseVersion') = 'string'
      and jsonb_typeof(v -> 'licenseUrl') = 'string' and jsonb_typeof(v -> 'landing') = 'string'
      and jsonb_typeof(v -> 'url') = 'string'
      and jsonb_typeof(v -> 'start') = 'number' and jsonb_typeof(v -> 'len') = 'number'
      and (v ->> 'provider') = 'openverse'
      and (v ->> 'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      -- texto que se muestra: sin caracteres de control ni < >
      and char_length(v ->> 'title') between 1 and 80 and btrim(v ->> 'title') <> '' and (v ->> 'title') !~ '[\x00-\x1f\x7f\u2028\u2029<>]'
      and char_length(v ->> 'creator') <= 60 and (v ->> 'creator') !~ '[\x00-\x1f\x7f\u2028\u2029<>]'
      -- tramo
      and (v ->> 'start') ~ '^(0|[1-9][0-9]{0,3}|[1-7][0-9]{4}|8[0-5][0-9]{3}|86[0-3][0-9]{2}|86400)$'
      and (v ->> 'len') ~ '^([1-9]|[12][0-9]|30)$'
      -- licencia: solo las que permiten uso comercial, con su versión y su dirección canónica
      and (v ->> 'license') in ('by', 'by-sa', 'by-nd', 'cc0', 'pdm')
      and char_length(v ->> 'licenseUrl') <= 80
      and case v ->> 'license'
            when 'cc0' then (v ->> 'licenseVersion') = '1.0' and (v ->> 'licenseUrl') = 'https://creativecommons.org/publicdomain/zero/1.0/'
            when 'pdm' then (v ->> 'licenseVersion') = '1.0' and (v ->> 'licenseUrl') = 'https://creativecommons.org/publicdomain/mark/1.0/'
            else (v ->> 'licenseVersion') in ('1.0', '2.0', '2.5', '3.0', '4.0')
                 and (v ->> 'licenseUrl') = 'https://creativecommons.org/licenses/' || (v ->> 'license') || '/' || (v ->> 'licenseVersion') || '/'
          end
      -- audio y página de origen: del mismo sitio, https, solo los hosts y formatos conocidos
      and char_length(v ->> 'url') <= 300 and char_length(v ->> 'landing') <= 120
      and (
        ((v ->> 'url') ~ '^https://prod-1\.storage\.jamendo\.com/\?trackid=[0-9]{1,10}&format=mp3[12]$'
          and (v ->> 'landing') ~ '^https://www\.jamendo\.com/track/[0-9]{1,10}$')
        or
        ((v ->> 'url') ~ '^https://upload\.wikimedia\.org/wikipedia/commons/[0-9a-f]/[0-9a-f]{2}/[A-Za-z0-9._%~+-]{1,200}\.(ogg|oga|opus|mp3)$'
          and (v ->> 'landing') ~ '^https://commons\.wikimedia\.org/(w/index\.php\?curid=[0-9]{1,10}|wiki/File:[A-Za-z0-9._%~+()-]{1,200})$')
      )
    ), false)
$$;

revoke all on function private.card_song_ok(uuid, jsonb) from public, anon, authenticated;

-- ---------- Bucket profile-audio: ya no se suben canciones ----------
-- Se sacan las políticas de subida. Leer (select_own) y borrar (delete_own) quedan para quien ya tuviera un archivo.
drop policy if exists "profile_audio_insert_own" on storage.objects;
drop policy if exists "profile_audio_update_own" on storage.objects;
