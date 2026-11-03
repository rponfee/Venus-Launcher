// Favoritos, etiquetas y tareas pendientes de Mis instancias. node --test "src/renderer/js/pages/versions/test/"
import test from 'node:test';
import assert from 'node:assert/strict';
import { tagsOf, isFavorite, pendingTaskCount, collectTags, hasTag, filterByMeta, favoritesFirst, matchesInstance, sortInstances } from '../catalog.js';

const A = { id: 'a', name: 'Aventura', mcVersion: '1.21', loader: 'fabric', tags: ['Survival', 'Amigos'], favorite: true, lastPlayed: 10 };
const B = { id: 'b', name: 'Base', mcVersion: '1.20.1', loader: 'forge', tags: ['survival'], favorite: false, lastPlayed: 30, notes: { tasks: [{ text: 'x', done: false }, { text: 'y', done: true }] } };
const C = { id: 'c', name: 'Creativo', mcVersion: '1.21', loader: 'vanilla', lastPlayed: 20 };

test('tagsOf, isFavorite y pendingTaskCount toleran instancias sin metadatos', () => {
  assert.deepEqual(tagsOf(C), []);
  assert.deepEqual(tagsOf({ tags: ['a', 3, '', null] }), ['a']);
  assert.equal(isFavorite(A), true);
  assert.equal(isFavorite(B), false);
  assert.equal(isFavorite({ favorite: 'true' }), false);
  assert.equal(pendingTaskCount(B), 1);
  assert.equal(pendingTaskCount(C), 0);
});

test('collectTags junta sin distinguir mayusculas y ordena por uso', () => {
  assert.deepEqual(collectTags([A, B, C]), [
    { tag: 'Survival', count: 2 },
    { tag: 'Amigos', count: 1 },
  ]);
  assert.deepEqual(collectTags([]), []);
});

test('filterByMeta: favoritas y etiqueta (sin distinguir mayusculas)', () => {
  assert.deepEqual(filterByMeta([A, B, C], { favorites: true }).map((i) => i.id), ['a']);
  assert.deepEqual(filterByMeta([A, B, C], { tag: 'SURVIVAL' }).map((i) => i.id), ['a', 'b']);
  assert.deepEqual(filterByMeta([A, B, C], { favorites: true, tag: 'amigos' }).map((i) => i.id), ['a']);
  assert.deepEqual(filterByMeta([A, B, C]).map((i) => i.id), ['a', 'b', 'c']);
  assert.equal(hasTag(A, ''), false);
});

test('favoritesFirst conserva el orden dentro de cada grupo', () => {
  const sorted = sortInstances([A, B, C], 'recent');
  assert.deepEqual(sorted.map((i) => i.id), ['b', 'c', 'a']);
  assert.deepEqual(favoritesFirst(sorted).map((i) => i.id), ['a', 'b', 'c']);
  assert.deepEqual(favoritesFirst([]), []);
});

test('la busqueda tambien encuentra por etiqueta', () => {
  assert.equal(matchesInstance(A, 'amigos'), true);
  assert.equal(matchesInstance(B, 'amigos'), false);
  assert.equal(matchesInstance(C, ''), true);
});
