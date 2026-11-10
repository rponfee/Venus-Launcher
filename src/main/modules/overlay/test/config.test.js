'use strict';
// Ajustes del overlay: valores por defecto, rangos, posiciones y atajos.
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../config');

test('sin ajustes: overlay apagado (6.1), widgets prendidos, atajo por defecto y las posiciones de fabrica', () => {
  const c = config.normalize(undefined);
  assert.equal(c.enabled, false);
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
  assert.equal(c.enabled, false, 'algo que no es si o no vale lo de fabrica: apagado');
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

test('atajos: los que le sacan la tecla a Minecraft, a Windows o a AltGr se rechazan', () => {
  for (const [accel, issue] of [
    ['Ctrl+W', 'minecraft'], ['Shift+K', 'minecraft'], ['Ctrl+Shift+M', 'minecraft'], ['CommandOrControl+F9', 'minecraft'], ['Shift+Space', 'minecraft'],
    ['Ctrl+Alt+Q', 'altgr'], ['Ctrl+Alt+1', 'altgr'], ['AltGr+E', 'altgr'], ['Alt+Control+O', 'altgr'],
    ['Alt+F4', 'system'], ['Alt+Tab', 'system'], ['Alt+Enter', 'system'], ['Ctrl+Shift+Esc', 'system'],
  ]) assert.equal(config.shortcutIssue(accel), issue, accel);
  for (const accel of ['Alt+Shift+O', 'Alt+Shift+F9', 'Alt+K', 'Ctrl+Alt+Space', 'Ctrl+Alt+Left', 'Super+K', 'F13', 'F24', 'Alt+Shift+num5']) assert.equal(config.shortcutIssue(accel), null, accel);
  assert.equal(config.shortcutIssue('Hyper+X'), 'invalid');
});

test('atajos: dos escritos distinto son el mismo si tienen las mismas teclas', () => {
  assert.equal(config.canonAccelerator('Shift+Alt+o'.replace('o', 'O')), 'Alt+Shift+O');
  assert.equal(config.canonAccelerator('CommandOrControl+Alt+Esc'), 'Ctrl+Alt+Escape');
  assert.equal(config.canonAccelerator('Ctrl+Alt+Return'), config.canonAccelerator('Control+Alt+Enter'));
  assert.equal(config.canonAccelerator('nada'), '');
  const list = [{ id: 'voice', accel: 'CommandOrControl+Shift+M' }, { id: 'capture', accel: 'Alt+Shift+F9' }, { id: 'x', accel: '' }, null];
  assert.equal(config.findConflict('Shift+Alt+F9', list).id, 'capture');
  assert.equal(config.findConflict('Ctrl+Shift+M', list).id, 'voice');
  assert.equal(config.findConflict('Alt+Shift+F10', list), null);
  assert.equal(config.findConflict('basura', list), null);
  assert.equal(config.findConflict('Alt+Shift+F9', undefined), null);
});

test('ajustes viejos: un atajo de panel igual al principal queda sin atajo y no se registra dos veces', () => {
  const c = config.normalize({ shortcut: 'Alt+Shift+R', panelShortcuts: { recipes: 'Alt+Shift+R', assistant: 'Shift+Alt+R' } });
  assert.equal(c.shortcut, 'Alt+Shift+R');
  assert.deepEqual(c.panelShortcuts, { recipes: '', assistant: '', dnd: 'Alt+Shift+N' });
  const d = config.normalize({ shortcut: 'Alt+Shift+O', panelShortcuts: { recipes: 'Alt+Shift+A', assistant: 'Alt+Shift+A' } });
  assert.deepEqual(d.panelShortcuts, { recipes: 'Alt+Shift+A', assistant: '', dnd: 'Alt+Shift+N' });
  // Lo que no es de este modulo no se toca: valores raros en los widgets viejos vuelven a los de fabrica
  const e = config.normalize({ widgets: { voice: { scale: '1.2', opacity: 'x', x: null, anchor: 5 }, perf: { show: 'fps' }, counters: null } });
  assert.equal(e.widgets.voice.scale, 1.2);
  assert.equal(e.widgets.voice.opacity, config.DEFAULTS.widgets.voice.opacity);
  assert.equal(e.widgets.voice.anchor, 'tl');
  assert.deepEqual(e.widgets.perf.show, config.DEFAULTS.widgets.perf.show);
  assert.deepEqual(e.widgets.counters, config.normalizeWidget('counters', {}));
});

test('tamano, opacidad y oculto desde el modo edicion: solo esos tres campos y siempre acotados', () => {
  assert.deepEqual(config.tweakPatch('voice', { scale: 1.2, opacity: 0.5, enabled: false }), { voice: { scale: 1.2, opacity: 0.5, enabled: false } });
  assert.deepEqual(config.tweakPatch('music', { scale: 9, opacity: 0 }), { music: { scale: 1.6, opacity: 0.3 } });
  assert.deepEqual(config.tweakPatch('perf', { scale: 1.23 }), { perf: { scale: 1.25 } });
  // Nada mas pasa: ni otros campos, ni widgets que no existen, ni tipos raros
  assert.deepEqual(config.tweakPatch('voice', { scale: 1.1, anchor: 'br', theme: 'light', x: 3, show: 'speaking' }), { voice: { scale: 1.1 } });
  for (const bad of [null, 'x', 5, [], {}, { scale: '1.2' }, { scale: NaN }, { enabled: 'si' }, { opacity: null }, { scale: Infinity }]) assert.equal(config.tweakPatch('voice', bad), null, JSON.stringify(bad));
  for (const id of ['__proto__', 'constructor', 'otro', '', null, 7]) assert.equal(config.tweakPatch(id, { scale: 1.2 }), null, String(id));
});
