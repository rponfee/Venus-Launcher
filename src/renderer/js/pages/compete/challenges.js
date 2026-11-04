// Competir -> Desafíos: los que hay que responder, los que están en curso con el progreso de los dos, los enviados y los
// terminados, más el diálogo para desafiar a un amigo. El estado vive en features/compete.js (loadChallenges).
import { h, icon, mount, modal, skeleton, emptyState, setBusy, fail, ok, fmtDate, confirmDialog } from '../../ui.js';
import { t } from '../../i18n.js';
import { navigate } from '../../app.js';
import { errText, getChallenges, loadChallenges, onChallenges, reportNow, setShare, shareEnabled, tellFriend } from '../../features/compete.js';
import { headImg } from '../../social/profile-ui.js';
import { CHALLENGE_RULES, DURATIONS, METRICS, challengeBars, groupChallenges, timeLeft, validateChallengeForm } from './logic.js';
import { METRIC_ICONS, durationName, friendName, fmtInt, goalText, leftText, metricName, metricText } from './format.js';

const C = (key, vars) => t(`compete.${key}`, vars);

function segmented(options, value, onChange, label) {
  const el = h('div', { class: 'segmented cp-seg', role: 'group', 'aria-label': label });
  const draw = () => mount(el, options.map((o) => h('button', {
    type: 'button',
    class: o.value === value ? 'active' : null,
    'aria-pressed': String(o.value === value),
    onclick: () => {
      value = o.value;
      draw();
      onChange(value);
    },
  }, o.label)));
  draw();
  return el;
}

// ---------- Desafiar a un amigo ----------
async function openNewChallenge(b, { friendId = null, onDone } = {}) {
  const body = h('div', { class: 'stack cp-form' }, skeleton(3));
  let dialog;
  dialog = modal({ title: C('newTitle'), subtitle: C('newSub', { n: CHALLENGE_RULES.prize }), icon: 'swords', body });
  let friends = [];
  try {
    friends = await b.friends();
  } catch (err) {
    console.warn('[compete] amigos', err?.message || err);
  }
  if (!friends.length) {
    mount(body, emptyState('users', C('newNoFriends'), C('newNoFriendsText'), h('button', { type: 'button', class: 'btn sm', onclick: () => { dialog.close(); navigate('messages'); } }, icon('userPlus'), C('rankEmptyAction'))));
    return;
  }
  const form = { friend: friendId && friends.some((f) => f.id === friendId) ? friendId : friends[0].id, metric: 'hours', hours: 72, mode: 'most', goal: '' };
  const fieldId = (k) => `cp-new-${k}`;
  const friend = h('select', { class: 'select', id: fieldId('friend'), onchange: (e) => { form.friend = e.target.value; } }, friends.map((f) => h('option', { value: f.id, selected: f.id === form.friend }, f.name)));
  const metric = h('select', { class: 'select', id: fieldId('metric') }, METRICS.map((m) => h('option', { value: m, selected: m === form.metric }, metricName(m))));
  const goal = h('input', { class: 'input num', id: fieldId('goal'), inputmode: 'decimal', autocomplete: 'off' });
  const goalField = h('div', { class: 'field' });
  const error = h('div', { class: 'field-error', role: 'alert', hidden: true });
  const drawGoal = () => {
    goalField.hidden = form.mode !== 'target';
    mount(goalField, h('label', { for: fieldId('goal') }, form.metric === 'hours' ? C('newGoalHours') : C('newGoal')), goal);
  };
  metric.addEventListener('change', () => {
    form.metric = metric.value;
    drawGoal();
  });
  goal.addEventListener('input', () => {
    form.goal = goal.value;
    error.hidden = true;
  });
  const send = h('button', { type: 'button', class: 'btn primary' }, icon('send'), C('newSend'));
  send.addEventListener('click', async () => {
    const check = validateChallengeForm(form);
    if (!check.ok) {
      mount(error, icon('alert'), h('span', {}, C(`newError_${check.error}`)));
      error.hidden = false;
      return;
    }
    const done = setBusy(send);
    try {
      await reportNow(); // lo jugado hasta ahora no cuenta para el desafío
      await b.rpc('challenge_create', check.payload);
      tellFriend(form.friend);
      ok(C('newSent'));
      dialog.close();
      onDone?.();
    } catch (err) {
      mount(error, icon('alert'), h('span', {}, errText(err)));
      error.hidden = false;
    } finally {
      done();
    }
  });
  mount(body,
    h('div', { class: 'field' }, h('label', { for: fieldId('friend') }, C('newFriend')), friend),
    h('div', { class: 'field' }, h('label', { for: fieldId('metric') }, C('newMetric')), metric),
    h('div', { class: 'field' }, h('span', { class: 'label' }, C('newDuration')), segmented(DURATIONS.map((d) => ({ value: d, label: durationName(d) })), form.hours, (v) => { form.hours = v; }, C('newDuration'))),
    h('div', { class: 'field' }, h('span', { class: 'label' }, C('newMode')), segmented([{ value: 'most', label: C('modeMost') }, { value: 'target', label: C('modeTarget') }], form.mode, (v) => { form.mode = v; drawGoal(); }, C('newMode'))),
    goalField,
    h('p', { class: 'cp-muted small' }, C('newRules', { min: CHALLENGE_RULES.minMinutes })),
    error,
    h('div', { class: 'cp-form-foot' }, send));
  drawGoal();
}

// ---------- Tarjetas ----------
function faceOf(c) {
  return headImg({ mcUuid: c.friend.mcUuid, mcName: c.friend.mcName, username: c.friend.username }, 36, 'cp-head');
}

function chips(c) {
  return h('div', { class: 'cp-chips' },
    h('span', { class: 'cp-chip' }, icon(METRIC_ICONS[c.metric]), metricName(c.metric)),
    h('span', { class: 'cp-chip' }, icon('target'), goalText(c)),
    h('span', { class: 'cp-chip' }, icon('clock'), durationName(c.hours)));
}

function progress(label, value, pct, metric, cls) {
  return h('div', { class: ['cp-progress', cls] },
    h('span', { class: 'cp-progress-who ellipsis' }, label),
    h('div', { class: 'cp-bar', role: 'progressbar', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct) }, h('i', { style: { width: `${pct}%` } })),
    h('span', { class: 'cp-progress-value num' }, metricText(metric, value)));
}

function activityHint(c) {
  const min = CHALLENGE_RULES.minMinutes;
  if (c.myMinutes >= min && c.theirMinutes >= min) return null;
  return h('p', { class: 'cp-muted small cp-hint' }, icon('info'), c.myMinutes < min ? C('activityYou', { min, n: fmtInt(c.myMinutes) }) : C('activityThem', { name: friendName(c.friend), min }));
}

function outcomeView(c) {
  if (c.status === 'declined') return h('span', { class: 'pill' }, icon('x'), c.mine ? C('statusDeclinedThem') : C('statusDeclinedYou'));
  if (c.status === 'canceled') return h('span', { class: 'pill' }, icon('x'), C('statusCanceled'));
  if (c.status === 'expired') return h('span', { class: 'pill' }, icon('clock'), C('statusExpired'));
  if (c.outcome === 'win' && c.won) return h('span', { class: 'pill good' }, icon('trophy'), c.prize > 0 ? C('statusWonPrize', { n: c.prize }) : C('statusWon'));
  if (c.outcome === 'win') return h('span', { class: 'pill bad' }, icon('x'), C('statusLost'));
  if (c.outcome === 'tie') return h('span', { class: 'pill warn' }, icon('swords'), C('statusTie'));
  return h('span', { class: 'pill warn' }, icon('info'), C(c.outcome === 'no_target' ? 'statusNoTarget' : 'statusNoActivity'));
}

function challengeCard(c, b, reload) {
  const name = friendName(c.friend);
  const act = (rpc, args, { text, confirm } = {}) => async (e) => {
    const done = setBusy(e.currentTarget);
    try {
      if (confirm && !(await confirm())) return;
      if (rpc === 'challenge_respond' && args.p_accept) await reportNow();
      await b.rpc(rpc, args);
      tellFriend(c.friend.id);
      if (text) ok(text);
    } catch (err) {
      fail(C('actionError'), errText(err));
    } finally {
      done();
      reload();
    }
  };
  if (c.status === 'pending' && !c.mine) {
    const share = shareEnabled();
    return h('article', { class: 'card cp-ch is-incoming' },
      h('div', { class: 'cp-ch-head' }, faceOf(c), h('div', { class: 'cp-ch-title' }, h('strong', { class: 'ellipsis' }, C('incomingTitle', { name })), c.expiresAt ? h('span', { class: 'cp-muted small' }, C('expiresIn', { left: leftText(timeLeft(c.expiresAt, Date.now())) })) : null)),
      chips(c),
      share ? null : h('p', { class: 'cp-muted small cp-hint' }, icon('info'), C('acceptNeedsShare')),
      h('div', { class: 'cp-ch-actions' },
        h('button', { type: 'button', class: 'btn primary sm', onclick: act('challenge_respond', { p_id: c.id, p_accept: true }, {
          text: C('accepted'),
          confirm: share ? null : async () => {
            if (!(await confirmDialog(C('shareTitle'), `${C('shareSends')} ${C('shareSees')}`, { okText: C('acceptAndShare') }))) return false;
            await setShare(true);
            return true;
          },
        }) }, icon('check'), C('accept')),
        h('button', { type: 'button', class: 'btn sm', onclick: act('challenge_respond', { p_id: c.id, p_accept: false }) }, icon('x'), C('decline'))));
  }
  if (c.status === 'pending') {
    return h('article', { class: 'card cp-ch' },
      h('div', { class: 'cp-ch-head' }, faceOf(c), h('div', { class: 'cp-ch-title' }, h('strong', { class: 'ellipsis' }, C('outgoingTitle', { name })), c.expiresAt ? h('span', { class: 'cp-muted small' }, C('expiresIn', { left: leftText(timeLeft(c.expiresAt, Date.now())) })) : null)),
      chips(c),
      h('div', { class: 'cp-ch-actions' }, h('button', { type: 'button', class: 'btn sm', onclick: act('challenge_cancel', { p_id: c.id }) }, icon('x'), C('cancel'))));
  }
  if (c.status === 'active') {
    const bars = challengeBars(c);
    return h('article', { class: 'card cp-ch is-active' },
      h('div', { class: 'cp-ch-head' }, faceOf(c), h('div', { class: 'cp-ch-title' }, h('strong', { class: 'ellipsis' }, C('activeTitle', { name })), h('span', { class: 'cp-muted small' }, C('endsIn', { left: leftText(timeLeft(c.endsAt, Date.now())) })))),
      chips(c),
      h('div', { class: 'cp-ch-bars' }, progress(C('you'), c.myValue, bars.me, c.metric, 'is-me'), progress(name, c.theirValue, bars.them, c.metric, 'is-them')),
      activityHint(c));
  }
  const hasScore = c.status === 'finished';
  return h('li', { class: 'cp-closed' },
    faceOf(c),
    h('div', { class: 'cp-closed-main' },
      h('strong', { class: 'ellipsis' }, name),
      h('span', { class: 'cp-muted small ellipsis' }, `${metricName(c.metric)} · ${goalText(c)}${c.settledAt ? ` · ${fmtDate(c.settledAt, { day: 'numeric', month: 'short' })}` : ''}`),
      c.prizeNote ? h('span', { class: 'cp-muted small' }, C(`note_${c.prizeNote}`)) : null),
    hasScore ? h('span', { class: 'cp-closed-score num', title: C('scoreLabel') }, `${metricText(c.metric, c.myValue)} – ${metricText(c.metric, c.theirValue)}`) : null,
    outcomeView(c));
}

// ---------- Pestaña ----------
export function challengesView(root, { b }) {
  const body = h('div', { class: 'cp-ch-page' });
  const rules = CHALLENGE_RULES;
  const newBtn = h('button', { type: 'button', class: 'btn primary', onclick: () => openNewChallenge(b, { onDone: reload }) }, icon('swords'), C('newChallenge'));
  const weekChip = h('span', { class: 'cp-chip' });
  mount(root, h('div', { class: 'cp-controls' }, newBtn, weekChip), body, h('p', { class: 'cp-note' }, icon('info'), h('span', {}, C('challengeNote', { prize: rules.prize, cap: rules.weekCap, min: rules.minMinutes }))));
  mount(body, skeleton('list', { rows: 3 }));

  async function reload() {
    await loadChallenges({ force: true });
  }

  const section = (titleKey, iconName, cards) => (cards.length ? h('section', { class: 'cp-ch-section' }, h('h2', { class: 'cp-ch-section-title' }, icon(iconName), C(titleKey), h('span', { class: 'count' }, String(cards.length))), h('div', { class: 'cp-ch-grid' }, cards)) : null);

  function paint() {
    if (!root.isConnected) return;
    const { data, error, at } = getChallenges();
    if (!at && !data) return;
    if (error && !data) {
      mount(body, h('div', { class: 'notice bad' }, icon('alert'), h('div', { class: 'spacer' }, errText(error)), h('button', { type: 'button', class: 'btn sm', onclick: reload }, icon('refresh'), C('retry'))));
      return;
    }
    const g = groupChallenges(data?.challenges);
    mount(weekChip, icon('trophy'), C('prizesWeek', { n: Number(data?.prizesThisWeek) || 0, cap: rules.weekCap }));
    const needShare = shareEnabled() ? null : h('div', { class: 'notice info' }, icon('info'), h('div', { class: 'spacer' }, C('challengeNeedsShare')), h('button', { type: 'button', class: 'btn sm', onclick: () => navigate('compete/rankings') }, icon('trophy'), C('tab_rankings')));
    const empty = !g.incoming.length && !g.active.length && !g.outgoing.length && !g.closed.length;
    mount(body,
      needShare,
      empty ? emptyState('swords', C('challengesEmptyTitle'), C('challengesEmptyText')) : null,
      section('sectionIncoming', 'bell', g.incoming.map((c) => challengeCard(c, b, reload))),
      section('sectionActive', 'swords', g.active.map((c) => challengeCard(c, b, reload))),
      section('sectionOutgoing', 'send', g.outgoing.map((c) => challengeCard(c, b, reload))),
      g.closed.length ? h('section', { class: 'cp-ch-section' }, h('h2', { class: 'cp-ch-section-title' }, icon('history'), C('sectionClosed')), h('ul', { class: 'card cp-closed-list' }, g.closed.map((c) => challengeCard(c, b, reload)))) : null);
  }

  const off = onChallenges(paint);
  reload();
  // Mientras se mira la pestaña, el tiempo que queda y el progreso se refrescan de a poco.
  const timer = setInterval(() => {
    if (document.hidden || root.hidden) return;
    if (groupChallenges(getChallenges().data?.challenges).active.length) loadChallenges();
    else paint();
  }, 60000);
  return () => {
    off();
    clearInterval(timer);
  };
}
