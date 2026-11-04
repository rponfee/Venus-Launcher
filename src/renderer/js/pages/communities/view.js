// Comunidades: la pantalla de una comunidad. Canales fijos a la izquierda (de texto y de voz, con quién está en cada uno),
// el chat del canal elegido en el medio y los miembros a la derecha. Los canales de voz abren una sala del Voice Chat de
// siempre (community_voice_room la crea a pedido y la reutiliza) y navegan a #/voice.
import { h, icon, mount, skeleton, emptyState, setBusy, ok, fail, confirmDialog } from '../../ui.js';
import { t, loadNs } from '../../i18n.js';
import { navigate } from '../../app.js';
import { errText } from '../../features/clans/backend.js';
import { openGroupReport } from '../../features/clans/report.js';
import { headImg, openProfile, popMenu } from '../../social/profile-ui.js';
import { canModerate, channelsByKind, isMuted, isStaff, MUTE_OPTIONS, personName, pickChannel, voiceSummary } from './logic.js';
import { chatView } from './chat.js';
import { openBansDialog, openChannelsDialog, openCommunityForm, openInviteDialog } from './forms.js';

const C = (key, vars) => t(`clans.${key}`, vars);
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
  return h('section', { class: 'card cl-card cm-preview' },
    h('h2', { class: 'card-title' }, icon('users'), community.name),
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
  const people = new Map();
  let members = [];
  let total = 0;
  const side = h('aside', { class: 'cm-side', 'aria-label': C('channelsLabel') });
  const chatHost = h('section', { class: 'cm-chat card' });
  const memberHost = h('aside', { class: 'cm-members', 'aria-label': C('membersTitle') });
  const layout = h('div', { class: 'cm-layout' }, side, chatHost, memberHost);
  const back = h('button', { class: 'btn sm ghost cl-back', type: 'button', onclick: () => navigate('communities') }, icon('arrowLeft'), C('backToCommunities'));

  async function fetchCommunity() {
    community = await b.rpc('community_get', { p_community: id });
    return community;
  }
  async function fetchMembers() {
    try {
      const res = await b.rpc('community_members_list', { p_community: id });
      members = Array.isArray(res?.members) ? res.members.filter(Boolean) : [];
      total = Number(res?.total) || members.length;
      for (const m of members) people.set(m.userId, m);
    } catch (err) {
      console.warn('[clans] miembros:', err?.message || err);
    }
  }
  async function refresh() {
    await fetchCommunity();
    if (destroyed) return community;
    drawSide();
    chat?.setCommunity(community);
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
    channelId = ch.id;
    route();
    chat?.destroy();
    chat = chatView(chatHost, { b, community, channel: ch, people, onPerson: () => {} });
    drawSide();
  }

  async function enterVoice(ch, btn) {
    const done = setBusy(btn);
    try {
      await loadNs('voice');
      const room = await b.rpc('community_voice_room', { p_channel: ch.id });
      if (!b.fake) {
        const { voice } = await import('../../voice.js');
        await voice.joinRoom(room.code);
      }
      navigate('voice');
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

  function voiceRow(ch) {
    const sum = voiceSummary(ch.people);
    const btn = h('button', { class: 'cm-channel', type: 'button', title: C('voiceEnter', { name: ch.name }) }, icon('volume'), h('span', { class: 'ellipsis' }, ch.name),
      sum.count ? h('span', { class: 'cm-channel-count' }, String(sum.count)) : null);
    btn.addEventListener('click', () => enterVoice(ch, btn));
    return h('li', {}, btn, sum.count ? h('ul', { class: 'cm-voice-people' }, sum.shown.map((p) => h('li', {}, headImg(p, 18, 'cl-head'), h('span', { class: 'ellipsis' }, personName(p) || C('someone')))), sum.extra ? h('li', { class: 'cl-muted small' }, C('voiceMore', { n: sum.extra })) : null) : null);
  }
  function drawSide() {
    const { text, voice } = channelsByKind(community.channels);
    mount(side,
      h('div', { class: 'cm-side-head' },
        h('strong', { class: 'cm-side-name ellipsis', title: community.name }, community.name),
        h('button', { class: 'icon-btn sm', type: 'button', title: C('communityMenu'), 'aria-label': C('communityMenu'), 'aria-haspopup': 'menu', onclick: (e) => headerMenu(e.currentTarget) }, icon('more'))),
      h('div', { class: 'cm-side-scroll' },
        h('h3', { class: 'cm-side-title' }, C('textChannels')),
        h('ul', { class: 'cm-channels' }, text.map((ch) => h('li', {}, h('button', { class: ['cm-channel', ch.id === channelId && 'active'], type: 'button', 'aria-current': ch.id === channelId ? 'true' : null, onclick: () => openChannel(ch) }, icon('hash'), h('span', { class: 'ellipsis' }, ch.name))))),
        h('h3', { class: 'cm-side-title' }, C('voiceChannels')),
        voice.length ? h('ul', { class: 'cm-channels' }, voice.map(voiceRow)) : h('p', { class: 'cl-muted small cm-side-empty' }, C('voiceNone')),
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
        m.role !== 'member' ? h('span', { class: 'cm-role', title: C(`role_${m.role}`), 'aria-label': C(`role_${m.role}`) }, icon(m.role === 'owner' ? 'crown' : 'shield')) : null,
        muted ? h('span', { class: 'cm-role is-muted', title: C('mutedBadge'), 'aria-label': C('mutedBadge') }, icon('volumeX')) : null));
  }
  function drawMembers() {
    if (destroyed) return;
    mount(memberHost,
      h('div', { class: 'cm-side-head' }, h('strong', {}, C('membersTotal', { n: total }))),
      h('ul', { class: 'cm-channels cm-side-scroll' }, members.map(memberRow)),
      total > members.length ? h('p', { class: 'cl-muted small cm-side-empty' }, C('membersMore', { n: total - members.length })) : null);
  }

  async function start() {
    mount(root, back, skeleton('card', { lines: 6 }));
    try {
      await fetchCommunity();
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
    if (destroyed) return;
    root.classList.add('cm-fill');
    mount(root, back, layout);
    drawMembers();
    const ch = pickChannel(community.channels, channelId);
    if (ch) openChannel(ch);
    else {
      drawSide();
      mount(chatHost, emptyState('hash', C('chatNoChannel'), ''));
    }
  }
  start();
  const timer = setInterval(() => {
    if (!destroyed && community?.myRole && document.visibilityState === 'visible') refresh().catch(() => {});
  }, REFRESH_MS);
  return () => {
    destroyed = true;
    clearInterval(timer);
    chat?.destroy();
  };
}
