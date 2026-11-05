import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../../../features/communities/media.js';

const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const gif = (w, h) => new Uint8Array([...ascii('GIF89a'), w & 255, w >> 8, h & 255, h >> 8, 0, 0, 0]);
const png = (w, h) => {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...ascii('IHDR')]);
  b.set([w >>> 24, (w >> 16) & 255, (w >> 8) & 255, w & 255, h >>> 24, (h >> 16) & 255, (h >> 8) & 255, h & 255], 16);
  return b;
};
const webpX = (w, h) => { const b = new Uint8Array(40); b.set([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBPVP8X'), 10, 0, 0, 0, 0, 0, 0, 0]); b.set([(w - 1) & 255, ((w - 1) >> 8) & 255, (w - 1) >> 16, (h - 1) & 255, ((h - 1) >> 8) & 255, (h - 1) >> 16], 24); return b; };
const webpL = (w, h) => { const b = new Uint8Array(40); b.set([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBPVP8L'), 0, 0, 0, 0, 0x2f]); const bits = ((w - 1) | ((h - 1) << 14)) >>> 0; b.set([bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >>> 24) & 255], 21); return b; };
const webpLossy = (w, h) => { const b = new Uint8Array(40); b.set([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBPVP8 '), 0, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, w & 255, w >> 8, h & 255, h >> 8]); return b; };

test('tipo y medidas reales por la cabecera', () => {
  assert.deepEqual(M.sniffImage(gif(320, 240)), { mime: 'image/gif', width: 320, height: 240 });
  assert.deepEqual(M.sniffImage(png(640, 480)), { mime: 'image/png', width: 640, height: 480 });
  assert.deepEqual(M.sniffImage(webpX(500, 300)), { mime: 'image/webp', width: 500, height: 300 });
  assert.deepEqual(M.sniffImage(webpL(200, 100)), { mime: 'image/webp', width: 200, height: 100 });
  assert.deepEqual(M.sniffImage(webpLossy(128, 96)), { mime: 'image/webp', width: 128, height: 96 });
  assert.equal(M.sniffImage(new Uint8Array(ascii('MZ\u0090\u0000'))), null);
  assert.equal(M.sniffImage(new Uint8Array(ascii('<svg xmlns="http://www.w3.org/2000/svg"/>'))), null);
  assert.equal(M.sniffImage(null), null);
  assert.equal(M.sniffImage(new Uint8Array(3)), null);
});

test('validar un archivo elegido: tipo, tamaño y dimensiones', () => {
  assert.deepEqual(M.validateMediaFile({ type: 'image/gif', size: 2000 }, gif(320, 240)), { ok: true, value: { mime: 'image/gif', ext: 'gif', width: 320, height: 240 } });
  assert.equal(M.validateMediaFile({ type: 'image/gif', size: 0 }, gif(320, 240)).error, 'media_empty');
  assert.equal(M.validateMediaFile({ type: 'image/gif', size: M.MEDIA_LIMITS.bytes + 1 }, gif(320, 240)).error, 'too_big');
  assert.equal(M.validateMediaFile({ type: 'image/gif', size: M.MEDIA_LIMITS.bytes }, gif(320, 240)).ok, true);
  assert.equal(M.validateMediaFile({ type: 'image/gif', size: 100 }, png(320, 240)).error, 'bad_type', 'el nombre o el tipo dicen una cosa y la cabecera otra');
  assert.equal(M.validateMediaFile({ type: 'video/mp4', size: 100 }, new Uint8Array(40)).error, 'bad_type');
  assert.equal(M.validateMediaFile({ type: '', size: 100 }, gif(320, 240)).ok, true, 'sin tipo declarado manda la cabecera');
  assert.equal(M.validateMediaFile({ type: 'image/gif', size: 100 }, gif(8, 240)).error, 'bad_dimensions');
  assert.equal(M.validateMediaFile({ type: 'image/gif', size: 100 }, gif(320, 1025)).error, 'bad_dimensions');
  assert.equal(M.validateMediaFile({ type: 'image/gif', size: 100 }, gif(1024, 16)).ok, true);
});

test('rutas, nombres y estados', () => {
  assert.equal(M.mediaPath('c1', 'm1', 'gif'), 'c1/m1.gif');
  assert.equal(M.suggestMediaName('mi_gato bailando.GIF'), 'mi gato bailando');
  assert.equal(M.suggestMediaName(`${'x'.repeat(60)}.gif`).length, 40);
  assert.equal(M.suggestMediaName(null), '');
  assert.equal(M.isMediaId('0e0b4f2a-1111-4222-8333-444455556666'), true);
  assert.equal(M.isMediaId('../x'), false);
  assert.equal(M.safeStatus('approved'), 'approved');
  assert.equal(M.safeStatus('<img>'), 'pending');
});

test('un GIF de un mensaje a lo que se dibuja', () => {
  const isKlipy = (u) => typeof u === 'string' && /^https:\/\/static[0-9]*\.klipy\.com\//.test(u);
  assert.deepEqual(M.viewMedia({ kind: 'klipy', url: 'https://static.klipy.com/a.gif' }, isKlipy), { kind: 'klipy', url: 'https://static.klipy.com/a.gif', still: null });
  assert.deepEqual(M.viewMedia({ kind: 'klipy', url: 'https://evil.example/a.gif' }, isKlipy), { kind: 'gone' });
  assert.deepEqual(M.viewMedia({ kind: 'upload', id: 'x', path: 'c/x.gif', name: 'Gato', width: 10, height: 20 }, isKlipy), { kind: 'upload', id: 'x', path: 'c/x.gif', name: 'Gato', width: 10, height: 20 });
  assert.deepEqual(M.viewMedia({ kind: 'upload', id: 'x', unavailable: true }, isKlipy), { kind: 'gone' }, 'pendiente, rechazado o retirado: sin ruta');
  assert.deepEqual(M.viewMedia({ kind: 'upload', id: 'x' }, isKlipy), { kind: 'gone' });
  assert.equal(M.viewMedia(null, isKlipy), null);
  assert.deepEqual(M.viewMedia({ kind: 'otro' }, isKlipy), { kind: 'gone' });
  assert.equal(M.canSeeDetails({ mine: true }, 'member'), true);
  assert.equal(M.canSeeDetails({ mine: false }, 'owner'), true);
  assert.equal(M.canSeeDetails({ mine: false }, 'moderator'), false);
});
