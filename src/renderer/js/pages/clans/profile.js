// Perfil de un clan: tag, descripción, miembros, ranking de la semana y logros, más lo que puede hacer cada rol. El nombre,
// el tag y la descripción son de otras cuentas: van siempre como texto. Los botones se muestran según el rol, pero el que
// decide es el servidor (0033_clanes_comunidades.sql).
import { h, icon, ok, fail, setBusy, confirmDialog, copyText, fmtDate, fmtAgo } from '../../ui.js';
import { t, locale } from '../../i18n.js';
import { navigate } from '../../app.js';
import { errText } from '../../features/clans/backend.js';
import { emblemBadge, forgetClanTags, tagChip } from '../../features/clans/tag.js';
import { tellFriend } from '../../features/clans.js';
import { openGroupReport } from '../../features/clans/report.js';
import { MIN_SHARING, achievementView, canKickFromClan, canSetClanRole, canTransferClan, isClanStaff, minutesToHours, sortClanMembers } from '../../features/clans/logic.js';
import { headImg, openProfile, popMenu } from '../../social/profile-ui.js';
import { openClanForm, openClanInvite } from './forms.js';

const C = (key, vars) => t(`clans.${key}`, vars);
const ACH_ICONS = { members: 'users', days: 'calendar', minutes: 'clock' };

const nameOf = (p) => String(p?.displayName || p?.username || '').trim() || C('someone');

export const hoursText = (minutes) => C('hoursValue', { n: minutesToHours(minutes).toLocaleString(locale(), { maximumFractionDigits: 1 }) });

// Corre una acción del clan: botón ocupado, aviso y volver a dibujar con lo que diga el servidor.
function runner(reload) {
  return async (btn, fn, okText) => {
    const done = btn ? setBusy(btn) : () => {};
    try {
      await fn();
      if (okText) ok(okText);
      forgetClanTags();
      await reload();
    } catch (err) {
      fail(C('actionError'), errText(err));
    } finally {
      done();
    }
  };
}

function memberRow(m, clan, { b, run }) {
  const me = b.userId();
  const self = m.userId === me;
  const role = clan.myRole;
  const items = self ? [] : [
    canSetClanRole(role, m.role) ? { icon: m.role === 'member' ? 'upCircle' : 'user', label: m.role === 'member' ? C('promote') : C('demote'), run: () => run(null, () => b.rpc('clan_set_role', { p_user: m.userId, p_role: m.role === 'member' ? 'officer' : 'member' }), C('roleChanged')) } : null,
    canTransferClan(role, m.role) ? { icon: 'crown', label: C('transfer'), run: async () => {
      if (await confirmDialog(C('transferTitle'), C('transferText', { name: nameOf(m) }), { okText: C('transfer') })) run(null, () => b.rpc('clan_transfer', { p_user: m.userId }), C('transferred', { name: nameOf(m) }));
    } } : null,
    canKickFromClan(role, m.role) ? { icon: 'ban', label: C('kick'), danger: true, run: async () => {
      if (await confirmDialog(C('kickTitle'), C('kickText', { name: nameOf(m) }), { okText: C('kick'), danger: true })) run(null, () => b.rpc('clan_kick', { p_user: m.userId }), C('kicked', { name: nameOf(m) }));
    } } : null,
  ].filter(Boolean);
  const more = items.length ? h('button', { class: 'icon-btn sm', type: 'button', title: C('memberActions'), 'aria-label': C('memberActions'), 'aria-haspopup': 'menu', onclick: (e) => popMenu(e.currentTarget, items) }, icon('more')) : null;
  return h('li', { class: 'cl-row' },
    headImg(m, 32, 'cl-head'),
    h('button', { class: 'cl-link cl-row-name ellipsis', type: 'button', title: C('viewProfile', { name: nameOf(m) }), onclick: () => openProfile(m.userId) }, nameOf(m)),
    self ? h('span', { class: 'badge accent' }, C('you')) : null,
    h('span', { class: ['badge', m.role === 'leader' && 'warn', m.role === 'officer' && 'info'] }, m.role === 'leader' ? icon('crown') : null, C(`role_${m.role}`)),
    more);
}

function rankingCard(clan, rank) {
  const shared = clan.shared || {};
  const note = shared.available === false ? C('sharedUnavailable') : Number(shared.sharing) >= MIN_SHARING ? C('sharedSome', { count: Number(shared.sharing) }) : Number(shared.sharing) === 1 ? C('sharedOne') : C('sharedNobody');
  return h('section', { class: 'card cl-card' },
    h('h3', { class: 'card-title' }, icon('trophy'), C('rankingCard')),
    h('div', { class: 'cl-stats' },
      h('div', { class: 'cl-stat' }, h('strong', { class: 'num' }, hoursText(shared.weekMinutes)), h('span', {}, C('statWeek'))),
      h('div', { class: 'cl-stat' }, h('strong', { class: 'num' }, rank?.pos ? `#${rank.pos}` : '—'), h('span', {}, C('statPosition'))),
      h('div', { class: 'cl-stat' }, h('strong', { class: 'num' }, hoursText(shared.totalMinutes)), h('span', {}, C('statTotal')))),
    h('p', { class: 'cl-note' }, icon('info'), h('span', {}, note)));
}

function achievementsCard(clan) {
  const list = (Array.isArray(clan.achievements) ? clan.achievements : []).map(achievementView);
  const got = list.filter((a) => a.unlocked).length;
  return h('section', { class: 'card cl-card' },
    h('h3', { class: 'card-title' }, icon('star'), C('achievementsTitle', { got, total: list.length })),
    h('ul', { class: 'cl-ach-list' }, list.map((a) => h('li', { class: ['cl-ach', a.unlocked && 'is-on'] },
      h('span', { class: 'cl-ach-icon', 'aria-hidden': 'true' }, icon(a.unlocked ? 'check' : ACH_ICONS[a.kind] || 'star')),
      h('div', { class: 'cl-ach-main' },
        h('div', { class: 'cl-ach-name' }, C(`ach_${a.id}`)),
        h('div', { class: 'cl-bar', role: 'progressbar', 'aria-valuenow': String(a.pct), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': C(`ach_${a.id}`) }, h('i', { style: { width: `${a.pct}%` } }))),
      h('span', { class: 'cl-ach-value num' }, `${Math.min(a.value, a.goal)}/${a.goal}`)))));
}

function staffCard(clan, { b, run, reload }) {
  const code = h('span', { class: 'kbd selectable priv cl-code' }, clan.inviteCode || '');
  const copy = h('button', { class: 'icon-btn sm', type: 'button', title: C('copyCode'), 'aria-label': C('copyCode'), onclick: () => copyText(clan.inviteCode, C('codeCopied')) }, icon('copy'));
  const regen = h('button', { class: 'btn sm ghost', type: 'button' }, icon('refresh'), C('regenCode'));
  regen.addEventListener('click', async () => {
    if (await confirmDialog(C('regenTitle'), C('regenText'), { okText: C('regenCode') })) run(regen, () => b.rpc('clan_regen_code'), C('regenDone'));
  });
  const invite = h('button', { class: 'btn sm primary', type: 'button', onclick: () => openClanInvite(b, clan, { onChanged: reload }) }, icon('userPlus'), C('inviteFriend'));
  const requests = clan.requests || [];
  const invited = clan.invited || [];
  return h('section', { class: 'card cl-card' },
    h('h3', { class: 'card-title' }, icon('userPlus'), C('joinCard')),
    h('div', { class: 'cl-code-row' }, h('span', { class: 'label' }, C('codeLabel')), code, copy, regen),
    h('div', { class: 'row wrap' }, invite),
    requests.length ? h('div', { class: 'cl-sub' }, h('h4', {}, C('requestsTitle', { count: requests.length })),
      h('ul', { class: 'cl-list' }, requests.map((r) => {
        const yes = h('button', { class: 'btn sm tonal', type: 'button' }, icon('check'), C('approve'));
        const no = h('button', { class: 'icon-btn sm', type: 'button', title: C('reject'), 'aria-label': C('reject') }, icon('x'));
        const answer = (accept, btn) => run(btn, async () => {
          await b.rpc('clan_request_respond', { p_user: r.user.userId, p_accept: accept });
          tellFriend(r.user.userId);
        }, accept ? C('approved', { name: nameOf(r.user) }) : null);
        yes.addEventListener('click', () => answer(true, yes));
        no.addEventListener('click', () => answer(false, no));
        return h('li', { class: 'cl-row' }, headImg(r.user, 32, 'cl-head'), h('button', { class: 'cl-link cl-row-name ellipsis', type: 'button', onclick: () => openProfile(r.user.userId) }, nameOf(r.user)), h('span', { class: 'cl-muted small' }, fmtAgo(Date.parse(r.at))), yes, no);
      }))) : null,
    invited.length ? h('div', { class: 'cl-sub' }, h('h4', {}, C('invitedTitle', { count: invited.length })),
      h('ul', { class: 'cl-list' }, invited.map((r) => {
        const del = h('button', { class: 'icon-btn sm', type: 'button', title: C('inviteCancel'), 'aria-label': C('inviteCancel') }, icon('x'));
        del.addEventListener('click', () => run(del, () => b.rpc('clan_invite_cancel', { p_user: r.user.userId }), null));
        return h('li', { class: 'cl-row' }, headImg(r.user, 32, 'cl-head'), h('span', { class: 'cl-row-name ellipsis' }, nameOf(r.user)), h('span', { class: 'cl-muted small' }, fmtAgo(Date.parse(r.at))), del);
      }))) : null);
}

/** clan: lo que devuelve clan_get. reload(): vuelve a pedirlo y redibuja. rank: su fila del ranking, si se conoce. */
export function clanProfile(clan, { b, reload, rank = null, inClan = false }) {
  const run = runner(reload);
  const role = clan.myRole;
  const staff = isClanStaff(role);
  const members = sortClanMembers(clan.members);
  const actions = [];
  if (role === 'leader') {
    actions.push(h('button', { class: 'btn sm', type: 'button', onclick: () => openClanForm(b, { clan, onSaved: reload }) }, icon('edit'), C('edit')));
  }
  if (role) {
    const leave = h('button', { class: 'btn sm ghost', type: 'button' }, icon('logout'), C('leave'));
    leave.addEventListener('click', async () => {
      const last = members.length <= 1;
      if (role === 'leader' && !last) return fail(C('leaveLeaderTitle'), C('err_leader_must_transfer'));
      if (await confirmDialog(C('leaveTitle'), last ? C('leaveLast') : C('leaveText'), { okText: C('leave'), danger: true })) run(leave, () => b.rpc('clan_leave'), last ? C('dissolved') : C('left'));
      return undefined;
    });
    actions.push(leave);
  } else if (clan.requested) {
    const cancel = h('button', { class: 'btn sm ghost', type: 'button' }, icon('x'), C('requestCancel'));
    cancel.addEventListener('click', () => run(cancel, () => b.rpc('clan_request_cancel', { p_clan: clan.id }), null));
    actions.push(cancel);
  } else if (clan.isOpen && !inClan) {
    const ask = h('button', { class: 'btn sm primary', type: 'button' }, icon('userPlus'), C('requestJoin'));
    ask.addEventListener('click', () => run(ask, () => b.rpc('clan_request', { p_clan: clan.id }), C('requestSent')));
    actions.push(ask);
  }
  if (!role) {
    actions.push(h('button', { class: 'icon-btn sm', type: 'button', title: C('report'), 'aria-label': C('report'), onclick: () => openGroupReport({ kind: 'clan', id: clan.id, name: clan.name }) }, icon('alert')));
  }
  const at = Date.parse(clan.createdAt);
  return h('div', { class: 'cl-profile' },
    h('section', { class: 'card cl-hero', style: { '--cl-c': tagColor(clan) } },
      emblemBadge(clan, { size: 'lg' }),
      h('div', { class: 'cl-hero-main' },
        h('div', { class: 'cl-hero-title' }, h('h2', { class: 'cl-hero-name selectable' }, clan.name), tagChip({ tag: clan.tag, color: clan.color })),
        h('div', { class: 'cl-chips' },
          h('span', { class: ['badge', clan.isOpen ? 'good' : ''] }, icon(clan.isOpen ? 'globe' : 'lock'), clan.isOpen ? C('open') : C('closed')),
          h('span', { class: 'badge' }, icon('users'), C('membersCount', { n: clan.memberCount ?? members.length, max: clan.maxMembers ?? 50 })),
          Number.isFinite(at) ? h('span', { class: 'badge' }, icon('calendar'), C('since', { date: fmtDate(at) })) : null),
        clan.description ? h('p', { class: 'cl-desc selectable' }, clan.description) : null),
      actions.length ? h('div', { class: 'cl-hero-actions' }, actions) : null),
    !role && inClan ? h('p', { class: 'cl-note' }, icon('info'), h('span', {}, C('alreadyInOther'))) : null,
    h('div', { class: 'cl-grid' },
      h('div', { class: 'cl-col' },
        staff ? staffCard(clan, { b, run, reload }) : null,
        h('section', { class: 'card cl-card' },
          h('h3', { class: 'card-title' }, icon('users'), C('membersTitle')),
          h('ul', { class: 'cl-list' }, members.map((m) => memberRow(m, clan, { b, run }))))),
      h('div', { class: 'cl-col' }, rankingCard(clan, rank), achievementsCard(clan))));
}

const tagColor = (clan) => (/^#[0-9a-f]{6}$/i.test(clan?.color || '') ? clan.color : 'var(--accent)');

export function backToBrowse() {
  return h('button', { class: 'btn sm ghost cl-back', type: 'button', onclick: () => navigate('clans/browse') }, icon('arrowLeft'), C('backToBrowse'));
}
