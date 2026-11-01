'use strict';
// Pruebas del cliente de Minecraft Services con fetch falso: forma de cada pedido, lectura del perfil,
// lista blanca de texturas y errores HTTP.
const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../api');
const { reply, skinPng } = require('./fixtures');

const fail = (code, vars) => Object.assign(new Error(`skins.${code}${vars ? ` ${JSON.stringify(vars)}` : ''}`), { code: `skins:${code}` });

const PROFILE = {
  id: '0123456789abcdef0123456789abcdef',
  name: 'VenusTester',
  skins: [{ id: 'skin-1', state: 'ACTIVE', url: 'http://textures.minecraft.net/texture/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', variant: 'SLIM', textureKey: 'x' }],
  capes: [
    { id: '11111111-2222-3333-4444-555555555555', state: 'ACTIVE', url: 'http://textures.minecraft.net/texture/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', alias: 'Migrator' },
    { id: '66666666-7777-8888-9999-000000000000', state: 'INACTIVE', url: 'https://evil.example.com/texture/cccc', alias: 'Otra' },
  ],
};

function setup(handler) {
  const calls = [];
  const client = api.createMinecraftApi({
    fail,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return handler(url, init, calls.length);
    },
  });
  return { client, calls };
}

test('perfil: GET con Bearer y datos saneados', async () => {
  const { client, calls } = setup(() => reply(200, PROFILE));
  const p = await client.getProfile('tok-123');
  assert.equal(calls[0].url, 'https://api.minecraftservices.com/minecraft/profile');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok-123');
  assert.equal(calls[0].init.redirect, 'error', 'nunca sigue redirecciones');
  assert.ok(calls[0].init.signal, 'con tiempo limite');
  assert.equal(p.name, 'VenusTester');
  assert.deepEqual(p.skins[0], { id: 'skin-1', state: 'active', variant: 'slim', textureUrl: 'https://textures.minecraft.net/texture/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', alias: null });
  assert.equal(p.capes.length, 2);
  assert.equal(p.capes[0].state, 'active');
  assert.equal(p.capes[0].alias, 'Migrator');
  assert.equal(p.capes[1].textureUrl, null, 'una URL de otro dominio se descarta');
});

test('perfil: respuestas raras', async () => {
  assert.equal(api.parseProfile(null), null);
  assert.equal(api.parseProfile({ id: 'corto', name: 'x' }), null);
  assert.equal(api.parseProfile([]), null);
  const p = api.parseProfile({ id: '0123456789ABCDEF0123456789ABCDEF', name: 'Ok', skins: [null, { id: '../x' }, { id: 'ok', variant: 'GIANT' }], capes: 'no' });
  assert.equal(p.id, '0123456789abcdef0123456789abcdef');
  assert.deepEqual(p.skins, [{ id: 'ok', state: 'inactive', variant: 'classic', textureUrl: null, alias: null }]);
  assert.deepEqual(p.capes, []);
  // perfil inexistente o cuerpo invalido
  const notFound = setup(() => reply(404, { error: 'NOT_FOUND' }));
  await assert.rejects(notFound.client.getProfile('t'), { code: 'skins:noProfile' });
  const garbage = setup(() => reply(200, 'no es json'));
  await assert.rejects(garbage.client.getProfile('t'), { code: 'skins:serviceUnavailable' });
});

test('subir skin: multipart con variant y file PNG', async () => {
  const bytes = skinPng('slim');
  const { client, calls } = setup(() => reply(200, PROFILE));
  const p = await client.uploadSkin('tok', { bytes, variant: 'slim', fileName: 'abc def.png' });
  const { url, init } = calls[0];
  assert.equal(url, 'https://api.minecraftservices.com/minecraft/profile/skins');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer tok');
  assert.equal(init.headers['Content-Type'], undefined, 'el boundary lo pone FormData');
  assert.ok(init.body instanceof FormData);
  assert.equal(init.body.get('variant'), 'slim');
  const file = init.body.get('file');
  assert.equal(file.type, 'image/png');
  assert.equal(file.name, 'abc_def.png');
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
  assert.equal(p.name, 'VenusTester');
  assert.throws(() => client.uploadSkin('tok', { bytes, variant: 'giant' }), { code: 'skins:badVariant' });
});

test('volver a la skin por defecto: DELETE skins/active', async () => {
  const { client, calls } = setup(() => reply(200, PROFILE));
  await client.resetSkin('tok');
  assert.equal(calls[0].url, 'https://api.minecraftservices.com/minecraft/profile/skins/active');
  assert.equal(calls[0].init.method, 'DELETE');
});

test('capa: PUT con capeId y DELETE para ocultarla', async () => {
  const { client, calls } = setup(() => reply(200, PROFILE));
  await client.showCape('tok', '11111111-2222-3333-4444-555555555555');
  assert.equal(calls[0].url, 'https://api.minecraftservices.com/minecraft/profile/capes/active');
  assert.equal(calls[0].init.method, 'PUT');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), { capeId: '11111111-2222-3333-4444-555555555555' });
  await client.hideCape('tok');
  assert.equal(calls[1].url, 'https://api.minecraftservices.com/minecraft/profile/capes/active');
  assert.equal(calls[1].init.method, 'DELETE');
  assert.throws(() => client.showCape('tok', '../../x'), { code: 'skins:capeRejected' });
  // cuerpo vacio: sin perfil, pero sin error
  const empty = setup(() => reply(200, ''));
  assert.equal(await empty.client.hideCape('tok'), null);
});

test('errores HTTP con su codigo', async () => {
  const cases = [
    [401, 'getProfile', 'skins:sessionExpired'],
    [403, 'getProfile', 'skins:forbidden'],
    [429, 'getProfile', 'skins:rateLimited'],
    [500, 'getProfile', 'skins:serviceUnavailable'],
    [503, 'resetSkin', 'skins:serviceUnavailable'],
    [400, 'uploadSkin', 'skins:skinRejected'],
    [400, 'showCape', 'skins:capeRejected'],
    [418, 'resetSkin', 'skins:rejected'],
  ];
  for (const [status, method, code] of cases) {
    const { client } = setup(() => reply(status, { errorMessage: 'x' }));
    const args = method === 'uploadSkin' ? [{ bytes: skinPng(), variant: 'classic' }] : method === 'showCape' ? ['abc'] : [];
    await assert.rejects(client[method]('tok', ...args), { code }, `${status} ${method}`);
  }
  const net = setup(() => {
    throw new TypeError('fetch failed');
  });
  await assert.rejects(net.client.getProfile('tok'), { code: 'skins:network' });
  const slow = setup(() => {
    throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
  });
  await assert.rejects(slow.client.getProfile('tok'), { code: 'skins:timeout' });
  const noToken = setup(() => reply(200, PROFILE));
  await assert.rejects(noToken.client.getProfile(''), { code: 'skins:sessionExpired' });
  assert.equal(noToken.calls.length, 0, 'sin token no se llama a la red');
});

test('texturas: solo textures.minecraft.net, por https y con tope de tamano', async () => {
  assert.equal(api.textureUrl('http://textures.minecraft.net/texture/abcdef0123456789'), 'https://textures.minecraft.net/texture/abcdef0123456789');
  for (const bad of [
    'https://textures.minecraft.net.evil.com/texture/abcdef0123456789',
    'https://evil.com/texture/abcdef0123456789',
    'ftp://textures.minecraft.net/texture/abcdef0123456789',
    'https://textures.minecraft.net:8443/texture/abcdef0123456789',
    'https://user@textures.minecraft.net/texture/abcdef0123456789',
    'https://textures.minecraft.net/texture/abcdef0123456789?x=1',
    'https://textures.minecraft.net/other/abcdef0123456789',
    'https://textures.minecraft.net/texture/../../x',
    'file:///C:/Windows/win.ini',
    42,
    '',
  ]) {
    assert.equal(api.textureUrl(bad), null, String(bad));
  }
  const bytes = skinPng();
  const { client, calls } = setup(() => reply(200, bytes, { headers: { 'Content-Type': 'image/png' } }));
  const got = await client.fetchTexture('http://textures.minecraft.net/texture/abcdef0123456789');
  assert.deepEqual(got, bytes);
  assert.equal(calls[0].url, 'https://textures.minecraft.net/texture/abcdef0123456789');
  assert.equal(calls[0].init.headers.Authorization, undefined, 'las texturas no llevan token');
  await assert.rejects(client.fetchTexture('https://evil.com/texture/abcdef0123456789'), { code: 'skins:badTextureUrl' });
  assert.equal(calls.length, 1, 'una URL rechazada no sale a la red');
  const huge = setup(() => reply(200, Buffer.alloc(300 * 1024)));
  await assert.rejects(huge.client.fetchTexture('https://textures.minecraft.net/texture/abcdef0123456789'), { code: 'skins:tooLarge' });
  const declared = setup(() => reply(200, Buffer.alloc(10), { headers: { 'Content-Length': String(10 * 1024 * 1024) } }));
  await assert.rejects(declared.client.fetchTexture('https://textures.minecraft.net/texture/abcdef0123456789'), { code: 'skins:tooLarge' });
  const missing = setup(() => reply(404, ''));
  await assert.rejects(missing.client.fetchTexture('https://textures.minecraft.net/texture/abcdef0123456789'), { code: 'skins:textureMissing' });
});
