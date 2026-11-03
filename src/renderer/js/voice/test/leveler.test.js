// Nivelacion de las voces de los demas.
// node --test "src/renderer/js/voice/test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceLeveler, LEVEL_TARGET_DB, VOICE_COMPRESSOR, MIX_LIMITER, compressorMakeupDb } from '../leveler.js';

const TICK = 40;
const toDb = (g) => 20 * Math.log10(g);

function speak(leveler, db, ms) {
  let gain = leveler.gain;
  for (let t = 0; t < ms; t += TICK) gain = leveler.update(db, TICK);
  return gain;
}

test('sin voz todavia no toca nada', () => {
  const l = new VoiceLeveler();
  assert.equal(l.gain, 1);
  assert.equal(speak(l, -80, 5000), 1, 'el silencio no sube la ganancia');
});

test('a quien habla bajo lo sube y a quien habla fuerte lo baja, hasta el mismo nivel', () => {
  const quiet = new VoiceLeveler();
  const loud = new VoiceLeveler();
  const up = toDb(speak(quiet, LEVEL_TARGET_DB - 8, 2000));
  const down = toDb(speak(loud, LEVEL_TARGET_DB + 6, 2000));
  assert.ok(Math.abs(up - 8) < 1, `sube ${up.toFixed(1)} dB`);
  assert.ok(Math.abs(down + 6) < 1, `baja ${down.toFixed(1)} dB`);
});

test('tiene limites: no sube ruido sin fin ni deja mudo a nadie', () => {
  assert.ok(toDb(speak(new VoiceLeveler(), -50, 3000)) <= 12.01);
  assert.ok(toDb(speak(new VoiceLeveler(), -3, 3000)) >= -9.01);
});

test('al callarse o en los finales de palabra la ganancia no se mueve', () => {
  const l = new VoiceLeveler();
  const gain = speak(l, -30, 2000);
  assert.equal(speak(l, -90, 4000), gain, 'silencio');
  assert.equal(speak(l, -51, 4000), gain, 'muy por debajo de su nivel');
});

test('despues de aprender, un pico suelto casi no cambia la ganancia (de eso se ocupa el compresor)', () => {
  const l = new VoiceLeveler();
  const before = toDb(speak(l, -30, 3000));
  const after = toDb(speak(l, -10, 120));
  assert.ok(Math.abs(after - before) < 1.5, `${before.toFixed(1)} -> ${after.toFixed(1)}`);
});

test('makeup del compresor: la misma cuenta que Chromium', () => {
  // Sin rodilla la cuenta es exacta: 0,6 * -umbral * (1 - 1/ratio)
  assert.ok(Math.abs(compressorMakeupDb({ threshold: -24, knee: 0, ratio: 4 }) - 10.8) < 0.01);
  assert.ok(Math.abs(compressorMakeupDb({ threshold: -3, knee: 0, ratio: 20 }) - 1.71) < 0.01);
  // Sin compresion no hay makeup
  assert.ok(Math.abs(compressorMakeupDb({ threshold: -24, knee: 0, ratio: 1 })) < 0.01);
  // Con rodilla comprime menos en 0 dB, y el makeup es un poco menor
  const soft = compressorMakeupDb(VOICE_COMPRESSOR);
  const hard = compressorMakeupDb({ ...VOICE_COMPRESSOR, knee: 0 });
  assert.ok(soft > 0 && soft < hard, `${soft} < ${hard}`);
  assert.ok(compressorMakeupDb(MIX_LIMITER) > 0);
});
