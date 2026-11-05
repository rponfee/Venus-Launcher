'use strict';
// Datos sintéticos y módulos sustituidos: no usa APPDATA ni inicia servicios.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const activity = require('../../modules/discord/activity');

const MODULES = path.join(__dirname, '../../modules');

test('los módulos retirados en la 4.6 ya no existen y el cargador no guarda ninguna lista de excepciones', () => {
  for (const name of ['compete', 'extensions', 'obs', 'streamer']) {
    assert.equal(fs.existsSync(path.join(MODULES, name + '.js')), false, name + '.js');
    assert.equal(fs.existsSync(path.join(MODULES, name)), false, name + '/');
  }
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../../modules-loader.js'), 'utf8'), /RETIRED/);
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
