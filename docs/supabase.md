# Conectar Venus Launcher con Supabase

Las funciones en línea usan un proyecto de [Supabase](https://supabase.com): la cuenta de Venus, amigos y mensajes privados, Voice Chat, modpacks compartidos por código, la nube de mundos, las capturas y clips compartidos, los servidores destacados y el backend de la IA. El proyecto va fijo dentro del launcher (`src/main/core/cloud-defaults.js`): los usuarios no configuran nada, solo inician sesión en **Ajustes → Cuenta y nube**. Si el servicio no responde, esas secciones muestran "El servicio no está disponible en este momento" y el detalle técnico queda en la consola.

Pasos, en orden: crear el proyecto (1), aplicar las migraciones (2), configurar la autenticación y los emails (3), revisar Realtime y Storage (4), conectar el launcher (5) y, si vas a usar la IA con la cuenta de Venus, desplegar el backend (6). La sección 7 explica cómo editar los servidores destacados.

## 1. Crear el proyecto

1. Entrá a https://supabase.com/dashboard y creá un proyecto nuevo (por ejemplo `venus-launcher`).
2. En **Project Settings → API** (o **API Keys**) copiá:
   - **Project URL** (`https://xxxx.supabase.co`)
   - **anon public key** (o la **publishable key**, `sb_publishable_...`)

La anon key es pública por diseño: lo que protege los datos son las políticas RLS de las migraciones. **Nunca** pongas la `service_role` (o una *secret key*) en el launcher: todo lo que va en `cloud-defaults.js` o `app-config.js` se puede extraer del instalador.

## 2. Aplicar las migraciones

Aplicá **en orden** todos los archivos de `supabase/migrations/`:

- Desde el panel: **SQL Editor → New query**, pegá cada archivo y ejecutalo (0001, 0002, ... hasta la última).
- O con la [Supabase CLI](https://supabase.com/docs/guides/cli): `supabase login`, `supabase link --project-ref <ref>` (si te pide inicializar la carpeta, `supabase init` primero) y después `supabase db push`.

Las migraciones se pueden volver a ejecutar **solo todas juntas y en orden**, de 0001 a la última: usan `if not exists`, recrean las políticas y no pisan datos cargados. **Nunca vuelvas a aplicar una sola**: las más nuevas reemplazan funciones y políticas de las anteriores (por ejemplo, 0012 y 0014 cambian funciones de 0002, y 0008 las de 0007), y reaplicar una vieja sola las deja en su versión vieja sin ningún error (por ejemplo, 0002 sola apaga los silencios y baneos del panel). Para corregir una función, agregá una migración nueva. Todas activan **RLS** en sus tablas, y las escrituras sensibles van por funciones `security definer`.

| Migración | Módulo | Qué crea | Necesita |
|---|---|---|---|
| `0001_base.sql` | núcleo | Tabla `profiles` (perfil público: `username` único, `display_name`, `friend_code` `VENUS-XXXXXX`, `mc_name`, `mc_uuid`, `bio`, `banner`, `badges`, `status`, `status_text`, `last_seen`). Todos los usuarios con sesión pueden leer los perfiles; cada uno edita solo el suyo, y nunca `friend_code` ni `badges` (los maneja el servidor). Función `venus_friend_code()` y trigger `on_auth_user_created` (`handle_new_user()`), que crea el perfil al registrarse con el nombre elegido o uno libre parecido. | — |
| `0002_social.sql` | Amigos y mensajes | Tablas `friendships`, `user_activity`, `conversations`, `conversation_members`, `messages` y `message_reactions`. Funciones `are_friends` y `social_*` (`social_send_friend_request`, `social_respond_friend_request`, `social_remove_friend`, `social_block_user`, `social_unblock_user`, `social_get_or_create_conversation`, `social_mark_read`, `social_conversations`, `social_heartbeat`, `social_send_signal`). Límite de 40 mensajes por minuto por usuario. Realtime (abajo). | 0001 |
| `0003_voice.sql` | Voice Chat | Extensión `pgcrypto` (esquema `extensions`), tablas `voice_rooms` (código de 6 caracteres, contraseña opcional con hash del lado del servidor, cupo, privada o para amigos), `voice_members` (admisión, bloqueos, clave pública de la sesión) y `voice_throttle` (límite de intentos). Funciones `voice_create_room`, `voice_room_by_code`, `voice_join`, `voice_heartbeat`, `voice_leave`, `voice_member_keys`, `voice_invite`, `voice_kick`, `voice_set_password`, `voice_list_rooms`. Políticas de Realtime del canal privado `voice:<código>`. | 0001 (con 0002, el lobby muestra las salas de los amigos) |
| `0004_share.sql` | Compartir y nube | Extensión `pgcrypto`, tablas `shared_packs` (modpacks por código `PACK-XXXXXX` y grupos), `shared_pack_members`, `cloud_saves` (metadatos de las copias de mundos y configuraciones) y `share_throttle` (límite contra la adivinación de códigos). Funciones `create_shared_pack`, `get_shared_pack`, `join_shared_pack`, `publish_revision`, `mark_pack_synced` y `cloud_saves_quota_ok` (cuota de **2 GB** por usuario). Bucket privado `world-saves` (abajo). | 0001 |
| `0005_media.sql` | Mundos (capturas y clips) | Tabla `shared_media` (una fila por archivo compartido, solo la ve y la cambia su dueño). Buckets privados `screenshots` y `clips` (abajo), función `venus_media_count` y límite de 500 capturas y 100 clips por usuario. Se comparte con links firmados que duran un año (el launcher los renueva). | — |
| `0006_featured.sql` | Multijugador | Tabla `featured_servers` (servidores destacados) con lectura de las filas activas para todos y sin escrituras desde el cliente, trigger de `updated_at` y la carga inicial de 14 servidores (sección 7). | — |
| `0007_ai.sql` | Backend de la IA (base) | Tablas `ai_plans`, `ai_subscriptions` (plan de cada usuario), `ai_usage_daily` (sin uso desde 0008), `ai_turns` y `ai_rate`. Funciones de cuota de la primera versión (0008 las reemplaza) y `ai_my_quota` (lectura de la cuota propia). Ver sección 6. | — |
| `0008_ai_plans.sql` | Backend de la IA (planes reales) | Tablas `ai_models` (modelos de Claude y precios de lista), `ai_plan_models` (modelos de cada plan con sus esfuerzos y preguntas por día y por semana) y `ai_usage_model_daily` (uso y costo por día y por modelo); precio y presupuesto mensual en `ai_plans`; la tabla de planes `go`, `pro`, `super`, `ultra`, `max` y `supreme` (desactiva `free` y `plus`). Funciones `ai_effective_plan`, `ai_quota_status`, `ai_catalog`, `ai_register_turn`, `ai_release_turn` y `ai_add_usage` (solo la service role) y `ai_my_quota`. Zona horaria de las cuotas: Buenos Aires. Ver sección 6. | 0007 |
| `0009_billing.sql` | Pagos con Stripe | Tablas `stripe_customers` (cliente de Stripe de cada usuario, por modo), `stripe_events` (eventos recibidos, para no procesar dos veces el mismo) y `ai_plan_prices` (precio de Stripe de cada plan, por modo; la carga `scripts/stripe-setup.js`); columnas de Stripe en `ai_subscriptions` (suscripción, estado, fin del período, gracia). Funciones `billing_state`, `billing_my_state`, `billing_catalog`, `billing_prices`, `billing_price_map`, `billing_user_for_customer`, `billing_link_customer`, `billing_begin_event`, `billing_finish_event`, `billing_apply_subscription` y `billing_upsert_price`. Ver [pagos.md](pagos.md). | 0008 |
| `0010_hardening.sql` | Ajustes de los advisors | Saca el permiso de ejecutar `handle_new_user()` por la API, reescribe las políticas de `profiles` y `shared_media` con `(select auth.uid())` (se evalúa una vez por consulta) y agrega índices a las claves foráneas `message_reactions.user_id` y `voice_members.invited_by`. | 0001, 0002, 0003 y 0005 |
| `0011_ai_providers.sql` | Backend de la IA (respaldo en OpenAI) | Columna `provider` en `ai_models` y los precios de los modelos de OpenAI (filas de solo precio, nunca en los planes); tablas `ai_tier_fallbacks` (el modelo de OpenAI de cada modelo de Venus y la traducción del esfuerzo) y `ai_provider_config` (proveedor principal y secundario, si el respaldo está activo y qué fallas lo activan), las dos solo para la service role; función `ai_provider_settings` y la versión nueva de `ai_add_usage` (el costo de OpenAI queda en la fila de su modelo). Ver sección 6. | 0008 |
| `0012_admin.sql` | Panel de administración | Tablas `app_admin_emails` (emails con acceso al panel; carga el del dueño), `app_admins` (la llenan triggers sobre `auth.users` y `app_admin_emails`: solo cuentas con el email confirmado), `admin_actions` (registro de lo que hacen los admins: solo se agrega y lo leen los admins) y `user_moderation` (baneos, silencios y notas internas, solo la service role). Funciones `is_admin`, `admin_guard` y `my_moderation`, las lecturas del panel (`admin_overview`, `admin_list_users`, `admin_user_detail`, `admin_plans`, `admin_list_actions`) y las escrituras que usa la Edge Function `admin` con la service role. Reemplaza con las mismas firmas `social_can_send`, `social_send_friend_request`, `social_send_signal` y `social_messages_before` para que una cuenta silenciada o baneada no pueda escribir. Ver [admin.md](admin.md). | 0001, 0002, 0007, 0008, 0009 y 0011 |
| `0014_security.sql` | Seguridad de la base | Esquema `private` (fuera de la API): ahí pasan las funciones que usan las políticas (`are_friends`, `social_is_member`, `social_can_send`, `moderation_self_block`, `voice_friend_array`, `voice_is_owner`, `voice_is_member`, `voice_can_use_topic`, `share_is_owner`, `share_is_member`) y se borran `cloud_saves_quota_ok` y `venus_media_count`. Trigger `venus_storage_quota` sobre `storage.objects`: las cuotas de Storage en cada escritura (sección 4). Sin la política de UPDATE de `screenshots` y `clips`. Topes de 1000 filas en `cloud_saves` y 600 en `shared_media` por usuario. Voice Chat: el canal es solo de quien está en la sala, `voice_leave` borra la sesión, se invita solo a amigos y quien bloqueó el dueño no ve ni entra a sus salas. Editar un mensaje exige seguir siendo amigos y las señales tienen un límite de 120 por minuto (`private.social_throttle`). Admins: sin los triggers que daban admin por el email (ver [admin.md](admin.md)). `venus_friend_code` ya no se puede llamar por la API. | 0001 a 0005 y 0012 |

En el proyecto de Venus (`dzchklzaxyygbvfpagvx`), cada migración quedó registrada con su versión (fecha y hora UTC) y un nombre `venus_<número>_<nombre>`, distinto del nombre del archivo. Por ejemplo, `0011_ai_providers.sql` es `20261028003925_venus_0011_ai_providers`, `0012_admin.sql` es `20261028004214_venus_0012_admin` y `0014_security.sql` es `20261028024946_venus_0014_security`.

## 3. Autenticación y emails

En **Authentication → Providers → Email** (o **Sign In / Providers**):

- **Opción simple**: desactivá **Confirm email** y las cuentas quedan activas al registrarse. Ojo: así un email "confirmado" no prueba que sea de esa persona (cualquiera se registra con cualquier email), así que **no habilites el panel de administración** con esta opción ([admin.md](admin.md), sección 5).
- **Opción con confirmación** (recomendada; con `AI_REQUIRE_CONFIRMED_EMAIL`, la IA de la sección 6 la exige): dejala activada.

Los links de los emails no pueden volver a una app de escritorio, así que el launcher trabaja con **códigos**. En **Authentication → Email Templates** agregá `{{ .Token }}` al mensaje de **las dos** plantillas:

- **Confirm signup**: el código que el launcher pide después de crear la cuenta (en la bienvenida y en Ajustes → Cuenta y nube).
- **Reset Password**: el código para **¿Olvidaste tu contraseña?** en Ajustes → Cuenta y nube. Sin `{{ .Token }}`, el email llega con un link que no sirve dentro del launcher.

El campo del launcher acepta códigos de 6 a 10 dígitos (Supabase manda 6 por defecto).

## 4. Realtime y Storage

### Realtime

- **0002** agrega `friendships`, `user_activity`, `conversation_members`, `messages` y `message_reactions` a la publicación `supabase_realtime` (Postgres Changes respeta la RLS de cada tabla).
- **0002** crea la política `"venus_inbox_receive_own"` sobre `realtime.messages`: cada usuario solo puede escuchar su buzón privado `inbox:<su id>`. Nadie puede mandar por ese canal desde el cliente: las señales (invitaciones a voz y a modpacks, "unite a mi mundo", "escribiendo...") entran solo por la función `social_send_signal`, que usa **Broadcast from Database** (`realtime.send`), pone el remitente del lado del servidor y deja mandar hasta 120 por minuto (0014).
- **0003** crea las políticas `voice_room_receive` y `voice_room_send` sobre `realtime.messages` para el canal privado `voice:<código>` (señalización WebRTC, presencia, chat y moderación). Desde **0014** solo entran el dueño y quien está en la sala ahora (entró con `voice_join` y sigue con el latido de 30 s, sin bloqueo en la sala ni del dueño en social): una admisión vieja ya no alcanza para escuchar el canal.
- El proyecto necesita **Realtime Authorization** (canales privados) y `realtime.send`, como trae Supabase hospedado. El launcher se une a esos canales como privados, así que no hace falta cambiar los ajustes de acceso público de Realtime. En un Supabase propio viejo sin `realtime.send`, las señales y el "escribiendo..." se desactivan solos y el resto sigue andando.
- El latido de presencia (cada 60 s) genera un evento de Realtime por minuto para cada amigo conectado: cuenta para la cuota de mensajes de Realtime de tu plan.

### Storage

Los buckets se crean desde las migraciones, todos **privados** y con rutas `<userId>/...` (cada usuario solo lee y escribe en su carpeta):

| Bucket | Migración | Límite por archivo | Tipos | Para qué |
|---|---|---|---|---|
| `world-saves` | 0004 | 50 MB | `application/octet-stream`, `application/zip` | Nube de mundos y configuraciones. Cada mundo se comprime y se sube en **partes de 45 MB** (`<userId>/<instancia>/<mundo>/<subida>/part-NNN`). Cuota de 2 GB por usuario. |
| `screenshots` | 0005 | 15 MB | PNG, JPEG, WebP | Capturas compartidas (hasta 500 por usuario). |
| `clips` | 0005 | 50 MB | MP4, WebM, MKV, MOV | Clips compartidos (hasta 100 por usuario). |

**Límite de tamaño del proyecto:** en la configuración de Storage del proyecto (**Storage → Settings** o **Project Settings → Storage**), el límite global por archivo (*Upload file size limit*) tiene que ser de **50 MB o más**: si es menor, Supabase rechaza las partes de 45 MB de la nube de mundos y los clips grandes. En el plan gratuito, 50 MB es el máximo por archivo; por eso el launcher parte los mundos. Revisá también el espacio total que incluye tu plan.

**Cuotas (0014):** las controla el trigger `venus_storage_quota` en **cada** escritura de `storage.objects` (subir, pisar, copiar o mover), también cuando Storage guarda como service role una subida con URL firmada, y de a una por usuario, así que las subidas en paralelo no pasan juntas. Al firmar o probar el permiso el tamaño todavía no se conoce; el real se controla al guardar el archivo (si no entra, Storage borra lo subido y el launcher ve "cuota llena"). Las políticas solo controlan la carpeta. Los archivos de `screenshots` y `clips` no se pueden mover ni pisar (no tienen política de UPDATE; el launcher nunca lo necesita). Para cambiar la cuota de 2 GB o los 500 y 100 archivos, editá `private.storage_quota_before()` en una migración nueva.

## 5. Conectar el launcher

Completá `url` y `anonKey` en `src/main/core/cloud-defaults.js` antes de compilar: todas las copias de ese build usan ese proyecto. No hay forma de cambiarlo desde la interfaz, y un proyecto guardado en los ajustes por versiones anteriores (`settings.cloud`) se ignora.

Para desarrollo (solo con el launcher sin empaquetar) se puede apuntar a otro proyecto, por ejemplo uno de prueba o el stack local de `supabase start`, con las variables de entorno `VENUS_SUPABASE_URL` y `VENUS_SUPABASE_ANON_KEY`. Las claves de otros servicios (CurseForge, Discord, TURN y bore) van aparte, en `src/main/core/app-config.js` (ver [arquitectura.md](arquitectura.md), sección 2).

## 6. Backend de la IA (Edge Function `ai-assistant`)

El Asistente IA y las funciones con IA (explicación de crashes, buscador inteligente, traducción de mods) pueden usar la cuenta de Venus: la Edge Function `ai-assistant` guarda las claves de IA y aplica el plan del usuario (modelos Haiku, Sonnet y Opus 5.5 con sus esfuerzos, preguntas por día y por semana de cada modelo y un presupuesto mensual en dólares). El proveedor **principal** es Anthropic (Claude); el **secundario** es OpenAI (ChatGPT): si Anthropic falla por un problema del proveedor (saturación, caída, límites, sin crédito, configuración), el pedido pasa a OpenAI con un modelo equivalente y la respuesta llega marcada con `served_by`. **No hay plan gratis**: sin suscripción vigente, la cuenta no tiene IA y el launcher muestra los planes (pagos con Stripe: [pagos.md](pagos.md)). No existe la API key propia: la IA va siempre por esta función.

1. **Migraciones**: aplicá `supabase/migrations/0007_ai.sql`, **después** `supabase/migrations/0008_ai_plans.sql` y, para el respaldo en OpenAI, `supabase/migrations/0011_ai_providers.sql` (sección 2). 0008 se apoya en las tablas de 0007 y carga los planes reales: Go (US$ 3,50), Pro (9,25), Super (13,50), Ultra (25,50), Max (36,50) y Supreme (42,50), con sus modelos, esfuerzos, preguntas y presupuestos (tabla completa en [backend-ia.md](backend-ia.md), sección 2). 0011 carga los precios de OpenAI, el modelo de respaldo de cada modelo de Venus y la configuración de proveedores (Anthropic principal, OpenAI secundario, respaldo activado).
2. **CLI**: instalá la [Supabase CLI](https://supabase.com/docs/guides/cli), `supabase login` y `supabase link --project-ref <ref>`.
3. **Secretos**: `supabase secrets set ANTHROPIC_API_KEY=sk-ant-...` (clave **principal**, obligatoria salvo que uses solo OpenAI) y `supabase secrets set OPENAI_API_KEY=sk-...` (clave **secundaria**, para el respaldo; sin ella, solo Anthropic). Quedan solo en Supabase. Opcionales: `AI_UPSTREAM_TIMEOUT_MS` (por defecto `140000`, entre `10000` y `390000`; Supabase corta a los 150 s; es el plazo de los dos proveedores juntos) y `AI_REQUIRE_CONFIRMED_EMAIL=1` (solo cuentas con el email confirmado). `SUPABASE_URL`, `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY` los inyecta Supabase.
4. **Desplegar**: `supabase functions deploy ai-assistant`, enseguida después de aplicar 0008 (hasta que la despliegues, una versión vieja de la función rechaza los pedidos), con la verificación de JWT activada (lo predeterminado). No uses `--no-verify-jwt` salvo el caso que explica `supabase/functions/README.md`. Si algún día agregás `supabase/config.toml`, dejá `[functions.ai-assistant] verify_jwt = true`.
5. **Asignar planes**: cada usuario necesita una fila en `ai_subscriptions`, que solo escribe la service role: la crea el webhook de Stripe cuando el usuario paga desde **Ajustes → Plan** ([pagos.md](pagos.md)), o se carga a mano desde el SQL Editor o el panel de administración para regalar un plan. Los planes, modelos y precios se editan en `ai_plans`, `ai_plan_models` y `ai_models` sin tocar código. Cómo hacerlo: [backend-ia.md](backend-ia.md), secciones 7 y 8.
6. **Precios estimados**: los precios de caché de Haiku 5.5 que carga 0008 (0,01 y 0,125 USD por millón de tokens) son estimados: verificalos en la página de precios de Anthropic y corregilos en `ai_models` si hace falta. Los de OpenAI que carga 0011 son los de lista de octubre de 2026 (nivel Standard): verificalos en https://developers.openai.com/api/docs/pricing antes de cargar `OPENAI_API_KEY`.
7. **Respaldo en OpenAI**: con `OPENAI_API_KEY` y 0011 queda activo. Para apagarlo, cambiar el orden de los proveedores (OpenAI como principal), elegir qué fallas lo activan o cambiar el modelo de OpenAI de cada modelo de Venus, se editan `ai_provider_config` y `ai_tier_fallbacks` con SQL, sin volver a desplegar (tarda hasta un minuto en verse): [backend-ia.md](backend-ia.md), sección 12. Un rechazo de la IA o un pedido inválido nunca pasan al otro proveedor.
8. **Probar**: en el launcher, con la sesión de Venus iniciada, **Ajustes → Inteligencia artificial** muestra el plan, las preguntas que quedan y el presupuesto del mes y tiene **Probar la IA**; **Ajustes → Plan** muestra los planes y la suscripción. También se puede probar con `curl` (ver `supabase/functions/README.md`). Los errores quedan en **Edge Functions → ai-assistant → Logs** (sin el contenido de las conversaciones). Antes de abrir la IA a todos, probá una vez las funciones SQL con un usuario de prueba (pasos al final de [backend-ia.md](backend-ia.md)).
9. **Zona horaria**: el día, la semana (desde el lunes) y el mes de las cuotas se cuentan en la hora de Argentina (`America/Argentina/Buenos_Aires`, en `public.ai_quota_tz()`). Para cambiarla, editá esa función y volvé a ejecutarla.

Protocolo, errores, cómo se cuentan las preguntas y el presupuesto, márgenes, costos y privacidad: [backend-ia.md](backend-ia.md). Despliegue y pruebas de la función: [supabase/functions/README.md](../supabase/functions/README.md).

## 7. Servidores destacados (0006)

La tabla `featured_servers` alimenta **Multijugador → Destacados** y los destacados del Inicio. Los usuarios solo la pueden leer (las filas con `active = true`); se edita desde el panel de Supabase (**Table Editor → featured_servers**) o con SQL desde el **SQL Editor**.

| Columna | Qué es |
|---|---|
| `name` | Nombre visible (hasta 64 caracteres). |
| `address` | Dirección (`host` o `host:puerto`). Única, sin importar mayúsculas. |
| `description` | Descripción (hasta 300 caracteres), en el idioma principal del servidor. |
| `descriptions` | Traducciones opcionales: `{"en": "...", "pt": "..."}`. El launcher muestra la del idioma elegido, si no `description` y si no la de `en`. |
| `tags` | Etiquetas en minúsculas (hasta 8; el launcher muestra 6), por ejemplo `{minigames,survival}`. |
| `language` | Idioma del servidor: código de 2 letras (`es`, `en`, `pt`...) o `multi`. Sirve para el filtro de idioma. |
| `region`, `version` | Región (`LATAM`, `EU`, `NA`, `GLOBAL`...) y versiones que acepta (texto libre, por ejemplo `1.8 – 26.3`). |
| `partner` | `true` para destacarlo primero. |
| `sort` | Orden: los números más bajos van antes (después de los `partner`). |
| `active` | `false` lo oculta sin borrarlo. |

El launcher pide hasta 60 servidores activos, los guarda 10 minutos en memoria y una copia en su caché para usar sin conexión. Si la tabla está vacía o la nube no está configurada, usa la lista que trae incluida (los mismos 14 servidores de la carga inicial).
