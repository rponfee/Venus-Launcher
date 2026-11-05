// Imagenes del perfil: se recortan, se achican y se comprimen en la PC antes de subirlas al bucket publico
// profile-media (carpeta <userId>/, hasta 12 archivos de 4 MB; desde la 4.6 sin GIF para nadie: 0039_perfil_circular_banners.sql).
// El banner propio es solo una imagen quieta: GIF, APNG y WebP animado se rechazan mirando el contenido (bannerSourceError).
// Los errores llevan err.code: 'type', 'animated', 'too_big', 'decode', 'limit', 'denied', 'unavailable', 'network', 'session'.
import { cloud } from '../../cloud.js';
import { LIMITS, bannerSourceError, cropRect, fitSize, mediaFileName, orphanMedia } from './model.js';

const BUCKET = 'profile-media';
const SOURCE_MAX = 30 * 1024 * 1024; // archivo de origen (antes de comprimir)
const TARGET = LIMITS.fileBytes - 200 * 1024; // margen bajo el limite del bucket
const STATIC_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

export class MediaError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

export function loadImage(src, { cors = false } = {}) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (cors) img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new MediaError('decode'));
    img.src = src;
  });
}

// Archivo elegido -> imagen cargada (para recortar varias veces sin volver a leerlo).
// still: true (el banner) mira el contenido del archivo y rechaza lo que se mueve (GIF, APNG, WebP animado) o no es PNG, JPG ni WebP,
// diga lo que diga la extension o el type.
export async function readImageFile(file, { still = false } = {}) {
  if (!file || (!still && !STATIC_TYPES.includes(file.type))) throw new MediaError('type');
  if (file.size > SOURCE_MAX) throw new MediaError('too_big');
  if (still) {
    let bytes;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      throw new MediaError('decode');
    }
    const why = bannerSourceError(bytes);
    if (why) throw new MediaError(why);
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    if (!img.naturalWidth || !img.naturalHeight) throw new MediaError('decode');
    return { img, url, type: file.type, size: file.size };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err instanceof MediaError ? err : new MediaError('decode');
  }
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, quality));
}

// WebP con la mejor calidad que entre en el limite (JPEG si el WebP no se puede armar)
async function encode(canvas) {
  for (const type of ['image/webp', 'image/jpeg']) {
    for (let q = 0.9; q >= 0.45; q -= 0.12) {
      let blob = null;
      try {
        blob = await toBlob(canvas, type, q);
      } catch {
        blob = null;
      }
      if (!blob) break;
      if (blob.type !== type) break;
      if (blob.size <= TARGET) return { blob, ext: type === 'image/webp' ? 'webp' : 'jpg' };
    }
  }
  throw new MediaError('too_big');
}

function draw(img, rect, size) {
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const g = canvas.getContext('2d');
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, size.width, size.height);
  return canvas;
}

// Banner: recorte 4:1 (focus mueve el recorte) y como mucho 1200 x 300
export async function bannerFromImage(img, focus = 0.5) {
  const rect = cropRect(img.naturalWidth, img.naturalHeight, LIMITS.bannerW / LIMITS.bannerH, focus);
  const size = fitSize(rect.sw, rect.sh, LIMITS.bannerW, LIMITS.bannerH);
  const { blob, ext } = await encode(draw(img, rect, size));
  return { blob, ext, url: URL.createObjectURL(blob), width: size.width, height: size.height };
}

// Captura destacada: sin recorte, como mucho 1600 x 900
export async function featuredFromImage(img) {
  const rect = { sx: 0, sy: 0, sw: img.naturalWidth, sh: img.naturalHeight };
  const size = fitSize(rect.sw, rect.sh, LIMITS.featuredW, LIMITS.featuredH);
  const { blob, ext } = await encode(draw(img, rect, size));
  return { blob, ext, url: URL.createObjectURL(blob), width: size.width, height: size.height };
}

// Imagen que llega de otra parte del launcher (Capturas y clips): URL file:/data:/blob: o un Blob
export async function featuredFromSource(src) {
  if (src instanceof Blob) {
    const url = URL.createObjectURL(src);
    try {
      return await featuredFromImage(await loadImage(url));
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  if (typeof src !== 'string' || !/^(file:|data:image\/|blob:)/.test(src)) throw new MediaError('type');
  try {
    return await featuredFromImage(await loadImage(src));
  } catch (err) {
    throw err instanceof MediaError ? err : new MediaError('decode');
  }
}

// ---------- Bucket ----------
export function storageError(error) {
  const msg = String(error?.message || error || '');
  const status = Number(error?.statusCode || error?.status || 0);
  if (status === 413 || /maximum allowed size|too large|payload/i.test(msg)) return new MediaError('too_big', msg);
  if (/row-level security|violates|unauthorized|not allowed/i.test(msg) || status === 403) return new MediaError('denied', msg);
  if (/bucket not found|not found/i.test(msg) || status === 404) return new MediaError('unavailable', msg);
  if (/jwt|session/i.test(msg) || status === 401) return new MediaError('session', msg);
  return new MediaError('network', msg);
}

export function requireSession() {
  if (!cloud.client || !cloud.isSignedIn()) throw new MediaError('session');
  return { client: cloud.client, uid: cloud.user.id };
}

export async function listOwnMedia() {
  const { client, uid } = requireSession();
  const { data, error } = await client.storage.from(BUCKET).list(uid, { limit: 100 });
  if (error) throw storageError(error);
  return (data || []).filter((f) => f && f.name && f.id !== null);
}

export async function removeMedia(names) {
  const list = (names || []).filter(Boolean);
  if (!list.length) return;
  const { client, uid } = requireSession();
  const { error } = await client.storage.from(BUCKET).remove(list.map((n) => `${uid}/${n}`));
  if (error) throw storageError(error);
}

// Antes de subir: borra los archivos propios que ya no usa nada si no entran los nuevos (limite de 12)
export async function makeRoom(keepUrls, needed = 1) {
  const files = await listOwnMedia();
  if (files.length + needed <= LIMITS.files) return;
  const orphans = orphanMedia(files, keepUrls);
  const excess = files.length + needed - LIMITS.files;
  await removeMedia(orphans.slice(0, Math.max(excess, 0)));
  if (files.length - Math.min(orphans.length, excess) + needed > LIMITS.files) throw new MediaError('limit');
}

// Sube y devuelve la URL publica
export async function uploadMedia(blob, { kind, ext }) {
  const { client, uid } = requireSession();
  if (!blob || blob.size > LIMITS.fileBytes) throw new MediaError('too_big');
  // Ultima barrera: lo que sube un banner nunca es un GIF, un APNG ni un WebP animado (sale de un lienzo, pero se mira igual)
  if (kind === 'banner') {
    const why = bannerSourceError(new Uint8Array(await blob.arrayBuffer()));
    if (why) throw new MediaError(why);
  }
  const name = mediaFileName(kind, ext);
  const type = { webp: 'image/webp', jpg: 'image/jpeg', png: 'image/png' }[ext] || 'image/webp';
  const { error } = await client.storage.from(BUCKET).upload(`${uid}/${name}`, blob, { contentType: type, cacheControl: '31536000', upsert: false });
  if (error) throw storageError(error);
  const { data } = client.storage.from(BUCKET).getPublicUrl(`${uid}/${name}`);
  if (!data?.publicUrl) throw new MediaError('unavailable');
  return data.publicUrl;
}
