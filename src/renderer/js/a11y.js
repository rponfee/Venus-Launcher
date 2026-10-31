// Accesibilidad: modos para daltonismo (filtro SVG + paletas de estados), alto contraste, tamaño de la
// interfaz, movimiento reducido, foco siempre visible, mejoras para lectores de pantalla, paleta de
// comandos (Ctrl+K) y navegacion con control (modo sofa / Steam Deck).
// Ajustes en settings.a11y. Contrato: startup(), accessibilityPanel() -> Element.
import { h, icon, mount, ensureCss, switchEl, modal, confirmDialog, toast, ok, fail, emptyState, skeleton, setBusy, instanceIcon, loaderBadge, instanceLoaderKey } from './ui.js';
import { store, api } from './store.js';
import { t, loadNs, has, onLanguageChange } from './i18n.js';
import { navigate, launchInstance, openAccounts } from './app.js';
import * as engine from './a11y/engine.js';
import { initAria, relabel, topDialog } from './a11y/aria.js';
import { initPalette, registerCommands, paletteApi, open as openCommandPalette } from './a11y/palette.js';
import { initGamepad, refreshGamepad, gamepadStatus, onGamepadChange, glyphsFor, renderHints, dispatchEscape, padKind } from './a11y/gamepad.js';

export { registerCommands, openCommandPalette };

export const A11Y_DEFAULTS = {
  colorblind: 'none', // 'none' | 'protanopia' | 'deuteranopia' | 'tritanopia'
  cvdStrength: 50, // intensidad del filtro de correccion (0-100)
  statusShapes: false,
  highContrast: false,
  focusRings: false,
  scale: 100, // 90-130
  reduceMotion: 'auto', // 'auto' (como Windows) | 'on' | 'off'
  gamepad: true,
  gamepadHints: true,
  couchMode: false,
};
const CVD_MODES = ['none', 'protanopia', 'deuteranopia', 'tritanopia'];
const COUCH_SCALE = 125;
const MIN_W = 1040;
const MIN_H = 680;
const CONTROLIFY = 'controlify';

let started = false;
let local = { ...A11Y_DEFAULTS };
let pending = {};
let saveTimer = 0;
const stateListeners = new Set();
const motionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)');
const contrastQuery = window.matchMedia?.('(prefers-contrast: more)');

// ---------- Ajustes ----------
function intIn(v, min, max, def) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

function normalize(raw = {}) {
  const s = { ...A11Y_DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  if (!CVD_MODES.includes(s.colorblind)) s.colorblind = 'none';
  s.cvdStrength = intIn(s.cvdStrength, 0, 100, 50);
  s.scale = intIn(Math.round(Number(s.scale) / 5) * 5, 90, 130, 100);
  if (s.reduceMotion === true) s.reduceMotion = 'on';
  else if (s.reduceMotion === false) s.reduceMotion = 'off';
  else if (!['auto', 'on', 'off'].includes(s.reduceMotion)) s.reduceMotion = 'auto';
  for (const k of ['statusShapes', 'highContrast', 'focusRings', 'gamepad', 'gamepadHints', 'couchMode']) s[k] = Boolean(s[k]);
  return s;
}

export function a11ySettings() {
  return { ...local };
}

function fromStore() {
  return normalize({ ...(store.settings?.a11y || {}), ...pending });
}

// Cambia una o mas opciones: se aplica al instante y se guarda (con espera para los deslizadores)
export function setA11y(patch, { delay = 0 } = {}) {
  local = normalize({ ...local, ...patch });
  Object.assign(pending, patch);
  applyAll();
  emitState();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, delay);
}

async function flush() {
  const p = pending;
  pending = {};
  if (!Object.keys(p).length) return;
  try {
    await store.setSettings({ a11y: p });
  } catch (err) {
    fail(t('a11y.saveFailed'), err);
  }
}

function emitState() {
  for (const fn of stateListeners) {
    try {
      fn(local);
    } catch (err) {
      console.error('[a11y]', err);
    }
  }
}

function onState(fn) {
  stateListeners.add(fn);
  return () => stateListeners.delete(fn);
}

// ---------- Aplicar ----------
export function motionReduced(s = local) {
  return s.reduceMotion === 'on' || (s.reduceMotion === 'auto' && Boolean(motionQuery?.matches));
}

// Escala pedida y la que entra en la ventana (la interfaz necesita 1040x680 de espacio util)
export function scaleInfo(s = local) {
  const requested = (s.couchMode ? Math.max(s.scale, COUCH_SCALE) : s.scale) / 100;
  const fit = Math.min(window.innerWidth / MIN_W, window.innerHeight / MIN_H);
  const max = Math.max(1, Math.floor(fit * 100) / 100);
  const applied = requested > 1 ? Math.min(requested, max) : requested;
  return { requested: Math.round(requested * 100), applied: Math.round(applied * 100), max: Math.round(max * 100), limited: applied < requested };
}

function applyScale() {
  const root = document.documentElement;
  const { applied } = scaleInfo();
  if (applied === 100) {
    root.classList.remove('ax-zoomed');
    root.style.removeProperty('--ax-zoom');
  } else {
    root.classList.add('ax-zoomed');
    root.style.setProperty('--ax-zoom', String(applied / 100));
  }
}

function applyAll() {
  const s = local;
  engine.setVision({ cvd: s.colorblind, cvdStrength: s.cvdStrength / 100, hc: s.highContrast, shapes: s.statusShapes });
  document.body.classList.toggle('reduce-motion', motionReduced(s));
  document.documentElement.classList.toggle('ax-focus', s.focusRings);
  document.documentElement.classList.toggle('ax-couch', s.couchMode);
  applyScale();
  refreshGamepad();
}

// ---------- Inicio ----------
export async function startup() {
  if (started) return;
  started = true;
  ensureCss('a11y');
  // la hoja propia ya usa variables: no hace falta reescribir sus colores
  document.querySelector('link[href="styles/a11y.css"]')?.setAttribute('data-ax-skip', '');
  try {
    await loadNs('a11y');
  } catch (err) {
    console.warn('[a11y] i18n', err);
  }
  local = fromStore();
  applyAll();
  initAria();
  initPalette({ onChange: () => renderHints() });
  registerCommands(baseCommands);
  initGamepad({
    enabled: () => local.gamepad,
    hints: () => local.gamepadHints,
    sticky: () => local.couchMode,
    palette: () => paletteApi,
    navigate: (r) => navigate(r),
    reduceMotion: () => motionReduced(),
  });
  store.on('settings', () => {
    const next = fromStore();
    if (JSON.stringify(next) === JSON.stringify(local)) return;
    local = next;
    applyAll();
    emitState();
  });
  motionQuery?.addEventListener?.('change', () => {
    applyAll();
    emitState();
  });
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      applyScale();
      emitState();
    }, 150);
  });
  onLanguageChange(async () => {
    await loadNs('a11y').catch(() => {});
    relabel();
    renderHints();
  });
}

// ---------- Comandos de la paleta ----------
function go(route) {
  if (topDialog()) dispatchEscape();
  navigate(route);
}

function baseCommands() {
  const cmds = [];
  document.querySelectorAll('#nav .nav-item[data-route]').forEach((n) => {
    const route = n.dataset.route;
    const label = n.querySelector('span')?.textContent?.trim() || route;
    cmds.push({ id: `page:${route}`, group: 'pages', title: label, icon: n.querySelector('svg') || 'arrowRight', keywords: route, run: () => go(route) });
  });
  const settingsLabel = document.getElementById('settings-btn')?.getAttribute('aria-label') || t('a11y.cmdSettings');
  cmds.push({ id: 'page:settings', group: 'pages', title: settingsLabel, icon: 'settings', keywords: 'settings ajustes opciones', run: () => go('settings') });
  cmds.push({ id: 'page:settings/cloud', group: 'pages', title: t('a11y.cmdCloud'), icon: 'cloud', keywords: t('a11y.cmdCloudKw'), run: () => go('settings/cloud') });

  const inst = store.selectedInstance?.();
  if (inst) {
    if (store.running[inst.id]) {
      cmds.push({ id: 'act:stop', group: 'actions', title: t('a11y.cmdStop', { name: inst.name }), icon: 'stop', run: () => api.instances.stop(inst.id).catch((err) => fail(t('a11y.cmdFailed'), err)) });
    } else {
      cmds.push({ id: 'act:play', group: 'actions', title: t('a11y.cmdPlay', { name: inst.name }), icon: 'play', keywords: t('a11y.cmdPlayKw'), run: () => launchInstance(inst.id) });
    }
  }
  cmds.push({ id: 'act:new', group: 'actions', title: t('a11y.cmdNewInstance'), icon: 'plus', keywords: t('a11y.cmdNewInstanceKw'), run: () => go('versions/new') });
  cmds.push({ id: 'act:accounts', group: 'actions', title: t('a11y.cmdAccounts'), icon: 'users', keywords: t('a11y.cmdAccountsKw'), run: () => openAccounts() });
  if (store.info?.dataDir) cmds.push({ id: 'act:data', group: 'actions', title: t('a11y.cmdDataFolder'), icon: 'folder', run: () => api.app.openPath(store.info.dataDir).catch((err) => fail(t('a11y.cmdFailed'), err)) });
  cmds.push({ id: 'act:reload', group: 'actions', title: t('a11y.cmdReload'), icon: 'refresh', hint: 'Ctrl+Shift+R', run: () => location.reload() });

  for (const i of store.instances || []) {
    const sub = [i.mcVersion, i.loader && i.loader !== 'vanilla' ? i.loader : null].filter(Boolean).join(' · ');
    cmds.push({ id: `inst:open:${i.id}`, group: 'instances', title: t('a11y.cmdOpenInstance', { name: i.name }), sub, icon: 'box', run: () => go(`instance/${encodeURIComponent(i.id)}`) });
    if (!store.running[i.id]) cmds.push({ id: `inst:play:${i.id}`, group: 'instances', title: t('a11y.cmdPlayInstance', { name: i.name }), sub, icon: 'play', run: () => launchInstance(i.id) });
  }
  for (const s of store.servers || []) {
    if (!s?.id) continue;
    cmds.push({ id: `srv:${s.id}`, group: 'servers', title: t('a11y.cmdOpenServer', { name: s.name || s.id }), icon: 'server', run: () => go(`server/${encodeURIComponent(s.id)}`) });
  }

  const a = local;
  cmds.push({ id: 'a11y:hc', group: 'a11y', title: t('a11y.highContrast'), icon: 'contrast', state: a.highContrast, keywords: t('a11y.kwContrast'), run: () => setA11y({ highContrast: !a.highContrast }) });
  cmds.push({ id: 'a11y:motion', group: 'a11y', title: t('a11y.reduceMotion'), icon: 'activity', state: motionReduced(a), keywords: t('a11y.kwMotion'), run: () => setA11y({ reduceMotion: motionReduced(a) ? 'off' : 'on' }) });
  cmds.push({ id: 'a11y:focus', group: 'a11y', title: t('a11y.focusRings'), icon: 'target', state: a.focusRings, keywords: t('a11y.kwFocus'), run: () => setA11y({ focusRings: !a.focusRings }) });
  cmds.push({ id: 'a11y:shapes', group: 'a11y', title: t('a11y.statusShapes'), icon: 'shieldCheck', state: a.statusShapes, keywords: t('a11y.kwShapes'), run: () => setA11y({ statusShapes: !a.statusShapes }) });
  cmds.push({ id: 'a11y:couch', group: 'a11y', title: t('a11y.couchMode'), icon: 'gamepad', state: a.couchMode, keywords: t('a11y.kwCouch'), run: () => setA11y({ couchMode: !a.couchMode }) });
  for (const mode of CVD_MODES) {
    cmds.push({ id: `a11y:cvd:${mode}`, group: 'a11y', title: t('a11y.cmdColorblind', { mode: t(`a11y.cvd_${mode}`) }), icon: 'eye', state: a.colorblind === mode, radio: true, keywords: t('a11y.kwColorblind'), run: () => setA11y({ colorblind: mode }) });
  }
  cmds.push({ id: 'a11y:bigger', group: 'a11y', title: t('a11y.cmdScaleUp'), sub: t('a11y.scaleValue', { value: a.scale }), icon: 'zoomIn', keywords: t('a11y.kwScale'), run: () => setA11y({ scale: Math.min(130, a.scale + 10) }) });
  cmds.push({ id: 'a11y:smaller', group: 'a11y', title: t('a11y.cmdScaleDown'), sub: t('a11y.scaleValue', { value: a.scale }), icon: 'zoomOut', keywords: t('a11y.kwScale'), run: () => setA11y({ scale: Math.max(90, a.scale - 10) }) });
  cmds.push({ id: 'a11y:scale100', group: 'a11y', title: t('a11y.cmdScaleReset'), icon: 'maximize', keywords: t('a11y.kwScale'), run: () => setA11y({ scale: 100 }) });
  cmds.push({ id: 'a11y:panel', group: 'a11y', title: t('a11y.cmdOpenPanel'), icon: 'accessibility', keywords: t('a11y.kwPanel'), run: () => go('settings/a11y') });
  cmds.push({ id: 'a11y:controlify', group: 'a11y', title: t('a11y.cfyButton'), icon: 'gamepad', keywords: 'controlify gamepad mando joystick', run: () => openControlifyInstaller() });
  return cmds;
}

export function openAccessibilityModal() {
  modal({ title: t('a11y.panelTitle'), body: accessibilityPanel(), size: 'wide' });
}

// ---------- Controles reutilizables del panel ----------
function segmented(options, value, onChange, label) {
  const wrap = h('div', { class: 'segmented ax-seg', role: 'radiogroup', 'aria-label': label });
  const btns = options.map((o) =>
    h(
      'button',
      {
        type: 'button',
        role: 'radio',
        title: o.title || null,
        onclick: () => onChange(o.value),
      },
      o.icon ? icon(o.icon) : null,
      o.label,
    ),
  );
  wrap.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const i = btns.indexOf(document.activeElement);
    const d = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
    const next = (i < 0 ? 0 : i + d + btns.length) % btns.length;
    btns[next].focus();
    onChange(options[next].value);
  });
  wrap.append(...btns);
  const set = (v) =>
    btns.forEach((b, i) => {
      const on = options[i].value === v;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
  set(value);
  return { el: wrap, set };
}

function toggleRow(title, sub, checked, onChange) {
  const sw = switchEl(checked, onChange, title);
  const row = h('div', { class: 'toggle-row' }, h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, title), sub ? h('div', { class: 'tr-sub' }, sub) : null), sw);
  const input = sw.querySelector('input');
  return {
    el: row,
    set: (v) => {
      input.checked = Boolean(v);
    },
  };
}

function card(iconName, title, sub, ...children) {
  return h(
    'section',
    { class: 'card ax-card' },
    h('div', { class: 'ax-card-head' }, h('span', { class: 'ax-card-icon' }, icon(iconName)), h('div', {}, h('h3', { class: 'ax-card-title' }, title), sub ? h('p', { class: 'ax-card-sub' }, sub) : null)),
    ...children,
  );
}

function statusPreview() {
  return h(
    'div',
    { class: 'ax-status-preview', role: 'group', 'aria-label': t('a11y.statusPreview') },
    h('span', { class: 'pill good' }, icon('check'), t('a11y.statusGood')),
    h('span', { class: 'pill warn' }, icon('alert'), t('a11y.statusWarn')),
    h('span', { class: 'pill bad' }, icon('x'), t('a11y.statusBad')),
    h('span', { class: 'pill ax-pill-info' }, icon('info'), t('a11y.statusInfo')),
    h('span', { class: 'badge good ax-shape-demo' }, t('a11y.statusOnline')),
    h('span', { class: 'badge bad ax-shape-demo' }, t('a11y.statusOffline')),
  );
}

// ---------- Panel ----------
let panelSeq = 0;

export function accessibilityPanel() {
  ensureCss('a11y');
  const root = h('div', { class: 'ax-panel' });
  if (has('a11y.panelVision')) buildPanel(root);
  else {
    mount(root, skeleton('card', { lines: 4 }));
    loadNs('a11y')
      .then(() => buildPanel(root))
      .catch((err) => mount(root, h('div', { class: 'notice bad' }, icon('alert'), String(err?.message || err))));
  }
  return root;
}

function buildPanel(root) {
  if (!started) local = fromStore();
  const s = local;
  const uid = ++panelSeq; // ids propios: el panel puede estar a la vez en Ajustes y en el dialogo

  // --- Vision ---
  const cvdDesc = h('p', { class: 'ax-desc' });
  const strength = h('input', { type: 'range', class: 'range', id: `ax-cvd-strength-${uid}`, min: 0, max: 100, step: 5, value: s.cvdStrength, 'aria-label': t('a11y.cvdStrength') });
  const strengthVal = h('span', { class: 'ax-value' });
  const strengthBox = h(
    'div',
    { class: 'ax-field' },
    h('div', { class: 'ax-field-head' }, h('label', { class: 'label', for: `ax-cvd-strength-${uid}` }, t('a11y.cvdStrength')), strengthVal),
    strength,
    h('div', { class: 'ax-hint' }, t('a11y.cvdStrengthHint')),
  );
  strength.addEventListener('input', () => setA11y({ cvdStrength: Number(strength.value) }, { delay: 300 }));
  const cvdSeg = segmented(
    CVD_MODES.map((m) => ({ value: m, label: t(`a11y.cvd_${m}`), title: t(`a11y.cvdDesc_${m}`) })),
    s.colorblind,
    (v) => setA11y({ colorblind: v }),
    t('a11y.colorblind'),
  );
  const shapes = toggleRow(t('a11y.statusShapes'), t('a11y.statusShapesSub'), s.statusShapes, (v) => setA11y({ statusShapes: v }));
  const hc = toggleRow(t('a11y.highContrast'), t('a11y.highContrastSub'), s.highContrast, (v) => setA11y({ highContrast: v }));
  const hcHint = h('div', { class: 'ax-hint ax-os-hint' }, icon('info'), t('a11y.highContrastOs'));
  const focus = toggleRow(t('a11y.focusRings'), t('a11y.focusRingsSub'), s.focusRings, (v) => setA11y({ focusRings: v }));

  const vision = card(
    'eye',
    t('a11y.panelVision'),
    t('a11y.panelVisionSub'),
    h('div', { class: 'ax-field' }, h('div', { class: 'label' }, t('a11y.colorblind')), cvdSeg.el, cvdDesc),
    statusPreview(),
    strengthBox,
    h('div', { class: 'ax-toggles' }, shapes.el, hc.el, hcHint, focus.el),
  );

  // --- Tamaño y movimiento ---
  const scale = h('input', { type: 'range', class: 'range', id: `ax-scale-${uid}`, min: 90, max: 130, step: 5, value: s.scale, 'aria-label': t('a11y.scale') });
  const scaleVal = h('span', { class: 'ax-value' });
  const scaleHint = h('div', { class: 'ax-hint ax-warn-hint' });
  const minus = h('button', { type: 'button', class: 'icon-btn sm', title: t('a11y.cmdScaleDown'), 'aria-label': t('a11y.cmdScaleDown'), onclick: () => setA11y({ scale: Math.max(90, local.scale - 5) }) }, icon('zoomOut'));
  const plus = h('button', { type: 'button', class: 'icon-btn sm', title: t('a11y.cmdScaleUp'), 'aria-label': t('a11y.cmdScaleUp'), onclick: () => setA11y({ scale: Math.min(130, local.scale + 5) }) }, icon('zoomIn'));
  const resetScale = h('button', { type: 'button', class: 'btn sm ghost', onclick: () => setA11y({ scale: 100 }) }, t('a11y.scaleReset'));
  scale.addEventListener('input', () => setA11y({ scale: Number(scale.value) }, { delay: 400 }));
  const motionSeg = segmented(
    [
      { value: 'auto', label: t('a11y.motionAuto') },
      { value: 'on', label: t('a11y.motionOn') },
      { value: 'off', label: t('a11y.motionOff') },
    ],
    s.reduceMotion,
    (v) => setA11y({ reduceMotion: v }),
    t('a11y.reduceMotion'),
  );
  const motionHint = h('div', { class: 'ax-hint' });
  const sizing = card(
    'type',
    t('a11y.panelSize'),
    t('a11y.panelSizeSub'),
    h(
      'div',
      { class: 'ax-field' },
      h('div', { class: 'ax-field-head' }, h('label', { class: 'label', for: `ax-scale-${uid}` }, t('a11y.scale')), h('div', { class: 'row ax-head-tools' }, scaleVal, resetScale)),
      h('div', { class: 'ax-scale-row' }, minus, scale, plus),
      h('div', { class: 'ax-scale-marks', 'aria-hidden': 'true' }, ['90', '100', '110', '120', '130'].map((v) => h('span', {}, `${v} %`))),
      scaleHint,
    ),
    h('div', { class: 'ax-field' }, h('div', { class: 'label' }, t('a11y.reduceMotion')), motionSeg.el, motionHint),
  );

  // --- Teclado ---
  const shortcuts = [
    [['Ctrl', 'K'], t('a11y.keyPalette')],
    [['Tab'], t('a11y.keyTab')],
    [['Enter'], t('a11y.keyEnter')],
    [['Esc'], t('a11y.keyEsc')],
    [['Ctrl', 'J'], t('a11y.keyAssistant')],
    [['Ctrl', 'Shift', 'R'], t('a11y.keyReload')],
  ];
  const keyboard = card(
    'keyboard',
    t('a11y.panelKeyboard'),
    t('a11y.panelKeyboardSub'),
    h(
      'div',
      { class: 'ax-palette-promo' },
      h('div', { class: 'ax-promo-icon' }, icon('search')),
      h('div', { class: 'ax-promo-text' }, h('div', { class: 'ax-promo-title' }, t('a11y.paletteTitle')), h('div', { class: 'ax-hint' }, t('a11y.paletteText'))),
      h('button', { type: 'button', class: 'btn sm', onclick: () => openCommandPalette() }, h('span', { class: 'kbd' }, 'Ctrl'), h('span', { class: 'kbd' }, 'K'), t('a11y.paletteOpen')),
    ),
    h(
      'dl',
      { class: 'ax-keys' },
      shortcuts.map(([keys, label]) => h('div', { class: 'ax-key' }, h('dt', {}, keys.map((k) => h('span', { class: 'kbd' }, k))), h('dd', {}, label))),
    ),
    h('div', { class: 'ax-hint ax-sr-note' }, icon('info'), t('a11y.screenReaderNote')),
  );

  // --- Control ---
  const padBox = h('div', { class: 'ax-pad-status', role: 'status', 'aria-live': 'polite' });
  const padToggle = toggleRow(t('a11y.gamepad'), t('a11y.gamepadSub'), s.gamepad, (v) => setA11y({ gamepad: v }));
  const hintsToggle = toggleRow(t('a11y.gamepadHints'), t('a11y.gamepadHintsSub'), s.gamepadHints, (v) => setA11y({ gamepadHints: v }));
  const couch = toggleRow(t('a11y.couchMode'), t('a11y.couchModeSub'), s.couchMode, (v) => setA11y({ couchMode: v }));
  const legend = h('div', { class: 'ax-pad-legend' });
  const drawLegend = () => {
    const st = gamepadStatus();
    const kind = st.pads[0] ? padKind(st.pads[0].id) : st.kind;
    const g = { DPAD: '✚', RS: kind === 'xbox' ? 'RS' : 'R', ...glyphsFor(kind) };
    const item = (names, label) => h('div', { class: 'ax-pad-item' }, h('span', { class: 'ax-pad-keys' }, names.map((n) => h('span', { class: `ax-pad-btn ax-pad-${kind} ax-pad-${n.toLowerCase()}` }, g[n] || n))), h('span', {}, label));
    mount(
      legend,
      item(['DPAD'], t('a11y.padMove')),
      item(['A'], t('a11y.padSelect')),
      item(['B'], t('a11y.padBack')),
      item(['LB', 'RB'], t('a11y.padPages')),
      item(['LT', 'RT'], t('a11y.padTabs')),
      item(['Y'], t('a11y.padSearch')),
      item(['X'], t('a11y.padContext')),
      item(['START'], t('a11y.padHomePlay')),
      item(['VIEW'], t('a11y.padMenu')),
      item(['RS'], t('a11y.padScroll')),
    );
  };
  const drawPad = () => {
    const st = gamepadStatus();
    if (!local.gamepad) {
      mount(padBox, h('span', { class: 'ax-pad-dot off' }), h('div', {}, h('div', { class: 'ax-pad-name' }, t('a11y.padDisabled')), h('div', { class: 'ax-hint' }, t('a11y.padDisabledText'))));
    } else if (!st.pads.length) {
      mount(padBox, h('span', { class: 'ax-pad-dot' }), h('div', {}, h('div', { class: 'ax-pad-name' }, t('a11y.padNone')), h('div', { class: 'ax-hint' }, t('a11y.padNoneText'))));
    } else {
      const deck = st.pads.some((p) => p.deck);
      mount(
        padBox,
        h('span', { class: 'ax-pad-dot on' }),
        h(
          'div',
          { class: 'ax-pad-names' },
          st.pads.map((p) => h('div', { class: 'ax-pad-name ellipsis', title: p.id }, icon('gamepad'), p.name)),
          h('div', { class: 'ax-hint' }, deck && !local.couchMode ? t('a11y.padDeckHint') : t('a11y.padConnectedText')),
        ),
      );
    }
    drawLegend();
  };
  const controller = card(
    'gamepad',
    t('a11y.panelGamepad'),
    t('a11y.panelGamepadSub'),
    padBox,
    h('div', { class: 'ax-toggles' }, padToggle.el, hintsToggle.el, couch.el),
    h('details', { class: 'ax-details' }, h('summary', {}, t('a11y.padMapping')), legend),
    h(
      'div',
      { class: 'ax-cfy-promo' },
      h('div', { class: 'ax-promo-icon' }, icon('pickaxe')),
      h('div', { class: 'ax-promo-text' }, h('div', { class: 'ax-promo-title' }, t('a11y.cfyPromoTitle')), h('div', { class: 'ax-hint' }, t('a11y.cfyPromoText'))),
      h('button', { type: 'button', class: 'btn primary sm', onclick: () => openControlifyInstaller() }, icon('download'), t('a11y.cfyButton')),
    ),
  );

  // Volver a los valores de fabrica pisa todas las elecciones: se confirma antes (igual que en Apariencia)
  const resetBtn = h(
    'button',
    {
      type: 'button',
      class: 'btn ghost sm',
      onclick: async () => {
        if (!(await confirmDialog(t('a11y.resetTitle'), t('a11y.resetText'), { okText: t('a11y.resetOk'), cancelText: t('a11y.cancel') }))) return;
        setA11y({ ...A11Y_DEFAULTS });
      },
    },
    icon('undo'),
    t('a11y.resetAll'),
  );

  mount(root, vision, sizing, keyboard, controller, h('div', { class: 'ax-panel-foot' }, h('span', { class: 'ax-hint' }, t('a11y.liveNote')), resetBtn));

  // --- Sincronizar controles con el estado ---
  const sync = () => {
    const v = local;
    cvdSeg.set(v.colorblind);
    cvdDesc.textContent = t(`a11y.cvdDesc_${v.colorblind}`);
    strengthBox.hidden = v.colorblind === 'none';
    if (document.activeElement !== strength) strength.value = v.cvdStrength;
    strengthVal.textContent = t('a11y.percent', { value: v.cvdStrength });
    strength.setAttribute('aria-valuetext', t('a11y.percent', { value: v.cvdStrength }));
    shapes.set(v.statusShapes);
    hc.set(v.highContrast);
    hcHint.hidden = !(contrastQuery?.matches && !v.highContrast);
    focus.set(v.focusRings);
    if (document.activeElement !== scale) scale.value = v.scale;
    const info = scaleInfo(v);
    scaleVal.textContent = v.couchMode && v.scale < COUCH_SCALE ? t('a11y.scaleValueCouch', { value: info.requested }) : t('a11y.scaleValue', { value: v.scale });
    scale.setAttribute('aria-valuetext', t('a11y.scaleValue', { value: v.scale }));
    scaleHint.hidden = !info.limited;
    scaleHint.replaceChildren(icon('info'), t('a11y.scaleLimited', { max: info.max }));
    minus.disabled = v.scale <= 90;
    plus.disabled = v.scale >= 130;
    resetScale.disabled = v.scale === 100;
    motionSeg.set(v.reduceMotion);
    motionHint.textContent = v.reduceMotion === 'auto' ? (motionQuery?.matches ? t('a11y.motionAutoOn') : t('a11y.motionAutoOff')) : t('a11y.motionHint');
    padToggle.set(v.gamepad);
    hintsToggle.set(v.gamepadHints);
    couch.set(v.couchMode);
    drawPad();
  };
  sync();
  // Las suscripciones se sueltan solas en el primer aviso despues de que el panel sale del documento
  let wasConnected = false;
  const offs = [];
  const guard = () => {
    if (root.isConnected) {
      wasConnected = true;
      sync();
    } else if (wasConnected) offs.forEach((off) => off());
  };
  offs.push(onState(guard), onGamepadChange(guard));
}

// ---------- Controlify ----------
function modLoaders(inst) {
  switch (inst?.loader) {
    case 'fabric':
      return ['fabric'];
    case 'quilt':
      return ['quilt', 'fabric'];
    case 'legacyfabric':
      return ['legacy-fabric', 'fabric'];
    case 'neoforge':
      return inst.mcVersion === '1.20.1' ? ['neoforge', 'forge'] : ['neoforge'];
    case 'forge':
      return ['forge'];
    default:
      return [];
  }
}

const STATUS_ORDER = { ok: 0, unknown: 1, installed: 2, noVersion: 3, noLoader: 4 };

export async function openControlifyInstaller() {
  ensureCss('a11y');
  await loadNs('a11y').catch(() => {});
  let selected = null;
  let projectId = null;
  let versions = null;
  // Mientras se consulta Modrinth se ve la forma de la lista (instancias con su estado)
  const listBox = h('div', { class: 'ax-cfy-list', role: 'radiogroup', 'aria-label': t('a11y.cfyPick') }, skeleton('list', { rows: 3, label: t('a11y.cfyLoading') }));
  const installBtn = h('button', { type: 'button', class: 'btn primary', disabled: true }, icon('download'), t('a11y.cfyInstall'));
  const cancelBtn = h('button', { type: 'button', class: 'btn ghost', onclick: () => m.close() }, t('a11y.cancel'));
  const m = modal({
    title: t('a11y.cfyTitle'),
    body: h('div', { class: 'stack ax-cfy' }, h('p', { class: 'ax-desc' }, t('a11y.cfyIntro')), listBox),
    footer: [cancelBtn, installBtn],
  });

  try {
    await store.refreshInstances();
  } catch {
    /* se usa la lista que ya habia */
  }
  const insts = store.instances || [];
  if (!insts.length) {
    // Sin instancias la accion principal es crear una: el pie queda solo con Cerrar (un primario por vista)
    installBtn.hidden = true;
    cancelBtn.textContent = t('common.close');
    mount(
      listBox,
      emptyState(
        'layers',
        t('a11y.cfyNoInstances'),
        t('a11y.cfyNoInstancesText'),
        h(
          'button',
          {
            type: 'button',
            class: 'btn primary',
            onclick: () => {
              m.close();
              navigate('versions/new');
            },
          },
          icon('plus'),
          t('a11y.cfyCreate'),
        ),
      ),
    );
    return;
  }
  let offline = false;
  try {
    versions = await api.modrinth.versions(CONTROLIFY, { includeChangelog: false });
    projectId = versions?.[0]?.project_id || null;
  } catch (err) {
    offline = true;
    console.warn('[a11y] controlify', err);
  }
  if (!listBox.isConnected) return;

  const statusOf = (inst) => {
    if (projectId && inst.modrinth?.projects?.[projectId]) return 'installed';
    const loaders = modLoaders(inst);
    if (!loaders.length) return 'noLoader';
    if (!Array.isArray(versions)) return 'unknown';
    const okv = versions.some((v) => v.game_versions?.includes(inst.mcVersion) && v.loaders?.some((l) => loaders.includes(l)));
    return okv ? 'ok' : 'noVersion';
  };
  const rows = insts.map((inst) => ({ inst, status: statusOf(inst) })).sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
  const pickable = (st) => st === 'ok' || st === 'unknown';
  const preferred = rows.find((r) => r.inst.id === store.selectedInstance?.()?.id && pickable(r.status)) || rows.find((r) => pickable(r.status));
  selected = preferred?.inst || null;

  const pillFor = (st, inst) => {
    if (st === 'ok') return h('span', { class: 'pill good' }, icon('check'), t('a11y.cfyOk'));
    if (st === 'installed') return h('span', { class: 'pill' }, icon('check'), t('a11y.cfyInstalled'));
    if (st === 'unknown') return h('span', { class: 'pill warn' }, icon('info'), t('a11y.cfyUnknown'));
    if (st === 'noVersion') return h('span', { class: 'pill bad' }, icon('x'), t('a11y.cfyNoVersion', { version: inst.mcVersion }));
    return h('span', { class: 'pill bad' }, icon('x'), t('a11y.cfyNoLoader'));
  };
  const draw = () => {
    const nodes = rows.map(({ inst, status }) => {
      const can = pickable(status);
      const on = selected?.id === inst.id;
      return h(
        'div',
        {
          class: ['ax-cfy-item', on && 'active', !can && 'disabled'],
          role: 'radio',
          'aria-checked': String(on),
          'aria-disabled': String(!can),
          tabindex: on || (!selected && can && rows.find((r) => pickable(r.status))?.inst.id === inst.id) ? 0 : -1,
          dataset: { id: inst.id },
          onclick: () => {
            if (!can) return;
            selected = inst;
            draw();
            listBox.querySelector('.ax-cfy-item.active')?.focus();
          },
        },
        h('span', { class: 'ax-radio', 'aria-hidden': 'true' }),
        instanceIcon(inst),
        h('div', { class: 'ax-cfy-main' }, h('div', { class: 'ax-cfy-name ellipsis', title: inst.name }, inst.name), h('div', { class: 'ax-cfy-meta' }, loaderBadge(instanceLoaderKey(inst), inst.mcVersion))),
        pillFor(status, inst),
      );
    });
    mount(listBox, offline ? h('div', { class: 'notice' }, icon('wifi'), t('a11y.cfyOffline')) : null, nodes);
    installBtn.disabled = !selected;
  };
  listBox.addEventListener('keydown', (e) => {
    if (!['ArrowDown', 'ArrowUp'].includes(e.key)) return;
    e.preventDefault();
    const enabled = rows.filter((r) => pickable(r.status));
    if (!enabled.length) return;
    const i = enabled.findIndex((r) => r.inst.id === selected?.id);
    const next = enabled[(i + (e.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length];
    selected = next.inst;
    draw();
    listBox.querySelector('.ax-cfy-item.active')?.focus();
  });
  draw();
  if (!rows.some((r) => pickable(r.status))) {
    listBox.prepend(h('div', { class: 'notice' }, icon('info'), t('a11y.cfyNoneCompatible')));
  }
  // la lista llega despues de abrir el dialogo: el foco pasa a la instancia elegida
  requestAnimationFrame(() => {
    const active = document.activeElement;
    if (!m.el.contains(active) || active === m.el) listBox.querySelector('.ax-cfy-item.active')?.focus({ preventScroll: true });
  });

  installBtn.addEventListener('click', async () => {
    const inst = selected;
    if (!inst) return;
    const done = setBusy(installBtn);
    // checkBeforeInstall modifica items en el lugar: deja la version elegida y quita lo que se omitio
    const items = [{ projectId: projectId || CONTROLIFY }];
    let proceed = true;
    try {
      const compat = await import('./features/compat.js');
      if (typeof compat.checkBeforeInstall === 'function') proceed = await compat.checkBeforeInstall({ target: { kind: 'instance', id: inst.id }, items });
    } catch (err) {
      console.warn('[a11y] compat', err);
      proceed = true;
    }
    done();
    if (!proceed || !items.length) return;
    m.close();
    toast('info', t('a11y.cfyInstalling', { name: inst.name }), t('a11y.cfyInstallingText'), 3500);
    try {
      const res = await api.modrinth.install(inst.id, items[0].projectId || projectId || CONTROLIFY, items[0].versionId || null);
      const warnings = Array.isArray(res?.warnings) ? res.warnings.filter(Boolean) : [];
      ok(t('a11y.cfyDone', { name: inst.name }), warnings.length ? warnings.slice(0, 2).join(' · ') : t('a11y.cfyDoneText'));
      store.refreshInstances().catch(() => {});
    } catch (err) {
      // el panel de tareas ya muestra el error de la instalacion
      console.warn('[a11y] controlify', err);
    }
  });
}
