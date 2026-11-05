'use strict';
// Anonimización del diagnóstico: rutas de cualquier disco, usuario, equipo, cuentas, correos, IP, claves, chat y nombres.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSupportRedactor, countRedactions, squashPath } = require('../redact');

const R = createSupportRedactor({
  homedir: 'C:\\Users\\Mateo',
  username: 'Mateo',
  hostname: 'DESKTOP-MATEO1',
  players: ['MateoBuilds', 'Alt_Cuenta'],
  dataDir: 'C:\\Users\\Mateo\\AppData\\Roaming\\.venuslauncher',
});

test('carpeta del launcher y del usuario: no queda el nombre de la persona', () => {
  // el nombre de la carpeta de cada instancia lo elige la persona: tampoco queda
  assert.equal(R.text('C:\\Users\\Mateo\\AppData\\Roaming\\.venuslauncher\\instances\\casa-de-pedro\\mods\\sodium.jar'), '<launcher>\\instances\\<instancia>\\mods\\sodium.jar');
  const out = R.text('Leyendo C:\\Users\\Mateo\\Documents\\cosas\\notas.txt ahora');
  assert.doesNotMatch(out, /Mateo/);
  assert.match(out, /notas\.txt/);
});

test('rutas de otros discos y con espacios: queda el archivo y, si es una carpeta del juego, la de arriba', () => {
  assert.equal(R.text('Falló D:\\Juegos\\MC 2026\\mods\\sodium-0.6.0.jar'), 'Falló <ruta>/mods/sodium-0.6.0.jar');
  assert.equal(R.text('java: "C:\\Program Files\\Eclipse Adoptium\\jdk-21\\bin\\javaw.exe" -Xmx4G'), 'java: "<ruta>/bin/javaw.exe" -Xmx4G');
  assert.equal(R.text('E:\\Pedro Gomez\\MC\\options.txt'), '<ruta>/options.txt');
  assert.equal(R.text('\\\\NAS-DE-CASA\\compartido\\mundos\\mi mundo\\level.dat'), '<ruta>/level.dat');
  assert.equal(R.text('cargó /home/pedro/.minecraft/mods/foo.jar bien'), 'cargó <ruta>/mods/foo.jar bien');
  assert.equal(R.text('/Users/pedro/Library/x.log'), '<ruta>/x.log');
  assert.equal(squashPath('C:\\'), '<ruta>');
});

test('lo que no es una ruta absoluta no se toca', () => {
  const lines = ['mods/sodium.jar', 'config/lithium.properties', '[main/INFO]: Loaded 38 mods', 'minecraft:overworld y/o nether', 'versión 1.21.1'];
  for (const line of lines) assert.equal(R.text(line), line);
});

test('equipo, usuario del sistema y nombres de las cuentas', () => {
  const out = R.text('Host DESKTOP-MATEO1 corriendo como Mateo; jugador MateoBuilds y Alt_Cuenta');
  assert.doesNotMatch(out, /DESKTOP-MATEO1|MateoBuilds|Alt_Cuenta|Mateo/);
  assert.match(out, /<host>/);
  assert.match(out, /<player>/);
});

test('correos, UUID, IP y claves', () => {
  const out = R.text([
    'mail mateo@example.com', 'uuid 123e4567-e89b-12d3-a456-426614174000', 'ip 192.168.1.35 y 2001:db8:85a3:0:0:8a2e:370:7334',
    'Authorization: Bearer abcdefghijklmnop1234', 'accessToken=abcd1234efgh5678', '--accessToken secreto123456',
  ].join('\n'));
  assert.doesNotMatch(out, /example\.com|123e4567|192\.168|2001:db8|abcdefghijklmnop|abcd1234efgh|secreto123456/);
  assert.match(out, /<email>/);
  assert.match(out, /<uuid>/);
  assert.match(out, /<ip>/);
});

test('versiones dentro de un nombre de archivo no se toman por IP', () => {
  assert.equal(R.text('mod sodium-1.20.1.2.jar cargado'), 'mod sodium-1.20.1.2.jar cargado');
});

test('registro del juego: chat, nombres de quienes entran y sesión', () => {
  assert.equal(R.text('[14:02:20] [Render thread/INFO]: [CHAT] <Pedro> mi clave es 1234'), '[14:02:20] [Render thread/INFO]: [CHAT] <oculto>');
  assert.equal(R.text('[Server thread/INFO]: Pedro_99 joined the game'), '[Server thread/INFO]: <player> joined the game');
  assert.equal(R.text('[Server thread/INFO]: Pedro_99 lost connection: Disconnected'), '[Server thread/INFO]: <player> lost connection: Disconnected');
  assert.equal(R.text('Setting user: OtroJugador'), 'Setting user: <player>');
  assert.equal(R.text('[main/INFO]: UUID of player Pedro is 123e4567-e89b-12d3-a456-426614174000'), '[main/INFO]: UUID of player <player> is <uuid>');
});

test('caracteres de control fuera, saltos de línea y tabulaciones se quedan', () => {
  assert.equal(R.text(`a${String.fromCharCode(7)}b\tc\nd`), 'ab\tc\nd');
});

test('es idempotente: pasarlo dos veces no cambia nada', () => {
  const raw = 'D:\\Juegos\\MC\\mods\\a.jar con DESKTOP-MATEO1, mateo@example.com y 10.0.0.2 desde C:\\Users\\Mateo\\x.txt [CHAT] hola';
  const once = R.text(raw);
  assert.equal(R.text(once), once);
});

test('contar lo tapado, por tipo', () => {
  const out = R.text('mateo@example.com C:\\Juegos\\a.jar 10.0.0.2 [CHAT] hola');
  const c = countRedactions(out);
  assert.equal(c.kinds.email, 1);
  assert.equal(c.kinds.path, 1);
  assert.equal(c.kinds.ip, 1);
  assert.equal(c.kinds.chat, 1);
  assert.equal(c.total, 4);
  assert.deepEqual(countRedactions('nada que ver'), { total: 0, kinds: {} });
});

test('sin datos de la PC se puede crear igual (valores por defecto del sistema)', () => {
  const plain = createSupportRedactor();
  assert.equal(plain.text('hola'), 'hola');
  assert.deepEqual(plain.lines(['a', 'b']), ['a', 'b']);
  assert.deepEqual(plain.lines(null), []);
});

test('usuario y equipo de 3 letras también se tapan (el anonimizador del asistente solo llega a 4)', () => {
  const short = createSupportRedactor({ homedir: '/home/xyz', username: 'xyz', hostname: 'abc', players: [] });
  const out = short.text('Running as xyz on abc; los dados salieron en abcdef y xyzzy');
  assert.equal(out, 'Running as <user> on <host>; los dados salieron en abcdef y xyzzy');
  // una palabra común de 3 letras no se toma por nombre
  const common = createSupportRedactor({ homedir: '/home/log', username: 'log', hostname: 'dev', players: [] });
  assert.equal(common.text('log del dev'), 'log del dev');
});
