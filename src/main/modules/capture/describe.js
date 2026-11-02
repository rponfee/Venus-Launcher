'use strict';
// Busqueda de capturas con IA: SOLO cuando el usuario lo pide (boton "Describir con IA" de la pagina de Clips, con
// confirmacion). Manda las capturas achicadas (JPEG de 448 px) a la IA de Venus (modules/ai.js, ai.json con bloques
// de imagen en `messages`, que el backend acepta) y guarda una descripcion corta de cada una en
// data/capture-ai.json. Despues la busqueda de la pagina compara contra esas descripciones sin volver a usar IA.
// Todas las llamadas de una accion usan el mismo turnId (6.7: cuenta como una sola consulta).
// Sin Electron arriba de todo: el achicado de imagenes llega como funcion (encode) para poder probarlo.
const paths = require('../../core/paths');
const { readJson, writeJson, uid } = require('../../core/util');

const FILE = () => paths.data('capture-ai.json');
const BATCH = 5; // capturas por llamada (el backend acepta pedidos de hasta 400 KB)
const MAX_PER_RUN = 20; // capturas por accion del usuario
const MAX_BATCH_BYTES = 320 * 1024; // base64 de las imagenes de una llamada
const MAX_TEXT = 300;

const SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: { index: { type: 'integer' }, description: { type: 'string' } },
        required: ['index', 'description'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

const LANGS = { es: 'español', en: 'English', pt: 'português', fr: 'français', de: 'Deutsch', it: 'italiano', nl: 'Nederlands', pl: 'polski', ru: 'русский', uk: 'українська', tr: 'Türkçe', ja: '日本語', ko: '한국어', zh: '中文' };

function systemPrompt(language) {
  const lang = LANGS[language] || LANGS.es;
  return [
    'Describís capturas de pantalla de Minecraft para que el jugador las encuentre buscando con palabras.',
    `Escribí en ${lang}. Para cada imagen, una sola línea de hasta 200 caracteres con lo que se ve: bioma o lugar, construcciones, mobs o jugadores, hora del día, clima y si hay menús o interfaz. Agregá al final 3 a 6 palabras clave separadas por comas.`,
    'No inventes nada que no se vea. No leas ni copies nombres de usuario, chats ni datos personales.',
  ].join('\n');
}

function cleanDescription(s) {
  return String(s ?? '')
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT);
}

function batches(list, n = BATCH) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

// Contenido del mensaje: cada imagen con su numero y al final el pedido
function buildContent(images) {
  const content = [];
  images.forEach((img, i) => {
    content.push({ type: 'text', text: `Imagen ${i + 1}:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img } });
  });
  content.push({ type: 'text', text: `Describí las ${images.length} imágenes. Devolvé items con index (1 a ${images.length}) y description.` });
  return content;
}

// ---------- Registro local ----------
let cache = null;
let chain = Promise.resolve();

async function load() {
  if (!cache) {
    const raw = await readJson(FILE(), null);
    cache = raw && raw.items && typeof raw.items === 'object' ? raw.items : {};
  }
  return cache;
}

// { clave: descripcion } (clave = sharedKey de worlds: instancia|ruta|tamanio)
async function index() {
  const all = await load();
  const out = {};
  for (const [k, v] of Object.entries(all)) if (v?.text) out[k] = v.text;
  return out;
}

function save(entries) {
  const run = chain.then(async () => {
    const all = await load();
    for (const [k, text] of entries) all[k] = { text, at: Date.now() };
    // Tope: las 5000 mas nuevas
    const keys = Object.keys(all);
    if (keys.length > 5000) keys.sort((a, b) => (all[a].at || 0) - (all[b].at || 0)).slice(0, keys.length - 5000).forEach((k) => delete all[k]);
    await writeJson(FILE(), { version: 1, items: all });
  });
  chain = run.catch(() => {});
  return run;
}

/**
 * Describe capturas. list = [{ key, path }] (ya validadas); deps = { ai, encode(path) -> base64 JPEG | null,
 * language }. Devuelve { described, skipped, error? } (error = el de la IA si corto antes de terminar, con su code).
 */
async function describe(list, { ai, encode, language = 'es' }) {
  const items = (Array.isArray(list) ? list : []).slice(0, MAX_PER_RUN);
  const turnId = uid(16);
  const system = systemPrompt(language);
  let described = 0;
  let skipped = 0;
  for (const group of batches(items)) {
    const ready = [];
    let bytes = 0;
    for (const it of group) {
      const img = await encode(it.path).catch(() => null);
      if (!img || bytes + img.length > MAX_BATCH_BYTES) {
        skipped++;
        continue;
      }
      bytes += img.length;
      ready.push({ ...it, img });
    }
    if (!ready.length) continue;
    let res;
    try {
      res = await ai.json({ system, messages: [{ role: 'user', content: buildContent(ready.map((r) => r.img)) }], schema: SCHEMA, model: 'haiku', effort: 'low', turnId });
    } catch (err) {
      return { described, skipped: items.length - described, error: err };
    }
    const found = [];
    for (const row of Array.isArray(res?.items) ? res.items : []) {
      const r = ready[Number(row?.index) - 1];
      const text = cleanDescription(row?.description);
      if (r && text) found.push([r.key, text]);
    }
    if (found.length) await save(found);
    described += found.length;
    skipped += ready.length - found.length;
  }
  return { described, skipped };
}

// Para pruebas: olvida lo cargado
function _reset() {
  cache = null;
}

module.exports = { index, describe, systemPrompt, buildContent, cleanDescription, batches, SCHEMA, MAX_PER_RUN, BATCH, _reset };
