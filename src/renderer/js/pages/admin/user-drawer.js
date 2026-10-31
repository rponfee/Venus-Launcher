// Ficha de un usuario (panel lateral): cuenta, plan con los ids de Stripe, uso de la IA por modelo, moderación con
// notas internas, acciones recientes de admins y las mismas acciones del lote para esta cuenta.
import { navigate } from '../../app.js';
import { h, icon, mount, modal, setBusy, ok, copyText } from '../../ui.js';
import { T, call, fmtUsd, fmtInt, fmtDay, fmtDateTime, fmtRelative, isPermanent, planBadge, statePills, errorBox, skeletonRows, showBulkResult, failAction } from './parts.js';
import { removePlanDialog, banDialog, muteDialog, simpleAction, resetUsageDialog, deleteDialog, cancelStripeDialog } from './dialogs.js';
import { actionLabel, actionDetails } from './audit.js';

function row(label, value, { copy, mono } = {}) {
  return h(
    'div',
    { class: 'adm-dl-row' },
    h('dt', {}, label),
    h(
      'dd',
      { class: mono ? 'mono wrap-anywhere' : null },
      value ?? '—',
      copy ? h('button', { class: 'icon-btn sm adm-copy', type: 'button', title: T('copy'), 'aria-label': T('copyWhat', { what: label }), onclick: () => copyText(String(copy)) }, icon('copy')) : null,
    ),
  );
}

function section(iconName, title, ...body) {
  return h('section', { class: 'adm-drawer-sec' }, h('h4', { class: 'adm-drawer-title' }, icon(iconName), title), ...body);
}

function account(d) {
  const a = d.account || {};
  const p = d.profile || {};
  return section(
    'user',
    T('sec_account'),
    h(
      'dl',
      { class: 'adm-dl' },
      row(T('f_email'), a.email, { copy: a.email }),
      row(T('f_id'), a.id, { copy: a.id, mono: true }),
      row(T('f_friendCode'), p.friendCode, { copy: p.friendCode, mono: true }),
      row(T('f_mcName'), p.mcName),
      row(T('f_confirmed'), a.emailConfirmed ? T('yesDate', { date: fmtDay(a.emailConfirmedAt) }) : T('no')),
      row(T('f_providers'), (a.providers || []).join(', ') || '—'),
      row(T('f_created'), fmtDateTime(a.createdAt)),
      row(T('f_lastSignIn'), a.lastSignInAt ? `${fmtDateTime(a.lastSignInAt)} · ${fmtRelative(a.lastSignInAt)}` : T('never')),
    ),
  );
}

function plan(d, onCancelStripe) {
  const s = d.subscription;
  if (!s) return section('sparkles', T('sec_plan'), h('p', { class: 'muted small' }, T('noPlanEver')));
  const items = [
    row(T('f_plan'), h('span', { class: 'row' }, planBadge({ id: s.planId, name: s.planName, active: s.active, source: s.source }), s.active ? T('planActive') : T('planInactive'))),
    row(T('f_status'), s.stripeStatus ? `${s.status} · Stripe: ${s.stripeStatus}` : s.status),
    row(T('f_source'), ['support', 'stripe', 'admin', 'manual'].includes(s.source) ? T(`source_${s.source}`) : s.source),
    row(T('f_periodEnd'), s.currentPeriodEnd ? fmtDateTime(s.currentPeriodEnd) : T('planNoEnd')),
  ];
  if (s.cancelAtPeriodEnd) items.push(row(T('f_cancel'), T('cancelsAtEnd')));
  if (s.graceUntil) items.push(row(T('f_grace'), fmtDateTime(s.graceUntil)));
  const customer = d.stripeCustomer?.customerId || s.stripeCustomerId;
  if (customer) items.push(row(T('f_customer'), customer, { copy: customer, mono: true }));
  if (s.stripeSubscriptionId) items.push(row(T('f_subscription'), s.stripeSubscriptionId, { copy: s.stripeSubscriptionId, mono: true }));
  if (s.stripePriceId) items.push(row(T('f_price'), s.stripePriceId, { mono: true }));
  if (s.lastSyncedAt) items.push(row(T('f_synced'), fmtDateTime(s.lastSyncedAt)));
  return section(
    'sparkles',
    T('sec_plan'),
    h('dl', { class: 'adm-dl' }, items),
    s.managedByStripe || customer
      ? h(
          'div',
          { class: 'notice info adm-drawer-notice' },
          icon('info'),
          h('div', { class: 'spacer' }, T('stripeManagedNotice')),
          d.stripe?.configured ? h('button', { class: 'btn sm danger', type: 'button', onclick: onCancelStripe }, icon('x'), T('act_cancelStripe')) : null,
        )
      : null,
  );
}

function usage(d) {
  const u = d.usage || {};
  const models = Array.isArray(u.models) ? u.models : [];
  const quota = u.quota && u.quota.plan ? u.quota : null;
  const totals = u.totals || {};
  const budget = quota?.budget;
  const head = h(
    'div',
    { class: 'adm-usage-head' },
    ['today', 'week', 'month'].map((k) =>
      h('div', { class: 'adm-usage-cell' }, h('div', { class: 'muted small' }, T(`usage_${k}`)), h('div', { class: 'adm-usage-value num' }, fmtUsd(totals[k]?.usd, { precise: true })), h('div', { class: 'tiny muted' }, T('questions', { count: totals[k]?.questions || 0, value: fmtInt(totals[k]?.questions || 0) }))),
    ),
  );
  const bar = budget && budget.limitUsd > 0
    ? h(
        'div',
        { class: 'adm-budget' },
        h('div', { class: 'row between small' }, h('span', {}, T('budget')), h('span', { class: 'num' }, T('budgetValue', { used: fmtUsd(budget.usedUsd, { precise: true }), limit: fmtUsd(budget.limitUsd) }))),
        h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.min(100, Math.round((budget.usedUsd / budget.limitUsd) * 100)), 'aria-label': T('budget') }, h('i', { style: { width: `${Math.min(100, (budget.usedUsd / budget.limitUsd) * 100)}%` } })),
      )
    : null;
  const table = models.length
    ? h(
        'table',
        { class: 'table adm-table-compact' },
        h('thead', {}, h('tr', {}, h('th', {}, T('colModel')), h('th', { class: 'num' }, T('usage_week')), h('th', { class: 'num' }, T('usage_month')), h('th', { class: 'num' }, T('colQuestionsLimit')))),
        h(
          'tbody',
          {},
          models.map((m) => {
            const q = quota?.models?.find((x) => x.id === m.model);
            return h(
              'tr',
              {},
              h('td', {}, m.label || m.model),
              h('td', { class: 'num' }, fmtUsd(m.week?.usd, { precise: true }), h('div', { class: 'tiny muted' }, fmtInt(m.week?.questions || 0))),
              h('td', { class: 'num' }, fmtUsd(m.month?.usd, { precise: true }), h('div', { class: 'tiny muted' }, fmtInt(m.month?.questions || 0))),
              h('td', { class: 'num' }, q ? T('quotaCell', {
                day: fmtInt(q.daily?.used), dayLimit: q.daily?.limit == null || q.daily.limit >= 2147483647 ? '∞' : fmtInt(q.daily.limit),
                week: fmtInt(q.weekly?.used), weekLimit: q.weekly?.limit == null || q.weekly.limit >= 2147483647 ? '∞' : fmtInt(q.weekly.limit),
              }) : '—'),
            );
          }),
        ),
      )
    : h('p', { class: 'muted small' }, T('noUsage'));
  return section('activity', T('sec_usage'), head, bar, table);
}

function moderation(d, userId, refresh) {
  const m = d.moderation || {};
  const lines = [];
  if (m.banned) lines.push(h('div', { class: 'pill bad' }, icon('ban'), isPermanent(m.bannedUntil) ? T('modBannedPermanent') : T('modBanned', { date: fmtDateTime(m.bannedUntil) })));
  if (m.muted) lines.push(h('div', { class: 'pill warn' }, icon('volumeX'), isPermanent(m.mutedUntil) ? T('modMutedPermanent') : T('modMuted', { date: fmtDateTime(m.mutedUntil) })));
  if (!lines.length) lines.push(h('div', { class: 'pill good' }, icon('check'), T('modClean')));
  const reasons = [];
  if (m.banned && m.banReason) reasons.push(h('p', { class: 'small text-2' }, T('modBanReason', { reason: m.banReason })));
  if (m.muted && m.muteReason) reasons.push(h('p', { class: 'small text-2' }, T('modMuteReason', { reason: m.muteReason })));
  const notes = h('textarea', { class: 'textarea', rows: 3, maxlength: 2000, id: 'adm-notes', placeholder: T('notesPlaceholder') });
  notes.value = m.notes || '';
  const save = h('button', { class: 'btn sm', type: 'button' }, icon('save'), T('saveNotes'));
  save.addEventListener('click', async () => {
    const done = setBusy(save);
    try {
      await call('users.setNotes', { id: userId, notes: notes.value.trim() || null });
      ok(T('notesSaved'));
      refresh();
    } catch (err) {
      failAction(err);
    } finally {
      done();
    }
  });
  return section(
    'shield',
    T('sec_moderation'),
    h('div', { class: 'row wrap' }, lines),
    ...reasons,
    m.updatedAt && (m.banned || m.muted) ? h('p', { class: 'tiny muted' }, T('modUpdated', { date: fmtDateTime(m.updatedAt), admin: m.updatedByEmail || '—' })) : null,
    h('div', { class: 'field' }, h('label', { for: 'adm-notes' }, T('notesLabel')), notes, h('div', { class: 'field-help' }, T('notesHelp'))),
    h('div', { class: 'row' }, save),
  );
}

function actions(d) {
  const list = Array.isArray(d.actions) ? d.actions : [];
  return section(
    'history',
    T('sec_actions'),
    list.length
      ? h(
          'ul',
          { class: 'adm-timeline' },
          list.map((a) =>
            h('li', {}, h('div', { class: 'adm-tl-main' }, h('b', {}, actionLabel(a.action)), ' ', h('span', { class: 'muted' }, actionDetails(a))), h('div', { class: 'tiny muted' }, `${fmtDateTime(a.createdAt)} · ${a.adminEmail || '—'}`)),
          ),
        )
      : h('p', { class: 'muted small' }, T('noActions')),
  );
}

/**
 * Abre la ficha. opts: { onChanged() (para refrescar la lista),
 * selfId (el admin: sin acciones de moderación sobre sí mismo) }.
 */
export function openUserDrawer(userId, opts = {}) {
  const body = h('div', { class: 'adm-drawer-body' }, skeletonRows(10));
  const foot = h('div', { class: 'adm-drawer-foot' });
  const m = modal({ title: T('drawerTitle'), body, footer: foot, size: 'adm-drawer' });
  let detail = null;

  const user = () => ({ id: userId, name: detail?.profile?.username || detail?.account?.email || opts.name || userId });

  async function act(run, { deletes = false } = {}) {
    let res;
    try {
      res = await run();
    } catch (err) {
      failAction(err);
      return;
    }
    if (!res) return;
    if (Array.isArray(res.results)) showBulkResult(res, { names: new Map([[userId, user().name]]), onCancelStripe: () => cancelStripe() });
    opts.onChanged?.();
    // La cuenta ya no existe: se cierra la ficha.
    if (deletes && res.results?.[0]?.ok) {
      m.close();
      return;
    }
    load();
  }

  async function cancelStripe() {
    const res = await cancelStripeDialog(user());
    if (!res) return;
    ok(res.canceled?.length ? T('stripeCanceled', { count: res.canceled.length }) : T('stripeNothing'));
    opts.onChanged?.();
    load();
  }

  function drawFoot() {
    const isSelf = opts.selfId === userId;
    const isAdmin = detail?.account?.isAdmin;
    const protect = isSelf || isAdmin;
    const mod = detail?.moderation || {};
    const u = [user()];
    const btn = (label, ic, run, cls = '', flags) => h('button', { class: `btn sm ${cls}`, type: 'button', onclick: () => act(run, flags) }, icon(ic), label);
    mount(
      foot,
      h(
        'div',
        { class: 'adm-drawer-actions' },
        h('button', { class: 'btn sm', type: 'button', onclick: () => { m.close(); navigate('admin/payments'); } }, icon('card'), T('act_supportPayment')),
        detail?.subscription ? btn(T('act_removePlan'), 'x', () => removePlanDialog(u)) : null,
        btn(T('act_resetUsage'), 'refresh', () => resetUsageDialog(u)),
        protect ? null : btn(T('act_signOut'), 'logout', () => simpleAction(u, 'users.signOut')),
        protect ? null : mod.muted ? btn(T('act_unmute'), 'volume', () => simpleAction(u, 'users.unmute')) : btn(T('act_mute'), 'volumeX', () => muteDialog(u)),
        mod.banned ? btn(T('act_unban'), 'check', () => simpleAction(u, 'users.unban')) : null,
      ),
      protect
        ? h('p', { class: 'tiny muted adm-protect' }, icon('shieldCheck'), isSelf ? T('protectSelf') : T('protectAdmin'))
        : h(
            'div',
            { class: 'adm-drawer-danger', role: 'group', 'aria-label': T('sec_danger') },
            mod.banned ? null : btn(T('act_ban'), 'ban', () => banDialog(u), 'danger'),
            btn(T('act_delete'), 'trash', () => deleteDialog(u), 'danger', { deletes: true }),
          ),
    );
  }

  async function load() {
    try {
      detail = await call('users.get', { id: userId });
    } catch (err) {
      mount(body, errorBox(err, load));
      mount(foot);
      return;
    }
    if (!body.isConnected) return;
    const a = detail.account || {};
    const pseudo = { ...a, username: detail.profile?.username, isAdmin: a.isAdmin, moderation: detail.moderation, plan: detail.subscription ? { stripeStatus: detail.subscription.stripeStatus, active: detail.subscription.active, cancelAtPeriodEnd: detail.subscription.cancelAtPeriodEnd } : null };
    mount(
      body,
      h(
        'div',
        { class: 'adm-drawer-hero' },
        h('div', { class: 'adm-avatar', 'aria-hidden': 'true' }, (detail.profile?.username || a.email || '?').slice(0, 1).toUpperCase()),
        h('div', { class: 'adm-drawer-who' }, h('div', { class: 'adm-drawer-name ellipsis', title: detail.profile?.username || a.email }, detail.profile?.username || a.email), h('div', { class: 'muted small ellipsis' }, a.email), h('div', { class: 'row wrap adm-pills' }, statePills(pseudo))),
      ),
      account(detail),
      plan(detail, cancelStripe),
      usage(detail),
      moderation(detail, userId, load),
      actions(detail),
    );
    drawFoot();
  }

  load();
  return m;
}
