'use strict';
// Creador de skins con IA: a partir de imagenes de referencia y una descripcion, la IA de Venus (plan de pago,
// igual que "Describir con IA" de Clips) arma una skin de 64x64 para el editor de skins. SOLO cuando el jugador
// toca "Generar": nada se manda antes. Las imagenes llegan ya achicadas y reencodeadas por la interfaz (sin
// metadatos), se validan aca y viajan en un unico pedido (cuenta como una sola consulta de la IA).
// La logica (prompt, validacion, conversion a pixeles) esta en skinai/ con pruebas en skinai/test/.
// Canales:
//   skinai:status() -> { available }
//   skinai:generate({ images: [dataURL], text, variant, outer, mode: 'create' | 'edit', current?: bytes RGBA 64x64,
//                     currentImage?: dataURL, hints?: ['#rrggbb'] }) -> { rgba: Uint8Array(16384), notes, filled }
//   skinai:cancel() -> boolean
// Errores: los de ai.js (sin sesion, sin plan, cuota...) con su code, o err.code 'skinai:<badImage|bigImage|badSkin|
// needText|needInput|bad|busy>' que la interfaz traduce.
const settings = require('../core/settings');
const { uid } = require('../core/util');
const logic = require('./skinai/logic');

let running = null; // { controller }

function aiModule() {
  try {
    return require('./ai');
  } catch {
    return null;
  }
}

function fail(code) {
  const err = new Error(code);
  err.code = `skinai:${code}`;
  return err;
}

async function status(deps = {}) {
  const ai = deps.ai || aiModule();
  try {
    return { available: Boolean(ai && (await ai.available())) };
  } catch {
    return { available: false };
  }
}

async function generate(raw, deps = {}) {
  const checked = logic.cleanRequest(raw);
  if (!checked.ok) throw fail(checked.code);
  const req = checked.req;
  if (running) throw fail('busy');
  const ai = deps.ai || aiModule();
  if (!ai || !(await ai.available().catch(() => false))) {
    const err = new Error('unavailable');
    err.code = 'unavailable';
    throw err;
  }
  const language = deps.language || (await settings.get()).language || 'es';
  const controller = new AbortController();
  running = { controller };
  try {
    const res = await ai.json({
      system: logic.systemPrompt({ language, variant: req.variant, outer: req.outer, edit: req.mode === 'edit' }),
      messages: [{ role: 'user', content: logic.buildContent(req) }],
      schema: logic.SCHEMA,
      model: 'haiku',
      effort: 'high',
      maxTokens: 30000,
      turnId: uid(16),
      signal: controller.signal,
    });
    const out = logic.decodeSkin(res, { variant: req.variant, outer: req.outer });
    return { rgba: new Uint8Array(out.px), notes: out.notes, filled: out.filled };
  } catch (err) {
    if (err?.name === 'AbortError' || controller.signal.aborted) throw fail('cancelled');
    throw err;
  } finally {
    running = null;
  }
}

function cancel() {
  if (!running) return false;
  running.controller.abort();
  return true;
}

function register({ handle }) {
  handle('skinai:status', () => status());
  handle('skinai:generate', (req) => generate(req));
  handle('skinai:cancel', () => cancel());
}

module.exports = { register, status, generate, cancel };
