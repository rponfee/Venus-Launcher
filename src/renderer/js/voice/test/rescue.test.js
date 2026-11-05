// Codigo de respaldo, salas guardadas, deteccion de "el servidor no responde" y lista de STUN.
// node --test "src/renderer/js/voice/test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatBackupCode, parseBackupCode, newEmergencyRoom, shareableSecret, RoomVault, VAULT_MAX, VAULT_TTL, isOutage, stunServers, STUN_BASE, STUN_MORE } from '../rescue.js';

const memory = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), raw: m };
};

test('codigo de respaldo: se arma, se agrupa y se lee con cualquier formato', () => {
  const room = newEmergencyRoom();
  assert.match(room.code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.match(room.secret, /^[A-HJ-NP-Z2-9]{24}$/);
  const text = formatBackupCode(room.code, room.secret);
  assert.match(text, /^[A-Z2-9]{6}(-[A-Z2-9]{4}){6}$/);
  for (const variant of [text, text.toLowerCase(), text.replaceAll('-', ''), text.replaceAll('-', ' '), `  ${text}\n`, `Entra con ${text} por favor`.replace('Entra con ', '').replace(' por favor', '')]) {
    assert.deepEqual(parseBackupCode(variant), { ...room, roomId: null }, JSON.stringify(variant));
  }
});

test('codigo de respaldo de una sala del servidor: lleva el id de la sala para que las firmas coincidan', () => {
  const id = '9f1c2b3a-4d5e-4f60-8a7b-0c1d2e3f4a5b';
  const text = formatBackupCode('ABC234', 'KQ7MXT2PRN9WHJ4EC5VDB8YF', id);
  assert.match(text, /^ABC234(-[A-Z0-9]{4}){6}-R[0-9A-F]{8}(-[0-9A-F]{8}){3}$/);
  assert.deepEqual(parseBackupCode(text), { code: 'ABC234', secret: 'KQ7MXT2PRN9WHJ4EC5VDB8YF', roomId: id });
  assert.deepEqual(parseBackupCode(text.toLowerCase().replaceAll('-', ' ')), { code: 'ABC234', secret: 'KQ7MXT2PRN9WHJ4EC5VDB8YF', roomId: id });
  assert.equal(parseBackupCode(text.slice(0, -1)), null, 'id cortado');
  assert.equal(parseBackupCode(`${text}0`), null, 'sobra algo');
  assert.equal(formatBackupCode('ABC234', 'KQ7MXT2PRN9WHJ4EC5VDB8YF', 'no-es-un-id'), formatBackupCode('ABC234', 'KQ7MXT2PRN9WHJ4EC5VDB8YF'), 'un id invalido no se agrega');
});

test('codigo de respaldo: rechaza lo que no es', () => {
  for (const bad of ['', null, undefined, 'ABC234', 'ABC234-KQ7M-XT2P', 'ABC234KQ7MXT2PRN9WHJ4EC5VDB8YFX', 'ABC234KQ7MXT2PRN9WHJ4EC5VDB8Y0', 'ABC234KQ7MXT2PRN9WHJ4EC5VDB8YI']) {
    assert.equal(parseBackupCode(bad), null, String(bad));
  }
});

test('solo se comparte como codigo la clave que usa el alfabeto de los codigos', () => {
  assert.equal(shareableSecret('KQ7MXT2PRN9WHJ4EC5VDB8YF'), true);
  assert.equal(shareableSecret('kq7mxt2prn9whj4ec5vdb8yf'), true);
  assert.equal(shareableSecret('abc_def-ghi_jkl-mno_pqr-stu'), false);
  assert.equal(shareableSecret(null), false);
});

test('salas guardadas: por cuenta, con tope, vencimiento y sin romperse si no hay almacenamiento', () => {
  let now = 1_700_000_000_000;
  const st = memory();
  const v = new RoomVault(st, () => now);
  const e = (n) => ({ code: `AAAA${String(10 + n)}`.slice(0, 6), secret: `KQ7MXT2PRN9WHJ4EC5VDB8${String(10 + n)}`, name: `Sala ${n}` });
  v.put('user-1', { ...e(1), roomId: 'r1', ownerId: 'o1' });
  v.put('user-2', e(2));
  assert.equal(v.list('user-1').length, 1);
  assert.equal(v.get('user-1', e(1).code).roomId, 'r1');
  assert.equal(v.get('user-2', e(1).code), null, 'las claves de una cuenta no las ve otra');
  assert.equal(v.list('anon').length, 0);

  // actualizar conserva lo que ya se sabia y renueva el uso
  now += 1000;
  v.put('user-1', { code: e(1).code, secret: e(1).secret });
  assert.equal(v.get('user-1', e(1).code).roomId, 'r1');
  assert.equal(v.get('user-1', e(1).code).name, 'Sala 1');

  // tope: queda lo mas reciente
  for (let i = 0; i < VAULT_MAX + 6; i++) {
    now += 10;
    v.put('user-3', { code: `Q${String(100000 + i).slice(1)}`, secret: `KQ7MXT2PRN9WHJ4EC5VD${String(1000 + i)}` });
  }
  assert.equal(v.list('user-3').length, VAULT_MAX);
  assert.ok(v.list('user-3')[0].used >= v.list('user-3')[VAULT_MAX - 1].used);

  // vencimiento
  now += VAULT_TTL + 1;
  assert.equal(v.list('user-1').length, 0);

  // una clave mal formada no se guarda
  assert.equal(v.put('user-1', { code: 'ABC234', secret: 'corta' }), null);
  v.put('user-1', e(4));
  v.remove('user-1', e(4).code);
  assert.equal(v.get('user-1', e(4).code), null);

  // sin almacenamiento o con datos rotos
  const broken = new RoomVault({ getItem: () => '{no es json', setItem: () => { throw new Error('lleno'); } }, () => now);
  assert.deepEqual(broken.list('x'), []);
  assert.ok(broken.put('x', e(5)), 'guarda en memoria aunque no pueda escribir');
  assert.equal(new RoomVault(null, () => now).put('x', e(6)).code, e(6).code);
});

test('"el servidor no responde" se distingue de un error de la sala', () => {
  // red caida, pausado o con error de puerta de enlace: respaldo
  assert.equal(isOutage({ message: 'TypeError: Failed to fetch', code: '' }, 0), true);
  assert.equal(isOutage({ message: 'Failed to fetch' }), true);
  assert.equal(isOutage({ message: 'x', code: '' }, 503), true);
  assert.equal(isOutage({ message: 'x', code: '' }, 522), true);
  assert.equal(isOutage({ message: 'Failed to send a request to the Edge Function', name: 'FunctionsFetchError' }), true);
  assert.equal(isOutage({ name: 'VoiceTimeout', message: 'timeout' }), true);
  assert.equal(isOutage({ message: 'network request failed' }), true);
  // el servidor contesto: no es una caida
  assert.equal(isOutage({ message: 'permission denied', code: '42501' }, 403), false);
  assert.equal(isOutage({ message: 'function not found', code: 'PGRST202' }, 404), false);
  assert.equal(isOutage({ message: 'JWT expired', code: 'PGRST301' }, 401), false);
  assert.equal(isOutage({ message: 'raise exception', code: 'P0001' }, 400), false);
  assert.equal(isOutage({ message: 'algo raro', code: '' }, 400), false);
  assert.equal(isOutage(null), false);
  // un 500 con codigo de Postgres es una falla del servidor, tambien se trata como caida
  assert.equal(isOutage({ message: 'internal', code: 'XX000' }, 500), true);
});

test('STUN: dos proveedores distintos de entrada y mas alternativas para cuando no sale', () => {
  assert.ok(STUN_BASE.length >= 2);
  const hosts = (l) => new Set(l.map((u) => u.replace(/^stun:/, '').split(':')[0].split('.').slice(-2).join('.')));
  assert.ok(hosts(STUN_BASE).size >= 2, 'no todos del mismo proveedor');
  assert.deepEqual(stunServers(0), [{ urls: STUN_BASE }]);
  assert.deepEqual(stunServers(1)[0].urls, [...STUN_BASE, ...STUN_MORE]);
  assert.ok(STUN_MORE.length >= 3);
  assert.equal(new Set([...STUN_BASE, ...STUN_MORE]).size, STUN_BASE.length + STUN_MORE.length, 'sin repetidos');
});
