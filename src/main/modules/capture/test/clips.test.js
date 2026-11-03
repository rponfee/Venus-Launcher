'use strict';
// Cuentas de la pagina de Clips (modulos ES de la interfaz, sin DOM)
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const logic = require('../logic');
const PAGES = path.join(__dirname, '..', '..', '..', '..', 'renderer', 'js', 'pages', 'clips');
const load = (name) => import(pathToFileURL(path.join(PAGES, name)).href);

test('recorte vertical 9:16 centrado o elegido', async () => {
  const { verticalCrop, VERTICAL } = await load('crop.js');
  assert.deepEqual(verticalCrop(1920, 1080, 0.5), { sx: 656, sy: 0, sw: 608, sh: 1080 });
  assert.deepEqual(verticalCrop(1920, 1080, 0), { sx: 0, sy: 0, sw: 608, sh: 1080 });
  assert.deepEqual(verticalCrop(1920, 1080, 1), { sx: 1312, sy: 0, sw: 608, sh: 1080 });
  assert.deepEqual(verticalCrop(1920, 1080, 7), verticalCrop(1920, 1080, 1), 'pos fuera de rango se limita');
  assert.deepEqual(verticalCrop(1920, 1080, 'x'), verticalCrop(1920, 1080, 0.5));
  // Un video mas angosto que 9:16 se recorta arriba y abajo
  assert.deepEqual(verticalCrop(500, 1000, 0.5), { sx: 0, sy: 56, sw: 500, sh: 889 });
  const c = verticalCrop(1280, 720);
  assert.ok(Math.abs(c.sw / c.sh - VERTICAL) < 0.01);
  // Horizontal 16:9 de un video 4:3
  assert.deepEqual(verticalCrop(1024, 768, 0.5, 16 / 9), { sx: 0, sy: 96, sw: 1024, sh: 576 });
});

test('tamanio de salida, bitrate y recorte de inicio y fin', async () => {
  const { verticalCrop, outputSize, exportBitrate, clampTrim, fmtClock, MIN_CLIP } = await load('crop.js');
  assert.deepEqual(outputSize(verticalCrop(1920, 1080), 'vertical'), { width: 608, height: 1080 });
  assert.deepEqual(outputSize(verticalCrop(3840, 2160), 'vertical'), { width: 1080, height: 1920 });
  assert.deepEqual(outputSize({ sw: 2560, sh: 1440 }, 'horizontal'), { width: 1920, height: 1080 });
  assert.deepEqual(outputSize({ sw: 801, sh: 451 }, 'horizontal'), { width: 800, height: 450 });
  assert.ok(exportBitrate(1080, 1920) > exportBitrate(608, 1080));
  assert.equal(exportBitrate(10, 10), 2e6);
  assert.deepEqual(clampTrim(-3, 99, 30), { start: 0, end: 30 });
  assert.deepEqual(clampTrim(10, 10.1, 30), { start: 10, end: 10 + MIN_CLIP });
  assert.deepEqual(clampTrim(29.9, 30, 30), { start: 30 - MIN_CLIP, end: 30 });
  assert.deepEqual(clampTrim(0, 0, 0.3), { start: 0, end: 0.3 });
  assert.equal(fmtClock(65.34), '1:05.3');
  assert.equal(fmtClock(5, 0), '0:05');
});

test('motivo de los clips automaticos: lo que escribe logic.fileName, en el filtro y sin tocar lo demas', async () => {
  const { reasonOf, filterItems, countByTab, REASONS } = await load('model.js');
  const d = new Date(2026, 10, 2, 18, 3, 9);
  assert.deepEqual(REASONS, ['death', 'advancement', 'boss']);
  for (const r of REASONS) assert.equal(reasonOf({ file: logic.fileName('clip', d, r) }), r);
  assert.ok(REASONS.every((r) => logic.AUTO_REASONS.includes(r)), 'los mismos motivos en los dos lados');
  assert.equal(reasonOf({ file: logic.fileName('clip', d) }), null, 'el atajo no lleva motivo');
  assert.equal(reasonOf({ file: '2026-11-02_18.03.09_auto-death-2.webm' }), 'death', 'nombre repetido');
  assert.equal(reasonOf({ file: logic.exportName('2026-11-02_18.03.09_auto-boss.webm', 'vertical') }), 'boss', 'lo exportado lo conserva');
  assert.equal(reasonOf({ file: 'auto-death.webm' }), null);
  assert.equal(reasonOf({ file: '2026_auto-otro.webm' }), null);
  assert.equal(reasonOf(null), null);
  const now = d.getTime();
  const items = [
    { kind: 'clip', rel: 'clips/a_auto-death.webm', file: 'a_auto-death.webm', instanceId: 'i', date: now - 1 },
    { kind: 'clip', rel: 'clips/b_auto-boss.webm', file: 'b_auto-boss.webm', instanceId: 'i', date: now - 2 },
    { kind: 'clip', rel: 'clips/c_auto-advancement.webm', file: 'c_auto-advancement.webm', instanceId: 'i', date: now - 3 },
    { kind: 'clip', rel: 'clips/d_replay.webm', file: 'd_replay.webm', instanceId: 'i', date: now - 4 },
    { kind: 'clip', rel: 'recordings/e_rec.webm', file: 'e_rec.webm', instanceId: 'i', date: now - 5 },
    { kind: 'screenshot', rel: 'screenshots/f.png', file: 'f.png', instanceId: 'i', date: now - 6 },
  ];
  const names = (f) => filterItems(items, { now, ...f }).map((i) => i.file[0]).join('');
  assert.equal(names({ tab: 'clips' }), 'abcd');
  assert.equal(names({ tab: 'clips', reason: 'death' }), 'a');
  assert.equal(names({ tab: 'clips', reason: 'boss' }), 'b');
  assert.equal(names({ tab: 'clips', reason: 'advancement' }), 'c');
  assert.equal(names({ tab: 'screenshots', reason: 'death' }), 'f', 'las otras pestanas no tienen motivo');
  assert.equal(names({ tab: 'recordings', reason: 'death' }), 'e');
  assert.deepEqual(countByTab(items, { now, reason: 'death' }), { screenshots: 1, clips: 1, recordings: 1 });
});

test('pestanas, filtros por instancia, fecha y texto', async () => {
  const { tabOf, filterItems, countByTab, rangeStart, matches, instancesOf, normalizeText } = await load('model.js');
  const now = new Date(2026, 10, 15, 12, 0, 0).getTime();
  const day = 86400000;
  const items = [
    { kind: 'screenshot', rel: 'screenshots/a.png', file: 'a.png', world: 'Isla Ñandú', instanceId: 'i1', instanceName: 'Survival', date: now - 1000 },
    { kind: 'clip', rel: 'clips/b_replay.webm', file: 'b_replay.webm', world: null, instanceId: 'i1', instanceName: 'Survival', date: now - 3 * day },
    { kind: 'clip', rel: 'recordings/c_rec.webm', file: 'c_rec.webm', world: 'Base', instanceId: 'i2', instanceName: 'Creativo', date: now - 20 * day },
    { kind: 'clip', rel: 'replay_videos\\d.mp4', file: 'd.mp4', instanceId: 'i2', instanceName: 'Creativo', date: now - 400 * day },
  ];
  assert.deepEqual(items.map(tabOf), ['screenshots', 'clips', 'recordings', 'clips']);
  assert.equal(rangeStart('all', now), 0);
  assert.equal(rangeStart('today', now), new Date(2026, 10, 15).getTime());
  assert.equal(filterItems(items, { tab: 'clips', now }).length, 2);
  assert.equal(filterItems(items, { tab: 'clips', range: 'week', now }).length, 1);
  assert.equal(filterItems(items, { instanceId: 'i2', now }).length, 2);
  assert.equal(filterItems(items, { range: 'month', now }).length, 3);
  assert.equal(filterItems(items, { query: 'nandu', now })[0].file, 'a.png', 'busca sin tildes por el mundo');
  assert.equal(filterItems(items, { query: 'creativo base', now }).length, 1);
  assert.equal(filterItems(items, { query: 'atardecer', now, extraText: (it) => (it.file === 'd.mp4' ? 'un atardecer en la playa' : '') }).length, 1);
  assert.deepEqual(countByTab(items, { now }), { screenshots: 1, clips: 2, recordings: 1 });
  assert.deepEqual(countByTab(items, { now, instanceId: 'i1' }), { screenshots: 1, clips: 1, recordings: 0 });
  assert.ok(matches(items[0], ''));
  assert.equal(normalizeText(' ÁrBol '), 'arbol');
  assert.deepEqual(instancesOf(items).map((i) => [i.id, i.count]), [['i2', 2], ['i1', 2]]);
  const sorted = filterItems([...items].reverse(), { now });
  assert.equal(sorted[0].file, 'a.png', 'mas nuevo primero');
});
