'use strict';
// Normalizacion de etiquetas, favorito, notas y caratula. node --test "src/main/modules/instancemeta/test/"
const test = require('node:test');
const assert = require('node:assert/strict');
const meta = require('../meta');

test('tags: recorta, saca repetidas (sin distinguir mayusculas), vacias y largas; maximo 10', () => {
  const tags = meta.normalizeTags([' Survival ', 'survival', 'SURVIVAL', '', '   ', 'a'.repeat(25), 'a'.repeat(24), 42, null, 'con\tcontrol\x01']);
  assert.deepEqual(tags, ['Survival', 'a'.repeat(24), 'con control']);
  assert.deepEqual(meta.normalizeTags('no es lista'), []);
  assert.deepEqual(meta.normalizeTags(undefined), []);
  const many = meta.normalizeTags(Array.from({ length: 30 }, (_, i) => `t${i}`));
  assert.equal(many.length, 10);
  assert.deepEqual(many.slice(0, 3), ['t0', 't1', 't2']);
});

test('tags: los emojis cuentan como un caracter', () => {
  const tag = '🔥'.repeat(24);
  assert.deepEqual(meta.normalizeTags([tag]), [tag]);
  assert.deepEqual(meta.normalizeTags(['🔥'.repeat(25)]), []);
});

test('favorite: solo true es true', () => {
  assert.equal(meta.normalizeFavorite(true), true);
  assert.equal(meta.normalizeFavorite('true'), false);
  assert.equal(meta.normalizeFavorite(1), false);
  assert.equal(meta.normalizeFavorite(undefined), false);
});

test('notes: texto hasta 20000 caracteres, tareas hasta 100 de 200 caracteres con id unico', () => {
  const n = meta.normalizeNotes({ text: 'hola\nmundo\x00', tasks: [{ id: 'abcd1234', text: ' Hacer la granja ', done: 1 }, { id: 'abcd1234', text: 'Otra', done: true }, { text: '' }, 'no', { text: 'x'.repeat(250) }] });
  assert.equal(n.text, 'hola\nmundo');
  assert.equal(n.tasks.length, 3);
  assert.deepEqual(n.tasks[0], { id: 'abcd1234', text: 'Hacer la granja', done: false });
  assert.equal(n.tasks[1].text, 'Otra');
  assert.equal(n.tasks[1].done, true);
  assert.notEqual(n.tasks[1].id, 'abcd1234', 'el id repetido se reemplaza');
  assert.match(n.tasks[1].id, /^[a-z0-9]{8}$/);
  assert.equal(n.tasks[2].text.length, 200);
  const big = meta.normalizeNotes({ text: 'a'.repeat(30000), tasks: Array.from({ length: 150 }, (_, i) => ({ text: `t${i}` })) });
  assert.equal(big.text.length, 20000);
  assert.equal(big.tasks.length, 100);
  assert.deepEqual(meta.normalizeNotes(null), { text: '', tasks: [] });
  assert.deepEqual(meta.normalizeNotes('texto'), { text: '', tasks: [] });
  assert.deepEqual(meta.normalizeNotes({ text: 12, tasks: 'x' }), { text: '', tasks: [] });
});

test('cover: solo cover.<png|webp|jpg> o null', () => {
  assert.equal(meta.normalizeCover('cover.png'), 'cover.png');
  assert.equal(meta.normalizeCover('cover.webp'), 'cover.webp');
  assert.equal(meta.normalizeCover(null), null);
  assert.equal(meta.normalizeCover('../cover.png'), undefined);
  assert.equal(meta.normalizeCover('C:\\x\\cover.png'), undefined);
  assert.equal(meta.normalizeCover('mods/cover.png'), undefined);
  assert.equal(meta.normalizeCover(''), undefined);
  assert.equal(meta.normalizeCover(5), undefined);
});

test('applyMetaPatch: normaliza solo las claves presentes y descarta las invalidas', () => {
  const patch = { name: 'x', tags: ['a', 'a'], favorite: 'si', cover: '../../etc', coverAt: '12.7', notes: { text: 'n', tasks: [] } };
  meta.applyMetaPatch(patch);
  assert.deepEqual(patch, { name: 'x', tags: ['a'], favorite: false, coverAt: 13, notes: { text: 'n', tasks: [] } });
  const nulls = { cover: null, coverAt: null, notes: null };
  meta.applyMetaPatch(nulls);
  assert.deepEqual(nulls, { cover: null, coverAt: null, notes: null });
  const bad = { coverAt: -3 };
  meta.applyMetaPatch(bad);
  assert.deepEqual(bad, {});
  assert.deepEqual(meta.applyMetaPatch({ memory: { max: 1 } }), { memory: { max: 1 } }, 'otras claves no se tocan');
  assert.equal(meta.applyMetaPatch(null), null);
});

test('pendingTasks cuenta las no hechas', () => {
  assert.equal(meta.pendingTasks({ tasks: [{ done: false }, { done: true }, {}] }), 2);
  assert.equal(meta.pendingTasks(null), 0);
  assert.equal(meta.pendingTasks({ tasks: 'x' }), 0);
});
