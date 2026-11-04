'use strict';
// El módulo con los servidores de verdad (core/servers) en una carpeta temporal y "red local" en 127.0.0.1: canales,
// quién puede elegir la dirección, textos de la página y lo que queda de pie al apagar. Sin Electron.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const paths = require('../../../core/paths');
const remote = require('../../serverremote');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venus-remote-'));
paths.setRoot(dir);
fs.mkdirSync(path.join(dir, 'servers', 'srv1'), { recursive: true });
fs.writeFileSync(path.join(dir, 'servers', 'srv1', 'venus-server.json'), JSON.stringify({ type: 'paper', name: 'Prueba', mcVersion: '1.21.4', port: 25999, installed: true }));

process.env.VENUS_DEVSHOT = dir;
process.env.VENUS_REMOTE_FAKE_LAN = '1';

const handlers = new Map();
const sent = [];
const quit = [];
remote.register({ app: { isPackaged: false }, handle: (ch, fn) => handlers.set(ch, fn), send: (...a) => sent.push(a), onQuit: (fn) => quit.push(fn) });
const call = (ch, ...a) => handlers.get(ch)(...a);

function get(port, path_, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: path_, setHost: false, agent: false, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

test.after(async () => {
  for (const fn of quit) await fn();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('apagado por defecto; un servidor que no existe da error', async () => {
  assert.deepEqual(await call('serverremote:status', 'srv1'), { on: false });
  await assert.rejects(call('serverremote:status', 'noexiste'));
  await assert.rejects(call('serverremote:start', '../../etc'));
});

test('la dirección solo sale de la lista: pedir otra no cambia dónde escucha', async () => {
  for (const address of ['0.0.0.0', '::', '8.8.8.8', '192.168.0.1', { toString: () => '0.0.0.0' }, undefined]) {
    const st = await call('serverremote:start', 'srv1', { address });
    assert.equal(st.address, '127.0.0.1', String(address));
    await call('serverremote:stop', 'srv1');
  }
});

test('prender: QR, código, y cada encendido genera un token nuevo; prender dos veces no abre otro', async () => {
  const a = await call('serverremote:start', 'srv1', {});
  assert.ok(a.on);
  assert.ok(a.qr.size >= 21);
  const same = await call('serverremote:start', 'srv1', {});
  assert.equal(same.url, a.url, 'ya estaba prendido');
  await call('serverremote:stop', 'srv1');
  const b = await call('serverremote:start', 'srv1', {});
  assert.notEqual(new URL(b.url).hash, new URL(a.url).hash);
  await call('serverremote:stop', 'srv1');
  for (const [ch, , ev] of sent) if (ch === 'serverremote:changed') assert.ok(!JSON.stringify(ev).includes(new URL(b.url).hash.slice(3)), 'los eventos no llevan el token');
});

test('la página ve el servidor: sin token no, con token sí; apagar lo corta', async () => {
  const st = await call('serverremote:start', 'srv1', {});
  const { port } = st;
  assert.equal((await get(port, '/api/state')).status, 401);
  const res = await get(port, '/api/state', { 'x-venus-token': new URL(st.url).hash.slice(3) });
  assert.equal(res.status, 200);
  const data = JSON.parse(res.text);
  assert.equal(data.server.name, 'Prueba');
  assert.equal(data.server.state, 'offline');
  const strings = JSON.parse((await get(port, '/strings.json')).text);
  assert.ok(strings.page_start);
  await call('serverremote:stop', 'srv1');
  await assert.rejects(get(port, '/'));
});

test('acciones de verdad con el servidor apagado: contesta el motivo sin tocar nada', async () => {
  const st = await call('serverremote:start', 'srv1', {});
  const post = (body) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: st.port, path: '/api/action', method: 'POST', setHost: false, agent: false, headers: { Host: `127.0.0.1:${st.port}`, 'x-venus-token': new URL(st.url).hash.slice(3), 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end(data);
  });
  assert.deepEqual(await post({ action: 'stop', confirm: true }), { status: 409, json: { error: 'offline' } });
  assert.deepEqual(await post({ action: 'restart', confirm: true }), { status: 409, json: { error: 'offline' } });
  assert.deepEqual(await post({ action: 'command', command: 'list', confirm: true }), { status: 409, json: { error: 'offline' } });
  await call('serverremote:stop', 'srv1');
});

test('fuera del modo de capturas no hay forma de escuchar en 127.0.0.1', async () => {
  const before = process.env.VENUS_REMOTE_FAKE_LAN;
  delete process.env.VENUS_REMOTE_FAKE_LAN;
  try {
    for (const a of remote.addresses()) assert.notEqual(a.address, '127.0.0.1');
    for (const a of remote.addresses()) assert.ok(/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address), a.address);
  } finally {
    process.env.VENUS_REMOTE_FAKE_LAN = before;
  }
});

test('textos de la página: todos en español e inglés y ninguno afuera de la lista', () => {
  const page = path.join(__dirname, '..', 'page');
  const html = fs.readFileSync(path.join(page, 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(page, 'app.js'), 'utf8');
  const used = new Set([...html.matchAll(/data-(?:t|ph)="(page_\w+)"/g)].map((m) => m[1]));
  for (const m of js.matchAll(/T\('(page_\w+)'/g)) if (!m[1].endsWith('_')) used.add(m[1]);
  for (const state of ['online', 'offline', 'starting', 'stopping']) used.add(`page_state_${state}`);
  for (const err of ['busy', 'offline', 'bad_command', 'too_large', 'failed']) used.add(`page_err_${err}`);
  assert.ok(used.size > 20);
  const es = require('../../../i18n/es/serverremote.js');
  const en = require('../../../i18n/en/serverremote.js');
  for (const key of used) {
    assert.ok(remote.PAGE_KEYS.includes(key), `${key} no viaja a la página`);
    assert.ok(es[key], `${key} falta en español`);
    assert.ok(en[key], `${key} falta en inglés`);
  }
  for (const key of remote.PAGE_KEYS) assert.ok(es[key] && en[key], key);
});
