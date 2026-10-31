'use strict';
// Interprete local del Buscador inteligente: entiende pedidos en espanol, ingles y portugues
// ("Buscame mods y texturas para un singleplayer de zombies") sin necesidad de IA y arma el
// plan de busquedas para Modrinth.
const L = require('./lexicon');

const ORDER = ['mod', 'resourcepack', 'shader', 'datapack', 'plugin', 'modpack'];
const MAX_PER_TYPE = 12;
const MAX_SEARCHES_PER_TYPE = 4;

// ---------- Texto ----------

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9.+\s]/g, ' ')
    .replace(/\.(?![0-9])|(?<![0-9])\./g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const rxCache = new Map();
function rx(alts) {
  const src = Array.isArray(alts) ? alts.join('|') : alts;
  let r = rxCache.get(src);
  if (!r) {
    r = new RegExp(`(?<![a-z0-9])(?:${src})(?![a-z0-9])`, 'g');
    rxCache.set(src, r);
  }
  r.lastIndex = 0;
  return r;
}

// Busca coincidencias en el texto de trabajo y (opcionalmente) las tapa con espacios para que
// otra regla no las vuelva a usar. Los indices se conservan.
function take(state, alts, mask = true) {
  const re = rx(alts);
  const found = [];
  let m;
  while ((m = re.exec(state.text))) {
    if (!m[0].trim()) {
      re.lastIndex++;
      continue;
    }
    found.push({ start: m.index, end: m.index + m[0].length, text: m[0].trim() });
  }
  if (mask) for (const f of found) maskSpan(state, f);
  return found;
}

function maskSpan(state, f) {
  state.text = state.text.slice(0, f.start) + ' '.repeat(f.end - f.start) + state.text.slice(f.end);
}

const stem = (w) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w);
const PHRASES = Object.keys(L.WORDS).filter((k) => k.includes(' '));

// ---------- Versiones ----------

const VERSION_RE = /(?<![0-9.])(1\.[0-9]{1,2}(?:\.[0-9]{1,2})?|2[0-9]\.[0-9]{1,2}(?:\.[0-9]{1,2})?)(?![0-9.])/g;

// Convierte una mencion ("1.20", "1.8", "26.1") en una version real.
function resolveVersion(raw, releases) {
  const known = releases && releases.size ? releases : null;
  if (/^1\.\d+$/.test(raw) && L.MODDED_PATCH[raw] && (!known || known.has(L.MODDED_PATCH[raw]))) {
    return { value: L.MODDED_PATCH[raw], raw, mapped: true };
  }
  if (!known || known.has(raw)) return { value: raw, raw, mapped: false };
  return null;
}

// ---------- Idioma ----------

function guessLang(tokens, fallback = 'es') {
  const score = { es: 0, pt: 0, en: 0 };
  for (const tk of tokens) for (const [lang, words] of Object.entries(L.LANG_HINTS)) if (words.includes(tk)) score[lang]++;
  const best = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : fallback;
}

// ---------- Interpretacion ----------

function typeOfWord(word) {
  for (const [type, alts] of L.TYPE_PATTERNS) if (rx(alts).test(word)) return type;
  return null;
}

/**
 * Lee el pedido y devuelve lo que se entendio (sin resolver contra filtros ni instancias).
 * ctx: { releases: Set<string>, uiLang }
 */
function interpret(query, ctx = {}) {
  const normalized = normalize(query);
  const state = { text: ` ${normalized} `, orig: ` ${normalized} ` };
  const out = {
    normalized,
    lang: 'es',
    types: [],
    excluded: [],
    more: false,
    counts: {},
    version: null,
    badVersion: null,
    latest: false,
    loader: null,
    vanilla: false,
    shaderLoader: null,
    serverSoftware: null,
    mode: null,
    themes: [],
    related: [],
    terms: [],
    flags: { lowEnd: false, highEnd: false },
  };

  // Versiones ("1.20.1", "1.8", "26.1")
  VERSION_RE.lastIndex = 0;
  let vm;
  const versionSpans = [];
  while ((vm = VERSION_RE.exec(state.text))) {
    versionSpans.push({ start: vm.index, end: vm.index + vm[0].length, text: vm[0] });
    if (!out.version) {
      const v = resolveVersion(vm[1], ctx.releases);
      if (v) out.version = v;
      else if (!out.badVersion) out.badVersion = vm[1];
    }
  }
  versionSpans.forEach((s) => maskSpan(state, s));
  if (take(state, L.LATEST_PATTERNS).length && !out.version) out.latest = true;

  // Cantidades: "5 mods", "3 mejores shaders"
  const countRe = /(?<![0-9.])([0-9]{1,2}) (?:mejores |buenos |best |good |top |melhores )?([a-z]+(?: ?packs?)?)/g;
  let cm;
  while ((cm = countRe.exec(state.text))) {
    const type = typeOfWord(cm[2]);
    const n = Number(cm[1]);
    if (type && n > 0) out.counts[type] = Math.min(MAX_PER_TYPE, n);
  }

  // Tipos de contenido (con negaciones: "sin shaders")
  for (const [type, alts] of L.TYPE_PATTERNS) {
    for (const f of take(state, alts)) {
      const before = state.orig.slice(Math.max(0, f.start - 28), f.start);
      if (L.NEGATION.test(before)) {
        if (!out.excluded.includes(type)) out.excluded.push(type);
      } else if (!out.types.includes(type)) out.types.push(type);
    }
  }
  out.types = out.types.filter((tp) => !out.excluded.includes(tp));
  if (take(state, L.MORE_PATTERNS).length) out.more = true;

  // Loaders, software de servidor y "sin mods"
  if (take(state, L.VANILLA_PATTERNS).length || out.excluded.includes('mod')) out.vanilla = true;
  for (const [loader, alts] of L.LOADER_PATTERNS) if (take(state, alts).length && !out.loader) out.loader = loader;
  for (const [sl, alts] of L.SHADER_LOADER_PATTERNS) if (take(state, alts).length && !out.shaderLoader) out.shaderLoader = sl;
  for (const [sw, alts] of L.SERVER_SOFTWARE_PATTERNS) if (take(state, alts).length && !out.serverSoftware) out.serverSoftware = sw;

  // Modo de juego. Sus palabras se tapan recien despues de buscar los temas, porque
  // "servidor de economia" tambien dice de que se trata ("economia").
  const modes = [];
  const deferred = [];
  for (const [mode, alts] of L.MODE_PATTERNS) {
    const found = take(state, alts, false);
    if (found.length) modes.push(mode);
    deferred.push(...found);
  }
  if (modes.includes('server')) out.mode = 'server';
  else if (modes.includes('singleplayer') && modes.includes('multiplayer')) out.mode = 'any';
  else out.mode = modes[0] || null;

  // Hardware
  const lowEnd = take(state, L.LOWEND_PATTERNS, false);
  const highEnd = take(state, L.HIGHEND_PATTERNS, false);
  if (lowEnd.length) out.flags.lowEnd = true;
  if (highEnd.length) out.flags.highEnd = true;
  deferred.push(...lowEnd, ...highEnd);

  // Frases del diccionario con mas de una palabra ("hombres lobo") antes que los temas,
  // para que "lobo" no se lea como "animales".
  const specific = [];
  for (const phrase of PHRASES) for (const f of take(state, [phrase.replace(/ /g, ' ?')])) specific.push(L.WORDS[phrase] || L.WORDS[f.text]);

  // Temas (pueden compartir palabras entre si)
  const themeSpans = [];
  for (const theme of L.THEMES) {
    const found = take(state, theme.p, false);
    if (!found.length) continue;
    themeSpans.push(...found);
    out.themes.push({ id: theme.id, weight: theme.weight ?? 1, pos: found[0].start, minor: false, matches: found.map((f) => f.text) });
    if (theme.flags?.lowEnd) out.flags.lowEnd = true;
    if (theme.flags?.highEnd) out.flags.highEnd = true;
    // Palabras concretas dentro del tema ("dinosaurios" -> dinosaurs) se buscan tal cual
    const generic = new Set(Object.values(theme.q || {}).flat().map(stem));
    for (const f of found) {
      const en = L.WORDS[f.text];
      if (en && !generic.has(stem(en))) specific.push(en);
    }
  }
  out.themes.sort((a, b) => a.pos - b.pos);
  const ids = new Set(out.themes.map((th) => th.id));
  for (const th of out.themes) {
    const def = L.THEMES.find((x) => x.id === th.id);
    for (const sup of def.suppress || []) {
      const other = out.themes.find((x) => x.id === sup);
      if (other) other.minor = true;
    }
  }
  for (const th of out.themes) {
    if (th.minor) continue;
    for (const r of L.THEMES.find((x) => x.id === th.id).rel || []) if (!ids.has(r) && !out.related.includes(r)) out.related.push(r);
  }
  [...themeSpans, ...deferred].forEach((s) => maskSpan(state, s));
  if (!out.mode) {
    const hinted = out.themes.find((th) => !th.minor && L.THEMES.find((x) => x.id === th.id).modeHint);
    if (hinted) out.mode = L.THEMES.find((x) => x.id === hinted.id).modeHint;
  }

  // Palabras sueltas que no entendimos: se traducen si se puede y se buscan tal cual
  const rest = state.text.split(' ').filter(Boolean);
  out.lang = guessLang(normalized.split(' '), ctx.uiLang === 'en' ? 'en' : ctx.uiLang === 'pt' ? 'pt' : 'es');
  const free = [];
  for (let i = 0; i < rest.length; i++) {
    const two = i + 1 < rest.length ? `${rest[i]} ${rest[i + 1]}` : null;
    if (two && L.WORDS[two]) {
      free.push(L.WORDS[two]);
      i++;
      continue;
    }
    const tk = rest[i];
    if (tk.length < 3 || /^[0-9.+]+$/.test(tk) || L.STOPWORDS.has(tk)) continue;
    if (L.WORDS[tk]) free.push(L.WORDS[tk]);
    else if (tk.length >= 4 && /^[a-z][a-z0-9+]*$/.test(tk)) free.push(tk);
  }
  const seen = new Set();
  for (const term of [...specific, ...free]) {
    const k = stem(term);
    if (seen.has(k)) continue;
    seen.add(k);
    out.terms.push(term);
    if (out.terms.length >= 3) break;
  }
  return out;
}

// ---------- Plan ----------

function modLoaderOf(instLoader) {
  if (instLoader === 'legacyfabric') return 'fabric';
  return L.MOD_LOADERS.includes(instLoader) ? instLoader : null;
}

function canonicalTypes(list) {
  return ORDER.filter((tp) => list.includes(tp));
}

/**
 * Resuelve lo interpretado contra los filtros de la interfaz y la instancia elegida.
 * ctx: { filters, target, latestRelease, releases: Set }
 */
function resolvePlan(query, interp, ctx = {}) {
  const f = ctx.filters || {};
  const target = ctx.target || null;
  const plan = {
    query,
    lang: interp.lang,
    source: 'local',
    mcVersion: null,
    versionSource: 'none',
    versionNote: null,
    badVersion: interp.badVersion,
    loader: null,
    loaderSource: 'auto',
    shaderLoader: interp.shaderLoader,
    serverSoftware: interp.serverSoftware,
    mode: 'any',
    modeSource: 'default',
    themes: interp.themes.map((th) => ({ id: th.id, minor: th.minor })),
    related: interp.related.slice(),
    aiThemes: [],
    terms: interp.terms.slice(),
    types: [],
    typesSource: 'default',
    more: interp.more,
    excluded: interp.excluded.slice(),
    perType: {},
    compatibleOnly: f.compatibleOnly !== false,
    flags: { ...interp.flags },
    searches: [],
    boost: {},
    keywords: [],
    avoid: [],
    summary: '',
    targetNoModLoader: false,
  };

  // Version: filtro elegido > mencion en el pedido > instancia > ultima release
  if (f.mcVersion && f.mcVersion !== 'auto') {
    plan.mcVersion = f.mcVersion;
    plan.versionSource = 'filter';
  } else if (interp.version) {
    plan.mcVersion = interp.version.value;
    plan.versionSource = 'query';
    if (interp.version.mapped) plan.versionNote = { from: interp.version.raw, to: interp.version.value };
  } else if (interp.latest && ctx.latestRelease) {
    plan.mcVersion = ctx.latestRelease;
    plan.versionSource = 'query';
  } else if (target?.mcVersion) {
    plan.mcVersion = target.mcVersion;
    plan.versionSource = 'instance';
  } else if (ctx.latestRelease) {
    plan.mcVersion = ctx.latestRelease;
    plan.versionSource = 'latest';
  }

  // Loader: filtro > pedido > instancia (si es la misma version) > automatico segun resultados
  const sameVersion = target && target.mcVersion === plan.mcVersion;
  if (f.loader && f.loader !== 'auto') {
    plan.loader = f.loader;
    plan.loaderSource = 'filter';
  } else if (interp.vanilla) {
    plan.loader = 'vanilla';
    plan.loaderSource = 'query';
  } else if (interp.loader) {
    plan.loader = interp.loader;
    plan.loaderSource = 'query';
  } else if (interp.shaderLoader === 'iris') {
    plan.loader = 'fabric';
    plan.loaderSource = 'query';
  } else if (sameVersion) {
    const ml = modLoaderOf(target.loader);
    if (ml) {
      plan.loader = ml;
      plan.loaderSource = 'instance';
    } else plan.targetNoModLoader = true;
  }
  if (!plan.shaderLoader && sameVersion) {
    if (target.loader === 'optifine') plan.shaderLoader = 'optifine';
    else if (target.hasIris) plan.shaderLoader = 'iris';
  }

  // Modo
  if (interp.mode) {
    plan.mode = interp.mode;
    plan.modeSource = 'query';
  } else if (interp.types.includes('plugin') || interp.serverSoftware) {
    plan.mode = 'server';
    plan.modeSource = 'query';
  }

  // Tipos
  const primary = interp.themes.filter((th) => !th.minor);
  const themeTypes = () => {
    const tally = new Map();
    for (const th of primary) for (const tp of L.THEMES.find((x) => x.id === th.id).types || []) tally.set(tp, (tally.get(tp) || 0) + th.weight);
    return [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([tp]) => tp);
  };
  if (Array.isArray(f.types) && f.types.length) {
    plan.types = f.types.filter((tp) => L.TYPES.includes(tp));
    plan.typesSource = 'filter';
  } else {
    let types = interp.types.slice();
    if (interp.serverSoftware && !types.length) types.push('plugin');
    if (types.length) {
      plan.typesSource = 'query';
      if (interp.more) {
        const extra = primary.length ? themeTypes() : ['resourcepack', 'shader', 'datapack'];
        for (const tp of extra) if (!types.includes(tp)) types.push(tp);
      }
    } else if (plan.mode === 'server') {
      types = ['plugin'];
      if (themeTypes().includes('datapack')) types.push('datapack');
      plan.typesSource = 'default';
    } else if (primary.length) {
      types = themeTypes().slice(0, 4);
      plan.typesSource = 'theme';
    } else {
      types = ['mod', 'resourcepack', 'shader'];
      plan.typesSource = 'default';
    }
    types = types.filter((tp) => !interp.excluded.includes(tp));
    if (plan.loader === 'vanilla' && !interp.types.includes('mod')) types = types.filter((tp) => tp !== 'mod' && tp !== 'modpack');
    if (plan.mode !== 'server' && !interp.types.includes('plugin') && plan.typesSource !== 'query') types = types.filter((tp) => tp !== 'plugin');
    plan.types = types;
  }
  if (!plan.types.length) plan.types = ['mod'];
  plan.types = canonicalTypes(plan.types);

  const base = Math.max(1, Math.min(MAX_PER_TYPE, Number(f.perType) || 5));
  for (const tp of plan.types) plan.perType[tp] = interp.counts[tp] || base;

  plan.searches = localSearches(plan);
  plan.boost = boostFor(plan);
  plan.keywords = keywordsFor(plan);
  plan.avoid = avoidFor(plan);
  return plan;
}

// Busquedas que propone el interprete local para cada tipo del plan.
function localSearches(plan) {
  const out = [];
  const primary = plan.themes.filter((th) => !th.minor).map((th) => L.THEMES.find((x) => x.id === th.id)).filter(Boolean);
  const related = plan.related.map((id) => L.THEMES.find((x) => x.id === id)).filter(Boolean);
  for (const type of plan.types) {
    const list = [];
    const add = (query, categories, weight) => list.push({ type, query, categories: categories || [], weight });
    for (const term of plan.terms.slice(0, 2)) if (type !== 'shader') add(term, [], 1.15);
    if (primary.length >= 2 && ['mod', 'modpack', 'datapack'].includes(type)) {
      const a = primary[0].q?.[type]?.[0];
      const b = primary[1].q?.[type]?.[0];
      if (a && b && a !== b) add(`${a} ${b}`, [], 1.05);
    }
    for (const th of primary) {
      const w = th.weight ?? 1;
      (th.q?.[type] || []).slice(0, 2).forEach((q, i) => add(q, [], w * (i === 0 ? 1 : 0.8)));
      for (const cats of th.cat?.[type] || []) add('', cats, w * 0.9);
    }
    for (const th of related) {
      const q = th.q?.[type]?.[0];
      if (q) list.push({ type, query: q, categories: [], weight: 0.45, related: true });
    }
    if (type === 'shader' && plan.flags.lowEnd) add('', ['potato', 'low'], 0.95);
    if (type === 'shader' && plan.flags.highEnd) add('', ['high', 'screenshot'], 0.7);
    out.push(...capSearches(list, type));
  }
  return out;
}

// Deja las busquedas mas importantes de un tipo y siempre suma una de "populares" como base.
function capSearches(list, type, max = MAX_SEARCHES_PER_TYPE) {
  const byKey = new Map();
  for (const s of list) {
    const key = `${s.query.toLowerCase()}|${[...s.categories].sort().join(',')}`;
    const prev = byKey.get(key);
    if (!prev || prev.weight < s.weight) byKey.set(key, s);
  }
  const sorted = [...byKey.values()].filter((s) => s.query || s.categories.length).sort((a, b) => b.weight - a.weight);
  const picked = sorted.slice(0, max - 1);
  picked.push({ type, query: '', categories: [], weight: picked.length ? 0.3 : 0.8, baseline: true });
  return picked;
}

function boostFor(plan) {
  const out = {};
  const themes = [...plan.themes.filter((th) => !th.minor).map((th) => th.id), ...plan.related];
  for (const type of plan.types) {
    const set = new Set();
    for (const id of themes) for (const c of L.THEMES.find((x) => x.id === id)?.boost?.[type] || []) set.add(c);
    if (type === 'shader' && plan.flags.lowEnd) ['potato', 'low'].forEach((c) => set.add(c));
    if (type === 'shader' && plan.flags.highEnd) ['high', 'screenshot', 'pbr'].forEach((c) => set.add(c));
    if (type === 'resourcepack' && plan.flags.lowEnd) ['16x', '8x-'].forEach((c) => set.add(c));
    if (type === 'resourcepack' && plan.flags.highEnd) ['64x', '128x', '256x'].forEach((c) => set.add(c));
    out[type] = [...set];
  }
  return out;
}

// Frases que delatan resultados fuera de tema (de los temas principales).
// Devuelve [{ text, desc }]: desc = tambien se busca en la descripcion. Se ignoran las frases
// que el usuario escribio (si pide "hypixel", no se descarta Hypixel).
function avoidFor(plan) {
  const q = normalize(plan.query);
  const out = new Map();
  for (const th of plan.themes) {
    if (th.minor) continue;
    const def = L.THEMES.find((x) => x.id === th.id);
    for (const a of def?.avoid || []) if (!q.includes(a)) out.set(a, { text: a, desc: false });
    for (const a of def?.avoidText || []) if (!q.includes(a)) out.set(a, { text: a, desc: true });
  }
  return [...out.values()];
}

// Palabras clave (en ingles) para medir que tan relacionado esta cada resultado.
function keywordsFor(plan) {
  const set = new Set();
  const add = (w) => {
    const k = normalize(w);
    if (k && k.length >= 3 && !L.STOPWORDS.has(k)) set.add(k);
  };
  plan.terms.forEach(add);
  for (const th of plan.themes) {
    if (th.minor) continue;
    const def = L.THEMES.find((x) => x.id === th.id);
    for (const list of Object.values(def?.q || {})) list.forEach(add);
  }
  plan.aiThemes.forEach(add);
  for (const s of plan.searches) if (s.query && s.source === 'ai') add(s.query);
  return [...set].slice(0, 16);
}

// Interpreta y resuelve en un paso.
function plan(query, ctx = {}) {
  const interp = interpret(query, { releases: ctx.releases, uiLang: ctx.uiLang });
  return resolvePlan(query, interp, ctx);
}

module.exports = {
  normalize,
  interpret,
  resolvePlan,
  localSearches,
  capSearches,
  boostFor,
  keywordsFor,
  avoidFor,
  canonicalTypes,
  modLoaderOf,
  plan,
  ORDER,
  MAX_PER_TYPE,
  MAX_SEARCHES_PER_TYPE,
};
