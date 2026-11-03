// Contraste de la paleta clara y coincidencia con styles/a11y.css. node --test "src/renderer/js/a11y/test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIGHT_VARS, legibleAccent } from '../engine.js';
import { parseColor, contrast } from '../color.js';

const ratio = (a, b) => contrast(parseColor(LIGHT_VARS[a]), parseColor(LIGHT_VARS[b]));

test('la paleta clara se lee (WCAG AA sobre fondo y tarjetas)', () => {
  for (const bg of ['--bg-0', '--bg-1', '--surface', '--surface-2', '--surface-3']) {
    assert.ok(ratio('--text', bg) >= 7, `--text sobre ${bg}: ${ratio('--text', bg).toFixed(2)}`);
    assert.ok(ratio('--text-2', bg) >= 4.5, `--text-2 sobre ${bg}: ${ratio('--text-2', bg).toFixed(2)}`);
    assert.ok(ratio('--muted', bg) >= 4.5, `--muted sobre ${bg}: ${ratio('--muted', bg).toFixed(2)}`);
    assert.ok(ratio('--faint', bg) >= 3, `--faint sobre ${bg}: ${ratio('--faint', bg).toFixed(2)}`);
    assert.ok(ratio('--accent-hi', bg) >= 4.5, `--accent-hi sobre ${bg}: ${ratio('--accent-hi', bg).toFixed(2)}`);
    assert.ok(ratio('--cream', bg) >= 4.5, `--cream sobre ${bg}: ${ratio('--cream', bg).toFixed(2)}`);
    for (const k of ['--good-text', '--warn-text', '--bad-text', '--info-text']) assert.ok(ratio(k, bg) >= 4.5, `${k} sobre ${bg}: ${ratio(k, bg).toFixed(2)}`);
  }
  // la tinta del boton primario sobre el acento claro
  assert.ok(ratio('--accent-ink', '--accent') >= 4.5, `--accent-ink sobre --accent: ${ratio('--accent-ink', '--accent').toFixed(2)}`);
  // los fondos son claros y el texto oscuro (es un tema claro de verdad)
  for (const k of ['--bg-0', '--bg-1', '--surface', '--surface-2', '--surface-3', '--surface-4']) assert.ok(contrast(parseColor(LIGHT_VARS[k]), parseColor('#000000')) > 10, k);
});

test('el acento legible se oscurece sobre el tema claro y se aclara sobre el oscuro', () => {
  const dark = legibleAccent('#1a2a5a');
  const light = legibleAccent('#ffe08a', true);
  assert.notEqual(dark, '#1a2a5a');
  assert.notEqual(light, '#ffe08a');
  assert.equal(legibleAccent('#f29a2e'), '#f29a2e');
  assert.equal(legibleAccent('zzz'), '#f29a2e');
  assert.equal(legibleAccent('zzz', true), LIGHT_VARS['--accent']);
  assert.ok(contrast(parseColor(light), parseColor(LIGHT_VARS['--bg-0'])) > contrast(parseColor('#ffe08a'), parseColor(LIGHT_VARS['--bg-0'])));
});

test('styles/a11y.css lleva exactamente las mismas variables que LIGHT_VARS', () => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'styles', 'a11y.css');
  const css = fs.readFileSync(file, 'utf8');
  const block = /html\[data-scheme='light'\]\s*\{([^}]*)\}/.exec(css);
  assert.ok(block, 'falta la regla html[data-scheme=light] en a11y.css');
  const vars = {};
  for (const m of block[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) vars[m[1]] = m[2].trim();
  assert.deepEqual(vars, LIGHT_VARS);
});
