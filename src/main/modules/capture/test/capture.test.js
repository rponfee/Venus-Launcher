'use strict';
// modules/capture.js con Electron, el juego, la grabadora y el disco simulados (capture-harness.js, cada escenario
// en un proceso aparte)
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const logic = require('../logic');

const GB = 1024 ** 3;

function run(scenario, platform = '') {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'capture-harness.js'), scenario, platform].filter(Boolean), { encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, `${scenario}: ${r.stderr || r.stdout}`);
  const lines = r.stdout.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

test('repeticion en pausa por falta de disco: vuelve al elegir un largo que entra', () => {
  const r = run('noRoomRetry');
  assert.equal(r.before, true);
  assert.deepEqual(r.blocked, { active: false, error: 'noRoom' }, '30 minutos a 4K no entran en 4 GB');
  assert.deepEqual(r.after, { active: true, error: null });
});

test('repeticion en pausa por falta de disco: vuelve sola cuando se libera lugar', () => {
  const r = run('noRoomFreed');
  assert.deepEqual(r.blocked, { active: false, error: 'noRoom' });
  assert.deepEqual(r.after, { active: true, error: null });
});

test('codificador por software: que el juego deje de dar cuadros despues del arranque no reinicia ni baja la calidad', () => {
  const r = run('lateStall');
  assert.equal(r.starts, 1, 'no se reinicio la captura');
  assert.equal(r.degraded, null);
  assert.ok(r.bufferedAfter >= r.bufferedBefore, 'el buffer de la repeticion sigue');
});

test('codificador por software: un tiron de 3 s al arrancar no baja la calidad', () => {
  const r = run('earlyHiccup');
  assert.equal(r.starts, 1);
  assert.equal(r.degraded, null);
});

test('la PC no llega mientras se graba: un solo paso y un solo aviso, aplicado al terminar', () => {
  const r = run('degradeWhileRecording');
  assert.deepEqual(r.during, { degraded: { quality: '720p', fps: 60 }, notices: 1, starts: 1 });
  assert.deepEqual(r.after, { starts: 2, lastFps: 60, lastBox: 720 });
});

test('un reinicio pendiente de una grabacion ya terminada no borra despues el buffer de la repeticion', () => {
  const r = run('staleRestart');
  assert.ok(r.after >= r.before, `buffer ${r.before} s -> ${r.after} s`);
});

test('"nativa" le pide a la grabadora el tope de 4K, no el tamanio de la pantalla principal', () => {
  assert.deepEqual(run('nativeBox').box, { width: 3840, height: 2160 });
});

test('el buffer entra pero no el clip entero: Ajustes y un aviso lo dicen, sin bloquear', () => {
  const r = run('saveTight');
  assert.equal(r.active, true);
  assert.equal(r.diskOk, true);
  assert.equal(r.diskSaveOk, false);
  assert.ok(r.need > 2 * GB && 5.5 * GB < 2 * r.need + logic.DISK_MARGIN);
  assert.equal(r.notices.length, 1);
});

test('con la placa de video, el bitrate en vivo es lo que se espera que ocupe y no lo pedido', () => {
  assert.equal(run('liveBitrate').live, Math.round(5e6 * logic.hwOvershoot(60)));
});

test('sin grabacion en esta plataforma (macOS) los ajustes guardados igual se cargan y se siguen', () => {
  const r = run('platformSettings', 'darwin');
  assert.equal(r.available, false);
  assert.deepEqual(r.first, { replaySeconds: 600, quality: '1440p', notify: false, copyTo: true });
  assert.equal(r.notify, true);
});
