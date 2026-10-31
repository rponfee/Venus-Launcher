'use strict';
// Chequeo rapido de sintaxis de todo el proyecto (sin abrir Electron).
// Uso: node scripts/check.js [carpeta-o-archivo ...]
//   - src/main/**        -> CommonJS (node --check)
//   - src/renderer/**    -> modulos ES (se copian a .mjs temporales y se chequean)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const targets = process.argv.slice(2).map((p) => path.resolve(p));
if (!targets.length) targets.push(path.join(ROOT, 'src'));

function walk(p, out) {
  const st = fs.statSync(p);
  if (st.isFile()) {
    if (p.endsWith('.js')) out.push(p);
    return out;
  }
  for (const name of fs.readdirSync(p)) {
    if (name === 'node_modules' || name === 'vendor') continue;
    walk(path.join(p, name), out);
  }
  return out;
}

const files = targets.flatMap((t) => walk(t, []));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'venus-check-'));
let failed = 0;
for (const file of files) {
  const isRenderer = file.includes(`${path.sep}renderer${path.sep}`);
  let target = file;
  if (isRenderer) {
    target = path.join(tmp, `${files.indexOf(file)}.mjs`);
    fs.copyFileSync(file, target);
  }
  const r = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed++;
    console.log(`\n✗ ${path.relative(ROOT, file)}\n${(r.stderr || '').replaceAll(target, path.relative(ROOT, file)).trim()}`);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${files.length - failed}/${files.length} archivos sin errores de sintaxis.`);
process.exit(failed ? 1 : 0);
