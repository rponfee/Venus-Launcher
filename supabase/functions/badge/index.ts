// Edge Function "badge": anota una cuenta de Minecraft en la insignia de Venus después de verificarla con Mojang
// (ver handler.ts). Se despliega con la verificación de JWT activada y además revisa el usuario con auth.getUser.
// No necesita secretos propios: SUPABASE_URL, SUPABASE_ANON_KEY y SUPABASE_SERVICE_ROLE_KEY los pone Supabase.
// Necesita la migración 0019_insignia.sql. Guía: docs/insignia.md.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { type AuthResult, createBadgeHandler, mojangHasJoined } from './handler.ts';

const env = (name: string) => (Deno.env.get(name) ?? '').trim();
const SUPABASE_URL = env('SUPABASE_URL');
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const authClient = SUPABASE_URL && env('SUPABASE_ANON_KEY') ? createClient(SUPABASE_URL, env('SUPABASE_ANON_KEY'), options) : null;
const admin = SUPABASE_URL && env('SUPABASE_SERVICE_ROLE_KEY') ? createClient(SUPABASE_URL, env('SUPABASE_SERVICE_ROLE_KEY'), options) : null;

async function verifyUser(token: string): Promise<AuthResult> {
  if (!authClient) return { status: 'unavailable' };
  const { data, error } = await authClient.auth.getUser(token);
  const user = data?.user ?? null;
  if (user?.id && !error) return user.is_anonymous === true ? { status: 'forbidden' } : { status: 'ok', userId: user.id };
  const status = typeof error?.status === 'number' ? error.status : 0;
  return !error || (status >= 400 && status < 500) ? { status: 'invalid' } : { status: 'unavailable' };
}

async function rpc(name: string, args: Record<string, unknown>) {
  if (!admin) throw new Error('sin service role');
  const { data, error } = await admin.rpc(name, args);
  if (error) {
    console.error(`[badge] ${name}: ${error.code ?? ''} ${error.message ?? ''}`);
    throw new Error(name);
  }
  return data;
}

Deno.serve(createBadgeHandler({
  verifyUser,
  takeChallenge: async (userId, serverId) => (await rpc('badge_take_challenge', { p_user: userId, p_server_id: serverId })) === true,
  hasJoined: (name, serverId) => mojangHasJoined(fetch, name, serverId),
  enroll: async (userId, uuid) => String(await rpc('badge_enroll', { p_user: userId, p_uuid: uuid })),
}));
