// Contadores en pantalla: muertes, bloques minados y tiempo de sesion, desde que se abrio el juego. Lo dibuja OverlayView
// (widgets.js) con los eventos { kind: 'counters', deaths, mined, session, multiplayer } del proceso principal
// (src/main/modules/overlay/counters.js). Los bloques salen del archivo de estadisticas que el juego guarda cada pocos
// minutos, y en multijugador ese archivo no esta en la PC: el tooltip lo aclara. Sin imports de la interfaz.
import { h } from './dom.js';
import { fmtSession } from './perf.js';

export const COUNTERS_STALE_MS = 16000; // sin muestras nuevas (se cerro el juego), el widget se esconde
export const COUNTER_METRICS = ['deaths', 'mined', 'session'];

// Trazos fijos (estilo Lucide), nunca datos de afuera.
const ICONS = {
  deaths: '<circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><path d="M8 20v2h8v-2"/><path d="m12.5 17-.5-1-.5 1h1z"/><path d="M16 20a2 2 0 0 0 1.56-3.25 8 8 0 1 0-11.12 0A2 2 0 0 0 8 20"/>',
  mined: '<path d="M14.531 12.469 6.619 20.38a1 1 0 1 1-3-3l7.912-7.912"/><path d="M15.686 4.314A12.5 12.5 0 0 0 5.461 2.958 1 1 0 0 0 5.58 4.71a22 22 0 0 1 6.318 3.393"/><path d="M17.7 3.7a1 1 0 0 0-1.4 0l-4.6 4.6a1 1 0 0 0 0 1.4l2.6 2.6a1 1 0 0 0 1.4 0l4.6-4.6a1 1 0 0 0 0-1.4z"/><path d="M19.686 8.314a12.501 12.501 0 0 1 1.356 10.225 1 1 0 0 1-1.751-.119 22 22 0 0 0-3.393-6.319"/>',
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

export function hasCounters(ev) {
  return Boolean(ev) && COUNTER_METRICS.some((m) => isNum(ev[m]));
}

// Datos de ejemplo (vista previa de Ajustes y modo edicion).
export function sampleCounters() {
  return { deaths: 2, mined: 347, session: 2694, multiplayer: false };
}

export function fmtCount(n, lang) {
  if (!isNum(n)) return null;
  try {
    return Math.round(n).toLocaleString(lang || undefined);
  } catch {
    return String(Math.round(n));
  }
}

// El tiempo de sesion sigue corriendo entre muestra y muestra (llegan cada 5 s).
export function sessionNow(data, now) {
  if (!isNum(data?.session)) return null;
  const extra = isNum(data.at) && isNum(now) ? Math.max(0, (now - data.at) / 1000) : 0;
  return data.session + extra;
}

// Valor para mostrar de cada contador: null = no se sabe (se dibuja como "—")
export function counterValues(data, now, lang) {
  return {
    deaths: fmtCount(data?.deaths, lang),
    mined: fmtCount(data?.mined, lang),
    session: fmtSession(sessionNow(data, now)),
  };
}

// Dibuja el widget dentro de `inner` (conserva la etiqueta del modo edicion). Devuelve si hay algo que mostrar.
export function drawCounters(inner, cfg, data, { tr, now, lang }) {
  const show = cfg?.show && typeof cfg.show === 'object' ? cfg.show : {};
  const values = counterValues(data, now, lang);
  const items = COUNTER_METRICS.filter((m) => show[m] !== false).map((m) => {
    const text = values[m];
    const label = tr(`counter_${m}`);
    return h(
      'span',
      { class: ['ovl-perf-item', `ovl-count-${m}`, text === null && 'empty'], title: label },
      icon(m),
      h('span', { class: 'ovl-perf-val ovl-count-val' }, text ?? tr('perfNoData')),
      h('span', { class: 'ovl-perf-lab' }, label),
    );
  });
  if (!items.length) return false;
  const tag = inner.querySelector(':scope > .ovl-tag');
  inner.replaceChildren(...(tag ? [tag] : []), h('div', { class: 'ovl-perf ovl-counters', role: 'status', title: tr(data?.multiplayer ? 'countersHintMp' : 'countersHint'), 'aria-label': tr('w_counters') }, items));
  return true;
}
