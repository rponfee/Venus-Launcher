// "Quizás esto te ayude": preguntas frecuentes locales que se filtran mientras la persona escribe. No consulta nada por
// internet: las respuestas están en el diccionario y el filtro en logic.js (matchFaq).
import { h, icon, mount } from '../../ui.js';
import { navigate } from '../../app.js';
import { S, uid } from './common.js';
import { FAQ, matchFaq } from './logic.js';

// -> { el, update(texto, tema) }
export function createSuggestions() {
  const id = uid('sp-faq');
  const list = h('div', { class: 'sp-faq-list' });
  const el = h('section', { class: 'sp-faq', 'aria-labelledby': `${id}-t`, hidden: true },
    h('h3', { id: `${id}-t` }, icon('spLightbulb'), S('faqTitle')), h('p', { class: 'sp-hint' }, S('faqHint')), list);
  let last = '';

  function go(entry) {
    if (entry.go.plans) import('../plans.js').then((m) => m.openPlans());
    else if (entry.go.route) navigate(entry.go.route);
  }
  return {
    el,
    update(text, category) {
      const found = matchFaq(text, category);
      const key = found.map((x) => x.id).join(',');
      if (key === last) return;
      last = key;
      el.hidden = !found.length;
      mount(list, found.map(({ id: faqId }) => {
        const entry = FAQ.find((x) => x.id === faqId);
        const item = h('details', { class: 'sp-faq-item' },
          h('summary', {}, S(`faq_${faqId}_q`)),
          h('div', { class: 'sp-faq-answer' }, h('p', {}, S(`faq_${faqId}_a`)),
            h('button', { type: 'button', class: 'btn sm', onclick: () => go(entry) }, icon('arrowRight'), S(`faq_${faqId}_go`))));
        return item;
      }));
    },
  };
}
