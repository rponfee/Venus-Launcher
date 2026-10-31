'use strict';
// Estadisticas dentro del juego: lee saves/<mundo>/stats/*.json (formato 1.13+ y el plano de 1.12 o anterior),
// advancements/*.json y level.dat de cada mundo, y arma totales, rankings y progreso de logros.
// Todo se cachea por archivo (fecha de modificacion + tamano): las lecturas siguientes solo hacen stat().
const fsp = require('fs/promises');
const path = require('path');
const nbt = require('../../core/nbt');
const gamedata = require('./gamedata');

const STAT_TYPES = {
  'minecraft:custom': 'custom',
  'minecraft:mined': 'mined',
  'minecraft:killed': 'killed',
  'minecraft:killed_by': 'killedBy',
  'minecraft:crafted': 'crafted',
  'minecraft:used': 'used',
  'minecraft:broken': 'broken',
  'minecraft:picked_up': 'pickedUp',
  'minecraft:dropped': 'dropped',
};
const KINDS = ['custom', 'mined', 'killed', 'killedBy', 'crafted', 'used', 'broken', 'pickedUp', 'dropped'];
const CATEGORIES = ['story', 'nether', 'end', 'adventure', 'husbandry'];
const LEGACY_ACHIEVEMENTS_TOTAL = 34; // logros clasicos de 1.4.6 a 1.11
const TICKS = new Set(['play_time', 'total_world_time', 'time_since_death', 'time_since_rest', 'sneak_time']);
const SINGLE_ONLY = new Set(['time_since_death', 'time_since_rest']); // sumarlas entre mundos no tiene sentido
const EXTRA = [
  'animals_bred',
  'fish_caught',
  'traded_with_villager',
  'talked_to_villager',
  'sleep_in_bed',
  'enchant_item',
  'raid_win',
  'open_chest',
  'open_enderchest',
  'open_shulker_box',
  'eat_cake_slice',
  'play_record',
  'play_noteblock',
  'bell_ring',
  'target_hit',
  'damage_blocked_by_shield',
  'leave_game',
  'drop',
  'sneak_time',
  'time_since_death',
  'time_since_rest',
];
const BOSSES = ['minecraft:ender_dragon', 'minecraft:wither', 'minecraft:elder_guardian', 'minecraft:warden'];

// Estadisticas de 1.12 o anterior: "stat.walkOneCm", "stat.mineBlock.minecraft.stone", "stat.killEntity.Zombie"...
const LEGACY_CUSTOM = {
  playOneMinute: 'play_time',
  diveOneCm: 'walk_under_water_one_cm',
  cakeSlicesEaten: 'eat_cake_slice',
  cauldronFilled: 'fill_cauldron',
  cauldronUsed: 'use_cauldron',
  armorCleaned: 'clean_armor',
  bannerCleaned: 'clean_banner',
  brewingstandInteraction: 'interact_with_brewingstand',
  beaconInteraction: 'interact_with_beacon',
  craftingTableInteraction: 'interact_with_crafting_table',
  furnaceInteraction: 'interact_with_furnace',
  dispenserInspected: 'inspect_dispenser',
  dropperInspected: 'inspect_dropper',
  hopperInspected: 'inspect_hopper',
  chestOpened: 'open_chest',
  trappedChestTriggered: 'trigger_trapped_chest',
  enderchestOpened: 'open_enderchest',
  itemEnchanted: 'enchant_item',
  recordPlayed: 'play_record',
  noteblockPlayed: 'play_noteblock',
  noteblockTuned: 'tune_noteblock',
  flowerPotted: 'pot_flower',
  sleepInBed: 'sleep_in_bed',
  shulkerBoxOpened: 'open_shulker_box',
};
const LEGACY_KIND = { mineBlock: 'mined', craftItem: 'crafted', useItem: 'used', breakItem: 'broken', pickup: 'pickedUp', drop: 'dropped', killEntity: 'killed', entityKilledBy: 'killedBy' };
const LEGACY_ENTITY = {
  PigZombie: 'zombified_piglin',
  LavaSlime: 'magma_cube',
  VillagerGolem: 'iron_golem',
  SnowMan: 'snow_golem',
  Ozelot: 'ocelot',
  MushroomCow: 'mooshroom',
  EntityHorse: 'horse',
  WitherBoss: 'wither',
  EnderDragon: 'ender_dragon',
  EvocationIllager: 'evoker',
  VindicationIllager: 'vindicator',
  IllusionIllager: 'illusioner',
};
const ALIASES = { 'minecraft:zombie_pigman': 'minecraft:zombified_piglin', 'minecraft:play_one_minute': 'minecraft:play_time' };

const camelToSnake = (s) =>
  String(s)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();

function fullId(id) {
  const s = String(id).trim().toLowerCase();
  const out = s.includes(':') ? s : `minecraft:${s}`;
  return ALIASES[out] || out;
}

function emptyNorm() {
  const n = { legacyAchievements: [], dataVersion: null };
  for (const k of KINDS) n[k] = {};
  return n;
}

function add(map, id, v) {
  if (!(v > 0)) return;
  const k = fullId(id);
  map[k] = (map[k] || 0) + v;
}

function legacyEntity(name) {
  if (name.includes('.')) return name.replace('.', ':');
  return `minecraft:${LEGACY_ENTITY[name] || camelToSnake(name)}`;
}

// Lleva cualquier formato de archivo de estadisticas a { custom, mined, killed, ... } con ids "ns:id".
function normalize(json) {
  const out = emptyNorm();
  if (!json || typeof json !== 'object') return out;
  if (json.stats && typeof json.stats === 'object') {
    for (const [type, values] of Object.entries(json.stats)) {
      const k = STAT_TYPES[type];
      if (!k || !values || typeof values !== 'object') continue;
      for (const [id, v] of Object.entries(values)) if (typeof v === 'number' && Number.isFinite(v)) add(out[k], id, v);
    }
    out.dataVersion = Number.isFinite(json.DataVersion) ? json.DataVersion : null;
    return out;
  }
  for (const [key, raw] of Object.entries(json)) {
    const v = typeof raw === 'number' ? raw : raw && typeof raw.value === 'number' ? raw.value : 0;
    if (key.startsWith('achievement.')) {
      if (v > 0) out.legacyAchievements.push(key.slice(12));
      continue;
    }
    if (!key.startsWith('stat.') || !(v > 0)) continue;
    const rest = key.slice(5);
    const dot = rest.indexOf('.');
    if (dot < 0) {
      add(out.custom, LEGACY_CUSTOM[rest] || camelToSnake(rest), v);
      continue;
    }
    const kind = LEGACY_KIND[rest.slice(0, dot)];
    if (!kind) continue;
    const id = rest.slice(dot + 1);
    add(out[kind], kind === 'killed' || kind === 'killedBy' ? legacyEntity(id) : id.replace('.', ':'), v);
  }
  return out;
}

function mergeNorm(target, src) {
  for (const k of KINDS) for (const [id, v] of Object.entries(src[k] || {})) target[k][id] = (target[k][id] || 0) + v;
  for (const a of src.legacyAchievements || []) if (!target.legacyAchievements.includes(a)) target.legacyAchievements.push(a);
  if (src.dataVersion && (!target.dataVersion || src.dataVersion > target.dataVersion)) target.dataVersion = src.dataVersion;
  return target;
}

// "2023-06-14 18:03:11 -0300" -> ms
function parseMcDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(String(s || '').trim());
  if (!m) return 0;
  return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7]}${m[8]}:${m[9]}`) || 0;
}

// Logros completos de un archivo advancements/<uuid>.json (sin recetas) -> Map(id -> fecha)
function parseAdvancements(json) {
  const done = new Map();
  if (!json || typeof json !== 'object') return done;
  for (const [id, v] of Object.entries(json)) {
    if (id === 'DataVersion' || !v || typeof v !== 'object' || v.done !== true || id.includes(':recipes/')) continue;
    let at = 0;
    for (const ts of Object.values(v.criteria || {})) {
      const t = parseMcDate(ts);
      if (t > at) at = t;
    }
    done.set(id, at || null);
  }
  return done;
}

// ---------- Lectura con cache ----------
const fileCache = new Map(); // ruta -> { mtimeMs, size, value }
async function cachedRead(file, parse) {
  const st = await fsp.stat(file).catch(() => null);
  if (!st || !st.isFile()) {
    fileCache.delete(file);
    return null;
  }
  const hit = fileCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
  let value = null;
  try {
    value = await parse(file);
  } catch {
    value = null;
  }
  fileCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
  if (fileCache.size > 5000) fileCache.delete(fileCache.keys().next().value);
  return value;
}

const readJsonFile = async (f) => JSON.parse(await fsp.readFile(f, 'utf8'));
const toNum = (v) => (typeof v === 'bigint' ? Number(v) : Number(v) || 0);

function levelInfo(dir) {
  return cachedRead(path.join(dir, 'level.dat'), async (f) => {
    const root = (await nbt.readFile(f)).value || {};
    const d = root.Data || root.data || {};
    return {
      name: typeof d.LevelName === 'string' && d.LevelName.trim() ? d.LevelName.trim() : null,
      lastPlayed: toNum(d.LastPlayed),
      gameMode: d.GameType === undefined ? null : toNum(d.GameType),
      hardcore: Boolean(toNum(d.hardcore)),
      version: typeof d.Version?.Name === 'string' ? d.Version.Name : null,
      dataVersion: toNum(d.DataVersion) || null,
    };
  });
}

async function jsonFiles(dir) {
  try {
    return (await fsp.readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.json')).map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// UUIDs de las cuentas del launcher: si un mundo tiene archivos de varios jugadores (LAN), se usan los propios.
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

const uuidOf = (file) => path.basename(file, path.extname(file)).replace(/-/g, '').toLowerCase();

async function listWorlds(instDir) {
  const saves = path.join(instDir, 'saves');
  let entries = [];
  try {
    entries = await fsp.readdir(saves, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(saves, e.name);
    const ok = await fsp
      .stat(path.join(dir, 'level.dat'))
      .then((st) => st.isFile())
      .catch(() => false);
    if (ok) out.push({ folder: e.name, dir });
  }
  return out;
}

async function readWorld(inst, w, known) {
  const info = (await levelInfo(w.dir)) || {};
  const [statFiles, advFiles] = await Promise.all([jsonFiles(path.join(w.dir, 'stats')), jsonFiles(path.join(w.dir, 'advancements'))]);
  const pick = (files) => {
    const mine = files.filter((f) => known.has(uuidOf(f)));
    return mine.length ? mine : files;
  };
  const norm = emptyNorm();
  for (const f of pick(statFiles)) {
    const n = await cachedRead(f, (p) => readJsonFile(p).then(normalize));
    if (n) mergeNorm(norm, n);
  }
  const adv = new Map();
  for (const f of pick(advFiles)) {
    const m = await cachedRead(f, (p) => readJsonFile(p).then(parseAdvancements));
    if (!m) continue;
    for (const [id, at] of m) {
      const prev = adv.get(id);
      if (prev === undefined || (at && (!prev || at < prev))) adv.set(id, at);
    }
  }
  let lastPlayed = info.lastPlayed || 0;
  if (!lastPlayed) lastPlayed = (await fsp.stat(path.join(w.dir, 'level.dat')).catch(() => null))?.mtimeMs || 0;
  return {
    instanceId: inst.id,
    instanceName: inst.name,
    mcVersion: inst.mcVersion || null,
    loader: inst.preset || inst.loader || 'vanilla',
    folder: w.folder,
    name: info.name || w.folder,
    lastPlayed,
    gameMode: info.gameMode ?? null,
    hardcore: Boolean(info.hardcore),
    version: info.version || null,
    hasStats: statFiles.length > 0,
    players: statFiles.length,
    norm,
    adv,
  };
}

const sumValues = (m) => Object.values(m).reduce((a, b) => a + b, 0);

function summarize(norm, names, { single = false } = {}) {
  const c = norm.custom;
  const g = (k) => c[`minecraft:${k}`] || 0;
  const top = (kind, n = 10) =>
    Object.entries(norm[kind])
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([id, count]) => ({ id, name: names.of(kind, id), count }));
  const distance = Object.entries(c)
    .filter(([k, v]) => k.endsWith('_one_cm') && v > 0)
    .map(([k, cm]) => ({ id: k.replace(/^minecraft:/, ''), name: names.stat(k), cm }))
    .sort((a, b) => b.cm - a.cm);
  const extras = EXTRA.filter((k) => (single || !SINGLE_ONLY.has(k)) && g(k) > 0).map((k) => ({
    id: k,
    name: names.stat(`minecraft:${k}`),
    value: g(k),
    unit: TICKS.has(k) ? 'ticks' : k.startsWith('damage_') ? 'damage' : 'count',
  }));
  return {
    playTimeMs: g('play_time') * 50,
    deaths: g('deaths'),
    mobKills: g('mob_kills'),
    playerKills: g('player_kills'),
    jumps: g('jump'),
    damageDealt: g('damage_dealt') / 20, // en corazones (la estadistica guarda 10x medio corazon)
    damageTaken: g('damage_taken') / 20,
    blocksMined: sumValues(norm.mined),
    itemsCrafted: sumValues(norm.crafted),
    itemsUsed: sumValues(norm.used),
    itemsBroken: sumValues(norm.broken),
    itemsPickedUp: sumValues(norm.pickedUp),
    itemsDropped: sumValues(norm.dropped),
    distanceCm: distance.reduce((a, d) => a + d.cm, 0),
    walkCm: g('walk_one_cm'),
    distance,
    extras,
    bosses: BOSSES.filter((id) => norm.killed[id] > 0).map((id) => ({ id, name: names.of('killed', id), count: norm.killed[id] })),
    totems: norm.used['minecraft:totem_of_undying'] || 0,
    kinds: { mined: Object.keys(norm.mined).length, killed: Object.keys(norm.killed).length, crafted: Object.keys(norm.crafted).length },
    top: { mined: top('mined'), killed: top('killed'), killedBy: top('killedBy'), crafted: top('crafted'), used: top('used'), broken: top('broken'), pickedUp: top('pickedUp') },
  };
}

const categoryOf = (id) => {
  const [ns, p] = gamedata.splitId(id);
  return ns === 'minecraft' ? p.split('/')[0] : 'mods';
};

async function advancementsBlock(worlds, names, { single = false } = {}) {
  const defsByVersion = new Map();
  for (const v of new Set(worlds.map((w) => w.mcVersion).filter(Boolean))) defsByVersion.set(v, await gamedata.advancements(v));
  // Version de referencia: la mas nueva con definiciones disponibles
  let ref = null;
  let refTime = -1;
  for (const [v, defs] of defsByVersion) {
    if (!defs) continue;
    const time = await gamedata.versionTime(v);
    if (time > refTime) {
      ref = v;
      refTime = time;
    }
  }
  const refDefs = ref ? defsByVersion.get(ref) : null;
  const defIndex = new Map();
  for (const defs of defsByVersion.values()) for (const d of defs || []) defIndex.set(d.id, d);
  for (const d of refDefs || []) defIndex.set(d.id, d);
  const titleOf = (id) => {
    const d = defIndex.get(id);
    return (d && (names.text(d.titleKey) || d.title)) || gamedata.prettify(id);
  };
  const descOf = (id) => {
    const d = defIndex.get(id);
    return (d && (names.text(d.descKey) || d.desc)) || null;
  };

  const doneAll = new Map(); // id -> { at, instanceId, folder, world }
  const legacy = new Set();
  for (const w of worlds) {
    for (const [id, at] of w.adv) {
      const prev = doneAll.get(id);
      if (!prev || (at && (!prev.at || at < prev.at))) doneAll.set(id, { at, instanceId: w.instanceId, folder: w.folder, world: w.name });
    }
    for (const a of w.norm.legacyAchievements) legacy.add(a);
  }
  const vanillaIds = [...doneAll.keys()].filter((id) => id.startsWith('minecraft:'));
  const modsDone = doneAll.size - vanillaIds.length;
  const done = refDefs ? refDefs.filter((d) => doneAll.has(d.id)).length : vanillaIds.length;
  const categories = CATEGORIES.map((cat) => ({
    id: cat,
    done: refDefs ? refDefs.filter((d) => d.category === cat && doneAll.has(d.id)).length : vanillaIds.filter((id) => categoryOf(id) === cat).length,
    total: refDefs ? refDefs.filter((d) => d.category === cat).length : null,
  })).filter((c) => c.done > 0 || c.total > 0);

  const recent = [...doneAll]
    .filter(([, v]) => v.at)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, 12)
    .map(([id, v]) => ({ id, title: titleOf(id), desc: descOf(id), frame: defIndex.get(id)?.frame || 'task', category: categoryOf(id), at: v.at, world: v.world, instanceId: v.instanceId, folder: v.folder }));

  const missing =
    single && refDefs
      ? refDefs
          .filter((d) => !doneAll.has(d.id))
          .map((d) => ({ id: d.id, title: d.hidden ? null : titleOf(d.id), desc: d.hidden ? null : descOf(d.id), frame: d.frame, category: d.category, hidden: d.hidden }))
      : null;

  const perWorld = worlds.map((w) => {
    const defs = defsByVersion.get(w.mcVersion);
    const ids = [...w.adv.keys()].filter((id) => id.startsWith('minecraft:'));
    return {
      instanceId: w.instanceId,
      folder: w.folder,
      name: w.name,
      instanceName: w.instanceName,
      mcVersion: w.mcVersion,
      done: defs ? defs.filter((d) => w.adv.has(d.id)).length : ids.length,
      total: defs ? defs.length : null,
    };
  });

  return {
    done,
    total: refDefs ? refDefs.length : null,
    reference: ref,
    categories,
    modsDone,
    recent,
    missing,
    perWorld,
    legacy: legacy.size ? { done: Math.min(legacy.size, LEGACY_ACHIEVEMENTS_TOTAL), total: LEGACY_ACHIEVEMENTS_TOTAL } : null,
  };
}

function worldRow(w, advRow) {
  const c = w.norm.custom;
  const g = (k) => c[`minecraft:${k}`] || 0;
  let distanceCm = 0;
  for (const [k, v] of Object.entries(c)) if (k.endsWith('_one_cm')) distanceCm += v;
  return {
    instanceId: w.instanceId,
    instanceName: w.instanceName,
    mcVersion: w.mcVersion,
    loader: w.loader,
    folder: w.folder,
    name: w.name,
    lastPlayed: w.lastPlayed,
    gameMode: w.gameMode,
    hardcore: w.hardcore,
    hasStats: w.hasStats,
    playTimeMs: g('play_time') * 50,
    deaths: g('deaths'),
    mobKills: g('mob_kills'),
    blocksMined: sumValues(w.norm.mined),
    distanceCm,
    advDone: advRow ? advRow.done : 0,
    advTotal: advRow ? advRow.total : null,
  };
}

// Consulta agregada. list: instancias ({ id, name, dir, mcVersion, loader, preset }).
// scope: { instanceId?, world? } (world solo junto con instanceId)
async function query(list, { instanceId = null, world = null } = {}, { lang } = {}) {
  const known = await knownUuids();
  const options = [];
  const targets = [];
  const perInstance = await mapLimit(list, 4, async (inst) => ({ inst, worlds: await listWorlds(inst.dir) }));
  for (const { inst, worlds } of perInstance) {
    const infos = await mapLimit(worlds, 8, async (w) => ({ w, info: await levelInfo(w.dir) }));
    options.push({
      id: inst.id,
      name: inst.name,
      mcVersion: inst.mcVersion || null,
      loader: inst.preset || inst.loader || 'vanilla',
      worlds: infos.map(({ w, info }) => ({ folder: w.folder, name: info?.name || w.folder, lastPlayed: info?.lastPlayed || 0 })).sort((a, b) => b.lastPlayed - a.lastPlayed),
    });
    if (instanceId && inst.id !== instanceId) continue;
    for (const w of worlds) if (!world || w.folder === world) targets.push({ inst, w });
  }
  const worlds = await mapLimit(targets, 6, ({ inst, w }) => readWorld(inst, w, known));
  const names = await gamedata.names(lang);
  const total = emptyNorm();
  for (const w of worlds) mergeNorm(total, w.norm);
  const single = worlds.length === 1;
  const advancements = await advancementsBlock(worlds, names, { single });
  const advByWorld = new Map(advancements.perWorld.map((r) => [`${r.instanceId}|${r.folder}`, r]));
  return {
    scope: { instanceId: instanceId || null, world: world || null },
    options: options.sort((a, b) => b.worlds.length - a.worlds.length || a.name.localeCompare(b.name)),
    worldsCount: worlds.length,
    withStats: worlds.filter((w) => w.hasStats).length,
    totals: summarize(total, names, { single }),
    advancements,
    worlds: worlds.map((w) => worldRow(w, advByWorld.get(`${w.instanceId}|${w.folder}`))).sort((a, b) => b.lastPlayed - a.lastPlayed),
    namesFromGame: names.size > 0,
    generatedAt: Date.now(),
  };
}

// Un mundo puntual (para el detalle). Devuelve null si la carpeta no es un mundo.
async function worldDetail(inst, folder, { lang } = {}) {
  const dir = path.join(inst.dir, 'saves', folder);
  const ok = await fsp
    .stat(path.join(dir, 'level.dat'))
    .then((st) => st.isFile())
    .catch(() => false);
  if (!ok) return null;
  const w = await readWorld(inst, { folder, dir }, await knownUuids());
  const names = await gamedata.names(lang);
  const advancements = await advancementsBlock([w], names, { single: true });
  return {
    info: { name: w.name, folder, lastPlayed: w.lastPlayed, gameMode: w.gameMode, hardcore: w.hardcore, version: w.version, hasStats: w.hasStats, players: w.players },
    ingame: summarize(w.norm, names, { single: true }),
    advancements,
  };
}

// Datos minimos de un mundo para listas (nombre real y tiempo dentro del juego).
async function worldBrief(inst, folder) {
  const dir = path.join(inst.dir, 'saves', folder);
  const info = await levelInfo(dir);
  if (!info) return null;
  const known = await knownUuids();
  let ticks = 0;
  const files = await jsonFiles(path.join(dir, 'stats'));
  const mine = files.filter((f) => known.has(uuidOf(f)));
  for (const f of mine.length ? mine : files) {
    const n = await cachedRead(f, (p) => readJsonFile(p).then(normalize));
    ticks += n?.custom['minecraft:play_time'] || 0;
  }
  return { name: info.name || folder, lastPlayed: info.lastPlayed || 0, playTimeMs: ticks * 50, gameMode: info.gameMode };
}

module.exports = { query, worldDetail, worldBrief, listWorlds, normalize, parseAdvancements, parseMcDate, summarize, mergeNorm, emptyNorm };
