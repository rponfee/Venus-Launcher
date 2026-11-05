# Retirada de funciones del launcher

Actualización local del 4 de noviembre de 2026, por decisión del dueño. Este cambio retira Clanes, modo streamer, Extensiones y visor de semillas del launcher. Comunidades continúa, y **Ajustes → Acerca de → Web oficial** abre [venuslauncher.fun](https://venuslauncher.fun/) mediante el handler existente `app.openExternal`, solo al pulsar el botón.

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

- [Extensiones: guía histórica](extensiones.md) y [contratos y aislamiento](implementacion/extensiones.md).
- [Visor de semillas: cobertura y límites históricos](implementacion/semillas.md).
- [Clanes y comunidades: contratos anteriores](implementacion/clanes-comunidades.md); Comunidades sigue en desarrollo en su frente propio.
- [Clips y OBS](implementacion/clips.md): contrato actual sin el evento `obs:streamer`; los resultados anteriores de ese automatismo se identifican como antecedentes.
