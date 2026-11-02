'use strict';
// Ajustes del overlay: valores por defecto, rangos, posiciones y atajos.
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../config');

test('sin ajustes: todo prendido, atajo por defecto y las posiciones de fabrica', () => {
  const c = config.normalize(undefined);
  assert.equal(c.enabled, true);
  assert.equal(c.shortcut, config.DEFAULT_SHORTCUT);
  assert.deepEqual(Object.keys(c.widgets), config.WIDGETS);
  for (const id of config.WIDGETS) {
    const w = c.widgets[id];
    assert.equal(w.enabled, true, id);
    assert.ok(config.ANCHORS.includes(w.anchor), id);
    assert.equal(w.scale, 1);
    assert.equal(w.theme, 'dark');
  }
  assert.equal(c.widgets.messages.hideContent, false);
  assert.deepEqual(c.widgets.alerts.filter, { launcher: true, friends: true, servers: true, rewards: true });
  assert.equal(c.widgets.voice.show, 'all');
  assert.equal(c.widgets.music.show, 'always');
});

test('valores fuera de rango o raros se corrigen', () => {
  const c = config.normalize({
    enabled: 'si',
    widgets: {
      voice: { scale: 9, opacity: 0, theme: 'neon', anchor: 'arriba', show: 'nadie', x: -3, y: 4 },
      messages: { hideContent: true, duration: 999 },
      alerts: { duration: 0.5, filter: { friends: false, otra: true } },
      music: { scale: 1.23, opacity: 0.555, show: 'change' },
    },
  });
  assert.equal(c.enabled, true);
  const v = c.widgets.voice;
  assert.equal(v.scale, 1.6);
  assert.equal(v.opacity, 0.3);
  assert.equal(v.theme, 'dark');
  assert.equal(v.anchor, 'tl');
  assert.equal(v.show, 'all');
  assert.equal(v.x, 0);
  assert.equal(v.y, 1);
  assert.equal(c.widgets.messages.hideContent, true);
  assert.equal(c.widgets.messages.duration, 30);
  assert.equal(c.widgets.alerts.duration, 2);
  assert.deepEqual(c.widgets.alerts.filter, { launcher: true, friends: false, servers: true, rewards: true });
  assert.equal(c.widgets.music.scale, 1.25); // pasos de 5 %
  assert.equal(c.widgets.music.opacity, 0.56);
  assert.equal(c.widgets.music.show, 'change');
});

test('posicion libre y atajo vacio (sin atajo)', () => {
  const c = config.normalize({ shortcut: '', widgets: { alerts: { anchor: 'free', x: 0.25, y: 0.75 } } });
  assert.equal(c.shortcut, '');
  assert.deepEqual([c.widgets.alerts.anchor, c.widgets.alerts.x, c.widgets.alerts.y], ['free', 0.25, 0.75]);
  assert.equal(config.normalize({ shortcut: 'cualquier cosa' }).shortcut, config.DEFAULT_SHORTCUT);
});

test('atajos: formato de Electron con modificador (o F13 a F24 solas)', () => {
  for (const ok of ['Alt+Shift+O', 'Ctrl+F9', 'CommandOrControl+Shift+9', 'Alt+num5', 'F13', 'Super+Space', 'Ctrl+Alt+Up']) assert.equal(config.validAccelerator(ok), true, ok);
  for (const bad of ['', 'O', 'F9', 'Alt+', '+O', 'Shift+Shift+O', 'Hyper+O', 'Alt+Shift+Ctrl+Super+O', 'Alt+OO', 42, null]) assert.equal(config.validAccelerator(bad), false, String(bad));
});

test('parche de posicion del modo edicion', () => {
  assert.deepEqual(config.positionPatch('voice', { anchor: 'br' }), { voice: { anchor: 'br' } });
  assert.deepEqual(config.positionPatch('music', { anchor: 'free', x: 1.7, y: 0.123456 }), { music: { anchor: 'free', x: 1, y: 0.1235 } });
  assert.equal(config.positionPatch('otro', { anchor: 'br' }), null);
  assert.equal(config.positionPatch('voice', { anchor: 'centro' }), null);
  assert.equal(config.positionPatch('voice', { anchor: 'free', x: 'a', y: 1 }), null);
  const reset = config.resetPatch();
  assert.deepEqual(Object.keys(reset), config.WIDGETS);
  assert.equal(reset.voice.anchor, config.DEFAULTS.widgets.voice.anchor);
});
