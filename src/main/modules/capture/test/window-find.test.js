'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const wf = require('../window-find');

test('salida del script e id de desktopCapturer', () => {
  assert.equal(wf.parseOutput('hwnd:3219316\r\n'), 3219316);
  assert.equal(wf.parseOutput('nada'), null);
  assert.equal(wf.parseOutput('hwnd:0'), null);
  assert.equal(wf.sourceId(3219316), 'window:3219316:0');
});

test('comando: PowerShell oculto con el pid en el entorno', () => {
  const cmd = wf.command({ pid: 1234, anyClass: true, waitMin: 2 });
  assert.equal(cmd.file, 'powershell.exe');
  assert.ok(cmd.args.includes('-WindowStyle') && cmd.args.includes('Hidden'));
  assert.equal(cmd.env.VENUS_GAME_PID, '1234');
  assert.equal(cmd.env.VENUS_ANY_CLASS, '1');
  assert.equal(cmd.env.VENUS_WAIT_MIN, '2');
  assert.match(wf.SCRIPT, /GLFW/);
});

test('fuera de Windows o sin pid no abre nada', async () => {
  let spawned = false;
  const spawnFn = () => {
    spawned = true;
  };
  assert.equal(await wf.findWindow({ pid: 10, platform: 'linux', spawnFn }).promise, null);
  assert.equal(await wf.findWindow({ pid: 0, platform: 'win32', spawnFn }).promise, null);
  assert.equal(spawned, false);
});

test('devuelve el handle apenas lo escribe el script y se puede cancelar', async () => {
  const fake = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => {
      child.killed = true;
    };
    setTimeout(() => child.stdout.emit('data', Buffer.from('hwnd:777\n')), 5);
    return child;
  };
  assert.equal(await wf.findWindow({ pid: 5, platform: 'win32', spawnFn: fake }).promise, 777);
  let child = null;
  const f = wf.findWindow({
    pid: 5,
    platform: 'win32',
    spawnFn: () => {
      child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.kill = () => {
        child.killed = true;
      };
      return child;
    },
  });
  f.cancel();
  assert.equal(child.killed, true);
});

test('respaldo por titulo de la ventana de Minecraft', () => {
  const list = [
    { id: 'window:1:0', name: 'Discord' },
    { id: 'window:2:0', name: 'Minecraft* 1.20.1 - Un jugador' },
    { id: 'window:3:0', name: 'Minecraft 1.21.1 · Venus Launcher' },
  ];
  assert.equal(wf.matchByTitle(list).id, 'window:3:0', 'primero la que tiene el titulo de Venus');
  assert.equal(wf.matchByTitle(list.slice(0, 2)).id, 'window:2:0');
  assert.equal(wf.matchByTitle([{ name: 'Minecraft Launcher' }]), null, 'el launcher oficial no es el juego');
  assert.equal(wf.matchByTitle(null), null);
});
