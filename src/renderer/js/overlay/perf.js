// Widget de rendimiento del overlay (3.1): FPS, RAM y CPU del proceso del juego, ping del servidor y tiempo de sesion.
// Lo dibuja OverlayView (widgets.js) con los eventos { kind: 'perf', fps?, ram, cpu, ping, session } que manda el proceso
// principal cada 2 s (src/main/modules/overlay/perf.js). Los FPS no se pueden medir desde afuera del juego: los informa el
// mod Venus Badge y, sin el mod, el tooltip lo explica. Sin imports de la interfaz (la pagina del overlay no carga ui.js).
import { h } from './dom.js';

export const PERF_STALE_MS = 6000; // sin muestras nuevas, el widget se esconde
export const PERF_METRICS = ['fps', 'ram', 'cpu', 'ping', 'session'];

// Trazos fijos (estilo Lucide), nunca datos de afuera.
const ICONS = {
  fps: '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
  ram: '<path d="M6 19v-3"/><path d="M10 19v-3"/><path d="M14 19v-3"/><path d="M18 19v-3"/><path d="M8 11V9"/><path d="M16 11V9"/><path d="M12 11V9"/><path d="M2 15h20"/><path d="M2 7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v1.1a2 2 0 0 0 0 3.837V17a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-5.1a2 2 0 0 0 0-3.837Z"/>',
  cpu: '<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/>',
  ping: '<path d="M12 20h.01"/><path d="M2 8.82a15 15 0 0 1 20 0"/><path d="M5 12.859a10 10 0 0 1 14 0"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/>',
  session: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
};

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name] || ICONS.session;
  return svg;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// Hay algo para mostrar? (un evento con todo en null apaga el widget)
export function hasPerfData(ev) {
  return Boolean(ev) && PERF_METRICS.some((m) => isNum(ev[m]));
}

// Datos de ejemplo (vista previa de Ajustes y modo edicion).
export function samplePerf() {
  return { fps: 144, ram: 2048, cpu: 23, ping: 48, session: 2694 };
}

export function fmtFps(n) {
  return isNum(n) ? String(Math.round(n)) : null;
}

export function fmtRam(mb) {
  if (!isNum(mb)) return null;
  return mb >= 10000 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

export function fmtCpu(pct) {
  return isNum(pct) ? `${Math.round(pct)} %` : null;
}

export function fmtPing(ms) {
  return isNum(ms) ? `${Math.round(ms)} ms` : null;
}

export function fmtSession(sec) {
  if (!isNum(sec)) return null;
  const s = Math.max(0, Math.floor(sec));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

const FORMAT = { fps: fmtFps, ram: fmtRam, cpu: fmtCpu, ping: fmtPing, session: fmtSession };
const LABEL = { fps: 'perfFps', ram: 'perfRam', cpu: 'perfCpu', ping: 'perfPing', session: 'perfSession' };

// Dibuja el widget dentro de `inner` (conserva la etiqueta del modo edicion). Devuelve si hay algo que mostrar.
export function drawPerf(inner, cfg, data, { tr }) {
  const show = cfg?.show && typeof cfg.show === 'object' ? cfg.show : {};
  const items = PERF_METRICS.filter((m) => show[m] !== false).map((m) => {
    const text = FORMAT[m](data?.[m]);
    return h(
      'span',
      { class: ['ovl-perf-item', `ovl-perf-${m}`, text === null && 'empty'] },
      icon(m),
      h('span', { class: 'ovl-perf-val' }, text ?? tr('perfNoData')),
      h('span', { class: 'ovl-perf-lab' }, tr(LABEL[m])),
    );
  });
  if (!items.length) return false;
  const tag = inner.querySelector(':scope > .ovl-tag');
  inner.replaceChildren(...(tag ? [tag] : []), h('div', { class: 'ovl-perf', role: 'status', title: isNum(data?.fps) ? null : tr('perfNoFps'), 'aria-label': tr('w_perf') }, items));
  return true;
}
