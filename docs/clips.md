# Clips y capturas

> La captura existente se amplía con el estudio de clips de la 4.5.0 (publicado con la 4.6.0; la integración con OBS se retiró en la 4.6). Contratos detallados: [montaje, timelapse, subida y galería](implementacion/clips.md). [Estado y validaciones pendientes](estado-4.5.0.md).

Grabación del juego, repetición instantánea, capturas de pantalla, galería con editor rápido y compartir. Sin dependencias nuevas: todo con `desktopCapturer` + `MediaRecorder` de Electron y un lector/escritor de WebM propio.

## Para el usuario

- **Repetición instantánea** (apagada por defecto): mientras jugás guarda en disco los últimos **60 s** (o **5 minutos** con Venus Premium), en archivos temporales que se borran al cerrar el juego. Al apretar el atajo, esos segundos quedan como clip. Usa CPU y disco (unos 60 MB, o 260 MB con Premium, a 1080p 30 fps), por eso solo corre con un juego abierto y solo si la prendiste en **Ajustes → En el juego → Clips y capturas** (`#/settings/ingame/capture`).
- **Clips automáticos** (apagados por defecto, necesitan la repetición prendida): el clip se guarda solo al **morir**, al **conseguir un logro** o al **matar un jefe**, unos segundos después del evento para que incluya lo que siguió. Solo lo que le pasa a tu cuenta, no a otros jugadores. Se elige qué eventos cuentan, cuánto dura cada clip (60 s por defecto, para no gastar 250 MB por muerte con Premium), la espera entre clips (30 s) y el máximo por partida (20). Ver [qué se detecta](#clips-automáticos).
- **Grabación**: el atajo empieza a grabar y el mismo atajo termina. Sin límite de tiempo (va directo al disco).
- **Captura de pantalla**: solo la ventana del juego, al tamaño real de la ventana (PNG).
- **Atajos por defecto**: guardar repetición `Alt+Shift+F8`, grabar `Alt+Shift+F9`, captura `Alt+Shift+F12` (Alt+F9/Alt+F10 los usa NVIDIA). Se cambian en Ajustes; funcionan **solo mientras hay un juego abierto** (así no le sacan esas teclas a otras aplicaciones). Si otra aplicación ya usa la combinación, el panel lo avisa.
- **Calidad**: 720p, 1080p o nativa (tope 4K) y 30 o 60 fps. **Audio**: el sonido del equipo (en Windows es todo el audio de la PC, no solo el del juego).
- **Página Clips y capturas** (`#/clips`): pestañas Capturas, Clips y Grabaciones de todas las instancias; filtros por instancia y fecha y, en Clips, por motivo (Muerte, Logro, Jefe: la misma etiqueta se ve en la miniatura y en el visor); búsqueda por nombre, mundo o instancia; visor grande con teclado (flechas, Inicio/Fin, Supr manda a la papelera, E abre el editor, Escape cierra).
- **Editor**: recortar inicio y fin y exportar en **horizontal** o **vertical 9:16** (TikTok, Shorts, Reels) con el recuadro centrado o arrastrado. La exportación vuelve a grabar el tramo en tiempo real (tarda lo mismo que dura) y queda en la carpeta `clips` de la instancia.
- **Compartir**: link privado (el mismo de Mundos), **mandar a un amigo** (le llega un aviso con **Ver**) y **destacar en mi perfil** (capturas; hasta 3, públicas). El tope de un clip compartido es de **50 MB** (lo fija el Storage, ver [Límites conocidos](#límites-conocidos)): un clip más largo hay que recortarlo antes en el editor (el visor lo avisa).
- **Buscar con IA** (opcional): el botón **Describir con IA** de la pestaña Capturas manda hasta 20 capturas achicadas a la IA de Venus (con confirmación, usa el plan) y guarda una descripción corta de cada una; después la búsqueda encuentra capturas por lo que muestran ("atardecer", "casa de madera") sin volver a usar IA.

## Dónde se guarda (y por qué)

Dentro de la carpeta de cada instancia:

| Carpeta | Qué | Nombre |
|---|---|---|
| `screenshots/` | Capturas (junto a las del F2 de Minecraft) | `2026-11-01_18.03.09_venus.png` |
| `clips/` | Repeticiones, clips automáticos y lo que exporta el editor | `…_replay.webm`, `…_auto-death.webm`, `…_auto-advancement.webm`, `…_auto-boss.webm`, `…_vertical.webm`, `…_edit.webm` |
| `recordings/` | Grabaciones | `…_rec.webm` |

El **buffer de la repetición** no se guarda ahí: va a `cache/capture-replay/<id>/` dentro de los datos del launcher (segmentos `seg-000001.bin`). Se borra al cerrar el juego o al apagar la repetición y, por si el launcher se cerró de golpe, también al arrancar. Limpiar la caché del launcher mientras se juega no rompe nada: se pierde lo que había y sigue.

Así no hace falta otra lista ni otro registro: `worlds/media.js` ya lista `screenshots/`, `clips/` y `recordings/` (canales `worlds:media`, `worlds:thumbs`, `worlds:readMedia`, `worlds:deleteMedia`…), la línea de tiempo de cada mundo los atribuye al mundo que se estaba jugando, la pestaña Capturas de la instancia los muestra y exportar o compartir la instancia sigue sus reglas de siempre. La fecha del nombre es la de Minecraft (`AAAA-MM-DD_HH.MM.SS`), que `worlds/media.js` ya entiende. El **motivo** de un clip automático también va en el nombre (`_auto-death`): sigue al archivo, lo lee `pages/clips/model.js` y lo conserva lo que se exporta en el editor (`…_auto-boss_vertical.webm`). Opcional: **Copia extra** (`settings.capture.copyTo`) deja además una copia de cada archivo en otra carpeta (por ejemplo Videos).

## Arquitectura

```
src/main/modules/capture.js            Orquestador: juego y ventana, sesión de captura, atajos, guardar, canales
src/main/modules/capture/
  logic.js                             Ajustes, atajos, calidad/bitrate, nombres y carpetas, juego a capturar (sin Electron)
  webm.js                              Lector incremental y escritor de WebM (sin Electron)
  ring.js                              Buffer circular de la repetición, en disco (sin Electron)
  recording.js                         Grabación larga directo al archivo final (sin Electron)
  gamelog.js                           Reconoce muerte, logro y jefe del jugador local en la salida del juego (sin Electron)
  gamelang.js                          Plantillas de esos mensajes: del .jar del cliente y de los assets del juego (sin Electron)
  autoclip.js                          Reglas de los clips automáticos: tipos, enfriamiento, límite, espera (sin Electron)
  window-find.js                       Ventana del juego por pid (PowerShell oculto, como ingame/window.js) + respaldo por título
  host.js                              Ventana oculta de la grabadora (Electron)
  recorder-preload.js                  Preload mínimo de la grabadora (un canal de ida y uno de vuelta)
  describe.js                          Descripciones con IA a pedido (data/capture-ai.json)
  test/                                Pruebas node:test (node --test "src/main/modules/capture/test/")
src/renderer/recorder.html + js/recorder/main.js   Grabadora oculta (getDisplayMedia + MediaRecorder)
src/renderer/js/pages/clips.js (+ pages/clips/)    Página, visor, editor, compartir; crop.js y model.js sin DOM
src/renderer/js/features/capture.js                startup() y capturePanel()
```

### Cómo graba

1. Cuando arranca un juego (`game.events` `'state'` = `running`, sin partidas silenciosas), `capture.js` elige el juego abierto más reciente (`logic.pickGame`) y busca su ventana: un PowerShell oculto devuelve el handle de la ventana GLFW/LWJGL de ese pid (id de `desktopCapturer` = `window:<handle>:0`) y, en paralelo, cada 3 s se prueba por título ("Minecraft 1.21.1…", nunca "Minecraft Launcher"). Recién ahí registra los atajos.
2. La grabadora es una ventana **oculta** con su propia sesión en memoria (`partition: 'venus-capture'`): sus permisos y su `setDisplayMediaRequestHandler` no tocan los de la ventana principal (compartir pantalla del Voice Chat). El manejador entrega siempre la fuente que eligió el proceso principal (la página no elige nada) y, en Windows, el audio `loopback` si se pidió. Si `getDisplayMedia` falla, se usa la forma vieja (`getUserMedia` con `chromeMediaSourceId`).
3. `MediaRecorder` graba WebM (VP9 o VP8 + Opus) con un cuadro clave cada 2 s (`videoKeyFrameIntervalDuration`) y entrega pedazos de 1 s, que la grabadora manda por IPC al proceso principal.
4. Repetición y grabación comparten **una sola** captura (un solo codificador): los cuadros van al buffer circular en disco y, si se está grabando, también al archivo.

### El WebM (por qué hay un lector propio)

`MediaRecorder` escribe un WebM "en vivo": Segment y Clusters de tamaño desconocido, sin duración ni índice. Además Chrome abre un Cluster nuevo cada ~1 s **sin alinearlo con los cuadros clave** (verificado en Electron 44). Por eso:

- No se puede cortar un pedazo cualquiera del flujo: sin el encabezado no se reproduce y un Cluster puede empezar en un cuadro que depende de otro.
- `webm.js` lee el flujo cuadro por cuadro (SimpleBlock/BlockGroup, pista, tiempo absoluto y si es clave), guarda el encabezado (EBML + Info + Tracks) y arma Clusters nuevos, uno por cuadro clave de video, con los tiempos corridos para empezar en cero.
- El archivo final lleva Segment con tamaño, SeekHead, Info con **Duration**, Tracks y **Cues** (un punto por cuadro clave): el video dice su duración y se puede adelantar (sin eso, Chrome muestra duración "Infinity" y no deja buscar).
- **Repetición**: `ring.js` escribe los cuadros en segmentos de ~10 s, cada uno desde un cuadro clave, y borra los viejos enteros (se queda desde el último cuadro clave antes del corte, así que guarda hasta un segmento de más; con video quieto, tope duro de 4×N, y nunca más de 2 GB). En memoria solo queda un índice por segmento y lo que falta escribir: si el disco no da abasto, saltea cuadros hasta el próximo cuadro clave en vez de juntarlos en RAM. Si la escritura falla o, al arrancar, quedarían menos de 1 GB libres además del buffer, la repetición se pausa con un aviso (el juego y la grabación siguen). Al guardar se pide a `MediaRecorder` lo que tenía pendiente (`requestData`), se retienen los segmentos (la rotación no los borra mientras tanto) y se pasan al archivo final de a uno con `RecordingFile`: un clip de 5 minutos nunca está entero en memoria.
- **Grabación**: `recording.js` escribe un encabezado provisorio que ocupa un lugar fijo (512 KB, con relleno Void; si el launcher se cierra de golpe el archivo igual se reproduce), después los Clusters a medida que llegan, y al terminar reescribe solo el principio con la duración y el índice (si el índice no entra, se reparte). Terminar es instantáneo aunque pese GB.
- **Editor**: lo que exporta la interfaz (otro `MediaRecorder`, sobre un canvas) se rearma igual en `capture:saveExport`.

## Clips automáticos

`game.events 'log'` trae las líneas que el launcher ya lee del juego. `gamelog.js` se queda con los mensajes de sistema: `[System] [CHAT] …` (desde 1.19), `[CHAT] …` (hasta 1.18; también con el formato de Forge, que agrega la clase) y `[Server thread/INFO]: …` (el servidor integrado de un mundo propio). El chat de jugadores (`<nombre> …`, `[Not Secure]`, `[Modified]`) nunca cuenta.

**Idioma.** Minecraft no escribe ningún código en el log, solo el mensaje ya traducido al idioma del juego, y no hay una señal independiente del idioma para morir o conseguir un logro. Por eso no hay frases escritas en el launcher: `gamelang.js` lee las **plantillas del propio juego** (`death.attack.*`, `death.fell.*`, `chat.type.advancement.*`, `chat.type.achievement`, los nombres de los jefes): el inglés del `.jar` del cliente de esa versión (guardado en `cache/capture-lang/<versión>.json`) y el idioma elegido en `options.txt` de los assets. Vale para los 142 idiomas de 26.2 (se probó con sus archivos reales: 14.699 de 14.704 plantillas; las otras 5 están mal escritas en la traducción del juego) y se vuelve a mirar si el juego recarga sus recursos, porque pudo cambiar de idioma.

**Jugador local.** El nombre sale de la cuenta con la que se lanzó el juego (`game.addBeforeLaunch`) y, si el log dice otro (`Setting user: X`, la primera vez), manda el del log. La plantilla se arma con ese nombre en el lugar del muerto (`^Steve was slain by .+$`): la muerte de otro, un nombre parecido o el chat que copia el texto no coinciden. Se tolera un rango o equipo delante del nombre (`[VIP] Steve`). Las partidas de prueba (`quiet`) y las otras instancias abiertas no cuentan.

| Evento | Se detecta | No se detecta |
|---|---|---|
| **Muerte** | El mensaje de muerte del juego en cualquier idioma, propio o de un servidor; también los de minijuegos que usan una plantilla del juego o `fell into the void` | `showDeathMessages` apagado; mensajes cambiados por un plugin o un mod (por ejemplo, las muertes propias de un mod); un servidor que no los manda |
| **Logro** | `chat.type.advancement.*` (1.12 en adelante) y `chat.type.achievement` (hasta 1.11) | `announceAdvancements` apagado; logros ocultos o recetas (el juego no los anuncia); las pantallitas de progreso que no pasan por el chat |
| **Ender Dragon** | El logro que solo se consigue matándolo (`end/kill_dragon`; hasta 1.11, `achievement.theEnd2`) | Volver a matarlo: el logro sale **una vez por jugador en cada mundo** |
| **Wither** | Hasta 1.11, por `achievement.killWither` | **Desde 1.12 no hay ninguna señal**: el logro `nether/summon_wither` es por invocarlo, no por matarlo |
| **Warden, Elder Guardian** | — | **No hay ninguna señal** |
| **Cualquier jefe** | Si un servidor o un mod anuncia su muerte con el formato del juego (`Wither was slain by Steve`, en el idioma que sea) | Frases propias de cada plugin |

El Wither, el Warden y el Elder Guardian no se pueden distinguir leyendo la salida de un juego sin mods: su muerte no escribe nada. Las estadísticas (`stats/<uuid>.json`) sí la cuentan, pero el juego las guarda cada 5 minutos o al pausar, y para entonces el momento ya salió del buffer. La alternativa real es que un mod del launcher escriba una línea propia en el log. El interruptor **Al matar un jefe** de Ajustes lo aclara.

**Reglas** (`autoclip.js`): el interruptor general y el del tipo tienen que estar prendidos, y la repetición andando. El clip se corta unos segundos después (5 s; 12 s si es un jefe, el dragón tarda en morir). Si mientras tanto llega otro evento no se abre otro clip: queda uno solo, con el motivo más importante (jefe > muerte > logro). Después del evento hay un enfriamiento (30 s por defecto, de 5 s a 10 minutos) para todos los motivos y un máximo por partida (20 por defecto); al llegar se avisa una vez y el atajo sigue andando. Si el juego se cierra durante la espera, el clip se guarda igual. El clip dura lo que diga **Largo de cada clip** (60 s por defecto), sin pasarse de lo que guarda la repetición en el plan.

## Canales y eventos

| Canal | Qué hace |
|---|---|
| `capture:status()` | `{ settings, premium, replaySeconds, diskEstimate, game: { instanceId, window, searching } \| null, replay: { enabled, active, buffered, disk, error: null \| 'noRoom' \| 'disk' }, auto: { saved, limit }, recording: { active, instanceId?, startedAt?, duration? }, shortcuts: { replay\|record\|screenshot: { accel, registered, active } }, folders }` |
| `capture:saveReplay()` | Guarda la repetición → `{ path, instanceId, duration }` |
| `capture:screenshot()` | Captura de la ventana del juego → `{ path, instanceId, width, height }` |
| `capture:startRecording()` · `capture:stopRecording()` · `capture:toggleRecording()` | Grabación |
| `capture:setPremium(bool)` | La interfaz avisa el plan (5 minutos con Premium) |
| `capture:testShortcut(acelerador, acción)` | `{ ok, accel, reason?: 'invalid' \| 'duplicate' \| 'inUse', other? }` |
| `capture:openFolder({ instanceId?, kind })` | Abre `screenshots/`, `clips/` o `recordings/` (sin instancia: la del juego abierto o la elegida) |
| `capture:saveExport({ instanceId, sourceName, mode }, bytes)` | Guarda lo que exporta el editor → `{ path, name, duration }` |
| `capture:aiStatus()` · `capture:aiIndex()` · `capture:aiDescribe([{ key, path }])` | Búsqueda con IA (a pedido) |

Errores con `err.code`: `noGame`, `noWindow`, `notReady`, `replayOff`, `empty`, `instance`, `write`, `capture`, `tooBig`, `badWebm`, `unavailable` (y los de `modules/ai.js` en `aiDescribe`).

Eventos: `capture:saved` `{ type: 'screenshot' | 'clip' | 'recording', path, instanceId, duration? (segundos), reason? ('death' | 'advancement' | 'boss', clip automático) }` (contrato 4), `capture:state` (lo mismo que `capture:status`, cuando cambia y cada 1 s mientras hay repetición o grabación), `capture:notice` `{ level, message }` (errores de los atajos, falta de disco, máximo de clips automáticos) y `worlds:updated` `{ kind: 'media', instanceId }` para que Mundos refresque.

**Overlay** (contrato 1): `overlay.push({ kind: 'capture', type: 'screenshot' | 'replay-saved' | 'recording-start' | 'recording-stop', path?, thumb? (data: JPEG de 320 px), duration? })` y `{ kind: 'alert', icon: 'capture', … }` cuando falla un atajo. Se omite con `notify: false`. Un clip automático avisa igual que uno guardado con el atajo (`replay-saved`): el contrato del overlay no lleva el motivo.

**Logros** (contrato 3): `features/capture.js` despacha `venus:achievement` con `first_screenshot` (captura) o `first_clip` (clip o grabación), una vez por sesión.

**Señal nueva** `media-share` `{ url, kind: 'screenshot' | 'clip', name }`: la manda **A un amigo** del visor; `features/capture.js` la escucha con `social.onSignal('media-share')` y muestra un aviso con **Ver** (como mucho uno cada 8 s por amigo). Solo se aceptan links `https` firmados del Storage del proyecto del launcher (`/storage/v1/object/sign/screenshots|clips/…`).

**Destacar en el perfil**: lo hace el editor de perfiles (agente D): `import('../../features/profile-editor.js')` → `featureCapture({ src: Blob, title })` (sube a `profile-media`, agrega a `featured` con hasta 3 y, si ya hay 3, pregunta si reemplazar la primera; muestra sus propios avisos). Clips le pasa la captura como `Blob` leída con `worlds:readMedia` y el mundo (o la instancia) como título. Si ese módulo no está, el botón avisa que no está disponible.

## Ajustes (`settings.capture`)

`{ replay (false), quality ('720p' | '1080p' | 'native'; '1080p'), fps (30 | 60; 30), audio (true), notify (true), copyTo (''), shortcuts: { replay, record, screenshot }, auto: { enabled (false), death (true), advancement (true), boss (true), cooldown (segundos, 5 a 600; 30), maxPerSession (1 a 200; 20), seconds (30 | 60 | 120 | 300; 60) } }`. Un atajo vacío (`''`) es "sin atajo"; los inválidos o repetidos se ignoran.

## Archivos de datos

- `data/capture-ai.json`: `{ version: 1, items: { <instancia>|<ruta>|<tamaño>: { text, at } } }` (descripciones hechas con IA; hasta 5000).
- `cache/capture-replay/`: buffers de la repetición (temporales, ver arriba). `cache/capture-lang/<versión>.json`: plantillas en inglés de esa versión (se regeneran solas).

## Límites conocidos

- Un juego en pantalla completa **exclusiva** puede verse negro (Windows Graphics Capture captura lo que compone el escritorio). Minecraft en ventana o "pantalla completa sin bordes" anda bien.
- El audio es el de todo el equipo (loopback de Windows), no solo el del juego.
- Si la ventana del juego cambia de tamaño durante una grabación, el video cambia de resolución en ese punto (los reproductores lo soportan; el encabezado dice el tamaño inicial).
- Con dos juegos abiertos se captura el que se abrió último.
- La exportación del editor es en tiempo real (un clip de 5 minutos tarda 5 minutos).
- **Compartir tiene un tope de 50 MB por clip** y depende del Storage (`file_size_limit` del bucket `clips`, migración `0005_media.sql`; `LIMITS` de `pages/worlds/media.js` es la misma cifra): con la repetición nueva, un clip de 60 s a 1080p 30 fps ya anda justo en ese tope (~50 MB) y uno de 5 minutos no entra. Hay que recortarlo en el editor o subir el tope en Supabase.
- Los clips automáticos solo ven lo que el juego escribe en su salida: ver la tabla de [qué se detecta](#clips-automáticos).

## Cómo verificar

```bash
node --test "src/main/modules/capture/test/"     # WebM, buffer en disco, grabación, lógica, parseo del log, idiomas, reglas de los clips automáticos, ventana, recorte, filtros, IA
```

Las líneas de `gamelog.test.js` de 1.19 en adelante son reales (de los logs de un jugador, con el nombre cambiado); las de versiones anteriores siguen el formato conocido porque no había logs de esas versiones a mano.

Prueba de punta a punta (sin Minecraft): un script de Electron que abre una ventana propia animada titulada "Minecraft 1.21.1 · Venus Launcher", registra `capture.js`, simula `game.status()`/`'state'`, manda líneas de log falsas por `game.events 'log'` y llama a `capture:saveReplay`, `capture:screenshot`, `capture:startRecording`/`stopRecording` y `capture:saveExport`; después carga cada WebM en un `<video>` y revisa duración, tamaño y que se pueda adelantar.

## Estudio de clips de 4.5.0

| Función | Datos, canales y límites |
|---|---|
| Montaje de la semana | `clipstudio:probe` y trabajos `montage*`: clips WebM de Venus; copia de cuadros si son compatibles o recodificación con WebCodecs. Duraciones de 30 s, 1/2/5 min o sin tope. No es un editor general de formatos arbitrarios. |
| Timelapse | `clipstudio:timelapse*`; apagado por defecto. Intervalo de 5 s a 2 min y espacio de 256 MB a 5 GB; configuración en `.venus/timelapse.json`, cuadros en `<instancia>/timelapse/`. Se detiene al alcanzar el límite o faltar espacio. |
| Subida | `clipupload:status/connect/cancelConnect/revoke/upload/cancel`. OAuth en navegador; tokens cifrados en main. YouTube parte de privado, TikTok envía al borrador. El camino de navegador permite continuar sin subida directa configurada. |
| Galería | RPC de 0032 sobre clips compartidos: cinco publicaciones por día, 200 me gusta y diez denuncias por día. Usa el bucket privado `clips` y sus links firmados; siguen los 50 MB por archivo. |

Los vídeos se escriben primero como `.part` y se terminan antes de mostrarlos. La galería exige sesión; despublicar u ocultar no revoca una URL firmada ya emitida. Moderar/borrar una publicación no garantiza borrar el objeto de Storage: SQL no elimina el archivo físico. El panel informa ese límite.

### Configuración de subida

El build agrega únicamente estos identificadores públicos, además de la configuración previa de CurseForge:

| Variable del build | Campo de configuración |
|---|---|
| `VENUS_YOUTUBE_CLIENT_ID` | `youtubeClientId` |
| `VENUS_TIKTOK_CLIENT_KEY` | `tiktokClientKey` |

No distribuir `client_secret` en el launcher ni agregarlo al workflow. Si el proveedor lo exige y el flujo actual no puede completarse con los identificadores públicos, **la subida directa no está lista hasta contar con un flujo aprobado y probado**. TikTok mantiene sus credenciales confidenciales exclusivamente del lado de `tiktok-token` en Supabase; requiere sesión Venus y aprobación de la app por el proveedor. La configuración y las condiciones históricamente revisadas están en el [documento técnico](implementacion/clips.md); deben revalidarse antes de publicar.

Los permisos de captura se instalan desde `capture/host.js` usando `core/permissions.js`: página exacta del recorder, sin subframes; display media valida el marco solicitante.

### Evidencia y pendientes

El informe final del frente registra **182/182 pruebas locales** con DOM/WebCodecs/proveedores simulados o retorno OAuth local. Esa corrida focalizada no prueba Electron/WebCodecs real; la integración principal los comprobó después como se detalla abajo. Minecraft, OBS y OAuth/subidas reales siguen pendientes. La galería requiere 0032, todavía pendiente en producción; tampoco se publicaron los cambios por consolidar esta documentación.

### Actualización de la integración principal

Con imágenes propias se ejecutó WebCodecs real: 60 PNG de 320×180 generaron un WebM de 2 s, reproducido con salto a 1 s. El montaje por copia de dos segmentos produjo 4 s y salto a 3 s. Ambas pruebas de Electron dejaron consola vacía; los artefactos están en `shots-encoder-valid/` y `shots-montage/`, bajo `%TEMP%/venus-codex-review-20261103/`. No son pruebas con Minecraft, OBS ni proveedores OAuth reales. [Evidencia consolidada](estado-4.5.0.md).
