// Reseñas de servidores: lo que llega de la base es de otros usuarios y se normaliza antes de mostrarse.
// node --test "src/renderer/js/features/serverreviews/test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_BODY, isUuid, canReview, cleanBody, bodyLength, normalizeStats, normalizeEntry, normalizeList, canVoteAt, hoursLeft, filledStars, classifyError } from '../logic.js';

const ID = '00000000-0000-4000-8000-000000000001';

test('solo los destacados de la nube tienen reseñas', () => {
  assert.equal(canReview({ id: ID, source: 'cloud' }), true);
  assert.equal(canReview({ id: ID, source: 'cache' }), true);
  assert.equal(canReview({ id: ID, source: 'bundled' }), false);
  assert.equal(canReview({ id: 'hypixel', source: 'cloud' }), false);
  assert.equal(canReview(null), false);
  assert.equal(isUuid(ID), true);
  assert.equal(isUuid(`${ID}x`), false);
  assert.equal(isUuid(5), false);
});

test('texto: sin controles, con el tope y sin tocar el HTML (se muestra como texto)', () => {
  assert.equal(cleanBody('  hola  '), 'hola');
  assert.equal(cleanBody('a\nb\tc'), 'a\nb\tc');
  assert.equal(cleanBody(`a${String.fromCharCode(1)}b${String.fromCharCode(127)}c`), 'abc');
  assert.equal(cleanBody('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>');
  assert.equal(cleanBody('x'.repeat(5000)).length, MAX_BODY);
  assert.equal(cleanBody('x'.repeat(5000), 32).length, 32);
  assert.equal(cleanBody(null), '');
  assert.equal(cleanBody(undefined), '');
  assert.equal(bodyLength('  ñandú  '), 5);
});

test('números: lo raro queda en cero o sin promedio', () => {
  assert.deepEqual(normalizeStats({ avg: '4.25', count: 3, votes: '12' }), { avg: 4.25, count: 3, votes: 12 });
  assert.deepEqual(normalizeStats({ avg: null }), { avg: null, count: 0, votes: 0 });
  assert.deepEqual(normalizeStats(undefined), { avg: null, count: 0, votes: 0 });
  assert.deepEqual(normalizeStats({ avg: 'x', count: -4, votes: 'y' }), { avg: null, count: 0, votes: 0 });
  assert.equal(normalizeStats({ avg: 99 }).avg, 5);
});

test('una reseña: estrellas acotadas, autor limpio, nombre de Minecraft validado', () => {
  const e = normalizeEntry({ id: ID, stars: 9, body: ' x ', at: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:30Z', mine: 'true', hidden: 'si', author: { displayName: 'A'.repeat(99), mcName: '../../evil' } });
  assert.equal(e.stars, 5);
  assert.equal(e.body, 'x');
  assert.equal(e.edited, false);
  assert.equal(e.mine, false);
  assert.equal(e.hidden, false);
  assert.equal(e.author.name.length, 32);
  assert.equal(e.author.mcName, null);
  assert.equal(normalizeEntry({ id: ID, stars: 0 }).stars, 1);
  assert.equal(normalizeEntry({ id: ID, at: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:05:00Z' }).edited, true);
  assert.equal(normalizeEntry({ id: ID, author: { username: 'Steve_1', mcName: 'Steve_1' } }).author.mcName, 'Steve_1');
  for (const bad of [null, 'x', {}, { id: 'no-es-uuid' }]) assert.equal(normalizeEntry(bad), null);
});

test('la lista descarta filas rotas y lee el voto y la página siguiente', () => {
  const l = normalizeList({ avg: 4, count: 2, votes: 9, mine: { id: ID, stars: 3 }, vote: { total: 2, nextAt: '2030-01-01T00:00:00Z' }, items: [{ id: ID, stars: 1 }, { id: 'x' }, null], next: '2026-01-01T00:00:00Z' });
  assert.equal(l.items.length, 1);
  assert.equal(l.mine.stars, 3);
  assert.equal(l.vote.total, 2);
  assert.equal(l.next, '2026-01-01T00:00:00Z');
  const empty = normalizeList(null);
  assert.deepEqual(empty, { avg: null, count: 0, votes: 0, mine: null, vote: null, items: [], next: null });
});

test('voto: cada 24 h', () => {
  assert.equal(canVoteAt(null, 1000), true);
  assert.equal(canVoteAt({ nextAt: null }, 1000), true);
  assert.equal(canVoteAt({ nextAt: 2000 }, 1000), false);
  assert.equal(canVoteAt({ nextAt: 1000 }, 1000), true);
  assert.equal(hoursLeft({ nextAt: 1000 }, 1000), 0);
  assert.equal(hoursLeft({ nextAt: 1001 }, 1000), 1);
  assert.equal(hoursLeft({ nextAt: 3600000 * 5 + 1 }, 1), 5);
  assert.equal(hoursLeft(null, 1), 0);
});

test('estrellas pintadas', () => {
  assert.equal(filledStars(null), 0);
  assert.equal(filledStars(4.5), 5);
  assert.equal(filledStars(4.49), 4);
  assert.equal(filledStars(1), 1);
  assert.equal(filledStars(99), 5);
});

test('errores: los códigos de la base, sin servicio, sin red y el resto', () => {
  for (const code of ['not_authenticated', 'user_banned', 'user_muted', 'bad_stars', 'too_fast', 'too_many_today', 'own_review']) assert.equal(classifyError({ message: code, code: '22023' }), code);
  assert.equal(classifyError({ code: 'PGRST202', message: 'Could not find the function' }), 'unavailable');
  assert.equal(classifyError({ code: '42883', message: 'function does not exist' }), 'unavailable');
  assert.equal(classifyError(new TypeError('Failed to fetch')), 'network');
  assert.equal(classifyError({ message: 'cualquier otra cosa', code: 'XX000' }), 'server');
  assert.equal(classifyError(undefined), 'server');
  assert.equal(classifyError({ reviewsCode: 'too_fast' }), 'too_fast');
  // Un texto que no sea un código conocido no se muestra nunca: va a 'server'
  assert.equal(classifyError({ message: '<b>hola</b>' }), 'server');
});
