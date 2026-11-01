'use strict';
// Casos borde del servicio, la API y la biblioteca: errores que no dejan la cola trabada, respuestas
// vacias, texturas raras, el token que nunca aparece en un error y entradas malas desde la interfaz.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSkinsService } = require('../service');
const { createLibrary } = require('../library');
const { createMinecraftApi } = require('../api');
const png = require('../png');
const { reply, skinPng, encodePng, solid } = require('./fixtures');

const fail = (code, vars) => Object.assign(new Error(`skins.${code}${vars ? ` ${JSON.stringify(vars)}` : ''}`), { code: `skins:${code}` });
const UUID = '0123456789abcdef0123456789abcdef';
const SKIN_URL = 'http://textures.minecraft.net/texture/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PROFILE = { id: UUID, name: 'VenusTester', skins: [{ id: 's1', state: 'ACTIVE', url: SKIN_URL, variant: 'CLASSIC' }], capes: [] };
const TOKEN = 'secreto-del-token-123';

function accounts({ token = TOKEN } = {}) {
  return {
    state: { selected: 'msa-1', accounts: [{ id: 'msa-1', type: 'msa', name: 'VenusTester', uuid: UUID }] },
    async list() {
      return JSON.parse(JSON.stringify(this.state));
    },
    async getLaunchAccount() {
      if (token instanceof Error) throw token;
      return { type: 'msa', name: 'VenusTester', uuid: UUID, accessToken: token };
    },
  };
}

function setup({ handler, acc = accounts(), trash = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venus-skins-edge-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return handler ? handler(url, init, calls) : reply(200, PROFILE);
  };
  const library = createLibrary({ dir, fail, trash });
  const service = createSkinsService({ accounts: acc, api: createMinecraftApi({ fetch, fail }), library, fail, t: (k) => k });
  return { service, calls, library, dir };
}

test('un cambio que falla libera la cuenta: el siguiente cambio anda', async () => {
  let n = 0;
  const { service, library } = setup({
    handler: () => {
      n++;
      if (n === 1) throw new TypeError('fetch failed');
      return reply(200, PROFILE);
    },
  });
  const { item } = await library.add(skinPng('classic'), { name: 'Una' });
  await assert.rejects(service.apply(item.id, 'msa-1', 'classic'), { code: 'skins:network' });
  const view = await service.apply(item.id, 'msa-1', 'classic');
  assert.equal(view.name, 'VenusTester');
});

test('un perfil que falla no traba la cola de la cuenta', async () => {
  let n = 0;
  const { service } = setup({ handler: () => (++n === 1 ? reply(503, {}) : reply(200, PROFILE)) });
  await assert.rejects(service.profile('msa-1'), { code: 'skins:serviceUnavailable' });
  assert.equal((await service.profile('msa-1')).name, 'VenusTester');
});

test('respuesta vacia (204) de un cambio: devuelve null y el perfil se vuelve a pedir', async () => {
  const { service, calls } = setup({ handler: (url, init) => (init.method === 'GET' ? reply(200, PROFILE) : reply(204, null)) });
  await service.profile('msa-1');
  assert.equal(await service.cape(null, 'msa-1'), null);
  await service.profile('msa-1');
  assert.equal(calls.filter((c) => c.init.method === 'GET').length, 2, 'la cache del perfil se descarto');
});

test('capa vacia (\'\') la oculta con DELETE', async () => {
  const { service, calls } = setup();
  await service.cape('', 'msa-1');
  assert.equal(calls[0].init.method, 'DELETE');
  await assert.rejects(service.cape({ id: 'x' }, 'msa-1'), { code: 'skins:capeRejected' });
  await assert.rejects(service.cape('a'.repeat(65), 'msa-1'), { code: 'skins:capeRejected' });
});

test('un archivo de la biblioteca danado no se sube', async () => {
  const { service, calls, library, dir } = setup();
  const { item } = await library.add(skinPng('classic'), {});
  fs.writeFileSync(path.join(dir, `${item.id}.png`), 'roto');
  await assert.rejects(service.apply(item.id, 'msa-1', 'classic'), { code: 'skins:fileDamaged' });
  assert.equal(calls.length, 0);
});

test('el token nunca aparece en el mensaje de un error', async () => {
  const leaky = setup({
    handler: () => {
      throw new Error(`fallo con Authorization: Bearer ${TOKEN}`);
    },
  });
  await assert.rejects(leaky.service.profile('msa-1'), (err) => {
    assert.equal(err.code, 'skins:network');
    assert.equal(String(err.message).includes(TOKEN), false);
    return true;
  });
  const status = setup({ handler: () => reply(400, { errorMessage: `token ${TOKEN}` }) });
  const { item } = await status.library.add(skinPng('classic'), {});
  await assert.rejects(status.service.apply(item.id, 'msa-1', 'classic'), (err) => !String(err.message).includes(TOKEN));
});

test('errores de la cuenta: limite de pedidos y codigos desconocidos', async () => {
  const limited = setup({ acc: accounts({ token: Object.assign(new Error('demasiados'), { code: 'mcRateLimited' }) }) });
  await assert.rejects(limited.service.profile('msa-1'), { code: 'skins:rateLimited' });
  const missing = setup({ acc: accounts({ token: Object.assign(new Error('no esta'), { code: 'notFound' }) }) });
  await assert.rejects(missing.service.profile('msa-1'), { code: 'skins:accountChanged' });
});

test('texturas: 429, red caida, capa de 128x64 y skin que no es capa', async () => {
  const bytes128 = encodePng(solid(128, 64));
  const { service } = setup({
    handler: (url) => {
      if (url.includes('cccc')) return reply(429, '');
      if (url.includes('dddd')) throw new TypeError('fetch failed');
      if (url.includes('eeee')) return reply(200, bytes128);
      return reply(200, skinPng('classic'));
    },
  });
  const u = (c) => `https://textures.minecraft.net/texture/${c.repeat(16)}`;
  await assert.rejects(service.texture(u('cccc'), 'skin'), { code: 'skins:rateLimited' });
  await assert.rejects(service.texture(u('dddd'), 'skin'), { code: 'skins:network' });
  const cape = await service.texture(u('eeee'), 'cape');
  assert.equal(cape.width, 128);
  await assert.rejects(service.texture(u('eeee'), 'skin'), { code: 'skins:textureInvalid' }, 'una capa no pasa por skin');
  // un error no queda guardado: la segunda vez se vuelve a pedir
  await assert.rejects(service.texture(u('cccc'), 'skin'), { code: 'skins:rateLimited' });
});

test('guardar la skin actual sin skin en la cuenta', async () => {
  const { service } = setup({ handler: () => reply(200, { ...PROFILE, skins: [] }) });
  await assert.rejects(service.saveCurrent('msa-1'), { code: 'skins:noSkin' });
});

test('biblioteca: ids raros, nombres largos y una skin borrada a mano', async () => {
  const { library, dir } = setup();
  for (const bad of ['../../x', 'ABCDEFGH1', 'abc', 'a'.repeat(30), null, 42, { id: 'x' }]) {
    await assert.rejects(library.read(bad), { code: 'skins:notFound' }, String(bad));
    await assert.rejects(library.remove(bad), { code: 'skins:notFound' }, String(bad));
  }
  const { item } = await library.add(skinPng('classic'), { name: 'x' });
  assert.equal((await library.rename(item.id, 'n'.repeat(200))).name.length, 40);
  fs.rmSync(path.join(dir, `${item.id}.png`));
  const listed = (await library.list()).items[0];
  assert.equal(listed.broken, true);
  assert.equal(listed.image, null);
  await library.remove(item.id);
  assert.equal((await library.list()).items.length, 0, 'se puede borrar aunque falte el archivo');
});

test('un error del disco llega traducido (diskError) y el detalle va a la consola', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venus-skins-disk-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'index.json')); // el indice no se puede escribir
  const warned = [];
  const library = createLibrary({ dir, fail, warn: (...a) => warned.push(a.join(' ')) });
  await assert.rejects(library.add(skinPng('classic'), { name: 'x' }), { code: 'skins:diskError' });
  assert.equal(warned.length, 1);
  assert.match(warned[0], /^\[skins\] biblioteca:/);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.png')), [], 'no queda el PNG suelto');
  // los errores propios no se tocan (y la cola sigue andando)
  await assert.rejects(library.rename('noexiste1', 'x'), { code: 'skins:notFound' });
  fs.rmSync(path.join(dir, 'index.json'), { recursive: true });
  const { item } = await library.add(skinPng('classic'), { name: 'ahora si' });
  assert.equal((await library.list()).items[0].id, item.id);
});

test('PNG de 16 bits y con paleta de 4 bits', () => {
  const zlib = require('zlib');
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const make = (w, h, depth, colorType, rowBytes, fillRow, extra = []) => {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = depth;
    ihdr[9] = colorType;
    const raw = Buffer.alloc(h * (rowBytes + 1));
    for (let y = 0; y < h; y++) fillRow(raw.subarray(y * (rowBytes + 1) + 1, (y + 1) * (rowBytes + 1)), y);
    return Buffer.concat([png.SIGNATURE, chunk('IHDR', ihdr), ...extra, chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  };
  // RGBA de 16 bits: (0x1234, 0x5678, 0x9abc, 0xffff) -> (0x12, 0x56, 0x9a, 255)
  const rgba16 = make(64, 32, 16, 6, 64 * 8, (row) => {
    for (let x = 0; x < 64; x++) row.set([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xff, 0xff], x * 8);
  });
  const a = png.check(rgba16);
  assert.equal(a.ok, true);
  assert.deepEqual([...a.image.data.subarray(0, 4)], [0x12, 0x56, 0x9a, 255]);
  // paleta de 4 bits: dos indices por byte (1 y 2)
  const pal = Buffer.from([0, 0, 0, 255, 0, 0, 0, 255, 0]);
  const p4 = make(64, 64, 4, 3, 32, (row) => row.fill(0x12), [chunk('PLTE', pal)]);
  const b = png.check(p4);
  assert.equal(b.ok, true);
  assert.deepEqual([...b.image.data.subarray(0, 8)], [255, 0, 0, 255, 0, 255, 0, 255]);
  // un indice fuera de la paleta: danado
  const bad = make(64, 64, 4, 3, 32, (row) => row.fill(0x77), [chunk('PLTE', pal)]);
  assert.equal(png.check(bad).code, 'corrupt');
});
