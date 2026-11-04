'use strict';
// El estado de la app con el backend real y el cliente falso (dev/fake.js): sin red.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const modules = Promise.all([import('../dev/fake.js'), import('../js/backend.js'), import('../js/store.js')]);

async function setup({ net = { onLine: true }, doc = { hidden: false } } = {}) {
  const [{ createFakeClient }, { createBackend }, { Store }] = await modules;
  const client = createFakeClient();
  const fake = client.__fake;
  const backend = createBackend(client, fake.ids.ME);
  const store = new Store({ backend, someone: 'Alguien', doc, net });
  await store.start();
  await new Promise((resolve) => setTimeout(resolve, 5));
  return { store, client, fake, backend };
}

test('arranca: amigos, solicitudes, conversaciones y no leídos', async (t) => {
  const { store, fake } = await setup();
  t.after(() => store.stop());
  assert.equal(store.state, 'ready');
  assert.equal(store.live, 'online');
  assert.equal(store.me.friend_code, 'VENUS-A1B2C3');
  assert.equal(store.friends.length, 5);
  assert.equal(store.friends[0].presence !== 'offline', true);
  assert.equal(store.friends.find((f) => f.id === fake.ids.MAIA).presence, 'offline', 'sin latido reciente');
  assert.deepEqual(store.incoming.map((r) => r.name), ['Pablo']);
  assert.deepEqual(store.outgoing.map((r) => r.name), ['Juli']);
  assert.equal(store.conversations().length, 2);
  assert.equal(store.chat(fake.ids.CONV_LUNA).unread, 2);
  assert.equal(store.badges.requests, 1);
  assert.equal(store.badges.messages, 2);
  assert.equal(store.badges.clips, 1);
  assert.equal(store.badges.total, 4);
});

test('el celular nunca publica presencia ni actividad', async (t) => {
  const { store, fake } = await setup();
  t.after(() => store.stop());
  await store.loadMessages(fake.ids.CONV_LUNA);
  store.setActive(fake.ids.LUNA);
  store.send(fake.ids.CONV_LUNA, 'hola');
  await store.resync('prueba');
  assert.ok(!fake.calls.some((c) => c.name === 'social_heartbeat'), 'no llama a social_heartbeat');
});

test('chat: cargar, recibir en vivo, marcar como leído y enviar', async (t) => {
  const { store, fake } = await setup();
  t.after(() => store.stop());
  const chatId = fake.ids.CONV_LUNA;
  await store.loadMessages(chatId);
  const chat = store.chat(chatId);
  assert.equal(chat.messages.length, 9);
  assert.equal(chat.messages[0].id, 'm1');

  // Mirando la conversación: lo que llega queda leído
  store.setActive(fake.ids.LUNA);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(chat.unread, 0);
  assert.ok(fake.calls.some((c) => c.name === 'social_mark_read'));
  const row = fake.receive(fake.ids.LUNA, chatId, 'en vivo');
  assert.ok(chat.messages.some((m) => m.id === row.id));
  assert.equal(chat.unread, 0);

  // Sin mirarla: suma
  store.setActive(null);
  fake.receive(fake.ids.LUNA, chatId, 'otro');
  assert.equal(chat.unread, 1);

  // Mismo evento dos veces: una sola fila
  const dup = fake.receive(fake.ids.LUNA, chatId, 'dup');
  store._onMessage('INSERT', dup);
  assert.equal(chat.messages.filter((m) => m.id === dup.id).length, 1);

  const sent = store.send(chatId, '  hola\r\nche  ');
  assert.equal(sent.body, 'hola\nche');
  assert.equal(sent._local, 'pending');
  await new Promise((resolve) => setTimeout(resolve, 5));
  const saved = chat.messages.find((m) => m.id === sent.id);
  assert.equal(saved._local, undefined);
  assert.equal(store._queue.length, 0);
  assert.equal(store.send(chatId, '   '), null);
  assert.throws(() => store.send(chatId, 'x'.repeat(2001)), /too_long/);
});

test('sin red el mensaje queda en cola y sale al volver; un rechazo se puede reintentar o descartar', async (t) => {
  const net = { onLine: true };
  const { store, fake } = await setup({ net });
  t.after(() => store.stop());
  const chatId = fake.ids.CONV_NICO;
  await store.loadMessages(chatId);
  const chat = store.chat(chatId);

  net.onLine = false;
  const queued = store.send(chatId, 'sin red');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(chat.messages.find((m) => m.id === queued.id)._local, 'pending');
  net.onLine = true;
  store.onNetwork(true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(chat.messages.find((m) => m.id === queued.id)._local, undefined);

  // Error de red: sigue pendiente y no se pierde
  fake.db.fail = { insert: { error: { message: 'Failed to fetch' }, status: 0 } };
  const retryable = store.send(chatId, 'reintenta');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(chat.messages.find((m) => m.id === retryable.id)._local, 'pending');
  fake.db.fail = null;
  store._flush();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(chat.messages.find((m) => m.id === retryable.id)._local, undefined);

  // Rechazo: silenciado
  fake.db.fail = { insert: { error: { message: 'user_muted', code: 'P0001' }, status: 400 } };
  const refused = store.send(chatId, 'rechazado');
  await new Promise((resolve) => setTimeout(resolve, 5));
  const failed = chat.messages.find((m) => m.id === refused.id);
  assert.equal(failed._local, 'failed');
  assert.equal(failed._error.message, 'user_muted');
  fake.db.fail = null;
  store.retry(refused.id);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(chat.messages.find((m) => m.id === refused.id)._local, undefined);

  fake.db.fail = { insert: { error: { message: 'user_muted', code: 'P0001' }, status: 400 } };
  const gone = store.send(chatId, 'descartado');
  await new Promise((resolve) => setTimeout(resolve, 5));
  store.discard(chatId, gone.id);
  fake.db.fail = null;
  assert.ok(!chat.messages.some((m) => m.id === gone.id));
  assert.equal(store._queue.length, 0);
});

test('tiempo real: borrado, leído, escribiendo, presencia, solicitudes y clips', async (t) => {
  const { store, fake } = await setup();
  t.after(() => store.stop());
  const chatId = fake.ids.CONV_LUNA;
  await store.loadMessages(chatId);
  const chat = store.chat(chatId);

  fake.deleteMessage('m9');
  assert.equal(chat.messages.find((m) => m.id === 'm9').deleted, true);
  assert.equal(chat.lastMessage.deleted, true);

  const at = new Date(Date.now() + 1000).toISOString();
  fake.read(chatId, at);
  assert.equal(store.isRead(chatId, chat.messages.find((m) => m.id === 'm7')), true);

  fake.typing(fake.ids.LUNA, chatId);
  assert.equal(store.isTyping(chatId), true);
  fake.receive(fake.ids.LUNA, chatId, 'ya está');
  assert.equal(store.isTyping(chatId), false);

  fake.activity({ user_id: fake.ids.MAIA, status: 'online', activity: { type: 'menu', mcVersion: '1.21' }, updated_at: new Date().toISOString() });
  assert.equal(store.friends.find((f) => f.id === fake.ids.MAIA).presence, 'online');
  assert.equal(store.friends.find((f) => f.id === fake.ids.MAIA).activity.type, 'menu');

  fake.request(fake.ids.JULI);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(store.incoming.some((r) => r.id === fake.ids.JULI));

  const before = store.inbox.clips.length;
  let media = 0;
  store.on('media', () => media++);
  fake.share(fake.ids.LUNA);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(media, 1);
  assert.equal(store.inbox.clips.length, before + 1);
});

test('una señal propia, un remitente raro o un formato inválido no hacen nada', async (t) => {
  const { store, fake } = await setup();
  t.after(() => store.stop());
  for (const msg of [null, 'x', { from: fake.ids.ME, kind: '_typing' }, { kind: '_typing' }, { from: 5, kind: '_typing' }, { from: fake.ids.SOFI, kind: '_typing', payload: {} }]) store._onSignal(msg);
  assert.equal(store.typing.size, 0);
});

test('amigos: aceptar, rechazar, cancelar y agregar', async (t) => {
  const { store, fake } = await setup();
  t.after(() => store.stop());
  await store.respond(fake.ids.PABLO, true);
  assert.equal(store.incoming.length, 0);
  assert.ok(store.friends.some((f) => f.id === fake.ids.PABLO));
  await store.cancelRequest(fake.ids.JULI);
  assert.equal(store.outgoing.length, 0);
  assert.equal((await store.addFriend('VENUS-ZZZZZZ')).result, 'sent');
  await assert.rejects(() => store.addFriend('VENUS-NOEXIS'), /user_not_found/);
  await assert.rejects(() => store.addFriend('a b'), /invalid_query/);
  await assert.rejects(() => store.addFriend('venus-a1b2c3'), /cannot_add_self/);
});

test('sin 0035: la app sigue andando y la bandeja se arma con lo que hay', async (t) => {
  const [{ createFakeClient }, { createBackend }, { Store }] = await modules;
  const client = createFakeClient();
  const realRpc = client.rpc;
  client.rpc = (name, args) => (name === 'app_inbox' ? Promise.resolve({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' }, status: 404 }) : realRpc(name, args));
  const store = new Store({ backend: createBackend(client, client.__fake.ids.ME), someone: 'Alguien', doc: { hidden: false }, net: { onLine: true } });
  t.after(() => store.stop());
  await store.start();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(store.inboxAvailable, false);
  assert.equal(store.inbox.messages.length, 1);
  assert.equal(store.inbox.requests.length, 1);
  assert.equal(store.inbox.clips.length, 0);
  assert.equal(store.state, 'ready');
});

test('stickers: vivo, borrado y sin 0030 (se ve como texto)', async (t) => {
  const { store, backend, client } = await setup();
  t.after(() => store.stop());
  assert.equal(await store.stickerStatus('0c000000-0000-4000-8000-000000000001'), true);
  assert.equal(await store.stickerStatus('0c000000-0000-4000-8000-000000000002'), false);
  void backend;
  client.rpc = () => Promise.resolve({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' }, status: 404 });
  assert.equal(await store.stickerStatus('0c000000-0000-4000-8000-000000000003'), undefined);
  assert.equal(await store.stickerStatus('0c000000-0000-4000-8000-000000000004'), undefined);
});

test('la galería se oculta sin error si la función no está', async () => {
  const [{ createFakeClient }, { createBackend }] = await modules;
  const sin = createFakeClient();
  assert.equal(await createBackend(sin, 'x').gallery(), undefined);
  const con = createFakeClient({ gallery: true });
  assert.equal((await createBackend(con, 'x').gallery()).items.length, 1);
});

test('un error del servidor al arrancar deja reintentar', async (t) => {
  const [{ createFakeClient }, { createBackend }, { Store }] = await modules;
  const client = createFakeClient();
  const realRpc = client.rpc;
  client.rpc = () => Promise.resolve({ data: null, error: { message: 'boom', code: 'XX000' }, status: 500 });
  const warn = console.warn;
  console.warn = () => {};
  const store = new Store({ backend: createBackend(client, client.__fake.ids.ME), someone: 'Alguien', doc: { hidden: false }, net: { onLine: true } });
  t.after(() => {
    console.warn = warn;
    return store.stop();
  });
  await store.start();
  assert.equal(store.state, 'error');
  client.rpc = realRpc;
  await store.start();
  assert.equal(store.state, 'ready');
});
