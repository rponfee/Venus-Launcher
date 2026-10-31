// Traducciones de la interfaz.
// Diccionarios: src/renderer/i18n/<idioma>/<ns>.js  ->  export default { clave: 'Texto con {variable}' }
// Uso en una pagina:   export default { ns: ['home'], render(root) { ... t('home.play') ... } }
// (app.js carga los espacios de nombres de la pagina antes de llamar a render)
// Plurales: t('stats.sessions', { count: n }) busca 'sessions_one' / 'sessions_other' segun el idioma.

const api = window.venus;

export const LANGUAGES = [
  { code: 'es', name: 'Español', english: 'Spanish', locale: 'es' },
  { code: 'en', name: 'English', english: 'English', locale: 'en' },
  { code: 'pt', name: 'Português (Brasil)', english: 'Portuguese', locale: 'pt-BR' },
  { code: 'fr', name: 'Français', english: 'French', locale: 'fr' },
  { code: 'de', name: 'Deutsch', english: 'German', locale: 'de' },
  { code: 'it', name: 'Italiano', english: 'Italian', locale: 'it' },
  { code: 'nl', name: 'Nederlands', english: 'Dutch', locale: 'nl' },
  { code: 'pl', name: 'Polski', english: 'Polish', locale: 'pl' },
  { code: 'ru', name: 'Русский', english: 'Russian', locale: 'ru' },
  { code: 'uk', name: 'Українська', english: 'Ukrainian', locale: 'uk' },
  { code: 'tr', name: 'Türkçe', english: 'Turkish', locale: 'tr' },
  { code: 'ja', name: '日本語', english: 'Japanese', locale: 'ja' },
  { code: 'ko', name: '한국어', english: 'Korean', locale: 'ko' },
  { code: 'zh', name: '简体中文', english: 'Chinese (Simplified)', locale: 'zh-CN' },
];

const FALLBACK = ['en', 'es'];
let lang = 'es';
let available = null; // { es: ['common', ...], en: [...] }
const dicts = {}; // lang -> ns -> dict
const loadedNs = new Set();
const changeListeners = new Set();
const missing = new Set();

export function getLanguage() {
  return lang;
}

// Locale BCP 47 para Intl (fechas, numeros, tiempo relativo)
export function locale() {
  return LANGUAGES.find((l) => l.code === lang)?.locale || lang;
}

// Idioma del sistema si esta soportado (para preseleccionar en la bienvenida)
export function systemLanguage(sysLocale = navigator.language) {
  const base = String(sysLocale || '').toLowerCase().split(/[-_]/)[0];
  return LANGUAGES.some((l) => l.code === base) ? base : 'en';
}

async function ensureAvailable() {
  if (!available) {
    try {
      available = await api.invoke('i18n:available');
    } catch {
      available = {};
    }
  }
  return available;
}

async function loadOne(code, ns) {
  dicts[code] = dicts[code] || {};
  if (dicts[code][ns]) return;
  const list = (await ensureAvailable())[code] || [];
  if (!list.includes(ns)) {
    dicts[code][ns] = {};
    return;
  }
  try {
    const mod = await import(new URL(`../i18n/${code}/${ns}.js`, import.meta.url).href);
    dicts[code][ns] = mod.default || {};
  } catch (err) {
    console.warn(`[i18n] ${code}/${ns}`, err);
    dicts[code][ns] = {};
  }
}

// Carga uno o mas espacios de nombres para el idioma actual y los de respaldo.
export async function loadNs(...names) {
  const list = names.flat().filter(Boolean);
  const chain = [lang, ...FALLBACK.filter((c) => c !== lang)];
  await Promise.all(list.flatMap((ns) => chain.map((code) => loadOne(code, ns))));
  list.forEach((ns) => loadedNs.add(ns));
}

export async function setLanguage(code) {
  const next = LANGUAGES.some((l) => l.code === code) ? code : 'es';
  const changed = next !== lang;
  lang = next;
  document.documentElement.lang = locale();
  await loadNs([...loadedNs]);
  if (changed) {
    for (const fn of changeListeners) {
      try {
        fn(lang);
      } catch (err) {
        console.error(err);
      }
    }
  }
}

export function onLanguageChange(fn) {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

function format(text, vars) {
  if (!vars) return String(text);
  return String(text).replace(/\{(\w+)\}/g, (m, name) => (vars[name] === undefined || vars[name] === null ? m : String(vars[name])));
}

function lookup(code, ns, key) {
  const d = dicts[code]?.[ns];
  return d && Object.prototype.hasOwnProperty.call(d, key) ? d[key] : undefined;
}

export function t(fullKey, vars) {
  const dot = fullKey.indexOf('.');
  if (dot < 0) return fullKey;
  const ns = fullKey.slice(0, dot);
  const key = fullKey.slice(dot + 1);
  const candidates = [key];
  if (vars && typeof vars.count === 'number') {
    let rule = 'other';
    try {
      rule = new Intl.PluralRules(locale()).select(vars.count);
    } catch {
      /* idioma desconocido */
    }
    candidates.unshift(`${key}_${rule}`, `${key}_other`);
  }
  for (const code of [lang, ...FALLBACK.filter((c) => c !== lang)]) {
    for (const k of candidates) {
      const v = lookup(code, ns, k);
      if (v !== undefined) return format(v, vars);
    }
  }
  if (!missing.has(fullKey)) {
    missing.add(fullKey);
    console.warn(`[i18n] Falta la clave ${fullKey}`);
  }
  return key;
}

// true si existe la clave (en algun idioma de la cadena)
export function has(fullKey) {
  const dot = fullKey.indexOf('.');
  const ns = fullKey.slice(0, dot);
  const key = fullKey.slice(dot + 1);
  return [lang, ...FALLBACK].some((code) => lookup(code, ns, key) !== undefined);
}
