// Genera las claves VAPID y el secreto compartido de los avisos, sin dependencias. No guarda nada: imprime los comandos
// para pegar una sola vez. Uso: node supabase/functions/push-notify/generar-claves.mjs
import { generateKeyPairSync, randomBytes } from 'node:crypto';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = privateKey.export({ format: 'jwk' });
const publicKey = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
const secret = randomBytes(32).toString('base64url');

console.log(`supabase secrets set VENUS_VAPID_PUBLIC=${publicKey} VENUS_VAPID_PRIVATE=${jwk.d} VENUS_PUSH_SECRET=${secret}`);
console.log('');
console.log('Y en el SQL Editor de Supabase, después de aplicar 0035 (cambiá <ref> por el del proyecto):');
console.log(`select private.push_configure('https://<ref>.supabase.co/functions/v1/push-notify', '${secret}');`);
