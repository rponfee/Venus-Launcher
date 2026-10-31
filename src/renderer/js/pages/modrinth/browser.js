// Catalogo: busqueda en todo Modrinth (y en CurseForge) con todos los filtros ("Filtros" y "Mas filtros"),
// cantidad de resultados por pagina a eleccion, carga infinita, salto de pagina, comparacion de shaders /
// resource packs e instalacion en un clic.
import { h, icon, mount, clear, fmtNumber, fmtAgo, emptyState, selectEl, switchEl, debounce, toast, registerIcons, instanceLoaderKey } from '../../ui.js';
import { store, api } from '../../store.js';
import { navigate } from '../../app.js';
import { t } from '../../i18n.js';
import {
  session,
  TYPES,
  TYPE_IDS,
  CF_TYPES,
  VISUAL_TYPES,
  PAGE_SIZES,
  pageSizeOf,
  setPageSize,
  typeLabel,
  categoryLabel,
  headerLabel,
  loaderName,
  loaderChip,
  fmtInt,
  targetFacets,
  targetProblem,
  installedIn,
  installedInServers,
  cfInstalledIn,
  projectIcon,
  stat,
  colorOf,
  isPluginServer,
  isModServer,
  isProxyServer,
  loadServerTypes,
  modLoadersFor,
  isReleaseVersion,
  isLoaderTag,
  keepFocus,
  tabKeys,
} from './shared.js';
import { openCompare } from './compare.js';
import { cfUnavailableCard } from './curseforge.js';
import { openInstallDialog } from '../../features/install.js';
import { createMoreFilters, morePayload, morePills, moreCount, clearMore, radioKeys } from '../../features/searchfilters.js';

registerIcons({
  columns: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M12 3v18"/>',
  listFilter: '<path d="M3 6h18"/><path d="M7 12h10"/><path d="M10 18h4"/>',
});

const AUTO_WINDOW = 480; // tarjetas que se cargan solas antes de pedir "Cargar más"
// Cuánto antes del final se pide la tanda que sigue. Corto a propósito: así la primera tanda es exactamente la cantidad
// por página elegida (10, 20, 50 o 100) y la siguiente se pide recién al llegar casi al final (o si la primera no llena la pantalla).
const PREFETCH = 240;
const MAX_ATTEMPTS = 2; // con frase o palabras excluidas: veces seguidas que se pide más si una tanda vuelve sin resultados
const MR_SORTS = ['relevance', 'downloads', 'follows', 'newest', 'updated'];
const CF_SORTS = ['popularity', 'downloads', 'updated', 'released', 'name', 'rating'];
const CF_MAX = 10000;
const CF_LOADERS = ['forge', 'fabric', 'neoforge', 'quilt'];

function loaderLabelOf(inst) {
  const key = instanceLoaderKey(inst);
  return key === 'vanilla' ? 'Vanilla' : loaderName(key === 'legacyfabric' ? 'legacy-fabric' : key);
}

function applyRoute(route) {
  const S = session;
  if (!route.instanceId && !route.serverId && !route.type) return;
  S.source = 'modrinth';
  if (TYPE_IDS.includes(route.type)) {
    if (S.mr.type !== route.type) {
      S.mr.categories = [];
      S.mr.loaders = [];
    }
    S.mr.type = route.type;
    if (CF_TYPES.includes(route.type)) S.cf.type = route.type;
  }
  if (route.serverId) S.mr.target = { kind: 'server', id: route.serverId };
  else if (route.instanceId) {
    S.mr.target = { kind: 'instance', id: route.instanceId };
    S.cf.target = { kind: 'instance', id: route.instanceId };
  }
}

export function renderBrowser(root, route = {}) {
  const S = session;
  applyRoute(route);
  let alive = true;
  let servers = store.servers || [];
  let facets = null;
  let facetsType = null;
  let cfCats = null;
  let cfCatsType = null;
  let gameVersions = null;
  let cfStatus = null;
  let loadingMore = false;
  let reqToken = 0;
  const cards = new Map();
  const offs = [];

  const st = () => (S.source === 'curseforge' ? S.cf : S.mr);
  const isMr = () => S.source !== 'curseforge';

  // ---------- Estructura ----------
  const title = h('h1', { class: 'page-title mx-title' });
  const subtitle = h('p', { class: 'page-sub' });
  const sourceSeg = h('div', { class: 'segmented mx-source', role: 'tablist', 'aria-label': t('modrinth.sourceLabel'), onkeydown: tabKeys });
  const siteBtn = h('button', { class: 'btn ghost', type: 'button' });
  const typeTabs = h('div', { class: 'tabs mx-types', role: 'tablist', 'aria-label': t('modrinth.typesLabel'), onkeydown: tabKeys });
  const targetBar = h('div', { class: 'mx-target' });
  const searchInput = h('input', { class: 'input', type: 'search', autocomplete: 'off', spellcheck: 'false', 'aria-label': t('modrinth.searchLabel') });
  const sortBox = h('div', { class: 'mx-sort' });
  const filtersBtn = h('button', { class: 'btn mx-filters-btn', type: 'button', 'aria-controls': 'mx-filter-panel' });
  const moreBtn = h('button', { class: 'btn mx-filters-btn mx-more-btn', type: 'button', 'aria-controls': 'mx-more-panel' });
  // Los dos botones de filtros van juntos: si la barra no alcanza, pasan a la segunda fila los dos a la vez
  const toolbar = h('div', { class: 'mx-toolbar' }, h('div', { class: 'input-icon mx-search' }, icon('search'), searchInput, h('span', { class: 'kbd mx-slash', title: t('modrinth.slashHint') }, '/')), sortBox, h('div', { class: 'mx-fbtns' }, filtersBtn, moreBtn));
  const panel = h('div', { class: 'mx-panel', id: 'mx-filter-panel' });
  // "Mas filtros": frase exacta, palabras a excluir, autor, descargas, fecha, codigo abierto, entorno y licencia
  const morePanel = h('div', { class: 'mx-panel mx-morepanel', id: 'mx-more-panel', role: 'region', 'aria-label': t('searchfilters.title') });
  // Busqueda, destino ("compatible con") y filtros en un solo bloque
  const query = h('section', { class: 'mx-query', 'aria-label': t('modrinth.searchLabel') }, toolbar, targetBar, panel, morePanel);
  const activeBar = h('div', { class: 'mx-active' });
  const resultsHead = h('div', { class: 'mx-rhead', 'aria-live': 'polite' });
  // Cantidad de resultados por pagina: fuera de la zona que anuncia el lector de pantalla
  const perPageBox = h('div', { class: 'mx-perpage' });
  const resultsRow = h('div', { class: 'mx-rrow' }, resultsHead, perPageBox);
  const grid = h('div', { class: 'mx-grid', role: 'list' });
  const sentinel = h('div', { class: 'mx-sentinel', 'aria-hidden': 'true' });
  const foot = h('div', { class: 'mx-foot' });
  const catalog = h('div', { class: 'mx-catalog' }, query, activeBar, resultsRow, grid, sentinel, foot);
  const body = h('div', { class: 'mx-body' });
  const tray = h('div', { class: 'mx-tray', role: 'region', 'aria-label': t('modrinth.compareTray') });

  mount(
    root,
    h('div', { class: 'page-head mx-head' }, h('div', { class: 'ph-text' }, title, subtitle), h('div', { class: 'page-actions' }, sourceSeg, siteBtn)),
    h('div', { class: 'mx-types-wrap' }, typeTabs),
    body,
    tray,
  );

  searchInput.addEventListener(
    'input',
    debounce(() => {
      if (searchInput.value.trim() === st().query) return;
      st().query = searchInput.value.trim();
      reload();
    }, 380),
  );
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      st().query = searchInput.value.trim();
      reload();
    } else if (e.key === 'Escape' && searchInput.value) {
      e.stopPropagation();
      searchInput.value = '';
      st().query = '';
      reload();
    }
  });
  filtersBtn.addEventListener('click', () => {
    S.filtersOpen = !S.filtersOpen;
    drawPanel();
    if (S.filtersOpen) panel.querySelector('button, select, input')?.focus();
  });
  moreBtn.addEventListener('click', () => {
    S.moreOpen = !S.moreOpen;
    drawMore();
    if (S.moreOpen) morePanel.querySelector('input, select, button')?.focus();
  });
  // Escape cierra el panel abierto y devuelve el foco a su boton
  for (const [box, flag, btn, redraw] of [
    [panel, 'filtersOpen', filtersBtn, () => drawPanel()],
    [morePanel, 'moreOpen', moreBtn, () => drawMore()],
  ]) {
    box.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !S[flag] || e.defaultPrevented) return;
      e.stopPropagation();
      S[flag] = false;
      redraw();
      btn.focus({ preventScroll: true });
    });
  }

  // ---------- Destino ("compatible con") ----------
  function resolveTarget() {
    const tg = st().target;
    if (!tg) return null;
    if (tg.kind === 'server') {
      if (!isMr()) return null;
      const obj = servers.find((x) => x.id === tg.id);
      return obj ? { kind: 'server', obj } : null;
    }
    const obj = store.instances.find((x) => x.id === tg.id);
    return obj ? { kind: 'instance', obj } : null;
  }

  function facetsFor() {
    const tg = resolveTarget();
    return tg ? targetFacets(S.mr.type, tg.obj, tg.kind) : null;
  }

  // Capacidades de "Mas filtros" segun la fuente: el entorno es de Modrinth (solo mods y modpacks; con un servidor de
  // destino lo define el destino), el autor es un usuario exacto en Modrinth y un nombre visible en CurseForge.
  function moreCaps() {
    if (!isMr()) return { environment: false, authorMode: 'name', openSourceMode: 'source' };
    const applies = ['mod', 'modpack'].includes(S.mr.type);
    return { environment: applies ? (resolveTarget()?.kind === 'server' ? 'locked' : true) : false, authorMode: 'username', openSourceMode: 'license' };
  }

  function mrParams() {
    const s = S.mr;
    const p = { query: s.query, type: s.type, sort: s.sort, categories: [...s.categories] };
    // frase, palabras excluidas, autor, descargas, dias, codigo abierto y entorno
    Object.assign(p, morePayload(s, moreCaps()));
    const f = facetsFor();
    if (f) {
      p.gameVersions = f.gameVersions;
      if (f.loaders?.length) p.loaders = f.loaders;
      if (f.environment) p.environment = f.environment; // el destino manda
    } else {
      if (s.gameVersion) p.gameVersions = [s.gameVersion];
      if (s.loaders.length) p.loaders = [...s.loaders];
    }
    if (s.license) p.license = s.license;
    return p;
  }

  function cfParams() {
    const s = S.cf;
    const p = { query: s.query, type: s.type, sort: s.sort };
    if (s.categoryId) p.categoryId = s.categoryId;
    // CurseForge no filtra por estos criterios: los filtra el proceso principal sobre lo que devuelve
    Object.assign(p, morePayload(s, moreCaps()));
    const tg = resolveTarget();
    if (tg) {
      p.gameVersion = tg.obj.mcVersion;
      const l = modLoadersFor(tg.obj).filter((x) => CF_LOADERS.includes(x));
      if (['mod', 'modpack'].includes(s.type) && l.length) p.loader = l[0];
    } else {
      if (s.gameVersion) p.gameVersion = s.gameVersion;
      if (s.loader && ['mod', 'modpack'].includes(s.type)) p.loader = s.loader;
    }
    return p;
  }

  const currentKey = () => JSON.stringify([S.source, isMr() ? mrParams() : cfParams(), pageSizeOf(S.source)]);

  function drawTarget() {
    const s = st();
    const type = s.type;
    if (type === 'modpack') {
      mount(targetBar, h('div', { class: 'mx-target-note' }, icon('info'), t('modrinth.modpackNote')));
      return;
    }
    const options = [{ value: '', label: t('modrinth.targetAny') }];
    if (type !== 'plugin') {
      for (const i of store.instances) options.push({ value: `instance:${i.id}`, label: t('modrinth.targetInstance', { name: i.name, mc: i.mcVersion, loader: loaderLabelOf(i) }) });
    }
    if (isMr() && (type === 'plugin' || type === 'mod')) {
      for (const x of servers) {
        if (type === 'plugin' ? !isPluginServer(x) : !isModServer(x)) continue;
        options.push({ value: `server:${x.id}`, label: t('modrinth.targetServer', { name: x.name, mc: x.mcVersion, type: loaderName(x.type) }) });
      }
    }
    const tg = resolveTarget();
    const cur = tg ? `${tg.kind}:${tg.obj.id}` : '';
    const sel = selectEl(
      options,
      cur,
      (v) => {
        const cut = v.indexOf(':');
        s.target = v ? { kind: v.slice(0, cut), id: v.slice(cut + 1) } : null;
        drawTarget();
        drawPanel();
        drawMore();
        drawActive();
        syncRoute();
        reload();
      },
      'select mx-target-select',
    );
    sel.setAttribute('aria-label', t('modrinth.targetLabel'));
    sel.dataset.fk = 'target';
    let info = null;
    if (tg) {
      const problem = isMr() ? targetProblem(type, tg.obj, tg.kind) : null;
      if (problem) info = h('span', { class: 'pill warn mx-target-pill' }, icon('alert'), h('span', { class: 'ellipsis' }, t(`modrinth.problem_${problem}`)));
      else {
        const f = isMr() ? facetsFor() : null;
        const loaders = isMr() ? (f?.loaders || []).filter((l) => l !== 'vanilla' && l !== 'datapack').map(loaderName) : ['mod', 'modpack'].includes(type) ? modLoadersFor(tg.obj).filter((x) => CF_LOADERS.includes(x)).slice(0, 1).map(loaderName) : [];
        // Proxies: la version es la del proxy, el filtro es solo por loader
        const proxy = tg.kind === 'server' && isProxyServer(tg.obj);
        info = h('span', { class: 'pill good mx-target-pill' }, icon('check'), h('span', { class: 'ellipsis' }, proxy ? loaders.join(' / ') : loaders.length ? t('modrinth.targetFacets', { mc: tg.obj.mcVersion, loaders: loaders.join(' / ') }) : t('modrinth.targetFacetsMc', { mc: tg.obj.mcVersion })));
      }
    }
    const none = options.length === 1;
    keepFocus(targetBar, () =>
      mount(
        targetBar,
        h('span', { class: 'mx-target-label' }, icon('target'), t('modrinth.targetLabel')),
        none ? h('span', { class: 'mx-target-none' }, type === 'plugin' ? t('modrinth.noServers') : t('modrinth.noInstances')) : sel,
        none ? h('button', { class: 'btn sm ghost', type: 'button', onclick: () => navigate(type === 'plugin' ? 'servers' : 'versions/new') }, icon('plus'), type === 'plugin' ? t('modrinth.createServer') : t('modrinth.createInstance')) : info,
      ),
    );
  }

  // ---------- Encabezado, origen y tipos ----------
  function drawHead() {
    const mr = isMr();
    title.className = `page-title mx-title ${mr ? 'is-modrinth' : 'is-curseforge'}`;
    title.textContent = t('nav.modrinth');
    subtitle.textContent = mr ? t('modrinth.subtitle') : t('modrinth.subtitleCfText');
    const url = mr ? 'https://modrinth.com' : 'https://www.curseforge.com/minecraft';
    mount(siteBtn, icon('external'), mr ? 'modrinth.com' : 'curseforge.com');
    siteBtn.title = url;
    siteBtn.onclick = () => window.venus.app.openExternal(url).catch(() => {});
    keepFocus(sourceSeg, () =>
      mount(
        sourceSeg,
        ['modrinth', 'curseforge'].map((src) =>
          h(
            'button',
            {
              type: 'button',
              role: 'tab',
              'aria-selected': S.source === src ? 'true' : 'false',
              tabindex: S.source === src ? 0 : -1,
              class: [S.source === src && 'active', `mx-src-${src}`],
              dataset: { fk: `src-${src}` },
              onclick: () => switchSource(src),
            },
            h('span', { class: 'mx-src-dot', 'aria-hidden': 'true' }),
            src === 'modrinth' ? 'Modrinth' : 'CurseForge',
          ),
        ),
      ),
    );
  }

  async function switchSource(src) {
    if (S.source === src) return;
    S.source = src;
    S.results = null;
    searchInput.value = st().query;
    if (src === 'curseforge') await ensureCfStatus();
    drawAll();
    syncRoute();
    reload();
  }

  function drawTypes() {
    const list = isMr() ? TYPES : TYPES.filter((x) => CF_TYPES.includes(x.id));
    typeTabs.classList.toggle('cf', !isMr());
    keepFocus(typeTabs, () =>
      mount(
        typeTabs,
        list.map((tp) =>
          h(
            'button',
            {
              type: 'button',
              role: 'tab',
              'aria-selected': st().type === tp.id ? 'true' : 'false',
              tabindex: st().type === tp.id ? 0 : -1,
              class: ['tab', st().type === tp.id && 'active'],
              dataset: { fk: `type-${tp.id}` },
              onclick: () => {
                if (st().type === tp.id) return;
                const s = st();
                s.type = tp.id;
                if (isMr()) {
                  s.categories = [];
                  s.loaders = [];
                } else s.categoryId = null;
                drawAll();
                syncRoute();
                reload();
              },
            },
            icon(tp.icon),
            typeLabel(tp.id),
            isMr() && S.typeCounts?.[tp.id] !== undefined ? h('span', { class: 'count', title: fmtInt(S.typeCounts[tp.id]) }, fmtNumber(S.typeCounts[tp.id])) : null,
          ),
        ),
      ),
    );
  }

  function drawSort() {
    const s = st();
    const opts = isMr() ? MR_SORTS.map((v) => ({ value: v, label: t(`modrinth.sort_${v}`) })) : CF_SORTS.map((v) => ({ value: v, label: t(`modrinth.cfsort_${v}`) }));
    const sel = selectEl(opts, s.sort, (v) => {
      s.sort = v;
      reload();
    });
    sel.setAttribute('aria-label', t('modrinth.sortLabel'));
    mount(sortBox, sel);
  }

  // ---------- Filtros ----------
  function chip(label, active, onToggle, title, fk) {
    const b = h('button', { type: 'button', class: ['chip', active && 'active'], 'aria-pressed': active ? 'true' : 'false', title: title || null, dataset: fk ? { fk } : null }, label);
    b.addEventListener('click', () => {
      const on = !b.classList.contains('active');
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      onToggle(on);
    });
    return b;
  }

  function toggleIn(list, value, on) {
    const i = list.indexOf(value);
    if (on && i < 0) list.push(value);
    if (!on && i >= 0) list.splice(i, 1);
  }

  // Filtros activos del panel "Filtros" (categorias, loaders y version) y de "Mas filtros" (el resto, con la licencia).
  // Los que define el destino elegido no cuentan: no los eligio el usuario.
  function classicCount() {
    if (isMr()) {
      const s = S.mr;
      const locked = Boolean(facetsFor());
      return s.categories.length + (locked ? 0 : s.loaders.length + (s.gameVersion ? 1 : 0));
    }
    const s = S.cf;
    const locked = Boolean(resolveTarget());
    return (s.categoryId ? 1 : 0) + (locked ? 0 : (s.gameVersion ? 1 : 0) + (s.loader && ['mod', 'modpack'].includes(s.type) ? 1 : 0));
  }

  const moreTotal = () => moreCount(st(), moreCaps()) + (isMr() && S.mr.license ? 1 : 0);
  const activeCount = () => classicCount() + moreTotal();

  function filtersChanged() {
    drawActive();
    drawFiltersBtn();
    drawMoreBtn();
    reload();
  }

  // Boton que abre un panel de filtros: con la cantidad de filtros activos (el lector de pantalla la lee completa)
  function filterBtn(btn, iconName, label, n, open) {
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.classList.toggle('active', open);
    mount(
      btn,
      icon(iconName),
      label,
      n ? h('span', { class: 'mx-count', 'aria-hidden': 'true' }, String(n)) : null,
      n ? h('span', { class: 'sr-only' }, ` (${t('searchfilters.activeCount', { count: n })})`) : null,
      h('span', { class: ['mx-caret', open && 'open'], 'aria-hidden': 'true' }, icon('chevronDown')),
    );
  }

  function drawFiltersBtn() {
    filterBtn(filtersBtn, 'filter', t('modrinth.filters'), classicCount(), S.filtersOpen);
  }

  function drawMoreBtn() {
    filterBtn(moreBtn, 'sliders', t('searchfilters.title'), moreTotal(), S.moreOpen);
  }

  async function ensureFacets() {
    const type = S.mr.type;
    if (facets && facetsType === type) return;
    try {
      const f = await api.invoke('modrinth:facets', type);
      if (!alive || S.mr.type !== type) return;
      facets = f;
    } catch {
      facets = { categories: [], loaders: [], gameVersions: [], licenses: [] };
    }
    facetsType = type;
    gameVersions = gameVersions || facets.gameVersions;
    drawPanel();
    drawMore();
    drawActive();
  }

  async function ensureGameVersions() {
    if (gameVersions) return gameVersions;
    try {
      gameVersions = (await api.invoke('modrinth:facets', 'mod')).gameVersions || [];
    } catch {
      gameVersions = [];
    }
    return gameVersions;
  }

  function versionSelect(value, snapshots, onChange) {
    const list = (gameVersions || []).filter((v) => snapshots || v.type === 'release');
    const opts = [{ value: '', label: t('modrinth.anyVersion') }, ...list.map((v) => ({ value: v.version, label: v.type === 'release' ? v.version : t('modrinth.versionWithType', { version: v.version, type: t(`modrinth.gv_${v.type}`) }) }))];
    if (value && !list.some((v) => v.version === value)) opts.splice(1, 0, { value, label: value });
    const sel = selectEl(opts, value, onChange);
    sel.setAttribute('aria-label', t('modrinth.gameVersion'));
    sel.dataset.fk = 'gv';
    return sel;
  }

  function locked() {
    return h('div', { class: 'mx-locked' }, icon('lock'), t('modrinth.lockedByTarget'));
  }

  // Esqueleto del panel de filtros mientras llegan las categorias
  function panelSkeleton() {
    const bone = (cls, w) => h('span', { class: `skeleton ${cls}`, style: w ? { width: w } : null });
    const chipsRow = (n) => h('div', { class: 'mx-sk-chips' }, Array.from({ length: n }, (_, i) => bone('mx-sk-chip', `${64 + ((i * 37) % 48)}px`)));
    return h(
      'div',
      { class: 'skeleton-group', role: 'status', 'aria-busy': 'true' },
      h('span', { class: 'sr-only' }, t('modrinth.loadingFilters')),
      h('div', { class: 'mx-pgrid', 'aria-hidden': 'true' }, h('div', { class: 'mx-pcol' }, bone('skeleton-line', '90px'), chipsRow(9), chipsRow(6)), h('div', { class: 'mx-pcol' }, bone('skeleton-line', '70px'), chipsRow(4), bone('skeleton-line', '120px'), bone('mx-sk-select'))),
    );
  }

  // Al redibujar el panel, el foco vuelve al mismo control (chips, selects, interruptores)
  function drawPanel() {
    keepFocus(panel, renderPanel);
  }

  function renderPanel() {
    drawFiltersBtn();
    panel.hidden = !S.filtersOpen;
    if (!S.filtersOpen) return mount(panel);
    if (!isMr()) return drawCfPanel();
    if (!facets || facetsType !== S.mr.type) {
      mount(panel, panelSkeleton());
      ensureFacets();
      return;
    }
    const s = S.mr;
    const tgLocked = Boolean(facetsFor());
    const groups = facets.categories.map((g) =>
      h('div', { class: 'mx-fgroup' }, h('div', { class: 'mx-flabel' }, headerLabel(g.header)), h('div', { class: 'chips' }, g.names.map((name) => chip(categoryLabel(name), s.categories.includes(name), (on) => (toggleIn(s.categories, name, on), filtersChanged()), null, `cat-${name}`)))),
    );
    const right = [];
    if (facets.loaders.length) {
      right.push(
        h(
          'div',
          { class: 'mx-fgroup' },
          h('div', { class: 'mx-flabel' }, t('modrinth.loaders')),
          tgLocked ? locked() : h('div', { class: 'chips' }, facets.loaders.map((l) => chip(loaderName(l), s.loaders.includes(l), (on) => (toggleIn(s.loaders, l, on), filtersChanged()), null, `ld-${l}`))),
        ),
      );
    }
    right.push(
      h(
        'div',
        { class: 'mx-fgroup' },
        h('div', { class: 'mx-flabel' }, t('modrinth.gameVersion')),
        tgLocked
          ? locked()
          : h(
              'div',
              { class: 'mx-vrow' },
              versionSelect(s.gameVersion, s.snapshots, (v) => {
                s.gameVersion = v;
                filtersChanged();
              }),
              snapshotsSwitch(s),
            ),
      ),
    );
    // El entorno y la licencia (con "solo codigo abierto") viven en "Mas filtros"
    mount(
      panel,
      h('div', { class: 'mx-pgrid' }, h('div', { class: 'mx-pcol' }, groups.length ? groups : h('div', { class: 'mx-pnone' }, t('modrinth.noCategories'))), h('div', { class: 'mx-pcol' }, right)),
      h('div', { class: 'mx-pfoot' }, h('span', { class: 'mx-phint' }, icon('info'), t('modrinth.filtersHint')), h('span', { class: 'spacer' }), clearFiltersBtn()),
    );
  }

  function clearFiltersBtn() {
    return h('button', { class: 'btn sm ghost', type: 'button', disabled: !activeCount(), dataset: { fk: 'clear' }, onclick: clearFilters }, icon('x'), t('modrinth.clearFilters'));
  }

  // ---------- Mas filtros ----------
  // Un formulario por fuente (cada una tiene su propio estado de sesion). Cambiar un campo no redibuja el panel
  // (el foco y lo que se esta escribiendo quedan donde estan): solo actualiza etiquetas, contadores y resultados.
  const moreForms = {};
  function moreForm() {
    const src = isMr() ? 'modrinth' : 'curseforge';
    if (!moreForms[src]) {
      moreForms[src] = createMoreFilters({
        state: src === 'modrinth' ? S.mr : S.cf,
        caps: moreCaps,
        idPrefix: `mx-${src}`,
        onChange: () => filtersChanged(),
        extra: src === 'modrinth' ? () => [licenseField()] : null,
      });
    }
    return moreForms[src];
  }

  // Licencia de Modrinth (select) como un campo mas de "Mas filtros"
  function licenseField() {
    const s = S.mr;
    const opts = [{ value: '', label: t('modrinth.licenseAny') }, ...(facets?.licenses || []).map((l) => ({ value: l, label: licenseLabel(l) }))];
    if (s.license && !opts.some((o) => o.value === s.license)) opts.push({ value: s.license, label: licenseLabel(s.license) });
    const sel = selectEl(opts, s.license, (v) => {
      s.license = v;
      filtersChanged();
    });
    sel.id = 'mx-license';
    sel.dataset.fk = 'license';
    return h('div', { class: 'sf-field' }, h('label', { class: 'sf-label', for: 'mx-license' }, t('modrinth.license')), sel);
  }

  function drawMore() {
    keepFocus(morePanel, renderMore);
  }

  function renderMore() {
    drawMoreBtn();
    morePanel.hidden = !S.moreOpen;
    if (!S.moreOpen) return mount(morePanel);
    const form = moreForm();
    form.refresh();
    mount(morePanel, form.el, h('div', { class: 'mx-pfoot' }, h('span', { class: 'mx-phint' }, icon('info'), t(isMr() ? 'modrinth.moreHint' : 'modrinth.moreHintCf')), h('span', { class: 'spacer' }), clearFiltersBtn()));
  }

  // "Incluir snapshots": interruptor con su texto clicable al lado
  function snapshotsSwitch(s) {
    const sw = switchEl(
      s.snapshots,
      (on) => {
        s.snapshots = on;
        if (!on && s.gameVersion && !isReleaseVersion(s.gameVersion)) {
          s.gameVersion = '';
          filtersChanged();
        }
        drawPanel();
      },
      t('modrinth.showSnapshots'),
    );
    const box = sw.querySelector('input');
    box.dataset.fk = 'snapshots';
    return h('div', { class: 'mx-switch-row' }, sw, h('span', { class: 'mx-switch-text', onclick: () => box.click() }, t('modrinth.showSnapshots')));
  }

  function drawCfPanel() {
    const s = S.cf;
    if (!cfCats || cfCatsType !== s.type || !gameVersions) {
      mount(panel, panelSkeleton());
      const type = s.type;
      Promise.all([api.invoke('curseforge:categories', type).catch(() => []), ensureGameVersions()]).then(([list]) => {
        if (!alive || S.cf.type !== type) return;
        cfCats = list || [];
        cfCatsType = type;
        drawPanel();
      });
      return;
    }
    const tgLocked = Boolean(resolveTarget());
    // categorias principales con sus subcategorias al lado (una sola a la vez)
    const ids = new Set(cfCats.map((c) => c.id));
    const roots = cfCats.filter((c) => !ids.has(c.parent));
    const pick = (c, sub) => {
      const b = chip(
        c.name,
        s.categoryId === c.id,
        (on) => {
          s.categoryId = on ? c.id : null;
          drawPanel();
          filtersChanged();
        },
        null,
        `cfcat-${c.id}`,
      );
      if (sub) b.classList.add('mx-subchip');
      return b;
    };
    const cats = h(
      'div',
      { class: 'chips mx-cfcat-list' },
      roots.map((r) => [pick(r, false), cfCats.filter((c) => c.parent === r.id).map((k) => pick(k, true))]),
    );
    const right = [];
    if (['mod', 'modpack'].includes(s.type)) {
      const sel = selectEl([{ value: '', label: t('modrinth.anyLoader') }, ...CF_LOADERS.map((l) => ({ value: l, label: loaderName(l) }))], s.loader, (v) => {
        s.loader = v;
        filtersChanged();
      });
      sel.setAttribute('aria-label', t('modrinth.loaders'));
      sel.dataset.fk = 'cfloader';
      right.push(h('div', { class: 'mx-fgroup' }, h('div', { class: 'mx-flabel' }, t('modrinth.loaders')), tgLocked ? locked() : sel));
    }
    right.push(
      h(
        'div',
        { class: 'mx-fgroup' },
        h('div', { class: 'mx-flabel' }, t('modrinth.gameVersion')),
        tgLocked
          ? locked()
          : versionSelect(s.gameVersion, false, (v) => {
              s.gameVersion = v;
              filtersChanged();
            }),
      ),
    );
    mount(
      panel,
      h('div', { class: 'mx-pgrid' }, h('div', { class: 'mx-pcol' }, h('div', { class: 'mx-fgroup mx-cfcats' }, h('div', { class: 'mx-flabel' }, t('modrinth.categories')), cfCats.length ? cats : h('div', { class: 'mx-pnone' }, t('modrinth.noCategories')))), h('div', { class: 'mx-pcol' }, right)),
      h('div', { class: 'mx-pfoot' }, h('span', { class: 'spacer' }), clearFiltersBtn()),
    );
  }

  function licenseLabel(l) {
    if (l === 'LicenseRef-All-Rights-Reserved') return t('modrinth.licenseArr');
    if (l === 'LicenseRef-Custom') return t('modrinth.licenseCustom');
    return l;
  }

  // Quita todos los filtros de la fuente actual (los de "Filtros" y los de "Mas filtros")
  function clearFilters() {
    if (isMr()) Object.assign(S.mr, { categories: [], loaders: [], gameVersion: '', license: '' });
    else Object.assign(S.cf, { categoryId: null, gameVersion: '', loader: '' });
    clearMore(st());
    drawPanel();
    drawMore();
    filtersChanged();
  }

  function clearAll() {
    st().query = '';
    searchInput.value = '';
    st().target = null;
    drawTarget();
    clearFilters();
    syncRoute();
  }

  function pill(label, onRemove, extraClass) {
    // al quitar un filtro con el teclado, el foco pasa al siguiente (o al boton Filtros si no quedan)
    const remove = () => {
      const i = [...activeBar.querySelectorAll('.mx-apill-x')].indexOf(document.activeElement);
      onRemove();
      if (i < 0) return;
      const left = [...activeBar.querySelectorAll('.mx-apill-x')];
      (left[Math.min(i, left.length - 1)] || filtersBtn).focus({ preventScroll: true });
    };
    return h('span', { class: ['mx-apill', extraClass], title: label }, h('span', { class: 'ellipsis' }, label), h('button', { type: 'button', class: 'mx-apill-x', title: t('modrinth.removeFilter', { name: label }), 'aria-label': t('modrinth.removeFilter', { name: label }), onclick: remove }, icon('x')));
  }

  function drawActive() {
    const pills = [];
    const s = st();
    if (isMr()) {
      const locked2 = Boolean(facetsFor());
      for (const c of s.categories) pills.push(pill(categoryLabel(c), () => (toggleIn(s.categories, c, false), drawPanel(), filtersChanged())));
      if (!locked2) {
        for (const l of s.loaders) pills.push(pill(loaderName(l), () => (toggleIn(s.loaders, l, false), drawPanel(), filtersChanged())));
        if (s.gameVersion) pills.push(pill(t('modrinth.pillVersion', { version: s.gameVersion }), () => ((s.gameVersion = ''), drawPanel(), filtersChanged())));
      }
      if (s.license) pills.push(pill(licenseLabel(s.license), () => ((s.license = ''), drawMore(), filtersChanged())));
    } else {
      const cat = (cfCats || []).find((c) => c.id === s.categoryId);
      if (s.categoryId) pills.push(pill(cat?.name || t('modrinth.categories'), () => ((s.categoryId = null), drawPanel(), filtersChanged())));
      if (!resolveTarget()) {
        if (s.gameVersion) pills.push(pill(t('modrinth.pillVersion', { version: s.gameVersion }), () => ((s.gameVersion = ''), drawPanel(), filtersChanged())));
        if (s.loader && ['mod', 'modpack'].includes(s.type)) pills.push(pill(loaderName(s.loader), () => ((s.loader = ''), drawPanel(), filtersChanged())));
      }
    }
    // Mas filtros: frase, palabras excluidas, autor, descargas, dias, codigo abierto y entorno
    for (const mp of morePills(s, moreCaps())) pills.push(pill(mp.label, () => (mp.clear(s), drawMore(), filtersChanged())));
    const n = pills.length;
    // los botones "Limpiar filtros" de los paneles (que no se redibujan al escribir) se habilitan o no segun haya filtros
    for (const b of query.querySelectorAll('[data-fk="clear"]')) b.disabled = !n;
    activeBar.hidden = !n;
    mount(
      activeBar,
      n ? h('span', { class: 'mx-active-count' }, icon('filter'), t('searchfilters.activeCount', { count: n })) : null,
      pills,
      n
        ? h(
            'button',
            {
              type: 'button',
              class: 'btn sm ghost mx-clear',
              onclick: () => {
                clearFilters();
                filtersBtn.focus({ preventScroll: true });
              },
            },
            icon('x'),
            t('modrinth.clearFilters'),
          )
        : null,
    );
  }

  // ---------- Resultados ----------
  // Tarjetas fantasma con la misma forma que las reales (banner, icono, titulo, texto, etiquetas y pie)
  function skeletons() {
    const visual = isMr() && VISUAL_TYPES.has(S.mr.type);
    const bone = (cls, w) => h('span', { class: `skeleton ${cls}`, style: w ? { width: w } : null });
    return Array.from({ length: 9 }, (_, i) =>
      h(
        'div',
        { class: ['mx-card', 'mx-skel', visual && 'visual'], 'aria-hidden': 'true' },
        visual ? bone('mx-sk-banner') : null,
        h(
          'div',
          { class: 'mx-card-body' },
          bone('mx-icon'),
          bone('skeleton-line mx-sk-title', `${52 + ((i * 17) % 30)}%`),
          bone('skeleton-line mx-sk-author', `${30 + ((i * 11) % 20)}%`),
          h('div', { class: 'mx-sk-desc' }, bone('skeleton-line'), bone('skeleton-line', `${55 + ((i * 13) % 35)}%`)),
          h('div', { class: 'mx-sk-tags' }, bone('mx-sk-tag'), bone('mx-sk-tag'), bone('mx-sk-tag')),
        ),
        h('div', { class: 'mx-card-foot' }, bone('skeleton-line mx-sk-stat'), bone('skeleton-line mx-sk-stat'), h('span', { class: 'spacer' }), bone('mx-sk-btn')),
      ),
    );
  }

  function saveScroll() {
    if (S.results) S.results.scrollTop = root.scrollTop;
  }

  function reload({ startPage = 0 } = {}) {
    if (!alive) return;
    if (!isMr() && !cfStatus?.configured) {
      drawBody();
      return;
    }
    const size = pageSizeOf(S.source);
    const start = startPage * size;
    S.results = { key: currentKey(), source: S.source, type: st().type, size, hits: [], total: 0, start, next: start, done: false, capped: false, filtered: false, stalled: false, placeholder: false, error: null, scrollTop: 0, first: true, autoUntil: AUTO_WINDOW };
    loadingMore = false;
    reqToken++;
    cards.clear();
    grid.setAttribute('aria-busy', 'true');
    mount(grid, skeletons());
    mount(foot);
    drawRHead();
    const top = catalog.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
    if (root.scrollTop > top) root.scrollTop = Math.max(0, top - 12);
    loadMore();
  }

  // Una tanda de resultados de la fuente actual, con la misma forma para las dos: { hits, total, next, done, filtered, capped }.
  // next = desde donde pedir lo que sigue. Con frase o palabras excluidas (y en CurseForge con cualquiera de "Mas filtros")
  // el proceso principal revisa varias paginas de la API hasta juntar `size` resultados: next puede avanzar mas que size
  // y total es el de la API sin ese filtro (filtered: true avisa que no es el total real).
  async function fetchBatch(r) {
    const size = r.size;
    if (r.source === 'modrinth') {
      const data = await api.modrinth.search({ ...mrParams(), offset: r.next, limit: size });
      const hits = data.hits || [];
      const total = data.total_hits || 0;
      const next = data.next_offset ?? r.next + size;
      return { hits, total, next, done: data.exhausted ?? (hits.length < size || next >= total), filtered: Boolean(data.filtered), capped: Boolean(data.capped) };
    }
    const data = await api.invoke('curseforge:search', { ...cfParams(), index: r.next, pageSize: size });
    const hits = data.hits || [];
    const total = data.total || 0;
    const next = data.next_index ?? r.next + size;
    return { hits, total, next, done: data.exhausted ?? (hits.length < size || next >= Math.min(total, CF_MAX)), filtered: Boolean(data.filtered), capped: total > CF_MAX && next >= CF_MAX };
  }

  async function loadMore() {
    const r = S.results;
    if (!alive || !r || loadingMore || r.done || r.error) return;
    loadingMore = true;
    r.stalled = false;
    const my = ++reqToken;
    drawFoot();
    try {
      // Con filtros que se aplican en la app una tanda puede volver sin resultados aunque queden: se vuelve a pedir
      // (hasta MAX_ATTEMPTS veces seguidas) antes de dejar el boton "Seguir buscando". Mientras tanto se ven las tarjetas fantasma.
      for (let attempt = 1; ; attempt++) {
        const page = await fetchBatch(r);
        if (my !== reqToken || r !== S.results || !alive) return;
        r.total = page.total;
        r.filtered = page.filtered;
        r.capped = page.capped;
        r.next = page.next;
        r.done = page.done;
        if (page.hits.length) {
          if (r.first || r.placeholder) {
            clear(grid);
            r.first = false;
            r.placeholder = false;
          }
          for (const hit of page.hits) {
            r.hits.push(hit);
            grid.append(card(hit, r.source));
          }
        }
        if (page.hits.length || r.done) break;
        if (attempt >= MAX_ATTEMPTS) {
          r.stalled = true;
          break;
        }
      }
      if (!r.hits.length) {
        r.first = false;
        r.placeholder = true;
        keepFocus(grid, () => mount(grid, r.done ? noResults() : stalledState()));
      }
    } catch (err) {
      if (my !== reqToken || r !== S.results || !alive) return;
      r.error = err?.message || String(err);
      if (r.first || r.placeholder) {
        clear(grid);
        r.first = false;
        r.placeholder = false;
      }
    } finally {
      if (my === reqToken) {
        loadingMore = false;
        grid.removeAttribute('aria-busy');
        drawRHead();
        drawFoot();
        requestAnimationFrame(checkSentinel);
      }
    }
  }

  function canAuto() {
    const r = S.results;
    return r && !r.done && !r.error && !r.stalled && !loadingMore && r.hits.length < r.autoUntil;
  }

  function checkSentinel() {
    if (!alive || !canAuto() || !sentinel.isConnected) return;
    const view = root.getBoundingClientRect();
    const box = sentinel.getBoundingClientRect();
    if (box.top < view.bottom + PREFETCH) loadMore();
  }

  const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && canAuto() && loadMore(), { root, rootMargin: `0px 0px ${PREFETCH}px 0px` });
  io.observe(sentinel);

  function totalPages(r) {
    const reachable = r.source === 'modrinth' ? r.total : Math.min(r.total, CF_MAX);
    return Math.max(1, Math.ceil(reachable / r.size));
  }

  function noResults() {
    const filtered = activeCount() > 0 || Boolean(resolveTarget()) || Boolean(st().query);
    const action = filtered
      ? h(
          'button',
          {
            class: 'btn sm',
            type: 'button',
            onclick: () => {
              clearAll();
              searchInput.focus({ preventScroll: true });
            },
          },
          icon('x'),
          t('modrinth.clearAll'),
        )
      : null;
    return h('div', { class: 'mx-empty', role: 'listitem' }, emptyState('search', t('modrinth.noResults'), filtered ? t('modrinth.noResultsFiltered') : t('modrinth.noResultsText'), action));
  }

  // Una tanda sin resultados con filtros que se aplican en la app, pero con mas para revisar
  function stalledState() {
    return h('div', { class: 'mx-empty', role: 'listitem' }, emptyState('search', t('modrinth.stalledTitle'), t('modrinth.stalledText'), keepSearchingBtn()));
  }

  function keepSearchingBtn() {
    return h('button', { class: 'btn sm', type: 'button', dataset: { fk: 'keep' }, onclick: () => keepSearching() }, icon('refresh'), t('modrinth.keepSearching'));
  }

  function keepSearching() {
    const r = S.results;
    if (!r || loadingMore) return;
    r.stalled = false;
    loadMore();
  }

  // Cantidad de resultados por pagina (Modrinth: 10, 20, 50 o 100; CurseForge: 10, 20 o 50). Se recuerda en los ajustes.
  function drawPerPage() {
    const sizes = PAGE_SIZES[S.source] || PAGE_SIZES.modrinth;
    const current = pageSizeOf(S.source);
    keepFocus(perPageBox, () =>
      mount(
        perPageBox,
        h('span', { class: 'mx-perpage-label', id: 'mx-perpage-label' }, t('modrinth.perPage')),
        h(
          'div',
          { class: 'segmented mx-perpage-seg', role: 'radiogroup', 'aria-labelledby': 'mx-perpage-label', title: t('modrinth.perPageTitle'), onkeydown: radioKeys },
          sizes.map((n) =>
            h(
              'button',
              {
                type: 'button',
                role: 'radio',
                'aria-checked': n === current ? 'true' : 'false',
                tabindex: n === current ? 0 : -1,
                class: [n === current && 'active'],
                dataset: { fk: `per-${n}` },
                onclick: () => choosePageSize(n),
              },
              String(n),
            ),
          ),
        ),
      ),
    );
  }

  function choosePageSize(n) {
    if (n === pageSizeOf(S.source)) return;
    setPageSize(S.source, n);
    reload();
  }

  function drawRHead() {
    drawPerPage();
    const r = S.results;
    if (!r || r.first) {
      mount(resultsHead, h('div', { class: 'mx-total is-loading' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), t('modrinth.searching')));
      return;
    }
    if (r.error && !r.hits.length) return mount(resultsHead);
    // Con frase o palabras excluidas el total real no se conoce hasta revisar todo: se cuenta lo encontrado hasta ahora
    const exact = !r.filtered;
    const n = exact ? r.total : r.hits.length;
    const pages = totalPages(r);
    const from = Math.floor(r.start / r.size) + 1;
    mount(
      resultsHead,
      // "0+ resultados" no dice nada: mientras no apareció ninguno solo queda el aviso de que se filtra en el launcher
      !exact && !r.done && !n ? null : h('div', { class: 'mx-total' }, h('strong', { class: 'num' }, exact || r.done ? fmtInt(n) : t('modrinth.countPlus', { n: fmtInt(n) })), h('span', {}, t('modrinth.resultsWord', { count: n }))),
      exact ? null : h('span', { class: 'mx-fnote', title: t('modrinth.filteredTitle') }, icon('info'), t('modrinth.filteredNote')),
      exact && r.start > 0
        ? h(
            'span',
            { class: 'mx-from' },
            h('span', { class: 'num' }, t('modrinth.fromPage', { page: fmtInt(from), pages: fmtInt(pages) })),
            h('span', { 'aria-hidden': 'true' }, '·'),
            h('button', { type: 'button', class: 'mx-linkbtn', onclick: () => reload() }, t('modrinth.backToStart')),
          )
        : null,
      h('span', { class: 'spacer' }),
      isMr() && VISUAL_TYPES.has(S.mr.type) && r.hits.length ? h('span', { class: 'mx-cmp-hint' }, icon('columns'), t('modrinth.compareHint')) : null,
    );
  }

  function drawFoot() {
    const r = S.results;
    if (!r) return mount(foot);
    const parts = [];
    if (loadingMore && !r.first) parts.push(h('div', { class: 'mx-more', role: 'status' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), t('modrinth.loadingMore')));
    else if (r.error) {
      parts.push(
        h(
          'div',
          { class: 'notice bad mx-err', role: 'alert' },
          icon('alert'),
          h('div', { class: 'spacer' }, h('strong', {}, isMr() ? t('modrinth.searchFailed') : t('modrinth.searchFailedCf')), h('div', { class: 'mx-err-text' }, r.error)),
          h(
            'button',
            {
              class: 'btn sm',
              type: 'button',
              onclick: () => {
                r.error = null;
                if (!r.hits.length) reload({ startPage: Math.floor(r.start / r.size) });
                else loadMore();
              },
            },
            icon('refresh'),
            t('modrinth.retry'),
          ),
        ),
      );
    } else if (r.stalled && r.hits.length) {
      // ya hay resultados en pantalla pero la ultima busqueda no encontro mas: se sigue a pedido del usuario
      parts.push(h('div', { class: 'notice info mx-capped' }, icon('info'), h('div', { class: 'spacer' }, t('modrinth.stalledText')), keepSearchingBtn()));
    } else if (r.capped) parts.push(h('div', { class: 'notice info mx-capped' }, icon('info'), r.source === 'curseforge' ? t('modrinth.cappedCf', { n: fmtInt(CF_MAX) }) : t('modrinth.capped')));
    else if (r.done && r.hits.length) parts.push(h('div', { class: 'mx-end' }, icon('check'), t('modrinth.endOfResults')));
    else if (!r.done && r.hits.length >= r.autoUntil) {
      parts.push(
        h(
          'button',
          {
            class: 'btn mx-loadmore',
            onclick: () => {
              r.autoUntil = r.hits.length + AUTO_WINDOW;
              loadMore();
            },
          },
          icon('chevronDown'),
          t('modrinth.loadMore'),
        ),
      );
    }
    // Saltar a una pagina solo se puede cuando el total es el real (con frase o palabras excluidas no se sabe donde cae)
    const pages = totalPages(r);
    if (!r.filtered && pages > 1 && r.hits.length) parts.push(pager(r, pages));
    mount(foot, parts);
  }

  function pager(r, pages) {
    const from = Math.floor(r.start / r.size) + 1;
    const to = Math.min(pages, Math.max(from, Math.ceil((r.start + r.hits.length) / r.size)));
    const input = h('input', { class: 'input mx-page-input num', type: 'number', min: 1, max: pages, value: Math.min(pages, to + 1), 'aria-label': t('modrinth.pageNumber') });
    // el pie se redibuja al saltar: el foco vuelve a la busqueda (arriba de los resultados nuevos)
    const jump = (startPage) => {
      reload({ startPage });
      searchInput.focus({ preventScroll: true });
    };
    const go = () => jump(Math.max(1, Math.min(pages, parseInt(input.value, 10) || 1)) - 1);
    input.addEventListener('keydown', (e) => e.key === 'Enter' && go());
    return h(
      'nav',
      { class: 'mx-pager', 'aria-label': t('modrinth.goToPage') },
      h('button', { class: 'btn sm ghost', type: 'button', disabled: from <= 1, title: t('modrinth.prevPageTitle'), onclick: () => jump(Math.max(0, from - 2)) }, icon('chevronLeft'), t('modrinth.prevPage')),
      h('span', { class: 'mx-pages num' }, from === to ? t('modrinth.pageOf', { page: fmtInt(from), pages: fmtInt(pages) }) : t('modrinth.pagesShown', { from: fmtInt(from), to: fmtInt(to), pages: fmtInt(pages) })),
      h('span', { class: 'spacer' }),
      h('label', { class: 'mx-jump' }, t('modrinth.goToPage'), input),
      h('button', { class: 'btn sm', type: 'button', onclick: go }, t('modrinth.go'), icon('arrowRight')),
    );
  }

  // ---------- Tarjetas ----------
  function card(hit, source) {
    return source === 'curseforge' ? cfCard(hit) : mrCard(hit);
  }

  function badgeFor(id, cf = false) {
    const tg = resolveTarget();
    if (tg) {
      const rec = cf ? tg.obj.curseforge?.projects?.[id] : tg.obj.modrinth?.projects?.[id];
      return rec ? h('span', { class: 'badge modrinth mx-installed', title: t('modrinth.installedVersion', { version: rec.versionNumber || '?' }) }, icon('check'), t('modrinth.installedHere')) : null;
    }
    const all = cf ? cfInstalledIn(id) : [...installedIn(id), ...installedInServers(id)];
    if (!all.length) return null;
    return h('span', { class: 'badge modrinth mx-installed', title: t('modrinth.installedInList', { list: all.map((x) => x.name).join(', ') }) }, icon('check'), all.length === 1 ? t('modrinth.installed') : t('modrinth.installedCount', { count: all.length }));
  }

  function updateBadges() {
    for (const [id, c] of cards) mount(c.slot, badgeFor(id, c.cf));
  }

  function openProject(route) {
    saveScroll();
    navigate(route);
  }

  function toggleCompare(hit, cb) {
    const id = hit.project_id;
    if (cb.checked) {
      if (S.compare.size >= 4) {
        cb.checked = false;
        toast('info', t('modrinth.compareMaxTitle'), t('modrinth.compareMax'));
        return;
      }
      S.compare.set(id, { project_id: id, slug: hit.slug, title: hit.title, icon_url: hit.icon_url, project_type: S.mr.type });
    } else S.compare.delete(id);
    cb.closest('.mx-cmp-check')?.classList.toggle('on', cb.checked);
    drawTray();
  }

  function banner(hit) {
    const url = hit.featured_gallery || hit.gallery?.[0] || null;
    const checked = S.compare.has(hit.project_id);
    const cb = h('input', { type: 'checkbox', checked, 'aria-label': t('modrinth.compareSelect', { title: hit.title }) });
    cb.addEventListener('change', () => toggleCompare(hit, cb));
    const img = url ? h('img', { src: url, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' }) : null;
    img?.addEventListener('error', () => img.replaceWith(h('div', { class: 'mx-banner-ph' }, icon('image'))), { once: true });
    return h(
      'div',
      { class: 'mx-banner', style: { '--c': colorOf(hit) || 'var(--surface-4)' } },
      img || h('div', { class: 'mx-banner-ph' }, icon('image')),
      h('label', { class: ['mx-cmp-check', checked && 'on'], title: t('modrinth.compareSelect', { title: hit.title }) }, cb, h('span', {}, t('modrinth.compare'))),
    );
  }

  function cardShell({ id, cf, visualEl, iconUrl, titleText, route, author, description, tags, stats, onInstall }) {
    const slot = h('span', { class: 'mx-badge-slot' }, badgeFor(id, cf));
    cards.set(id, { slot, cf });
    const titleLink = h(
      'a',
      {
        class: 'mx-card-title',
        href: `#/${route}`,
        title: titleText,
        onclick: (e) => {
          e.preventDefault();
          openProject(route);
        },
      },
      titleText,
    );
    const el = h(
      'article',
      { class: ['mx-card', visualEl && 'visual', cf && 'cf'], role: 'listitem', dataset: { id: String(id) } },
      visualEl,
      h(
        'div',
        { class: 'mx-card-body' },
        projectIcon(iconUrl, 'mx-icon'),
        h(
          'div',
          { class: 'mx-card-main' },
          h('div', { class: 'mx-card-top' }, titleLink, slot),
          author ? h('div', { class: 'mx-card-author ellipsis', title: author }, t('modrinth.byAuthor', { author })) : null,
          h('p', { class: 'mx-card-desc', title: description || null }, description || ''),
          tags.length ? h('div', { class: 'mx-card-tags' }, tags) : null,
        ),
      ),
      h(
        'div',
        { class: 'mx-card-foot' },
        h('div', { class: 'mx-stats' }, stats),
        h(
          'button',
          {
            class: ['btn sm mx-install mx-soft', cf && 'cf'],
            type: 'button',
            title: t('modrinth.installTitle', { title: titleText }),
            'aria-label': t('modrinth.installTitle', { title: titleText }),
            onclick: (e) => {
              e.stopPropagation();
              onInstall();
            },
          },
          icon('download'),
          h('span', { class: 'mx-install-label' }, t('modrinth.install')),
        ),
      ),
    );
    el.addEventListener('click', (e) => {
      if (e.target.closest('button, a, input, label, select')) return;
      openProject(route);
    });
    return el;
  }

  function mrCard(hit) {
    const type = S.mr.type;
    const loaders = (hit.categories || []).filter(isLoaderTag);
    const cats = (hit.display_categories?.length ? hit.display_categories : hit.categories || []).filter((c) => !isLoaderTag(c)).slice(0, 3);
    return cardShell({
      id: hit.project_id,
      cf: false,
      visualEl: VISUAL_TYPES.has(type) ? banner(hit) : null,
      iconUrl: hit.icon_url,
      titleText: hit.title,
      route: `modrinth/project/${encodeURIComponent(hit.slug || hit.project_id)}`,
      author: hit.author,
      description: hit.description,
      tags: [...cats.map((c) => h('span', { class: 'mx-tag' }, categoryLabel(c))), ...loaders.filter((l) => l !== 'minecraft' && l !== 'datapack').slice(0, 3).map((l) => loaderChip(l, 'mx-lchip'))],
      stats: [
        stat('download', fmtNumber(hit.downloads), t('modrinth.downloadsTitle', { n: fmtInt(hit.downloads) })),
        stat('heart', fmtNumber(hit.follows), t('modrinth.followsTitle', { n: fmtInt(hit.follows) }), 'is-follows'),
        stat('clock', fmtAgo(Date.parse(hit.date_modified)), t('modrinth.updatedTitle')),
      ],
      onInstall: () => quickInstall(hit, false),
    });
  }

  function cfCard(hit) {
    return cardShell({
      id: hit.id,
      cf: true,
      visualEl: null,
      iconUrl: hit.icon_url,
      titleText: hit.title,
      route: `modrinth/curseforge/${hit.id}`,
      author: hit.author,
      description: hit.description,
      tags: [...(hit.categories || []).slice(0, 3).map((c) => h('span', { class: 'mx-tag' }, c.name)), ...(hit.loaders || []).slice(0, 3).map((l) => loaderChip(l, 'mx-lchip'))],
      stats: [stat('download', fmtNumber(hit.downloads), t('modrinth.downloadsTitle', { n: fmtInt(hit.downloads) })), stat('clock', fmtAgo(Date.parse(hit.date_modified)), t('modrinth.updatedTitle'))],
      onInstall: () => quickInstall(hit, true),
    });
  }

  async function quickInstall(hit, cf) {
    const tg = resolveTarget();
    const opts = { type: st().type };
    if (tg?.kind === 'instance') opts.instanceId = tg.obj.id;
    if (tg?.kind === 'server') opts.serverId = tg.obj.id;
    const res = await openInstallDialog(cf ? { ...hit, source: 'curseforge' } : hit, opts);
    if (res && alive) {
      servers = store.servers || servers;
      updateBadges();
    }
  }

  // ---------- Comparacion ----------
  function syncChecks() {
    grid.querySelectorAll('.mx-card .mx-cmp-check').forEach((label) => {
      const cb = label.querySelector('input');
      const id = label.closest('.mx-card')?.dataset.id;
      if (!cb || !id) return;
      cb.checked = S.compare.has(id);
      label.classList.toggle('on', cb.checked);
    });
  }

  // La comparacion es de shaders y resource packs de Modrinth: en CurseForge la bandeja no se muestra
  function drawTray() {
    const n = S.compare.size;
    tray.hidden = n === 0 || !isMr();
    if (tray.hidden) return mount(tray);
    mount(
      tray,
      h(
        'div',
        { class: 'mx-tray-inner' },
        h('span', { class: 'mx-tray-ico', 'aria-hidden': 'true' }, icon('columns')),
        h(
          'div',
          { class: 'mx-tray-items' },
          [...S.compare.values()].map((p, i) =>
            h(
              'span',
              { class: 'mx-tray-item', title: p.title },
              projectIcon(p.icon_url, 'mx-tray-icon'),
              h('span', { class: 'ellipsis' }, p.title),
              h(
                'button',
                {
                  type: 'button',
                  class: 'mx-apill-x',
                  title: t('modrinth.compareRemove', { title: p.title }),
                  'aria-label': t('modrinth.compareRemove', { title: p.title }),
                  onclick: () => {
                    S.compare.delete(p.project_id);
                    syncChecks();
                    drawTray();
                    // el foco pasa a la "x" que quedo en ese lugar (o a la busqueda si se vacio)
                    const xs = tray.querySelectorAll('.mx-tray-item .mx-apill-x');
                    (xs[Math.min(i, xs.length - 1)] || searchInput).focus({ preventScroll: true });
                  },
                },
                icon('x'),
              ),
            ),
          ),
        ),
        h(
          'button',
          {
            class: 'btn sm ghost',
            type: 'button',
            onclick: () => {
              S.compare.clear();
              syncChecks();
              drawTray();
              searchInput.focus({ preventScroll: true });
            },
          },
          t('modrinth.compareClear'),
        ),
        h('button', { class: 'btn sm primary', type: 'button', disabled: n < 2, title: n < 2 ? t('modrinth.compareNeedTwo') : null, onclick: () => openCompare([...S.compare.values()]) }, icon('columns'), t('modrinth.compareOpen', { count: n })),
      ),
    );
  }

  // ---------- CurseForge ----------
  async function ensureCfStatus(force = false) {
    if (cfStatus && !force) return cfStatus;
    try {
      cfStatus = await api.invoke('curseforge:status');
    } catch (err) {
      cfStatus = { configured: false, unavailable: /no handler/i.test(err?.message || ''), error: err?.message };
    }
    return cfStatus;
  }

  function drawBody() {
    if (!isMr() && !cfStatus?.configured) {
      mount(body, cfUnavailableCard({ onBack: () => switchSource('modrinth') }));
      return;
    }
    if (catalog.parentNode !== body) mount(body, catalog);
  }

  // ---------- Conteo por tipo ----------
  async function fetchTypeCounts() {
    if (S.typeCounts && Date.now() - S.typeCountsAt < 10 * 60 * 1000) return;
    S.typeCountsAt = Date.now();
    const counts = { ...(S.typeCounts || {}) };
    for (const tp of TYPE_IDS) {
      if (!alive) return;
      try {
        counts[tp] = (await api.modrinth.search({ type: tp, limit: 1 })).total_hits;
      } catch {
        /* sin conteo */
      }
    }
    S.typeCounts = counts;
    if (alive && isMr()) drawTypes();
  }

  function syncRoute() {
    const s = S.mr;
    const tg = s.target;
    let route = 'modrinth';
    if (isMr() && (s.type !== 'mod' || tg)) route = `modrinth/${tg?.kind === 'instance' ? encodeURIComponent(tg.id) : '-'}/${s.type}${tg?.kind === 'server' ? `/${encodeURIComponent(tg.id)}` : ''}`;
    S.lastRoute = route;
    if (location.hash !== `#/${route}`) history.replaceState(null, '', `#/${route}`);
  }

  function drawAll() {
    drawHead();
    drawTypes();
    drawBody();
    searchInput.placeholder = isMr() ? t('modrinth.searchPlaceholder', { type: typeLabel(S.mr.type).toLowerCase() }) : t('modrinth.searchPlaceholderCf', { type: typeLabel(S.cf.type).toLowerCase() });
    if (searchInput.value !== st().query) searchInput.value = st().query;
    drawTarget();
    drawSort();
    drawPanel();
    drawMore();
    drawPerPage();
    drawActive();
    drawTray();
  }

  // ---------- Inicio ----------
  async function start() {
    if (!isMr()) await ensureCfStatus();
    if (!alive) return;
    drawAll();
    syncRoute();
    const r = S.results;
    if (r && r.key === currentKey() && r.hits.length && !r.error) {
      clear(grid);
      for (const hit of r.hits) grid.append(card(hit, r.source));
      drawRHead();
      drawFoot();
      const top = r.scrollTop || 0;
      requestAnimationFrame(() => {
        root.scrollTop = top;
        requestAnimationFrame(() => (root.scrollTop = top));
      });
    } else reload();
    if (isMr()) {
      ensureFacets();
      fetchTypeCounts();
    }
  }

  offs.push(
    store.on('instances', () => {
      if (!alive) return;
      drawTarget();
      updateBadges();
    }),
  );
  // Servidores locales y sus tipos (servers:types dice cuales reciben plugins o mods y con que loaders)
  Promise.all([api.servers.list(), loadServerTypes()])
    .then(([list]) => {
      if (!alive) return;
      servers = list || [];
      store.servers = servers;
      drawTarget();
      updateBadges();
      if (S.mr.target?.kind === 'server' && isMr() && S.results && S.results.key !== currentKey()) reload();
    })
    .catch(() => {});

  const onKey = (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.closest?.('input, textarea, select, [contenteditable="true"]') || document.querySelector('.modal-backdrop, .mx-lb')) return;
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
  };
  document.addEventListener('keydown', onKey);
  offs.push(() => document.removeEventListener('keydown', onKey));

  start();

  return () => {
    saveScroll();
    alive = false;
    io.disconnect();
    offs.forEach((off) => off());
  };
}
