// Marcos de perfil de Venus (4.6): la fuente unica. El catalogo (FRAME_CATALOG), como se resuelve un marco a partir del
// id de un item de la tienda o del Venus Pass y como se dibuja (SVG original hecho con codigo, sin imagenes de nadie).
// Lo leen la tarjeta de perfil (profile-style.js), el editor (features/profile-editor.js y model.js), la tienda de Venus
// Points (pages/rewards.js), la lista de premios del Pass (pages/pass.js), los regalos y la imagen para compartir.
//
//   import { FRAME_CATALOG, frameStyleOf, drawFrame, framePreview } from '../social/frames.js';
//
// Este archivo no toca el DOM al cargarse (se puede probar con Node). Los estilos estan en styles/features/frames.css; el
// dibujo de cada estilo esta en social/frames/*.js. Para sumar un marco: docs/perfiles.md (Marcos nuevos).
import { begin, takeDefs } from './frames/kit.js';
import { cosmic, nature, elements, gems } from './frames/art-a.js';
import { retro, neon, seasonal, fantasy } from './frames/art-b.js';
import { pass } from './frames/art-pass.js';

// Categorias de la tienda (el orden es el de la pantalla). 'pass' son los marcos que solo se ganan en el Venus Pass.
export const FRAME_CATEGORIES = ['cosmic', 'nature', 'elements', 'gems', 'retro', 'neon', 'seasonal', 'fantasy'];
export const FRAME_RARITIES = ['common', 'rare', 'epic', 'legendary', 'mythic'];

// [estilo, categoria, rareza, precio en Venus Points, solo Premium]
// Los de solo Premium valen 0: vienen incluidos con el plan y no se compran (shop_buy los rechaza).
const SHOP = [
  ['nebula', 'cosmic', 'common', 500],
  ['comet', 'cosmic', 'common', 700],
  ['rings', 'cosmic', 'rare', 1100],
  ['eclipse', 'cosmic', 'epic', 1800],
  ['constellation', 'cosmic', 'epic', 0, true],
  ['leaves', 'nature', 'common', 400],
  ['vines', 'nature', 'common', 600],
  ['blossom', 'nature', 'rare', 1000],
  ['dandelion', 'nature', 'rare', 1200],
  ['firefly', 'nature', 'epic', 1700],
  ['tide', 'elements', 'common', 600],
  ['gale', 'elements', 'common', 800],
  ['frost', 'elements', 'rare', 1100],
  ['flame', 'elements', 'epic', 1600],
  ['storm', 'elements', 'epic', 1900],
  ['ruby', 'gems', 'rare', 1000],
  ['sapphire', 'gems', 'rare', 1200],
  ['prism', 'gems', 'epic', 2000],
  ['opal', 'gems', 'epic', 0, true],
  ['bits', 'retro', 'common', 400],
  ['coins', 'retro', 'common', 700],
  ['arcade', 'retro', 'rare', 1000],
  ['glitch', 'retro', 'rare', 1300],
  ['equalizer', 'neon', 'common', 700],
  ['radar', 'neon', 'rare', 900],
  ['synth', 'neon', 'rare', 1400],
  ['circuit', 'neon', 'epic', 1600],
  ['hologram', 'neon', 'epic', 0, true],
  ['cupid', 'seasonal', 'rare', 1000],
  ['spooky', 'seasonal', 'rare', 1200],
  ['garland', 'seasonal', 'rare', 1200],
  ['fireworks', 'seasonal', 'epic', 1500],
  ['runes', 'fantasy', 'epic', 1800],
  ['dragon', 'fantasy', 'legendary', 2600],
  ['wings', 'fantasy', 'legendary', 0, true],
  ['phoenix', 'fantasy', 'legendary', 3000],
];

// Los ocho del Venus Pass: del nivel 25 al 380, cada uno mas vistoso (0041_venus_pass_tiempo.sql los inserta con source 'pass')
const PASS = [
  ['pass1', 'rare', 25],
  ['pass2', 'rare', 60],
  ['pass3', 'epic', 100],
  ['pass4', 'epic', 150],
  ['pass5', 'epic', 200],
  ['pass6', 'legendary', 260],
  ['pass7', 'legendary', 320],
  ['pass8', 'mythic', 380],
];

/**
 * Cada marco: { id, style, category, rarity, price, premiumOnly, source, sort }.
 *   id: el de shop_items ('frame_<nombre>' en la tienda, 'pass_frame_<n>' en el Pass); style: lo que dice shop_items.data.style;
 *   source: 'shop' (se compra con Venus Points o viene con Premium) o 'pass' (se gana jugando; level es el nivel que lo da).
 */
export const FRAME_CATALOG = Object.freeze([
  ...SHOP.map(([style, category, rarity, price, premiumOnly], i) => Object.freeze({ id: `frame_${style}`, style, category, rarity, price: premiumOnly ? 0 : price, premiumOnly: Boolean(premiumOnly), source: 'shop', sort: 600 + i * 10 })),
  ...PASS.map(([style, rarity, level], i) => Object.freeze({ id: `pass_frame_${i + 1}`, style, category: 'pass', rarity, price: 0, premiumOnly: false, source: 'pass', level, sort: 310 + i })),
]);

// Marcos anteriores a la 4.6 (arte distinto, algunos con nombres de otros juegos): la migracion 0040 los desactiva y quita de
// los perfiles. Solo sirven para reconocerlos en el historial; no se dibujan.
export const RETIRED_FRAME_IDS = Object.freeze([
  'frame_pixel', 'frame_neon', 'frame_gold', 'frame_venus', 'frame_ice', 'frame_emerald', 'frame_amethyst', 'frame_redstone', 'frame_fire',
  'frame_ender', 'frame_rainbow', 'frame_diamond', 'frame_cosmic', 'frame_pulse', 'frame_orbit', 'frame_halloween', 'frame_xmas',
  'pass_s1_frame', 'pass_s1_frame_legend', 'pass_s1_free_frame', 'pass_max_frame',
]);

export const FRAME_STYLES = Object.freeze(FRAME_CATALOG.map((fr) => fr.style));
const BY_ID = new Map(FRAME_CATALOG.map((fr) => [fr.id, fr]));
const BY_STYLE = new Map(FRAME_CATALOG.map((fr) => [fr.style, fr]));
const ART = { ...cosmic, ...nature, ...elements, ...gems, ...retro, ...neon, ...seasonal, ...fantasy, ...pass };

// ---------- Resolver ----------
// Ids que la tienda conoce y este archivo no (shop_items.data.style apunta a un estilo conocido): se suman al cargar la tienda
const extra = new Map();
export function registerFrameItems(rows) {
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || r.kind !== 'frame' || typeof r.id !== 'string') continue;
    const style = r.data?.style ?? r.style;
    if (typeof style === 'string' && BY_STYLE.has(style)) extra.set(r.id, style);
  }
}

/** 'frame_flame', 'pass_frame_3' o 'flame' -> 'flame' / 'pass3'; null si no es un marco que se sepa dibujar (por ejemplo, uno retirado). */
export function frameStyleOf(value) {
  if (typeof value !== 'string') return null;
  const byId = BY_ID.get(value);
  if (byId) return byId.style;
  if (extra.has(value)) return extra.get(value);
  return BY_STYLE.has(value) ? value : null;
}
/** El marco del catalogo para un id o un estilo (o null) */
export const frameItem = (value) => BY_ID.get(value) || BY_STYLE.get(frameStyleOf(value)) || null;
/** Clave de texto del nombre ('rewards.item_frame_flame'); los del Pass tambien estan en rewards */
export const frameNameKey = (value) => {
  const it = frameItem(value);
  return it ? `rewards.item_${it.id}` : null;
};
export const isPassFrame = (value) => frameItem(value)?.source === 'pass';

// ---------- Filtrar (la tienda y el editor) ----------
/**
 * Marcos que cumplen los filtros. opts: { query, category, rarity, price } con price 'free' (Premium), 'low' (hasta 800),
 * 'mid' (801 a 1600) o 'high' (mas de 1600); nameOf(id) da el nombre ya traducido para el buscador.
 */
export function filterFrames(list, { query = '', category = 'all', rarity = 'all', price = 'all', nameOf = (id) => id } = {}) {
  const q = String(query || '').trim().toLowerCase();
  return (Array.isArray(list) ? list : []).filter((it) => {
    const fr = frameItem(it.id ?? it);
    if (!fr) return false;
    if (category !== 'all' && fr.category !== category) return false;
    if (rarity !== 'all' && fr.rarity !== rarity) return false;
    if (price === 'free' && !fr.premiumOnly) return false;
    if (price === 'low' && (fr.premiumOnly || fr.price > 800)) return false;
    if (price === 'mid' && (fr.premiumOnly || fr.price <= 800 || fr.price > 1600)) return false;
    if (price === 'high' && (fr.premiumOnly || fr.price <= 1600)) return false;
    return !q || String(nameOf(fr.id)).toLowerCase().includes(q);
  });
}

// Filtros de precio del buscador de la tienda (los entiende filterFrames)
export const FRAME_PRICE_FILTERS = ['all', 'free', 'low', 'mid', 'high'];

/**
 * Los marcos de la tienda (los { item } de shopView) por categoria, ya filtrados. opts como filterFrames.
 * Devuelve [{ category, items }] en el orden de FRAME_CATEGORIES; un marco que no se sabe dibujar no aparece.
 */
export function frameSections(views, opts = {}) {
  const list = Array.isArray(views) ? views : [];
  const keep = new Set(filterFrames(list.map((v) => v.item), opts).map((it) => it.id));
  return FRAME_CATEGORIES.map((category) => ({ category, items: list.filter((v) => keep.has(v.item.id) && frameItem(v.item.id)?.category === category) })).filter((sec) => sec.items.length);
}

// ---------- Dibujo ----------
let seq = 0;
/** El <svg> de un estilo (texto). uid prefija los ids de sus degradados: dos marcos en la misma pagina no se pisan. '' si no existe. */
export function frameSvg(style, { uid } = {}) {
  const art = BY_STYLE.has(style) ? ART[style] : null;
  if (!art) return '';
  begin(uid || `fr${(++seq).toString(36)}`);
  const body = art();
  const defs = takeDefs();
  return `<svg class="fr fr-${style}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" focusable="false" aria-hidden="true">${defs ? `<defs>${defs}</defs>` : ''}${body}</svg>`;
}
/** Direccion data: del marco quieto, para dibujarlo en un <canvas> (imagen de "Compartir mi perfil") */
export const frameImageUrl = (style) => {
  const svg = frameSvg(style, { uid: 'st' });
  return svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : '';
};
// El marco ocupa 125 % de la cabeza (12,5 % de cada lado): el avatar es el circulo de radio 40 de un dibujo de 100
export const FRAME_SCALE = 1.25;

// Las animaciones se pausan mientras el marco esta fuera de pantalla
let watcher = null;
function watch(box) {
  if (typeof IntersectionObserver !== 'function') return;
  watcher ||= new IntersectionObserver(
    (entries) => {
      for (const e of entries) e.target.classList.toggle('off', !e.isIntersecting);
    },
    { rootMargin: '48px' },
  );
  watcher.observe(box);
}

/** Saca el marco de un contenedor de cabeza (el que le puso drawFrame) */
export function clearFrame(el) {
  if (!el) return el;
  for (const c of [...el.classList]) if (c === 'pf-frame' || c.startsWith('pf-frame-')) el.classList.remove(c);
  delete el.dataset.frame;
  for (const box of el.querySelectorAll(':scope > .fr-art')) {
    watcher?.unobserve(box);
    box.remove();
  }
  return el;
}

/**
 * Pone el marco en el contenedor de una cabeza (un .sc-headwrap: caja con la medida de la cabeza, position: relative).
 * value: id de la tienda, del Pass o estilo. Si no se conoce, lo deja sin marco. Necesita styles/features/frames.css.
 */
export function drawFrame(el, value) {
  if (!el) return el;
  clearFrame(el);
  const style = frameStyleOf(value);
  const svg = style ? frameSvg(style) : '';
  if (!svg) return el;
  el.classList.add('pf-frame', `pf-frame-${style}`);
  el.dataset.frame = style;
  const box = el.ownerDocument.createElement('span');
  box.className = 'fr-art';
  box.setAttribute('aria-hidden', 'true');
  box.innerHTML = svg; // texto armado aca con constantes: nada que venga de otras personas
  el.append(box);
  watch(box);
  return el;
}

/** Cabeza circular con el marco puesto, para vistas previas (tienda, premios del Pass). head: el elemento de la cabeza ya armado. */
export function framePreview(value, head, size = 64) {
  const wrap = head.ownerDocument.createElement('span');
  wrap.className = 'sc-headwrap fr-prev';
  wrap.style.width = `${size}px`;
  wrap.style.height = `${size}px`;
  wrap.append(head);
  return drawFrame(wrap, value);
}
