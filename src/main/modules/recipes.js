'use strict';
// Recetas e items de una partida, leidos de los archivos del propio juego: el .jar del cliente de esa version
// (versions/<v>/<v>.jar) y, si tiene, los .jar de mods/ de la instancia. Lo usa el panel del overlay (overlay.js).
// Nada de Mojang viene en el repositorio: se lee en la PC del usuario y se guarda en <datos>/cache/recipes/ (una
// pareja de archivos por .jar, que se vuelve a leer si cambia su tamano o su fecha). Antes de la 1.12 el juego no
// trae recetas en JSON: info.recipes queda en 0. Los errores vienen con err.code ('noVersion', 'noJar').
//   open({ rootId, instanceDir, lang?, assetIndex?, mods? }) -> sesion { info, search(q), card(id), icons(ids), wiki(id) }
// Canales (por instancia, sin partida abierta):
//   recipes:search(instanceId, texto) -> { total, items: [{ id, name, hasRecipe }], icons }
//   recipes:item(instanceId, id)      -> { id, name, en, recipes, uses, wiki, icons } | null
const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');
const paths = require('../core/paths');
const { readJar } = require('./recipes/jar');
const { createBook, cardIconIds, wikiUrl } = require('./recipes/book');
const { pickNames } = require('./recipes/parse');

// Subir este numero cuando cambie lo que se guarda: invalida la cache
const CACHE_VERSION = 1;
const MAX_MODS = 500;
const SESSIONS = 2; // cuantas sesiones quedan en memoria
// Con cientos de mods la primera lectura es larga (despues sale de la cache). El panel no espera mas que esto: lo que falta
// se sigue leyendo en segundo plano, de a uno y dejando respirar al launcher, y la proxima vez que se abra ya esta completo.
const BUILD_BUDGET_MS = 30000;
const later = () => new Promise((resolve) => setImmediate(resolve));

const sessions = new Map(); // clave -> Promise<sesion>

function coded(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

const safeId = (s) => /^[\w.+-]{1,120}$/.test(String(s || ''));

// Archivos de cache de un .jar (el nombre lleva la version para que se pueda ver a mano)
function cacheFiles(dir, jar, st, lang, label) {
  const hash = crypto.createHash('sha1').update(`${CACHE_VERSION}|${path.resolve(jar)}|${st.size}|${Math.round(st.mtimeMs)}|${lang || ''}`).digest('hex').slice(0, 16);
  const base = path.join(dir, `${String(label || 'jar').replace(/[^\w.+-]+/g, '_').slice(0, 60)}-${hash}`);
  return { data: `${base}.json`, icons: `${base}.icons.json` };
}

async function readJsonFile(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

// Fuente: lo que hay en un .jar (de la cache o leyendolo). Los iconos quedan en su archivo hasta que hacen falta.
async function loadSource(jar, { cacheDir, lang, label }) {
  const st = await fsp.stat(jar);
  const files = cacheFiles(cacheDir, jar, st, lang, label);
  const cached = await readJsonFile(files.data);
  if (cached && cached.v === CACHE_VERSION) return { ...cached, iconsFile: files.icons };
  const { icons, ...data } = await readJar(jar, { lang });
  await fsp.mkdir(cacheDir, { recursive: true });
  await fsp.writeFile(files.icons, JSON.stringify(icons));
  await fsp.writeFile(files.data, JSON.stringify({ v: CACHE_VERSION, ...data }));
  return { v: CACHE_VERSION, ...data, iconsFile: files.icons };
}

// Nombres del idioma del juego: el .jar del cliente solo trae el ingles, los demas estan en los assets
async function assetNames({ assetsDir, assetIndex, lang }) {
  if (!assetsDir || !assetIndex || !lang || lang.toLowerCase() === 'en_us' || !safeId(assetIndex)) return null;
  const index = await readJsonFile(path.join(assetsDir, 'indexes', `${assetIndex}.json`));
  const wanted = new Set([`minecraft/lang/${lang}.json`, `minecraft/lang/${lang}.lang`].map((k) => k.toLowerCase()));
  const key = Object.keys(index?.objects || {}).find((k) => wanted.has(k.toLowerCase()));
  const hash = key && index.objects[key]?.hash;
  if (!hash || !/^[0-9a-f]{40}$/.test(hash)) return null;
  try {
    const { parseLang } = require('./capture/gamelang');
    return pickNames(parseLang(await fsp.readFile(path.join(assetsDir, 'objects', hash.slice(0, 2), hash), 'utf8')));
  } catch {
    return null;
  }
}

// Los .jar activos de mods/ de la instancia
async function modJars(dir) {
  let names = [];
  try {
    names = (await fsp.readdir(path.join(dir, 'mods'), { withFileTypes: true })).filter((e) => e.isFile() && /\.jar$/i.test(e.name)).map((e) => e.name);
  } catch {
    return { jars: [], skipped: 0 };
  }
  names.sort();
  return { jars: names.slice(0, MAX_MODS).map((n) => path.join(dir, 'mods', n)), skipped: Math.max(0, names.length - MAX_MODS) };
}

async function assetIndexOf(rootId) {
  const data = await readJsonFile(path.join(path.dirname(paths.versionJar(rootId)), `${rootId}.json`));
  return typeof data?.assetIndex?.id === 'string' ? data.assetIndex.id : null;
}

async function build({ jar, rootId, instanceDir, lang, assetIndex, mods, assetsDir, cacheDir, budgetMs = BUILD_BUDGET_MS, onComplete }) {
  const started = Date.now();
  const client = await loadSource(jar, { cacheDir, lang: null, label: rootId });
  const list = mods && instanceDir ? await modJars(instanceDir) : { jars: [], skipped: 0 };
  const sources = [client];
  const modSource = (m) => loadSource(m, { cacheDir: path.join(cacheDir, 'mods'), lang, label: path.basename(m, path.extname(m)) });
  let failed = 0;
  const rest = [];
  for (const m of list.jars) {
    if (Date.now() - started > budgetMs) {
      rest.push(m);
      continue;
    }
    try {
      sources.push(await modSource(m));
    } catch (err) {
      failed++;
      console.warn('[recipes] mod:', path.basename(m), err?.message || err);
    }
    await later(); // entre un .jar y otro el launcher atiende lo suyo (esto corre en el proceso principal mientras se juega)
  }
  if (rest.length) {
    (async () => {
      for (const m of rest) {
        try {
          await modSource(m);
        } catch {
          /* un .jar que no se lee se cuenta en la proxima vuelta */
        }
        await later();
      }
      onComplete?.();
    })();
  }
  const langTable = await assetNames({ assetsDir, assetIndex: assetIndex || (await assetIndexOf(rootId).catch(() => null)), lang });
  const book = createBook(sources, { langTable });
  const iconFiles = new Map();
  const iconOwners = new Map(); // item -> fuente que trae su icono (un mod puede reemplazar el del juego)
  for (const s of sources) for (const id of s.iconIds || []) iconOwners.set(id, s);
  const iconsOf = (s) => {
    if (!iconFiles.has(s.iconsFile)) iconFiles.set(s.iconsFile, readJsonFile(s.iconsFile).then((d) => d || {}));
    return iconFiles.get(s.iconsFile);
  };
  async function icons(ids) {
    const out = {};
    for (const id of ids) {
      const s = iconOwners.get(id);
      if (!s) continue;
      const png = (await iconsOf(s))[id];
      if (png) out[id] = `data:image/png;base64,${png}`;
    }
    return out;
  }
  const session = {
    info: { version: rootId, mods: sources.length - 1, modsFailed: failed, modsSkipped: list.skipped, modsPending: rest.length, recipes: book.recipeCount, items: book.size, translated: Boolean(langTable) },
    async search(query, limit) {
      const r = book.search(query, limit);
      return { ...r, icons: await icons(r.items.map((i) => i.id)) };
    },
    async card(id) {
      const c = book.card(id);
      if (!c) return null;
      return { ...c, wiki: Boolean(wikiUrl(id, c.en)), icons: await icons(cardIconIds(c)) };
    },
    wiki(id) {
      const it = book.has(id) ? book.item(id) : null;
      return it ? wikiUrl(id, it.en) : null;
    },
    icons,
  };
  return session;
}

/**
 * Sesion de recetas de una version. El .jar del cliente tiene que estar (lo baja el launcher al preparar la partida).
 * opts: { rootId, instanceDir?, lang?, assetIndex?, mods?, jarPath?, assetsDir?, cacheDir?, budgetMs? } (los cuatro ultimos, para las pruebas)
 */
async function open(opts) {
  const { rootId, instanceDir = null, lang = null, assetIndex = null, mods = false } = opts || {};
  if (!safeId(rootId)) throw coded('noVersion');
  const jar = opts.jarPath || paths.versionJar(rootId);
  const st = await fsp.stat(jar).catch(() => null);
  if (!st || !st.isFile()) throw coded('noJar');
  const key = JSON.stringify([jar, st.size, Math.round(st.mtimeMs), instanceDir, lang, mods]);
  if (!sessions.has(key)) {
    // Si quedaron mods para leer despues, al terminar se descarta esta sesion: la proxima apertura sale completa de la cache
    const promise = build({ jar, rootId, instanceDir, lang, assetIndex, mods, assetsDir: opts.assetsDir || paths.assets(), cacheDir: opts.cacheDir || paths.cache('recipes'), budgetMs: opts.budgetMs, onComplete: () => sessions.get(key) === promise && sessions.delete(key) });
    sessions.set(key, promise);
    promise.catch(() => sessions.delete(key));
    while (sessions.size > SESSIONS) sessions.delete(sessions.keys().next().value);
  }
  return sessions.get(key);
}

function forget() {
  sessions.clear();
}

// Sesion de una instancia sin partida abierta (la version sale de sus metadatos)
async function forInstance(instanceId) {
  const instances = require('../core/instances');
  const gamelang = require('./capture/gamelang');
  const inst = await instances.get(instanceId);
  return open({ rootId: inst.mcVersion, instanceDir: inst.dir, lang: await gamelang.readLanguage(inst.dir), mods: true });
}

function register({ handle, onQuit }) {
  handle('recipes:search', async (instanceId, query) => (await forInstance(instanceId)).search(typeof query === 'string' ? query.slice(0, 80) : ''));
  handle('recipes:item', async (instanceId, id) => (await forInstance(instanceId)).card(typeof id === 'string' ? id.slice(0, 200) : ''));
  onQuit?.(() => forget());
}

module.exports = { register, open, forget };
