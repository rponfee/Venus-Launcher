'use strict';
// Modo falso SOLO para capturas y pruebas de desarrollo del Buscador inteligente: simula el plan de la cuenta y las apps
// locales sin tocar ninguna cuenta ni servidor. Nunca se activa en la app empaquetada ni sin VENUS_DEVSHOT.
//   VENUS_SMARTSEARCH_AI_FAKE=paid        plan de pago, solo Venus IA
//   VENUS_SMARTSEARCH_AI_FAKE=both        plan de pago y Claude Code instalado: se elige una fuente
//   VENUS_SMARTSEARCH_AI_FAKE=basic       plan Basic con Claude Code instalado (la fuente local pide Go o superior)
//   VENUS_SMARTSEARCH_AI_FAKE=none        cuenta sin plan
//   VENUS_SMARTSEARCH_AI_FAKE=signedOut | unknown | disabled
// Las preferencias (interruptor, fuente y aviso aceptado) son las reales de la carpeta de datos de la prueba.

function mode() {
  const m = process.env.VENUS_SMARTSEARCH_AI_FAKE;
  if (!m || !process.env.VENUS_DEVSHOT) return null;
  try {
    if (require('electron').app?.isPackaged) return null;
  } catch {
    /* Node puro: no hay app empaquetada */
  }
  return ['paid', 'both', 'basic', 'none', 'signedOut', 'unknown', 'disabled'].includes(m) ? m : null;
}

const base = { provider: 'backend', enabled: true, signedIn: true, cloudConfigured: true, configured: true };
const paid = (plan, name) => ({ ...base, quota: { status: 'active', plan, planName: name } });

// Entradas de ai-source.describe() para el escenario, o null si el modo falso no esta activo.
function inputs() {
  const m = mode();
  if (!m) return null;
  const claude = { claude: { installed: true, loggedIn: true, cli: 'claude' }, chatgpt: { installed: false, loggedIn: null } };
  const none = { claude: { installed: false }, chatgpt: { installed: false } };
  switch (m) {
    case 'both':
      return { status: paid('go', 'Go'), engines: claude, entitled: true };
    case 'basic':
      return { status: paid('basic', 'Basic'), engines: claude, entitled: false };
    case 'none':
      return { status: { ...base, quota: { status: 'none', plan: null } }, engines: none, entitled: false };
    case 'signedOut':
      return { status: { ...base, signedIn: false, quota: null }, engines: none, entitled: false };
    case 'unknown':
      return { status: { ...base, quota: null }, engines: none, entitled: false };
    case 'disabled':
      return { status: { ...base, enabled: false }, engines: none, entitled: false };
    default:
      return { status: paid('go', 'Go'), engines: none, entitled: false };
  }
}

// Quien "responde" en el modo falso: un plan fijo y sin motivos.
function runner() {
  if (!mode()) return null;
  return {
    json: async (o) =>
      o?.schema?.required?.includes('items')
        ? { items: [] }
        : { types: ['mod', 'shader'], mcVersion: '', loader: '', mode: 'any', themes: ['zombie apocalypse'], hardware: 'normal', searches: [{ type: 'mod', query: 'zombie', categories: ['mobs'], weight: 1 }], summary: 'Kit de supervivencia con zombis (IA de demostración)' },
  };
}

module.exports = { mode, inputs, runner };
