'use strict';
// Traduccion de mensajes (3.3): el canal que usa Mensajes para traducir una tanda con la IA del plan del usuario. Arma el
// pedido aca, no en la interfaz: asi este canal solo sirve para traducir, no para mandarle cualquier cosa a la IA.
//   socialplus:translate({ items: [{ id, text }], lang }) -> { items: [{ id, text, same } | { id, failed: true }] }
// Errores con err.code: los de modules/ai.js (unavailable, session, noplan, plan, quota, ratelimit, network...) y bad_request.
// Solo para capturas, sin empaquetar: VENUS_DEVSHOT + VENUS_SOCIALPLUS_FAKE=1|noplan|quota (no habla con ningun servidor).
const { translate, createTurns, checkRequest } = require('./socialplus/translate');

function fakeTranslate(payload, mode) {
  if (mode === 'noplan' || mode === 'quota') {
    const err = new Error(mode);
    err.code = mode;
    throw err;
  }
  const { items, lang } = checkRequest(payload);
  return { items: items.map((it) => ({ id: it.id, text: `[${lang}] ${it.text}`, same: false })) };
}

function register({ app, handle }) {
  const turns = createTurns();
  const fake = !app?.isPackaged && process.env.VENUS_DEVSHOT ? process.env.VENUS_SOCIALPLUS_FAKE : null;
  handle('socialplus:translate', (payload) => {
    if (fake) return fakeTranslate(payload, fake);
    return translate(payload, { ai: require('./ai'), turns });
  });
}

module.exports = { register };
