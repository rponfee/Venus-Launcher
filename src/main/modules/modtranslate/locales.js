'use strict';
// Idiomas de destino de Minecraft. "name" es el nombre nativo (no se traduce, como en el selector
// de idiomas del juego); "ai" describe la variante para la IA; "note" agrega pautas de estilo.
const LOCALES = [
  { code: 'es_es', lang: 'es', name: 'Español (España)', ai: 'Spanish (Spain)', note: 'Use European Spanish as spoken in Spain and address the player with "tú".' },
  { code: 'es_ar', lang: 'es', name: 'Español (Argentina)', ai: 'Spanish (Argentina)', note: 'Use Rioplatense Spanish from Argentina and address the player with voseo (vos tenés, hacé clic, elegí). Never use "vosotros".' },
  { code: 'es_mx', lang: 'es', name: 'Español (México)', ai: 'Spanish (Mexico)', note: 'Use Latin American Spanish as spoken in Mexico; use "tú" and "ustedes", never "vosotros".' },
  { code: 'es_cl', lang: 'es', name: 'Español (Chile)', ai: 'Spanish (Chile)', note: 'Use neutral Latin American Spanish as spoken in Chile; use "tú" and "ustedes", never "vosotros".' },
  { code: 'es_uy', lang: 'es', name: 'Español (Uruguay)', ai: 'Spanish (Uruguay)', note: 'Use Rioplatense Spanish from Uruguay and address the player with voseo (vos tenés, hacé clic). Never use "vosotros".' },
  { code: 'es_ve', lang: 'es', name: 'Español (Venezuela)', ai: 'Spanish (Venezuela)', note: 'Use Latin American Spanish as spoken in Venezuela; use "tú" and "ustedes", never "vosotros".' },
  { code: 'pt_br', lang: 'pt', name: 'Português (Brasil)', ai: 'Brazilian Portuguese' },
  { code: 'pt_pt', lang: 'pt', name: 'Português (Portugal)', ai: 'European Portuguese (Portugal)' },
  { code: 'fr_fr', lang: 'fr', name: 'Français (France)', ai: 'French (France)' },
  { code: 'fr_ca', lang: 'fr', name: 'Français (Canada)', ai: 'Canadian French (Québec)' },
  { code: 'de_de', lang: 'de', name: 'Deutsch (Deutschland)', ai: 'German (Germany)' },
  { code: 'it_it', lang: 'it', name: 'Italiano (Italia)', ai: 'Italian' },
  { code: 'nl_nl', lang: 'nl', name: 'Nederlands (Nederland)', ai: 'Dutch (Netherlands)' },
  { code: 'pl_pl', lang: 'pl', name: 'Polski (Polska)', ai: 'Polish' },
  { code: 'ru_ru', lang: 'ru', name: 'Русский (Россия)', ai: 'Russian' },
  { code: 'uk_ua', lang: 'uk', name: 'Українська (Україна)', ai: 'Ukrainian' },
  { code: 'tr_tr', lang: 'tr', name: 'Türkçe (Türkiye)', ai: 'Turkish' },
  { code: 'ja_jp', lang: 'ja', name: '日本語 (日本)', ai: 'Japanese', note: 'Use the katakana and kanji names used by the official Japanese Minecraft translation.' },
  { code: 'ko_kr', lang: 'ko', name: '한국어 (대한민국)', ai: 'Korean' },
  { code: 'zh_cn', lang: 'zh', name: '简体中文 (中国大陆)', ai: 'Simplified Chinese (mainland China)' },
  { code: 'zh_tw', lang: 'zh-tw', name: '繁體中文 (台灣)', ai: 'Traditional Chinese (Taiwan)' },
];

const BY_CODE = new Map(LOCALES.map((l) => [l.code, l]));

// Idioma del launcher -> idioma de destino por defecto y sugeridos.
const DEFAULTS = {
  es: ['es_es', 'es_ar', 'es_mx'],
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
  zh: ['zh_cn', 'zh_tw'],
};

// Variantes cercanas cuyas traducciones sirven de base (orden de preferencia).
const SIBLINGS = {
  es_es: ['es_mx', 'es_ar', 'es_cl', 'es_uy', 'es_ve', 'es_ec'],
  es_ar: ['es_uy', 'es_mx', 'es_es', 'es_cl', 'es_ve', 'es_ec'],
  es_uy: ['es_ar', 'es_mx', 'es_es', 'es_cl', 'es_ve', 'es_ec'],
  es_mx: ['es_ar', 'es_cl', 'es_ve', 'es_uy', 'es_ec', 'es_es'],
  es_cl: ['es_mx', 'es_ar', 'es_uy', 'es_ve', 'es_ec', 'es_es'],
  es_ve: ['es_mx', 'es_cl', 'es_ar', 'es_uy', 'es_ec', 'es_es'],
  pt_br: ['pt_pt'],
  pt_pt: ['pt_br'],
  fr_fr: ['fr_ca'],
  fr_ca: ['fr_fr'],
};

function isLocale(code) {
  return typeof code === 'string' && BY_CODE.has(code);
}

function info(code) {
  return BY_CODE.get(code) || null;
}

function suggestedFor(appLang) {
  return DEFAULTS[String(appLang || '').slice(0, 2)] || [];
}

function defaultFor(appLang) {
  return suggestedFor(appLang)[0] || 'es_es';
}

function siblingsOf(code) {
  return SIBLINGS[code] || [];
}

// "es_es" -> "es_ES" (nombres de archivo y options.txt de Minecraft 1.10 y anteriores)
function legacyCode(code) {
  const [l, r] = String(code).split('_');
  return r ? `${l}_${r.toUpperCase()}` : code;
}

// Lista para la interfaz: sugeridos primero.
function listFor(appLang) {
  const sug = suggestedFor(appLang);
  const rank = (c) => (sug.includes(c) ? sug.indexOf(c) : 100 + LOCALES.findIndex((l) => l.code === c));
  return LOCALES.map((l) => ({ code: l.code, name: l.name, suggested: sug.includes(l.code) })).sort((a, b) => rank(a.code) - rank(b.code));
}

module.exports = { LOCALES, isLocale, info, suggestedFor, defaultFor, siblingsOf, legacyCode, listFor };
