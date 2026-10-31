// Edge Function "admin": panel de administración de Venus Launcher (usuarios, planes, cupones y registro).
// - La llama el launcher (src/main/modules/admin.js) con el token del usuario:
//     supabase functions deploy admin        (con la verificación de JWT activada, lo predeterminado)
//   y en CADA pedido vuelve a verificar la sesión (auth.getUser), que el email esté confirmado y que el usuario
//   siga siendo admin en la base (0012_admin.sql).
// - Base: funciones admin_* de 0012 con la service role. Auth: API de administración (baneos y borrar cuentas).
//   Stripe: cupones, códigos de promoción, cambio de precio y cancelación de suscripciones.
// Secretos: STRIPE_SECRET_KEY (opcional: sin ella cupones, precios y cancelaciones responden "no configurado"),
// BILLING_PORTAL_CONFIGURATION (opcional). SUPABASE_URL, SUPABASE_ANON_KEY y SUPABASE_SERVICE_ROLE_KEY los pone
// Supabase. Guía: docs/admin.md.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { keyMode } from '../billing/config.ts';
import { createAdminHandler } from './handler.ts';
import type { AuthResult } from './handler.ts';
import { AuthAdminError } from './errors.ts';
import { createAdminStripe } from './stripe-admin.ts';

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
// Cliente con la anon key: solo para verificar el JWT de quien llama.
const authClient = SUPABASE_URL && SUPABASE_ANON_KEY ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, supabaseOptions) : null;
// Cliente con la service role: funciones SQL, API de administración de Auth y Storage (nunca sale del servidor).
const adminClient =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, supabaseOptions) : null;
const stripe = MODE ? createAdminStripe({ secretKey: STRIPE_SECRET_KEY }) : null;

if (!authClient || !adminClient) console.error('[admin] faltan SUPABASE_URL, SUPABASE_ANON_KEY o SUPABASE_SERVICE_ROLE_KEY');
if (!stripe) console.warn('[admin] sin STRIPE_SECRET_KEY: cupones, precios y cancelaciones de Stripe quedan desactivados');

const statusOf = (error: unknown) => {
  const raw = (error as { status?: unknown } | null)?.status;
  return typeof raw === 'number' ? raw : 0;
};

async function verifyUser(token: string): Promise<AuthResult> {
  if (!authClient) return { status: 'unavailable' };
  const { data, error } = await authClient.auth.getUser(token);
  const user = data?.user ?? null;
  if (user?.id && !error) {
    return {
      status: 'ok',
      user: {
        userId: user.id,
        email: typeof user.email === 'string' && user.email ? user.email : null,
        emailConfirmed: Boolean(user.email_confirmed_at),
        anonymous: user.is_anonymous === true,
      },
    };
  }
  const status = statusOf(error);
  // 4xx: token vencido o inválido, sesión cerrada o usuario borrado o baneado. Lo demás: Auth no respondió.
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
  createAdminHandler({
    supabaseReady: Boolean(authClient && adminClient),
    verifyUser,
    rpc,
    authAdmin: {
      async setBan(userId, banDuration) {
        const { error } = await adminClient!.auth.admin.updateUserById(userId, { ban_duration: banDuration });
        if (error) throw new AuthAdminError(statusOf(error));
      },
      async deleteUser(userId) {
        const { error } = await adminClient!.auth.admin.deleteUser(userId);
        if (error) throw new AuthAdminError(statusOf(error));
      },
    },
    storage: {
      async remove(bucket, paths) {
        const { data, error } = await adminClient!.storage.from(bucket).remove(paths);
        if (error) throw new AuthAdminError(statusOf(error));
        return Array.isArray(data) ? data.length : 0;
      },
    },
    stripe,
    livemode: MODE === 'live',
    portalConfiguration: PORTAL_CONFIGURATION,
  }),
);
