// Pestana "Launcher": actividad del ano, por dia, por hora, tendencia semanal, versiones, loaders,
// instancias, records, cierres inesperados, equipo y espacio en disco.
import { h, icon, mount, clear, fmtDuration, fmtDate, fmtBytes, fmtAgo, LOADERS, emptyState, selectEl, fail } from '../../ui.js';
import { t, locale, loadNs, has } from '../../i18n.js';
import { navigate } from '../../app.js';
import { columnChart, barChart, lineChart, calendarHeatmap, matrixHeatmap, heatLegend, dataTable, viewToggle } from './charts.js';
import { fmtInt, fmtPct, dayKey, keyDate, addDays, startOfDay, fmtDayKey, fmtLongDay, weekdayNames, firstDayOfWeek } from './format.js';
import { card, segmented } from './parts.js';

const pad = (n) => String(n).padStart(2, '0');
const sum = (arr, f = (x) => x) => arr.reduce((a, x) => a + f(x), 0);

// Lista con "Otras" al final si hay demasiadas categorias
function topWithOther(list, n, otherLabel) {
  if (list.length <= n) return list;
  const head = list.slice(0, n - 1);
  const rest = list.slice(n - 1);
  return [...head, { id: '__other', label: otherLabel(rest.length), ms: sum(rest, (x) => x.ms), sessions: sum(rest, (x) => x.sessions), dim: true }];
}

function calendarCard(r, cleanups) {
  const years = [...new Set(Object.keys(r.days).filter((k) => r.days[k] > 0).map((k) => k.slice(0, 4)))].sort().reverse();
  let range = 'last';
  const host = h('div', { class: 'st-cal-host' });
  const legend = h('div', { class: 'st-cal-foot' }, h('span', { class: 'st-today-key' }, h('i', { 'aria-hidden': 'true' }), t('stats.today')));
  const tableBox = h('div', { class: 'st-table-wrap' });
  const sub = h('span');
  let off = null;
  const draw = () => {
    off?.();
    const end = range === 'last' ? new Date() : new Date(Number(range), 11, 31);
    const start = range === 'last' ? addDays(startOfDay(end), -364) : new Date(Number(range), 0, 1);
    let ms = 0;
    let days = 0;
    const months = new Map();
    for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
      const k = dayKey(d);
      const v = r.days[k] || 0;
      const mk = k.slice(0, 7);
      if (!months.has(mk)) months.set(mk, { key: mk, ms: 0, days: 0, sessions: 0 });
      const m = months.get(mk);
      m.ms += v;
      m.sessions += r.daySessions[k] || 0;
      if (v > 0) {
        days++;
        m.days++;
      }
      ms += v;
    }
    mount(sub, t('stats.calSummary', { count: days, time: fmtDuration(ms) }));
    off = calendarHeatmap(host, {
      values: r.days,
      end,
      firstDay: firstDayOfWeek(),
      aria: t('stats.calAria', { count: days, time: fmtDuration(ms) }),
      tip: (k) => [fmtLongDay(k), r.days[k] ? t('stats.dayTip', { time: fmtDuration(r.days[k]), count: r.daySessions[k] || 0 }) : t('stats.dayTipNone')],
    });
    mount(
      tableBox,
      dataTable(
        [t('stats.colMonth'), t('stats.colTime'), t('stats.colDays'), t('stats.colSessions')],
        [...months.values()].reverse().map((m) => [keyDate(`${m.key}-01`).toLocaleDateString(locale(), { month: 'long', year: 'numeric' }), fmtDuration(m.ms), fmtInt(m.days), fmtInt(m.sessions)]),
      ),
    );
  };
  draw();
  cleanups.push(() => off?.());
  const yearSel =
    years.length > 1 || (years.length === 1 && years[0] !== String(new Date().getFullYear()))
      ? selectEl([{ value: 'last', label: t('stats.calLast12') }, ...years.map((y) => ({ value: y, label: y }))], range, (v) => {
          range = v;
          draw();
        }, 'select st-select-sm')
      : null;
  yearSel?.setAttribute('aria-label', t('stats.calRange'));
  const chartWrap = h('div', {}, host, h('div', { class: 'st-cal-legend-row' }, legend, heatLegend()));
  return card({ icon: 'calendar', title: t('stats.calTitle'), sub, actions: [yearSel, viewToggle(chartWrap, tableBox)], cls: 'st-cal-card' }, chartWrap, tableBox);
}

function dailyCard(r, cleanups) {
  let span = 14;
  const host = h('div', { class: 'st-chart' });
  const tableBox = h('div', { class: 'st-table-wrap' });
  let off = null;
  const draw = () => {
    off?.();
    const data = [];
    for (let i = span - 1; i >= 0; i--) {
      const d = addDays(startOfDay(), -i);
      const k = dayKey(d);
      const ms = r.days[k] || 0;
      data.push({
        label: span <= 14 ? d.toLocaleDateString(locale(), { weekday: 'short' }).replace('.', '') : String(d.getDate()),
        tip: fmtLongDay(k),
        value: ms / 60000,
        ms,
        sessions: r.daySessions[k] || 0,
      });
    }
    off = columnChart(host, data, {
      height: 210,
      labelEvery: span <= 14 ? 1 : 3,
      tipValue: (d) => (d.ms ? t('stats.dayTip', { time: fmtDuration(d.ms), count: d.sessions }) : t('stats.dayTipNone')),
      aria: t('stats.dailyAria', { count: span }),
    });
    mount(tableBox, dataTable([t('stats.colDay'), t('stats.colTime'), t('stats.colSessions')], [...data].reverse().map((d) => [d.tip, fmtDuration(d.ms), fmtInt(d.sessions)])));
  };
  draw();
  cleanups.push(() => off?.());
  const seg = segmented(
    [
      { id: 14, label: t('stats.days14') },
      { id: 30, label: t('stats.days30') },
    ],
    span,
    (v) => {
      span = v;
      draw();
    },
    t('stats.dailyRange'),
  );
  return card({ icon: 'chart', title: t('stats.dailyTitle'), sub: t('stats.dailySub', { time: fmtDuration(r.totals.monthMs) }), actions: [seg, viewToggle(host, tableBox)] }, host, tableBox);
}

function whenCard(r, cleanups) {
  let mode = 'hour';
  const host = h('div', { class: 'st-chart' });
  const foot = h('div', { class: 'st-when-foot' });
  // Vista de tabla (alternativa accesible al grafico): por hora, o por dia de la semana en los otros modos
  const tableBox = h('div', { class: 'st-table-wrap' });
  const names = weekdayNames('short');
  const longNames = weekdayNames('long');
  const fd = firstDayOfWeek();
  const order = Array.from({ length: 7 }, (_, i) => (fd + i) % 7);
  const dayTotals = r.weekdayHour.map((row) => sum(row));
  const hourLabel = (hr) => `${pad(hr)}:00`;
  let off = null;
  // Momento favorito (celda con mas tiempo)
  let peak = null;
  r.weekdayHour.forEach((row, dow) => row.forEach((ms, hr) => (!peak || ms > peak.ms) && ms > 0 && (peak = { dow, hr, ms })));
  const peakNote = peak ? h('div', { class: 'small muted' }, icon('star'), t('stats.peak', { day: longNames[peak.dow], hour: hourLabel(peak.hr) })) : null;
  const draw = () => {
    off?.();
    clear(foot);
    if (mode === 'hour') {
      off = columnChart(
        host,
        r.hours.map((ms, i) => ({ label: `${i}h`, tip: t('stats.hourRange', { from: hourLabel(i), to: hourLabel((i + 1) % 24) }), value: ms / 60000, ms })),
        { height: 210, labelEvery: 3, tipValue: (d) => fmtDuration(d.ms), aria: t('stats.hourAria') },
      );
    } else if (mode === 'weekday') {
      off = columnChart(
        host,
        order.map((dow) => ({ label: names[dow], tip: longNames[dow], value: dayTotals[dow] / 60000, ms: dayTotals[dow] })),
        { height: 210, tipValue: (d) => fmtDuration(d.ms), aria: t('stats.weekdayAria') },
      );
    } else {
      off = matrixHeatmap(host, {
        rows: order.map((dow) => ({ label: names[dow], values: r.weekdayHour[dow] })),
        tip: (ri, hr) => [t('stats.dayHourTip', { day: longNames[order[ri]], from: hourLabel(hr), to: hourLabel((hr + 1) % 24) }), fmtDuration(r.weekdayHour[order[ri]][hr])],
        aria: t('stats.matrixAria'),
      });
      foot.append(heatLegend());
    }
    if (peakNote) foot.prepend(peakNote);
    mount(
      tableBox,
      mode === 'hour'
        ? dataTable(
            [t('stats.colHour'), t('stats.colTime')],
            r.hours.map((ms, i) => [t('stats.hourRange', { from: hourLabel(i), to: hourLabel((i + 1) % 24) }), fmtDuration(ms)]),
          )
        : dataTable(
            [t('stats.colDay'), t('stats.colTime')],
            order.map((dow) => [longNames[dow], fmtDuration(dayTotals[dow])]),
          ),
    );
  };
  draw();
  cleanups.push(() => off?.());
  const chartWrap = h('div', {}, host, foot);
  const seg = segmented(
    [
      { id: 'hour', label: t('stats.byHour') },
      { id: 'weekday', label: t('stats.byWeekday') },
      { id: 'matrix', label: t('stats.byDayHour') },
    ],
    mode,
    (v) => {
      mode = v;
      draw();
    },
    t('stats.whenTitle'),
  );
  return card({ icon: 'clock', title: t('stats.whenTitle'), sub: t('stats.whenSub'), actions: [seg, viewToggle(chartWrap, tableBox)], cls: 'st-when-card' }, chartWrap, tableBox);
}

function trendCard(r, cleanups) {
  const data = r.weeks.map((w, i) => {
    const d = new Date(w.start);
    const prev = i ? new Date(r.weeks[i - 1].start) : null;
    return { value: w.ms / 60000, ms: w.ms, sessions: w.sessions, start: w.start, axis: !prev || prev.getMonth() !== d.getMonth() ? d.toLocaleDateString(locale(), { month: 'short' }).replace('.', '') : null };
  });
  // Si el primer mes ocupa una o dos semanas, su etiqueta se pisaria con la siguiente
  const second = data.findIndex((d, i) => i > 0 && d.axis);
  if (second > 0 && second < 3) data[0].axis = null;
  const avg = sum(data, (d) => d.value) / Math.max(1, data.length);
  const host = h('div', { class: 'st-chart' });
  const tableBox = h('div', { class: 'st-table-wrap' });
  const last4 = sum(data.slice(-4), (d) => d.ms);
  const prev4 = sum(data.slice(-8, -4), (d) => d.ms);
  let sub = t('stats.trendSub');
  if (prev4 > 0 && last4 !== prev4) sub = t(last4 > prev4 ? 'stats.trendUp' : 'stats.trendDown', { pct: fmtPct(Math.abs(last4 - prev4) / prev4) });
  else if (prev4 === 0 && last4 > 0) sub = t('stats.trendNew');
  const weekLabel = (d) => t('stats.weekOf', { date: fmtDate(d.start, { day: 'numeric', month: 'short' }) });
  cleanups.push(
    lineChart(host, data, {
      height: 200,
      avg,
      avgLabel: t('stats.avgPerWeek', { time: fmtDuration(avg * 60000) }),
      tipTitle: weekLabel,
      tipValue: (d) => t('stats.weekTip', { time: fmtDuration(d.ms), count: d.sessions }),
      aria: t('stats.trendAria', { time: fmtDuration(avg * 60000) }),
    }),
  );
  mount(tableBox, dataTable([t('stats.colWeek'), t('stats.colTime'), t('stats.colSessions')], [...data].reverse().map((d) => [weekLabel(d), fmtDuration(d.ms), fmtInt(d.sessions)])));
  return card({ icon: 'trending', title: t('stats.trendTitle'), sub, actions: [viewToggle(host, tableBox)] }, host, tableBox);
}

const fmtBarTime = (v) => fmtDuration(v, { short: v > 36e5 * 10 });

function barsCard({ icon: ic, title, sub, data, onSelect, aria }, cleanups) {
  const host = h('div', { class: 'st-chart' });
  if (!data.length) return card({ icon: ic, title, sub }, h('div', { class: 'chart-empty' }, t('stats.noDataYet')));
  cleanups.push(barChart(host, data, { format: fmtBarTime, aria, onSelect }));
  return card({ icon: ic, title, sub }, host);
}

function versionsData(r) {
  const list = r.byVersion.map((v) => ({ ...v, label: v.id === '?' ? t('stats.unknownVersion') : v.id }));
  return topWithOther(list, 8, (count) => t('stats.otherVersions', { count })).map((v) => ({
    label: v.label,
    value: v.ms,
    dim: v.dim,
    tip: t('stats.barTip', { time: fmtDuration(v.ms), count: v.sessions }),
  }));
}

function loadersData(r) {
  return r.byLoader.map((v) => ({ label: LOADERS[v.id]?.name || v.id, value: v.ms, tip: t('stats.barTip', { time: fmtDuration(v.ms), count: v.sessions }) }));
}

// Versiones y loaders en una sola tarjeta (se elige con el control segmentado): queda a la par de "Instancias"
function playsCard(r, cleanups) {
  let mode = 'version';
  const host = h('div', { class: 'st-chart' });
  const sub = h('span');
  let off = null;
  const draw = () => {
    off?.();
    off = null;
    const byVersion = mode === 'version';
    const data = byVersion ? versionsData(r) : loadersData(r);
    mount(sub, byVersion ? t('stats.versionsSub', { count: r.totals.versionsPlayed }) : t('stats.loadersSub'));
    if (!data.length) {
      mount(host, h('div', { class: 'chart-empty' }, t('stats.noDataYet')));
      return;
    }
    off = barChart(host, data, { format: fmtBarTime, aria: byVersion ? t('stats.versionsTitle') : t('stats.loadersTitle') });
  };
  draw();
  cleanups.push(() => off?.());
  const seg = segmented(
    [
      { id: 'version', label: t('stats.byVersion') },
      { id: 'loader', label: t('stats.byLoader') },
    ],
    mode,
    (v) => {
      mode = v;
      draw();
    },
    t('stats.playsTitle'),
  );
  return card({ icon: 'box', title: t('stats.playsTitle'), sub, actions: [seg] }, host);
}

function instancesCard(r, cleanups) {
  const data = topWithOther(r.byInstance, 8, (count) => t('stats.otherInstances', { count })).map((v) => ({
    id: v.id,
    exists: v.exists,
    label: v.dim ? v.label : v.exists === false ? t('stats.deletedInstance', { name: v.name }) : v.name,
    value: v.ms,
    dim: v.dim || v.exists === false,
    tip: v.lastPlayed ? t('stats.instanceTip', { time: fmtDuration(v.ms), count: v.sessions, ago: fmtAgo(v.lastPlayed) }) : t('stats.barTip', { time: fmtDuration(v.ms), count: v.sessions }),
  }));
  return barsCard(
    {
      icon: 'layers',
      title: t('stats.instancesTitle'),
      sub: t('stats.instancesSub'),
      data,
      aria: t('stats.instancesTitle'),
      onSelect: (d) => {
        if (d.exists) navigate(`instance/${d.id}`);
      },
    },
    cleanups,
  );
}

function recordsCard(r) {
  const rec = r.records;
  const tt = r.totals;
  const sinceFirst = r.firstPlay ? Math.max(1, Math.round((startOfDay() - startOfDay(r.firstPlay)) / 86400000) + 1) : 0;
  const rows = [
    rec.longestSession && { icon: 'zap', label: t('stats.recLongest'), value: fmtDuration(rec.longestSession.ms), sub: t('stats.recLongestSub', { date: fmtDate(rec.longestSession.start), name: rec.longestSession.name }) },
    rec.bestDay && { icon: 'sun', label: t('stats.recBestDay'), value: fmtDuration(rec.bestDay.ms), sub: fmtLongDay(rec.bestDay.day) },
    rec.bestWeek && { icon: 'calendar', label: t('stats.recBestWeek'), value: fmtDuration(rec.bestWeek.ms), sub: t('stats.weekOf', { date: fmtDayKey(rec.bestWeek.start) }) },
    r.streak.longest.days > 0 && {
      icon: 'flame',
      label: t('stats.recStreak'),
      value: t('stats.days', { count: r.streak.longest.days }),
      sub: r.streak.longest.days > 1 ? t('stats.recStreakSub', { from: fmtDayKey(r.streak.longest.from), to: fmtDayKey(r.streak.longest.to) }) : fmtDayKey(r.streak.longest.from),
    },
    rec.busiestDay && { icon: 'gamepad', label: t('stats.recBusiest'), value: t('stats.sessionsCount', { count: rec.busiestDay.count }), sub: fmtLongDay(rec.busiestDay.day) },
    r.firstPlay && { icon: 'history', label: t('stats.recFirst'), value: fmtDate(r.firstPlay), sub: fmtAgo(r.firstPlay) },
    { icon: 'rocket', label: t('stats.recLaunches'), value: fmtInt(tt.launches), sub: tt.failedLaunches ? t('stats.recFailed', { count: tt.failedLaunches }) : t('stats.recNoFailed') },
    sinceFirst > 0 && { icon: 'activity', label: t('stats.recDaysPlayed'), value: fmtInt(tt.daysPlayed), sub: t('stats.recDaysPlayedSub', { pct: fmtPct(Math.min(1, tt.daysPlayed / sinceFirst)) }) },
  ].filter(Boolean);
  // Mosaicos: rotulo con icono, la marca grande y el detalle (cortado con … y completo en el title)
  return card(
    { icon: 'trophy', title: t('stats.recordsTitle'), sub: t('stats.recordsSub'), cls: 'st-records-card' },
    h(
      'ul',
      { class: 'st-records' },
      rows.map((row) =>
        h(
          'li',
          { class: 'st-record' },
          h('div', { class: 'st-rec-label' }, h('span', { class: 'st-rec-icon' }, icon(row.icon)), h('span', { class: 'ellipsis', title: row.label }, row.label)),
          h('div', { class: 'st-rec-value num ellipsis', title: row.value }, row.value),
          h('div', { class: 'st-rec-sub ellipsis', title: row.sub }, row.sub),
        ),
      ),
    ),
  );
}

async function openCrashTools(instanceId) {
  try {
    const [m] = await Promise.all([import('../../features/crash.js'), loadNs('crash')]);
    m.openCrashTools(instanceId);
  } catch (err) {
    fail(t('stats.crashToolsError'), err);
  }
}

function crashItem(c) {
  const name = c.exists === false ? t('stats.deletedInstance', { name: c.name }) : c.name;
  // Un tipo de error que esta version no conoce se omite (en lugar de mostrar la clave cruda)
  const kindKey = c.reasonKind ? `stats.crashKind_${c.reasonKind}` : null;
  return h(
    'div',
    { class: 'list-item st-crash-item' },
    h('div', { class: 'li-icon st-crash-icon' }, icon('bug')),
    h(
      'div',
      { class: 'li-main' },
      h(
        'div',
        { class: 'st-crash-head' },
        h('span', { class: 'li-title', title: name }, name),
        kindKey && has(kindKey) ? h('span', { class: 'badge bad' }, t(kindKey)) : null,
        c.code !== null && c.code !== undefined ? h('span', { class: 'badge num', title: t('stats.exitCode') }, t('stats.exitCodeValue', { code: c.code })) : null,
      ),
      h('div', { class: 'li-sub' }, t('stats.crashSub', { date: fmtDate(c.start, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }), version: c.mcVersion || '?', time: fmtDuration(c.duration) })),
      c.reason ? h('div', { class: 'st-crash-reason mono selectable', title: c.reason }, c.reason) : null,
    ),
    c.exists !== false
      ? h('button', { class: 'btn ghost sm st-crash-tools', type: 'button', title: t('stats.crashToolsHint'), onclick: () => openCrashTools(c.instanceId) }, icon('wrench'), t('stats.crashTools'))
      : null,
  );
}

function crashCard(r) {
  const tt = r.totals;
  const rate = tt.crashRate;
  const level = rate < 0.05 ? 'good' : rate < 0.15 ? 'warn' : 'bad';
  const summary = h(
    'div',
    { class: 'st-crash-summary' },
    h('div', { class: 'st-crash-rate num' }, fmtPct(rate, rate > 0 && rate < 0.1 ? 1 : 0)),
    h(
      'div',
      { class: 'st-crash-meta' },
      h('div', { class: 'st-crash-label' }, t('stats.crashRate')),
      h('div', { class: 'small muted' }, t('stats.crashOf', { count: tt.crashes, total: fmtInt(tt.sessions) })),
      h('div', { class: `progress st-meter-${level}`, role: 'img', 'aria-label': t('stats.crashRate') }, h('i', { style: { width: `${rate > 0 ? Math.max(2, Math.min(100, rate * 100)) : 0}%` } })),
    ),
    h('span', { class: `pill ${level}` }, icon(level === 'good' ? 'shieldCheck' : 'shieldAlert'), t(`stats.crashLevel_${level}`)),
  );
  const listBox = h('div', { class: 'list st-crash-list' });
  let showAll = false;
  const more = h('button', { class: 'btn ghost sm', type: 'button' });
  const draw = () => {
    const items = showAll ? r.crashes : r.crashes.slice(0, 5);
    mount(listBox, items.map(crashItem));
    mount(more, icon(showAll ? 'chevronLeft' : 'chevronDown'), showAll ? t('stats.showLess') : t('stats.showAllCount', { count: r.crashes.length }));
    more.classList.toggle('hidden', r.crashes.length <= 5);
  };
  more.addEventListener('click', () => {
    showAll = !showAll;
    draw();
  });
  draw();
  return card(
    { icon: 'alert', title: t('stats.crashTitle'), sub: t('stats.crashSubtitle'), cls: 'st-crash-card' },
    summary,
    r.crashes.length ? [listBox, h('div', { class: 'st-more-row' }, more)] : h('div', { class: 'notice good' }, icon('check'), t('stats.noCrashes')),
  );
}

function systemCard(st) {
  const sys = st.sys;
  if (!sys) return card({ icon: 'monitor', title: t('stats.pcTitle'), sub: t('stats.pcSub') }, h('div', { class: 'chart-empty' }, t('stats.pcUnavailable')));
  const usedMem = sys.totalMem - sys.freeMem;
  const os = sys.platform === 'win32' ? 'Windows' : sys.platform === 'darwin' ? 'macOS' : sys.platform === 'linux' ? 'Linux' : sys.platform;
  return card(
    { icon: 'monitor', title: t('stats.pcTitle'), sub: t('stats.pcSub') },
    h(
      'dl',
      { class: 'sysinfo st-sysinfo' },
      h('dt', {}, t('stats.pcOs')),
      h('dd', {}, t('stats.pcOsValue', { os, release: sys.release, arch: sys.arch })),
      h('dt', {}, t('stats.pcCpu')),
      h('dd', { class: 'ellipsis', title: sys.cpuModel }, t('stats.pcCpuValue', { model: sys.cpuModel, count: sys.cpuCores })),
      h('dt', {}, t('stats.pcGpu')),
      h('dd', { class: 'ellipsis', title: sys.gpu }, sys.gpu),
      h('dt', {}, t('stats.pcRam')),
      h('dd', {}, t('stats.pcRamValue', { total: fmtBytes(sys.totalMem), used: fmtBytes(usedMem) })),
      h('dt', {}, t('stats.pcJava')),
      h('dd', {}, st.runtimes?.length ? st.runtimes.map((x) => t('stats.pcJavaItem', { major: x.major })).join(', ') : t('stats.pcJavaAuto')),
    ),
  );
}

function storageCard(st, cleanups) {
  const keys = ['assets', 'libraries', 'versions', 'runtime', 'instances', 'servers', 'cache'];
  const data = Object.entries(st.usage || {})
    .map(([k, v]) => ({ label: keys.includes(k) ? t(`stats.disk_${k}`) : k, value: v }))
    .filter((d) => d.value > 0)
    .sort((a, b) => b.value - a.value);
  const total = sum(data, (d) => d.value);
  const host = h('div', { class: 'st-chart' });
  if (data.length) cleanups.push(barChart(host, data, { format: fmtBytes, aria: t('stats.diskTitle') }));
  return card({ icon: 'drive', title: t('stats.diskTitle'), sub: t('stats.diskSub', { size: fmtBytes(total) }) }, data.length ? host : h('div', { class: 'chart-empty' }, t('stats.diskEmpty')));
}

export function render(panel, ctx) {
  const r = ctx.state.report;
  const cleanups = [];
  const parts = [];
  if (!r.totals.sessions) {
    parts.push(
      h(
        'section',
        { class: 'card st-card st-empty-card' },
        emptyState('chart', t('stats.emptyTitle'), t('stats.emptyText'), h('button', { class: 'btn primary', type: 'button', onclick: () => navigate('home') }, icon('play'), t('stats.emptyAction'))),
      ),
    );
  } else {
    parts.push(calendarCard(r, cleanups));
    parts.push(h('div', { class: 'st-grid st-grid-2 st-grid-lead' }, dailyCard(r, cleanups), whenCard(r, cleanups)));
    parts.push(trendCard(r, cleanups));
    parts.push(h('div', { class: 'st-grid st-grid-2' }, instancesCard(r, cleanups), playsCard(r, cleanups)));
    parts.push(recordsCard(r));
    parts.push(crashCard(r));
  }
  parts.push(h('div', { class: 'st-grid st-grid-2' }, systemCard(ctx.state), storageCard(ctx.state, cleanups)));
  mount(panel, h('div', { class: 'st-stack' }, parts));
  return () => cleanups.forEach((c) => c());
}
