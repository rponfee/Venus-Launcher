// Registro de eventos del proyecto: builds, despliegues, recargas, servidor y cliente.
import { h, icon, mount, fail, fmtTime, fmtDate, skeleton } from '../../ui.js';
import { api } from '../../store.js';
import { t, locale } from '../../i18n.js';
import { EVENT_ICONS, eventText, iconBtn } from './common.js';

const MAX = 200;

function sameDay(a, b) {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

export function eventsCard(ctx) {
  const el = h('section', { class: 'card dm-card dm-events', 'aria-label': t('devmode.eventsCard') });
  const list = h('ol', { class: 'dm-log', 'aria-live': 'polite', 'aria-label': t('devmode.eventsCard') });
  let entries = [];

  const row = (e) => {
    const full = new Date(e.t).toLocaleString(locale());
    return h(
      'li',
      { class: ['dm-ev', `lv-${e.level || 'info'}`] },
      h('span', { class: 'dm-ev-icon', 'aria-hidden': 'true' }, icon(EVENT_ICONS[e.kind] || 'info')),
      h('div', { class: 'dm-ev-text' }, eventText(e)),
      h('time', { class: 'dm-ev-time', datetime: new Date(e.t).toISOString(), title: full }, sameDay(e.t, Date.now()) ? fmtTime(e.t) : fmtDate(e.t, { day: 'numeric', month: 'short' })),
    );
  };

  const empty = () => h('li', { class: 'dm-log-empty' }, icon('history'), h('div', {}, t('devmode.eventsEmpty')));
  const draw = () => {
    if (!entries.length) mount(list, empty());
    else mount(list, [...entries].reverse().map(row));
  };

  mount(
    el,
    h(
      'div',
      { class: 'card-head' },
      h('h2', { class: 'card-title' }, icon('history'), t('devmode.eventsCard')),
      iconBtn(
        'trash',
        t('devmode.clearEvents'),
        async () => {
          try {
            await api.invoke('devmode:clearEvents', ctx.id);
            entries = [];
            draw();
          } catch (err) {
            fail(t('devmode.errClear'), err);
          }
        },
        'danger',
      ),
    ),
    list,
  );
  mount(list, h('li', { class: 'dm-log-loading' }, skeleton('list', { rows: 3 })));
  api
    .invoke('devmode:events', ctx.id)
    .then((l) => {
      entries = [...(l || []), ...entries].slice(-MAX);
      draw();
    })
    .catch(() => draw());

  const offs = [
    ctx.on('event', (e) => {
      entries.push(e);
      if (entries.length > MAX) entries.shift();
      if (list.querySelector('.dm-log-empty, .dm-log-loading')) draw();
      else {
        list.prepend(row(e));
        while (list.childNodes.length > MAX) list.lastChild.remove();
      }
    }),
  ];
  return { el, destroy: () => offs.forEach((o) => o()) };
}
