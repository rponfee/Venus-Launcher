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
