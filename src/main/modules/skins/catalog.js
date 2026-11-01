'use strict';
// Catalogo de skins que viene con el launcher (src/renderer/assets/skins): catalog.json con los datos de
// cada skin y los PNG por categoria. Se lee una sola vez, recien cuando hace falta, y cada entrada se valida
// (id, ruta dentro de la carpeta, tamano, modelo y sha256): las que fallan se descartan con un aviso en la
// consola, sin tirar abajo el resto. Cada PNG se vuelve a revisar (sha256, encabezado y pixeles) cada vez
// que se lee. Favoritas en <datos>/data/skin-favorites.json ({ version: 1, ids }), en serie y con escritura
// atomica (core/util.writeJson). Sin Electron (carpeta, archivo y lectura se inyectan): test/catalog.test.js.
const fsp = require('fs/promises');
const crypto = require('crypto');
const png = require('./png');
const { readJson, writeJson } = require('../../core/util');
const { resolveInside } = require('../packs/safety');

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const CATEGORY = /^[A-Za-z0-9_-]{1,40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MODELS = new Set(['classic', 'slim']);
const PREFIX = 'skins/'; // las rutas de catalog.json son relativas a assets/
const MAX_PNG = 64 * 1024;
const MAX_JSON = 8 * 1024 * 1024;
const PAGE = 48;
const MAX_PAGE = 96;
const MAX_FAVORITES = 5000;
const NAME_MAX = 60;

// Texto para buscar: sin tildes ni mayusculas ("Estéticas" -> "esteticas").
const fold = (v) =>
  String(v ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

function cleanName(raw) {
  const s = String(raw ?? '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(s).slice(0, NAME_MAX).join('').trim();
}

const int = (v, fallback, min, max) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : fallback);

// Entrada valida del catalogo (con la ruta absoluta del PNG) o null.
function validEntry(raw, dir) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { id, file, width, height, sha256, model, category } = raw;
  if (typeof id !== 'string' || !ID.test(id)) return null;
  if (typeof file !== 'string' || !file.startsWith(PREFIX) || !/\.png$/i.test(file) || file.includes('\\')) return null;
  const full = resolveInside(dir, file.slice(PREFIX.length), { instance: false });
  if (!full) return null;
  if (width !== 64 || (height !== 64 && height !== 32)) return null;
  if (typeof sha256 !== 'string' || !SHA256.test(sha256)) return null;
  if (!MODELS.has(model) || typeof category !== 'string' || !CATEGORY.test(category)) return null;
  const name = cleanName(raw.name) || id;
  const legacy = height === 32;
  // Las de 64x32 (formato viejo) son siempre clasicas
  return { id, name, category, model: legacy ? 'classic' : model, legacy, width, height, sha256, full, search: fold(`${name} ${category} ${id}`) };
}

function createCatalog({ dir, favoritesFile, fail, readFile = (p) => fsp.readFile(p), warn = (...a) => console.warn(...a) } = {}) {
  if (!dir || !favoritesFile || typeof fail !== 'function') throw new Error('skins catalog: faltan dir, favoritesFile o fail');
  const jsonFile = resolveInside(dir, 'catalog.json', { instance: false });
  const checked = new Map(); // sha256 -> pixelHash (los PNG no cambian: el sha256 se revisa en cada lectura)
  const broken = new Set(); // ids ya avisados en la consola

  // ---------- Catalogo (una sola vez; si falla, se reintenta en el proximo pedido) ----------
  let loading = null;
  function load() {
    if (loading) return loading;
    loading = (async () => {
      let list;
      try {
        const raw = await readFile(jsonFile);
        if (raw.length > MAX_JSON) throw new Error('catalog.json demasiado grande');
        list = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
      } catch (err) {
        warn('[skins] catálogo:', err?.message || String(err));
        throw fail('catalogUnavailable');
      }
      if (!Array.isArray(list)) {
        warn('[skins] catálogo: catalog.json no es una lista');
        throw fail('catalogUnavailable');
      }
      const entries = [];
      const byId = new Map();
      for (const raw of list) {
        const e = validEntry(raw, dir);
        if (!e || byId.has(e.id)) continue;
        byId.set(e.id, e);
        entries.push(e);
      }
      const dropped = list.length - entries.length;
      if (dropped) warn(`[skins] catálogo: se descartaron ${dropped} de ${list.length} entradas inválidas o repetidas`);
      if (!entries.length) throw fail('catalogUnavailable');
      const categories = [...new Set(entries.map((e) => e.category))];
      return { entries, byId, categories };
    })();
    loading.catch(() => {
      loading = null;
    });
    return loading;
  }

  async function entryOf(id) {
    const { byId } = await load();
    const e = typeof id === 'string' ? byId.get(id) : null;
    if (!e) throw fail('catalogNotFound');
    return e;
  }

  // Bytes del PNG revisados (tamano, encabezado, sha256 y pixeles) y su pixelHash. null si no pasa.
  async function readEntry(e) {
    let bytes;
    try {
      bytes = await readFile(e.full);
    } catch {
      bytes = null;
    }
    if (bytes && !Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
    let ok = Boolean(bytes) && bytes.length <= MAX_PNG;
    if (ok) {
      const head = png.inspect(bytes);
      ok = Boolean(head) && head.width === e.width && head.height === e.height && crypto.createHash('sha256').update(bytes).digest('hex') === e.sha256;
    }
    if (ok && !checked.has(e.sha256)) {
      const c = png.check(bytes, { maxBytes: MAX_PNG });
      if (c.ok) checked.set(e.sha256, c.pixelHash);
      else ok = false;
    }
    if (!ok) {
      if (!broken.has(e.id)) {
        broken.add(e.id);
        warn(`[skins] catálogo: el archivo de ${e.id} falta o está dañado`);
      }
      return null;
    }
    return { bytes, pixelHash: checked.get(e.sha256) };
  }

  const publicEntry = (e) => ({ id: e.id, name: e.name, category: e.category, model: e.model, legacy: e.legacy, width: e.width, height: e.height });

  // ---------- Favoritas ----------
  let favLoad = null;
  let favQueue = Promise.resolve();
  function favorites() {
    if (!favLoad) {
      favLoad = (async () => {
        // Acepta tambien el formato de la 1.0.11 ({ ids }) y una lista suelta
        const data = await readJson(favoritesFile, null);
        const ids = Array.isArray(data) ? data : Array.isArray(data?.ids) ? data.ids : [];
        return new Set(ids.filter((v) => typeof v === 'string' && ID.test(v)).slice(-MAX_FAVORITES));
      })();
    }
    return favLoad;
  }
  const countKnown = (set, byId) => {
    let n = 0;
    for (const id of set) if (byId.has(id)) n++;
    return n;
  };

  return {
    // Una pagina de resultados con las imagenes en data:. limit 0 devuelve solo los totales.
    // categories: cuantas hay de cada categoria con los demas filtros (busqueda, modelo y favoritas).
    async list(opts) {
      const cat = await load();
      const o = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
      const terms = fold(typeof o.query === 'string' ? o.query.slice(0, 100) : '')
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 8);
      const category = typeof o.category === 'string' ? o.category : '';
      const model = MODELS.has(o.model) ? o.model : '';
      const onlyFavorites = o.onlyFavorites === true;
      const limit = int(o.limit, PAGE, 0, MAX_PAGE);
      const offset = int(o.offset, 0, 0, 1e6);
      const favs = await favorites();
      const counts = new Map(cat.categories.map((c) => [c, 0]));
      const matches = [];
      for (const e of cat.entries) {
        if (model && e.model !== model) continue;
        if (onlyFavorites && !favs.has(e.id)) continue;
        if (terms.length && !terms.every((w) => e.search.includes(w))) continue;
        counts.set(e.category, counts.get(e.category) + 1);
        if (!category || e.category === category) matches.push(e);
      }
      const items = [];
      for (const e of matches.slice(offset, offset + limit)) {
        const r = await readEntry(e);
        items.push({ ...publicEntry(e), favorite: favs.has(e.id), broken: !r, pixelHash: r ? r.pixelHash : null, image: r ? `data:image/png;base64,${r.bytes.toString('base64')}` : null });
      }
      return {
        items,
        total: matches.length,
        offset,
        limit,
        categories: [...counts].map(([id, count]) => ({ id, count })),
        favoriteCount: countKnown(favs, cat.byId),
        catalogTotal: cat.entries.length,
      };
    },

    // Datos y bytes revisados de una skin (para subirla, guardarla en la biblioteca o exportarla).
    async read(id) {
      const e = await entryOf(id);
      const r = await readEntry(e);
      if (!r) throw fail('catalogDamaged');
      return { item: { ...publicEntry(e), pixelHash: r.pixelHash }, bytes: r.bytes };
    },

    // Marca o desmarca una favorita. Las escrituras van en serie: el archivo nunca queda a medias.
    async setFavorite(id, enabled) {
      const { byId } = await load();
      if (typeof id !== 'string' || !byId.has(id)) throw fail('catalogNotFound');
      const on = enabled === true;
      const run = favQueue.then(async () => {
        const set = await favorites();
        const had = set.has(id);
        if (had !== on) {
          if (on) {
            if (set.size >= MAX_FAVORITES) set.delete(set.values().next().value);
            set.add(id);
          } else set.delete(id);
          try {
            await writeJson(favoritesFile, { version: 1, ids: [...set] });
          } catch (err) {
            if (on) set.delete(id);
            else set.add(id);
            warn('[skins] favoritas:', err?.message || String(err));
            throw fail('diskError');
          }
        }
        return { id, favorite: on, favoriteCount: countKnown(set, byId) };
      });
      favQueue = run.catch(() => {});
      return run;
    },
  };
}

module.exports = { createCatalog, validEntry, fold, PAGE, MAX_PAGE };
