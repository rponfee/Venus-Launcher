'use strict';
// Datos sintéticos y módulos sustituidos: no usa APPDATA ni inicia servicios.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const activity = require('../../modules/discord/activity');

test('autoload omite Extensiones y streamer antes de require; conserva OBS y mapa de mundos', async () => {
  const required = [], events = [];
  const names = ['extensions.js', 'streamer.js', 'mapviewer.js', 'obs.js', 'helpers'];
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(__dirname, '../../modules-loader.js'), 'utf8');
  vm.runInNewContext(source, {
    module, __dirname: path.resolve(__dirname, '../..'), console,
    require(id) {
      if (id === 'path') return path;
      if (id === 'fs') return { readdirSync: () => names.map(name => ({ name, isFile: () => name.endsWith('.js') })) };
      const name = path.basename(id);
      required.push(name);
      return { preReady: () => events.push('pre:' + name), register: () => events.push('register:' + name) };
    },
  });
  module.exports.preReady({});
  await module.exports.register({});
  assert.deepEqual(required, ['mapviewer.js', 'obs.js']);
  assert.deepEqual(events, ['pre:mapviewer.js', 'pre:obs.js', 'register:mapviewer.js', 'register:obs.js']);
});

test('Discord ignora privacy.streamer guardado y conserva sus propias opciones de privacidad', () => {
  const saved = { privacy: { streamer: true }, discord: { enabled: true, showWorld: false, showServer: false } };
  const before = structuredClone(saved);
  const cfg = activity.config(saved);
  assert.equal('streamer' in cfg, false);
  assert.equal(cfg.showWorld, false);
  assert.equal(cfg.showServer, false);
  const t = (key, vars) => key + (vars?.world || vars?.address || '');
  const build = act => activity.buildActivity({ cfg, t, session: { state: 'running', instance: {}, activity: act } });
  assert.equal(build({ type: 'singleplayer', world: 'Fixture' }).state, 'discord.stateSingleplayer');
  assert.equal(build({ type: 'server', address: 'play.example.test' }).state, 'discord.stateMultiplayer');
  const publicCfg = activity.config({ privacy: { streamer: true }, discord: { showWorld: true, showServer: true } });
  const publicBuild = act => activity.buildActivity({ cfg: publicCfg, t, session: { state: 'running', instance: {}, activity: act } });
  assert.equal(publicBuild({ type: 'singleplayer', world: 'Fixture' }).state, 'discord.stateWorldFixture');
  assert.equal(publicBuild({ type: 'server', address: '192.168.1.5' }).state, 'discord.stateMultiplayer');
  assert.deepEqual(saved, before);
});
