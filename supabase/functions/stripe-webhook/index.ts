// Edge Function "stripe-webhook": recibe los eventos de Stripe de las suscripciones de Venus IA.
// - Se despliega SIN la verificación de JWT de Supabase (Stripe no manda un JWT):
//     supabase functions deploy stripe-webhook --no-verify-jwt
//   La seguridad la da la firma: cada pedido sin una Stripe-Signature válida se rechaza (signature.ts).
// - Por cada evento vuelve a leer la suscripción de la API de Stripe y la guarda en ai_subscriptions
//   (funciones SQL de 0009_billing.sql, con la service role).
// - También responde GET ?return=success|cancel|portal: la página de vuelta de Checkout y del portal.
// Comparte código con ../billing (el empaquetador de Supabase incluye los imports relativos).
// Secretos: STRIPE_WEBHOOK_SECRET, STRIPE_SECRET_KEY y opcional BILLING_GRACE_DAYS (ver docs/pagos.md).
import { createClient } from 'npm:@supabase/supabase-js@2';
import { keyMode, parseGraceDays, parseSecrets } from '../billing/config.ts';
import { createStripeClient } from '../billing/stripe.ts';
import { createWebhookHandler } from './handler.ts';

function env(name: string): string {
  return (Deno.env.get(name) ?? '').trim();
}

const SUPABASE_URL = env('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = env('SUPABASE_SERVICE_ROLE_KEY');
const STRIPE_SECRET_KEY = env('STRIPE_SECRET_KEY');
const SECRETS = parseSecrets(env('STRIPE_WEBHOOK_SECRET'));
const MODE = keyMode(STRIPE_SECRET_KEY);

const adminClient =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
    : null;
const stripe = MODE ? createStripeClient({ secretKey: STRIPE_SECRET_KEY }) : null;

// Dice por qué no sirve un secreto sin mostrar su valor: si no hay ninguno con ese nombre o qué forma tiene.
function describeSecret(name: string, raw: string, expected: RegExp, hint: string): string {
  if (!raw) return `falta el secreto ${name} (${hint}): no hay ninguno cargado con ese nombre exacto`;
  const yes = (v: boolean) => (v ? 'sí' : 'no');
  const quoted = /["'`]/.test(raw);
  const facts = [
    `largo ${raw.length}`,
    `empieza bien: ${yes(expected.test(raw))}`,
    `comillas: ${yes(quoted)}`,
    `espacios o saltos de línea: ${yes(/\s/.test(raw))}`,
  ];
  return `el secreto ${name} está cargado pero no tiene la forma ${hint} (${facts.join(', ')})`;
}

if (!adminClient) console.error('[stripe-webhook] faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY');
if (!SECRETS.length) console.error(`[stripe-webhook] ${describeSecret('STRIPE_WEBHOOK_SECRET', env('STRIPE_WEBHOOK_SECRET'), /^whsec_/, 'whsec_...')}`);
if (!stripe) console.error(`[stripe-webhook] ${describeSecret('STRIPE_SECRET_KEY', STRIPE_SECRET_KEY, /^(sk|rk)_(test|live)_/, 'sk_test_..., sk_live_... o una clave restringida rk_...')}`);

async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (!adminClient) throw Object.assign(new Error('sin cliente de Supabase'), { code: 'not_configured' });
  const { data, error } = await adminClient.rpc(name, args);
  if (error) throw Object.assign(new Error('falla de rpc'), { code: String(error.code ?? '') });
  return data;
}

Deno.serve(
  createWebhookHandler({
    secrets: SECRETS,
    stripe,
    livemode: MODE ? MODE === 'live' : null,
    dbReady: Boolean(adminClient),
    graceDays: parseGraceDays(env('BILLING_GRACE_DAYS')),
    rpc,
  }),
);
