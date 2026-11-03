// Menu lateral a gusto: normalizacion de settings.nav y orden final con fijados y ocultos.
// node --test "src/renderer/js/features/navcustom/test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNav, navLayout, sections, sortByOrder, orderFromSections, moveInSection, dropInSection, toggleIn, canHide } from '../logic.js';

const NAV = [
  { group: 'play' },
  { id: 'home', icon: 'home' },
  { id: 'venus', icon: 'globe' },
  { id: 'versions', icon: 'layers' },
  { id: 'worlds', icon: 'globe' },
  { group: 'content' },
  { id: 'modrinth', icon: 'package' },
  { id: 'smartsearch', icon: 'sparkles' },
  { group: 'online' },
  { id: 'multiplayer', icon: 'wifi' },
  { id: 'messages', icon: 'message' },
];
const IDS = NAV.filter((n) => n.id).map((n) => n.id);
const flat = (list) => list.map((e) => (e.group ? `[${e.group}]` : e.id));

test('normalizeNav: valores por defecto y basura', () => {
  assert.deepEqual(normalizeNav(undefined, IDS), { order: [], hidden: [], pinned: [], iconPack: 'outline' });
  assert.deepEqual(normalizeNav(null, IDS), { order: [], hidden: [], pinned: [], iconPack: 'outline' });
  assert.deepEqual(normalizeNav('x', IDS), { order: [], hidden: [], pinned: [], iconPack: 'outline' });
  assert.deepEqual(normalizeNav({ order: 'home', hidden: 3, pinned: {}, iconPack: 'neon' }, IDS), { order: [], hidden: [], pinned: [], iconPack: 'outline' });
});

test('normalizeNav: ids desconocidos y repetidos se descartan; home nunca oculto', () => {
  const n = normalizeNav({ order: ['worlds', 'nope', 'home', 'worlds', 7], hidden: ['home', 'messages', 'ghost'], pinned: ['venus', 'venus', 'x'], iconPack: 'pixel' }, IDS);
  assert.deepEqual(n.order, ['worlds', 'home']);
  assert.deepEqual(n.hidden, ['messages']);
  assert.deepEqual(n.pinned, ['venus']);
  assert.equal(n.iconPack, 'pixel');
  assert.equal(normalizeNav({ iconPack: 'filled' }, IDS).iconPack, 'filled');
  assert.equal(canHide('home'), false);
  assert.equal(canHide('messages'), true);
});

test('navLayout: sin preferencias deja el menu como esta', () => {
  assert.deepEqual(flat(navLayout(NAV, normalizeNav({}, IDS))), flat(NAV));
  assert.deepEqual(flat(navLayout(NAV, undefined)), flat(NAV));
});

test('navLayout: fijados arriba de todo, ocultos afuera, orden por seccion', () => {
  const prefs = normalizeNav({ order: ['worlds', 'versions', 'smartsearch', 'modrinth'], hidden: ['multiplayer'], pinned: ['messages', 'venus'] }, IDS);
  assert.deepEqual(flat(navLayout(NAV, prefs)), ['[pinned]', 'messages', 'venus', '[play]', 'worlds', 'versions', 'home', '[content]', 'smartsearch', 'modrinth', '[online]']);
});

test('navLayout: un fijado oculto no aparece ni arriba ni en su seccion', () => {
  const prefs = normalizeNav({ pinned: ['venus'], hidden: ['venus'] }, IDS);
  const out = flat(navLayout(NAV, prefs));
  assert.ok(!out.includes('venus'));
  assert.ok(!out.includes('[pinned]'));
});

test('navLayout: una pagina registrada despues del orden va al final de su seccion', () => {
  const prefs = normalizeNav({ order: ['messages', 'multiplayer'] }, IDS);
  const withAdmin = [...NAV, { id: 'admin', icon: 'shieldCheck' }];
  assert.deepEqual(flat(navLayout(withAdmin, prefs)).slice(-3), ['messages', 'multiplayer', 'admin']);
});

test('sections y sortByOrder', () => {
  const secs = sections(NAV);
  assert.deepEqual(
    secs.map((s) => [s.group, s.items.length]),
    [
      ['play', 4],
      ['content', 2],
      ['online', 2],
    ],
  );
  assert.deepEqual(sections([{ id: 'a' }, { group: 'g' }, { id: 'b' }]).map((s) => s.group), [null, 'g']);
  assert.deepEqual(
    sortByOrder(secs[0].items, ['worlds', 'home']).map((e) => e.id),
    ['worlds', 'home', 'venus', 'versions'],
  );
});

test('moveInSection, dropInSection y orderFromSections', () => {
  let secs = sections(NAV);
  secs = moveInSection(secs, 'worlds', -1);
  assert.deepEqual(secs[0].items.map((e) => e.id), ['home', 'venus', 'worlds', 'versions']);
  secs = moveInSection(secs, 'home', -1); // ya esta arriba
  assert.deepEqual(secs[0].items.map((e) => e.id), ['home', 'venus', 'worlds', 'versions']);
  secs = dropInSection(secs, 'versions', 'home', true);
  assert.deepEqual(secs[0].items.map((e) => e.id), ['versions', 'home', 'venus', 'worlds']);
  secs = dropInSection(secs, 'versions', 'messages', true); // otra seccion: no cambia
  assert.deepEqual(secs[0].items.map((e) => e.id), ['versions', 'home', 'venus', 'worlds']);
  secs = dropInSection(secs, 'home', 'worlds', false);
  assert.deepEqual(secs[0].items.map((e) => e.id), ['versions', 'venus', 'worlds', 'home']);
  assert.deepEqual(orderFromSections(secs), ['versions', 'venus', 'worlds', 'home', 'modrinth', 'smartsearch', 'multiplayer', 'messages']);
});

test('toggleIn', () => {
  assert.deepEqual(toggleIn(['a'], 'b'), ['a', 'b']);
  assert.deepEqual(toggleIn(['a', 'b'], 'a'), ['b']);
  assert.deepEqual(toggleIn(['a'], 'a', true), ['a']);
  assert.deepEqual(toggleIn(['a'], 'b', false), ['a']);
});
