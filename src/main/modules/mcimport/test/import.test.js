'use strict';
// Prueba de punta a punta: una .minecraft falsa se importa a una carpeta de datos de Venus temporal con el
// modulo de instancias real (sin Electron ni red). Tambien cancelar, mundo abierto, fallas y enlaces.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paths = require('../../../core/paths');
const { scanFolder } = require('../scan');
const { buildPlan } = require('../plan');
const { runPlan, cleanStaging, freeSpace } = require('../runner');
const { buildMinecraft, tmpDir, write, MANIFEST, NOW } = require('./fixture');

const venusRoot = tmpDir('venus-data-');
paths.setRoot(venusRoot);
const instances = require('../../../core/instances');

const names = { latestRelease: (v) => `Minecraft ${v}`, latestSnapshot: (v) => `Snapshot ${v}`, unnamed: (l, v) => `${l} ${v}` };
const stagingRoot = path.join(venusRoot, 'mcimport');

// Huella de una carpeta (rutas, tamanios y contenido): para comprobar que el origen no se toco.
function fingerprint(dir) {
  const h = crypto.createHash('sha1');
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, e.name);
      const r = `${rel}/${e.name}`;
      if (e.isSymbolicLink()) h.update(`L${r}`);
      else if (e.isDirectory()) walk(full, r);
      else {
        h.update(`F${r}:${fs.statSync(full).size}`);
        h.update(fs.readFileSync(full));
      }
    }
  };
  walk(dir, '');
  return h.digest('hex');
}

const deps = (extra = {}) => ({
  stagingRoot,
  venusRoot,
  createInstance: (o) => instances.create(o),
  markInstance: (id, meta) => instances.update(id, { mcimport: meta }),
  removeInstance: (id) => fs.promises.rm(instances.dir(id), { recursive: true, force: true }),
  checkLock: async () => false,
  ...extra,
});

async function setup() {
  const fx = buildMinecraft();
  const scan = await scanFolder(fx.root, { venusRoot, manifest: MANIFEST, now: NOW, names, checkLocks: false });
  const id = (key) => scan.profiles.find((p) => p.key === key).id;
  return { fx, scan, id };
}

const stagingLeft = () => (fs.existsSync(stagingRoot) ? fs.readdirSync(stagingRoot).filter((n) => n.startsWith('staging-')) : []);

test('importa tres perfiles con su contenido y no toca la carpeta original', async () => {
  const { fx, scan, id } = await setup();
  const before = fingerprint(fx.root);
  const existing = (await instances.list()).map((i) => i.name);
  const plan = buildPlan(scan, { profiles: [id('aaaa1111'), id('bbbb2222'), id('cccc3333')] }, { existingNames: existing });
  const progress = [];
  const r = await runPlan(plan, deps({ meta: { dir: scan.dir }, onProgress: (p) => progress.push(p) }));
  assert.equal(r.instances.length, 3);
  assert.equal(fingerprint(fx.root), before, 'la carpeta del launcher oficial queda igual');
  assert.deepEqual(stagingLeft(), [], 'no quedan temporales');
  assert.ok(progress.some((p) => p.phase === 'copy') && progress.some((p) => p.phase === 'create'));

  const fabric = await instances.get(r.instances.find((x) => x.profileId === id('bbbb2222')).id);
  assert.deepEqual([fabric.mcVersion, fabric.loader, fabric.loaderVersion], ['1.21.1', 'fabric', '0.16.5']);
  assert.equal(fabric.mcimport.profile, 'bbbb2222');
  assert.equal(fabric.mcimport.dir, scan.dir);
  const has = (inst, rel) => fs.existsSync(path.join(inst.dir, rel));
  for (const rel of ['saves/World A/level.dat', 'saves/World A/region/r.0.0.mca', 'saves/World B/level.dat', 'mods/sodium.jar', 'mods/lithium.jar.disabled', 'resourcepacks/Faithful.zip', 'options.txt', 'servers.dat']) {
    assert.ok(has(fabric, rel), `falta ${rel}`);
  }
  assert.equal(has(fabric, 'saves/World A/session.lock'), false, 'el session.lock no se copia');
  assert.equal(has(fabric, 'logs'), false);
  assert.equal(fs.readFileSync(path.join(fabric.dir, 'options.txt'), 'utf8'), 'lang:es_ar\nfov:0.5\n');

  const forge = await instances.get(r.instances.find((x) => x.profileId === id('cccc3333')).id);
  assert.deepEqual([forge.loader, forge.loaderVersion], ['forge', '47.3.0']);
  for (const rel of ['saves/Forge World/level.dat', 'mods/jei.jar', 'config/jei-client.toml', 'options.txt']) assert.ok(has(forge, rel), `falta ${rel}`);

  const vanilla = await instances.get(r.instances.find((x) => x.profileId === id('aaaa1111')).id);
  assert.deepEqual(fs.readdirSync(vanilla.dir), ['venus-instance.json'], 'la carpeta compartida ya fue a Fabric');

  // Al volver a escanear, los perfiles importados quedan marcados
  const again = await scanFolder(fx.root, { venusRoot, manifest: MANIFEST, now: NOW, names, checkLocks: false, existing: await instances.list() });
  assert.equal(again.profiles.find((p) => p.key === 'bbbb2222').imported.instanceId, fabric.id);

  // Y una segunda importacion no pisa nada: nombres "(2)"
  const plan2 = buildPlan(again, { profiles: [id('bbbb2222')] }, { existingNames: (await instances.list()).map((i) => i.name) });
  assert.equal(plan2.instances[0].name, 'Fabric 1.21.1 (2)');
});

test('cancelar a mitad de la copia no deja instancias ni temporales', async () => {
  const { scan, id } = await setup();
  const count = (await instances.list()).length;
  const plan = buildPlan(scan, { profiles: [id('bbbb2222'), id('cccc3333')] });
  const ctrl = new AbortController();
  let files = 0;
  await assert.rejects(
    runPlan(plan, deps({ signal: ctrl.signal, onProgress: (p) => p.phase === 'copy' && ++files === 3 && ctrl.abort(new Error('Cancelado por el usuario')) })),
    /Cancelado/,
  );
  assert.equal((await instances.list()).length, count);
  assert.deepEqual(stagingLeft(), []);
});

test('un mundo abierto en el juego frena la importacion antes de crear nada', async () => {
  const { scan, id } = await setup();
  const count = (await instances.list()).length;
  const plan = buildPlan(scan, { profiles: [id('bbbb2222')] });
  await assert.rejects(runPlan(plan, deps({ checkLock: async (file) => file.includes('World B') })), (err) => err.code === 'worldOpen' && err.world === 'Creativo');
  assert.equal((await instances.list()).length, count);
  assert.deepEqual(stagingLeft(), []);
});

test('si falla al crear la segunda instancia se borra la primera', async () => {
  const { scan, id } = await setup();
  const count = (await instances.list()).length;
  const plan = buildPlan(scan, { profiles: [id('bbbb2222'), id('cccc3333')] });
  let n = 0;
  const failing = deps({
    createInstance: async (o) => {
      if (++n === 2) throw new Error('disco lleno');
      return instances.create(o);
    },
  });
  await assert.rejects(runPlan(plan, failing), /disco lleno/);
  assert.equal((await instances.list()).length, count);
  assert.deepEqual(stagingLeft(), []);
});

test('los enlaces adentro de un mundo no se copian', async (t) => {
  const { fx } = await setup();
  const outside = tmpDir('afuera-');
  write(path.join(outside, 'secreto.txt'), 'no');
  try {
    fs.symlinkSync(outside, path.join(fx.root, 'saves', 'World A', 'enlace'), 'junction');
  } catch {
    t.skip('sin uniones');
    return;
  }
  const scan = await scanFolder(fx.root, { venusRoot, manifest: MANIFEST, now: NOW, names, checkLocks: false });
  const plan = buildPlan(scan, { profiles: [scan.profiles.find((p) => p.key === 'bbbb2222').id] });
  const r = await runPlan(plan, deps());
  const inst = await instances.get(r.instances[0].id);
  assert.equal(fs.existsSync(path.join(inst.dir, 'saves', 'World A', 'enlace')), false);
  assert.ok(r.stats.links >= 1);
});

test('limpieza de temporales viejos y espacio libre', async () => {
  fs.mkdirSync(path.join(stagingRoot, 'staging-viejo', '0'), { recursive: true });
  fs.mkdirSync(path.join(stagingRoot, 'otra-cosa'), { recursive: true });
  await cleanStaging(stagingRoot);
  assert.deepEqual(fs.readdirSync(stagingRoot).sort(), ['otra-cosa']);
  const free = await freeSpace(venusRoot);
  assert.ok(free === null || free > 0);
});
