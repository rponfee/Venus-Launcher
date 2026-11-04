// Capas de Venus: la lista fija tiene que ser la misma en el mod, en la migración, en las texturas y en los textos, y la tienda
// tiene que tratar la capa como un cosmético más sin mandarla a profile_customize.
// node --test "src/renderer/js/features/capes/test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CAPE_IDS, capeIdOf, knownCapes } from '../logic.js';
import { CAPE_TEXTURES } from '../textures.js';
import { CAPE_SLOT, KIND_ORDER, equipPatch, shopView } from '../../../pages/rewards/logic.js';

const root = new URL('../../../../../../', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, root), 'utf8');
const SQL = read('supabase/migrations/0034_capas.sql');

// Las filas de la migración: ('cape_dawn', 'cape', 1000, false, 400, '{"cape":"dawn"}')
const ROWS = [...SQL.matchAll(/\('(cape_[a-z0-9_]+)', 'cape', (\d+), (true|false), (\d+), '\{"cape":"([a-z0-9_]+)"\}'\)/g)].map(([, id, price, premium, sort, cape]) => ({ id, kind: 'cape', price: Number(price), premium_only: premium === 'true', sort: Number(sort), data: { cape } }));

test('la lista fija es la misma en el mod, la migración y las texturas', () => {
  const java = read('mod/venus-badge/src/main/java/com/venuslauncher/badge/Capes.java');
  const inJava = /List\.of\(([^)]*)\)/.exec(java)[1].split(',').map((s) => s.trim().replace(/"/g, ''));
  assert.deepEqual(CAPE_IDS, inJava);
  assert.deepEqual(ROWS.map((r) => r.data.cape), CAPE_IDS);
  assert.deepEqual(Object.keys(CAPE_TEXTURES), CAPE_IDS);
});

test('hay al menos una capa solo para Premium y las otras tienen precio', () => {
  assert.ok(ROWS.some((r) => r.premium_only && r.price === 0));
  assert.ok(ROWS.filter((r) => !r.premium_only).every((r) => r.price > 0));
});

test('la vista previa es el mismo PNG de 64x32 que trae el mod', () => {
  for (const id of CAPE_IDS) {
    const inMod = fs.readFileSync(new URL(`mod/venus-badge/src/main/resources/assets/venusbadge/textures/cape/${id}.png`, root));
    assert.equal(CAPE_TEXTURES[id], `data:image/png;base64,${inMod.toString('base64')}`, id);
    assert.equal(inMod.readUInt32BE(16), 64, id);
    assert.equal(inMod.readUInt32BE(20), 32, id);
  }
});

test('cada capa tiene nombre en español e inglés', () => {
  for (const lang of ['es', 'en']) {
    const texts = read(`src/renderer/i18n/${lang}/rewards.js`);
    assert.ok(texts.includes('kind_cape:'), lang);
    for (const r of ROWS) assert.ok(texts.includes(`item_${r.id}:`), `${lang} ${r.id}`);
  }
});

test('un id desconocido se ignora: no se dibuja ni se vende', () => {
  const dawn = ROWS[0];
  assert.equal(capeIdOf(dawn), 'dawn');
  assert.equal(capeIdOf({ kind: 'cape', data: { cape: 'capa-nueva' } }), null);
  assert.equal(capeIdOf({ kind: 'cape', data: { cape: 'constructor' } }), null);
  assert.equal(capeIdOf({ kind: 'frame', data: { cape: 'dawn' } }), null);
  assert.equal(capeIdOf(null), null);
  const frame = { id: 'frame_neon', kind: 'frame' };
  assert.deepEqual(knownCapes([frame, dawn, { id: 'cape_x', kind: 'cape', data: { cape: 'x' } }]), [frame, dawn]);
  assert.deepEqual(knownCapes(null), []);
});

test('la tienda muestra el estado de cada capa', () => {
  const opts = { owned: ['cape_dawn', 'cape_nebula'], premium: false, balance: 1500, equipped: { cape: 'cape_dawn' } };
  const group = shopView(ROWS, opts).find((g) => g.kind === 'cape');
  const state = Object.fromEntries(group.items.map((v) => [v.item.id, v.state]));
  assert.deepEqual(state, { cape_dawn: 'equipped', cape_nebula: 'owned', cape_aurora: 'buy', cape_magma: 'short', cape_orbit: 'premium' });
  assert.ok(group.items.every((v) => v.slot === CAPE_SLOT));
  assert.equal(group.items.find((v) => v.item.id === 'cape_magma').missing, 1000);
  // La premium viene incluida con Premium y, sin Premium, deja de figurar como puesta
  const premium = shopView(ROWS, { owned: [], premium: true, balance: 0, equipped: { cape: 'cape_orbit' } }).find((g) => g.kind === 'cape');
  assert.equal(premium.items.find((v) => v.item.id === 'cape_orbit').state, 'equipped');
  const lapsed = shopView(ROWS, { owned: [], premium: false, balance: 0, equipped: { cape: 'cape_orbit' } }).find((g) => g.kind === 'cape');
  assert.equal(lapsed.items.find((v) => v.item.id === 'cape_orbit').state, 'premium');
  assert.ok(KIND_ORDER.includes('cape'));
});

test('la capa nunca va a profile_customize', () => {
  const patch = equipPatch({ frame: 'frame_neon', cape: 'cape_dawn' }, 'frame', null, { items: ROWS, owned: ['cape_dawn'], premium: false });
  assert.deepEqual(Object.keys(patch).sort(), ['badgeStyle', 'frame', 'nameEffect', 'title']);
});
