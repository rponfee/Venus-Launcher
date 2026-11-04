'use strict';
// Unir WebM (Montaje de la semana) y armar un WebM con cuadros codificados (timelapse), con clips de prueba generados aca.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const webm = require('../../capture/webm');
const { RecordingFile } = require('../../capture/recording');
const { makeStream, simpleBlock, ebmlHeader, info } = require('../../capture/test/fake-webm');
const join = require('../webmjoin');
const { VideoJob } = require('../job');

const { ID, element, uintEl, floatEl, idBytes, UNKNOWN_SIZE } = webm;
const RESERVE = 64 * 1024;

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'venus-clipstudio-test-'));
}

// Un clip como los que guarda capture.js: rearmado con duracion e indice
function writeClip(dir, name, opts) {
  const built = webm.remux(makeStream(opts), { frameDur: 33 });
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.concat(built.parts));
  return file;
}

function readAll(file) {
  const r = new webm.WebmReader();
  const out = r.push(fs.readFileSync(file));
  return { header: out.header, frames: out.frames, duration: webm.describeHeader(out.header.info, out.header.tracks).duration };
}

async function probes(files) {
  return Promise.all(files.map((f) => join.probeFile(f)));
}

test('probeFile lee codec, tamanio, audio y duracion sin leer todo', async () => {
  const dir = tmp();
  try {
    const p = await join.probeFile(writeClip(dir, 'a.webm', { seconds: 6, width: 1280, height: 720 }));
    assert.equal(p.ok, true);
    assert.equal(p.codec, 'V_VP9');
    assert.equal(p.width, 1280);
    assert.equal(p.height, 720);
    assert.equal(p.audio.codec, 'A_OPUS');
    assert.equal(p.audio.channels, 2);
    assert.ok(Math.abs(p.duration - 6) < 0.1, `duracion ${p.duration}`);
    // Sin duracion en el archivo (un flujo crudo de MediaRecorder): la calcula recorriendolo
    const raw = path.join(dir, 'raw.webm');
    fs.writeFileSync(raw, makeStream({ seconds: 4 }));
    const r = await join.probeFile(raw);
    assert.ok(Math.abs(r.duration - 4) < 0.15, `duracion ${r.duration}`);
    // No es un WebM
    const bad = path.join(dir, 'bad.webm');
    fs.writeFileSync(bad, Buffer.from('esto no es un video'));
    assert.equal((await join.probeFile(bad)).ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('planJoin une sin recodificar solo si coinciden codec, tamanio y audio', async () => {
  const dir = tmp();
  try {
    const a = writeClip(dir, 'a.webm', { seconds: 4 });
    const b = writeClip(dir, 'b.webm', { seconds: 4 });
    const noAudio = writeClip(dir, 'c.webm', { seconds: 4, audio: false });
    const small = writeClip(dir, 'd.webm', { seconds: 4, width: 640, height: 360 });
    assert.equal(join.planJoin(await probes([a, b])).mode, 'copy');
    // Un clip sin audio no impide unir: en su tramo hay silencio, y el encabezado sale del que tiene audio
    const mixed = join.planJoin(await probes([noAudio, a]));
    assert.equal(mixed.mode, 'copy');
    assert.equal(mixed.template.path, a);
    const other = join.planJoin(await probes([a, small]));
    assert.equal(other.mode, 'encode');
    assert.equal(other.reason, 'size');
    assert.deepEqual([other.width, other.height], [1280, 720]);
    assert.equal(other.codec, 'V_VP9');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('encodeSize no agranda, respeta 1080p y deja lados pares', () => {
  assert.deepEqual(join.encodeSize([{ width: 1280, height: 720 }, { width: 640, height: 360 }]), { width: 1280, height: 720 });
  assert.deepEqual(join.encodeSize([{ width: 3840, height: 2160 }]), { width: 1920, height: 1080 });
  assert.deepEqual(join.encodeSize([{ width: 1001, height: 501 }]), { width: 1000, height: 500 });
});

test('un tramo empieza en el cuadro clave anterior y corta a la duracion pedida', async () => {
  const dir = tmp();
  try {
    const file = writeClip(dir, 'a.webm', { seconds: 10, keyMs: 2000 });
    const frames = [];
    for await (const f of join.segmentFrames(file, { start: 5, length: 3 })) frames.push(f);
    const video = frames.filter((f) => f.video);
    assert.equal(video[0].key, true);
    assert.equal(video[0].time, 0, 'el primer cuadro queda en cero');
    assert.ok(Math.max(...video.map((f) => f.time)) < 3000, 'no se pasa de lo pedido');
    assert.ok(Math.max(...video.map((f) => f.time)) > 2800);
    assert.ok(frames.every((f) => f.time >= 0), 'sin audio de antes del cuadro clave');
    // El cuadro clave de los 4 s es el ultimo antes de los 5 s: por eso son 3 s desde ahi
    const all = readAll(file).frames.filter((f) => f.video && f.key).map((f) => f.time);
    assert.ok(all.includes(4000));
    // Pedir mas alla del final no rompe: arranca en el ultimo cuadro clave
    const late = [];
    for await (const f of join.segmentFrames(file, { start: 99 })) late.push(f);
    assert.equal(late[0].video && late[0].key, true);
    assert.ok(late.length > 0);
    // Sin recorte, entero
    const whole = [];
    for await (const f of join.segmentFrames(file, { start: 0, length: null })) whole.push(f);
    assert.equal(whole.filter((f) => f.video).length, readAll(file).frames.filter((f) => f.video).length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('copySegment pasa la pista del audio a la del archivo final', () => {
  const buf = makeStream({ seconds: 1 });
  const { frames } = new webm.WebmReader().push(buf);
  const f = frames.find((x) => !x.video);
  const out = join.withTrack(f, 5);
  assert.equal(out.track, 5);
  assert.equal(out.bytes[out.tcPos - 1], 0x80 | 5);
  assert.equal(f.bytes[f.tcPos - 1], 0x80 | 2, 'el cuadro original no cambia');
  assert.equal(join.withTrack(f, 2), f, 'con la misma pista no copia');
});

test('unir clips sin recodificar: tiempos seguidos, duracion total e indice', async () => {
  const dir = tmp();
  try {
    const a = writeClip(dir, 'a.webm', { seconds: 4 });
    const b = writeClip(dir, 'b.webm', { seconds: 6 });
    const c = writeClip(dir, 'c.webm', { seconds: 2, audio: false });
    const list = await probes([a, b, c]);
    const plan = join.planJoin(list);
    assert.equal(plan.mode, 'copy');
    const out = path.join(dir, 'montage.webm');
    const job = new VideoJob({ file: out, header: plan.template.header, tracks: join.tracksOf(plan.template), template: plan.template, segments: list.map((p) => ({ path: p.path, start: 0, length: null, probe: p })) });
    await job.open();
    const seen = [];
    await job.copyAll((p) => seen.push(p));
    const res = await job.finish();
    assert.ok(Math.abs(res.duration - 12) < 0.3, `duracion ${res.duration}`);
    assert.ok(!fs.existsSync(`${out}.part`), 'no queda el temporal');
    assert.ok(seen.at(-1).done >= seen.at(-1).total - 0.001);
    const r = readAll(out);
    assert.ok(Math.abs(r.duration - res.duration * 1000) < 150);
    const video = r.frames.filter((f) => f.video);
    assert.equal(video[0].time, 0);
    for (let i = 1; i < video.length; i++) assert.ok(video[i].time >= video[i - 1].time, 'los tiempos no retroceden');
    // Las costuras: cada tramo empieza despues del anterior, con un cuadro clave
    const keys = video.filter((f) => f.key).map((f) => f.time);
    assert.ok(keys.some((t) => Math.abs(t - 4000) < 120));
    assert.ok(keys.some((t) => Math.abs(t - 10000) < 200));
    // Tiene indice: se puede adelantar
    const head = fs.readFileSync(out);
    const eb = webm.readHeader(head, 0);
    const seg = webm.readHeader(head, eb.head + eb.size);
    const kids = [];
    let pos = eb.head + eb.size + seg.head;
    while (pos < head.length) {
      const h = webm.readHeader(head, pos);
      kids.push(h.id);
      pos += h.head + h.size;
    }
    assert.ok(kids.includes(ID.Cues));
    assert.ok(kids.includes(ID.Cluster));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cancelar borra el temporal y no deja archivo', async () => {
  const dir = tmp();
  try {
    const a = writeClip(dir, 'a.webm', { seconds: 4 });
    const [p] = await probes([a]);
    const out = path.join(dir, 'x.webm');
    const job = new VideoJob({ file: out, header: p.header, tracks: join.tracksOf(p), template: p, segments: [{ path: a, start: 0, length: null, probe: p }] });
    await job.open();
    assert.ok(fs.existsSync(`${out}.part`));
    await job.abort();
    assert.equal(job.cancelled, true);
    assert.ok(!fs.existsSync(`${out}.part`));
    assert.ok(!fs.existsSync(out));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recodificar: la interfaz recibe el video y el audio se copia y se mezcla por tiempo', async () => {
  const dir = tmp();
  try {
    const a = writeClip(dir, 'a.webm', { seconds: 4 });
    const b = writeClip(dir, 'b.webm', { seconds: 4, width: 640, height: 360 });
    const list = await probes([a, b]);
    const plan = join.planJoin(list);
    assert.equal(plan.mode, 'encode');
    const out = path.join(dir, 'montage.webm');
    const header = join.encodedHeader({ width: plan.width, height: plan.height, codec: plan.codec, audioRaw: plan.template.audio.raw });
    const job = new VideoJob({ file: out, header, tracks: { video: 1, audio: 2 }, template: plan.template, segments: list.map((p) => ({ path: p.path, start: 0, length: null, probe: p })) });
    await job.open();
    for (let i = 0; i < list.length; i++) {
      const info2 = job.openSegment(i);
      assert.equal(info2.codec, 'V_VP9');
      assert.equal(info2.width, list[i].width);
      for (;;) {
        const { frames, done } = await job.readVideo(10);
        assert.ok(frames.length <= 10);
        // "Recodifica": devuelve cuadros con el mismo tiempo
        await job.addEncoded(frames.map((f) => ({ time: f.time, key: f.key, data: Buffer.alloc(50, 7) })));
        if (done) break;
      }
    }
    const res = await job.finish();
    assert.ok(Math.abs(res.duration - 8) < 0.3, `duracion ${res.duration}`);
    const r = readAll(out);
    assert.equal(r.header.width, 1280);
    const tracks = join.trackDetails(r.header.tracks);
    assert.deepEqual(tracks.map((t) => [t.number, t.codec]), [[1, 'V_VP9'], [2, 'A_OPUS']]);
    const audio = r.frames.filter((f) => !f.video);
    const video = r.frames.filter((f) => f.video);
    assert.ok(audio.length > 300, `audio ${audio.length}`);
    assert.ok(audio.some((f) => f.time > 7000), 'el audio del segundo clip tambien esta');
    assert.equal(video[0].bytes.at(-1), 7);
    // Mezclado por tiempo: nunca hay audio mucho despues del video que le sigue
    let last = -1;
    for (const f of r.frames) {
      assert.ok(f.time >= last - 40, `orden ${f.time} despues de ${last}`);
      last = Math.max(last, f.time);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('placa de titulo antes de unir: el clip arranca donde termina la placa', async () => {
  const dir = tmp();
  try {
    const a = writeClip(dir, 'a.webm', { seconds: 4 });
    const [p] = await probes([a]);
    const out = path.join(dir, 'montage.webm');
    const job = new VideoJob({ file: out, header: p.header, tracks: join.tracksOf(p), template: p, segments: [{ path: a, start: 0, length: null, probe: p }] });
    await job.open();
    const card = [];
    for (let i = 0; i < 75; i++) card.push({ time: Math.round((i * 1000) / 30), key: i === 0, data: Buffer.alloc(20, 3) });
    await job.addEncoded(card);
    await job.copyAll();
    const res = await job.finish();
    assert.ok(Math.abs(res.duration - 6.5) < 0.3, `duracion ${res.duration}`);
    const video = readAll(out).frames.filter((f) => f.video);
    const firstClip = video.find((f) => f.time > 2480);
    assert.ok(Math.abs(firstClip.time - 2500) < 60, `empieza en ${firstClip.time}`);
    assert.equal(firstClip.key, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cuadros de un codificador: encabezado propio, duracion e indice (timelapse)', async () => {
  const dir = tmp();
  try {
    const out = path.join(dir, 't.webm');
    const job = new VideoJob({ file: out, header: join.encodedHeader({ width: 1920, height: 1080, codec: 'V_VP8' }), tracks: { video: 1, audio: 0 }, frameDur: 42 });
    await job.open();
    const frames = [];
    for (let i = 0; i < 240; i++) frames.push({ time: (i * 1000) / 24, key: i % 48 === 0, data: Uint8Array.from([1, 2, 3, i % 255]) });
    await job.addEncoded(frames);
    const res = await job.finish();
    assert.ok(Math.abs(res.duration - 10) < 0.1, `duracion ${res.duration}`);
    const r = readAll(out);
    assert.equal(r.header.width, 1920);
    assert.equal(r.header.height, 1080);
    assert.equal(join.trackDetails(r.header.tracks)[0].codec, 'V_VP8');
    assert.equal(r.frames.length, 240);
    assert.equal(r.frames.filter((f) => f.key).length, 5);
    assert.deepEqual([...join.framePayload(r.frames[5])], [1, 2, 3, 5]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sin cuadros clave no queda un archivo vacio', async () => {
  const dir = tmp();
  try {
    const out = path.join(dir, 't.webm');
    const job = new VideoJob({ file: out, header: join.encodedHeader({ width: 640, height: 360 }), tracks: { video: 1, audio: 0 } });
    await job.open();
    await assert.rejects(job.finish(), (e) => e.code === 'empty');
    assert.ok(!fs.existsSync(out));
    assert.ok(!fs.existsSync(`${out}.part`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('framePayload entiende BlockGroup', () => {
  // Un flujo con un BlockGroup a mano: cabecera del bloque + datos
  const block = Buffer.concat([Buffer.from([0x81, 0, 0, 0]), Buffer.from([9, 8, 7])]);
  const group = element(ID.BlockGroup, [element(ID.Block, block), uintEl(0x9b, 33)]);
  const tracks = element(ID.Tracks, [element(ID.TrackEntry, [uintEl(ID.TrackNumber, 1), uintEl(0x73c5, 1), uintEl(ID.TrackType, 1), element(ID.CodecID, Buffer.from('V_VP9')), element(ID.Video, [uintEl(ID.PixelWidth, 2), uintEl(ID.PixelHeight, 2)])])]);
  const stream = Buffer.concat([ebmlHeader(), idBytes(ID.Segment), UNKNOWN_SIZE, info(), tracks, idBytes(ID.Cluster), UNKNOWN_SIZE, uintEl(ID.Timecode, 0), group]);
  const { frames } = new webm.WebmReader().push(stream);
  assert.equal(frames.length, 1);
  assert.deepEqual([...join.framePayload(frames[0])], [9, 8, 7]);
  // Y SimpleBlock
  const simple = new webm.WebmReader().push(Buffer.concat([ebmlHeader(), idBytes(ID.Segment), UNKNOWN_SIZE, info(), tracks, idBytes(ID.Cluster), UNKNOWN_SIZE, uintEl(ID.Timecode, 0), simpleBlock(1, 0, true, Buffer.from([4, 5]))]));
  assert.deepEqual([...join.framePayload(simple.frames[0])], [4, 5]);
  assert.ok(floatEl && RESERVE && RecordingFile);
});
