// Denunciar un mensaje, una comunidad o un clan (RPC community_report de 0033: 10 por día y una abierta por cosa).
//   openGroupReport({ kind: 'message' | 'community' | 'clan', id, name? })
import { h, icon, modal, ok, setBusy } from '../../ui.js';
import { t, loadNs } from '../../i18n.js';
import { groupsBackend, errText } from './backend.js';
import { REPORT_REASONS } from './logic.js';

const C = (key, vars) => t(`clans.${key}`, vars);

export async function openGroupReport({ kind, id, name = '' }) {
  await loadNs('clans');
  const b = await groupsBackend();
  const reason = h('select', { class: 'select', id: 'cl-rep-reason' }, REPORT_REASONS.map((r) => h('option', { value: r }, C(`reason_${r}`))));
  const text = h('textarea', { class: 'textarea', id: 'cl-rep-text', rows: '3', maxlength: '300', placeholder: C('reportPlaceholder') });
  const error = h('div', { class: 'field-error', role: 'alert', hidden: true });
  const send = h('button', { class: 'btn danger', type: 'button' }, icon('alert'), C('reportSend'));
  const cancel = h('button', { class: 'btn ghost', type: 'button' }, C('cancel'));
  const m = modal({
    title: C(`reportTitle_${kind}`),
    subtitle: name || null,
    icon: 'alert',
    size: 'sm',
    body: h('div', { class: 'stack' },
      h('p', { class: 'card-sub' }, C('reportHint')),
      h('div', { class: 'field' }, h('label', { for: 'cl-rep-reason' }, C('reportReason')), reason),
      h('div', { class: 'field' }, h('label', { for: 'cl-rep-text' }, C('reportText')), text),
      error),
    footer: [cancel, send],
  });
  cancel.addEventListener('click', () => m.close());
  send.addEventListener('click', async () => {
    error.hidden = true;
    const done = setBusy(send);
    try {
      await b.rpc('community_report', { p_kind: kind, p_id: id, p_reason: reason.value, p_text: text.value.trim() || null });
      ok(C('reportSent'));
      m.close();
    } catch (err) {
      error.textContent = errText(err);
      error.hidden = false;
    } finally {
      done();
    }
  });
}
