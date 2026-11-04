'use strict';
// El catálogo y la lista de bloqueadas tienen consentimientos independientes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function harness({ catalog = false, blocklist = false, offline = false, accepted = true } = {}) {
  const calls = [], timeouts = [], intervals = [];
  const store = { settings: { extensions: { catalog, blocklist }, downloads: { offline } }, async setSettings(patch) {
    for (const [key, value] of Object.entries(patch)) this.settings[key] = { ...this.settings[key], ...value };
  } };
  const api = { on() {}, async invoke(channel, ...args) {
    calls.push([channel, ...args]);
    return channel === 'extensions:list' ? { items: [], safeMode: false } : [];
  } };
  const cloud = { isConfigured: () => true, isSignedIn: () => true, on() {}, client: { async rpc(name) { calls.push([name]); return { data: {} }; } } };
  const ctx = { module: { exports: {} }, store, api, cloud, console, Map, Set, Promise,
    confirmDialog: async () => accepted, t: x => x, loadNs: async () => {}, ensureCss() {}, registerSettingsCard() {},
    setNavBadge() {}, window: { addEventListener() {} },
    setTimeout(fn) { timeouts.push(fn); }, setInterval(fn) { intervals.push(fn); } };
  const source = fs.readFileSync(path.join(__dirname, '../../extensions.js'), 'utf8')
    .replace(/^import .*;\r?$/gm, '').replace(/^export /gm, '');
  vm.runInNewContext(source + '\nmodule.exports = { startup, setExtensionEnabled, checkBlocklist };', ctx);
  return { ...ctx.module.exports, store, calls, timeouts, intervals };
}
test('el catálogo solo no autoriza consultar bloqueos', async () => {
  const h = harness({ catalog: true });
  await h.startup(); h.timeouts[0](); await h.checkBlocklist();
  assert.equal(h.calls.some(x => x[0] === 'extension_blocklist'), false);
});
test('activar con permiso consulta bloqueos incluso con catálogo apagado', async () => {
  const h = harness(); await h.startup();
  assert.equal(await h.setExtensionEnabled('demo', true), true);
  assert.equal(h.store.settings.extensions.blocklist, true);
  assert.deepEqual(h.calls.filter(x => x[0] === 'extensions:setEnabled'), [['extensions:setEnabled', 'demo', true]]);
  await h.intervals[0]();
  assert.equal(h.calls.filter(x => x[0] === 'extension_blocklist').length, 2);
});
test('cancelar no activa la extensión ni hace consultas', async () => {
  const h = harness({ accepted: false });
  assert.equal(await h.setExtensionEnabled('demo', true), false);
  assert.equal(h.calls.length, 0);
});
test('sin conexión conserva el permiso sin consultar la red', async () => {
  const h = harness({ blocklist: true, offline: true });
  await h.checkBlocklist(); assert.equal(h.calls.length, 0);
});
