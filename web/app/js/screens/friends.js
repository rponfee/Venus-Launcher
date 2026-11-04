// Amigos: quién está en línea y a qué juega (la presencia que publica el launcher), solicitudes y agregar por código.
import { avatar, emptyState, h, icon, mount, spinner, toast } from '../dom.js';
import { activityLine, avatarTone, errorKey, isOnline } from '../logic.js';

export function friendsScreen(ctx) {
  const { store, tr } = ctx;
  const list = h('div', { class: 'stack' });

  // ---------- Agregar ----------
  const input = h('input', { id: 'add-code', class: 'input', placeholder: 'VENUS-XXXXXX', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', maxlength: 32, 'aria-label': tr('friends_add_label') });
  const addBtn = h('button', { class: 'btn primary', type: 'submit' }, icon('userPlus', 20), tr('friends_add'));
  const addResult = h('div', { class: 'small', role: 'status' });
  const addForm = h(
    'form',
    {
      class: 'add-friend',
      novalidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        const q = input.value.trim();
        if (!q) return;
        addBtn.disabled = true;
        addResult.textContent = '';
        addResult.className = 'small';
        try {
          const res = await store.addFriend(q);
          const key = { sent: 'friends_sent', accepted: 'friends_accepted', already_sent: 'friends_already_sent', already_friends: 'friends_already' }[res?.result] || 'friends_sent';
          addResult.textContent = tr(key);
          addResult.className = 'small good-text';
          input.value = '';
        } catch (err) {
          addResult.textContent = tr(errorKey(err));
          addResult.className = 'small bad-text';
        } finally {
          addBtn.disabled = false;
        }
      },
    },
    input,
    addBtn,
  );

  // ---------- Filas ----------
  const act = (run, okKey) => async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await run();
      if (okKey) toast(tr(okKey), 'good');
    } catch (err) {
      toast(tr(errorKey(err)), 'bad');
      btn.disabled = false;
    }
  };

  const incomingRow = (r) =>
    h(
      'div',
      { class: 'row card-row' },
      avatar(r.name, avatarTone(r.id)),
      h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, r.name), h('div', { class: 'row-sub muted' }, tr('friends_wants'))),
      h(
        'div',
        { class: 'row-actions' },
        h('button', { class: 'icon-btn good', type: 'button', 'aria-label': tr('friends_accept_name', { name: r.name }), onclick: act(() => store.respond(r.id, true), 'friends_accepted') }, icon('check')),
        h('button', { class: 'icon-btn bad', type: 'button', 'aria-label': tr('friends_decline_name', { name: r.name }), onclick: act(() => store.respond(r.id, false)) }, icon('x')),
      ),
    );

  const outgoingRow = (r) =>
    h(
      'div',
      { class: 'row card-row' },
      avatar(r.name, avatarTone(r.id)),
      h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, r.name), h('div', { class: 'row-sub muted' }, tr('friends_waiting'))),
      h('div', { class: 'row-actions' }, h('button', { class: 'btn ghost sm', type: 'button', onclick: act(() => store.cancelRequest(r.id)) }, tr('friends_cancel'))),
    );

  const friendRow = (f) => {
    const line = isOnline(f.presence) ? activityLine(f.activity, tr) || f.statusText || tr(`presence_${f.presence}`) : f.statusText || tr('presence_offline');
    const open = async () => {
      try {
        await store.ensureChat(f.id);
        ctx.navigate(`#/messages/${f.id}`);
      } catch (err) {
        toast(tr(errorKey(err)), 'bad');
      }
    };
    return h(
      'button',
      { class: 'row', type: 'button', onclick: open, 'aria-label': `${f.name}. ${tr(`presence_${f.presence}`)}. ${line}` },
      h('span', { class: 'avatar-wrap' }, avatar(f.name, avatarTone(f.id)), h('span', { class: `dot ${f.presence}`, 'aria-hidden': 'true' })),
      h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, f.name), h('span', { class: `row-sub ${f.activity ? 'playing' : 'muted'}` }, f.activity ? icon('gamepad', 14) : null, line)),
      f.unread ? h('span', { class: 'badge' }, String(f.unread)) : null,
    );
  };

  function draw() {
    if (store.state === 'loading' || store.state === 'idle') return mount(list, spinner(tr('loading')));
    if (store.state === 'error') return mount(list, retryBox());
    const { friends, incoming, outgoing } = store;
    const online = friends.filter((f) => isOnline(f.presence));
    const offline = friends.filter((f) => !isOnline(f.presence));
    mount(
      list,
      incoming.length ? section(tr('friends_incoming', { count: incoming.length }), incoming.map(incomingRow)) : null,
      online.length ? section(tr('friends_online', { count: online.length }), online.map(friendRow)) : null,
      offline.length ? section(tr('friends_offline', { count: offline.length }), offline.map(friendRow)) : null,
      outgoing.length ? section(tr('friends_outgoing'), outgoing.map(outgoingRow)) : null,
      !friends.length && !incoming.length && !outgoing.length ? emptyState('users', tr('friends_empty'), tr('friends_empty_text')) : null,
    );
  }

  const retryBox = () => emptyState('alert', tr('err_service'), null, h('button', { class: 'btn primary', type: 'button', onclick: () => store.start() }, icon('refresh', 20), tr('retry')));
  const section = (title, rows) => h('section', { class: 'section' }, h('h2', { class: 'section-title' }, title), h('div', { class: 'section-list' }, rows));

  const offs = [store.on('friends', draw), store.on('state', draw)];
  draw();
  return {
    title: tr('nav_friends'),
    el: h('div', { class: 'screen' }, h('div', { class: 'card add-card' }, addForm, addResult, myCode(ctx, offs)), list),
    destroy: () => offs.forEach((off) => off()),
  };
}

// offs: donde queda la baja del evento, para sacarla al salir de la pantalla
export function myCode({ store, tr }, offs) {
  const code = h('code', { class: 'friend-code' }, store.me?.friend_code || '—');
  offs.push(
    store.on('friends', () => {
      code.textContent = store.me?.friend_code || '—';
    }),
  );
  return h(
    'div',
    { class: 'my-code' },
    h('span', { class: 'muted small' }, tr('friends_my_code')),
    code,
    h(
      'button',
      {
        class: 'icon-btn',
        type: 'button',
        'aria-label': tr('copy_code'),
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(store.me?.friend_code || '');
            toast(tr('code_copied'), 'good');
          } catch {
            toast(tr('copy_failed'), 'bad');
          }
        },
      },
      icon('copy', 20),
    ),
  );
}
