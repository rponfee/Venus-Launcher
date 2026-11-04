// Numeros y semillas. Los valores de Java salen de java.util.Random y String.hashCode, documentados y faciles de repetir.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JavaRandom, Xoroshiro, javaHash, parseSeed, randomSeed, mul48, add48, bigToLimbs, rHi, rLo } from '../gen/rng.js';

test('String.hashCode de Java', () => {
  assert.equal(javaHash(''), 0);
  assert.equal(javaHash('a'), 97);
  assert.equal(javaHash('hello'), 99162322);
  assert.equal(javaHash('Hello World'), -862545276);
  // Unidades UTF-16: los acentos cuentan como un caracter y los emojis como dos
  assert.equal(javaHash('é'), 233);
  assert.equal(javaHash('😀'), 31 * 0xd83d + 0xde00);
});

test('una semilla se lee igual que en el juego', () => {
  assert.deepEqual(parseSeed('12345'), { seed: 12345n, fromText: false, text: '12345' });
  assert.equal(parseSeed('  -7  ').seed, -7n);
  assert.equal(parseSeed('+7').seed, 7n);
  assert.equal(parseSeed('9223372036854775807').seed, 9223372036854775807n);
  assert.equal(parseSeed('-9223372036854775808').seed, -9223372036854775808n);
  // Fuera de los 64 bits Long.parseLong falla: el juego usa el hash del texto
  const big = parseSeed('9223372036854775808');
  assert.equal(big.fromText, true);
  assert.equal(big.seed, BigInt(javaHash('9223372036854775808')));
  assert.equal(parseSeed('hello').seed, 99162322n);
  assert.equal(parseSeed('hello').fromText, true);
  assert.equal(parseSeed('1.5').fromText, true);
  assert.equal(parseSeed('   '), null);
  assert.equal(parseSeed(''), null);
});

test('la semilla al azar entra en 64 bits con signo', () => {
  for (let i = 0; i < 50; i++) {
    const s = randomSeed();
    assert.ok(s >= -(1n << 63n) && s < 1n << 63n);
  }
});

test('Random de Java da los numeros conocidos', () => {
  // new Random(42).nextInt(): -1170105035, 234785527, -1360544799, 205897768
  const r = new JavaRandom().setSeed(42n);
  assert.deepEqual([r.next32(), r.next32(), r.next32(), r.next32()], [-1170105035, 234785527, -1360544799, 205897768]);
  assert.equal(new JavaRandom().setSeed(0n).next32(), -1155484576);
  assert.equal(new JavaRandom().setSeed(0n).nextDouble(), 0.730967787376657);
  assert.equal(BigInt.asIntN(64, new JavaRandom().setSeed(42n).nextLong()), -5025562857975149833n);
  // nextInt(n) sale de esos mismos numeros: (x >>> 1) % n, o (n * (x >>> 1)) >> 31 si n es potencia de 2
  const ints = new JavaRandom().setSeed(42n);
  assert.deepEqual([0, 1, 2, 3].map(() => ints.nextInt(100)), [30, 63, 48, 84]);
  assert.equal(new JavaRandom().setSeed(42n).nextInt(16), 11);
});

// Referencia directa con BigInt: la misma definicion de Xoroshiro128++, sin los pares de 32 bits del port
function bigXoroshiro(seed) {
  const M = (1n << 64n) - 1n;
  const rot = (x, b) => ((x << b) | (x >> (64n - b))) & M;
  let l = (seed & M) ^ 0x6a09e667f3bcc909n;
  let h = (l + 0x9e3779b97f4a7c15n) & M;
  l = ((l ^ (l >> 30n)) * 0xbf58476d1ce4e5b9n) & M;
  h = ((h ^ (h >> 30n)) * 0xbf58476d1ce4e5b9n) & M;
  l = ((l ^ (l >> 27n)) * 0x94d049bb133111ebn) & M;
  h = ((h ^ (h >> 27n)) * 0x94d049bb133111ebn) & M;
  l ^= l >> 31n;
  h ^= h >> 31n;
  return () => {
    const n = (rot((l + h) & M, 17n) + l) & M;
    h ^= l;
    l = rot(l, 49n) ^ h ^ ((h << 21n) & M);
    h = rot(h, 28n);
    return n;
  };
}

test('Xoroshiro en pares de 32 bits coincide con la definicion en 64', () => {
  for (const seed of [0n, 1n, -1n, 123456789012345n, -8675309n]) {
    const ref = bigXoroshiro(seed);
    const xr = new Xoroshiro().setSeed(seed);
    for (let i = 0; i < 2000; i++) {
      xr.next();
      const got = (BigInt(xr.r1 >>> 0) << 32n) | BigInt(xr.r0 >>> 0);
      assert.equal(got, ref());
    }
  }
});

test('nextDouble de Xoroshiro usa los 53 bits altos', () => {
  const ref = bigXoroshiro(99n);
  const xr = new Xoroshiro().setSeed(99n);
  for (let i = 0; i < 500; i++) assert.equal(xr.nextDouble(), Number(ref() >> 11n) * 1.1102230246251565e-16);
});

test('cuentas de 48 bits', () => {
  const big = (hi, lo) => (BigInt(hi) << 24n) | BigInt(lo);
  const M = (1n << 48n) - 1n;
  for (const [a, k] of [[0x123456789abcn, 7], [0xfffffffffffen, -1], [341873128712n, -2147483648], [132897987541n, 2147483647], [1n, -12345]]) {
    bigToLimbs(a);
    mul48(rHi, rLo, k);
    assert.equal(big(rHi, rLo), (a * BigInt(k)) & M);
  }
  bigToLimbs(0xffffffffffffn);
  const hi = rHi;
  const lo = rLo;
  add48(hi, lo, 0, 2);
  assert.equal(big(rHi, rLo), 1n);
});
