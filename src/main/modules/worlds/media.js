'use strict';
// Capturas (screenshots/*.png|jpg|webp) y clips (videos en la carpeta de la instancia, replay_videos/ y
// videos/) de cada instancia, miniaturas en cache (cache/worlds-thumbs) y registro local de los
// archivos compartidos en la nube (data/worlds-shared.json).
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const paths = require('../../core/paths');
const { readJson, writeJson } = require('../../core/util');
const { fileUrl } = require('./level');

const IMAGE = /\.(png|jpe?g|webp)$/i;
const VIDEO = /\.(mp4|webm|mkv|mov|m4v)$/i;
const CLIP_DIRS = ['', 'replay_videos', 'videos', 'recordings', 'clips'];
const THUMB_W = 480;

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime' };

function mimeOf(file) {
  return MIME[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream';
}

function kindOf(file) {
  if (IMAGE.test(file)) return 'screenshot';
  if (VIDEO.test(file)) return 'clip';
  return null;
}

// Fecha del nombre del archivo ("2024-01-15_18.03.11.png", "2024-01-15_18-03-11.mp4") en hora local
function nameTime(file) {
  const m = /(\d{4})-(\d{2})-(\d{2})[_ T](\d{2})[.\-:](\d{2})[.\-:](\d{2})/.exec(path.basename(file));
  if (!m) return 0;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  const ts = d.getTime();
  return Number.isFinite(ts) && ts > 946684800000 ? ts : 0;
}

// Ancho y alto de un PNG (cabecera IHDR) sin decodificar la imagen
async function pngSize(file) {
  let fh = null;
  try {
    fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(24);
    await fh.read(buf, 0, 24, 0);
    if (buf.readUInt32BE(0) !== 0x89504e47 || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

async function listDir(dir, re) {
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = await Promise.all(
    entries
      .filter((e) => e.isFile() && re.test(e.name))
      .map(async (e) => {
        const full = path.join(dir, e.name);
        const st = await fsp.stat(full).catch(() => null);
        return st ? { file: e.name, path: full, size: st.size, mtime: st.mtimeMs, birth: st.birthtimeMs || 0 } : null;
      }),
  );
  return out.filter(Boolean);
}

// Capturas de una instancia: [{ kind, instanceId, file, rel, path, size, mtime, time }]
async function screenshots(inst) {
  const base = path.join(inst.dir, 'screenshots');
  const files = await listDir(base, IMAGE);
  return files.map((f) => ({ kind: 'screenshot', instanceId: inst.id, file: f.file, rel: `screenshots/${f.file}`, path: f.path, size: f.size, mtime: f.mtime, time: nameTime(f.file) || f.mtime }));
}

// Clips de video: raiz de la instancia, replay_videos/, videos/, recordings/, clips/
async function clips(inst) {
  const out = [];
  for (const sub of CLIP_DIRS) {
    const dir = sub ? path.join(inst.dir, sub) : inst.dir;
    for (const f of await listDir(dir, VIDEO)) {
      out.push({ kind: 'clip', instanceId: inst.id, file: f.file, rel: sub ? `${sub}/${f.file}` : f.file, path: f.path, size: f.size, mtime: f.mtime, time: nameTime(f.file) || f.mtime });
    }
  }
  return out;
}

// Ruta de captura o clip valida: dentro de una instancia y en una carpeta de medios conocida.
function checkMediaPath(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return null;
  const full = path.resolve(p);
  const base = path.resolve(paths.instances());
  if (!full.startsWith(base + path.sep)) return null;
  const rel = full.slice(base.length + 1).split(path.sep);
  if (rel.length < 2 || rel.length > 3) return null;
  const name = rel[rel.length - 1];
  if (rel.length === 3) {
    if (rel[1] === 'screenshots' && IMAGE.test(name)) return { full, kind: 'screenshot', instanceId: rel[0] };
    if (CLIP_DIRS.includes(rel[1]) && rel[1] && VIDEO.test(name)) return { full, kind: 'clip', instanceId: rel[0] };
    return null;
  }
  return VIDEO.test(name) ? { full, kind: 'clip', instanceId: rel[0] } : null;
}

// ---------- Miniaturas ----------
const THUMB_DIR = () => paths.cache('worlds-thumbs');
const thumbJobs = new Map();
let thumbQueue = Promise.resolve();

function thumbName(p, st) {
  return `${crypto.createHash('sha1').update(`${p}|${st.size}|${Math.round(st.mtimeMs)}`).digest('hex').slice(0, 24)}.jpg`;
}

async function existingThumb(p) {
  const st = await fsp.stat(p).catch(() => null);
  if (!st) return null;
  const out = path.join(THUMB_DIR(), thumbName(p, st));
  const ok = await fsp
    .stat(out)
    .then((s) => s.size > 0)
    .catch(() => false);
  return ok ? fileUrl(out) : null;
}

// Genera (una a la vez) la miniatura JPEG de una imagen. Devuelve la URL file: o null.
function thumb(p) {
  if (thumbJobs.has(p)) return thumbJobs.get(p);
  const job = (async () => {
    const st = await fsp.stat(p).catch(() => null);
    if (!st || !IMAGE.test(p)) return null;
    const out = path.join(THUMB_DIR(), thumbName(p, st));
    if (await fsp.stat(out).then((s) => s.size > 0).catch(() => false)) return fileUrl(out);
    const run = thumbQueue.then(async () => {
      const { nativeImage } = require('electron');
      const img = nativeImage.createFromPath(p);
      if (img.isEmpty()) return null;
      const { width } = img.getSize();
      const small = width > THUMB_W ? img.resize({ width: THUMB_W, quality: 'good' }) : img;
      await fsp.mkdir(THUMB_DIR(), { recursive: true });
      await fsp.writeFile(out, small.toJPEG(82));
      return fileUrl(out);
    });
    thumbQueue = run.catch(() => null);
    return run;
  })()
    .catch(() => null)
    .finally(() => thumbJobs.delete(p));
  thumbJobs.set(p, job);
  return job;
}

// Limpia miniaturas viejas (mas de 3000 archivos: se borran las mas antiguas)
async function pruneThumbs(max = 3000) {
  let names = [];
  try {
    names = await fsp.readdir(THUMB_DIR());
  } catch {
    return 0;
  }
  if (names.length <= max) return 0;
  const withTime = await Promise.all(names.map(async (n) => ({ n, t: (await fsp.stat(path.join(THUMB_DIR(), n)).catch(() => ({ mtimeMs: 0 }))).mtimeMs })));
  withTime.sort((a, b) => a.t - b.t);
  const drop = withTime.slice(0, names.length - max);
  await Promise.all(drop.map((x) => fsp.rm(path.join(THUMB_DIR(), x.n), { force: true }).catch(() => {})));
  return drop.length;
}

// ---------- Compartidos (registro local) ----------
const SHARED_FILE = () => paths.data('worlds-shared.json');
let shared = null;
let sharedChain = Promise.resolve();

async function loadShared() {
  if (!shared) {
    const raw = await readJson(SHARED_FILE(), null);
    shared = raw && typeof raw.items === 'object' && raw.items ? raw.items : {};
  }
  return shared;
}

// Clave estable de un archivo local: instancia + ruta relativa + tamanio
function sharedKey(item) {
  return `${item.instanceId}|${String(item.rel || '').replace(/\\/g, '/')}|${item.size}`;
}

async function sharedList() {
  return { ...(await loadShared()) };
}

function setShared(key, info) {
  const run = sharedChain.then(async () => {
    if (typeof key !== 'string' || key.length > 600) throw new Error('bad key');
    const all = await loadShared();
    if (info === null || info === undefined) delete all[key];
    else {
      const clean = {
        id: String(info.id || '').slice(0, 64),
        bucket: String(info.bucket || '').slice(0, 40),
        path: String(info.path || '').slice(0, 300),
        url: typeof info.url === 'string' && /^https:\/\//i.test(info.url) ? info.url.slice(0, 2000) : '',
        expiresAt: Number(info.expiresAt) || 0,
        sharedAt: Number(info.sharedAt) || Date.now(),
      };
      all[key] = clean;
    }
    await writeJson(SHARED_FILE(), { version: 1, items: all });
    return all[key] || null;
  });
  sharedChain = run.catch(() => {});
  return run;
}

module.exports = { IMAGE, VIDEO, CLIP_DIRS, mimeOf, kindOf, nameTime, pngSize, screenshots, clips, checkMediaPath, thumb, existingThumb, pruneThumbs, sharedKey, sharedList, setShared };
