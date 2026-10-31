'use strict';
// Gamerules vanilla: esquema (tipo, valor por defecto, rango, grupo y versiones) y lectura/escritura
// en el mundo. Hasta 1.21.10 viven en level.dat (Data.GameRules, como textos); en 1.21.11 pasan a
// nombres snake_case (Data.game_rules) y desde 26.1 a data/minecraft/game_rules.dat. Si el formato de
// un mundo no se puede deducir con seguridad, el cambio queda pendiente y se aplica por comando al iniciar.
const fsp = require('fs/promises');
const path = require('path');
const nbt = require('../../core/nbt');
const props = require('../../core/server-properties');

const { TAG } = nbt;

// [id moderno, nombre viejo, tipo, por defecto, grupo, desde, hasta, extra]
const R = (id, legacy, type, def, group, since, until = null, extra = {}) => ({ id, legacy, type, default: def, group, since, until, ...extra });

const RULES = [
  R('keep_inventory', 'keepInventory', 'bool', false, 'player', '1.4.2'),
  R('natural_health_regeneration', 'naturalRegeneration', 'bool', true, 'player', '1.6.1'),
  R('immediate_respawn', 'doImmediateRespawn', 'bool', false, 'player', '1.15'),
  R('players_sleeping_percentage', 'playersSleepingPercentage', 'int', 100, 'player', '1.17', null, { min: 0, max: 100 }),
  R('pvp', 'pvp', 'bool', true, 'player', '1.21.9'),
  R('fall_damage', 'fallDamage', 'bool', true, 'player', '1.15'),
  R('fire_damage', 'fireDamage', 'bool', true, 'player', '1.15'),
  R('drowning_damage', 'drowningDamage', 'bool', true, 'player', '1.15'),
  R('freeze_damage', 'freezeDamage', 'bool', true, 'player', '1.17'),
  R('respawn_radius', 'spawnRadius', 'int', 10, 'player', '1.9', null, { min: 0 }),
  R('limited_crafting', 'doLimitedCrafting', 'bool', false, 'player', '1.12'),
  R('locator_bar', 'locatorBar', 'bool', true, 'player', '1.21.6'),
  R('ender_pearls_vanish_on_death', 'enderPearlsVanishOnDeath', 'bool', true, 'player', '1.20.2'),
  R('allow_entering_nether_using_portals', 'allowEnteringNetherUsingPortals', 'bool', true, 'player', '1.21.9'),
  R('players_nether_portal_default_delay', 'playersNetherPortalDefaultDelay', 'int', 80, 'player', '1.20.3', null, { min: 0 }),
  R('players_nether_portal_creative_delay', 'playersNetherPortalCreativeDelay', 'int', 1, 'player', '1.20.3', null, { min: 0 }),
  R('spectators_generate_chunks', 'spectatorsGenerateChunks', 'bool', true, 'player', '1.9'),
  R('elytra_movement_check', 'disableElytraMovementCheck', 'bool', true, 'player', '1.9', null, { inverted: true }),
  R('player_movement_check', 'disablePlayerMovementCheck', 'bool', true, 'player', '1.21.2', null, { inverted: true }),

  R('advance_time', 'doDaylightCycle', 'bool', true, 'world', '1.6.1'),
  R('advance_weather', 'doWeatherCycle', 'bool', true, 'world', '1.11'),
  R('random_tick_speed', 'randomTickSpeed', 'int', 3, 'world', '1.8', null, { min: 0, max: 4096 }),
  R(null, 'doFireTick', 'bool', true, 'world', '1.4.2', '1.21.11'),
  R(null, 'allowFireTicksAwayFromPlayer', 'bool', false, 'world', '1.21.5', '1.21.11'),
  R('fire_spread_radius_around_player', null, 'int', 128, 'world', '1.21.11', null, { min: -1 }),
  R('water_source_conversion', 'waterSourceConversion', 'bool', true, 'world', '1.19.3'),
  R('lava_source_conversion', 'lavaSourceConversion', 'bool', false, 'world', '1.19.3'),
  R('spread_vines', 'doVinesSpread', 'bool', true, 'world', '1.19.4'),
  R('max_snow_accumulation_height', 'snowAccumulationHeight', 'int', 1, 'world', '1.19.3', null, { min: 0, max: 8 }),
  R(null, 'spawnChunkRadius', 'int', 2, 'world', '1.20.5', '1.21.9', { min: 0, max: 32 }),

  R('spawn_mobs', 'doMobSpawning', 'bool', true, 'spawning', '1.4.2'),
  R('spawn_monsters', 'spawnMonsters', 'bool', true, 'spawning', '1.21.9'),
  R('spawn_phantoms', 'doInsomnia', 'bool', true, 'spawning', '1.15'),
  R('spawn_patrols', 'doPatrolSpawning', 'bool', true, 'spawning', '1.15.2'),
  R('spawn_wandering_traders', 'doTraderSpawning', 'bool', true, 'spawning', '1.15.2'),
  R('spawn_wardens', 'doWardenSpawning', 'bool', true, 'spawning', '1.19'),
  R('spawner_blocks_work', 'spawnerBlocksEnabled', 'bool', true, 'spawning', '1.21.9'),

  R('mob_griefing', 'mobGriefing', 'bool', true, 'mobs', '1.4.2'),
  R('raids', 'disableRaids', 'bool', true, 'mobs', '1.14.3', null, { inverted: true }),
  R('forgive_dead_players', 'forgiveDeadPlayers', 'bool', true, 'mobs', '1.16'),
  R('universal_anger', 'universalAnger', 'bool', false, 'mobs', '1.16'),
  R('max_entity_cramming', 'maxEntityCramming', 'int', 24, 'mobs', '1.11', null, { min: 0 }),

  R('block_drops', 'doTileDrops', 'bool', true, 'drops', '1.4.2'),
  R('mob_drops', 'doMobLoot', 'bool', true, 'drops', '1.4.2'),
  R('entity_drops', 'doEntityDrops', 'bool', true, 'drops', '1.8.1'),
  R('block_explosion_drop_decay', 'blockExplosionDropDecay', 'bool', true, 'drops', '1.19.3'),
  R('mob_explosion_drop_decay', 'mobExplosionDropDecay', 'bool', true, 'drops', '1.19.3'),
  R('tnt_explosion_drop_decay', 'tntExplosionDropDecay', 'bool', false, 'drops', '1.19.3'),
  R('projectiles_can_break_blocks', 'projectilesCanBreakBlocks', 'bool', true, 'drops', '1.20.3'),

  R('show_death_messages', 'showDeathMessages', 'bool', true, 'chat', '1.8'),
  R('show_advancement_messages', 'announceAdvancements', 'bool', true, 'chat', '1.12'),
  R('command_block_output', 'commandBlockOutput', 'bool', true, 'chat', '1.4.2'),
  R('send_command_feedback', 'sendCommandFeedback', 'bool', true, 'chat', '1.8'),
  R('log_admin_commands', 'logAdminCommands', 'bool', true, 'chat', '1.8'),

  R('command_blocks_work', 'commandBlocksEnabled', 'bool', true, 'misc', '1.21.9'),
  R('tnt_explodes', 'tntExplodes', 'bool', true, 'misc', '1.21.5'),
  R('reduced_debug_info', 'reducedDebugInfo', 'bool', false, 'misc', '1.8'),
  R('global_sound_events', 'globalSoundEvents', 'bool', true, 'misc', '1.19.3'),
  R('max_command_sequence_length', 'maxCommandChainLength', 'int', 65536, 'misc', '1.12', null, { min: 0 }),
  R('max_command_forks', 'maxCommandForkCount', 'int', 65536, 'misc', '1.20.3', null, { min: 1 }),
  R('max_block_modifications', 'commandModificationBlockLimit', 'int', 32768, 'misc', '1.19.4', null, { min: 1 }),
  R('max_minecart_speed', 'minecartMaxSpeed', 'int', 8, 'misc', '1.21.2', null, { min: 1, max: 1000, experimental: true }),
];

const GROUPS = ['player', 'world', 'spawning', 'mobs', 'drops', 'chat', 'misc'];
const keyOf = (rule) => rule.id || rule.legacy;
const BY_KEY = new Map(RULES.map((r) => [keyOf(r), r]));

const usesNewNames = (mc) => props.atLeast(mc, '1.21.11');
const nameFor = (rule, mc) => (usesNewNames(mc) ? rule.id : rule.legacy);
const isAvailable = (rule, mc) => Boolean(nameFor(rule, mc)) && props.availableIn(rule, mc);

// Valor a mostrar (semantica moderna) -> valor que entiende esa version (las reglas "disable*" estan invertidas).
function toVersionValue(rule, value, mc) {
  if (rule.type === 'bool') {
    const v = value === true || value === 'true';
    return rule.inverted && !usesNewNames(mc) ? !v : v;
  }
  return Math.round(Number(value));
}

function fromVersionValue(rule, raw, mc) {
  if (rule.type === 'bool') {
    const v = raw === true || raw === 'true' || raw === 1 || raw === 1n;
    return rule.inverted && !usesNewNames(mc) ? !v : v;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : rule.default;
}

function validate(rule, value) {
  if (rule.type === 'bool') {
    if (value !== true && value !== false && value !== 'true' && value !== 'false') throw Object.assign(new Error('bool'), { code: 'bool' });
    return value === true || value === 'true';
  }
  const s = String(value).trim();
  if (!/^-?\d+$/.test(s)) throw Object.assign(new Error('int'), { code: 'int' });
  const n = Number(s);
  if ((rule.min !== undefined && n < rule.min) || (rule.max !== undefined && n > rule.max)) throw Object.assign(new Error('range'), { code: 'range', min: rule.min, max: rule.max });
  return n;
}

// Comandos para aplicar un parche { clave: valor } en un servidor encendido.
function commands(patch, mc) {
  const out = [];
  for (const [k, v] of Object.entries(patch)) {
    const rule = BY_KEY.get(k);
    if (rule) {
      const name = nameFor(rule, mc);
      if (name) out.push(`gamerule ${name} ${toVersionValue(rule, v, mc)}`);
    } else if (/^[\w:.-]{1,80}$/.test(k)) out.push(`gamerule ${k} ${String(v).trim()}`);
  }
  return out;
}

// ---------- Archivo del mundo ----------

async function readNbt(file) {
  const buf = await fsp.readFile(file);
  return { root: nbt.readTyped(buf), gzip: buf[0] === 0x1f && buf[1] === 0x8b };
}

async function writeNbt(file, root, gzip) {
  const buf = nbt.write(root, { gzip });
  await fsp.copyFile(file, `${file}.venus-bak`).catch(() => {});
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, buf);
  await fsp.rename(tmp, file);
}

const looksLikeRule = (name) => BY_KEY.has(name.replace(/^minecraft:/, '')) || RULES.some((r) => r.legacy === name);

// Encuentra el compound de reglas: { holder, key } donde holder[key].value es el compound.
function findRules(root, kind) {
  const top = root.value;
  if (kind === 'level') {
    const data = top.Data?.type === TAG.Compound ? top.Data.value : null;
    if (!data) return null;
    for (const k of ['GameRules', 'game_rules']) if (data[k]?.type === TAG.Compound) return { holder: data, key: k };
    return null;
  }
  if (top.data?.type === TAG.Compound) {
    const inner = top.data.value;
    for (const k of ['game_rules', 'GameRules', 'rules']) if (inner[k]?.type === TAG.Compound) return { holder: inner, key: k };
    return { holder: top, key: 'data' };
  }
  return { holder: { root: { type: TAG.Compound, value: top } }, key: 'root' };
}

// Estilo de las entradas existentes: prefijo "minecraft:" y valores con tipo o como texto.
function detectStyle(compound, mc) {
  const keys = Object.keys(compound).filter(looksLikeRule);
  if (!keys.length) return usesNewNames(mc) ? null : { prefix: '', typed: false };
  return {
    prefix: keys.some((k) => k.startsWith('minecraft:')) ? 'minecraft:' : '',
    typed: keys.some((k) => compound[k].type !== TAG.String),
  };
}

function findTag(compound, rule) {
  for (const k of [rule.id && `minecraft:${rule.id}`, rule.id, rule.legacy]) if (k && compound[k]) return { key: k, tag: compound[k] };
  return null;
}

function tagValue(tag) {
  if (!tag) return undefined;
  if (tag.type === TAG.String) return tag.value;
  if (tag.type === TAG.Long) return Number(tag.value);
  return tag.value;
}

function makeTag(prev, rule, value, style) {
  const type = prev ? prev.type : style.typed ? (rule && rule.type === 'int' ? TAG.Int : rule ? TAG.Byte : TAG.String) : TAG.String;
  if (type === TAG.String) return { type, value: String(value) };
  const num = value === true ? 1 : value === false ? 0 : Number(value);
  if (type === TAG.Long) return { type, value: BigInt(Math.round(num)) };
  if (type === TAG.Byte || type === TAG.Short || type === TAG.Int) return { type, value: Math.round(num) };
  return { type: TAG.String, value: String(value) };
}

async function locate(worldDir) {
  const data = path.join(worldDir, 'data', 'minecraft', 'game_rules.dat');
  try {
    await fsp.access(data);
    return { file: data, kind: 'data' };
  } catch {
    /* formato anterior */
  }
  const level = path.join(worldDir, 'level.dat');
  try {
    await fsp.access(level);
    return { file: level, kind: 'level' };
  } catch {
    return null;
  }
}

// Lee las reglas del mundo: { file, values: { clave: valor }, extra: [{ name, value }], style }
async function readWorld(worldDir, mc) {
  const loc = await locate(worldDir);
  if (!loc) return { file: null, values: {}, extra: [], style: null };
  let parsed;
  try {
    parsed = await readNbt(loc.file);
  } catch {
    return { file: path.relative(worldDir, loc.file), values: {}, extra: [], style: null, corrupt: true };
  }
  const where = findRules(parsed.root, loc.kind);
  const compound = where ? where.holder[where.key].value : {};
  const values = {};
  const known = new Set();
  for (const rule of RULES) {
    const hit = findTag(compound, rule);
    if (!hit) continue;
    known.add(hit.key);
    // Las reglas "disable*" guardadas con el nombre viejo tienen el valor invertido.
    const legacyKey = hit.key === rule.legacy && rule.id !== rule.legacy;
    values[keyOf(rule)] = fromVersionValue(rule, tagValue(hit.tag), legacyKey ? '1.0' : '99.0');
  }
  const extra = Object.keys(compound)
    .filter((k) => !known.has(k) && [TAG.String, TAG.Byte, TAG.Short, TAG.Int, TAG.Long].includes(compound[k].type))
    .map((k) => ({ name: k, value: String(tagValue(compound[k])) }));
  return { file: path.relative(worldDir, loc.file).split(path.sep).join('/'), values, extra, style: where ? detectStyle(compound, mc) : null };
}

// Escribe un parche { clave: valor } (y reglas extra { nombre: texto }). Devuelve las claves que no se
// pudieron escribir (formato desconocido) para dejarlas pendientes.
async function writeWorld(worldDir, mc, patch = {}, extraPatch = {}) {
  const loc = await locate(worldDir);
  const keys = Object.keys(patch);
  if (!loc) return { written: [], skipped: keys };
  const parsed = await readNbt(loc.file);
  const where = findRules(parsed.root, loc.kind);
  if (!where) return { written: [], skipped: keys };
  const compound = where.holder[where.key].value;
  const style = detectStyle(compound, mc);
  const written = [];
  const skipped = [];
  for (const [k, v] of Object.entries(patch)) {
    const rule = BY_KEY.get(k);
    if (!rule) continue;
    const hit = findTag(compound, rule);
    const base = nameFor(rule, mc);
    if (!hit && (!style || !base)) {
      skipped.push(k);
      continue;
    }
    // La clave que ya existe manda; si no existe, se usa el nombre de esa version con el estilo del archivo.
    const fileName = hit ? hit.key : `${usesNewNames(mc) ? style.prefix : ''}${base}`;
    const isLegacyKey = fileName === rule.legacy && rule.id !== rule.legacy;
    const versionValue = toVersionValue(rule, v, isLegacyKey ? '1.0' : '99.0');
    compound[fileName] = makeTag(hit?.tag, rule, versionValue, style || { typed: false });
    written.push(k);
  }
  for (const [name, v] of Object.entries(extraPatch || {})) {
    if (!compound[name]) continue;
    const prev = compound[name];
    const raw = String(v).trim();
    if (prev.type !== TAG.String && !/^-?\d+$/.test(raw) && raw !== 'true' && raw !== 'false') continue;
    compound[name] = makeTag(prev, null, raw === 'true' ? true : raw === 'false' ? false : prev.type === TAG.String ? raw : Number(raw), style || { typed: false });
    written.push(name);
  }
  if (written.length) await writeNbt(loc.file, parsed.root, parsed.gzip);
  return { written, skipped };
}

// Esquema para la interfaz, resuelto para una version.
function schemaFor(mc) {
  return RULES.map((r) => ({
    key: keyOf(r),
    name: nameFor(r, mc),
    type: r.type,
    default: r.default,
    min: r.min,
    max: r.max,
    group: r.group,
    experimental: Boolean(r.experimental),
    available: isAvailable(r, mc),
  }));
}

module.exports = { RULES, GROUPS, BY_KEY, keyOf, schemaFor, usesNewNames, nameFor, isAvailable, validate, commands, readWorld, writeWorld, locate };
