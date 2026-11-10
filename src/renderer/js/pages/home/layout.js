// Inicio armable (settings.home.layout): orden de los bloques, ocultos y a lo ancho. Logica pura, sin DOM ni
// Electron, para poder probarla con Node. La pagina (home.js) la usa para dibujar y para el modo "Organizar".
//
// Modelo: `order` es el orden global de todos los bloques. Un bloque "wide" ocupa una fila entera; entre dos
// de esos, los bloques normales se reparten en dos columnas (principal y lateral) segun su tipo. Asi, el orden
// de siempre (accesos rapidos arriba, despues las dos columnas) es el mismo que el de un layout vacio.

export const MAIN_BLOCKS = ['worlds', 'featured', 'screenshots', 'news'];
export const RAIL_BLOCKS = ['server', 'friends', 'stats', 'tips'];
export const BLOCKS = ['quick', ...MAIN_BLOCKS, ...RAIL_BLOCKS];
// Siempre a lo ancho (los accesos rapidos son una fila de botones; en una columna no entran)
export const ALWAYS_WIDE = ['quick'];

const uniqueKnown = (value, known) => {
  const out = [];
  for (const v of Array.isArray(value) ? value : []) {
    const id = typeof v === 'string' ? v : null;
    if (id && known.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
};

// settings.home -> { order, hidden, wide }. Ids desconocidos se descartan; los bloques que falten en `order`
// van al final en su orden por defecto. Sin `layout`, lee `hidden` (la clave de la 2.x) para no perder lo elegido.
export function normalizeLayout(home, blocks = BLOCKS) {
  const known = new Set(blocks);
  const raw = home && typeof home === 'object' && home.layout && typeof home.layout === 'object' ? home.layout : null;
  const order = uniqueKnown(raw?.order, known);
  for (const id of blocks) if (!order.includes(id)) order.push(id);
  const hidden = uniqueKnown(raw ? raw.hidden : home?.hidden, known);
  const wide = uniqueKnown(raw?.wide, known).filter((id) => !ALWAYS_WIDE.includes(id));
  return { order, hidden, wide };
}

export const isWide = (layout, id) => ALWAYS_WIDE.includes(id) || (Array.isArray(layout?.wide) && layout.wide.includes(id));

export const columnOf = (id) => (RAIL_BLOCKS.includes(id) ? 'rail' : 'main');

// true si dos bloques se ven uno arriba del otro en la pagina (misma columna, o uno de ellos a lo ancho)
export function sameLane(layout, a, b) {
  return isWide(layout, a) || isWide(layout, b) || columnOf(a) === columnOf(b);
}

// Filas de la pagina en el orden en que se dibujan: { wide: id } o { main: [ids], rail: [ids] }.
// `visible(id)` dice que bloques entran (en el modo normal, los que tienen datos y no estan ocultos).
export function buildRows(layout, visible = () => true) {
  const rows = [];
  let cur = null;
  for (const id of layout.order) {
    if (!visible(id)) continue;
    if (isWide(layout, id)) {
      rows.push({ wide: id });
      cur = null;
      continue;
    }
    if (!cur) {
      cur = { main: [], rail: [] };
      rows.push(cur);
    }
    cur[columnOf(id)].push(id);
  }
  return rows;
}

// Pone `id` justo antes (o despues) de `target` en el orden. Devuelve un orden nuevo.
export function reorder(order, id, target, before = true) {
  if (id === target || !order.includes(id) || !order.includes(target)) return [...order];
  const out = order.filter((x) => x !== id);
  const at = out.indexOf(target);
  out.splice(before ? at : at + 1, 0, id);
  return out;
}

// Sube (dir = -1) o baja (dir = 1) un bloque como se ve en la pagina: un bloque de columna salta al vecino
// visible de su misma columna o a un bloque ancho; un bloque ancho salta una fila entera (las dos columnas
// juntas cuentan como una fila). Devuelve el orden nuevo (el mismo si no hay a donde moverse).
export function moveBlock(layout, id, dir, visible = () => true) {
  const order = layout.order;
  if (!order.includes(id) || !visible(id)) return [...order];
  if (!isWide(layout, id)) {
    const lane = order.filter((x) => visible(x) && sameLane(layout, id, x));
    const i = lane.indexOf(id);
    const neighbor = lane[i + dir];
    if (!neighbor) return [...order];
    return reorder(order, id, neighbor, dir < 0);
  }
  const rows = buildRows(layout, visible);
  const r = rows.findIndex((row) => row.wide === id);
  const target = rows[r + dir];
  if (!target) return [...order];
  if (target.wide) return reorder(order, id, target.wide, dir < 0);
  const members = order.filter((x) => target.main.includes(x) || target.rail.includes(x));
  return dir < 0 ? reorder(order, id, members[0], true) : reorder(order, id, members[members.length - 1], false);
}

export function toggleIn(list, id, on) {
  const has = list.includes(id);
  if (on === undefined) on = !has;
  if (on && !has) return [...list, id];
  if (!on && has) return list.filter((x) => x !== id);
  return [...list];
}

// Orden visual de los bloques (por fila y por columna), por ejemplo para recorrerlos con el teclado
export function visualOrder(layout, visible = () => true) {
  const out = [];
  for (const row of buildRows(layout, visible)) {
    if (row.wide) out.push(row.wide);
    else out.push(...row.main, ...row.rail);
  }
  return out;
}

export const sameLayout = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Tamaño de la tarjeta principal (settings.home.hero, 6.1): 'large' (la de siempre) o 'compact'. Otro valor -> 'large'.
export const HERO_SIZES = ['large', 'compact'];
export const normalizeHero = (home) => (home && typeof home === 'object' && HERO_SIZES.includes(home.hero) ? home.hero : 'large');
