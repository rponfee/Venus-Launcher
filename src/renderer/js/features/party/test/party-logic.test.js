// Máquina de estados del grupo (lado del líder y del miembro). node --test "src/renderer/js/features/party/test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../logic.js';

const T0 = 1_700_000_000_000;
const LEADER = { id: 'leader-1', name: 'Ringo' };
const mk = () => L.createParty({ id: 'PARTY1234567', leader: LEADER, now: T0 });
const plan = (extra = {}) => ({ pack: { kind: 'version', name: 'Survival', mcVersion: '1.21.1', loader: 'fabric' }, target: { kind: 'server', address: 'play.example.net', name: 'Example' }, ...extra });

function withMembers(n) {
  let p = mk();
  for (let i = 1; i <= n; i++) {
    p = L.invite(p, { id: `u${i}`, name: `Amigo ${i}` }, T0).party;
    p = L.acceptInvite(p, `u${i}`, `Amigo ${i}`, T0 + 1000).party;
  }
  return p;
}

test('crear: el líder es el único integrante, listo y con revisión 1', () => {
  const p = mk();
  assert.equal(p.leader, 'leader-1');
  assert.equal(p.rev, 1);
  assert.deepEqual(p.members.map((m) => [m.id, m.leader, m.ready]), [['leader-1', true, true]]);
  assert.throws(() => L.createParty({ id: 'x', leader: LEADER }), /bad_party/);
  assert.throws(() => L.createParty({ id: 'PARTY1234567', leader: { id: 'con espacio' } }), /bad_party/);
});

test('invitar: errores por uno mismo, repetido, inválido y lleno', () => {
  const p = mk();
  assert.equal(L.invite(p, { id: 'leader-1' }).error, 'self');
  assert.equal(L.invite(p, { id: '../x' }).error, 'bad');
  const r1 = L.invite(p, { id: 'u1', name: 'Tomi' }, T0);
  assert.ok(r1.ok);
  assert.equal(r1.party.rev, 2);
  assert.equal(r1.party.invited[0].name, 'Tomi');
  assert.equal(L.invite(r1.party, { id: 'u1' }, T0 + 1000).error, 'already');
  // una invitación vencida se puede volver a mandar
  assert.ok(L.invite(r1.party, { id: 'u1' }, T0 + L.INVITE_TTL_MS + 1).ok);
  // 8 lugares con el líder: 7 invitaciones pendientes llenan el grupo
  let full = p;
  for (let i = 1; i <= 7; i++) full = L.invite(full, { id: `f${i}` }, T0).party;
  assert.equal(L.slotsLeft(full), 0);
  assert.equal(L.invite(full, { id: 'f8' }, T0).error, 'full');
});

test('aceptar: solo invitados, antes de que venza y con lugar', () => {
  let p = L.invite(mk(), { id: 'u1', name: 'Tomi' }, T0).party;
  assert.equal(L.acceptInvite(p, 'zz', 'X', T0).error, 'not_invited');
  const late = L.acceptInvite(p, 'u1', 'Tomi', T0 + L.INVITE_TTL_MS);
  assert.equal(late.error, 'expired');
  assert.equal(late.party.invited.length, 0, 'la invitación vencida se borra');
  const r = L.acceptInvite(p, 'u1', 'Tomás', T0 + 5000);
  assert.ok(r.ok);
  p = r.party;
  assert.equal(p.invited.length, 0);
  const m = p.members.find((x) => x.id === 'u1');
  assert.equal(m.name, 'Tomás');
  assert.equal(m.ready, false);
  assert.equal(m.prep, 'unknown');
  // aceptar dos veces no cambia nada
  const again = L.acceptInvite(p, 'u1', 'Tomás', T0 + 6000);
  assert.ok(again.ok);
  assert.equal(again.party, p);
});

test('aceptar con el grupo completo no deja pasar a nadie más', () => {
  let p = withMembers(7);
  assert.equal(L.memberCount(p), 8);
  // una invitación vieja que quedó (por ejemplo, de antes de llenarse) no entra
  p = { ...p, invited: [{ id: 'late', name: 'Tarde', at: T0 }] };
  const r = L.acceptInvite(p, 'late', 'Tarde', T0 + 1000);
  assert.equal(r.error, 'full');
  assert.equal(r.party.invited.length, 0);
});

test('rechazar y cancelar sacan la invitación', () => {
  const p = L.invite(mk(), { id: 'u1' }, T0).party;
  assert.equal(L.declineInvite(p, 'u1').party.invited.length, 0);
  assert.equal(L.cancelInvite(p, 'u1').party.invited.length, 0);
  assert.equal(L.declineInvite(p, 'u2').error, 'not_invited');
});

test('salir y echar', () => {
  const p = withMembers(2);
  assert.equal(L.leave(p, 'leader-1').error, 'leader', 'el líder no sale: disuelve');
  assert.equal(L.leave(p, 'nadie').error, 'not_member');
  const left = L.leave(p, 'u1');
  assert.ok(left.ok);
  assert.deepEqual(left.party.members.map((m) => m.id), ['leader-1', 'u2']);
  assert.equal(L.kick(p, 'u2', 'u1').error, 'not_leader');
  assert.equal(L.kick(p, 'leader-1').error, 'self');
  assert.deepEqual(L.kick(p, 'u2').party.members.map((m) => m.id), ['leader-1', 'u1']);
});

test('listo y preparación de un miembro', () => {
  const p = withMembers(1);
  const r = L.setReady(p, 'u1', true, 'ok');
  assert.ok(r.ok);
  assert.deepEqual(r.party.members[1], { ...r.party.members[1], ready: true, prep: 'ok' });
  assert.equal(L.setReady(r.party, 'u1', true, 'ok').party, r.party, 'sin cambios no sube la revisión');
  assert.equal(L.setReady(p, 'leader-1', false).error, 'not_member');
  assert.equal(L.setReady(p, 'u1', true, 'raro').party.members[1].prep, 'unknown', 'prep desconocido se ignora');
});

test('cambiar el plan pone a todos en "no listo", salvo cuando solo cambia la dirección del mundo', () => {
  let p = L.setReady(withMembers(1), 'u1', true, 'ok').party;
  p = L.setPlan(p, plan()).party;
  assert.equal(p.members[1].ready, false);
  assert.equal(L.setPlan(p, { pack: { kind: 'raro' } }).error, 'bad_plan');
  // mundo sin dirección -> con dirección: se conserva el "listo"
  p = L.setPlan(p, { pack: plan().pack, target: { kind: 'world', name: 'Mundo', address: null } }).party;
  p = L.setReady(p, 'u1', true, 'ok').party;
  const withAddr = L.setPlan(p, { pack: plan().pack, target: { kind: 'world', name: 'Mundo', address: 'abc.e4mc.link' } }).party;
  assert.equal(withAddr.members[1].ready, true);
  assert.equal(withAddr.plan.target.address, 'abc.e4mc.link');
  // otra instancia: vuelve a "no listo"
  const other = L.setPlan(withAddr, { pack: { ...plan().pack, mcVersion: '1.20.4' }, target: withAddr.plan.target }).party;
  assert.equal(other.members[1].ready, false);
});

test('jugar todos necesita plan completo y al menos dos personas', () => {
  assert.equal(L.startPlay(L.setPlan(mk(), plan()).party).error, 'alone');
  assert.equal(L.startPlay(withMembers(1)).error, 'no_plan');
  assert.equal(L.startPlay(L.setPlan(withMembers(1), { pack: plan().pack, target: null }).party).error, 'no_plan');
  const r1 = L.startPlay(L.setPlan(withMembers(1), plan()).party, T0);
  assert.ok(r1.ok);
  assert.equal(r1.party.play.seq, 1);
  assert.equal(L.startPlay(r1.party, T0 + 1).party.play.seq, 2);
});

test('las invitaciones vencen', () => {
  const p = L.invite(L.invite(mk(), { id: 'a' }, T0).party, { id: 'b' }, T0 + 60_000).party;
  const r = L.expireInvites(p, T0 + L.INVITE_TTL_MS + 1);
  assert.deepEqual(r.party.invited.map((i) => i.id), ['b']);
  assert.equal(L.expireInvites(p, T0 + 1000).party, p);
});

test('toWire: el estado entra en una señal aunque los nombres sean largos', () => {
  let p = mk();
  const long = '🐉'.repeat(40);
  for (let i = 1; i <= 7; i++) {
    p = L.invite(p, { id: `u-${'x'.repeat(30)}-${i}`, name: long }, T0).party;
    if (i <= 5) p = L.acceptInvite(p, `u-${'x'.repeat(30)}-${i}`, long, T0 + 10).party;
  }
  p = L.setPlan(p, { pack: { kind: 'shared', code: 'PACK-ABCDEF', name: long, revision: 3, mcVersion: '1.21.1', loader: 'neoforge' }, target: { kind: 'server', address: 'play.example.net:25570', name: long } }).party;
  const wire = L.toWire(p, long);
  assert.ok(wire, 'se pudo armar');
  assert.ok(L.payloadBytes(wire) <= L.MAX_PAYLOAD);
  assert.equal(wire.v, L.PROTOCOL);
  assert.equal(wire.members.length, 6);
  assert.equal(wire.invited.length, 2);
  // lo que manda el líder pasa la validación del miembro
  assert.ok(L.parseSignal(L.SIGNALS.state, wire));
});

test('miembro: aplica solo estados nuevos del líder de su grupo', () => {
  const local = { id: 'PARTY1234567', leader: 'leader-1', rev: 3, leaderName: 'Ringo' };
  const state = (rev, members = [{ id: 'leader-1', name: 'Ringo', ready: true, prep: 'ok', online: true }, { id: 'me', name: 'Yo', ready: false, prep: 'unknown', online: true }]) =>
    L.parseSignal(L.SIGNALS.state, { v: 1, party: 'PARTY1234567', rev, leaderName: 'Ringo', members, invited: [], plan: plan(), voice: null, play: null });
  assert.equal(L.applyState(local, 'otro', state(4), 'me').action, 'ignore', 'no es el líder');
  assert.equal(L.applyState(local, 'leader-1', state(3), 'me').action, 'ignore', 'revisión vieja');
  assert.equal(L.applyState({ ...local, id: 'OTROGRUPO123' }, 'leader-1', state(4), 'me').action, 'ignore', 'otro grupo');
  const upd = L.applyState(local, 'leader-1', state(4), 'me');
  assert.equal(upd.action, 'update');
  assert.equal(upd.party.rev, 4);
  assert.equal(upd.party.leader, 'leader-1');
  assert.equal(upd.party.plan.target.address, 'play.example.net');
  const removed = L.applyState(local, 'leader-1', state(5, [{ id: 'leader-1', name: 'Ringo', ready: true, prep: 'ok', online: true }]), 'me');
  assert.equal(removed.action, 'removed');
});

test('líder caído: tiempo sin estado o desconectado sin estado reciente', () => {
  const now = T0 + 1_000_000;
  assert.equal(L.leaderLost({ lastStateAt: now - 30_000, now, presence: 'online' }), false);
  assert.equal(L.leaderLost({ lastStateAt: now - L.LEADER_TIMEOUT_MS - 1, now, presence: 'online' }), true);
  // Invisible: se ve desconectado pero el estado llegó hace poco
  assert.equal(L.leaderLost({ lastStateAt: now - 30_000, now, presence: 'offline' }), false);
  assert.equal(L.leaderLost({ lastStateAt: now - L.PRESENCE_GRACE_MS - 1, now, presence: 'offline' }), true);
  assert.equal(L.leaderLost({ lastStateAt: undefined, now, presence: 'offline' }), true);
  assert.equal(L.leaderLost({ lastStateAt: undefined, now, presence: 'online' }), false);
});

test('líder: saca a los miembros que dejaron de latir', () => {
  const p = withMembers(2);
  const seen = new Map([['u1', T0 + 1000 + L.LEADER_TIMEOUT_MS]]);
  const now = T0 + 1000 + L.LEADER_TIMEOUT_MS + 5000;
  assert.deepEqual(L.staleMembers(p, seen, now), ['u2'], 'u2 nunca latió desde que entró');
  assert.deepEqual(L.staleMembers(p, new Map(), T0 + 2000), []);
  assert.deepEqual(L.staleMembers(null, seen, now), []);
});

test('preparación: instancia compartida al día, atrasada o faltante; versión y loader', () => {
  const shared = { pack: { kind: 'shared', code: 'PACK-ABCDEF', name: 'Pack', revision: 5, mcVersion: '1.21.1', loader: 'fabric' }, target: null };
  const inst = (id, extra) => ({ id, name: id, mcVersion: '1.21.1', loader: 'fabric', lastPlayed: 0, ...extra });
  assert.deepEqual(L.prepFor(shared, [inst('a', { share: { code: 'PACK-ABCDEF', revision: 5 } })]), { prep: 'ok', instanceId: 'a' });
  assert.deepEqual(L.prepFor(shared, [inst('a', { share: { code: 'PACK-ABCDEF', revision: 4 } })]), { prep: 'update', instanceId: 'a' });
  assert.deepEqual(L.prepFor(shared, [inst('a', { share: { code: 'PACK-ABCDEF', revision: 4 } }), inst('b', { share: { code: 'PACK-ABCDEF', revision: 6 } })]), { prep: 'ok', instanceId: 'b' });
  assert.deepEqual(L.prepFor(shared, [inst('a')]), { prep: 'missing', instanceId: null }, 'misma versión sin el modpack no alcanza');
  const version = { pack: { kind: 'version', name: '', mcVersion: '1.21.1', loader: 'iris' }, target: null };
  assert.deepEqual(L.prepFor(version, [inst('a'), inst('b', { preset: 'iris', lastPlayed: 5 }), inst('c', { preset: 'iris', lastPlayed: 9 })]), { prep: 'ok', instanceId: 'c' });
  assert.deepEqual(L.prepFor(version, [inst('a')]), { prep: 'missing', instanceId: null });
  assert.deepEqual(L.prepFor(null, []), { prep: 'unknown', instanceId: null });
});

test('plan desde una instancia del líder: código si está compartida, versión y loader si no', () => {
  assert.deepEqual(L.packFromInstance({ name: 'Mi pack', mcVersion: '1.20.1', loader: 'forge', share: { code: 'PACK-ABCDEF', name: 'Pack grupo', revision: 2 } }), { kind: 'shared', code: 'PACK-ABCDEF', name: 'Pack grupo', revision: 2, mcVersion: '1.20.1', loader: 'forge' });
  assert.deepEqual(L.packFromInstance({ name: 'Vanilla', mcVersion: '1.21.4', loader: 'vanilla' }), { kind: 'version', name: 'Vanilla', mcVersion: '1.21.4', loader: 'vanilla' });
  assert.equal(L.packFromInstance({ name: 'x', mcVersion: '<script>' }), null);
  assert.equal(L.packFromInstance(null), null);
});

test('invitaciones que llegan: repetidas y en ráfaga se ignoran', () => {
  const gate = L.createInviteGate();
  assert.equal(gate.allow('a', 'P1', T0), true);
  assert.equal(gate.allow('a', 'P1', T0 + 1000), false, 'mismo grupo dentro de 30 s');
  assert.equal(gate.allow('a', 'P2', T0 + 2000), true);
  assert.equal(gate.allow('a', 'P3', T0 + 3000), true);
  assert.equal(gate.allow('a', 'P4', T0 + 4000), false, 'más de 3 por minuto');
  assert.equal(gate.allow('b', 'P1', T0 + 4000), true, 'cada amigo cuenta aparte');
  assert.equal(gate.allow('a', 'P1', T0 + 61_000), true);
});
