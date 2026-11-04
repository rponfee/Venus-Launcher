'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const { ui, loadRenderer, turn, deferred } = require('../../../features/clipstudio/test/ui-harness');
const raw = (id, extra = {}) => ({ id, title: id, url: 'https://example.supabase.co/storage/v1/object/sign/clips/test/' + id + '.webm?token=test', likes: 2, likesWeek: 1, ...extra });

async function rig(backend, admin = false) {
  const dom = ui();
  const logic = await import(pathToFileURL(path.join(__dirname, '../gallery-logic.js')).href);
  const deps = { ...dom.deps, ...logic, cloud: { ready: async () => {}, on: () => () => {} } };
  if (admin) {
    const mod = loadRenderer(path.join(__dirname, '../../admin/gallery.js'), ['render', 'setAdminGalleryBackend'], deps);
    mod.setAdminGalleryBackend(backend);
    const root = new dom.Element('div'); root.attached = true;
    await mod.render(root); await turn();
    return { ...dom, root };
  }
  const mod = loadRenderer(path.join(__dirname, '../gallery.js'), ['galleryPanel', 'setGalleryBackend'], deps);
  mod.setGalleryBackend(backend);
  const root = mod.galleryPanel(); root.attached = true;
  await turn();
  return { ...dom, root };
}
const button = (root, text) => root.querySelectorAll('button').find(el => el.textContent.includes(text));

test('galeria: el like pendiente se bloquea y muestra la respuesta real en la tarjeta visible', async () => {
  const vote = deferred();
  const r = await rig(name => name === 'gallery_like' ? vote.promise : { items: [raw('uno')], more: false });
  const click = r.root.querySelector('.cs-gl-like').click();
  assert.equal(r.root.querySelector('.cs-gl-like').disabled, true);
  vote.resolve({ liked: true, likes: 8, likesWeek: 4 });
  await click;
  assert.equal(r.root.querySelector('.cs-gl-like').disabled, false);
  assert.equal(r.root.querySelector('.cs-gl-like').querySelector('.num').textContent, '8');
  r.root.destroy();
});

test('galeria: un like rechazado restaura la tarjeta visible', async () => {
  const vote = deferred();
  const r = await rig(name => name === 'gallery_like' ? vote.promise : { items: [raw('uno')], more: false });
  const click = r.root.querySelector('.cs-gl-like').click();
  vote.reject(new Error('network'));
  await click;
  const like = r.root.querySelector('.cs-gl-like');
  assert.equal(like.attrs['aria-pressed'], 'false');
  assert.equal(like.querySelector('.num').textContent, '2');
  assert.equal(like.disabled, false);
  assert.equal(r.failures.length, 1);
  r.root.destroy();
});

test('galeria: la paginacion cuenta tambien las filas omitidas por falta de enlace', async () => {
  const offsets = [];
  const r = await rig((name, args) => {
    offsets.push(args.p_offset);
    return args.p_offset ? { items: [raw('dos')], more: false } : { items: [raw('uno'), raw('sin-link', { url: null })], more: true };
  });
  await button(r.root, 'clipstudio.showMore').click();
  assert.deepEqual(offsets, [0, 2]);
  assert.equal(r.root.querySelectorAll('.cs-gl-card').length, 2);
  r.root.destroy();
});

test('galeria: una pagina anterior no se mezcla con otra pestaña ni se pide dos veces', async () => {
  const pending = deferred(); let requests = 0;
  const r = await rig((name, args) => {
    if (name === 'gallery_mine') return [raw('propio')];
    if (args.p_offset) { requests++; return pending.promise; }
    return { items: [raw('uno')], more: true };
  });
  const more = button(r.root, 'clipstudio.showMore');
  const click = more.click();
  more.onclick({ currentTarget: more });
  button(r.root, 'clipstudio.galleryView_mine').click();
  await turn();
  pending.resolve({ items: [raw('tardio')], more: false });
  await click;
  assert.equal(requests, 1);
  assert.deepEqual(r.root.querySelectorAll('.cs-gl-title').map(el => el.textContent), ['propio']);
  r.root.destroy();
});

test('admin: una respuesta vieja no reemplaza el filtro nuevo', async () => {
  const pending = deferred();
  const r = await rig((name, args) => args.p_filter === 'reported' ? pending.promise : { items: [raw('oculto', { hidden: true })], more: false }, true);
  button(r.root, 'clipstudio.adminGalleryFilter_hidden').click();
  await turn();
  pending.resolve({ items: [raw('viejo')], more: false });
  await turn();
  assert.deepEqual(r.root.querySelectorAll('.cs-gl-title').map(el => el.textContent), ['oculto']);
});
