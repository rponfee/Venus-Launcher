// Mesa de Soporte: lista a la izquierda y, a la derecha, el formulario o la conversación. Con admin: true es la cola del
// equipo (filtros por estado, tema, prioridad y asignación, buscador, contadores); sin admin son "Mis consultas".
// ticketDesk({ admin, userId, initial }) -> { el, refresh(quiet), select(id), openNew(), destroy() }
import { h, icon, mount, loading, emptyState, switchEl } from '../../ui.js';
import { cloud } from '../../cloud.js';
import { S, supportCall, errMsg, statusBadge, priorityBadge, categoryLabel, categoryIcon, subjectOf, fmtWhen, shortId, uid, prefs } from './common.js';
import { MY_FILTERS, filterMine, mineCounts, isPending, buildQueueFilter, activeFilterCount, DEFAULT_QUEUE, QUEUE_STATUS, QUEUE_SORT, ALL_CATEGORIES, PRIORITIES, waitLevel, waitingSince, LIMITS } from './logic.js';
import { createThread } from './thread.js';
import { createForm } from './form.js';
import { isNotifyEnabled, setNotifyEnabled, reportUnread } from './notify.js';

const QUEUE_KEY = 'venus.support.queue';

function readQueuePrefs() {
  try {
    const v = JSON.parse(prefs.get(QUEUE_KEY) || '{}');
    return { ...DEFAULT_QUEUE, ...(QUEUE_STATUS.includes(v.status) ? { status: v.status } : {}), ...(QUEUE_SORT.includes(v.sort) ? { sort: v.sort } : {}) };
  } catch { return { ...DEFAULT_QUEUE }; }
}

export function ticketDesk({ admin = false, initial = null, onTickets = () => {} } = {}) {
  const owner = cloud.user?.id || null;
  const valid = () => alive && owner === (cloud.user?.id || null);
  let alive = true;
  let tickets = [];
  let counts = null;
  let total = 0;
  let page = 0;
  let selected = null; // id de consulta, 'new' o null
  let myFilter = 'all';
  const ui = admin ? readQueuePrefs() : null;
  let listSeq = 0;
  let loadingList = false;

  const list = h('ul', { class: 'sp-list', 'aria-label': S(admin ? 'queueList' : 'myList') });
  const errorBox = h('div', { 'aria-live': 'polite' });
  const rail = h('aside', { class: 'sp-rail', 'aria-label': S(admin ? 'queueTitle' : 'myTickets') });
  const panel = h('div', { class: 'sp-panel' });
  const thread = createThread({ staff: admin, onChanged: (info) => { refresh(true); if (info?.seen) reportUnreadNow(); }, onNew: () => openNew() });
  const form = admin ? null : createForm({ userId: owner, onSent: async (id) => { await refresh(true); await select(id); thread.focusHead(); } });
  const empty = h('div', { class: 'card sp-empty-card' }, emptyState('message', S(admin ? 'queueEmptyTitle' : 'selectTicket'), S(admin ? 'queueEmptyText' : 'selectTicketText')));
  thread.el.hidden = true;
  if (form) form.el.hidden = true;
  mount(panel, ...(form ? [form.el] : []), thread.el, empty);
  const root = h('section', { class: ['sp-desk', admin && 'staff'] }, errorBox, h('div', { class: 'sp-layout' }, rail, panel));

  // ---------- Panel derecho ----------
  function showPanel() {
    const isNew = selected === 'new';
    if (form) form.el.hidden = !isNew;
    thread.el.hidden = isNew || !selected;
    empty.hidden = Boolean(selected);
    if (!selected) empty.replaceChildren(emptyState('message', S(admin ? 'queueEmptyTitle' : 'selectTicket'), S(admin ? 'queueEmptyText' : 'selectTicketText')));
  }
  function select(id, { focus = false } = {}) {
    selected = id;
    drawList();
    showPanel();
    let loaded = null;
    if (id && id !== 'new') {
      const t = tickets.find((x) => x.id === id);
      loaded = thread.load(id, { userName: t?.userName });
    } else thread.clear();
    if (id === 'new' && focus) form?.focus();
    return loaded;
  }
  const openNew = () => select('new', { focus: true });

  // ---------- Lista ----------
  const initialsOf = (name) => String(name || '?').trim().slice(0, 2).toUpperCase();
  function itemNode(t) {
    const active = t.id === selected;
    const wait = admin ? waitingSince(t) : null;
    const replyLine = !admin && t.lastReplyPreview ? h('span', { class: 'sp-item-reply' }, icon('message'), h('span', {}, `${S('team')} · ${fmtWhen(t.lastReplyAt)}: ${t.lastReplyPreview}`)) : null;
    const staffLine = admin ? h('span', { class: 'sp-item-reply' }, icon(t.lastFromTeam ? 'send' : 'user'), h('span', {}, `${t.lastFromTeam ? S('teamLabel') : t.userName}: ${t.lastPreview || ''}`)) : null;
    return h('li', {}, h('button', { type: 'button', class: ['sp-item', active && 'active', t.unread && 'unread'], 'aria-current': active ? 'true' : null, onclick: () => select(t.id) },
      h('span', { class: 'sp-item-top' }, h('strong', {}, subjectOf(t)), t.unread ? h('span', { class: 'sp-new' }, S('newReply')) : null),
      h('span', { class: 'sp-item-badges' },
        // El equipo ve solo lo que ayuda a ordenar: el estado cuando no es el de siempre y la prioridad cuando no es normal.
        !admin || t.status !== 'open' ? statusBadge(t) : null, !admin || t.priority !== 'normal' ? priorityBadge(t) : null,
        admin && t.assigneeName ? h('span', { class: 'badge', title: t.assigneeName }, icon('user'), t.mine ? S('you') : initialsOf(t.assigneeName)) : null),
      h('span', { class: 'sp-item-meta muted small' }, categoryIcon(t.category), h('span', {}, `${categoryLabel(t.category)} · ${admin ? t.userName : shortId(t)} · ${fmtWhen(admin ? t.lastUserMessageAt || t.createdAt : t.updatedAt)}`)),
      wait !== null ? h('span', { class: ['sp-wait', waitLevel(wait)] }, icon('clock'), S('waitingFor', { time: fmtWhen(t.lastUserMessageAt) })) : null,
      replyLine, staffLine));
  }
  function drawList() {
    const items = admin ? tickets : filterMine(tickets, myFilter);
    mount(list, items.length ? items.map(itemNode) : h('li', { class: 'sp-list-empty' }, h('p', { class: 'muted' }, admin ? S('queueNone') : tickets.length ? S('noMatch') : S('noTickets'))));
    if (!admin) drawMyFilters();
    else drawQueueHead();
    const more = admin && tickets.length < total;
    pager.hidden = !more;
    pagerBtn.textContent = '';
    pagerBtn.append(icon('chevronDown'), S('loadMore', { shown: tickets.length, total }));
  }
  list.addEventListener('keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    const buttons = [...list.querySelectorAll('.sp-item')];
    const i = buttons.indexOf(document.activeElement);
    if (i < 0) return;
    event.preventDefault();
    buttons[Math.max(0, Math.min(buttons.length - 1, i + (event.key === 'ArrowDown' ? 1 : -1)))].focus();
  });

  // ---------- Riel de la persona ----------
  const filtersBox = h('div', { class: 'sp-filter-row', role: 'group', 'aria-label': S('filterLabel') });
  const newBtn = h('button', { type: 'button', class: 'btn primary', onclick: openNew }, icon('plus'), S('newTicket'));
  const refreshIcon = h('button', { type: 'button', class: 'icon-btn', 'aria-label': S('refresh'), title: S('refresh'), onclick: () => refresh(false) }, icon('refresh'));
  const notifyId = uid('sp-nt');
  const notifySwitch = switchEl(isNotifyEnabled(), (on) => setNotifyEnabled(on), S('notifyLabel'));
  function drawMyFilters() {
    const c = mineCounts(tickets);
    mount(filtersBox, MY_FILTERS.map((f) => h('button', { type: 'button', class: ['chip', f === myFilter && 'active'], 'aria-pressed': String(f === myFilter), onclick: () => { myFilter = f; drawList(); } },
      S(`filter_${f}`), h('span', { class: 'count' }, String(c[f])))));
  }

  // ---------- Riel del equipo ----------
  const statsBox = h('div', { class: 'sp-stats' });
  const filtersPanel = h('details', { class: 'sp-filters' });
  const search = h('input', { class: 'input', type: 'search', 'aria-label': S('searchLabel'), placeholder: S('searchPh'), maxlength: LIMITS.search, value: ui?.search || '' });
  let searchTimer = null;
  search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { ui.search = search.value; refresh(); }, 350); });
  const pagerBtn = h('button', { type: 'button', class: 'btn sm block', onclick: () => { page += 1; refresh(true, { append: true }); } });
  const pager = h('div', { class: 'sp-pager', hidden: true }, pagerBtn);
  function setFilter(patch) {
    Object.assign(ui, patch);
    prefs.set(QUEUE_KEY, JSON.stringify({ status: ui.status, sort: ui.sort }));
    refresh();
  }
  function drawQueueHead() {
    const c = counts || {};
    const stat = (label, value, patch, active) => h('button', { type: 'button', class: ['chip', active && 'active'], 'aria-pressed': String(Boolean(active)), onclick: () => setFilter({ ...DEFAULT_QUEUE, search: ui.search, ...patch }) },
      label, h('span', { class: 'count' }, String(value ?? '–')));
    mount(statsBox,
      stat(S('stat_pending'), c.pending, { status: 'pending' }, ui.status === 'pending' && ui.assigned === 'any' && !ui.category && !ui.priority),
      stat(S('stat_waiting'), c.waiting, { status: 'waiting' }, ui.status === 'waiting'),
      stat(S('stat_unassigned'), c.unassigned, { status: 'pending', assigned: 'none' }, ui.assigned === 'none'),
      stat(S('stat_mine'), c.mine, { status: 'pending', assigned: 'me' }, ui.assigned === 'me'),
      c.ratingCount ? h('div', { class: 'sp-rating-line muted small', title: S('ratingAvgTitle') }, h('span', { class: 'sp-star-on' }, icon('star')), h('strong', {}, String(c.ratingAvg)), ` · ${S('ratingAvg', { count: c.ratingCount })}`) : null);
    const n = activeFilterCount(ui);
    const select = (label, key, options) => {
      const id = uid('sp-f');
      return h('div', { class: 'sp-filter' }, h('label', { for: id, class: 'sp-label' }, label), h('select', { id, class: 'select', onchange: (e) => setFilter({ [key]: e.target.value }) },
        options.map(([value, text]) => h('option', { value, selected: (ui[key] || '') === value }, text))));
    };
    mount(filtersPanel, h('summary', {}, icon('filter'), S('filters'), n ? h('span', { class: 'badge accent' }, String(n)) : null),
      h('div', { class: 'sp-filter-grid' },
        select(S('f_status'), 'status', QUEUE_STATUS.map((v) => [v, S(`q_status_${v}`)])),
        select(S('f_category'), 'category', [['', S('f_any')], ...ALL_CATEGORIES.map((v) => [v, categoryLabel(v)])]),
        select(S('f_priority'), 'priority', [['', S('f_any')], ...PRIORITIES.map((v) => [v, S(`prio_${v}`)])]),
        select(S('f_assigned'), 'assigned', [['any', S('f_any')], ['me', S('assigned_me')], ['none', S('assigned_none')]]),
        select(S('f_sort'), 'sort', QUEUE_SORT.map((v) => [v, S(`sort_${v}`)]))),
      n ? h('button', { type: 'button', class: 'btn sm ghost', onclick: () => { search.value = ''; setFilter({ ...DEFAULT_QUEUE }); } }, icon('x'), S('clearFilters')) : null);
  }

  // ---------- Carga ----------
  const refreshBtn = h('button', { type: 'button', class: 'btn sm', onclick: () => refresh(false) }, icon('refresh'), S('refresh'));
  async function refresh(quiet = false, { append = false } = {}) {
    if (!valid() || (loadingList && !append)) return;
    loadingList = true;
    const request = ++listSeq;
    if (!quiet) { refreshBtn.disabled = true; refreshIcon.disabled = true; }
    if (!append && !quiet && !tickets.length) mount(list, h('li', {}, loading(S('loading'))));
    try {
      let result;
      if (admin) {
        if (!append) page = 0;
        result = await supportCall('queue', { filter: buildQueueFilter(ui, page) });
        if (!valid() || request !== listSeq) return;
        counts = result.counts;
        total = result.total;
        tickets = append ? [...tickets, ...result.items.filter((x) => !tickets.some((y) => y.id === x.id))] : result.items;
      } else {
        result = await supportCall('list', { admin: false });
        if (!valid() || request !== listSeq) return;
        tickets = Array.isArray(result) ? result : [];
      }
      mount(errorBox);
      onTickets(tickets);
      if (form) form.setOpenCount(tickets.filter(isPending).length);
      if (!admin) reportUnread(mineCounts(tickets).unread);
      if (selected && selected !== 'new' && !tickets.some((x) => x.id === selected) && !admin) selected = null;
      drawList();
      if (!selected) {
        // Al entrar: la consulta pedida, la primera con respuesta nueva, la primera abierta, o el formulario si no hay ninguna.
        const pick = (initialId && tickets.find((x) => x.id === initialId)?.id) || tickets.find((x) => x.unread)?.id || tickets.find(isPending)?.id || tickets[0]?.id;
        initialId = null;
        if (admin) { if (pick) select(pick); else showPanel(); } else select(pick || 'new');
      } else if (selected !== 'new') await thread.load(selected, { userName: tickets.find((x) => x.id === selected)?.userName });
      else showPanel();
    } catch (err) {
      if (valid() && request === listSeq && !quiet) mount(errorBox, h('div', { class: 'notice bad', role: 'alert' }, icon('alert'), h('span', {}, S('loadFailed', { error: errMsg(err) })), h('button', { type: 'button', class: 'btn sm', onclick: () => refresh(false) }, icon('refresh'), S('retry'))));
    } finally {
      loadingList = false;
      refreshBtn.disabled = false;
      refreshIcon.disabled = false;
    }
  }
  let initialId = initial;
  const reportUnreadNow = () => reportUnread(mineCounts(tickets).unread);

  // ---------- Armado ----------
  const rows = admin
    ? [h('div', { class: 'sp-rail-head' }, h('h2', {}, S('queueTitle')), refreshBtn), statsBox, filtersPanel, h('div', { class: 'sp-search' }, icon('search'), search), list, pager]
    : [h('div', { class: 'sp-rail-top' }, newBtn, refreshIcon), filtersBox, list,
      h('div', { class: 'sp-rail-foot' }, h('label', { class: 'toggle-row sp-notify' }, h('div', { class: 'tr-text' }, h('div', { class: 'tr-title', id: notifyId }, S('notifyLabel')), h('div', { class: 'tr-sub' }, S('notifyHint'))), notifySwitch))];
  mount(rail, ...rows);
  mount(list, loading(S('loading')));
  refresh();
  const timer = setInterval(() => { if (!document.hidden && root.isConnected && !root.closest('[hidden]')) refresh(true); }, admin ? 20000 : 15000);
  const offAuth = cloud.on('auth', () => { if (!valid()) { destroy(); mount(root); } });
  function destroy() { alive = false; listSeq++; clearInterval(timer); offAuth(); thread.destroy(); form?.destroy(); clearTimeout(searchTimer); }
  return { el: root, refresh, select, openNew, destroy };
}
