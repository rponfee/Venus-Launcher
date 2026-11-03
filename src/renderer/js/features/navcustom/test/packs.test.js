// Packs de iconos: todo icono del menu tiene su variante pixel y filled, y cualquier otro cae al de siempre.
// node --test "src/renderer/js/features/navcustom/test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';
import { NAV_ICONS, PIXEL, FILLED, PACKS, packIconName, packIconMap, bitmapPath } from '../packs.js';

test('cada icono del menu tiene las dos variantes', () => {
  for (const name of NAV_ICONS) {
    assert.ok(PIXEL[name], `falta px-${name}`);
    assert.ok(FILLED[name], `falta fi-${name}`);
    assert.equal(packIconName(name, 'pixel'), `px-${name}`);
    assert.equal(packIconName(name, 'filled'), `fi-${name}`);
    assert.equal(packIconName(name, 'outline'), name);
  }
});

test('un icono sin variante cae al de siempre', () => {
  assert.equal(packIconName('box', 'pixel'), 'box');
  assert.equal(packIconName('box', 'filled'), 'box');
  assert.equal(packIconName('home', 'neon'), 'home');
  assert.equal(packIconName('home', undefined), 'home');
});

test('los paths son SVG rellenos de 24x24 (sin trazo) y se registran con prefijo', () => {
  const map = packIconMap();
  for (const [name, svg] of Object.entries(map)) {
    assert.match(name, /^(px|fi)-\w+$/);
    assert.match(svg, /^<path fill="currentColor" stroke="none"/, name);
    assert.ok(!/<(img|image|script|use)/.test(svg), name);
    for (const n of svg.replace(/^<path[^d]*d="/, '').matchAll(/-?(?:\d+\.?\d*|\.\d+)/g)) assert.ok(Math.abs(Number(n[0])) <= 24, `${name}: ${n[0]}`);
  }
  assert.equal(Object.keys(map).length, Object.keys(PACKS.pixel).length + Object.keys(PACKS.filled).length);
});

test('los mapas pixel son de 12x12', () => {
  // bitmapPath junta celdas vecinas de una fila en un solo rectangulo
  assert.equal(bitmapPath(['.##.', '#..#']), 'M2 0h4v2h-4zM0 2h2v2h-2zM6 2h2v2h-2z');
  for (const [name, svg] of Object.entries(PIXEL)) {
    for (const m of svg.matchAll(/M(\d+) (\d+)h(\d+)/g)) {
      assert.ok(Number(m[1]) + Number(m[3]) <= 24 && Number(m[2]) < 24, `${name} fuera de la grilla`);
    }
  }
});
