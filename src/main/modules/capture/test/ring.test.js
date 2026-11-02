'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ReplayRing } = require('../ring');
const webm = require('../webm');
const { makeStream } = require('./fake-webm');

function framesOf(opts) {
  const r = new webm.WebmReader();
  const o = r.push(makeStream(opts));
  return { header: o.header, frames: o.frames };
}

test('guarda solo los ultimos N segundos, siempre desde un cuadro clave', () => {
  const { header, frames } = framesOf({ seconds: 100 });
  const ring = new ReplayRing({ seconds: 30 });
  ring.setHeader(header);
  let maxBytes = 0;
  for (const f of frames) {
    ring.add(f);
    maxBytes = Math.max(maxBytes, ring.bytes);
  }
  assert.ok(ring.buffered >= 30 && ring.buffered <= 32.1, `buffer: ${ring.buffered}`);
  const first = ring.frames[ring.head];
  assert.ok(first.video && first.key, 'el buffer empieza en un cuadro clave');
  const total = frames.reduce((a, f) => a + f.bytes.length, 0);
  assert.ok(ring.bytes < total / 2, 'descarta lo viejo');
  assert.equal(ring.header, header);
  const snap = ring.snapshot();
  assert.ok(snap[0].video && snap[0].key);
  const span = (ring.newest - snap[0].time) / 1000;
  assert.ok(span >= 30 && span <= 32.1, `largo guardado: ${span}`);
  // Se puede armar y vuelve a empezar en 0
  const built = webm.buildFile(header, snap, { frameDur: 33 });
  assert.ok(built.duration >= 30000);
});

test('snapshot mas corto y antes de juntar los N segundos', () => {
  const { frames } = framesOf({ seconds: 8 });
  const ring = new ReplayRing({ seconds: 30 });
  frames.forEach((f) => ring.add(f));
  const all = ring.snapshot();
  assert.equal(all[0].time, 0, 'todavia no hay 30 s: guarda desde el principio');
  const short = ring.snapshot(3);
  assert.ok(short[0].key && short[0].time <= ring.newest - 3000);
  assert.ok(short[0].time >= ring.newest - 5000);
});

test('120 s con premium: cambiar el largo agranda lo que se guarda desde ahi', () => {
  const { frames } = framesOf({ seconds: 200, audio: false });
  const ring = new ReplayRing({ seconds: 30 });
  ring.setSeconds(120);
  frames.forEach((f) => ring.add(f));
  assert.ok(ring.buffered >= 120 && ring.buffered <= 122.1);
});

test('video quieto sin cuadros clave: tope duro para no crecer sin fin', () => {
  const ring = new ReplayRing({ seconds: 10 });
  const mk = (time, key) => ({ time, key, video: true, track: 1, bytes: Buffer.alloc(10), tcPos: 3 });
  ring.add(mk(0, true));
  for (let t = 33; t < 100000; t += 33) ring.add(mk(t, false));
  assert.ok(ring.newest - ring.frames[ring.head].time <= 40000 + 33);
  assert.deepEqual(ring.snapshot(), [], 'sin cuadro clave no hay nada reproducible');
});

test('setHeader vacia lo guardado (cambio de flujo)', () => {
  const { header, frames } = framesOf({ seconds: 4 });
  const ring = new ReplayRing({ seconds: 30 });
  frames.forEach((f) => ring.add(f));
  assert.ok(ring.length > 0);
  ring.setHeader(header);
  assert.equal(ring.length, 0);
  assert.equal(ring.bytes, 0);
  assert.equal(ring.buffered, 0);
});
