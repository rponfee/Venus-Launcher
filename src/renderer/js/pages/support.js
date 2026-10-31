// Soporte: consultas con el equipo de Venus. Los planes se compran desde Planes (Ajustes > Plan o el asistente).
import { h, icon, mount, setBusy, ok } from '../ui.js';
import { cloud } from '../cloud.js';
import { navigate } from '../app.js';
import { S, CATEGORIES, supportCall, ticketDesk, isPendingTicket } from '../features/support.js';

const MAX_OPEN = 3;

export default {
  ns: ['support', 'plans'],
  css: ['pages/support', 'features/plans'],
  async render(root) {
    await cloud.ready();
    if (!root.isConnected) return;
    const header = h('div', { class: 'page-head' }, h('div', { class: 'ph-text' }, h('h1', { class: 'page-title' }, S('title')), h('p', { class: 'page-sub' }, S('subtitle'))));
    const plansHint = h('div', { class: 'notice info' }, icon('crown'), h('div', { class: 'spacer' }, S('plansHint')),
      h('button', { type: 'button', class: 'btn sm', onclick: () => import('../features/plans.js').then((m) => m.openPlans()) }, S('openPlans')));
    if (!cloud.isSignedIn()) {
      mount(root, header, h('div', { class: 'notice info' }, icon('logIn'), h('div', { class: 'spacer' }, S('signInText')), h('button', { class: 'btn primary', onclick: () => navigate('settings/cloud/venus') }, S('signIn'))), plansHint);
      return cloud.on('auth', () => navigate('support'));
    }
    let busy = false;
    let alive = true;
    const subject = h('input', { class: 'input', name: 'subject', minlength: 3, maxlength: 120, required: true, placeholder: S('subjectPlaceholder') });
    const category = h('select', { class: 'select', name: 'category', required: true },
      CATEGORIES.map((c) => h('option', { value: c, selected: c === 'general' }, S(`cat_${c}`))));
    const message = h('textarea', { class: 'input', name: 'message', rows: 4, minlength: 1, maxlength: 4000, required: true, placeholder: S('messagePlaceholder') });
    const formError = h('p', { class: 'support-form-error', role: 'alert' });
    const limitNote = h('div', { 'aria-live': 'polite' });
    const submit = h('button', { type: 'submit', class: 'btn primary' }, icon('send'), S('createTicket'));
    const fields = h('fieldset', { class: 'support-fields' },
      h('legend', { class: 'sr-only' }, S('requestTitle')),
      h('div', { class: 'support-form-row' }, h('label', {}, S('subject'), subject), h('label', {}, S('category'), category)),
      h('label', {}, S('message'), message),
      h('p', { class: 'muted small' }, S('formHint')), formError, submit);
    const form = h('form', { class: 'card support-form', onsubmit: async (event) => {
      event.preventDefault();
      if (!alive || busy || !subject.value.trim() || !message.value.trim()) return;
      busy = true;
      formError.textContent = '';
      const done = setBusy(submit);
      try {
        const ticket = await supportCall('create', { subject: subject.value.trim(), category: category.value, message: message.value.trim() });
        if (!alive) return;
        ok(S('created'), S('createdText'));
        subject.value = '';
        message.value = '';
        await desk.refresh();
        desk.select(ticket.id);
        desk.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (err) { if (alive) formError.textContent = err?.message || String(err); }
      finally { busy = false; done(); }
    } }, h('h2', {}, S('requestTitle')), limitNote, fields);
    const desk = ticketDesk({ onTickets(tickets) {
      const open = tickets.filter((ticket) => isPendingTicket(ticket)).length;
      fields.disabled = open >= MAX_OPEN;
      mount(limitNote, open >= MAX_OPEN ? h('div', { class: 'notice info' }, icon('clock'), S('tooManyOpen', { count: MAX_OPEN })) : null);
    } });
    mount(root, header, plansHint, form, desk.el);
    const currentUser = cloud.user?.id;
    const offAuth = cloud.on('auth', () => {
      if (cloud.user?.id === currentUser) return;
      alive = false;
      desk.destroy();
      mount(root);
      navigate('support');
    });
    return () => { alive = false; offAuth(); desk.destroy(); };
  },
};
