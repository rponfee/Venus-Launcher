// Cifrado del respaldo: lo que ve un broker publico, mensajes manipulados, otra sala, mensajes viejos o del futuro.
// node --test "src/renderer/js/voice/test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveRoom, sealFrame, openFrame, fingerprint, newSecret, PAD, FRESH_MS, FRAME_VERSION } from '../seal.js';
import { createIdentity } from '../sign.js';

const SECRET = 'KQ7MXT2PRN9WHJ4EC5VDB8YF';

test('el tema es un hash de la clave: estable, distinto por sala y sin nada legible', async () => {
  const a = await deriveRoom(SECRET);
  const again = await deriveRoom(SECRET);
  const other = await deriveRoom('KQ7MXT2PRN9WHJ4EC5VDB8YG');
  assert.equal(a.topic, again.topic);
  assert.notEqual(a.topic, other.topic);
  assert.match(a.topic, /^vv1\/[0-9a-f]{32}$/);
  assert.ok(!a.topic.toLowerCase().includes(SECRET.slice(0, 6).toLowerCase()));
  await assert.rejects(deriveRoom('corta'), /bad secret/);
  await assert.rejects(deriveRoom(null), /bad secret/);
});

test('ida y vuelta: lo que se cifra se abre igual y trae su hora', async () => {
  const room = await deriveRoom(SECRET);
  const env = { f: 'u1', fs: 's1', ts: 1, n: 'abc', d: '{"k":"desc"}', sig: 'zzz' };
  const frame = await sealFrame(room, { e: 'sig', v: env });
  assert.equal(frame[0], FRAME_VERSION);
  const open = await openFrame(room, frame);
  assert.deepEqual(open.obj.v, env);
  assert.equal(open.obj.e, 'sig');
  assert.ok(Math.abs(open.obj.t - Date.now()) < 5000);
  assert.match(open.id, /^[0-9a-f]{24}$/);
});

test('el broker no ve el contenido ni el tamaño exacto: se redondea a multiplos de PAD', async () => {
  const room = await deriveRoom(SECRET);
  const secretText = 'texto-que-no-debe-aparecer-en-claro';
  const frames = [];
  for (const n of [1, 10, 100, 300, 1000]) frames.push(await sealFrame(room, { e: 'chat', v: { d: `${secretText}${'x'.repeat(n)}` } }));
  for (const f of frames) {
    assert.ok(!Buffer.from(f).toString('latin1').includes('texto-que'), 'sin texto en claro');
    assert.equal((f.length - 1 - 12 - 16) % PAD, 0, 'tamaño redondeado');
  }
  assert.equal(frames[0].length, frames[1].length, 'mensajes cortos pesan lo mismo');
  // mismo contenido, otro marco: IV al azar
  const a = await sealFrame(room, { e: 'chat', v: { x: 1 } });
  const b = await sealFrame(room, { e: 'chat', v: { x: 1 } });
  assert.notDeepEqual(a, b);
  assert.notEqual((await openFrame(room, a)).id, (await openFrame(room, b)).id);
});

test('con otra clave, otro tema o un bit cambiado no se abre', async () => {
  const room = await deriveRoom(SECRET);
  const other = await deriveRoom('KQ7MXT2PRN9WHJ4EC5VDB8YG');
  const frame = await sealFrame(room, { e: 'sig', v: { a: 1 } });
  assert.equal(await openFrame(other, frame), null, 'otra sala');
  // misma clave pero el marco movido a otro tema (el tema va como dato autenticado)
  const moved = { ...room, aad: new TextEncoder().encode('vv1/otro') };
  assert.equal(await openFrame(moved, frame), null, 'marco de otro tema');
  for (const at of [0, 1, 12, 13, 40, frame.length - 1]) {
    const bad = Uint8Array.from(frame);
    bad[at] ^= 1;
    assert.equal(await openFrame(room, bad), null, `byte ${at} cambiado`);
  }
  assert.equal(await openFrame(room, frame.subarray(0, frame.length - 1)), null, 'truncado');
  assert.equal(await openFrame(room, new Uint8Array(0)), null);
  assert.equal(await openFrame(room, 'texto'), null);
  assert.equal(await openFrame(room, crypto.getRandomValues(new Uint8Array(500))), null, 'basura al azar');
});

test('marcos viejos o del futuro se descartan (repeticion de un marco grabado)', async () => {
  const room = await deriveRoom(SECRET);
  const now = Date.now();
  const old = await sealFrame(room, { e: 'sig', v: { a: 1 } }, { now: now - FRESH_MS - 1000 });
  const future = await sealFrame(room, { e: 'sig', v: { a: 1 } }, { now: now + FRESH_MS + 1000 });
  const fine = await sealFrame(room, { e: 'sig', v: { a: 1 } }, { now: now - FRESH_MS + 5000 });
  assert.equal(await openFrame(room, old, { now }), null);
  assert.equal(await openFrame(room, future, { now }), null);
  assert.notEqual(await openFrame(room, fine, { now }), null);
});

test('limites: un mensaje enorme no se manda y uno de 60 KB (SDP) si', async () => {
  const room = await deriveRoom(SECRET);
  await assert.rejects(sealFrame(room, { e: 'sig', v: { d: 'x'.repeat(300 * 1024) } }), RangeError);
  const sdp = await sealFrame(room, { e: 'sig', v: { d: 's'.repeat(60000) } });
  assert.equal((await openFrame(room, sdp)).obj.v.d.length, 60000);
});

test('clave nueva para salas de emergencia: 24 simbolos legibles y distintos cada vez', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const s = newSecret();
    assert.match(s, /^[A-HJ-NP-Z2-9]{24}$/);
    seen.add(s);
  }
  assert.equal(seen.size, 50);
});

test('huella de la clave de sesion: estable, depende solo de la clave y rechaza lo que no es P-256', async () => {
  const a = await createIdentity();
  const b = await createIdentity();
  const fa = await fingerprint(a.publicJwk);
  assert.match(fa, /^[0-9a-f]{20}$/);
  assert.equal(fa, await fingerprint(JSON.parse(a.publicJwk)));
  assert.equal(fa, await fingerprint(JSON.stringify({ ...JSON.parse(a.publicJwk), ext: true }))); // campos de mas no cuentan
  assert.notEqual(fa, await fingerprint(b.publicJwk));
  await assert.rejects(fingerprint('{"kty":"RSA"}'), /bad key/);
  await assert.rejects(fingerprint('no es json'));
});
