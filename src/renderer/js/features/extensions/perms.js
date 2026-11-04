// Permisos explicados en lenguaje claro: el resumen al instalar y la lista de la pantalla de Extensiones.
import { h, icon } from '../../ui.js';
import { t } from '../../i18n.js';

const ICONS = { storage: 'drive', notify: 'bell', 'read.instances': 'layers', 'read.gameState': 'gamepad', 'action.openPage': 'link', 'action.launchInstance': 'play' };

const slug = (perm) => perm.replace(/\./g, '_');
export const permTitle = (perm) => t(`extensions.perm_${slug(perm)}`);
export const permText = (perm) => t(`extensions.perm_${slug(perm)}_text`);

export function permRow(perm, { isNew = false } = {}) {
  return h(
    'div',
    { class: ['xt-perm', isNew && 'new'] },
    h('span', { class: 'xt-perm-icon', 'aria-hidden': 'true' }, icon(ICONS[perm] || 'shield')),
    h('div', { class: 'xt-perm-text' }, h('div', { class: 'xt-perm-title' }, permTitle(perm), isNew ? h('span', { class: 'pill warn xt-perm-new' }, t('extensions.permNew')) : null), h('div', { class: 'small muted' }, permText(perm))),
  );
}

// Lo que ninguna extensión puede hacer: va siempre en el resumen, tenga o no permisos.
export function neverBlock() {
  return h('p', { class: 'small muted xt-never' }, icon('shieldCheck'), t('extensions.neverText'));
}
