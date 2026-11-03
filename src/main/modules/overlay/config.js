'use strict';
// Ajustes del overlay (settings.overlay) con sus valores por defecto. Sin Electron: lo usan el modulo, la
// pagina (le llega ya normalizado) y las pruebas.
//   overlay: { enabled, shortcut, widgets: { voice, messages, alerts, captures, music, perf } }
// Cada widget: { enabled, anchor ('tl'...'br' de la grilla de 3x3 o 'free'), x, y (posicion libre, fracciones
// de 0 a 1 del espacio que queda dentro del juego), scale (0.6 a 1.6), opacity (0.3 a 1), theme ('dark',
// 'light' o 'accent') } y lo propio de cada uno (ver DEFAULTS).

const WIDGETS = ['voice', 'messages', 'alerts', 'captures', 'music', 'perf'];
const ANCHORS = ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br'];
const THEMES = ['dark', 'light', 'accent'];
const ALERT_GROUPS = ['launcher', 'friends', 'servers', 'rewards'];
// Widget de rendimiento (3.1): que medidas muestra. No hay FPS: no se pueden medir desde afuera del juego.
const PERF_METRICS = ['ram', 'cpu', 'ping', 'session'];
const DEFAULT_SHORTCUT = 'Alt+Shift+O';

const base = (anchor, x, y) => ({ enabled: true, anchor, x, y, scale: 1, opacity: 0.94, theme: 'dark' });

const DEFAULTS = Object.freeze({
  enabled: true,
  shortcut: DEFAULT_SHORTCUT,
  widgets: {
    // show: 'all' (toda la sala) o 'speaking' (solo quien habla)
    voice: { ...base('tl', 0, 0), show: 'all' },
    // hideContent: solo quien escribio, sin el texto
    messages: { ...base('ml', 0, 0.5), hideContent: false, duration: 8 },
    // filter: que avisos se muestran
    alerts: { ...base('tr', 1, 0), duration: 6, filter: { launcher: true, friends: true, servers: true, rewards: true } },
    captures: { ...base('br', 1, 1), duration: 5 },
    // show: 'always' (mientras suena) o 'change' (unos segundos al cambiar de cancion)
    music: { ...base('br', 1, 1), show: 'always' },
    // show: que medidas van en el widget (RAM y CPU del juego, ping del servidor y tiempo de sesion)
    perf: { ...base('bl', 0, 1), show: { ram: true, cpu: true, ping: true, session: true } },
  },
});

const clamp = (n, min, max, def) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;
};
const round = (n, step) => Number((Math.round(n / step) * step).toFixed(4));
const pick = (v, list, def) => (list.includes(v) ? v : def);
const bool = (v, def) => (typeof v === 'boolean' ? v : def);

// Formato de Electron ("Alt+Shift+O", "CommandOrControl+F9"): al menos un modificador, salvo F13 a F24.
const MODS = ['Command', 'Cmd', 'Control', 'Ctrl', 'CommandOrControl', 'CmdOrCtrl', 'Alt', 'Option', 'AltGr', 'Shift', 'Super', 'Meta'];
const KEY = /^([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|Plus|Space|Tab|Backspace|Delete|Insert|Return|Enter|Up|Down|Left|Right|Home|End|PageUp|PageDown|Escape|Esc|num[0-9]|numdec|numadd|numsub|nummult|numdiv|[`~!@#$%^&*()\-_=[\]{};:'",.<>/?\\|])$/;
function validAccelerator(accel) {
  if (typeof accel !== 'string') return false;
  const parts = accel.trim().split('+');
  if (!parts.length || parts.length > 4 || parts.some((p) => !p)) return false;
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  if (!KEY.test(key)) return false;
  if (mods.some((m) => !MODS.includes(m)) || new Set(mods).size !== mods.length) return false;
  return mods.length > 0 || /^F(1[3-9]|2[0-4])$/.test(key);
}

function normalizeWidget(id, raw) {
  const d = DEFAULTS.widgets[id];
  const r = raw && typeof raw === 'object' ? raw : {};
  const out = {
    enabled: bool(r.enabled, d.enabled),
    anchor: pick(r.anchor, [...ANCHORS, 'free'], d.anchor),
    x: round(clamp(r.x, 0, 1, d.x), 0.0001),
    y: round(clamp(r.y, 0, 1, d.y), 0.0001),
    scale: round(clamp(r.scale, 0.6, 1.6, d.scale), 0.05),
    opacity: round(clamp(r.opacity, 0.3, 1, d.opacity), 0.01),
    theme: pick(r.theme, THEMES, d.theme),
  };
  if (id === 'voice') out.show = pick(r.show, ['all', 'speaking'], d.show);
  if (id === 'music') out.show = pick(r.show, ['always', 'change'], d.show);
  if (id === 'messages') out.hideContent = bool(r.hideContent, d.hideContent);
  if ('duration' in d) out.duration = Math.round(clamp(r.duration, 2, 30, d.duration));
  if (id === 'alerts') {
    const f = r.filter && typeof r.filter === 'object' ? r.filter : {};
    out.filter = Object.fromEntries(ALERT_GROUPS.map((g) => [g, bool(f[g], d.filter[g])]));
  }
  if (id === 'perf') {
    const s = r.show && typeof r.show === 'object' ? r.show : {};
    out.show = Object.fromEntries(PERF_METRICS.map((m) => [m, bool(s[m], d.show[m])]));
  }
  return out;
}

// settings.overlay (cualquier cosa) -> configuracion completa y valida.
function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const w = r.widgets && typeof r.widgets === 'object' ? r.widgets : {};
  let shortcut = DEFAULTS.shortcut;
  if (r.shortcut === '' || r.shortcut === null) shortcut = '';
  else if (validAccelerator(r.shortcut)) shortcut = r.shortcut.trim();
  return {
    enabled: bool(r.enabled, DEFAULTS.enabled),
    shortcut,
    widgets: Object.fromEntries(WIDGETS.map((id) => [id, normalizeWidget(id, w[id])])),
  };
}

// Posicion que manda la pagina al arrastrar un widget (modo edicion) -> parche para settings.overlay.widgets.
function positionPatch(id, pos) {
  if (!WIDGETS.includes(id) || !pos || typeof pos !== 'object') return null;
  const anchor = pick(pos.anchor, [...ANCHORS, 'free'], null);
  if (!anchor) return null;
  const out = { anchor };
  if (anchor === 'free') {
    const x = Number(pos.x);
    const y = Number(pos.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    out.x = round(clamp(x, 0, 1, 0), 0.0001);
    out.y = round(clamp(y, 0, 1, 0), 0.0001);
  }
  return { [id]: out };
}

// Parche que vuelve todas las posiciones a las de fabrica (Restablecer).
function resetPatch() {
  return Object.fromEntries(WIDGETS.map((id) => {
    const d = DEFAULTS.widgets[id];
    return [id, { anchor: d.anchor, x: d.x, y: d.y }];
  }));
}

module.exports = { WIDGETS, ANCHORS, THEMES, ALERT_GROUPS, PERF_METRICS, DEFAULTS, DEFAULT_SHORTCUT, normalize, normalizeWidget, positionPatch, resetPatch, validAccelerator };
