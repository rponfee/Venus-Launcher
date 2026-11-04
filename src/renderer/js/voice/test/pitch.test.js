// Cambio de tono de los efectos de voz: un seno entra, se mide la frecuencia que sale.
// node --test "src/renderer/js/voice/test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';
import { PitchShifter, dominantFrequency, PITCH_WINDOW_MS, PITCH_SEARCH_MS } from '../pitch-core.js';

const RATE = 48000;

function run(ratio, freq, seconds = 1, block = 128) {
  const shifter = new PitchShifter({ sampleRate: RATE, ratio });
  const total = Math.floor(seconds * RATE);
  const out = new Float32Array(total);
  const input = new Float32Array(block);
  const output = new Float32Array(block);
  for (let at = 0; at + block <= total; at += block) {
    for (let i = 0; i < block; i++) input[i] = Math.sin((2 * Math.PI * freq * (at + i)) / RATE);
    shifter.process(input, output);
    out.set(output, at);
  }
  return out;
}

// Se descarta el primer tramo, mientras se llena la linea de demora
const settled = (out) => out.subarray(Math.floor(RATE * 0.1));

test('dominantFrequency encuentra un seno', () => {
  const n = RATE / 2;
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = Math.sin((2 * Math.PI * 523 * i) / RATE);
  assert.ok(Math.abs(dominantFrequency(s, RATE, 300, 800) - 523) <= 2);
});

for (const [name, ratio, freq] of [
  ['grave', 0.72, 440],
  ['agudo', 1.42, 440],
  ['aldeano', 0.86, 220],
  ['grave con una voz baja', 0.72, 150],
  ['agudo con una voz baja', 1.42, 150],
  ['agudo con una voz alta', 1.42, 1000],
]) {
  test(`${name}: ${freq} Hz por ${ratio}`, () => {
    const want = freq * ratio;
    const got = dominantFrequency(settled(run(ratio, freq)), RATE, Math.round(want * 0.6), Math.round(want * 1.4));
    assert.ok(Math.abs(got - want) / want < 0.015, `salieron ${got} Hz y se esperaban ${want} Hz`);
  });
}

test('con ratio 1 la frecuencia no cambia', () => {
  const got = dominantFrequency(settled(run(1, 440)), RATE, 300, 600);
  assert.ok(Math.abs(got - 440) <= 2, `salieron ${got} Hz`);
});

test('el nivel se mantiene: ni se apaga ni satura', () => {
  for (const ratio of [0.72, 0.86, 1.42]) {
    const out = settled(run(ratio, 300));
    let sum = 0;
    let peak = 0;
    for (const v of out) {
      sum += v * v;
      peak = Math.max(peak, Math.abs(v));
    }
    const rms = Math.sqrt(sum / out.length);
    assert.ok(rms > 0.3 && rms < 0.9, `rms ${rms} con ratio ${ratio}`);
    assert.ok(peak <= 1.01, `pico ${peak} con ratio ${ratio}`);
  }
});

test('latencia baja: el primer sonido sale antes de que pase la ventana', () => {
  for (const ratio of [0.72, 1.42]) {
    const s = new PitchShifter({ sampleRate: RATE, ratio });
    const block = 128;
    const output = new Float32Array(block);
    const input = new Float32Array(block).fill(0.5);
    let firstAt = -1;
    for (let at = 0; firstAt < 0 && at < RATE; at += block) {
      s.process(input, output);
      const i = output.findIndex((v) => Math.abs(v) > 0.05);
      if (i >= 0) firstAt = at + i;
    }
    assert.ok(firstAt >= 0);
    assert.ok((firstAt / RATE) * 1000 <= PITCH_WINDOW_MS + PITCH_SEARCH_MS, `tardo ${(firstAt / RATE) * 1000} ms con ratio ${ratio}`);
  }
});

test('silencio entra, silencio sale; sin entrada no rompe', () => {
  const s = new PitchShifter({ sampleRate: RATE, ratio: 0.72 });
  const out = new Float32Array(128).fill(1);
  s.process(null, out);
  assert.ok(out.every((v) => v === 0));
});

test('un ratio invalido queda en 1 y los extremos se recortan', () => {
  const s = new PitchShifter({ sampleRate: RATE, ratio: Number.NaN });
  assert.equal(s.ratio, 1);
  s.setRatio(100);
  assert.equal(s.ratio, 4);
  s.setRatio(0.01);
  assert.equal(s.ratio, 0.25);
  s.setRatio(-3);
  assert.equal(s.ratio, 1);
});

test('la fase nunca se sale de 0..1 y reset limpia todo', () => {
  const s = new PitchShifter({ sampleRate: RATE, ratio: 1.42 });
  const buf = new Float32Array(128);
  for (let i = 0; i < 2000; i++) {
    s.process(buf, buf);
    assert.ok(s.phase >= 0 && s.phase < 1 && s.phase2 >= 0 && s.phase2 < 1);
  }
  s.reset();
  assert.equal(s.phase, 0);
  assert.equal(s.write, 0);
});
