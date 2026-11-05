# Retiros de la 4.6 (Competir, visor de semillas, Extensiones, modo streamer con OBS y la página Herramientas)

> **Rama 4.6, sin publicar.** El dueño pidió sacar cinco funciones. En la 4.5.0 la navegación ya no las mostraba, pero el código seguía en el árbol. Acá se borra de verdad: archivos, importaciones, menú, `STARTUP`, textos en los 14 idiomas, estilos, pruebas y documentos. No se escribió ninguna migración ni se tocó la base: lo que queda sin uso allá está en "Base de datos" para que lo limpie el dueño.

## Qué cambió para el jugador

- **Competir** ya no existe: ni la página, ni el aviso de desafíos, ni los recordatorios de eventos, ni la tarjeta "Compartir con mis amigos" de Ajustes → Privacidad, ni la pestaña **Eventos** de Administración. El launcher deja de mandar horas jugadas a los rankings.
- **Visor de semillas**: borrado para siempre (generador, mapas, tablas y pruebas contra el original). Los campos "Semilla" al crear un mundo (en Mundos y en el asistente de servidores) siguen igual.
- **Extensiones**: ni el módulo, ni el protocolo `venus-ext`, ni las páginas, ni el catálogo, ni la pestaña de Administración. La directiva `frame-src` de `index.html` volvió a `'none'`, como en la 3.0.
- **Modo streamer e integración con OBS**: borrados el módulo de modo streamer (principal e interfaz) y el módulo de OBS con su tarjeta de Ajustes → En el juego. Desaparecen el aviso "Modo streamer" del overlay, el filtro de textos de los toasts y la regla de escenas.
- **Herramientas**: la página (conversor Nether, stacks, orden de encantamientos, ticks, colores y chunks) ya no existe. **Se conserva**, funcionando igual, lo que vivía en `features/tools/`: recordatorio de descansos y tope de horas, resumen al cerrar el juego, aviso de versión nueva de Minecraft y descargas programadas. Mudó a `features/playcare` (sin cambiar ajustes ni comportamiento).

## Qué se mudó: `tools` → `playcare`

| Antes | Ahora |
|---|---|
| `renderer/js/features/tools.js` (registraba la página y arrancaba las piezas) | `renderer/js/features/playcare.js` (solo arranca las piezas; ya no registra ninguna página) |
| `features/tools/{breaks,mcnews,recap,schedule}.js` | `features/playcare/{breaks,mcnews,recap,schedule}.js` |
| `pages/tools/breaks.js` (cuentas sin DOM) | `features/playcare/breaks-logic.js` |
| `pages/tools/test/{breaks.test.js,index.js}` | `features/playcare/test/{breaks.test.js,index.js}` |
| `styles/pages/tools.css` (solo se salvó lo de resumen, aviso, descansos y descargas) | `styles/features/playcare.css`; las clases `tools-recap*`, `tools-toast*` y `tools-sched-task*` pasaron a `pc-recap*`, `pc-toast*` y `pc-sched-task*`. `.tsch-*` y `.cfg-care-*` no cambiaron |
| namespace i18n `tools` (14 idiomas) | namespace `playcare`: las 38 claves que usan las cuatro piezas, con las traducciones que ya tenían; las ~134 claves de la página se borraron |

Ajustes que no cambian: `play.breaks`, `play.today`, `play.sessionRecap`, `news.newVersions`, `downloads.schedule`. Canales que no cambian: `mcnews:*`, `downloads:schedule*`, `overlay:push`. Ajustes → General y Ajustes → Descargas importan ahora desde `features/playcare/…` (`pages/settings/general.js` y `panels.js`).

## Qué se borró

**Competir**
- Principal: `modules/compete.js` y `modules/compete/` (`logic.js`, `scan.js`, `test/`). Canales `compete:collect`, `compete:commit`, `compete:reset`.
- Interfaz: `features/compete.js`, `pages/compete.js`, `pages/compete/` (rankings, desafíos, eventos, datos de ejemplo, `test/`), `pages/admin/events.js` (y su entrada `events` en `pages/admin.js`), `styles/pages/compete.css`.
- Menú y arranque en `app.js`: entrada `compete` de `NAV`, de `PAGES` y de `STARTUP`.
- Textos: namespace `compete` completo, `nav.compete` y `admin.tab_events` en los 14 idiomas.
- Documento: `docs/implementacion/competir.md`.

**Visor de semillas**
- `pages/seeds.js`, `pages/seeds/` (generador `gen/`, mapa, hilo de cálculo, íconos, pruebas de referencia, `golden.json`, `harness.c`), `styles/pages/seeds.css`, namespace `seeds` y `nav.seeds` en los 14 idiomas, `docs/implementacion/semillas.md`. No quedaba ningún aviso de licencia fuera de `seeds/gen/LICENSE-cubiomes.txt`, que se borró con el código.

**Extensiones**
- Principal: `modules/extensions.js` y `modules/extensions/` (manifiesto, paquetes, registro, servidor del protocolo, `boot.js`, pruebas hostiles). `core/permissions.js` se queda: es genérico (lo usan `main.js` y `capture/host.js`).
- Interfaz: `features/extensions.js`, `features/extensions/`, `pages/extensions.js`, `pages/extensions/`, `pages/admin/extensions.js`, `styles/pages/extensions.css`.
- Textos: namespace `extensions` en la interfaz y en `main/i18n`, `nav.extensions` y `admin.tab_extensions`, en los 14 idiomas. `index.html`: `frame-src 'none'`.
- Herramienta y documentos: `scripts/pack-extension.js`, `docs/extensiones.md`, `docs/extensiones-ejemplo/`, `docs/implementacion/extensiones.md`.

**Modo streamer y OBS**
- Principal: `modules/streamer.js`, `modules/streamer/`, `modules/obs.js`, `modules/obs/` (cliente obs-websocket, lógica y pruebas). Canales `obs:status`, `obs:test`, `obs:setPassword` y el evento `obs:state`.
- Interfaz: `features/streamer.js`, `features/streamer/`, `features/clipstudio/obs-panel.js`. En `features/clipstudio.js` se quitó la tarjeta; `styles/features/clipstudio.css` perdió `.cs-obs*` y `features/clipstudio/icons.js` el ícono `csObs`. En `ui.js` se quitó el filtro de textos de los toasts (`setTextFilter`/`filterText`) y su uso en `features/party/toasts.js`. En `features/clipstudio/timelapse.js` y `pages/clips/gallery.js` se quitó la clase `priv` que solo servía al modo streamer.
- Textos: `common.streamer*`, `settings.streamer*`, `serverremote.qrHidden`, `clipstudio.obs*` y `clipstudio.errObs*`, en la interfaz y en `main/i18n` (`overlay.streamer*`, `clipstudio.errObs*`), en los 14 idiomas. Del recorrido de novedades: la viñeta `v45clips_b3` (OBS).
- `modules-loader.js`: se borró `RETIRED`. Ya no hay nada que excluir.

**Herramientas (página)**: `pages/tools.js`, `pages/tools/calc.js` y su prueba, y las ~134 claves de la página. La entrada `registerPage('tools', …)` ya no existe.

**Recorrido de novedades (`whatsnew`)**: se borraron `v31tools_*`, `v45worlds_*` (la pantalla ya no estaba en `SLIDES`), `v45connected_*`, `v45clips_b3` y `v45changes_b1` en los 14 idiomas, y se quitó "rankings, desafíos entre amigos y calendario de eventos" de `v45social_text` (solo en **es** y **en**; ver "Textos viejos en otros idiomas").

## Pruebas

- Borradas: `main/modules/compete/test`, `main/modules/extensions/test`, `main/modules/obs/test`, `main/modules/streamer/test`, `renderer/js/features/extensions/test`, `renderer/js/features/streamer/test`, `renderer/js/pages/compete/test`, `renderer/js/pages/seeds/test`, `renderer/js/pages/tools/test`.
- Nuevas: ninguna carpeta. `renderer/js/features/playcare/test/` es la de `pages/tools/test/` mudada (`breaks.test.js`: 5 pruebas).
- Reescritas: `main/core/test/retired-features.test.js` (los módulos ya no existen, el cargador no tiene lista de excepciones y Discord ignora `privacy.streamer`) y `renderer/js/features/retired/test/integration.test.js` (rutas, archivos y textos de las cinco funciones; las pruebas de Administración de comunidades y de Acerca de siguen como estaban).
- `.github/workflows/build.yml`: se sacaron las ocho rutas de las carpetas borradas y la de `pages/tools/test` se cambió por `features/playcare/test` (la única prueba que se mudó en lugar de borrarse).

## Base de datos: lo que queda sin uso (no se escribió migración)

**Competir** (`0031_competencia.sql`)
- Tablas: `ranking_prefs`, `ranking_weekly`, `ranking_reports`, `challenges`, `calendar_events`, `calendar_signups`.
- Funciones públicas: `ranking_set_share`, `ranking_forget`, `ranking_report`, `ranking_friends`, `challenge_create`, `challenge_respond`, `challenge_cancel`, `challenge_settle`, `challenges_me`, `events_list`, `events_mine`, `event_signups`, `event_join`, `event_leave`, `admin_events`, `admin_event_save`, `admin_event_delete`.
- Funciones privadas: `private.compete_week`, `private.ranking_cap`, `private.challenge_tally`, `private.challenge_finish`, `private.challenge_json`, `private.event_json`.
- Ojo: `points_ledger_reason_check` incluye el motivo `challenge`. No lo saques mientras haya filas viejas con ese motivo (el historial de puntos las muestra con `rewards.hist_challenge`).
- Ojo: `0033_clanes_comunidades.sql` lee `ranking_weekly` y `ranking_prefs` (con `to_regclass`, así que no falla si no existen: el ranking de clanes simplemente queda en cero). Si se borran esas tablas antes que las funciones de clanes, hay que contar con eso.
- Sin filas en `shop_items` ni en `achievements`.

**Extensiones** (`0036_extensiones.sql`)
- Tablas: `community_extensions`, `community_extension_versions`.
- Funciones públicas: `extension_catalog`, `extension_blocklist`, `extension_submit`, `extension_my_submissions`, `admin_extensions`, `admin_extension_review`, `admin_extension_block`.
- Funciones privadas: `private.extension_permissions`, `extension_text_ok`, `extension_name_ok`, `extension_version_ok`, `extension_page_ok`, `extension_manifest_ok`, `extension_can_read`, `extension_can_upload`.
- Storage: bucket privado `extension-packages` y las políticas `extension_packages_select` y `extension_packages_insert` sobre `storage.objects`. Los paquetes subidos (`<uid>/<id>/<versión>.venusext`) hay que borrarlos antes que el bucket.

**Modo streamer, OBS, visor de semillas y página Herramientas**: nada en la base. Eran 100 % locales.

**Claves de ajustes** (archivos de datos del usuario, no hay migración ni hace falta una): `compete.{share,seen,reminded}`, `obs.*` (`enabled`, `host`, `port`, `sceneOnOpen`, `sceneOnClose`, `streamerWhileLive`, `streamerOwned`), `privacy.streamer` y `extensions.{catalog,blocklist}`. Se ignoran; no se leen ni se borran. Quedan además en el disco de quien las usó: `data/compete.json`, la carpeta `extensions/` de la raíz de datos y el secreto cifrado `obs.password` de `core/secure`.

## Textos viejos en otros idiomas (para traducir o limpiar)

- `whatsnew.v45social_text` cambió en **es** y **en**; los otros 12 idiomas todavía hablan de rankings, desafíos y calendario de eventos.
- `clans.sharePlaytimeRequirements`, `clans.sharedUnavailable` y `clans.rankingZero_unavailable` (agente de Comunidades) nombran a Competir en los 14 idiomas; las horas compartidas ya no existen. Las toca quien retira Clanes.
- `rewards.hist_challenge` ("Premio de un desafío") se conserva para el historial de puntos viejo.

## Qué no se tocó (a propósito)

- La clase `priv` (la que difuminaba el modo streamer) sigue en ~35 lugares de archivos de otros frentes (mensajes, voz, comunidades, inicio, servidores, etc.). Ya no tiene ningún estilo: es inocua. Se quitó solo donde se editaba el archivo por otro motivo.
- Los títulos de perfil `title_streamer` (tienda, 500 Venus Points) no son el modo streamer: son un cosmético del perfil.
- Documentos que todavía nombran las funciones retiradas (solo prosa, sin enlaces rotos): `README.md`, `docs/{activacion-backend-4.5.0,arquitectura,asistente-ia,backend-ia,clips,continuar-con-chatgpt,estado-4.5.0,funciones,hoja-de-ruta,mcp,supabase,venus-points,retirada-funciones}.md`, `docs/implementacion/{clips,clanes-comunidades,revision-sql-0028-0036,servidores}.md`. Los únicos cambios en ellos fueron quitar o desvincular los enlaces a los documentos borrados (`docs/README.md`, `docs/implementacion/README.md`, `docs/arquitectura.md`, `docs/supabase.md` y `docs/retirada-funciones.md`).
