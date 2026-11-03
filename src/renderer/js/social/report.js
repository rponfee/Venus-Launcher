// Denunciar un perfil (3.1): la cancion o el contenido, con un texto opcional (RPC profile_report de 0027, 10 por dia).
//   openReportDialog({ id, name, hasSong })
import { h, icon, mount, modal, ok, fail, setBusy, registerIcons } from '../ui.js';
import { t } from '../i18n.js';
import { cloud } from '../cloud.js';
import { LIMITS } from '../features/profile-editor/model.js';
import { ensureProfileStyle } from './profile-style.js';

registerIcons({ scFlag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/>' });

const P = (k, vars) => t(`profile.${k}`, vars);

export async function openReportDialog({ id, name = '', hasSong = false } = {}) {
  await ensureProfileStyle();
  let reason = hasSong ? 'song' : 'content';
  const reasons = h('div', { class: 'pfe-radios pf-report-reasons', role: 'radiogroup', 'aria-label': P('reportReason') });
  const draw = () =>
    mount(
      reasons,
      ['song', 'content'].map((r) =>
        h('button', { type: 'button', role: 'radio', class: ['pfe-radio', reason === r && 'active'], 'aria-checked': String(reason === r), disabled: r === 'song' && !hasSong, onclick: () => ((reason = r), draw()) }, icon(r === 'song' ? 'music' : 'user'), h('span', { class: 'pfe-radio-label' }, P(`reportReason_${r}`))),
      ),
    );
  draw();
  const text = h('textarea', { class: 'textarea', rows: 3, maxlength: LIMITS.reportText, placeholder: P('reportText'), 'aria-label': P('reportText') });
  const send = h('button', { class: 'btn danger', type: 'button' }, icon('scFlag'), P('reportSend'));
  const d = modal({
    title: P('reportTitle', { name: name || t('social.someone') }),
    icon: 'scFlag',
    size: 'sm',
    body: h('div', { class: 'stack' }, h('div', { class: 'field' }, h('span', { class: 'label' }, P('reportReason')), reasons), h('div', { class: 'field' }, text)),
    footer: [h('span', { class: 'spacer' }), send],
  });
  send.addEventListener('click', async () => {
    const release = setBusy(send);
    try {
      const { error } = await cloud.client.rpc('profile_report', { p_user: id, p_reason: reason, p_text: text.value.trim() || null });
      if (error) throw error;
      d.close();
      ok(P('reportSent'), P('reportSentText'));
    } catch (err) {
      fail(P('reportFailed'), /too_many_today/.test(String(err?.message || '')) ? P('err_report_too_many_today') : err);
    } finally {
      release();
    }
  });
  return d;
}
