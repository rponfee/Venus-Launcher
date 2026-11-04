// Extensiones (#/extensions[/installed|catalog]): las instaladas con sus permisos y el catálogo de la comunidad.
// El grueso vive en pages/extensions/installed.js y pages/extensions/catalog.js; acá van las pestañas.
import { h, icon, mount } from '../ui.js';
import { t } from '../i18n.js';
import { startup, refreshExtensions } from '../features/extensions.js';
import { installedTab } from './extensions/installed.js';
import { catalogTab } from './extensions/catalog.js';

const TABS = ['installed', 'catalog'];
const memo = { tab: 'installed' };

export default {
  ns: ['extensions'],
  css: ['pages/extensions'],
  async render(root, params = []) {
    if (TABS.includes(params[0])) memo.tab = params[0];
    await startup();
    await refreshExtensions();
    const tabBar = h('div', { class: 'tabs', role: 'tablist', 'aria-label': t('extensions.tabsLabel') });
    const host = h('div', { class: 'xt-tab-host' });
    let panel = null;

    const icons = { installed: 'puzzle', catalog: 'globe' };
    function drawTabs() {
      mount(
        tabBar,
        TABS.map((id) =>
          h(
            'button',
            { type: 'button', class: ['tab', memo.tab === id && 'active'], role: 'tab', 'aria-selected': String(memo.tab === id), tabindex: memo.tab === id ? '0' : '-1', onclick: () => select(id) },
            icon(icons[id]),
            t(`extensions.tab_${id}`),
          ),
        ),
      );
    }
    tabBar.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      const i = TABS.indexOf(memo.tab) + (e.key === 'ArrowRight' ? 1 : -1);
      select(TABS[(i + TABS.length) % TABS.length]);
      tabBar.querySelector('.tab.active')?.focus();
    });
    function select(id) {
      memo.tab = id;
      drawTabs();
      panel?.destroy?.();
      panel = id === 'catalog' ? catalogTab() : installedTab();
      mount(host, panel.el);
    }

    mount(
      root,
      h(
        'div',
        { class: 'xt-root' },
        h('div', { class: 'page-head' }, h('div', { class: 'ph-text' }, h('h1', { class: 'page-title' }, t('extensions.title')), h('p', { class: 'page-sub' }, t('extensions.subtitle')))),
        tabBar,
        host,
      ),
    );
    select(memo.tab);
    return () => panel?.destroy?.();
  },
};
