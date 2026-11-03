// Mis instancias: cuadricula, lista o biblioteca (caratulas grandes), busqueda, orden, agrupado por loader,
// favoritas primero (estrella en cada tarjeta), filtros "Solo favoritas" y por etiqueta, contador de tareas
// pendientes, Comparar dos instancias, juego en curso, jugar rapido, menu de acciones e importacion de
// modpacks (botones o arrastrando el archivo).
import { h, icon, mount, emptyState, fmtAgo, fmtDuration, debounce, selectEl } from '../../ui.js';
import { store, api } from '../../store.js';
import { t, locale } from '../../i18n.js';
import { navigate } from '../../app.js';
import { sortInstances, groupByLoader, matchesInstance, INSTANCE_SORTS, favoritesFirst, filterByMeta, collectTags, isFavorite } from './catalog.js';
import {
  loaderMeta,
  instanceBadge,
  instIcon,
  iconButton,
  viewPrefs,
  saveViewPrefs,
  VIEW_MODES,
  popMenu,
  instanceMenuItems,
  importMenuItems,
  playInstance,
  dropZone,
  handlePackDrop,
  keepFocus,
} from './common.js';
import { listFilters, favoriteButton, tagChips, pendingBadge, coverEl } from './meta.js';
import { openCompare } from './compare.js';

const VIEW_ICONS = { grid: 'grid', list: 'list', library: 'vsLibrary' };
let versionTimes = null; // id de version -> fecha (para ordenar por version)

function liveBadge(run) {
  if (!run) return null;
  const playing = run.state === 'running';
  return h('span', { class: ['vs-live', playing ? 'on' : 'starting'] }, h('i', { 'aria-hidden': 'true' }), playing ? t('versions.playing') : t('versions.starting'));
}

function lastPlayedLabel(inst) {
  return inst.lastPlayed ? t('versions.lastPlayed', { ago: fmtAgo(inst.lastPlayed) }) : t('versions.neverPlayed');
}

// Jugar (tonal: la accion principal de la vista es "Nueva instancia"), instalando con porcentaje o Detener.
function playButton(inst, { compact = false } = {}) {
  const run = store.running[inst.id];
  const task = store.taskFor(inst.id);
  if (run?.state === 'running') {
    return h(
      'button',
      {
        class: 'btn sm danger',
        type: 'button',
        title: t('versions.stop'),
        'aria-label': compact ? t('versions.stop') : null,
        dataset: { fk: `play:${inst.id}` },
        onclick: (e) => (e.stopPropagation(), api.instances.stop(inst.id)),
      },
      icon('stop'),
      compact ? null : t('versions.stop'),
    );
  }
  const busy = Boolean(run || task);
  const pct = task?.progress != null ? Math.round(task.progress * 100) : null;
  const label = task ? (pct != null ? t('versions.installingPct', { pct }) : t('versions.installing')) : run ? t('versions.starting') : t('versions.play');
  return h(
    'button',
    {
      class: ['btn sm tonal vs-play', busy && 'loading'],
      type: 'button',
      disabled: busy,
      'aria-busy': busy ? 'true' : null,
      title: busy ? label : t('versions.playName', { name: inst.name }),
      'aria-label': busy ? label : t('versions.playName', { name: inst.name }),
      dataset: { fk: `play:${inst.id}` },
      onclick: (e) => (e.stopPropagation(), playInstance(inst)),
    },
    icon('play'),
    compact ? null : h('span', { class: 'num' }, label),
  );
}

function openOnKey(e, inst) {
  if (e.target !== e.currentTarget) return;
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    navigate(`instance/${encodeURIComponent(inst.id)}`);
  }
}

function moreButton(inst) {
  const btn = iconButton('more', t('versions.moreOptions', { name: inst.name }), (e) => {
    e.stopPropagation();
    popMenu(btn, instanceMenuItems(inst));
  });
  btn.setAttribute('aria-haspopup', 'menu');
  btn.dataset.fk = `more:${inst.id}`;
  return btn;
}

function progressBar(task) {
  if (!task) return null;
  return h('div', { class: 'ic-progress', 'aria-hidden': 'true' }, h('div', { class: ['progress', task.progress == null && 'indeterminate'] }, h('i', { style: { width: `${Math.round((task.progress || 0) * 100)}%` } })));
}

function notInstalledBadge(inst, task) {
  return !inst.installed && !task ? h('span', { class: 'badge warn' }, t('versions.notInstalled')) : null;
}

function card(inst, pickTag) {
  const run = store.running[inst.id];
  const task = store.taskFor(inst.id);
  const mc = t('versions.minecraftVersion', { version: inst.mcVersion });
  return h(
    'div',
    {
      class: ['inst-card', 'vs-card', run?.state === 'running' && 'running', inst.cover && 'has-cover'],
      tabindex: 0,
      role: 'link',
      'aria-label': inst.name,
      dataset: { fk: `open:${inst.id}` },
      onclick: () => navigate(`instance/${encodeURIComponent(inst.id)}`),
      onkeydown: (e) => openOnKey(e, inst),
    },
    inst.cover ? coverEl(inst, 'vs-card-cover') : null,
    h(
      'div',
      { class: 'ic-top' },
      instIcon(inst),
      h('div', { class: 'ellipsis spacer' }, h('div', { class: 'ic-name ellipsis', title: inst.name }, inst.name), h('div', { class: 'ic-sub', title: mc }, mc)),
      favoriteButton(inst),
      moreButton(inst),
    ),
    h('div', { class: 'row wrap vs-card-badges' }, instanceBadge(inst), notInstalledBadge(inst, task), pendingBadge(inst), liveBadge(run)),
    tagChips(inst, { max: 3, onPick: pickTag }),
    h(
      'div',
      { class: 'ic-foot' },
      h(
        'div',
        { class: 'small spacer vs-card-meta' },
        inst.playtime ? h('span', { class: 'num', title: t('versions.colPlaytime') }, icon('clock'), fmtDuration(inst.playtime, { short: true })) : null,
        h('span', { class: 'ellipsis', title: lastPlayedLabel(inst) }, lastPlayedLabel(inst)),
      ),
      playButton(inst),
    ),
    progressBar(task),
  );
}

function row(inst, pickTag) {
  const run = store.running[inst.id];
  const task = store.taskFor(inst.id);
  return h(
    'div',
    {
      class: ['vs-row', run?.state === 'running' && 'running'],
      tabindex: 0,
      role: 'link',
      'aria-label': inst.name,
      dataset: { fk: `open:${inst.id}` },
      onclick: () => navigate(`instance/${encodeURIComponent(inst.id)}`),
      onkeydown: (e) => openOnKey(e, inst),
    },
    instIcon(inst, 'vs-row-icon'),
    h(
      'div',
      { class: 'vs-row-main' },
      h('div', { class: 'vs-row-name' }, h('span', { class: 'ellipsis', title: inst.name }, inst.name), pendingBadge(inst), liveBadge(run)),
      h('div', { class: 'vs-row-sub' }, h('span', { class: 'ellipsis' }, t('versions.minecraftVersion', { version: inst.mcVersion })), notInstalledBadge(inst, task), tagChips(inst, { max: 2, onPick: pickTag })),
    ),
    h('div', { class: 'vs-row-loader' }, instanceBadge(inst)),
    h('div', { class: ['vs-row-time', !inst.playtime && 'none'] }, inst.playtime ? fmtDuration(inst.playtime, { short: true }) : '—'),
    h('div', { class: ['vs-row-last', !inst.lastPlayed && 'none'], title: inst.lastPlayed ? lastPlayedLabel(inst) : null }, inst.lastPlayed ? fmtAgo(inst.lastPlayed) : t('versions.neverShort')),
    h('div', { class: 'vs-row-actions' }, favoriteButton(inst), playButton(inst, { compact: true }), moreButton(inst)),
    progressBar(task),
  );
}

// Biblioteca: caratula grande con nombre, loader y version encima; Jugar aparece al pasar el mouse (o con el foco).
function libCard(inst, pickTag) {
  const run = store.running[inst.id];
  const task = store.taskFor(inst.id);
  const mc = t('versions.minecraftVersion', { version: inst.mcVersion });
  return h(
    'div',
    {
      class: ['vs-lib-card', run?.state === 'running' && 'running', isFavorite(inst) && 'fav', (run || task) && 'busy'],
      tabindex: 0,
      role: 'link',
      'aria-label': inst.name,
      dataset: { fk: `open:${inst.id}` },
      onclick: () => navigate(`instance/${encodeURIComponent(inst.id)}`),
      onkeydown: (e) => openOnKey(e, inst),
    },
    coverEl(inst, 'vs-lib-cover'),
    h('div', { class: 'vs-lib-top' }, liveBadge(run) || notInstalledBadge(inst, task), h('span', { class: 'spacer' }), pendingBadge(inst), favoriteButton(inst, { cls: 'vs-lib-btn' }), moreButton(inst)),
    h(
      'div',
      { class: 'vs-lib-info' },
      h('div', { class: 'vs-lib-name ellipsis', title: inst.name }, inst.name),
      h('div', { class: 'vs-lib-sub' }, instanceBadge(inst), h('span', { class: 'vs-lib-mc ellipsis', title: mc }, mc)),
      tagChips(inst, { max: 3, onPick: pickTag }),
    ),
    h('div', { class: 'vs-lib-play' }, playButton(inst)),
    progressBar(task),
  );
}

// Encabezado de columnas de la vista de lista (solo visual: cada fila ya se lee completa).
function listHead() {
  return h(
    'div',
    { class: 'vs-list-head', 'aria-hidden': 'true' },
    h('span'),
    h('span', {}, t('versions.colName')),
    h('span', {}, t('versions.colLoader')),
    h('span', {}, t('versions.colPlaytime')),
    h('span', { class: 'vs-col-last' }, t('versions.colLastPlayed')),
    h('span'),
  );
}

export function instancesView(container) {
  const prefs = viewPrefs();
  const state = { query: '', view: prefs.view, sort: prefs.sort, group: prefs.group };
  const results = h('div', { class: 'vs-results' });
  const summary = h('div', { class: 'vs-summary small muted', 'aria-live': 'polite' });

  const search = h('input', { class: 'input', type: 'search', placeholder: t('versions.searchInstancesShort'), title: t('versions.searchInstances'), 'aria-label': t('versions.searchInstances'), autocomplete: 'off', spellcheck: 'false' });
  search.addEventListener('input', debounce(() => ((state.query = search.value), draw()), 120));
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && search.value) {
      e.stopPropagation();
      search.value = '';
      state.query = '';
      draw();
    }
  });

  const sortSel = selectEl(
    INSTANCE_SORTS.map((s) => ({ value: s, label: t(`versions.sort_${s}`) })),
    state.sort,
    (v) => {
      state.sort = v;
      saveViewPrefs({ sort: v });
      draw();
    },
  );
  sortSel.setAttribute('aria-label', t('versions.sortBy'));
  sortSel.title = t('versions.sortBy');

  const groupBtn = h('button', { class: ['chip', state.group && 'active'], type: 'button', 'aria-pressed': String(state.group) }, icon('layers'), t('versions.groupByLoader'));
  groupBtn.addEventListener('click', () => {
    state.group = !state.group;
    groupBtn.classList.toggle('active', state.group);
    groupBtn.setAttribute('aria-pressed', String(state.group));
    saveViewPrefs({ group: state.group });
    draw();
  });

  // Filtros de la sesion (favoritas y etiqueta): viven en listFilters para volver igual desde la pagina de una instancia
  const favBtn = h('button', { class: ['chip', 'vs-favchip', listFilters.favorites && 'active'], type: 'button', 'aria-pressed': String(listFilters.favorites) }, icon('star'), t('versions.onlyFavorites'));
  favBtn.addEventListener('click', () => {
    listFilters.favorites = !listFilters.favorites;
    favBtn.classList.toggle('active', listFilters.favorites);
    favBtn.setAttribute('aria-pressed', String(listFilters.favorites));
    draw();
  });
  const tagBox = h('div', { class: 'vs-tagfilter', hidden: true });
  let tagSel = null;
  let tagKey = null;
  function drawTagFilter(all) {
    const tags = collectTags(all, locale());
    if (listFilters.tag && !tags.some((x) => x.tag.toLowerCase() === listFilters.tag.toLowerCase())) listFilters.tag = null;
    const key = tags.map((x) => `${x.tag}:${x.count}`).join('|');
    if (key !== tagKey) {
      tagKey = key;
      tagBox.hidden = !tags.length;
      tagSel = selectEl(
        [{ value: '', label: t('versions.allTags') }, ...tags.map((x) => ({ value: x.tag, label: t('versions.tagOption', { tag: x.tag, count: x.count }) }))],
        listFilters.tag || '',
        (v) => {
          listFilters.tag = v || null;
          draw();
        },
      );
      tagSel.setAttribute('aria-label', t('versions.tagFilter'));
      tagSel.title = t('versions.tagFilter');
      mount(tagBox, icon('tag'), tagSel);
    } else if (tagSel) tagSel.value = listFilters.tag || '';
    tagBox.classList.toggle('active', Boolean(listFilters.tag));
  }
  const pickTag = (tag) => {
    listFilters.tag = tag;
    draw();
  };
  function clearFilters() {
    listFilters.favorites = false;
    listFilters.tag = null;
    favBtn.classList.remove('active');
    favBtn.setAttribute('aria-pressed', 'false');
    draw();
  }

  const compareBtn = h('button', { class: 'btn vs-compare', type: 'button', onclick: () => openCompare(store.instances) }, icon('vsCompare'), t('versions.compare'));

  const viewBtns = VIEW_MODES.map((v) =>
    h(
      'button',
      {
        type: 'button',
        class: state.view === v ? 'active' : '',
        title: t(`versions.view_${v}`),
        'aria-label': t(`versions.view_${v}`),
        'aria-pressed': String(state.view === v),
        onclick: () => {
          state.view = v;
          viewBtns.forEach((b, i) => {
            const on = VIEW_MODES[i] === v;
            b.classList.toggle('active', on);
            b.setAttribute('aria-pressed', String(on));
          });
          saveViewPrefs({ view: v });
          draw();
        },
      },
      icon(VIEW_ICONS[v]),
    ),
  );

  const toolbar = h(
    'div',
    { class: 'vs-toolbar' },
    h('div', { class: 'input-icon vs-search' }, icon('search'), search),
    sortSel,
    groupBtn,
    favBtn,
    tagBox,
    h('span', { class: 'spacer' }),
    compareBtn,
    h('div', { class: 'segmented', role: 'group', 'aria-label': t('versions.viewMode') }, viewBtns),
  );

  function emptyAll() {
    const importBtn = h(
      'button',
      {
        class: 'btn',
        type: 'button',
        'aria-haspopup': 'menu',
        onclick: (e) => popMenu(e.currentTarget, importMenuItems()),
      },
      icon('download'),
      t('versions.import'),
      icon('chevronDown'),
    );
    return h(
      'div',
      { class: 'card vs-empty' },
      emptyState(
        'layers',
        t('versions.emptyTitle'),
        t('versions.emptyText'),
        h('div', { class: 'row wrap vs-empty-actions' }, h('button', { class: 'btn primary', type: 'button', onclick: () => navigate('versions/new') }, icon('plus'), t('versions.newInstance')), importBtn),
      ),
      h('div', { class: 'vs-empty-drop small muted' }, icon('upload'), t('versions.dropHintEmpty')),
    );
  }

  function block(items) {
    if (state.view === 'list') return h('div', { class: 'vs-list card flat' }, state.group ? null : listHead(), items.map((i) => row(i, pickTag)));
    if (state.view === 'library') return h('div', { class: 'vs-lib' }, items.map((i) => libCard(i, pickTag)));
    return h('div', { class: 'grid vs-grid' }, items.map((i) => card(i, pickTag)));
  }

  function clearSearch() {
    search.value = '';
    state.query = '';
    draw();
    search.focus();
  }

  // Se redibuja con cada progreso de instalacion: el foco del teclado se conserva.
  const draw = () => keepFocus(results, drawResults);

  let summaryKey = null;
  function drawSummary(all) {
    const runningCount = Object.values(store.running).filter((r) => r.state === 'running').length;
    const totalTime = all.reduce((a, i) => a + (i.playtime || 0), 0);
    const favCount = all.filter(isFavorite).length;
    const parts = all.length
      ? [
          t('versions.instancesCount', { count: all.length }),
          totalTime ? t('versions.totalPlaytime', { time: fmtDuration(totalTime, { short: true }) }) : null,
          runningCount ? t('versions.runningCount', { count: runningCount }) : null,
          favCount ? t('versions.favoritesCount', { count: favCount }) : null,
        ]
      : [];
    // Solo se reescribe si cambia (es una region viva: no se repite en cada progreso de instalacion)
    const key = parts.join('|');
    if (key === summaryKey) return;
    summaryKey = key;
    mount(summary, parts.map((text, i) => (text ? h('span', { class: i === 2 ? 'vs-summary-live' : null }, text) : null)));
  }

  function drawResults() {
    const all = store.instances;
    drawSummary(all);
    toolbar.classList.toggle('hidden', !all.length);
    summary.classList.toggle('hidden', !all.length);
    if (!all.length) {
      mount(results, emptyAll());
      return;
    }
    drawTagFilter(all);
    compareBtn.disabled = all.length < 2;
    compareBtn.title = all.length < 2 ? t('versions.compareHint') : t('versions.compareTitle');
    const byQuery = all.filter((i) => matchesInstance(i, state.query));
    const filtered = filterByMeta(byQuery, listFilters);
    if (!filtered.length) {
      const onlyFilters = byQuery.length > 0;
      mount(
        results,
        h(
          'div',
          { class: 'card flat' },
          emptyState(
            onlyFilters ? 'star' : 'search',
            onlyFilters ? t('versions.noFilterMatchTitle') : t('versions.noMatchTitle'),
            onlyFilters ? t('versions.noFilterMatchText') : t('versions.noMatchText', { query: state.query.trim() }),
            h(
              'div',
              { class: 'row wrap vs-empty-actions' },
              state.query ? h('button', { class: 'btn sm', type: 'button', onclick: clearSearch }, icon('x'), t('versions.clearSearch')) : null,
              listFilters.favorites || listFilters.tag ? h('button', { class: 'btn sm', type: 'button', onclick: clearFilters }, icon('x'), t('versions.clearFilters')) : null,
            ),
          ),
        ),
      );
      return;
    }
    const sorted = favoritesFirst(sortInstances(filtered, state.sort, { timeMap: versionTimes, locale: locale() }));
    if (!state.group) {
      mount(results, block(sorted));
      return;
    }
    mount(
      results,
      groupByLoader(sorted).map(({ loader, items }) => {
        const meta = loaderMeta(loader);
        return h(
          'section',
          { class: 'vs-group', 'aria-label': meta.name },
          h(
            'div',
            { class: 'vs-group-head', style: { '--c': meta.color } },
            h('span', { class: 'vs-group-tile', 'aria-hidden': 'true' }, meta.letter),
            h('h2', { class: 'vs-group-name' }, meta.name),
            h('span', { class: 'vs-group-count', title: t('versions.instancesCount', { count: items.length }) }, String(items.length)),
            h('span', { class: 'st-line', 'aria-hidden': 'true' }),
          ),
          block(items),
        );
      }),
    );
  }

  mount(container, h('div', { class: 'vs-mine' }, toolbar, summary, results));
  draw();

  // Fechas de las versiones para ordenar por version (el manifest queda en cache en el proceso principal).
  if (!versionTimes) {
    api.versions
      .manifest(false)
      .then((m) => {
        versionTimes = new Map((m?.versions || []).map((v) => [v.id, Date.parse(v.releaseTime) || 0]));
        if (state.sort === 'version' && container.isConnected) draw();
      })
      .catch(() => {});
  }

  let lastTask = 0;
  const offs = [
    store.on('instances', draw),
    store.on('running', draw),
    store.on('task', (task) => {
      if (!task.meta?.instanceId) return;
      if (task.state !== 'running' || Date.now() - lastTask > 400) {
        lastTask = Date.now();
        draw();
      }
    }),
    dropZone(container.closest('.page') || container, {
      label: t('versions.dropTitle'),
      hint: t('versions.dropHint'),
      onFiles: handlePackDrop,
    }),
  ];
  return () => offs.forEach((off) => off());
}
