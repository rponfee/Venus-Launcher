// Competir -> Rankings: la semana (de lunes a domingo, UTC) entre amigos, por métrica. Si compartir está apagado explica
// qué se manda y quién lo ve; igual se ven los amigos que comparten.
import { h, icon, mount, skeleton, emptyState, setBusy, fail, ok, fmtDate, confirmDialog } from '../../ui.js';
import { store } from '../../store.js';
import { t } from '../../i18n.js';
import { navigate } from '../../app.js';
import { errText, reportNow, shareEnabled, shareSwitch, shareWhat, forgetShared } from '../../features/compete.js';
import { headImg, openProfile } from '../../social/profile-ui.js';
import { METRICS, rankingView, shiftWeek, weekBounds, weekKey } from './logic.js';
import { METRIC_ICONS, friendName, metricName, metricText } from './format.js';
import { clanSharingCard } from '../../features/clans/sharing.js';

const C = (key, vars) => t(`compete.${key}`, vars);
const MAX_WEEKS_BACK = 12;

export function rankingsView(root, { b }) {
  let metric = 'hours';
  const thisWeek = weekKey(Date.now());
  let week = thisWeek;
  let seq = 0;
  let reportedAt = 0;
  let sharing = shareEnabled();
  const shareBox = h('div', { class: 'cp-share-slot' });
  const clanSharing = clanSharingCard();
  const metricBar = h('div', { class: 'segmented cp-metrics', role: 'group', 'aria-label': C('metricLabel') });
  const prev = h('button', { type: 'button', class: 'icon-btn', title: C('weekPrev'), 'aria-label': C('weekPrev') }, icon('chevronLeft'));
  const next = h('button', { type: 'button', class: 'icon-btn', title: C('weekNext'), 'aria-label': C('weekNext') }, icon('chevronRight'));
  const weekLabel = h('div', { class: 'cp-week-label', role: 'status' });
  const list = h('section', { class: 'card cp-rank', 'aria-live': 'polite' });

  function drawMetrics() {
    mount(metricBar, METRICS.map((m) => h('button', {
      type: 'button',
      class: m === metric ? 'active' : null,
      'aria-pressed': String(m === metric),
      onclick: () => {
        metric = m;
        drawMetrics();
        load();
      },
    }, icon(METRIC_ICONS[m]), metricName(m))));
  }

  function drawWeek() {
    const { from, to } = weekBounds(week);
    const opts = { day: 'numeric', month: 'short', timeZone: 'UTC' };
    mount(weekLabel,
      h('strong', {}, week === thisWeek ? C('weekThis') : week === shiftWeek(thisWeek, -1) ? C('weekLast') : C('weekOther')),
      h('span', { class: 'cp-muted' }, C('weekRange', { from: fmtDate(from, opts), to: fmtDate(to, opts) })));
    next.disabled = week >= thisWeek;
    prev.disabled = week <= shiftWeek(thisWeek, -MAX_WEEKS_BACK);
  }
  prev.addEventListener('click', () => { week = shiftWeek(week, -1); drawWeek(); load(); });
  next.addEventListener('click', () => { week = shiftWeek(week, 1); drawWeek(); load(); });

  function drawShare(view) {
    if (!shareEnabled()) {
      mount(shareBox, h('section', { class: 'card cp-share' },
        h('div', { class: 'cp-share-head' },
          h('h2', { class: 'card-title' }, icon('trophy'), C('shareTitle')),
          h('div', { class: 'cp-share-toggle' }, h('span', {}, C('shareToggle')), shareSwitch(afterShare))),
        shareWhat(),
        view?.share ? h('p', { class: 'cp-muted small cp-hint' }, icon('info'), C('shareOtherPc')) : null));
      return;
    }
    const mine = view?.mine || {};
    const forget = h('button', { type: 'button', class: 'btn sm ghost' }, icon('trash'), C('shareForget'));
    forget.addEventListener('click', async () => {
      if (!(await confirmDialog(C('shareForget'), C('shareForgetText'), { danger: true }))) return;
      const done = setBusy(forget);
      try {
        await forgetShared();
        ok(C('shareForgotten'));
        afterShare();
      } catch (err) {
        fail(C('shareError'), errText(err));
      } finally {
        done();
      }
    });
    mount(shareBox, h('section', { class: 'card cp-share is-on' },
      h('div', { class: 'cp-share-head' },
        h('div', { class: 'cp-share-state' }, icon('check'), h('strong', {}, C('shareActive'))),
        h('div', { class: 'cp-share-tools' }, forget, h('div', { class: 'cp-share-toggle' }, shareSwitch(afterShare)))),
      h('div', { class: 'cp-mine' }, h('span', { class: 'cp-muted' }, week === thisWeek ? C('mineThisWeek') : C('mineThatWeek')),
        METRICS.map((m) => h('span', { class: 'cp-mine-chip', title: metricName(m) }, icon(METRIC_ICONS[m]), h('span', { class: 'sr-only' }, metricName(m)), metricText(m, mine[m === 'hours' ? 'minutes' : m]))))));
  }

  function afterShare() {
    sharing = shareEnabled();
    drawShare(null);
    load();
  }

  function rowView(r, i, rows) {
    const name = friendName(r);
    const top = r.rank <= 3 && r.value > 0;
    return h('li', { class: ['cp-rank-row', r.me && 'is-me'] },
      h('span', { class: ['cp-rank-pos', top && `is-top is-${r.rank}`] }, top ? icon(metric === 'deaths' ? 'skull' : 'crown') : null, String(r.rank)),
      headImg({ mcUuid: r.mcUuid, mcName: r.mcName, username: r.username }, 32, 'cp-head'),
      h('div', { class: 'cp-rank-main' },
        h('div', { class: 'cp-rank-name' },
          r.me ? h('strong', { class: 'ellipsis' }, name) : h('button', { type: 'button', class: 'cp-link ellipsis', title: C('viewProfile', { name }), onclick: () => openProfile(r.userId) }, name),
          r.me ? h('span', { class: 'badge accent' }, C('you')) : null),
        h('div', { class: 'cp-bar', 'aria-hidden': 'true' }, h('i', { style: { width: `${r.pct}%` } }))),
      h('span', { class: 'cp-rank-value num' }, metricText(metric, r.value)));
  }

  async function load() {
    const my = ++seq;
    drawWeek();
    mount(list, skeleton('list', { rows: 4 }));
    let view;
    try {
      // Lo último que se jugó entra antes de mirar el ranking (como mucho una vez por minuto).
      if (week === thisWeek && shareEnabled() && Date.now() - reportedAt > 60000) {
        reportedAt = Date.now();
        await reportNow();
      }
      view = rankingView(await b.rpc('ranking_friends', { p_metric: metric, p_week: week }));
    } catch (err) {
      if (my !== seq || !root.isConnected) return;
      if (err?.code !== 'unavailable') console.warn('[compete] ranking', err?.message || err);
      drawShare(null);
      mount(list, h('div', { class: 'notice bad' }, icon('alert'), h('div', { class: 'spacer' }, errText(err)), h('button', { type: 'button', class: 'btn sm', onclick: load }, icon('refresh'), C('retry'))));
      return;
    }
    if (my !== seq || !root.isConnected) return;
    drawShare(view);
    const refresh = h('button', { type: 'button', class: 'icon-btn sm', title: C('refresh'), 'aria-label': C('refresh') }, icon('refresh'));
    refresh.addEventListener('click', async () => {
      const done = setBusy(refresh);
      try { await load(); } finally { done(); }
    });
    mount(list,
      h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, icon(METRIC_ICONS[metric]), metricName(metric)), refresh),
      view.rows.length
        ? h('ol', { class: 'cp-rank-list' }, view.rows.map(rowView))
        : emptyState('users', C('rankEmptyTitle'), C('rankEmptyText'), h('button', { type: 'button', class: 'btn sm', onclick: () => navigate('messages') }, icon('userPlus'), C('rankEmptyAction'))));
  }

  drawMetrics();
  mount(root,
    shareBox,
    clanSharing,
    h('div', { class: 'cp-controls' }, metricBar, h('div', { class: 'cp-week' }, prev, weekLabel, next)),
    list,
    h('p', { class: 'cp-note' }, icon('info'), h('span', {}, C('rankNote'))));
  drawShare(null);
  load();
  // Se prendió o se apagó desde Ajustes o desde otra PC.
  const off = store.on?.('settings', () => {
    if (root.isConnected && shareEnabled() !== sharing) afterShare();
  });
  return () => { seq++; off?.(); clanSharing.destroy(); };
}
