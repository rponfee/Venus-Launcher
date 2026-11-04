'use strict';
// De lo que devuelve app_inbox al aviso que se muestra.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const texts = require('../js/shared/texts.js');
require('../js/shared/media.js');
const { buildNotification, safeHash } = require('../js/shared/notify.js');

const BASE = 'https://proyecto.supabase.co';
const tr = texts.translator('es');
const LUNA = '11111111-2222-4333-8444-555555555555';
const STK = '77777777-2222-4333-8444-555555555555';
const T = (min) => new Date(Date.UTC(2026, 10, 3, 12, min)).toISOString();
const opts = (last = 0) => ({ last, tr, base: BASE });
const empty = { messages: [], requests: [], clips: [] };

test('sin sesión o sin datos: aviso genérico, sin nombres ni texto', () => {
  for (const inbox of [null, undefined, 'x']) {
    const n = buildNotification(inbox, opts());
    assert.equal(n.title, 'Venus');
    assert.equal(n.body, tr('push_generic'));
    assert.equal(n.hash, '#/inbox');
    assert.equal(n.stamp, 0);
  }
});

test('nada nuevo desde el último aviso: genérico', () => {
  const inbox = { ...empty, messages: [{ conv: 'c', userId: LUNA, name: 'Luna', unread: 1, at: T(1), text: 'hola' }] };
  const n = buildNotification(inbox, opts(Date.parse(T(5))));
  assert.equal(n.tag, 'venus-generic');
  assert.ok(!n.body.includes('hola'));
});

test('un mensaje: nombre y texto solo si la app lo pidió', () => {
  const con = buildNotification({ ...empty, messages: [{ conv: 'c', userId: LUNA, name: 'Luna', unread: 1, at: T(1), text: 'hola che' }] }, opts());
  assert.equal(con.title, 'Luna');
  assert.equal(con.body, 'hola che');
  assert.equal(con.tag, 'venus-dm-c');
  assert.equal(con.hash, `#/messages/${LUNA}`);
  assert.equal(con.stamp, Date.parse(T(1)));
  const sin = buildNotification({ ...empty, messages: [{ conv: 'c', userId: LUNA, name: 'Luna', unread: 3, at: T(1), text: null }] }, opts());
  assert.equal(sin.body, tr('push_messages', { count: 3 }));
  const uno = buildNotification({ ...empty, messages: [{ conv: 'c', userId: LUNA, name: 'Luna', unread: 1, at: T(1) }] }, opts());
  assert.equal(uno.body, tr('push_message'));
});

test('un GIF o un sticker nunca muestran la dirección', () => {
  const gif = buildNotification({ ...empty, messages: [{ conv: 'c', userId: LUNA, name: 'Luna', unread: 1, at: T(1), text: 'https://static.klipy.com/a.gif' }] }, opts());
  assert.equal(gif.body, 'GIF');
  const url = `${BASE}/storage/v1/object/public/stickers/${LUNA}/${STK}.png`;
  const sticker = buildNotification({ ...empty, messages: [{ conv: 'c', userId: LUNA, name: 'Luna', unread: 1, at: T(1), text: url }] }, opts());
  assert.equal(sticker.body, 'Sticker');
});

test('el texto se limpia y se corta', () => {
  const n = buildNotification({ ...empty, messages: [{ conv: 'c', userId: LUNA, name: 'Lu\u0000na', unread: 1, at: T(1), text: `a\n\u0007b${'x'.repeat(300)}` }] }, opts());
  assert.equal(n.title, 'Lu na');
  assert.ok(n.body.startsWith('a b'));
  assert.ok(n.body.length <= 120);
});

test('varias conversaciones: resumen sin texto', () => {
  const inbox = { ...empty, messages: [{ conv: 'a', userId: LUNA, name: 'Luna', unread: 2, at: T(2), text: 'secreto' }, { conv: 'b', userId: LUNA, name: 'Nico', unread: 1, at: T(3), text: 'otro' }] };
  const n = buildNotification(inbox, opts());
  assert.equal(n.body, tr('push_many', { count: 3, chats: 2 }));
  assert.equal(n.hash, '#/messages');
  assert.ok(!n.body.includes('secreto'));
});

test('se avisa de lo último: solicitud o clip', () => {
  const req = buildNotification({ messages: [{ conv: 'c', userId: LUNA, name: 'Luna', unread: 1, at: T(1) }], requests: [{ userId: LUNA, name: 'Pablo', at: T(9) }], clips: [] }, opts());
  assert.equal(req.title, 'Pablo');
  assert.equal(req.body, tr('push_request'));
  assert.equal(req.hash, '#/friends');
  const clip = buildNotification({ messages: [], requests: [{ userId: LUNA, name: 'Pablo', at: T(1) }], clips: [{ id: 'r', from: 'Luna', kind: 'clip', name: 'a.webm', at: T(9) }] }, opts());
  assert.equal(clip.title, 'Luna');
  assert.equal(clip.body, `${tr('push_clip')}: a.webm`);
  assert.equal(clip.hash, '#/clips/received');
  const shot = buildNotification({ ...empty, clips: [{ id: 'r', from: null, kind: 'screenshot', name: '', at: T(9) }] }, opts());
  assert.equal(shot.title, tr('someone'));
  assert.equal(shot.body, tr('push_shot'));
});

test('un id raro no llega a la dirección del aviso', () => {
  const n = buildNotification({ ...empty, messages: [{ conv: 'c', userId: '../../evil', name: 'Luna', unread: 1, at: T(1) }] }, opts());
  assert.equal(n.hash, '#/messages');
});

test('tocar el aviso solo abre direcciones internas', () => {
  for (const ok of ['#/friends', '#/inbox', '#/messages', `#/messages/${LUNA}`, '#/clips', '#/clips/received']) assert.equal(safeHash(ok), ok);
  for (const no of ['https://evil.com', 'javascript:alert(1)', '#/messages/../..', '//evil.com', null, undefined, 5]) assert.equal(safeHash(no), '#/inbox');
});

test('los dos idiomas tienen las mismas claves y las mismas variables', () => {
  const { es, en } = texts.dictionaries;
  assert.deepEqual(Object.keys(es).sort(), Object.keys(en).sort());
  const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const key of Object.keys(es)) assert.deepEqual(vars(es[key]), vars(en[key]), key);
  assert.equal(texts.pickLang('es-AR'), 'es');
  assert.equal(texts.pickLang('ES'), 'es');
  assert.equal(texts.pickLang('en-US'), 'en');
  assert.equal(texts.pickLang('pt-BR'), 'en');
  assert.equal(texts.pickLang(undefined), 'en');
  assert.equal(texts.translator('es')('friends_incoming', { count: 2 }), 'Solicitudes (2)');
  assert.equal(texts.translator('en')('no_existe'), 'no_existe');
});
