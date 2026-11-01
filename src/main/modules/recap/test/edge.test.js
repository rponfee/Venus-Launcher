'use strict';
// Casos borde del resumen (sin Electron): partidas que cruzan el comienzo del periodo, relojes rotos,
// direcciones con forma de IP y el cambio de horario de verano.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildRecap, publicServer } = require('../aggregate');

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// Domingo 8 de noviembre de 2026, 20:00: "esta semana" empieza el lunes 2 a las 00:00
const NOW = new Date(2026, 10, 8, 20, 0, 0).getTime();
const at = (mo, d, h, mi = 0) => new Date(2026, mo - 1, d, h, mi).getTime();
const S = (instanceId, start, minutes) => ({ instanceId, name: instanceId, mcVersion: '1.21.1', loader: 'fabric', start, end: start + minutes * MIN });

test('una partida que empezo antes del periodo y termino adentro cuenta como partida del periodo', () => {
  // Domingo 1 a las 23:00 hasta el lunes 2 a la 01:00: una hora cae en la semana
  const r = buildRecap({ data: { sessions: [S('a', at(11, 1, 23), 120)] }, now: NOW });
  const w = r.periods.week;
  assert.equal(w.ms, HOUR);
  // Nunca "1 h de juego en 0 partidas"
  assert.equal(w.sessions, 1);
  assert.equal(w.favorite.ms, HOUR);
  assert.equal(w.favorite.sessions, 1);
  assert.equal(r.periods.all.sessions, 1);
  assert.equal(r.periods.all.ms, 2 * HOUR);
});

test('con tiempo en el periodo siempre hay al menos una partida', () => {
  const sessions = [S('a', at(10, 9, 22), 180), S('b', at(11, 1, 23, 30), 90), S('a', at(10, 31, 23), 300)];
  const r = buildRecap({ data: { sessions }, now: NOW });
  for (const id of ['week', 'month', 'all']) {
    const p = r.periods[id];
    if (p.ms > 0) assert.ok(p.sessions >= 1, `${id}: ${p.ms} ms en ${p.sessions} partidas`);
    if (p.favorite) assert.ok(p.favorite.ms <= p.ms, `${id}: la favorita no puede tener mas tiempo que el periodo`);
  }
});

test('una partida con el reloj roto (mas de 30 dias) va entera a su dia, tambien para la favorita', () => {
  const broken = { instanceId: 'rota', name: 'Rota', start: at(9, 20, 12), end: at(9, 20, 12) + 40 * DAY };
  const r = buildRecap({ data: { sessions: [broken, S('a', at(11, 8, 10), 30)] }, now: NOW });
  // El tiempo de la semana no incluye la partida rota (empezo hace mas de 7 dias)...
  assert.equal(r.periods.week.ms, 30 * MIN);
  // ...asi que tampoco puede ser la favorita de la semana ni sumar partidas
  assert.equal(r.periods.week.favorite.id, 'a');
  assert.equal(r.periods.week.sessions, 1);
  assert.ok(r.periods.month.favorite.ms <= r.periods.month.ms);
});

test('direcciones con forma de IP no se muestran aunque no tengan cuatro partes', () => {
  for (const bad of ['10.1.5', '127.1', '1.2.3:25565', '0x7f.1', '192.168.0.1.', '1.2.3.4.5']) assert.equal(publicServer(bad), null, bad);
  assert.equal(publicServer('play.2b2t.org'), 'play.2b2t.org');
  assert.equal(publicServer('mc.server123.net:25566'), 'mc.server123.net');
});

test('cambio de horario (fin del horario de verano en Nueva York, 1 de noviembre de 2026)', () => {
  // Otro proceso con TZ fija: la zona horaria se lee al arrancar
  const script = `
    const { buildRecap } = require(${JSON.stringify(path.join(__dirname, '..', 'aggregate.js'))});
    const now = new Date(2026, 10, 1, 20, 0, 0).getTime();
    const start = new Date(2026, 10, 1, 0, 30).getTime(); // 00:30 EDT
    const end = new Date(2026, 10, 1, 3, 30).getTime(); // 03:30 EST: 4 horas reales
    const prev = new Date(2026, 9, 26, 10, 0).getTime(); // lunes 26 (primer dia de la semana)
    const r = buildRecap({ data: { sessions: [
      { instanceId: 'a', name: 'A', start: prev, end: prev + 3600000 },
      { instanceId: 'a', name: 'A', start, end },
    ] }, now });
    process.stdout.write(JSON.stringify({ off: new Date(start).getTimezoneOffset() - new Date(end).getTimezoneOffset(), from: r.periods.week.from, fromLocal: new Date(r.periods.week.from).toString(), ms: r.periods.week.ms, sessions: r.periods.week.sessions, days: r.periods.week.daysPlayed, streak: r.streak }));
  `;
  const out = JSON.parse(execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8' }));
  assert.equal(out.off, -60, 'la prueba tiene que cruzar el cambio de hora');
  assert.match(out.fromLocal, /^Mon Oct 26 2026 00:00:00/);
  assert.equal(out.ms, 5 * HOUR);
  assert.equal(out.sessions, 2);
  assert.equal(out.days, 2);
  assert.deepEqual(out.streak, { current: 1, longest: 1, playedToday: true });
});
