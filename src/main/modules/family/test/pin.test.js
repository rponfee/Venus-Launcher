'use strict';
// PIN, codigo de recuperacion e intentos del modo familia.
const test = require('node:test');
const assert = require('node:assert/strict');
const pin = require('../pin');

test('el PIN son de 4 a 8 números', () => {
  for (const ok of ['1234', '12345678']) assert.equal(pin.validPin(ok), true);
  for (const bad of ['123', '123456789', 'abcd', '12 34', '', null, 1234]) assert.equal(pin.validPin(bad), false);
});

test('se guarda un hash con sal: nunca el PIN, y dos veces el mismo PIN dan hashes distintos', async () => {
  const a = await pin.hashSecret('1234');
  const b = await pin.hashSecret('1234');
  assert.ok(!JSON.stringify(a).includes('1234'));
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.hash, b.hash);
  assert.equal(await pin.checkSecret('1234', a), true);
  assert.equal(await pin.checkSecret('1235', a), false);
  assert.equal(await pin.checkSecret('', a), false);
  assert.equal(await pin.checkSecret('1234', null), false);
  assert.equal(await pin.checkSecret('1234', { salt: a.salt }), false);
});

test('código de recuperación: largo, sin caracteres confusos y se acepta como se lo escriba', async () => {
  const code = pin.newRecoveryCode();
  assert.match(code, /^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/);
  assert.notEqual(code, pin.newRecoveryCode());
  const saved = await pin.hashSecret(pin.normalizeCode(code));
  assert.equal(await pin.checkSecret(pin.normalizeCode(code.toLowerCase().replace(/-/g, ' ')), saved), true);
});

test('5 intentos y 5 minutos de espera; acertar vuelve a cero', () => {
  const now = 1000000;
  let a = pin.okAttempt();
  for (let i = 1; i < pin.MAX_ATTEMPTS; i++) {
    a = pin.failedAttempt(a, now);
    assert.equal(pin.lockInfo(a, now).locked, false);
    assert.equal(pin.lockInfo(a, now).attemptsLeft, pin.MAX_ATTEMPTS - i);
  }
  a = pin.failedAttempt(a, now);
  const lock = pin.lockInfo(a, now);
  assert.equal(lock.locked, true);
  assert.equal(lock.retryInMs, pin.LOCK_MS);
  assert.equal(lock.attemptsLeft, 0);
  assert.equal(pin.lockInfo(a, now + pin.LOCK_MS - 1).locked, true);
  const later = pin.lockInfo(a, now + pin.LOCK_MS);
  assert.equal(later.locked, false);
  assert.equal(later.attemptsLeft, pin.MAX_ATTEMPTS, 'después de la espera hay 5 intentos de nuevo');
  assert.deepEqual(pin.okAttempt(), { count: 0, lockedUntil: 0 });
});

test('un reloj movido no bloquea para siempre', () => {
  const lock = pin.lockInfo({ count: 0, lockedUntil: 1e15 }, 1000);
  assert.equal(lock.retryInMs, pin.LOCK_MS);
  assert.equal(pin.lockInfo(null, 1000).attemptsLeft, pin.MAX_ATTEMPTS);
});
