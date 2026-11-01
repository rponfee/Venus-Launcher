'use strict';
// Pruebas del paquete de recursos de Venus (sin Electron): formato segun el jar, frases sumadas a las del juego,
// activacion en options.txt sin tocar los paquetes del jugador, reescritura solo si cambia y quitarlo al apagarlo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const pack = require('../pack');
const options = require('../../modtranslate/options');

const dirs = [];
function tmpDir() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'venus-ingame-')));
  dirs.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function fakeJar(dir, { packVersion = { resource: 34, data: 48 }, splashes = 'Vanilla uno\nVanilla dos\n' } = {}) {
  const zip = new AdmZip();
  if (packVersion !== null) zip.addFile('version.json', Buffer.from(JSON.stringify({ id: '1.21.1', pack_version: packVersion })));
  if (splashes !== null) zip.addFile('assets/minecraft/texts/splashes.txt', Buffer.from(splashes));
  const file = path.join(dir, 'client.jar');
  zip.writeZip(file);
  return file;
}

const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

test('mergeSplashes suma las frases de Venus a las del juego (una de cada cuatro, aprox.)', () => {
  const vanilla = Array.from({ length: 300 }, (_, i) => `v${i}`).join('\n');
  const out = pack.mergeSplashes(vanilla, ['a', 'b', ' ', 'c']).trim().split('\n');
  const own = out.filter((l) => ['a', 'b', 'c'].includes(l)).length;
  assert.ok(out.includes('v0') && out.includes('v299'));
  assert.ok(own / out.length > 0.2 && own / out.length < 0.3, `proporcion ${own}/${out.length}`);
});

test('apply crea el paquete, lo activa despues de los integrados y antes de los del jugador', async () => {
  const dir = tmpDir();
  const jar = fakeJar(dir);
  fs.writeFileSync(path.join(dir, 'options.txt'), 'fov:0.0\nresourcePacks:["vanilla","fabric","file/Faithful.zip"]\nlang:es_ar\n');
  const r = await pack.apply({ instanceDir: dir, mcVersion: '1.21.1', jarPath: jar, splashes: ['¡Venus!'], description: 'Venus' });
  assert.equal(r.state, 'applied');
  assert.equal(r.written, true);
  const p = pack.packDir(dir);
  const meta = JSON.parse(read(p, 'pack.mcmeta'));
  assert.equal(meta.pack.pack_format, 34);
  assert.equal(meta.pack.description, 'Venus');
  assert.ok(fs.existsSync(path.join(p, 'assets/minecraft/textures/gui/title/mojangstudios.png')));
  assert.ok(fs.existsSync(path.join(p, 'assets/minecraft/textures/gui/title/edition.png')));
  assert.ok(fs.existsSync(path.join(p, 'pack.png')));
  const splashes = read(p, 'assets/minecraft/texts/splashes.txt');
  assert.match(splashes, /Vanilla uno/);
  assert.match(splashes, /¡Venus!/);
  const state = options.readState(read(dir, 'options.txt'), pack.PACK_ID);
  assert.deepEqual(state.packs, ['vanilla', 'fabric', pack.PACK_ID, 'file/Faithful.zip']);
  assert.equal(state.lang, 'es_ar');
  assert.match(read(dir, 'options.txt'), /^fov:0\.0$/m);
});

test('apply no reescribe el paquete si nada cambio, y si cambia el idioma de las frases si', async () => {
  const dir = tmpDir();
  const jar = fakeJar(dir);
  const opts = { instanceDir: dir, mcVersion: '1.21.1', jarPath: jar, splashes: ['uno'] };
  assert.equal((await pack.apply(opts)).written, true);
  assert.equal((await pack.apply(opts)).written, false);
  assert.equal((await pack.apply({ ...opts, splashes: ['dos'] })).written, true);
});

test('sin options.txt lo crea con vanilla y el paquete', async () => {
  const dir = tmpDir();
  await pack.apply({ instanceDir: dir, mcVersion: '1.20.1', jarPath: fakeJar(dir, { packVersion: 15 }) });
  assert.equal(read(dir, 'options.txt'), `resourcePacks:["vanilla","${pack.PACK_ID}"]\n`);
});

test('formato 1.21.9+ (mayor.menor) usa min_format y max_format', async () => {
  const dir = tmpDir();
  const jar = fakeJar(dir, { packVersion: { resource_major: 69, resource_minor: 0, data_major: 88, data_minor: 0 } });
  await pack.apply({ instanceDir: dir, mcVersion: '1.21.10', jarPath: jar });
  const meta = JSON.parse(read(pack.packDir(dir), 'pack.mcmeta'));
  assert.equal(meta.pack.min_format, 69);
  assert.ok(meta.pack.max_format >= 69);
});

test('si no se pueden leer las frases del juego no pisa las suyas', async () => {
  const dir = tmpDir();
  await pack.apply({ instanceDir: dir, mcVersion: '1.21.1', jarPath: fakeJar(dir, { splashes: null }), splashes: ['¡Venus!'] });
  assert.equal(fs.existsSync(path.join(pack.packDir(dir), 'assets/minecraft/texts/splashes.txt')), false);
});

test('sin jar usa la tabla de formatos', async () => {
  const dir = tmpDir();
  const r = await pack.apply({ instanceDir: dir, mcVersion: '1.20.1', jarPath: path.join(dir, 'no-existe.jar') });
  assert.equal(r.state, 'applied');
  assert.equal(JSON.parse(read(pack.packDir(dir), 'pack.mcmeta')).pack.pack_format, 15);
});

test('versiones anteriores a la 1.13 no se tocan', async () => {
  const dir = tmpDir();
  const r = await pack.apply({ instanceDir: dir, mcVersion: '1.12.2', jarPath: null });
  assert.equal(r.state, 'unsupported');
  assert.equal(fs.existsSync(path.join(dir, 'options.txt')), false);
  assert.equal(fs.existsSync(pack.packDir(dir)), false);
});

test('apagado: lo saca de options.txt y borra solo su carpeta', async () => {
  const dir = tmpDir();
  const jar = fakeJar(dir);
  fs.mkdirSync(path.join(dir, 'resourcepacks', 'Otro'), { recursive: true });
  await pack.apply({ instanceDir: dir, mcVersion: '1.21.1', jarPath: jar });
  const r = await pack.apply({ instanceDir: dir, mcVersion: '1.21.1', jarPath: jar, enabled: false });
  assert.equal(r.state, 'removed');
  assert.equal(fs.existsSync(pack.packDir(dir)), false);
  assert.ok(fs.existsSync(path.join(dir, 'resourcepacks', 'Otro')));
  assert.deepEqual(options.readState(read(dir, 'options.txt'), pack.PACK_ID).packs, ['vanilla']);
  assert.equal((await pack.apply({ instanceDir: dir, mcVersion: '1.21.1', jarPath: jar, enabled: false })).state, 'off');
});

test('apagado y sin nada creado: no crea options.txt', async () => {
  const dir = tmpDir();
  const r = await pack.apply({ instanceDir: dir, mcVersion: '1.21.1', jarPath: null, enabled: false });
  assert.equal(r.state, 'off');
  assert.equal(fs.existsSync(path.join(dir, 'options.txt')), false);
});
