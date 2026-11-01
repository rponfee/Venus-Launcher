'use strict';
// Pruebas del lector de PNG: firma, tamanos, CRC, filtros, tipos de color y deteccion de brazos finos.
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const png = require('../png');
const { encodePng, solid, setRect, skinImage, skinPng } = require('./fixtures');

test('valida 64x64 y 64x32 y rechaza otros tamanos', () => {
  assert.equal(png.check(skinPng('classic', 64)).ok, true);
  assert.equal(png.check(skinPng('classic', 32)).ok, true);
  const big = png.check(encodePng(solid(128, 128)));
  assert.equal(big.ok, false);
  assert.equal(big.code, 'wrongSize');
  assert.equal(png.check(encodePng(solid(32, 64))).code, 'wrongSize');
  assert.equal(png.check(encodePng(solid(64, 48))).code, 'wrongSize');
});

test('rechaza archivos que no son PNG, cortados o con CRC roto', () => {
  assert.equal(png.check(Buffer.from('GIF89a................................')).code, 'notPng');
  assert.equal(png.check(Buffer.alloc(0)).code, 'notPng');
  assert.equal(png.check('no es un buffer').code, 'notPng');
  const good = skinPng();
  // firma alterada
  const badSig = Buffer.from(good);
  badSig[1] = 0x51;
  assert.equal(png.check(badSig).code, 'notPng');
  // cortado antes de IEND
  assert.equal(png.check(good.subarray(0, good.length - 20)).code, 'corrupt');
  // un byte de los datos cambiado: el CRC ya no coincide
  const flipped = Buffer.from(good);
  flipped[60] ^= 0xff;
  assert.equal(png.check(flipped).code, 'corrupt');
  // primer bloque que no es IHDR
  const noIhdr = Buffer.from(good);
  noIhdr.write('IHDX', 12, 'latin1');
  assert.equal(png.check(noIhdr).code, 'corrupt');
});

test('rechaza archivos de mas de 64 KB', () => {
  const big = Buffer.concat([skinPng(), Buffer.alloc(70 * 1024)]);
  assert.equal(png.check(big).code, 'tooBig');
  assert.equal(png.check(big, { maxBytes: 200 * 1024 }).ok, true, 'los datos de mas despues de IEND se ignoran');
});

test('decodifica todos los filtros y tipos de color', () => {
  const img = skinImage('classic', 64);
  for (const filter of [0, 1, 2, 3, 4, 'mixed']) {
    const out = png.decode(encodePng({ ...img, filter }));
    assert.ok(out, `filtro ${filter}`);
    assert.deepEqual(Buffer.from(out.data), img.data, `filtro ${filter}`);
  }
  // RGB sin alfa
  const rgb = solid(64, 32, [10, 20, 30, 255]);
  const outRgb = png.decode(encodePng({ ...rgb, colorType: 2 }));
  assert.deepEqual([...outRgb.data.subarray(0, 4)], [10, 20, 30, 255]);
  // paleta con transparencia
  const pal = setRect(solid(64, 64, [1, 2, 3, 255]), 0, 0, 8, 8, [0, 0, 0, 0]);
  const outPal = png.decode(encodePng({ ...pal, colorType: 3 }));
  assert.deepEqual([...outPal.data.subarray(0, 4)], [0, 0, 0, 0]);
  assert.deepEqual([...outPal.data.subarray(64 * 4 * 10, 64 * 4 * 10 + 4)], [1, 2, 3, 255]);
  // gris
  const gray = solid(64, 32, [77, 77, 77, 255]);
  const outGray = png.decode(encodePng({ ...gray, colorType: 0 }));
  assert.deepEqual([...outGray.data.subarray(0, 4)], [77, 77, 77, 255]);
});

test('datos comprimidos de menos o de mas no se aceptan', () => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(64, 0);
  ihdr.writeUInt32BE(64, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const make = (raw) => {
    const chunk = (type, data) => {
      const head = Buffer.alloc(8);
      head.writeUInt32BE(data.length, 0);
      head.write(type, 4, 'latin1');
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
      return Buffer.concat([head, data, crc]);
    };
    return Buffer.concat([png.SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  };
  assert.equal(png.decode(make(Buffer.alloc(10))), null, 'faltan filas');
  assert.equal(png.decode(make(Buffer.alloc(64 * (64 * 4 + 1) + 4096))), null, 'sobran muchos datos');
  const badFilter = Buffer.alloc(64 * (64 * 4 + 1));
  badFilter[0] = 9;
  assert.equal(png.decode(make(badFilter)), null, 'filtro inexistente');
});

test('adivina brazos finos o clasicos', () => {
  assert.equal(png.guessVariant(png.decode(skinPng('classic'))), 'classic');
  assert.equal(png.guessVariant(png.decode(skinPng('slim'))), 'slim');
  assert.equal(png.guessVariant(png.decode(skinPng('slim', 32))), 'classic', '64x32 es siempre clasica');
  // zonas sin usar pintadas de negro: tambien es slim
  const black = skinImage('classic');
  for (const [x, y, w, h] of png.SLIM_AREAS) setRect(black, x, y, w, h, [0, 0, 0, 255]);
  assert.equal(png.guessVariant(png.decode(encodePng(black))), 'slim');
  assert.equal(png.guessVariant(null), 'classic');
});

test('la huella de pixeles no depende de la compresion ni del color de lo transparente', () => {
  const a = skinImage('classic');
  const b = skinImage('classic');
  setRect(b, 0, 32, 4, 4, [255, 255, 255, 0]); // transparente, otro color
  const ha = png.pixelHash(png.decode(encodePng({ ...a, filter: 0 })));
  const hb = png.pixelHash(png.decode(encodePng({ ...b, filter: 4 })));
  assert.equal(ha, hb);
  const c = setRect(skinImage('classic'), 8, 8, 1, 1, [9, 9, 9, 255]);
  assert.notEqual(png.pixelHash(png.decode(encodePng(c))), ha);
});
