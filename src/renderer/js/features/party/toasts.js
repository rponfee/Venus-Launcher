// Avisos con botones (Aceptar/Rechazar, Unirme) en la pila de toasts del launcher y alertas al overlay del juego.
// Los usan features/party.js y features/notify.js. Estilos en styles/features/notify.css (prefijo nt-).
import { h, icon, ensureCss, reducedMotion, setBusy } from '../../ui.js';
import { api } from '../../store.js';
import { t } from '../../i18n.js';

const EXIT_MS = 180;
const MAX_LIVE = 4;
const live = [];

// actionToast({ kind: 'info'|'good'|'bad', icon, title, msg, actions: [{ label, icon, primary, run, ariaLabel }],
//               ms, key, onTimeout }) -> { close }
// - key: un aviso nuevo con la misma clave reemplaza al anterior (por ejemplo, la invitación de un mismo amigo)
// - run() puede ser asíncrona: el botón queda ocupado; si devuelve false el aviso queda abierto
// - nunca roba el foco; pasar el mouse o enfocar adentro pausa el cierre
export function actionToast({ kind = 'info', icon: iconName, title, msg, actions = [], ms = 9000, key, onTimeout } = {}) {
  ensureCss('features/notify');
  const host = document.getElementById('toasts');
  if (!host) return { close() {} };
  if (key) live.filter((x) => x.key === key).forEach((x) => x.close(false));
  let timer = null;
  let closed = false;
  const close = (byTimeout = false) => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    const i = live.indexOf(entry);
    if (i >= 0) live.splice(i, 1);
    if (byTimeout) onTimeout?.();
    if (!el.isConnected) return;
    if (reducedMotion()) {
      el.remove();
      return;
    }
    el.classList.add('leaving');
    setTimeout(() => el.remove(), EXIT_MS);
  };
  const buttons = actions.map((a) => {
    const btn = h('button', { class: ['btn sm', a.primary ? 'tonal' : 'ghost', 'nt-toast-btn'], type: 'button', 'aria-label': a.ariaLabel || null }, a.icon ? icon(a.icon) : null, a.label);
    btn.addEventListener('click', async () => {
      const done = setBusy(btn);
      let keep = false;
      try {
        keep = (await a.run?.()) === false;
      } catch (err) {
        console.warn('[notify] acción', err);
      } finally {
        done();
      }
      if (!keep) close(false);
    });
    return btn;
  });
  const el = h(
    'div',
    { class: ['toast', kind, 'nt-toast'], role: kind === 'bad' ? 'alert' : 'status' },
    icon(iconName || (kind === 'good' ? 'check' : kind === 'bad' ? 'alert' : 'info')),
    h('div', { class: 'nt-toast-body' }, h('div', { class: 't-title' }, title), msg ? h('div', { class: 't-msg' }, msg) : null, buttons.length ? h('div', { class: 'nt-toast-actions' }, buttons) : null),
    h('button', { class: 'icon-btn sm nt-toast-x', type: 'button', title: closeLabel(), 'aria-label': closeLabel(), onclick: () => close(false) }, icon('x')),
  );
  const arm = (delay) => {
    clearTimeout(timer);
    if (delay > 0) timer = setTimeout(() => close(true), delay);
  };
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', () => arm(Math.min(ms, 4000)));
  el.addEventListener('focusin', () => clearTimeout(timer));
  const entry = { key, close, el };
  host.append(el);
  live.push(entry);
  while (live.length > MAX_LIVE) live[0].close(false);
  arm(ms);
  return { close: () => close(false) };
}

const closeLabel = () => t('common.close');

// Alerta al overlay del juego (contrato 1 de la 2.0: lo registra el módulo overlay). Si el overlay no está,
// no pasa nada.
export async function pushOverlay(event) {
  try {
    await api.invoke('overlay:push', event);
    return true;
  } catch {
    return false;
  }
}

// ¿Hay alguna partida abierta? (los avisos se silencian mientras se juega, salvo en el overlay)
export function isPlaying(running) {
  return Object.values(running || {}).some((r) => r?.state === 'running' && !r.quiet);
}
