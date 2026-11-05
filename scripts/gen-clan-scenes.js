'use strict';
// Genera las 12 escenas incluidas de los planes de clan (fondos del chat de texto y escenarios de las salas de voz de una
// comunidad) en src/renderer/assets/scenes/<id>.svg. Es arte propio, dibujado con código: curvas, degradados y un generador
// de números al azar con semilla fija, así que la salida es idéntica en cualquier máquina.
// Uso:  node scripts/gen-clan-scenes.js            escribe los 12 SVG (solo toca los que cambian)
//       node scripts/gen-clan-scenes.js --check    falla (código 1) si lo que hay en disco no coincide con lo generado
// Con require() solo exporta SCENES (los ids, en orden) y generate(); no ejecuta nada.
// Reglas de los SVG: viewBox 1600x900, sin texto, sin imágenes, sin scripts y sin referencias externas; la animación (si hay)
// es CSS embebido, sutil, y se apaga con prefers-reduced-motion. Quedan en LF.
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'src', 'renderer', 'assets', 'scenes');
const SCENES = ['campfire', 'space-station', 'library', 'forest', 'beach', 'neon-city', 'aurora', 'deep-sea', 'desert', 'floating-island', 'crystal-cave', 'snow-cabin'];
const W = 1600;
const H = 900;
const MAX_BYTES = 40 * 1024;

// ---------- números, azar y formato ----------
const num = (v) => String(Math.round(v * 10) / 10);
const num2 = (v) => String(Math.round(v * 100) / 100);

// mulberry32: el mismo número semilla da siempre la misma secuencia
function prng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = (r, a, b) => a + (b - a) * r();
const ri = (r, a, b) => Math.floor(a + (b - a + 1) * r());
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];

// ruido de valores 1D (suave) y su suma por octavas
function valueNoise(r) {
  const T = [];
  for (let i = 0; i < 128; i++) T.push(r());
  const at = (i) => T[((i % 128) + 128) % 128];
  return (x) => {
    const i = Math.floor(x);
    const f = x - i;
    const s = f * f * (3 - 2 * f);
    return at(i) + (at(i + 1) - at(i)) * s;
  };
}
function fbm(nz, x, oct) {
  let a = 1;
  let s = 0;
  let t = 0;
  let fr = 1;
  for (let k = 0; k < oct; k++) {
    s += a * nz(x * fr + k * 17.3);
    t += a;
    a *= 0.5;
    fr *= 2;
  }
  return s / t;
}

// ---------- elementos SVG ----------
const ex = (s) => (s ? ' ' + s : '');
const rect = (x, y, w, h, fill, e) => `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" fill="${fill}"${ex(e)}/>`;
const rrect = (x, y, w, h, rx, fill, e) => `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" rx="${num(rx)}" fill="${fill}"${ex(e)}/>`;
const circ = (x, y, rr, fill, e) => `<circle cx="${num(x)}" cy="${num(y)}" r="${num(rr)}" fill="${fill}"${ex(e)}/>`;
const ell = (x, y, rx, ry, fill, e) => `<ellipse cx="${num(x)}" cy="${num(y)}" rx="${num(rx)}" ry="${num(ry)}" fill="${fill}"${ex(e)}/>`;
const pa = (d, fill, e) => `<path d="${d}" fill="${fill}"${ex(e)}/>`;
const stroke = (d, color, w, e) => `<path d="${d}" fill="none" stroke="${color}" stroke-width="${num(w)}" stroke-linecap="round" stroke-linejoin="round"${ex(e)}/>`;
const grp = (inner, e) => `<g${ex(e)}>${[].concat(inner).join('')}</g>`;
const poly = (pts) => 'M' + pts.map((p) => `${num(p[0])} ${num(p[1])}`).join('L') + 'Z';

// puntitos redondos (estrellas, polvo, burbujas chicas) en un solo trazo: línea de largo casi cero con extremos redondos
function dots(pts, size, color, e) {
  if (!pts.length) return '';
  return `<path d="${pts.map((p) => `M${num(p[0])} ${num(p[1])}h.1`).join('')}" fill="none" stroke="${color}" stroke-width="${num(size)}" stroke-linecap="round"${ex(e)}/>`;
}
// destello de cuatro puntas (curvas hacia el centro)
function sparkle(x, y, s) {
  return `M${num(x)} ${num(y - s)}Q${num(x)} ${num(y)} ${num(x + s)} ${num(y)}Q${num(x)} ${num(y)} ${num(x)} ${num(y + s)}Q${num(x)} ${num(y)} ${num(x - s)} ${num(y)}Q${num(x)} ${num(y)} ${num(x)} ${num(y - s)}Z`;
}

// curva suave (Catmull-Rom pasada a Bézier) por una lista de puntos
function smoothSeg(pts, closed) {
  const n = pts.length;
  const get = (i) => (closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
  let d = '';
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const p0 = get(i - 1);
    const p1 = get(i);
    const p2 = get(i + 1);
    const p3 = get(i + 2);
    d += `C${num(p1[0] + (p2[0] - p0[0]) / 6)} ${num(p1[1] + (p2[1] - p0[1]) / 6)} ${num(p2[0] - (p3[0] - p1[0]) / 6)} ${num(p2[1] - (p3[1] - p1[1]) / 6)} ${num(p2[0])} ${num(p2[1])}`;
  }
  return d;
}
const smooth = (pts, closed) => `M${num(pts[0][0])} ${num(pts[0][1])}${smoothSeg(pts, closed)}${closed ? 'Z' : ''}`;

// loma o colina suave que llena hasta abajo
function ridge(r, o) {
  const { base, amp, scale = 220, oct = 3, step = 40, bottom = H + 12, tilt = 0 } = o;
  const nz = valueNoise(r);
  const pts = [];
  for (let x = -step; x <= W + step; x += step) pts.push([x, base + tilt * (x / W - 0.5) + amp * (fbm(nz, x / scale, oct) - 0.5) * 2]);
  return `${smooth(pts)}L${W + step} ${bottom}L${-step} ${bottom}Z`;
}
// cresta de montaña filosa (poligonal) que llena hasta abajo
function crags(r, o) {
  const { base, amp, scale = 160, step = 18, bottom = H + 12 } = o;
  const nz = valueNoise(r);
  const pts = [];
  for (let x = -step; x <= W + step; x += step) {
    const v = fbm(nz, x / scale, 4);
    pts.push([x, base - amp * (1 - Math.abs(2 * v - 1)) * 1.1 + amp * 0.35]);
  }
  return `M${pts.map((p) => `${num(p[0])} ${num(p[1])}`).join('L')}L${W + step} ${bottom}L${-step} ${bottom}Z`;
}
// forma orgánica cerrada
function blob(cx, cy, rx, ry, r, n, j) {
  const pts = [];
  const cnt = n || 9;
  const jit = j === undefined ? 0.18 : j;
  const a0 = r() * 6.28;
  for (let i = 0; i < cnt; i++) {
    const a = a0 + (i / cnt) * Math.PI * 2;
    const k = 1 + (r() - 0.5) * 2 * jit;
    pts.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k]);
  }
  return smooth(pts, true);
}
// nube de base chata y lomo en bultos
function cloud(x, y, w, h, r) {
  const n = ri(r, 4, 6);
  const xs = [x];
  for (let i = 1; i < n; i++) xs.push(x + (w * (i + rng(r, -0.25, 0.25))) / n);
  xs.push(x + w);
  let d = `M${num(x)} ${num(y)}`;
  for (let i = 0; i < n; i++) {
    const ya = i === 0 ? y : y - h * rng(r, 0.05, 0.3);
    const yb = i === n - 1 ? y : y - h * rng(r, 0.05, 0.3);
    const c = Math.hypot(xs[i + 1] - xs[i], yb - ya);
    const mid = Math.abs(i - (n - 1) / 2) / n;
    const rad = c * (0.54 + mid * 0.5 + r() * 0.1);
    if (i > 0) d += `L${num(xs[i])} ${num(ya)}`;
    d += `A${num(rad)} ${num(rad)} 0 0 1 ${num(xs[i + 1])} ${num(yb)}`;
  }
  return `${d}Q${num(x + w / 2)} ${num(y + h * 0.18)} ${num(x)} ${num(y)}Z`;
}

// pino: capas de ramas que se ensanchan hacia abajo; (x, y) es el pie del tronco. Devuelve la silueta y, si se pide, la nieve.
function pine(x, y, h, w, r, tiers, snow) {
  const top = y - h;
  const span = h * 0.9;
  const tw = Math.max(1.5, w * 0.03);
  const half = (sgn) => {
    const segs = [];
    let p = [x, top];
    for (let k = 0; k < tiers; k++) {
      const oy = Math.min(top + (span * (k + 1.45)) / (tiers + 0.45), top + span);
      const hw = (w / 2) * (0.2 + (0.8 * (k + 1)) / tiers) * (0.88 + 0.24 * r());
      const o = [x + sgn * hw, oy];
      segs.push({ q: true, p0: p, c: [p[0] + (o[0] - p[0]) * 0.18, p[1] + (o[1] - p[1]) * 0.72], p1: o });
      p = o;
      if (k < tiers - 1) {
        const nn = [x + sgn * hw * 0.36, o[1] - span * 0.045];
        segs.push({ q: false, p0: p, p1: nn });
        p = nn;
      }
    }
    return segs;
  };
  const R = half(1);
  const L = half(-1);
  const f = (p) => `${num(p[0])} ${num(p[1])}`;
  let d = `M${f([x, top])}`;
  for (const s of R) d += s.q ? `Q${f(s.c)} ${f(s.p1)}` : `L${f(s.p1)}`;
  const by = top + span;
  d += `L${num(x + tw)} ${num(by)}L${num(x + tw)} ${num(y)}L${num(x - tw)} ${num(y)}L${num(x - tw)} ${num(by)}`;
  for (let i = L.length - 1; i >= 0; i--) {
    const s = L[i];
    d += s.q ? `Q${f(s.c)} ${f(s.p0)}` : `L${f(s.p0)}`;
  }
  d += 'Z';
  if (!snow) return { d, snow: '' };
  // nieve: la parte alta de cada capa, con el borde de abajo en ondas
  let sd = '';
  const cut = (s, t) => {
    const mx = (1 - t) * (1 - t) * s.p0[0] + 2 * (1 - t) * t * s.c[0] + t * t * s.p1[0];
    const my = (1 - t) * (1 - t) * s.p0[1] + 2 * (1 - t) * t * s.c[1] + t * t * s.p1[1];
    return { c: [s.p0[0] + (s.c[0] - s.p0[0]) * t, s.p0[1] + (s.c[1] - s.p0[1]) * t], m: [mx, my] };
  };
  for (let k = 0; k < tiers; k++) {
    const sr = R[k * 2];
    const sl = L[k * 2];
    const t = 0.5 + 0.12 * r();
    const a = cut(sr, t);
    const b = cut(sl, t);
    sd += `M${f(sr.p0)}Q${f(a.c)} ${f(a.m)}`;
    const n = 3;
    for (let i = 1; i <= n; i++) {
      const px = a.m[0] + ((b.m[0] - a.m[0]) * i) / n;
      const py = a.m[1] + ((b.m[1] - a.m[1]) * i) / n + (i < n ? rng(r, -2, 2) : 0);
      const qx = a.m[0] + ((b.m[0] - a.m[0]) * (i - 0.5)) / n;
      const qy = a.m[1] + ((b.m[1] - a.m[1]) * (i - 0.5)) / n + w * 0.018 + 3;
      sd += `Q${num(qx)} ${num(qy)} ${num(px)} ${num(py)}`;
    }
    sd += `Q${f(b.c)} ${f(sl.p0)}Z`;
  }
  return { d, snow: sd };
}

// ---------- contexto de una escena ----------
function makeScene(prefix, seed) {
  const S = { r: prng(seed), defs: [], body: [], css: '' };
  const url = (n) => `url(#${prefix}${n})`;
  const stops = (a) => a.map((s) => `<stop offset="${num2(s[0])}" stop-color="${s[1]}"${s[2] === undefined || s[2] === 1 ? '' : ` stop-opacity="${num2(s[2])}"`}/>`).join('');
  // degradado lineal; abs = true usa coordenadas del lienzo, false usa fracciones de la forma
  S.lin = (n, x1, y1, x2, y2, st, abs = true) => {
    S.defs.push(`<linearGradient id="${prefix}${n}"${abs ? ' gradientUnits="userSpaceOnUse"' : ''} x1="${num2(x1)}" y1="${num2(y1)}" x2="${num2(x2)}" y2="${num2(y2)}">${stops(st)}</linearGradient>`);
    return url(n);
  };
  // degradado radial elíptico en coordenadas del lienzo (rx, ry)
  S.rad = (n, cx, cy, rx, st, ry) => {
    S.defs.push(`<radialGradient id="${prefix}${n}" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="translate(${num(cx)} ${num(cy)}) scale(${num(rx)} ${num(ry || rx)})">${stops(st)}</radialGradient>`);
    return url(n);
  };
  // radial sobre la forma (fracciones)
  S.radB = (n, st, cx = 0.5, cy = 0.5, rr = 0.5) => {
    S.defs.push(`<radialGradient id="${prefix}${n}" cx="${num2(cx)}" cy="${num2(cy)}" r="${num2(rr)}">${stops(st)}</radialGradient>`);
    return url(n);
  };
  // desenfoque gaussiano (la región cubre todo el lienzo)
  S.blur = (n, sd) => {
    S.defs.push(`<filter id="${prefix}${n}" filterUnits="userSpaceOnUse" x="-120" y="-120" width="${W + 240}" height="${H + 240}"><feGaussianBlur stdDeviation="${num(sd)}"/></filter>`);
    return url(n);
  };
  S.def = (s) => S.defs.push(s);
  S.id = (n) => `${prefix}${n}`;
  S.add = (...a) => {
    for (const s of a) if (s) S.body.push(s);
  };
  S.band = (n, y0, y1, color, a, mid) => S.add(rect(0, y0, W, y1 - y0, S.lin(n, 0, y0, 0, y1, [[0, color, 0], [mid === undefined ? 0.5 : mid, color, a], [1, color, 0]])));
  S.toString = () => {
    const css = S.css ? `${S.css}@media (prefers-reduced-motion:reduce){*{animation:none!important}}` : '';
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice">`,
      S.defs.length ? `<defs>\n${S.defs.join('\n')}\n</defs>` : '',
      css ? `<style>${css}</style>` : '',
      S.body.join('\n'),
      '</svg>',
    ]
      .filter(Boolean)
      .join('\n') + '\n';
  };
  return S;
}

// estrellas en tres tamaños; las del centro se rarean para que el texto no pelee con ellas. Titilan con clases t1..t3.
const TWINKLE = '@keyframes tw{0%,100%{opacity:.3}50%{opacity:1}}.t1{animation:tw 5s ease-in-out infinite}.t2{animation:tw 7s ease-in-out -2s infinite}.t3{animation:tw 9s ease-in-out -5s infinite}';
function stars(S, n, y0, y1, o = {}) {
  const r = S.r;
  const av = o.avoid || { x: 800, y: 300, rx: 440, ry: 250 };
  const tint = o.tint || '#dfe8ff';
  const g = [[], [], []];
  const sp = [];
  for (let i = 0; i < n; i++) {
    const x = rng(r, 0, W);
    const y = rng(r, y0, y1);
    const k = r();
    const dx = (x - av.x) / av.rx;
    const dy = (y - av.y) / av.ry;
    if (dx * dx + dy * dy < 1 && r() < 0.6) continue;
    if (k > 0.985 && !(dx * dx + dy * dy < 1)) sp.push([x, y]);
    else g[k < 0.62 ? 0 : k < 0.92 ? 1 : 2].push([x, y]);
  }
  if (!S.css.includes('@keyframes tw')) S.css += TWINKLE;
  const out = [dots(g[0], 1.5, tint, 'opacity=".75" class="t1"'), dots(g[1], 2.2, tint, 'opacity=".85" class="t2"'), dots(g[2], 3, o.bright || '#ffffff', 'opacity=".9" class="t3"')];
  if (sp.length) out.push(pa(sp.map((p) => sparkle(p[0], p[1], rng(r, 7, 11))).join(''), o.bright || '#ffffff', 'opacity=".85" class="t3"'));
  return out.join('\n');
}

// @@ESCENAS@@

const BUILDERS = {};

// ---------- salida ----------
function generate(id) {
  const prefix = id.replace(/[^a-z]/g, '').slice(0, 2) + '-';
  const seeds = { campfire: 1101, 'space-station': 2202, library: 3303, forest: 4404, beach: 5505, 'neon-city': 6606, aurora: 7707, 'deep-sea': 8808, desert: 9909, 'floating-island': 1011, 'crystal-cave': 1112, 'snow-cabin': 1213 };
  const S = makeScene(prefix, seeds[id]);
  BUILDERS[id](S);
  return S.toString();
}

function main() {
  const check = process.argv.includes('--check');
  let bad = 0;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const id of SCENES) {
    if (!BUILDERS[id]) continue;
    const file = path.join(OUT_DIR, `${id}.svg`);
    const svg = generate(id);
    const bytes = Buffer.byteLength(svg);
    if (bytes > MAX_BYTES) {
      console.error(`${id}.svg pesa ${bytes} bytes: el tope es ${MAX_BYTES}.`);
      bad++;
      continue;
    }
    const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (check) {
      if (cur !== svg) {
        console.error(`${id}.svg no coincide con lo que genera el script: corré node scripts/gen-clan-scenes.js`);
        bad++;
      }
      continue;
    }
    if (cur !== svg) fs.writeFileSync(file, svg);
    console.log(`${id}.svg  ${(bytes / 1024).toFixed(1)} KB${cur === svg ? ' (sin cambios)' : ''}`);
  }
  if (check) console.log(bad ? `${bad} escena(s) con problemas.` : `Las ${SCENES.length} escenas coinciden con el generador.`);
  if (bad) process.exit(1);
}

module.exports = { SCENES, generate };
if (require.main === module) main();
