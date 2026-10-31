// Graficos SVG de la pagina de Estadisticas (una sola serie por grafico, tono naranja de Venus).
// Todos se redibujan al cambiar el ancho del contenedor y muestran el valor con showTip/hideTip.
import { h, icon, mount, showTip, hideTip } from '../../ui.js';
import { t, locale } from '../../i18n.js';
import { timeScale, countScale, fmtAxisMin, fmtInt, dayKey, addDays, startOfDay, weekdayNames } from './format.js';

const SVG = 'http://www.w3.org/2000/svg';
export const s = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v);
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
};

// Llama a draw(ancho) al montar y cada vez que cambia el ancho del contenedor (no dibuja si esta oculto).
export function observe(host, draw) {
  let lastW = -1;
  let raf = 0;
  const run = () => {
    raf = 0;
    const w = Math.floor(host.clientWidth);
    if (w <= 0 || w === lastW) return;
    lastW = w;
    draw(w);
  };
  const ro = new ResizeObserver(() => {
    if (!raf) raf = requestAnimationFrame(run);
  });
  ro.observe(host);
  run();
  return () => {
    ro.disconnect();
    if (raf) cancelAnimationFrame(raf);
  };
}

function roundedTop(x, y, w, hgt) {
  const r = Math.min(4, w / 2, hgt);
  return `M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt}Z`;
}

function roundedRight(x, y, w, hgt) {
  const r = Math.min(4, hgt / 2, w);
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt - r}Q${x + w},${y + hgt} ${x + w - r},${y + hgt}H${x}Z`;
}

function axis(svg, { m, width, ih, ymax, step, fmt }) {
  for (let v = 0; v <= ymax + 1e-6; v += step) {
    const y = m.top + ih - (v / ymax) * ih;
    svg.append(s('line', { class: v === 0 ? 'axis-line' : 'grid-line', x1: m.left, x2: width - m.right, y1: y, y2: y }));
    svg.append(s('text', { class: 'tick', x: m.left - 8, y: y + 4, 'text-anchor': 'end' }, fmt(v)));
  }
}

// Columnas. data: [{ label, tip, value, ... }] (value en minutos si scale = 'time')
export function columnChart(host, data, { height = 200, labelEvery = 1, tipValue, scale = 'time', aria = '' }) {
  return observe(host, (width) => {
    const m = { top: 12, right: 6, bottom: 24, left: 46 };
    const iw = width - m.left - m.right;
    const ih = height - m.top - m.bottom;
    const maxV = Math.max(0, ...data.map((d) => d.value));
    const [ymax, step] = scale === 'time' ? timeScale(maxV) : countScale(maxV);
    const band = iw / data.length;
    const bw = Math.max(2, Math.min(24, band * 0.62));
    const every = Math.max(labelEvery, Math.ceil(30 / band));
    const svg = s('svg', { class: 'chart', width, height, role: 'img', 'aria-label': aria });
    axis(svg, { m, width, ih, ymax, step, fmt: scale === 'time' ? fmtAxisMin : fmtInt });
    data.forEach((d, i) => {
      const cx = m.left + band * i + band / 2;
      const bh = ymax ? (d.value / ymax) * ih : 0;
      const bar = d.value > 0 ? s('path', { class: ['bar', d.dim && 'st-dim'].filter(Boolean).join(' '), d: roundedTop(cx - bw / 2, m.top + ih - bh, bw, Math.max(bh, 1.5)) }) : null;
      if (bar) svg.append(bar);
      if (i % every === 0) svg.append(s('text', { class: 'tick', x: cx, y: height - 7, 'text-anchor': 'middle' }, d.label));
      const hit = s('rect', { class: 'bar-hit', x: m.left + band * i, y: m.top, width: band, height: ih });
      hit.addEventListener('mousemove', (e) => {
        bar?.classList.add('hover');
        showTip(e.clientX, e.clientY, d.tip || d.label, tipValue(d));
      });
      hit.addEventListener('mouseleave', () => {
        bar?.classList.remove('hover');
        hideTip();
      });
      svg.append(hit);
    });
    mount(host, svg);
  });
}

// Barras horizontales con categoria a la izquierda y valor en la punta.
// data: [{ label, value, tip?, dim? }]; onSelect(d) hace la fila clickeable (y enfocable con el teclado).
export function barChart(host, data, { format, aria = '', onSelect } = {}) {
  return observe(host, (width) => {
    const rowH = 32;
    const labelW = Math.min(180, Math.max(96, width * 0.34));
    const valueW = 86;
    const height = data.length * rowH + 2;
    const max = Math.max(1e-9, ...data.map((d) => d.value));
    const iw = Math.max(20, width - labelW - valueW - 10);
    const maxChars = Math.max(8, Math.floor(labelW / 7.2));
    const svg = s('svg', { class: 'chart st-bars', width, height, role: onSelect ? 'list' : 'img', 'aria-label': aria });
    data.forEach((d, i) => {
      const y = i * rowH + 6;
      const bw = Math.max(2, (d.value / max) * iw);
      const name = d.label.length > maxChars ? `${d.label.slice(0, maxChars - 1)}…` : d.label;
      svg.append(s('text', { class: ['cat', d.dim && 'st-dim-text'].filter(Boolean).join(' '), x: 0, y: y + 14 }, name));
      const bar = s('path', { class: ['bar', d.dim && 'st-dim'].filter(Boolean).join(' '), d: roundedRight(labelW, y + 2, bw, 16) });
      svg.append(bar);
      svg.append(s('text', { class: 'val', x: labelW + bw + 8, y: y + 15 }, format(d.value)));
      const hit = s('rect', { class: ['bar-hit', onSelect && 'st-clickable'].filter(Boolean).join(' '), x: 0, y: y - 2, width, height: rowH - 4, rx: 6 });
      const enter = (e) => {
        bar.classList.add('hover');
        if (e) showTip(e.clientX, e.clientY, d.label, d.tip || format(d.value));
      };
      const leave = () => {
        bar.classList.remove('hover');
        hideTip();
      };
      hit.addEventListener('mousemove', enter);
      hit.addEventListener('mouseleave', leave);
      if (onSelect) {
        hit.setAttribute('tabindex', '0');
        hit.setAttribute('role', 'listitem');
        hit.setAttribute('aria-label', `${d.label}: ${format(d.value)}`);
        hit.addEventListener('click', () => onSelect(d));
        hit.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect(d);
          }
        });
        hit.addEventListener('focus', () => bar.classList.add('hover'));
        hit.addEventListener('blur', leave);
      }
      svg.append(hit);
    });
    mount(host, svg);
  });
}

// Linea + area (una serie) con cursor de seguimiento y linea de promedio opcional.
// data: [{ value (minutos), axis?: texto del eje x, ... }]
export function lineChart(host, data, { height = 200, tipTitle, tipValue, avg = 0, avgLabel = '', aria = '' }) {
  return observe(host, (width) => {
    const m = { top: 14, right: 14, bottom: 24, left: 46 };
    const iw = width - m.left - m.right;
    const ih = height - m.top - m.bottom;
    const [ymax, step] = timeScale(Math.max(0, avg, ...data.map((d) => d.value)));
    const x = (i) => m.left + (data.length < 2 ? iw / 2 : (i / (data.length - 1)) * iw);
    const y = (v) => m.top + ih - (ymax ? (v / ymax) * ih : 0);
    const svg = s('svg', { class: 'chart st-linechart', width, height, role: 'img', 'aria-label': aria });
    axis(svg, { m, width, ih, ymax, step, fmt: fmtAxisMin });
    const pts = data.map((d, i) => [x(i), y(d.value)]);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
    svg.append(s('path', { class: 'st-area', d: `${line}L${x(data.length - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z` }));
    svg.append(s('path', { class: 'st-stroke', d: line }));
    if (avg > 0) {
      const ya = y(avg);
      svg.append(s('line', { class: 'st-avg', x1: m.left, x2: width - m.right, y1: ya, y2: ya }));
      svg.append(s('text', { class: 'tick st-avg-label', x: width - m.right, y: ya - 6, 'text-anchor': 'end' }, avgLabel));
    }
    data.forEach((d, i) => {
      if (d.axis) svg.append(s('text', { class: 'tick', x: x(i), y: height - 7, 'text-anchor': i === 0 ? 'start' : 'middle' }, d.axis));
    });
    const lastP = pts[pts.length - 1];
    if (lastP) svg.append(s('circle', { class: 'st-dot', cx: lastP[0], cy: lastP[1], r: 4 }));
    const cross = s('line', { class: 'st-cross', y1: m.top, y2: m.top + ih, visibility: 'hidden' });
    const dot = s('circle', { class: 'st-dot', r: 4.5, visibility: 'hidden' });
    svg.append(cross, dot);
    const overlay = s('rect', { class: 'bar-hit', x: m.left - 6, y: m.top, width: iw + 12, height: ih });
    overlay.addEventListener('mousemove', (e) => {
      const r = svg.getBoundingClientRect();
      const i = Math.max(0, Math.min(data.length - 1, Math.round(((e.clientX - r.left - m.left) / Math.max(1, iw)) * (data.length - 1))));
      for (const [k, v] of [
        ['x1', x(i)],
        ['x2', x(i)],
      ])
        cross.setAttribute(k, v);
      cross.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', x(i));
      dot.setAttribute('cy', y(data[i].value));
      dot.setAttribute('visibility', 'visible');
      showTip(e.clientX, e.clientY, tipTitle(data[i]), tipValue(data[i]));
    });
    overlay.addEventListener('mouseleave', () => {
      cross.setAttribute('visibility', 'hidden');
      dot.setAttribute('visibility', 'hidden');
      hideTip();
    });
    svg.append(overlay);
    mount(host, svg);
  });
}

// Niveles 1..4 por cuartiles de los valores con juego (como el calendario de GitHub)
function levels(values) {
  const nz = values.filter((v) => v > 0).sort((a, b) => a - b);
  const q = (p) => (nz.length ? nz[Math.min(nz.length - 1, Math.floor(p * nz.length))] : 0);
  const [q1, q2, q3] = [q(0.25), q(0.5), q(0.75)];
  return (v) => (!(v > 0) ? 0 : v <= q1 ? 1 : v <= q2 ? 2 : v <= q3 ? 3 : 4);
}

// Calendario de actividad: columnas = semanas, filas = dias. values: { 'YYYY-MM-DD': ms }
export function calendarHeatmap(host, { values, end = new Date(), weeks = 53, firstDay = 1, tip, aria = '' }) {
  return observe(host, (width) => {
    const labelW = 30;
    const top = 16;
    const gap = width < 560 ? 2 : 3;
    const cell = Math.max(6, Math.min(16, Math.floor((width - labelW - gap * (weeks - 1)) / weeks)));
    const gridW = weeks * cell + (weeks - 1) * gap;
    const height = top + 7 * cell + 6 * gap + 2;
    const last = startOfDay(end);
    const lastRow = (last.getDay() - firstDay + 7) % 7;
    const start = addDays(last, -((weeks - 1) * 7 + lastRow));
    const keys = [];
    for (let d = new Date(start); d <= last; d = addDays(d, 1)) keys.push(dayKey(d));
    const level = levels(keys.map((k) => values[k] || 0));
    const todayKey = dayKey(new Date());
    const svg = s('svg', { class: 'chart st-cal', width: labelW + gridW, height, role: 'img', 'aria-label': aria });
    const names = weekdayNames('short');
    for (const row of [1, 3, 5]) svg.append(s('text', { class: 'tick', x: 0, y: top + row * (cell + gap) + cell * 0.82 }, names[(firstDay + row) % 7]));
    // Meses: etiqueta donde cambia el mes (si hay lugar)
    const starts = [];
    for (let col = 0; col < weeks; col++) {
      const d = addDays(start, col * 7);
      if (!starts.length || starts[starts.length - 1].month !== d.getMonth()) starts.push({ col, month: d.getMonth(), date: d });
    }
    starts.forEach((st, i) => {
      const next = starts[i + 1];
      if (next && next.col - st.col < 3) return;
      svg.append(s('text', { class: 'tick', x: labelW + st.col * (cell + gap), y: 11 }, st.date.toLocaleDateString(locale(), { month: 'short' }).replace('.', '')));
    });
    keys.forEach((k, i) => {
      const col = Math.floor(i / 7);
      const row = i % 7;
      svg.append(s('rect', { class: `st-hm st-l${level(values[k] || 0)}${k === todayKey ? ' st-today' : ''}`, x: labelW + col * (cell + gap), y: top + row * (cell + gap), width: cell, height: cell, rx: Math.min(3, cell / 4), 'data-k': k }));
    });
    let hovered = null;
    svg.addEventListener('mousemove', (e) => {
      const k = e.target?.getAttribute?.('data-k');
      if (hovered && hovered !== e.target) hovered.classList.remove('hover');
      if (!k) {
        hovered = null;
        hideTip();
        return;
      }
      hovered = e.target;
      hovered.classList.add('hover');
      const [title, value] = tip(k);
      showTip(e.clientX, e.clientY, title, value);
    });
    svg.addEventListener('mouseleave', () => {
      hovered?.classList.remove('hover');
      hovered = null;
      hideTip();
    });
    mount(host, svg);
  });
}

// Mapa de calor dia de la semana x hora. rows: [{ label, values: [24] }]; tip(rowIndex, hour) -> [titulo, valor]
export function matrixHeatmap(host, { rows, tip, aria = '' }) {
  return observe(host, (width) => {
    const labelW = 40;
    const gap = 2;
    const cellW = Math.max(6, (width - labelW - gap * 23) / 24);
    const cellH = Math.max(14, Math.min(22, cellW * 0.78));
    const bottom = 18;
    const height = rows.length * (cellH + gap) + bottom;
    const level = levels(rows.flatMap((r) => r.values));
    const svg = s('svg', { class: 'chart st-matrix', width, height, role: 'img', 'aria-label': aria });
    rows.forEach((r, ri) => {
      const y = ri * (cellH + gap);
      svg.append(s('text', { class: 'tick', x: 0, y: y + cellH * 0.72 }, r.label));
      r.values.forEach((v, hr) => {
        svg.append(s('rect', { class: `st-hm st-l${level(v)}`, x: labelW + hr * (cellW + gap), y, width: cellW, height: cellH, rx: 3, 'data-r': ri, 'data-h': hr }));
      });
    });
    for (let hr = 0; hr < 24; hr += 3) svg.append(s('text', { class: 'tick', x: labelW + hr * (cellW + gap) + cellW / 2, y: height - 4, 'text-anchor': 'middle' }, `${hr}h`));
    let hovered = null;
    svg.addEventListener('mousemove', (e) => {
      const r = e.target?.getAttribute?.('data-r');
      if (hovered && hovered !== e.target) hovered.classList.remove('hover');
      if (r === null || r === undefined) {
        hovered = null;
        hideTip();
        return;
      }
      hovered = e.target;
      hovered.classList.add('hover');
      const [title, value] = tip(Number(r), Number(e.target.getAttribute('data-h')));
      showTip(e.clientX, e.clientY, title, value);
    });
    svg.addEventListener('mouseleave', () => {
      hovered?.classList.remove('hover');
      hovered = null;
      hideTip();
    });
    mount(host, svg);
  });
}

// Leyenda de la escala de los mapas de calor: Menos ■■■■■ Mas
export function heatLegend() {
  return h(
    'div',
    { class: 'st-heat-legend', 'aria-hidden': 'true' },
    h('span', {}, t('stats.less')),
    [0, 1, 2, 3, 4].map((l) => h('i', { class: `st-sw st-l${l}` })),
    h('span', {}, t('stats.more')),
  );
}

// Anillo de progreso (un solo valor). cls 'st-ring-count': anillo entero y tenue para una cantidad sin total.
export function ring(fraction, { size = 120, stroke = 10, label = '', sub = '', aria = '', cls = '' } = {}) {
  const f = Math.max(0, Math.min(1, Number(fraction) || 0));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const mid = size / 2;
  return s(
    'svg',
    { class: ['st-ring', cls].filter(Boolean).join(' '), width: size, height: size, viewBox: `0 0 ${size} ${size}`, role: 'img', 'aria-label': aria },
    s('circle', { class: 'st-ring-track', cx: mid, cy: mid, r, 'stroke-width': stroke }),
    f > 0 ? s('circle', { class: 'st-ring-fill', cx: mid, cy: mid, r, 'stroke-width': stroke, 'stroke-dasharray': `${(c * f).toFixed(2)} ${c.toFixed(2)}`, transform: `rotate(-90 ${mid} ${mid})` }) : null,
    s('text', { class: 'st-ring-label', x: mid, y: sub ? mid - 2 : mid + 6, 'text-anchor': 'middle' }, label),
    sub ? s('text', { class: 'st-ring-sub', x: mid, y: mid + 17, 'text-anchor': 'middle' }, sub) : null,
  );
}

// Barra apilada (partes de un total) con hueco de 2px entre segmentos. parts: [{ value, cls, label }]
export function splitBar(parts, aria = '') {
  const total = parts.reduce((a, p) => a + (p.value > 0 ? p.value : 0), 0);
  return h(
    'div',
    { class: 'st-split', role: 'img', 'aria-label': aria },
    total > 0 ? parts.filter((p) => p.value > 0).map((p) => h('i', { class: p.cls, style: { flexGrow: String(p.value / total) }, title: p.label })) : h('i', { class: 'st-split-empty' }),
  );
}

// Tabla simple para la vista alternativa de un grafico
export function dataTable(headers, rows, cls = '') {
  return h(
    'table',
    { class: ['table', 'st-table', cls] },
    h('thead', {}, h('tr', {}, headers.map((x, i) => h('th', { class: i ? 'num' : null }, x)))),
    h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c, i) => h('td', { class: i ? 'num' : null }, c))))),
  );
}

// Boton "Ver tabla / Ver grafico" que alterna dos vistas del mismo dato
export function viewToggle(chartEl, tableEl) {
  const btn = h('button', { class: 'btn ghost sm', type: 'button' });
  const draw = () => {
    const showingTable = !tableEl.classList.contains('hidden');
    mount(btn, icon(showingTable ? 'chart' : 'list'), showingTable ? t('stats.viewChart') : t('stats.viewTable'));
    btn.setAttribute('aria-pressed', String(showingTable));
  };
  tableEl.classList.add('hidden');
  btn.addEventListener('click', () => {
    const toTable = tableEl.classList.contains('hidden');
    tableEl.classList.toggle('hidden', !toTable);
    chartEl.classList.toggle('hidden', toTable);
    draw();
  });
  draw();
  return btn;
}
