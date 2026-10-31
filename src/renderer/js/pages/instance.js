// Instancia: el centro de cada instalacion. Resumen y herramientas, contenido (mods, resource packs,
// shaders, data packs por mundo), mundos, capturas, registros y ajustes.
// Rutas: #/instance/<id>[/<pestania>[/<extra>]]. Pestanias: overview, mods, resourcepacks, shaderpacks,
// datapacks[/<mundo>], worlds, screenshots, logs[/files], settings ("saves" y "console" siguen funcionando).
import { h, icon, mount, emptyState, fmtAgo, fmtDuration } from '../ui.js';
import { store, api } from '../store.js';
import { t } from '../i18n.js';
import { navigate } from '../app.js';
import { instIcon, instanceBadge, iconButton, popMenu, closeMenu, instanceMenuItems, feature, openFolder, playInstance, supportsMods, guardDrops, keepFocus } from './versions/common.js';
import { overviewTab, getOverview, invalidateOverview } from './instance/overview.js';
import { contentHub, CONTENT_KINDS } from './instance/content.js';
import { worldsTab } from './instance/worlds.js';
import { screenshotsTab } from './instance/screenshots.js';
import { logsTab } from './instance/logs.js';
import { settingsTab } from './instance/settings.js';

const TABS = [
  { id: 'overview', icon: 'vsDashboard' },
  { id: 'content', icon: 'package', count: (c) => (c.mods || 0) + (c.resourcepacks || 0) + (c.shaderpacks || 0) },
  { id: 'worlds', icon: 'globe', count: (c) => c.worlds },
  { id: 'screenshots', icon: 'image', count: (c) => c.screenshots },
  { id: 'logs', icon: 'terminal' },
  { id: 'settings', icon: 'sliders' },
];
const ALIASES = { saves: 'worlds', console: 'logs' };

function activityText(act) {
  if (!act) return null;
  if (act.type === 'singleplayer') return act.world ? t('instance.activityWorld', { world: act.world }) : t('instance.activitySingle');
  if (act.type === 'server') return t('instance.activityServer', { address: act.address });
  if (act.type === 'menu') return t('instance.activityMenu');
  return null;
}

// Traduce la pestania de la ruta: los tipos de contenido van a "content".
function parseTab(raw, inst) {
  const tab = ALIASES[raw] || raw;
  if (CONTENT_KINDS.includes(tab)) return { tab: 'content', kind: tab };
  if (tab === 'content') return { tab: 'content', kind: supportsMods(inst) ? 'mods' : 'resourcepacks' };
  return { tab: TABS.some((x) => x.id === tab) ? tab : 'overview', kind: null };
}

// Forma de la cabecera mientras se lee la instancia (solo si tarda: evita un parpadeo en lecturas rapidas).
function headSkeleton() {
  return h(
    'div',
    { class: 'skeleton-group', role: 'status', 'aria-live': 'polite', 'aria-busy': 'true' },
    h('span', { class: 'sr-only' }, t('common.loading')),
    h(
      'div',
      { class: 'skeleton-shapes ih-skel', 'aria-hidden': 'true' },
      h('span', { class: 'skeleton skeleton-line ih-skel-back' }),
      h('div', { class: 'ih-skel-head' }, h('span', { class: 'skeleton ih-skel-icon' }), h('div', { class: 'skeleton-lines' }, h('span', { class: 'skeleton skeleton-line title' }), h('span', { class: 'skeleton skeleton-line' }))),
      h('span', { class: 'skeleton ih-skel-tabs' }),
      h('div', { class: 'ih-skel-kpis' }, Array.from({ length: 4 }, () => h('span', { class: 'skeleton' }))),
    ),
  );
}

export default {
  ns: ['instance', 'versions'],
  css: ['pages/versions', 'pages/instance'],
  async render(root, params) {
    const [id, rawTab = 'overview', ...rest] = params;
    let inst;
    const skelTimer = setTimeout(() => mount(root, headSkeleton()), 250);
    try {
      inst = await api.instances.get(id);
    } catch {
      clearTimeout(skelTimer);
      mount(
        root,
        h(
          'div',
          { class: 'ih-missing' },
          h('button', { class: 'back-link', type: 'button', onclick: () => navigate('versions') }, icon('chevronLeft'), t('instance.backToVersions')),
          h(
            'div',
            { class: 'card flat' },
            emptyState('alert', t('instance.notFound'), t('instance.notFoundText'), h('button', { class: 'btn primary', type: 'button', onclick: () => navigate('versions') }, icon('layers'), t('instance.goToVersions'))),
          ),
        ),
      );
      return undefined;
    }
    clearTimeout(skelTimer);

    const first = parseTab(rawTab, inst);
    const state = { tab: first.tab, kind: first.kind, sub: rest, counts: null, activity: null, gone: false };
    const headBox = h('div', { class: 'ih-headbox' });
    const tabsBar = h('div', { class: 'tabs ih-tabs', role: 'tablist', 'aria-label': t('instance.sections') });
    const body = h('div', { class: 'ih-body', role: 'tabpanel', id: 'ih-panel' });
    const groupSlot = h('span', { class: 'ih-group-slot' });
    const countListeners = new Set();
    let tabCleanup = null;

    // Insignia de grupo compartido (modulo share): opcional.
    const fillGroup = async () => {
      try {
        const mod = await feature('share');
        const el = typeof mod.groupBadge === 'function' ? mod.groupBadge(inst) : null;
        mount(groupSlot, el instanceof Node ? el : null);
      } catch {
        mount(groupSlot);
      }
    };

    const ctx = {
      get inst() {
        return inst;
      },
      get counts() {
        return state.counts;
      },
      id,
      setInstance(next) {
        if (!next) return;
        inst = next;
        drawHead();
      },
      goTab(tab, ...sub) {
        selectTab(tab, sub);
      },
      // Ruta de la pestania actual (sin recargar la pagina).
      setRoute(...parts) {
        const route = ['instance', id, ...parts].map(encodeURIComponent).join('/');
        if (location.hash !== `#/${route}`) history.replaceState(null, '', `#/${route}`);
      },
      onCounts(fn) {
        countListeners.add(fn);
        return () => countListeners.delete(fn);
      },
      async refreshCounts(force = true) {
        if (force) invalidateOverview(id);
        try {
          const ov = await getOverview(id);
          state.counts = ov.counts;
          drawTabs();
          countListeners.forEach((fn) => fn(state.counts));
          return ov;
        } catch {
          return null;
        }
      },
    };

    function playButton() {
      const run = store.running[id];
      const task = store.taskFor(id);
      if (run?.state === 'running') {
        return h('button', { class: 'btn lg danger', type: 'button', dataset: { fk: 'play' }, onclick: () => api.instances.stop(id) }, icon('stop'), t('instance.stop'));
      }
      const busy = Boolean(run || task);
      const pct = task?.progress != null ? Math.round(task.progress * 100) : null;
      const label = task ? (pct != null ? t('instance.installingPct', { pct }) : t('instance.installing')) : run ? t('instance.starting') : t('instance.play');
      return h(
        'button',
        { class: ['btn lg primary ih-play', busy && 'loading'], type: 'button', disabled: busy, 'aria-busy': busy ? 'true' : null, dataset: { fk: 'play' }, onclick: () => playInstance(inst) },
        icon('play'),
        h('span', { class: 'num' }, label),
      );
    }

    function drawHead() {
      const run = store.running[id];
      const task = store.taskFor(id);
      const more = iconButton('more', t('instance.moreActions'), (e) => {
        e.stopPropagation();
        popMenu(more, instanceMenuItems(inst, { manage: false, onDeleted: () => navigate('versions') }));
      });
      more.setAttribute('aria-haspopup', 'menu');
      more.dataset.fk = 'more';
      const folderBtn = iconButton('folder', t('instance.openFolder'), () => openFolder(inst));
      folderBtn.dataset.fk = 'folder';
      const act = run?.state === 'running' ? activityText(state.activity) : null;
      keepFocus(headBox, () => mount(
        headBox,
        h('button', { class: 'back-link ih-back', type: 'button', dataset: { fk: 'back' }, onclick: () => navigate('versions') }, icon('chevronLeft'), t('instance.backToVersions')),
        h(
          'div',
          { class: 'detail-head ih-head' },
          instIcon(inst),
          h(
            'div',
            { class: 'ih-title-wrap' },
            h('div', { class: 'ih-title-row' }, h('h1', { class: 'page-title ellipsis', title: inst.name }, inst.name), groupSlot),
            h(
              'div',
              { class: 'ih-meta' },
              h('span', { class: 'badge' }, icon('box'), t('instance.minecraftVersion', { version: inst.mcVersion })),
              instanceBadge(inst),
              run ? h('span', { class: ['vs-live', run.state === 'running' ? 'on' : 'starting'] }, h('i', { 'aria-hidden': 'true' }), run.state === 'running' ? t('instance.playing') : t('instance.starting')) : null,
              !inst.installed && !task ? h('span', { class: 'badge warn' }, t('instance.notInstalled')) : null,
              act ? h('span', { class: 'small text-2 ih-activity ellipsis', title: act }, act) : null,
            ),
            h(
              'div',
              { class: 'ih-sub small muted vs-dots' },
              h('span', {}, inst.playtime ? t('instance.playtime', { time: fmtDuration(inst.playtime) }) : t('instance.neverPlayed')),
              h('span', {}, t('instance.launches', { count: inst.launches || 0 })),
              inst.lastPlayed ? h('span', {}, t('instance.lastPlayed', { ago: fmtAgo(inst.lastPlayed) })) : null,
            ),
          ),
          h('div', { class: 'ih-actions' }, folderBtn, more, playButton()),
        ),
        task
          ? h(
              'div',
              { class: 'ih-task' },
              h(
                'div',
                { class: 'ih-task-top' },
                h('div', { class: 'small text-2 ellipsis', title: task.detail || task.title || '' }, task.detail || task.title),
                task.progress != null ? h('span', { class: 'ih-task-pct' }, t('instance.percent', { pct: Math.round(task.progress * 100) })) : null,
              ),
              h(
                'div',
                {
                  class: ['progress', task.progress == null && 'indeterminate'],
                  role: 'progressbar',
                  'aria-label': task.title || t('instance.installing'),
                  'aria-valuemin': '0',
                  'aria-valuemax': '100',
                  'aria-valuenow': task.progress != null ? String(Math.round(task.progress * 100)) : null,
                },
                h('i', { style: { width: `${Math.round((task.progress || 0) * 100)}%` } }),
              ),
            )
          : null,
      ));
    }

    function drawTabs() {
      const c = state.counts;
      keepFocus(tabsBar, () => mount(
        tabsBar,
        TABS.map((tb) => {
          const n = c && tb.count ? tb.count(c) : null;
          const label = t(`instance.tab_${tb.id}`);
          const on = state.tab === tb.id;
          return h(
            'button',
            {
              type: 'button',
              role: 'tab',
              id: `ih-tab-${tb.id}`,
              class: ['tab', on && 'active'],
              'aria-selected': String(on),
              'aria-controls': 'ih-panel',
              tabindex: on ? 0 : -1,
              title: n ? t('versions.groupOption', { label, count: n }) : null,
              dataset: { tab: tb.id, fk: `tab:${tb.id}` },
              onclick: () => selectTab(tb.id),
            },
            icon(tb.icon),
            h('span', { class: 'ih-tab-label' }, label),
            n ? h('span', { class: 'count' }, String(n)) : null,
          );
        }),
      ));
      body.setAttribute('aria-labelledby', `ih-tab-${state.tab}`);
    }

    tabsBar.addEventListener('keydown', (e) => {
      if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const i = TABS.findIndex((x) => x.id === state.tab);
      const n = e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
      selectTab(TABS[n].id);
      tabsBar.querySelector(`[data-tab="${TABS[n].id}"]`)?.focus();
    });

    function renderTab() {
      if (tabCleanup) {
        try {
          tabCleanup();
        } catch (err) {
          console.error('[versions] pestaña de instancia', err);
        }
        tabCleanup = null;
      }
      closeMenu();
      body.classList.remove('ih-anim');
      void body.offsetWidth;
      body.classList.add('ih-anim');
      switch (state.tab) {
        case 'content':
          tabCleanup = contentHub(body, ctx, state.kind, state.sub);
          break;
        case 'worlds':
          tabCleanup = worldsTab(body, ctx);
          break;
        case 'screenshots':
          tabCleanup = screenshotsTab(body, ctx);
          break;
        case 'logs':
          tabCleanup = logsTab(body, ctx, state.sub);
          break;
        case 'settings':
          tabCleanup = settingsTab(body, ctx);
          break;
        default:
          tabCleanup = overviewTab(body, ctx);
      }
    }

    // Cambiar de pestania sin recargar toda la pagina (la ruta se actualiza para poder recargar o compartir).
    function selectTab(tab, sub = []) {
      const parsed = parseTab(tab, inst);
      state.tab = parsed.tab;
      state.kind = parsed.kind;
      state.sub = sub;
      if (state.tab === 'content') ctx.setRoute(state.kind, ...sub);
      else ctx.setRoute(state.tab, ...sub);
      drawTabs();
      renderTab();
    }

    mount(root, h('div', { class: 'ih' }, headBox, tabsBar, body));
    const offGuard = guardDrops(root);
    drawHead();
    drawTabs();
    renderTab();
    fillGroup();
    ctx.refreshCounts(false);
    api
      .invoke('game:activity', id)
      .then((act) => {
        state.activity = act;
        if (store.running[id]) drawHead();
      })
      .catch(() => {});

    const refresh = async () => {
      try {
        const next = await api.instances.get(id);
        const nameChanged = next.name !== inst.name;
        inst = next;
        drawHead();
        if (nameChanged) fillGroup();
      } catch {
        if (!state.gone) {
          state.gone = true;
          navigate('versions');
        }
      }
    };

    let lastTaskDraw = 0;
    const offs = [
      store.on('running', drawHead),
      store.on('instances', refresh),
      store.on('task', (task) => {
        if (task.meta?.instanceId !== id) return;
        if (task.state !== 'running' || Date.now() - lastTaskDraw > 350) {
          lastTaskDraw = Date.now();
          drawHead();
        }
        if (task.state === 'done') {
          refresh();
          ctx.refreshCounts();
        }
      }),
      api.on('game:activity', (iid, act) => {
        if (iid !== id) return;
        state.activity = act;
        drawHead();
      }),
    ];
    return () => {
      offs.forEach((off) => off());
      offGuard();
      countListeners.clear();
      closeMenu();
      if (tabCleanup) tabCleanup();
    };
  },
};
