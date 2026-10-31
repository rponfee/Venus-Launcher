# Edge Functions de Venus Launcher

| Función | Para qué | Migraciones que necesita | Documentación |
|---|---|---|---|
| `ai-assistant` | Puerta de la IA del launcher: verifica la sesión, aplica el plan del usuario (modelos, esfuerzos, preguntas por día y por semana y presupuesto mensual) y llama a Claude (Anthropic, principal) con la clave del servidor; si Anthropic falla por un problema del proveedor, pasa el pedido a ChatGPT (OpenAI, secundario). | `supabase/migrations/0007_ai.sql`, después `0008_ai_plans.sql` y, para el respaldo, `0011_ai_providers.sql` | [docs/backend-ia.md](../../docs/backend-ia.md) |
| `admin` | Panel de administración del launcher: en cada pedido vuelve a verificar la sesión, que el email esté confirmado y que el usuario siga siendo admin. Maneja usuarios (planes, baneos, silencios, sesiones, uso y borrar cuentas), cupones y códigos de promoción de Stripe, el precio de los planes y el registro de acciones. Se despliega con la verificación de JWT activada y lleva los archivos compartidos `billing/config.ts`, `billing/http.ts` y `billing/stripe.ts` (los imports `../billing/` se resuelven al empaquetar). Secretos: `STRIPE_SECRET_KEY` (opcional: sin ella, cupones, precios y cancelaciones responden "no configurado") y `BILLING_PORTAL_CONFIGURATION` (opcional). | `supabase/migrations/0012_admin.sql` (después de 0011; usa 0001, 0002, 0007, 0008 y 0009) | [docs/admin.md](../../docs/admin.md) |

## Antes de empezar

1. Instalá la [Supabase CLI](https://supabase.com/docs/guides/cli) e iniciá sesión: `supabase login`.
2. Vinculá la carpeta del proyecto con tu proyecto de Supabase: `supabase link --project-ref <ref>` (el `ref` está en la URL del panel: `https://supabase.com/dashboard/project/<ref>`).
3. Aplicá las migraciones en orden (ver [docs/supabase.md](../../docs/supabase.md)). Para el asistente hacen falta `0007_ai.sql` y `0008_ai_plans.sql`, en ese orden, y para el respaldo en OpenAI, `0011_ai_providers.sql` (después de 0008).

## Desplegar `ai-assistant`

```bash
# 1. Claves (quedan guardadas en Supabase; nunca van en el código ni en el launcher)
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...   # principal: Claude
supabase secrets set OPENAI_API_KEY=sk-...          # secundaria: ChatGPT, el respaldo (opcional)

# 2. Desplegar (la verificación de JWT queda activada, que es lo que corresponde)
supabase functions deploy ai-assistant
```

- **Respaldo**: si Anthropic falla por un problema del proveedor (429, 529, 5xx, red, plazo del proveedor, sin crédito, clave, permisos, beta o modelo no disponible, o falta `ANTHROPIC_API_KEY`), la función traduce el pedido a la Responses API de OpenAI y lo manda con el modelo equivalente (`ai_tier_fallbacks`); la respuesta vuelve con la forma de siempre y `message.served_by = { provider, model, failover }`. Nunca pasa al otro proveedor un rechazo de la IA, un pedido inválido (400) ni una cancelación. Sin `OPENAI_API_KEY` o sin 0011, solo Anthropic, como antes. Orden de los proveedores, qué fallas activan el respaldo y cómo apagarlo: [docs/backend-ia.md](../../docs/backend-ia.md), sección 12.

- Desplegá enseguida después de aplicar `0008_ai_plans.sql`: mientras tanto, una versión vieja de la función rechaza todos los pedidos (a propósito, para que no gaste fuera del presupuesto). Al revés, la función nueva sin la migración 0008 responde `backend_not_ready`.
- No hay plan gratis: para usar la IA, cada usuario necesita una fila en `ai_subscriptions` (a mano o, cuando exista, desde el webhook de pagos). Ver [docs/backend-ia.md](../../docs/backend-ia.md), secciones 7 y 8.
- `SUPABASE_URL`, `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY` los inyecta Supabase solo: no hay que cargarlos.
- **No** despliegues con `--no-verify-jwt`. La función igual verifica la sesión por su cuenta (`auth.getUser`), así que la única excepción es un proyecto que usa las claves de firma JWT nuevas (asimétricas) y en el que la puerta de Supabase rechaza sesiones válidas con 401: ahí sí se puede desplegar con `--no-verify-jwt`.
- Secretos opcionales:

| Secreto | Por defecto | Para qué |
|---|---|---|
| `OPENAI_API_KEY` | sin cargar | Clave de OpenAI para el respaldo (proveedor secundario). Sin ella, solo Anthropic. Conviene un proyecto de OpenAI dedicado, con límite de gasto. |
| `AI_UPSTREAM_TIMEOUT_MS` | `140000` | Cuánto se espera a la IA (entre 10000 y 390000), para los dos proveedores juntos: el respaldo solo se prueba si quedan al menos 15 s. Supabase corta a los 150 s sin respuesta, así que no conviene subirlo. |
| `AI_REQUIRE_CONFIRMED_EMAIL` | apagado | Con `1`, solo pueden usar la IA las cuentas con el email confirmado. |

Para ver los errores: panel de Supabase → **Edge Functions → ai-assistant → Logs**. Los logs nunca incluyen el contenido de las conversaciones: solo códigos (`upstream_rate_limited`, `quota_unavailable`...), estados HTTP, el proveedor y su `request_id` (`provider=anthropic` u `openai`), los avisos de respaldo (`respaldo: anthropic -> openai (upstream_overloaded)`, `sin tiempo para el respaldo`, `no se pudo leer la configuración de proveedores`) y el aviso `modelo sin precio` si un intento corrió en un modelo que no está en `ai_models`.

## Probar contra el proyecto

Con el token de acceso de un usuario de prueba que tenga un plan (por ejemplo el que devuelve `POST /auth/v1/token?grant_type=password`):

```bash
# Estado del plan y catálogo de planes (no llama a la IA)
curl "$SUPABASE_URL/functions/v1/ai-assistant" \
  -H "Authorization: Bearer $USER_TOKEN" -H "apikey: $SUPABASE_ANON_KEY"

# Una consulta de texto con el modelo por defecto del plan (protocolo 1: sin "model")
curl "$SUPABASE_URL/functions/v1/ai-assistant" \
  -H "Authorization: Bearer $USER_TOKEN" -H "apikey: $SUPABASE_ANON_KEY" -H "Content-Type: application/json" \
  -d '{"task":"text","messages":[{"role":"user","content":"Decí hola"}],"max_tokens":2000,"effort":"low","client":{"app":"venus-launcher","protocol":1}}'

# Eligiendo el modelo (protocolo 2): tiene que estar en el plan del usuario
curl "$SUPABASE_URL/functions/v1/ai-assistant" \
  -H "Authorization: Bearer $USER_TOKEN" -H "apikey: $SUPABASE_ANON_KEY" -H "Content-Type: application/json" \
  -d '{"task":"text","model":"sonnet","messages":[{"role":"user","content":"Decí hola"}],"client":{"app":"venus-launcher","protocol":2}}'
```

Sin plan, la respuesta es `402` con `{ "error": "noplan", "quota": ..., "plans": [...] }`; con un modelo o un esfuerzo que el plan no tiene, `403` con `{ "error": "plan", "reason": "model" | "effort" }`.

En local: `supabase start`, después `supabase functions serve ai-assistant --env-file <archivo con ANTHROPIC_API_KEY y, si querés el respaldo, OPENAI_API_KEY>` y las mismas llamadas contra `http://127.0.0.1:54321`. Para probar el respaldo, poné una `ANTHROPIC_API_KEY` inválida: la respuesta tiene que traer `"served_by": { "provider": "openai", ..., "failover": true }`.

## Pruebas automáticas (sin Deno ni Postgres)

La lógica de la función (validación, cuotas, errores, política, la traducción a OpenAI, el respaldo y el flujo HTTP completo con dobles de Supabase, de Anthropic y de OpenAI) está en archivos `.ts` sin dependencias, que Node corre directamente. El doble de la base (`tests/fake-db.ts`) replica las funciones SQL de 0008 y 0011 para probar planes, modelos, esfuerzos, cupos por día y por semana, presupuesto y costos (también los de OpenAI) de punta a punta; `tests/migration.test.ts` y `tests/providers-migration.test.ts` revisan el SQL de 0008 y 0011 sin ejecutarlo (carga de planes y precios, precios y mapeo de OpenAI, RLS, `search_path`, permisos y las claves del JSON). `tests/openai.test.ts`, `tests/providers.test.ts` y `tests/failover.test.ts` prueban la traducción en los dos sentidos, la tabla de decisión del respaldo y el flujo completo con los dos proveedores. Además, `tests/index.e2e.test.ts` corre el `index.ts` real con los paquetes `@anthropic-ai/sdk` y `@supabase/supabase-js` del launcher (los de `node_modules`) contra un `fetch` falso, sin red, y revisa los pedidos exactos que salen hacia Supabase, Anthropic y OpenAI (si faltan los paquetes, se saltea). El paquete `openai` no está en el repositorio: la prueba usa un doble con la misma superficie (`tests/fake-openai-sdk.ts`), o el SDK real si `VENUS_OPENAI_SDK` apunta al `index.mjs` de un paquete `openai` 7.x instalado en otro lado:

```bash
node --test "supabase/functions/ai-assistant/tests/*.test.ts"
```

(Con Node 24, el mismo que usa el proyecto: corre los `.ts` sin compilar. El aviso `MODULE_TYPELESS_PACKAGE_JSON` es solo informativo; se puede ocultar con `--disable-warning=MODULE_TYPELESS_PACKAGE_JSON`.)

Las funciones SQL no se ejecutan en estas pruebas: probalas una vez en un proyecto de prueba (los pasos están al final de [docs/backend-ia.md](../../docs/backend-ia.md)).

## Estructura de `ai-assistant/`

| Archivo | Qué hace |
|---|---|
| `index.ts` | Entrada (`Deno.serve`). Crea los clientes de Supabase y los SDK de Anthropic y de OpenAI y se los pasa al handler. Único archivo con imports `npm:`. |
| `handler.ts` | Flujo HTTP: CORS, sesión, cuerpo, validación, plan y cuota, llamada a la IA (con el respaldo entre proveedores), uso y errores. |
| `providers.ts` | Configuración de proveedores (`ai_provider_settings`), orden de los intentos y tabla de decisión del respaldo. |
| `openai.ts` | Traducción entre el formato de Anthropic y la Responses API de OpenAI (pedido, respuesta, uso, esquemas estrictos y errores). |
| `validate.ts` | Validación estricta del cuerpo (protocolos 1 y 2). |
| `quota.ts` | Lectura de la cuota (QuotaV2), del catálogo y de las funciones SQL; recorte de `max_tokens`; uso por intento; respuestas de rechazo. |
| `errors.ts` | Traduce las fallas de los proveedores a respuestas seguras. |
| `policy.ts` | Política fija del servidor que va primero en el system de cada pedido. |
| `config.ts` | Constantes: protocolos, modelos que acepta el protocolo, herramientas permitidas y su nivel de permiso, límites, CORS. |
| `tests/` | Pruebas con `node:test` (incluye `fake-db.ts`, `owner-plans.ts` y `fake-openai-sdk.ts`, que son solo para las pruebas). No se despliegan (no las importa `index.ts`). |
