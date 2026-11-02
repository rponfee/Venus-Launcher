'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const webm = require('../webm');
const { makeFrames, makeStream, chunks } = require('./fake-webm');

const { ID } = webm;

function readAll(buf, pieces) {
  const r = new webm.WebmReader();
  let header = null;
  const frames = [];
  for (const c of pieces || [buf]) {
    const o = r.push(c);
    if (o.header) header = o.header;
    frames.push(...o.frames);
  }
  return { header, frames };
}

// Recorre los elementos de nivel 1 de un archivo armado: { segStart, segSize, list: [{ id, at, size }] }
function topLevel(buf) {
  const eb = webm.readHeader(buf, 0);
  let pos = eb.head + eb.size;
  const seg = webm.readHeader(buf, pos);
  assert.equal(seg.id, ID.Segment);
  const segStart = pos + seg.head;
  pos = segStart;
  const list = [];
  while (pos < buf.length) {
    const h = webm.readHeader(buf, pos);
    list.push({ id: h.id, at: pos - segStart, size: h.size, head: h.head });
    pos += h.head + h.size;
  }
  return { segStart, segSize: seg.size, list, end: pos };
}

function cuesOf(buf) {
  const top = topLevel(buf);
  const cues = top.list.find((e) => e.id === ID.Cues);
  if (!cues) return [];
  const start = top.segStart + cues.at + cues.head;
  return webm.children(buf, start, start + cues.size).map((cp) => {
    const kids = webm.children(buf, cp.start, cp.end);
    const time = kids.find((k) => k.id === ID.CueTime);
    const pos = kids.find((k) => k.id === ID.CueTrackPositions);
    const inner = webm.children(buf, pos.start, pos.end);
    const cl = inner.find((k) => k.id === ID.CueClusterPosition);
    return { time: webm.readUint(buf, time.start, time.end), pos: webm.readUint(buf, cl.start, cl.end), segStart: top.segStart };
  });
}

test('vints e IDs: lectura y escritura', () => {
  for (const n of [0, 1, 126, 127, 128, 16382, 16383, 2 ** 21, 2 ** 35, 2 ** 50]) {
    const b = webm.sizeBytes(n);
    assert.equal(webm.readVint(b, 0).value, n, `tamanio ${n}`);
  }
  assert.equal(webm.sizeBytes(127).length, 2, '127 es el "desconocido" de 1 byte: necesita 2');
  assert.equal(webm.sizeBytes(5, 8).length, 8);
  assert.equal(webm.readVint(webm.UNKNOWN_SIZE, 0).value, -1);
  assert.equal(webm.readVint(Buffer.from([0x40]), 0), null, 'faltan bytes');
  assert.deepEqual(webm.readId(webm.idBytes(ID.Cluster), 0), { id: ID.Cluster, len: 4 });
  assert.throws(() => webm.readId(Buffer.from([0x00]), 0), /webm/);
});

test('voidEl ocupa exactamente lo pedido', () => {
  for (const n of [2, 3, 10, 128, 129, 130, 5000, 600000]) {
    const v = webm.voidEl(n);
    assert.equal(v.length, n);
    const h = webm.readHeader(v, 0);
    assert.equal(h.id, ID.Void);
    assert.equal(h.head + h.size, n);
  }
  assert.throws(() => webm.voidEl(1));
});

test('el lector entiende el flujo de MediaRecorder entero y en pedazos', () => {
  const frames = makeFrames({ seconds: 6 });
  const buf = makeStream({ frames });
  const whole = readAll(buf);
  const pieces = readAll(buf, chunks(buf));
  assert.equal(whole.header.videoTrack, 1);
  assert.equal(whole.header.width, 1280);
  assert.equal(whole.header.height, 720);
  assert.equal(whole.header.timecodeScale, 1000000);
  assert.equal(whole.frames.length, frames.length);
  assert.equal(pieces.frames.length, frames.length);
  for (let i = 0; i < frames.length; i++) {
    assert.equal(whole.frames[i].time, frames[i].time);
    assert.equal(pieces.frames[i].time, frames[i].time);
    assert.equal(whole.frames[i].video, frames[i].track === 1);
    if (frames[i].track === 1) assert.equal(whole.frames[i].key, frames[i].key);
  }
  assert.ok(pieces.frames.every((f, i) => f.bytes.equals(whole.frames[i].bytes)));
});

test('el lector rechaza lo que no es WebM', () => {
  assert.throws(() => new webm.WebmReader().push(Buffer.from('hola mundo, esto no es un video')), (e) => e.code === 'badWebm');
});

test('fromKeyframe empieza en un cuadro clave y descarta el audio anterior', () => {
  const { frames } = readAll(makeStream({ seconds: 10 }));
  const list = webm.fromKeyframe(frames, 3000);
  assert.ok(list[0].video && list[0].key);
  assert.equal(list[0].time, 4000);
  assert.ok(list.every((f) => f.time >= 4000));
  assert.deepEqual(webm.fromKeyframe([], 0), []);
});

test('buildFile: tiempos desde cero, duracion, tamanio del Segment e indice correctos', () => {
  const { header, frames } = readAll(makeStream({ seconds: 12, base: 500000 }));
  const list = webm.fromKeyframe(frames, 500000 + 5000);
  const built = webm.buildFile(header, list, { frameDur: 33 });
  const out = Buffer.concat(built.parts);
  assert.equal(out.length, built.bytes);
  const top = topLevel(out);
  assert.equal(top.segSize, out.length - top.segStart, 'el Segment mide lo que hay');
  assert.deepEqual(top.list.slice(0, 4).map((e) => e.id), [ID.SeekHead, ID.Info, ID.Tracks, ID.Cues]);
  // Se vuelve a leer: empieza en 0 con un cuadro clave
  const again = readAll(out);
  assert.equal(again.frames[0].time, 0);
  assert.ok(again.frames[0].video && again.frames[0].key);
  assert.equal(again.frames.length, list.length);
  assert.equal(again.frames.at(-1).time, list.at(-1).time - list[0].time);
  // Duracion en Info
  const d = webm.describeHeader(again.header.info, again.header.tracks);
  assert.equal(d.duration, built.duration);
  assert.ok(Math.abs(built.duration - (list.at(-1).time - list[0].time + 33)) < 1);
  // Cada punto del indice apunta a un Cluster que empieza con un cuadro clave
  const cues = cuesOf(out);
  const keys = list.filter((f) => f.video && f.key).length;
  assert.equal(cues.length, keys);
  for (const c of cues) {
    const at = c.segStart + c.pos;
    assert.equal(webm.readHeader(out, at).id, ID.Cluster);
  }
  // El SeekHead apunta a Info, Tracks y Cues
  const seek = top.list[0];
  const seeks = webm.children(out, top.segStart + seek.head, top.segStart + seek.head + seek.size).map((s) => {
    const kids = webm.children(out, s.start, s.end);
    const id = kids.find((k) => k.id === ID.SeekID);
    const pos = kids.find((k) => k.id === ID.SeekPosition);
    return { id: webm.readUint(out, id.start, id.end), pos: webm.readUint(out, pos.start, pos.end) };
  });
  for (const s of seeks) assert.equal(webm.readHeader(out, top.segStart + s.pos).id, s.id);
});

test('Muxer: un Cluster por cuadro clave y cortes antes de pasarse del int16', () => {
  const mux = new webm.Muxer({ base: 0 });
  const mk = (time, video, key) => ({ time, video, key, track: video ? 1 : 2, bytes: Buffer.from([0xa3, 0x84, 0x81, 0, 0, 0x80]), tcPos: 3 });
  const closed = [];
  closed.push(...mux.add(mk(0, true, true)));
  closed.push(...mux.add(mk(10, false, true)));
  closed.push(...mux.add(mk(2000, true, true)));
  assert.equal(closed.length, 1);
  assert.equal(closed[0].time, 0);
  assert.ok(closed[0].key);
  // Video quieto sin cuadros clave por 40 s: igual corta
  for (let t = 2100; t < 42000; t += 1000) closed.push(...mux.add(mk(t, true, false)));
  assert.equal(closed.length, 2, 'el Cluster de los 2 s se corto a los 30 s');
  const tail = mux.flush();
  assert.ok(tail && !tail.key, 'el resto va en un Cluster sin cuadro clave');
  assert.ok(tail.time > 30000);
  assert.equal(mux.flush(), null);
});

test('buildHead con lugar reservado: siempre mide lo mismo y achica el indice si no entra', () => {
  const { header } = readAll(makeStream({ seconds: 2 }));
  const reserve = 4096;
  const prov = webm.buildHead({ header, reserve, clusterBytes: null });
  const many = Array.from({ length: 1000 }, (_, i) => ({ time: i * 2000, offset: i * 5000 }));
  const fin = webm.buildHead({ header, reserve, cues: many, duration: 2000000, clusterBytes: 5000000 });
  assert.equal(prov.data.length, fin.data.length);
  assert.equal(fin.headLen, reserve);
  assert.ok(fin.cues > 0 && fin.cues < 1000, `puntos que entraron: ${fin.cues}`);
  assert.deepEqual(webm.thinCues([1, 2, 3, 4], 2), [1, 3]);
  assert.deepEqual(webm.thinCues([1, 2], 5), [1, 2]);
  assert.deepEqual(webm.thinCues([1, 2], 0), []);
});

test('remux de un archivo entero (lo que exporta el editor)', () => {
  const buf = makeStream({ seconds: 5 });
  const out = webm.remux(buf, { frameDur: 33 });
  assert.ok(out.duration > 4900);
  const again = readAll(Buffer.concat(out.parts));
  assert.equal(again.frames[0].time, 0);
  assert.throws(() => webm.remux(Buffer.from([1, 2, 3])));
});
