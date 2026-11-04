'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const logic = require('../logic');

test('OBS: reintentos sin estado de salidas no reinician la gracia del modo streamer', async () => {
  let change;
  const timers = [];
  const saved = { privacy: { streamer: true }, obs: { enabled: true, streamerOwned: true } };
  const settings = { get: async () => saved, onChange: fn => { change = fn; }, set: async patch => {
    for (const [key, value] of Object.entries(patch)) saved[key] = { ...saved[key], ...value };
    change(saved, patch);
  } };
  class Client extends EventEmitter {
    async connect() { this.identified = true; return { obsWebSocketVersion: 'test' }; }
    async sceneList() { throw new Error('sin respuesta'); }
    async outputs() { return { streaming: false, recording: false }; }
    close() {}
  }
  const deps = { '../core/settings': settings, '../core/secure': { has: async () => false }, '../core/game': { status: () => ({}), events: new EventEmitter() }, '../core/i18n': { t: x => x }, './obs/client': { ObsClient: Client }, './obs/logic': logic };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../obs.js'), 'utf8'), {
    module, require: id => deps[id], console,
    setTimeout: (fn, ms) => { const timer = { fn, ms, cleared: false, unref() {} }; timers.push(timer); return timer; },
    clearTimeout: timer => { if (timer) timer.cleared = true; },
  });
  module.exports.register({ handle() {}, send() {}, onQuit() {} });
  await new Promise(r => setImmediate(r));
  const grace = timers.find(timer => timer.ms === 30000);
  const retry = timers.find(timer => timer.ms === 3000);
  await retry.fn();
  assert.equal(grace.cleared, false);
  assert.equal(timers.filter(timer => timer.ms === 30000).length, 1);
  grace.fn();
  await new Promise(r => setImmediate(r));
  assert.equal(saved.privacy.streamer, false);
  assert.equal(saved.obs.streamerOwned, false);
});
