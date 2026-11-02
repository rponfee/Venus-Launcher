// Lienzo 2D del editor de skins: damero en lo transparente, la textura ampliada sin suavizado, la capa que no
// se edita atenuada, la plantilla (contorno de cada zona con el color de su parte; la capa exterior con línea
// punteada), la cuadrícula y el pixel bajo el puntero o el cursor del teclado (y su espejo).
// Los colores salen de los tokens de main.css (siguen al tema de Apariencia).
import { SIZE, zones, zoneAt, mirrorPoint, withLayers } from './logic.js';

const PART_TOKEN = { head: '--accent-hi', body: '--info', rightArm: '--good', leftArm: '--good', rightLeg: '--bad-text', leftLeg: '--bad-text' };
export const LEGEND = [
  { id: 'head', token: '--accent-hi' },
  { id: 'body', token: '--info' },
  { id: 'arms', token: '--good' },
  { id: 'legs', token: '--bad-text' },
];

export function readColors() {
  const cs = getComputedStyle(document.documentElement);
  const get = (n, fb) => cs.getPropertyValue(n).trim() || fb;
  const parts = {};
  for (const [k, v] of Object.entries(PART_TOKEN)) parts[k] = get(v, '#ffc562');
  return {
    check1: get('--surface-2', '#231912'),
    check2: get('--surface-4', '#382a1e'),
    void: get('--bg-0', '#0c0705'),
    line: get('--text', '#fff3e3'),
    accent: get('--accent-hi', '#ffc562'),
    parts,
  };
}

let patternCache = null;
function checker(ctx, z, dpr, colors) {
  const key = `${z}:${dpr}:${colors.check1}:${colors.check2}`;
  if (patternCache?.key === key) return patternCache.pattern;
  const tile = document.createElement('canvas');
  const s = Math.max(2, Math.round(z * dpr));
  tile.width = s;
  tile.height = s;
  const c = tile.getContext('2d');
  c.fillStyle = colors.check1;
  c.fillRect(0, 0, s, s);
  c.fillStyle = colors.check2;
  const half = Math.max(1, Math.floor(s / 2));
  c.fillRect(0, 0, half, half);
  c.fillRect(half, half, s - half, s - half);
  const pattern = ctx.createPattern(tile, 'repeat');
  patternCache = { key, pattern };
  return pattern;
}

const scratch = { canvas: null };
function textureCanvas(px) {
  if (!scratch.canvas) {
    scratch.canvas = document.createElement('canvas');
    scratch.canvas.width = SIZE;
    scratch.canvas.height = SIZE;
  }
  scratch.canvas.getContext('2d').putImageData(new ImageData(px, SIZE, SIZE), 0, 0);
  return scratch.canvas;
}

/**
 * st: { px, variant, show: { base, outer }, layer ('base' | 'outer'), zoom (px por pixel), grid, template,
 *       hover: { x, y } | null, cursor: { x, y } | null, mirror }
 */
export function drawCanvas(canvas, st, colors) {
  const z = st.zoom;
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const W = SIZE * z;
  const back = Math.round(W * dpr);
  if (canvas.width !== back || canvas.height !== back) {
    canvas.width = back;
    canvas.height = back;
  }
  canvas.style.width = `${W}px`;
  canvas.style.height = `${W}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = colors.void;
  ctx.fillRect(0, 0, back, back);
  const list = zones(st.variant);
  const px = (v) => Math.round(v * z * dpr); // pixel de la skin -> pixel del lienzo

  // Damero solo en las zonas de las capas visibles
  ctx.fillStyle = checker(ctx, z, dpr, colors);
  for (const zone of list) {
    if (!st.show[zone.layer]) continue;
    const [x, y, w, h] = zone.rect;
    ctx.fillRect(px(x), px(y), px(x + w) - px(x), px(y + h) - px(y));
  }

  // Textura (las capas ocultas no se dibujan)
  ctx.drawImage(textureCanvas(withLayers(st.px, st.show, st.variant)), 0, 0, back, back);

  // La capa que no se edita queda atenuada
  ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
  for (const zone of list) {
    if (zone.layer === st.layer || !st.show[zone.layer]) continue;
    const [x, y, w, h] = zone.rect;
    ctx.fillRect(px(x), px(y), px(x + w) - px(x), px(y + h) - px(y));
  }

  // Cuadrícula
  if (st.grid && z >= 5) {
    ctx.strokeStyle = colors.line;
    ctx.globalAlpha = z >= 10 ? 0.1 : 0.07;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < SIZE; i++) {
      const p = px(i) + 0.5;
      ctx.moveTo(p, 0);
      ctx.lineTo(p, back);
      ctx.moveTo(0, p);
      ctx.lineTo(back, p);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Plantilla: contorno de cada zona (capa exterior punteada); la zona bajo el puntero, más marcada
  const focus = st.hover || st.cursor;
  const focusZone = focus ? zoneAt(focus.x, focus.y, st.variant) : null;
  if (st.template) {
    ctx.lineWidth = Math.max(1, Math.round(dpr));
    for (const zone of list) {
      const [x, y, w, h] = zone.rect;
      ctx.strokeStyle = colors.parts[zone.part];
      ctx.globalAlpha = zone.layer === st.layer ? 0.85 : 0.4;
      ctx.setLineDash(zone.layer === 'outer' ? [Math.max(2, 3 * dpr), Math.max(2, 2 * dpr)] : []);
      const o = ctx.lineWidth / 2;
      ctx.strokeRect(px(x) + o, px(y) + o, px(x + w) - px(x) - ctx.lineWidth, px(y + h) - px(y) - ctx.lineWidth);
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }
  if (focusZone) {
    const [x, y, w, h] = focusZone.rect;
    ctx.strokeStyle = colors.parts[focusZone.part];
    ctx.lineWidth = Math.max(2, Math.round(2 * dpr));
    const o = ctx.lineWidth / 2;
    ctx.strokeRect(px(x) + o, px(y) + o, px(x + w) - px(x) - ctx.lineWidth, px(y + h) - px(y) - ctx.lineWidth);
  }

  // Pixel bajo el puntero o el cursor, y su espejo
  const mark = (p, dashed) => {
    ctx.save();
    ctx.lineWidth = Math.max(2, Math.round(2 * dpr));
    const o = ctx.lineWidth / 2;
    const [x0, y0, s] = [px(p.x), px(p.y), px(p.x + 1) - px(p.x)];
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
    ctx.strokeRect(x0 - o, y0 - o, s + ctx.lineWidth, s + ctx.lineWidth);
    ctx.strokeStyle = colors.accent;
    if (dashed) ctx.setLineDash([Math.max(2, 2 * dpr), Math.max(2, 2 * dpr)]);
    ctx.strokeRect(x0 + o, y0 + o, Math.max(1, s - ctx.lineWidth), Math.max(1, s - ctx.lineWidth));
    ctx.restore();
  };
  for (const p of [st.hover, st.cursor].filter(Boolean)) {
    mark(p, false);
    if (st.mirror) {
      const m = mirrorPoint(p.x, p.y, st.variant);
      if (m && (m.x !== p.x || m.y !== p.y)) mark(m, true);
    }
  }
}

// Pixel de la skin bajo el puntero, o null si está fuera del lienzo.
export function texelAt(canvas, e) {
  const r = canvas.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const x = Math.floor(((e.clientX - r.left) / r.width) * SIZE);
  const y = Math.floor(((e.clientY - r.top) / r.height) * SIZE);
  return x >= 0 && y >= 0 && x < SIZE && y < SIZE ? { x, y } : null;
}
