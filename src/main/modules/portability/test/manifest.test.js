'use strict';
// Manifiesto y rutas de un .venusbackup: zip-slip, tamanios absurdos y archivos armados a mano.
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateManifest, parseEntryName, validateEntries, BackupError, VERSION } = require('../manifest');

const base = () => ({ format: 'venusbackup', version: VERSION, createdAt: 1, appVersion: '3.2.0', categories: ['instances'], instances: [{ key: 'i1', originalId: 'a', name: 'A', mcVersion: '1.21', loader: 'fabric', content: { files: 1, bytes: 1 }, worlds: [{ folder: 'Mundo', files: 1, bytes: 1 }], media: {} }], servers: [{ key: 's1', name: 'S', type: 'paper', mcVersion: '1.21', content: {} }], settings: true });
const code = (fn, expected) => assert.throws(fn, (err) => err instanceof BackupError && err.code === expected, expected);
const file = (name, size = 10, compressedSize = 5) => ({ name, size, compressedSize, method: 8, dir: name.endsWith('/') });

test('manifiesto: formato, versión y campos conocidos', () => {
  const m = validateManifest({ ...base(), nuevo: 'x', categories: ['instances', 'otra'] });
  assert.equal(m.format, 'venusbackup');
  assert.equal(m.nuevo, undefined);
  assert.deepEqual(m.categories, ['instances']);
  code(() => validateManifest(null), 'notBackup');
  code(() => validateManifest({ format: 'otro', version: 1 }), 'notBackup');
  code(() => validateManifest({ format: 'venusbackup' }), 'badManifest');
  code(() => validateManifest({ format: 'venusbackup', version: 0 }), 'badManifest');
  code(() => validateManifest({ format: 'venusbackup', version: VERSION + 1 }), 'newerVersion');
  code(() => validateManifest({ ...base(), instances: [{ key: '../x' }] }), 'badManifest');
  code(() => validateManifest({ ...base(), instances: [{ key: 'a' }, { key: 'a' }] }), 'badManifest');
});

test('manifiesto: un mundo con nombre de ruta se descarta y un nombre con ruta queda vacío', () => {
  const m = validateManifest({ ...base(), instances: [{ key: 'i1', name: 'C:\\Users\\ana', worlds: [{ folder: '../../afuera' }, { folder: 'bien' }, { folder: 'a/b' }] }] });
  assert.deepEqual(m.instances[0].worlds.map((w) => w.folder), ['bien']);
  assert.equal(m.instances[0].name, '');
});

test('zip-slip: ninguna de estas rutas pasa', () => {
  for (const name of [
    '../evil.txt',
    '../../evil.exe',
    'instances/i1/files/../../../evil',
    'instances/i1/saves/../../evil',
    'instances/../../evil',
    '..\\..\\evil',
    '/etc/passwd',
    'C:/Windows/evil.dll',
    'C:\\Windows\\evil.dll',
    '\\\\servidor\\x',
    'instances/i1/files/a/../../../b',
    'instances/i1/files/CON',
    'instances/i1/files/nul.txt',
    'instances/i1/files/x:stream',
    'instances/i1/files/a.',
    'instances/i1/files/a ',
    'instances/i1/files/./a',
    'instances/i1/files//a',
    'otra/carpeta/a',
    'evil.exe',
    'instances/x y/files/a',
    'instances/i1/otra/a',
    'servers/s1/saves/a',
    'servers/s1/media/a',
    'settings/otra.json',
    'instances/i1/meta.json/x',
    '',
  ]) {
    assert.equal(parseEntryName(name), null, name);
  }
});

test('archivos internos del launcher: nunca, ni con alias de Windows', () => {
  for (const name of ['instances/i1/files/venus-instance.json', 'instances/i1/files/VENUS-INSTANCE.JSON', 'instances/i1/files/.venus/prepared.json', 'instances/i1/files/.VENUS/x', 'instances/i1/files/VENUS-~1.JSO', 'servers/s1/files/venus-server.json', 'servers/s1/files/.venus/x']) {
    assert.equal(parseEntryName(name), null, name);
  }
});

test('rutas buenas', () => {
  assert.deepEqual(parseEntryName('manifest.json'), { area: 'manifest', kind: null });
  assert.deepEqual(parseEntryName('settings/settings.json'), { area: 'settings', kind: null });
  assert.equal(parseEntryName('instances/i1/meta.json').area, 'meta');
  assert.equal(parseEntryName('instances/i1/files/mods/a.jar').rel, 'mods/a.jar');
  const w = parseEntryName('instances/i1/saves/Mi Mundo/region/r.0.0.mca');
  assert.equal(w.area, 'saves');
  assert.equal(w.world, 'Mi Mundo');
  assert.equal(parseEntryName('instances/i1/media/screenshots/a.png').area, 'media');
  assert.equal(parseEntryName('servers/s1/files/world/level.dat').kind, 'server');
});

test('validateEntries rechaza el archivo entero por una sola ruta mala', () => {
  const m = validateManifest(base());
  code(() => validateEntries([file('manifest.json'), file('instances/i1/files/../../evil')], m), 'badPath');
  code(() => validateEntries([file('manifest.json'), file('instances/i9/files/a.txt')], m), 'badPath');
  code(() => validateEntries([file('manifest.json'), file('instances/i1/files/a.txt'), file('INSTANCES/i1/files/a.txt')], m), 'badPath');
  code(() => validateEntries([], m), 'notBackup');
  code(() => validateEntries([{ ...file('manifest.json'), encrypted: true }], m), 'badFile');
  code(() => validateEntries([{ ...file('manifest.json'), method: 12 }], m), 'badFile');
});

test('validateEntries: lo que nunca viaja no se escribe aunque venga', () => {
  const m = validateManifest(base());
  const res = validateEntries(
    [file('manifest.json'), file('instances/i1/meta.json'), file('instances/i1/files/mods/a.jar'), file('instances/i1/files/mods/malo.exe'), file('instances/i1/files/token.json'), file('instances/i1/files/logs/latest.log'), file('instances/i1/saves/Mundo/level.dat'), file('instances/i1/saves/Mundo/session.lock'), file('instances/i1/media/screenshots/a.png'), file('instances/i1/media/nada.bin'), file('instances/i1/media/mods/x.png'), file('servers/s1/files/server.jar'), file('servers/s1/files/plugins/p.jar')],
    m,
  );
  const names = res.list.map((x) => x.entry.name);
  assert.ok(names.includes('instances/i1/files/mods/a.jar'));
  assert.ok(names.includes('servers/s1/files/plugins/p.jar'));
  for (const bad of ['instances/i1/files/mods/malo.exe', 'instances/i1/files/token.json', 'instances/i1/files/logs/latest.log', 'instances/i1/saves/Mundo/session.lock', 'instances/i1/media/nada.bin', 'instances/i1/media/mods/x.png', 'servers/s1/files/server.jar']) assert.ok(!names.includes(bad), bad);
  assert.equal(res.dropped, 7);
});

test('tamaños absurdos: archivo enorme, muchísimas entradas, bomba de descompresión, manifiesto gigante', () => {
  const m = validateManifest(base());
  const GB = 1024 ** 3;
  code(() => validateEntries([file('manifest.json'), file('instances/i1/files/a.bin', 101 * GB, 100 * GB)], m), 'tooBig');
  code(() => validateEntries([file('manifest.json'), file('instances/i1/files/a.bin', 10 * GB, 1024)], m), 'tooBig');
  code(() => validateEntries([file('manifest.json', 17 * 1024 * 1024, 16 * 1024 * 1024)], m), 'tooBig');
  code(() => validateEntries([file('manifest.json'), file('instances/i1/meta.json', 3 * 1024 * 1024, 2 * 1024 * 1024)], m), 'tooBig');
  const many = Array.from({ length: 3000001 }, (_, i) => ({ name: `instances/i1/files/a${i}`, size: 1, compressedSize: 1, method: 0, dir: false }));
  code(() => validateEntries(many, m), 'tooBig');
  const sum = Array.from({ length: 10 }, (_, i) => file(`instances/i1/files/a${i}.bin`, 60 * GB, 50 * GB));
  code(() => validateEntries(sum, m), 'tooBig');
  // Un mundo plano comprime mucho pero no llega a mentir: pasa
  assert.ok(validateEntries([file('manifest.json'), file('instances/i1/files/flat.bin', 1 * GB, 2 * 1024 * 1024)], m).total > 0);
  code(() => validateEntries([file('manifest.json'), { ...file('instances/i1/files/a'), size: -1 }], m), 'badFile');
  code(() => validateEntries([file('manifest.json'), { ...file('instances/i1/files/a'), size: Number.MAX_SAFE_INTEGER + 2 }], m), 'badFile');
});
