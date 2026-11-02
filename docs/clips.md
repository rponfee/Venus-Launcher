# Clips y capturas (Venus 2.0)

Grabación del juego, repetición instantánea, capturas de pantalla, galería con editor rápido y compartir. Sin dependencias nuevas: todo con `desktopCapturer` + `MediaRecorder` de Electron y un lector/escritor de WebM propio.

## Para el usuario

- **Repetición instantánea** (apagada por defecto): mientras jugás guarda en memoria los últimos **30 s** (o **120 s** con Venus Premium). Al apretar el atajo, esos segundos quedan como clip. Usa CPU y memoria, por eso solo corre con un juego abierto y solo si la prendiste en **Ajustes → En el juego → Clips y capturas** (`#/settings/ingame/capture`).
- **Grabación**: el atajo empieza a grabar y el mismo atajo termina. Sin límite de tiempo (va directo al disco).
- **Captura de pantalla**: solo la ventana del juego, al tamaño real de la ventana (PNG).
- **Atajos por defecto**: guardar repetición `Alt+Shift+F8`, grabar `Alt+Shift+F9`, captura `Alt+Shift+F12` (Alt+F9/Alt+F10 los usa NVIDIA). Se cambian en Ajustes; funcionan **solo mientras hay un juego abierto** (así no le sacan esas teclas a otras aplicaciones). Si otra aplicación ya usa la combinación, el panel lo avisa.
- **Calidad**: 720p, 1080p o nativa (tope 4K) y 30 o 60 fps. **Audio**: el sonido del equipo (en Windows es todo el audio de la PC, no solo el del juego).
- **Página Clips y capturas** (`#/clips`): pestañas Capturas, Clips y Grabaciones de todas las instancias; filtros por instancia y fecha; búsqueda por nombre, mundo o instancia; visor grande con teclado (flechas, Inicio/Fin, Supr manda a la papelera, E abre el editor, Escape cierra).
- **Editor**: recortar inicio y fin y exportar en **horizontal** o **vertical 9:16** (TikTok, Shorts, Reels) con el recuadro centrado o arrastrado. La exportación vuelve a grabar el tramo en tiempo real (tarda lo mismo que dura) y queda en la carpeta `clips` de la instancia.
- **Compartir**: link privado (el mismo de Mundos), **mandar a un amigo** (le llega un aviso con **Ver**) y **destacar en mi perfil** (capturas; hasta 3, públicas).
- **Buscar con IA** (opcional): el botón **Describir con IA** de la pestaña Capturas manda hasta 20 capturas achicadas a la IA de Venus (con confirmación, usa el plan) y guarda una descripción corta de cada una; después la búsqueda encuentra capturas por lo que muestran ("atardecer", "casa de madera") sin volver a usar IA.

## Dónde se guarda (y por qué)

Dentro de la carpeta de cada instancia:

| Carpeta | Qué | Nombre |
|---|---|---|
| `screenshots/` | Capturas (junto a las del F2 de Minecraft) | `2026-11-01_18.03.09_venus.png` |
| `clips/` | Repeticiones y lo que exporta el editor | `…_replay.webm`, `…_vertical.webm`, `…_edit.webm` |
| `recordings/` | Grabaciones | `…_rec.webm` |

Así no hace falta otra lista ni otro registro: `worlds/media.js` ya lista `screenshots/`, `clips/` y `recordings/` (canales `worlds:media`, `worlds:thumbs`, `worlds:readMedia`, `worlds:deleteMedia`…), la línea de tiempo de cada mundo los atribuye al mundo que se estaba jugando, la pestaña Capturas de la instancia los muestra y exportar o compartir la instancia sigue sus reglas de siempre. La fecha del nombre es la de Minecraft (`AAAA-MM-DD_HH.MM.SS`), que `worlds/media.js` ya entiende. Opcional: **Copia extra** (`settings.capture.copyTo`) deja además una copia de cada archivo en otra carpeta (por ejemplo Videos).

## Arquitectura

```
src/main/modules/capture.js            Orquestador: juego y ventana, sesión de captura, atajos, guardar, canales
src/main/modules/capture/
  logic.js                             Ajustes, atajos, calidad/bitrate, nombres y carpetas, juego a capturar (sin Electron)
  webm.js                              Lector incremental y escritor de WebM (sin Electron)
  ring.js                              Buffer circular de la repetición (sin Electron)
  recording.js                         Grabación larga directo al archivo final (sin Electron)
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
4. Repetición y grabación comparten **una sola** captura (un solo codificador): los cuadros van al buffer circular y, si se está grabando, también al archivo.

### El WebM (por qué hay un lector propio)

`MediaRecorder` escribe un WebM "en vivo": Segment y Clusters de tamaño desconocido, sin duración ni índice. Además Chrome abre un Cluster nuevo cada ~1 s **sin alinearlo con los cuadros clave** (verificado en Electron 44). Por eso:

- No se puede cortar un pedazo cualquiera del flujo: sin el encabezado no se reproduce y un Cluster puede empezar en un cuadro que depende de otro.
- `webm.js` lee el flujo cuadro por cuadro (SimpleBlock/BlockGroup, pista, tiempo absoluto y si es clave), guarda el encabezado (EBML + Info + Tracks) y arma Clusters nuevos, uno por cuadro clave de video, con los tiempos corridos para empezar en cero.
- El archivo final lleva Segment con tamaño, SeekHead, Info con **Duration**, Tracks y **Cues** (un punto por cuadro clave): el video dice su duración y se puede adelantar (sin eso, Chrome muestra duración "Infinity" y no deja buscar).
- **Repetición**: `ring.js` guarda solo los últimos N segundos, siempre desde un cuadro clave (descarta lo anterior al último cuadro clave antes del corte; con video quieto, tope duro de 4×N). Al guardar se pide a `MediaRecorder` lo que tenía pendiente (`requestData`) y se arma el archivo en memoria.
- **Grabación**: `recording.js` escribe un encabezado provisorio que ocupa un lugar fijo (512 KB, con relleno Void; si el launcher se cierra de golpe el archivo igual se reproduce), después los Clusters a medida que llegan, y al terminar reescribe solo el principio con la duración y el índice (si el índice no entra, se reparte). Terminar es instantáneo aunque pese GB.
- **Editor**: lo que exporta la interfaz (otro `MediaRecorder`, sobre un canvas) se rearma igual en `capture:saveExport`.

## Canales y eventos

| Canal | Qué hace |
|---|---|
| `capture:status()` | `{ settings, premium, replaySeconds, memoryEstimate, game: { instanceId, window, searching } \| null, replay: { enabled, active, buffered, memory }, recording: { active, instanceId?, startedAt?, duration? }, shortcuts: { replay\|record\|screenshot: { accel, registered, active } }, folders }` |
| `capture:saveReplay()` | Guarda la repetición → `{ path, instanceId, duration }` |
| `capture:screenshot()` | Captura de la ventana del juego → `{ path, instanceId, width, height }` |
| `capture:startRecording()` · `capture:stopRecording()` · `capture:toggleRecording()` | Grabación |
| `capture:setPremium(bool)` | La interfaz avisa el plan (120 s con Premium) |
| `capture:testShortcut(acelerador, acción)` | `{ ok, accel, reason?: 'invalid' \| 'duplicate' \| 'inUse', other? }` |
| `capture:openFolder({ instanceId?, kind })` | Abre `screenshots/`, `clips/` o `recordings/` (sin instancia: la del juego abierto o la elegida) |
| `capture:saveExport({ instanceId, sourceName, mode }, bytes)` | Guarda lo que exporta el editor → `{ path, name, duration }` |
| `capture:aiStatus()` · `capture:aiIndex()` · `capture:aiDescribe([{ key, path }])` | Búsqueda con IA (a pedido) |

Errores con `err.code`: `noGame`, `noWindow`, `notReady`, `replayOff`, `empty`, `instance`, `write`, `capture`, `tooBig`, `badWebm`, `unavailable` (y los de `modules/ai.js` en `aiDescribe`).

Eventos: `capture:saved` `{ type: 'screenshot' | 'clip' | 'recording', path, instanceId, duration? (segundos) }` (contrato 4), `capture:state` (lo mismo que `capture:status`, cuando cambia y cada 1 s mientras hay repetición o grabación), `capture:notice` `{ level, message }` (errores de los atajos) y `worlds:updated` `{ kind: 'media', instanceId }` para que Mundos refresque.

**Overlay** (contrato 1): `overlay.push({ kind: 'capture', type: 'screenshot' | 'replay-saved' | 'recording-start' | 'recording-stop', path?, thumb? (data: JPEG de 320 px), duration? })` y `{ kind: 'alert', icon: 'capture', … }` cuando falla un atajo. Se omite con `notify: false`.

**Logros** (contrato 3): `features/capture.js` despacha `venus:achievement` con `first_screenshot` (captura) o `first_clip` (clip o grabación), una vez por sesión.

**Señal nueva** `media-share` `{ url, kind: 'screenshot' | 'clip', name }`: la manda **A un amigo** del visor; `features/capture.js` la escucha con `social.onSignal('media-share')` y muestra un aviso con **Ver** (como mucho uno cada 8 s por amigo). Solo se aceptan links `https` firmados del Storage del proyecto del launcher (`/storage/v1/object/sign/screenshots|clips/…`).

**Destacar en el perfil**: lo hace el editor de perfiles (agente D): `import('../../features/profile-editor.js')` → `featureCapture({ src: Blob, title })` (sube a `profile-media`, agrega a `featured` con hasta 3 y, si ya hay 3, pregunta si reemplazar la primera; muestra sus propios avisos). Clips le pasa la captura como `Blob` leída con `worlds:readMedia` y el mundo (o la instancia) como título. Si ese módulo no está, el botón avisa que no está disponible.

## Ajustes (`settings.capture`)

`{ replay (false), quality ('720p' | '1080p' | 'native'; '1080p'), fps (30 | 60; 30), audio (true), notify (true), copyTo (''), shortcuts: { replay, record, screenshot } }`. Un atajo vacío (`''`) es "sin atajo"; los inválidos o repetidos se ignoran.

## Archivos de datos

- `data/capture-ai.json`: `{ version: 1, items: { <instancia>|<ruta>|<tamaño>: { text, at } } }` (descripciones hechas con IA; hasta 5000).

## Límites conocidos

- Un juego en pantalla completa **exclusiva** puede verse negro (Windows Graphics Capture captura lo que compone el escritorio). Minecraft en ventana o "pantalla completa sin bordes" anda bien.
- El audio es el de todo el equipo (loopback de Windows), no solo el del juego.
- Si la ventana del juego cambia de tamaño durante una grabación, el video cambia de resolución en ese punto (los reproductores lo soportan; el encabezado dice el tamaño inicial).
- Con dos juegos abiertos se captura el que se abrió último.
- La exportación del editor es en tiempo real.

## Cómo verificar

```bash
node --test "src/main/modules/capture/test/"     # WebM, buffer, grabación, lógica, ventana, recorte, filtros, IA
```

Prueba de punta a punta (sin Minecraft): un script de Electron que abre una ventana propia animada titulada "Minecraft 1.21.1 · Venus Launcher", registra `capture.js`, simula `game.status()`/`'state'` y llama a `capture:saveReplay`, `capture:screenshot`, `capture:startRecording`/`stopRecording` y `capture:saveExport`; después carga cada WebM en un `<video>` y revisa duración, tamaño y que se pueda adelantar.
