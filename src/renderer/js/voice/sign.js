// Identidad de cada sesion de voz: par de claves ECDSA P-256 efimero. La clave publica se guarda en la
// base (voice_members.session_key, atada al usuario autenticado) y con ella los demas verifican que la
// señalizacion WebRTC, el chat y las ordenes del anfitrion vienen de quien dicen venir.
const ALG = { name: 'ECDSA', namedCurve: 'P-256' };
const SIG = { name: 'ECDSA', hash: 'SHA-256' };
const enc = new TextEncoder();

function toB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function fromB64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Identificador aleatorio legible (sesiones, mensajes, nonces)
export function randomId(len = 16) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

export async function createIdentity() {
  const pair = await crypto.subtle.generateKey(ALG, false, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { privateKey: pair.privateKey, publicJwk: JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }) };
}

export async function importPublicKey(jwkText) {
  const jwk = typeof jwkText === 'string' ? JSON.parse(jwkText) : jwkText;
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') throw new Error('invalid key');
  return crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true }, ALG, false, ['verify']);
}

export async function signText(privateKey, text) {
  return toB64(await crypto.subtle.sign(SIG, privateKey, enc.encode(text)));
}

export async function verifyText(publicKey, text, signature) {
  if (!publicKey || typeof signature !== 'string' || signature.length > 200) return false;
  try {
    return await crypto.subtle.verify(SIG, publicKey, fromB64(signature), enc.encode(text));
  } catch {
    return false;
  }
}
