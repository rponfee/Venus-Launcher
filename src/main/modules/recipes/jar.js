'use strict';
// Lee de un .jar (el cliente de Minecraft o un mod) lo que hace falta para mostrar recetas: las recetas, los tags de
// items, los nombres y un icono por item. Nada de esto viene en el repositorio: todo sale del archivo de la PC del
// usuario. Usa ZipReader (lee solo lo que se pide y sin trabar el proceso principal; adm-zip carga los 40 MB del
// cliente de una vez y lo traba casi un segundo, ver capture/gamelang.js). Sin Electron.
const { ZipReader } = require('../modtranslate/zip');
const { parseRecipe, parseTag, itemId, langKeys, pickNames } = require('./parse');
const { parseLang } = require('../capture/gamelang');

const MAX_JSON = 1024 * 1024; // ninguna receta, tag o modelo deberia pesar mas
const MAX_LANG = 16 * 1024 * 1024;
const MAX_PNG = 64 * 1024;
const MAX_ITEMS = 12000;
const PARALLEL = 16;
const MODEL_DEPTH = 8;

const RECIPE_NEW = /^data\/([a-z0-9_.-]+)\/recipes?\/(.+)\.json$/;
const RECIPE_OLD = /^assets\/([a-z0-9_.-]+)\/recipes\/(.+)\.json$/; // 1.12
const TAG_ITEM = /^data\/([a-z0-9_.-]+)\/tags\/items?\/(.+)\.json$/;
const LANG = /^assets\/([a-z0-9_.-]+)\/lang\/([a-zA-Z0-9_-]+)\.(json|lang)$/;
const ITEM_DEF = /^assets\/([a-z0-9_.-]+)\/items\/(.+)\.json$/; // 1.21.4+
const ITEM_MODEL = /^assets\/([a-z0-9_.-]+)\/models\/item\/(.+)\.json$/;
const TEXTURE_ORDER = ['layer0', 'all', 'side', 'top', 'texture', 'end', 'front', 'cross', 'plant', 'flower', 'crop', 'rail', 'wool', 'pattern', 'particle'];
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47];
const BOM = new RegExp(`^${String.fromCharCode(0xfeff)}`);

async function mapLimit(list, limit, fn) {
  let next = 0;
  const run = async () => {
    while (next < list.length) {
      const i = next++;
      await fn(list[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, run));
}

const splitRef = (ref, ns) => {
  const s = String(ref || '').replace(/^#/, '');
  const cut = s.indexOf(':');
  return cut < 0 ? [ns, s] : [s.slice(0, cut), s.slice(cut + 1)];
};

function createResolver(zip) {
  const json = new Map();
  const readJson = async (name) => {
    if (json.has(name)) return json.get(name);
    let value = null;
    const entry = zip.get(name);
    if (entry && entry.size <= MAX_JSON) {
      try {
        value = JSON.parse((await zip.read(entry)).toString('utf8').replace(BOM, ''));
      } catch {
        value = null;
      }
    }
    json.set(name, value);
    return value;
  };

  // Texturas de un modelo con las de sus padres (las del hijo mandan)
  async function modelTextures(ref, ns, depth = 0) {
    const [n, p] = splitRef(ref, ns);
    if (depth > MODEL_DEPTH || !p) return {};
    const model = await readJson(`assets/${n}/models/${p}.json`);
    if (!model || typeof model !== 'object') return {};
    const parent = typeof model.parent === 'string' ? await modelTextures(model.parent, n, depth + 1) : {};
    return { ...parent, ...(model.textures && typeof model.textures === 'object' ? model.textures : {}) };
  }

  // Definicion de item (1.21.4+): el primer modelo simple que aparezca
  function defModel(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 6) return null;
    if (typeof node.model === 'string') return node.model;
    for (const k of ['model', 'fallback', 'base', 'on_true', 'on_false']) {
      const r = defModel(node[k], depth + 1);
      if (r) return r;
    }
    for (const k of ['cases', 'models', 'entries']) {
      for (const c of Array.isArray(node[k]) ? node[k] : []) {
        const r = defModel(c, depth + 1);
        if (r) return r;
      }
    }
    return null;
  }

  function pickTexture(textures, ns) {
    const follow = (v, n = 0) => (typeof v === 'string' && v.startsWith('#') && n < 8 ? follow(textures[v.slice(1)], n + 1) : v);
    const keys = [...TEXTURE_ORDER, ...Object.keys(textures)];
    for (const k of keys) {
      const v = follow(textures[k]);
      if (typeof v !== 'string' || !v || v.startsWith('#')) continue;
      const [n, p] = splitRef(v, ns);
      const name = `assets/${n}/textures/${p}.png`;
      if (zip.get(name)) return name;
    }
    return null;
  }

  // Item -> entrada de la textura que lo representa, o null (se muestra con su nombre)
  async function iconEntry(id) {
    const cut = id.indexOf(':');
    const ns = id.slice(0, cut);
    const p = id.slice(cut + 1);
    const def = await readJson(`assets/${ns}/items/${p}.json`);
    const ref = def ? defModel(def) : null;
    let name = pickTexture(await modelTextures(ref || `item/${p}`, ns), ns);
    if (!name) name = ['item', 'block', 'items', 'blocks'].map((d) => `assets/${ns}/textures/${d}/${p}.png`).find((n) => zip.get(n)) || null;
    return name ? zip.get(name) : null;
  }
  return { readJson, iconEntry };
}

async function readPng(zip, entry) {
  if (!entry || entry.size > MAX_PNG) return null;
  try {
    const buf = await zip.read(entry);
    return PNG_SIG.every((b, i) => buf[i] === b) ? buf.toString('base64') : null;
  } catch {
    return null;
  }
}

/**
 * Lee un .jar. lang = idioma del juego ('es_ar'): los mods traen sus nombres adentro (el del cliente de Minecraft
 * solo trae el ingles; los demas estan en los assets, ver recipes.js).
 * -> { recipes: [receta], tags: { id: [valores] }, en: { clave: texto }, own: { clave: texto }, items: [id], iconIds: [id], icons: { id: base64 } }
 */
async function readJar(file, { lang = null } = {}) {
  const zip = await ZipReader.open(file);
  try {
    const recipeEntries = [];
    const tagEntries = [];
    const langEntries = { en: [], own: [] };
    const known = new Set(); // items con definicion o modelo propio
    const wantLang = String(lang || '').toLowerCase();
    for (const e of zip.entries) {
      if (e.dir) continue;
      const n = e.name;
      let m = RECIPE_NEW.exec(n) || RECIPE_OLD.exec(n);
      if (m) {
        if (!m[2].split('/').pop().startsWith('_') && e.size <= MAX_JSON) recipeEntries.push({ id: `${m[1]}:${m[2]}`, e });
        continue;
      }
      if ((m = TAG_ITEM.exec(n))) {
        if (e.size <= MAX_JSON) tagEntries.push({ id: `${m[1]}:${m[2]}`, e });
        continue;
      }
      if ((m = LANG.exec(n))) {
        const code = m[2].toLowerCase();
        if (e.size <= MAX_LANG) {
          if (code === 'en_us') langEntries.en.push(e);
          else if (wantLang && code === wantLang) langEntries.own.push(e);
        }
        continue;
      }
      if ((m = ITEM_DEF.exec(n)) || (m = ITEM_MODEL.exec(n))) {
        const id = itemId(`${m[1]}:${m[2]}`);
        if (id) known.add(id);
      }
    }

    const res = createResolver(zip);
    const recipes = [];
    await mapLimit(recipeEntries, PARALLEL, async ({ id, e }) => {
      const r = parseRecipe(await res.readJson(e.name), id);
      if (r) recipes.push(r);
    });
    recipes.sort((a, b) => (a.id < b.id ? -1 : 1));

    const tags = {};
    await mapLimit(tagEntries, PARALLEL, async ({ id, e }) => {
      const list = parseTag(await res.readJson(e.name));
      if (list.length) tags[id] = list;
    });

    const readLangs = async (entries) => {
      const out = {};
      for (const e of entries) {
        try {
          Object.assign(out, pickNames(parseLang((await zip.read(e)).toString('utf8'))));
        } catch {
          /* idioma danado */
        }
      }
      return out;
    };
    const en = await readLangs(langEntries.en);
    const own = await readLangs(langEntries.own);

    // Items: los de las recetas y los que tienen modelo y nombre (los modelos sueltos, como bow_pulling_0, no)
    const items = new Set();
    for (const r of recipes) {
      if (r.result?.id) items.add(r.result.id);
      for (const s of r.slots) for (const id of s?.items || []) items.add(id);
    }
    for (const id of known) {
      if (items.size >= MAX_ITEMS) break;
      if (langKeys(id).some((k) => en[k] || own[k])) items.add(id);
    }

    const icons = {};
    await mapLimit([...items], PARALLEL, async (id) => {
      const png = await readPng(zip, await res.iconEntry(id));
      if (png) icons[id] = png;
    });
    return { recipes, tags, en, own, items: [...items], iconIds: Object.keys(icons), icons };
  } finally {
    await zip.close();
  }
}

module.exports = { readJar };
