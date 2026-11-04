'use strict';
// Resumen de una partida y rotacion de los archivos por mes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { stats, downsample, summarize, MAX_POINTS } = require('../summary');
const { monthKey, pruneOld, fitSize, createStore, MAX_AGE_MS } = require('../store');
const { readFps } = require('../fps');

const DAY = 86400000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'venus-perf-'));

test('stats: promedio, mínimo, máximo y 1 % bajo', () => {
  const s = stats([10, 20, 30, 40]);
  assert.deepEqual(s, { avg: 25, min: 10, low1: 10, max: 40, n: 4 });
  // 300 muestras: el 1 % son las 3 más bajas
  const many = Array.from({ length: 300 }, (_, i) => i + 1);
  assert.equal(stats(many).low1, 2);
  assert.equal(stats(many).min, 1);
  assert.equal(stats(many).max, 300);
});

test('stats: sin datos es null y lo que no es número no cuenta como cero', () => {
  assert.equal(stats([]), null);
  assert.equal(stats([null, undefined, NaN]), null);
  assert.equal(stats(null), null);
  assert.deepEqual(stats([null, 60, null]), { avg: 60, min: 60, low1: 60, max: 60, n: 1 });
});

test('downsample: nunca pasa del tope y promedia', () => {
  const samples = Array.from({ length: 5000 }, (_, i) => ({ t: i * 10000, ram: 1000 + i, cpu: 10, fps: null }));
  const d = downsample(samples);
  assert.ok(d.t.length <= MAX_POINTS);
  assert.equal(d.ram.length, d.t.length);
  assert.equal(d.fps, null, 'sin FPS no se guarda la columna');
  assert.equal(downsample([{ t: 0, ram: 5, cpu: 1, fps: 60 }, { t: 10000, ram: 7, cpu: 3, fps: null }], 1).fps[0], 60);
  assert.deepEqual(downsample([]), { t: [], ram: [], cpu: [], fps: null });
});

test('summarize: arma el registro y marca los FPS como faltantes', () => {
  const r = summarize({ id: 'a', instanceId: 'i', instanceName: 'I', mcVersion: '1.21', loader: 'fabric', start: 1000, end: 61000, samples: [{ t: 10000, ram: 2000, cpu: 40, fps: null }, { t: 20000, ram: 3000, cpu: 60, fps: null }] });
  assert.equal(r.durationMs, 60000);
  assert.equal(r.samples, 2);
  assert.equal(r.ram.avg, 2500);
  assert.equal(r.cpu.max, 60);
  assert.equal(r.fps, null);
  assert.equal(r.series.fps, null);
  assert.equal(r.crashed, false);
});

test('readFps: sin archivo, viejo o raro es null', () => {
  const dir = tmp();
  assert.equal(readFps(dir), null);
  fs.mkdirSync(path.join(dir, 'venus'));
  const f = path.join(dir, 'venus', 'perf.json');
  fs.writeFileSync(f, JSON.stringify({ fps: 144.4, at: 1000 }));
  assert.deepEqual(readFps(dir, 2000), { fps: 144, at: 1000 });
  assert.equal(readFps(dir, 1000 + 60000), null, 'dato viejo');
  fs.writeFileSync(f, 'nada');
  assert.equal(readFps(dir, 2000), null);
});

test('monthKey y 90 días de vida', () => {
  assert.equal(monthKey(new Date(2026, 10, 3).getTime()), '2026-11');
  const now = Date.now();
  const list = [{ id: 'nueva', start: now - DAY, end: now - DAY }, { id: 'vieja', start: now - 91 * DAY, end: now - 91 * DAY }];
  assert.deepEqual(pruneOld(list, now).map((s) => s.id), ['nueva']);
  assert.deepEqual(pruneOld(null, now), []);
});

test('fitSize: primero se pierden las series de las más viejas, después partidas', () => {
  const series = { t: new Array(500).fill(1), ram: new Array(500).fill(1000), cpu: new Array(500).fill(1), fps: null };
  const list = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, start: i, series }));
  const size = Buffer.byteLength(JSON.stringify({ version: 1, sessions: list }));
  const kept = fitSize(list, Math.floor(size * 0.6));
  assert.equal(kept.length, 10, 'todavía entran todas sin serie');
  assert.equal(kept[0].series, null);
  assert.ok(kept[9].series, 'la más nueva conserva la serie');
  const tiny = fitSize(list, 200);
  assert.ok(tiny.length >= 1 && tiny.length < 10);
  assert.equal(tiny[tiny.length - 1].id, 's9', 'quedan las más nuevas');
});

test('el archivo del mes respeta el tope de tamaño al guardar', async () => {
  const dir = tmp();
  const now = Date.now();
  const store = createStore(dir, { now: () => now, maxBytes: 20000 });
  for (let i = 0; i < 40; i++) await store.save({ id: `s${i}`, start: now - i, end: now, series: { t: new Array(300).fill(1), ram: new Array(300).fill(1000), cpu: new Array(300).fill(1), fps: null } });
  const key = monthKey(now);
  assert.ok(fs.statSync(path.join(dir, `${key}.json`)).size <= 20000);
  assert.ok((await store.list()).length > 0);
});

test('guardar, listar sin serie, buscar, reemplazar, borrar', async () => {
  const dir = tmp();
  const now = Date.now();
  const store = createStore(dir, { now: () => now });
  await store.save({ id: 'a', instanceId: 'x', start: now - 1000, end: now, series: { t: [1] } });
  await store.save({ id: 'b', instanceId: 'y', start: now - 500, end: now, series: null });
  const list = await store.list();
  assert.deepEqual(list.map((s) => s.id), ['b', 'a']);
  assert.equal(list[1].series, undefined);
  assert.equal(list[1].hasSeries, true);
  assert.deepEqual((await store.list({ instanceId: 'x' })).map((s) => s.id), ['a']);
  assert.deepEqual((await store.get('a')).series, { t: [1] });
  await store.save({ id: 'a', instanceId: 'x', start: now - 1000, end: now, partial: false, series: null });
  assert.equal((await store.list()).length, 2, 'la misma partida se reemplaza');
  assert.equal(await store.remove('a'), true);
  assert.equal(await store.remove('a'), false);
  assert.equal(await store.get('a'), null);
  await store.clear();
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('rotación: borra meses vencidos y partidas de más de 90 días de los que quedan', async () => {
  const dir = tmp();
  const now = new Date(2026, 10, 15, 12).getTime();
  const old = new Date(2026, 4, 2).getTime();
  const edge = now - 91 * DAY;
  const recent = now - DAY;
  const write = (key, sessions) => fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify({ version: 1, sessions }));
  write(monthKey(old), [{ id: 'mayo', start: old, end: old }]);
  write(monthKey(edge), [{ id: 'justo', start: edge, end: edge }, { id: 'sirve', start: now - 80 * DAY, end: now - 80 * DAY }]);
  write(monthKey(recent), [{ id: 'nueva', start: recent, end: recent }]);
  const store = createStore(dir, { now: () => now });
  await store.rotate();
  const names = fs.readdirSync(dir);
  assert.ok(!names.includes(`${monthKey(old)}.json`), 'el mes vencido se borra entero');
  const ids = (await store.list()).map((s) => s.id).sort();
  assert.ok(ids.includes('nueva'));
  assert.ok(!ids.includes('justo'));
  assert.ok(!ids.includes('mayo'));
  assert.ok(MAX_AGE_MS > 0);
});
