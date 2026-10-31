'use strict';
// Motor del Buscador inteligente: ejecuta el plan en Modrinth, junta y ordena los resultados,
// verifica la compatibilidad real (version + loader) de los mejores candidatos y arma el "kit".
const L = require('./lexicon');
const client = require('./client');
const { normalize, modLoaderOf } = require('./interpreter');
const { compareNumeric } = require('../../core/util');
const { t } = require('../../core/i18n');
// Filtros extra del usuario (frase exacta, palabras excluidas, autor, descargas, fecha, codigo abierto, entorno).
const searchFilters = require('../../core/search-filters');

const CONTENT_TYPES = new Set(['mod', 'datapack', 'plugin', 'modpack']);
const KNOWN_LOADERS = new Set([...L.MOD_LOADERS, ...L.PLUGIN_LOADERS, 'liteloader', 'rift', 'modloader', 'legacy-fabric', 'babric', 'bta-babric', 'nilloader', 'ornithe', 'java-agent', 'bungeecord', 'velocity', 'waterfall', 'sponge', 'iris', 'optifine', 'canvas', 'vanilla', 'minecraft', 'datapack']);
const RESOLUTIONS = new Set(['8x-', '16x', '32x', '48x', '64x', '128x', '256x', '512x+']);
const SHADER_PERF = new Set(['potato', 'low', 'medium', 'high', 'screenshot']);
const COMPAT_SCORE = { verified: 1, likely: 0.6, 'n/a': 0.6, unknown: 0.45, incompatible: 0 };
// Peso de relevancia vs. popularidad por tipo: en lo visual (shaders, texturas) pesa mas la calidad
// probada; en el contenido (mods, data packs...) pesa mas que tenga que ver con el pedido.
const WEIGHTS = { shader: [0.3, 0.41], resourcepack: [0.38, 0.33], default: [0.44, 0.27] };

// ---------- Utilidades ----------

function modLoaders(loader, mcVersion) {
  switch (loader) {
    case 'fabric':
      return ['fabric'];
    case 'quilt':
      return ['quilt', 'fabric'];
    case 'forge':
      return ['forge'];
    case 'neoforge':
      return mcVersion === '1.20.1' ? ['neoforge', 'forge'] : ['neoforge'];
    default:
      return [];
  }
}

function serverLoaders(server) {
  return { paper: ['paper', 'spigot', 'bukkit'], purpur: ['purpur', 'paper', 'spigot', 'bukkit'], fabric: ['fabric'], forge: ['forge'], neoforge: ['neoforge'] }[server?.type] || [];
}

function olderThan(a, b) {
  return Boolean(a) && compareNumeric(a, b) < 0;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const kwCache = new Map();
function kwRegex(kw) {
  let r = kwCache.get(kw);
  if (!r) {
    const base = kw.length > 4 && kw.endsWith('s') ? kw.slice(0, -1) : kw;
    r = new RegExp(`(?<![a-z0-9])${escapeRe(base)}(?:s|es)?(?![a-z0-9])`);
    kwCache.set(kw, r);
  }
  return r;
}

function pickBest(list) {
  return list.find((v) => v.version_type === 'release') || list.find((v) => v.version_type === 'beta') || list[0];
}

function shortVersion(v) {
  if (!v) return null;
  return {
    id: v.id,
    number: v.version_number,
    type: v.version_type,
    loaders: v.loaders || [],
    gameVersions: (v.game_versions || []).slice(-4),
    published: Date.parse(v.date_published) || 0,
  };
}

// Normaliza un resultado de busqueda o un proyecto completo a la misma forma.
function fromHit(hit, type) {
  return {
    id: hit.project_id,
    slug: hit.slug,
    type,
    title: hit.title,
    author: hit.author || null,
    description: hit.description || '',
    icon: hit.icon_url || null,
    downloads: hit.downloads || 0,
    follows: hit.follows || 0,
    updated: Date.parse(hit.date_modified) || 0,
    categories: hit.categories || [],
    displayCategories: hit.display_categories || hit.categories || [],
    gameVersions: hit.versions || [],
    clientSide: hit.client_side || 'unknown',
    serverSide: hit.server_side || 'unknown',
    latestVersion: hit.latest_version || null,
  };
}

function fromProject(p, type) {
  return {
    id: p.id,
    slug: p.slug,
    type,
    title: p.title,
    author: null,
    description: p.description || '',
    icon: p.icon_url || null,
    downloads: p.downloads || 0,
    follows: p.followers || 0,
    updated: Date.parse(p.updated) || 0,
    categories: [...(p.categories || []), ...(p.loaders || [])],
    displayCategories: p.categories || [],
    gameVersions: p.game_versions || [],
    clientSide: p.client_side || 'unknown',
    serverSide: p.server_side || 'unknown',
    latestVersion: (p.versions || []).slice(-1)[0] || null,
  };
}

// ---------- Facetas ----------

function versionFor(type, plan) {
  if (!plan.mcVersion) return null;
  if (type === 'modpack' && !['filter', 'query'].includes(plan.versionSource)) return null;
  return plan.mcVersion;
}

function searchLoaders(type, plan, ctx) {
  if (type === 'mod') return plan.loader && plan.loader !== 'vanilla' ? modLoaders(plan.loader, plan.mcVersion) : L.MOD_LOADERS;
  if (type === 'plugin') return ctx.server ? serverLoaders(ctx.server) : ['paper', 'spigot', 'bukkit', 'purpur'];
  if (type === 'shader') return plan.shaderLoader ? [plan.shaderLoader] : [];
  if (type === 'modpack') return ['filter', 'query'].includes(plan.loaderSource) && plan.loader && plan.loader !== 'vanilla' ? [plan.loader] : [];
  return [];
}

function facetsFor(spec, plan, ctx, { withVersion = true } = {}) {
  const facets = [[`project_type:${spec.type}`]];
  const v = withVersion ? versionFor(spec.type, plan) : null;
  if (v) facets.push([`versions:${v}`]);
  const loaders = searchLoaders(spec.type, plan, ctx);
  if (loaders.length) facets.push(loaders.map((l) => `categories:${l}`));
  if (spec.categories?.length) facets.push(spec.categories.map((c) => `categories:${c}`));
  if (spec.type === 'mod' && plan.mode === 'server') facets.push(['server_side:required', 'server_side:optional']);
  // Filtros extra que Modrinth admite como facets: autor, descargas minimas, fecha, codigo abierto y entorno
  // (el entorno solo tiene sentido en mods y modpacks). Frase exacta y palabras excluidas se filtran en run().
  facets.push(...searchFilters.modrinthFacets(searchFilters.normalize(ctx.filters), { environment: ['mod', 'modpack'].includes(spec.type) }));
  return facets;
}

// ---------- Puntaje ----------

function scoreGroup(cands, plan) {
  const boostList = plan.boost?.[cands[0]?.item.type] || [];
  const wantsLibs = plan.keywords.some((k) => /librar|\bapi\b|core/.test(k));
  const avoid = (plan.avoid || []).map((a) => ({ text: normalize(a.text), desc: a.desc }));
  for (const c of cands) {
    const title = normalize(c.item.title);
    const desc = normalize(c.item.description);
    let text = 0;
    const matched = [];
    for (const kw of plan.keywords) {
      const re = kwRegex(kw);
      if (re.test(title)) {
        text += 0.55;
        matched.push(kw);
      } else if (re.test(desc)) {
        text += 0.25;
        matched.push(kw);
      }
    }
    // Categorias del tema que tiene el proyecto, en el orden de prioridad del tema
    const catHits = boostList.filter((cat) => c.item.categories.includes(cat));
    text += Math.min(0.45, catHits.length * 0.15);
    c.matched = matched.slice(0, 4);
    c.catHits = catHits;
    c.relRaw = c.searchScore + text;
    if (matched.length) c.themed = true;
  }
  const max = Math.max(0.0001, ...cands.map((c) => c.relRaw));
  const recW = olderThan(plan.mcVersion, '1.16.5') ? 0.02 : 0.08;
  for (const c of cands) {
    const it = c.item;
    const title = normalize(it.title);
    const rel = c.relRaw / max;
    const pop = Math.min(1, Math.log10(it.downloads + 1) / 7.3) * 0.7 + Math.min(1, Math.log10(it.follows + 1) / 4.7) * 0.3;
    const days = (Date.now() - it.updated) / 86400000;
    const rec = days <= 60 ? 1 : days <= 180 ? 0.85 : days <= 365 ? 0.65 : days <= 730 ? 0.4 : 0.2;
    const compat = COMPAT_SCORE[c.compat] ?? 0.45;
    const [wRel, wPop] = WEIGHTS[it.type] || WEIGHTS.default;
    let score = wRel * rel + wPop * pop + recW * rec + 0.16 * compat + 0.05;
    // Proyectos casi sin descargas: pueden estar abandonados o no andar bien.
    if (it.downloads < 250) score *= 0.7;
    else if (it.downloads < 1500) score *= 0.85;
    if (it.categories.includes('library') && !wantsLibs) score *= 0.35;
    if (plan.mode === 'server' && it.type === 'mod' && it.serverSide === 'unsupported') score *= 0.4;
    // Mods solo de servidor: no suben los FPS ni sirven al entrar al servidor de otro.
    if (it.type === 'mod' && it.clientSide === 'unsupported' && (plan.flags?.lowEnd || plan.mode === 'multiplayer')) score *= 0.5;
    if (!c.themed && c.typeHasThemes && CONTENT_TYPES.has(it.type)) score *= 0.6;
    if (avoid.length && avoid.some((a) => title.includes(a.text) || (a.desc && normalize(it.description).includes(a.text)))) score *= 0.45;
    // Relleno: no tiene palabras del pedido, ni categorias del tema, y casi no aparecio en las busquedas
    c.weak = CONTENT_TYPES.has(it.type) && !c.matched.length && !c.catHits.length && rel < 0.2;
    c.score = score;
  }
  cands.sort((a, b) => b.score - a.score);
}

// ---------- Verificacion ----------

function verifyLoaders(type, plan, ctx, effLoader) {
  switch (type) {
    case 'mod':
      return modLoaders(effLoader, plan.mcVersion);
    case 'plugin':
      return ctx.server ? serverLoaders(ctx.server) : L.PLUGIN_LOADERS;
    case 'shader':
      if (plan.shaderLoader) return [plan.shaderLoader];
      if (['fabric', 'quilt', 'neoforge', 'forge'].includes(effLoader)) return ['iris'];
      if (effLoader === 'optifine') return ['optifine'];
      return [];
    case 'resourcepack':
      return ['minecraft'];
    case 'datapack':
      return ['datapack'];
    case 'modpack':
      return ['filter', 'query'].includes(plan.loaderSource) && plan.loader && plan.loader !== 'vanilla' ? [plan.loader] : [];
    default:
      return [];
  }
}

async function verify(c, loaders, gameVersion, signal) {
  c.checked = true;
  if (!gameVersion && !loaders.length) {
    c.compat = c.item.type === 'modpack' ? 'n/a' : 'likely';
    return;
  }
  try {
    const list = await client.versions(c.item.id, { loaders, gameVersions: gameVersion ? [gameVersion] : undefined }, signal);
    if (list.length) {
      c.compat = 'verified';
      c.versionRaw = pickBest(list);
    } else c.compat = 'incompatible';
  } catch (err) {
    if (signal?.aborted) throw err;
    c.compat = 'unknown';
  }
}

// Elige el loader con mas soporte entre los mejores mods (cuando el usuario no eligio uno).
function resolveLoader(plan, modCands) {
  if (plan.loader && plan.loader !== 'vanilla') return plan.loader;
  const votes = { fabric: 0, forge: 0, neoforge: 0, quilt: 0 };
  for (const c of modCands.slice(0, 15)) for (const l of Object.keys(votes)) if (c.item.categories.includes(l)) votes[l] += c.score;
  const best = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
  // Empate tecnico: Fabric es el mas comun para mods del lado del cliente.
  if (best && best[1] > 0 && votes.fabric >= best[1] * 0.9) return 'fabric';
  if (best && best[1] > 0) return best[0];
  return olderThan(plan.mcVersion, '1.14') ? 'forge' : 'fabric';
}

function recommendLoader(plan, effLoader, kitHasMods, kitHasShaders) {
  if (kitHasMods) return effLoader;
  const explicit = plan.loader && plan.loader !== 'vanilla' ? plan.loader : null;
  if (kitHasShaders) {
    if (plan.loader === 'vanilla' || olderThan(plan.mcVersion, '1.16.5')) return 'optifine';
    return explicit || 'fabric';
  }
  return explicit || 'vanilla';
}

// Iris u Oculus para que funcionen los shaders (si hace falta).
async function shaderHelper(plan, ctx, loader, signal) {
  const target = ctx.target && ctx.target.mcVersion === plan.mcVersion ? ctx.target : null;
  if (plan.shaderLoader === 'optifine' || loader === 'optifine' || (target && (target.hasIris || target.loader === 'optifine'))) return { status: 'present' };
  const ml = target ? modLoaderOf(target.loader) : L.MOD_LOADERS.includes(loader) ? loader : null;
  if (!ml) return { status: 'needsLoader' };
  for (const id of L.SHADER_HELPERS[ml] || []) {
    const list = await client.versions(id, { loaders: modLoaders(ml, plan.mcVersion), gameVersions: plan.mcVersion ? [plan.mcVersion] : undefined }, signal).catch((err) => {
      if (signal?.aborted) throw err;
      return [];
    });
    if (!list.length) continue;
    const [p] = await client.projects([id], signal).catch((err) => {
      if (signal?.aborted) throw err;
      return [];
    });
    if (!p) continue;
    const c = { item: fromProject(p, 'mod'), compat: 'verified', versionRaw: pickBest(list), score: 1, matched: [], catHits: [], helper: 'shaders' };
    return { status: 'added', cand: c };
  }
  return { status: 'unavailable', loader: ml };
}

// ---------- Sugerencia de version ----------

async function suggestVersion(plan, ctx, type, signal) {
  const spec = plan.searches.find((s) => s.type === type && !s.baseline) || plan.searches.find((s) => s.type === type);
  if (!spec) return null;
  try {
    const res = await client.search({ query: spec.query, facets: facetsFor(spec, plan, ctx, { withVersion: false }), limit: 25 }, signal);
    const tally = new Map();
    for (const hit of res.hits || []) {
      for (const v of new Set(hit.versions || [])) if (!ctx.releases?.size || ctx.releases.has(v)) tally.set(v, (tally.get(v) || 0) + 1);
    }
    const best = [...tally.entries()].sort((a, b) => b[1] - a[1] || compareNumeric(b[0], a[0]))[0];
    if (best && best[0] !== plan.mcVersion && best[1] >= 5) return { version: best[0], count: best[1], type };
  } catch (err) {
    if (signal?.aborted) throw err;
  }
  return null;
}

// ---------- Salida ----------

function publicItem(c, plan) {
  const it = c.item;
  const cats = it.displayCategories.filter((x) => !KNOWN_LOADERS.has(x) && !RESOLUTIONS.has(x) && !SHADER_PERF.has(x));
  const why = [...new Set([...c.catHits.filter((x) => !RESOLUTIONS.has(x) && !SHADER_PERF.has(x) && !KNOWN_LOADERS.has(x)), ...cats])].slice(0, 3);
  let sideNote = null;
  if (it.type === 'mod') {
    if (plan.mode === 'server' && it.serverSide === 'unsupported') sideNote = 'clientOnly';
    else if (plan.mode === 'multiplayer' && it.serverSide === 'required') sideNote = 'bothSides';
    else if (plan.mode === 'multiplayer' && it.clientSide === 'unsupported') sideNote = 'serverOnly';
  }
  return {
    id: it.id,
    slug: it.slug,
    type: it.type,
    title: it.title,
    author: it.author,
    description: it.description.slice(0, 300),
    icon: it.icon,
    downloads: it.downloads,
    follows: it.follows,
    updated: it.updated,
    categories: cats.slice(0, 6),
    loaders: it.categories.filter((x) => L.MOD_LOADERS.includes(x)),
    resolution: it.categories.find((x) => RESOLUTIONS.has(x)) || null,
    performance: it.type === 'shader' ? it.categories.filter((x) => SHADER_PERF.has(x)) : [],
    gameVersions: it.gameVersions.slice(-3),
    clientSide: it.clientSide,
    serverSide: it.serverSide,
    latestVersion: it.latestVersion,
    score: Math.round(c.score * 100) / 100,
    compat: c.compat || 'unknown',
    version: shortVersion(c.versionRaw),
    matched: c.matched,
    why,
    deps: [],
    conflicts: [],
    installed: false,
    helper: c.helper || null,
    sideNote,
    selected: true,
    reason: null,
    fit: null,
  };
}

function publicPlan(plan, effLoader) {
  const { boost: _b, keywords: _k, avoid: _a, ...rest } = plan;
  return {
    ...rest,
    resolvedLoader: effLoader,
    searches: plan.searches.map((s) => ({ type: s.type, query: s.query, categories: s.categories, source: s.source || 'local', baseline: Boolean(s.baseline) })),
  };
}

/**
 * Ejecuta el plan. ctx: { target, server, releases, latestRelease }
 * progress(stage, data) informa el avance: 'search' | 'verify' | 'rank'.
 */
async function run(plan, ctx = {}, { signal, progress = () => {} } = {}) {
  const started = Date.now();
  const reqBefore = client.requestCount();
  const warnings = [];
  const types = plan.types;
  const specs = plan.searches.filter((s) => types.includes(s.type));
  // Frase exacta y palabras excluidas no las filtra la API: se descartan aca los resultados que no las cumplen
  // y se piden mas candidatos para que no queden grupos cortos.
  const more = searchFilters.normalize(ctx.filters);
  const accept = searchFilters.needsClient(more, 'modrinth') ? searchFilters.matcher(more, { source: 'modrinth' }) : null;
  // La frase tambien se busca por su cuenta en cada tipo: asi no depende de que el interprete la nombre
  if (more.phrase) for (const type of new Set(specs.map((s) => s.type))) specs.push({ type, query: more.phrase, categories: [], weight: 1.2, source: 'filter' });

  // 1) Busquedas
  let done = 0;
  progress('search', { done, total: specs.length });
  const results = await mapLimit(specs, 4, async (spec) => {
    try {
      const res = await client.search({ query: spec.query, facets: facetsFor(spec, plan, ctx), limit: accept ? 60 : spec.query ? 20 : 15 }, signal);
      return { spec, hits: res.hits || [] };
    } catch (err) {
      if (signal?.aborted) throw err;
      return { spec, hits: [], error: err };
    } finally {
      progress('search', { done: ++done, total: specs.length });
    }
  });
  const failed = results.filter((r) => r.error);
  if (specs.length && failed.length === specs.length) throw new Error(t('smartsearch.errModrinth', { error: failed[0].error.message }));

  // 2) Unir resultados por tipo
  const byType = new Map(types.map((tp) => [tp, new Map()]));
  const themedTypes = new Set(specs.filter((s) => !s.baseline).map((s) => s.type));
  for (const { spec, hits } of results) {
    const map = byType.get(spec.type);
    hits.forEach((hit, rank) => {
      if (accept && !accept(hit)) return;
      let c = map.get(hit.project_id);
      if (!c) {
        c = { item: fromHit(hit, spec.type), searchScore: 0, themed: false, typeHasThemes: themedTypes.has(spec.type), compat: plan.mcVersion ? 'likely' : 'unknown' };
        map.set(hit.project_id, c);
      }
      c.searchScore += spec.weight / (1 + rank * 0.22);
      if (!spec.baseline && !spec.related) c.themed = true;
    });
  }

  // Un mismo proyecto puede aparecer como mod y como data pack: queda donde mejor encaja.
  const owner = new Map();
  const modsFirst = types.includes('mod') && plan.loader !== 'vanilla';
  for (const [type, map] of byType) {
    for (const [id, c] of map) {
      const prev = owner.get(id);
      let better = !prev || c.searchScore > prev.c.searchScore;
      if (prev && modsFirst && (type === 'mod' || prev.type === 'mod')) better = type === 'mod';
      if (better) owner.set(id, { type, c });
    }
  }
  for (const [type, map] of byType) for (const id of [...map.keys()]) if (owner.get(id)?.type !== type) map.delete(id);

  // 3) Puntaje preliminar
  const groupsC = new Map();
  for (const [type, map] of byType) {
    let cands = [...map.values()];
    if (cands.length) scoreGroup(cands, plan);
    // En mods, data packs, plugins y modpacks solo cuentan los que tienen que ver con el pedido
    // (los "populares" de base quedan para cuando no hay tema).
    if (themedTypes.has(type) && CONTENT_TYPES.has(type)) {
      const themed = cands.filter((c) => c.themed);
      if (themed.length) cands = themed;
      const strong = cands.filter((c) => !c.weak);
      if (strong.length >= Math.min(3, plan.perType[type] || 5)) cands = strong;
    }
    groupsC.set(type, cands);
  }

  // 4) Loader recomendado (si no se eligio) segun los mods encontrados
  const effLoader = types.includes('mod') ? resolveLoader(plan, groupsC.get('mod') || []) : plan.loader && plan.loader !== 'vanilla' ? plan.loader : null;

  // 5) Verificacion de compatibilidad real de los mejores candidatos
  const verifyJobs = [];
  for (const type of types) {
    const want = plan.perType[type] || 5;
    const cands = groupsC.get(type) || [];
    const gv = versionFor(type, plan);
    const loaders = verifyLoaders(type, plan, ctx, effLoader);
    verifyJobs.push({ type, want, cands, gv, loaders, next: 0 });
  }
  let vDone = 0;
  let vTotal = verifyJobs.reduce((a, j) => a + Math.min(j.cands.length, j.want + 2), 0);
  progress('verify', { done: 0, total: vTotal });
  for (let round = 0; round < 3; round++) {
    const batch = [];
    for (const j of verifyJobs) {
      const ok = j.cands.slice(0, j.next).filter((c) => c.compat !== 'incompatible').length;
      const missing = round === 0 ? j.want + 2 : plan.compatibleOnly ? j.want - ok : 0;
      if (missing <= 0 || j.next >= j.cands.length) continue;
      const take = j.cands.slice(j.next, j.next + (round === 0 ? missing : missing + 2));
      j.next += take.length;
      for (const c of take) batch.push({ c, j });
    }
    if (!batch.length) break;
    if (round > 0) {
      vTotal += batch.length;
      progress('verify', { done: vDone, total: vTotal });
    }
    await mapLimit(batch, 4, async ({ c, j }) => {
      await verify(c, j.loaders, j.gv, signal);
      progress('verify', { done: ++vDone, total: vTotal });
    });
  }
  progress('rank', {});

  // 6) Puntaje final y seleccion
  const picks = new Map();
  for (const j of verifyJobs) {
    const cands = j.cands;
    if (cands.length) scoreGroup(cands, plan);
    let pool = cands.filter((c) => c.checked);
    if (plan.compatibleOnly) pool = pool.filter((c) => c.compat !== 'incompatible');
    picks.set(j.type, pool.slice(0, j.want));
  }

  const kitHasMods = (picks.get('mod') || []).length > 0;
  const kitHasShaders = (picks.get('shader') || []).length > 0;
  const recommendedLoader = recommendLoader(plan, effLoader, kitHasMods, kitHasShaders);

  // 7) Iris/Oculus para los shaders
  let helperStatus = null;
  if (kitHasShaders) {
    helperStatus = await shaderHelper(plan, ctx, kitHasMods ? effLoader : recommendedLoader, signal);
    if (helperStatus.status === 'added') {
      const already = (picks.get('mod') || []).some((c) => c.item.id === helperStatus.cand.item.id);
      if (!already) picks.get('shader').unshift(helperStatus.cand);
    }
  }

  // 8) Salida publica + dependencias, conflictos e instalados
  const groups = [];
  for (const type of types) {
    const want = plan.perType[type] || 5;
    const items = (picks.get(type) || []).map((c) => {
      const pub = publicItem(c, plan);
      pub._deps = c.versionRaw?.dependencies || [];
      pub._score = c.score;
      return pub;
    });
    const found = (groupsC.get(type) || []).length;
    let note = null;
    const real = items.filter((i) => !i.helper).length;
    if (!real) note = { key: found ? 'noCompatible' : 'noResults' };
    else if (real < Math.min(want, 3)) note = { key: 'fewResults', vars: { count: real } };
    groups.push({ type, items, found, note });
  }
  const all = groups.flatMap((g) => g.items);
  const ids = new Set(all.map((i) => i.id));
  const installed = ctx.target?.installed || {};
  const depIds = new Set();
  for (const it of all) for (const d of it._deps) if (d.dependency_type === 'required' && d.project_id && !ids.has(d.project_id)) depIds.add(d.project_id);
  let depTitles = {};
  if (depIds.size) {
    try {
      const list = await client.projects([...depIds].slice(0, 80), signal);
      depTitles = Object.fromEntries(list.map((p) => [p.id, p.title]));
    } catch (err) {
      if (signal?.aborted) throw err;
    }
  }
  const conflictPairs = new Set();
  for (const it of all) {
    it.installed = Boolean(installed[it.id]) && ctx.target?.mcVersion === plan.mcVersion;
    for (const d of it._deps) {
      if (d.dependency_type === 'required' && d.project_id && depTitles[d.project_id] && !it.deps.some((x) => x.id === d.project_id)) it.deps.push({ id: d.project_id, title: depTitles[d.project_id] });
      if (d.dependency_type !== 'incompatible' || !d.project_id) continue;
      const other = all.find((o) => o.id === d.project_id);
      if (other) {
        const key = [it.id, other.id].sort().join('|');
        if (conflictPairs.has(key)) continue;
        conflictPairs.add(key);
        const [win, lose] = it._score >= other._score ? [it, other] : [other, it];
        lose.conflicts.push({ id: win.id, title: win.title, installed: false });
        lose.selected = false;
        warnings.push({ key: 'conflict', vars: { a: win.title, b: lose.title } });
      } else if (installed[d.project_id]) {
        it.conflicts.push({ id: d.project_id, title: installed[d.project_id].title || d.project_id, installed: true });
        it.selected = false;
        warnings.push({ key: 'conflictInstalled', vars: { a: it.title, b: installed[d.project_id].title || d.project_id } });
      }
    }
    // Conflictos declarados por mods ya instalados (en sentido inverso no se puede saber sin descargar sus datos)
    if (it.compat === 'incompatible' || it.installed || it.type === 'modpack') it.selected = false;
  }
  for (const it of all) {
    delete it._deps;
    delete it._score;
  }

  // 9) Avisos del kit
  const target = ctx.target || null;
  const groupOf = (tp) => groups.find((g) => g.type === tp && g.items.length);
  if (target) {
    if (target.mcVersion !== plan.mcVersion && plan.mcVersion) warnings.unshift({ key: 'versionMismatch', vars: { name: target.name, instVersion: target.mcVersion, version: plan.mcVersion } });
    else if (groupOf('mod') && !modLoaderOf(target.loader)) warnings.unshift({ key: 'modsNeedLoader', vars: { name: target.name } });
    else if (groupOf('mod') && ['filter', 'query'].includes(plan.loaderSource) && plan.loader && modLoaderOf(target.loader) && modLoaderOf(target.loader) !== plan.loader) {
      warnings.unshift({ key: 'loaderMismatch', vars: { name: target.name, instLoader: target.loader, loader: plan.loader } });
    }
  }
  if (helperStatus?.status === 'added') warnings.push({ key: 'shadersHelper', vars: { helper: helperStatus.cand.item.title } });
  else if (helperStatus?.status === 'needsLoader') warnings.push({ key: target && target.mcVersion === plan.mcVersion ? 'shadersNeedLoader' : 'shadersOptifine' });
  else if (helperStatus?.status === 'unavailable') warnings.push({ key: 'shadersNoHelper', vars: { loader: helperStatus.loader, version: plan.mcVersion } });
  else if (helperStatus?.status === 'present' && recommendedLoader === 'optifine' && !(target && target.mcVersion === plan.mcVersion)) warnings.push({ key: 'shadersOptifine' });
  if (groupOf('datapack')) warnings.push({ key: 'datapacksNeedWorld' });
  if (groupOf('plugin')) warnings.push({ key: 'pluginsNeedServer' });
  if (groupOf('modpack')) warnings.push({ key: 'modpacksNewInstance' });
  const both = (groupOf('mod')?.items || []).filter((i) => i.sideNote === 'bothSides').length;
  if (both) warnings.push({ key: 'serverSideMods', vars: { count: both } });
  if (!plan.mcVersion) warnings.push({ key: 'noVersion' });
  if (plan.badVersion) warnings.push({ key: 'badVersion', vars: { version: plan.badVersion } });

  // 10) Sugerencia de version si hay pocos resultados para la elegida automaticamente
  let versionSuggestion = null;
  if (['latest', 'instance', 'none'].includes(plan.versionSource)) {
    const weak = groups.find((g) => CONTENT_TYPES.has(g.type) && g.type !== 'modpack' && g.items.filter((i) => !i.helper).length < Math.ceil((plan.perType[g.type] || 5) / 2));
    if (weak) versionSuggestion = await suggestVersion(plan, ctx, weak.type, signal);
  }

  const kitTypes = groups.filter((g) => g.items.length && !['modpack', 'plugin'].includes(g.type)).map((g) => g.type);
  return {
    query: plan.query,
    plan: publicPlan(plan, effLoader),
    groups,
    warnings,
    target: target ? { kind: 'instance', id: target.id, name: target.name, mcVersion: target.mcVersion, loader: target.loader, preset: target.preset || null } : null,
    recommended: {
      mcVersion: plan.mcVersion,
      loader: recommendedLoader,
      preset: recommendedLoader === 'fabric' && kitHasShaders ? 'iris' : null,
      types: kitTypes,
    },
    versionSuggestion,
    stats: { requests: client.requestCount() - reqBefore, ms: Date.now() - started },
  };
}

module.exports = { run, modLoaders, serverLoaders, facetsFor, resolveLoader, recommendLoader, fromHit, fromProject, pickBest };
