'use strict';
// Argumentos del acceso directo, nombre del .lnk y parseo de --play-instance.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePlayArg, splitArgs, safeLinkName, buildShortcut } = require('../args');

test('parsePlayArg: lee --play-instance=<id> en process.argv y en los argumentos de otra copia', () => {
  assert.equal(parsePlayArg(['C:\\Venus\\Venus Launcher.exe', '--play-instance=fabric-1.21']), 'fabric-1.21');
  assert.equal(parsePlayArg(['electron.exe', '.', '--play-instance', 'mi-instancia']), 'mi-instancia');
  assert.equal(parsePlayArg(['x', '--play-instance="con espacio"']), 'con espacio');
  assert.equal(parsePlayArg(['x', '--allow-file-access', '--play-instance=a1', '--play-instance=a2']), 'a1', 'gana el primero');
  assert.equal(parsePlayArg(['x']), null);
  assert.equal(parsePlayArg([]), null);
  assert.equal(parsePlayArg(null), null);
});

test('parsePlayArg: rechaza ids que no son un segmento de ruta seguro', () => {
  assert.equal(parsePlayArg(['x', '--play-instance=../otra']), null);
  assert.equal(parsePlayArg(['x', '--play-instance=a/b']), null);
  assert.equal(parsePlayArg(['x', '--play-instance=a\\b']), null);
  assert.equal(parsePlayArg(['x', '--play-instance=..']), null);
  assert.equal(parsePlayArg(['x', '--play-instance=']), null);
  assert.equal(parsePlayArg(['x', '--play-instance= x']), null);
  assert.equal(parsePlayArg(['x', '--play-instance', '--otro']), null, 'un flag no es un id');
  assert.equal(parsePlayArg(['x', `--play-instance=${'a'.repeat(256)}`]), null);
});

test('parsePlayArg y splitArgs: tambien sobre la cadena de argumentos de un .lnk', () => {
  assert.deepEqual(splitArgs('"C:\\app" --play-instance=abc  --x'), ['C:\\app', '--play-instance=abc', '--x']);
  assert.equal(parsePlayArg('"C:\\Users\\yo\\app" --play-instance=vanilla-1.20'), 'vanilla-1.20');
  assert.equal(parsePlayArg('--play-instance="con espacio"'), 'con espacio');
  assert.equal(parsePlayArg(''), null);
});

test('safeLinkName: saca caracteres prohibidos, puntos finales y nombres de dispositivo', () => {
  assert.equal(safeLinkName('Mi: instancia/"rara"?'), 'Mi instancia rara');
  assert.equal(safeLinkName('  con   espacios  '), 'con espacios');
  assert.equal(safeLinkName('Final con puntos...'), 'Final con puntos');
  assert.equal(safeLinkName('CON'), 'CON (instancia)');
  assert.equal(safeLinkName('nul.txt'), 'nul.txt (instancia)');
  assert.equal(safeLinkName('Console'), 'Console');
  assert.equal(safeLinkName(''), 'Venus Launcher');
  assert.equal(safeLinkName('***'), 'Venus Launcher');
  assert.equal(safeLinkName(null, 'X'), 'X');
  assert.equal(Array.from(safeLinkName('á'.repeat(80))).length, 60);
});

test('buildShortcut: empaquetado apunta al .exe con --play-instance', () => {
  const s = buildShortcut({ id: 'fabric-1.21', name: 'Fabric 1.21', desktopDir: 'C:\\Users\\yo\\Desktop', execPath: 'C:\\Venus\\Venus Launcher.exe', isPackaged: true, icon: 'C:\\Venus\\resources\\venus.ico', description: 'Fabric 1.21 — Venus Launcher' });
  assert.equal(s.path, 'C:\\Users\\yo\\Desktop\\Fabric 1.21.lnk');
  assert.equal(s.altPath, 'C:\\Users\\yo\\Desktop\\Fabric 1.21 (fabric-1.21).lnk');
  assert.equal(s.name, 'Fabric 1.21');
  assert.equal(s.target, 'C:\\Venus\\Venus Launcher.exe');
  assert.equal(s.cwd, 'C:\\Venus');
  assert.equal(s.args, '--play-instance=fabric-1.21');
  assert.equal(s.icon, 'C:\\Venus\\resources\\venus.ico');
  assert.equal(s.iconIndex, 0);
  assert.equal(s.description, 'Fabric 1.21 — Venus Launcher');
  assert.equal(parsePlayArg(s.args), 'fabric-1.21', 'lo que se escribe se vuelve a leer igual');
});

test('buildShortcut: portable usa el .exe portable y sin icono usa el destino', () => {
  const s = buildShortcut({ id: 'a', name: 'A', desktopDir: 'D:\\Esc', execPath: 'C:\\Temp\\unpacked\\Venus.exe', portableExe: 'E:\\Pendrive\\Venus Launcher Portable.exe', isPackaged: true });
  assert.equal(s.target, 'E:\\Pendrive\\Venus Launcher Portable.exe');
  assert.equal(s.cwd, 'E:\\Pendrive');
  assert.equal(s.icon, 'E:\\Pendrive\\Venus Launcher Portable.exe');
  assert.equal(s.description, 'A');
});

test('buildShortcut: en desarrollo pasa la carpeta de la app a electron y entrecomilla espacios', () => {
  const s = buildShortcut({ id: 'con espacio', name: 'X', desktopDir: 'D:\\Esc', execPath: 'C:\\p\\node_modules\\electron\\dist\\electron.exe', appPath: 'C:\\Users\\yo\\Venus Launcher', isPackaged: false });
  assert.equal(s.args, '"C:\\Users\\yo\\Venus Launcher" --play-instance="con espacio"');
  assert.equal(parsePlayArg(s.args), 'con espacio');
  assert.throws(() => buildShortcut({ id: '../x', name: 'X', desktopDir: 'D:\\', execPath: 'e.exe' }));
});
