'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { defaults, deepMerge } = require('../settings');

test('las instalaciones nuevas buscan actualizaciones y se conserva una desactivación guardada', () => {
  assert.equal(defaults().privacy.autoUpdates, true);
  const saved = deepMerge(defaults(), { privacy: { decided: true, autoUpdates: false } });
  assert.equal(saved.privacy.autoUpdates, false);
  assert.equal(saved.privacy.decided, true);
  assert.equal(saved.privacy.news, false);
});
