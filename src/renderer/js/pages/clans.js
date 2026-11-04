// Clanes (#/clans[/mine|browse|ranking] · #/clans/view/<id> abre el perfil de un clan): tu clan, el buscador de clanes abiertos
// y el ranking semanal. Lo que corre sin abrir la página (invitaciones y número del menú) está en features/clans.js.
// Reglas y RPC: 0033_clanes_comunidades.sql · guía: docs/wip/clanes-comunidades-34.md.
import { h, icon, mount, emptyState, skeleton, setBusy, ok, fail, fmtAgo, fmtDate, debounce } from '../ui.js';
import { t } from '../i18n.js';
import { navigate } from '../app.js';
import { groupsBackend, errText } from '../features/clans/backend.js';
import { getMine, loadMine } from '../features/clans.js';
import { emblemBadge, forgetClanTags, tagChip } from '../features/clans/tag.js';
import { normalizeCode, rankingNotice, shiftWeek, weekOf } from '../features/clans/logic.js';
import { backToBrowse, clanProfile, hoursText } from './clans/profile.js';
import { openClanForm } from './clans/forms.js';
import { clanSharingCard } from '../features/clans/sharing.js';

const C = (key, vars) => t(`clans.${key}`, vars);
const TABS = [{ id: 'mine', icon: 'shield' }, { id: 'browse', icon: 'search' }, { id: 'ranking', icon: 'trophy' }];
const MAX_WEEKS_BACK = 12;

function head() {
  return h('div', { class: 'page-head' }, h('div', { class: 'ph-text' }, h('h1', { class: 'page-title' }, C('title')), h('p', { class: 'page-sub' }, C('subtitle'))));
}

function problem(err, retry) {
  return emptyState('alert', errText(err), '', h('button', { type: 'button', class: 'btn', onclick: retry }, icon('refresh'), C('retry')));
}

function clanRow(card, { extra = null } = {}) {
  const open = () => navigate(`clans/view/${encodeURIComponent(card.id)}`);
  return h('div', { class: 'card cl-clan-row' },
    emblemBadge(card, { size: 'md' }),
    h('div', { class: 'cl-clan-main' },
      h('div', { class: 'cl-clan-name' }, h('button', { class: 'cl-link ellipsis', type: 'button', onclick: open }, card.name), tagChip({ tag: card.tag, color: card.color })),
      card.description ? h('div', { class: 'cl-muted small ellipsis' }, card.description) : null,
      h('div', { class: 'cl-muted small' }, C('membersCount', { n: card.memberCount ?? 0, max: card.maxMembers ?? 50 }))),
    extra || h('button', { class: 'btn sm', type: 'button', onclick: open }, C('view')));
}

// ---------- Mi clan ----------
function mineView(host, { b }) {
  let rank = null;
  async function reload() {
    forgetClanTags();
    await loadMine({ force: true });
    draw();
  }
  function noClan(data) {
    const invites = Array.isArray(data?.invites) ? data.invites : [];
    const requests = Array.isArray(data?.requests) ? data.requests : [];
    const code = h('input', { class: 'input mono', id: 'cl-code', placeholder: 'CLAN-XXXXXX', maxlength: '11', autocomplete: 'off', spellcheck: 'false' });
    const join = h('button', { class: 'btn', type: 'button' }, icon('logIn'), C('joinWithCode'));
    const codeError = h('div', { class: 'field-error', role: 'alert', hidden: true });
    const tryJoin = async () => {
      codeError.hidden = true;
      const value = normalizeCode(code.value, 'CLAN');
      if (!value) {
        codeError.textContent = C('err_bad_code');
        codeError.hidden = false;
        return;
      }
      const done = setBusy(join);
      try {
        const res = await b.rpc('clan_join_code', { p_code: value });
        ok(C('joined', { name: res?.clan?.name || '' }));
        await reload();
      } catch (err) {
        codeError.textContent = err?.code === 'not_found' ? C('err_code_not_found') : errText(err);
        codeError.hidden = false;
      } finally {
        done();
      }
    };
    join.addEventListener('click', tryJoin);
    code.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryJoin(); });
    return [
      invites.length ? h('section', { class: 'cl-section' }, h('h2', { class: 'cl-h2' }, C('invitesTitle')),
        invites.map((inv) => {
          const yes = h('button', { class: 'btn sm primary', type: 'button' }, icon('check'), C('accept'));
          const no = h('button', { class: 'btn sm ghost', type: 'button' }, C('decline'));
          const answer = async (accept, btn) => {
            const done = setBusy(btn);
            try {
              await b.rpc('clan_invite_respond', { p_clan: inv.clan.id, p_accept: accept });
              if (accept) ok(C('joined', { name: inv.clan.name }));
              await reload();
            } catch (err) {
              fail(C('actionError'), errText(err));
            } finally {
              done();
            }
          };
          yes.addEventListener('click', () => answer(true, yes));
          no.addEventListener('click', () => answer(false, no));
          return clanRow(inv.clan, { extra: h('div', { class: 'row' }, no, yes) });
        })) : null,
      h('div', { class: 'cl-start' },
        h('section', { class: 'card cl-card' },
          h('h2', { class: 'card-title' }, icon('plus'), C('createTitle')),
          h('p', { class: 'card-sub' }, C('createText')),
          h('button', { class: 'btn primary', type: 'button', onclick: () => openClanForm(b, { onSaved: reload }) }, icon('shield'), C('createButton'))),
        h('section', { class: 'card cl-card' },
          h('h2', { class: 'card-title' }, icon('key'), C('codeTitle')),
          h('p', { class: 'card-sub' }, C('codeText')),
          h('div', { class: 'row' }, h('label', { class: 'sr-only', for: 'cl-code' }, C('codeLabel')), code, join),
          codeError),
        h('section', { class: 'card cl-card' },
          h('h2', { class: 'card-title' }, icon('search'), C('browseTitle')),
          h('p', { class: 'card-sub' }, C('browseText')),
          h('button', { class: 'btn', type: 'button', onclick: () => navigate('clans/browse') }, icon('search'), C('browseButton')))),
      requests.length ? h('section', { class: 'cl-section' }, h('h2', { class: 'cl-h2' }, C('myRequestsTitle')),
        requests.map((r) => {
          const cancel = h('button', { class: 'btn sm ghost', type: 'button' }, icon('x'), C('requestCancel'));
          cancel.addEventListener('click', async () => {
            const done = setBusy(cancel);
            try {
              await b.rpc('clan_request_cancel', { p_clan: r.clan.id });
              await reload();
            } catch (err) {
              fail(C('actionError'), errText(err));
            } finally {
              done();
            }
          });
          return clanRow(r.clan, { extra: h('div', { class: 'row' }, h('span', { class: 'cl-muted small' }, fmtAgo(Date.parse(r.at))), cancel) });
        })) : null,
    ];
  }
  function draw() {
    if (!host.isConnected) return;
    const { data, error } = getMine();
    if (error && !data) return mount(host, problem(error, () => { mount(host, skeleton('card', { lines: 4 })); reload(); }));
    if (data?.clan) return mount(host, clanProfile(data.clan, { b, reload, rank }));
    return mount(host, noClan(data));
  }
  mount(host, skeleton('grid', { items: 3, min: 260, lines: 3 }));
  loadMine({ force: true }).then(draw);
  // La posición llega aparte: si tarda, el perfil ya se ve sin ella.
  b.rpc('clan_ranking', {}).then((r) => {
    rank = r?.mine || null;
    if (rank && getMine().data?.clan) draw();
  }).catch(() => {});
  return null;
}

// ---------- Perfil de otro clan ----------
function viewClan(host, id, { b }) {
  async function draw() {
    try {
      const [clan, me, ranking] = await Promise.all([b.rpc('clan_get', { p_clan: id }), loadMine(), b.rpc('clan_ranking', {}).catch(() => null)]);
      if (!host.isConnected) return;
      const rank = (ranking?.rows || []).find((r) => r.id === id) || null;
      mount(host, backToBrowse(), clanProfile(clan, { b, reload: draw, rank, inClan: !!me?.data?.clan && !clan.myRole }));
    } catch (err) {
      if (!host.isConnected) return;
      mount(host, backToBrowse(), err?.code === 'not_found' ? emptyState('shield', C('clanGone'), C('clanGoneText')) : problem(err, draw));
    }
  }
  mount(host, skeleton('card', { lines: 4 }));
  draw();
  return null;
}

// ---------- Buscador ----------
function browseView(host, { b }) {
  const search = h('input', { class: 'input', type: 'search', placeholder: C('searchPlaceholder'), 'aria-label': C('searchPlaceholder'), maxlength: '40' });
  const list = h('div', { class: 'cl-section', 'aria-live': 'polite' });
  let seq = 0;
  async function load() {
    const my = ++seq;
    mount(list, skeleton('list', { rows: 4 }));
    try {
      const rows = await b.rpc('clan_search', { p_query: search.value.trim() });
      if (my !== seq || !host.isConnected) return;
      if (!rows?.length) return mount(list, emptyState('search', C('searchEmpty'), C('searchEmptyText')));
      return mount(list, rows.map((card) => clanRow(card)));
    } catch (err) {
      if (my === seq && host.isConnected) mount(list, problem(err, load));
    }
    return undefined;
  }
  search.addEventListener('input', debounce(load, 300));
  mount(host, h('div', { class: 'input-icon cl-search' }, icon('search'), search), h('p', { class: 'cl-note' }, icon('info'), h('span', {}, C('searchNote'))), list);
  load();
  return null;
}

// ---------- Ranking ----------
function rankingView(host, { b }) {
  const thisWeek = weekOf(Date.now());
  let week = thisWeek;
  let seq = 0;
  const prev = h('button', { type: 'button', class: 'icon-btn', title: C('weekPrev'), 'aria-label': C('weekPrev') }, icon('chevronLeft'));
  const next = h('button', { type: 'button', class: 'icon-btn', title: C('weekNext'), 'aria-label': C('weekNext') }, icon('chevronRight'));
  const label = h('div', { class: 'cl-week-label', role: 'status' });
  const notice = h('div');
  const list = h('section', { class: 'card cl-card', 'aria-live': 'polite' });
  function drawWeek() {
    const from = Date.parse(`${week}T00:00:00Z`);
    const opts = { day: 'numeric', month: 'short', timeZone: 'UTC' };
    mount(label, h('strong', {}, week === thisWeek ? C('weekThis') : week === shiftWeek(thisWeek, -1) ? C('weekLast') : C('weekOther')),
      h('span', { class: 'cl-muted small' }, C('weekRange', { from: fmtDate(from, opts), to: fmtDate(from + 6 * 86400000, opts) })));
    next.disabled = week >= thisWeek;
    prev.disabled = week <= shiftWeek(thisWeek, -MAX_WEEKS_BACK);
  }
  prev.addEventListener('click', () => { week = shiftWeek(week, -1); load(); });
  next.addEventListener('click', () => { week = shiftWeek(week, 1); load(); });
  const rowView = (r) => h('li', { class: ['cl-rank-row', r.mine && 'is-me'] },
    h('span', { class: ['cl-rank-pos', r.pos <= 3 && Number(r.minutes) > 0 && 'is-top'] }, String(r.pos)),
    emblemBadge(r, { size: 'sm' }),
    h('div', { class: 'cl-clan-main' },
      h('div', { class: 'cl-clan-name' }, h('button', { class: 'cl-link ellipsis', type: 'button', onclick: () => navigate(`clans/view/${encodeURIComponent(r.id)}`) }, r.name), tagChip({ tag: r.tag, color: r.color })),
      h('div', { class: 'cl-muted small' }, C('rankingRowSub', { members: r.members, sharing: r.sharing }))),
    h('span', { class: 'cl-rank-value num' }, hoursText(r.minutes)));
  async function load() {
    const my = ++seq;
    drawWeek();
    mount(list, skeleton('list', { rows: 4 }));
    try {
      const view = await b.rpc('clan_ranking', { p_week: week });
      if (my !== seq || !host.isConnected) return;
      const why = rankingNotice(view);
      mount(notice, why ? h('p', { class: 'cl-note' }, icon('info'), h('span', {}, C(`rankingZero_${why}`))) : null);
      const rows = Array.isArray(view?.rows) ? view.rows : [];
      const mine = view?.mine && !rows.some((r) => r.id === view.mine.id) ? view.mine : null;
      mount(list, rows.length ? h('ol', { class: 'cl-rank-list' }, rows.map(rowView), mine ? [h('li', { class: 'cl-rank-gap', 'aria-hidden': 'true' }, '···'), rowView(mine)] : null) : emptyState('trophy', C('rankingEmpty'), C('rankingEmptyText')));
    } catch (err) {
      if (my === seq && host.isConnected) mount(list, problem(err, load));
    }
  }
  mount(host, h('div', { class: 'cl-controls' }, h('div', { class: 'cl-week' }, prev, label, next)), h('p', { class: 'cl-note' }, icon('info'), h('span', {}, C('rankingNote'))), notice, list);
  load();
  return null;
}

const VIEWS = { mine: mineView, browse: browseView, ranking: rankingView };

export default {
  ns: ['clans'],
  css: ['pages/clans', 'pages/messages'],
  async render(root, params = []) {
    const b = await groupsBackend();
    if (!root.isConnected) return null;
    if (!b.signedIn()) {
      mount(root, head(), h('div', { class: 'cl-signed-out' }, emptyState('logIn', C('signInTitle'), C('signInText'),
        h('button', { type: 'button', class: 'btn primary', onclick: () => navigate('settings/cloud') }, icon('logIn'), C('signIn')))));
      return b.onAuth?.(() => { if (b.signedIn()) navigate('clans'); }) || null;
    }
    const viewing = params[0] === 'view' && params[1] ? params[1] : null;
    let current = viewing ? 'browse' : VIEWS[params[0]] ? params[0] : 'mine';
    const tabBar = h('div', { class: 'tabs cl-tabs', role: 'tablist', 'aria-label': C('tabsLabel') });
    let host = h('div', { class: 'cl-panel', role: 'tabpanel', tabindex: '-1' });
    const sharing = clanSharingCard({ b, onChanged: () => select(current) });
    function drawTabs() {
      mount(tabBar, TABS.map((tab) => h('button', {
        type: 'button',
        class: ['tab', tab.id === current && 'active'],
        role: 'tab',
        'aria-selected': String(tab.id === current),
        tabindex: tab.id === current ? '0' : '-1',
        dataset: { tab: tab.id },
        onclick: () => select(tab.id),
      }, icon(tab.icon), C(`tab_${tab.id}`))));
    }
    tabBar.addEventListener('keydown', (e) => {
      const i = TABS.findIndex((x) => x.id === current);
      const nextTab = e.key === 'ArrowRight' ? TABS[(i + 1) % TABS.length] : e.key === 'ArrowLeft' ? TABS[(i - 1 + TABS.length) % TABS.length] : null;
      if (!nextTab) return;
      e.preventDefault();
      select(nextTab.id);
      tabBar.querySelector(`[data-tab="${nextTab.id}"]`)?.focus();
    });
    function select(id) {
      current = id;
      // Desconectar el panel anterior: sus respuestas pendientes ya no pueden pisar la pestaña elegida.
      host = h('div', { class: 'cl-panel', role: 'tabpanel', tabindex: '-1' });
      mount(root, head(), sharing, tabBar, host);
      drawTabs();
      VIEWS[id](host, { b });
      try {
        history.replaceState(null, '', `#/clans/${id}`);
      } catch {
        /* sin historial */
      }
    }
    mount(root, head(), sharing, tabBar, host);
    if (viewing) {
      drawTabs();
      viewClan(host, viewing, { b });
    } else select(current);
    const user = b.userId();
    const offAuth = b.onAuth?.(() => { if (b.userId() !== user) navigate('clans'); });
    return () => { sharing.destroy(); offAuth?.(); };
  },
};
