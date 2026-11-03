'use strict';
// Widget de rendimiento (3.1): forma de los datos, validacion del evento, ajustes del widget y el muestreo.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const perf = require('../perf');
const { validate } = require('../events');
const config = require('../config');

test('buildSample: MB redondeados, CPU con un decimal, ping entero y sesion en segundos', () => {
  const s = perf.buildSample({ mem: 2.5 * 1048576, cpu: 23.456, ping: 48.7, startedAt: 1000, now: 61000 });
  assert.deepEqual(s, { kind: 'perf', ram: 3, cpu: 23.5, ping: 49, session: 60 });
  const empty = perf.buildSample({ mem: null, cpu: -1, ping: undefined, startedAt: null, now: 5 });
  assert.deepEqual(empty, { kind: 'perf', ram: null, cpu: null, ping: null, session: null });
  assert.equal(perf.buildSample({ cpu: 250, startedAt: 10, now: 5 }).cpu, 100);
  assert.equal(perf.buildSample({ startedAt: 10, now: 5 }).session, 0);
});

test('lineas del ayudante de PowerShell', () => {
  assert.deepEqual(perf.parseHelperLine('{"ok":1,"mem":1073741824,"cpu10":125}'), { mem: 1073741824, cpu: 12.5 });
  assert.deepEqual(perf.parseHelperLine('{"ok":1,"mem":1024,"cpu10":-10}'), { mem: 1024, cpu: null });
  assert.deepEqual(perf.parseHelperLine('{"ok":1,"mem":1024,"cpu10":5000}'), { mem: 1024, cpu: 100 });
  assert.deepEqual(perf.parseHelperLine('{"end":1}'), { end: true });
  assert.equal(perf.parseHelperLine('{"ok":0}'), null);
  assert.equal(perf.parseHelperLine('basura'), null);
  const cmd = perf.command({ pid: 4242, parentPid: 7 });
  assert.equal(cmd.file, 'powershell.exe');
  assert.ok(cmd.args.includes('-NoProfile') && cmd.args.includes('-NonInteractive'));
  assert.equal(cmd.env.VENUS_GAME_PID, '4242');
  assert.equal(cmd.env.VENUS_PARENT_PID, '7');
  assert.ok(perf.SCRIPT.includes('Get-Process'));
});

test('evento perf del contrato 1: numeros acotados, null para lo que no se sabe', () => {
  assert.deepEqual(validate({ kind: 'perf', ram: 2048.6, cpu: 150, ping: 48, session: 100 }), { kind: 'perf', ram: 2049, cpu: 100, ping: 48, session: 100 });
  assert.deepEqual(validate({ kind: 'perf', ram: null, cpu: 'x', ping: -5, session: undefined }), { kind: 'perf', ram: null, cpu: null, ping: 0, session: null });
  assert.deepEqual(validate({ kind: 'perf', cpu: 12.345, extra: 1 }), { kind: 'perf', ram: null, cpu: 12.3, ping: null, session: null });
});

test('ajustes del widget perf: abajo a la izquierda, con las cuatro medidas', () => {
  const c = config.normalize(undefined);
  assert.ok(config.WIDGETS.includes('perf'));
  assert.equal(c.widgets.perf.anchor, 'bl');
  assert.deepEqual(c.widgets.perf.show, { ram: true, cpu: true, ping: true, session: true });
  const custom = config.normalize({ widgets: { perf: { enabled: false, show: { ping: false, fps: true } } } });
  assert.equal(custom.widgets.perf.enabled, false);
  assert.deepEqual(custom.widgets.perf.show, { ram: true, cpu: true, ping: false, session: true });
  assert.deepEqual(config.positionPatch('perf', { anchor: 'tc' }), { perf: { anchor: 'tc' } });
});

// Ayudante falso: un proceso con stdout que escribe lo que le pidamos.
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  return child;
}

test('muestreo en Windows: una muestra por linea del ayudante, con el ping del servidor actual', async () => {
  let clock = 100000;
  const child = fakeChild();
  const samples = [];
  const pings = [];
  const sampler = perf.createSampler({
    pid: 500,
    startedAt: clock - 30000,
    getAddress: () => 'mc.ejemplo.com',
    onSample: (s) => samples.push(s),
    platform: 'win32',
    spawnFn: () => child,
    pingFn: async (address) => {
      pings.push(address);
      return 42;
    },
    now: () => clock,
  });
  assert.ok(sampler);
  child.stdout.emit('data', '{"ok":1,"mem":2147483648,"cpu10":310}\n');
  assert.equal(samples.length, 1);
  assert.deepEqual(samples[0], { kind: 'perf', ram: 2048, cpu: 31, ping: null, session: 30 });
  await new Promise((r) => setImmediate(r)); // el ping se resolvio
  assert.deepEqual(pings, ['mc.ejemplo.com']);
  clock += 2000;
  child.stdout.emit('data', '{"ok":1,"mem":2147483648,"cpu10":280}\n');
  assert.equal(samples[1].ping, 42);
  assert.equal(samples[1].session, 32);
  assert.equal(pings.length, 1); // dentro de los 10 s no vuelve a medir
  clock += 10000;
  child.stdout.emit('data', '{"ok":1,"mem":1048576,"cpu10":-10}\n');
  await new Promise((r) => setImmediate(r));
  assert.equal(pings.length, 2);
  assert.equal(samples[2].cpu, null);
  assert.equal(samples[2].ram, 1);
  child.stdout.emit('data', '{"end":1}\n');
  assert.equal(child.killed, true);
  child.stdout.emit('data', '{"ok":1,"mem":1,"cpu10":1}\n');
  assert.equal(samples.length, 3); // parado: no hay mas muestras
});

test('muestreo con pidusage cuando no hay ayudante', async () => {
  const samples = [];
  const sampler = perf.createSampler({
    pid: 77,
    startedAt: Date.now() - 5000,
    getAddress: () => null,
    onSample: (s) => samples.push(s),
    platform: 'linux',
    usage: async () => ({ memory: 300 * 1048576, cpu: 40 }),
    interval: 5,
  });
  await new Promise((r) => setTimeout(r, 30));
  sampler.stop();
  assert.ok(samples.length >= 2, `muestras: ${samples.length}`);
  assert.equal(samples[0].ram, 300);
  assert.ok(samples[0].cpu !== null && samples[0].cpu <= 100);
  assert.equal(samples[0].ping, null);
  assert.ok(samples[0].session >= 5);
  assert.equal(perf.createSampler({ pid: 0 }), null);
});
