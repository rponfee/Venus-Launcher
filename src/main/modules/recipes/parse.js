'use strict';
// Formatos de las recetas de Minecraft a una forma unica, sin archivos ni Electron (lo prueban las pruebas). Vale para
// todas las versiones con recetas en JSON (1.12 en adelante) y para los mods que usan los mismos campos:
//   1.12            assets/minecraft/recipes, { item, data }, type sin espacio de nombres
//   1.13 a 1.20.4   data/minecraft/recipes, result: { item, count } o result: 'id' (horno)
//   1.20.5 a 1.21.1 result: { id, count }; 1.21 cambia la carpeta a data/minecraft/recipe
//   1.21.2+         ingredientes como texto: 'minecraft:stick', '#minecraft:planks' o una lista
// Probado con los .jar reales de 1.20.1, 1.21.11 y 26.1.2 (ver docs/implementacion/overlay.md).
// Receta normalizada:
//   { id, kind: 'shaped'|'shapeless'|'cooking'|'stonecutting'|'smithing'|'other', station, width?, height?,
//     slots: [{ items: [id], tags: [id] } | null], result: { id, count }, time? (ticks), xp? }

const ID = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;
const MAX_ALTERNATIVES = 64;
const MAX_SLOTS = 81;
const COOKING = { smelting: 'smelting', blasting: 'blasting', smoking: 'smoking', campfire_cooking: 'campfire' };
// Sin ingredientes fijos en sus datos: las hace el codigo del juego, no se pueden mostrar
const SKIP = /^(crafting_special_|crafting_decorated_pot$|smithing_trim$)/;

// 'stick' -> 'minecraft:stick'; null si no es un id valido
function itemId(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (!s || s.length > 200 || s.includes('..')) return null;
  const full = s.includes(':') ? s : `minecraft:${s}`;
  return ID.test(full) ? full : null;
}

// Cualquier forma de ingrediente -> { items, tags } o null si esta vacio
function parseIngredient(raw) {
  const items = new Set();
  const tags = new Set();
  const add = (v, depth) => {
    if (depth > 4 || v === null || v === undefined) return;
    if (items.size + tags.size >= MAX_ALTERNATIVES) return;
    if (Array.isArray(v)) {
      for (const x of v) add(x, depth + 1);
      return;
    }
    if (typeof v === 'string') {
      const id = itemId(v.startsWith('#') ? v.slice(1) : v);
      if (id) (v.startsWith('#') ? tags : items).add(id);
      return;
    }
    if (typeof v !== 'object') return;
    if (typeof v.tag === 'string') add(`#${v.tag.replace(/^#/, '')}`, depth + 1);
    else if (typeof v.item === 'string') add(v.item, depth + 1);
    else if (typeof v.id === 'string') add(v.id, depth + 1);
    else if (Array.isArray(v.items)) add(v.items, depth + 1);
    else if (v.ingredient !== undefined) add(v.ingredient, depth + 1);
    else if (Array.isArray(v.ingredients)) add(v.ingredients, depth + 1);
  };
  add(raw, 0);
  return items.size || tags.size ? { items: [...items], tags: [...tags] } : null;
}

function parseResult(raw, fallbackCount) {
  let id = null;
  let count = fallbackCount;
  if (typeof raw === 'string') id = itemId(raw);
  else if (Array.isArray(raw)) return raw.length ? parseResult(raw[0], fallbackCount) : null;
  else if (raw && typeof raw === 'object') {
    id = itemId(raw.id ?? raw.item);
    count = raw.count ?? raw.Count ?? fallbackCount;
  }
  if (!id) return null;
  const n = Number(count);
  return { id, count: Number.isInteger(n) && n > 0 && n <= 64000 ? n : 1 };
}

function parseShaped(raw) {
  const rows = Array.isArray(raw.pattern) ? raw.pattern.filter((r) => typeof r === 'string') : [];
  if (!rows.length || rows.length > 9) return null;
  const width = Math.max(...rows.map((r) => r.length));
  if (!width || width > 9) return null;
  const key = raw.key && typeof raw.key === 'object' ? raw.key : {};
  const cache = new Map();
  const slots = [];
  for (const row of rows) {
    for (let x = 0; x < width; x++) {
      const c = row[x];
      if (c === undefined || c === ' ') {
        slots.push(null);
        continue;
      }
      if (!cache.has(c)) cache.set(c, parseIngredient(key[c]));
      slots.push(cache.get(c));
    }
  }
  return { width, height: rows.length, slots };
}

function slotList(list) {
  const out = [];
  for (const v of Array.isArray(list) ? list : [list]) {
    if (out.length >= MAX_SLOTS) break;
    const ing = parseIngredient(v);
    if (ing) out.push(ing);
  }
  return out;
}

// JSON de una receta -> receta normalizada o null (tipo sin datos fijos, o sin nada que mostrar)
function parseRecipe(raw, id) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const fullType = typeof raw.type === 'string' ? raw.type.toLowerCase() : '';
  const type = fullType.replace(/^minecraft:/, '');
  if (!type || SKIP.test(type)) return null;
  const base = { id };
  if (type === 'crafting_shaped') {
    const shape = parseShaped(raw);
    const result = parseResult(raw.result, raw.count ?? 1);
    if (!shape || !result || !shape.slots.some(Boolean)) return null;
    return { ...base, kind: 'shaped', station: 'crafting', ...shape, result };
  }
  if (type === 'crafting_shapeless') {
    const slots = slotList(raw.ingredients);
    const result = parseResult(raw.result, raw.count ?? 1);
    if (!slots.length || !result) return null;
    return { ...base, kind: 'shapeless', station: 'crafting', slots, result };
  }
  if (type === 'crafting_transmute' || type === 'crafting_dye' || type === 'crafting_imbue') {
    // Dos ingredientes y un resultado, cada tipo con sus nombres (crafting_dye e crafting_imbue, desde 26.1)
    const slots = slotList(type === 'crafting_dye' ? [raw.target, raw.dye] : type === 'crafting_imbue' ? [raw.source, raw.material] : [raw.input, raw.material]);
    const result = parseResult(raw.result, 1);
    if (!slots.length || !result) return null;
    return { ...base, kind: 'shapeless', station: 'crafting', slots, result };
  }
  if (COOKING[type]) {
    const ing = parseIngredient(raw.ingredient);
    const result = parseResult(raw.result, 1);
    if (!ing || !result) return null;
    const xp = Number(raw.experience);
    const time = Number(raw.cookingtime);
    return {
      ...base,
      kind: 'cooking',
      station: COOKING[type],
      slots: [ing],
      result,
      time: Number.isFinite(time) && time > 0 ? Math.round(time) : null,
      xp: Number.isFinite(xp) && xp >= 0 ? Number(xp.toFixed(2)) : null,
    };
  }
  if (type === 'stonecutting') {
    const ing = parseIngredient(raw.ingredient);
    const result = parseResult(raw.result, raw.count ?? 1);
    if (!ing || !result) return null;
    return { ...base, kind: 'stonecutting', station: 'stonecutter', slots: [ing], result };
  }
  if (type === 'smithing_transform' || type === 'smithing') {
    const result = parseResult(raw.result, 1);
    const slots = [raw.template, raw.base, raw.addition].filter((v) => v !== undefined).map(parseIngredient);
    if (!result || !slots.some(Boolean)) return null;
    return { ...base, kind: 'smithing', station: 'smithing', slots, result };
  }
  // Tipos de mods con los campos de siempre: se muestran como una lista de ingredientes
  const input = raw.ingredients ?? raw.inputs ?? raw.ingredient ?? raw.input;
  const output = raw.result ?? raw.results ?? raw.output;
  if (input === undefined || output === undefined) return null;
  const slots = slotList(input);
  const result = parseResult(output, raw.count ?? 1);
  if (!slots.length || !result) return null;
  return { ...base, kind: 'other', station: fullType.slice(0, 80), slots, result };
}

// Un archivo de tag: { values: ['minecraft:stick', '#minecraft:planks', { id, required }] } -> lista de textos
function parseTag(raw) {
  const out = [];
  for (const v of Array.isArray(raw?.values) ? raw.values : []) {
    const text = typeof v === 'string' ? v : typeof v?.id === 'string' ? v.id : null;
    if (!text) continue;
    const id = itemId(text.replace(/^#/, ''));
    if (id) out.push(text.startsWith('#') ? `#${id}` : id);
  }
  return out;
}

// Items de un tag con sus tags anidados (con un tope, por si un mod arma un ciclo)
function expandTag(tags, id, seen = new Set(), out = new Set()) {
  if (seen.has(id) || seen.size > 256) return out;
  seen.add(id);
  for (const v of tags?.[id] || []) {
    if (v.startsWith('#')) expandTag(tags, v.slice(1), seen, out);
    else out.add(v);
  }
  return out;
}

// Los items de un ingrediente, con los tags ya expandidos
function ingredientItems(slot, tags) {
  if (!slot) return [];
  const out = new Set(slot.items);
  for (const tag of slot.tags) for (const id of expandTag(tags, tag)) out.add(id);
  return [...out];
}

function langKeys(id) {
  const cut = id.indexOf(':');
  const ns = id.slice(0, cut);
  const p = id.slice(cut + 1).replace(/\//g, '.');
  return [`item.${ns}.${p}`, `block.${ns}.${p}`];
}

// 'minecraft:oak_planks' -> 'Oak Planks' (cuando el juego no trae el nombre)
function prettify(id) {
  const last = String(id).split(':').pop().split('/').pop();
  return last.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function nameFrom(id, table) {
  for (const k of langKeys(id)) if (typeof table?.[k] === 'string' && table[k]) return table[k];
  return null;
}

// Solo las claves de nombres de items y bloques (de un archivo con miles)
function pickNames(all) {
  const out = {};
  for (const [k, v] of Object.entries(all || {})) if (typeof v === 'string' && /^(item|block)\./.test(k) && v.length <= 200) out[k] = v;
  return out;
}

module.exports = { parseRecipe, parseIngredient, parseResult, parseTag, expandTag, ingredientItems, itemId, langKeys, nameFrom, pickNames, prettify, ID };
