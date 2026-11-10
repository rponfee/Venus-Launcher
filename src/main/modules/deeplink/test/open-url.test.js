'use strict';
// Links venus:// que llegan por 'open-url' (macOS) con el launcher minimizado u oculto: la ventana vuelve al frente.
// node --test "src/main/modules/deeplink/test/"
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const deeplink = require('../../deeplink');

function fakeApp() {
  const app = new EventEmitter();
  app.setAsDefaultProtocolClient = () => true; // nunca toca el registro real
  app.isDefaultProtocolClient = () => true;
  app.getApplicationNameForProtocol = () => '';
  return app;
}

function fakeWindow({ minimized = false, destroyed = false } = {}) {
  const calls = [];
  return {
    calls,
    isDestroyed: () => destroyed,
    isMinimized: () => minimized,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
  };
}

const openUrl = (app, url) => {
  let prevented = false;
  app.emit('open-url', { preventDefault: () => (prevented = true) }, url);
  return prevented;
};

test("open-url (macOS): antes de register no toca ventanas; después restaura, muestra y enfoca con un link válido", () => {
  const app = fakeApp();
  deeplink.preReady({ app });
  // Arranque en frío: todavía no hay ventana (aparece sola en ready-to-show) y no revienta
  assert.equal(openUrl(app, 'venus://modpack/modrinth/sodium'), true);

  let win = fakeWindow({ minimized: true });
  const sent = [];
  const handles = new Map();
  deeplink.register({ app, handle: (name, fn) => handles.set(name, fn), send: (ch, a) => sent.push([ch, a]), getWindow: () => win });
  assert.equal(handles.get('deeplink:ready')(), 1); // el link del arranque en frío sigue esperando a la interfaz

  // Minimizada (afterLaunch: 'minimize')
  openUrl(app, 'venus://modpack/modrinth/fabulously-optimized');
  assert.deepEqual(win.calls, ['restore', 'show', 'focus']);
  assert.equal(sent.at(-1)[1].project, 'fabulously-optimized');

  // Oculta (afterLaunch: 'hide'): show + focus
  win = fakeWindow();
  openUrl(app, 'venus://server/play.example.net');
  assert.deepEqual(win.calls, ['show', 'focus']);

  // Link inválido: no se trae nada al frente
  win = fakeWindow({ minimized: true });
  openUrl(app, 'venus://nada/raro');
  openUrl(app, 'https://example.com');
  assert.deepEqual(win.calls, []);

  // Ventana cerrada o destruida: no revienta
  win = fakeWindow({ destroyed: true });
  openUrl(app, 'venus://modpack/modrinth/lithium');
  assert.deepEqual(win.calls, []);
  win = null;
  assert.doesNotThrow(() => openUrl(app, 'venus://modpack/modrinth/iris'));
});
