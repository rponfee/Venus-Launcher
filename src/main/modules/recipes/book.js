'use strict';
// El libro de recetas de una partida: junta lo que se leyo de los .jar (recipes/jar.js) y responde busquedas y fichas
// de items. Sin archivos ni Electron: lo prueban las pruebas.
const { expandTag, ingredientItems, nameFrom, prettify } = require('./parse');

const MAX_RESULTS = 60;
const MAX_ALTERNATIVES = 16;
const MAX_CARDS = 24;

// Sin mayusculas ni acentos, para buscar "piston" y encontrar "Pistón"
function fold(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim();
}

/**
 * sources = [{ recipes, tags, en, own, items }] en el orden de carga (el cliente primero: un mod puede reemplazar una
 * receta del juego con el mismo id). langTable = nombres del idioma del juego (de los assets).
 */
function createBook(sources, { langTable = null } = {}) {
  const tags = {};
  const en = {};
  const own = { ...(langTable || {}) };
  const recipes = new Map();
  const ids = new Set();
  for (const s of sources) {
    for (const [k, list] of Object.entries(s.tags || {})) tags[k] = [...(tags[k] || []), ...list];
    Object.assign(en, s.en);
    Object.assign(own, s.own);
    for (const r of s.recipes || []) recipes.set(r.id, r);
    for (const id of s.items || []) ids.add(id);
  }
  const byResult = new Map();
  const byUse = new Map();
  const push = (map, id, r) => {
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(r);
  };
  for (const r of recipes.values()) {
    push(byResult, r.result.id, r);
    ids.add(r.result.id);
    const used = new Set();
    for (const s of r.slots) for (const id of ingredientItems(s, tags)) used.add(id);
    for (const id of used) {
      push(byUse, id, r);
      ids.add(id);
    }
  }
  ids.delete('minecraft:air');
  const items = new Map();
  for (const id of ids) {
    const english = nameFrom(id, en) || prettify(id);
    const name = nameFrom(id, own) || english;
    items.set(id, { id, name, en: english, key: fold(`${name} ${english} ${id}`), nameKey: fold(name) });
  }
  const sorted = [...items.values()].sort((a, b) => a.nameKey.localeCompare(b.nameKey));

  const item = (id) => items.get(id) || { id, name: nameFrom(id, own) || nameFrom(id, en) || prettify(id), en: nameFrom(id, en) || prettify(id) };

  function search(query, limit = MAX_RESULTS) {
    const q = fold(query);
    const max = Math.min(MAX_RESULTS, Math.max(1, limit));
    let list;
    if (!q) list = sorted.filter((i) => byResult.has(i.id));
    else {
      const words = q.split(/\s+/);
      const rank = (i) => {
        if (i.nameKey === q) return 0;
        if (i.nameKey.startsWith(q)) return 1;
        if (i.nameKey.split(/\s+/).some((w) => w.startsWith(q))) return 2;
        return i.nameKey.includes(q) ? 3 : 4;
      };
      list = sorted.filter((i) => words.every((w) => i.key.includes(w))).map((i) => [rank(i), i]);
      list.sort((a, b) => a[0] - b[0] || a[1].nameKey.localeCompare(b[1].nameKey));
      list = list.map((x) => x[1]);
    }
    return { total: list.length, items: list.slice(0, max).map((i) => ({ id: i.id, name: i.name, hasRecipe: byResult.has(i.id) })) };
  }

  // Una ranura para la interfaz: hasta 16 alternativas con su nombre y el tag (si es que el ingrediente es uno)
  function slotView(slot) {
    if (!slot) return null;
    const all = ingredientItems(slot, tags);
    const alternatives = all.slice(0, MAX_ALTERNATIVES).map((id) => ({ id, name: item(id).name }));
    return { items: alternatives, more: Math.max(0, all.length - alternatives.length), tag: slot.tags[0] || null };
  }

  function recipeView(r) {
    return {
      id: r.id,
      kind: r.kind,
      station: r.station,
      width: r.width || null,
      height: r.height || null,
      slots: r.slots.map(slotView),
      result: { id: r.result.id, count: r.result.count, name: item(r.result.id).name },
      time: r.time ?? null,
      xp: r.xp ?? null,
    };
  }

  // Ficha de un item: como se fabrica y en que se usa. null si no existe.
  function card(id) {
    if (!items.has(id)) return null;
    const i = items.get(id);
    const made = byResult.get(id) || [];
    const used = byUse.get(id) || [];
    return {
      id,
      name: i.name,
      en: i.en,
      recipes: made.slice(0, MAX_CARDS).map(recipeView),
      recipesMore: Math.max(0, made.length - MAX_CARDS),
      uses: used.slice(0, MAX_CARDS).map(recipeView),
      usesMore: Math.max(0, used.length - MAX_CARDS),
    };
  }

  return { search, card, item, has: (id) => items.has(id), size: items.size, recipeCount: recipes.size, tag: (id) => [...expandTag(tags, id)] };
}

// Ids de una ficha que necesitan icono
function cardIconIds(card) {
  const out = new Set();
  if (!card) return [];
  out.add(card.id);
  for (const r of [...card.recipes, ...card.uses]) {
    out.add(r.result.id);
    for (const s of r.slots) for (const it of s?.items || []) out.add(it.id);
  }
  return [...out];
}

// Busqueda en la wiki por el nombre en ingles, solo para lo que es del juego (los mods no estan en minecraft.wiki)
function wikiUrl(id, englishName) {
  if (typeof id !== 'string' || !id.startsWith('minecraft:') || !englishName) return null;
  return `https://minecraft.wiki/w/Special:Search?search=${encodeURIComponent(englishName)}&go=Go`;
}

module.exports = { createBook, cardIconIds, wikiUrl, fold, MAX_RESULTS };
