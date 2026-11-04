import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, deferred, flush } from './renderer-harness.js';
import * as logic from '../logic.js';

test('una respuesta tardía de Mi clan no pisa la pestaña de búsqueda', async () => {
  const ui = harness(), pending = deferred();
  const mine = { data: { clan: { id: 'clan', name: 'Prueba' } }, error: null };
  const b = { signedIn: () => true, userId: () => 'me', onAuth: () => () => {}, rpc: async () => [] };
  const { page } = ui.load(new URL('../../../pages/clans.js', import.meta.url), {
    ...logic, groupsBackend: async () => b, getMine: () => mine, loadMine: () => pending.promise,
    clanSharingCard: () => Object.assign(ui.deps.h('sharing'), { destroy() {} }),
    clanProfile: () => ui.deps.h('clan-profile'), forgetClanTags() {}, debounce: (fn) => fn,
  }, ['page']);
  const close = await page.render(ui.root, ['mine']);
  try {
    const browse = ui.nodes.find((n) => n.dataset.tab === 'browse');
    await browse.fire('click');
    await flush();
    assert.equal(ui.find('cl-search').isConnected, true);
    pending.resolve(mine);
    await flush();
    assert.equal(ui.find('cl-search').isConnected, true);
    assert.equal(ui.nodes.some((n) => n.tag === 'clan-profile' && n.isConnected), false);
  } finally { close?.(); }
});
