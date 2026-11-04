'use strict';
// El módulo escuchando los eventos reales de core/servers, con fetch falso: qué avisa, qué no y qué guarda. Sin Electron.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const paths = require('../../../core/paths');
const servers = require('../../../core/servers');
const discord = require('../../serverdiscord');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venus-discord-'));
paths.setRoot(dir);
const addServer = (id) => {
  fs.mkdirSync(path.join(dir, 'servers', id), { recursive: true });
  fs.writeFileSync(path.join(dir, 'servers', id, 'venus-server.json'), JSON.stringify({ type: 'paper', name: 'Mi server', mcVersion: '1.21.4', port: 25999, installed: true }));
};
addServer('srv1');
addServer('srv2');

const URL_OK = 'https://discord.com/api/webhooks/123456789012345678/aBcD_eFgH-iJkLmNoPqRsTuVwXyZ0123456789';
const handlers = new Map();
const sent = [];
const realFetch = globalThis.fetch;
let responder = () => new Response(null, { status: 204 });
const calls = [];
globalThis.fetch = async (url, opts) => {
  calls.push({ url, opts, body: JSON.parse(opts.body) });
  return responder();
};
discord.register({ handle: (ch, fn) => handlers.set(ch, fn), send: (...a) => sent.push(a), onQuit: () => {} });
const call = (ch, ...a) => handlers.get(ch)(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(20);
  }
  return false;
};
const emitState = (id, state, extra = {}) => servers.events.emit('state', id, { state, players: [], playerInfo: [], ...extra });

test.after(() => {
  globalThis.fetch = realFetch;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sin webhook no se manda nada', async () => {
  const v = await call('serverdiscord:get', 'srv1');
  assert.equal(v.configured, false);
  assert.equal(v.enabled, false);
  emitState('srv1', 'starting');
  emitState('srv1', 'online');
  emitState('srv1', 'offline');
  await sleep(120);
  assert.equal(calls.length, 0);
});

test('un webhook inválido no se guarda', async () => {
  await assert.rejects(call('serverdiscord:set', 'srv1', { url: 'https://evil.example/api/webhooks/1/2' }), (err) => err.code === 'invalid');
  assert.equal((await call('serverdiscord:get', 'srv1')).configured, false);
  await assert.rejects(call('serverdiscord:test', 'srv1'), (err) => err.code === 'none');
});

test('guardar: no vuelve el secreto, los ajustes van al servidor y el secreto no', async () => {
  const v = await call('serverdiscord:set', 'srv1', { url: URL_OK });
  assert.equal(v.configured, true);
  assert.equal(v.enabled, true);
  assert.ok(!JSON.stringify(v).includes('aBcD_eFgH'));
  assert.deepEqual(v.events, { started: true, stopped: true, crashed: true, join: false, leave: false, backup: false });
  const meta = fs.readFileSync(path.join(dir, 'servers', 'srv1', 'venus-server.json'), 'utf8');
  assert.ok(!meta.includes('aBcD_eFgH'));
  assert.ok(meta.includes('discordNotify'));
  // Sin almacén del sistema (acá no hay Electron): queda solo en memoria, nunca en el archivo
  await sleep(50);
  const secure = fs.readFileSync(path.join(dir, 'data', 'secure.json'), 'utf8');
  assert.ok(!secure.includes('aBcD_eFgH'));
  assert.ok(secure.includes('mem:'));
});

test('se prendió, se apagó y se cayó avisan una sola vez', async () => {
  calls.length = 0;
  emitState('srv1', 'starting');
  emitState('srv1', 'online');
  emitState('srv1', 'online', { players: ['a'] }); // el mismo estado con otros jugadores no avisa
  assert.ok(await until(() => calls.length >= 1));
  assert.equal(calls[0].url, URL_OK);
  assert.equal(calls[0].opts.redirect, 'error');
  assert.deepEqual(calls[0].body.allowed_mentions, { parse: [] });
  emitState('srv1', 'stopping');
  emitState('srv1', 'offline', { code: 0, crashed: false });
  assert.ok(await until(() => calls.length >= 2));
  emitState('srv1', 'starting');
  emitState('srv1', 'online');
  emitState('srv1', 'offline', { code: 1, crashed: true });
  assert.ok(await until(() => calls.length >= 4), `llegaron ${calls.length}`);
  await sleep(50);
  const titles = calls.map((c) => c.body.embeds[0].title);
  assert.equal(titles.length, 4);
  assert.ok(titles[0].includes('Mi server'));
  assert.notEqual(titles[0], titles[1]);
  assert.equal(titles[0], titles[2]);
  assert.notEqual(titles[1], titles[3]);
});

test('un arranque que nunca llegó a estar en línea no avisa que se apagó', async () => {
  calls.length = 0;
  emitState('srv1', 'starting');
  emitState('srv1', 'stopping');
  emitState('srv1', 'offline', { code: 0 });
  await sleep(150);
  assert.equal(calls.length, 0);
});

test('jugadores y copias solo si se eligieron', async () => {
  calls.length = 0;
  servers.events.emit('player', 'srv1', { type: 'join', name: 'Steve' });
  servers.events.emit('backup', 'srv1', { auto: true });
  await sleep(150);
  assert.equal(calls.length, 0);
  await call('serverdiscord:set', 'srv1', { events: { join: true, leave: true, backup: true } });
  servers.events.emit('player', 'srv1', { type: 'join', name: '@everyone' });
  assert.ok(await until(() => calls.length >= 1));
  const body = JSON.stringify(calls[0].body);
  assert.ok(!body.includes('@everyone'));
  assert.deepEqual(calls[0].body.allowed_mentions, { parse: [] });
  await call('serverdiscord:set', 'srv1', { events: { join: false } });
  const v = await call('serverdiscord:get', 'srv1');
  assert.equal(v.events.join, false);
  assert.equal(v.events.leave, true);
});

test('apagar los avisos los corta, sin perder el webhook', async () => {
  calls.length = 0;
  const v = await call('serverdiscord:set', 'srv1', { enabled: false });
  assert.equal(v.enabled, false);
  assert.equal(v.configured, true);
  emitState('srv1', 'starting');
  emitState('srv1', 'online');
  await sleep(150);
  assert.equal(calls.length, 0);
  await call('serverdiscord:set', 'srv1', { enabled: true });
  emitState('srv1', 'offline');
});

test('Probar: resultado real y webhook rechazado por Discord', async () => {
  // La cola espera 2,1 s entre pedidos
  await until(() => false, 2300);
  responder = () => new Response(null, { status: 204 });
  assert.deepEqual(await call('serverdiscord:test', 'srv1'), { ok: true });
  await until(() => false, 2300);
  responder = () => new Response(null, { status: 404 });
  await assert.rejects(call('serverdiscord:test', 'srv1'), (err) => err.code === 'invalid' && err.message.length > 0);
  const v = await call('serverdiscord:get', 'srv1');
  assert.equal(v.lastError, 'invalid');
  responder = () => new Response(null, { status: 204 });
});

test('quitar el webhook y borrar el servidor limpian el secreto', async () => {
  await call('serverdiscord:set', 'srv2', { url: URL_OK });
  await call('serverdiscord:remove', 'srv2');
  const v = await call('serverdiscord:get', 'srv2');
  assert.equal(v.configured, false);
  assert.equal(v.enabled, false);
  await discord.forget('srv1');
  await sleep(50);
  const secure = fs.readFileSync(path.join(dir, 'data', 'secure.json'), 'utf8');
  assert.ok(!secure.includes('serverdiscord.webhook.'));
});

test('sin conexión al Discord el servidor no se entera: el evento no lanza', async () => {
  await call('serverdiscord:set', 'srv2', { url: URL_OK });
  globalThis.fetch = async () => {
    throw new Error('sin red');
  };
  assert.doesNotThrow(() => {
    emitState('srv2', 'starting');
    emitState('srv2', 'online');
  });
  await sleep(100);
});
