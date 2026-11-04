'use strict';
// Seleccion del Montaje de la semana, reparto de la duracion y cuentas del timelapse (modulos ES de la interfaz, sin DOM)
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'logic.js')).href);

const NOW = new Date(2026, 10, 3, 12, 0, 0).getTime();
const DAY = 86400000;

function clip(name, daysAgo, over = {}) {
  return { kind: 'clip', file: name, rel: `clips/${name}`, path: `C:/i/clips/${name}`, sharedKey: `k|${name}`, instanceId: 'a', date: NOW - daysAgo * DAY, ...over };
}

test('un candidato es un WebM de clips/, que no sea ya un montaje o un timelapse', async () => {
  const { isCandidate } = await load();
  assert.equal(isCandidate(clip('x_replay.webm', 1)), true);
  assert.equal(isCandidate(clip('x.mp4', 1)), false);
  assert.equal(isCandidate(clip('x_montage.webm', 1)), false);
  assert.equal(isCandidate(clip('x_timelapse-2.webm', 1)), false);
  assert.equal(isCandidate(clip('x.webm', 1, { rel: 'recordings/x.webm' })), false);
  assert.equal(isCandidate({ kind: 'screenshot', file: 'a.png', rel: 'screenshots/a.png' }), false);
});

test('propone automaticos y destacados de la semana, en el orden en que pasaron', async () => {
  const { proposeClips } = await load();
  const items = [
    clip('a_auto-death.webm', 1),
    clip('b_replay.webm', 2),
    clip('c_auto-boss.webm', 3),
    clip('d_auto-death.webm', 8), // de hace mas de 7 dias
    clip('e_replay.webm', 4),
    clip('f_replay.webm', 5),
    { kind: 'screenshot', file: 'g.png', rel: 'screenshots/g.png', date: NOW },
  ];
  const sharedMap = { 'k|e_replay.webm': { id: 'mediaE' }, 'k|f_replay.webm': { id: 'mediaF' } };
  const out = proposeClips(items, { now: NOW, sharedMap, featuredIds: new Set(['mediaF']) });
  assert.deepEqual(out.map((c) => c.file), ['f_replay.webm', 'e_replay.webm', 'c_auto-boss.webm', 'a_auto-death.webm']);
});

test('si son muchos, quedan los que mas valen y los mas nuevos', async () => {
  const { proposeClips } = await load();
  const items = [];
  for (let i = 0; i < 10; i++) items.push(clip(`d${i}_auto-death.webm`, i * 0.1));
  items.push(clip('jefe_auto-boss.webm', 6.5));
  const out = proposeClips(items, { now: NOW, limit: 4 });
  assert.equal(out.length, 4);
  assert.ok(out.some((c) => c.file === 'jefe_auto-boss.webm'), 'el jefe entra aunque sea el mas viejo');
  assert.equal(out[0].file, 'jefe_auto-boss.webm', 'el orden sigue siendo el de la semana');
  assert.ok(out.some((c) => c.file === 'd0_auto-death.webm'), 'y los mas nuevos');
  assert.ok(!out.some((c) => c.file === 'd9_auto-death.webm'));
});

test('sin automaticos ni destacados, los ultimos clips a mano', async () => {
  const { proposeClips } = await load();
  const out = proposeClips([clip('a_replay.webm', 1), clip('b_replay.webm', 6), clip('c_replay.webm', 9)], { now: NOW });
  assert.deepEqual(out.map((c) => c.file), ['b_replay.webm', 'a_replay.webm']);
  assert.deepEqual(proposeClips([], { now: NOW }), []);
  assert.deepEqual(proposeClips(null, { now: NOW }), []);
});

test('agregar a mano y reordenar', async () => {
  const { addableClips, moveItem } = await load();
  const items = [clip('a_replay.webm', 1), clip('b_auto-boss.webm', 2), clip('viejo.webm', 30)];
  const rest = addableClips(items, [{ path: items[1].path }], { now: NOW });
  assert.deepEqual(rest.map((c) => c.file), ['a_replay.webm']);
  assert.deepEqual(moveItem([1, 2, 3], 0, 2), [2, 3, 1]);
  assert.deepEqual(moveItem([1, 2, 3], 2, 1), [1, 3, 2]);
  assert.deepEqual(moveItem([1, 2, 3], 5, 1), [1, 2, 3]);
});

test('la duracion se reparte y se usa el final de cada clip', async () => {
  const { planSegments, TITLE_SECONDS } = await load();
  const list = [{ path: 'a', duration: 60 }, { path: 'b', duration: 60 }, { path: 'c', duration: 60 }];
  const p = planSegments(list, 30);
  assert.equal(p.total, 30);
  assert.deepEqual(p.segments.map((s) => s.length), [10, 10, 10]);
  assert.equal(p.segments[0].start, 50, 'se queda con el final');
  assert.equal(p.segments[0].trimmed, true);
  // Sin tope: enteros
  const all = planSegments(list, 0);
  assert.equal(all.total, 180);
  assert.equal(all.segments[1].start, 0);
  assert.equal(all.segments[1].trimmed, false);
  // Un clip corto usa lo suyo y lo que sobra les queda a los otros
  const short = planSegments([{ path: 'a', duration: 4 }, { path: 'b', duration: 60 }, { path: 'c', duration: 60 }], 30);
  assert.deepEqual(short.segments.map((s) => s.length), [4, 13, 13]);
  assert.equal(short.segments[0].trimmed, false);
  assert.equal(short.total, 30);
  // Todos entran: no se estira nada
  const fits = planSegments([{ path: 'a', duration: 5 }, { path: 'b', duration: 8 }], 60);
  assert.deepEqual(fits.segments.map((s) => s.length), [5, 8]);
  assert.equal(fits.total, 13);
  // La placa cuenta en la duracion
  const titled = planSegments(list, 30, { title: true });
  assert.ok(Math.abs(titled.total - 30) < 0.02);
  assert.ok(Math.abs(titled.segments[0].length - (30 - TITLE_SECONDS) / 3) < 0.02);
});

test('si no entran todos, quedan los primeros y se dice cuantos sobran', async () => {
  const { planSegments, MIN_SEGMENT } = await load();
  const list = Array.from({ length: 14 }, (_, i) => ({ path: `c${i}`, duration: 60 }));
  const p = planSegments(list, 30);
  assert.equal(p.segments.length, 10);
  assert.equal(p.dropped, 4);
  assert.ok(p.segments.every((s) => s.length >= MIN_SEGMENT));
  assert.deepEqual(planSegments([], 30), { segments: [], total: 0, dropped: 0 });
  // Los clips sin duracion conocida no cuentan
  assert.equal(planSegments([{ path: 'x', duration: 0 }], 30).segments.length, 0);
});

test('el resultado va a la instancia con mas clips', async () => {
  const { targetInstance } = await load();
  assert.equal(targetInstance([{ instanceId: 'a' }, { instanceId: 'b' }, { instanceId: 'b' }]), 'b');
  assert.equal(targetInstance([{ instanceId: 'a' }, { instanceId: 'b' }]), 'a');
  assert.equal(targetInstance([]), null);
});

test('tamanios: con franjas negras si no tiene la misma forma, sin agrandar y lados pares', async () => {
  const { fitBox, outputBox, videoBitrate } = await load();
  assert.deepEqual(fitBox(1920, 1080, 1920, 1080), { dx: 0, dy: 0, dw: 1920, dh: 1080 });
  assert.deepEqual(fitBox(1280, 1024, 1920, 1080), { dx: 285, dy: 0, dw: 1350, dh: 1080 });
  assert.deepEqual(fitBox(1920, 800, 1280, 720), { dx: 0, dy: 94, dw: 1280, dh: 533 });
  assert.deepEqual(outputBox(3840, 2160), { width: 1920, height: 1080 });
  assert.deepEqual(outputBox(1281, 721), { width: 1280, height: 720 });
  assert.deepEqual(outputBox(800, 600), { width: 800, height: 600 });
  assert.ok(videoBitrate(1920, 1080, 30) <= 16e6 && videoBitrate(1920, 1080, 30) > 2e6);
  assert.equal(videoBitrate(100, 100, 30), 1.5e6);
});

test('timelapse: duracion, velocidad y tiempos de cada cuadro', async () => {
  const { planTimelapse, frameTimestamp, keyInterval, frameDate, TIMELAPSE_MAX_FRAMES } = await load();
  const p = planTimelapse(240, 24, 30);
  assert.equal(p.duration, 10);
  assert.equal(p.factor, 720, 'una imagen cada 30 s a 24 por segundo: 720 veces mas rapido');
  assert.equal(planTimelapse(0, 24).frames, 0);
  assert.equal(planTimelapse(TIMELAPSE_MAX_FRAMES + 50, 24).frames, TIMELAPSE_MAX_FRAMES);
  assert.equal(frameTimestamp(0, 24), 0);
  assert.equal(frameTimestamp(24, 24), 1e6);
  assert.equal(frameTimestamp(1, 30), 33333);
  // Sin error acumulado
  assert.equal(frameTimestamp(30000, 30), 1e9);
  assert.equal(keyInterval(24), 48);
  assert.equal(frameDate('2026-11-03_18.03.09.jpg'), new Date(2026, 10, 3, 18, 3, 9).getTime());
  assert.equal(frameDate('otro.jpg'), 0);
});
