'use strict';
// Los canales de modules/mcimport.js con un contexto falso (sin Electron ni red): escanear la carpeta por defecto
// (VENUS_MC_DIR), carpetas no permitidas, dos pedidos de importar seguidos, resultado, aviso instances:changed y
// cancelar sin dejar instancias ni temporales. Lo que cambia (carpeta de datos, VENUS_MC_DIR, la consulta de
// procesos) se pone y se devuelve en before/after: con test/index.js todas las pruebas corren en un solo proceso.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const paths = require('../../../core/paths');
const running = require('../running');
const instances = require('../../../core/instances');
const mcimport = require('../../mcimport');
const { buildMinecraft, tmpDir, write, MANIFEST } = require('./fixture');

describe('canales de mcimport', () => {
  const venusRoot = tmpDir('venus-ipc-');
  const handlers = new Map();
  const sent = [];
  let fx;
  let prev;
  const call = (ch, ...args) => Promise.resolve().then(() => handlers.get(ch)(...args));
  const stagingLeft = () => {
    const dir = path.join(venusRoot, 'mcimport');
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.startsWith('staging-')) : [];
  };

  before(() => {
    let root = null;
    try {
      root = paths.root();
    } catch {
      /* sin carpeta todavia */
    }
    prev = { root, mcDir: process.env.VENUS_MC_DIR, gameDirsInUse: running.gameDirsInUse };
    paths.setRoot(venusRoot);
    write(paths.cache('version_manifest_v2.json'), JSON.stringify(MANIFEST)); // sin red: el manifest ya guardado
    fx = buildMinecraft();
    process.env.VENUS_MC_DIR = fx.root;
    running.gameDirsInUse = async () => []; // sin PowerShell: ningun Minecraft abierto
    mcimport.register({ handle: (ch, fn) => handlers.set(ch, fn), send: (ch, ...args) => sent.push([ch, ...args]), getWindow: () => null, onQuit: () => {} });
  });

  after(() => {
    running.gameDirsInUse = prev.gameDirsInUse;
    if (prev.mcDir === undefined) delete process.env.VENUS_MC_DIR;
    else process.env.VENUS_MC_DIR = prev.mcDir;
    if (prev.root) paths.setRoot(prev.root);
  });

  test('escanea la carpeta por defecto y rechaza las que no eligio el usuario', async () => {
    const scan = await call('mcimport:scan');
    assert.equal(scan.found, true);
    assert.equal(scan.isDefault, true);
    assert.equal(scan.dir, fs.realpathSync(fx.root));
    assert.ok(scan.profiles.length >= 4);
    assert.equal(scan.profiles[0].key, undefined, 'solo lo que dibuja el dialogo');
    await assert.rejects(call('mcimport:scan', path.dirname(fx.root)), (err) => err.code === 'notAllowed');
    await assert.rejects(call('mcimport:import', { dir: 'C:\\Windows', profiles: [] }), (err) => err.code === 'notAllowed');
    const detect = await call('mcimport:detect');
    assert.equal(detect.found, true);
  });

  test('dos pedidos de importar seguidos: el segundo es "busy" y el primero termina bien', async () => {
    const scan = await call('mcimport:scan');
    const fabric = scan.profiles.find((p) => p.name === 'Fabric 1.21.1');
    const before = (await instances.list()).length;
    sent.length = 0;
    const first = call('mcimport:import', { dir: scan.dir, profiles: [fabric.id] });
    const second = call('mcimport:import', { dir: scan.dir, profiles: [fabric.id] });
    await assert.rejects(second, (err) => err.code === 'busy');
    const r = await first;
    assert.equal(r.instances.length, 1);
    assert.equal(r.instances[0].loader, 'fabric');
    assert.equal(r.worlds, 2);
    assert.ok(r.bytes > 0);
    assert.equal((await instances.list()).length, before + 1);
    assert.ok(sent.some(([ch]) => ch === 'instances:changed'));
    assert.deepEqual(await call('mcimport:status'), { running: false, taskId: null });
    const inst = await instances.get(r.instances[0].id);
    assert.ok(fs.existsSync(path.join(inst.dir, 'saves', 'World A', 'level.dat')));
    assert.deepEqual(stagingLeft(), []);
  });

  test('nada elegido o perfiles que no existen: errores con codigo', async () => {
    const scan = await call('mcimport:scan');
    await assert.rejects(call('mcimport:import', { dir: scan.dir, profiles: [] }), (err) => err.code === 'nothing');
    await assert.rejects(call('mcimport:import', { dir: scan.dir, profiles: ['o:no-existe'] }), (err) => err.code === 'changed');
  });

  test('cancelar a mitad de la copia: codigo cancelled, sin instancias ni temporales', async () => {
    // Mundo con muchos archivos para que la copia dure lo suficiente
    for (let i = 0; i < 400; i++) write(path.join(fx.root, 'saves', 'World A', 'region', `r.${i}.1.mca`), Buffer.alloc(2048, i % 255));
    const scan = await call('mcimport:scan');
    const fabric = scan.profiles.find((p) => p.name === 'Fabric 1.21.1');
    const before = (await instances.list()).length;
    const job = call('mcimport:import', { dir: scan.dir, profiles: [fabric.id] });
    // Se cancela cuando ya hay algo en la carpeta temporal
    for (let i = 0; i < 400 && !stagingLeft().length; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(await call('mcimport:cancel'), true);
    await assert.rejects(job, (err) => err.code === 'cancelled');
    assert.equal((await instances.list()).length, before);
    assert.deepEqual(stagingLeft(), []);
    assert.equal(await call('mcimport:cancel'), false, 'sin importacion en curso no hay nada que cancelar');
  });
});
