// Stickers y emojis propios de Mensajes (3.3). Cada cuenta sube los suyos (PNG, WebP o GIF, hasta 256 KB y 320 px): hasta
// 30, o 100 con Premium. Cada sticker tiene un nombre: se manda como imagen o se escribe :nombre: en el texto.
//   - El mensaje de un sticker es solo la direccion del archivo, igual que un GIF de KLIPY. Se dibuja como imagen solo si
//     es del bucket de este proyecto y de la carpeta del que escribio; cualquier otra cosa sigue siendo texto.
//   - Los :nombre: se buscan solo en la lista del que escribio el mensaje (RPC sticker_emojis).
// Servidor: supabase/migrations/0030_stickers.sql. La nube se importa recien al usarla: lo de arriba se prueba con Node.
// Los errores llevan err.code: session, type, decode, too_big, gif_too_big, bad_name, name_taken, limit_reached,
// user_muted, user_banned, unavailable o network.

export const STICKER_BUCKET = 'stickers';
export const STICKER_LIMITS = { bytes: 262144, px: 320, free: 30, premium: 100, nameMin: 2, nameMax: 24, sourceBytes: 20 * 1024 * 1024, perMessage: 20 };

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const FILE_RE = new RegExp(`^(${UUID})/(${UUID})\\.(png|webp|gif)$`);
const NAME_RE = /^[a-z0-9_]{2,24}$/;
const EMOJI_RE = /:([a-z0-9_]{2,24}):/g;
const CACHE_MS = 5 * 60_000;

export class StickerError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

// ---------- Direcciones ----------
const publicPrefix = (base) => `${String(base || '').replace(/\/+$/, '')}/storage/v1/object/public/${STICKER_BUCKET}/`;

// Direccion publica de un archivo del bucket
export const stickerUrl = (path, base) => `${publicPrefix(base)}${path}`;

// { userId, id, ext, path } si la direccion es exactamente un archivo del bucket de ESTE proyecto; si no, null.
// Otro proyecto de Supabase con un bucket del mismo nombre no pasa: base es la direccion de cloud.config.
export function parseStickerUrl(url, base) {
  if (typeof url !== 'string' || !base || url.length > 400) return null;
  const prefix = publicPrefix(base);
  if (!url.startsWith(prefix)) return null;
  const m = FILE_RE.exec(url.slice(prefix.length));
  return m ? { userId: m[1], id: m[2], ext: m[3], path: url.slice(prefix.length) } : null;
}

// Sticker de un mensaje: el cuerpo es solo una direccion del bucket, en la carpeta del que lo escribio
export function stickerInMessage(body, senderId, base) {
  const s = String(body ?? '').trim();
  if (!s || /\s/.test(s)) return null;
  const p = parseStickerUrl(s, base);
  return p && senderId && p.userId === senderId ? { ...p, url: s } : null;
}

// ---------- Nombres y :emojis: ----------
export const isStickerName = (name) => typeof name === 'string' && NAME_RE.test(name);

// Nombre sugerido a partir de lo que escribe el usuario o del nombre del archivo
export function cleanStickerName(raw) {
  return String(raw ?? '')
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, STICKER_LIMITS.nameMax);
}

// Nombres :asi: de un texto, sin repetir y con tope (un mensaje no puede pedir mil)
export function emojiNames(text) {
  const out = new Set();
  for (const m of String(text ?? '').matchAll(EMOJI_RE)) {
    out.add(m[1]);
    if (out.size >= STICKER_LIMITS.perMessage) break;
  }
  return [...out];
}

// Parte un texto en pedazos: cadenas y { name, url } para los :nombre: que lookup(nombre) conoce. Lo que no se conoce
// (o no tiene direccion) sigue siendo texto tal cual.
export function splitEmojis(text, lookup) {
  const s = String(text ?? '');
  const out = [];
  let last = 0;
  let shown = 0;
  for (const m of s.matchAll(EMOJI_RE)) {
    const url = shown < STICKER_LIMITS.perMessage ? lookup?.(m[1]) : null;
    if (!url) continue;
    if (m.index > last) out.push(s.slice(last, m.index));
    out.push({ name: m[1], url });
    last = m.index + m[0].length;
    shown++;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

// ---------- Archivos ----------
// Tipo real por los primeros bytes (la extension o el type del archivo no alcanzan)
export function sniffImage(b) {
  if (!b || b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

export const extOfMime = (mime) => ({ 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' })[mime] || null;

// Tamaño que entra en el maximo sin agrandar ni deformar
export function fitInside(width, height, max = STICKER_LIMITS.px) {
  const scale = Math.min(1, max / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

// Que hacer con la imagen elegida: 'keep' (se sube tal cual, conserva la animacion), 'resize' (se achica y se pasa a
// WebP, queda quieta) o 'gif_too_big' (un GIF animado no se puede achicar sin un codificador: se pide uno mas chico).
export function uploadPlan({ mime, bytes, width, height }) {
  if (bytes <= STICKER_LIMITS.bytes && Math.max(width, height) <= STICKER_LIMITS.px) return 'keep';
  return mime === 'image/gif' ? 'gif_too_big' : 'resize';
}

// Error del servidor o de Storage -> codigo estable
export function stickerError(err) {
  if (err instanceof StickerError) return err;
  const msg = String(err?.message || err || '');
  const code = String(err?.code || '');
  for (const known of ['limit_reached', 'name_taken', 'bad_name', 'too_big', 'bad_type', 'no_file', 'user_muted', 'user_banned', 'not_found', 'bad_id']) {
    if (msg.includes(known)) return new StickerError(known === 'bad_type' ? 'type' : known === 'no_file' || known === 'bad_id' ? 'unavailable' : known, msg);
  }
  const status = Number(err?.statusCode || err?.status || 0);
  if (status === 413 || /maximum allowed size|too large|payload/i.test(msg)) return new StickerError('too_big', msg);
  if (/mime type|invalid_mime/i.test(msg)) return new StickerError('type', msg);
  if (/row-level security|violates/i.test(msg) || status === 403) return new StickerError('denied', msg);
  if (['PGRST202', 'PGRST205', '42883', '42P01'].includes(code) || /could not find the (function|table)|does not exist|bucket not found/i.test(msg)) return new StickerError('unavailable', msg);
  if (/jwt|session/i.test(msg) || status === 401) return new StickerError('session', msg);
  return new StickerError('network', msg);
}

// ---------- Servidor ----------
let cloudRef = null;
async function session() {
  if (!cloudRef) cloudRef = (await import('../cloud.js')).cloud;
  await cloudRef.ready?.();
  if (!cloudRef.client || !cloudRef.isSignedIn()) throw new StickerError('session');
  return { client: cloudRef.client, uid: cloudRef.user.id, base: cloudRef.config?.url };
}

// Le agrega la direccion a lo que devuelve el servidor (y descarta lo que no sea del bucket propio)
function withUrl(row, base) {
  const url = stickerUrl(row?.path, base);
  const p = parseStickerUrl(url, base);
  return p && p.userId === row.userId ? { ...row, url } : null;
}

export async function listMine() {
  const { client, base } = await session();
  const { data, error } = await client.rpc('sticker_mine');
  if (error) throw stickerError(error);
  const items = (Array.isArray(data?.items) ? data.items : []).map((r) => withUrl(r, base)).filter(Boolean);
  return { items, max: Number(data?.max) || STICKER_LIMITS.free, premium: Boolean(data?.premium), blocked: data?.blocked || null };
}

// Archivo elegido -> { blob, mime, width, height } listo para subir. Solo con DOM (createImageBitmap y canvas).
export async function prepareImage(file) {
  if (!file || !(file.size > 0)) throw new StickerError('decode');
  if (file.size > STICKER_LIMITS.sourceBytes) throw new StickerError('too_big');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = sniffImage(bytes);
  if (!mime) throw new StickerError('type');
  let bmp;
  try {
    bmp = await createImageBitmap(new Blob([bytes], { type: mime }));
  } catch {
    throw new StickerError('decode');
  }
  try {
    const { width, height } = bmp;
    const plan = uploadPlan({ mime, bytes: bytes.length, width, height });
    if (plan === 'gif_too_big') throw new StickerError('gif_too_big');
    if (plan === 'keep') return { blob: new Blob([bytes], { type: mime }), mime, width, height };
    // Se achica a 320 px y, si todavia pesa de mas, se baja la calidad y despues el tamaño
    let size = fitInside(width, height);
    for (let attempt = 0; attempt < 6; attempt++) {
      const canvas = document.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
      canvas.getContext('2d').drawImage(bmp, 0, 0, size.width, size.height);
      for (const q of [0.9, 0.75, 0.6]) {
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', q));
        if (blob && blob.size <= STICKER_LIMITS.bytes && blob.type === 'image/webp') return { blob, mime: 'image/webp', width: size.width, height: size.height };
      }
      size = fitInside(size.width, size.height, Math.round(Math.max(size.width, size.height) * 0.75));
    }
    throw new StickerError('too_big');
  } finally {
    bmp.close?.();
  }
}

// Sube el archivo y lo registra. Si el registro falla, el archivo no queda suelto.
export async function createSticker(prepared, name) {
  const clean = String(name ?? '').trim().toLowerCase();
  if (!isStickerName(clean)) throw new StickerError('bad_name');
  const ext = extOfMime(prepared?.mime);
  if (!ext || !prepared.blob || prepared.blob.size > STICKER_LIMITS.bytes) throw new StickerError('too_big');
  const { client, uid, base } = await session();
  const id = crypto.randomUUID();
  const path = `${uid}/${id}.${ext}`;
  const bucket = client.storage.from(STICKER_BUCKET);
  const up = await bucket.upload(path, prepared.blob, { contentType: prepared.mime, cacheControl: '3600', upsert: false });
  if (up.error) throw stickerError(up.error);
  const { data, error } = await client.rpc('sticker_create', { p_id: id, p_name: clean, p_ext: ext });
  if (error) {
    await bucket.remove([path]).catch(() => {});
    throw stickerError(error);
  }
  forgetOwner(uid);
  return withUrl(data, base);
}

export async function deleteSticker(item) {
  const { client, uid } = await session();
  const { data, error } = await client.rpc('sticker_delete', { p_id: item.id });
  if (error) throw stickerError(error);
  const removed = await client.storage.from(STICKER_BUCKET).remove([data?.path || item.path]);
  if (removed.error) console.warn('[stickers] no se pudo borrar el archivo:', removed.error.message);
  byId.set(item.id, { at: Date.now(), item: null });
  forgetOwner(uid);
}

// ---------- Mostrar los de otros (con caché de 5 minutos) ----------
const byId = new Map(); // id -> { at, item | null }
const byOwner = new Map(); // dueño -> Map(nombre -> { at, item | null })
let idWaiters = new Map();
let idTimer = null;

function forgetOwner(owner) {
  byOwner.delete(owner);
}

async function flushIds() {
  const waiters = idWaiters;
  idWaiters = new Map();
  idTimer = null;
  const ids = [...waiters.keys()].slice(0, 60);
  for (const extra of [...waiters.keys()].slice(60)) resolveSticker(extra).then((v) => waiters.get(extra).forEach((fn) => fn(v)));
  let rows = null;
  let base = null;
  try {
    const s = await session();
    base = s.base;
    const { data, error } = await s.client.rpc('sticker_resolve', { p_ids: ids });
    if (error) throw error;
    rows = Array.isArray(data) ? data : [];
  } catch (err) {
    console.warn('[stickers] resolver:', err?.message || err);
  }
  for (const id of ids) {
    // Sin respuesta del servidor no se sabe: undefined (la imagen se muestra igual, si esta en el bucket propio)
    let value;
    if (rows) {
      const row = rows.find((r) => r?.id === id);
      value = row ? withUrl(row, base) : null;
      byId.set(id, { at: Date.now(), item: value });
    }
    waiters.get(id).forEach((fn) => fn(value));
  }
}

// El sticker con ese id, null si ya no existe, undefined si no se pudo preguntar. Los pedidos se juntan en una tanda.
export function resolveSticker(id) {
  const hit = byId.get(id);
  if (hit && Date.now() - hit.at < CACHE_MS) return Promise.resolve(hit.item);
  return new Promise((resolve) => {
    if (!idWaiters.has(id)) idWaiters.set(id, []);
    idWaiters.get(id).push(resolve);
    if (!idTimer) idTimer = setTimeout(flushIds, 40);
  });
}

// Direccion ya conocida de un :nombre: de ese usuario: texto, null (no tiene ese nombre) o undefined (no se pregunto)
export function cachedEmoji(owner, name) {
  const hit = byOwner.get(owner)?.get(name);
  return hit && Date.now() - hit.at < CACHE_MS ? (hit.item?.url ?? null) : undefined;
}

export const cachedEmojiItem = (owner, name) => byOwner.get(owner)?.get(name)?.item || null;

// Pregunta los nombres que faltan de ese usuario. Devuelve true si aprendio alguno nuevo.
export async function resolveEmojis(owner, names) {
  const missing = [...new Set(names)].filter((n) => cachedEmoji(owner, n) === undefined).slice(0, 40);
  if (!owner || !missing.length) return false;
  const s = await session();
  const { data, error } = await s.client.rpc('sticker_emojis', { p_user: owner, p_names: missing });
  if (error) throw stickerError(error);
  if (!byOwner.has(owner)) byOwner.set(owner, new Map());
  const known = byOwner.get(owner);
  const rows = Array.isArray(data) ? data : [];
  let learned = false;
  for (const name of missing) {
    const row = rows.find((r) => r?.name === name && r?.userId === owner);
    const item = row ? withUrl(row, s.base) : null;
    known.set(name, { at: Date.now(), item });
    if (item) learned = true;
  }
  return learned;
}
