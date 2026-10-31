// Lista de mundos de todas las instancias (tarjetas con filtros) y pestana "Capturas y clips".
import { h, icon, mount, emptyState, fmtAgo, fmtBytes, fmtDate, debounce, selectEl, setBusy } from '../../ui.js';
import { store, api } from '../../store.js';
import { t } from '../../i18n.js';
import { navigate } from '../../app.js';
import {
  prefs,
  savePrefs,
  sortWorlds,
  modeBadge,
  modeKey,
  shortDur,
  worldIcon,
  instanceDot,
  openWorld,
  playWorld,
  openMap,
  backupWorld,
  popMenu,
  closeMenu,
  isRunning,
  worldRoute,
  errorBox,
  bone,
  skelGroup,
  DATE_TIME,
} from './common.js';
import { openCopyDialog, renameWorld, deleteWorld, openAllBackups } from './dialogs.js';
import { mediaGrid, mediaSkeleton, openLightbox, closeLightbox } from './media.js';

const MODES = ['all', 'survival', 'creative', 'hardcore', 'adventure'];

// Tarjetas vacias con la misma forma que las de los mundos
export function listSkeleton(n = 6) {
  return skelGroup(
    t('worlds.loadingWorlds'),
    h(
      'div',
      { class: 'wo-grid' },
      Array.from({ length: n }, () =>
        h(
          'div',
          { class: 'wo-card wo-card-skel' },
          bone('wo-skel-cover'),
          h('div', { class: 'wo-card-body' }, bone('wo-skel-icon'), bone('skeleton-line title wo-skel-w70'), bone('skeleton-line wo-skel-w55'), bone('wo-skel-chip'), bone('skeleton-line wo-skel-w40')),
          h('div', { class: 'wo-card-actions' }, bone('wo-skel-btn'), bone('wo-skel-sq'), bone('wo-skel-sq')),
        ),
      ),
    ),
  );
}

export function renderList(root, { tab = 'worlds', onTab } = {}) {
  let alive = true;
  let worlds = null;
  let media = null;
  let sharedMap = {};
  let error = null;
  let mediaError = null;
  let entered = false; // la entrada escalonada de las tarjetas solo se ve en la primera carga
  const offs = [];
  const p = prefs();
  const state = { query: '', instance: p.instance, sort: p.sort, mode: p.mode, mediaKind: p.mediaKind, mediaInstance: p.mediaInstance };

  // ---------- Encabezado y pestanas ----------
  const tabBar = h('div', { class: 'tabs wo-tabs', role: 'tablist', 'aria-label': t('worlds.tabsLabel') });
  const panel = h('div', { class: 'wo-panel', role: 'tabpanel', id: 'wo-list-panel' });
  const sub = h('p', { class: 'page-sub' }, t('worlds.subtitle'));
  // Actualizar como boton de icono, igual que en Multijugador y Extensiones (setBusy hace girar el icono)
  const refreshBtn = h('button', { class: 'icon-btn', type: 'button', title: t('worlds.refresh'), 'aria-label': t('worlds.refresh'), onclick: () => refreshAll() }, icon('refresh'));
  const backupsBtn = h('button', { class: 'btn', type: 'button', onclick: () => openAllBackups({ onRestored: () => reload(true) }) }, icon('archive'), t('worlds.backupsFolder'));
  mount(
    root,
    h(
      'div',
      { class: 'wo-root' },
      h('div', { class: 'page-head' }, h('div', { class: 'ph-text' }, h('h1', { class: 'page-title' }, t('worlds.title')), sub), h('div', { class: 'page-actions' }, refreshBtn, backupsBtn)),
      tabBar,
      panel,
    ),
  );

  function drawTabs() {
    const count = (n) => (n === null || n === undefined ? null : h('span', { class: 'count' }, String(n)));
    const mediaCount = media ? media.counts.screenshots + media.counts.clips : null;
    const btn = (id, ic, label, n) =>
      h(
        'button',
        {
          type: 'button',
          id: `wo-tab-${id}`,
          class: ['tab', tab === id && 'active'],
          role: 'tab',
          'aria-selected': String(tab === id),
          'aria-controls': 'wo-list-panel',
          tabindex: tab === id ? '0' : '-1',
          onclick: () => select(id),
          onkeydown: (e) => {
            if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
              e.preventDefault();
              select(tab === 'worlds' ? 'media' : 'worlds');
              tabBar.querySelector('.tab.active')?.focus();
            }
          },
        },
        icon(ic),
        label,
        count(n),
      );
    mount(tabBar, btn('worlds', 'globe', t('worlds.tabWorlds'), worlds ? worlds.length : null), btn('media', 'camera', t('worlds.tabMedia'), mediaCount));
    panel.setAttribute('aria-labelledby', `wo-tab-${tab}`);
  }

  function select(id) {
    if (id === tab) return;
    tab = id;
    onTab?.(id);
    drawTabs();
    drawPanel();
    if (id === 'media' && !media && !mediaError && !mediaLoading) loadMedia();
  }

  function drawPanel() {
    closeMenu();
    if (tab === 'media') drawMedia();
    else drawWorlds();
  }

  // ---------- Mundos ----------
  const search = h('input', { class: 'input', type: 'search', placeholder: t('worlds.searchPlaceholder'), 'aria-label': t('worlds.searchPlaceholder') });
  search.addEventListener(
    'input',
    debounce(() => {
      state.query = search.value.trim().toLowerCase();
      drawGrid();
    }, 120),
  );
  const gridHost = h('div', { class: 'wo-grid-host' });
  const summary = h('div', { class: 'wo-summary', 'aria-live': 'polite' });
  const toolbar = h('div', { class: 'wo-toolbar' });
  const chipsHost = h('div', { class: 'chips wo-chips', role: 'group', 'aria-label': t('worlds.filterMode') });
  const filterBar = h('div', { class: 'wo-filterbar' }, chipsHost, summary);

  function drawChips() {
    mount(
      chipsHost,
      MODES.map((m) =>
        h(
          'button',
          {
            type: 'button',
            class: ['chip', state.mode === m && 'active'],
            'aria-pressed': String(state.mode === m),
            onclick: () => {
              state.mode = m;
              savePrefs({ mode: m });
              drawChips();
              drawGrid();
            },
          },
          m === 'hardcore' ? icon('skull') : null,
          t(`worlds.chip_${m}`),
        ),
      ),
    );
  }

  function drawToolbar() {
    const instOptions = [{ value: '', label: t('worlds.allInstances') }, ...store.instances.map((i) => ({ value: i.id, label: i.name }))];
    if (state.instance && !store.instances.some((i) => i.id === state.instance)) state.instance = '';
    const instSel = selectEl(instOptions, state.instance, (v) => {
      state.instance = v;
      savePrefs({ instance: v });
      drawGrid();
    });
    instSel.setAttribute('aria-label', t('worlds.filterInstance'));
    const sortSel = selectEl(
      ['recent', 'name', 'playtime', 'size', 'instance'].map((v) => ({ value: v, label: t(`worlds.sort_${v}`) })),
      state.sort,
      (v) => {
        state.sort = v;
        savePrefs({ sort: v });
        drawGrid();
      },
    );
    sortSel.setAttribute('aria-label', t('worlds.sortLabel'));
    mount(toolbar, h('div', { class: 'input-icon wo-search' }, icon('search'), search), instSel, sortSel);
    drawChips();
  }

  function filtered() {
    let list = worlds || [];
    if (state.instance) list = list.filter((w) => w.instanceId === state.instance);
    if (state.mode !== 'all') list = list.filter((w) => (state.mode === 'hardcore' ? w.hardcore : !w.hardcore && w.gameMode === state.mode));
    if (state.query) list = list.filter((w) => `${w.name} ${w.folder} ${w.instanceName} ${w.version || ''}`.toLowerCase().includes(state.query));
    return sortWorlds(list, state.sort);
  }

  function card(w, index) {
    const running = isRunning(w.instanceId);
    const inst = store.instances.find((i) => i.id === w.instanceId);
    const more = h('button', { class: 'icon-btn sm', type: 'button', title: t('worlds.moreActions', { name: w.name }), 'aria-label': t('worlds.moreActions', { name: w.name }), 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, icon('more'));
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      popMenu(more, [
        { icon: 'history', label: t('worlds.openHistory'), run: () => openWorld(w) },
        { icon: 'map', label: t('worlds.viewMap'), run: () => openMap(w) },
        { icon: 'archive', label: t('worlds.backupNow'), run: () => backupWorld(w) },
        { icon: 'copy', label: t('worlds.copyTo'), run: () => openCopyDialog(w, { onDone: () => reload(true) }) },
        { icon: 'edit', label: t('worlds.rename'), disabled: w.playing, run: async () => (await renameWorld(w)) && reload(true) },
        { icon: 'folderOpen', label: t('worlds.openFolder'), run: () => api.invoke('worlds:openFolder', w.instanceId, w.folder).catch((err) => console.warn('[worlds]', err)) },
        '-',
        { icon: 'trash', label: t('worlds.moveToTrash'), danger: true, disabled: w.playing, run: async () => (await deleteWorld(w)) && reload(true) },
      ]);
    });
    const play = h(
      'button',
      {
        class: 'btn sm tonal wo-card-play',
        type: 'button',
        disabled: running,
        title: running ? t('worlds.alreadyRunningShort') : t('worlds.playWorld', { name: w.name }),
        'aria-label': t('worlds.playWorld', { name: w.name }),
        onclick: (e) => {
          e.stopPropagation();
          playWorld(w);
        },
      },
      icon('play'),
      w.playing ? t('worlds.inGame') : t('worlds.play'),
    );
    const map = h('button', { class: 'icon-btn sm', type: 'button', title: t('worlds.viewMap'), 'aria-label': t('worlds.viewMapOf', { name: w.name }), onclick: (e) => (e.stopPropagation(), openMap(w)) }, icon('map'));
    const meta = [
      h('span', { class: 'wo-meta', title: t('worlds.lastPlayedAt', { date: fmtDate(w.lastPlayed, DATE_TIME) }) }, icon('clock'), h('span', { dataset: { ago: String(w.lastPlayed) } }, fmtAgo(w.lastPlayed))),
      h('span', { class: 'wo-meta', title: t('worlds.playtimeHint') }, icon('woHourglass'), shortDur(w.playtime)),
      h('span', { class: 'wo-meta wo-size', title: t('worlds.sizeHint'), dataset: { size: `${w.instanceId}/${w.folder}` } }, icon('drive'), w.size === null || w.size === undefined ? h('span', { class: 'wo-dim' }, '…') : fmtBytes(w.size)),
    ];
    const el = h(
      'article',
      {
        class: ['wo-card', w.playing && 'playing', modeKey(w) && `mode-${modeKey(w)}`],
        style: { '--i': String(index) },
        tabindex: '0',
        role: 'link',
        'aria-label': t('worlds.openWorldLabel', { name: w.name, instance: w.instanceName }),
        onclick: () => openWorld(w),
        onkeydown: (e) => {
          if ((e.key === 'Enter' || e.key === ' ') && e.target === el) {
            e.preventDefault();
            openWorld(w);
          }
        },
      },
      h('div', { class: 'wo-card-cover', 'aria-hidden': 'true' }, w.icon ? h('img', { class: 'wo-card-bg', src: w.icon, alt: '', loading: 'lazy' }) : null),
      w.playing ? h('span', { class: 'wo-card-live' }, h('i', { class: 'wo-pulse' }), t('worlds.playingNow')) : null,
      h(
        'div',
        { class: 'wo-card-body' },
        worldIcon(w, 'wo-card-icon'),
        h('h3', { class: 'wo-card-name', title: w.name }, w.name),
        h('div', { class: 'wo-card-inst', title: w.instanceName }, instanceDot(inst || { name: w.instanceName }, w.instanceLoader), h('span', { class: 'ellipsis' }, w.instanceName), w.version ? h('span', { class: 'wo-card-ver' }, w.version) : null),
        h('div', { class: 'wo-card-badges' }, modeBadge(w), w.cheats ? h('span', { class: 'badge', title: t('worlds.cheatsHint') }, icon('wand'), t('worlds.cheats')) : null, w.damaged ? h('span', { class: 'badge warn' }, icon('alert'), t('worlds.damaged')) : null),
        h('div', { class: 'wo-card-meta' }, meta),
      ),
      h('div', { class: 'wo-card-actions' }, play, map, more),
    );
    return el;
  }

  function drawSummary(list) {
    const totalPlay = list.reduce((a, w) => a + (w.playtime || 0), 0);
    const totalSize = list.reduce((a, w) => a + (w.size || 0), 0);
    mount(
      summary,
      h('span', {}, t('worlds.worldsCount', { count: list.length })),
      totalPlay ? h('span', {}, t('worlds.inGameTotal', { time: shortDur(totalPlay) })) : null,
      totalSize ? h('span', {}, t('worlds.onDisk', { size: fmtBytes(totalSize) })) : null,
    );
  }

  function drawGrid() {
    if (tab !== 'worlds') return;
    filterBar.hidden = false;
    toolbar.hidden = false;
    if (error) {
      mount(gridHost, errorBox(error, () => reload()));
      mount(summary);
      return;
    }
    if (!worlds) {
      mount(summary);
      mount(gridHost, listSkeleton());
      return;
    }
    if (!store.instances.length || !worlds.length) {
      // Sin instancias o sin mundos los filtros no sirven: solo el estado vacio con su accion
      filterBar.hidden = true;
      toolbar.hidden = true;
      mount(summary);
      mount(
        gridHost,
        h(
          'div',
          { class: 'card flat' },
          !store.instances.length
            ? emptyState('layers', t('worlds.noInstances'), t('worlds.noInstancesText'), h('button', { class: 'btn primary', type: 'button', onclick: () => navigate('versions/new') }, icon('plus'), t('worlds.createInstance')))
            : emptyState('globe', t('worlds.noWorlds'), t('worlds.noWorldsText'), h('button', { class: 'btn primary', type: 'button', onclick: () => navigate('versions') }, icon('layers'), t('worlds.goToInstances'))),
        ),
      );
      return;
    }
    const list = filtered();
    drawSummary(list);
    if (!list.length) {
      mount(
        gridHost,
        h(
          'div',
          { class: 'card flat' },
          emptyState(
            'search',
            t('worlds.noMatch'),
            t('worlds.noMatchText'),
            h(
              'button',
              {
                class: 'btn',
                type: 'button',
                onclick: () => {
                  state.query = '';
                  search.value = '';
                  state.mode = 'all';
                  state.instance = '';
                  savePrefs({ mode: 'all', instance: '' });
                  drawToolbar();
                  drawGrid();
                  search.focus();
                },
              },
              icon('x'),
              t('worlds.clearFilters'),
            ),
          ),
        ),
      );
      return;
    }
    const focusKey = document.activeElement?.closest?.('.wo-card')?.getAttribute('aria-label');
    mount(gridHost, h('div', { class: ['wo-grid', !entered && 'wo-enter'] }, list.map(card)));
    entered = true;
    if (focusKey) [...gridHost.querySelectorAll('.wo-card')].find((c) => c.getAttribute('aria-label') === focusKey)?.focus({ preventScroll: true });
  }

  function drawWorlds() {
    drawToolbar();
    mount(panel, h('div', { class: 'stack wo-list' }, toolbar, filterBar, gridHost));
    drawGrid();
  }

  // ---------- Capturas y clips ----------
  const mediaHost = h('div', { class: 'wo-media-host' });
  const mediaToolbar = h('div', { class: 'wo-toolbar' });

  function mediaItems() {
    let items = media?.items || [];
    if (state.mediaInstance) items = items.filter((i) => i.instanceId === state.mediaInstance);
    if (state.mediaKind === 'screenshot' || state.mediaKind === 'clip') items = items.filter((i) => i.kind === state.mediaKind);
    if (state.mediaKind === 'shared') items = items.filter((i) => sharedMap[i.sharedKey]);
    return items;
  }

  function drawMediaToolbar() {
    const all = media?.items || [];
    const inInst = state.mediaInstance ? all.filter((i) => i.instanceId === state.mediaInstance) : all;
    const n = {
      all: inInst.length,
      screenshot: inInst.filter((i) => i.kind === 'screenshot').length,
      clip: inInst.filter((i) => i.kind === 'clip').length,
      shared: inInst.filter((i) => sharedMap[i.sharedKey]).length,
    };
    const segBtn = (id, ic, label) =>
      h(
        'button',
        {
          type: 'button',
          class: state.mediaKind === id ? 'active' : '',
          'aria-pressed': String(state.mediaKind === id),
          onclick: () => {
            state.mediaKind = id;
            savePrefs({ mediaKind: id });
            drawMediaToolbar();
            drawMediaGrid();
          },
        },
        icon(ic),
        label,
        media ? h('span', { class: 'wo-seg-count' }, String(n[id])) : null,
      );
    const instIds = [...new Set(all.map((i) => i.instanceId))];
    const instSel = selectEl(
      [{ value: '', label: t('worlds.allInstances') }, ...instIds.map((id) => ({ value: id, label: store.instances.find((i) => i.id === id)?.name || id }))],
      state.mediaInstance,
      (v) => {
        state.mediaInstance = v;
        savePrefs({ mediaInstance: v });
        drawMediaToolbar();
        drawMediaGrid();
      },
    );
    instSel.setAttribute('aria-label', t('worlds.filterInstance'));
    const refresh = h('button', { class: 'icon-btn', type: 'button', title: t('worlds.refresh'), 'aria-label': t('worlds.refresh'), disabled: mediaLoading, onclick: () => loadMedia() }, icon('refresh'));
    mount(
      mediaToolbar,
      h('div', { class: 'segmented wo-seg', role: 'group', 'aria-label': t('worlds.mediaKind') }, segBtn('all', 'grid', t('worlds.kindAll')), segBtn('screenshot', 'camera', t('worlds.kindShots')), segBtn('clip', 'woFilm', t('worlds.kindClips')), segBtn('shared', 'link', t('worlds.kindShared'))),
      // Filtro de instancia y Actualizar quedan a la derecha (tambien si bajan a otra linea)
      h('div', { class: 'wo-toolbar-end' }, instSel, refresh),
    );
  }

  function drawMediaGrid() {
    if (tab !== 'media') return;
    if (mediaError) {
      mount(mediaHost, errorBox(mediaError, () => loadMedia()));
      return;
    }
    if (!media) {
      mount(mediaHost, mediaSkeleton(8, t('worlds.loadingMedia')));
      return;
    }
    const items = mediaItems();
    const emptyText = state.mediaKind === 'shared' ? t('worlds.noSharedText') : state.mediaKind === 'clip' ? t('worlds.noClipsText') : t('worlds.noMediaText');
    const emptyTitle = state.mediaKind === 'shared' ? t('worlds.noShared') : state.mediaKind === 'clip' ? t('worlds.noClips') : t('worlds.noMedia');
    // Con filtros puestos, el estado vacio ofrece volver a ver todo
    const filteredOut = (state.mediaKind !== 'all' || state.mediaInstance) && (media.items || []).length > 0;
    const clearAction = filteredOut
      ? h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onclick: () => {
              state.mediaKind = 'all';
              state.mediaInstance = '';
              savePrefs({ mediaKind: 'all', mediaInstance: '' });
              drawMediaToolbar();
              drawMediaGrid();
            },
          },
          icon('grid'),
          t('worlds.showAllMedia'),
        )
      : null;
    mount(
      mediaHost,
      mediaGrid(items, {
        sharedMap,
        emptyIcon: state.mediaKind === 'clip' ? 'woFilm' : state.mediaKind === 'shared' ? 'link' : 'camera',
        emptyTitle,
        emptyText,
        emptyAction: clearAction,
        onOpen: (index) =>
          openLightbox(items, index, {
            showWorldLink: true,
            onDeleted: (it) => {
              media.items = media.items.filter((x) => x.id !== it.id);
              media.counts[it.kind === 'clip' ? 'clips' : 'screenshots'] -= 1;
              drawTabs();
              drawMediaToolbar();
              drawMediaGrid();
            },
            onShared: () => refreshShared(),
          }),
      }),
    );
  }

  function drawMedia() {
    drawMediaToolbar();
    mount(panel, h('div', { class: 'stack wo-list' }, mediaToolbar, h('p', { class: 'wo-media-hint' }, icon('info'), h('span', {}, t('worlds.mediaHint'))), mediaHost));
    drawMediaGrid();
  }

  async function refreshShared() {
    sharedMap = (await api.invoke('worlds:shared').catch(() => ({}))) || {};
    if (alive && tab === 'media') {
      drawMediaToolbar();
      drawMediaGrid();
    }
  }

  // ---------- Carga ----------
  async function load(quiet = false) {
    if (!quiet) {
      worlds = null;
      error = null;
      drawGrid();
    }
    try {
      const list = await api.invoke('worlds:list', {});
      if (!alive) return;
      worlds = Array.isArray(list) ? list : [];
      error = null;
    } catch (err) {
      if (!alive) return;
      error = err;
    }
    drawTabs();
    drawGrid();
    // La galeria se prepara en segundo plano: la pestana muestra su cantidad y abre al instante
    if (!quiet && !media && !mediaError && tab === 'worlds') setTimeout(() => alive && !media && !mediaLoading && loadMedia(), 400);
  }

  let mediaToken = 0;
  let mediaLoading = false;
  async function loadMedia() {
    const token = ++mediaToken;
    mediaLoading = true;
    mediaError = null;
    media = null;
    if (tab === 'media') drawMediaToolbar();
    drawMediaGrid();
    try {
      const [res, shared] = await Promise.all([api.invoke('worlds:media', {}), api.invoke('worlds:shared').catch(() => ({}))]);
      if (!alive || token !== mediaToken) return;
      media = res;
      sharedMap = shared || {};
    } catch (err) {
      if (!alive || token !== mediaToken) return;
      mediaError = err;
    } finally {
      if (token === mediaToken) mediaLoading = false;
    }
    drawTabs();
    if (tab === 'media') {
      drawMediaToolbar();
      drawMediaGrid();
    }
  }

  function reload(quiet = false) {
    const jobs = [load(quiet)];
    if (tab === 'media' || media) jobs.push(loadMedia());
    return Promise.allSettled(jobs);
  }

  // Boton Actualizar: queda ocupado hasta que termina de leer todo
  async function refreshAll() {
    const done = setBusy(refreshBtn);
    try {
      await reload();
    } finally {
      if (alive) done();
    }
  }

  const quietReload = debounce(() => alive && load(true), 400);
  offs.push(
    api.on('worlds:updated', (e) => {
      if (!alive) return;
      if (e?.kind === 'sizes' && worlds) {
        for (const it of e.items || []) {
          const w = worlds.find((x) => x.instanceId === it.instanceId && x.folder === it.folder);
          if (w) w.size = it.size;
          const el = gridHost.querySelector(`.wo-size[data-size="${CSS.escape(`${it.instanceId}/${it.folder}`)}"]`);
          if (el) mount(el, icon('drive'), fmtBytes(it.size));
        }
        if (state.sort === 'size') drawGrid();
        else if (tab === 'worlds' && worlds.length) drawSummary(filtered());
      } else if (e?.kind === 'media') {
        if (media) loadMedia();
      } else if (e?.kind === 'list' || e?.kind === 'timeline') {
        quietReload();
      }
    }),
  );
  offs.push(api.on('game:activity', () => quietReload()));
  offs.push(store.on('running', () => tab === 'worlds' && worlds && drawGrid()));
  offs.push(store.on('instances', () => quietReload()));

  // Actualiza los "hace X minutos" cada minuto
  const timer = setInterval(() => {
    gridHost.querySelectorAll('[data-ago]').forEach((el) => (el.textContent = fmtAgo(Number(el.dataset.ago))));
  }, 60000);

  drawTabs();
  drawPanel();
  load();
  if (tab === 'media') loadMedia();

  return () => {
    alive = false;
    clearInterval(timer);
    closeMenu();
    closeLightbox();
    offs.forEach((o) => o());
  };
}

export { worldRoute };
