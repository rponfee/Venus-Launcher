// Estilo de los perfiles de Venus (contrato 5 de la 2.0): nombre con tipografia, efecto, color, brillo y titulo,
// marco equipado, banner (prediseñado, imagen, animado o el color clasico) y el fade del perfil.
// Lo usan las tarjetas de perfil (profile-ui.js), el editor (features/profile-editor.js), Mensajes y otras partes.
// Acepta el perfil en camelCase (profile_public) o la fila cruda de profiles (snake_case). Si la fila no trae el
// estilo (las de social.js), styledName lo pide aparte en un solo pedido para todos y se pinta cuando llega.
//   import { styledName, applyFrame, bannerEl, gradientCss, titleLabel, ensureProfileStyle } from '../social/profile-style.js';
import { h, icon, ensureCss, reducedMotion } from '../ui.js';
import { t, has, loadNs } from '../i18n.js';
import { cloud } from '../cloud.js';
import { bannerBackground, rankInfo } from './cosmetics.js';
import { EXTRA_FONTS, fontStack } from '../features/profile-editor/fonts.js';
import {
  normalizeProfile,
  effectiveEffect,
  frameOf,
  titleOf,
  titleStyle,
  badgeStyleOf,
  gradientCss as fadeCss,
  presetCss,
  readableColor,
  fadeSurface,
  glowFilter,
  DEFAULT_NAME_COLOR,
  FONTS,
  FRAMES,
} from '../features/profile-editor/model.js';

const NS = 'profile';
const CSS = 'features/profile-style';
const FONTS_CSS = 'features/profile-fonts'; // las 28 tipografias de la 3.0 (el navegador baja solo las que se usan)
const ensureStyles = () => {
  ensureCss(CSS);
  ensureCss(FONTS_CSS);
};

// Tipografias del nombre: pilas de fuentes del sistema o las que trae el launcher (sin bajar nada).
// 'default' es el estilo de Venus: pixel en tarjetas y titulos, la fuente de la lista en las listas.
export const FONT_STACKS = {
  default: { family: "'Pixelify Sans', 'Outfit', system-ui, sans-serif", weight: 600 },
  pixel: { family: "'Pixelify Sans', 'Outfit', system-ui, sans-serif", weight: 600 },
  outfit: { family: "'Outfit', system-ui, 'Segoe UI', sans-serif", weight: 800 },
  serif: { family: "Georgia, Cambria, 'Times New Roman', serif", weight: 700 },
  mono: { family: "'Cascadia Mono', Consolas, ui-monospace, monospace", weight: 700 },
  rounded: { family: "ui-rounded, 'Arial Rounded MT Bold', Nunito, 'Varela Round', Quicksand, Candara, 'Segoe UI', sans-serif", weight: 700 },
  condensed: { family: "'Bahnschrift Condensed', Bahnschrift, 'Arial Narrow', 'Roboto Condensed', sans-serif", weight: 700, stretch: 'condensed' },
  ...Object.fromEntries(EXTRA_FONTS.map((f) => [f.id, { family: fontStack(f), weight: f.weight, scale: f.scale }])),
};

let ready = null;
// Carga la hoja de estilos y los textos del namespace profile (se puede llamar muchas veces)
export function ensureProfileStyle() {
  ensureStyles();
  if (!ready) {
    ready = loadNs(NS).catch((err) => {
      ready = null;
      console.warn('[profile] textos', err?.message || err);
    });
  }
  return ready;
}

// ---------- Estilos que faltan (filas viejas de social) ----------
const STYLE_TTL = 5 * 60_000;
const styleCache = new Map(); // id -> { at, raw: { nameStyle, theme, equipped, banner } }
const waiting = new Map(); // id -> [fn]
let flushTimer = null;
let offUntil = 0;
let warned = false;

function cachedStyle(id) {
  const c = styleCache.get(id);
  return c && Date.now() - c.at < STYLE_TTL ? c.raw : null;
}

// Guarda el estilo conocido de un usuario (lo usa el editor despues de guardar)
export function setStyleCache(id, profile) {
  if (!id || !profile) return;
  const n = normalize(profile);
  styleCache.set(id, { at: Date.now(), raw: { nameStyle: n.nameStyle, theme: n.theme || {}, equipped: n.equipped, banner: n.banner, cardStyle: n.cardStyle, rank: n.rank } });
}

function requestStyle(id, fn) {
  if (!id || Date.now() < offUntil) return;
  if (!waiting.has(id)) waiting.set(id, []);
  waiting.get(id).push(fn);
  if (!flushTimer) flushTimer = setTimeout(flushStyles, 60);
}

async function flushStyles() {
  flushTimer = null;
  const ids = [...waiting.keys()].slice(0, 100);
  const fns = new Map(ids.map((id) => [id, waiting.get(id)]));
  ids.forEach((id) => waiting.delete(id));
  if (waiting.size) flushTimer = setTimeout(flushStyles, 60);
  try {
    await cloud.ready();
    if (!cloud.isSignedIn()) {
      offUntil = Date.now() + 30_000; // sin sesion no hay a quien preguntar: se reintenta en un rato
      return;
    }
    const { data, error } = await cloud.client.from('profiles').select('id,name_style,theme,equipped,banner_style,card_style,rank').in('id', ids);
    if (error) throw error;
    const now = Date.now();
    const rows = new Map((data || []).map((r) => [r.id, r]));
    for (const id of ids) {
      const r = rows.get(id) || {};
      styleCache.set(id, { at: now, raw: { nameStyle: r.name_style || {}, theme: r.theme || {}, equipped: r.equipped || {}, banner: r.banner_style || {}, cardStyle: r.card_style || {}, rank: r.rank || null } });
      for (const fn of fns.get(id) || []) {
        try {
          fn();
        } catch (err) {
          console.warn('[profile] estilo', err?.message || err);
        }
      }
    }
  } catch (err) {
    // Sin las columnas nuevas (servidor sin actualizar) o sin red: se deja de pedir por un rato
    offUntil = Date.now() + 10 * 60_000;
    if (!warned) {
      warned = true;
      console.warn('[profile] estilos de perfil no disponibles:', err?.message || err);
    }
  }
}

// Pide de una vez el estilo de varios usuarios (por ejemplo, toda la lista de amigos)
export function primeStyles(ids) {
  for (const id of ids || []) if (id && !cachedStyle(id)) requestStyle(id, () => {});
}

// ---------- Perfil ----------
// Perfil normalizado (model.js) con el estilo guardado en memoria si la fila no lo trae
export function normalize(profile, opts) {
  const n = profile && typeof profile === 'object' && 'legacyBanner' in profile && 'hasStyle' in profile ? profile : normalizeProfile(profile, opts);
  if (n.hasStyle || !n.id) return n;
  const c = cachedStyle(n.id);
  if (!c) return n;
  return normalizeProfile({ ...n, nameStyle: c.nameStyle, theme: c.theme, equipped: c.equipped, banner: c.banner && c.banner.kind ? c.banner : n.banner, cardStyle: c.cardStyle, rank: c.rank || n.rank, hasStyle: true }, opts);
}

// Color del nombre ya ajustado para que se lea
export function nameColor(profile) {
  const n = normalize(profile);
  return n.nameStyle.color ? readableColor(n.nameStyle.color, fadeSurface(n.theme)) : DEFAULT_NAME_COLOR;
}

// ---------- Nombre ----------
function paintName(el, label, n, { size, animate }) {
  const fx = effectiveEffect(n);
  const font = FONTS.includes(n.nameStyle.font) ? n.nameStyle.font : 'default';
  // Contraste medido contra el fondo real de la tarjeta (con fade, mas claro que la superficie)
  const bg = fadeSurface(n.theme);
  const color = n.nameStyle.color ? readableColor(n.nameStyle.color, bg) : DEFAULT_NAME_COLOR;
  const from = n.theme?.from || color;
  const to = n.theme?.to || (n.theme?.from ? n.theme.from : '#f29a2e');
  const glow = fx === 'glow' ? Math.max(n.nameStyle.glow, 55) : n.nameStyle.glow;
  const scale = size === 'sm' ? 0.55 : size === 'lg' ? 1.25 : 1;
  for (const c of [...el.classList]) if (c.startsWith('pf-font-') || c.startsWith('pf-fx-')) el.classList.remove(c);
  el.classList.add(`pf-font-${font}`, `pf-fx-${fx}`);
  el.classList.toggle('pf-static', !animate);
  el.classList.toggle('pf-caps', n.nameStyle.caps === true);
  el.classList.toggle('pf-italic', n.nameStyle.italic === true);
  el.classList.toggle('pf-outline', n.nameStyle.outline === true);
  el.style.setProperty('--pf-c', color);
  el.style.setProperty('--pf-from', readableColor(from, bg));
  el.style.setProperty('--pf-to', readableColor(to, bg));
  el.style.setProperty('--pf-glow', glowFilter(glow, color, scale));
  label.dataset.text = label.textContent;
}

function titleChip(n) {
  const id = titleOf(n);
  if (!id) return null;
  const label = titleLabel(id);
  return h('span', { class: 'pf-title', dataset: { title: id }, title: label }, label);
}

/**
 * Nombre con el estilo del perfil. size: 'sm' (listas: hereda el tamaño, sin animaciones), 'md' o 'lg'.
 * title: true agrega el titulo equipado al lado. animate: fuerza (o apaga) las animaciones del efecto.
 */
export function styledName(profile, { size = 'md', title = false, animate } = {}) {
  ensureStyles();
  const n = normalize(profile);
  const sz = ['sm', 'md', 'lg'].includes(size) ? size : 'md';
  const anim = animate ?? sz !== 'sm';
  const text = n.name || (has(`${NS}.someone`) ? t(`${NS}.someone`) : '');
  const label = h('span', { class: 'pf-name-text' }, text);
  const el = h('span', { class: ['pf-name', `pf-size-${sz}`] }, label);
  paintName(el, label, n, { size: sz, animate: anim });
  const box = title ? h('span', { class: ['pf-namebox', `pf-size-${sz}`] }, el, titleChip(n)) : null;
  if (!n.hasStyle && n.id && !cachedStyle(n.id)) {
    requestStyle(n.id, () => {
      const fresh = normalize(n);
      paintName(el, label, fresh, { size: sz, animate: anim });
      if (box) {
        box.querySelector('.pf-title')?.remove();
        const chip = titleChip(fresh);
        if (chip) box.append(chip);
      }
    });
  }
  return box || el;
}

// ---------- Marco ----------
// Pone (o saca) el marco equipado en un elemento, normalmente el contenedor de la cabeza
export function applyFrame(el, profile) {
  if (!el) return el;
  ensureCss(CSS);
  const n = normalize(profile);
  const style = frameOf(n);
  for (const c of [...el.classList]) if (c === 'pf-frame' || c.startsWith('pf-frame-') || c.startsWith('pf-avatar-')) el.classList.remove(c);
  if (n.cardStyle?.avatar && n.cardStyle.avatar !== 'square') el.classList.add(`pf-avatar-${n.cardStyle.avatar}`);
  if (style && FRAMES.includes(style)) {
    el.classList.add('pf-frame', `pf-frame-${style}`);
    el.dataset.frame = style;
  } else delete el.dataset.frame;
  return el;
}

// ---------- Banner ----------
// Cuadro estatico de un GIF (movimiento reducido): se dibuja una vez en un <canvas> del mismo tamaño
function freezeGif(img, holder) {
  try {
    const canvas = h('canvas', { class: 'pf-banner-img', width: img.naturalWidth, height: img.naturalHeight, 'aria-hidden': 'true' });
    canvas.getContext('2d').drawImage(img, 0, 0);
    img.replaceWith(canvas);
  } catch {
    holder.classList.add('pf-banner-fallback');
  }
}

// Fondo CSS del banner sin imagen (prediseñado, color clasico o el de Venus)
export function bannerBackgroundCss(profile) {
  const n = normalize(profile);
  if (n.banner.kind === 'preset') return presetCss(n.banner.preset);
  return bannerBackground(n.legacyBanner || 'venus');
}

export function bannerEl(profile, { cls = '' } = {}) {
  ensureCss(CSS);
  const n = normalize(profile, { allowLocalMedia: true });
  const el = h('div', { class: ['pf-banner', cls], dataset: { kind: n.banner.kind } });
  if (n.banner.kind === 'image' || n.banner.kind === 'animated') {
    el.style.background = bannerBackground(n.legacyBanner || 'venus');
    const img = h('img', { class: 'pf-banner-img', src: n.banner.url, alt: '', decoding: 'async', draggable: 'false' });
    if (n.banner.kind === 'animated' && reducedMotion()) {
      img.crossOrigin = 'anonymous';
      img.addEventListener('load', () => freezeGif(img, el), { once: true });
    }
    img.addEventListener('error', () => img.remove(), { once: true });
    el.append(img);
  } else if (n.banner.kind === 'klipy') {
    // GIF de KLIPY: se carga directo de su dominio, como pide su integracion. Con movimiento reducido, el cuadro fijo.
    el.style.background = bannerBackground(n.legacyBanner || 'venus');
    const img = h('img', { class: 'pf-banner-img', src: reducedMotion() && n.banner.still ? n.banner.still : n.banner.url, alt: '', decoding: 'async', draggable: 'false', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => img.remove(), { once: true });
    el.append(img);
  } else {
    el.style.background = bannerBackgroundCss(n);
  }
  return el;
}

// ---------- Fade ----------
export function gradientCss(profile) {
  return fadeCss(normalize(profile));
}

// ---------- Textos ----------
// Respaldo en español si todavia no cargo el namespace (lo correcto es esperar ensureProfileStyle() antes de dibujar)
const TITLE_FALLBACK = { explorer: 'Explorador', builder: 'Constructor', redstoner: 'Redstoner', legend: 'Leyenda', supporter: 'Colaborador', miner: 'Minero', farmer: 'Granjero', architect: 'Arquitecto', modder: 'Modder', streamer: 'Streamer', pvp: 'PvP', nightowl: 'Búho nocturno', speedrunner: 'Speedrunner', collector: 'Coleccionista', hardcore: 'Hardcore', veteran: 'Veterano', vip: 'VIP' };
export function titleLabel(titleId) {
  const id = titleStyle(titleId);
  if (!id) return '';
  const key = `${NS}.title_${id}`;
  if (has(key)) return t(key);
  ensureProfileStyle();
  return TITLE_FALLBACK[id] || id;
}

// Insignia Premium (o el estilo de insignia comprado) con el estilo equipado
export function premiumChip(profile) {
  const n = normalize(profile);
  const style = badgeStyleOf(n);
  if (!n.premium && !style) return null;
  const label = n.premium ? (has(`${NS}.premium`) ? t(`${NS}.premium`) : 'Premium') : has(`${NS}.badgeVenus`) ? t(`${NS}.badgeVenus`) : 'Venus';
  const svg = h(
    'svg',
    { svg: true, viewBox: '0 0 24 24', width: 13, height: 13, fill: 'none', stroke: 'currentColor', 'stroke-width': 2.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
    h('path', { svg: true, d: n.premium ? 'M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z' : 'M12 2l2.9 6.9L22 9.3l-5.5 4.8L18.2 21 12 17.3 5.8 21l1.7-6.9L2 9.3l7.1-.4z' }),
  );
  return h('span', { class: 'pf-premium', dataset: { style: style || 'gold' }, title: label }, svg, h('span', {}, label));
}

// Rango (owner, admin, mod, helper) con su color: lo da un admin, no se compra
export function rankChip(profile, { compact = false } = {}) {
  const info = rankInfo(normalize(profile).rank);
  if (!info) return null;
  return h('span', { class: ['pf-rank', compact && 'compact'], dataset: { rank: info.id }, title: info.label, 'aria-label': info.label }, icon(info.icon), compact ? null : h('span', {}, info.label));
}

// Clases y variables de la tarjeta segun su estilo (dibujo de fondo, disposicion y color de acento)
export function cardStyleAttrs(profile) {
  const c = normalize(profile).cardStyle || {};
  return {
    classes: [c.pattern && c.pattern !== 'none' && `pf-pattern-${c.pattern}`, c.layout === 'center' && 'pf-layout-center'].filter(Boolean),
    vars: c.accent ? { '--pf-accent': c.accent } : {},
  };
}
