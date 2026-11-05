// Logros de Venus (#/achievements[/<list o missions>]): logros con niveles y rareza, y misiones diarias y semanales. Son
// solo de Venus (el launcher y la cuenta): desde la 4.6 no hay logros ni progresos de Minecraft, y #/achievements/minecraft
// abre la lista de logros. Catalogo en achievements/catalog.js; datos en features/achievements.js y features/missions.js;
// servidor en supabase/migrations/0023_venus3.sql y 0043_logros_venus.sql. Guia: docs/venus-points.md.
import { h, icon, mount, skeleton, emptyState, setBusy, fmtDate, fmtDuration } from '../ui.js';
import { t, locale } from '../i18n.js';
import { navigate } from '../app.js';
import { ACHIEVEMENTS, GROUPS, TIERS, families, familyState, rarityOf, roman, RARITY_MIN_USERS } from './achievements/catalog.js';
import { familyName, achievementDesc, tierLabel, missionText } from './achievements/names.js';
import { checkAchievements, loadAchievements, getAchievements, onAchievements } from '../features/achievements.js';
import { loadMissions, getMissions, onMissions, claimMission, missionValue } from '../features/missions.js';
import { formatPoints } from './rewards/logic.js';

const A = (key, vars) => t(`achievements.${key}`, vars);
const TABS = [
  { id: 'list', icon: 'trophy' },
  { id: 'missions', icon: 'target' },
];
const pts = (n) => formatPoints(n, locale());

function fmtNum(n, max = 0) {
  try {
    return new Intl.NumberFormat(locale(), { maximumFractionDigits: max }).format(n);
  } catch {
    return String(n);
  }
}

// Se recuerdan mientras la app esta abierta
const memo = { group: 'all', status: 'all', query: '', open: new Set() };

export default {
  ns: ['achievements'],
  css: ['pages/achievements'],
  async render(root, params) {
    const st = { tab: TABS.some((x) => x.id === params?.[0]) ? params[0] : 'list' };
    // Una pestaña que ya no existe (la de Minecraft de las versiones anteriores) abre la lista y corrige la dirección
    if (params?.[0] && st.tab !== params[0]) history.replaceState(null, '', `#/achievements/${st.tab}`);
    const offs = [];
    let disposed = false;

    const head = h('div', { class: 'page-head' }, h('div', { class: 'ph-text' }, h('h1', { class: 'page-title' }, A('title')), h('p', { class: 'page-sub' }, A('subtitle'))));
    const summary = h('div', { class: 'ac-summary' });
    const tabBar = h('div', { class: 'tabs ac-tabs', role: 'tablist', 'aria-label': A('title') });
    const body = h('div', { class: 'ac-body', id: 'ac-panel', role: 'tabpanel' });
    mount(root, head, summary, tabBar, body);

    function metricValue(metric) {
      const s = getAchievements();
      const v = s.serverMetrics?.[metric];
      return v !== undefined ? Number(v) : s.metrics?.[metric];
    }
    const allMetrics = () => ({ ...getAchievements().metrics, ...getAchievements().serverMetrics });

    // ---------- Resumen ----------
    function drawSummary() {
      const s = getAchievements();
      const total = ACHIEVEMENTS.length;
      const done = ACHIEVEMENTS.filter((a) => s.unlocked.has(a.id)).length;
      const pct = total ? done / total : 0;
      const tiers = TIERS.map((tier) => ({ tier, n: ACHIEVEMENTS.filter((a) => a.tier === tier && s.unlocked.has(a.id)).length, of: ACHIEVEMENTS.filter((a) => a.tier === tier).length }));
      const earned = ACHIEVEMENTS.filter((a) => s.unlocked.has(a.id)).reduce((sum, a) => sum + a.points, 0);
      mount(
        summary,
        h(
          'section',
          { class: 'card ac-hero' },
          h('div', { class: 'ac-hero-main' }, h('div', { class: 'ac-hero-value' }, h('span', { class: 'num' }, fmtNum(done)), h('span', { class: 'ac-hero-of num' }, `/ ${fmtNum(total)}`)), h('div', { class: 'ac-hero-label' }, A('heroLabel', { pct: Math.round(pct * 100) })), h('div', { class: 'progress ac-hero-bar', role: 'img', 'aria-label': A('heroLabel', { pct: Math.round(pct * 100) }) }, h('i', { style: { width: `${(pct * 100).toFixed(1)}%` } }))),
          h('div', { class: 'ac-hero-tiers' }, tiers.map((x) => h('div', { class: 'ac-tier-count', dataset: { tier: x.tier }, title: tierLabel(x.tier) }, h('span', { class: 'ac-tier-dot', 'aria-hidden': 'true' }), h('span', { class: 'num' }, `${x.n}/${x.of}`), h('span', { class: 'ac-tier-name' }, tierLabel(x.tier))))),
          h('div', { class: 'ac-hero-side' }, h('div', { class: 'ac-hero-points num' }, pts(earned)), h('div', { class: 'ac-hero-label' }, A('heroPoints')), h('button', { class: 'btn ghost sm', type: 'button', onclick: () => navigate('rewards/shop') }, icon('tag'), A('goShop'))),
        ),
        s.error === 'noSession' ? h('div', { class: 'notice info ac-note' }, icon('info'), h('div', { class: 'spacer' }, A('needSession')), h('button', { class: 'btn sm', type: 'button', onclick: () => navigate('settings/cloud') }, icon('logIn'), A('signIn'))) : null,
        s.error && s.error !== 'noSession' ? h('div', { class: 'notice warn ac-note' }, icon('alert'), h('div', {}, A('serverError'))) : null,
      );
    }

    // ---------- Logros ----------
    function familyCard(fam) {
      const s = getAchievements();
      const stt = familyState(fam, { unlocked: s.unlocked, metrics: allMetrics() });
      const single = fam.single;
      const shown = stt.next || stt.current || fam.steps[0];
      const open = memo.open.has(fam.id);
      const rarityPct = Number(s.rarity?.[shown.id]);
      const rarity = rarityOf(rarityPct, s.totalUsers);
      const title = single ? familyName(fam) : `${familyName(fam)}${stt.current ? ` ${roman(stt.current.step)}` : ''}`;
      const toggle = () => {
        if (open) memo.open.delete(fam.id);
        else memo.open.add(fam.id);
        drawList();
      };
      return h(
        'article',
        { class: ['ac-fam', stt.done && 'done', !stt.current && 'locked'], dataset: { tier: stt.current?.tier || 'none' }, role: 'listitem' },
        h(
          'div',
          { class: 'ac-fam-top' },
          h('span', { class: 'ac-fam-icon', 'aria-hidden': 'true' }, icon(fam.icon)),
          h(
            'div',
            { class: 'ac-fam-main' },
            h('h3', { class: 'ac-fam-name ellipsis', title }, title),
            h('p', { class: 'ac-fam-desc' }, achievementDesc(shown.id) || A(`group_${fam.group}`)),
          ),
          fam.steps.length > 1
            ? h('button', { class: 'icon-btn sm', type: 'button', 'aria-expanded': String(open), title: A(open ? 'collapse' : 'expand'), 'aria-label': A(open ? 'collapse' : 'expand'), onclick: toggle }, icon(open ? 'chevronLeft' : 'chevronDown'))
            : null,
        ),
        !stt.done && stt.value !== null && !single
          ? h(
              'div',
              { class: 'ac-fam-progress' },
              h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(shown.target), 'aria-valuenow': String(Math.min(stt.value, shown.target)), 'aria-label': title }, h('i', { style: { width: `${(stt.progress * 100).toFixed(1)}%` } })),
              h('span', { class: 'ac-fam-progress-text num' }, `${fmtNum(Math.min(stt.value, shown.target), stt.value < 10 ? 1 : 0)} / ${fmtNum(shown.target)}`),
            )
          : null,
        h(
          'div',
          { class: 'ac-fam-foot' },
          fam.steps.length > 1 ? h('span', { class: 'ac-pips', role: 'img', 'aria-label': A('pipsAria', { done: stt.unlockedCount, total: fam.steps.length }) }, fam.steps.map((x) => h('span', { class: ['ac-pip', s.unlocked.has(x.id) && 'on'], dataset: { tier: x.tier } }))) : null,
          h('span', { class: 'spacer' }),
          rarity ? h('span', { class: 'ac-rarity', dataset: { rarity }, title: A('rarityPct', { pct: fmtNum(rarityPct, 1) }) }, A(`rarity_${rarity}`)) : null,
          stt.done
            ? h('span', { class: 'badge good' }, icon('check'), A('done'))
            : h('span', { class: 'ac-fam-points num', title: A('pointsNext') }, `+${pts(shown.points)}`),
        ),
        open
          ? h(
              'ul',
              { class: 'ac-steps' },
              fam.steps.map((x) => {
                const at = s.unlocked.get(x.id);
                const pct = Number(s.rarity?.[x.id]);
                return h(
                  'li',
                  { class: ['ac-step', at && 'on'], dataset: { tier: x.tier } },
                  h('span', { class: 'ac-tier-dot', 'aria-hidden': 'true' }),
                  h('span', { class: 'ac-step-name' }, roman(x.step)),
                  h('span', { class: 'ac-step-desc' }, achievementDesc(x.id)),
                  s.totalUsers >= RARITY_MIN_USERS && pct > 0 ? h('span', { class: 'ac-step-pct num' }, A('rarityPct', { pct: fmtNum(pct, 1) })) : null,
                  at ? h('span', { class: 'ac-step-date' }, icon('check'), fmtDate(Date.parse(at))) : h('span', { class: 'ac-step-points num' }, `+${pts(x.points)}`),
                );
              }),
            )
          : null,
      );
    }

    const listBox = h('div', { class: 'ac-grid', role: 'list', 'aria-label': A('tab_list') });
    const countBox = h('span', { class: 'ac-count num' });
    function drawList() {
      if (st.tab !== 'list') return;
      const s = getAchievements();
      const q = memo.query.trim().toLowerCase();
      const all = families();
      const metrics = allMetrics();
      const items = all
        .filter((f) => memo.group === 'all' || f.group === memo.group)
        .map((f) => ({ f, stt: familyState(f, { unlocked: s.unlocked, metrics }) }))
        .filter(({ stt }) => memo.status === 'all' || (memo.status === 'done' ? stt.done : memo.status === 'started' ? !stt.done && (stt.current || stt.progress > 0) : !stt.current && !stt.progress))
        .filter(({ f }) => !q || familyName(f).toLowerCase().includes(q) || f.steps.some((x) => achievementDesc(x.id).toLowerCase().includes(q)));
      // Primero lo que esta mas cerca de completarse
      items.sort((a, b) => Number(a.stt.done) - Number(b.stt.done) || b.stt.progress - a.stt.progress);
      countBox.textContent = A('familyCount', { n: items.length });
      mount(listBox, items.length ? items.map(({ f }) => familyCard(f)) : emptyState('search', A('emptyTitle'), A('emptyText')));
    }

    function listPanel() {
      const search = h('input', { class: 'input ac-search', type: 'search', placeholder: A('search'), value: memo.query, 'aria-label': A('search') });
      search.addEventListener('input', () => {
        memo.query = search.value;
        drawList();
      });
      const chips = h('div', { class: 'chips ac-chips', role: 'group', 'aria-label': A('filterGroup') });
      const drawChips = () =>
        mount(
          chips,
          ['all', ...GROUPS].map((g) => h('button', { type: 'button', class: ['chip', memo.group === g && 'active'], 'aria-pressed': String(memo.group === g), onclick: () => ((memo.group = g), drawChips(), drawList()) }, A(`group_${g}`))),
        );
      drawChips();
      const status = h('select', { class: 'select ac-status', 'aria-label': A('filterStatus') }, ['all', 'started', 'done', 'locked'].map((x) => h('option', { value: x, selected: memo.status === x }, A(`status_${x}`))));
      status.addEventListener('change', () => {
        memo.status = status.value;
        drawList();
      });
      const panel = h('div', { class: 'ac-list' }, h('div', { class: 'ac-toolbar' }, search, status, countBox), chips, listBox);
      queueMicrotask(drawList);
      return panel;
    }

    // ---------- Misiones ----------
    function timeLeft(iso) {
      const ms = Date.parse(iso) - Date.now();
      return Number.isFinite(ms) && ms > 0 ? fmtDuration(ms) : '';
    }

    function missionsPanel() {
      const m = getMissions();
      if (m.error === 'noSession') return emptyState('target', A('missionsTitle'), A('needSession'));
      if (!m.data) return m.error ? emptyState('alert', A('missionsTitle'), A('serverError')) : h('div', {}, skeleton('card', { lines: 3 }), skeleton('card', { lines: 3 }));
      return h(
        'div',
        { class: 'ac-missions' },
        ['daily', 'weekly'].map((period) => {
          const p = m.data[period];
          const list = p?.missions || [];
          const claimed = list.filter((x) => x.claimed).length;
          return h(
            'section',
            { class: 'card ac-period' },
            h('div', { class: 'card-head' }, h('div', {}, h('div', { class: 'card-title' }, icon(period === 'daily' ? 'calendar' : 'star'), A(`period_${period}`)), h('div', { class: 'card-sub' }, A('periodEnds', { time: timeLeft(p.endsAt) }))), h('span', { class: ['pill', p.bonusClaimed && 'good'] }, p.bonusClaimed ? A('bonusDone') : A('bonusLabel', { points: pts(p.bonus) }))),
            h('div', { class: 'ac-bonus-bar progress', role: 'img', 'aria-label': `${claimed}/${list.length}` }, h('i', { style: { width: `${list.length ? (claimed / list.length) * 100 : 0}%` } })),
            h(
              'div',
              { class: 'ac-mission-list' },
              list.map((x) => {
                const value = Math.min(missionValue(period, x.metric), x.target);
                const ready = !x.claimed && value >= x.target;
                const btn = h('button', { class: ['btn sm', ready ? 'primary' : 'ghost'], type: 'button', disabled: !ready }, x.claimed ? icon('check') : null, x.claimed ? A('claimed') : A('claim'));
                btn.addEventListener('click', async () => {
                  const done = setBusy(btn);
                  try {
                    await claimMission(x.id);
                  } finally {
                    done();
                  }
                });
                return h(
                  'article',
                  { class: ['ac-mission', x.claimed && 'done', ready && 'ready'] },
                  h('div', { class: 'ac-mission-main' }, h('div', { class: 'ac-mission-text' }, missionText(x.metric, x.target)), h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(x.target), 'aria-valuenow': String(value), 'aria-label': missionText(x.metric, x.target) }, h('i', { style: { width: `${(value / x.target) * 100}%` } })), h('div', { class: 'ac-mission-value num' }, `${fmtNum(value)} / ${fmtNum(x.target)}`)),
                  h('span', { class: 'ac-fam-points num' }, `+${pts(x.points)}`),
                  btn,
                );
              }),
            ),
          );
        }),
        h('p', { class: 'small muted ac-note-text' }, icon('info'), h('span', {}, A('missionsNote'))),
      );
    }

    // ---------- Pestañas ----------
    function drawTabs() {
      const ready = (getMissions().data ? ['daily', 'weekly'] : []).flatMap((p) => getMissions().data[p]?.missions?.filter((x) => !x.claimed && missionValue(p, x.metric) >= x.target) || []).length;
      mount(
        tabBar,
        TABS.map((x) =>
          h(
            'button',
            { type: 'button', class: ['tab', st.tab === x.id && 'active'], role: 'tab', 'aria-selected': String(st.tab === x.id), 'aria-controls': 'ac-panel', onclick: () => select(x.id) },
            icon(x.icon),
            A(`tab_${x.id}`),
            x.id === 'missions' && ready ? h('span', { class: 'badge accent' }, String(ready)) : null,
          ),
        ),
      );
    }

    function drawBody() {
      if (st.tab === 'list') mount(body, listPanel());
      else mount(body, missionsPanel());
    }

    function select(id) {
      st.tab = TABS.some((x) => x.id === id) ? id : 'list';
      if (location.hash !== `#/achievements/${st.tab}`) history.replaceState(null, '', `#/achievements/${st.tab}`);
      drawTabs();
      drawBody();
    }

    drawSummary();
    drawTabs();
    drawBody();
    offs.push(onAchievements(() => {
      if (disposed) return;
      drawSummary();
      drawList();
    }));
    offs.push(onMissions(() => {
      if (disposed) return;
      drawTabs();
      if (st.tab === 'missions') drawBody();
    }));
    loadAchievements({ force: true }).catch(() => {});
    loadMissions({ force: true }).catch(() => {});
    checkAchievements({ force: true });

    return () => {
      disposed = true;
      offs.splice(0).forEach((off) => off());
    };
  },
};
