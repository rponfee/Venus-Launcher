import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAppearance, DEFAULT_APPEARANCE, readableNumber } from '../logic.js';

test('solo conserva el aspecto; el nivel y la XP no se pueden guardar en él', () => {
  const result = normalizeAppearance({ planet: 'mars', frame: 'nova', accent: '#AABBCC', number: '#ffffff', level: 99, xp: 999999 });
  assert.deepEqual(result, { planet: 'mars', frame: 'nova', accent: '#aabbcc', number: '#ffffff' });
});
test('ajustes viejos, corruptos y valores CSS o rutas ajenas vuelven a valores seguros', () => {
  for (const value of [null, [], 'bad', { planet: '../../elsewhere', frame: 'bad', accent: 'url(https://example.invalid)', number: '#000000' }]) {
    assert.deepEqual(normalizeAppearance(value), DEFAULT_APPEARANCE);
  }
});
test('el color del número mantiene contraste AA contra la placa, incluso con una preferencia oscura guardada', () => {
  assert.equal(readableNumber('#ffffff'), true);
  assert.equal(readableNumber('#100c0a'), false);
  assert.equal(readableNumber('#303030'), false);
  assert.equal(readableNumber('white'), false);
  assert.equal(readableNumber('#ffff00'), true);
  assert.equal(normalizeAppearance({ number: '#000000' }).number, DEFAULT_APPEARANCE.number);
});
