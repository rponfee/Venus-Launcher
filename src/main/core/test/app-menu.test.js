'use strict';
// Menú de la aplicación en macOS (core/app-menu.js): lo mínimo para editar texto y salir, sin quitarle atajos al launcher.
// node --test "src/main/core/test/app-menu.test.js"
const test = require('node:test');
const assert = require('node:assert/strict');
const appMenu = require('../app-menu');
const i18n = require('../i18n');

const roles = (items) => items.flatMap((i) => [i.role, ...(i.submenu ? roles(i.submenu) : [])]).filter(Boolean);

test('tiene Cmd+C/V/X/A/Z y Cmd+Q, sin Ver (Cmd+R) ni Minimizar con Cmd+M', () => {
  const tpl = appMenu.menuTemplate({ appName: 'Venus Launcher' });
  const all = roles(tpl);
  for (const r of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll', 'quit', 'hide']) assert.ok(all.includes(r), r);
  for (const r of ['reload', 'forceReload', 'toggleDevTools', 'viewMenu', 'windowMenu', 'minimize']) assert.ok(!all.includes(r), r);
  const accels = JSON.stringify(tpl).match(/"accelerator":"[^"]*"/g) || [];
  assert.deepEqual(accels, []);
  const minimize = tpl[2].submenu[0];
  assert.equal(typeof minimize.click, 'function');
  assert.equal(minimize.accelerator, undefined);
});

test('los textos salen del idioma elegido', () => {
  i18n.setLanguage('es');
  const es = appMenu.menuTemplate({ appName: 'Venus Launcher', t: i18n.t });
  assert.equal(es[0].submenu.at(-1).label, 'Salir de Venus Launcher');
  assert.equal(es[1].label, 'Edición');
  i18n.setLanguage('en');
  const en = appMenu.menuTemplate({ appName: 'Venus Launcher', t: i18n.t });
  assert.equal(en[0].submenu.at(-1).label, 'Quit Venus Launcher');
  assert.equal(en[1].submenu.find((i) => i.role === 'paste').label, 'Paste');
  i18n.setLanguage('es');
});

test('solo se instala en macOS', () => {
  const calls = [];
  const Menu = { buildFromTemplate: (tpl) => (calls.push('build'), tpl), setApplicationMenu: () => calls.push('set') };
  assert.equal(appMenu.install({ Menu, platform: 'win32' }), false);
  assert.deepEqual(calls, []);
  let minimized = 0;
  const win = { isDestroyed: () => false, minimize: () => minimized++ };
  let built = null;
  const Menu2 = { buildFromTemplate: (tpl) => (built = tpl), setApplicationMenu: () => calls.push('set') };
  assert.equal(appMenu.install({ Menu: Menu2, getWindow: () => win, platform: 'darwin' }), true);
  assert.deepEqual(calls, ['set']);
  built[2].submenu[0].click();
  assert.equal(minimized, 1);
});
