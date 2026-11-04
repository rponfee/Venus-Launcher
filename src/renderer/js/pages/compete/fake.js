// Competir de ejemplo para capturas (VENUS_DEVSHOT + VENUS_REWARDS_FAKE, como el resto de Venus Points): misma forma que las
// RPC de 0031, en memoria y sin red. 'new' no tiene amigos ni desafíos; 'unavailable' responde que no hay servicio.
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const HOUR = 3600000;
const DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();

function fail(message, code = 'server') {
  throw Object.assign(new Error(message), { code });
}

const FRIENDS = [
  { id: 'f-tomi', username: 'TomiCraft', displayName: 'TomiCraft', mcName: 'TomiCraft', mcUuid: null },
  { id: 'f-luna', username: 'Luna_MC', displayName: 'Luna', mcName: 'Luna_MC', mcUuid: null },
  { id: 'f-nacho', username: 'ElNacho', displayName: 'El Nacho', mcName: 'ElNacho', mcUuid: null },
  { id: 'f-pixel', username: 'PixelRoja', displayName: 'Pixel', mcName: 'PixelRoja', mcUuid: null },
];
const ME = { id: 'fake-me', username: 'Ringo', displayName: 'Ringo', mcName: 'Ringo', mcUuid: null };
const NUMBERS = {
  'fake-me': { minutes: 754, diamonds: 18, mobs: 312, blocks: 8421, deaths: 7 },
  'f-tomi': { minutes: 1260, diamonds: 42, mobs: 590, blocks: 20310, deaths: 3 },
  'f-luna': { minutes: 845, diamonds: 7, mobs: 720, blocks: 4210, deaths: 12 },
  'f-nacho': { minutes: 310, diamonds: 2, mobs: 64, blocks: 1980, deaths: 21 },
};
const column = (metric) => (metric === 'hours' ? 'minutes' : metric);

export function createFakeCompete(scenario = 'demo') {
  const now = Date.now();
  const empty = scenario === 'new';
  let share = false; // como en una cuenta nueva: se prende con el interruptor
  const friend = (id) => FRIENDS.find((f) => f.id === id);
  const challenge = (id, friendId, extra) => ({ id, mine: false, metric: 'mobs', target: null, hours: 72, status: 'pending', createdAt: iso(now - HOUR), startsAt: null, endsAt: null, settledAt: null, expiresAt: null, outcome: null, won: null, prize: 0, prizeNote: null, friend: friend(friendId), myValue: null, theirValue: null, myMinutes: null, theirMinutes: null, ...extra });
  let challenges = empty ? [] : [
    challenge('c-in', 'f-luna', { metric: 'diamonds', target: 20, hours: 168, expiresAt: iso(now + 40 * HOUR) }),
    challenge('c-a1', 'f-tomi', { mine: true, status: 'active', startsAt: iso(now - DAY), endsAt: iso(now + 2 * DAY + 3 * HOUR), myValue: 240, theirValue: 310, myMinutes: 95, theirMinutes: 120 }),
    challenge('c-a2', 'f-nacho', { metric: 'hours', target: 600, status: 'active', hours: 168, startsAt: iso(now - 2 * DAY), endsAt: iso(now + 5 * HOUR), myValue: 420, theirValue: 150, myMinutes: 420, theirMinutes: 150 }),
    challenge('c-out', 'f-pixel', { mine: true, metric: 'blocks', hours: 24, expiresAt: iso(now + 20 * HOUR) }),
    challenge('c-w', 'f-tomi', { status: 'finished', outcome: 'win', won: true, prize: 25, settledAt: iso(now - DAY), myValue: 500, theirValue: 320, myMinutes: 300, theirMinutes: 200 }),
    challenge('c-cap', 'f-luna', { mine: true, status: 'finished', outcome: 'win', won: true, prize: 0, prizeNote: 'friend_cap', settledAt: iso(now - 2 * DAY), myValue: 80, theirValue: 40, myMinutes: 60, theirMinutes: 45 }),
    challenge('c-l', 'f-nacho', { metric: 'deaths', status: 'finished', outcome: 'win', won: false, settledAt: iso(now - 3 * DAY), myValue: 3, theirValue: 9, myMinutes: 120, theirMinutes: 80 }),
    challenge('c-na', 'f-pixel', { status: 'finished', outcome: 'no_activity', settledAt: iso(now - 4 * DAY), myValue: 12, theirValue: 0, myMinutes: 40, theirMinutes: 3 }),
    challenge('c-d', 'f-luna', { mine: true, status: 'declined', settledAt: iso(now - 5 * DAY) }),
  ];
  const signups = new Map([['t-1', ['f-tomi', 'f-luna', 'f-nacho']], ['t-full', ['f-tomi', 'f-luna']], ['e-soon', ['fake-me']]]);
  let events = [
    { id: 'e-now', title: 'Noche de construcción', description: 'Traé tus mejores bloques. Se juega en el servidor de la comunidad.', kind: 'event', startsAt: iso(now - HOUR), endsAt: iso(now + 2 * HOUR), capacity: null, server: 'mc.venus.example:25565', link: null },
    { id: 'e-soon', title: 'Charla con el equipo', description: 'Novedades del launcher y preguntas.', kind: 'event', startsAt: iso(now + 10 * 60000), endsAt: iso(now + HOUR), capacity: 100, server: null, link: 'https://venus.example/charla' },
    { id: 't-1', title: 'Torneo de PvP <b>sin HTML</b>', description: 'Eliminación directa, kit de hierro.\nSe arranca puntual: leé las reglas antes.', kind: 'tournament', startsAt: iso(now + 2 * DAY), endsAt: iso(now + 2 * DAY + 3 * HOUR), capacity: 8, server: 'pvp.venus.example', link: 'https://venus.example/torneo' },
    { id: 't-full', title: 'Copa de parkour', description: 'Cupo chico.', kind: 'tournament', startsAt: iso(now + 4 * DAY), endsAt: iso(now + 4 * DAY + 2 * HOUR), capacity: 2, server: null, link: null },
    { id: 'e-week', title: 'Semana de la redstone', description: 'Toda la semana: mostrá tus máquinas.', kind: 'event', startsAt: iso(now + 6 * DAY), endsAt: iso(now + 9 * DAY), capacity: null, server: null, link: null },
    { id: 'e-past', title: 'Maratón de la semana pasada', description: '', kind: 'event', startsAt: iso(now - 6 * DAY), endsAt: iso(now - 6 * DAY + 4 * HOUR), capacity: null, server: null, link: null },
  ];
  if (empty) {
    events = [];
    signups.clear();
  }
  const eventJson = (e) => ({ ...e, signups: (signups.get(e.id) || []).length, joined: (signups.get(e.id) || []).includes('fake-me') });
  const profileOf = (id) => (id === 'fake-me' ? ME : friend(id));

  const rpcs = {
    ranking_set_share({ p_on }) {
      share = p_on === true;
      return { share };
    },
    ranking_forget() {
      share = false;
      return { share };
    },
    ranking_report: ({ p_week }) => ({ week: p_week, accepted: {}, clamped: false }),
    ranking_friends({ p_metric: metric, p_week: week }) {
      const scale = week && Date.parse(`${week}T00:00:00Z`) < now - 7 * DAY ? 0.6 : 1;
      const ids = empty ? (share ? ['fake-me'] : []) : Object.keys(NUMBERS).filter((id) => id !== 'fake-me' || share);
      const rows = ids.map((id) => ({ ...profileOf(id), userId: id, value: Math.round((NUMBERS[id][column(metric)] || 0) * (empty ? 0 : scale)), me: id === 'fake-me' })).sort((a, b) => b.value - a.value);
      rows.forEach((r, i) => { r.rank = i && rows[i - 1].value === r.value ? rows[i - 1].rank : i + 1; });
      return { week, metric, share, mine: share && !empty ? NUMBERS['fake-me'] : null, rows };
    },
    challenges_me: () => ({ rules: { prize: 25, weekCap: 3, minMinutes: 10, pendingHours: 48 }, share, prizesThisWeek: empty ? 0 : 1, challenges: challenges.map((c) => ({ ...c })) }),
    challenge_settle: () => ({ settled: 0 }),
    challenge_create({ p_friend, p_metric, p_hours, p_target }) {
      if (!share) fail('share_off');
      if (challenges.some((c) => c.friend.id === p_friend && ['pending', 'active'].includes(c.status))) fail('already_open');
      const c = challenge(`c-${Date.now()}`, p_friend, { mine: true, metric: p_metric, hours: p_hours, target: p_target, createdAt: iso(Date.now()), expiresAt: iso(Date.now() + 48 * HOUR) });
      challenges = [c, ...challenges];
      return c;
    },
    challenge_respond({ p_id, p_accept }) {
      if (p_accept && !share) fail('share_off');
      const c = challenges.find((x) => x.id === p_id);
      if (!c || c.status !== 'pending') fail('not_pending');
      Object.assign(c, p_accept
        ? { status: 'active', startsAt: iso(Date.now()), endsAt: iso(Date.now() + c.hours * HOUR), myValue: 0, theirValue: 0, myMinutes: 0, theirMinutes: 0, expiresAt: null }
        : { status: 'declined', settledAt: iso(Date.now()), expiresAt: null });
      return c;
    },
    challenge_cancel({ p_id }) {
      const c = challenges.find((x) => x.id === p_id);
      if (!c || c.status !== 'pending') fail('not_pending');
      Object.assign(c, { status: 'canceled', settledAt: iso(Date.now()), expiresAt: null });
      return c;
    },
    events_list({ p_from, p_to } = {}) {
      const from = p_from ? Date.parse(p_from) : Date.now();
      const to = p_to ? Date.parse(p_to) : from + 90 * DAY;
      return events.filter((e) => Date.parse(e.endsAt) > from && Date.parse(e.startsAt) < to).sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)).map(eventJson);
    },
    events_mine: () => events.filter((e) => Date.parse(e.endsAt) > Date.now() && (signups.get(e.id) || []).includes('fake-me')).map(eventJson),
    event_signups({ p_id }) {
      return (signups.get(p_id) || []).map((id, i) => ({ ...profileOf(id), userId: id, at: iso(now - (i + 1) * HOUR), me: id === 'fake-me' }));
    },
    event_join({ p_id }) {
      const e = events.find((x) => x.id === p_id);
      if (!e) fail('not_found');
      const list = signups.get(p_id) || [];
      if (!list.includes('fake-me')) {
        if (Date.now() >= Date.parse(e.endsAt) || (e.kind === 'tournament' && Date.now() >= Date.parse(e.startsAt))) fail('closed');
        if (e.capacity !== null && list.length >= e.capacity) fail('full');
        signups.set(p_id, [...list, 'fake-me']);
      }
      return eventJson(e);
    },
    event_leave({ p_id }) {
      const e = events.find((x) => x.id === p_id);
      if (!e) fail('not_found');
      signups.set(p_id, (signups.get(p_id) || []).filter((id) => id !== 'fake-me'));
      return eventJson(e);
    },
    admin_events: () => [...events].sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt)).map(eventJson),
    admin_event_save({ p }) {
      if (p.id) {
        const e = events.find((x) => x.id === p.id);
        if (!e) fail('not_found');
        Object.assign(e, p);
        return eventJson(e);
      }
      const e = { ...p, id: `e-${Date.now()}` };
      events = [...events, e];
      return eventJson(e);
    },
    admin_event_delete({ p_id }) {
      events = events.filter((e) => e.id !== p_id);
      signups.delete(p_id);
      return { ok: true, id: p_id };
    },
  };

  return {
    friends: () => (empty ? [] : FRIENDS.map((f) => ({ id: f.id, name: f.displayName }))),
    async rpc(name, args) {
      await wait(250);
      if (scenario === 'unavailable') fail('unavailable', 'unavailable');
      const fn = rpcs[name];
      if (!fn) fail('unavailable', 'unavailable');
      return fn(args || {});
    },
  };
}
