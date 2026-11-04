// Proxy de CurseForge: la clave se obtiene de Vault mediante la RPC de acceso, nunca del launcher.
// verify_jwt=true; el handler confirma además la sesión con Auth y rechaza cuentas anónimas.
import { createCurseforgeHandler } from './handler.ts';

const env = (name: string) => (Deno.env.get(name) ?? '').trim();

Deno.serve(createCurseforgeHandler({
  fetch,
  supabaseUrl: env('SUPABASE_URL'),
  anonKey: env('SUPABASE_ANON_KEY'),
  serviceKey: env('SUPABASE_SERVICE_ROLE_KEY'),
}));
