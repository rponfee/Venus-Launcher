// Competir (#/compete[/rankings|challenges|events] · #/compete/events/<id> abre ese evento): rankings entre amigos,
// desafíos con Venus Points y el calendario de eventos y torneos. Lo que corre sin abrir la página (envíos, avisos y
// recordatorios) está en features/compete.js; reglas y RPC en 0031_competencia.sql · guía: docs/wip/competir-33.md.
import { h, icon, mount, emptyState } from '../ui.js';
import { t } from '../i18n.js';
import { navigate } from '../app.js';
import { competeBackend, onChallenges, getChallenges } from '../features/compete.js';
import { groupChallenges } from './compete/logic.js';
import { rankingsView } from './compete/rankings.js';
import { challengesView } from './compete/challenges.js';
import { eventsView } from './compete/events.js';

const C = (key, vars) => t(`compete.${key}`, vars);
const TABS = [
  { id: 'rankings', icon: 'trophy', view: rankingsView },
  { id: 'challenges', icon: 'swords', view: challengesView },
  { id: 'events', icon: 'calendar', view: eventsView },
];

function head() {
  return h('div', { class: 'page-head' }, h('div', { class: 'ph-text' }, h('h1', { class: 'page-title' }, C('title')), h('p', { class: 'page-sub' }, C('subtitle'))));
}

export default {
  ns: ['compete', 'clans'],
  css: ['pages/compete'],
  async render(root, params = []) {
    const b = await competeBackend();
    if (!root.isConnected) return null;
    if (!b.signedIn()) {
      mount(root, head(), h('div', { class: 'cp-signed-out' }, emptyState('logIn', C('signInTitle'), C('signInText'),
        h('button', { type: 'button', class: 'btn primary', onclick: () => navigate('settings/cloud') }, icon('logIn'), C('signIn')))));
      return b.onAuth?.(() => { if (b.signedIn()) navigate('compete'); }) || null;
    }

    const panels = new Map(); // id -> { el, destroy }
    let current = TABS.some((x) => x.id === params[0]) ? params[0] : 'rankings';
    const tabBar = h('div', { class: 'tabs cp-tabs', role: 'tablist', 'aria-label': C('tabsLabel') });
    const host = h('div', { class: 'cp-panels' });

    const drawTabs = () => {
      const incoming = groupChallenges(getChallenges().data?.challenges).incoming.length;
      mount(tabBar, TABS.map((tab) => h('button', {
        type: 'button',
        class: ['tab', tab.id === current && 'active'],
        role: 'tab',
        id: `cp-tab-${tab.id}`,
        'aria-selected': String(tab.id === current),
        'aria-controls': `cp-panel-${tab.id}`,
        tabindex: tab.id === current ? '0' : '-1',
        dataset: { tab: tab.id },
        onclick: () => select(tab.id),
      }, icon(tab.icon), C(`tab_${tab.id}`), tab.id === 'challenges' ? h('span', { class: 'count' }, incoming ? String(incoming) : '') : null)));
    };
    tabBar.addEventListener('keydown', (e) => {
      const i = TABS.findIndex((x) => x.id === current);
      const next = e.key === 'ArrowRight' ? TABS[(i + 1) % TABS.length] : e.key === 'ArrowLeft' ? TABS[(i - 1 + TABS.length) % TABS.length] : null;
      if (!next) return;
      e.preventDefault();
      select(next.id);
      tabBar.querySelector(`[data-tab="${next.id}"]`)?.focus();
    });

    function select(id, args = []) {
      current = id;
      drawTabs();
      let p = panels.get(id);
      if (!p) {
        p = { el: h('div', { class: 'cp-panel', role: 'tabpanel', id: `cp-panel-${id}`, 'aria-labelledby': `cp-tab-${id}`, tabindex: '-1' }), destroy: null };
        panels.set(id, p);
        host.append(p.el);
        p.destroy = TABS.find((x) => x.id === id).view(p.el, { b, args }) || null;
      }
      for (const [pid, panel] of panels) panel.el.hidden = pid !== id;
      try {
        history.replaceState(null, '', `#/compete/${id}`);
      } catch {
        /* sin historial */
      }
    }

    mount(root, head(), tabBar, host);
    select(current, params.slice(1));
    const off = onChallenges(drawTabs);
    // Cambió la cuenta (renovar la sesión no cuenta): la página empieza de nuevo.
    const user = b.userId();
    const offAuth = b.onAuth?.(() => { if (b.userId() !== user) navigate('compete'); });
    return () => {
      off();
      offAuth?.();
      for (const panel of panels.values()) panel.destroy?.();
    };
  },
};
