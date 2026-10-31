// Un solo lugar para "estado del proveedor -> estado de la orden". Siempre se consulta al proveedor con nuestras
// credenciales: lo que llega en un webhook o en la URL de vuelta es solo un aviso de que hay que mirar.
import { type FetchLike, ProviderError } from './provider.ts';
import { mpOutcome, mpSearchPayments } from './mercadopago.ts';
import { type PaypalCreds, type PaypalEnv, paypalCapture, paypalGetOrder, paypalOutcome } from './paypal.ts';

export type Rpc = (name: string, args: Record<string, unknown>) => Promise<unknown>;
export type Logger = Pick<Console, 'warn' | 'error'>;

export type Secrets = {
  mpAccessToken: string | null;
  mpWebhookSecret: string | null;
  paypalClientId: string | null;
  paypalSecret: string | null;
  paypalWebhookId: string | null;
  paypalEnv: PaypalEnv;
  statementDescriptor: string;
};

export type Order = {
  id: string;
  userId: string;
  plan: string;
  planName: string;
  provider: 'mercado_pago' | 'paypal';
  currency: 'ARS' | 'USD';
  amount: number;
  priceUsd: number;
  budgetUsd: number;
  status: 'pending' | 'paid' | 'failed' | 'cancelled' | 'expired' | 'refunded';
  providerStatus: string | null;
  providerOrderId: string | null;
  checkoutUrl: string | null;
  live: boolean;
  createdAt: string | null;
  paidAt: string | null;
  expiresAt: string | null;
};

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseSecrets(raw: unknown): Secrets {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const s = (k: string) => (typeof o[k] === 'string' && o[k] ? (o[k] as string) : null);
  return {
    mpAccessToken: s('mpAccessToken'),
    mpWebhookSecret: s('mpWebhookSecret'),
    paypalClientId: s('paypalClientId'),
    paypalSecret: s('paypalSecret'),
    paypalWebhookId: s('paypalWebhookId'),
    paypalEnv: o.paypalEnv === 'live' ? 'live' : 'sandbox',
    statementDescriptor: s('statementDescriptor') ?? 'VENUS LAUNCHER',
  };
}

export function paypalCreds(secrets: Secrets): PaypalCreds | null {
  return secrets.paypalClientId && secrets.paypalSecret ? { env: secrets.paypalEnv, clientId: secrets.paypalClientId, secret: secrets.paypalSecret } : null;
}

export function asOrder(raw: unknown): Order | null {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!o || typeof o.id !== 'string' || !UUID.test(o.id)) return null;
  if (o.provider !== 'mercado_pago' && o.provider !== 'paypal') return null;
  return o as unknown as Order;
}

export type SyncContext = {
  rpc: Rpc;
  fetch: FetchLike;
  secrets: Secrets;
  logger: Logger;
  tag: string;
  /** También revisa órdenes ya pagadas (por una devolución). */
  includePaid?: boolean;
};

async function reload(ctx: SyncContext, id: string, fallback: Order): Promise<Order> {
  return asOrder(await ctx.rpc('payments_get_order', { p_order: id })) ?? fallback;
}

async function markPaid(ctx: SyncContext, order: Order, paymentId: string, amount: number | null, currency: string | null, live: boolean, providerStatus: string) {
  const out = (await ctx.rpc('payments_mark_paid', {
    p_order: order.id, p_payment_id: paymentId, p_amount: amount, p_currency: currency, p_live: live, p_provider_status: providerStatus,
  })) as Record<string, unknown> | null;
  if (out?.applied !== true && out?.reason === 'amount_mismatch') {
    ctx.logger.error(`[${ctx.tag}] la orden ${order.id} recibió un monto distinto (${currency} ${amount}); no se activó el plan`);
  }
}

/** Mira la orden en el proveedor y la actualiza. Devuelve la orden como quedó. */
export async function syncOrder(order: Order, ctx: SyncContext): Promise<Order> {
  const open = ['pending', 'expired', 'failed', 'cancelled'].includes(order.status);
  if (!open && !(ctx.includePaid && order.status === 'paid')) return order;
  if (order.provider === 'mercado_pago') {
    const token = ctx.secrets.mpAccessToken;
    if (!token) return order;
    const outcome = mpOutcome(await mpSearchPayments(ctx.fetch, token, order.id), order.id);
    if (outcome.kind === 'paid' && open) {
      await markPaid(ctx, order, outcome.paymentId, outcome.amount, outcome.currency, outcome.live, outcome.providerStatus);
    } else if (outcome.kind === 'refunded' && order.status === 'paid') {
      await ctx.rpc('payments_mark_status', { p_order: order.id, p_status: 'refunded', p_provider_status: outcome.providerStatus });
    } else if (outcome.kind === 'pending') {
      await ctx.rpc('payments_touch', { p_order: order.id, p_provider_status: outcome.providerStatus });
    }
    return reload(ctx, order.id, order);
  }
  const creds = paypalCreds(ctx.secrets);
  if (!creds || !order.providerOrderId) return order;
  let outcome = paypalOutcome(await paypalGetOrder(ctx.fetch, creds, order.providerOrderId));
  if (outcome.kind === 'approved' && open) {
    try {
      outcome = paypalOutcome(await paypalCapture(ctx.fetch, creds, order.providerOrderId));
    } catch (err) {
      if (!(err instanceof ProviderError) || err.status >= 500 || err.status === 0) throw err;
      ctx.logger.warn(`[${ctx.tag}] PayPal no capturó la orden ${order.id}: ${err.describe()}`);
      await ctx.rpc('payments_touch', { p_order: order.id, p_provider_status: `capture_error:${err.code ?? err.status}` });
      return reload(ctx, order.id, order);
    }
  }
  if (outcome.customId && outcome.customId !== order.id) {
    ctx.logger.error(`[${ctx.tag}] la orden de PayPal ${order.providerOrderId} no es de la orden ${order.id}`);
    return order;
  }
  if (outcome.kind === 'paid' && open) {
    await markPaid(ctx, order, outcome.paymentId, outcome.amount, outcome.currency, creds.env === 'live', outcome.providerStatus);
  } else if (outcome.kind === 'refunded' && order.status === 'paid') {
    await ctx.rpc('payments_mark_status', { p_order: order.id, p_status: 'refunded', p_provider_status: outcome.providerStatus });
  } else if (outcome.kind === 'cancelled' && order.status === 'pending') {
    await ctx.rpc('payments_mark_status', { p_order: order.id, p_status: 'cancelled', p_provider_status: outcome.providerStatus });
  } else if (outcome.kind === 'pending' || outcome.kind === 'approved') {
    await ctx.rpc('payments_touch', { p_order: order.id, p_provider_status: outcome.providerStatus });
  }
  return reload(ctx, order.id, order);
}
