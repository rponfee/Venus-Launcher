# Activación del backend de Venus 4.5.0

Registro del **4 de noviembre de 2026**. Con autorización del dueño, se aplicaron completas las migraciones **0028–0036 en producción** y se desplegaron `push-notify` y `tiktok-token`. Después se autorizó y completó la activación de **0037 y la Edge Function `curseforge`**, detallada en su sección. Este documento registra esa activación y sus comprobaciones; no afirma que todas las funciones estén probadas de punta a punta.

La fuente aplicada para **0028–0036** fue **`cbedf16`**, de la rama `venus-3.2-funciones`, ya subida a GitHub en el [PR #1](https://github.com/rponfee/Venus-Launcher/pull/1). **No hubo merge, release ni publicación de `web/`.** Este registro actualiza las menciones históricas a producción hasta 0027 o a migraciones pendientes en los documentos de implementación.

## Migraciones 0028–0036 aplicadas

Se aplicaron en este orden, con las siguientes versiones y nombres registrados:

| Archivo fuente | Versión | Nombre registrado |
|---|---|---|
| `0028_sync_ajustes.sql` | `20261104162950` | `venus_0028_sync_ajustes` |
| `0029_resenas_servidores.sql` | `20261104162959` | `venus_0029_resenas_servidores` |
| `0030_stickers.sql` | `20261104163115` | `venus_0030_stickers` |
| `0031_competencia.sql` | `20261104163154` | `venus_0031_competencia` |
| `0032_galeria_clips.sql` | `20261104163204` | `venus_0032_galeria_clips` |
| `0033_clanes_comunidades.sql` | `20261104163249` | `venus_0033_clanes_comunidades` |
| `0034_capas.sql` | `20261104163300` | `venus_0034_capas` |
| `0035_app_celular.sql` | `20261104163731` | `venus_0035_app_celular` |
| `0036_extensiones.sql` | `20261104163806` | `venus_0036_extensiones` |

La verificación de producción de **0028–0036** encontró **32/32 tablas con RLS y 183/183 funciones** de ese inventario. El motivo **`challenge`** se conservó en la restricción de `points_ledger.reason`. **`community_messages` está en la publicación Realtime**. **pg_net 0.20.4 está instalado** y el esquema **`net` no está expuesto** por la API.

Estos resultados comprueban presencia y configuración estructural; no certifican por sí solos cada política con usuarios reales, concurrencia ni entrega de eventos. No corresponde reaplicar migraciones anteriores: los cambios posteriores deben tener su propia migración.

## Funciones Edge desplegadas

| Función | Versión/estado | Verificación JWT | Respuesta observada |
|---|---|---|---|
| `push-notify` | v1 **ACTIVE** | `verify_jwt = false` | HTTP **503**, `not_configured`: credenciales pendientes. |
| `tiktok-token` | v1 **ACTIVE** | `verify_jwt = true` | HTTP **503**, `not_configured`: credenciales pendientes. |
| `curseforge` | v1 **ACTIVE** | `verify_jwt = true` | Preflight **OPTIONS 204**, CORS `*`; **POST 401** sin autenticación. Clave aún sin cargar. |

`push-notify` ofrece VAPID pública por GET cuando está configurada; POST valida el secreto del disparo dentro de la función. `verify_jwt = false` no convierte el envío en una operación pública. `tiktok-token` exige sesión y mantiene la credencial confidencial del proveedor en el servidor.

`admin`, `ai-assistant` y `billing` **no se reemplazaron**, según la lista de despliegues comprobada. Se informó que difieren del código del repo; hay que reconciliarlas antes de cualquier despliegue de esas funciones.

## CurseForge: activado para configurar la API

El **4 de noviembre de 2026**, el dueño autorizó activar la sección para cargar la API de CurseForge. Se aplicó **`0037_curseforge_admin.sql`** completa y se desplegó **`curseforge` v1 ACTIVE**, con **`verify_jwt = true`**. La función `admin` existente no se reemplazó.

| Artefacto | Versión | SHA-256 registrado |
|---|---|---|
| `0037_curseforge_admin.sql` | `20261104170221` en el historial de migraciones | `f266bae4d9f0d7126ef50f00f689c18dfd06d3966fd4127ed35a4a5b92019ed3` |
| Edge Function `curseforge` | v1 ACTIVE, JWT activado | `01b485382061d3984a8e2008bc0aded1e0b3c196a1f644c2a3acd551ad6196c6` |

La sección **Administración → Integraciones → CurseForge** usa `admin_curseforge_status()` y `admin_set_curseforge_key(p_key)`. La clave se configura en Vault y el panel recibe estado y los últimos cuatro caracteres. `curseforge_status()` solo informa si hay configuración; `curseforge_proxy_access(p_user)` permite recuperarla al servidor con `service_role` y aplica el límite de 240 consultas por minuto y cuenta.

**Comprobaciones de producción posteriores a la activación:**

| Lectura o petición | Resultado observado |
|---|---|
| Estado público `curseforge_status()` por HTTP | **200**, `configured: false`: el dueño todavía no cargó la clave. |
| Preflight del navegador, `OPTIONS` a `curseforge` | **204**, `Access-Control-Allow-Origin: *`. |
| `POST` a `curseforge` sin autenticación | **401**. |
| `private.curseforge_rate` | **RLS activado**. |
| Permisos de ejecución | `anon` sin acceso a las RPC administrativas; `authenticated` sin acceso a `curseforge_proxy_access`; `service_role` con acceso a esa RPC. |

Estos permisos se comprobaron sin recuperar ninguna clave real. Las respuestas HTTP confirman el estado sin configurar, CORS y el rechazo sin autenticación; no prueban un flujo autenticado contra CurseForge.

**Validación local previa y de integración:** **84/84 comprobaciones SQL**, **82/82 pruebas Node de main/Edge/UI**, **56/56 de estado de servicios**, **2613/2613 archivos en sintaxis**, **0 canales IPC sin handler** e **i18n inglés con salida 0**. El ensayo SQL usó PostgreSQL 17.11, fixtures mínimos y 0001–0036 completas en una base nueva; 0037 y los escenarios quedaron dentro de `BEGIN/ROLLBACK`. Se verificaron guardado, reemplazo y borrado, estado público, ACL, bloqueos, cuota por cuenta, cambio de ventana, limpieza al eliminar usuarios y auditoría sin valores de claves. Esquema, permisos, filas y secuencias quedaron iguales después; el clúster se apagó y los archivos de entrada no cambiaron.

El [test SQL](../supabase/tests/curseforge-admin-local.sql) y su [runner](../scripts/run-curseforge-admin-local.ps1) son reproducibles. Evidencia local: `%TEMP%/venus-curseforge-sql-20261104-140020-cc533da2/result.json`. Vault se sustituyó solo dentro de la transacción por un stub con valores ficticios: **no se probó cifrado real de Vault, JWT real, concurrencia ni el proveedor CurseForge**. No se usaron cuentas reales ni se enviaron mensajes.

**Pendiente:** el dueño debe cargar la clave desde la sección habilitada y comprobar el proveedor. La portable con este cambio ya se compiló: `VenusLauncher-CurseForge-Portable.exe`, **146.066.437 bytes**, sin firma digital. SHA-256: `023C24A6A51FB6F9EC9410228B40FBA912FF2AB681E0F325ACD2EFD80246888C`. Se entregó localmente en Descargas; no se publicó una release. `check-package` aprobó 7614 archivos/69,8 MiB, `smoke-packaged` comprobó arranque, interfaz y versión 4.5.0 con datos temporales. Los 36 archivos de aplicación modificados comparados coinciden con el paquete; no lleva clave de CurseForge compilada. Capturas ES/EN de la tarjeta con RPC ficticios y consola sin errores.

## Comprobaciones realizadas y alcance

**Ensayo local del 3 de noviembre.** La suite SQL sí se ejecutó en PostgreSQL 17.11: **1282 comprobaciones, 1225 estructurales y 57 escenarios**, con 0001–0027 completas en una base temporal nueva y 0028–0036 completas dentro de `BEGIN/ROLLBACK`. El esquema/ACL, las filas y las secuencias quedaron iguales después. Ese entorno usó fixtures mínimos de Auth/Storage/Realtime, sin pg_net real y con sustitutos de push/Realtime; no comprobó servicios administrados. Evidencia y guardas en la [revisión SQL](implementacion/revision-sql-0028-0036.md) y el [estado de integración](estado-4.5.0.md).

**Lecturas SQL de producción del 4 de noviembre.** Se ejecutaron **18 getters** dentro de una transacción `BEGIN READ ONLY`, con `SET LOCAL ROLE authenticated`, un UUID aleatorio **sin cuenta** y cierre con `ROLLBACK`. **17 devolvieron la forma esperada**; `cape_mine` devolvió **`NULL` sin perfil**. `clan_me` incluye el campo de consentimiento y `clan_ranking` devuelve **`available: true`**. No se crearon registros.

El rol y el UUID de esas lecturas no son una sesión autenticada real: **no se probó un JWT válido ni un flujo con usuarios reales**. El resultado nulo de `cape_mine` es el esperado para esa identidad sin perfil; no demuestra equipamiento ni renderizado de una capa.

**Rutas HTTP reales.** Se comprobaron **19 rutas**: **3 HTTP 200 públicos**, **16 HTTP 401 con código `42501` sin sesión** y **0 HTTP 404**. Evidencia: `%TEMP%/venus-backend-http-20261104.json`. Esto muestra que las rutas comprobadas ya no faltan y rechazan llamadas sin sesión cuando corresponde. No demuestra que los usuarios autenticados puedan completar las operaciones. Los dos HTTP 503 de las funciones Edge se registran por separado en la tabla anterior.

## Configuración pendiente a cargo del dueño

El dueño confirmó que **configurará personalmente push**. Los materiales privados ya están preparados; no deben regenerarse ni pedirse por chat. **No se incluyen valores ni ubicaciones privadas en el repositorio.**

Quedan por cargar las tres variables del servidor: `VENUS_VAPID_PUBLIC`, `VENUS_VAPID_PRIVATE` y `VENUS_PUSH_SECRET`. También queda ejecutar el **`configure-push.sql` privado**, que configura el endpoint y el secreto del disparo mediante `private.push_configure`. No había entradas `venus_push_url` ni `venus_push_secret`; la consulta se limitó a esos nombres. La presencia de pg_net y el despliegue de la función no reemplazan esta configuración.

TikTok sigue pendiente de sus credenciales del servidor (`TIKTOK_CLIENT_KEY` y `TIKTOK_CLIENT_SECRET`), aprobación/configuración del proveedor y OAuth real. YouTube necesita su cliente público y configuración de API/OAuth. El launcher distribuye únicamente `tiktokClientKey` y `youtubeClientId`; no deben incorporarse secretos OAuth al instalador.

## Lo que sigue sin demostrarse

- Flujos con JWT y usuarios reales, permisos efectivos sobre datos propios, escrituras de Storage y concurrencia.
- Entrega de Realtime entre dos sesiones y Web Push recibido en un teléfono después de configurar las credenciales.
- Publicación de la web/PWA, HTTPS, login e instalación en Android/iPhone.
- OAuth y subidas reales a YouTube/TikTok; IA con proveedor/plan real, pagos, voz entre PC, OBS, Discord y las demás integraciones externas.
- CurseForge con una clave real cargada por el dueño y una sesión válida; la activación para configurarla ya se completó.
- Minecraft real: capas, FPS, overlay, opciones compartidas, límites de familia y marcadores.
- Publicación del launcher: merge, release y distribución continúan fuera de esta activación.

Las referencias operativas son [Supabase](supabase.md), [Edge Functions](../supabase/functions/README.md) y [estado de integración](estado-4.5.0.md). La activación de contratos y despliegues se considera completada dentro del alcance registrado; las credenciales y pruebas anteriores siguen pendientes.
