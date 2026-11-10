'use strict';
// Reglas de Soporte que el servidor (migración 0045) también aplica. La interfaz tiene su copia en
// renderer/js/features/support/logic.js; las pruebas de client.test.js cuidan que las dos digan lo mismo.

// Se aceptan los ocho; el formulario nuevo ofrece los seis primeros ('general' y 'account' siguen para consultas viejas).
const CATEGORIES = ['bug', 'game', 'payments', 'assistant', 'suggestion', 'other', 'general', 'account'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const STATUS_FILTERS = ['pending', 'waiting', 'progress', 'closed', 'all'];
const ASSIGNED_FILTERS = ['any', 'me', 'none'];
const SORTS = ['priority', 'newest', 'oldest'];

// Campos propios de cada categoría: valores permitidos (enums) y texto libre con su largo máximo (free).
const DETAILS = {
  bug: { enums: { area: ['launcher', 'install', 'update', 'account', 'social', 'other'], frequency: ['always', 'sometimes', 'once'] }, free: { steps: 600 } },
  game: { enums: { loader: ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge', 'other'], moment: ['launch', 'loading', 'playing', 'closing'], modsChanged: ['yes', 'no', 'unknown'] }, free: { mcVersion: 24, steps: 600 } },
  payments: { enums: { topic: ['login', 'profile', 'sanction', 'payment', 'refund', 'other'], method: ['mercado_pago', 'paypal', 'other'] }, free: { paidOn: 10, orderRef: 80 } },
  assistant: { enums: { plan: ['none', 'claude_basic', 'claude_go', 'claude_pro', 'claude_max', 'claude_ultra', 'basic', 'go', 'pro', 'max', 'ultra'], issue: ['noreply', 'limit', 'wrong', 'billing', 'other'] }, free: {} },
  suggestion: { enums: { area: ['launcher', 'play', 'social', 'ai', 'other'] }, free: { benefit: 400 } },
  other: { enums: {}, free: {} },
  general: { enums: {}, free: {} },
  account: { enums: {}, free: {} },
};

const LIMITS = {
  subject: [3, 120],
  message: [1, 4000],
  note: 2000,
  closeNote: 500,
  diagnostic: 12000,
  rating: [1, 5],
  ratingComment: 500,
  macroTitle: 60,
  macroBody: 2000,
  search: 60,
  attachmentsPerSend: 3,
  attachmentBytes: 4 * 1024 * 1024,
  attachmentMime: ['image/png', 'image/jpeg', 'image/webp'],
  attachmentName: 80,
};

const CONTROL = /[\u0000-\u0008\u000b-\u001f]/; // todo menos \t y \n
const SHORT_BAD = /[\r\n<>]/;

function coded(code, message) { return Object.assign(new Error(message), { code }); }

// Devuelve los campos propios ya recortados y sin vacíos, o tira badRequest si algo no corresponde a la categoría.
function cleanDetails(category, details) {
  if (details === undefined || details === null) return {};
  if (typeof details !== 'object' || Array.isArray(details)) throw coded('bad_details', 'Revisá los datos de la consulta.');
  const spec = DETAILS[category] || { enums: {}, free: {} };
  const out = {};
  for (const [key, value] of Object.entries(details)) {
    if (typeof value !== 'string') throw coded('bad_details', 'Revisá los datos de la consulta.');
    const text = value.trim();
    if (!text) continue;
    if (spec.enums[key]) {
      if (!spec.enums[key].includes(text)) throw coded('bad_details', 'Revisá los datos de la consulta.');
    } else if (spec.free[key]) {
      if (text.length > spec.free[key] || CONTROL.test(text) || (['mcVersion', 'paidOn', 'orderRef'].includes(key) && SHORT_BAD.test(text))
        || (key === 'paidOn' && !/^\d{4}-\d{2}-\d{2}$/.test(text))) throw coded('bad_details', 'Revisá los datos de la consulta.');
    } else throw coded('bad_details', 'Revisá los datos de la consulta.');
    out[key] = text;
  }
  return out;
}

function cleanDiagnostic(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw coded('bad_diagnostic', 'El diagnóstico no es válido.');
  const text = value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
  if (!text) return null;
  if (text.length > LIMITS.diagnostic || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw coded('bad_diagnostic', 'El diagnóstico es demasiado largo o tiene caracteres no válidos.');
  return text;
}

module.exports = { CATEGORIES, PRIORITIES, STATUS_FILTERS, ASSIGNED_FILTERS, SORTS, DETAILS, LIMITS, cleanDetails, cleanDiagnostic, coded };
