'use strict';
// Geometria y mapa UV de la vista previa 3D (src/renderer/js/pages/skins/model.js, sin DOM) contra el modelo
// del juego (PlayerModel): cajas, puntos de giro, capa exterior, brazos finos, capa y la vista plana.
// Coordenadas de model.js: origen en el centro del personaje, Y hacia abajo, X hacia el lado izquierdo del
// personaje y Z hacia su frente. En el juego el origen es el cuello (Y = 8 mas arriba) y el frente es -Z.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// model.js es un modulo ES sin imports: se carga desde data: (asi Node no avisa por el tipo del paquete)
const MODEL = `data:text/javascript;base64,${fs.readFileSync(path.join(__dirname, '../../../../renderer/js/pages/skins/model.js')).toString('base64')}`;

// Cajas del juego (addBox) por parte: [texOffs, origen de la caja, tamano, inflado] y el pivot de la parte.
const VANILLA = {
  classic: {
    head: { pivot: [0, 0, 0], boxes: [[[0, 0], [-4, -8, -4], [8, 8, 8], 0], [[32, 0], [-4, -8, -4], [8, 8, 8], 0.5]] },
    body: { pivot: [0, 0, 0], boxes: [[[16, 16], [-4, 0, -2], [8, 12, 4], 0], [[16, 32], [-4, 0, -2], [8, 12, 4], 0.25]] },
    rightArm: { pivot: [-5, 2, 0], boxes: [[[40, 16], [-3, -2, -2], [4, 12, 4], 0], [[40, 32], [-3, -2, -2], [4, 12, 4], 0.25]] },
    leftArm: { pivot: [5, 2, 0], boxes: [[[32, 48], [-1, -2, -2], [4, 12, 4], 0], [[48, 48], [-1, -2, -2], [4, 12, 4], 0.25]] },
    rightLeg: { pivot: [-1.9, 12, 0], boxes: [[[0, 16], [-2, 0, -2], [4, 12, 4], 0], [[0, 32], [-2, 0, -2], [4, 12, 4], 0.25]] },
    leftLeg: { pivot: [1.9, 12, 0], boxes: [[[16, 48], [-2, 0, -2], [4, 12, 4], 0], [[0, 48], [-2, 0, -2], [4, 12, 4], 0.25]] },
  },
};
VANILLA.slim = {
  ...VANILLA.classic,
  rightArm: { pivot: [-5, 2.5, 0], boxes: [[[40, 16], [-2, -2, -2], [3, 12, 4], 0], [[40, 32], [-2, -2, -2], [3, 12, 4], 0.25]] },
  leftArm: { pivot: [5, 2.5, 0], boxes: [[[32, 48], [-1, -2, -2], [3, 12, 4], 0], [[48, 48], [-1, -2, -2], [3, 12, 4], 0.25]] },
};

test('caras de una caja en el mapa UV estandar', async () => {
  const { faceRects } = await import(MODEL);
  assert.deepEqual(faceRects(0, 0, 8, 8, 8), { top: [8, 0, 8, 8], bottom: [16, 0, 8, 8], right: [0, 8, 8, 8], front: [8, 8, 8, 8], left: [16, 8, 8, 8], back: [24, 8, 8, 8] });
  // brazo fino derecho: 3x12x4 en (40, 16)
  assert.deepEqual(faceRects(40, 16, 3, 12, 4), { top: [44, 16, 3, 4], bottom: [47, 16, 3, 4], right: [40, 20, 4, 12], front: [44, 20, 3, 12], left: [47, 20, 4, 12], back: [51, 20, 3, 12] });
});

for (const variant of ['classic', 'slim']) {
  test(`partes del jugador iguales a las del juego (${variant})`, async () => {
    const { playerParts } = await import(MODEL);
    const parts = playerParts(variant);
    assert.deepEqual(parts.map((p) => p.id).sort(), Object.keys(VANILLA[variant]).sort());
    for (const part of parts) {
      const ref = VANILLA[variant][part.id];
      // pivot del juego -> model.js: Y 8 mas arriba; X y Z iguales en el pivot (los pivots tienen Z = 0)
      const [px, py] = ref.pivot;
      assert.ok(Math.abs(part.pivot[0] - px) < 0.11, `${part.id} pivot x`); // las piernas van en +-2 en lugar de +-1,9
      assert.equal(part.pivot[1], py - 8, `${part.id} pivot y`);
      assert.equal(part.pivot[2], 0, `${part.id} pivot z`);
      assert.equal(part.boxes.length, ref.boxes.length);
      part.boxes.forEach((b, i) => {
        const [uv, from, size, inflate] = ref.boxes[i];
        assert.deepEqual(b.uv, uv, `${part.id} uv`);
        assert.deepEqual(b.size, size, `${part.id} tamano`);
        assert.equal(b.inflate || 0, inflate, `${part.id} inflado`);
        assert.equal(Boolean(b.overlay), inflate > 0, `${part.id} capa exterior`);
        // centro de la caja desde el pivot: X igual, Y igual, Z invertida (el frente del juego es -Z)
        const center = from.map((v, k) => v + size[k] / 2);
        assert.deepEqual([b.offset[0], b.offset[1], b.offset[2] + 0], [center[0], center[1], -center[2] + 0], `${part.id} centro`);
      });
    }
  });
}

test('el personaje mide 32 pixeles y queda centrado', async () => {
  const { playerParts } = await import(MODEL);
  let top = Infinity;
  let bottom = -Infinity;
  for (const p of playerParts('classic')) {
    for (const b of p.boxes) {
      if (b.overlay) continue;
      top = Math.min(top, p.pivot[1] + b.offset[1] - b.size[1] / 2);
      bottom = Math.max(bottom, p.pivot[1] + b.offset[1] + b.size[1] / 2);
    }
  }
  assert.equal(top, -16);
  assert.equal(bottom, 16);
});

test('capa: caja 10x16x1 de la textura de 64x32, colgada de la espalda y girada', async () => {
  const { capePart, faceRects } = await import(MODEL);
  const cape = capePart();
  const [box] = cape.boxes;
  assert.deepEqual(box.uv, [0, 0]);
  assert.deepEqual(box.size, [10, 16, 1]);
  assert.equal(box.texture, 'cape');
  assert.equal(box.turn, 180, 'el frente de la textura mira hacia atras');
  assert.deepEqual(cape.pivot, [0, -8, -2], 'en los hombros, pegada a la espalda');
  assert.deepEqual(box.offset, [0, 8, -0.5], 'cuelga 16 pixeles hacia abajo, detras de la espalda');
  assert.deepEqual(faceRects(0, 0, 10, 16, 1).front, [1, 1, 10, 16]);
});

test('vista plana: brazo y pierna derechos a la izquierda de frente y a la derecha de espalda', async () => {
  const { flatLayout } = await import(MODEL);
  const at = (variant, side, part, overlay = false) => flatLayout(variant, side).filter((e) => e.part === part)[overlay ? 1 : 0];
  assert.equal(at('classic', 'front', 'rightArm').x, 0);
  assert.equal(at('classic', 'front', 'leftArm').x, 12);
  assert.equal(at('classic', 'back', 'rightArm').x, 12);
  assert.equal(at('classic', 'back', 'leftArm').x, 0);
  assert.equal(at('slim', 'front', 'rightArm').x, 1, 'el brazo fino queda pegado al cuerpo');
  assert.equal(at('slim', 'back', 'leftArm').x, 1);
  assert.equal(at('classic', 'front', 'rightLeg').x, 4);
  assert.equal(at('classic', 'back', 'rightLeg').x, 8);
  assert.deepEqual(at('classic', 'front', 'head').rect, [8, 8, 8, 8]);
  assert.deepEqual(at('classic', 'back', 'head').rect, [24, 8, 8, 8]);
  assert.deepEqual(at('classic', 'front', 'head', true).rect, [40, 8, 8, 8], 'el sombrero');
  // la capa exterior se dibuja despues de toda la base
  const layout = flatLayout('classic', 'front');
  assert.deepEqual(layout.slice(0, 6).map((e) => e.rect.slice(0, 2)), [[8, 8], [20, 20], [44, 20], [36, 52], [4, 20], [20, 52]]);
  assert.deepEqual(layout.slice(6).map((e) => e.rect.slice(0, 2)), [[40, 8], [20, 36], [44, 36], [52, 52], [4, 36], [4, 52]]);
});
