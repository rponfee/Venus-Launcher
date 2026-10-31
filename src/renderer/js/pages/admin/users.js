// Pestaña Usuarios: búsqueda, filtros, tabla paginada con selección múltiple, ficha lateral y acciones en lote.
import { navigate } from '../../app.js';
import { h, icon, mount, selectEl, debounce, emptyState } from '../../ui.js';
import { T, call, fmtUsd, fmtInt, fmtDay, fmtRelative, planBadge, statePills, displayName, errorBox, skeletonRows, showBulkResult, failAction } from './parts.js';
import { removePlanDialog, banDialog, muteDialog, simpleAction, resetUsageDialog, deleteDialog, cancelStripeDialog } from './dialogs.js';
import { openUserDrawer } from './user-drawer.js';

const PER_PAGE = 25;
const STATUSES = ['active', 'inactive', 'none', 'past_due', 'canceling', 'stripe'];
const SORTS = ['created', 'lastSignIn', 'spend', 'email'];

export function render(root, ctx) {
  const state = { search: '', plan: '', status: '', moderation: 'all', sort: 'created', page: 1, data: null, loading: false };
  // Filtro inicial (por ejemplo, desde los avisos del Resumen: "pagos fallidos").
  const init = (ctx.takeUsersFilter && ctx.takeUsersFilter()) || {};
  if (STATUSES.includes(init.status)) state.status = init.status;
  if (init.moderation === 'banned' || init.moderation === 'muted') state.moderation = init.moderation;
  const selected = new Map(); // id -> nombre (persiste entre páginas)

  // ---------- Barra de filtros ----------
  const search = h('input', { class: 'input', type: 'search', placeholder: T('searchPlaceholder'), 'aria-label': T('searchLabel'), maxlength: 100 });
  const planSel = selectEl([{ value: '', label: T('filterPlanAll') }, { value: 'none', label: T('filterPlanNone') }], '', (v) => setFilter({ plan: v }), 'select adm-select');
  planSel.setAttribute('aria-label', T('filterPlan'));
  const statusSel = selectEl([{ value: '', label: T('status_all') }, ...STATUSES.map((s) => ({ value: s, label: T(`status_${s}`) }))], state.status, (v) => setFilter({ status: v }), 'select adm-select');
  statusSel.setAttribute('aria-label', T('filterStatus'));
  const sortSel = selectEl(SORTS.map((s) => ({ value: s, label: T(`sort_${s}`) })), 'created', (v) => setFilter({ sort: v }), 'select adm-select');
  sortSel.setAttribute('aria-label', T('sortLabel'));
  const modSeg = h('div', { class: 'segmented adm-seg', role: 'group', 'aria-label': T('filterModeration') });
  const drawSeg = () =>
    mount(
      modSeg,
      ['all', 'banned', 'muted'].map((id) =>
        h(
          'button',
          { type: 'button', class: state.moderation === id ? 'active' : null, 'aria-pressed': String(state.moderation === id), onclick: () => state.moderation !== id && setFilter({ moderation: id }) },
          id === 'banned' ? icon('ban') : id === 'muted' ? icon('volumeX') : null,
          T(`mod_${id}`),
        ),
      ),
    );
  drawSeg();
  search.addEventListener('input', debounce(() => setFilter({ search: search.value.trim() }), 300));
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') setFilter({ search: search.value.trim() });
  });

  // Ofertas actuales para el filtro. Los registros históricos siguen visibles en "Todos".
  ctx.plans().then((plans) => {
    for (const p of plans) planSel.append(h('option', { value: p.id }, p.active ? p.name : `${p.name} (${T('planOff')})`));
  }).catch(() => {});

  const toolbar = h(
    'div',
    { class: 'adm-toolbar' },
    h('div', { class: 'input-icon adm-search' }, icon('search'), search),
    planSel,
    statusSel,
    modSeg,
    h('div', { class: 'spacer' }),
    h('button', { class: 'btn sm', type: 'button', onclick: () => navigate('admin/payments') }, icon('card'), T('act_supportPayment')),
    h('label', { class: 'adm-sort' }, h('span', { class: 'muted small' }, T('sortLabel')), sortSel),
  );

  // ---------- Barra de acciones en lote ----------
  const bulkBar = h('div', { class: 'adm-bulk', role: 'region', 'aria-label': T('actionsLabel'), hidden: true });
  const selectedUsers = () => [...selected].map(([id, name]) => ({ id, name }));

  async function runBulk(open) {
    const users = selectedUsers();
    if (!users.length) return;
    let res;
    try {
      res = await open(users);
    } catch (err) {
      failAction(err);
      return;
    }
    if (!res) return;
    showBulkResult(res, { names: new Map(users.map((u) => [u.id, u.name])), onCancelStripe: cancelStripe });
    // Los borrados ya no existen: salen de la selección.
    for (const r of res.results || []) if (r.ok && open === deleteDialog) selected.delete(r.id);
    load();
  }

  async function cancelStripe(id, name) {
    try {
      const res = await cancelStripeDialog({ id, name });
      if (res) load();
    } catch (err) {
      failAction(err);
    }
  }

  function drawBulk() {
    bulkBar.hidden = selected.size === 0;
    if (!selected.size) return mount(bulkBar);
    const btn = (label, ic, open, cls = '') => h('button', { class: `btn sm ${cls}`, type: 'button', onclick: () => runBulk(open) }, icon(ic), label);
    mount(
      bulkBar,
      h('div', { class: 'adm-bulk-count' }, h('b', { class: 'num' }, T('selectedCount', { count: selected.size })), h('button', { class: 'btn sm ghost', type: 'button', onclick: () => (selected.clear(), drawTable(), drawBulk()) }, icon('x'), T('clearSelection'))),
      h(
        'div',
        { class: 'adm-bulk-actions' },
        btn(T('act_removePlan'), 'x', removePlanDialog),
        btn(T('act_resetUsage'), 'refresh', resetUsageDialog),
        btn(T('act_signOut'), 'logout', (u) => simpleAction(u, 'users.signOut')),
        btn(T('act_mute'), 'volumeX', muteDialog),
        btn(T('act_unmute'), 'volume', (u) => simpleAction(u, 'users.unmute')),
        btn(T('act_unban'), 'check', (u) => simpleAction(u, 'users.unban')),
      ),
      h('div', { class: 'adm-bulk-danger', role: 'group', 'aria-label': T('sec_danger') }, btn(T('act_ban'), 'ban', banDialog, 'danger'), btn(T('act_delete'), 'trash', deleteDialog, 'danger')),
    );
  }

  // ---------- Tabla ----------
  const tableHost = h('div', { class: 'adm-table-host' });
  const pager = h('div', { class: 'adm-pager' });

  function setFilter(patch) {
    const before = JSON.stringify([state.search, state.plan, state.status, state.moderation, state.sort]);
    Object.assign(state, patch);
    if (JSON.stringify([state.search, state.plan, state.status, state.moderation, state.sort]) === before) return;
    state.page = 1;
    if ('moderation' in patch) drawSeg();
    selected.clear(); // con otros filtros, la selección podría tener usuarios que ya no se ven
    drawBulk();
    load();
  }

  const openUser = (u) =>
    openUserDrawer(u.id, { name: displayName(u), selfId: ctx.selfId, onChanged: () => load({ quiet: true }) });

  function userRow(u) {
    const name = displayName(u);
    const cb = h('input', { type: 'checkbox', class: 'adm-cb', checked: selected.has(u.id), 'aria-label': T('selectRow', { name }) });
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => {
      if (cb.checked) selected.set(u.id, name);
      else selected.delete(u.id);
      tr.classList.toggle('selected', cb.checked);
      syncHeadCheck();
      drawBulk();
    });
    const p = u.plan;
    const tr = h(
      'tr',
      {
        class: ['adm-row', selected.has(u.id) && 'selected', u.moderation?.banned && 'banned'],
        tabindex: '0',
        'aria-label': T('openDetail', { name }),
        onclick: () => openUser(u),
        onkeydown: (e) => {
          if (e.target !== tr) return;
          if (e.key === 'Enter') openUser(u);
          else if (e.key === ' ') {
            e.preventDefault();
            cb.click();
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            tr.nextElementSibling?.focus();
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            tr.previousElementSibling?.focus();
          }
        },
      },
      h('td', { class: 'adm-col-check' }, cb),
      h(
        'td',
        { class: 'adm-col-user' },
        h('div', { class: 'adm-user' }, h('div', { class: 'adm-avatar sm', 'aria-hidden': 'true' }, name.slice(0, 1).toUpperCase()), h('div', { class: 'adm-user-text' }, h('div', { class: 'adm-user-name ellipsis', title: name }, name), h('div', { class: 'adm-user-email ellipsis', title: u.email || '' }, u.email || '—'))),
      ),
      h('td', { class: 'adm-col-plan' }, planBadge(p && p.active ? p : p ? { ...p, active: false } : null), p && p.active && p.currentPeriodEnd ? h('div', { class: 'tiny muted' }, T('planUntil', { date: fmtDay(p.currentPeriodEnd) })) : null),
      h('td', { class: 'adm-col-usage num' }, fmtUsd(u.usage?.monthUsd, { precise: true }), h('div', { class: 'tiny muted' }, T('questions', { count: u.usage?.monthQuestions || 0, value: fmtInt(u.usage?.monthQuestions || 0) }))),
      h('td', { class: 'adm-col-state' }, h('div', { class: 'adm-pills' }, statePills(u))),
      h('td', { class: 'adm-col-date adm-col-created', title: u.createdAt || '' }, fmtDay(u.createdAt)),
      h('td', { class: 'adm-col-date', title: u.lastSignInAt || '' }, u.lastSignInAt ? fmtRelative(u.lastSignInAt) : T('never')),
    );
    return tr;
  }

  const headCheck = h('input', { type: 'checkbox', class: 'adm-cb', 'aria-label': T('selectAll') });
  headCheck.addEventListener('change', () => {
    const users = state.data?.users || [];
    for (const u of users) {
      if (headCheck.checked) selected.set(u.id, displayName(u));
      else selected.delete(u.id);
    }
    drawTable();
    drawBulk();
  });
  function syncHeadCheck() {
    const users = state.data?.users || [];
    const n = users.filter((u) => selected.has(u.id)).length;
    headCheck.checked = users.length > 0 && n === users.length;
    headCheck.indeterminate = n > 0 && n < users.length;
  }

  function drawTable() {
    const users = state.data?.users || [];
    if (!users.length) {
      const filtered = state.search || state.plan || state.status || state.moderation !== 'all';
      mount(
        tableHost,
        emptyState(
          'users',
          filtered ? T('emptyTitle') : T('emptyNoUsers'),
          filtered ? T('emptyText') : null,
          filtered
            ? h('button', { class: 'btn', type: 'button', onclick: () => {
                search.value = '';
                planSel.value = '';
                statusSel.value = '';
                sortSel.value = 'created';
                setFilter({ search: '', plan: '', status: '', moderation: 'all', sort: 'created' });
                drawSeg();
              } }, icon('x'), T('clearFilters'))
            : null,
        ),
      );
      mount(pager);
      return;
    }
    mount(
      tableHost,
      h(
        'div',
        { class: ['adm-table-wrap', state.loading && 'adm-busy'] },
        h(
          'table',
          { class: 'table adm-table adm-users' },
          h(
            'thead',
            {},
            h(
              'tr',
              {},
              h('th', { class: 'adm-col-check', scope: 'col' }, headCheck),
              h('th', { scope: 'col' }, T('colUser')),
              h('th', { scope: 'col' }, T('colPlan')),
              h('th', { scope: 'col', class: 'num' }, T('colUsage')),
              h('th', { scope: 'col' }, T('colState')),
              h('th', { scope: 'col', class: 'adm-col-created' }, T('colCreated')),
              h('th', { scope: 'col' }, T('colLastSeen')),
            ),
          ),
          h('tbody', {}, users.map(userRow)),
        ),
      ),
    );
    syncHeadCheck();
    const total = Number(state.data?.total) || 0;
    const from = (state.page - 1) * PER_PAGE + 1;
    const to = Math.min(total, from + users.length - 1);
    mount(
      pager,
      h('span', { class: 'muted small num', 'aria-live': 'polite' }, T('pageInfo', { from: fmtInt(from), to: fmtInt(to), total: fmtInt(total) })),
      h('button', { class: 'btn sm', type: 'button', disabled: state.page <= 1, onclick: () => ((state.page -= 1), load()) }, icon('chevronLeft'), T('prev')),
      h('button', { class: 'btn sm', type: 'button', disabled: to >= total, onclick: () => ((state.page += 1), load()) }, T('next'), icon('chevronRight')),
    );
  }

  let seq = 0;
  async function load({ quiet = false } = {}) {
    const my = ++seq;
    state.loading = true;
    if (!state.data || !quiet) {
      if (!state.data) mount(tableHost, skeletonRows(10));
      else tableHost.querySelector('.adm-table-wrap')?.classList.add('adm-busy');
    }
    try {
      const data = await call('users.list', {
        search: state.search || null,
        plan: state.plan || null,
        status: state.status || null,
        banned: state.moderation === 'banned' ? true : null,
        muted: state.moderation === 'muted' ? true : null,
        sort: state.sort,
        page: state.page,
        perPage: PER_PAGE,
      });
      if (my !== seq || !root.isConnected) return;
      state.data = data;
      state.loading = false;
      // Si la página quedó vacía (por ejemplo, después de borrar), se vuelve a la anterior.
      if (!data.users?.length && state.page > 1 && Number(data.total) > 0) {
        state.page = Math.max(1, Math.ceil(Number(data.total) / PER_PAGE));
        return load();
      }
      drawTable();
    } catch (err) {
      if (my !== seq) return;
      state.loading = false;
      mount(tableHost, errorBox(err, () => load()));
      mount(pager);
    }
  }

  mount(root, h('section', { class: 'card adm-card adm-users-card' }, toolbar, bulkBar, tableHost, pager));
  load();
  return {
    refresh: () => load(),
    openUser: (id, name) => openUser({ id, username: name }),
  };
}
