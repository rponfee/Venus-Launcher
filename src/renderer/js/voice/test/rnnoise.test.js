// RNNoise de verdad: corre el mismo binario que usa el launcher, con ruido y una señal parecida a la voz.
// node --test "src/renderer/js/voice/test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRnnoise, RNNOISE_FRAME } from '../rnnoise-core.js';

const VENDOR = new URL('../../../vendor/rnnoise/', import.meta.url);
const INDEX = new URL('../../../index.html', import.meta.url);
const compile = () => new WebAssembly.Module(fs.readFileSync(new URL('rnnoise.wasm', VENDOR)));

// Ruido repetible (sin Math.random): ventilador con algo de soplido
function noise(n, gain = 0.03) {
  const out = new Float32Array(n);
  let seed = 12345;
  let low = 0;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const white = seed / 2147483648 - 1;
    low += (white - low) * 0.05;
    out[i] = gain * (0.5 * white + 2 * low + 0.4 * Math.sin((2 * Math.PI * 120 * i) / 48000));
  }
  return out;
}

function runFrames(rn, samples) {
  const frame = new Float32Array(RNNOISE_FRAME);
  const out = new Float32Array(samples.length);
  const probs = [];
  for (let i = 0; i + RNNOISE_FRAME <= samples.length; i += RNNOISE_FRAME) {
    frame.set(samples.subarray(i, i + RNNOISE_FRAME));
    probs.push(rn.process(frame));
    out.set(frame, i);
  }
  return { out, probs };
}

function db(a, from = 0, to = a.length) {
  let sum = 0;
  for (let i = from; i < to; i++) sum += a[i] * a[i];
  return 10 * Math.log10(sum / (to - from) + 1e-12);
}

test('el binario y su licencia estan en vendor/rnnoise', () => {
  assert.ok(fs.statSync(new URL('rnnoise.wasm', VENDOR)).size > 100000);
  const license = fs.readFileSync(new URL('LICENSE', VENDOR), 'utf8');
  assert.match(license, /Xiph\.Org Foundation/);
  assert.match(license, /Apache License/);
});

test('la CSP deja compilar WebAssembly y nada mas de lo necesario', () => {
  const html = fs.readFileSync(INDEX, 'utf8');
  const csp = /content="(default-src[^"]+)"/.exec(html)[1];
  const script = csp.split(';').find((d) => d.trim().startsWith('script-src')).trim().split(/\s+/);
  assert.ok(script.includes("'wasm-unsafe-eval'"));
  assert.ok(!script.includes("'unsafe-eval'"));
  assert.ok(!script.includes("'unsafe-inline'"));
});

test('limpia el ruido: baja mucho el nivel de una señal de solo ruido', () => {
  const rn = createRnnoise(compile());
  const input = noise(48000 * 3);
  const { out, probs } = runFrames(rn, input);
  // El primer medio segundo es lo que tarda en aprender el ruido
  const from = 24000;
  const reduction = db(input, from) - db(out, from);
  assert.ok(reduction > 25, `reduccion de ${reduction.toFixed(1)} dB`);
  const late = probs.slice(100);
  assert.ok(Math.max(...late) < 0.2, 'no lo confunde con voz');
  rn.destroy();
});

test('la probabilidad de voz siempre esta entre 0 y 1 y el silencio queda en silencio', () => {
  const rn = createRnnoise(compile());
  const { out, probs } = runFrames(rn, new Float32Array(48000));
  for (const p of probs) assert.ok(p >= 0 && p <= 1);
  assert.ok(db(out) < -100);
  rn.destroy();
  rn.destroy(); // dos veces no rompe
});

test('dos instancias no se pisan (cada una con su memoria)', () => {
  const module = compile();
  const a = createRnnoise(module);
  const b = createRnnoise(module);
  const input = noise(48000);
  const ra = runFrames(a, input).out;
  const rb = runFrames(b, input).out;
  assert.deepEqual(ra, rb);
  a.destroy();
  b.destroy();
});

test('un binario equivocado tira error (y mic.js cae a la supresion del navegador)', () => {
  // Modulo WebAssembly valido pero vacio: no es RNNoise
  const empty = new WebAssembly.Module(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
  assert.throws(() => createRnnoise(empty));
  assert.throws(() => new WebAssembly.Module(new Uint8Array([1, 2, 3, 4])));
});
