// Aviso cuando el equipo de Venus contesta una consulta. Es una conexión que el launcher hace por su cuenta, así que tiene
// su propio interruptor (se activa al enviar una consulta o desde la página de Soporte) y solo corre con el launcher
// abierto, la ventana visible y la sesión iniciada: cada 3 minutos pregunta cuántas respuestas hay sin leer (una sola
// función liviana del servidor). Pone el número en el menú y avisa una vez por respuesta nueva.
import { cloud } from '../../cloud.js';
import { loadNs } from '../../i18n.js';
import { navigate, setNavBadge } from '../../app.js';
import { S, supportCall, prefs } from './common.js';

const KEY = 'venus.support.notify';
const EVERY_MS = 3 * 60000;
let timer = null;
let started = false;
let announced = new Set(); // respuestas que ya avisamos (id + hora)
let first = true;

export function isNotifyEnabled(whenUnset = false) {
  const v = prefs.get(KEY);
  return v === null ? whenUnset : v === '1';
}

export function setNotifyEnabled(on) {
  prefs.set(KEY, on ? '1' : '0');
  if (on) { schedule(); poll(); } else { stop(); setNavBadge('support', 0); }
}

// La página de Soporte conoce el número exacto de respuestas sin leer: actualiza el menú si el aviso está activo.
export function reportUnread(count) {
  if (isNotifyEnabled()) setNavBadge('support', count);
}

function stop() {
  clearInterval(timer);
  timer = null;
}
function schedule() {
  if (timer || !isNotifyEnabled()) return;
  timer = setInterval(() => { if (!document.hidden) poll(); }, EVERY_MS);
}

async function poll() {
  if (!isNotifyEnabled() || !cloud.isSignedIn()) return;
  try {
    await loadNs('support');
    const summary = await supportCall('unread');
    setNavBadge('support', Number(summary?.unread) || 0);
    const fresh = (summary?.latest || []).filter((x) => !announced.has(`${x.id}|${x.at}`));
    for (const x of summary?.latest || []) announced.add(`${x.id}|${x.at}`);
    // La primera consulta después de abrir el launcher solo pone el número: no avisa por respuestas que ya estaban.
    if (first) { first = false; return; }
    if (fresh.length) {
      const { actionToast } = await import('../party/toasts.js');
      actionToast({
        kind: 'info', icon: 'message', key: 'support-reply', title: S('toastTitle', { count: fresh.length }),
        msg: fresh.length === 1 ? fresh[0].subject : S('toastMany', { count: fresh.length }),
        actions: [{ label: S('toastOpen'), primary: true, run: () => navigate(`support/${fresh[0].id}`) }],
      });
    }
  } catch { /* sin red o sin sesión: se reintenta en el próximo ciclo */ }
}

export async function startup() {
  if (started) return;
  started = true;
  await cloud.ready();
  cloud.on('auth', () => { announced = new Set(); first = true; setNavBadge('support', 0); stop(); if (cloud.isSignedIn()) { schedule(); poll(); } });
  if (cloud.isSignedIn()) { schedule(); setTimeout(poll, 20000); }
}
