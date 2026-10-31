// Vista dentro de una sala: encabezado, pantalla compartida, miembros con indicador de voz,
// controles, soundboard, chat de la sala, invitaciones y herramientas del anfitrion.
import { h, icon, mount, modal, fail, ok, toast, confirmDialog, copyText, switchEl, fmtTime, reducedMotion, setBusy } from '../ui.js';
import { t } from '../i18n.js';
import { navigate } from '../app.js';
import { social } from '../social.js';
import { voice } from '../voice.js';
import { acceleratorParts, keyLabel } from './keys.js';
import { personAvatar, fmtPing, openRoomEditor, tSlot, kbdKeys } from './ui-common.js';

const SPEAK_LEVEL = 0.34; // ~ -53 dB

// Fecha para el atributo datetime (null si el valor no es una fecha valida)
function isoOf(ts) {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function roomView(container, { onTab } = {}) {
  const offs = [];
  const tiles = new Map();
  let order = '';
  let pop = null;
  let boardOpen = false;
  let stageHidden = false;
  let selectedScreen = null;
  let lastScreensKey = '';

  // ---------- Encabezado ----------
  const nameEl = h('h2', { class: 'vc-head-name' });
  const statusEl = h('span', { class: 'pill', role: 'status' });
  const codeText = h('span', { class: 'vc-code-text' });
  // El nombre accesible es el codigo; el title dice que hace el boton
  const codeBtn = h('button', { class: 'vc-code', type: 'button', title: t('voice.copyCode') }, icon('hash'), codeText, icon('copy'));
  codeBtn.addEventListener('click', () => voice.room && copyText(voice.room.code, t('voice.codeCopied')));
  const countEl = h('span', { class: 'vc-head-count' });
  const badgesEl = h('span', { class: 'vc-head-badges' });
  const inviteBtn = h('button', { class: 'btn sm vc-invite-btn', type: 'button', title: t('voice.invite'), 'aria-label': t('voice.invite') }, icon('userPlus'), h('span', { class: 'vc-btn-label' }, t('voice.invite')));
  inviteBtn.addEventListener('click', () => openInvite());
  const hostBtn = h('button', { class: 'icon-btn vc-host-btn', type: 'button', title: t('voice.hostTools'), 'aria-label': t('voice.hostTools'), 'aria-haspopup': 'dialog', 'aria-expanded': 'false' }, icon('crown'));
  hostBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openHostMenu(hostBtn);
  });
  const head = h(
    'div',
    { class: 'card vc-head' },
    h('div', { class: 'vc-head-icon', 'aria-hidden': 'true' }, icon('mic')),
    h('div', { class: 'vc-head-main' }, h('div', { class: 'vc-head-title' }, nameEl, statusEl), h('div', { class: 'vc-head-meta' }, codeBtn, countEl, badgesEl)),
    h('div', { class: 'vc-head-actions' }, inviteBtn, hostBtn),
  );

  // ---------- Pantalla compartida ----------
  const video = h('video', { class: 'vc-video', autoplay: true, playsinline: true });
  video.muted = true;
  const stageLabel = h('div', { class: 'vc-stage-label' });
  const stageChips = h('div', { class: 'vc-stage-chips' });
  const stopShareBtn = h('button', { class: 'btn danger sm hidden' }, icon('screenShareOff'), t('voice.stopSharing'));
  stopShareBtn.addEventListener('click', () => voice.stopScreenShare());
  const fsBtn = h('button', { class: 'icon-btn sm', title: t('voice.fullscreen'), 'aria-label': t('voice.fullscreen') }, icon('maximize'));
  const stageBox = h('div', { class: 'vc-stage-frame' }, video);
  fsBtn.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else stageBox.requestFullscreen?.().catch(() => {});
  });
  const hideBtn = h('button', { class: 'icon-btn sm', title: t('voice.hideScreen'), 'aria-label': t('voice.hideScreen') }, icon('eyeOff'));
  hideBtn.addEventListener('click', () => {
    stageHidden = true;
    drawScreens(true);
  });
  const showBar = h('button', { class: 'vc-stage-collapsed hidden' }, icon('screenShare'), h('span', { class: 'ellipsis' }), h('span', { class: 'vc-stage-view' }, icon('eye'), t('voice.showScreen')));
  showBar.addEventListener('click', () => {
    stageHidden = false;
    drawScreens(true);
  });
  const stage = h('div', { class: 'card vc-stage hidden' }, h('div', { class: 'vc-stage-bar' }, h('span', { class: 'vc-live-dot', 'aria-hidden': 'true' }), stageLabel, stageChips, h('span', { class: 'spacer' }), stopShareBtn, fsBtn, hideBtn), stageBox);

  // ---------- Miembros + controles ----------
  const grid = h('div', { class: 'vc-grid', role: 'list', 'aria-label': t('voice.members') });
  const inviteTile = h('button', { class: 'vc-tile vc-invite-tile', type: 'button', title: t('voice.inviteFriends') }, h('div', { class: 'vc-invite-icon', 'aria-hidden': 'true' }, icon('userPlus')), h('div', { class: 'vc-tile-name' }, t('voice.inviteFriends')), h('div', { class: 'vc-invite-code' }));
  inviteTile.addEventListener('click', () => openInvite());
  // La lista solo puede tener listitems: el boton va adentro de una celda
  const inviteCell = h('div', { class: 'vc-invite-cell', role: 'listitem' }, inviteTile);
  const soundChip = h('div', { class: 'vc-sound-chip', 'aria-live': 'polite' });
  const board = soundboard();
  const ctl = controls();
  const membersCard = h('div', { class: 'card vc-members' }, soundChip, h('div', { class: 'vc-grid-wrap' }, grid));
  ctl.el.prepend(board.el);

  // ---------- Chat ----------
  const chat = chatPanel();

  const roomEl = h('div', { class: 'vc-room' }, h('div', { class: 'vc-room-col' }, head, showBar, stage, membersCard, ctl.el), chat.el);
  mount(container, roomEl);

  // En pantallas anchas la sala ocupa justo el alto visible (como una llamada); en angostas se desplaza
  const page = container.closest('.page');
  const fit = () => {
    if (!page || !roomEl.isConnected) return;
    const top = roomEl.getBoundingClientRect().top - page.getBoundingClientRect().top + page.scrollTop;
    roomEl.style.setProperty('--vc-h', `${Math.max(440, Math.round(page.clientHeight - top - 24))}px`);
  };
  window.addEventListener('resize', fit);
  requestAnimationFrame(fit);

  // ---------- Dibujo ----------
  function drawRoom() {
    const room = voice.room;
    if (!room) return;
    nameEl.textContent = room.name;
    nameEl.title = room.name;
    codeText.textContent = room.code;
    inviteTile.querySelector('.vc-invite-code').textContent = room.code;
    const n = room.members.length;
    countEl.textContent = t('voice.membersOf', { count: n, max: room.maxMembers });
    const reconnecting = room.status !== 'connected';
    statusEl.className = `pill ${reconnecting ? 'warn' : 'good'}`;
    mount(statusEl, h('span', { class: ['status-dot', reconnecting ? 'starting' : 'online'], 'aria-hidden': 'true' }), t(reconnecting ? 'voice.statusReconnecting' : 'voice.statusConnected'));
    mount(
      badgesEl,
      room.locked ? h('span', { class: 'badge warn' }, icon('lock'), t('voice.lockedBadge')) : null,
      room.hasPassword ? h('span', { class: 'badge' }, icon('key'), t('voice.passwordBadge')) : null,
      room.isPrivate ? h('span', { class: 'badge' }, icon('eyeOff'), t('voice.privateBadge')) : h('span', { class: 'badge accent' }, icon('users'), t('voice.friendsBadge')),
      room.demo ? h('span', { class: 'badge' }, t('voice.demoBadge')) : null,
    );
    hostBtn.classList.toggle('hidden', !room.isOwner);
  }

  function drawMembers(list) {
    const room = voice.room;
    if (!room) return;
    const seen = new Set();
    for (const m of list) {
      seen.add(m.userId);
      let tile = tiles.get(m.userId);
      if (!tile) {
        tile = createTile(m);
        tiles.set(m.userId, tile);
      }
      updateTile(tile, m);
    }
    for (const [id, tile] of tiles) {
      if (!seen.has(id)) {
        tile.el.remove();
        tiles.delete(id);
        if (pop?.userId === id) closePop();
      }
    }
    const want = list.length < room.maxMembers;
    const key = list.map((m) => m.userId).join(',') + (want ? '+' : '');
    if (key !== order) {
      order = key;
      for (const m of list) grid.append(tiles.get(m.userId).el);
      if (want) grid.append(inviteCell);
      else inviteCell.remove();
    }
    grid.dataset.count = String(Math.min(list.length + (want ? 1 : 0), 9));
    drawRoom();
  }

  function createTile(m) {
    const ring = h('span', { class: 'vc-ring', 'aria-hidden': 'true' });
    const wrap = h('div', { class: 'vc-avatar-wrap' }, ring, personAvatar(m.avatar, m.name, 96, 'vc-avatar'));
    const name = h('div', { class: 'vc-tile-name' });
    const flags = h('div', { class: 'vc-tile-flags' });
    const conn = h('span', { class: 'vc-conn', role: 'img' });
    const menu = h('button', { class: 'icon-btn sm vc-tile-menu', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' }, icon('more'));
    const el = h('div', { class: 'vc-tile', role: 'listitem' }, conn, menu, wrap, name, flags);
    const tile = { el, wrap, name, flags, conn, menu, member: m, key: '', avatar: m.avatar, speakingUntil: 0 };
    menu.addEventListener('click', (e) => {
      e.stopPropagation();
      openMemberMenu(tile, menu);
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openMemberMenu(tile, menu);
    });
    return tile;
  }

  function flag(iconName, label, cls) {
    return h('span', { class: ['vc-flag', cls], role: 'img', title: label, 'aria-label': label }, icon(iconName));
  }

  function updateTile(tile, m) {
    tile.member = m;
    const pingBucket = m.ping === null ? 'n' : m.ping < 90 ? 'g' : m.ping < 200 ? 'w' : 'b';
    const key = [m.name, m.avatar, m.isOwner, m.muted, m.deafened, m.ptt, m.sharing, m.connection, pingBucket, m.relay, m.localMute, m.volume].join('|');
    if (key === tile.key) return;
    tile.key = key;
    if (m.avatar !== tile.avatar) {
      tile.avatar = m.avatar;
      tile.wrap.querySelector('img')?.replaceWith(personAvatar(m.avatar, m.name, 96, 'vc-avatar'));
    }
    const el = tile.el;
    el.classList.toggle('self', m.self);
    el.classList.toggle('muted', Boolean(m.muted || m.localMute));
    el.classList.toggle('deafened', Boolean(m.deafened));
    el.classList.toggle('owner', Boolean(m.isOwner));
    el.classList.toggle('weak', ['away', 'reconnecting', 'connecting'].includes(m.connection) && !m.self);
    el.classList.toggle('failed', m.connection === 'failed');
    mount(tile.name, h('span', { class: 'ellipsis', title: m.name }, m.name), m.isOwner ? h('span', { class: 'vc-crown', role: 'img', title: t('voice.host'), 'aria-label': t('voice.host') }, icon('crown')) : null);
    mount(
      tile.flags,
      m.self ? h('span', { class: 'vc-you' }, t('voice.youTag')) : null,
      m.muted ? flag('micOff', t('voice.flagMuted'), 'bad') : null,
      m.deafened ? flag('headphonesOff', t('voice.flagDeafened'), 'bad') : null,
      m.ptt ? h('span', { class: 'vc-flag ptt', title: t('voice.flagPtt') }, t('voice.pttShort')) : null,
      m.localMute ? flag('volumeX', t('voice.flagLocalMuted'), 'warn') : null,
      m.sharing ? flag('screenShare', t('voice.flagSharing'), 'accent') : null,
      !m.self && m.volume !== 1 && !m.localMute ? h('span', { class: 'vc-flag vol', title: t('voice.volume') }, `${Math.round(m.volume * 100)}%`) : null,
    );
    // Calidad de la conexion directa
    let connLabel = '';
    let connCls = 'vc-conn';
    if (m.self) connCls += ' hidden';
    else if (m.connection === 'connected') {
      connCls += ` q-${pingBucket}`;
      connLabel = m.ping === null ? t('voice.connConnected') : t('voice.connPing', { ping: fmtPing(m.ping) });
      if (m.relay) connLabel = t('voice.connRelay', { status: connLabel });
    } else if (m.connection === 'failed') {
      connCls += ' q-fail';
      connLabel = t('voice.connFailed');
    } else {
      connCls += ' q-wait';
      connLabel = t(m.connection === 'connecting' ? 'voice.connConnecting' : 'voice.connReconnecting');
    }
    tile.conn.className = connCls;
    tile.conn.title = connLabel;
    tile.conn.setAttribute('aria-label', connLabel);
    mount(tile.conn, m.connection === 'failed' ? icon('alert') : [h('i'), h('i'), h('i')]);
    const menuLabel = t(m.self ? 'voice.selfMenu' : 'voice.memberMenu', { name: m.name });
    tile.menu.title = menuLabel;
    tile.menu.setAttribute('aria-label', menuLabel);
    el.setAttribute('aria-label', [m.name, m.isOwner ? t('voice.host') : '', m.muted ? t('voice.flagMuted') : '', m.deafened ? t('voice.flagDeafened') : '', connLabel].filter(Boolean).join(' · '));
  }

  function onLevels(levels) {
    const now = performance.now();
    const deafened = voice.deafened;
    for (const tile of tiles.values()) {
      const m = tile.member;
      let lvl = 0;
      let speaking = false;
      if (m.self) {
        speaking = Boolean(levels.speaking);
        lvl = speaking ? Math.max(levels.self || 0, 0.5) : 0;
      } else if (!m.localMute && !deafened) {
        lvl = levels.users?.[m.userId] || 0;
        speaking = lvl > SPEAK_LEVEL || (!lvl && m.speaking && m.connection !== 'connected');
      }
      if (speaking) tile.speakingUntil = now + 280;
      const on = now < tile.speakingUntil;
      tile.el.classList.toggle('speaking', on);
      tile.el.style.setProperty('--lvl', on ? Math.min(1, Math.max(0.35, lvl)).toFixed(2) : '0');
    }
    ctl.level(levels);
  }

  // ---------- Popovers ----------
  function closePop() {
    if (!pop) return;
    const p = pop;
    pop = null;
    p.el.remove();
    p.anchor?.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', p.onDown, true);
    document.removeEventListener('keydown', p.onKey, true);
    window.removeEventListener('resize', closePop);
    if (p.restoreFocus && document.activeElement === document.body) p.anchor?.focus();
  }

  function openPop(anchor, content, extra = {}) {
    closePop();
    const el = h('div', { class: 'vc-pop', role: 'dialog', 'aria-label': extra.label || anchor.getAttribute('aria-label') || null }, content);
    document.body.append(el);
    const r = anchor.getBoundingClientRect();
    const pr = el.getBoundingClientRect();
    let left = Math.min(r.right - pr.width, window.innerWidth - pr.width - 10);
    left = Math.max(10, left);
    let top = r.bottom + 8;
    if (top + pr.height > window.innerHeight - 10) top = Math.max(10, r.top - pr.height - 8);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    const onDown = (e) => {
      if (!el.contains(e.target) && !anchor.contains(e.target)) closePop();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        pop.restoreFocus = true;
        closePop();
      }
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', closePop);
    pop = { el, anchor, onDown, onKey, ...extra };
    anchor.setAttribute('aria-expanded', 'true');
    el.querySelector('input, button')?.focus();
  }

  function openMemberMenu(tile, anchor) {
    const m = tile.member;
    const room = voice.room;
    if (!room) return;
    if (pop?.userId === m.userId) {
      closePop();
      return;
    }
    const headEl = h('div', { class: 'vc-pop-head' }, personAvatar(m.avatar, m.name, 64, 'vc-pop-avatar'), h('div', { class: 'vc-pop-titles' }, h('div', { class: 'vc-pop-name', title: m.name }, m.name), h('div', { class: 'vc-pop-sub' }, m.self ? t('voice.youTag') : tile.conn.title || '')));
    if (m.self) {
      const st = voice.settings;
      const val = h('span', { class: 'vc-pop-val' }, `${Math.round((st.inputVolume ?? 1) * 100)}%`);
      const range = h('input', { type: 'range', class: 'range', min: 0, max: 200, step: 5, value: Math.round((st.inputVolume ?? 1) * 100), 'aria-label': t('voice.inputVolume') });
      range.addEventListener('input', () => (val.textContent = `${range.value}%`));
      range.addEventListener('change', () => voice.saveSettings({ inputVolume: Number(range.value) / 100 }));
      openPop(
        anchor,
        [
          headEl,
          h('div', { class: 'vc-pop-field' }, h('div', { class: 'vc-pop-label' }, t('voice.inputVolume'), val), range),
          h('button', { class: 'vc-pop-item', type: 'button', onclick: () => (closePop(), onTab?.('audio')) }, icon('sliders'), t('voice.audioSettings')),
        ],
        { userId: m.userId, label: t('voice.selfMenu') },
      );
      return;
    }
    const val = h('span', { class: 'vc-pop-val' }, `${Math.round(m.volume * 100)}%`);
    const range = h('input', { type: 'range', class: 'range', min: 0, max: 200, step: 5, value: Math.round(m.volume * 100), 'aria-label': t('voice.volumeOf', { name: m.name }) });
    range.addEventListener('input', () => {
      val.textContent = `${range.value}%`;
      voice.setVolume(m.userId, Number(range.value) / 100);
    });
    const items = [
      headEl,
      h('div', { class: 'vc-pop-field' }, h('div', { class: 'vc-pop-label' }, t('voice.volume'), val), range, h('div', { class: 'vc-pop-scale' }, h('span', {}, '0%'), h('span', {}, '100%'), h('span', {}, '200%'))),
      h('label', { class: 'vc-pop-toggle' }, h('span', { class: 'vc-pop-toggle-text' }, t('voice.localMute'), h('span', { class: 'vc-pop-sub' }, t('voice.localMuteHint'))), switchEl(m.localMute, (v) => voice.setLocalMute(m.userId, v), t('voice.localMute'))),
    ];
    if (room.isOwner) {
      items.push(
        h('div', { class: 'vc-pop-sep', role: 'separator' }),
        h('div', { class: 'vc-pop-section' }, icon('crown'), t('voice.hostActions')),
        h(
          'button',
          {
            class: 'vc-pop-item',
            type: 'button',
            disabled: m.muted,
            onclick: async () => {
              closePop();
              try {
                await voice.requestMute(m.userId);
                ok(t('voice.muteRequested'), m.name);
              } catch (err) {
                fail(t('voice.actionFailed'), err);
              }
            },
          },
          icon('micOff'),
          t('voice.requestMute'),
        ),
        h('button', { class: 'vc-pop-item warn', type: 'button', onclick: () => kickFlow(m, false) }, icon('userX'), t('voice.kick')),
        h('button', { class: 'vc-pop-item bad', type: 'button', onclick: () => kickFlow(m, true) }, icon('ban'), t('voice.ban')),
      );
    }
    openPop(anchor, items, { userId: m.userId, label: t('voice.memberMenu', { name: m.name }) });
  }

  async function kickFlow(m, ban) {
    closePop();
    const okd = await confirmDialog(t(ban ? 'voice.banTitle' : 'voice.kickTitle'), t(ban ? 'voice.banText' : 'voice.kickText', { name: m.name }), { okText: t(ban ? 'voice.ban' : 'voice.kick'), danger: true });
    if (!okd) return;
    try {
      await voice.kick(m.userId, { ban });
      ok(t(ban ? 'voice.banned' : 'voice.kicked'), m.name);
    } catch (err) {
      fail(t('voice.actionFailed'), err);
    }
  }

  function openHostMenu(anchor) {
    const room = voice.room;
    if (!room?.isOwner) return;
    if (pop?.host) {
      closePop();
      return;
    }
    openPop(
      anchor,
      [
        h('div', { class: 'vc-pop-section' }, icon('crown'), t('voice.hostTools')),
        h(
          'label',
          { class: 'vc-pop-toggle' },
          h('span', { class: 'vc-pop-toggle-text' }, t('voice.lockRoom'), h('span', { class: 'vc-pop-sub' }, t('voice.lockRoomHint'))),
          switchEl(
            room.locked,
            async (v) => {
              try {
                await voice.setLocked(v);
                toast('info', t(v ? 'voice.roomLocked' : 'voice.roomUnlocked'), room.name, 3000);
              } catch (err) {
                fail(t('voice.actionFailed'), err);
              }
            },
            t('voice.lockRoom'),
          ),
        ),
        h(
          'button',
          {
            class: 'vc-pop-item',
            type: 'button',
            onclick: () => {
              closePop();
              if (room.demo) return;
              openRoomEditor(room);
            },
          },
          icon('edit'),
          t('voice.editRoom'),
        ),
        h('div', { class: 'vc-pop-sep', role: 'separator' }),
        h(
          'button',
          {
            class: 'vc-pop-item bad',
            type: 'button',
            onclick: async () => {
              closePop();
              if (!(await confirmDialog(t('voice.endRoomTitle'), t('voice.endRoomText'), { okText: t('voice.endRoom'), danger: true }))) return;
              try {
                await voice.endRoom();
              } catch (err) {
                fail(t('voice.actionFailed'), err);
              }
            },
          },
          icon('power'),
          t('voice.endRoom'),
        ),
      ],
      { host: true, label: t('voice.hostTools') },
    );
  }

  // ---------- Invitar ----------
  function openInvite() {
    const room = voice.room;
    if (!room) return;
    const box = h('div', { class: 'vc-invite-list' });
    const friendsOf = () => {
      const list = Array.isArray(social?.friends) ? social.friends : [];
      const inRoom = new Set((voice.room?.members || []).map((m) => m.userId));
      return list
        .map((f) => ({ id: f.id || f.userId, name: f.name || f.profile?.display_name || f.profile?.username || '', avatar: f.profile?.mc_uuid || f.profile?.mc_name || f.profile?.username || null, presence: f.presence || social.presenceOf?.(f.id)?.presence || 'offline' }))
        .filter((f) => f.id && !inRoom.has(f.id));
    };
    const sent = new Set();
    const draw = () => {
      const canInvite = typeof social?.sendSignal === 'function';
      const list = friendsOf();
      if (!canInvite || !list.length) {
        mount(
          box,
          h(
            'div',
            { class: 'vc-empty-card' },
            h('div', { class: 'vc-empty-icon', 'aria-hidden': 'true' }, icon('users')),
            h('div', { class: 'vc-empty-main' }, h('div', { class: 'vc-empty-title' }, t(canInvite ? 'voice.noFriendsToInvite' : 'voice.inviteUnavailableTitle')), h('div', { class: 'vc-empty-text' }, t('voice.noFriendsToInviteHint'))),
            h(
              'button',
              {
                class: 'btn sm',
                type: 'button',
                onclick: () => {
                  m.close();
                  navigate('messages');
                },
              },
              icon('userPlus'),
              t('voice.openMessages'),
            ),
          ),
        );
        return;
      }
      const online = (p) => ['online', 'away', 'busy'].includes(p);
      list.sort((a, b) => Number(online(b.presence)) - Number(online(a.presence)) || a.name.localeCompare(b.name));
      mount(
        box,
        list.map((f) => {
          // Un boton por amigo: secundario (la lista no compite con una accion principal)
          const btn = h('button', { class: ['btn sm', sent.has(f.id) && 'good'], type: 'button', disabled: sent.has(f.id) }, icon(sent.has(f.id) ? 'check' : 'send'), t(sent.has(f.id) ? 'voice.invited' : 'voice.inviteOne'));
          btn.addEventListener('click', async () => {
            const done = setBusy(btn);
            try {
              await voice.inviteFriend(f.id);
              sent.add(f.id);
              draw();
            } catch (err) {
              done();
              fail(t('voice.inviteFailed'), err);
            }
          });
          const presence = ['online', 'away', 'busy'].includes(f.presence) ? f.presence : 'offline';
          return h(
            'div',
            { class: 'list-item vc-invite-row' },
            h('div', { class: 'vc-face-wrap' }, personAvatar(f.avatar, f.name, 64, 'avatar'), h('span', { class: ['vc-presence', presence], 'aria-hidden': 'true' })),
            h('div', { class: 'li-main' }, h('div', { class: 'li-title', title: f.name }, f.name), h('div', { class: 'li-sub' }, t(`voice.presence_${presence}`))),
            btn,
          );
        }),
      );
    };
    draw();
    const inviteText = t('voice.inviteText', { name: room.name, code: room.code });
    const m = modal({
      title: t('voice.inviteTitle'),
      size: 'vc-invite-modal',
      body: h(
        'div',
        { class: 'stack' },
        h(
          'div',
          { class: 'vc-invite-code-box' },
          h('div', { class: 'vc-invite-code-main' }, h('div', { class: 'label' }, t('voice.roomCode')), h('div', { class: 'vc-big-code' }, room.code)),
          h('div', { class: 'vc-invite-code-actions' }, h('button', { class: 'btn sm', type: 'button', onclick: () => copyText(room.code, t('voice.codeCopied')) }, icon('copy'), t('voice.copyCode')), h('button', { class: 'btn sm', type: 'button', onclick: () => copyText(inviteText, t('voice.inviteCopied')) }, icon('share'), t('voice.copyInvite'))),
        ),
        room.hasPassword ? h('div', { class: 'vc-inline-hint' }, icon('key'), h('span', {}, t('voice.invitePasswordHint'))) : null,
        h('div', { class: 'label vc-invite-label' }, t('voice.inviteFriends')),
        box,
      ),
      footer: [h('button', { class: 'btn ghost', onclick: () => m.close() }, t('voice.close'))],
      onClose: () => offFriends?.(),
    });
    const offFriends = typeof social?.on === 'function' ? social.on('friends', draw) : null;
  }

  // ---------- Controles ----------
  function controls() {
    const make = (iconName, cls) => {
      const ic = h('span', { class: 'vc-ctl-icon' }, icon(iconName));
      const btn = h('button', { class: ['vc-ctl', cls], type: 'button' }, ic);
      return {
        btn,
        set(iconN, label, extra = {}) {
          if (btn.dataset.icon !== iconN) {
            btn.dataset.icon = iconN;
            mount(ic, icon(iconN));
          }
          btn.title = label;
          btn.setAttribute('aria-label', label);
          for (const [k, v] of Object.entries(extra)) btn.classList.toggle(k, Boolean(v));
        },
      };
    };
    const mic = make('mic', 'vc-ctl-mic');
    const deaf = make('headphones');
    const share = make('screenShare');
    const sound = make('audioLines');
    const chatBtn = make('message', 'vc-ctl-chat');
    const settings = make('sliders');
    const leave = make('phoneOff', 'vc-ctl-leave');
    mic.btn.addEventListener('click', () => voice.toggleMute());
    deaf.btn.addEventListener('click', () => voice.toggleDeafen());
    share.btn.addEventListener('click', async () => {
      if (voice.state.sharing) {
        voice.stopScreenShare();
        return;
      }
      if (voice.room?.demo) return;
      share.btn.disabled = true;
      try {
        await voice.startScreenShare();
      } catch (err) {
        fail(t('voice.shareFailed'), err);
      } finally {
        share.btn.disabled = false;
      }
    });
    sound.btn.addEventListener('click', () => setBoard(!boardOpen));
    chatBtn.btn.addEventListener('click', () => chat.focus());
    settings.btn.addEventListener('click', () => onTab?.('audio'));
    settings.set('sliders', t('voice.audioSettings'));
    chatBtn.set('message', t('voice.chatTitle'));
    leave.set('phoneOff', t('voice.leave'));
    leave.btn.addEventListener('click', async () => {
      leave.btn.disabled = true;
      await voice.leaveRoom();
    });
    const hint = h('div', { class: 'vc-hint', 'aria-live': 'polite' });
    const el = h('div', { class: 'vc-controls', role: 'toolbar', 'aria-label': t('voice.controlsLabel') }, h('div', { class: 'vc-ctl-row' }, mic.btn, deaf.btn, share.btn, sound.btn, chatBtn.btn, settings.btn, h('span', { class: 'vc-ctl-sep', 'aria-hidden': 'true' }), leave.btn), hint);
    let hintKey = '';
    function draw() {
      const st = voice.state;
      const off = st.muted || st.deafened || !st.hasMic;
      mic.set(off ? 'micOff' : 'mic', t(off ? 'voice.unmute' : 'voice.mute'), { off, live: st.transmitting, ptt: st.pushToTalk && !off });
      mic.btn.setAttribute('aria-pressed', String(off));
      deaf.set(st.deafened ? 'headphonesOff' : 'headphones', t(st.deafened ? 'voice.undeafen' : 'voice.deafen'), { off: st.deafened });
      deaf.btn.setAttribute('aria-pressed', String(st.deafened));
      share.set(st.sharing ? 'screenShareOff' : 'screenShare', t(st.sharing ? 'voice.stopSharing' : 'voice.shareScreen'), { on: st.sharing });
      share.btn.setAttribute('aria-pressed', String(st.sharing));
      sound.set('audioLines', t('voice.soundboard'), { on: boardOpen });
      sound.btn.setAttribute('aria-expanded', String(boardOpen));
      let key;
      let content;
      if (!st.hasMic) {
        key = `nomic|${st.micError}`;
        content = [h('span', { class: 'vc-hint-bad' }, icon('micOff'), t('voice.hintNoMic')), h('button', { class: 'btn ghost sm', type: 'button', onclick: () => onTab?.('audio') }, t('voice.chooseMic'))];
      } else if (st.talkingMuted) {
        key = 'tm';
        content = h('span', { class: 'vc-hint-bad' }, icon('micOff'), t('voice.hintTalkingMuted'));
      } else if (st.deafened) {
        key = 'deaf';
        content = h('span', { class: 'muted' }, t('voice.hintDeafened'));
      } else if (st.pushToTalk && !st.muted) {
        key = `ptt|${st.pttDown}|${st.pttKey}`;
        content = st.pttDown ? h('span', { class: 'vc-hint-live' }, h('span', { class: 'status-dot online', 'aria-hidden': 'true' }), t('voice.hintTransmitting')) : h('span', { class: 'muted' }, tSlot('voice.hintPtt', 'key', h('kbd', { class: 'kbd' }, keyLabel(st.pttKey))));
      } else {
        const parts = acceleratorParts(voice.settings.muteShortcut);
        key = `vad|${st.muted}|${parts.join('+')}`;
        content = h('span', { class: 'muted' }, t(st.muted ? 'voice.hintMuted' : 'voice.hintVad'), parts.length ? [h('span', { class: 'vc-dot-sep', 'aria-hidden': 'true' }, '·'), h('span', { class: 'vc-hint-keys' }, tSlot('voice.hintShortcut', 'keys', kbdKeys(parts)))] : null);
      }
      if (key !== hintKey) {
        hintKey = key;
        mount(hint, content);
      }
    }
    return {
      el,
      draw,
      focusSound() {
        sound.btn.focus();
      },
      level(levels) {
        mic.btn.style.setProperty('--lvl', levels.speaking ? Math.max(0.3, levels.self || 0).toFixed(2) : '0');
      },
    };
  }

  // ---------- Soundboard ----------
  function soundboard() {
    const btns = new Map();
    const grid2 = h('div', { class: 'vc-board-grid' });
    for (const s of voice.SOUNDS) {
      const b = h('button', { class: 'vc-sfx', type: 'button', title: t(`voice.sfx_${s.id}`) }, icon(s.icon), h('span', {}, t(`voice.sfx_${s.id}`)));
      b.addEventListener('click', () => {
        if (!voice.playSound(s.id)) {
          b.classList.remove('nope');
          void b.offsetWidth;
          b.classList.add('nope');
          return;
        }
        grid2.classList.remove('cooling');
        void grid2.offsetWidth;
        grid2.classList.add('cooling');
        flash(s.id);
      });
      btns.set(s.id, b);
      grid2.append(b);
    }
    grid2.addEventListener('animationend', (e) => {
      if (e.animationName === 'vc-cool') grid2.classList.remove('cooling');
    });
    const st = voice.settings;
    const volVal = h('span', { class: 'vc-pop-val' }, `${Math.round((st.soundboardVolume ?? 0.7) * 100)}%`);
    const vol = h('input', { type: 'range', class: 'range', min: 0, max: 100, step: 5, value: Math.round((st.soundboardVolume ?? 0.7) * 100), 'aria-label': t('voice.soundboardVolume') });
    vol.addEventListener('input', () => {
      volVal.textContent = `${vol.value}%`;
      vol.setAttribute('aria-valuetext', `${vol.value}%`);
    });
    vol.addEventListener('change', () => voice.saveSettings({ soundboardVolume: Number(vol.value) / 100 }));
    const el = h(
      'div',
      { class: 'vc-board', role: 'region', 'aria-label': t('voice.soundboard'), hidden: true },
      h('div', { class: 'vc-board-head' }, h('span', { class: 'vc-board-title' }, icon('audioLines'), t('voice.soundboard')), h('span', { class: 'vc-board-hint' }, t('voice.soundboardHint'))),
      grid2,
      h(
        'div',
        { class: 'vc-board-foot' },
        h('label', { class: 'vc-board-opt' }, switchEl(st.soundboardEnabled !== false, (v) => voice.saveSettings({ soundboardEnabled: v }), t('voice.hearOthersSounds')), h('span', {}, t('voice.hearOthersSounds'))),
        h('div', { class: 'vc-board-vol' }, icon('volume'), vol, volVal),
      ),
    );
    function flash(id) {
      const b = btns.get(id);
      if (!b) return;
      b.classList.remove('flash');
      void b.offsetWidth;
      b.classList.add('flash');
    }
    return {
      el,
      flash,
      show(on) {
        el.hidden = !on;
        // Al abrirlo con el teclado, el foco entra al primer sonido
        if (on && el.closest('.vc-controls')?.contains(document.activeElement)) grid2.querySelector('button')?.focus({ preventScroll: true });
      },
    };
  }

  // El soundboard flota sobre la barra de controles; Escape lo cierra
  const onBoardKey = (e) => {
    if (e.key === 'Escape' && boardOpen && !pop && !document.querySelector('.modal-backdrop')) {
      const inside = board.el.contains(document.activeElement);
      setBoard(false);
      if (inside) ctl.focusSound();
    }
  };
  function setBoard(open) {
    boardOpen = open;
    board.show(open);
    if (open) document.addEventListener('keydown', onBoardKey);
    else document.removeEventListener('keydown', onBoardKey);
    ctl.draw();
  }

  let chipTimer = null;
  function showSoundChip({ name, id }) {
    board.flash(id);
    mount(soundChip, icon('audioLines'), t('voice.soundPlayed', { name: name || t('voice.someone'), sound: t(`voice.sfx_${id}`) }));
    soundChip.classList.add('show');
    clearTimeout(chipTimer);
    chipTimer = setTimeout(() => soundChip.classList.remove('show'), 2200);
  }

  // ---------- Pantalla compartida ----------
  function drawScreens(force = false) {
    const list = voice.screens;
    const key = list.map((s) => `${s.userId}:${s.stream?.id}`).join(',') + `|${stageHidden}|${selectedScreen}`;
    if (!force && key === lastScreensKey) return;
    lastScreensKey = key;
    roomEl.classList.toggle('sharing', Boolean(list.length) && !stageHidden);
    if (!list.length) {
      stage.classList.add('hidden');
      showBar.classList.add('hidden');
      video.srcObject = null;
      stageHidden = false;
      return;
    }
    const cur = list.find((s) => s.userId === selectedScreen) || list.find((s) => !s.self) || list[0];
    selectedScreen = cur.userId;
    const label = cur.self ? t('voice.youAreSharing') : t('voice.sharingNow', { name: cur.name });
    if (stageHidden) {
      stage.classList.add('hidden');
      showBar.classList.remove('hidden');
      showBar.querySelector('.ellipsis').textContent = label;
      return;
    }
    showBar.classList.add('hidden');
    stage.classList.remove('hidden');
    stageLabel.textContent = label;
    stopShareBtn.classList.toggle('hidden', !voice.state.sharing);
    if (video.srcObject !== cur.stream) {
      video.srcObject = cur.stream;
      video.play().catch(() => {});
    }
    mount(
      stageChips,
      list.length > 1
        ? list.map((s) =>
            h(
              'button',
              {
                class: ['chip', s.userId === cur.userId && 'active'],
                type: 'button',
                'aria-pressed': String(s.userId === cur.userId),
                onclick: () => {
                  selectedScreen = s.userId;
                  drawScreens(true);
                },
              },
              s.self ? t('voice.you') : s.name,
            ),
          )
        : null,
    );
  }

  // ---------- Eventos ----------
  drawRoom();
  drawMembers(voice.members);
  ctl.draw();
  drawScreens(true);
  chat.drawAll();
  offs.push(
    voice.on('room', (room) => {
      if (!room) return;
      drawRoom();
      drawMembers(room.members);
    }),
    voice.on('members', (list) => drawMembers(list)),
    voice.on('state', () => {
      ctl.draw();
      drawRoom();
      drawScreens();
    }),
    voice.on('levels', onLevels),
    voice.on('screens', () => drawScreens()),
    voice.on('chat', (msg) => chat.onChat(msg)),
    voice.on('sound', showSoundChip),
  );
  const onSettings = () => ctl.draw();
  offs.push(voice.on('settings', onSettings));

  return () => {
    offs.forEach((off) => off());
    window.removeEventListener('resize', fit);
    document.removeEventListener('keydown', onBoardKey);
    closePop();
    clearTimeout(chipTimer);
    video.srcObject = null;
    if (document.fullscreenElement && stage.contains(document.fullscreenElement)) document.exitFullscreen().catch(() => {});
  };
}

// ---------- Chat de la sala ----------
function chatPanel() {
  const list = h('div', { class: 'vc-chat-list', role: 'log', 'aria-live': 'polite', 'aria-label': t('voice.chatTitle'), tabindex: 0 });
  const input = h('input', { class: 'input', maxlength: 500, placeholder: t('voice.chatPlaceholder'), 'aria-label': t('voice.chatPlaceholder') });
  const sendBtn = h('button', { class: 'icon-btn vc-send', type: 'button', title: t('voice.send'), 'aria-label': t('voice.send'), disabled: true }, icon('send'));
  const count = h('span', { class: 'vc-chat-count' });
  const el = h('section', { class: 'card vc-chat', 'aria-label': t('voice.chatTitle') }, h('div', { class: 'vc-chat-head' }, icon('message'), h('h2', { class: 'vc-chat-title' }, t('voice.chatTitle')), count), list, h('div', { class: 'vc-chat-input' }, input, sendBtn));
  let lastFrom = null;
  let lastTs = 0;
  let n = 0;
  let sending = false;
  const syncSend = () => (sendBtn.disabled = sending || !input.value.trim());
  input.addEventListener('input', syncSend);

  const empty = () =>
    h(
      'div',
      { class: 'vc-chat-empty' },
      h('span', { class: 'vc-chat-empty-icon', 'aria-hidden': 'true' }, icon('message')),
      h('div', { class: 'vc-chat-empty-title' }, t('voice.chatEmpty')),
      h('div', { class: 'vc-chat-empty-text' }, t('voice.chatEmptyHint')),
    );

  function nearBottom() {
    return list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  }

  function render(m) {
    if (m.system) {
      lastFrom = null;
      const text = t(m.system === 'join' ? 'voice.sysJoined' : 'voice.sysLeft', { name: m.name });
      return h('div', { class: ['vc-sys', m.system === 'join' ? 'join' : 'left'] }, icon(m.system === 'join' ? 'logIn' : 'logout'), h('span', { class: 'ellipsis', title: text }, text), h('time', { class: 'vc-time', datetime: isoOf(m.ts) }, fmtTime(m.ts)));
    }
    const grouped = lastFrom === m.from && m.ts - lastTs < 180000;
    lastFrom = m.from;
    lastTs = m.ts;
    n++;
    return h(
      'div',
      { class: ['vc-msg', m.self && 'mine', grouped && 'grouped', m.history && 'history'] },
      grouped ? h('span', { class: 'vc-msg-gap' }) : personAvatar(m.avatar, m.name, 64, 'vc-msg-avatar'),
      h(
        'div',
        { class: 'vc-msg-body' },
        grouped ? null : h('div', { class: 'vc-msg-head' }, h('span', { class: 'vc-msg-name', title: m.self ? null : m.name }, m.self ? t('voice.you') : m.name), h('time', { class: 'vc-time', datetime: isoOf(m.ts) }, fmtTime(m.ts))),
        h('div', { class: 'vc-msg-text selectable' }, m.text),
      ),
    );
  }

  function updateCount() {
    count.textContent = n ? t('voice.chatCount', { count: n }) : '';
  }

  function drawAll() {
    lastFrom = null;
    n = 0;
    const msgs = voice.chat;
    if (!msgs.length) mount(list, empty());
    else mount(list, msgs.map(render));
    updateCount();
    list.scrollTop = list.scrollHeight;
  }

  function onChat(msg) {
    if (!msg || msg.history) {
      drawAll();
      return;
    }
    const stick = nearBottom() || msg.self;
    list.querySelector('.vc-chat-empty')?.remove();
    list.append(render(msg));
    updateCount();
    if (stick) list.scrollTop = list.scrollHeight;
  }

  async function send() {
    const text = input.value;
    if (!text.trim() || sending) return;
    sending = true;
    syncSend();
    try {
      await voice.sendChat(text);
      if (input.value === text) input.value = '';
    } catch (err) {
      fail(t('voice.chatFailed'), err);
    } finally {
      sending = false;
      syncSend();
    }
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  sendBtn.addEventListener('click', send);
  return {
    el,
    drawAll,
    onChat,
    focus() {
      el.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
      input.focus({ preventScroll: true });
    },
  };
}
