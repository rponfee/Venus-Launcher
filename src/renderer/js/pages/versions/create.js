// Nueva instancia: todas las versiones del manifest de Mojang (releases, snapshots, bromas del 1 de abril,
// beta y alpha) con busqueda, filtros con cantidades, fechas e insignia "nueva", y todos los loaders
// (Vanilla, Fabric, Quilt, Forge, NeoForge, OptiFine, Iris, Legacy Fabric y Babric) con sus versiones completas.
import { h, icon, mount, toast, fail, fmtDate, fmtAgo, debounce, selectEl, emptyState } from '../../ui.js';
import { store, api } from '../../store.js';
import { t } from '../../i18n.js';
import { navigate } from '../../app.js';
import { buildCatalog, catalogForLoader, filterVersions, countGroups, visibleLoaderVersions, pickLoaderVersion, GROUPS } from './catalog.js';
import { LOADER_KINDS, loaderMeta, kindLabel, viewPrefs, saveViewPrefs, pickMrpack, importOtherPack, importShareCode } from './common.js';

// Loaders tipo Fabric cuyas listas todavia no pasan por los canales loaders:* (se piden junto al manifest).
const MANIFEST_LOADERS = ['babric'];
const MANIFEST_TTL = 10 * 60 * 1000;
const OLD_KINDS = ['beta', 'alpha', 'infdev', 'indev', 'classic', 'preclassic'];
const TEST_KINDS = ['snapshot', 'pre', 'rc', 'experimental'];
const SKELETON_WIDTHS = [64, 52, 76, 48, 60, 56, 72, 50, 62, 58];

// Cache de la sesion (se reutiliza al volver a la pagina).
const cache = { manifest: null, manifestAt: 0, games: new Map(), loaderVersions: new Map(), extra: new Map() };

async function getCatalog() {
  if (!cache.manifest || Date.now() - cache.manifestAt > MANIFEST_TTL) {
    cache.manifest = buildCatalog(await api.versions.manifest(false));
    cache.manifestAt = Date.now();
  }
  return cache.manifest;
}

async function extraLoader(kind) {
  if (!cache.extra.has(kind)) {
    const p = api.versions.manifest({ loaders: [kind] }).then((m) => m?.venus?.loaders?.[kind] || null);
    cache.extra.set(kind, p);
    p.catch(() => cache.extra.delete(kind));
  }
  return cache.extra.get(kind);
}

async function gameVersionsFor(kind) {
  if (cache.games.has(kind)) return cache.games.get(kind);
  let list = [];
  try {
    list = await api.loaders.gameVersions(kind);
  } catch (err) {
    if (!MANIFEST_LOADERS.includes(kind)) throw err;
  }
  if ((!Array.isArray(list) || !list.length) && MANIFEST_LOADERS.includes(kind)) {
    const extra = await extraLoader(kind);
    if (extra?.error && !extra.games?.length) throw new Error(extra.error);
    list = extra?.games || [];
  }
  cache.games.set(kind, list || []);
  return list || [];
}

async function loaderVersionsFor(kind, mc) {
  const key = `${kind}|${mc}`;
  if (cache.loaderVersions.has(key)) return cache.loaderVersions.get(key);
  let list = [];
  try {
    list = await api.loaders.versions(kind, mc);
  } catch (err) {
    if (!MANIFEST_LOADERS.includes(kind)) throw err;
  }
  if ((!Array.isArray(list) || !list.length) && MANIFEST_LOADERS.includes(kind)) list = (await extraLoader(kind))?.versions?.[mc] || [];
  cache.loaderVersions.set(key, list || []);
  return list || [];
}

function loaderVersionOption(l) {
  const base = l.label || l.version;
  let label = l.recommended ? t('versions.optRecommended', { version: base }) : l.stable === false ? t('versions.optBeta', { version: base }) : base;
  if (l.forge && l.forge !== 'N/A') label = t('versions.optWithForge', { version: label, forge: l.forge });
  return { value: l.version, label };
}

function loaderTile(meta, cls = '') {
  return h('span', { class: ['vs-loader-tile', cls], style: { '--c': meta.color }, 'aria-hidden': 'true' }, meta.letter);
}

// Filas de carga con la forma de la lista de versiones (el manifest puede tardar si hay que bajarlo).
function listSkeleton() {
  return h(
    'div',
    { class: 'skeleton-group', role: 'status', 'aria-live': 'polite', 'aria-busy': 'true' },
    h('span', { class: 'sr-only' }, t('versions.loadingVersions')),
    h(
      'div',
      { class: 'skeleton-shapes vs-vskel', 'aria-hidden': 'true' },
      SKELETON_WIDTHS.map((w) => h('div', { class: 'vs-vskel-row' }, h('span', { class: 'skeleton skeleton-line', style: { width: `${w}px` } }), h('span', { class: 'spacer' }), h('span', { class: 'skeleton skeleton-line', style: { width: '72px' } }))),
    ),
  );
}

function railSkeleton() {
  return h('div', { class: 'skeleton-shapes vs-rail-skel', 'aria-hidden': 'true' }, [92, 70, 84, 60].map((w) => h('span', { class: 'skeleton skeleton-line', style: { width: `${w}px` } })));
}

export function newInstanceView(container, params = []) {
  const prefs = viewPrefs();
  const state = {
    kind: LOADER_KINDS.includes(params[0]) ? params[0] : 'vanilla',
    wantMc: params[1] || null,
    group: 'release',
    query: '',
    list: [],
    loadingList: true,
    listError: null,
    mc: null,
    loaderVersions: [],
    loaderVersion: null,
    loadingLoader: false,
    loaderError: null,
    showAll: prefs.allLoaderVersions,
    name: '',
    nameTouched: false,
    creating: false,
  };
  let token = 0;

  const loadersBox = h('div', { class: 'vs-loaders', role: 'radiogroup', 'aria-label': t('versions.chooseLoader') });
  const rail = h('div', { class: 'vs-rail', role: 'group', 'aria-label': t('versions.filterTypes') });
  const typeSel = h('select', { class: 'select vs-typesel', 'aria-label': t('versions.filterTypes'), title: t('versions.filterTypes') });
  typeSel.addEventListener('change', () => {
    state.group = typeSel.value;
    drawList({ keepScroll: false });
    listBox.scrollTop = 0;
  });
  const listBox = h('div', { class: 'vs-vlist', role: 'listbox', tabindex: -1, 'aria-label': t('versions.versionList') });
  const panel = h('div', { class: 'card vs-panel' });
  const search = h('input', { class: 'input', type: 'search', placeholder: t('versions.searchVersionsShort'), 'aria-label': t('versions.searchVersions'), autocomplete: 'off', spellcheck: 'false' });
  search.addEventListener('input', debounce(() => ((state.query = search.value), drawList()), 100));
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      (listBox.querySelector('.vs-vrow[tabindex="0"]') || listBox.querySelector('.vs-vrow'))?.focus();
    } else if (e.key === 'Escape' && search.value) {
      e.stopPropagation();
      clearSearch();
    }
  });

  const searchText = (v) => `${v.id} ${kindLabel(v.kind)} ${v.group === 'aprilfools' ? t('versions.aprilFoolsSearch') : ''} ${(v.releaseTime || '').slice(0, 4)}`;

  function clearSearch() {
    search.value = '';
    state.query = '';
    drawList({ keepScroll: false });
    search.focus();
  }

  // ---------- Loaders ----------
  function drawLoaders() {
    mount(
      loadersBox,
      LOADER_KINDS.map((k) => {
        const meta = loaderMeta(k);
        const on = state.kind === k;
        return h(
          'button',
          {
            type: 'button',
            class: ['vs-loader', on && 'active'],
            role: 'radio',
            'aria-checked': String(on),
            tabindex: on ? 0 : -1,
            title: meta.desc,
            style: { '--c': meta.color },
            dataset: { kind: k },
            onclick: () => selectKind(k),
          },
          h('span', { class: 'vs-loader-check', 'aria-hidden': 'true' }, icon('check')),
          loaderTile(meta),
          h('span', { class: 'vs-loader-name' }, meta.name),
        );
      }),
    );
  }
  loadersBox.addEventListener('keydown', (e) => {
    if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const i = LOADER_KINDS.indexOf(state.kind);
    let n = i;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = (i + 1) % LOADER_KINDS.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = (i - 1 + LOADER_KINDS.length) % LOADER_KINDS.length;
    else if (e.key === 'Home') n = 0;
    else n = LOADER_KINDS.length - 1;
    selectKind(LOADER_KINDS[n]);
    loadersBox.querySelector(`[data-kind="${LOADER_KINDS[n]}"]`)?.focus();
  });

  // ---------- Filtros por tipo (columna lateral; en espacios angostos, un desplegable) ----------
  function drawFilters() {
    if (state.loadingList) {
      mount(rail, railSkeleton());
      mount(typeSel, h('option', { value: state.group }, t(`versions.group_${state.group}`)));
      typeSel.disabled = true;
      return;
    }
    typeSel.disabled = Boolean(state.listError);
    const counts = countGroups(state.list, { query: state.query, searchText });
    const groups = GROUPS.filter((g) => g === 'all' || counts[g] > 0 || state.group === g);
    mount(
      rail,
      groups.map((g) => {
        const on = state.group === g;
        return h(
          'button',
          {
            type: 'button',
            class: ['vs-rail-btn', on && 'active', g === 'aprilfools' && 'vs-af'],
            'aria-pressed': String(on),
            onclick: () => {
              if (state.group === g) return;
              state.group = g;
              drawList({ keepScroll: false });
              listBox.scrollTop = 0;
            },
          },
          h('span', { class: 'vs-rail-label' }, t(`versions.group_${g}`)),
          h('span', { class: 'vs-rail-count' }, String(counts[g])),
        );
      }),
    );
    mount(typeSel, groups.map((g) => h('option', { value: g, selected: state.group === g }, t('versions.groupOption', { label: t(`versions.group_${g}`), count: counts[g] }))));
  }

  // Sugerencias: la version estable mas nueva del loader y, si es mas nueva, la ultima de prueba.
  function suggestions() {
    const release = state.list.find((v) => v.group === 'release');
    const test = state.list.find((v) => v.group === 'snapshot');
    const out = [];
    if (release) out.push({ v: release, label: t('versions.latestRelease') });
    if (test && (!release || test.time > release.time)) out.push({ v: test, label: t('versions.latestSnapshot') });
    return out.map(({ v, label }) =>
      h(
        'button',
        {
          type: 'button',
          class: 'vs-pick',
          title: t('versions.pickLatestTitle', { version: v.id }),
          onclick: () => {
            if (state.group !== 'all' && state.group !== v.group) state.group = v.group;
            selectVersion(v.id, { scroll: true, redraw: true });
          },
        },
        icon('star'),
        h('span', { class: 'vs-pick-text' }, h('span', { class: 'vs-pick-label' }, label), h('strong', { class: 'ellipsis', title: v.id }, v.id)),
        icon('chevronRight'),
      ),
    );
  }

  function versionRow(v) {
    const selected = state.mc === v.id;
    return h(
      'button',
      {
        type: 'button',
        class: ['vs-vrow', selected && 'active', `k-${v.kind}`],
        role: 'option',
        'aria-selected': String(selected),
        tabindex: selected ? 0 : -1,
        dataset: { id: v.id },
        onclick: () => selectVersion(v.id),
      },
      h('span', { class: 'vs-vid', title: v.id }, v.id),
      v.kind !== 'release' ? h('span', { class: `badge vs-kind vs-kind-${v.kind}` }, kindLabel(v.kind)) : null,
      v.isNew ? h('span', { class: 'badge accent vs-newbadge' }, icon('sparkles'), t('versions.new')) : null,
      v.latest
        ? h(
            'span',
            { class: 'vs-latest', title: v.latest === 'release' ? t('versions.latestRelease') : t('versions.latestSnapshot') },
            icon('star'),
            h('span', { class: 'sr-only' }, v.latest === 'release' ? t('versions.latestRelease') : t('versions.latestSnapshot')),
          )
        : null,
      h('span', { class: 'vs-vdate', title: v.releaseTime ? fmtAgo(v.time) : null }, v.releaseTime ? fmtDate(v.time) : ''),
    );
  }

  function drawList({ keepScroll = true } = {}) {
    drawFilters();
    if (state.loadingList) {
      mount(listBox, listSkeleton());
      return;
    }
    if (state.listError) {
      mount(
        listBox,
        h(
          'div',
          { class: 'vs-list-error' },
          h(
            'div',
            { class: 'notice bad', role: 'alert' },
            icon('alert'),
            h('div', {}, h('strong', {}, t('versions.loadFailed')), h('div', { class: 'small' }, state.listError)),
            h('button', { class: 'btn sm', type: 'button', onclick: () => selectKind(state.kind, { force: true }) }, icon('refresh'), t('versions.retry')),
          ),
        ),
      );
      return;
    }
    const shown = filterVersions(state.list, { group: state.group, query: state.query, searchText });
    if (!shown.length) {
      let action = null;
      if (state.query) action = h('button', { class: 'btn sm', type: 'button', onclick: clearSearch }, icon('x'), t('versions.clearSearch'));
      else if (state.group !== 'all' && state.list.length) {
        action = h(
          'button',
          {
            class: 'btn sm',
            type: 'button',
            onclick: () => {
              state.group = 'all';
              drawList({ keepScroll: false });
            },
          },
          icon('layers'),
          t('versions.showAllTypes'),
        );
      }
      mount(
        listBox,
        h(
          'div',
          { class: 'vs-list-empty' },
          emptyState(
            'search',
            state.list.length ? t('versions.noVersionsMatch') : t('versions.noVersionsLoader', { loader: loaderMeta(state.kind).name }),
            state.query ? t('versions.noVersionsHint') : null,
            action,
          ),
        ),
      );
      return;
    }
    const top = listBox.scrollTop;
    mount(listBox, shown.map(versionRow));
    if (!listBox.querySelector('.vs-vrow[tabindex="0"]')) listBox.querySelector('.vs-vrow')?.setAttribute('tabindex', '0');
    if (keepScroll) listBox.scrollTop = top;
  }

  listBox.addEventListener('keydown', (e) => {
    const rows = [...listBox.querySelectorAll('.vs-vrow')];
    if (!rows.length) return;
    const i = rows.indexOf(document.activeElement);
    let n = null;
    if (e.key === 'ArrowDown') n = Math.min(rows.length - 1, i + 1);
    else if (e.key === 'ArrowUp') n = i <= 0 ? -1 : i - 1;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = rows.length - 1;
    else if (e.key === 'PageDown') n = Math.min(rows.length - 1, i + 10);
    else if (e.key === 'PageUp') n = Math.max(0, i - 10);
    if (n === null) return;
    e.preventDefault();
    if (n === -1) return search.focus();
    rows[n].focus({ preventScroll: true });
    scrollRowIntoList(rows[n], 'nearest');
    selectVersion(rows[n].dataset.id);
    return undefined;
  });

  // Desplaza solo la lista (scrollIntoView tambien moveria la pagina).
  function scrollRowIntoList(el, mode = 'center') {
    if (!el) return;
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    if (mode === 'center') listBox.scrollTop = Math.max(0, top - (listBox.clientHeight - el.offsetHeight) / 2);
    else if (top < listBox.scrollTop) listBox.scrollTop = top - 6;
    else if (bottom > listBox.scrollTop + listBox.clientHeight) listBox.scrollTop = bottom - listBox.clientHeight + 6;
  }

  function scrollToSelected() {
    scrollRowIntoList(listBox.querySelector('.vs-vrow.active'));
  }

  // Cambia la seleccion sin redibujar la lista (conserva el foco del teclado y el scroll).
  function updateSelection() {
    for (const el of listBox.querySelectorAll('.vs-vrow')) {
      const on = el.dataset.id === state.mc;
      el.classList.toggle('active', on);
      el.setAttribute('aria-selected', String(on));
      el.setAttribute('tabindex', on ? '0' : '-1');
    }
  }

  async function selectKind(kind, { force = false } = {}) {
    if (kind === state.kind && !force && !state.listError && state.list.length) return;
    const my = ++token;
    state.kind = kind;
    state.mc = null;
    state.loaderVersions = [];
    state.loaderVersion = null;
    state.loaderError = null;
    state.loadingList = true;
    state.listError = null;
    state.list = [];
    if (!state.nameTouched) state.name = '';
    if (force) {
      cache.games.delete(kind);
      cache.extra.delete(kind);
    }
    drawLoaders();
    drawList();
    drawPanel();
    try {
      const catalog = await getCatalog();
      const list = kind === 'vanilla' ? catalog : catalogForLoader(catalog, await gameVersionsFor(kind));
      if (my !== token) return;
      state.list = list;
      state.loadingList = false;
      const counts = countGroups(list);
      if (!counts[state.group]) state.group = counts.release ? 'release' : 'all';
      drawList({ keepScroll: false });
      listBox.scrollTop = 0;
      if (!state.wantMc || !list.some((v) => v.id === state.wantMc)) {
        state.wantMc = null;
        drawPanel();
      }
      if (state.wantMc) {
        const want = list.find((v) => v.id === state.wantMc);
        state.wantMc = null;
        if (state.group !== 'all' && want.group !== state.group) state.group = want.group;
        selectVersion(want.id, { scroll: true, redraw: true });
      }
    } catch (err) {
      if (my !== token) return;
      state.loadingList = false;
      state.listError = err.message || String(err);
      drawList();
      drawPanel();
    }
  }

  async function selectVersion(id, { scroll = false, redraw = false } = {}) {
    if (state.mc === id && !redraw && (state.kind === 'vanilla' || state.loaderVersions.length || state.loadingLoader)) return;
    const my = ++token;
    state.mc = id;
    state.loaderVersion = null;
    state.loaderVersions = [];
    state.loaderError = null;
    if (redraw || !listBox.querySelector(`.vs-vrow[data-id="${CSS.escape(id)}"]`)) drawList();
    else updateSelection();
    if (scroll) scrollToSelected();
    if (state.kind === 'vanilla') {
      state.loadingLoader = false;
      drawPanel();
      return;
    }
    state.loadingLoader = true;
    drawPanel();
    try {
      const list = await loaderVersionsFor(state.kind, id);
      if (my !== token) return;
      state.loaderVersions = Array.isArray(list) ? list : [];
      state.loaderVersion = pickLoaderVersion(state.loaderVersions);
    } catch (err) {
      if (my !== token) return;
      state.loaderError = err.message || String(err);
    }
    state.loadingLoader = false;
    drawPanel();
  }

  // ---------- Panel de configuracion ----------
  function defaultName() {
    return `${loaderMeta(state.kind).name} ${state.mc}`;
  }

  function versionNotices(v) {
    const meta = loaderMeta(state.kind);
    const out = [];
    if (state.kind === 'iris') out.push(['info', 'sparkles', t('versions.noticeIris')]);
    if (state.kind === 'optifine') out.push(['info', 'info', t('versions.noticeOptifine')]);
    if (state.kind === 'babric') out.push(['info', 'info', t('versions.noticeBabric')]);
    if (state.kind === 'legacyfabric') out.push(['info', 'info', t('versions.noticeLegacyFabric')]);
    if (!v) return out;
    if (v.kind === 'aprilfools') out.push(['', 'alert', t('versions.noticeAprilFools')]);
    else if (TEST_KINDS.includes(v.kind)) out.push(['', 'alert', t('versions.noticeSnapshot')]);
    if (OLD_KINDS.includes(v.kind)) out.push(['info', 'history', t('versions.noticeOld')]);
    if (state.kind !== 'vanilla' && v.loaderStable === false && !TEST_KINDS.includes(v.kind) && v.kind !== 'aprilfools') out.push(['', 'alert', t('versions.noticeLoaderUnstable', { loader: meta.name })]);
    return out;
  }

  function loaderField() {
    if (state.kind === 'vanilla') return null;
    const meta = loaderMeta(state.kind);
    const title = state.kind === 'optifine' ? t('versions.optifineEdition') : state.kind === 'iris' ? t('versions.fabricLoaderVersion') : t('versions.loaderVersion', { loader: meta.name });
    if (state.loadingLoader) {
      return h(
        'div',
        { class: 'field' },
        h('span', { class: 'label' }, title),
        h('div', { class: 'skeleton-group', role: 'status', 'aria-live': 'polite', 'aria-busy': 'true' }, h('span', { class: 'sr-only' }, t('versions.loadingLoaderVersions')), h('span', { class: 'skeleton vs-field-skel', 'aria-hidden': 'true' })),
        h('div', { class: 'field-help' }, t('versions.loadingLoaderVersions')),
      );
    }
    if (state.loaderError) {
      return h(
        'div',
        { class: 'notice bad', role: 'alert' },
        icon('alert'),
        h('div', { class: 'spacer' }, h('strong', {}, t('versions.loaderLoadFailed')), h('div', { class: 'small' }, state.loaderError)),
        h(
          'button',
          { class: 'btn sm', type: 'button', onclick: () => (cache.loaderVersions.delete(`${state.kind}|${state.mc}`), (state.loaderVersions = []), selectVersion(state.mc)) },
          icon('refresh'),
          t('versions.retry'),
        ),
      );
    }
    if (!state.loaderVersions.length) return h('div', { class: 'notice' }, icon('alert'), h('div', {}, t('versions.noLoaderVersions', { loader: meta.name, version: state.mc })));
    const visible = visibleLoaderVersions(state.loaderVersions, state.showAll);
    const hasUnstable = state.loaderVersions.some((l) => l.stable === false);
    if (!visible.some((l) => l.version === state.loaderVersion)) state.loaderVersion = pickLoaderVersion(visible);
    const sel = selectEl(visible.map(loaderVersionOption), state.loaderVersion, (v) => (state.loaderVersion = v));
    sel.id = 'vs-loader-version';
    sel.setAttribute('aria-describedby', 'vs-loader-help');
    const rec = state.loaderVersions.find((l) => l.recommended);
    const stableCount = state.loaderVersions.filter((l) => l.stable !== false).length;
    return h(
      'div',
      { class: 'field' },
      h(
        'div',
        { class: 'row vs-field-head' },
        h('label', { for: 'vs-loader-version', class: 'spacer' }, title),
        hasUnstable
          ? h(
              'div',
              { class: 'segmented vs-seg-sm', role: 'group', 'aria-label': t('versions.loaderChannel') },
              [
                [false, t('versions.channelStable')],
                [true, t('versions.channelAll')],
              ].map(([all, label]) =>
                h(
                  'button',
                  {
                    type: 'button',
                    class: state.showAll === all ? 'active' : '',
                    'aria-pressed': String(state.showAll === all),
                    onclick: () => {
                      state.showAll = all;
                      saveViewPrefs({ allLoaderVersions: all });
                      drawPanel();
                    },
                  },
                  label,
                ),
              ),
            )
          : null,
      ),
      sel,
      h(
        'div',
        { class: 'field-help vs-dots num', id: 'vs-loader-help' },
        h('span', {}, t('versions.loaderCount', { count: state.loaderVersions.length })),
        hasUnstable ? h('span', {}, t('versions.stableCount', { count: stableCount })) : null,
        rec ? h('span', {}, t('versions.recommendedIs', { version: rec.label || rec.version })) : null,
      ),
    );
  }

  async function create() {
    if (!state.mc || state.creating) return;
    if (state.kind !== 'vanilla' && !state.loaderVersion) return;
    state.creating = true;
    drawPanel();
    try {
      const inst = await api.instances.create({
        name: state.name.trim() || defaultName(),
        mcVersion: state.mc,
        loader: state.kind === 'iris' ? 'fabric' : state.kind,
        loaderVersion: state.kind === 'vanilla' ? null : state.loaderVersion,
        preset: state.kind === 'iris' ? 'iris' : null,
      });
      await store.refreshInstances();
      await store.setSettings({ selectedInstance: inst.id });
      toast('info', t('versions.createdToast'), t('versions.createdToastText', { name: inst.name }));
      navigate(`instance/${encodeURIComponent(inst.id)}`);
    } catch (err) {
      state.creating = false;
      drawPanel();
      fail(t('versions.createFailed'), err);
    }
  }

  function importRow(ic, label, onclick, title) {
    return h(
      'button',
      { class: 'vs-panel-btn', type: 'button', title: title || null, onclick },
      h('span', { class: 'vs-panel-btn-icon', 'aria-hidden': 'true' }, icon(ic)),
      h('span', {}, label),
      icon('chevronRight'),
    );
  }

  function drawPanel() {
    const meta = loaderMeta(state.kind);
    if (!state.mc) {
      const picks = state.loadingList || state.listError ? [] : suggestions();
      mount(
        panel,
        h(
          'div',
          { class: 'vs-panel-head' },
          loaderTile(meta, 'lg'),
          h('div', { class: 'vs-panel-headtext' }, h('h2', { class: 'vs-panel-title ellipsis' }, meta.name), h('div', { class: 'vs-panel-sub' }, meta.desc)),
        ),
        h('p', { class: 'vs-panel-lead' }, t('versions.pickVersionFor', { loader: meta.name })),
        picks.length
          ? h('div', { class: 'vs-picks' }, h('div', { class: 'label' }, t('versions.suggestions')), picks)
          : state.listError
            ? null
            : h('div', { class: 'vs-pick-hint' }, icon('arrowLeft'), t('versions.pickFromList')),
        h('div', { class: 'divider' }),
        h(
          'div',
          { class: 'vs-panel-section' },
          h('div', { class: 'small muted' }, t('versions.importHint')),
          h(
            'div',
            { class: 'vs-panel-imports' },
            importRow('package', t('versions.importMrpack'), pickMrpack),
            importRow('hash', t('versions.useCodeLong'), () => importShareCode(), t('versions.useCodeHint')),
            importRow('archive', t('versions.importOther'), () => importOtherPack()),
          ),
        ),
      );
      return;
    }
    const v = state.list.find((x) => x.id === state.mc);
    const nameInput = h('input', { class: 'input', id: 'vs-name', value: state.name || defaultName(), maxlength: 60, autocomplete: 'off', spellcheck: 'false' });
    nameInput.addEventListener('input', () => {
      state.name = nameInput.value;
      state.nameTouched = Boolean(nameInput.value.trim());
    });
    nameInput.addEventListener('keydown', (e) => e.key === 'Enter' && create());
    const disabled = state.creating || state.loadingLoader || (state.kind !== 'vanilla' && !state.loaderVersion);
    mount(
      panel,
      h(
        'div',
        { class: 'vs-panel-head' },
        loaderTile(meta, 'lg'),
        h(
          'div',
          { class: 'vs-panel-headtext' },
          h('h2', { class: 'vs-panel-title ellipsis', title: defaultName() }, defaultName()),
          h('div', { class: 'vs-panel-sub vs-dots' }, v ? h('span', {}, kindLabel(v.kind)) : null, v?.releaseTime ? h('span', {}, fmtDate(v.time)) : null),
        ),
      ),
      h('div', { class: 'field' }, h('label', { for: 'vs-name' }, t('versions.nameLabel')), nameInput),
      loaderField(),
      versionNotices(v).map(([kind, ic, text]) => h('div', { class: ['notice', kind] }, icon(ic), h('div', {}, text))),
      h(
        'div',
        { class: 'vs-panel-section' },
        h(
          'button',
          { class: ['btn primary lg block', state.creating && 'loading'], type: 'button', disabled, 'aria-busy': state.creating ? 'true' : null, onclick: create },
          icon('download'),
          state.creating ? t('versions.creating') : t('versions.createInstall'),
        ),
        h('div', { class: 'tiny muted vs-panel-foot' }, t('versions.backgroundHint')),
      ),
    );
  }

  mount(
    container,
    h(
      'div',
      { class: 'vs-new' },
      loadersBox,
      h(
        'div',
        { class: 'vs-new-grid' },
        h(
          'div',
          { class: 'card flat vs-browser' },
          h('div', { class: 'vs-browser-head' }, h('div', { class: 'input-icon vs-vsearch' }, icon('search'), search), typeSel),
          h('div', { class: 'vs-browser-body' }, rail, listBox),
        ),
        panel,
      ),
    ),
  );
  const startKind = state.kind;
  state.kind = null;
  selectKind(startKind);
  return () => {
    token++;
  };
}
