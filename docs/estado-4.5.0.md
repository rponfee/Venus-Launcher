# Estado de integración de Venus 4.5.0

Actualizado el 4 de noviembre de 2026. **Las 35 funciones están implementadas para 4.5.0 en la rama `venus-3.2-funciones`; el launcher y la web siguen sin publicar.** La marca ☑ de la [hoja de ruta](hoja-de-ruta.md) registra implementación, no funcionamiento completo con servicios reales. **Producción ya tiene aplicadas 0028–0037 y desplegadas `push-notify`, `tiktok-token` y `curseforge`**, con autorización del dueño. Las credenciales de push/TikTok siguen pendientes; la clave aprobada para el launcher ya permitió búsquedas de CurseForge. Versiones, evidencia y límites en [activación del backend](activacion-backend-4.5.0.md). La versión publicada de referencia del launcher sigue siendo 3.1.0.

La [guía de funciones](funciones.md) explica el uso; [arquitectura](arquitectura.md) concentra los contratos y [las referencias de implementación](implementacion/README.md) conservan archivos, canales, RPC, formatos y límites. Los doce WIP de funciones y el informe SQL se reconciliaron con esas referencias y se revisaron antes de retirar `docs/wip/`. El respaldo previo quedó en `%TEMP%/venus-docs-wip-ae6f586369d1478aa621587f1b7e5938.zip`. El prompt `continuar-con-chatgpt.md` se mantiene intacto como documento histórico, no como estado vigente.

## Decisiones confirmadas

| Tema | Decisión para 4.5.0 |
|---|---|
| Versión | 4.5.0; la publicación requiere una instrucción posterior del dueño. |
| Portable y protocolo | Mantener el registro automático de `venus://`, respetando una asociación ajena. `build/installer.nsh` solo quita la clave al desinstalar, no al actualizar, si `shell/open/command` coincide con el ejecutable de esa copia. Preserva una asociación posterior de otra instalación o portable. El instalador NSIS compiló; queda pendiente instalar, actualizar y desinstalar en un Windows aislado. |
| Capas | Amanecer 1000, Nebulosa 1500, Aurora 1500 y Magma 2500 Venus Points; Órbita incluida únicamente con Premium. |
| Lista de extensiones bloqueadas | Consentimiento independiente del catálogo, apagado por defecto. Con permiso se consulta al abrir y cada 4 horas; la última lista se conserva y aplica sin conexión. No envía la lista de extensiones instaladas. |
| Horas del clan | Permiso separado, apagado por defecto: `clan_prefs.share_playtime`. Exige además compartir en Competir; no se hereda del permiso para amigos. El total se muestra con al menos dos aportantes habilitados; eso no garantiza anonimato. |
| Identificadores de subida | El build incorpora solo `youtubeClientId` y `tiktokClientKey`, sin secretos OAuth. Google documenta `client_secret` como opcional para escritorio; esto no sustituye la prueba de un cliente real. Si un proveedor exige otro flujo, debe aprobarse y probarse sin empaquetar secretos. |
| Sesiones por dispositivo | `cloud.signOut()` usa `scope: 'local'`. El celular y otras PC conservan sus sesiones. |
| Permisos Electron | `core/permissions.js` centraliza la validación de la página solicitante; `main.js` y `capture/host.js` instalan sus propios manejadores. Ya no se envuelven desde extensiones. |

Referencia de OAuth consultada el 3 de noviembre de 2026: [Google, OAuth 2.0 para aplicaciones de escritorio](https://developers.google.com/identity/protocols/oauth2/native-app).

## Evidencia actual

El 3 de noviembre, la integración ejecutó las pruebas de aplicación, navegador, vídeo, mod y paquete; el agente SQL ejecutó PostgreSQL local. Los resultados de esta tabla corresponden a esos artefactos. La activación de producción del 4 de noviembre se registra por separado más abajo; los informes anteriores se conservan como antecedentes, con su alcance.

| Comprobación | Resultado y alcance | Evidencia |
|---|---|---|
| Sintaxis y contratos | **2610/2610 archivos**, 545 canales registrados, 462 usados y **0 sin handler**. | `node scripts/check.js` y `node scripts/contracts-check.js` |
| Suite integrada Node | **1538 total, 1537 pass, 0 fail, 1 skip**, 44,7 s. El skip corresponde al ayudante de medios real de Windows, opt-in; no es una prueba aprobada. | `%TEMP%/venus-codex-review-20261103/integrated.tap` |
| Mod | `gradlew clean build`: **BUILD SUCCESSFUL**, 29 tareas ejecutadas en 19 s; cuatro JAR empaquetados. No se ejecutó Minecraft. | `mod-build.log` y `mod-package.log`, bajo el mismo directorio temporal |
| Páginas del launcher | **20 rutas en español y 20 en inglés**, con fixture del popup de conexiones corregido y `console.log` vacío en ambas. Las rondas anteriores bloqueadas por el popup son históricas. | `shots-pages-es/`, `shots-pages-en/` |
| Rutas adicionales | **12 rutas adicionales por idioma**, ES/EN, y consola vacía en ambas. | `shots-extra-valid-es/`, `shots-extra-valid-en/` |
| PWA | **7 capturas**, español/tema claro, 410×870, backend falso; worker activo y controlador, **33 archivos en caché**, HTML/login cargan sin red; `console.json: []`. | `pwa-browser/` |
| Timelapse | **60 PNG propios de 320×180 → WebM de 2 s**, reproducción real y salto a 1 s comprobado en Electron; consola vacía. No captura Minecraft. | `shots-encoder-valid/` |
| Montaje | Copia de **2 segmentos → WebM de 4 s**, reproducción real y salto a 3 s comprobado en Electron; consola vacía. | `shots-montage/` |
| Overlay | Capturas ES/EN en ventana oculta, recetas con **JAR sintético propio** y asistente falso. La integración principal revisó recetas ES y asistente EN y los informó correctos. Consola principal vacía; no se generó log adicional de errores del overlay. No prueba foco sobre Minecraft. | `shots-overlay-es/`, `shots-overlay-en/` y `recipes-synthetic.jar` |
| SQL local | **PostgreSQL 17.11**, 0001–0027 completas en base temporal nueva; 0028–0036 completas dentro de **BEGIN/ROLLBACK**. **1282 comprobaciones: 1225 estructurales + 57 escenarios**. Esquema/ACL, filas y secuencias iguales después; entradas sin cambios y procesos de prueba detenidos. | `%TEMP%/venus-sql-run-20261103-234145-713ff653/result.json`, `harness.log` e informe SQL completo |

Las rutas relativas de la tabla están bajo `%TEMP%/venus-codex-review-20261103/`. Se usaron datos temporales e inventados y capturas con `capturePage`, sin aceptar la EULA, cerrar apps del usuario ni utilizar sus datos reales.

La prueba SQL local del 3 de noviembre usó fixtures mínimos de Auth, Storage y Realtime; allí **pg_net estaba ausente**, Vault era un catálogo vacío y push/Realtime tenían sustitutos durante los escenarios. Fue PostgreSQL real, no Supabase administrado ni una validación de servicios externos. La [revisión SQL completa](implementacion/revision-sql-0028-0036.md) conserva comandos, guardas, fallos de preparación y limitaciones. **Las 1282 comprobaciones sí se ejecutaron**; no queda pendiente ese ensayo. Después se actualizaron únicamente diez referencias documentales en comentarios de las nueve migraciones; el registro `sql-comment-path-updates.json` no muestra cambios de sentencias SQL. El estado de producción del día siguiente se distingue de ese entorno local.

También se informó la recuperación de Electron/ICU y la comprobación de permisos con micrófono simulado y Notification concedido. El smoke usa `SMOKE_TEST` para evitar registrar el protocolo y cambiar el foco durante la prueba. Eso no valida micrófono físico ni llamadas entre PC.

## Activación del backend en producción — 4 de noviembre

Se aplicaron completas y en orden **0028–0036**, desde `cbedf16`, con autorización. La verificación encontró **32/32 tablas con RLS y 183/183 funciones**; se conservó el motivo `challenge`, `community_messages` quedó en Realtime y **pg_net 0.20.4** está instalado. El esquema `net` **no está expuesto**.

- `push-notify` **v1 ACTIVE**, `verify_jwt = false`; `tiktok-token` **v1 ACTIVE**, `verify_jwt = true`. Ambas devolvieron **HTTP 503 `not_configured`** por credenciales pendientes: desplegadas no significa operativas de punta a punta.
- **18 getters SQL**, en `BEGIN READ ONLY`, con `SET LOCAL ROLE authenticated`, UUID aleatorio sin cuenta y `ROLLBACK`: **17 devolvieron la forma esperada**; `cape_mine` devolvió `NULL` sin perfil. `clan_me` incluye el consentimiento y `clan_ranking` devuelve `available: true`. No se crearon registros ni se probó un JWT o usuario real.
- **19 rutas HTTP reales**: 3 respuestas públicas HTTP 200, 16 respuestas HTTP 401 con código `42501` sin sesión y **0 HTTP 404**. Evidencia: `%TEMP%/venus-backend-http-20261104.json`. Esto comprueba rutas presentes y el rechazo sin sesión, no flujos autenticados completos.

El dueño configurará personalmente push: faltan las tres variables del servidor y la configuración privada de Vault. No había entradas `venus_push_url` ni `venus_push_secret`; la consulta se limitó a esos nombres. Los materiales privados ya están preparados; sus valores y ubicaciones no se incorporan al repositorio. El [registro de activación](activacion-backend-4.5.0.md) contiene las nueve versiones iniciales, la activación adicional de 0037/CurseForge y separa los pendientes de credenciales, OAuth, celulares, juego y publicación.

### CurseForge: activación adicional autorizada

`0037_curseforge_admin.sql` quedó aplicada con versión **`20261104170221`** y `curseforge` **v1 ACTIVE**, **`verify_jwt = true`**. Los hashes de la migración y del despliegue figuran en el [registro de activación](activacion-backend-4.5.0.md). La función `admin` existente no se reemplazó.

El estado público devolvió **HTTP 200, `configured: false`**, porque el dueño aún no cargó la clave; el preflight del navegador devolvió **OPTIONS 204**, CORS `*`, y el POST sin autenticación devolvió **401**. Se verificaron RLS en `private.curseforge_rate`, ausencia de permiso administrativo para `anon` y acceso a la RPC que recupera la clave reservado a `service_role`, sin acceso para `authenticated`.

| Comprobación de CurseForge del 4 de noviembre | Resultado y alcance |
|---|---|
| SQL local 0037 | **84/84 PASS**, PostgreSQL 17.11, 0001–0036 completas y 0037 con valores ficticios en `BEGIN/ROLLBACK`. Esquema/ACL, filas y secuencias restaurados; clúster apagado. |
| Node main/Edge/UI | **82/82 PASS**. |
| Estado de servicios | **56/56 PASS**. |
| Sintaxis, IPC e inglés | **2613/2613 archivos**, **0 canales sin handler**, `i18n-check en` con salida **0**. |

Evidencia SQL: `%TEMP%/venus-curseforge-sql-20261104-140020-cc533da2/result.json`; [test](../supabase/tests/curseforge-admin-local.sql) y [runner](../scripts/run-curseforge-admin-local.ps1). El Vault simulado no prueba cifrado real. En esa primera activación no se cargó una clave de CurseForge ni se probaron el proveedor, JWT/cuentas reales o concurrencia; tampoco se enviaron mensajes.

**Comprobación posterior del proveedor:** la clave inicial era de Profile y daba 403 al buscar mods. El dueño cargó la clave aprobada para el launcher; la búsqueda mínima y la consulta exacta del catálogo respondieron **HTTP 200** desde el servidor, esta última con un resultado. No se expuso la clave. Queda pendiente el flujo autenticado completo dentro de la app.

## Traducciones y entrega local

- **Las doce traducciones adicionales están completas: 28.512 entradas base y 0 claves faltantes.** Hume cerró RU/UK con 204 formas `_few`/`_many` y **2240 comprobaciones con `t()` aprobadas**. Las fuentes i18n quedaron congeladas. `i18n-check --summary` devuelve **exit 1 únicamente por los dos archivos `admin` excluidos por idioma**; no se informa exit 0. La integración volvió a ejecutar el control global al cierre: **0 claves faltantes, 0 variables distintas y 0 sobrantes**; inglés también terminó con exit 0.
- **Instalador NSIS y portable 4.5.0 compilados localmente**, sin publicación ni firma digital. `check-package` aprobó **7613 archivos y 69,7 MiB**. `smoke-packaged --tamper` aprobó arranque, interfaz, versión, fuses, copia de control y rechazo de una copia alterada. Evidencia: `package-build.log`, `package-check.log`, `package-smoke.log` y tamaños/SHA-256/estado de firma en `package-artifacts.json`, bajo el directorio temporal de esta revisión.
- Ejecutables de la corrida del 3 de noviembre: `package-4.5.0/VenusLauncher-Setup.exe` y `package-4.5.0/VenusLauncher-Portable.exe`. Son anteriores a la configuración central de CurseForge y no llevan identificadores OAuth de YouTube/TikTok. La nueva `VenusLauncher-CurseForge-Portable.exe` ya está compilada y entregada localmente, sin firma. El paquete y el arranque aprobaron sus controles; archivos, hash y alcance en [activación del backend](activacion-backend-4.5.0.md).
- La web incluye **App para celular** en el pie, con destino relativo `app/`. Respeta la cuenta regresiva existente y estará disponible al publicar el sitio junto con la PWA.

## Pruebas externas pendientes

- Instalación, actualización y desinstalación NSIS en un Windows aislado; el ejecutable empaquetado se probó con datos temporales, sin reemplazar la instalación del usuario.
- Minecraft real: capas/elytra, FPS, ajustes compartidos, cierre por modo familia, marcadores, superposición/foco del overlay y semillas frente al juego.
- Dos PC/cuentas y micrófono físico: voz, soundboard, efectos, señales y Realtime. Las capturas con servicios falsos no validan estas funciones de punta a punta.
- Celular Android e iPhone: control remoto LAN, instalación PWA, teclado/áreas seguras, login y Web Push real. La comprobación de caché y shell en Chromium no cubre esos dispositivos.
- Discord webhook, IA con plan real, OBS, OAuth y subidas a YouTube/TikTok; credenciales, VAPID y aprobaciones de proveedores a cargo del dueño. CurseForge: cargar la clave desde Administración y probar el proveedor con una sesión real.
- Flujos reales con usuarios/JWT de Auth, Storage y Realtime, concurrencia y entrega de push. La estructura en producción y pg_net ya se comprobaron; faltan la configuración privada de push en Vault y las pruebas completas con cuentas/dispositivos. Los getters con UUID sin cuenta y las respuestas HTTP sin sesión no certifican esos comportamientos.

## Publicación coordinada pendiente

La fuente de la activación inicial 0028–0036 es el commit `cbedf16`, de la rama `venus-3.2-funciones`, ya subida a GitHub en el [PR #1](https://github.com/rponfee/Venus-Launcher/pull/1). La activación posterior de 0037/CurseForge tiene sus propios hashes registrados. **0028–0037 y las tres funciones Edge nuevas ya están en producción.** No se hizo merge, release ni publicación de `web/`. Quedan la configuración de credenciales, las comprobaciones externas y esas publicaciones, cada una con la autorización correspondiente; no corresponde volver a aplicar las migraciones como un paso pendiente.

No redesplegar `admin`, `ai-assistant` ni `billing` desde el repo sin reconciliarlos con lo desplegado: se informó divergencia. La lista de despliegues comprobada confirma que esas tres funciones no se reemplazaron.
