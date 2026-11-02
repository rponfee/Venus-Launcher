// Límites y transiciones de los Avisos. node --test "src/renderer/js/features/party/test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';
import * as N from '../notify-logic.js';

const T0 = 1_700_000_000_000;
const server = (address, extra = {}) => ({ type: 'server', address, mcVersion: '1.21.1', ...extra });

test('ajustes: valores por defecto y saneados', () => {
  const c = N.readNotify(undefined);
  assert.deepEqual(c, { ...N.NOTIFY_DEFAULTS, muted: [], watch: [] });
  const d = N.readNotify({ friendServers: 'no', serverFull: true, muted: ['a', 'a', '../x', 5], watch: ['Play.X.net', { address: 'play.x.net:25565' }, { address: 'bad host' }] });
  assert.equal(d.friendServers, true, 'un valor que no es booleano se ignora');
  assert.equal(d.serverFull, true);
  assert.deepEqual(d.muted, ['a']);
  assert.deepEqual(d.watch, [{ address: 'play.x.net', name: '' }]);
});

test('actividad: entra a un servidor o a un mundo nuevo', () => {
  assert.deepEqual(N.activityChange(null, server('mc.hypixel.net')), { kind: 'server', address: 'mc.hypixel.net' });
  assert.deepEqual(N.activityChange({ type: 'menu' }, server('mc.hypixel.net')), { kind: 'server', address: 'mc.hypixel.net' });
  assert.equal(N.activityChange(server('mc.hypixel.net'), server('MC.hypixel.net:25565')), null, 'mismo servidor');
  assert.deepEqual(N.activityChange(server('a.net'), server('b.net')), { kind: 'server', address: 'b.net' });
  assert.equal(N.activityChange(null, { type: 'server' }), null, 'servidor sin dirección (privada o local)');
  assert.deepEqual(N.activityChange({ type: 'menu' }, { type: 'singleplayer', world: 'Isla' }), { kind: 'world', world: 'Isla' });
  assert.equal(N.activityChange({ type: 'singleplayer', world: 'Isla' }, { type: 'singleplayer', world: 'Isla' }), null);
  assert.equal(N.activityChange(server('a.net'), { type: 'menu' }), null, 'volver al menú no avisa');
  assert.equal(N.activityChange(server('a.net'), null), null);
});

test('seguimiento: la primera vez que se ve a un amigo solo se anota', () => {
  const tr = N.createActivityTracker();
  assert.equal(tr.update('u1', server('a.net'), 'online'), null, 'ya estaba jugando al abrir el launcher');
  assert.equal(tr.update('u1', server('a.net'), 'online'), null);
  assert.deepEqual(tr.update('u1', server('b.net'), 'online'), { kind: 'server', address: 'b.net' });
  assert.equal(tr.update('u1', server('b.net'), 'offline'), null, 'se desconectó');
  assert.deepEqual(tr.update('u1', server('b.net'), 'online'), { kind: 'server', address: 'b.net' }, 'volvió y entró de nuevo');
  tr.clear();
  assert.equal(tr.size, 0);
  assert.equal(tr.update('u1', server('c.net'), 'online'), null);
});

test('seguimiento: sembrar al arrancar no pisa lo que ya se vio', () => {
  const tr = N.createActivityTracker();
  tr.seed('u1', server('a.net'), 'online');
  assert.equal(tr.has('u1'), true);
  assert.deepEqual(tr.update('u1', server('b.net'), 'online'), { kind: 'server', address: 'b.net' }, 'el primer cambio después de sembrar sí avisa');
  tr.seed('u1', server('z.net'), 'online');
  assert.equal(tr.update('u1', server('b.net'), 'online'), null, 'sembrar a alguien conocido no cambia nada');
});

test('límite: un aviso por amigo cada 10 minutos', () => {
  const lim = N.createLimiter(N.FRIEND_COOLDOWN_MS);
  assert.equal(lim.allow('u1', T0), true);
  assert.equal(lim.allow('u1', T0 + 9 * 60_000), false);
  assert.equal(lim.allow('u2', T0 + 1000), true, 'otro amigo');
  assert.equal(lim.peek('u1', T0 + 10 * 60_000), true);
  assert.equal(lim.allow('u1', T0 + 10 * 60_000), true);
  lim.reset('u1');
  assert.equal(lim.allow('u1', T0 + 10 * 60_000 + 1), true);
});

test('silenciados y tipos apagados', () => {
  const c = N.readNotify({ muted: ['u1'], friendWorlds: false });
  assert.equal(N.friendEventAllowed({ kind: 'server', address: 'a.net' }, c, 'u1'), false);
  assert.equal(N.friendEventAllowed({ kind: 'server', address: 'a.net' }, c, 'u2'), true);
  assert.equal(N.friendEventAllowed({ kind: 'world', world: 'x' }, c, 'u2'), false);
  assert.equal(N.friendEventAllowed(null, c, 'u2'), false);
});

test('entrega: silencio en el launcher mientras se juega, salvo el overlay', () => {
  const c = N.readNotify({});
  assert.deepEqual(N.deliveryFor(c, { playing: false }), { toast: true, overlay: true });
  assert.deepEqual(N.deliveryFor(c, { playing: true }), { toast: false, overlay: true });
  assert.deepEqual(N.deliveryFor(N.readNotify({ quietWhilePlaying: false }), { playing: true }), { toast: true, overlay: true });
  assert.deepEqual(N.deliveryFor(N.readNotify({ overlay: false }), { playing: true }), { toast: false, overlay: false });
});

test('servidores: el primer resultado solo se anota', () => {
  const on = N.nextServerState(undefined, { online: true, players: { online: 3, max: 10 } });
  assert.deepEqual(on, { state: { online: true, fails: 0, players: 3, max: 10 }, events: [] });
  const off = N.nextServerState(undefined, { online: false });
  assert.deepEqual(off.events, []);
  assert.equal(off.state.online, null);
});

test('servidores: un ping perdido no cuenta como caído; dos sí, y al volver avisa', () => {
  let s = N.nextServerState(undefined, { online: true, players: { online: 3, max: 10 } }).state;
  let r = N.nextServerState(s, { online: false });
  assert.equal(r.state.online, true, 'un solo fallo');
  r = N.nextServerState(r.state, { online: true, players: { online: 3, max: 10 } });
  assert.deepEqual(r.events, [], 'volvió enseguida: sin aviso');
  r = N.nextServerState(r.state, { online: false });
  r = N.nextServerState(r.state, { online: false });
  assert.equal(r.state.online, false, 'dos fallos seguidos');
  r = N.nextServerState(r.state, { online: true, players: { online: 0, max: 10 } });
  assert.deepEqual(r.events, ['online']);
  // caído desde el arranque: al aparecer también avisa
  s = N.nextServerState(undefined, { online: false }).state;
  s = N.nextServerState(s, { online: false }).state;
  assert.deepEqual(N.nextServerState(s, { online: true, players: { online: 1, max: 5 } }).events, ['online']);
});

test('servidores: se llena y se vacía', () => {
  let s = N.nextServerState(undefined, { online: true, players: { online: 9, max: 10 } }).state;
  let r = N.nextServerState(s, { online: true, players: { online: 10, max: 10 } });
  assert.deepEqual(r.events, ['full']);
  r = N.nextServerState(r.state, { online: true, players: { online: 10, max: 10 } });
  assert.deepEqual(r.events, [], 'sigue lleno: no repite');
  r = N.nextServerState(r.state, { online: true, players: { online: 0, max: 10 } });
  assert.deepEqual(r.events, ['empty']);
  r = N.nextServerState(r.state, { online: true, players: { online: 0, max: 10 } });
  assert.deepEqual(r.events, []);
  // sin máximo conocido nunca está "lleno"
  s = N.nextServerState(undefined, { online: true, players: { online: 5, max: 0 } }).state;
  assert.deepEqual(N.nextServerState(s, { online: true, players: { online: 6, max: 0 } }).events, []);
});

test('servidores: eventos filtrados por los ajustes', () => {
  const c = N.readNotify({});
  assert.deepEqual(N.serverEventsAllowed(['online', 'full', 'empty'], c), ['online']);
  assert.deepEqual(N.serverEventsAllowed(['online', 'full', 'empty'], N.readNotify({ serverOnline: false, serverFull: true, serverEmpty: true })), ['full', 'empty']);
});

test('favoritos: perfil + esta PC sin repetir, con límite', () => {
  const merged = N.mergeFavorites([{ address: 'Play.A.net', name: 'A' }, { address: 'bad host' }], [{ address: 'play.a.net:25565', name: 'A local' }, 'b.net'], { includeProfile: true });
  assert.deepEqual(merged.map((s) => [s.address, s.name, s.sources]), [['play.a.net', 'A', ['profile', 'local']], ['b.net', 'b.net', ['local']]]);
  assert.deepEqual(N.mergeFavorites([{ address: 'a.net' }], [], { includeProfile: false }), []);
  const many = Array.from({ length: 30 }, (_, i) => `s${i}.net`);
  assert.equal(N.normalizeWatch(many).length, N.MAX_WATCH);
});

test('marcar y desmarcar un servidor', () => {
  let list = N.toggleWatch([], 'play.x.net', 'X');
  assert.deepEqual(list, [{ address: 'play.x.net', name: 'X' }]);
  list = N.toggleWatch(list, 'PLAY.X.NET:25565');
  assert.deepEqual(list, []);
  assert.deepEqual(N.toggleWatch([], 'no válida'), []);
});
