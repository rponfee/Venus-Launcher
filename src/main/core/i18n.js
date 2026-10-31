'use strict';
// Traducciones del proceso principal (titulos de tareas, errores que ve el usuario).
// Diccionarios: src/main/i18n/<idioma>/<ns>.js  ->  module.exports = { clave: 'texto con {variable}' }
// Uso: const { t } = require('../core/i18n'); t('servers.installing', { name })
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'i18n');
const FALLBACK = ['en', 'es'];
let lang = 'es';
const cache = new Map();

function setLanguage(code) {
  if (code && typeof code === 'string') lang = code;
}

function getLanguage() {
  return lang;
}

function dict(code, ns) {
  const key = `${code}/${ns}`;
  if (!cache.has(key)) {
    const file = path.join(DIR, code, `${ns}.js`);
    let value = null;
    if (fs.existsSync(file)) {
      try {
        value = require(file);
      } catch (err) {
        console.error(`[i18n] ${key}:`, err.message);
      }
    }
    cache.set(key, value);
  }
  return cache.get(key);
}

function format(text, vars) {
  if (!vars) return String(text);
  return String(text).replace(/\{(\w+)\}/g, (m, name) => (vars[name] === undefined || vars[name] === null ? m : String(vars[name])));
}

function lookup(code, ns, key) {
  const d = dict(code, ns);
  return d && Object.prototype.hasOwnProperty.call(d, key) ? d[key] : undefined;
}

// t('ns.clave', vars). Con vars.count se prueba primero 'clave_one' / 'clave_other' segun el idioma.
function t(fullKey, vars) {
  const dot = fullKey.indexOf('.');
  if (dot < 0) return fullKey;
  const ns = fullKey.slice(0, dot);
  const key = fullKey.slice(dot + 1);
  const chain = [lang, ...FALLBACK.filter((c) => c !== lang)];
  const candidates = [key];
  if (vars && typeof vars.count === 'number') {
    let rule = 'other';
    try {
      rule = new Intl.PluralRules(lang).select(vars.count);
    } catch {
      /* idioma desconocido */
    }
    candidates.unshift(`${key}_${rule}`, `${key}_other`);
  }
  for (const code of chain) {
    for (const k of candidates) {
      const v = lookup(code, ns, k);
      if (v !== undefined) return format(v, vars);
    }
  }
  return fullKey;
}

// Idiomas con diccionarios de interfaz disponibles (lo usa el renderer para no pedir archivos inexistentes).
function availableRenderer() {
  const base = path.join(__dirname, '..', '..', 'renderer', 'i18n');
  const out = {};
  let langs = [];
  try {
    langs = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return out;
  }
  for (const code of langs) {
    try {
      out[code] = fs.readdirSync(path.join(base, code)).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3));
    } catch {
      out[code] = [];
    }
  }
  return out;
}

module.exports = { t, setLanguage, getLanguage, availableRenderer, format };
