// Pestana "Mundos y servidores": tiempo que el launcher registro en cada mundo y en cada servidor.
import { h, icon, mount, fmtDuration, fmtDate, fmtAgo, emptyState, fail } from '../../ui.js';
import { t } from '../../i18n.js';
import { store } from '../../store.js';
import { launchInstance } from '../../app.js';
import { barChart, splitBar } from './charts.js';
import { fmtPct } from './format.js';
import { card, errorBox, panelSkeleton } from './parts.js';

const LIST_STEP = 8;

async function joinServer(address, instanceId) {
  try {
    const m = await import('../../features/serverlist.js');
    await m.joinServer(address, { instanceId });
  } catch (err) {
    // Sin el modulo multijugador: entrar directo con la ultima instancia usada en ese servidor
    if (!instanceId) {
      fail(t('stats.joinFailed'), err);
      return;
    }
    const [host, port] = address.split(':');
    launchInstance(instanceId, { quickPlay: { server: host, port: Number(port) || 25565 } });
  }
}

function splitCard(p) {
  const tt = p.totals;
  const total = tt.worldMs + tt.serverMs + tt.otherMs;
  const parts = [
    { value: tt.worldMs, cls: 'st-seg-world', key: 'plSingle' },
    { value: tt.serverMs, cls: 'st-seg-server', key: 'plServers' },
    { value: tt.otherMs, cls: 'st-seg-other', key: 'plOther' },
  ];
  const label = (x) => t('stats.plSplitItem', { label: t(`stats.${x.key}`), time: fmtDuration(x.value), pct: fmtPct(total ? x.value / total : 0) });
  return card(
    { icon: 'activity', title: t('stats.plSplitTitle'), sub: p.since ? t('stats.plSince', { date: fmtDate(p.since) }) : null },
    splitBar(
      parts.map((x) => ({ ...x, label: label(x) })),
      parts.map(label).join(' · '),
    ),
    h(
      'div',
      { class: 'legend st-split-legend' },
      parts.map((x) => h('span', { class: 'lg-item' }, h('span', { class: `sw ${x.cls}` }), h('span', {}, t(`stats.${x.key}`)), h('strong', {}, fmtDuration(x.value)), h('span', { class: 'muted' }, fmtPct(total ? x.value / total : 0)))),
    ),
  );
}

function topCard({ icon: ic, title, sub, data, onSelect, empty }, cleanups) {
  const host = h('div', { class: 'st-chart' });
  if (data.length) cleanups.push(barChart(host, data, { format: (v) => fmtDuration(v, { short: v > 36e5 * 10 }), aria: title, onSelect }));
  return card({ icon: ic, title, sub }, data.length ? host : h('div', { class: 'chart-empty' }, empty));
}

function worldRow(w, ctx) {
  const running = Boolean(store.running[w.instanceId]);
  const canPlay = w.instanceExists && w.exists && w.folder;
  return h(
    'div',
    { class: ['list-item', 'st-place', !w.exists && 'st-gone'] },
    h('div', { class: 'li-icon st-place-icon' }, icon('globe')),
    h(
      'div',
      { class: 'li-main' },
      h(
        'div',
        { class: 'li-title st-place-title' },
        h('span', { class: 'ellipsis' }, w.name || t('stats.unknownWorld')),
        w.live ? h('span', { class: 'pill good st-live' }, h('i', { class: 'st-live-dot' }), t('stats.live')) : null,
        !w.exists ? h('span', { class: 'badge' }, t('stats.worldGone')) : null,
      ),
      h('div', { class: 'li-sub' }, t('stats.plWorldSub', { instance: w.instanceName, count: w.visits, ago: fmtAgo(w.last) })),
    ),
    h('div', { class: 'st-place-time' }, h('strong', {}, fmtDuration(w.ms)), w.playTimeMs ? h('div', { class: 'tiny muted' }, t('stats.plGameTime', { time: fmtDuration(w.playTimeMs) })) : null),
    h(
      'div',
      { class: 'st-place-actions' },
      w.folder
        ? h('button', { class: 'icon-btn sm', type: 'button', title: t('stats.viewWorldStats'), 'aria-label': t('stats.viewWorldStats'), onclick: () => ctx.openWorld(w.instanceId, w.folder) }, icon('chart'))
        : null,
      canPlay
        ? h(
            'button',
            {
              class: 'icon-btn sm',
              type: 'button',
              disabled: running,
              title: running ? t('stats.alreadyRunning') : t('stats.playWorld'),
              'aria-label': t('stats.playWorld'),
              onclick: () => launchInstance(w.instanceId, { quickPlay: { world: w.folder } }),
            },
            icon('play'),
          )
        : null,
    ),
  );
}

function serverRow(s) {
  const inst = s.instances.find((i) => i.exists) || null;
  return h(
    'div',
    { class: 'list-item st-place' },
    h('div', { class: 'li-icon st-place-icon' }, icon('server')),
    h(
      'div',
      { class: 'li-main' },
      h('div', { class: 'li-title st-place-title' }, h('span', { class: 'ellipsis selectable' }, s.address), s.live ? h('span', { class: 'pill good st-live' }, h('i', { class: 'st-live-dot' }), t('stats.live')) : null),
      h('div', { class: 'li-sub' }, t('stats.plServerSub', { count: s.visits, ago: fmtAgo(s.last), instances: s.instances.map((i) => i.name).join(', ') })),
    ),
    h('div', { class: 'st-place-time' }, h('strong', {}, fmtDuration(s.ms))),
    h(
      'div',
      { class: 'st-place-actions' },
      h(
        'button',
        { class: 'btn sm tonal', type: 'button', title: t('stats.joinServerHint', { address: s.address }), 'aria-label': t('stats.joinServerHint', { address: s.address }), onclick: () => joinServer(s.address, inst?.id || null) },
        icon('play'),
        t('stats.joinServer'),
      ),
    ),
  );
}

function listCard({ icon: ic, title, sub, items, row }) {
  const box = h('div', { class: 'list st-place-list' });
  const more = h('button', { class: 'btn ghost sm', type: 'button' });
  let shown = LIST_STEP;
  const draw = () => {
    mount(box, items.slice(0, shown).map(row));
    more.classList.toggle('hidden', items.length <= shown);
    mount(more, icon('chevronDown'), t('stats.showMoreCount', { count: Math.min(LIST_STEP, items.length - shown) }));
  };
  more.addEventListener('click', () => {
    shown += LIST_STEP;
    draw();
  });
  draw();
  return card({ icon: ic, title, sub }, box, h('div', { class: 'st-more-row' }, more));
}

export function render(panel, ctx) {
  const st = ctx.state;
  const cleanups = [];
  if (!st.places && !st.placesError) {
    mount(panel, panelSkeleton(t('stats.plLoading'), { cards: 2 }));
    ctx.loadPlaces();
    return null;
  }
  if (!st.places) {
    mount(panel, errorBox(st.placesError, () => ctx.loadPlaces(true)));
    return null;
  }
  const p = st.places;
  if (!p.worlds.length && !p.servers.length) {
    mount(panel, h('div', { class: 'st-stack' }, h('section', { class: 'card st-card st-empty-card' }, emptyState('globe', t('stats.plEmptyTitle'), t('stats.plEmptyText')))));
    return null;
  }
  const worldsTop = p.worlds.slice(0, 8).map((w) => ({
    label: w.name || t('stats.unknownWorld'),
    value: w.ms,
    dim: !w.exists,
    world: w,
    tip: t('stats.plWorldTip', { time: fmtDuration(w.ms), instance: w.instanceName, count: w.visits }),
  }));
  const serversTop = p.servers.slice(0, 8).map((s) => ({ label: s.address, value: s.ms, tip: t('stats.plServerTip', { time: fmtDuration(s.ms), count: s.visits }) }));
  const parts = [
    splitCard(p),
    h(
      'div',
      { class: 'st-grid st-grid-2' },
      topCard(
        {
          icon: 'globe',
          title: t('stats.plTopWorlds'),
          sub: t('stats.plWorldsCount', { count: p.worlds.length }),
          data: worldsTop,
          empty: t('stats.plNoWorlds'),
          onSelect: (d) => d.world.folder && ctx.openWorld(d.world.instanceId, d.world.folder),
        },
        cleanups,
      ),
      topCard({ icon: 'server', title: t('stats.plTopServers'), sub: t('stats.plServersCount', { count: p.servers.length }), data: serversTop, empty: t('stats.plNoServers') }, cleanups),
    ),
  ];
  if (p.worlds.length) parts.push(listCard({ icon: 'globe', title: t('stats.plAllWorlds'), sub: t('stats.plAllWorldsSub'), items: p.worlds, row: (w) => worldRow(w, ctx) }));
  if (p.servers.length) parts.push(listCard({ icon: 'server', title: t('stats.plAllServers'), sub: t('stats.plAllServersSub'), items: p.servers, row: serverRow }));
  parts.push(h('div', { class: 'small muted st-footnote' }, icon('info'), h('span', {}, t('stats.plNote'))));
  mount(panel, h('div', { class: 'st-stack' }, parts));
  return () => cleanups.forEach((c) => c());
}
