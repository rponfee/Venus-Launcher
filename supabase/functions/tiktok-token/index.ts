// Edge Function "tiktok-token" (ver handler.ts). Se despliega con la verificacion de JWT activada.
// Secretos: TIKTOK_CLIENT_KEY y TIKTOK_CLIENT_SECRET. Sin ellos responde 503 y el launcher avisa que no esta disponible.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { createTokenHandler } from './handler.ts';

const env = (name: string) => (Deno.env.get(name) ?? '').trim();
const SUPABASE_URL = env('SUPABASE_URL');
const authClient = SUPABASE_URL && env('SUPABASE_ANON_KEY') ? createClient(SUPABASE_URL, env('SUPABASE_ANON_KEY'), { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }) : null;

Deno.serve(createTokenHandler({
  fetch,
  clientKey: env('TIKTOK_CLIENT_KEY'),
  clientSecret: env('TIKTOK_CLIENT_SECRET'),
  verifyUser: async (token) => {
    if (!authClient) return 'unavailable';
    const { data, error } = await authClient.auth.getUser(token);
    if (data?.user?.id && !error) return data.user.is_anonymous === true ? 'forbidden' : 'ok';
    const status = typeof error?.status === 'number' ? error.status : 0;
    return !error || (status >= 400 && status < 500) ? 'invalid' : 'unavailable';
  },
}));
