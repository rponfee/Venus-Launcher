// Inicio armable: normalizacion de settings.home.layout, filas y movimientos.
// node --test "src/renderer/js/pages/home/test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';
import { BLOCKS, MAIN_BLOCKS, RAIL_BLOCKS, normalizeLayout, buildRows, moveBlock, reorder, isWide, toggleIn, visualOrder, sameLane, HERO_SIZES, normalizeHero } from '../layout.js';

const DEFAULT_ORDER = ['quick', 'worlds', 'featured', 'screenshots', 'news', 'server', 'friends', 'stats', 'tips'];

test('normalizeLayout: por defecto, el orden de siempre y nada oculto', () => {
  assert.deepEqual(normalizeLayout(undefined), { order: DEFAULT_ORDER, hidden: [], wide: [] });
  assert.deepEqual(normalizeLayout({}), { order: DEFAULT_ORDER, hidden: [], wide: [] });
  assert.deepEqual(normalizeLayout({ layout: 'x' }), { order: DEFAULT_ORDER, hidden: [], wide: [] });
  assert.deepEqual(BLOCKS, [...new Set([...MAIN_BLOCKS, ...RAIL_BLOCKS, 'quick'])].sort().length === BLOCKS.length ? BLOCKS : null);
});

test('normalizeLayout: ids desconocidos se descartan y los que faltan van al final', () => {
  const l = normalizeLayout({ layout: { order: ['news', 'zzz', 'quick', 'news', 5], hidden: ['tips', 'nope'], wide: ['friends', 'quick', 'x'] } });
  assert.deepEqual(l.order, ['news', 'quick', 'worlds', 'featured', 'screenshots', 'server', 'friends', 'stats', 'tips']);
  assert.deepEqual(l.hidden, ['tips']);
  assert.deepEqual(l.wide, ['friends']); // quick siempre es ancho: no se guarda
  assert.equal(isWide(l, 'quick'), true);
  assert.equal(isWide(l, 'friends'), true);
  assert.equal(isWide(l, 'news'), false);
});

test('normalizeLayout: sin layout lee home.hidden (2.x)', () => {
  assert.deepEqual(normalizeLayout({ hidden: ['news', 'bad'] }).hidden, ['news']);
  // con layout, manda layout.hidden aunque exista la clave vieja
  assert.deepEqual(normalizeLayout({ hidden: ['news'], layout: { hidden: ['tips'] } }).hidden, ['tips']);
});

test('buildRows: el layout vacio dibuja igual que siempre', () => {
  const rows = buildRows(normalizeLayout({}));
  assert.deepEqual(rows, [{ wide: 'quick' }, { main: MAIN_BLOCKS, rail: RAIL_BLOCKS }]);
});

test('buildRows: un bloque ancho corta las columnas y los no visibles no cuentan', () => {
  const l = normalizeLayout({ layout: { order: ['quick', 'worlds', 'server', 'news', 'friends', 'stats'], wide: ['news'] } });
  const rows = buildRows(l, (id) => id !== 'tips' && id !== 'featured' && id !== 'screenshots');
  assert.deepEqual(rows, [{ wide: 'quick' }, { main: ['worlds'], rail: ['server'] }, { wide: 'news' }, { main: [], rail: ['friends', 'stats'] }]);
  // si el ancho se oculta, las dos filas de columnas se juntan
  const joined = buildRows(l, (id) => !['tips', 'featured', 'screenshots', 'news'].includes(id));
  assert.deepEqual(joined, [{ wide: 'quick' }, { main: ['worlds'], rail: ['server', 'friends', 'stats'] }]);
});

test('reorder y toggleIn', () => {
  assert.deepEqual(reorder(['a', 'b', 'c'], 'c', 'a', true), ['c', 'a', 'b']);
  assert.deepEqual(reorder(['a', 'b', 'c'], 'a', 'c', false), ['b', 'c', 'a']);
  assert.deepEqual(reorder(['a', 'b', 'c'], 'a', 'a', true), ['a', 'b', 'c']);
  assert.deepEqual(reorder(['a', 'b', 'c'], 'x', 'a', true), ['a', 'b', 'c']);
  assert.deepEqual(toggleIn(['a'], 'b'), ['a', 'b']);
  assert.deepEqual(toggleIn(['a', 'b'], 'a'), ['b']);
});

test('moveBlock: un bloque de columna salta a su vecino de columna o a un bloque ancho', () => {
  const l = normalizeLayout({ layout: { order: ['quick', 'worlds', 'server', 'news', 'friends'], wide: ['news'] } });
  const vis = (id) => ['quick', 'worlds', 'server', 'news', 'friends'].includes(id);
  // friends (lateral) sube: pasa por encima de news (ancho) y queda en la fila de server
  let order = moveBlock(l, 'friends', -1, vis);
  assert.deepEqual(order.slice(0, 5), ['quick', 'worlds', 'server', 'friends', 'news']);
  // y otra vez: ahora por encima de server
  order = moveBlock({ ...l, order }, 'friends', -1, vis);
  assert.deepEqual(order.slice(0, 5), ['quick', 'worlds', 'friends', 'server', 'news']);
  // worlds (principal) no tiene con quien cambiar hacia arriba salvo quick (ancho)
  order = moveBlock(l, 'worlds', -1, vis);
  assert.deepEqual(order.slice(0, 2), ['worlds', 'quick']);
  // bajar friends al final: no hay vecino, queda igual
  assert.deepEqual(moveBlock(l, 'friends', 1, vis), l.order);
  assert.ok(sameLane(l, 'friends', 'news'));
  assert.ok(sameLane(l, 'friends', 'server'));
  assert.ok(!sameLane(l, 'friends', 'worlds'));
});

test('moveBlock: un bloque ancho salta filas enteras', () => {
  const l = normalizeLayout({ layout: { order: ['quick', 'worlds', 'server', 'news', 'friends', 'stats'], wide: ['news'] } });
  const vis = (id) => ['quick', 'worlds', 'server', 'news', 'friends', 'stats'].includes(id);
  // news sube por encima de la fila worlds/server completa
  let order = moveBlock(l, 'news', -1, vis);
  assert.deepEqual(order.slice(0, 6), ['quick', 'news', 'worlds', 'server', 'friends', 'stats']);
  // y baja por debajo de la fila friends/stats
  order = moveBlock(l, 'news', 1, vis);
  assert.deepEqual(order.slice(0, 6), ['quick', 'worlds', 'server', 'friends', 'stats', 'news']);
  // quick (siempre ancho) arriba de todo: no se mueve mas
  assert.deepEqual(moveBlock(l, 'quick', -1, vis), l.order);
  // un bloque oculto no se mueve
  assert.deepEqual(moveBlock(l, 'tips', -1, vis), l.order);
});

test('visualOrder recorre filas y columnas', () => {
  const l = normalizeLayout({ layout: { order: ['quick', 'worlds', 'server', 'news', 'friends'], wide: ['news'] } });
  assert.deepEqual(visualOrder(l, (id) => ['quick', 'worlds', 'server', 'news', 'friends'].includes(id)), ['quick', 'worlds', 'server', 'news', 'friends']);
});

// 6.1: tamaño de la tarjeta principal y orden guardado junto con ella
test('normalizeHero: grande por defecto, compacta si se eligio y cualquier otra cosa vuelve a grande', () => {
  assert.deepEqual(HERO_SIZES, ['large', 'compact']);
  assert.equal(normalizeHero(undefined), 'large');
  assert.equal(normalizeHero({}), 'large');
  assert.equal(normalizeHero({ hero: 'compact' }), 'compact');
  assert.equal(normalizeHero({ hero: 'enorme' }), 'large');
  assert.equal(normalizeHero('compact'), 'large');
});

test('el orden del Inicio no depende del tamaño de la tarjeta principal y se mueve con el teclado', () => {
  const home = { hero: 'compact', layout: { order: ['news', 'quick'], hidden: ['tips'], wide: [] } };
  const l = normalizeLayout(home);
  assert.deepEqual(l.order.slice(0, 2), ['news', 'quick']);
  assert.equal(normalizeHero(home), 'compact');
  // subir 'worlds' lo pone antes del vecino de arriba (los accesos rapidos, que van a lo ancho)
  const up = moveBlock(l, 'worlds', -1);
  assert.deepEqual(up.slice(0, 3), ['news', 'worlds', 'quick']);
  // bajar el ultimo de una columna no hace nada
  const last = visualOrder(l).filter((id) => !isWide(l, id) && RAIL_BLOCKS.includes(id)).pop();
  assert.deepEqual(moveBlock(l, last, 1), l.order);
});
