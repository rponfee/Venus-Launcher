// Atajos con Cmd en macOS y funciones por plataforma en la interfaz (js/platform.js).
// node --test "src/renderer/js/platform/test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';
import { modKey, keyLabel, keyName, supports, setInfo, isMac } from '../../platform.js';

const key = (over = {}) => ({ ctrlKey: false, metaKey: false, ...over });

test('Ctrl+K, Ctrl+J y Ctrl+M: en Mac con Cmd o con Ctrl; en Windows solo Ctrl', () => {
  assert.equal(modKey(key({ metaKey: true }), true), true);
  assert.equal(modKey(key({ ctrlKey: true }), true), true);
  assert.equal(modKey(key({ ctrlKey: true, metaKey: true }), true), false);
  assert.equal(modKey(key(), true), false);
  assert.equal(modKey(key({ ctrlKey: true }), false), true);
  assert.equal(modKey(key({ metaKey: true }), false), false);
  assert.equal(modKey(key({ ctrlKey: true, metaKey: true }), false), false);
  assert.equal(modKey(null, true), false);
});

test('rótulos: ⌘ en Mac, igual en Windows, sin tocar teclas físicas', () => {
  assert.equal(keyLabel('Modo mini (Ctrl+M)', true), 'Modo mini (⌘M)');
  assert.equal(keyLabel('Ctrl+Shift+R', true), '⇧⌘R');
  assert.equal(keyLabel('Ctrl + Enter envía.', true), '⌘ + Enter envía.');
  assert.equal(keyLabel('Ctrl+Z', true), '⌘Z');
  assert.equal(keyLabel('Ctrl izquierdo', true), 'Ctrl izquierdo');
  assert.equal(keyLabel('Ctrl+Alt es AltGr', true), 'Ctrl+Alt es AltGr');
  assert.equal(keyLabel('Ctrl+K', false), 'Ctrl+K');
  assert.equal(keyLabel(undefined, true), undefined);
  assert.deepEqual(['Ctrl', 'Shift', 'R'].map((k) => keyName(k, true)), ['⌘', '⇧', 'R']);
  assert.deepEqual(['Ctrl', 'K'].map((k) => keyName(k, false)), ['Ctrl', 'K']);
});

test('funciones por plataforma: lo que dice app:info manda', () => {
  setInfo({ platform: 'darwin', capabilities: { overlay: false, nowplaying: false, capture: false } });
  assert.equal(isMac(), true);
  assert.equal(supports('overlay'), false);
  assert.equal(supports('nowplaying'), false);
  assert.equal(supports('voice'), true);
  setInfo({ platform: 'win32', capabilities: { overlay: true, nowplaying: true, capture: true } });
  assert.equal(isMac(), false);
  assert.equal(supports('overlay'), true);
  assert.equal(supports('capture'), true);
  setInfo(null); // no cambia nada
  assert.equal(isMac(), false);
});
