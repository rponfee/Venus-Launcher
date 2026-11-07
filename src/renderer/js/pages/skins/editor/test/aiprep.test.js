// Pruebas de las piezas puras del creador de skins con IA.
// node --test "src/renderer/js/pages/skins/editor/test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';
import { dominantColors, fitSize, base64Bytes, errorKey } from '../aiprep.js';

function image(pixels) {
  const data = new Uint8ClampedArray(pixels.length * 4);
  pixels.forEach(([r, g, b, a = 255], i) => data.set([r, g, b, a], i * 4));
  return data;
}

test('dominantColors: los mas frecuentes primero, sin fondo blanco ni transparente', () => {
  const px = [
    ...Array(50).fill([200, 100, 20]),
    ...Array(30).fill([60, 30, 20]),
    ...Array(80).fill([255, 255, 255]),
    ...Array(90).fill([10, 200, 10, 0]),
    ...Array(5).fill([20, 40, 200]),
  ];
  const out = dominantColors(image(px), 8);
  assert.deepEqual(out, ['#c86414', '#3c1e14', '#1428c8']);
});

test('dominantColors: junta tonos casi iguales y respeta el tope', () => {
  const px = [...Array(10).fill([200, 100, 20]), ...Array(9).fill([205, 104, 22]), ...Array(8).fill([0, 0, 0]), ...Array(7).fill([0, 0, 255])];
  assert.equal(dominantColors(image(px), 8).length, 3);
  assert.equal(dominantColors(image(px), 2).length, 2);
  assert.deepEqual(dominantColors(new Uint8ClampedArray(0)), []);
});

test('fitSize achica el lado mayor y nunca agranda', () => {
  assert.deepEqual(fitSize(1280, 640, 640), { w: 640, h: 320 });
  assert.deepEqual(fitSize(300, 900, 640), { w: 213, h: 640 });
  assert.deepEqual(fitSize(100, 50, 640), { w: 100, h: 50 });
  assert.deepEqual(fitSize(0, 0, 640), { w: 1, h: 1 });
});

test('base64Bytes y errorKey', () => {
  assert.equal(base64Bytes('data:image/png;base64,AAAA'), 4);
  assert.equal(base64Bytes('sin coma'), 0);
  assert.equal(errorKey({ code: 'skinai:bad' }), 'skineditor.aiErr_bad');
  assert.equal(errorKey({ code: 'skinai:otro' }), null);
  assert.equal(errorKey({ code: 'noplan' }), null);
  assert.equal(errorKey(null), null);
});
