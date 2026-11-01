'use strict';
// Pruebas del escaneo de una carpeta .minecraft falsa: perfiles, carpetas compartidas, contenido y seguridad.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { scanFolder, quickDetect, sourceProblem, resolveGameDir, treeStats, defaultDirs } = require('../scan');
const { buildMinecraft, tmpDir, write, world, MANIFEST, NOW } = require('./fixture');

const names = { latestRelease: (v) => `Minecraft ${v}`, latestSnapshot: (v) => `Snapshot ${v}`, unnamed: (l, v) => `${l} ${v}` };

async function scanFake(extra = {}) {
  const fx = buildMinecraft();
  const venusRoot = tmpDir('venus-');
  const scan = await scanFolder(fx.root, { venusRoot, manifest: MANIFEST, now: NOW, names, checkLocks: false, ...extra });
  return { fx, venusRoot, scan };
}

test('perfiles, versiones y loaders de una carpeta real', async () => {
  const { scan } = await scanFake();
  assert.equal(scan.found, true);
  assert.deepEqual(scan.files.sort(), ['launcher_profiles.json', 'launcher_profiles_microsoft_store.json']);
  const byKey = Object.fromEntries(scan.profiles.map((p) => [p.key, p]));
  assert.deepEqual(byKey.aaaa1111.version, { ok: true, mcVersion: '1.21.1', loader: 'vanilla', loaderVersion: null });
  assert.equal(byKey.aaaa1111.suggestedName, 'Minecraft 1.21.1');
  assert.deepEqual(byKey.bbbb2222.version, { ok: true, mcVersion: '1.21.1', loader: 'fabric', loaderVersion: '0.16.5' });
  assert.equal(byKey.bbbb2222.selected, true);
  assert.equal(byKey.bbbb2222.modded, true);
  assert.deepEqual(byKey.cccc3333.version, { ok: true, mcVersion: '1.20.1', loader: 'forge', loaderVersion: '47.3.0' });
  assert.equal(byKey.dddd4444.version.mcVersion, '24w14a');
  assert.equal(byKey.dddd4444.lastUsed, 0);
  assert.equal(byKey.eeee5555.source, 'store');
  // Orden: usado mas reciente primero
  assert.deepEqual(scan.profiles.map((p) => p.key), ['bbbb2222', 'aaaa1111', 'cccc3333', 'eeee5555', 'dddd4444']);
});

test('carpeta compartida y carpeta propia: un grupo por carpeta con su contenido', async () => {
  const { scan, fx } = await scanFake();
  assert.equal(scan.groups.length, 2);
  const [main, forge] = scan.groups;
  assert.equal(main.isRoot, true);
  assert.equal(main.shared, true);
  assert.equal(main.label, '.minecraft');
  assert.equal(main.profileIds.length, 4);
  assert.equal(forge.label, 'profiles/forge');
  assert.equal(forge.dir, fs.realpathSync.native(fx.forgeDir));
  assert.deepEqual(forge.profileIds, ['o:cccc3333']);

  const c = main.content;
  assert.equal(c.worlds.count, 2, 'solo las carpetas con level.dat son mundos');
  assert.deepEqual(c.worlds.items.map((w) => [w.folder, w.name]), [['World A', 'Mi mundo'], ['World B', 'Creativo']]);
  assert.ok(c.worlds.items[0].bytes >= 4000);
  assert.equal(c.mods.count, 2, 'cuenta los .jar desactivados');
  assert.equal(c.mods.bytes, 500);
  assert.equal(c.resourcepacks.count, 1);
  assert.equal(c.shaderpacks.count, 0);
  assert.deepEqual(c.options.files, ['options.txt']);
  assert.equal(c.servers.count, 1);
  assert.equal(forge.content.worlds.count, 1);
  assert.equal(forge.content.config.count, 1);
  assert.equal(forge.content.mods.count, 1);
});

test('una carpeta vacia o que no es de Minecraft', async () => {
  const empty = tmpDir();
  const r = await scanFolder(empty, { venusRoot: tmpDir(), now: NOW });
  assert.equal(r.found, false);
  assert.equal(r.reason, 'notMinecraft');
  const missing = await scanFolder(path.join(empty, 'no-existe'), { venusRoot: tmpDir(), now: NOW });
  assert.equal(missing.reason, 'notFound');
});

test('sin archivo de perfiles pero con mundos: un perfil de la ultima version para traerlos', async () => {
  const root = path.join(tmpDir(), '.minecraft');
  world(root, 'Solo', 'Solo un mundo', NOW - 1000);
  write(path.join(root, 'launcher_profiles.json'), '{ roto');
  const r = await scanFolder(root, { venusRoot: tmpDir(), manifest: MANIFEST, now: NOW, names, checkLocks: false });
  assert.equal(r.found, true);
  assert.deepEqual(r.errors, [{ file: 'launcher_profiles.json', error: 'malformed' }]);
  assert.equal(r.profiles.length, 1);
  assert.equal(r.profiles[0].synthetic, true);
  assert.equal(r.profiles[0].version.mcVersion, '1.21.1');
  assert.equal(r.groups[0].content.worlds.count, 1);
});

test('ultima version sin manifest: sale de las versiones instaladas', async () => {
  const { scan } = await scanFake({ manifest: null });
  const latest = scan.profiles.find((p) => p.key === 'aaaa1111');
  assert.equal(latest.version.mcVersion, '1.21.1');
});

test('seguridad de las carpetas de los perfiles', () => {
  const venusRoot = path.resolve(tmpDir('venus-'));
  const env = { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' };
  const opts = { venusRoot, platform: process.platform, env, home: path.resolve(tmpDir('home-')) };
  assert.equal(sourceProblem('\\\\servidor\\juegos\\.minecraft', opts), 'network');
  assert.equal(sourceProblem('//servidor/juegos', opts), 'network');
  assert.equal(sourceProblem(path.parse(process.cwd()).root, opts), 'unsafe');
  assert.equal(sourceProblem(opts.home, opts), 'unsafe', 'la carpeta del usuario entera no');
  assert.equal(sourceProblem(path.join(venusRoot, 'instances', 'x'), opts), 'venus');
  assert.equal(sourceProblem(path.dirname(venusRoot), opts), 'venus', 'una carpeta que contiene los datos de Venus tampoco');
  if (process.platform === 'win32') assert.equal(sourceProblem('C:\\Windows\\System32', opts), 'unsafe');
  assert.equal(sourceProblem(path.join(opts.home, 'AppData', 'Roaming', '.minecraft'), opts), null);
  // Relativas contra la raiz; ".." se resuelve antes de validar
  const root = path.resolve(tmpDir(), '.minecraft');
  assert.equal(resolveGameDir(root, 'profiles/x'), path.join(root, 'profiles', 'x'));
  assert.equal(resolveGameDir(root, '../../..'), path.resolve(root, '../../..'));
  assert.equal(resolveGameDir(root, null), root);
});

test('un perfil con carpeta en un lugar prohibido se lista pero su contenido no se lee', async () => {
  const fx = buildMinecraft();
  const venusRoot = tmpDir('venus-');
  const file = path.join(fx.root, 'launcher_profiles.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.profiles.net1 = { name: 'En red', type: 'custom', lastVersionId: '1.21.1', gameDir: '\\\\servidor\\mc', lastUsed: new Date(NOW - 5000).toISOString() };
  data.profiles.venus1 = { name: 'Dentro de Venus', type: 'custom', lastVersionId: '1.21.1', gameDir: path.join(venusRoot, 'instances', 'x'), lastUsed: new Date(NOW - 6000).toISOString() };
  data.profiles.dots = { name: '../../../evil', type: 'custom', lastVersionId: '1.21.1', gameDir: path.join(fx.root, '..', '..'), lastUsed: new Date(NOW - 7000).toISOString() };
  fs.writeFileSync(file, JSON.stringify(data));
  const scan = await scanFolder(fx.root, { venusRoot, manifest: MANIFEST, now: NOW, names, checkLocks: false, home: path.join(fx.root, '..', '..') });
  const groupOf = (key) => scan.groups.find((g) => g.id === scan.profiles.find((p) => p.key === key).groupId);
  assert.equal(groupOf('net1').problem, 'network');
  assert.equal(groupOf('venus1').problem, 'venus');
  // La carpeta temporal es a la vez la "carpeta del usuario" de la prueba y la que contiene los datos de Venus
  assert.ok(['unsafe', 'venus'].includes(groupOf('dots').problem));
  for (const k of ['net1', 'venus1', 'dots']) assert.equal(groupOf(k).hasContent, false);
  assert.equal(scan.profiles.find((p) => p.key === 'dots').suggestedName, '../../../evil', 'el nombre es solo texto: la carpeta de la instancia la arma Venus');
});

test('enlaces simbolicos y uniones se saltean y se cuentan', async (t) => {
  const fx = buildMinecraft();
  const outside = tmpDir('afuera-');
  world(outside, 'Secreto', 'Mundo de afuera', NOW, 999);
  write(path.join(outside, 'secret.jar'), 'x');
  try {
    fs.symlinkSync(path.join(outside, 'saves', 'Secreto'), path.join(fx.root, 'saves', 'Enlace'), 'junction');
    fs.symlinkSync(outside, path.join(fx.root, 'mods', 'carpeta-enlazada'), 'junction');
  } catch (err) {
    t.skip(`no se pueden crear uniones aca: ${err.code}`);
    return;
  }
  const scan = await scanFolder(fx.root, { venusRoot: tmpDir(), manifest: MANIFEST, now: NOW, names, checkLocks: false });
  const main = scan.groups.find((g) => g.isRoot);
  assert.deepEqual(main.content.worlds.items.map((w) => w.folder), ['World A', 'World B']);
  assert.equal(main.content.mods.bytes, 500, 'lo de la carpeta enlazada no suma');
  assert.ok(scan.links >= 2);
});

test('recorrido: no sigue enlaces', async (t) => {
  const dir = tmpDir();
  write(path.join(dir, 'a.txt'), '12345');
  write(path.join(dir, 'sub', 'b.txt'), '123');
  const outside = tmpDir();
  write(path.join(outside, 'c.txt'), '1234567890');
  try {
    fs.symlinkSync(outside, path.join(dir, 'link'), 'junction');
  } catch {
    t.skip('sin uniones');
    return;
  }
  const r = await treeStats(dir);
  assert.deepEqual({ files: r.files, bytes: r.bytes, links: r.links }, { files: 2, bytes: 8, links: 1 });
});

test('deteccion rapida para la bienvenida', async () => {
  const fx = buildMinecraft();
  const r = await quickDetect(fx.root, { venusRoot: tmpDir(), now: NOW });
  assert.deepEqual({ found: r.found, profiles: r.profiles, worlds: r.worlds }, { found: true, profiles: 4, worlds: 2 });
  // Un launcher recien instalado (un perfil sin usar y sin mundos) no se sugiere
  const fresh = path.join(tmpDir(), '.minecraft');
  write(path.join(fresh, 'launcher_profiles.json'), JSON.stringify({ profiles: { a: { name: '', type: 'latest-release', lastVersionId: 'latest-release' } } }));
  assert.equal((await quickDetect(fresh, { venusRoot: tmpDir(), now: NOW })).found, false);
  assert.equal((await quickDetect(path.join(fresh, 'nada'), { venusRoot: tmpDir() })).found, false);
});

test('carpetas por defecto de cada sistema', () => {
  assert.deepEqual(defaultDirs({ platform: 'win32', env: { APPDATA: 'C:\\Users\\Ana\\AppData\\Roaming' }, home: 'C:\\Users\\Ana' }), [path.join('C:\\Users\\Ana\\AppData\\Roaming', '.minecraft')]);
  assert.deepEqual(defaultDirs({ platform: 'darwin', env: {}, home: '/Users/ana' }), [path.join('/Users/ana', 'Library', 'Application Support', 'minecraft')]);
  assert.deepEqual(defaultDirs({ platform: 'linux', env: {}, home: '/home/ana' }), [path.join('/home/ana', '.minecraft')]);
});

test('marca de importado: el perfil que ya se importo desde esta carpeta', async () => {
  const fx = buildMinecraft();
  const existing = [{ id: 'fabric-1-21-1', name: 'Fabric 1.21.1', mcimport: { dir: fs.realpathSync.native(fx.root), profile: 'bbbb2222' } }];
  const scan = await scanFolder(fx.root, { venusRoot: tmpDir(), manifest: MANIFEST, now: NOW, names, existing, checkLocks: false });
  assert.deepEqual(scan.profiles.find((p) => p.key === 'bbbb2222').imported, { instanceId: 'fabric-1-21-1', name: 'Fabric 1.21.1' });
  assert.equal(scan.profiles.find((p) => p.key === 'aaaa1111').imported, null);
});
