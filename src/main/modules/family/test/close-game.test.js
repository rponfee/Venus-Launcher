'use strict';
// Cierre del juego por el control parental (family.js closeGame) según el sistema, sin lanzar Minecraft: se reemplazan
// game.status/game.stop y platform.stopProcess por dobles.
// node --test "src/main/modules/family/test/"
const test = require('node:test');
const assert = require('node:assert/strict');
const game = require('../../../core/game');
const platform = require('../../../core/platform');
const family = require('../../family');

function withDoubles(fn) {
  const original = { status: game.status, stop: game.stop, stopProcess: platform.stopProcess };
  const calls = { stop: [], stopProcess: [] };
  game.status = () => ({ a: { pid: 4242 }, b: { pid: 4343 }, c: { pid: 4444 } });
  game.stop = (...args) => (calls.stop.push(args), true);
  platform.stopProcess = (opts) => (calls.stopProcess.push(opts), true);
  try {
    fn(calls);
  } finally {
    Object.assign(game, { status: original.status, stop: original.stop });
    platform.stopProcess = original.stopProcess;
  }
}

test('Windows: taskkill sin /F como antes, sin pasar por game.stop', () => {
  withDoubles((calls) => {
    family.closeGame('a', 'limit', 'win32');
    assert.deepEqual(calls.stopProcess, [{ pid: 4242, force: false }]);
    assert.deepEqual(calls.stop, []);
  });
});

test('macOS: el cierre amable va por game.stop (queda marcado killed: la salida 143 no es un crash)', () => {
  withDoubles((calls) => {
    family.closeGame('b', 'schedule', 'darwin');
    assert.deepEqual(calls.stop, [['b', { force: false }]]);
    assert.deepEqual(calls.stopProcess, []);
  });
});

test('Linux: igual que macOS', () => {
  withDoubles((calls) => {
    family.closeGame('c', 'server', 'linux');
    assert.deepEqual(calls.stop, [['c', { force: false }]]);
    assert.deepEqual(calls.stopProcess, []);
  });
});

test('game.stop sin la partida no hace nada y acepta el cierre amable', () => {
  assert.equal(game.stop('no-existe', { force: false }), false);
  assert.equal(game.stop('no-existe'), false);
});
