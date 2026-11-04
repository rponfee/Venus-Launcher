import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, flush } from '../../../features/clans/test/renderer-harness.js';
import * as logic from '../logic.js';

function viewHarness() {
  const ui = harness(), chats = [];
  let value = { id: 'c', name: 'Comunidad', myRole: 'member', channels: [{ id: 'a', kind: 'text', name: 'general' }] };
  const b = { userId: () => 'me', rpc: async (name) => {
    if (name === 'community_get') { if (value instanceof Error) throw value; return value; }
    if (name === 'community_members_list') return { members: [], total: 1 };
    throw new Error(name);
  } };
  const { communityView } = ui.load(new URL('../view.js', import.meta.url), {
    ...logic, chatView: (host, { channel }) => {
      const item = { channel, stopped: false, updates: 0, destroy() { this.stopped = true; }, setCommunity() { this.updates++; } };
      chats.push(item); ui.deps.mount(host, ui.deps.h('chat')); return item;
    },
  }, ['communityView']);
  const close = communityView(ui.root, 'c', 'a', { b });
  return { ...ui, chats, close, set: (next) => { value = next; }, refresh: async () => { for (const fn of ui.intervals.values()) fn(); await flush(); } };
}

test('si borran el canal abierto, el refresco abre el siguiente y cierra el anterior', async () => {
  const ui = viewHarness();
  try {
    await flush();
    ui.set({ id: 'c', name: 'Comunidad', myRole: 'member', channels: [{ id: 'b', kind: 'text', name: 'otro' }] });
    await ui.refresh();
    assert.equal(ui.chats[0].stopped, true);
    assert.equal(ui.chats.at(-1).channel.id, 'b');
    ui.set({ id: 'c', name: 'Comunidad', myRole: 'member', channels: [] });
    await ui.refresh();
    assert.equal(ui.chats.at(-1).stopped, true);
    assert.equal(ui.find('cm-chat').children[0].tag, 'empty');
  } finally { ui.close(); }
});

test('si deja de ser miembro, se cierra el chat y aparece la vista previa', async () => {
  const ui = viewHarness();
  try {
    await flush();
    ui.set({ id: 'c', name: 'Comunidad', myRole: null, channels: [], bannedHere: false });
    await ui.refresh();
    assert.equal(ui.chats[0].stopped, true);
    assert.ok(ui.nodes.some((n) => n.hasClass('cm-preview') && n.isConnected));
  } finally { ui.close(); }
});

test('si desaparece la comunidad se cierra el chat; un error de red no lo destruye', async () => {
  const ui = viewHarness();
  try {
    await flush();
    ui.set(Object.assign(new Error('sin red'), { code: 'network' }));
    await ui.refresh();
    assert.equal(ui.chats[0].stopped, false);
    ui.set(Object.assign(new Error('no existe'), { code: 'not_found' }));
    await ui.refresh();
    assert.equal(ui.chats[0].stopped, true);
    assert.equal(ui.root.children.at(-1).tag, 'empty');
  } finally { ui.close(); }
});
