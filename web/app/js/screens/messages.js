// Lista de conversaciones.
import { avatar, emptyState, h, mount, spinner } from '../dom.js';
import { avatarTone, isOnline, previewText, shortStamp } from '../logic.js';

export function messagesScreen(ctx) {
  const { store, tr, lang, media, config } = ctx;
  const list = h('div', { class: 'section-list' });

  const row = (chat) => {
    const name = store.nameOf(chat.otherId);
    const { presence } = store.presenceOf(chat.otherId);
    const typing = store.isTyping(chat.id);
    const text = typing ? tr('chat_typing_short') : previewText(chat.lastMessage, { me: store.userId, base: config.url, media, tr });
    return h(
      'a',
      { class: `row ${chat.unread ? 'unread' : ''}`, href: `#/messages/${chat.otherId}` },
      h('span', { class: 'avatar-wrap' }, avatar(name, avatarTone(chat.otherId)), isOnline(presence) ? h('span', { class: `dot ${presence}`, 'aria-hidden': 'true' }) : null),
      h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, name), h('span', { class: `row-sub ${typing ? 'playing' : 'muted'}` }, text)),
      h('span', { class: 'row-side' }, h('span', { class: 'row-time muted' }, shortStamp(chat.lastMessage?.at, lang)), chat.unread ? h('span', { class: 'badge' }, String(chat.unread)) : null),
    );
  };

  function draw() {
    if (store.state === 'loading' || store.state === 'idle') return mount(list, spinner(tr('loading')));
    const chats = store.conversations();
    if (!chats.length) {
      return mount(list, emptyState('message', tr('messages_empty'), tr('messages_empty_text'), h('a', { class: 'btn primary', href: '#/friends' }, tr('nav_friends'))));
    }
    mount(list, chats.map(row));
  }

  const offs = [store.on('chats', draw), store.on('state', draw), store.on('typing', draw)];
  draw();
  return { title: tr('nav_messages'), el: h('div', { class: 'screen' }, list), destroy: () => offs.forEach((off) => off()) };
}
