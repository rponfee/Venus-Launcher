// Estadisticas de un mundo: las del modulo de estadisticas (stats:world) si esta disponible; si no, una
// lectura propia rapida de stats/*.json y advancements/*.json (worlds:stats).
import { h, icon, mount, emptyState, fmtAgo, fmtDate, showTip, hideTip } from '../../ui.js';
import { api } from '../../store.js';
import { t } from '../../i18n.js';
import { shortDur, fmtInt, fmtCompact, fmtDistance, prettyId, categoryLabel, isMissingHandler, errorBox, bone, skelGroup } from './common.js';
import { advItem } from './timeline.js';

const CAT_ICON = { story: 'pickaxe', nether: 'flame', end: 'moon', adventure: 'compass', husbandry: 'woSprout', mods: 'puzzle' };

function named(list) {
  return (list || []).map((x) => ({ id: x.id, name: x.name || prettyId(x.id), count: Number(x.count) || 0 }));
}

function normalize(raw, source) {
  const ig = raw?.ingame || null;
  const ad = raw?.advancements || null;
  return {
    source,
    ingame: ig
      ? {
          playTimeMs: ig.playTimeMs || 0,
          deaths: ig.deaths || 0,
          mobKills: ig.mobKills || 0,
          playerKills: ig.playerKills || 0,
          jumps: ig.jumps || 0,
          blocksMined: ig.blocksMined || 0,
          itemsCrafted: ig.itemsCrafted || 0,
          distanceCm: ig.distanceCm || 0,
          damageDealt: ig.damageDealt || 0,
          damageTaken: ig.damageTaken || 0,
          top: { mined: named(ig.top?.mined), killed: named(ig.top?.killed), killedBy: named(ig.top?.killedBy) },
          bosses: named(ig.bosses),
        }
      : null,
    advancements: ad
      ? {
          done: ad.done || 0,
          total: ad.total || null,
          modsDone: ad.modsDone || 0,
          categories: (ad.categories || []).filter((c) => c && c.id),
          recent: (ad.recent || []).filter((a) => a && a.at).slice(0, 8),
        }
      : null,
    launcher: raw?.launcher && Array.isArray(raw.launcher.days) ? raw.launcher : null,
  };
}

export async function loadStats(w) {
  try {
    return normalize(await api.invoke('stats:world', w.instanceId, w.folder), 'stats');
  } catch (err) {
    if (!isMissingHandler(err)) console.warn('[worlds] stats:world', err);
    return normalize(await api.invoke('worlds:stats', w.instanceId, w.folder), 'own');
  }
}

// Un mundo sin nada jugado devuelve todo en cero: es lo mismo que no tener estadisticas
function emptyIngame(ig) {
  return !ig || !(ig.playTimeMs || ig.blocksMined || ig.mobKills || ig.jumps || ig.distanceCm || ig.itemsCrafted || ig.deaths);
}

function tile(ic, label, value, foot) {
  return h('div', { class: 'wo-stat' }, h('div', { class: 'wo-stat-label' }, icon(ic), label), h('div', { class: 'wo-stat-value', title: typeof value === 'string' ? value : null }, value), foot ? h('div', { class: 'wo-stat-foot', title: foot }, foot) : null);
}

function bars(list, emptyText) {
  if (!list.length) return h('p', { class: 'small muted wo-none' }, emptyText);
  const max = Math.max(...list.map((x) => x.count), 1);
  return h(
    'ol',
    { class: 'wo-bars' },
    list.slice(0, 6).map((x) =>
      h(
        'li',
        { class: 'wo-bar' },
        h('span', { class: 'wo-bar-name', title: x.id }, x.name),
        h('span', { class: 'wo-bar-track', 'aria-hidden': 'true' }, h('i', { style: { width: `${Math.max(3, (x.count / max) * 100)}%` } })),
        h('span', { class: 'wo-bar-val' }, fmtCompact(x.count)),
      ),
    ),
  );
}

function advCard(ad) {
  const pct = ad.total ? Math.min(100, Math.round((ad.done / ad.total) * 100)) : null;
  return h(
    'section',
    { class: 'card wo-card-pad' },
    h('div', { class: 'card-head' }, h('h3', { class: 'card-title' }, icon('trophy'), t('worlds.advTitle')), pct !== null ? h('span', { class: 'badge accent' }, t('worlds.percent', { value: pct })) : null),
    h(
      'div',
      { class: 'wo-adv-total' },
      h('span', { class: 'wo-adv-big' }, fmtInt(ad.done)),
      h('span', { class: 'muted' }, ad.total ? t('worlds.advOf', { total: fmtInt(ad.total) }) : t('worlds.advDoneLabel')),
    ),
    pct !== null ? h('div', { class: 'progress wo-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': t('worlds.advTitle') }, h('i', { style: { width: `${pct}%` } })) : null,
    ad.categories.length
      ? h(
          'ul',
          { class: 'wo-cats' },
          ad.categories.map((c) => {
            const cp = c.total ? Math.min(100, Math.round((c.done / c.total) * 100)) : null;
            return h(
              'li',
              { class: ['wo-catrow', `wo-cat-${c.id}`] },
              h('span', { class: 'wo-cat-icon', 'aria-hidden': 'true' }, icon(CAT_ICON[c.id] || 'star')),
              h('span', { class: 'wo-cat-name' }, categoryLabel(c.id)),
              h('span', { class: 'wo-cat-track', 'aria-hidden': 'true' }, cp !== null ? h('i', { style: { width: `${cp}%` } }) : null),
              h('span', { class: 'wo-cat-val' }, c.total ? `${c.done}/${c.total}` : String(c.done)),
            );
          }),
        )
      : null,
    ad.modsDone ? h('p', { class: 'small muted wo-none' }, icon('puzzle'), h('span', {}, t('worlds.modAdvancements', { count: ad.modsDone }))) : null,
  );
}

function recentCard(ad) {
  if (!ad.recent.length) return null;
  return h(
    'section',
    { class: 'card wo-card-pad' },
    h('h3', { class: 'card-title' }, icon('sparkles'), t('worlds.recentAdvancements')),
    h(
      'ul',
      { class: 'wo-advs wo-advs-plain' },
      ad.recent.map((a) => advItem({ ...a, title: a.title || prettyId(a.id) }, fmtAgo(a.at))),
    ),
  );
}

function launcherCard(l) {
  const days = l.days.slice(-30);
  if (!days.some((d) => d.ms > 0)) return null;
  const max = Math.max(...days.map((d) => d.ms), 1);
  const chart = h(
    'div',
    { class: 'wo-spark', role: 'img', 'aria-label': t('worlds.launcherChartLabel', { time: shortDur(l.ms) }) },
    days.map((d) => {
      const bar = h('span', { class: ['wo-spark-bar', d.ms > 0 && 'on'], style: { height: `${d.ms > 0 ? Math.max(8, (d.ms / max) * 100) : 4}%` } });
      bar.addEventListener('mouseenter', (e) => showTip(e.clientX, e.clientY, fmtDate(new Date(`${d.day}T12:00:00`).getTime()), d.ms ? shortDur(d.ms) : t('worlds.durNone')));
      bar.addEventListener('mouseleave', hideTip);
      return bar;
    }),
  );
  return h(
    'section',
    { class: 'card wo-card-pad' },
    h('div', { class: 'card-head' }, h('h3', { class: 'card-title' }, icon('activity'), t('worlds.launcherTime')), h('span', { class: 'small muted' }, t('worlds.last30'))),
    chart,
    h('p', { class: 'small muted wo-none' }, t('worlds.launcherTimeFoot', { time: shortDur(l.ms), count: l.visits || 0 })),
  );
}

// Forma de la pestana mientras se leen los archivos del mundo
export function statsSkeleton() {
  return skelGroup(t('worlds.loadingStats'), h('div', { class: 'wo-skel-stats' }, bone(), bone()), h('div', { class: 'wo-skel-stats' }, bone(), bone()));
}

/**
 * opts: { isAlive(), fallbackAdvancements() -> logros de la linea de tiempo, emptyAction() -> boton del estado vacio }
 */
export async function statsView(container, w, { isAlive = () => true, fallbackAdvancements = () => null, emptyAction = null } = {}) {
  mount(container, statsSkeleton());
  let data;
  try {
    data = await loadStats(w);
  } catch (err) {
    if (isAlive()) mount(container, errorBox(err, () => statsView(container, w, { isAlive, fallbackAdvancements, emptyAction })));
    return;
  }
  if (!isAlive()) return;
  // Sin definiciones de logros para esa version: se completan los totales con la tabla propia
  const own = fallbackAdvancements();
  if (own && own.total && (!data.advancements || !data.advancements.total)) {
    const recent = data.advancements?.recent?.length ? data.advancements.recent : (own.recent || []).slice(0, 8);
    data.advancements = { done: own.done, total: own.total, modsDone: own.modsDone || 0, categories: own.categories || [], recent };
  }
  // Los titulos de la linea de tiempo vienen traducidos: ganan a los del modulo de estadisticas (mismos ids)
  if (own?.recent?.length && data.advancements?.recent?.length) {
    const byId = new Map(own.recent.map((a) => [a.id, a]));
    data.advancements.recent = data.advancements.recent.map((a) => {
      const mine = byId.get(a.id);
      return mine ? { ...a, title: mine.title || a.title, category: a.category || mine.category, frame: a.frame || mine.frame } : a;
    });
  }
  const ig = emptyIngame(data.ingame) ? null : data.ingame;
  const ad = data.advancements && (data.advancements.done || data.advancements.total) ? data.advancements : null;
  const launcher = data.launcher ? launcherCard(data.launcher) : null;
  // Nada jugado todavia (ni estadisticas, ni logros conseguidos, ni tiempo en el launcher): estado vacio
  if (!ig && !(ad && (ad.done || ad.modsDone)) && !launcher) {
    mount(container, h('div', { class: 'card flat' }, emptyState('chart', t('worlds.noStats'), t('worlds.noStatsText'), typeof emptyAction === 'function' ? emptyAction() : null)));
    return;
  }
  const parts = [];
  if (ig) {
    parts.push(
      h(
        'section',
        { class: 'card wo-card-pad' },
        h('h3', { class: 'card-title' }, icon('pickaxe'), t('worlds.ingameTitle')),
        h(
          'div',
          { class: 'wo-stats' },
          tile('woHourglass', t('worlds.statPlaytime'), shortDur(ig.playTimeMs)),
          tile('skull', t('worlds.statDeaths'), fmtInt(ig.deaths)),
          tile('swords', t('worlds.statMobKills'), fmtCompact(ig.mobKills), ig.playerKills ? t('worlds.statPlayerKills', { count: ig.playerKills }) : null),
          tile('pickaxe', t('worlds.statMined'), fmtCompact(ig.blocksMined)),
          tile('woFootprints', t('worlds.statDistance'), fmtDistance(ig.distanceCm)),
          tile('upCircle', t('worlds.statJumps'), fmtCompact(ig.jumps)),
          tile('heart', t('worlds.statDamage'), t('worlds.hearts', { value: fmtCompact(Math.round(ig.damageDealt)) }), t('worlds.statDamageTaken', { value: fmtCompact(Math.round(ig.damageTaken)) })),
          tile('hammer', t('worlds.statCrafted'), fmtCompact(ig.itemsCrafted)),
        ),
      ),
    );
  }
  const side = [];
  if (ad) side.push(advCard(ad));
  if (launcher) side.push(launcher);
  const lists = ig
    ? h(
        'div',
        { class: 'grid cols-2 wo-cols' },
        h('section', { class: 'card wo-card-pad' }, h('h3', { class: 'card-title' }, icon('pickaxe'), t('worlds.topMined')), bars(ig.top.mined, t('worlds.nothingYet'))),
        h(
          'section',
          { class: 'card wo-card-pad' },
          h('h3', { class: 'card-title' }, icon('swords'), t('worlds.topKilled')),
          bars(ig.top.killed, t('worlds.nothingYet')),
          ig.top.killedBy.length ? h('h4', { class: 'wo-subhead' }, icon('skull'), t('worlds.killedBy')) : null,
          ig.top.killedBy.length ? bars(ig.top.killedBy.slice(0, 3), '') : null,
        ),
      )
    : null;
  mount(
    container,
    h(
      'div',
      { class: 'stack wo-stats-wrap' },
      h('div', { class: ['wo-stats-top', (!parts.length || !side.length) && 'single'] }, parts, side.length ? h('div', { class: 'stack wo-stats-wrap' }, side) : null),
      lists,
      ad ? recentCard(ad) : null,
      h('p', { class: 'wo-note wo-source' }, icon('info'), h('span', {}, data.source === 'stats' ? t('worlds.sourceStats') : t('worlds.sourceOwn'))),
    ),
  );
}
