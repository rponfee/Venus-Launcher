'use strict';
// Armado del pedido a Openverse: filtros, limites y valores desconocidos.
const test = require('node:test');
const assert = require('node:assert/strict');
const Q = require('../query');

test('busqueda por texto en Jamendo: licencias comerciales, categoria music y 20 por pagina', () => {
  const s = Q.buildSearch({ text: '  piano   suave ', source: 'jamendo' });
  assert.equal(s.params.q, 'piano suave');
  assert.equal(s.params.source, 'jamendo');
  assert.equal(s.params.category, 'music');
  assert.equal(s.params.license, 'by,by-sa,by-nd,cc0,pdm');
  assert.equal(s.params.length, 'short,medium,long');
  assert.equal(s.params.page_size, '20');
  assert.equal(s.params.page, '1');
  assert.ok(!('license_type' in s.params));
  assert.ok(!/nc|sampling/.test(s.params.license));
  assert.match(s.params.extension, /^mp32,mp3,ogg,oga,opus$/);
});

test('Wikimedia y ambas fuentes no llevan category (esas pistas no la tienen)', () => {
  assert.equal(Q.buildSearch({ text: 'piano', source: 'wikimedia' }).params.source, 'wikimedia_audio');
  assert.ok(!('category' in Q.buildSearch({ text: 'piano', source: 'wikimedia' }).params));
  const both = Q.buildSearch({ text: 'piano', source: 'both' });
  assert.equal(both.params.source, 'jamendo,wikimedia_audio');
  assert.ok(!('category' in both.params));
});

test('genero y duracion', () => {
  const s = Q.buildSearch({ genre: 'chiptune', length: 'short' });
  assert.equal(s.params.q, 'chiptune');
  assert.equal(s.params.length, 'short');
  assert.equal(Q.buildSearch({ text: 'noche', genre: 'jazz' }).params.q, 'noche jazz');
  assert.equal(Q.buildSearch({ text: 'x', length: 'medium' }).params.length, 'medium');
  assert.equal(Q.buildSearch({ text: 'x', length: 'shortest' }).params.length, 'short,medium,long', '"shortest" no se ofrece');
  for (const g of Q.GENRE_IDS) assert.ok(Q.buildSearch({ genre: g }).params.q);
});

test('sin nada que buscar es bad_query', () => {
  for (const input of [undefined, null, {}, { text: '' }, { text: '   ' }, { genre: 'inventado' }, { text: 7 }, 'piano']) {
    assert.throws(() => Q.buildSearch(input), (e) => e.code === 'bad_query', JSON.stringify(input));
  }
});

test('valores raros no se cuelan en la URL', () => {
  const s = Q.buildSearch({ text: 'a'.repeat(500), source: 'freesound', length: '../x', page: 99, genre: 'rock&license=by-nc' });
  assert.equal(s.params.q.length, 100);
  assert.equal(s.params.source, 'jamendo');
  assert.equal(s.params.length, 'short,medium,long');
  assert.equal(s.params.page, String(Q.MAX_PAGE));
  const odd = Q.buildSearch({ text: 'hola&license=by-nc&page_size=500', page: -3 });
  assert.equal(odd.params.page, '1');
  assert.equal(odd.params.license, 'by,by-sa,by-nd,cc0,pdm');
  assert.equal(new URLSearchParams(odd.params).get('q'), 'hola&license=by-nc&page_size=500'); // viaja codificado, es solo texto
  assert.equal(Q.buildSearch({ text: 'x', page: '3' }).params.page, '3');
  assert.equal(Q.buildSearch({ text: 'x', page: 2.9 }).params.page, '2');
});

test('la clave de cache es estable', () => {
  const a = Q.buildSearch({ text: 'piano', genre: '', length: 'any', source: 'jamendo', page: 1 });
  const b = Q.buildSearch({ page: 1, source: 'jamendo', length: 'any', text: ' piano ' });
  assert.equal(a.key, b.key);
  assert.notEqual(a.key, Q.buildSearch({ text: 'piano', page: 2 }).key);
  assert.notEqual(a.key, Q.buildSearch({ text: 'piano', source: 'both' }).key);
});
