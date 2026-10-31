// Pruebas de la verificación de Stripe-Signature (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  bytesToHex,
  parseSignatureHeader,
  signatureHeader,
  signedPayload,
  timingSafeEqual,
  verifyStripeSignature,
} from '../signature.ts';

const SECRET = 'whsec_test_secreto_principal_0123456789';
const OTHER = 'whsec_test_otro_secreto_9876543210';
const NOW_MS = Date.UTC(2026, 9, 27, 12, 0, 0);
const T = Math.floor(NOW_MS / 1000);
const enc = new TextEncoder();
const BODY = enc.encode('{"id":"evt_1","type":"invoice.paid","data":{"object":{"id":"in_1","customer_name":"Ñandú Pérez"}}}');

function nodeSignature(secret: string, timestamp: number, body: Uint8Array): string {
  return createHmac('sha256', secret).update(Buffer.concat([Buffer.from(`${timestamp}.`), Buffer.from(body)])).digest('hex');
}

const verify = (body: Uint8Array, header: string | null, secrets = [SECRET], nowMs = NOW_MS) =>
  verifyStripeSignature(body, header, secrets, { toleranceSec: 300, nowMs });

test('firma válida: coincide con el HMAC-SHA256 de Node sobre "<t>.<cuerpo crudo>"', async () => {
  const header = await signatureHeader(SECRET, T, BODY);
  assert.equal(header, `t=${T},v1=${nodeSignature(SECRET, T, BODY)}`);
  assert.deepEqual(await verify(BODY, header), { ok: true, timestamp: T });
});

test('cuerpo alterado (aunque sea un byte o un espacio): mismatch', async () => {
  const header = await signatureHeader(SECRET, T, BODY);
  const tampered = new Uint8Array(BODY);
  tampered[10] ^= 1;
  assert.deepEqual(await verify(tampered, header), { ok: false, reason: 'mismatch' });
  const spaced = enc.encode(new TextDecoder().decode(BODY) + ' ');
  assert.deepEqual(await verify(spaced, header), { ok: false, reason: 'mismatch' });
});

test('firma alterada, otro secreto o timestamp cambiado: mismatch', async () => {
  const good = nodeSignature(SECRET, T, BODY);
  const flipped = (good[0] === 'a' ? 'b' : 'a') + good.slice(1);
  assert.deepEqual(await verify(BODY, `t=${T},v1=${flipped}`), { ok: false, reason: 'mismatch' });
  assert.deepEqual(await verify(BODY, `t=${T},v1=${nodeSignature(OTHER, T, BODY)}`), { ok: false, reason: 'mismatch' });
  // La misma firma con otro t (para "rejuvenecer" un evento viejo) no sirve.
  assert.deepEqual(await verify(BODY, `t=${T + 1},v1=${good}`), { ok: false, reason: 'mismatch' });
});

test('timestamp viejo (más de 300 s) o del futuro: rechazado aunque la firma sea correcta', async () => {
  const old = T - 301;
  assert.deepEqual(await verify(BODY, await signatureHeader(SECRET, old, BODY)), { ok: false, reason: 'timestamp_out_of_range' });
  const limit = T - 300;
  assert.equal((await verify(BODY, await signatureHeader(SECRET, limit, BODY))).ok, true);
  const future = T + 301;
  assert.deepEqual(await verify(BODY, await signatureHeader(SECRET, future, BODY)), { ok: false, reason: 'timestamp_out_of_range' });
  // Un evento viejo con la firma alterada da mismatch (primero se valida la firma, como el SDK de Stripe).
  assert.deepEqual(await verify(BODY, `t=${old},v1=${'0'.repeat(64)}`), { ok: false, reason: 'mismatch' });
});

test('varias v1: alcanza con que una coincida (rotación del secreto); v0 se ignora', async () => {
  const good = nodeSignature(SECRET, T, BODY);
  const wrong = nodeSignature(OTHER, T, BODY);
  assert.equal((await verify(BODY, `t=${T},v1=${wrong},v1=${good}`)).ok, true);
  assert.equal((await verify(BODY, `t=${T},v0=${good},v1=${wrong},v1=${good.toUpperCase()}`)).ok, true);
  assert.deepEqual(await verify(BODY, `t=${T},v0=${good}`), { ok: false, reason: 'no_signature' });
  assert.deepEqual(await verify(BODY, `t=${T},v1=${wrong},v1=${wrong}`), { ok: false, reason: 'mismatch' });
});

test('varios secretos configurados (prueba y producción, o rotación): vale cualquiera', async () => {
  const header = await signatureHeader(OTHER, T, BODY);
  assert.equal((await verify(BODY, header, [SECRET, OTHER])).ok, true);
  assert.equal((await verify(BODY, header, [SECRET])).ok, false);
});

test('sin firma, sin secreto o con la cabecera mal formada: rechazado', async () => {
  const good = nodeSignature(SECRET, T, BODY);
  assert.deepEqual(await verify(BODY, null), { ok: false, reason: 'missing_header' });
  assert.deepEqual(await verify(BODY, ''), { ok: false, reason: 'missing_header' });
  assert.deepEqual(await verify(BODY, await signatureHeader(SECRET, T, BODY), []), { ok: false, reason: 'no_secret' });
  assert.deepEqual(await verify(BODY, `v1=${good}`), { ok: false, reason: 'no_timestamp' });
  assert.deepEqual(await verify(BODY, `t=abc,v1=${good}`), { ok: false, reason: 'no_timestamp' });
  assert.deepEqual(await verify(BODY, `t=${T}`), { ok: false, reason: 'no_signature' });
  assert.deepEqual(await verify(BODY, `t=${T},v1=xyz`), { ok: false, reason: 'no_signature' });
  assert.deepEqual(await verify(BODY, `t=${T},v1=${good.slice(0, 63)}`), { ok: false, reason: 'no_signature' });
  assert.deepEqual(await verify(BODY, 'basura sin formato'), { ok: false, reason: 'no_timestamp' });
});

test('parseSignatureHeader: espacios, orden y partes desconocidas', () => {
  const sig = 'a'.repeat(64);
  assert.deepEqual(parseSignatureHeader(` v1=${sig} , t=${T} , scheme=x, v1=${'B'.repeat(64)}`), { timestamp: T, v1: [sig, 'b'.repeat(64)] });
  assert.deepEqual(parseSignatureHeader(`t=${T},t=1`), { timestamp: T, v1: [] });
  assert.deepEqual(parseSignatureHeader(null), { timestamp: null, v1: [] });
});

test('timingSafeEqual y signedPayload', () => {
  assert.equal(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])), true);
  assert.equal(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])), false);
  assert.equal(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3])), false);
  assert.equal(new TextDecoder().decode(signedPayload(5, enc.encode('{}'))), '5.{}');
  assert.equal(bytesToHex(new Uint8Array([0, 15, 255])), '000fff');
});
