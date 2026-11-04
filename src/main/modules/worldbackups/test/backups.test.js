'use strict';
// Una copia automatica es una copia como cualquier otra: se lista marcada y se restaura igual. Con una carpeta temporal.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const paths = require('../../../core/paths');
const backups = require('../../worlds/backups');
const plan = require('../plan');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'venus-bk-'));
  paths.setRoot(root);
  const dir = path.join(root, 'instances', 'inst');
  const world = path.join(dir, 'saves', 'Mundo');
  fs.mkdirSync(path.join(world, 'region'), { recursive: true });
  fs.writeFileSync(path.join(world, 'level.dat'), 'nivel');
  fs.writeFileSync(path.join(world, 'session.lock'), 'lock');
  fs.writeFileSync(path.join(world, 'region', 'r.0.0.mca'), Buffer.alloc(2 * 1024 * 1024, 5));
  return { inst: { id: 'inst', dir }, world, dir };
}

test('la copia automática se lista marcada, la manual no', async () => {
  const { inst } = setup();
  const auto = await backups.create(inst, 'Mundo', { auto: true });
  const manual = await backups.create(inst, 'Mundo');
  assert.match(auto.name, /\.auto\.zip$/);
  assert.equal(auto.auto, true);
  assert.equal(manual.auto, false);
  const list = await backups.list('inst', 'Mundo');
  assert.equal(list.length, 2);
  assert.equal(list.find((b) => b.name === auto.name).auto, true);
  assert.equal(list.find((b) => b.name === manual.name).auto, false);
  assert.ok(backups.checkBackupPath(auto.path), 'pasa el control de rutas de restaurar y borrar');
});

test('rotar con archivos de verdad deja las manuales', async () => {
  const { inst } = setup();
  const dir = backups.dirFor('inst');
  fs.mkdirSync(dir, { recursive: true });
  const name = (day, tail) => `Mundo-2026-01-0${day}_10-00-00${tail}`;
  for (const n of [name(1, '.auto.zip'), name(2, '.zip'), name(3, '.auto.zip'), name(4, '.auto.zip')]) fs.writeFileSync(path.join(dir, n), 'zip');
  void inst;
  for (const b of plan.rotationVictims(await backups.list('inst', 'Mundo'), 2)) await backups.remove(b.path);
  assert.deepEqual(fs.readdirSync(dir).sort(), [name(2, '.zip'), name(3, '.auto.zip'), name(4, '.auto.zip')].sort());
});

test('una copia automática se restaura como mundo nuevo y reemplazando', async () => {
  const { inst, world, dir } = setup();
  const auto = await backups.create(inst, 'Mundo', { auto: true });
  fs.writeFileSync(path.join(world, 'level.dat'), 'cambiado');
  const copy = await backups.restore(inst, 'Mundo', auto.path, { mode: 'copy' });
  assert.notEqual(copy.folder, 'Mundo');
  assert.equal(fs.readFileSync(path.join(dir, 'saves', copy.folder, 'level.dat'), 'utf8'), 'nivel');
  assert.ok(!fs.existsSync(path.join(dir, 'saves', copy.folder, 'session.lock')), 'session.lock no viaja');
  assert.equal(fs.statSync(path.join(dir, 'saves', copy.folder, 'region', 'r.0.0.mca')).size, 2 * 1024 * 1024);
  const back = await backups.restore(inst, 'Mundo', auto.path, { mode: 'replace' });
  assert.equal(back.folder, 'Mundo');
  assert.equal(fs.readFileSync(path.join(world, 'level.dat'), 'utf8'), 'nivel');
  const kept = fs.readdirSync(path.join(dir, 'saves'));
  assert.ok(kept.length >= 3, 'sin papelera, el mundo de antes queda al lado con otro nombre');
});
