process.env.TZ = 'America/Argentina/Buenos_Aires';
const { default: test } = await import('node:test');
const { default: assert } = await import('node:assert/strict');
const L = await import('../logic.js');

const at = (s) => Date.parse(s);

test('semanas de lunes a domingo en UTC', () => {
  assert.equal(L.weekKey(at('2026-11-08T23:59:59Z')), '2026-11-02');
  assert.equal(L.weekKey(at('2026-11-09T00:00:00Z')), '2026-11-09');
  assert.equal(L.shiftWeek('2026-11-02', -1), '2026-10-26');
  assert.equal(L.shiftWeek('2026-12-28', 1), '2027-01-04');
  const { from, to } = L.weekBounds('2026-11-02');
  assert.equal(new Date(from).toISOString(), '2026-11-02T00:00:00.000Z');
  assert.equal(new Date(to).toISOString(), '2026-11-08T00:00:00.000Z');
});

test('métricas: las horas se ven con un decimal y el objetivo va en minutos', () => {
  assert.equal(L.metricNumber('hours', 90), 1.5);
  assert.equal(L.metricNumber('hours', 100), 1.7);
  assert.equal(L.metricNumber('diamonds', 12.9), 12);
  assert.equal(L.metricNumber('mobs', -4), 0);
  assert.equal(L.goalToTarget('hours', '2,5'), 150);
  assert.equal(L.goalToTarget('hours', '169'), null);
  assert.equal(L.goalToTarget('diamonds', '12'), 12);
  assert.equal(L.goalToTarget('diamonds', '1.5'), null);
  assert.equal(L.goalToTarget('diamonds', '0'), null);
  assert.equal(L.goalToTarget('blocks', 'muchos'), null);
  assert.equal(L.goalToTarget('nada', '5'), null);
});

test('rankingView calcula las barras y descarta lo raro', () => {
  const v = L.rankingView({ week: '2026-11-02', metric: 'mobs', share: true, rows: [{ userId: 'a', value: 200, rank: 1, me: true }, { userId: 'b', value: 50, rank: 2 }, { value: 9 }, null] });
  assert.equal(v.rows.length, 2);
  assert.deepEqual(v.rows.map((r) => r.pct), [100, 25]);
  assert.equal(v.rows[0].me, true);
  assert.equal(v.rows[1].me, false);
  assert.deepEqual(L.rankingView({ rows: [{ userId: 'a', value: 0 }] }).rows.map((r) => r.pct), [0]);
  assert.deepEqual(L.rankingView(null).rows, []);
});

const raw = (id, status, extra = {}) => ({ id, status, metric: 'mobs', mine: false, hours: 24, createdAt: '2026-11-02T10:00:00Z', friend: { id: 'f', username: 'Tomi' }, ...extra });

test('los desafíos se separan como en la página', () => {
  const g = L.groupChallenges([
    raw('a', 'pending'),
    raw('b', 'pending', { mine: true }),
    raw('c', 'active', { endsAt: '2026-11-05T00:00:00Z' }),
    raw('d', 'active', { endsAt: '2026-11-04T00:00:00Z' }),
    raw('e', 'finished', { settledAt: '2026-11-01T00:00:00Z' }),
    raw('f', 'declined', { settledAt: '2026-11-03T00:00:00Z' }),
    { id: 'x', metric: 'otra' },
  ]);
  assert.deepEqual(g.incoming.map((c) => c.id), ['a']);
  assert.deepEqual(g.outgoing.map((c) => c.id), ['b']);
  assert.deepEqual(g.active.map((c) => c.id), ['d', 'c']);
  assert.deepEqual(g.closed.map((c) => c.id), ['f', 'e']);
});

test('las barras de un desafío van contra el objetivo o contra el mejor', () => {
  assert.deepEqual(L.challengeBars({ target: 200, myValue: 50, theirValue: 400 }), { me: 25, them: 100 });
  assert.deepEqual(L.challengeBars({ target: null, myValue: 30, theirValue: 60 }), { me: 50, them: 100 });
  assert.deepEqual(L.challengeBars({ target: null, myValue: 0, theirValue: 0 }), { me: 0, them: 0 });
});

test('avisos: al recibir, al aceptar y al terminar', () => {
  const first = L.challengeNotices(null, [raw('a', 'pending'), raw('b', 'active', { mine: true }), raw('c', 'finished')]);
  // La primera vez solo avisa lo que hay que responder
  assert.deepEqual(first.notices.map((n) => [n.type, n.challenge.id]), [['received', 'a']]);
  assert.deepEqual(first.seen, ['a:pending', 'b:active', 'c:finished']);
  // Sin cambios no avisa de nuevo
  assert.deepEqual(L.challengeNotices(first.seen, [raw('a', 'pending'), raw('b', 'active', { mine: true }), raw('c', 'finished')]).notices, []);
  // Cambian de estado
  const next = L.challengeNotices(first.seen, [
    raw('a', 'active'), // lo acepté yo: no se avisa
    raw('b', 'finished', { mine: true, won: true, prize: 25 }),
    raw('d', 'active', { mine: true }), // me lo aceptaron
    raw('e', 'declined', { mine: true }),
    raw('f', 'declined'), // lo rechacé yo
    raw('g', 'expired', { mine: true }),
    raw('h', 'expired'),
    raw('i', 'canceled'),
    raw('j', 'pending'),
    raw('k', 'pending', { mine: true }),
  ]);
  assert.deepEqual(next.notices.map((n) => [n.type, n.challenge.id]), [['finished', 'b'], ['accepted', 'd'], ['declined', 'e'], ['expired', 'g'], ['received', 'j']]);
  assert.equal(next.seen.length, 10);
});

test('nextSettleAt da el plazo más próximo', () => {
  assert.equal(L.nextSettleAt([{ status: 'active', endsAt: 50 }, { status: 'active', endsAt: 30 }, { status: 'finished', endsAt: 1 }]), 30);
  assert.equal(L.nextSettleAt([]), null);
});

test('validar el formulario de un desafío', () => {
  assert.equal(L.validateChallengeForm({}).error, 'friend');
  assert.equal(L.validateChallengeForm({ friend: 'a', metric: 'x', hours: 24 }).error, 'metric');
  assert.equal(L.validateChallengeForm({ friend: 'a', metric: 'mobs', hours: 5 }).error, 'hours');
  assert.equal(L.validateChallengeForm({ friend: 'a', metric: 'mobs', hours: 24, mode: 'target', goal: '' }).error, 'goal');
  assert.deepEqual(L.validateChallengeForm({ friend: 'a', metric: 'hours', hours: '72', mode: 'target', goal: '3' }).payload, { p_friend: 'a', p_metric: 'hours', p_hours: 72, p_target: 180 });
  assert.equal(L.validateChallengeForm({ friend: 'a', metric: 'mobs', hours: 168, mode: 'most', goal: '3' }).payload.p_target, null);
});

test('tiempo que queda', () => {
  const now = at('2026-11-02T00:00:00Z');
  assert.deepEqual(L.timeLeft(now + 2 * 86400000 + 3 * 3600000 + 4 * 60000, now), { ms: 2 * 86400000 + 3 * 3600000 + 4 * 60000, days: 2, hours: 3, minutes: 4 });
  assert.equal(L.timeLeft(now - 5, now).ms, 0);
});

const ev = (id, starts, ends, extra = {}) => L.normalizeEvent({ id, title: id, startsAt: starts, endsAt: ends, signups: 0, ...extra });

test('los eventos se normalizan y el texto queda como texto', () => {
  const e = L.normalizeEvent({ id: 'a', title: '<b>Hola</b>', description: 7, startsAt: '2026-11-05T20:00:00Z', endsAt: '2026-11-05T22:00:00Z', kind: 'x', capacity: 2, signups: 2, link: 'javascript:alert(1)' });
  assert.equal(e.title, '<b>Hola</b>');
  assert.equal(e.description, '7');
  assert.equal(e.kind, 'event');
  assert.equal(e.full, true);
  assert.equal(e.link, null);
  assert.equal(L.normalizeEvent({ id: 'a', startsAt: 'x', endsAt: 'y' }), null);
  assert.equal(L.safeLink('https://venus.gg/torneo?x=1'), 'https://venus.gg/torneo?x=1');
  assert.equal(L.safeLink('http://venus.gg'), null);
  assert.equal(L.safeLink('https://a b'), null);
  assert.equal(L.safeLink(null), null);
});

test('vista de mes: semanas de lunes a domingo en la hora local', () => {
  // Noviembre de 2026 empieza en domingo y termina en lunes
  const weeks = L.monthGrid({ year: 2026, month: 10 }, [], at('2026-11-15T12:00:00-03:00'));
  assert.equal(weeks.length, 6);
  assert.ok(weeks.every((w) => w.length === 7));
  assert.equal(weeks[0][0].key, '2026-10-26');
  assert.equal(weeks[0][6].key, '2026-11-01');
  assert.equal(weeks[0][0].inMonth, false);
  assert.equal(weeks[0][6].inMonth, true);
  assert.equal(weeks[5][0].key, '2026-11-30');
  assert.equal(weeks[5][6].key, '2026-12-06');
  assert.deepEqual(weeks.flat().filter((d) => d.today).map((d) => d.key), ['2026-11-15']);
  // Febrero de 2027 cabe justo en 4 semanas
  const feb = L.monthGrid({ year: 2027, month: 1 }, [], 0);
  assert.equal(feb.length, 4);
  assert.equal(feb[0][0].key, '2027-02-01');
  assert.equal(feb[3][6].key, '2027-02-28');
  assert.equal(L.shiftMonth({ year: 2026, month: 11 }, 1).year, 2027);
  assert.deepEqual(L.shiftMonth({ year: 2026, month: 0 }, -1), { year: 2025, month: 11 });
});

test('vista de mes: cada evento cae en los días locales que toca', () => {
  const grid = L.monthGrid({ year: 2026, month: 10 }, [
    // 23:30 UTC del 5 son las 20:30 del 5 en Argentina; 02:30 UTC del 6 son las 23:30 del 5: un solo día
    ev('noche', '2026-11-05T23:30:00Z', '2026-11-06T02:30:00Z'),
    // De la noche del 6 a la madrugada del 8 (hora local)
    ev('largo', '2026-11-07T01:00:00Z', '2026-11-08T05:00:00Z'),
    // Termina justo a la medianoche local del 11: no toca el 11
    ev('justo', '2026-11-10T20:00:00Z', '2026-11-11T03:00:00Z'),
    // Fuera de lo que se ve
    ev('afuera', '2027-01-10T20:00:00Z', '2027-01-10T22:00:00Z'),
  ], 0);
  const on = (key) => grid.flat().find((d) => d.key === key).events.map((e) => e.id);
  assert.deepEqual(on('2026-11-05'), ['noche']);
  assert.deepEqual(on('2026-11-06'), ['largo']);
  assert.deepEqual(on('2026-11-07'), ['largo']);
  assert.deepEqual(on('2026-11-08'), ['largo']);
  assert.deepEqual(on('2026-11-10'), ['justo']);
  assert.deepEqual(on('2026-11-11'), []);
  assert.deepEqual(grid.flat().flatMap((d) => d.events).filter((e) => e.id === 'afuera'), []);
  assert.deepEqual(L.eventsOnDay([ev('noche', '2026-11-05T23:30:00Z', '2026-11-06T02:30:00Z')], '2026-11-05').map((e) => e.id), ['noche']);
  assert.deepEqual(L.eventsOnDay([ev('noche', '2026-11-05T23:30:00Z', '2026-11-06T02:30:00Z')], '2026-11-06'), []);
});

test('el rango de un mes cubre semanas completas', () => {
  const { from, to } = L.monthRange({ year: 2026, month: 10 });
  assert.equal(L.dayKey(from), '2026-10-26');
  assert.equal(L.dayKey(to), '2026-12-07');
  const feb = L.monthRange({ year: 2027, month: 1 });
  assert.equal(L.dayKey(feb.from), '2027-02-01');
  assert.equal(L.dayKey(feb.to), '2027-03-01');
});

test('próximos: solo lo que no terminó y en orden', () => {
  const now = at('2026-11-05T12:00:00Z');
  const list = [ev('b', '2026-11-08T12:00:00Z', '2026-11-08T13:00:00Z'), ev('viejo', '2026-11-01T12:00:00Z', '2026-11-01T13:00:00Z'), ev('ahora', '2026-11-05T11:00:00Z', '2026-11-05T13:00:00Z')];
  assert.deepEqual(L.upcomingEvents(list, now).map((e) => e.id), ['ahora', 'b']);
  assert.equal(L.eventState(list[0], now), 'upcoming');
  assert.equal(L.eventState(list[1], now), 'ended');
  assert.equal(L.eventState(list[2], now), 'live');
});

test('anotarse: un torneo se cierra al empezar y al llegar al cupo', () => {
  const now = at('2026-11-05T12:00:00Z');
  const torneo = (extra) => ev('t', '2026-11-05T13:00:00Z', '2026-11-05T15:00:00Z', { kind: 'tournament', capacity: 2, ...extra });
  assert.equal(L.eventAction(torneo({}), now), 'join');
  assert.equal(L.eventAction(torneo({ signups: 2 }), now), 'full');
  assert.equal(L.eventAction(torneo({ signups: 2, joined: true }), now), 'leave');
  assert.equal(L.eventAction(torneo({}), at('2026-11-05T13:30:00Z')), 'closed');
  assert.equal(L.eventAction(torneo({ joined: true }), at('2026-11-05T13:30:00Z')), 'leave');
  assert.equal(L.eventAction(torneo({ joined: true }), at('2026-11-05T15:30:00Z')), 'closed');
  const evento = ev('e', '2026-11-05T11:00:00Z', '2026-11-05T15:00:00Z');
  assert.equal(L.eventAction(evento, now), 'join'); // un evento se puede sumar mientras dura
});

test('recordatorios: 15 minutos antes, una sola vez y solo de lo anotado', () => {
  const start = at('2026-11-05T20:00:00Z');
  const e = ev('a', '2026-11-05T20:00:00Z', '2026-11-05T22:00:00Z', { joined: true });
  const otro = ev('b', '2026-11-05T20:00:00Z', '2026-11-05T22:00:00Z', { joined: false });
  const due = (now, reminded = []) => L.dueReminders([e, otro], reminded, now).map((x) => x.id);
  assert.deepEqual(due(start - 16 * 60000), []);
  assert.deepEqual(due(start - 15 * 60000), ['a']);
  assert.deepEqual(due(start - 60000), ['a']); // el launcher abrió cuando faltaba poco
  assert.deepEqual(due(start), []); // ya empezó
  assert.deepEqual(due(start - 60000, [L.reminderKey(e)]), []);
  // Si el evento cambia de horario se vuelve a avisar
  const movido = ev('a', '2026-11-05T21:00:00Z', '2026-11-05T22:00:00Z', { joined: true });
  assert.deepEqual(L.dueReminders([movido], [L.reminderKey(e)], at('2026-11-05T20:50:00Z')).map((x) => x.id), ['a']);
});

test('lo avisado que ya pasó se olvida', () => {
  const e = ev('a', '2026-11-05T20:00:00Z', '2026-11-05T22:00:00Z');
  const kept = L.pruneReminded([L.reminderKey(e), 'viejo:1'], [e], at('2026-11-05T21:00:00Z'));
  assert.deepEqual(kept, [L.reminderKey(e)]);
  assert.deepEqual(L.pruneReminded([L.reminderKey(e)], [e], at('2026-11-06T00:00:00Z')), []);
});

test('el formulario de un evento usa la hora de la PC y valida cada campo', () => {
  assert.equal(L.toLocalInput('2026-11-05T23:30:00Z'), '2026-11-05T20:30');
  assert.equal(L.toLocalInput('x'), '');
  const base = { title: ' Torneo ', kind: 'tournament', startsAt: '2026-11-05T20:30', endsAt: '2026-11-05T22:00', capacity: '16', server: 'mc.venus.gg:25565', link: 'https://venus.gg/t' };
  const ok = L.validateEventForm(base);
  assert.equal(ok.ok, true);
  assert.equal(ok.payload.title, 'Torneo');
  assert.equal(ok.payload.startsAt, '2026-11-05T23:30:00.000Z');
  assert.equal(ok.payload.capacity, 16);
  assert.equal(L.validateEventForm({ ...base, title: '' }).error, 'title');
  assert.equal(L.validateEventForm({ ...base, description: 'x'.repeat(2001) }).error, 'description');
  assert.equal(L.validateEventForm({ ...base, endsAt: base.startsAt }).error, 'dates');
  assert.equal(L.validateEventForm({ ...base, capacity: '' }).error, 'capacity'); // un torneo necesita cupo
  assert.equal(L.validateEventForm({ ...base, capacity: '1.5' }).error, 'capacity');
  assert.equal(L.validateEventForm({ ...base, kind: 'event', capacity: '' }).payload.capacity, null);
  assert.equal(L.validateEventForm({ ...base, server: 'no vale' }).error, 'server');
  assert.equal(L.validateEventForm({ ...base, link: 'http://venus.gg' }).error, 'link');
  assert.equal(L.validateEventForm({ ...base, link: '', server: '' }).payload.link, null);
  assert.equal(L.validateEventForm({ ...base, id: 'abc' }).payload.id, 'abc');
});
