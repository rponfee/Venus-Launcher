// Herramientas del equipo dentro de una consulta: quién la atiende, prioridad, cerrar, datos de la cuenta (solo lo necesario),
// notas internas que la persona nunca ve y respuestas guardadas. Cada acción la vuelve a autorizar el servidor.
import { h, icon, mount, modal, ok, fail, setBusy, loading } from '../../ui.js';
import { S, supportCall, errMsg, field, fmtDateTime, fmtWhen, uid } from './common.js';
import { LIMITS, PRIORITIES, isPending, fillMacro } from './logic.js';

const BUILTIN_MACROS = ['hello', 'needInfo', 'diag', 'paymentWait', 'resolved', 'suggestion'];
let staffCache = null; // quiénes atienden: cambia poco, se pide una sola vez por sesión de pantalla

async function staffList() {
  staffCache ||= supportCall('staffList').catch((err) => { staffCache = null; throw err; });
  return staffCache;
}

// -> { el, update(ticket) }
export function createStaffBar({ onChanged = () => {}, getTicket, name = () => '' }) {
  const row = h('div', { class: 'sp-staff-row' });
  const panel = h('div', { class: 'sp-staff-panel' });
  const el = h('section', { class: 'sp-staffbar', 'aria-label': S('staffTools') }, row, panel);
  let loadedFor = null;
  let panelData = null;
  let noteDraft = ''; // lo que se estaba escribiendo: sobrevive a las actualizaciones de la pantalla
  let lastKey = null;

  async function run(action, payload, okText) {
    try {
      await supportCall(action, payload);
      if (okText) ok(okText);
      onChanged();
    } catch (err) { fail(S('actionFailed'), errMsg(err)); }
  }

  function closeDialog(ticket) {
    const note = h('textarea', { class: 'input', rows: 3, maxlength: LIMITS.note, name: 'note' });
    const f = field({ label: S('closeNote'), control: note, max: LIMITS.note, hint: S('closeNoteHint') });
    const confirm = h('button', { type: 'button', class: 'btn primary' }, icon('check'), S('closeTicket'));
    const error = h('div', { class: 'sp-error', role: 'alert' });
    let dialog;
    confirm.addEventListener('click', async () => {
      const done = setBusy(confirm);
      try {
        await supportCall('resolve', { ticketId: ticket.id, note: note.value.trim() });
        dialog.close();
        ok(S('closed'));
        onChanged();
      } catch (err) { error.textContent = errMsg(err); } finally { done(); }
    });
    dialog = modal({ title: S('closeTicket'), icon: 'check', body: h('div', { class: 'sp-modal-body' }, h('p', {}, S('closeSummary')), f.el, error), footer: [h('button', { type: 'button', class: 'btn ghost', onclick: () => dialog.close() }, S('cancel')), confirm] });
  }

  function drawRow(ticket) {
    const pending = isPending(ticket);
    const prio = h('select', { class: 'select', 'aria-label': S('priorityLabel'), disabled: !pending, onchange: (e) => run('priority', { ticketId: ticket.id, priority: e.target.value }, S('priorityChanged')) },
      PRIORITIES.map((p) => h('option', { value: p, selected: p === ticket.priority }, S(`prio_${p}`))));
    const assignee = panelData?.assignee;
    const take = h('button', { type: 'button', class: 'btn sm', disabled: !pending, onclick: async () => {
      if (assignee?.me) return run('assign', { ticketId: ticket.id, to: null }, S('released'));
      const mine = (await staffList().catch(() => []))?.find((s) => s.me)?.id;
      return mine ? run('assign', { ticketId: ticket.id, to: mine }, S('taken')) : fail(S('actionFailed'), S('err_server'));
    } }, icon(assignee?.me ? 'undo' : 'user'), assignee?.me ? S('release') : S('take'));
    const pick = h('select', { class: 'select', 'aria-label': S('assignTo'), disabled: !pending, onchange: (e) => { if (e.target.value) run('assign', { ticketId: ticket.id, to: e.target.value }, S('assigned')); } },
      h('option', { value: '' }, S('assignTo')));
    mount(row,
      h('div', { class: 'sp-staff-assignee' }, icon('user'), h('span', {}, assignee ? S('assignedTo', { name: assignee.me ? S('you') : assignee.name }) : S('unassigned'))),
      take, pick, h('label', { class: 'sp-inline-select' }, h('span', { class: 'muted small' }, S('priorityLabel')), prio),
      pending ? h('button', { type: 'button', class: 'btn sm', onclick: () => closeDialog(ticket) }, icon('check'), S('closeTicket')) : null);
    staffList().then((list) => {
      if (!pick.isConnected) return;
      for (const s of list) if (!s.me) pick.append(h('option', { value: s.id, selected: assignee?.id === s.id }, s.name));
    }).catch(() => {});
  }

  function ctxRow(label, value) { return [h('dt', {}, label), h('dd', {}, value)]; }
  function drawPanel(ticket) {
    const c = panelData?.context || {};
    const sanction = c.sanction && c.sanction !== 'none' ? h('span', { class: 'badge bad' }, icon('ban'), S(`sanction_${c.sanction}`), c.sanctionUntil ? ` · ${fmtDateTime(c.sanctionUntil)}` : '') : S('sanction_none');
    const notes = panelData?.notes || [];
    const ta = h('textarea', { class: 'input', rows: 2, maxlength: LIMITS.note, name: 'note', value: noteDraft });
    const nf = field({ label: S('noteLabel'), control: ta, max: LIMITS.note });
    const error = h('div', { class: 'sp-error', role: 'alert' });
    const add = h('button', { type: 'button', class: 'btn sm', onclick: async () => {
      if (!ta.value.trim()) { nf.setError(S('val_required')); ta.focus(); return; }
      const done = setBusy(add);
      try {
        await supportCall('note', { ticketId: ticket.id, body: ta.value.trim() });
        ta.value = '';
        noteDraft = '';
        await loadPanel(ticket);
        ta.focus();
      } catch (err) { error.textContent = errMsg(err); } finally { done(); }
    } }, icon('plus'), S('noteAdd'));
    ta.addEventListener('input', () => { noteDraft = ta.value; nf.setError(''); error.textContent = ''; });
    mount(panel,
      h('details', { class: 'sp-fold' }, h('summary', {}, icon('user'), S('accountTitle')),
        h('dl', { class: 'sp-dl' }, c.username ? [
          ctxRow(S('ctx_user'), c.username), ctxRow(S('ctx_since'), c.memberSince ? fmtDateTime(c.memberSince) : '—'),
          ctxRow(S('ctx_email'), c.emailConfirmed ? S('yes') : S('no')), ctxRow(S('ctx_plan'), c.plan ? S(`plan_${c.plan}`) : S('ctx_noPlan')),
          ctxRow(S('ctx_sanction'), sanction), ctxRow(S('ctx_tickets'), S('ctx_ticketsValue', { total: c.tickets?.total ?? 0, open: c.tickets?.open ?? 0 })),
        ] : h('dd', {}, S('loading'))),
        h('p', { class: 'sp-hint' }, S('accountNote'))),
      h('details', { class: 'sp-fold sp-notes', open: notes.length > 0 }, h('summary', {}, icon('lock'), S('notesTitle'), h('span', { class: 'badge' }, String(notes.length))),
        h('p', { class: 'sp-hint' }, S('notesNote')),
        notes.length ? h('ul', { class: 'sp-note-list' }, notes.map((n) => h('li', {}, h('div', { class: 'sp-note-meta' }, h('strong', {}, n.mine ? S('you') : n.author), h('time', { class: 'muted small', datetime: n.createdAt }, fmtWhen(n.createdAt))), h('p', {}, n.body)))) : null,
        nf.el, error, h('div', { class: 'sp-actions' }, add)));
  }

  async function loadPanel(ticket) {
    try {
      panelData = await supportCall('staffPanel', { ticketId: ticket.id });
      loadedFor = ticket.id;
      drawRow(ticket);
      drawPanel(ticket);
    } catch (err) { mount(panel, h('div', { class: 'notice bad', role: 'alert' }, icon('alert'), S('loadFailed', { error: errMsg(err) }))); }
  }

  return {
    el,
    update(ticket) {
      if (loadedFor !== ticket.id) { panelData = null; noteDraft = ''; lastKey = null; mount(panel, loading(S('loading'))); loadedFor = ticket.id; }
      // Solo se vuelve a pedir el panel si la consulta cambió (así no se pisa lo que se está escribiendo).
      const key = `${ticket.id}|${ticket.updatedAt}|${ticket.priority}|${ticket.status}|${ticket.assigned}`;
      if (key === lastKey) return;
      lastKey = key;
      if (panelData) drawRow(ticket);
      loadPanel(ticket);
    },
  };
}

// ---------- Respuestas guardadas ----------
export function openMacros({ ticket, name, textarea }) {
  const search = h('input', { class: 'input', type: 'search', 'aria-label': S('macroSearch'), placeholder: S('macroSearch') });
  const listBox = h('div', { class: 'sp-macros' });
  const title = h('input', { class: 'input', type: 'text', maxlength: LIMITS.macroTitle, name: 'macroTitle' });
  const tf = field({ label: S('macroTitleLabel'), control: title, required: true, max: LIMITS.macroTitle });
  const shared = h('input', { type: 'checkbox', id: uid('sp-sh') });
  const error = h('div', { class: 'sp-error', role: 'alert' });
  let saved = [];
  let dialog;

  const insert = (body) => {
    const text = fillMacro(body, { name });
    textarea.value = textarea.value.trim() ? `${textarea.value.trimEnd()}\n\n${text}` : text;
    textarea.dispatchEvent(new Event('input'));
    dialog.close();
    textarea.focus();
  };
  function draw() {
    const q = search.value.trim().toLowerCase();
    const builtin = BUILTIN_MACROS.map((id) => ({ id, title: S(`macro_${id}_t`), body: S(`macro_${id}_b`) }));
    const match = (m) => !q || m.title.toLowerCase().includes(q) || m.body.toLowerCase().includes(q);
    const row = (m, mine) => h('li', { class: 'sp-macro' }, h('div', { class: 'sp-macro-text' }, h('strong', {}, m.title), m.owner ? h('span', { class: 'muted small' }, ` · ${m.owner}`) : null, m.shared ? h('span', { class: 'badge info' }, S('macroShared')) : null,
      h('p', { class: 'muted small' }, (() => { const shown = fillMacro(m.body, { name }); return shown.length > 140 ? `${shown.slice(0, 140)}…` : shown; })())),
    h('div', { class: 'sp-macro-actions' }, h('button', { type: 'button', class: 'btn sm primary', onclick: () => insert(m.body) }, icon('plus'), S('macroInsert')),
      mine ? h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': S('macroDelete', { title: m.title }), title: S('macroDeleteShort'), onclick: async () => {
        try { await supportCall('macroDelete', { id: m.id }); await load(); } catch (err) { error.textContent = errMsg(err); }
      } }, icon('trash')) : null));
    const mine = saved.filter(match);
    mount(listBox,
      h('h4', {}, S('macroSaved')), mine.length ? h('ul', {}, mine.map((m) => row(m, m.mine))) : h('p', { class: 'muted small' }, S('macroNoneSaved')),
      h('h4', {}, S('macroBuiltin')), h('ul', {}, builtin.filter(match).map((m) => row(m, false))));
  }
  async function load() {
    try { saved = await supportCall('macros'); } catch (err) { saved = []; error.textContent = errMsg(err); }
    draw();
  }
  const save = h('button', { type: 'button', class: 'btn', onclick: async () => {
    if (!title.value.trim()) { tf.setError(S('val_required')); title.focus(); return; }
    if (!textarea.value.trim()) { error.textContent = S('macroWriteFirst'); textarea.focus(); return; }
    const done = setBusy(save);
    try {
      await supportCall('macroSave', { title: title.value.trim(), body: textarea.value.trim(), shared: shared.checked });
      title.value = '';
      tf.repaint();
      ok(S('macroSavedOk'));
      await load();
    } catch (err) { error.textContent = errMsg(err); } finally { done(); }
  } }, icon('save'), S('macroSave'));
  search.addEventListener('input', draw);
  title.addEventListener('input', () => tf.setError(''));
  dialog = modal({ title: S('macroOpen'), icon: 'fileText', size: 'lg',
    body: h('div', { class: 'sp-modal-body' }, search, listBox,
      h('fieldset', { class: 'sp-macro-new' }, h('legend', {}, S('macroNew')), h('p', { class: 'sp-hint' }, S('macroNewHint')), tf.el,
        h('label', { class: 'sp-check', for: shared.id }, shared, h('span', {}, S('macroShare'))), save), error) });
  mount(listBox, loading(S('loading')));
  load();
  return dialog;
}
