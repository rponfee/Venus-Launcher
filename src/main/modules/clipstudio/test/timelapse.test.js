'use strict';
// Timelapse: planificacion, tope de espacio y el controlador con dependencias falsas.
const test = require('node:test');
const assert = require('node:assert/strict');
const logic = require('../timelapse-logic');
const { createTimelapse } = require('../timelapse');

test('ajustes: apagado por defecto y solo valores de la lista', () => {
  assert.deepEqual(logic.normalizeConfig(null), { enabled: false, every: 30, capMb: 1024 });
  assert.deepEqual(logic.normalizeConfig({ enabled: 'si', every: 7, capMb: 3 }), { enabled: false, every: 30, capMb: 1024 });
  assert.deepEqual(logic.normalizeConfig({ enabled: true, every: 5, capMb: 256 }), { enabled: true, every: 5, capMb: 256 });
});

test('carpeta segun lo que se juega: nunca en el menu y nunca fuera de la carpeta', () => {
  assert.equal(logic.folderForActivity(null), null);
  assert.equal(logic.folderForActivity({ type: 'menu' }), null);
  assert.equal(logic.folderForActivity({ type: 'singleplayer', world: null }), null);
  assert.equal(logic.folderForActivity({ type: 'singleplayer', world: 'Mi mundo' }), 'Mi mundo');
  assert.equal(logic.folderForActivity({ type: 'singleplayer', world: 'Mi mundo', quiet: true }), null);
  assert.equal(logic.folderForActivity({ type: 'server', address: 'play.example.com:25566' }), 'server_play.example.com_25566');
  assert.equal(logic.safeFolder('..\\..\\Windows'), '_.._Windows');
  assert.equal(logic.safeFolder('../../etc/x'), '_.._etc_x');
  assert.equal(logic.safeFolder('con'), '_con');
  assert.equal(logic.safeFolder('   . '), '');
  assert.equal(logic.safeFolder('nombre.'), 'nombre');
});

test('validFolder solo acepta un nombre ya seguro de un solo segmento', () => {
  assert.equal(logic.validFolder('Mi mundo'), true);
  for (const bad of ['', '..', '../x', 'a/b', 'a\\b', 'x:y', '.oculta', 'aux', null, 3]) assert.equal(logic.validFolder(bad), false, String(bad));
});

test('cuando sacar la proxima imagen', () => {
  const base = { now: 100000, lastAt: 0, everyMs: 30000, used: 0, capBytes: 1e9, free: 1e11, folder: 'Mundo', busy: false };
  assert.equal(logic.decide(base).action, 'capture');
  assert.deepEqual(logic.decide({ ...base, lastAt: 90000 }), { action: 'wait', delay: 20000 });
  assert.equal(logic.decide({ ...base, busy: true }).action, 'wait');
  assert.equal(logic.decide({ ...base, folder: null }).action, 'wait', 'en el menu no');
  assert.equal(logic.decide({ ...base, used: 1e9 }).action, 'full');
  assert.equal(logic.decide({ ...base, used: 1e9 - logic.FRAME_ESTIMATE + 1 }).action, 'full', 'la proxima imagen no entra');
  assert.equal(logic.decide({ ...base, used: 1e9 - logic.FRAME_ESTIMATE }).action, 'capture');
  assert.equal(logic.decide({ ...base, free: logic.DISK_MARGIN }).action, 'noDisk');
  assert.equal(logic.decide({ ...base, free: null }).action, 'capture', 'si no se sabe el lugar libre, sigue');
});

test('cuadro negro o ventana minimizada', () => {
  assert.equal(logic.isBlankFrame(9000, 1920, 1080), true);
  assert.equal(logic.isBlankFrame(180000, 1920, 1080), false);
  assert.equal(logic.isBlankFrame(0, 0, 0), true);
});

test('resumen de una carpeta: solo imagenes con el nombre esperado y en orden', () => {
  const sum = logic.summarize('Mundo', [
    { name: '2026-11-03_18.03.09.jpg', size: 10 },
    { name: 'notas.txt', size: 500 },
    { name: '2026-11-03_18.02.09.jpg', size: 20 },
    { name: '2026-11-03_18.03.09-2.jpg', size: 30 },
  ]);
  assert.deepEqual(sum, { folder: 'Mundo', count: 3, bytes: 60, first: '2026-11-03_18.02.09.jpg', last: '2026-11-03_18.03.09.jpg' });
});

// Un controlador con todo falso. now se adelanta a mano.
function rig(over = {}) {
  const st = { now: 1000000, used: 0, free: 1e12, activity: { type: 'singleplayer', world: 'Mundo' }, writes: [], grabs: 0, notices: [], events: [], config: { enabled: true, every: 10, capMb: 256 }, shot: { data: new Uint8Array(200000), width: 1920, height: 1080 } };
  const tl = createTimelapse({
    now: () => st.now,
    grab: async () => {
      st.grabs += 1;
      if (st.grabError) throw st.grabError;
      return st.shot;
    },
    activityOf: () => st.activity,
    config: async () => st.config,
    usage: async () => st.used,
    freeBytes: async () => st.free,
    write: async (id, folder, stamp, data) => {
      st.writes.push({ id, folder, stamp, size: data.byteLength });
    },
    stamp: () => '2026-11-03_18.00.00',
    notify: (key) => st.notices.push(key),
    emit: (v) => st.events.push(v),
    ...over,
  });
  return { st, tl };
}

test('saca una imagen cada N segundos, solo con un mundo abierto', async () => {
  const { st, tl } = rig();
  await tl.start('inst');
  assert.equal(tl.view().active, true);
  assert.equal((await tl.tick()).action, 'captured');
  assert.equal(st.writes.length, 1);
  assert.equal(st.writes[0].folder, 'Mundo');
  assert.equal((await tl.tick()).action, 'wait', 'todavia no pasaron 10 s');
  st.now += 10000;
  await tl.tick();
  assert.equal(st.writes.length, 2);
  // En el menu no saca nada
  st.activity = { type: 'menu' };
  st.now += 60000;
  assert.equal((await tl.tick()).action, 'wait');
  assert.equal(st.grabs, 2);
  tl.stop('inst');
  assert.equal(tl.view().active, false);
  assert.equal(await tl.tick(), null);
});

test('apagado no hace nada', async () => {
  const { st, tl } = rig();
  st.config = { enabled: false };
  await tl.start('inst');
  assert.equal(tl.view().active, false);
  assert.equal(await tl.tick(), null);
  assert.equal(st.grabs, 0);
});

test('al llegar al tope para y avisa una sola vez', async () => {
  const { st, tl } = rig();
  st.config = { enabled: true, every: 5, capMb: 256 };
  st.used = 256 * 1048576 - logic.FRAME_ESTIMATE - 1000;
  await tl.start('inst');
  // Entra una mas: despues ya no
  assert.equal((await tl.tick()).action, 'captured');
  st.now += 5000;
  assert.equal((await tl.tick()).action, 'full');
  assert.deepEqual(st.notices, ['timelapseFull']);
  assert.equal(tl.view().stopped, 'full');
  assert.equal(tl.view().active, false);
  st.now += 5000;
  assert.equal(await tl.tick(), null);
  assert.equal(st.notices.length, 1);
});

test('sin lugar en el disco para y avisa', async () => {
  const { st, tl } = rig();
  st.free = 1024;
  await tl.start('inst');
  assert.equal((await tl.tick()).action, 'noDisk');
  assert.deepEqual(st.notices, ['timelapseNoDisk']);
});

test('un cuadro negro no se guarda y una falla de captura no corta nada', async () => {
  const { st, tl } = rig();
  await tl.start('inst');
  st.shot = { data: new Uint8Array(500), width: 1920, height: 1080 };
  assert.equal((await tl.tick()).action, 'skip');
  assert.equal(st.writes.length, 0);
  st.now += 10000;
  st.grabError = Object.assign(new Error('sin ventana'), { code: 'noWindow' });
  assert.equal((await tl.tick()).action, 'skip');
  assert.equal(tl.view().active, true);
  st.grabError = null;
  st.shot = { data: new Uint8Array(200000), width: 1920, height: 1080 };
  st.now += 10000;
  assert.equal((await tl.tick()).action, 'captured');
  // Disco lleno al escribir: para
  const full = rig({
    write: async () => {
      throw Object.assign(new Error('lleno'), { code: 'ENOSPC' });
    },
  });
  await full.tl.start('inst');
  assert.equal((await full.tl.tick()).action, 'skip');
  assert.equal(full.tl.view().stopped, 'noDisk');
});

test('no se pisan dos capturas al mismo tiempo', async () => {
  let release;
  const { st, tl } = rig({
    grab: () =>
      new Promise((resolve) => {
        release = () => resolve({ data: new Uint8Array(200000), width: 1920, height: 1080 });
      }),
  });
  await tl.start('inst');
  const first = tl.tick();
  await new Promise((r) => setImmediate(r));
  st.now += 60000;
  assert.equal(await tl.tick(), null, 'la segunda no empieza mientras corre la primera');
  release();
  assert.equal((await first).action, 'captured');
  assert.equal(st.writes.length, 1);
  tl.stop();
});


const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('detener durante la lectura de ajustes no inicia una captura despues', async () => {
  const pending = deferred();
  const { tl } = rig({ config: () => pending.promise });
  const start = tl.start('inst');
  tl.stop('inst');
  pending.resolve({ enabled: true });
  await start;
  assert.equal(tl.view().active, false);
  tl.stop();
});

test('dos inicios superpuestos conservan la ultima instancia solicitada', async () => {
  const pending = deferred();
  const { tl } = rig({ usage: id => id === 'anterior' ? pending.promise : Promise.resolve(0) });
  const first = tl.start('anterior');
  await new Promise(r => setImmediate(r));
  await tl.start('ultima');
  pending.resolve(0);
  await first;
  assert.equal(tl.view().instanceId, 'ultima');
  tl.stop();
});

test('una consulta de disco tardia no captura ni detiene la nueva sesion', async () => {
  const pending = deferred();
  const { tl, st } = rig({ freeBytes: () => pending.promise });
  await tl.start('anterior');
  const tick = tl.tick();
  await tl.start('ultima');
  pending.resolve(0);
  assert.equal((await tick).action, 'skip');
  assert.equal(tl.view().active, true);
  assert.equal(st.grabs, 0);
  assert.equal(st.notices.length, 0);
  tl.stop();
});

test('salir del mundo mientras llega la imagen no la guarda en el mundo anterior', async () => {
  const pending = deferred();
  const { tl, st } = rig({ grab: () => pending.promise });
  await tl.start('inst');
  const tick = tl.tick();
  await new Promise(r => setImmediate(r));
  st.activity = { type: 'menu' };
  pending.resolve(st.shot);
  assert.equal((await tick).action, 'skip');
  assert.equal(st.writes.length, 0);
  tl.stop();
});

test('el limite de espacio tambien comprueba el tamaño real de la imagen', async () => {
  const { tl, st } = rig();
  st.used = 256 * 1048576 - logic.FRAME_ESTIMATE;
  st.shot.data = new Uint8Array(logic.FRAME_ESTIMATE + 1);
  await tl.start('inst');
  assert.equal((await tl.tick()).action, 'full');
  assert.equal(st.writes.length, 0);
  assert.deepEqual(st.notices, ['timelapseFull']);
  tl.stop();
});
