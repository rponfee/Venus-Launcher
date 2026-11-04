const { default: test } = await import('node:test');
const { default: assert } = await import('node:assert/strict');
const L = await import('../logic.js');

const msg = (id, at, extra = {}) => ({ id, at, authorId: 'a', body: id, deleted: false, ...extra });

test('moderar: el dueño a cualquiera, el moderador a miembros y nadie a sí mismo', () => {
  assert.equal(L.canModerate('owner', 'moderator'), true);
  assert.equal(L.canModerate('owner', 'member'), true);
  assert.equal(L.canModerate('owner', 'owner'), false);
  assert.equal(L.canModerate('moderator', 'member'), true);
  assert.equal(L.canModerate('moderator', 'moderator'), false);
  assert.equal(L.canModerate('moderator', 'owner'), false);
  assert.equal(L.canModerate('member', 'member'), false);
  assert.equal(L.canModerate('owner', 'member', { self: true }), false);
  assert.equal(L.canModerate(null, 'member'), false);
});

test('borrar y denunciar mensajes', () => {
  const mine = msg('1', 'x', { authorId: 'me' });
  const other = msg('2', 'x', { authorId: 'b' });
  assert.equal(L.canDeleteMessage(mine, 'me', 'member'), true);
  assert.equal(L.canDeleteMessage(other, 'me', 'member'), false);
  assert.equal(L.canDeleteMessage(other, 'me', 'moderator'), true);
  assert.equal(L.canDeleteMessage(other, 'me', 'owner'), true);
  assert.equal(L.canDeleteMessage({ ...other, deleted: true }, 'me', 'owner'), false);
  assert.equal(L.canDeleteMessage(mine, 'me', null), false);
  assert.equal(L.canReportMessage(other, 'me'), true);
  assert.equal(L.canReportMessage(mine, 'me'), false);
  assert.equal(L.canReportMessage({ ...other, deleted: true }, 'me'), false);
});

test('canales: orden, tipos y cuál abrir', () => {
  const channels = [{ id: 'v', kind: 'voice', position: 1 }, { id: 't2', kind: 'text', position: 2 }, { id: 't1', kind: 'text', position: 0 }];
  const { text, voice, all } = L.channelsByKind(channels);
  assert.deepEqual(text.map((c) => c.id), ['t1', 't2']);
  assert.deepEqual(voice.map((c) => c.id), ['v']);
  assert.deepEqual(all.map((c) => c.id), ['t1', 'v', 't2']);
  assert.deepEqual(L.channelsByKind(null), { text: [], voice: [], all: [] });
  assert.equal(L.pickChannel(channels, 't2').id, 't2');
  assert.equal(L.pickChannel(channels, 'v').id, 't1', 'un canal de voz no se abre como chat');
  assert.equal(L.pickChannel(channels, 'no').id, 't1');
  assert.equal(L.pickChannel([{ id: 'v', kind: 'voice' }], null), null);
});

test('mover un canal', () => {
  assert.deepEqual(L.moveChannel(['a', 'b', 'c'], 'b', -1), ['b', 'a', 'c']);
  assert.deepEqual(L.moveChannel(['a', 'b', 'c'], 'b', 1), ['a', 'c', 'b']);
  assert.equal(L.moveChannel(['a', 'b'], 'a', -1), null);
  assert.equal(L.moveChannel(['a', 'b'], 'b', 1), null);
  assert.equal(L.moveChannel(['a'], 'z', 1), null);
});

test('juntar mensajes: sin repetir, en orden y un borrado no se deshace', () => {
  const a = msg('a', '2026-11-01T10:00:00Z');
  const b = msg('b', '2026-11-01T10:01:00Z');
  assert.deepEqual(L.mergeMessages([b], [a, b]).map((m) => m.id), ['a', 'b']);
  const gone = L.mergeMessages([a], [{ ...a, deleted: true, body: '' }]);
  assert.equal(gone[0].deleted, true);
  assert.equal(gone[0].body, '');
  const again = L.mergeMessages(gone, [a]);
  assert.equal(again[0].deleted, true, 'una página vieja no revive lo borrado');
  assert.equal(again[0].body, '');
  const kept = L.mergeMessages([{ ...a, author: { userId: 'a' } }], [{ ...a, author: null }]);
  assert.deepEqual(kept[0].author, { userId: 'a' });
  assert.deepEqual(L.mergeMessages(null, [null, {}]), []);
});

test('fila de Realtime a mensaje', () => {
  const row = { id: 'x', channel_id: 'c', community_id: 'm', author: 'u', created_at: '2026-11-01T10:00:00Z', deleted: false, body: 'hola' };
  const people = new Map([['u', { userId: 'u', displayName: 'U' }]]);
  const m = L.messageFromRow(row, { people, isBlocked: () => false });
  assert.equal(m.body, 'hola');
  assert.equal(m.author.displayName, 'U');
  assert.equal(L.messageFromRow(row, { people: new Map() }).author, null);
  const hidden = L.messageFromRow(row, { people, isBlocked: (id) => id === 'u' });
  assert.equal(hidden.hidden, true);
  assert.equal(hidden.body, '', 'lo de una cuenta bloqueada no se guarda');
  assert.equal(L.messageFromRow({ ...row, deleted: true }, {}).body, '');
  assert.equal(L.messageFromRow({ id: 'x' }, {}), null);
  assert.equal(L.messageFromRow(null, {}), null);
});

test('agrupar mensajes por autor y cercanía', () => {
  const list = [
    msg('1', '2026-11-01T10:00:00Z'),
    msg('2', '2026-11-01T10:04:00Z'),
    msg('3', '2026-11-01T10:10:00Z'),
    msg('4', '2026-11-01T10:11:00Z', { authorId: 'b' }),
  ];
  const groups = L.groupMessages(list);
  assert.deepEqual(groups.map((g) => g.items.map((m) => m.id)), [['1', '2'], ['3'], ['4']]);
  assert.deepEqual(L.groupMessages([]), []);
  assert.equal(L.oldestAt(list), '2026-11-01T10:00:00Z');
  assert.equal(L.oldestAt([]), null);
});

test('formatos', () => {
  assert.equal(L.personName({ displayName: ' Luna ', username: 'x' }), 'Luna');
  assert.equal(L.personName({ username: 'x' }), 'x');
  assert.equal(L.personName(null), '');
  assert.equal(L.isMuted('2026-11-01T10:00:00Z', Date.parse('2026-11-01T09:00:00Z')), true);
  assert.equal(L.isMuted('2026-11-01T10:00:00Z', Date.parse('2026-11-01T11:00:00Z')), false);
  assert.equal(L.isMuted(null), false);
  const v = L.voiceSummary([1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ userId: n })));
  assert.equal(v.count, 8);
  assert.equal(v.full, true);
  assert.equal(v.shown.length, 4);
  assert.equal(v.extra, 4);
  assert.deepEqual(L.voiceSummary(null), { count: 0, full: false, shown: [], extra: 0 });
});
