'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { isAppPage, isPermissionRequester } = require('../permissions');
const file = path.resolve(__dirname, '../../../renderer/index.html');
const url = pathToFileURL(file).href;
test('la página propia conserva permisos en las distintas rutas del launcher', () => {
  assert.equal(isAppPage(url + '#/voice', file), true);
  assert.equal(isPermissionRequester(null, { requestingUrl: url, isMainFrame: true }, file), true);
  assert.equal(isPermissionRequester({ getURL: () => url }, { isMainFrame: true }, file), true);
});
test('los permisos requieren identificar la página propia, sin heredarse a marcos', () => {
  assert.equal(isPermissionRequester({ getURL: () => url }, { requestingUrl: url, isMainFrame: false }, file), false);
  assert.equal(isPermissionRequester({ getURL: () => url }, {}, file), false);
  assert.equal(isAppPage('https://example.com/', file), false);
  assert.equal(isAppPage(pathToFileURL(path.join(path.dirname(file), 'recorder.html')).href, file), false);
});
