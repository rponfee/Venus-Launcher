'use strict';
// Pruebas del servicio con cuentas y API falsas: guardia de cuenta, un cambio a la vez, cache del perfil,
// texturas como data:, copia de la skin actual y modo sin conexion del launcher.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSkinsService } = require('../service');
const { createLibrary } = require('../library');
const { createMinecraftApi } = require('../api');
const { reply, skinPng, encodePng, solid } = require('./fixtures');

const fail = (code, vars) => Object.assign(new Error(`skins.${code}${vars ? ` ${JSON.stringify(vars)}` : ''}`), { code: `skins:${code}` });
const UUID = '0123456789abcdef0123456789abcdef';
const SKIN_URL = 'http://textures.minecraft.net/texture/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CAPE_URL = 'http://textures.minecraft.net/texture/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const PROFILE = {
  id: UUID,
  name: 'VenusTester',
  skins: [{ id: 's1', state: 'ACTIVE', url: SKIN_URL, variant: 'CLASSIC' }],
  capes: [{ id: 'cape-1', state: 'ACTIVE', url: CAPE_URL, alias: 'Venus' }],
};

function fakeAccounts({ selected = 'msa-1', type = 'msa', token = 'secret-token' } = {}) {
  const state = {
    selected,
    accounts: [
      { id: 'msa-1', type, name: 'VenusTester', uuid: UUID },
      { id: 'offline-1', type: 'offline', name: 'Local', uuid: 'ffffffffffffffffffffffffffffffff' },
    ],
  };
  const launches = [];
  return {
    state,
    launches,
    onLaunch: null,
    async list() {
      return JSON.parse(JSON.stringify(state));
    },
    async getLaunchAccount(id) {
      launches.push(id);
      if (this.onLaunch) await this.onLaunch(id);
      const acc = state.accounts.find((a) => a.id === id);
      if (acc.type !== 'msa') return { type: 'offline', name: acc.name, uuid: acc.uuid, accessToken: '0' };
      if (token instanceof Error) throw token;
      return { type: 'msa', name: acc.name, uuid: acc.uuid, accessToken: token };
    },
  };
}

function setup({ accounts = fakeAccounts(), handler, offline = false, clock } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venus-skins-svc-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (handler) return handler(url, init, calls);
    if (url.startsWith('https://textures.minecraft.net/')) return reply(200, url.includes('bbbb') ? encodePng(solid(64, 32)) : skinPng('slim'));
    return reply(200, PROFILE);
  };
  let now = 1_000_000;
  const library = createLibrary({ dir, fail });
  const service = createSkinsService({
    accounts,
    api: createMinecraftApi({ fetch, fail }),
    library,
    fail,
    t: (k, v) => (k === 'skins.currentName' ? `Skin de ${v.name}` : k),
    isOffline: () => offline,
    now: clock || (() => now),
  });
  return { service, calls, accounts, library, dir, tick: (ms) => (now += ms) };
}

test('cuenta elegida sin token', async () => {
  const { service } = setup();
  assert.deepEqual(await service.account(), { id: 'msa-1', type: 'msa', name: 'VenusTester', needsLogin: false });
  const none = setup({ accounts: { list: async () => ({ selected: null, accounts: [] }) } });
  assert.equal(await none.service.account(), null);
});

test('perfil: con cache corta y sin pedidos duplicados', async () => {
  const { service, calls, tick } = setup();
  const [a, b] = await Promise.all([service.profile('msa-1'), service.profile('msa-1')]);
  assert.equal(calls.length, 1, 'dos pedidos juntos comparten la misma llamada');
  assert.equal(a, b);
  assert.equal(a.name, 'VenusTester');
  assert.deepEqual(a.skin, { id: 's1', variant: 'classic', textureUrl: 'https://textures.minecraft.net/texture/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', alias: null });
  assert.equal(a.activeCapeId, 'cape-1');
  assert.equal(JSON.stringify(a).includes('secret-token'), false, 'el token nunca llega a la interfaz');
  await service.profile('msa-1');
  assert.equal(calls.length, 1, 'cache');
  tick(61_000);
  await service.profile('msa-1');
  assert.equal(calls.length, 2, 'vencida la cache, vuelve a pedir');
  await service.profile('msa-1', { force: true });
  assert.equal(calls.length, 3);
});

test('cuenta sin conexion, otra cuenta o sin cuenta', async () => {
  const offline = setup({ accounts: fakeAccounts({ selected: 'offline-1' }) });
  await assert.rejects(offline.service.profile('offline-1'), { code: 'skins:offline' });
  await assert.rejects(offline.service.apply('abcdefgh1', 'offline-1', 'classic'), { code: 'skins:offline' });
  assert.equal(offline.calls.length, 0);
  const changed = setup();
  await assert.rejects(changed.service.profile('offline-1'), { code: 'skins:accountChanged' });
  await assert.rejects(changed.service.reset(undefined), { code: 'skins:accountChanged' });
  const none = setup({ accounts: { list: async () => ({ selected: null, accounts: [] }) } });
  await assert.rejects(none.service.profile('msa-1'), { code: 'skins:noAccount' });
});

test('si la cuenta cambia mientras se renueva el token, no se toca nada', async () => {
  const accounts = fakeAccounts();
  const { service, calls, library } = setup({ accounts });
  const { item } = await library.add(skinPng('classic'), { name: 'X' });
  accounts.onLaunch = async () => {
    accounts.state.selected = 'offline-1';
  };
  await assert.rejects(service.apply(item.id, 'msa-1', 'classic'), { code: 'skins:accountChanged' });
  accounts.onLaunch = async () => {
    accounts.state.accounts[0].uuid = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  };
  accounts.state.selected = 'msa-1';
  await assert.rejects(service.apply(item.id, 'msa-1', 'classic'), { code: 'skins:accountChanged' });
  assert.equal(calls.length, 0, 'no se subio nada');
});

test('aplicar una skin de la biblioteca', async () => {
  const { service, calls, library } = setup();
  const { item } = await library.add(skinPng('slim'), { name: 'Fina' });
  const view = await service.apply(item.id, 'msa-1', 'slim');
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, 'https://api.minecraftservices.com/minecraft/profile/skins');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer secret-token');
  assert.equal(init.body.get('variant'), 'slim');
  assert.deepEqual(Buffer.from(await init.body.get('file').arrayBuffer()), skinPng('slim'));
  assert.equal(view.name, 'VenusTester');
  // el modelo elegido en la interfaz pisa el guardado; una de 64x32 va siempre como clasica
  const old = await library.add(skinPng('classic', 32), {});
  await service.apply(old.item.id, 'msa-1', 'slim');
  assert.equal(calls[1].init.body.get('variant'), 'classic');
  await assert.rejects(service.apply('noexiste1', 'msa-1', 'classic'), { code: 'skins:notFound' });
});

test('un solo cambio a la vez por cuenta', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { service, library } = setup({
    handler: async (url) => {
      if (url.endsWith('/skins')) await gate;
      return reply(200, PROFILE);
    },
  });
  const { item } = await library.add(skinPng('classic'), {});
  const first = service.apply(item.id, 'msa-1', 'classic');
  await new Promise((r) => setTimeout(r, 10));
  await assert.rejects(service.reset('msa-1'), { code: 'skins:busy' });
  await assert.rejects(service.cape(null, 'msa-1'), { code: 'skins:busy' });
  release();
  await first;
  await service.reset('msa-1');
});

test('volver a la skin por defecto y cambiar la capa', async () => {
  const { service, calls } = setup();
  await service.reset('msa-1');
  assert.equal(calls[0].init.method, 'DELETE');
  assert.ok(calls[0].url.endsWith('/minecraft/profile/skins/active'));
  await service.cape('cape-1', 'msa-1');
  assert.equal(calls[1].init.method, 'PUT');
  assert.deepEqual(JSON.parse(calls[1].init.body), { capeId: 'cape-1' });
  await service.cape(null, 'msa-1');
  assert.equal(calls[2].init.method, 'DELETE');
  assert.ok(calls[2].url.endsWith('/minecraft/profile/capes/active'));
  await assert.rejects(service.cape('../x', 'msa-1'), { code: 'skins:capeRejected' });
  assert.equal(calls.length, 3);
});

test('un cambio actualiza la cache del perfil', async () => {
  const { service, calls } = setup();
  await service.profile('msa-1');
  await service.cape(null, 'msa-1');
  const n = calls.length;
  const view = await service.profile('msa-1');
  assert.equal(calls.length, n, 'usa el perfil que devolvio el cambio');
  assert.equal(view.name, 'VenusTester');
});

test('sesion vencida y errores de la cuenta', async () => {
  const expired = setup({ accounts: fakeAccounts({ token: Object.assign(new Error('vencida'), { code: 'sessionExpired' }) }) });
  await assert.rejects(expired.service.profile('msa-1'), { code: 'skins:sessionExpired' });
  const net = setup({ accounts: fakeAccounts({ token: Object.assign(new Error('sin red'), { code: 'refreshFailed' }) }) });
  await assert.rejects(net.service.profile('msa-1'), { code: 'skins:network' });
  const other = setup({ accounts: fakeAccounts({ token: Object.assign(new Error('Texto de accounts'), { code: 'noGame' }) }) });
  await assert.rejects(other.service.profile('msa-1'), { code: 'skins:accountError', message: 'Texto de accounts' });
  const zero = setup({ accounts: fakeAccounts({ token: '0' }) });
  await assert.rejects(zero.service.profile('msa-1'), { code: 'skins:sessionExpired' });
  const http401 = setup({ handler: () => reply(401, {}) });
  await assert.rejects(http401.service.profile('msa-1'), { code: 'skins:sessionExpired' });
});

test('texturas como data: con tamanos validados y cache', async () => {
  const { service, calls } = setup();
  const skin = await service.texture(SKIN_URL, 'skin');
  assert.match(skin.dataUrl, /^data:image\/png;base64,/);
  assert.equal(skin.url, 'https://textures.minecraft.net/texture/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(skin.height, 64);
  await service.texture(SKIN_URL, 'skin');
  assert.equal(calls.length, 1, 'cache');
  const cape = await service.texture(CAPE_URL, 'cape');
  assert.equal(cape.width, 64);
  assert.equal(cape.height, 32);
  // una skin de 64x64 no puede pasar por capa
  await assert.rejects(service.texture(SKIN_URL, 'cape'), { code: 'skins:textureInvalid' });
  await assert.rejects(service.texture('https://example.com/texture/abcdef0123456789', 'skin'), { code: 'skins:badTextureUrl' });
});

test('guardar la skin actual en la biblioteca', async () => {
  const { service, library } = setup();
  const saved = await service.saveCurrent('msa-1');
  assert.equal(saved.duplicate, false);
  assert.equal(saved.item.name, 'Skin de VenusTester');
  assert.equal(saved.item.variant, 'classic', 'el modelo del perfil');
  assert.equal(saved.item.source, 'account');
  const again = await service.saveCurrent('msa-1');
  assert.equal(again.duplicate, true);
  assert.equal((await library.list()).items.length, 1);
});

test('varios archivos: agregados, repetidos y con error', async () => {
  const { service } = setup();
  const out = await service.addFiles([
    { name: 'Una', bytes: skinPng('classic') },
    { name: 'Otra vez', bytes: skinPng('classic') },
    { name: 'mala.png', bytes: Buffer.from('nada') },
    { name: 'grande.png', error: fail('tooBig') },
  ]);
  assert.deepEqual(out.added.map((i) => i.name), ['Una']);
  assert.deepEqual(out.duplicates.map((i) => i.name), ['Una']);
  assert.deepEqual(out.failed.map((f) => [f.name, f.code]), [
    ['mala.png', 'skins:invalidPng'],
    ['grande.png', 'skins:tooBig'],
  ]);
});

test('con el modo sin conexion del launcher no sale nada a la red', async () => {
  const { service, calls, library } = setup({ offline: true });
  await assert.rejects(service.profile('msa-1'), { code: 'skins:launcherOffline' });
  await assert.rejects(service.texture(SKIN_URL, 'skin'), { code: 'skins:launcherOffline' });
  const { item } = await library.add(skinPng('classic'), {});
  await assert.rejects(service.apply(item.id, 'msa-1', 'classic'), { code: 'skins:launcherOffline' });
  assert.equal(calls.length, 0);
  assert.equal((await service.library()).items.length, 1, 'la biblioteca anda sin red');
});
