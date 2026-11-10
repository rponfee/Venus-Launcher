# Panel de administración

Panel del launcher para los dueños del proyecto: ver y buscar usuarios, cambiarles el plan de Venus IA, banearlos, silenciarlos, cerrarles las sesiones, reiniciarles el uso de la IA o eliminar sus cuentas; crear **cupones de descuento** para el checkout de Stripe; editar los **planes** (cupos, esfuerzos, presupuesto, si están a la venta y el precio) y revisar el **registro** de todo lo que hizo cada admin.

Solo lo ve quien tiene una cuenta de Venus con un email de la lista de admins **y confirmado**, y su fila en `app_admins`. Desde la 6.1 el **dueño** da y quita ese acceso desde la pestaña **Equipo** (sección 1, "Equipo: dar y quitar admin"); el SQL a mano queda como último recurso. Para el resto de los usuarios el launcher no muestra nada.

| Pieza | Archivo |
|---|---|
| Base de datos | `supabase/migrations/0012_admin.sql` (equipo: `0057_admin_equipo.sql`) |
| Edge Function | `supabase/functions/admin/` (`index.ts`, `handler.ts`, `actions.ts`, `coupons.ts`, `prices.ts`, `validate.ts`, `errors.ts`, `stripe-admin.ts`, pruebas en `tests/`) |
| Proceso principal | `src/main/modules/admin.js` (+ `admin/client.js`, `admin/fake.js`, `admin/fake-team.js`), textos `src/main/i18n/<es,en>/admin.js` |
| Interfaz | `src/renderer/js/features/admin.js` (agrega el menú), `src/renderer/js/pages/admin.js` (+ `pages/admin/*.js`; Equipo: `team.js` y la lógica sin DOM `team-logic.js`), `src/renderer/styles/pages/admin.css`, textos `src/renderer/i18n/<es,en>/admin.js` |

## 1. Cómo funciona el acceso

```
Launcher                                   Supabase
features/admin.js ── admin:me ──► RPC is_admin()  (barata: no usa la Edge Function)
   └─ si es admin: agrega "Administración" al menú
pages/admin.js ── admin:me (de nuevo) ──► si no es admin: "No autorizado"
   └─ cada acción ── admin:call ──► Edge Function "admin"
                                      1. verifica la sesión (auth.getUser)
                                      2. cuenta no anónima y email confirmado
                                      3. admin_is_admin_user(usuario) en la base
                                      4. valida el pedido y lo hace con la service role
                                      5. lo anota en admin_actions
```

- **Quién es admin.** Un usuario es admin cuando tiene su fila en `public.app_admins` **y** su email está en `public.app_admin_emails`, confirmado (`auth.users.email_confirmed_at`) y sin baneo. 0012 carga `admin@example.com` (en otro proyecto, 0014 borra ese email de la lista si esa cuenta no es admin).
- **`app_admins` no se llena sola** (desde 0014). Antes la llenaban triggers con solo mirar el email confirmado, pero con "Confirm email" apagado cualquiera que registrara primero un email de la lista (o se lo cambiara) quedaba admin. 0014 sacó esos triggers y `admin_sync_all`; los admins que ya estaban siguen igual. Desde 0057 la carga el dueño con **Dar acceso de administrador** (que también agrega el email a la lista).
- **`is_admin()`** (la puede llamar cualquier usuario con sesión) responde si **quien llama** es admin. Además de estar en `app_admins`, revisa en el momento que el email siga en la lista, que esté confirmado y que la cuenta no esté baneada: sacar un email de la lista corta el acceso al instante.
- **El servidor verifica en cada acción.** La Edge Function `admin` no confía en el launcher: en cada pedido vuelve a verificar la sesión, que la cuenta no sea anónima, que el email esté confirmado y que siga siendo admin. Un usuario común que llame a la función recibe `403` y no se toca nada.
- **El launcher solo decide qué mostrar.** El menú y la página se ven solo si `admin:me` dice que es admin; la página vuelve a preguntar al abrirse y, si no, muestra "No autorizado".

### Rangos e integraciones (3.0)

- **Rango** en la ficha de cada usuario: helper o mod (`admin_set_rank`, queda en el registro de acciones). Es lo que se ve en el perfil: no da acceso a este panel. Desde 0057 **`admin` ya no se elige suelto**: va atado al acceso real (lo pone Dar acceso y lo saca Quitar acceso), y no se le puede cambiar el rango a un administrador activo (`admin_locked`). Una insignia `admin` vieja sin acceso se puede cambiar o sacar. `owner` se carga a mano con SQL y no se puede cambiar desde el panel.
- **Integraciones**: clave de la app de KLIPY (`admin_set_klipy_key`, en el Vault). Sin clave, el buscador de GIF del perfil avisa que no está disponible.

### CurseForge desde Integraciones (4.5.0)

La tarjeta **CurseForge** permite guardar, reemplazar, quitar y probar la clave del proyecto. Se guarda en Vault; el panel solo muestra los últimos cuatro caracteres. Guardada no significa validada: **Probar búsqueda** consulta mods de Minecraft usando la clave guardada. Las categorías por sí solas no comprueban ese permiso. El campo se vacía después de cada operación y no se guarda en los ajustes locales.

**Activada en producción el 4 de noviembre de 2026**, con autorización del dueño: `0037_curseforge_admin.sql` aplicada con versión **`20261104170221`** y Edge Function `curseforge` **v1 ACTIVE**, **`verify_jwt = true`**. No se reemplazó la función `admin` existente. La clave aprobada para el launcher está configurada y una búsqueda real de mods respondió HTTP 200 desde el servidor. El preflight devolvió OPTIONS 204 con CORS `*` y el POST sin autenticación, 401. [Versiones, hashes y límites](activacion-backend-4.5.0.md).

La validación local pasó **84 comprobaciones SQL** con Vault simulado; la prueba focalizada más reciente pasó **87 pruebas Node de main/Edge/UI**. La primera portable se entregó al dueño. La clave de Profile daba 403 en búsquedas; el dueño la reemplazó por la clave aprobada para el launcher y la búsqueda real respondió 200. La interfaz distingue ahora un rechazo de clave de los permisos de cuenta. [Diagnóstico y pasos](curseforge.md).

- Administración llama `admin_curseforge_status()` y `admin_set_curseforge_key(p_key)`; ambas comprueban la cuenta administradora en el servidor. Los cambios quedan en el registro como `curseforge.key`, sin clave ni pista.
- `curseforge_status()` solo informa si existe configuración. La clave la recupera exclusivamente la función del servidor mediante `curseforge_proxy_access(p_user)`, restringida a `service_role`.
- El catálogo central requiere una cuenta de Venus. Su clave tiene prioridad sobre la incluida en builds anteriores. Si no hay configuración central, se conserva ese camino anterior.
- Las consultas se limitan a las rutas utilizadas de Minecraft en `api.curseforge.com`, sin seguir redirecciones, con un máximo de 240 consultas por minuto y cuenta. La caché local de resultados sigue vigente.
- Quitar una clave central no revoca copias incluidas en instaladores viejos; la revocación de esas claves se hace en CurseForge. Para builds nuevos puede dejarse vacío `VENUS_CURSEFORGE_API_KEY`.
- Nunca pegues la clave en un issue, el chat o el repositorio.

Referencias: [API oficial de CurseForge](https://docs.curseforge.com/rest-api/) y [Supabase Vault](https://supabase.com/docs/guides/database/vault).

### Equipo: dar y quitar admin (6.1, 0057)

**Quién es quién.**

| Rol | Qué es | Qué ve en Equipo |
|---|---|---|
| **Dueño** | Un administrador activo cuyo perfil tiene `rank = 'owner'`. Hay uno solo y se carga a mano (abajo). | La lista, **Dar acceso de administrador**, **Quitar acceso** (menos a sí mismo y a otra cuenta owner) y soporte. |
| **Admin** | Fila en `app_admins` + email actual en `app_admin_emails`, confirmado y sin baneo. Usa todo el panel. | La lista en **solo lectura** (con una nota) y puede sumar o quitar personal de soporte. |
| **Soporte** | Fila activa en `support_staff` (0016) con su email actual. Atiende tickets; no entra al panel. | No ve el panel. |

**Dar acceso.** Equipo → **Dar acceso de administrador** → buscar la cuenta (el mismo buscador de Usuarios: usuario, email, código de amigo) → confirmación que explica qué va a poder hacer (ver los datos de todas las cuentas, banear y eliminar, cambiar precios, planes y claves, soporte y denuncias; no dar ni quitar admin). También desde la **ficha** del usuario, sección **Acceso al panel**. La cuenta tiene que existir, no ser de invitado, tener el **email confirmado** y no estar baneada; si no, el panel lo avisa con el motivo (`unconfirmed`, `banned`, `anonymous`, `unknown_user`). Por dentro, `admin_grant_admin` agrega su email actual (en minúsculas) a `app_admin_emails`, su fila a `app_admins`, le pone la insignia `admin` si no tenía una igual o mayor y lo anota como `admin.grant`. Si ya era admin no cambia nada.

**Quitar acceso.** En la fila del admin (o en su ficha) → **Quitar acceso** → confirmación con el nombre. Se corta **al instante**: `admin_is_admin_user` se revisa en cada pedido. `admin_revoke_admin` borra su fila de `app_admins`, saca de la lista el email con el que se cargó y el actual **salvo que otra fila de `app_admins` todavía lo use** (así nunca se corta a otra cuenta), baja la insignia `admin` a sin rango y lo anota como `admin.revoke`. Nadie se puede quitar a sí mismo (`cannot_self`) ni a una cuenta owner (`owner_locked`).

**Soporte.** Equipo → **Sumar a soporte** (cualquier admin) o **Quitar de soporte**. `admin_set_support_staff` respeta el índice único de `support_staff` (una fila activa por email): si otra fila activa tenía ese email (una cuenta que después se lo cambió), queda inactiva. Queda en el registro como `support.staffGranted` / `support.staffRevoked`.

**Lo que muestra la lista.** Administradores: el dueño primero (**Dueño**), **Vos**, desde cuándo y la última acción registrada; **Sin acceso ahora** si tiene la fila pero no entra (cambió el email, no lo confirmó o está baneado). Soporte: desde cuándo, y **Sin acceso ahora** si cambió el email (hay que sacarlo y volver a sumarlo).

**Quién decide.** El launcher solo decide qué botones mostrar. Cada función vuelve a verificar en el servidor: un admin común que llame `admin_grant_admin` a mano recibe `owner_only` y no cambia nada. Las RPC van directo con la sesión del usuario (`cloud.client.rpc`, como Integraciones), no por la Edge Function `admin`.

**Abusos pensados.** Un admin común con el RPC a mano (`owner_only`); el dueño quitándose a sí mismo (`cannot_self`); una cuenta que cambia el email después de ser admin (pierde el acceso porque se compara el email actual; volver a darle acceso carga el nuevo); emails con mayúsculas (se guardan en minúsculas, como compara `admin_is_admin_user`); dos filas de `app_admins` con el mismo email (quitar a una no saca el email que usa la otra); dos clics seguidos (un candado por transacción).

#### Último recurso: SQL a mano

Para cargar al **dueño** (una sola vez) o si el panel no está disponible. En el SQL Editor de Supabase:

```sql
-- Dueño: primero tiene que ser admin (fila + email confirmado en la lista), después el rango.
insert into public.app_admin_emails (email, note) values ('dueno@example.com', 'Dueño');
insert into public.app_admins (user_id, email)
select u.id, lower(u.email) from auth.users u
 where lower(u.email) = 'dueno@example.com' and u.email_confirmed_at is not null;
update public.profiles set rank = 'owner' where id = (select id from auth.users where lower(email) = 'dueno@example.com');

-- Quitar un admin a mano (deja de serlo al instante; borrar el email de la lista ya alcanza)
delete from public.app_admin_emails where email = 'otra.persona@example.com';
delete from public.app_admins where email = 'otra.persona@example.com';
update public.profiles set rank = null where rank = 'admin' and id = (select id from auth.users where lower(email) = 'otra.persona@example.com');

-- Ver quiénes son admins ahora (y quién es el dueño)
select a.user_id, a.email, a.granted_at, public.admin_is_admin_user(a.user_id) as activo, p.rank
  from public.app_admins a left join public.profiles p on p.id = a.user_id;
```

Registrarse con un email de la lista no da acceso: hace falta la fila en `app_admins`.

## 2. Despliegue

1. **Aplicá `supabase/migrations/0012_admin.sql` después de `0011`** (y de 0001, 0002, 0007, 0008 y 0009, que ya tenés) **y después `0014_security.sql`**: SQL Editor → pegar y ejecutar, o `supabase db push`. Se pueden volver a aplicar sin perder datos, pero todas juntas y en orden: 0012 sola volvería a poner los triggers que daban admin por el email ([supabase.md](supabase.md), sección 2).
2. **Desplegá la función** desde la carpeta del proyecto (la CLI empaqueta el código compartido de `billing/`):

   ```bash
   supabase functions deploy admin
   ```

   Con la verificación de JWT activada (lo predeterminado). Si usás `supabase/config.toml`:

   ```toml
   [functions.admin]
   verify_jwt = true
   ```

3. **Secretos.** `SUPABASE_URL`, `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY` los pone Supabase. Para cupones, precios y cancelaciones hace falta `STRIPE_SECRET_KEY` (la misma de `billing`, ver [pagos.md](pagos.md)); sin ella el resto del panel funciona y esas pestañas avisan "Stripe no está configurado". Opcional: `BILLING_PORTAL_CONFIGURATION` (`bpc_...`), si el portal no es el que creó `scripts/stripe-setup.js`.
   - Si usás una **clave restringida** de Stripe (`rk_...`) para las funciones, para el panel sumale: Coupons y Promotion codes (escritura), Prices y Products (escritura), Subscriptions (escritura) y Customer portal (escritura).
4. **El launcher.** `src/renderer/js/features/admin.js` tiene que estar en la lista `STARTUP` de `app.js` (lo agrega quien integra). Sin eso el menú no aparece (la ruta `#/admin` no existe).
5. **Antes de abrir el panel:** dejá activado **"Confirm email"** en Supabase (Authentication → Providers → Email) y asegurate de que tu cuenta con el email de admin ya exista y tenga su fila en `app_admins` (sección 1). Ver la sección 8.

## 3. Pestañas y acciones

Ruta: `#/admin[/<pestaña>]`. `#/admin/users/<id>` abre la ficha de ese usuario.

Pestañas (6.1), agrupadas por uso y separadas por una línea: **Resumen, Soporte, Usuarios, Pagos** · **Denuncias, Galería, Reseñas, Stickers** · **Planes, Integraciones, Equipo, Registro**. Flechas, Inicio y Fin recorren las pestañas; el foco se ve. Comunidades salió del panel en la 6.1 (se retiraron del launcher). Mientras queden launchers 6.0.0 o anteriores en uso, sus denuncias y GIFs pendientes se moderan con SQL: ver "Moderación mientras queden launchers viejos" en [retirada-funciones.md](retirada-funciones.md#retiros-de-la-61).

### Resumen

Arriba, lo que necesita atención: un aviso rojo si **falta una clave** necesaria (ChatGPT/OpenAI, Claude/Anthropic o un medio de pago) con **Cargar ahora**, y **Para revisar**: accesos directos a tickets esperando respuesta, denuncias abiertas, clips denunciados y pagos sin confirmar (solo los que tienen algo). Abajo, **IA del mes por motor** (Claude / ChatGPT: gasto, llamadas, saldos vigentes y lo que queda, de `admin_ai_providers` de 0056; si el servidor todavía no tiene esa función, el bloque no aparece) y **Claves e integraciones** (OpenAI, Claude, pagos, CurseForge y KLIPY: Lista, Falta cargar, Sin activar en el servidor o No se pudo revisar). Cada bloque carga solo: si uno falla, el resto se ve.

Usuarios totales y nuevos (7 y 30 días), suscripciones con acceso (pagan con Stripe / regaladas), **MRR estimado**, gasto de la IA del mes (dólares, preguntas, usuarios), baneados y silenciados, avisos de pagos fallidos y cancelaciones (llevan a Usuarios filtrado), suscripciones por plan y gasto por modelo.

- **MRR estimado** = suma de las suscripciones de Stripe que dan acceso hoy (sin las de prueba gratis), con el precio de `ai_plan_prices` que paga cada una (o el `price_usd` del plan). No descuenta cupones ni impuestos; los planes regalados no suman.
- El gasto del mes se cuenta desde el día 1 a las 00:00 de Argentina (como las cuotas, ver [backend-ia.md](backend-ia.md)).

### Usuarios

Búsqueda por email, usuario, nombre visible, código de amigo, nombre de Minecraft o id (con la cantidad encontrada y **Limpiar filtros** a mano cuando hay alguno); columna **Rol** (Dueño, Admin, Soporte, del Equipo); filtros por plan, estado de la suscripción y moderación; orden por alta, última conexión, gasto o email; 25 por página. Se pueden elegir varios (la selección se mantiene entre páginas y se vacía al cambiar los filtros) y actuar sobre todos a la vez, o abrir la ficha de uno (clic o Enter; Espacio marca la fila; flechas para moverse).

La **ficha** muestra la cuenta (email, id, código de amigo, confirmación, alta, última conexión), el plan con los ids de Stripe (cliente, suscripción, precio), el uso de la IA de hoy, la semana y el mes por modelo con su cuota, el **acceso al panel** (qué es y, para el dueño, Dar/Quitar acceso; Sumar/Quitar de soporte para cualquier admin), el **rango** (helper o mod), la moderación con **notas internas** (solo las ven los admins) y las últimas 20 acciones de admins sobre esa cuenta.

| Acción | Qué hace | Sobre vos / otros admins |
|---|---|---|
| **Cambiar plan** | Le pone el plan elegido, `source = 'admin'`, sin vencimiento o hasta el final del día elegido, con nota opcional (queda en el registro). Deja vacías las columnas de Stripe, como un plan manual de [pagos.md](pagos.md) §13. | Sí |
| **Quitar plan** | El plan queda `canceled` (`source = 'admin'`) y se borran sus saldos pagados de Claude y de ChatGPT (6.1, 0056; las compras quedan en el historial): se queda sin la IA del launcher (si paga con Stripe, solo hasta la próxima lectura de Stripe: ver abajo). | Sí |
| **Reiniciar uso** | Pone en 0 las **preguntas** de hoy o de la semana (vuelve a tener el cupo de su plan) y vacía la ventana de llamadas por minuto. **No** toca el gasto en dólares del mes (es el historial real de costos, que también cuenta para el presupuesto). | Sí |
| **Cerrar sesiones** | Borra sus sesiones y revoca sus refresh tokens: tiene que volver a iniciar sesión. Los tokens de acceso ya emitidos valen hasta que vencen (1 hora por defecto). | No |
| **Silenciar** (1 h, 24 h, 7 días, 30 días o permanente) | Solo social: no puede mandar mensajes, reacciones, señales (invitaciones a voz, a mundos, modpacks, "escribiendo…") ni solicitudes de amistad, ni editar mensajes (sí borrarlos). Sigue jugando y usando la IA. | No |
| **Quitar silencio** | Vuelve todo a la normalidad. | Sí |
| **Banear** (misma duración, **motivo obligatorio**) | 1) Supabase Auth: `ban_duration` (no puede iniciar sesión ni renovar la sesión; permanente = 876000 h, 100 años). 2) La base: `user_moderation.banned_until` y el motivo (lo social se corta al instante). 3) Cierra sus sesiones. | No |
| **Desbanear** | `ban_duration = 'none'` en Auth y limpia la base. | Sí |
| **Eliminar** (doble confirmación: escribir **ELIMINAR** y confirmar otra vez) | 1) Cancela **ya** sus suscripciones de Stripe que cobran (sin factura final ni prorrateo) para que nadie siga pagando; si no se puede (Stripe sin configurar, cliente del otro modo o falla de Stripe) **no se elimina** esa cuenta. 2) Borra sus archivos en Storage (mundos en la nube, capturas y clips; se puede desmarcar). 3) Borra la cuenta con la API de Auth: la base borra en cascada perfil, amigos, mensajes, plan, uso, cliente de Stripe guardado y moderación. | No |
| **Cancelar suscripción de Stripe** (desde la ficha o desde el aviso de Stripe) | Ahora (corta el acceso y no cobra más) o al fin del período (no se renueva). El webhook actualiza el plan en unos segundos. No hace reembolsos. | Sí |

- Las acciones en lote aceptan hasta 100 usuarios. El resultado dice cuántas salieron bien y, por cada una que no, por qué (es tu cuenta, es admin, ya no existe, Stripe falló…).
- **Planes y Stripe.** Si el usuario paga una suscripción de Stripe, cambiar o quitar el plan desde el panel dura **muy poco**: la próxima vez que se lee Stripe (un evento del webhook, o el launcher del usuario, que relee Stripe al abrir los planes y cada tanto) vuelve a quedar el plan que paga, en segundos o minutos. El panel lo avisa (lo revisa en la base y en Stripe) y ofrece cancelar esa suscripción: para cortarle la IA a alguien que paga, cancelá su suscripción (**Ahora**). Para un descuento a alguien que ya paga, mejor un cupón aplicado desde el panel de Stripe.
- **Cancelar dos veces.** La clave de idempotencia de las cancelaciones cambia cada minuto: dos clics seguidos mandan una sola, pero si el usuario reactivó la suscripción en el portal (o Stripe falló), volver a cancelar después llega de verdad a Stripe.

### Cupones

Crea cupones de Stripe con su **código de promoción** (lo que la gente escribe al pagar). El checkout de Venus ya acepta códigos (`allow_promotion_codes` en `supabase/functions/billing/handler.ts`), así que no hay que tocar nada más.

- **Descuento:** porcentaje (más de 0 a 100, hasta 2 decimales) **o** monto fijo en dólares.
- **Duración:** solo el primer pago, durante N meses (1 a 36) o para siempre. La vista previa lo muestra en vivo: "20% off por 3 meses".
- **Planes:** todos, o solo algunos (se aplica a los productos `venus_ai_<plan>` que crea `scripts/stripe-setup.js`).
- **Límites del cupón:** usos máximos y fecha hasta la que se puede usar (opcionales).
- **Código:** de 3 a 40 letras o números (Stripe no acepta espacios ni símbolos), se guarda en mayúsculas. Opcionales: vencimiento (no puede ser después que el del cupón), "solo para la primera compra" y usos máximos del código.
- Si el código ya existe, el cupón recién creado se borra solo y el panel lo avisa.
- **Desactivar un código:** nadie más lo puede usar (se puede volver a activar). **Agregar código:** otro texto para el mismo cupón. **Borrar cupón:** sus códigos dejan de funcionar al instante; quien ya tiene el descuento en su suscripción lo conserva.
- La lista muestra los 100 cupones más nuevos de Stripe (también los creados fuera del panel) con sus códigos, usos y vencimientos. Nunca muestra datos de clientes (un código restringido a un cliente dice "para un cliente puntual", sin decir cuál).

### Planes

Por cada plan: a la venta o no, presupuesto por usuario y mes, tokens por llamada, llamadas por pregunta, llamadas por minuto y, por modelo, los esfuerzos permitidos y las preguntas por día y por semana (se pueden agregar o quitar modelos; siempre queda al menos uno). Se guarda en la base (`ai_plans`, `ai_plan_models`) y se aplica **al instante** en la IA. Desactivar un plan deja a sus suscriptores sin IA (no hay plan gratis): el panel lo advierte.

**Cambiar precio** (con aviso explícito y una casilla de confirmación). Los precios de Stripe no se pueden editar, así que la función:

1. crea un precio mensual nuevo en USD en el mismo producto, con el `lookup_key` `venus_ai_<plan>_monthly` (se lo lleva del anterior) y el mismo comportamiento de impuestos;
2. lo carga en `ai_plan_prices` con `billing_upsert_price` (el anterior queda inactivo pero **no se borra**: sigue reconociendo las suscripciones viejas);
3. deja inactivo el precio anterior en Stripe y marca el nuevo como el del producto;
4. actualiza el portal de facturación para que el cambio de plan ofrezca el precio nuevo;
5. actualiza `ai_plans.price_usd` (informativo).

**Los suscriptores actuales siguen pagando el precio anterior** hasta que los cambies desde el panel de Stripe. Dos clics (o un reintento en la misma hora) no crean dos precios. Si algo del paso 3 en adelante falla, el precio se cambia igual y el panel avisa qué revisar en Stripe. Se crea en el modo de la clave del servidor (prueba o producción).

### Registro

Filtros por **tipo de acción** (grupos como "Equipo (todas)" o una acción puntual) y por **admin** (aparece con dos o más). Las acciones nuevas tienen texto propio: dar y quitar admin, sumar y quitar de soporte, cambios de clave de OpenAI, Claude, CurseForge y KLIPY, rangos (de cuál a cuál), galería y stickers.

Todo lo que **cambia algo** queda en `public.admin_actions`: quién (id y email del admin), qué acción, sobre qué usuario (si corresponde), los detalles (plan, duración, motivo, código, montos…) y cuándo. Una fila por usuario afectado. Las lecturas (listas, fichas, resumen) **no** se registran. De una cuenta eliminada queda el email enmascarado (`r*****e@gmail.com`) y el nombre de usuario.

Si una acción falla a mitad de camino, lo que ya se hizo también queda, con `failed: true` y el código del error: por ejemplo, un borrado que canceló en Stripe y borró archivos pero no pudo borrar la cuenta (`canceledSubscriptions`, `filesRemoved`), un baneo que quedó en Auth pero no en la base (`authBan`) o las suscripciones que se cancelaron antes de que fallara otra. Una falla que no cambió nada no se registra.

La tabla es **solo de agregar**: se escribe únicamente con la función `admin_log` y ni la service role la puede editar o borrar por la API (solo el dueño de la base desde el SQL Editor). La leen los admins.

## 4. Moderación en la base

`public.user_moderation` (una fila por usuario): `banned_until`, `ban_reason`, `muted_until`, `mute_reason`, `notes`, `updated_by`, `updated_at`. Solo la service role.

0012 reemplaza estas funciones de 0002 **con las mismas firmas** para que una cuenta silenciada o baneada no pueda escribir:

| Función | Corta |
|---|---|
| `social_can_send(conv)` (la usan las políticas de `messages` y `message_reactions`) | Mensajes y reacciones |
| `social_send_friend_request(target)` | Solicitudes de amistad |
| `social_send_signal(target, kind, payload)` | Señales (invitaciones, "escribiendo…") |
| `social_messages_before()` (trigger) | Editar el texto de un mensaje (borrarlo sí se puede) |

El error es `P0001` con el mensaje `user_muted` o `user_banned` (como los demás errores de social: `user_blocked`, `not_friends`…). **Pendiente para el dueño de social:** sumar `user_muted` y `user_banned` a `KNOWN_ERRORS` de `js/social.js` con sus textos (`social.err_user_muted`, `social.err_user_banned`); mientras tanto se ve "Algo salió mal: user_muted". Para avisar antes de que escriba, el launcher puede leer `rpc('my_moderation')` → `{ muted, mutedUntil, banned, bannedUntil }` (sin motivos ni notas).

## 5. Seguridad

- **Nada de secretos en el launcher.** La service role y la clave de Stripe viven solo en los secretos de Supabase. El launcher manda el token del usuario; la función verifica todo en el servidor.
- **No se puede escalar desde el cliente.** Las tablas nuevas tienen RLS y no tienen permisos para `anon` ni `authenticated` (salvo leer `admin_actions` si sos admin). Las funciones que cambian algo son solo de la service role; las de lectura del panel exigen `is_admin()` o la service role (`admin_guard`). `app_admin_emails` solo se edita con la service role o desde el SQL Editor.
- **Protecciones:** nadie se puede banear, silenciar, cerrar las sesiones ni eliminar a sí mismo, ni hacerlo con otro admin. Eliminar pide escribir ELIMINAR y una segunda confirmación; el servidor además exige `confirm: true`. Cambiar un precio exige `confirm: true`.
- **"Confirm email" activado.** El acceso pide el email confirmado, y con la confirmación apagada eso no prueba nada: cualquiera se registra con cualquier email y queda "confirmado" al instante. Desde 0014 registrarse con un email de la lista ya no da acceso solo (la fila de `app_admins` se carga a mano), pero igual dejá la confirmación activada y cargá solo cuentas que verificaste que son de esa persona.
- **Baneos y tokens.** Un baneo corta el inicio de sesión y la renovación de la sesión, y el panel cierra sus sesiones; lo social se corta al instante, pero un token de acceso ya emitido puede seguir sirviendo para otras cosas hasta que vence (1 hora por defecto).
- **Datos de pago.** El panel nunca devuelve datos de tarjetas ni de clientes de Stripe: solo ids (`cus_`, `sub_`, `price_`), estados, montos y códigos. Los errores de Stripe llegan como código (por ejemplo `resource_missing`), nunca con su mensaje.
- **Logs de la función:** solo códigos, ids de usuario de los accesos denegados y descripciones de errores de Stripe sin datos.
- **Modo de capturas** (`VENUS_DEVSHOT` + `VENUS_ADMIN_FAKE=1`, nunca en la app empaquetada): el proceso principal responde con datos de ejemplo locales y no habla con ningún servidor, así que no puede dar ni usar permisos reales. Las RPC directas (Equipo, Resumen) van a un doble local (`admin/fake-team.js`, acción `rpc`) con las mismas reglas y códigos de error; `VENUS_ADMIN_FAKE_ROLE=admin` muestra el panel como un admin común.

## 6. Para quien integra: canales y protocolo

### Canales del proceso principal (`src/main/modules/admin.js`)

- `admin:me({ force? })` → `{ isAdmin, email, userId, reason, checkedAt, fake? }`. Usa la RPC `is_admin` (no la Edge Function) y guarda la respuesta 5 minutos por usuario (`force: true` vuelve a preguntar). `reason`: `null`, `'noCloud'`, `'noSession'`, `'notReady'` (falta 0012), `'network'` o `'error'`.
- `admin:call(action, payload?)` → el `result` de la acción. Errores con `err.code`: `noCloud`, `noSession`, `forbidden` (no es admin o email sin confirmar; borra la caché de `admin:me`), `notFound`, `unavailable` (sin la función o sin la migración), `badRequest` (con `err.field` y el mensaje del servidor), `conflict` (`err.reason`, por ejemplo `promo_code_taken` o `same_price`), `stripeNotConfigured`, `stripe` (`err.stripeCode`), `server`, `network`, `error`.

### Edge Function `admin`

`POST /functions/v1/admin` con `Authorization: Bearer <token del usuario>` y `{ "action": "...", "payload": { ... } }` → `200 { ok: true, action, result }`. `GET` = acción `me`. Errores: `{ ok: false, error, message, field?, reason?, stripeCode? }` con 400 (`bad_request`), 401 (`unauthorized`), 403 (`forbidden`, `reason`: `anonymous` / `unconfirmed` / `not_admin`), 404 (`not_found`), 409 (`conflict`), 502 (`stripe`, `auth_unavailable`), 503 (`not_configured`, `backend_not_ready`, `db_unavailable`, `stripe_not_configured`, `auth_unavailable`).

| Acción | Payload | `result` |
|---|---|---|
| `me` | — | `{ userId, email, isAdmin: true, protocol: 1, stripe: { configured, mode }, storage }` |
| `overview` | — | `{ users: { total, new7d, new30d, confirmed, banned, muted, admins }, subscriptions: { active, paying, trialing, manual, pastDue, canceling, byPlan: [{ plan, name, planActive, priceUsd, active, paying, manual, mrrUsd }] }, revenue: { mrrUsd, currency }, ai: { monthUsd, monthQuestions, monthCalls, activeUsers, since, byModel: [{ model, label, usd, questions, calls }] }, generatedAt, stripe }` |
| `users.list` | `{ search?, plan? (id o 'none'), status? ('active', 'inactive', 'none', 'past_due', 'canceling', 'stripe', 'manual'), banned?, muted?, sort? ('created', 'lastSignIn', 'spend', 'email'), page?, perPage? (hasta 100) }` | `{ total, page, perPage, users: [UserRow] }` |
| `users.get` | `{ id }` | `{ account, profile, subscription, stripeCustomer, usage: { models, totals, quota }, moderation, actions, stripe }` (404 si no existe) |
| `users.setPlan` | `{ ids[], planId, until? (ISO), note? }` | Lote + `{ planId, until, stripe }`; cada resultado `{ previousPlan, stripeActive, subscriptionId }`; avisos `stripe_active` |
| `users.removePlan` | `{ ids[], note? }` | Lote; cada resultado `{ changed, previousPlan, stripeActive, subscriptionId }` |
| `users.ban` | `{ ids[], duration ('1h', '24h', '7d', '30d', 'permanent'), reason }` | Lote; cada resultado `{ bannedUntil, sessionsRevoked }` |
| `users.unban` · `users.unmute` · `users.signOut` | `{ ids[] }` | Lote (`signOut`: `{ sessionsRevoked }`) |
| `users.mute` | `{ ids[], duration, reason? }` | Lote; cada resultado `{ mutedUntil }` |
| `users.resetUsage` | `{ ids[], scope ('today' o 'week') }` | Lote; cada resultado `{ rows }` |
| `users.delete` | `{ ids[], confirm: true, cancelStripe? (true), purgeFiles? (true) }` | Lote; cada resultado `{ canceledSubscriptions, filesRemoved }` |
| `users.setNotes` | `{ id, notes }` | `{ moderation, warnings }` |
| `stripe.cancelSubscription` | `{ userId, when? ('now' o 'period_end') }` | `{ userId, when, canceled: [{ id, status, cancelAtPeriodEnd }], warnings }` |
| `coupons.list` | — | `{ configured, mode, coupons: [Coupon], hasMore, checkoutAcceptsCodes }` (sin Stripe: `configured: false` y `message`) |
| `coupons.create` | `{ name?, percentOff? \| amountOff? (centavos), duration ('once', 'repeating', 'forever'), durationInMonths?, appliesTo? (ids de plan), maxRedemptions?, redeemBy? (ISO), promo?: { code, expiresAt?, firstTimeOnly?, maxRedemptions? } }` | `{ coupon, promotionCode, warnings }` |
| `coupons.addPromo` | `{ couponId, code, expiresAt?, firstTimeOnly?, maxRedemptions? }` | `{ promotionCode, warnings }` |
| `coupons.deactivatePromo` · `coupons.activatePromo` | `{ promoId }` | `{ promotionCode, warnings }` |
| `coupons.delete` | `{ couponId }` | `{ deleted: true, couponId, warnings }` |
| `plans.list` | — | `{ plans: [Plan], models: [{ id, label, active }], stripe }` |
| `plans.update` | `{ planId, patch: { monthlyBudgetUsd?, maxTokensPerRequest?, maxCallsPerTurn?, requestsPerMinute?, active?, models?: [{ id, efforts, daily, weekly, sort?, remove? }] } }` | `{ plan, warnings }` |
| `plans.setPrice` | `{ planId, amount (centavos, 50 a 100000), confirm: true }` | `{ planId, priceId, previousPriceId, amount, previousAmount, livemode, product, portal ('updated', 'not_found', 'failed'), warnings, plan }` |
| `audit.list` | `{ action? (exacta o grupo 'users.'), adminId?, targetUser?, since?, until?, page?, perPage? (hasta 200) }` | `{ total, page, perPage, actions: [{ id, action, adminId, adminEmail, targetUser, targetEmail, targetUsername, details, createdAt }] }` |

**Lote** = `{ results: [{ id, ok, error?, ... }], summary: { ok, failed }, warnings: [{ code, id?, email?, ... }] }`. Errores por usuario: `self`, `target_admin`, `not_found`, `stripe` (+ `stripeCode`), `stripe_not_configured`, `stripe_mode`, `auth`, `db`, `unknown_plan`, `error`. Avisos: `stripe_active`, `stripe_unchecked`, `signout_failed`, `files_not_removed`, `stripe_not_canceled`, `audit_failed`.

**UserRow** = `{ id, email, emailConfirmed, createdAt, lastSignInAt, username, displayName, friendCode, mcName, isAdmin, plan: { id, name, status, active, source, currentPeriodEnd, cancelAtPeriodEnd, stripeStatus, managedByStripe } | null, usage: { monthUsd, monthQuestions }, moderation: { banned, bannedUntil, banReason, muted, mutedUntil } }`.

**Coupon** = `{ id, name, percentOff, amountOff, currency, duration, durationInMonths, maxRedemptions, timesRedeemed, redeemBy, valid, createdAt, appliesTo: { products, plans } | null, venus, promotionCodes: [{ id, code, active, couponId, expiresAt, maxRedemptions, timesRedeemed, firstTimeOnly, restricted, createdAt }] }`.

**Plan** = `{ id, name, active, sort, priceUsd, currency, monthlyBudgetUsd, maxTokensPerRequest, maxCallsPerTurn, requestsPerMinute, subscribers, models: [{ id, label, modelActive, efforts, daily, weekly, sort }], prices: [{ priceId, amount, currency, interval, livemode, active, lookupKey, createdAt }] }`.

### Funciones SQL (0012)

| Función | Quién | Qué hace |
|---|---|---|
| `is_admin()` | Usuarios con sesión | ¿Quien llama es admin? |
| `my_moderation()` | Usuarios con sesión | Su propio silencio o baneo (sin motivos). |
| `admin_overview()`, `admin_list_users(...)`, `admin_user_detail(user)`, `admin_plans()`, `admin_list_actions(...)` | Admins con sesión y service role | Lecturas del panel (también sirven desde el SQL Editor). |
| `admin_team()` (0057) | Admins con sesión | `{ me: { userId, isOwner }, admins: [{ userId, username, displayName, email, grantedAt, isOwner, active, lastActionAt }], staff: [{ userId, username, displayName, email, since, active }] }` |
| `admin_grant_admin(user)`, `admin_revoke_admin(user)` (0057) | Solo el dueño (lo revisa cada función) | Dar y quitar el acceso; `{ userId, isAdmin, changed, rank }`. Errores: `owner_only`, `unknown_user`, `anonymous`, `unconfirmed`, `banned`, `bad_email`, `cannot_self`, `owner_locked`, `grant_failed`. |
| `admin_set_support_staff(user, active)` (0057) | Admins con sesión | Soporte; `{ userId, staff, changed }`. |
| `admin_set_rank(user, rank)` (0023, cambiada en 0057) | Admins con sesión | Solo `helper`, `mod` o sin rango (`bad_rank`, `owner_locked`, `admin_locked`). |
| `private.admin_is_owner(user)`, `private.admin_team_blocker(user)` (0057) | Internas | Dueño = admin activo con `rank = 'owner'`; por qué una cuenta no puede recibir un rol. |
| `admin_is_admin_user(user)`, `admin_targets(ids)`, `admin_set_plan`, `admin_remove_plan`, `admin_moderate`, `admin_revoke_sessions`, `admin_reset_usage`, `admin_log`, `admin_update_plan`, `admin_plan_json`, `admin_user_files` | Service role | Las usa la Edge Function. (`admin_sync_all` y los triggers que llenaban `app_admins` los sacó 0014.) |
| `moderation_social_block(user)`, `private.moderation_self_block()` | Internas | Lo que consultan las funciones sociales (0014 pasó la segunda al esquema `private`, fuera de la API). |

## 7. Pruebas

```bash
node --test "supabase/functions/admin/tests/*.test.ts"
node --test "src/main/modules/admin/test/*.test.js"
node --test "src/renderer/js/pages/admin/test/*.test.js"
```

Equipo (0057): `supabase/functions/admin/tests/team-migration.test.ts` revisa el SQL sin Postgres (security definer con `search_path` vacío, permisos para `authenticated` solo en lo que llama el panel y nada para `anon`, controles de dueño antes de escribir, códigos de error, que el registro no lleve el email de la cuenta afectada y que no haya emails en el archivo). `pages/admin/test/team-logic.test.js` y `team.test.js` prueban quién ve qué, el armado de las listas, las confirmaciones, los errores por código y que todos los textos existan en español e inglés; `src/main/modules/admin/test/fake-team.test.js`, el modo de ejemplo. **Contra una base de verdad** hay un guion aparte (`begin; 0057; escenarios; rollback;`) que aplica la migración en una transacción, prueba con cuentas simuladas (dueño, admin común, sin confirmar, baneada, anónima, email con mayúsculas, email compartido, cambio de email, soporte) y deshace todo.

Cubren: quién entra (sin sesión, anónimo, email sin confirmar, no admin, admin sacado de la lista o baneado: en cada pedido), que un usuario común no llegue a tocar nada, no banear ni eliminar a uno mismo ni a otro admin, los pedidos exactos a Auth (duraciones), a la base y a Stripe de cada acción, borrar cancelando Stripe antes (y no borrar si no se puede), la validación de cupones y códigos y sus pedidos a Stripe (con la vuelta atrás si el código ya existe), el cambio de precio completo (idempotencia, sin precio en el modo, portal, fallas), la edición de planes, el `index.ts` real con `@supabase/supabase-js` contra un `fetch` falso (API de administración de Auth y Storage), una revisión estática del SQL (RLS, permisos, `search_path`, firmas de las funciones sociales, que la función solo llame funciones que existen; `tests/security.test.ts` revisa 0014), lo que queda en el registro cuando una acción falla a mitad de camino, los borrados de más de 1000 archivos y la clave de idempotencia de las cancelaciones, y el cliente del launcher (caché de `admin:me`, errores, modo de capturas sin red).

**El SQL no se ejecuta en estas pruebas** (no hay Postgres en el repositorio): se revisó a mano. Probalo una vez en un proyecto de prueba: aplicá 0012, confirmá que `select public.is_admin();` (con tu sesión) da `true`, abrí el panel, baneá y desbaneá a un usuario de prueba, y verificá que un usuario silenciado no pueda mandar un mensaje.

Capturas con datos de ejemplo:

```bash
VENUS_DEVSHOT=<carpeta> VENUS_DATA_DIR=<carpeta-temporal> VENUS_SKIP_ONBOARDING=1 VENUS_ADMIN_FAKE=1 \
  VENUS_DEVSHOT_ROUTES="home|import('./js/features/admin.js').then((m) => m.startup());0;;admin/overview;;admin/users;;admin/team;;admin/plans;;admin/audit" \
  ./node_modules/.bin/electron .
```

## 8. Límites conocidos

- **Planes y Stripe:** un plan puesto o quitado desde el panel a alguien que paga con Stripe dura hasta la próxima lectura de Stripe, en segundos o minutos (sección 3): para cortarle la IA, cancelá su suscripción.
- **Reiniciar uso** no devuelve presupuesto en dólares: el gasto del mes es el costo real. Para darle más margen a alguien, cambiale el plan.
- **Tokens ya emitidos:** cerrar sesiones o banear no invalida el token de acceso que ya tiene (hasta 1 hora); lo social se corta igual al instante.
- **Voz:** silenciar no corta el Voice Chat (salas de 0003); solo lo social de 0002.
- **Archivos:** al eliminar una cuenta se borran sus archivos en vueltas de 1000 por bucket, hasta 20.000 por bucket; si queda alguno (o Storage no borra), el panel avisa `files_not_removed` y hay que borrar el resto desde Storage.
- **Cupones:** la lista muestra los 100 más nuevos de Stripe. Los cupones son solo en USD y los planes, mensuales.
- **Cambio de precio:** los suscriptores existentes no se mueven solos; si el portal no es el que creó `scripts/stripe-setup.js` (o el de `BILLING_PORTAL_CONFIGURATION`), no se actualiza (el panel avisa).
- **MRR:** es una estimación (sin descuentos, impuestos ni pruebas gratis).
- **Las lecturas no se registran** (solo lo que cambia algo).
- **Mensajes de error del servidor** en español (con un código estable para traducirlos en el launcher).
- **Errores de social:** hasta que social los traduzca, un usuario silenciado ve "Algo salió mal: user_muted" (sección 4).
