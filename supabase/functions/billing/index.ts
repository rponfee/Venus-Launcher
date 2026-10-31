// Edge Function "billing": pagos de los planes de Venus IA con Stripe (suscripciones mensuales en USD).
// - La llama el launcher (src/main/modules/billing.js) con el token del usuario, como ai-assistant:
//     supabase functions deploy billing        (con la verificación de JWT activada)
//   y además verifica la sesión por su cuenta (auth.getUser).
// - Checkout de Stripe para un plan, portal de facturación (tarjeta, cambio de plan, cancelación) y estado.
// - Los planes y precios salen de ai_plan_prices / ai_plans (0009_billing.sql); el webhook (stripe-webhook) es
//   quien activa el plan cuando Stripe confirma el pago.
// Secretos: STRIPE_SECRET_KEY (obligatorio), BILLING_RETURN_URL, BILLING_AUTOMATIC_TAX, BILLING_GRACE_DAYS,
// BILLING_PORTAL_CONFIGURATION (opcionales). Ver docs/pagos.md.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { buildReturnUrls, keyMode, parseFlag, parseGraceDays } from './config.ts';
import { createBillingHandler } from './handler.ts';
import type { AuthResult } from './handler.ts';
import { createStripeClient } from './stripe.ts';

function env(name: string): string {
  return (Deno.env.get(name) ?? '').trim();
}

const SUPABASE_URL = env('SUPABASE_URL');
const SUPABASE_ANON_KEY = env('SUPABASE_ANON_KEY');
const SUPABASE_SERVICE_ROLE_KEY = env('SUPABASE_SERVICE_ROLE_KEY');
const STRIPE_SECRET_KEY = env('STRIPE_SECRET_KEY');
const MODE = keyMode(STRIPE_SECRET_KEY);
const PORTAL_CONFIGURATION = /^bpc_[A-Za-z0-9_]{4,250}$/.test(env('BILLING_PORTAL_CONFIGURATION')) ? env('BILLING_PORTAL_CONFIGURATION') : null;

const supabaseOptions = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
// Cliente con la anon key: solo para verificar el JWT del usuario.
const authClient = SUPABASE_URL && SUPABASE_ANON_KEY ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, supabaseOptions) : null;
// Cliente con la service role: solo para las funciones SQL de pagos (nunca se expone al usuario).
const adminClient =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, supabaseOptions) : null;
const stripe = MODE ? createStripeClient({ secretKey: STRIPE_SECRET_KEY }) : null;
const returnUrls = buildReturnUrls(env('BILLING_RETURN_URL'), SUPABASE_URL);

if (!authClient || !adminClient) console.error('[billing] faltan SUPABASE_URL, SUPABASE_ANON_KEY o SUPABASE_SERVICE_ROLE_KEY');
if (!stripe) console.error('[billing] falta el secreto STRIPE_SECRET_KEY (sk_test_..., sk_live_... o una clave restringida rk_...)');
if (!returnUrls) console.error('[billing] no hay URL de vuelta: definí BILLING_RETURN_URL (https://...)');
if (env('BILLING_RETURN_URL') && !buildReturnUrls(env('BILLING_RETURN_URL'), null)) {
  console.error('[billing] BILLING_RETURN_URL no es una URL https válida: se usa la página de stripe-webhook');
}

async function verifyUser(token: string): Promise<AuthResult> {
  if (!authClient) return { status: 'unavailable' };
  const { data, error } = await authClient.auth.getUser(token);
  const user = data?.user ?? null;
  if (user?.id && !error) {
    if (user.is_anonymous === true) return { status: 'forbidden', reason: 'anonymous' };
    return { status: 'ok', userId: user.id, email: typeof user.email === 'string' && user.email ? user.email : null };
  }
  const rawStatus = (error as { status?: unknown } | null)?.status;
  const status = typeof rawStatus === 'number' ? rawStatus : 0;
  // 4xx: token vencido o inválido, o usuario que ya no existe. Lo demás (red, 5xx): Auth no respondió.
  if (!error || (status >= 400 && status < 500)) return { status: 'invalid' };
  return { status: 'unavailable' };
}

async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (!adminClient) throw Object.assign(new Error('sin cliente de Supabase'), { code: 'not_configured' });
  const { data, error } = await adminClient.rpc(name, args);
  if (error) throw Object.assign(new Error('falla de rpc'), { code: String(error.code ?? '') });
  return data;
}

Deno.serve(
  createBillingHandler({
    supabaseReady: Boolean(authClient && adminClient),
    stripe,
    livemode: MODE === 'live',
    returnUrls,
    automaticTax: parseFlag(env('BILLING_AUTOMATIC_TAX')),
    portalConfiguration: PORTAL_CONFIGURATION,
    graceDays: parseGraceDays(env('BILLING_GRACE_DAYS')),
    verifyUser,
    rpc,
  }),
);
