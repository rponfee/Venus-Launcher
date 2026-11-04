// Pestaña Historial de Rendimiento: lista de partidas, gráfico SVG propio y comparación entre dos partidas. Los datos los
// junta modules/perfhistory.js (una muestra cada 10 s de RAM, CPU y FPS). Los colores salen de las variables del tema, así el
// gráfico se ve bien en claro y en oscuro; la segunda partida de una comparación va punteada, para no depender solo del color.
import { h, icon, mount, emptyState, skeleton, fail, ok, selectEl, confirmDialog, fmtDate, fmtDuration, fmtNumber, switchEl } from '../../ui.js';
import { api, store } from '../../store.js';
import { t } from '../../i18n.js';
import { bounds, ticks, linePath, compareRows, niceRam } from './chart-math.js';

const T = (key, vars) => t(`datatools.${key}`, vars);
const METRICS = ['ram', 'cpu', 'fps'];
const DATE_ROW = { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };
const W = 640;
const H = 220;
const PAD = { left: 52, right: 12, top: 12, bottom: 28 };

const svg = (tag, props, ...kids) => h(tag, { ...props, svg: true }, ...kids);
const fmtValue = (metric, v) => {
  if (v === null || v === undefined) return T('histNoData');
  if (metric === 'ram') return v >= 1024 ? `${(v / 1024).toFixed(1)} GB` : `${Math.round(v)} MB`;
  if (metric === 'cpu') return `${Number(v).toFixed(0)} %`;
  return T('histFpsValue', { value: Math.round(v) });
};
const axisValue = (metric, v) => (metric === 'ram' ? (v >= 1024 ? `${Number((v / 1024).toFixed(2))} GB` : `${Math.round(v)} MB`) : metric === 'cpu' ? `${Math.round(v)} %` : String(Math.round(v)));

// series: [{ t, v, label, second }]
function chart(metric, series) {
  const { tMax, vMax } = bounds(series, metric === 'ram' ? niceRam : undefined);
  const inner = { w: W - PAD.left - PAD.right, h: H - PAD.top - PAD.bottom };
  const x = (s) => PAD.left + (s / tMax) * inner.w;
  const y = (v) => PAD.top + inner.h - (v / vMax) * inner.h;
  const yTicks = ticks(vMax, 4);
  const xTicks = ticks(tMax, 4);
  const title = series.map((s) => s.label).join(' · ');
  return svg(
    'svg',
    { class: 'dt-chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': T('histChartAria', { metric: T(`histMetric_${metric}`), sessions: title }) },
    yTicks.map((v) => svg('line', { class: 'dt-grid', x1: PAD.left, x2: W - PAD.right, y1: y(v), y2: y(v) })),
    yTicks.map((v) => svg('text', { class: 'dt-axis', x: PAD.left - 6, y: y(v) + 4, 'text-anchor': 'end' }, axisValue(metric, v))),
    xTicks.map((s, i) => svg('text', { class: 'dt-axis', x: x(s), y: H - 8, 'text-anchor': i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle' }, T('histMinutes', { value: Math.round(s / 60) }))),
    series.map((s) => svg('path', { class: ['dt-line-path', s.second && 'second'], d: linePath(s.t, s.v, { x, y }), fill: 'none' })),
  );
}

function statsTable(s) {
  const head = ['histAvg', 'histMin', 'histLow1', 'histMax'].map((k) => h('th', { scope: 'col' }, T(k)));
  return h(
    'table',
    { class: 'dt-table' },
    h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, T('histMetricCol')), head)),
    h(
      'tbody',
      {},
      METRICS.map((m) => {
        const st = s[m];
        return h('tr', {}, h('th', { scope: 'row' }, T(`histMetric_${m}`)), st ? [st.avg, st.min, st.low1, st.max].map((v) => h('td', {}, fmtValue(m, v))) : h('td', { colspan: 4, class: 'muted' }, T('histNoData')));
      }),
    ),
  );
}

function compareTable(a, b) {
  return h(
    'table',
    { class: 'dt-table' },
    h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, T('histMetricCol')), h('th', { scope: 'col' }, T('histSessionA')), h('th', { scope: 'col' }, T('histSessionB')), h('th', { scope: 'col' }, T('histDiff')))),
    h(
      'tbody',
      {},
      compareRows(a, b).map((r) =>
        h(
          'tr',
          {},
          h('th', { scope: 'row' }, T(`histMetric_${r.key}`)),
          h('td', {}, r.a ? fmtValue(r.key, r.a.avg) : T('histNoData')),
          h('td', {}, r.b ? fmtValue(r.key, r.b.avg) : T('histNoData')),
          h('td', {}, r.diff === null ? '—' : `${r.diff > 0 ? '+' : ''}${r.key === 'ram' ? `${fmtNumber(Math.round(r.diff))} MB` : r.key === 'cpu' ? `${r.diff} %` : r.diff}${r.pct === null ? '' : ` (${r.pct > 0 ? '+' : ''}${r.pct} %)`}`),
        ),
      ),
    ),
  );
}

const fpsNotice = () => h('div', { class: 'notice info dt-fps-note' }, icon('info'), h('div', {}, h('strong', {}, T('histFpsNone')), h('div', { class: 'small' }, T('histFpsWhy'))));

export function historyView() {
  const state = { sessions: null, filter: '', selected: null, compare: [], metric: 'ram', details: new Map(), alive: true };
  const toolbar = h('div', { class: 'dt-hist-bar' });
  const list = h('div', { class: 'dt-hist-list', role: 'list', 'aria-label': T('histListAria') });
  const panel = h('div', { class: 'dt-hist-panel' });
  const record = h('div', { class: 'card toggle-row', style: { padding: '16px 20px' } },
    h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, T('histRecord')), h('div', { class: 'tr-sub' }, T('histRecordText'))),
    switchEl(store.settings?.perfhistory?.enabled !== false, (enabled) => store.setSettings({ perfhistory: { enabled } }).catch((err) => fail(T('saveError'), err)), T('histRecord')));
  const root = h('div', { class: 'dt-hist' }, record, toolbar, h('div', { class: 'dt-hist-main' }, list, panel));

  const visible = () => (state.sessions || []).filter((s) => !state.filter || s.instanceId === state.filter);

  async function detail(id) {
    if (state.details.has(id)) return state.details.get(id);
    const d = await api.invoke('perfhistory:get', id);
    if (d) state.details.set(id, d);
    return d;
  }

  function drawToolbar() {
    const seen = new Map((state.sessions || []).map((s) => [s.instanceId, s.instanceName]));
    const options = [{ value: '', label: T('histAllInstances') }, ...[...seen].map(([value, label]) => ({ value, label }))];
    mount(
      toolbar,
      selectEl(options, state.filter, (v) => {
        state.filter = v;
        drawList();
      }),
      h('span', { class: 'small muted spacer' }, T('histHint')),
      state.sessions?.length
        ? h(
            'button',
            {
              class: 'btn sm ghost',
              type: 'button',
              onclick: async () => {
                if (!(await confirmDialog(T('histClearTitle'), T('histClearText'), { okText: T('histClear'), danger: true }))) return;
                try {
                  await api.invoke('perfhistory:clear');
                  ok(T('histCleared'));
                } catch (err) {
                  fail(T('histError'), err);
                }
              },
            },
            icon('trash'),
            T('histClear'),
          )
        : null,
    );
  }

  function row(s) {
    const check = h('input', { type: 'checkbox', checked: state.compare.includes(s.id), 'aria-label': T('histCompareAria', { name: s.instanceName }), onclick: (e) => e.stopPropagation() });
    check.addEventListener('change', () => {
      if (check.checked) state.compare = [...state.compare, s.id].slice(-2);
      else state.compare = state.compare.filter((x) => x !== s.id);
      drawList();
      drawPanel();
    });
    const active = state.selected === s.id && state.compare.length < 2;
    return h(
      'div',
      {
        class: ['dt-hist-row', active && 'active'],
        role: 'listitem',
        tabindex: 0,
        onclick: () => {
          state.selected = s.id;
          state.compare = [];
          drawList();
          drawPanel();
        },
        onkeydown: (e) => {
          if (e.key !== 'Enter' || e.target !== e.currentTarget) return;
          e.preventDefault();
          e.currentTarget.click();
        },
      },
      check,
      h(
        'div',
        { class: 'dt-hist-row-main' },
        h('div', { class: 'dt-hist-row-title ellipsis', title: s.instanceName }, s.instanceName),
        h('div', { class: 'dt-hist-row-sub' }, [fmtDate(s.start, DATE_ROW), fmtDuration(s.durationMs), s.mcVersion].filter(Boolean).join(' · ')),
        h('div', { class: 'dt-hist-row-sub' }, s.ram ? fmtValue('ram', s.ram.avg) : '', s.cpu ? ` · ${fmtValue('cpu', s.cpu.avg)}` : '', s.fps ? ` · ${fmtValue('fps', s.fps.avg)}` : ''),
      ),
      s.crashed ? h('span', { class: 'badge warn', title: T('histCrashed') }, icon('alert')) : null,
      s.partial ? h('span', { class: 'badge', title: T('histPartial') }, icon('clock')) : null,
    );
  }

  function drawList() {
    const items = visible();
    drawToolbar();
    mount(list, items.length ? items.map(row) : h('div', { class: 'small muted dt-hist-none' }, T('histNoneForInstance')));
  }

  function metricTabs() {
    return h(
      'div',
      { class: 'segmented', role: 'group', 'aria-label': T('histMetricCol') },
      METRICS.map((m) =>
        h(
          'button',
          {
            type: 'button',
            class: state.metric === m ? 'active' : '',
            'aria-pressed': String(state.metric === m),
            onclick: () => {
              state.metric = m;
              drawPanel();
            },
          },
          T(`histMetric_${m}`),
        ),
      ),
    );
  }

  const seriesOf = (d, metric, second, label) => ({ t: d.series?.t || [], v: d.series?.[metric] || [], label, second });

  async function drawPanel() {
    const compare = state.compare.length === 2;
    const ids = compare ? state.compare : state.selected ? [state.selected] : [];
    if (!ids.length) {
      mount(panel, emptyState('chart', T('histPick'), T('histPickText')));
      return;
    }
    const loading = h('div', {}, skeleton('block', { height: 200 }));
    mount(panel, loading);
    let items;
    try {
      items = await Promise.all(ids.map(detail));
    } catch (err) {
      if (state.alive) mount(panel, h('div', { class: 'notice bad', role: 'alert' }, icon('alert'), h('div', {}, err.message)));
      return;
    }
    if (!state.alive || !loading.isConnected) return;
    items = items.filter(Boolean);
    if (!items.length) {
      mount(panel, emptyState('chart', T('histGone')));
      return;
    }
    const [a, b] = items;
    const metric = state.metric;
    const noFps = items.every((d) => !d.fps);
    const noSeries = items.every((d) => !d.series?.[metric]?.length);
    const labelOf = (d) => `${d.instanceName} · ${fmtDate(d.start, DATE_ROW)}`;
    mount(
      panel,
      h(
        'div',
        { class: 'dt-hist-head' },
        h(
          'div',
          { class: 'dt-hist-title' },
          compare
            ? h('div', { class: 'dt-legend' }, h('span', { class: 'dt-lg' }, h('i', { class: 'dt-lg-line' }), h('span', { class: 'ellipsis' }, labelOf(a))), h('span', { class: 'dt-lg' }, h('i', { class: 'dt-lg-line second' }), h('span', { class: 'ellipsis' }, labelOf(b))))
            : [h('div', { class: 'dt-hist-name ellipsis', title: a.instanceName }, a.instanceName), h('div', { class: 'small muted' }, [fmtDate(a.start, DATE_ROW), fmtDuration(a.durationMs), a.mcVersion, a.loader].filter(Boolean).join(' · '))],
        ),
        metricTabs(),
      ),
      noSeries
        ? h('div', { class: 'dt-chart-empty' }, metric === 'fps' ? h('span', {}, T('histNoData')) : h('span', {}, T('histNoSeries')))
        : chart(metric, compare ? [seriesOf(a, metric, false, labelOf(a)), seriesOf(b, metric, true, labelOf(b))] : [seriesOf(a, metric, false, labelOf(a))]),
      noFps ? fpsNotice() : null,
      compare ? compareTable(a, b) : statsTable(a),
      compare
        ? null
        : h(
            'div',
            { class: 'dt-actions' },
            a.crashed ? h('span', { class: 'small muted' }, T('histCrashed')) : null,
            a.partial ? h('span', { class: 'small muted' }, T('histPartial')) : null,
            h('span', { class: 'spacer' }),
            h(
              'button',
              {
                class: 'btn sm ghost',
                type: 'button',
                onclick: async () => {
                  try {
                    await api.invoke('perfhistory:remove', a.id);
                  } catch (err) {
                    fail(T('histError'), err);
                  }
                },
              },
              icon('trash'),
              T('histDelete'),
            ),
          ),
    );
  }

  async function load() {
    let sessions;
    try {
      sessions = await api.invoke('perfhistory:list', { limit: 500 });
    } catch (err) {
      if (state.alive) mount(root, h('div', { class: 'notice bad', role: 'alert' }, icon('alert'), h('div', { class: 'spacer' }, T('histError')), h('button', { class: 'btn sm', type: 'button', onclick: load }, icon('refresh'), t('common.retry'))));
      return;
    }
    if (!state.alive) return;
    state.sessions = sessions;
    if (!sessions.length) {
      mount(root, record, h('div', { class: 'card flat' }, emptyState('activity', T('histEmpty'), T('histEmptyText'))));
      return;
    }
    if (!root.contains(list)) mount(root, record, toolbar, h('div', { class: 'dt-hist-main' }, list, panel));
    if (!state.selected || !sessions.some((s) => s.id === state.selected)) state.selected = sessions[0].id;
    state.compare = state.compare.filter((id) => sessions.some((s) => s.id === id));
    drawList();
    drawPanel();
  }

  mount(list, skeleton('list', { rows: 4 }));
  load();
  const off = api.on('perfhistory:updated', () => {
    state.details.clear();
    load();
  });
  return {
    el: root,
    destroy() {
      state.alive = false;
      off();
    },
  };
}
