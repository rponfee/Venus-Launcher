// Multijugador: servidores destacados, mis servidores (la lista del juego de cada instancia),
// amigos jugando y consulta de cualquier servidor por IP. Se actualiza solo cada 30 segundos.
import { h, icon, mount, emptyState, debounce, fail, ok, confirmDialog, selectEl, avatarImg, fmtAgo, fmtDuration, instanceIcon, LOADERS, skeleton, sectionTitle } from '../ui.js';
import { store, api } from '../store.js';
import { t, has } from '../i18n.js';
import { netAllowed, optInBlock } from '../features/netprefs.js';
import { navigate } from '../app.js';
import { cloud } from '../cloud.js';
import { social } from '../social.js';
import {
  ensureUi,
  pingServer,
  motdView,
  latencyBars,
  serverIcon,
  playersText,
  versionText,
  loaderText,
  loaderBadgeFor,
  errorText,
  joinServer,
  openBuildFromServer,
  openSaveDialog,
  cleanAddress,
  sampleView,
  fmtInt,
  copyText,
} from '../features/serverlist.js';

const NS = 'multiplayer';
const REFRESH_MS = 30000;
const TABS = [
  { id: 'featured', icon: 'star' },
  { id: 'saved', icon: 'server' },
  { id: 'friends', icon: 'users' },
  { id: 'search', icon: 'search' },
];
const LANG_ORDER = ['es', 'en', 'pt', 'multi'];

const keyOf = (address) => String(address || '').trim().toLowerCase().replace(/:25565$/, '');

function prefs() {
  const p = store.settings?.multiplayer;
  return p && typeof p === 'object' ? p : {};
}

const savePrefs = debounce((patch) => {
  store.setSettings({ multiplayer: { ...prefs(), ...patch } }).catch(() => {});
}, 600);

// Etiquetas e idiomas pueden venir de la nube: si no hay traduccion se muestran tal cual
function tagLabel(tag) {
  return has(`${NS}.tag_${tag}`) ? t(`${NS}.tag_${tag}`) : tag;
}

function langLabel(lang) {
  return has(`${NS}.lang_${lang}`) ? t(`${NS}.lang_${lang}`) : String(lang).toUpperCase();
}

// 'Consultado recién' / 'Consultado hace 3 minutos'
function checkedLabel(ts) {
  const at = ts || Date.now();
  return Date.now() - at < 60000 ? t(`${NS}.checkedNow`) : t(`${NS}.checkedAgo`, { time: fmtAgo(at) });
}

function copyAddress(address) {
  copyText(address, t(`${NS}.ipCopied`));
}

// Huesos de esqueleto (formas decorativas: el anuncio "Cargando..." lo lleva el contenedor)
const bone = (cls, style) => h('span', { class: `skeleton ${cls}`, style });

// Contenedor de un esqueleto armado a mano: se anuncia una sola vez ("Cargando..." o el texto dado)
function skeletonBox(cls, shapes, label = t('common.loading')) {
  return h('div', { class: ['skeleton-group', cls], role: 'status', 'aria-live': 'polite', 'aria-busy': 'true' }, h('span', { class: 'sr-only' }, label), h('div', { class: 'skeleton-shapes', 'aria-hidden': 'true' }, shapes));
}

// MOTD que todavia no llego (primer ping)
function motdSkeleton(compact = false) {
  return h('div', { class: ['sl-motd', 'sl-motd-skeleton', compact && 'sl-motd-compact'], 'aria-hidden': 'true' }, bone('skeleton-line'), compact ? null : bone('skeleton-line'));
}

// Estado de un servidor dentro de una tarjeta o fila (se actualiza con cada ping)
function statusSlots({ fallbackVersion = '', compact = false } = {}) {
  const players = h('span', { class: 'mp-players' }, icon('users'), h('span', {}, '…'));
  const bars = h('span', { class: 'mp-bars' }, latencyBars(null));
  const version = h('span', { class: 'badge mp-version' }, fallbackVersion || '…');
  return {
    players,
    bars,
    version,
    update(r) {
      mount(players, icon('users'), h('span', {}, r?.online ? playersText(r, { compact }) : '–'));
      players.title = r?.online ? t(`${NS}.playersTitle`, { online: fmtInt(r.players?.online), max: fmtInt(r.players?.max) }) : '';
      mount(bars, latencyBars(r));
      const v = r?.online ? versionText(r) : fallbackVersion;
      version.textContent = v || '–';
      version.title = r?.online && r.version ? r.version : '';
      version.classList.toggle('hidden', !v);
    },
  };
}

export default {
  ns: [NS],
  css: ['pages/multiplayer', 'features/serverlist'],

  async render(root, params) {
    await ensureUi();
    let alive = true;
    const results = new Map(); // direccion -> ultimo ping
    const counts = new Map(); // pestaña -> numero que se muestra al lado
    let view = null;
    let tab = TABS.some((x) => x.id === params[0]) ? params[0] : TABS.some((x) => x.id === prefs().tab) ? prefs().tab : 'featured';

    const ping = async (address, opts) => {
      const r = await pingServer(address, opts);
      results.set(keyOf(address), r);
      return r;
    };

    const tabsEl = h('div', { class: 'tabs mp-tabs', role: 'tablist', 'aria-label': t(`${NS}.title`) });
    const content = h('div', { class: 'mp-content' });
    // Actualizar ahora: el icono gira mientras se consulta (minimo un instante para que se note)
    const refreshBtn = h('button', {
      class: 'icon-btn',
      title: t(`${NS}.refresh`),
      'aria-label': t(`${NS}.refresh`),
      onclick: async () => {
        if (refreshBtn.classList.contains('mp-busy')) return;
        refreshBtn.classList.add('mp-busy');
        refreshBtn.setAttribute('aria-busy', 'true');
        try {
          await Promise.all([Promise.resolve(view?.refresh?.(true)).catch(() => {}), new Promise((r) => setTimeout(r, 500))]);
        } finally {
          refreshBtn.classList.remove('mp-busy');
          refreshBtn.removeAttribute('aria-busy');
        }
      },
    }, icon('refresh'));

    mount(
      root,
      h(
        'div',
        { class: 'mp-root' },
        h(
          'div',
          { class: 'page-head' },
          h('div', { class: 'ph-text' }, h('h1', { class: 'page-title' }, t(`${NS}.title`)), h('p', { class: 'page-sub' }, t(`${NS}.subtitle`))),
          // Actualizar primero (como en Mundos y Extensiones): las acciones de la pagina quedan a la derecha
          h('div', { class: 'page-actions' }, refreshBtn, h('button', { class: 'btn', onclick: () => openBuildFromServer() }, icon('hammer'), t(`${NS}.buildFromServer`))),
        ),
        h('div', { class: 'mp-bar' }, tabsEl, h('span', { class: 'mp-auto', title: t(`${NS}.autoRefreshHint`) }, icon('clock'), t(`${NS}.autoRefresh`))),
        content,
      ),
    );

    const drawTabs = () =>
      mount(
        tabsEl,
        TABS.map((x) =>
          h(
            'button',
            {
              class: ['tab', x.id === tab && 'active'],
              role: 'tab',
              id: `mp-tab-${x.id}`,
              'aria-selected': String(x.id === tab),
              'aria-controls': 'mp-panel',
              tabindex: x.id === tab ? 0 : -1,
              onclick: () => selectTab(x.id),
            },
            icon(x.icon),
            t(`${NS}.tab_${x.id}`),
            h('span', { class: 'count', dataset: { count: x.id } }, counts.get(x.id) ? String(counts.get(x.id)) : ''),
          ),
        ),
      );
    // Flechas, Inicio y Fin para moverse entre pestañas
    tabsEl.addEventListener('keydown', (e) => {
      if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const i = TABS.findIndex((x) => x.id === tab);
      const j = e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length;
      const next = TABS[j].id;
      if (next !== tab) selectTab(next);
      tabsEl.querySelector(`#mp-tab-${next}`)?.focus();
    });

    const setCount = (id, n) => {
      counts.set(id, n);
      const el = tabsEl.querySelector(`[data-count="${id}"]`);
      if (el) el.textContent = n ? String(n) : '';
    };

    function selectTab(id, arg) {
      tab = id;
      drawTabs();
      try {
        history.replaceState(null, '', `#/multiplayer/${id}${arg ? `/${encodeURIComponent(arg)}` : ''}`);
      } catch {
        /* sin historial */
      }
      savePrefs({ tab: id });
      view?.cleanup?.();
      const panel = h('div', { id: 'mp-panel', role: 'tabpanel', 'aria-labelledby': `mp-tab-${id}`, class: 'mp-panel' });
      mount(content, panel);
      const ctx = { panel, ping, results, setCount, isAlive: () => alive && tab === id, selectTab };
      if (id === 'featured') view = featuredView(ctx);
      else if (id === 'saved') view = savedView(ctx);
      else if (id === 'friends') view = friendsView(ctx);
      else view = searchView(ctx, arg);
    }

    drawTabs();
    selectTab(tab, tab === 'search' ? params[1] : undefined);

    const timer = setInterval(() => {
      if (alive && !document.hidden) view?.refresh?.(false);
    }, REFRESH_MS);
    const offInstances = store.on('instances', () => view?.onInstances?.());

    return () => {
      alive = false;
      clearInterval(timer);
      offInstances();
      view?.cleanup?.();
    };
  },
};

// =====================================================================
// Destacados
// =====================================================================

function featuredView(ctx) {
  const { panel, ping, isAlive } = ctx;
  let list = [];
  let filter = '';
  let lang = prefs().lang || 'all';
  let sort = prefs().sort === 'players' ? 'players' : 'recommended';
  const cards = new Map(); // direccion -> { el, server, slots }

  const filterInput = h('input', { class: 'input', placeholder: t(`${NS}.featuredFilterPlaceholder`), 'aria-label': t(`${NS}.featuredFilterPlaceholder`) });
  const langChips = h('div', { class: 'chips', role: 'group', 'aria-label': t(`${NS}.languageFilter`) });
  const sortSeg = h('div', { class: 'segmented', role: 'group', 'aria-label': t(`${NS}.sortLabel`) });
  const grid = h('div', { class: 'mpf-grid' });
  const hint = h('div');
  filterInput.addEventListener('input', debounce(() => {
    filter = filterInput.value.trim().toLowerCase();
    layout();
  }, 150));

  mount(
    panel,
    h('div', { class: 'mp-toolbar' }, h('div', { class: 'input-icon mp-filter' }, icon('search'), filterInput), langChips, h('span', { class: 'spacer' }), sortSeg),
    grid,
    hint,
  );
  function drawControls() {
    const langs = LANG_ORDER.filter((l) => list.some((s) => s.language === l));
    for (const s of list) if (s.language && !langs.includes(s.language)) langs.push(s.language);
    if (lang !== 'all' && !langs.includes(lang)) lang = 'all';
    mount(
      langChips,
      ['all', ...langs].map((l) =>
        h(
          'button',
          {
            class: ['chip', l === lang && 'active'],
            'aria-pressed': String(l === lang),
            onclick: () => {
              lang = l;
              savePrefs({ lang });
              drawControls();
              layout();
            },
          },
          l === 'all' ? t(`${NS}.filterAll`) : langLabel(l),
        ),
      ),
    );
    mount(
      sortSeg,
      ['recommended', 'players'].map((s) =>
        h(
          'button',
          {
            class: [s === sort && 'active'],
            'aria-pressed': String(s === sort),
            onclick: () => {
              sort = s;
              savePrefs({ sort });
              drawControls();
              layout();
            },
          },
          icon(s === 'players' ? 'users' : 'star'),
          t(`${NS}.sort_${s}`),
        ),
      ),
    );
  }

  function makeCard(s) {
    const slots = statusSlots({ fallbackVersion: s.version, compact: true });
    const iconSlot = h('div', { class: 'mpf-icon' }, serverIcon(null));
    const motdSlot = h('div', { class: 'mpf-motd' }, motdSkeleton());
    const el = h(
      'article',
      { class: ['mpf-card', s.partner && 'mpf-partner'], 'aria-label': s.name },
      h(
        'div',
        { class: 'mpf-top' },
        iconSlot,
        h(
          'div',
          { class: 'mpf-title' },
          h('div', { class: 'mpf-name' }, h('span', { class: 'ellipsis', title: s.name }, s.name), s.partner ? h('span', { class: 'badge accent', title: t(`${NS}.partnerHint`) }, icon('star'), t(`${NS}.partner`)) : null),
          h('button', { class: 'mpf-addr mono', title: t(`${NS}.copyIp`), 'aria-label': t(`${NS}.copyIpOf`, { address: s.address }), onclick: () => copyAddress(s.address) }, h('span', { class: 'ellipsis' }, s.address), icon('copy')),
        ),
        s.language ? h('span', { class: 'mpf-lang', title: langLabel(s.language), role: 'img', 'aria-label': langLabel(s.language) }, s.language === 'multi' ? icon('globe') : s.language.toUpperCase()) : null,
        h('button', { class: 'icon-btn sm', title: t(`${NS}.save`), 'aria-label': t(`${NS}.saveOf`, { name: s.name }), onclick: () => openSaveDialog({ name: s.name, ip: s.address }) }, icon('save')),
      ),
      motdSlot,
      s.description ? h('p', { class: 'mpf-desc', title: s.description }, s.description) : null,
      h('div', { class: 'mpf-meta' }, (s.tags || []).slice(0, 3).map((tg) => h('span', { class: 'mpf-tag' }, tagLabel(tg))), slots.version),
      h(
        'div',
        { class: 'mpf-foot' },
        slots.players,
        slots.bars,
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn sm tonal mp-join', 'aria-label': t(`${NS}.joinOf`, { name: s.name }), onclick: () => joinServer(s.address, { name: s.name }) }, icon('play'), t(`${NS}.join`)),
      ),
    );
    const card = {
      el,
      server: s,
      result: null,
      update(r) {
        card.result = r;
        mount(iconSlot, serverIcon(r?.favicon));
        if (r?.online) mount(motdSlot, motdView(r.motd, { lines: 2 }));
        else mount(motdSlot, h('div', { class: 'sl-motd mp-offline' }, h('div', { class: 'sl-motd-line' }, icon('wifi'), ' ', errorText(r))));
        slots.update(r);
        el.classList.toggle('mp-is-offline', !r?.online);
      },
    };
    return card;
  }

  function visible() {
    let out = list.filter((s) => lang === 'all' || s.language === lang);
    if (filter) {
      out = out.filter((s) => [s.name, s.address, s.description, ...(s.tags || []).flatMap((tg) => [tg, tagLabel(tg)])].some((x) => String(x || '').toLowerCase().includes(filter)));
    }
    if (sort === 'players') {
      const n = (s) => cards.get(s.address)?.result?.players?.online ?? -1;
      out = [...out].sort((a, b) => n(b) - n(a));
    }
    return out;
  }

  function layout() {
    const shown = visible();
    if (!shown.length) {
      mount(
        grid,
        h(
          'div',
          { class: 'mp-span card' },
          emptyState(
            'search',
            t(`${NS}.featuredEmptyFilter`),
            t(`${NS}.featuredEmptyFilterText`),
            h('button', { class: 'btn', onclick: () => ((filterInput.value = ''), (filter = ''), (lang = 'all'), savePrefs({ lang }), drawControls(), layout(), filterInput.focus()) }, icon('x'), t(`${NS}.clearFilters`)),
          ),
        ),
      );
      return;
    }
    mount(grid, shown.map((s) => cards.get(s.address).el));
  }

  async function pingAll(force) {
    await Promise.all(
      list.map(async (s) => {
        const r = await ping(s.address, { force });
        if (!isAlive()) return;
        cards.get(s.address)?.update(r);
        if (sort === 'players') layout();
      }),
    );
  }

  const gridSkeleton = () => h('div', { class: 'mp-span' }, skeleton('grid', { items: 6, min: 300, lines: 3, label: t(`${NS}.loadingFeatured`) }));
  function retryLoad() {
    mount(grid, gridSkeleton());
    load();
  }

  async function load() {
    // Lista del servidor de Venus + ping a cada servidor: solo si el usuario lo activó (netprefs.js).
    if (!netAllowed('featuredServers')) {
      mount(grid, h('div', { class: 'mp-span' }, optInBlock('featuredServers', () => isAlive() && retryLoad())));
      return;
    }
    try {
      list = await api.invoke('serverlist:featured');
    } catch (err) {
      if (!isAlive()) return;
      mount(grid, h('div', { class: 'mp-span card' }, emptyState('alert', t(`${NS}.featuredError`), /No handler registered/i.test(err.message) ? t(`${NS}.err_unavailable`) : err.message, h('button', { class: 'btn', onclick: retryLoad }, icon('refresh'), t(`${NS}.retry`)))));
      return;
    }
    if (!isAlive()) return;
    list = (Array.isArray(list) ? list : []).sort((a, b) => Number(b.partner) - Number(a.partner) || a.sort - b.sort);
    cards.clear();
    for (const s of list) cards.set(s.address, makeCard(s));
    drawControls();
    layout();
    ctx.setCount('featured', list.length);
    const bundled = list.length && list.every((s) => s.source === 'bundled');
    await cloud.ready().catch(() => {});
    if (!isAlive()) return;
    mount(
      hint,
      bundled && !cloud.isConfigured()
        ? h('div', { class: 'mp-hint' }, icon('cloud'), h('span', {}, t(`${NS}.featuredBundledHint`)), h('button', { class: 'btn ghost sm', onclick: () => navigate('settings/cloud') }, t(`${NS}.openCloudSettings`)))
        : h('div', { class: 'mp-hint' }, icon('info'), h('span', {}, t(`${NS}.featuredFootnote`))),
    );
    pingAll(false);
  }
  mount(grid, gridSkeleton());
  load();

  return {
    refresh: (force) => (list.length ? pingAll(force) : null),
    cleanup() {},
  };
}

// =====================================================================
// Mis servidores
// =====================================================================

function savedView(ctx) {
  const { panel, ping, isAlive } = ctx;
  let entries = [];
  let filter = '';
  let instanceFilter = prefs().savedInstance && store.instances.some((i) => i.id === prefs().savedInstance) ? prefs().savedInstance : '';
  const rows = new Map(); // ip -> fila

  const filterInput = h('input', { class: 'input', placeholder: t(`${NS}.savedFilterPlaceholder`), 'aria-label': t(`${NS}.savedFilterPlaceholder`) });
  filterInput.addEventListener('input', debounce(() => {
    filter = filterInput.value.trim().toLowerCase();
    layout();
  }, 150));
  const selectBox = h('div', { class: 'mp-instsel' });
  const listBox = h('div', { class: 'mps-list' });
  const addBtn = h('button', { class: 'btn primary', onclick: () => add() }, icon('plus'), t(`${NS}.addServer`));
  // Filas de esqueleto con la forma de una fila real
  const rowsSkeleton = () =>
    skeletonBox(
      'mps-skel',
      [0, 1, 2].map(() =>
        h(
          'div',
          { class: 'mps-row' },
          bone('mps-icon', { width: '52px', height: '52px', borderRadius: 'var(--radius)' }),
          h('div', { class: 'mps-main skeleton-lines' }, bone('skeleton-line title', { width: '38%' }), bone('skeleton-line', { width: '72%' }), bone('skeleton-line', { width: '46%' })),
          h('div', { class: 'mps-stats' }, bone('skeleton-line', { width: '84px' }), bone('skeleton-line', { width: '64px' })),
          h('div', { class: 'mps-actions' }, bone('', { width: '96px', height: 'var(--control-h-sm)', borderRadius: 'var(--radius-s)' })),
        ),
      ),
      t(`${NS}.loadingSaved`),
    );

  mount(panel, h('div', { class: 'mp-toolbar' }, h('div', { class: 'input-icon mp-filter' }, icon('search'), filterInput), selectBox, h('span', { class: 'spacer' }), addBtn), listBox);

  function drawSelect() {
    const opts = [{ value: '', label: t(`${NS}.allInstances`) }, ...store.instances.map((i) => ({ value: i.id, label: i.name }))];
    const sel = selectEl(opts, instanceFilter, (v) => {
      instanceFilter = v;
      savePrefs({ savedInstance: v });
      load();
    });
    sel.setAttribute('aria-label', t(`${NS}.instanceFilter`));
    mount(selectBox, sel);
  }

  async function add() {
    const pre = instanceFilter ? [instanceFilter] : [];
    if (await openSaveDialog(pre.length ? { instancesDefault: pre } : {})) load();
  }

  function makeRow(e) {
    const slots = statusSlots();
    const iconSlot = h('div', { class: 'mps-icon' }, serverIcon(e.icon));
    const motdSlot = h('div', { class: 'mps-motd' }, motdSkeleton(true));
    const ids = e.instances.map((i) => i.id);
    const instChips = h(
      'div',
      { class: 'mps-insts' },
      e.instances.slice(0, 3).map((i) => h('span', { class: 'mps-inst', title: `${i.name} · ${i.mcVersion}` }, instanceIcon(i, 'xs'), h('span', { class: 'ellipsis' }, i.name))),
      e.instances.length > 3 ? h('span', { class: 'mps-inst mps-more', title: e.instances.map((i) => i.name).join(', ') }, `+${e.instances.length - 3}`) : null,
    );
    const el = h(
      'div',
      { class: 'mps-row', role: 'listitem', 'aria-label': e.name },
      iconSlot,
      h(
        'div',
        { class: 'mps-main' },
        h('div', { class: 'mps-name ellipsis', title: e.name }, e.name),
        motdSlot,
        h('div', { class: 'mps-sub' }, h('button', { class: 'mps-addr mono', title: t(`${NS}.copyIp`), 'aria-label': t(`${NS}.copyIpOf`, { address: e.ip }), onclick: () => copyAddress(e.ip) }, e.ip), instChips),
      ),
      h('div', { class: 'mps-stats' }, slots.players, h('div', { class: 'row' }, slots.bars, slots.version)),
      h(
        'div',
        { class: 'mps-actions' },
        h('button', { class: 'btn sm tonal mp-join', 'aria-label': t(`${NS}.joinOf`, { name: e.name }), onclick: () => joinServer(e.ip, { instanceId: ids.length === 1 ? ids[0] : undefined, name: e.name }) }, icon('play'), t(`${NS}.join`)),
        h('button', { class: 'icon-btn sm', title: t(`${NS}.edit`), 'aria-label': t(`${NS}.editOf`, { name: e.name }), onclick: () => edit(e) }, icon('edit')),
        h('button', { class: 'icon-btn sm', title: t(`${NS}.buildCompatible`), 'aria-label': t(`${NS}.buildCompatible`), onclick: () => openBuildFromServer(e.ip) }, icon('hammer')),
        h('button', { class: 'icon-btn sm danger', title: t(`${NS}.remove`), 'aria-label': t(`${NS}.removeOf`, { name: e.name }), onclick: () => remove(e) }, icon('trash')),
      ),
    );
    return {
      el,
      entry: e,
      update(r) {
        if (r?.favicon) mount(iconSlot, serverIcon(r.favicon));
        if (r?.online) mount(motdSlot, motdView(r.motd, { lines: 1, cls: 'compact' }));
        else mount(motdSlot, h('div', { class: 'sl-motd sl-motd-compact mp-offline' }, h('div', { class: 'sl-motd-line' }, errorText(r))));
        slots.update(r);
        el.classList.toggle('mp-is-offline', !r?.online);
      },
    };
  }

  async function edit(e) {
    if (await openSaveDialog({ name: e.name, ip: e.ip, instances: e.instances.map((i) => i.id) })) load();
  }

  async function remove(e) {
    const msg = e.instances.length === 1 ? t(`${NS}.removeConfirm_one`, { name: e.name, instance: e.instances[0].name }) : t(`${NS}.removeConfirm_other`, { name: e.name, count: e.instances.length });
    if (!(await confirmDialog(t(`${NS}.removeTitle`), msg, { okText: t(`${NS}.remove`), cancelText: t(`${NS}.cancel`), danger: true }))) return;
    try {
      await api.invoke('serverlist:removeSaved', e.instances.map((i) => i.id), e.ip);
      ok(t(`${NS}.removed`), e.name);
      load();
    } catch (err) {
      fail(t(`${NS}.removeFailed`), err);
    }
  }

  function layout() {
    // Sin instancias o sin servidores, la accion principal es la del estado vacio
    addBtn.hidden = !store.instances.length || !entries.length;
    if (!store.instances.length) {
      mount(listBox, h('div', { class: 'card' }, emptyState('layers', t(`${NS}.noInstancesTitle`), t(`${NS}.noInstancesText`), h('button', { class: 'btn primary', onclick: () => navigate('versions/new') }, icon('plus'), t(`${NS}.createInstance`)))));
      return;
    }
    if (!entries.length) {
      mount(
        listBox,
        h(
          'div',
          { class: 'card' },
          emptyState(
            'server',
            t(`${NS}.savedEmptyTitle`),
            t(`${NS}.savedEmptyText`),
            h('div', { class: 'row wrap', style: { justifyContent: 'center' } }, h('button', { class: 'btn primary', onclick: () => add() }, icon('plus'), t(`${NS}.addServer`)), h('button', { class: 'btn', onclick: () => ctx.selectTab('featured') }, icon('star'), t(`${NS}.seeFeatured`))),
          ),
        ),
      );
      return;
    }
    const shown = filter ? entries.filter((e) => [e.name, e.ip, ...e.instances.map((i) => i.name)].some((x) => String(x).toLowerCase().includes(filter))) : entries;
    if (!shown.length) {
      mount(
        listBox,
        h(
          'div',
          { class: 'card' },
          emptyState(
            'search',
            t(`${NS}.savedEmptyFilter`),
            null,
            h('button', { class: 'btn', onclick: () => ((filterInput.value = ''), (filter = ''), layout(), filterInput.focus()) }, icon('x'), t(`${NS}.clearSearch`)),
          ),
        ),
      );
      return;
    }
    mount(listBox, h('div', { class: 'mps-rows', role: 'list' }, shown.map((e) => rows.get(e.ip).el)));
  }

  async function pingAll(force) {
    await Promise.all(
      entries.map(async (e) => {
        const r = await ping(e.ip, { force });
        if (isAlive()) rows.get(e.ip)?.update(r);
      }),
    );
  }

  async function load() {
    drawSelect();
    if (!entries.length) mount(listBox, rowsSkeleton());
    try {
      entries = await api.invoke('serverlist:saved', instanceFilter || null);
    } catch (err) {
      if (!isAlive()) return;
      addBtn.hidden = true;
      mount(listBox, h('div', { class: 'card' }, emptyState('alert', t(`${NS}.savedError`), /No handler registered/i.test(err.message) ? t(`${NS}.err_unavailable`) : err.message, h('button', { class: 'btn', onclick: load }, icon('refresh'), t(`${NS}.retry`)))));
      return;
    }
    if (!isAlive()) return;
    rows.clear();
    for (const e of entries) rows.set(e.ip, makeRow(e));
    if (!instanceFilter) ctx.setCount('saved', entries.length);
    layout();
    pingAll(false);
  }
  load();

  return {
    refresh: (force) => (force ? load() : pingAll(false)),
    onInstances: () => drawSelect(),
    cleanup() {},
  };
}

// =====================================================================
// Amigos jugando
// =====================================================================

// social.friends: [{ id, name, profile: { display_name, username, mc_name, mc_uuid }, presence, activity }]
// social.presenceOf(id): { presence: 'online'|'away'|'busy'|'offline', activity: { type, address, mcVersion, loader, since } }
const MC_UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const MC_NAME = /^[A-Za-z0-9_]{3,16}$/;

function friendInfo(f) {
  const p = f?.profile && typeof f.profile === 'object' ? f.profile : f || {};
  const id = f?.id || f?.userId || f?.user_id || p.id || null;
  const name = f?.name || p.display_name || p.username || p.mc_name || '?';
  const skin = MC_UUID.test(p.mc_uuid || '') ? p.mc_uuid.replace(/-/g, '') : MC_NAME.test(p.mc_name || '') ? p.mc_name : MC_NAME.test(p.username || '') ? p.username : 'MHF_Steve';
  return { id, name, skin };
}

function activityOf(presence) {
  const a = presence && typeof presence === 'object' ? presence.activity : null;
  if (!a || typeof a !== 'object') return null;
  if (a.type === 'server') return { type: 'server', address: typeof a.address === 'string' && a.address ? a.address : null, since: a.since || null, mcVersion: a.mcVersion || '', loader: a.loader || '' };
  if (a.type === 'singleplayer' || a.type === 'menu') return { type: a.type, since: a.since || null };
  return null;
}

function isOnline(presence) {
  const v = typeof presence === 'string' ? presence : presence?.presence ?? presence?.status;
  return v === 'online' || v === 'away' || v === 'busy';
}

function friendsView(ctx) {
  const { panel, ping, isAlive } = ctx;
  const box = h('div', { class: 'mpa-wrap' });
  mount(panel, box);
  const cards = new Map(); // direccion -> funciones de actualizacion
  let playing = [];
  const offs = [];

  const friendsSkeleton = () => skeleton('grid', { items: 3, min: 300, lines: 2, label: t(`${NS}.friendsLoading`) });

  // Sin nube: icono de nube y engranaje. Sin sesion: el mismo icono de entrar que en Voice Chat, Mensajes y Compartir.
  function needsCloud(title, text, signIn = false) {
    mount(box, h('div', { class: 'card' }, emptyState(signIn ? 'logIn' : 'cloud', title, text, h('button', { class: 'btn primary', onclick: () => navigate('settings/cloud') }, icon(signIn ? 'logIn' : 'settings'), t(`${NS}.openCloudSettings`)))));
  }

  function friendCard(f, act) {
    const slots = statusSlots({ compact: true });
    const iconSlot = h('div', { class: 'mpa-srv-icon' }, serverIcon(null, 'sm'));
    const motdSlot = h('div', { class: 'mpa-motd' });
    // Version con la que juega el amigo (sirve para elegir la misma)
    const gameVersion = act.mcVersion ? (act.loader && act.loader !== 'vanilla' && LOADERS[act.loader] ? `${LOADERS[act.loader].name} ${act.mcVersion}` : act.mcVersion) : '';
    const el = h(
      'article',
      { class: 'mpa-card' },
      h(
        'div',
        { class: 'mpa-who' },
        avatarImg(f.skin, 64, 'mpa-avatar'),
        h(
          'div',
          { class: 'mpa-whotext' },
          h('div', { class: 'mpa-name ellipsis', title: f.name }, f.name),
          h('div', { class: 'mpa-sub' }, h('span', { class: 'status-dot online' }), act.since ? t(`${NS}.playingFor`, { time: fmtDuration(Math.max(60000, Date.now() - act.since)) }) : t(`${NS}.playingNow`)),
        ),
        gameVersion ? h('span', { class: 'badge mpa-game', title: t(`${NS}.friendVersionHint`) }, icon('box'), gameVersion) : null,
      ),
      h('div', { class: 'mpa-server' }, iconSlot, h('div', { class: 'mpa-srvtext' }, h('div', { class: 'mpa-label' }, t(`${NS}.playingOn`)), h('button', { class: 'mpa-addr mono', title: t(`${NS}.copyIp`), 'aria-label': t(`${NS}.copyIpOf`, { address: act.address }), onclick: () => copyAddress(act.address) }, act.address), motdSlot)),
      h('div', { class: 'mpa-foot' }, slots.players, slots.bars, h('span', { class: 'spacer' }), h('button', { class: 'btn sm tonal mp-join', 'aria-label': t(`${NS}.joinFriendOf`, { name: f.name }), onclick: () => joinServer(act.address) }, icon('play'), t(`${NS}.joinFriend`))),
    );
    const list = cards.get(act.address) || [];
    list.push((r) => {
      if (r?.favicon) mount(iconSlot, serverIcon(r.favicon, 'sm'));
      mount(motdSlot, r?.online ? motdView(r.motd, { lines: 1, cls: 'compact' }) : h('div', { class: 'small muted' }, errorText(r)));
      slots.update(r);
    });
    cards.set(act.address, list);
    return el;
  }

  function unavailable() {
    mount(box, h('div', { class: 'card' }, emptyState('users', t(`${NS}.friendsUnavailableTitle`), t(`${NS}.friendsUnavailableText`))));
    ctx.setCount('friends', 0);
  }

  async function draw() {
    await cloud.ready().catch(() => {});
    if (!isAlive()) return;
    const hasApi = typeof social.presenceOf === 'function' && Array.isArray(social.friends);
    const state = typeof social.state === 'string' ? social.state : null;
    // social.state: idle | disabled | signedOut | loading | ready | missingSchema | error
    if (state !== 'ready') {
      if (!cloud.isConfigured() || state === 'disabled') return needsCloud(t(`${NS}.friendsNoCloudTitle`), t(`${NS}.friendsNoCloudText`));
      if (!cloud.isSignedIn() || state === 'signedOut') return needsCloud(t(`${NS}.friendsSignInTitle`), t(`${NS}.friendsSignInText`), true);
      if (state === 'loading' || state === 'idle') return mount(box, friendsSkeleton());
      if (state === 'error') {
        mount(box, h('div', { class: 'card' }, emptyState('alert', t(`${NS}.friendsErrorTitle`), t(`${NS}.friendsErrorText`), typeof social.retry === 'function' ? h('button', { class: 'btn', onclick: () => Promise.resolve(social.retry()).catch(() => {}) }, icon('refresh'), t(`${NS}.retry`)) : null)));
        return undefined;
      }
      if (state) return unavailable(); // missingSchema u otro estado desconocido
    }
    if (!hasApi) return unavailable();
    const friends = social.friends.map((f) => ({ f: friendInfo(f), presence: safePresence(f) }));
    const withAct = friends.map((x) => ({ ...x, act: activityOf(x.presence) }));
    playing = withAct.filter((x) => x.f.id && isOnline(x.presence) && x.act?.type === 'server' && x.act.address);
    const others = withAct.filter((x) => x.f.id && isOnline(x.presence) && !playing.includes(x));
    ctx.setCount('friends', playing.length);
    cards.clear();
    if (!friends.length) {
      mount(box, h('div', { class: 'card' }, emptyState('userPlus', t(`${NS}.friendsNoneTitle`), t(`${NS}.friendsNoneText`), h('button', { class: 'btn', onclick: () => navigate('messages') }, icon('message'), t(`${NS}.goMessages`)))));
      return undefined;
    }
    const blocks = [];
    if (playing.length) blocks.push(h('div', { class: 'mpa-grid' }, playing.map((x) => friendCard(x.f, x.act))));
    else blocks.push(h('div', { class: 'card' }, emptyState('users', t(`${NS}.friendsEmptyTitle`), t(`${NS}.friendsEmptyText`))));
    if (others.length) {
      blocks.push(
        sectionTitle(t(`${NS}.friendsOnlineOther`, { count: others.length })),
        h(
          'div',
          { class: 'mpa-others', role: 'list' },
          others.map((x) => {
            const act = x.act;
            const label = act?.type === 'server' ? t(`${NS}.friendInPrivateServer`) : act?.type === 'singleplayer' ? t(`${NS}.friendInWorld`) : act?.type === 'menu' ? t(`${NS}.friendInMenu`) : t(`${NS}.friendOnline`);
            return h('div', { class: 'player-chip mpa-other', role: 'listitem', title: `${x.f.name} · ${label}` }, avatarImg(x.f.skin, 32, ''), h('div', { class: 'ellipsis' }, h('div', { class: 'mpa-other-name ellipsis' }, x.f.name), h('div', { class: 'mpa-other-sub ellipsis' }, label)));
          }),
        ),
      );
    }
    mount(box, blocks);
    pingAll(false);
    return undefined;
  }

  function safePresence(f) {
    try {
      return social.presenceOf(friendInfo(f).id) || f?.presence || null;
    } catch {
      return f?.presence || null;
    }
  }

  async function pingAll(force) {
    await Promise.all(
      [...cards.keys()].map(async (address) => {
        const r = await ping(address, { force });
        if (isAlive()) for (const fn of cards.get(address) || []) fn(r);
      }),
    );
  }

  const redraw = debounce(() => isAlive() && draw(), 300);
  for (const evt of ['presence', 'friends', 'state', 'ready']) {
    try {
      const off = social.on?.(evt, redraw);
      if (typeof off === 'function') offs.push(off);
    } catch {
      /* social todavia sin eventos */
    }
  }
  offs.push(cloud.on('auth', redraw), cloud.on('config', redraw));
  mount(box, friendsSkeleton());
  draw();

  return {
    refresh: (force) => (force ? draw() : pingAll(false)),
    cleanup() {
      for (const off of offs) {
        try {
          off();
        } catch {
          /* nada */
        }
      }
    },
  };
}

// =====================================================================
// Buscar por IP
// =====================================================================

function searchView(ctx, initial) {
  const { panel, ping, isAlive } = ctx;
  let current = null;
  let busy = false;
  let live = null; // partes de la ficha que se actualizan solas: { addr, online, update(r) }
  const input = h('input', { class: 'input mono mpq-input', placeholder: t(`${NS}.searchPlaceholder`), maxlength: 300, spellcheck: 'false', 'aria-label': t(`${NS}.searchPlaceholder`), 'aria-describedby': 'mpq-error' });
  const goBtn = h('button', { class: 'btn primary lg', onclick: () => go() }, icon('search'), t(`${NS}.searchButton`));
  const errBox = h('div', { class: 'field-error', id: 'mpq-error', role: 'alert' });
  const recentBox = h('div', { class: 'mpq-recent' });
  const resultBox = h('div', { class: 'mpq-result', 'aria-live': 'polite' });
  input.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  // El error se va apenas se corrige la direccion
  input.addEventListener('input', () => input.getAttribute('aria-invalid') === 'true' && showError(null));

  function showError(text) {
    input.setAttribute('aria-invalid', text ? 'true' : 'false');
    mount(errBox, text ? [icon('alert'), h('span', {}, text)] : null);
  }

  // Con una ficha en pantalla la accion principal pasa a ser Unirme
  const setPrimary = (searching) => goBtn.classList.toggle('primary', searching);

  mount(
    panel,
    h('div', { class: 'mpq-search card' }, h('div', { class: 'mpq-row' }, h('div', { class: 'input-icon' }, icon('server'), input), goBtn), errBox, recentBox),
    resultBox,
  );

  async function drawRecent() {
    let hist = [];
    try {
      hist = await api.invoke('serverlist:history');
    } catch {
      hist = [];
    }
    if (!isAlive()) return;
    if (!hist.length) {
      mount(recentBox);
      return;
    }
    mount(
      recentBox,
      h('span', { class: 'mpq-recent-label' }, icon('history'), t(`${NS}.recent`)),
      h('div', { class: 'chips' }, hist.slice(0, 8).map((it) => h('button', { class: 'chip', title: it.kind === 'join' ? t(`${NS}.recentJoined`) : t(`${NS}.recentLooked`), onclick: () => ((input.value = it.address), go()) }, it.kind === 'join' ? icon('play') : icon('search'), it.address))),
      h(
        'button',
        {
          class: 'btn ghost sm',
          onclick: async () => {
            await api.invoke('serverlist:clearHistory').catch(() => {});
            drawRecent();
          },
        },
        t(`${NS}.clearRecent`),
      ),
    );
  }

  function emptyView() {
    const examples = ['mc.hypixel.net', 'mc.universocraft.com', 'play.cubecraft.net'];
    live = null;
    setPrimary(true);
    mount(
      resultBox,
      h(
        'div',
        { class: 'card mpq-empty' },
        emptyState(
          'search',
          t(`${NS}.searchEmptyTitle`),
          t(`${NS}.searchEmptyText`),
          h('div', { class: 'chips', style: { justifyContent: 'center' } }, examples.map((ex) => h('button', { class: 'chip', onclick: () => ((input.value = ex), go()) }, icon('zap'), ex))),
        ),
      ),
    );
  }

  // Ficha de esqueleto con la forma del resultado (icono, direccion, MOTD y datos)
  const resultSkeleton = (addr) =>
    h(
      'div',
      { class: 'card' },
      skeletonBox(
        'mpq-skel',
        [
          h('div', { class: 'mpq-skel-head' }, bone('mpq-skel-icon'), h('div', { class: 'skeleton-lines' }, bone('skeleton-line title', { width: '42%' }), bone('skeleton-line', { width: '64%' }))),
          bone('mpq-skel-motd'),
          h('div', { class: 'mpq-stats' }, [0, 1, 2, 3].map(() => bone('mpq-skel-stat'))),
        ],
        t(`${NS}.searching`, { server: addr }),
      ),
    );

  async function go(force = true) {
    const addr = cleanAddress(input.value);
    if (!addr) {
      showError(t(`${NS}.invalidAddress`));
      input.focus();
      return;
    }
    showError(null);
    if (busy) return;
    busy = true;
    goBtn.disabled = true;
    goBtn.setAttribute('aria-busy', 'true');
    current = addr;
    try {
      history.replaceState(null, '', `#/multiplayer/search/${encodeURIComponent(addr)}`);
    } catch {
      /* nada */
    }
    mount(resultBox, resultSkeleton(addr));
    const r = await ping(addr, { force, remember: true });
    busy = false;
    goBtn.disabled = false;
    goBtn.removeAttribute('aria-busy');
    if (!isAlive() || current !== addr) return;
    if (r.error === 'invalid') {
      showError(r.errorText || t(`${NS}.invalidAddress`));
      emptyView();
      return;
    }
    drawResult(addr, r);
    drawRecent();
  }

  function stat(iconName, label, value, extra) {
    return h('div', { class: 'mpq-stat' }, h('div', { class: 'mpq-stat-label' }, icon(iconName), label), h('div', { class: 'mpq-stat-value' }, value), extra ? h('div', { class: 'mpq-stat-extra' }, extra) : null);
  }

  function drawResult(addr, r) {
    const actions = h(
      'div',
      { class: 'mpq-actions' },
      h('button', { class: 'btn primary', onclick: () => joinServer(addr) }, icon('play'), t(`${NS}.join`)),
      h('button', { class: 'btn', onclick: () => openBuildFromServer(addr) }, icon('hammer'), t(`${NS}.buildCompatible`)),
      h('button', { class: 'btn', onclick: () => openSaveDialog({ name: addr, ip: addr }) }, icon('save'), t(`${NS}.save`)),
      h('button', { class: 'icon-btn', title: t(`${NS}.copyIp`), 'aria-label': t(`${NS}.copyIp`), onclick: () => copyAddress(addr) }, icon('copy')),
    );
    live = null;
    // Con la ficha en linea, Unirme es la accion principal; sin respuesta lo sigue siendo Consultar
    setPrimary(!r.online);
    if (!r.online) {
      mount(
        resultBox,
        h(
          'div',
          { class: 'card mpq-card mp-is-offline' },
          h('div', { class: 'mpq-head' }, serverIcon(null, 'xl'), h('div', { class: 'mpq-headtext' }, h('div', { class: 'mpq-addr' }, addr), h('div', { class: 'row wrap' }, h('span', { class: 'pill bad' }, icon('wifiOff'), t(`${NS}.offline`)), h('span', { class: 'mpq-fact' }, icon('clock'), checkedLabel(r.checkedAt))))),
          h('div', { class: 'notice bad' }, icon('alert'), h('div', {}, h('strong', {}, t(`${NS}.offlineTitle`)), h('div', {}, errorText(r)))),
          h('div', { class: 'mpq-actions' }, h('button', { class: 'btn', onclick: () => go(true) }, icon('refresh'), t(`${NS}.retry`)), h('button', { class: 'btn ghost', onclick: () => openSaveDialog({ name: addr, ip: addr }) }, icon('save'), t(`${NS}.save`))),
        ),
      );
      return;
    }
    const facts = [];
    if (r.target?.srv) facts.push(h('span', { class: 'mpq-fact', title: t(`${NS}.srvHint`) }, icon('link'), t(`${NS}.srvVia`, { target: `${r.target.host}:${r.target.port}` })));
    if (r.ip) facts.push(h('span', { class: 'mpq-fact mono' }, icon('globe'), r.ip));
    if (r.protocol !== null && r.protocol !== undefined) facts.push(h('span', { class: 'mpq-fact' }, icon('hash'), t(`${NS}.protocol`, { protocol: r.protocol })));
    if (r.legacy) facts.push(h('span', { class: 'mpq-fact' }, icon('history'), t(`${NS}.legacyServer`)));
    if (r.secureChat === true) facts.push(h('span', { class: 'mpq-fact' }, icon('shieldCheck'), t(`${NS}.secureChat`)));
    facts.push(h('span', { class: 'mpq-fact' }, icon('clock'), checkedLabel(r.checkedAt)));

    const typeValue = r.loader ? [loaderBadgeFor(r)] : [loaderText(r)];
    const modsBlock = r.mods?.length ? modsSection(r) : r.modded ? h('div', { class: 'notice info' }, icon('info'), t(`${NS}.modsHidden`)) : null;
    const sampleBox = h('div', { class: 'mpq-section' });
    const motdBox = h('div', {}, motdView(r.motd, { lines: 2, cls: 'large' }));
    const playersVal = stat('users', t(`${NS}.statPlayers`), playersText(r));
    const latencyVal = stat('activity', t(`${NS}.statLatency`), latencyBars(r));
    const checkedFact = h('span', { class: 'mpq-fact' }, icon('clock'), checkedLabel(r.checkedAt));
    facts.pop();
    facts.push(checkedFact);
    const drawSample = (res) => mount(sampleBox, res.players?.sample?.length ? [h('div', { class: 'mpq-subtitle', role: 'heading', 'aria-level': '3' }, t(`${NS}.sampleTitle`)), sampleView(res.players.sample)] : null);
    drawSample(r);

    mount(
      resultBox,
      h(
        'div',
        { class: 'card mpq-card' },
        h(
          'div',
          { class: 'mpq-head' },
          serverIcon(r.favicon, 'xl'),
          h('div', { class: 'mpq-headtext' }, h('div', { class: 'mpq-addr' }, addr), h('div', { class: 'row wrap' }, h('span', { class: 'pill good' }, h('span', { class: 'status-dot online' }), t(`${NS}.online`)), facts)),
        ),
        motdBox,
        h(
          'div',
          { class: 'mpq-stats' },
          playersVal,
          latencyVal,
          stat('box', t(`${NS}.statVersion`), versionText(r), r.version && r.version !== versionText(r) ? h('span', { class: 'ellipsis', title: r.version }, r.version) : null),
          stat('puzzle', t(`${NS}.statType`), typeValue, r.mods?.length ? t(`${NS}.modsCount`, { count: r.mods.length }) : null),
        ),
        sampleBox,
        modsBlock,
        actions,
      ),
    );
    // La actualizacion automatica solo toca lo que cambia (no borra el filtro de mods ni el scroll)
    live = {
      addr,
      online: true,
      update(res) {
        mount(motdBox, motdView(res.motd, { lines: 2, cls: 'large' }));
        mount(playersVal.querySelector('.mpq-stat-value'), playersText(res));
        mount(latencyVal.querySelector('.mpq-stat-value'), latencyBars(res));
        mount(checkedFact, icon('clock'), checkedLabel(res.checkedAt));
        drawSample(res);
      },
    };
  }

  function modsSection(r) {
    const list = h('div', { class: 'mpq-mods' });
    const filterIn = h('input', { class: 'input', placeholder: t(`${NS}.modsFilter`), 'aria-label': t(`${NS}.modsFilter`) });
    const draw = () => {
      const q = filterIn.value.trim().toLowerCase();
      const shown = q ? r.mods.filter((m) => m.id.toLowerCase().includes(q)) : r.mods;
      mount(list, shown.length ? shown.map((m) => h('span', { class: 'mpq-mod', title: m.version ? `${m.id} ${m.version}` : m.id }, h('span', { class: 'mpq-mod-id' }, m.id), m.version ? h('span', { class: 'mpq-mod-v' }, m.version) : null)) : h('div', { class: 'small muted' }, t(`${NS}.modsNoMatch`)));
    };
    filterIn.addEventListener('input', debounce(draw, 120));
    draw();
    return h(
      'div',
      { class: 'mpq-section' },
      h('div', { class: 'mpq-section-head' }, h('div', { class: 'mpq-subtitle', role: 'heading', 'aria-level': '3' }, t(`${NS}.modsTitle`), h('span', { class: 'count' }, fmtInt(r.mods.length))), h('div', { class: 'input-icon mpq-modfilter' }, icon('search'), filterIn)),
      r.modsTruncated ? h('div', { class: 'notice' }, icon('alert'), t(`${NS}.modsTruncated`)) : null,
      list,
      r.serverOnlyMods ? h('div', { class: 'small muted' }, t(`${NS}.serverOnlyMods`, { count: r.serverOnlyMods })) : null,
    );
  }

  drawRecent();
  const pre = initial ? cleanAddress(initial) : null;
  if (pre) {
    input.value = pre;
    go(false);
  } else {
    emptyView();
    setTimeout(() => isAlive() && input.focus(), 60);
  }

  return {
    async refresh(force) {
      if (!current || busy) return;
      const addr = current;
      const r = await ping(addr, { force });
      if (!isAlive() || current !== addr || busy) return;
      if (live && live.addr === addr && r.online) live.update(r);
      else drawResult(addr, r);
    },
    cleanup() {},
  };
}
