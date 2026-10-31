// Ticket conversation shared by the customer page and the support inbox. Tickets are general questions:
// plans are paid from Plans and activate on their own, so nothing here confirms payments.
import { h, icon, mount, loading, fail, ok, modal, setBusy } from '../ui.js';
import { api } from '../store.js';
import { t, locale } from '../i18n.js';
import { cloud } from '../cloud.js';

export const S = (key, vars) => t(`support.${key}`, vars);
export const supportCall = (action, payload = {}) => api.invoke('support:call', action, payload);
export const CATEGORIES = ['general', 'account', 'payments', 'assistant', 'bug', 'other'];
export const isPendingTicket = (ticket) => ['open', 'in_progress'].includes(ticket?.status);
const date = (value) => value ? new Date(value).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' }) : '—';
const subjectOf = (ticket) => ticket.subject || (ticket.planName ? S('legacyPlanSubject', { plan: ticket.planName }) : S('noSubject'));
const categoryOf = (ticket) => S(`cat_${CATEGORIES.includes(ticket.category) ? ticket.category : 'general'}`);

export function ticketStatus(ticket) {
  const state = ['open', 'in_progress', 'paid', 'closed'].includes(ticket.status) ? ticket.status : 'open';
  return h('span', { class: ['badge', state === 'paid' ? 'good' : isPendingTicket(ticket) ? 'warn' : ''] }, icon(state === 'paid' ? 'check' : isPendingTicket(ticket) ? 'clock' : 'x'), S(`status_${state}`));
}

export function ticketDesk({ admin = false, onTickets = () => {} } = {}) {
  const list = h('div', { class: 'support-ticket-list' });
  const detail = h('section', { class: 'card support-detail' });
  const errorBox = h('div', { 'aria-live': 'polite' });
  const refreshButton = h('button', { type: 'button', class: 'btn sm', onclick: () => refresh(false) }, icon('refresh'), S('refresh'));
  const root = h('section', { class: 'support-desk' },
    h('div', { class: 'support-heading' }, h('h2', {}, S(admin ? 'adminTickets' : 'myTickets')), refreshButton), errorBox,
    h('div', { class: 'support-ticket-layout' }, list, detail));
  let tickets = [];
  let selected = null;
  let alive = true;
  let listSeq = 0;
  let detailSeq = 0;
  let activeTicket = null;
  let messageBox;
  let meta;
  let reply;
  let replyForm;
  let staffActions;
  let fingerprint = null;
  let loadingList = false;
  const dialogs = new Set();
  const owner = cloud.user?.id || null;
  const valid = () => alive && owner === (cloud.user?.id || null);

  function drawList() {
    mount(list, tickets.length ? tickets.map((ticket) => h('button', {
      type: 'button', class: ['support-ticket', ticket.id === selected && 'active'],
      'aria-pressed': String(ticket.id === selected), onclick: () => select(ticket.id),
    }, h('div', { class: 'support-ticket-top' }, h('strong', {}, subjectOf(ticket)), ticketStatus(ticket)),
    h('span', { class: 'muted small' }, `${categoryOf(ticket)} · ${date(ticket.createdAt)}`),
    h('span', { class: 'support-ticket-id' }, `#${String(ticket.id).slice(0, 8)}`))) : h('p', { class: 'support-empty muted' }, S('noTickets')));
    if (!selected) mount(detail, h('div', { class: 'support-empty' }, icon('message'), h('p', {}, S('selectTicket'))));
  }

  function drawDetail(data) {
    activeTicket = data.ticket;
    const ticket = data.ticket;
    mount(meta, h('div', { class: 'support-heading' }, h('h3', {}, subjectOf(ticket)), ticketStatus(ticket)),
      h('p', { class: 'muted small' }, `${categoryOf(ticket)} · #${String(ticket.id).slice(0, 8)} · ${date(ticket.createdAt)}`),
      h('p', { class: 'support-state-note' }, S(`detail_${ticket.status}`)));
    const messages = Array.isArray(data.messages) ? data.messages : [];
    const next = JSON.stringify(messages);
    if (next !== fingerprint) {
      const nearBottom = messageBox.scrollHeight - messageBox.scrollTop - messageBox.clientHeight < 80;
      mount(messageBox, messages.length ? messages.map((message) => h('article', { class: ['support-message', message.isAdmin && 'from-admin'] },
        h('div', { class: 'support-message-meta' }, h('strong', {}, S(message.isAdmin ? 'team' : 'customer')), h('time', { datetime: message.createdAt }, date(message.createdAt))),
        h('p', {}, message.body))) : h('p', { class: 'muted small' }, S('noMessages')));
      if (nearBottom || fingerprint === null) messageBox.scrollTop = messageBox.scrollHeight;
      fingerprint = next;
    }
    replyForm.hidden = !isPendingTicket(ticket);
    mount(staffActions, admin && isPendingTicket(ticket)
      ? h('button', { type: 'button', class: 'btn', onclick: () => closeDialog() }, icon('check'), S('closeTicket'))
      : null);
  }

  async function reloadDetail({ quiet = false } = {}) {
    if (!selected || !valid()) return;
    const id = selected;
    const request = ++detailSeq;
    try {
      const data = await supportCall('detail', { ticketId: id });
      if (!valid() || request !== detailSeq || selected !== id) return;
      drawDetail(data);
    } catch (err) {
      if (valid() && request === detailSeq && !quiet) showError(err);
    }
  }

  function select(id) {
    if (selected === id && activeTicket) return reloadDetail();
    selected = id;
    activeTicket = null;
    fingerprint = null;
    meta = h('div', {}, loading(S('loading')));
    messageBox = h('div', { class: 'support-messages', role: 'log', 'aria-label': S('conversation'), 'aria-live': 'polite', 'aria-relevant': 'additions' });
    reply = h('textarea', { class: 'input', rows: 3, maxlength: 4000, required: true, placeholder: S('replyPlaceholder'), 'aria-label': S('reply') });
    const submit = h('button', { type: 'submit', class: 'btn primary' }, icon('send'), S('send'));
    replyForm = h('form', { class: 'support-reply', onsubmit: async (event) => {
      event.preventDefault();
      const body = reply.value.trim();
      if (!valid() || !body || selected !== id) return;
      const done = setBusy(submit);
      try {
        await supportCall('reply', { ticketId: id, body });
        if (!valid() || selected !== id) return;
        reply.value = '';
        await reloadDetail();
      } catch (err) { if (valid()) fail(S('sendFailed'), err); }
      finally { done(); }
    } }, h('label', {}, S('reply'), reply), submit);
    replyForm.hidden = true;
    staffActions = h('div', { class: 'support-actions' });
    mount(detail, meta, messageBox, replyForm, staffActions);
    drawList();
    reloadDetail();
  }

  function closeDialog() {
    const ticket = activeTicket;
    if (!valid() || !ticket || !isPendingTicket(ticket)) return;
    const note = h('textarea', { class: 'input', rows: 3, maxlength: 2000, placeholder: S('closeNotePlaceholder') });
    const errors = h('p', { class: 'support-form-error', role: 'alert' });
    const submit = h('button', { type: 'submit', class: 'btn primary' }, S('closeTicket'));
    let dialog;
    const form = h('form', { class: 'support-form', onsubmit: async (event) => {
      event.preventDefault();
      if (!valid()) return;
      const done = setBusy(submit);
      try {
        await supportCall('resolve', { ticketId: ticket.id, note: note.value.trim() });
        dialog.close();
        dialogs.delete(dialog);
        if (!valid()) return;
        ok(S('closed'));
        await refresh();
      } catch (err) { errors.textContent = err?.message || String(err); }
      finally { done(); }
    } },
    h('p', {}, S('closeSummary', { subject: subjectOf(ticket) })),
    h('label', {}, S('closeNote'), note), errors, submit);
    dialog = modal({ title: S('closeTicket'), icon: 'check', body: form, onClose: () => dialogs.delete(dialog) });
    dialogs.add(dialog);
  }

  function showError(err) {
    mount(errorBox, h('div', { class: 'notice bad', role: 'alert' }, icon('alert'), h('span', {}, S('loadFailed', { error: err?.message || String(err) }))));
  }

  async function refresh(quiet = false) {
    if (!valid() || loadingList) return;
    loadingList = true;
    const request = ++listSeq;
    if (!quiet) refreshButton.disabled = true;
    try {
      const result = await supportCall('list', { admin });
      if (!valid() || request !== listSeq) return;
      tickets = Array.isArray(result) ? result : [];
      mount(errorBox);
      if (selected && !tickets.some((x) => x.id === selected)) selected = null;
      onTickets(tickets);
      drawList();
      if (!selected && tickets.length) select(tickets.find((x) => isPendingTicket(x))?.id || tickets[0].id);
      else if (selected) await reloadDetail({ quiet });
    } catch (err) {
      if (valid() && request === listSeq && !quiet) showError(err);
    } finally {
      loadingList = false;
      refreshButton.disabled = false;
    }
  }
  mount(list, loading(S('loading')));
  refresh();
  const timer = setInterval(() => { if (!document.hidden && root.isConnected && !root.closest('[hidden]')) refresh(true); }, 15000);
  const offAuth = cloud.on('auth', () => { if (!valid()) { destroy(); mount(root); } });
  function destroy() { alive = false; listSeq++; detailSeq++; clearInterval(timer); offAuth(); for (const dialog of dialogs) { const backdrop = dialog.el.closest('.modal-backdrop'); dialog.close(); backdrop?.remove(); } dialogs.clear(); }
  return { el: root, refresh, select, destroy };
}
