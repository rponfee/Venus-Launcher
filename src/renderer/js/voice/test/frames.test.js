// Puente entre bloques de 128 muestras y cuadros de 480: sin cortes y con la menor demora posible.
// node --test "src/renderer/js/voice/test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameBridge } from '../frames.js';

const FRAME = 480;
const QUANTUM = 128;
const LATENCY = 512; // 10,7 ms: ver FrameBridge.configure

function run(bridge, samples, quantum = QUANTUM, onFrame = () => {}) {
  const out = new Float32Array(samples.length);
  const input = new Float32Array(quantum);
  const output = new Float32Array(quantum);
  for (let i = 0; i + quantum <= samples.length; i += quantum) {
    input.set(samples.subarray(i, i + quantum));
    bridge.process(input, output, onFrame);
    out.set(output, i);
  }
  return out;
}

test('un impulso sale exactamente 512 muestras despues', () => {
  const samples = new Float32Array(6400);
  samples[1000] = 1;
  const out = run(new FrameBridge(FRAME), samples);
  assert.equal(out.indexOf(1), 1000 + LATENCY);
  const b = new FrameBridge(FRAME);
  b.configure(QUANTUM);
  assert.equal(b.delay, LATENCY);
});

test('no falta ni se repite ninguna muestra durante mucho tiempo', () => {
  const samples = new Float32Array(QUANTUM * 20000);
  for (let i = 0; i < samples.length; i++) samples[i] = (i % 1000) / 1000 + 0.001;
  const out = run(new FrameBridge(FRAME), samples);
  // Antes de la demora, silencio; despues, la señal corrida y sin huecos
  for (let i = 0; i < LATENCY; i++) assert.equal(out[i], 0);
  for (let i = LATENCY; i < out.length; i++) {
    if (out[i] !== samples[i - LATENCY]) assert.fail(`muestra ${i}: ${out[i]} != ${samples[i - LATENCY]}`);
  }
});

test('cada cuadro completo pasa por el proceso y su resultado llega a la salida', () => {
  const samples = new Float32Array(QUANTUM * 30).fill(0.5);
  let frames = 0;
  const out = run(new FrameBridge(FRAME), samples, QUANTUM, (f) => {
    assert.equal(f.length, FRAME);
    frames++;
    f.fill(0.25);
  });
  assert.equal(frames, Math.floor(samples.length / FRAME));
  assert.equal(out[LATENCY + 1], 0.25);
  assert.equal(out[out.length - 1], 0.25);
});

test('funciona con otro tamaño de bloque y con divisores exactos', () => {
  const b = new FrameBridge(FRAME);
  b.configure(480);
  assert.equal(b.delay, 0, 'bloques iguales al cuadro: sin demora extra');
  const c = new FrameBridge(FRAME);
  c.configure(240);
  assert.equal(c.delay, 240);
  const samples = new Float32Array(9600).map((_, i) => i + 1);
  const out = run(new FrameBridge(FRAME), samples, 240);
  assert.equal(out[240], 1);
});

test('reset vuelve a empezar sin arrastrar audio viejo', () => {
  const b = new FrameBridge(FRAME);
  const input = new Float32Array(QUANTUM).fill(1);
  const output = new Float32Array(QUANTUM);
  for (let i = 0; i < 20; i++) b.process(input, output, () => {});
  assert.equal(output[0], 1);
  b.reset();
  b.process(new Float32Array(QUANTUM), output, () => {});
  assert.equal(output[0], 0);
  assert.equal(b.started, false);
});
