'use strict';
// Dibuja las capas de Venus: arte propio hecho con código, sin nada copiado de ningún juego ni de otros mods. Sin dependencias.
//   node make-capes.js   (desde mod/venus-badge)
// Deja un PNG de 64x32 por capa en src/main/resources/assets/venusbadge/textures/cape/ (lo que dibuja el mod) y los mismos
// PNG como data: en src/renderer/js/features/capes/textures.js (la vista previa de la tienda). Siempre sale lo mismo: el
// azar tiene semilla. Para sumar una capa: docs/wip/capas-34.md.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const W = 64;
const H = 32;
const OUT_MOD = path.join(__dirname, 'src', 'main', 'resources', 'assets', 'venusbadge', 'textures', 'cape');
const OUT_APP = path.join(__dirname, '..', '..', 'src', 'renderer', 'js', 'features', 'capes', 'textures.js');

// ---------- PNG ----------
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8 bits, RGBA
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) px.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- Ayudas de dibujo ----------
const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
const mix = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.min(1, Math.max(0, k))));
const shade = (c, k) => c.map((v) => Math.min(255, Math.max(0, Math.round(v * k))));

// Gradiente por tramos: stops = ['#rrggbb', ...] parejos entre 0 y 1
function ramp(stops, k) {
  const list = stops.map(hex);
  const t = Math.min(0.9999, Math.max(0, k)) * (list.length - 1);
  const i = Math.floor(t);
  return mix(list[i], list[i + 1], t - i);
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Ruido suave de valores (cuadrícula con interpolación): manchas para nebulosas y cortinas
function noise2(seed, cell) {
  const r = rng(seed);
  const table = Array.from({ length: 256 }, () => r());
  const at = (x, y) => table[(x * 31 + y * 17 + 7) & 255];
  const smooth = (t) => t * t * (3 - 2 * t);
  return (x, y) => {
    const fx = x / cell;
    const fy = y / cell;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const sx = smooth(fx - x0);
    const sy = smooth(fy - y0);
    const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
    const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
    return top + (bottom - top) * sy;
  };
}

// Estrellas fijas para un paño de w x h: Map 'x,y' -> brillo
function stars(seed, w, h, count) {
  const r = rng(seed);
  const out = new Map();
  for (let i = 0; i < count; i++) out.set(`${Math.floor(r() * w)},${Math.floor(r() * h)}`, 0.8 + r() * 0.2);
  return out;
}

// ---------- Arte ----------
// Cada capa es una función (x, y, w, h) -> [r, g, b] que pinta un paño: se usa con la tela de la capa (10x16) y con el ala
// del elytra (10x20), así que el dibujo tiene que aguantar los dos tamaños. x e y van desde el borde de arriba a la izquierda.
const CAPES = {
  // Amanecer sobre Venus: el cielo pasa de índigo a oro y el planeta asoma abajo.
  dawn: {
    trim: '#ffc562',
    lining: '#3a1c45',
    art(seed) {
      const sky = stars(seed, 10, 20, 5);
      return (x, y, w, h) => {
        const k = y / (h - 1);
        const cx = (w - 1) / 2;
        const dx = x - cx;
        const dy = y - (h + 1.5);
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < 6.2) return ramp(['#fff0b8', '#ffc562', '#f08a3c'], (y - (h - 5)) / 5);
        if (d < 7.2) return hex('#fff0b8');
        const c = ramp(['#1d1447', '#4b1f6b', '#b23a6e', '#f0783c', '#ffc562'], k * 0.92);
        const star = sky.get(`${x},${y}`);
        return star && k < 0.45 ? mix(c, [255, 244, 214], star) : c;
      };
    },
  },
  // Nebulosa: manchas violetas y rosas sobre el negro, con estrellas.
  nebula: {
    trim: '#8f6bff',
    lining: '#120b2e',
    art(seed) {
      const a = noise2(seed, 4);
      const b = noise2(seed + 1, 3);
      const sky = stars(seed + 2, 10, 20, 9);
      return (x, y) => {
        const v = a(x, y) * 0.65 + b(x + 9, y + 3) * 0.35;
        const t = b(x + 2, y + 11);
        const cloud = ramp(['#0d0a26', '#2b1a66', '#6b2fb3', '#d65cc4', '#ffc4ea'], (v - 0.22) * 1.55);
        const c = t > 0.62 ? mix(cloud, hex('#3fa8ff'), (t - 0.62) * 1.6) : cloud;
        const star = sky.get(`${x},${y}`);
        return star ? mix(c, [255, 255, 255], star) : c;
      };
    },
  },
  // Aurora: tres cortinas verdes y turquesas que ondulan y se apagan hacia abajo, sobre la noche polar.
  aurora: {
    trim: '#5cf2c0',
    lining: '#07202b',
    art(seed) {
      const sky = stars(seed + 3, 10, 20, 8);
      return (x, y, w, h) => {
        const k = y / (h - 1);
        const curtain = (base, amp, freq, phase) => 1 - Math.abs(x - (base + Math.sin(y * freq + phase) * amp)) / 1.5;
        const band = Math.max(curtain(1.6, 1.1, 0.55, seed), curtain(5, 1.3, 0.42, seed + 2) * 0.9, curtain(8.2, 0.9, 0.6, seed + 4) * 0.75, 0);
        const fall = k < 0.55 ? 1 : Math.max(0, (1 - k) / 0.45);
        const night = ramp(['#04121f', '#072a3a', '#0c4048'], k);
        const glow = ramp(['#b8ffe6', '#3fe8a8', '#1fb5b0', '#3a6be0'], k);
        const c = mix(night, glow, band * fall);
        const star = sky.get(`${x},${y}`);
        return star && band < 0.15 ? mix(c, [226, 248, 255], star) : c;
      };
    },
  },
  // Magma: roca oscura partida por grietas que brillan más hacia abajo.
  magma: {
    trim: '#ff7a2e',
    lining: '#1c0d0a',
    art(seed) {
      const r = rng(seed);
      const seeds = Array.from({ length: 14 }, () => [r() * 10, r() * 20]);
      return (x, y, w, h) => {
        const k = y / (h - 1);
        // Las grietas son el borde entre las dos piedras más cercanas (celdas de Voronoi)
        const ds = seeds.map(([sx, sy]) => Math.hypot(x - sx, (y / (h - 1)) * 20 - sy)).sort((p, q) => p - q);
        const edge = ds[1] - ds[0];
        const rock = shade(hex('#2a1c1e'), 0.8 + ((x * 7 + y * 13) % 5) * 0.09);
        if (edge > 0.95) return rock;
        const hot = ramp(['#7a1f0c', '#e8501a', '#ffb02e', '#fff0a0'], (0.95 - edge) * (0.75 + k * 0.5));
        return hot;
      };
    },
  },
  // Órbita (Premium): Venus con su anillo dorado sobre el cielo, con ribete de oro.
  orbit: {
    trim: '#ffd86b',
    lining: '#0d1433',
    art(seed) {
      const sky = stars(seed, 10, 20, 7);
      // Anillo de un pixel de grueso: se recorre la elipse inclinada y se anota qué pixel toca cada punto
      const ringFor = (cx, cy) => {
        const out = new Map();
        for (let i = 0; i < 360; i++) {
          const t = (i * Math.PI) / 180;
          const ex = Math.cos(t) * 4.4;
          const ey = Math.sin(t) * 0.8;
          const px = Math.round(cx + ex * Math.cos(-0.45) - ey * Math.sin(-0.45));
          const py = Math.round(cy + ex * Math.sin(-0.45) + ey * Math.cos(-0.45));
          out.set(`${px},${py}`, ey >= 0 ? 'front' : 'back');
        }
        return out;
      };
      const rings = new Map();
      return (x, y, w, h) => {
        const cx = (w - 1) / 2;
        const cy = Math.round((h - 1) * 0.42);
        if (!rings.has(h)) rings.set(h, ringFor(cx, cy));
        const d = Math.hypot(x - cx, y - cy);
        const ring = rings.get(h).get(`${x},${y}`);
        const inPlanet = d < 3.1;
        if (ring === 'front') return hex('#fff0b8');
        if (inPlanet) return ramp(['#ffa040', '#e0662c', '#9c3a22'], (x - cx + (y - cy) + 3) / 6);
        if (ring === 'back') return hex('#d8a23c');
        if (x === 0 || x === w - 1 || y === 0 || y === h - 1) return hex('#b98a2e');
        const c = ramp(['#0b1030', '#141a4a', '#1f1d5c'], y / (h - 1));
        const star = sky.get(`${x},${y}`);
        return star ? mix(c, [255, 240, 200], star) : c;
      };
    },
  },
};

// ---------- La textura ----------
// Las regiones que usan el modelo de la capa (10x16x1, desde 0,0) y el del elytra (10x20x2, desde 22,0).
function drawCape(cape, seed) {
  const px = Buffer.alloc(W * H * 4); // lo que no es de la capa ni del elytra queda transparente
  const set = (x, y, c, alpha = 255) => {
    const i = (y * W + x) * 4;
    px[i] = c[0];
    px[i + 1] = c[1];
    px[i + 2] = c[2];
    px[i + 3] = alpha;
  };
  const fill = (x0, y0, w, h, fn) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const c = fn(x, y, w, h);
      if (c) set(x0 + x, y0 + y, c);
    }
  };
  const art = cape.art(seed);
  const trim = hex(cape.trim);
  const lining = hex(cape.lining);
  const liningAt = (x, y) => shade(lining, 1 + ((x + y) % 2) * 0.12);

  // Capa: la cara de afuera (1,1), el forro (12,1) y los cantos
  fill(1, 1, 10, 16, art);
  fill(12, 1, 10, 16, liningAt);
  fill(1, 0, 10, 1, () => trim); // canto de arriba
  fill(11, 0, 10, 1, () => shade(trim, 0.8)); // canto de abajo
  fill(0, 1, 1, 16, () => shade(trim, 0.9));
  fill(11, 1, 1, 16, () => shade(trim, 0.9));

  // Elytra: ala de 10x20 afinada hacia la punta. La recorta el juego por la transparencia: del lado de la espalda el ala
  // termina antes y del lado de afuera llega hasta abajo. Cara de atrás (36,2), cara del frente (24,2) y cantos.
  const wing = (outer, y) => y < 8 + Math.round((outer * outer) / 9 * 1.33); // outer = 0 junto a la espalda, 9 afuera
  fill(36, 2, 10, 20, (x, y, w, h) => (wing(9 - x, y) ? art(x, y, w, h) : null));
  fill(24, 2, 10, 20, (x, y) => (wing(x, y) ? liningAt(x, y) : null));
  fill(24, 0, 10, 2, () => trim); // canto de arriba
  fill(34, 2, 2, 20, () => shade(trim, 0.9)); // canto de afuera, entero
  fill(22, 2, 2, 8, () => shade(trim, 0.9)); // canto de la espalda, solo hasta donde empieza el recorte
  fill(41, 0, 3, 2, () => shade(trim, 0.8)); // canto de abajo, solo la punta
  return px;
}

function main() {
  const seeds = { dawn: 11, nebula: 21, aurora: 31, magma: 41, orbit: 51 };
  fs.mkdirSync(OUT_MOD, { recursive: true });
  const lines = [];
  for (const [id, cape] of Object.entries(CAPES)) {
    const png = encodePng(drawCape(cape, seeds[id]));
    fs.writeFileSync(path.join(OUT_MOD, `${id}.png`), png);
    lines.push(`  ${id}: 'data:image/png;base64,${png.toString('base64')}',`);
  }
  fs.mkdirSync(path.dirname(OUT_APP), { recursive: true });
  fs.writeFileSync(OUT_APP, ['// Generado por mod/venus-badge/make-capes.js: no se edita a mano. Los mismos PNG que trae el mod.', 'export const CAPE_TEXTURES = {', ...lines, '};', ''].join('\r\n'));
}

main();
