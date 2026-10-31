// Utilidades compartidas por las tarjetas del modo desarrollador.
import { h, icon, registerIcons, fmtBytes, switchEl, fail } from '../../ui.js';
import { api } from '../../store.js';
import { t, locale } from '../../i18n.js';

registerIcons({
  dmFlask: '<path d="M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2"/><path d="M8.5 2h7"/><path d="M7 16h10"/>',
  dmBranch: '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  dmCycle: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
});

export const TYPE_META = {
  paper: { name: 'Paper', color: '#e8e2da', letter: 'P' },
  purpur: { name: 'Purpur', color: '#c77dff', letter: 'P' },
  folia: { name: 'Folia', color: '#4cbf7a', letter: 'F' },
  spigot: { name: 'Spigot', color: '#f0932b', letter: 'S' },
  mohist: { name: 'Mohist', color: '#4f9cf0', letter: 'M' },
  youer: { name: 'Youer', color: '#36c2b4', letter: 'Y' },
};

export function typeMeta(type) {
  return TYPE_META[type] || { name: String(type || '?'), color: '#999999', letter: String(type || '?').charAt(0).toUpperCase() };
}

export function typeBadge(type, extra) {
  const m = typeMeta(type);
  return h('span', { class: 'badge loader-badge', style: { '--c': m.color } }, h('span', { class: 'ld' }), m.name, extra ? h('span', { class: 'muted ld-ver' }, extra) : null);
}

export function tile(letter, color, cls = '') {
  return h('div', { class: ['dm-tile', cls], style: { '--c': color }, 'aria-hidden': 'true' }, letter);
}

export function statePill(state, extra) {
  const cls = state === 'online' ? 'good' : state === 'starting' || state === 'stopping' ? 'warn' : '';
  return h('span', { class: ['pill', cls, 'dm-state'] }, h('span', { class: ['status-dot', state] }), t(`devmode.state_${state || 'offline'}`), extra ? h('span', { class: 'dm-state-extra' }, extra) : null);
}

let nf1 = null;
function numFmt() {
  const loc = locale();
  if (!nf1 || nf1.loc !== loc) nf1 = { loc, fmt: new Intl.NumberFormat(loc, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) };
  return nf1.fmt;
}

// Duracion corta: "8,4 s", "1:05 min"
export function fmtSecs(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (n < 1000) return t('devmode.millis', { ms: Math.round(n) });
  const s = n / 1000;
  if (s < 60) return t('devmode.secs', { s: numFmt().format(s) });
  const m = Math.floor(s / 60);
  return t('devmode.mins', { m, s: String(Math.floor(s % 60)).padStart(2, '0') });
}

// Reloj "mm:ss" para lo que esta corriendo
export function fmtClock(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// Error de una accion que corre como tarea: el panel de tareas ya lo muestra, asi que solo se avisa
// si no hay una tarea fallida con el mismo mensaje (por ejemplo, si fallo antes de empezar la tarea).
export function failUnlessTask(store, title, err) {
  const msg = err?.message || String(err);
  for (const task of store.tasks.values()) if (task.state === 'error' && task.detail === msg) return;
  fail(title, err);
}

// Llama a un canal y devuelve fallback si todavia no existe (modulos en construccion).
export async function tryInvoke(channel, args = [], fallback = null) {
  try {
    return await api.invoke(channel, ...args);
  } catch (err) {
    if (/No handler registered/i.test(err.message)) return fallback;
    throw err;
  }
}

export const EVENT_ICONS = { build: 'hammer', deploy: 'package', reload: 'dmCycle', server: 'server', client: 'gamepad', watch: 'eye', plugman: 'zap', project: 'folder', info: 'info' };

// Texto de una entrada del registro (las variables llegan crudas del proceso principal).
export function eventText(e) {
  const vars = { ...(e.vars || {}) };
  if (vars.ms !== undefined) vars.duration = fmtSecs(vars.ms);
  if (vars.bytes !== undefined) vars.size = fmtBytes(vars.bytes);
  if (vars.mode !== undefined) vars.modeLabel = t(`devmode.reload_${vars.mode}`);
  let key = e.key;
  if (key === 'ev_buildAuto' && Number(vars.count) > 0) key = 'ev_buildAutoMany';
  if (key === 'ev_buildFail' && !vars.error) key = 'ev_buildFailNoMsg';
  if (key === 'ev_deployOffline' && !vars.version) key = 'ev_deployOfflineNoVersion';
  if (key === 'ev_restartDone' && !vars.version) key = 'ev_restartDoneNoVersion';
  return t(`devmode.${key}`, vars);
}

// Fila con interruptor (titulo + explicacion)
export function toggleRow(title, sub, checked, onChange, { disabled = false } = {}) {
  const sw = switchEl(checked, onChange, title);
  if (disabled) sw.querySelector('input').disabled = true;
  return h('div', { class: ['toggle-row', 'dm-toggle', disabled && 'is-disabled'] }, h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, title), sub ? h('div', { class: 'tr-sub' }, sub) : null), sw);
}

export function iconBtn(name, label, onclick, cls = '') {
  return h('button', { class: ['icon-btn', 'sm', cls], type: 'button', title: label, 'aria-label': label, onclick }, icon(name));
}

// Una entrada de "dato: valor" en las tarjetas
export function fact(label, ...value) {
  return h('div', { class: 'dm-fact' }, h('div', { class: 'dm-fact-label' }, label), h('div', { class: 'dm-fact-value' }, ...value));
}

export function serverTaskFor(store, sid, projectId) {
  for (const task of store.tasks.values()) {
    if (task.state !== 'running') continue;
    if ((sid && task.meta?.serverId === sid) || (projectId && task.meta?.devmode === projectId && task.meta?.serverId)) return task;
  }
  return null;
}

export function taskBar(task) {
  const pct = task.progress === null || task.progress === undefined ? null : Math.round(task.progress * 100);
  return h(
    'div',
    { class: 'dm-taskbar', role: 'status' },
    h('div', { class: 'row small' }, h('div', { class: 'spinner' }), h('span', { class: 'ellipsis spacer', title: task.title }, task.title), pct !== null ? h('span', { class: 'muted num' }, `${pct}%`) : null),
    h('div', { class: ['progress', pct === null && 'indeterminate'] }, h('i', { style: { width: `${pct || 0}%` } })),
    task.detail ? h('div', { class: 'tiny muted ellipsis', title: task.detail }, task.detail) : null,
  );
}

export const ADOPTIUM_URL = 'https://adoptium.net/temurin/releases/?version=21';
export const EULA_URL = 'https://aka.ms/MinecraftEULA';
