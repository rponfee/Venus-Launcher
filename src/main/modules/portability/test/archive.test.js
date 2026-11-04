'use strict';
// Exportar e importar de verdad, con la carpeta de datos en un temporal: dos "PCs" que comparten el archivo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const paths = require('../../../core/paths');
const instances = require('../../../core/instances');
const servers = require('../../../core/servers');
const settings = require('../../../core/settings');
const zip = require('../../worlds/zip');
const archive = require('../archive');
const { BackupError } = require('../manifest');

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `venus-port-${name}-`));
const write = (file, content = 'x') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

// Una PC con una instancia completa, un mundo, capturas, un servidor y ajustes con cosas que no deben viajar.
async function makePc() {
  const root = tmp('pc');
  paths.setRoot(root);
  const inst = await instances.create({ name: 'Survival', mcVersion: '1.21.1', loader: 'fabric' });
  await instances.update(inst.id, { java: { path: 'C:\\malo.exe', args: '-javaagent:malo.jar' }, tags: ['Amigos'], mcimport: { dir: `${root}\\oficial` } });
  const d = inst.dir;
  write(path.join(d, 'mods', 'sodium.jar'), 'jar');
  write(path.join(d, 'mods', 'malo.exe'), 'exe');
  write(path.join(d, 'config', 'sodium.json'), JSON.stringify({ path: root, ok: 1 }));
  write(path.join(d, 'config', 'discord', 'token.json'), '{"token":"secreto"}');
  write(path.join(d, 'config', 'x.toml'), 'apiKey = "secreto2"\nname = "ok"\n');
  write(path.join(d, 'options.txt'), 'fov:0\n');
  write(path.join(d, 'logs', 'latest.log'), 'registro');
  write(path.join(d, 'crash-reports', 'a.txt'), 'crash');
  write(path.join(d, '.venus', 'prepared.json'), '{}');
  write(path.join(d, 'cache', 'x.bin'), 'cache');
  write(path.join(d, 'usercache.json'), '[]');
  write(path.join(d, 'saves', 'Mundo', 'level.dat'), 'nivel');
  write(path.join(d, 'saves', 'Mundo', 'session.lock'), 'lock');
  write(path.join(d, 'saves', 'Mundo', 'region', 'r.0.0.mca'), Buffer.alloc(3 * 1024 * 1024, 7));
  write(path.join(d, 'screenshots', '2026-01-01_10.00.00.png'), 'png');
  write(path.join(d, 'replay_videos', 'clip.mp4'), 'video');
  const sid = 'mi-server';
  const sd = paths.server(sid);
  write(path.join(sd, 'venus-server.json'), JSON.stringify({ id: sid, name: 'Mi Server', type: 'paper', mcVersion: '1.21.1', port: 25565, memory: { min: 1024, max: 2048 }, java: { path: 'C:\\malo.exe', args: '-x' }, flags: 'aikar', automation: { autostart: true }, installed: true, launch: { args: ['-javaagent:malo.jar'] } }));
  write(path.join(sd, 'paper.jar'), 'jar');
  write(path.join(sd, 'server.properties'), 'server-port=25565\nrcon.password=clave123\nmotd=hola\n');
  write(path.join(sd, 'plugins', 'p.jar'), 'plugin');
  write(path.join(sd, 'world', 'level.dat'), 'nivel');
  write(path.join(sd, 'logs', 'latest.log'), 'registro');
  write(path.join(sd, 'backups', 'a.zip'), 'copia');
  write(path.join(sd, 'forwarding.secret'), 'secreto3');
  await settings.set({ appearance: { accent: 'mars', background: 'image', bgFile: `${root}\\fondo.png` }, jvmArgs: '-javaagent:malo.jar', privacy: { autoUpdates: true }, decor: { particles: 'snow' }, nav: { iconPack: 'pixel' }, assistantMcp: { servers: [{ command: 'malo.exe' }] } });
  return { root, inst, sid };
}

const deps = () => ({ instances, servers, settings, appVersion: '3.2.0' });
const ALL = { instances: true, worlds: true, servers: true, settings: true, media: true };

test('ida y vuelta: filtrado, sin rutas ni secretos, renombres y nada que corra', async () => {
  const pc = await makePc();
  const dest = path.join(tmp('out'), 'todo.venusbackup');
  const plan = await archive.buildPlan(ALL, deps());
  const res = await archive.writeBackup(plan, dest);
  assert.ok(res.size > 0);
  assert.equal(res.skipped, 0);

  // Lo abre cualquier programa de ZIP
  const az = new AdmZip(dest);
  const names = az.getEntries().map((e) => e.entryName);
  assert.equal(names[0], 'manifest.json');
  const has = (x) => names.includes(x);
  assert.ok(has('instances/i1/files/mods/sodium.jar'));
  assert.ok(has('instances/i1/saves/Mundo/level.dat'));
  assert.ok(has('instances/i1/media/screenshots/2026-01-01_10.00.00.png'));
  assert.ok(has('instances/i1/media/replay_videos/clip.mp4'));
  assert.ok(has('servers/s1/files/plugins/p.jar'));
  assert.ok(has('settings/settings.json'));
  for (const bad of [/malo\.exe/, /token\.json/, /logs\//, /crash-reports/, /\.venus\//, /cache\//, /usercache/, /session\.lock/, /venus-instance\.json/, /venus-server\.json/, /paper\.jar/, /backups\//, /forwarding\.secret/]) {
    assert.ok(!names.some((n) => bad.test(n)), String(bad));
  }

  // Ningún texto del archivo menciona esta PC, ni trae secretos, ni tiene con qué ejecutar algo
  const texts = az.getEntries().filter((e) => /\.(json|toml|properties|txt)$/.test(e.entryName)).map((e) => az.readAsText(e)).join('\n');
  for (const bad of [pc.root, pc.root.replace(/\\/g, '/'), pc.root.replace(/\\/g, '\\\\'), os.homedir().replace(/\\/g, '\\\\'), 'secreto', 'clave123', 'javaagent', 'malo.exe', '"java"', 'assistantMcp', 'privacy']) {
    assert.ok(!texts.includes(bad), bad);
  }
  const meta = JSON.parse(az.readAsText('instances/i1/meta.json'));
  assert.equal(meta.name, 'Survival');
  assert.equal(meta.java, undefined);

  // Otra PC, vacía
  const other = tmp('otra');
  paths.setRoot(other);
  settings.set({}); // la caché de ajustes es del proceso: se escribe en la carpeta nueva
  const info = await archive.inspect(dest);
  assert.equal(info.manifest.instances[0].name, 'Survival');
  const done = await archive.importBackup(dest, ALL, { instances, servers, settings, game: { status: () => ({}) } });
  assert.equal(done.instances.length, 1);
  assert.equal(done.worlds.length, 1);
  assert.equal(done.servers.length, 1);
  assert.equal(done.settings, true);

  const got = await instances.get(done.instances[0].id);
  assert.equal(got.name, 'Survival');
  assert.equal(got.installed, false);
  assert.deepEqual(got.java, { path: '', args: '' }, 'el Java de la otra PC no viaja');
  assert.deepEqual(got.tags, ['Amigos']);
  assert.ok(fs.existsSync(path.join(got.dir, 'mods', 'sodium.jar')));
  assert.ok(!fs.existsSync(path.join(got.dir, 'mods', 'malo.exe')));
  assert.equal(fs.statSync(path.join(got.dir, 'saves', 'Mundo', 'region', 'r.0.0.mca')).size, 3 * 1024 * 1024);
  assert.ok(fs.existsSync(path.join(got.dir, 'screenshots', '2026-01-01_10.00.00.png')));
  assert.ok(fs.existsSync(path.join(got.dir, 'replay_videos', 'clip.mp4')));
  assert.ok(!JSON.parse(fs.readFileSync(path.join(got.dir, 'config', 'sodium.json'), 'utf8')).path.includes(path.basename(pc.root)), 'la ruta se fue de la configuración');
  assert.match(fs.readFileSync(path.join(got.dir, 'config', 'x.toml'), 'utf8'), /apiKey = ""/);

  const srv = await servers.get(done.servers[0].id);
  assert.equal(srv.installed, false);
  assert.equal(srv.launch, null);
  assert.deepEqual(srv.java, { path: '', args: '' });
  assert.equal(srv.automation.autostart, false);
  assert.ok(!fs.existsSync(path.join(srv.dir, 'paper.jar')), 'el .jar se baja de su fuente');
  assert.match(fs.readFileSync(path.join(srv.dir, 'server.properties'), 'utf8'), /rcon\.password=\r?\n/);

  const s = await settings.get();
  assert.equal(s.appearance.accent, 'mars');
  assert.equal(s.appearance.background, 'stars');
  assert.equal(s.decor.particles, 'snow');
  assert.equal(s.jvmArgs, '-javaagent:malo.jar'.length ? s.jvmArgs : ''); // no se cambia por el archivo
  assert.ok(fs.readdirSync(paths.data('')).some((n) => n.startsWith('settings-before-import-')), 'lo de antes queda guardado');
  assert.deepEqual(fs.readdirSync(archive.STAGING()), [], 'sin temporales');

  // Otra vez: nada se pisa, todo entra con otro nombre
  write(path.join(got.dir, 'mods', 'sodium.jar'), 'modificado');
  const again = await archive.importBackup(dest, ALL, { instances, servers, settings, game: { status: () => ({}) } });
  assert.equal(again.instances[0].name, 'Survival (2)');
  assert.equal(again.instances[0].renamedFrom, 'Survival');
  assert.notEqual(again.instances[0].id, got.id);
  assert.equal(fs.readFileSync(path.join(got.dir, 'mods', 'sodium.jar'), 'utf8'), 'modificado');
  assert.equal(again.servers[0].name, 'Mi Server (2)');

  // Solo mundos: entran en la instancia que coincide, con otro nombre si ya está
  const worldsOnly = await archive.importBackup(dest, { worlds: true }, { instances, servers, settings, game: { status: () => ({}) } });
  assert.equal(worldsOnly.instances.length, 0);
  assert.equal(worldsOnly.worlds[0].instanceId, got.id);
  assert.equal(worldsOnly.worlds[0].folder, 'Mundo (2)');
  assert.equal(worldsOnly.worlds[0].renamedFrom, 'Mundo');
  assert.ok(fs.existsSync(path.join(got.dir, 'saves', 'Mundo', 'level.dat')));
});

test('solo lo elegido entra, y la instancia con el juego abierto no se toca', async () => {
  await makePc();
  const dest = path.join(tmp('out'), 'mundos.venusbackup');
  const plan = await archive.buildPlan({ worlds: true }, deps());
  await archive.writeBackup(plan, dest);
  const names = new AdmZip(dest).getEntries().map((e) => e.entryName);
  assert.ok(names.some((n) => n.startsWith('instances/i1/saves/')));
  assert.ok(!names.some((n) => n.includes('/files/') || n.includes('/media/') || n.startsWith('servers/') || n.startsWith('settings/')));

  const running = await archive.importBackup(dest, { worlds: true }, { instances, servers, settings, game: { status: () => Object.fromEntries((fs.readdirSync(paths.instances())).map((id) => [id, { state: 'running' }])) } });
  assert.equal(running.worlds.length, 0);
  assert.equal(running.skipped[0].reason, 'gameRunning');
});

test('cancelar: no deja el .part al exportar ni nada a medias al importar', async () => {
  await makePc();
  const dir = tmp('out');
  const dest = path.join(dir, 'x.venusbackup');
  const ac = new AbortController();
  ac.abort(new Error('Cancelado por el usuario'));
  const plan = await archive.buildPlan(ALL, deps());
  await assert.rejects(archive.writeBackup(plan, dest, { signal: ac.signal }), /Cancelado/);
  assert.deepEqual(fs.readdirSync(dir), []);

  await archive.writeBackup(plan, dest);
  const other = tmp('otra');
  paths.setRoot(other);
  const before = fs.readdirSync(paths.instances());
  await assert.rejects(archive.importBackup(dest, ALL, { instances, servers, settings, game: { status: () => ({}) }, signal: ac.signal }));
  assert.deepEqual(fs.readdirSync(paths.instances()), before);
  assert.deepEqual(fs.readdirSync(paths.servers()), []);
  assert.deepEqual(fs.readdirSync(archive.STAGING()), []);
});

// Un .venusbackup a mano con lo que se le quiera poner
async function craft(file, entries) {
  await zip.zipFiles(entries.map(([rel, data]) => ({ rel, data: Buffer.from(data) })), file);
}

test('importar un archivo malicioso: se rechaza entero antes de escribir nada', async () => {
  const root = tmp('pc');
  paths.setRoot(root);
  const dir = tmp('mal');
  const manifest = JSON.stringify({ format: 'venusbackup', version: 1, instances: [{ key: 'i1', name: 'Mala', mcVersion: '1.21.1', loader: 'vanilla', content: { files: 1, bytes: 1 } }], servers: [] });
  const code = (expected) => (err) => err instanceof BackupError && err.code === expected;
  const bad = async (name, entries, expected) => {
    const f = path.join(dir, name);
    await craft(f, entries);
    await assert.rejects(archive.importBackup(f, ALL, { instances, servers, settings }), code(expected), name);
    assert.deepEqual(fs.readdirSync(paths.instances()), [], name);
    assert.ok(!fs.existsSync(path.join(root, 'evil.txt')));
    assert.ok(!fs.existsSync(path.join(path.dirname(root), 'evil.txt')));
  };
  await bad('slip.venusbackup', [['manifest.json', manifest], ['instances/i1/meta.json', '{}'], ['instances/i1/files/../../../../evil.txt', 'x']], 'badPath');
  await bad('raiz.venusbackup', [['manifest.json', manifest], ['../evil.txt', 'x']], 'badPath');
  await bad('interno.venusbackup', [['manifest.json', manifest], ['instances/i1/files/.venus/prepared.json', '{}']], 'badPath');
  await bad('nada.venusbackup', [['otra.txt', 'x']], 'notBackup');
  await bad('futuro.venusbackup', [['manifest.json', JSON.stringify({ format: 'venusbackup', version: 999 })]], 'newerVersion');
  await bad('roto.venusbackup', [['manifest.json', '{ esto no es json']], 'badManifest');
  const junk = path.join(dir, 'basura.venusbackup');
  fs.writeFileSync(junk, 'no soy un zip');
  await assert.rejects(archive.importBackup(junk, ALL, { instances, servers, settings }), code('badFile'));
});

test('un meta.json con java.path o una ruta en el nombre no llega a la instancia', async () => {
  const root = tmp('pc');
  paths.setRoot(root);
  const f = path.join(tmp('mal'), 'java.venusbackup');
  const manifest = JSON.stringify({ format: 'venusbackup', version: 1, instances: [{ key: 'i1', name: 'Mala', mcVersion: '1.21.1', loader: 'vanilla', content: { files: 1, bytes: 1 } }], servers: [] });
  await craft(f, [['manifest.json', manifest], ['instances/i1/meta.json', JSON.stringify({ name: 'Mala', mcVersion: '1.21.1', loader: 'vanilla', java: { path: 'C:\\malo.exe', args: '-javaagent:malo.jar' }, versionId: 'x', installed: true, launchHook: 'calc.exe' })], ['instances/i1/files/mods/a.jar', 'jar'], ['instances/i1/files/mods/malo.bat', 'bat']]);
  const res = await archive.importBackup(f, { instances: true }, { instances, servers, settings, game: { status: () => ({}) } });
  const got = await instances.get(res.instances[0].id);
  assert.deepEqual(got.java, { path: '', args: '' });
  assert.equal(got.installed, false);
  assert.equal(got.versionId, null);
  assert.equal(got.launchHook, undefined);
  assert.ok(fs.existsSync(path.join(got.dir, 'mods', 'a.jar')));
  assert.ok(!fs.existsSync(path.join(got.dir, 'mods', 'malo.bat')));
});

test('sin espacio: avisa cuánto hace falta y no escribe nada', async () => {
  const root = tmp('pc');
  paths.setRoot(root);
  const orig = fs.promises.statfs;
  fs.promises.statfs = async () => ({ bavail: 1, bsize: 1 });
  try {
    const f = path.join(tmp('mal'), 'grande.venusbackup');
    const manifest = JSON.stringify({ format: 'venusbackup', version: 1, instances: [{ key: 'i1', name: 'A', mcVersion: '1.21.1', loader: 'vanilla', content: { files: 1, bytes: 5000 } }], servers: [] });
    await craft(f, [['manifest.json', manifest], ['instances/i1/meta.json', '{}'], ['instances/i1/files/a.bin', 'x'.repeat(5000)]]);
    await assert.rejects(archive.importBackup(f, { instances: true }, { instances, servers, settings }), (err) => err.code === 'noSpace' && err.needed === 5002 && err.free === 1);
    assert.deepEqual(fs.readdirSync(paths.instances()), []);
  } finally {
    fs.promises.statfs = orig;
  }
});

test('ZIP64: más de 65.535 archivos se escriben y se leen bien', async () => {
  const dir = tmp('big');
  const file = path.join(dir, 'muchos.venusbackup');
  const list = Array.from({ length: 66000 }, (_, i) => ({ rel: `f/${i}`, data: Buffer.from('x') }));
  await zip.zipFiles(list, file);
  const entries = await zip.readEntries(file);
  assert.equal(entries.length, 66000);
  assert.equal(entries[65999].name, 'f/65999');
  assert.equal(entries[65999].size, 1);
});

test('una entrada que se infla más de lo que declara no llena la memoria', async () => {
  const dir = tmp('bomb');
  const file = path.join(dir, 'b.zip');
  await zip.zipFiles([{ rel: 'a.bin', data: Buffer.alloc(1024 * 1024, 0) }], file);
  const [e] = await zip.readEntries(file);
  await assert.rejects(zip.extract(file, path.join(dir, 'out'), { entries: [{ ...e, size: 10 }] }));
});
