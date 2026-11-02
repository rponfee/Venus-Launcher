// Validación de las señales party-* que llegan de amigos y de las direcciones. node --test "src/renderer/js/features/party/test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../logic.js';

const P = 'PARTY1234567';
const member = (id, extra = {}) => ({ id, name: `N-${id}`, ready: false, prep: 'unknown', online: true, ...extra });
const goodPlan = { pack: { kind: 'version', name: 'Survival', mcVersion: '1.21.1', loader: 'fabric' }, target: { kind: 'server', address: 'Play.Example.net', name: 'Example' } };
const goodState = (extra = {}) => ({ v: 1, party: P, rev: 2, leaderName: 'Ringo', members: [member('lead', { ready: true, prep: 'ok' }), member('me')], invited: [{ id: 'inv', name: 'Inv' }], plan: goodPlan, voice: 'ABCDEF', play: { seq: 1 }, ...extra });

test('tipos: todos con prefijo party- y que cumplen el formato de social', () => {
  for (const type of L.SIGNAL_TYPES) {
    assert.match(type, /^party-/);
    assert.match(type, /^[A-Za-z][\w.:-]{0,39}$/);
  }
  assert.equal(L.parseSignal('voice-invite', { v: 1, party: P }), null);
});

test('base: versión, id del grupo y forma del payload', () => {
  assert.equal(L.parseSignal(L.SIGNALS.accept, null), null);
  assert.equal(L.parseSignal(L.SIGNALS.accept, []), null);
  assert.equal(L.parseSignal(L.SIGNALS.accept, { v: 2, party: P }), null);
  assert.equal(L.parseSignal(L.SIGNALS.accept, { v: 1, party: 'corto' }), null);
  assert.equal(L.parseSignal(L.SIGNALS.accept, { v: 1, party: 'con espacio 12' }), null);
  assert.deepEqual(L.parseSignal(L.SIGNALS.accept, { v: 1, party: P, extra: 'x' }), { party: P });
  for (const type of [L.SIGNALS.decline, L.SIGNALS.leave, L.SIGNALS.kick]) assert.deepEqual(L.parseSignal(type, { v: 1, party: P }), { party: P });
});

test('invitación: textos limpios y tamaño acotado', () => {
  const nul = String.fromCharCode(0);
  const ls = String.fromCharCode(0x2028);
  const rlo = String.fromCharCode(0x202e);
  const r = L.parseSignal(L.SIGNALS.invite, { v: 1, party: P, size: 99, game: `Pack${nul}${ls}${rlo} genial   ${'x'.repeat(80)}`, where: 42 });
  assert.equal(r.size, 1, 'tamaño fuera de rango -> 1');
  assert.ok(!r.game.includes(nul) && !r.game.includes(ls) && !r.game.includes(rlo));
  assert.ok(r.game.startsWith('Pack genial'));
  assert.ok(r.game.length <= 60);
  assert.equal(r.where, '');
});

test('fin y listo: valores conocidos o por defecto', () => {
  assert.equal(L.parseSignal(L.SIGNALS.end, { v: 1, party: P, reason: 'leader' }).reason, 'leader');
  assert.equal(L.parseSignal(L.SIGNALS.end, { v: 1, party: P, reason: 'hack' }).reason, 'closed');
  assert.deepEqual(L.parseSignal(L.SIGNALS.ready, { v: 1, party: P, ready: 'yes', prep: 'ok' }), { party: P, ready: false, prep: 'ok' });
  assert.deepEqual(L.parseSignal(L.SIGNALS.ready, { v: 1, party: P, ready: true, prep: '<b>' }), { party: P, ready: true, prep: 'unknown' });
});

test('jugar todos: necesita un plan completo y un número de secuencia', () => {
  assert.equal(L.parseSignal(L.SIGNALS.play, { v: 1, party: P, seq: 1, plan: { pack: goodPlan.pack, target: null } }), null);
  assert.equal(L.parseSignal(L.SIGNALS.play, { v: 1, party: P, seq: 0, plan: goodPlan }), null);
  assert.equal(L.parseSignal(L.SIGNALS.play, { v: 1, party: P, seq: 1.5, plan: goodPlan }), null);
  const r = L.parseSignal(L.SIGNALS.play, { v: 1, party: P, seq: 3, plan: goodPlan });
  assert.equal(r.seq, 3);
  assert.equal(r.plan.target.address, 'play.example.net', 'la dirección se normaliza');
  // el mundo sin dirección todavía es un plan completo (la dirección llega después)
  assert.ok(L.parseSignal(L.SIGNALS.play, { v: 1, party: P, seq: 1, plan: { pack: goodPlan.pack, target: { kind: 'world', name: 'Mundo', address: null } } }));
});

test('estado: forma completa válida', () => {
  const r = L.parseSignal(L.SIGNALS.state, goodState());
  assert.equal(r.rev, 2);
  assert.equal(r.members.length, 2);
  assert.equal(r.members[0].prep, 'ok');
  assert.equal(r.voice, 'ABCDEF');
  assert.deepEqual(r.play, { seq: 1 });
  assert.deepEqual(r.invited, [{ id: 'inv', name: 'Inv' }]);
});

test('estado: rechaza integrantes repetidos, de más, ids raros y planes rotos', () => {
  assert.equal(L.parseSignal(L.SIGNALS.state, goodState({ rev: 0 })), null);
  assert.equal(L.parseSignal(L.SIGNALS.state, goodState({ members: [] })), null);
  assert.equal(L.parseSignal(L.SIGNALS.state, goodState({ members: [member('a'), member('a')] })), null);
  assert.equal(L.parseSignal(L.SIGNALS.state, goodState({ members: [member('a'), member('b/../c')] })), null);
  assert.equal(L.parseSignal(L.SIGNALS.state, goodState({ members: Array.from({ length: 9 }, (_, i) => member(`m${i}`)) })), null);
  assert.equal(L.parseSignal(L.SIGNALS.state, goodState({ members: Array.from({ length: 7 }, (_, i) => member(`m${i}`)), invited: [{ id: 'x' }, { id: 'y' }] })), null, 'integrantes + invitados > 8');
  assert.equal(L.parseSignal(L.SIGNALS.state, goodState({ invited: [{ id: 'me' }] })), null, 'invitado que ya es integrante');
  assert.equal(L.parseSignal(L.SIGNALS.state, goodState({ plan: { pack: goodPlan.pack, target: { kind: 'server', address: 'javascript:alert(1)' } } })), null);
  assert.equal(L.parseSignal(L.SIGNALS.state, goodState({ plan: { pack: { kind: 'shared', code: 'PACK-000000', mcVersion: '1.21.1' } } })), null, 'código de modpack inválido');
  // valores opcionales raros se descartan sin rechazar el estado
  const r = L.parseSignal(L.SIGNALS.state, goodState({ voice: 'abc', play: { seq: -1 }, leaderName: '' }));
  assert.equal(r.voice, null);
  assert.equal(r.play, null);
  assert.equal(r.leaderName, '?');
});

test('loader desconocido cae en vanilla y versiones raras se rechazan', () => {
  assert.equal(L.cleanPack({ kind: 'version', mcVersion: '1.21.1', loader: 'malware' }).loader, 'vanilla');
  assert.equal(L.cleanPack({ kind: 'version', mcVersion: '1.21.1"; rm -rf' }), null);
  assert.equal(L.cleanPack({ kind: 'shared', code: 'PACK-ABCDEF', mcVersion: '1.21.1', revision: -3 }).revision, 0);
});

test('direcciones: formatos válidos y peligrosos', () => {
  assert.equal(L.cleanAddress('Play.Hypixel.NET'), 'play.hypixel.net');
  assert.equal(L.cleanAddress('play.hypixel.net.'), 'play.hypixel.net');
  assert.equal(L.cleanAddress('minecraft://mc.example.com:25570/'), 'mc.example.com:25570');
  assert.equal(L.cleanAddress('192.168.0.10:25565'), '192.168.0.10:25565', 'red local permitida (amigos en la misma casa)');
  assert.equal(L.cleanAddress('[2001:db8::1]:25565'), '[2001:db8::1]:25565');
  assert.equal(L.cleanAddress('bore.pub:41234'), 'bore.pub:41234');
  for (const bad of ['', ' ', 'host:0', 'host:70000', 'a b.com', 'http://x.com', 'x.com/path', '-bad.com', 'bad-.com', 'a..b', '../etc', 'host:12ab', null, 42]) {
    assert.equal(L.cleanAddress(bad), null, String(bad));
  }
  assert.deepEqual(L.quickPlayOf('mc.example.com'), { server: 'mc.example.com', port: 25565 });
  assert.deepEqual(L.quickPlayOf('mc.example.com:25570'), { server: 'mc.example.com', port: 25570 });
  assert.deepEqual(L.quickPlayOf('[::1]:25566'), { server: '[::1]', port: 25566 });
  assert.equal(L.addressKey('MC.example.com:25565'), 'mc.example.com');
});

test('tamaño: lo que no entra en 4 KB no se manda', () => {
  assert.ok(L.fitsPayload({ v: 1, party: P }));
  assert.equal(L.fitsPayload({ x: 'a'.repeat(4100) }), false);
  assert.ok(L.newPartyId().match(/^[A-Za-z0-9]{12}$/));
});
