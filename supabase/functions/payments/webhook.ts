// Parte pública de la Edge Function "payments": avisos de Mercado Pago y PayPal, y las páginas a las que vuelve el
// navegador después de pagar. Nada de lo que llega se cree: con el id que trae se consulta al proveedor.
//
//   POST ?provider=mercado_pago   notificación de pago (firma x-signature si hay clave secreta cargada)
//   POST ?provider=paypal         webhook (verificado con la API de PayPal si hay webhook id cargado)
//   GET  ?return=mp | paypal | paypal-cancel   texto para el navegador; de paso revisa y acredita el pago
import { errorName, json, obj, readText, str, textPage } from '../_shared/pagos/http.ts';
import { type FetchLike, ProviderError } from '../_shared/pagos/provider.ts';
import { mpGetPayment, mpVerifySignature } from '../_shared/pagos/mercadopago.ts';
import { paypalVerifyWebhook } from '../_shared/pagos/paypal.ts';
import { type Logger, type Order, type Rpc, type Secrets, UUID, asOrder, parseSecrets, paypalCreds, syncOrder } from '../_shared/pagos/sync.ts';

const TAG = 'payments-webhook';
const MP_BODY_LIMIT = 64 * 1024;
const PAYPAL_BODY_LIMIT = 256 * 1024;
const HINT_INTERVAL_MS = 4000;

export type WebhookDeps = {
  supabaseReady: boolean;
  rpc: Rpc;
  fetch: FetchLike;
  nowMs?: () => number;
  logger?: Logger;
};

export const PAGES = {
  paid: (plan: string) => `¡Listo! Tu plan ${plan} de Venus IA ya está activo. Volvé a Venus Launcher: ya podés cerrar esta pestaña.\n\nDone! Your Venus AI ${plan} plan is active. Go back to Venus Launcher. You can close this tab.\n`,
  pending: 'Recibimos tu pago y estamos esperando la confirmación. Venus Launcher activa el plan solo apenas se acredite: ya podés cerrar esta pestaña.\n\nWe are waiting for the payment to be confirmed. Venus Launcher activates the plan automatically. You can close this tab.\n',
  failed: 'El pago no se completó y no se activó ningún plan. Volvé a Venus Launcher para intentarlo de nuevo.\n\nThe payment was not completed. Go back to Venus Launcher to try again.\n',
  cancelled: 'Cancelaste el pago: no se cobró nada. Volvé a Venus Launcher cuando quieras.\n\nYou cancelled the payment: nothing was charged. Go back to Venus Launcher whenever you want.\n',
  unknown: 'No encontramos ese pago. Volvé a Venus Launcher: ahí ves el estado de tus pagos.\n\nWe could not find that payment. Go back to Venus Launcher to see its status.\n',
};

export function createWebhookHandler(deps: WebhookDeps) {
  const logger = deps.logger ?? console;
  const now = deps.nowMs ?? Date.now;
  const lastHint = new Map<string, number>();

  async function secrets(): Promise<Secrets> {
    return parseSecrets(await deps.rpc('payments_secrets', {}));
  }

  function throttled(key: string): boolean {
    const t = now();
    const last = lastHint.get(key);
    if (last !== undefined && t - last < HINT_INTERVAL_MS) return true;
    if (lastHint.size > 5000) lastHint.clear();
    lastHint.set(key, t);
    return false;
  }

  async function sync(order: Order, keys: Secrets, includePaid: boolean): Promise<Order> {
    return syncOrder(order, { rpc: deps.rpc, fetch: deps.fetch, secrets: keys, logger, tag: TAG, includePaid });
  }

  // ---------- Mercado Pago ----------
  async function mercadoPago(req: Request, url: URL): Promise<Response> {
    const text = await readText(req, MP_BODY_LIMIT);
    if (text === null) return json(413, { ok: false });
    let body: Record<string, unknown> | null = null;
    try {
      body = text ? obj(JSON.parse(text)) : null;
    } catch {
      body = null;
    }
    const type = str(body?.type, 40) ?? url.searchParams.get('type') ?? url.searchParams.get('topic') ?? '';
    const dataId = url.searchParams.get('data.id') ?? (obj(body?.data)?.id !== undefined ? String(obj(body?.data)?.id) : null) ?? url.searchParams.get('id');
    if (type !== 'payment' || !dataId || !/^[0-9]{1,30}$/.test(dataId)) return json(200, { ok: true, ignored: true });
    const keys = await secrets();
    if (!keys.mpAccessToken) return json(200, { ok: true, ignored: true });
    const signature = req.headers.get('x-signature');
    if (keys.mpWebhookSecret && signature) {
      const valid = await mpVerifySignature(keys.mpWebhookSecret, signature, req.headers.get('x-request-id'), dataId, Math.floor(now() / 1000));
      if (!valid) {
        logger.warn(`[${TAG}] notificación de Mercado Pago con firma inválida (pago ${dataId})`);
        return json(401, { ok: false });
      }
    }
    if (throttled(`mp:${dataId}`)) return json(200, { ok: true, throttled: true });
    const payment = await mpGetPayment(deps.fetch, keys.mpAccessToken, dataId);
    const ref = payment?.externalReference ?? '';
    if (!payment || !UUID.test(ref)) return json(200, { ok: true, ignored: true });
    const order = asOrder(await deps.rpc('payments_get_order', { p_order: ref }));
    if (!order || order.provider !== 'mercado_pago') return json(200, { ok: true, ignored: true });
    await sync(order, keys, true);
    return json(200, { ok: true });
  }

  // ---------- PayPal ----------
  async function paypal(req: Request): Promise<Response> {
    const text = await readText(req, PAYPAL_BODY_LIMIT);
    if (text === null) return json(413, { ok: false });
    let event: Record<string, unknown> | null = null;
    try {
      event = text ? obj(JSON.parse(text)) : null;
    } catch {
      event = null;
    }
    if (!event) return json(400, { ok: false });
    const keys = await secrets();
    const creds = paypalCreds(keys);
    if (!creds) return json(200, { ok: true, ignored: true });
    if (keys.paypalWebhookId) {
      const valid = await paypalVerifyWebhook(deps.fetch, creds, keys.paypalWebhookId, req.headers, event);
      if (!valid) {
        logger.warn(`[${TAG}] webhook de PayPal sin verificar (${str(event.event_type, 60) ?? '?'})`);
        return json(401, { ok: false });
      }
    }
    const type = str(event.event_type, 60) ?? '';
    const resource = obj(event.resource) ?? {};
    const related = obj(obj(resource.supplementary_data)?.related_ids);
    const paypalOrderId = type.startsWith('CHECKOUT.ORDER.') ? str(resource.id, 64) : str(related?.order_id, 64);
    const customId = str(resource.custom_id, 200);
    let order: Order | null = null;
    if (paypalOrderId) order = asOrder(await deps.rpc('payments_find_order', { p_provider: 'paypal', p_provider_order_id: paypalOrderId }));
    if (!order && customId && UUID.test(customId)) order = asOrder(await deps.rpc('payments_get_order', { p_order: customId }));
    if (!order || order.provider !== 'paypal') return json(200, { ok: true, ignored: true });
    if (throttled(`pp:${order.id}:${type}`)) return json(200, { ok: true, throttled: true });
    await sync(order, keys, true);
    return json(200, { ok: true });
  }

  // ---------- Vuelta del navegador ----------
  async function returnPage(url: URL): Promise<Response> {
    const kind = url.searchParams.get('return');
    if (kind === 'paypal-cancel') return textPage(PAGES.cancelled);
    let order: Order | null = null;
    if (kind === 'mp') {
      const ref = url.searchParams.get('external_reference') ?? '';
      if (UUID.test(ref)) order = asOrder(await deps.rpc('payments_get_order', { p_order: ref }));
      if (order && order.provider !== 'mercado_pago') order = null;
    } else if (kind === 'paypal') {
      const token = url.searchParams.get('token') ?? '';
      if (/^[A-Z0-9]{5,64}$/.test(token)) order = asOrder(await deps.rpc('payments_find_order', { p_provider: 'paypal', p_provider_order_id: token }));
    } else {
      return textPage(PAGES.unknown, 404);
    }
    if (!order) return textPage(PAGES.unknown);
    if (!throttled(`ret:${order.id}`)) {
      try {
        order = await sync(order, await secrets(), false);
      } catch (err) {
        logger.warn(`[${TAG}] no se pudo revisar la orden ${order.id} al volver: ${err instanceof ProviderError ? err.describe() : errorName(err)}`);
      }
    }
    if (order.status === 'paid') return textPage(PAGES.paid(order.planName || order.plan));
    if (order.status === 'pending') {
      const mpStatus = kind === 'mp' ? url.searchParams.get('status') ?? url.searchParams.get('collection_status') : null;
      return textPage(mpStatus === 'rejected' || mpStatus === 'null' ? PAGES.failed : PAGES.pending);
    }
    return textPage(order.status === 'cancelled' ? PAGES.cancelled : PAGES.failed);
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
    if (!deps.supabaseReady) return json(503, { ok: false });
    if ((req.method === 'GET' || req.method === 'HEAD') && url.searchParams.has('return')) return returnPage(url);
    if (req.method !== 'POST') return json(405, { ok: false });
    const provider = url.searchParams.get('provider');
    if (provider === 'mercado_pago') return mercadoPago(req, url);
    if (provider === 'paypal') return paypal(req);
    return json(404, { ok: false });
  }

  return async (req: Request): Promise<Response> => {
    try {
      return await handle(req);
    } catch (err) {
      // 500: el proveedor reintenta el aviso más tarde.
      logger.error(`[${TAG}] error: ${err instanceof ProviderError ? err.describe() : errorName(err)}`);
      return json(500, { ok: false });
    }
  };
}
