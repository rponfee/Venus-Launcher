// Linea de tiempo vertical de un mundo: dias -> partidas (registradas, estimadas o en curso) con sus
// capturas, clips y logros, y el comienzo del mundo.
import { h, icon, mount, emptyState, fmtTime, fmtDate, fmtDuration } from '../../ui.js';
import { t, locale } from '../../i18n.js';
import { shortDur, categoryLabel, bone, skelGroup, DATE_TIME } from './common.js';
import { mediaTile } from './media.js';

const FRAME_ICON = { task: 'star', goal: 'target', challenge: 'trophy' };
const DAYS_PAGE = 14;
const ADV_VISIBLE = 6;
const MEDIA_VISIBLE = 5;

function dayLabel(day) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - day.date) / 86400000);
  if (diff === 0) return t('worlds.today');
  if (diff === 1) return t('worlds.yesterday');
  const sameYear = new Date(day.date).getFullYear() === today.getFullYear();
  const label = new Intl.DateTimeFormat(locale(), { weekday: 'long', day: 'numeric', month: 'long', year: sameYear ? undefined : 'numeric' }).format(day.date);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function createdText(source) {
  if (source === 'advancement') return t('worlds.createdByAdvancement');
  if (source === 'session') return t('worlds.createdBySession');
  return t('worlds.createdByFolder');
}

function sessionTitle(s) {
  if (s.live) return t('worlds.sessionLive');
  if (s.loose) return t('worlds.sessionLoose');
  if (s.inferred && !s.ms) return t('worlds.sessionActivity', { time: fmtTime(s.start) });
  return t('worlds.sessionRange', { from: fmtTime(s.start), to: fmtTime(s.end) });
}

/**
 * Un logro: icono del marco (tarea, meta o desafio) + titulo y, debajo, categoria y cuando.
 * when: texto de la fecha (hora en la linea de tiempo, "hace X" en estadisticas).
 */
export function advItem(a, when) {
  const frame = FRAME_ICON[a.frame] ? a.frame : 'task';
  const frameLabel = t(`worlds.frame_${frame}`);
  return h(
    'li',
    { class: ['wo-adv', `wo-adv-${frame}`, a.category && `wo-cat-${a.category}`] },
    h('span', { class: 'wo-adv-icon', role: 'img', title: frameLabel, 'aria-label': frameLabel }, icon(FRAME_ICON[frame])),
    h(
      'span',
      { class: 'wo-adv-main' },
      h('span', { class: 'wo-adv-title', title: a.title }, a.title),
      h(
        'span',
        { class: 'wo-adv-meta' },
        a.category ? h('span', { class: 'wo-adv-cat' }, categoryLabel(a.category)) : null,
        h('time', { class: 'wo-adv-time', datetime: new Date(a.at).toISOString(), title: fmtDate(a.at, DATE_TIME) }, when ?? fmtTime(a.at)),
      ),
    ),
  );
}

function advList(list) {
  if (!list.length) return null;
  const ul = h('ul', { class: 'wo-advs', 'aria-label': t('worlds.advancementsList', { count: list.length }) });
  const draw = (all) => mount(ul, (all ? list : list.slice(0, ADV_VISIBLE)).map((a) => advItem(a)));
  draw(false);
  if (list.length <= ADV_VISIBLE) return ul;
  const btn = h('button', { class: 'btn ghost sm wo-adv-more', type: 'button', 'aria-expanded': 'false' }, icon('chevronDown'), t('worlds.moreAdvancements', { count: list.length - ADV_VISIBLE }));
  btn.addEventListener('click', () => {
    const open = btn.getAttribute('aria-expanded') !== 'true';
    btn.setAttribute('aria-expanded', String(open));
    draw(open);
    mount(btn, icon('chevronDown'), open ? t('worlds.lessAdvancements') : t('worlds.moreAdvancements', { count: list.length - ADV_VISIBLE }));
    btn.classList.toggle('open', open);
  });
  return h('div', { class: 'stack' }, ul, btn);
}

// Tira de capturas de una partida: hasta 5 miniaturas que se achican para entrar y "+N" con el resto
function mediaStrip(s, allMedia, onOpenMedia, sharedMap) {
  if (!s.media.length) return null;
  const visible = s.media.slice(0, MEDIA_VISIBLE);
  const extra = s.media.length - visible.length;
  return h(
    'div',
    { class: 'wo-tl-media', style: { '--n': String(visible.length) } },
    visible.map((m) => mediaTile(m, { compact: true, shared: Boolean(sharedMap?.[m.sharedKey]), onOpen: () => onOpenMedia(allMedia, allMedia.indexOf(m)) })),
    extra > 0
      ? h(
          'button',
          { class: 'wo-tl-more', type: 'button', title: t('worlds.moreMedia', { count: extra }), 'aria-label': t('worlds.moreMedia', { count: extra }), onclick: () => onOpenMedia(allMedia, allMedia.indexOf(s.media[MEDIA_VISIBLE])) },
          `+${extra}`,
        )
      : null,
  );
}

function sessionItem(s, ctx) {
  const kind = s.live ? 'live' : s.loose ? 'loose' : s.inferred ? 'inferred' : 'tracked';
  const nodeIcon = { live: 'play', tracked: 'play', inferred: 'history', loose: 'image' }[kind];
  const counts = [];
  const shots = s.media.filter((m) => m.kind === 'screenshot').length;
  const clips = s.media.length - shots;
  if (shots) counts.push(h('span', { class: 'wo-tl-count' }, icon('camera'), t('worlds.shotsCount', { count: shots })));
  if (clips) counts.push(h('span', { class: 'wo-tl-count' }, icon('woFilm'), t('worlds.clipsCount', { count: clips })));
  if (s.advancements.length) counts.push(h('span', { class: 'wo-tl-count' }, icon('trophy'), t('worlds.advCount', { count: s.advancements.length })));
  return h(
    'li',
    { class: ['wo-tl-item', `is-${kind}`] },
    h('span', { class: 'wo-tl-node', 'aria-hidden': 'true' }, icon(nodeIcon)),
    h(
      'article',
      { class: 'wo-tl-card' },
      h(
        'header',
        { class: 'wo-tl-head' },
        h('div', { class: 'wo-tl-title' }, sessionTitle(s)),
        s.ms > 0 && !s.loose ? h('span', { class: 'wo-tl-dur', title: kind === 'inferred' ? t('worlds.estimatedHint') : null }, kind === 'inferred' ? t('worlds.approx', { time: fmtDuration(s.ms) }) : fmtDuration(s.ms)) : null,
        kind === 'live' ? h('span', { class: 'badge good wo-live-badge' }, h('i', { class: 'wo-pulse' }), t('worlds.playingNow')) : null,
        kind === 'inferred' ? h('span', { class: 'badge wo-est-badge', title: t('worlds.estimatedHint') }, t('worlds.estimated')) : null,
        counts.length ? h('div', { class: 'wo-tl-counts' }, counts) : null,
      ),
      mediaStrip(s, ctx.allMedia, ctx.onOpenMedia, ctx.sharedMap),
      advList(s.advancements),
      !s.media.length && !s.advancements.length && kind === 'tracked' ? h('p', { class: 'wo-tl-quiet' }, t('worlds.sessionQuiet')) : null,
    ),
  );
}

function createdItem(c) {
  return h(
    'li',
    { class: ['wo-tl-item', 'is-created'] },
    h('span', { class: 'wo-tl-node', 'aria-hidden': 'true' }, icon('woSprout')),
    h(
      'article',
      { class: 'wo-tl-card' },
      h('header', { class: 'wo-tl-head' }, h('div', { class: 'wo-tl-title' }, t('worlds.worldBegan')), h('span', { class: 'wo-tl-dur' }, fmtTime(c.at))),
      h('p', { class: 'wo-tl-quiet' }, createdText(c.source)),
    ),
  );
}

// Forma de la linea de tiempo mientras se lee
export function timelineSkeleton(label) {
  return skelGroup(label, h('div', { class: 'wo-skel-tl' }, bone('wo-skel-day'), bone('wo-skel-session'), bone('wo-skel-session'), bone('wo-skel-day'), bone('wo-skel-session')));
}

/**
 * data: respuesta de worlds:timeline. opts: { order: 'desc'|'asc', onOpenMedia(list, index), sharedMap, empty }
 */
export function timelineView(data, { order = 'desc', onOpenMedia, sharedMap = {}, empty } = {}) {
  const days = order === 'asc' ? [...data.days].reverse() : data.days;
  if (!days.length) return empty || h('div', { class: 'card flat' }, emptyState('history', t('worlds.noHistory'), t('worlds.noHistoryText')));
  const allMedia = data.days.flatMap((d) => d.sessions.flatMap((s) => s.media)).sort((a, b) => b.time - a.time);
  const ctx = { allMedia, onOpenMedia, sharedMap };
  const host = h('ol', { class: 'wo-tl', 'aria-label': t('worlds.timelineLabel') });
  let shown = 0;
  const more = h('button', { class: 'btn wo-more', type: 'button' });
  function draw() {
    for (const day of days.slice(shown, shown + DAYS_PAGE)) {
      const sessions = order === 'asc' ? [...day.sessions].reverse() : day.sessions;
      const items = sessions.map((s) => sessionItem(s, ctx));
      if (day.created) {
        if (order === 'asc') items.unshift(createdItem(day.created));
        else items.push(createdItem(day.created));
      }
      host.append(
        h(
          'li',
          { class: ['wo-tl-day', day.live && 'live'] },
          h(
            'div',
            { class: 'wo-tl-dayhead' },
            h(
              'div',
              { class: 'wo-tl-daypill' },
              h('h3', { class: 'wo-tl-date' }, dayLabel(day)),
              day.ms > 0 ? h('span', { class: 'wo-tl-daytotal', title: day.approx ? t('worlds.estimatedHint') : null }, day.approx ? t('worlds.approx', { time: fmtDuration(day.ms) }) : fmtDuration(day.ms)) : null,
            ),
          ),
          h('ol', { class: 'wo-tl-list' }, items),
        ),
      );
    }
    shown = Math.min(days.length, shown + DAYS_PAGE);
    more.hidden = shown >= days.length;
    mount(more, icon('chevronDown'), t('worlds.olderDays', { count: days.length - shown }));
  }
  more.addEventListener('click', draw);
  draw();
  return h('div', { class: 'wo-tl-wrap' }, host, more);
}

// Resumen arriba de la linea de tiempo
export function timelineSummary(totals) {
  const parts = [];
  if (totals.sessions) parts.push(t('worlds.sessionsCount', { count: totals.sessions }), t('worlds.daysPlayed', { count: totals.days }));
  if (totals.trackedMs) parts.push(t('worlds.sumTracked', { time: shortDur(totals.trackedMs) }));
  if (totals.estimatedMs) parts.push(t('worlds.sumEstimated', { time: shortDur(totals.estimatedMs) }));
  if (totals.advancements) parts.push(t('worlds.advCount', { count: totals.advancements }));
  return h('p', { class: 'wo-tl-summary' }, parts.map((p) => h('span', {}, p)));
}
