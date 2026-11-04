// Edge Function "push-notify": avisos Web Push de la app del celular, sin contenido. Guía: docs/wip/app-celular-34.md.
// Se despliega sin verificación de JWT (supabase functions deploy push-notify --no-verify-jwt): la llama la base con un
// secreto propio y la app le pide la clave pública sin sesión. Sin dependencias: habla con PostgREST con fetch.
// Secretos: VENUS_PUSH_SECRET (el mismo de private.push_configure), VENUS_VAPID_PUBLIC y VENUS_VAPID_PRIVATE
// (node supabase/functions/push-notify/generar-claves.mjs los genera) y VENUS_PUSH_SUBJECT (opcional).
// SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY los inyecta Supabase.
import { createPushHandler } from './handler.ts';

const env = (name: string) => (Deno.env.get(name) ?? '').trim();

for (const name of ['VENUS_PUSH_SECRET', 'VENUS_VAPID_PUBLIC', 'VENUS_VAPID_PRIVATE']) {
  if (!env(name)) console.error(`[push-notify] falta el secreto ${name}`);
}

Deno.serve(createPushHandler({
  secret: env('VENUS_PUSH_SECRET'),
  vapidPublic: env('VENUS_VAPID_PUBLIC'),
  vapidPrivate: env('VENUS_VAPID_PRIVATE'),
  subject: env('VENUS_PUSH_SUBJECT') || 'https://github.com/rponfee/Venus-Launcher',
  supabaseUrl: env('SUPABASE_URL'),
  serviceKey: env('SUPABASE_SERVICE_ROLE_KEY'),
}));
