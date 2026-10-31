// Versiones: mis instancias (cuadricula/lista, busqueda, orden, agrupado, juego en curso, importar)
// e "Instalar nueva" con todas las versiones de Minecraft y todos los loaders.
// Rutas: #/versions · #/versions/new · #/versions/new/<loader> · #/versions/new/<loader>/<version>
import { h, icon, mount } from '../ui.js';
import { store } from '../store.js';
import { t } from '../i18n.js';
import { navigate } from '../app.js';
import { instancesView } from './versions/list.js';
import { newInstanceView } from './versions/create.js';
import { importMenuItems, popMenu, closeMenu, guardDrops } from './versions/common.js';

const TABS = [
  { id: 'mine', route: 'versions', icon: 'layers', label: 'versions.tabMine' },
  { id: 'new', route: 'versions/new', icon: 'plus', label: 'versions.tabNew' },
];
// Cambio de pestania con el teclado: la pagina nueva devuelve el foco a la pestania activa.
let focusTabOnRender = false;

export default {
  ns: ['versions', 'instance'],
  css: ['pages/versions'],
  render(root, params) {
    const tab = params[0] === 'new' ? 'new' : 'mine';
    const body = h('div', { class: 'vs-body', role: 'tabpanel', id: 'vs-panel', 'aria-labelledby': `vs-tab-${tab}` });
    const count = h('span', { class: 'count' }, String(store.instances.length));

    const importBtn = h(
      'button',
      {
        class: 'btn',
        type: 'button',
        'aria-haspopup': 'menu',
        onclick: (e) => popMenu(e.currentTarget, importMenuItems()),
      },
      icon('download'),
      t('versions.import'),
      icon('chevronDown'),
    );

    const tabsBar = h(
      'div',
      { class: 'tabs vs-tabs', role: 'tablist', 'aria-label': t('versions.title') },
      TABS.map((tb) => {
        const on = tab === tb.id;
        return h(
          'button',
          {
            class: ['tab', on && 'active'],
            type: 'button',
            role: 'tab',
            id: `vs-tab-${tb.id}`,
            'aria-selected': String(on),
            'aria-controls': 'vs-panel',
            tabindex: on ? 0 : -1,
            dataset: { tab: tb.id },
            onclick: () => navigate(tb.route),
          },
          icon(tb.icon),
          t(tb.label),
          tb.id === 'mine' ? count : null,
        );
      }),
    );
    // Flechas entre pestanias (patron de tabs: solo la activa esta en el orden de Tab)
    tabsBar.addEventListener('keydown', (e) => {
      if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const i = TABS.findIndex((x) => x.id === tab);
      const n = e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
      if (n === i) return;
      focusTabOnRender = true;
      navigate(TABS[n].route);
    });

    // Sin instancias, el boton primario es el del estado vacio (uno solo por vista)
    const newBtn = tab === 'mine' ? h('button', { class: 'btn primary', type: 'button', hidden: !store.instances.length, onclick: () => navigate('versions/new') }, icon('plus'), t('versions.newInstance')) : null;

    mount(
      root,
      h(
        'div',
        { class: 'page-head' },
        h('div', { class: 'ph-text' }, h('h1', { class: 'page-title' }, t('versions.title')), h('p', { class: 'page-sub' }, t('versions.subtitle'))),
        h('div', { class: 'page-actions' }, importBtn, newBtn),
      ),
      tabsBar,
      body,
    );
    if (focusTabOnRender) {
      focusTabOnRender = false;
      tabsBar.querySelector('.tab.active')?.focus({ preventScroll: true });
    }

    const offGuard = guardDrops(root);
    const cleanup = tab === 'new' ? newInstanceView(body, params.slice(1)) : instancesView(body);
    const offCount = store.on('instances', () => {
      count.textContent = String(store.instances.length);
      if (newBtn) newBtn.hidden = !store.instances.length;
    });
    return () => {
      closeMenu();
      offCount();
      offGuard();
      if (cleanup) cleanup();
    };
  },
};
