'use strict';
// Ajustes de Música y plan de atajos globales.
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeConfig, normalizeAccel, planShortcuts, DEFAULT_SHORTCUTS, VOICE_DEFAULT_SHORTCUT } = require('../config');

test('normalizeAccel: forma canónica', () => {
  assert.equal(normalizeAccel('Ctrl+Alt+p'), 'CommandOrControl+Alt+P');
  assert.equal(normalizeAccel('alt + ctrl + space'), 'CommandOrControl+Alt+Space');
  assert.equal(normalizeAccel('CmdOrCtrl+Shift+M'), 'CommandOrControl+Shift+M');
  assert.equal(normalizeAccel('Shift+Control+Right'), 'CommandOrControl+Shift+Right');
  assert.equal(normalizeAccel('Ctrl+numadd'), 'CommandOrControl+numadd');
  assert.equal(normalizeAccel('Ctrl+Alt+Enter'), 'CommandOrControl+Alt+Return');
  assert.equal(normalizeAccel('Alt+.'), 'Alt+.');
  assert.equal(normalizeAccel('F9'), 'F9', 'las teclas F pueden ir solas');
});

test('normalizeAccel: inválidos', () => {
  for (const bad of ['', 'P', 'Space', 'Ctrl+', 'Ctrl+Alt', 'Ctrl+Ctrl+P', 'Ctrl+Hiper+P', 'Ctrl+F25', 'Ctrl+Alt+PP', null, 42, 'Ctrl++']) {
    assert.equal(normalizeAccel(bad), '', String(bad));
  }
});

test('normalizeConfig: valores por defecto', () => {
  const cfg = normalizeConfig(undefined);
  assert.equal(cfg.source, 'auto');
  assert.equal(cfg.overlay, true);
  assert.equal(cfg.shortcuts.enabled, false, 'los atajos vienen apagados');
  for (const [k, v] of Object.entries(DEFAULT_SHORTCUTS)) assert.equal(cfg.shortcuts[k], v);
});

test('normalizeConfig: respeta lo guardado y los atajos quitados', () => {
  const cfg = normalizeConfig({ source: 'Chrome', overlay: false, shortcuts: { enabled: true, next: '', prev: 'Alt+F2', volumeUp: 7 } });
  assert.equal(cfg.source, 'Chrome');
  assert.equal(cfg.overlay, false);
  assert.equal(cfg.shortcuts.enabled, true);
  assert.equal(cfg.shortcuts.next, '');
  assert.equal(cfg.shortcuts.prev, 'Alt+F2');
  assert.equal(cfg.shortcuts.volumeUp, '');
  assert.equal(cfg.shortcuts.playPause, DEFAULT_SHORTCUTS.playPause);
  assert.equal(normalizeConfig({ source: '   ' }).source, 'auto');
});

test('planShortcuts: vacíos, inválidos, del Voice Chat y repetidos', () => {
  const plan = planShortcuts(
    { playPause: 'Ctrl+Shift+M', next: 'Ctrl+Alt+N', prev: 'ctrl+alt+n', volumeUp: 'Hola', volumeDown: '' },
    { reserved: [VOICE_DEFAULT_SHORTCUT, ''] },
  );
  assert.deepEqual(plan, [
    { action: 'playPause', accel: 'CommandOrControl+Shift+M', skip: 'reserved' },
    { action: 'next', accel: 'CommandOrControl+Alt+N', skip: null },
    { action: 'prev', accel: 'CommandOrControl+Alt+N', skip: 'duplicate' },
    { action: 'volumeUp', accel: 'Hola', skip: 'invalid' },
    { action: 'volumeDown', accel: '', skip: 'empty' },
  ]);
});

test('planShortcuts: los de fábrica no chocan con el Voice Chat', () => {
  const plan = planShortcuts(DEFAULT_SHORTCUTS, { reserved: [VOICE_DEFAULT_SHORTCUT] });
  assert.ok(plan.every((p) => p.skip === null), JSON.stringify(plan));
});
