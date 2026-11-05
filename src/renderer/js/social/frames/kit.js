// Herramientas para dibujar los marcos de perfil en SVG (4.6). Sin DOM ni dependencias: todo devuelve texto SVG, asi que
// se prueba con Node y sirve igual para la pantalla que para la imagen fija de "Compartir mi perfil".
// Convenciones: viewBox 0 0 100 100; el avatar redondo ocupa el centro (radio HOLE = 40) y el marco se dibuja alrededor;
// 0 grados es arriba y crece en sentido horario. El dibujo quieto se arma solo con atributos; las clases de animacion
// (spin, tw, flk...) las define styles/features/frames.css y solo mueven `transform` y `opacity`.

export const HOLE = 40;

// ---------- Numeros y puntos ----------
export const f = (n) => String(Math.round(n * 100) / 100);
export const rad = (deg) => ((deg - 90) * Math.PI) / 180;
export const pt = (deg, r) => [50 + r * Math.cos(rad(deg)), 50 + r * Math.sin(rad(deg))];
// "x y" de un punto polar, para armar un path
export const P = (deg, r) => {
  const [x, y] = pt(deg, r);
  return `${f(x)} ${f(y)}`;
};
export const lerp = (a, b, t) => a + (b - a) * t;
// Mezcla dos colores #rrggbb (t de 0 a 1)
export function mix(a, b, t) {
  const c = (hex, i) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  return `#${[0, 1, 2].map((i) => Math.round(lerp(c(a, i), c(b, i), t)).toString(16).padStart(2, '0')).join('')}`;
}
// Numero "al azar" repetible (los dibujos tienen que salir siempre iguales)
export const rnd = (i, salt = 1) => {
  const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
};

// ---------- Atributos ----------
const A = (o) =>
  Object.entries(o || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== false)
    .map(([k, v]) => ` ${k}="${v}"`)
    .join('');
// style="--t:8s;--d:-2s" a partir de { t: 8, d: -2 } (segundos)
export function sty(o) {
  return Object.entries(o)
    .map(([k, v]) => `--${k}:${typeof v === 'number' ? `${f(v)}s` : v}`)
    .join(';');
}
// Clase de animacion con su tiempo: an('tw', { t: 2.4, d: -1 })
export const an = (cls, o) => ({ class: cls, style: o ? sty(o) : undefined });

// ---------- Definiciones (degradados y mascaras) ----------
let uid = 'fr';
let count = 0;
let defs = [];
export function begin(prefix) {
  uid = prefix;
  count = 0;
  defs = [];
}
export const takeDefs = () => defs.join('');
const nextId = () => `${uid}${(count++).toString(36)}`;
const stopsTag = (stops) =>
  stops
    .map((s, i) => {
      const [off, color, op] = Array.isArray(s) ? s : [stops.length === 1 ? 0 : i / (stops.length - 1), s];
      return `<stop offset="${f(off)}" stop-color="${color}"${op !== undefined ? ` stop-opacity="${op}"` : ''}/>`;
    })
    .join('');
// Degradado lineal en la caja del elemento; angle como en CSS (0 = hacia arriba, 90 = hacia la derecha)
export function lin(stops, angle = 135) {
  const id = nextId();
  const dx = Math.sin((angle * Math.PI) / 180);
  const dy = -Math.cos((angle * Math.PI) / 180);
  defs.push(`<linearGradient id="${id}" x1="${f(0.5 - dx / 2)}" y1="${f(0.5 - dy / 2)}" x2="${f(0.5 + dx / 2)}" y2="${f(0.5 + dy / 2)}">${stopsTag(stops)}</linearGradient>`);
  return `url(#${id})`;
}
// Degradado radial en la caja del elemento (centro y radio 50 %)
export function rg(stops) {
  const id = nextId();
  defs.push(`<radialGradient id="${id}">${stopsTag(stops)}</radialGradient>`);
  return `url(#${id})`;
}
// Degradado radial en coordenadas del dibujo (para brillos que dependen del radio, no del elemento)
export function rgAbs(stops, r = 50, cx = 50, cy = 50) {
  const id = nextId();
  defs.push(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="${r}">${stopsTag(stops)}</radialGradient>`);
  return `url(#${id})`;
}
// Mascara: lo blanco se ve, lo negro no. Devuelve el valor de `mask`
export function mask(inner) {
  const id = nextId();
  defs.push(`<mask id="${id}" maskUnits="userSpaceOnUse" x="-10" y="-10" width="120" height="120">${inner}</mask>`);
  return `url(#${id})`;
}

// ---------- Formas ----------
export const ring = (r, w, stroke, o) => `<circle cx="50" cy="50" r="${f(r)}" fill="none" stroke="${stroke}" stroke-width="${f(w)}"${A(o)}/>`;
export const disc = (x, y, r, fill, o) => `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" fill="${fill}"${A(o)}/>`;
export const path = (d, o) => `<path d="${d}"${A(o)}/>`;
export const rect = (x, y, w, h, fill, o) => `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" fill="${fill}"${A(o)}/>`;
export const line = (x1, y1, x2, y2, stroke, w, o) => `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke="${stroke}" stroke-width="${f(w)}"${A({ 'stroke-linecap': 'round', ...o })}/>`;
export const ellipse = (cx, cy, rx, ry, o) => `<ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(rx)}" ry="${f(ry)}"${A(o)}/>`;
export const g = (inner, o) => `<g${A(o)}>${Array.isArray(inner) ? inner.join('') : inner}</g>`;
// Lo que va dentro de `fn(deg, i)` repetido n veces alrededor (o en un tramo: span grados desde start)
export const each = (n, fn, start = 0, span = 360) => Array.from({ length: n }, (_, i) => fn(start + (span * i) / n, i)).join('');
// Una animacion CSS pisa el atributo transform de su elemento: por eso lo animado va en un <g> de adentro y la posicion en el de afuera
const joined = (inner) => (Array.isArray(inner) ? inner.join('') : inner);
function placed(transform, inner, o) {
  const { class: cls, style, ...rest } = o || {};
  const body = joined(inner);
  return `<g transform="${transform}"${A(rest)}>${cls || style ? `<g${A({ class: cls, style })}>${body}</g>` : body}</g>`;
}
// Cosa dibujada en el sistema local de un punto del anillo: el origen queda en (deg, r) y -y apunta hacia afuera
export const put = (deg, r, inner, o) => {
  const [x, y] = pt(deg, r);
  return placed(`translate(${f(x)} ${f(y)}) rotate(${f(deg)})`, inner, o);
};
// Cosa dibujada en un punto del dibujo sin girarla (queda derecha)
export const tr = (x, y, inner, o) => placed(`translate(${f(x)} ${f(y)})`, inner, o);

// Arco del anillo de radio r entre dos angulos (hacia la derecha)
export function arcPath(a0, a1, r) {
  const sweep = (((a1 - a0) % 360) + 360) % 360;
  return `M${P(a0, r)}A${f(r)} ${f(r)} 0 ${sweep > 180 ? 1 : 0} 1 ${P(a1, r)}`;
}
// Tramo de corona circular (entre dos radios y dos angulos)
export function bandPath(a0, a1, r0, r1) {
  const sweep = (((a1 - a0) % 360) + 360) % 360;
  const big = sweep > 180 ? 1 : 0;
  return `M${P(a0, r1)}A${f(r1)} ${f(r1)} 0 ${big} 1 ${P(a1, r1)}L${P(a1, r0)}A${f(r0)} ${f(r0)} 0 ${big} 0 ${P(a0, r0)}Z`;
}
// Linea quebrada por puntos [[x,y],...]
export const poly = (pts) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${f(x)} ${f(y)}`).join('');

// Destello de cuatro puntas
export function spark(x, y, s, fill, o) {
  const k = s * 0.18;
  return path(`M${f(x)} ${f(y - s)}Q${f(x + k)} ${f(y - k)} ${f(x + s)} ${f(y)}Q${f(x + k)} ${f(y + k)} ${f(x)} ${f(y + s)}Q${f(x - k)} ${f(y + k)} ${f(x - s)} ${f(y)}Q${f(x - k)} ${f(y - k)} ${f(x)} ${f(y - s)}Z`, { fill, ...o });
}
// Estrella de cinco puntas
export function star5(x, y, r, fill, o) {
  const pts = Array.from({ length: 10 }, (_, i) => {
    const a = (i * Math.PI) / 5 - Math.PI / 2;
    const rr = i % 2 ? r * 0.42 : r;
    return [x + rr * Math.cos(a), y + rr * Math.sin(a)];
  });
  return path(`${poly(pts)}Z`, { fill, ...o });
}
// Marcas alrededor: n rayitas entre dos radios
export function ticks(n, r0, r1, w, stroke, o, every = 0, r2 = 0) {
  return each(n, (a, i) => {
    const [x0, y0] = pt(a, r0);
    const [x1, y1] = pt(a, every && i % every === 0 ? r2 || r1 : r1);
    return line(x0, y0, x1, y1, stroke, w, o);
  });
}
// Brillo suave alrededor del anillo (no tapa al avatar: es transparente adentro)
export function glow(color, op, rIn = 40, rOut = 50, o) {
  const mid = (rIn + (rOut - rIn) * 0.38) / 50;
  return `<circle cx="50" cy="50" r="50" fill="${rgAbs([[0, color, 0], [rIn / 50, color, 0], [mid, color, op], [1, color, 0]])}"${A(o)}/>`;
}

// ---------- Figuras en su sistema local (origen en la base, la punta mira hacia -y) ----------
export const leaf = (s, fill, o) => path(`M0 0C${f(s * 0.7)} ${f(-s * 0.25)} ${f(s * 0.65)} ${f(-s * 0.95)} 0 ${f(-s * 1.4)}C${f(-s * 0.65)} ${f(-s * 0.95)} ${f(-s * 0.7)} ${f(-s * 0.25)} 0 0Z`, { fill, ...o });
export const petal = (s, fill, o) => path(`M0 0C${f(s * 0.95)} ${f(-s * 0.15)} ${f(s * 0.85)} ${f(-s * 1.1)} ${f(s * 0.12)} ${f(-s * 1.05)}L0 ${f(-s * 0.92)}L${f(-s * 0.12)} ${f(-s * 1.05)}C${f(-s * 0.85)} ${f(-s * 1.1)} ${f(-s * 0.95)} ${f(-s * 0.15)} 0 0Z`, { fill, ...o });
export const drop = (s, fill, o) => path(`M0 ${f(-s * 1.3)}C${f(s * 0.3)} ${f(-s * 0.7)} ${f(s * 0.8)} ${f(-s * 0.35)} ${f(s * 0.8)} ${f(s * 0.1)}A${f(s * 0.8)} ${f(s * 0.8)} 0 0 1 ${f(-s * 0.8)} ${f(s * 0.1)}C${f(-s * 0.8)} ${f(-s * 0.35)} ${f(-s * 0.3)} ${f(-s * 0.7)} 0 ${f(-s * 1.3)}Z`, { fill, ...o });
export function flame(h, w, fill, o) {
  return path(`M0 0C${f(-w)} 0 ${f(-w)} ${f(-0.5 * h)} ${f(-0.25 * w)} ${f(-0.66 * h)}C${f(-0.1 * w)} ${f(-0.8 * h)} 0 ${f(-0.9 * h)} 0 ${f(-h)}C${f(0.2 * w)} ${f(-0.85 * h)} ${f(w)} ${f(-0.62 * h)} ${f(w)} ${f(-0.3 * h)}C${f(w)} ${f(-0.1 * h)} ${f(0.5 * w)} 0 0 0Z`, { fill, ...o });
}
// Cristal: dos caras (izquierda clara, derecha oscura)
export function shard(h, w, light, dark, o) {
  const body = `M0 0L${f(w)} ${f(-h * 0.22)}L${f(w * 0.78)} ${f(-h * 0.82)}L0 ${f(-h)}L${f(-w * 0.78)} ${f(-h * 0.82)}L${f(-w)} ${f(-h * 0.22)}Z`;
  return g([path(body, { fill: dark }), path(`M0 0L0 ${f(-h)}L${f(-w * 0.78)} ${f(-h * 0.82)}L${f(-w)} ${f(-h * 0.22)}Z`, { fill: light })], o);
}
export const heart = (s, fill, o) => path(`M0 ${f(s)}C${f(-s * 1.55)} ${f(-s * 0.15)} ${f(-s * 0.95)} ${f(-s * 1.1)} 0 ${f(-s * 0.38)}C${f(s * 0.95)} ${f(-s * 1.1)} ${f(s * 1.55)} ${f(-s * 0.15)} 0 ${f(s)}Z`, { fill, ...o });
// Flor de cinco petalos centrada en (x, y)
export function flower(x, y, s, petalFill, centerFill, o) {
  return tr(x, y, [each(5, (a) => `<g transform="rotate(${f(a)})">${petal(s, petalFill)}</g>`), disc(0, 0, s * 0.28, centerFill)], o);
}
export function snowflake(x, y, s, stroke, w = 0.6, o) {
  const arm = (a) => `<g transform="rotate(${a})"><path d="M0 ${f(-s)}V${f(s)}M${f(-s * 0.32)} ${f(-s * 0.62)}L0 ${f(-s * 0.3)}L${f(s * 0.32)} ${f(-s * 0.62)}M${f(-s * 0.32)} ${f(s * 0.62)}L0 ${f(s * 0.3)}L${f(s * 0.32)} ${f(s * 0.62)}"/></g>`;
  return tr(x, y, `<g fill="none" stroke="${stroke}" stroke-width="${f(w)}" stroke-linecap="round" stroke-linejoin="round">${arm(0)}${arm(60)}${arm(120)}</g>`, o);
}
// Murcielago (a la derecha del origen la mitad del cuerpo; se espeja para la otra)
export function bat(s, fill, o) {
  const half = `M0 ${f(-s * 0.2)}C${f(s * 0.35)} ${f(-s * 0.75)} ${f(s * 0.95)} ${f(-s * 0.8)} ${f(s * 1.5)} ${f(-s * 0.3)}C${f(s * 1.25)} ${f(-s * 0.2)} ${f(s * 1.15)} ${f(s * 0.05)} ${f(s * 1.05)} ${f(s * 0.3)}C${f(s * 0.85)} ${f(s * 0.12)} ${f(s * 0.62)} ${f(s * 0.14)} ${f(s * 0.5)} ${f(s * 0.38)}C${f(s * 0.38)} ${f(s * 0.1)} ${f(s * 0.12)} ${f(s * 0.1)} 0 ${f(s * 0.5)}Z`;
  return g([path(half, { fill }), `<g transform="scale(-1 1)">${path(half, { fill })}</g>`, path(`M${f(-s * 0.2)} ${f(-s * 0.3)}L${f(-s * 0.16)} ${f(-s * 0.62)}L${f(-s * 0.04)} ${f(-s * 0.3)}M${f(s * 0.2)} ${f(-s * 0.3)}L${f(s * 0.16)} ${f(-s * 0.62)}L${f(s * 0.04)} ${f(-s * 0.3)}`, { fill })], o);
}
// Pluma larga y angosta (alas)
export const feather = (len, w, fill, o) => path(`M0 0C${f(w * 0.95)} ${f(-len * 0.28)} ${f(w * 0.85)} ${f(-len * 0.8)} 0 ${f(-len)}C${f(-w * 0.85)} ${f(-len * 0.8)} ${f(-w * 0.95)} ${f(-len * 0.28)} 0 0Z`, { fill, ...o });
