'use strict';
// Sonidos propios del soundboard: node --test "src/main/modules/soundboard/test/"
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SoundStore, sniffAudio, MAX_SOUNDS, MAX_BYTES } = require('../store');

const webm = (size = 64) => {
  const b = Buffer.alloc(size);
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).copy(b);
  return b;
};

function tmpStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venus-soundboard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new SoundStore(path.join(dir, 'soundboard'));
}

test('reconoce el audio por los primeros bytes', () => {
  const pad = (s) => Buffer.concat([Buffer.from(s, 'latin1'), Buffer.alloc(16)]);
  assert.equal(sniffAudio(webm()), 'audio/webm');
  assert.equal(sniffAudio(pad('OggS')), 'audio/ogg');
  assert.equal(sniffAudio(pad('ID3')), 'audio/mpeg');
  assert.equal(sniffAudio(Buffer.concat([Buffer.from('RIFF0000WAVE', 'latin1'), Buffer.alloc(4)])), 'audio/wav');
  assert.equal(sniffAudio(pad('MZ')), null, 'un ejecutable no pasa');
  assert.equal(sniffAudio(Buffer.alloc(4)), null);
});

test('guarda, lee, renombra y borra', async (t) => {
  const s = tmpStore(t);
  assert.deepEqual((await s.list()).items, []);
  const { items } = await s.add({ name: '  Mi   risa ', bytes: new Uint8Array(webm()) });
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'Mi risa');
  assert.equal(items[0].mime, 'audio/webm');
  const id = items[0].id;
  assert.equal((await s.read(id)).length, 64);
  assert.equal((await s.rename(id, 'Otra')).items[0].name, 'Otra');
  await s.setShortcut(`custom:${id}`, 'Alt+1');
  assert.equal((await s.list()).shortcuts[`custom:${id}`], 'Alt+1');
  const after = await s.remove(id);
  assert.deepEqual(after.items, []);
  assert.deepEqual(after.shortcuts, {}, 'el atajo se va con el sonido');
  assert.ok(!fs.existsSync(s.soundPath(id)));
  await assert.rejects(s.read(id), { code: 'not_found' });
});

test('respeta los topes y rechaza lo que no es audio', async (t) => {
  const s = tmpStore(t);
  await assert.rejects(s.add({ name: 'x', bytes: webm(MAX_BYTES + 1) }), { code: 'too_big' });
  await assert.rejects(s.add({ name: 'x', bytes: Buffer.from('MZ esto no es audio') }), { code: 'bad_type' });
  await assert.rejects(s.add({ name: 'x', bytes: 'texto' }), { code: 'bad_type' });
  await assert.rejects(s.add({ name: '   ', bytes: webm() }), { code: 'bad_name' });
  // Altas en paralelo: la cola no deja pasar del tope ni se pisa el indice
  const adds = await Promise.allSettled(Array.from({ length: MAX_SOUNDS + 3 }, (_, i) => s.add({ name: `s${i}`, bytes: webm() })));
  assert.equal(adds.filter((r) => r.status === 'fulfilled').length, MAX_SOUNDS);
  assert.equal(adds.filter((r) => r.reason?.code === 'too_many').length, 3);
  assert.equal((await s.list()).items.length, MAX_SOUNDS);
});

test('un id raro no sale de la carpeta', async (t) => {
  const s = tmpStore(t);
  assert.throws(() => s.soundPath('../../secure'), { code: 'not_found' });
  await assert.rejects(s.read('../../secure'), { code: 'not_found' });
  await assert.rejects(s.remove('../../secure'), { code: 'not_found' });
});

test('los atajos aceptan sonidos del pack y validan el acelerador', async (t) => {
  const s = tmpStore(t);
  assert.equal((await s.setShortcut('ding', 'CommandOrControl+Shift+1')).shortcuts.ding, 'CommandOrControl+Shift+1');
  assert.deepEqual((await s.setShortcut('ding', '')).shortcuts, {});
  await assert.rejects(s.setShortcut('../x', 'Alt+1'), { code: 'bad_shortcut' });
  await assert.rejects(s.setShortcut('ding', 'Alt+<script>'), { code: 'bad_shortcut' });
});
