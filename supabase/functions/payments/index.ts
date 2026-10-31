// Edge Function "payments" (verify_jwt = false: también la llaman Mercado Pago, PayPal y el navegador).
//   ?provider=… o ?return=…  -> webhook.ts (avisos y páginas de vuelta; nada se cree sin consultar al proveedor)
//   el resto                  -> handler.ts (launcher y panel de admin; verifica el JWT del usuario en cada pedido)
// Guía: docs/pagos.md.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { type AuthResult, createPaymentsHandler } from './handler.ts';
import { createWebhookHandler } from './webhook.ts';

const env = (name: string) => (Deno.env.get(name) ?? '').trim();
const SUPABASE_URL = env('SUPABASE_URL');
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const authClient = SUPABASE_URL && env('SUPABASE_ANON_KEY') ? createClient(SUPABASE_URL, env('SUPABASE_ANON_KEY'), options) : null;
const adminClient = SUPABASE_URL && env('SUPABASE_SERVICE_ROLE_KEY') ? createClient(SUPABASE_URL, env('SUPABASE_SERVICE_ROLE_KEY'), options) : null;
if (!authClient || !adminClient) console.error('[payments] faltan SUPABASE_URL, SUPABASE_ANON_KEY o SUPABASE_SERVICE_ROLE_KEY');

async function verifyUser(token: string): Promise<AuthResult> {
  if (!authClient) return { status: 'unavailable' };
  const { data, error } = await authClient.auth.getUser(token);
  const user = data?.user ?? null;
  if (user?.id && !error) {
    if (user.is_anonymous === true) return { status: 'forbidden' };
    return { status: 'ok', userId: user.id, email: typeof user.email === 'string' && user.email ? user.email : null };
  }
  const status = typeof error?.status === 'number' ? error.status : 0;
  return !error || (status >= 400 && status < 500) ? { status: 'invalid' } : { status: 'unavailable' };
}

async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (!adminClient) throw Object.assign(new Error('sin cliente'), { code: 'not_configured' });
  const { data, error } = await adminClient.rpc(name, args);
  if (error) throw Object.assign(new Error(String(error.message ?? 'rpc')), { code: String(error.code ?? ''), message: String(error.message ?? '') });
  return data;
}

const doFetch = (input: string, init?: RequestInit) => fetch(input, init);
const api = createPaymentsHandler({
  supabaseReady: Boolean(authClient && adminClient),
  verifyUser,
  rpc,
  fetch: doFetch,
  functionsBase: `${SUPABASE_URL.replace(/\/+$/, '')}/functions/v1`,
});
const hooks = createWebhookHandler({ supabaseReady: Boolean(adminClient), rpc, fetch: doFetch });

Deno.serve((req) => {
  const url = new URL(req.url);
  return url.searchParams.has('provider') || url.searchParams.has('return') ? hooks(req) : api(req);
});
