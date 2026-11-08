import { h, icon, mount } from '../ui.js';
import { cloud } from '../cloud.js';
import { getLanguage, t } from '../i18n.js';

const S = (key) => t(`supportai.${key}`);

export function supportAiCard() {
  const input = h('textarea', { class: 'input', rows: 3, maxlength: 1000, placeholder: S('placeholder'), 'aria-label': S('question') });
  const answer = h('div', { class: 'notice info', role: 'status', 'aria-live': 'polite', hidden: true });
  const button = h('button', { type: 'button', class: 'btn primary' }, icon('wand'), S('ask'));
  let busy = false;
  async function ask() {
    const question = input.value.trim();
    if (busy || question.length < 3) return;
    busy = true;
    button.disabled = true;
    mount(answer, S('working'));
    answer.hidden = false;
    try {
      const { data, error } = await cloud.client.functions.invoke('support-ai', { body: { question, language: getLanguage() } });
      if (error || typeof data?.answer !== 'string' || !data.answer) throw error || new Error('empty');
      mount(answer, data.answer);
    } catch {
      mount(answer, S('error'));
    } finally {
      busy = false;
      button.disabled = false;
    }
  }
  button.addEventListener('click', ask);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ask(); } });
  return h('section', { class: 'card stack' }, h('h2', {}, S('title')), h('p', { class: 'muted' }, S('description')), input, h('div', { class: 'row' }, button), answer);
}
