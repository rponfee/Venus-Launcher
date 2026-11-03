// Logros (advancements) de Minecraft por mundo. Se mudaron de Estadisticas a la pagina de Logros en la 3.0.
import { h, icon, mount, fmtDate, emptyState } from '../../ui.js';
import { t } from '../../i18n.js';
import { ring } from '../stats/charts.js';
import { fmtInt, fmtPct } from '../stats/format.js';
import { card, errorBox, scopeBar, skeletonBox, bone } from '../stats/parts.js';

// Nota al pie con icono alineado (no queda pegado al texto cuando la linea se corta)
const footnote = (ic, text, cls = '') => h('div', { class: ['tiny', 'muted', 'st-footnote', cls] }, icon(ic), h('span', {}, text));

// Ancho de una barra de progreso: con total, contra el total; sin total (version sin datos del juego),
// contra el mejor valor de la lista, asi las barras siguen comparando algo.
const barPct = (done, total, max) => (total ? (done / total) * 100 : max ? (done / max) * 100 : 0);

const FRAME_ICON = { challenge: 'crown', goal: 'target', task: 'check' };

function advItem(a, { showWorld = false } = {}) {
  return h(
    'div',
    { class: ['st-adv', `f-${a.frame || 'task'}`] },
    h('div', { class: 'st-adv-icon', title: t(`stats.frame_${a.frame || 'task'}`) }, icon(a.hidden && !a.title ? 'lock' : FRAME_ICON[a.frame] || 'check')),
    h(
      'div',
      { class: 'st-adv-main' },
      h('div', { class: 'st-adv-title', title: a.title || null }, a.title || t('stats.advHidden')),
      h('div', { class: 'st-adv-desc', title: a.title ? a.desc || null : null }, a.title ? a.desc || t(`stats.cat_${a.category}`) : t('stats.advHiddenDesc')),
    ),
    a.at
      ? h('div', { class: 'st-adv-meta' }, h('div', { class: 'tiny' }, fmtDate(a.at)), showWorld && a.world ? h('div', { class: 'tiny muted ellipsis', title: a.world }, a.world) : h('div', { class: 'tiny muted' }, fmtAgo(a.at)))
      : a.frame && a.frame !== 'task'
        ? h('span', { class: ['badge', a.frame === 'challenge' ? 'warn' : ''] }, t(`stats.frame_${a.frame}`))
        : null,
  );
}

export function advancementsCard(ctx) {
  const st = ctx.state;
  if (!st.ingame && !st.ingameError) {
    ctx.loadIngame();
    return card(
      { icon: 'target', title: t('stats.advTitle'), sub: t('stats.advSub') },
      skeletonBox(t('stats.igLoading'), bone('skeleton-block st-skel-filter'), h('div', { class: 'st-adv-head' }, bone('skeleton-circle st-skel-ring'), h('div', { class: 'st-adv-cats' }, Array.from({ length: 4 }, () => bone('skeleton-line'))))),
    );
  }
  if (!st.ingame) return card({ icon: 'target', title: t('stats.advTitle'), sub: t('stats.advSub') }, errorBox(st.ingameError, () => ctx.loadIngame(st.scope, { force: true })));
  const data = st.ingame;
  const adv = data.advancements;
  if (!data.worldsCount && !data.options.some((o) => o.worlds.length)) {
    return card({ icon: 'target', title: t('stats.advTitle'), sub: t('stats.advSub') }, emptyState('target', t('stats.igNoWorlds'), t('stats.igNoWorldsText')));
  }
  const single = data.worldsCount === 1;
  const pct = adv.total ? adv.done / adv.total : 0;
  const catMax = Math.max(0, ...adv.categories.map((c) => c.done));
  const head = h(
    'div',
    { class: 'st-adv-head' },
    // Sin total conocido el anillo no mide progreso: se muestra entero y tenue, con la cantidad conseguida
    ring(adv.total ? pct : 1, {
      size: 128,
      stroke: 11,
      cls: adv.total ? '' : 'st-ring-count',
      label: adv.total ? fmtPct(pct) : fmtInt(adv.done),
      sub: adv.total ? t('stats.advOf', { done: adv.done, total: adv.total }) : t('stats.advDoneShort'),
      aria: adv.total ? t('stats.advRingAria', { done: adv.done, total: adv.total }) : t('stats.advDoneCount', { count: adv.done }),
    }),
    h(
      'div',
      { class: 'st-adv-cats' },
      adv.categories.length
        ? adv.categories.map((c) =>
            h(
              'div',
              { class: 'st-adv-cat' },
              h('div', { class: 'row between' }, h('span', { class: 'st-adv-cat-name' }, t(`stats.cat_${c.id}`)), h('span', { class: 'small muted num' }, c.total ? t('stats.advOf', { done: c.done, total: c.total }) : fmtInt(c.done))),
              h('div', { class: 'progress' }, h('i', { style: { width: `${Math.round(barPct(c.done, c.total, catMax))}%` } })),
            ),
          )
        : h('div', { class: 'small muted' }, t('stats.advNone')),
      adv.total === null && adv.done > 0 ? footnote('info', t('stats.advNoTotal')) : null,
      adv.reference && !single ? footnote('info', t('stats.advReference', { version: adv.reference })) : null,
      adv.modsDone ? footnote('puzzle', t('stats.advMods', { count: adv.modsDone })) : null,
      adv.legacy ? footnote('history', t('stats.advLegacy', { done: adv.legacy.done, total: adv.legacy.total })) : null,
    ),
  );
  const recent = adv.recent.length
    ? h('div', { class: 'st-adv-section' }, h('div', { class: 'label' }, t('stats.advRecent')), h('div', { class: 'st-adv-list' }, adv.recent.map((a) => advItem(a, { showWorld: !single }))))
    : h('div', { class: 'small muted st-adv-section' }, t('stats.advNoRecent'));
  let missing = null;
  if (single && adv.missing) {
    const box = h('div', { class: 'st-adv-list st-adv-missing hidden' }, adv.missing.map((a) => advItem(a)));
    const toggle = h('button', { class: 'btn ghost sm', type: 'button', 'aria-expanded': 'false' }, icon('chevronDown'), t('stats.advMissing', { count: adv.missing.length }));
    toggle.addEventListener('click', () => {
      const open = box.classList.toggle('hidden') === false;
      toggle.setAttribute('aria-expanded', String(open));
      mount(toggle, icon(open ? 'chevronLeft' : 'chevronDown'), open ? t('stats.advMissingHide') : t('stats.advMissing', { count: adv.missing.length }));
    });
    missing = adv.missing.length ? h('div', { class: 'st-adv-section' }, toggle, box) : h('div', { class: 'notice good' }, icon('trophy'), t('stats.advAllDone'));
  } else if (!single && data.worldsCount > 1) {
    missing = footnote('info', t('stats.advPickWorld'), 'st-adv-section');
  }
  const worldMax = Math.max(0, ...adv.perWorld.map((w) => w.done));
  const perWorld =
    !single && adv.perWorld.length > 1
      ? h(
          'div',
          { class: 'st-adv-section' },
          h('div', { class: 'label' }, t('stats.advPerWorld')),
          h(
            'div',
            { class: 'st-adv-worlds' },
            [...adv.perWorld]
              .sort((a, b) => (b.total ? b.done / b.total : 0) - (a.total ? a.done / a.total : 0) || b.done - a.done)
              .slice(0, 12)
              .map((w) =>
                h(
                  'button',
                  { class: 'st-adv-world', type: 'button', title: t('stats.openWorldHint'), onclick: () => ctx.openWorld(w.instanceId, w.folder) },
                  h('div', { class: 'row between' }, h('span', { class: 'ellipsis st-adv-world-name', title: w.name }, w.name), h('span', { class: 'small muted num' }, w.total ? t('stats.advOf', { done: w.done, total: w.total }) : fmtInt(w.done))),
                  h('div', { class: 'tiny muted ellipsis', title: t('stats.worldCellSub', { instance: w.instanceName, version: w.mcVersion || '?' }) }, t('stats.worldCellSub', { instance: w.instanceName, version: w.mcVersion || '?' })),
                  h('div', { class: 'progress' }, h('i', { style: { width: `${Math.round(barPct(w.done, w.total, worldMax))}%` } })),
                ),
              ),
          ),
        )
      : null;
  return card({ icon: 'target', title: t('stats.advTitle'), sub: t('stats.advSub'), cls: ['st-adv-card', st.ingameLoading && 'st-busy'].filter(Boolean).join(' ') }, scopeBar(ctx), head, perWorld, recent, missing);
}
