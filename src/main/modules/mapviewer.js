'use strict';
// Visor de mapas: vista desde arriba de cualquier mundo guardado, sin abrir el juego.
// Cada region (r.X.Z.mca) se dibuja como una tesela PNG de 512x512 en un grupo de hilos y se guarda en
// <datos>/cache/maps/<instancia>/<mundo>/<dimension>/r.X.Z.png (se vuelve a dibujar si cambia la region).
// Canales:
//   mapviewer:info(instanceId, world) -> { world, dimensions, regions: { [dim]: [[rx, rz]...] }, spawn, players }
//   mapviewer:tile(instanceId, world, dimension, rx, rz) -> { url, empty, chunks, legacy, cached } (dibuja si hace falta)
//   mapviewer:renderAll(instanceId, world, dimension, { force }?) -> tarea con progreso -> { total, rendered, cached, failed }
//   mapviewer:saveImage(bytes PNG, nombreSugerido) -> dialogo para guardar -> { path, bytes } | null
//   mapviewer:reveal(ruta) -> muestra en la carpeta una imagen exportada en esta sesion
// Evento hacia la interfaz: 'mapviewer:tileReady' ({ instanceId, world, dimension, rx, rz, url, empty })
const fsp = require('fs/promises');
const path = require('path');
const { pathToFileURL } = require('url');
const paths = require('../core/paths');
const nbt = require('../core/nbt');
const tasks = require('../core/tasks');
const instances = require('../core/instances');
const { t } = require('../core/i18n');
const { readJson, writeJson, sanitizeFileName } = require('../core/util');
const anvil = require('./mapviewer/anvil');
const { Pool } = require('./mapviewer/pool');

// Subir este numero cuando cambie el dibujo: invalida las teselas guardadas
const RENDER_VERSION = 1;
const VANILLA = {
  'minecraft:overworld': { folder: '', kind: 'overworld' },
  'minecraft:the_nether': { folder: 'DIM-1', kind: 'nether' },
  'minecraft:the_end': { folder: 'DIM1', kind: 'end' },
};
const LEGACY_DIMS = { 0: 'minecraft:overworld', '-1': 'minecraft:the_nether', 1: 'minecraft:the_end' };
const ID_PART = /^[a-z0-9_.-]+$/;
const MAX_PLAYERS = 100;
const MAX_IMAGE = 256 * 1024 * 1024;

let ctx = null;
let pool = null;
const inflight = new Map(); // ruta del png -> promesa (con .handle del pool)
const running = new Map(); // renderAll en curso
const indexes = new Map(); // carpeta de cache -> Promise<indice>
const dimCache = new Map(); // carpeta del mundo -> { at, dims }
const exported = new Set();

function getPool() {
  if (!pool) pool = new Pool();
  return pool;
}

// ---------- Rutas ----------
function validName(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= 255 && s !== '.' && s !== '..' && s.trim() === s && !/[\\/\x00-\x1f<>:"|?*]/.test(s);
}

function safe(p) {
  if (ctx?.safePath) return ctx.safePath(p);
  const full = path.resolve(p);
  const root = path.resolve(paths.root());
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error(t('mapviewer.errWorld'));
  return full;
}

function instanceDir(instanceId) {
  try {
    return instances.dir(instanceId);
  } catch {
    throw new Error(t('mapviewer.errInstance'));
  }
}

async function worldDir(instanceId, world) {
  if (!validName(world)) throw new Error(t('mapviewer.errWorld'));
  const dir = safe(path.join(instanceDir(instanceId), 'saves', world));
  const st = await fsp.stat(dir).catch(() => null);
  if (!st || !st.isDirectory()) throw new Error(t('mapviewer.errWorld'));
  return dir;
}

function dimKind(id) {
  return VANILLA[id]?.kind || 'overworld';
}

function dimSlug(id) {
  return String(id).replace(/[^a-z0-9_.-]+/gi, '_');
}

async function isDir(p) {
  const st = await fsp.stat(p).catch(() => null);
  return Boolean(st && st.isDirectory());
}

async function subdirs(p) {
  try {
    return (await fsp.readdir(p, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

// Dimensiones con carpeta region: las vanilla, las de datapacks (dimensions/<ns>/<ruta>) y las DIMn de mods viejos
async function discoverDimensions(wdir) {
  const cached = dimCache.get(wdir);
  if (cached && Date.now() - cached.at < 8000) return cached.dims;
  const found = new Map();
  const add = async (id, dir, kind) => {
    const regionDir = path.join(dir, 'region');
    if (!(await isDir(regionDir))) return;
    const list = await anvil.listRegions(regionDir);
    const prev = found.get(id);
    if (prev && prev.regions.length >= list.regions.length) return;
    found.set(id, { id, kind, dir, regionDir, regions: list.regions, mcregion: list.mcregion });
  };
  for (const [id, v] of Object.entries(VANILLA)) await add(id, v.folder ? path.join(wdir, v.folder) : wdir, v.kind);
  const base = path.join(wdir, 'dimensions');
  for (const ns of await subdirs(base)) {
    if (!ID_PART.test(ns)) continue;
    const walk = async (rel, depth) => {
      const dir = path.join(base, ns, ...rel);
      if (rel.length && (await isDir(path.join(dir, 'region')))) await add(`${ns}:${rel.join('/')}`, dir, dimKind(`${ns}:${rel.join('/')}`));
      if (depth >= 3) return;
      for (const name of await subdirs(dir)) if (ID_PART.test(name) && name !== 'region' && name !== 'entities' && name !== 'poi' && name !== 'data') await walk([...rel, name], depth + 1);
    };
    await walk([], 0);
  }
  for (const name of await subdirs(wdir)) {
    if (/^DIM-?\d+$/.test(name) && name !== 'DIM-1' && name !== 'DIM1') await add(`folder:${name}`, path.join(wdir, name), 'overworld');
  }
  const dims = [...found.values()];
  dimCache.set(wdir, { at: Date.now(), dims });
  return dims;
}

async function resolveDimension(wdir, id) {
  if (typeof id !== 'string' || !id || id.length > 200) throw new Error(t('mapviewer.errDimension'));
  let dims = await discoverDimensions(wdir);
  let dim = dims.find((d) => d.id === id);
  if (!dim) {
    dimCache.delete(wdir);
    dims = await discoverDimensions(wdir);
    dim = dims.find((d) => d.id === id);
  }
  if (!dim) throw new Error(t('mapviewer.errDimension'));
  safe(dim.regionDir);
  return dim;
}

// Carpetas posibles de una dimension a partir de su id (sin listar regiones: lo usan las teselas)
function dimensionCandidates(wdir, id) {
  if (typeof id !== 'string' || !id || id.length > 200) throw new Error(t('mapviewer.errDimension'));
  if (VANILLA[id]) {
    const v = VANILLA[id];
    return [v.folder ? path.join(wdir, v.folder) : wdir, path.join(wdir, 'dimensions', 'minecraft', id.slice(10))];
  }
  let m = /^folder:(DIM-?\d+)$/.exec(id);
  if (m) return [path.join(wdir, m[1])];
  m = /^([a-z0-9_.-]+):([a-z0-9_./-]+)$/.exec(id);
  const parts = m ? m[2].split('/') : [];
  if (!m || m[1] === '.' || m[1] === '..' || !parts.every((p) => ID_PART.test(p) && p !== '.' && p !== '..')) throw new Error(t('mapviewer.errDimension'));
  return [path.join(wdir, 'dimensions', m[1], ...parts)];
}

// ---------- Indice de la cache (fecha y tamano de cada region dibujada) ----------
function cacheDir(instanceId, world, dimId) {
  return paths.cache('maps', instanceId, world, dimSlug(dimId));
}

function loadIndex(dir) {
  if (!indexes.has(dir)) {
    const file = path.join(dir, 'index.json');
    indexes.set(
      dir,
      readJson(file, null).then((data) => ({
        file,
        timer: null,
        data: data && data.v === RENDER_VERSION && data.tiles && typeof data.tiles === 'object' ? data : { v: RENDER_VERSION, tiles: {} },
      })),
    );
  }
  return indexes.get(dir);
}

function saveIndexSoon(idx) {
  clearTimeout(idx.timer);
  idx.timer = setTimeout(() => {
    idx.timer = null;
    writeJson(idx.file, idx.data).catch((err) => console.warn('[mapviewer] No se pudo guardar el indice:', err.message));
  }, 800);
}

async function flushIndexes() {
  const all = await Promise.all([...indexes.values()].map((p) => p.catch(() => null)));
  await Promise.all(
    all.filter((idx) => idx && idx.timer).map((idx) => {
      clearTimeout(idx.timer);
      idx.timer = null;
      return writeJson(idx.file, idx.data).catch(() => {});
    }),
  );
}

function tileUrl(file, entry) {
  return `${pathToFileURL(file).href}?v=${encodeURIComponent(`${entry.m}-${entry.s}-${RENDER_VERSION}`)}`;
}

function tileResult(entry, file, cached) {
  return {
    url: entry.e ? null : tileUrl(file, entry),
    empty: Boolean(entry.e),
    chunks: entry.c || 0,
    legacy: entry.l || 0,
    unsupported: entry.u || 0,
    cached,
  };
}

// Devuelve la tesela de una region (de la cache o dibujandola). st = stat del .mca
async function ensureTile(dim, dir, rx, rz, st, priority, force = false) {
  const idx = await loadIndex(dir);
  const key = `${rx},${rz}`;
  const out = path.join(dir, `r.${rx}.${rz}.png`);
  const mtime = Math.round(st.mtimeMs);
  const prev = idx.data.tiles[key];
  if (!force && prev && prev.m === mtime && prev.s === st.size) {
    if (prev.e) return tileResult(prev, out, true);
    if (await fsp.stat(out).catch(() => null)) return tileResult(prev, out, true);
  }
  const pending = inflight.get(out);
  if (pending) {
    if (priority === 'high') getPool().promote(pending.handle);
    return pending;
  }
  const file = path.join(dim.regionDir, `r.${rx}.${rz}.mca`);
  const job = getPool().run({ file, dim: dim.kind, out }, priority);
  const promise = job
    .then((r) => {
      const entry = { m: mtime, s: st.size, e: r.empty ? 1 : 0, c: r.chunks, l: r.legacy, u: r.unsupported };
      idx.data.tiles[key] = entry;
      saveIndexSoon(idx);
      return tileResult(entry, out, false);
    })
    .catch((err) => {
      throw new Error(t('mapviewer.errRender', { x: rx, z: rz, error: err.message }));
    })
    .finally(() => inflight.delete(out));
  promise.handle = job.handle;
  inflight.set(out, promise);
  return promise;
}

function checkCoord(v) {
  if (!Number.isInteger(v) || Math.abs(v) > 1e6) throw new Error(t('mapviewer.errRegion'));
  return v;
}

async function tile(instanceId, world, dimension, rx, rz) {
  checkCoord(rx);
  checkCoord(rz);
  const wdir = await worldDir(instanceId, world);
  for (const base of dimensionCandidates(wdir, dimension)) {
    const regionDir = safe(path.join(base, 'region'));
    const st = await fsp.stat(path.join(regionDir, `r.${rx}.${rz}.mca`)).catch(() => null);
    if (!st || !st.isFile()) continue;
    if (st.size <= anvil.HEADER_SIZE) break;
    const dim = { id: dimension, kind: dimKind(dimension), regionDir };
    return ensureTile(dim, cacheDir(instanceId, world, dimension), rx, rz, st, 'high');
  }
  return { url: null, empty: true, chunks: 0, legacy: 0, unsupported: 0, cached: true };
}

// ---------- level.dat, jugadores y nombres ----------
function uuidFromInts(arr) {
  if (!arr || arr.length !== 4) return null;
  return Array.from(arr, (v) => (v >>> 0).toString(16).padStart(8, '0')).join('');
}

function uuidFromLongs(most, least) {
  if (typeof most !== 'bigint' || typeof least !== 'bigint') return null;
  return BigInt.asUintN(64, most).toString(16).padStart(16, '0') + BigInt.asUintN(64, least).toString(16).padStart(16, '0');
}

function dashed(u) {
  const s = String(u || '').replace(/-/g, '').toLowerCase();
  if (s.length !== 32) return s;
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

function playerDimension(v) {
  if (typeof v === 'string') return v.includes(':') ? v : `minecraft:${v}`;
  if (typeof v === 'number') return LEGACY_DIMS[v] || `folder:DIM${v}`;
  return 'minecraft:overworld';
}

function playerFrom(tag, uuid) {
  const pos = Array.isArray(tag?.Pos) ? tag.Pos.map(Number) : null;
  if (!pos || pos.length < 3 || pos.some((n) => !Number.isFinite(n))) return null;
  return {
    uuid: uuid || uuidFromInts(tag.UUID) || uuidFromLongs(tag.UUIDMost, tag.UUIDLeast) || null,
    x: pos[0],
    y: pos[1],
    z: pos[2],
    dimension: playerDimension(tag.Dimension),
  };
}

async function knownNames(instanceId) {
  const names = new Map();
  try {
    const cache = await readJson(path.join(instanceDir(instanceId), 'usercache.json'), []);
    if (Array.isArray(cache)) for (const e of cache) if (e && typeof e.uuid === 'string' && typeof e.name === 'string') names.set(e.uuid.replace(/-/g, '').toLowerCase(), e.name);
  } catch {
    /* sin cache de nombres */
  }
  try {
    const accounts = await require('../core/accounts').list();
    for (const a of accounts?.accounts || []) if (a?.uuid && a?.name) names.set(String(a.uuid).replace(/-/g, '').toLowerCase(), a.name);
  } catch {
    /* sin cuentas */
  }
  return names;
}

async function readPlayers(wdir, instanceId, level) {
  const names = await knownNames(instanceId);
  const out = [];
  const seen = new Set();
  const host = level?.Player ? playerFrom(level.Player) : null;
  if (host) {
    host.host = true;
    out.push(host);
    if (host.uuid) seen.add(host.uuid.replace(/-/g, ''));
  }
  const dir = path.join(wdir, 'playerdata');
  let files = [];
  try {
    files = (await fsp.readdir(dir)).filter((f) => /^[0-9a-f-]{32,36}\.dat$/i.test(f));
  } catch {
    files = [];
  }
  const stats = await Promise.all(files.map((f) => fsp.stat(path.join(dir, f)).then((st) => ({ f, m: st.mtimeMs })).catch(() => null)));
  const recent = stats.filter(Boolean).sort((a, b) => b.m - a.m).slice(0, MAX_PLAYERS);
  for (const { f, m } of recent) {
    const uuid = f.slice(0, -4).replace(/-/g, '').toLowerCase();
    if (seen.has(uuid)) continue;
    try {
      const data = (await nbt.readFile(path.join(dir, f))).value;
      const p = playerFrom(data, uuid);
      if (!p) continue;
      p.lastSeen = Math.round(m);
      out.push(p);
      seen.add(uuid);
    } catch {
      /* archivo de jugador danado */
    }
  }
  return out.map((p) => {
    const key = (p.uuid || '').replace(/-/g, '');
    return { ...p, uuid: p.uuid ? dashed(p.uuid) : null, name: names.get(key) || null, host: Boolean(p.host) };
  });
}

function readSpawn(level) {
  if (!level) return null;
  if (Number.isFinite(level.SpawnX) && Number.isFinite(level.SpawnZ)) {
    return { x: level.SpawnX, y: Number.isFinite(level.SpawnY) ? level.SpawnY : null, z: level.SpawnZ, dimension: 'minecraft:overworld' };
  }
  // 1.21.9+: spawn { dimension, pos: [x, y, z] }
  const s = level.spawn;
  const pos = s?.pos;
  if (pos && pos.length >= 3) return { x: Number(pos[0]), y: Number(pos[1]), z: Number(pos[2]), dimension: typeof s.dimension === 'string' ? s.dimension : 'minecraft:overworld' };
  return null;
}

async function info(instanceId, world) {
  const wdir = await worldDir(instanceId, world);
  let level = null;
  try {
    level = (await nbt.readFile(path.join(wdir, 'level.dat'))).value?.Data || null;
  } catch {
    level = null;
  }
  dimCache.delete(wdir);
  const dims = await discoverDimensions(wdir);
  const regions = {};
  const dimensions = dims.map((d) => {
    regions[d.id] = d.regions.map((r) => [r.rx, r.rz]);
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const r of d.regions) {
      minX = Math.min(minX, r.rx);
      minZ = Math.min(minZ, r.rz);
      maxX = Math.max(maxX, r.rx);
      maxZ = Math.max(maxZ, r.rz);
    }
    return {
      id: d.id,
      kind: d.kind,
      regionCount: d.regions.length,
      bounds: d.regions.length ? { minX: minX * 512, minZ: minZ * 512, maxX: maxX * 512 + 511, maxZ: maxZ * 512 + 511 } : null,
      unsupported: !d.regions.length && d.mcregion ? 'mcregion' : null,
    };
  });
  const order = ['minecraft:overworld', 'minecraft:the_nether', 'minecraft:the_end'];
  dimensions.sort((a, b) => (order.indexOf(a.id) + 1 || 99) - (order.indexOf(b.id) + 1 || 99) || a.id.localeCompare(b.id));
  const dataVersion = Number.isFinite(level?.DataVersion) ? level.DataVersion : null;
  let unsupported = null;
  if (!dimensions.some((d) => d.regionCount)) {
    if (dimensions.some((d) => d.unsupported === 'mcregion')) unsupported = 'mcregion';
    else if (await isDir(path.join(wdir, '0'))) unsupported = 'alpha';
  }
  // Las dimensiones con carpeta pero sin regiones (nunca se jugaron) no se muestran, salvo que no haya otras
  const withRegions = dimensions.filter((d) => d.regionCount);
  return {
    world: {
      folder: world,
      name: typeof level?.LevelName === 'string' && level.LevelName.trim() ? level.LevelName.trim() : world,
      version: typeof level?.Version?.Name === 'string' ? level.Version.Name : null,
      dataVersion,
      legacy: dataVersion !== null ? dataVersion < 1451 : Boolean(level && level.version === 19133),
      unsupported,
    },
    dimensions: withRegions.length ? withRegions : dimensions,
    regions,
    spawn: readSpawn(level),
    players: await readPlayers(wdir, instanceId, level),
  };
}

// ---------- Renderizar todo ----------
function dimensionLabel(id) {
  const kind = VANILLA[id]?.kind;
  return kind ? t(`mapviewer.dim_${kind}`) : id.replace(/^folder:/, '');
}

async function renderAll(instanceId, world, dimension, opts = {}) {
  const wdir = await worldDir(instanceId, world);
  dimCache.delete(wdir);
  const dim = await resolveDimension(wdir, dimension);
  const key = `${instanceId}\n${world}\n${dim.id}`;
  if (running.has(key)) return running.get(key);
  const dir = cacheDir(instanceId, world, dim.id);
  let levelName = world;
  let spawn = { x: 0, z: 0 };
  try {
    const level = (await nbt.readFile(path.join(wdir, 'level.dat'))).value?.Data;
    if (typeof level?.LevelName === 'string' && level.LevelName.trim()) levelName = level.LevelName.trim();
    const s = readSpawn(level);
    if (s) spawn = s;
  } catch {
    /* sin level.dat */
  }
  // Primero las regiones cercanas al punto de aparicion (en el Nether, las coordenadas se dividen por 8)
  const f = dim.kind === 'nether' ? 1 / 8 : 1;
  const cx = (spawn.x * f) / 512;
  const cz = (spawn.z * f) / 512;
  const queue = [...dim.regions].sort((a, b) => Math.hypot(a.rx + 0.5 - cx, a.rz + 0.5 - cz) - Math.hypot(b.rx + 0.5 - cx, b.rz + 0.5 - cz));
  const title = t('mapviewer.taskTitle', { world: levelName, dimension: dimensionLabel(dim.id) });
  const promise = tasks
    .run(
      title,
      async (task) => {
        const total = queue.length;
        const stats = { total, rendered: 0, cached: 0, failed: 0, empty: 0 };
        let done = 0;
        task.update({ detail: t('mapviewer.taskProgress', { done: 0, total }), progress: total ? 0 : null });
        const lanes = Math.max(1, getPool().size);
        await Promise.all(
          Array.from({ length: lanes }, async () => {
            while (queue.length && !task.signal.aborted) {
              const r = queue.shift();
              try {
                const st = await fsp.stat(r.file);
                const res = await ensureTile(dim, dir, r.rx, r.rz, st, 'low', Boolean(opts.force));
                if (res.cached) stats.cached++;
                else stats.rendered++;
                if (res.empty) stats.empty++;
                if (!res.cached) ctx?.send?.('mapviewer:tileReady', { instanceId, world, dimension: dim.id, rx: r.rx, rz: r.rz, url: res.url, empty: res.empty });
              } catch (err) {
                stats.failed++;
                console.warn('[mapviewer]', err.message);
              }
              done++;
              task.update({ detail: t('mapviewer.taskProgress', { done, total }), progress: total ? done / total : 1 });
            }
          }),
        );
        if (task.signal.aborted) throw new Error(t('mapviewer.canceled'));
        return stats;
      },
      { mapviewer: { instanceId, world, dimension: dim.id } },
    )
    .finally(() => running.delete(key));
  running.set(key, promise);
  return promise;
}

// ---------- Exportar ----------
function toBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  return null;
}

async function saveImage(bytes, suggested) {
  const buf = toBuffer(bytes);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!buf || buf.length < 16 || buf.length > MAX_IMAGE || sig.some((b, i) => buf[i] !== b)) throw new Error(t('mapviewer.errImage'));
  const { dialog, app } = require('electron');
  const win = ctx?.getWindow?.();
  let dirPath;
  try {
    dirPath = app.getPath('pictures');
  } catch {
    dirPath = app.getPath('documents');
  }
  const base = sanitizeFileName(typeof suggested === 'string' && suggested.trim() ? suggested : t('mapviewer.fileName')).replace(/\.png$/i, '');
  const opts = {
    title: t('mapviewer.saveTitle'),
    defaultPath: path.join(dirPath, `${base}.png`),
    filters: [{ name: t('mapviewer.filterPng'), extensions: ['png'] }],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  };
  const r = win && !win.isDestroyed() ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
  if (r.canceled || !r.filePath) return null;
  const target = /\.png$/i.test(r.filePath) ? r.filePath : `${r.filePath}.png`;
  try {
    await fsp.writeFile(target, buf);
  } catch (err) {
    throw new Error(t('mapviewer.errSave', { error: err.message }));
  }
  exported.add(path.resolve(target));
  return { path: target, bytes: buf.length };
}

function reveal(p) {
  const full = typeof p === 'string' ? path.resolve(p) : '';
  if (!exported.has(full)) throw new Error(t('mapviewer.errReveal'));
  require('electron').shell.showItemInFolder(full);
  return true;
}

function register(context) {
  ctx = context;
  const { handle, onQuit } = context;
  handle('mapviewer:info', (instanceId, world) => info(instanceId, world));
  handle('mapviewer:tile', (instanceId, world, dimension, rx, rz) => tile(instanceId, world, dimension, rx, rz));
  handle('mapviewer:renderAll', (instanceId, world, dimension, opts) => renderAll(instanceId, world, dimension, opts || {}));
  handle('mapviewer:saveImage', (bytes, suggested) => saveImage(bytes, suggested));
  handle('mapviewer:reveal', (p) => reveal(p));
  onQuit(async () => {
    await flushIndexes();
    if (pool) await pool.close();
    pool = null;
  });
}

// Para pruebas desde Node: usar sin Electron (sin safePath ni send)
function configure(context) {
  ctx = context || null;
}

module.exports = { register, configure, info, tile, renderAll, flushIndexes, discoverDimensions, getPool, RENDER_VERSION };
