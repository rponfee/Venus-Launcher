// Soporte: consultas con el equipo de Venus. Los planes se compran desde Planes (Ajustes > Plan o el asistente).
import { h, icon, mount } from '../ui.js';
import { api } from '../store.js';
import { cloud } from '../cloud.js';
import { navigate } from '../app.js';
import { S, ticketDesk } from '../features/support.js';
import { supportAiCard } from '../features/support-ai.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default {
  ns: ['support', 'supportai', 'plans'],
  css: ['pages/support', 'features/plans'],
  async render(root, params = []) {
    await cloud.ready();
    if (!root.isConnected) return;
    // Solo en capturas de desarrollo (VENUS_DEVSHOT + VENUS_SUPPORT_FAKE): consultas de ejemplo sin cuenta ni servidor.
    const fake = await api.invoke('support:fakeMode').catch(() => null);
    const header = h('div', { class: 'page-head' }, h('div', { class: 'ph-text' }, h('h1', { class: 'page-title' }, S('title')), h('p', { class: 'page-sub' }, S('subtitle'))));
    const plansHint = h('div', { class: 'notice info sp-plans-hint' }, icon('crown'), h('div', { class: 'spacer' }, S('plansHint')),
      h('button', { type: 'button', class: 'btn sm', onclick: () => import('../features/plans.js').then((m) => m.openPlans()) }, S('openPlans')));
    if (!cloud.isSignedIn() && !fake) {
      mount(root, header, h('div', { class: 'notice info' }, icon('logIn'), h('div', { class: 'spacer' }, S('signInText')), h('button', { class: 'btn primary', onclick: () => navigate('settings/cloud/venus') }, S('signIn'))), plansHint);
      return cloud.on('auth', () => navigate('support'));
    }
    const desk = ticketDesk({ initial: UUID.test(params[0] || '') ? params[0] : null });
    mount(root, header, supportAiCard(), plansHint, desk.el);
    const currentUser = cloud.user?.id;
    const offAuth = cloud.on('auth', () => {
      if (cloud.user?.id === currentUser) return;
      desk.destroy();
      mount(root);
      navigate('support');
    });
    return () => { offAuth(); desk.destroy(); };
  },
};
