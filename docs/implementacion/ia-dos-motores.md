# Venus IA con dos motores: planes de Claude y planes de ChatGPT

Contrato de la versión 6.1. Reemplaza el esquema de "OpenAI único proveedor" de la 6.0.0 (migración 0049). La base
la cambia `supabase/migrations/0056_ia_dos_motores.sql`; el servidor, `supabase/functions/ai-assistant` y `payments`; el
launcher, `src/main/modules/ai.js`, `assistant/*`, `billing*` y `src/renderer/js/features/plans*.js`.

## 1. Idea

- Hay **dos familias de planes**: `anthropic` (se muestra "Claude") y `openai` (se muestra "ChatGPT"). Cada plan es de
  una sola familia y cada compra da **saldo en dólares de esa API**, que no vence.
- Una cuenta puede tener **un saldo por familia** a la vez (comprar Claude no toca el saldo de ChatGPT y al revés).
  Comprar otro plan de la misma familia suma lo que quedaba (como siempre).
- Siempre hay **un saldo en uso**. Cuando ese saldo ya no alcanza para una llamada y el otro sí, el servidor **pasa solo
  al otro** y lo avisa en la respuesta (`switched`). El usuario también puede elegir a mano cuál usar.
- Las claves de las dos APIs las carga un administrador en **Administración → Integraciones** (Vault). Nunca van al
  launcher ni al repositorio.

## 2. Planes (precio, saldo y límites)

| Plan (`id`) | Familia | `tier` | Precio USD | Saldo USD | Tokens por respuesta | Modelos (clave) | Esfuerzos |
|---|---|---|---|---|---|---|---|
| `claude_basic` | anthropic | basic | 6 | 3,50 | 12.000 | haiku | low, medium |
| `claude_go` | anthropic | go | 10 | 6,75 | 32.000 | haiku | low, medium, high |
| `claude_pro` | anthropic | pro | 18 | 12,50 | 44.000 | haiku, sonnet | low, medium, high |
| `claude_max` | anthropic | max | 32 | 26 | 78.000 | haiku, sonnet | low, medium, high, xhigh |
| `claude_ultra` | anthropic | ultra | 40 | 32 | 128.000 | haiku, sonnet | low, medium, high, xhigh, max |
| `basic` | openai | basic | 6 | 3,50 | 12.000 | haiku | low |
| `go` | openai | go | 10 | 6,75 | 32.000 | haiku | low, medium, high |
| `pro` | openai | pro | 18 | 12,50 | 44.000 | haiku | low, medium, high |
| `max` | openai | max | 32 | 26 | 78.000 | haiku, sonnet | low, medium, high |
| `ultra` | openai | ultra | 40 | 28 | 128.000 | haiku, sonnet | low, medium, high |

Los planes de ChatGPT conservan los ids de la 6.0.0 (`basic`, `go`, `pro`, `max`): quien ya compró sigue igual, con su
saldo. `name` es el del nivel ("Basic", "Go"...); la interfaz antepone la familia ("Claude Pro", "ChatGPT Pro").

### Claves de modelo

El protocolo sigue usando las claves `haiku` (modelo rápido) y `sonnet` (modelo avanzado). **El modelo real lo decide la
familia del plan**:

| Clave | Familia anthropic | Familia openai |
|---|---|---|
| `haiku` | `claude-haiku-5-5` · "Haiku 5.5" | `gpt-6-luna` · "GPT-6 Luna" |
| `sonnet` | `claude-sonnet-5-5` · "Sonnet 5.5" | `gpt-5.6-sol` · "GPT-5.6 Sol" |

El launcher nunca arma el nombre del modelo: muestra `label` de la cuota. Esfuerzo nuevo: `max` (además de `low`,
`medium`, `high`, `xhigh`).

## 3. Base de datos (0056)

- `ai_plans.ai_provider` (`anthropic` | `openai`) y `ai_plans.tier` (`basic` … `ultra`; `null` en los planes viejos, que
  no se venden ni valen). `max_tokens_per_request` admite hasta 128.000.
- `ai_wallets (user_id, ai_provider, plan_id, period_id)`: el saldo de cada familia (clave `user_id, ai_provider`).
  `ai_subscriptions` sigue siendo **el saldo en uso** (lo leen todas las funciones de antes).
- Claves: `admin_anthropic_status()`, `admin_set_anthropic_key(p_key)` (admins, como las de OpenAI) y
  `ai_anthropic_key()` (solo `service_role`). Secreto de Vault: `venus_anthropic_key`.
- `ai_use_wallet(p_provider text)` (usuario con sesión): elige qué saldo usar. Devuelve la cuota.
- `ai_register_turn(p_user, p_turn, p_model, p_effort, p_max_tokens integer default null, p_input_bytes integer default null)`:
  los dos parámetros nuevos ajustan la reserva al pedido real (antes reservaba el peor caso del plan). Si el saldo no
  alcanza para el `max_tokens` pedido, **lo baja** hasta lo que alcanza (mínimo 2.048) en vez de rechazar. En una
  pregunta ya abierta (mismo `turn_id`), un modelo o un esfuerzo que el plan en uso no tiene (porque una llamada
  anterior pasó al otro saldo) **se ajusta** a ese plan en vez de rechazarse: el launcher puede seguir mandando el
  modelo y el esfuerzo del principio del turno.
- Un plan dado a mano por un administrador (`source = 'admin'`) que sigue vigente **no se reemplaza** por un saldo
  pagado (`private.ai_wallet_activate` devuelve `false`): ni el cambio automático (si se agota, `budget` hasta el mes
  siguiente) ni `ai_use_wallet` (`no_wallet`). Cuando vence o se quita, el saldo pagado se usa solo.
- Pagos: una compra suma **todo** lo que quedaba en el saldo del mismo motor, y las llamadas en curso de ese saldo pasan
  al período nuevo (se cierran y se cobran ahí).
- Panel: **Quitar plan** (`admin_remove_plan`) también borra los saldos de la cuenta (`ai_wallets`; los períodos pagados
  quedan como historial), así la llamada siguiente responde `noplan`. El Resumen (`admin_overview`) cuenta todos los
  planes con nivel (los de Claude y los Ultra incluidos).
- `ai_add_usage(p_user, p_model, p_usage, p_call uuid default null)` y `ai_end_call(p_user, p_call uuid default null)`:
  con `p_call` (el `callId` de `ai_register_turn`) cierran **esa** llamada. Hace falta porque con dos saldos puede haber
  llamadas simultáneas pagadas por saldos distintos; sin `p_call` se comportan como en la 6.0.0 (la más vieja).
- **Motor listo** (`private.ai_provider_ready`): un motor está listo cuando su clave está cargada en Vault (desde
  Administración → Integraciones). Los planes de un motor que no está listo salen con `available: false` en el catálogo y
  sin precio en `payments_catalog()` (no se pueden comprar), y el cambio automático de saldo nunca elige ese motor. La
  variable de entorno de la función sirve de respaldo para responder, pero no habilita la venta.
- Soporte: el formulario de "Asistente IA" (`private.support_details_clean`) acepta los diez planes.

### Respuesta de `ai_register_turn`

```json
{
  "allowed": true, "callId": "uuid", "reason": null,
  "model": "sonnet",
  "provider": "anthropic",
  "modelId": "claude-sonnet-5-5",
  "models": { "anthropic": "claude-sonnet-5-5", "openai": "gpt-5.6-sol" },
  "openaiEffort": "high",
  "effort": "high", "counted": true, "fallback": false,
  "maxTokensPerRequest": 44000,
  "switched": null,
  "quota": { }
}
```

- `provider`: la familia del saldo que paga esta llamada. La Edge Function llama **a ese proveedor**.
- `models`: el id de la API de la clave en cada proveedor. El modelo de la llamada es `models[provider]`
  (`models.openai` es `null` si ese motor no ofrece la clave). `modelId` queda por compatibilidad con la función de la
  6.0.0 y es **siempre el id de Claude** de la clave, también cuando `provider` es `openai`.
- `openaiEffort`: `reasoning.effort` para OpenAI (`null` = no mandarlo).
- `maxTokensPerRequest`: tope **de esta llamada** (ya recortado al plan, al pedido y al saldo).
- `switched`: `null` o `{ "from": "anthropic", "to": "openai", "reason": "budget" | "noplan" }` cuando en esta llamada
  el servidor pasó al otro saldo. `reason` `budget` = el saldo en uso no alcanzaba; `noplan` = el plan en uso dejó de
  valer (por ejemplo, una devolución).
- Rechazos (`allowed: false`): los de siempre (`noplan`, `model`, `effort`, `turn_model`, `rate`, `budget`, `turn`,
  `daily`, `weekly`). `budget` ahora significa que **ningún** saldo alcanza.

### Cuota (QuotaV3 = QuotaV2 + campos nuevos)

```json
{
  "plan": "claude_pro", "planName": "Pro", "priceUsd": 18, "status": "active",
  "provider": "anthropic", "tier": "pro",
  "maxTokensPerRequest": 44000,
  "models": [
    { "id": "haiku", "model": "claude-haiku-5-5", "providerModel": "claude-haiku-5-5", "label": "Haiku 5.5",
      "efforts": ["low", "medium", "high"],
      "daily": { "used": 0, "limit": 2147483647 }, "weekly": { "used": 0, "limit": 2147483647 } }
  ],
  "budget": { "usedUsd": 1.2, "limitUsd": 12.5 },
  "wallets": [
    { "provider": "anthropic", "plan": "claude_pro", "planName": "Pro", "tier": "pro",
      "usedUsd": 1.2, "limitUsd": 12.5, "remainingUsd": 11.3, "active": true },
    { "provider": "openai", "plan": "go", "planName": "Go", "tier": "go",
      "usedUsd": 6.7, "limitUsd": 6.75, "remainingUsd": 0.05, "active": false }
  ],
  "resets": { "daily": "…", "weekly": "…", "monthly": null }, "timezone": "…", "lastModel": "haiku"
}
```

`models[].model` es siempre el id de Claude de la clave (compatibilidad con la 6.0.0); el id real del motor del plan es
`models[].providerModel` (en un plan de ChatGPT: `gpt-6-luna` o `gpt-5.6-sol`) y `label` es el nombre de ese modelo real.

`wallets` lista los saldos válidos de la cuenta (0, 1 o 2), el que está en uso con `active: true`. Un plan dado a mano
por un administrador (`source = 'admin'`) no es un saldo: `wallets` no lo incluye y `provider` sale del plan.

### Catálogo (`ai_catalog()` y dentro de `payments_catalog().plans`)

Cada plan suma `provider`, `tier`, `available` (si el motor tiene su clave cargada) y los `label` de sus modelos según
la familia:

```json
{ "id": "claude_pro", "name": "Pro", "provider": "anthropic", "tier": "pro", "available": true, "priceUsd": 18, "budgetUsd": 12.5,
  "maxTokensPerRequest": 44000,
  "models": [{ "id": "haiku", "label": "Haiku 5.5", "efforts": ["low", "medium", "high"], "daily": 2147483647, "weekly": 2147483647 }] }
```

`payments_catalog().clans` queda en `[]` (las Comunidades se retiraron).

## 4. Edge Function `ai-assistant`

- Las dos claves salen de Vault (`ai_openai_key`, `ai_anthropic_key`); las variables `OPENAI_API_KEY` y
  `ANTHROPIC_API_KEY` quedan como respaldo opcional.
- Proveedor de cada llamada = `provider` de `ai_register_turn`. Si ese proveedor no tiene clave: `503 not_configured`
  (la pregunta se devuelve).
- Manda a `ai_register_turn` el `max_tokens` pedido (ya recortado a `LIMITS`) y el tamaño del cuerpo.
- Cierra cada llamada con su `callId` (`p_call` en `ai_add_usage` y `ai_end_call`).
- Una llamada que se corta sin respuesta (plazo vencido, cancelación del launcher, conexión cortada) se cobra estimada:
  la entrada entera y la salida que pudo generar en lo que duró ese intento (400 tokens por segundo,
  `ESTIMATE_OUTPUT_TOKENS_PER_SECOND`), nunca más que `max_tokens`. Si el launcher canceló antes de que el pedido
  saliera hacia un proveedor, no se cobra nada: la pregunta se devuelve y responde `503 aborted`.
- Respuesta 200: igual que antes, más `switched` (el mismo objeto, o ausente) en el nivel superior. `served_by` sigue
  diciendo quién respondió. Los errores con `quota` también llevan `switched` si lo hubo.
- Esfuerzo `max` aceptado en el protocolo.

## 5. Launcher

- Planes: dos familias (Claude / ChatGPT) con los cinco niveles; el pago manda el `id` del plan.
- El Asistente y el resto de las funciones con IA muestran una vez el aviso cuando llega `switched`:
  "Se terminó tu saldo de Claude. Ahora estás usando tu saldo de ChatGPT." (y al revés).
- Con dos saldos, el usuario elige cuál usar (`ai_use_wallet`).
- Administración → Integraciones: tarjeta **Claude (Anthropic)** igual a la de OpenAI.

## 6. Orden para publicar

1. Aplicar `0056_ia_dos_motores.sql`.
2. Desplegar `ai-assistant` y `payments` (y `admin` si cambió la validación de planes).
3. Cargar la clave de Claude en Administración → Integraciones.
4. Publicar el launcher 6.1.

Hasta el paso 3, los planes de Claude aparecen como "todavía no disponibles" y no se pueden comprar: se habilitan solos
cuando se carga la clave.
