// "Compartir mi perfil": la tarjeta del perfil dibujada en un <canvas> de 1200 x 630 (banner, fade, cabeza con
// el marco, nombre con su estilo, titulo, insignia, descripcion, estadisticas publicadas y servidores favoritos).
// Usa las mismas descripciones de banners y colores que la tarjeta en pantalla (model.js), asi la imagen coincide.
import { t, locale } from '../../i18n.js';
import { LOADERS } from '../../ui.js';
import { parseBanner } from '../../social/cosmetics.js';
import { FONT_STACKS, titleLabel } from '../../social/profile-style.js';
import { presetLayers, linearPoints, effectiveEffect, frameOf, titleOf, badgeStyleOf, readableColor, fadeSurface, DEFAULT_NAME_COLOR } from './model.js';

export const SHARE_SIZE = { width: 1200, height: 630 };
const BANNER_H = 214;
const FOOT_H = 64;
const P = (k, vars) => t(`profile.${k}`, vars);

// ---------- Ayudas de dibujo ----------
function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function fitText(g, text, maxW) {
  const s = String(text || '');
  if (g.measureText(s).width <= maxW) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (g.measureText(`${s.slice(0, mid)}…`).width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return `${s.slice(0, lo).trimEnd()}…`;
}

function wrapLines(g, text, maxW, maxLines) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (g.measureText(next).width <= maxW) cur = next;
    else {
      if (cur) lines.push(cur);
      cur = w;
      if (lines.length === maxLines) break;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length === maxLines && words.join(' ') !== lines.join(' ')) lines[maxLines - 1] = fitText(g, `${lines[maxLines - 1]}…`, maxW);
  return lines.map((l) => fitText(g, l, maxW));
}

// Capas de un banner prediseñado (lin, rad, poly, dots) en el rectangulo pedido
function drawLayers(g, layers, x, y, w, h) {
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  for (const l of layers) {
    if (l.t === 'lin') {
      const [x0, y0, x1, y1] = linearPoints(l.a, w, h);
      const grad = g.createLinearGradient(x + x0, y + y0, x + x1, y + y1);
      l.s.forEach(([c, p]) => grad.addColorStop(p, c));
      g.fillStyle = grad;
      g.fillRect(x, y, w, h);
    } else if (l.t === 'rad') {
      g.save();
      g.translate(x + l.x * w, y + l.y * h);
      g.scale(l.rx * w, l.ry * h);
      const grad = g.createRadialGradient(0, 0, 0, 0, 0, 1);
      l.s.forEach(([c, p]) => grad.addColorStop(p, c));
      g.fillStyle = grad;
      g.fillRect(-1 / l.rx, -1 / l.ry, 2 / l.rx, 2 / l.ry);
      g.restore();
    } else if (l.t === 'poly') {
      g.beginPath();
      l.p.forEach(([px, py], i) => (i ? g.lineTo(x + px * w, y + py * h) : g.moveTo(x + px * w, y + py * h)));
      g.closePath();
      g.fillStyle = l.c;
      g.fill();
    } else if (l.t === 'dots') {
      const k = h / 112;
      for (const d of l.d) {
        g.beginPath();
        g.arc(x + d.x * w, y + d.y * h, Math.max(0.6, d.r * k), 0, Math.PI * 2);
        g.fillStyle = d.c;
        g.fill();
      }
    }
  }
  g.restore();
}

function drawCover(g, img, x, y, w, h) {
  const k = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  const sw = w / k;
  const sh = h / k;
  g.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, x, y, w, h);
}

function drawBanner(g, n, images, w) {
  if ((n.banner.kind === 'image' || n.banner.kind === 'animated' || n.banner.kind === 'klipy') && images.banner) {
    drawCover(g, images.banner, 0, 0, w, BANNER_H);
    return;
  }
  if (n.banner.kind === 'preset' && presetLayers(n.banner.preset)) {
    drawLayers(g, presetLayers(n.banner.preset), 0, 0, w, BANNER_H);
    return;
  }
  const { colors } = parseBanner(n.legacyBanner || 'venus');
  const [x0, y0, x1, y1] = linearPoints(135, w, BANNER_H);
  const grad = g.createLinearGradient(x0, y0, x1, y1);
  if (colors.length === 3) [colors[0], colors[1], colors[2]].forEach((c, i) => grad.addColorStop([0, 0.48, 1][i], c));
  else colors.forEach((c, i) => grad.addColorStop(i, c));
  g.fillStyle = grad;
  g.fillRect(0, 0, w, BANNER_H);
}

const FRAME_PAINT = {
  pixel: (g, x, y, s) => {
    const n = Math.round(s / 12);
    const c = s / n;
    for (let k = 0; k < n; k++) {
      g.fillStyle = k % 2 ? '#f29a2e' : '#ffe6b0';
      g.fillRect(x + k * c, y, c, 12);
      g.fillRect(x + k * c, y + s - 12, c, 12);
      g.fillRect(x, y + k * c, 12, c);
      g.fillRect(x + s - 12, y + k * c, 12, c);
    }
  },
  neon: (g, x, y, s) => {
    const grad = g.createLinearGradient(x, y, x + s, y + s);
    grad.addColorStop(0, '#7df9ff');
    grad.addColorStop(0.5, '#b06bff');
    grad.addColorStop(1, '#ff4fd8');
    g.save();
    g.shadowColor = 'rgba(125,249,255,0.7)';
    g.shadowBlur = 24;
    roundRect(g, x, y, s, s, 30);
    g.fillStyle = grad;
    g.fill();
    g.restore();
  },
  gold: (g, x, y, s) => {
    const grad = g.createLinearGradient(x, y, x + s, y + s);
    [['#fff1a8', 0], ['#f0b429', 0.3], ['#8a5a12', 0.55], ['#ffd27a', 0.78], ['#b07a1c', 1]].forEach(([c, p]) => grad.addColorStop(p, c));
    roundRect(g, x, y, s, s, 30);
    g.fillStyle = grad;
    g.fill();
  },
  venus: (g, x, y, s) => {
    const grad = g.createConicGradient ? g.createConicGradient(0, x + s / 2, y + s / 2) : g.createLinearGradient(x, y, x + s, y + s);
    ['#ffc562', '#f29a2e', '#c2457a', '#7e5bd6', '#5aa7f0', '#ffc562'].forEach((c, i, a) => grad.addColorStop(i / (a.length - 1), c));
    g.save();
    g.shadowColor = 'rgba(242,154,46,0.6)';
    g.shadowBlur = 22;
    roundRect(g, x, y, s, s, 30);
    g.fillStyle = grad;
    g.fill();
    g.restore();
  },
};

// Relleno del nombre segun el efecto (el mismo criterio que la hoja de estilos, sin animacion)
function nameFill(g, n, fx, x, y, w, size) {
  const bg = fadeSurface(n.theme);
  const color = n.nameStyle.color ? readableColor(n.nameStyle.color, bg) : DEFAULT_NAME_COLOR;
  const from = readableColor(n.theme?.from || color, bg);
  const to = readableColor(n.theme?.to || n.theme?.from || '#f29a2e', bg);
  const lin = (stops) => {
    const grad = g.createLinearGradient(x, 0, x + Math.max(w, 1), 0);
    stops.forEach(([c, p]) => grad.addColorStop(p, c));
    return grad;
  };
  if (fx === 'gradient') return { fill: lin([[from, 0], [to, 1]]), color };
  if (fx === 'shimmer') return { fill: lin([[color, 0], [color, 0.2], ['#ffffff', 0.32], [color, 0.44], [color, 1]]), color };
  if (fx === 'rainbow') return { fill: lin(['#ff6b6b', '#ffb36b', '#ffe66b', '#7dff8a', '#6bd5ff', '#9a8cff', '#ff7ad9'].map((c, i, a) => [c, i / (a.length - 1)])), color };
  const STOPS = {
    neon: ['#7df9ff', '#b06bff', '#ff4fd8'],
    ice: ['#ffffff', '#c4f4ff', '#7ad7f7'],
    ocean: ['#3fcfc0', '#2a7fd4', '#6fe0d0'],
    sakura: ['#ffe3ef', '#ff9ec7', '#ff7eb3'],
    toxic: ['#d7ff5a', '#5dff7a', '#1fd36a'],
    vapor: ['#ff7ad9', '#ffb36b', '#6bd5ff', '#9a8cff'],
    gold: ['#8a5a12', '#f0b429', '#fff1a8', '#f0b429'],
    galaxy: ['#c2457a', '#7e5bd6', '#5aa7f0'],
  };
  if (STOPS[fx]) return { fill: lin(STOPS[fx].map((c, i, a) => [c, i / (a.length - 1)])), color: STOPS[fx][1] };
  if (fx === 'fire') {
    const grad = g.createLinearGradient(0, y, 0, y - size);
    [['#ff3d00', 0], ['#ff7a00', 0.3], ['#ffb300', 0.55], ['#ffe36b', 0.8], ['#fff6c9', 1]].forEach(([c, p]) => grad.addColorStop(p, c));
    return { fill: grad, color: '#ff7a00' };
  }
  return { fill: color, color };
}

function chip(g, x, y, text, { bg, fg, h = 34, font = `700 18px ${FONT_STACKS.outfit.family}`, pad = 14, r = 17 }) {
  g.font = font;
  const w = g.measureText(text).width + pad * 2;
  roundRect(g, x, y, w, h, r);
  g.fillStyle = bg;
  g.fill();
  g.fillStyle = fg;
  g.textBaseline = 'middle';
  g.fillText(text, x + pad, y + h / 2 + 1);
  g.textBaseline = 'alphabetic';
  return w;
}

const BADGE_PAINT = {
  gold: { stops: ['#fff1a8', '#f0b429', '#e08a1e'], fg: '#2b1405' },
  nebula: { stops: ['#c2457a', '#5b1f73', '#2a3a8f'], fg: '#ffffff' },
  ice: { stops: ['#ffffff', '#c4f4ff', '#7ad7f7'], fg: '#06283d' },
};

function nf(n, max = 0) {
  try {
    return new Intl.NumberFormat(locale(), { maximumFractionDigits: max }).format(n);
  } catch {
    return String(n);
  }
}

/**
 * Dibuja la tarjeta. n: perfil normalizado. images: { head, banner, logo } (imagenes ya cargadas o null).
 */
export function drawShareCard(canvas, n, { images = {}, palette = {} } = {}) {
  const { width: W, height: H } = SHARE_SIZE;
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d');
  const pal = { bg: '#0c0705', surface: '#1b130e', surface2: '#231912', text: '#fff3e3', text2: '#d4bfa8', muted: '#ad9781', accent: '#f29a2e', accentHi: '#ffc562', cream: '#ffe6b0', ...palette };

  // Fondo del cuerpo: el fade del perfil bajo un velo oscuro, o las superficies del launcher
  g.fillStyle = pal.bg;
  g.fillRect(0, 0, W, H);
  if (n.theme) {
    const [x0, y0, x1, y1] = linearPoints(n.theme.angle, W, H - BANNER_H);
    const grad = g.createLinearGradient(x0, BANNER_H + y0, x1, BANNER_H + y1);
    grad.addColorStop(0, n.theme.from);
    grad.addColorStop(1, n.theme.to);
    g.fillStyle = grad;
    g.fillRect(0, BANNER_H, W, H - BANNER_H);
    const veil = g.createLinearGradient(0, BANNER_H, 0, H);
    veil.addColorStop(0, 'rgba(14,9,6,0.55)');
    veil.addColorStop(1, 'rgba(14,9,6,0.74)');
    g.fillStyle = veil;
    g.fillRect(0, BANNER_H, W, H - BANNER_H);
  } else {
    const grad = g.createLinearGradient(0, BANNER_H, 0, H);
    grad.addColorStop(0, pal.surface2);
    grad.addColorStop(1, pal.surface);
    g.fillStyle = grad;
    g.fillRect(0, BANNER_H, W, H - BANNER_H);
  }
  drawBanner(g, n, images, W);

  // Cabeza con el marco
  const HS = 150;
  const hx = 64;
  const hy = BANNER_H - 92;
  const frame = frameOf(n);
  if (frame && FRAME_PAINT[frame]) FRAME_PAINT[frame](g, hx - 10, hy - 10, HS + 20);
  else {
    roundRect(g, hx - 8, hy - 8, HS + 16, HS + 16, 30);
    g.fillStyle = n.theme ? '#1d1410' : pal.surface2;
    g.fill();
  }
  g.save();
  roundRect(g, hx, hy, HS, HS, frame === 'pixel' ? 4 : 22);
  g.clip();
  g.fillStyle = '#2c2017';
  g.fillRect(hx, hy, HS, HS);
  if (images.head) {
    g.imageSmoothingEnabled = false;
    g.drawImage(images.head, hx, hy, HS, HS);
    g.imageSmoothingEnabled = true;
  } else if (images.logo) g.drawImage(images.logo, hx + 24, hy + 24, HS - 48, HS - 48);
  g.restore();

  // Insignia Premium / estilo de insignia, a la derecha de la cabeza
  let cx = hx + HS + 28;
  const badge = badgeStyleOf(n);
  if (badge || n.premium) {
    const paint = BADGE_PAINT[badge || 'gold'];
    g.font = `800 18px ${FONT_STACKS.outfit.family}`;
    const label = n.premium ? P('premium') : P('badgeVenus');
    const w = g.measureText(label).width + 28;
    const grad = g.createLinearGradient(cx, 0, cx + w, 0);
    paint.stops.forEach((c, i) => grad.addColorStop(i / (paint.stops.length - 1), c));
    cx += chip(g, cx, BANNER_H + 14, label, { bg: grad, fg: paint.fg, r: 8 }) + 10;
  }

  // Nombre
  const fx = effectiveEffect(n);
  const fontKey = FONT_STACKS[n.nameStyle.font] ? n.nameStyle.font : 'default';
  const stack = FONT_STACKS[fontKey];
  const nameSize = Math.round(56 * (stack.scale || 1));
  const nameY = BANNER_H + 126;
  const leftW = 640;
  g.font = `${stack.weight} ${stack.stretch === 'condensed' ? 'condensed ' : ''}${nameSize}px ${stack.family}`;
  const rawName = n.name || P('someone');
  const name = fitText(g, n.nameStyle.caps ? rawName.toUpperCase() : rawName, leftW);
  const nw = g.measureText(name).width;
  const { fill, color } = nameFill(g, n, fx, hx, nameY, nw, nameSize);
  const glow = fx === 'glow' ? Math.max(n.nameStyle.glow, 55) : n.nameStyle.glow;
  g.save();
  if (glow > 0 || fx === 'fire') {
    g.shadowColor = fx === 'fire' ? 'rgba(255,110,20,0.7)' : color;
    g.shadowBlur = fx === 'fire' ? 22 : 4 + (glow / 100) * 26;
  }
  g.fillStyle = fill;
  g.fillText(name, hx, nameY);
  g.restore();

  // Titulo, pronombres y usuario
  let lineY = nameY + 14;
  const title = titleOf(n);
  if (title) {
    const label = titleLabel(title).toUpperCase();
    const legend = title === 'legend';
    const chipFont = `800 16px ${FONT_STACKS.outfit.family}`;
    g.font = chipFont;
    const tw = g.measureText(label).width + 28;
    const inline = hx + nw + 18 + tw <= hx + leftW;
    const tx = inline ? hx + nw + 18 : hx;
    const ty = inline ? nameY - 38 : lineY;
    let bg = 'rgba(242,154,46,0.16)';
    if (legend) {
      bg = g.createLinearGradient(tx, 0, tx + tw, 0);
      bg.addColorStop(0, '#fff1a8');
      bg.addColorStop(1, '#f0b429');
    }
    chip(g, tx, ty, label, { bg, fg: legend ? '#2b1405' : pal.accentHi, h: 32, font: chipFont, r: 16 });
    if (!inline) lineY += 44;
  }
  const sub = [n.pronouns, n.username ? `@${n.username}` : null].filter(Boolean).join('  ·  ');
  if (sub) {
    g.font = `500 24px ${FONT_STACKS.outfit.family}`;
    g.fillStyle = pal.text2;
    g.fillText(fitText(g, sub, leftW), hx, lineY + 22);
    lineY += 44;
  }
  if (n.bio) {
    g.font = `400 23px ${FONT_STACKS.outfit.family}`;
    g.fillStyle = pal.text;
    const room = Math.floor((H - FOOT_H - 16 - lineY) / 32);
    if (room > 0) wrapLines(g, n.bio, leftW, Math.min(3, room)).forEach((l, i) => g.fillText(l, hx, lineY + 22 + i * 32));
  }

  // Columna derecha: estadisticas y servidores favoritos
  const rx = 760;
  const rw = W - rx - 64;
  let ry = BANNER_H + 28;
  const stats = n.publicStats;
  if (stats) {
    const tiles = [];
    if (Number.isFinite(stats.hours)) tiles.push([P('hoursShort', { hours: nf(stats.hours, stats.hours < 10 ? 1 : 0) }), P('statHours')]);
    if (Number.isFinite(stats.sessions)) tiles.push([nf(stats.sessions), P('statSessions')]);
    if (stats.topVersion) tiles.push([stats.topVersion, P('statVersion')]);
    if (stats.topLoader) tiles.push([LOADERS[stats.topLoader]?.name || stats.topLoader, P('statLoader')]);
    const tw = (rw - 12) / 2;
    tiles.slice(0, 4).forEach(([value, label], i) => {
      const x = rx + (i % 2) * (tw + 12);
      const y = ry + Math.floor(i / 2) * 96;
      roundRect(g, x, y, tw, 84, 14);
      g.fillStyle = 'rgba(12,7,5,0.5)';
      g.fill();
      g.strokeStyle = 'rgba(255,196,120,0.14)';
      g.lineWidth = 1.5;
      g.stroke();
      g.font = `600 30px ${FONT_STACKS.pixel.family}`;
      g.fillStyle = pal.cream;
      g.fillText(fitText(g, value, tw - 28), x + 14, y + 42);
      g.font = `500 17px ${FONT_STACKS.outfit.family}`;
      g.fillStyle = pal.text2;
      g.fillText(fitText(g, label, tw - 28), x + 14, y + 68);
    });
    ry += Math.ceil(Math.min(tiles.length, 4) / 2) * 96 + 8;
  }
  // Solo los servidores que entran antes del pie
  const fit = Math.max(0, Math.floor((H - FOOT_H - 12 - (ry + 26)) / 62));
  const servers = n.favoriteServers.slice(0, Math.min(3, fit));
  if (servers.length) {
    g.font = `700 15px ${FONT_STACKS.outfit.family}`;
    g.fillStyle = pal.text2;
    g.fillText(P('favoriteServers').toUpperCase(), rx, ry + 14);
    ry += 26;
    for (const s of servers) {
      roundRect(g, rx, ry, rw, 54, 12);
      g.fillStyle = 'rgba(12,7,5,0.5)';
      g.fill();
      g.font = `600 20px ${FONT_STACKS.outfit.family}`;
      g.fillStyle = pal.text;
      g.fillText(fitText(g, s.name || s.address, rw - 28), rx + 14, ry + (s.name ? 24 : 34));
      if (s.name) {
        g.font = `400 15px ${FONT_STACKS.mono.family}`;
        g.fillStyle = pal.text2;
        g.fillText(fitText(g, s.address, rw - 28), rx + 14, ry + 44);
      }
      ry += 62;
    }
  }

  // Pie: marca y codigo de amigo
  g.fillStyle = 'rgba(12,7,5,0.55)';
  g.fillRect(0, H - FOOT_H, W, FOOT_H);
  if (images.logo) g.drawImage(images.logo, 64, H - 52, 40, 40);
  g.font = `600 24px ${FONT_STACKS.pixel.family}`;
  g.fillStyle = pal.cream;
  g.fillText('Venus Launcher', images.logo ? 116 : 64, H - 24);
  if (n.friendCode) {
    g.font = `600 20px ${FONT_STACKS.mono.family}`;
    g.fillStyle = pal.accentHi;
    g.textAlign = 'right';
    g.fillText(n.friendCode, W - 64, H - 25);
    g.textAlign = 'left';
  }
  return canvas;
}

// Fuentes del launcher listas antes de dibujar (como mucho 3 s)
export function loadFonts(fontId) {
  if (!document.fonts) return Promise.resolve();
  const chosen = FONT_STACKS[fontId];
  const specs = [
    ...(chosen ? [`${chosen.weight} 56px ${chosen.family}`] : []),'600 62px "Pixelify Sans"', '600 30px "Pixelify Sans"', '400 23px Outfit', '500 24px Outfit', '600 20px Outfit', '700 18px Outfit', '800 18px Outfit'];
  return Promise.race([Promise.all(specs.map((f) => document.fonts.load(f).catch(() => null))), new Promise((r) => setTimeout(r, 3000))]);
}
