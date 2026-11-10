// Saca lo que falta traducir por idioma a .tr/need-<idioma>.json: { "<renderer|main>/<ns>": { clave: { en, es } } }.
// El español y el inglés los escribe quien hace la función; los otros 12 idiomas salen de acá. Se traduce a
// .tr/done-<idioma>.json (mismo formato, con el texto traducido como valor de cada clave) y se aplica con tr-merge.js.
// Con --since <ref de git> (por ejemplo --since HEAD o --since v6.0.0) también saca los textos que cambiaron en español
// o en inglés desde esa versión: los otros idiomas tienen la traducción vieja.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.tr');
fs.mkdirSync(OUT, { recursive: true });
const LANGS = ['pt', 'fr', 'de', 'it', 'nl', 'pl', 'ru', 'uk', 'tr', 'ja', 'ko', 'zh'];
// Textos que cambiaron en es/en desde la 3.1.0: los otros idiomas tienen una versión vieja. Sacalos después de traducir.
const STALE = {
};
function evaluate(source) {
  const s = source.replace(/^\uFEFF/, '').replace(/export default/, 'module.exports =');
  const m = { exports: {} };
  new Function('module', 'exports', 'require', s)(m, m.exports, () => ({}));
  return m.exports;
}
function load(file) {
  if (!fs.existsSync(file)) return null;
  return evaluate(fs.readFileSync(file, 'utf8'));
}
const kinds = { renderer: 'src/renderer/i18n', main: 'src/main/i18n' };
// --since <ref>: el archivo tal como estaba en esa versi\u00F3n ({} si no exist\u00EDa).
const sinceAt = process.argv.indexOf('--since');
const SINCE = sinceAt > 0 ? process.argv[sinceAt + 1] : null;
// La versión tiene que existir: si git no la resuelve (mal escrita, o un tag que no está en este clon), sin este
// corte no se marcaría ningún texto como cambiado y nada lo avisaría.
if (sinceAt > 0) {
  try {
    if (!SINCE) throw new Error('sin ref');
    const safe = `safe.directory=${ROOT.split(path.sep).join('/')}`;
    execFileSync('git', ['-c', safe, 'rev-parse', '--verify', '--quiet', `${SINCE}^{commit}`], { cwd: ROOT, stdio: 'ignore' });
  } catch {
    console.error(`--since: git no encuentra la versión "${SINCE ?? ''}" (¿falta git fetch --tags?)`);
    process.exit(1);
  }
}
function loadAt(ref, rel) {
  try {
    const safe = `safe.directory=${ROOT.split(path.sep).join('/')}`;
    return evaluate(execFileSync('git', ['-c', safe, 'show', `${ref}:${rel}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })) || {};
  } catch {
    return {};
  }
}
// Claves que ya exist\u00EDan en esa versi\u00F3n y cuyo texto en espa\u00F1ol o en ingl\u00E9s cambi\u00F3.
const changedCache = new Map();
function changedSince(kind, base, f, en, es) {
  if (!SINCE) return [];
  const id = `${kind}/${f}`;
  if (!changedCache.has(id)) {
    const oldEn = loadAt(SINCE, `${base}/en/${f}`);
    const oldEs = loadAt(SINCE, `${base}/es/${f}`);
    changedCache.set(id, Object.keys(en).filter((k) => (k in oldEn && oldEn[k] !== en[k]) || (k in oldEs && oldEs[k] !== es[k])));
  }
  return changedCache.get(id);
}
const totals = {};
for (const lang of LANGS) {
  const out = {};
  let n = 0;
  for (const [kind, base] of Object.entries(kinds)) {
    for (const f of fs.readdirSync(path.join(ROOT, base, 'en'))) {
      const ns = f.replace(/\.js$/, '');
      const en = load(path.join(ROOT, base, 'en', f)) || {};
      const es = load(path.join(ROOT, base, 'es', f)) || {};
      const cur = load(path.join(ROOT, base, lang, f)) || {};
      const stale = [...(STALE[`${kind}/${ns}`] || []), ...changedSince(kind, base, f, en, es)];
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
