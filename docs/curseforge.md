# CurseForge en Venus Launcher

La clave se carga desde **Administración → Integraciones → CurseForge** y se conserva cifrada en Vault. El launcher usa su sesión de Venus para consultar la función `curseforge`; nunca recibe la clave central. Las instalaciones siguen los permisos de distribución de cada autor.

## Comprobar la clave

1. Pegá la clave API de la solicitud aprobada para el launcher y elegí **Guardar clave** o **Reemplazar clave**.
2. Elegí **Probar búsqueda**. Consulta `/v1/mods/search?gameId=432&classId=6&pageSize=1` por el mismo servicio que usa el catálogo.
3. Un resultado correcto confirma una búsqueda de Minecraft. Guardar una clave solo confirma que se guardó. Cargar las categorías tampoco demuestra acceso a búsquedas.

Si CurseForge rechaza la clave, el panel lo explica y permite reemplazarla. La anterior se conserva hasta guardar otra o quitarla. El catálogo distingue ese error de una cuenta sin permisos, una sesión vencida y un límite de consultas. Los errores no muestran cuerpos remotos ni claves.

## Diagnóstico del 4 de noviembre de 2026

- La primera clave guardada era de CurseForge Profile, no la clave aprobada para el launcher. Las categorías respondían HTTP 200, pero las búsquedas de mods recibían HTTP 403.
- Después de reemplazarla por la clave del launcher, una búsqueda mínima y la consulta con filtros que usa el catálogo respondieron **HTTP 200** desde el servidor; la segunda devolvió un resultado. La clave no salió del servidor.
- La prueba directa confirma acceso de esa clave al endpoint de búsqueda. Las pruebas de código cubren el proxy y la interfaz, pero todavía falta comprobar el recorrido completo con una sesión real dentro de la app.

Referencia del contrato: [documentación oficial de CurseForge](https://docs.curseforge.com/rest-api/).

### Arreglo de la 4.6: por qué no cargaba el catálogo

#### Qué pasaba (evidencia)

Registros de la función `curseforge` en producción, últimas 24 horas (solo lectura, una única cuenta usa la función):

| Momento (UTC) | Qué se vio |
|---|---|
| 4 de noviembre, 17:09 a 17:58 | 29 respuestas 403 en búsquedas con la clave de CurseForge Profile; las categorías respondían 200. |
| 4 de noviembre, 17:59:12 | Se reemplaza la clave desde Administración (queda en el registro de acciones, 12 cambios ese día). Desde ahí **~110 búsquedas con 200** hasta las 22:57. |
| 5 de noviembre, 16:14 a 16:31 | **6 búsquedas del catálogo con 403**, las mismas formas de pedido que antes daban 200. A las 16:15:40 se vuelve a guardar la clave desde Administración y el siguiente pedido (16:15:45) y otro a las 16:31 siguen en 403. |

Lo que se pudo descartar:

- **No es la cuenta ni la sesión.** El 403 del servidor para una cuenta bloqueada es otro código (`forbidden`), y la cuenta cumple todas las condiciones de `curseforge_proxy_access` (existe, no está baneada, no es anónima, sin bloqueo social). Además esa RPC dejó su fila de cuota a las 16:31:39: el pedido **pasó** el control de acceso y llegó a CurseForge.
- **No es el código desplegado.** `get_edge_function` devuelve el mismo `handler.ts` e `index.ts` que el repo (v1, `verify_jwt = true`).
- **No son los parámetros de la búsqueda.** Los pedidos del 5 de noviembre tienen el mismo contrato y los mismos parámetros que los que respondieron 200 el 4.
- **No es el estado.** `curseforge_status` y la cuenta responden bien; falló la búsqueda, no el "configurado".

Entonces el 403 viene de `api.curseforge.com`. Una prueba mía con una clave inventada (no la real) mostró cómo contesta CurseForge: con una clave inválida, `403 text/plain "Forbidden: API Key missing or invalid"` (de su aplicación); sin la cabecera de clave, `403` vacío de CloudFront. **Y el proxy tiraba esa respuesta y devolvía siempre `badkey`**: desde afuera, y desde los registros, era imposible distinguir una clave mala de un corte del borde de CurseForge o de un archivo cuyo autor no permite la descarga. Eso es lo que impedía diagnosticar y lo que hacía que el launcher dijera "la clave fue rechazada" para todo.

> Con la información disponible **no se puede afirmar** si CurseForge rechazó la clave el 5 de noviembre o si bloqueó el pedido del servidor: esa respuesta nunca se guardó. La corrección de abajo hace que quede registrada (sin el texto remoto) y que la prueba de Administración lo diga.

#### Causas encontradas en el código y qué se cambió

1. **El proxy colapsaba todo en `badkey` y descartaba la respuesta** (`supabase/functions/curseforge/handler.ts`). Ahora lee como mucho 4 KB del rechazo y lo clasifica **sin devolver ni registrar su texto**:
   - `badkey`: CurseForge dijo que la clave falta o no sirve.
   - `blocked`: el pedido no llegó a su aplicación (página HTML del borde, o 403 vacío de CloudFront).
   - `denied`: CurseForge entendió el pedido pero ese archivo/descarga no se puede pedir (autor sin distribución).
   El servidor deja una línea de diagnóstico en los registros de la función (`curseforge.rejected`, `curseforge.limited`, `curseforge.upstream`, `curseforge.network`) con estado, clasificación, tipo de contenido y el valor del encabezado `server`; nunca la clave, la sesión ni el cuerpo.
2. **Una consulta de estado caída contaba como "CurseForge no está configurado"** (`modules/curseforge/cloud.js`, `api.js`). Cualquier falla de red, timeout o 5xx de `curseforge_status` devolvía `false`, el catálogo mostraba la tarjeta "no disponible" y **no volvía a preguntar mientras la página seguía abierta**. Ahora el estado es `on`, `off` o `unknown`; si no se pudo preguntar se sigue con lo último que se supo (10 minutos) o se intenta igual (el servidor contesta con precisión), y la tarjeta "no disponible" aparece solo cuando el servidor dice que no hay clave. Además la tarjeta tiene **Revisar de nuevo** y se vuelve a revisar al iniciar sesión.
3. **Un 401 con un token que parecía vigente decía "iniciá sesión"** (reloj de la PC atrasado o sesión revocada). Ahora se pide una renovación a la interfaz una sola vez, se espera un token distinto y se reintenta; recién si no hay, se pide iniciar sesión.
4. **Sin sesión de Venus no había explicación**: ahora hay una tarjeta "Iniciá sesión para usar CurseForge" con el botón que lleva al inicio de sesión, en el catálogo y en el detalle de un proyecto.
5. **Los builds con clave propia no tenían respaldo**: si el catálogo central falla (clave rechazada, bloqueo, red o servidor) y el build trae su clave, el pedido se repite con esa clave. No se tapan la sesión vencida, la cuenta bloqueada ni un archivo inexistente.
6. **Errores con mensaje propio**: clave rechazada, cortado antes de revisar la clave, cuenta sin permiso, sin sesión, sin clave en el servidor, límite de consultas, servidor caído, red; en el catálogo los de servidor ofrecen **Volver a Modrinth**. `download-url` con `denied` sigue devolviendo "descarga manual".
7. **Administración → Probar búsqueda** explica `blocked`, `not_configured`, `unavailable` y `upstream` además de lo que ya explicaba.

#### Qué hay que desplegar (y qué no)

Solo **la función `curseforge`**: `supabase functions deploy curseforge` (con `verify_jwt = true`, como está). Archivos que cambian: `supabase/functions/curseforge/handler.ts`; `index.ts` no cambia. **No hay migración, ni cambios en `admin`, `ai-assistant` ni `billing`.** El launcher funciona con la función vieja (cae al mensaje de clave rechazada como hasta ahora) y mejora con la nueva.

#### Qué tiene que probar el dueño con su sesión real

1. Desplegar `curseforge` y, en Administración → Integraciones → CurseForge, **Probar búsqueda**. El mensaje dice cuál de estos casos es: funciona, **CurseForge rechazó la clave** (`badkey`: reemplazarla por la clave aprobada para el launcher), **CurseForge cortó la consulta antes de revisar la clave** (`blocked`: la clave puede estar bien; es un bloqueo del borde, probar de nuevo en unos minutos) o error propio de CurseForge.
2. En los registros de la función (Supabase → Edge Functions → `curseforge` → Logs) aparece la línea `curseforge.rejected` con `kind` y `server`.
3. Con la sesión de Venus iniciada, abrir Contenidos → CurseForge: tiene que listar mods; con la sesión cerrada tiene que mostrar la tarjeta de iniciar sesión.

**No se probó:** el recorrido completo con una sesión real y la clave real (no se las usó a propósito), el proveedor CurseForge, ni un despliegue.

#### Pruebas

- `node --test supabase/functions/curseforge/tests/handler.test.ts` (66 pruebas; 11 nuevas: clasificación `badkey`/`blocked`/`denied`, HTML enorme, descarga con autor sin permiso, el registro no contiene claves ni texto remoto, 429/5xx/red).
- `node --test src/main/modules/curseforge/test/cloud.test.js` (23; 12 nuevas: estado `on`/`off`/`unknown`, falla pasajera del estado, un caso por cada falla con su código, búsqueda vacía, parámetros de búsqueda, renovación en 401, respaldo con clave compilada y lo que no tapa, clasificación del 403 directo, `getDownloadUrl`).
- `node --test src/renderer/js/pages/modrinth/test/curseforge-gate.test.js` (4, nuevas) y `node --test src/renderer/js/pages/admin/test/integrations.test.js` (28; 7 nuevas).
- Ventana de desarrollo con un servidor falso de Supabase (nunca producción): catálogo con resultados, clave rechazada, cortado por el borde, cuenta sin permiso, 429, 503, vacío, sesión vencida, sin sesión, sin clave en el servidor y consulta de estado caída (el catálogo igual carga), en español e inglés, con `console.log` vacío.
