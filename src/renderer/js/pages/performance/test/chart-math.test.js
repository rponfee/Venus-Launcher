// Escalas, líneas y comparación del historial de rendimiento.
import test from 'node:test';
import assert from 'node:assert/strict';
import { niceMax, niceRam, ticks, bounds, linePath, compareRows } from '../chart-math.js';

test('niceMax redondea hacia arriba', () => {
  assert.equal(niceMax(3.2), 5);
  assert.equal(niceMax(1800), 2000);
  assert.equal(niceMax(100), 100);
  assert.equal(niceMax(0), 1);
  assert.equal(niceMax(null), 1);
});

test('niceRam da GB pares', () => {
  assert.equal(niceRam(3800), 4096);
  assert.equal(niceRam(4200), 6144);
  assert.equal(niceRam(500), 1024);
  assert.equal(niceRam(0), 1024);
});

test('ticks reparte el eje', () => {
  assert.deepEqual(ticks(100, 4), [0, 25, 50, 75, 100]);
});

test('bounds ignora los datos que faltan', () => {
  assert.deepEqual(bounds([{ t: [0, 10, 20], v: [1, null, 3] }, { t: [0, 40], v: [null, 7] }]), { tMax: 40, vMax: 10 });
  assert.deepEqual(bounds([]), { tMax: 1, vMax: 1 });
});

test('linePath corta la línea donde falta un dato', () => {
  const scale = { x: (n) => n, y: (n) => n };
  assert.equal(linePath([0, 1, 2], [5, 6, 7], scale), 'M0.0 5.0L1.0 6.0L2.0 7.0');
  assert.equal(linePath([0, 1, 2, 3], [5, null, 7, 8], scale), 'M0.0 5.0M2.0 7.0L3.0 8.0');
  assert.equal(linePath([], [], scale), '');
  assert.equal(linePath(null, null, scale), '');
});

test('compareRows: diferencia del promedio y sin datos no inventa nada', () => {
  const rows = compareRows({ ram: { avg: 2000 }, cpu: { avg: 40 }, fps: null }, { ram: { avg: 3000 }, cpu: { avg: 30 }, fps: null });
  assert.equal(rows[0].diff, 1000);
  assert.equal(rows[0].pct, 50);
  assert.equal(rows[1].diff, -10);
  assert.equal(rows[2].diff, null);
  assert.equal(rows[2].pct, null);
});
