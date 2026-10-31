// Piezas compartidas de la pagina de Mundos: iconos propios, etiquetas (modo, dificultad, tipo de mundo),
// formatos, preferencias (settings.worlds), menu emergente, funciones de otros modulos y acciones comunes.
import { h, icon, mount, fail, ok, registerIcons, fmtDuration, fmtNumber, LOADERS } from '../../ui.js';
import { store, api } from '../../store.js';
import { t, locale } from '../../i18n.js';
import { navigate, launchInstance } from '../../app.js';

registerIcons({
  woHourglass: '<path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/>',
  woSprout: '<path d="M7 20h10"/><path d="M10 20c5.5-2.5.8-6.4 3-10"/><path d="M9.5 9.4c1.1.8 1.8 2.2 2.3 3.7-2 .4-3.5.4-4.8-.3-1.2-.6-2.3-1.9-3-4.2 2.8-.5 4.4 0 5.5.8z"/><path d="M14.1 6a7 7 0 0 0-1.1 4c1.9-.1 3.3-.6 4.3-1.4 1-1 1.6-2.3 1.7-4.6-2.7.1-4 1-4.9 2z"/>',
  woFilm: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18"/><path d="M3 7.5h4"/><path d="M3 12h18"/><path d="M3 16.5h4"/><path d="M17 3v18"/><path d="M17 7.5h4"/><path d="M17 16.5h4"/>',
  woFlag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/>',
  woFootprints: '<path d="M4 16v-2.38C4 11.5 2.97 10.5 3 8c.03-2.72 1.49-6 4.5-6C9.37 2 10 3.8 10 5.5c0 3.11-2 5.66-2 8.68V16a2 2 0 1 1-4 0Z"/><path d="M20 20v-2.38c0-2.12 1.03-3.12 1-5.62-.03-2.72-1.49-6-4.5-6C14.63 6 14 7.8 14 9.5c0 3.11 2 5.66 2 8.68V20a2 2 0 1 0 4 0Z"/><path d="M16 17h4"/><path d="M4 13h4"/>',
  woSun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  woSeed: '<path d="M2 22 16 8"/><path d="M3.47 12.53 5 11l1.53 1.53a3.5 3.5 0 0 1 0 4.94L5 19l-1.53-1.53a3.5 3.5 0 0 1 0-4.94Z"/><path d="M7.47 8.53 9 7l1.53 1.53a3.5 3.5 0 0 1 0 4.94L9 15l-1.53-1.53a3.5 3.5 0 0 1 0-4.94Z"/><path d="M11.47 4.53 13 3l1.53 1.53a3.5 3.5 0 0 1 0 4.94L13 11l-1.53-1.53a3.5 3.5 0 0 1 0-4.94Z"/><path d="M20 2h2v2a4 4 0 0 1-4 4h-2V6a4 4 0 0 1 4-4Z"/>',
  woBed: '<path d="M2 4v16"/><path d="M2 8h18a2 2 0 0 1 2 2v10"/><path d="M2 17h20"/><path d="M6 8v9"/>',
});

export const NS = 'worlds';
export const MODE_KEYS = ['survival', 'creative', 'adventure', 'spectator'];
export const DATE_LONG = { day: 'numeric', month: 'long', year: 'numeric' };
export const DATE_TIME = { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' };

export const isMissingHandler = (err) => /No handler registered/i.test(String(err?.message || err || ''));

// Ruta del detalle de un mundo
export function worldRoute(instanceId, folder) {
  return `worlds/${encodeURIComponent(instanceId)}/${encodeURIComponent(folder)}`;
}

export function openWorld(w) {
  navigate(worldRoute(w.instanceId, w.folder));
}

// Clave de modo para colores y textos (el extremo pisa al modo)
export function modeKey(w) {
  if (w?.hardcore) return 'hardcore';
  return MODE_KEYS.includes(w?.gameMode) ? w.gameMode : null;
}

export function modeBadge(w, extraCls = '') {
  const key = modeKey(w);
  if (!key) return null;
  return h('span', { class: ['badge', 'wo-mode', `wo-mode-${key}`, extraCls] }, key === 'hardcore' ? icon('skull') : null, t(`worlds.mode_${key}`));
}

export function difficultyLabel(d) {
  return d ? t(`worlds.diff_${d}`) : t('worlds.unknown');
}

export function worldTypeLabel(type) {
  return type ? t(`worlds.type_${type}`) : t('worlds.unknown');
}

export function categoryLabel(cat) {
  return t(`worlds.cat_${cat}`);
}

// Tiempo corto para tarjetas: "8 h", "45 min"
export function shortDur(ms) {
  if (!ms) return t('worlds.durNone');
  return ms >= 3600000 ? fmtDuration(ms, { short: true }) : fmtDuration(ms);
}

export function fmtInt(n) {
  try {
    return new Intl.NumberFormat(locale()).format(Math.round(Number(n) || 0));
  } catch {
    return String(Math.round(Number(n) || 0));
  }
}

// Distancia en cm -> "12,3 km" o "850 m"
export function fmtDistance(cm) {
  const m = (Number(cm) || 0) / 100;
  try {
    if (m >= 1000) return t('worlds.km', { value: new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(m / 1000) });
    return t('worlds.meters', { value: new Intl.NumberFormat(locale(), { maximumFractionDigits: 0 }).format(m) });
  } catch {
    return `${Math.round(m)} m`;
  }
}

export function fmtCompact(n) {
  return n >= 10000 ? fmtNumber(n) : fmtInt(n);
}

// "minecraft:deepslate_iron_ore" -> "Deepslate iron ore"
export function prettyId(id) {
  const last = String(id || '').split(/[:/]/).pop() || '';
  const words = last.replace(/[_-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : String(id || '');
}

export function instanceOf(id) {
  return store.instances.find((i) => i.id === id) || null;
}

export function isRunning(instanceId) {
  return Boolean(store.running[instanceId]);
}

// Icono del mundo (icon.png en pixel art) o la inicial sobre un bloque de pasto
export function worldIcon(w, cls = '') {
  const letter = () => h('span', { class: 'wo-icon-letter', 'aria-hidden': 'true' }, (String(w?.name || '?').trim().charAt(0) || '?').toUpperCase());
  const box = h('div', { class: ['wo-icon', cls] });
  if (w?.icon) {
    const img = h('img', { src: w.icon, alt: '', loading: 'lazy', decoding: 'async' });
    img.addEventListener('error', () => mount(box, letter()), { once: true });
    box.append(img);
  } else box.append(letter());
  return box;
}

// Insignia chica de la instancia (letra con el color del loader)
export function instanceDot(inst, loaderKey) {
  const meta = LOADERS[loaderKey || inst?.loader] || LOADERS.vanilla;
  return h('span', { class: 'wo-inst-dot', style: { '--c': meta.color }, 'aria-hidden': 'true' }, (String(inst?.name || meta.letter).trim().charAt(0) || meta.letter).toUpperCase());
}

// ---------- Preferencias (clave propia: settings.worlds) ----------
let pending = {};
const SORTS = ['recent', 'name', 'size', 'playtime', 'instance'];
export function prefs() {
  const p = { ...(store.settings?.worlds || {}), ...pending };
  return {
    sort: SORTS.includes(p.sort) ? p.sort : 'recent',
    instance: typeof p.instance === 'string' ? p.instance : '',
    mode: ['all', 'survival', 'creative', 'hardcore', 'adventure'].includes(p.mode) ? p.mode : 'all',
    mediaKind: ['all', 'screenshot', 'clip', 'shared'].includes(p.mediaKind) ? p.mediaKind : 'all',
    mediaInstance: typeof p.mediaInstance === 'string' ? p.mediaInstance : '',
    order: p.order === 'asc' ? 'asc' : 'desc',
  };
}
export function savePrefs(patch) {
  pending = { ...pending, ...patch };
  return store.setSettings({ worlds: prefs() }).catch((err) => console.warn('[worlds] ajustes', err));
}

// ---------- Esqueletos de carga ----------
// Pieza con el brillo de .skeleton (main.css)
export function bone(cls = '', style) {
  return h('span', { class: `skeleton ${cls}`, style });
}

// Grupo que se anuncia una sola vez como "cargando" (las formas son decorativas)
export function skelGroup(label, ...content) {
  return h(
    'div',
    { class: 'skeleton-group', role: 'status', 'aria-live': 'polite', 'aria-busy': 'true' },
    h('span', { class: 'sr-only' }, label || t('common.loading')),
    h('div', { class: 'wo-skel', 'aria-hidden': 'true' }, content),
  );
}

// ---------- Menu emergente ----------
let openMenu = null;

export function closeMenu() {
  if (!openMenu) return;
  const m = openMenu;
  openMenu = null;
  m.cleanup();
}

export function popMenu(anchor, items) {
  if (openMenu?.anchor === anchor) return closeMenu();
  closeMenu();
  const list = items.filter(Boolean);
  const el = h(
    'div',
    { class: 'wo-menu', role: 'menu' },
    list.map((it) =>
      it === '-'
        ? h('div', { class: 'wo-menu-sep', role: 'separator' })
        : h(
            'button',
            {
              class: ['wo-menu-item', it.danger && 'danger'],
              role: 'menuitem',
              type: 'button',
              tabindex: '-1',
              disabled: it.disabled,
              onclick: (e) => {
                e.stopPropagation();
                closeMenu();
                // El foco vuelve al boton que abrio el menu (y de ahi al dialogo que abra la accion)
                if (anchor.isConnected) anchor.focus({ preventScroll: true });
                it.run();
              },
            },
            icon(it.icon),
            h('span', {}, it.label),
          ),
    ),
  );
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const mr = el.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.right - mr.width, window.innerWidth - mr.width - 8));
  let top = r.bottom + 6;
  if (top + mr.height > window.innerHeight - 8) {
    top = r.top - mr.height - 6;
    el.style.transformOrigin = 'bottom right';
  } else el.style.transformOrigin = 'top right';
  el.style.left = `${left}px`;
  el.style.top = `${Math.max(8, top)}px`;
  const buttons = [...el.querySelectorAll('.wo-menu-item:not(:disabled)')];
  buttons[0]?.focus();
  anchor.setAttribute('aria-expanded', 'true');
  const onKey = (e) => {
    const i = buttons.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
      anchor.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      buttons[(i + 1) % buttons.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      buttons[(i - 1 + buttons.length) % buttons.length]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      (e.key === 'Home' ? buttons[0] : buttons.at(-1))?.focus();
    } else if (e.key === 'Tab') closeMenu();
  };
  const onDown = (e) => {
    if (!el.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) closeMenu();
  };
  document.addEventListener('keydown', onKey, true);
  setTimeout(() => document.addEventListener('mousedown', onDown, true), 0);
  window.addEventListener('blur', closeMenu, { once: true });
  openMenu = {
    anchor,
    cleanup() {
      el.remove();
      anchor.setAttribute('aria-expanded', 'false');
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('blur', closeMenu);
    },
  };
  return undefined;
}

export function iconBtn(name, label, onclick, cls = '') {
  return h('button', { class: `icon-btn sm ${cls}`, type: 'button', title: label, 'aria-label': label, onclick }, icon(name));
}

// ---------- Funciones de otros modulos (features) ----------
const FEATURES = {
  worldmap: () => import('../../features/worldmap.js'),
  snapshots: () => import('../../features/snapshots.js'),
  cloudsync: () => import('../../features/cloudsync.js'),
};

export async function runFeature(file, fn, ...args) {
  try {
    const mod = await FEATURES[file]();
    if (typeof mod[fn] !== 'function') throw new Error(fn);
    return await mod[fn](...args);
  } catch (err) {
    console.warn(`[worlds] ${file}.${fn}`, err);
    fail(t('worlds.featureFailed'), err);
    return undefined;
  }
}

// ---------- Acciones ----------
export async function playWorld(w) {
  if (isRunning(w.instanceId)) {
    fail(t('worlds.alreadyRunning'), t('worlds.alreadyRunningText', { name: instanceOf(w.instanceId)?.name || w.instanceName || '' }));
    return false;
  }
  const started = await launchInstance(w.instanceId, { quickPlay: { world: w.folder } });
  if (started) ok(t('worlds.launching'), t('worlds.launchingText', { name: w.name }));
  return started;
}

export function openMap(w) {
  return runFeature('worldmap', 'openWorldMap', w.instanceId, w.folder);
}

export async function backupWorld(w) {
  try {
    const res = await api.invoke('worlds:backup', w.instanceId, w.folder);
    ok(t('worlds.backupDone'), res.skipped ? t('worlds.backupSkipped', { count: res.skipped }) : res.name);
    return res;
  } catch (err) {
    if (!/cancel/i.test(err.message)) fail(t('worlds.backupFailed'), err);
    return null;
  }
}

export function sortWorlds(list, sort) {
  const by = {
    recent: (a, b) => b.lastPlayed - a.lastPlayed,
    name: (a, b) => a.name.localeCompare(b.name, locale(), { sensitivity: 'base', numeric: true }),
    size: (a, b) => (b.size ?? -1) - (a.size ?? -1),
    playtime: (a, b) => (b.playtime || 0) - (a.playtime || 0),
    instance: (a, b) => a.instanceName.localeCompare(b.instanceName, locale(), { sensitivity: 'base' }) || b.lastPlayed - a.lastPlayed,
  };
  return [...list].sort(by[sort] || by.recent);
}

// Compara versiones "1.21.4" / "26.1" (null si no se puede)
export function compareVersions(a, b) {
  const pa = String(a || '').match(/^\d+(?:\.\d+)*/);
  const pb = String(b || '').match(/^\d+(?:\.\d+)*/);
  if (!pa || !pb) return null;
  const x = pa[0].split('.').map(Number);
  const y = pb[0].split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function errorBox(err, onRetry) {
  return h(
    'div',
    { class: 'notice bad wo-error', role: 'alert' },
    icon('alert'),
    h('div', { class: 'spacer' }, h('div', { class: 'wo-error-title' }, t('worlds.loadError')), h('div', { class: 'small' }, err?.message || String(err || ''))),
    onRetry ? h('button', { class: 'btn sm', type: 'button', onclick: onRetry }, icon('refresh'), t('worlds.retry')) : null,
  );
}
