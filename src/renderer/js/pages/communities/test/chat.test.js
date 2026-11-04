import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, deferred, flush } from '../../../features/clans/test/renderer-harness.js';
import { COMMUNITY_LIMITS, validateMessage } from '../../../features/clans/logic.js';
import * as logic from '../logic.js';

function chatHarness() {
  const ui = harness(), pending = deferred(), sent = [];
  let watch, stops = 0;
  const b = {
    userId: () => 'me', isBlocked: () => false,
    rpc: (name, args) => {
      if (name === 'community_messages_page') return Promise.resolve([]);
      if (name === 'community_send') { sent.push(args); return pending.promise; }
      throw new Error(name);
    },
    watchChannel: (id, handlers) => { watch = handlers; return () => stops++; },
  };
  const community = { id: 'community', name: 'Prueba', myRole: 'member', mutedUntil: null };
  const { chatView } = ui.load(new URL('../chat.js', import.meta.url), { ...logic, COMMUNITY_LIMITS, validateMessage }, ['chatView']);
  const chat = chatView(ui.root, { b, community, channel: { id: 'channel', name: 'general' }, people: new Map() });
  return { ...ui, pending, sent, chat, community, watch, stops: () => stops, input: ui.find('cm-input'), send: ui.find('cm-send') };
}

test('Enter repetido durante un envío produce un solo mensaje y conserva el borrador siguiente', async () => {
  const ui = chatHarness();
  try {
    await flush();
    ui.input.value = 'primero';
    const first = ui.input.fire('keydown', { key: 'Enter' });
    ui.chat.setCommunity(ui.community);
    assert.equal(ui.send.disabled, true);
    await ui.input.fire('keydown', { key: 'Enter' });
    assert.equal(ui.sent.length, 1);
    ui.input.value = 'borrador siguiente';
    ui.pending.resolve({ id: 'm1', authorId: 'me', at: '2026-11-03T10:00:00Z', body: 'primero' });
    await first;
    await flush();
    assert.equal(ui.input.value, 'borrador siguiente');
    assert.equal(ui.send.disabled, false);
  } finally { ui.pending.resolve(null); ui.chat.destroy(); }
});

test('un envío tardío no enfoca un chat cerrado ni borra su borrador', async () => {
  const ui = chatHarness();
  await flush();
  ui.input.value = 'mensaje';
  ui.input.fire('keydown', { key: 'Enter' });
  ui.chat.destroy();
  ui.pending.resolve({ id: 'm1', body: 'mensaje' });
  await flush();
  assert.equal(ui.input.focuses, 0);
  assert.equal(ui.input.value, 'mensaje');
  assert.equal(ui.stops(), 1);
  assert.equal(ui.intervals.size, 0);
});

test('un rechazo conserva el borrador y permite reintentar', async () => {
  const ui = chatHarness();
  try {
    ui.input.value = 'mensaje';
    ui.input.fire('keydown', { key: 'Enter' });
    ui.pending.reject({ code: 'network' });
    await flush();
    assert.equal(ui.input.value, 'mensaje');
    assert.equal(ui.send.disabled, false);
    assert.equal(ui.errors.length, 1);
  } finally { ui.chat.destroy(); }
});
