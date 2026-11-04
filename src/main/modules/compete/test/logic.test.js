'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { weekKey, weekStartMs, mergeIntervals, playedByWeek, totalsOf, diffTotals, buildReports, firstSnapshot, MINUTE, DAY } = require('../logic');

const at = (s) => Date.parse(s);
// 2026-11-02 es lunes
const MON = at('2026-11-02T00:00:00Z');

test('la semana va de lunes a domingo en UTC', () => {
  assert.equal(weekKey(at('2026-11-02T00:00:00Z')), '2026-11-02');
  assert.equal(weekKey(at('2026-11-05T12:00:00Z')), '2026-11-02');
  assert.equal(weekKey(at('2026-11-08T23:59:59Z')), '2026-11-02');
  assert.equal(weekKey(at('2026-11-09T00:00:00Z')), '2026-11-09');
  assert.equal(weekKey(at('2026-11-01T23:59:59Z')), '2026-10-26');
  // Domingo por la noche en Argentina ya es lunes en UTC
  assert.equal(weekKey(at('2026-11-08T22:30:00-03:00')), '2026-11-09');
  // Cruce de año y de febrero
  assert.equal(weekKey(at('2027-01-01T10:00:00Z')), '2026-12-28');
  assert.equal(weekKey(at('2028-03-01T10:00:00Z')), '2028-02-28');
  assert.equal(weekStartMs(at('2026-11-05T12:00:00Z')), MON);
});

test('dos instancias abiertas a la vez no cuentan doble', () => {
  const merged = mergeIntervals([{ start: 100, end: 300 }, { start: 200, end: 400 }, { start: 500, end: 600 }, { start: 'x', end: 700 }], 0, 1000);
  assert.deepEqual(merged, [[100, 400], [500, 600]]);
  assert.deepEqual(mergeIntervals([{ start: 100, end: 300 }], 200, 250), [[200, 250]]);
  assert.deepEqual(mergeIntervals(null, 0, 10), []);
});

test('los minutos se cuentan desde el cursor y lo que sobra queda para el próximo envío', () => {
  const start = MON + 3 * DAY;
  const sessions = [{ start, end: start + 90.5 * MINUTE }];
  const [first] = playedByWeek(sessions, start - DAY, start + DAY);
  assert.equal(first.week, '2026-11-02');
  assert.equal(first.minutes, 90);
  assert.equal(first.cursor, start + 90 * MINUTE);
  // Lo mismo después: quedan 30 segundos, que no llegan a un minuto
  const [second] = playedByWeek(sessions, first.cursor, start + DAY);
  assert.equal(second.minutes, 0);
  assert.equal(second.ms, 0.5 * MINUTE);
  assert.equal(second.cursor, first.cursor);
  // Una partida vieja no se cuenta de nuevo
  assert.deepEqual(playedByWeek(sessions, start + 91 * MINUTE, start + DAY), []);
});

test('una partida que cruza la medianoche del domingo se reparte entre las dos semanas', () => {
  const sunday = at('2026-11-08T23:30:00Z');
  const sessions = [{ start: sunday, end: sunday + 60 * MINUTE }];
  const list = playedByWeek(sessions, sunday - MINUTE, sunday + 2 * 60 * MINUTE);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((x) => [x.week, x.minutes]), [['2026-11-02', 30], ['2026-11-09', 30]]);
  assert.equal(list[0].cursor, at('2026-11-09T00:00:00Z'));
  assert.equal(list[1].cursor, sunday + 60 * MINUTE);
});

test('las estadísticas se toman de lo minado y de custom', () => {
  const totals = totalsOf({
    custom: { 'minecraft:mob_kills': 12, 'minecraft:deaths': 3, 'minecraft:play_time': 2400 },
    mined: { 'minecraft:stone': 100, 'minecraft:diamond_ore': 2, 'minecraft:deepslate_diamond_ore': 3 },
  });
  assert.deepEqual(totals, { diamonds: 5, mobs: 12, blocks: 105, deaths: 3, play: 2400 });
  assert.deepEqual(totalsOf(null), { diamonds: 0, mobs: 0, blocks: 0, deaths: 0, play: 0 });
});

test('la diferencia nunca es negativa: un valor que bajó es el nuevo punto de partida', () => {
  const prev = { diamonds: 10, mobs: 5, blocks: 100, deaths: 1, play: 1200 };
  assert.deepEqual(diffTotals(prev, { diamonds: 12, mobs: 5, blocks: 130, deaths: 2, play: 2400 }), { diamonds: 2, mobs: 0, blocks: 30, deaths: 1, ms: 60000 });
  assert.deepEqual(diffTotals(prev, { diamonds: 0, mobs: 0, blocks: 0, deaths: 0, play: 0 }), { diamonds: 0, mobs: 0, blocks: 0, deaths: 0, ms: 0 });
  assert.deepEqual(diffTotals(undefined, { diamonds: 1, mobs: 2, blocks: 3, deaths: 4, play: 20 }), { diamonds: 1, mobs: 2, blocks: 3, deaths: 4, ms: 1000 });
});

const file = (key, mtimeMs, totals) => ({ key, mtimeMs, size: 10, totals: { diamonds: 0, mobs: 0, blocks: 0, deaths: 0, play: 0, ...totals } });

test('buildReports manda la diferencia contra el último envío', () => {
  const now = MON + 3 * DAY;
  const cursor = now - 60 * MINUTE;
  const out = buildReports({
    baseline: { a: { mtimeMs: 1, size: 1, diamonds: 2, mobs: 1, blocks: 10, deaths: 0, play: 0 } },
    scanned: [{ key: 'z', unchanged: true }, file('a', now - MINUTE, { diamonds: 5, mobs: 4, blocks: 40, deaths: 1, play: 20 * 60 * 30 })],
    sessions: [{ start: now - 30 * MINUTE, end: now }],
    cursor,
    now,
  });
  assert.equal(out.reports.length, 1);
  const r = out.reports[0];
  assert.deepEqual([r.week, r.minutes, r.diamonds, r.mobs, r.blocks, r.deaths], ['2026-11-02', 30, 3, 3, 30, 1]);
  assert.equal(r.files.a.diamonds, 5);
  assert.deepEqual(out.silent, {});
  assert.equal(out.cursor, null);
});

test('sin cambios no hay nada para enviar', () => {
  const now = MON + 3 * DAY;
  const out = buildReports({ baseline: {}, scanned: [{ key: 'a', unchanged: true }], sessions: [], cursor: now - DAY, now });
  assert.deepEqual(out.reports, []);
});

test('un mundo importado o duplicado no se envía: es el nuevo punto de partida', () => {
  const now = MON + 3 * DAY;
  // 50 horas de juego en el archivo y 10 minutos jugados en el launcher
  const out = buildReports({
    baseline: {},
    scanned: [file('copia', now - MINUTE, { diamonds: 500, blocks: 90000, play: 50 * 3600 * 20 })],
    sessions: [{ start: now - 10 * MINUTE, end: now }],
    cursor: now - 20 * MINUTE,
    now,
  });
  assert.equal(out.reports[0].minutes, 10);
  assert.equal(out.reports[0].diamonds, 0);
  assert.equal(out.silent.copia.diamonds, 500);
});

test('un mundo nuevo de verdad sí se envía', () => {
  const now = MON + 3 * DAY;
  const out = buildReports({
    baseline: {},
    scanned: [file('nuevo', now - MINUTE, { diamonds: 1, blocks: 200, play: 30 * 60 * 20 })],
    sessions: [{ start: now - 30 * MINUTE, end: now }],
    cursor: now - 40 * MINUTE,
    now,
  });
  assert.equal(out.reports[0].diamonds, 1);
  assert.equal(out.reports[0].blocks, 200);
});

test('cambio de semana: cada archivo y cada partida van a la semana en que pasaron', () => {
  const now = at('2026-11-09T00:10:00Z'); // lunes recién empezado
  const out = buildReports({
    baseline: { viejo: { mtimeMs: 1, size: 1, diamonds: 0, mobs: 0, blocks: 0, deaths: 0, play: 0 }, nuevo: { mtimeMs: 1, size: 1, diamonds: 0, mobs: 0, blocks: 0, deaths: 0, play: 0 } },
    scanned: [
      file('viejo', at('2026-11-08T23:50:00Z'), { diamonds: 2, play: 20 * 60 * 20 }),
      file('nuevo', at('2026-11-09T00:05:00Z'), { diamonds: 3, play: 5 * 60 * 20 }),
    ],
    sessions: [{ start: at('2026-11-08T23:40:00Z'), end: at('2026-11-09T00:06:00Z') }],
    cursor: at('2026-11-08T23:00:00Z'),
    now,
  });
  assert.deepEqual(out.reports.map((r) => [r.week, r.minutes, r.diamonds]), [['2026-11-02', 20, 2], ['2026-11-09', 6, 3]]);
  assert.equal(out.reports[0].cursor, at('2026-11-09T00:00:00Z'));
  assert.equal(out.reports[1].cursor, at('2026-11-09T00:06:00Z'));
});

test('lo de hace más de una semana no se envía: el servidor no lo aceptaría', () => {
  const now = at('2026-11-20T12:00:00Z'); // semana del 16
  const oldStart = at('2026-11-03T10:00:00Z'); // semana del 2: ya no es ni la anterior
  const out = buildReports({
    baseline: {},
    scanned: [file('a', oldStart + 30 * MINUTE, { diamonds: 4, play: 30 * 60 * 20 })],
    sessions: [{ start: oldStart, end: oldStart + 30 * MINUTE }],
    cursor: oldStart - DAY,
    now,
  });
  assert.deepEqual(out.reports, []);
  assert.equal(out.silent.a.diamonds, 4);
  assert.equal(out.cursor, at('2026-11-09T00:00:00Z'));
});

test('una fecha adelantada del archivo no manda a una semana futura', () => {
  const now = at('2026-11-08T23:00:00Z');
  const out = buildReports({
    baseline: {},
    scanned: [file('a', at('2026-12-25T00:00:00Z'), { diamonds: 1, play: 1 })],
    sessions: [],
    cursor: now - DAY,
    now,
  });
  assert.equal(out.reports[0].week, '2026-11-02');
});

test('la foto inicial anota todo sin mandar nada', () => {
  const snap = firstSnapshot([{ key: 'b', unchanged: true }, file('a', 5, { diamonds: 7 })]);
  assert.deepEqual(Object.keys(snap), ['a']);
  assert.equal(snap.a.diamonds, 7);
  assert.equal(snap.a.mtimeMs, 5);
});
