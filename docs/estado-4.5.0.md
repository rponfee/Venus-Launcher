# Estado de integración de Venus 4.5.0

Cierre documental del 3 de noviembre de 2026. **Las 35 funciones están implementadas para 4.5.0 en la rama `venus-3.2-funciones`, sin publicar.** La marca ☑ de la [hoja de ruta](hoja-de-ruta.md) registra implementación; no certifica servicios reales, despliegues ni validación externa completa. La versión publicada de referencia sigue siendo 3.1.0. La integración principal verificó que producción llega hasta **0027**: 0028–0036 continúan pendientes allí.

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

La integración ejecutó las pruebas de aplicación, navegador, vídeo, mod y paquete; el agente SQL ejecutó PostgreSQL local. Los resultados siguientes corresponden a los artefactos indicados. Los informes anteriores se conservan como antecedentes, con su alcance.

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

La prueba SQL usa fixtures mínimos de Auth, Storage y Realtime; **pg_net está ausente**, Vault es un catálogo vacío y push/Realtime tienen sustitutos locales durante los escenarios. Es PostgreSQL real, **no Supabase administrado** ni validación de servicios. La [revisión SQL completa](implementacion/revision-sql-0028-0036.md) conserva comandos, guardas, fallos de preparación y limitaciones. No queda pendiente esa ejecución local; sigue pendiente la integración con servicios reales. Después de la prueba se actualizaron únicamente diez referencias documentales en comentarios de las nueve migraciones; el registro de hashes antes/después está en `sql-comment-path-updates.json` y no cambió ninguna sentencia SQL.

También se informó la recuperación de Electron/ICU y la comprobación de permisos con micrófono simulado y Notification concedido. El smoke usa `SMOKE_TEST` para evitar registrar el protocolo y cambiar el foco durante la prueba. Eso no valida micrófono físico ni llamadas entre PC.

## Traducciones y entrega local

- **Las doce traducciones adicionales están completas: 28.512 entradas base y 0 claves faltantes.** Hume cerró RU/UK con 204 formas `_few`/`_many` y **2240 comprobaciones con `t()` aprobadas**. Las fuentes i18n quedaron congeladas. `i18n-check --summary` devuelve **exit 1 únicamente por los dos archivos `admin` excluidos por idioma**; no se informa exit 0. La integración volvió a ejecutar el control global al cierre: **0 claves faltantes, 0 variables distintas y 0 sobrantes**; inglés también terminó con exit 0.
- **Instalador NSIS y portable 4.5.0 compilados localmente**, sin publicación ni firma digital. `check-package` aprobó **7613 archivos y 69,7 MiB**. `smoke-packaged --tamper` aprobó arranque, interfaz, versión, fuses, copia de control y rechazo de una copia alterada. Evidencia: `package-build.log`, `package-check.log`, `package-smoke.log` y tamaños/SHA-256/estado de firma en `package-artifacts.json`, bajo el directorio temporal de esta revisión.
- Ejecutables: `package-4.5.0/VenusLauncher-Setup.exe` y `package-4.5.0/VenusLauncher-Portable.exe`. El build local no contiene configuración de CurseForge ni identificadores OAuth de YouTube/TikTok; esas integraciones necesitan su configuración para la release.
- La web incluye **App para celular** en el pie, con destino relativo `app/`. Respeta la cuenta regresiva existente y estará disponible al publicar el sitio junto con la PWA.

## Pruebas externas pendientes

- Instalación, actualización y desinstalación NSIS en un Windows aislado; el ejecutable empaquetado se probó con datos temporales, sin reemplazar la instalación del usuario.
- Minecraft real: capas/elytra, FPS, ajustes compartidos, cierre por modo familia, marcadores, superposición/foco del overlay y semillas frente al juego.
- Dos PC/cuentas y micrófono físico: voz, soundboard, efectos, señales y Realtime. Las capturas con servicios falsos no validan estas funciones de punta a punta.
- Celular Android e iPhone: control remoto LAN, instalación PWA, teclado/áreas seguras, login y Web Push real. La comprobación de caché y shell en Chromium no cubre esos dispositivos.
- Discord webhook, IA con plan real, OBS, OAuth y subidas a YouTube/TikTok; credenciales, VAPID y aprobaciones de proveedores a cargo del dueño.
- Stack Supabase con Auth/Storage/Realtime, Vault y pg_net reales, concurrencia y entrega de push. La prueba local de una sola transacción no certifica esos comportamientos.

## Publicación coordinada pendiente

No se hizo deploy, commit, push ni release en este cierre. Antes de publicar se acuerdan orden y autorizaciones: integrar la rama, tag/release, aplicar 0028–0036 en orden, desplegar únicamente las funciones aprobadas y publicar `web/`. Los cambios de workflows los sube el dueño.

No redesplegar `admin`, `ai-assistant` ni `billing` desde el repo sin reconciliarlos con lo desplegado: se informó divergencia. La documentación de despliegue prepara esos pasos; no demuestra que se hayan ejecutado.
