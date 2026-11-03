// Menu lateral a gusto (settings.nav): orden, ocultos, fijados y pack de iconos. Logica pura, sin DOM ni
// Electron: la usan app.js (al dibujar el menu) y el editor "Personalizar menu". Se prueba con Node.

export const ICON_PACKS = ['outline', 'pixel', 'filled'];
// Entradas que nunca se pueden ocultar (Ajustes no esta en NAV: vive al pie de la barra lateral)
export const NEVER_HIDDEN = ['home'];

const uniqueKnown = (value, known) => {
  const out = [];
  for (const v of Array.isArray(value) ? value : []) {
    const id = typeof v === 'string' ? v : null;
    if (id && known.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
};

// settings.nav -> { order, hidden, pinned, iconPack }. Ids que no existen en el menu se descartan y `home`
// nunca queda oculto. `ids` = ids de las entradas actuales del menu (sin los grupos).
export function normalizeNav(raw, ids) {
  const known = new Set(ids || []);
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    order: uniqueKnown(src.order, known),
    hidden: uniqueKnown(src.hidden, known).filter((id) => !NEVER_HIDDEN.includes(id)),
    pinned: uniqueKnown(src.pinned, known),
    iconPack: ICON_PACKS.includes(src.iconPack) ? src.iconPack : 'outline',
  };
}

// Secciones del menu: [{ group: 'play' | null, items: [entradas] }] (los items antes del primer titulo van con group null)
export function sections(entries) {
  const out = [];
  let cur = { group: null, items: [] };
  for (const e of entries || []) {
    if (!e) continue;
    if (e.group) {
      if (cur.group || cur.items.length) out.push(cur);
      cur = { group: e.group, items: [] };
    } else if (e.id) cur.items.push(e);
  }
  if (cur.group || cur.items.length) out.push(cur);
  return out;
}

// Ordena una seccion: primero los que tienen lugar en `order` (por ese lugar) y despues, en su orden de
// siempre, los que no (por ejemplo una pagina que un modulo registro despues de que el usuario ordeno el menu).
export function sortByOrder(items, order) {
  const rank = new Map((order || []).map((id, i) => [id, i]));
  const ranked = items.filter((e) => rank.has(e.id)).sort((a, b) => rank.get(a.id) - rank.get(b.id));
  const rest = items.filter((e) => !rank.has(e.id));
  return [...ranked, ...rest];
}

// Lista final para dibujar: los fijados arriba de todo (bajo el grupo 'pinned', en el orden de `pinned`),
// despues cada seccion con su titulo y sus entradas ordenadas, sin las ocultas.
export function navLayout(entries, prefs) {
  const p = prefs || { order: [], hidden: [], pinned: [], iconPack: 'outline' };
  const hidden = new Set(p.hidden || []);
  const pinnedSet = new Set(p.pinned || []);
  const byId = new Map((entries || []).filter((e) => e && e.id).map((e) => [e.id, e]));
  const out = [];
  const pinned = (p.pinned || []).map((id) => byId.get(id)).filter((e) => e && !hidden.has(e.id));
  if (pinned.length) out.push({ group: 'pinned' }, ...pinned);
  for (const s of sections(entries)) {
    const items = sortByOrder(
      s.items.filter((e) => !pinnedSet.has(e.id) && !hidden.has(e.id)),
      p.order,
    );
    if (s.group) out.push({ group: s.group });
    out.push(...items);
  }
  return out;
}

// Orden global a guardar a partir de las secciones tal como se ven en el editor
export function orderFromSections(secs) {
  return secs.flatMap((s) => s.items.map((e) => e.id));
}

// Mueve `id` un lugar dentro de su seccion (dir = -1 sube, 1 baja). Devuelve secciones nuevas.
export function moveInSection(secs, id, dir) {
  return secs.map((s) => {
    const i = s.items.findIndex((e) => e.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= s.items.length) return s;
    const items = [...s.items];
    [items[i], items[j]] = [items[j], items[i]];
    return { ...s, items };
  });
}

// Pone `id` antes (o despues) de `target` si los dos estan en la misma seccion; si no, no cambia nada.
export function dropInSection(secs, id, target, before = true) {
  return secs.map((s) => {
    const from = s.items.findIndex((e) => e.id === id);
    const to = s.items.findIndex((e) => e.id === target);
    if (from < 0 || to < 0 || id === target) return s;
    const items = s.items.filter((e) => e.id !== id);
    const at = items.findIndex((e) => e.id === target);
    items.splice(before ? at : at + 1, 0, s.items[from]);
    return { ...s, items };
  });
}

export function toggleIn(list, id, on) {
  const has = list.includes(id);
  if (on === undefined) on = !has;
  if (on && !has) return [...list, id];
  if (!on && has) return list.filter((x) => x !== id);
  return [...list];
}

export const canHide = (id) => !NEVER_HIDDEN.includes(id);
