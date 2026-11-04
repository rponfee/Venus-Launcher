'use strict';
// Apagar el registro evita llamar a pidusage, sin perder las muestras anteriores.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
test('el interruptor detiene las mediciones y conserva la partida parcial', async () => {
  let enabled = false, measurements = 0, tick, quit;
  const events = new EventEmitter(), saved = [];
  const usage = async () => { measurements++; return { memory: 1048576, cpu: 10 }; }; usage.clear = () => {};
  const modules = { os: { cpus: () => [{}] }, path, '../core/paths': { root: () => __dirname },
    '../core/settings': { get: async () => ({ perfhistory: { enabled } }) }, '../core/game': { events },
    '../core/instances': { get: async () => ({ name: 'Demo' }) }, './perfhistory/fps': { readFps: () => null },
    './perfhistory/summary': { summarize: x => x }, './perfhistory/store': { createStore: () => ({ rotate: async () => {}, save: async x => saved.push(x) }) },
    pidusage: usage };
  const ctx = { module: { exports: {} }, require(name) { assert.ok(name in modules, name); return modules[name]; },
    console, Date, Map, setInterval(fn) { tick = fn; return { unref() {} }; }, clearInterval() {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../perfhistory.js'), 'utf8'), ctx);
  ctx.module.exports.register({ handle() {}, send() {}, onQuit(fn) { quit = fn; } });
  events.emit('state', 'demo', { state: 'running', pid: 100, startedAt: Date.now() });
  await tick(); assert.equal(measurements, 0);
  enabled = true; await tick(); assert.equal(measurements, 1);
  enabled = false; await tick(); assert.equal(measurements, 1);
  await quit(); assert.equal(saved.length, 1);
  assert.equal(saved[0].partial, true); assert.equal(saved[0].samples.length, 1);
});
