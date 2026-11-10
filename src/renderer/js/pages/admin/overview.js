// Pestaña Resumen: lo pendiente (accesos directos a Soporte, Denuncias, Galería y Pagos), las claves e integraciones
// que faltan, el acceso actual, los pagos únicos confirmados y el uso de la IA del mes (por motor si el servidor lo
// informa con admin_ai_providers, de 0056; si no, ese bloque no se muestra). Cada bloque carga por su cuenta: si uno
// falla, el resto se ve igual. La lógica sin DOM está en team-logic.js.
import { h, icon, mount } from '../../ui.js';
import { T, call, rpc, fmtUsd, fmtInt, fmtDay, fmtRelative, kpi, card, errorBox, skeletonRows } from './parts.js';
import { planOverviewRows } from '../../features/plans-catalog.js';
import { KEY_CHECKS, keyState, paymentsState, keyAlerts, engineKeyStates, aiByEngine, pendingShortcuts } from './team-logic.js';

const metric = (value, format) => value == null ? '—' : format(value);
const settle = (p) => p.then((data) => ({ ok: true, data }), (error) => ({ ok: false, error }));
const PENDING_ICON = { tickets: 'message', reports: 'alert', gallery: 'camera', payments: 'card' };
const STATE_PILL = { ok: ['good', 'check'], missing: ['bad', 'alert'], notReady: ['warn', 'clock'], unknown: ['', 'info'] };

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

// Uso por motor (Claude / ChatGPT): gasto del mes, llamadas y saldos comprados que siguen vigentes.
function enginesCard(engines, since) {
  const total = Math.max(0.0001, ...engines.map((e) => e.usd));
  return card(
    { icon: 'cpu', title: T('ov_enginesTitle'), sub: since ? T('byModelSub', { date: fmtDay(`${since}T12:00:00Z`) }) : null },
    h(
      'div',
      { class: 'adm-engines' },
      engines.map((e) =>
        h(
          'div',
          { class: 'adm-engine', dataset: { engine: e.engine } },
          h('div', { class: 'row between' }, h('b', {}, T(`engine_${e.engine}`)), h('span', { class: 'adm-engine-usd num' }, fmtUsd(e.usd, { precise: true }))),
          h('span', { class: 'adm-bar', 'aria-hidden': 'true' }, h('i', { style: { width: `${Math.round((e.usd / total) * 100)}%` } })),
          h('div', { class: 'tiny muted' }, T('ov_engineFoot', { calls: fmtInt(e.calls), wallets: fmtInt(e.wallets), left: fmtUsd(e.walletsLeftUsd) })),
        ),
      ),
    ),
  );
}

export function render(root, ctx = {}) {
  let alive = true;
  const go = (tab) => ctx.goTab?.(tab);
  const topHost = h('div', { class: 'stack adm-ov-top' });
  const mainHost = h('div', { class: 'stack' });
  const engineHost = h('div');
  const keysHost = h('div');

  // ---------- Lo pendiente y las claves (RPC directas; cada una puede fallar sola) ----------
  async function loadSide() {
    mount(keysHost, card({ icon: 'key', title: T('ov_keysTitle') }, skeletonRows(4)));
    const [providers, tickets, reports, gallery, orders, payments, ...status] = await Promise.all([
      settle(rpc('admin_ai_providers')),
      settle(rpc('support_queue', { p_filter: { status: 'waiting', limit: 1 } })),
      settle(rpc('admin_profile_reports')),
      settle(rpc('admin_gallery_list', { p_filter: 'reported', p_offset: 0 })),
      settle(call('payments.orders')),
      settle(call('payments.get')),
      ...KEY_CHECKS.map((k) => (k.rpc ? settle(rpc(k.rpc)) : Promise.resolve(null))),
    ]);
    if (!alive || !root.isConnected) return;
    const states = {};
    KEY_CHECKS.forEach((k, i) => {
      states[k.id] = k.id === 'payments' ? paymentsState(payments) : keyState(status[i]);
    });
    // admin_ai_providers sabe si están las dos claves aunque falte una función de estado.
    const engineKeys = providers.ok ? engineKeyStates(providers.data) : null;
    if (engineKeys) for (const id of ['anthropic', 'openai']) if (engineKeys[id] !== 'unknown') states[id] = engineKeys[id];

    const counts = {
      tickets: tickets.ok ? Number(tickets.data?.counts?.waiting) : null,
      reports: reports.ok && Array.isArray(reports.data) ? reports.data.filter((r) => r?.status === 'open').length : null,
      gallery: gallery.ok && Array.isArray(gallery.data?.items) ? gallery.data.items.length : null,
      payments: orders.ok && Array.isArray(orders.data?.orders) ? orders.data.orders.filter((o) => o?.status === 'pending').length : null,
    };
    const pending = pendingShortcuts(counts);
    const unread = Object.keys(counts).filter((k) => counts[k] === null || Number.isNaN(counts[k]));
    const missing = keyAlerts(states);
    mount(
      topHost,
      missing.length
        ? h('div', { class: 'notice bad adm-key-alert', role: 'alert' }, icon('key'), h('div', { class: 'spacer' }, T('ov_keysMissing', { list: missing.map((id) => T(`key_${id}`)).join(', ') })), h('button', { class: 'btn sm', type: 'button', onclick: () => go(missing.includes('payments') && missing.length === 1 ? 'payments' : 'integrations') }, icon('plug'), T('ov_keysFix')))
        : null,
      card(
        { icon: 'bell', title: T('ov_pendingTitle') },
        pending.length
          ? h('div', { class: 'row wrap adm-pending' }, pending.map((p) => h('button', { class: 'chip adm-alert-chip', type: 'button', dataset: { pending: p.id }, onclick: () => go(p.tab) }, icon(PENDING_ICON[p.id]), T(`pending_${p.id}`, { count: p.count, value: fmtInt(p.count) }), p.id === 'gallery' && gallery.data?.more ? '+' : null)))
          : h('p', { class: 'muted small adm-empty-line' }, icon('check'), ' ', T('ov_pendingNone')),
        unread.length === Object.keys(counts).length ? null : unread.length ? h('p', { class: 'tiny muted' }, T('ov_pendingUnknown', { list: unread.map((k) => T(`pendingName_${k}`)).join(', ') })) : null,
      ),
    );
    mount(
      keysHost,
      card(
        { icon: 'key', title: T('ov_keysTitle'), sub: T('ov_keysSub'), actions: [h('button', { class: 'btn sm', type: 'button', onclick: () => go('integrations') }, icon('plug'), T('tab_integrations'))] },
        h(
          'ul',
          { class: 'adm-keys' },
          KEY_CHECKS.map((k) => {
            const [tone, ic] = STATE_PILL[states[k.id]] || STATE_PILL.unknown;
            return h('li', { class: 'adm-key', dataset: { key: k.id } }, h('span', {}, T(`key_${k.id}`)), h('span', { class: ['pill', tone] }, icon(ic), T(`keyState_${states[k.id] || 'unknown'}`)));
          }),
        ),
      ),
    );
    const engines = providers.ok ? aiByEngine(providers.data) : null;
    mount(engineHost, engines ? enginesCard(engines, providers.data?.since) : null);
  }

  async function load() {
    mount(mainHost, h('div', { class: 'adm-kpis' }, Array.from({ length: 5 }, () => h('div', { class: 'card kpi adm-kpi' }, skeletonRows(3)))), skeletonRows(6));
    loadSide();
    let d;
    try {
      d = await call('overview');
    } catch (err) {
      if (alive && root.isConnected) mount(mainHost, errorBox(err, load), engineHost, keysHost);
      return;
    }
    if (!alive || !root.isConnected) return;
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
      mainHost,
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
        h('div', { class: 'stack' }, engineHost, card({ icon: 'cpu', title: T('byModelTitle'), sub: ai.since ? T('byModelSub', { date: fmtDay(`${ai.since}T12:00:00Z`) }) : null }, modelsTable(ai.byModel)), keysHost),
      ),
      h('p', { class: 'tiny muted adm-generated' }, T('generatedAt', { time: fmtRelative(d.generatedAt) }), d.stripe?.configured ? ` · ${T(`stripeMode_${d.stripe.mode}`)}` : ''),
    );
  }

  mount(root, topHost, mainHost);
  load();
  return {
    refresh: load,
    destroy() {
      alive = false;
    },
  };
}
