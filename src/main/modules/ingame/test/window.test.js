'use strict';
// Pruebas del ayudante de la ventana del juego (sin abrir PowerShell): cuando corre y que le pasa.
const test = require('node:test');
const assert = require('node:assert/strict');
const windowBrand = require('../window');
const ingame = require('../../ingame');

function fakeSpawn() {
  const calls = [];
  const fn = (file, args, opts) => {
    calls.push({ file, args, opts });
    return { on() {} };
  };
  return { fn, calls };
}

test('en Windows abre PowerShell oculto con el pid, el icono y el sufijo del titulo', () => {
  const s = fakeSpawn();
  const child = windowBrand.brand({ pid: 4242, iconPath: 'C:\\Venus\\venus.ico', platform: 'win32', spawnFn: s.fn });
  assert.ok(child);
  assert.equal(s.calls.length, 1);
  const { file, args, opts } = s.calls[0];
  assert.equal(file, 'powershell.exe');
  assert.ok(args.includes('-NoProfile') && args.includes('Hidden'));
  assert.equal(opts.windowsHide, true);
  assert.equal(opts.env.VENUS_GAME_PID, '4242');
  assert.equal(opts.env.VENUS_ICON, 'C:\\Venus\\venus.ico');
  assert.equal(opts.env.VENUS_TITLE_SUFFIX, windowBrand.SUFFIX);
});

test('el pid y las rutas van por variables de entorno, nunca dentro del script', () => {
  const cmd = windowBrand.command({ pid: 1, iconPath: 'C:\\x"; Remove-Item C:\\ #.ico' });
  assert.equal(cmd.args[cmd.args.length - 1], windowBrand.SCRIPT);
  assert.doesNotMatch(windowBrand.SCRIPT, /Remove-Item/);
});

test('fuera de Windows, sin pid valido o sin nada que cambiar no hace nada', () => {
  const s = fakeSpawn();
  assert.equal(windowBrand.brand({ pid: 10, iconPath: 'x.ico', platform: 'linux', spawnFn: s.fn }), null);
  assert.equal(windowBrand.brand({ pid: 0, iconPath: 'x.ico', platform: 'win32', spawnFn: s.fn }), null);
  assert.equal(windowBrand.brand({ pid: 10, iconPath: null, title: false, platform: 'win32', spawnFn: s.fn }), null);
  assert.equal(s.calls.length, 0);
});

test('si PowerShell no se puede abrir, no rompe el lanzamiento', () => {
  const r = windowBrand.brand({ pid: 10, iconPath: 'x.ico', platform: 'win32', spawnFn: () => { throw new Error('ENOENT'); } });
  assert.equal(r, null);
});

test('ajustes: paquete y ventana vienen prendidos, la insignia apagada, y se cambian por separado', () => {
  assert.deepEqual(ingame.prefs({}), { pack: true, window: true, badge: false });
  assert.deepEqual(ingame.prefs({ ingame: { pack: false } }), { pack: false, window: true, badge: false });
  assert.deepEqual(ingame.prefs({ ingame: { window: false } }), { pack: true, window: false, badge: false });
  assert.deepEqual(ingame.prefs(null), { pack: true, window: true, badge: false });
  assert.deepEqual(ingame.prefs({ ingame: { badge: true } }), { pack: true, window: true, badge: true });
  assert.deepEqual(ingame.prefs({ ingame: { badge: 'si' } }), { pack: true, window: true, badge: false });
});
