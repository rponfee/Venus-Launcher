// Textos de la pagina del overlay. La ventana del overlay no tiene el puente del launcher, asi que carga el mismo
// diccionario de la interfaz (src/renderer/i18n/<idioma>/overlay.js) directamente, con el idioma que manda el
// proceso principal y el ingles y el espanol de respaldo. Plurales con _one / _other como i18n.js.

const FALLBACK = ['en', 'es'];
const LOCALES = { pt: 'pt-BR', zh: 'zh-CN' };

export function createTranslator() {
  let lang = 'es';
  let chain = [];
  const dicts = new Map();

  async function loadOne(code) {
    if (dicts.has(code)) return dicts.get(code);
    let dict = null;
    if (/^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(code)) {
      try {
        dict = (await import(new URL(`../../i18n/${code}/overlay.js`, import.meta.url).href)).default || null;
      } catch {
        dict = null; // idioma sin traduccion del overlay todavia
      }
    }
    dicts.set(code, dict);
    return dict;
  }

  async function load(code) {
    lang = typeof code === 'string' && code ? code : 'es';
    const codes = [lang, ...FALLBACK.filter((c) => c !== lang)];
    chain = (await Promise.all(codes.map(loadOne))).filter(Boolean);
    document.documentElement.lang = LOCALES[lang] || lang;
  }

  function t(key, vars) {
    const candidates = [key];
    if (vars && typeof vars.count === 'number') {
      let rule = 'other';
      try {
        rule = new Intl.PluralRules(LOCALES[lang] || lang).select(vars.count);
      } catch {
        /* idioma desconocido */
      }
      candidates.unshift(`${key}_${rule}`, `${key}_other`);
    }
    for (const dict of chain) {
      for (const k of candidates) {
        if (Object.prototype.hasOwnProperty.call(dict, k)) {
          return String(dict[k]).replace(/\{(\w+)\}/g, (m, name) => (vars?.[name] === undefined || vars[name] === null ? m : String(vars[name])));
        }
      }
    }
    return key;
  }

  return { load, t };
}
