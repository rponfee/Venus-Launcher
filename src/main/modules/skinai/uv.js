'use strict';
// Mapa UV de una skin de Minecraft de 64x64 (modelo clasico o slim): que rectangulo es cada cara de cada parte.
// Es la misma geometria que usa el editor (renderer/js/pages/skins/model.js); skinai/test/uv.test.js comprueba
// que las dos coincidan. Sirve para dos cosas: explicarle a la IA donde va cada cosa y descartar lo que dibuje
// fuera de las zonas que el juego usa.
const SIZE = 64;
const FACES = ['top', 'bottom', 'right', 'front', 'left', 'back'];

// [id, capa, u, v, ancho, alto, profundidad]; el brazo slim mide 3 de ancho
function boxes(variant) {
  const arm = variant === 'slim' ? 3 : 4;
  return [
    ['head', 'base', 0, 0, 8, 8, 8],
    ['hat', 'outer', 32, 0, 8, 8, 8],
    ['body', 'base', 16, 16, 8, 12, 4],
    ['jacket', 'outer', 16, 32, 8, 12, 4],
    ['rightArm', 'base', 40, 16, arm, 12, 4],
    ['rightSleeve', 'outer', 40, 32, arm, 12, 4],
    ['leftArm', 'base', 32, 48, arm, 12, 4],
    ['leftSleeve', 'outer', 48, 48, arm, 12, 4],
    ['rightLeg', 'base', 0, 16, 4, 12, 4],
    ['rightPants', 'outer', 0, 32, 4, 12, 4],
    ['leftLeg', 'base', 16, 48, 4, 12, 4],
    ['leftPants', 'outer', 0, 48, 4, 12, 4],
  ];
}

// [x, y, ancho, alto] de cada cara de una caja
function faceRects(u, v, w, h, d) {
  return {
    top: [u + d, v, w, d],
    bottom: [u + d + w, v, w, d],
    right: [u, v + d, d, h],
    front: [u + d, v + d, w, h],
    left: [u + d + w, v + d, d, h],
    back: [u + d + w + d, v + d, w, h],
  };
}

function zones(variant = 'classic') {
  const v = variant === 'slim' ? 'slim' : 'classic';
  const list = [];
  for (const [part, layer, u, vv, w, h, d] of boxes(v)) {
    const rects = faceRects(u, vv, w, h, d);
    for (const face of FACES) list.push({ id: `${part}:${face}`, part, layer, face, rect: rects[face] });
  }
  return list;
}

// Int8Array(4096): 0 = el juego no usa ese pixel, 1 = capa base, 2 = capa exterior
function layerMap(variant = 'classic') {
  const map = new Int8Array(SIZE * SIZE);
  for (const z of zones(variant)) {
    const [x0, y0, w, h] = z.rect;
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) map[y * SIZE + x] = z.layer === 'base' ? 1 : 2;
  }
  return map;
}

// Texto para la IA: las zonas de la capa base y de la exterior, una por linea
function describeLayout(variant = 'classic') {
  const names = { top: 'top', bottom: 'bottom', right: 'right side', front: 'front', left: 'left side', back: 'back' };
  const lines = [];
  for (const layer of ['base', 'outer']) {
    lines.push(layer === 'base' ? 'BASE LAYER (every pixel must be opaque):' : 'OUTER LAYER (optional overlay; "." = transparent):');
    for (const z of zones(variant).filter((q) => q.layer === layer)) {
      const [x, y, w, h] = z.rect;
      lines.push(`- ${z.part} ${names[z.face]}: x ${x}..${x + w - 1}, y ${y}..${y + h - 1}`);
    }
  }
  return lines.join('\n');
}

module.exports = { SIZE, FACES, zones, faceRects, layerMap, describeLayout };
