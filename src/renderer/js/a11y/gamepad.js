// Navegacion con control (Gamepad API). La cruceta o el stick izquierdo mueven el foco al elemento mas
// cercano en esa direccion; A elige, B vuelve o cierra, LB/RB cambian de pagina del menu, LT/RT de
// pestaña, Y abre la paleta de comandos, Start va a Inicio (foco en Jugar), View alterna menu/contenido,
// X abre el menu contextual y el stick derecho desplaza. Solo actua con la ventana enfocada: si estas
// jugando con el control, el launcher no se entera.
import { t } from '../i18n.js';
import { focusables, topDialog, setModality } from './aria.js';

const BTN = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, VIEW: 8, START: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
const REPEAT_DELAY = 380;
const REPEAT_RATE = 110;
const STICK_ON = 0.55;
const STICK_OFF = 0.35;
const SCROLL_DEAD = 0.18;

// Etiquetas segun la marca del control (posicion fisica estandar)
const GLYPHS = {
  xbox: { A: 'A', B: 'B', X: 'X', Y: 'Y', LB: 'LB', RB: 'RB', LT: 'LT', RT: 'RT', START: '☰', VIEW: '⧉' },
  playstation: { A: '✕', B: '○', X: '□', Y: '△', LB: 'L1', RB: 'R1', LT: 'L2', RT: 'R2', START: 'OPT', VIEW: '⧉' },
  nintendo: { A: 'B', B: 'A', X: 'Y', Y: 'X', LB: 'L', RB: 'R', LT: 'ZL', RT: 'ZR', START: '+', VIEW: '−' },
};

let opts = {
  enabled: () => true,
  hints: () => true,
  sticky: () => false, // modo sofa: no salir del modo control al mover el mouse
  palette: () => null, // { isOpen, open, close, move(d), run() }
  navigate: () => {},
  reduceMotion: () => false,
};
let raf = 0;
const padState = new Map(); // indice -> { buttons: [], dir, since, last }
let kind = 'xbox';
let hintBar = null;
let lastPad = null;
const listeners = new Set();
let started = false;

export function initGamepad(options = {}) {
  opts = { ...opts, ...options };
  if (started) return;
  started = true;
  window.addEventListener('gamepadconnected', (e) => {
    lastPad = e.gamepad;
    kind = padKind(e.gamepad?.id);
    notify();
    ensureLoop();
  });
  window.addEventListener('gamepaddisconnected', () => {
    notify();
    if (!connectedPads().length) exitMode();
  });
  window.addEventListener(
    'mousemove',
    (e) => {
      if (!document.body.classList.contains('gamepad-mode') || opts.sticky()) return;
      if (Math.abs(e.movementX) + Math.abs(e.movementY) > 8) exitMode();
    },
    { passive: true },
  );
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) ensureLoop();
  });
  ensureLoop();
}

// Se llama cuando cambian los ajustes (activar/desactivar, ayudas, modo sofa)
export function refreshGamepad() {
  if (!opts.enabled()) exitMode();
  else ensureLoop();
  renderHints();
}

export function gamepadStatus() {
  const pads = connectedPads();
  return {
    pads: pads.map((p) => ({ id: p.id, name: padName(p.id), kind: padKind(p.id), deck: isDeck(p.id) })),
    kind,
    glyphs: GLYPHS[kind],
  };
}

export function onGamepadChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function glyphsFor(k = kind) {
  return GLYPHS[k] || GLYPHS.xbox;
}

function notify() {
  for (const fn of listeners) {
    try {
      fn(gamepadStatus());
    } catch (err) {
      console.error('[a11y]', err);
    }
  }
  renderHints();
}

function connectedPads() {
  try {
    return [...(navigator.getGamepads?.() || [])].filter((p) => p && p.connected);
  } catch {
    return [];
  }
}

export function padKind(id = '') {
  const s = String(id).toLowerCase();
  if (/054c|dualsense|dualshock|playstation|ps[345]/.test(s)) return 'playstation';
  if (/057e|nintendo|pro controller|joy-con/.test(s)) return 'nintendo';
  return 'xbox';
}

function isDeck(id = '') {
  return /28de/i.test(id) && /1205|steam deck/i.test(id);
}

export function padName(id = '') {
  const clean = String(id).replace(/\s*\(.*$/, '').trim();
  return clean || String(id);
}

// ---------- Bucle ----------
function ensureLoop() {
  if (!raf && opts.enabled() && connectedPads().length) raf = requestAnimationFrame(tick);
}

function tick(time) {
  raf = 0;
  const pads = connectedPads();
  if (!pads.length || !opts.enabled()) {
    padState.clear();
    return;
  }
  const focused = !document.hidden && document.hasFocus();
  for (const p of pads) handlePad(p, time, focused);
  raf = requestAnimationFrame(tick);
}

function handlePad(p, time, focused) {
  const st = padState.get(p.index) || { buttons: [], dir: null, since: 0, last: 0 };
  const now = p.buttons.map((b) => Boolean(b?.pressed || (b?.value ?? 0) > 0.5));
  if (!focused) {
    // sin foco (jugando): solo se recuerda el estado para no disparar acciones al volver
    st.buttons = now;
    st.dir = null;
    padState.set(p.index, st);
    return;
  }
  const down = (i) => now[i] && !st.buttons[i];

  let dir = null;
  if (now[BTN.UP]) dir = 'up';
  else if (now[BTN.DOWN]) dir = 'down';
  else if (now[BTN.LEFT]) dir = 'left';
  else if (now[BTN.RIGHT]) dir = 'right';
  else {
    const x = p.axes[0] || 0;
    const y = p.axes[1] || 0;
    const th = st.dir ? STICK_OFF : STICK_ON;
    if (Math.max(Math.abs(x), Math.abs(y)) > th) dir = Math.abs(x) > Math.abs(y) ? (x > 0 ? 'right' : 'left') : y > 0 ? 'down' : 'up';
  }
  if (dir) {
    if (dir !== st.dir) {
      act(p, () => move(dir, p));
      st.since = time;
      st.last = time;
    } else if (time - st.since > REPEAT_DELAY && time - st.last > REPEAT_RATE) {
      act(p, () => move(dir, p));
      st.last = time;
    }
  }
  st.dir = dir;

  if (down(BTN.A)) act(p, activate);
  if (down(BTN.B)) act(p, back);
  if (down(BTN.X)) act(p, contextMenu);
  if (down(BTN.Y)) act(p, () => togglePalette());
  if (down(BTN.LB)) act(p, () => pageStep(-1));
  if (down(BTN.RB)) act(p, () => pageStep(1));
  if (down(BTN.LT)) act(p, () => tabStep(-1));
  if (down(BTN.RT)) act(p, () => tabStep(1));
  if (down(BTN.START)) act(p, goHome);
  if (down(BTN.VIEW)) act(p, toggleMenu);

  // stick derecho: desplazamiento
  const rx = p.axes[2] || 0;
  const ry = p.axes[3] || 0;
  if (Math.abs(ry) > SCROLL_DEAD || Math.abs(rx) > SCROLL_DEAD) {
    enterMode(p);
    scrollWith(rx, ry);
  }

  st.buttons = now;
  padState.set(p.index, st);
}

function act(p, fn) {
  enterMode(p);
  try {
    fn();
  } catch (err) {
    console.warn('[a11y] gamepad', err);
  }
}

// ---------- Modo control ----------
function enterMode(p) {
  if (p && p !== lastPad) {
    lastPad = p;
    const k = padKind(p.id);
    if (k !== kind) {
      kind = k;
      renderHints();
    }
  }
  setModality('gamepad');
  if (!document.body.classList.contains('gamepad-mode')) {
    document.body.classList.add('gamepad-mode');
    renderHints();
    notify();
  }
}

function exitMode() {
  if (!document.body.classList.contains('gamepad-mode')) return;
  document.body.classList.remove('gamepad-mode');
  renderHints();
  notify();
}

export function inGamepadMode() {
  return document.body.classList.contains('gamepad-mode');
}

function glyph(name) {
  const g = GLYPHS[kind] || GLYPHS.xbox;
  const span = document.createElement('span');
  span.className = `ax-pad-btn ax-pad-${kind} ax-pad-${name.toLowerCase()}`;
  span.textContent = g[name];
  span.setAttribute('aria-hidden', 'true');
  return span;
}

function hint(names, label) {
  const item = document.createElement('span');
  item.className = 'ax-hb-item';
  for (const n of names) item.append(glyph(n));
  const text = document.createElement('span');
  text.textContent = label;
  item.append(text);
  return item;
}

export function renderHints() {
  const show = document.body.classList.contains('gamepad-mode') && opts.hints() && opts.enabled();
  if (!show) {
    hintBar?.remove();
    hintBar = null;
    document.body.classList.remove('ax-hints-on');
    return;
  }
  if (!hintBar) {
    hintBar = document.createElement('div');
    hintBar.className = 'ax-hintbar';
    hintBar.setAttribute('role', 'note');
    document.body.append(hintBar);
  }
  document.body.classList.add('ax-hints-on');
  hintBar.setAttribute('aria-label', t('a11y.padHintsLabel'));
  const pal = opts.palette();
  const items = pal?.isOpen()
    ? [hint(['A'], t('a11y.padRun')), hint(['B'], t('a11y.padClose'))]
    : [
        hint(['A'], t('a11y.padSelect')),
        hint(['B'], t('a11y.padBack')),
        hint(['LB', 'RB'], t('a11y.padPages')),
        hint(['LT', 'RT'], t('a11y.padTabs')),
        hint(['Y'], t('a11y.padSearch')),
        hint(['START'], t('a11y.padHome')),
      ];
  hintBar.replaceChildren(...items);
}

// ---------- Foco espacial ----------
function rectOf(el) {
  let r = el.getBoundingClientRect();
  if (!r.width && !r.height) {
    const label = el.closest('label') || el.parentElement;
    if (label) r = label.getBoundingClientRect();
  }
  return r;
}

function candidates(scope) {
  const root = scope === document ? document.body : scope;
  return focusables(root).filter((el) => !el.closest('.ax-hintbar') && !el.classList.contains('ax-skip') && (scope !== document || !el.closest('.modal-backdrop')));
}

function score(a, b, dir) {
  const ac = { x: (a.left + a.right) / 2, y: (a.top + a.bottom) / 2 };
  const bc = { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 };
  const gap = (a1, a2, b1, b2) => Math.max(0, Math.max(a1, b1) - Math.min(a2, b2));
  if (dir === 'right' || dir === 'left') {
    if (dir === 'right' && (bc.x <= ac.x + 1 || b.right <= a.right - 1)) return Infinity;
    if (dir === 'left' && (bc.x >= ac.x - 1 || b.left >= a.left + 1)) return Infinity;
    const primary = dir === 'right' ? Math.max(0, b.left - a.right) : Math.max(0, a.left - b.right);
    return primary + gap(a.top, a.bottom, b.top, b.bottom) * 2.5 + Math.abs(bc.y - ac.y) * 0.15;
  }
  if (dir === 'down' && (bc.y <= ac.y + 1 || b.bottom <= a.bottom - 1)) return Infinity;
  if (dir === 'up' && (bc.y >= ac.y - 1 || b.top >= a.top + 1)) return Infinity;
  const primary = dir === 'down' ? Math.max(0, b.top - a.bottom) : Math.max(0, a.top - b.bottom);
  return primary + gap(a.left, a.right, b.left, b.right) * 2.5 + Math.abs(bc.x - ac.x) * 0.15;
}

function bestIn(cur, list, dir) {
  const a = rectOf(cur);
  let best = null;
  let bestScore = Infinity;
  for (const el of list) {
    if (el === cur || el.contains(cur)) continue;
    const b = rectOf(el);
    if (!b.width && !b.height) continue;
    const s = score(a, b, dir);
    if (s < bestScore) {
      bestScore = s;
      best = el;
    }
  }
  return best;
}

function initialTarget(scope, list) {
  if (scope !== document) {
    const body = scope.querySelector('.modal-body') || scope;
    return list.find((el) => body.contains(el)) || list[0];
  }
  const main = document.getElementById('main');
  const play = main?.querySelector('.play-btn:not([disabled])');
  if (play && list.includes(play)) return play;
  return list.find((el) => main?.contains(el) && inView(el)) || document.querySelector('#nav .nav-item.active') || list[0];
}

function inView(el) {
  const r = rectOf(el);
  return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
}

export function focusEl(el) {
  if (!el) return;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: opts.reduceMotion() ? 'auto' : 'smooth' });
}

function rumble(p) {
  try {
    p?.vibrationActuator?.playEffect?.('dual-rumble', { duration: 45, strongMagnitude: 0.05, weakMagnitude: 0.22 });
  } catch {
    /* sin vibracion */
  }
}

function move(dir, p) {
  const pal = opts.palette();
  if (pal?.isOpen()) {
    if (dir === 'up' || dir === 'down') pal.move(dir === 'up' ? -1 : 1);
    return;
  }
  const el = document.activeElement;
  if (el && el !== document.body && (dir === 'left' || dir === 'right')) {
    if (el.matches('input[type="range"]')) return stepRange(el, dir === 'right' ? 1 : -1);
    if (el.matches('select')) return stepSelect(el, dir === 'right' ? 1 : -1);
  }
  const scope = topDialog() || document;
  const list = candidates(scope);
  if (!list.length) return;
  const cur = el && list.includes(el) ? el : null;
  if (!cur) return focusEl(initialTarget(scope, list));
  const next = bestIn(cur, list, dir);
  if (next) focusEl(next);
  else rumble(p);
}

function fire(el, type) {
  el.dispatchEvent(new Event(type, { bubbles: true }));
}

function stepRange(el, d) {
  const step = Number(el.step) || 1;
  const min = el.min === '' ? 0 : Number(el.min);
  const max = el.max === '' ? 100 : Number(el.max);
  const next = Math.min(max, Math.max(min, Number(el.value) + d * step));
  if (next === Number(el.value)) return;
  el.value = String(next);
  fire(el, 'input');
  fire(el, 'change');
}

function stepSelect(el, d, wrap = false) {
  const opts2 = [...el.options].filter((o) => !o.disabled);
  if (!opts2.length) return;
  let i = opts2.findIndex((o) => o.selected);
  i += d;
  if (wrap) i = (i + opts2.length) % opts2.length;
  i = Math.min(opts2.length - 1, Math.max(0, i));
  if (opts2[i].selected) return;
  el.value = opts2[i].value;
  fire(el, 'input');
  fire(el, 'change');
}

function activate() {
  const pal = opts.palette();
  if (pal?.isOpen()) return pal.run();
  const el = document.activeElement;
  if (!el || el === document.body) {
    const scope = topDialog() || document;
    return focusEl(initialTarget(scope, candidates(scope)));
  }
  if (el.matches('select')) return stepSelect(el, 1, true);
  if (el.matches('input[type="range"]')) return;
  if (el.matches('input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="color"]):not([type="file"]), textarea, [contenteditable="true"]')) {
    el.select?.();
    return;
  }
  el.click();
}

export function dispatchEscape() {
  const target = document.activeElement && document.activeElement !== document.body ? document.activeElement : document;
  const ev = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true });
  target.dispatchEvent(ev);
}

function back() {
  const pal = opts.palette();
  if (pal?.isOpen()) return pal.close();
  if (topDialog()) return dispatchEscape();
  dispatchEscape();
  const route = location.hash.replace(/^#\/?/, '').split('/')[0] || 'home';
  if (route !== 'home' && history.length > 1) history.back();
}

function contextMenu() {
  const el = document.activeElement;
  if (!el || el === document.body) return;
  const r = rectOf(el);
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 2 }));
}

function togglePalette() {
  const pal = opts.palette();
  if (!pal) return;
  if (pal.isOpen()) pal.close();
  else pal.open();
}

function waitFor(fn, ms = 2500) {
  return new Promise((resolve) => {
    const start = performance.now();
    const loop = () => {
      const v = fn();
      if (v) return resolve(v);
      if (performance.now() - start > ms) return resolve(null);
      setTimeout(loop, 60);
    };
    loop();
  });
}

function currentPage() {
  return document.querySelector('#main .page');
}

function focusFirstInPage(before) {
  waitFor(() => {
    const page = currentPage();
    if (!page || page === before) return null;
    const list = focusables(page);
    return list.length ? list : null;
  }).then((list) => {
    if (!list) return;
    const visible = list.find(inView) || list[0];
    focusEl(visible);
  });
}

function pageStep(d) {
  if (topDialog() || opts.palette()?.isOpen()) return;
  const items = [...document.querySelectorAll('#nav .nav-item[data-route]')];
  if (!items.length) return;
  const i = items.findIndex((n) => n.classList.contains('active'));
  const next = items[(i < 0 ? 0 : i + d + items.length) % items.length];
  const before = currentPage();
  next.click();
  focusFirstInPage(before);
}

function tabStep(d) {
  const scope = topDialog() || document.getElementById('main');
  if (!scope) return;
  const lists = [...scope.querySelectorAll('[role="tablist"], .tabs, .segmented')].filter((l) => l.getClientRects().length);
  if (!lists.length) return;
  // la lista de pestañas que contiene el foco, o la primera visible
  const list = lists.find((l) => l.contains(document.activeElement)) || lists[0];
  const tabs = [...list.querySelectorAll('[role="tab"], .tab, button')].filter((b) => !b.disabled && b.getClientRects().length);
  if (tabs.length < 2) return;
  let i = tabs.findIndex((b) => b.getAttribute('aria-selected') === 'true' || b.classList.contains('active'));
  if (i < 0) i = 0;
  const next = tabs[(i + d + tabs.length) % tabs.length];
  next.click();
  focusEl(next);
}

function goHome() {
  const pal = opts.palette();
  if (pal?.isOpen()) pal.close();
  if (topDialog()) dispatchEscape();
  const route = location.hash.replace(/^#\/?/, '').split('/')[0] || 'home';
  if (route !== 'home') opts.navigate('home');
  waitFor(() => {
    const main = document.getElementById('main');
    if (!main || !main.querySelector('.page-home, .page')) return null;
    return main.querySelector('.play-btn:not([disabled])') || main.querySelector('[data-fk="play"]');
  }, 3500).then((btn) => {
    if (btn) focusEl(btn);
    else focusFirstInPage(null);
  });
}

function toggleMenu() {
  if (topDialog() || opts.palette()?.isOpen()) return;
  const nav = document.getElementById('nav');
  if (nav?.contains(document.activeElement)) {
    const page = currentPage();
    const list = page ? focusables(page) : [];
    focusEl(list.find(inView) || list[0]);
  } else {
    focusEl(nav?.querySelector('.nav-item.active') || nav?.querySelector('.nav-item'));
  }
}

function scrollContainer(el) {
  let n = el && el !== document.body ? el : null;
  while (n && n !== document.body) {
    const cs = getComputedStyle(n);
    if (/(auto|scroll)/.test(cs.overflowY + cs.overflowX) && (n.scrollHeight > n.clientHeight + 2 || n.scrollWidth > n.clientWidth + 2)) return n;
    n = n.parentElement;
  }
  const dlg = topDialog();
  return dlg?.querySelector('.modal-body') || currentPage();
}

function scrollWith(rx, ry) {
  const box = scrollContainer(document.activeElement);
  if (!box) return;
  const f = (v) => (Math.abs(v) > SCROLL_DEAD ? Math.sign(v) * ((Math.abs(v) - SCROLL_DEAD) / (1 - SCROLL_DEAD)) ** 1.6 * 22 : 0);
  box.scrollBy({ left: f(rx), top: f(ry), behavior: 'auto' });
}
