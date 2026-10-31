# Backend de la IA: planes, cuotas y Edge Function `ai-assistant`

La IA del launcher (asistente con herramientas, explicación de crashes, buscador inteligente, etc.) va
siempre por el **backend**: la Edge Function `ai-assistant` de Supabase, que guarda las claves de los
proveedores, aplica el plan del usuario (modelos, esfuerzos, preguntas
por día y por semana y presupuesto mensual) y llama a **Claude** (Anthropic, el proveedor principal). Si
Anthropic falla por un problema del proveedor (saturación, caída, límites, sin crédito, configuración), el
mismo pedido pasa a **ChatGPT** (OpenAI, el proveedor secundario) y la respuesta vuelve con la forma de
siempre, marcada con `served_by` (sección 12).

Archivos:

| Archivo | Qué es |
|---|---|
| `supabase/migrations/0007_ai.sql` | Base: planes, suscripciones, preguntas abiertas y límite por minuto. |
| `supabase/migrations/0008_ai_plans.sql` | Los planes reales: modelos y precios, modelos de cada plan, uso y costo por modelo, presupuesto y las funciones de cuota nuevas. Se aplica **después** de 0007. |
| `supabase/migrations/0011_ai_providers.sql` | Proveedor secundario (OpenAI): precios de sus modelos, el modelo de OpenAI de cada modelo de Venus, la configuración de proveedores y el costo de OpenAI en `ai_add_usage`. Se aplica **después** de 0008. |
| `supabase/migrations/0013_ai_budget.sql` | El presupuesto sin agujeros: llamadas en curso (hasta 3 a la vez, con su costo máximo reservado), `ai_end_call` y el tope prorrateado al cambiar de plan en medio del período de Stripe (`billing_apply_subscription`). Se aplica **después** de 0009 y 0011. |
| `supabase/functions/ai-assistant/` | La Edge Function (ver `supabase/functions/README.md`). |
| `src/main/modules/ai.js` | El lado del launcher (cliente del protocolo; no es parte de este módulo). |

**No hay plan gratis**: una cuenta sin suscripción vigente no tiene IA (la función responde `402 noplan` con
el catálogo de planes y el launcher muestra las tarjetas de planes de `features/plans.js`).

## 1. Cómo funciona

```
Launcher (src/main/modules/ai.js)
  │  GET/POST {SUPABASE_URL}/functions/v1/ai-assistant
  │  Authorization: Bearer <token del usuario> · apikey: <anon key>
  ▼
Edge Function ai-assistant
  1. Verifica la sesión con Supabase Auth (auth.getUser).
  2. Valida el pedido (protocolo 1 o 2, herramientas permitidas, tamaños).
  3. ai_register_turn (una transacción, con la service role): plan vigente, modelo y esfuerzo permitidos,
     límite por minuto y de llamadas en curso, presupuesto del mes, pregunta nueva o ya abierta y cupo del modelo.
  4. Arma el pedido: id del modelo de ai_models + esfuerzo + política del servidor + system del launcher +
     mensajes intactos.
  5. Llama a Claude con la clave del servidor y registra los tokens y el costo de cada intento (ai_add_usage).
     Si Anthropic falla por un problema del proveedor, traduce el pedido a la API de OpenAI, lo manda con el
     modelo equivalente (ai_tier_fallbacks) y traduce la respuesta de vuelta (sección 12).
  ▼
API de Anthropic (Claude)  ──respaldo──▶  API de OpenAI (ChatGPT, Responses API)
```

### Cuándo hay IA en el launcher

Lo decide `src/main/modules/ai.js`:

- `ai.enabled = false` (interruptor de Ajustes → Inteligencia artificial): no hay IA.
- Si no, la IA va por este **backend** cuando el usuario inició sesión con su cuenta de Venus (el proyecto es
  siempre el de `core/cloud-defaults.js`). Sin sesión, la IA no está disponible y las funciones muestran su
  camino sin IA; sin plan, la función responde `noplan` y el launcher ofrece los planes.

El modelo y el esfuerzo los elige el usuario en el Asistente entre los que permite su plan (las tareas internas
usan Haiku); la cuota la pone el plan y las claves de Anthropic y de OpenAI viven solo en el servidor. **No hay
API key propia**: la de versiones anteriores (`ai.apiKey` en `core/secure`) y los ajustes `ai.provider` y
`ai.model` se ignoran.

## 2. Los planes

Precios en dólares por mes. **Presupuesto** = lo máximo que puede gastar cada usuario por mes en la IA (la API
de Anthropic y, cuando responde el respaldo, la de OpenAI; un tope duro: cuando lo alcanza, la IA queda
bloqueada hasta el mes siguiente). Esfuerzos: Bajo =
`low`, Medio = `medium`, Alto = `high`. Preguntas: por modelo, por día / por semana.

| Plan | Precio | Presupuesto | Haiku 5.5 | Sonnet 5.5 | Opus 5.5 |
|---|---|---|---|---|---|
| `go` · Go | US$ 3,50 | US$ 1,50 | Bajo, Medio · 35 / 170 | — | — |
| `pro` · Pro | US$ 9,25 | US$ 5 | Bajo, Medio, Alto · 25 / 115 | Bajo, Medio · 5 / 20 | — |
| `super` · Super | US$ 13,50 | US$ 7 | Bajo, Medio, Alto · 25 / 115 | Bajo, Medio · 6 / 30 | — |
| `ultra` · Ultra | US$ 25,50 | US$ 12 | Bajo, Medio, Alto · 25 / 115 | Bajo, Medio, Alto · 8 / 40 | — |
| `max` · Max | US$ 36,50 | US$ 19 | Bajo, Medio, Alto · 25 / 115 | Bajo, Medio, Alto · 8 / 40 | Bajo, Medio · 4 / 20 |
| `supreme` · Supreme | US$ 42,50 | US$ 23 | Bajo, Medio, Alto · 25 / 115 | Bajo, Medio, Alto · 10 / 50 | Bajo, Medio, Alto · 4 / 20 |

Además, por plan:

| Plan | `max_tokens` por llamada | Llamadas por pregunta | Llamadas por minuto |
|---|---|---|---|
| Go | 8000 | 30 | 30 |
| Pro, Super | 16000 | 40 | 40 |
| Ultra, Max, Supreme | 16000 | 60 | 60 |

El modelo por defecto de todos los planes es Haiku 5.5 (el primero por `sort`): es el que usa el protocolo 1
y el que se usa cuando el launcher no elige modelo.

### Margen de cada plan

Margen mínimo por usuario y por mes = **precio − presupuesto − comisión del cobro**. Es el peor caso (un
usuario que gasta todo su presupuesto); la mayoría gasta menos. El proveedor de pagos todavía no está
elegido, así que la comisión de la tabla es solo un **ejemplo** (5 % + US$ 0,30 por cobro, redondeada al
centavo); cambiala por la real cuando se elija el proveedor.

| Plan | Precio | Presupuesto | Precio − presupuesto | Comisión del ejemplo | Margen mínimo del ejemplo |
|---|---|---|---|---|---|
| Go | 3,50 | 1,50 | 2,00 | 0,48 | 1,52 (43 %) |
| Pro | 9,25 | 5,00 | 4,25 | 0,76 | 3,49 (38 %) |
| Super | 13,50 | 7,00 | 6,50 | 0,98 | 5,52 (41 %) |
| Ultra | 25,50 | 12,00 | 13,50 | 1,58 | 11,92 (47 %) |
| Max | 36,50 | 19,00 | 17,50 | 2,13 | 15,37 (42 %) |
| Supreme | 42,50 | 23,00 | 19,50 | 2,43 | 17,07 (40 %) |

No incluye impuestos, conversión de moneda, reintegros ni el costo de Supabase (las Edge Functions se cobran
por invocación y cada llamada del ciclo de herramientas es una). La última llamada del mes puede pasar el
presupuesto por su propio costo (sección 3): en el peor caso, unos centavos con Haiku y alrededor de US$ 1 con
Opus (unos US$ 2,50 si esa llamada la atiende el respaldo de Opus, GPT-6 Astra). Las llamadas simultáneas no
suman más que eso: cada llamada en curso reserva ese costo máximo (0013).

## 3. Cómo se cuentan las preguntas, la semana y el presupuesto

**Pregunta**: cada `turn_id` del launcher (una pregunta del usuario) cuenta **una** pregunta del modelo que
usa, aunque la IA haga varias llamadas con herramientas. Sin `turn_id`, cada llamada es una pregunta nueva.
Las funciones internas (explicación de crashes, buscador, traducción de mods) también gastan preguntas del
modelo que usan.

Cada `POST` pasa por `ai_register_turn` antes de llamar a la IA, en una sola transacción y en este orden:

1. **Plan vigente**: suscripción `active` o `trialing`, sin vencer y con el plan activo. Si no: `noplan`.
2. **Modelo**: el que pide el launcher, el de la pregunta ya abierta o el primero del plan. Tiene que estar
   en el plan: si no, `model`.
3. **Esfuerzo**: el que pide el launcher o, sin valor, `medium` si el plan lo permite con ese modelo; si no,
   el más alto permitido por debajo (`low`); si tampoco, `high`. Tiene que estar permitido: si no, `effort`.
4. **Pregunta atada a su modelo**: todas las llamadas de una pregunta usan el modelo con el que empezó. Si
   el launcher manda otro modelo con el mismo `turn_id`: `turn_model` (para cambiar de modelo, pregunta nueva).
5. **Ráfaga y llamadas en curso**: hasta `requests_per_minute` llamadas por minuto (protege el límite de la
   organización en Anthropic y en OpenAI) y hasta **3 llamadas en curso** a la vez por usuario; si no: `rate`.
   Cuenta también los intentos que después se rechazan por presupuesto o cupo.
6. **Presupuesto**: si lo gastado en el mes (todos los modelos) ya llegó al presupuesto que rige: `budget`. El que
   rige es `monthly_budget_usd` o, si el usuario cambió de plan en medio del período de Stripe, el tope prorrateado
   de la sección 8 (`ai_budget_limit`). Además, cada llamada en curso todavía no sumó su costo: reserva el máximo
   de una llamada de ese modelo (`ai_call_reserve`, con el precio del modelo o el de su respaldo, el más caro) y,
   si con esas reservas se podría pasar el presupuesto, la llamada espera a que terminen las otras (`rate`, que
   el launcher reintenta). Una llamada sola nunca espera. Se revisa en cada llamada, también dentro de una
   pregunta abierta.
7. **Pregunta ya abierta** (mismo `turn_id`, hoy o ayer): suma una llamada sin gastar otra pregunta, hasta
   `max_calls_per_turn`; si no: `turn`.
8. **Pregunta nueva**: suma una pregunta del día y de la semana del modelo si quedan (`daily` / `weekly`). El
   contador sube de forma atómica: dos pedidos simultáneos no pueden pasarse del límite.

Después de cada llamada, `ai_add_usage` registra lo que informó la API **por intento**: entrada, salida
(incluido el razonamiento), lectura y escritura de caché, y el **costo en dólares** con los precios de
`ai_models`. Se cuenta también cuando la respuesta queda cortada o la IA la rechaza, porque el proveedor igual
la factura. Si la API de Anthropic reintentó en otro modelo (`fallbacks: "default"`, solo Opus 5.5 y Sonnet 5.5),
cada intento se cobra con el precio del modelo que lo corrió (lo dice `usage.iterations`) y todo queda en el uso
del modelo de la pregunta.

**Con el respaldo en OpenAI** (sección 12): la pregunta se sigue contando en el modelo de Venus (`haiku`,
`sonnet` u `opus`) exactamente igual, con su cupo por día y por semana. El **costo** se registra en la fila del
modelo de OpenAI que respondió (por ejemplo `gpt-6-1-sol` en `ai_usage_model_daily`), con su precio: entrada sin
caché, entrada en caché a la tarifa de caché, escritura de caché y salida con el razonamiento incluido. Esas filas
tienen llamadas, tokens y costo, nunca preguntas. Como el presupuesto del mes suma todas las filas del usuario,
sigue siendo exacto atienda quien atienda.

Cada llamada permitida queda **en curso** (`ai_rate.inflight`) hasta que la función la cierra: `ai_add_usage`
cuando hubo respuesta (o un costo estimado, abajo) y `ai_end_call` cuando no. Si una función se corta sin
cerrarla, vence sola a los 150 s.

Si ningún proveedor pudo atender el pedido (saturados o caídos: 429, 529, 5xx) la pregunta nueva se devuelve
(`ai_release_turn`). Si se venció el plazo, el launcher canceló o se cortó la conexión, la pregunta no se devuelve
y además se cobra una **estimación del peor caso** con `ai_add_usage`, porque el proveedor pudo haber procesado (y
facturado) el pedido: todo el cuerpo del pedido como escritura de caché (unos 3 caracteres por token) y la salida
entera (`max_tokens`), con el precio del modelo del intento. Así repetir pedidos que se cortan con el mismo
`turn_id` ya no gasta fuera del presupuesto.

**Tarifa de contexto largo de Haiku 5.5**: si la entrada total de un pedido (entrada + lectura + escritura de
caché) pasa los 100.000 tokens, todo ese pedido se cobra a US$ 0,50 / 2,50 por millón (en lugar de 0,10 / 0,50).

**Día, semana y mes**: se cuentan en la zona horaria de `public.ai_quota_tz()`, que es
`America/Argentina/Buenos_Aires`. El cupo diario se renueva a las 00:00, el semanal el lunes a las 00:00 y el
presupuesto el día 1 a las 00:00 (hora de Argentina, 03:00 UTC). La cuota trae esos tres momentos en `resets`.
Para cambiar la zona, reemplazá el texto de `ai_quota_tz()` (por ejemplo `'UTC'` o `'America/Montevideo'`) y
volvé a ejecutar solo esa función; el día, la semana y el mes en curso pasan a contarse en la zona nueva.

## 4. Protocolo (versión 2; la 1 se sigue aceptando)

### `POST /functions/v1/ai-assistant`

| Campo | Tipo | Notas |
|---|---|---|
| `task` | `'assistant' \| 'text' \| 'json'` | Obligatorio. |
| `model` | `'haiku' \| 'sonnet' \| 'opus'` | Solo protocolo 2 y opcional. Sin valor: el de la pregunta abierta (`turn_id`) o el primero del plan (Haiku). El id real de Anthropic sale de `ai_models`, nunca de este texto. |
| `effort` | `'low' \| 'medium' \| 'high'` | Opcional. Sin valor: `medium` si el plan lo permite con ese modelo; si no, el más alto permitido por debajo. |
| `system` | texto | Opcional, hasta 20 KB. Va **después** de la política del servidor. |
| `messages` | lista de mensajes | Obligatorio. Roles `user` y `assistant` (el primero y el último, `user`). Se reenvían **intactos**. |
| `tools` | lista | Solo con `task: 'assistant'`. Las canónicas del launcher (hasta 80, esquemas de hasta 64 KB en total) y, además, hasta 48 de servidores MCP que el usuario agregó en el launcher: nombre `mcp__<servidor>__<herramienta>` (servidor `[a-z0-9-]`, hasta 20; en total hasta 64 caracteres), sin `strict` y hasta 128 KB entre todas. Nunca herramientas del servidor (`type` distinto de `custom`). |
| `schema` | JSON Schema `type: 'object'` | Obligatorio con `task: 'json'` y prohibido en las otras. Hasta 20 KB. |
| `max_tokens` | entero | Se recorta al tope del plan (8000 en Go, 16000 en el resto) y nunca pasa de 16000. Sin valor, el tope del plan. |
| `turn_id` | texto | Una por pregunta del usuario (letras, números y `_ . : -`, hasta 100): agrupa las llamadas de su ciclo de herramientas y las ata a un modelo. Sin valor, cada llamada es una pregunta nueva. |
| `client` | `{ app: 'venus-launcher', protocol: 1 \| 2 }` | Obligatorio. |

**Protocolo 1** (el launcher de antes): igual que el 2 pero sin `model` (si lo manda, es un campo
desconocido): usa el modelo de la pregunta abierta o el primero del plan. Recibe la cuota nueva (QuotaV2).

El cuerpo puede pesar hasta 400 KB. Cualquier otro campo (por ejemplo `thinking`, `temperature`,
`tool_choice`, `fallbacks` o `mcp_servers`) se rechaza. `cache_control` solo se acepta como
`{ type: 'ephemeral' }` (5 minutos): la caché de 1 hora cuesta más de lo que cuenta el presupuesto.

Bloques aceptados en los mensajes: del usuario `text`, `image` (solo base64: PNG, JPEG, GIF o WebP) y
`tool_result`; de la IA `text`, `thinking`, `redacted_thinking`, `tool_use` y `fallback`. Los bloques de
la IA tienen que volver exactamente como llegaron (también los `thinking` vacíos con su firma).

Respuesta `200`:

```json
{
  "message": {
    "content": [...],
    "stop_reason": "end_turn",
    "usage": { ... },
    "model": "claude-sonnet-5-5",
    "served_by": { "provider": "anthropic", "model": "claude-sonnet-5-5", "failover": false }
  },
  "parsed": { ... },
  "quota": { ... }
}
```

`parsed` viene solo con `task: 'json'` (o `null` si la respuesta quedó cortada). `message.model` es el
modelo que respondió (puede ser el de respaldo si hubo reintento en otro modelo, o un modelo de OpenAI).

`message.served_by` (nuevo, viene siempre) dice quién respondió:

| Campo | Qué es |
|---|---|
| `provider` | `anthropic` u `openai`. |
| `model` | Modelo que respondió, el mismo que `message.model` (por ejemplo `claude-sonnet-5-5`, `claude-opus-5` si Anthropic reintentó en otro modelo, o `gpt-6.1-sol`). |
| `failover` | `true` si respondió el proveedor secundario porque el principal falló o no está configurado. |

Cuando responde OpenAI, el resto de `message` tiene la misma forma que con Anthropic: `content` con bloques
`text` y `tool_use` (`id` = el `call_id` de OpenAI, `name`, `input`), `stop_reason` `end_turn`, `tool_use` o
`max_tokens`, y `usage` con `input_tokens` (entrada sin caché), `output_tokens` (incluye el razonamiento),
`cache_read_input_tokens` y `cache_creation_input_tokens`. No trae bloques `thinking` (OpenAI no los
devuelve). El launcher guarda y reenvía esos bloques como siempre: la llamada siguiente de la misma pregunta
puede ir a cualquiera de los dos proveedores.

### `GET /functions/v1/ai-assistant`

Devuelve `{ "quota": QuotaV2, "plans": Catalog }` sin llamar a la IA (lo usa `ai:status` en el launcher).

**QuotaV2** (también en cada respuesta y en los errores):

```json
{
  "plan": "max",
  "planName": "Max",
  "priceUsd": 36.5,
  "status": "active",
  "models": [
    { "id": "haiku", "model": "claude-haiku-5-5", "label": "Haiku 5.5", "efforts": ["low", "medium", "high"],
      "daily": { "used": 3, "limit": 25 }, "weekly": { "used": 9, "limit": 115 } },
    { "id": "sonnet", "model": "claude-sonnet-5-5", "label": "Sonnet 5.5", "efforts": ["low", "medium", "high"],
      "daily": { "used": 0, "limit": 8 }, "weekly": { "used": 2, "limit": 40 } },
    { "id": "opus", "model": "claude-opus-5-5", "label": "Opus 5.5", "efforts": ["low", "medium"],
      "daily": { "used": 1, "limit": 4 }, "weekly": { "used": 1, "limit": 20 } }
  ],
  "budget": { "usedUsd": 2.1234, "limitUsd": 19 },
  "resets": { "daily": "2026-10-29T03:00:00Z", "weekly": "2026-11-02T03:00:00Z", "monthly": "2026-11-01T03:00:00Z" },
  "timezone": "America/Argentina/Buenos_Aires",
  "lastModel": "sonnet"
}
```

| Campo | Qué es |
|---|---|
| `plan`, `planName`, `priceUsd` | Plan vigente, o `null` los tres si no hay. |
| `status` | `active`, `trialing` (de prueba) o `none` (sin plan). |
| `models` | Modelos del plan en orden (el primero es el por defecto), con sus esfuerzos y las preguntas usadas / permitidas hoy y esta semana. Sin plan, `[]`. |
| `budget` | Gastado en el mes (USD, 4 decimales) y presupuesto del plan (0 sin plan). |
| `resets` | Cuándo se renuevan el día, la semana y el mes (ISO 8601, UTC). |
| `timezone` | Zona horaria de las cuotas. |
| `lastModel` | Opcional: el último modelo usado, si el plan lo sigue ofreciendo (para preseleccionarlo). |

**Catalog** (planes activos, en orden):

```json
[
  { "id": "go", "name": "Go", "priceUsd": 3.5, "budgetUsd": 1.5,
    "models": [{ "id": "haiku", "label": "Haiku 5.5", "efforts": ["low", "medium"], "daily": 35, "weekly": 170 }] },
  { "id": "pro", "name": "Pro", "priceUsd": 9.25, "budgetUsd": 5, "models": [ ... ] }
]
```

### Errores

Todos traen CORS y JSON. `message` está en español; `error`, `reason` y `code` son estables para que el
launcher los traduzca.

| Estado | Cuerpo | Cuándo |
|---|---|---|
| 401 | `{ error: 'unauthorized' }` | Token vencido o inválido. |
| 403 | `{ error: 'unauthorized', code: 'anonymous' \| 'unconfirmed', message }` | Usuario anónimo, o email sin confirmar si se activó `AI_REQUIRE_CONFIRMED_EMAIL`. |
| 402 | `{ error: 'noplan', message, quota, plans }` | Sin suscripción vigente. `plans` es el catálogo. |
| 403 | `{ error: 'plan', reason: 'model' \| 'effort', model, message, quota }` | El plan no incluye ese modelo, o no permite ese esfuerzo con ese modelo. |
| 429 | `{ error: 'quota', reason, model?, message, quota }` | `reason`: `daily` / `weekly` (preguntas del modelo), `budget` (presupuesto del mes), `turn` (llamadas de la pregunta), `rate` (llamadas por minuto, 3 llamadas en curso, o las llamadas en curso podrían pasar el presupuesto: hay que esperar). |
| 400 | `{ error: 'bad_request', code, message, quota? }` | `code`: `invalid_request` (pedido mal armado), `turn_model` (cambio de modelo en medio de una pregunta; trae `quota`) o `upstream_invalid_request` (la API de Anthropic rechazó el formato). 405 usa `method_not_allowed`. |
| 422 | `{ error: 'refusal', quota }` | La IA (y su modelo de respaldo, si tiene) rechazó el pedido. Un rechazo nunca pasa al otro proveedor. |
| 502 / 503 | `{ error: 'upstream', message, code, quota? }` | Falla del proveedor de IA (Anthropic, y OpenAI si también se probó), de Auth o de la base. |

Nunca se devuelven 401, 404 ni 429 por fallas de los proveedores, porque el launcher los usa para "sesión
vencida", "el servidor no tiene el asistente" y "cuota del plan".

Códigos de `upstream`: `upstream_rate_limited` y `upstream_overloaded` (proveedor saturado),
`upstream_unavailable`, `upstream_timeout`, `upstream_network`, `upstream_billing` (sin crédito en la
cuenta del proveedor), `upstream_auth` / `upstream_permission` / `upstream_config` (clave, betas o parámetros
mal configurados), `upstream_model` (el modelo no existe), `auth_unavailable`, `quota_unavailable`,
`backend_not_ready` (faltan las migraciones 0007 u 0008), `not_configured` (no hay ninguna clave de IA, o
ningún proveedor puede atender ese modelo), `aborted` e `internal`. Si los dos proveedores fallan, el código es
el del último que se probó (OpenAI), salvo que OpenAI haya rechazado el pedido traducido (400): ahí es el de
Anthropic (sección 12).

## 5. Seguridad: qué se aplica en el código

Las restricciones del producto no dependen solo del prompt:

| Restricción ("Lo que la IA NO puede hacer") | Dónde se aplica |
|---|---|
| Solo actuar con las herramientas listadas | El backend acepta únicamente definiciones con los 23 nombres canónicos (`config.ts`) y las de los servidores MCP que el usuario agregó en el launcher (`mcp__<servidor>__<herramienta>`, `isMcpToolName`), siempre de tipo propio: nada de búsqueda web, ejecución de código, bash, conectores MCP de Anthropic ni otras herramientas de servidor. Todas las ejecuta el launcher (módulo del asistente), que aplica los niveles de permiso y pide confirmación antes de cada herramienta MCP (salvo las de solo lectura o las que el usuario permitió siempre). |
| Cuenta de Microsoft, tokens, contraseñas, pagos | No existe herramienta para eso. El backend no tiene acceso a esos datos (las claves de Anthropic y de OpenAI y la service role nunca salen del servidor). |
| Archivos fuera de la instancia, borrar mundos, comandos o `.jar` arbitrarios | No hay herramientas para eso; las que hay las implementa el launcher validando rutas. El backend no ejecuta nada: solo reenvía texto. |
| Descargas que no sean de Modrinth/CurseForge | Las descargas las hace el launcher con sus herramientas de instalación. |
| Cambiar la cuenta, el plan o la suscripción | Las tablas de planes, modelos, suscripciones y uso solo las escribe la service role (RLS + permisos). |
| Mandar datos a servicios externos | El backend solo habla con Supabase, con la API de Anthropic y, cuando responde el respaldo, con la API de OpenAI. Las herramientas MCP las ejecuta el launcher contra los servidores que el usuario agregó a mano; la política lo explica como la única excepción. |
| Elegir el modelo, el esfuerzo o la cuota | El cliente solo puede pedir `haiku`, `sonnet` u `opus`, y solo los de su plan; el id de Anthropic sale de `ai_models` y el de OpenAI de `ai_tier_fallbacks` + `ai_models`. El esfuerzo se valida contra el plan, `max_tokens` se recorta al plan y nada de `thinking`, `temperature`, `fallbacks` ni caché de 1 hora. A OpenAI tampoco se le manda `temperature`, `top_p` ni `tool_choice`. |
| Gastar más que el plan | Presupuesto mensual por usuario calculado con el costo real de cada llamada (y una estimación de las que se cortan); llamadas en curso limitadas y con su costo máximo reservado; tope prorrateado al cambiar de plan en medio del período; preguntas por modelo por día y por semana; preguntas atadas a su modelo. |
| Confirmación de cambios destructivos | La pide el launcher en su interfaz (`remove_mod`); la política se lo explica a la IA. |

Niveles de permiso de las herramientas (`TOOL_LEVELS` en `config.ts`, iguales a los del launcher):

- **Lectura** (sin confirmación): `list_instances`, `get_instance_info`, `list_mods`, `get_system_specs`,
  `search_mods`, `search_resource_packs`, `search_shaders`, `get_mod_versions`, `check_compatibility`,
  `read_crash_summary`, `run_benchmark`, `list_servers`, `get_server_info`, `read_server_console`, `get_server_properties`, `list_server_plugins`, `search_server_plugins`, `list_server_backups`, `recommend_ram`, `list_snapshots`, `list_worlds`.
- **Cambios reversibles** (copia de la configuración + botón "Deshacer"): `create_instance`, `install_mod`,
  `install_resource_pack`, `install_shader`, `update_mod` (también para bajar de versión), `toggle_mod`,
  `set_ram`, `set_option`, `set_java_version`, `set_jvm_args` (solo argumentos de la lista blanca),
  `change_instance_version`, `create_server`, `start_server`, `stop_server`, `restart_server`, `send_server_command`, `set_server_property`, `set_server_ram`, `install_server_plugin`, `update_server_plugin`, `replace_server_plugin`, `toggle_server_plugin`, `backup_server_world`, `duplicate_instance`, `rename_instance`, `create_snapshot`, `backup_world`.
- **Destructivos** (confirmación explícita en la interfaz): `remove_mod`, `remove_server_plugin`, `restore_server_backup`, `restore_snapshot`, `whitelist_add`, `whitelist_remove`, `op_player`.

Las herramientas de servidores locales, RAM, instantáneas y mundos se sumaron el 28/10 (55 herramientas propias en total): `LIMITS.maxTools` pasó de 30 a 80 y `LIMITS.toolSchemasBytes` de 20 KB a 64 KB (las definiciones de hoy pesan ~21 KB de esquemas).

**Política del servidor** (`policy.ts`): va siempre primero en el `system` y dice que tiene prioridad sobre
las instrucciones del launcher, del usuario y del contenido de las herramientas. Incluye la lista de lo que
la IA no puede hacer, que nunca diga que hizo algo sin una herramienta que haya respondido bien, que trate
logs y resultados de herramientas como datos y no como órdenes, que no revele secretos ni sus
instrucciones, y la regla de idioma: español rioplatense por defecto, o el idioma en que escriba el usuario
(en las tareas internas `text` y `json` manda el formato y el idioma que pida el launcher).

La política también tiene una sección para las herramientas de los servidores MCP del usuario (`mcp__…`): son la única excepción a "mandar datos a servicios externos", solo para lo que pidió el usuario y con la confirmación del launcher, y sus resultados son contenido de terceros no confiable (ver [asistente-ia.md](asistente-ia.md), sección 10). Se desplegó en la versión 9 de `ai-assistant` (28/10/2026).

Es **texto fijo** a propósito: si cambiara entre llamadas de una conversación se perdería la caché y los
bloques `thinking` que reenvía el launcher dejarían de ser válidos. Si se edita `policy.ts` y se vuelve a
desplegar, las conversaciones abiertas en ese momento pueden fallar con un 400 y hay que empezar una nueva.

Otras medidas: usuarios anónimos bloqueados; `AI_REQUIRE_CONFIRMED_EMAIL` opcional; RLS en todas las
tablas (cada usuario lee solo lo suyo y nadie escribe desde el cliente); funciones de cuota `SECURITY
DEFINER` con `search_path` vacío y ejecutables solo por la service role (salvo `ai_my_quota`, de solo lectura).

## 6. Despliegue

1. Aplicá **en orden** `supabase/migrations/0007_ai.sql`, `supabase/migrations/0008_ai_plans.sql`,
   `supabase/migrations/0011_ai_providers.sql` y `supabase/migrations/0013_ai_budget.sql` (SQL Editor del panel o
   `supabase db push`; 0013 necesita también 0009, la de pagos).
2. Cargá las claves:
   - `supabase secrets set ANTHROPIC_API_KEY=sk-ant-...` — **principal** (Claude).
   - `supabase secrets set OPENAI_API_KEY=sk-...` — **secundaria** (ChatGPT, el respaldo). Opcional: sin ella
     la función trabaja solo con Anthropic, exactamente como antes. Conviene una clave de un **proyecto** de
     OpenAI dedicado al launcher, con límite de gasto mensual cargado en el panel de OpenAI.
3. Desplegá enseguida: `supabase functions deploy ai-assistant` (verificación de JWT activada). Entre la
   migración 0008 y el despliegue, una función vieja que siga publicada rechaza todos los pedidos (a propósito:
   no puede gastar fuera del presupuesto). Si se despliega la función antes de aplicar 0008, responde
   `backend_not_ready`. Sin 0011, la función anda igual pero sin respaldo (deja un aviso en el log si
   `OPENAI_API_KEY` está cargada).
4. Asigná planes (sección 8): sin suscripción no hay IA.
5. Opcional: `AI_UPSTREAM_TIMEOUT_MS`, `AI_REQUIRE_CONFIRMED_EMAIL` (ver `supabase/functions/README.md`).
6. Probá con `curl` (en el README de las funciones) o desde el launcher: Ajustes → Inteligencia artificial. Para
   probar el respaldo, ver la sección 12.

Los pedidos a Opus 5.5 y Sonnet 5.5 usan el beta de reintento automático en otro modelo
(`server-side-fallback-2026-07-01`, con `fallbacks: "default"`); Haiku 5.5 no lo tiene y nunca lo manda. Las
tareas `json` usan el de salidas estructuradas que agrega el SDK. Si la organización de Anthropic no tuviera
alguno disponible, la API responde 400 y la función devuelve `upstream_config` (queda en el log). Ningún pedido
manda `thinking` ni `temperature` (los tres modelos piensan solos; la profundidad se controla con `effort`).

## 7. Planes: ver y editar

Todo se edita desde el panel (Table Editor) o con SQL, sin tocar código ni volver a desplegar. Volver a
aplicar 0008 no pisa lo editado: solo completa planes que todavía no tienen precio ni presupuesto y solo
carga modelos en planes que no tienen ninguno.

**`public.ai_plans`** (una fila por plan):

| Columna | Qué es |
|---|---|
| `id`, `name` | Identificador (`go`, `pro`...) y nombre que ve el usuario. |
| `price_usd`, `currency` | Precio por mes (informativo: lo cobra el proveedor de pagos). |
| `monthly_budget_usd` | Presupuesto: gasto máximo en Anthropic por usuario y por mes (USD). Con 0 el plan no da IA. |
| `max_tokens_per_request` | Tope de `max_tokens` por llamada (1000 a 16000). |
| `max_calls_per_turn` | Llamadas a la IA dentro de una misma pregunta. |
| `requests_per_minute` | Llamadas por minuto por usuario. |
| `sort`, `active` | Orden en el catálogo y si el plan se puede usar (`false` = sus usuarios se quedan sin IA). |
| `model`, `daily_messages`, `monthly_tokens` | **Sin uso** desde 0008 (quedan por compatibilidad; se ignoran). |

**`public.ai_plan_models`** (los modelos de cada plan): `plan_id`, `model_id` (`haiku`, `sonnet`, `opus`),
`efforts` (lista con `low`, `medium` y/o `high`), `daily_questions`, `weekly_questions` y `sort` (el primero es
el modelo por defecto).

**`public.ai_models`** (modelos y precios de lista en USD por millón de tokens): `model_id` (id de la API de
su proveedor), `provider` (`anthropic` u `openai`, desde 0011), `label`, `input_usd_mtok`, `output_usd_mtok`,
`cache_read_usd_mtok`, `cache_write_usd_mtok` (caché de 5 minutos en Anthropic; de 30 minutos en OpenAI), la
tarifa de contexto largo opcional (`long_context_threshold` y las columnas `long_*`), `supports_fallback` y
`active`. Las filas inactivas `opus-5`, `opus-4-8` y `sonnet-5` son solo de precio: sirven para cobrar los
reintentos en otro modelo. Las de OpenAI (`gpt-6-luna`, `gpt-6-1-terra`, `gpt-6-1-sol`, `gpt-6-astra`) también son
solo de precio: las usa el respaldo y nunca se pueden ofrecer en un plan (un check lo impide). Para ofrecer un
modelo con un id nuevo hay que agregarlo también a `MODEL_KEYS` en `supabase/functions/ai-assistant/config.ts`
(y al launcher). Qué modelo de OpenAI reemplaza a cada modelo de Venus y en qué orden se usan los proveedores:
sección 12.

Ejemplos:

```sql
-- Cambiar el precio o el presupuesto de un plan
update public.ai_plans set price_usd = 9.99, monthly_budget_usd = 5.50 where id = 'pro';

-- Cambiar el cupo o los esfuerzos de un modelo en un plan
update public.ai_plan_models
   set daily_questions = 6, weekly_questions = 25, efforts = array['low', 'medium', 'high']
 where plan_id = 'pro' and model_id = 'sonnet';

-- Agregar un modelo a un plan / quitarlo
insert into public.ai_plan_models (plan_id, model_id, efforts, daily_questions, weekly_questions, sort)
values ('ultra', 'opus', array['low'], 2, 8, 30);
delete from public.ai_plan_models where plan_id = 'ultra' and model_id = 'opus';

-- Plan nuevo (con sus modelos)
insert into public.ai_plans (id, name, price_usd, monthly_budget_usd, max_tokens_per_request, max_calls_per_turn, requests_per_minute, sort)
values ('mega', 'Mega', 60, 32, 16000, 60, 60, 70);
insert into public.ai_plan_models (plan_id, model_id, efforts, daily_questions, weekly_questions, sort)
values ('mega', 'haiku', array['low', 'medium', 'high'], 30, 150, 10),
       ('mega', 'opus', array['low', 'medium', 'high'], 8, 40, 30);

-- Dejar de ofrecer un plan (sus usuarios se quedan sin IA hasta cambiar de plan)
update public.ai_plans set active = false where id = 'super';

-- Corregir un precio de Anthropic (por ejemplo la caché de Haiku, que está estimada)
update public.ai_models set cache_read_usd_mtok = 0.01, cache_write_usd_mtok = 0.125 where id = 'haiku';
```

Un plan con suscripciones no se puede borrar y un modelo con uso tampoco (las claves foráneas lo impiden):
desactivalos. Los planes provisorios de 0007 (`free` y `plus`) quedan desactivados.

Ver el uso:

```sql
-- Gasto y preguntas del mes por usuario
select user_id, sum(cost_usd) as usd, sum(questions) as preguntas, sum(calls) as llamadas
  from public.ai_usage_model_daily
 where day >= date_trunc('month', public.ai_local_now())::date
 group by user_id
 order by usd desc;

-- Gasto del mes por plan (con el plan vigente de cada usuario) y margen antes de comisiones
select s.plan_id, count(distinct u.user_id) as usuarios, sum(u.cost_usd) as gasto_usd,
       count(distinct u.user_id) * max(p.price_usd) - sum(u.cost_usd) as margen_usd
  from public.ai_usage_model_daily u
  join public.ai_subscriptions s on s.user_id = u.user_id
  join public.ai_plans p on p.id = s.plan_id
 where u.day >= date_trunc('month', public.ai_local_now())::date
 group by s.plan_id;

-- Estado de la cuota de un usuario (lo mismo que recibe el launcher) y el catálogo
select public.ai_quota_status('<uuid del usuario>');
select public.ai_catalog();

-- Probar el costo de un pedido: 120.000 tokens de entrada en Haiku usan la tarifa larga
select public.ai_price_line(m, 120000, 1000, 0, 0) from public.ai_models m where m.id = 'haiku';
```

(La consulta de margen solo cuenta a los usuarios que usaron la IA en el mes.) Desde la interfaz del launcher
también se puede leer la cuota propia sin llamar a la función: `cloud.client.rpc('ai_my_quota')`.

## 8. Asignar un plan a un usuario

Sin fila en `ai_subscriptions` el usuario no tiene IA por el backend. Una suscripción vale si `status` es
`active` o `trialing`, el plan está activo y `current_period_end` es `null` o futuro.

```sql
-- A mano (por ejemplo, un plan de regalo sin vencimiento)
insert into public.ai_subscriptions (user_id, plan_id, status, current_period_end, source)
values ('<uuid del usuario>', 'pro', 'active', null, 'manual')
on conflict (user_id) do update
  set plan_id = excluded.plan_id, status = excluded.status,
      current_period_end = excluded.current_period_end, source = excluded.source;

-- Lo que hará el webhook de pagos al cobrar una renovación
insert into public.ai_subscriptions (user_id, plan_id, status, current_period_end, source, external_ref)
values ('<uuid del usuario>', 'max', 'active', '2026-11-27T00:00:00Z', '<proveedor>', '<id de la suscripción>')
on conflict (user_id) do update
  set plan_id = excluded.plan_id, status = excluded.status, current_period_end = excluded.current_period_end,
      source = excluded.source, external_ref = excluded.external_ref;

-- Cancelación o pago rechazado: deja de valer (sin IA)
update public.ai_subscriptions set status = 'canceled' where user_id = '<uuid del usuario>';
```

Cambiar de plan en medio del mes no reinicia el gasto del mes ni las preguntas de la semana: rige el
presupuesto y el cupo del plan nuevo contra lo ya usado.

**Cambio de plan en medio del período de Stripe (0013)**: Stripe cobra solo el prorrateo del tiempo que queda, así
que el presupuesto nuevo también se prorratea. `billing_apply_subscription` guarda en `ai_subscriptions` un tope,
`budget_cap_usd` = lo pagado en el período (el tope que ya tenía o, si no, el presupuesto del plan anterior) +
(presupuesto nuevo − anterior) × (lo que queda del período / un mes), que vale hasta el fin de ese período
(`budget_cap_until`). Mientras tanto rige el menor entre el presupuesto del plan y el tope. Por ejemplo, subir de
Go a Supreme a una hora de la renovación deja unos US$ 1,53 (no US$ 23); a mitad del período, unos US$ 12. Al
renovar (período pagado entero) el tope vence. Solo vale para filas de Stripe (`source = 'stripe'`): un plan
manual o de un admin no lo usa.

**Webhook de pagos: pendiente.** El proveedor todavía no está elegido. Cuando se elija, el webhook tiene que
correr en el servidor con la service role (por ejemplo, otra Edge Function), verificar la firma del proveedor,
traducir el producto o precio del proveedor a un `plan_id`, hacer exactamente esos `upsert` por `user_id` y
ser idempotente (el proveedor puede mandar el mismo evento más de una vez). Estados posibles: `active`,
`trialing`, `past_due`, `paused`, `canceled`, `expired` (solo los dos primeros dan acceso; si querés días de
gracia con `past_due`, agregalo en `ai_effective_plan`). El precio que cobra el proveedor tiene que coincidir
con `ai_plans.price_usd`, que es solo informativo.

## 9. Costos

Precios de lista de Anthropic (octubre de 2026, USD por millón de tokens; verificá los actuales en la página
de precios de Anthropic). Son los que carga 0008 en `ai_models`:

| Modelo | Entrada | Salida | Lectura de caché | Escritura de caché (5 min) |
|---|---|---|---|---|
| Haiku 5.5 (`claude-haiku-5-5`) | 0,10 | 0,50 | 0,01 (estimado) | 0,125 (estimado) |
| Haiku 5.5, pedidos de más de 100K tokens | 0,50 | 2,50 | 0,05 (estimado) | 0,625 (estimado) |
| Sonnet 5.5 (`claude-sonnet-5-5`) | 2 | 10 | 0,20 | 2,50 |
| Opus 5.5 (`claude-opus-5-5`) | 4 | 20 | 0,20 | 5 |
| Respaldo: Opus 5 / Opus 4.8 | 5 | 25 | 0,50 (estimado) | 6,25 (estimado) |
| Respaldo: Sonnet 5 | 2 | 10 | 0,20 (estimado) | 2,50 (estimado) |

Los precios de caché de Haiku no están publicados en nuestras referencias: los de la tabla siguen los
multiplicadores habituales (lectura 0,1x y escritura 1,25x de la entrada). **Verificalos** y corregilos en
`ai_models` si hace falta. Lo mismo con la caché de los modelos de respaldo.

### Precios de OpenAI (respaldo)

Precios de lista de OpenAI del nivel **Standard** (octubre de 2026, USD por millón de tokens; **verificalos**
antes de abrir el respaldo). Son los que carga 0011 en `ai_models`:

| Modelo (`model_id`) | Reemplaza a | Entrada | Entrada en caché | Escritura de caché (30 min) | Salida |
|---|---|---|---|---|---|
| GPT-6 Luna (`gpt-6-luna`) | Haiku 5.5 | 0,10 | 0,01 | 0,125 | 0,50 |
| GPT-6.1 Terra (`gpt-6.1-terra`) | — (cargado como alternativa) | 1 | 0,05 | 1,25 | 5 |
| GPT-6.1 Sol (`gpt-6.1-sol`) | Sonnet 5.5 | 2 | 0,10 | 2,50 | 10 |
| GPT-6 Astra (`gpt-6-astra`) | Opus 5.5 | 10 | 1 | 12,50 | 50 |

Pedidos de más de 272.000 tokens de entrada: el doble la entrada y la caché y 1,5 veces la salida, para todo
el pedido (columnas `long_*`; con el límite de 400 KB del cuerpo no debería pasar). La escritura de caché de 12
horas cuesta el doble que la de 30 minutos (el backend no la pide; si apareciera, se cobra bien igual). El
procesamiento regional (residencia de datos) suma un 10 % y los niveles Fast y Flex tienen otros precios: el
backend usa el nivel Standard, sin región.

Fuentes (consultadas el 27/10/2026): [precios de la API](https://developers.openai.com/api/docs/pricing), las
páginas de cada modelo ([gpt-6-luna](https://developers.openai.com/api/docs/models/gpt-6-luna),
[gpt-6.1-terra](https://developers.openai.com/api/docs/models/gpt-6.1-terra),
[gpt-6.1-sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol),
[gpt-6-astra](https://developers.openai.com/api/docs/models/gpt-6-astra)) y la guía de
[caché de prompts](https://developers.openai.com/api/docs/guides/prompt-caching). Compará también con
https://openai.com/api/pricing antes de abrir el respaldo.

Orden de magnitud por pregunta con las mismas cuentas de arriba (45.000 tokens de entrada, casi todos en
caché, y 3.000 de salida; el tokenizador y el razonamiento de OpenAI no son iguales, así que es aproximado):
GPT-6 Luna ≈ US$ 0,003, GPT-6.1 Sol ≈ US$ 0,05 y GPT-6 Astra ≈ US$ 0,25. Es decir: el respaldo de Haiku y el de
Sonnet cuestan lo mismo que el original; el de Opus, unas 2,5 veces más (el presupuesto lo cobra con ese precio,
así que en un corte largo de Anthropic los usuarios de Opus llegan antes al tope). Si preferís cuidar el
presupuesto, cambiá el respaldo de Opus por GPT-6.1 Sol (sección 12).

Orden de magnitud por pregunta al asistente con 3 o 4 llamadas de herramientas y esfuerzo `medium` (unos
45.000 tokens de entrada en total, casi todos lectura de caché, y unos 3.000 de salida con el razonamiento;
`high` piensa más y cuesta más):

| Modelo | Por pregunta | Explicación de un crash (`text`, una llamada) |
|---|---|---|
| Haiku 5.5 | ≈ US$ 0,003 | ≈ US$ 0,002 |
| Sonnet 5.5 | ≈ US$ 0,06 | ≈ US$ 0,04 |
| Opus 5.5 | ≈ US$ 0,11 | ≈ US$ 0,07 |

Con esos números, un usuario que usa **todas** las preguntas de la semana (unas 4,4 semanas por mes) gastaría
más o menos: Go 2,2 · Pro 6,8 · Super 9,4 · Ultra 12 · Max 22 · Supreme 25 dólares. Es decir, para los usuarios
más intensivos el que corta es el presupuesto; para el resto, las preguntas por día y por semana.

Palancas, de la más barata a la más cara de aplicar:

- **Caché**: ya está activa (la política es fija y el launcher manda el historial sin cambios). Dentro de
  un ciclo de herramientas casi todo se lee de la caché.
- **Presupuesto** y **preguntas por modelo** de cada plan (sección 7).
- **Esfuerzo**: el launcher elige `low`, `medium` o `high` por tarea dentro de lo que permite el plan; `low`
  alcanza para tareas simples.
- **Modelo**: Haiku cuesta una fracción de Sonnet y Opus; probá la calidad antes de mover tareas de modelo.
- **Abuso**: sin plan no hay IA. Si el registro no pide confirmar el email, conviene activar la
  confirmación (docs/supabase.md) y `AI_REQUIRE_CONFIRMED_EMAIL=1`.

## 10. Privacidad

- **No se registra el contenido de las conversaciones**: ni la función ni la base guardan mensajes,
  prompts, respuestas ni resultados de herramientas. Los logs solo tienen códigos de error, estados HTTP, el
  `request_id` del proveedor (`provider=anthropic` u `openai`), los avisos de respaldo (`respaldo: anthropic ->
  openai (upstream_overloaded)`) y, si un reintento corrió en un modelo sin precio en `ai_models`, su id. Los dos
  SDK quedan fijos en `logLevel: 'warn'` para que no registren pedidos aunque alguien configure
  `ANTHROPIC_LOG=debug` u `OPENAI_LOG=debug`.
- **Lo que se guarda**: contadores por día y por modelo (preguntas, llamadas, tokens y costo), los `turn_id`
  de los últimos días con su modelo (se borran solos), la ventana de un minuto de la ráfaga y la suscripción.
  Cada usuario puede leer solo lo suyo. Al borrar un usuario se borra todo en cascada.
- **Lo que recibe Anthropic**: el contenido de cada pedido (la conversación, el `system` y las
  herramientas), porque es quien genera la respuesta. Lo trata según sus términos comerciales. El launcher
  ya recorta y limpia los datos que manda (por ejemplo, el resumen del crash).
- **Lo que recibe OpenAI**: lo mismo, pero solo en los pedidos que atiende el respaldo (o todos, si se lo pone
  como principal). Se manda con `store: false`, así OpenAI no guarda la respuesta para recuperarla después; igual
  la trata según sus políticas de datos de la API. No se manda ningún dato del usuario aparte de la conversación
  (ni el id ni el email). Si tu política de privacidad nombra a Anthropic como proveedor de IA, agregá a OpenAI.
- La función no manda datos a ningún otro servicio.

## 11. Límites conocidos

- **Sin streaming**: Supabase corta una respuesta que tarda más de 150 s. El plazo por defecto es 140 s
  (`AI_UPSTREAM_TIMEOUT_MS`); respuestas muy largas con esfuerzo `high` pueden no llegar a tiempo y
  devuelven `upstream_timeout`. En ese caso (y si el launcher cancela o se corta la conexión) se cobra una
  estimación del peor caso, que puede ser más de lo que facturó el proveedor (sección 3).
- **El presupuesto se revisa antes de cada llamada**: la última llamada del mes puede pasarlo por lo que
  cueste esa sola llamada. Las llamadas simultáneas reservan su costo máximo con el modelo de la llamada que
  entra; si se mezclan modelos (por ejemplo Haiku mientras corren dos de Opus) el exceso queda acotado por las 3
  llamadas en curso.
- **Mes calendario y período de Stripe**: el presupuesto se cuenta por mes calendario y el cobro por período de
  facturación. Quien se suscribe a fin de mes usa dos meses de presupuesto en su primer período (como máximo, un
  presupuesto extra al suscribirse o al cancelar).
- **Costos estimados**: la caché de Haiku y la de los modelos de respaldo no están confirmadas (sección 9). Si
  un reintento corre en un modelo que no está en `ai_models`, se cobra con el precio del modelo de la pregunta
  y queda un aviso en el log (`modelo sin precio`): agregá su fila de precio.
- **Conversaciones y bloques `thinking`**: la política, el `system` del launcher y las herramientas no
  pueden cambiar en medio de una conversación (ver sección 5). Si el clasificador de seguridad rechaza un
  pedido y lo responde el modelo de respaldo, las preguntas siguientes de esa conversación siguen sin el
  razonamiento anterior (lo maneja la API; no da error).
- **Protocolo 1**: el launcher de antes no elige modelo (usa Haiku, el primero de todos los planes) y no
  conoce `402 noplan` ni `403 plan` (muestra el mensaje genérico con el texto del servidor).
- Los mensajes de error del servidor están en español. Cada uno trae un código estable (`error`, `reason`,
  `code`) para traducirlo del lado del launcher.
- **Respaldo en OpenAI** (sección 12):
  - El plazo de 140 s es para todos los intentos juntos y el respaldo solo se prueba si quedan al menos 15 s.
    Como el SDK de Anthropic espera hasta el mismo plazo, un Anthropic que no responde nunca (en vez de dar un
    error) termina en `upstream_timeout` sin pasar a OpenAI. Antes de pasar, el SDK de Anthropic hace sus 2
    reintentos de siempre (con espera), así que el respaldo tarda unos segundos más que una respuesta normal.
  - El razonamiento no pasa de un proveedor al otro: OpenAI no lee los bloques `thinking` de Claude (se omiten
    al traducir) y su propio razonamiento no se guarda en la conversación. Anthropic acepta sin problema los
    turnos de OpenAI (texto y `tool_use`, sin `thinking`) y sigue leyendo su razonamiento anterior.
  - Las herramientas `strict` del launcher tienen propiedades opcionales, que el modo estricto de OpenAI no
    permite: se mandan como obligatorias que aceptan `null` y esos `null` se quitan al volver. Un esquema con algo
    que el modo estricto no acepta (`anyOf`, `$ref`...) va sin modo estricto (el launcher valida todo igual).
  - Las fases de los mensajes de la IA (`phase`) se reconstruyen: texto antes de herramientas = `commentary`,
    texto final = `final_answer`.
  - La configuración de proveedores se lee una vez por minuto en cada instancia: un cambio en
    `ai_provider_config` o `ai_tier_fallbacks` tarda hasta un minuto en verse.
  - No se manda `safety_identifier` (OpenAI lo recomienda para identificar abusos sin bloquear toda la
    organización). Si alguna vez hace falta, se puede agregar un hash del id del usuario.
  - Los precios de OpenAI son del nivel Standard. Si el proyecto de OpenAI usa procesamiento regional (+10 %),
    Flex o Fast, corregí los precios en `ai_models`.

## 12. Proveedores: Anthropic (principal) y OpenAI (respaldo)

### Cómo funciona

Cada `POST` va primero al **proveedor principal** (Anthropic, con el pedido de siempre, sin ningún cambio). Si
falla por un problema **del proveedor**, el mismo pedido se traduce a la Responses API de OpenAI y se manda al
**proveedor secundario** con el modelo equivalente. La respuesta vuelve con la forma de Anthropic que espera el
launcher y con `served_by.failover = true`. La pregunta se cuenta una sola vez, en el modelo de Venus.

Solo se usa el respaldo si están `OPENAI_API_KEY`, la migración 0011 y `failover_enabled = true`, y si queda
tiempo (sección 11).

**Tabla de decisión** (qué falla del principal pasa el pedido al secundario; los tipos son los de
`ai_provider_config.failover_on`):

| Falla del principal | Código | Tipo | ¿Pasa al otro? |
|---|---|---|---|
| Límite de la organización (429) | `upstream_rate_limited` | `rate_limited` | Sí |
| Saturado (529) | `upstream_overloaded` | `overloaded` | Sí |
| Caído (500, 502, 503) | `upstream_unavailable` | `unavailable` | Sí |
| Plazo del proveedor (504) o del SDK, con tiempo de sobra | `upstream_timeout` | `timeout` | Sí |
| Error de conexión (después de los reintentos del SDK) | `upstream_network` | `network` | Sí |
| Sin crédito en la cuenta | `upstream_billing` | `billing` | Sí |
| Clave inválida (401) | `upstream_auth` | `auth` | Sí |
| Sin permiso (403) | `upstream_permission` | `permission` | Sí |
| Beta o parámetro del servidor no habilitado | `upstream_config` | `config` | Sí |
| Modelo que no existe o no está disponible (404) | `upstream_model` | `model` | Sí |
| Falta la clave del principal (`ANTHROPIC_API_KEY`) | `not_configured` | `not_configured` | Sí (directo al secundario) |
| Otro error desconocido | `upstream_error` | `unknown` | No (se puede activar) |
| Rechazo de la IA (`stop_reason: "refusal"`, o un rechazo de seguridad de OpenAI) | `refusal` (422) | — | **Nunca** |
| Pedido inválido (400, 413, 422) | `upstream_invalid_request` | — | **Nunca** |
| El launcher canceló | `aborted` | — | **Nunca** |
| Se venció el plazo de la función | `upstream_timeout` | — | No (no queda tiempo) |

Si los dos fallan: la respuesta es la falla del último proveedor que se probó, salvo que ese haya rechazado el
pedido traducido (400; queda como error en el log): ahí es la del primero. La pregunta nueva se devuelve si
ninguno la procesó.

### Qué modelo de OpenAI reemplaza a cada modelo de Venus

`public.ai_tier_fallbacks` (una fila por modelo de Venus):

| Modelo de Venus | Modelo de OpenAI | Por qué |
|---|---|---|
| `haiku` (Haiku 5.5) | `gpt-6-luna` (GPT-6 Luna) | El más eficiente de OpenAI, chico y rápido; mismo precio de lista. |
| `sonnet` (Sonnet 5.5) | `gpt-6-1-sol` (GPT-6.1 Sol) | Intermedio, cerca del más capaz; mismo precio de lista. |
| `opus` (Opus 5.5) | `gpt-6-astra` (GPT-6 Astra) | El más capaz de OpenAI (unas 2,5 veces el precio de Opus 5.5). |

El esfuerzo se traduce con `effort_low`, `effort_medium` y `effort_high` (por defecto `low`, `medium` y `high`,
que aceptan los cuatro modelos; GPT-6 Astra y GPT-6.1 Sol no aceptan `none`). Con `null` no se manda
`reasoning` (para un modelo sin razonamiento). `max_tokens` pasa como `max_output_tokens` (incluye el
razonamiento, como en Claude).

Qué se traduce: el `system` (política del servidor y system del launcher) va como `instructions`; los mensajes,
como items de la Responses API (`function_call` con `call_id` = el id del `tool_use`, `function_call_output` con
el mismo `call_id`, imágenes como `input_image`); las herramientas, como `function` tools con
`parameters` = `input_schema`; la tarea `json`, como `text.format` `json_schema` estricto. Los bloques
`thinking`, `redacted_thinking` y `fallback` de Anthropic se omiten. Se manda `store: false`.

### Cambiar el orden o apagar el respaldo

Todo se edita en la base (SQL Editor o Table Editor), sin volver a desplegar. Tarda hasta un minuto en verse.

```sql
-- Ver la configuración y los modelos de respaldo (lo mismo que lee la Edge Function)
select public.ai_provider_settings();

-- Apagar el respaldo (solo Anthropic, como antes)
update public.ai_provider_config set failover_enabled = false where id = 'default';

-- Volver a prenderlo
update public.ai_provider_config set failover_enabled = true where id = 'default';

-- OpenAI como principal y Anthropic de respaldo (y al revés para volver)
update public.ai_provider_config set primary_provider = 'openai', secondary_provider = 'anthropic' where id = 'default';
update public.ai_provider_config set primary_provider = 'anthropic', secondary_provider = 'openai' where id = 'default';

-- Sin proveedor secundario
update public.ai_provider_config set secondary_provider = null where id = 'default';

-- Qué fallas activan el respaldo (por ejemplo, solo saturación y caídas)
update public.ai_provider_config set failover_on = array['rate_limited', 'overloaded', 'unavailable', 'network'] where id = 'default';

-- Respaldo de Opus más barato: GPT-6.1 Sol en lugar de GPT-6 Astra
update public.ai_tier_fallbacks set model_id = 'gpt-6-1-sol' where tier = 'opus';

-- Sin respaldo para un modelo de Venus
update public.ai_tier_fallbacks set active = false where tier = 'opus';

-- Otro esfuerzo de OpenAI para el "high" de Venus en Opus
update public.ai_tier_fallbacks set effort_high = 'xhigh' where tier = 'opus';

-- Otro modelo de OpenAI: primero su fila de precio (solo precio, active = false) y después el mapeo
insert into public.ai_models (id, model_id, provider, label, input_usd_mtok, output_usd_mtok, cache_read_usd_mtok,
                              cache_write_usd_mtok, supports_fallback, price_note, sort, active)
values ('gpt-5-4-mini', 'gpt-5.4-mini', 'openai', 'GPT-5.4 mini (respaldo)', 0.75, 4.50, 0.075, 0.75, false,
        'Verificar en developers.openai.com/api/docs/pricing', 150, false);
update public.ai_tier_fallbacks set model_id = 'gpt-5-4-mini' where tier = 'haiku';
```

Con OpenAI como principal, Anthropic solo atiende cuando OpenAI falla (con la misma tabla de decisión) o, si
`failover_on` incluye `not_configured`, cuando OpenAI no tiene un modelo activo para esa pregunta. Sin
`ANTHROPIC_API_KEY`, todo va directo a OpenAI mientras `failover_on` incluya `not_configured`. Las tablas `ai_provider_config` y `ai_tier_fallbacks` solo las ve la
service role (el panel de administración y la Edge Function).

### Costo y uso del respaldo

```sql
-- Gasto del mes por proveedor (todas las cuentas)
select m.provider, sum(d.cost_usd) as usd, sum(d.calls) as llamadas
  from public.ai_usage_model_daily d
  join public.ai_models m on m.id = d.model_id
 where d.day >= date_trunc('month', public.ai_local_now())::date
 group by m.provider;

-- Probar el costo de una respuesta de OpenAI (entrada sin caché, salida, caché leída y escrita)
select public.ai_price_line(m, 500, 120, 2000, 500) from public.ai_models m where m.id = 'gpt-6-1-sol';  -- 0.00365
```

### Cómo lo ve el launcher

Nada cambia en el protocolo salvo `message.served_by` (sección 4): `{ provider, model, failover }`. El launcher
puede mostrar "Respondió el respaldo (OpenAI)" cuando `failover` es `true`. Hoy usa `message.model` como "modelo
que respondió", así que va a mostrar, por ejemplo, `gpt-6.1-sol`.

Para probar el respaldo en un proyecto de prueba: cargá `OPENAI_API_KEY`, poné una `ANTHROPIC_API_KEY` inválida
(responde 401 y pasa a OpenAI) y mandá un pedido: tiene que volver con `served_by.provider = "openai"` y
`failover = true`, y el log tiene que decir `respaldo: anthropic -> openai (upstream_auth)`. Después volvé a
cargar la clave buena.

## 13. Pruebas

```bash
node --test "supabase/functions/ai-assistant/tests/*.test.ts"
```

Cubren la validación (protocolos 1 y 2, modelo y esfuerzo), la cuota (QuotaV2, catálogo, respuestas de
`ai_register_turn`, uso por intento), el mapeo de errores, la política y el flujo HTTP completo con dobles de
Supabase, de Anthropic y de OpenAI. El doble de la base (`tests/fake-db.ts`) replica paso a paso las funciones
SQL de 0008 y 0011 para probar de punta a punta el plan vigente y la falta de plan, el modelo y el esfuerzo por
defecto, los cupos por modelo por día y por semana, el presupuesto, la pregunta atada a su modelo, el costo por
modelo (incluida la tarifa larga de Haiku, los reintentos en otro modelo y el costo de OpenAI en la fila de su
modelo) y la zona horaria. También replica 0013: las llamadas en curso (el tope de 3, la reserva y el vencimiento a
los 150 s), `ai_end_call` y el tope del presupuesto al cambiar de plan. `tests/migration.test.ts`,
`tests/providers-migration.test.ts` y `tests/budget-migration.test.ts` revisan el SQL de 0008, 0011 y 0013 sin
ejecutarlo: que la carga sea exactamente la tabla de planes y precios (y los precios y el mapeo de OpenAI), RLS,
`search_path` y permisos, que el JSON del SQL tenga las claves que lee la función y que las funciones que 0013
reemplaza conserven todo lo anterior. La estimación de los pedidos cortados (plazo, cancelación, conexión) está en
`tests/handler.test.ts`; el cálculo del tope, en `supabase/functions/billing/tests/budget-cap.test.ts`.

Del respaldo: `tests/openai.test.ts` prueba la traducción en los dos sentidos (mensajes, ciclos de
herramientas, llamadas en paralelo, imágenes, esquemas estrictos, salida estructurada, uso y errores),
`tests/providers.test.ts` la tabla de decisión y el orden de los proveedores, y `tests/failover.test.ts` el
flujo completo: qué fallas pasan a OpenAI y cuáles no (el rechazo nunca), las claves que faltan, OpenAI como
principal, los dos caídos, el plazo, el costo exacto y un ciclo de herramientas que va de OpenAI a Anthropic y
vuelve con los mismos ids.

`tests/index.e2e.test.ts` corre además el `index.ts` real con los SDK del launcher contra un `fetch` falso (sin
red): verifica el modelo que sale de la base, el beta y `fallbacks` (nunca con Haiku), la caché, el `effort`, la
salida estructurada, el registro del uso por intento, los errores tipados del SDK y, con `OPENAI_API_KEY`, el
pedido exacto a la Responses API y la respuesta traducida. El paquete `openai` no está en el repositorio: la
prueba usa un doble con la misma superficie (`tests/fake-openai-sdk.ts`); para correrla con el SDK real, apuntá
`VENUS_OPENAI_SDK` al `index.mjs` de un paquete `openai` 7.x instalado en otro lado:

```bash
VENUS_OPENAI_SDK=/ruta/a/node_modules/openai/index.mjs node --test supabase/functions/ai-assistant/tests/index.e2e.test.ts
```

**Las funciones SQL no se ejecutan en estas pruebas** (no hay Postgres en el repositorio): se revisaron a mano.
Antes de abrir el asistente a todos, probalas una vez en un proyecto de prueba con un usuario de prueba:

```sql
-- Asignar un plan y abrir una pregunta con Sonnet
insert into public.ai_subscriptions (user_id, plan_id) values ('<uuid de prueba>', 'pro')
on conflict (user_id) do update set plan_id = excluded.plan_id, status = 'active';
select public.ai_register_turn('<uuid de prueba>', 'prueba-1', 'sonnet', null);   -- allowed, effort medium
select public.ai_register_turn('<uuid de prueba>', 'prueba-1', 'haiku', null);    -- turn_model
select public.ai_register_turn('<uuid de prueba>', 'prueba-2', 'opus', null);     -- model (Pro no tiene Opus)
select public.ai_add_usage('<uuid de prueba>', 'sonnet',
  '[{"model": "claude-sonnet-5-5", "input": 1000, "output": 500, "cacheRead": 0, "cacheWrite": 0}]');  -- costUsd 0.007
select public.ai_quota_status('<uuid de prueba>');

-- 0011: configuración de proveedores y costo de una respuesta del respaldo
select public.ai_provider_settings();  -- primary anthropic, secondary openai, openai.sonnet.model gpt-6.1-sol
select public.ai_add_usage('<uuid de prueba>', 'sonnet',
  '[{"model": "gpt-6.1-sol", "input": 500, "output": 120, "cacheRead": 2000, "cacheWrite": 500}]');  -- costUsd 0.00365
select model_id, questions, calls, cost_usd from public.ai_usage_model_daily
 where user_id = '<uuid de prueba>' and day = public.ai_local_now()::date;  -- sonnet con la pregunta; gpt-6-1-sol con la llamada
```
