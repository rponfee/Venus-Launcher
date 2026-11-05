// Cifrado de lo que viaja por el camino de respaldo del Voice Chat (voice/backup.js). Los brokers MQTT publicos
// son de cualquiera: solo ven bytes. La clave de la sala (un secreto de 120 bits o mas que solo conocen sus
// miembros) da, por HKDF, el tema del broker y la clave AES-GCM. Asi:
//   - nadie que no tenga el secreto puede leer, ni meter mensajes, ni siquiera adivinar el tema (es un hash);
//   - el broker no sabe la sala, ni quien habla (el sobre firmado va adentro) y los tamaños se redondean;
//   - lo de adentro sigue firmado con la clave de sesion de cada uno (voice/sign.js): el secreto compartido solo
//     deja entrar a la sala, no hacerse pasar por otra persona.
// Es logica sin DOM: se prueba en Node con WebCrypto.
const enc = new TextEncoder();
const dec = new TextDecoder();

export const FRAME_VERSION = 1;
export const PAD = 128; // el texto se rellena a multiplos de esto
export const FRESH_MS = 5 * 60 * 1000; // un marco mas viejo (o del futuro) que esto se descarta
export const MAX_FRAME = 200 * 1024;
const SALT = enc.encode('venus-voice-backup/v1');
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 simbolos: sin I, O, 0 ni 1 (como los codigos de sala)
export const SECRET_RE = /^[A-Za-z0-9_-]{24,64}$/;

const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

// Secreto nuevo para una sala de emergencia: 24 simbolos de 5 bits = 120 bits
export function newSecret(len = 24) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = '';
  for (const b of bytes) out += ALPHABET[b % 32];
  return out;
}

// Tema y clave de una sala a partir de su secreto
export async function deriveRoom(secret) {
  if (typeof secret !== 'string' || !SECRET_RE.test(secret)) throw new Error('bad secret');
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveBits', 'deriveKey']);
  const topicBits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: SALT, info: enc.encode('topic') }, base, 128);
  const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: SALT, info: enc.encode('aead') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const topic = `vv1/${toHex(new Uint8Array(topicBits))}`;
  return { topic, key, aad: enc.encode(topic) };
}

// Obj -> bytes. Formato: version(1) | iv(12) | AES-GCM( largo(4) | JSON | ceros hasta multiplo de PAD ), con el tema como AAD
export async function sealFrame(room, obj, { now = Date.now() } = {}) {
  const body = enc.encode(JSON.stringify({ t: now, ...obj }));
  const size = Math.max(PAD, Math.ceil((body.length + 4) / PAD) * PAD);
  if (size > MAX_FRAME) throw new RangeError('frame too big');
  const plain = new Uint8Array(size);
  new DataView(plain.buffer).setUint32(0, body.length);
  plain.set(body, 4);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: room.aad }, room.key, plain));
  const out = new Uint8Array(1 + 12 + ct.length);
  out[0] = FRAME_VERSION;
  out.set(iv, 1);
  out.set(ct, 13);
  return out;
}

// Bytes -> { id, obj } o null (version desconocida, cifrado que no verifica, JSON roto o marco fuera de hora)
export async function openFrame(room, bytes, { now = Date.now() } = {}) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 1 + 12 + 16 + PAD || bytes.length > MAX_FRAME + 64 || bytes[0] !== FRAME_VERSION) return null;
  let plain;
  try {
    plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(1, 13), additionalData: room.aad }, room.key, bytes.subarray(13)));
  } catch {
    return null; // otra clave, otro tema o alguien lo toco
  }
  if (plain.length < 4) return null;
  const len = new DataView(plain.buffer, plain.byteOffset, plain.byteLength).getUint32(0);
  if (len < 2 || len > plain.length - 4) return null;
  let obj;
  try {
    obj = JSON.parse(dec.decode(plain.subarray(4, 4 + len)));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || !Number.isFinite(obj.t) || Math.abs(now - obj.t) > FRESH_MS) return null;
  return { id: toHex(bytes.subarray(1, 13)), obj };
}

// Huella de una clave publica de sesion (JWK de ECDSA P-256): da el nombre de quien entra por el respaldo sin
// que el servidor lo haya registrado ("fb:<huella>"). Se calcula sobre los campos, no sobre el texto.
export async function fingerprint(jwk) {
  const j = typeof jwk === 'string' ? JSON.parse(jwk) : jwk;
  if (!j || j.kty !== 'EC' || j.crv !== 'P-256' || typeof j.x !== 'string' || typeof j.y !== 'string') throw new Error('bad key');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(`${j.kty}|${j.crv}|${j.x}|${j.y}`)));
  return toHex(digest.subarray(0, 10));
}
