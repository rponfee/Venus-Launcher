// Pestaña Registro: lo que hizo cada admin (admin_actions), con filtros y páginas. Exporta también cómo se
// muestra una acción (lo usa la ficha del usuario).
import { h, icon, mount, selectEl, emptyState } from '../../ui.js';
import { T, call, fmtDateTime, fmtDay, fmtCents, card, errorBox, skeletonRows } from './parts.js';
import { discountText } from './coupons.js';

const DURATIONS = new Set(['1h', '24h', '7d', '30d', 'permanent']);

const ACTIONS = [
  'users.setPlan',
  'users.removePlan',
  'users.ban',
  'users.unban',
  'users.mute',
  'users.unmute',
  'users.signOut',
  'users.resetUsage',
  'users.delete',
  'users.setNotes',
  'stripe.cancelSubscription',
  'coupons.create',
  'coupons.addPromo',
  'coupons.deactivatePromo',
  'coupons.activatePromo',
  'coupons.delete',
  'plans.update',
  'plans.setPrice',
];
const KNOWN = new Set(ACTIONS);

export function actionLabel(action) {
  return KNOWN.has(action) ? T(`a_${action.replace('.', '_')}`) : action;
}

/** Resumen corto de los detalles (sin volcar el JSON entero). */
export function actionDetails(a) {
  const d = a && typeof a.details === 'object' && a.details ? a.details : {};
  const parts = [];
  if (d.planId) parts.push(T('d_plan', { plan: d.planId }));
  // Un cupón guarda { kind, value, duration, months }; un baneo o silencio, la duración elegida.
  if (a.action === 'coupons.create' && (d.kind === 'percent' || d.kind === 'amount')) {
    const text = discountText({ percentOff: d.kind === 'percent' ? d.value : null, amountOff: d.kind === 'amount' ? d.value : null, duration: d.duration, durationInMonths: d.months });
    if (text) parts.push(text);
  } else if (DURATIONS.has(d.duration)) parts.push(T(`dur_${d.duration}`));
  if (d.until && (a.action === 'users.setPlan' || !DURATIONS.has(d.duration))) parts.push(T('d_until', { date: fmtDay(d.until) }));
  if (d.reason) parts.push(`“${String(d.reason).slice(0, 80)}”`);
  if (d.scope === 'today' || d.scope === 'week') parts.push(T(`scope_${d.scope}`));
  if (d.note) parts.push(`“${String(d.note).slice(0, 60)}”`);
  if (d.when === 'now' || d.when === 'period_end') parts.push(T(`when_${d.when}`));
  if (d.promoCode || d.code) parts.push(T('d_code', { code: d.promoCode || d.code }));
  if (a.action === 'plans.setPrice' && d.amount) parts.push(T('d_price', { from: d.previousAmount ? fmtCents(d.previousAmount) : '—', to: fmtCents(d.amount) }));
  if (Array.isArray(d.canceledSubscriptions) && d.canceledSubscriptions.length) parts.push(T('d_canceled', { count: d.canceledSubscriptions.length }));
  if (d.stripeActive) parts.push(T('d_stripeActive'));
  return parts.join(' · ');
}

export function render(root, ctx) {
  const state = { action: '', page: 1, perPage: 50, data: null };
  const filter = selectEl(
    [
      { value: '', label: T('action_all') },
      { value: 'users.', label: T('group_users') },
      { value: 'coupons.', label: T('group_coupons') },
      { value: 'plans.', label: T('group_plans') },
      { value: 'stripe.', label: T('group_stripe') },
      ...ACTIONS.map((a) => ({ value: a, label: actionLabel(a) })),
    ],
    '',
    (v) => {
      state.action = v;
      state.page = 1;
      load();
    },
    'select',
  );
  filter.setAttribute('aria-label', T('filterAction'));
  const target = h('div', { class: 'adm-filter-note', hidden: true });
  const content = h('div', { class: 'adm-audit-body' });
  const pager = h('div', { class: 'adm-pager' });

  if (ctx.auditTarget) {
    state.target = ctx.auditTarget;
    target.hidden = false;
  }
  const drawTarget = () =>
    mount(
      target,
      state.target
        ? [icon('user'), T('auditFor', { name: state.target.name }), h('button', { class: 'btn sm ghost', type: 'button', onclick: () => ((state.target = null), (target.hidden = true), load()) }, icon('x'), T('clearFilter'))]
        : [],
    );
  drawTarget();

  mount(
    root,
    card(
      { icon: 'history', title: T('auditTitle'), sub: T('auditSub'), actions: [filter] },
      target,
      content,
      pager,
    ),
  );

  let seq = 0;
  async function load() {
    const my = ++seq;
    mount(content, skeletonRows(8));
    mount(pager);
    try {
      const data = await call('audit.list', { action: state.action || null, targetUser: state.target?.id || null, page: state.page, perPage: state.perPage });
      if (my !== seq || !root.isConnected) return;
      state.data = data;
      draw();
    } catch (err) {
      if (my !== seq) return;
      mount(content, errorBox(err, load));
    }
  }

  function draw() {
    const list = Array.isArray(state.data?.actions) ? state.data.actions : [];
    if (!list.length) {
      mount(content, emptyState('history', T('auditEmpty'), T('auditEmptyText')));
      return;
    }
    mount(
      content,
      h(
        'div',
        { class: 'adm-table-wrap' },
        h(
          'table',
          { class: 'table adm-table' },
          h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, T('colDate')), h('th', { scope: 'col', class: 'adm-col-admin' }, T('colAdmin')), h('th', { scope: 'col' }, T('colAction')), h('th', { scope: 'col' }, T('colTarget')), h('th', { scope: 'col' }, T('colDetails')))),
          h(
            'tbody',
            {},
            list.map((a) =>
              h(
                'tr',
                {},
                h('td', { class: 'adm-nowrap' }, fmtDateTime(a.createdAt)),
                h('td', { class: 'ellipsis adm-col-admin', title: a.adminEmail || '' }, a.adminEmail || '—'),
                h('td', {}, h('span', { class: ['badge', a.action.startsWith('users.delete') || a.action.endsWith('ban') ? 'bad' : a.action.startsWith('coupons') ? 'accent' : 'info'] }, actionLabel(a.action))),
                h(
                  'td',
                  { class: 'ellipsis adm-col-target' },
                  a.targetUser
                    ? a.targetEmail || a.targetUsername
                      ? h('button', { class: 'adm-link', type: 'button', onclick: () => ctx.openUser(a.targetUser, a.targetUsername || a.targetEmail) }, a.targetUsername || a.targetEmail)
                      : h('span', { class: 'muted' }, a.details?.email || a.details?.username ? `${a.details.username || a.details.email} (${T('deletedUser')})` : T('deletedUser'))
                    : '—',
                ),
                h('td', { class: 'adm-col-details small text-2' }, actionDetails(a)),
              ),
            ),
          ),
        ),
      ),
    );
    const total = Number(state.data?.total) || 0;
    const from = (state.page - 1) * state.perPage + 1;
    const to = Math.min(total, state.page * state.perPage);
    mount(
      pager,
      h('span', { class: 'muted small num' }, T('pageInfo', { from, to, total })),
      h('button', { class: 'btn sm', type: 'button', disabled: state.page <= 1, onclick: () => ((state.page -= 1), load()) }, icon('chevronLeft'), T('prev')),
      h('button', { class: 'btn sm', type: 'button', disabled: to >= total, onclick: () => ((state.page += 1), load()) }, T('next'), icon('chevronRight')),
    );
  }

  load();
  return {
    refresh: load,
    filterUser(user) {
      state.target = user;
      state.page = 1;
      target.hidden = !user;
      drawTarget();
      load();
    },
  };
}
