# Comunidades

> **Estado del 4 de noviembre de 2026.** La base de comunidades de `0033_clanes_comunidades.sql` ya está aplicada en producción; la activación general llegó hasta 0037. **0038 está preparada y pasó 318 comprobaciones SQL locales; no se aplicó en producción.** Requiere autorización específica antes de activarse. El launcher y la web siguen sin publicar. Ver [estado general](../estado-4.5.0.md) y [activación del backend](../activacion-backend-4.5.0.md).

El usuario pidió retirar Clanes de la aplicación, sin borrar sus datos de producción. Ese cambio de UI pertenece a otro frente. **0038 modifica solo comunidades y su integración con voz**: conserva las tablas, filas y funciones de clanes y las firmas anteriores de comunidades. Los apartados de Clanes que siguen al final son antecedentes históricos, no una propuesta para volver a mostrar esa sección.

## Alcance de 0038

El contrato siguiente fue acordado con el frente de UI de comunidades (Boole). El backend ejecuta operaciones reales sobre categorías, canales, temas y respuestas; no depende de datos demo. El test SQL no certifica por sí solo formularios, navegación, capturas ni funcionamiento entre dos sesiones reales. La integración del renderer y sus pruebas se entregan desde ese frente.

- Personalización de la comunidad mediante colores, iconos y presets locales, más bienvenida y reglas editables.
- Hasta **20 categorías ordenadas** y **50 canales** por comunidad, con creación, edición, orden y borrado.
- Tipos `text`, `voice`, `announcement` y `forum`; el tipo de un canal existente es inmutable.
- Descripción e icono del canal, categoría opcional, publicación por miembros o por staff, espera entre publicaciones y acceso privado de staff.
- Foro con temas y respuestas persistentes, paginación y borrado suave del tema junto con sus respuestas.
- Se mantienen los topes previos de 500 miembros, 3 comunidades propias y 100 membresías por cuenta.

No hay cargas de imágenes, URLs de banners, nuevos buckets ni estilos arbitrarios. Tampoco se agregaron edición de mensajes, reacciones, hilos anidados o archivado de canales.

## Apariencia y textos

`community_customize(p_community uuid, p_patch jsonb)` es exclusiva del dueño y devuelve `community_get(p_community)`. Solo acepta las claves de esta tabla; una entrada inválida revierte la operación completa.

| Campo | Valores / límite | Inicial |
|---|---|---|
| `theme` | `default`, `cozy`, `compact` | `default` |
| `color` | `#RRGGBB`; se normaliza a minúsculas | `#f6b45a` |
| `icon` | Lista fija de abajo | `users` |
| `banner` | `none`, `aurora`, `sunset`, `forest`, `ocean`, `stars` | `none` |
| `welcome` | Texto de hasta 2000 caracteres | Vacío |
| `rules` | Texto de hasta 4000 caracteres | Vacío |

Iconos: `users`, `gamepad`, `star`, `heart`, `shield`, `flame`, `mountain`, `moon`, `zap`, `book`, `message-circle`, `headphones`, `megaphone`, `hash`.

`community_update(p_community, p_patch)` conserva `name`, `description` e `isPublic` y su respuesta anterior. Las tarjetas de comunidad añaden `theme`, `color`, `icon`, `banner`, `maxChannels: 50` y `maxCategories: 20`. **Bienvenida, reglas, categorías y canales solo aparecen en `community_get` para miembros autorizados**; una cuenta que consulta una comunidad pública sin ser miembro sigue recibiendo solo la tarjeta.

Los textos son datos. Se validan longitudes y controles en el servidor; el renderer debe tratarlos como texto o con su renderizador seguro existente, nunca como HTML, CSS ni instrucciones.

## Categorías y canales

Staff significa **dueño o moderador**. Ambos gestionan categorías y canales; solamente el dueño modifica la apariencia y los textos de la comunidad.

| RPC | Resultado / comportamiento |
|---|---|
| `community_category_save(p_community uuid, p_name text, p_category uuid default null)` | Crea o renombra; nombre de 1–40 caracteres. Devuelve `{ id, name, position }`. |
| `community_category_delete(p_category uuid)` | `{ ok: true }`. Desagrupa los canales; no borra sus mensajes ni salas. |
| `community_category_reorder(p_community uuid, p_ids uuid[])` | Lista completa, sin duplicados ni categorías ajenas. `{ ok: true }`. |
| `community_channel_create(p_community uuid, p_kind text, p_name text)` | Conserva la firma de 0033, admite los cuatro tipos y devuelve el canal completo. |
| `community_channel_create_configured(p_community uuid, p_kind text, p_name text, p_patch jsonb default '{}')` | Creación y configuración **atómicas**. Si falla cualquier campo, no queda un canal parcial. |
| `community_channel_configure(p_channel uuid, p_patch jsonb)` | Modifica solo los campos de abajo y devuelve el canal completo. |
| `community_channel_rename(p_channel uuid, p_name text)` | Firma anterior; devuelve `{ ok: true }`. |
| `community_channel_delete(p_channel uuid)` | **Borrado definitivo**: elimina mensajes y, si es de voz, su sala. Permite borrar el último canal. La UI debe confirmar antes. |
| `community_channels_reorder(p_community uuid, p_ids uuid[])` | Firma anterior; lista completa y sin duplicados, `{ ok: true }`. |

| Campo del patch de canal | Validación / efecto |
|---|---|
| `name` | 1–30 caracteres de una línea. |
| `topic` | Descripción de hasta 500 caracteres. |
| `icon` | Misma lista fija de iconos de comunidad. |
| `categoryId` | UUID de categoría de la misma comunidad o `null` para desagrupar. |
| `slowmodeSeconds` | Entero entre 0 y 21600. Solo texto, anuncios y foro; voz permanece en 0. |
| `postingRole` | `members` o `staff`. Anuncios siempre `staff`; voz mantiene `members` porque no publica mensajes. |
| `isPrivate` | Booleano; si es `true`, solo dueño y moderadores acceden al canal. |

`community_get` conserva sus campos anteriores y añade `categories: [{ id, name, position }]`. Cada canal devuelve:

```text
{ id, kind, name, position, people, topic, icon, categoryId,
  slowmodeSeconds, postingRole, isPrivate, canPost, nextPostAt }
```

Las categorías son compartidas entre los miembros; **la privacidad pertenece al canal**, no a su categoría. Los canales privados quedan fuera de la lista y del contador visible para miembros comunes. `people` conserva el uso anterior para voz y es `[]` en los demás tipos.

`canPost` expresa los permisos, el tipo y los silencios; **no** incluye el reloj del slowmode. `nextPostAt` es un timestamp ISO o `null` para la cuenta actual, calculado otra vez al recargar. El slowmode aplica a miembros; dueño y moderadores están exentos. Borrar un mensaje propio no reinicia esa espera. Texto, temas y respuestas comparten además el límite previo de **30 publicaciones por minuto y cuenta**.

## Mensajes y foros

`community_send(p_channel, p_body)` y `community_messages_page(p_channel, p_before?, p_limit?)` mantienen sus firmas y ahora admiten texto y anuncios. **Rechazan voz y foro**. En anuncios solo publica staff.

| RPC de foro | Resultado |
|---|---|
| `community_forum_topics(p_channel uuid, p_before timestamptz default null, p_limit integer default 30)` | Array de temas raíz, del más reciente al más antiguo. |
| `community_forum_topic_create(p_channel uuid, p_title text, p_body text)` | Crea y devuelve un tema; título de 3–120 y cuerpo de 1–2000 caracteres. |
| `community_forum_replies(p_topic uuid, p_before timestamptz default null, p_limit integer default 50)` | Página de respuestas del tema, ordenada de la más antigua a la más reciente. |
| `community_forum_reply(p_topic uuid, p_body text)` | Crea y devuelve una respuesta; cuerpo de 1–2000 caracteres. Solo admite como padre un tema raíz. |
| `community_message_delete(p_id uuid)` | Firma anterior. Autor o staff; borrar un tema marca también sus respuestas como borradas. |

Las lecturas admiten hasta 100 filas por página. `p_before` es una fecha exclusiva, como en el historial anterior. Los mensajes mantienen `{ id, channelId, communityId, authorId, at, body, deleted, hidden, author }` y añaden `title`, `parentId` y `replyCount`. Un tema tiene `parentId: null`; una respuesta, el UUID de la raíz y `title: null`.

Un foro configurado con `postingRole: staff` restringe **temas y respuestas**. No hay respuestas anidadas. Borrar suavemente un tema conserva sus identificadores y fechas, pero deja `deleted: true`, `body: ''` y `title: null` tanto en la raíz como en las respuestas. El servidor rechaza tanto la lectura de respuestas como nuevas respuestas con `thread_deleted` tras borrar la raíz; la UI debe deshabilitar el formulario incluso si no llegó el evento Realtime. El mismo tratamiento se aplica cuando Administración modera la raíz.

## Autorización, bloqueos y voz

Todas las RPC de comunidades requieren el rol autenticado y vuelven a comprobar identidad, membresía y permisos. Las auxiliares permanecen privadas; solo las funciones necesarias para RLS son ejecutables desde el rol autenticado. `community_categories` tiene RLS y no admite acceso directo del cliente.

La política de `community_messages` y las RPC comparten el filtro: membresía vigente, ausencia de baneo, acceso al canal privado y bloqueos entre lector y autor. Una raíz bloqueada también oculta sus respuestas. A diferencia del comportamiento histórico de 0033, las filas bloqueadas se **omiten** del historial/RLS. El bloqueo entre dueño y miembro impide acceder al contenido de la comunidad, aunque exista una membresía anterior. Se conserva la posibilidad de salir.

Al hacer privada una sala de voz o retirar un rol de staff, las admisiones y sesiones que ya no correspondan se eliminan. Salir o ser expulsado también revoca acceso. La comprobación cubre `community_voice_room`, el ingreso por código, el latido, la consulta de sala, Recientes, claves públicas de sesión y las políticas de Realtime. Las salas independientes de Voice Chat conservan su comportamiento.

La migración no convierte los canales de voz en canales de chat y no publica mensajes de texto en ellos. Una sala sigue teniendo hasta ocho participantes. La revocación de una sesión multimedia ya establecida depende también del cliente y de sus latidos: **no se comprobó desconexión inmediata entre dos PC ni audio real**.

`community_messages` continúa en la publicación de Realtime; las filas nuevas añaden `parent_id` y `title`. El consumidor distingue raíz y respuesta mediante `parent_id`, mantiene su consulta periódica como respaldo y vuelve a comprobar el acceso al refrescar. Las aserciones SQL de políticas no equivalen a validar entrega o revocación de una suscripción Realtime ya abierta.

## Errores del contrato

- `22023`: validación (`bad_request`, `bad_name`, `bad_description`, `bad_theme`, `bad_color`, `bad_icon`, `bad_banner`, `bad_welcome`, `bad_rules`, `bad_category_name`, `bad_category`, `bad_channel_name`, `bad_topic`, `bad_slowmode`, `bad_posting_role`, `bad_kind`, `bad_order`, `bad_title`, `bad_body`), límites (`too_many_categories`, `too_many_channels`), `not_found`, `thread_deleted` y `community_muted`.
- `42501`: `not_authenticated`, `not_member`, `forbidden`, `user_banned` o `user_muted`, según la operación.
- `PT429`: `rate_limited` o `slowmode`; este último agrega `details` como JSON de texto con `{ nextPostAt }`.

Los códigos anteriores de crear, entrar, moderar y transferir comunidades siguen vigentes. La UI debe distinguir un backend todavía sin 0038 y no mostrar una operación como completada si su RPC falla.

## Ensayo SQL local de 0038

Archivos de este frente:

- [Migración 0038](../../supabase/migrations/0038_comunidades.sql).
- [Escenarios SQL reproducibles](../../supabase/tests/communities-local.sql).
- [Runner PostgreSQL local](../../scripts/run-communities-local.ps1).

```powershell
./scripts/run-communities-local.ps1 -PgBin "$env:TEMP/venus-sql-pg17-20261103/pgsql/bin"
```

**Resultado: 318 comprobaciones aprobadas en PostgreSQL 17.11.** Base y clúster nuevos; fixture `managed-schemas-minimal.sql` sin alterar, migraciones **0001–0037 completas** y **0038 dentro de `BEGIN/ROLLBACK`**. El runner comprobó esquema/ACL, filas y secuencias idénticos antes y después, hashes de entradas sin cambios y apagó el clúster. `pg_net` no estaba disponible y 0035 degradó como estaba previsto. No se usaron secretos; Vault permaneció como catálogo mínimo vacío.

Evidencia: `%TEMP%/venus-communities-sql-20261104-145016-b2c4e44e/result.json`, `test.log`, volcados de esquema y huellas de filas/secuencias. SHA-256 ensayado de 0038: `ba602bba55fcd342be53146b85b458116d9b6b21bc22f1ebcc92e595614d435e`.

Se ejercitaron las RPC reales para personalización, categorías, orden, creación atómica, todos los tipos, tópicos/respuestas, paginación, borrados, topes, slowmode, anuncios, publicaciones de staff, bloqueos, silencio, baneo, expulsión y salida. Se comprobaron RLS y las rutas de voz al privatizar un canal y degradar un moderador, además de una sala de voz independiente. Las firmas previas se conservaron y las funciones de clanes/auxiliares compartidas quedaron intactas.

**Límites:** fixtures parciales de Auth/Storage/Realtime; sin JWT real, HTTP, audio, dos sesiones conectadas, concurrencia entre conexiones ni entrega Realtime real. Los destinos de push y `realtime.send` se sustituyeron solo dentro del ensayo para impedir salidas externas. Las pruebas previas de 0033 y la suite de 1282 comprobaciones son antecedentes distintos. No hubo migración de producción, commit, push ni publicación desde este frente.

## Antecedentes de 0033 y revisión anterior

Los apartados siguientes se conservan como historial del 3 de noviembre. Sus rutas de Clanes, tope de 20 canales, mensajes bloqueados con `hidden`, ausencia de respuestas y referencias a migraciones pendientes describen aquella entrega; **no sustituyen el contrato de 0038 de arriba ni el estado actual de producción**.

### Cómo se usa

#### Clanes

- **Crear:** nombre único (3 a 30), tag único (2 a 5 letras o números, se guarda en mayúsculas), descripción, color y emblema de listas fijas. El nombre y el tag no se pueden cambiar después. Palabras como `admin`, `venus`, `staff`, `mod` u `oficial` están reservadas, también escritas con números o letras cirílicas parecidas.
- **Una cuenta en un solo clan**, 50 miembros por clan y un clan creado por cuenta mientras ese clan exista (aunque ya no estés adentro).
- **Entrar:** invitación a un amigo (vence a los 7 días), código `CLAN-XXXXXX` regenerable o, si el clan es abierto, solicitud que aprueba un oficial. Quien está baneado no crea ni entra. Quien está silenciado entra, pero no crea, ni edita, ni invita.
- **Roles:**

| Acción | Líder | Oficial | Miembro |
|---|---|---|---|
| Invitar, ver y cambiar el código, aprobar solicitudes | Sí | Sí | No |
| Expulsar | A cualquiera | Solo a miembros | No |
| Promover o bajar a oficial, pasar el liderazgo, editar | Sí | No | No |

- **Salir:** el líder con más gente pasa el liderazgo antes (`leader_must_transfer`). Si se va el último, el clan se disuelve y su nombre y su tag quedan libres. Si se borra la cuenta del líder, lo toma el oficial (o el miembro) más antiguo. Expulsar cambia el código, para que no vuelva a entrar con el mismo.
- **Tag visible:** junto al nombre en la tarjeta de perfil (`social/profile-ui.js`) y en la página del clan. Siempre como texto.
- **Ranking semanal** (lunes a domingo, UTC, hasta 12 semanas atrás): suma horas de miembros actuales que habilitaron compartir en Competir **y** el permiso separado del clan (`clan_prefs.share_playtime`, apagado por defecto), sin baneados. Con menos de 2 participantes habilitados da cero y se explica por qué. Ese mínimo no garantiza anonimato: con dos aportantes, uno puede deducir las horas del otro. El total es visible a usuarios con sesión, puede incluir horas previas al ingreso y no da puntos ni dinero.
- **Permiso para aportar horas:** tarjeta en Clanes y en Competir → Rankings, incluso sin pertenecer a un clan. Apagado por defecto; activar requiere confirmación y apagar es directo. Es de la cuenta y se conserva al cambiar de clan. No activa compartir con amigos ni manda nuevos datos. Se incluyen las horas ya enviadas; cualquier cuenta con sesión puede consultar los totales semanales, acumulados y logros.
- **Logros del clan:** 5, 20 y 50 miembros; 30, 180 y 365 días; 100, 1.000 y 5.000 horas compartidas. Se calculan al pedirlos: si el clan baja de miembros, el logro se apaga.

#### Comunidades

- **Crear:** nombre único (3 a 40), descripción, pública o por código. Hasta 3 por cuenta y 500 miembros. Arranca con un canal de texto y uno de voz llamados `general`. Hasta 100 comunidades por cuenta como miembro.
- **Entrar:** pública, se busca y se entra. Por código (`COM-XXXXXX`, regenerable), no aparece en el buscador ni se puede leer sin ser miembro.
- **Roles:**

| Acción | Dueño | Moderador | Miembro |
|---|---|---|---|
| Canales (hasta 20): crear, renombrar, ordenar, borrar | Sí | Sí | No |
| Ver y cambiar el código, ver expulsados y dejar volver | Sí | Sí | No |
| Silenciar y expulsar | A cualquiera | Solo a miembros | No |
| Borrar mensajes de otros | Sí | Sí | No |
| Nombrar moderadores, editar, pasar y borrar la comunidad | Sí | No | No |

- **Expulsar** deja afuera, también de las salas de voz y aunque tenga el código, hasta que un moderador lo deje volver. **Silenciar** dura de 10 minutos a 7 días en la interfaz (el servidor acepta hasta 30 días) y no se borra saliendo y volviendo a entrar.
- **Canales de texto:** historial de a 50, hasta 2000 caracteres, 30 mensajes por minuto por cuenta. Se muestran con `renderBody` de `social/richtext.js`, sin HTML. Cada uno borra el suyo. La pantalla aclara que no están cifrados de punta a punta y que los moderadores los ven.
- **Canales de voz:** cada uno abre una sala del Voice Chat de siempre, creada a pedido y reutilizada, y navega a `#/voice`. Se ve quién está en cada canal (se actualiza cada 20 s).
- **Denuncias** de mensajes, comunidades y clanes: 10 por día y una abierta por cosa. Queda una copia de lo denunciado, aunque después se borre.

#### Bloqueos y baneos

- Baneado (`moderation_social_block`): no crea, no entra, no lee canales ni por la RPC ni por la tabla ni por Realtime. Puede salir.
- Silenciado de la cuenta: entra y lee, no escribe ni crea.
- Si el líder del clan o el dueño de la comunidad te bloqueó, para vos no existe: no aparece en los buscadores y entrar responde `not_found`, sin avisar del bloqueo.
- Los mensajes de quien bloqueaste llegan sin texto (`hidden`) y se muestran como "Mensaje de una cuenta que bloqueaste".
- Invitar a un clan exige ser amigos aceptados (`private.are_friends`).

#### Administración

Pestaña **Clanes y comunidades** de `#/admin` (`pages/admin/clans.js`): buscar, ver miembros y canales, disolver, quitar gente y resolver denuncias. Queda en `admin_log` como `clan.dissolve`, `community.dissolve`, `clan.removeMember`, `community.removeMember` y `groupReport.close`. Las lecturas no se registran. Al disolver no se avisa a los miembros.

### Archivos

| Parte | Dónde |
|---|---|
| Esquema y reglas | `supabase/migrations/0033_clanes_comunidades.sql` |
| Avisos e invitaciones sin abrir la página | `src/renderer/js/features/clans.js` |
| Datos, errores y Realtime | `features/clans/backend.js` |
| Permiso separado de horas | `features/clans/sharing.js`, usado desde `pages/clans.js` y `pages/compete/rankings.js` |
| Lógica pura compartida (validación, roles, logros, semanas) | `features/clans/logic.js` |
| Tag, emblema y denuncias | `features/clans/tag.js`, `features/clans/report.js` |
| Datos de ejemplo | `features/clans/fake.js` |
| Clanes | `pages/clans.js`, `pages/clans/profile.js`, `pages/clans/forms.js` |
| Comunidades | `pages/communities.js`, `pages/communities/view.js`, `chat.js`, `forms.js`, `logic.js` |
| Administración | `pages/admin/clans.js` |
| Tag en la tarjeta de perfil | `social/profile-ui.js` (una línea y un import) |
| Estilos | `styles/pages/clans.css` (prefijos `cl-` y `cm-`) |
| Textos | `i18n/{es,en}/clans.js` y aclaración de `shareSees` en `i18n/{es,en}/compete.js` |
| Pruebas | `features/clans/test/`, `pages/communities/test/` |

### Ajustes, señales y Realtime

- `settings.clans.seen`: hasta 100 invitaciones ya avisadas (`<clan>:<momento>`), para no repetir el aviso. No hay tarjetas en Ajustes.
- Señal `clan-update` (`{}`), por `social.sendSignal`: un amigo te invitó o respondió, volver a preguntar. El contenido no se usa. Solo viaja entre amigos: una solicitud de alguien que no es amigo se ve al abrir la página o en la próxima consulta (a los 20 s de abrir y cada 15 minutos).
- Número en el menú: `setNavBadge('clans', invitaciones + solicitudes)`.
- Realtime: `postgres_changes` sobre `community_messages` con `channel_id=eq.<canal>`, solo mientras el canal está abierto. La política de la tabla decide quién recibe: a quien expulsan le dejan de llegar. Si el canal se cae, una consulta cada 30 s.

### Tablas y RPC

Con RLS y sin acceso directo: `clan_prefs`, `clans`, `clan_members`, `clan_invites`, `clan_requests`, `communities`, `community_members`, `community_bans`, `community_mutes`, `community_channels`, `group_reports`. `community_messages` tiene RLS y `select` para miembros (lo usa Realtime), y se escribe solo por RPC.

| RPC | Para qué |
|---|---|
| `clan_me()`, `clan_get(p_clan)`, `clan_search(p_query)`, `clan_tags(p_users)`, `clan_ranking(p_week?)` | Lecturas. `clan_tags`: hasta 100 cuentas |
| `clan_share_playtime(p_share)` | Permiso de la cuenta para contribuir horas; devuelve `{ sharePlaytime }`. `clan_me()` también lo devuelve en la raíz, incluso sin clan |
| `clan_create(p_name, p_tag, p_description, p_color, p_emblem, p_open)`, `clan_update(p_patch)` | Crear (5 por día) y editar (`description`, `color`, `emblem`, `isOpen`) |
| `clan_invite(p_user)`, `clan_invite_cancel(p_user)`, `clan_invite_respond(p_clan, p_accept)` | Invitar a un amigo (40 por hora) |
| `clan_request(p_clan)`, `clan_request_cancel(p_clan)`, `clan_request_respond(p_user, p_accept)` | Solicitudes (5 pendientes por cuenta, 100 por clan) |
| `clan_join_code(p_code)`, `clan_regen_code()` | Código (20 intentos cada 10 minutos) |
| `clan_leave()`, `clan_kick(p_user)`, `clan_set_role(p_user, p_role)`, `clan_transfer(p_user)` | Salir, expulsar, roles y liderazgo |
| `community_my()`, `community_search(p_query)`, `community_get(p_community)`, `community_members_list(p_community, p_offset?)`, `community_bans_list(p_community)` | Lecturas. Miembros de a 100 |
| `community_create(p_name, p_description, p_public)`, `community_update(p_community, p_patch)`, `community_delete(p_community)`, `community_transfer(p_community, p_user)` | Administrar (crear: 5 por día) |
| `community_join(p_community)`, `community_join_code(p_code)`, `community_regen_code(p_community)`, `community_leave(p_community)` | Entrar y salir |
| `community_set_role(p_community, p_user, p_role)`, `community_mute(p_community, p_user, p_minutes)`, `community_kick(p_community, p_user)`, `community_unban(p_community, p_user)` | Moderación |
| `community_channel_create(p_community, p_kind, p_name)`, `community_channel_rename(p_channel, p_name)`, `community_channel_delete(p_channel)`, `community_channels_reorder(p_community, p_ids)` | Canales |
| `community_messages_page(p_channel, p_before?, p_limit?)`, `community_send(p_channel, p_body)`, `community_message_delete(p_id)` | Mensajes |
| `community_voice_room(p_channel)` | `{ code, roomId, name, max }`, solo para miembros |
| `community_report(p_kind, p_id, p_reason, p_text?)` | Denunciar |
| `admin_groups(p_kind, p_query)`, `admin_group_detail(p_kind, p_id)`, `admin_group_dissolve(p_kind, p_id, p_reason?)`, `admin_group_remove(p_kind, p_id, p_user, p_reason?)`, `admin_group_reports()`, `admin_group_report_close(p_id, p_remove?)` | Panel (`admin_guard`) |

Los errores son el texto de la excepción (22023 validación, 42501 permisos, PT429 límite) y se traducen con `clans.err_<código>`. Los códigos equivocados devuelven `{ error: 'not_found' }` en vez de cortar: cortar desharía el intento y no quedaría contado.

No redefine funciones existentes ni `points_ledger_reason_check`. No necesita 0031: lee sus tablas con SQL dinámico y, sin ellas, `available: false`.

#### Cómo funciona la sala de voz de un canal

`community_voice_room` crea una fila de `voice_rooms` con `is_locked` y `is_private` (la primera vez) y, en cada pedido, invita 30 minutos a quien la pidió (`voice_members.invited_at`). Así `voice_join` responde `locked` a quien solo tiene el código, sin tocar las funciones de 0003. Expulsar marca `banned` en la sala; salir borra la admisión. `voice_rooms.owner` no admite otra cosa que una cuenta: el dueño de la sala es el dueño de la comunidad y cambia con él.

### Límites

- **Privacidad del ranking, decisión aprobada el 3/11/2026:** permiso separado `clan_prefs.share_playtime`, apagado por defecto. La UI y `compete.shareSees` ahora distinguen compartir con amigos de aportar al agregado público del clan. Se requieren ambos permisos. El consentimiento incluye horas ya enviadas y persiste entre clanes; apagar amigos deja de aportar sin borrar el permiso del clan. El mínimo de 2 no garantiza anonimato. Los cambios de UI y de 0033 deben integrarse juntos; no alcanza con cambiar el texto.
- **Las horas del ranking las informa cada PC** (0031): sirve para jugar, no como competencia oficial. Cuentan los miembros actuales, también por lo que jugaron antes de entrar.
- **Voz:** hasta 8 personas por canal (`voice_rooms.max_members`). Solo el dueño de la comunidad es anfitrión: los moderadores no expulsan dentro de la sala. Las salas cuentan para el tope de 12 de `voice_create_room` de su dueño y aparecen en sus salas hasta que pasa una hora sin uso y alguien vuelve a abrir un canal. A quien entró alguna vez la sala le aparece en Recientes, aunque ya no pueda entrar. Si el dueño abre la sala desde Voice Chat, queda sin cerrar hasta el próximo pedido.
- **Homoglifos:** la lista de palabras reservadas cubre números y cirílico parecido, no todo Unicode. Lo que se escape se resuelve desde el panel.
- **El nombre y el tag del clan no se cambian.** Quedan reservados mientras el clan exista.
- **Los mensajes no se borran solos:** no hay retención por tiempo. Tampoco hay contador de no leídos, respuestas, reacciones ni edición.
- **Sin push:** los avisos llegan con el launcher abierto.
- Al expulsar, los mensajes viejos de esa persona quedan. Se borran con la cuenta.
- Los textos de los otros 12 idiomas todavía no existen.

### Pruebas

- `node --test "src/renderer/js/features/clans/test/*.test.js" "src/renderer/js/pages/communities/test/*.test.js"`: validación de nombres y tags (mismos vectores que la migración), códigos, colores y emblemas ajenos, permisos de cada rol, logros, semanas, errores, fusión de mensajes, filas de Realtime y agrupado.
- **Antecedente de la entrega previa, no repetido por este frente:** la migración se probó contra la base en una transacción revertida, aplicándola dos veces seguidas para comprobar que es idempotente: 489 comprobaciones, todas bien (roles y topes, intentos de un miembro de hacer cosas de oficial, de un no miembro de leer un canal por la RPC y por la tabla, baneados, bloqueos, voz, denuncias y panel). Aparte se comprobó que el arnés detecta fallas, con controles que tenían que fallar. Las tablas de 0031 se recrearon con las columnas que usa el ranking; 0031 no se aplicó.
- Capturas sin servidor: `VENUS_DEVSHOT=<carpeta> VENUS_DATA_DIR=<carpeta-temporal> VENUS_SKIP_ONBOARDING=1 VENUS_REWARDS_FAKE=demo|new|signedOut|unavailable VENUS_ADMIN_FAKE=1 VENUS_DEVSHOT_ROUTES="clans/mine;;clans/browse;;clans/ranking;;clans/view/c-2;;communities;;communities/explore;;communities/m-1;;admin/clans"`.
- **Sin probar:** Realtime con dos sesiones reales (la política sí, por la tabla y con cada rol), entrar a una sala de voz con audio desde la interfaz (`voice_join` sí, por SQL; en el modo de capturas el botón solo navega), concurrencia real de dos pedidos a la vez sobre el último lugar de un clan o una comunidad (una transacción de prueba es una sola) y el vencimiento de una invitación de 7 días.

### Pendiente para quien integra

- El contrato UI/0033 del permiso separado está implementado y el agente SQL informó sus aserciones aprobadas en PostgreSQL local con fixtures. La decisión de privacidad y los textos ES/EN están resueltos. Sigue pendiente la validación con Supabase real antes de publicar; la prueba del renderer no certifica RLS ni concurrencia. Ver [revisión SQL](revision-sql-0028-0036.md).

### Informe final — revisión local del 3 de noviembre de 2026

Se contrastaron las rutas, pantallas, backend, datos demo, roles, RPC y textos con el código. La revisión defensiva del renderer mantuvo nombres, descripciones y mensajes como datos. No se ejecutaron reproducciones de exploits ni se probó contra usuarios reales.

Correcciones verificadas:

- **Clanes:** una respuesta pendiente de Mi clan ya no reemplaza la pestaña de búsqueda elegida después. Cada pestaña recibe un panel propio, que se desconecta al salir.
- **Mensajes de comunidades:** Enter repetido no duplica un envío; el refresco de permisos mantiene ocupado el botón; se conserva el siguiente borrador y el de un envío rechazado. Una respuesta tardía no borra ni enfoca un chat cerrado.
- **Vista de comunidad:** al borrar el canal abierto se elige otro canal de texto o se muestra el estado vacío. Al perder la membresía o desaparecer la comunidad se cierran el chat y la suscripción; un fallo transitorio de red conserva la vista. Se descartan lecturas de comunidad atrasadas y listas de miembros que llegan después de perder acceso.
- **Permiso de horas:** la tarjeta común espera la lectura del servidor, no escribe al abrir, confirma antes de activar y no cambia `ranking_set_share` ni los ajustes de recolección. Ante una respuesta perdida deja de afirmar el estado y exige releer. Si cambia la cuenta durante la confirmación, no escribe para la cuenta nueva. Un servidor sin el contrato mantiene el control inhabilitado.

#### Contrato coordinado con el agente de base de datos

La implementación SQL pertenece a ese agente; este frente no modificó migraciones.

- `clan_me()` agrega `sharePlaytime: boolean` en la raíz, por defecto `false`, incluso con `clan: null`.
- `clan_share_playtime({ p_share: boolean })` devuelve `{ sharePlaytime: boolean }`, para la propia cuenta autenticada; `null` apaga. La UI solo envía booleanos y exige una respuesta booleana coincidente antes de mostrar éxito.
- `private.clan_shared` y `clan_ranking` filtran por `clan_prefs.share_playtime = true` **y** `ranking_prefs.share = true`, con el mínimo existente de 2 y la exclusión de baneados.
- `features/clans/fake.js` simula lectura y cambio del permiso en memoria, apagado inicialmente. La tarjeta de Competir usa el mismo backend de clanes, por lo que la elección demo no se duplica en otro estado independiente.

La nueva redacción ES/EN explica el público, las horas previas, la relación entre ambos permisos, la persistencia entre clanes y el límite de anonimato. `compete.shareSees` deja de prometer que todo lo enviado solo lo ven amigos. No se pidió ni se accedió a credenciales.

#### Evidencia de esta sesión

La corrida inicial dio **50/50** (29 de semillas, 13 de clanes y 8 de comunidades) en 58,3 s. Las regresiones de fallos de interfaz se comprobaron fallando antes de corregirlas. La verificación final focalizada dio **66/66**, sin fallos, cancelaciones ni omisiones, en 0,81 s:

```powershell
node --test src/renderer/js/features/clans/test/logic.test.js src/renderer/js/features/clans/test/page.test.js src/renderer/js/features/clans/test/sharing.test.js src/renderer/js/pages/communities/test/logic.test.js src/renderer/js/pages/communities/test/chat.test.js src/renderer/js/pages/communities/test/view.test.js src/renderer/js/pages/seeds/test/logic.test.js src/renderer/js/pages/seeds/test/page.test.js src/renderer/js/pages/compete/test/logic.test.js
```

Desglose: 22 de clanes/permiso (incluida paridad ES/EN), 14 de comunidades, 12 de semillas y 18 de Competir. Se usaron `VENUS_DATA_DIR` temporal y escalación autorizada por el error `spawn EPERM` del runner dentro del sandbox; `workdir` explícito y `login:false`. Los casos nuevos ejecutan el renderer con un DOM mínimo y backend ficticio, no un navegador. Node emitió el aviso preexistente `MODULE_TYPELESS_PACKAGE_JSON`; no se cambió `package.json`.

Paridad de claves y variables verificada por importación de los módulos: `seeds` **164**, `clans` **371**, `compete` **222**, iguales en ES/EN. Se agregaron 11 claves `clans.sharePlaytime*`; las demás son ajustes de textos existentes. No se editaron otros idiomas; su integración pertenece al parent.

No se corrió la suite global del parent, ni Electron, ni capturas nuevas, ni audio real, ni Realtime con dos cuentas, ni Minecraft. No se consultó ni mutó producción desde este frente; el parent informó migraciones aplicadas hasta 0027. El pase de pruebas del renderer no valida RLS, concurrencia de base ni despliegue coordinado. Las 489 comprobaciones SQL históricas de arriba no son evidencia del permiso nuevo.

#### Archivos de este frente

- Renderer: `src/renderer/js/pages/seeds.js`, `src/renderer/js/pages/clans.js`, `src/renderer/js/pages/communities/chat.js`, `src/renderer/js/pages/communities/view.js`, `src/renderer/js/pages/compete.js`, `src/renderer/js/pages/compete/rankings.js`, `src/renderer/js/features/clans/sharing.js`, `src/renderer/js/features/clans/fake.js`.
- Pruebas y arnés: `src/renderer/js/features/clans/test/renderer-harness.js`, `src/renderer/js/features/clans/test/page.test.js`, `src/renderer/js/features/clans/test/sharing.test.js`, `src/renderer/js/pages/communities/test/chat.test.js`, `src/renderer/js/pages/communities/test/view.test.js`, `src/renderer/js/pages/seeds/test/page.test.js`.
- Textos: `src/renderer/i18n/es/clans.js`, `src/renderer/i18n/en/clans.js`, `src/renderer/i18n/es/compete.js`, `src/renderer/i18n/en/compete.js`.
- Documentación: `docs/implementacion/semillas.md`, `docs/implementacion/clanes-comunidades.md`.

Verificación estática final: `node --check` pasó en los 18 archivos JS de este frente; `git diff --check` pasó y se comprobó CRLF sin saltos LF aislados en los 20 archivos listados. Los cambios previos de semillas no se revirtieron ni regeneraron. HEAD cambió externamente durante la sesión; este frente no hizo commits, checkout, reset, push ni release.

### Actualización posterior de integración

La integración principal completó los recorridos de páginas y rutas extra ES/EN con fixtures corregidos y consola vacía. El agente SQL aprobó **1282 comprobaciones locales**, incluidas las aserciones del permiso separado de horas, con Auth/Storage/Realtime mínimos y rollback verificado. El [informe SQL completo](revision-sql-0028-0036.md) conserva sus límites. No se probaron Realtime entre cuentas reales, concurrencia de producción ni salas con micrófono físico. Ver [evidencia general](../estado-4.5.0.md).

## Ampliación de la 4.6: roles, permisos por canal, GIFs con aprobación, bienvenida y despedida

Ampliación de `0038_comunidades.sql` (aplicada en producción el 5 de noviembre). Reemplaza al módulo de Clanes por `features/communities/`. El contrato anterior de la 0038 (categorías, canales de anuncios y foros, tema, modo lento, canales privados, apariencia, bienvenida y reglas como texto) sigue valiendo; esto cuenta solo lo que se suma o cambia. El sistema viejo de clanes y sus tablas se retiran con la 0048 (sin aplicar al escribirse esto): `admin_groups`, `admin_group_detail`, `admin_group_dissolve`, `admin_group_remove` y `community_report` quedan sin la rama `'clan'` y `group_reports_kind_check` en `('message', 'community', 'media')`.

### Qué hay de nuevo

| Pedido | Qué se hizo |
|---|---|
| Mensajes de **bienvenida y despedida** | Cada comunidad configura uno de cada tipo: activarlo, canal, texto con `{usuario}`, `{comunidad}` y `{miembros}`, GIF opcional y vista previa. Se publican solos al entrar y al salir. |
| GIFs de **KLIPY** | Se validan en el servidor con `private.klipy_url`, igual que los banners del perfil. Se pueden mandar al chat y usar en la bienvenida y la despedida. |
| GIFs **subidos con aprobación** | Bucket privado `community-media`, tabla `community_media` con estado `pending/approved/rejected/removed`, cola en Administración, denuncia de uno aprobado y estado visible para el dueño. **Nada se ve para otros mientras está pendiente.** |
| **Permisos por canal** | Roles propios por comunidad y, por canal, seis permisos: ver, escribir, enlaces y GIFs, reaccionar, entrar a voz y hablar. Se aplican en el servidor (RLS, Storage y RPC). Panel de edición y vista "qué puede hacer este rol aquí". |
| **Reacciones** | Hacía falta para que el permiso "reaccionar" significara algo: ocho reacciones fijas, hasta cinco por cuenta y mensaje. |
| **Mudanza** | `features/clans*`, `pages/clans*`, `pages/admin/clans.js`, `styles/pages/clans.css` y el namespace `clans` se borraron. Todo vive en `features/communities/`, `pages/communities/`, `pages/admin/communities.js`, `styles/pages/communities.css` y el namespace `communities`. |

### Cómo se usa

#### Dueño

Menú de la comunidad (los tres puntos junto al nombre):

- **Bienvenida y despedida:** dos pestañas. Cada una tiene un interruptor, el canal (de texto o de anuncios, no privado), el mensaje y el GIF. El GIF se elige de KLIPY, de la galería de la comunidad o se sube uno nuevo. Un archivo subido que todavía no aprobó Venus se puede elegir, pero el mensaje sale **sin** el GIF hasta que se apruebe. Abajo, la vista previa con un nombre de ejemplo.
- **Roles:** crear, renombrar, cambiar el color y borrar (hasta 15). No dan poderes de moderación.
- **GIFs de la comunidad:** subir, ver el estado de cada archivo (con el motivo si se rechazó) y borrar. Lo ven y lo usan también los moderadores, y los miembros solo ven lo aprobado.
- **Personalizar comunidad:** igual que antes. El campo que se llamaba "Bienvenida" ahora es "Texto de presentación" (el de *Bienvenida y reglas*), para no confundirlo con el mensaje automático.

Menú de cada canal: **Permisos del canal**. A la izquierda, a quién configurar (todos los miembros, cada rol propio, moderadores y dueño). A la derecha, los permisos que tienen sentido para ese tipo de canal. A los roles propios se les puede *permitir*, *denegar* o dejar en *heredar*; a "todos" se le prende o apaga cada uno. Debajo, **qué puede hacer aquí**: el resultado real con el motivo de cada permiso (lo concede el canal, lo permite o niega un rol, falta poder ver, etc.). Con cambios sin guardar es una vista previa; ya guardado, lo explica el servidor.

Lista de miembros: en el menú de un miembro común, **Roles…** (también para moderadores).

#### Moderadores

Asignan roles propios a miembros comunes, administran canales y categorías, suben GIFs y ven el estado de los suyos. No crean ni borran roles.

#### Miembros

Ven los canales que les tocan, escriben, mandan enlaces o GIFs, reaccionan, entran a voz y hablan **si el canal y sus roles lo permiten**. Los botones que no pueden usar aparecen apagados con la razón en el texto de ayuda. Pueden denunciar un GIF aprobado desde el mensaje o desde la galería.

#### Administración de Venus

Pestaña **Comunidades** de `#/admin`, con tres secciones:

1. **GIFs:** la cola. Filtros Pendiente / Aprobado / Rechazado / Retirado. Cada tarjeta muestra la vista previa (con la URL firmada de Storage, que solo entrega a administradores), la comunidad, quién lo subió, medidas, peso y denuncias abiertas. **Aprobar**, **Rechazar** (pide motivo de 3 a 200 caracteres) y **Retirar** (uno aprobado, también con motivo).
2. **Comunidades:** buscar, ver, quitar gente y disolver (como antes).
3. **Denuncias:** mensajes, comunidades y GIFs aprobados. Una denuncia de GIF muestra la imagen y ofrece **Retirar el GIF y cerrar**.

Todo lo que cambia algo queda en `admin_log`: `communityMedia.approve`, `communityMedia.reject`, `communityMedia.remove` y `groupReport.close` (con `details.kind = 'media'`).

### Permisos: cómo se resuelven

Seis permisos: `view`, `write`, `embeds` (enlaces y GIFs), `react`, `connect`, `speak`. Cada tipo de canal usa solo algunos: la voz tiene ver, entrar y hablar; todo lo demás, ver, escribir, enlaces y reaccionar.

1. **Dueño y moderadores** pueden todo en todos los canales (saltean las reglas). Es lo que mantiene a los canales de anuncios y a los privados bajo control del equipo.
2. Para el resto se parte de lo que concede el canal a todos. `is_private` es el "ver" y `posting_role` el "escribir" de todos, como antes; `perm_embeds`, `perm_react`, `perm_connect` y `perm_speak` (nuevos, en `community_channels`) son los otros cuatro.
3. Encima van las excepciones de los **roles propios** de la cuenta (`community_channel_perms`). Si un rol niega y otro permite, **gana permitir**.
4. Dependencias: sin *ver* no hay nada; *enlaces y GIFs* necesita *escribir*; *hablar* necesita *entrar*.

Una cuenta silenciada en la comunidad, con sanción global, baneada, expulsada o bloqueada por el dueño no tiene ningún permiso (`community_access`).

La función que decide es `private.community_perms_for(canal, cuenta)` (una sola pasada). La usan:

- la política RLS de `community_messages` (`private.community_message_visible`), así que **la tabla directa y Realtime** respetan "ver";
- `community_send`, `community_send_media`, los temas y respuestas de foro (`private.community_write_channel`): *escribir* y, si el texto lleva un enlace o es un GIF, *enlaces y GIFs*;
- `community_react`: *reaccionar* (quitar la propia siempre se puede);
- todo el acceso a voz (`private.community_voice_access`): *entrar* para `voice_join`, `voice_room_by_code`, el latido, las invitaciones, Recientes, las claves de sesión y la política de Realtime;
- `community_get`, que solo entrega los canales visibles y a cada uno le suma `can`, `canPost`, `canEmbed`, `canReact`, `canConnect` y `canSpeak`.

Los cambios de roles y de permisos revocan en el momento las admisiones de voz que ya no correspondan.

#### Hablar

En una sala P2P el servidor no puede cortar el audio de alguien, pero sí **no entregar su clave de sesión**: `voice_member_keys` (copia de la de 0014 con un filtro más) deja afuera a quien no puede hablar en una sala de comunidad. Los demás clientes no pueden verificar sus señales ni aceptar su audio, y esa persona escucha pero no la oyen (tampoco aparece en la lista de la sala). `community_voice_room` devuelve `canSpeak` y la pantalla avisa "entraste solo para escuchar". **No se probó con audio real ni con dos PC.** Hace falta que `js/voice.js` (agente H) tolere que otros no tengan su clave; no cambié nada en `js/voice*`.

Límite que viene con el respaldo de voz de la 0047 (agente H): mientras el servidor está caído, quien entra por el respaldo "se presenta solo" con su clave y los demás lo ven **sin verificar**. Sin servidor no hay quién aplique "hablar" (ni ningún otro permiso): la regla vale mientras el servidor responde. Además `voice_fallback_secret` entrega el secreto de la sala a cualquier miembro admitido, también a quien no puede hablar. Si el dueño necesita que "hablar" valga aun con el servidor caído, el respaldo tendría que dejar de aceptar claves presentadas en salas de comunidad.

#### Enlaces

La regla es heurística, no un analizador de URL: `https://`, `http://`, `www.`, `discord.gg/` y `discord.com/invite`. Es lo que el chat vuelve clicable (solo `http(s)`) más las invitaciones de Discord. Quien escriba "ejemplo punto com" no dispara la regla; tampoco el chat lo vuelve un enlace.

### GIFs subidos: el circuito

1. Dueño o moderador elige un archivo (GIF, WebP o PNG). La interfaz lee los primeros bytes y comprueba el **tipo real, el tamaño (hasta 2 MB) y las medidas (de 16 a 1024 píxeles por lado)**.
2. Lo sube a `community-media/<comunidad>/<id>.<ext>`. La política de inserción de Storage solo deja a dueño y moderadores de esa comunidad, con nombre de archivo exacto, sin sanciones y hasta 30 archivos por carpeta.
3. `community_media_register` lo anota: **el peso y el tipo salen de Storage, no del cliente**. Máximo 20 entre pendientes y aprobados por comunidad, 5 pendientes a la vez y 10 registros por día y cuenta. Si el registro falla, el cliente borra lo subido.
4. Nace `pending`. **Lo ven solo quien lo subió, el dueño y los administradores** (política de lectura de Storage `private.community_media_can_read`, la lista, el registro y los mensajes). El resto: ni en la lista, ni en `community_media_resolve`, ni por Storage, ni se puede mandar al chat (`bad_media`).
5. Un administrador lo aprueba o lo rechaza con motivo. Aprobado, lo ven los miembros de esa comunidad (el bucket sigue privado: la interfaz pide una URL firmada y la política decide).
6. Un miembro puede denunciarlo (`community_report('media')`). Un administrador lo cierra o lo **retira** (queda `removed`, deja de entregarse y los mensajes que lo usaban muestran "GIF no disponible").
7. Quien lo subió o el dueño lo borra (`community_media_delete` devuelve la ruta y el cliente borra el archivo).

Lo que **no** controla el servidor: que la imagen sea apta. Eso lo decide la revisión de un administrador. Las medidas las manda el cliente y el servidor solo valida el rango; si no coinciden con el archivo real, la vista previa que ve el administrador (limitada por CSS) muestra la verdad.

Al borrar una comunidad se borran sus registros, pero **los archivos quedan en el bucket**: borrar filas de `storage.objects` por SQL no borra el archivo de verdad. Hace falta una limpieza por la API de Storage (por ejemplo, desde la función de administración).

### Bienvenida y despedida: el circuito

- Configuración: `community_greeting_save(comunidad, 'join'|'leave', parche)`, solo el dueño. `parche` admite `enabled`, `channelId`, `body` y `media`. Errores: `bad_greeting_channel`, `bad_greeting_text`, `bad_greeting_variable`, `bad_media`, `greeting_needs_channel`, `greeting_empty`.
- Variables: `{usuario}`, `{comunidad}`, `{miembros}`, y también `{user}`, `{community}`, `{members}`. Cualquier otra `{palabra}` se rechaza. Los nombres se insertan sin llaves ni barras. Misma regla en `features/communities/greeting.js` (`renderGreeting`) para la vista previa; los dos tienen el mismo vector de prueba.
- Al entrar (`private.community_add_member`) o salir por su cuenta (`community_leave`) el servidor arma el texto con los datos del momento y publica un mensaje de sistema (`community_messages.system = 'join' | 'leave'`) en el canal elegido. **Expulsar, banear o borrar la cuenta no publican despedida.** Una misma cuenta no repite el mismo aviso antes de 10 minutos.
- No publica si el canal se borró (la configuración queda con `channelId` vacío), si se volvió privado, si es de voz o de foro, o si no hay texto ni GIF.
- El mensaje se dibuja centrado y sin nombre. Solo el equipo puede borrarlo. Respeta bloqueos: quien bloqueaste no aparece en las bienvenidas que ves.

### Archivos

**Migración y pruebas SQL**

- `supabase/migrations/0038_comunidades.sql` (ampliada).
- `supabase/tests/communities-local.sql`: 929 comprobaciones (el contrato original, más roles, permisos, reacciones, GIFs, cola, bienvenida y despedida). `scripts/run-communities-local.ps1` sin cambios.

**Interfaz** (`src/renderer/js/`)

- `features/communities/`: `backend.js`, `logic.js`, `report.js`, `fake.js`, `permissions.js`, `greeting.js`, `media.js`, `test/renderer-harness.js`.
- `pages/communities.js` y `pages/communities/`: `view.js`, `chat.js`, `forum.js`, `manage.js`, `forms.js`, `logic.js`, y los nuevos `greetings.js`, `roles.js`, `perms.js`, `gallery.js`, `media-view.js`.
- `pages/admin/communities.js` (reemplaza a `pages/admin/clans.js`). Cambio puntual en `pages/admin.js`: la importación de la pestaña.
- `styles/pages/communities.css`.
- `i18n/{es,en}/communities.js` y `i18n/<idioma>/communities.js` en los otros doce (solo con las claves conservadas).
- Cambio puntual en `features/retired/test/integration.test.js` (ruta del arnés y de la pestaña de Administración).

### RPC nuevas

| RPC | Quién | Para qué |
|---|---|---|
| `community_role_save(comunidad, nombre, color?, rol?)`, `community_role_delete(rol)` | dueño | Roles propios (hasta 15) |
| `community_role_assign(comunidad, usuario, rol, activar?)` | dueño y moderadores | A miembros comunes, hasta 5 por cuenta |
| `community_channel_perms_get(canal)`, `community_channel_perms_set(canal, rol|null, permisos)`, `community_perms_explain(canal, sujeto)` | dueño y moderadores | Leer, cambiar (todo o nada) y explicar permisos. `sujeto`: `everyone`, `moderator`, `owner` o el id de un rol |
| `community_react(mensaje, emoji, activar?)` | miembros | Reacciones: `like`, `love`, `laugh`, `wow`, `sad`, `party`, `fire`, `eyes` |
| `community_send_media(canal, media, texto?)` | miembros con el permiso | GIF de KLIPY o subido y aprobado, con un texto de hasta 500 |
| `community_media_register`, `community_media_list`, `community_media_resolve`, `community_media_delete` | equipo / miembros | Galería de la comunidad |
| `community_greeting_save` | dueño | Bienvenida y despedida |
| `admin_community_media_queue(estado?, límite?, desde?)`, `admin_community_media_review(id, 'approve'|'reject'|'remove', motivo?)` | administradores | Cola de GIFs |

Cambios en lo que ya existía: `community_get` suma `roles`, `myRoleIds`, `maxRoles`, `greetings` (solo el dueño) y filtra los canales por permiso; cada canal suma `can`, `canEmbed`, `canReact`, `canConnect`, `canSpeak`; `community_members_list` suma `roleIds`; los mensajes suman `system`, `media` y `reactions`; `community_report` acepta `'media'`; `admin_group_report_close` retira el GIF denunciado; `community_voice_room` responde `canSpeak` y rechaza con `voice_forbidden`.

Errores nuevos (`communities.err_<código>` en la interfaz): `embeds_forbidden`, `react_forbidden`, `voice_forbidden`, `bad_emoji`, `too_many_reactions`, `bad_media`, `bad_media_name`, `bad_dimensions`, `no_file`, `bad_type`, `too_big`, `media_limit`, `media_pending_limit`, `bad_id`, `bad_greeting_*`, `greeting_needs_channel`, `greeting_empty`, `bad_role_name`, `role_name_taken`, `too_many_roles`, `too_many_member_roles`, `bad_permission`, `bad_decision`, `bad_state` y `reason_required`.

### Límites y decisiones

- Cada cuenta puede tener hasta 5 roles propios; cada comunidad, 15, 50 canales, 20 categorías y 20 GIFs (pendientes y aprobados).
- Un rol propio no se asigna a dueño ni a moderadores (no cambiaría nada). Si un miembro con roles sube a moderador y vuelve a miembro, recupera los suyos.
- Los permisos de "todos" se guardan en el canal; los de los roles en `community_channel_perms`. Cambiar `is_private` o `posting_role` con `community_channel_configure` sigue funcionando y es lo mismo que "ver" y "escribir" de todos.
- Las reacciones no viajan por Realtime: se refrescan con la consulta periódica del chat (cada 30 segundos, ahora también con la conexión en vivo) y con la propia acción.
- Un GIF subido llega por Realtime sin su ruta (solo el id): el chat vuelve a pedir la página para tenerla.
- Sin conexiones nuevas en segundo plano: los GIFs se piden solo al abrir un canal que los tiene (KLIPY como en Mensajes, y URLs firmadas de la nube de Venus).
- Los textos de los otros 12 idiomas **no existen** para las claves nuevas: caen al inglés. Se conservaron las traducciones que ya había para las claves que no cambiaron.

### Pruebas

- SQL: `communities-local.sql` en PostgreSQL 17.11, con las migraciones 0001 a 0037 completas y la 0038 dentro de `BEGIN/ROLLBACK`. Roles, permisos por canal y salto del equipo, intentos de saltearlos por la tabla directa (INSERT, UPDATE, SELECT de las tablas nuevas y de mensajes) y por la RPC, voz (entrar, hablar, revocación, claves), reacciones, GIFs pendientes que no ve nadie más (lista, Storage, resolve, envío), cola de administración con `admin_log`, denuncias, bienvenida y despedida (al entrar, al salir, repetidos, expulsados, baneados, bloqueados, canal borrado o privado) y KLIPY.
- Interfaz: `node --test "src/renderer/js/pages/communities/test/*.test.js"`: 70 pruebas (las 36 que ya había, adaptadas, y las nuevas de permisos, bienvenida, GIFs, datos de ejemplo y RPC de ejemplo).
- Capturas con `VENUS_DEVSHOT` y `VENUS_REWARDS_FAKE=demo`, en español e inglés, `console.log` vacío: lista, comunidad, canal con aviso de bienvenida, GIF y reacciones, bienvenida y despedida, roles, roles de un miembro, permisos del canal (todos y un rol), galería, cola de Administración y denuncias.
