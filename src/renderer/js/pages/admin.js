// Panel de administración (#/admin[/<pestaña>] · #/admin/users/<id> abre la ficha de ese usuario). Solo lo registra
// features/admin.js para los admins, y además vuelve a preguntar admin:me al entrar: si la cuenta no es admin
// muestra "No autorizado". El servidor (Edge Function "admin" y cada RPC) verifica al admin en cada acción igual.
// Pestañas agrupadas por uso (team-logic.js: TAB_GROUPS): Día a día (Resumen, Soporte, Usuarios, Pagos),
// Moderación (Denuncias, Galería, Reseñas, Stickers) y Ajustes (Planes, Integraciones, Equipo, Registro).
// Guía: docs/admin.md.
import { h, icon, mount, emptyState, loading } from '../ui.js';
import { api } from '../store.js';
import { navigate } from '../app.js';
import { T, call, useFakeRpc } from './admin/parts.js';
import { currentPlans } from '../features/plans-catalog.js';
import { TAB_GROUPS, TAB_ORDER, nextTab } from './admin/team-logic.js';
import { fetchTeam } from './admin/team.js';
import * as overviewTab from './admin/overview.js';
import * as usersTab from './admin/users.js';
import * as plansTab from './admin/plans.js';
import * as auditTab from './admin/audit.js';
import * as supportTab from './admin/support.js';
import * as paymentsTab from './admin/payments.js';
import * as integrationsTab from './admin/integrations.js';
import * as reportsTab from './admin/reports.js';
import * as reviewsTab from './admin/reviews.js';
import * as stickersTab from './admin/stickers.js';
import * as galleryTab from './admin/gallery.js';
import * as teamTab from './admin/team.js';

const MODS = {
  overview: { icon: 'chart', mod: overviewTab },
  support: { icon: 'message', mod: supportTab },
  users: { icon: 'users', mod: usersTab },
  payments: { icon: 'card', mod: paymentsTab },
  reports: { icon: 'alert', mod: reportsTab },
  gallery: { icon: 'camera', mod: galleryTab },
  reviews: { icon: 'star', mod: reviewsTab },
  stickers: { icon: 'smile', mod: stickersTab },
  plans: { icon: 'layers', mod: plansTab },
  integrations: { icon: 'plug', mod: integrationsTab },
  team: { icon: 'shieldCheck', mod: teamTab },
  audit: { icon: 'history', mod: auditTab },
};
const TABS = TAB_ORDER.filter((id) => MODS[id]).map((id) => ({ id, ...MODS[id] }));

function head(sub, actions) {
  return h(
    'div',
    { class: 'page-head' },
    h('div', { class: 'ph-text' }, h('h1', { class: 'page-title' }, T('title')), h('p', { class: 'page-sub' }, sub)),
    actions ? h('div', { class: 'page-actions' }, actions) : null,
  );
}

function denied(me) {
  const reason = me?.reason;
  const text =
    reason === 'noSession' || reason === 'noCloud'
      ? T('deniedSignIn')
      : reason === 'notReady'
        ? T('deniedNotReady')
        : reason === 'network'
          ? T('deniedNetwork')
          : T('deniedText');
  const action =
    reason === 'noSession' || reason === 'noCloud'
      ? h('button', { class: 'btn primary', type: 'button', onclick: () => navigate('settings/cloud') }, icon('logIn'), T('goSettings'))
      : reason === 'network'
        ? h('button', { class: 'btn', type: 'button', onclick: () => navigate('admin') }, icon('refresh'), T('retry'))
        : h('button', { class: 'btn', type: 'button', onclick: () => navigate('home') }, icon('home'), T('goHome'));
  return h('div', { class: 'adm-root' }, head(T('subtitle')), h('section', { class: 'card adm-card adm-denied' }, emptyState('shieldAlert', T('deniedTitle'), text, action)));
}

export default {
  ns: ['admin', 'support', 'plans'],
  css: ['pages/admin', 'pages/support', 'features/plans'],
  async render(root, params = []) {
    mount(root, h('div', { class: 'adm-root' }, head(T('subtitle')), loading(T('checking'))));
    let me;
    try {
      me = await api.invoke('admin:me', { force: true });
    } catch {
      me = { isAdmin: false, reason: 'error' };
    }
    if (!root.isConnected) return null;
    if (!me || me.isAdmin !== true) {
      mount(root, denied(me));
      return null;
    }
    // Con datos de ejemplo, las RPC directas (Equipo, Resumen) van al doble local del proceso principal.
    useFakeRpc(me.fake === true);

    const state = { tab: TABS.some((x) => x.id === params[0]) ? params[0] : 'overview' };
    const panels = new Map(); // id -> { el, api }
    let plansPromise = null;
    let teamPromise = null;
    let usersFilter = null;
    const ctx = {
      selfId: me.userId,
      fake: me.fake === true,
      /** Ofertas actuales para los filtros. */
      plans() {
        if (!plansPromise) {
          plansPromise = call('plans.list')
            .then((d) => currentPlans(d.plans))
            .catch((err) => {
              plansPromise = null;
              throw err;
            });
        }
        return plansPromise;
      },
      invalidatePlans() {
        plansPromise = null;
      },
      /** Equipo (admin_team) compartido por Usuarios, la ficha y Equipo. Solo decide qué se muestra. */
      team() {
        if (!teamPromise) {
          teamPromise = fetchTeam().catch((err) => {
            teamPromise = null;
            throw err;
          });
        }
        return teamPromise;
      },
      invalidateTeam() {
        teamPromise = null;
      },
      /** Cambió el equipo (dar o quitar acceso, soporte): la columna Rol de Usuarios se vuelve a dibujar, y Equipo y
       *  el Registro (su filtro por admin) se descartan para que select() los vuelva a dibujar con el equipo nuevo. */
      onTeamChanged() {
        teamPromise = null;
        panels.get('users')?.api?.refresh?.();
        for (const id of ['team', 'audit']) {
          if (id === state.tab) continue; // la pestaña activa se recarga sola (Equipo: changed())
          const p = panels.get(id);
          if (!p) continue;
          p.api?.destroy?.();
          p.el.remove();
          panels.delete(id);
        }
      },
      goUsers(filter) {
        usersFilter = filter || null;
        const p = panels.get('users');
        if (p) {
          p.el.remove();
          panels.delete('users');
        }
        select('users');
      },
      takeUsersFilter() {
        const f = usersFilter;
        usersFilter = null;
        return f;
      },
      openUser(id, name) {
        select('users');
        panels.get('users')?.api?.openUser(id, name);
      },
      /** Ir a otra pestaña (los accesos directos del Resumen). */
      goTab(id) {
        select(id);
        tabBar.querySelector(`[data-tab="${id}"]`)?.focus();
      },
    };

    // ---------- Encabezado ----------
    const refreshBtn = h('button', { class: 'btn', type: 'button', title: T('refreshHint') }, icon('refresh'), T('refresh'));
    refreshBtn.addEventListener('click', () => {
      plansPromise = null;
      teamPromise = null;
      panels.get(state.tab)?.api?.refresh?.();
    });
    const who = h('span', { class: ['badge', me.fake ? 'warn' : 'info', 'adm-who'], title: me.email || '' }, icon('shieldCheck'), me.fake ? T('fakeMode') : T('signedInAs', { email: me.email || '—' }));
    const tabBar = h('div', { class: 'tabs adm-tabs', role: 'tablist', 'aria-label': T('tabsLabel') });
    const host = h('div', { class: 'adm-panels' });

    const tabButton = (tab) => {
      const active = tab.id === state.tab;
      return h(
        'button',
        {
          type: 'button',
          class: ['tab', active && 'active'],
          role: 'tab',
          id: `adm-tab-${tab.id}`,
          'aria-selected': String(active),
          'aria-controls': `adm-panel-${tab.id}`,
          tabindex: active ? '0' : '-1',
          dataset: { tab: tab.id },
          onclick: () => select(tab.id),
        },
        icon(tab.icon),
        T(`tab_${tab.id}`),
      );
    };
    // Grupos por uso separados por una línea (las flechas recorren todas las pestañas seguidas).
    const drawTabs = () =>
      mount(
        tabBar,
        TAB_GROUPS.map((g, i) => [
          i ? h('span', { class: 'adm-tab-sep', 'aria-hidden': 'true' }) : null,
          TABS.filter((tab) => g.tabs.includes(tab.id)).map(tabButton),
        ]),
      );
    tabBar.addEventListener('keydown', (e) => {
      if (!e.target.closest?.('[role="tab"]')) return;
      const next = nextTab(state.tab, e.key, TABS.map((x) => x.id));
      if (!next) return;
      e.preventDefault();
      select(next);
      tabBar.querySelector(`[data-tab="${next}"]`)?.focus();
    });

    function select(id) {
      if (!TABS.some((x) => x.id === id)) return;
      state.tab = id;
      drawTabs();
      let p = panels.get(id);
      if (!p) {
        p = { el: h('div', { class: 'adm-panel', role: 'tabpanel', id: `adm-panel-${id}`, 'aria-labelledby': `adm-tab-${id}`, tabindex: '-1' }), api: null };
        panels.set(id, p);
        host.append(p.el);
        try {
          p.api = TABS.find((x) => x.id === id).mod.render(p.el, ctx) || null;
        } catch (err) {
          console.error('[admin]', err);
          mount(p.el, h('div', { class: 'notice bad' }, icon('alert'), h('div', {}, err?.message || String(err))));
        }
      }
      for (const [pid, panel] of panels) panel.el.hidden = pid !== id;
      try {
        history.replaceState(null, '', `#/admin/${id}`);
      } catch {
        /* sin historial */
      }
    }

    mount(root, h('div', { class: 'adm-root' }, head(T('subtitle'), [who, refreshBtn]), tabBar, host));
    select(state.tab);
    // #/admin/users/<id>: abre la ficha de ese usuario.
    if (state.tab === 'users' && params[1]) panels.get('users')?.api?.openUser(params[1], null);
    return () => {
      useFakeRpc(false);
      for (const panel of panels.values()) panel.api?.destroy?.();
    };
  },
};
