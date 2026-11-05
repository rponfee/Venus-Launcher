# Overlay 4.6: auditoría de calidad y mejoras de uso

> Rama 4.6, sin publicar. Agente J. Pedido del dueño: "mejorar el overlay (sin bugs)". Contratos de base: [overlay.md](../overlay.md) y [implementacion/overlay.md](../implementacion/overlay.md). Esto describe **solo lo que cambia** en la 4.6.

No se probó con Minecraft real (la PC de pruebas no tiene ni el juego ni varios monitores con escalas distintas). Todo lo que depende de eso está marcado en la sección [Lo que no se pudo probar](#lo-que-no-se-pudo-probar); lo demás se probó con pruebas puras, con un entorno falso de Electron (`test/harness.js`) y con la ventana de desarrollo del overlay (`overlay/dev.js`).

## 1. Cómo se usa lo nuevo

- **Estado visible.** La tarjeta de Ajustes > En el juego dice en una línea qué pasa: `Activo`, `Listo`, `Apagado`, `Editando`, `Buscando` ("Juego no detectado todavía…", con el aviso de que los modpacks grandes tardan) o `Con error` (el ayudante que sigue la ventana del juego no se pudo abrir, por ejemplo con PowerShell bloqueado por un antivirus, o la ventana del overlay no pudo abrirse). Si falla, el texto dice qué probar.
- **Editor de widgets.**
  - En la vista previa, **tocar un widget lo elige**: se marca con un borde y se abren sus opciones debajo. Los widgets apagados se ven **tenues y con borde punteado** (se sabe dónde están y se los puede mover o volver a prender).
  - Cada widget tiene **Restablecer este widget** (posición, tamaño, opacidad, tema y opciones; no lo prende ni lo apaga) y el encabezado de Widgets tiene **Restablecer todos** (con confirmación). **Restablecer posiciones** sigue siendo solo de lugares.
  - El resumen de cada widget dice posición, tamaño y opacidad. Tamaño y opacidad se ven en vivo en la vista previa mientras se arrastra el deslizador.
  - **Teclado** (en la vista previa y en el modo edición dentro del juego), con el widget elegido (Tab): flechas lo mueven (Mayús, más lejos), `1` a `9` lo llevan a la grilla, `+` y `-` cambian el tamaño, `[` y `]` (o `Re Pág` y `Av Pág`; los corchetes salen con AltGr en el teclado en español y también andan) la opacidad, `Supr` (o `H`) lo oculta o lo muestra.
  - En el juego, los widgets apagados aparecen como fantasmas mientras se edita, así se pueden volver a prender sin salir al launcher.
- **Atajos.** Funcionan **solo con el juego (o el overlay en un panel o en edición) adelante**: con otra aplicación adelante no se le roba la combinación. Al cambiar un atajo, el proceso principal rechaza, con su motivo:
  - `minecraft`: solo Ctrl y/o Mayús (correr, agacharse, soltar, chat);
  - `altgr`: Ctrl+Alt con una tecla que se escribe (es AltGr en muchos teclados: arroba, barra invertida);
  - `system`: combinaciones de Windows (Alt+F4, Alt+Tab, Alt+Enter, Ctrl+Mayús+Esc…);
  - `venus` con `who`: ya lo usa el silencio del Voice Chat (`voice`), las capturas y la grabación (`capture`), los atajos de música (`music`, solo si están activados) u otra función del overlay (`overlay`; las teclas se comparan sin importar el orden ni los sinónimos: `Shift+Alt+F9` es `Alt+Shift+F9`);
  - `taken`: otra aplicación lo tiene tomado (se prueba registrándolo).

  Los atajos que ya estaban guardados y caen en `minecraft`, `altgr` o `system` no se tocan, pero la tarjeta los marca con una advertencia. Si el juego no pudo tomar un atajo (lo usa otra aplicación), la tarjeta lo avisa también para los atajos de los paneles, y no se reintenta en cada vuelta sino cada 5 s.
- **Errores que se entienden.** Sin conexión, el asistente del panel lo dice enseguida (sin esperar a la nube) y enviar un mensaje da "El asistente necesita internet…". Una lectura de recetas que tarda más de 90 s dice "está tardando demasiado (hay muchos mods)". Un panel que no consigue el teclado se cierra con el aviso de siempre.

## 2. Bugs encontrados y su estado

Líneas = código **antes** de los cambios (commit base de la 4.6). "Prueba" = prueba que falla sobre el código viejo y pasa sobre el nuevo (`VENUS_OVERLAY_FILE=overlay.old.js node --test test/module.test.js` contra una copia del `overlay.js` viejo dio **19 de 29 fallando**; sobre el nuevo, 29 de 29).

| # | Dónde (antes) | Qué pasaba | Estado |
|---|---|---|---|
| B01 | `overlay.js:248-262` (`evaluate`) | Con el overlay apagado en Ajustes y un juego abierto, el medidor de rendimiento seguía vivo: un PowerShell midiendo cada 2 s y el ping al servidor cada 10 s, para nadie (`syncPerf` solo se llamaba por el camino "se muestra"). | Corregido. Prueba. |
| B02 | `overlay.js:298` (`perfWanted`) | Oculto con el atajo, el medidor seguía igual (CPU con el overlay oculto). Ahora se corta y vuelve a los 2 s al mostrarlo. | Corregido. Prueba. |
| B03 | `perf.js:174` | Si el PowerShell del medidor no abría o se caía, el medidor quedaba muerto (el error de `spawn` es asíncrono y nunca se pasaba a `pidusage`) y `syncPerf` no lo reiniciaba. Ahora pasa a medir con `pidusage`; si el juego terminó (línea de fin) se corta. | Corregido. Prueba. |
| B04 | `overlay.js:426-442`, `tracker.js:193` | Si el ayudante que sigue la ventana del juego terminaba mal (no abrió, antivirus, política que bloquea PowerShell), no se reintentaba y la tarjeta decía "Buscando la ventana…" para siempre. Ahora se reabre hasta 3 veces (1, 3 y 8 s; el contador vuelve a cero si anduvo) y `overlay:status` trae `tracker: 'off' \| 'starting' \| 'ok' \| 'failed'`. | Corregido. Pruebas. |
| B05 | `tracker.js:189` | Después de `stop()`, una línea que ya estaba en el buffer igual llamaba a `onUpdate`: el módulo creía que el juego seguía visible aunque el ayudante estuviera apagado. | Corregido. Prueba. |
| B06 | `tracker.js:193` | `exit` puede llegar antes que la última línea `{"end":1}` del ayudante: se confundía el cierre normal con una caída (visto al arreglar B04). Ahora se usa `close` y un margen de 300 ms para `exit`. | Corregido. Prueba. |
| B07 | `overlay.js:514-558` | Los atajos globales estaban registrados todo el tiempo que había un juego abierto, aunque el jugador estuviera en el navegador o en otra aplicación: se le sacaba la combinación. Ahora se arman solo con el juego (o el overlay) adelante (`geometry.gameInFront`; sin noticias de la ventana se supone que sí, para no quedarse sin atajo). | Corregido. Prueba. |
| B08 | `overlay.js:566-614` | Cambiar un atajo no miraba los paneles al revés ni los de capturas, Voice Chat o música (se descubría en la partida, en silencio, con `shortcutOk: false`), ni avisaba de combinaciones que le rompen el teclado a Minecraft o a AltGr. | Corregido. Pruebas. |
| B09 | `overlay.js:597` | `overlay:setShortcut(42)` (algo que no es texto) **borraba** el atajo. Ahora responde `invalid`. | Corregido. Prueba. |
| B10 | `config.js:102` | `normalize` dejaba pasar dos atajos iguales (por ejemplo el de las recetas igual al principal): solo el primero se registraba. Ahora gana el de arriba y el otro queda sin atajo. | Corregido. Prueba. |
| B11 | `overlay.js:514` | Un atajo tomado por otra aplicación se volvía a registrar en **cada línea** del ayudante (hasta 14 por segundo mientras se arrastra la ventana). Ahora cada 5 s. | Corregido. Prueba. |
| B12 | `overlay.js:248`, callbacks | Un error dentro de `evaluate` (por ejemplo `setBounds` de una ventana que acaba de morir) salía por el callback del ayudante, de los ajustes o de un temporizador: error sin atender en el proceso principal. Ahora `evaluate`, los callbacks, los atajos y los temporizadores van en `guard()` (se avisa una vez cada 30 s y no se propaga). | Corregido. Prueba. |
| B13 | `window.js:53` | `win.loadFile()` devuelve una promesa que se rechaza si se destruye la ventana mientras carga (o falta el archivo): error sin atender. | Corregido (`.catch`). Sin prueba posible sin Electron; razonado con el contrato de `loadURL`. |
| B14 | `overlay.js:161-190` | Si la página no avisaba que estaba lista, la ventana quedaba (transparente, encima del juego) sin mostrar nada. Ahora, a los 10 s sin `ready` se descarta y se arma de nuevo; a la tercera vez seguida se rinde (`pageFailed` en el estado) hasta la próxima partida, prueba o edición. También con `did-fail-load` y `render-process-gone` (que antes destruía sin contarlo). | Corregido. Prueba. |
| B15 | `overlay.js:182-190` | Una página colgada (`unresponsive`) con un panel o la edición abiertos dejaba el mouse tomado hasta los 15 minutos. Ahora se sueltan los modos interactivos, se descarta la ventana y se arma de nuevo. | Corregido. Prueba. |
| B16 | `overlay.js:277` | Con monitores de distinta escala (DPI), Electron a veces deja la ventana con otro tamaño la primera vez que se la lleva a otro monitor. Ahora se compara `getBounds()` con lo pedido y se vuelve a pedir (hasta 2 veces). | Defensa. Prueba con una ventana falsa que se equivoca la primera vez; **no probado en dos monitores reales**. |
| B17 | `overlay.js` (sin oyentes) | Si cambiaba la escala de Windows o se enchufaba o sacaba un monitor sin que el ayudante notara un cambio, el rectángulo no se volvía a poner. Ahora `display-metrics-changed`, `display-added` y `display-removed` lo fuerzan. | Corregido. Prueba. |
| B18 | `overlay.js:742-747` (`returnToGame`) | Al terminar la edición (o cerrar un panel) se le pide el juego al ayudante a los 60 y 450 ms; si en el medio se abría otra edición, el juego le **robaba el foco** a la edición (Esc y flechas dejaban de andar hasta hacer clic). Ahora no se pide si hay un panel o una edición. | Corregido. Prueba. |
| B19 | `overlay.js:468-473` (`stopGame`) | Una partida que fallaba al lanzar (nunca llega a `running`) dejaba su preparación (`plays`: lector del registro, tablas de idioma, temporizador) guardada. | Corregido. Prueba. |
| B20 | `overlay.js:1012`, `widgets.js:566` | Mantener una flecha apretada en el modo edición guardaba el archivo de ajustes **30 veces por segundo**, y cada guardado volvía a mandarle a la página un layout atrasado: el widget "saltaba" para atrás. Ahora el proceso principal junta lo que llega y lo guarda 150 ms después (y al terminar la edición); la página recuerda 1,2 s lo que acaba de mover (`layout.mergeLocalMoves`). | Corregido. Pruebas. |
| B21 | `overlay.js:777`, `recipes.js:100` | Leer recetas de una instancia con cientos de mods no tenía techo: el panel quedaba en "Leyendo…" sin tiempo máximo, y 500 `.jar` se leían uno tras otro en el proceso principal sin dejar respirar al launcher. Ahora: techo de 90 s en el módulo y de 120 s en la página; la primera lectura espera 30 s como mucho y el resto de los mods se sigue leyendo en segundo plano, de a uno y cediendo el turno entre `.jar` (`info.modsPending`); a los 20 s el panel vuelve a pedir y sale completo de la caché. | Corregido. Pruebas. |
| B22 | `overlay.js:818-838` | Con el asistente sin conexión (o con la IA apagada) el panel esperaba la respuesta de la nube antes de decir nada, y sin tiempo máximo. Ahora lo sabe de entrada y, con conexión, espera el estado 8 s como mucho (si no llega, dice "no disponible"). | Corregido. Pruebas. |
| B23 | `page.js:33` | Una sola excepción al dibujar un layout rechazaba la promesa `pending` y **todos** los layouts y eventos siguientes se descartaban: la página quedaba sorda hasta recargarse. Ahora `createSerial` (`logic.js`): si una tarea falla se avisa y la cola sigue. | Corregido. Prueba. |
| B24 | `widgets.js:159` | Un dato raro que hacía fallar el dibujo de un widget cortaba el de los que venían después. Ahora cada widget se dibuja aparte (`safeRender`): el que falla se esconde y se avisa una vez. | Corregido. Sin prueba (necesita DOM); verificado en la ventana de desarrollo. |
| B25 | `widgets.js:389`, `events.js:107`, `logic.js:54` | Con salas de más de 8 integrantes, quien hablaba y estaba del noveno para abajo quedaba escondido en "+N personas más" (y con más de 16 se cortaba al validar). Ahora se dibujan primero quien habla y uno mismo, en el orden de la sala (`pickVoiceRows`, y lo mismo en `events.voice`). | Corregido. Pruebas. |
| B26 | `widgets.js:523-576` | Si la edición terminaba con un arrastre a medias (Esc con el mouse apretado, ventana escondida), `drag` quedaba puesto: el widget nunca más se reubicaba ni se redibujaba. Ahora `cancelDrag()` al salir del modo edición, al destruir la vista y con `lostpointercapture`. | Corregido. Verificado en la ventana de desarrollo; sin prueba (DOM). |
| B27 | `overlay.css:57-71` | Las 9 posiciones eran 9 cajas independientes: un Voice Chat de 8 filas con 3 mensajes apilados **se pisaban** (4 px en 1280×720, mucho más en ventanas chicas). Ahora son las celdas de una **grilla de 3×3**: lo que crece empuja a la celda de al lado, y si todo junto no entra en el área de juego se achica (`fitFactor`, hasta 55 %). Las posiciones libres no cambian. | Corregido. Capturas 1280×720, 1366×768 y 854×480. |
| B28 | `widgets.js:288-307` | La página seguía con su temporizador de 1 s (reloj de sesión, música, contadores) y redibujando aunque la ventana estuviera escondida (juego atrás, atajo de ocultar). Ahora el proceso principal le avisa `{ kind: 'shown', shown }` y escondida no corre nada. | Corregido. Prueba (lado principal). |
| B29 | `panel-recipes.js:81,156` | Buscadores y fichas compartían un mismo contador: escribir mientras se abría un ítem cancelaba la ficha y el clic "no hacía nada". Ahora tienen contadores separados. | Corregido. Sin prueba (DOM). |
| B30 | `panels.js` (`ask`) | Un pedido al proceso principal sin respuesta dejaba al panel esperando para siempre. Ahora 120 s como último recurso. | Corregido. |
| B31 | `features/overlay.js:259` | Si un guardado fallaba, la tarjeta mostraba lo que no quedó; los atajos de los paneles no avisaban si el juego no pudo tomarlos; "Buscando…" no distinguía fallas. | Corregido (se vuelve a leer del proceso principal; ver sección 1). |

### Revisado y sin cambios

- **Permisos.** `overlay/preload.js` no suma ningún canal ni capacidad: sigue siendo `overlay:page` (enviar) y `overlay:panel` (invocar, lista cerrada de acciones). La acción nueva `tweak` viaja por el mismo `overlay:page`, solo en modo edición, y se acota en el proceso principal (`config.tweakPatch`: solo `enabled`, `scale` y `opacity` de widgets que existen). La prueba "el puente de la página no expone nada genérico" sigue en verde. `window.js`: `sandbox`, `contextIsolation`, sesión propia que niega todo, sin navegación ni ventanas, CSP sin red: igual.
- **Canales IPC.** Los mensajes de la página (`ready`, `done`, `panelClose`, `move`, `tweak`, `reset`) solo se aceptan de la ventana del overlay y, los de edición, solo editando; `overlay:panel` pasa por `panels.cleanRequest` (probado con rutas externas, ids con `..`, booleanos que no lo son, pestañas inexistentes). `overlay:push` y `overlay:test` validan con `events.validate`; `overlay:setShortcut` y `setPanelShortcut` rechazan lo que no es texto.
- **Contadores y rendimiento con datos raros.** `events.perf` y `events.counters` acotan y dejan `null` lo que no se sabe; la página no dibuja `NaN`. Sin cambios.
- **Clics que atraviesan o se bloquean.** `setInteractive` y el ciclo `showInactive` / `focusable` están bien; los casos de trabado que encontré eran B15, B18 y B26.
- **Arranque con el juego ya abierto.** Prender el overlay con el juego abierto arranca el ayudante, los atajos y el medidor (`syncTrackers`, `armShortcut`, `syncPerf`). Si es el **launcher** el que se reinicia con el juego abierto, `core/game` no conoce esa partida y el overlay no la sigue: fuera del alcance del overlay (no es un bug nuevo).
- **Pantalla completa exclusiva.** Límite de Windows, sin cambios: ver [overlay.md](../overlay.md).

## 3. Archivos

```
src/main/modules/overlay.js               guard/report, withTimeout, estado del ayudante (reintentos), vigilancia de la página
                                          (ready, did-fail-load, render-process-gone, unresponsive), applyBounds, pantallas,
                                          atajos solo con el juego adelante y con choques, medidor pausado, posiciones juntas,
                                          recetas y asistente con tiempos, evento 'shown' a la página, __state (solo pruebas)
src/main/modules/overlay/config.js        canonAccelerator, shortcutIssue, findConflict, tweakPatch, normalize sin atajos repetidos
src/main/modules/overlay/geometry.js      gameInFront
src/main/modules/overlay/tracker.js       onEnd({ clean, lines }), sin avisos después de stop(), 'close' y margen para 'exit'
src/main/modules/overlay/perf.js          vuelve a pidusage si el ayudante se cae
src/main/modules/overlay/events.js        voice: quien habla y uno mismo primero si hay más de 16
src/main/modules/overlay/window.js        loadFile con catch
src/main/modules/overlay/preload.js       tweak(id, patch)
src/main/modules/overlay/dev.js           'hold' acepta '1366x768'; la consola de la página se engancha una sola vez
src/main/modules/recipes.js               presupuesto de 30 s, mods restantes en segundo plano, info.modsPending
src/main/i18n/{es,en}/overlay.js          errOffline
src/renderer/js/overlay/                  page.js (cola serial, onTweak), widgets.js (grilla, fantasma, selección, teclas, cancelDrag,
                                          pausa, safeRender, voz), layout.js (mergeLocalMoves, fitFactor, stepValue), logic.js
                                          (createSerial, pickVoiceRows), panels.js (tiempo máximo), panel-recipes.js
src/renderer/js/features/overlay.js       estado, restablecer por widget y todos, selección desde la vista previa, mensajes de
                                          atajos, avisos de atajos de riesgo y de paneles, releer si guardar falla
src/renderer/styles/overlay.css           .ovl-grid y .ovl-cell-*, .ovl-ghost, .ovl-selected
src/renderer/styles/features/overlay.css  .ovp-w-foot, .ovp-keys-help
src/renderer/i18n/{es,en}/overlay.js, overlaytools.js
src/main/modules/overlay/test/            harness.js (entorno falso), module.test.js (29 pruebas del módulo entero) y ampliaciones
                                          de config, events, geometry, layout, logic, perf y tracker
src/main/modules/recipes/test/            presupuesto de tiempo con muchos mods
```

## 4. Canales, ajustes y contratos que cambian

- `overlay:status` suma `tracker`, `pageFailed`, `shortcutIssue` y `panelShortcutIssues` (ver sección 1 para los valores).
- `overlay:setShortcut` y `overlay:setPanelShortcut` suman los códigos `minecraft`, `system`, `altgr` y `venus` (con `who`).
- Página → principal (`overlay:page`): mensaje nuevo `tweak` `{ id, patch: { enabled?, scale?, opacity? } }`. Principal → página (`overlay:event`): `{ kind: 'shown', shown }` (interno, no pasa por `events.validate` ni por `overlay:push`).
- `recipes.open` acepta `budgetMs` (solo pruebas) y la sesión trae `info.modsPending`.
- `module.exports` de `overlay.js` sigue siendo `{ register, push, status }` para los demás módulos (capturas, música, familia, ayuda). Con `VENUS_OVERLAY_TEST=1` suma `__state`.
- Ajustes (`settings.overlay`): **sin claves nuevas**. `panelShortcuts` repetidos con `shortcut` se normalizan al leer.
- Ventana de desarrollo: `venus.invoke('overlay:dev', 'hold', '1366x768')` fija el tamaño del "juego" de las capturas.

## 5. Pruebas

```bash
node --test "src/main/modules/overlay/test/" "src/main/modules/recipes/test/"      # 117 pruebas
# El mismo módulo.test.js contra otra copia de overlay.js (para ver lo que fallaba antes):
git show <commit-base>:src/main/modules/overlay.js > src/main/modules/overlay.old.js
printf "\nif (process.env.VENUS_OVERLAY_TEST === '1') module.exports.__state = st;\n" >> src/main/modules/overlay.old.js
VENUS_OVERLAY_FILE=overlay.old.js node --test --test-timeout=4000 src/main/modules/overlay/test/module.test.js
```

`test/harness.js` arma Electron, `core/game`, `core/settings`, servidores y tareas falsos, y reemplaza el ayudante de la ventana, el medidor y la ventana del overlay por dobles que registran lo que se les pidió; los temporizadores y `Date` son los falsos de `node:test` (sin esperas reales). Al terminar cada prueba se devuelve todo lo reemplazado (las demás pruebas ven los módulos de verdad).

Capturas de desarrollo, en español e inglés, con `console.log` de la ventana principal y de la página del overlay **vacíos**: tarjeta de Ajustes (vista previa, widget elegido, widget apagado como fantasma, texto largo), overlay en 1280×720, 1366×768 y 854×480 (tema oscuro y claro), modo edición con las teclas nuevas (se comprobó que lo editado queda en `settings.json`), panel de recetas con un `.jar` sintético propio y panel del asistente falso.

## 6. Lo que no se pudo probar

Sin Minecraft real ni varios monitores:

- Que el overlay se vea **encima del juego real** en ventana, ventana sin bordes y pantalla completa; y el **foco** al abrir y cerrar paneles con el juego de verdad (la lógica y los tiempos se probaron con un ayudante falso; el robo y la devolución reales de Windows no).
- **Monitores de distinta escala**: `applyBounds` (reintento si Electron deja otro tamaño) y los oyentes de pantallas se probaron con dobles, no con dos monitores reales. `physicalToDip` ya tenía pruebas de cuentas.
- `win.loadFile().catch` y los eventos `did-fail-load` y `unresponsive`: se razonaron con la documentación de Electron; no se pudo forzar un fallo de carga real.
- Que `document`/la ventana escondida de verdad pare los temporizadores (la página obedece `{ kind: 'shown' }`; en la ventana de desarrollo el evento se manda a mano).
- El reintento del ayudante con un PowerShell realmente bloqueado por política (`Constrained Language Mode`): se probó con caídas simuladas.
- Cientos de mods reales (se probó con `.jar` sintéticos y el presupuesto en cero; los tiempos de verdad dependen del disco).
- Conflictos con atajos de **otras aplicaciones**: se prueba con `globalShortcut.register` (si devuelve falso, `taken`); la lista de teclas de Minecraft es la de las teclas por defecto (si el jugador las cambió, el aviso puede sobrar o faltar).

## 7. Textos nuevos y viejos

- `overlay` (renderer): nuevas `tweakShown`, `tweakHidden`, `tweakSize`, `pillSearching`, `pillError`, `statusTrackerFailed`, `statusPageFailed`, `previewKeys`, `resetPositionsHint`, `panelShortcutTakenNow`, `shortcutMinecraft`, `shortcutSystem`, `shortcutAltgr`, `shortcutVenus`, `shortcutWho_voice`, `shortcutWho_capture`, `shortcutWho_music`, `shortcutWho_overlay`, `widgetSummary`, `resetWidget`, `resetWidgetHint`, `resetAll`, `resetAllHint`, `resetAllTitle`, `resetAllText`, `resetAllOk`, `resetAllDone`. **Cambian de significado** (los otros 12 idiomas quedan con el texto viejo hasta traducirlos): `editHint`, `editWidgetAria`, `statusSearching`, `previewHint`, `shortcutHint`, `shortcutPressHint`, `shortcutInvalid`.
- `overlaytools` (renderer): nuevas `rc_err_timeout`, `rc_modsPending_one/_other`, `rc_modsPendingShort_one/_other`.
- `overlay` (principal): nueva `errOffline`. (Las claves `streamer*` de `src/main/i18n/{es,en}/overlay.js` ya las sacó el agente A, junto con el módulo, de los 14 idiomas.)

## 8. Avisos para la integración

- **Funciones que borran otros agentes.** El overlay no usa streamer, OBS ni Competir y no queda ninguna referencia a ellos en los archivos del overlay (se revisó el código y los textos al final). Al empezar, `modules/streamer.js` llamaba a `overlay.onStreamerChange?.()` (con `?.`; esa función nunca estuvo en `overlay.js`) y `main/i18n/{es,en}/overlay.js` traía las claves `streamer*`: el agente A ya los retiró de la rama.
- `modules/capture.js`, `nowplaying.js` y `family.js` siguen usando `require('./overlay').push(...)` y `status().running`: no cambió.
- **Objetos de base de datos:** ninguno. No hay migraciones ni RPC.
- Carpetas de pruebas nuevas: ninguna (se amplían `modules/overlay/test/` y `modules/recipes/test/`). Borradas: ninguna.
- No se tocó ningún archivo compartido (`app.js`, `admin.js`, `nav.js`, `index.html`, `main.js`, `modules-loader.js`).
