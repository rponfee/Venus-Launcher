// Una conversación. Los mensajes no van cifrados en el launcher (texto plano con RLS): acá es igual. GIF y sticker son mensajes
// cuyo cuerpo es solo una dirección; se dibujan como imagen solo si la dirección pasa la validación de shared/media.js.
import { avatar, emptyState, h, icon, mount, notice, spinner, toast } from '../dom.js';
import { MAX_MESSAGE, activityLine, avatarTone, dateLabel, dayKey, errorKey, isOnline, splitLinks, timeLabel } from '../logic.js';

const SHOW_COUNTER_AT = MAX_MESSAGE - 200;

export function chatScreen(ctx, route) {
  const { store, tr, lang, media, config } = ctx;
  const userId = route.userId;
  let chatId = store.chatIdFor(userId);
  let destroyed = false;
  const cache = new Map(); // id -> { key, el }

  const name = () => store.nameOf(userId);
  const subtitle = h('div', { class: 'chat-sub muted small' });
  const titleEl = h('div', { class: 'chat-name' }, name());
  const avatarBox = h('span', { class: 'avatar-wrap' });
  const header = h(
    'header',
    { class: 'chat-head' },
    h('a', { class: 'icon-btn', href: '#/messages', 'aria-label': tr('back') }, icon('back')),
    avatarBox,
    h('div', { class: 'chat-who' }, titleEl, subtitle),
  );
  const scroller = h('div', { class: 'chat-scroll', role: 'log', 'aria-live': 'polite', 'aria-label': tr('chat_log') });
  const olderBtn = h('button', { class: 'btn ghost sm chat-older', type: 'button', hidden: true, onclick: loadOlder }, tr('chat_older'));
  const listEl = h('div', { class: 'chat-list' });
  const typingEl = h('div', { class: 'chat-typing small muted', hidden: true }, h('span', { class: 'typing-dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), h('span', {}, tr('chat_typing', { name: name() })));
  scroller.append(olderBtn, listEl, typingEl);

  // ---------- Escribir ----------
  const input = h('textarea', { class: 'input chat-input', rows: 1, maxlength: MAX_MESSAGE, 'aria-label': tr('chat_placeholder'), placeholder: tr('chat_placeholder'), oninput: onInput, enterkeyhint: 'enter' });
  const counter = h('span', { class: 'chat-counter small muted', hidden: true });
  const sendBtn = h('button', { class: 'btn primary send-btn', type: 'submit', 'aria-label': tr('chat_send'), disabled: true }, icon('send', 20));
  const lockNote = h('div', { class: 'chat-lock small muted', hidden: true });
  const composer = h(
    'form',
    {
      class: 'chat-compose',
      novalidate: true,
      onsubmit: (e) => {
        e.preventDefault();
        submit();
      },
    },
    lockNote,
    h('div', { class: 'chat-compose-row' }, h('div', { class: 'chat-input-wrap' }, input, counter), sendBtn),
  );

  function onInput() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
    const len = input.value.length;
    sendBtn.disabled = !input.value.trim() || locked();
    counter.hidden = len < SHOW_COUNTER_AT;
    counter.textContent = `${len}/${MAX_MESSAGE}`;
    if (chatId && input.value.trim()) store.sendTyping(chatId);
  }

  function locked() {
    return store.moderation?.banned || store.moderation?.muted || (store.state === 'ready' && !store.isFriend(userId));
  }

  function applyLock() {
    const m = store.moderation;
    const reason = m?.banned ? tr('err_user_banned') : m?.muted ? tr('err_user_muted') : store.state === 'ready' && !store.isFriend(userId) ? tr('chat_not_friends') : '';
    lockNote.textContent = reason;
    lockNote.hidden = !reason;
    input.disabled = Boolean(reason);
    sendBtn.disabled = Boolean(reason) || !input.value.trim();
  }

  async function submit() {
    if (locked() || !input.value.trim()) return;
    try {
      if (!chatId) chatId = await store.ensureChat(userId);
      if (!store.chat(chatId)?.loaded) await store.loadMessages(chatId);
      store.send(chatId, input.value);
      input.value = '';
      onInput();
      draw(true);
      input.focus();
    } catch (err) {
      toast(err?.message === 'too_long' ? tr('chat_too_long', { max: MAX_MESSAGE }) : tr(errorKey(err)), 'bad');
    }
  }

  // ---------- Mensajes ----------
  function bodyNodes(text) {
    return splitLinks(text).map((part) => (part.url ? h('a', { class: 'msg-link', href: part.url, target: '_blank', rel: 'noopener noreferrer nofollow' }, part.url) : part.text));
  }

  function gifEl(url, fallback) {
    const box = h('span', { class: 'msg-media' });
    const img = h('img', { src: url, alt: tr('preview_gif'), loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', class: 'msg-gif' });
    img.addEventListener('error', () => mount(box, h('span', { class: 'msg-text' }, bodyNodes(fallback))));
    box.append(img);
    return box;
  }

  // Si el servidor no tiene stickers (sin 0030) queda el texto; si el sticker se borró, un aviso.
  function stickerEl(sticker, body) {
    const box = h('span', { class: 'msg-media msg-sticker-box' }, h('span', { class: 'msg-sticker-wait', 'aria-hidden': 'true' }));
    store.stickerStatus(sticker.id).then((status) => {
      if (destroyed) return;
      if (status === undefined) return mount(box, h('span', { class: 'msg-text' }, bodyNodes(body)));
      if (status === false) return mount(box, h('span', { class: 'msg-gone small muted' }, tr('chat_sticker_gone')));
      const img = h('img', { src: sticker.url, alt: tr('preview_sticker'), loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', class: 'msg-sticker' });
      img.addEventListener('error', () => mount(box, h('span', { class: 'msg-gone small muted' }, tr('chat_sticker_gone'))));
      mount(box, img);
    });
    return box;
  }

  function messageEl(m, read) {
    const mine = m.sender_id === store.userId;
    const time = timeLabel(m.created_at, lang);
    const sticker = m.deleted ? null : media.stickerOf(m.body, m.sender_id, config.url);
    const gif = m.deleted || sticker ? null : media.gifOf(m.body);
    let status = null;
    if (m._local === 'pending') status = h('span', { class: 'msg-status' }, tr('chat_sending'));
    else if (m._local === 'failed') status = h('span', { class: 'msg-status bad-text' }, m._error ? tr(errorKey(m._error)) : tr('chat_failed'));
    else if (mine && read) status = h('span', { class: 'msg-status read', title: tr('chat_read') }, icon('check', 14), h('span', { class: 'sr' }, tr('chat_read')));
    const meta = h('span', { class: 'msg-meta' }, m.edited_at && !m.deleted ? `${tr('chat_edited')} · ` : null, time, status);
    let content;
    if (m.deleted) content = h('span', { class: 'msg-gone' }, tr('msg_deleted'));
    else if (sticker) content = stickerEl(sticker, m.body);
    else if (gif) content = gifEl(gif, m.body);
    else content = h('span', { class: 'msg-text' }, bodyNodes(m.body));
    const failed = m._local === 'failed';
    return h(
      'div',
      { class: `msg ${mine ? 'mine' : 'theirs'} ${sticker || gif ? 'is-media' : ''} ${failed ? 'failed' : ''}` },
      h('div', { class: 'msg-bubble' }, content, meta),
      failed
        ? h(
            'div',
            { class: 'msg-retry' },
            h('button', { class: 'btn ghost sm', type: 'button', onclick: () => store.retry(m.id) }, tr('retry')),
            h('button', { class: 'btn ghost sm', type: 'button', onclick: () => store.discard(chatId, m.id) }, tr('chat_discard')),
          )
        : null,
    );
  }

  function draw(stick = false) {
    if (destroyed) return;
    const chat = chatId ? store.chat(chatId) : null;
    const prevHeight = scroller.scrollHeight;
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
    const nodes = [];
    let day = null;
    for (const m of chat?.messages || []) {
      const k = dayKey(m.created_at);
      if (k !== day) {
        day = k;
        nodes.push(h('div', { class: 'chat-day' }, h('span', {}, dateLabel(m.created_at, lang))));
      }
      const read = store.isRead(chatId, m);
      const key = `${m.body}|${m.deleted}|${m._local || ''}|${m.edited_at || ''}|${read}`;
      let item = cache.get(m.id);
      if (!item || item.key !== key) {
        item = { key, el: messageEl(m, read) };
        cache.set(m.id, item);
      }
      nodes.push(item.el);
    }
    if (nodes.length) mount(listEl, nodes);
    else if (!chat || chat.loaded) mount(listEl, emptyState('message', tr('chat_empty', { name: name() }), null));
    olderBtn.hidden = !chat?.loaded || !chat.hasMore;
    typingEl.hidden = !chatId || !store.isTyping(chatId);
    if (stick === 'older') scroller.scrollTop += scroller.scrollHeight - prevHeight;
    else if (stick || atBottom) scroller.scrollTop = scroller.scrollHeight;
  }

  async function loadOlder() {
    olderBtn.disabled = true;
    try {
      if (chatId) await store.loadOlder(chatId);
    } catch (err) {
      toast(tr(errorKey(err)), 'bad');
    } finally {
      olderBtn.disabled = false;
    }
  }

  function drawHead() {
    titleEl.textContent = name();
    const { presence, activity } = store.presenceOf(userId);
    mount(avatarBox, avatar(name(), avatarTone(userId)), isOnline(presence) ? h('span', { class: `dot ${presence}`, 'aria-hidden': 'true' }) : null);
    subtitle.textContent = isOnline(presence) ? activityLine(activity, tr) || tr(`presence_${presence}`) : tr('presence_offline');
    applyLock();
  }

  async function open() {
    drawHead();
    store.setActive(userId);
    if (store.state !== 'ready') return mount(listEl, spinner(tr('loading')));
    if (!chatId && store.isFriend(userId)) {
      try {
        chatId = await store.ensureChat(userId);
      } catch (err) {
        return mount(listEl, notice('bad', tr(errorKey(err))));
      }
    }
    if (destroyed) return;
    if (!chatId) return mount(listEl, emptyState('message', tr('chat_not_friends'), null));
    store.setActive(userId);
    mount(listEl, spinner(tr('loading')));
    try {
      await store.loadMessages(chatId);
      if (destroyed) return;
      draw(true);
    } catch (err) {
      mount(listEl, notice('bad', tr(errorKey(err)), h('button', { class: 'btn ghost sm', type: 'button', onclick: open }, tr('retry'))));
    }
  }

  const offs = [
    store.on('chat', (e) => {
      if (e.chatId !== chatId) return;
      if (e.kind === 'older') draw('older');
      else if (e.kind !== 'loaded' || store.chat(chatId)?.loaded) draw(e.kind === 'loaded');
    }),
    store.on('typing', (e) => {
      if (e.chatId === chatId) draw();
    }),
    store.on('friends', drawHead),
    store.on('moderation', applyLock),
    store.on('state', (state) => {
      if (state === 'ready' && !store.chat(chatId)?.loaded) open();
    }),
  ];

  open();

  return {
    fullscreen: true,
    title: name(),
    el: h('div', { class: 'chat' }, header, scroller, composer),
    destroy: () => {
      destroyed = true;
      store.setActive(null);
      offs.forEach((off) => off());
    },
  };
}
