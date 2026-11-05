// Conversación de una consulta: encabezado, datos propios del tema, diagnóstico, mensajes con capturas, respuesta con
// borrador, cierre, reapertura y valoración de la atención. Lo usan la página de la persona y la cola del equipo.
// Todo lo que escriben las personas se dibuja como texto (h() usa textContent): nunca HTML.
import { h, icon, mount, loading, ok, fail, setBusy, modal, copyText } from '../../ui.js';
import { cloud } from '../../cloud.js';
import { S, supportCall, errMsg, field, prefs, onCtrlEnter, statusBadge, priorityBadge, categoryLabel, categoryIcon, subjectOf, shortId, fmtDateTime, uid } from './common.js';
import { DETAIL_FIELDS, LIMITS, isPending, messageText, systemKind, validateReply, replyDraftKey, canReopen, canRate, normalizeRating, fieldVisible } from './logic.js';
import { createAttachPicker, uploadAll, warnUpload, gallery } from './media.js';
import { createDiagnosticPicker } from './diagnostic.js';
import { createStaffBar, openMacros } from './staffbar.js';

// -> { el, load(id, { userName }), clear(), id(), destroy() }
export function createThread({ staff = false, onChanged = () => {}, onNew = () => {} } = {}) {
  const owner = cloud.user?.id || null;
  const el = h('section', { class: 'card sp-thread', 'aria-label': S('conversation') });
  const headBox = h('div', { class: 'sp-thread-head' });
  const infoBox = h('div', { class: 'sp-thread-info' });
  const logBox = h('div', { class: 'sp-messages', role: 'log', 'aria-label': S('conversation'), 'aria-live': 'polite', 'aria-relevant': 'additions' });
  const footBox = h('div', { class: 'sp-thread-foot' });
  const staffBox = h('div', { class: 'sp-staffbox' });
  mount(el, headBox, staffBox, infoBox, logBox, footBox);

  let ticketId = null;
  let meta = {};
  let data = null;
  let seq = 0;
  let alive = true;
  let msgKey = null;
  let footKey = null;
  let infoKey = null;
  let composer = null;
  let bar = null;
  const dialogs = new Set();
  const valid = () => alive && owner === (cloud.user?.id || null);

  // ---------- Encabezado ----------
  function drawHead(ticket) {
    mount(headBox,
      h('div', { class: 'sp-head-top' }, h('h3', { class: 'sp-head-title', tabindex: '-1' }, subjectOf(ticket)), h('div', { class: 'sp-badges' }, statusBadge(ticket), priorityBadge(ticket))),
      h('p', { class: 'muted small sp-head-meta' }, categoryIcon(ticket.category),
        h('span', {}, `${categoryLabel(ticket.category)} · ${shortId(ticket)} · ${fmtDateTime(ticket.createdAt)}${staff && meta.userName ? ` · ${S('byUser', { name: meta.userName })}` : ''}`)),
      h('p', { class: 'sp-state-note' }, staff ? S(`staffState_${ticket.status}`) : S(`detail_${ticket.status}`)));
  }

  // ---------- Datos propios y diagnóstico ----------
  function drawInfo(ticket) {
    const fields = (DETAIL_FIELDS[ticket.category] || []).filter((f) => ticket.details?.[f.id] && fieldVisible(ticket.category, f, ticket.details));
    const parts = [];
    if (fields.length) {
      parts.push(h('details', { class: 'sp-fold', open: true }, h('summary', {}, icon('list'), S('detailsLegend')),
        h('dl', { class: 'sp-dl' }, fields.map((f) => [h('dt', {}, S(`fld_${ticket.category}_${f.id}`)),
          h('dd', {}, f.kind === 'select' ? S(`opt_${ticket.category}_${f.id}_${ticket.details[f.id]}`) : ticket.details[f.id])]))));
    }
    if (ticket.diagnostic) {
      parts.push(h('details', { class: 'sp-fold' }, h('summary', {}, icon('shieldCheck'), S('diagAttached'), h('span', { class: 'muted small' }, ` · ${S('chars', { used: ticket.diagnostic.length, max: LIMITS.diagnostic })}`)),
        h('div', { class: 'sp-diag-actions' }, h('button', { type: 'button', class: 'btn sm ghost', onclick: () => copyText(ticket.diagnostic, S('diagCopied')) }, icon('copy'), S('diagCopy'))),
        h('pre', { class: 'sp-diag-pre selectable', tabindex: '0', 'aria-label': S('diagAttached') }, ticket.diagnostic)));
    }
    mount(infoBox, parts);
  }

  // ---------- Mensajes ----------
  function messageNode(message, ticket) {
    const kind = systemKind(message);
    const text = messageText(message);
    const mine = staff ? !message.isAdmin : !message.isAdmin;
    if (kind === 'closed' || kind === 'closed_self') {
      return h('article', { class: 'sp-system' }, icon('check'), h('div', {},
        h('strong', {}, S(kind === 'closed' ? 'sys_closed' : staff ? 'sys_closedUser' : 'sys_closedSelf')), ' ', h('time', { class: 'muted small', datetime: message.createdAt }, fmtDateTime(message.createdAt)),
        text ? h('p', {}, text) : null));
    }
    const who = staff ? (message.isAdmin ? S('teamLabel') : meta.userName || S('customer')) : (message.isAdmin ? S('team') : S('you'));
    return h('article', { class: ['sp-message', message.isAdmin && 'from-team', mine && !staff && 'mine'] },
      h('div', { class: 'sp-message-meta' }, h('strong', {}, who), kind === 'reopened' ? h('span', { class: 'badge info' }, icon('refresh'), S('sys_reopened')) : null, h('time', { datetime: message.createdAt }, fmtDateTime(message.createdAt))),
      text ? h('p', {}, text) : null,
      gallery(message.attachments, { isAlive: () => alive && ticketId === ticket.id }));
  }
  function drawLog(messages, ticket) {
    const key = JSON.stringify(messages.map((m) => [m.id, m.attachments?.length || 0])) + staff;
    if (key === msgKey) return;
    const nearBottom = logBox.scrollHeight - logBox.scrollTop - logBox.clientHeight < 80;
    mount(logBox, messages.length ? messages.map((m) => messageNode(m, ticket)) : h('p', { class: 'muted small' }, S('noMessages')));
    if (nearBottom || msgKey === null) logBox.scrollTop = logBox.scrollHeight;
    msgKey = key;
  }

  // ---------- Responder ----------
  function buildComposer(ticket) {
    const draftKeyStr = replyDraftKey(owner, ticket.id);
    const ta = h('textarea', { class: 'input', rows: 3, maxlength: LIMITS.reply[1], name: 'reply', value: prefs.get(draftKeyStr) || '' });
    const f = field({ label: staff ? S('replyAsTeam') : S('reply'), control: ta, required: true, max: LIMITS.reply[1] });
    const attach = createAttachPicker({});
    const summary = h('div', { class: 'sp-error', role: 'alert' });
    const send = h('button', { type: 'submit', class: 'btn primary' }, icon('send'), S('send'));
    let saveTimer = null;
    ta.addEventListener('input', () => { f.setError(''); summary.textContent = ''; clearTimeout(saveTimer); saveTimer = setTimeout(() => prefs.set(draftKeyStr, ta.value.trim() ? ta.value : null), 500); });
    ta.addEventListener('paste', attach.onPaste);
    let busy = false;
    const form = h('form', { class: 'sp-reply', novalidate: true, 'aria-label': S('replyForm'), onsubmit: async (event) => {
      event.preventDefault();
      if (busy || !valid() || ticketId !== ticket.id) return;
      const check = validateReply(ta.value);
      if (!check.ok) { f.setError(S(`val_${check.error}`, { min: LIMITS.reply[0], max: LIMITS.reply[1] })); ta.focus(); return; }
      busy = true;
      const done = setBusy(send);
      try {
        const sent = await supportCall('reply', { ticketId: ticket.id, body: ta.value.trim() });
        const picked = attach.items();
        let up = { failed: 0, error: null };
        if (picked.length) up = await uploadAll(ticket.id, sent.id, picked, supportCall);
        clearTimeout(saveTimer);
        prefs.set(draftKeyStr, null);
        ta.value = '';
        f.repaint();
        attach.clear();
        if (up.failed) warnUpload(up.failed, up.error);
        if (valid() && ticketId === ticket.id) { await reload(true); onChanged(); ta.focus(); }
      } catch (err) { if (valid()) summary.textContent = errMsg(err); }
      finally { busy = false; done(); }
    } },
    f.el, attach.el, summary,
    h('div', { class: 'sp-actions end' }, staff ? h('button', { type: 'button', class: 'btn', onclick: () => openMacros({ ticket, name: meta.userName, textarea: ta }) }, icon('fileText'), S('macroOpen')) : null,
      !staff && !ticket.hasDiagnostic ? h('button', { type: 'button', class: 'btn', onclick: () => addDiagnostic(ticket) }, icon('shieldCheck'), S('diagAdd')) : null,
      h('span', { class: 'muted small spacer' }, S('sendHint')), send));
    onCtrlEnter(ta, () => form.requestSubmit());
    return { form, focus: () => ta.focus(), destroy: () => attach.clear() };
  }

  // ---------- Agregar diagnóstico a una consulta abierta ----------
  function addDiagnostic(ticket) {
    const picker = createDiagnosticPicker({ compact: true, onChange: () => { sendBtn.disabled = !picker.value(); } });
    const error = h('div', { class: 'sp-error', role: 'alert' });
    const sendBtn = h('button', { type: 'button', class: 'btn primary', disabled: true }, icon('send'), S('diagSend'));
    let dialog;
    sendBtn.addEventListener('click', async () => {
      const done = setBusy(sendBtn);
      try {
        await supportCall('diagnostic', { ticketId: ticket.id, diagnostic: picker.value() });
        dialog.close();
        ok(S('diagSent'));
        if (valid() && ticketId === ticket.id) { await reload(true); onChanged(); }
      } catch (err) { error.textContent = errMsg(err); } finally { done(); }
    });
    dialog = modal({ title: S('diagAdd'), icon: 'shieldCheck', size: 'lg', body: h('div', { class: 'sp-modal-body' }, picker.el, error), footer: sendBtn, onClose: () => dialogs.delete(dialog) });
    dialogs.add(dialog);
    picker.el.querySelector('input')?.focus();
  }

  // ---------- Cerrada: valoración y reapertura ----------
  function ratingBox(ticket) {
    const current = normalizeRating(ticket.rating);
    const name = uid('sp-rate');
    let picked = current;
    const comment = h('textarea', { class: 'input', rows: 2, maxlength: LIMITS.ratingComment, name: 'ratingComment', value: ticket.ratingComment || '' });
    const cf = field({ label: S('rateComment'), control: comment, max: LIMITS.ratingComment, hint: S('rateCommentHint') });
    const error = h('div', { class: 'sp-error', role: 'alert' });
    const stars = [1, 2, 3, 4, 5].map((n) => {
      const input = h('input', { type: 'radio', name, value: String(n), checked: n === current, 'aria-label': S('rateStars', { count: n }) });
      input.addEventListener('change', () => { picked = n; paintStars(); });
      return { n, input, el: h('label', { class: 'sp-star', title: S('rateStars', { count: n }) }, input, icon('star')) };
    });
    function paintStars() { for (const s of stars) s.el.classList.toggle('on', s.n <= picked); }
    paintStars();
    const send = h('button', { type: 'button', class: 'btn primary', onclick: async () => {
      if (!picked) { error.textContent = S('rateChoose'); stars[0].input.focus(); return; }
      const done = setBusy(send);
      try {
        await supportCall('rate', { ticketId: ticket.id, rating: picked, comment: comment.value.trim() });
        ok(S('rateThanks'));
        if (valid() && ticketId === ticket.id) { footKey = null; await reload(true); onChanged(); }
      } catch (err) { error.textContent = errMsg(err); } finally { done(); }
    } }, icon('check'), current ? S('rateUpdate') : S('rateSend'));
    return h('fieldset', { class: 'sp-rate' }, h('legend', {}, S('rateTitle')), h('p', { class: 'muted small' }, S('rateHelp')),
      h('div', { class: 'sp-stars', role: 'presentation' }, stars.map((s) => s.el)), cf.el, error, h('div', { class: 'sp-actions' }, send));
  }

  function reopenBox(ticket) {
    const wrap = h('div', { class: 'sp-reopen' });
    const open = h('button', { type: 'button', class: 'btn', onclick: show }, icon('refresh'), S('reopen'));
    function show() {
      const ta = h('textarea', { class: 'input', rows: 3, maxlength: LIMITS.reply[1], name: 'reopen' });
      const f = field({ label: staff ? S('reopenStaffLabel') : S('reopenWhy'), control: ta, required: !staff, max: LIMITS.reply[1] });
      const error = h('div', { class: 'sp-error', role: 'alert' });
      const confirm = h('button', { type: 'button', class: 'btn primary', onclick: async () => {
        const text = ta.value.trim();
        if (!staff && !text) { f.setError(S('val_required')); ta.focus(); return; }
        const done = setBusy(confirm);
        try {
          await supportCall('reopen', { ticketId: ticket.id, message: text });
          ok(S('reopened'));
          if (valid() && ticketId === ticket.id) { footKey = null; await reload(true); onChanged(); }
        } catch (err) { error.textContent = errMsg(err); } finally { done(); }
      } }, icon('refresh'), S('reopenConfirm'));
      mount(wrap, f.el, error, h('div', { class: 'sp-actions' }, confirm, h('button', { type: 'button', class: 'btn ghost', onclick: () => { mount(wrap, open); open.focus(); } }, S('cancel'))));
      ta.focus();
    }
    mount(wrap, open);
    return wrap;
  }

  function drawFoot(ticket) {
    const key = `${ticket.status}|${ticket.rating}|${ticket.reopenCount}|${ticket.hasDiagnostic}|${staff}`;
    if (key === footKey) return;
    footKey = key;
    composer?.destroy();
    composer = null;
    if (isPending(ticket)) {
      composer = buildComposer(ticket);
      const extra = !staff ? h('div', { class: 'sp-actions' }, h('button', { type: 'button', class: 'btn ghost', onclick: () => closeOwn(ticket) }, icon('check'), S('closeOwn'))) : null;
      mount(footBox, composer.form, extra);
      return;
    }
    const reopenable = staff || canReopen(ticket);
    mount(footBox,
      h('div', { class: 'notice info sp-closed' }, icon(ticket.status === 'paid' ? 'check' : 'lock'), h('span', {}, S(ticket.status === 'paid' ? 'detail_paid' : 'closedNote'))),
      !staff && canRate(ticket) ? ratingBox(ticket) : null,
      staff && ticket.rating ? h('p', { class: 'sp-rated' }, icon('star'), S('ratedBy', { count: ticket.rating }), ticket.ratingComment ? h('span', { class: 'muted' }, ` — ${ticket.ratingComment}`) : null) : null,
      ticket.status === 'closed' ? (reopenable ? reopenBox(ticket)
        : h('div', { class: 'sp-reopen' }, h('p', { class: 'muted small' }, S((ticket.reopenCount || 0) >= LIMITS.reopenTimes ? 'reopenLimit' : 'reopenExpired')),
          h('button', { type: 'button', class: 'btn', onclick: onNew }, icon('plus'), S('newInstead')))) : null);
  }

  async function closeOwn(ticket) {
    const note = h('textarea', { class: 'input', rows: 2, maxlength: LIMITS.closeNote, placeholder: S('closeNotePh'), 'aria-label': S('closeNote') });
    const body = h('div', { class: 'sp-modal-body' }, h('p', {}, S('closeOwnText')), note);
    const yes = await new Promise((resolve) => {
      const go = h('button', { type: 'button', class: 'btn primary' }, icon('check'), S('closeOwn'));
      const m = modal({ title: S('closeOwn'), icon: 'check', body, footer: [h('button', { type: 'button', class: 'btn ghost', onclick: () => { m.close(); resolve(false); } }, S('cancel')), go], onClose: () => resolve(false) });
      // Primero la respuesta: al cerrar el modal se llama onClose, que contesta que no.
      go.addEventListener('click', () => { resolve(true); m.close(); });
    });
    if (!yes || !valid()) return;
    try {
      await supportCall('closeOwn', { ticketId: ticket.id, note: note.value.trim() });
      ok(S('closed'));
      await reload(true);
      onChanged();
    } catch (err) { fail(S('actionFailed'), errMsg(err)); }
  }

  // ---------- Carga ----------
  async function reload(quiet = false) {
    if (!ticketId || !valid()) return;
    const id = ticketId;
    const request = ++seq;
    try {
      const res = await supportCall('detail', { ticketId: id });
      if (!valid() || request !== seq || ticketId !== id) return;
      data = res;
      const ticket = res.ticket;
      drawHead(ticket);
      const k = JSON.stringify([ticket.details, ticket.diagnostic?.length, ticket.category]);
      if (k !== infoKey) { infoKey = k; drawInfo(ticket); }
      drawLog(Array.isArray(res.messages) ? res.messages : [], ticket);
      drawFoot(ticket);
      if (staff) { if (!bar) { bar = createStaffBar({ onChanged: async () => { await reload(true); onChanged(); }, getTicket: () => data?.ticket, name: () => meta.userName }); mount(staffBox, bar.el); } bar.update(ticket); }
      if (!staff && ticket.unread) supportCall('markSeen', { ticketId: id }).then(() => { if (valid()) onChanged({ seen: id }); }).catch(() => {});
    } catch (err) {
      if (valid() && request === seq && !quiet) mount(logBox, h('div', { class: 'notice bad', role: 'alert' }, icon('alert'), S('loadFailed', { error: errMsg(err) })));
    }
  }

  return {
    el,
    id: () => ticketId,
    load(id, info = {}) {
      if (id === ticketId) { meta = { ...meta, ...info }; return reload(); }
      composer?.destroy();
      composer = null;
      bar = null;
      ticketId = id;
      meta = info;
      data = null;
      msgKey = null;
      footKey = null;
      infoKey = null;
      mount(headBox, loading(S('loading')));
      mount(staffBox);
      mount(infoBox);
      mount(logBox);
      mount(footBox);
      return reload();
    },
    clear() { ticketId = null; seq++; composer?.destroy(); composer = null; bar = null; },
    focusReply() { composer?.focus(); },
    // Después de enviar una consulta nueva: el foco pasa al título de la conversación (lo lee el lector de pantalla).
    focusHead() { headBox.querySelector('.sp-head-title')?.focus({ preventScroll: true }); },
    destroy() {
      alive = false;
      seq++;
      composer?.destroy();
      for (const d of dialogs) { const backdrop = d.el.closest('.modal-backdrop'); d.close(); backdrop?.remove(); }
      dialogs.clear();
    },
  };
}
