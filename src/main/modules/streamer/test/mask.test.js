'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { maskText, maskEvent, resetAliases, CODE_MASK } = require('../mask');

const t = (key, vars = {}) => `${key}${vars.n ? `#${vars.n}` : ''}`;

test('tapa codigos de amigo y de pack', () => {
  assert.equal(maskText('Tu código es VENUS-R1NG0X'), `Tu código es VENUS-${CODE_MASK}`);
  assert.equal(maskText('entrá con pack-ab12cd'), `entrá con PACK-${CODE_MASK}`);
  assert.equal(maskText('VENUS-ABC'), 'VENUS-ABC'); // demasiado corto: no es un código
});

test('tapa IPs con y sin puerto, no versiones', () => {
  assert.equal(maskText('Servidor en 190.12.34.56:25565'), 'Servidor en •••.•••.•••.•••');
  assert.equal(maskText('LAN 192.168.1.20'), 'LAN •••.•••.•••.•••');
  assert.equal(maskText('Forge 1.20.1-47.2.0 listo'), 'Forge 1.20.1-47.2.0 listo');
  assert.equal(maskText('Minecraft 1.20.1 y NeoForge 21.1.72'), 'Minecraft 1.20.1 y NeoForge 21.1.72');
  assert.equal(maskText('fabric-1.21.1.jar'), 'fabric-1.21.1.jar');
  assert.equal(maskText('v6 2001:db8::1 ok'), 'v6 ••••:•••• ok');
});

test('tapa direcciones de servidor y deja archivos y textos comunes', () => {
  assert.equal(maskText('Sofi entró a mc.hypixel.net'), 'Sofi entró a ••••••••.net');
  assert.equal(maskText('play.ejemplo.com:25565'), '••••••••.com:25565');
  assert.equal(maskText('abc123.bore.pub:4567'), '••••••••.pub:4567');
  assert.equal(maskText('sodium-0.5.8+mc1.20.1.jar'), 'sodium-0.5.8+mc1.20.1.jar');
  assert.equal(maskText('config/sodium.properties'), 'config/sodium.properties');
  assert.equal(maskText('ringo@gmail.com'), 'ringo@gmail.com'); // los emails no son direcciones de servidor
  assert.equal(maskText('Tarea terminada. Mundo nuevo.'), 'Tarea terminada. Mundo nuevo.');
  assert.equal(maskText(''), '');
  assert.equal(maskText(null), null);
});

test('mensajes: sin remitente ni texto', () => {
  const out = maskEvent({ kind: 'message', from: 'Sofi', fromId: 'u1', avatar: 'https://x/y.png', text: 'vení al server 1.2.3.4', chatId: 'c1' }, t);
  assert.deepEqual(out, { kind: 'message', from: 'overlay.streamerFriend', fromId: null, avatar: null, text: 'overlay.streamerMessage', chatId: 'c1' });
});

test('voz: codigo y nombres genericos estables, el propio se distingue', () => {
  resetAliases();
  const ev = { kind: 'voice', room: { name: 'Base', code: 'ABC234' }, self: { muted: false, deafened: false }, members: [{ id: 'me', name: 'Ringo', self: true, speaking: false }, { id: 'u2', name: 'Sofi', speaking: true, avatar: 'https://x' }] };
  const a = maskEvent(ev, t);
  assert.equal(a.room.code, CODE_MASK);
  assert.equal(a.room.name, 'overlay.streamerRoom');
  assert.equal(a.members[0].name, 'overlay.streamerYou');
  assert.equal(a.members[1].name, 'overlay.streamerFriendN#1');
  assert.equal(a.members[1].avatar, null);
  assert.equal(a.members[1].speaking, true);
  const b = maskEvent({ ...ev, members: [{ id: 'u3', name: 'Tomi' }, { id: 'u2', name: 'Sofi' }] }, t);
  assert.equal(b.members[1].name, 'overlay.streamerFriendN#1'); // mismo id, mismo alias
  assert.equal(b.members[0].name, 'overlay.streamerFriendN#2');
  assert.equal(maskEvent({ kind: 'voice', room: null, members: [] }, t).room, null);
});

test('avisos: los de amigos pierden el cuerpo, el resto solo las direcciones', () => {
  assert.deepEqual(maskEvent({ kind: 'alert', icon: 'friend', title: 'Sofi entró a mc.x.net', body: 'Versión 1.21' }, t), { kind: 'alert', icon: 'friend', title: 'overlay.streamerFriendAlert', body: undefined });
  assert.deepEqual(maskEvent({ kind: 'alert', icon: 'server', title: 'Servidor listo', body: 'Entrá con 10.0.0.2:25565' }, t), { kind: 'alert', icon: 'server', title: 'Servidor listo', body: 'Entrá con •••.•••.•••.•••' });
  const cap = { kind: 'capture', type: 'screenshot' };
  assert.equal(maskEvent(cap, t), cap);
});
