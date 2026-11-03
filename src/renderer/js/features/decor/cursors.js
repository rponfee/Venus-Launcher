// Cursores personalizados: pixel art de 16×16 dibujado acá y servido como SVG de 32×32 en una URL data:
// (sin archivos). Cada cursor tiene una variante "normal" y una "pointer" (otro color) para botones y enlaces.
// Las funciones de dibujo no tocan el DOM (se prueban con Node puro); applyCursor() sí.

export const CURSOR_IDS = ['pixel', 'sword', 'pickaxe', 'diamond'];
export const HOTSPOT = [2, 2]; // punto activo (px del SVG de 32×32): la punta queda en la celda (1,1)
export const SIZE = 16; // celdas por lado (cada celda son 2×2 px)

// Paletas: '#' contorno · w/s blanco y su sombra (flecha) · l/c/d diamante claro, medio y oscuro · g oro · h/k madera
const PALETTE = {
  normal: { '#': '#1a120c', w: '#f7f1e8', s: '#cfc3b4', l: '#d9fbff', c: '#4fd6e6', d: '#2596ad', g: '#d9a844', h: '#8a5a2b', k: '#5a371a' },
  // Sobre botones y enlaces: la flecha se vuelve dorada y las herramientas de diamante pasan a oro.
  pointer: { '#': '#1a120c', w: '#ffc562', s: '#d9881e', l: '#ffe9a8', c: '#f2b134', d: '#c47a14', g: '#d9a844', h: '#8a5a2b', k: '#5a371a' },
};

function grid() {
  return Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
}

function set(g, x, y, c) {
  if (x >= 0 && x < SIZE && y >= 0 && y < SIZE) g[y][x] = c;
}

// Contorno oscuro alrededor de lo dibujado (vecinos en cruz), como en los ítems del juego.
function outline(g) {
  const src = g.map((row) => row.slice());
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (src[y][x]) continue;
      const near = [src[y - 1]?.[x], src[y + 1]?.[x], src[y][x - 1], src[y][x + 1]].some((c) => c && c !== '#');
      if (near) g[y][x] = '#';
    }
  }
  return g;
}

// Flecha clásica: ya trae su contorno dibujado a mano (punta en la celda (1,1)).
const ARROW = [
  '................',
  '.#..............',
  '.##.............',
  '.#w#............',
  '.#ww#...........',
  '.#www#..........',
  '.#wwww#.........',
  '.#wwwww#........',
  '.#wwwwww#.......',
  '.#wwwwwww#......',
  '.#wwwwwwww#.....',
  '.#wwww#####.....',
  '.#ww#ww#........',
  '.#w#.#ww#.......',
  '.##...#ww#......',
  '.......###......',
];

function arrow() {
  const g = grid();
  ARROW.forEach((row, y) => [...row].forEach((ch, x) => set(g, x, y, ch === '.' ? null : ch)));
  // una sombra en el borde inferior izquierdo para que no se vea plana
  for (let y = 4; y <= 10; y++) if (g[y][2] === 'w') g[y][2] = 's';
  return g;
}

// Espada de diamante: hoja en diagonal (punta arriba a la izquierda), guarda de oro y mango de madera.
function sword() {
  const g = grid();
  for (let i = 1; i <= 8; i++) {
    set(g, i, i, 'c');
    set(g, i + 1, i, 'l');
    if (i >= 2) set(g, i - 1, i, 'd');
  }
  for (const [x, y] of [[12, 7], [11, 8], [10, 9], [10, 10], [9, 10], [9, 11], [8, 12]]) set(g, x, y, 'g');
  for (const [x, y] of [[11, 11], [12, 12], [13, 13]]) set(g, x, y, 'h');
  set(g, 12, 11, 'k');
  set(g, 13, 12, 'k');
  set(g, 14, 14, 'g');
  return outline(g);
}

// Pico de diamante: cabeza en arco (un cuarto de anillo con las puntas afinadas) que asoma hacia la esquina
// superior izquierda y mango en diagonal hacia abajo a la derecha.
function pickaxe() {
  const g = grid();
  const cx = 8;
  const cy = 8;
  for (let y = 1; y <= 8; y++) {
    for (let x = 1; x <= 8; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d < 6.3 || d > 8.1) continue;
      set(g, x, y, d >= 7.4 ? 'l' : 'c');
    }
  }
  for (const [x, y] of [[4, 3], [3, 4]]) set(g, x, y, 'd');
  for (let i = 4; i <= 14; i++) {
    set(g, i, i, 'h');
    if (i <= 13) set(g, i, i + 1, 'k');
  }
  return outline(g);
}

// Diamante: gema con la cara clara arriba a la izquierda y la base oscura.
function diamond() {
  const g = grid();
  const rows = [
    [1, 2, 8, 'l'],
    [2, 1, 9, 'c'],
    [3, 1, 9, 'c'],
    [4, 1, 9, 'c'],
    [5, 2, 8, 'c'],
    [6, 3, 7, 'd'],
    [7, 4, 6, 'd'],
    [8, 5, 5, 'd'],
  ];
  for (const [y, x0, x1, color] of rows) for (let x = x0; x <= x1; x++) set(g, x, y, color);
  for (const [x, y] of [[1, 2], [2, 2], [3, 2], [1, 3], [2, 3], [1, 4]]) set(g, x, y, 'l');
  for (const [x, y] of [[8, 3], [9, 3], [7, 4], [8, 4], [9, 4], [6, 5], [7, 5], [8, 5]]) set(g, x, y, 'd');
  return outline(g);
}

const SHAPES = { pixel: arrow, sword, pickaxe, diamond };

// Grilla de 16×16 con la letra de la paleta de cada celda (null = transparente); para pruebas y vistas en texto.
export function cursorGrid(id) {
  const make = SHAPES[id];
  return make ? make() : null;
}

// SVG de 32×32 (viewBox de 16 celdas, bordes nítidos): un <path> por color con las corridas horizontales de
// píxeles, para que la URL data: quede corta.
export function cursorSvg(id, variant = 'normal') {
  const make = SHAPES[id];
  if (!make) return null;
  const g = make();
  const pal = PALETTE[variant] || PALETTE.normal;
  const runs = new Map(); // letra -> trazos
  for (let y = 0; y < SIZE; y++) {
    let x = 0;
    while (x < SIZE) {
      const c = g[y][x];
      if (!c) {
        x++;
        continue;
      }
      let w = 1;
      while (x + w < SIZE && g[y][x + w] === c) w++;
      runs.set(c, `${runs.get(c) || ''}M${x} ${y}h${w}v1h-${w}z`);
      x += w;
    }
  }
  const paths = [...runs].map(([c, d]) => `<path fill="${pal[c] || pal['#']}" d="${d}"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 ${SIZE} ${SIZE}" shape-rendering="crispEdges">${paths.join('')}</svg>`;
}

export function cursorDataUrl(id, variant = 'normal') {
  const svg = cursorSvg(id, variant);
  return svg ? `data:image/svg+xml,${encodeURIComponent(svg)}` : null;
}

// Valores para CSS (sin el cursor de respaldo, que lo pone decor.css): { normal, pointer } o null.
export function cursorCss(id) {
  if (!SHAPES[id]) return null;
  const [hx, hy] = HOTSPOT;
  return {
    normal: `url("${cursorDataUrl(id, 'normal')}") ${hx} ${hy}`,
    pointer: `url("${cursorDataUrl(id, 'pointer')}") ${hx} ${hy}`,
  };
}

// Aplica (o quita, con 'default') el cursor a toda la interfaz: variables en <html> que usa decor.css.
export function applyCursor(id) {
  if (typeof document === 'undefined') return false;
  const root = document.documentElement;
  const css = cursorCss(id);
  if (!css) {
    root.removeAttribute('data-dc-cursor');
    root.style.removeProperty('--dc-cursor');
    root.style.removeProperty('--dc-cursor-pointer');
    return false;
  }
  root.style.setProperty('--dc-cursor', css.normal);
  root.style.setProperty('--dc-cursor-pointer', css.pointer);
  root.setAttribute('data-dc-cursor', id);
  return true;
}
