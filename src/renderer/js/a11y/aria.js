// Mejoras de teclado y lector de pantalla para toda la interfaz (se instalan una vez al iniciar):
// enlace "Saltar al contenido", regiones con nombre, avisos hablados, foco dentro de los dialogos,
// Enter/Espacio en elementos clicables que no son botones y foco para tarjetas clicables.
import { t } from '../i18n.js';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
  'summary',
].join(',');
const NATIVE = 'a[href], button, input, select, textarea, summary, [contenteditable="true"]';
const ACTIVATE_ROLES = new Set(['button', 'link', 'tab', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'option', 'checkbox', 'switch', 'radio', 'treeitem']);
// Tarjetas y filas clicables del sistema de diseno que pueden crearse como <div> (las que son <button> o
// <a> se saltean solas)
const KNOWN_CLICKABLE = '.inst-card, .account-row, .instance-picker, .back-link';

let installed = false;
let modality = 'mouse';
let liveEl = null;
let skipEl = null;
const scanned = new WeakSet();
let pendingScan = new Set();
let scanTimer = 0;
const modalityListeners = new Set();

export { FOCUSABLE };

export function initAria() {
  if (installed) return;
  installed = true;
  addSkipLink();
  addLiveRegion();
  labelLandmarks();
  watchNav();
  watchToasts();
  watchModals();
  trackModality();
  enterActivation();
  focusTrap();
  watchClickables();
  window.addEventListener('hashchange', onRoute);
}

// Vuelve a poner los textos (al cambiar de idioma)
export function relabel() {
  if (!installed) return;
  if (skipEl) skipEl.textContent = t('a11y.skipToContent');
  labelLandmarks();
}

export function getModality() {
  return modality;
}

export function setModality(m) {
  if (m === modality) return;
  modality = m;
  document.documentElement.dataset.axInput = m;
  for (const fn of modalityListeners) fn(m);
}

export function onModality(fn) {
  modalityListeners.add(fn);
  return () => modalityListeners.delete(fn);
}

// Lee un texto en voz alta con el lector de pantalla (region "polite")
export function announce(text) {
  if (!liveEl || !text) return;
  liveEl.textContent = '';
  setTimeout(() => {
    liveEl.textContent = String(text);
  }, 60);
}

// ---------- Estructura ----------
function addSkipLink() {
  skipEl = document.createElement('button');
  skipEl.type = 'button';
  skipEl.className = 'ax-skip';
  skipEl.textContent = t('a11y.skipToContent');
  skipEl.addEventListener('click', () => focusMain());
  // Siempre fuera del flujo: si a11y.css todavia no cargo, el boton quedaria arriba de .app y correria
  // toda la ventana hacia abajo. Hasta que cargue la hoja queda oculto.
  skipEl.style.position = 'fixed';
  const sheet = document.querySelector('link[href="styles/a11y.css"]');
  if (sheet && !sheet.sheet) {
    skipEl.hidden = true;
    sheet.addEventListener(
      'load',
      () => {
        if (skipEl) skipEl.hidden = false;
      },
      { once: true },
    );
  }
  document.body.prepend(skipEl);
}

export function focusMain() {
  const main = document.getElementById('main');
  if (!main) return;
  const title = main.querySelector('.page-title');
  const target = title || main;
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: false });
}

function addLiveRegion() {
  liveEl = document.createElement('div');
  liveEl.id = 'ax-live';
  liveEl.className = 'ax-sr';
  liveEl.setAttribute('aria-live', 'polite');
  liveEl.setAttribute('aria-atomic', 'true');
  document.body.append(liveEl);
}

function setAttrs(el, attrs) {
  if (!el) return;
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, v);
}

function labelLandmarks() {
  setAttrs(document.querySelector('.sidebar'), { 'aria-label': t('a11y.landmarkSidebar') });
  setAttrs(document.getElementById('nav'), { 'aria-label': t('a11y.landmarkNav') });
  const main = document.getElementById('main');
  setAttrs(main, { 'aria-label': t('a11y.landmarkMain') });
  if (main && !main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
  setAttrs(document.getElementById('toasts'), { role: 'region', 'aria-label': t('a11y.landmarkToasts'), 'aria-live': 'polite' });
  setAttrs(document.getElementById('tasks'), { role: 'region', 'aria-label': t('a11y.landmarkTasks') });
  setAttrs(document.getElementById('tb-status'), { role: 'status', 'aria-live': 'polite' });
  const chip = document.getElementById('account-chip');
  if (chip) setAttrs(chip, { role: 'button', tabindex: chip.getAttribute('tabindex') ?? '0', 'aria-label': chip.title || t('a11y.accounts') });
  const brand = document.querySelector('.brand');
  if (brand) setAttrs(brand, { role: 'link', tabindex: brand.getAttribute('tabindex') ?? '0', 'aria-label': t('a11y.goHome') });
}

function syncNavCurrent() {
  document.querySelectorAll('#nav .nav-item').forEach((n) => {
    if (n.classList.contains('active')) n.setAttribute('aria-current', 'page');
    else n.removeAttribute('aria-current');
  });
}

function watchNav() {
  const nav = document.getElementById('nav');
  if (!nav) return;
  syncNavCurrent();
  new MutationObserver(syncNavCurrent).observe(nav, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
}

function watchToasts() {
  const host = document.getElementById('toasts');
  if (!host) return;
  new MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (n.nodeType === 1 && n.classList.contains('toast') && n.classList.contains('bad')) n.setAttribute('role', 'alert');
      }
    }
  }).observe(host, { childList: true });
}

// ---------- Dialogos: nombre, foco al abrir y al cerrar ----------
export function topDialog() {
  const list = [...document.querySelectorAll('.ax-palette-backdrop, .modal-backdrop, [role="dialog"][aria-modal="true"]')].filter((el) => el.isConnected && el.getClientRects().length);
  if (!list.length) return null;
  // el ultimo en el documento es el de arriba
  const last = list[list.length - 1];
  return last.classList.contains('modal-backdrop') ? last.querySelector('.modal') || last : last;
}

export function focusables(scope) {
  return [...scope.querySelectorAll(FOCUSABLE)].filter((el) => !el.closest('[inert], [aria-hidden="true"]') && isRendered(el));
}

function isRendered(el) {
  if (el.getClientRects().length) return el.checkVisibility ? el.checkVisibility({ visibilityProperty: true }) : true;
  // los checkbox ocultos de los interruptores no tienen tamanio: cuentan si su etiqueta se ve
  const label = el.closest('label');
  return Boolean(label && label.getClientRects().length);
}

// El foco al abrir y al cerrar lo maneja modal() de ui.js (primer campo util o el dialogo, y vuelta al
// disparador). Aca solo se asegura que el dialogo tenga nombre para el lector de pantalla.
function prepareModal(backdrop) {
  const box = backdrop.querySelector('.modal') || backdrop;
  const title = box.querySelector('.modal-head h3, h1, h2, h3');
  if (title && !box.hasAttribute('aria-labelledby') && !box.hasAttribute('aria-label')) {
    if (!title.id) title.id = `ax-dlg-${Math.random().toString(36).slice(2, 8)}`;
    box.setAttribute('aria-labelledby', title.id);
  }
}

function watchModals() {
  new MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.addedNodes) if (n.nodeType === 1 && n.classList.contains('modal-backdrop')) prepareModal(n);
    }
  }).observe(document.body, { childList: true });
}

function focusTrap() {
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Tab' || e.defaultPrevented) return;
      const dlg = topDialog();
      if (!dlg) return;
      const list = focusables(dlg);
      if (!list.length) return;
      const active = document.activeElement;
      const i = list.indexOf(active);
      if (!dlg.contains(active) || i < 0) {
        e.preventDefault();
        (e.shiftKey ? list[list.length - 1] : list[0]).focus();
      } else if (e.shiftKey && i === 0) {
        e.preventDefault();
        list[list.length - 1].focus();
      } else if (!e.shiftKey && i === list.length - 1) {
        e.preventDefault();
        list[0].focus();
      }
    },
    true,
  );
}

// ---------- Modo de entrada (teclado / mouse / control) ----------
function trackModality() {
  document.documentElement.dataset.axInput = modality;
  window.addEventListener(
    'keydown',
    (e) => {
      if (['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', ' ', 'Escape', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) setModality('keyboard');
    },
    true,
  );
  window.addEventListener('pointerdown', () => setModality('mouse'), true);
}

// ---------- Enter / Espacio en elementos con rol de boton ----------
function enterActivation() {
  let clicked = false;
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Enter' || e.key === ' ') clicked = false;
    },
    true,
  );
  document.addEventListener(
    'click',
    () => {
      clicked = true;
    },
    true,
  );
  window.addEventListener('keydown', (e) => {
    if ((e.key !== 'Enter' && e.key !== ' ') || e.defaultPrevented || clicked || e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
    const el = e.target;
    if (!(el instanceof Element) || el.matches(NATIVE) || el.isContentEditable) return;
    const role = el.getAttribute('role');
    if (!ACTIVATE_ROLES.has(role) && !el.hasAttribute('data-ax-click')) return;
    e.preventDefault();
    el.click();
  });
}

// ---------- Tarjetas clicables sin foco ----------
function makeFocusable(el) {
  if (el.matches(NATIVE) || el.hasAttribute('tabindex') || el.closest('[inert], [aria-hidden="true"], svg')) return;
  el.setAttribute('tabindex', '0');
  if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
  el.setAttribute('data-ax-click', '');
}

function scanNode(root) {
  if (root.nodeType !== 1) return;
  if (root.matches(KNOWN_CLICKABLE)) makeFocusable(root);
  root.querySelectorAll(KNOWN_CLICKABLE).forEach(makeFocusable);
  // heuristica: el elemento mas externo con cursor de mano, sin nada enfocable adentro
  const all = [root, ...root.querySelectorAll('div, span, li, img, figure, article, section, tr, td, p, h2, h3, h4')];
  for (const el of all) {
    if (scanned.has(el)) continue;
    scanned.add(el);
    if (el.matches(NATIVE) || el.hasAttribute('tabindex') || el.hasAttribute('role') || el.closest('svg')) continue;
    const cs = getComputedStyle(el);
    if (cs.cursor !== 'pointer') continue;
    const parent = el.parentElement;
    if (parent && getComputedStyle(parent).cursor === 'pointer') continue;
    if (el.querySelector(FOCUSABLE) || el.closest('label')) continue;
    if (!el.getClientRects().length) continue;
    makeFocusable(el);
  }
}

function flushScan() {
  scanTimer = 0;
  const list = [...pendingScan];
  pendingScan = new Set();
  for (const n of list) if (n.isConnected) scanNode(n);
}

function watchClickables() {
  const queue = (n) => {
    if (n.nodeType !== 1 || n.closest?.('.ax-palette-backdrop')) return;
    pendingScan.add(n);
    if (!scanTimer) scanTimer = setTimeout(flushScan, 160);
  };
  const obs = new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) queue(n);
  });
  const main = document.getElementById('main');
  if (main) {
    obs.observe(main, { childList: true, subtree: true });
    queue(main);
  }
  // dialogos (se agregan al body)
  new MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (n.nodeType === 1 && n.classList.contains('modal-backdrop')) {
          queue(n);
          obs.observe(n, { childList: true, subtree: true });
        }
      }
    }
  }).observe(document.body, { childList: true });
}

// ---------- Cambio de pagina ----------
function onRoute() {
  setTimeout(() => {
    const main = document.getElementById('main');
    const title = main?.querySelector('.page-title')?.textContent?.trim();
    const nav = document.querySelector('#nav .nav-item.active span')?.textContent?.trim();
    const name = title || nav;
    if (name) announce(t('a11y.pageAnnounce', { page: name }));
    if (modality === 'keyboard' && (!document.activeElement || document.activeElement === document.body || !document.activeElement.isConnected)) focusMain();
  }, 450);
}
