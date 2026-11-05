# Música de perfil (4.6)

> La canción del perfil ya no se sube: se **elige de un catálogo de música libre** con la API de **Openverse**. Esta guía explica la plataforma elegida y por qué, qué se verificó con pedidos reales, cómo se usa, qué archivos tocan, los límites y lo que quedó sin probar. Reemplaza la parte de "Canción de perfil (`card_style.song { url, title }`)" y del bucket `profile-audio` de [perfiles.md](../perfiles.md) (3.1), que sigue describiendo la versión vieja.

## 1. Plataforma recomendada: Openverse

**Openverse** (Fundación WordPress, `https://api.openverse.org/v1/audio/`) es un buscador de medios con licencias abiertas. Para este pedido ("gratis, sin copyright, conectable") es la que mejor cumple:

| Punto | Openverse |
|---|---|
| Costo y clave | Gratis y **sin clave** (pedidos anónimos). Sin cuenta, sin secretos en el launcher |
| Licencias | Cada resultado trae su licencia Creative Commons (`license`, `license_version`, `license_url`) y se puede filtrar por licencia en el propio pedido |
| Catálogo de audio | Jamendo (≈ 645 mil pistas, música), Wikimedia Commons (≈ 4 millones, grabaciones) y Freesound (≈ 592 mil, sonidos), cifras de `/v1/audio/stats/` del 5/11/2026 |
| Uso desde una app | Una sola API estable y documentada (OpenAPI en `/v1/schema/`) y reproducible directo desde el sitio de origen |
| Límites | **20 pedidos por minuto y 200 por día por IP** (cabeceras `x-ratelimit-limit-anon_burst` y `x-ratelimit-limit-anon_sustained`). Como los pedidos salen de la PC de cada jugador, el tope es **por jugador**, no por todo el launcher |

**Por qué no las otras** (las dos primeras ya venían descartadas en el pedido; la última la comprobé yo):

- **Jamendo directo**: su API gratis es solo para uso no comercial (devportal.jamendo.com/api_terms_of_use, página de 2013: cualquier otro uso, incluido el comercial, pide un acuerdo con Jamendo). Openverse trae las mismas pistas con su licencia CC por pista, sin usar la API de Jamendo.
- **Pixabay**: no tiene API de música.
- **Freesound**: queda adentro de Openverse pero **no se usa** (ver 3.2).

**Condiciones de Openverse que hay que cumplir** (docs.openverse.org/terms_of_service.html): dar atribución a lo que tenga licencia CC; respetar los límites y no esquivarlos con varias máquinas; decir claramente que el producto usa Openverse y que Openverse no lo avala ni certifica (va en el pie de la pestaña Música: `profilemusic.creditsText`); y respetar los términos del sitio que aloja cada audio. Openverse se reserva cobrar usos comerciales o muy intensivos: si el launcher crece mucho, conviene escribirles (y, si hace falta, pasar a OAuth, que sube los topes) antes de que lo pidan.

## 2. Qué se verificó con pedidos reales (5/11/2026)

Unos 70 pedidos de prueba a la API real (de los 200 diarios de la PC de prueba) y pruebas de reproducción dentro de Electron. Las respuestas guardadas, recortadas y con títulos y autores reemplazados por nombres neutros, están en `src/main/modules/profilemusic/test/fixtures/`.

- **Pedido**: `GET /v1/audio/?q=…&source=jamendo,wikimedia_audio&license=by,by-sa,by-nd,cc0,pdm&length=short,medium,long&extension=mp32,mp3,ogg,oga,opus&page_size=20&page=N` (+ `category=music` solo con Jamendo). Responde 200 JSON; `page_size` pasa de 20 solo con clave (401: `page_size may not exceed 20 for anonymous requests`); `result_count` se queda en 240 como máximo.
- **Campos que se usan**: `id` (uuid), `title`, `creator`, `license`, `license_version`, `license_url`, `source`, `url` (audio), `foreign_landing_url` (página de la pista), `duration` (milisegundos), `genres` (solo Jamendo), `mature`, `unstable__sensitivity`.
- **Licencias que salen**: `by`, `by-sa`, `by-nd` (versiones 2.0 a 4.0) y `cc0`. `license_url` del CC0 viene con `/deed.en/`: se guarda la forma canónica (`…/publicdomain/zero/1.0/`). Del filtro `license_type=commercial` la documentación no detalla qué agrupa, así que **no se usa**: se pasan las cinco licencias explícitas.
- **Hosts y formatos del audio**:
  - Jamendo: 71 de 71 resultados en `https://prod-1.storage.jamendo.com/?trackid=<n>&format=mp32` (`audio/mpeg`, 200/206 directo, sin redirecciones, con rangos).
  - Wikimedia Commons: 59 de 59 en `https://upload.wikimedia.org/wikipedia/commons/<x>/<xx>/<archivo>` (`application/ogg`, `accept-ranges: bytes`). Formatos vistos: ogg 18, mp3 12, **wav 19**, flac 2, opus 1, oga 1, webm 1, ogx 5. Se aceptan solo `.ogg`, `.oga`, `.opus` y `.mp3` (wav y flac pesan decenas de MB).
  - Freesound: `https://cdn.freesound.org/previews/…-hq.mp3`, vistas previas de 1,5 a 110 s.
- **`category`**: solo Jamendo la trae (`music`); Wikimedia y Freesound vienen sin categoría, así que `category=music` las deja afuera. Por eso se usa solo con la fuente Jamendo.
- **Duración (`length`)**: `shortest` (1 a 8 s observados), `short` (37 a 116 s), `medium` (148 a 530 s) y `long` (619 s en adelante). La pestaña ofrece corta / media / larga; `shortest` nunca se pide (no alcanza para un tramo de 30 s).
- **Género**: no es un parámetro. `q` busca en título y etiquetas (`fields_matched`: `title`, `tags.name`), no en `genres`, y exige todas las palabras (`ambient piano`: 11 resultados contra 195 de `ambient`). Los géneros de la pestaña son palabras que se suman al texto; se probaron 17 y se ofrecen los 15 que dan resultados útiles (`hiphop` daba 11 y `latin` 23: no se ofrecen).
- **Reproducción con `currentTime`**: dentro de Electron, con la CSP del launcher, un `<audio>` apuntado a una pista de Jamendo y otra de Wikimedia queda `seekable` de 0 a la duración completa, arrancó en el segundo 60 y a los 2,5 s iba por el 62,5, sin errores. Por eso el inicio del tramo se hace con `currentTime` y no hace falta bajar ni recortar nada.
- **429**: no se pudo provocar uno real (24 pedidos seguidos entraron; los contadores de cupo van y vienen entre 17 y 19). El cuerpo de la prueba (`throttled-429.json`) sale del formato documentado de Django REST (`Request was throttled. Expected available in N seconds.` más `Retry-After`) y **no es una captura real**.

## 3. Qué se acepta y qué se excluye

### 3.1 Licencias

Solo las que permiten uso comercial: **CC0, dominio público (PDM), CC BY, CC BY-SA y CC BY-ND**. Se descartan todas las NC, `sampling+` y `nc-sampling+`.

- **BY-ND** (sin derivadas): se reproduce un tramo de la pista tal cual, sin recodificarla ni mezclarla. Es una lectura razonable, no una opinión legal; si el dueño prefiere cero dudas, basta sacar `by-nd` de `LICENSES` en `policy.js` y de la lista de `card_song_ok`.
- La licencia se valida en tres lugares (cliente de la API, interfaz y servidor) y tiene que ser coherente: licencia, versión y dirección canónica de creativecommons.org.

### 3.2 Fuentes

- **Jamendo** (música) y **Wikimedia Commons** (grabaciones libres, mucha música clásica): sí.
- **Freesound**: **no**. Casi todo son efectos y muestras de 1 a 40 s ("Piano C.wav"), sin categoría `music`, y solo ofrece vistas previas recodificadas. Si algún día se quiere, es agregar su host a `SOURCES`, a la CSP y a la migración.
- **Riesgo que hay que conocer**: Jamendo prohíbe el uso comercial de **su API** sin acuerdo, y su página dice que cada pista se rige por la licencia que eligió el artista. Acá no se usa la API de Jamendo (ni `client_id`): se usa la dirección de audio que publica Openverse y la licencia CC de cada pista, que para BY, BY-SA y BY-ND permite el uso comercial con atribución. No hay garantía de que Jamendo esté de acuerdo con enlazar su almacenamiento desde un producto comercial. Si se quiere eliminar ese riesgo, se deja solo Wikimedia (`SOURCE_CHOICES` y el valor por defecto de `source` en `query.js`) o se consulta a licensing@jamendo.com.
- **`mature` y `unstable__sensitivity`**: lo marcado como sensible se descarta.

## 4. Cómo se usa

1. **Activar** (apagado por defecto): Ajustes > Privacidad > **Música de perfil**, o el botón **Activar** de la pestaña Música (y del reproductor de la tarjeta). Es el único interruptor: con él apagado **no sale ningún pedido** a Openverse, Jamendo ni Wikimedia, ni para buscar ni para escuchar. Apagarlo corta todo al instante.
2. **Mi perfil > Música**: texto, género (botones), duración y fuente (Jamendo, Wikimedia o las dos). **Buscar** (o Enter). Cada resultado muestra título, autor, licencia, duración y fuente, con **Escuchar** (los primeros 30 s) y **Elegir**. **Ver más** trae la página siguiente.
3. **Tu canción**: la elegida con su atribución (título con enlace a la página de la pista, autor, licencia con enlace al texto, sitio de origen), **Desde dónde suena** (control del inicio dentro de la pista, con el tramo de 30 s o menos si la pista es corta), **Escuchar** el tramo y **Quitar canción**. Nada se guarda hasta **Guardar** (como el resto del editor).
4. **Tarjeta de perfil**: lo mismo que en la 3.1 (la oyen solo el dueño y los amigos, arranca sola si el que mira no apagó "No reproducir canciones de perfil", volumen, silenciar, botón **Denunciar** del perfil), más: se ve la atribución, suena **solo el tramo elegido** (empieza en `start`, corta a los `len` segundos), y **se pausa mientras hay un juego abierto** (no arranca sola y se frena si se abre uno; el botón de play sigue funcionando).
5. **Mensajes de la búsqueda**: límite por minuto (cuenta atrás y **Reintentar**), cupo del día (cuánto falta), sin conexión (se ven las búsquedas guardadas), error de red, tiempo agotado, servidor, respuesta ilegible, "escribí algo". Si hay una copia vieja de esa búsqueda y no se puede pedir, se muestra la copia con un aviso.

## 5. Datos y reglas

**`cardStyle.song`** (el formato lo valida igual el servidor, el cliente de la API y la interfaz):

```json
{
  "provider": "openverse",
  "id": "<uuid de la pista>",
  "title": "…(1 a 80)",
  "creator": "…(0 a 60)",
  "license": "by | by-sa | by-nd | cc0 | pdm",
  "licenseVersion": "1.0 | 2.0 | 2.5 | 3.0 | 4.0",
  "licenseUrl": "https://creativecommons.org/…/",
  "landing": "https://www.jamendo.com/track/<n> | https://commons.wikimedia.org/…",
  "url": "https://prod-1.storage.jamendo.com/?trackid=<n>&format=mp31|mp32 | https://upload.wikimedia.org/wikipedia/commons/<x>/<xx>/<archivo>.ogg|oga|opus|mp3",
  "start": 0,
  "len": 30
}
```

- Exactamente esas claves; `start` entero de 0 a 86400 y `len` entero de 1 a 30; la dirección del audio y la de la página son del mismo sitio; JSON de hasta 1400 bytes. Con la canción más grande posible y el resto de `card_style` lleno, `card_style` pesa 1447 bytes (el tope es 2048).
- **Texto de otras personas** (título, autor): se dibuja siempre como texto; se limpian caracteres de control y `< >`. Las direcciones se validan contra los hosts fijos antes de usarlas (`<audio>`, enlaces); nada se ejecuta ni se descarga.

## 6. Archivos

| Archivo | Qué hace |
|---|---|
| `src/main/modules/profilemusic.js` | Módulo principal: canales, interruptor, modo falso de desarrollo |
| `src/main/modules/profilemusic/policy.js` | Reglas: licencias, fuentes, hosts, validación de resultados y de la canción guardada |
| `src/main/modules/profilemusic/query.js` | Arma el pedido (filtros, géneros, duraciones, página) |
| `src/main/modules/profilemusic/client.js` | Cliente de la API: User-Agent propio, tiempo máximo, tope de tamaño, validación, caché, límites y reintentos |
| `src/main/modules/profilemusic/store.js` | Caché y contador de pedidos en disco (`data/profilemusic.json`) |
| `src/main/modules/profilemusic/fake.js` | Openverse de mentira para capturas (ver 8) |
| `src/renderer/js/features/profile-editor/music-logic.js` | Copia de las reglas para la interfaz (sin DOM) |
| `src/renderer/js/features/profile-editor/music-ui.js` | Atribución, enlaces y aviso para activar |
| `src/renderer/js/features/profile-editor/music.js` | Pestaña **Música** del editor |
| `src/renderer/js/features/profilemusic.js` | Tarjeta de Ajustes > Privacidad |
| `src/renderer/js/social/song.js` | Reproductor de la tarjeta (reescrito) |
| `src/renderer/styles/features/profilemusic.css` | Estilos |
| `src/renderer/i18n/{es,en}/profilemusic.js` | Textos (namespace `profilemusic`) |
| `supabase/migrations/0042_musica_perfil.sql` | Servidor: `private.card_song_ok` y bucket `profile-audio` |

Se borró la subida de la canción: `uploadSong`, `removeSong`, `prepareSong` y el bucket de `src/renderer/js/features/profile-editor/audio.js`, el bloque entero de elegir archivo, recortar, codificar y subir de `profile-editor.js`, y lo que colgaba de eso en `model.js` (`isProfileAudioUrl`, `AUDIO_FILE`, `AUDIO_TYPES`, `AUDIO_EXTS`, `audioFileName`, `audioUrlWithVersion`, `audioSourceError`, `LIMITS.songBytes` y `songSourceBytes`).

**`audio.js` no se pudo borrar entero**: `voice/ui-board.js` (el soundboard de la voz, no tiene que ver con los perfiles) importa de ahí `decodeAudio`, `clipBuffer` y `encodeWebm` para recortar los sonidos propios. Quedó un `audio.js` mínimo con solo esas tres funciones y `audioSupported`, sin nada de Supabase ni de perfiles y sin depender de `model.js`. Cuando la voz las mude a su carpeta, se borra el archivo.

**Canales** (`profilemusic:`): `status()` → ajustes, uso y límites; `search({ text, genre, length, source, page })` → `{ items, page, pageCount, total, fromCache, stale }` o `{ error, retryAfter? }` (los errores esperados viajan como dato para que llegue `retryAfter`); `clearCache()`.

**Ajustes**: `settings.profileMusic.enabled` (falso por defecto; no hace falta tocar `core/settings.js`). **Datos**: `data/profilemusic.json` (hasta 80 búsquedas, 12 h de frescura, marcas de tiempo de los pedidos de las últimas 24 h).

**Límites propios del cliente** (por debajo de los de Openverse): 12 pedidos por minuto y 160 por día; si Openverse contesta 429 se respeta `Retry-After` y no se vuelve a pedir hasta entonces; un reintento ante errores de red o 5xx; tiempo máximo de 15 s y respuesta de hasta 1,5 MB. El archivo en disco tampoco es de fiar: cada pista se vuelve a validar al leerlo.

**User-Agent**: `VenusLauncher/<versión> (+https://github.com/rponfee/Venus-Launcher; profile music via Openverse)`.

**CSP** (`index.html`): `media-src` ya admitía cualquier `https:`; se sumaron explícitos `https://prod-1.storage.jamendo.com` y `https://upload.wikimedia.org` (los únicos hosts de audio comprobados) para que sigan valiendo si algún día se cierra el `https:` general. Las búsquedas salen del proceso principal, no del navegador.

## 7. Servidor: `0042_musica_perfil.sql`

- Redefine **solo** `private.card_song_ok(uuid, jsonb)` (misma firma, ahora `immutable`): `null` o el objeto de arriba con todas las validaciones (claves exactas, tipos, largos, caracteres, licencia coherente con versión y dirección canónica, hosts y formatos, tramo). `profile_customize` y `profile_public` no se tocan (siguen llamando a esa función y devolviendo `card_style -> 'song'` a amigos y dueño).
- Saca las políticas de **insertar** y **actualizar** del bucket `profile-audio` (no se pueden subir canciones). Quedan `profile_audio_select_own` y `profile_audio_delete_own`.
- **Sin aplicar** (hay que aplicarla después de la 0027). Producción hoy: 0 archivos en `profile-audio` y 0 cuentas con canción, así que no hay nada que migrar. Una canción con el formato viejo (`{ url, title }`) que hubiera quedado la ignora la interfaz y `profile_customize` la rechaza hasta que se quite.
- **Prueba** (producción, una transacción que termina en `rollback`; la base quedó igual: 4 políticas, definición vieja, sin usuarios de prueba): 141 casos, **141 bien**.
  - 18 canciones válidas: Jamendo y Wikimedia, BY 1.0/2.5, BY-SA, BY-ND, CC0, PDM, `mp31`, `mp3`, `opus`, `oga`, `null`, título con acentos y emoji, extremos de `start` y `len`.
  - 17 de licencia: NC, NC-SA, NC-ND, `sampling+`, `nc-sampling+`, mayúsculas, versión que no existe, CC0 con otra versión, URL de licencia de otro host, con `/deed.es`, `http`, de otra licencia o con espacio.
  - 28 de audio y página de origen: `http`, otro host, `jamendo.com.evil`, `prod-2`, Freesound, el formato viejo de Supabase, usuario o puerto en la URL, parámetro de más, `trackid` no numérico, `flac`, `wav`, `?x=1`, `../`, `UPLOAD.wikimedia.org`, `javascript:`, `data:`, `file:`, vacío, número, más de 300 caracteres, página de otro sitio o de la otra fuente.
  - 41 de forma: clave de más o de menos, `provider` distinto, tipos (`start` y `len` como texto, decimales, `null`, fuera de rango), `id` que no es uuid, título vacío o de 81 caracteres o con `<b>` o `>` o caracteres de control o separador de línea, autor de 61, objeto vacío, formato viejo, texto suelto, número, booleano, lista.
  - Tamaño máximo (título y autor de 4 bytes por carácter), permisos (`authenticated` y `anon` no ejecutan la función; `profile_customize` sigue ejecutable y sigue llamándola; misma firma).
  - 17 de punta a punta con tres usuarios simulados: `profile_customize` acepta la canción válida y rechaza NC, otro host, formato viejo y clave de más (la guardada queda intacta); el `card_style` completo más grande entra en el tope de 2 KB; el dueño y un amigo ven la canción en `profile_public` y un tercero no; `song: null` la quita.
  - Bucket: antes de la migración se podía subir `song.webm` como usuario; después falla por RLS (con ese nombre y con cualquier otro); quedan leer y borrar; las políticas de `profile-media` no se tocaron.
- **Sin uso desde ahora**: el bucket `profile-audio` (vacío), `private.profile_audio_url(uuid, jsonb)` y las dos políticas que quedan. Se pueden borrar en una migración futura.
- Esta migración **no cambia** que `profiles.card_style` (y su `song`) se pueda leer con una consulta directa (como en la 3.1: `profile-style.js` la pide para estilos). "Solo la oyen los amigos y el dueño" lo cumple `profile_public` y la interfaz, no la política de la tabla.

## 8. Cómo se prueba

```bash
node --test "src/main/modules/profilemusic/test/"             # 41: reglas, pedido, cliente (respuestas guardadas), módulo, cruce con la interfaz
node --test "src/renderer/js/features/profile-editor/test/"   # incluye music-logic.test.js y el modelo con el formato nuevo
node --test "src/renderer/js/social/test/"                    # shouldAutoplaySong con el juego abierto
node scripts/check.js && node scripts/contracts-check.js && node scripts/i18n-check.js en
```

- **Capturas sin internet**: `VENUS_PROFILEMUSIC_FAKE=1` (con `VENUS_DEVSHOT` y la app sin empaquetar) usa un Openverse de mentira con títulos y autores inventados, pasando por el mismo cliente; `=limit` contesta siempre 429 con `Retry-After: 30`; `=empty` sin resultados. En la app empaquetada o sin `VENUS_DEVSHOT` el modo no existe (hay una prueba). Ejemplo:
  `VENUS_PROFILEMUSIC_FAKE=1 VENUS_DEVSHOT_ROUTES="messages|import('./js/features/profile-editor.js').then((m) => m.openProfileEditor({ demo: 'premium', tab: 'music' }));0" …`
  El perfil de ejemplo `premium` (`features/profile-editor/demo.js`) trae una canción inventada.
- Prueba en vivo (con la API real, una sola vez, desde Electron): apagado → `{ error: 'disabled' }` sin pedir nada; activado → 9 de 10 resultados válidos; la misma búsqueda otra vez sale de la caché; el cupo restante llega de las cabeceras (19 por minuto y 196 por día en ese momento); y el audio de Jamendo y el de Wikimedia se pueden saltar al segundo 60 y suenan.

## 9. Sin probar y pendientes

- **No se pudo provocar un 429 real**; el manejo está probado con el formato documentado, no con una captura.
- **Dos cuentas con Realtime y amistad real en la interfaz**: la visibilidad para amigos está probada en SQL, no en la aplicación con dos sesiones.
- **Pausa con un Minecraft real**: la lógica (`gameBusy` sobre `store.running`) está probada, pero no con un juego abierto de verdad.
- **App empaquetada**, lector de pantalla y teclado en la pestaña nueva (tiene roles, etiquetas y foco, pero no se recorrió con un lector).
- **Los otros 12 idiomas**: solo `es` y `en`; en esos idiomas la pestaña y los avisos salen en inglés por el respaldo.
- **CI**: el workflow no corre la carpeta nueva; hay que sumar `"src/main/modules/profilemusic/test/*.test.js"` a la lista de `build.yml` (no se tocó el archivo).
- **Qué dice Jamendo** sobre enlazar su almacenamiento desde un producto comercial (ver 3.2).
- **Código y textos que quedaron sin uso**: claves de `profile.js` (14 idiomas) `songHint`, `songPick`, `songReplace`, `songRemove`, `songTitle`, `songTitlePlaceholder`, `songStart`, `songFileHint`, `songEncode`, `songEncoding`, `songReady`, `songCurrent`, `songUnsupported`, `songCancel`, `errAudio_type`, `errAudio_too_big` y `errAudio_decode`; y las reglas `.pfe-song*` de `styles/features/profile-editor.css`.
- **Corrección de un defecto de la 3.1** que esto necesitaba: `features/profile-editor.js › combine` no pasaba la canción de `profile_public` (que la manda aparte) al borrador del editor, así que guardar cualquier cambio de estilo habría **borrado la canción** (el servidor reemplaza `card_style` entero). Ahora se vuelve a meter en `card_style.song`.
