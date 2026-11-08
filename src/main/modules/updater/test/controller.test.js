'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createController, parseLatestYml, isNewer, latestYmlUrl } = require('../controller');

const REPO = 'rponfee/Venus-Launcher';
const app = (version = '3.0.1', isPackaged = true) => ({ isPackaged, getVersion: () => version, quit() {} });
const yml = (version) => `version: ${version}\nfiles:\n  - url: VenusLauncher-Setup.exe\n    sha512: abc\n    size: 1\npath: VenusLauncher-Setup.exe\n`;

function portable({ version = '3.0.1', text, fail = false } = {}) {
  const urls = [];
  const states = [];
  const controller = createController({
    app: app(version), updater: null, repository: REPO, portable: true, platform: 'win32', now: () => 1234,
    notify: (s) => states.push(s),
    fetchText: async (url) => {
      urls.push(url);
      if (fail) throw new Error('sin red');
      return text;
    },
  });
  return { controller, urls, states };
}

test('latest.yml: saca la versión y compara bien', () => {
  assert.equal(parseLatestYml(yml('3.1.0')), '3.1.0');
  assert.equal(parseLatestYml("version: '3.1.0'\n"), '3.1.0');
  assert.equal(parseLatestYml('<html>no es el archivo</html>'), null);
  assert.equal(parseLatestYml(''), null);
  assert.equal(isNewer('3.0.10', '3.0.9'), true);
  assert.equal(isNewer('3.1.0', '3.0.9'), true);
  assert.equal(isNewer('3.0.1', '3.0.1'), false);
  assert.equal(isNewer('3.0.0', '3.0.1'), false);
  assert.equal(isNewer('2.9.9', '3.0.0'), false);
});

test('la portable ya no queda desactivada: arranca lista para buscar y sin consultar nada', () => {
  const { controller, urls } = portable({ text: yml('9.9.9') });
  const s = controller.status();
  assert.equal(s.status, 'idle');
  assert.equal(s.disabledReason, null);
  assert.equal(s.portable, true);
  assert.equal(s.downloadUrl, `https://github.com/${REPO}/releases/latest/download/VenusLauncher-Portable.exe`);
  assert.deepEqual(urls, []);
});

test('la portable avisa si hay una versión nueva', async () => {
  const { controller, urls, states } = portable({ text: yml('3.2.0') });
  const s = await controller.check();
  assert.deepEqual(urls, [latestYmlUrl(REPO)]);
  assert.equal(s.status, 'available');
  assert.equal(s.version, '3.2.0');
  assert.equal(s.lastChecked, 1234);
  assert.deepEqual(states.map((x) => x.status), ['checking', 'available']);
});

test('la portable dice que está al día si no hay nada más nuevo', async () => {
  for (const version of ['3.0.1', '3.0.0']) {
    const s = await portable({ text: yml(version) }).controller.check();
    assert.equal(s.status, 'current');
    assert.equal(s.version, null);
  }
});

test('la portable no revienta sin red ni con una respuesta rara', async () => {
  assert.equal((await portable({ fail: true }).controller.check()).status, 'error');
  assert.equal((await portable({ text: '<html>' }).controller.check()).status, 'error');
});

test('la portable no intenta instalar', () => {
  const { controller } = portable({ text: yml('9.9.9') });
  assert.throws(() => controller.install());
});

test('sin empaquetar sigue desactivado y la instalada sigue usando electron-updater', async () => {
  const dev = createController({ app: app('3.0.1', false), updater: null, repository: REPO, portable: true, fetchText: async () => yml('9.9.9'), platform: 'win32' });
  assert.equal(dev.status().disabledReason, 'development');
  assert.equal((await dev.check()).status, 'disabled');

  let asked = 0;
  const handlers = new Map();
  const updater = {
    on: (n, fn) => handlers.set(n, fn),
    removeListener: (n) => handlers.delete(n),
    checkForUpdates: async () => { asked++; handlers.get('update-not-available')(); return {}; },
  };
  const installed = createController({ app: app(), updater, repository: REPO, platform: 'win32', fetchText: async () => { throw new Error('no debería usarse'); } });
  assert.equal(installed.status().portable, false);
  assert.equal(installed.status().downloadUrl, null);
  assert.equal((await installed.check()).status, 'current');
  assert.equal(asked, 1);
  assert.equal(updater.autoDownload, true);
  assert.equal(updater.allowPrerelease, false);
  assert.equal(updater.allowDowngrade, false);
});

test('una beta recibe futuras betas sin permitir bajar a una versión anterior', () => {
  const updater = { on() {}, removeListener() {} };
  createController({ app: app('4.6.3-beta.3'), updater, repository: REPO, platform: 'win32' });
  assert.equal(updater.allowPrerelease, true);
  assert.equal(updater.allowDowngrade, false);
  assert.equal(updater.autoDownload, true);
  assert.equal(updater.autoInstallOnAppQuit, true);
});
