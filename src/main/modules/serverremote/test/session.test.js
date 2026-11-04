'use strict';
// Pedidos y servidor HTTP simulados: el reloj y la rotación se controlan sin abrir sockets.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');

async function fixture(t, snapshot = async () => ({ name: 'Prueba', players: [] })) {
  const file = path.resolve(__dirname, '../host.js');
  const realRequire = createRequire(file);
  let listener;
  let clock = 1000;
  const actions = [];
  const http = {
    createServer(_options, handler) {
      listener = handler;
      const server = new EventEmitter();
      server.listen = (_opts, callback) => callback();
      server.address = () => ({ port: 32100 });
      server.close = () => {};
      return server;
    },
  };
  const context = { module: { exports: {} }, require: (id) => id === 'http' ? http : realRequire(id), __dirname: path.dirname(file), Buffer, console, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  const host = context.module.exports.createRemoteHost({
    ip: '127.0.0.1', now: () => clock, ttlMs: 10000,
    backend: { snapshot, action: async (action) => actions.push(action) },
  });
  await host.start();
  t.after(() => host.stop());
  function request(method = 'POST') {
    const req = new EventEmitter();
    req.method = method;
    req.url = method === 'GET' ? '/api/state' : '/api/action';
    req.socket = { remoteAddress: '127.0.0.1', destroy() {} };
    req.rawHeaders = ['Host', '127.0.0.1:32100'];
    req.headers = { host: '127.0.0.1:32100', 'x-venus-token': new URL(host.info().url).hash.slice(3), 'content-type': 'application/json' };
    const res = new EventEmitter();
    let finish;
    const done = new Promise((resolve) => { finish = resolve; });
    res.writeHead = (status) => { res.status = status; res.headersSent = true; };
    res.end = (body) => { finish({ status: res.status, body: JSON.parse(body.toString()) }); res.emit('finish'); };
    res.destroy = () => finish({ status: 0 });
    listener(req, res);
    return { done, complete() { req.emit('data', Buffer.from('{"action":"start"}')); req.emit('end'); } };
  }
  return { host, actions, request, advance: (ms) => { clock += ms; } };
}

test('una acción completa conserva su autorización y llega al backend simulado', async (t) => {
  const { actions, request } = await fixture(t);
  const pending = request();
  pending.complete();
  assert.equal((await pending.done).status, 200);
  assert.equal(actions.length, 1);
});

test('la rotación se aplica también a una acción que aún esperaba completar su lectura', async (t) => {
  const { host, actions, request } = await fixture(t);
  const pending = request();
  host.rotate();
  pending.complete();
  assert.equal((await pending.done).status, 401);
  assert.equal(actions.length, 0);
});

test('el vencimiento se vuelve a comprobar al terminar la lectura', async (t) => {
  const { actions, request, advance } = await fixture(t);
  const pending = request();
  advance(10000);
  pending.complete();
  assert.equal((await pending.done).status, 410);
  assert.equal(actions.length, 0);
});

test('un estado pendiente deja de entregarse si se renueva la sesión', async (t) => {
  let completeSnapshot;
  const snapshot = new Promise((resolve) => { completeSnapshot = resolve; });
  const { host, request } = await fixture(t, () => snapshot);
  const pending = request('GET');
  host.rotate();
  completeSnapshot({ name: 'Prueba', players: [] });
  const response = await pending.done;
  assert.equal(response.status, 401);
  assert.equal(response.body.server, undefined);
});
