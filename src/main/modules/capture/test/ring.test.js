'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ReplayRing, cleanRoot, parseRecords, recordHead } = require('../ring');
const { RecordingFile } = require('../recording');
const webm = require('../webm');
const { makeStream } = require('./fake-webm');

function framesOf(opts) {
  const r = new webm.WebmReader();
  const o = r.push(makeStream(opts));
  return { header: o.header, frames: o.frames };
}

// Carpeta temporal para cada prueba, que se borra al terminar
function withDir(fn) {
  return async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'venus-ring-test-'));
    try {
      await fn(path.join(root, 'buffer'), root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  };
}

const onDisk = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);
const diskBytes = (dir) => onDisk(dir).reduce((a, f) => a + fs.statSync(path.join(dir, f)).size, 0);
// Termina de escribir y de borrar lo descartado
async function settled(ring) {
  await ring.sync();
  await Promise.allSettled([...ring.removals]);
}

test(
  'guarda en disco solo los ultimos N segundos, siempre desde un cuadro clave',
  withDir(async (dir) => {
    const { header, frames } = framesOf({ seconds: 100 });
    const ring = new ReplayRing({ dir, seconds: 30 });
    ring.setHeader(header);
    for (const f of frames) ring.add(f);
    await settled(ring);
    assert.ok(ring.buffered >= 30 && ring.buffered <= 42.1, `buffer: ${ring.buffered}`);
    const total = frames.reduce((a, f) => a + f.bytes.length, 0);
    assert.ok(ring.bytes < total / 2, 'descarta lo viejo');
    assert.equal(diskBytes(dir), ring.bytes, 'lo que dice que ocupa es lo que hay en el disco');
    assert.ok(onDisk(dir).length <= 5, `segmentos: ${onDisk(dir).length}`);
    assert.equal(ring.header, header);
    const snap = await ring.snapshot();
    const out = await snap.frames();
    assert.ok(out[0].video && out[0].key, 'empieza en un cuadro clave');
    const span = (ring.newest - out[0].time) / 1000;
    assert.ok(span >= 30 && span <= 32.1, `largo guardado: ${span}`);
    // Se puede armar y vuelve a empezar en 0
    const built = webm.buildFile(header, out, { frameDur: 33 });
    assert.ok(built.duration >= 30000);
    snap.release();
    await ring.dispose();
  }),
);

test(
  'rotacion: cada segmento empieza en un cuadro clave y los viejos se borran del disco',
  withDir(async (dir) => {
    const { frames } = framesOf({ seconds: 60, audio: false });
    const ring = new ReplayRing({ dir, seconds: 15, segmentSeconds: 5 });
    let most = 0;
    for (const f of frames) {
      ring.add(f);
      most = Math.max(most, ring.segments.length);
    }
    await settled(ring);
    assert.ok(most <= 6, `segmentos a la vez: ${most}`);
    for (const s of ring.segments) {
      assert.equal(s.keys[0], s.start, 'empieza en su primer cuadro clave');
      assert.ok(fs.existsSync(s.file));
    }
    assert.equal(ring.segments[0].dropped, false);
    assert.ok(ring.segments.filter((s) => s.fh).length <= 1, 'un solo archivo abierto a la vez');
    assert.equal(onDisk(dir).length, ring.segments.length, 'no quedan archivos de segmentos descartados');
    assert.ok(ring.seq > ring.segments.length, 'hubo rotacion');
    await ring.dispose();
  }),
);

test(
  'lo que sale es exactamente lo que entro (byte a byte y con sus datos)',
  withDir(async (dir) => {
    const { frames } = framesOf({ seconds: 25 });
    const ring = new ReplayRing({ dir, seconds: 60, segmentSeconds: 4 });
    for (const f of frames) ring.add(f);
    const snap = await ring.snapshot();
    const out = await snap.frames();
    snap.release();
    assert.equal(out.length, frames.length);
    for (let i = 0; i < out.length; i++) {
      assert.equal(out[i].time, frames[i].time);
      assert.equal(out[i].track, frames[i].track);
      assert.equal(out[i].key, frames[i].key);
      assert.equal(out[i].video, frames[i].video);
      assert.equal(out[i].tcPos, frames[i].tcPos);
      assert.ok(out[i].bytes.equals(frames[i].bytes), `cuadro ${i}`);
    }
    await ring.dispose();
  }),
);

test('registro cortado al final de un segmento: se ignora', () => {
  const frame = { time: 1234.5, track: 2, key: true, video: false, tcPos: 3, bytes: Buffer.from('abcdef') };
  const one = Buffer.concat([recordHead(frame), frame.bytes]);
  const two = Buffer.concat([one, one.subarray(0, one.length - 2)]);
  const out = parseRecords(two);
  assert.equal(out.length, 1);
  assert.equal(out[0].time, 1234.5);
  assert.equal(out[0].bytes.toString(), 'abcdef');
});

test(
  'snapshot mas corto y antes de juntar los N segundos: corta en un cuadro clave',
  withDir(async (dir) => {
    const { frames } = framesOf({ seconds: 8 });
    const ring = new ReplayRing({ dir, seconds: 60 });
    frames.forEach((f) => ring.add(f));
    const all = await ring.snapshot();
    const everything = await all.frames();
    all.release();
    assert.equal(everything[0].time, 0, 'todavia no hay 60 s: guarda desde el principio');
    const short = await ring.snapshot(3);
    const part = await short.frames();
    short.release();
    assert.ok(part[0].key && part[0].video);
    assert.ok(part[0].time <= ring.newest - 3000, 'incluye los 3 s pedidos');
    assert.ok(part[0].time >= ring.newest - 5000, 'y no mucho mas (un cuadro clave cada 2 s)');
    assert.ok(part.every((f) => f.time >= part[0].time), 'sin el audio de antes de ese cuadro clave');
    await ring.dispose();
  }),
);

test(
  'cambiar el largo de la repeticion (60 s a 5 minutos) agranda lo que se guarda desde ahi',
  withDir(async (dir) => {
    const { frames } = framesOf({ seconds: 400, audio: false, size: 20 });
    const ring = new ReplayRing({ dir, seconds: 60 });
    ring.setSeconds(300);
    frames.forEach((f) => ring.add(f));
    await settled(ring);
    assert.ok(ring.buffered >= 300 && ring.buffered <= 312.1, `buffer: ${ring.buffered}`);
    // Y al volver a 60 s descarta lo que sobra
    ring.setSeconds(60);
    await settled(ring);
    assert.ok(ring.buffered >= 60 && ring.buffered <= 72.1, `buffer: ${ring.buffered}`);
    await ring.dispose();
  }),
);

test(
  'video quieto sin cuadros clave: tope duro para no crecer sin fin',
  withDir(async (dir) => {
    const ring = new ReplayRing({ dir, seconds: 10 });
    const mk = (time, key) => ({ time, key, video: true, track: 1, bytes: Buffer.alloc(10), tcPos: 3 });
    ring.add(mk(0, true));
    for (let t = 33; t < 100000; t += 33) ring.add(mk(t, false));
    await settled(ring);
    assert.ok(ring.newest - ring.segments[0].start <= 40000 + 20000, `guardado: ${ring.newest - ring.segments[0].start}`);
    assert.equal(await ring.snapshot(), null, 'sin cuadro clave no hay nada reproducible');
    await ring.dispose();
  }),
);

test(
  'tope de bytes: aunque el video pese mas de lo esperado no pasa del maximo',
  withDir(async (dir) => {
    const { frames } = framesOf({ seconds: 60, audio: false, size: 2000 });
    const ring = new ReplayRing({ dir, seconds: 300, segmentSeconds: 5, maxBytes: 1024 * 1024 });
    for (const f of frames) {
      ring.add(f);
      await ring.sync();
    }
    await settled(ring);
    assert.ok(diskBytes(dir) <= 1024 * 1024 + 2 * 1024 * 1024, `disco: ${diskBytes(dir)}`);
    await ring.dispose();
  }),
);

test(
  'setHeader vacia lo guardado (cambio de flujo) y borra los archivos',
  withDir(async (dir) => {
    const { header, frames } = framesOf({ seconds: 4 });
    const ring = new ReplayRing({ dir, seconds: 30 });
    frames.forEach((f) => ring.add(f));
    await ring.sync();
    assert.ok(ring.length > 0);
    assert.ok(onDisk(dir).length > 0);
    ring.setHeader(header);
    assert.equal(ring.length, 0);
    assert.equal(ring.bytes, 0);
    assert.equal(ring.buffered, 0);
    await settled(ring);
    assert.equal(onDisk(dir).length, 0);
    await ring.dispose();
  }),
);

test(
  'lo que se esta guardando no se borra aunque el buffer rote',
  withDir(async (dir) => {
    const { frames } = framesOf({ seconds: 30, audio: false });
    const ring = new ReplayRing({ dir, seconds: 10, segmentSeconds: 2 });
    const firstPart = frames.filter((f) => f.time < 15000);
    firstPart.forEach((f) => ring.add(f));
    const snap = await ring.snapshot();
    const held = snap.parts.map((p) => p.seg.file);
    // Mientras se guarda sigue llegando video y los segmentos de antes rotan
    frames.filter((f) => f.time >= 15000).forEach((f) => ring.add(f));
    await settled(ring);
    assert.ok(snap.parts[0].seg.dropped, 'el primero ya se descarto');
    for (const file of held) assert.ok(fs.existsSync(file), `sigue en el disco: ${file}`);
    const out = await snap.frames();
    assert.ok(out[0].key && out[0].video);
    assert.ok(out.length > 100);
    snap.release();
    await settled(ring);
    assert.ok(!fs.existsSync(held[0]), 'al terminar se borra');
    await ring.dispose();
  }),
);

test(
  'dispose: borra la carpeta, espera lo que se este guardando y no acepta mas cuadros',
  withDir(async (dir) => {
    const { frames } = framesOf({ seconds: 12 });
    const ring = new ReplayRing({ dir, seconds: 30 });
    frames.forEach((f) => ring.add(f));
    const release = ring.retain();
    const snap = await ring.snapshot();
    let gone = false;
    const disposing = ring.dispose().then(() => {
      gone = true;
    });
    ring.add(frames[0]);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(gone, false, 'espera');
    assert.ok(fs.existsSync(dir));
    assert.ok((await snap.frames()).length > 0, 'se puede terminar de guardar');
    snap.release();
    release();
    await disposing;
    assert.equal(gone, true);
    assert.ok(!fs.existsSync(dir), 'no queda nada');
    assert.equal(ring.dispose(), ring.disposing, 'dos veces no rompe nada');
  }),
);

test(
  'limpieza al arrancar: cleanRoot borra lo que dejo un cierre de golpe',
  withDir(async (dir, root) => {
    const buffers = path.join(root, 'capture-replay');
    fs.mkdirSync(path.join(buffers, 'r1'), { recursive: true });
    fs.writeFileSync(path.join(buffers, 'r1', 'seg-000001.bin'), Buffer.alloc(1000));
    await cleanRoot(buffers);
    assert.ok(!fs.existsSync(buffers));
    await cleanRoot(buffers); // sin la carpeta tampoco falla
  }),
);

test(
  'si no se puede escribir avisa una vez y deja de guardar',
  withDir(async (dir, root) => {
    const notDir = path.join(root, 'archivo');
    fs.writeFileSync(notDir, 'x');
    const errors = [];
    const { frames } = framesOf({ seconds: 3 });
    const ring = new ReplayRing({ dir: path.join(notDir, 'sub'), seconds: 30, onError: (e) => errors.push(e) });
    frames.forEach((f) => ring.add(f));
    await ring.sync();
    assert.equal(errors.length, 1);
    assert.ok(ring.error);
    const before = ring.length;
    ring.add(frames[0]);
    assert.equal(ring.length, before, 'no acepta mas');
    await ring.dispose();
  }),
);

test(
  'si el disco no da abasto saltea hasta el proximo cuadro clave en vez de juntarlo en memoria',
  withDir(async (dir) => {
    const { frames } = framesOf({ seconds: 20, audio: false });
    const ring = new ReplayRing({ dir, seconds: 60, maxQueue: 20000 });
    frames.forEach((f) => ring.add(f)); // de corrido: la escritura todavia no llego a hacer nada
    assert.ok(ring.skipped > 0, 'salteo cuadros');
    assert.ok(ring.queued < 40000, `en fila: ${ring.queued}`);
    const snap = await ring.snapshot();
    const out = await snap.frames();
    snap.release();
    assert.ok(out[0].key && out[0].video);
    await ring.dispose();
  }),
);

test(
  'si limpian la cache del launcher mientras se juega, sigue funcionando',
  withDir(async (dir) => {
    const { frames } = framesOf({ seconds: 30, audio: false });
    const ring = new ReplayRing({ dir, seconds: 60, segmentSeconds: 2 });
    frames.filter((f) => f.time < 10000).forEach((f) => ring.add(f));
    await ring.sync();
    // Lo mismo que hace app:clearCache. El archivo abierto (el del segmento actual) puede no dejarse borrar en todos
    // los sistemas: lo que importa es que lo demas siga andando.
    const held = ring.current?.fh;
    if (held) {
      await held.close();
      ring.current.fh = null;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    frames.filter((f) => f.time >= 10000).forEach((f) => ring.add(f));
    await ring.sync();
    assert.equal(ring.error, null);
    const snap = await ring.snapshot();
    const out = await snap.frames();
    snap.release();
    assert.ok(out.length > 100, 'quedan los cuadros nuevos');
    assert.ok(out[0].key && out[0].video);
    await ring.dispose();
  }),
);

test(
  'del buffer al archivo final: un clip de 5 minutos sin armarlo en memoria',
  withDir(async (dir, root) => {
    const { header, frames } = framesOf({ seconds: 320, base: 90000, size: 40 });
    const ring = new ReplayRing({ dir, seconds: 300 });
    ring.setHeader(header);
    frames.forEach((f) => ring.add(f));
    const snap = await ring.snapshot();
    const file = path.join(root, 'clip.webm');
    const rec = new RecordingFile(file, header, { reserve: 64 * 1024, frameDur: 33 });
    await rec.open();
    let largest = 0;
    let batches = 0;
    for await (const batch of snap.batches()) {
      batches++;
      largest = Math.max(largest, batch.reduce((a, f) => a + f.bytes.length, 0));
      for (const f of batch) rec.add(f);
      await rec.drain();
    }
    const res = await rec.finish();
    snap.release();
    assert.equal(res.empty, false);
    assert.equal(res.error, null);
    assert.ok(batches >= 25, `de a segmentos: ${batches}`);
    const out = fs.readFileSync(file);
    assert.ok(largest < out.length / 10, 'nunca se tuvo mas de un pedazo chico en memoria');
    // Se lee de nuevo: empieza en 0 con un cuadro clave, dura 5 minutos y tiene indice y tamanio
    const again = new webm.WebmReader().push(out);
    assert.equal(again.frames[0].time, 0);
    assert.ok(again.frames[0].video && again.frames[0].key);
    const d = webm.describeHeader(again.header.info, again.header.tracks);
    assert.ok(d.duration >= 300000 && d.duration <= 302100, `duracion ${d.duration}`);
    const eb = webm.readHeader(out, 0);
    const seg = webm.readHeader(out, eb.head + eb.size);
    assert.equal(seg.size, out.length - (eb.head + eb.size + seg.head));
    await ring.dispose();
    assert.ok(!fs.existsSync(dir), 'el buffer no deja nada');
    assert.ok(fs.existsSync(file), 'el clip queda');
  }),
);
