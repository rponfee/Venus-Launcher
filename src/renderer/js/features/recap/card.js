// Tarjeta de "Tu resumen de Venus" dibujada en un <canvas>: solo datos locales y recursos del launcher
// (logo y fuentes propias; nunca imagenes de la red). Dos formatos: horizontal 1600x900 (Discord, X) y
// vertical 1080x1920 (TikTok, historias). La paleta llega resuelta desde los tokens de :root, asi la
// imagen sigue el color de acento de Apariencia. Los textos llegan ya traducidos y formateados (view); los
// rotulos (eyebrow y los label) ya vienen en mayusculas segun el idioma de la interfaz.
//   view: { eyebrow, title, name?, hero, caption, tiles: [{ icon, value, label }],
//           favorite?: { label, name, meta, value, color, letter }, top?: { label, icon, name, meta, value },
//           collection?: { label, chips: [{ icon, text }] }, site }

export const FORMATS = {
  landscape: { width: 1600, height: 900 },
  portrait: { width: 1080, height: 1920 },
};

const PIXEL = '"Pixelify Sans", Outfit, system-ui, sans-serif';
const SANS = 'Outfit, system-ui, "Segoe UI", sans-serif';

// Iconos estilo Lucide (los mismos trazos que ui.js) como trazados para el canvas
const ICONS = {
  calendar: ['M8 2v4', 'M16 2v4', 'M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', 'M3 10h18'],
  flame: ['M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z'],
  zap: ['M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z'],
  globe: ['M22 12a10 10 0 1 1-20 0a10 10 0 1 1 20 0z', 'M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20', 'M2 12h20'],
  server: ['M4 2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z', 'M4 14h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2z', 'M6 6h.01', 'M6 18h.01'],
  trophy: ['M6 9H4.5a2.5 2.5 0 0 1 0-5H6', 'M18 9h1.5a2.5 2.5 0 0 0 0-5H18', 'M4 22h16', 'M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22', 'M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22', 'M18 2H6v7a6 6 0 0 0 12 0V2Z'],
  clock: ['M22 12a10 10 0 1 1-20 0a10 10 0 1 1 20 0z', 'M12 6v6l4 2'],
  puzzle: ['M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z'],
  layers: ['M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z', 'M22 17.65l-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65', 'M22 12.65l-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65'],
  user: ['M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2', 'M16 7a4 4 0 1 1-8 0a4 4 0 1 1 8 0z'],
};
const pathCache = new Map();

const rgba = (c, a = 1) => `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`;
const mix = (a, b, t) => ({ r: Math.round(a.r + (b.r - a.r) * t), g: Math.round(a.g + (b.g - a.g) * t), b: Math.round(a.b + (b.b - a.b) * t) });

// Numeros pseudoaleatorios con semilla: las estrellas quedan siempre en el mismo lugar
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function setFont(g, weight, size, family) {
  g.font = `${weight} ${Math.max(1, Math.round(size))}px ${family}`;
}
function spacing(g, px) {
  if ('letterSpacing' in g) g.letterSpacing = `${px}px`;
}

const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
const graphemes = (s) => (segmenter ? Array.from(segmenter.segment(s), (x) => x.segment) : Array.from(s));

// Recorta con "…" hasta que entre en maxW (con la fuente ya puesta)
function ellipsis(g, text, maxW) {
  const s = String(text ?? '');
  if (!(maxW > 0) || g.measureText(s).width <= maxW) return s;
  const parts = graphemes(s);
  let lo = 0;
  let hi = parts.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (g.measureText(`${parts.slice(0, mid).join('').trimEnd()}…`).width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return `${parts.slice(0, lo).join('').trimEnd()}…`;
}

// Achica la letra hasta que el texto entre (sin bajar de min); deja la fuente puesta y devuelve el tamaño
function fitFont(g, text, maxW, weight, size, min, family) {
  let s = size;
  setFont(g, weight, s, family);
  let w = g.measureText(text).width;
  if (w > maxW && maxW > 0) {
    s = Math.max(min, Math.floor((s * maxW) / w));
    setFont(g, weight, s, family);
    w = g.measureText(text).width;
    while (w > maxW && s > min) {
      s -= 1;
      setFont(g, weight, s, family);
      w = g.measureText(text).width;
    }
  }
  return s;
}

// Una linea de texto: se achica hasta min y despues se recorta con "…". Devuelve el ancho dibujado.
function line(g, text, x, y, { weight = 400, size, min = size, family = SANS, color, align = 'left', maxW = Infinity, track = 0, baseline = 'alphabetic' }) {
  g.save();
  spacing(g, track);
  fitFont(g, String(text ?? ''), maxW, weight, size, min, family);
  const str = ellipsis(g, text, maxW);
  g.textAlign = align;
  g.textBaseline = baseline;
  g.fillStyle = color;
  g.fillText(str, x, y);
  const w = g.measureText(str).width;
  g.restore();
  return w;
}

function drawIcon(g, name, x, y, size, color, width = 2) {
  const list = ICONS[name];
  if (!list) return;
  let paths = pathCache.get(name);
  if (!paths) {
    paths = list.map((d) => new Path2D(d));
    pathCache.set(name, paths);
  }
  g.save();
  g.translate(x, y);
  g.scale(size / 24, size / 24);
  g.strokeStyle = color;
  g.lineWidth = width;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const p of paths) g.stroke(p);
  g.restore();
}

function glow(g, x, y, r, c, a) {
  const gr = g.createRadialGradient(x, y, 0, x, y, r);
  gr.addColorStop(0, rgba(c, a));
  gr.addColorStop(1, rgba(c, 0));
  g.fillStyle = gr;
  g.fillRect(0, 0, g.canvas.width, g.canvas.height);
}

// Estrella pixel en cruz (brillo)
function sparkle(g, x, y, u, c, a) {
  g.fillStyle = rgba(c, a * 0.55);
  g.fillRect(Math.round(x - u / 2), Math.round(y - u * 2.5), u, u * 5);
  g.fillRect(Math.round(x - u * 2.5), Math.round(y - u / 2), u * 5, u);
  g.fillStyle = rgba(c, a);
  g.fillRect(Math.round(x - u / 2), Math.round(y - u / 2), u, u);
}

const inside = (x, y, rects) => rects.some((r) => x >= r.x - 6 && x <= r.x + r.w + 6 && y >= r.y - 6 && y <= r.y + r.h + 6);

// Fondo: espacio profundo calido con nebulosas del color de acento y estrellas pixel. avoid: zonas de texto
// sin estrellas (ninguna cae encima de una letra); panels: tarjetas, donde tampoco van los brillos en cruz.
function drawSpace(g, W, H, P, planet, seed, avoid = [], panels = []) {
  const base = g.createLinearGradient(0, 0, W * 0.35, H);
  base.addColorStop(0, rgba(mix(P.bg1, P.accentDeep, 0.28)));
  base.addColorStop(0.5, rgba(mix(P.bg0, P.bg1, 0.6)));
  base.addColorStop(1, rgba(P.bg0));
  g.fillStyle = base;
  g.fillRect(0, 0, W, H);
  glow(g, planet.x, planet.y, planet.r * 3.4, P.accentDeep, 0.5);
  glow(g, W * 0.06, H * 1.04, Math.max(W, H) * 0.62, P.accentLo, 0.2);
  glow(g, W * 0.42, -H * 0.12, Math.max(W, H) * 0.45, P.cream, 0.05);

  const rand = rng(seed);
  const count = Math.round((W * H) / 5600);
  for (let i = 0; i < count; i++) {
    const x = rand() * W;
    const y = rand() * H;
    const k = rand();
    const size = k > 0.975 ? 4 : k > 0.82 ? 3 : 2;
    const a = 0.2 + rand() * 0.6;
    const warm = rand() > 0.86;
    if (inside(x, y, avoid)) continue;
    g.fillStyle = rgba(warm ? P.accentHi : P.text, a);
    g.fillRect(Math.round(x), Math.round(y), size, size);
  }
  // Brillos en cruz: solo lejos del texto y del planeta
  let placed = 0;
  for (let i = 0; i < 80 && placed < 10; i++) {
    const x = 28 + rand() * (W - 56);
    const y = 28 + rand() * (H - 56);
    const u = rand() > 0.6 ? 4 : 3;
    const a = 0.55 + rand() * 0.4;
    // fuera del planeta y de su anillo (una elipse mas ancha que alta)
    if (inside(x, y, avoid) || inside(x, y, panels) || Math.hypot((x - planet.x) / 1.75, (y - planet.y) / 1.15) < planet.r) continue;
    sparkle(g, x, y, u, P.cream, a);
    placed++;
  }

  const v = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.hypot(W, H) * 0.6);
  v.addColorStop(0, 'rgba(0, 0, 0, 0)');
  v.addColorStop(1, 'rgba(0, 0, 0, 0.5)');
  g.fillStyle = v;
  g.fillRect(0, 0, W, H);
}

// Anillo inclinado: la mitad de atras va antes del planeta y la de adelante despues
function drawRing(g, { x, y, r }, P, part) {
  const rx = r * 1.62;
  const ry = r * 0.33;
  const [a0, a1] = part === 'back' ? [Math.PI, Math.PI * 2] : [0, Math.PI];
  const front = part === 'front';
  g.save();
  g.translate(x, y);
  g.rotate(-0.3);
  const stroke = (sx, sy, color, width) => {
    g.beginPath();
    g.ellipse(0, 0, sx, sy, 0, a0, a1);
    g.strokeStyle = color;
    g.lineWidth = width;
    g.stroke();
  };
  stroke(rx, ry, rgba(P.accentHi, front ? 0.16 : 0.08), r * 0.08);
  stroke(rx, ry, rgba(P.cream, front ? 0.75 : 0.3), Math.max(2, r * 0.013));
  stroke(rx * 0.9, ry * 0.88, rgba(P.accent, front ? 0.55 : 0.22), Math.max(2, r * 0.009));
  if (front) {
    const s = Math.max(4, Math.round(r * 0.028));
    for (const t of [0.42, 1.15, 2.35, 2.8]) {
      const px = Math.cos(t) * rx;
      const py = Math.sin(t) * ry;
      g.fillStyle = rgba(P.cream, 0.95);
      g.fillRect(Math.round(px - s / 2), Math.round(py - s / 2), s, s);
    }
  } else {
    const s = Math.max(3, Math.round(r * 0.02));
    for (const t of [3.6, 4.4, 5.6]) {
      g.fillStyle = rgba(P.cream, 0.5);
      g.fillRect(Math.round(Math.cos(t) * rx - s / 2), Math.round(Math.sin(t) * ry - s / 2), s, s);
    }
  }
  g.restore();
}

function drawPlanet(g, planet, P, img) {
  const { x, y, r } = planet;
  const halo = g.createRadialGradient(x, y, r * 0.8, x, y, r * 1.8);
  halo.addColorStop(0, rgba(P.accent, 0.42));
  halo.addColorStop(0.45, rgba(P.accentLo, 0.15));
  halo.addColorStop(1, rgba(P.accentLo, 0));
  g.fillStyle = halo;
  g.beginPath();
  g.arc(x, y, r * 1.8, 0, Math.PI * 2);
  g.fill();
  drawRing(g, planet, P, 'back');
  g.save();
  if (img && img.naturalWidth) {
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, x - r, y - r, r * 2, r * 2);
  } else {
    const body = g.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r);
    body.addColorStop(0, rgba(P.cream));
    body.addColorStop(0.55, rgba(P.accent));
    body.addColorStop(1, rgba(P.accentDeep));
    g.fillStyle = body;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  g.restore();
  drawRing(g, planet, P, 'front');
}

// Panel de vidrio oscuro con borde del acento
function panel(g, x, y, w, h, radius, P, alpha = 0.66) {
  g.save();
  g.beginPath();
  g.roundRect(x, y, w, h, radius);
  g.fillStyle = rgba(P.bg0, alpha);
  g.fill();
  const hl = g.createLinearGradient(0, y, 0, y + h);
  hl.addColorStop(0, rgba(P.cream, 0.07));
  hl.addColorStop(0.55, rgba(P.cream, 0));
  g.fillStyle = hl;
  g.fill();
  g.lineWidth = 2;
  g.strokeStyle = rgba(P.accent, 0.28);
  g.stroke();
  g.restore();
}

// Logo + "VENUS / LAUNCHER" como en la barra lateral del launcher
function drawBrand(g, x, y, s, P, logo) {
  const size = 64 * s;
  g.save();
  g.shadowColor = rgba(P.accent, 0.55);
  g.shadowBlur = 22 * s;
  if (logo && logo.naturalWidth) {
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(logo, x, y, size, size);
  }
  g.restore();
  const tx = x + size + 16 * s;
  g.save();
  setFont(g, 700, 36 * s, PIXEL);
  spacing(g, 1.5 * s);
  const grad = g.createLinearGradient(0, y + 6 * s, 0, y + 38 * s);
  grad.addColorStop(0, rgba(P.cream));
  grad.addColorStop(0.7, rgba(P.accent));
  grad.addColorStop(1, rgba(P.accentLo));
  g.fillStyle = grad;
  g.textBaseline = 'alphabetic';
  g.fillText('VENUS', tx, y + 36 * s);
  setFont(g, 500, 15 * s, PIXEL);
  spacing(g, 5.5 * s);
  g.fillStyle = rgba(P.muted);
  g.fillText('LAUNCHER', tx + 2 * s, y + 60 * s);
  g.restore();
}

// Pastilla con el periodo y las fechas
function drawPill(g, text, x, y, size, P, { align = 'left', maxW = Infinity } = {}) {
  g.save();
  setFont(g, 600, size, PIXEL);
  spacing(g, size * 0.1);
  const padX = size * 0.95;
  const str = ellipsis(g, text, maxW - padX * 2);
  const tw = g.measureText(str).width;
  const h = Math.round(size * 2.1);
  const w = tw + padX * 2;
  const left = align === 'center' ? x - w / 2 : x;
  g.beginPath();
  g.roundRect(left, y, w, h, h / 2);
  g.fillStyle = rgba(P.accent, 0.16);
  g.fill();
  g.lineWidth = 2;
  g.strokeStyle = rgba(P.accent, 0.55);
  g.stroke();
  g.fillStyle = rgba(P.accentHi);
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  g.fillText(str, left + padX, y + h / 2 + size * 0.06);
  g.restore();
  return { w, h };
}

// Cifra principal (horas) con degradado y brillo
function drawHero(g, text, x, y, maxW, size, min, P, align = 'left') {
  g.save();
  const s = fitFont(g, text, maxW, 700, size, min, PIXEL);
  const str = ellipsis(g, text, maxW);
  g.textAlign = align;
  g.textBaseline = 'alphabetic';
  const grad = g.createLinearGradient(0, y - s * 0.78, 0, y);
  grad.addColorStop(0, rgba(P.cream));
  grad.addColorStop(0.55, rgba(P.accentHi));
  grad.addColorStop(1, rgba(P.accent));
  g.shadowColor = rgba(P.accent, 0.5);
  g.shadowBlur = s * 0.32;
  g.fillStyle = grad;
  g.fillText(str, x, y);
  g.restore();
  return s;
}

function drawName(g, name, x, y, size, P, { align = 'left', maxW = Infinity } = {}) {
  g.save();
  setFont(g, 700, size, SANS);
  const icon = size * 0.95;
  const gap = size * 0.4;
  const str = ellipsis(g, name, maxW - icon - gap);
  const tw = g.measureText(str).width;
  const left = align === 'center' ? x - (icon + gap + tw) / 2 : x;
  drawIcon(g, 'user', left, y - icon * 0.84, icon, rgba(P.accentHi), 2.2);
  g.fillStyle = rgba(P.text);
  g.textBaseline = 'alphabetic';
  g.fillText(str, left + icon + gap, y);
  g.restore();
}

// Cifra con su icono. Las tarjetas anchas (vertical) llevan el icono a la izquierda; las angostas, arriba.
function drawTile(g, x, y, w, h, tile, P, s) {
  panel(g, x, y, w, h, 20 * s, P);
  const pad = 22 * s;
  const wide = w / h > 2.4;
  const ib = (wide ? 58 : 46) * s;
  const bx = x + pad;
  const by = wide ? y + (h - ib) / 2 : y + pad;
  g.save();
  g.beginPath();
  g.roundRect(bx, by, ib, ib, (wide ? 14 : 12) * s);
  g.fillStyle = rgba(P.accent, 0.16);
  g.fill();
  g.strokeStyle = rgba(P.accent, 0.4);
  g.lineWidth = 1.5;
  g.stroke();
  g.restore();
  const is = ib * 0.52;
  drawIcon(g, tile.icon, bx + (ib - is) / 2, by + (ib - is) / 2, is, rgba(P.accentHi), 2.2);
  if (wide) {
    const tx = bx + ib + 20 * s;
    const maxW = x + w - pad - tx;
    line(g, tile.value, tx, y + h / 2 - 2 * s, { weight: 700, size: 44 * s, min: 22 * s, family: PIXEL, color: rgba(P.cream), maxW });
    line(g, tile.label, tx, y + h / 2 + 30 * s, { weight: 600, size: 20 * s, min: 14 * s, family: SANS, color: rgba(P.text2), maxW });
    return;
  }
  const maxW = w - pad * 2;
  line(g, tile.value, x + pad, y + h - pad - 34 * s, { weight: 700, size: 44 * s, min: 22 * s, family: PIXEL, color: rgba(P.cream), maxW });
  line(g, tile.label, x + pad, y + h - pad - 2 * s, { weight: 600, size: 20 * s, min: 14 * s, family: SANS, color: rgba(P.text2), maxW });
}

// Instancia favorita o mundo/servidor mas jugado: icono, rotulo, nombre, detalle y tiempo a la derecha
function drawFeature(g, x, y, w, h, item, P, s, kind) {
  panel(g, x, y, w, h, 22 * s, P, 0.74);
  const pad = 22 * s;
  const ib = h - pad * 2;
  g.save();
  g.beginPath();
  g.roundRect(x + pad, y + pad, ib, ib, 16 * s);
  if (kind === 'favorite') {
    const c = item.color || P.accent;
    const gr = g.createLinearGradient(x + pad, y + pad, x + pad + ib, y + pad + ib);
    gr.addColorStop(0, rgba(c));
    gr.addColorStop(1, rgba(mix(c, P.bg0, 0.55)));
    g.fillStyle = gr;
    g.fill();
    g.clip();
    setFont(g, 700, ib * 0.5, PIXEL);
    g.fillStyle = 'rgba(255, 255, 255, 0.95)';
    g.shadowColor = 'rgba(0, 0, 0, 0.35)';
    g.shadowBlur = 6 * s;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(item.letter || '?', x + pad + ib / 2, y + pad + ib / 2 + ib * 0.03);
  } else {
    g.fillStyle = rgba(P.accent, 0.16);
    g.fill();
    g.strokeStyle = rgba(P.accent, 0.4);
    g.lineWidth = 1.5;
    g.stroke();
  }
  g.restore();
  if (kind !== 'favorite') drawIcon(g, item.icon || 'globe', x + pad + ib * 0.25, y + pad + ib * 0.25, ib * 0.5, rgba(P.accentHi), 2);

  const right = x + w - pad;
  let valueW = 0;
  if (item.value) {
    g.save();
    setFont(g, 700, 34 * s, PIXEL);
    valueW = Math.min(g.measureText(item.value).width, w * 0.32);
    g.restore();
    line(g, item.value, right, y + h / 2 + 12 * s, { weight: 700, size: 34 * s, min: 18 * s, family: PIXEL, color: rgba(P.cream), align: 'right', maxW: w * 0.32 });
  }
  const tx = x + pad + ib + 20 * s;
  const maxW = right - tx - (valueW ? valueW + 20 * s : 0);
  const mid = y + h / 2;
  line(g, item.label, tx, mid - 18 * s, { weight: 700, size: 15 * s, min: 12 * s, family: SANS, color: rgba(P.accentHi), maxW, track: 2.4 * s });
  line(g, item.name, tx, mid + 14 * s, { weight: 700, size: 30 * s, min: 20 * s, family: SANS, color: rgba(P.text), maxW });
  if (item.meta) line(g, item.meta, tx, mid + 42 * s, { weight: 500, size: 19 * s, min: 15 * s, family: SANS, color: rgba(P.muted), maxW });
}

// "Tu coleccion": rotulo y pastillas (mods, mundos, instancias); devuelve el alto usado
function drawCollection(g, col, x, y, maxW, P, s, align = 'left') {
  if (!col || !col.chips?.length) return 0;
  const labelY = y + 16 * s;
  line(g, col.label, align === 'center' ? x + maxW / 2 : x, labelY, { weight: 700, size: 15 * s, min: 12 * s, family: SANS, color: rgba(P.accentHi), align, maxW, track: 2.6 * s });
  const chipY = y + 32 * s;
  const ch = 50 * s;
  const gap = 12 * s;
  const icon = 22 * s;
  g.save();
  let size = 22 * s;
  const widths = () => {
    setFont(g, 600, size, SANS);
    return col.chips.map((c) => icon + 10 * s + g.measureText(c.text).width + 36 * s);
  };
  let ws = widths();
  const total = () => ws.reduce((a, b) => a + b, 0) + gap * (ws.length - 1);
  while (total() > maxW && size > 15 * s) {
    size -= 1;
    ws = widths();
  }
  let cx = align === 'center' ? x + (maxW - total()) / 2 : x;
  col.chips.forEach((c, i) => {
    const w = ws[i];
    if (cx + w > x + maxW + 1) return;
    g.beginPath();
    g.roundRect(cx, chipY, w, ch, ch / 2);
    g.fillStyle = rgba(P.bg0, 0.62);
    g.fill();
    g.lineWidth = 2;
    g.strokeStyle = rgba(P.accent, 0.3);
    g.stroke();
    drawIcon(g, c.icon, cx + 18 * s, chipY + (ch - icon) / 2, icon, rgba(P.accentHi), 2.2);
    setFont(g, 600, size, SANS);
    g.fillStyle = rgba(P.text);
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.fillText(c.text, cx + 18 * s + icon + 10 * s, chipY + ch / 2 + 1);
    cx += w + gap;
  });
  g.restore();
  return 32 * s + ch;
}

function drawSite(g, site, x, y, P, s, align) {
  if (!site) return;
  g.save();
  setFont(g, 600, 21 * s, SANS);
  spacing(g, 1.2 * s);
  const tw = g.measureText(site).width;
  const icon = 20 * s;
  const gap = 10 * s;
  const left = align === 'right' ? x - tw - icon - gap : align === 'center' ? x - (tw + icon + gap) / 2 : x;
  drawIcon(g, 'globe', left, y - icon * 0.82, icon, rgba(P.accentHi), 2);
  g.fillStyle = rgba(P.text2);
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  g.fillText(site, left + icon + gap, y);
  g.restore();
}

// ---------- Formatos ----------
// Cada formato primero calcula donde va cada bloque (para que las estrellas no caigan sobre el texto) y despues dibuja.

function drawLandscape(g, view, P, images) {
  const W = 1600;
  const H = 900;
  const L = 80;
  const colW = 820;
  const RX = 960;
  const RW = 560;
  const features = [view.favorite && ['favorite', view.favorite], view.top && ['top', view.top]].filter(Boolean);
  const planet = features.length ? { x: 1245, y: 262, r: 212 } : { x: 1240, y: 440, r: 290 };
  const n = Math.min(3, view.tiles.length);
  const hasCollection = Boolean(view.collection?.chips?.length);

  // Bloque de arriba: periodo, nombre, titulo, horas y partidas (las cifras empiezan en tilesTop)
  const pillY = 166;
  let y = pillY + Math.round(19 * 2.1) + 28;
  const nameY = view.name ? y + 26 : null;
  if (view.name) y += 46;
  const titleY = y + 46;
  y += 66;
  const tilesTop = n ? 520 : hasCollection ? 560 : 620;
  const avail = tilesTop - 28 - y - 22 - 26;
  const heroSize = Math.max(64, Math.min(138, avail / 0.8));
  // Si la cifra no entra se achica, y su linea de base sube con ella: la frase de abajo nunca la pisa
  const hs = fitFont(g, view.hero, colW, 700, heroSize, 48, PIXEL);
  const heroY = y + hs * 0.8;
  const captionY = heroY + 22 + 26;
  const collectionY = n ? 734 : tilesTop + 24;
  const avoid = [
    { x: L - 10, y: 50, w: 250, h: 92 },
    { x: L - 10, y: pillY - 6, w: colW + 20, h: captionY + 14 - pillY },
    hasCollection ? { x: L - 10, y: collectionY - 4, w: colW + 20, h: 96 } : null,
    { x: RX + RW - 360, y: 818, w: 370, h: 50 },
  ].filter(Boolean);
  const panels = [n ? { x: L, y: tilesTop, w: colW, h: 172 } : null, features.length ? { x: RX, y: 520, w: RW, h: features.length * 140 - 16 } : null].filter(Boolean);

  drawSpace(g, W, H, P, planet, 7, avoid, panels);
  drawPlanet(g, planet, P, images.planet);
  drawBrand(g, L, 58, 0.95, P, images.logo);
  drawPill(g, view.eyebrow, L, pillY, 19, P, { maxW: colW });
  if (nameY) drawName(g, view.name, L, nameY, 28, P, { maxW: colW });
  line(g, view.title, L, titleY, { weight: 700, size: 52, min: 30, family: PIXEL, color: rgba(P.cream), maxW: colW });
  drawHero(g, view.hero, L - 4, heroY, colW, heroSize, 48, P);
  line(g, view.caption, L, captionY, { weight: 500, size: 30, min: 20, family: SANS, color: rgba(P.text2), maxW: colW });

  if (n) {
    const gap = 18;
    const tw = (colW - gap * (n - 1)) / n;
    view.tiles.slice(0, n).forEach((tile, i) => drawTile(g, L + i * (tw + gap), tilesTop, tw, 172, tile, P, 1));
  }
  if (hasCollection) drawCollection(g, view.collection, L, collectionY, colW, P, 1);

  // Columna derecha: instancia favorita y mundo o servidor mas jugado
  let fy = 520;
  for (const [kind, item] of features) {
    drawFeature(g, RX, fy, RW, 124, item, P, 1, kind);
    fy += 124 + 16;
  }
  drawSite(g, view.site, RX + RW, 852, P, 1, 'right');
}

function drawPortrait(g, view, P, images) {
  const W = 1080;
  const H = 1920;
  const M = 72;
  const CW = W - M * 2;
  const cx = W / 2;
  const s = 1.12;
  const features = [view.favorite && ['favorite', view.favorite], view.top && ['top', view.top]].filter(Boolean);
  // Grilla de 2 columnas: con 3 cifras se muestran 2 para que no quede una sola en una fila
  const n = view.tiles.length >= 4 ? 4 : view.tiles.length === 3 ? 2 : view.tiles.length;
  const rows = Math.ceil(n / 2);
  const hasCollection = Boolean(view.collection?.chips?.length);
  const T = { pill: 44, title: 62, hero: 136, caption: 36, tile: 150, tileGap: 18, feat: 118, featGap: 16, chips: Math.round(82 * s) };
  // Alto de todo lo que va debajo del planeta: el planeta se queda con el espacio que sobra
  const below =
    24 + T.pill + 30 + (view.name ? 56 : 0) + T.title + 20 + T.hero + 14 + T.caption +
    (rows ? 44 + rows * T.tile + (rows - 1) * T.tileGap : 0) +
    (features.length ? 28 + features.length * T.feat + (features.length - 1) * T.featGap : 0) +
    (hasCollection ? 32 + T.chips : 0) +
    130;
  const top = 160;
  const zone = Math.max(280, H - top - below);
  const r = Math.max(150, Math.min(268, zone * 0.4));
  const planet = { x: cx, y: top + zone / 2, r };

  // Posiciones
  let y = top + zone + 24;
  const pillY = y;
  y += T.pill + 30;
  const nameY = view.name ? y + 32 : null;
  if (view.name) y += 56;
  const titleY = y + 54;
  y += T.title + 20;
  const heroY = y + T.hero * 0.86;
  y += T.hero + 14;
  const captionY = y + 30;
  y += T.caption;
  const tilesY = rows ? y + 44 : null;
  if (rows) y += 44 + rows * T.tile + (rows - 1) * T.tileGap;
  const featY = [];
  if (features.length) {
    y += 28;
    features.forEach((_, i) => {
      featY.push(y);
      y += T.feat + (i < features.length - 1 ? T.featGap : 0);
    });
  }
  const collectionY = hasCollection ? y + 32 : null;
  const avoid = [
    { x: M - 10, y: 56, w: 270, h: 96 },
    { x: M - 10, y: pillY - 8, w: CW + 20, h: captionY + 16 - pillY },
    hasCollection ? { x: M - 10, y: collectionY - 6, w: CW + 20, h: T.chips + 14 } : null,
    { x: cx - 230, y: H - 100, w: 460, h: 56 },
  ].filter(Boolean);
  const panels = [
    rows ? { x: M, y: tilesY, w: CW, h: rows * T.tile + (rows - 1) * T.tileGap } : null,
    features.length ? { x: M, y: featY[0], w: CW, h: features.length * T.feat + (features.length - 1) * T.featGap } : null,
  ].filter(Boolean);

  drawSpace(g, W, H, P, planet, 11, avoid, panels);
  drawPlanet(g, planet, P, images.planet);
  drawBrand(g, M, 66, 1.05, P, images.logo);
  drawPill(g, view.eyebrow, cx, pillY, 21, P, { align: 'center', maxW: CW });
  if (nameY) drawName(g, view.name, cx, nameY, 32, P, { align: 'center', maxW: CW });
  line(g, view.title, cx, titleY, { weight: 700, size: 60, min: 34, family: PIXEL, color: rgba(P.cream), align: 'center', maxW: CW });
  drawHero(g, view.hero, cx, heroY, CW, 160, 56, P, 'center');
  line(g, view.caption, cx, captionY, { weight: 500, size: 32, min: 22, family: SANS, color: rgba(P.text2), align: 'center', maxW: CW });
  if (rows) {
    const tw = (CW - T.tileGap) / 2;
    view.tiles.slice(0, n).forEach((tile, i) => {
      const row = Math.floor(i / 2);
      const col = i % 2;
      const alone = col === 0 && i === n - 1;
      drawTile(g, M + col * (tw + T.tileGap), tilesY + row * (T.tile + T.tileGap), alone ? CW : tw, T.tile, tile, P, 0.96);
    });
  }
  features.forEach(([kind, item], i) => drawFeature(g, M, featY[i], CW, T.feat, item, P, 1, kind));
  if (hasCollection) drawCollection(g, view.collection, M, collectionY, CW, P, s, 'center');
  drawSite(g, view.site, cx, H - 62, P, 1.05, 'center');
}

// Dibuja la tarjeta completa en el canvas (cambia su tamaño al del formato)
export function drawCard(canvas, view, { format = 'landscape', palette, images = {} } = {}) {
  const size = FORMATS[format] || FORMATS.landscape;
  if (canvas.width !== size.width) canvas.width = size.width;
  if (canvas.height !== size.height) canvas.height = size.height;
  const g = canvas.getContext('2d');
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, size.width, size.height);
  if (format === 'portrait') drawPortrait(g, view, palette, images);
  else drawLandscape(g, view, palette, images);
  g.restore();
}
