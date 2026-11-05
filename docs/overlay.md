# Overlay dentro del juego

> Documento para desarrolladores del módulo **overlay** (agente B de la 2.0). Guía de usuario: [funciones.md](funciones.md). Contratos generales: [arquitectura.md](arquitectura.md).

Mientras se juega, Venus muestra encima del juego el **Voice Chat** (quién está en la sala, quién habla, quién está silenciado o sin sonido), los **mensajes** que llegan, **avisos** (del launcher, de amigos y grupos, de los servidores locales, logros y Venus Points), **capturas, clips y grabación** y **la canción que suena**. Cada widget se activa o no, se ubica en una grilla de 3×3 o en una posición libre arrastrándolo, y tiene tamaño, opacidad y tema propios.

**Cómo funciona:** no toca el juego. Es una ventana de Electron transparente, siempre encima (nivel `screen-saver`), sin foco en su modo habitual, fuera de la barra de tareas y de Alt+Tab, y que deja pasar los clics (`setIgnoreMouseEvents(true, { forward: true })`), puesta exactamente sobre el área de juego de la ventana de Minecraft. Por eso anda con **cualquier versión y loader** (vanilla, Fabric, Forge, NeoForge, Quilt, OptiFine, versiones viejas con LWJGL 2...).

**Límite conocido: pantalla completa exclusiva.** Si el juego toma la pantalla en modo exclusivo, Windows no compone ninguna otra ventana encima y el overlay no se ve. En Windows 10/11 la "pantalla completa" de Minecraft muchas veces pasa por la composición del escritorio (optimizaciones de pantalla completa) y el overlay sí se ve, pero no está garantizado. Lo seguro es jugar en ventana (maximizada) o en ventana sin bordes (por ejemplo con el mod Borderless Mining). La tarjeta de Ajustes lo dice siempre como consejo y, si el ayudante detecta que el área de juego ocupa todo el monitor, muestra un aviso con F11.

Solo Windows (el seguimiento de la ventana usa la API de Win32). En otras plataformas `overlay:status` devuelve `supported: false`; la prueba y el modo edición igual funcionan sobre la pantalla.

## 1. Piezas

```
src/main/modules/overlay.js               Módulo: ventana, seguimiento, push(), canales, atajo, modo edición, prueba, avisos propios
src/main/modules/overlay/
  config.js      settings.overlay: valores por defecto, normalización, atajos válidos, parches de posición
  events.js      Validación de los eventos del contrato 1 (textos, números, imágenes)
  geometry.js    Líneas del ayudante, píxeles físicos -> DIP, qué juego seguir, cuándo se ve
  tracker.js     Ayudante de PowerShell + C# que sigue la ventana del juego
  window.js      BrowserWindow del overlay (transparente, sin foco, click-through) y modo interactivo
  preload.js     Puente mínimo de la página del overlay (window.overlayBridge)
  test/          node:test (sin Electron)
src/main/i18n/{es,en}/overlay.js          Errores y avisos que arma el proceso principal (servidores, tareas)
src/renderer/overlay.html                 Página del overlay (CSP estricta: sin red, sin estilos ni scripts en línea)
src/renderer/js/overlay/
  page.js        Arranque de la página: layout + eventos del preload -> OverlayView
  widgets.js     OverlayView: dibuja los 5 widgets, colas y tiempos, arrastre y teclado (también la vista previa)
  layout.js      Cuentas de posiciones sin DOM (grilla, posición libre, snap, teclado)
  logic.js       Límite de frecuencia, foto del Voice Chat, atajos desde el teclado (sin DOM)
  dom.js         h() e iconos propios (la página no carga ui.js)
  i18n.js        Textos de la página (el mismo diccionario renderer/i18n/<idioma>/overlay.js)
src/renderer/styles/overlay.css           Widgets (.ovl-*), compartido por la página y la vista previa
src/renderer/js/features/overlay.js       startup() y overlayPanel() (tarjeta de Ajustes)
src/renderer/styles/features/overlay.css  Tarjeta de Ajustes (.ovp-*)
src/renderer/i18n/{es,en}/overlay.js      Textos de los widgets y de la tarjeta
```

## 2. Seguir la ventana del juego

`core/game` emite `state` con `{ state: 'running', pid }`. Para cada partida que **no** es `quiet` (las pruebas de la búsqueda del culpable de un crash no tienen overlay) se abre un ayudante (`tracker.js`), con la misma idea que `ingame/window.js`:

- `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command <script>`; el C# se compila con `Add-Type` y corre el bucle entero (sin pasar por PowerShell en cada vuelta).
- El hilo se marca **consciente de la escala por monitor** (`SetThreadDpiAwarenessContext(-4)`), así `GetClientRect` + `ClientToScreen` devuelven el **área de juego en píxeles físicos** (sin la barra de título ni los bordes) con cualquier escala de Windows.
- Busca la ventana del pid con clase `GLFW*` (1.13+) o `LWJGL` (versiones viejas); si no hay, la ventana visible sin dueño más grande de ese proceso (≥ 200×150).
- Escribe una línea JSON **solo cuando algo cambia** (y una cada 2 s para confirmar que sigue vivo): `{ ok, hwnd, fgw (ventana en primer plano), x, y, w, h, min, vis, full (ocupa todo el monitor), dpi }`, `{ ok: 0 }` mientras no hay ventana, `{ end: 1 }` al terminar.
- Sondea cada **250 ms** (unas 4 veces por segundo), cada 70 ms durante el medio segundo siguiente a un cambio (para seguir bien una ventana que se arrastra) y cada 1 s mientras todavía no hay ventana (los modpacks grandes tardan; se rinde a los 15 minutos).
- **Se apaga solo** cuando termina el proceso del juego o el del launcher (`WaitForSingleObject` sobre los dos, sin costo), y el módulo además lo cierra cuando el juego pasa a `stopped`/`crashed`, cuando se apaga el overlay y al salir del launcher.
- Medido en Windows 11: arranca en ~0,4 s, ~70 MB de memoria y ~5 ms de CPU por segundo (0,5 % de un núcleo).

El proceso principal pasa el rectángulo físico a DIP con `screen.screenToDipRect` (con respaldo propio en `geometry.physicalToDip` usando `nativeOrigin` y `scaleFactor` de cada pantalla) y hace `setBounds` solo si cambió.

**Cuándo se ve** (`geometry.decide`): overlay activado, no oculto con el atajo, ventana del juego encontrada, visible y no minimizada, y **el juego en primer plano** (o el propio overlay, en el modo edición). Si el jugador cambia a otra app, el overlay se esconde (es una ventana siempre encima: si no, taparía otras apps). En el modo edición y durante una prueba se ve siempre; sin juego, sobre el área de trabajo de la pantalla del launcher (`mode: 'screen'`). Sin juego ni prueba la ventana se esconde y se destruye al minuto.

Si se cierra la ventana principal del launcher, el overlay se destruye (si no, Electron no dispararía `window-all-closed`).

## 3. Contrato 1: eventos

Desde el proceso principal: `require('./overlay').push(evento)` → `true` o `false` (nunca lanza; un evento inválido se descarta con `console.warn('[overlay] ...')`). Desde la interfaz: `api.invoke('overlay:push', evento)` → `true` o error con `err.code = 'badEvent'`.

| Evento | Campos |
|---|---|
| `alert` | `title` (obligatorio, 120), `body?` (280), `icon?`: `info`, `friend`, `server`, `points`, `achievement`, `capture`, `music`, `party`; `ttl?` en segundos (2 a 30; un valor de más de 60 se toma como milisegundos) |
| `message` | `from` (48), `text` (400), `fromId?`, `avatar?`, `chatId?` |
| `voice` | `room: { name, code } \| null`, `self: { muted, deafened }`, `members: [{ id, name, avatar?, speaking, muted, deafened, self? }]` (hasta 16; sin sala no hay miembros) |
| `music` | `state: { title, artist, album, art, playing, position, duration, positionAt?, source, appName } \| null`. **`position` y `duration` en milisegundos** (como los manda `nowplaying.js`); `positionAt` = epoch ms en que vale `position` (la barra avanza sola). Duración 0 = sin barra (radio). Sin título = `null` |
| `capture` | `type`: `screenshot`, `clip`, `recording-start`, `recording-stop`, `replay-saved`; `path?`, `thumb?` (data: URL), `duration?` en segundos |

Validación (`events.js`): textos sin caracteres de control ni marcas de dirección, en una línea y recortados con `…`; booleanos solo `true`; imágenes solo `https:` (sin usuario ni contraseña), `data:image/(png|jpeg|webp|gif);base64` de hasta 512 KB o `assets/...` del launcher; los campos de más se descartan. La ruta de una captura no viaja a la página: solo sirve para no mostrar dos veces la misma captura (misma ruta en 5 s), porque `capture.js` la avisa por `push` y la interfaz también podría.

El proceso principal guarda lo último de **voz**, **música** y **grabación en curso** y lo manda cuando la ventana del overlay se abre (no hace falta volver a empujarlo). Durante una prueba, la voz y la música de ejemplo no pisan lo guardado: al terminar vuelve lo real.

Quién empuja qué:

- **Voz, mensajes, invitaciones y solicitudes de amistad:** `features/overlay.js` (`startup()`), solo mientras el overlay está activo. La voz se junta y se manda **como mucho 5 veces por segundo y solo si cambió algo** (`logic.createLimiter` + `createChangeGate`; `voice.members` ya trae `speaking` en vivo). Un mensaje de la conversación que está abierta y con foco en el launcher no se avisa.
- **Música:** `nowplaying.js` (agente A), solo si el usuario dejó la música en el overlay en su tarjeta. El overlay no se suscribe a `nowplaying.events` para respetar ese ajuste.
- **Capturas, clips y grabación:** `capture.js` (agente C), respetando su ajuste de avisos.
- **Logros y Venus Points:** `rewards` (agente E).
- **Servidores locales y tareas largas:** el propio módulo, solo mientras se juega: servidor listo, servidor que se cerró por un error, jugador que entra, y tareas de 10 s o más que terminan o fallan.

## 4. Página del overlay

`renderer/overlay.html` con CSP `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; font-src 'self'; connect-src 'none'; ...` (sin red, sin nada en línea). Ventana con `sandbox`, `contextIsolation`, sesión propia en memoria (`partition: 'venus-overlay'`) que niega todos los permisos, sin navegación ni ventanas nuevas.

Preload (`overlay/preload.js`) → `window.overlayBridge`: `onLayout(fn)`, `onEvent(fn)`, `ready()` y, para el modo edición, `move(id, { anchor, x, y })`, `reset()`, `done()`. **No hay invoke genérico**: la página no llega a ningún canal del launcher. Los mensajes van por `ipcMain.on('overlay:page')` y el módulo revisa que vengan de la ventana del overlay (`event.sender.id`); `move` y `reset` solo se aceptan en el modo edición y pasan por `config.positionPatch`.

Layout que manda el proceso principal: `{ lang, accent, motion ('auto'|'on'|'off' de settings.a11y.reduceMotion), editing, mode ('game'|'screen'), shortcut, widgets }`.

`OverlayView` (`widgets.js`) mantiene cada widget en un contenedor estable: los anclados van a una de las 9 celdas (varios en la misma celda se apilan en orden fijo: voz, mensajes, avisos, capturas, música) y los libres a una capa aparte con `left`/`top` en porcentaje. Todo se mide en **fracciones del área del juego** (`layout.js`): una posición libre `(x, y)` es la fracción del espacio que queda dentro de los márgenes (1,25 % del ancho, 2 % del alto), así un widget nunca se sale y el lugar se mantiene con cualquier tamaño de ventana, escala de Windows o tamaño del widget. La escala usa `zoom` (afecta el layout, así los widgets apilados no se pisan).

- Avisos: hasta 3 a la vez, el resto en cola (hasta 20); duración = `ttl` del evento o la de Ajustes. Mensajes: los 3 últimos. Capturas: las 2 últimas + la píldora "Grabando 1:23" mientras dura la grabación. Música: mientras suena (en pausa se va a los 6 s) o solo 8 s al cambiar de canción.
- Un solo temporizador (el vencimiento más cercano, o cada segundo si hay un reloj en pantalla).
- Movimiento: entradas y salidas solo con `opacity`/`transform`; nada con `.ovl-reduce` (Ajustes > Accesibilidad o la preferencia de Windows).
- Nada depende solo del color: quien habla tiene anillo **y** ícono de volumen; silenciado y sin sonido llevan ícono con `aria-label`.

**Modo edición** (`overlay:edit(true)`): el launcher se minimiza (si hay juego), la ventana acepta mouse y foco, se oscurece un poco el juego y aparecen las guías de la grilla y una barra con Restablecer y Listo. Se arrastra cada widget; al soltarlo cerca de una posición de la grilla se ancla ahí (`layout.snap`), si no queda libre. Teclado: Tab entre widgets, flechas (Mayús: pasos de 5 %), 1 a 9 (teclado numérico: 7 8 9 arriba) para la grilla, Enter o Escape para terminar. Cada cambio se guarda en `settings.overlay.widgets.<id>`. Se apaga solo a los 15 minutos, al cerrar el juego o con el atajo.

## 5. Ajustes (`settings.overlay`)

```js
overlay: {
  enabled: true,                 // overlay activado
  shortcut: 'Alt+Shift+O',       // mostrar u ocultar ('' = sin atajo)
  widgets: {
    voice:    { enabled, anchor, x, y, scale, opacity, theme, show: 'all' | 'speaking' },
    messages: { enabled, anchor, x, y, scale, opacity, theme, hideContent: false, duration: 8 },
    alerts:   { enabled, anchor, x, y, scale, opacity, theme, duration: 6, filter: { launcher, friends, servers, rewards } },
    captures: { enabled, anchor, x, y, scale, opacity, theme, duration: 5 },
    music:    { enabled, anchor, x, y, scale, opacity, theme, show: 'always' | 'change' },
  },
}
```

`anchor`: `tl`, `tc`, `tr`, `ml`, `mc`, `mr`, `bl`, `bc`, `br` o `free` (usa `x`, `y` de 0 a 1). `scale` 0,6 a 1,6; `opacity` 0,3 a 1; `theme` `dark`, `light` o `accent` (el color de acento del launcher, que manda `features/overlay.js` con `overlay:accent`); `duration` 2 a 30 s. Por defecto: voz arriba a la izquierda, mensajes al medio a la izquierda, avisos arriba a la derecha, capturas y música abajo a la derecha. `nowplaying.js` lee `settings.overlay.enabled` y `settings.overlay.widgets.music.enabled` para decidir si deja vivo su ayudante durante el juego.

**Atajo global:** se registra **solo mientras hay un juego abierto** (y el overlay activado), para no robarle la combinación a otras apps el resto del tiempo. `overlay:setShortcut(accel)` lo prueba registrándolo: si otra app (o el atajo de silenciar del Voice Chat) lo usa, devuelve `{ ok: false, code: 'taken' }` y no lo guarda; con formato inválido, `code: 'invalid'`. Formato de Electron con al menos un modificador (o F13 a F24 solas). Durante el modo edición el atajo lo termina.

## 6. Canales

| Canal | Qué hace |
|---|---|
| `overlay:push(evento)` | Contrato 1 desde la interfaz → `true` (`err.code 'badEvent'`) |
| `overlay:status()` | `{ supported, enabled, active, running, found, fullscreen, minimized, visible, hidden, editing, testing, mode, shortcut, shortcutOk, config, defaults }` |
| `overlay:edit(bool)` | Abre o cierra el modo edición → status |
| `overlay:test([eventos])` | Muestra el overlay 9 s (sobre el juego o la pantalla) con hasta 12 eventos de ejemplo → status |
| `overlay:reset()` | Posiciones de fábrica → status |
| `overlay:setShortcut(accel)` | `{ ok, shortcut, code? }` |
| `overlay:accent('#rrggbb')` | Color del tema "Acento" → `true`/`false` |
| evento `overlay:state` | Lo mismo que status sin `config` ni `defaults`, cuando cambia |
| evento `overlay:config` | La configuración normalizada cada vez que cambia (por ejemplo, al mover un widget en el juego) |

## 7. Probar

```bash
node --test "src/main/modules/overlay/test/"        # 32 pruebas: config, eventos, geometría (DPI), layout, límite, ayudante
```

Con capturas de desarrollo (`scripts/devshot.js`), `VENUS_OVERLAY_FAKE_PID=<pid>` (solo con `VENUS_DEVSHOT` y sin empaquetar) trata la ventana de ese proceso como si fuera el juego: sirve con cualquier ventana propia (por ejemplo un formulario de PowerShell). Desde la consola de la interfaz: `venus.invoke('overlay:test', [...])`, `venus.invoke('overlay:edit', true)`.

## 8. Paneles, contadores y marcadores de 4.5.0

Implementados en la rama, sin publicar. [Contrato completo](implementacion/overlay.md): conserva las tablas de comandos del puente, eventos, canales, atajos, archivos y límites.

| Función | Comportamiento y límite |
|---|---|
| Paneles interactivos | Recetas y asistente activan temporalmente interacción y foco; cerrar restaura el modo del overlay. Los atajos se configuran mediante `overlay:setPanelShortcut`; la vuelta de foco con Minecraft real sigue pendiente. |
| Recetas | Lectura local de JSON del juego desde 1.12 y hasta 500 JAR de mods; sin datapacks del mundo, JAR anidados ni recetas creadas por código. Las condiciones del mod no se evalúan. |
| Wiki | `privacy.wiki`, apagado por defecto y visible en el aviso de conexiones. El principal construye una dirección de Minecraft Wiki a partir del ítem; abre el navegador. |
| Contadores | Las estadísticas de mundos locales se revisan cada 5 s y cambian cuando el juego guarda. En multijugador no hay archivo de bloques; las muertes dependen de los mensajes reconocidos del registro. |
| Marcadores | `venus-markers.json` del mundo: hasta 1000; código compartible de hasta 200 y 12 000 caracteres. Datos validados y nombres presentados como texto. |
| Asistente | Mismos permisos, plan, conversación y confirmaciones del launcher. `features/overlaytools.js` transmite eventos a través de `overlay:assistantEvent`; no habilita modificar una instancia en ejecución. |
| FPS | El mod escribe `venus/perf.json` cada 2 s en una partida sin pausa; a los 10 s el dato vence. Ausencia o vencimiento se muestran sin inventar una medición. |

Stickers y GIF usan un texto de aviso específico en vez de su URL. La compilación de cuatro variantes del mod fue informada como exitosa, pero no valida el overlay ni los FPS en Minecraft. Estado general y comprobaciones externas: [estado-4.5.0.md](estado-4.5.0.md).

### Evidencia de integración del 3 de noviembre de 2026

Capturas ES/EN en ventana oculta con JAR de recetas sintético propio y asistente falso. La integración principal revisó recetas ES y asistente EN y los informó correctos: consola principal vacía, sin log adicional de errores del overlay. Artefactos: `shots-overlay-es/` y `shots-overlay-en/`, bajo `%TEMP%/venus-codex-review-20261103/`. No valida superposición ni foco con Minecraft real. [Detalle permanente](implementacion/overlay.md).

## 9. Auditoría y mejoras de la 4.6

Sin migraciones ni RPC; `settings.overlay` no suma claves (los `panelShortcuts` repetidos con `shortcut` se normalizan al leer). Se probó con pruebas puras, con un entorno falso de Electron (`modules/overlay/test/harness.js`) y con la ventana de desarrollo (`overlay/dev.js`); **no** con Minecraft real ni con monitores de distinta escala.

**Qué se ve distinto.** La tarjeta de Ajustes → En el juego dice en una línea qué pasa (`Activo`, `Listo`, `Apagado`, `Editando`, `Buscando`, `Con error`, con qué probar). En la vista previa, tocar un widget lo elige (los apagados se ven tenues), cada uno tiene **Restablecer este widget**, el encabezado tiene **Restablecer todos** (con confirmación) y hay atajos de teclado para mover (flechas), llevar a la grilla (`1` a `9`), tamaño (`+`/`-`), opacidad (`[`/`]`) y ocultar (`Supr` o `H`). En el juego, los widgets apagados aparecen como fantasmas mientras se edita. Los errores se entienden: el asistente dice enseguida que necesita internet y una lectura de recetas lenta dice "está tardando demasiado (hay muchos mods)".

**Atajos.** Funcionan solo con el juego (o un panel del overlay o la edición) adelante. Al cambiarlos, el proceso principal rechaza con un código: `minecraft` (solo Ctrl y/o Mayús), `altgr` (Ctrl+Alt con una tecla que se escribe), `system` (Alt+F4, Alt+Tab, Ctrl+Mayús+Esc…), `venus` con `who` (`voice`, `capture`, `music` u `overlay`; las teclas se comparan sin importar el orden) y `taken` (otra aplicación lo tiene; se prueba registrándolo). Los ya guardados que caen en `minecraft`, `altgr` o `system` no se tocan pero la tarjeta los marca.

**Bugs corregidos (31).** Los más importantes: el medidor de rendimiento seguía vivo con el overlay apagado u oculto; si el ayudante que sigue la ventana del juego no abría (antivirus, PowerShell bloqueado) no se reintentaba; los atajos globales estaban tomados todo el tiempo que había un juego abierto; `overlay:setShortcut` con algo que no es texto borraba el atajo; dos atajos iguales se aceptaban; un atajo tomado por otra aplicación se reintentaba en cada línea del ayudante (ahora cada 5 s); una página que no avisaba `ready` dejaba una ventana transparente encima del juego (se descarta y se rearma a los 10 s); una página colgada con un panel abierto dejaba el mouse tomado; mantener una flecha apretada guardaba los ajustes 30 veces por segundo; leer recetas de cientos de mods no tenía techo (ahora tiene presupuesto y avisa `modsPending`); una excepción al dibujar dejaba la página sorda; las nueve posiciones eran cajas independientes que se pisaban (ahora son celdas de una grilla); la página seguía con temporizadores con la ventana escondida. Cada uno tiene su prueba, salvo `loadFile().catch` y los eventos de Electron, que no se pueden forzar sin Electron.

**Contratos.** `overlay:status` suma `tracker`, `pageFailed`, `shortcutIssue` y `panelShortcutIssues`; `overlay:setShortcut` y `overlay:setPanelShortcut` suman los códigos de arriba; página → principal (`overlay:page`) suma el mensaje `tweak { id, patch: { enabled?, scale?, opacity? } }` y principal → página (`overlay:event`) suma `{ kind: 'shown', shown }` (interno); `recipes.open` acepta `budgetMs` (solo pruebas) y la sesión trae `info.modsPending`. `module.exports` de `overlay.js` sigue siendo `{ register, push, status }`. La ventana de desarrollo acepta `venus.invoke('overlay:dev', 'hold', '1366x768')`. El overlay ya no sabe nada del modo streamer ni de OBS.

**Textos.** Namespaces `overlay` e `overlaytools` (interfaz) y `overlay` (principal, `errOffline`) en es y en; los otros 12 idiomas quedan sin las claves nuevas.

**Límites.** Sin probar: el overlay encima del juego real en ventana, sin bordes y pantalla completa (la exclusiva no se ve, límite de Windows), el robo y devolución real del foco, monitores de distinta escala, un PowerShell bloqueado por política, cientos de mods reales y conflictos con atajos de otras aplicaciones (la lista de teclas de Minecraft es la de las teclas por defecto).
