# Retirada de funciones del launcher

Actualización local del 4 de noviembre de 2026, por decisión del dueño. Este cambio retira Clanes, modo streamer, Extensiones y visor de semillas del launcher. Comunidades continuó hasta la 6.1 ([Retiros de la 6.1](#retiros-de-la-61)), y **Ajustes → Acerca de → Web oficial** abre [venuslauncher.fun](https://venuslauncher.fun/) mediante el handler existente `app.openExternal`, solo al pulsar el botón.

| Función | Cambio efectivo | Lo que se conserva |
|---|---|---|
| Clanes | Sin ruta, menú, startup de invitaciones, tarjeta de horas en Competir ni acciones de clan en Administración. La pestaña compartida de admin se llama Comunidades y opera sobre comunidades y sus mensajes. | Comunidades, sus canales y permisos; módulos compartidos y registros existentes. La tarjeta de perfil tampoco muestra el tag ni consulta clan_tags. |
| Modo streamer | Sin interruptor, comando, indicador ni CSS de ocultación. El módulo principal no se importa. Discord, overlay, QR de control remoto y OBS ignoran las preferencias antiguas del modo. | Controles propios de privacidad, permisos, voz, filtros del overlay, protección de direcciones privadas en Discord y reglas de escenas/grabación de OBS. |
| Extensiones | Sin ruta, menú, startup, tarjetas en Inicio ni pestaña de administración. El cargador principal excluye el módulo antes de `require`: no hay registro de protocolo o IPC, carga automática ni consultas de catálogo/blocklist. | Directorios, paquetes, configuración y datos del usuario. Código e informes anteriores como antecedentes. |
| Visor de semillas | Sin ruta ni entrada en Herramientas; su generador deja de ser accesible desde la navegación del launcher. | Mapa normal de mundos, marcadores y campos Semilla para crear mundos o servidores. Generador e informe de cobertura históricos. |

Los valores persistidos `privacy.streamer`, `obs.streamerWhileLive` y `obs.streamerOwned` pueden permanecer en el archivo de ajustes, pero no producen efectos. No se migra ni borra ese archivo para retirar la función. Del mismo modo, las preferencias antiguas de Extensiones no reactivan su carga. Las preferencias de navegación guardadas no pueden restaurar las tres páginas retiradas.

## Archivos de integración

- `src/main/modules-loader.js`: exclusión de `extensions.js` y `streamer.js` antes de importarlos.
- `src/renderer/js/app.js` y `pages/home.js`: rutas, menú, startup y retirada del hook de tarjetas de extensiones.
- `pages/admin.js` y `pages/admin/clans.js`: acceso y acciones de administración exclusivamente de Comunidades.
- `pages/settings/general.js`: acceso externo a la web oficial y retirada del panel streamer.
- `src/main/core/settings.js`, `modules/discord/activity.js`, `modules/overlay.js`, `modules/obs.js` y `modules/obs/logic.js`: preferencias obsoletas sin efecto.
- `features/clipstudio.js`, `features/clipstudio/obs-panel.js`, `features/serverremote/remote.js`, `features/whatsnew.js`, `pages/compete/rankings.js`, HTML y CSS generales: retirada de integraciones y avisos de las funciones eliminadas.

Las rutas abreviadas de interfaz de esta lista son relativas a `src/renderer/js/`. Los textos de Acerca de, OBS y el recorrido se ajustaron en los 14 idiomas existentes.

## Verificación local

**61 pruebas aprobadas, sin fallos ni omitidas**, con servicios y datos sintéticos; no se usaron cuentas ni servicios reales. Cubren el cargador principal, navegación, enlace externo, administración de comunidades y mensajes, ajustes antiguos de streamer, OBS, marcadores de mapa, overlay y lifecycle del estudio de clips.

Además, se verificó la sintaxis de 63 archivos del alcance, los 42 textos ajustados en 14 idiomas, el YAML y la resolución de los dos globs nuevos de CI, y los enlaces locales de los once documentos modificados. No se ejecutó el workflow remoto.

Regresiones nuevas: `src/main/core/test/retired-features.test.js` y `src/renderer/js/features/retired/test/integration.test.js`. Se actualizaron las pruebas de OBS que antes comprobaban el automatismo streamer. El workflow `.github/workflows/build.yml` incluye las regresiones de interfaz y el nuevo glob de `features/cosmic-art/test/` solicitado por la integración principal; las de core y OBS ya estaban incluidas.

Esta comprobación no equivale a un recorrido visual en Electron, OBS real, Minecraft, un paquete final ni una ejecución remota de CI. La retirada no ejecuta SQL, despliegues, borrado de datos de producción ni limpieza de carpetas de extensiones.

## Referencias conservadas

- Extensiones y visor de semillas: la guía, los contratos y los informes se borraron en la 4.6 junto con el código (ver [supabase.md](supabase.md) para lo que queda en la base y la migración 0048).
- [Clanes y comunidades: contratos anteriores](implementacion/clanes-comunidades.md); Comunidades se retiró en la 6.1 (ver abajo).
- [Clips y OBS](implementacion/clips.md): contrato actual sin el evento `obs:streamer`; los resultados anteriores de ese automatismo se identifican como antecedentes.

## Retiros de la 4.6

La 4.6.0 borró del árbol, además de lo anterior: **Competir** (rankings, desafíos, eventos y el aviso de desafíos), **Extensiones**, el **visor de semillas**, el **modo streamer con OBS**, la página **Herramientas** (el conversor Nether, stacks, orden de encantamientos, ticks, colores § y chunks), las **capas de Venus** (tienda, mod y launcher; ver [insignia.md](insignia.md)) y el sistema viejo de **Clanes** (Comunidades lo reemplaza). Se conservan, funcionando igual, el recordatorio de descansos y tope de horas, el resumen al cerrar el juego, el aviso de versión nueva de Minecraft y las descargas programadas: mudaron a `features/playcare` sin cambiar ajustes ni canales (`play.breaks`, `play.today`, `play.sessionRecap`, `news.newVersions`, `downloads.schedule`, `mcnews:*`, `downloads:schedule*`). `modules-loader.js` ya no tiene lista de excepciones y la directiva `frame-src` de `index.html` volvió a `'none'`. Los campos "Semilla" al crear un mundo siguen. Las claves de ajustes de lo retirado quedan como datos inertes y en el disco pueden quedar `data/compete.json`, la carpeta `extensions/` y el secreto cifrado `obs.password`. La base: la migración **0048** (sin aplicar) elimina las tablas y funciones sin uso; ver [supabase.md](supabase.md).

## Retiros de la 6.1

Por decisión del dueño, la 6.1 retira las **Comunidades** del launcher: la sección del menú En línea con canales de texto, anuncios, foros y voz, roles y permisos, bienvenida y despedida, galería de GIF y los **planes de clan** pagos (Clanes Go, Pro, Max y Ultra). Siguen igual Voice Chat (las salas normales y la de emergencia), Mensajes (con GIF de KLIPY y stickers), los grupos para jugar, los perfiles (el banner de KLIPY sigue) y los temas de la comunidad.

| Qué | Cambio efectivo |
|---|---|
| Página y menú | Sin ruta `#/communities` ni entrada en el menú. Una ruta vieja (un enlace, la página de inicio "la última que visitaste" o un acceso guardado) abre el Inicio, porque el router solo abre lo que está en `PAGES`. |
| Navegación personalizada | Un `communities` guardado en `settings.nav` (orden, fijados u ocultos) se descarta al leerlo (`normalizeNav` solo acepta ids del menú actual) y no rompe el resto de la preferencia. El archivo no se reescribe. |
| Voice Chat | La sala ya no pide el "escenario" de una comunidad (`community_stage_get`) ni carga código de Comunidades. |
| Recorrido de novedades | Sin la pantalla "Jugá y charlá en comunidad" (`v45social`), que llevaba a la página; sus textos se borraron en los 14 idiomas. |
| Planes de clan | `features/plans.js` ya no tiene la rama de clan. En el proceso principal, `billing:checkout` solo acepta los planes de IA (`clan_*` responde `unknownPlan` sin llegar a pedir el pago), el catálogo ya no devuelve `clans` y las órdenes no llevan `communityId`. Se borraron las claves `billing.errUnknownCommunity` y `billing.errNotOwner` en los 14 idiomas. |
| Otros | Se borraron `pages/communities.js`, `pages/communities/` (vistas y pruebas), `features/communities/looks.js` y `report.js`, y `scripts/gen-clan-scenes.js` (generaba escenas que ya no estaban en el árbol). El texto de sugerencias de Soporte dice "Amigos, mensajes y voz" (es y en; los otros idiomas se traducen al final). |

**Restos borrados en esta misma versión:** al quitarse la pestaña Comunidades de Administración (`pages/admin/communities.js`) se borraron también `features/communities/` (`backend`, `logic`, `fake`, `fake-plans`, `presets`, `permissions`, `greeting`, `media` y `plan`), `pages/communities/logic.js` y `media-view.js`, los estilos `pages/communities.css` y `features/communityplans.css`, los namespaces `communities` y `communityplans` en los 14 idiomas y la clave `nav.communities`. No queda código de Comunidades en `src`.

**Datos que se conservan:** no se ejecutó SQL ni se borró nada de nadie. En la base siguen las tablas `communities`, `community_members`, `community_channels`, `community_messages`, `community_bans`, `community_mutes`, `group_reports` (0033), `community_categories`, `community_roles`, `community_member_roles`, `community_channel_perms`, `community_reactions`, `community_greetings`, `community_media` (0038), `community_plans`, `community_plan_periods`, `community_backdrops`, `community_presets` y la columna `payment_orders.community_id` (0044); el bucket privado `community-media`; las RPC públicas `community_*` y `admin_community_*`, y las privadas `private.community_*`, `private.group_*` y `private.clan_quote`. Las salas de voz de los canales de comunidad son filas de `voice_rooms` privadas y cerradas. El launcher ya no las crea ni invita a nadie (nada llama a `community_voice_room`), pero las que ya existen siguen saliendo en Voice Chat como salas comunes: al dueño de la comunidad en "Tus salas" (puede entrar, editarlas o borrarlas, y le cuentan para el tope de 12 salas) y a los miembros que entraron alguna vez en "Recientes" (cerradas: `voice_join` les responde `locked`). El cliente no puede ocultarlas porque el servidor no distingue una sala de comunidad; ocultarlas o borrarlas es una migración aparte. Además `voice_join`, `voice_member_keys` y la voz de respaldo siguen llamando a `private.community_voice_access`, `community_voice_speaks` y `community_voice_visible`, así que una limpieza futura tiene que redefinir esas funciones de voz **antes** de borrar las tablas. En el archivo de ajustes del usuario, las claves viejas quedan inertes.

**Moderación mientras queden launchers viejos.** El servidor sigue aceptando las Comunidades de los launchers 6.0.0 o anteriores (la edición portable no se actualiza sola, y hay quien apaga las actualizaciones): se pueden seguir creando comunidades, mensajes, denuncias (`group_reports`) y GIFs, que nacen pendientes de aprobación. El panel de la 6.1 ya no tiene una pestaña para eso. Hasta que esos launchers se actualicen, se modera desde el SQL Editor de Supabase (las funciones aceptan esa sesión):

- Ver las denuncias: `select public.admin_group_reports();`
- Cerrar una (con `true` además borra el mensaje denunciado): `select public.admin_group_report_close('<id>'::uuid, true);`
- Ver los GIFs pendientes: `select public.admin_community_media_queue('pending', 50, 0);`
- Rechazar o aprobar uno (`'reject'` o `'approve'`): `select public.admin_community_media_review('<id>'::uuid, 'reject', '<motivo>');`
- Disolver una comunidad: `select public.admin_group_dissolve('community', '<id>'::uuid, '<motivo>');`

Si se quiere cortar del todo, hace falta una migración nueva que les quite el permiso de ejecución a las funciones públicas de escritura de Comunidades (`community_create`, `community_join`, `community_send` y las demás); no está escrita.

### Archivos de integración (6.1)

- `src/renderer/js/app.js`: `NAV` y `PAGES` sin Comunidades.
- `voice/ui-room.js`: sin `attachStage`.
- `features/plans.js`, `src/main/modules/billing/client.js` y `fake.js`: sin planes de clan.
- `features/whatsnew.js` e `i18n/*/whatsnew.js`: sin la pantalla `v45social`.
- `src/main/i18n/*/billing.js`: sin los errores de comunidad.

### Verificación de la 6.1

Regresiones nuevas en `src/renderer/js/features/retired/test/communities.test.js` (6 pruebas): sin ruta ni menú; preferencia vieja con `communities` ignorada; Voice Chat, Mensajes, Inicio, el menú, novedades y planes cargan sin archivos faltantes y sin llegar a código de Comunidades (recorriendo sus imports, sin entrar en Administración); los archivos borrados no existen; las novedades no mencionan Comunidades; el cliente de pagos no ofrece ni cobra planes de clan. `integration.test.js` pasó a comprobar que Comunidades ya no está. Capturas en Electron con datos temporales (Inicio, `#/communities` que abre el Inicio, Voice Chat, Mensajes y el menú con En línea completo) sin errores en la consola. No se probó con una cuenta real.
