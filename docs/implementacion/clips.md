# Estudio de clips: montaje, timelapse, subida y galería

> **Actualización de la 4.6:** la integración con OBS se retiró junto con el modo streamer (módulo, canales `obs:*`, tarjeta de Ajustes, ajustes `obs.*` y `obs-panel.js`). Las menciones a OBS que quedan más abajo son históricas, de la revisión de la 4.5.0, y no describen código vigente. Montaje, timelapse, subida a YouTube/TikTok y galería siguen igual.

> **Actualización del 4 de noviembre de 2026:** se retiró el modo streamer. OBS conserva conexión, estados, escenas y controles de grabación; ya no emite `obs:streamer` ni modifica `privacy.streamer`. Los resultados históricos sobre ese automatismo describen la implementación anterior. [Retirada y pruebas actuales](../retirada-funciones.md).

> **Rama 4.5.0, sin publicar.** Consolidación documental del 3 de noviembre de 2026, reconciliada con el WIP congelado. Los informes de cada frente se conservan como antecedentes; las pruebas posteriores están atribuidas al final o en el estado de integración. Contratos y límites del código local; producción continúa hasta 0027 según la integración principal. Los resultados previos pertenecen a sus informes y no equivalen a pruebas externas repetidas ni a un despliegue. Ver [estado de integración](../estado-4.5.0.md).

Cinco funciones de la hoja de ruta (64, 65, 66, 67 y 68). Sin dependencias nuevas ni ffmpeg: WebCodecs y el lector y escritor de WebM de `capture/webm.js`. Esta referencia conserva el detalle técnico de [clips](../clips.md) y [arquitectura](../arquitectura.md).

## Cómo se usa

- **Montaje de la semana.** Botón en la página de Clips (`#/clips`). Propone los clips automáticos y los destacados de los últimos 7 días (destacado = en el perfil o compartido), en el orden en que pasaron; si no hay, los últimos clips guardados a mano. Se saca, se agrega y se reordena. Duración: 30 s, 1, 2 o 5 minutos, o sin tope; si los clips suman más, de cada uno se usa el **final** (en un clip automático, lo importante acaba de pasar). Placa de título opcional de 2,5 s. El resultado queda en `clips/` como `<fecha>_montage.webm` y aparece en la galería.
- **Timelapse de tu mundo.** Botón en Clips y tarjeta en Ajustes → En el juego. Apagado por defecto y **por instancia**: cada cuánto (5 s a 2 minutos), tope de espacio (256 MB a 5 GB). Guarda JPEG de la ventana del juego en `timelapse/<mundo o server_dirección>/`, solo con un mundo o un servidor abierto. **Generar video** arma un WebM con la velocidad elegida, con progreso y cancelar, y después ofrece mandar las imágenes a la papelera. Sale como `<fecha>_timelapse.webm` en `clips/`.
- **Subir.** Botón en el visor de un clip. Siempre anda el camino del navegador: abre la página de subida, muestra el archivo en su carpeta y copia título y descripción. Con los identificadores cargados al compilar aparece además **Directo desde Venus** (conectar la cuenta, aviso de qué se sube y adónde, progreso y cancelar). YouTube: privado por defecto. TikTok: queda como borrador en la bandeja de la cuenta y se termina de publicar desde la app. Se desconecta desde el mismo diálogo o desde Ajustes → En el juego.
- **Galería.** Pestaña Galería de Clips (`#/clips/gallery`): Recientes, Más likes de la semana y Mis publicaciones. **Publicar** está en el visor de un clip: si no estaba compartido, primero pasa por el flujo de compartir de siempre. Título de hasta 80 caracteres, con el aviso de que lo ve cualquiera con sesión. Like, denunciar y despublicar. Panel de admin: pestaña Galería.

## Archivos

```
src/main/modules/clipstudio.js          Canales de montaje y timelapse; escucha game.events para el timelapse
src/main/modules/clipstudio/
  webmjoin.js                           Leer de a pedazos, decidir si se une sin recodificar, tramos, encabezado propio (sin Electron)
  job.js                                VideoJob: escribe a <archivo>.part, copia tramos, mezcla audio y cuadros codificados (sin Electron)
  timelapse-logic.js                    Ajustes, carpeta según la actividad, cuándo capturar, tope, cuadro vacío (sin Electron)
  timelapse.js                          Controlador del timelapse, con dependencias inyectadas (sin Electron)
src/main/modules/clipupload.js          Tokens, conectar, revocar, subir
src/main/modules/clipupload/
  oauth.js                              PKCE y servidor de retorno en loopback (sin Electron)
  youtube.js · tiktok.js                Las dos API, con fetch inyectado (sin Electron)
  config.js                             Identificadores: variables de entorno en desarrollo, build-config.json al compilar
src/renderer/js/features/clipstudio.js  startup(): tarjetas de Ajustes
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
| `clipupload:status()` | `{ youtube: { configured, connected }, tiktok: { configured, connected } }` |
| `clipupload:connect(proveedor)` · `clipupload:cancelConnect()` · `clipupload:revoke(proveedor)` | Abre el navegador y espera la vuelta |
| `clipupload:upload({ jobId, provider, path, title, description, privacy })` · `clipupload:cancel(jobId)` | Los tokens nunca llegan a la interfaz |

Eventos: `clipstudio:progress { jobId, done, total }`, `clipstudio:timelapse` (lo mismo que `timelapseStatus`), `obs:state` (lo mismo que `obs:status`), `clipupload:progress { jobId, sent, total }`. Lo que se guarda en `clips/` avisa con `capture:saved` y `worlds:updated` (`capture.savedElsewhere`), con la copia extra incluida.

Errores con `err.code`: `instance`, `job`, `write`, `clip`, `empty`, `badWebm`, `folder`, `trash`; OBS `refused`, `timeout`, `auth`, `authRequired`, `version`, `host`; subir `session`, `quota`, `noChannel`, `forbidden`, `badRequest`, `network`, `rejected`, `tooBig`, `denied`, `noSession`, `broker`, `notConfigured`, `cancelled`, `failed`.

## Ajustes y datos

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
3. La [documentación de OAuth de escritorio de Google](https://developers.google.com/identity/protocols/oauth2/native-app), consultada el 3 de noviembre de 2026, marca `client_secret` como opcional y considera las apps instaladas clientes públicos. No se validó un cliente OAuth real. El build distribuye solamente `youtubeClientId` y `tiktokClientKey`, sin secretos OAuth. Si un proveedor exige un secreto que el flujo público actual no puede resolver, la subida directa queda **no lista hasta disponer de un flujo aprobado y probado**. No habilitar un secreto en el instalador ni en el workflow como solución. La revisión automática rechazó la propuesta de persistir el valor opcional de YouTube; el camino aceptado utiliza únicamente los dos identificadores públicos.

### 3. TikTok (opcional)

TikTok manda hacer el intercambio de tokens **desde un servidor** con el `client_secret`, que no puede ir en el instalador. Por eso el launcher solo lleva el `client_key` y el resto pasa por la función `tiktok-token`.

1. En developers.tiktok.com: una app con **Login Kit** (Desktop, redirect `http://127.0.0.1:*/callback/`) y **Content Posting API** con **Upload** (scope `video.upload`). TikTok tiene que aprobar la app.
2. `supabase secrets set TIKTOK_CLIENT_KEY=... TIKTOK_CLIENT_SECRET=...`
3. `supabase functions deploy tiktok-token` (con la verificación de JWT activada).
4. Conectar TikTok pide tener iniciada la sesión de Venus.

Límites de TikTok: 5 subidas pendientes cada 24 horas por cuenta y 6 inicios por minuto. No se usa la publicación directa (`video.publish`): pide otra auditoría.

### 4. Cargar los identificadores al compilar

Los identificadores públicos `VENUS_YOUTUBE_CLIENT_ID` y `VENUS_TIKTOK_CLIENT_KEY` ya se incorporan mediante `scripts/write-build-config.js` a `src/main/core/build-config.json` (no se sube). Funcionan aunque CurseForge no esté configurado, se omiten los vacíos y nunca se imprimen valores. El workflow queda a cargo de la integración principal: este frente no lo editó. El script ahora contiene:

```js
// scripts/write-build-config.js: conserva CurseForge y agrega los identificadores públicos
const out = {};
if (key) out.curseforgeApiKey = key;
for (const [field, name] of [['youtubeClientId', 'VENUS_YOUTUBE_CLIENT_ID'], ['tiktokClientKey', 'VENUS_TIKTOK_CLIENT_KEY']]) {
  const value = String(process.env[name] || '').trim();
  if (value) out[field] = value;
}
if (Object.keys(out).length) fs.writeFileSync(OUT, `${JSON.stringify(out)}\n`);
```

```yaml
# .github/workflows/build.yml, en el paso que ya tiene VENUS_CURSEFORGE_API_KEY
VENUS_YOUTUBE_CLIENT_ID: ${{ secrets.VENUS_YOUTUBE_CLIENT_ID }}
VENUS_TIKTOK_CLIENT_KEY: ${{ secrets.VENUS_TIKTOK_CLIENT_KEY }}
```

En desarrollo alcanza con las variables de entorno (solo sin empaquetar, como `core/app-config.js`). Sin identificadores, el camino directo no se muestra y el resto anda igual. La revisión automática rechazó incluir el secreto opcional de YouTube; aceptó la alternativa limitada a estos dos identificadores públicos. Ningún secreto OAuth se incorpora con el script de build de esta revisión. No se ejecutó el script contra el entorno real: sus pruebas usan una VM con variables y archivos ficticios.

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
node --test --test-concurrency=4 "src/main/modules/clipstudio/test/" "src/main/modules/obs/test/" "src/main/modules/clipupload/test/" "src/main/modules/capture/test/"
node --test --test-concurrency=4 "src/renderer/js/features/clipstudio/test/logic.test.js" "src/renderer/js/features/clipstudio/test/lifecycle.test.js" "src/renderer/js/pages/clips/test/gallery.test.js" "src/renderer/js/pages/clips/test/gallery-ui.test.js" "supabase/functions/tiktok-token/tests/handler.test.ts"
```

Sin Minecraft: un `VENUS_DATA_DIR` temporal con `instances/<id>/venus-instance.json`, clips generados en la ventana de desarrollo con `MediaRecorder` sobre un canvas (`capture:saveExport`) y el diálogo real; después cada resultado se carga en un `<video>` y se revisa duración, tamaño, adelantar, llegar al final y el color de cada tramo.

## Informe final de integración — 3 de noviembre de 2026

Alcance: montaje, timelapse, subida de clips, OBS, galería pública y su panel de administración, pruebas propias y carga de identificadores públicos al build. Se trabajó en `C:\Users\ringo\Downloads\Venus Launcher`, con `workdir` explícito y `login:false`. Los cambios anteriores y de otros frentes se conservaron.

### Implementación contrastada y correcciones

- **Montaje:** la placa de título se vacía al archivo antes de abrir el primer tramo recodificado; su inicio ya no depende de cuadros que todavía están en la cola del codificador. Cerrar el diálogo mientras llega un trabajo elimina también ese temporal tardío. Se conservan selección semanal, recorte desde cuadro clave y copia/recodificación según el plan existente.
- **Timelapse:** un inicio tardío no reactiva una partida detenida ni reemplaza a la última solicitada. Una consulta de disco de la sesión anterior no captura ni detiene la nueva. Si se sale del mundo durante la captura, se descarta la imagen. El límite comprueba también el tamaño real del JPEG, además de la estimación previa. Cancelar durante apertura/codificación o fallar al crear el codificador limpia el trabajo. La instancia de origen queda fija para mandar las imágenes a la papelera después de generar, aun si cambia la selección mientras se confirma.
- **Subidas:** cancelar durante la apertura del retorno, el intercambio OAuth o la consulta del archivo ya no deja que la operación continúe al terminar esa espera. Una conexión anterior no pierde el control de cancelación de la siguiente. Se impiden trabajos con el mismo ID simultáneamente. El formulario bloquea cambios y subidas repetidas mientras se conecta, confirma o sube; el pedido conserva el proveedor, la privacidad y el texto que se confirmaron. El cierre exitoso no emite una cancelación innecesaria. El cierre del diálogo sigue disponible.
- **OBS:** cerrar durante la identificación resuelve la promesa pendiente y descarta mensajes tardíos; un fallo al enviar Identify rechaza normalmente. Los reintentos que no consiguen consultar el estado de OBS ya no reinician la gracia de 30 segundos para restituir el modo streamer. Las reglas de escenas y propiedad del modo streamer siguen con sus pruebas existentes.
- **Galería:** la confirmación o el rechazo de un like actualizan la tarjeta visible; mientras espera, el botón queda deshabilitado. La paginación cuenta las filas del servidor aunque algunas se omitan por falta de enlace válido. Una página tardía no se mezcla con otra pestaña, y dos pedidos de “más” no se pisan. El panel de admin descarta respuestas de filtros anteriores.
- **Build:** incorporados `youtubeClientId` y `tiktokClientKey`, conservando CurseForge y la limpieza de configuración anterior. El secreto opcional de YouTube no se incorporó; ver §4. No se cambió el workflow.

### Evidencia obtenida en esta revisión

- Primera corrida bajo sandbox: `node:test` no pudo iniciar sus procesos (`spawn EPERM`). Se usó la escalación autorizada, sin rodear el sandbox.
- Primera corrida escalada antes de recuperar dependencias: **75 pruebas aprobadas y 1 archivo de pruebas fallido** por `Cannot find module 'adm-zip'` en captura. No se atribuyó a la aplicación ni se instaló nada desde este frente.
- Tras la recuperación de dependencias comunicada por la integración principal, corrida final con Node **v25.9.0**, `VENUS_DATA_DIR` bajo el directorio temporal y `--test-concurrency=4`: **182 pruebas, 182 aprobadas, 0 fallidas, 0 canceladas, 0 omitidas**. Se ejecutaron juntas las nueve rutas de prueba de “Cómo verificar”, con `--test-reporter=tap`. Incluye **28 regresiones nuevas** de esta revisión.
- Los módulos de interfaz se ejecutaron con un DOM mínimo, IPC y WebCodecs ficticios. Los módulos principales se probaron con dependencias inyectadas o simuladas; los WebM usan archivos temporales. Las pruebas de OAuth incluyen un servidor local de retorno; YouTube/TikTok usan respuestas ficticias y el caso de 308 existente usa un servidor local.
- El script de build se ejecutó solo dentro de una VM con entorno y sistema de archivos en memoria: se verificaron identificadores sin CurseForge, limpieza de valores antiguos, espacios/vacíos, conservación de CurseForge, omisión de secretos OAuth y ausencia de valores en los mensajes.
- `node --check` y verificación de CRLF: **20 archivos JavaScript correctos**. `git diff --check` del alcance: sin errores. La salida completa de pruebas conserva avisos de Node sobre módulos ES sin `type` y el aviso esperado de la prueba de un JAR temporal inexistente; no se afirma que la consola estuviera vacía.

### Límites y coordinación

- En la revisión focalizada de 182 pruebas no se ejecutó Electron ni WebCodecs real; la integración principal los probó después con imágenes y vídeos propios, como detalla la actualización final. Minecraft, OBS real, OAuth de una cuenta real y subidas reales a YouTube/TikTok siguen sin validar. Los tiempos históricos de codificación citados más arriba no se volvieron a medir en esa revisión focalizada.
- Se leyó la migración 0032 para contrastar los contratos de galería; no se ejecutó SQL ni se certificaron RLS, cuotas o concurrencia en una base. Según el estado comunicado por la integración principal, producción sigue hasta 0027. La disponibilidad real de galería sigue pendiente de su migración y la de TikTok del broker/configuración correspondientes.
- La incorporación del secreto opcional de YouTube fue rechazada por la revisión automática por tratarse de persistencia de credenciales. Se completó la alternativa de identificadores públicos autorizada por esa revisión; si un cliente real requiere aquel secreto, la subida directa no está lista hasta contar con un flujo aprobado que no distribuya secretos, y su prueba. Una variable de workflow para ese secreto, por sí sola, no es consumida por el script de esta revisión.
- Sin cambios de contratos IPC/RPC, captcha, idiomas, dependencias, workflows ni documentación general. Sin commit, push, release, cambios de producción ni lectura/escritura de credenciales reales. No se cerró ninguna aplicación. La suite global queda a cargo de la integración principal.

### Rutas cambiadas en este frente

```text
scripts/write-build-config.js
src/main/modules/clipstudio/timelapse.js
src/main/modules/clipstudio/test/timelapse.test.js
src/main/modules/clipupload.js
src/main/modules/clipupload/test/index.js
src/main/modules/clipupload/test/lifecycle.test.js
src/main/modules/clipupload/test/build-config.test.js
src/renderer/js/features/clipstudio/montage.js
src/renderer/js/features/clipstudio/timelapse.js
src/renderer/js/features/clipstudio/upload.js
src/renderer/js/features/clipstudio/test/lifecycle.test.js
src/renderer/js/features/clipstudio/test/ui-harness.js
src/renderer/js/pages/clips/gallery.js
src/renderer/js/pages/clips/test/gallery-ui.test.js
src/renderer/js/pages/admin/gallery.js
docs/implementacion/clips.md
```

## Actualización posterior de integración · 3 de noviembre de 2026

La integración principal probó el codificador y el reproductor reales de Electron con **60 PNG propios de 320×180**: generó un **WebM de 2 s** y comprobó el salto a **1 s**. También unió por copia **dos segmentos** en un **WebM de 4 s**, con salto real a **3 s**. Ambas corridas terminaron con consola vacía. Evidencia: `%TEMP%/venus-codex-review-20261103/shots-encoder-valid/` y `shots-montage/`.

Esto reemplaza el pendiente de WebCodecs/reproducción local de aquella revisión, no la captura de Minecraft ni las integraciones con OBS/OAuth reales. Las pantallas ES/EN están cubiertas por las rondas corregidas de páginas y rutas extra, descritas en [estado de integración](../estado-4.5.0.md). La galería y el broker de TikTok continúan sin despliegue de producción.
