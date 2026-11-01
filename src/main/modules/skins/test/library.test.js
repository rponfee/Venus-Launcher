'use strict';
// Pruebas de la biblioteca local con una carpeta temporal: agregar, duplicados, renombrar, modelo,
// borrar, indice danado y archivos que faltan.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLibrary, cleanName, nameFromFile } = require('../library');
const { skinPng, skinImage, encodePng, setRect, solid } = require('./fixtures');

const fail = (code, vars) => Object.assign(new Error(`skins.${code}${vars ? ` ${JSON.stringify(vars)}` : ''}`), { code: `skins:${code}` });

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venus-skins-test-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('agrega una copia, adivina el modelo y la lista con su imagen', async () => {
  const dir = tempDir();
  let n = 0;
  const lib = createLibrary({ dir, fail, makeId: () => `skin0000${++n}`, now: () => 1000 + n });
  const slim = await lib.add(skinPng('slim'), { name: '  Mi   skin\u0007 fina ' });
  assert.equal(slim.duplicate, false);
  assert.equal(slim.item.name, 'Mi skin fina');
  assert.equal(slim.item.variant, 'slim', 'adivinada por los brazos');
  const legacy = await lib.add(skinPng('classic', 32), { name: 'Vieja', variant: 'slim' });
  assert.equal(legacy.item.variant, 'classic', 'las de 64x32 son siempre clasicas');
  assert.equal(legacy.item.legacy, true);
  const { items, max } = await lib.list();
  assert.equal(max, 100);
  assert.deepEqual(items.map((i) => i.name), ['Vieja', 'Mi skin fina'], 'la mas nueva primero');
  assert.match(items[0].image, /^data:image\/png;base64,/);
  assert.equal(items[0].broken, false);
  assert.ok(fs.existsSync(path.join(dir, 'skin00001.png')));
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  assert.equal(index.items.length, 2);
});

test('la misma imagen no se guarda dos veces (aunque este comprimida distinto)', async () => {
  const dir = tempDir();
  const lib = createLibrary({ dir, fail });
  const a = await lib.add(encodePng({ ...skinImage('classic'), filter: 0 }), { name: 'A' });
  const b = await lib.add(encodePng({ ...skinImage('classic'), filter: 4 }), { name: 'B' });
  assert.equal(b.duplicate, true);
  assert.equal(b.item.id, a.item.id);
  assert.equal((await lib.list()).items.length, 1);
});

test('rechaza lo que no es una skin', async () => {
  const dir = tempDir();
  const lib = createLibrary({ dir, fail });
  await assert.rejects(lib.add(Buffer.from('hola'), {}), { code: 'skins:invalidPng' });
  await assert.rejects(lib.add(encodePng(solid(32, 32)), {}), { code: 'skins:wrongSize' });
  await assert.rejects(lib.add(Buffer.concat([skinPng(), Buffer.alloc(65 * 1024)]), {}), { code: 'skins:tooBig' });
  await assert.rejects(lib.add('texto', {}), { code: 'skins:invalidPng' });
  assert.deepEqual((await lib.list()).items, []);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.png')), [], 'no quedan archivos sueltos');
});

test('limite de la biblioteca', async () => {
  const dir = tempDir();
  const lib = createLibrary({ dir, fail, maxItems: 2 });
  const img = (k) => encodePng(setRect(skinImage('classic'), 8, 8, 1, 1, [k, k, k, 255]));
  await lib.add(img(1), {});
  await lib.add(img(2), {});
  await assert.rejects(lib.add(img(3), {}), { code: 'skins:libraryFull' });
});

test('renombrar, cambiar el modelo y borrar', async () => {
  const dir = tempDir();
  const trashed = [];
  const lib = createLibrary({ dir, fail, trash: async (p) => trashed.push(p) && fs.rmSync(p) });
  const { item } = await lib.add(skinPng('classic'), { name: 'Uno' });
  const renamed = await lib.rename(item.id, 'Nombre nuevo');
  assert.equal(renamed.name, 'Nombre nuevo');
  await assert.rejects(lib.rename(item.id, '   '), { code: 'skins:badName' });
  await assert.rejects(lib.rename('noexiste1', 'x'), { code: 'skins:notFound' });
  assert.equal((await lib.setVariant(item.id, 'slim')).variant, 'slim');
  await assert.rejects(lib.setVariant(item.id, 'giant'), { code: 'skins:badVariant' });
  const old = await lib.add(skinPng('classic', 32), {});
  await assert.rejects(lib.setVariant(old.item.id, 'slim'), { code: 'skins:legacyVariant' });
  const read = await lib.read(item.id);
  assert.deepEqual(read.bytes, skinPng('classic'));
  await lib.remove(item.id);
  assert.equal(trashed.length, 1, 'a la papelera');
  assert.ok(trashed[0].endsWith(`${item.id}.png`));
  assert.deepEqual((await lib.list()).items.map((i) => i.id), [old.item.id]);
  await assert.rejects(lib.remove(item.id), { code: 'skins:notFound' });
  await assert.rejects(lib.read('../../etc'), { code: 'skins:notFound' });
});

test('si la papelera falla, el archivo se borra igual', async () => {
  const dir = tempDir();
  const lib = createLibrary({ dir, fail, trash: async () => Promise.reject(new Error('sin papelera')) });
  const { item } = await lib.add(skinPng('classic'), {});
  await lib.remove(item.id);
  assert.equal(fs.existsSync(path.join(dir, `${item.id}.png`)), false);
});

test('indice danado o con entradas raras, y archivos que faltan', async () => {
  const dir = tempDir();
  fs.writeFileSync(
    path.join(dir, 'index.json'),
    JSON.stringify({
      items: [
        { id: '../../evil', name: 'x', width: 64, height: 64 },
        { id: 'abcdefgh1', name: 'Bien', width: 64, height: 64, variant: 'slim' },
        { id: 'abcdefgh1', name: 'Repetida', width: 64, height: 64 },
        { id: 'abcdefgh2', name: 'Rara', width: 128, height: 128 },
        { id: 'abcdefgh3', name: 'Falta el archivo', width: 64, height: 32, variant: 'slim' },
      ],
    }),
  );
  fs.writeFileSync(path.join(dir, 'abcdefgh1.png'), skinPng('slim'));
  const lib = createLibrary({ dir, fail });
  const { items } = await lib.list();
  assert.deepEqual(items.map((i) => [i.id, i.broken, i.variant]), [
    ['abcdefgh1', false, 'slim'],
    ['abcdefgh3', true, 'classic'],
  ]);
  await assert.rejects(lib.read('abcdefgh3'), { code: 'skins:fileDamaged' });
  // un indice que no es JSON se trata como vacio (y no se pierde: writeJson lo aparta antes de pisarlo)
  const dir2 = tempDir();
  fs.writeFileSync(path.join(dir2, 'index.json'), '{ roto');
  const lib2 = createLibrary({ dir: dir2, fail });
  assert.deepEqual((await lib2.list()).items, []);
  await lib2.add(skinPng('classic'), {});
  assert.ok(fs.readdirSync(dir2).some((f) => f.startsWith('index.json.corrupt-')));
});

test('nombres', () => {
  assert.equal(cleanName('a'.repeat(80)).length, 40);
  assert.equal(cleanName('\u0000\u001f  '), '');
  assert.equal(nameFromFile('C:\\Users\\x\\Mi_Skin.PNG'), 'Mi Skin');
  assert.equal(nameFromFile('/home/x/otra.png'), 'otra');
});
