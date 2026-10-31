// Utilidades de interfaz: creacion de elementos, iconos, modales, toasts y formatos.
import { t, locale } from './i18n.js';

export function h(tag, props = {}, ...children) {
  const el = tag === 'svg' || props?.svg ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false || k === 'svg') continue;
    if (k === 'class') el.setAttribute('class', Array.isArray(v) ? v.filter(Boolean).join(' ') : v);
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith('--')) el.style.setProperty(sk, sv);
        else el.style[sk] = sv;
      }
    }
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value' && 'value' in el) el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'multiple') el[k] = Boolean(v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function mount(el, ...children) {
  clear(el);
  append(el, children);
  return el;
}

// ---------- Iconos (estilo Lucide, trazo 2px) ----------
const ICONS = {
  home: '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  chart: '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
  layers: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
  package: '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  memory: '<path d="M6 19v-3"/><path d="M10 19v-3"/><path d="M14 19v-3"/><path d="M18 19v-3"/><path d="M8 11V9"/><path d="M16 11V9"/><path d="M12 11V9"/><path d="M2 15h20"/><path d="M2 7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v1.1a2 2 0 0 0 0 3.837V17a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-5.1a2 2 0 0 0 0-3.837Z"/>',
  server: '<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>',
  mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/>',
  micOff: '<line x1="2" x2="22" y1="2" y2="22"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 12 5"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><line x1="12" x2="12" y1="19" y2="22"/>',
  message: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  github: '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3" fill="currentColor"/>',
  stop: '<rect width="14" height="14" x="5" y="5" rx="2" fill="currentColor"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  card: '<rect width="20" height="14" x="2" y="5" rx="2"/><path d="M2 10h20"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  volume: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>',
  headphones: '<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/>',
  headphonesOff: '<path d="M21 14h-1.343"/><path d="M9.128 3.47A9 9 0 0 1 21 12v3.343"/><path d="m2 2 20 20"/><path d="M20.414 20.414A2 2 0 0 1 19 21h-1a2 2 0 0 1-2-2v-3"/><path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 2.636-6.364"/>',
  phoneOff: '<path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"/><line x1="22" x2="2" y1="2" y2="22"/>',
  send: '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  userPlus: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  wifi: '<path d="M12 20h.01"/><path d="M2 8.82a15 15 0 0 1 20 0"/><path d="M5 12.859a10 10 0 0 1 14 0"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/>',
  wifiOff: '<path d="M12 20h.01"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/><path d="M5 12.859a10 10 0 0 1 5.17-2.69"/><path d="M19 12.859a10 10 0 0 0-2.007-1.523"/><path d="M2 8.82a15 15 0 0 1 4.177-2.643"/><path d="M22 8.82a15 15 0 0 0-11.288-3.764"/><path d="m2 2 20 20"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
  edit: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  puzzle: '<path d="M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z"/>',
  palette: '<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  coffee: '<path d="M10 2v2"/><path d="M14 2v2"/><path d="M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1"/><path d="M6 2v2"/>',
  drive: '<line x1="22" x2="2" y1="12" y2="12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" x2="6.01" y1="16" y2="16"/><line x1="10" x2="10.01" y1="16" y2="16"/>',
  gamepad: '<line x1="6" x2="10" y1="12" y2="12"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="15" x2="15.01" y1="13" y2="13"/><line x1="18" x2="18.01" y1="11" y2="11"/><rect width="20" height="12" x="2" y="6" rx="2"/>',
  cpu: '<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>',
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  image: '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  rocket: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
  sliders: '<line x1="4" x2="4" y1="21" y2="14"/><line x1="4" x2="4" y1="10" y2="3"/><line x1="12" x2="12" y1="21" y2="12"/><line x1="12" x2="12" y1="8" y2="3"/><line x1="20" x2="20" y1="21" y2="16"/><line x1="20" x2="20" y1="12" y2="3"/><line x1="2" x2="6" y1="14" y2="14"/><line x1="10" x2="14" y1="8" y2="8"/><line x1="18" x2="22" y1="16" y2="16"/>',
  activity: '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
  ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
  upCircle: '<circle cx="12" cy="12" r="10"/><path d="m16 12-4-4-4 4"/><path d="M12 16V8"/>',
  monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  hash: '<line x1="4" x2="20" y1="9" y2="9"/><line x1="4" x2="20" y1="15" y2="15"/><line x1="10" x2="8" y1="3" y2="21"/><line x1="16" x2="14" y1="3" y2="21"/>',
  heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
  power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>',
  box: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  sparkles: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  map: '<path d="M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z"/><path d="M15 5.764v15"/><path d="M9 3.236v15"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  bug: '<path d="m8 2 1.88 1.88"/><path d="M14.12 3.88 16 2"/><path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M6 13H2"/><path d="M3 21c0-2.1 1.7-3.9 3.8-4"/><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/><path d="M22 13h-4"/><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" x2="15.42" y1="13.51" y2="17.49"/><line x1="15.41" x2="8.59" y1="6.51" y2="10.49"/>',
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
  cloudUpload: '<path d="M12 13v8"/><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="m8 17 4-4 4 4"/>',
  cloudDownload: '<path d="M12 13v8l-4-4"/><path d="m12 21 4-4"/><path d="M4.393 15.269A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.436 8.284"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  key: '<path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4"/><path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/>',
  eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>',
  wand: '<path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72"/><path d="m14 7 3 3"/><path d="M5 6v4"/><path d="M19 14v4"/><path d="M10 2v2"/><path d="M7 8H3"/><path d="M21 16h-4"/><path d="M11 3H9"/>',
  compass: '<path d="m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z"/><circle cx="12" cy="12" r="10"/>',
  swords: '<polyline points="14.5 17.5 3 6 3 3 6 3 17.5 14.5"/><line x1="13" x2="19" y1="19" y2="13"/><line x1="16" x2="20" y1="16" y2="20"/><line x1="19" x2="21" y1="21" y2="19"/><polyline points="14.5 6.5 18 3 21 3 21 6 17.5 9.5"/><line x1="5" x2="9" y1="14" y2="18"/><line x1="7" x2="4" y1="17" y2="20"/><line x1="3" x2="5" y1="19" y2="21"/>',
  skull: '<path d="m12.5 17-.5-1-.5 1h1z"/><path d="M15 22a1 1 0 0 0 1-1v-1a2 2 0 0 0 1.56-3.25 8 8 0 1 0-11.12 0A2 2 0 0 0 8 20v1a1 1 0 0 0 1 1z"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="12" r="1"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
  mountain: '<path d="m8 3 4 8 5-5 5 15H2L8 3z"/>',
  trophy: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
  calendar: '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
  list: '<path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M3 6h.01"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M8 6h13"/>',
  grid: '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
  filter: '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
  sort: '<path d="m21 16-4 4-4-4"/><path d="M17 20V4"/><path d="m3 8 4-4 4 4"/><path d="M7 4v16"/>',
  scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/>',
  tag: '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>',
  bell: '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>',
  languages: '<path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/>',
  accessibility: '<circle cx="16" cy="4" r="1"/><path d="m18 19 1-7-6 1"/><path d="m5 8 3-3 5.5 3-2.36 3.5"/><path d="M4.24 14.5a5 5 0 0 0 6.88 6"/><path d="M13.76 17.5a5 5 0 0 0-6.88-6"/>',
  keyboard: '<path d="M10 8h.01"/><path d="M12 12h.01"/><path d="M14 8h.01"/><path d="M16 12h.01"/><path d="M18 8h.01"/><path d="M6 8h.01"/><path d="M7 16h10"/><path d="M8 12h.01"/><rect width="20" height="16" x="2" y="4" rx="2"/>',
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>',
  save: '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/>',
  archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  plug: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
  network: '<rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/>',
  radio: '<path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"/><circle cx="12" cy="12" r="2"/><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"/><path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"/>',
  screenShare: '<path d="M13 3H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-3"/><path d="M8 21h8"/><path d="M12 17v4"/><path d="m17 8 5-5"/><path d="M17 3h5v5"/>',
  volumeX: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" x2="16" y1="9" y2="15"/><line x1="16" x2="22" y1="9" y2="15"/>',
  crown: '<path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z"/><path d="M5 21h14"/>',
  hammer: '<path d="m15 12-8.373 8.373a1 1 0 1 1-3-3L12 9"/><path d="m18 15 4-4"/><path d="m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172V7l-2.26-2.26a6 6 0 0 0-4.202-1.756L9 2.96l.92.82A6.18 6.18 0 0 1 12 8.4V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5"/>',
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  folderOpen: '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
  fileText: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>',
  gauge: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  crosshair: '<circle cx="12" cy="12" r="10"/><line x1="22" x2="18" y1="12" y2="12"/><line x1="6" x2="2" y1="12" y2="12"/><line x1="12" x2="12" y1="6" y2="2"/><line x1="12" x2="12" y1="22" y2="18"/>',
  zoomIn: '<circle cx="11" cy="11" r="8"/><line x1="21" x2="16.65" y1="21" y2="16.65"/><line x1="11" x2="11" y1="8" y2="14"/><line x1="8" x2="14" y1="11" y2="11"/>',
  zoomOut: '<circle cx="11" cy="11" r="8"/><line x1="21" x2="16.65" y1="21" y2="16.65"/><line x1="8" x2="14" y1="11" y2="11"/>',
  maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
  atSign: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
  smile: '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" x2="9.01" y1="9" y2="9"/><line x1="15" x2="15.01" y1="9" y2="9"/>',
  pause: '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
  skipForward: '<polygon points="5 4 15 12 5 20 5 4"/><line x1="19" x2="19" y1="5" y2="19"/>',
  arrowRight: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  arrowLeft: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  logIn: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" x2="3" y1="12" y2="12"/>',
  mail: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>',
  shieldCheck: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  shieldAlert: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  diff: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M11 18H8a2 2 0 0 1-2-2V9"/>',
  contrast: '<circle cx="12" cy="12" r="10"/><path d="M12 18a6 6 0 0 0 0-12v12z"/>',
  type: '<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" x2="15" y1="20" y2="20"/><line x1="12" x2="12" y1="4" y2="20"/>',
  trending: '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>',
  pickaxe: '<path d="M14.531 12.469 6.619 20.38a1 1 0 1 1-3-3l7.912-7.912"/><path d="M15.686 4.314A12.5 12.5 0 0 0 5.461 2.958 1 1 0 0 0 5.58 4.71a22 22 0 0 1 6.318 3.393"/><path d="M17.7 3.7a1 1 0 0 0-1.4 0l-4.6 4.6a1 1 0 0 0 0 1.4l2.6 2.6a1 1 0 0 0 1.4 0l4.6-4.6a1 1 0 0 0 0-1.4z"/><path d="M19.686 8.314a12.501 12.501 0 0 1 1.356 10.225 1 1 0 0 1-1.751-.119 22 22 0 0 0-3.393-6.319"/>',
};

// Otros modulos pueden sumar iconos propios: registerIcons({ miIcono: '<path d="..."/>' })
export function registerIcons(map) {
  Object.assign(ICONS, map);
}

export function icon(name, cls) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (cls) svg.setAttribute('class', cls);
  svg.innerHTML = ICONS[name] || ICONS.box;
  return svg;
}

// ---------- Movimiento ----------
// true si hay que evitar animaciones: Ajustes > Accesibilidad (body.reduce-motion) o la preferencia de Windows.
const motionQuery = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
export function reducedMotion() {
  return Boolean(document.body?.classList.contains('reduce-motion') || motionQuery?.matches);
}
// Duracion de las salidas (--dur de main.css): el elemento se saca del documento al terminar
const EXIT_MS = 180;

// ---------- Toasts ----------
// Los errores ('bad') usan role="alert" para que el lector de pantalla los lea enseguida.
// Pasar el mouse por encima pausa el cierre automatico (vuelve a contar al salir).
export function toast(type, title, msg, ms = 4500) {
  const host = document.getElementById('toasts');
  const icn = type === 'good' ? 'check' : type === 'bad' ? 'alert' : 'info';
  const el = h('div', { class: `toast ${type}`, role: type === 'bad' ? 'alert' : 'status' }, icon(icn), h('div', {}, h('div', { class: 't-title' }, title), msg ? h('div', { class: 't-msg' }, msg) : null));
  host.append(el);
  let timer = null;
  const leave = () => {
    if (!el.isConnected || el.classList.contains('leaving')) return;
    if (reducedMotion()) {
      el.remove();
      return;
    }
    el.classList.add('leaving');
    setTimeout(() => el.remove(), EXIT_MS);
  };
  const arm = (delay) => {
    clearTimeout(timer);
    timer = setTimeout(leave, delay);
  };
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', () => arm(Math.min(ms, 2500)));
  arm(ms);
}
export const ok = (title, msg) => toast('good', title, msg);
export const fail = (title, err) => toast('bad', title, err?.message || err, 7000);

// ---------- Modales ----------
// Pila de modales abiertos (el ultimo es el de arriba): Escape cierra solo el de arriba. Al abrir, el foco
// entra al dialogo y al cerrar vuelve a donde estaba. js/a11y/aria.js completa lo que falte (atrapa Tab
// adentro del dialogo) y no repite esto: solo actua si el dialogo no tiene nombre o si el foco quedo afuera.
const modalStack = [];
let modalSeq = 0;
const TEXT_FIELD = 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]):not([type="button"]):not([type="submit"]):not([type="file"]):not([disabled]), textarea:not([disabled]), [contenteditable="true"]';

const isShown = (el) => el.getClientRects().length > 0 && !el.closest('[hidden], [inert], [aria-hidden="true"]');

// Foco inicial: un elemento con autofocus, si no el primer campo de texto del cuerpo, si no el dialogo
// entero (el lector de pantalla lee su titulo y Tab sigue adentro).
function focusInto(box) {
  const auto = [...box.querySelectorAll('[autofocus], [data-autofocus]')].find(isShown);
  const field = auto || [...(box.querySelector('.modal-body')?.querySelectorAll(TEXT_FIELD) || [])].find(isShown);
  (field || box).focus({ preventScroll: true });
}

function restoreFocus(prev, hadFocus) {
  const active = document.activeElement;
  // si el foco ya estaba en otro lado (fuera del dialogo), no se toca
  if (!hadFocus && active && active !== document.body && active.isConnected) return;
  if (prev?.isConnected && typeof prev.focus === 'function' && !prev.closest('[inert]')) {
    prev.focus({ preventScroll: true });
    return;
  }
  const top = modalStack[modalStack.length - 1];
  if (top?.backdrop.isConnected) top.box.focus({ preventScroll: true });
}

function onModalKey(e) {
  if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
  // si alguien saco un modal del documento sin cerrarlo, se descarta sin mover el foco
  while (modalStack.length && !modalStack[modalStack.length - 1].backdrop.isConnected) modalStack[modalStack.length - 1].drop();
  const top = modalStack[modalStack.length - 1];
  if (!top) return;
  // Escape es del modal de arriba: no cierra los de abajo ni le llega a la pagina o al asistente
  e.preventDefault();
  e.stopImmediatePropagation();
  if (top.closable) top.close();
}
if (typeof document !== 'undefined') document.addEventListener('keydown', onModalKey);

// icon (opcional): icono de la herramienta en un recuadro de acento a la izquierda del titulo.
// subtitle (opcional): contexto en una linea debajo del titulo (por ejemplo, la instancia).
export function modal({ title, subtitle, icon: iconName, body, footer, size = '', onClose, closable = true }) {
  const titleId = `modal-title-${++modalSeq}`;
  const opener = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
  const backdrop = h('div', { class: 'modal-backdrop' });
  const entry = { backdrop, closable };
  let closed = false;
  const finish = (restore) => {
    if (closed) return;
    closed = true;
    const i = modalStack.indexOf(entry);
    if (i >= 0) modalStack.splice(i, 1);
    const hadFocus = backdrop.contains(document.activeElement);
    if (restore && backdrop.isConnected && !reducedMotion()) {
      // Salida animada: el dialogo queda inerte (sin foco ni clics) mientras se desvanece y despues se saca
      backdrop.inert = true;
      backdrop.classList.add('closing');
      setTimeout(() => backdrop.remove(), EXIT_MS);
    } else backdrop.remove();
    if (restore) restoreFocus(opener, hadFocus);
    onClose && onClose();
  };
  const close = () => finish(true);
  entry.close = close;
  entry.drop = () => finish(false);
  const box = h(
    'div',
    { class: `modal ${size}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': title ? titleId : null, tabindex: '-1' },
    h(
      'div',
      { class: ['modal-head', (iconName || subtitle) && 'has-meta'] },
      iconName ? h('span', { class: 'modal-head-icon', 'aria-hidden': 'true' }, icon(iconName)) : null,
      iconName || subtitle
        ? h('div', { class: 'modal-head-text' }, h('h3', { id: titleId }, title), subtitle ? h('p', { class: 'modal-sub', title: typeof subtitle === 'string' ? subtitle : null }, subtitle) : null)
        : h('h3', { id: titleId }, title),
      closable ? h('button', { class: 'icon-btn sm', onclick: close, 'aria-label': t('common.close'), title: t('common.close') }, icon('x')) : null,
    ),
    h('div', { class: 'modal-body' }, body),
    footer ? h('div', { class: 'modal-foot' }, footer) : null,
  );
  entry.box = box;
  backdrop.append(box);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop && closable) close();
  });
  modalStack.push(entry);
  document.body.append(backdrop);
  // Despues de que quien lo abrio termine de armarlo (si ya enfoco algo adentro, se respeta)
  queueMicrotask(() => {
    if (!closed && backdrop.isConnected && !box.contains(document.activeElement)) focusInto(box);
  });
  return { el: box, close };
}

// Confirmacion corta (dialogo angosto). Con danger: true el boton de aceptar es rojo.
export function confirmDialog(title, message, { okText = t('common.ok'), cancelText = t('common.cancel'), danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    const m = modal({
      title,
      size: 'sm',
      body: h('p', { class: 'text-2', style: { margin: 0, lineHeight: 1.55 } }, message),
      footer: [
        h('button', { class: 'btn ghost', onclick: () => finish(false) }, cancelText),
        h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => finish(true) }, okText),
      ],
      onClose: () => finish(false),
    });
  });
}

export function promptDialog(title, label, { value = '', placeholder = '', okText = t('common.ok'), hint } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const id = `prompt-${++modalSeq}`;
    const input = h('input', { class: 'input', id, value, placeholder, 'aria-describedby': hint ? `${id}-hint` : null });
    const finish = (v) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(input.value.trim());
    });
    const m = modal({
      title,
      size: 'sm',
      body: h('div', { class: 'field' }, h('label', { for: id }, label), input, hint ? h('div', { class: 'hint field-help', id: `${id}-hint` }, hint) : null),
      footer: [h('button', { class: 'btn ghost', onclick: () => finish(null) }, t('common.cancel')), h('button', { class: 'btn primary', onclick: () => finish(input.value.trim()) }, okText)],
      onClose: () => finish(null),
    });
    setTimeout(() => input.focus(), 30);
  });
}

// ---------- Tooltip (graficos) ----------
let tipEl = null;
export function showTip(x, y, title, value) {
  if (!tipEl) {
    tipEl = h('div', { class: 'tooltip', role: 'tooltip' });
    document.body.append(tipEl);
  }
  mount(tipEl, h('div', { class: 'tt-title' }, title), value ? h('div', { class: 'tt-value' }, value) : null);
  tipEl.style.display = 'block';
  const r = tipEl.getBoundingClientRect();
  tipEl.style.left = `${Math.min(window.innerWidth - r.width - 8, x + 14)}px`;
  tipEl.style.top = `${Math.max(8, y - r.height - 10)}px`;
}
export function hideTip() {
  if (tipEl) tipEl.style.display = 'none';
}

// ---------- Formatos ----------
export function fmtBytes(n) {
  if (!n && n !== 0) return '-';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

export function fmtMb(mb) {
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB` : `${mb} MB`;
}

export function fmtDuration(ms, { short = false } = {}) {
  const totalMin = Math.floor((ms || 0) / 60000);
  const hrs = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  if (hrs === 0) return totalMin === 0 && ms > 0 ? t('common.durLessMin') : t('common.durMin', { m: min });
  if (short) return t('common.durHour', { h: hrs });
  return min ? t('common.durHourMin', { h: hrs, m: min }) : t('common.durHour', { h: hrs });
}

export function fmtNumber(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)} M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)} K`;
  return String(n ?? 0);
}

let rtfCache = null;
function rtf() {
  const loc = locale();
  if (!rtfCache || rtfCache.loc !== loc) rtfCache = { loc, fmt: new Intl.RelativeTimeFormat(loc, { numeric: 'auto' }) };
  return rtfCache.fmt;
}
export function fmtAgo(ts) {
  if (!ts) return t('common.never');
  const diff = Math.min(0, (ts - Date.now()) / 1000);
  const abs = Math.abs(diff);
  if (abs < 60) return t('common.justNow');
  if (abs < 3600) return rtf().format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf().format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf().format(Math.round(diff / 86400), 'day');
  if (abs < 86400 * 365) return rtf().format(Math.round(diff / (86400 * 30)), 'month');
  return rtf().format(Math.round(diff / (86400 * 365)), 'year');
}

export function fmtDate(ts, opts = { day: 'numeric', month: 'short', year: 'numeric' }) {
  if (!ts) return '-';
  return new Date(ts).toLocaleDateString(locale(), opts);
}

export function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
}

export function debounce(fn, ms = 300) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export async function copyText(text, label = t('common.copied')) {
  try {
    await navigator.clipboard.writeText(text);
    toast('good', label, text.length < 60 ? text : null, 2500);
  } catch {
    toast('bad', t('common.copyFailed'));
  }
}

// Carga una hoja de estilos una sola vez: ensureCss('pages/home') -> styles/pages/home.css
const cssLoaded = new Set();
export function ensureCss(name) {
  if (cssLoaded.has(name)) return;
  cssLoaded.add(name);
  document.head.append(h('link', { rel: 'stylesheet', href: `styles/${name}.css` }));
}

// ---------- Loaders ----------
const loaderMeta = (key, name, color, letter) => ({
  name,
  color,
  letter,
  get desc() {
    return t(`common.loaderDesc_${key}`);
  },
});
export const LOADERS = {
  vanilla: loaderMeta('vanilla', 'Vanilla', '#5fae4d', 'V'),
  fabric: loaderMeta('fabric', 'Fabric', '#dbb98d', 'F'),
  forge: loaderMeta('forge', 'Forge', '#6f8cff', 'F'),
  neoforge: loaderMeta('neoforge', 'NeoForge', '#ff8a3d', 'N'),
  quilt: loaderMeta('quilt', 'Quilt', '#b884f0', 'Q'),
  optifine: loaderMeta('optifine', 'OptiFine', '#e45555', 'O'),
  iris: loaderMeta('iris', 'Iris', '#8f7bff', 'I'),
  legacyfabric: loaderMeta('legacyfabric', 'Legacy Fabric', '#c9a46a', 'L'),
  babric: loaderMeta('babric', 'Babric', '#4fb3a9', 'B'),
};

// Version del loader en formato corto y legible (47.4.10, HD U I6...)
export function loaderVersionLabel(inst) {
  const v = inst?.loaderVersion;
  if (!v || v === 'latest' || inst.loader === 'vanilla') return null;
  let out = v.startsWith(`${inst.mcVersion}-`) ? v.slice(inst.mcVersion.length + 1) : v;
  if (out.endsWith(`-${inst.mcVersion}`)) out = out.slice(0, -(inst.mcVersion.length + 1));
  return inst.loader === 'optifine' ? out.replace(/_/g, ' ') : out;
}

export function loaderBadge(loader, version) {
  const meta = LOADERS[loader] || { name: loader, color: '#999' };
  return h('span', { class: 'badge loader-badge', style: { '--c': meta.color } }, h('span', { class: 'ld' }), meta.name, version ? h('span', { class: 'muted ld-ver' }, version) : null);
}

export function instanceLoaderKey(inst) {
  return inst?.preset === 'iris' ? 'iris' : inst?.loader || 'vanilla';
}

export function instanceIcon(inst, cls = '') {
  if (inst?.icon && /^https?:\/\//.test(inst.icon)) {
    return h('div', { class: `inst-icon ${cls}` }, h('img', { src: inst.icon, alt: '', loading: 'lazy' }));
  }
  const meta = LOADERS[instanceLoaderKey(inst)] || LOADERS.vanilla;
  const letter = (inst?.name || meta.letter).trim().charAt(0).toUpperCase();
  return h(
    'div',
    { class: `inst-icon ${cls}`, style: { background: `linear-gradient(135deg, ${meta.color}, color-mix(in srgb, ${meta.color} 45%, var(--surface)))` } },
    letter,
  );
}

// Las caras de jugadores salen de mc-heads.net solo si el usuario lo activó (privacy.playerHeads, ver netprefs.js);
// si no, se usa el logo y no se consulta a nadie.
let playerHeads = false;
export function setPlayerHeads(on) {
  playerHeads = on === true;
}

export function avatarUrl(nameOrUuid, size = 64) {
  if (!playerHeads) return 'assets/logo-64.png';
  return `https://mc-heads.net/avatar/${encodeURIComponent(nameOrUuid || 'MHF_Steve')}/${size}`;
}

export function avatarImg(nameOrUuid, size = 64, cls = 'avatar') {
  const img = h('img', { class: cls, src: avatarUrl(nameOrUuid, size), alt: '', loading: 'lazy' });
  img.addEventListener('error', () => {
    img.src = 'assets/logo-64.png';
  }, { once: true });
  return img;
}

export function switchEl(checked, onChange, label) {
  const input = h('input', { type: 'checkbox', checked, 'aria-label': label || t('common.enable') });
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'switch' }, input, h('span', { class: 'track' }));
}

export function selectEl(options, value, onChange, cls = 'select') {
  const sel = h(
    'select',
    { class: cls },
    options.map((o) => (typeof o === 'string' ? h('option', { value: o, selected: o === value }, o) : h('option', { value: o.value, selected: String(o.value) === String(value) }, o.label))),
  );
  if (onChange) sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

// Spinner con texto, para esperas cortas (para cargas lentas usar skeleton()).
export function loading(text = t('common.loading')) {
  return h('div', { class: 'loading-box', role: 'status', 'aria-live': 'polite' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), text);
}

// Estado vacio: icono + que es + explicacion + accion principal (opcional).
export function emptyState(iconName, title, text, action) {
  return h('div', { class: 'empty' }, icon(iconName, 'empty-icon'), h('div', { class: 'empty-title' }, title), text ? h('div', { class: 'empty-text' }, text) : null, action || null);
}

// Skeleton: anticipa la forma del contenido mientras carga algo lento (> 300 ms). Se anuncia una sola
// vez como "Cargando..."; las formas son decorativas y respetan el movimiento reducido.
//   skeleton(3)                         3 lineas de texto
//   skeleton('line' | 'title')          una linea o un titulo
//   skeleton('circle', { size: 40 })    avatar o icono redondo ('avatar' es lo mismo)
//   skeleton('block', { height: 160 })  bloque (graficos, imagenes, mapas)
//   skeleton('list', { rows: 3 })       filas con icono y dos lineas (como .list-item)
//   skeleton('card', { lines: 3 })      tarjeta con titulo y texto
//   skeleton('grid', { items: 6, min: 240 })  grilla de tarjetas
// Opciones comunes: label (texto para el lector de pantalla) y width.
export function skeleton(shape = 3, opts = {}) {
  const px = (v) => (typeof v === 'number' ? `${v}px` : v);
  const bone = (cls, style) => h('span', { class: `skeleton ${cls}`, style });
  const lines = (n) => h('div', { class: 'skeleton-lines' }, Array.from({ length: Math.max(1, n) }, () => bone('skeleton-line')));
  const card = () => h('div', { class: 'skeleton-card' }, bone('skeleton-line title'), lines(opts.lines || 3));
  let content;
  if (typeof shape === 'number') content = lines(shape);
  else if (shape === 'line') content = bone('skeleton-line', opts.width ? { width: px(opts.width) } : null);
  else if (shape === 'title') content = bone('skeleton-line title', opts.width ? { width: px(opts.width) } : null);
  else if (shape === 'circle' || shape === 'avatar') content = bone('skeleton-circle', { width: px(opts.size || 40), height: px(opts.size || 40) });
  else if (shape === 'block') content = bone('skeleton-block', { height: px(opts.height || 160), width: opts.width ? px(opts.width) : null });
  else if (shape === 'list') content = h('div', { class: 'skeleton-list' }, Array.from({ length: opts.rows || 3 }, () => h('div', { class: 'skeleton-row' }, bone('skeleton-icon'), lines(2))));
  else if (shape === 'grid') content = h('div', { class: 'skeleton-grid', style: { '--sk-min': px(opts.min || 240) } }, Array.from({ length: opts.items || 6 }, card));
  else content = card();
  return h('div', { class: 'skeleton-group', role: 'status', 'aria-live': 'polite', 'aria-busy': 'true' }, h('span', { class: 'sr-only' }, opts.label || t('common.loading')), h('div', { class: 'skeleton-shapes', 'aria-hidden': 'true' }, content));
}

// Boton ocupado mientras corre una accion asincronica: spinner en lugar del icono, deshabilitado y aria-busy.
// Devuelve la funcion que lo libera (y le devuelve el foco si lo tenia):
//   const done = setBusy(btn); try { await algo(); } finally { done(); }
const busyState = new WeakMap();
export function setBusy(btn, busy = true) {
  if (!btn) return () => {};
  if (busy) {
    if (!busyState.has(btn)) busyState.set(btn, { disabled: btn.disabled, hadFocus: document.activeElement === btn });
    btn.classList.add('loading');
    btn.setAttribute('aria-busy', 'true');
    btn.disabled = true;
  } else {
    const prev = busyState.get(btn);
    busyState.delete(btn);
    btn.classList.remove('loading');
    btn.removeAttribute('aria-busy');
    btn.disabled = Boolean(prev?.disabled);
    const active = document.activeElement;
    if (prev?.hadFocus && btn.isConnected && !btn.disabled && (!active || active === document.body)) btn.focus({ preventScroll: true });
  }
  return () => setBusy(btn, false);
}

// Convierte HTML externo (notas de version) en nodos seguros: solo etiquetas de texto basicas.
const SAFE_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'UL', 'OL', 'LI', 'B', 'STRONG', 'I', 'EM', 'CODE', 'BR', 'A', 'BLOCKQUOTE', 'PRE']);
export function safeHtml(html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  const walk = (node) => {
    const out = [];
    for (const n of node.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) out.push(document.createTextNode(n.textContent));
      else if (n.nodeType === Node.ELEMENT_NODE) {
        const kids = walk(n);
        if (!SAFE_TAGS.has(n.tagName)) {
          out.push(...kids);
          continue;
        }
        if (n.tagName === 'A') {
          const href = n.getAttribute('href') || '';
          out.push(/^https?:\/\//i.test(href) ? h('a', { onclick: () => window.venus.app.openExternal(href), title: href }, kids) : h('span', {}, kids));
        } else out.push(h(n.tagName.toLowerCase(), {}, kids));
      }
    }
    return out;
  };
  return h('div', { class: 'rich selectable' }, walk(doc.body));
}

// Titulo de seccion (pixel) con la linea decorativa; el texto es un encabezado de nivel 2 para el lector
// de pantalla (el extra, por ejemplo un contador o un boton, queda afuera del encabezado).
export function sectionTitle(text, extra) {
  return h('div', { class: 'section-title' }, h('span', { class: 'st-text', role: 'heading', 'aria-level': '2' }, text), h('span', { class: 'st-line', 'aria-hidden': 'true' }), extra || null);
}
