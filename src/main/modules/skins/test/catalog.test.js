'use strict';
// Pruebas del catalogo incluido con una carpeta temporal y un catalog.json chico: validacion de entradas
// (sha256, tamano, rutas que salen de la carpeta, ids repetidos), busqueda sin tildes, filtros, paginas,
// favoritas guardadas en serie, y guardar o usar una skin del catalogo con las mismas guardias que apply.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createCatalog, validEntry } = require('../catalog');
const { createSkinsService } = require('../service');
const { createLibrary } = require('../library');
const { createMinecraftApi } = require('../api');
const png = require('../png');
const { reply, skinPng, skinImage, encodePng, setRect } = require('./fixtures');

const fail = (code, vars) => Object.assign(new Error(`skins.${code}${vars ? ` ${JSON.stringify(vars)}` : ''}`), { code: `skins:${code}` });
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const UUID = '0123456789abcdef0123456789abcdef';
const PROFILE = { id: UUID, name: 'VenusTester', skins: [], capes: [] };

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Skin distinta para cada numero (cambia un pixel de la cara), asi no se repiten los pixelHash.
function uniqueSkin(n, variant = 'classic', height = 64) {
  const img = skinImage(variant, height);
  setRect(img, 8 + (n % 8), 8 + Math.floor(n / 8) % 8, 1, 1, [n & 255, 200, 100, 255]);
  return encodePng(img);
}

// Carpeta con catalog.json y los PNG. entries: [{ id, name, category, model, bytes, file?, ...extra }]
function makeCatalog(entries, { raw } = {}) {
  const dir = tempDir('venus-skins-cat-');
  const list = [];
  for (const e of entries) {
    const file = e.file || `skins/${e.category}/${e.id}.png`;
    if (e.bytes) {
      const full = path.join(dir, ...file.slice(6).split('/'));
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, e.bytes);
    }
    const head = e.bytes ? png.inspect(e.bytes) : { width: 64, height: 64 };
    list.push({ id: e.id, name: e.name ?? e.id, category: e.category, model: e.model || 'classic', legacy: head.height === 32, file, width: head.width, height: head.height, sha256: e.bytes ? sha256(e.bytes) : '0'.repeat(64), ...e.extra });
  }
  fs.writeFileSync(path.join(dir, 'catalog.json'), raw ?? JSON.stringify(list));
  return dir;
}

function setupCatalog(entries, opts = {}) {
  const dir = makeCatalog(entries, opts);
  const data = tempDir('venus-skins-fav-');
  const warnings = [];
  const favoritesFile = path.join(data, 'skin-favorites.json');
  if (opts.favorites !== undefined) fs.writeFileSync(favoritesFile, JSON.stringify(opts.favorites));
  const make = () => createCatalog({ dir, favoritesFile, fail, warn: (...a) => warnings.push(a.join(' ')) });
  return { dir, favoritesFile, warnings, catalog: make(), make };
}

const BASIC = [
  { id: 'esteticas-0001-aaaaaa', name: 'Girl Slim Model Green', category: 'Esteticas', model: 'slim', bytes: uniqueSkin(1, 'slim') },
  { id: 'esteticas-0002-bbbbbb', name: 'Café Boy', category: 'Esteticas', model: 'classic', bytes: uniqueSkin(2) },
  { id: 'kawaii-0001-cccccc', name: 'Pink Cat', category: 'Kawaii', model: 'slim', bytes: uniqueSkin(3, 'slim') },
  { id: 'kawaii-0002-dddddd', name: 'Old Pink', category: 'Kawaii', model: 'slim', bytes: uniqueSkin(4, 'classic', 32) },
  { id: 'lindas-0001-eeeeee', name: 'Green Frog', category: 'Lindas', model: 'classic', bytes: uniqueSkin(5) },
];

test('valida cada entrada y descarta solo las malas', async () => {
  const good = uniqueSkin(10);
  const { catalog, warnings } = setupCatalog([
    ...BASIC,
    { id: 'malo-sha', category: 'Lindas', bytes: uniqueSkin(11), extra: { sha256: 'f'.repeat(64) } }, // sha que no coincide: se ve al leerla
    { id: 'malo-tamano', category: 'Lindas', bytes: good, extra: { width: 32 } },
    { id: 'malo-ruta', category: 'Lindas', file: 'skins/../../fuera.png' },
    { id: 'malo-absoluta', category: 'Lindas', file: 'skins/C:/Windows/x.png' },
    { id: 'malo-barra', category: 'Lindas', file: 'skins\\Lindas\\x.png' },
    { id: 'malo-prefijo', category: 'Lindas', file: 'otros/Lindas/x.png' },
    { id: 'malo-ext', category: 'Lindas', file: 'skins/Lindas/x.jpg' },
    { id: '../malo-id', category: 'Lindas', bytes: uniqueSkin(12) },
    { id: 'malo-modelo', category: 'Lindas', model: 'wide', bytes: uniqueSkin(13) },
    { id: 'malo-categoria', category: '../x', file: 'skins/Lindas/malo-categoria.png', bytes: uniqueSkin(14) },
    { id: 'esteticas-0001-aaaaaa', name: 'Repetida', category: 'Lindas', bytes: uniqueSkin(15) }, // id repetido
  ]);
  const r = await catalog.list({ limit: 96 });
  assert.equal(r.catalogTotal, 6, 'las 5 buenas y la del sha (que falla recien al leerla)');
  assert.equal(r.items.find((i) => i.id === 'esteticas-0001-aaaaaa').name, 'Girl Slim Model Green', 'gana la primera con ese id');
  assert.equal(warnings.filter((w) => /descartaron 10 de 16/.test(w)).length, 1, 'un solo aviso con la cuenta');
  const bad = r.items.find((i) => i.id === 'malo-sha');
  assert.equal(bad.broken, true);
  assert.equal(bad.image, null);
  await assert.rejects(catalog.read('malo-sha'), { code: 'skins:catalogDamaged' });
  await assert.rejects(catalog.read('malo-ruta'), { code: 'skins:catalogNotFound' });
  await assert.rejects(catalog.read(42), { code: 'skins:catalogNotFound' });
  // validEntry sola: la ruta tiene que quedar dentro de la carpeta
  assert.equal(validEntry({ id: 'a', file: 'skins/x/../../../y.png', width: 64, height: 64, sha256: 'a'.repeat(64), model: 'slim', category: 'X' }, os.tmpdir()), null);
  assert.ok(validEntry({ id: 'a', file: 'skins/X/y.png', width: 64, height: 64, sha256: 'a'.repeat(64), model: 'slim', category: 'X' }, os.tmpdir()));
});

test('cada PNG se revisa al leerlo: sha256 y encabezado', async () => {
  const { catalog, dir } = setupCatalog(BASIC);
  const ok = await catalog.read('lindas-0001-eeeeee');
  assert.deepEqual(ok.bytes, BASIC[4].bytes);
  assert.match(ok.item.pixelHash, /^[0-9a-f]{40}$/);
  // el archivo cambia despues de cargar el catalogo
  fs.writeFileSync(path.join(dir, 'Lindas', 'lindas-0001-eeeeee.png'), uniqueSkin(99));
  await assert.rejects(catalog.read('lindas-0001-eeeeee'), { code: 'skins:catalogDamaged' });
  // el sha coincide con el archivo pero el encabezado no con la entrada (dice 64x64 y es de 64x32)
  const legacy = uniqueSkin(20, 'classic', 32);
  const liar = setupCatalog([{ id: 'mentira', category: 'Kawaii', bytes: uniqueSkin(21), extra: {} }]);
  fs.writeFileSync(path.join(liar.dir, 'Kawaii', 'mentira.png'), legacy);
  const json = JSON.parse(fs.readFileSync(path.join(liar.dir, 'catalog.json'), 'utf8'));
  json[0].sha256 = sha256(legacy);
  fs.writeFileSync(path.join(liar.dir, 'catalog.json'), JSON.stringify(json));
  await assert.rejects(liar.make().read('mentira'), { code: 'skins:catalogDamaged' });
});

test('catalogo ilegible o vacio: error traducido y se puede reintentar', async () => {
  const broken = setupCatalog([], { raw: '{ no es json' });
  await assert.rejects(broken.catalog.list({}), { code: 'skins:catalogUnavailable' });
  fs.writeFileSync(path.join(broken.dir, 'catalog.json'), '[]');
  await assert.rejects(broken.catalog.list({}), { code: 'skins:catalogUnavailable' }, 'sin entradas validas');
  fs.writeFileSync(path.join(broken.dir, 'catalog.json'), JSON.stringify([{ id: 'x', file: 'skins/A/x.png', width: 64, height: 64, sha256: 'a'.repeat(64), model: 'slim', category: 'A' }]));
  assert.equal((await broken.catalog.list({})).catalogTotal, 1, 'despues de un error vuelve a leer el archivo');
});

test('busqueda sin tildes ni mayusculas, por nombre, categoria e id', async () => {
  const { catalog } = setupCatalog(BASIC);
  const names = async (opts) => (await catalog.list(opts)).items.map((i) => i.name);
  assert.deepEqual(await names({ query: 'cafe' }), ['Café Boy']);
  assert.deepEqual(await names({ query: 'CAFÉ' }), ['Café Boy']);
  assert.deepEqual(await names({ query: 'estéticas' }), ['Girl Slim Model Green', 'Café Boy']);
  assert.deepEqual(await names({ query: 'pink kawaii' }), ['Pink Cat', 'Old Pink'], 'todas las palabras');
  assert.deepEqual(await names({ query: 'lindas-0001' }), ['Green Frog']);
  assert.deepEqual(await names({ query: 'nada parecido' }), []);
  assert.deepEqual(await names({ query: 42 }), BASIC.map((e) => e.name), 'una busqueda rara no filtra');
});

test('filtros, cuentas por categoria y paginas', async () => {
  const { catalog } = setupCatalog(BASIC);
  const all = await catalog.list({});
  assert.equal(all.total, 5);
  assert.equal(all.limit, 48);
  assert.deepEqual(all.categories, [
    { id: 'Esteticas', count: 2 },
    { id: 'Kawaii', count: 2 },
    { id: 'Lindas', count: 1 },
  ]);
  const item = all.items[0];
  assert.deepEqual(Object.keys(item).sort(), ['broken', 'category', 'favorite', 'height', 'id', 'image', 'legacy', 'model', 'name', 'pixelHash', 'width']);
  assert.match(item.image, /^data:image\/png;base64,/);
  assert.equal(JSON.stringify(all).includes(os.tmpdir()), false, 'nunca manda rutas a la interfaz');
  // la de 64x32 es siempre clasica, aunque el catalogo diga slim
  const old = all.items.find((i) => i.id === 'kawaii-0002-dddddd');
  assert.equal(old.legacy, true);
  assert.equal(old.model, 'classic');
  const slim = await catalog.list({ model: 'slim' });
  assert.deepEqual(slim.items.map((i) => i.id), ['esteticas-0001-aaaaaa', 'kawaii-0001-cccccc']);
  // las cuentas por categoria respetan los demas filtros, pero no la categoria elegida
  const kawaiiSlim = await catalog.list({ model: 'slim', category: 'Kawaii' });
  assert.equal(kawaiiSlim.total, 1);
  assert.deepEqual(kawaiiSlim.categories.map((c) => c.count), [1, 1, 0]);
  assert.equal((await catalog.list({ category: 'NoExiste' })).total, 0);
  assert.equal((await catalog.list({ model: 'raro' })).total, 5, 'un modelo invalido no filtra');
  // paginas
  const p1 = await catalog.list({ offset: 0, limit: 2 });
  const p2 = await catalog.list({ offset: 2, limit: 2 });
  const p3 = await catalog.list({ offset: 4, limit: 2 });
  assert.deepEqual([...p1.items, ...p2.items, ...p3.items].map((i) => i.id), BASIC.map((e) => e.id));
  assert.equal((await catalog.list({ offset: 50 })).items.length, 0);
  assert.equal((await catalog.list({ limit: 500 })).limit, 96, 'tope de 96');
  assert.equal((await catalog.list({ limit: -3 })).limit, 0);
  assert.equal((await catalog.list({ limit: 'mucho' })).limit, 48);
  const counts = await catalog.list({ limit: 0 });
  assert.deepEqual(counts.items, [], 'limit 0: solo los totales');
  assert.equal(counts.total, 5);
  assert.equal(counts.catalogTotal, 5);
});

test('favoritas: se guardan, se filtran y se cuentan', async () => {
  const { catalog, favoritesFile, make } = setupCatalog(BASIC);
  assert.equal((await catalog.list({})).favoriteCount, 0);
  assert.deepEqual(await catalog.setFavorite('kawaii-0001-cccccc', true), { id: 'kawaii-0001-cccccc', favorite: true, favoriteCount: 1 });
  await catalog.setFavorite('lindas-0001-eeeeee', true);
  await catalog.setFavorite('lindas-0001-eeeeee', true); // repetir no cambia nada
  const favs = await catalog.list({ onlyFavorites: true });
  assert.deepEqual(favs.items.map((i) => i.id), ['kawaii-0001-cccccc', 'lindas-0001-eeeeee']);
  assert.ok(favs.items.every((i) => i.favorite));
  assert.equal(favs.favoriteCount, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(favoritesFile, 'utf8')), { version: 1, ids: ['kawaii-0001-cccccc', 'lindas-0001-eeeeee'] });
  assert.deepEqual((await catalog.setFavorite('kawaii-0001-cccccc', false)).favoriteCount, 1);
  await assert.rejects(catalog.setFavorite('no-existe', true), { code: 'skins:catalogNotFound' });
  await assert.rejects(catalog.setFavorite(null, true), { code: 'skins:catalogNotFound' });
  // otra instancia (otra vez el launcher abierto) lee el archivo
  assert.deepEqual((await make().list({ onlyFavorites: true })).items.map((i) => i.id), ['lindas-0001-eeeeee']);
});

test('favoritas: muchos cambios juntos quedan todos guardados', async () => {
  const { catalog, favoritesFile, make } = setupCatalog(BASIC);
  await Promise.all(BASIC.map((e) => catalog.setFavorite(e.id, true)));
  await Promise.all([catalog.setFavorite(BASIC[0].id, false), catalog.setFavorite(BASIC[1].id, false), catalog.setFavorite(BASIC[2].id, true)]);
  const saved = JSON.parse(fs.readFileSync(favoritesFile, 'utf8')).ids.sort();
  assert.deepEqual(saved, [BASIC[2].id, BASIC[3].id, BASIC[4].id].sort());
  assert.equal((await make().list({})).favoriteCount, 3);
  assert.deepEqual(fs.readdirSync(path.dirname(favoritesFile)), ['skin-favorites.json'], 'sin temporales sueltos');
});

test('favoritas: lee el formato de la 1.0.11 y descarta lo que no sirve', async () => {
  const { catalog } = setupCatalog(BASIC, { favorites: { ids: ['lindas-0001-eeeeee', 'ya-no-existe', 7, '../x'] } });
  const r = await catalog.list({ onlyFavorites: true });
  assert.deepEqual(r.items.map((i) => i.id), ['lindas-0001-eeeeee']);
  assert.equal(r.favoriteCount, 1, 'solo cuentan las que estan en el catalogo');
  const broken = setupCatalog(BASIC, { favorites: 'texto' });
  assert.equal((await broken.catalog.list({})).favoriteCount, 0);
});

// ---------- Guardar y usar desde el servicio ----------

function fakeAccounts({ selected = 'msa-1', type = 'msa' } = {}) {
  const state = {
    selected,
    accounts: [
      { id: 'msa-1', type, name: 'VenusTester', uuid: UUID },
      { id: 'offline-1', type: 'offline', name: 'Local', uuid: 'ffffffffffffffffffffffffffffffff' },
    ],
  };
  return {
    state,
    onLaunch: null,
    async list() {
      return JSON.parse(JSON.stringify(state));
    },
    async getLaunchAccount(id) {
      if (this.onLaunch) await this.onLaunch(id);
      const acc = state.accounts.find((a) => a.id === id);
      return acc.type === 'msa' ? { type: 'msa', name: acc.name, uuid: acc.uuid, accessToken: 'secret-token' } : { type: 'offline', name: acc.name, uuid: acc.uuid, accessToken: '0' };
    },
  };
}

function setupService({ accounts = fakeAccounts(), handler, offline = false, maxItems } = {}) {
  const { catalog } = setupCatalog(BASIC);
  const dir = tempDir('venus-skins-catlib-');
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return handler ? handler(url, init) : reply(200, PROFILE);
  };
  const library = createLibrary({ dir, fail, maxItems });
  const service = createSkinsService({ accounts, api: createMinecraftApi({ fetch, fail }), library, catalog, fail, isOffline: () => offline });
  return { service, calls, library, accounts };
}

test('usar una skin del catalogo: sube el PNG con el modelo del catalogo', async () => {
  const { service, calls, library } = setupService();
  const view = await service.catalogApply('esteticas-0001-aaaaaa', 'msa-1');
  assert.equal(view.name, 'VenusTester');
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, 'https://api.minecraftservices.com/minecraft/profile/skins');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer secret-token');
  assert.equal(init.body.get('variant'), 'slim', 'el del catalogo');
  assert.deepEqual(Buffer.from(await init.body.get('file').arrayBuffer()), BASIC[0].bytes);
  assert.equal((await library.list()).items.length, 0, 'no hace falta pasarla por la biblioteca');
  // el modelo elegido en la interfaz pisa el del catalogo; una de 64x32 va siempre como clasica
  await service.catalogApply('esteticas-0001-aaaaaa', 'msa-1', 'classic');
  assert.equal(calls[1].init.body.get('variant'), 'classic');
  await service.catalogApply('kawaii-0002-dddddd', 'msa-1', 'slim');
  assert.equal(calls[2].init.body.get('variant'), 'classic');
  await service.catalogApply('kawaii-0001-cccccc', 'msa-1', 'raro');
  assert.equal(calls[3].init.body.get('variant'), 'slim');
  await assert.rejects(service.catalogApply('no-existe', 'msa-1'), { code: 'skins:catalogNotFound' });
  assert.equal(calls.length, 4);
});

test('usar una skin del catalogo pasa por las mismas guardias', async () => {
  const offline = setupService({ accounts: fakeAccounts({ selected: 'offline-1' }) });
  await assert.rejects(offline.service.catalogApply('lindas-0001-eeeeee', 'offline-1'), { code: 'skins:offline' });
  const changed = setupService();
  await assert.rejects(changed.service.catalogApply('lindas-0001-eeeeee', 'offline-1'), { code: 'skins:accountChanged' });
  await assert.rejects(changed.service.catalogApply('lindas-0001-eeeeee', undefined), { code: 'skins:accountChanged' });
  const none = setupService({ accounts: { list: async () => ({ selected: null, accounts: [] }) } });
  await assert.rejects(none.service.catalogApply('lindas-0001-eeeeee', 'msa-1'), { code: 'skins:noAccount' });
  const launcherOffline = setupService({ offline: true });
  await assert.rejects(launcherOffline.service.catalogApply('lindas-0001-eeeeee', 'msa-1'), { code: 'skins:launcherOffline' });
  // la cuenta cambia mientras se renueva el token
  const swap = setupService();
  swap.accounts.onLaunch = async () => {
    swap.accounts.state.selected = 'offline-1';
  };
  await assert.rejects(swap.service.catalogApply('lindas-0001-eeeeee', 'msa-1'), { code: 'skins:accountChanged' });
  for (const s of [offline, changed, none, launcherOffline, swap]) assert.equal(s.calls.length, 0, 'no se subio nada');
  // errores de Minecraft con los mismos codigos
  const limited = setupService({ handler: () => reply(429, {}) });
  await assert.rejects(limited.service.catalogApply('lindas-0001-eeeeee', 'msa-1'), { code: 'skins:rateLimited' });
});

test('un solo cambio a la vez, mezclando catalogo y biblioteca', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { service, library } = setupService({
    handler: async (url) => {
      if (url.endsWith('/skins')) await gate;
      return reply(200, PROFILE);
    },
  });
  const { item } = await library.add(skinPng('classic'), {});
  const first = service.catalogApply('lindas-0001-eeeeee', 'msa-1');
  await new Promise((r) => setTimeout(r, 10));
  await assert.rejects(service.catalogApply('kawaii-0001-cccccc', 'msa-1'), { code: 'skins:busy' });
  await assert.rejects(service.apply(item.id, 'msa-1', 'classic'), { code: 'skins:busy' });
  await assert.rejects(service.reset('msa-1'), { code: 'skins:busy' });
  release();
  await first;
  await service.catalogApply('kawaii-0001-cccccc', 'msa-1');
});

test('guardar una skin del catalogo en la biblioteca', async () => {
  const { service, library } = setupService({ maxItems: 2 });
  const saved = await service.catalogSave('esteticas-0001-aaaaaa');
  assert.equal(saved.duplicate, false);
  assert.equal(saved.item.name, 'Girl Slim Model Green');
  assert.equal(saved.item.variant, 'slim');
  assert.equal(saved.item.source, 'catalog');
  const { item: cat } = await service.catalogRead('esteticas-0001-aaaaaa');
  assert.equal(saved.item.pixelHash, cat.pixelHash, 'la interfaz puede reconocerla en la biblioteca');
  assert.equal((await service.catalogSave('esteticas-0001-aaaaaa')).duplicate, true);
  const old = await service.catalogSave('kawaii-0002-dddddd', 'slim');
  assert.equal(old.item.variant, 'classic', 'las de 64x32 son clasicas');
  assert.equal(old.item.legacy, true);
  await assert.rejects(service.catalogSave('lindas-0001-eeeeee'), { code: 'skins:libraryFull' });
  await assert.rejects(service.catalogSave('no-existe'), { code: 'skins:catalogNotFound' });
  const list = await library.list();
  assert.deepEqual(list.items.map((i) => i.source), ['catalog', 'catalog']);
  // sin catalogo (servicio viejo), los canales responden con un error traducido
  const bare = createSkinsService({ accounts: fakeAccounts(), api: {}, library, fail });
  await assert.rejects(bare.catalog({}), { code: 'skins:catalogUnavailable' });
});
