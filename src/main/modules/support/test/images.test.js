'use strict';
// Capturas: se acepta por los bytes (no por el nombre), hasta 4 MiB.
const test = require('node:test');
const assert = require('node:assert/strict');
const { sniffImage, checkUpload, safeName, isObjectPath, toBuffer } = require('../images');

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBP'), Buffer.alloc(8)]);

test('tipo por los primeros bytes', () => {
  assert.equal(sniffImage(png), 'image/png');
  assert.equal(sniffImage(jpg), 'image/jpeg');
  assert.equal(sniffImage(webp), 'image/webp');
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
  assert.equal(sniffImage(Buffer.from('GIF89a......')), null);
  assert.equal(sniffImage(Buffer.from('MZ\u0090\u0000............')), null);
  assert.equal(sniffImage(Buffer.alloc(4)), null);
  assert.equal(sniffImage(null), null);
});

test('checkUpload: devuelve extensión por el contenido y rechaza lo demás', () => {
  assert.deepEqual({ mime: checkUpload(png).mime, ext: checkUpload(png).ext }, { mime: 'image/png', ext: 'png' });
  assert.equal(checkUpload(jpg).ext, 'jpg');
  assert.equal(checkUpload(webp).ext, 'webp');
  assert.equal(checkUpload(new Uint8Array(png)).mime, 'image/png');
  assert.equal(checkUpload(new Uint8Array(png).buffer).mime, 'image/png');
  assert.throws(() => checkUpload(Buffer.from('<html></html>............')), { code: 'attach_bad' });
  assert.throws(() => checkUpload(null), { code: 'attach_bad' });
  assert.throws(() => checkUpload('texto'), { code: 'attach_bad' });
  assert.throws(() => checkUpload(Buffer.concat([png, Buffer.alloc(4 * 1024 * 1024)])), { code: 'attach_big' });
  // justo en el tope entra
  assert.equal(checkUpload(Buffer.concat([png, Buffer.alloc(4 * 1024 * 1024 - png.length)])).mime, 'image/png');
});

test('nombre para mostrar: sin carpetas ni caracteres raros y hasta 80', () => {
  assert.equal(safeName('C:\\Users\\yo\\Desktop\\error.png'), 'error.png');
  assert.equal(safeName('../../etc/passwd'), 'passwd');
  assert.equal(safeName('a<b>c:"d|e?f*.png'), 'abcdef.png');
  assert.equal(safeName('   '), 'captura');
  assert.equal(safeName(undefined), 'captura');
  assert.equal(safeName('x'.repeat(200)).length, 80);
  assert.equal(safeName(`a${String.fromCharCode(0)}b.png`), 'ab.png');
});

test('ruta de objeto: <uuid>/<uuid>/<uuid>.<png|jpg|webp>', () => {
  const u = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
  assert.equal(isObjectPath(`${u}/${u}/${u}.png`), true);
  assert.equal(isObjectPath(`${u}/${u}/${u}.webp`), true);
  assert.equal(isObjectPath(`${u}/${u}/${u}.gif`), false);
  assert.equal(isObjectPath(`${u}/${u}.png`), false);
  assert.equal(isObjectPath(`${u}/${u}/../${u}.png`), false);
  assert.equal(isObjectPath(`${u}/${u}/${u}.png/`), false);
  assert.equal(isObjectPath(null), false);
});

test('toBuffer entiende lo que llega por IPC', () => {
  assert.ok(Buffer.isBuffer(toBuffer(new Uint8Array(3))));
  assert.ok(Buffer.isBuffer(toBuffer(new ArrayBuffer(3))));
  assert.equal(toBuffer('x'), null);
});
