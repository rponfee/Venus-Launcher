// Formulario de una consulta nueva: tema con campos propios, sugerencias antes de enviar, capturas, diagnóstico opcional,
// borrador que se guarda solo y validación clara (cada error queda asociado a su campo). Solo texto: nada se dibuja como HTML.
import { h, icon, mount, setBusy, ok, debounce } from '../../ui.js';
import { S, supportCall, errMsg, field, prefs, uid, categoryIcon, fmtWhen, onCtrlEnter } from './common.js';
import { CATEGORIES, DETAIL_FIELDS, LIMITS, fieldVisible, cleanDetails, validateTicket, draftKey, parseDraft, serializeDraft, draftIsEmpty } from './logic.js';
import { createSuggestions } from './faq.js';
import { createAttachPicker, uploadAll, warnUpload } from './media.js';
import { createDiagnosticPicker } from './diagnostic.js';
import { isNotifyEnabled, setNotifyEnabled } from './notify.js';

// -> { el, focus(), setOpenCount(n), destroy() }
export function createForm({ userId, onSent = () => {} } = {}) {
  const key = draftKey(userId);
  const state = { category: 'bug', details: {} };
  let openCount = 0;
  let busy = false;
  let alive = true;
  const formId = uid('sp-form');

  // --- Tema ---
  const radios = CATEGORIES.map((c) => {
    const input = h('input', { type: 'radio', name: `${formId}-cat`, value: c, checked: c === state.category });
    input.addEventListener('change', () => { if (input.checked) setCategory(c); });
    return { c, input, el: h('label', { class: 'sp-cat' }, input, h('span', { class: 'sp-cat-body' }, categoryIcon(c), h('span', { class: 'sp-cat-text' }, h('strong', {}, S(`cat_${c}`)), h('span', { class: 'muted small' }, S(`catd_${c}`))))) };
  });
  const catFieldset = h('fieldset', { class: 'sp-cats' }, h('legend', { class: 'sp-label' }, S('catLegend'), h('span', { class: 'sp-req', 'aria-hidden': 'true' }, ' *')), h('div', { class: 'sp-cat-grid' }, radios.map((r) => r.el)), h('div', { class: 'sp-error', 'aria-live': 'polite' }));

  // --- Asunto, datos propios y mensaje ---
  const subject = h('input', { class: 'input', type: 'text', maxlength: LIMITS.subject[1], autocomplete: 'off', name: 'subject' });
  const subjectF = field({ label: S('subject'), control: subject, required: true, max: LIMITS.subject[1], hint: S('subjectHint') });
  const detailsBox = h('fieldset', { class: 'sp-details' });
  const message = h('textarea', { class: 'input', rows: 6, maxlength: LIMITS.message[1], name: 'message' });
  const messageF = field({ label: S('message'), control: message, required: true, max: LIMITS.message[1], hint: S('messageHint', { min: LIMITS.message[0] }), wide: true });
  const tplButton = h('button', { type: 'button', class: 'btn sm ghost', onclick: useTemplate }, icon('fileText'), S('tplUse'));
  const detailControls = new Map(); // id del dato -> { control, setError }

  // --- Sugerencias, capturas, diagnóstico y aviso ---
  const faq = createSuggestions();
  const attach = createAttachPicker({});
  const diag = createDiagnosticPicker({ onChange: () => { diagError.textContent = ''; scheduleSave(); } });
  const diagError = h('div', { class: 'sp-error', role: 'alert' });
  const notify = h('input', { type: 'checkbox', id: `${formId}-notify`, checked: isNotifyEnabled(true) });
  const notifyRow = h('label', { class: 'sp-check', for: `${formId}-notify` }, notify, h('span', {}, h('strong', {}, S('notifyLabel')), h('span', { class: 'sp-hint block' }, S('notifyHint'))));

  // --- Estado del formulario ---
  const draftNote = h('div', { class: 'notice info sp-draft', hidden: true, role: 'status' });
  const limitNote = h('div', { class: 'notice warn', hidden: true, role: 'status' }, icon('clock'), h('span', {}));
  const summary = h('div', { class: 'sp-summary', role: 'alert', tabindex: '-1', hidden: true });
  const submit = h('button', { type: 'submit', class: 'btn primary' }, icon('send'), S('submit'));
  const hintSend = h('span', { class: 'muted small' }, S('submitHint'));
  const titleId = `${formId}-title`;
  const el = h('form', { class: 'card sp-form', novalidate: true, 'aria-labelledby': titleId, onsubmit: onSubmit },
    h('div', { class: 'sp-form-head' }, h('h2', { id: titleId }, S('formTitle')), h('p', { class: 'muted small' }, S('formSub', { max: LIMITS.openTickets }))),
    draftNote, limitNote, h('p', { class: 'sp-safety' }, icon('lock'), S('safetyNote')),
    catFieldset, faq.el, subjectF.el, detailsBox, messageF.el, h('div', { class: 'sp-tpl' }, tplButton), attach.el,
    diag.el, diagError, notifyRow, summary,
    h('div', { class: 'sp-actions' }, submit, hintSend));

  // ---------- Datos propios del tema ----------
  function drawDetails() {
    detailControls.clear();
    const fields = (DETAIL_FIELDS[state.category] || []).filter((f) => fieldVisible(state.category, f, state.details));
    detailsBox.hidden = !fields.length;
    mount(detailsBox, fields.length ? h('legend', { class: 'sp-label' }, S('detailsLegend')) : null, h('div', { class: 'sp-details-grid' }, fields.map((f) => {
      const cat = state.category;
      let control;
      if (f.kind === 'select') {
        control = h('select', { class: 'select', name: f.id }, h('option', { value: '' }, S('choose')), f.options.map((o) => h('option', { value: o, selected: state.details[f.id] === o }, S(`opt_${cat}_${f.id}_${o}`))));
      } else if (f.kind === 'area') {
        control = h('textarea', { class: 'input', rows: 3, maxlength: f.max, name: f.id, value: state.details[f.id] || '' });
      } else {
        control = h('input', { class: 'input', type: f.kind === 'date' ? 'date' : 'text', maxlength: f.max, name: f.id, autocomplete: 'off', value: state.details[f.id] || '' });
      }
      const hasHint = f.kind !== 'select';
      const built = field({ label: S(`fld_${cat}_${f.id}`), control, required: f.required, max: f.kind === 'area' ? f.max : 0, hint: hasHint ? S(`fldh_${cat}_${f.id}`) : null, wide: f.kind === 'area' });
      control.addEventListener('input', () => { state.details[f.id] = control.value; built.setError(''); scheduleSave(); });
      control.addEventListener('change', () => {
        state.details[f.id] = control.value;
        built.setError('');
        // El medio de pago, la fecha y la referencia solo aparecen en pagos y reembolsos.
        if (cat === 'payments' && f.id === 'topic') { drawDetails(); detailControls.get('topic')?.control.focus(); }
        scheduleSave();
      });
      detailControls.set(f.id, built);
      return built.el;
    })));
  }

  function setCategory(category, { keepFocus = true } = {}) {
    state.category = category;
    state.details = cleanDetails(category, state.details);
    for (const r of radios) r.input.checked = r.c === category;
    subject.placeholder = S(`subjectPh_${category}`);
    drawDetails();
    faq.update(`${subject.value} ${message.value}`, category);
    if (keepFocus) scheduleSave();
  }

  function useTemplate() {
    const text = S(`tpl_${state.category}`);
    message.value = message.value.trim() ? `${message.value.trimEnd()}\n\n${text}` : text;
    message.dispatchEvent(new Event('input'));
    message.focus();
    message.setSelectionRange(message.value.length, message.value.length);
  }

  // ---------- Borrador ----------
  const readDraft = () => ({ category: state.category, subject: subject.value, message: message.value, details: state.details });
  const persist = () => { const raw = serializeDraft(readDraft()); prefs.set(key, raw || null); };
  const scheduleSave = debounce(() => { if (alive && !busy) persist(); }, 600);
  function restoreDraft() {
    const draft = parseDraft(prefs.get(key));
    if (!draft) return;
    state.category = CATEGORIES.includes(draft.category) ? draft.category : 'bug';
    state.details = draft.details;
    subject.value = draft.subject;
    message.value = draft.message;
    mount(draftNote, icon('save'), h('span', { class: 'spacer' }, S('draftRestored', { when: draft.savedAt ? fmtWhen(new Date(draft.savedAt).toISOString()) : S('draftBefore') })),
      h('button', { type: 'button', class: 'btn sm ghost', onclick: discardDraft }, icon('trash'), S('draftDiscard')));
    draftNote.hidden = false;
  }
  function discardDraft() {
    prefs.set(key, null);
    draftNote.hidden = true;
    resetFields();
    subject.focus();
  }
  function resetFields() {
    subject.value = '';
    message.value = '';
    state.details = {};
    attach.clear();
    diag.reset();
    clearErrors();
    setCategory(state.category, { keepFocus: false });
    for (const f of [subjectF, messageF]) f.repaint();
  }

  // ---------- Validación ----------
  const errorText = (code, vars) => S(`val_${code}`, vars);
  function clearErrors() {
    subjectF.setError('');
    messageF.setError('');
    for (const d of detailControls.values()) d.setError('');
    catFieldset.lastChild.textContent = '';
    diagError.textContent = '';
    summary.hidden = true;
  }
  function paint(result) {
    clearErrors();
    const jump = [];
    const add = (label, focus) => jump.push({ label, focus });
    if (result.errors.category) { catFieldset.lastChild.textContent = errorText('category'); add(S('catLegend'), () => radios[0].input.focus()); }
    if (result.errors.subject) { subjectF.setError(errorText(result.errors.subject, { min: LIMITS.subject[0], max: LIMITS.subject[1] })); add(S('subject'), () => subject.focus()); }
    for (const [fieldId, code] of Object.entries(result.errors.details)) {
      const built = detailControls.get(fieldId);
      const spec = (DETAIL_FIELDS[state.category] || []).find((f) => f.id === fieldId);
      built?.setError(errorText(code, { max: spec?.max }));
      add(S(`fld_${state.category}_${fieldId}`), () => built?.control.focus());
    }
    if (result.errors.message) { messageF.setError(errorText(result.errors.message, { min: LIMITS.message[0], max: LIMITS.message[1] })); add(S('message'), () => message.focus()); }
    if (result.errors.diagnostic) { diagError.textContent = errorText('diagnostic', { max: LIMITS.diagnostic }); add(S('diagTitle'), () => diag.el.querySelector('input')?.focus()); }
    mount(summary, h('strong', {}, S('summaryTitle', { count: jump.length })), h('ul', {}, jump.map((j) => h('li', {}, h('button', { type: 'button', class: 'sp-link', onclick: j.focus }, j.label)))));
    summary.hidden = !jump.length;
    if (jump.length) { summary.focus(); }
  }

  // ---------- Enviar ----------
  async function onSubmit(event) {
    event.preventDefault();
    if (busy || !alive) return;
    const form = { category: state.category, subject: subject.value, message: message.value, details: state.details };
    const result = validateTicket(form, { diagnosticChars: diag.chars() });
    paint(result);
    if (!result.ok) return;
    if (openCount >= LIMITS.openTickets) return;
    busy = true;
    const done = setBusy(submit);
    try {
      const ticket = await supportCall('create', {
        subject: subject.value.trim(), category: state.category, message: message.value.trim(),
        details: cleanDetails(state.category, state.details), diagnostic: diag.value(),
      });
      if (!alive) return;
      const picked = attach.items();
      let upload = { failed: 0, error: null };
      if (picked.length) upload = await uploadAll(ticket.id, ticket.firstMessageId, picked, supportCall);
      prefs.set(key, null);
      draftNote.hidden = true;
      setNotifyEnabled(notify.checked);
      resetFields();
      ok(S('created'), S('createdText'));
      if (upload.failed) warnUpload(upload.failed, upload.error);
      onSent(ticket.id);
    } catch (err) {
      if (!alive) return;
      mount(summary, h('strong', {}, S('sendFailed')), h('p', {}, errMsg(err)));
      summary.hidden = false;
      summary.focus();
    } finally {
      busy = false;
      done();
    }
  }

  // ---------- Armado ----------
  const refreshSuggestions = debounce(() => { if (alive) faq.update(`${subject.value} ${message.value}`, state.category); }, 250);
  for (const control of [subject, message]) control.addEventListener('input', () => { refreshSuggestions(); scheduleSave(); if (control === subject) subjectF.setError(''); else messageF.setError(''); });
  message.addEventListener('paste', attach.onPaste);
  onCtrlEnter(message, () => el.requestSubmit());
  restoreDraft();
  setCategory(state.category, { keepFocus: false });
  faq.update(`${subject.value} ${message.value}`, state.category);

  return {
    el,
    focus() { subject.focus(); },
    hasDraft: () => !draftIsEmpty(readDraft()),
    setOpenCount(n) {
      openCount = n;
      const full = n >= LIMITS.openTickets;
      limitNote.hidden = !full;
      limitNote.lastChild.textContent = S('tooManyOpen', { count: LIMITS.openTickets });
      submit.disabled = full;
    },
    destroy() { alive = false; persist(); attach.clear(); },
  };
}
