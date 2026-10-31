// Detalle de un mundo: tiempo registrado por el launcher, estadisticas del juego y logros.
import { h, icon, mount, modal, fmtDuration, fmtAgo, fail, hideTip } from '../../ui.js';
import { t } from '../../i18n.js';
import { api, store } from '../../store.js';
import { launchInstance } from '../../app.js';
import { columnChart } from './charts.js';
import { fmtInt, fmtCompact, fmtDistance, fmtPct, keyDate, fmtLongDay } from './format.js';
import { gameModeBadge, errorBox, skeletonBox, bone } from './parts.js';

function mini(label, value, sub, ic) {
  return h(
    'div',
    { class: 'st-mini' },
    h('div', { class: 'st-mini-label', title: label }, icon(ic), label),
    h('div', { class: 'st-mini-value num', title: value }, value),
    sub ? h('div', { class: 'tiny muted ellipsis', title: sub }, sub) : null,
  );
}

// Forma del detalle mientras se lee el mundo
function worldSkeleton() {
  const tile = () => h('div', { class: 'st-mini' }, bone('skeleton-line st-skel-label'), bone('skeleton-line title st-skel-value'));
  return skeletonBox(
    t('stats.worldLoading'),
    h('div', { class: 'st-world-head' }, bone('skeleton-icon st-skel-badge'), h('div', { class: 'spacer st-skel-lines' }, bone('skeleton-line title'), bone('skeleton-line st-skel-sub'))),
    h('div', { class: 'st-minis' }, Array.from({ length: 6 }, tile)),
    bone('skeleton-block', { height: '150px' }),
  );
}

function topList(title, list, empty) {
  return h(
    'div',
    { class: 'st-world-top' },
    h('div', { class: 'label' }, title),
    list.length
      ? h(
          'ol',
          { class: 'st-toplist' },
          list.slice(0, 5).map((x) => h('li', {}, h('span', { class: 'ellipsis', title: x.id }, x.name), h('strong', {}, fmtInt(x.count)))),
        )
      : h('div', { class: 'small muted' }, empty),
  );
}

async function openMap(instanceId, folder) {
  try {
    const m = await import('../../features/worldmap.js');
    m.openWorldMap(instanceId, folder);
  } catch (err) {
    fail(t('stats.mapFailed'), err);
  }
}

function content(w, close, cleanups) {
  const ig = w.ingame;
  const adv = w.advancements;
  const running = Boolean(store.running[w.instanceId]);
  const actions = h(
    'div',
    { class: 'st-world-actions' },
    w.world.exists && w.instanceExists
      ? h(
          'button',
          {
            class: 'btn primary sm',
            type: 'button',
            disabled: running,
            title: running ? t('stats.alreadyRunning') : null,
            onclick: () => {
              close();
              launchInstance(w.instanceId, { quickPlay: { world: w.folder } });
            },
          },
          icon('play'),
          t('stats.playWorld'),
        )
      : null,
    w.world.exists ? h('button', { class: 'btn sm', type: 'button', onclick: () => openMap(w.instanceId, w.folder) }, icon('map'), t('stats.viewMap')) : null,
    w.world.exists
      ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => api.instances.openFolder(w.instanceId, `saves/${w.folder}`).catch((err) => fail(t('stats.openFolderFailed'), err)) }, icon('folder'), t('stats.openFolder'))
      : null,
  );
  const header = h(
    'div',
    { class: 'st-world-head' },
    h('div', { class: 'st-world-badge' }, icon('globe')),
    h(
      'div',
      { class: 'spacer st-world-headtext' },
      h('div', { class: 'st-world-title ellipsis', title: w.world.name }, w.world.name),
      h(
        'div',
        { class: 'row wrap st-world-meta' },
        h('span', { class: 'small muted' }, t('stats.worldCellSub', { instance: w.instanceName, version: w.mcVersion || w.world.version || '?' })),
        gameModeBadge(w.world.gameMode, w.world.hardcore),
        w.launcher.live ? h('span', { class: 'pill good st-live' }, h('i', { class: 'st-live-dot' }), t('stats.live')) : null,
      ),
    ),
    actions,
  );
  const notices = [];
  if (!w.world.exists) notices.push(h('div', { class: 'notice info' }, icon('info'), t('stats.worldGoneNote')));
  else if (ig && !w.world.hasStats) notices.push(h('div', { class: 'notice info' }, icon('info'), t('stats.worldNoStats')));
  const minis = h(
    'div',
    { class: 'st-minis' },
    mini(t('stats.wLauncherTime'), fmtDuration(w.launcher.ms), w.launcher.visits ? t('stats.wVisits', { count: w.launcher.visits }) : t('stats.wNotTracked'), 'clock'),
    ig ? mini(t('stats.igPlayTime'), fmtDuration(ig.playTimeMs), w.world.lastPlayed ? t('stats.wLastPlayed', { ago: fmtAgo(w.world.lastPlayed) }) : null, 'gamepad') : null,
    ig ? mini(t('stats.igDeaths'), fmtInt(ig.deaths), null, 'skull') : null,
    ig ? mini(t('stats.igMobs'), fmtCompact(ig.mobKills), null, 'swords') : null,
    ig ? mini(t('stats.igMined'), fmtCompact(ig.blocksMined), null, 'pickaxe') : null,
    ig ? mini(t('stats.igDistance'), fmtDistance(ig.distanceCm), null, 'compass') : null,
  );
  // Actividad de los ultimos 30 dias (lo que registro el launcher)
  const chartHost = h('div', { class: 'st-chart' });
  const days = w.launcher.days.map((d) => ({ label: String(keyDate(d.day).getDate()), tip: fmtLongDay(d.day), value: d.ms / 60000, ms: d.ms }));
  const hasDays = days.some((d) => d.ms > 0);
  if (hasDays) cleanups.push(columnChart(chartHost, days, { height: 150, labelEvery: 5, tipValue: (d) => fmtDuration(d.ms), aria: t('stats.wActivityTitle') }));
  const activity = h(
    'div',
    { class: 'st-world-block' },
    h('div', { class: 'label' }, t('stats.wActivityTitle')),
    hasDays ? chartHost : h('div', { class: 'chart-empty st-chart-empty-sm' }, t('stats.wNoRecent')),
  );
  const tops = ig
    ? h('div', { class: 'st-world-tops' }, topList(t('stats.rank_mined'), ig.top.mined, t('stats.igRankEmpty')), topList(t('stats.rank_killed'), ig.top.killed, t('stats.igRankEmpty')), topList(t('stats.rank_killedBy'), ig.top.killedBy, t('stats.igRankEmpty')))
    : null;
  let advBlock = null;
  if (adv) {
    const pct = adv.total ? adv.done / adv.total : 0;
    advBlock = h(
      'div',
      { class: 'st-world-block' },
      h('div', { class: 'row between' }, h('div', { class: 'label' }, t('stats.advTitle')), h('span', { class: 'small muted' }, adv.total ? t('stats.advOfPct', { done: adv.done, total: adv.total, pct: fmtPct(pct) }) : t('stats.advDoneCount', { count: adv.done }))),
      adv.total ? h('div', { class: 'progress' }, h('i', { style: { width: `${Math.round(pct * 100)}%` } })) : null,
      adv.recent.length
        ? h(
            'div',
            { class: 'st-world-advs' },
            adv.recent.slice(0, 6).map((a) => h('span', { class: ['badge', a.frame === 'challenge' ? 'warn' : 'accent'], title: a.desc || '' }, icon(a.frame === 'challenge' ? 'crown' : 'check'), a.title)),
          )
        : null,
      adv.legacy ? h('div', { class: 'tiny muted' }, t('stats.advLegacy', { done: adv.legacy.done, total: adv.legacy.total })) : null,
    );
  }
  return [header, ...notices, minis, activity, tops, advBlock];
}

// Abre el detalle (tambien accesible con la ruta #/stats/world/<instancia>/<carpeta>).
// Devuelve { close } para que la pagina lo cierre al salir.
export function openWorldStats(instanceId, folder, onClosed) {
  const body = h('div', { class: 'st-world' }, worldSkeleton());
  const cleanups = [];
  let closed = false;
  const m = modal({
    title: t('stats.worldTitle'),
    size: 'wide',
    body,
    onClose: () => {
      closed = true;
      cleanups.forEach((c) => c());
      hideTip();
      onClosed?.();
    },
  });
  m.el.classList.add('st-world-modal');
  const load = async () => {
    mount(body, worldSkeleton());
    try {
      const w = await api.invoke('stats:world', instanceId, folder);
      if (!body.isConnected) return;
      mount(body, content(w, m.close, cleanups));
    } catch (err) {
      if (body.isConnected) mount(body, errorBox(err, load));
    }
  };
  load();
  return {
    close: () => {
      if (!closed) m.close();
    },
  };
}

