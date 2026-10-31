// Configuración compartida de los pagos de Venus IA con Stripe (Edge Functions "billing" y "stripe-webhook").
// Sin dependencias externas ni APIs de Deno: se prueba con Node (node --test).

/** Planes pagos de Venus IA (ids de public.ai_plans, ver 0008_ai_plans.sql). No hay plan gratis. */
export const PLAN_IDS = ['go', 'pro', 'super', 'ultra', 'max', 'supreme'] as const;

/** Formato de un id de plan (el mismo check que public.ai_plans.id). */
export const PLAN_ID_PATTERN = /^[a-z][a-z0-9_-]{1,31}$/;

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const STRIPE_API_BASE = 'https://api.stripe.com';
/**
 * Versión fija de la API de Stripe: las respuestas tienen siempre la misma forma aunque la cuenta tenga otra
 * versión por defecto. Desde esta versión el fin del período está en cada ítem de la suscripción
 * (items.data[].current_period_end) y la suscripción de una factura en parent.subscription_details; el código
 * acepta también la forma vieja (los eventos llegan con la versión del endpoint del webhook).
 */
export const STRIPE_API_VERSION = '2025-03-31.basil';
export const STRIPE_TIMEOUT_MS = 15000;

export const DEFAULT_GRACE_DAYS = 3;
export const MAX_GRACE_DAYS = 30;

/** Eventos que procesa el webhook (los mismos que hay que elegir en el panel de Stripe). */
export const HANDLED_EVENTS: ReadonlySet<string> = new Set([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
]);

/** Estados de Stripe de una suscripción "viva": con una así, el checkout abre el portal en vez de cobrar otra. */
export const OPEN_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set(['active', 'trialing', 'past_due']);

export const LIMITS = {
  /** Cuerpo de un evento de Stripe (los nuestros pesan unos pocos KB). */
  webhookBodyBytes: 1024 * 1024,
  /** Cuerpo de un pedido del launcher a "billing". */
  billingBodyBytes: 8 * 1024,
  /** Antigüedad máxima de la firma de un evento (segundos). */
  signatureToleranceSec: 300,
  /** Mínimo entre dos sincronizaciones con Stripe pedidas por un mismo usuario (GET ?sync=1). */
  syncIntervalMs: 10000,
  /** Cuánto se guardan en memoria el mapa de precios y la configuración del portal. */
  priceMapTtlMs: 60000,
  portalConfigTtlMs: 10 * 60000,
};

export const CORS_HEADERS: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

/** Lee BILLING_GRACE_DAYS (días de gracia con un pago fallido). Sin valor o inválido: 3. */
export function parseGraceDays(raw: string | null | undefined): number {
  const text = String(raw ?? '').trim();
  if (!text) return DEFAULT_GRACE_DAYS;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_GRACE_DAYS;
  return Math.min(MAX_GRACE_DAYS, n);
}

/** Interruptor de un secreto: 1, true, yes, si, sí. */
export function parseFlag(raw: string | null | undefined): boolean {
  return /^(1|true|yes|on|si|sí)$/i.test(String(raw ?? '').trim());
}

/** Modo de una clave de Stripe: 'live' (sk_live_, rk_live_), 'test' (sk_test_, rk_test_) o null si no se reconoce. */
export function keyMode(secretKey: string | null | undefined): 'live' | 'test' | null {
  const key = String(secretKey ?? '').trim();
  if (/^(sk|rk)_live_[A-Za-z0-9]{8,}$/.test(key)) return 'live';
  if (/^(sk|rk)_test_[A-Za-z0-9]{8,}$/.test(key)) return 'test';
  return null;
}

/** Secretos de firma del webhook (whsec_...). Se aceptan varios separados por coma o espacio (rotación). */
export function parseSecrets(raw: string | null | undefined): string[] {
  return String(raw ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => /^whsec_[A-Za-z0-9+/=_-]{8,}$/.test(s));
}

export type ReturnKind = 'success' | 'cancel' | 'portal';
export type ReturnUrls = Record<ReturnKind, string>;

const RETURN_KINDS: readonly ReturnKind[] = ['success', 'cancel', 'portal'];

function withReturn(base: URL, kind: ReturnKind): string {
  const url = new URL(base.href);
  url.searchParams.set('return', kind);
  return url.href;
}

/** URL aceptable para volver de Stripe: https, o http solo en la máquina local (pruebas). */
export function validReturnBase(raw: string | null | undefined): URL | null {
  const text = String(raw ?? '').trim();
  if (!text || text.length > 1000) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return url;
  return null;
}

/**
 * Adónde vuelve el navegador después de Stripe (Checkout o portal), con ?return=success|cancel|portal.
 * - BILLING_RETURN_URL (por ejemplo la web del launcher) si está y es válida;
 * - si no, el GET ?return=... de la función stripe-webhook, que es pública (la función billing tiene la
 *   verificación de JWT de Supabase, que rechazaría al navegador). Las dos funciones responden ese GET.
 * null si no hay forma de armarlas (falta SUPABASE_URL).
 */
export function buildReturnUrls(returnBase: string | null | undefined, supabaseUrl: string | null | undefined): ReturnUrls | null {
  let base = validReturnBase(returnBase);
  if (!base) {
    const root = validReturnBase(String(supabaseUrl ?? '').trim().replace(/\/+$/, ''));
    if (!root) return null;
    base = new URL(`${root.origin}/functions/v1/stripe-webhook`);
  }
  const out = {} as ReturnUrls;
  for (const kind of RETURN_KINDS) out[kind] = withReturn(base, kind);
  return out;
}

/** Textos de la página de vuelta (texto plano: Supabase sirve el HTML de las funciones como text/plain). */
export const RETURN_MESSAGES: Readonly<Record<ReturnKind, string>> = {
  success:
    'Listo, volvé a Venus Launcher.\n\nEstamos confirmando tu pago: en unos segundos vas a ver tu plan de Venus IA activo. Ya podés cerrar esta pestaña.\n\nDone! Go back to Venus Launcher. You can close this tab.\n',
  cancel:
    'No se hizo ningún cobro. Volvé a Venus Launcher para elegir un plan cuando quieras. Ya podés cerrar esta pestaña.\n\nNo charge was made. Go back to Venus Launcher. You can close this tab.\n',
  portal:
    'Listo, volvé a Venus Launcher. Los cambios de tu suscripción se ven en unos segundos. Ya podés cerrar esta pestaña.\n\nDone! Go back to Venus Launcher. You can close this tab.\n',
};

/** Respuesta del GET ?return=success|cancel|portal, o null si el pedido no es eso. */
export function returnPage(req: Request): Response | null {
  if (req.method !== 'GET' && req.method !== 'HEAD') return null;
  let kind: string | null = null;
  try {
    kind = new URL(req.url).searchParams.get('return');
  } catch {
    return null;
  }
  if (kind !== 'success' && kind !== 'cancel' && kind !== 'portal') return null;
  return new Response(req.method === 'HEAD' ? null : RETURN_MESSAGES[kind], {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

/** Idioma del launcher -> idioma de las páginas de Stripe (Checkout y portal). Desconocido: 'auto'. */
const STRIPE_LOCALES: Readonly<Record<string, string>> = {
  es: 'es-419',
  en: 'en',
  pt: 'pt-BR',
  fr: 'fr',
  de: 'de',
  it: 'it',
  nl: 'nl',
  pl: 'pl',
  ru: 'ru',
  tr: 'tr',
  ja: 'ja',
  ko: 'ko',
  zh: 'zh',
};

export function stripeLocale(lang: unknown): string {
  if (typeof lang !== 'string') return 'auto';
  const code = lang.trim().toLowerCase().slice(0, 2);
  return STRIPE_LOCALES[code] ?? 'auto';
}
