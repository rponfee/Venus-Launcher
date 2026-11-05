'use strict';
// CurseForge en el catálogo: qué pantalla se ve según el estado que informa el proceso principal.
// Sin Electron: se ejecuta el curseforge.js real con un DOM mínimo (ver clipstudio/test/ui-harness).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { ui, loadRenderer } = require('../../../features/clipstudio/test/ui-harness');

function load({ signedIn = false } = {}) {
  const dom = ui();
  const visited = [];
  const deps = { ...dom.deps, navigate: (route) => visited.push(route), cloud: { isSignedIn: () => signedIn, on: () => () => {} } };
  const mod = loadRenderer(path.join(__dirname, '../curseforge.js'), ['cfGate', 'cfUnavailableCard'], deps);
  return { ...mod, visited, dom };
}
const ready = { configured: true, state: 'on', source: 'central', signedIn: true };

test('cfGate: un estado correcto no muestra ninguna tarjeta', () => {
  const { cfGate } = load();
  assert.equal(cfGate(ready), null);
  // "No se pudo comprobar" NO apaga el catálogo: el servidor contesta con el motivo exacto al buscar.
  assert.equal(cfGate({ ...ready, state: 'unknown' }), null);
});

test('cfGate: sin clave en el servidor es "off", y un fallo del propio proceso principal es "error"', () => {
  const { cfGate } = load();
  assert.equal(cfGate({ configured: false, state: 'off', source: null, signedIn: true }), 'off');
  assert.equal(cfGate({ configured: false, unavailable: true, error: 'No handler registered' }), 'off');
  assert.equal(cfGate({ configured: false, error: 'boom' }), 'error');
  assert.equal(cfGate(null), 'off');
});

test('cfGate: el catálogo central pide la cuenta de Venus; una clave del build no', () => {
  const out = load({ signedIn: false });
  assert.equal(out.cfGate({ ...ready, signedIn: false }), 'signin');
  assert.equal(out.cfGate({ configured: true, state: 'off', source: 'build', signedIn: false }), null);
  // El proceso principal puede no verla todavía pero la interfaz ya sí (o al revés).
  assert.equal(load({ signedIn: true }).cfGate({ ...ready, signedIn: false }), null);
  assert.equal(load({ signedIn: false }).cfGate(ready), null);
});

test('la tarjeta explica cada caso y el botón de sesión lleva al inicio de sesión de Venus', () => {
  const { cfUnavailableCard, visited } = load();
  const retried = [];
  let back = 0;
  const off = cfUnavailableCard({ kind: 'off', onRetry: () => retried.push('off'), onBack: () => back++ });
  assert.match(off.textContent, /curseforge\.offText/);
  assert.match(off.textContent, /curseforge\.checkAgain/);
  const signin = cfUnavailableCard({ kind: 'signin', onRetry: () => retried.push('signin'), onBack: () => back++ });
  assert.match(signin.textContent, /curseforge\.signInTitle/);
  const buttons = signin.querySelectorAll('button');
  assert.equal(buttons.length, 3);
  buttons[0].click();
  assert.deepEqual(visited, ['settings/cloud/venus']);
  buttons[1].click();
  buttons[2].click();
  assert.deepEqual(retried, ['signin']);
  assert.equal(back, 1);
  const error = cfUnavailableCard({ kind: 'error', message: 'Detalle propio del launcher', onRetry: () => {} });
  assert.match(error.textContent, /Detalle propio del launcher/);
  assert.equal(error.querySelectorAll('button').length, 1);
});
