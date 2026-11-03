// Umbral de voz (puerta de ruido).
// node --test "src/renderer/js/voice/test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceGate, LevelFollower, FLOOR_DB, rmsDb, powerDb, autoThreshold } from '../gate.js';

const MANUAL = { vad: true, auto: false, threshold: -50, transmit: true };

test('rmsDb y powerDb', () => {
  assert.equal(rmsDb(new Float32Array(128)), FLOOR_DB);
  const full = new Float32Array(128).fill(1);
  assert.ok(Math.abs(rmsDb(full)) < 1e-6);
  assert.equal(powerDb(0), FLOOR_DB);
  assert.ok(Math.abs(powerDb(0.01) + 20) < 1e-9);
});

test('abre con voz sobre el umbral y sigue abierta un rato despues', () => {
  const g = new VoiceGate({ holdMs: 300 });
  assert.equal(g.update(-70, 0, MANUAL).open, false);
  assert.equal(g.update(-30, 10, MANUAL).open, true);
  assert.equal(g.update(-90, 200, MANUAL).open, true, 'no corta los finales de palabra');
  assert.equal(g.update(-90, 309, MANUAL).open, true);
  assert.equal(g.update(-90, 311, MANUAL).open, false);
});

test('histeresis: abierta no tartamudea cuando el nivel baila cerca del umbral', () => {
  const g = new VoiceGate({ holdMs: 0, hysteresisDb: 4 });
  assert.equal(g.update(-49, 0, MANUAL).open, true);
  assert.equal(g.update(-52, 10, MANUAL).open, true, 'debajo del umbral pero dentro de la histeresis');
  assert.equal(g.update(-55, 20, MANUAL).open, false);
  assert.equal(g.update(-52, 30, MANUAL).open, false, 'cerrada, recien abre sobre el umbral');
  assert.equal(g.update(-49, 40, MANUAL).open, true);
});

test('sin transmitir no abre, pero sabe que hay voz', () => {
  const g = new VoiceGate();
  const r = g.update(-20, 0, { ...MANUAL, transmit: false });
  assert.equal(r.open, false);
  assert.equal(r.voiced, true);
  assert.equal(r.speaking, false);
});

test('pulsar para hablar: abre aunque no haya voz; speaking solo con voz', () => {
  const g = new VoiceGate();
  const p = { vad: false, auto: false, threshold: -55, transmit: true };
  const silent = g.update(-90, 0, p);
  assert.equal(silent.open, true);
  assert.equal(silent.speaking, false);
  assert.equal(g.update(-90, 1000, { ...p, transmit: false }).open, false);
  assert.equal(g.update(-30, 2000, p).speaking, true);
});

test('sensibilidad automatica: se ubica sobre el ruido de fondo y dentro de limites', () => {
  assert.equal(autoThreshold(-100), -62);
  assert.equal(autoThreshold(-50), -37);
  assert.equal(autoThreshold(0), -28);
  const auto = { vad: true, auto: true, threshold: -10, transmit: true };
  const g = new VoiceGate({ holdMs: 0 });
  for (let t = 0; t < 10000; t += 40) g.update(-45, t, auto);
  const r = g.update(-45, 10000, auto);
  assert.ok(r.threshold > -45, `con ruido a -45 dB el umbral queda arriba (${r.threshold})`);
  assert.equal(r.open, false, 'el ruido constante no abre');
  assert.equal(g.update(-20, 10040, auto).open, true, "la voz si");
});

test('el piso de ruido baja rapido y sube lento, sin depender de cada cuanto se llama', () => {
  const quick = new VoiceGate();
  const slow = new VoiceGate();
  for (let t = 0; t < 2000; t += 3) quick.update(-40, t, MANUAL);
  for (let t = 0; t < 2000; t += 40) slow.update(-40, t, MANUAL);
  assert.ok(Math.abs(quick.floor - slow.floor) < 1);
  assert.ok(slow.floor < -55, 'sube muy lento');
  for (let t = 2000; t < 2400; t += 40) slow.update(-80, t, MANUAL);
  assert.ok(slow.floor < -75, 'baja rapido');
  const before = slow.floor;
  slow.update(FLOOR_DB, 2500, MANUAL);
  assert.equal(slow.floor, before, 'el silencio digital no cuenta como ruido');
});

test('RNNoise dice que no es voz: un ruido corto no abre, salvo que sea muy fuerte', () => {
  const g = new VoiceGate({ holdMs: 0 });
  assert.equal(g.update(-45, 0, { ...MANUAL, voiceProb: 0.01 }).open, false, 'teclado');
  assert.equal(g.update(-45, 10, { ...MANUAL, voiceProb: 0.9 }).open, true, 'voz');
  assert.equal(g.update(-45, 20, { ...MANUAL, voiceProb: 0.01 }).open, true, 'ya abierta, no se corta en medio de una palabra');
  const h = new VoiceGate({ holdMs: 0 });
  assert.equal(h.update(-20, 0, { ...MANUAL, voiceProb: 0.01 }).open, true, 'un grito pasa');
  const i = new VoiceGate({ holdMs: 0 });
  assert.equal(i.update(-45, 0, { ...MANUAL, voiceProb: null }).open, true, 'sin RNNoise solo cuenta el nivel');
});

test('devuelve siempre el mismo objeto (no genera basura en el hilo de audio)', () => {
  const g = new VoiceGate();
  assert.equal(g.update(-30, 0, MANUAL), g.update(-30, 1, MANUAL));
});

test('LevelFollower sube enseguida y baja suave', () => {
  const dt = (128 / 48000) * 1000;
  const f = new LevelFollower(dt);
  assert.equal(f.update(0), FLOOR_DB);
  let db = FLOOR_DB;
  for (let i = 0; i < 4; i++) db = f.update(0.01); // 10,7 ms a -20 dB
  assert.ok(db > -22, `sube en pocos bloques (${db})`);
  for (let i = 0; i < 4; i++) db = f.update(0);
  assert.ok(db > -30 && db < -20, `baja suave (${db})`);
});
