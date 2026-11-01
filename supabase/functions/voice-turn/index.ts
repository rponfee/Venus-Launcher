// Edge Function "voice-turn": claves temporales del servidor TURN del Voice Chat, solo para sesiones de Venus
// (se despliega con la verificación de JWT activada y además revisa el usuario con auth.getUser).
// Secretos: TURN_SECRET (el static-auth-secret de coturn, obligatorio), TURN_URLS (opcional, separadas por coma) y
// TURN_TTL_SECONDS (opcional, de 600 a 172800; por defecto 24 h). Guía: docs/voice-turn.md.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { type AuthResult, createTurnHandler, parseTtl, parseUrls } from './handler.ts';

const env = (name: string) => (Deno.env.get(name) ?? '').trim();
// El servidor de Vultr del launcher; TURN_URLS lo reemplaza si se muda (no es secreto: la IP la ve cualquier usuario).
const DEFAULT_URLS = 'turn:64.176.3.21:3478?transport=udp,turn:64.176.3.21:3478?transport=tcp';
const SUPABASE_URL = env('SUPABASE_URL');
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const authClient = SUPABASE_URL && env('SUPABASE_ANON_KEY') ? createClient(SUPABASE_URL, env('SUPABASE_ANON_KEY'), options) : null;
if (!env('TURN_SECRET')) console.error('[voice-turn] falta el secreto TURN_SECRET: se responde una lista vacía');

async function verifyUser(token: string): Promise<AuthResult> {
  if (!authClient) return { status: 'unavailable' };
  const { data, error } = await authClient.auth.getUser(token);
  const user = data?.user ?? null;
  if (user?.id && !error) return user.is_anonymous === true ? { status: 'forbidden' } : { status: 'ok', userId: user.id };
  const status = typeof error?.status === 'number' ? error.status : 0;
  return !error || (status >= 400 && status < 500) ? { status: 'invalid' } : { status: 'unavailable' };
}

Deno.serve(createTurnHandler({
  secret: env('TURN_SECRET'),
  urls: parseUrls(env('TURN_URLS') || DEFAULT_URLS),
  ttlSeconds: parseTtl(env('TURN_TTL_SECONDS')),
  verifyUser,
}));
