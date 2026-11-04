// Armado de pantallas con nodos. Nada acá usa innerHTML: el texto de otras personas siempre llega como textContent.

const SVG = 'http://www.w3.org/2000/svg';

// Trazos de los íconos del launcher (src/renderer/js/ui.js)
const ICONS = {
  users: [['path', { d: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2' }], ['circle', { cx: 9, cy: 7, r: 4 }], ['path', { d: 'M22 21v-2a4 4 0 0 0-3-3.87' }], ['path', { d: 'M16 3.13a4 4 0 0 1 0 7.75' }]],
  userPlus: [['path', { d: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2' }], ['circle', { cx: 9, cy: 7, r: 4 }], ['line', { x1: 19, x2: 19, y1: 8, y2: 14 }], ['line', { x1: 22, x2: 16, y1: 11, y2: 11 }]],
  message: [['path', { d: 'M7.9 20A9 9 0 1 0 4 16.1L2 22Z' }]],
  play: [['polygon', { points: '6 3 20 12 6 21 6 3', fill: 'currentColor' }]],
  image: [['rect', { width: 18, height: 18, x: 3, y: 3, rx: 2, ry: 2 }], ['circle', { cx: 9, cy: 9, r: 2 }], ['path', { d: 'm21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21' }]],
  film: [['rect', { width: 18, height: 18, x: 3, y: 3, rx: 2 }], ['path', { d: 'M7 3v18' }], ['path', { d: 'M17 3v18' }], ['path', { d: 'M3 12h18' }], ['path', { d: 'M3 7.5h4' }], ['path', { d: 'M3 16.5h4' }], ['path', { d: 'M17 7.5h4' }], ['path', { d: 'M17 16.5h4' }]],
  bell: [['path', { d: 'M10.268 21a2 2 0 0 0 3.464 0' }], ['path', { d: 'M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326' }]],
  back: [['path', { d: 'm12 19-7-7 7-7' }], ['path', { d: 'M19 12H5' }]],
  send: [['path', { d: 'M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z' }], ['path', { d: 'm21.854 2.147-10.94 10.939' }]],
  copy: [['rect', { width: 14, height: 14, x: 8, y: 8, rx: 2, ry: 2 }], ['path', { d: 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2' }]],
  check: [['path', { d: 'M20 6 9 17l-5-5' }]],
  x: [['path', { d: 'M18 6 6 18' }], ['path', { d: 'm6 6 12 12' }]],
  external: [['path', { d: 'M15 3h6v6' }], ['path', { d: 'M10 14 21 3' }], ['path', { d: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' }]],
  logout: [['path', { d: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4' }], ['polyline', { points: '16 17 21 12 16 7' }], ['line', { x1: 21, x2: 9, y1: 12, y2: 12 }]],
  gamepad: [['line', { x1: 6, x2: 10, y1: 12, y2: 12 }], ['line', { x1: 8, x2: 8, y1: 10, y2: 14 }], ['line', { x1: 15, x2: 15.01, y1: 13, y2: 13 }], ['line', { x1: 18, x2: 18.01, y1: 11, y2: 11 }], ['rect', { width: 20, height: 12, x: 2, y: 6, rx: 2 }]],
  download: [['path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }], ['polyline', { points: '7 10 12 15 17 10' }], ['line', { x1: 12, x2: 12, y1: 15, y2: 3 }]],
  refresh: [['path', { d: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' }], ['path', { d: 'M21 3v5h-5' }], ['path', { d: 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' }], ['path', { d: 'M8 16H3v5' }]],
  user: [['path', { d: 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2' }], ['circle', { cx: 12, cy: 7, r: 4 }]],
  alert: [['path', { d: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3' }], ['path', { d: 'M12 9v4' }], ['path', { d: 'M12 17h.01' }]],
  trash: [['path', { d: 'M3 6h18' }], ['path', { d: 'M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6' }], ['path', { d: 'M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2' }]],
};

export function icon(name, size = 22) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('ico');
  for (const [tag, attrs] of ICONS[name] || []) {
    const el = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    svg.append(el);
  }
  return svg;
}

const FORBIDDEN = new Set(['innerHTML', 'outerHTML', 'srcdoc']);

// h('button', { class: 'x', onclick: fn }, 'texto', otroNodo): las cadenas siempre son nodos de texto.
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false || FORBIDDEN.has(k)) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'required' || k === 'open') el[k] = Boolean(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, kids);
  return el;
}

function append(el, kids) {
  for (const kid of kids) {
    if (kid === null || kid === undefined || kid === false) continue;
    if (Array.isArray(kid)) append(el, kid);
    else if (kid instanceof Node) el.append(kid);
    else el.append(document.createTextNode(String(kid)));
  }
}

export function mount(el, ...kids) {
  el.replaceChildren();
  append(el, kids);
  return el;
}

// ---------- Avisos cortos ----------
let toastBox = null;
export function toast(text, kind = 'info') {
  if (!toastBox) {
    toastBox = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastBox);
  }
  const el = h('div', { class: `toast ${kind}` }, text);
  toastBox.append(el);
  setTimeout(() => el.remove(), 4200);
}

// ---------- Pregunta de sí o no ----------
export function confirmBox({ title, text, ok, cancel, danger = false }) {
  return new Promise((resolve) => {
    const finish = (value) => {
      dlg.close();
      dlg.remove();
      resolve(value);
    };
    const dlg = h(
      'dialog',
      { class: 'sheet', 'aria-labelledby': 'dlg-title' },
      h('h2', { id: 'dlg-title' }, title),
      text ? h('p', { class: 'muted' }, text) : null,
      h('div', { class: 'sheet-actions' }, h('button', { class: 'btn ghost', type: 'button', onclick: () => finish(false) }, cancel), h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, type: 'button', onclick: () => finish(true) }, ok)),
    );
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      finish(false);
    });
    document.body.append(dlg);
    dlg.showModal();
  });
}

// El círculo con la inicial: no se pide ninguna imagen a terceros.
export function avatar(name, tone, size = '') {
  const first = [...String(name || '').trim()][0] || '?';
  return h('span', { class: `avatar tone-${tone} ${size}`, 'aria-hidden': 'true' }, first.toUpperCase());
}

export function spinner(label) {
  return h('div', { class: 'spinner-wrap', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), label ? h('span', { class: 'muted' }, label) : null);
}

export function emptyState(iconName, title, text, action = null) {
  return h('div', { class: 'empty' }, h('span', { class: 'empty-ico' }, icon(iconName, 30)), h('h2', {}, title), text ? h('p', { class: 'muted' }, text) : null, action);
}

export function notice(kind, text, action = null) {
  return h('div', { class: `notice ${kind}`, role: kind === 'bad' ? 'alert' : 'status' }, icon(kind === 'bad' || kind === 'warn' ? 'alert' : 'bell', 20), h('div', { class: 'notice-text' }, text), action);
}
