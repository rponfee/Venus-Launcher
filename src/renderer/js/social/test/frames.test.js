'use strict';
// Marcos de perfil (4.6): catalogo, estilos con su CSS y su dibujo, nombres en es y en, y catalogo contra la migracion 0040.
// Uso: node --test "src/renderer/js/social/test/"
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const RENDERER = path.join(__dirname, '..', '..', '..'); // src/renderer
const ROOT = path.join(RENDERER, '..', '..');
const load = () => import(pathToFileURL(path.join(RENDERER, 'js', 'social', 'frames.js')).href);
const css = () => fs.readFileSync(path.join(RENDERER, 'styles', 'features', 'frames.css'), 'utf8');
const names = (lang) => {
  const src = fs.readFileSync(path.join(RENDERER, 'i18n', lang, 'rewards.js'), 'utf8');
  return new Set([...src.matchAll(/^\s+(item_(?:frame|pass_frame)_\w+):/gm)].map((m) => m[1]));
};

test('ids y estilos unicos; los de la tienda se llaman frame_<estilo> y los del Pase pass_frame_<n>', async () => {
  const F = await load();
  assert.equal(new Set(F.FRAME_CATALOG.map((f) => f.id)).size, F.FRAME_CATALOG.length);
  assert.equal(new Set(F.FRAME_STYLES).size, F.FRAME_STYLES.length);
  const shop = F.FRAME_CATALOG.filter((f) => f.source === 'shop');
  const pass = F.FRAME_CATALOG.filter((f) => f.source === 'pass');
  assert.equal(shop.length, 36);
  assert.equal(pass.length, 8);
  for (const f of shop) {
    assert.equal(f.id, `frame_${f.style}`);
    assert.ok(F.FRAME_CATEGORIES.includes(f.category), f.id);
    assert.ok(F.FRAME_RARITIES.includes(f.rarity), f.id);
    assert.ok(f.premiumOnly ? f.price === 0 : f.price >= 400 && f.price <= 3000, `${f.id} ${f.price}`);
  }
  pass.forEach((f, i) => assert.deepEqual([f.id, f.style, f.category, f.price], [`pass_frame_${i + 1}`, `pass${i + 1}`, 'pass', 0]));
  assert.ok(shop.some((f) => f.premiumOnly), 'hay marcos solo Premium');
  for (const old of F.RETIRED_FRAME_IDS) assert.equal(F.frameStyleOf(old), null, `${old} ya no se dibuja`);
});

test('cada estilo se dibuja (SVG propio, sin imagenes ni enlaces) y tiene su CSS', async () => {
  const F = await load();
  const sheet = css();
  for (const style of F.FRAME_STYLES) {
    const svg = F.frameSvg(style, { uid: 't' });
    assert.match(svg, new RegExp(`^<svg class="fr fr-${style}" `), style);
    assert.ok(!/<image|href=|xlink|<script|<foreignObject|url\((?!#)/i.test(svg), `${style}: nada externo`);
    assert.ok(sheet.includes(`.fr-${style} {`), `${style}: falta su bloque en frames.css`);
    // las clases de movimiento que usa el dibujo existen en la hoja
    for (const m of svg.matchAll(/class="([^"]+)"/g)) for (const c of m[1].split(/\s+/)) if (c !== 'fr' && c !== 'rev' && !c.startsWith('fr-')) assert.ok(sheet.includes(`.fr .${c}`), `${style}: falta .${c}`);
  }
  assert.equal(F.frameSvg('inexistente'), '');
});

test('resolver: id de la tienda, del Pase o estilo; registerFrameItems suma lo que dice shop_items.data', async () => {
  const F = await load();
  assert.equal(F.frameStyleOf('frame_flame'), 'flame');
  assert.equal(F.frameStyleOf('pass_frame_8'), 'pass8');
  assert.equal(F.frameStyleOf('flame'), 'flame');
  assert.equal(F.frameStyleOf('frame_gold'), null);
  assert.equal(F.frameStyleOf(null), null);
  F.registerFrameItems([{ id: 'evento_marco', kind: 'frame', data: { style: 'dragon' } }, { id: 'otro', kind: 'frame', data: { style: 'no-existe' } }]);
  assert.equal(F.frameStyleOf('evento_marco'), 'dragon');
  assert.equal(F.frameStyleOf('otro'), null);
  assert.equal(F.frameNameKey('frame_flame'), 'rewards.item_frame_flame');
});

test('buscador y filtros', async () => {
  const F = await load();
  const list = F.FRAME_CATALOG.filter((f) => f.source === 'shop');
  const nameOf = (id) => id.replace('frame_', '');
  assert.deepEqual(F.filterFrames(list, { query: 'phoe', nameOf }).map((f) => f.id), ['frame_phoenix']);
  assert.ok(F.filterFrames(list, { category: 'neon' }).every((f) => f.category === 'neon'));
  assert.ok(F.filterFrames(list, { rarity: 'legendary' }).every((f) => f.rarity === 'legendary'));
  assert.ok(F.filterFrames(list, { price: 'low' }).every((f) => !f.premiumOnly && f.price <= 800));
  assert.ok(F.filterFrames(list, { price: 'free' }).every((f) => f.premiumOnly));
  const secs = F.frameSections(list.map((item) => ({ item })), {});
  assert.deepEqual(secs.map((s) => s.category), F.FRAME_CATEGORIES);
  assert.equal(secs.reduce((n, s) => n + s.items.length, 0), 36);
});

test('cada marco tiene nombre en es y en (tienda y Pase) y las categorias y rarezas tambien', async () => {
  const F = await load();
  for (const lang of ['es', 'en']) {
    const have = names(lang);
    for (const f of F.FRAME_CATALOG) assert.ok(have.has(`item_${f.id}`), `${lang}: item_${f.id}`);
    const src = fs.readFileSync(path.join(RENDERER, 'i18n', lang, 'rewards.js'), 'utf8');
    for (const k of [...F.FRAME_CATEGORIES, 'all', 'mine', 'pass'].map((c) => `frames_cat_${c}`).concat(F.FRAME_RARITIES.map((r) => `rarity_${r}`))) assert.ok(src.includes(`  ${k}:`), `${lang}: ${k}`);
    assert.ok(!/cape/i.test(src.replace(/escape/gi, '')), `${lang}: sin textos de capas`);
  }
});

test('el catalogo coincide con la migracion 0040 (id, precio, solo Premium, estilo, sort) y 0040 retira los marcos anteriores', async () => {
  const F = await load();
  const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '0040_marcos_originales.sql'), 'utf8').replace(/\r\n/g, '\n');
  const rows = [...sql.matchAll(/\('(frame_\w+)', 'frame', (\d+), (true|false), (\d+), '\{"style":"(\w+)"\}', 'shop'\)/g)].map((m) => ({ id: m[1], price: Number(m[2]), premiumOnly: m[3] === 'true', sort: Number(m[4]), style: m[5] }));
  const shop = F.FRAME_CATALOG.filter((f) => f.source === 'shop');
  assert.deepEqual(rows, shop.map((f) => ({ id: f.id, price: f.price, premiumOnly: f.premiumOnly, sort: f.sort, style: f.style })));
  for (const id of F.RETIRED_FRAME_IDS) assert.ok(sql.includes(`'${id}'`), `0040 no menciona ${id}`);
  assert.match(sql, /set active = false/);
  assert.match(sql, /'refund:' \|\| l\.ref/);
  assert.doesNotMatch(sql, /create or replace function public\.(profile_customize|profile_public)/);
});
