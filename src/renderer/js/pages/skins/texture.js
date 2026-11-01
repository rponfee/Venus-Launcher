// Texturas de la vista previa. Se decodifican solo desde data: (las de la cuenta las baja el proceso
// principal; nunca se dibuja una imagen de la red en un canvas). Se aplican las mismas reglas que el juego:
//  - Las skins viejas de 64x32 pasan a 64x64 copiando en espejo el brazo y la pierna derechos.
//  - En las de 64x32, si la zona del sombrero no tiene ningun pixel transparente, el sombrero no se ve.
//  - La capa base es opaca y la exterior descarta los pixeles casi transparentes (alfa < 0,1).
//  - La capa se dibuja opaca.
import { faceRects, playerParts, flatLayout } from './model.js';

const DATA_PNG = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;

// Copias de Minecraft para las skins de 64x32: [x, y, ancho, alto, destino x, destino y] (en espejo).
const LEGACY_COPIES = [
  [4, 16, 4, 4, 20, 48],
  [8, 16, 4, 4, 24, 48],
  [0, 20, 4, 12, 24, 52],
  [4, 20, 4, 12, 20, 52],
  [8, 20, 4, 12, 16, 52],
  [12, 20, 4, 12, 28, 52],
  [44, 16, 4, 4, 36, 48],
  [48, 16, 4, 4, 40, 48],
  [40, 20, 4, 12, 40, 52],
  [44, 20, 4, 12, 36, 52],
  [48, 20, 4, 12, 32, 52],
  [52, 20, 4, 12, 44, 52],
];

export function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    if (typeof dataUrl !== 'string' || !DATA_PNG.test(dataUrl)) {
      reject(new Error('skins: imagen invalida'));
      return;
    }
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('skins: no se pudo decodificar la imagen'));
    img.src = dataUrl;
  });
}

function canvasOf(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function copyRect(px, sx, sy, w, h, dx, dy) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const from = ((sy + y) * 64 + sx + x) * 4;
      const to = ((dy + y) * 64 + dx + (w - 1 - x)) * 4;
      for (let k = 0; k < 4; k++) px[to + k] = px[from + k];
    }
  }
}

function setOpaque(px, x0, y0, x1, y1) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) px[(y * 64 + x) * 4 + 3] = 255;
}

// Regla vieja del sombrero transparente (zona 32..64 x 0..32 sin ningun pixel con alfa < 128).
function notchHack(px) {
  for (let y = 0; y < 32; y++) for (let x = 32; x < 64; x++) if (px[(y * 64 + x) * 4 + 3] < 128) return;
  for (let y = 0; y < 32; y++) for (let x = 32; x < 64; x++) px[(y * 64 + x) * 4 + 3] = 0;
}

// Skin lista para dibujar: { canvas (64x64), legacy }.
export function normalizeSkin(img) {
  const w = img?.naturalWidth;
  const h = img?.naturalHeight;
  if (w !== 64 || (h !== 64 && h !== 32)) throw new Error('skins: tamano invalido');
  const legacy = h === 32;
  const canvas = canvasOf(64, 64);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, 64, 64);
  const px = data.data;
  if (legacy) for (const [sx, sy, cw, ch, dx, dy] of LEGACY_COPIES) copyRect(px, sx, sy, cw, ch, dx, dy);
  setOpaque(px, 0, 0, 32, 16);
  if (legacy) notchHack(px);
  setOpaque(px, 0, 16, 64, 32);
  setOpaque(px, 16, 48, 48, 64);
  for (let i = 3; i < px.length; i += 4) if (px[i] < 26) px[i] = 0;
  ctx.putImageData(data, 0, 0);
  return { canvas, legacy };
}

// Capa lista para dibujar (64x32, opaca). Acepta 64x32 y sus multiplos (128x64...).
export function normalizeCape(img) {
  const w = img?.naturalWidth;
  const h = img?.naturalHeight;
  if (!w || !h || w !== h * 2 || w % 64 || w > 512) throw new Error('skins: capa invalida');
  const canvas = canvasOf(64, 32);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0, 64, 32);
  const data = ctx.getImageData(0, 0, 64, 32);
  for (let i = 3; i < data.data.length; i += 4) data.data[i] = 255;
  ctx.putImageData(data, 0, 0);
  return canvas;
}

function tokenRgb(name, fallback) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(raw);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16));
  const rgb = /^rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)/i.exec(raw);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : fallback;
}

// Maniqui neutro (propio, no es Steve ni Alex): se ve mientras carga o cuando no hay skin.
export function mannequin() {
  const canvas = canvasOf(64, 64);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const [r, g, b] = tokenRgb('--muted', [173, 151, 129]);
  const shade = { front: 0.62, back: 0.46, right: 0.52, left: 0.52, top: 0.74, bottom: 0.36 };
  for (const part of playerParts('classic')) {
    for (const box of part.boxes) {
      if (box.overlay) continue;
      const [w, h, d] = box.size;
      for (const [face, [x, y, fw, fh]] of Object.entries(faceRects(box.uv[0], box.uv[1], w, h, d))) {
        const k = shade[face];
        ctx.fillStyle = `rgb(${Math.round(r * k)}, ${Math.round(g * k)}, ${Math.round(b * k)})`;
        ctx.fillRect(x, y, fw, fh);
      }
    }
  }
  return { canvas, legacy: false };
}

// Vista plana (frente o espalda) en un canvas de 16x32 pixeles por "scale".
export function drawFlat(target, skin, variant = 'classic', { side = 'front', scale = 4 } = {}) {
  target.width = 16 * scale;
  target.height = 32 * scale;
  const ctx = target.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, target.width, target.height);
  for (const { rect, x, y } of flatLayout(variant, side)) {
    const [sx, sy, w, h] = rect;
    ctx.drawImage(skin, sx, sy, w, h, x * scale, y * scale, w * scale, h * scale);
  }
  return target;
}

// Frente de la capa (10x16) para las miniaturas del selector.
export function drawCapeFront(target, cape, scale = 4) {
  target.width = 10 * scale;
  target.height = 16 * scale;
  const ctx = target.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(cape, 1, 1, 10, 16, 0, 0, 10 * scale, 16 * scale);
  return target;
}
