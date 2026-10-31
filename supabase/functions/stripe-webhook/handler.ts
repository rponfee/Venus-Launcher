// Flujo HTTP de la Edge Function "stripe-webhook" (eventos de Stripe, ver docs/pagos.md).
// 1. Verifica la firma (Stripe-Signature) sobre el cuerpo crudo: sin firma válida no se procesa nada.
// 2. Idempotencia por id de evento (public.billing_begin_event / billing_finish_event).
// 3. Por cada evento vuelve a LEER la suscripción de Stripe y guarda esa foto (sync.ts), así el orden de los
//    eventos no importa. Nunca registra el cuerpo de los eventos ni datos de tarjetas: solo ids y códigos.
// Respuestas: 2xx = recibido (Stripe no reintenta); 400 = firma o cuerpo inválidos; 500 = falla temporal
// (base o API de Stripe): Stripe reintenta el mismo evento durante hasta 3 días.
// No importa nada de npm ni de Deno: index.ts le pasa Supabase y el cliente de Stripe; las pruebas, dobles.
import { HANDLED_EVENTS, LIMITS, returnPage } from '../billing/config.ts';
import { decodeUtf8, errorCode, errorName, json, readBodyBytes } from '../billing/http.ts';
import { StripeError, stripePath } from '../billing/stripe.ts';
import type { StripeClient } from '../billing/stripe.ts';
import { applySubscription, asUserId, createPriceMapLoader, idOf, subscriptionIdFromEvent, userIdFromMetadata } from '../billing/sync.ts';
import type { Logger, PriceMap } from '../billing/sync.ts';
import { verifyStripeSignature } from './signature.ts';

const TAG = 'stripe-webhook';

export interface WebhookDeps {
  /** Secretos de firma (STRIPE_WEBHOOK_SECRET; puede haber más de uno). */
  secrets: string[];
  /** Cliente de la API de Stripe (null si falta STRIPE_SECRET_KEY). */
  stripe: StripeClient | null;
  /** Modo de la clave de Stripe (true = producción); null si no se sabe. */
  livemode: boolean | null;
  /** Están SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY. */
  dbReady: boolean;
  graceDays: number;
  /** Llama a una función SQL con la service role. Si falla lanza un error con `code`. */
  rpc(name: string, args: Record<string, unknown>): Promise<unknown>;
  priceMap?: (force?: boolean) => Promise<PriceMap>;
  nowMs?: () => number;
  logger?: Logger;
}

type Obj = Record<string, unknown>;

/** Falla temporal: se responde 500 para que Stripe reintente. */
class RetryLater extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'RetryLater';
  }
}

function obj(value: unknown): Obj | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : null;
}

async function processEvent(event: Obj, deps: WebhookDeps, logger: Logger, priceMap: (force?: boolean) => Promise<PriceMap>): Promise<string> {
  const type = String(event.type);
  const object = obj(obj(event.data)?.object) ?? {};
  const livemode = event.livemode === true;
  let fallbackUserId: string | null = null;

  if (type === 'checkout.session.completed') {
    if (object.mode !== 'subscription') return 'ignored_mode';
    // client_reference_id lo pone billing con el id del usuario; también queda el cliente asociado.
    fallbackUserId = asUserId(object.client_reference_id) ?? userIdFromMetadata(object);
    const customer = idOf(object.customer);
    if (fallbackUserId && customer && /^cus_[A-Za-z0-9_]{1,250}$/.test(customer)) {
      try {
        await deps.rpc('billing_link_customer', { p_user: fallbackUserId, p_customer: customer, p_livemode: livemode, p_replace: false });
      } catch (err) {
        if (errorCode(err) !== '23505') throw new RetryLater(`billing_link_customer: ${errorCode(err)}`);
        logger.warn(`[${TAG}] el cliente ${customer} ya está asociado a otro usuario`);
      }
    }
  }

  const subscriptionId = subscriptionIdFromEvent(event);
  if (!subscriptionId) return 'no_subscription';

  const stripe = deps.stripe as StripeClient;
  const syncedAt = new Date(deps.nowMs ? deps.nowMs() : Date.now());
  let sub: Obj;
  try {
    sub = await stripe.get<Obj>(stripePath('/v1/subscriptions/', subscriptionId), { expand: ['latest_invoice'] });
  } catch (err) {
    if (err instanceof StripeError && err.missing) {
      logger.warn(`[${TAG}] la suscripción ${subscriptionId} no existe para esta clave de Stripe (¿modo de prueba vs. producción?)`);
      return 'subscription_missing';
    }
    if (err instanceof StripeError && err.status === 400) {
      // Pedido rechazado: reintentar el mismo evento no lo arregla.
      logger.error(`[${TAG}] Stripe rechazó la lectura de ${subscriptionId}: ${err.describe()}`);
      return 'stripe_rejected';
    }
    // Red, plazo, Stripe caído o saturado, o clave inválida (401/403, se arregla cargando la correcta).
    if (err instanceof StripeError) throw new RetryLater(`Stripe: ${err.describe()}`);
    throw err;
  }

  return applySubscription(sub, {
    rpc: deps.rpc,
    priceMap,
    graceDays: deps.graceDays,
    nowMs: deps.nowMs ? deps.nowMs() : Date.now(),
    syncedAt,
    fallbackUserId,
    logger,
    tag: TAG,
  });
}

async function handle(req: Request, deps: WebhookDeps, logger: Logger, priceMap: (force?: boolean) => Promise<PriceMap>): Promise<Response> {
  // La página de vuelta de Checkout y del portal (pública; ver config.ts, buildReturnUrls).
  const page = returnPage(req);
  if (page) return page;
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' }, { Allow: 'POST' });

  if (!deps.secrets.length || !deps.stripe || !deps.dbReady) {
    logger.error(`[${TAG}] faltan secretos: STRIPE_WEBHOOK_SECRET, STRIPE_SECRET_KEY o las claves de Supabase`);
    return json(500, { error: 'not_configured' });
  }

  const read = await readBodyBytes(req, LIMITS.webhookBodyBytes);
  if (!read.ok) return json(read.reason === 'too_large' ? 413 : 400, { error: 'bad_body' });

  const verified = await verifyStripeSignature(read.bytes, req.headers.get('stripe-signature'), deps.secrets, {
    toleranceSec: LIMITS.signatureToleranceSec,
    nowMs: deps.nowMs ? deps.nowMs() : Date.now(),
  });
  if (!verified.ok) {
    logger.warn(`[${TAG}] firma rechazada: ${verified.reason}`);
    return json(400, { error: 'invalid_signature' });
  }

  const text = decodeUtf8(read.bytes);
  let event: Obj | null = null;
  try {
    event = text === null ? null : obj(JSON.parse(text));
  } catch {
    event = null;
  }
  const id = typeof event?.id === 'string' ? event.id : '';
  const type = typeof event?.type === 'string' ? event.type : '';
  if (!event || !/^evt_[A-Za-z0-9_]{1,250}$/.test(id) || !type || type.length > 100 || !obj(obj(event.data)?.object)) {
    logger.warn(`[${TAG}] evento con formato inválido`);
    return json(400, { error: 'bad_event' });
  }

  if (!HANDLED_EVENTS.has(type)) return json(200, { received: true, ignored: 'event_type' });
  if (deps.livemode !== null && (event.livemode === true) !== deps.livemode) {
    logger.warn(`[${TAG}] ${id} ${type}: el evento es de ${event.livemode === true ? 'producción' : 'prueba'} y la clave de Stripe no`);
    return json(200, { received: true, ignored: 'livemode' });
  }

  let claim: unknown;
  try {
    claim = await deps.rpc('billing_begin_event', { p_id: id, p_type: type, p_livemode: event.livemode === true });
  } catch (err) {
    logger.error(`[${TAG}] ${id}: falla de la base (${errorCode(err)})`);
    return json(500, { error: 'db_unavailable' });
  }
  if (claim === 'duplicate') return json(200, { received: true, duplicate: true });

  let outcome: string;
  try {
    outcome = await processEvent(event, deps, logger, priceMap);
  } catch (err) {
    const detail = err instanceof RetryLater ? err.message : `${errorName(err)} ${errorCode(err)}`;
    logger.error(`[${TAG}] ${id} ${type}: se reintentará (${detail})`);
    return json(500, { error: 'retry' });
  }

  try {
    await deps.rpc('billing_finish_event', { p_id: id, p_outcome: outcome });
  } catch (err) {
    // Ya quedó guardado; si Stripe lo reenvía se procesa otra vez sin problema.
    logger.warn(`[${TAG}] ${id}: no se pudo marcar como procesado (${errorCode(err)})`);
  }
  logger.info?.(`[${TAG}] ${id} ${type}: ${outcome}`);
  return json(200, { received: true, outcome });
}

/** Handler para Deno.serve. */
export function createWebhookHandler(deps: WebhookDeps): (req: Request) => Promise<Response> {
  const logger: Logger = deps.logger ?? console;
  const priceMap = deps.priceMap ?? createPriceMapLoader(deps.rpc, LIMITS.priceMapTtlMs, deps.nowMs ?? Date.now);
  return async (req: Request): Promise<Response> => {
    try {
      return await handle(req, deps, logger, priceMap);
    } catch (err) {
      logger.error(`[${TAG}] error interno: ${errorName(err)}`);
      return json(500, { error: 'internal' });
    }
  };
}
