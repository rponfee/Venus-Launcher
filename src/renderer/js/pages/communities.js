// Comunidades (#/communities[/explore] · #/communities/<id>[/<canal>] abre una): las tuyas, el buscador de públicas y la pantalla
// con canales fijos de texto y voz (pages/communities/view.js). Reglas y RPC: 0033_clanes_comunidades.sql · guía: docs/wip/clanes-comunidades-34.md.
import { h, icon, mount, emptyState, skeleton, setBusy, ok, debounce } from '../ui.js';
import { t } from '../i18n.js';
import { navigate } from '../app.js';
import { groupsBackend, errText } from '../features/clans/backend.js';
import { COMMUNITY_LIMITS, normalizeCode } from '../features/clans/logic.js';
import { openCommunityForm } from './communities/forms.js';
import { communityView } from './communities/view.js';

const C = (key, vars) => t(`clans.${key}`, vars);
const TABS = [{ id: 'mine', icon: 'users' }, { id: 'explore', icon: 'compass' }];

function head() {
  return h('div', { class: 'page-head' }, h('div', { class: 'ph-text' }, h('h1', { class: 'page-title' }, C('communitiesTitle')), h('p', { class: 'page-sub' }, C('communitiesSubtitle'))));
}

function problem(err, retry) {
  return emptyState('alert', errText(err), '', h('button', { type: 'button', class: 'btn', onclick: retry }, icon('refresh'), C('retry')));
}

function communityCard(c) {
  const open = () => navigate(`communities/${encodeURIComponent(c.id)}`);
  return h('article', { class: 'card cm-card' },
    h('div', { class: 'cm-card-head' },
      h('span', { class: 'cm-card-icon', 'aria-hidden': 'true' }, icon(c.isPublic ? 'globe' : 'lock')),
      h('button', { class: 'cl-link ellipsis', type: 'button', onclick: open }, c.name),
      c.myRole && c.myRole !== 'member' ? h('span', { class: 'badge accent' }, C(`role_${c.myRole}`)) : null),
    c.description ? h('p', { class: 'cm-card-desc' }, c.description) : null,
    h('div', { class: 'cm-card-foot' },
      h('span', { class: 'cl-muted small' }, C('membersCount', { n: c.memberCount ?? 0, max: c.maxMembers ?? COMMUNITY_LIMITS.members })),
      h('button', { class: 'btn sm', type: 'button', onclick: open }, c.myRole ? C('open_community') : C('view'))));
}

function mineView(host, { b }) {
  const list = h('div', { class: 'cm-grid' });
  const code = h('input', { class: 'input mono', id: 'cm-code', placeholder: 'COM-XXXXXX', maxlength: '10', autocomplete: 'off', spellcheck: 'false' });
  const join = h('button', { class: 'btn', type: 'button' }, icon('logIn'), C('joinWithCode'));
  const codeError = h('div', { class: 'field-error', role: 'alert', hidden: true });
  const tryJoin = async () => {
    codeError.hidden = true;
    const value = normalizeCode(code.value, 'COM');
    const show = (text) => {
      codeError.textContent = text;
      codeError.hidden = false;
    };
    if (!value) return show(C('err_bad_code'));
    const done = setBusy(join);
    try {
      const c = await b.rpc('community_join_code', { p_code: value });
      ok(C('communityJoined', { name: c?.name || '' }));
      navigate(`communities/${encodeURIComponent(c.id)}`);
    } catch (err) {
      show(err?.code === 'not_found' ? C('err_code_not_found') : errText(err));
    } finally {
      done();
    }
    return undefined;
  };
  join.addEventListener('click', tryJoin);
  code.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryJoin(); });
  const create = h('button', { class: 'btn primary', type: 'button', onclick: () => openCommunityForm(b, { onSaved: (c) => c?.id && navigate(`communities/${encodeURIComponent(c.id)}`) }) }, icon('plus'), C('communityCreateButton'));
  mount(host,
    h('div', { class: 'cl-controls' }, create, h('div', { class: 'cm-code' }, h('label', { class: 'sr-only', for: 'cm-code' }, C('codeLabel')), code, join)),
    codeError,
    list);
  async function load() {
    mount(list, skeleton('grid', { items: 3, min: 260, lines: 3 }));
    try {
      const rows = await b.rpc('community_my');
      if (!host.isConnected) return;
      mount(list, rows?.length ? rows.map(communityCard) : emptyState('users', C('communitiesEmpty'), C('communitiesEmptyText'), h('button', { class: 'btn', type: 'button', onclick: () => navigate('communities/explore') }, icon('compass'), C('comTab_explore'))));
    } catch (err) {
      if (host.isConnected) mount(list, problem(err, load));
    }
  }
  load();
}

function exploreView(host, { b }) {
  const search = h('input', { class: 'input', type: 'search', placeholder: C('communitySearch'), 'aria-label': C('communitySearch'), maxlength: '40' });
  const list = h('div', { class: 'cm-grid', 'aria-live': 'polite' });
  let seq = 0;
  async function load() {
    const my = ++seq;
    mount(list, skeleton('grid', { items: 3, min: 260, lines: 3 }));
    try {
      const rows = await b.rpc('community_search', { p_query: search.value.trim() });
      if (my !== seq || !host.isConnected) return;
      mount(list, rows?.length ? rows.map(communityCard) : emptyState('search', C('searchEmpty'), C('communitySearchEmpty')));
    } catch (err) {
      if (my === seq && host.isConnected) mount(list, problem(err, load));
    }
  }
  search.addEventListener('input', debounce(load, 300));
  mount(host, h('div', { class: 'input-icon cl-search' }, icon('search'), search), list);
  load();
}

const VIEWS = { mine: mineView, explore: exploreView };

export default {
  ns: ['clans'],
  css: ['pages/clans', 'pages/messages'],
  async render(root, params = []) {
    const b = await groupsBackend();
    if (!root.isConnected) return null;
    if (!b.signedIn()) {
      mount(root, head(), h('div', { class: 'cl-signed-out' }, emptyState('logIn', C('signInTitle'), C('communitiesSignInText'),
        h('button', { type: 'button', class: 'btn primary', onclick: () => navigate('settings/cloud') }, icon('logIn'), C('signIn')))));
      return b.onAuth?.(() => { if (b.signedIn()) navigate('communities'); }) || null;
    }
    const user = b.userId();
    const offAuth = b.onAuth?.(() => { if (b.userId() !== user) navigate('communities'); });
    if (params[0] && !VIEWS[params[0]]) {
      const close = communityView(root, params[0], params[1] || null, { b });
      return () => {
        close();
        offAuth?.();
      };
    }
    let current = VIEWS[params[0]] ? params[0] : 'mine';
    const tabBar = h('div', { class: 'tabs cl-tabs', role: 'tablist', 'aria-label': C('communitiesTabsLabel') });
    const panel = h('div', { class: 'cl-panel', role: 'tabpanel', tabindex: '-1' });
    function select(id) {
      current = id;
      mount(tabBar, TABS.map((tab) => h('button', {
        type: 'button', class: ['tab', tab.id === current && 'active'], role: 'tab', 'aria-selected': String(tab.id === current), tabindex: tab.id === current ? '0' : '-1', dataset: { tab: tab.id }, onclick: () => select(tab.id),
      }, icon(tab.icon), C(`comTab_${tab.id}`))));
      VIEWS[id](panel, { b });
      try {
        history.replaceState(null, '', id === 'mine' ? '#/communities' : `#/communities/${id}`);
      } catch {
        /* sin historial */
      }
    }
    tabBar.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      const next = TABS[(TABS.findIndex((x) => x.id === current) + 1) % TABS.length];
      select(next.id);
      tabBar.querySelector(`[data-tab="${next.id}"]`)?.focus();
    });
    mount(root, head(), tabBar, panel);
    select(current);
    return offAuth || null;
  },
};
