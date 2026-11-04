'use strict';
// Modo familia: PIN y codigo de recuperacion. Solo se guarda un hash con sal (crypto.scrypt), nunca el valor. Sin
// Electron ni disco (pruebas en test/pin.test.js).
//   validPin(pin) · hashSecret(valor) -> { salt, hash, N } · checkSecret(valor, guardado) -> boolean
//   newRecoveryCode() -> 'XXXX-XXXX-XXXX-XXXX' (se muestra una sola vez)
//   lockInfo(intentos, ahora) · failedAttempt(intentos, ahora) · okAttempt(): 5 intentos y 5 minutos de espera
const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

const MAX_ATTEMPTS = 5;
const LOCK_MS = 5 * 60 * 1000;
const PIN_RE = /^\d{4,8}$/;
const N = 32768; // ~32 MB y unos 100 ms: frena probar todos los PIN en el archivo, sin que se note al escribirlo
const R = 8;
const P = 1;
const KEY_LEN = 32;
const MAXMEM = 64 * 1024 * 1024;
// Sin letras ni numeros que se confundan al copiarlo a mano (0/O, 1/I)
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const validPin = (pin) => typeof pin === 'string' && PIN_RE.test(pin);

const derive = (value, salt, n) => scrypt(value, salt, KEY_LEN, { N: n, r: R, p: P, maxmem: MAXMEM });

// El codigo se escribe con o sin guiones y en minusculas: se compara siempre igual.
const normalizeCode = (code) => String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

async function hashSecret(value) {
  const salt = crypto.randomBytes(16);
  const key = await derive(String(value), salt, N);
  return { salt: salt.toString('base64'), hash: key.toString('base64'), N };
}

async function checkSecret(value, saved) {
  if (!saved?.salt || !saved?.hash) return false;
  const expected = Buffer.from(saved.hash, 'base64');
  const n = Number.isInteger(saved.N) && saved.N >= 2 && saved.N <= N * 4 ? saved.N : N;
  const key = await derive(String(value), Buffer.from(saved.salt, 'base64'), n);
  return expected.length === key.length && crypto.timingSafeEqual(expected, key);
}

function newRecoveryCode() {
  const bytes = crypto.randomBytes(16);
  const chars = Array.from(bytes, (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
  return chars.match(/.{4}/g).join('-');
}

// Espera vigente. Una espera mas larga que lo normal es un reloj movido: nunca se bloquea mas de 5 minutos.
function lockInfo(attempts, now) {
  const until = Math.min(Number(attempts?.lockedUntil) || 0, now + LOCK_MS);
  const locked = until > now;
  return { locked, lockedUntil: locked ? until : 0, retryInMs: locked ? until - now : 0, attemptsLeft: locked ? 0 : Math.max(0, MAX_ATTEMPTS - (Number(attempts?.count) || 0)) };
}

function failedAttempt(attempts, now) {
  const count = (Number(attempts?.count) || 0) + 1;
  return count >= MAX_ATTEMPTS ? { count: 0, lockedUntil: now + LOCK_MS } : { count, lockedUntil: 0 };
}

const okAttempt = () => ({ count: 0, lockedUntil: 0 });

module.exports = { MAX_ATTEMPTS, LOCK_MS, validPin, normalizeCode, hashSecret, checkSecret, newRecoveryCode, lockInfo, failedAttempt, okAttempt };
