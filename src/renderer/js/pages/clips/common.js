// Piezas comunes de la pagina de Clips: iconos propios, textos de atajos y ayudantes.
import { h, icon, registerIcons } from '../../ui.js';
import { t } from '../../i18n.js';

registerIcons({
  clScissors: '<circle cx="6" cy="6" r="3"/><path d="M8.12 8.12 12 12"/><path d="M20 4 8.12 15.88"/><circle cx="6" cy="18" r="3"/><path d="M14.8 14.8 20 20"/>',
  clRec: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/>',
  clPhone: '<rect width="12" height="20" x="6" y="2" rx="2"/><path d="M11 18h2"/>',
  clVideo: '<path d="m16 13 5.2 3.5a.5.5 0 0 0 .8-.4V7.9a.5.5 0 0 0-.8-.4L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
});

export const TAB_ICON = { screenshots: 'camera', clips: 'woFilm', recordings: 'clVideo' };

export const isMissingHandler = (err) => /No handler registered/i.test(String(err?.message || err || ''));

// Atajo para mostrar ("Alt+Shift+F8" -> teclas sueltas en .kbd)
export function kbd(accel) {
  if (!accel) return h('span', { class: 'cl-kbd-none' }, t('clips.noShortcut'));
  return h(
    'span',
    { class: 'cl-kbd', title: accel },
    accel.split('+').map((k) => h('span', { class: 'kbd' }, k)),
  );
}

// Boton de icono con title y aria-label
export function iconBtn(name, label, onclick, extra = '') {
  return h('button', { class: ['icon-btn sm', extra], type: 'button', title: label, 'aria-label': label, onclick }, icon(name));
}

// "2:05" a partir de segundos
export function clock(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}
