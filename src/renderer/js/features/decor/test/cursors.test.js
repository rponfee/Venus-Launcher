// Pruebas de los cursores SVG (sin DOM). node --test "src/renderer/js/features/decor/test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';
import { CURSOR_IDS, HOTSPOT, SIZE, cursorSvg, cursorDataUrl, cursorCss, cursorGrid } from '../cursors.js';
import { CURSORS } from '../settings.js';

test('los ids de cursores coinciden con los ajustes (más "default")', () => {
  assert.deepEqual(['default', ...CURSOR_IDS], CURSORS);
});

test('cada cursor es un SVG válido de 32×32 con píxeles', () => {
  for (const id of CURSOR_IDS) {
    for (const variant of ['normal', 'pointer']) {
      const svg = cursorSvg(id, variant);
      assert.ok(svg.startsWith('<svg'), `${id}/${variant}: no empieza con <svg`);
      assert.ok(svg.endsWith('</svg>'), `${id}/${variant}: no termina con </svg>`);
      assert.match(svg, /width="32" height="32"/, `${id}/${variant}: tamaño`);
      assert.match(svg, new RegExp(`viewBox="0 0 ${SIZE} ${SIZE}"`), `${id}/${variant}: viewBox`);
      assert.match(svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, `${id}/${variant}: xmlns`);
      assert.ok((svg.match(/<path /g) || []).length >= 3, `${id}/${variant}: pocos colores`);
      assert.ok((svg.match(/h\d+v1h-\d+z/g) || []).length >= 10, `${id}/${variant}: pocos píxeles`);
      assert.ok(!/undefined|null|NaN/.test(svg), `${id}/${variant}: valores rotos`);
      // todos los colores son hex de 6 dígitos (nada depende del tema ni de archivos)
      for (const m of svg.matchAll(/fill="([^"]+)"/g)) assert.match(m[1], /^#[0-9a-f]{6}$/i, `${id}/${variant}: color ${m[1]}`);
    }
    // la variante para botones tiene otro color
    assert.notEqual(cursorSvg(id, 'normal'), cursorSvg(id, 'pointer'), `${id}: las variantes son iguales`);
    // y ninguna tiene archivos externos
    assert.ok(!/href|url\(/.test(cursorSvg(id)), `${id}: referencias externas`);
  }
  assert.equal(cursorSvg('default'), null);
  assert.equal(cursorSvg('banana'), null);
});

test('el punto activo cae sobre la punta dibujada (o pegado a ella)', () => {
  assert.deepEqual(HOTSPOT, [2, 2]);
  const [cx, cy] = [HOTSPOT[0] / 2, HOTSPOT[1] / 2];
  for (const id of CURSOR_IDS) {
    const g = cursorGrid(id);
    assert.equal(g.length, SIZE);
    assert.ok(g.every((row) => row.length === SIZE), `${id}: ancho`);
    const near = [-1, 0, 1].some((dy) => [-1, 0, 1].some((dx) => g[cy + dy]?.[cx + dx]));
    assert.ok(near, `${id}: nada dibujado alrededor de la celda (1,1)`);
    // nada por encima ni a la izquierda de la punta: el cursor no tapa lo que señala
    assert.ok(g[0].every((c) => !c || c === '#'), `${id}: dibujo por encima de la punta`);
    // contorno oscuro presente y algo de color adentro
    const chars = new Set(g.flat().filter(Boolean));
    assert.ok(chars.has('#'), `${id}: sin contorno`);
    assert.ok(chars.size >= 3, `${id}: muy pocos colores`);
    // nada se sale de la grilla por la derecha o abajo (la última fila y columna quedan para el contorno)
    assert.ok(g[SIZE - 1].every((c) => !c || c === '#'), `${id}: dibujo cortado abajo`);
  }
});

test('URL data: y valores de CSS listos para usar', () => {
  for (const id of CURSOR_IDS) {
    const url = cursorDataUrl(id);
    assert.ok(url.startsWith('data:image/svg+xml,'), id);
    assert.ok(!/[<>"#]/.test(url.slice(19)), `${id}: caracteres sin codificar`);
    assert.ok(url.length < 4000, `${id}: URL muy larga (${url.length})`);
    const css = cursorCss(id);
    assert.ok(css.normal.startsWith('url("data:image/svg+xml,') && css.normal.endsWith('") 2 2'), `${id}: css normal`);
    assert.ok(css.pointer.startsWith('url("data:image/svg+xml,') && css.pointer.endsWith('") 2 2'), `${id}: css pointer`);
    assert.notEqual(css.normal, css.pointer);
    assert.equal(decodeURIComponent(url.slice(19)), cursorSvg(id));
  }
  assert.equal(cursorCss('default'), null);
  assert.equal(cursorDataUrl('nope'), null);
});
