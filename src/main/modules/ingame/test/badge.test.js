'use strict';
// Pruebas de la insignia de Venus (sin Electron): cada instancia compatible recibe el mod de su loader y version, se
// actualiza solo si cambia, respeta si el jugador lo desactivo y se quita al apagarla; el registro pasa por el
// desafio, Mojang y la Edge Function sin mandar el token de Minecraft a Venus.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const badgeMod = require('../badgemod');
const { createBadgeClient, normalizeUuid, MOJANG_JOIN } = require('../badge');

const dirs = [];
function tmpDir() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'venus-badge-')));
  dirs.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function bundle(content = 'jar-1') {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, badgeMod.BUILDS[0].jar), content);
  return dir;
}
const SERVER = { url: 'https://example.supabase.co', anonKey: 'anon-publica' };
const modFile = (inst) => path.join(inst, 'mods', badgeMod.MOD_FILE);
const cfgFile = (inst) => path.join(inst, 'config', badgeMod.CONFIG_FILE);

test('cada loader y version con compilacion tiene su jar; el resto, ninguno', () => {
  const jars = {
    'fabric 1.21.1': 'venus-badge-mc1.21.1-fabric.jar',
    'fabric 1.21': 'venus-badge-mc1.21.1-fabric.jar',
    'quilt 1.21.1': 'venus-badge-mc1.21.1-fabric.jar',
    'fabric 1.20.1': 'venus-badge-mc1.20.1-fabric.jar',
    'quilt 1.20.1': 'venus-badge-mc1.20.1-fabric.jar',
    'neoforge 1.21.1': 'venus-badge-mc1.21.1-neoforge.jar',
    'neoforge 1.21': 'venus-badge-mc1.21.1-neoforge.jar',
    'forge 1.20.1': 'venus-badge-mc1.20.1-forge.jar',
  };
  for (const [what, jar] of Object.entries(jars)) {
    const [loader, v] = what.split(' ');
    assert.equal(badgeMod.buildFor(loader, v)?.jar, jar, what);
  }
  for (const [loader, v] of [['vanilla', '1.21.1'], ['optifine', '1.21.1'], ['forge', '1.21.1'], ['forge', '1.20'], ['neoforge', '1.20.1'], ['fabric', '1.21.4'], ['fabric', '1.20'], ['legacyfabric', '1.20.1']]) {
    assert.equal(badgeMod.buildFor(loader, v), null, `${loader} ${v}`);
  }
  assert.deepEqual(badgeMod.supportedVersions(), ['1.20.1', '1.21', '1.21.1']);
});

test('no instala con un loader mas viejo que el que pide el jar (el juego no arrancaria)', async () => {
  for (const [loader, mc, old, ok] of [['fabric', '1.21.1', '0.15.10', '0.15.11'], ['quilt', '1.21.1', '0.25.0', '0.26.0'], ['fabric', '1.20.1', '0.14.20', '0.14.21'], ['quilt', '1.20.1', '0.18.10', '0.19.0']]) {
    assert.equal(badgeMod.buildFor(loader, mc, old), null, `${loader} ${old}`);
    assert.ok(badgeMod.buildFor(loader, mc, ok), `${loader} ${ok}`);
    assert.ok(badgeMod.buildFor(loader, mc, 'latest'), `${loader} latest`);
    assert.ok(badgeMod.buildFor(loader, mc, undefined), `${loader} sin version`);
  }
  assert.ok(badgeMod.buildFor('forge', '1.20.1', '47.1.0'));
  assert.ok(badgeMod.buildFor('forge', '1.20.1', '1.20.1-47.1.0'));
  assert.ok(badgeMod.buildFor('neoforge', '1.21.1', '21.1.1'));
  const inst = tmpDir();
  const bundledDir = bundle();
  await badgeMod.apply({ instanceDir: inst, loader: 'fabric', loaderVersion: '0.16.14', mcVersion: '1.21.1', enabled: true, server: SERVER, bundledDir });
  assert.deepEqual(await badgeMod.apply({ instanceDir: inst, loader: 'fabric', loaderVersion: '0.15.3', mcVersion: '1.21.1', enabled: true, server: SERVER, bundledDir }), { state: 'unsupported' });
  assert.equal(fs.existsSync(modFile(inst)), false);
});

test('instala el jar de la instancia y lo cambia si la instancia cambia de loader o version', async () => {
  const inst = tmpDir();
  const bundledDir = tmpDir();
  for (const b of badgeMod.BUILDS) fs.writeFileSync(path.join(bundledDir, b.jar), b.jar);
  for (const [loader, mcVersion, jar] of [
    ['forge', '1.20.1', 'venus-badge-mc1.20.1-forge.jar'],
    ['neoforge', '1.21.1', 'venus-badge-mc1.21.1-neoforge.jar'],
    ['quilt', '1.21', 'venus-badge-mc1.21.1-fabric.jar'],
    ['fabric', '1.20.1', 'venus-badge-mc1.20.1-fabric.jar'],
  ]) {
    assert.deepEqual(await badgeMod.apply({ instanceDir: inst, loader, mcVersion, enabled: true, server: SERVER, bundledDir }), { state: 'installed', written: true });
    assert.equal(fs.readFileSync(modFile(inst), 'utf8'), jar);
    assert.deepEqual(fs.readdirSync(path.join(inst, 'mods')), [badgeMod.MOD_FILE]);
  }
});

test('instala el mod y la config con el servidor, y no reescribe si no cambio', async () => {
  const inst = tmpDir();
  const bundledDir = bundle();
  const first = await badgeMod.apply({ instanceDir: inst, loader: 'fabric', mcVersion: '1.21.1', enabled: true, server: SERVER, bundledDir });
  assert.deepEqual(first, { state: 'installed', written: true });
  assert.equal(fs.readFileSync(modFile(inst), 'utf8'), 'jar-1');
  assert.deepEqual(JSON.parse(fs.readFileSync(cfgFile(inst), 'utf8')), SERVER);
  const again = await badgeMod.apply({ instanceDir: inst, loader: 'fabric', mcVersion: '1.21.1', enabled: true, server: SERVER, bundledDir });
  assert.deepEqual(again, { state: 'installed', written: false });
  const updated = await badgeMod.apply({ instanceDir: inst, loader: 'fabric', mcVersion: '1.21.1', enabled: true, server: SERVER, bundledDir: bundle('jar-2') });
  assert.equal(updated.written, true);
  assert.equal(fs.readFileSync(modFile(inst), 'utf8'), 'jar-2');
  assert.deepEqual(fs.readdirSync(path.join(inst, 'mods')), [badgeMod.MOD_FILE]); // sin temporales
});

test('la config que dejo la 4.5 con showCapes se reescribe solo con el servidor (las capas se retiraron)', async () => {
  const inst = tmpDir();
  fs.mkdirSync(path.dirname(cfgFile(inst)), { recursive: true });
  fs.writeFileSync(cfgFile(inst), JSON.stringify({ ...SERVER, showCapes: false }, null, 2));
  const res = await badgeMod.apply({ instanceDir: inst, loader: 'fabric', mcVersion: '1.21.1', enabled: true, server: SERVER, bundledDir: bundle(), showCapes: false });
  assert.deepEqual(res, { state: 'installed', written: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(cfgFile(inst), 'utf8')), SERVER); // aunque alguien todavia pase showCapes
});

test('apagada o en una instancia incompatible, lo quita', async () => {
  const inst = tmpDir();
  const bundledDir = bundle();
  await badgeMod.apply({ instanceDir: inst, loader: 'fabric', mcVersion: '1.21.1', enabled: true, server: SERVER, bundledDir });
  // El jugador cambio la instancia a 1.21.4: el mod no carga ahi
  assert.deepEqual(await badgeMod.apply({ instanceDir: inst, loader: 'fabric', mcVersion: '1.21.4', enabled: true, server: SERVER, bundledDir }), { state: 'unsupported' });
  assert.equal(fs.existsSync(modFile(inst)), false);
  assert.equal(fs.existsSync(cfgFile(inst)), false);
  await badgeMod.apply({ instanceDir: inst, loader: 'fabric', mcVersion: '1.21.1', enabled: true, server: SERVER, bundledDir });
  assert.deepEqual(await badgeMod.apply({ instanceDir: inst, loader: 'fabric', mcVersion: '1.21.1', enabled: false, bundledDir }), { state: 'removed' });
  assert.equal(fs.existsSync(modFile(inst)), false);
  assert.deepEqual(await badgeMod.apply({ instanceDir: inst, loader: 'fabric', mcVersion: '1.21.1', enabled: false, bundledDir }), { state: 'off' });
});

test('vanilla, OptiFine y Forge de una version sin compilacion no reciben nada', async () => {
  for (const loader of ['vanilla', 'optifine', 'forge']) {
    const inst = tmpDir();
    assert.deepEqual(await badgeMod.apply({ instanceDir: inst, loader, mcVersion: '1.21.1', enabled: true, server: SERVER, bundledDir: bundle() }), { state: 'unsupported' });
    assert.equal(fs.existsSync(path.join(inst, 'mods')), false);
  }
});

test('respeta el mod desactivado por el jugador y no falla sin el jar empaquetado', async () => {
  const inst = tmpDir();
  fs.mkdirSync(path.join(inst, 'mods'));
  fs.writeFileSync(`${modFile(inst)}.disabled`, 'viejo');
  assert.deepEqual(await badgeMod.apply({ instanceDir: inst, loader: 'fabric', mcVersion: '1.21.1', enabled: true, server: SERVER, bundledDir: bundle() }), { state: 'userDisabled' });
  assert.equal(fs.existsSync(modFile(inst)), false);
  const other = tmpDir();
  assert.deepEqual(await badgeMod.apply({ instanceDir: other, loader: 'fabric', mcVersion: '1.21.1', enabled: true, server: SERVER, bundledDir: tmpDir() }), { state: 'missing' });
  assert.equal(await badgeMod.bundled(tmpDir()), false);
  assert.equal(await badgeMod.bundled(bundle()), true);
});

// ---------- Registro en el servidor ----------
const MC = '0f8a5c2e-1b3d-4e6f-9a7b-8c9d0e1f2a3b';
const ACCOUNT = { type: 'msa', name: 'Steve', uuid: MC.replace(/-/g, ''), accessToken: 'token-de-minecraft' };
const CHALLENGE = 'c'.repeat(40);
const CFG = { url: 'https://example.supabase.co', anonKey: 'anon', configured: true };

function fakeServer({ mine = [], joinStatus = 204, joinBody = null, badge = null, challenge = CHALLENGE } = {}) {
  const calls = [];
  const reply = (status, body) => new Response(body == null ? null : JSON.stringify(body), { status });
  const fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, headers: init?.headers || {}, body });
    if (url.endsWith('/rest/v1/rpc/badge_mine')) return reply(200, mine);
    if (url.endsWith('/rest/v1/rpc/badge_challenge')) return reply(200, challenge);
    if (url.endsWith('/rest/v1/rpc/badge_remove')) return reply(200, 2);
    if (url === MOJANG_JOIN) return reply(joinStatus, joinBody);
    if (url.endsWith('/functions/v1/badge')) return badge ? badge(body) : reply(200, { uuid: body.uuid, name: body.name });
    throw new Error(`inesperado: ${url}`);
  };
  const client = createBadgeClient({ fetch, cloudConfig: async () => CFG, accessToken: async () => 'token-de-venus' });
  return { client, calls };
}

test('anota la cuenta: desafio, Mojang con el token de Minecraft y la Edge Function sin el token', async () => {
  const { client, calls } = fakeServer();
  assert.equal(await client.enroll(ACCOUNT), MC);
  assert.deepEqual(calls.map((c) => c.url), [`${CFG.url}/rest/v1/rpc/badge_challenge`, MOJANG_JOIN, `${CFG.url}/functions/v1/badge`]);
  assert.deepEqual(calls[1].body, { accessToken: 'token-de-minecraft', selectedProfile: ACCOUNT.uuid, serverId: CHALLENGE });
  assert.equal(calls[1].headers.Authorization, undefined); // a Mojang no va la sesion de Venus
  assert.deepEqual(calls[2].body, { uuid: MC, name: 'Steve', serverId: CHALLENGE });
  assert.equal(calls[2].headers.Authorization, 'Bearer token-de-venus');
  for (const c of [calls[0], calls[2]]) assert.ok(!JSON.stringify(c).includes('token-de-minecraft'));
});

test('ensure no vuelve a verificar una cuenta ya anotada', async () => {
  const { client, calls } = fakeServer({ mine: [MC] });
  assert.deepEqual(await client.ensure(ACCOUNT), { uuid: MC, enrolled: false });
  assert.equal(calls.length, 1);
  const second = fakeServer({ mine: [] });
  assert.deepEqual(await second.client.ensure(ACCOUNT), { uuid: MC, enrolled: true });
});

test('errores con codigo para la interfaz', async () => {
  const cases = [
    [{ joinStatus: 403, joinBody: { error: 'InsufficientPrivilegesException' } }, 'multiplayerDisabled'],
    [{ joinStatus: 403, joinBody: { error: 'ForbiddenOperationException', errorMessage: 'Invalid token' } }, 'mojangSession'],
    [{ joinStatus: 500 }, 'mojang'],
    [{ badge: () => new Response(JSON.stringify({ error: { code: 'not_verified' } }), { status: 403 }) }, 'notVerified'],
    [{ badge: () => new Response(JSON.stringify({ error: { code: 'too_many_accounts' } }), { status: 409 }) }, 'tooManyAccounts'],
    [{ badge: () => new Response(JSON.stringify({ error: { code: 'user_banned' } }), { status: 403 }) }, 'banned'],
    [{ badge: () => new Response('', { status: 404 }) }, 'unavailable'],
    [{ challenge: 'no-es-un-desafio' }, 'server'],
  ];
  for (const [opts, code] of cases) {
    const { client } = fakeServer(opts);
    await assert.rejects(client.enroll(ACCOUNT), (err) => err.code === code, code);
  }
  const { client } = fakeServer();
  await assert.rejects(client.enroll({ type: 'offline', name: 'Steve', uuid: MC }), { code: 'offlineAccount' });
  const noSession = createBadgeClient({ fetch: async () => { throw new Error('no deberia llamar'); }, cloudConfig: async () => CFG, accessToken: async () => null });
  await assert.rejects(noSession.mine(), { code: 'noSession' });
  const offline = createBadgeClient({ fetch: async () => { throw new TypeError('fetch failed'); }, cloudConfig: async () => CFG, accessToken: async () => 't' });
  await assert.rejects(offline.mine(), { code: 'network' });
});

test('borrar y leer las propias con la sesion de Venus', async () => {
  const { client, calls } = fakeServer({ mine: [MC.replace(/-/g, '').toUpperCase()] });
  assert.deepEqual(await client.mine(), [MC]);
  assert.equal(await client.remove(), 2);
  assert.deepEqual(calls.at(-1).body, { p_uuid: null });
  await client.remove(ACCOUNT.uuid);
  assert.deepEqual(calls.at(-1).body, { p_uuid: MC });
});

test('normalizeUuid', () => {
  assert.equal(normalizeUuid(ACCOUNT.uuid), MC);
  assert.equal(normalizeUuid('x'), null);
});

test('enroll con mcverify llama a esa función y devuelve si se pagó la invitación', async () => {
  const { client, calls } = fakeServer();
  const fetchCalls = calls;
  const res = await createBadgeClient({
    fetch: async (url, init) => {
      fetchCalls.push({ url });
      if (url.endsWith('/rest/v1/rpc/badge_challenge')) return new Response(JSON.stringify(CHALLENGE), { status: 200 });
      if (url === MOJANG_JOIN) return new Response(null, { status: 204 });
      if (url.endsWith('/functions/v1/mcverify')) return new Response(JSON.stringify({ uuid: MC, name: 'Steve', rewarded: true }), { status: 200 });
      throw new Error(`inesperado: ${url}`);
    },
    cloudConfig: async () => CFG,
    accessToken: async () => 'token-de-venus',
  }).enroll(ACCOUNT, { fn: 'mcverify' });
  assert.deepEqual(res, { uuid: MC, rewarded: true });
  assert.ok(fetchCalls.some((c) => c.url.endsWith('/functions/v1/mcverify')));
  await assert.rejects(client.enroll(ACCOUNT, { fn: 'otra' }), { code: 'server' });
});
