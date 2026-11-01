'use strict';
// Pruebas del plan de importacion: carpeta compartida, destino del contenido, nombres y validacion de la seleccion.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPlan, normalizeSelection, uniqueName, safeFolderName, defaultTarget, targetCandidates } = require('../plan');
const { scanFolder } = require('../scan');
const { buildMinecraft, tmpDir, MANIFEST, NOW } = require('./fixture');

const names = { latestRelease: (v) => `Minecraft ${v}`, latestSnapshot: (v) => `Snapshot ${v}`, unnamed: (l, v) => `${l} ${v}` };

async function fakeScan() {
  const fx = buildMinecraft();
  return scanFolder(fx.root, { venusRoot: tmpDir('venus-'), manifest: MANIFEST, now: NOW, names, checkLocks: false });
}

const id = (scan, key) => scan.profiles.find((p) => p.key === key).id;
const rootGroup = (scan) => scan.groups.find((g) => g.isRoot);

test('el contenido compartido va una sola vez: por defecto al perfil con mods usado mas reciente', async () => {
  const scan = await fakeScan();
  const plan = buildPlan(scan, { profiles: [id(scan, 'aaaa1111'), id(scan, 'bbbb2222'), id(scan, 'cccc3333')] });
  assert.equal(plan.instances.length, 3);
  const [fabric, vanilla, forge] = plan.instances;
  assert.equal(fabric.name, 'Fabric 1.21.1');
  assert.deepEqual(fabric.copies.map((c) => c.dest).sort(), ['mods', 'options.txt', 'resourcepacks', 'saves/World A', 'saves/World B', 'servers.dat']);
  assert.equal(vanilla.copies.length, 0, 'el perfil vanilla comparte la carpeta: su contenido ya va al de Fabric');
  assert.deepEqual(forge.copies.map((c) => c.dest).sort(), ['config', 'mods', 'options.txt', 'saves/Forge World']);
  assert.equal(plan.worlds, 3);
  assert.ok(plan.bytes > 9000);
});

test('el tamanio del plan es la suma exacta de lo elegido', async () => {
  const scan = await fakeScan();
  const main = rootGroup(scan);
  const forge = scan.groups.find((g) => !g.isRoot);
  const plan = buildPlan(scan, { profiles: [id(scan, 'bbbb2222'), id(scan, 'cccc3333')] });
  const sum = (g, cats) => cats.reduce((a, c) => a + g.content[c].bytes, 0);
  const expected = sum(main, ['worlds', 'mods', 'resourcepacks', 'options', 'servers']) + sum(forge, ['worlds', 'mods', 'config', 'options']);
  assert.equal(plan.bytes, expected);
  assert.equal(plan.instances.reduce((a, x) => a + x.bytes, 0), plan.bytes);
  // Elegir un solo mundo resta el resto
  const one = buildPlan(scan, { profiles: [id(scan, 'bbbb2222')], groups: { [main.id]: { target: id(scan, 'bbbb2222'), categories: { worlds: ['World B'] } } } });
  const worldB = main.content.worlds.items.find((w) => w.folder === 'World B').bytes;
  assert.equal(one.bytes, worldB + sum(main, ['mods', 'resourcepacks', 'options', 'servers']));
  assert.equal(one.worlds, 1);
});

test('sin mods en el destino elegido, los mods y la configuracion no se copian', async () => {
  const scan = await fakeScan();
  const main = rootGroup(scan);
  const plan = buildPlan(scan, { profiles: [id(scan, 'aaaa1111'), id(scan, 'bbbb2222')], groups: { [main.id]: { target: id(scan, 'aaaa1111'), categories: { mods: true, config: true, shaderpacks: true } } } });
  const vanilla = plan.instances.find((x) => x.profileKey === 'aaaa1111');
  assert.equal(vanilla.copies.some((c) => c.category === 'mods'), false);
  assert.ok(vanilla.copies.some((c) => c.category === 'worlds'));
});

test('solo perfil vanilla: el contenido va a el y los mods quedan afuera', async () => {
  const scan = await fakeScan();
  const plan = buildPlan(scan, { profiles: [id(scan, 'aaaa1111')] });
  assert.deepEqual(plan.instances[0].copies.map((c) => c.category).sort(), ['options', 'resourcepacks', 'servers', 'worlds', 'worlds']);
});

test('elegir mundos uno por uno y apagar categorias', async () => {
  const scan = await fakeScan();
  const main = rootGroup(scan);
  const plan = buildPlan(scan, {
    profiles: [id(scan, 'bbbb2222')],
    groups: { [main.id]: { target: id(scan, 'bbbb2222'), categories: { worlds: ['World B', 'No existe', '../../etc'], mods: false, servers: false } } },
  });
  assert.deepEqual(plan.instances[0].copies.map((c) => c.dest).sort(), ['options.txt', 'resourcepacks', 'saves/World B']);
});

test('un destino que no usa la carpeta se ignora y vuelve el de por defecto', async () => {
  const scan = await fakeScan();
  const main = rootGroup(scan);
  const plan = buildPlan(scan, { profiles: [id(scan, 'bbbb2222'), id(scan, 'cccc3333')], groups: { [main.id]: { target: id(scan, 'cccc3333') } } });
  const forge = plan.instances.find((x) => x.profileKey === 'cccc3333');
  assert.equal(forge.copies.some((c) => c.dest === 'saves/World A'), false);
  assert.ok(plan.instances.find((x) => x.profileKey === 'bbbb2222').copies.some((c) => c.dest === 'saves/World A'));
});

test('selecciones invalidas', async () => {
  const scan = await fakeScan();
  assert.deepEqual(buildPlan(scan, { profiles: [] }), { error: 'nothing' });
  assert.deepEqual(buildPlan(scan, { profiles: ['o:no-existe'] }), { error: 'changed' });
  assert.deepEqual(buildPlan(scan, null), { error: 'nothing' });
  assert.deepEqual(buildPlan(scan, { profiles: 'o:x' }), { error: 'nothing' });
  const sel = normalizeSelection({ profiles: [1, 'o:a', 'o:a'], groups: { 'no-hex': {}, abcdef012345: { target: 5, categories: { mods: 'si', worlds: 'todos', evil: true } } } });
  assert.deepEqual(sel, { dir: null, profiles: ['o:a'], groups: { abcdef012345: { target: null, categories: { mods: false, worlds: false } } } });
});

test('nombres unicos: nunca se pisa una instancia existente', () => {
  const taken = new Set(['fabric 1.21.1', 'fabric 1.21.1 (2)']);
  assert.equal(uniqueName('Fabric 1.21.1', taken), 'Fabric 1.21.1 (3)');
  assert.equal(uniqueName('Fabric 1.21.1', taken), 'Fabric 1.21.1 (4)');
  assert.equal(uniqueName('x'.repeat(80), new Set(['x'.repeat(60)])).length, 60);
});

test('los nombres de instancia del lote tampoco se repiten entre si', async () => {
  const scan = await fakeScan();
  const plan = buildPlan(scan, { profiles: [id(scan, 'aaaa1111'), id(scan, 'bbbb2222')] }, { existingNames: ['Minecraft 1.21.1'] });
  assert.deepEqual(plan.instances.map((x) => x.name).sort(), ['Fabric 1.21.1', 'Minecraft 1.21.1 (2)']);
});

test('carpetas de mundos con nombres que Windows no acepta', () => {
  assert.equal(safeFolderName('Mi mundo'), 'Mi mundo');
  assert.equal(safeFolderName('mundo.'), 'mundo');
  assert.equal(safeFolderName('CON'), '_CON');
  assert.equal(safeFolderName('a:b*c'), 'a_b_c');
  assert.equal(safeFolderName('..'), 'world');
  assert.equal(safeFolderName('mundo  '), 'mundo');
  assert.equal(safeFolderName(''), 'world');
});

test('destino por defecto sin mods: el usado mas reciente', () => {
  const g = { profileIds: ['a', 'b'], content: { mods: { count: 0 } } };
  const sel = [{ id: 'a', lastUsed: 1, suggestedName: 'A', modded: true }, { id: 'b', lastUsed: 5, suggestedName: 'B', modded: false }];
  const c = targetCandidates(g, sel);
  assert.equal(defaultTarget(g, c).id, 'b');
  assert.equal(defaultTarget({ ...g, content: { mods: { count: 3 } } }, c).id, 'a');
  assert.equal(defaultTarget(g, []), null);
});
