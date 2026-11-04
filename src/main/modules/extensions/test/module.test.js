'use strict';
// IPC con registro, reloj y paquetes simulados: no se instala ni se ejecuta código de terceros.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function fixture() {
  const file = path.resolve(__dirname, '../../extensions.js');
  const realRequire = createRequire(file);
  let clock = 1000;
  const installed = [];
  const handlers = new Map();
  const events = [];
  const pkg = { manifest: { id: 'demo-extension', version: '1.0.0' }, files: [], sha256: 'fixture', size: 1 };
  const registry = {
    load: async () => {},
    compare: async () => ({ blocked: false }),
    install: async (value) => { installed.push(value); return { id: value.manifest.id }; },
  };
  const stubs = {
    '../core/paths': { root: () => __dirname },
    '../core/i18n': { t: (key) => key },
    './extensions/package': { readPackage: () => pkg },
    './extensions/registry': { createRegistry: () => registry },
    electron: { protocol: { handle() {}, registerSchemesAsPrivileged() {} } },
  };
  const context = {
    module: { exports: {} }, require: (id) => stubs[id] || realRequire(id),
    Buffer, Uint8Array, ArrayBuffer, process: { argv: [] }, console,
    Date: class extends Date { static now() { return clock; } },
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  const app = { getVersion: () => '3.1.0', on: (event) => events.push(event) };
  const module = context.module.exports;
  module.preReady({ app });
  module.register({ app, handle: (name, fn) => handlers.set(name, fn), send() {}, getWindow() {} });
  return { installed, events, advance: (ms) => { clock += ms; }, call: (name, ...args) => handlers.get(name)(...args) };
}

test('una inspección vigente permite instalar una sola vez', async () => {
  const f = fixture();
  const stage = await f.call('extensions:inspectBytes', Buffer.from('fixture'));
  f.advance(15 * 60000 - 1);
  assert.equal((await f.call('extensions:install', stage.stageId)).id, 'demo-extension');
  assert.equal(f.installed.length, 1);
  await assert.rejects(f.call('extensions:install', stage.stageId), { code: 'stage_expired' });
});

test('el paquete temporal vence aunque no se inspeccione otro después', async () => {
  const f = fixture();
  const stage = await f.call('extensions:inspectBytes', Buffer.from('fixture'));
  f.advance(15 * 60000);
  await assert.rejects(f.call('extensions:install', stage.stageId), { code: 'stage_expired' });
  assert.equal(f.installed.length, 0);
  const fresh = await f.call('extensions:inspectBytes', Buffer.from('fixture'));
  await f.call('extensions:install', fresh.stageId);
  assert.equal(f.installed.length, 1);
});

test('el módulo deja los manejadores de permisos en sus propietarios', () => {
  assert.equal(fixture().events.includes('session-created'), false);
});
