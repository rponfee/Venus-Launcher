// node --test "src/renderer/js/features/extensions/test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';
import { isNewer } from '../version.js';

test('isNewer compara como números, no como texto', () => {
  assert.equal(isNewer('1.10.0', '1.9.0'), true);
  assert.equal(isNewer('1.9.0', '1.10.0'), false);
  assert.equal(isNewer('2.0.0', '1.99.99'), true);
  assert.equal(isNewer('1.0.0', '1.0.0'), false);
});

test('un sufijo es anterior a la misma versión sin sufijo', () => {
  assert.equal(isNewer('1.2.0', '1.2.0-beta'), true);
  assert.equal(isNewer('1.2.0-beta', '1.2.0'), false);
  assert.equal(isNewer('1.2.0-beta.2', '1.2.0-beta.1'), true);
  assert.equal(isNewer('1.3.0-beta', '1.2.0'), true);
});
