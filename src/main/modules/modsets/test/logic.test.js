'use strict';
// Sets de mods: plan, renombrados, dependencias y aplicar y deshacer de verdad sobre una carpeta temporal.
// node --test "src/main/modules/modsets/test/"
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const logic = require('../logic');

const file = (name, enabled = true, extra = {}) => ({ file: enabled ? name : `${name}.disabled`, name, enabled, title: null, project: null, ...extra });
const setOf = (entries) => ({ id: 's1', name: 'Set', entries });

test('normalizeSet y normalizeStore descartan lo que no sirve', () => {
  assert.equal(logic.normalizeSet({ name: '   ' }), null);
  assert.equal(logic.normalizeSet(null), null);
  const set = logic.normalizeSet({
    name: `  ${'a'.repeat(60)} <b> `,
    template: 'inventada',
    entries: [
      { file: 'ok.jar', on: true },
      { file: 'ok.jar.disabled', on: false },
      { file: 'OK.JAR', on: true },
      { file: '../../fuera.jar', on: true },
      { file: 'C:\\x.jar', on: true },
      { file: 'texto.txt', on: true },
      { file: 42, on: true },
      null,
      { file: 'p.jar', project: 'modrinth:AANobbMI', on: 'si' },
      { file: 'q.jar', project: 'otra:cosa', on: true },
    ],
  });
  assert.equal(Array.from(set.name).length, 40);
  assert.equal(set.template, null);
  assert.deepEqual(set.entries, [
    { file: 'ok.jar', project: null, on: true },
    { file: 'p.jar', project: 'modrinth:AANobbMI', on: false },
    { file: 'q.jar', project: null, on: true },
  ]);
  const store = logic.normalizeStore({ sets: [{ id: 'a', name: 'Uno' }, { id: 'a', name: 'Repetido' }, { name: '' }], lastApply: { snapshotId: 123 } });
  assert.equal(store.sets.length, 1);
  assert.equal(store.lastApply, null);
  assert.deepEqual(logic.normalizeStore('roto'), { version: 1, sets: [], lastApply: null });
});

test('planApply: prende y apaga, y lo desconocido queda como estaba', () => {
  const files = [file('a.jar'), file('b.jar', false), file('c.jar'), file('nuevo.jar'), file('nuevo2.jar', false)];
  const plan = logic.planApply(setOf([{ file: 'a.jar', on: false }, { file: 'b.jar', on: true }, { file: 'c.jar', on: true }, { file: 'borrado.jar', on: true }, { file: 'viejo.jar', on: false }]), files);
  assert.deepEqual(plan.renames, [{ from: 'a.jar', to: 'a.jar.disabled' }, { from: 'b.jar.disabled', to: 'b.jar' }]);
  assert.deepEqual(plan.enable, ['b.jar']);
  assert.deepEqual(plan.disable, ['a.jar']);
  assert.deepEqual(plan.same, ['c.jar']);
  assert.deepEqual(plan.unknown, ['nuevo.jar', 'nuevo2.jar']);
  assert.deepEqual(plan.missing, ['borrado.jar'], 'solo avisa lo que tenía que quedar prendido');
});

test('planApply: reconoce un mod actualizado por su proyecto', () => {
  const files = [file('sodium-2.jar', true, { project: 'modrinth:AANobbMI' })];
  const plan = logic.planApply(setOf([{ file: 'sodium-1.jar', project: 'modrinth:AANobbMI', on: false }]), files);
  assert.deepEqual(plan.renames, [{ from: 'sodium-2.jar', to: 'sodium-2.jar.disabled' }]);
  assert.deepEqual(plan.missing, []);
});

test('planApply: si conviven x.jar y x.jar.disabled no se elige uno a ciegas', () => {
  const files = [{ file: 'x.jar', name: 'x.jar', enabled: true }, { file: 'x.jar.disabled', name: 'x.jar', enabled: false }];
  const off = logic.planApply(setOf([{ file: 'x.jar', on: false }]), files);
  assert.deepEqual(off.conflicts, ['x.jar']);
  assert.deepEqual(off.renames, []);
  const on = logic.planApply(setOf([{ file: 'x.jar', on: true }]), files);
  assert.deepEqual(on.conflicts, ['x.jar']);
  assert.deepEqual(on.renames, []);
});

test('activeAfter: lo del set, y lo desconocido como está ahora', () => {
  const files = [file('a.jar'), file('b.jar', false), file('nuevo.jar'), file('nuevo2.jar', false), file('sodium-2.jar', false, { project: 'modrinth:AANobbMI' })];
  const entries = [{ file: 'a.jar', on: false }, { file: 'b.jar', on: true }, { file: 'sodium-1.jar', project: 'modrinth:AANobbMI', on: true }];
  assert.deepEqual(logic.activeAfter(entries, files), ['b.jar', 'nuevo.jar', 'sodium-2.jar']);
});

test('plantillas: arrancan con los mods de ese estilo y el resto apagado', () => {
  const files = [file('sodium-fabric.jar'), file('iris-mc1.21.jar'), file('keystrokes.jar'), file('create-1.0.jar'), file('algo.jar', true, { title: 'OK Zoomer' })];
  const pick = (id) => logic.templateEntries(id, files).filter((e) => e.on).map((e) => e.file);
  assert.deepEqual(pick('pvp'), ['sodium-fabric.jar', 'keystrokes.jar', 'algo.jar']);
  assert.deepEqual(pick('shaders'), ['sodium-fabric.jar', 'iris-mc1.21.jar']);
  assert.deepEqual(pick('lite'), ['sodium-fabric.jar']);
  assert.deepEqual(logic.templateEntries('nada', files), []);
  assert.equal(logic.templateEntries('pvp', files).length, files.length, 'recuerda todos los mods, prendidos o no');
});

test('entriesFromFiles guarda lo activo o la lista pedida', () => {
  const files = [file('a.jar'), file('b.jar', false)];
  assert.deepEqual(logic.entriesFromFiles(files).map((e) => [e.file, e.on]), [['a.jar', true], ['b.jar', false]]);
  assert.deepEqual(logic.entriesFromFiles(files, ['b.jar']).map((e) => [e.file, e.on]), [['a.jar', false], ['b.jar', true]]);
});

test('projectOf usa los registros de Modrinth y CurseForge', () => {
  const records = { modrinth: { AANobbMI: { file: 'sodium.jar' } }, curseforge: { 123: { file: 'jei.jar', folder: 'mods' }, 456: { file: 'pack.zip', folder: 'resourcepacks' } } };
  assert.equal(logic.projectOf(records, 'sodium.jar'), 'modrinth:AANobbMI');
  assert.equal(logic.projectOf(records, 'jei.jar'), 'curseforge:123');
  assert.equal(logic.projectOf(records, 'pack.zip'), null);
  assert.equal(logic.projectOf(records, 'otro.jar'), null);
});

test('missingDependencies: solo avisa lo que está en la carpeta y queda apagado', () => {
  const mods = [
    { name: 'create.jar', title: 'Create', mods: [{ id: 'create', depends: { flywheel: '*', minecraft: '1.20.1', fabricloader: '*', 'fabric-resource-loader-v0': '*' } }] },
    { name: 'flywheel.jar', title: 'Flywheel', mods: [{ id: 'flywheel' }] },
    { name: 'fabric-api.jar', title: 'Fabric API', mods: [{ id: 'fabric-api' }] },
    { name: 'jei.jar', title: 'JEI', mods: [{ id: 'jei', deps: [{ modId: 'forge', type: 'required' }, { modId: 'lib', type: 'required' }, { modId: 'extra', type: 'optional' }] }] },
    { name: 'lib.jar', title: 'Lib', mods: [{ id: 'otra', provides: ['lib'] }] },
    { name: 'extra.jar', title: 'Extra', mods: [{ id: 'extra' }] },
    { name: 'solo.jar', title: 'Solo', mods: [{ id: 'solo', depends: { 'no-esta-en-la-carpeta': '*' } }] },
  ];
  assert.deepEqual(logic.missingDependencies(mods, ['create.jar', 'flywheel.jar', 'fabric-api.jar']), [], 'con todo prendido no hay avisos');
  const off = logic.missingDependencies(mods, ['create.jar', 'jei.jar', 'solo.jar']);
  assert.deepEqual(off.map((x) => [x.title, x.providerTitle]), [['Create', 'Flywheel'], ['Create', 'Fabric API'], ['JEI', 'Lib']]);
  assert.deepEqual(logic.missingDependencies(mods, ['flywheel.jar']), [], 'lo que nadie prendido pide no importa');
  assert.deepEqual(logic.missingDependencies([], []), []);
});

function tempInstance(names) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'venus-modsets-'));
  fs.mkdirSync(path.join(root, 'mods'));
  for (const n of names) fs.writeFileSync(path.join(root, 'mods', n), n);
  return root;
}
const listing = (root) => fs.readdirSync(path.join(root, 'mods')).sort();

test('executeRenames: renombra de verdad y, si uno falla, vuelve todo atrás', async () => {
  const root = tempInstance(['a.jar', 'b.jar.disabled', 'c.jar']);
  try {
    const dir = path.join(root, 'mods');
    const renames = [{ from: 'a.jar', to: 'a.jar.disabled' }, { from: 'b.jar.disabled', to: 'b.jar' }];
    assert.equal(await logic.executeRenames(dir, renames), 2);
    assert.deepEqual(listing(root), ['a.jar.disabled', 'b.jar', 'c.jar']);

    let calls = 0;
    const flaky = async (from, to) => {
      if (++calls === 2) throw Object.assign(new Error('ocupado'), { code: 'EBUSY' });
      fs.renameSync(from, to);
    };
    await assert.rejects(
      () => logic.executeRenames(dir, [{ from: 'c.jar', to: 'c.jar.disabled' }, { from: 'b.jar', to: 'b.jar.disabled' }], { rename: flaky }),
      (err) => err.code === 'EBUSY' && err.failedFile === 'b.jar',
    );
    assert.deepEqual(listing(root), ['a.jar.disabled', 'b.jar', 'c.jar'], 'la carpeta queda como estaba');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Aplicar y deshacer completos: instancia y datos reales en una carpeta temporal, con el motor real de instantáneas.
test('aplicar un set y deshacer con una instantánea real', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'venus-modsets-full-'));
  const paths = require('../../../core/paths');
  paths.setRoot(root);
  const instances = require('../../../core/instances');
  const game = require('../../../core/game');
  const modsets = require('../../modsets');
  try {
    const inst = await instances.create({ name: 'Prueba de sets', mcVersion: '1.20.1', loader: 'fabric' });
    const mods = path.join(inst.dir, 'mods');
    fs.mkdirSync(mods, { recursive: true });
    for (const n of ['a.jar', 'b.jar', 'c.jar.disabled', 'nuevo.jar']) fs.writeFileSync(path.join(mods, n), `contenido de ${n}`);
    const dirOf = fs.readdirSync(mods).sort();
    assert.deepEqual(dirOf, ['a.jar', 'b.jar', 'c.jar.disabled', 'nuevo.jar']);

    // El set: a apagado, b prendido, c prendido; nuevo.jar no lo conoce.
    const storeFile = path.join(inst.dir, '.venus', 'modsets.json');
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    fs.writeFileSync(storeFile, JSON.stringify({ version: 1, sets: [{ id: 'pvp', name: 'PvP', entries: [{ file: 'a.jar', on: false }, { file: 'b.jar', on: true }, { file: 'c.jar', on: true }] }] }));

    const res = await modsets.applySet(inst.id, 'pvp', { reason: 'Antes de aplicar el set PvP' });
    assert.deepEqual(fs.readdirSync(mods).sort(), ['a.jar.disabled', 'b.jar', 'c.jar', 'nuevo.jar']);
    assert.deepEqual(res.enabled, ['c.jar']);
    assert.deepEqual(res.disabled, ['a.jar']);
    assert.deepEqual(res.unknown, ['nuevo.jar']);
    assert.ok(res.snapshotId, 'hay instantánea previa');
    const saved = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    assert.equal(saved.lastApply.snapshotId, res.snapshotId);

    await modsets.undoLast(inst.id);
    assert.deepEqual(fs.readdirSync(mods).sort(), ['a.jar', 'b.jar', 'c.jar.disabled', 'nuevo.jar'], 'deshacer deja todo como estaba');
    assert.equal(fs.readFileSync(path.join(mods, 'a.jar'), 'utf8'), 'contenido de a.jar');
    assert.equal(JSON.parse(fs.readFileSync(storeFile, 'utf8')).lastApply, null);

    await assert.rejects(() => modsets.undoLast(inst.id), (err) => err.code === 'noUndo');
    await assert.rejects(() => modsets.applySet(inst.id, 'inventado'), (err) => err.code === 'notFound');

    // Sin instantánea no se toca nada
    await assert.rejects(() => modsets.applySet(inst.id, 'pvp', {}, { snapshot: async () => { throw new Error('sin espacio'); } }), (err) => err.code === 'snapshotFailed');
    assert.deepEqual(fs.readdirSync(mods).sort(), ['a.jar', 'b.jar', 'c.jar.disabled', 'nuevo.jar']);

    // Con el juego corriendo no se aplica: withStoppedInstance es el mismo candado que usa game.start
    let inner = false;
    const held = game.withStoppedInstance(inst.id, async () => {
      inner = true;
      await assert.rejects(() => modsets.applySet(inst.id, 'pvp', {}, { snapshot: async () => ({ id: 'x' }) }), (err) => err.code === 'instanceBusy');
    });
    await held;
    assert.equal(inner, true);
  } finally {
    await new Promise((r) => setTimeout(r, 50));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
