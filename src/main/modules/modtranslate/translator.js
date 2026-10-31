'use strict';
// Traduccion con IA por tandas (~120 textos). Cada resultado se valida (no vacio y con los mismos
// marcadores %s, §a, {0}, <b>, \n...); los que vuelven mal se reintentan una vez indicando que hay que
// conservar, y si siguen mal se deja el texto original (en ingles) para corregirlo a mano.
// La IA se recibe por parametro (ai.json de modules/ai.js) para poder probarlo sin conexion.
const { t } = require('../../core/i18n');
const { validate, keepList } = require('./placeholders');

const BATCH_ITEMS = 120;
const BATCH_CHARS = 9000;
const RETRY_ITEMS = 30;
const CONCURRENCY = 2;
const MAX_TOKENS = 16000;
const PROMPT_OVERHEAD = 700; // tokens de instrucciones por tanda (aprox.)

const SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: { key: { type: 'string' }, text: { type: 'string' } },
        required: ['key', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

function systemPrompt(loc) {
  const lines = [
    `You translate the user interface text of Minecraft: Java Edition mods (item and block names, tooltips, menus, configuration screens, chat messages and guide books) from English into ${loc.ai}.`,
    'Rules:',
    '- Return exactly one result for every input item, with the same "key" and the translation in "text". Never skip, merge, split or add items.',
    '- Copy every placeholder and formatting code exactly, the same number of times: printf placeholders (%s, %d, %.1f, %1$s, %%), section-sign codes (§a, §l, §r...), braces ({0}, {name}), tags (<b>, </b>, <br>), $(...) book macros, &-codes (&a) and line breaks (\\n). You may move a placeholder to where the grammar needs it, but keep un-numbered %s/%d placeholders in the same relative order.',
    `- Use the terminology of the official Minecraft ${loc.ai} translation for vanilla items, blocks, mobs, biomes, effects, enchantments and controls.`,
    '- Keep proper nouns, mod names, brand names, units, commands, technical identifiers and file names unchanged.',
    `- Keep labels short, like a game interface. Follow the capitalization style Minecraft uses in ${loc.ai} (for example, item names are not Title Case in Romance languages).`,
    '- The key is only context (it tells whether the text is an item, a tooltip, a config option...). Never translate or modify keys.',
    `- If a text is already in ${loc.ai}, or must not be translated (a name, a number, a symbol), return it unchanged.`,
    '- Do not add quotes, notes or explanations.',
  ];
  if (loc.note) lines.push(`- ${loc.note}`);
  return lines.join('\n');
}

function userPrompt(loc, items, retry) {
  const groups = [];
  const byMod = new Map();
  for (const it of items) {
    const label = it.mod || it.ns;
    let g = byMod.get(label);
    if (!g) {
      g = { mod: label, items: [] };
      byMod.set(label, g);
      groups.push(g);
    }
    const row = { key: it.key, text: it.source };
    if (retry) {
      const keep = keepList(it.source);
      if (keep.length) row.keep = keep;
    }
    g.items.push(row);
  }
  const head = retry
    ? `Translate the "text" of every item into ${loc.ai}. These items were returned with missing or changed placeholders before: each "keep" list shows the tokens that must appear in the translation exactly as written, the same number of times.`
    : `Translate the "text" of every item into ${loc.ai}.`;
  return `${head}\nAnswer with JSON: {"items":[{"key":"<same key>","text":"<translation>"}]} with one entry per input item.\n\n${JSON.stringify(groups)}`;
}

// ---------- Errores de la IA ----------

function templateRegex(key) {
  const sample = t(key, { status: '\u0001', detail: '\u0002', plan: '\u0003' });
  const esc = sample.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${esc.replace('\u0001', '(\\d+|\\?)').replace('\u0002', '[\\s\\S]*').replace('\u0003', '[\\s\\S]*')}$`);
}

function classify(err, signal) {
  if (signal?.aborted || err?.name === 'AbortError') return 'abort';
  const msg = String(err?.message || err || '');
  if ([t('ai.errTooLong'), t('ai.errParse'), t('ai.errRefused')].includes(msg)) return 'split';
  if (err?.code === 'ratelimit' || err?.code === 'network' || [t('ai.errBusy'), t('ai.errNetwork')].includes(msg)) return 'retry';
  const api = templateRegex('ai.errApi').exec(msg);
  if (api) {
    const status = Number(api[1]);
    if (!Number.isFinite(status) || status >= 500 || status === 429 || status === 408 || status === 409) return 'retry';
  }
  return 'fatal';
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error('aborted'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// Respeta los espacios del principio y del final del original ("Velocidad: ").
function normalize(source, text) {
  const lead = /^\s*/.exec(source)[0];
  const trail = /\s*$/.exec(source)[0];
  return `${lead}${String(text).trim()}${trail}`;
}

// ---------- Tandas ----------

function makeBatches(items, maxItems, maxChars) {
  const batches = [];
  let cur = null;
  for (const it of items) {
    const size = it.key.length + it.source.length;
    if (!cur || cur.items.length >= maxItems || (cur.items.length && cur.chars + size > maxChars) || cur.keys.has(it.key)) {
      cur = { items: [], chars: 0, keys: new Set() };
      batches.push(cur);
    }
    cur.items.push(it);
    cur.chars += size;
    cur.keys.add(it.key);
  }
  return batches.map((b) => b.items);
}

async function pool(list, n, fn, signal) {
  let next = 0;
  let failure = null;
  const worker = async () => {
    while (next < list.length && !failure) {
      if (signal?.aborted) {
        failure = failure || signal.reason || new Error('aborted');
        return;
      }
      const item = list[next++];
      try {
        await fn(item);
      } catch (err) {
        failure = failure || err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, worker));
  if (failure) throw failure;
}

async function translateBatch(items, ctx, attempt = 0) {
  const { ai, loc, signal, turnId, retry } = ctx;
  try {
    const res = await ai.json({ system: ctx.system, prompt: userPrompt(loc, items, retry), schema: SCHEMA, maxTokens: MAX_TOKENS, model: 'haiku', effort: 'low', signal, turnId });
    const got = new Map();
    for (const r of Array.isArray(res?.items) ? res.items : []) {
      if (!r || typeof r.key !== 'string' || typeof r.text !== 'string') continue;
      const k = r.key.trim();
      if (!got.has(k)) got.set(k, r.text);
    }
    const ok = [];
    const bad = [];
    for (const it of items) {
      const text = got.has(it.key) ? got.get(it.key) : got.get(it.key.trim());
      const v = validate(it.source, text);
      if (v.ok) ok.push({ item: it, text: normalize(it.source, text) });
      else bad.push({ item: it, reason: text === undefined ? 'missing' : v.reason });
    }
    return { ok, bad };
  } catch (err) {
    const kind = classify(err, signal);
    if (kind === 'abort') throw signal?.reason || err;
    if (kind === 'retry' && attempt < 3) {
      await sleep([3000, 9000, 20000][attempt], signal);
      return translateBatch(items, ctx, attempt + 1);
    }
    if (kind === 'split' && items.length > 4) {
      const mid = Math.ceil(items.length / 2);
      const a = await translateBatch(items.slice(0, mid), ctx);
      const b = await translateBatch(items.slice(mid), ctx);
      return { ok: [...a.ok, ...b.ok], bad: [...a.bad, ...b.bad] };
    }
    if (kind === 'split') return { ok: [], bad: items.map((item) => ({ item, reason: 'refused' })) };
    throw err;
  }
}

/**
 * Traduce items [{ key, source, ns, mod }] y avisa cada tanda con onBatch({ ok: [{item, text}], failed: [item] }).
 * Opciones: { ai, loc (info del idioma), signal, turnId }.
 */
async function translateAll(items, { ai, loc, signal, turnId, onBatch }) {
  const ctx = { ai, loc, signal, turnId, system: systemPrompt(loc), retry: false };
  const again = [];
  await pool(
    makeBatches(items, BATCH_ITEMS, BATCH_CHARS),
    CONCURRENCY,
    async (batch) => {
      const { ok, bad } = await translateBatch(batch, ctx);
      again.push(...bad.map((b) => b.item));
      await onBatch({ ok, failed: [] });
    },
    signal,
  );
  if (!again.length) return;
  const retryCtx = { ...ctx, retry: true };
  await pool(
    makeBatches(again, RETRY_ITEMS, Math.floor(BATCH_CHARS / 2)),
    CONCURRENCY,
    async (batch) => {
      const { ok, bad } = await translateBatch(batch, retryCtx);
      await onBatch({ ok, failed: bad.map((b) => b.item) });
    },
    signal,
  );
}

// Factor de salida segun el idioma (los alfabetos no latinos usan mas tokens por letra).
function outputFactor(code) {
  if (/^(ja|ko|zh)/.test(code)) return 1.9;
  if (/^(ru|uk)/.test(code)) return 1.6;
  return 1.3;
}

// Tokens aproximados (entrada + salida) para traducir estos textos.
function estimateTokens(items, code) {
  if (!items.length) return 0;
  const f = outputFactor(code);
  let chars = 0;
  let keys = 0;
  for (const it of items) {
    chars += it.source.length;
    keys += it.key.length;
  }
  const batches = Math.ceil(items.length / BATCH_ITEMS);
  const input = (keys + chars) / 3.3 + items.length * 6 + batches * PROMPT_OVERHEAD;
  const output = (keys + chars * f) / 3.3 + items.length * 6;
  return Math.round(input + output);
}

module.exports = { translateAll, estimateTokens, makeBatches, classify, systemPrompt, userPrompt, normalize, SCHEMA, BATCH_ITEMS };
