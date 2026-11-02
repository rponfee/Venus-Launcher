'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const logic = require('../logic');

test('atajos: normaliza, exige modificador y rechaza lo invalido', () => {
  assert.equal(logic.normalizeAccelerator('alt+shift+f8'), 'Alt+Shift+F8');
  assert.equal(logic.normalizeAccelerator(' Shift + Control + s '), 'Ctrl+Shift+S');
  assert.equal(logic.normalizeAccelerator('CommandOrControl+Alt+R'), 'CmdOrCtrl+Alt+R');
  assert.equal(logic.normalizeAccelerator('Ctrl+PrintScreen'), 'Ctrl+PrintScreen');
  assert.equal(logic.normalizeAccelerator('Ctrl++'), 'Ctrl+Plus');
  assert.equal(logic.normalizeAccelerator('F13'), 'F13', 'F13 a F24 sin modificador');
  assert.equal(logic.normalizeAccelerator('F2'), null, 'F2 solo le quitaria la captura al juego');
  assert.equal(logic.normalizeAccelerator('a'), null);
  assert.equal(logic.normalizeAccelerator('Ctrl+A+B'), null);
  assert.equal(logic.normalizeAccelerator('Ctrl+Nada'), null);
  assert.equal(logic.normalizeAccelerator('Ctrl+Shift'), null);
  assert.equal(logic.normalizeAccelerator(''), null);
  assert.equal(logic.normalizeAccelerator(42), null);
});

test('atajos de los ajustes: por defecto, vacios a proposito y repetidos', () => {
  assert.deepEqual(logic.normalizeShortcuts(undefined), { ...logic.DEFAULTS.shortcuts });
  assert.deepEqual(logic.normalizeShortcuts({ replay: '', record: null, screenshot: 'ctrl+f12' }), { replay: '', record: '', screenshot: 'Ctrl+F12' });
  const dup = logic.normalizeShortcuts({ replay: 'Alt+X', record: 'alt+x', screenshot: 'basura' });
  assert.deepEqual(dup, { replay: 'Alt+X', record: '', screenshot: '' });
});

test('ajustes: valores por defecto y validacion', () => {
  const d = logic.normalizeSettings(null);
  assert.equal(d.replay, false, 'la repeticion arranca apagada');
  assert.equal(d.quality, '1080p');
  assert.equal(d.fps, 30);
  assert.equal(d.audio, true);
  assert.equal(d.copyTo, '');
  const s = logic.normalizeSettings({ replay: true, quality: '4k', fps: '60', audio: false, copyTo: 'relativa/no' });
  assert.equal(s.replay, true);
  assert.equal(s.quality, '1080p');
  assert.equal(s.fps, 60);
  assert.equal(s.audio, false);
  assert.equal(s.copyTo, '');
  const abs = path.resolve('/tmp/clips');
  assert.equal(logic.normalizeSettings({ copyTo: abs }).copyTo, path.normalize(abs));
});

test('repeticion: 30 s o 120 s con premium', () => {
  assert.equal(logic.replaySeconds(false), 30);
  assert.equal(logic.replaySeconds(true), 120);
  assert.ok(logic.replayMemory(120, '1080p', 60) > logic.replayMemory(30, '1080p', 60));
  assert.ok(logic.replayMemory(30, 'native', 30) > logic.replayMemory(30, '1080p', 30));
});

test('calidad: tamanio dentro de la caja, sin agrandar y con lados pares', () => {
  assert.deepEqual(logic.fitSize(2560, 1440, '1080p'), { width: 1920, height: 1080 });
  assert.deepEqual(logic.fitSize(1280, 720, '1080p'), { width: 1280, height: 720 });
  assert.deepEqual(logic.fitSize(1921, 1081, '720p'), { width: 1278, height: 720 });
  assert.deepEqual(logic.fitSize(800, 2000, '720p'), { width: 288, height: 720 });
  assert.deepEqual(logic.qualityBox('native'), { width: 3840, height: 2160 });
});

test('bitrate: crece con el tamanio y los fps, con topes', () => {
  const a = logic.bitrateFor(1280, 720, 30);
  const b = logic.bitrateFor(1920, 1080, 30);
  const c = logic.bitrateFor(1920, 1080, 60);
  assert.ok(a < b && b < c);
  assert.ok(c < b * 2, '60 fps no cuesta el doble');
  assert.equal(logic.bitrateFor(10, 10, 30), logic.MIN_BPS);
  assert.equal(logic.bitrateFor(7680, 4320, 60), logic.MAX_BPS);
});

test('nombres: fecha local como la de Minecraft y carpeta por tipo', () => {
  const d = new Date(2026, 10, 1, 18, 3, 9);
  assert.equal(logic.stamp(d), '2026-11-01_18.03.09');
  assert.equal(logic.fileName('screenshot', d), '2026-11-01_18.03.09_venus.png');
  assert.equal(logic.fileName('clip', d), '2026-11-01_18.03.09_replay.webm');
  assert.equal(logic.fileName('recording', d), '2026-11-01_18.03.09_rec.webm');
  assert.throws(() => logic.fileName('otro', d));
  const inst = path.join('C:', 'datos', 'instances', 'abc');
  assert.equal(logic.folderFor(inst, 'screenshot'), path.join(inst, 'screenshots'));
  assert.equal(logic.folderFor(inst, 'clip'), path.join(inst, 'clips'));
  assert.equal(logic.folderFor(inst, 'recording'), path.join(inst, 'recordings'));
  // worlds/media.js lista esas carpetas y entiende la fecha del nombre
  const media = require('../../worlds/media');
  assert.ok(media.CLIP_DIRS.includes('clips') && media.CLIP_DIRS.includes('recordings'));
  assert.equal(media.nameTime(logic.fileName('clip', d)), d.getTime());
});

test('nombre unico y nombre de la exportacion', async () => {
  const taken = new Set(['x.webm', 'x-2.webm'].map((n) => path.join('d', n)));
  assert.equal(await logic.uniqueName('d', 'x.webm', async (p) => taken.has(p)), 'x-3.webm');
  assert.equal(await logic.uniqueName('d', 'y.webm', async () => false), 'y.webm');
  assert.equal(logic.exportName('2026-11-01_18.03.09_replay.webm', 'vertical'), '2026-11-01_18.03.09_replay_vertical.webm');
  assert.equal(logic.exportName('clip_vertical-2.webm', 'horizontal'), 'clip_edit.webm', 'no apila sufijos');
  assert.equal(logic.exportName('../../malo:<>.mp4', 'vertical'), 'malo__vertical.webm');
  assert.equal(logic.exportName('', 'x'), 'clip_edit.webm');
});

test('juego a capturar: el abierto mas reciente que no sea de prueba', () => {
  assert.equal(logic.pickGame({}), null);
  const st = {
    a: { state: 'running', pid: 10, startedAt: 100 },
    b: { state: 'running', pid: 20, startedAt: 300, quiet: true },
    c: { state: 'running', pid: 30, startedAt: 200 },
    d: { state: 'preparing', pid: 40, startedAt: 400 },
  };
  assert.deepEqual(logic.pickGame(st), { instanceId: 'c', pid: 30, startedAt: 200 });
});
