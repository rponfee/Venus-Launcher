import { h, mount } from '../ui.js';
import { store } from '../store.js';
import { t } from '../i18n.js';
import { appendUpdates } from './settings/updates.js';

export default {
  ns: ['updates'],
  css: ['pages/settings', 'pages/updates'],
  render(root) {
    let alive = true;
    const cleanups = [];
    const body = h('div', { class: 'updates-body' });
    mount(root, h('div', { class: 'updates-page' },
      h('header', { class: 'page-head' }, h('div', { class: 'ph-text' },
        h('h1', { class: 'page-title' }, t('updates.title')),
        h('p', { class: 'page-sub' }, t('updates.subtitle')))), body));
    appendUpdates(body, {
      info: store.info || {},
      alive: () => alive && root.isConnected,
      onCleanup: (fn) => { if (typeof fn === 'function') cleanups.push(fn); },
    });
    return () => { alive = false; cleanups.forEach((off) => off()); };
  },
};
