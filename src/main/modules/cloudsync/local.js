'use strict';
// Parte local de la nube: estado de sincronizacion por instancia, huella de cada mundo (para saber si
// cambio desde la ultima sincronizacion), compresion en partes de 45 MB y el paquete de configuraciones
// (opciones, controles, lista de servidores y configs de mods).
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const paths = require('../../core/paths');
const { readJson, writeJson, uid } = require('../../core/util');
const { ZipWriter } = require('./zipstream');

const PART_SIZE = 45 * 1024 * 1024; // el plan gratuito de Supabase acepta hasta 50 MB por archivo
const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const STATE_FILE = 'cloudsync.json';
const VENUS_DIR = '.venus';
const SKIP_WORLD = new Set(['session.lock']);
const CONFIG_ROOT_FILES = ['options.txt', 'optionsof.txt', 'optionsshaders.txt', 'servers.dat'];
const CONFIG_MAX_FILE = 512 * 1024;
const CONFIG_MAX_TOTAL = 20 * 1024 * 1024;
const MAX_WORLD = 3.5 * 1024 * 1024 * 1024;
const MAX_FILES = 60000;

function validSegment(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= 255 && s !== '.' && s !== '..' && s.trim() === s && !/[\\/\x00-\x1f<>:"|?*]/.test(s);
}

function slug(s, max = 40) {
  return String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, max)
    .replace(/[-._]+$/g, '');
}

const sha1 = (s) => crypto.createHash('sha1').update(String(s), 'utf8').digest('hex');

// Clave de la instancia en la nube (se puede vincular a otra para seguir la misma copia en dos PCs).
function defaultKey(instanceId) {
  const s = slug(instanceId, 56);
  return KEY_RE.test(s) ? s : `instancia-${sha1(instanceId).slice(0, 8)}`;
}

// Segmento seguro para Storage (solo ASCII): "Mi Mundo ñ" -> "mi-mundo-n-1a2b3c4d"
function worldKey(folder) {
  return `${slug(folder, 40) || 'mundo'}-${sha1(folder).slice(0, 8)}`;
}

// ---------- Dispositivo ----------

let deviceCache = null;
async function device() {
  if (deviceCache) return deviceCache;
  const file = paths.data(STATE_FILE);
  const data = await readJson(file, {});
  if (typeof data.deviceId !== 'string' || !/^[a-z0-9]{8,32}$/.test(data.deviceId)) {
    data.deviceId = uid(16);
    await writeJson(file, data).catch(() => {});
  }
  deviceCache = { id: data.deviceId, name: (os.hostname() || 'PC').slice(0, 64) };
  return deviceCache;
}

// ---------- Estado por instancia (<instancia>/.venus/cloudsync.json) ----------

function defaults(inst) {
  return { v: 1, instanceId: inst.id, key: defaultKey(inst.id), auto: false, autoSince: 0, configs: true, worlds: {}, config: null };
}

// Si la carpeta se duplico, el estado es de otra instancia: se empieza de cero (si no, dos instancias
// pisarian la misma copia en la nube).
async function readState(inst) {
  const raw = await readJson(path.join(inst.dir, VENUS_DIR, STATE_FILE), null);
  if (!raw || raw.v !== 1 || raw.instanceId !== inst.id) return defaults(inst);
  const s = { ...defaults(inst), ...raw };
  if (!KEY_RE.test(s.key)) s.key = defaultKey(inst.id);
  if (!s.worlds || typeof s.worlds !== 'object') s.worlds = {};
  return s;
}

async function writeState(inst, state) {
  await writeJson(path.join(inst.dir, VENUS_DIR, STATE_FILE), { ...state, v: 1, instanceId: inst.id });
}

// ---------- Mundos ----------

async function walk(dir, rel, out, skipTop) {
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!validSegment(e.name)) continue;
    if (!rel && skipTop?.has(e.name)) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, r, out, skipTop);
    else if (e.isFile()) {
      const st = await fsp.stat(full).catch(() => null);
      if (st) out.push({ rel: r, full, size: st.size, mtime: Math.round(st.mtimeMs) });
    }
    if (out.length > MAX_FILES) return;
  }
}

async function listWorldFiles(worldDir) {
  const out = [];
  await walk(worldDir, '', out, SKIP_WORLD);
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

// Huella del mundo: rutas + tamaños + fechas. Se recalcula solo si cambio el level.dat (el juego lo
// reescribe en cada guardado), asi la vista de muchos mundos no recorre todos los archivos cada vez.
const stampCache = new Map();
async function worldStamp(worldDir, { force = false } = {}) {
  const level = await fsp.stat(path.join(worldDir, 'level.dat')).catch(() => null);
  if (!level) return null;
  const sig = `${level.size}:${Math.round(level.mtimeMs)}`;
  const hit = stampCache.get(worldDir);
  if (!force && hit && hit.sig === sig) return hit.value;
  const list = await listWorldFiles(worldDir);
  const h = crypto.createHash('sha1');
  let size = 0;
  for (const f of list) {
    h.update(`${f.rel}\u0000${f.size}\u0000${f.mtime}\n`);
    size += f.size;
  }
  const value = { stamp: h.digest('hex'), size, files: list.length };
  stampCache.set(worldDir, { sig, value });
  return value;
}

function forgetStamp(worldDir) {
  stampCache.delete(worldDir);
}

// ---------- Partes de 45 MB (con sha1 del total) ----------

class PartSink {
  constructor(dir, partSize = PART_SIZE) {
    this.dir = dir;
    this.partSize = partSize;
    this.fh = null;
    this.inPart = 0;
    this.parts = [];
    this.size = 0;
    this.hash = crypto.createHash('sha1');
  }

  async _next() {
    if (this.fh) await this.fh.close();
    const p = path.join(this.dir, `part-${String(this.parts.length).padStart(3, '0')}`);
    this.fh = await fsp.open(p, 'w');
    this.parts.push(p);
    this.inPart = 0;
  }

  async write(buf) {
    this.hash.update(buf);
    this.size += buf.length;
    let off = 0;
    while (off < buf.length) {
      if (!this.fh || this.inPart >= this.partSize) await this._next();
      const n = Math.min(buf.length - off, this.partSize - this.inPart);
      let done = 0;
      while (done < n) {
        const { bytesWritten } = await this.fh.write(buf, off + done, n - done);
        done += bytesWritten;
      }
      off += n;
      this.inPart += n;
    }
  }

  async close() {
    if (!this.fh) await this._next();
    await this.fh.close();
    this.fh = null;
    return { parts: this.parts, size: this.size, sha1: this.hash.digest('hex') };
  }
}

async function tempDir(label) {
  return fsp.mkdtemp(path.join(os.tmpdir(), `venus-cloudsync-${label}-`));
}

/** Comprime una lista de archivos [{ rel, full }] en partes dentro de dir. */
async function zipToParts(list, dir, { signal, onBytes, partSize } = {}) {
  const sink = new PartSink(dir, partSize);
  const zw = new ZipWriter(sink, { level: 6 });
  let ok = false;
  try {
    for (const f of list) {
      if (signal?.aborted) throw signal.reason || new Error('aborted');
      await zw.addFile(f.rel, f.full, { mtime: f.mtime, signal, onBytes });
    }
    await zw.finish();
    ok = true;
  } finally {
    // si fallo, se cierra el archivo abierto (la carpeta temporal la borra quien llama)
    if (!ok) await sink.close().catch(() => {});
  }
  return sink.close();
}

// ---------- Paquete de configuraciones ----------

async function configFiles(instDir) {
  const out = [];
  for (const name of CONFIG_ROOT_FILES) {
    const full = path.join(instDir, name);
    const st = await fsp.stat(full).catch(() => null);
    if (st?.isFile() && st.size <= CONFIG_MAX_FILE) out.push({ rel: name, full, size: st.size, mtime: Math.round(st.mtimeMs) });
  }
  const cfg = [];
  await walk(path.join(instDir, 'config'), '', cfg, null);
  let total = out.reduce((a, f) => a + f.size, 0);
  for (const f of cfg.sort((a, b) => (a.rel < b.rel ? -1 : 1))) {
    if (f.size > CONFIG_MAX_FILE || total + f.size > CONFIG_MAX_TOTAL || f.rel.split('/').some((s) => s.startsWith('.'))) continue;
    total += f.size;
    out.push({ ...f, rel: `config/${f.rel}` });
  }
  return out;
}

// Huella por contenido (el juego reescribe options.txt al cerrar aunque no cambie nada).
async function configStamp(instDir) {
  const list = await configFiles(instDir);
  if (!list.length) return null;
  const h = crypto.createHash('sha1');
  let size = 0;
  for (const f of list) {
    const data = await fsp.readFile(f.full).catch(() => null);
    if (!data) continue;
    h.update(`${f.rel}\u0000${crypto.createHash('sha1').update(data).digest('hex')}\n`);
    size += data.length;
  }
  return { stamp: h.digest('hex'), size, files: list.length, list };
}

// Copia de seguridad de las configs locales antes de pisarlas con las de la nube (se guardan las 5 ultimas).
async function backupConfigs(instDir) {
  const list = await configFiles(instDir);
  if (!list.length) return null;
  const dir = path.join(instDir, VENUS_DIR, 'cloudsync-backup');
  await fsp.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `config-${stamp}.zip`);
  const fh = await fsp.open(file, 'w');
  try {
    const zw = new ZipWriter({ write: (b) => fh.write(b) });
    for (const f of list) await zw.addFile(f.rel, f.full, { mtime: f.mtime });
    await zw.finish();
  } finally {
    await fh.close();
  }
  const old = (await fsp.readdir(dir).catch(() => [])).filter((n) => /^config-.*\.zip$/.test(n)).sort();
  for (const n of old.slice(0, Math.max(0, old.length - 5))) await fsp.rm(path.join(dir, n), { force: true }).catch(() => {});
  return file;
}

function existsSync(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  PART_SIZE,
  KEY_RE,
  MAX_WORLD,
  MAX_FILES,
  VENUS_DIR,
  CONFIG_ROOT_FILES,
  validSegment,
  slug,
  defaultKey,
  worldKey,
  device,
  readState,
  writeState,
  listWorldFiles,
  worldStamp,
  forgetStamp,
  PartSink,
  tempDir,
  zipToParts,
  configFiles,
  configStamp,
  backupConfigs,
  existsSync,
};
