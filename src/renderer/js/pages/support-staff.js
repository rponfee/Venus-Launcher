// Dedicated support inbox: permission is checked again on every direct page visit.
import { h, icon, mount, loading } from '../ui.js';
import { cloud } from '../cloud.js';
import { navigate } from '../app.js';
import { S, supportCall, ticketDesk } from '../features/support.js';
import { onStaffAccess } from '../features/support-staff.js';

export default {
  ns: ['support', 'plans'],
  css: ['pages/support', 'features/plans'],
  async render(root) {
    const header = h('div', { class: 'page-head' }, h('div', { class: 'ph-text' },
      h('h1', { class: 'page-title' }, S('staffTitle')),
      h('p', { class: 'page-sub' }, S('staffSubtitle'))));
    mount(root, header, loading(S('staffChecking')));
    await cloud.ready();
    if (!root.isConnected) return;
    const owner = cloud.user?.id || null;
    let alive = true;
    let desk = null;
    const cleanup = () => { alive = false; offAuth(); offAccess(); desk?.destroy(); };
    const offAccess = onStaffAccess(({ owner: checkedOwner, isStaff }) => {
      if (checkedOwner !== owner || isStaff !== false) return;
      cleanup();
      mount(root);
      navigate('support');
    });
    const offAuth = cloud.on('auth', () => {
      if ((cloud.user?.id || null) === owner) return;
      cleanup();
      mount(root);
      navigate('support');
    });
    let authorized = false;
    let unavailable = false;
    if (owner) {
      try {
        authorized = (await supportCall('staffState'))?.isStaff === true;
      } catch {
        unavailable = true;
      }
    }
    if (!alive || !root.isConnected || (cloud.user?.id || null) !== owner) {
      cleanup();
      return;
    }
    if (!authorized) {
      mount(root, header, h('section', { class: 'card support-detail' },
        h('h2', {}, S(unavailable ? 'staffUnavailable' : 'staffDenied')),
        h('p', { class: 'muted' }, S(unavailable ? 'staffUnavailableText' : 'staffDeniedText')),
        h('div', { class: 'support-actions' },
          h('button', { type: 'button', class: 'btn primary', onclick: () => navigate('support') }, icon('message'), S('goCustomerSupport')),
          unavailable ? h('button', { type: 'button', class: 'btn', onclick: () => navigate('support-staff') }, icon('refresh'), S('refresh')) : null)));
      return cleanup;
    }
    desk = ticketDesk({ admin: true });
    mount(root, header, desk.el);
    return cleanup;
  },
};
