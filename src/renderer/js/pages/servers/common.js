// Utilidades compartidas por la lista de servidores, el asistente y el detalle.
import { h, icon, registerIcons, toast, reducedMotion } from '../../ui.js';
import { api } from '../../store.js';
import { t } from '../../i18n.js';

registerIcons({
  svProxy: '<path d="M2 12h5"/><path d="M17 12h5"/><rect width="10" height="8" x="7" y="8" rx="2"/><path d="M12 8V4"/><path d="M12 20v-4"/>',
  svHybrid: '<path d="M12 2v6"/><path d="M12 16v6"/><circle cx="12" cy="12" r="4"/><path d="m4.93 4.93 2.83 2.83"/><path d="m16.24 16.24 2.83 2.83"/><path d="m4.93 19.07 2.83-2.83"/><path d="m16.24 7.76 2.83-2.83"/>',
  svRestart: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  svSkull: '<path d="M12 2a8 8 0 0 0-8 8v4l2 2v4h12v-4l2-2v-4a8 8 0 0 0-8-8z"/><circle cx="9" cy="11" r="1.5"/><circle cx="15" cy="11" r="1.5"/>',
  svBold: '<path d="M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8"/>',
  svItalic: '<line x1="19" x2="10" y1="4" y2="4"/><line x1="14" x2="5" y1="20" y2="20"/><line x1="15" x2="9" y1="4" y2="20"/>',
  svUnderline: '<path d="M6 4v6a6 6 0 0 0 12 0V4"/><line x1="4" x2="20" y1="20" y2="20"/>',
  svStrike: '<path d="M16 4H9a3 3 0 0 0-2.83 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><line x1="4" x2="20" y1="12" y2="12"/>',
  svShuffle: '<path d="m18 14 4 4-4 4"/><path d="m18 2 4 4-4 4"/><path d="M2 18h1.973a4 4 0 0 0 3.3-1.7l5.454-7.6a4 4 0 0 1 3.3-1.7H22"/><path d="M2 6h1.972a4 4 0 0 1 3.6 2.2"/><path d="M22 18h-6.041a4 4 0 0 1-3.3-1.8l-.359-.45"/>',
  svEraser: '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>',
});

// ---------- Tipos de servidor ----------
let typesCache = null;
const FALLBACK_TYPES = [
  { id: 'vanilla', name: 'Vanilla', kind: 'vanilla', color: '#5fae4d', letter: 'V' },
  { id: 'paper', name: 'Paper', kind: 'plugins', color: '#e8e2da', letter: 'P', plugins: true },
  { id: 'fabric', name: 'Fabric', kind: 'mods', color: '#dbb98d', letter: 'F', mods: true, loaderVersions: true },
  { id: 'forge', name: 'Forge', kind: 'mods', color: '#6f8cff', letter: 'F', mods: true, loaderVersions: true },
  { id: 'neoforge', name: 'NeoForge', kind: 'mods', color: '#ff8a3d', letter: 'N', mods: true, loaderVersions: true },
];

export async function loadTypes() {
  if (typesCache) return typesCache;
  try {
    typesCache = await api.invoke('servers:types');
  } catch (err) {
    console.warn('[servers] tipos', err);
    typesCache = FALLBACK_TYPES;
  }
  return typesCache;
}

export function typeMeta(type) {
  return (typesCache || FALLBACK_TYPES).find((x) => x.id === type) || { id: type, name: type, kind: 'vanilla', color: '#999999', letter: String(type || '?').charAt(0).toUpperCase() };
}

export const KIND_ORDER = ['vanilla', 'plugins', 'mods', 'hybrid', 'proxy'];
export const KIND_ICON = { vanilla: 'box', plugins: 'puzzle', mods: 'package', hybrid: 'svHybrid', proxy: 'svProxy' };

export function typeBadge(type, extra) {
  const m = typeMeta(type);
  return h('span', { class: 'badge loader-badge', style: { '--c': m.color } }, h('span', { class: 'ld' }), m.name, extra ? h('span', { class: 'muted ld-ver' }, extra) : null);
}

// Cuadro con el icono del servidor (server-icon.png) o la letra del tipo.
export function serverTile(s, iconData, size = 46) {
  const m = typeMeta(s.type);
  if (iconData) return h('div', { class: 'sv-tile has-img', style: { width: `${size}px`, height: `${size}px` } }, h('img', { src: iconData, alt: '' }));
  return h('div', { class: 'sv-tile', style: { width: `${size}px`, height: `${size}px`, '--c': m.color, fontSize: `${Math.round(size * 0.42)}px` } }, m.letter || '?');
}

// ---------- Estado ----------
export function stateLabel(state) {
  return t(`servers.state_${state}`) || state;
}

export function statusPill(state, extra) {
  const cls = state === 'online' ? 'good' : state === 'starting' || state === 'stopping' ? 'warn' : '';
  return h('span', { class: ['pill', cls, 'sv-status'] }, h('span', { class: ['status-dot', state] }), stateLabel(state), extra ? h('span', { class: 'sv-status-extra' }, extra) : null);
}

export function serverTask(store, id) {
  for (const task of store.tasks.values()) if (task.meta?.serverId === id && task.state === 'running') return task;
  return null;
}

export function taskBar(task) {
  if (!task) return null;
  const pct = task.progress === null || task.progress === undefined ? null : Math.round(task.progress * 100);
  return h(
    'div',
    { class: 'sv-taskbar' },
    h('div', { class: 'row small' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), h('span', { class: 'ellipsis spacer', title: task.title }, task.title), pct !== null ? h('span', { class: 'num' }, `${pct}%`) : null),
    h('div', { class: ['progress', pct === null && 'indeterminate'], role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': pct === null ? null : String(pct), 'aria-label': task.title }, h('i', { style: { width: `${pct || 0}%` } })),
    task.detail ? h('div', { class: 'tiny muted ellipsis', title: task.detail }, task.detail) : null,
  );
}

// Esqueleto de una pestaña mientras carga (barra de herramientas + tarjetas con filas). Se anuncia una
// sola vez como "Cargando..."; las formas son decorativas.
export function tabSkeleton({ bar = true, cards = 2, rows = 3, columns = 1 } = {}) {
  const bone = (cls) => h('span', { class: `skeleton ${cls}` });
  const card = () =>
    h(
      'div',
      { class: 'skeleton-card' },
      bone('skeleton-line title'),
      h('div', { class: 'skeleton-list' }, Array.from({ length: rows }, () => h('div', { class: 'skeleton-row' }, h('div', { class: 'skeleton-lines' }, bone('skeleton-line'), bone('skeleton-line'))))),
    );
  const list = Array.from({ length: cards }, card);
  return h(
    'div',
    { class: 'skeleton-group', role: 'status', 'aria-live': 'polite', 'aria-busy': 'true' },
    h('span', { class: 'sr-only' }, t('common.loading')),
    h('div', { class: 'skeleton-shapes sv-skel-stack', 'aria-hidden': 'true' }, bar ? bone('sv-skel-bar') : null, columns > 1 ? h('div', { class: 'sv-two-col' }, list) : list),
  );
}

// Error de una accion que corre como tarea: app.js ya muestra el error de la tarea, asi que solo
// se avisa si no hubo una tarea fallida con el mismo mensaje (por ejemplo, si fallo antes de empezar).
export function failUnlessTask(store, title, err) {
  const msg = err?.message || String(err);
  for (const task of store.tasks.values()) if (task.state === 'error' && task.detail === msg) return;
  toast('bad', title, msg, 7000);
}

// Revision de compatibilidad antes de instalar en un servidor (contrato de features/compat.js).
// Devuelve true para seguir; puede cambiar items en el lugar (version elegida y sin los items omitidos).
// Si el modulo no carga, la instalacion sigue como antes.
export async function compatAllows(target, items) {
  try {
    const mod = await import('../../features/compat.js');
    if (typeof mod.checkBeforeInstall !== 'function') return true;
    return (await mod.checkBeforeInstall({ target, items })) !== false;
  } catch (err) {
    console.warn('[servers] checkBeforeInstall', err);
    return true;
  }
}

// Llama a un canal y devuelve fallback si el canal todavia no existe (modulos en construccion).
export async function tryInvoke(channel, args = [], fallback = null) {
  try {
    return await api.invoke(channel, ...args);
  } catch (err) {
    if (/No handler registered/i.test(err.message)) return fallback;
    throw err;
  }
}

export function memLabel(mb) {
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB` : `${mb} MB`;
}

// ---------- MOTD (codigos de formato con §) ----------
export const MC_COLORS = {
  0: '#000000',
  1: '#0000AA',
  2: '#00AA00',
  3: '#00AAAA',
  4: '#AA0000',
  5: '#AA00AA',
  6: '#FFAA00',
  7: '#AAAAAA',
  8: '#555555',
  9: '#5555FF',
  a: '#55FF55',
  b: '#55FFFF',
  c: '#FF5555',
  d: '#FF55FF',
  e: '#FFFF55',
  f: '#FFFFFF',
};
export const MC_FORMATS = { l: 'bold', o: 'italic', n: 'underline', m: 'strike', k: 'obfuscated' };
const OBF_CHARS = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNOPQRSTUVWXYZ0123456789#$%&?';

function styledSpan(text, st) {
  const deco = [st.underline && 'underline', st.strike && 'line-through'].filter(Boolean).join(' ');
  return h(
    'span',
    {
      class: st.obfuscated ? 'sv-obf' : null,
      dataset: st.obfuscated ? { len: String(text.length) } : undefined,
      style: { color: st.color, fontWeight: st.bold ? '700' : null, fontStyle: st.italic ? 'italic' : null, textDecoration: deco || null },
    },
    text,
  );
}

// Convierte un texto con § en lineas de spans (maximo 2 lineas, como la lista de servidores).
export function motdNodes(text, baseColor = MC_COLORS[7], maxLines = 2) {
  const lines = String(text ?? '').split('\n').slice(0, maxLines);
  return lines.map((line) => {
    const out = [];
    let st = { color: baseColor };
    let buf = '';
    const flush = () => {
      if (buf) out.push(styledSpan(buf, st));
      buf = '';
    };
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '§' && i + 1 < line.length) {
        const code = line[i + 1].toLowerCase();
        if (MC_COLORS[code] || MC_FORMATS[code] || code === 'r') {
          flush();
          if (MC_COLORS[code]) st = { color: MC_COLORS[code] };
          else if (code === 'r') st = { color: baseColor };
          else st = { ...st, [MC_FORMATS[code]]: true };
          i++;
          continue;
        }
      }
      buf += c;
    }
    flush();
    return h('div', { class: 'sv-motd-line' }, out.length ? out : ' ');
  });
}

// Anima el texto "ofuscado" (§k) mientras el elemento esta en pantalla.
export function animateObfuscated(root) {
  const timer = setInterval(() => {
    if (!root.isConnected) {
      clearInterval(timer);
      return;
    }
    if (reducedMotion() || document.hidden) return;
    root.querySelectorAll('.sv-obf').forEach((el) => {
      const n = Number(el.dataset.len) || el.textContent.length;
      let s = '';
      for (let i = 0; i < n; i++) s += OBF_CHARS[Math.floor(Math.random() * OBF_CHARS.length)];
      el.textContent = s;
    });
  }, 90);
  return () => clearInterval(timer);
}

export function stripCodes(text) {
  return String(text ?? '').replace(/§[0-9a-fk-or]/gi, '');
}
