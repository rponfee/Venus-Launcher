'use strict';
// El cálculo usa entradas normales ya validadas, sin crear ni extraer archivos.
const test = require('node:test');
const assert = require('node:assert/strict');
const { neededBytes, normalizeSelection } = require('../archive');
const { validateManifest, validateEntries } = require('../manifest');

function fixture() {
  const manifest = validateManifest({
    format: 'venusbackup', version: 1, settings: true,
    instances: [{ key: 'i1', content: { files: 1, bytes: 30 }, worlds: [{ folder: 'Demo', files: 1, bytes: 40 }], media: { files: 1, bytes: 50 } }],
    servers: [{ key: 's1', content: { files: 1, bytes: 70 } }],
  });
  const entries = [
    ['manifest.json', 100], ['instances/i1/meta.json', 20], ['instances/i1/files/options.txt', 30],
    ['instances/i1/saves/Demo/level.dat', 40], ['instances/i1/media/screenshots/demo.png', 50],
    ['servers/s1/meta.json', 60], ['servers/s1/files/server.properties', 70], ['settings/settings.json', 80],
  ].map(([name, size]) => ({ name, size, compressedSize: size, method: 0, dir: false }));
  return { manifest, list: validateEntries(entries, manifest).list };
}

test('el espacio incluye los metadatos una sola vez y los ajustes seleccionados', () => {
  const { manifest, list } = fixture();
  assert.equal(neededBytes(manifest, normalizeSelection({ instances: true, worlds: true, media: true, servers: true, settings: true }), list), 350);
  assert.equal(neededBytes(manifest, normalizeSelection({ settings: true }), list), 80);
  assert.equal(neededBytes(manifest, normalizeSelection({}), list), 0);
});

test('el cálculo de espacio acompaña a la selección de mundos y servidores', () => {
  const { manifest, list } = fixture();
  assert.equal(neededBytes(manifest, normalizeSelection({ worlds: true }), list), 60);
  assert.equal(neededBytes(manifest, normalizeSelection({ servers: true }), list), 130);
});

test('los contadores informativos no cambian los bytes de las entradas seleccionadas', () => {
  const { manifest, list } = fixture();
  const options = normalizeSelection({ instances: true, worlds: true, servers: true, media: true });
  const expected = neededBytes(manifest, options, list);
  manifest.instances[0].content.bytes = 0;
  manifest.instances[0].worlds[0].bytes = 0;
  manifest.instances[0].media.bytes = 0;
  manifest.servers[0].content.bytes = 0;
  assert.equal(neededBytes(manifest, options, list), expected);
});
