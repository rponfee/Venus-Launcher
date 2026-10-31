'use strict';
// Lectura de mundos: level.dat (nombre, modo, dificultad, version, semilla...), tiempo jugado segun las
// estadisticas del juego, tamanio en disco (con cache) e icono. Todo con cache por fecha de modificacion
// para que listar decenas de mundos de varias instancias sea rapido.
const fsp = require('fs/promises');
const path = require('path');
const { pathToFileURL } = require('url');
const nbt = require('../../core/nbt');
const paths = require('../../core/paths');
const { readJson, writeJson, dirSize } = require('../../core/util');

const GAME_MODES = ['survival', 'creative', 'adventure', 'spectator'];
const DIFFICULTIES = ['peaceful', 'easy', 'normal', 'hard'];

// Nombre de carpeta seguro: un solo segmento, sin separadores ni caracteres de control.
function validSegment(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= 255 && s !== '.' && s !== '..' && s.trim() === s && !/[\\/\x00-\x1f<>:"|?*]/.test(s);
}

const toNum = (v) => (typeof v === 'bigint' ? Number(v) : Number(v) || 0);

function fileUrl(p, version) {
  const href = pathToFileURL(p).href;
  return version ? `${href}?v=${Math.round(version)}` : href;
}

// Tipo de mundo: default, flat, amplified, large_biomes, single_biome, custom, debug
function worldTypeOf(d) {
  const gen = d?.WorldGenSettings?.dimensions?.['minecraft:overworld']?.generator;
  if (gen && typeof gen === 'object') {
    const type = String(gen.type || '').replace(/^minecraft:/, '');
    if (type === 'flat') return 'flat';
    if (type === 'debug') return 'debug';
    if (type === 'noise') {
      if (typeof gen.settings === 'string') {
        const s = gen.settings.replace(/^minecraft:/, '');
        if (s === 'amplified') return 'amplified';
        if (s === 'large_biomes') return 'large_biomes';
        if (s !== 'overworld') return 'custom';
      } else if (gen.settings && typeof gen.settings === 'object') return 'custom';
      const bs = String(gen.biome_source?.type || '').replace(/^minecraft:/, '');
      if (bs === 'fixed') return 'single_biome';
      return 'default';
    }
    return type ? 'custom' : null;
  }
  const legacy = typeof d?.generatorName === 'string' ? d.generatorName.toLowerCase() : '';
  if (!legacy) return null;
  if (legacy === 'default' || legacy === 'default_1_1') return 'default';
  if (legacy === 'flat') return 'flat';
  if (legacy === 'largebiomes') return 'large_biomes';
  if (legacy === 'amplified') return 'amplified';
  if (legacy === 'buffet') return 'single_biome';
  if (legacy.startsWith('debug')) return 'debug';
  return 'custom';
}

function seedOf(d) {
  const ws = d?.WorldGenSettings;
  if (ws && ws.seed !== undefined) return String(ws.seed);
  if (d?.RandomSeed !== undefined) return String(d.RandomSeed);
  return null;
}

function difficultyOf(d) {
  const raw = d?.Difficulty ?? d?.difficulty_settings?.difficulty;
  if (typeof raw === 'string') {
    const k = raw.replace(/^minecraft:/, '').toLowerCase();
    return DIFFICULTIES.includes(k) ? k : null;
  }
  if (raw === undefined || raw === null) return null;
  return DIFFICULTIES[toNum(raw)] || null;
}

// ---------- level.dat con cache ----------
const levelCache = new Map(); // ruta -> { mtimeMs, size, value }

function parseLevel(root) {
  const d = root?.Data || root?.data || {};
  const mode = d.GameType === undefined ? null : toNum(d.GameType);
  const hardcore = Boolean(toNum(d.hardcore));
  return {
    levelName: typeof d.LevelName === 'string' && d.LevelName.trim() ? d.LevelName.trim() : null,
    lastPlayed: toNum(d.LastPlayed),
    gameMode: mode === null ? null : GAME_MODES[mode] || null,
    hardcore,
    difficulty: hardcore ? 'hard' : difficultyOf(d),
    difficultyLocked: Boolean(toNum(d.DifficultyLocked)),
    cheats: Boolean(toNum(d.allowCommands)),
    version: typeof d.Version?.Name === 'string' ? d.Version.Name : null,
    snapshot: Boolean(toNum(d.Version?.Snapshot)),
    dataVersion: toNum(d.DataVersion) || toNum(d.Version?.Id) || null,
    seed: seedOf(d),
    worldType: worldTypeOf(d),
    time: toNum(d.Time),
    dayTime: toNum(d.DayTime),
    raining: Boolean(toNum(d.raining)),
    thundering: Boolean(toNum(d.thundering)),
    hostPlayer: Boolean(d.Player && typeof d.Player === 'object'),
    datapacksEnabled: Array.isArray(d.DataPacks?.Enabled) ? d.DataPacks.Enabled.length : null,
  };
}

async function readLevel(worldDir) {
  const file = path.join(worldDir, 'level.dat');
  const st = await fsp.stat(file).catch(() => null);
  if (!st || !st.isFile()) {
    levelCache.delete(file);
    return null;
  }
  const hit = levelCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return { ...hit.value, levelMtime: st.mtimeMs };
  let value = null;
  try {
    value = parseLevel((await nbt.readFile(file)).value);
  } catch {
    // level.dat danado: se intenta con la copia que deja el juego
    try {
      value = { ...parseLevel((await nbt.readFile(`${file}_old`)).value), damaged: true };
    } catch {
      value = { damaged: true, levelName: null, lastPlayed: 0, gameMode: null, hardcore: false, difficulty: null, cheats: false, version: null, dataVersion: null, seed: null, worldType: null, time: 0, dayTime: 0 };
    }
  }
  levelCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
  if (levelCache.size > 2000) levelCache.delete(levelCache.keys().next().value);
  return { ...value, levelMtime: st.mtimeMs };
}

// ---------- Tiempo jugado (estadisticas del juego) ----------
const statCache = new Map(); // ruta -> { mtimeMs, size, ticks }

function playTicks(json) {
  if (!json || typeof json !== 'object') return 0;
  const custom = json.stats?.['minecraft:custom'];
  if (custom && typeof custom === 'object') return toNum(custom['minecraft:play_time'] ?? custom['minecraft:play_one_minute']);
  return toNum(json['stat.playOneMinute']); // formato de 1.12 o anterior
}

async function fileTicks(file) {
  const st = await fsp.stat(file).catch(() => null);
  if (!st || !st.isFile()) return 0;
  const hit = statCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.ticks;
  let ticks = 0;
  try {
    ticks = playTicks(JSON.parse(await fsp.readFile(file, 'utf8')));
  } catch {
    ticks = 0;
  }
  statCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, ticks });
  if (statCache.size > 3000) statCache.delete(statCache.keys().next().value);
  return ticks;
}

async function jsonFiles(dir) {
  try {
    return (await fsp.readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.json')).map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

const uuidOf = (file) => path.basename(file, path.extname(file)).replace(/-/g, '').toLowerCase();

// Tiempo dentro del juego (ms): suma de las cuentas del launcher; si ninguna jugo ahi, el mayor.
async function playtime(worldDir, known = new Set()) {
  const files = await jsonFiles(path.join(worldDir, 'stats'));
  if (!files.length) return 0;
  const mine = files.filter((f) => known.has(uuidOf(f)));
  const ticks = await Promise.all((mine.length ? mine : files).map(fileTicks));
  const total = mine.length ? ticks.reduce((a, b) => a + b, 0) : Math.max(0, ...ticks);
  return total * 50;
}

// UUID (sin guiones) de las cuentas del launcher, para elegir las estadisticas propias.
let knownMemo = null;
async function knownUuids() {
  if (knownMemo && Date.now() - knownMemo.at < 60000) return knownMemo.set;
  let set = new Set();
  try {
    const r = await require('../../core/accounts').list();
    set = new Set((r?.accounts || []).map((a) => String(a.uuid || '').replace(/-/g, '').toLowerCase()).filter(Boolean));
  } catch {
    set = new Set();
  }
  knownMemo = { at: Date.now(), set };
  return set;
}

// ---------- Tamanio en disco (cache en cache/worlds-sizes.json) ----------
const SIZE_FILE = () => paths.cache('worlds-sizes.json');
let sizes = null;
let sizesDirty = false;
let sizesTimer = null;
const computing = new Map(); // clave -> Promise

async function loadSizes() {
  if (!sizes) {
    const data = await readJson(SIZE_FILE(), null);
    sizes = data && typeof data === 'object' && data.items && typeof data.items === 'object' ? data.items : {};
  }
  return sizes;
}

function saveSizesSoon() {
  sizesDirty = true;
  if (sizesTimer) return;
  sizesTimer = setTimeout(async () => {
    sizesTimer = null;
    if (!sizesDirty) return;
    sizesDirty = false;
    await writeJson(SIZE_FILE(), { version: 1, items: sizes || {} }).catch(() => {});
  }, 1500);
  sizesTimer.unref?.();
}

const sizeKey = (instanceId, folder) => `${instanceId}/${folder}`;

// Tamanio guardado si sigue valido (el level.dat no cambio desde que se midio)
async function cachedSize(instanceId, folder, levelMtime) {
  const all = await loadSizes();
  const hit = all[sizeKey(instanceId, folder)];
  return hit && hit.levelMtime === levelMtime ? hit.size : null;
}

async function measure(instanceId, folder, worldDir, levelMtime) {
  const key = sizeKey(instanceId, folder);
  if (computing.has(key)) return computing.get(key);
  const run = (async () => {
    const size = await dirSize(worldDir);
    const all = await loadSizes();
    all[key] = { size, levelMtime, at: Date.now() };
    saveSizesSoon();
    return size;
  })().finally(() => computing.delete(key));
  computing.set(key, run);
  return run;
}

async function forgetSize(instanceId, folder) {
  const all = await loadSizes();
  if (all[sizeKey(instanceId, folder)]) {
    delete all[sizeKey(instanceId, folder)];
    saveSizesSoon();
  }
}

async function flushSizes() {
  if (sizesTimer) {
    clearTimeout(sizesTimer);
    sizesTimer = null;
  }
  if (sizesDirty && sizes) {
    sizesDirty = false;
    await writeJson(SIZE_FILE(), { version: 1, items: sizes }).catch(() => {});
  }
}

// ---------- Mundos de una instancia ----------

// Carpetas de saves/ que tienen level.dat
async function folders(instDir) {
  const saves = path.join(instDir, 'saves');
  let entries = [];
  try {
    entries = await fsp.readdir(saves, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = await Promise.all(
    entries
      .filter((e) => e.isDirectory() && validSegment(e.name))
      .map(async (e) => {
        const ok = await fsp
          .stat(path.join(saves, e.name, 'level.dat'))
          .then((s) => s.isFile())
          .catch(() => false);
        return ok ? e.name : null;
      }),
  );
  return out.filter(Boolean);
}

async function iconOf(worldDir) {
  const file = path.join(worldDir, 'icon.png');
  const st = await fsp.stat(file).catch(() => null);
  return st && st.isFile() ? { path: file, url: fileUrl(file, st.mtimeMs) } : null;
}

async function birthOf(worldDir) {
  const st = await fsp.stat(worldDir).catch(() => null);
  if (!st) return 0;
  const b = st.birthtimeMs;
  return b && b > 946684800000 ? b : 0; // sin fecha de creacion confiable (algunos sistemas de archivos)
}

/**
 * Datos de un mundo para listas y fichas.
 * inst: { id, name, dir, mcVersion, loader, preset }
 */
async function describe(inst, folder, { known, withSize = 'cached' } = {}) {
  const worldDir = path.join(inst.dir, 'saves', folder);
  const level = await readLevel(worldDir);
  if (!level) return null;
  const [icon, ms, birth] = await Promise.all([iconOf(worldDir), playtime(worldDir, known || (await knownUuids())), birthOf(worldDir)]);
  let size = await cachedSize(inst.id, folder, level.levelMtime);
  if (size === null && withSize === 'compute') size = await measure(inst.id, folder, worldDir, level.levelMtime);
  return {
    instanceId: inst.id,
    instanceName: inst.name || inst.id,
    instanceVersion: inst.mcVersion || null,
    instanceLoader: inst.preset === 'iris' ? 'iris' : inst.loader || 'vanilla',
    folder,
    name: level.levelName || folder,
    levelName: level.levelName,
    icon: icon ? icon.url : null,
    iconPath: icon ? icon.path : null,
    gameMode: level.gameMode,
    hardcore: level.hardcore,
    difficulty: level.difficulty,
    difficultyLocked: Boolean(level.difficultyLocked),
    cheats: level.cheats,
    version: level.version || null,
    snapshot: Boolean(level.snapshot),
    dataVersion: level.dataVersion,
    lastPlayed: level.lastPlayed > 0 ? level.lastPlayed : Math.round(level.levelMtime),
    seed: level.seed,
    worldType: level.worldType,
    days: level.time > 0 ? Math.floor(level.time / 24000) : 0,
    size,
    playtime: ms,
    birth: birth || null,
    damaged: Boolean(level.damaged),
    hostPlayer: Boolean(level.hostPlayer),
    levelMtime: level.levelMtime,
  };
}

module.exports = {
  GAME_MODES,
  DIFFICULTIES,
  validSegment,
  fileUrl,
  readLevel,
  parseLevel,
  playtime,
  playTicks,
  knownUuids,
  cachedSize,
  measure,
  forgetSize,
  flushSizes,
  folders,
  describe,
  jsonFiles,
  uuidOf,
  worldTypeOf,
  seedOf,
};
