// Pruebas de la lógica del editor de skins (sin DOM).
// node --test "src/renderer/js/pages/skins/editor/test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SIZE,
  zones,
  zoneAt,
  editable,
  mirrorPoint,
  getPixel,
  setPixel,
  paint,
  floodFill,
  line,
  withLayers,
  opaqueBase,
  cleanUnused,
  blankSkin,
  isBlank,
  newPixels,
  parseHex,
  toHex,
  pushRecent,
  createHistory,
  TRANSPARENT,
} from '../logic.js';

const RED = [255, 0, 0, 255];
const BLUE = [0, 0, 255, 255];

test('las zonas no se superponen y cubren lo esperado', () => {
  for (const v of ['classic', 'slim']) {
    const owner = new Map();
    let area = 0;
    for (const z of zones(v)) {
      const [x0, y0, w, h] = z.rect;
      area += w * h;
      for (let y = y0; y < y0 + h; y++) {
        for (let x = x0; x < x0 + w; x++) {
          assert.ok(x >= 0 && y >= 0 && x < SIZE && y < SIZE, `${z.id} fuera de la textura`);
          assert.equal(owner.has(`${x},${y}`), false, `${z.id} se superpone con ${owner.get(`${x},${y}`)}`);
          owner.set(`${x},${y}`, z.id);
        }
      }
    }
    // 6 partes x 2 capas x 6 caras
    assert.equal(zones(v).length, 72);
    // cabeza 8x8x8 (384 por capa), torso 8x12x4 (352), piernas 4x12x4 (224 c/u), brazos 4x12x4 (224) o 3x12x4 (192)
    const arms = v === 'slim' ? 192 : 224;
    assert.equal(area, 2 * (384 + 352 + 224 * 2 + arms * 2));
  }
});

test('zona de pixeles conocidos', () => {
  assert.equal(zoneAt(8, 8).id, 'head:base:front');
  assert.equal(zoneAt(40, 8).id, 'head:outer:front');
  assert.equal(zoneAt(20, 20).id, 'body:base:front');
  assert.equal(zoneAt(44, 20).id, 'rightArm:base:front');
  assert.equal(zoneAt(36, 52).id, 'leftArm:base:front');
  assert.equal(zoneAt(4, 36).id, 'rightLeg:outer:front');
  assert.equal(zoneAt(0, 0), null); // esquina sin usar
  assert.equal(zoneAt(64, 0), null);
  // en slim, el brazo derecho termina antes: (54, 20) es espalda en clásico y nada en slim
  assert.equal(zoneAt(54, 20, 'classic').id, 'rightArm:base:back');
  assert.equal(zoneAt(54, 20, 'slim'), null);
  assert.equal(editable(8, 8, 'classic', 'outer'), false);
  assert.equal(editable(40, 8, 'classic', 'outer'), true);
  assert.equal(editable(40, 8, 'classic', 'all'), true);
});

test('espejo izquierda/derecha', () => {
  // frente de la cabeza: se refleja sobre sí mismo
  assert.deepEqual(mirrorPoint(8, 8), { x: 15, y: 8 });
  assert.deepEqual(mirrorPoint(11, 12), { x: 12, y: 12 });
  // brazo derecho (frente) -> brazo izquierdo (frente)
  assert.deepEqual(mirrorPoint(44, 20), { x: 39, y: 52 });
  // costado derecho de la cabeza -> costado izquierdo
  assert.equal(zoneAt(mirrorPoint(0, 8).x, mirrorPoint(0, 8).y).id, 'head:base:left');
  // capa exterior del pie izquierdo -> capa exterior del pie derecho
  assert.equal(zoneAt(mirrorPoint(4, 52).x, mirrorPoint(4, 52).y).id, 'rightLeg:outer:front');
  assert.equal(mirrorPoint(0, 0), null);
  // reflejar dos veces vuelve al mismo pixel en todas las zonas y los dos modelos
  for (const v of ['classic', 'slim']) {
    for (const z of zones(v)) {
      const [x0, y0, w, h] = z.rect;
      for (let y = y0; y < y0 + h; y++) {
        for (let x = x0; x < x0 + w; x++) {
          const m = mirrorPoint(x, y, v);
          assert.ok(m, `${v} ${z.id} sin espejo`);
          const mz = zoneAt(m.x, m.y, v);
          assert.equal(mz.layer, z.layer);
          assert.deepEqual(mirrorPoint(m.x, m.y, v), { x, y });
        }
      }
    }
  }
});

test('lápiz, goma y capa activa', () => {
  const px = newPixels();
  assert.deepEqual(paint(px, 8, 8, RED), [{ x: 8, y: 8 }]);
  assert.deepEqual(getPixel(px, 8, 8), RED);
  assert.deepEqual(paint(px, 8, 8, RED), []); // ya estaba
  assert.deepEqual(paint(px, 0, 0, RED), []); // fuera de las zonas
  assert.deepEqual(paint(px, 9, 9, RED, { layer: 'outer' }), []); // capa base con la exterior activa
  const both = paint(px, 44, 20, BLUE, { mirror: true });
  assert.deepEqual(both, [{ x: 44, y: 20 }, { x: 39, y: 52 }]);
  assert.deepEqual(getPixel(px, 39, 52), BLUE);
  paint(px, 8, 8, TRANSPARENT);
  assert.deepEqual(getPixel(px, 8, 8), [0, 0, 0, 0]);
  // un transparente con RGB raro se guarda limpio
  assert.equal(setPixel(px, 9, 9, [10, 20, 30, 0]), false);
});

test('el balde no se sale de la cara', () => {
  const px = newPixels();
  const n = floodFill(px, 8, 8, RED).length;
  assert.equal(n, 64); // el frente de la cabeza entero, nada más
  assert.deepEqual(getPixel(px, 7, 8), [0, 0, 0, 0]); // costado de la cabeza intacto
  assert.deepEqual(getPixel(px, 16, 8), [0, 0, 0, 0]);
  // corta en un borde de otro color
  for (let y = 8; y < 16; y++) setPixel(px, 11, y, BLUE);
  const half = floodFill(px, 8, 8, [0, 255, 0, 255]);
  assert.equal(half.length, 24); // columnas 8..10
  // con espejo pinta el otro lado
  const px2 = newPixels();
  floodFill(px2, 44, 20, RED, { mirror: true });
  assert.deepEqual(getPixel(px2, 36, 52), RED);
  assert.deepEqual(getPixel(px2, 39, 63), RED);
  // capa equivocada o fuera de las zonas: nada
  assert.equal(floodFill(newPixels(), 8, 8, RED, { layer: 'outer' }).length, 0);
  assert.equal(floodFill(newPixels(), 0, 0, RED).length, 0);
});

test('línea sin huecos', () => {
  const pts = line(0, 0, 5, 2);
  assert.deepEqual(pts[0], { x: 0, y: 0 });
  assert.deepEqual(pts[pts.length - 1], { x: 5, y: 2 });
  for (let i = 1; i < pts.length; i++) {
    assert.ok(Math.abs(pts[i].x - pts[i - 1].x) <= 1 && Math.abs(pts[i].y - pts[i - 1].y) <= 1);
  }
  assert.deepEqual(line(3, 3, 3, 3), [{ x: 3, y: 3 }]);
});

test('capas visibles, en blanco y limpieza', () => {
  const px = blankSkin();
  assert.equal(getPixel(px, 8, 8)[3], 255); // base opaca
  assert.equal(getPixel(px, 40, 8)[3], 0); // exterior vacía
  setPixel(px, 40, 8, RED);
  const onlyBase = withLayers(px, { base: true, outer: false });
  assert.equal(getPixel(onlyBase, 40, 8)[3], 0);
  assert.equal(getPixel(onlyBase, 8, 8)[3], 255);
  const onlyOuter = withLayers(px, { base: false, outer: true });
  assert.deepEqual(getPixel(onlyOuter, 40, 8), RED);
  assert.equal(getPixel(onlyOuter, 8, 8)[3], 0);
  // la vista 3D muestra la capa base opaca (lo borrado, negro) y deja la exterior como está
  const shown = opaqueBase(onlyOuter);
  assert.deepEqual(getPixel(shown, 8, 8), [0, 0, 0, 255]);
  assert.deepEqual(getPixel(shown, 40, 8), RED);
  assert.equal(getPixel(shown, 41, 8)[3], 0);
  assert.equal(isBlank(newPixels()), true);
  assert.equal(isBlank(px), false);
  // en slim se borra la columna que no se usa
  const full = newPixels();
  setPixel(full, 54, 20, RED);
  assert.equal(getPixel(cleanUnused(full, 'slim'), 54, 20)[3], 0);
  assert.deepEqual(getPixel(cleanUnused(full, 'classic'), 54, 20), RED);
});

test('colores', () => {
  assert.deepEqual(parseHex('#FF8800'), [255, 136, 0, 255]);
  assert.deepEqual(parseHex('ff8800'), [255, 136, 0, 255]);
  assert.equal(parseHex('#fff'), null);
  assert.equal(toHex([255, 136, 0, 255]), '#ff8800');
  assert.deepEqual(pushRecent(['#000000', '#ffffff'], '#FFFFFF'), ['#ffffff', '#000000']);
  assert.deepEqual(pushRecent([], 'rojo'), []);
  assert.equal(pushRecent(Array.from({ length: 12 }, (_, i) => `#0000${String(i).padStart(2, '0')}`), '#abcdef', 10).length, 10);
});

test('historial de deshacer y rehacer', () => {
  const hist = createHistory({ limit: 3 });
  let px = newPixels();
  assert.equal(hist.canUndo(), false);
  for (let i = 0; i < 5; i++) {
    hist.record(px);
    px = new Uint8ClampedArray(px);
    setPixel(px, 8 + i, 8, RED);
  }
  assert.deepEqual(hist.size, { undo: 3, redo: 0 });
  px = hist.undo(px);
  assert.deepEqual(getPixel(px, 12, 8), [0, 0, 0, 0]);
  assert.deepEqual(getPixel(px, 11, 8), RED);
  assert.equal(hist.canRedo(), true);
  px = hist.redo(px);
  assert.deepEqual(getPixel(px, 12, 8), RED);
  hist.undo(px);
  hist.record(px); // un cambio nuevo borra lo que se podía rehacer
  assert.equal(hist.canRedo(), false);
  assert.equal(hist.redo(px), null);
  hist.clear();
  assert.equal(hist.undo(px), null);
});
