// Paleta de comandos (Ctrl+K): escribí para saltar a cualquier pagina o hacer una accion.
// Los comandos salen de "proveedores" (funciones que devuelven una lista); otros modulos pueden
// sumar los suyos con registerCommands(() => [{ id, title, run, ... }]).
import { h, icon } from '../ui.js';
import { t } from '../i18n.js';

const RECENT_KEY = 'venus.a11y.palette.recent';
const MAX_RESULTS = 60;
const providers = new Set();
const GROUP_ORDER = ['recent', 'pages', 'actions', 'instances', 'servers', 'a11y', 'appearance'];
let ui = null; // { backdrop, input, list, results, active, prevFocus }
let changeHandler = null;

// Comando: { id, title, sub?, group?, icon?: string|Element, keywords?: string, hint?: string, run: () => void }
// Opcionales: state (true/false: interruptor que muestra Si/No) y radio: true (opcion de un grupo excluyente,
// como un color o un modo: solo la elegida muestra "En uso").
export function registerCommands(provider) {
  if (typeof provider !== 'function') return () => {};
  providers.add(provider);
  return () => providers.delete(provider);
}

export function initPalette({ onChange } = {}) {
  changeHandler = onChange || null;
  window.addEventListener(
    'keydown',
    (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        e.stopPropagation();
        if (isOpen()) close();
        else open();
      }
    },
    true,
  );
}

export const paletteApi = {
  isOpen: () => isOpen(),
  open: () => open(),
  close: () => close(),
  move: (d) => moveActive(d),
  run: () => runActive(),
};

export function isOpen() {
  return Boolean(ui?.backdrop.isConnected);
}

// ---------- Busqueda ----------
const norm = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

// Coincidencia aproximada: todas las letras en orden, con premio por inicio de palabra y letras seguidas.
function fuzzy(q, text) {
  if (!q) return { score: 0, hits: [] };
  const hits = [];
  let from = 0;
  let prev = -2;
  let score = 0;
  let chunks = 0;
  let letters = 0;
  for (const ch of q) {
    if (ch === ' ') continue;
    const i = text.indexOf(ch, from);
    if (i < 0) return null;
    const wordStart = i === 0 || /[\s\-_/:.·(]/.test(text[i - 1]);
    const together = i === prev + 1;
    if (!together) chunks++;
    score += 1 + (together ? 3 : 0) + (wordStart ? 4 : 0);
    hits.push(i);
    prev = i;
    from = i + 1;
    letters++;
  }
  // letras muy desparramadas no cuentan como coincidencia
  if (chunks > Math.max(2, Math.ceil(letters / 2.5))) return null;
  const compact = q.replace(/\s+/g, ' ').trim();
  if (text.includes(compact)) score += 12 + (text.startsWith(compact) ? 8 : 0);
  return { score: score - (chunks - 1) * 2 - hits[0] * 0.08 - text.length * 0.01, hits };
}

function collect() {
  const out = [];
  const seen = new Set();
  for (const p of providers) {
    let list = [];
    try {
      list = p() || [];
    } catch (err) {
      console.warn('[a11y] palette', err);
    }
    for (const c of list) {
      if (!c || !c.id || !c.title || typeof c.run !== 'function' || seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
    }
  }
  return out;
}

function readRecent() {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 6) : [];
  } catch {
    return [];
  }
}

function pushRecent(id) {
  try {
    const list = [id, ...readRecent().filter((x) => x !== id)].slice(0, 6);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* sin almacenamiento local */
  }
}

function search(query) {
  const all = collect();
  const q = norm(query).trim();
  if (!q) {
    const recentIds = readRecent();
    const recent = recentIds.map((id) => all.find((c) => c.id === id)).filter(Boolean).map((c) => ({ cmd: c, group: 'recent', hits: [] }));
    const rest = all.filter((c) => !recentIds.includes(c.id)).map((c) => ({ cmd: c, group: c.group || 'actions', hits: [] }));
    return sortGroups([...recent, ...rest]).slice(0, MAX_RESULTS);
  }
  const scored = [];
  for (const c of all) {
    const title = norm(c.title);
    const m = fuzzy(q, title);
    const k = c.keywords || c.sub ? fuzzy(q, norm(`${c.keywords || ''} ${c.sub || ''}`)) : null;
    const best = m && (!k || m.score >= k.score - 6) ? { score: m.score + 6, hits: m.hits } : k ? { score: k.score, hits: [] } : null;
    if (best) scored.push({ cmd: c, group: c.group || 'actions', hits: title.length === c.title.length ? best.hits : [], score: best.score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_RESULTS);
}

function sortGroups(list) {
  const rank = (g) => {
    const i = GROUP_ORDER.indexOf(g);
    return i < 0 ? GROUP_ORDER.length : i;
  };
  return list.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r.group) - rank(b.r.group) || a.i - b.i).map((x) => x.r);
}

// ---------- Interfaz ----------
// Los grupos propios se traducen; los que agregan otros modulos ya vienen con su texto
function groupLabel(g) {
  return GROUP_ORDER.includes(g) ? t(`a11y.palGroup_${g}`) : String(g);
}

function highlight(text, hits) {
  if (!hits?.length) return text;
  const set = new Set(hits);
  const out = [];
  let buf = '';
  let marked = false;
  for (let i = 0; i < text.length; i++) {
    const isHit = set.has(i);
    if (isHit !== marked && buf) {
      out.push(marked ? h('mark', {}, buf) : buf);
      buf = '';
    }
    marked = isHit;
    buf += text[i];
  }
  if (buf) out.push(marked ? h('mark', {}, buf) : buf);
  return out;
}

function iconEl(c) {
  if (c.icon instanceof Element) return c.icon.cloneNode(true);
  return icon(c.icon || 'arrowRight');
}

// Estado a la derecha: interruptores con Si/No; en los grupos excluyentes solo la opcion elegida.
function stateEl(c) {
  if (c.state === undefined) return null;
  if (c.radio) return c.state ? h('span', { class: 'ax-pal-state on' }, t('a11y.palCurrent')) : null;
  return h('span', { class: ['ax-pal-state', c.state && 'on'] }, c.state ? t('a11y.palOn') : t('a11y.palOff'));
}

// Cantidad de resultados para el lector de pantalla (con una pequeña espera mientras se escribe).
let announceTimer = 0;
function announceResults(query, count) {
  clearTimeout(announceTimer);
  if (!ui?.live) return;
  const live = ui.live;
  if (!query) {
    live.textContent = '';
    return;
  }
  announceTimer = setTimeout(() => {
    live.textContent = count ? t('a11y.palCount', { count }) : t('a11y.palNoResults', { query });
  }, 350);
}

function render() {
  if (!ui) return;
  const query = ui.input.value;
  const results = search(query);
  ui.results = results;
  ui.active = results.length ? Math.min(ui.active, results.length - 1) : -1;
  if (ui.active < 0 && results.length) ui.active = 0;
  const nodes = [];
  let lastGroup = null;
  const grouped = !norm(query).trim();
  results.forEach((r, i) => {
    if (grouped && r.group !== lastGroup) {
      lastGroup = r.group;
      nodes.push(h('div', { class: 'ax-pal-group', role: 'presentation' }, groupLabel(r.group)));
    }
    const c = r.cmd;
    nodes.push(
      h(
        'div',
        {
          class: ['ax-pal-item', i === ui.active && 'active'],
          id: `ax-pal-opt-${i}`,
          role: 'option',
          'aria-selected': String(i === ui.active),
          dataset: { i: String(i) },
          onmousemove: () => {
            if (ui.active !== i) setActive(i, false);
          },
          onclick: () => runAt(i),
        },
        h('span', { class: 'ax-pal-icon' }, iconEl(c)),
        h('span', { class: 'ax-pal-text' }, h('span', { class: 'ax-pal-title', title: c.title }, highlight(c.title, r.hits)), c.sub ? h('span', { class: 'ax-pal-sub', title: c.sub }, c.sub) : null),
        stateEl(c),
        c.hint ? h('span', { class: 'kbd ax-pal-kbd' }, c.hint) : !grouped ? h('span', { class: 'ax-pal-tag' }, groupLabel(r.group)) : null,
      ),
    );
  });
  // Sin resultados: que paso y como seguir (otras palabras o buscar por pagina, instancia o accion)
  if (!results.length) {
    nodes.push(
      h(
        'div',
        { class: 'ax-pal-empty', role: 'presentation' },
        icon('search'),
        h('div', { class: 'text-2' }, t('a11y.palNoResults', { query: query.trim() })),
        h('div', { class: 'small' }, t('a11y.palNoResultsHint')),
      ),
    );
  }
  ui.list.replaceChildren(...nodes);
  syncActive();
  announceResults(query.trim(), results.length);
}

function syncActive() {
  if (!ui) return;
  ui.list.querySelectorAll('.ax-pal-item').forEach((el) => {
    const on = Number(el.dataset.i) === ui.active;
    el.classList.toggle('active', on);
    el.setAttribute('aria-selected', String(on));
  });
  if (ui.active >= 0) {
    ui.input.setAttribute('aria-activedescendant', `ax-pal-opt-${ui.active}`);
    ui.list.querySelector(`#ax-pal-opt-${ui.active}`)?.scrollIntoView({ block: 'nearest' });
  } else ui.input.removeAttribute('aria-activedescendant');
}

function setActive(i, scroll = true) {
  if (!ui) return;
  ui.active = i;
  if (scroll) syncActive();
  else {
    ui.list.querySelectorAll('.ax-pal-item').forEach((el) => {
      const on = Number(el.dataset.i) === i;
      el.classList.toggle('active', on);
      el.setAttribute('aria-selected', String(on));
    });
    ui.input.setAttribute('aria-activedescendant', `ax-pal-opt-${i}`);
  }
}

function moveActive(d) {
  if (!ui || !ui.results.length) return;
  const n = ui.results.length;
  setActive((((ui.active < 0 ? 0 : ui.active + d) % n) + n) % n);
}

function runActive() {
  if (ui && ui.active >= 0) runAt(ui.active);
}

function runAt(i) {
  const r = ui?.results[i];
  if (!r) return;
  pushRecent(r.cmd.id);
  close({ restore: !r.cmd.keepFocus });
  setTimeout(() => {
    try {
      r.cmd.run();
    } catch (err) {
      console.error('[a11y] palette', err);
    }
  }, 0);
}

export function open(initial = '') {
  if (isOpen()) {
    ui.input.focus();
    return;
  }
  const input = h('input', {
    class: 'ax-pal-input',
    type: 'text',
    placeholder: t('a11y.palPlaceholder'),
    'aria-label': t('a11y.palLabel'),
    role: 'combobox',
    'aria-expanded': 'true',
    'aria-controls': 'ax-pal-list',
    'aria-autocomplete': 'list',
    autocomplete: 'off',
    spellcheck: 'false',
    value: initial,
  });
  const list = h('div', { class: 'ax-pal-list', id: 'ax-pal-list', role: 'listbox', 'aria-label': t('a11y.palResults') });
  const live = h('div', { class: 'sr-only', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const box = h(
    'div',
    { class: 'ax-palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('a11y.palLabel') },
    h('div', { class: 'ax-pal-head' }, icon('search'), input, h('span', { class: 'kbd', 'aria-hidden': 'true' }, 'Esc')),
    list,
    live,
    h(
      'div',
      { class: 'ax-pal-foot' },
      h('span', {}, h('span', { class: 'kbd' }, '↑'), h('span', { class: 'kbd' }, '↓'), t('a11y.palMove')),
      h('span', {}, h('span', { class: 'kbd' }, 'Enter'), t('a11y.palRun')),
      h('span', {}, h('span', { class: 'kbd' }, 'Esc'), t('a11y.palClose')),
      h('span', { class: 'spacer' }),
      h('span', { class: 'ax-pal-brand' }, h('span', { class: 'kbd' }, 'Ctrl'), h('span', { class: 'kbd' }, 'K')),
    ),
  );
  const backdrop = h('div', { class: 'ax-palette-backdrop' }, box);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  input.addEventListener('input', () => {
    ui.active = 0;
    render();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveActive(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveActive(-1);
    } else if (e.key === 'PageDown') {
      e.preventDefault();
      moveActive(5);
    } else if (e.key === 'PageUp') {
      e.preventDefault();
      moveActive(-5);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runActive();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      moveActive(e.shiftKey ? -1 : 1);
    }
  });
  ui = { backdrop, input, list, live, results: [], active: 0, prevFocus: document.activeElement };
  document.body.append(backdrop);
  render();
  input.focus();
  changeHandler?.(true);
}

export function close({ restore = true } = {}) {
  if (!ui) return;
  const { backdrop, prevFocus } = ui;
  ui = null;
  backdrop.remove();
  if (restore && prevFocus?.isConnected && prevFocus !== document.body) prevFocus.focus({ preventScroll: true });
  changeHandler?.(false);
}
