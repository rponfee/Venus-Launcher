# Revisión defensiva SQL 0028–0036 · 2026-11-03

> **Rama 4.5.0, sin publicar.** Informe final completo del frente SQL, reconciliado el 3 de noviembre de 2026 con su WIP congelado. Se conserva el contenido, los comandos y las limitaciones; solo cambia la autorreferencia a esta ruta permanente. Ver [estado de integración](../estado-4.5.0.md).

Este informe pertenece al frente SQL. No reemplaza los informes de UI de los otros agentes. Trabajo local en C:\Users\ringo\Downloads\Venus Launcher; sin commit, push, despliegue, conexión remota, cambios de credenciales ni nuevas dependencias del repositorio. PostgreSQL portátil se descargó en TEMP con autorización explícita. Se conservaron los cambios previos y se escribieron los archivos de este frente con CRLF.

## Resultado y evidencia

**Prueba SQL local completa ejecutada y aprobada el 2026-11-03:** PostgreSQL 17.11 portátil, base nueva sin usuarios, 0001–0027 completas y 0028–0036 completas en una única transacción BEGIN/ROLLBACK. **1282 comprobaciones: 1225 estructurales y 57 escenarios legítimos.** El permiso separado de horas de clanes, los premios challenge, las transferencias de propiedad, la moderación y las tres rutas internas de push pasaron sus aserciones.

El ensayo final usó la query expandida de scripts/build-migrations-0028-0036-query.js --mode all, sin metacomandos psql ni migraciones recortadas. Antes y después del rollback se compararon:

- pg_dump --schema-only completo, incluidas ACL y propietarios; solo se excluyeron las marcas aleatorias restrict/unrestrict de pg_dump.
- Cantidades y huellas ordenadas de todas las filas de public/private/auth/storage/realtime/vault, y last_value/is_called de todas sus secuencias.
- SHA-256 de las 36 migraciones, el fixture, el harness y el generador: no cambiaron durante la ejecución.

Las comparaciones fueron idénticas. La base inicial adicional terminó con **0 usuarios, 0 secretos ficticios, pg_net ausente y sin clan_prefs**; ambos servidores de prueba quedaron detenidos. Solo se conservan archivos de prueba y evidencia en TEMP.

Evidencia final: C:\Users\ringo\AppData\Local\Temp\venus-sql-run-20261103-234145-713ff653

- result.json: ok=true, restauración de esquema/ACL, filas y secuencias, inputsUnchanged=true.
- harness.log: 1282 comprobaciones, 57 etiquetas, ROLLBACK y DO posterior, exit code 0.
- harness.sql: 297922 bytes, SHA-256 3ea19a96852dfe7cdc9e817523cc792c170164616e4cceedfb97fc458fb15316.
- baseline.log y fixtures.log: construcción desde cero. inputs.json: archivos y hashes exactos.
- schema-before.sql / schema-after.sql y state-before.json / state-after.json: comparación del estado.
- stop.log: apagado correcto del cluster exclusivo del runner.

**Límite preciso:** esto prueba PostgreSQL real con fixtures parciales de Supabase. No es un stack Supabase administrado. Se crean roles/default grants, tablas mínimas de Auth/Storage, helpers de identidad/rutas y el contrato Realtime. Vault es un catálogo vacío que no admite filas, requerido para compilar 0017; no hay cifrado ni secretos. No se simuló una extensión pg_net instalada: 0035 ejecutó su CREATE EXTENSION original y registró 0A000, usando su degradación prevista. El harness sustituyó push_dispatch y realtime.send antes de los escenarios. No se verifican autenticación por HTTP, archivos, entrega Realtime/Web Push ni Vault real.

### Entorno y reproducción

WSL respondió que no está instalado; Docker, Podman y PostgreSQL no estaban en PATH. La [documentación oficial de Supabase](https://supabase.com/docs/guides/local-development/docker-and-native-runtimes) limita el runtime nativo a Linux y macOS Apple silicon: Windows requiere Docker. No se instaló WSL/Docker ni se cambió la configuración global del equipo.

PostgreSQL se obtuvo del [ZIP oficial enlazado por EDB](https://www.enterprisedb.com/download-postgresql-binaries): https://get.enterprisedb.com/postgresql/postgresql-17.11-5-windows-x64-binaries.zip. Versión ejecutada: 17.11; 381531864 bytes; SHA-256 local 80379b2c04d51c30225532e0ae04509899141e9957ed096fe749d7fd9df8f82f. postgres.exe informó Authenticode NotSigned; el hash registra el archivo recibido por HTTPS, no es una firma de editor verificada. Referencia de [PostgreSQL para Windows](https://www.postgresql.org/download/windows/).

Desde el repositorio, con los binarios conservados:

    & .\scripts\run-migrations-0028-0036-local.ps1 -PgBin "$env:TEMP\venus-sql-pg17-20261103\pgsql\bin"

El runner exige binarios en TEMP, elige una carpeta nueva, usa loopback IPv4 y puerto 54438 (configurable), crea la base venus_sql_test, ejecuta todo y detiene únicamente su propio cluster en finally. No descarga herramientas, no instala servicios, no usa credenciales y no borra archivos. Mantiene logs de cada ejecución. El bootstrap 0001–0027 hace COMMIT solo en esa base temporal; las nueve migraciones nuevas y todos los usuarios ficticios siempre terminan en ROLLBACK.

### Fallos encontrados durante la preparación

- El primer bootstrap encontró que 0017 necesita vault.decrypted_secrets al crear una función SQL. Se añadió únicamente el fixture vacío; no se alteró 0017 ni se buscó un secreto.
- El primer harness alcanzó 0035, pero no había mensaje sin leer: now() permanece constante en una transacción y coincidían last_read_at y created_at. Se preparó una lectura anterior ficticia y se reforzó la aserción para exigir un mensaje, evitando un resultado vacío que pasara por accidente. Se corrigió además la ambigüedad del nombre de variable v_conversation_id del fixture.
- El primer runner quedó esperando una tubería heredada al arrancar pg_ctl. Se detuvo solo ese cluster y se corrigió con Start-Process oculto, redirección a archivos y espera del iniciador, no de todo el árbol. El runner final terminó en 8.7 segundos con exit code 0.
- No aparecieron fallos nuevos de negocio que exigieran modificar las migraciones durante esta ejecución. Las correcciones defensivas previas siguen detalladas abajo.

Comprobaciones adicionales: checker estático (9 migraciones, 183 funciones, 32 tablas), sintaxis JS, generación all/structural, CRLF y diff de espacios. La suite global la corre el agente principal y no se duplicó. Sus pruebas de UI/Node no se cuentan como evidencia SQL de este frente.

## Cambios

| Migración | Resultado de la revisión y corrección local |
|---|---|
| 0028_sync_ajustes.sql | Mantiene aislamiento por auth.uid(), versión optimista, objeto JSON y 64 KB. Revoca también PUBLIC en la tabla. |
| 0029_resenas_servidores.sql | RPC de escritura con identidad y moderación; lecturas anónimas intencionales, guardia de admin, reseñas/votos/denuncias acotados. Revoca también PUBLIC en las tres tablas. |
| 0030_stickers.sql | El chequeo de cuota de archivos contaba sin serializar subidas. sticker_can_upload pasa a PL/pgSQL VOLATILE, verifica que p_user sea auth.uid() y toma un bloqueo transaccional por cuenta antes de contar. Revoca PUBLIC en user_stickers. No se cambian MIME, tamaños ni precios. |
| 0031_competencia.sql | event_join bloqueaba el evento, pero el tope de 50 inscripciones de una cuenta abarca eventos distintos. Se agrega bloqueo por cuenta antes del evento. Conserva challenge y los once motivos anteriores de points_ledger. |
| 0032_galeria_clips.sql | gallery_mine y admin_gallery_list entregaban m.url sin la misma validación usada en la galería pública. Ahora revalidan ruta/formato y ambos vencimientos; devuelven null y expired cuando no sirve. gallery_unpublish bloquea la fila antes de comprobar hidden para coordinar con moderación. Revocación de PUBLIC en las tres tablas. |
| 0033_clanes_comunidades.sql | Consentimiento público separado (contrato abajo). Bloqueos para topes de invitaciones/solicitudes, pertenencias por cuenta, transferencia de comunidades y último canal de texto. Cambios de roles de clan/comunidad bloquean y vuelven a comprobar las pertenencias; los UPDATE de clan se limitan al clan autorizado. |
| 0034_capas.sql | Mantiene propiedad/Premium, Minecraft verificado y lote público de hasta 100 UUID. Solo se amplía la revocación a PUBLIC en user_capes. Precios existentes confirmados por el usuario; no se modifican. |
| 0035_app_celular.sql | social_send_signal usa search_path vacío; todas sus referencias ya estaban calificadas. app_inbox filtra las conversaciones bloqueadas por quien consulta, como promete su contrato. media_share_note serializa la retención de 200 recibidos por destinatario. push_claim y push_drop siguen reservadas a service_role; push_configure sigue sin permiso para roles de API. |
| 0036_extensiones.sql | Conserva dueño, revisión administrativa, versión inmutable en Storage, manifiesto cerrado y cuotas de envío. Se revoca también PUBLIC en ambas tablas. No se cambia el catálogo ni la política del launcher apagado. |

La revocación adicional de PUBLIC es endurecimiento explícito de la ACL heredada. No se afirma que se haya observado una concesión real a PUBLIC en la base remota. Los permisos efectivos se verificaron en el catálogo PostgreSQL local con los defaults del fixture; el entorno administrado puede tener diferencias.

## Contrato del permiso de horas de clan

Decisión explícita del usuario: aportar horas al total público exige un permiso separado, **apagado por defecto**. Se coordinó con el agente de semillas/clanes, que tiene la UI y los textos es/en; este frente conserva la propiedad de los SQL.

- public.clan_prefs(user_id PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE, share_playtime boolean NOT NULL DEFAULT false, updated_at). RLS activado; sin lectura/escritura directa para PUBLIC, anon o authenticated.
- public.clan_share_playtime(p_share boolean) devuelve { sharePlaytime: boolean }. Usa exclusivamente auth.uid(); null equivale a false. Sin sesión: not_authenticated / 42501. Se puede apagar incluso estando baneado.
- public.clan_me() agrega sharePlaytime en la raíz; false si no existe preferencia, también sin clan.
- private.clan_shared y public.clan_ranking requieren **ranking_prefs.share Y clan_prefs.share_playtime**; excluyen baneados y mantienen el mínimo de dos aportantes.
- No cambia ranking_set_share, ranking_report ni el ranking entre amigos. El permiso nuevo no habilita recolección adicional. Si compartir con amigos está apagado, tampoco hay aporte al clan.
- Es un permiso de la cuenta, conservado al cambiar de clan. Al activarlo cuentan las horas ya informadas; al apagarlo se retiran de las agregaciones posteriores. El agregado no garantiza anonimato. La UI acordada explica esto y confirma la activación.
- La 0033 sigue funcionando sin 0031: los accesos a sus tablas siguen en SQL dinámico y conservan available: false.

## Qué ejecutar después

### 1. Preflight remoto de solo lectura

supabase/tests/migrations-0028-0036-preflight-readonly.sql es SQL puro, **BEGIN READ ONLY / ROLLBACK**. El agente principal puede pasar su texto completo al execute_sql que tenga autorizado.

Solo consulta pg_catalog: existencia de esquemas/tablas/funciones base, roles, extensiones, la clave de configuración pgrst.db_schemas, RLS, ACL de las 32 tablas y 183 funciones esperadas, políticas, constraint de motivos, triggers de datos y de DDL. No imprime cuerpos de funciones ni consulta auth.users, perfiles, endpoints, Vault o datos de negocio. La detección de referencias a red/Vault en triggers devuelve únicamente un booleano; no sigue llamadas indirectas. No cambia ningún objeto.

En una base hasta 0027 es normal que casi todos los objetos nuevos aparezcan como inexistentes y que points_ledger_reason_check todavía no tenga challenge. La consulta de esquemas expuestos informa lo visible desde PostgreSQL; un valor vacío no demuestra la configuración externa de PostgREST. No hay que agregar net a los esquemas expuestos.

### 2. Ensayo estructural con rollback, sin escenarios

El generador arma SQL puro en memoria y **no ejecuta nada**. Por defecto usa el modo structural. Para escribir una query completa en un archivo nuevo:

    node scripts/build-migrations-0028-0036-query.js --mode structural --output "$env:TEMP\venus-sql-structure-20261103.sql"

Leer el archivo completo y pasar su contenido al execute_sql autorizado; no pegar una salida truncada. El generador rechaza un archivo de salida ya existente y devuelve tamaño y SHA-256. --check genera y verifica en memoria sin escribir.

Esta variante aplica **0028–0036 completas y en orden dentro de BEGIN/ROLLBACK**, con timeouts, y verifica el catálogo. No crea usuarios, no ejecuta RPC de negocio, no usa secuencias ni invoca push_dispatch, push_configure, realtime.send o net.http_post. Los cuerpos de funciones que mencionan Vault se crean como definiciones; no se ejecutan y no se leen valores de Vault.

**No es READ ONLY:** las migraciones crean/modifican objetos y actualizan las filas de catálogo de capas y buckets hasta el rollback, tomando bloqueos. La 0035 incluye su CREATE EXTENSION IF NOT EXISTS pg_net, también dentro de la transacción: no se elimina ni saltea esa parte. El generador rechaza triggers de usuario activos en shop_items/storage.buckets para que las actualizaciones de esos catálogos no disparen hooks personalizados. Los event triggers y las diferencias del esquema instalado deben revisarse con el preflight antes; no se afirma que esta inspección estática garantice el comportamiento de extensiones o hooks ajenos al repositorio. El parent decide si usa su autorización para ese ensayo o lo deja para una base local.

### 3. Escenarios completos en una base local descartable

supabase/tests/migrations-0028-0036-rollback.sql es la fuente del harness psql. Tiene 57 aserciones de uso legítimo, más comprobaciones estructurales. Ejecuta cada migración una sola vez, en orden, en una única transacción. No prueba idempotencia por doble aplicación.

Para SQL puro:

    node scripts/build-migrations-0028-0036-query.js --mode all --output "$env:TEMP\venus-sql-all-20261103.sql"

Para psql ya disponible en un entorno local descartable con Supabase y 0001–0027:

    psql -X -h 127.0.0.1 -U postgres -d venus_sql_test -v venus_disposable=on -f 'C:\Users\ringo\Downloads\Venus Launcher\supabase\tests\migrations-0028-0036-rollback.sql'

Adaptar la base/puerto local, sin URLs ni credenciales de producción. El control mira inet_server_addr() **del servidor**: una conexión a un puerto Docker publicado puede verse con IP de bridge y ser rechazada; en ese caso ejecutar dentro del entorno local por loopback/socket, sin quitar la guarda. La alternativa PostgreSQL portátil ya se preparó y ejecutó con el runner documentado arriba. Los archivos 0001–0027 solos no crean los componentes administrados auth/storage/realtime/roles de Supabase.

Las guardas de local, base sin usuarios y superusuario son una elección de aislamiento del harness; **no son una nueva exigencia de aprobación ni revocan la autorización del usuario**. Los escenarios usan listados globales de galería/catálogos/moderación, por lo que una base con datos reales alteraría resultados y leería filas que no son fixtures. El superusuario se exige para cambiar roles y sustituir temporalmente funciones administradas sin depender de ACL particulares.

Efecto no transaccional concreto previsto: nextval consume valores aun con rollback. Antes de los escenarios se hace ALTER SEQUENCE RESTART, que sí es transaccional, sobre las secuencias public/private preexistentes; así los consumos de prueba usan el estado temporal y se restaura el anterior al revertir. No se usa setval. Esto requiere un entorno descartable sin otros escritores, no una prueba de producción.

### Barreras frente a push/red en los escenarios

- Los tres caminos de la 0035 son mensajes, solicitudes pendientes y media-share; desactivar solo los dos triggers no cubre el tercero.
- Antes del primer fixture, private.push_dispatch se reemplaza por un sumidero que registra solamente el tipo del aviso en una tabla temporal. Los triggers siguen activos y se comprueba que llegan los tres tipos, sin invocar net.http_post ni leer Vault.
- realtime.send se reemplaza por una función vacía con los argumentos de la firma instalada. Si la firma no coincide, el ensayo aborta.
- Auth y Storage tienen sus triggers de usuario desactivados solo durante la transacción; los perfiles y metadatos de archivos son ficticios. Por eso el harness **no verifica** hooks reales de Auth/Storage ni subidas/descargas de archivos.
- Los usuarios, la cuenta administradora, los mensajes, URLs y UUID son creados en esa transacción; no se copian filas reales ni se llama a servicios externos. Los endpoints/tokens de ejemplo no se envían a ningún destino.
- No se confirmó que pg_net emita solicitudes que sobrevivan a un rollback. La protección evita la llamada sin depender de la versión instalada; no se presenta esa posibilidad como un efecto observado.
- ROLLBACK deshace DDL, fixtures, sustituciones de funciones y cambios de estado de triggers. En psql, ON_ERROR_STOP aborta ante un error y la desconexión revierte la transacción abierta. Con otro ejecutor, el parent debe comprobar cómo cierra la transacción fallida; si queda abierta, emitir ROLLBACK en esa misma sesión. No ejecutar fragmentos por separado ni mantener una sesión de prueba abierta.

## Límites de la entrega

La ejecución completa en PostgreSQL local está aprobada con los límites de fixtures indicados arriba. No se ejecutó el preflight remoto desde este frente. Las carreras corregidas se identificaron leyendo los bloqueos y los filtros; no se simularon peticiones simultáneas. Un harness de una sola transacción no prueba concurrencia, latencias, expiración real, Realtime con dos sesiones, Auth, transferencia de archivos, notificaciones de navegador ni funcionamiento de extensiones.

La revisión cubre el código de estas nueve migraciones y las dependencias consultadas del esquema previo; no certifica toda la base ni todos los posibles órdenes concurrentes de moderación, salidas y cambios de propietario. Los helpers y funciones anteriores a 0028 conservan sus permisos y search_path existentes salvo social_send_signal, reemplazada por 0035. Las reglas de rangos/URLs de Storage se verifican estáticamente; no se valida una firma real de Storage ni se abre una URL.

No hay pruebas de explotación ni herramientas ofensivas. Las mutaciones de escenarios son operaciones normales de cuentas ficticias. No se ejecutó remoto ni se tocó producción desde este frente.

## Rutas cambiadas por este frente

- supabase/migrations/0028_sync_ajustes.sql
- supabase/migrations/0029_resenas_servidores.sql
- supabase/migrations/0030_stickers.sql
- supabase/migrations/0031_competencia.sql
- supabase/migrations/0032_galeria_clips.sql
- supabase/migrations/0033_clanes_comunidades.sql
- supabase/migrations/0034_capas.sql
- supabase/migrations/0035_app_celular.sql
- supabase/migrations/0036_extensiones.sql
- supabase/tests/fixtures/managed-schemas-minimal.sql
- scripts/run-migrations-0028-0036-local.ps1
- supabase/tests/migrations-0028-0036-rollback.sql
- supabase/tests/migrations-0028-0036-preflight-readonly.sql
- scripts/check-migrations-0028-0036.js
- scripts/build-migrations-0028-0036-query.js
- docs/implementacion/revision-sql-0028-0036.md

## Entrega al agente principal

No queda una ejecución SQL local pendiente de este frente. Para repetirla, usar el runner; para integrar con Supabase real, sigue pendiente el ensayo en un stack compatible con Auth/Storage/Realtime y pg_net reales, sin desplegar producción por este informe. Producción hasta 0027 y pg_net no instalado son datos reportados por el parent, no consultados por este agente.

En esta fase cambiaron el harness, el fixture mínimo, el runner y este informe; no cambiaron las migraciones previamente revisadas ni el frontend. Los parciales tr/ja se pausaron atómicamente en 967/2390 y 953/2334 (pendientes 1423/1381 al cederlos), sin merge. Otros agentes continuaron después; este frente no volvió a editar esos idiomas.
