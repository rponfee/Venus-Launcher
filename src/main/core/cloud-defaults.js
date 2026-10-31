'use strict';
// Proyecto de Supabase del launcher (cuenta de Venus, amigos, mensajes, Voice Chat, nube, pagos e IA). Es fijo:
// no se cambia desde la interfaz y el proceso principal ignora cualquier proyecto guardado en los ajustes por
// versiones anteriores (settings.cloud). Para usar otro proyecto en todas las copias, cambiá estos valores antes
// de compilar. La anon key es pública por diseño: la seguridad la dan las políticas RLS de supabase/migrations.
// Proyecto: dzchklzaxyygbvfpagvx (región sa-east-1, San Pablo).
//
// Para desarrollo (solo sin empaquetar): VENUS_SUPABASE_URL + VENUS_SUPABASE_ANON_KEY apuntan a otro proyecto
// (uno de prueba o el stack local de `supabase start`). No se muestra en la interfaz.
const { devEnv } = require('./app-config');

const url = 'https://dzchklzaxyygbvfpagvx.supabase.co';
const anonKey =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR6Y2hrbHpheHl5Z2J2ZnBhZ3Z4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMxNDA2NDYsImV4cCI6MjEwODcxNjY0Nn0.OwCJ2uTTO0IXECEKhwPk3Qha-NRN7PXd_2v6VPzJyzg';

// https, o http solo para el stack local de Supabase (http://127.0.0.1:54321)
const VALID_URL = /^https:\/\/[^\s/]+$|^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i;

// { url, anonKey, configured }: lo que usan todos los módulos (y la interfaz por cloud:config).
function config() {
  let u = url;
  let k = anonKey;
  const devUrl = process.env.VENUS_SUPABASE_URL;
  const devKey = process.env.VENUS_SUPABASE_ANON_KEY;
  if (devUrl && devKey && devEnv()) {
    u = devUrl;
    k = devKey;
  }
  u = String(u || '').trim().replace(/\/+$/, '');
  k = String(k || '').trim();
  return { url: u, anonKey: k, configured: Boolean(k && VALID_URL.test(u)) };
}

module.exports = { url, anonKey, config };
