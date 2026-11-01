// Catalogo de skins que viene con el launcher: busqueda, categorias, modelo, favoritas y una grilla que
// carga de a 48 ("Cargar mas"). Las imagenes llegan como data: desde el proceso principal (skins:catalog),
// ya revisadas. Los filtros, la pestana, la skin elegida y el modelo elegido para cada skin se recuerdan
// mientras el launcher esta abierto (estado del modulo). Los pedidos viejos se descartan: si los filtros
// cambian rapido, solo se dibuja la respuesta del ultimo.
import { h, icon, mount, setBusy, skeleton, emptyState, fail } from '../../ui.js';
import { api } from '../../store.js';
import { t, locale } from '../../i18n.js';
import { loadImage, normalizeSkin } from './texture.js';
import { variantLabel, skinThumb } from './parts.js';

const PAGE = 48;
const NORM_MAX = 400; // miniaturas decodificadas que se guardan
const SEARCH_DELAY = 250;
const NAMED = ['Esteticas', 'Kawaii', 'Lindas']; // categorias con nombre traducido

export const memory = {
  tab: 'library', // 'library' | 'catalog'
  filters: { query: '', category: '', model: '', onlyFavorites: false },
  pick: null, // skin del catalogo elegida (con su imagen)
  variants: new Map(), // id -> modelo elegido por el jugador
  catalogTotal: null,
  favoriteCount: null,
};

const norms = new Map(); // id -> { canvas, legacy } o { error: true } (las mas usadas al final)
const pending = new Map(); // id -> Promise

export const catalogKey = (id) => `cat:${id}`;
export const isCatalogKey = (key) => typeof key === 'string' && key.startsWith('cat:');
export const categoryLabel = (id) => (NAMED.includes(id) ? t(`skins.category${id}`) : id);
export const fmtCount = (n) => new Intl.NumberFormat(locale()).format(n || 0);

// Modelo con el que se ve y se usa: el elegido o el del catalogo (las de 64x32, siempre clasico).
export function catalogVariant(it) {
  return it.legacy ? 'classic' : memory.variants.get(it.id) || it.model;
}

export function setCatalogVariant(it, v) {
  if (it.legacy || (v !== 'classic' && v !== 'slim')) return;
  if (v === it.model) memory.variants.delete(it.id);
  else memory.variants.set(it.id, v);
}

export function catalogMeta(it) {
  const category = categoryLabel(it.category);
  return it.legacy ? t('skins.catalogMetaLegacy', { category }) : t('skins.catalogMeta', { category, variant: variantLabel(catalogVariant(it)) });
}

// Skin decodificada (o undefined si todavia no se decodifico).
export function catalogNorm(it) {
  const n = it ? norms.get(it.id) : undefined;
  if (n) {
    norms.delete(it.id);
    norms.set(it.id, n);
  }
  return n;
}

export function ensureNorm(it) {
  if (!it) return Promise.resolve(undefined);
  if (norms.has(it.id)) return Promise.resolve(catalogNorm(it));
  if (pending.has(it.id)) return pending.get(it.id);
  const run = (async () => {
    let n;
    try {
      if (it.broken || !it.image) throw new Error('sin imagen');
      n = normalizeSkin(await loadImage(it.image));
    } catch (err) {
      if (!it.broken) console.warn('[skins] no se pudo leer la skin del catálogo', it.id, err?.message);
      n = { error: true };
    }
    norms.set(it.id, n);
    while (norms.size > NORM_MAX) norms.delete(norms.keys().next().value);
    pending.delete(it.id);
    return n;
  })();
  pending.set(it.id, run);
  return run;
}

// Vista del catalogo (contenido de su pestana). La pagina le pasa la seleccion y le avisa los cambios:
//  selectedKey() -> clave elegida ('cat:<id>', 'account' o un id de la biblioteca)
//  inUse(item)   -> si es la skin que tiene puesta la cuenta
//  onPick(item)  -> el jugador eligio una skin de la grilla
//  onChange()    -> cambio algo que la pagina muestra (favorita, totales)
export function createCatalogView({ selectedKey, inUse, onPick, onChange }) {
  let alive = true;
  let req = 0; // pedido vigente
  let timer = 0;
  let items = [];
  let total = null; // null: todavia no hay resultados
  let loadingFirst = false;
  let loadingMore = false;
  let error = null;
  let grid = null;
  let cats = []; // cuantas hay por categoria con los filtros actuales
  const tiles = new Map(); // id -> elemento
  const favBusy = new Set();
  const f = memory.filters;

  // ---------- Herramientas ----------
  const search = h('input', {
    class: 'input',
    type: 'search',
    value: f.query,
    maxlength: '100',
    spellcheck: 'false',
    placeholder: t('skins.catalogSearchPlaceholder'),
    'aria-label': t('skins.catalogSearch'),
    oninput: () => {
      clearTimeout(timer);
      timer = setTimeout(() => setFilter({ query: search.value.trim() }), SEARCH_DELAY);
    },
    onkeydown: (e) => {
      if (e.key !== 'Enter') return;
      clearTimeout(timer);
      setFilter({ query: search.value.trim() });
    },
    onsearch: () => {
      clearTimeout(timer);
      setFilter({ query: search.value.trim() });
    },
  });
  const chips = new Map(); // id de categoria ('' = todas) -> { btn, count }
  const chipsEl = h('div', { class: 'chips sk-cat-chips', role: 'group', 'aria-label': t('skins.categoryGroup') });
  const addChip = (id) => {
    const count = h('span', { class: 'count' });
    const btn = h('button', { class: 'chip', type: 'button', 'aria-pressed': 'false', onclick: () => setFilter({ category: id }) }, h('span', {}, id ? categoryLabel(id) : t('skins.categoryAll')), count);
    chips.set(id, { btn, count });
    chipsEl.append(btn);
  };
  for (const id of ['', ...NAMED]) addChip(id);
  const models = ['', 'classic', 'slim'].map((m) => h('button', { type: 'button', 'aria-pressed': 'false', dataset: { model: m }, onclick: () => setFilter({ model: m }) }, m ? variantLabel(m) : t('skins.modelAll')));
  const favCount = h('span', { class: 'count' });
  const favBtn = h('button', { class: 'chip sk-cat-favs', type: 'button', 'aria-pressed': 'false', onclick: () => setFilter({ onlyFavorites: !f.onlyFavorites }) }, icon('star'), h('span', {}, t('skins.favoritesFilter')), favCount);
  const status = h('p', { class: 'sk-cat-status', role: 'status', 'aria-live': 'polite' });
  const results = h('div', { class: 'sk-cat-results' });
  const moreBtn = h('button', { class: 'btn', type: 'button', onclick: () => loadMore() }, icon('plus'), t('skins.loadMore'));
  const more = h('div', { class: 'sk-cat-more', hidden: true }, moreBtn);
  const el = h(
    'div',
    { class: 'sk-cat' },
    h(
      'div',
      { class: 'sk-cat-tools' },
      h('div', { class: 'input-icon sk-cat-search' }, icon('search'), search),
      chipsEl,
      h('div', { class: 'sk-cat-row' }, h('div', { class: 'segmented sk-seg', role: 'group', 'aria-label': t('skins.model') }, models), favBtn),
    ),
    status,
    results,
    more,
  );

  function drawTools(categories) {
    if (categories) {
      cats = categories.map((c) => ({ id: String(c.id), count: Number(c.count) || 0 }));
      for (const c of cats) if (!chips.has(c.id)) addChip(c.id);
      const counts = new Map(cats.map((c) => [c.id, c.count]));
      const all = cats.reduce((a, c) => a + c.count, 0);
      for (const [id, { count }] of chips) count.textContent = fmtCount(id ? counts.get(id) || 0 : all);
    }
    for (const [id, { btn }] of chips) {
      const on = f.category === id;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', String(on));
    }
    for (const b of models) {
      const on = f.model === b.dataset.model;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    }
    favBtn.classList.toggle('active', f.onlyFavorites);
    favBtn.setAttribute('aria-pressed', String(f.onlyFavorites));
    favCount.textContent = memory.favoriteCount === null ? '' : fmtCount(memory.favoriteCount);
  }

  function drawStatus() {
    // Sin resultados no hace falta: el estado vacio ya lo dice
    if (total === null || loadingFirst || !total || (error && !items.length)) status.textContent = '';
    else if (items.length < total) status.textContent = t('skins.catalogShowing', { shown: fmtCount(items.length), total: fmtCount(total) });
    else status.textContent = t('skins.catalogResults', { count: total, total: fmtCount(total) });
    more.hidden = total === null || loadingFirst || items.length >= total || (!items.length && Boolean(error));
  }

  // ---------- Grilla ----------
  function tileFor(it) {
    const key = catalogKey(it.id);
    const selected = selectedKey() === key;
    const n = norms.get(it.id);
    const broken = it.broken || n?.error;
    const used = inUse(it);
    const favLabel = t(it.favorite ? 'skins.favoriteRemove' : 'skins.favoriteAdd');
    // La estrella es para el mouse (no recibe foco): con el teclado esta en el detalle de la skin
    const star = h(
      'button',
      {
        class: 'sk-fav',
        type: 'button',
        tabindex: '-1',
        'aria-hidden': 'true',
        title: favLabel,
        onclick: (e) => {
          e.stopPropagation();
          toggleFavorite(it);
        },
      },
      icon('star'),
    );
    const tile = h(
      'div',
      {
        class: ['sk-tile', 'sk-cat-tile', selected && 'active', broken && 'broken', it.favorite && 'fav'],
        role: 'option',
        'aria-selected': String(selected),
        tabindex: selected ? '0' : '-1',
        title: it.name,
        dataset: { skFocus: `tile:${key}`, id: key, state: tileState(it) },
        onclick: (e) => {
          pickItem(it);
          (e.currentTarget.isConnected ? e.currentTarget : tiles.get(it.id))?.focus();
        },
      },
      h(
        'div',
        { class: 'sk-tile-art' },
        broken ? icon('alert', 'sk-tile-icon') : n?.canvas ? skinThumb(n.canvas, catalogVariant(it)) : h('div', { class: 'spinner', 'aria-hidden': 'true' }),
        used ? h('span', { class: 'sk-tile-badge good sk-left', title: t('skins.inUse') }, icon('check'), h('span', { class: 'sr-only' }, t('skins.inUse'))) : null,
        star,
      ),
      h('div', { class: 'sk-tile-name ellipsis' }, it.name),
      h('div', { class: 'sk-tile-meta', title: catalogMeta(it) }, broken ? t('skins.damaged') : catalogMeta(it), it.favorite ? h('span', { class: 'sr-only' }, ` · ${t('skins.favorite')}`) : null),
    );
    tiles.set(it.id, tile);
    // Miniatura que salio del cache (muchas skins cargadas): se vuelve a decodificar y se reemplaza sola
    if (!n && !it.broken) {
      ensureNorm(it).then(() => {
        if (!alive || tiles.get(it.id) !== tile || !tile.isConnected) return;
        const focused = document.activeElement === tile;
        const fresh = tileFor(it);
        tile.replaceWith(fresh);
        if (focused) fresh.focus({ preventScroll: true });
      });
    }
    return tile;
  }

  // Lo que cambia el dibujo de una miniatura (elegida, en uso, favorita y modelo)
  const tileState = (it) => `${selectedKey() === catalogKey(it.id)}|${inUse(it)}|${it.favorite}|${catalogVariant(it)}`;

  function drawResults() {
    if (!alive) return;
    results.classList.remove('sk-stale');
    results.removeAttribute('aria-busy');
    tiles.clear();
    grid = null;
    if (error && !items.length) {
      mount(results, h('div', { class: 'notice bad' }, icon('alert'), h('div', {}, h('div', {}, t('skins.catalogFailed')), h('div', { class: 'small' }, error.message || ''), h('button', { class: 'btn sm tonal sk-notice-btn', type: 'button', dataset: { skFocus: 'catalogRetry' }, onclick: () => reload() }, icon('refresh'), t('common.retry')))));
    } else if (total === null) {
      mount(results, skeleton('grid', { items: 6, min: 116, label: t('skins.loadingCatalog') }));
    } else if (!items.length) {
      const noFavorites = f.onlyFavorites && !memory.favoriteCount;
      const action = noFavorites
        ? h('button', { class: 'btn tonal', type: 'button', dataset: { skFocus: 'catalogShowAll' }, onclick: () => resetFilters() }, icon('grid'), t('skins.showWholeCatalog'))
        : h('button', { class: 'btn tonal', type: 'button', dataset: { skFocus: 'catalogClear' }, onclick: () => resetFilters() }, icon('x'), t('skins.clearFilters'));
      mount(results, h('div', { class: 'sk-drop-empty' }, noFavorites ? emptyState('star', t('skins.favoritesEmptyTitle'), t('skins.favoritesEmptyText'), action) : emptyState('search', t('skins.catalogEmptyTitle'), t('skins.catalogEmptyText'), action)));
    } else {
      grid = h('div', { class: 'sk-grid', role: 'listbox', 'aria-label': t('skins.catalogTitle'), 'aria-orientation': 'horizontal', onkeydown: onGridKey }, items.map(tileFor));
      mount(results, grid);
      roving();
    }
    drawStatus();
  }

  // Siempre hay una miniatura que recibe el foco con Tab (la elegida o la primera)
  function roving() {
    if (!grid || grid.querySelector('[role="option"][tabindex="0"]')) return;
    grid.querySelector('[role="option"]')?.setAttribute('tabindex', '0');
  }

  function pickItem(it) {
    memory.pick = it;
    onPick(it);
  }

  // Flechas, Inicio y Fin (la seleccion sigue al foco, como en la biblioteca)
  function onGridKey(e) {
    const opts = [...e.currentTarget.querySelectorAll('[role="option"]')];
    const i = opts.indexOf(document.activeElement);
    if (i < 0) return;
    const cols = Math.max(1, getComputedStyle(e.currentTarget).gridTemplateColumns.split(' ').filter(Boolean).length);
    const moves = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols, Home: -i, End: opts.length - 1 - i };
    if (!(e.key in moves)) return;
    e.preventDefault();
    const next = opts[Math.min(opts.length - 1, Math.max(0, i + moves[e.key]))];
    if (!next || next === opts[i]) return;
    const it = items.find((x) => catalogKey(x.id) === next.dataset.id);
    if (!it) return;
    pickItem(it);
    tiles.get(it.id)?.focus();
  }

  // Redibuja solo las miniaturas que cambiaron (elegida, en uso, favorita o modelo)
  function sync() {
    if (!grid) return;
    for (const it of items) {
      const old = tiles.get(it.id);
      if (!old || old.dataset.state === tileState(it)) continue;
      const focused = document.activeElement === old;
      const fresh = tileFor(it);
      old.replaceWith(fresh);
      if (focused) fresh.focus({ preventScroll: true });
    }
    for (const opt of grid.querySelectorAll('[role="option"][tabindex="0"]')) if (opt.getAttribute('aria-selected') !== 'true') opt.setAttribute('tabindex', '-1');
    roving();
  }

  // ---------- Datos ----------
  function applyInfo(r) {
    if (Number.isFinite(r?.catalogTotal)) memory.catalogTotal = r.catalogTotal;
    if (Number.isFinite(r?.favoriteCount)) memory.favoriteCount = r.favoriteCount;
  }

  async function fetchPage(offset, token) {
    const r = await api.invoke('skins:catalog', { query: f.query, category: f.category, model: f.model, onlyFavorites: f.onlyFavorites, offset, limit: PAGE });
    if (!alive || token !== req) return null;
    const list = Array.isArray(r?.items) ? r.items : [];
    // Las miniaturas se decodifican antes de dibujar (son PNG chicos): la grilla aparece completa
    await Promise.all(list.map(ensureNorm));
    if (!alive || token !== req) return null;
    applyInfo(r);
    return { ...r, items: list };
  }

  async function reload() {
    const token = ++req;
    loadingFirst = true;
    error = null;
    drawStatus();
    // Con resultados en pantalla se atenuan hasta que llegan los nuevos (sin parpadeo); si no, esqueleto
    if (total === null) drawResults();
    else {
      results.classList.add('sk-stale');
      results.setAttribute('aria-busy', 'true');
    }
    let r = null;
    try {
      r = await fetchPage(0, token);
    } catch (err) {
      if (!alive || token !== req) return;
      console.warn('[skins] catálogo:', err?.message);
      error = err;
      items = [];
      total = 0;
    }
    if (!alive || token !== req) return;
    loadingFirst = false;
    if (r) {
      items = r.items;
      total = r.total;
      drawTools(r.categories);
    }
    drawResults();
    onChange();
  }

  async function loadMore() {
    if (loadingMore || loadingFirst || total === null || items.length >= total) return;
    const token = req;
    const hadFocus = document.activeElement === moreBtn;
    loadingMore = true;
    const done = setBusy(moreBtn);
    let added = [];
    try {
      const r = await fetchPage(items.length, token);
      if (!r) return;
      const known = new Set(items.map((i) => i.id));
      added = r.items.filter((i) => !known.has(i.id));
      items.push(...added);
      total = r.total;
      drawTools(r.categories);
      if (grid) for (const it of added) grid.append(tileFor(it));
      else drawResults();
    } catch (err) {
      if (alive && token === req) fail(t('skins.catalogFailed'), err);
    } finally {
      loadingMore = false;
      done();
      if (alive && token === req) {
        drawStatus();
        // Con el teclado, el foco sigue en la primera skin nueva
        if (hadFocus && added.length) tiles.get(added[0].id)?.focus();
      }
    }
  }

  function setFilter(patch) {
    const before = JSON.stringify(f);
    Object.assign(f, patch);
    if (JSON.stringify(f) === before) return;
    drawTools();
    reload();
  }

  function resetFilters() {
    clearTimeout(timer);
    Object.assign(f, { query: '', category: '', model: '', onlyFavorites: false });
    search.value = '';
    drawTools();
    reload();
    search.focus({ preventScroll: true });
  }

  // Marca o desmarca una favorita (se ve al instante; si falla, vuelve como estaba).
  function markFavorite(id, on) {
    for (const it of items) if (it.id === id) it.favorite = on;
    if (memory.pick?.id === id) memory.pick.favorite = on;
  }

  async function toggleFavorite(it) {
    if (!it || favBusy.has(it.id)) return;
    favBusy.add(it.id);
    const on = !it.favorite;
    markFavorite(it.id, on);
    if (memory.favoriteCount !== null) memory.favoriteCount = Math.max(0, memory.favoriteCount + (on ? 1 : -1));
    drawTools();
    sync();
    onChange();
    try {
      const r = await api.invoke('skins:catalogFavorite', it.id, on);
      if (!alive) return;
      applyInfo(r);
      // En Favoritas, la que se desmarca sale de la lista
      if (f.onlyFavorites && !r.favorite) dropItem(it.id);
    } catch (err) {
      markFavorite(it.id, !on);
      if (memory.favoriteCount !== null) memory.favoriteCount = Math.max(0, memory.favoriteCount + (on ? -1 : 1));
      if (alive) fail(t('skins.favoriteFailed'), err);
    } finally {
      favBusy.delete(it.id);
      if (alive) {
        drawTools();
        sync();
        onChange();
      }
    }
  }

  function dropItem(id) {
    const i = items.findIndex((x) => x.id === id);
    if (i < 0) return;
    const tile = tiles.get(id);
    const focused = tile && tile.contains(document.activeElement);
    const [gone] = items.splice(i, 1);
    total = Math.max(0, (total || 1) - 1);
    const c = cats.find((x) => x.id === gone.category);
    if (c) c.count = Math.max(0, c.count - 1);
    drawTools(cats);
    if (!items.length) {
      if (total > 0) reload();
      else drawResults();
      return;
    }
    tile?.remove();
    tiles.delete(id);
    roving();
    drawStatus();
    if (focused) tiles.get(items[Math.min(i, items.length - 1)].id)?.focus();
  }

  drawTools();

  return {
    el,
    // Al mostrar la pestana: primera carga (despues quedan los resultados)
    activate() {
      if (total === null && !loadingFirst) reload();
    },
    // Solo los totales (para el contador de la pestana), sin imagenes
    async prefetch() {
      try {
        applyInfo(await api.invoke('skins:catalog', { limit: 0 }));
        if (alive) {
          drawTools();
          onChange();
        }
      } catch (err) {
        console.warn('[skins] catálogo:', err?.message);
      }
    },
    sync,
    toggleFavorite,
    isFavoriteBusy: (id) => favBusy.has(id),
    destroy() {
      alive = false;
      req++;
      clearTimeout(timer);
    },
  };
}
