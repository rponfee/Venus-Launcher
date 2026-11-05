'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const logic = require('../logic');
const flush = () => new Promise(resolve => setImmediate(resolve));

function rig({ failScenes = false } = {}) {
  const timers = [], writes = [], clients = [], sent = [], scenes = [], handlers = new Map(), quit = [];
  const saved = { privacy: { streamer: true, playerHeads: false }, obs: { enabled: true, streamerWhileLive: true, streamerOwned: true, sceneOnOpen: 'Juego', sceneOnClose: 'Fin' } };
  const game = { status: () => ({}), events: new EventEmitter() };
  const settings = { get: async () => saved, onChange() {}, set: async patch => writes.push(patch) };
  class Client extends EventEmitter {
    constructor() { super(); clients.push(this); }
    async connect() { this.identified = true; return { obsWebSocketVersion: 'fixture' }; }
    async sceneList() { if (failScenes) throw new Error('sin respuesta'); return { scenes: ['Juego', 'Fin'], current: 'Fin' }; }
    async outputs() { return { streaming: true, recording: true }; }
    async setScene(scene) { scenes.push(scene); }
    close() { this.closed = true; }
  }
  const deps = { '../core/settings': settings, '../core/secure': { has: async () => false }, '../core/game': game, '../core/i18n': { t: x => x }, './obs/client': { ObsClient: Client }, './obs/logic': logic };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../obs.js'), 'utf8'), {
    module, require: id => deps[id], console,
    setTimeout: (fn, ms) => { const timer = { fn, ms, cleared: false, unref() {} }; timers.push(timer); return timer; },
    clearTimeout: timer => { if (timer) timer.cleared = true; },
  });
  module.exports.register({ handle: (name, fn) => handlers.set(name, fn), send: (...args) => sent.push(args), onQuit: fn => quit.push(fn) });
  return { saved, timers, writes, clients, sent, scenes, game, handlers, close: () => quit.forEach(fn => fn()) };
}

test('OBS conserva estados y escenas pero no cambia streamer aunque las opciones antiguas estén activas', async () => {
  const r = rig();
  try {
    await flush();
    assert.equal(r.handlers.get('obs:status')().state, 'connected');
    r.clients[0].emit('event', 'StreamStateChanged', { outputActive: false });
    r.clients[0].emit('event', 'RecordStateChanged', { outputActive: false });
    r.game.events.emit('state', 'fixture-game', { state: 'running' });
    r.game.events.emit('state', 'fixture-game', { state: 'stopped' });
    await flush();
    assert.deepEqual(r.scenes, ['Juego', 'Fin']);
    assert.equal(r.handlers.get('obs:status')().recording, false);
    assert.equal(r.handlers.get('obs:status')().streaming, false);
    assert.equal(r.writes.length, 0);
    assert.equal(r.sent.some(([name]) => name === 'obs:streamer'), false);
    assert.equal(r.saved.privacy.streamer, true, 'no borra ajustes antiguos');
    assert.equal(r.saved.privacy.playerHeads, false);
  } finally { r.close(); }
});

test('OBS reintenta una conexión incompleta sin programar reglas de streamer', async () => {
  const r = rig({ failScenes: true });
  try {
    await flush();
    const retry = r.timers.find(timer => timer.ms === 3000);
    assert.ok(retry);
    await retry.fn();
    await flush();
    assert.equal(r.clients.length, 2);
    assert.equal(r.timers.some(timer => timer.ms === 30000), false);
    assert.equal(r.writes.length, 0);
    assert.equal(r.handlers.get('obs:status')().state, 'waiting');
  } finally { r.close(); }
});
