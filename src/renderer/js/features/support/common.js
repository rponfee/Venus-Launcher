// Piezas que comparten el formulario, la conversación y la cola de Soporte: textos, llamadas, etiquetas, campos con
// ayuda y error asociados (para el lector de pantalla), contadores, avisos de estado y preferencias locales.
import { h, icon, registerIcons, fmtAgo } from '../../ui.js';
import { api } from '../../store.js';
import { t, locale } from '../../i18n.js';
import { errorKey, counter, isPending, ALL_CATEGORIES, PRIORITIES, CATEGORY_ICONS } from './logic.js';

registerIcons({
  spLightbulb: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
  spPaperclip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
});

export const S = (key, vars) => t(`support.${key}`, vars);
export const supportCall = (action, payload = {}) => api.invoke('support:call', action, payload);
// Texto de un error del proceso principal, en el idioma de la persona (el mensaje del servidor es solo el respaldo).
export const errMsg = (err) => S(errorKey(err));

let seq = 0;
export const uid = (prefix = 'sp') => `${prefix}-${++seq}`;

export const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' }) : '—');
export const fmtWhen = (iso) => (iso ? fmtAgo(Date.parse(iso)) : '—');
export const shortId = (ticket) => `#${String(ticket?.id || '').slice(0, 8)}`;
export const fmtSize = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

export const categoryLabel = (category) => S(`cat_${ALL_CATEGORIES.includes(category) ? category : 'other'}`);
export const subjectOf = (ticket) => ticket.subject || (ticket.planName ? S('legacyPlanSubject', { plan: ticket.planName }) : S('noSubject'));

export function statusBadge(ticket) {
  const state = ['open', 'in_progress', 'paid', 'closed'].includes(ticket.status) ? ticket.status : 'open';
  return h('span', { class: ['badge', state === 'paid' ? 'good' : isPending(ticket) ? 'warn' : ''] },
    icon(state === 'paid' ? 'check' : isPending(ticket) ? 'clock' : 'x'), S(`status_${state}`));
}
export function priorityBadge(ticket) {
  const p = PRIORITIES.includes(ticket.priority) ? ticket.priority : 'normal';
  return h('span', { class: ['badge', 'sp-prio', `sp-prio-${p}`], title: S('priorityTitle') }, icon(p === 'urgent' || p === 'high' ? 'alert' : 'tag'), S(`prio_${p}`));
}
export const categoryIcon = (category) => icon(CATEGORY_ICONS[category] || 'message');

// Campo con etiqueta, ayuda, contador y error: todo asociado con aria-describedby / aria-invalid para el lector de pantalla.
// setError(texto) muestra o limpia el error (el contenedor lo anuncia con aria-live="polite").
export function field({ label, control, hint, required = false, max = 0, wide = false }) {
  const id = control.id || uid('f');
  control.id = id;
  const labelEl = h('label', { for: id, class: 'sp-label' }, label, required ? h('span', { class: 'sp-req', 'aria-hidden': 'true' }, ' *') : null);
  const hintEl = hint ? h('div', { class: 'sp-hint', id: `${id}-h` }, hint) : null;
  const countEl = max ? h('div', { class: 'sp-count', id: `${id}-c` }) : null;
  const errEl = h('div', { class: 'sp-error', id: `${id}-e`, 'aria-live': 'polite' });
  const root = h('div', { class: ['sp-field', wide && 'wide'] }, labelEl, hintEl, control, h('div', { class: 'sp-field-foot' }, errEl, countEl));
  control.setAttribute('aria-describedby', [hintEl && hintEl.id, countEl && countEl.id, errEl.id].filter(Boolean).join(' '));
  if (required) control.setAttribute('aria-required', 'true');
  const paint = () => {
    if (!countEl) return;
    const c = counter(control.value, max);
    countEl.textContent = S('chars', { used: c.used, max });
    countEl.dataset.level = c.level;
  };
  if (max) { control.addEventListener('input', paint); paint(); }
  function setError(message) {
    errEl.textContent = message || '';
    if (message) control.setAttribute('aria-invalid', 'true'); else control.removeAttribute('aria-invalid');
    root.classList.toggle('invalid', Boolean(message));
  }
  return { el: root, control, setError, repaint: paint };
}

// Preferencias de este equipo (no viajan a ningún lado). Todo con try/catch: sin almacenamiento la pantalla anda igual.
export const prefs = {
  get(key, fallback = null) { try { const v = localStorage.getItem(key); return v === null ? fallback : v; } catch { return fallback; } },
  set(key, value) { try { if (value === null || value === '') localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* sin almacenamiento */ } },
};

// Las acciones que cambian algo se esperan una a una: evita que un doble clic mande dos veces lo mismo.
export function once(fn) {
  let running = false;
  return async (...args) => {
    if (running) return undefined;
    running = true;
    try { return await fn(...args); } finally { running = false; }
  };
}

// Atajo Ctrl/Cmd + Enter en un campo de texto.
export function onCtrlEnter(control, run) {
  control.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); run(); }
  });
}
