# Clips y capturas

> La captura existente se amplía con el estudio de clips de la 4.5.0 (publicado con la 4.6.0; la integración con OBS se retiró en la 4.6). Contratos detallados: [montaje, timelapse, subida y galería](implementacion/clips.md). [Estado y validaciones pendientes](estado-4.5.0.md).

Grabación del juego, repetición instantánea, capturas de pantalla, galería con editor rápido y compartir. Sin dependencias nuevas: todo con `desktopCapturer` + `MediaRecorder` de Electron y un lector/escritor de WebM propio.

## Para el usuario

- **Repetición instantánea** (apagada por defecto): mientras jugás guarda en disco los últimos **30 s, 1, 2, 5, 10, 15 o 30 minutos** (lo que elijas, para todos: desde la 6.1 no depende de ningún plan), en archivos temporales que se borran al cerrar el juego. Al apretar el atajo, ese tramo queda como clip. Usa CPU y disco, por eso solo corre con un juego abierto y solo si la prendiste en **Ajustes → En el juego → Clips y capturas** (`#/settings/ingame/capture`). Ajustes muestra **cuánto ocupa** la combinación elegida (duración × resolución × fps × calidad) y cuánto hay libre; si no entra con 1 GB de margen, lo dice y la repetición no arranca (ver [Disco](#disco)).
- **Clips automáticos** (apagados por defecto, necesitan la repetición prendida): el clip se guarda solo al **morir**, al **conseguir un logro** o al **matar un jefe**, unos segundos después del evento para que incluya lo que siguió. Solo lo que le pasa a tu cuenta, no a otros jugadores. Se elige qué eventos cuentan, cuánto dura cada clip (60 s por defecto, para no gastar cientos de MB por muerte; nunca más que la repetición), la espera entre clips (30 s) y el máximo por partida (20). Ver [qué se detecta](#clips-automáticos).
- **Grabación**: el atajo empieza a grabar y el mismo atajo termina. Va directo al disco, **sin límite** por defecto o con un largo máximo (15 o 30 minutos, 1, 2 o 4 horas) que se elige en Ajustes: al llegar se termina sola y se guarda. No empieza si no quedan unos minutos de lugar más 1 GB, y se termina sola (guardando lo hecho) si el disco baja de 512 MB libres.
- **Captura de pantalla**: solo la ventana del juego, al tamaño real de la ventana (PNG).
- **Atajos por defecto**: guardar repetición `Alt+Shift+F8`, grabar `Alt+Shift+F9`, captura `Alt+Shift+F12` (Alt+F9/Alt+F10 los usa NVIDIA). Se cambian en Ajustes; funcionan **solo mientras hay un juego abierto** (así no le sacan esas teclas a otras aplicaciones). Si otra aplicación ya usa la combinación, el panel lo avisa.
- **Calidad**: tres ajustes de un clic (**Liviano** 720p 30 fps, **Equilibrado** 1080p 60 fps, **Máximo** 1440p (2K) 120 fps, o 4K 60 fps si la pantalla es 4K) o manual: resolución 720p, 1080p, 1440p (2K), 4K o nativa (la de la ventana, con tope en 4K); 30, 45, 60, 80 o 120 fps; calidad de imagen Baja, Media o Alta. **Nunca se agranda**: si la ventana del juego es más chica que lo elegido, se graba a su tamaño y Ajustes lo dice. Los fps son un tope: el video tiene los cuadros que el juego muestra (con VSync, como mucho los Hz de la pantalla; Ajustes avisa "Hasta 120 fps: depende de tu monitor, del juego y de tu PC"). Si la PC no llega, baja sola un paso y avisa (ver [Calidad, codec y lo que se midió](#calidad-codec-y-lo-que-se-midió)). En una PC modesta (datos de `perf:system`) o con el modo liviano, Ajustes avisa si la calidad elegida es más pesada que Equilibrado. **Audio**: el sonido del equipo (en Windows es todo el audio de la PC, no solo el del juego).
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

El **buffer de la repetición** no se guarda ahí: va a `cache/capture-replay/<id>/` dentro de los datos del launcher (segmentos `seg-000001.bin`), así que el lugar que importa para la repetición es el del disco de los datos del launcher; el de la carpeta de la instancia se mira al guardar el clip y al grabar. Se borra al cerrar el juego o al apagar la repetición y, por si el launcher se cerró de golpe, también al arrancar. Limpiar la caché del launcher mientras se juega no rompe nada: se pierde lo que había y sigue.

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
3. `MediaRecorder` graba WebM (AV1 o H.264 por la placa de video si la hay; si no, VP9 o VP8 por el procesador; audio Opus) con un cuadro clave cada 2 s (`videoKeyFrameIntervalDuration`) y entrega pedazos de 1 s, que la grabadora manda por IPC al proceso principal. La grabadora mide el tamaño real de los cuadros (no el tope pedido) antes de elegir el bitrate y cada 2 s avisa cuántos cuadros entregó la captura (`MediaStreamTrack.stats`).
4. Repetición y grabación comparten **una sola** captura (un solo codificador): los cuadros van al buffer circular en disco y, si se está grabando, también al archivo.

### El WebM (por qué hay un lector propio)

`MediaRecorder` escribe un WebM "en vivo": Segment y Clusters de tamaño desconocido, sin duración ni índice. Además Chrome abre un Cluster nuevo cada ~1 s **sin alinearlo con los cuadros clave** (verificado en Electron 44). Por eso:

- No se puede cortar un pedazo cualquiera del flujo: sin el encabezado no se reproduce y un Cluster puede empezar en un cuadro que depende de otro.
- `webm.js` lee el flujo cuadro por cuadro (SimpleBlock/BlockGroup, pista, tiempo absoluto y si es clave), guarda el encabezado (EBML + Info + Tracks) y arma Clusters nuevos, uno por cuadro clave de video, con los tiempos corridos para empezar en cero.
- El archivo final lleva Segment con tamaño, SeekHead, Info con **Duration**, Tracks y **Cues** (un punto por cuadro clave): el video dice su duración y se puede adelantar (sin eso, Chrome muestra duración "Infinity" y no deja buscar).
- **Repetición**: `ring.js` escribe los cuadros en segmentos de ~10 s, cada uno desde un cuadro clave, y borra los viejos enteros (se queda desde el último cuadro clave antes del corte, así que guarda hasta un segmento de más; con video quieto, tope duro de 4×N, y nunca más bytes que `logic.ringMaxBytes`: 1,5 veces lo estimado, sin dejar el disco con menos de 1 GB). En memoria solo queda un índice por segmento y lo que falta escribir: si el disco no da abasto, saltea cuadros hasta el próximo cuadro clave en vez de juntarlos en RAM. Si la escritura falla, si al arrancar (o al cambiar el largo o la calidad) quedarían menos de 1 GB libres además del buffer, o si con el juego abierto el disco baja de 512 MB libres, la repetición se pausa con un aviso que dice cuánto hace falta (el juego y la grabación siguen). Al guardar se pide a `MediaRecorder` lo que tenía pendiente (`requestData`), se retienen los segmentos (la rotación no los borra mientras tanto) y se pasan al archivo final de a uno con `RecordingFile`: un clip de 5 minutos nunca está entero en memoria.
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

**Reglas** (`autoclip.js`): el interruptor general y el del tipo tienen que estar prendidos, y la repetición andando. El clip se corta unos segundos después (5 s; 12 s si es un jefe, el dragón tarda en morir). Si mientras tanto llega otro evento no se abre otro clip: queda uno solo, con el motivo más importante (jefe > muerte > logro). Después del evento hay un enfriamiento (30 s por defecto, de 5 s a 10 minutos) para todos los motivos y un máximo por partida (20 por defecto); al llegar se avisa una vez y el atajo sigue andando. Si el juego se cierra durante la espera, el clip se guarda igual. El clip dura lo que diga **Largo de cada clip** (60 s por defecto), sin pasarse de lo que guarda la repetición.

## Canales y eventos

| Canal | Qué hace |
|---|---|
| `capture:status()` | `{ settings, available, audioAvailable, replaySeconds, diskEstimate, diskFree, diskOk, diskSaveOk, recordPerMinute, plan: { width, height, fps, codec, hardware, bitrate, expected, notes: ['window' \| 'monitor'] }, display: { width, height, hz }, preset: 'light' \| 'balanced' \| 'max' \| 'custom', presets: [{ id, quality, fps, level, width, height, disk }], heavy, degraded: { quality, fps } \| null, live: { width, height, codec, hardware, bitrate, fps, delivered } \| null, options: { replayLengths, qualities, fps, levels, recordLimits }, game: { instanceId, window, searching } \| null, replay: { enabled, active, buffered, disk, error: null \| 'noRoom' \| 'disk' }, auto: { saved, limit }, recording: { active, instanceId?, startedAt?, duration?, limit? }, shortcuts: { replay\|record\|screenshot: { accel, registered, active } }, folders }`. Bytes en `diskEstimate` (la repetición elegida), `diskFree` (disco de los datos del launcher; `null` si no se sabe) y `recordPerMinute`; `diskSaveOk` dice si, con el buffer lleno, queda lugar para guardar el clip entero; bits por segundo en `plan.bitrate` (lo que se le pide a MediaRecorder) y `expected` (lo que se espera que ocupe); `live.bitrate` es lo que se espera que ocupe la captura andando (por la placa de video, lo pedido por cuánto gasta de más). `plan.codec` es `null` hasta que la grabadora arrancó. |
| `capture:saveReplay()` | Guarda la repetición → `{ path, instanceId, duration }` |
| `capture:screenshot()` | Captura de la ventana del juego → `{ path, instanceId, width, height }` |
| `capture:startRecording()` · `capture:stopRecording()` · `capture:toggleRecording()` | Grabación |
| `capture:testShortcut(acelerador, acción)` | `{ ok, accel, reason?: 'invalid' \| 'duplicate' \| 'inUse', other? }` |
| `capture:openFolder({ instanceId?, kind })` | Abre `screenshots/`, `clips/` o `recordings/` (sin instancia: la del juego abierto o la elegida) |
| `capture:saveExport({ instanceId, sourceName, mode }, bytes)` | Guarda lo que exporta el editor → `{ path, name, duration }` |
| `capture:aiStatus()` · `capture:aiIndex()` · `capture:aiDescribe([{ key, path }])` | Búsqueda con IA (a pedido) |

Errores con `err.code`: `noGame`, `noWindow`, `notReady`, `replayOff`, `empty`, `instance`, `write`, `capture`, `tooBig`, `badWebm`, `noRoom` (no hay lugar para empezar a grabar), `unavailable` (IA, o una plataforma sin grabación) y los de `modules/ai.js` en `aiDescribe`. `capture:setPremium` se retiró en la 6.1 (Venus Premium ya no cambia nada de la captura).

Eventos: `capture:saved` `{ type: 'screenshot' | 'clip' | 'recording', path, instanceId, duration? (segundos), reason? ('death' | 'advancement' | 'boss', clip automático) }` (contrato 4), `capture:state` (lo mismo que `capture:status`, cuando cambia y cada 1 s mientras hay repetición o grabación), `capture:notice` `{ level, message }` (errores de los atajos, falta de disco, máximo de clips automáticos, la grabación que llegó a su límite o se cortó por el disco, la calidad que bajó sola) y `worlds:updated` `{ kind: 'media', instanceId }` para que Mundos refresque.

**Overlay** (contrato 1): `overlay.push({ kind: 'capture', type: 'screenshot' | 'replay-saved' | 'recording-start' | 'recording-stop', path?, thumb? (data: JPEG de 320 px), duration? })` y `{ kind: 'alert', icon: 'capture', … }` cuando falla un atajo. Se omite con `notify: false`. Un clip automático avisa igual que uno guardado con el atajo (`replay-saved`): el contrato del overlay no lleva el motivo.

**Logros** (contrato 3): `features/capture.js` despacha `venus:achievement` con `first_screenshot` (captura) o `first_clip` (clip o grabación), una vez por sesión.

**Señal nueva** `media-share` `{ url, kind: 'screenshot' | 'clip', name }`: la manda **A un amigo** del visor; `features/capture.js` la escucha con `social.onSignal('media-share')` y muestra un aviso con **Ver** (como mucho uno cada 8 s por amigo). Solo se aceptan links `https` firmados del Storage del proyecto del launcher (`/storage/v1/object/sign/screenshots|clips/…`).

**Destacar en el perfil**: lo hace el editor de perfiles (agente D): `import('../../features/profile-editor.js')` → `featureCapture({ src: Blob, title })` (sube a `profile-media`, agrega a `featured` con hasta 3 y, si ya hay 3, pregunta si reemplazar la primera; muestra sus propios avisos). Clips le pasa la captura como `Blob` leída con `worlds:readMedia` y el mundo (o la instancia) como título. Si ese módulo no está, el botón avisa que no está disponible.

## Ajustes (`settings.capture`)

`{ replay (false), replaySeconds (30 | 60 | 120 | 300 | 600 | 900 | 1800; 60), quality ('720p' | '1080p' | '1440p' | '2160p' | 'native'; '1080p'), fps (30 | 45 | 60 | 80 | 120; 30), level ('low' | 'medium' | 'high'; 'medium'), recordLimit (minutos: 0 = sin límite, 15, 30, 60, 120 o 240; 0), audio (true), notify (true), copyTo (''), shortcuts: { replay, record, screenshot }, auto: { enabled (false), death (true), advancement (true), boss (true), cooldown (segundos, 5 a 600; 30), maxPerSession (1 a 200; 20), seconds (30 | 60 | 120 | 300; 60) } }`. Un atajo vacío (`''`) es "sin atajo"; los inválidos o repetidos se ignoran.

**Migración** (`logic.normalizeSettings`, sin reescribir el archivo): lo guardado por la 6.0 sigue valiendo tal cual (`quality` 720p/1080p/native, `fps` 30/60); sin `replaySeconds` queda en 60 s (antes eran 60 s fijos, 5 minutos con Premium; los ajustes de la 6.0 no guardaban el plan ni el largo, así que no se puede saber quién tenía 5 minutos y nadie lo recupera solo: se elige en Ajustes); `'2k'`/`'1440'` se leen como `'1440p'` y `'4k'`/`'2160'` como `'2160p'`; un número fuera de la lista va al más cercano (`fps` 50 → 45, 240 → 120; `replaySeconds` 99999 → 1800; `recordLimit` 45 → 30); lo que no es un número vuelve al valor por defecto. El preset no se guarda: se deduce de `quality`, `fps` y `level` (`logic.activePreset`).

## Calidad, codec y lo que se midió

Todo se decide en `capture/logic.js` (sin Electron, con pruebas) y la grabadora aplica la misma cuenta al tamaño real de la ventana (`renderer/js/recorder/bitrate.js`; una prueba compara las dos).

- **Bitrate** = píxeles × "cuadros equivalentes" × bits por píxel × factor del codec. Cuadros equivalentes = 30 × (fps/30)^0,7 (60 fps cuesta 1,6 veces 30; 120 fps, 2,6 veces). Bits por píxel: Baja 0,06, Media 0,1, Alta 0,15. Factor: VP9 1, AV1 0,8, H.264 1,35, VP8 1,25. Entre 1,5 y 100 Mbps. Con Media en VP9: 1080p60 ≈ 10 Mbps, 1440p60 ≈ 18, 4K60 ≈ 40 (un poco menos de lo que YouTube recomienda para subir: 12, 24 y 53 en H.264).
- **Codec**: la grabadora pregunta a WebCodecs (`VideoEncoder.isConfigSupported` con `prefer-hardware`, solo codec y tamaño) qué codifica la placa de video y prueba en este orden: AV1 y H.264 por hardware (`logic.HW_CODECS`), después por software VP9 hasta 1080p a 30 fps y VP8 más arriba (`logic.codecOrder`). Usa el primero que MediaRecorder acepte y arranque. Siempre WebM.
- **Por hardware se pide menos**: las GPU gastan ~2,5 veces lo pedido a 60 fps (~1,4 a 30, ~4 a 120); se divide por eso (`logic.hwOvershoot`) para que el archivo pese lo que dice la tabla.
- **Disco** (`logic.expectedBitrate`, `replayDisk`, `estimateBytes`): sin saber todavía el codec se cuenta el peor caso (1,45 veces lo de VP9, lo que se midió por software con una imagen que cambia toda); con la captura andando, lo del codec elegido. Es un tope: con la imagen quieta se usa menos.
- **Si la PC no llega** (`logic.assessRate` + `logic.stepDown`, cada 4 s con los últimos 8 s): con un codificador por software que saca menos del 85 % de los fps pedidos dos veces seguidas, se baja un paso (primero los fps de 120 → 80 → 60, después la resolución 4K → 1440p → 1080p → 720p, después 60 → 45 → 30), se vuelve a empezar la captura y se avisa. También si MediaRecorder falla al poco de empezar. Hasta 4 pasos por partida; al cambiar un ajuste o en la próxima partida se vuelve a probar lo elegido. Con una grabación en curso no se corta: se anota un solo paso y se aplica al terminarla (el aviso lo dice; mientras tanto el archivo queda con menos fps, sin romperse: cada cuadro lleva su tiempo). Por hardware no se baja: si salen menos cuadros es el juego o la pantalla (Ajustes lo dice). Para no confundir al juego con la PC: solo se decide en los primeros 30 s de cada captura (un codificador que no da abasto se nota enseguida; una caída después es el juego, y reiniciar tiraría el buffer de la repetición), con la mediana de los cuadros de cada segundo (un tirón suelto de una pantalla de carga no la mueve) y, si no llega ningún cuadro (ventana minimizada), no es el codificador. Si la ventana es más chica que la calidad elegida, el paso saltea las resoluciones que no la achicarían. Queda sin resolver: con software, un juego que va estable por debajo del 85 % de los fps pedidos no se distingue de un codificador saturado y baja en esos primeros 30 s.

**Prueba real** (10 de noviembre de 2026, Electron 44.7.0 / Chromium 152, Windows 11, RTX 4070 SUPER, pantalla 2560×1440 a 60 Hz): una ventana de Electron propia con un canvas que desplaza una textura de bloques por toda la pantalla (como girar la cámara; peor caso para el codificador), grabada con el mismo camino del launcher (`desktopCapturer` → `capture/host.js` → `recorder/main.js` → `WebmReader` → `RecordingFile`), 10 s por prueba; del archivo final se midió tamaño, fps reales, cuadros clave y que un `<video>` lo reproduzca y adelante. CPU = suma de `app.getAppMetrics()` (100 = un núcleo).

| Pedido | Codec elegido | Resultado | CPU |
|---|---|---|---|
| 1080p 60 | AV1 (GPU) | 1920×1080, 59,7 fps, ~10 Mbps | 4 % |
| 1440p 60 (ventana de 2560×1370) | AV1 (GPU) | 2560×1370, 59,5 fps, ~17 Mbps | 5 % |
| 4K 60 Alta | AV1 (GPU) | 3840×2160, 59,2 fps, ~53 Mbps | 9 % |
| 1080p 120, juego sin VSync | AV1 (GPU) | 105 fps (el canvas daba 126) en una pantalla de 60 Hz | 9 % |
| 1440p 120, juego sin VSync | AV1 (GPU) | 2560×1370, ~100 fps | 11 % |
| 1440p 120, juego con VSync | AV1 (GPU) | 60 fps: los Hz de la pantalla | 6 % |
| 1080p 30 sin GPU | VP9 | 30 fps, ~8 Mbps | 28 % |
| 1080p 60 sin GPU | VP8 | 59,6 fps, ~14 Mbps | 15 % |
| 4K 60 sin GPU | VP8 | ~34 fps: no llega → baja sola a 1440p 60 (60 fps) | 36 % |

Lo que mostró la prueba y decidió el diseño: VP9 por software no llega a 1080p60 (39 fps con 35 % de CPU) y VP8 sí; H.264 por software (OpenH264) ignora el cuadro clave cada 2 s y saca todo cuadro clave (~100 Mbps), por eso nunca se usa sin GPU; cuando el codificador por software no da abasto, Chromium frena la captura y las estadísticas de la pista bajan igual, así que no sirven para separar "no llega la PC" de "el juego da menos fps"; una ventana más grande que la pantalla (4K en una de 1440p) se captura entera; los fps de la captura no están atados a los Hz de la pantalla: dependen de cuántos cuadros muestre el juego. Clips AV1 y H.264 de esta prueba (4K60 y 1080p120) se decodificaron con `VideoDecoder` como hace el montaje (240 de 240 cuadros). Con `capture.js` entero (juego simulado): repetición → clip AV1 de 12,8 s a 59,9 fps, grabación de 7,2 s a 60 fps, captura de pantalla, cambio del largo a 10 minutos en caliente, degradación 4K120 → 4K80 → 4K60 → 1440p60 sin GPU, y disco lleno simulado (la repetición de 30 min a 4K se frena con el aviso; una grabación sin lugar no empieza).

**Falta ver con Minecraft de verdad**: los fps y la CPU con el juego corriendo a la vez (la prueba usó una ventana propia, que casi no gasta), pantalla completa exclusiva, placas de video sin AV1 (H.264 por hardware: GTX 10/16, Intel antes de Arc, AMD anteriores a RX 7000) y PCs sin GPU dedicada, y cuánto ocupa el video de un juego real (la textura de la prueba es el peor caso; Minecraft debería pesar menos que la tabla).

## Disco

- **Repetición**: antes de arrancar (y al cambiar largo o calidad) se mira el disco de los datos del launcher; si lo estimado más 1 GB no entra, no arranca y avisa cuánto hace falta. Mientras corre, el buffer tiene tope de bytes y cada 15 s se vuelve a mirar: con menos de 512 MB libres se pausa. En pausa por falta de disco vuelve sola si se elige un largo o una calidad que entra, o si se libera lugar (se mira cada 15 s; vuelve recién con lo estimado más 1 GB libres, así que no oscila). Si el buffer entra pero con el buffer lleno no quedaría lugar para guardar el clip entero (guardar copia el tramo al mismo disco), no se bloquea (la estimación es un tope y los clips automáticos cortos sí entran): avisa una vez al arrancar y Ajustes lo dice (`diskSaveOk: false`).
- **Guardar un clip**: hace falta el lugar de ese tramo más 64 MB en el disco de la instancia; si no, error `write` con "No hay espacio".
- **Grabación**: no empieza sin lugar para 2 minutos más 1 GB (`noRoom`); cada 5 s se mira y, con menos de 512 MB libres, se termina sola y se guarda (aviso). El límite de largo (`recordLimit`) también la termina guardando.

## Plataformas

`logic.platformSupport()` es el **único lugar** que decide si hay grabación: hoy solo Windows (`{ capture: true, audio: true }`). En macOS y Linux `capture.js` registra `capture:status` (con `available: false`, Ajustes lo dice), el editor, la carpeta y la IA; los canales de captura responden `unavailable`. El audio del equipo (`loopback`) también sale de ahí (`capture/host.js`). Para macOS hay que probar `desktopCapturer` con el permiso de Grabación de pantalla y la búsqueda de la ventana del juego por título, y después cambiar esa función.

## Archivos de datos

- `data/capture-ai.json`: `{ version: 1, items: { <instancia>|<ruta>|<tamaño>: { text, at } } }` (descripciones hechas con IA; hasta 5000).
- `cache/capture-replay/`: buffers de la repetición (temporales, ver arriba). `cache/capture-lang/<versión>.json`: plantillas en inglés de esa versión (se regeneran solas).

## Límites conocidos

- Un juego en pantalla completa **exclusiva** puede verse negro (Windows Graphics Capture captura lo que compone el escritorio). Minecraft en ventana o "pantalla completa sin bordes" anda bien.
- El audio es el de todo el equipo (loopback de Windows), no solo el del juego.
- Si la ventana del juego cambia de tamaño durante una grabación, el video cambia de resolución en ese punto (los reproductores lo soportan; el encabezado dice el tamaño inicial).
- Con dos juegos abiertos se captura el que se abrió último.
- La exportación del editor es en tiempo real (un clip de 5 minutos tarda 5 minutos) y sale en VP9 con tope de 1080p (vertical, 1080×1920) a los fps que dibuja la pantalla: de un clip de 120 fps o 4K sale uno más liviano.
- Los clips en AV1 o H.264 (los que se graban con la placa de video) se ven en el launcher y en navegadores basados en Chromium; algunos reproductores de Windows necesitan la extensión de AV1. El montaje los recodifica a VP9 (no los une "sin recodificar").
- Más de 60 fps solo si el juego muestra más de 60 cuadros por segundo (VSync apagado o pantalla de más Hz): la captura de una ventana no inventa cuadros.
- **Compartir tiene un tope de 50 MB por clip** y depende del Storage (`file_size_limit` del bucket `clips`, migración `0005_media.sql`; `LIMITS` de `pages/worlds/media.js` es la misma cifra): con la repetición nueva, un clip de 60 s a 1080p 30 fps ya anda justo en ese tope (~50 MB) y uno de varios minutos o a 4K no entra. Hay que recortarlo en el editor o subir el tope en Supabase.
- Los clips automáticos solo ven lo que el juego escribe en su salida: ver la tabla de [qué se detecta](#clips-automáticos).

## Cómo verificar

```bash
node --test "src/main/modules/capture/test/"     # WebM, buffer en disco, grabación, lógica (ajustes y migración, tabla de bitrate, codec, disco, presets, degradación, plataforma; la grabadora calcula igual), parseo del log, idiomas, clips automáticos, ventana, recorte, filtros, IA
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
