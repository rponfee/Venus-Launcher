// Competir -> Eventos: la agenda en vista de mes y lo que viene, anotarse y darse de baja. Todo en la zona horaria de la PC.
// El texto de un evento es siempre texto: h() lo pone con textContent, nunca como HTML.
import { h, icon, mount, modal, skeleton, emptyState, setBusy, fail, ok, fmtDate, copyText } from '../../ui.js';
import { api } from '../../store.js';
import { t, locale } from '../../i18n.js';
import { errText, loadMyEvents } from '../../features/compete.js';
import { headImg } from '../../social/profile-ui.js';
import { dayKey, eventAction, eventState, eventsOnDay, monthGrid, monthRange, normalizeEvent, shiftMonth, upcomingEvents } from './logic.js';
import { eventRange, friendName, signupsText, timeZoneName } from './format.js';

const C = (key, vars) => t(`compete.${key}`, vars);

function kindPill(ev) {
  return ev.kind === 'tournament' ? h('span', { class: 'pill warn' }, icon('trophy'), C('kind_tournament')) : h('span', { class: 'pill' }, icon('calendar'), C('kind_event'));
}

function statePill(ev, now) {
  const st = eventState(ev, now);
  if (st === 'live') return h('span', { class: 'pill good' }, icon('play'), C('stateLive'));
  if (st === 'ended') return h('span', { class: 'pill' }, icon('history'), C('stateEnded'));
  return null;
}

// ---------- Detalle ----------
async function signupsList(b, ev, host) {
  mount(host, skeleton(2));
  try {
    const rows = await b.rpc('event_signups', { p_id: ev.id });
    if (!host.isConnected) return;
    mount(host, Array.isArray(rows) && rows.length
      ? h('ul', { class: 'cp-signups' }, rows.map((r) => h('li', { class: r.me ? 'is-me' : null }, headImg({ mcUuid: r.mcUuid, mcName: r.mcName, username: r.username }, 24, 'cp-head'), h('span', { class: 'ellipsis' }, friendName(r)), r.me ? h('span', { class: 'badge accent' }, C('you')) : null)))
      : h('p', { class: 'cp-muted small' }, C('signupsNone')));
  } catch (err) {
    if (host.isConnected) mount(host, h('p', { class: 'cp-muted small' }, errText(err)));
  }
}

function openEvent(b, initial, onChange) {
  let ev = initial;
  const body = h('div', { class: 'stack cp-ev-detail' });
  const dialog = modal({ title: ev.title, icon: ev.kind === 'tournament' ? 'trophy' : 'calendar', body });
  const list = h('div');
  function draw() {
    const now = Date.now();
    const action = eventAction(ev, now);
    const btn = action === 'join'
      ? h('button', { type: 'button', class: 'btn primary' }, icon('check'), C('evJoin'))
      : action === 'leave'
        ? h('button', { type: 'button', class: 'btn' }, icon('x'), C('evLeave'))
        : h('button', { type: 'button', class: 'btn', disabled: true }, icon('lock'), action === 'full' ? C('evFull') : C('evClosed'));
    if (action === 'join' || action === 'leave') {
      btn.addEventListener('click', async () => {
        const done = setBusy(btn);
        try {
          const updated = normalizeEvent(await b.rpc(action === 'join' ? 'event_join' : 'event_leave', { p_id: ev.id }));
          if (updated) ev = updated;
          ok(action === 'join' ? C('evJoined') : C('evLeft'));
          loadMyEvents({ force: true });
          onChange?.();
          draw();
        } catch (err) {
          fail(C('actionError'), errText(err));
        } finally {
          done();
        }
      });
    }
    mount(body,
      h('div', { class: 'cp-chips' }, kindPill(ev), statePill(ev, now), ev.joined ? h('span', { class: 'pill good' }, icon('check'), C('evYouJoined')) : null),
      h('dl', { class: 'cp-ev-facts' },
        h('dt', {}, icon('clock'), C('evWhen')), h('dd', {}, eventRange(ev), h('div', { class: 'cp-muted small' }, C('timeZone', { zone: timeZoneName() }))),
        h('dt', {}, icon('users'), C('evSignups')), h('dd', {}, signupsText(ev)),
        ev.server ? h('dt', {}, icon('server'), C('evServer')) : null,
        ev.server ? h('dd', { class: 'cp-ev-actions' }, h('code', { class: 'wrap-anywhere' }, ev.server),
          h('button', { type: 'button', class: 'icon-btn sm', title: C('evCopy'), 'aria-label': C('evCopy'), onclick: () => copyText(ev.server) }, icon('copy')),
          h('button', { type: 'button', class: 'btn sm tonal', onclick: async () => { dialog.close(); (await import('../../features/serverlist.js')).joinServer(ev.server).catch((err) => fail(C('actionError'), err)); } }, icon('play'), C('evJoinServer'))) : null,
        ev.link ? h('dt', {}, icon('link'), C('evLink')) : null,
        ev.link ? h('dd', {}, h('button', { type: 'button', class: 'cp-link wrap-anywhere', title: ev.link, onclick: () => api.invoke('app:openExternal', ev.link).catch((err) => fail(C('actionError'), err)) }, ev.link, ' ', icon('external'))) : null),
      ev.description ? h('p', { class: 'cp-ev-desc' }, ev.description) : null,
      ev.kind === 'tournament' ? h('div', { class: 'cp-ev-signups' }, h('h3', { class: 'card-title' }, icon('users'), C('evSignupList')), list) : null,
      h('div', { class: 'cp-form-foot' }, h('p', { class: 'cp-muted small' }, ev.joined ? C('evReminder') : C('evReminderOff')), btn));
    if (ev.kind === 'tournament') signupsList(b, ev, list);
  }
  draw();
}

// ---------- Pestaña ----------
export function eventsView(root, { b, args = [] }) {
  const today = new Date();
  let month = { year: today.getFullYear(), month: today.getMonth() };
  let selected = null;
  let monthEvents = [];
  let upcoming = [];
  let seq = 0;
  let openId = args[0] || null;
  const calendar = h('section', { class: 'card cp-cal-card' });
  const side = h('section', { class: 'card cp-side' });

  const monthTitle = () => {
    const text = new Date(month.year, month.month, 1).toLocaleDateString(locale(), { month: 'long', year: 'numeric' });
    return text.charAt(0).toUpperCase() + text.slice(1);
  };
  const weekdays = () => Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(locale(), { weekday: 'short' }));
  const allEvents = () => {
    const byId = new Map();
    for (const e of [...monthEvents, ...upcoming]) byId.set(e.id, e);
    return [...byId.values()];
  };
  const show = (ev) => openEvent(b, ev, load);

  function drawCalendar() {
    const now = Date.now();
    const weeks = monthGrid(month, monthEvents, now);
    const go = (n) => {
      month = shiftMonth(month, n);
      selected = null;
      load();
    };
    mount(calendar,
      h('div', { class: 'cp-cal-head' },
        h('button', { type: 'button', class: 'icon-btn', title: C('calPrev'), 'aria-label': C('calPrev'), onclick: () => go(-1) }, icon('chevronLeft')),
        h('h2', { class: 'cp-cal-title', 'aria-live': 'polite' }, monthTitle()),
        h('button', { type: 'button', class: 'icon-btn', title: C('calNext'), 'aria-label': C('calNext'), onclick: () => go(1) }, icon('chevronRight')),
        h('button', { type: 'button', class: 'btn sm ghost', onclick: () => { const d = new Date(); month = { year: d.getFullYear(), month: d.getMonth() }; selected = dayKey(d.getTime()); load(); } }, C('calToday'))),
      h('table', { class: 'cp-cal' },
        h('thead', {}, h('tr', {}, weekdays().map((d) => h('th', { scope: 'col' }, d)))),
        h('tbody', {}, weeks.map((week) => h('tr', {}, week.map((d) => {
          const label = d.events.length ? C('calDayEvents', { date: fmtDate(new Date(`${d.key}T12:00:00`).getTime(), { day: 'numeric', month: 'long' }), count: d.events.length }) : fmtDate(new Date(`${d.key}T12:00:00`).getTime(), { day: 'numeric', month: 'long' });
          return h('td', { class: [!d.inMonth && 'is-out', d.today && 'is-today', d.key === selected && 'is-selected'] },
            h('button', { type: 'button', class: 'cp-day', 'aria-label': label, 'aria-pressed': String(d.key === selected), onclick: () => { selected = selected === d.key ? null : d.key; drawCalendar(); drawSide(); } },
              h('span', { class: 'cp-day-num' }, String(d.day)),
              d.events.slice(0, 2).map((e) => h('span', { class: ['cp-day-ev', e.kind === 'tournament' && 'is-tournament', e.joined && 'is-joined'], title: e.title }, e.title)),
              d.events.length > 2 ? h('span', { class: 'cp-day-more' }, C('calMore', { n: d.events.length - 2 })) : null));
        }))))),
      h('p', { class: 'cp-muted small cp-cal-zone' }, icon('clock'), C('timeZone', { zone: timeZoneName() })));
  }

  function eventRow(ev, now) {
    const d = new Date(ev.startsAt);
    return h('li', {}, h('button', { type: 'button', class: 'cp-ev-row', onclick: () => show(ev) },
      h('span', { class: 'cp-ev-date', 'aria-hidden': 'true' }, h('b', {}, String(d.getDate())), d.toLocaleDateString(locale(), { month: 'short' })),
      h('span', { class: 'cp-ev-main' },
        h('strong', { class: 'ellipsis' }, ev.title),
        h('span', { class: 'cp-muted small ellipsis' }, eventRange(ev)),
        h('span', { class: 'cp-chips' }, kindPill(ev), statePill(ev, now), ev.joined ? h('span', { class: 'pill good' }, icon('check'), C('evYouJoined')) : null, h('span', { class: 'cp-muted small' }, signupsText(ev))))));
  }

  function drawSide() {
    const now = Date.now();
    const list = selected ? eventsOnDay(allEvents(), selected) : upcomingEvents(upcoming, now);
    const title = selected ? fmtDate(new Date(`${selected}T12:00:00`).getTime(), { weekday: 'long', day: 'numeric', month: 'long' }) : C('upcomingTitle');
    mount(side,
      h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, icon(selected ? 'calendar' : 'clock'), title),
        selected ? h('button', { type: 'button', class: 'btn sm ghost', onclick: () => { selected = null; drawCalendar(); drawSide(); } }, C('upcomingTitle')) : null),
      list.length ? h('ul', { class: 'cp-ev-list' }, list.map((e) => eventRow(e, now))) : emptyState('calendar', selected ? C('dayEmpty') : C('upcomingEmptyTitle'), selected ? null : C('upcomingEmptyText')));
  }

  async function load() {
    const my = ++seq;
    const { from, to } = monthRange(month);
    try {
      const [inMonth, next] = await Promise.all([
        b.rpc('events_list', { p_from: new Date(from).toISOString(), p_to: new Date(to).toISOString() }),
        b.rpc('events_list', {}),
      ]);
      if (my !== seq || !root.isConnected) return;
      monthEvents = (inMonth || []).map(normalizeEvent).filter(Boolean);
      upcoming = (next || []).map(normalizeEvent).filter(Boolean);
      side.hidden = false;
      drawCalendar();
      drawSide();
      if (openId) {
        const target = allEvents().find((e) => e.id === openId);
        openId = null;
        if (target) show(target);
      }
    } catch (err) {
      if (my !== seq || !root.isConnected) return;
      if (err?.code !== 'unavailable') console.warn('[compete] eventos', err?.message || err);
      mount(calendar, h('div', { class: 'notice bad' }, icon('alert'), h('div', { class: 'spacer' }, errText(err)), h('button', { type: 'button', class: 'btn sm', onclick: load }, icon('refresh'), C('retry'))));
      mount(side);
      side.hidden = true;
    }
  }

  mount(root, h('div', { class: 'cp-agenda' }, calendar, side), h('p', { class: 'cp-note' }, icon('bell'), h('span', {}, C('eventsNote'))));
  mount(calendar, skeleton('block', { height: 320 }));
  mount(side, skeleton('list', { rows: 3 }));
  load();
  return () => { seq++; };
}
