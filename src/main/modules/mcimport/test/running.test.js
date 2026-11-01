'use strict';
// Pruebas de la deteccion de un Minecraft abierto desde una carpeta (procesos falsos, sin ejecutar nada).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { parseGameDirs, gameDirsInUse, findInUse } = require('../running');

const WIN_OUT = [
  '"C:\\Program Files\\Java\\bin\\javaw.exe" -Xmx2G -cp x.jar net.minecraft.client.main.Main --username Ana --version 1.21.1 --gameDir C:\\Users\\Ana\\AppData\\Roaming\\.minecraft --assetsDir C:\\x',
  'C:\\java\\bin\\javaw.exe -jar otro.jar',
  'javaw.exe --gameDir "D:\\Juegos con espacio\\mc" --width 854',
  '',
].join('\r\n');

test('lee --gameDir de las lineas de comando (con y sin comillas)', () => {
  assert.deepEqual(parseGameDirs(WIN_OUT), ['C:\\Users\\Ana\\AppData\\Roaming\\.minecraft', 'D:\\Juegos con espacio\\mc']);
  assert.deepEqual(parseGameDirs('java --gameDir=/home/ana/.minecraft --version 1.20'), ['/home/ana/.minecraft']);
  assert.deepEqual(parseGameDirs(''), []);
  assert.deepEqual(parseGameDirs(null), []);
});

test('usa PowerShell en Windows y ps en el resto; si falla devuelve null', async () => {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push(cmd);
    return cmd === 'ps' ? 'java --gameDir /home/ana/.minecraft' : WIN_OUT;
  };
  assert.equal((await gameDirsInUse({ platform: 'win32', exec })).length, 2);
  assert.equal((await gameDirsInUse({ platform: 'linux', exec })).length, 1);
  assert.deepEqual(calls, ['powershell.exe', 'ps']);
  assert.equal(await gameDirsInUse({ platform: 'win32', exec: async () => null }), null);
});

test('compara rutas sin distinguir mayusculas en Windows', () => {
  const dir = path.resolve('C:\\Users\\Ana\\AppData\\Roaming\\.minecraft');
  if (process.platform === 'win32') {
    assert.equal(findInUse([dir], [path.resolve('c:\\users\\ana\\appdata\\roaming\\.MINECRAFT')]), dir);
  }
  assert.equal(findInUse([dir], []), null);
  assert.equal(findInUse([dir], null), null);
  assert.equal(findInUse([dir], [path.resolve('D:\\otra')]), null);
});
