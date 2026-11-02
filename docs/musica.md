# Música (controlar Spotify y cualquier reproductor)

> Documento para desarrolladores del módulo **nowplaying** (agente A de la 2.0). Guía de usuario: [funciones.md](funciones.md). Contratos generales: [arquitectura.md](arquitectura.md).

Desde el launcher y mientras se juega se puede ver qué suena y controlarlo: reproducir o pausar, siguiente, anterior, adelantar o retroceder 10 s, saltar a una posición, y el **volumen de la app** en el mezclador de Windows (más silenciar). Anda con **Spotify gratis o Premium**, YouTube Music, Apple Music, el Reproductor multimedia, VLC y los navegadores (Chrome, Edge, Firefox, Opera, Brave...): cualquier app que use los controles multimedia de Windows.

**Por qué no la Web API de Spotify:** sus controles de reproducción exigen Spotify Premium y una cuenta conectada. Los controles multimedia de Windows (SMTC, `Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager`) son los mismos que usan las teclas multimedia y el panel de volumen de Windows: no piden cuenta, ni claves, ni red.

Solo Windows 10 (1809 o posterior) y 11. En otras plataformas todo responde "no disponible" (`reason: 'platform'`) y nada se rompe.

## 1. Piezas

```
src/main/modules/nowplaying.js            Módulo (canales, ajustes, juego, atajos globales, overlay)
src/main/modules/nowplaying/
  script.js      Ayudante: script de PowerShell (SMTC) + C# compilado con Add-Type (Core Audio y portada)
  protocol.js    Lee las líneas JSON del ayudante con validación y arma los comandos
  helper.js      Abre el proceso, comandos con respuesta, reintentos con espera creciente (Backoff)
  sessions.js    Lógica pura: nombre y tipo de cada app, qué sesión se controla, mezclador, estado del overlay
  controller.js  Estado: junta todo, arma la vista, comandos, volumen, y cuándo se abre o se cierra el ayudante
  config.js      settings.nowplaying y atajos (normalización de aceleradores, plan sin choques)
  test/          node:test (sin Electron)
src/main/i18n/{es,en}/nowplaying.js       Errores y avisos del overlay
src/renderer/js/pages/music.js            Página #/music
src/renderer/js/features/nowplaying.js    Cliente compartido, mini reproductor, tarjeta de Ajustes y paleta Ctrl+K
src/renderer/styles/pages/music.css       .mu-*
src/renderer/styles/features/nowplaying.css  .np-*
src/renderer/i18n/{es,en}/nowplaying.js
```

## 2. El ayudante

Un `powershell.exe` oculto (ruta completa de `System32`, `-NoProfile -NonInteractive -WindowStyle Hidden -Command <script>`), sin dependencias npm:

- **SMTC** en PowerShell: los tipos de WinRT se cargan con `ContentType=WindowsRuntime` y las operaciones asíncronas se esperan con `WindowsRuntimeSystemExtensions.AsTask`.
- **Volumen y portada** en C# compilado al vuelo con `Add-Type` (.NET Framework viene con Windows). El código C# viaja en la variable de entorno `VENUS_NP_CS` para que la línea de comandos quede chica:
  - Core Audio por COM (`IMMDeviceEnumerator` → `IAudioSessionManager2` → `IAudioSessionControl2` + `ISimpleAudioVolume`), en todas las salidas de audio activas. De cada sesión manda el PID, el ejecutable y, si es de la Tienda, el nombre del paquete (nunca la ruta completa).
  - Portada: `CreateStreamOverRandomAccessStream` (shcore) para leer la miniatura de SMTC, recorte cuadrado y JPEG de 192 px que se achica (calidad y tamaño) hasta entrar en **20 KB como data: URL**. Se vuelve a leer a los 1,5 y 4,5 s de cambiar de canción porque algunas apps actualizan la imagen después del título.
- Pregunta cada 1 s (2 s si no hay reproductores) y el mezclador cada 2 s, pero **solo escribe cuando algo cambió**. Medido en una PC con Windows 11: arranca en ~0,4 s, usa ~110 MB y ~2 % de un núcleo.
- Se cierra solo si se cierra su stdin, si recibe `quit` o si desaparece el proceso del launcher (`VENUS_PARENT_PID`, revisado cada 5 s).

### Protocolo (una línea JSON por mensaje)

Ayudante → launcher:

| Mensaje | Contenido |
|---|---|
| `{ t: 'ready', v, smtc, audio, thumbs, error? }` | `smtc: false` = Windows sin SMTC: el ayudante termina y no se reabre |
| `{ t: 'sessions', system, list }` | Cada sesión: `id` (AppUserModelId, con `#2`, `#3`... si la misma app tiene varias), `app`, `title`, `artist`, `album`, `key` (hash de la canción), `status` (0 cerrada, 1 abierta, 2 cambiando, 3 detenida, 4 sonando, 5 en pausa), `position`, `start`, `end` (ms en la línea de tiempo de la app), `updated` (epoch ms en que la app informó la posición), `canPlay`, `canPause`, `canToggle`, `canNext`, `canPrev`, `canSeek`. `system` = la que eligió Windows |
| `{ t: 'art', id, key, data }` | Portada (data:image/jpeg;base64, ≤ 20 KB) o `null` |
| `{ t: 'audio', list }` | Sesiones del mezclador: `{ pid, exe, pkg, volume (0 a 1), muted, active }` |
| `{ t: 'result', req, ok, error? }` | Respuesta a un comando con `req`. Errores: `noSession`, `noAudio`, `rejected`, `badCommand`, `failed` |
| `{ t: 'log', msg }` | Error interno (como mucho uno cada 30 s por lugar); va a la consola con `[nowplaying]` |

Launcher → ayudante: `{ req, cmd: 'play' \| 'pause' \| 'toggle' \| 'next' \| 'prev' \| 'stop', id }`, `{ req, cmd: 'seek', id, position }` (ms en la línea de tiempo de la app), `{ req, cmd: 'setVolume', pids, volume }`, `{ req, cmd: 'setMute', pids, muted }`, `{ cmd: 'poll' }` (manda todo de nuevo), `{ cmd: 'ping' }`, `{ cmd: 'quit' }`.

`protocol.js` valida todo lo que llega: textos sin caracteres de control y con largo máximo, números en rango, portadas solo `data:image/(jpeg|png);base64` de hasta 20 KB, códigos de error de una lista cerrada.

## 3. Cuándo está abierto

- Lo abre la interfaz al pedir el estado (`nowplaying:state`, `nowplaying:sources` o un control): ese pedido dura **45 s**. El cliente de la interfaz lo renueva cada 15 s **solo mientras la ventana se ve** (minimizada deja de pedirlo y el ayudante se cierra solo).
- También queda abierto mientras haya **un juego abierto** (sin contar las partidas de prueba `quiet`) y además: la música en el overlay activa (`settings.nowplaying.overlay`, el overlay encendido y su widget de música, `settings.overlay.widgets.music.enabled`, y que exista `modules/overlay.js`) **o** los atajos de música activos.
- Un atajo lo abre por 30 s si estaba cerrado (el primer comando espera a que esté listo: ~0,5 s).
- Si se cae, se reabre con espera creciente: 1 s, 2 s, 4 s... hasta 60 s; si anduvo bien más de un minuto, la espera vuelve a 1 s. Si no queda listo en 25 s, se lo mata y cuenta como caída. Si Windows no tiene SMTC (`smtc: false`), queda `unsupported` hasta reiniciar el launcher. El botón **Reintentar** de la página (`nowplaying:state({ retry: true })`) no espera.
- Al cerrarse, se olvida lo que mostraba (la vista queda sin estado hasta el próximo mensaje).

## 4. Qué reproductor se controla

`settings.nowplaying.source`:

- `'auto'` (por defecto): **Spotify si está sonando o si no suena otra cosa**; si Spotify está en pausa y otra app suena, la que suena (primero la que ya se controlaba, después la que elige Windows). Entre dos apps sonando sin Spotify se mantiene la anterior para no saltar.
- `'system'`: la que elige Windows (la del panel de volumen).
- El id de una app (`'Spotify.exe'`, `'Chrome'`, `'AppleInc.AppleMusicWin_…!App'`...): siempre esa; si no está abierta, como `'auto'` (la vista trae `source.missing: true`).

Volumen: las sesiones del mezclador se buscan por ejecutable (`Spotify.exe`), por paquete de la Tienda (nombre y editor), por nombres conocidos (Chrome → `chrome.exe`, el hash de 16 dígitos de Firefox → `firefox.exe`...) y por nombre base. Si la app tiene varias sesiones (navegadores), se cambian todas; el nivel que se muestra es el de la que está sonando. Subir el volumen de una app silenciada le saca el silencio, como el mezclador de Windows. Si la app todavía no abrió audio, no hay volumen (`volume.available: false`) y la interfaz lo explica.

## 5. Canales y contratos

| Canal | Qué hace |
|---|---|
| `nowplaying:state({ retry? }?)` | Vista completa (abajo). Renueva el pedido de la interfaz |
| `nowplaying:control(acción, valor?)` | `toggle`, `play`, `pause`, `next`, `prev`, `stop`, `forward` / `back` (valor = ms, 10 s por defecto), `seek` (valor = ms desde el principio), `mute` (valor = bool o alternar), `volumeUp` / `volumeDown` (valor = paso de 0 a 1, 5 % por defecto). Devuelve la vista |
| `nowplaying:setVolume(nivel)` | Volumen de la app (0 a 1). Devuelve la vista |
| `nowplaying:sources()` | `{ choice, loaded, list: [{ id, appName, source, title, artist, playing, system, selected }] }` |
| `nowplaying:openSpotify()` | Abre la app de Spotify (`spotify:`). `err.code 'noSpotify'` si no está instalada (se detecta con `app.getApplicationNameForProtocol('spotify://')` y la carpeta de Spotify) |
| Evento `nowplaying:update` | La vista, cuando cambia algo que se ve (no por el avance normal de la posición) |

**Vista:** `{ available, reason (null, 'platform' o 'unsupported'), status ('idle', 'starting', 'ready', 'retrying', 'stopping' o 'unsupported'), retryAt, loaded, state, can: { play, pause, toggle, next, prev, seek }, volume: { available, level, muted }, source: { choice, id, missing }, sessions, overlay, shortcuts: { enabled, items: [{ action, accel, state }] }, spotify: { installed } }`.

**Estado (`state`, contrato 1 del overlay):** `{ title, artist, album, art (data: URL ≤ 20 KB o null), playing, position, duration, source, appName }` + extras `appId`, `status` ('playing', 'paused', 'stopped'...), `positionAt` y `canSeek`. **`position` y `duration` van en milisegundos** y `position` es la de la hora `positionAt` (epoch ms): si `playing`, sigue avanzando sola (`position + (ahora - positionAt)`, sin pasar de `duration`). `duration` es 0 si la app no la informa (transmisiones en vivo). `source`: `'spotify'`, `'apple-music'`, `'youtube-music'`, `'browser'`, `'media-player'` u `'other'`.

**Para otros módulos (proceso principal):** `require('./nowplaying')` → `getState()` (el estado de arriba con la posición al día, o `null`) y `events` (EventEmitter, evento `'update'` con el mismo estado o `null`). Además el módulo hace `require('./overlay').push({ kind: 'music', state })` (en try/catch; si el overlay no existe no pasa nada) cuando cambia la canción, play/pausa, la portada, un salto de posición de más de 2,5 s o la duración, y solo si `settings.nowplaying.overlay` está activo; al apagarlo manda `state: null` una vez. Con los atajos de volumen, si hay un juego abierto, también manda `{ kind: 'alert', title: 'Volumen de la música: 60 %', icon: 'music', ttl: 1500 }`.

Errores con `err.code`: `platform`, `unsupported`, `unavailable` (el ayudante no responde o no quedó listo en 9 s), `noSession`, `rejected` (la app no aceptó), `noSeek`, `noAudio`, `noSpotify`, `badAction`, `timeout`.

## 6. Atajos globales

Desactivados por defecto (`settings.nowplaying.shortcuts.enabled`). Acciones y aceleradores de fábrica: `playPause` Ctrl+Alt+Espacio, `next` Ctrl+Alt+→, `prev` Ctrl+Alt+←, `volumeUp` Ctrl+Alt+↑, `volumeDown` Ctrl+Alt+↓ (cada uno se puede cambiar o quitar con `''`). Las teclas multimedia del teclado funcionan siempre, sin activar esto, porque Windows ya las manda a SMTC.

- Se registran con `globalShortcut` dentro de `register` y solo se desregistran los propios (nunca `unregisterAll`).
- Nunca se pisa el del Voice Chat: se reserva `settings.voice.muteShortcut` y su valor por defecto (`CommandOrControl+Shift+M`), los atajos se registran 2,5 s después de arrancar (cuando `main.js` ya registró el del Voice Chat) y un acelerador que ya registró otra parte del launcher (`globalShortcut.isRegistered`) queda como `reserved`.
- Estado de cada uno en la vista: `ok`, `inUse` (otra aplicación), `reserved` (otra función del launcher), `duplicate`, `invalid`, `empty` u `off` (atajos apagados). Se vuelven a registrar al cambiar `settings.nowplaying` o `settings.voice`.
- Límite conocido: mientras un atajo está registrado, Windows se come esa combinación; por eso no se puede volver a "grabar" la misma combinación desde la tarjeta (no llega la tecla). Quitarlo y grabarlo de nuevo sí anda.

## 7. Ajustes (`settings.nowplaying`)

`{ source: 'auto' | 'system' | '<id de app>', overlay: true, shortcuts: { enabled: false, playPause, next, prev, volumeUp, volumeDown } }`. La clave vieja `music` (y `data/music.json`) es de la sección Música anterior y no se lee. No guarda archivos de datos.

## 8. Interfaz

- **`#/music`** (`pages/music.js`): portada grande (con la portada desenfocada de fondo, que se apaga con alto contraste), app y estado, título, artista y álbum, barra de progreso que se puede arrastrar o mover con el teclado (si la app deja), controles (anterior, −10 s, reproducir/pausar, +10 s, siguiente), volumen de la app con silenciar, y debajo la tarjeta de ajustes. Estados: cargando (skeleton), nada sonando (con **Abrir Spotify** si está instalado), sin Windows o sin SMTC, y no se pudo conectar (con **Reintentar**).
- **Mini reproductor** (`miniPlayer()`): portada, canción y artista (abre `#/music`), reproducir/pausar y siguiente, y una línea de progreso. Se oculta si no hay nada.
- **Tarjeta de Ajustes** (`nowPlayingPanel()`): reproductor que se controla, mostrar la canción en el juego y atajos (grabar con el teclado, quitar, estado de cada uno).
- **Paleta Ctrl+K** (`startup()`): Abrir Música, reproducir o pausar, siguiente y anterior.
- El cliente de `features/nowplaying.js` (`nowPlaying.subscribe/refresh/control/setVolume/sources/openSpotify`) comparte una sola suscripción a `nowplaying:update` entre todo lo de arriba.

## 9. Privacidad y seguridad

- Nada sale de la PC: no hay red, cuentas ni claves. Los títulos y las portadas viven en memoria; no se guardan.
- El ayudante no ejecuta nada que llegue de afuera: los comandos son una lista cerrada y se validan de los dos lados. No usa `Invoke-Expression`.
- La interfaz nunca usa `innerHTML` con títulos de canciones y solo muestra portadas `data:image/(jpeg|png);base64` validadas.
- Los comandos de reproducción solo salen de una acción del usuario (botón, paleta o atajo).

## 10. Pruebas

```bash
node --test "src/main/modules/nowplaying/test/"                       # 65 pruebas sin Electron ni Windows (+1 que se saltea)
VENUS_NP_LIVE=1 node --test "src/main/modules/nowplaying/test/script.test.js"   # además abre el ayudante real (solo lee)
```

Cubren: lectura de cada mensaje (valores raros, listas de un elemento, portadas inválidas o grandes, BOM, líneas partidas), armado de comandos, elección de la sesión (auto, system, app elegida, sin saltos), mezclador (ejecutables, Tienda, navegadores, Firefox), posición que avanza sola, avisos al overlay solo cuando corresponde, comandos y errores, volumen y silencio, espera a que el ayudante esté listo, reintentos con espera creciente, Windows sin SMTC, cierre y reapertura, y que el script entienda todos los comandos del protocolo.

Capturas (sección 9 de arquitectura.md): mientras `app.js` no registre la página, se puede registrar desde la ruta de `devshot`:

```bash
VENUS_DEVSHOT=<carpeta> VENUS_DATA_DIR=<carpeta-temporal> VENUS_SKIP_ONBOARDING=1 \
VENUS_DEVSHOT_ROUTES="home|(async()=>{const a=await import('./js/app.js');a.registerPage('music',()=>import('./js/pages/music.js'),{label:'Música',icon:'music'});})();0;;music" \
  ./node_modules/.bin/electron .
```
