// Avisos: la bandeja dentro de la app y el botón para recibirlos con la app cerrada.
import { avatar, emptyState, h, icon, mount, notice, spinner, toast } from '../dom.js';
import { avatarTone, errorKey, shortStamp } from '../logic.js';

export function inboxScreen(ctx) {
  const { store, tr, lang, push } = ctx;
  const pushBox = h('div', { class: 'card push-card' }, spinner());
  const list = h('div', { class: 'section-list' });
  let destroyed = false;

  // ---------- Avisos con la app cerrada ----------
  async function drawPush() {
    if (destroyed) return;
    let st;
    try {
      st = await push.status();
    } catch {
      st = { support: 'unsupported' };
    }
    if (destroyed) return;
    const title = h('div', { class: 'push-title' }, icon('bell', 20), h('strong', {}, tr('push_card_title')));
    if (st.support === 'ios_install') return mount(pushBox, title, h('p', { class: 'muted' }, tr('push_ios_install')));
    if (st.support === 'ios_old') return mount(pushBox, title, h('p', { class: 'muted' }, tr('push_ios_old')));
    if (st.support !== 'ok') return mount(pushBox, title, h('p', { class: 'muted' }, tr('push_unsupported')));
    if (st.permission === 'denied') return mount(pushBox, title, h('p', { class: 'muted' }, tr('push_denied_text')));
    const onTap = (run, okKey) => async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        await run();
        if (okKey) toast(tr(okKey), 'good');
      } catch (err) {
        console.warn('[app] avisos', err?.code || err?.message);
        const key = err?.code === 'push_denied' ? 'push_denied_text' : err?.code === 'push_unavailable' || err?.code === 'PGRST202' ? 'push_not_ready' : errorKey(err);
        toast(tr(key), 'bad');
      }
      drawPush();
    };
    if (!st.enabled) {
      return mount(
        pushBox,
        title,
        h('p', { class: 'muted' }, tr('push_explain')),
        h('button', { class: 'btn primary wide', type: 'button', onclick: onTap(() => push.enable(), 'push_on') }, tr('push_enable')),
      );
    }
    const preview = h('input', { type: 'checkbox', id: 'push-preview', checked: await push.previewEnabled().catch(() => true) });
    preview.addEventListener('change', () => push.setPreview(preview.checked).catch(() => {}));
    mount(
      pushBox,
      title,
      h('p', { class: 'good-text small' }, tr('push_is_on')),
      h('label', { class: 'switch-row', for: 'push-preview' }, h('span', {}, tr('push_preview')), preview),
      h('button', { class: 'btn ghost wide', type: 'button', onclick: onTap(() => push.disable(), 'push_off') }, tr('push_disable')),
    );
  }

  // ---------- Bandeja ----------
  function draw() {
    if (store.state === 'loading' || store.state === 'idle') return mount(list, spinner(tr('loading')));
    const { messages, requests, clips } = store.inbox;
    const items = [
      ...messages.map((m) => ({
        at: m.at,
        el: h(
          'a',
          { class: 'row unread', href: `#/messages/${m.userId}` },
          avatar(m.name || tr('someone'), avatarTone(m.userId)),
          h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, m.name || tr('someone')), h('span', { class: 'row-sub muted' }, Number(m.unread) > 1 ? tr('push_messages', { count: m.unread }) : tr('push_message'))),
          h('span', { class: 'row-side' }, h('span', { class: 'row-time muted' }, shortStamp(m.at, lang)), h('span', { class: 'badge' }, String(m.unread))),
        ),
      })),
      ...requests.map((r) => ({
        at: r.at,
        el: h(
          'a',
          { class: 'row unread', href: '#/friends' },
          avatar(r.name || tr('someone'), avatarTone(r.userId)),
          h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, r.name || tr('someone')), h('span', { class: 'row-sub muted' }, tr('push_request'))),
          h('span', { class: 'row-side' }, h('span', { class: 'row-time muted' }, shortStamp(r.at, lang))),
        ),
      })),
      ...clips.map((c) => ({
        at: c.at,
        el: h(
          'a',
          { class: 'row unread', href: '#/clips/received' },
          avatar(c.from || tr('someone'), avatarTone(c.userId)),
          h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, c.from || tr('someone')), h('span', { class: 'row-sub muted' }, `${tr(c.kind === 'clip' ? 'push_clip' : 'push_shot')}: ${c.name}`)),
          h('span', { class: 'row-side' }, h('span', { class: 'row-time muted' }, shortStamp(c.at, lang))),
        ),
      })),
    ].sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
    if (!items.length) return mount(list, emptyState('bell', tr('inbox_empty'), tr('inbox_empty_text')));
    mount(list, items.map((i) => i.el));
  }

  const offs = [store.on('inbox', draw), store.on('friends', draw), store.on('state', draw)];
  draw();
  drawPush();
  store.refreshInbox();
  return {
    title: tr('nav_inbox'),
    el: h('div', { class: 'screen' }, pushBox, store.inboxAvailable ? null : notice('info', tr('inbox_partial')), list),
    destroy: () => {
      destroyed = true;
      offs.forEach((off) => off());
    },
  };
}
