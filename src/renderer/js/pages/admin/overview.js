// Pestaña Resumen: acceso actual y pagos únicos confirmados en Soporte.
import { h, icon, mount } from '../../ui.js';
import { T, call, fmtUsd, fmtInt, fmtDay, fmtRelative, kpi, card, errorBox, skeletonRows } from './parts.js';
import { planOverviewRows } from '../../features/plans-catalog.js';

const metric = (value, format) => value == null ? '—' : format(value);

function plansTable(byPlan, paymentsReady) {
  const rows = planOverviewRows(byPlan, paymentsReady);
  const max = Math.max(1, ...rows.map((p) => p.active));
  return h(
    'div',
    { class: 'adm-table-wrap' },
    h(
      'table',
      { class: 'table adm-table' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, T('colPlan')), h('th', { scope: 'col', class: 'num' }, T('colActive')), h('th', { scope: 'col', class: 'num' }, T('colSupport')), h('th', { scope: 'col', class: 'num' }, T('colManual')), h('th', { scope: 'col', class: 'num' }, T('colPaymentPrice')), h('th', { scope: 'col', class: 'num' }, T('colConfirmed')))),
      h(
        'tbody',
        {},
        rows.map((p) =>
          h(
            'tr',
            {},
            h('td', {}, h('div', { class: 'adm-bar-cell' }, h('span', { class: 'adm-plan-name' }, p.name, p.planActive ? null : h('span', { class: 'badge adm-plan-off' }, T('planOff'))), h('span', { class: 'adm-bar', 'aria-hidden': 'true' }, h('i', { style: { width: `${Math.round((p.active / max) * 100)}%` } })))),
            h('td', { class: 'num' }, metric(p.active, fmtInt)),
            h('td', { class: 'num' }, metric(p.paying, fmtInt)),
            h('td', { class: 'num' }, metric(p.manual, fmtInt)),
            h('td', { class: 'num' }, fmtUsd(p.priceUsd)),
            h('td', { class: 'num' }, metric(p.confirmedUsd, fmtUsd)),
          ),
        ),
      ),
    ),
  );
}

function modelsTable(byModel) {
  const rows = byModel || [];
  if (!rows.length) return h('p', { class: 'muted small adm-empty-line' }, T('noSpend'));
  return h(
    'table',
    { class: 'table adm-table' },
    h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, T('colModel')), h('th', { scope: 'col', class: 'num' }, T('colSpend')), h('th', { scope: 'col', class: 'num' }, T('colQuestions')), h('th', { scope: 'col', class: 'num' }, T('colCalls')))),
    h('tbody', {}, rows.map((m) => h('tr', {}, h('td', {}, m.label || m.model), h('td', { class: 'num' }, fmtUsd(m.usd, { precise: true })), h('td', { class: 'num' }, fmtInt(m.questions)), h('td', { class: 'num' }, fmtInt(m.calls))))),
  );
}

export function render(root, ctx) {
  async function load() {
    mount(root, h('div', { class: 'adm-kpis' }, Array.from({ length: 5 }, () => h('div', { class: 'card kpi adm-kpi' }, skeletonRows(3)))), skeletonRows(6));
    let d;
    try {
      d = await call('overview');
    } catch (err) {
      if (root.isConnected) mount(root, errorBox(err, load));
      return;
    }
    if (!root.isConnected) return;
    const u = d.users || {};
    const s = d.subscriptions || {};
    const ai = d.ai || {};
    const revenue = d.revenue || {};
    const paymentsReady = revenue.mode === 'one_time';
    const alerts = [];
    if (!paymentsReady) alerts.push(h('div', { class: 'notice' }, icon('alert'), h('div', {}, T('paymentMetricsPending'))));
    if (s.legacy) alerts.push(h('button', { class: 'chip adm-alert-chip', type: 'button', onclick: () => ctx.goUsers({}) }, icon('history'), T('legacyAccounts', { count: s.legacy })));
    if (s.pastDue) alerts.push(h('button', { class: 'chip adm-alert-chip', type: 'button', onclick: () => ctx.goUsers({ status: 'past_due' }) }, icon('alert'), T('alertPastDue', { count: s.pastDue })));
    if (s.canceling) alerts.push(h('button', { class: 'chip adm-alert-chip', type: 'button', onclick: () => ctx.goUsers({ status: 'canceling' }) }, icon('clock'), T('alertCanceling', { count: s.canceling })));
    mount(
      root,
      h(
        'div',
        { class: 'adm-kpis' },
        kpi({ icon: 'users', label: T('kpiUsers'), value: fmtInt(u.total), foot: T('kpiUsersFoot', { new7: fmtInt(u.new7d), new30: fmtInt(u.new30d) }) }),
        kpi({ icon: 'sparkles', label: T('kpiAccess'), value: fmtInt(s.active), foot: paymentsReady ? T('kpiAccessFoot', { paying: fmtInt(s.support ?? s.paying), manual: fmtInt(s.manual) }) : T('paymentMetricsPendingShort') }),
        kpi({ icon: 'trending', label: T('kpiConfirmed'), value: paymentsReady ? metric(revenue.confirmedUsd, fmtUsd) : '—', foot: paymentsReady ? T('kpiConfirmedFoot', { count: fmtInt(revenue.confirmedPayments), month: fmtUsd(revenue.monthUsd) }) : T('paymentMetricsPendingShort'), tone: 'accent' }),
        kpi({ icon: 'cpu', label: T('kpiAi'), value: fmtUsd(ai.monthUsd), foot: T('kpiAiFoot', { questions: fmtInt(ai.monthQuestions), users: fmtInt(ai.activeUsers) }) }),
        kpi({ icon: 'shield', label: T('kpiBanned'), value: fmtInt(u.banned), foot: T('kpiMutedFoot', { muted: fmtInt(u.muted) }), tone: u.banned ? 'bad' : null }),
      ),
      alerts.length ? h('div', { class: 'adm-alerts row wrap' }, alerts) : null,
      h(
        'div',
        { class: 'adm-grid-2' },
        card({ icon: 'layers', title: T('byPlanTitle'), sub: T('byPlanSub') }, plansTable(s.byPlan, paymentsReady)),
        card({ icon: 'cpu', title: T('byModelTitle'), sub: ai.since ? T('byModelSub', { date: fmtDay(`${ai.since}T12:00:00Z`) }) : null }, modelsTable(ai.byModel)),
      ),
      h('p', { class: 'tiny muted adm-generated' }, T('generatedAt', { time: fmtRelative(d.generatedAt) }), d.stripe?.configured ? ` · ${T(`stripeMode_${d.stripe.mode}`)}` : ''),
    );
  }
  load();
  return { refresh: load };
}
