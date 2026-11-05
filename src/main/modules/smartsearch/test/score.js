'use strict';
// Mide cuantas frases del corpus entiende un interprete: por frase (todos los campos esperados bien) y por campo.
// score(interpreter) -> { total, passed, fields, fieldsPassed, byGroup, failures }
// Uso por linea de comandos (el antes y el despues):
//   node src/main/modules/smartsearch/test/score.js                     el interprete actual
//   node src/main/modules/smartsearch/test/score.js <carpeta>            otro (por ejemplo una copia del commit anterior:
//                                                                        git archive <commit> src/main/modules/smartsearch)
//   agregar --fails para listar las frases que fallan, y --heldout para medir las frases "a ciegas" (corpus-heldout.js)
const path = require('path');
const { CORPUS, RELEASES, LATEST } = require('./corpus');

// Cada campo esperado: [clave, funcion(interp) -> bool]
function checks(expect) {
  const list = [];
  const ids = (i) => (i.themes || []).map((th) => th.id);
  if (expect.t) list.push(['t', (i) => i.types.length === expect.t.length && expect.t.every((tp) => i.types.includes(tp))]);
  if (expect.x) list.push(['x', (i) => expect.x.every((tp) => i.excluded.includes(tp))]);
  if (expect.l) list.push(['l', (i) => i.loader === expect.l]);
  if (expect.van) list.push(['van', (i) => i.vanilla === true]);
  // "la ultima version" no trae una version concreta: el plan toma la ultima release (i.latest)
  if (expect.v) list.push(['v', (i) => i.version?.value === expect.v || (expect.v === LATEST && i.latest === true && !i.version)]);
  if (expect.m) list.push(['m', (i) => i.mode === expect.m]);
  if (expect.th?.length) list.push(['th', (i) => expect.th.every((id) => ids(i).includes(id))]);
  if (expect.none) list.push(['none', (i) => !(i.themes || []).length && !i.flags?.lowEnd && !i.flags?.highEnd]);
  if (expect.no) list.push(['no', (i) => expect.no.every((id) => !ids(i).includes(id))]);
  if (expect.lo) list.push(['lo', (i) => i.flags?.lowEnd === true]);
  if (expect.hi) list.push(['hi', (i) => i.flags?.highEnd === true]);
  if (expect.c) list.push(['c', (i) => Object.entries(expect.c).every(([tp, n]) => i.counts?.[tp] === n)]);
  if (expect.s) list.push(['s', (i) => expect.s.every((id) => (i.similar || []).includes(id))]);
  if (expect.sw) list.push(['sw', (i) => i.serverSoftware === expect.sw]);
  if (expect.sh) list.push(['sh', (i) => i.shaderLoader === expect.sh]);
  return list;
}

function score(interpreter, { corpus = CORPUS } = {}) {
  const ctx = { releases: new Set(RELEASES), latestRelease: LATEST, uiLang: 'es' };
  const byGroup = {};
  const failures = [];
  let passed = 0;
  let fields = 0;
  let fieldsPassed = 0;
  for (const entry of corpus) {
    let interp;
    try {
      interp = interpreter.interpret(entry.text, ctx);
    } catch (err) {
      interp = null;
    }
    const wanted = checks(entry.expect);
    const failed = [];
    for (const [key, fn] of wanted) {
      fields++;
      let ok = false;
      try {
        ok = Boolean(interp) && fn(interp);
      } catch {
        ok = false;
      }
      if (ok) fieldsPassed++;
      else failed.push(key);
    }
    const g = (byGroup[entry.group] = byGroup[entry.group] || { total: 0, passed: 0 });
    g.total++;
    if (!failed.length) {
      passed++;
      g.passed++;
    } else failures.push({ ...entry, failed, got: interp && { types: interp.types, excluded: interp.excluded, loader: interp.loader, vanilla: interp.vanilla, version: interp.version?.value || null, mode: interp.mode, themes: (interp.themes || []).map((th) => th.id), lowEnd: interp.flags?.lowEnd, highEnd: interp.flags?.highEnd, counts: interp.counts, similar: interp.similar } });
  }
  return { total: corpus.length, passed, fields, fieldsPassed, byGroup, failures };
}

const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '-');

function report(result, label) {
  const lines = [`${label}: ${result.passed}/${result.total} frases (${pct(result.passed, result.total)}), ${result.fieldsPassed}/${result.fields} campos (${pct(result.fieldsPassed, result.fields)})`];
  for (const [group, g] of Object.entries(result.byGroup)) lines.push(`  ${group.padEnd(11)} ${String(g.passed).padStart(3)}/${String(g.total).padEnd(3)} ${pct(g.passed, g.total)}`);
  return lines.join('\n');
}

module.exports = { score, report, checks };

if (require.main === module) {
  const dir = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const interpreter = require(dir ? path.resolve(dir, 'interpreter') : './../interpreter');
  const result = score(interpreter, process.argv.includes('--heldout') ? { corpus: require('./corpus-heldout').CORPUS } : {});
  console.log(report(result, dir ? path.basename(path.resolve(dir, '..', '..', '..', '..')) || dir : 'actual'));
  if (process.argv.includes('--fails')) for (const f of result.failures) console.log(`- [${f.group}] ${JSON.stringify(f.text)} falla ${f.failed.join(',')} -> ${JSON.stringify(f.got)}`);
}
