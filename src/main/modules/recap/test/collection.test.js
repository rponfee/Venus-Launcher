'use strict';
// Pruebas del conteo de mods y mundos de las instancias (carpetas temporales, sin Electron).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanCollection, countMods, countWorlds } = require('../collection');

function tree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    if (content === null) fs.mkdirSync(full, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
  }
}

test('cuenta mods (activos y desactivados) y mundos con level.dat', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'venus-recap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  tree(root, {
    'uno/mods/a.jar': 'PK',
    'uno/mods/b.JAR.disabled': 'PK',
    'uno/mods/c.zip': 'PK',
    'uno/mods/d.litemod': 'PK',
    'uno/mods/leeme.txt': 'no',
    'uno/mods/carpeta.jar': null, // una carpeta no es un mod
    'uno/saves/Mundo 1/level.dat': 'x',
    'uno/saves/Mundo 2/level.dat': 'x',
    'uno/saves/Roto/region': null, // sin level.dat
    'uno/saves/suelto.txt': 'x',
    'dos/mods/e.jar': 'PK',
    'tres/venus-instance.json': '{}', // sin mods ni saves
  });
  const dirOf = (id) => {
    if (id === 'rota') throw new Error('id invalido');
    return path.join(root, id);
  };
  const res = await scanCollection([{ id: 'uno' }, { id: 'dos' }, { id: 'tres' }, { id: 'rota' }, null, { id: '' }], { dirOf });
  assert.equal(res.instances, 4);
  assert.equal(res.mods, 5);
  assert.equal(res.worlds, 2);
  assert.deepEqual(res.perInstance, { uno: { mods: 4, worlds: 2 }, dos: { mods: 1, worlds: 0 }, tres: { mods: 0, worlds: 0 } });
});

test('carpetas que no existen cuentan cero', async () => {
  const fsp = require('fs/promises');
  assert.equal(await countMods(fsp, path.join(os.tmpdir(), 'no-existe-venus-recap', 'mods')), 0);
  assert.equal(await countWorlds(fsp, path.join(os.tmpdir(), 'no-existe-venus-recap', 'saves')), 0);
  const empty = await scanCollection([], { dirOf: () => '' });
  assert.deepEqual(empty, { instances: 0, mods: 0, worlds: 0, perInstance: {} });
});
