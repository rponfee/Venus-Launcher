// Geometria del jugador en pixeles de Minecraft, con el mapa UV estandar de las skins de 64x64 y de las
// capas de 64x32. Coordenadas de la vista: X hacia la derecha de quien mira (el lado izquierdo del
// personaje), Y hacia abajo y Z hacia quien mira (el frente del personaje). El origen es el centro del
// cuerpo a media altura (16 pixeles sobre los pies). Sin DOM: solo datos.

// Caras de una caja con origen de textura (u, v) y tamano (w, h, d): [x, y, ancho, alto] en la textura.
export function faceRects(u, v, w, h, d) {
  return {
    top: [u + d, v, w, d],
    bottom: [u + d + w, v, w, d],
    right: [u, v + d, d, h],
    front: [u + d, v + d, w, h],
    left: [u + d + w, v + d, d, h],
    back: [u + 2 * d + w, v + d, w, h],
  };
}

// Partes con su punto de giro (pivot) y sus cajas (offset = centro de la caja desde el pivot).
// Capa exterior un poco mas grande, como en el juego: sombrero +0,5 y el resto +0,25 por lado.
export function playerParts(variant = 'classic') {
  const slim = variant === 'slim';
  const aw = slim ? 3 : 4;
  const drop = slim ? 0.5 : 0; // en el juego los brazos finos quedan medio pixel mas abajo
  const ax = slim ? 0.5 : 1;
  const box = (uv, size, offset, extra = {}) => ({ uv, size, offset, ...extra });
  const over = (uv, size, offset, inflate = 0.25) => box(uv, size, offset, { inflate, overlay: true });
  return [
    { id: 'head', pivot: [0, -8, 0], boxes: [box([0, 0], [8, 8, 8], [0, -4, 0]), over([32, 0], [8, 8, 8], [0, -4, 0], 0.5)] },
    { id: 'body', pivot: [0, -8, 0], boxes: [box([16, 16], [8, 12, 4], [0, 6, 0]), over([16, 32], [8, 12, 4], [0, 6, 0])] },
    { id: 'rightArm', pivot: [-5, -6 + drop, 0], boxes: [box([40, 16], [aw, 12, 4], [-ax, 4, 0]), over([40, 32], [aw, 12, 4], [-ax, 4, 0])] },
    { id: 'leftArm', pivot: [5, -6 + drop, 0], boxes: [box([32, 48], [aw, 12, 4], [ax, 4, 0]), over([48, 48], [aw, 12, 4], [ax, 4, 0])] },
    { id: 'rightLeg', pivot: [-2, 4, 0], boxes: [box([0, 16], [4, 12, 4], [0, 6, 0]), over([0, 32], [4, 12, 4], [0, 6, 0])] },
    { id: 'leftLeg', pivot: [2, 4, 0], boxes: [box([16, 48], [4, 12, 4], [0, 6, 0]), over([0, 48], [4, 12, 4], [0, 6, 0])] },
  ];
}

// Capa: cuelga de los hombros, detras de la espalda (z = -2), girada 180 grados para que su cara
// "frente" de la textura mire hacia atras, como en el juego.
export function capePart() {
  return { id: 'cape', pivot: [0, -8, -2], boxes: [{ uv: [0, 0], size: [10, 16, 1], offset: [0, 8, -0.5], turn: 180, texture: 'cape' }] };
}

// Vista plana (para miniaturas y para el respaldo sin 3D): [region de la textura, x, y] en un lienzo de
// 16x32 pixeles. side: 'front' o 'back'. Primero la capa base y despues la exterior.
export function flatLayout(variant = 'classic', side = 'front') {
  const aw = variant === 'slim' ? 3 : 4;
  const back = side === 'back';
  const parts = playerParts(variant);
  const at = { head: [4, 0], body: [4, 8], rightLeg: [back ? 8 : 4, 20], leftLeg: [back ? 4 : 8, 20], rightArm: [back ? 12 : 4 - aw, 8], leftArm: [back ? 4 - aw : 12, 8] };
  const base = [];
  const overlay = [];
  for (const p of parts) {
    for (const b of p.boxes) {
      const [w, h, d] = b.size;
      const rect = faceRects(b.uv[0], b.uv[1], w, h, d)[back ? 'back' : 'front'];
      (b.overlay ? overlay : base).push({ part: p.id, rect, x: at[p.id][0], y: at[p.id][1] });
    }
  }
  return [...base, ...overlay];
}
