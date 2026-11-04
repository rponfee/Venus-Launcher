'use strict';
// Reglas del modo familia: topes con cambio de dia, horario, avisos y lista de servidores.
const test = require('node:test');
const assert = require('node:assert/strict');
const logic = require('../logic');

const { MIN, WARN_MS, COUNTDOWN_MS } = logic;
const at = (d, h, m = 0, s = 0) => new Date(2026, 10, d, h, m, s).getTime();
const cfgOf = (raw) => logic.normalizeConfig(raw);

// Juega de a 30 s entre dos momentos
function play(usage, from, to, playing = true) {
  for (let t = from; t <= to; t += 30000) logic.advance(usage, t, playing);
  return usage;
}

test('normalizeConfig: valores raros vuelven a lo seguro', () => {
  const c = cfgOf({ limitMin: -5, schedule: { enabled: 'si', from: '99:00', to: '7:30' }, servers: { enabled: true, list: ['Play.Example.COM', 'play.example.com', 'bad host', 'x:99999', 'b.net:25566'] } });
  assert.equal(c.limitMin, 0);
  assert.equal(c.schedule.enabled, false);
  assert.equal(c.schedule.from, '08:00');
  assert.equal(c.schedule.to, '07:30');
  assert.deepEqual(c.servers.list, ['play.example.com', 'b.net:25566']);
  assert.equal(cfgOf({ limitMin: 99999 }).limitMin, 24 * 60);
  assert.equal(cfgOf(null).servers.enabled, false);
});

test('tiempo jugado: suma solo mientras se juega', () => {
  const start = at(3, 15);
  const u = logic.createUsage(null, start);
  play(u, start, start + 10 * MIN);
  assert.equal(u.usedMs, 10 * MIN);
  play(u, start + 10 * MIN, start + 20 * MIN, false);
  assert.equal(u.usedMs, 10 * MIN);
});

test('cambio de día: lo jugado antes de medianoche es de ayer y el tope vuelve a cero', () => {
  const start = at(3, 23, 50);
  const u = logic.createUsage({ day: logic.dayKey(start), usedMs: 60 * MIN }, start);
  assert.equal(u.usedMs, 60 * MIN);
  play(u, start, at(3, 23, 59, 30));
  assert.equal(u.day, logic.dayKey(start));
  assert.equal(u.usedMs, 60 * MIN + 9.5 * MIN);
  logic.advance(u, at(4, 0, 0, 30), true);
  assert.equal(u.day, logic.dayKey(at(4, 0)));
  assert.equal(u.usedMs, 30000, 'solo los 30 s después de medianoche');
  play(u, at(4, 0, 1), at(4, 0, 10));
  assert.equal(u.usedMs, 10 * MIN);
});

test('cambio de día con el launcher cerrado: lo guardado de ayer no cuenta', () => {
  const u = logic.createUsage({ day: logic.dayKey(at(3, 20)), usedMs: 100 * MIN, extendUntil: at(3, 21) }, at(4, 10));
  assert.equal(u.usedMs, 0);
  assert.equal(u.extendUntil, 0);
});

test('reloj atrasado o PC suspendida no suman ni restan', () => {
  const start = at(3, 15);
  const u = logic.createUsage(null, start);
  logic.advance(u, start + 60000, true);
  logic.advance(u, start + 3 * 60 * MIN, true);
  assert.equal(u.usedMs, 60000, 'una suspensión larga no cuenta');
  logic.advance(u, start, true);
  assert.equal(u.usedMs, 60000, 'reloj hacia atrás');
});

test('horario simple y uno que cruza medianoche', () => {
  const day = { enabled: true, from: '16:00', to: '20:00' };
  assert.equal(logic.allowedNow(day, at(3, 15, 59)), false);
  assert.equal(logic.allowedNow(day, at(3, 16, 0)), true);
  assert.equal(logic.allowedNow(day, at(3, 19, 59)), true);
  assert.equal(logic.allowedNow(day, at(3, 20, 0)), false);
  assert.equal(logic.windowInfo(day, at(3, 19, 30)).msLeft, 30 * MIN);
  assert.equal(logic.windowInfo(day, at(3, 10)).opensAt, at(3, 16));
  assert.equal(logic.windowInfo(day, at(3, 21)).opensAt, at(4, 16));

  const night = { enabled: true, from: '22:00', to: '02:00' };
  assert.equal(logic.allowedNow(night, at(3, 23)), true);
  assert.equal(logic.allowedNow(night, at(4, 1, 59)), true);
  assert.equal(logic.allowedNow(night, at(4, 2)), false);
  assert.equal(logic.allowedNow(night, at(4, 21, 59)), false);
  assert.equal(logic.windowInfo(night, at(3, 23)).msLeft, 3 * 60 * MIN);
  assert.equal(logic.windowInfo(night, at(4, 1)).msLeft, 60 * MIN);
  assert.equal(logic.windowInfo(night, at(4, 3)).opensAt, at(4, 22));

  assert.equal(logic.allowedNow({ enabled: false, from: '10:00', to: '11:00' }, at(3, 3)), true);
  assert.equal(logic.windowInfo({ enabled: true, from: '10:00', to: '10:00' }, at(3, 3)).msLeft, Infinity, 'igual = todo el día');
});

test('remaining: gana lo que se agote primero', () => {
  const now = at(3, 19, 30);
  const u = logic.createUsage(null, now);
  u.usedMs = 50 * MIN;
  const both = cfgOf({ limitMin: 60, schedule: { enabled: true, from: '16:00', to: '20:00' } });
  assert.deepEqual(logic.remaining(u, both, now), { ms: 10 * MIN, reason: 'limit' });
  u.usedMs = 0;
  assert.deepEqual(logic.remaining(u, both, now), { ms: 30 * MIN, reason: 'schedule' });
  const free = cfgOf({});
  assert.equal(logic.remaining(u, free, now).ms, Infinity);
});

test('con el tope pasado el motivo sigue siendo el tope, no una extensión que no existe', () => {
  const now = at(3, 15);
  const u = logic.createUsage(null, now);
  u.usedMs = 61 * MIN;
  assert.deepEqual(logic.remaining(u, cfgOf({ limitMin: 60 }), now), { ms: 0, reason: 'limit' });
  assert.equal(logic.canLaunch(u, cfgOf({ limitMin: 60 }), now).reason, 'limit');
  const s = logic.createTickState();
  assert.equal(logic.tick(s, u, cfgOf({ limitMin: 60 }), { now, playing: true })[0].reason, 'limit');
});

test('el tope no avisa por algo que la medianoche va a resolver', () => {
  const now = at(3, 23, 55);
  const u = logic.createUsage(null, now);
  u.usedMs = 50 * MIN; // quedan 10 min de tope y faltan 5 para medianoche
  const r = logic.remaining(u, cfgOf({ limitMin: 60 }), now);
  assert.ok(r.ms > WARN_MS);
});

test('extender con PIN corre el tope y el horario, y se puede sumar', () => {
  const now = at(3, 21);
  const u = logic.createUsage(null, now);
  const cfg = cfgOf({ limitMin: 30, schedule: { enabled: true, from: '16:00', to: '20:00' } });
  u.usedMs = 40 * MIN;
  assert.equal(logic.remaining(u, cfg, now).ms, 0);
  assert.equal(logic.canLaunch(u, cfg, now).ok, false);
  u.extendUntil = now + 30 * MIN;
  const r = logic.remaining(u, cfg, now);
  assert.equal(r.ms, 30 * MIN);
  assert.equal(r.reason, 'extended');
  assert.equal(logic.canLaunch(u, cfg, now).ok, true);
  assert.equal(logic.remaining(u, cfg, now + 31 * MIN).ms, 0, 'se termina sola');
});

test('no se deja lanzar fuera de horario ni con el tope agotado', () => {
  const now = at(3, 21);
  const u = logic.createUsage(null, now);
  const sched = logic.canLaunch(u, cfgOf({ schedule: { enabled: true, from: '16:00', to: '20:00' } }), now);
  assert.equal(sched.ok, false);
  assert.equal(sched.reason, 'schedule');
  assert.equal(sched.opensAt, at(4, 16));
  u.usedMs = 60 * MIN;
  const lim = logic.canLaunch(u, cfgOf({ limitMin: 60 }), now);
  assert.equal(lim.ok, false);
  assert.equal(lim.reason, 'limit');
  assert.equal(logic.canLaunch(logic.createUsage(null, now), cfgOf({}), now).ok, true);
});

test('avisos: 10 minutos, cuenta regresiva de 60 s y cierre', () => {
  const cfg = cfgOf({ limitMin: 30 });
  const start = at(3, 15);
  const u = logic.createUsage(null, start);
  const s = logic.createTickState();
  const seen = [];
  let t = start;
  for (; t <= start + 32 * MIN; t += 5000) {
    logic.advance(u, t, true);
    for (const ev of logic.tick(s, u, cfg, { now: t, playing: true })) seen.push({ ...ev, at: t - start });
  }
  assert.deepEqual(seen.map((e) => e.type), ['warn', 'countdown', 'close'], 'cada aviso una sola vez');
  assert.equal(seen[0].at, 20 * MIN);
  assert.equal(seen[0].minutes, 10);
  assert.equal(seen[1].at, 30 * MIN);
  assert.equal(seen[1].reason, 'limit');
  assert.equal(seen[2].at, 30 * MIN + COUNTDOWN_MS);
  assert.equal(s.phase, 'closing');
});

test('avisos: entrar con poco tiempo avisa enseguida y extender cancela la cuenta', () => {
  const cfg = cfgOf({ limitMin: 30 });
  const start = at(3, 15);
  const u = logic.createUsage(null, start);
  u.usedMs = 25 * MIN;
  const s = logic.createTickState();
  assert.deepEqual(logic.tick(s, u, cfg, { now: start, playing: true }).map((e) => e.type), ['warn']);
  u.usedMs = 30 * MIN;
  assert.deepEqual(logic.tick(s, u, cfg, { now: start + 1000, playing: true }).map((e) => e.type), ['countdown']);
  u.extendUntil = start + 60 * MIN;
  assert.deepEqual(logic.tick(s, u, cfg, { now: start + 2000, playing: true }).map((e) => e.type), ['cancelled']);
  assert.equal(s.phase, 'idle');
  assert.deepEqual(logic.tick(s, u, cfg, { now: start + 3000, playing: true }), []);
});

test('avisos: cerrar el juego durante la cuenta la cancela', () => {
  const cfg = cfgOf({ limitMin: 30 });
  const start = at(3, 15);
  const u = logic.createUsage(null, start);
  u.usedMs = 30 * MIN;
  const s = logic.createTickState();
  logic.tick(s, u, cfg, { now: start, playing: true });
  assert.deepEqual(logic.tick(s, u, cfg, { now: start + 1000, playing: false }).map((e) => e.type), ['cancelled']);
  assert.equal(s.phase, 'idle');
});

test('la medianoche durante la cuenta regresiva la cancela: el tope volvió a cero', () => {
  const cfg = cfgOf({ limitMin: 30 });
  const before = at(3, 23, 59, 30);
  const u = logic.createUsage(null, before);
  u.usedMs = 30 * MIN;
  const s = logic.createTickState();
  assert.equal(logic.tick(s, u, cfg, { now: before, playing: true })[0].type, 'countdown');
  const after = at(4, 0, 0, 5);
  logic.advance(u, after, true);
  assert.deepEqual(logic.tick(s, u, cfg, { now: after, playing: true }).map((e) => e.type), ['cancelled']);
});

test('parseConnect: solo el mensaje del juego, no el chat', () => {
  assert.deepEqual(logic.parseConnect('[18:03:11] [Render thread/INFO]: Connecting to mc.Example.net, 25565'), { host: 'mc.example.net', port: 25565 });
  assert.deepEqual(logic.parseConnect('[Client thread/INFO]: Connecting to 10.0.0.2, 25570'), { host: '10.0.0.2', port: 25570 });
  assert.deepEqual(logic.parseConnect('Connecting to play.example.com., 25565'), { host: 'play.example.com', port: 25565 });
  assert.equal(logic.parseConnect('[18:03:11] [Render thread/INFO]: [CHAT] Connecting to evil.example, 25565'), null);
  assert.equal(logic.parseConnect('[18:03:11] [Render thread/INFO]: [System] [CHAT] <Bob> Connecting to evil.example, 25565'), null);
  assert.equal(logic.parseConnect('[18:03:11] [Render thread/INFO]: <Bob> Connecting to evil.example, 25565'), null);
  assert.equal(logic.parseConnect('[18:03:11] [main/INFO]: Connecting to evil.example, 99999'), null);
  assert.equal(logic.parseConnect('Stopping server'), null);
  assert.equal(logic.parseConnect(null), null);
});

test('serverAllowed: mayúsculas, puertos y subdominios', () => {
  const list = ['play.example.com', 'b.net:25566', '*.hypixel.net'];
  assert.equal(logic.serverAllowed(list, 'PLAY.example.com'), true);
  assert.equal(logic.serverAllowed(list, 'play.example.com:1234'), true, 'sin puerto en la lista vale cualquiera');
  assert.equal(logic.serverAllowed(list, 'play.example.com.'), true);
  assert.equal(logic.serverAllowed(list, 'b.net:25566'), true);
  assert.equal(logic.serverAllowed(list, 'b.net'), false, 'es otro puerto');
  assert.equal(logic.serverAllowed(list, 'mc.hypixel.net'), true);
  assert.equal(logic.serverAllowed(list, 'hypixel.net'), false, '*. pide un subdominio');
  assert.equal(logic.serverAllowed(list, 'evilhypixel.net'), false);
  assert.equal(logic.serverAllowed(list, 'play.example.com.evil.net'), false);
  assert.equal(logic.serverAllowed(list, { host: 'b.net', port: 25566 }), true);
  assert.equal(logic.serverAllowed([], 'a.com'), false, 'lista vacía: ninguno');
  assert.equal(logic.serverAllowed(list, ''), false);
  assert.equal(logic.serverAllowed(['[::1]:25565'], '[::1]:25565'), true);
});
