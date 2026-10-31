'use strict';
// Logros (advancements) de un mundo. Tabla de los logros vanilla (categoria, marco y DataVersion en la
// que aparecieron) y lectura de advancements/<uuid>.json: fecha en que se completo cada logro (el
// criterio mas reciente) y todas las marcas de tiempo (incluidas las recetas, que el juego desbloquea
// a cada rato mientras se juega) para estimar las partidas que el launcher no registro.
const fsp = require('fs/promises');
const path = require('path');
const { t } = require('../../core/i18n');

// DataVersion de la version en la que aparecio cada logro (para no contar como faltantes los que no existen)
const DV = { v112: 1139, v113: 1519, v114: 1952, v115: 2225, v116: 2566, v117: 2724, v118: 2860, v119: 3105, v120: 3463, v1205: 3837, v121: 3953, v1214: 4189, v1216: 4435 };

// [ruta, marco, version en la que aparecio, version en la que se quito] · marco: t = tarea, g = meta, c = desafio
const LIST = [
  // Minecraft (historia)
  ['story/root', 't', DV.v112],
  ['story/mine_stone', 't', DV.v112],
  ['story/upgrade_tools', 't', DV.v112],
  ['story/smelt_iron', 't', DV.v112],
  ['story/obtain_armor', 't', DV.v112],
  ['story/lava_bucket', 't', DV.v112],
  ['story/iron_tools', 't', DV.v112],
  ['story/deflect_arrow', 't', DV.v112],
  ['story/form_obsidian', 't', DV.v112],
  ['story/mine_diamond', 't', DV.v112],
  ['story/enter_the_nether', 't', DV.v112],
  ['story/shiny_gear', 't', DV.v112],
  ['story/enchant_item', 't', DV.v112],
  ['story/cure_zombie_villager', 'g', DV.v112],
  ['story/follow_ender_eye', 't', DV.v112],
  ['story/enter_the_end', 't', DV.v112],
  // Nether
  ['nether/root', 't', DV.v112],
  ['nether/return_to_sender', 'c', DV.v112],
  ['nether/find_bastion', 't', DV.v116],
  ['nether/obtain_ancient_debris', 't', DV.v116],
  ['nether/fast_travel', 'c', DV.v112],
  ['nether/find_fortress', 't', DV.v112],
  ['nether/obtain_crying_obsidian', 't', DV.v116],
  ['nether/distract_piglin', 't', DV.v116],
  ['nether/ride_strider', 't', DV.v116],
  ['nether/uneasy_alliance', 'c', DV.v112],
  ['nether/loot_bastion', 't', DV.v116],
  ['nether/use_lodestone', 't', DV.v116],
  ['nether/netherite_armor', 'c', DV.v116],
  ['nether/get_wither_skull', 't', DV.v112],
  ['nether/obtain_blaze_rod', 't', DV.v112],
  ['nether/charge_respawn_anchor', 't', DV.v116],
  ['nether/ride_strider_in_overworld_lava', 't', DV.v116],
  ['nether/explore_nether', 'c', DV.v116],
  ['nether/summon_wither', 't', DV.v112],
  ['nether/brew_potion', 't', DV.v112],
  ['nether/create_beacon', 't', DV.v112],
  ['nether/all_potions', 'c', DV.v112],
  ['nether/create_full_beacon', 'g', DV.v112],
  ['nether/all_effects', 'c', DV.v112],
  // End
  ['end/root', 't', DV.v112],
  ['end/kill_dragon', 't', DV.v112],
  ['end/dragon_egg', 'g', DV.v112],
  ['end/enter_end_gateway', 't', DV.v112],
  ['end/respawn_dragon', 'g', DV.v112],
  ['end/dragon_breath', 'g', DV.v112],
  ['end/find_end_city', 't', DV.v112],
  ['end/elytra', 'g', DV.v112],
  ['end/levitate', 'c', DV.v112],
  // Aventura
  ['adventure/root', 't', DV.v112],
  ['adventure/voluntary_exile', 't', DV.v114],
  ['adventure/spyglass_at_parrot', 't', DV.v117],
  ['adventure/kill_a_mob', 't', DV.v112],
  ['adventure/read_power_of_chiseled_bookshelf', 't', DV.v120],
  ['adventure/trade', 't', DV.v112],
  ['adventure/trim_with_any_armor_pattern', 't', DV.v120],
  ['adventure/honey_block_slide', 't', DV.v115],
  ['adventure/ol_betsy', 't', DV.v114],
  ['adventure/lightning_rod_with_villager_no_fire', 't', DV.v117],
  ['adventure/fall_from_world_height', 't', DV.v118],
  ['adventure/salvage_sherd', 't', DV.v120],
  ['adventure/avoid_vibration', 't', DV.v119],
  ['adventure/sleep_in_bed', 't', DV.v112],
  ['adventure/hero_of_the_village', 'c', DV.v114],
  ['adventure/spyglass_at_ghast', 't', DV.v117],
  ['adventure/throw_trident', 't', DV.v113],
  ['adventure/kill_mob_near_sculk_catalyst', 'c', DV.v119],
  ['adventure/shoot_arrow', 't', DV.v112],
  ['adventure/kill_all_mobs', 'c', DV.v112],
  ['adventure/totem_of_undying', 'g', DV.v112],
  ['adventure/summon_iron_golem', 'g', DV.v114],
  ['adventure/trade_at_world_height', 't', DV.v119],
  ['adventure/trim_with_all_exclusive_armor_patterns', 'c', DV.v120],
  ['adventure/two_birds_one_arrow', 'c', DV.v114],
  ['adventure/whos_the_pillager_now', 't', DV.v114],
  ['adventure/arbalistic', 'c', DV.v114],
  ['adventure/craft_decorated_pot_using_only_sherds', 't', DV.v120],
  ['adventure/adventuring_time', 'c', DV.v112],
  ['adventure/play_jukebox_in_meadows', 't', DV.v118],
  ['adventure/walk_on_powder_snow_with_leather_boots', 't', DV.v117],
  ['adventure/spyglass_at_dragon', 't', DV.v117],
  ['adventure/very_very_frightening', 't', DV.v113],
  ['adventure/sniper_duel', 'c', DV.v112],
  ['adventure/bullseye', 'c', DV.v116],
  ['adventure/brush_armadillo', 't', DV.v1205],
  ['adventure/minecraft_trials_edition', 't', DV.v121],
  ['adventure/crafters_crafting_crafters', 't', DV.v121],
  ['adventure/lighten_up', 't', DV.v121],
  ['adventure/who_needs_rockets', 't', DV.v121],
  ['adventure/under_lock_and_key', 't', DV.v121],
  ['adventure/revaulting', 'g', DV.v121],
  ['adventure/blowback', 'c', DV.v121],
  ['adventure/overoverkill', 'c', DV.v121],
  ['adventure/heart_transplanter', 't', DV.v1214],
  // Agricultura
  ['husbandry/root', 't', DV.v112],
  ['husbandry/safely_harvest_honey', 't', DV.v115],
  ['husbandry/breed_an_animal', 't', DV.v112],
  ['husbandry/allay_deliver_item_to_player', 't', DV.v119],
  ['husbandry/ride_a_boat_with_a_goat', 't', DV.v117],
  ['husbandry/tame_an_animal', 't', DV.v112],
  ['husbandry/make_a_sign_glow', 't', DV.v117],
  ['husbandry/fishy_business', 't', DV.v113],
  ['husbandry/silk_touch_nest', 't', DV.v115],
  ['husbandry/tadpole_in_a_bucket', 't', DV.v119],
  ['husbandry/obtain_sniffer_egg', 't', DV.v120],
  ['husbandry/plant_seed', 't', DV.v112],
  ['husbandry/wax_on', 't', DV.v117],
  ['husbandry/bred_all_animals', 'c', DV.v112],
  ['husbandry/allay_deliver_cake_to_note_block', 't', DV.v119],
  ['husbandry/complete_catalogue', 'c', DV.v114],
  ['husbandry/tactical_fishing', 't', DV.v113],
  ['husbandry/leash_all_frog_variants', 't', DV.v119],
  ['husbandry/feed_snifflet', 't', DV.v120],
  ['husbandry/balanced_diet', 'c', DV.v112],
  ['husbandry/obtain_netherite_hoe', 'c', DV.v116],
  ['husbandry/break_diamond_hoe', 'c', DV.v112, DV.v116],
  ['husbandry/wax_off', 't', DV.v117],
  ['husbandry/axolotl_in_a_bucket', 't', DV.v117],
  ['husbandry/froglights', 't', DV.v119],
  ['husbandry/plant_any_sniffer_seed', 't', DV.v120],
  ['husbandry/kill_axolotl_target', 't', DV.v117],
  ['husbandry/repair_wolf_armor', 't', DV.v1205],
  ['husbandry/remove_wolf_armor', 't', DV.v1205],
  ['husbandry/whole_pack', 'c', DV.v1205],
  ['husbandry/place_dried_ghast_in_water', 't', DV.v1216],
];

const FRAMES = { t: 'task', g: 'goal', c: 'challenge' };
const CATEGORIES = ['story', 'nether', 'end', 'adventure', 'husbandry'];

const TABLE = new Map(LIST.map(([p, f, since, until]) => [`minecraft:${p}`, { path: p, category: p.split('/')[0], frame: FRAMES[f], since, until: until || 0 }]));

// El logro existe en un mundo con esa DataVersion
const existsIn = (meta, dv) => meta.since <= dv && (!meta.until || dv < meta.until);

// "2023-06-14 18:03:11 -0300" -> ms (0 si no se entiende)
function parseMcDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(String(s || '').trim());
  if (!m) return 0;
  return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7]}${m[8]}:${m[9]}`) || 0;
}

// "minecraft:adventure/kill_a_mob" -> "Kill a mob" (para logros de mods o nuevos)
function prettify(id) {
  const last = String(id || '').split(/[:/]/).pop() || String(id || '');
  const words = last.replace(/[_-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : String(id || '');
}

function info(id) {
  const key = String(id || '');
  const meta = TABLE.get(key);
  const ns = key.includes(':') ? key.slice(0, key.indexOf(':')) : 'minecraft';
  const pathPart = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key;
  const category = meta ? meta.category : ns === 'minecraft' ? pathPart.split('/')[0] : 'mods';
  let title = null;
  if (meta) {
    const tr = t(`worlds.adv.${meta.path}`);
    if (tr !== `worlds.adv.${meta.path}`) title = tr;
  }
  return {
    id: key,
    title: title || prettify(key),
    category: CATEGORIES.includes(category) ? category : 'mods',
    frame: meta ? meta.frame : 'task',
    vanilla: Boolean(meta),
  };
}

// Totales de logros vanilla que existen en un mundo con esa DataVersion (null si no se sabe la version)
function totals(dataVersion) {
  const dv = Number(dataVersion) || 0;
  if (!dv || dv < DV.v112) return null;
  const out = { total: 0, categories: {} };
  for (const meta of TABLE.values()) {
    if (!existsIn(meta, dv)) continue;
    out.total += 1;
    out.categories[meta.category] = (out.categories[meta.category] || 0) + 1;
  }
  return out;
}

// Un archivo advancements/<uuid>.json -> { done: Map(id -> fecha|null), stamps: [ms...] }
function parse(json) {
  const done = new Map();
  const stamps = [];
  if (!json || typeof json !== 'object') return { done, stamps };
  for (const [id, v] of Object.entries(json)) {
    if (id === 'DataVersion' || !v || typeof v !== 'object') continue;
    let latest = 0;
    for (const ts of Object.values(v.criteria || {})) {
      const at = parseMcDate(ts);
      if (!at) continue;
      stamps.push(at);
      if (at > latest) latest = at;
    }
    if (v.done === true && !id.includes(':recipes/') && !id.startsWith('recipes/')) done.set(id, latest || null);
  }
  stamps.sort((a, b) => a - b);
  return { done, stamps };
}

// ---------- Lectura con cache (por fecha de modificacion y tamanio) ----------
const cache = new Map(); // ruta -> { mtimeMs, size, value }
async function readCached(file) {
  const st = await fsp.stat(file).catch(() => null);
  if (!st || !st.isFile()) {
    cache.delete(file);
    return null;
  }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
  let value = null;
  try {
    value = parse(JSON.parse(await fsp.readFile(file, 'utf8')));
  } catch {
    value = null;
  }
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
  if (cache.size > 3000) cache.delete(cache.keys().next().value);
  return value;
}

const uuidOf = (file) => path.basename(file, path.extname(file)).replace(/-/g, '').toLowerCase();

// Logros del mundo: los archivos de las cuentas del launcher (o todos si ninguno es de ellas).
// -> { done: Map(id -> fecha mas temprana), stamps: [ms ordenados], players }
async function forWorld(worldDir, known = new Set()) {
  const dir = path.join(worldDir, 'advancements');
  let files = [];
  try {
    files = (await fsp.readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.json')).map((e) => path.join(dir, e.name));
  } catch {
    files = [];
  }
  const mine = files.filter((f) => known.has(uuidOf(f)));
  const use = mine.length ? mine : files;
  const done = new Map();
  let stamps = [];
  for (const f of use) {
    const r = await readCached(f);
    if (!r) continue;
    for (const [id, at] of r.done) {
      const prev = done.get(id);
      if (prev === undefined || (at && (!prev || at < prev))) done.set(id, at);
    }
    stamps = stamps.concat(r.stamps);
  }
  stamps.sort((a, b) => a - b);
  return { done, stamps, players: use.length };
}

// Resumen para la ficha del mundo: hechos / totales por categoria y los ultimos conseguidos.
function summary(done, dataVersion) {
  const tot = totals(dataVersion);
  const byCat = {};
  let vanillaDone = 0;
  let modsDone = 0;
  for (const id of done.keys()) {
    const meta = TABLE.get(id);
    if (meta) {
      if (tot && !existsIn(meta, Number(dataVersion) || 0)) continue;
      vanillaDone += 1;
      byCat[meta.category] = (byCat[meta.category] || 0) + 1;
    } else if (id.startsWith('minecraft:')) {
      const cat = id.slice(10).split('/')[0];
      if (CATEGORIES.includes(cat)) {
        vanillaDone += 1;
        byCat[cat] = (byCat[cat] || 0) + 1;
      }
    } else modsDone += 1;
  }
  const categories = CATEGORIES.map((id) => ({ id, done: byCat[id] || 0, total: tot ? tot.categories[id] || 0 : null })).filter((c) => c.done > 0 || c.total);
  const recent = [...done]
    .filter(([, at]) => at)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([id, at]) => ({ ...info(id), at }));
  return { done: vanillaDone, total: tot ? tot.total : null, modsDone, categories, recent };
}

module.exports = { TABLE, CATEGORIES, DV, parseMcDate, prettify, info, totals, parse, readCached, forWorld, summary, uuidOf };
