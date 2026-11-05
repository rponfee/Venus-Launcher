// Comunidades: la pantalla de una comunidad. Canales fijos a la izquierda (de texto y de voz, con quién está en cada uno),
// el chat del canal elegido en el medio y los miembros a la derecha. Los canales de voz abren una sala del Voice Chat de
// siempre (community_voice_room la crea a pedido y la reutiliza) y navegan a #/voice.
import { h, icon, mount, skeleton, emptyState, setBusy, ok, fail, confirmDialog, modal } from '../../ui.js';
import { t, loadNs } from '../../i18n.js';
import { navigate } from '../../app.js';
import { errText } from '../../features/communities/backend.js';
import { openGroupReport } from '../../features/communities/report.js';
import { headImg, openProfile, popMenu } from '../../social/profile-ui.js';
import { COMMUNITY_LIMITS } from '../../features/communities/logic.js';
import { rolesOf, roleColor } from '../../features/communities/permissions.js';
import { communityColor, canAssignRole, canModerate, isMuted, isStaff, MUTE_OPTIONS, personName, pickChannel, voiceSummary, categoryGroups, visibleChannels, channelIcon, safeCommunityIcon, iconGlyph, safeBanner, safeTheme, CATEGORY_LIMIT } from './logic.js';
import { chatView } from './chat.js';
import { forumView } from './forum.js';
import { openAppearanceForm, openChannelForm, openCategoryForm, channelMenuItems } from './manage.js';
import { openBansDialog, openChannelsDialog, openCommunityForm, openInviteDialog } from './forms.js';
import { openGreetingsDialog } from './greetings.js';
import { openRolesDialog, openMemberRolesDialog } from './roles.js';
import { openMediaGallery } from './gallery.js';

const C = (key, vars) => t(`communities.${key}`, vars);
const REFRESH_MS = 20000;

function muteLabel(minutes) {
  return minutes < 60 ? C('muteMinutes', { n: minutes }) : minutes < 1440 ? C('muteHours', { count: minutes / 60 }) : C('muteDays', { count: minutes / 1440 });
}

function previewFor(community, { b, onJoined }) {
  const join = h('button', { class: 'btn primary', type: 'button', disabled: community.bannedHere ? true : null }, icon('logIn'), C('communityJoin'));
  join.addEventListener('click', async () => {
    const done = setBusy(join);
    try {
      await b.rpc('community_join', { p_community: community.id });
      ok(C('communityJoined', { name: community.name }));
      onJoined();
    } catch (err) {
      fail(C('actionError'), errText(err));
    } finally {
      done();
    }
  });
  return h('section', { class: 'card cl-card cm-preview', style: { '--cm-color': communityColor(community.color) }, dataset: { banner: safeBanner(community.banner) } },
    h('h2', { class: 'card-title' }, icon(iconGlyph(safeCommunityIcon(community.icon))), community.name),
    community.description ? h('p', { class: 'cl-desc selectable' }, community.description) : null,
    h('div', { class: 'cl-chips' }, h('span', { class: 'badge' }, icon('users'), C('membersCount', { n: community.memberCount ?? 0, max: community.maxMembers ?? 500 }))),
    community.bannedHere ? h('p', { class: 'cl-note' }, icon('ban'), h('span', {}, C('err_banned_here'))) : null,
    h('div', { class: 'row wrap' }, join, h('button', { class: 'icon-btn', type: 'button', title: C('report'), 'aria-label': C('report'), onclick: () => openGroupReport({ kind: 'community', id: community.id, name: community.name }) }, icon('alert'))));
}

/** Dibuja la comunidad en root. Devuelve la función que la cierra. */
export function communityView(root, id, wantedChannel, { b }) {
  let community = null;
  let chat = null;
  let channelId = wantedChannel || null;
  let destroyed = false;
  let request = 0;
  const people = new Map();
  let members = [];
  let total = 0;
  const side = h('aside', { class: 'cm-side', 'aria-label': C('channelsLabel') });
  const chatHost = h('section', { class: 'cm-chat card' });
  const memberHost = h('aside', { class: 'cm-members', 'aria-label': C('membersTitle') });
  const layout = h('div', { class: 'cm-layout' }, side, chatHost, memberHost);
  const back = h('button', { class: 'btn sm ghost cl-back', type: 'button', onclick: () => navigate('communities') }, icon('arrowLeft'), C('backToCommunities'));

  async function fetchCommunity() {
    if (destroyed) return false;
    const current = ++request;
    try {
      const next = await b.rpc('community_get', { p_community: id });
      if (destroyed || current !== request) return false;
      community = next;
      return true;
    } catch (err) {
      if (destroyed || current !== request) return false;
      throw err;
    }
  }
  function closeChat() {
    chat?.destroy();
    chat = null;
  }
  function clearMembership() {
    closeChat();
    people.clear();
    members = [];
    total = 0;
    channelId = null;
    route();
    root.classList.remove('cm-fill');
  }
  async function fetchMembers({ more = false } = {}) {
    try {
      const res = await b.rpc('community_members_list', { p_community: id, p_offset: more ? members.length : 0 });
      if (destroyed || !community?.myRole) return;
      const rows = Array.isArray(res?.members) ? res.members.filter(Boolean) : [];
      members = more ? [...members, ...rows.filter((m) => !members.some((x) => x.userId === m.userId))] : rows;
      total = Number(res?.total) || members.length;
      for (const m of members) people.set(m.userId, m);
    } catch (err) {
      console.warn('[communities] miembros:', err?.message || err);
    }
  }
  async function refresh() {
    try {
      if (!(await fetchCommunity())) return community;
    } catch (err) {
      // Un fallo de red conserva la vista. Si ya no tiene acceso, se cierra también la suscripción del chat.
      if (!['not_found', 'not_member', 'user_banned', 'noSession'].includes(err?.code)) throw err;
      clearMembership();
      community = null;
      mount(root, back, emptyState('users', C('communityGone'), errText(err)));
      return null;
    }
    if (!community.myRole) {
      clearMembership();
      mount(root, back, previewFor(community, { b, onJoined: start }));
      return community;
    }
    const ch = pickChannel(visibleChannels(community), channelId);
    if (ch && (!chat || ch.id !== channelId)) openChannel(ch);
    else if (ch) {
      drawSide();
      chat.setCommunity(community, ch);
    } else {
      closeChat();
      channelId = null;
      route();
      drawSide();
      emptyChannel();
    }
    return community;
  }

  const route = () => {
    try {
      history.replaceState(null, '', `#/communities/${encodeURIComponent(id)}${channelId ? `/${encodeURIComponent(channelId)}` : ''}`);
    } catch {
      /* sin historial */
    }
  };

  function openChannel(ch) {
    if (destroyed || !visibleChannels(community).some((c) => c.id === ch.id)) return;
    channelId = ch.id;
    route();
    closeChat();
    chat = (ch.kind === 'forum' ? forumView : chatView)(chatHost, { b, community, channel: ch, people, onPerson: () => {} });
    drawSide();
  }

  async function enterVoice(ch, btn) {
    if (btn.disabled || destroyed) return;
    const done = setBusy(btn);
    try {
      await loadNs('voice');
      const room = await b.rpc('community_voice_room', { p_channel: ch.id });
      if (destroyed) return;
      if (!b.fake) {
        const { voice } = await import('../../voice.js');
        await voice.joinRoom(room.code);
      }
      // Sin el permiso de hablar el servidor no entrega tu clave de sesión: escuchás, pero no te oyen.
      if (room?.canSpeak === false) ok(C('voiceListenOnly'), C('voiceListenOnlyText'));
      if (!destroyed) navigate('voice');
    } catch (err) {
      fail(C('voiceFailed'), err?.name === 'GroupError' ? errText(err) : err?.message || errText(err));
    } finally {
      done();
    }
  }

  function headerMenu(anchor) {
    const role = community.myRole;
    popMenu(anchor, [
      isStaff(role) ? { icon: 'userPlus', label: C('menuInvite'), run: () => openInviteDialog(b, community, { reload: refresh }) } : null,
      isStaff(role) ? { icon: 'hash', label: C('menuChannels'), run: () => openChannelsDialog(b, community, { reload: refresh }) } : null,
      isStaff(role) ? { icon: 'ban', label: C('menuBans'), run: () => openBansDialog(b, community) } : null,
      role === 'owner' ? { icon: 'palette', label: C('cmCustomize'), run: () => openAppearanceForm(b, community, { reload: refresh }) } : null,
      role === 'owner' ? { icon: 'logIn', label: C('menuGreetings'), run: () => openGreetingsDialog(b, community, { reload: refresh }) } : null,
      role === 'owner' ? { icon: 'tag', label: C('menuRoles'), run: () => openRolesDialog(b, community, { reload: refresh }) } : null,
      isStaff(role) ? { icon: 'image', label: C('menuGallery'), run: () => openMediaGallery(b, community) } : null,
      role === 'owner' ? { icon: 'edit', label: C('menuEdit'), run: () => openCommunityForm(b, { community, onSaved: refresh }) } : null,
      role !== 'owner' ? { icon: 'alert', label: C('report'), run: () => openGroupReport({ kind: 'community', id, name: community.name }) } : null,
      role === 'owner' && total > 1 ? null : { icon: 'logout', label: C('leave'), danger: true, run: leave },
      role === 'owner' ? { icon: 'trash', label: C('communityDelete'), danger: true, run: remove } : null,
    ]);
  }
  async function leave() {
    const last = total <= 1;
    if (!(await confirmDialog(C('communityLeaveTitle'), last ? C('communityLeaveLast') : C('communityLeaveText', { name: community.name }), { okText: C('leave'), danger: true }))) return;
    try {
      await b.rpc('community_leave', { p_community: id });
      navigate('communities');
    } catch (err) {
      fail(C('actionError'), errText(err));
    }
  }
  async function remove() {
    if (!(await confirmDialog(C('communityDelete'), C('communityDeleteText', { name: community.name }), { okText: C('delete'), danger: true }))) return;
    try {
      await b.rpc('community_delete', { p_community: id });
      navigate('communities');
    } catch (err) {
      fail(C('actionError'), errText(err));
    }
  }

  function channelRow(ch) {
    const sum = voiceSummary(ch.people);
    const staff = isStaff(community.myRole);
    const openMenu = (anchor) => { if (!destroyed && isStaff(community.myRole)) popMenu(anchor, channelMenuItems(b, community, ch, refresh)); };
    const menu = staff ? h('button', { class: 'icon-btn sm cm-channel-menu', type: 'button', title: C('cmChannelActions', { name: ch.name }), 'aria-label': C('cmChannelActions', { name: ch.name }), 'aria-haspopup': 'menu', onclick: (e) => openMenu(e.currentTarget) }, icon('more')) : null;
    const noVoice = ch.kind === 'voice' && ch.canConnect === false;
    const button = h('button', { class: ['cm-channel', ch.id === channelId && 'active', noVoice && 'is-locked'], type: 'button',
      title: noVoice ? C('voiceNoPermission') : C('cmKind_' + ch.kind) + (ch.topic ? ' · ' + ch.topic : ''), 'aria-current': ch.id === channelId ? 'true' : null, 'aria-disabled': noVoice ? 'true' : null },
      icon(channelIcon(ch)), h('span', { class: 'ellipsis' }, ch.name),
      ch.isPrivate ? h('span', { title: C('cmPrivate'), 'aria-label': C('cmPrivate') }, icon('lock')) : null,
      noVoice ? h('span', { title: C('voiceNoPermission'), 'aria-label': C('voiceNoPermission') }, icon('shield')) : null,
      ch.kind === 'voice' && sum.count ? h('span', { class: 'cm-channel-count' }, String(sum.count)) : null);
    button.addEventListener('click', () => {
      if (noVoice) return fail(C('voiceFailed'), C('err_voice_forbidden'));
      return ch.kind === 'voice' ? enterVoice(ch, button) : openChannel(ch);
    });
    const row = h('li', {}, h('div', { class: 'cm-channel-row' }, button, menu),
      ch.kind === 'voice' && sum.count ? h('ul', { class: 'cm-voice-people' }, sum.shown.map((p) => h('li', {}, headImg(p, 18, 'cl-head'), h('span', { class: 'ellipsis' }, personName(p) || C('someone')))), sum.extra ? h('li', { class: 'cl-muted small' }, C('voiceMore', { n: sum.extra })) : null) : null);
    if (staff) {
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); openMenu(menu); });
      button.addEventListener('keydown', (e) => { if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); openMenu(menu); } });
    }
    return row;
  }
  function showAbout() {
    modal({ title: community.name, icon: iconGlyph(safeCommunityIcon(community.icon)), body: h('div', { class: 'stack cm-about' },
      community.description ? h('p', { class: 'cm-prose selectable' }, community.description) : null,
      h('h4', {}, C('cmWelcome')), h('p', { class: 'cm-prose selectable' }, community.welcome || C('cmNoWelcome')),
      h('h4', {}, C('cmRules')), h('p', { class: 'cm-prose selectable' }, community.rules || C('cmNoRules'))) });
  }
  function emptyChannel() {
    mount(chatHost, emptyState('hash', C('chatNoChannel'), '',
      isStaff(community.myRole) ? h('button', { class: 'btn primary', type: 'button', onclick: () => openChannelForm(b, community, { reload: refresh }) }, icon('plus'), C('cmChannelCreate')) : null));
  }
  function drawSide() {
    if (destroyed || !community?.myRole) return;
    const staff = isStaff(community.myRole);
    const full = (community.channels || []).length >= (community.maxChannels || COMMUNITY_LIMITS.channels);
    const groups = categoryGroups(community);
    side.setAttribute('style', '--cm-color:' + communityColor(community.color));
    layout.dataset.theme = safeTheme(community.theme);
    mount(side,
      h('div', { class: 'cm-community-cover', dataset: { banner: safeBanner(community.banner) } },
        h('span', { class: 'cm-community-symbol', 'aria-hidden': 'true' }, icon(iconGlyph(safeCommunityIcon(community.icon))))),
      h('div', { class: 'cm-side-head' },
        h('strong', { class: 'cm-side-name ellipsis', title: community.name }, community.name),
        h('button', { class: 'icon-btn sm', type: 'button', title: C('communityMenu'), 'aria-label': C('communityMenu'), 'aria-haspopup': 'menu', onclick: (e) => headerMenu(e.currentTarget) }, icon('more'))),
      community.welcome ? h('p', { class: 'cm-welcome-preview' }, community.welcome) : null,
      h('button', { class: 'btn sm ghost cm-about-button', type: 'button', onclick: showAbout }, icon('info'), C('cmAbout')),
      staff ? h('div', { class: 'cm-side-actions' },
        h('button', { class: 'btn primary sm cm-add-channel', type: 'button', disabled: full, onclick: () => openChannelForm(b, community, { reload: refresh }) }, icon('plus'), C('cmChannelCreate')),
        h('button', { class: 'icon-btn sm cm-add-category', type: 'button', disabled: (community.categories || []).length >= CATEGORY_LIMIT, title: C('cmCategoryCreate'), 'aria-label': C('cmCategoryCreate'), onclick: () => openCategoryForm(b, community, { reload: refresh }) }, icon('folder')),
        h('button', { class: 'icon-btn sm', type: 'button', title: C('cmManageChannels'), 'aria-label': C('cmManageChannels'), onclick: () => openChannelsDialog(b, community, { reload: refresh }) }, icon('settings'))) : null,
      community.myRole === 'owner' ? h('button', { class: 'btn sm ghost cm-customize', type: 'button', onclick: () => openAppearanceForm(b, community, { reload: refresh }) }, icon('palette'), C('cmCustomize')) : null,
      h('div', { class: 'cm-side-scroll' }, groups.filter((g) => g.id || g.channels.length || staff).map((g) =>
        h('section', { class: 'cm-category' },
          h('div', { class: 'cm-category-head' }, h('h3', { class: 'cm-side-title ellipsis', title: g.name || C('cmUncategorized') }, g.name || C('cmUncategorized')),
            staff ? h('button', { class: 'icon-btn sm', type: 'button', disabled: full, title: C('cmChannelCreate'), 'aria-label': C('cmChannelCreate'), onclick: () => openChannelForm(b, community, { categoryId: g.id, reload: refresh }) }, icon('plus')) : null),
          h('ul', { class: 'cm-channels' }, g.channels.map(channelRow)))),
        h('p', { class: 'cl-muted small cm-side-empty' }, C('voiceHint'))));
  }

  function memberRow(m) {
    const me = b.userId();
    const self = m.userId === me;
    const name = personName(m) || C('someone');
    const act = (fn, okText) => async () => {
      try {
        await fn();
        if (okText) ok(okText);
        await fetchMembers();
        drawMembers();
      } catch (err) {
        fail(C('actionError'), errText(err));
      }
    };
    const role = community.myRole;
    const muted = isMuted(m.mutedUntil);
    const items = [
      { icon: 'user', label: C('viewProfile', { name }), run: () => openProfile(m.userId) },
      canAssignRole(role, m.role) ? { icon: 'tag', label: C('memberRolesMenu'), run: () => openMemberRolesDialog(b, community, m, { reload: async () => { await fetchMembers(); drawMembers(); return refresh(); } }) } : null,
      role === 'owner' && !self && m.role !== 'owner' ? { icon: m.role === 'member' ? 'upCircle' : 'user', label: m.role === 'member' ? C('makeModerator') : C('removeModerator'), run: act(() => b.rpc('community_set_role', { p_community: id, p_user: m.userId, p_role: m.role === 'member' ? 'moderator' : 'member' }), C('roleChanged')) } : null,
      role === 'owner' && !self && m.role !== 'owner' ? { icon: 'crown', label: C('communityTransfer'), run: async () => {
        if (await confirmDialog(C('communityTransferTitle'), C('communityTransferText', { name }), { okText: C('communityTransfer') })) act(async () => {
          await b.rpc('community_transfer', { p_community: id, p_user: m.userId });
          await refresh();
        }, C('transferred', { name }))();
      } } : null,
      canModerate(role, m.role, { self }) && muted ? { icon: 'volume', label: C('unmute'), run: act(() => b.rpc('community_mute', { p_community: id, p_user: m.userId, p_minutes: 0 }), C('unmuted', { name })) } : null,
      ...(canModerate(role, m.role, { self }) && !muted ? MUTE_OPTIONS.map((min) => ({ icon: 'volumeX', label: C('muteFor', { time: muteLabel(min) }), run: act(() => b.rpc('community_mute', { p_community: id, p_user: m.userId, p_minutes: min }), C('muted', { name })) })) : []),
      canModerate(role, m.role, { self }) ? { icon: 'ban', label: C('kick'), danger: true, run: async () => {
        if (await confirmDialog(C('kickTitle'), C('communityKickText', { name }), { okText: C('kick'), danger: true })) act(() => b.rpc('community_kick', { p_community: id, p_user: m.userId }), C('kicked', { name }))();
      } } : null,
    ].filter(Boolean);
    return h('li', {},
      h('button', { class: 'cm-member', type: 'button', 'aria-haspopup': 'menu', onclick: (e) => popMenu(e.currentTarget, items) },
        headImg(m, 28, 'cl-head'),
        h('span', { class: 'cm-member-name ellipsis' }, name),
        rolesOf(community, m.roleIds).slice(0, 3).map((r) => h('span', { class: 'cm-role-dot', title: r.name, 'aria-label': r.name, style: { background: roleColor(r.color) } })),
        m.role !== 'member' ? h('span', { class: 'cm-role', title: C(`role_${m.role}`), 'aria-label': C(`role_${m.role}`) }, icon(m.role === 'owner' ? 'crown' : 'shield')) : null,
        muted ? h('span', { class: 'cm-role is-muted', title: C('mutedBadge'), 'aria-label': C('mutedBadge') }, icon('volumeX')) : null));
  }
  function drawMembers() {
    if (destroyed) return;
    mount(memberHost,
      h('div', { class: 'cm-side-head' }, h('strong', {}, C('membersTotal', { n: total }))),
      h('ul', { class: 'cm-channels cm-side-scroll' }, members.map(memberRow)),
      total > members.length ? h('button', { class: 'btn sm ghost cm-more', type: 'button', onclick: async (e) => {
        const done = setBusy(e.currentTarget);
        await fetchMembers({ more: true });
        done();
        drawMembers();
      } }, C('membersMore', { n: total - members.length })) : null);
  }

  async function start() {
    mount(root, back, skeleton('card', { lines: 6 }));
    try {
      if (!(await fetchCommunity())) return;
    } catch (err) {
      if (destroyed) return;
      mount(root, back, err?.code === 'not_found' ? emptyState('users', C('communityGone'), C('communityGoneText')) : emptyState('alert', errText(err), '', h('button', { class: 'btn', type: 'button', onclick: start }, icon('refresh'), C('retry'))));
      return;
    }
    if (destroyed) return;
    if (!community.myRole) {
      mount(root, back, previewFor(community, { b, onJoined: start }));
      return;
    }
    await fetchMembers();
    if (destroyed || !community?.myRole) return;
    root.classList.add('cm-fill');
    mount(root, back, layout);
    drawMembers();
    const ch = pickChannel(visibleChannels(community), channelId);
    if (ch) openChannel(ch);
    else {
      drawSide();
      emptyChannel();
    }
  }
  start();
  const timer = setInterval(() => {
    if (!destroyed && community?.myRole && document.visibilityState === 'visible') refresh().catch(() => {});
  }, REFRESH_MS);
  return () => {
    destroyed = true;
    clearInterval(timer);
    closeChat();
  };
}
