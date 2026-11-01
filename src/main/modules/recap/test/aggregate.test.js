'use strict';
// Pruebas del calculo del resumen (sin Electron): periodos, instancia favorita, mundo o servidor mas jugado,
// cifras de la tarjeta y tolerancia a datos vacios o rotos.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRecap, publicServer, splitDays } = require('../aggregate');

const MIN = 60000;
const HOUR = 60 * MIN;
// Domingo 8 de noviembre de 2026, 20:00 (hora local, como la usa el launcher)
const NOW = new Date(2026, 10, 8, 20, 0, 0).getTime();
const at = (mo, d, h, mi = 0) => new Date(2026, mo - 1, d, h, mi).getTime();
const S = (instanceId, start, minutes, extra = {}) => ({
  instanceId,
  name: extra.name || instanceId,
  mcVersion: extra.mcVersion || '1.21.1',
  loader: extra.loader || 'fabric',
  start,
  end: start + minutes * MIN,
  duration: minutes * MIN,
  crashed: false,
});

const SESSIONS = [
  S('a', at(11, 8, 18), 90, { name: 'Survival viejo' }), // hoy
  S('a', at(11, 7, 21), 60),
  S('b', at(11, 6, 23, 30), 120, { name: 'Create', loader: 'forge', mcVersion: '1.20.1' }), // cruza la medianoche
  S('b', at(11, 2, 10), 30, { name: 'Create', loader: 'forge', mcVersion: '1.20.1' }),
  S('b', at(11, 1, 23), 120, { name: 'Create', loader: 'forge', mcVersion: '1.20.1' }), // empieza antes de la semana
  S('c', at(10, 20, 15), 300, { name: 'Viejo', loader: 'quilt', mcVersion: '1.20.1' }), // instancia borrada
  S('a', at(9, 1, 12), 600),
];
const INSTANCES = [
  { id: 'a', name: 'Mi Survival', mcVersion: '1.21.4', loader: 'fabric', preset: 'iris' },
  { id: 'b', name: 'Create', mcVersion: '1.20.1', loader: 'forge', preset: null },
];
const COLLECTION = { instances: 2, mods: 139, worlds: 3, perInstance: { a: { mods: 87, worlds: 2 }, b: { mods: 52, worlds: 1 } } };
const PLACES = [
  { kind: 'world', instanceId: 'a', instanceName: 'Mi Survival', world: 'Isla', ms: 630 * MIN, days: { '2026-11-08': 80 * MIN, '2026-11-07': 50 * MIN, '2026-09-01': 500 * MIN } },
  { kind: 'world', instanceId: 'b', world: 'Base', ms: 100 * MIN, days: { '2026-11-02': 100 * MIN } },
  { kind: 'server', address: '192.168.0.10:25565', ms: 300 * MIN, days: { '2026-11-07': 300 * MIN } },
  { kind: 'server', address: 'mc.hypixel.net', ms: 200 * MIN, days: { '2026-10-20': 200 * MIN } },
  null,
  { kind: 'world' },
  { kind: 'server', address: '' },
  { kind: 'world', instanceId: 'b', world: 'Corto', ms: 30000, days: { '2026-11-08': 30000 } },
];
const IDS = ['time1', 'time10', 'sessions1', 'streak3'];

function build(over = {}) {
  return buildRecap({
    data: { sessions: SESSIONS, archived: null, milestones: { time1: at(9, 1, 20), sessions1: at(9, 1, 22), bogus: 5 } },
    places: PLACES,
    instances: INSTANCES,
    collection: COLLECTION,
    milestoneIds: IDS,
    now: NOW,
    ...over,
  });
}

test('sin datos: no lanza y no hay nada que mostrar', () => {
  for (const input of [undefined, {}, { data: null, places: null, instances: null, collection: null }, { data: { sessions: 'x', archived: 7, milestones: [] }, places: [1, 'a', null] }]) {
    const r = buildRecap({ ...input, now: NOW });
    assert.equal(r.hasPlaytime, false);
    assert.equal(r.firstPlay, null);
    for (const id of ['week', 'month', 'all']) {
      const p = r.periods[id];
      assert.equal(p.ms, 0);
      assert.equal(p.sessions, 0);
      assert.equal(p.favorite, null);
      assert.equal(p.top, null);
      assert.deepEqual(p.figures, []);
    }
    assert.deepEqual(r.streak, { current: 0, longest: 0, playedToday: false });
  }
});

test('sesiones rotas se ignoran', () => {
  const r = buildRecap({
    data: { sessions: [null, 5, { start: 'x', end: 3 }, { start: 10, end: 5 }, { start: -1, end: 5 }, S('a', at(11, 8, 10), 15)] },
    now: NOW,
  });
  assert.equal(r.hasPlaytime, true);
  assert.equal(r.periods.all.ms, 15 * MIN);
  assert.equal(r.periods.all.sessions, 1);
});

test('esta semana: ultimos 7 dias con hoy incluido, con las sesiones repartidas por dia', () => {
  const w = build().periods.week;
  assert.equal(w.days, 7);
  assert.equal(w.from, at(11, 2, 0));
  assert.equal(w.to, NOW);
  // 90 + 60 + 120 + 30 + 60 (la parte de la sesion del 1 que cae despues de la medianoche)
  assert.equal(w.ms, 360 * MIN);
  // las 4 que empiezan en la semana y la del domingo 1 que siguio despues de medianoche (suma 60 min)
  assert.equal(w.sessions, 5);
  assert.equal(w.daysPlayed, 4); // 2, 6, 7 y 8
  assert.equal(w.longestMs, 120 * MIN);
  assert.equal(w.favorite.id, 'b');
  assert.equal(w.favorite.ms, 210 * MIN);
  assert.equal(w.favorite.sessions, 3);
  assert.equal(w.favorite.name, 'Create');
  assert.equal(w.favorite.loader, 'forge');
  assert.equal(w.favorite.mods, 52);
  assert.equal(w.favorite.exists, true);
});

test('este mes y desde siempre', () => {
  const r = build();
  const m = r.periods.month;
  assert.equal(m.from, at(10, 10, 0));
  assert.equal(m.ms, 720 * MIN);
  assert.equal(m.sessions, 6);
  assert.equal(m.longestMs, 300 * MIN);
  // La favorita del mes es una instancia que ya no existe: nombre, version y loader de su ultima partida
  assert.deepEqual(m.favorite, { id: 'c', name: 'Viejo', mcVersion: '1.20.1', loader: 'quilt', ms: 300 * MIN, sessions: 1, exists: false, mods: null });

  const a = r.periods.all;
  assert.equal(a.ms, 1320 * MIN);
  assert.equal(a.sessions, 7);
  assert.equal(a.from, at(9, 1, 12));
  assert.equal(r.firstPlay, at(9, 1, 12));
  assert.equal(a.daysPlayed, 7);
  // Instancia que existe: nombre actual, version actual e Iris como loader
  assert.equal(a.favorite.id, 'a');
  assert.equal(a.favorite.name, 'Mi Survival');
  assert.equal(a.favorite.mcVersion, '1.21.4');
  assert.equal(a.favorite.loader, 'iris');
  assert.equal(a.favorite.mods, 87);
  assert.equal(a.favorite.ms, 750 * MIN);
  assert.equal(r.hasPlaytime, true);
});

test('rachas: la actual cuenta desde hoy y la mejor de todo el historial', () => {
  const r = build();
  assert.deepEqual(r.streak, { current: 3, longest: 3, playedToday: true });
  // Si hoy no se jugo, la racha sigue viva hasta ayer
  const ayer = buildRecap({ data: { sessions: [S('a', at(11, 7, 10), 20), S('a', at(11, 6, 10), 20)] }, now: NOW });
  assert.deepEqual(ayer.streak, { current: 2, longest: 2, playedToday: false });
  const cortada = buildRecap({ data: { sessions: [S('a', at(11, 5, 10), 20)] }, now: NOW });
  assert.equal(cortada.streak.current, 0);
  assert.equal(cortada.streak.longest, 1);
});

test('mundo o servidor mas jugado por periodo, sin direcciones privadas', () => {
  const r = build();
  assert.deepEqual(r.periods.week.top, { kind: 'world', instanceId: 'a', world: 'Isla', instanceName: 'Mi Survival', ms: 130 * MIN });
  // En el mes gana el servidor publico (la IP de la red local tiene mas tiempo pero no se muestra)
  assert.deepEqual(r.periods.month.top, { kind: 'server', address: 'mc.hypixel.net', ms: 200 * MIN });
  assert.equal(r.periods.all.top.world, 'Isla');
  assert.equal(r.periods.week.worldsVisited, 3);
  assert.equal(r.periods.week.serversVisited, 1);
  assert.equal(r.periods.month.serversVisited, 2);
});

test('cifras de la tarjeta en orden y solo las que tienen sentido', () => {
  const r = build();
  assert.deepEqual(
    r.periods.week.figures.map((f) => f.id),
    ['daysPlayed', 'streak', 'longest', 'worlds', 'servers', 'avg'],
  );
  assert.deepEqual(r.periods.week.figures[0], { id: 'daysPlayed', value: 4, total: 7 });
  assert.deepEqual(r.periods.week.figures[5], { id: 'avg', value: 72 * MIN }); // 360 min en 5 partidas
  assert.deepEqual(
    r.periods.all.figures.map((f) => f.id),
    ['bestStreak', 'longest', 'milestones', 'totalDays', 'avg'],
  );
  assert.deepEqual(r.periods.all.figures[2], { id: 'milestones', value: 2, total: 4 });
  // Con una sola partida corta no hay "partida mas larga" ni promedio (serian el mismo numero)
  const tiny = buildRecap({ data: { sessions: [S('a', at(11, 8, 19), 12)] }, instances: INSTANCES, now: NOW });
  assert.deepEqual(
    tiny.periods.week.figures.map((f) => f.id),
    ['daysPlayed', 'streak'],
  );
  assert.equal(tiny.periods.week.ms, 12 * MIN);
  assert.deepEqual(tiny.periods.all.figures.map((f) => f.id), ['bestStreak', 'totalDays']);
});

test('coleccion: totales de hoy y sin datos de carpetas', () => {
  assert.deepEqual(build().collection, { instances: 2, mods: 139, worlds: 3 });
  assert.deepEqual(build({ collection: null }).collection, { instances: 2, mods: null, worlds: null });
  assert.equal(build({ collection: null }).periods.all.favorite.mods, null);
});

test('las sesiones archivadas cuentan en "desde siempre"', () => {
  const archived = {
    ms: 10 * HOUR,
    sessions: 5,
    firstPlay: at(8, 1, 12),
    longest: { ms: 4 * HOUR },
    days: { '2026-08-01': 10 * HOUR, basura: 5 },
    daySessions: { '2026-08-01': 5 },
    byInstance: { c: { name: 'Viejo', ms: 10 * HOUR, sessions: 5 } },
  };
  const r = build({ data: { sessions: SESSIONS, archived } });
  assert.equal(r.periods.all.ms, 1320 * MIN + 10 * HOUR);
  assert.equal(r.periods.all.sessions, 12);
  assert.equal(r.firstPlay, at(8, 1, 12));
  assert.equal(r.periods.all.daysPlayed, 8);
  // c: 10 h archivadas + 5 h de octubre
  assert.equal(r.periods.all.favorite.id, 'c');
  assert.equal(r.periods.all.favorite.ms, 15 * HOUR);
  assert.equal(r.periods.all.favorite.sessions, 6);
  // La semana no cambia
  assert.equal(r.periods.week.ms, 360 * MIN);
  // Un archivo roto se ignora
  assert.equal(build({ data: { sessions: SESSIONS, archived: { ms: 'x' } } }).periods.all.ms, 1320 * MIN);
});

test('servidores que se pueden mostrar en una imagen publica', () => {
  assert.equal(publicServer('mc.hypixel.net'), 'mc.hypixel.net');
  assert.equal(publicServer('Play.Example.COM:25570'), 'play.example.com');
  assert.equal(publicServer('mc.example.org.'), 'mc.example.org');
  for (const bad of ['192.168.0.10', '10.0.0.1:25565', '[::1]:25565', 'fe80::1', 'localhost', 'mi-pc.local', 'abc.e4mc.link', 'bore.pub:4242', 'x.playit.gg', 'casa', '', null, 'a'.repeat(300), 'mal host.com', 'micasa.duckdns.org', 'server.ddns.net:25565', 'x.no-ip.biz', 'mc.hopto.org']) {
    assert.equal(publicServer(bad), null, String(bad));
  }
});

test('reparto por dias: igual que core/stats (y un reloj roto va entero a su dia)', () => {
  const parts = [];
  splitDays(at(11, 6, 23, 30), at(11, 7, 1, 30), (k, ms) => parts.push([k, ms / MIN]));
  assert.deepEqual(parts, [
    ['2026-11-06', 30],
    ['2026-11-07', 90],
  ]);
  const broken = [];
  splitDays(at(9, 1, 0), at(9, 1, 0) + 40 * 24 * HOUR, (k, ms) => broken.push([k, ms]));
  assert.deepEqual(broken, [['2026-09-01', 40 * 24 * HOUR]]);
});
