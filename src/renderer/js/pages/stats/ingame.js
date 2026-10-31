// Pestana "En el juego": estadisticas que guarda Minecraft en cada mundo (saves/<mundo>/stats),
// sumadas para todas las instancias o filtradas por instancia y mundo.
import { h, icon, mount, fmtDuration, fmtAgo, emptyState } from '../../ui.js';
import { t } from '../../i18n.js';
import { navigate } from '../../app.js';
import { barChart } from './charts.js';
import { fmtInt, fmtCompact, fmtDistance, fmtHearts, fmtTicks, labelOr } from './format.js';
import { card, segmented, kpi, errorBox, scopeBar, gameModeBadge, panelSkeleton } from './parts.js';

const RANKINGS = ['mined', 'killed', 'killedBy', 'crafted', 'used'];

function kpis(tt, data) {
  return h(
    'div',
    { class: 'st-ig-kpis' },
    kpi({ icon: 'clock', label: t('stats.igPlayTime'), value: fmtDuration(tt.playTimeMs), foot: t('stats.igWorldsFoot', { count: data.worldsCount }) }),
    kpi({ icon: 'pickaxe', label: t('stats.igMined'), value: fmtCompact(tt.blocksMined), title: fmtInt(tt.blocksMined), foot: t('stats.igKinds', { count: tt.kinds.mined }) }),
    kpi({
      icon: 'swords',
      label: t('stats.igMobs'),
      value: fmtCompact(tt.mobKills),
      title: fmtInt(tt.mobKills),
      foot: tt.playerKills ? t('stats.igPlayerKills', { count: tt.playerKills }) : t('stats.igKinds', { count: tt.kinds.killed }),
    }),
    kpi({ icon: 'skull', label: t('stats.igDeaths'), value: fmtInt(tt.deaths), foot: tt.deaths && tt.playTimeMs ? t('stats.igDeathEvery', { time: fmtDuration(tt.playTimeMs / tt.deaths) }) : t('stats.igNoDeaths') }),
    kpi({ icon: 'compass', label: t('stats.igDistance'), value: fmtDistance(tt.distanceCm), foot: t('stats.igWalked', { value: fmtDistance(tt.walkCm) }) }),
    kpi({ icon: 'upCircle', label: t('stats.igJumps'), value: fmtCompact(tt.jumps), title: fmtInt(tt.jumps), foot: t('stats.igJumpsFoot') }),
    kpi({ icon: 'zap', label: t('stats.igDamage'), value: fmtHearts(tt.damageDealt), foot: t('stats.igDamageTaken', { value: fmtHearts(tt.damageTaken) }) }),
    kpi({ icon: 'hammer', label: t('stats.igCrafted'), value: fmtCompact(tt.itemsCrafted), title: fmtInt(tt.itemsCrafted), foot: t('stats.igKinds', { count: tt.kinds.crafted }) }),
  );
}

function distanceCard(tt, cleanups) {
  const host = h('div', { class: 'st-chart' });
  const data = tt.distance.slice(0, 9).map((d) => ({ label: labelOr(`stats.dist_${d.id}`, d.name), value: d.cm }));
  if (data.length) cleanups.push(barChart(host, data, { format: fmtDistance, aria: t('stats.igDistanceTitle') }));
  return card(
    { icon: 'map', title: t('stats.igDistanceTitle'), sub: t('stats.igDistanceSub', { value: fmtDistance(tt.distanceCm) }) },
    data.length ? host : h('div', { class: 'chart-empty' }, t('stats.noDataYet')),
  );
}

function rankingCard(tt, cleanups) {
  let kind = 'mined';
  const host = h('div', { class: 'st-chart st-rank-host' });
  let off = null;
  const draw = () => {
    off?.();
    off = null;
    const list = tt.top[kind] || [];
    if (!list.length) {
      mount(host, h('div', { class: 'chart-empty' }, t('stats.igRankEmpty')));
      return;
    }
    off = barChart(
      host,
      list.map((x) => ({ label: x.name, value: x.count, tip: t('stats.igRankTip', { count: x.count, value: fmtInt(x.count), id: x.id }) })),
      { format: fmtInt, aria: t(`stats.rank_${kind}`) },
    );
  };
  draw();
  cleanups.push(() => off?.());
  const seg = segmented(
    RANKINGS.map((id) => ({ id, label: t(`stats.rank_${id}`) })),
    kind,
    (v) => {
      kind = v;
      draw();
    },
    t('stats.igRankTitle'),
  );
  return card({ icon: 'trophy', title: t('stats.igRankTitle'), sub: t('stats.igRankSub'), cls: 'st-rank-card' }, h('div', { class: 'st-rank-tabs' }, seg), host);
}

function extraValue(x) {
  if (x.unit === 'ticks') return fmtTicks(x.value);
  if (x.unit === 'damage') return fmtHearts(x.value / 20);
  return fmtInt(x.value);
}

function moreCard(tt) {
  const items = tt.extras.map((x) => [labelOr(`stats.x_${x.id}`, x.name), extraValue(x)]);
  if (tt.totems) items.push([t('stats.x_totems'), fmtInt(tt.totems)]);
  items.push([t('stats.x_items_used'), fmtInt(tt.itemsUsed)], [t('stats.x_items_broken'), fmtInt(tt.itemsBroken)], [t('stats.x_items_picked'), fmtInt(tt.itemsPickedUp)]);
  const bosses = tt.bosses.length
    ? h(
        'div',
        { class: 'st-bosses' },
        h('div', { class: 'label' }, t('stats.igBosses')),
        h(
          'div',
          { class: 'chips' },
          tt.bosses.map((b) => h('span', { class: 'badge accent st-boss' }, icon('crown'), t('stats.bossChip', { name: b.name, count: fmtInt(b.count) }))),
        ),
      )
    : null;
  return card(
    { icon: 'sparkles', title: t('stats.igMoreTitle'), sub: t('stats.igMoreSub') },
    bosses,
    h(
      'dl',
      { class: 'st-dl' },
      items.map(([k, v]) => h('div', { class: 'st-dl-item' }, h('dt', { title: k }, k), h('dd', {}, v))),
    ),
  );
}

function worldsCard(data, ctx) {
  const rows = data.worlds;
  const head = h(
    'tr',
    {},
    h('th', {}, t('stats.colWorld')),
    h('th', { class: 'num' }, t('stats.colGameTime')),
    h('th', { class: 'num' }, t('stats.colDeaths')),
    h('th', { class: 'num st-col-opt' }, t('stats.colMobs')),
    h('th', { class: 'num st-col-opt' }, t('stats.colBlocks')),
    h('th', { class: 'num' }, t('stats.colAdvancements')),
    h('th', { class: 'num st-col-opt2' }, t('stats.colLastPlayed')),
  );
  const body = rows.map((w) => {
    const open = () => ctx.openWorld(w.instanceId, w.folder);
    return h(
      'tr',
      {
        class: 'st-row-link',
        tabindex: '0',
        title: t('stats.openWorldHint'),
        onclick: open,
        onkeydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            open();
          }
        },
      },
      h(
        'td',
        {},
        h('div', { class: 'st-world-cell' }, h('div', { class: 'st-world-name ellipsis' }, w.name, gameModeBadge(w.gameMode, w.hardcore)), h('div', { class: 'tiny muted ellipsis' }, t('stats.worldCellSub', { instance: w.instanceName, version: w.mcVersion || '?' }))),
      ),
      h('td', { class: 'num' }, w.hasStats ? fmtDuration(w.playTimeMs) : h('span', { class: 'muted' }, t('stats.noStatsShort'))),
      h('td', { class: 'num' }, fmtInt(w.deaths)),
      h('td', { class: 'num st-col-opt' }, fmtCompact(w.mobKills)),
      h('td', { class: 'num st-col-opt' }, fmtCompact(w.blocksMined)),
      h('td', { class: 'num' }, w.advTotal ? t('stats.advOf', { done: w.advDone, total: w.advTotal }) : fmtInt(w.advDone)),
      h('td', { class: 'num st-col-opt2' }, w.lastPlayed ? fmtAgo(w.lastPlayed) : '—'),
    );
  });
  return card(
    { icon: 'globe', title: t('stats.igWorldsTitle'), sub: t('stats.igWorldsSub', { count: rows.length }) },
    h('div', { class: 'st-table-scroll' }, h('table', { class: 'table st-table st-worlds-table' }, h('thead', {}, head), h('tbody', {}, body))),
  );
}

export function render(panel, ctx) {
  const st = ctx.state;
  const cleanups = [];
  if (!st.ingame && !st.ingameError) {
    mount(panel, panelSkeleton(t('stats.igLoading'), { filter: true, kpis: 8 }));
    ctx.loadIngame();
    return null;
  }
  if (!st.ingame) {
    mount(panel, errorBox(st.ingameError, () => ctx.loadIngame(st.scope, { force: true })));
    return null;
  }
  const data = st.ingame;
  const parts = [];
  if (!data.options.length) {
    parts.push(
      h(
        'section',
        { class: 'card st-card st-empty-card' },
        emptyState('layers', t('stats.igNoInstances'), t('stats.igNoInstancesText'), h('button', { class: 'btn primary', type: 'button', onclick: () => navigate('versions/new') }, icon('plus'), t('stats.createInstance'))),
      ),
    );
  } else if (!data.options.some((o) => o.worlds.length)) {
    parts.push(h('section', { class: 'card st-card st-empty-card' }, emptyState('globe', t('stats.igNoWorlds'), t('stats.igNoWorldsText'), h('button', { class: 'btn primary', type: 'button', onclick: () => navigate('home') }, icon('play'), t('stats.emptyAction')))));
  } else {
    parts.push(scopeBar(ctx));
    if (st.ingameError) parts.push(errorBox(st.ingameError, () => ctx.loadIngame(st.scope, { force: true })));
    if (!data.worldsCount) parts.push(h('div', { class: 'notice info' }, icon('info'), t('stats.igScopeEmpty')));
    else {
      if (data.withStats < data.worldsCount) parts.push(h('div', { class: 'notice info' }, icon('info'), t('stats.igSomeNoStats', { count: data.worldsCount - data.withStats })));
      const tt = data.totals;
      parts.push(kpis(tt, data));
      parts.push(h('div', { class: 'st-grid st-grid-2' }, rankingCard(tt, cleanups), distanceCard(tt, cleanups)));
      parts.push(moreCard(tt));
      parts.push(worldsCard(data, ctx));
      if (!data.namesFromGame) parts.push(h('div', { class: 'small muted st-footnote' }, icon('info'), h('span', {}, t('stats.igNamesNote'))));
    }
  }
  mount(panel, h('div', { class: ['st-stack', st.ingameLoading && 'st-busy'] }, parts));
  return () => cleanups.forEach((c) => c());
}
