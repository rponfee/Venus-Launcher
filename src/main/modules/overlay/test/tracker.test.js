'use strict';
// Ayudante que sigue la ventana del juego: comando, lectura de lineas y fin (con un spawn falso: no abre nada).
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { track, command, SCRIPT } = require('../tracker');

function fakeSpawn() {
  const calls = [];
  const fn = (file, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.killed = false;
    child.kill = () => {
      child.killed = true;
    };
    calls.push({ file, args, opts, child });
    return child;
  };
  fn.calls = calls;
  return fn;
}

test('comando: PowerShell oculto con el pid del juego y del launcher', () => {
  const c = command({ pid: 4321, parentPid: 99 });
  assert.equal(c.file, 'powershell.exe');
  assert.ok(c.args.includes('-NonInteractive') && c.args.includes('Hidden'));
  assert.equal(c.args[c.args.length - 1], SCRIPT);
  assert.equal(c.env.VENUS_GAME_PID, '4321');
  assert.equal(c.env.VENUS_PARENT_PID, '99');
  // el script es consciente de la escala por monitor, mide el area de juego y termina con el juego o el launcher
  for (const s of ['SetThreadDpiAwarenessContext', 'GetClientRect', 'ClientToScreen', 'IsIconic', 'GetForegroundWindow', 'GLFW', 'LWJGL', 'WaitForSingleObject', '{\\"end\\":1}']) assert.ok(SCRIPT.includes(s), s);
});

test('solo en Windows y con un pid valido', () => {
  const spawnFn = fakeSpawn();
  assert.equal(track({ pid: 10, platform: 'linux', spawnFn }), null);
  assert.equal(track({ pid: 0, platform: 'win32', spawnFn }), null);
  assert.equal(track({ pid: 1.5, platform: 'win32', spawnFn }), null);
  assert.equal(spawnFn.calls.length, 0);
});

test('lee lineas partidas, ignora la basura y avisa el fin una sola vez', () => {
  const spawnFn = fakeSpawn();
  const updates = [];
  let ends = 0;
  const h = track({ pid: 77, platform: 'win32', spawnFn, onUpdate: (i) => updates.push(i), onEnd: () => ends++ });
  assert.ok(h);
  const { child, opts } = spawnFn.calls[0];
  assert.equal(opts.windowsHide, true);
  child.stdout.emit('data', '{"ok":0}\n{"ok":1,"hwnd":5,"fgw":5,"x":10,');
  child.stdout.emit('data', '"y":20,"w":800,"h":600,"min":0,"vis":1,"full":0,"dpi":96}\r\nruido\n');
  assert.equal(updates.length, 2);
  assert.equal(updates[0].found, false);
  assert.deepEqual(updates[1].rect, { x: 10, y: 20, width: 800, height: 600 });
  child.stdout.emit('data', '{"end":1}\n');
  child.emit('exit', 0);
  assert.equal(ends, 1);
});

test('stop() cierra el ayudante sin avisar el fin', () => {
  const spawnFn = fakeSpawn();
  let ends = 0;
  const h = track({ pid: 77, platform: 'win32', spawnFn, onEnd: () => ends++ });
  h.stop();
  spawnFn.calls[0].child.emit('exit', 1);
  assert.equal(spawnFn.calls[0].child.killed, true);
  assert.equal(ends, 0);
});
