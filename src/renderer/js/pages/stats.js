// Estadisticas completas: tiempo de juego y actividad del launcher, estadisticas dentro del juego,
// tiempo por mundo y servidor, hitos y logros. Rutas: #/stats, #/stats/<pestana>, #/stats/world/<instancia>/<carpeta>
import { h, icon, mount, clear, confirmDialog, fail, ok, toast, hideTip, fmtDate, fmtDuration, debounce, setBusy } from '../ui.js';
import { api, store } from '../store.js';
import { t } from '../i18n.js';
import { navigate } from '../app.js';
import { fmtInt } from './stats/format.js';
import { kpi, errorBox, skeletonBox, skeletonKpi, skeletonCard, bone } from './stats/parts.js';
import * as launcherTab from './stats/launcher.js';
import * as ingameTab from './stats/ingame.js';
import * as placesTab from './stats/places.js';
import * as achievementsTab from './stats/achievements.js';
import { openWorldStats } from './stats/world.js';

const TABS = [
  { id: 'launcher', icon: 'chart', mod: launcherTab },
  { id: 'ingame', icon: 'pickaxe', mod: ingameTab },
  { id: 'places', icon: 'globe', mod: placesTab },
  { id: 'achievements', icon: 'trophy', mod: achievementsTab },
];

function kpiRow(r) {
  const tt = r.totals;
  const fav = r.byVersion.find((v) => v.id !== '?');
  return [
    kpi({
      hero: true,
      icon: 'clock',
      label: t('stats.kpiTotal'),
      value: fmtDuration(tt.ms),
      foot: tt.sessions ? t('stats.kpiTotalFoot', { count: tt.sessions, value: fmtInt(tt.sessions), date: fmtDate(r.firstPlay) }) : t('stats.kpiNoGames'),
    }),
    kpi({ icon: 'calendar', label: t('stats.kpiWeek'), value: fmtDuration(tt.weekMs), foot: t('stats.kpiToday', { time: fmtDuration(tt.todayMs) }) }),
    kpi({ icon: 'gamepad', label: t('stats.kpiAvg'), value: fmtDuration(tt.avgMs), foot: tt.sessions ? t('stats.kpiMedian', { time: fmtDuration(tt.medianMs) }) : t('stats.noDataYet') }),
    kpi({
      icon: 'flame',
      label: t('stats.kpiStreak'),
      value: t('stats.days', { count: r.streak.current }),
      foot: r.streak.current && !r.streak.playedToday ? t('stats.kpiStreakKeep') : t('stats.kpiBestStreak', { count: r.streak.longest.days }),
    }),
    kpi({ icon: 'star', label: t('stats.kpiFavVersion'), value: fav ? fav.id : '—', foot: fav ? t('stats.kpiFavFoot', { time: fmtDuration(fav.ms) }) : t('stats.noDataYet') }),
  ];
}

const pageHead = (sub, actions) =>
  h('div', { class: 'page-head' }, h('div', { class: 'ph-text' }, h('h1', { class: 'page-title' }, t('stats.title')), sub), actions ? h('div', { class: 'page-actions' }, actions) : null);

// Mientras se calcula el reporte: la forma de la pagina (numeros, pestanas y tarjetas)
function loadingView() {
  return h(
    'div',
    { class: 'st-root' },
    pageHead(h('p', { class: 'page-sub' }, t('stats.subtitle'))),
    skeletonBox(
      t('stats.loading'),
      h('div', { class: 'st-kpis' }, Array.from({ length: 5 }, skeletonKpi)),
      bone('skeleton-block st-skel-tabs'),
      skeletonCard(176),
      h('div', { class: 'st-grid st-grid-2 st-grid-lead' }, skeletonCard(210), skeletonCard(210)),
    ),
  );
}

export default {
  ns: ['stats'],
  css: ['pages/stats'],
  async render(root, params = []) {
    const deepWorld = params[0] === 'world' && params[1] && params[2] ? { instanceId: params[1], folder: params[2] } : null;
    const state = {
      tab: TABS.some((x) => x.id === params[0]) ? params[0] : deepWorld ? 'places' : 'launcher',
      report: null,
      sys: null,
      usage: {},
      runtimes: [],
      ingame: null,
      ingameError: null,
      ingameLoading: false,
      scope: { instanceId: null, world: null },
      places: null,
      placesError: null,
    };
    const offs = [];
    const panels = new Map(); // id -> { el, cleanup, dirty }
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      offs.forEach((o) => o());
      for (const p of panels.values()) {
        try {
          p.cleanup?.();
        } catch (err) {
          console.error('[stats]', err);
        }
      }
      hideTip();
    };

    mount(root, loadingView());
    const loadAll = () =>
      Promise.all([api.invoke('stats:report'), api.system.info().catch(() => null), api.app.dataUsage().catch(() => ({})), api.java.runtimes().catch(() => [])]);
    try {
      [state.report, state.sys, state.usage, state.runtimes] = await loadAll();
    } catch (err) {
      if (!root.isConnected) return null;
      mount(
        root,
        h(
          'div',
          { class: 'st-root' },
          pageHead(h('p', { class: 'page-sub' }, t('stats.subtitle'))),
          errorBox(err, () => navigate(params.length ? `stats/${params.map(encodeURIComponent).join('/')}` : 'stats')),
        ),
      );
      return null;
    }
    if (!root.isConnected) return null; // se cambio de pagina mientras cargaba
    // Hitos nuevos de esta visita: conservan la etiqueta "Nuevo" aunque ya se marcaron como vistos
    state.newIds = new Set((state.report.milestones || []).filter((m) => m.isNew).map((m) => m.id));
    const modals = new Set();
    offs.push(() => modals.forEach((m) => m.close()));

    // ---------- Encabezado ----------
    const sub = h('p', { class: 'page-sub' });
    const drawSub = () => mount(sub, state.report.totals.sessions ? t('stats.subtitleSince', { date: fmtDate(state.report.firstPlay || state.report.firstUse) }) : t('stats.subtitle'));
    drawSub();
    const exportBtn = h('button', { class: 'btn', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, icon('download'), t('stats.export'), icon('chevronDown', 'st-export-chev'));
    const exportWrap = h('div', { class: 'st-export' }, exportBtn);
    // Reiniciar borra el historial: va separado y con aspecto de accion destructiva (pide confirmacion)
    const resetBtn = h('button', { class: 'btn ghost st-reset', type: 'button', title: t('stats.resetHint') }, icon('trash'), t('stats.reset'));
    const head = pageHead(sub, [resetBtn, exportWrap]);
    const runningBox = h('div', { class: 'st-notices' });
    const exportBox = h('div', { class: 'st-notices' });
    const kpiBox = h('div', { class: 'st-kpis' }, kpiRow(state.report));
    const tabBar = h('div', { class: 'tabs st-tabs', role: 'tablist', 'aria-label': t('stats.tabsLabel') });
    const panelsHost = h('div', { class: 'st-panels' });

    // ---------- Pestanas ----------
    const newMilestones = () => (state.report.milestones || []).filter((m) => m.isNew).length;
    const drawTabs = () => {
      mount(
        tabBar,
        TABS.map((tab) => {
          const active = tab.id === state.tab;
          const fresh = tab.id === 'achievements' ? newMilestones() : 0;
          const dot = fresh ? h('span', { class: 'st-tab-dot', role: 'img', title: t('stats.newMilestones', { count: fresh }), 'aria-label': t('stats.newMilestones', { count: fresh }) }) : null;
          return h(
            'button',
            {
              type: 'button',
              class: ['tab', active && 'active'],
              role: 'tab',
              id: `st-tab-${tab.id}`,
              'aria-selected': String(active),
              'aria-controls': `st-panel-${tab.id}`,
              tabindex: active ? '0' : '-1',
              dataset: { tab: tab.id },
              onclick: () => select(tab.id),
            },
            icon(tab.icon),
            t(`stats.tab_${tab.id}`),
            dot,
          );
        }),
      );
    };
    tabBar.addEventListener('keydown', (e) => {
      const i = TABS.findIndex((x) => x.id === state.tab);
      let next = null;
      if (e.key === 'ArrowRight') next = TABS[(i + 1) % TABS.length];
      else if (e.key === 'ArrowLeft') next = TABS[(i - 1 + TABS.length) % TABS.length];
      else if (e.key === 'Home') next = TABS[0];
      else if (e.key === 'End') next = TABS[TABS.length - 1];
      if (!next) return;
      e.preventDefault();
      select(next.id);
      tabBar.querySelector(`[data-tab="${next.id}"]`)?.focus();
    });

    function renderPanel(id) {
      const p = panels.get(id);
      if (!p || disposed) return;
      try {
        p.cleanup?.();
      } catch (err) {
        console.error('[stats]', err);
      }
      p.cleanup = null;
      p.dirty = false;
      const tab = TABS.find((x) => x.id === id);
      try {
        p.cleanup = tab.mod.render(p.el, ctx) || null;
      } catch (err) {
        console.error('[stats]', err);
        mount(p.el, errorBox(err, () => renderPanel(id)));
      }
    }
    function ensurePanel(id) {
      let p = panels.get(id);
      if (!p) {
        p = { el: h('div', { class: 'st-panel', role: 'tabpanel', id: `st-panel-${id}`, 'aria-labelledby': `st-tab-${id}` }), cleanup: null, dirty: true };
        panels.set(id, p);
        panelsHost.append(p.el);
      }
      for (const [pid, panel] of panels) panel.el.hidden = pid !== state.tab;
      if (p.dirty && id === state.tab) renderPanel(id);
    }
    function invalidate(...ids) {
      for (const id of ids) {
        const p = panels.get(id);
        if (!p) continue;
        p.dirty = true;
        if (id === state.tab) renderPanel(id);
      }
    }
    function select(id) {
      if (!TABS.some((x) => x.id === id)) return;
      hideTip();
      state.tab = id;
      drawTabs();
      ensurePanel(id);
      try {
        history.replaceState(null, '', `#/stats/${id}`);
      } catch {
        /* sin historial */
      }
    }

    // ---------- Datos compartidos entre pestanas ----------
    let ingameReq = 0;
    let placesReq = 0;
    const ctx = {
      state,
      openWorld: (instanceId, folder) => {
        const m = openWorldStats(instanceId, folder, () => modals.delete(m));
        modals.add(m);
      },
      goTab: select,
      invalidate,
      onMilestonesSeen: () => {
        // La etiqueta "Nuevo" se mantiene en esta visita; solo se apaga el punto de la pestana
        state.report.milestones = (state.report.milestones || []).map((m) => ({ ...m, isNew: false }));
        drawTabs();
      },
      async loadIngame(scope = state.scope, { force = false } = {}) {
        const next = { instanceId: scope?.instanceId || null, world: scope?.instanceId ? scope?.world || null : null };
        const cur = state.ingame?.scope;
        if (!force && state.ingame && cur && cur.instanceId === next.instanceId && cur.world === next.world) return state.ingame;
        const req = ++ingameReq;
        state.scope = next;
        state.ingameLoading = true;
        for (const id of ['ingame', 'achievements']) panels.get(id)?.el.classList.add('st-busy');
        let changed = false;
        try {
          const data = await api.invoke('stats:ingame', next);
          if (req !== ingameReq || disposed) return null;
          state.ingame = data;
          state.ingameError = null;
          changed = true;
        } catch (err) {
          if (req !== ingameReq || disposed) return null;
          state.ingameError = err;
          // Si el filtro dejo de existir (mundo borrado), volver a "todos"
          if (state.ingame && (next.instanceId || next.world)) state.scope = state.ingame.scope || { instanceId: null, world: null };
          changed = true;
        } finally {
          if (req === ingameReq) {
            state.ingameLoading = false;
            for (const id of ['ingame', 'achievements']) panels.get(id)?.el.classList.remove('st-busy');
          }
        }
        if (changed) invalidate('ingame', 'achievements');
        return state.ingame;
      },
      async loadPlaces(force = false) {
        if (state.places && !force) return state.places;
        const req = ++placesReq;
        try {
          const data = await api.invoke('stats:places');
          if (req !== placesReq || disposed) return null;
          state.places = data;
          state.placesError = null;
        } catch (err) {
          if (req !== placesReq || disposed) return null;
          state.placesError = err;
        }
        invalidate('places');
        return state.places;
      },
    };

    // ---------- Exportar ----------
    let menu = null;
    const closeMenu = () => {
      if (!menu) return;
      menu.remove();
      menu = null;
      exportBtn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('mousedown', onOutside, true);
    };
    const onOutside = (e) => {
      if (menu && !exportWrap.contains(e.target)) closeMenu();
    };
    const doExport = async (format) => {
      closeMenu();
      const done = setBusy(exportBtn);
      try {
        const res = await api.invoke('stats:export', format);
        if (res?.path && !disposed) {
          mount(
            exportBox,
            h(
              'div',
              { class: 'notice good st-export-done', role: 'status' },
              icon('check'),
              h('div', { class: 'spacer st-export-text' }, h('div', { class: 'st-export-title' }, t('stats.exportDone')), h('div', { class: 'small ellipsis selectable', title: res.path }, res.path)),
              h(
                'button',
                { class: 'btn sm', type: 'button', onclick: () => api.invoke('stats:reveal', res.path).catch((err) => fail(t('stats.exportFailed'), err)) },
                icon('folderOpen'),
                t('stats.showInFolder'),
              ),
              h('button', { class: 'icon-btn sm', type: 'button', title: t('stats.dismiss'), 'aria-label': t('stats.dismiss'), onclick: () => clear(exportBox) }, icon('x')),
            ),
          );
        }
      } catch (err) {
        fail(t('stats.exportFailed'), err);
      } finally {
        done();
      }
    };
    const openMenu = () => {
      if (menu) return closeMenu();
      const item = (fmt, ic, title, subText) =>
        h('button', { class: 'st-menu-item', type: 'button', role: 'menuitem', onclick: () => doExport(fmt) }, icon(ic), h('span', { class: 'st-mi-text' }, h('span', { class: 'st-mi-title' }, title), h('span', { class: 'st-mi-sub' }, subText)));
      menu = h('div', { class: 'st-menu', role: 'menu', 'aria-label': t('stats.export') }, item('csv', 'fileText', t('stats.exportCsv'), t('stats.exportCsvSub')), item('json', 'code', t('stats.exportJson'), t('stats.exportJsonSub')));
      menu.addEventListener('keydown', (e) => {
        const items = [...menu.querySelectorAll('.st-menu-item')];
        const i = items.indexOf(document.activeElement);
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          closeMenu();
          exportBtn.focus();
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
        }
      });
      exportWrap.append(menu);
      exportBtn.setAttribute('aria-expanded', 'true');
      document.addEventListener('mousedown', onOutside, true);
      menu.querySelector('.st-menu-item')?.focus();
    };
    exportBtn.addEventListener('click', openMenu);
    offs.push(() => {
      closeMenu();
    });

    // ---------- Reiniciar ----------
    resetBtn.addEventListener('click', async () => {
      if (!(await confirmDialog(t('stats.resetTitle'), t('stats.resetText'), { okText: t('stats.resetOk'), danger: true }))) return;
      const done = setBusy(resetBtn);
      try {
        await api.stats.reset();
        ok(t('stats.resetDone'));
        await refresh('reset');
      } catch (err) {
        fail(t('stats.resetFailed'), err);
      } finally {
        done();
      }
    });

    // ---------- Partida en curso ----------
    const drawRunning = () => {
      const ids = Object.entries(store.running)
        .filter(([, r]) => r?.state === 'running')
        .map(([id]) => id);
      if (!ids.length) {
        clear(runningBox);
        return;
      }
      const names = ids.map((id) => store.instances.find((i) => i.id === id)?.name || id);
      mount(runningBox, h('div', { class: 'notice info st-running', role: 'status' }, h('span', { class: 'st-live-dot' }), t('stats.runningNote', { name: names.join(', '), count: names.length })));
    };
    drawRunning();
    offs.push(store.on('running', drawRunning));

    // ---------- Actualizacion en vivo ----------
    const refresh = async (kind) => {
      let report;
      try {
        report = await api.invoke('stats:report');
      } catch {
        return;
      }
      if (disposed) return;
      state.report = report;
      for (const m of report.milestones || []) if (m.isNew) state.newIds.add(m.id);
      mount(kpiBox, kpiRow(report));
      drawSub();
      drawTabs();
      invalidate('launcher', 'achievements');
      state.places = null;
      invalidate('places');
      if (kind === 'session' || kind === 'reset') {
        // Al cerrar una partida el juego guarda las estadisticas del mundo
        state.ingame = null;
        state.ingameError = null;
        invalidate('ingame', 'achievements');
      }
    };
    const refreshSoon = debounce((kind) => refresh(kind), 900);
    offs.push(api.on('stats:updated', (info) => refreshSoon(info?.kind || 'session')));
    offs.push(
      api.on('stats:milestone', (list) => {
        for (const m of (Array.isArray(list) ? list : []).slice(0, 3)) toast('good', t('stats.msUnlockedToast'), t(`stats.ms_${m.id}`), 6000);
      }),
    );

    mount(root, h('div', { class: 'st-root' }, head, runningBox, exportBox, kpiBox, tabBar, panelsHost));
    drawTabs();
    ensurePanel(state.tab);
    if (deepWorld) {
      try {
        history.replaceState(null, '', `#/stats/${state.tab}`);
      } catch {
        /* sin historial */
      }
      ctx.openWorld(deepWorld.instanceId, deepWorld.folder);
    }
    return dispose;
  },
};
