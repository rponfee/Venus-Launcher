'use strict';
// Verifica las traducciones contra el español: claves faltantes o sobrantes y {variables} distintas.
// Uso: node scripts/i18n-check.js [idioma ...]      (sin argumentos: todos los idiomas)
//      node scripts/i18n-check.js --summary         (solo totales por idioma)
process.removeAllListeners('warning'); // sin el aviso de modulos ES sin "type"
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const AREAS = [
  { name: 'renderer', dir: path.join(ROOT, 'src', 'renderer', 'i18n'), esm: true },
  { name: 'main', dir: path.join(ROOT, 'src', 'main', 'i18n'), esm: false },
];
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

const args = process.argv.slice(2);
const summaryOnly = args.includes('--summary');
const onlyLangs = args.filter((a) => !a.startsWith('--'));

async function load(file, esm) {
  if (esm) return (await import(`${pathToFileURL(file).href}?t=${Date.now()}`)).default || {};
  delete require.cache[require.resolve(file)];
  return require(file);
}

function vars(text) {
  return [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
}

function baseKey(k) {
  return k.replace(PLURAL_SUFFIX, '');
}

(async () => {
  let problems = 0;
  const totals = {};
  for (const area of AREAS) {
    if (!fs.existsSync(area.dir)) continue;
    const esDir = path.join(area.dir, 'es');
    if (!fs.existsSync(esDir)) continue;
    const namespaces = fs.readdirSync(esDir).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3));
    const langs = fs
      .readdirSync(area.dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== 'es')
      .map((d) => d.name)
      .filter((l) => !onlyLangs.length || onlyLangs.includes(l));
    for (const lang of langs) {
      for (const ns of namespaces) {
        const es = await load(path.join(esDir, `${ns}.js`), area.esm);
        const file = path.join(area.dir, lang, `${ns}.js`);
        const key = `${lang}`;
        totals[key] = totals[key] || { missingFiles: 0, missingKeys: 0, extraKeys: 0, badVars: 0 };
        if (!fs.existsSync(file)) {
          totals[key].missingFiles++;
          problems++;
          if (!summaryOnly) console.log(`[${area.name}] ${lang}/${ns}.js: falta el archivo`);
          continue;
        }
        let tr;
        try {
          tr = await load(file, area.esm);
        } catch (err) {
          problems++;
          console.log(`[${area.name}] ${lang}/${ns}.js: error al cargar: ${err.message}`);
          continue;
        }
        const esBases = new Set(Object.keys(es).map(baseKey));
        for (const k of Object.keys(es)) {
          const isPlural = PLURAL_SUFFIX.test(k);
          // Un plural del español se considera cubierto si existe cualquier forma plural de esa clave.
          const present = isPlural ? Object.keys(tr).some((t) => baseKey(t) === baseKey(k)) : k in tr;
          if (!present) {
            totals[key].missingKeys++;
            problems++;
            if (!summaryOnly) console.log(`[${area.name}] ${lang}/${ns}: falta "${k}"`);
            continue;
          }
          if (!isPlural && vars(es[k]) !== vars(tr[k])) {
            totals[key].badVars++;
            problems++;
            if (!summaryOnly) console.log(`[${area.name}] ${lang}/${ns}: variables distintas en "${k}" (es: {${vars(es[k])}} / ${lang}: {${vars(tr[k])}})`);
          }
        }
        for (const k of Object.keys(tr)) {
          if (!(k in es) && !esBases.has(baseKey(k))) {
            totals[key].extraKeys++;
            if (!summaryOnly) console.log(`[${area.name}] ${lang}/${ns}: clave sobrante "${k}"`);
          }
        }
      }
    }
  }
  console.log('\nResumen por idioma:');
  for (const [lang, t] of Object.entries(totals).sort()) {
    console.log(`  ${lang.padEnd(4)} archivos faltantes: ${t.missingFiles}  claves faltantes: ${t.missingKeys}  variables distintas: ${t.badVars}  sobrantes: ${t.extraKeys}`);
  }
  process.exit(problems ? 1 : 0);
})();
