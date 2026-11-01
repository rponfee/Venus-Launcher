'use strict';
// Convierte las pruebas que fallaron (salida TAP de node --test) en anotaciones de GitHub Actions. Las anotaciones se
// ven sin iniciar sesión en GitHub; el registro completo de un workflow, no.
// Uso: node --test --test-reporter=tap --test-reporter-destination=test-results.tap ...
//      node scripts/ci-annotate.js test-results.tap
const fs = require('fs');
const path = require('path');

const MAX = 10; // GitHub muestra hasta 10 errores por paso

// GitHub usa %, \r y \n como escapes en el texto de una anotación (y además , y : en las propiedades)
const escData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = (s) => escData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

// Valor de "clave: 'texto'" o de un bloque "clave: |-" del YAML de un "not ok".
function field(block, key) {
  const i = block.findIndex((l) => l.trimStart().startsWith(`${key}:`));
  if (i < 0) return '';
  const line = block[i];
  const value = line.slice(line.indexOf(':') + 1).trim();
  if (value !== '|-' && value !== '|' && value !== '>-') return value.replace(/^'(.*)'$/, '$1').replace(/''/g, "'");
  const indent = line.length - line.trimStart().length;
  const out = [];
  for (const l of block.slice(i + 1)) {
    if (l.trim() && l.length - l.trimStart().length <= indent) break;
    out.push(l.trim());
  }
  return out.join('\n');
}

function failures(text) {
  const lines = text.split(/\r?\n/);
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)not ok \d+ - (.*)$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    const block = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === '...' && l.length - l.trimStart().length === indent + 2) break;
      block.push(l);
    }
    // Una suite que falla porque falló una prueba de adentro repite el mismo error: se anota solo la prueba
    if (field(block, 'failureType') === 'subtestsFailed') continue;
    const loc = /^(.*):(\d+):\d+$/.exec(field(block, 'location').replace(/\\\\/g, '\\'));
    found.push({
      name: m[2].trim(),
      file: loc ? path.relative(process.cwd(), loc[1]).split(path.sep).join('/') : '',
      line: loc ? loc[2] : '',
      error: [field(block, 'error'), field(block, 'code'), field(block, 'expected') && `expected: ${field(block, 'expected')}`, field(block, 'actual') && `actual: ${field(block, 'actual')}`]
        .filter(Boolean)
        .join('\n')
        .slice(0, 1500),
    });
  }
  return found;
}

if (require.main === module) {
  const file = process.argv[2];
  const text = file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const list = failures(text);
  for (const f of list.slice(0, MAX)) {
    const props = [f.file && `file=${escProp(f.file)}`, f.line && `line=${f.line}`, `title=${escProp(f.name.slice(0, 200))}`].filter(Boolean).join(',');
    console.log(`::error ${props}::${escData(f.error || 'La prueba falló')}`);
  }
  if (list.length > MAX) console.log(`::error title=Pruebas::Fallaron ${list.length} pruebas; se muestran las primeras ${MAX}.`);
  if (!list.length) console.log('::error title=Pruebas::node --test terminó con error, pero no se encontraron pruebas fallidas en el TAP.');
}

module.exports = { failures };
