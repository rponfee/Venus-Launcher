# Comunidades 4.6

> Agente F. Amplía `supabase/migrations/0038_comunidades.sql` **en su lugar** (nunca se aplicó) y reemplaza al módulo de Clanes por `features/communities/`. El contrato anterior de la 0038 (categorías, canales de anuncios y foros, tema, modo lento, canales privados, apariencia, bienvenida y reglas como texto) sigue valiendo y está en [`docs/implementacion/clanes-comunidades.md`](../implementacion/clanes-comunidades.md). Este documento cuenta solo lo que se suma o cambia.

## Qué hay de nuevo

| Pedido | Qué se hizo |
|---|---|
| Mensajes de **bienvenida y despedida** | Cada comunidad configura uno de cada tipo: activarlo, canal, texto con `{usuario}`, `{comunidad}` y `{miembros}`, GIF opcional y vista previa. Se publican solos al entrar y al salir. |
| GIFs de **KLIPY** | Se validan en el servidor con `private.klipy_url`, igual que los banners del perfil. Se pueden mandar al chat y usar en la bienvenida y la despedida. |
| GIFs **subidos con aprobación** | Bucket privado `community-media`, tabla `community_media` con estado `pending/approved/rejected/removed`, cola en Administración, denuncia de uno aprobado y estado visible para el dueño. **Nada se ve para otros mientras está pendiente.** |
| **Permisos por canal** | Roles propios por comunidad y, por canal, seis permisos: ver, escribir, enlaces y GIFs, reaccionar, entrar a voz y hablar. Se aplican en el servidor (RLS, Storage y RPC). Panel de edición y vista "qué puede hacer este rol aquí". |
| **Reacciones** | Hacía falta para que el permiso "reaccionar" significara algo: ocho reacciones fijas, hasta cinco por cuenta y mensaje. |
| **Mudanza** | `features/clans*`, `pages/clans*`, `pages/admin/clans.js`, `styles/pages/clans.css` y el namespace `clans` se borraron. Todo vive en `features/communities/`, `pages/communities/`, `pages/admin/communities.js`, `styles/pages/communities.css` y el namespace `communities`. |

## Cómo se usa

### Dueño

Menú de la comunidad (los tres puntos junto al nombre):

- **Bienvenida y despedida:** dos pestañas. Cada una tiene un interruptor, el canal (de texto o de anuncios, no privado), el mensaje y el GIF. El GIF se elige de KLIPY, de la galería de la comunidad o se sube uno nuevo. Un archivo subido que todavía no aprobó Venus se puede elegir, pero el mensaje sale **sin** el GIF hasta que se apruebe. Abajo, la vista previa con un nombre de ejemplo.
- **Roles:** crear, renombrar, cambiar el color y borrar (hasta 15). No dan poderes de moderación.
- **GIFs de la comunidad:** subir, ver el estado de cada archivo (con el motivo si se rechazó) y borrar. Lo ven y lo usan también los moderadores, y los miembros solo ven lo aprobado.
- **Personalizar comunidad:** igual que antes. El campo que se llamaba "Bienvenida" ahora es "Texto de presentación" (el de *Bienvenida y reglas*), para no confundirlo con el mensaje automático.

Menú de cada canal: **Permisos del canal**. A la izquierda, a quién configurar (todos los miembros, cada rol propio, moderadores y dueño). A la derecha, los permisos que tienen sentido para ese tipo de canal. A los roles propios se les puede *permitir*, *denegar* o dejar en *heredar*; a "todos" se le prende o apaga cada uno. Debajo, **qué puede hacer aquí**: el resultado real con el motivo de cada permiso (lo concede el canal, lo permite o niega un rol, falta poder ver, etc.). Con cambios sin guardar es una vista previa; ya guardado, lo explica el servidor.

Lista de miembros: en el menú de un miembro común, **Roles…** (también para moderadores).

### Moderadores

Asignan roles propios a miembros comunes, administran canales y categorías, suben GIFs y ven el estado de los suyos. No crean ni borran roles.

### Miembros

Ven los canales que les tocan, escriben, mandan enlaces o GIFs, reaccionan, entran a voz y hablan **si el canal y sus roles lo permiten**. Los botones que no pueden usar aparecen apagados con la razón en el texto de ayuda. Pueden denunciar un GIF aprobado desde el mensaje o desde la galería.

### Administración de Venus

Pestaña **Comunidades** de `#/admin`, con tres secciones:

1. **GIFs:** la cola. Filtros Pendiente / Aprobado / Rechazado / Retirado. Cada tarjeta muestra la vista previa (con la URL firmada de Storage, que solo entrega a administradores), la comunidad, quién lo subió, medidas, peso y denuncias abiertas. **Aprobar**, **Rechazar** (pide motivo de 3 a 200 caracteres) y **Retirar** (uno aprobado, también con motivo).
2. **Comunidades:** buscar, ver, quitar gente y disolver (como antes).
3. **Denuncias:** mensajes, comunidades y GIFs aprobados. Una denuncia de GIF muestra la imagen y ofrece **Retirar el GIF y cerrar**.

Todo lo que cambia algo queda en `admin_log`: `communityMedia.approve`, `communityMedia.reject`, `communityMedia.remove` y `groupReport.close` (con `details.kind = 'media'`).

## Permisos: cómo se resuelven

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

### Hablar

En una sala P2P el servidor no puede cortar el audio de alguien, pero sí **no entregar su clave de sesión**: `voice_member_keys` (copia de la de 0014 con un filtro más) deja afuera a quien no puede hablar en una sala de comunidad. Los demás clientes no pueden verificar sus señales ni aceptar su audio, y esa persona escucha pero no la oyen (tampoco aparece en la lista de la sala). `community_voice_room` devuelve `canSpeak` y la pantalla avisa "entraste solo para escuchar". **No se probó con audio real ni con dos PC.** Hace falta que `js/voice.js` (agente H) tolere que otros no tengan su clave; no cambié nada en `js/voice*`.

Límite que viene con el respaldo de voz de la 0047 (agente H): mientras el servidor está caído, quien entra por el respaldo "se presenta solo" con su clave y los demás lo ven **sin verificar**. Sin servidor no hay quién aplique "hablar" (ni ningún otro permiso): la regla vale mientras el servidor responde. Además `voice_fallback_secret` entrega el secreto de la sala a cualquier miembro admitido, también a quien no puede hablar. Si el dueño necesita que "hablar" valga aun con el servidor caído, el respaldo tendría que dejar de aceptar claves presentadas en salas de comunidad.

### Enlaces

La regla es heurística, no un analizador de URL: `https://`, `http://`, `www.`, `discord.gg/` y `discord.com/invite`. Es lo que el chat vuelve clicable (solo `http(s)`) más las invitaciones de Discord. Quien escriba "ejemplo punto com" no dispara la regla; tampoco el chat lo vuelve un enlace.

## GIFs subidos: el circuito

1. Dueño o moderador elige un archivo (GIF, WebP o PNG). La interfaz lee los primeros bytes y comprueba el **tipo real, el tamaño (hasta 2 MB) y las medidas (de 16 a 1024 píxeles por lado)**.
2. Lo sube a `community-media/<comunidad>/<id>.<ext>`. La política de inserción de Storage solo deja a dueño y moderadores de esa comunidad, con nombre de archivo exacto, sin sanciones y hasta 30 archivos por carpeta.
3. `community_media_register` lo anota: **el peso y el tipo salen de Storage, no del cliente**. Máximo 20 entre pendientes y aprobados por comunidad, 5 pendientes a la vez y 10 registros por día y cuenta. Si el registro falla, el cliente borra lo subido.
4. Nace `pending`. **Lo ven solo quien lo subió, el dueño y los administradores** (política de lectura de Storage `private.community_media_can_read`, la lista, el registro y los mensajes). El resto: ni en la lista, ni en `community_media_resolve`, ni por Storage, ni se puede mandar al chat (`bad_media`).
5. Un administrador lo aprueba o lo rechaza con motivo. Aprobado, lo ven los miembros de esa comunidad (el bucket sigue privado: la interfaz pide una URL firmada y la política decide).
6. Un miembro puede denunciarlo (`community_report('media')`). Un administrador lo cierra o lo **retira** (queda `removed`, deja de entregarse y los mensajes que lo usaban muestran "GIF no disponible").
7. Quien lo subió o el dueño lo borra (`community_media_delete` devuelve la ruta y el cliente borra el archivo).

Lo que **no** controla el servidor: que la imagen sea apta. Eso lo decide la revisión de un administrador. Las medidas las manda el cliente y el servidor solo valida el rango; si no coinciden con el archivo real, la vista previa que ve el administrador (limitada por CSS) muestra la verdad.

Al borrar una comunidad se borran sus registros, pero **los archivos quedan en el bucket**: borrar filas de `storage.objects` por SQL no borra el archivo de verdad. Hace falta una limpieza por la API de Storage (por ejemplo, desde la función de administración).

## Bienvenida y despedida: el circuito

- Configuración: `community_greeting_save(comunidad, 'join'|'leave', parche)`, solo el dueño. `parche` admite `enabled`, `channelId`, `body` y `media`. Errores: `bad_greeting_channel`, `bad_greeting_text`, `bad_greeting_variable`, `bad_media`, `greeting_needs_channel`, `greeting_empty`.
- Variables: `{usuario}`, `{comunidad}`, `{miembros}`, y también `{user}`, `{community}`, `{members}`. Cualquier otra `{palabra}` se rechaza. Los nombres se insertan sin llaves ni barras. Misma regla en `features/communities/greeting.js` (`renderGreeting`) para la vista previa; los dos tienen el mismo vector de prueba.
- Al entrar (`private.community_add_member`) o salir por su cuenta (`community_leave`) el servidor arma el texto con los datos del momento y publica un mensaje de sistema (`community_messages.system = 'join' | 'leave'`) en el canal elegido. **Expulsar, banear o borrar la cuenta no publican despedida.** Una misma cuenta no repite el mismo aviso antes de 10 minutos.
- No publica si el canal se borró (la configuración queda con `channelId` vacío), si se volvió privado, si es de voz o de foro, o si no hay texto ni GIF.
- El mensaje se dibuja centrado y sin nombre. Solo el equipo puede borrarlo. Respeta bloqueos: quien bloqueaste no aparece en las bienvenidas que ves.

## Archivos

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

## RPC nuevas

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

## Límites y decisiones

- Cada cuenta puede tener hasta 5 roles propios; cada comunidad, 15, 50 canales, 20 categorías y 20 GIFs (pendientes y aprobados).
- Un rol propio no se asigna a dueño ni a moderadores (no cambiaría nada). Si un miembro con roles sube a moderador y vuelve a miembro, recupera los suyos.
- Los permisos de "todos" se guardan en el canal; los de los roles en `community_channel_perms`. Cambiar `is_private` o `posting_role` con `community_channel_configure` sigue funcionando y es lo mismo que "ver" y "escribir" de todos.
- Las reacciones no viajan por Realtime: se refrescan con la consulta periódica del chat (cada 30 segundos, ahora también con la conexión en vivo) y con la propia acción.
- Un GIF subido llega por Realtime sin su ruta (solo el id): el chat vuelve a pedir la página para tenerla.
- Sin conexiones nuevas en segundo plano: los GIFs se piden solo al abrir un canal que los tiene (KLIPY como en Mensajes, y URLs firmadas de la nube de Venus).
- Los textos de los otros 12 idiomas **no existen** para las claves nuevas: caen al inglés. Se conservaron las traducciones que ya había para las claves que no cambiaron.

## Pruebas

- SQL: `communities-local.sql` en PostgreSQL 17.11, con las migraciones 0001 a 0037 completas y la 0038 dentro de `BEGIN/ROLLBACK`. Roles, permisos por canal y salto del equipo, intentos de saltearlos por la tabla directa (INSERT, UPDATE, SELECT de las tablas nuevas y de mensajes) y por la RPC, voz (entrar, hablar, revocación, claves), reacciones, GIFs pendientes que no ve nadie más (lista, Storage, resolve, envío), cola de administración con `admin_log`, denuncias, bienvenida y despedida (al entrar, al salir, repetidos, expulsados, baneados, bloqueados, canal borrado o privado) y KLIPY.
- Interfaz: `node --test "src/renderer/js/pages/communities/test/*.test.js"`: 70 pruebas (las 36 que ya había, adaptadas, y las nuevas de permisos, bienvenida, GIFs, datos de ejemplo y RPC de ejemplo).
- Capturas con `VENUS_DEVSHOT` y `VENUS_REWARDS_FAKE=demo`, en español e inglés, `console.log` vacío: lista, comunidad, canal con aviso de bienvenida, GIF y reacciones, bienvenida y despedida, roles, roles de un miembro, permisos del canal (todos y un rol), galería, cola de Administración y denuncias.
