'use strict';
// Capas de Venus: el interruptor de las capas ajenas llega a la config del mod y, prendido, el archivo queda como siempre.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const badgeMod = require('../badgemod');

const dirs = [];
function tmpDir() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'venus-capes-')));
  dirs.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

const SERVER = { url: 'https://example.supabase.co', anonKey: 'anon-publica' };
function setup() {
  const bundledDir = tmpDir();
  fs.writeFileSync(path.join(bundledDir, badgeMod.BUILDS[0].jar), 'jar-1');
  return { instanceDir: tmpDir(), bundledDir, loader: 'fabric', mcVersion: '1.21.1', enabled: true, server: SERVER };
}
const config = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'config', badgeMod.CONFIG_FILE), 'utf8'));

test('la config del mod dice showCapes: false solo si se apagaron las capas ajenas', async () => {
  const opts = setup();
  await badgeMod.apply(opts);
  assert.deepEqual(config(opts.instanceDir), SERVER);
  const off = await badgeMod.apply({ ...opts, showCapes: false });
  assert.equal(off.written, true);
  assert.deepEqual(config(opts.instanceDir), { ...SERVER, showCapes: false });
  const on = await badgeMod.apply({ ...opts, showCapes: true });
  assert.equal(on.written, true);
  assert.deepEqual(config(opts.instanceDir), SERVER);
});
