// Tu cuenta: código de amigo, instalar la app y salir (salir borra todo lo que hay en el celular).
import { avatar, confirmBox, h, icon } from '../dom.js';
import { avatarTone, displayName, isIos } from '../logic.js';
import { myCode } from './friends.js';

export function accountScreen(ctx) {
  const { store, tr, install } = ctx;
  const offs = [];
  const me = store.me;
  const name = displayName(me) || tr('someone');

  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  let installBox = null;
  if (!standalone) {
    if (isIos(navigator.userAgent, navigator.platform, navigator.maxTouchPoints)) {
      installBox = h('div', { class: 'card' }, h('strong', {}, tr('install_title')), h('p', { class: 'muted' }, tr('install_ios')));
    } else if (install.available()) {
      installBox = h('div', { class: 'card' }, h('strong', {}, tr('install_title')), h('p', { class: 'muted' }, tr('install_text')), h('button', { class: 'btn primary wide', type: 'button', onclick: () => install.prompt() }, icon('download', 20), tr('install_button')));
    } else {
      installBox = h('div', { class: 'card' }, h('strong', {}, tr('install_title')), h('p', { class: 'muted' }, tr('install_menu')));
    }
  }

  const leave = async (e) => {
    const go = await confirmBox({ title: tr('signout_title'), text: tr('signout_text'), ok: tr('signout'), cancel: tr('cancel'), danger: true });
    if (!go) return;
    e.target.disabled = true;
    ctx.signOut();
  };

  return {
    title: tr('account_title'),
    back: '#/friends',
    el: h(
      'div',
      { class: 'screen' },
      h(
        'div',
        { class: 'card profile-card' },
        avatar(name, avatarTone(me?.id), 'big'),
        h('div', { class: 'row-main' }, h('div', { class: 'profile-name' }, name), me?.username ? h('div', { class: 'muted small' }, `@${me.username}`) : null),
      ),
      h('div', { class: 'card' }, myCode(ctx, offs)),
      installBox,
      h('div', { class: 'card' }, h('p', { class: 'muted small' }, tr('account_presence_note'))),
      h('button', { class: 'btn danger-ghost wide', type: 'button', onclick: leave }, icon('logout', 20), tr('signout')),
    ),
    destroy: () => offs.forEach((off) => off()),
  };
}
