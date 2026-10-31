'use strict';
// Cruza los canales que usa la interfaz con los que registra el proceso principal.
// Uso: node scripts/contracts-check.js
//  - "sin handler": la interfaz llama api.invoke('x:y') / venus.x.y() y nadie registra 'x:y'
//  - "sin uso": el proceso principal registra 'x:y' y nadie lo llama (informativo)
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (name !== 'node_modules' && name !== 'vendor' && name !== 'i18n') walk(p, out);
    } else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
const mainFiles = walk(path.join(ROOT, 'src', 'main'));
const rendererFiles = walk(path.join(ROOT, 'src', 'renderer', 'js'));

// Canales registrados: handle('x:y' / ctx.handle("x:y" / ipcMain.handle('x:y' / override('x:y' (serverx)
const registered = new Map();
const handleRe = /\b(?:handle|override|ipcMain\.handle)\(\s*['"`]([a-z][\w]*:[\w:.-]+)['"`]/g;
for (const f of mainFiles) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(handleRe)) {
    if (!registered.has(m[1])) registered.set(m[1], new Set());
    registered.get(m[1]).add(rel(f));
  }
}
// Canales del puente viejo de preload: call('x:y')
const preload = fs.readFileSync(path.join(ROOT, 'src', 'main', 'preload.js'), 'utf8');
const preloadMap = new Map(); // 'instances.list' -> 'instances:list'
for (const block of preload.matchAll(/(\w+):\s*\{([^{}]*)\}/g)) {
  for (const m of block[2].matchAll(/(\w+):\s*call\('([^']+)'\)/g)) preloadMap.set(`${block[1]}.${m[1]}`, m[2]);
}

// Canales usados por la interfaz
const used = new Map();
const add = (ch, f) => {
  if (!used.has(ch)) used.set(ch, new Set());
  used.get(ch).add(rel(f));
};
const invokeRe = /\b(?:api|venus|window\.venus)\.invoke\(\s*['"`]([a-z][\w]*:[\w:.-]+)['"`]/g;
const sugarRe = /\b(?:api|venus|window\.venus)\.(\w+)\.(\w+)\(/g;
for (const f of rendererFiles) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(invokeRe)) add(m[1], f);
  for (const m of src.matchAll(sugarRe)) {
    const key = `${m[1]}.${m[2]}`;
    if (preloadMap.has(key)) add(preloadMap.get(key), f);
    else if (!['app', 'on', 'invoke'].includes(m[1])) add(`?${key}`, f);
  }
}
// Llamadas hechas desde el proceso principal a canales de otros (poco comun) no se cuentan.

let missing = 0;
console.log('== Canales usados por la interfaz sin handler registrado ==');
for (const [ch, files] of [...used].sort()) {
  if (ch.startsWith('?')) {
    missing++;
    console.log(`  ${ch.slice(1)} (atajo inexistente en preload) <- ${[...files].join(', ')}`);
  } else if (!registered.has(ch)) {
    missing++;
    console.log(`  ${ch} <- ${[...files].join(', ')}`);
  }
}
if (!missing) console.log('  (ninguno)');

console.log('\n== Canales registrados que la interfaz no usa (informativo) ==');
const unusedByNs = {};
for (const ch of registered.keys()) {
  if (!used.has(ch)) (unusedByNs[ch.split(':')[0]] = unusedByNs[ch.split(':')[0]] || []).push(ch.split(':').slice(1).join(':'));
}
for (const [ns, list] of Object.entries(unusedByNs).sort()) console.log(`  ${ns}: ${list.join(', ')}`);

const dup = [...registered].filter(([, files]) => files.size > 1);
if (dup.length) {
  console.log('\n== Canales registrados en más de un archivo ==');
  for (const [ch, files] of dup) console.log(`  ${ch}: ${[...files].join(', ')}`);
}
console.log(`\n${registered.size} canales registrados, ${used.size} usados por la interfaz, ${missing} sin handler.`);
process.exit(missing ? 1 : 0);
