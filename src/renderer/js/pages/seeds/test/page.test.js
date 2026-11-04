import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from '../../../features/clans/test/renderer-harness.js';
import { parseSeed, randomSeed } from '../gen/rng.js';
import { VERSIONS, versionByKey, versionForGame } from '../gen/versions.js';

function pageHarness() {
  const ui = harness(), copies = [], dialogs = [], worlds = [];
  let mapEvents;
  class SeedMap {
    constructor(events) { mapEvents = events; this.el = ui.deps.h('map'); this.pop = ui.deps.h('pop'); }
    setWorld(world) { worlds.push(world); }
    setSlime() {} setDoubtful() {} setFilters() {} resize() {} destroy() {}
  }
  const { page } = ui.load(new URL('../../seeds.js', import.meta.url), {
    store: {}, parseSeed, randomSeed, VERSIONS, versionByKey, versionForGame, SeedMap,
    STRUCT_STYLE: { stronghold: {} }, BIOME_KEYS: new Map(), BIOME_CSS: new Map(), typesFor: () => [],
    copyText: (value) => copies.push(value), modal: (options) => { dialogs.push(options); return { close() {} }; },
    selectEl: () => ui.deps.h('select'), switchEl: () => ui.deps.h('switch'),
  }, ['page']);
  const close = page.render(ui.root, ['42']);
  const button = (text) => ui.nodes.find((n) => n.tag === 'button' && n.children.includes(`seeds.${text}`));
  return { ...ui, copies, dialogs, worlds, close, button, mapEvents, input: ui.find('sd-seed') };
}

test('copiar lee la semilla recién escrita sin esperar el debounce', async () => {
  const ui = pageHarness();
  try {
    ui.input.value = '123';
    await ui.input.fire('input');
    await ui.button('copy').fire('click');
    assert.deepEqual(ui.copies, ['123']);
    assert.equal(ui.worlds.at(-1).seed, 123n);
  } finally { ui.close(); }
});

test('usar semilla valida el campo actual y no reutiliza la anterior si está vacío', async () => {
  const ui = pageHarness();
  try {
    ui.input.value = 'nueva semilla';
    await ui.button('useButton').fire('click');
    assert.equal(ui.dialogs.at(-1).subtitle, String(parseSeed('nueva semilla').seed));
    ui.input.value = '   ';
    await ui.button('copy').fire('click');
    await ui.button('useButton').fire('click');
    assert.equal(ui.copies.length, 0);
    assert.equal(ui.dialogs.length, 1);
    assert.equal(ui.input['aria-invalid'], 'true');
  } finally { ui.close(); }
});


test('al cambiar la semilla se actualizan estructuras cercanas aunque conserven el identificador', async () => {
  const ui = pageHarness();
  try {
    const show = (x) => ui.mapEvents.onView({ biomes: [], counts: {}, hidden: [], near: [{ id: 'stronghold:0', kind: 'stronghold', type: 'stronghold', x, z: 30 }] });
    show(10);
    ui.input.value = '123';
    await ui.button('copy').fire('click');
    show(20);
    const position = ui.nodes.find((n) => n.hasClass('sd-near-pos') && n.isConnected);
    assert.equal(position.children[0], '20, 30');
  } finally { ui.close(); }
});
