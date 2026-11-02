'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const webm = require('../webm');
const { RecordingFile } = require('../recording');
const { makeStream } = require('./fake-webm');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'venus-capture-test-'));
}

test('graba directo al archivo final y al terminar queda con duracion e indice', async () => {
  const dir = tmpDir();
  try {
    const reader = new webm.WebmReader();
    const { header, frames } = reader.push(makeStream({ seconds: 9, base: 120000 }));
    const file = path.join(dir, 'rec.webm');
    const rec = new RecordingFile(file, header, { reserve: 64 * 1024, frameDur: 33 });
    await rec.open();
    // Empieza a mitad de un GOP: lo anterior al primer cuadro clave se descarta
    for (const f of frames.filter((x) => x.time >= 120000 + 500)) rec.add(f);
    assert.ok(rec.duration > 0);
    const res = await rec.finish();
    assert.equal(res.empty, false);
    assert.equal(res.error, null);
    const out = fs.readFileSync(file);
    assert.equal(out.length, res.bytes);
    // Se lee de nuevo: empieza en 0 con un cuadro clave y tiene duracion
    const again = new webm.WebmReader().push(out);
    assert.equal(again.frames[0].time, 0);
    assert.ok(again.frames[0].video && again.frames[0].key);
    const d = webm.describeHeader(again.header.info, again.header.tracks);
    assert.ok(Math.abs(d.duration - res.duration) < 0.001);
    assert.ok(res.duration > 6000 && res.duration < 7100, `duracion ${res.duration}`);
    // Segment con tamanio correcto
    const eb = webm.readHeader(out, 0);
    const seg = webm.readHeader(out, eb.head + eb.size);
    assert.equal(seg.size, out.length - (eb.head + eb.size + seg.head));
    // Terminar dos veces no rompe nada
    assert.equal(await rec.finish(), res);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sin ningun cuadro clave la grabacion queda vacia', async () => {
  const dir = tmpDir();
  try {
    const { header, frames } = new webm.WebmReader().push(makeStream({ seconds: 1 }));
    const rec = new RecordingFile(path.join(dir, 'vacia.webm'), header, { reserve: 8192 });
    await rec.open();
    for (const f of frames.filter((x) => !(x.video && x.key))) rec.add(f);
    const res = await rec.finish();
    assert.equal(res.empty, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no pisa un archivo que ya existe', async () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'ya.webm');
    fs.writeFileSync(file, 'x');
    const { header } = new webm.WebmReader().push(makeStream({ seconds: 1 }));
    await assert.rejects(new RecordingFile(file, header).open(), (e) => e.code === 'EEXIST');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
