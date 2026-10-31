// Ficha de un mundo (#/worlds/<instancia>/<carpeta>): encabezado con acciones, resumen, linea de tiempo,
// capturas y clips, estadisticas del juego y datos con copias de seguridad.
import { h, icon, mount, emptyState, fail, copyText, fmtBytes, fmtDate, fmtAgo, debounce, hideTip, setBusy } from '../../ui.js';
import { store, api } from '../../store.js';
import { t } from '../../i18n.js';
import { navigate } from '../../app.js';
import {
  prefs,
  savePrefs,
  modeBadge,
  difficultyLabel,
  worldTypeLabel,
  shortDur,
  fmtInt,
  worldIcon,
  instanceDot,
  playWorld,
  openMap,
  backupWorld,
  runFeature,
  iconBtn,
  isRunning,
  closeMenu,
  errorBox,
  bone,
  skelGroup,
  DATE_TIME,
  DATE_LONG,
} from './common.js';
import { timelineView, timelineSummary, timelineSkeleton } from './timeline.js';
import { mediaGrid, mediaSkeleton, openLightbox, closeLightbox } from './media.js';
import { statsView } from './stats.js';
import { openCopyDialog, renameWorld, deleteWorld, backupsPanel } from './dialogs.js';

const TABS = [
  { id: 'history', icon: 'history' },
  { id: 'media', icon: 'camera' },
  { id: 'stats', icon: 'chart' },
  { id: 'data', icon: 'database' },
];

// Forma de la ficha mientras se lee el mundo
export function detailSkeleton() {
  return skelGroup(
    t('worlds.loadingWorld'),
    h(
      'div',
      { class: 'wo-skel-hero' },
      bone('wo-skel-icon'),
      h('div', { class: 'wo-skel-hero-main' }, bone('skeleton-line wo-skel-w30'), bone('skeleton-line title'), h('div', { class: 'row' }, bone('wo-skel-chip'), bone('wo-skel-chip')), h('div', { class: 'wo-skel-actions' }, bone('wo-skel-btn'), bone('wo-skel-btn'), bone('wo-skel-btn'))),
    ),
    h('div', { class: 'wo-skel-kpis' }, bone(), bone(), bone(), bone()),
    bone('wo-skel-tabs'),
  );
}

export function renderDetail(root, instanceId, folder) {
  let alive = true;
  let w = null;
  let tl = null;
  let tlError = null;
  let sharedMap = {};
  let tab = 'history';
  let order = prefs().order;
  let backups = null;
  const offs = [];

  const back = h('a', { class: 'back-link', href: '#/worlds', onclick: (e) => (e.preventDefault(), navigate('worlds')) }, icon('chevronLeft'), t('worlds.backToWorlds'));
  const heroHost = h('div');
  const kpiHost = h('div', { class: 'wo-kpis' });
  const tabBar = h('div', { class: 'tabs wo-tabs', role: 'tablist', 'aria-label': t('worlds.detailTabsLabel') });
  const panel = h('div', { class: 'wo-panel', role: 'tabpanel', id: 'wo-detail-panel' });
  mount(root, h('div', { class: 'wo-root wo-detail' }, back, detailSkeleton()));

  // ---------- Encabezado ----------
  function drawHero() {
    const inst = store.instances.find((i) => i.id === w.instanceId);
    const running = isRunning(w.instanceId);
    const badges = [
      modeBadge(w),
      w.difficulty && !w.hardcore ? h('span', { class: 'badge', title: w.difficultyLocked ? t('worlds.difficultyLocked') : null }, icon(w.difficultyLocked ? 'lock' : 'gauge'), difficultyLabel(w.difficulty)) : null,
      w.cheats ? h('span', { class: 'badge', title: t('worlds.cheatsHint') }, icon('wand'), t('worlds.cheats')) : null,
      w.worldType && w.worldType !== 'default' ? h('span', { class: 'badge' }, icon('mountain'), worldTypeLabel(w.worldType)) : null,
      w.days ? h('span', { class: 'badge', title: t('worlds.daysHint') }, icon('woSun'), t('worlds.daysCount', { count: w.days })) : null,
      w.playing ? h('span', { class: 'badge good wo-live-badge' }, h('i', { class: 'wo-pulse' }), t('worlds.playingNow')) : null,
      w.damaged ? h('span', { class: 'badge warn' }, icon('alert'), t('worlds.damaged')) : null,
    ];
    const play = h(
      'button',
      { class: 'btn primary wo-hero-play', type: 'button', disabled: running, title: running ? t('worlds.alreadyRunningShort') : null, onclick: () => playWorld(w) },
      icon('play'),
      w.playing ? t('worlds.inGame') : running ? t('worlds.instanceRunning') : t('worlds.play'),
    );
    // Respaldar y Copiar tienen nombre propio: en ventanas angostas quedan como iconos
    const backupBtn = h('button', { class: 'btn wo-collapse', type: 'button', title: t('worlds.backupNow'), 'aria-label': t('worlds.backup'), dataset: { act: 'backup' } }, icon('archive'), h('span', { class: 'wo-btn-label' }, t('worlds.backup')));
    backupBtn.addEventListener('click', async () => {
      const done = setBusy(backupBtn);
      try {
        if (await backupWorld(w)) backups?.reload();
      } finally {
        done();
      }
    });
    mount(
      heroHost,
      h(
        'section',
        { class: ['wo-hero', w.playing && 'playing'], 'aria-labelledby': 'wo-hero-title' },
        h('div', { class: 'wo-hero-art', 'aria-hidden': 'true' }, w.icon ? h('img', { class: 'wo-hero-bg', src: w.icon, alt: '' }) : null),
        worldIcon(w, 'wo-hero-icon'),
        h(
          'div',
          { class: 'wo-hero-main' },
          h(
            'div',
            { class: 'wo-hero-kicker' },
            instanceDot(inst || { name: w.instanceName }, w.instanceLoader),
            h('a', { class: 'wo-hero-inst ellipsis', href: `#/instance/${encodeURIComponent(w.instanceId)}`, title: t('worlds.goToInstance') }, w.instanceName),
            h('span', { class: 'wo-dot-sep', 'aria-hidden': 'true' }, '·'),
            h('span', {}, w.version ? t('worlds.minecraftVersion', { version: w.version }) : t('worlds.unknownVersion')),
            w.folder !== w.name ? h('span', { class: 'wo-dot-sep', 'aria-hidden': 'true' }, '·') : null,
            w.folder !== w.name ? h('span', { class: 'wo-hero-folder', title: `${t('worlds.folderLabel')}: ${w.folder}` }, icon('folder'), h('span', { class: 'ellipsis' }, w.folder)) : null,
          ),
          h('h1', { class: 'page-title wo-hero-title', id: 'wo-hero-title', title: w.name }, w.name),
          h('div', { class: 'wo-hero-badges' }, badges),
          h(
            'div',
            { class: 'wo-hero-actions' },
            play,
            h('button', { class: 'btn', type: 'button', dataset: { act: 'map' }, onclick: () => openMap(w) }, icon('map'), t('worlds.map')),
            backupBtn,
            h('button', { class: 'btn wo-collapse', type: 'button', title: t('worlds.copyTo'), 'aria-label': t('worlds.copyTo'), dataset: { act: 'copy' }, onclick: () => openCopyDialog(w, { onDone: () => refreshWorld() }) }, icon('copy'), h('span', { class: 'wo-btn-label' }, t('worlds.copyTo'))),
            h(
              'div',
              { class: 'wo-hero-tools', role: 'group', 'aria-label': t('worlds.moreTools') },
              iconBtn('history', t('worlds.snapshot'), () => runFeature('snapshots', 'openSnapshots', w.instanceId)),
              iconBtn('cloud', t('worlds.cloud'), () => runFeature('cloudsync', 'openCloudSync', w.instanceId)),
              iconBtn('edit', t('worlds.rename'), async () => (await renameWorld(w)) && refreshWorld()),
              iconBtn('folderOpen', t('worlds.openFolder'), () => api.invoke('worlds:openFolder', w.instanceId, w.folder).catch((err) => fail(t('worlds.openFailed'), err))),
              h('span', { class: 'wo-tools-sep', 'aria-hidden': 'true' }),
              iconBtn(
                'trash',
                t('worlds.moveToTrash'),
                async () => {
                  if (await deleteWorld(w)) navigate('worlds');
                },
                'danger',
              ),
            ),
          ),
        ),
      ),
    );
  }

  function kpi(ic, label, value, foot, extra) {
    // Mientras se lee la historia, el valor y el pie son lineas de carga
    const loadingValue = value === null;
    return h(
      'div',
      { class: 'card kpi wo-kpi', 'aria-busy': loadingValue ? 'true' : null },
      h('div', { class: 'kpi-label' }, icon(ic), label),
      loadingValue ? bone('wo-kpi-skel') : h('div', { class: 'kpi-value' }, value),
      extra || null,
      loadingValue ? bone('wo-kpi-skel foot') : foot ? h('div', { class: 'kpi-foot', title: typeof foot === 'string' ? foot : null }, foot) : null,
    );
  }

  function drawKpis() {
    const tot = tl?.totals;
    const adv = tl?.advancements;
    const pending = !tl && !tlError; // todavia leyendo la historia
    const pct = adv?.total ? Math.min(100, Math.round((adv.done / adv.total) * 100)) : null;
    const mediaFoot = tot ? (tot.screenshots + tot.clips ? [tot.screenshots ? t('worlds.shotsCount', { count: tot.screenshots }) : null, tot.clips ? t('worlds.clipsCount', { count: tot.clips }) : null].filter(Boolean).join(' · ') : t('worlds.kpiNoMedia')) : null;
    mount(
      kpiHost,
      kpi('woHourglass', t('worlds.kpiPlaytime'), shortDur(w.playtime), tot?.trackedMs ? t('worlds.kpiTracked', { time: shortDur(tot.trackedMs) }) : t('worlds.kpiPlaytimeFoot')),
      kpi('gamepad', t('worlds.kpiSessions'), pending ? null : tot ? fmtInt(tot.sessions) : '—', tot?.sessions ? t('worlds.kpiSessionsFoot', { count: tot.days }) : t('worlds.kpiNoSessions')),
      kpi('camera', t('worlds.kpiMedia'), pending ? null : tot ? fmtInt(tot.screenshots + tot.clips) : '—', mediaFoot),
      kpi(
        'trophy',
        t('worlds.kpiAdvancements'),
        pending ? null : adv ? (adv.total ? t('worlds.fraction', { done: fmtInt(adv.done), total: fmtInt(adv.total) }) : fmtInt(adv.done)) : '—',
        pct !== null ? t('worlds.percentDone', { value: pct }) : adv?.modsDone ? t('worlds.modAdvancements', { count: adv.modsDone }) : null,
        pct !== null ? h('div', { class: 'progress wo-kpi-bar', 'aria-hidden': 'true' }, h('i', { style: { width: `${pct}%` } })) : null,
      ),
    );
  }

  // ---------- Pestanas ----------
  function drawTabs() {
    const mediaCount = tl ? tl.totals.screenshots + tl.totals.clips : null;
    mount(
      tabBar,
      TABS.map((x) =>
        h(
          'button',
          {
            type: 'button',
            id: `wo-dtab-${x.id}`,
            class: ['tab', tab === x.id && 'active'],
            role: 'tab',
            'aria-selected': String(tab === x.id),
            'aria-controls': 'wo-detail-panel',
            tabindex: tab === x.id ? '0' : '-1',
            onclick: () => select(x.id),
            onkeydown: (e) => {
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
              e.preventDefault();
              const i = TABS.findIndex((y) => y.id === tab);
              select(TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length].id);
              tabBar.querySelector('.tab.active')?.focus();
            },
          },
          icon(x.icon),
          t(`worlds.tab_${x.id}`),
          x.id === 'media' && mediaCount ? h('span', { class: 'count' }, String(mediaCount)) : null,
        ),
      ),
    );
    panel.setAttribute('aria-labelledby', `wo-dtab-${tab}`);
  }

  function select(id) {
    if (id === tab) return;
    tab = id;
    hideTip();
    closeMenu();
    drawTabs();
    drawPanel();
  }

  function openMedia(list, index) {
    openLightbox(list, index, {
      onDeleted: () => refreshTimeline(),
      onShared: async () => {
        sharedMap = (await api.invoke('worlds:shared').catch(() => ({}))) || {};
        if (alive && (tab === 'media' || tab === 'history')) drawPanel();
      },
    });
  }

  // Boton Jugar de los estados vacios (secundario: el primario de la vista es el del encabezado)
  function playButton() {
    return h('button', { class: 'btn', type: 'button', disabled: isRunning(w.instanceId), onclick: () => playWorld(w) }, icon('play'), t('worlds.playNow'));
  }

  function drawPanel() {
    if (tab === 'history') {
      if (tlError) return mount(panel, errorBox(tlError, () => refreshTimeline(true)));
      if (!tl) return mount(panel, timelineSkeleton(t('worlds.loadingHistory')));
      const seg = (id, label) =>
        h(
          'button',
          {
            type: 'button',
            class: order === id ? 'active' : '',
            'aria-pressed': String(order === id),
            onclick: () => {
              order = id;
              savePrefs({ order: id });
              drawPanel();
            },
          },
          label,
        );
      const empty = h('div', { class: 'card flat' }, emptyState('history', t('worlds.noHistory'), t('worlds.noHistoryText'), playButton()));
      mount(
        panel,
        h(
          'div',
          { class: 'stack' },
          tl.days.length
            ? h(
                'div',
                { class: 'wo-tl-toolbar' },
                h('div', { class: 'segmented', role: 'group', 'aria-label': t('worlds.orderLabel') }, seg('desc', t('worlds.orderNewest')), seg('asc', t('worlds.orderOldest'))),
                h(
                  'div',
                  { class: 'wo-legend', 'aria-hidden': 'true' },
                  h('span', {}, h('i', { class: 'wo-lg tracked' }), t('worlds.legendTracked')),
                  h('span', {}, h('i', { class: 'wo-lg inferred' }), t('worlds.legendEstimated')),
                ),
              )
            : null,
          tl.days.length ? timelineSummary(tl.totals) : null,
          timelineView(tl, { order, onOpenMedia: openMedia, sharedMap, empty }),
        ),
      );
      return undefined;
    }
    if (tab === 'media') {
      if (tlError) return mount(panel, errorBox(tlError, () => refreshTimeline(true)));
      if (!tl) return mount(panel, mediaSkeleton(4));
      const items = tl.days.flatMap((d) => d.sessions.flatMap((s) => s.media)).sort((a, b) => b.time - a.time);
      mount(
        panel,
        h(
          'div',
          { class: 'stack' },
          items.some((i) => i.how === 'guess') ? h('p', { class: 'wo-media-hint' }, icon('info'), h('span', {}, t('worlds.guessNote'))) : null,
          mediaGrid(items, { sharedMap, onOpen: (i) => openMedia(items, i), emptyTitle: t('worlds.noWorldMedia'), emptyText: t('worlds.noWorldMediaText'), emptyAction: playButton() }),
        ),
      );
      return undefined;
    }
    if (tab === 'stats') {
      const host = h('div');
      mount(panel, host);
      statsView(host, w, { isAlive: () => alive && tab === 'stats', fallbackAdvancements: () => tl?.advancements || null, emptyAction: playButton });
      return undefined;
    }
    backups = backupsPanel(w, { isAlive: () => alive && tab === 'data', onRestored: (res, mode) => mode === 'replace' && refreshAll() });
    mount(panel, h('div', { class: 'wo-data' }, infoCard(), backups.el));
    return undefined;
  }

  function infoCard() {
    const row = (k, v, extra) => h('div', { class: 'wo-kv' }, h('dt', {}, k), h('dd', {}, v ?? '—', extra || null));
    const created = w.created?.at ? h('span', { title: t(`worlds.createdSource_${w.created.source || 'folder'}`) }, fmtDate(w.created.at, DATE_LONG)) : null;
    return h(
      'section',
      { class: 'card wo-card-pad' },
      h('h3', { class: 'card-title' }, icon('info'), t('worlds.infoTitle')),
      h(
        'dl',
        { class: 'wo-kvs' },
        row(t('worlds.infoName'), w.name),
        row(t('worlds.infoFolder'), h('span', { class: 'selectable wrap-anywhere' }, w.folder)),
        row(t('worlds.infoInstance'), w.instanceName),
        row(t('worlds.infoVersion'), w.version ? `${w.version}${w.snapshot ? ` (${t('worlds.snapshotVersion')})` : ''}` : null),
        row(t('worlds.infoMode'), modeBadge(w) || t('worlds.unknown')),
        row(t('worlds.infoDifficulty'), w.difficulty ? `${difficultyLabel(w.difficulty)}${w.difficultyLocked ? ` · ${t('worlds.locked')}` : ''}` : null),
        row(t('worlds.infoType'), worldTypeLabel(w.worldType)),
        row(
          t('worlds.infoSeed'),
          w.seed ? h('code', { class: 'wo-seed selectable', title: w.seed }, w.seed) : null,
          w.seed ? iconBtn('copy', t('worlds.copySeed'), () => copyText(w.seed, t('worlds.seedCopied'))) : null,
        ),
        row(t('worlds.infoCheats'), w.cheats ? t('worlds.yes') : t('worlds.no')),
        row(t('worlds.infoDays'), w.days ? fmtInt(w.days) : '0'),
        row(t('worlds.infoSize'), w.size ? fmtBytes(w.size) : null),
        row(t('worlds.infoDatapacks'), fmtInt(w.datapacks || 0)),
        row(t('worlds.infoPlayers'), fmtInt(w.players || 0)),
        row(t('worlds.infoCreated'), created),
        row(t('worlds.infoLastPlayed'), w.lastPlayed ? h('span', { title: fmtDate(w.lastPlayed, DATE_TIME) }, fmtAgo(w.lastPlayed)) : null),
      ),
    );
  }

  // ---------- Carga ----------
  async function refreshWorld() {
    try {
      const next = await api.invoke('worlds:get', instanceId, folder);
      if (!alive) return;
      w = next;
      drawHero();
      drawKpis();
      if (tab === 'data') drawPanel();
    } catch (err) {
      if (alive) showGone(err);
    }
  }

  // reset: vuelve a mostrar la carga (al reintentar despues de un error)
  async function refreshTimeline(reset = false) {
    if (reset) {
      tl = null;
      tlError = null;
      drawKpis();
      if (tab === 'history' || tab === 'media') drawPanel();
    }
    try {
      const next = await api.invoke('worlds:timeline', instanceId, folder);
      if (!alive) return;
      tl = next;
      tlError = null;
    } catch (err) {
      if (!alive) return;
      tlError = err;
    }
    drawKpis();
    drawTabs();
    if (tab === 'history' || tab === 'media') drawPanel();
  }

  function refreshAll() {
    refreshWorld();
    refreshTimeline();
  }

  function showGone(err) {
    closeLightbox();
    mount(
      root,
      h(
        'div',
        { class: 'wo-root wo-detail' },
        back,
        h('div', { class: 'card flat' }, emptyState('globe', t('worlds.worldGone'), err?.message || t('worlds.worldGoneText'), h('button', { class: 'btn primary', type: 'button', onclick: () => navigate('worlds') }, icon('arrowLeft'), t('worlds.backToWorlds')))),
      ),
    );
  }

  (async () => {
    try {
      const [world, shared] = await Promise.all([api.invoke('worlds:get', instanceId, folder), api.invoke('worlds:shared').catch(() => ({}))]);
      if (!alive) return;
      w = world;
      sharedMap = shared || {};
    } catch (err) {
      if (alive) showGone(err);
      return;
    }
    mount(root, h('div', { class: 'wo-root wo-detail' }, back, heroHost, kpiHost, tabBar, panel));
    drawHero();
    drawKpis();
    drawTabs();
    drawPanel();
    refreshTimeline();
  })();

  // ---------- Eventos ----------
  const softTimeline = debounce(() => alive && refreshTimeline(), 600);
  const softWorld = debounce(() => alive && refreshWorld(), 400);
  offs.push(
    api.on('worlds:updated', (e) => {
      if (!alive || !w) return;
      const mine = e?.instanceId === instanceId && (!e.world || e.world === folder);
      if (e?.kind === 'timeline' && mine) {
        softWorld();
        softTimeline();
      } else if (e?.kind === 'list' && mine) {
        if (e.removed) showGone(null);
        else softWorld();
      } else if (e?.kind === 'media' && e.instanceId === instanceId) softTimeline();
      else if (e?.kind === 'backups' && tab === 'data') backups?.reload();
      else if (e?.kind === 'sizes') {
        const it = (e.items || []).find((x) => x.instanceId === instanceId && x.folder === folder);
        if (it) w.size = it.size;
      }
    }),
  );
  offs.push(api.on('game:activity', (id) => id === instanceId && softWorld()));
  offs.push(store.on('running', () => alive && w && drawHero()));

  // Partida en curso: la duracion se actualiza sola
  const timer = setInterval(() => {
    if (alive && w?.playing && (tab === 'history' || tab === 'media')) refreshTimeline();
  }, 60000);

  return () => {
    alive = false;
    clearInterval(timer);
    closeLightbox();
    closeMenu();
    hideTip();
    offs.forEach((o) => o());
  };
}
