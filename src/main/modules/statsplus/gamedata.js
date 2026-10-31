'use strict';
// Datos del propio juego para mostrar nombres reales: textos (lang) y definiciones de logros (advancements).
// Se leen del .jar de cada version instalada (en_us + advancements) y de los assets descargados (otros idiomas).
// Lo extraido del .jar se guarda en cache/stats/game-<version>.json para no volver a abrirlo.
// Si no hay ninguna version instalada se usan los nombres del diccionario "stats" o el id embellecido.
const fsp = require('fs/promises');
const path = require('path');
const paths = require('../../core/paths');
const i18n = require('../../core/i18n');
const { readJson, writeJson } = require('../../core/util');

const CACHE_V = 1;
const KEEP = /^(block|item|entity|stat|advancements)\./;
// Idioma del launcher -> idiomas del juego (en orden de preferencia)
const LOCALES = {
  es: ['es_ar', 'es_es', 'es_mx'],
  en: ['en_us'],
  pt: ['pt_br', 'pt_pt'],
  fr: ['fr_fr', 'fr_ca'],
  de: ['de_de'],
  it: ['it_it'],
  nl: ['nl_nl'],
  pl: ['pl_pl'],
  ru: ['ru_ru'],
  uk: ['uk_ua'],
  tr: ['tr_tr'],
  ja: ['ja_jp'],
  ko: ['ko_kr'],
  zh: ['zh_cn'],
};

let versionsMemo = null;
const jarMemo = new Map(); // version -> Promise<datos | null>
const namesMemo = new Map(); // idioma -> { at, promise }

// "minecraft:diamond_ore" -> "Diamond Ore"
function prettify(id) {
  const p = String(id || '')
    .split(':')
    .pop()
    .split('/')
    .pop()
    .replace(/[_.]+/g, ' ')
    .trim();
  return p ? p.replace(/(^|\s)\S/g, (c) => c.toUpperCase()) : String(id || '');
}

function splitId(id) {
  const s = String(id || '');
  const i = s.indexOf(':');
  return i < 0 ? ['minecraft', s] : [s.slice(0, i), s.slice(i + 1)];
}

// Versiones vanilla instaladas (las que tienen assetIndex), de la mas nueva a la mas vieja.
async function installedVersions() {
  if (versionsMemo && Date.now() - versionsMemo.at < 60000) return versionsMemo.list;
  const list = [];
  let entries = [];
  try {
    entries = await fsp.readdir(paths.versions(), { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const json = await readJson(paths.versionJson(e.name), null);
    if (!json || json.inheritsFrom) continue;
    const jar = paths.versionJar(e.name);
    const hasJar = await fsp
      .stat(jar)
      .then((st) => st.isFile() && st.size > 0)
      .catch(() => false);
    list.push({ id: e.name, time: Date.parse(json.releaseTime || json.time || '') || 0, assetIndex: json.assetIndex?.id || json.assets || null, hasJar, jar });
  }
  list.sort((a, b) => b.time - a.time);
  versionsMemo = { at: Date.now(), list };
  return list;
}

function textKey(c) {
  if (!c) return null;
  if (typeof c === 'object' && typeof c.translate === 'string') return c.translate;
  return null;
}
function textLiteral(c) {
  if (typeof c === 'string') return c;
  if (c && typeof c === 'object' && typeof c.text === 'string' && c.text) return c.text;
  return null;
}

function parseLangFile(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0 && !line.startsWith('#')) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

// Extrae del .jar: textos en ingles y definiciones de logros (sin recetas). Con cache en disco.
function jarData(versionId) {
  if (!versionId || !/^[\w.+-]{1,64}$/.test(versionId)) return Promise.resolve(null);
  if (jarMemo.has(versionId)) return jarMemo.get(versionId);
  const p = (async () => {
    const jar = paths.versionJar(versionId);
    const st = await fsp.stat(jar).catch(() => null);
    if (!st || !st.isFile()) return null;
    const cacheFile = paths.cache('stats', `game-${versionId}.json`);
    const cached = await readJson(cacheFile, null);
    if (cached && cached.v === CACHE_V && cached.size === st.size && cached.mtimeMs === Math.round(st.mtimeMs)) return cached;
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(await fsp.readFile(jar));
    const out = { v: CACHE_V, version: versionId, size: st.size, mtimeMs: Math.round(st.mtimeMs), lang: {}, advancements: [] };
    for (const e of zip.getEntries()) {
      if (e.isDirectory) continue;
      const n = e.entryName;
      const m = /^(?:data|assets)\/minecraft\/advancements?\/(.+)\.json$/.exec(n);
      if (m) {
        const rel = m[1];
        if (rel.startsWith('recipes/')) continue;
        let def = null;
        try {
          def = JSON.parse(e.getData().toString('utf8'));
        } catch {
          continue;
        }
        const d = def?.display;
        if (!d) continue;
        out.advancements.push({
          id: `minecraft:${rel}`,
          category: rel.split('/')[0],
          titleKey: textKey(d.title),
          title: textLiteral(d.title),
          descKey: textKey(d.description),
          desc: textLiteral(d.description),
          frame: ['task', 'goal', 'challenge'].includes(d.frame) ? d.frame : 'task',
          hidden: Boolean(d.hidden),
          icon: d.icon?.id || d.icon?.item || null,
          parent: typeof def.parent === 'string' ? def.parent : null,
        });
        continue;
      }
      if (n === 'assets/minecraft/lang/en_us.json') {
        try {
          for (const [k, v] of Object.entries(JSON.parse(e.getData().toString('utf8')))) if (KEEP.test(k) && typeof v === 'string') out.lang[k] = v;
        } catch {
          /* idioma ilegible */
        }
      } else if (/^assets\/minecraft\/lang\/en_us\.lang$/i.test(n)) {
        // Versiones viejas (1.12 o anterior): formato clave=valor; solo sirven los textos de logros.
        for (const [k, v] of Object.entries(parseLangFile(e.getData().toString('utf8')))) if (k.startsWith('advancements.')) out.lang[k] = v;
      }
    }
    out.advancements.sort((a, b) => a.id.localeCompare(b.id));
    await writeJson(cacheFile, out).catch(() => {});
    return out;
  })().catch((err) => {
    console.warn(`[stats] No se pudo leer el jar de ${versionId}:`, err.message);
    return null;
  });
  jarMemo.set(versionId, p);
  // Si todavia no esta instalado, reintentar la proxima vez.
  p.then((v) => {
    if (!v) jarMemo.delete(versionId);
  });
  return p;
}

// Textos de un idioma desde los assets descargados (objects/<hash>).
async function assetLang(indexId, locales) {
  if (!indexId || !/^[\w.-]{1,64}$/.test(indexId)) return null;
  const index = await readJson(path.join(paths.assets(), 'indexes', `${indexId}.json`), null);
  if (!index?.objects) return null;
  for (const loc of locales) {
    const obj = index.objects[`minecraft/lang/${loc}.json`];
    if (!obj?.hash || !/^[0-9a-f]{40}$/.test(obj.hash)) continue;
    try {
      const all = JSON.parse(await fsp.readFile(path.join(paths.assets(), 'objects', obj.hash.slice(0, 2), obj.hash), 'utf8'));
      const out = {};
      for (const [k, v] of Object.entries(all)) if (KEEP.test(k) && typeof v === 'string') out[k] = v;
      return out;
    } catch {
      /* recurso no descargado */
    }
  }
  return null;
}

function makeNames(map) {
  const tr = (key) => (key && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null);
  const own = (p) => {
    const key = `stats.id_${p.replace(/[^a-z0-9_]/g, '_')}`;
    const v = i18n.t(key);
    return v === key ? null : v;
  };
  return {
    size: Object.keys(map).length,
    // kind: 'mined' | 'killed' | 'killedBy' | otro (items)
    of(kind, id) {
      const [ns, p] = splitId(id);
      const dotted = p.replace(/\//g, '.');
      const keys = kind === 'killed' || kind === 'killedBy' ? [`entity.${ns}.${dotted}`] : kind === 'mined' ? [`block.${ns}.${dotted}`, `item.${ns}.${dotted}`] : [`item.${ns}.${dotted}`, `block.${ns}.${dotted}`];
      for (const k of keys) {
        const v = tr(k);
        if (v) return v;
      }
      return (ns === 'minecraft' && own(p)) || prettify(id);
    },
    stat(id) {
      const [ns, p] = splitId(id);
      return tr(`stat.${ns}.${p}`) || (ns === 'minecraft' && own(p)) || prettify(id);
    },
    text: (key) => tr(key),
  };
}

// Nombres para el idioma elegido: ingles del jar mas nuevo + traduccion de los assets.
function names(lang = i18n.getLanguage()) {
  const hit = namesMemo.get(lang);
  if (hit && Date.now() - hit.at < 5 * 60000) return hit.promise;
  const promise = (async () => {
    const versions = await installedVersions();
    let base = {};
    for (const v of versions.filter((x) => x.hasJar)) {
      const d = await jarData(v.id);
      if (d && Object.keys(d.lang).length > 200) {
        base = d.lang;
        break;
      }
    }
    let local = {};
    const locales = LOCALES[lang] || [];
    if (lang !== 'en' && locales.length) {
      for (const v of versions) {
        const m = await assetLang(v.assetIndex, locales);
        if (m) {
          local = m;
          break;
        }
      }
    }
    return makeNames({ ...base, ...local });
  })().catch((err) => {
    console.warn('[stats] nombres del juego:', err.message);
    return makeNames({});
  });
  namesMemo.set(lang, { at: Date.now(), promise });
  return promise;
}

// Logros visibles de una version (sin recetas) o null si su .jar no esta instalado.
async function advancements(mcVersion) {
  const d = await jarData(mcVersion);
  return d && d.advancements.length ? d.advancements : null;
}

// Orden de versiones segun su fecha de salida (para elegir la mas nueva).
async function versionTime(id) {
  const v = (await installedVersions()).find((x) => x.id === id);
  return v ? v.time : 0;
}

function invalidate() {
  versionsMemo = null;
  namesMemo.clear();
}

module.exports = { names, advancements, installedVersions, versionTime, prettify, splitId, invalidate, jarData };
