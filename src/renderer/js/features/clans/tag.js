// Piezas visuales de un clan que usan otras pantallas: el tag junto al nombre y el emblema. El nombre y el tag son de otras
// cuentas: van siempre como texto (h() usa nodos de texto y setAttribute), nunca como HTML.
//   tagChip({ tag, color, name }) -> Element, emblemBadge({ emblem, color }, { size }) -> Element
//   clanTagSlot(userId) -> Element (vacío hasta que llega el tag; si la cuenta no tiene clan queda oculto)
//   clanTagsOf(ids) -> Promise<Map<userId, tag>>, forgetClanTags()
import { h, icon, ensureCss } from '../../ui.js';
import { t, loadNs } from '../../i18n.js';
import { groupsBackend } from './backend.js';
import { readableInk, safeColor, safeEmblem } from './logic.js';

const TTL = 5 * 60000;
const cache = new Map(); // userId -> { at, tag | null }
let pending = new Map(); // userId -> [resolve]
let timer = null;

export function tagChip({ tag, color, name } = {}) {
  ensureCss('pages/clans');
  const c = safeColor(color);
  return h('span', { class: 'cl-tag', style: { '--cl-c': c, '--cl-ink': readableInk(c) }, title: name || null }, String(tag ?? ''));
}

export function emblemBadge({ emblem, color } = {}, { size = 'md' } = {}) {
  ensureCss('pages/clans');
  const c = safeColor(color);
  return h('span', { class: ['cl-emblem', `is-${size}`], style: { '--cl-c': c, '--cl-ink': readableInk(c) }, 'aria-hidden': 'true' }, icon(safeEmblem(emblem)));
}

// Junta los pedidos de un mismo momento (una lista de miembros, por ejemplo) en una sola llamada de hasta 100.
async function flush() {
  timer = null;
  const batch = pending;
  pending = new Map();
  const ids = [...batch.keys()];
  const found = new Map();
  try {
    const b = await groupsBackend();
    if (b.signedIn()) {
      for (let i = 0; i < ids.length; i += 100) {
        const rows = await b.rpc('clan_tags', { p_users: ids.slice(i, i + 100) });
        for (const row of Array.isArray(rows) ? rows : []) found.set(row.userId, row);
      }
    }
    for (const id of ids) cache.set(id, { at: Date.now(), tag: found.get(id) || null });
  } catch {
    /* sin servicio: no se muestra el tag y se vuelve a preguntar la próxima vez */
  }
  for (const [id, waiting] of batch) for (const resolve of waiting) resolve(found.get(id) || null);
}

function tagOf(userId) {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < TTL) return Promise.resolve(hit.tag);
  return new Promise((resolve) => {
    if (!pending.has(userId)) pending.set(userId, []);
    pending.get(userId).push(resolve);
    timer ||= setTimeout(flush, 30);
  });
}

export async function clanTagsOf(ids) {
  const list = [...new Set(ids)].filter(Boolean);
  const tags = await Promise.all(list.map(tagOf));
  return new Map(list.map((id, i) => [id, tags[i]]));
}

export function forgetClanTags() {
  cache.clear();
}

export function clanTagSlot(userId) {
  ensureCss('pages/clans');
  const slot = h('span', { class: 'cl-tag-slot', hidden: true });
  if (!userId) return slot;
  tagOf(userId).then(async (tag) => {
    if (!tag) return;
    await loadNs('clans').catch(() => {});
    slot.append(tagChip({ tag: tag.tag, color: tag.color, name: t('clans.tagTitle', { name: tag.name }) }));
    slot.hidden = false;
  }).catch(() => {});
  return slot;
}
