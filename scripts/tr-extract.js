// Saca lo que falta traducir por idioma a .tr/need-<idioma>.json: { "<renderer|main>/<ns>": { clave: { en, es } } }.
// El español y el inglés los escribe quien hace la función; los otros 12 idiomas salen de acá. Se traduce a
// .tr/done-<idioma>.json (mismo formato, con el texto traducido como valor de cada clave) y se aplica con tr-merge.js.
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.tr');
fs.mkdirSync(OUT, { recursive: true });
const LANGS = ['pt', 'fr', 'de', 'it', 'nl', 'pl', 'ru', 'uk', 'tr', 'ja', 'ko', 'zh'];
// Textos que cambiaron en es/en desde la 3.1.0: los otros idiomas tienen una versión vieja. Sacalos después de traducir.
const STALE = {
  'renderer/overlay': ['perfNoFps'],
};
function load(file) {
  if (!fs.existsSync(file)) return null;
  let s = fs.readFileSync(file, 'utf8');
  s = s.replace(/^\uFEFF/, '').replace(/export default/, 'module.exports =');
  const m = { exports: {} };
  new Function('module', 'exports', 'require', s)(m, m.exports, () => ({}));
  return m.exports;
}
const kinds = { renderer: 'src/renderer/i18n', main: 'src/main/i18n' };
const totals = {};
for (const lang of LANGS) {
  const out = {};
  let n = 0;
  for (const [kind, base] of Object.entries(kinds)) {
    for (const f of fs.readdirSync(path.join(ROOT, base, 'en'))) {
      const ns = f.replace(/\.js$/, '');
      if (ns === 'admin') continue; // el panel de administracion no se traduce: cae a ingles
      const en = load(path.join(ROOT, base, 'en', f)) || {};
      const es = load(path.join(ROOT, base, 'es', f)) || {};
      const cur = load(path.join(ROOT, base, lang, f)) || {};
      const stale = STALE[`${kind}/${ns}`] || [];
      for (const [k, v] of Object.entries(en)) {
        if (typeof v !== 'string') continue;
        if (['ja', 'ko', 'zh'].includes(lang) && /_one$/.test(k)) continue; // esos idiomas no tienen singular
        if (cur[k] !== undefined && !stale.includes(k)) continue;
        (out[`${kind}/${ns}`] ||= {})[k] = { en: v, es: es[k] };
        n++;
      }
    }
  }
  fs.writeFileSync(path.join(OUT, `need-${lang}.json`), JSON.stringify(out, null, 1));
  totals[lang] = n;
}
console.log(totals);
const sample = JSON.parse(fs.readFileSync(path.join(OUT, 'need-pt.json'), 'utf8'));
console.log(Object.fromEntries(Object.entries(sample).map(([k, v]) => [k, Object.keys(v).length])));
