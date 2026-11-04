'use strict';
// Reglas de la cáscara: lo que guarda el service worker, la CSP, los textos usados y que nada dibuje HTML ajeno.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) walk(rel, out);
    else out.push(rel);
  }
  return out;
}

const shellList = () => {
  const m = /const SHELL = (\[[\s\S]*?\]);/.exec(read('sw.js'));
  return vm.runInNewContext(m[1]);
};

test('el service worker guarda toda la cáscara y nada de pruebas ni datos', () => {
  const shell = shellList();
  for (const file of shell) {
    if (file === './') continue;
    assert.ok(fs.existsSync(path.join(ROOT, file)), `falta ${file}`);
    assert.ok(!/^\.\/(dev|test)\//.test(file), file);
  }
  const code = walk('js').filter((f) => f.endsWith('.js')).map((f) => `./${f}`);
  for (const file of code) assert.ok(shell.includes(file), `${file} no está en la cáscara`);
  const html = read('index.html');
  for (const [, src] of html.matchAll(/(?:src|href)="((?:vendor|js|css|assets)[^"]+)"/g)) assert.ok(shell.includes(`./${src}`), `${src} no está en la cáscara`);
  const css = read('css/app.css');
  for (const [, font] of css.matchAll(/url\('\.\.\/(assets\/fonts\/[^']+)'\)/g)) assert.ok(shell.includes(`./${font}`), `${font} no está en la cáscara`);
});

test('el service worker no intercepta otros dominios ni cachea la API', () => {
  const sw = read('sw.js');
  assert.match(sw, /url\.origin !== self\.location\.origin\) return/);
  assert.match(sw, /request\.method !== 'GET'\) return/);
  assert.match(sw, /!shellUrls\.has\(/);
  assert.ok(!/supabase\.co/.test(sw));
  assert.equal([...sw.matchAll(/cache\.put\(/g)].length, 1);
  // Solo refreshShell escribe en la caché, y solo lo que cambió
  assert.ok(sw.includes("old?.headers.get('etag') !== tag"));
});

test('la CSP es estricta y es la misma en el HTML y en _headers', () => {
  const meta = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(read('index.html'))[1];
  const header = /Content-Security-Policy: (.+)/.exec(read('_headers'))[1];
  assert.equal(header, `${meta}; frame-ancestors 'none'`);
  assert.ok(!meta.includes('unsafe'), 'sin unsafe-inline ni unsafe-eval');
  assert.ok(meta.startsWith("default-src 'none'"));
  assert.match(meta, /script-src 'self';/);
  assert.match(meta, /base-uri 'none'/);
  const { url } = require('../js/shared/config.js');
  assert.ok(meta.includes(`connect-src 'self' ${url} ${url.replace('https:', 'wss:')}`), 'el proyecto de la CSP es el de la configuración');
  assert.ok(meta.includes(`media-src ${url};`));
  assert.ok(!/<script(?![^>]*\ssrc=)/.test(read('index.html')), 'sin scripts en línea');
  assert.ok(!/\sstyle=/.test(read('index.html')), 'sin estilos en línea');
});

test('solo la clave pública: nunca una service_role', () => {
  const { anonKey } = require('../js/shared/config.js');
  const payload = JSON.parse(Buffer.from(anonKey.split('.')[1], 'base64url').toString());
  assert.equal(payload.role, 'anon');
  for (const file of walk('.').filter((f) => /\.(js|html|json|webmanifest)$/.test(f) && !f.startsWith('vendor/') && !f.startsWith('test/'))) {
    assert.ok(!/service_role|SERVICE_ROLE|sb_secret_/.test(read(file)), file);
  }
});

test('ningún archivo arma HTML con texto ni evalúa código', () => {
  for (const file of walk('.').filter((f) => f.endsWith('.js') && !f.startsWith('vendor/') && !f.startsWith('test/'))) {
    const src = read(file).replace(/\/\/.*$/gm, '');
    assert.ok(!/\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|document\.write|\beval\(|new Function\(/.test(src), file);
    assert.ok(!/localStorage\.(get|set)Item|sessionStorage\.(get|set)Item/.test(src), `${file} guarda algo fuera de idb`);
  }
});

test('todos los textos que se usan existen', () => {
  const { dictionaries } = require('../js/shared/texts.js');
  const used = new Set();
  const sources = [...walk('js').filter((f) => f.endsWith('.js')), 'sw.js'];
  for (const file of sources) {
    for (const [, key] of read(file).matchAll(/\btr\('([a-z0-9_]+)'/g)) used.add(key);
    for (const [, key] of read(file).matchAll(/'((?:friends|push|clip|clips|err|auth|chat|verify|signup|reset|install)_[a-z0-9_]+)'/g)) used.add(key);
  }
  const ignore = new Set(['push_subscribe', 'push_unsubscribe', 'push_denied', 'push_unavailable', 'signup_disabled']); // RPC y códigos de error, no textos
  for (const key of used) {
    if (ignore.has(key)) continue;
    assert.ok(key in dictionaries.es, `falta el texto ${key}`);
  }
  for (const tab of ['received', 'mine', 'gallery']) assert.ok(`clips_tab_${tab}` in dictionaries.es);
  for (const p of ['online', 'away', 'busy', 'offline']) assert.ok(`presence_${p}` in dictionaries.es);
});

test('el manifiesto instala la app con los íconos que existen', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.equal(m.display, 'standalone');
  assert.equal(m.start_url, './');
  assert.equal(m.scope, './');
  for (const icon of m.icons) assert.ok(fs.existsSync(path.join(ROOT, icon.src)), icon.src);
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'));
  assert.ok(m.icons.some((i) => i.sizes === '512x512'));
});

test('el build de supabase-js y su licencia están en vendor', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'vendor/LICENSE-supabase-js.txt')));
  assert.ok(read('vendor/supabase.js').startsWith('var supabase='));
});

test('el almacén local borra todo al salir', async () => {
  const idb = require('../js/shared/idb.js');
  await idb.set('sb-prueba', 'x');
  await idb.storage.setItem('otra', 'y');
  assert.equal(await idb.get('sb-prueba'), 'x');
  assert.equal(await idb.storage.getItem('otra'), 'y');
  await idb.storage.removeItem('otra');
  assert.equal(await idb.get('otra'), null);
  await idb.clear();
  assert.equal(await idb.get('sb-prueba'), null);
});
