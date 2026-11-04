# Overlay y mapa: recetas, contadores, marcadores y asistente

> **Rama 4.5.0, sin publicar.** Consolidación documental del 3 de noviembre de 2026, reconciliada con el WIP congelado. Los informes de cada frente se conservan como antecedentes; las pruebas posteriores están atribuidas al final o en el estado de integración. Contratos y límites del código local; producción continúa hasta 0027 según la integración principal. Los resultados previos pertenecen a sus informes y no equivalen a pruebas externas repetidas ni a un despliegue. Ver [estado de integración](../estado-4.5.0.md).

Referencia de los paneles, eventos, recetas y marcadores. Ver también [overlay](../overlay.md) y [arquitectura](../arquitectura.md).

## Cómo se usa

- **Panel de recetas** (`Alt+Shift+R`) y **panel del asistente** (`Alt+Shift+A`): se abren con su atajo mientras se juega. La ventana del overlay toma el mouse y el teclado, y **Esc** (o el mismo atajo, o la X) vuelve al juego. Los atajos se cambian o se quitan en Ajustes > En el juego > Overlay, sección "Paneles en el juego".
- **Recetas:** buscador de ítems (por nombre en el idioma del juego, en inglés o por id, sin importar acentos), ficha de cada ítem con "Cómo se hace" y "En qué se usa", y clic en cualquier ingrediente para ir a su ficha. **Abrir en la wiki** busca en `minecraft.wiki` con el navegador; la primera vez pide activar la conexión opcional.
- **Contadores en pantalla:** widget `counters` (abajo a la izquierda, debajo de Rendimiento), con muertes, bloques minados y tiempo de sesión. Se mueve, se oculta y se ajusta como los demás.
- **FPS en Rendimiento:** el widget `perf` suma los FPS, que informa el mod Venus Badge. Sin el mod, el valor es `—` y el tooltip lo explica.
- **Marcadores:** en el Mapa del mundo, botón **Marcadores** en la barra de herramientas o **clic derecho** en el mapa. Nombre, color, ícono y coordenadas, por mundo y dimensión. Lista con buscador, ir al marcador, editar y borrar. **Compartir** arma un código `VENUS-MARKERS:…` de un marcador o de la lista, para copiar o mandar por Mensajes; el otro lo pega en **Importar**, ve qué trae y recién ahí lo agrega.

## Archivos

```
src/main/modules/recipes.js               Sesiones de recetas por versión, caché en disco, canales recipes:*
src/main/modules/recipes/
  parse.js       Formatos de las recetas (1.12 a 1.21.2+), ingredientes, tags, nombres (sin archivos)
  jar.js         Lee recetas, tags, nombres e iconos de un .jar con ZipReader
  book.js        Junta las fuentes y responde búsquedas y fichas (sin archivos)
  test/          Con .jar de prueba armados con adm-zip, formatos viejos y nuevos
src/main/modules/overlay.js               Paneles, atajos de paneles, contadores por partida, FPS, relevo del asistente
src/main/modules/overlay/
  counters.js    Estadísticas del juego, la cuenta desde el arranque, muertes sin repetir, seguimiento del archivo
  panels.js      Lista cerrada de pedidos de la página, por qué no contesta el asistente, eventos limpios
  dev.js         Solo capturas de desarrollo: la página en una ventana oculta (VENUS_DEVSHOT y sin empaquetar)
  tracker.js     El ayudante ahora recibe "front <hwnd>" por su entrada
src/main/modules/mapviewer/markers.js     Validación, venus-markers.json y códigos para compartir
src/renderer/js/overlay/
  panels.js, panel-recipes.js, panel-assistant.js, minimd.js, counters.js
src/renderer/js/features/overlaytools.js  Relevo de eventos del asistente, rutas que pide un panel, tarjeta de la wiki
src/renderer/js/features/overlaytools/markers-ui.js   Panel de marcadores del mapa
src/renderer/styles/features/overlaytools.css         Marcadores (.wmk-*)
src/renderer/styles/overlay.css           Paneles (.ovl-panel*, .ovr-* recetas, .ova-* asistente)
src/renderer/i18n/{es,en}/overlaytools.js Paneles (pn_, rc_, as_), wiki (wiki_) y marcadores (mk_)
```

## Paneles: modo interactivo y seguridad

`overlay.js` tiene `st.panel` (`null`, `'recipes'` o `'assistant'`). Con un panel abierto, `geometry.decide` muestra la ventana aunque esté oculta con el atajo, y `evaluate` la pone interactiva (`setInteractive`, lo mismo que el modo edición). Al abrir se pide el foco. `win.isFocused()` no sirve para saber si lo tiene (Electron dice que sí aunque Windows no la haya puesto adelante): lo que vale es la ventana de adelante que informa el ayudante. Con el atajo global Windows lo da enseguida; si no, a los 700 ms el ayudante insiste con `front` y a los 1,8 s el panel se cierra con un aviso, porque una ventana que toma el mouse sin tener el teclado dejaría al jugador trabado.

Al cerrar, Windows le da el foco a la ventana que sigue en el orden, que puede ser la barra de tareas u otra cosa que esté siempre encima (lo mismo que pasaba al salir del modo edición). Por eso `returnToGame` le pide el juego al ayudante a los 60 ms y otra vez a los 450 ms. Si Windows no lo deja, el jugador tiene que hacer clic en el juego: no queda nada trabado. El juego puede quedar en su menú de pausa, porque se pausa solo al perder el foco (es la opción `pauseOnLostFocus`).

El panel se cierra solo y deja pasar los clics de nuevo:

- con **Esc**, con su atajo o con la X,
- si el jugador se va a otra ventana (`blur`),
- si el juego se minimiza, se cierra o deja de verse (`checkPanelGame`),
- a los 15 minutos sin usarlo,
- al entrar al modo edición, al abrir la wiki o al pedir una pantalla del launcher.

**Pantalla completa.** GLFW minimiza el juego en pantalla completa cuando pierde el foco, y desde afuera no se distingue de una ventana sin bordes (las dos ocupan todo el monitor). Por eso se prueba: si al abrir un panel el juego se minimiza, el ayudante lo restaura, se avisa con F11 y en esa partida no se intenta más. Con ventana sin bordes, el panel anda.

**Permisos de la ventana:** no cambian. `sandbox`, `contextIsolation`, sesión propia en memoria que niega todo, sin navegación ni ventanas nuevas, CSP sin red. El preload suma tres cosas: `onPanel`, `closePanel` y `panel(pedido)`.

`panel(pedido)` es el único camino hacia afuera (`ipcMain.handle('overlay:panel')`). Se revisa que venga de la ventana del overlay (`event.sender.id`), que haya un panel abierto y que el pedido pase `panels.cleanRequest`:

| Acción | Campos | Qué hace |
|---|---|---|
| `recipes.info` | | Versión, mods y si la wiki está permitida |
| `recipes.search` | `query` (80) | Hasta 60 ítems con su icono |
| `recipes.item` | `id` | Ficha del ítem |
| `recipes.wiki` | `id` | Abre `minecraft.wiki` con el navegador. La página nunca manda una dirección: se arma acá con un ítem del juego |
| `recipes.wikiAllow` | | `settings.privacy.wiki = true` |
| `assistant.open` | | Conversación y por qué no puede contestar |
| `assistant.send` | `text` (8000) | `modules/assistant.send`, con la instancia de la partida |
| `assistant.cancel` / `assistant.new` | | Detener y empezar otra |
| `assistant.confirm` | `requestId`, `approved` | Responde una confirmación. "Permitir siempre" no se ofrece: se elige en el launcher |
| `launcher.open` | `route` | Abre el launcher en una de cuatro pantallas fijas (`panels.ROUTES`) |
| `panel.switch` | `id` | Cambio de pestaña |

## Recetas

`recipes.open({ rootId, instanceDir, lang, assetIndex, mods })` lee `versions/<rootId>/<rootId>.jar`, los `.jar` activos de `mods/` y el idioma del juego de los assets (el `.jar` del cliente solo trae inglés). Guarda por `.jar` un par de archivos en `<datos>/cache/recipes/` (`mods/` para los mods): el nombre lleva la versión o el mod y un hash del tamaño y la fecha, así que la primera vez tarda y después es inmediato. Los iconos quedan en su propio archivo y se leen cuando hacen falta. **Nada de Mojang va en el repositorio.**

Se usa `ZipReader` (`modtranslate/zip.js`) en vez de adm-zip: adm-zip carga los 40 MB del cliente de una vez y traba el proceso principal casi un segundo (el mismo motivo que da `capture/gamelang.js`), justo mientras se juega. Las pruebas arman los `.jar` con adm-zip.

Probado de solo lectura con los `.jar` reales de 1.20.1, 1.21.11 y 26.1.2: lee casi todas las recetas (en 26.1.2, 1466 de 1515; las que faltan son de los tipos especiales de abajo) en unos 700 ms la primera vez y 40 ms desde la caché, con textura para todos los ítems salvo unos 35 (estandartes, cabezas y estatuas, que se dibujan por código y usan sus iniciales). Con el índice de assets, los nombres salen en el idioma del juego.

Formatos: `crafting_shaped`, `crafting_shapeless`, `crafting_transmute`, `crafting_dye`, `crafting_imbue`, `smelting`, `blasting`, `smoking`, `campfire_cooking`, `stonecutting`, `smithing_transform`, `smithing`. Tipos de mods con los campos de siempre (`ingredients`, `result`): una lista de ingredientes con el nombre del tipo.

Límites:

- **Antes de la 1.12** el juego no trae recetas en JSON: el panel lo dice.
- **Con 1.12**, los nombres no salen de las claves del juego (`tile.wood.oak.name`): se muestran a partir del id.
- `crafting_special_*`, `crafting_decorated_pot` y `smithing_trim` no se muestran: no tienen ingredientes en sus datos, las hace el código del juego.
- **Mods:** se leen sus recetas, tags, nombres e iconos, hasta 500 `.jar`. Un `.jar` que no se puede leer se cuenta y se sigue. No se leen los `.jar` dentro de otro `.jar` ni las recetas que un mod arma por código (KubeJS, CraftTweaker). Las condiciones (`fabric:load_conditions`, `neoforge:conditions`) no se evalúan: una receta condicionada aparece igual.
- **Datapacks del mundo:** no se leen.
- Un bloque con modelo especial (cofre, cama) usa la textura que encuentra en su modelo o, si no hay, sus iniciales.

**Conexión opcional:** `settings.privacy.wiki`, apagada por defecto. Está incluida en el aviso general de `features/netprefs.js`, tiene tarjeta propia en Ajustes → Privacidad y activación desde el panel.

## Contadores

`createWatch` corre por partida desde que arranca el juego, aunque el widget esté oculto. Cada 5 s mira la fecha de `saves/<mundo>/stats/<uuid>.json` (el de la cuenta o, si no está, el más reciente) y lo lee solo si cambió. La primera lectura de cada mundo es la foto inicial, así lo de antes no suma; si no hay archivo (mundo nuevo), la foto es cero.

Muertes en vivo con `capture/gamelog.js` (mismo lector y mismo caché de textos que los clips automáticos). En un mundo propio la misma muerte aparece por el servidor y por el chat: se cuenta una cada 2 s. Por mundo, `muertes = max(registro, archivo)`, así el guardado no las cuenta de nuevo.

Límites: los bloques cambian cuando el juego guarda (cada pocos minutos o al pausar). En multijugador no hay archivo: solo las muertes del chat, los bloques muestran `—` y el tooltip lo aclara. Un servidor con mensajes de muerte propios no se reconoce.

## Marcadores

`<mundo>/venus-markers.json`: `{ v: 1, markers: [{ id, name, color, icon, dimension, x, y, z, createdAt }] }`. El juego no mira archivos que no conoce. Hasta 1000 por mundo.

Código: `VENUS-MARKERS:<base64url de { v: 1, m: [[nombre, color, icono, dimension, x, y, z], ...] }>`. Hasta 200 marcadores y 12 000 caracteres; si pasa los 2000 de un mensaje, se avisa y solo se copia. Se puede pegar con texto alrededor. Todo lo que viene en un código se valida: nombre sin caracteres de control ni marcas de dirección y de hasta 48, color `#rrggbb`, ícono de la lista, dimensión con su formato y sin `..`, coordenadas dentro del borde del mundo. Lo que no cumple se descarta y se cuenta. El nombre se dibuja siempre como texto, nunca como HTML. Lo importado no repite lo que ya está (mismo nombre, dimensión y lugar).

## Asistente

Es `modules/assistant` tal cual: misma conversación (retoma la que corre o la de las últimas 6 horas, como el panel lateral), mismos permisos, mismo plan y mismo motor, sin selector de modelo. Los cambios sobre la instancia abierta los sigue rechazando el asistente.

El asistente solo le habla a la ventana principal (`send` de `ipc.js`), así que `features/overlaytools.js` le pasa los eventos al overlay (`overlay:assistantEvent`) mientras el overlay está activo, igual que la voz y los mensajes. `panels.cleanEvent` deja solo lo que se dibuja.

"Streaming como en la página": los mismos eventos (`turn-start`, `thinking`, `text`, `tool-start`, `tool-result`, `confirm`, `error`, `done`). La página tampoco recibe el texto de a pedazos: llega por bloque.

Sin plan, sin sesión, con la IA apagada, sin cuota o sin internet, el panel dice por qué y ofrece abrir esa pantalla del launcher. Con el panel cerrado, un aviso cuando el asistente contesta o pide una confirmación. Deshacer sigue en la ventana del launcher: el panel lo menciona. Una confirmación pendiente también abre el panel lateral del launcher, como siempre; se puede responder en cualquiera de los dos.

## Canales y ajustes

| Canal | Qué hace |
|---|---|
| `overlay:setPanelShortcut(id, accel)` | `{ ok, shortcut, code? }` (`'invalid'`, `'taken'`) |
| `overlay:assistantEvent(conversación, evento)` | La interfaz le pasa los eventos del asistente al overlay |
| evento `overlay:route` | Un panel pidió una pantalla del launcher |
| `recipes:search(instanceId, texto)`, `recipes:item(instanceId, id)` | Recetas sin partida abierta (hoy no las usa ninguna pantalla) |
| `mapviewer:markers`, `markerSave`, `markerDelete`, `markersEncode`, `markersDecode`, `markersImport` | Marcadores (ver la cabecera de `mapviewer.js`) |
| `overlay:dev(comando, arg)` | Solo con `VENUS_DEVSHOT` y sin empaquetar (ver `overlay/dev.js`) |

`overlay:status` suma `panel`, `panelShortcuts` y `panelShortcutsOk`.

Ajustes: `overlay.panelShortcuts: { recipes, assistant }` (`''` = sin atajo), `overlay.widgets.counters: { ..., show: { deaths, mined, session } }`, `overlay.widgets.perf.show.fps`, `privacy.wiki`.

Eventos del contrato 1: `{ kind: 'counters', deaths, mined, session, multiplayer }` y `fps` opcional en `perf`.

## Probar

```bash
node --test "src/main/modules/overlay/test/" "src/main/modules/recipes/test/" "src/main/modules/mapviewer/test/"
```

Sin juego, la página en una ventana oculta (no se muestra ni toma el foco), con capturas en `VENUS_DEVSHOT`:

```js
await venus.invoke('overlay:dev', 'hold');
await venus.invoke('overlay:dev', 'panel', 'recipes');   // con VENUS_RECIPES_DEV_JAR=<un .jar>
await venus.invoke('overlay:dev', 'shot', 'recetas');
```

`VENUS_ASSISTANT_FAKE=1` o `=noplan` para el asistente. Con `VENUS_OVERLAY_FAKE_PID=<pid>`, `'open'` y `'info'` usan el camino de verdad (toma el foco).

## Validación posterior de integración · 3 de noviembre de 2026

La integración principal capturó los paneles en **ES/EN**, en ventana oculta, con un **JAR sintético propio** para recetas y asistente falso. Informó revisión visual correcta de recetas en español y asistente en inglés. Las consolas principales están vacías y no se generó un log adicional de errores del overlay. Evidencia: `%TEMP%/venus-codex-review-20261103/shots-overlay-es/`, `shots-overlay-en/` y `recipes-synthetic.jar`.

No se usaron archivos de Mojang en esta comprobación. Los antecedentes con JAR de otras revisiones no se repitieron. Sigue pendiente el overlay sobre Minecraft real y la vuelta del foco. La evidencia de los demás recorridos está en [estado de integración](../estado-4.5.0.md).
