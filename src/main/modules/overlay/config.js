'use strict';
// Ajustes del overlay (settings.overlay) con sus valores por defecto. Sin Electron: lo usan el modulo, la
// pagina (le llega ya normalizado) y las pruebas.
//   overlay: { enabled, shortcut, panelShortcuts: { recipes, assistant, dnd }, widgets: { voice, messages, alerts, captures, music, perf, counters } }
// Desde la 6.1 el overlay viene apagado (enabled: false) hasta que el usuario lo prende (Ajustes o la bienvenida); quien
// actualiza: ver upgradeSaved.
// Cada widget: { enabled, anchor ('tl'...'br' de la grilla de 3x3 o 'free'), x, y (posicion libre, fracciones
// de 0 a 1 del espacio que queda dentro del juego), scale (0.6 a 1.6), opacity (0.3 a 1), theme ('dark',
// 'light' o 'accent') } y lo propio de cada uno (ver DEFAULTS).

const WIDGETS = ['voice', 'messages', 'alerts', 'captures', 'music', 'perf', 'counters'];
const ANCHORS = ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br'];
const THEMES = ['dark', 'light', 'accent'];
const ALERT_GROUPS = ['launcher', 'friends', 'servers', 'rewards'];
// Widget de rendimiento (3.1): que medidas muestra. Los FPS solo se saben con el mod Venus Badge (perfhistory/fps.js).
const PERF_METRICS = ['fps', 'ram', 'cpu', 'ping', 'session'];
// Contadores en pantalla: muertes, bloques minados y tiempo de sesion (overlay/counters.js).
const COUNTER_METRICS = ['deaths', 'mined', 'session'];
const DEFAULT_SHORTCUT = 'Alt+Shift+O';
// Paneles que se abren en el modo interactivo (recetas y asistente), con su atajo.
const PANELS = ['recipes', 'assistant'];
// Atajos que se arman como los de los paneles (solo con el juego adelante): los dos paneles y "No molestar".
const SHORTCUT_IDS = [...PANELS, 'dnd'];
const PANEL_SHORTCUTS = Object.freeze({ recipes: 'Alt+Shift+R', assistant: 'Alt+Shift+A', dnd: 'Alt+Shift+N' });
// "No molestar": minutos que dura (o 'game' = hasta cerrar el juego, ver dndPlan)
const DND_MINUTES = [15, 60];

const base = (anchor, x, y) => ({ enabled: true, anchor, x, y, scale: 1, opacity: 0.94, theme: 'dark' });

const DEFAULTS = Object.freeze({
  enabled: false,
  shortcut: DEFAULT_SHORTCUT,
  panelShortcuts: { ...PANEL_SHORTCUTS },
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
    // show: que medidas van en el widget (FPS, RAM y CPU del juego, ping del servidor y tiempo de sesion)
    perf: { ...base('bl', 0, 1), show: { fps: true, ram: true, cpu: true, ping: true, session: true } },
    // show: que contadores van en el widget (se cuentan desde que se abrio el juego)
    counters: { ...base('bl', 0, 1), show: { deaths: true, mined: true, session: true } },
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

// ---------- Choques entre atajos ----------
// Un atajo global le saca la combinacion a quien este adelante. Mientras se juega, el que adelante es Minecraft: una
// combinacion con solo Ctrl o Mayus (correr, agacharse, soltar, chat) o con Ctrl+Alt (que es AltGr en los teclados con
// la arroba, el euro y la barra invertida en esa tecla) le romperia el teclado al juego. Y entre los de Venus (Voice
// Chat, capturas, musica y los del propio overlay) no se pueden repetir: el segundo que se registra se quedaria sin
// atajo, en silencio.
const MOD_CANON = { Command: 'Super', Cmd: 'Super', Super: 'Super', Meta: 'Super', Control: 'Ctrl', Ctrl: 'Ctrl', CommandOrControl: 'Ctrl', CmdOrCtrl: 'Ctrl', Alt: 'Alt', Option: 'Alt', AltGr: 'AltGr', Shift: 'Shift' };
const MOD_ORDER = ['Ctrl', 'Alt', 'AltGr', 'Shift', 'Super'];
const KEY_CANON = { Esc: 'Escape', Return: 'Enter', Plus: '+' };

// "Shift+Alt+o" -> { mods: ['Alt', 'Shift'], key: 'O', text: 'Alt+Shift+O' } (null si no es un atajo valido)
function parseAccelerator(accel) {
  if (!validAccelerator(accel)) return null;
  const parts = accel.trim().split('+');
  const raw = parts[parts.length - 1];
  const key = KEY_CANON[raw] || (raw.length === 1 ? raw.toUpperCase() : raw);
  // Sin repetidas y siempre en el mismo orden: Alt+Shift+O y Shift+Alt+O son el mismo atajo
  const mods = [...new Set(parts.slice(0, -1).map((m) => MOD_CANON[m]))].sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
  return { mods, key, text: [...mods, key].join('+') };
}

const canonAccelerator = (accel) => parseAccelerator(accel)?.text || '';

// Combinaciones de Windows que no se le pueden sacar al sistema
const SYSTEM_KEYS = new Set(['Alt+F4', 'Alt+Tab', 'Alt+Shift+Tab', 'Alt+Enter', 'Alt+Space', 'Alt+Escape', 'Ctrl+Escape', 'Ctrl+Shift+Escape', 'Ctrl+Alt+Tab', 'Super+L', 'Super+D', 'Super+Tab']);
const PRINTABLE = /^([A-Z0-9]|Plus|[`~!@#$%^&*()\-_=[\]{};:'",.<>/?\\|+])$/;

// Por que un atajo no conviene (aunque sea valido): 'system', 'minecraft' o 'altgr'; null si esta bien.
//   system     combinacion de Windows (Alt+F4, Alt+Tab...)
//   minecraft  solo Ctrl y/o Mayus (con cualquier tecla salvo F13 a F24): son las teclas de correr y agacharse
//   altgr      Ctrl+Alt con una tecla que se escribe (es AltGr en muchos teclados)
function shortcutIssue(accel) {
  const p = parseAccelerator(accel);
  if (!p) return 'invalid';
  if (SYSTEM_KEYS.has(p.text)) return 'system';
  if (/^F(1[3-9]|2[0-4])$/.test(p.key)) return null;
  const alt = p.mods.includes('Alt') || p.mods.includes('AltGr');
  if (!alt && !p.mods.includes('Super')) return 'minecraft';
  if (p.mods.includes('AltGr') || (alt && p.mods.includes('Ctrl'))) return PRINTABLE.test(p.key) ? 'altgr' : null;
  return null;
}

// Primer atajo de la lista ({ id, accel }) que es el mismo que accel (sin importar el orden de las teclas ni los sinonimos)
function findConflict(accel, list) {
  const want = canonAccelerator(accel);
  if (!want) return null;
  for (const item of Array.isArray(list) ? list : []) if (item && canonAccelerator(item.accel) === want) return item;
  return null;
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
  if (id === 'perf' || id === 'counters') {
    const s = r.show && typeof r.show === 'object' ? r.show : {};
    out.show = Object.fromEntries((id === 'perf' ? PERF_METRICS : COUNTER_METRICS).map((m) => [m, bool(s[m], d.show[m])]));
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
  const ps = r.panelShortcuts && typeof r.panelShortcuts === 'object' ? r.panelShortcuts : {};
  // Dos atajos iguales no pueden convivir (el segundo no se registraria): gana el de arriba, el otro queda sin atajo
  const taken = new Set([canonAccelerator(shortcut)].filter(Boolean));
  const panelShortcuts = Object.fromEntries(SHORTCUT_IDS.map((id) => {
    let value = '';
    if (ps[id] === '' || ps[id] === null) value = '';
    else value = validAccelerator(ps[id]) ? ps[id].trim() : PANEL_SHORTCUTS[id];
    const canon = canonAccelerator(value);
    if (canon && taken.has(canon)) value = '';
    else if (canon) taken.add(canon);
    return [id, value];
  }));
  return {
    enabled: bool(r.enabled, DEFAULTS.enabled),
    shortcut,
    panelShortcuts,
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

// Tamano, opacidad y "oculto" de un widget desde el modo edicion (mismas reglas que normalizeWidget) -> parche o null.
function tweakPatch(id, patch) {
  if (!WIDGETS.includes(id) || !patch || typeof patch !== 'object') return null;
  const d = DEFAULTS.widgets[id];
  const out = {};
  if (typeof patch.enabled === 'boolean') out.enabled = patch.enabled;
  if (typeof patch.scale === 'number' && Number.isFinite(patch.scale)) out.scale = round(clamp(patch.scale, 0.6, 1.6, d.scale), 0.05);
  if (typeof patch.opacity === 'number' && Number.isFinite(patch.opacity)) out.opacity = round(clamp(patch.opacity, 0.3, 1, d.opacity), 0.01);
  return Object.keys(out).length ? { [id]: out } : null;
}

// ---------- Disenos listos ----------
// Tres puntos de partida de un clic. Solo prenden o apagan widgets y tocan un par de opciones: la posicion, el tamano y el
// tema de cada uno no cambian (el usuario los ajusta despues).
//   minimal      la voz (solo quien habla) y los avisos, cortos
//   full         todos los widgets
//   performance  solo el rendimiento (FPS, RAM, CPU, ping y sesion)
const PRESET_IDS = ['minimal', 'full', 'performance'];
const off = { enabled: false };
const PRESETS = Object.freeze({
  minimal: { voice: { enabled: true, show: 'speaking' }, messages: off, alerts: { enabled: true, duration: 4 }, captures: off, music: off, perf: off, counters: off },
  full: { voice: { enabled: true, show: 'all' }, messages: { enabled: true }, alerts: { enabled: true, duration: 6 }, captures: { enabled: true }, music: { enabled: true }, perf: { enabled: true }, counters: { enabled: true } },
  performance: { voice: off, messages: off, alerts: off, captures: off, music: off, perf: { enabled: true, show: { fps: true, ram: true, cpu: true, ping: true, session: true } }, counters: off },
});

// Diseno -> parche para settings.overlay.widgets (null si no existe)
function presetPatch(id) {
  return PRESET_IDS.includes(id) ? JSON.parse(JSON.stringify(PRESETS[id])) : null;
}

// ---------- No molestar ----------
// Modo pedido (15, 60 o 'game') -> { until (epoch ms; 0 si es hasta cerrar el juego), game }; null si no vale.
function dndPlan(mode, now = Date.now()) {
  if (mode === 'game') return { until: 0, game: true };
  const min = Number(mode);
  return DND_MINUTES.includes(min) ? { until: now + min * 60000, game: false } : null;
}

// Lo que se calla con "No molestar": los avisos y los mensajes. La voz, la musica, las capturas propias, el rendimiento y
// los contadores siguen (no interrumpen). Tampoco se callan los avisos de las capturas (un clip que no se pudo guardar) ni
// los de la musica (el volumen que cambio el jugador con su atajo): son respuesta a algo que hizo el. Los demas avisos
// directos o criticos los marca quien los manda (push(ev, { direct: true }) en overlay.js).
const DND_KEEP_ICONS = ['capture', 'music'];
const dndSilences = (ev) => ev?.kind === 'message' || (ev?.kind === 'alert' && !DND_KEEP_ICONS.includes(ev.icon));

// ---------- Actualizacion a la 6.1 ----------
// El overlay venia prendido por defecto y ahora viene apagado. core/settings.js lo llama con lo que lee del disco, antes de
// mezclarlo con los valores por defecto (asi se distingue "nunca lo toco" de "lo apago a mano"):
//   - quien ya habia terminado la bienvenida (onboarded) y nunca guardo overlay.enabled lo usaba con el valor por defecto:
//     queda apagado como todos y con offNotice: 'pending' (la interfaz muestra un aviso unico y lo pasa a 'seen').
//   - quien lo prendio o lo apago a mano conserva su eleccion; una instalacion nueva no tiene nada que avisar.
function upgradeSaved(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.onboarded !== true) return raw;
  const ov = raw.overlay && typeof raw.overlay === 'object' && !Array.isArray(raw.overlay) ? raw.overlay : null;
  if (typeof ov?.enabled === 'boolean' || ov?.offNotice) return raw;
  return { ...raw, overlay: { ...(ov || {}), enabled: false, offNotice: 'pending' } };
}

// Parche que vuelve todas las posiciones a las de fabrica (Restablecer).
function resetPatch() {
  return Object.fromEntries(WIDGETS.map((id) => {
    const d = DEFAULTS.widgets[id];
    return [id, { anchor: d.anchor, x: d.x, y: d.y }];
  }));
}

module.exports = { WIDGETS, ANCHORS, THEMES, ALERT_GROUPS, PERF_METRICS, COUNTER_METRICS, PANELS, SHORTCUT_IDS, PANEL_SHORTCUTS, DND_MINUTES, PRESET_IDS, PRESETS, DEFAULTS, DEFAULT_SHORTCUT, presetPatch, dndPlan, dndSilences, upgradeSaved, normalize, normalizeWidget, positionPatch, tweakPatch, resetPatch, validAccelerator, canonAccelerator, shortcutIssue, findConflict };
