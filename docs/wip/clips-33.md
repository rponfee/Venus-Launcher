# Estudio de clips: montaje, timelapse, subir, OBS y galería

Cinco funciones de la hoja de ruta (64, 65, 66, 67 y 68). Sin dependencias nuevas ni ffmpeg: WebCodecs y el lector y escritor de WebM de `capture/webm.js`. Lo que sigue es para integrar esto en la documentación de siempre ([clips.md](../clips.md), [arquitectura.md](../arquitectura.md) §6 y §7).

## Cómo se usa

- **Montaje de la semana.** Botón en la página de Clips (`#/clips`). Propone los clips automáticos y los destacados de los últimos 7 días (destacado = en el perfil o compartido), en el orden en que pasaron; si no hay, los últimos clips guardados a mano. Se saca, se agrega y se reordena. Duración: 30 s, 1, 2 o 5 minutos, o sin tope; si los clips suman más, de cada uno se usa el **final** (en un clip automático, lo importante acaba de pasar). Placa de título opcional de 2,5 s. El resultado queda en `clips/` como `<fecha>_montage.webm` y aparece en la galería.
- **Timelapse de tu mundo.** Botón en Clips y tarjeta en Ajustes → En el juego. Apagado por defecto y **por instancia**: cada cuánto (5 s a 2 minutos), tope de espacio (256 MB a 5 GB). Guarda JPEG de la ventana del juego en `timelapse/<mundo o server_dirección>/`, solo con un mundo o un servidor abierto. **Generar video** arma un WebM con la velocidad elegida, con progreso y cancelar, y después ofrece mandar las imágenes a la papelera. Sale como `<fecha>_timelapse.webm` en `clips/`.
- **Subir.** Botón en el visor de un clip. Siempre anda el camino del navegador: abre la página de subida, muestra el archivo en su carpeta y copia título y descripción. Con los identificadores cargados al compilar aparece además **Directo desde Venus** (conectar la cuenta, aviso de qué se sube y adónde, progreso y cancelar). YouTube: privado por defecto. TikTok: queda como borrador en la bandeja de la cuenta y se termina de publicar desde la app. Se desconecta desde el mismo diálogo o desde Ajustes → En el juego.
- **OBS.** Ajustes → En el juego, apagado por defecto. Con OBS 28 o más nuevo y su servidor WebSocket prendido. Reglas: escena al abrir el juego, escena al cerrarlo (no si queda otro abierto) y modo streamer mientras OBS transmite o graba.
- **Galería.** Pestaña Galería de Clips (`#/clips/gallery`): Recientes, Más likes de la semana y Mis publicaciones. **Publicar** está en el visor de un clip: si no estaba compartido, primero pasa por el flujo de compartir de siempre. Título de hasta 80 caracteres, con el aviso de que lo ve cualquiera con sesión. Like, denunciar y despublicar. Panel de admin: pestaña Galería.

## Archivos

```
src/main/modules/clipstudio.js          Canales de montaje y timelapse; escucha game.events para el timelapse
src/main/modules/clipstudio/
  webmjoin.js                           Leer de a pedazos, decidir si se une sin recodificar, tramos, encabezado propio (sin Electron)
  job.js                                VideoJob: escribe a <archivo>.part, copia tramos, mezcla audio y cuadros codificados (sin Electron)
  timelapse-logic.js                    Ajustes, carpeta según la actividad, cuándo capturar, tope, cuadro vacío (sin Electron)
  timelapse.js                          Controlador del timelapse, con dependencias inyectadas (sin Electron)
src/main/modules/obs.js                 Conexión, reintentos, reglas y modo streamer
src/main/modules/obs/client.js          Cliente obs-websocket v5 con la WebSocket global (sin Electron)
src/main/modules/obs/logic.js           Ajustes, host permitido, espera, regla del modo streamer, escenas (sin Electron)
src/main/modules/clipupload.js          Tokens, conectar, revocar, subir
src/main/modules/clipupload/
  oauth.js                              PKCE y servidor de retorno en loopback (sin Electron)
  youtube.js · tiktok.js                Las dos API, con fetch inyectado (sin Electron)
  config.js                             Identificadores: variables de entorno en desarrollo, build-config.json al compilar
src/renderer/js/features/clipstudio.js  startup(): tarjetas de Ajustes y aviso de OBS
src/renderer/js/features/clipstudio/
  logic.js                              Selección, reparto de la duración, cuentas del timelapse (sin DOM)
  encoder.js                            FrameEncoder (WebCodecs), placa de título, recodificar un tramo
  montage.js · timelapse.js · upload.js · obs-panel.js · icons.js
src/renderer/js/pages/clips/gallery.js  Pestaña Galería, publicar, denunciar (gallery-logic.js sin DOM)
src/renderer/js/pages/admin/gallery.js  Pestaña Galería del panel
src/renderer/styles/features/clipstudio.css
src/renderer/i18n/{es,en}/clipstudio.js · src/main/i18n/{es,en}/clipstudio.js
supabase/migrations/0032_galeria_clips.sql
supabase/functions/tiktok-token/        Intercambio de tokens de TikTok (el secreto queda en el servidor)
```

Tocados con poco: `capture.js` (`grabFrame`, `savedElsewhere`), `capture/host.js` (`grab` acepta opciones), `recorder/main.js` (`grab`: formato, tamaño y reusar la captura andando), `pages/clips.js` y `pages/clips/viewer.js`.

## Cómo funciona el montaje

- `planJoin` mira los encabezados: mismo codec (VP8 o VP9), mismo tamaño, mismo audio y pistas de un byte → **se une sin recodificar**. Un clip sin audio no lo impide: en su tramo hay silencio. Un montaje de 9 s tardó 124 ms en esta PC.
- Si no, **se recodifica el video con WebCodecs** (`VideoDecoder` → canvas → `VideoEncoder`, VP9, en la ventana del launcher: los codificadores trabajan fuera del hilo de la interfaz) al tamaño del clip más grande, con tope en 1080p y franjas negras si cambia la forma. **El audio se copia** tal cual (Opus): queda en el proceso principal y se mezcla por tiempo con lo que vuelve codificado. Los clips con otro audio quedan en silencio. Cerca de 0,5 s de trabajo por segundo de video a 720p en esta PC.
- Un tramo recortado empieza en el cuadro clave anterior a donde se pidió y corta en el largo pedido desde ahí. Nunca se pisa un cuadro clave ajeno: el video tiene que arrancar en uno.
- `VideoDecoder` se configura con `SOURCE_COLOR` (BT.601): MediaRecorder no guarda el espacio de color y un `<video>` lo muestra así. Sin eso, lo recodificado salía con los colores corridos.
- Solo WebM de `clips/`. MP4 u otros videos sueltos no se proponen ni se pueden agregar, y lo que ya es un montaje o un timelapse tampoco.

## Canales

| Canal | Qué hace |
|---|---|
| `clipstudio:probe([rutas])` | `[{ path, ok, reason?, codec, width, height, duration, audio }]` |
| `clipstudio:montageOpen({ instanceId, segments: [{ path, start, length }] })` | `{ jobId, mode ('copy' \| 'encode'), width, height, codec, reason, segments }` |
| `clipstudio:montageCopy(jobId)` | Une sin recodificar; `true`, o `false` si se canceló |
| `clipstudio:montageSegment(jobId, i)` · `clipstudio:montageRead(jobId, max)` | Abre un tramo para recodificar · `{ frames: [{ time, key, data }], done }` |
| `clipstudio:frames(jobId, frames)` | Cuadros ya codificados, en orden |
| `clipstudio:finish(jobId)` | `{ path, name, duration, instanceId }` |
| `clipstudio:cancel(jobId)` | Borra el temporal |
| `clipstudio:timelapseOpen({ instanceId, folder, width, height, codec, frameMs })` | `{ jobId }` |
| `clipstudio:timelapseConfig(instanceId, patch?)` | Ajustes de la instancia |
| `clipstudio:timelapseList(instanceId)` | `{ config, used, folders: [{ folder, count, bytes, first, last }] }` |
| `clipstudio:timelapseFrames(instanceId, carpeta)` · `clipstudio:timelapseRead(instanceId, carpeta, nombre)` | Nombres · bytes de una imagen |
| `clipstudio:timelapseOpenFolder(instanceId, carpeta?)` · `clipstudio:timelapseDelete(instanceId, carpeta)` | Abrir · a la papelera |
| `clipstudio:timelapseStatus()` | `{ active, instanceId, folder, frames, used, capBytes, stopped ('full' \| 'noDisk' \| null) }` |
| `obs:status()` · `obs:test({ host, port, password? })` · `obs:setPassword(texto \| null)` | La contraseña entra y nunca vuelve |
| `clipupload:status()` | `{ youtube: { configured, connected }, tiktok: { configured, connected } }` |
| `clipupload:connect(proveedor)` · `clipupload:cancelConnect()` · `clipupload:revoke(proveedor)` | Abre el navegador y espera la vuelta |
| `clipupload:upload({ jobId, provider, path, title, description, privacy })` · `clipupload:cancel(jobId)` | Los tokens nunca llegan a la interfaz |

Eventos: `clipstudio:progress { jobId, done, total }`, `clipstudio:timelapse` (lo mismo que `timelapseStatus`), `obs:state` (lo mismo que `obs:status`), `obs:streamer { on }` (la interfaz relee los ajustes), `clipupload:progress { jobId, sent, total }`. Lo que se guarda en `clips/` avisa con `capture:saved` y `worlds:updated` (`capture.savedElsewhere`), con la copia extra incluida.

Errores con `err.code`: `instance`, `job`, `write`, `clip`, `empty`, `badWebm`, `folder`, `trash`; OBS `refused`, `timeout`, `auth`, `authRequired`, `version`, `host`; subir `session`, `quota`, `noChannel`, `forbidden`, `badRequest`, `network`, `rejected`, `tooBig`, `denied`, `noSession`, `broker`, `notConfigured`, `cancelled`, `failed`.

## Ajustes y datos

- `settings.obs`: `{ enabled (false), host ('127.0.0.1'), port (4455), sceneOnOpen (''), sceneOnClose (''), streamerWhileLive (true), streamerOwned (false) }`. `streamerOwned` = el modo streamer lo prendió esta integración; sobrevive a cerrar el launcher. El host solo acepta esta PC o la red local.
- `<instancia>/.venus/timelapse.json`: `{ enabled (false), every (30), capMb (1024) }`. No se exporta ni se comparte (6.7). Duplicar una instancia lo copia, y `timelapse/` también.
- `<instancia>/timelapse/<carpeta>/<fecha>.jpg`: fuera de las carpetas que exportan los packs (`packs/export.js`) y las instantáneas (`snapshots/scan.js`).
- `clips/<fecha>_montage.webm`, `clips/<fecha>_timelapse.webm`. Mientras se arman van a `<nombre>.part`: un corte a la mitad no aparece como clip.
- Secretos (`core/secure`, cifrados con `safeStorage`): `obs.password`, `clipupload.youtube`, `clipupload.tiktok`.

## Galería: tablas y RPC (`0032_galeria_clips.sql`)

Tablas con RLS y sin acceso directo: `clip_gallery` (`media_id` único → `shared_media`, en cascada), `clip_gallery_likes`, `clip_gallery_reports`. Hace falta sesión de una cuenta de verdad: `anon` no tiene permiso de ejecutar nada y una cuenta anónima recibe `not_authenticated`.

| RPC | Qué hace | Errores |
|---|---|---|
| `gallery_publish(p_media, p_title, p_thumb?)` | 5 por día. Devuelve `{ id, expiresAt }` | `not_authenticated`, `user_banned`, `user_muted`, `bad_title`, `bad_thumb`, `not_shared`, `bad_link`, `expired`, `already_published`, `hidden_by_admin`, `too_many_today` |
| `gallery_unpublish(p_id)` | Solo el dueño; `false` si no es suyo | `hidden_by_admin` |
| `gallery_list(p_sort 'recent' \| 'week', p_offset, p_limit)` | `{ items: [{ id, title, url, thumb, at, expiresAt, likes, likesWeek, liked, mine, author }], more }` | `not_authenticated` |
| `gallery_mine()` | Lo propio, también lo vencido u oculto, con `expired`, `hidden`, `hiddenReason` | — |
| `gallery_like(p_id, p_like)` | Uno por usuario, 200 por día, nunca en lo propio. `{ liked, likes, likesWeek }` | `user_banned`, `not_found`, `own_clip`, `too_many_today` |
| `gallery_report(p_id, p_reason, p_text?)` | 10 por día; `offensive`, `spam`, `stolen` u `other`; repetir no suma | `user_banned`, `not_found`, `own_clip`, `bad_reason`, `bad_text`, `too_many_today` |
| `admin_gallery_list(p_filter 'reported' \| 'hidden' \| 'all', p_offset)` | Con `admin_guard()` | `admin_only` |
| `admin_gallery_hide(p_id, p_hidden, p_reason?)` · `admin_gallery_delete(p_id, p_reason?)` · `admin_gallery_reports_close(p_id)` | Con `admin_log`: `gallery.hide`, `gallery.show`, `gallery.delete`, `gallery.close` | `admin_only`, `not_found` |

Cosas decididas:

- **El vencimiento no se alarga.** La publicación guarda su `expires_at` al publicar y nunca lo corre: renovar el link no la deja más tiempo en la galería. Vencida, sale de la lista y de los likes, y `gallery_mine` la muestra con el aviso; para seguir hay que volver a publicar. El clip sigue en el bucket `clips`, con su tope de 50 MB y de 100 por usuario: no se suma almacenamiento.
- **La lista no confía en `shared_media`.** El dueño tiene permiso para cambiar `url` y `expires_at` de su fila, así que `private.gallery_url_ok` exige un link firmado del Storage para esa misma ruta y la interfaz lo vuelve a revisar con `safeClipUrl`. Sin esto, un clip podía hacerle cargar a los demás una dirección cualquiera.
- **Miniatura.** `thumb` es un JPEG en `data:` de 320 px que arma el launcher del dueño, hasta 32 KB. Así la grilla no baja un video por tarjeta (`preload="none"`): solo se baja el clip que alguien abre. La miniatura la elige el dueño: es tan moderable como el clip.
- **Quien publica muestra el link.** Despublicar no revoca un link que alguien ya guardó (por eso el aviso al publicar). Dejar de compartir sí: borra el objeto y, en cascada, la publicación.
- **Silenciados** no publican (el título es texto para todos) pero sí dan like. **Baneados** no hacen nada de eso y sus clips no se listan.
- Se excluyen de la lista los usuarios bloqueados, en las dos direcciones.

## Lo que le toca al dueño

### 1. Aplicar la migración

`supabase/migrations/0032_galeria_clips.sql`. Se probó con `begin; …; rollback;` y **no está aplicada**. Sin ella, la pestaña dice que el servicio no está disponible.

### 2. YouTube (opcional)

1. En Google Cloud: un proyecto, **YouTube Data API v3** habilitada, pantalla de consentimiento con el permiso `.../auth/youtube.upload` y un cliente OAuth de tipo **App de escritorio**.
2. `youtube.upload` es un permiso sensible: hasta verificar la app, la pantalla de consentimiento avisa que no está verificada y, en modo de prueba, acepta solo los usuarios cargados a mano. Según la documentación de `videos.insert` revisada el 3 de noviembre de 2026, cada subida gasta 1 unidad del cupo Video Uploads, con 100 llamadas por día para todo el proyecto, y lo subido desde un proyecto sin verificar ya no queda forzado a privado. Conviene volver a mirarlo antes de lanzar: ese cupo es de toda la aplicación, no de cada usuario.
3. El ID del cliente no es secreto. Google marca el `client_secret` como opcional y aclara que en escritorio no es confidencial, pero no se pudo probar con un cliente real: si el intercambio contesta `client_secret is missing`, cargá también `VENUS_YOUTUBE_CLIENT_SECRET`.

### 3. TikTok (opcional)

TikTok manda hacer el intercambio de tokens **desde un servidor** con el `client_secret`, que no puede ir en el instalador. Por eso el launcher solo lleva el `client_key` y el resto pasa por la función `tiktok-token`.

1. En developers.tiktok.com: una app con **Login Kit** (Desktop, redirect `http://127.0.0.1:*/callback/`) y **Content Posting API** con **Upload** (scope `video.upload`). TikTok tiene que aprobar la app.
2. `supabase secrets set TIKTOK_CLIENT_KEY=... TIKTOK_CLIENT_SECRET=...`
3. `supabase functions deploy tiktok-token` (con la verificación de JWT activada).
4. Conectar TikTok pide tener iniciada la sesión de Venus.

Límites de TikTok: 5 subidas pendientes cada 24 horas por cuenta y 6 inicios por minuto. No se usa la publicación directa (`video.publish`): pide otra auditoría.

### 4. Cargar los identificadores al compilar

Igual que la clave de CurseForge: secretos de GitHub Actions que `scripts/write-build-config.js` escribe en `src/main/core/build-config.json` (no se sube). Esos dos archivos no se tocaron. Hay que sumar:

```js
// scripts/write-build-config.js: en vez de escribir solo la clave de CurseForge
const out = {};
if (key) out.curseforgeApiKey = key;
for (const [field, name] of [['youtubeClientId', 'VENUS_YOUTUBE_CLIENT_ID'], ['youtubeClientSecret', 'VENUS_YOUTUBE_CLIENT_SECRET'], ['tiktokClientKey', 'VENUS_TIKTOK_CLIENT_KEY']]) {
  const value = String(process.env[name] || '').trim();
  if (value) out[field] = value;
}
if (Object.keys(out).length) fs.writeFileSync(OUT, `${JSON.stringify(out)}\n`);
```

```yaml
# .github/workflows/build.yml, en el paso que ya tiene VENUS_CURSEFORGE_API_KEY
VENUS_YOUTUBE_CLIENT_ID: ${{ secrets.VENUS_YOUTUBE_CLIENT_ID }}
VENUS_YOUTUBE_CLIENT_SECRET: ${{ secrets.VENUS_YOUTUBE_CLIENT_SECRET }}
VENUS_TIKTOK_CLIENT_KEY: ${{ secrets.VENUS_TIKTOK_CLIENT_KEY }}
```

En desarrollo alcanza con las variables de entorno (solo sin empaquetar, como `core/app-config.js`). Sin identificadores, el camino directo no se muestra y el resto anda igual.

## Límites conocidos

- **Subida real sin probar:** ni YouTube ni TikTok se probaron contra sus servidores. Se probó PKCE, los pedidos reanudables con `fetch` falso y el manejo del 308 con el `fetch` de verdad contra un servidor local. Tampoco se probó el navegador de vuelta contra un OAuth real.
- **OBS real sin probar:** se probó con un socket falso y con un servidor WebSocket local que habla el protocolo v5, con el `WebSocket` de Electron. No contra OBS de verdad, ni el flujo entero de escenas con un juego abierto.
- **Timelapse con Minecraft sin probar:** la captura se probó contra una ventana de prueba propia, por su id, y el controlador con dependencias falsas. Se saltea un cuadro de un solo color (ventana minimizada: pesa menos de 0,025 bytes por píxel); una pantalla realmente lisa también se saltea.
- Un juego en pantalla completa **exclusiva** puede verse negro, igual que en los clips ([clips.md](../clips.md)): esos cuadros se saltean.
- Si hay dos juegos abiertos, el timelapse sigue al que se abrió último, como la captura.
- Duplicar una instancia copia `timelapse/` y su ajuste.
- Montaje: el resumen del diálogo mira codec y tamaño; si solo difiere el audio dice "sin recodificar" y al crear recodifica. Con el recorte, un tramo arranca en el cuadro clave anterior, así que puede arrancar hasta 2 s antes de lo que marcaría la cuenta (el largo se respeta).
- Una imagen rota del timelapse se saltea y el video queda un cuadro más corto.
- Admin **Borrar** saca la publicación pero no el archivo: desde SQL no se puede borrar un objeto del Storage. El dueño la puede volver a publicar; para frenarlo está **Ocultar** (no se puede volver a publicar ese clip) o el baneo.
- Galería: `gallery_list` cuenta likes de todo lo visible en cada página, sin caché. Alcanza para miles de clips; si crece más, conviene un contador.

## Cómo verificar

```bash
node --test "src/main/modules/clipstudio/test/" "src/main/modules/obs/test/" "src/main/modules/clipupload/test/" "src/main/modules/capture/test/"
node --test "src/renderer/js/features/clipstudio/test/logic.test.js" "src/renderer/js/pages/clips/test/gallery.test.js" "supabase/functions/tiktok-token/tests/handler.test.ts"
```

Sin Minecraft: un `VENUS_DATA_DIR` temporal con `instances/<id>/venus-instance.json`, clips generados en la ventana de desarrollo con `MediaRecorder` sobre un canvas (`capture:saveExport`) y el diálogo real; después cada resultado se carga en un `<video>` y se revisa duración, tamaño, adelantar, llegar al final y el color de cada tramo.
