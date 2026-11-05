# Planes de clan 4.6

> Agente M. Migración `supabase/migrations/0044_clanes_planes.sql` (se aplica sobre producción tal como está: 0001 a 0043, 0045 y 0047). El "clan" es una **Comunidad**: el plan se compra para **una** comunidad y lo paga su dueño. Los Clanes viejos (tag, ranking) están retirados.

## Qué hay

| Pedido | Qué se hizo |
|---|---|
| Planes **Clanes Go, Pro, Max y Ultra** (US$ 2 / 4 / 6 / 10) | Tabla editable `community_plans`, pagos con Mercado Pago o PayPal con el mismo flujo que los planes de IA, períodos de 30 días que **se renuevan a mano** (sin débito automático; la interfaz y la página de vuelta del pago lo dicen). |
| Galería de GIFs, fotos y wallpapers | La tubería de Comunidades (`community_media`, cola de aprobación, KLIPY, denuncias) con el **límite según el plan**. Se suman JPEG, fotos de hasta 4 MB y 2560 px y GIFs de KLIPY guardados en la galería. |
| Fondos del chat y escenarios de voz | `community_backdrops`: un fondo para el chat de toda la comunidad o de un canal de texto, y un escenario para todas las salas de voz o para una. Imagen o GIF aprobado de la galería, o uno de los **12 incluidos** (dibujados con CSS y SVG propios). |
| Sacar el Venus Pass de los pagos | Fuera la rama `pass` de `payments_*`, `private.pass_quote`, `pass_fulfill`, `pass_revoke`, `pass_tier_rank`, `pass_purchase`, `PASS_PLAN`, los `pass_*` de la lista de planes y la clave `pass` de `payments_catalog()`. `pass_tiers` y `pass_purchases` **no se tocan**. |

## Tabla de planes y límites

Viven en `community_plans`; Administración los edita sin actualizar el launcher. Los números del código (`features/communities/fake-plans.js`, `billing/fake.js`) solo sirven de ejemplo y una prueba los compara con la migración.

| Plan | US$ | Galería | Fondos del chat | Escenarios | Animados | Miembros | Canales | Roles | Pendientes a la vez | Revisión |
|---|---|---|---|---|---|---|---|---|---|---|
| Gratis | 0 | 10 | 0 | 0 | no | 500 | 50 | 15 | 5 | normal |
| Go | 2 | 50 | 2 | 1 | no | 500 | 50 | 15 | 5 | normal |
| Pro | 4 | 150 | 6 | 4 | **sí** | 500 | 50 | 15 | 5 | normal |
| Max | 6 | 400 | 15 | 10 | sí | 500 | 50 | 15 | 10 | normal |
| Ultra | 10 | 1000 | 40 | 25 | sí | **5000** | **150** | **50** | 10 | **prioritaria** |

- Los 500 miembros, 50 canales y 15 roles del plan gratis son lo que ya estaba fijo en 0038: ahora salen de la tabla (`community_card`, `community_get`, `community_add_member`, `community_channel_create`, `community_role_save`).
- Cada fondo o escenario guardado gasta **un cupo** ("1 de 2"), sea un incluido o una imagen. El gratis tiene 0: los incluidos tampoco se pueden usar sin plan.
- "Animado" es un GIF (subido o de KLIPY), un WebP animado o uno de los incluidos animados (olas, deriva, aurora, fogata, campo de estrellas). **Límite conocido:** el servidor se fía de la bandera de WebP animado que manda el cliente (la lee del encabezado VP8X); lo único que gana quien la falsee es usar como fondo un WebP animado sin pagar Pro, y igual lo revisa un administrador.

## Períodos: cómo se apilan

Cada pago crea una fila de `community_plan_periods` (30 días, `period_days`). `private.community_plan(comunidad)` devuelve el plan de **mayor rango entre los períodos vigentes** (o el gratis).

- **Renovar el mismo plan:** el nuevo período empieza cuando termina el que queda. No se pierde nada (Go de 20 días que quedan + renovar = 50 días).
- **Comprar uno mayor:** empieza ya y **pausa** el tiempo de los menores (se corren 30 días): al terminar el mayor, vuelve lo que quedaba del menor.
- **Comprar uno menor mientras corre uno mayor (o igual):** espera detrás.
- **Devolución:** quita el período de esa orden (`payments_mark_status(..., 'refunded')`). El tiempo que la compra le sumó a otros períodos no se descuenta (queda a favor del dueño).
- **Vencimiento:** no se borra nada. La galería pasa al límite del plan nuevo: lo que lo excede se **oculta, lo más nuevo primero** (`private.community_media_hidden`: el cupo se cuenta por fecha de subida entre pendientes y aprobados). Los fondos y escenarios más nuevos que pasan el cupo, y los animados sin plan que los permita, dejan de verse (`state`: `hidden_plan`, `hidden_animated`, `media_unavailable`). Al renovar vuelven solos: es un cálculo, no un estado guardado.
- Los miembros no ven lo oculto (ni por la lista, ni por `community_media_resolve`, ni por Storage, ni en los mensajes). El dueño lo ve marcado como "Oculto por el plan".
- Quien paga es siempre el **dueño** (`not_owner` si no). La orden lleva `community_id`: el pago de una persona **no activa el plan de otra comunidad**, ni siquiera de otra del mismo pagador. Si la comunidad se borra después de pagar, la orden queda (`community_id` se pone en nulo), se registra `communityPlan.orphan` en el registro de administración para devolverla.

## Pagos

- Producto nuevo `clan_plan` en `payment_orders` (`plan_id` = `clan_go|clan_pro|clan_max|clan_ultra`, columna nueva `community_id`). El precio sale de `community_plans.price_usd` con la cotización y los impuestos de `payment_settings`, igual que los planes de IA (`private.clan_quote` → `private.payments_price`).
- `payments_create_order(p_user, p_plan, p_provider, p_live, p_community default null)`: la firma de 4 parámetros se **reemplaza** (el servidor desplegado hoy sigue funcionando para los planes de IA porque el nuevo parámetro es opcional).
- `payments_catalog()` suma `clans` (id, nombre, precio, días, límites y precio en pesos y dólares) y ya no trae `pass`.
- `payments_mark_paid` y `payments_mark_status` mantienen todo lo de IA y suman la rama de clan. Registro: `communityPlan.purchased`, `communityPlan.refunded`.
- `private.payments_revenue_rows()` (estadísticas de ingresos del panel de pagos, función `admin` que **no se redespliega**) ahora solo cuenta planes de IA; lo cobrado con planes de clan se ve en Administración > Comunidades > Planes de clan.
- Edge Function `payments`: acepta `{ plan: 'clan_*', provider, community }`, valida que `community` sea un id antes de llegar a la base, devuelve `unknown_community` (400) y `not_owner` (403), pone "30 días" en el título del cobro y su página de vuelta dice que el plan "se renueva a mano: no hay débito automático". El Venus Pass ya no es un plan válido.
- Launcher: `billing:checkout` acepta `{ plan, provider, community }`; `billing:catalog` trae `clans`; `billing:changed` avisa `{ kind: 'clan', community }` y **no refresca el saldo de IA**.

## Para aplicarlo y desplegarlo

1. Aplicar `0044_clanes_planes.sql` (idempotente; se detiene sin cambiar nada si existiera una orden `pass`; en producción hay 0).
2. Desplegar **solo** la Edge Function `payments` (`supabase/functions/payments/`: `handler.ts`, `webhook.ts` y `_shared/pagos/sync.ts`). **No** se tocan `admin`, `ai-assistant` ni `billing`.
3. El orden importa poco: con la migración aplicada y la función vieja, los planes de IA siguen igual; con la función nueva y sin la migración, comprar un plan de clan falla con "pagos no disponibles".
4. Cargar la cotización y las claves de pago como siempre (Administración > Pagos). Los planes de clan no necesitan nada más.

## Interfaz

- **Menú de la comunidad** (dueño y moderadores): *Plan de la comunidad* y *Fondos y escenarios*. Junto al nombre aparece una insignia con el plan si no es gratis.
- **Tarjeta Plan** (`pages/communities/plan.js`): plan actual y vencimiento (avisa cuando faltan 7 días o menos), uso de cada cupo con barras ("12 de 50"), qué da cada plan, precio en pesos y en dólares con impuestos y el botón *Comprar / Renovar / Sumar*. Solo el dueño puede comprar. Sin la migración o sin red muestra "no disponible" y un botón para reintentar.
- **Galería** (`pages/communities/gallery.js`): contador del plan, *Agregar GIF de KLIPY* (nace pendiente), JPEG y fotos grandes, y los elementos ocultos por el plan marcados.
- **Fondos y escenarios** (`pages/communities/looks.js`): pestañas *Fondos del chat* y *Escenarios de voz*, una fila por canal (más la de toda la comunidad), selector con los 12 incluidos y la galería, vista previa con mensajes de ejemplo, oscurecer (0 a 80) y desenfoque (0 a 20) y uso del cupo.
- **Chat** (`pages/communities/chat.js`, gancho `attachChatBackdrop`) y **sala de voz** (`voice/ui-room.js`, gancho de una línea con `attachStage` detrás de los miembros; no toca la lógica de voz): la capa se agrega solo si hay fondo y el plan lo permite. Los animados respetan "reducir movimiento" (los GIF de KLIPY usan su imagen fija).
- **Administración > Comunidades > Planes de clan** (`pages/admin/communities.js`): editar los límites de cada plan, buscar una comunidad y darle o quitarle un plan a mano (con días), ver sus períodos. La cola de GIFs muestra el plan y marca las comunidades Ultra con *Revisión prioritaria* (van primero).

## Fondos y escenarios incluidos

Dibujados en `styles/features/communityplans.css` (SVG en `data:` y gradientes, nada de internet ni de terceros). Lista en `features/communities/presets.js` y en la tabla `community_presets`.

- Fondos del chat: `soft_grid`, `dunes`, `paper_dots`, `mesh`, `waves` (animado), `drift` (animado).
- Escenarios de voz: `aurora` (animado), `neon_city`, `campfire` (animado), `starfield` (animado), `sunset_bay`, `night_forest`.

## RPC nuevas o cambiadas

| RPC | Quién | Para qué |
|---|---|---|
| `community_plan_get(comunidad)` | miembros | Plan, vencimiento, uso, períodos que esperan, ocultos y lista de planes |
| `community_backdrops_get(comunidad)` | miembros | Fondos y escenarios que valen (el equipo ve también los ocultos con su `state`) |
| `community_backdrop_set(comunidad, tipo, canal, origen, valor, oscurecer, desenfoque)` / `community_backdrop_clear(...)` | dueño y moderadores | Poner o quitar. Errores: `plan_limit`, `plan_animated`, `bad_channel`, `bad_preset`, `bad_media`, `bad_value` |
| `community_stage_get(sala)` | quien puede entrar | El escenario de una sala de voz de comunidad |
| `community_media_add_klipy(comunidad, nombre, url, still, slug)` | dueño y moderadores | GIF de KLIPY en la galería (pendiente) |
| `community_media_register(..., p_animated)` | dueño y moderadores | Ahora con JPEG, fotos y el límite del plan (`media_limit`, `media_pending_limit`) |
| `admin_community_plans`, `admin_community_plan_save`, `admin_community_plan_state`, `admin_community_plan_grant`, `admin_community_plan_revoke` | administradores | Ver, editar, dar y quitar. Todo queda en el registro (`communityPlan.edit/grant/revoke`) |

Cambian también (misma firma): `community_get` (suma `plan`, `maxRoles`), `community_media_list/resolve`, `admin_community_media_queue` (suma `source`, `url`, `still`, `animated`, `plan`, `priority`) y los límites de `community_channel_create`, `community_role_save` y la entrada de miembros. `private.community_media_check` convierte un GIF de KLIPY de la galería en un GIF de KLIPY al mandarlo al chat. El bucket `community-media` acepta ahora JPEG y 4 MB (el GIF sigue en 2 MB y 1024 px, lo vuelve a comprobar `community_media_register`).

## Archivos

- Base: `supabase/migrations/0044_clanes_planes.sql`, `supabase/tests/community-plans-local.sql`, `scripts/run-community-plans-local.ps1`.
- Pagos: `supabase/functions/payments/{handler,webhook}.ts`, `supabase/functions/_shared/pagos/sync.ts`, `src/main/modules/billing/{client,fake}.js`, `src/main/i18n/{es,en}/billing.js`, `src/renderer/js/features/plans.js` (`openCheckout` acepta planes de clan).
- Interfaz: `features/communities/{plan,presets,looks,fake-plans,media,backend,fake}.js`, `pages/communities/{plan,looks,looks-view,gallery,view,chat}.js`, `pages/communities.js`, `pages/admin/communities.js`, `voice/ui-room.js` (una línea), `styles/features/communityplans.css`, `i18n/{es,en}/communityplans.js` y retoques en `i18n/{es,en}/communities.js` (`galleryTitle`, `menuGallery`, `mediaUpload`).

## Pruebas

- SQL (`scripts/run-community-plans-local.ps1`, PostgreSQL 17.11 local con las migraciones reales 0001 a 0037 y 0038 y 0044 aplicada dos veces): 133 comprobaciones. Compra y renovación sin perder el período que queda, un plan mayor que pausa al menor y uno menor que espera, devolución (y devolver dos veces), vencimiento, pago de prueba y con otro monto o moneda, aviso repetido, que un miembro, un moderador o el dueño de otra comunidad no puedan comprar, que el pago de una persona no active el plan de otra comunidad, límites por plan (galería, pendientes, canales, roles, miembros, Ultra), lo oculto que vuelve al renovar (lista, `resolve` y Storage), JPEG y fotos grandes, fondos y escenarios (cupos, animados, canales equivocados, imagen pendiente), escenario de una sala, KLIPY y cola con prioridad, Administración, comunidad borrada tras pagar, planes de IA intactos y permisos de cada función.
- `node --test "supabase/functions/payments/tests/*.test.ts"` (16, con las de `clan-plans.test.ts`), `node --test "src/main/modules/billing/test/*.test.js"` (9), `node --test "src/renderer/js/pages/communities/test/*.test.js"` (con `plan.test.js` y `plan-ui.test.js`: tarjeta Plan con una orden falsa de dueño y de miembro, sin medios de pago, sin servidor).
- Capturas con `VENUS_DEVSHOT` + `VENUS_REWARDS_FAKE=demo` + `VENUS_BILLING_FAKE=1`, en español e inglés, `console.log` vacío: tarjeta Plan gratis, compra de Pro con orden falsa (que se acredita sola), plan activo con "Renovar / Sumar / Comprar", editor de fondos, selector con vista previa, chat con fondo, escenario en una sala de voz de demostración, galería con el cupo y Administración.

## Lo que no se probó

- **Un pago real** con Mercado Pago o PayPal (ni su devolución): la tubería del servidor se probó con proveedores falsos.
- La migración se corrió completa solo en el PostgreSQL local (con las migraciones reales hasta la 0038); contra producción se comprobó solo lectura (las funciones y tablas que usa existen, la versión es PostgreSQL 17.11, no hay archivos de galería ni órdenes `pass`).
- La política de inserción de Storage con los límites nuevos y el JPEG (la suite de F la prueba con el cupo viejo); el escenario con **dos PC y audio real**.
- Las traducciones de los otros 12 idiomas: las claves nuevas caen al inglés.
- Moderadores: pueden poner y quitar fondos y escenarios y subir a la galería gastando el cupo del dueño (como ya subían GIFs).

## Objetos de base de datos sin uso

`pass_tiers`, `pass_purchases` (a pedido), las columnas `season_id` y `pass_tier` de `payment_orders` y su restricción `payment_orders_pass_tier_check`. Las claves `communities.galleryCount` y `communities.galleryRules` ya no se usan (en los 14 idiomas).
