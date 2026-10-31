'use strict';
// Lectura rapida de las estadisticas del juego de un mundo (stats/<uuid>.json). Es el respaldo de la
// ficha del mundo cuando el modulo de estadisticas (stats:world) no esta disponible.
const fsp = require('fs/promises');
const path = require('path');
const { jsonFiles, uuidOf } = require('./level');

const KINDS = { 'minecraft:custom': 'custom', 'minecraft:mined': 'mined', 'minecraft:killed': 'killed', 'minecraft:killed_by': 'killedBy', 'minecraft:crafted': 'crafted', 'minecraft:used': 'used', 'minecraft:broken': 'broken', 'minecraft:picked_up': 'pickedUp', 'minecraft:dropped': 'dropped' };
// Formato de 1.12 o anterior: "stat.walkOneCm" -> "minecraft:walk_one_cm"
const LEGACY_KIND = { mineBlock: 'mined', craftItem: 'crafted', useItem: 'used', breakItem: 'broken', pickup: 'pickedUp', drop: 'dropped', killEntity: 'killed', entityKilledBy: 'killedBy' };
const ALIASES = { 'minecraft:play_one_minute': 'minecraft:play_time' };

const toNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
const camelToSnake = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

function empty() {
  return { custom: {}, mined: {}, killed: {}, killedBy: {}, crafted: {}, used: {}, broken: {}, pickedUp: {}, dropped: {} };
}

function add(map, id, v) {
  const key = ALIASES[id] || id;
  map[key] = (map[key] || 0) + toNum(v);
}

function normalize(json) {
  const out = empty();
  if (!json || typeof json !== 'object') return out;
  if (json.stats && typeof json.stats === 'object') {
    for (const [cat, values] of Object.entries(json.stats)) {
      const kind = KINDS[cat];
      if (!kind || !values || typeof values !== 'object') continue;
      for (const [id, v] of Object.entries(values)) add(out[kind], id, v);
    }
    return out;
  }
  for (const [key, v] of Object.entries(json)) {
    if (!key.startsWith('stat.')) continue;
    const parts = key.slice(5).split('.');
    if (parts.length === 1) {
      add(out.custom, `minecraft:${camelToSnake(parts[0])}`, v);
      continue;
    }
    const kind = LEGACY_KIND[parts[0]];
    if (!kind) continue;
    const rest = parts.slice(1);
    const id = rest.length >= 2 ? `${rest[0]}:${rest.slice(1).join('.')}` : `minecraft:${camelToSnake(rest[0] || '')}`;
    add(out[kind], id, v);
  }
  return out;
}

function merge(target, src) {
  for (const kind of Object.keys(target)) for (const [id, v] of Object.entries(src[kind] || {})) target[kind][id] = (target[kind][id] || 0) + v;
  return target;
}

const sum = (m) => Object.values(m).reduce((a, b) => a + b, 0);

function top(map, n = 6) {
  return Object.entries(map)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([id, count]) => ({ id, count }));
}

function summarize(norm, players) {
  const g = (k) => norm.custom[`minecraft:${k}`] || 0;
  let distanceCm = 0;
  for (const [k, v] of Object.entries(norm.custom)) if (k.endsWith('_one_cm')) distanceCm += v;
  return {
    players,
    playTimeMs: g('play_time') * 50,
    deaths: g('deaths'),
    mobKills: g('mob_kills'),
    playerKills: g('player_kills'),
    jumps: g('jump'),
    damageDealt: g('damage_dealt') / 20,
    damageTaken: g('damage_taken') / 20,
    distanceCm,
    walkCm: g('walk_one_cm'),
    blocksMined: sum(norm.mined),
    itemsCrafted: sum(norm.crafted),
    itemsUsed: sum(norm.used),
    itemsBroken: sum(norm.broken),
    sleptInBed: g('sleep_in_bed'),
    tradedWithVillager: g('traded_with_villager'),
    animalsBred: g('animals_bred'),
    fishCaught: g('fish_caught'),
    enchantItem: g('enchant_item'),
    timeSinceDeathMs: g('time_since_death') * 50,
    top: { mined: top(norm.mined), killed: top(norm.killed), killedBy: top(norm.killedBy), crafted: top(norm.crafted) },
  };
}

// Estadisticas del mundo: las cuentas del launcher sumadas; si ninguna jugo ahi, el jugador con mas tiempo.
async function read(worldDir, known = new Set()) {
  const files = await jsonFiles(path.join(worldDir, 'stats'));
  if (!files.length) return null;
  const parsed = [];
  for (const f of files) {
    try {
      parsed.push({ file: f, norm: normalize(JSON.parse(await fsp.readFile(f, 'utf8'))) });
    } catch {
      /* archivo danado */
    }
  }
  if (!parsed.length) return null;
  const mine = parsed.filter((p) => known.has(uuidOf(p.file)));
  let use = mine;
  if (!use.length) {
    const best = parsed.reduce((a, b) => ((b.norm.custom['minecraft:play_time'] || 0) > (a.norm.custom['minecraft:play_time'] || 0) ? b : a));
    use = [best];
  }
  const norm = use.reduce((acc, p) => merge(acc, p.norm), empty());
  return summarize(norm, parsed.length);
}

module.exports = { read, normalize, summarize };
