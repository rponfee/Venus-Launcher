'use strict';
// Soporte de ejemplo (solo capturas): mismas formas que las funciones SQL, permisos de equipo y topes básicos.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFake } = require('../fake');
const { DETAILS } = require('../rules');

const KEYS = ['id', 'subject', 'category', 'status', 'priority', 'createdAt', 'updatedAt', 'assigned', 'unread', 'hasDiagnostic', 'attachmentCount', 'reopenCount'];

test('cliente: lista, detalle y sin leer con la forma de 0045', async () => {
  const fake = createFake('customer');
  const list = await fake.call('list', { admin: false });
  assert.equal(list.length, 4);
  for (const t of list) for (const k of KEYS) assert.ok(k in t, `${t.subject}: falta ${k}`);
  assert.ok(list.some((t) => t.unread));
  const detail = await fake.call('detail', { ticketId: list.find((t) => t.hasDiagnostic).id });
  assert.equal(detail.viewer, 'owner');
  assert.ok(detail.ticket.details && detail.ticket.diagnostic);
  assert.ok(detail.messages.every((m) => 'attachments' in m && 'code' in m));
  const summary = await fake.call('unread');
  assert.equal(summary.unread, 1);
  await fake.call('markSeen', { ticketId: summary.latest[0].id });
  assert.equal((await fake.call('unread')).unread, 0);
});

test('cliente: no accede a funciones del equipo', async () => {
  const fake = createFake('customer');
  assert.deepEqual(await fake.call('staffState'), { isStaff: false });
  for (const action of ['queue', 'staffList', 'macros', 'staffPanel', 'note', 'priority', 'assign']) {
    await assert.rejects(fake.call(action, { ticketId: 'x', filter: {} }), (e) => ['not_staff', 'not_available'].includes(e.code), action);
  }
});

test('cliente: abrir, responder, cerrar, valorar y reabrir', async () => {
  const fake = createFake('customer');
  const made = await fake.call('create', { subject: 'Consulta nueva', category: 'payments', message: 'Hola', details: { topic: 'payment' } });
  assert.equal(made.priority, 'high');
  assert.ok(made.firstMessageId);
  await fake.call('reply', { ticketId: made.id, body: 'Otra cosa' });
  await fake.call('closeOwn', { ticketId: made.id });
  await assert.rejects(fake.call('reply', { ticketId: made.id, body: 'x' }), { code: 'closed' });
  const rated = await fake.call('rate', { ticketId: made.id, rating: 5, comment: 'Bien' });
  assert.equal(rated.rating, 5);
  const reopened = await fake.call('reopen', { ticketId: made.id, message: 'Volvió' });
  assert.equal(reopened.status, 'open');
  assert.equal(reopened.reopenCount, 1);
});

test('cliente: tope de 3 consultas abiertas', async () => {
  const fake = createFake('empty');
  for (let i = 0; i < 3; i++) await fake.call('create', { subject: `Consulta ${i}`, category: 'other', message: 'x' });
  await assert.rejects(fake.call('create', { subject: 'Otra', category: 'other', message: 'x' }), { code: 'too_many_open' });
});

test('equipo: cola con filtros, contadores y panel', async () => {
  const fake = createFake('staff');
  assert.deepEqual(await fake.call('staffState'), { isStaff: true });
  const q = await fake.call('queue', { filter: {} });
  assert.ok(q.items.length >= 5);
  assert.equal(q.items[0].priority, 'urgent');
  for (const k of [...KEYS, 'userName', 'waiting', 'mine', 'lastPreview']) assert.ok(k in q.items[0], k);
  assert.equal(q.counts.pending, q.items.length);
  const game = await fake.call('queue', { filter: { category: 'game', status: 'all' } });
  assert.ok(game.items.length >= 2 && game.items.every((t) => t.category === 'game'));
  const mine = await fake.call('queue', { filter: { assigned: 'me' } });
  assert.ok(mine.items.every((t) => t.mine));
  const panel = await fake.call('staffPanel', { ticketId: q.items[0].id });
  assert.ok(panel.context.username && !('email' in panel.context));
  const note = await fake.call('note', { ticketId: q.items[0].id, body: 'Nota interna' });
  assert.equal(note.mine, true);
  const detail = await fake.call('detail', { ticketId: q.items[0].id });
  assert.equal(detail.viewer, 'staff');
  assert.ok(!JSON.stringify(detail).includes('Nota interna'));
});

test('el diagnóstico de ejemplo no sale de la PC real y las categorías coinciden con las reglas', async () => {
  const fake = createFake('customer');
  const list = await fake.call('list', { admin: false });
  for (const t of list) assert.ok(t.category in DETAILS, t.category);
  const shot = await fake.download();
  assert.match(shot.dataUrl, /^data:image\/svg\+xml;base64,/);
});
