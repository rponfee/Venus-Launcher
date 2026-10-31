'use strict';
// IA opcional del Buscador inteligente: mejora el plan del interprete local y escribe el
// "por que" de cada resultado. Si falla, se usa el plan local tal cual.
const L = require('./lexicon');
const interpreter = require('./interpreter');

const LOADERS = ['', 'fabric', 'forge', 'neoforge', 'quilt', 'vanilla'];
const LANG_NAMES = {
  es: "Spanish from Argentina (rioplatense, using voseo: 'Agrega', 'Mejorá', 'Sumá')",
  en: 'English',
  pt: 'Brazilian Portuguese',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  nl: 'Dutch',
  pl: 'Polish',
  ru: 'Russian',
  uk: 'Ukrainian',
  tr: 'Turkish',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Simplified Chinese',
};

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['types', 'mcVersion', 'loader', 'mode', 'themes', 'hardware', 'searches', 'summary'],
  properties: {
    types: { type: 'array', items: { type: 'string', enum: L.TYPES } },
    mcVersion: { type: 'string' },
    loader: { type: 'string', enum: LOADERS },
    mode: { type: 'string', enum: ['any', 'singleplayer', 'multiplayer', 'server'] },
    themes: { type: 'array', items: { type: 'string' } },
    hardware: { type: 'string', enum: ['normal', 'low-end', 'high-end'] },
    searches: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'query', 'categories', 'weight'],
        properties: {
          type: { type: 'string', enum: L.TYPES },
          query: { type: 'string' },
          categories: { type: 'array', items: { type: 'string' } },
          weight: { type: 'number' },
        },
      },
    },
    summary: { type: 'string' },
  },
};

const REASONS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'reason', 'fit'],
        properties: {
          id: { type: 'string' },
          reason: { type: 'string' },
          fit: { type: 'string', enum: ['great', 'good', 'weak'] },
        },
      },
    },
  },
};

function aiModule() {
  return require('../ai');
}

function langName(code) {
  return LANG_NAMES[code] || LANG_NAMES.en;
}

function planSystem(uiLang) {
  const cats = Object.entries(L.CATEGORIES)
    .map(([type, list]) => `- ${type}: ${list.join(', ')}`)
    .join('\n');
  return [
    'You plan searches on Modrinth (the Minecraft mod platform) for a Minecraft: Java Edition launcher.',
    'The user describes, usually in Spanish, English or Portuguese, what they want to play. Return a search plan as JSON.',
    '',
    'Rules:',
    '- types: content types to include (mod, modpack, resourcepack, shader, datapack, plugin). Keep the types the user names. If they add "and more"/"y demás", add the types that fit the theme. If they name none, choose what makes a good kit: usually mods + resource packs + shaders; data packs when they fit; plugins only for servers; modpacks when they ask for a ready-made pack or the request is very broad.',
    '- mcVersion: only when the user names a Minecraft version (e.g. "1.20.1", "1.8.9", "26.1"), otherwise "".',
    '- loader: only when named or clearly implied ("sin mods"/"no mods" means vanilla), otherwise "".',
    '- mode: singleplayer, multiplayer (playing with others), server (hosting/administering a server) or any.',
    '- themes: 1 to 4 short English theme words (e.g. "zombie apocalypse", "medieval", "redstone").',
    '- hardware: "low-end" if they mention a weak PC or wanting more FPS, "high-end" if they mention a powerful PC, else "normal".',
    '- searches: 4 to 12 Modrinth searches across the chosen types. query = 1 to 3 English keywords that would appear in project titles or descriptions (Modrinth content is in English), or a well-known project name you are confident fits (e.g. "sodium" for FPS, "carpet" for technical survival). categories = optional Modrinth categories valid for that type, combined with OR (use [] when unsure). weight = importance between 0.3 and 1.5. Never invent categories.',
    `- summary: one short sentence in ${langName(uiLang)} describing the kit you are putting together. No markdown.`,
    '',
    'Valid categories per type:',
    cats,
  ].join('\n');
}

function planPrompt(plan, ctx) {
  const fixed = {
    version: ['filter', 'query'].includes(plan.versionSource) ? plan.mcVersion : null,
    loader: ['filter', 'query'].includes(plan.loaderSource) ? plan.loader : null,
    types: plan.typesSource === 'filter' ? plan.types : null,
  };
  const context = {
    latestRelease: ctx.latestRelease || null,
    targetInstance: ctx.target ? { version: ctx.target.mcVersion, loader: ctx.target.loader } : null,
    fixedByUser: fixed,
    localInterpretation: {
      types: plan.types,
      themes: plan.themes.map((th) => th.id),
      mode: plan.mode,
      version: plan.mcVersion,
    },
  };
  return `User request: """${plan.query}"""\n\nContext (JSON): ${JSON.stringify(context)}`;
}

function validVersion(v, releases) {
  if (!v || typeof v !== 'string') return null;
  const s = v.trim();
  if (!/^(1\.\d{1,2}(\.\d{1,2})?|2\d\.\d{1,2}(\.\d{1,2})?)$/.test(s)) return null;
  if (releases?.size && !releases.has(s)) return null;
  return s;
}

function cleanQuery(q) {
  return String(q || '')
    .replace(/[^\p{L}\p{N}\s+'.-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

// Une el plan de la IA con el local. Lo que el usuario fijo (filtros o pedido explicito) manda.
function merge(plan, ai, ctx = {}) {
  const out = { ...plan, source: 'ai', flags: { ...plan.flags } };
  const aiTypes = (ai.types || []).filter((tp) => L.TYPES.includes(tp));
  if (plan.typesSource === 'filter') {
    /* lo eligio el usuario */
  } else if (plan.typesSource === 'query') {
    if (plan.more) out.types = interpreter.canonicalTypes([...new Set([...plan.types, ...aiTypes])]).filter((tp) => !plan.excluded.includes(tp));
  } else if (aiTypes.length) {
    out.types = interpreter.canonicalTypes(aiTypes).filter((tp) => !plan.excluded.includes(tp));
    out.typesSource = 'ai';
  }
  if (!out.types.length) out.types = plan.types;

  if (!['filter', 'query'].includes(plan.versionSource)) {
    const v = validVersion(ai.mcVersion, ctx.releases);
    if (v) {
      out.mcVersion = v;
      out.versionSource = 'query';
    }
  }
  if (plan.loaderSource === 'auto' && LOADERS.includes(ai.loader) && ai.loader) {
    out.loader = ai.loader;
    out.loaderSource = 'query';
  }
  if (plan.modeSource === 'default' && ['singleplayer', 'multiplayer', 'server'].includes(ai.mode)) {
    out.mode = ai.mode;
    out.modeSource = 'ai';
  }
  if (ai.hardware === 'low-end') out.flags.lowEnd = true;
  if (ai.hardware === 'high-end') out.flags.highEnd = true;
  out.aiThemes = (ai.themes || []).map((x) => cleanQuery(x)).filter(Boolean).slice(0, 4);
  out.summary = String(ai.summary || '').trim().slice(0, 280);

  // Si cambian los tipos o el loader, se recalculan las cantidades y busquedas locales.
  const base = plan.perType[plan.types[0]] || 5;
  out.perType = {};
  for (const tp of out.types) out.perType[tp] = plan.perType[tp] || base;
  if (out.loader === 'vanilla' && plan.loaderSource !== 'filter' && !plan.types.includes('mod')) out.types = out.types.filter((tp) => tp !== 'mod');

  const aiSearches = [];
  for (const s of ai.searches || []) {
    if (!out.types.includes(s.type)) continue;
    const query = cleanQuery(s.query);
    const valid = new Set(L.CATEGORIES[s.type] || []);
    const categories = [...new Set((s.categories || []).filter((c) => valid.has(c)))].slice(0, 4);
    if (!query && !categories.length) continue;
    const weight = Math.max(0.3, Math.min(1.5, Number(s.weight) || 1));
    aiSearches.push({ type: s.type, query, categories, weight: weight * 1.05, source: 'ai' });
  }
  const local = interpreter.localSearches(out);
  const searches = [];
  for (const type of out.types) {
    const mine = aiSearches.filter((s) => s.type === type).sort((a, b) => b.weight - a.weight).slice(0, 3);
    const theirs = local.filter((s) => s.type === type && !s.baseline).slice(0, mine.length ? 2 : 3);
    searches.push(...interpreter.capSearches([...mine, ...theirs], type, mine.length ? 5 : interpreter.MAX_SEARCHES_PER_TYPE));
  }
  out.searches = searches;
  out.boost = interpreter.boostFor(out);
  out.keywords = interpreter.keywordsFor(out);
  out.avoid = interpreter.avoidFor(out);
  return out;
}

// Pide el plan a la IA y lo une al local. Lanza un error si la IA falla (el llamador decide).
async function improve(plan, ctx = {}, { signal, turnId } = {}) {
  const ai = aiModule();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), 45000);
  const onAbort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await ai.json({ system: planSystem(ctx.uiLang), prompt: planPrompt(plan, ctx), schema: PLAN_SCHEMA, model: 'haiku', effort: 'low', maxTokens: 4000, signal: controller.signal, turnId });
    return merge(plan, res || {}, ctx);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

// Escribe un motivo corto por resultado. Devuelve { [projectId]: { reason, fit } }.
async function reasons(query, groups, uiLang, { signal, turnId } = {}) {
  const ai = aiModule();
  const items = groups.flatMap((g) => g.items.filter((i) => !i.helper).map((i) => ({ id: i.id, type: i.type, title: i.title, categories: i.categories.slice(0, 4), description: i.description.slice(0, 180) })));
  if (!items.length) return {};
  const system = [
    'You explain search results of a Minecraft launcher.',
    `For each Minecraft project, write one concrete reason (maximum 10 words) in ${langName(uiLang)} saying what it adds that fits the user's request, like "Agrega zombis más inteligentes que rompen bloques".`,
    'Base it only on the given title, categories and description. No markdown, no project name at the start, no trailing period.',
    'Rate fit with the request: great, good or weak. Return every id exactly as given.',
  ].join('\n');
  const prompt = `User request: """${query}"""\n\nProjects (JSON):\n${JSON.stringify(items)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), 60000);
  const onAbort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await ai.json({ system, prompt, schema: REASONS_SCHEMA, model: 'haiku', effort: 'low', maxTokens: 6000, signal: controller.signal, turnId });
    const valid = new Set(items.map((i) => i.id));
    const out = {};
    for (const r of res?.items || []) {
      if (!valid.has(r.id)) continue;
      const reason = String(r.reason || '').replace(/\s+/g, ' ').trim().replace(/\.$/, '').slice(0, 120);
      if (reason) out[r.id] = { reason, fit: ['great', 'good', 'weak'].includes(r.fit) ? r.fit : 'good' };
    }
    return out;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

module.exports = { improve, merge, reasons, PLAN_SCHEMA, REASONS_SCHEMA };
