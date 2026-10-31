// Piezas visuales del modulo social: punto de presencia, cabeza de Minecraft, insignias, tarjeta de perfil,
// el editor "Mi perfil" y las acciones sobre un amigo (unirse a su servidor, invitar a voz, quitar, bloquear).
// Se pueden usar desde cualquier pagina: cargan solas su hoja de estilos y sus textos.
import { h, icon, mount, modal, toast, ok, fail, confirmDialog, copyText, avatarImg, ensureCss, registerIcons, fmtAgo, fmtDate, fmtDuration, loaderBadge, instanceLoaderKey, switchEl, setBusy } from '../ui.js';
import { store } from '../store.js';
import { t, loadNs } from '../i18n.js';
import { social } from '../social.js';
import {
  BANNERS,
  parseBanner,
  encodeBanner,
  bannerBackground,
  bannerName,
  badgesOf,
  displayName,
  headId,
  isMcName,
  presenceLabel,
  activityLine,
  isJoinable,
  MY_STATUSES,
} from './cosmetics.js';

registerIcons({
  scCheckCheck: '<path d="M18 6 7 17l-5-5"/><path d="m22 10-7.5 7.5L13 16"/>',
  scReply: '<polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
  scSmilePlus: '<path d="M22 11v1a10 10 0 1 1-9-10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" x2="9.01" y1="9" y2="9"/><line x1="15" x2="15.01" y1="9" y2="9"/><path d="M16 5h6"/><path d="M19 2v6"/>',
  scUserMinus: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="22" x2="16" y1="11" y2="11"/>',
  scInbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  scArrowDown: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  scSend: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
});

// Hoja de estilos y textos del modulo (por si se abre una tarjeta fuera de la pagina de Mensajes).
export async function prepareSocialUi() {
  ensureCss('pages/messages');
  await loadNs('social');
}

// ---------- Piezas ----------
export function presenceDot(presence, cls = '') {
  const p = ['online', 'away', 'busy', 'offline', 'invisible'].includes(presence) ? presence : 'offline';
  const label = presenceLabel(p);
  return h('span', { class: ['sc-dot', p, cls], role: 'img', 'aria-label': label, title: label });
}

export function headImg(profile, size = 36, cls = '') {
  const img = avatarImg(headId(profile), size > 48 ? 128 : 64, ['sc-head', cls].filter(Boolean).join(' '));
  img.style.width = `${size}px`;
  img.style.height = `${size}px`;
  return img;
}

export function headWithDot(profile, presence, size = 36) {
  return h('span', { class: 'sc-headwrap', style: { width: `${size}px`, height: `${size}px` } }, headImg(profile, size), presence ? presenceDot(presence) : null);
}

export function badgeChips(profile, { compact = false, max = 8 } = {}) {
  const list = badgesOf(profile).slice(0, max);
  if (!list.length) return null;
  return h(
    'span',
    { class: ['sc-badges', compact && 'compact'] },
    list.map((b) =>
      h(
        'span',
        { class: 'sc-badge', title: b.label, 'aria-label': b.label, style: { '--c': b.color } },
        icon(b.icon),
        compact ? null : h('span', {}, b.label),
      ),
    ),
  );
}

function bannerEl(value, cls = 'sc-banner') {
  return h('div', { class: cls, style: { background: bannerBackground(value) } });
}

// Tarjeta visual del perfil (modal de perfil y vista previa del editor).
export function profileCard(profile, { presence = 'offline', statusText = '', self = false } = {}) {
  const name = displayName(profile) || t('social.someone');
  return h(
    'div',
    { class: 'sc-card' },
    bannerEl(profile?.banner, 'sc-card-banner'),
    h(
      'div',
      { class: 'sc-card-body' },
      h('div', { class: 'sc-card-head' }, headWithDot(profile, presence, 76)),
      h('div', { class: 'sc-card-names' }, h('div', { class: 'sc-card-name ellipsis' }, name), profile?.username ? h('div', { class: 'sc-card-user ellipsis' }, `@${profile.username}`) : null),
      badgeChips(profile),
      h(
        'div',
        { class: 'sc-card-status' },
        presenceDot(presence),
        h('span', { class: 'sc-card-presence' }, self && presence === 'invisible' ? t('social.presence_invisible') : presenceLabel(presence)),
        statusText ? h('span', { class: 'sc-card-statustext ellipsis', title: statusText }, statusText) : null,
      ),
    ),
  );
}

// Bloque "Jugando ahora" con boton Unirse.
export function activityBlock(friend, { onJoin } = {}) {
  const act = friend?.activity;
  if (!act) return null;
  const joinable = isJoinable(act);
  return h(
    'div',
    { class: 'sc-activity' },
    h('div', { class: 'sc-activity-icon' }, icon(act.type === 'server' ? 'server' : act.type === 'singleplayer' ? 'globe' : 'gamepad')),
    h(
      'div',
      { class: 'sc-activity-main' },
      h('div', { class: 'sc-activity-title' }, t('social.playingNow')),
      h('div', { class: 'sc-activity-line ellipsis', title: activityLine(act) }, activityLine(act)),
      h(
        'div',
        { class: 'sc-activity-meta' },
        act.loader ? loaderBadge(act.loader, act.mcVersion || null) : act.mcVersion ? h('span', { class: 'badge' }, act.mcVersion) : null,
        act.instanceName ? h('span', { class: 'sc-activity-inst ellipsis', title: act.instanceName }, act.instanceName) : null,
        act.since ? h('span', { class: 'sc-activity-since' }, t('social.playingFor', { time: fmtDuration(Date.now() - act.since) })) : null,
      ),
    ),
    // Unirme con el tinte de acento (igual que en Inicio y Multijugador): no compite con la accion principal
    joinable ? h('button', { class: 'btn tonal sm', type: 'button', onclick: () => (onJoin ? onJoin() : joinFriend(friend)) }, icon('play'), t('social.join')) : null,
  );
}

// ---------- Menu emergente sencillo ----------
let openMenuState = null;
export function popMenu(anchor, items) {
  if (openMenuState) {
    const same = openMenuState.anchor === anchor;
    openMenuState.close();
    if (same) return;
  }
  const list = items.filter(Boolean);
  const buttons = list.map((it) =>
    h(
      'button',
      {
        class: ['sc-menu-item', it.danger && 'danger', it.active && 'active'],
        type: 'button',
        role: it.active !== undefined ? 'menuitemradio' : 'menuitem',
        'aria-checked': it.active !== undefined ? String(Boolean(it.active)) : null,
        onclick: () => {
          close();
          it.run();
        },
      },
      it.icon ? (typeof it.icon === 'string' ? icon(it.icon) : it.icon) : null,
      h('span', {}, it.label),
      it.active ? icon('check', 'sc-menu-check') : null,
    ),
  );
  // Las acciones destructivas quedan separadas de las comunes
  const firstDanger = list.findIndex((it) => it.danger);
  const children = buttons.flatMap((b, i) => (i === firstDanger && i > 0 ? [h('div', { class: 'sc-menu-sep', role: 'separator' }), b] : [b]));
  const menu = h('div', { class: 'sc-menu', role: 'menu' }, children);
  document.body.append(menu);
  if (anchor.hasAttribute('aria-haspopup')) anchor.setAttribute('aria-expanded', 'true');
  const r = anchor.getBoundingClientRect();
  const mr = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(window.innerWidth - mr.width - 8, r.right - mr.width))}px`;
  const below = r.bottom + 6;
  menu.style.top = `${below + mr.height > window.innerHeight - 8 ? Math.max(8, r.top - mr.height - 6) : below}px`;
  const onDown = (e) => {
    if (!menu.contains(e.target) && !anchor.contains(e.target)) close();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      anchor.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const i = buttons.indexOf(document.activeElement);
      const next = buttons[(i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length];
      next?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      (e.key === 'Home' ? buttons[0] : buttons[buttons.length - 1])?.focus();
    } else if (e.key === 'Tab') {
      // Tab sale del menu (como en los menus del sistema) y lo cierra
      close();
    }
  };
  function close() {
    menu.remove();
    if (anchor.hasAttribute('aria-haspopup')) anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', close);
    if (openMenuState?.menu === menu) openMenuState = null;
  }
  setTimeout(() => {
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('resize', close);
  }, 0);
  document.addEventListener('keydown', onKey, true);
  buttons[0]?.focus();
  openMenuState = { menu, anchor, close };
}

// Elegir el estado propio (En linea / Ausente / No molestar / Invisible).
export function statusMenu(anchor) {
  const current = social.prefs().status;
  popMenu(
    anchor,
    MY_STATUSES.map((s) => ({
      label: presenceLabel(s),
      icon: presenceDot(s, 'sc-menu-dot'),
      active: current === s,
      run: () => social.setStatus(s).catch((err) => fail(t('social.saveFailed'), err)),
    })),
  );
}

// ---------- Acciones sobre un amigo ----------
export async function joinFriend(friend) {
  const act = friend?.activity;
  if (!isJoinable(act)) return;
  try {
    const { joinServer } = await import('../features/serverlist.js');
    // instancia local con la misma version y loader que la del amigo (si hay)
    const inst = store.instances.find((i) => i.mcVersion === act.mcVersion && (!act.loader || instanceLoaderKey(i) === act.loader));
    await joinServer(act.address, inst ? { instanceId: inst.id } : {});
  } catch (err) {
    fail(t('social.joinFailed'), err);
  }
}

export async function inviteToVoice(friend) {
  try {
    const { voice } = await import('../voice.js');
    if (typeof voice?.inviteFriend !== 'function') {
      toast('info', t('social.voiceUnavailable'), t('social.voiceUnavailableText'));
      return;
    }
    await voice.inviteFriend(friend.id);
    ok(t('social.voiceInvited', { name: friend.name }));
  } catch (err) {
    fail(t('social.voiceInviteFailed'), err);
  }
}

export async function confirmRemoveFriend(friend) {
  if (!(await confirmDialog(t('social.removeTitle'), t('social.removeConfirm', { name: friend.name }), { okText: t('social.remove'), danger: true }))) return false;
  try {
    await social.removeFriend(friend.id);
    ok(t('social.removed', { name: friend.name }));
    return true;
  } catch (err) {
    fail(t('social.actionFailed'), err);
    return false;
  }
}

export async function confirmBlock(user) {
  if (!(await confirmDialog(t('social.blockTitle'), t('social.blockConfirm', { name: user.name }), { okText: t('social.block'), danger: true }))) return false;
  try {
    await social.blockUser(user.id);
    ok(t('social.blocked', { name: user.name }));
    return true;
  } catch (err) {
    fail(t('social.actionFailed'), err);
    return false;
  }
}

// ---------- Perfil de otro usuario ----------
export async function openProfile(userId) {
  await prepareSocialUi();
  const friend = social.friendById(userId);
  const profile = social.profileOf(userId) || friend?.profile;
  if (!profile) return;
  const name = displayName(profile) || t('social.someone');
  const pres = friend ? social.presenceOf(userId) : { presence: 'offline', statusText: profile.status_text || '' };
  const incoming = social.requests.incoming.find((r) => r.id === userId);
  const outgoing = social.requests.outgoing.find((r) => r.id === userId);
  const isBlocked = social.blocked.some((b) => b.id === userId);
  const user = { id: userId, name };

  const act = (fn) => async () => {
    m.close();
    await fn();
  };
  const footer = [];
  if (friend) {
    footer.push(
      h('button', { class: 'icon-btn danger', type: 'button', title: t('social.block'), 'aria-label': t('social.block'), onclick: act(() => confirmBlock(user)) }, icon('ban')),
      h('button', { class: 'icon-btn danger', type: 'button', title: t('social.remove'), 'aria-label': t('social.remove'), onclick: act(() => confirmRemoveFriend(friend)) }, icon('scUserMinus')),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: act(() => inviteToVoice(friend)), disabled: friend.presence === 'offline', title: friend.presence === 'offline' ? t('social.friendOffline') : null }, icon('mic'), t('social.inviteVoice')),
      h('button', { class: 'btn primary', onclick: act(() => social.openChat(userId)) }, icon('message'), t('social.sendMessage')),
    );
  } else if (incoming) {
    footer.push(
      h('button', { class: 'btn ghost', onclick: act(() => social.declineRequest(userId).catch((e) => fail(t('social.actionFailed'), e))) }, icon('x'), t('social.decline')),
      h('button', { class: 'btn primary', onclick: act(() => social.acceptRequest(userId).then(() => ok(t('social.nowFriends', { name }))).catch((e) => fail(t('social.actionFailed'), e))) }, icon('check'), t('social.accept')),
    );
  } else if (outgoing) {
    footer.push(h('button', { class: 'btn ghost', onclick: act(() => social.cancelRequest(userId).catch((e) => fail(t('social.actionFailed'), e))) }, icon('x'), t('social.cancelRequest')));
  } else if (isBlocked) {
    footer.push(h('button', { class: 'btn', onclick: act(() => social.unblockUser(userId).catch((e) => fail(t('social.actionFailed'), e))) }, icon('check'), t('social.unblock')));
  }

  const m = modal({
    title: t('social.profileTitle', { name }),
    body: h(
      'div',
      { class: 'sc-profile' },
      profileCard(profile, { presence: friend ? pres.presence : 'offline', statusText: pres.statusText }),
      friend?.presence === 'offline' && friend.lastSeen ? h('div', { class: 'sc-lastseen' }, icon('clock'), t('social.lastSeen', { ago: fmtAgo(friend.lastSeen) })) : null,
      friend ? activityBlock(friend, { onJoin: act(() => joinFriend(friend)) }) : null,
      profile.bio ? h('div', { class: 'sc-section' }, h('div', { class: 'sc-section-label' }, t('social.about')), h('div', { class: 'sc-bio selectable' }, profile.bio)) : null,
      h(
        'div',
        { class: 'sc-facts' },
        friend?.since ? h('div', { class: 'sc-fact' }, icon('heart'), t('social.friendsSince', { date: fmtDate(friend.since) })) : null,
        profile.mc_name ? h('div', { class: 'sc-fact' }, icon('pickaxe'), t('social.mcName', { name: profile.mc_name })) : null,
        profile.friend_code
          ? h(
              'div',
              { class: 'sc-fact' },
              icon('hash'),
              h('span', { class: 'kbd selectable' }, profile.friend_code),
              h('button', { class: 'icon-btn sm', title: t('social.copyCode'), 'aria-label': t('social.copyCode'), onclick: () => copyText(profile.friend_code, t('social.codeCopied')) }, icon('copy')),
            )
          : null,
      ),
    ),
    footer: footer.length ? footer : null,
  });
  return m;
}

// ---------- Mi perfil (editor) ----------
export async function openMyProfile() {
  await prepareSocialUi();
  const me = social.me;
  if (!me) {
    fail(t('social.profileMissing'), t('social.profileMissingHelp'));
    return;
  }
  const prefs = social.prefs();
  const draft = {
    display_name: me.display_name || '',
    status_text: me.status_text || '',
    bio: me.bio || '',
    mc_name: me.mc_name || '',
    mc_uuid: me.mc_uuid || null,
    banner: me.banner || 'venus',
    status: prefs.status,
    shareActivity: prefs.shareActivity,
    autoAway: prefs.autoAway,
    notifications: prefs.notifications,
  };

  const preview = h('div', { class: 'sc-editor-preview' });
  const drawPreview = () =>
    mount(
      preview,
      profileCard(
        { ...me, display_name: draft.display_name.trim() || null, status_text: draft.status_text, banner: draft.banner, mc_name: draft.mc_name.trim() || null, mc_uuid: draft.mc_uuid },
        { presence: draft.status, statusText: draft.status_text.trim(), self: true },
      ),
    );

  // Campo con etiqueta enlazada (los controles que no son de texto usan un rotulo + aria-labelledby)
  let seq = 0;
  const field = (label, control, hint, extra = null) => {
    const id = `sc-ed-${++seq}`;
    const isText = ['INPUT', 'TEXTAREA', 'SELECT'].includes(control.tagName);
    if (isText) control.id = id;
    else control.setAttribute('aria-labelledby', `${id}-l`);
    const hintId = hint ? `${id}-h` : null;
    if (hintId) control.setAttribute('aria-describedby', hintId);
    return h('div', { class: 'field' }, isText ? h('label', { for: id }, label) : h('span', { class: 'label', id: `${id}-l` }, label), control, extra, hint ? h('div', { class: 'field-help', id: hintId }, hint) : null);
  };
  const input = (key, max, placeholder) => {
    const el = h('input', { class: 'input', value: draft[key], maxlength: max, placeholder });
    el.addEventListener('input', () => {
      draft[key] = el.value;
      if (key === 'mc_name') draft.mc_uuid = null;
      drawPreview();
    });
    return el;
  };

  const nameInput = input('display_name', 32, me.username);
  const statusTextInput = input('status_text', 80, t('social.statusTextPlaceholder'));
  const mcInput = input('mc_name', 16, 'Steve');
  const mcError = h('div', { class: 'field-error sc-field-error', id: 'sc-mc-error', role: 'alert', hidden: true });
  const setMcError = (text) => {
    mcError.hidden = !text;
    mount(mcError, text ? [icon('alert'), h('span', {}, text)] : []);
    if (text) mcInput.setAttribute('aria-invalid', 'true');
    else mcInput.removeAttribute('aria-invalid');
  };
  mcInput.addEventListener('input', () => setMcError(''));
  // Se valida al salir del campo, no en cada tecla
  mcInput.addEventListener('blur', () => {
    const v = mcInput.value.trim();
    if (v && !isMcName(v)) setMcError(t('social.mcNameInvalid'));
  });
  const bioInput = h('textarea', { class: 'textarea', maxlength: 200, rows: 3, placeholder: t('social.bioPlaceholder') }, draft.bio);
  bioInput.addEventListener('input', () => (draft.bio = bioInput.value));

  const acc = store.selectedAccount();
  const useAccount = acc
    ? h(
        'button',
        {
          class: 'btn sm ghost',
          type: 'button',
          onclick: () => {
            mcInput.value = acc.name;
            draft.mc_name = acc.name;
            draft.mc_uuid = acc.type === 'msa' && acc.uuid ? acc.uuid : null;
            drawPreview();
          },
        },
        icon('user'),
        t('social.useAccount', { name: acc.name }),
      )
    : null;

  // Estado
  const statusSeg = h('div', { class: 'segmented sc-status-seg', role: 'radiogroup', 'aria-label': t('social.status') });
  const drawStatus = () =>
    mount(
      statusSeg,
      MY_STATUSES.map((s) =>
        h(
          'button',
          {
            type: 'button',
            role: 'radio',
            'aria-checked': String(draft.status === s),
            class: draft.status === s ? 'active' : '',
            onclick: () => {
              draft.status = s;
              drawStatus();
              drawPreview();
            },
          },
          presenceDot(s),
          presenceLabel(s),
        ),
      ),
    );

  // Banner
  const parsed = parseBanner(draft.banner);
  const custom = { colors: parsed.kind === 'preset' ? ['#f29a2e', '#3b1450'] : [...parsed.colors] };
  const colorA = h('input', { type: 'color', class: 'sc-color', value: custom.colors[0], 'aria-label': t('social.bannerColorA') });
  const colorB = h('input', { type: 'color', class: 'sc-color', value: custom.colors[1], 'aria-label': t('social.bannerColorB') });
  const applyCustom = () => {
    custom.colors = [colorA.value, colorB.value];
    draft.banner = encodeBanner({ kind: colorA.value === colorB.value ? 'solid' : 'gradient', colors: custom.colors });
    drawBanners();
    drawPreview();
  };
  colorA.addEventListener('input', applyCustom);
  colorB.addEventListener('input', applyCustom);
  const bannerGrid = h('div', { class: 'sc-swatches', role: 'radiogroup', 'aria-label': t('social.banner') });
  const drawBanners = () => {
    const cur = parseBanner(draft.banner);
    mount(
      bannerGrid,
      BANNERS.map((b) =>
        h('button', {
          type: 'button',
          role: 'radio',
          'aria-checked': String(cur.kind === 'preset' && cur.id === b.id),
          class: ['sc-swatch', cur.kind === 'preset' && cur.id === b.id && 'active'],
          title: bannerName(b.id),
          'aria-label': bannerName(b.id),
          style: { background: bannerBackground(b.id) },
          onclick: () => {
            draft.banner = b.id;
            drawBanners();
            drawPreview();
          },
        }),
      ),
      h(
        'div',
        { class: ['sc-swatch-custom', cur.kind !== 'preset' && 'active'], title: t('social.bannerCustom') },
        colorA,
        colorB,
      ),
    );
  };

  const codeBox = h(
    'div',
    { class: 'sc-code' },
    h('span', { class: 'sc-code-value selectable' }, me.friend_code || '—'),
    me.friend_code ? h('button', { class: 'icon-btn sm', type: 'button', title: t('social.copyCode'), 'aria-label': t('social.copyCode'), onclick: () => copyText(me.friend_code, t('social.codeCopied')) }, icon('copy')) : null,
  );

  const toggle = (key, title, sub) =>
    h(
      'div',
      { class: 'toggle-row' },
      h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, title), h('div', { class: 'tr-sub' }, sub)),
      switchEl(Boolean(draft[key]), (v) => (draft[key] = v), title),
    );

  drawPreview();
  drawStatus();
  drawBanners();

  const saveBtn = h('button', { class: 'btn primary', type: 'button' }, icon('save'), t('social.save'));
  const m = modal({
    title: t('social.myProfile'),
    size: 'wide',
    body: h(
      'div',
      { class: 'sc-editor' },
      h(
        'div',
        { class: 'sc-editor-side' },
        preview,
        h('div', { class: 'sc-section-label' }, t('social.yourCode')),
        codeBox,
        h('div', { class: 'field-help sc-code-hint' }, t('social.yourCodeHint')),
      ),
      h(
        'div',
        { class: 'sc-editor-form' },
        field(t('social.displayName'), nameInput),
        field(t('social.status'), statusSeg, t('social.statusHint')),
        field(t('social.statusText'), statusTextInput),
        mcField(),
        field(t('social.bio'), bioInput),
        field(t('social.banner'), bannerGrid),
        h('div', { class: 'sc-section-label' }, t('social.privacy')),
        h(
          'div',
          { class: 'sc-toggles' },
          toggle('shareActivity', t('social.shareActivity'), t('social.shareActivityHint')),
          toggle('autoAway', t('social.autoAway'), t('social.autoAwayHint')),
          toggle('notifications', t('social.notifications'), t('social.notificationsHint')),
        ),
      ),
    ),
    footer: [h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, t('social.cancel')), saveBtn],
  });

  // Nombre de Minecraft: campo + "Usar mi cuenta" en la misma fila, ayuda y error debajo
  function mcField() {
    mcInput.id = 'sc-mc-name';
    mcInput.setAttribute('aria-describedby', 'sc-mc-hint');
    return h(
      'div',
      { class: 'field' },
      h('label', { for: 'sc-mc-name' }, t('social.mcNameLabel')),
      h('div', { class: 'sc-mc-row' }, mcInput, useAccount),
      mcError,
      h('div', { class: 'field-help', id: 'sc-mc-hint' }, t('social.mcNameHint')),
    );
  }

  saveBtn.addEventListener('click', async () => {
    const mc = draft.mc_name.trim();
    if (mc && !isMcName(mc)) {
      setMcError(t('social.mcNameInvalid'));
      mcInput.focus();
      return;
    }
    setMcError('');
    const next = {
      display_name: draft.display_name.trim() || null,
      status_text: draft.status_text.trim() || null,
      bio: draft.bio.trim() || null,
      mc_name: mc || null,
      mc_uuid: mc ? draft.mc_uuid : null,
      banner: draft.banner,
    };
    const patch = {};
    for (const [k, v] of Object.entries(next)) if ((me[k] ?? null) !== v) patch[k] = v;
    const release = setBusy(saveBtn);
    try {
      if (Object.keys(patch).length) await social.updateProfile(patch);
      const p = social.prefs();
      if (p.status !== draft.status || p.shareActivity !== draft.shareActivity || p.autoAway !== draft.autoAway || p.notifications !== draft.notifications) {
        await social.setPrefs({ status: draft.status, shareActivity: draft.shareActivity, autoAway: draft.autoAway, notifications: draft.notifications });
      }
      m.close();
      ok(t('social.profileSaved'));
    } catch (err) {
      fail(t('social.saveFailed'), err);
    } finally {
      release();
    }
  });
  setTimeout(() => nameInput.focus(), 40);
  return m;
}
