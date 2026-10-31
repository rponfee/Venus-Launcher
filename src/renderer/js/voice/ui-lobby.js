// Lobby del Voice Chat: crear una sala, entrar con codigo, salas de amigos, mis salas y recientes.
import { h, icon, mount, fail, ok, confirmDialog, copyText, selectEl, fmtAgo, sectionTitle, debounce, skeleton, setBusy } from '../ui.js';
import { t } from '../i18n.js';
import { navigate } from '../app.js';
import { voice, normalizeCode, MAX_MEMBERS } from '../voice.js';
import { personAvatar, errorBox, segmented, passwordField, fieldError, fieldId, joinWithPassword, maxOptions, openRoomEditor } from './ui-common.js';

const REFRESH_MS = 20000;

export function lobbyView(container, { initialCode } = {}) {
  let disposed = false;
  let loading = false;
  const create = createCard();
  const join = joinCard(initialCode);
  const friendsBox = h('div', { class: 'vc-rooms' }, roomsSkeleton(2));
  const mineBox = h('div', { class: 'vc-rooms' }, roomsSkeleton(2));
  const recentBox = h('div', { class: 'vc-rooms' });
  const recentSection = h('div', { class: 'vc-section', hidden: true }, sectionTitle(t('voice.recentRooms')), recentBox);
  const setupBox = h('div', { class: 'vc-setup-box' });
  const refreshBtn = h('button', { class: 'icon-btn sm', title: t('voice.refresh'), 'aria-label': t('voice.refresh') }, icon('refresh'));
  refreshBtn.addEventListener('click', () => load(false));

  mount(
    container,
    h(
      'div',
      { class: 'vc-lobby' },
      setupBox,
      h('div', { class: 'vc-lobby-top' }, create.el, join.el),
      h('div', { class: 'vc-section' }, sectionTitle(t('voice.friendsRooms'), refreshBtn), friendsBox),
      h('div', { class: 'vc-section' }, sectionTitle(t('voice.myRooms')), mineBox),
      recentSection,
    ),
  );

  async function load(quiet = true) {
    if (loading || disposed) return;
    loading = true;
    refreshBtn.classList.add('vc-spin');
    refreshBtn.setAttribute('aria-busy', 'true');
    try {
      const data = await voice.listRooms();
      if (disposed) return;
      mount(setupBox);
      drawFriends(data);
      drawList(mineBox, data.mine, 'mine');
      drawList(recentBox, data.recent, 'recent');
      recentSection.hidden = !data.recent.length;
    } catch (err) {
      if (disposed) return;
      if (err?.code === 'not_installed') {
        mount(setupBox, errorBox(err, () => load(false)));
        mount(friendsBox, emptyLine('clock', t('voice.unavailableShort')));
        mount(mineBox, emptyLine('clock', t('voice.unavailableShort')));
      } else if (!quiet || !friendsBox.querySelector('.vc-room-item')) {
        mount(friendsBox, errorBox(err, () => load(false)));
        mount(mineBox);
      }
    } finally {
      loading = false;
      refreshBtn.classList.remove('vc-spin');
      refreshBtn.removeAttribute('aria-busy');
    }
  }

  function drawFriends(data) {
    if (!data.friendsSupported) {
      mount(friendsBox, emptyLine('users', t('voice.friendsRoomsUnavailable')));
      return;
    }
    if (!data.friends.length) {
      mount(friendsBox, emptyCard('users', t('voice.noFriendRooms'), t('voice.noFriendRoomsHint'), h('button', { class: 'btn sm', onclick: () => navigate('messages') }, icon('message'), t('voice.openMessages'))));
      return;
    }
    drawList(friendsBox, data.friends, 'friends');
  }

  function drawList(box, rooms, kind) {
    if (!rooms.length) {
      if (kind === 'mine') mount(box, emptyCard('mic', t('voice.noMyRoomsTitle'), t('voice.noMyRoomsHint'), h('button', { class: 'btn sm', onclick: () => create.focus() }, icon('plus'), t('voice.createFirstRoom'))));
      else mount(box);
      return;
    }
    mount(box, rooms.map((r) => roomItem(r, kind, () => load(false))));
  }

  load(false);
  const timer = setInterval(() => {
    if (document.visibilityState === 'visible') load(true);
  }, REFRESH_MS);
  return () => {
    disposed = true;
    clearInterval(timer);
    join.dispose();
  };
}

// Filas fantasma con la forma de una sala mientras carga la lista
function roomsSkeleton(n) {
  return skeleton('list', { rows: n, label: t('voice.loading') });
}

function emptyLine(iconName, text) {
  return h('div', { class: 'vc-empty-line' }, icon(iconName), h('span', {}, text));
}

// Estado vacio compacto: icono + que pasa + que hacer + accion
function emptyCard(iconName, title, hint, action) {
  return h(
    'div',
    { class: 'vc-empty-card' },
    h('div', { class: 'vc-empty-icon', 'aria-hidden': 'true' }, icon(iconName)),
    h('div', { class: 'vc-empty-main' }, h('div', { class: 'vc-empty-title' }, title), h('div', { class: 'vc-empty-text' }, hint)),
    action || null,
  );
}

function roomBadges(room, kind) {
  const out = [];
  if (room.active) out.push(h('span', { class: 'pill good' }, h('span', { class: 'status-dot online', 'aria-hidden': 'true' }), t('voice.activeNow', { count: room.active })));
  if (room.locked) out.push(h('span', { class: 'badge warn', title: t('voice.lockedHint') }, icon('lock'), t('voice.lockedBadge')));
  if (room.hasPassword) out.push(h('span', { class: 'badge' }, icon('key'), t('voice.passwordBadge')));
  if (kind === 'mine') out.push(room.isPrivate ? h('span', { class: 'badge' }, icon('eyeOff'), t('voice.privateBadge')) : h('span', { class: 'badge accent' }, icon('users'), t('voice.friendsBadge')));
  return out;
}

function roomItem(room, kind, reload) {
  // Entrar a una sala con gente adentro es la accion "en vivo" (verde, como el indicador de la fila)
  const enter = h('button', { class: ['btn', 'sm', room.active && 'good'] }, icon('logIn'), t('voice.enter'));
  enter.addEventListener('click', async () => {
    const done = setBusy(enter);
    try {
      await joinWithPassword(room.code, { roomName: room.name });
    } finally {
      done();
    }
  });
  const actions = [enter, h('button', { class: 'icon-btn sm', title: t('voice.copyCode'), 'aria-label': t('voice.copyCode'), onclick: () => copyText(room.code, t('voice.codeCopied')) }, icon('copy'))];
  if (kind === 'mine') {
    actions.push(h('button', { class: 'icon-btn sm', title: t('voice.editRoom'), 'aria-label': t('voice.editRoom'), onclick: () => openRoomEditor(room, reload) }, icon('edit')));
    actions.push(
      h(
        'button',
        {
          class: 'icon-btn sm danger',
          title: t('voice.deleteRoom'),
          'aria-label': t('voice.deleteRoom'),
          onclick: async () => {
            if (!(await confirmDialog(t('voice.deleteRoomTitle'), t('voice.deleteRoomText', { name: room.name }), { okText: t('voice.deleteRoom'), danger: true }))) return;
            try {
              await voice.deleteRoom(room.id);
              ok(t('voice.roomDeleted'), room.name);
              reload();
            } catch (err) {
              fail(t('voice.deleteFailed'), err);
            }
          },
        },
        icon('trash'),
      ),
    );
  } else if (kind === 'recent') {
    actions.push(
      h(
        'button',
        {
          class: 'icon-btn sm',
          title: t('voice.forgetRoom'),
          'aria-label': t('voice.forgetRoom'),
          onclick: async () => {
            if (!(await confirmDialog(t('voice.forgetRoomTitle'), t('voice.forgetRoomText', { name: room.name }), { okText: t('voice.forgetRoom') }))) return;
            try {
              await voice.forgetRoom(room.id);
              reload();
            } catch (err) {
              fail(t('voice.forgetFailed'), err);
            }
          },
        },
        icon('x'),
      ),
    );
  }
  const sub =
    kind === 'friends'
      ? t('voice.roomOf', { name: room.ownerName || t('voice.someone') })
      : room.active
        ? t('voice.membersOf', { count: room.active, max: room.maxMembers })
        : t('voice.lastActive', { when: fmtAgo(room.lastActive) });
  const names = room.people.map((p) => p.name).filter(Boolean).join(', ');
  const faces = room.people.length
    ? h(
        'div',
        { class: 'vc-faces', role: 'img', title: names, 'aria-label': names },
        room.people.slice(0, 4).map((p) => personAvatar(p.avatar, p.name, 32, 'vc-face')),
        room.people.length > 4 ? h('span', { class: 'vc-face vc-face-more' }, `+${room.people.length - 4}`) : null,
      )
    : null;
  return h(
    'div',
    { class: ['vc-room-item', room.active && 'live'] },
    kind === 'friends' ? personAvatar(room.ownerAvatar, room.ownerName, 64, 'vc-room-owner') : h('div', { class: 'vc-room-icon', 'aria-hidden': 'true' }, icon(room.hasPassword ? 'lock' : 'mic')),
    h(
      'div',
      { class: 'vc-room-main' },
      h('div', { class: 'vc-room-title' }, h('span', { class: 'ellipsis', title: room.name }, room.name), h('span', { class: 'kbd vc-room-code', title: t('voice.roomCode') }, room.code)),
      h('div', { class: 'vc-room-sub' }, h('span', { class: 'ellipsis', title: sub }, sub), roomBadges(room, kind)),
    ),
    faces,
    h('div', { class: 'vc-room-actions' }, actions),
  );
}

function createCard() {
  const ids = { name: fieldId('vc-new-name'), pw: fieldId('vc-new-pw'), max: fieldId('vc-new-max'), vis: fieldId('vc-new-vis') };
  const name = h('input', { class: 'input', id: ids.name, maxlength: 40, placeholder: voice.defaultRoomName(), autocomplete: 'off' });
  let isPrivate = false;
  const visHint = h('div', { class: 'field-help', id: ids.vis }, t('voice.visFriendsHint'));
  const vis = segmented(
    [
      { id: 'friends', icon: 'users', label: t('voice.visFriends') },
      { id: 'private', icon: 'eyeOff', label: t('voice.visPrivate') },
    ],
    'friends',
    (v) => {
      isPrivate = v === 'private';
      visHint.textContent = t(isPrivate ? 'voice.visPrivateHint' : 'voice.visFriendsHint');
    },
    t('voice.visibility'),
  );
  vis.el.setAttribute('aria-describedby', ids.vis);
  const pw = passwordField({ placeholder: t('voice.passwordOptional'), label: t('voice.password'), id: ids.pw });
  const pwErr = fieldError(pw.input);
  pw.input.addEventListener('input', () => pwErr.set(''));
  // Se valida al salir del campo, no en cada tecla
  pw.input.addEventListener('blur', () => {
    if (pw.input.value && pw.input.value.length < 4) pwErr.set(t('voice.err_bad_password_format'));
  });
  let maxMembers = MAX_MEMBERS;
  const max = selectEl(maxOptions(), maxMembers, (v) => (maxMembers = Number(v)));
  max.id = ids.max;
  const btn = h('button', { class: 'btn primary' }, icon('plus'), t('voice.createRoom'));
  const submit = async () => {
    if (btn.disabled) return;
    if (pw.input.value && pw.input.value.length < 4) {
      pwErr.set(t('voice.err_bad_password_format'));
      pw.input.focus();
      return;
    }
    const done = setBusy(btn);
    try {
      await voice.createRoom({ name: name.value.trim() || undefined, private: isPrivate, password: pw.input.value, maxMembers });
    } catch (err) {
      fail(t('voice.createFailed'), err);
    } finally {
      done();
    }
  };
  btn.addEventListener('click', submit);
  name.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  const el = h(
    'section',
    { class: 'card vc-create', 'aria-labelledby': 'vc-create-title' },
    cardHead('plus', t('voice.createTitle'), t('voice.createSub'), '', 'vc-create-title'),
    h('div', { class: 'field' }, h('label', { for: ids.name }, t('voice.roomName')), name),
    h('div', { class: 'field' }, h('span', { class: 'label' }, t('voice.visibility')), vis.el, visHint),
    h('div', { class: 'vc-create-row' }, h('div', { class: 'field' }, h('label', { for: ids.pw }, t('voice.password')), pw.el, pwErr.el), h('div', { class: 'field vc-max' }, h('label', { for: ids.max }, t('voice.maxMembers')), max)),
    h('div', { class: 'vc-card-foot' }, btn),
  );
  return {
    el,
    focus() {
      el.scrollIntoView({ block: 'nearest', behavior: 'auto' });
      name.focus();
    },
  };
}

function joinCard(initialCode) {
  const ids = { code: fieldId('vc-join-code'), hint: fieldId('vc-join-hint'), pw: fieldId('vc-join-pw') };
  const input = h('input', { class: 'input vc-code-input', id: ids.code, maxlength: 7, placeholder: 'ABC234', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': ids.hint });
  const preview = h('div', { class: 'vc-preview', id: ids.hint, 'aria-live': 'polite' });
  const pw = passwordField({ placeholder: t('voice.password'), label: t('voice.password'), id: ids.pw });
  const pwBox = h('div', { class: 'field', hidden: true }, h('label', { for: ids.pw }, t('voice.password')), pw.el);
  const btn = h('button', { class: 'btn', disabled: true }, icon('logIn'), t('voice.joinBtn'));
  let info = null;
  let token = 0;
  let disposed = false;

  const sanitize = () => {
    const raw = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    if (raw !== input.value) input.value = raw;
    return raw;
  };

  // Lista para entrar: el boton pasa a verde (la misma señal que las salas con gente)
  const setReady = (ready) => btn.classList.toggle('good', Boolean(ready));

  const hint = () => h('div', { class: 'vc-preview-hint' }, icon('search'), h('span', {}, t('voice.codeHint')));

  const lookup = debounce(async (code) => {
    const my = ++token;
    mount(preview, h('div', { class: 'vc-preview-line', role: 'status' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), t('voice.lookingUp')));
    try {
      const room = await voice.roomInfo(code);
      if (my !== token || disposed) return;
      info = room;
      const needsPw = room.hasPassword && !room.admitted;
      pwBox.hidden = !needsPw;
      const sub = t('voice.roomOf', { name: room.ownerName || t('voice.someone') });
      mount(
        preview,
        h(
          'div',
          { class: 'vc-preview-card' },
          personAvatar(room.ownerAvatar, room.ownerName, 64, 'vc-room-owner'),
          h(
            'div',
            { class: 'vc-preview-main' },
            h('div', { class: 'vc-room-title' }, h('span', { class: 'ellipsis', title: room.name }, room.name)),
            h('div', { class: 'vc-room-sub' }, h('span', { class: 'ellipsis', title: sub }, sub), h('span', { class: 'pill' }, t('voice.membersOf', { count: room.active, max: room.maxMembers }))),
          ),
          room.locked ? h('span', { class: 'badge warn', title: t('voice.lockedHint') }, icon('lock'), t('voice.lockedBadge')) : null,
          needsPw ? h('span', { class: 'badge' }, icon('key'), t('voice.passwordBadge')) : null,
        ),
        room.banned ? h('div', { class: 'vc-preview-line bad', role: 'alert' }, icon('ban'), t('voice.err_banned')) : null,
      );
      btn.disabled = room.banned;
      setReady(!room.banned);
      if (needsPw && document.activeElement === input) setTimeout(() => !disposed && pw.input.focus({ preventScroll: true }), 30);
    } catch (err) {
      if (my !== token || disposed) return;
      info = null;
      pwBox.hidden = true;
      btn.disabled = err?.code === 'not_found';
      setReady(false);
      mount(preview, h('div', { class: 'vc-preview-line bad', role: 'alert' }, icon('alert'), h('span', {}, err.message)));
    }
  }, 350);

  const onInput = () => {
    const code = sanitize();
    info = null;
    token++;
    setReady(false);
    const valid = Boolean(normalizeCode(code));
    btn.disabled = !valid;
    if (!valid) {
      pwBox.hidden = true;
      mount(preview, code.length === 6 ? h('div', { class: 'vc-preview-line bad', role: 'alert' }, icon('alert'), h('span', {}, t('voice.err_code_format'))) : hint());
      return;
    }
    lookup(code);
  };

  const submit = async () => {
    const code = normalizeCode(sanitize());
    if (!code || btn.classList.contains('loading')) return;
    const done = setBusy(btn);
    try {
      await voice.joinRoom(code, { password: pw.input.value || undefined });
    } catch (err) {
      if (err?.code === 'password_required' || err?.code === 'bad_password') {
        pwBox.hidden = false;
        pw.input.focus();
        if (err.code === 'bad_password') {
          pw.input.select();
          fail(t('voice.joinFailed'), err);
        }
      } else fail(t('voice.joinFailed'), err);
    } finally {
      if (!disposed) done();
    }
  };

  input.addEventListener('input', onInput);
  input.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  pw.input.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  btn.addEventListener('click', submit);

  const el = h(
    'section',
    { class: 'card vc-join', 'aria-labelledby': 'vc-join-title' },
    cardHead('hash', t('voice.joinTitle'), t('voice.joinSub'), 'alt', 'vc-join-title'),
    h('div', { class: 'field' }, h('label', { for: ids.code }, t('voice.roomCode')), input),
    preview,
    pwBox,
    h('div', { class: 'vc-card-foot' }, btn),
  );
  if (initialCode) {
    input.value = String(initialCode);
    onInput();
  } else mount(preview, hint());
  return {
    el,
    dispose() {
      disposed = true;
      token++;
    },
    get info() {
      return info;
    },
  };
}

function cardHead(iconName, title, sub, variant = '', id = null) {
  return h(
    'div',
    { class: 'vc-card-head' },
    h('div', { class: ['vc-card-icon', variant], 'aria-hidden': 'true' }, icon(iconName)),
    h('div', { class: 'vc-card-titles' }, h('h2', { class: 'card-title', id }, title), h('p', { class: 'card-sub' }, sub)),
  );
}
