'use strict';
// Validacion de los eventos del contrato 1 (overlay.push / overlay:push).
const test = require('node:test');
const assert = require('node:assert/strict');
const { validate, alertGroup } = require('../events');

const badField = (ev) => {
  try {
    validate(ev);
  } catch (err) {
    assert.equal(err.code, 'badEvent');
    return err.field;
  }
  assert.fail('tenia que fallar');
};

test('eventos que no cumplen el contrato', () => {
  assert.equal(badField(null), 'event');
  assert.equal(badField([]), 'event');
  assert.equal(badField({ kind: 'otro' }), 'kind');
  assert.equal(badField({ kind: 'alert' }), 'title');
  assert.equal(badField({ kind: 'alert', title: '   ' }), 'title');
  assert.equal(badField({ kind: 'message', text: 'hola' }), 'from');
  assert.equal(badField({ kind: 'message', from: 'Sofi', text: '' }), 'text');
  assert.equal(badField({ kind: 'voice', room: 'sala' }), 'room');
  assert.equal(badField({ kind: 'voice', room: null, members: 'x' }), 'members');
  assert.equal(badField({ kind: 'music', state: 'x' }), 'state');
  assert.equal(badField({ kind: 'capture', type: 'video' }), 'type');
});

test('aviso: textos limpios, icono conocido y ttl en segundos (o ms)', () => {
  const a = validate({ kind: 'alert', title: ' Hola\n\tmundo\u0000 ', body: 'x'.repeat(500), icon: 'cohete', ttl: 99, extra: 1 });
  assert.equal(a.title, 'Hola mundo');
  assert.equal(a.icon, 'info');
  assert.equal(a.body.length, 280);
  assert.ok(a.body.endsWith('…'));
  assert.equal(a.ttl, 2); // 99 ms -> 0,099 s -> minimo 2
  assert.equal('extra' in a, false);
  assert.equal(validate({ kind: 'alert', title: 't', ttl: 5000 }).ttl, 5);
  assert.equal(validate({ kind: 'alert', title: 't', ttl: 8 }).ttl, 8);
  assert.equal(validate({ kind: 'alert', title: 't', ttl: 45 }).ttl, 30);
  assert.equal(validate({ kind: 'alert', title: 't' }).ttl, null);
  assert.equal(validate({ kind: 'alert', title: 't', icon: 'achievement' }).icon, 'achievement');
  // separadores de linea raros (U+2028) y marcas de direccion no pasan
  assert.equal(validate({ kind: 'alert', title: `a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x202e)}c` }).title, 'a b c');
});

test('mensaje: avatar solo https, data:image o assets/', () => {
  const base = { kind: 'message', from: 'Sofi', text: 'hola' };
  assert.equal(validate({ ...base, avatar: 'https://mc-heads.net/avatar/abc/32' }).avatar, 'https://mc-heads.net/avatar/abc/32');
  assert.equal(validate({ ...base, avatar: 'http://inseguro.com/a.png' }).avatar, null);
  assert.equal(validate({ ...base, avatar: 'javascript:alert(1)' }).avatar, null);
  assert.equal(validate({ ...base, avatar: 'https://user:pass@host/a.png' }).avatar, null);
  assert.equal(validate({ ...base, avatar: 'file:///C:/a.png' }).avatar, null);
  assert.equal(validate({ ...base, avatar: 'assets/logo-64.png' }).avatar, 'assets/logo-64.png');
  assert.equal(validate({ ...base, avatar: 'assets/../main.js' }).avatar, null);
  assert.equal(validate({ ...base, avatar: 'data:image/png;base64,iVBORw0KGgo=' }).avatar, 'data:image/png;base64,iVBORw0KGgo=');
  assert.equal(validate({ ...base, avatar: 'data:text/html;base64,PGI+' }).avatar, null);
  assert.equal(validate({ ...base, avatar: `data:image/png;base64,${'A'.repeat(600 * 1024)}` }).avatar, null);
  const m = validate({ ...base, text: 'línea 1\nlínea 2', chatId: 42 });
  assert.equal(m.text, 'línea 1 línea 2');
  assert.equal(m.chatId, '42');
  assert.equal(m.fromId, null);
});

test('voz: sala, miembros acotados y sin sala no hay miembros', () => {
  const members = Array.from({ length: 20 }, (_, i) => ({ id: `u${i}`, name: `N${i}`, speaking: i === 0, muted: i === 1 ? 'si' : false, deafened: i === 2 }));
  const v = validate({ kind: 'voice', room: { name: 'Sala', code: 'ABC' }, self: { muted: true }, members });
  assert.deepEqual(v.room, { name: 'Sala', code: 'ABC' });
  assert.deepEqual(v.self, { muted: true, deafened: false });
  assert.equal(v.members.length, 16);
  assert.equal(v.members[0].speaking, true);
  assert.equal(v.members[1].muted, false); // solo true cuenta
  assert.equal(v.members[2].deafened, true);
  const empty = validate({ kind: 'voice', room: null, members });
  assert.equal(empty.room, null);
  assert.deepEqual(empty.members, []);
  const unnamed = validate({ kind: 'voice', room: { name: 'x' }, members: [{}, null] });
  assert.deepEqual(unnamed.members.map((m) => [m.id, m.name]), [['m0', '?']]);
});

test('musica: position y duration en ms, positionAt para la barra y null sin titulo', () => {
  const ms = validate({ kind: 'music', state: { title: 'Sweden', artist: 'C418', playing: true, position: 61000, duration: 215000, positionAt: Date.now(), canSeek: true } });
  assert.equal(ms.state.duration, 215);
  assert.equal(ms.state.position, 61);
  assert.ok(ms.state.positionAt > 0);
  assert.equal('canSeek' in ms.state, false);
  const start = validate({ kind: 'music', state: { title: 'Sweden', position: 500, duration: 215000 } });
  assert.equal(start.state.position, 0.5);
  // radio o transmision sin duracion: la posicion sigue en ms y no hay barra
  const radio = validate({ kind: 'music', state: { title: 'Radio', position: 12000, duration: 0 } });
  assert.deepEqual([radio.state.position, radio.state.duration], [12, null]);
  const over = validate({ kind: 'music', state: { title: 'x', position: 300000, duration: 200000 } });
  assert.equal(over.state.position, 200);
  assert.equal(validate({ kind: 'music', state: { title: 'x', positionAt: 5 } }).state.positionAt, null); // hora absurda
  assert.deepEqual(validate({ kind: 'music', state: null }), { kind: 'music', state: null });
  assert.deepEqual(validate({ kind: 'music', state: { title: '' } }), { kind: 'music', state: null });
  assert.equal(validate({ kind: 'music', state: { title: 'x', art: 'https://i.scdn.co/a.jpg' } }).state.art, 'https://i.scdn.co/a.jpg');
});

test('captura: tipos del contrato y duracion en segundos', () => {
  const c = validate({ kind: 'capture', type: 'clip', path: 'C:\\clips\\a.mp4', duration: 30, thumb: 'nada' });
  assert.deepEqual(c, { kind: 'capture', type: 'clip', path: 'C:\\clips\\a.mp4', thumb: null, duration: 30 });
  assert.equal(validate({ kind: 'capture', type: 'recording-stop', duration: 90000 }).duration, 90); // mas de 6 h: eran ms
  assert.equal(validate({ kind: 'capture', type: 'recording-start' }).duration, null);
});

test('grupo de cada aviso para el filtro de Ajustes', () => {
  assert.equal(alertGroup('friend'), 'friends');
  assert.equal(alertGroup('party'), 'friends');
  assert.equal(alertGroup('server'), 'servers');
  assert.equal(alertGroup('points'), 'rewards');
  assert.equal(alertGroup('achievement'), 'rewards');
  assert.equal(alertGroup('capture'), 'launcher');
  assert.equal(alertGroup('info'), 'launcher');
});
