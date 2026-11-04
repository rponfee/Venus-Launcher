// Numeros del juego: Random de Java (48 bits), Xoroshiro128++ (1.18+) y como se lee una semilla escrita a mano.
// Port de rng.h de cubiomes (MIT, ver LICENSE-cubiomes.txt). Para que lo que corre muchas veces no use BigInt, el estado
// de 48 bits va en dos mitades de 24 bits (hi, lo) y el de 64 bits en pares de enteros de 32 bits. BigInt queda solo
// para preparar una semilla, que pasa una vez.

const TWO24 = 16777216;
const MASK24 = 0xffffff;
const TWO32 = 4294967296;
// 0x5deece66d partido en dos mitades
const K_HI = 0x5de;
const K_LO = 0xece66d;

// ---------- Semillas ----------
const MIN64 = -(1n << 63n);
const MAX64 = (1n << 63n) - 1n;

// String.hashCode() de Java: sobre unidades UTF-16 y con desborde de 32 bits
export function javaHash(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  return h;
}

// Igual que WorldOptions.parseSeed del juego: trim, Long.parseLong y, si no es un numero de 64 bits, hashCode del texto.
// Devuelve null si queda vacio (en el juego seria una semilla al azar).
// No cubre los digitos que no son ASCII que tambien acepta Long.parseLong (por ejemplo los arabigo-indicos).
export function parseSeed(text) {
  const clean = String(text ?? '').replace(/^[\0- ]+|[\0- ]+$/g, '');
  if (!clean) return null;
  if (/^[+-]?[0-9]+$/.test(clean)) {
    const negative = clean[0] === '-';
    const abs = BigInt(clean.replace(/^[+-]/, ''));
    const value = negative ? -abs : abs;
    if (value >= MIN64 && value <= MAX64) return { seed: value, fromText: false, text: clean };
  }
  return { seed: BigInt(javaHash(clean)), fromText: true, text: clean };
}

// Semilla al azar de 64 bits, ya con signo
export function randomSeed() {
  const buf = new BigUint64Array(1);
  crypto.getRandomValues(buf);
  return BigInt.asIntN(64, buf[0]);
}

// ---------- Cuentas de 48 bits ----------
// Devuelven el resultado en estas dos variables para no crear objetos en cada llamada
export let rHi = 0;
export let rLo = 0;

export function splitInt(v) {
  // Un entero de 32 bits con signo, extendido a 48 bits
  rHi = (v >> 24) & MASK24;
  rLo = v & MASK24;
}

export function mul48(hi, lo, k) {
  // (hi, lo) * k con k entero de 32 bits con signo, modulo 2^48
  const khi = (k >> 24) & MASK24;
  const klo = k & MASK24;
  const low = lo * klo;
  const carry = Math.floor(low / TWO24);
  const high = carry + lo * khi + hi * klo;
  rLo = low - carry * TWO24;
  rHi = high - Math.floor(high / TWO24) * TWO24;
}

export function add48(hi1, lo1, hi2, lo2) {
  const lo = lo1 + lo2;
  rLo = lo & MASK24;
  rHi = (hi1 + hi2 + (lo >= TWO24 ? 1 : 0)) & MASK24;
}

export function bigToLimbs(big) {
  const v = BigInt.asUintN(48, big);
  rHi = Number(v >> 24n);
  rLo = Number(v & 0xffffffn);
}

// ---------- Random de Java ----------
export class JavaRandom {
  constructor() {
    this.hi = 0;
    this.lo = 0;
  }

  // setSeed() con un valor de 48 bits ya partido
  setLimbs(hi, lo) {
    this.hi = hi ^ K_HI;
    this.lo = lo ^ K_LO;
    return this;
  }

  setSeed(big) {
    bigToLimbs(big);
    return this.setLimbs(rHi, rLo);
  }

  advance() {
    const low = this.lo * K_LO + 0xb;
    const carry = Math.floor(low / TWO24);
    const high = carry + this.lo * K_HI + this.hi * K_LO;
    this.lo = low - carry * TWO24;
    this.hi = high - Math.floor(high / TWO24) * TWO24;
  }

  skip(n) {
    for (let i = 0; i < n; i++) this.advance();
  }

  // Siempre entre 0 y 2^31-1
  next31() {
    this.advance();
    return this.hi * 128 + (this.lo >>> 17);
  }

  // Con signo, como el (int) de Java
  next32() {
    this.advance();
    return (this.hi * 256 + (this.lo >>> 16)) | 0;
  }

  // n siempre chico (hasta 2^21): el producto por 31 bits entra justo en un double
  nextInt(n) {
    const m = n - 1;
    if ((m & n) === 0) return Math.floor((n * this.next31()) / 2147483648);
    let bits;
    let val;
    do {
      bits = this.next31();
      val = bits % n;
    } while (((bits - val + m) | 0) < 0);
    return val;
  }

  nextDouble() {
    this.advance();
    const a = this.hi * 4 + (this.lo >>> 22);
    this.advance();
    const b = this.hi * 8 + (this.lo >>> 21);
    return (a * 134217728 + b) / 9007199254740992;
  }

  // Solo para preparar semillas: nextLong() de Java
  nextLong() {
    const a = this.next32();
    const b = this.next32();
    return BigInt.asUintN(64, (BigInt(a) << 32n) + BigInt(b));
  }
}

// ---------- Xoroshiro128++ ----------
const XL = 0x9e3779b97f4a7c15n;
const XH = 0x6a09e667f3bcc909n;
const XA = 0xbf58476d1ce4e5b9n;
const XB = 0x94d049bb133111ebn;
const U64 = (v) => BigInt.asUintN(64, v);

export class Xoroshiro {
  constructor() {
    // lo = (l1, l0), hi = (h1, h0); el ultimo numero sacado queda en (r1, r0)
    this.l0 = 0;
    this.l1 = 0;
    this.h0 = 0;
    this.h1 = 0;
    this.r0 = 0;
    this.r1 = 0;
  }

  set(l0, l1, h0, h1) {
    this.l0 = l0 | 0;
    this.l1 = l1 | 0;
    this.h0 = h0 | 0;
    this.h1 = h1 | 0;
    return this;
  }

  setSeed(big) {
    let l = U64(U64(big) ^ XH);
    let h = U64(l + XL);
    l = U64((l ^ (l >> 30n)) * XA);
    h = U64((h ^ (h >> 30n)) * XA);
    l = U64((l ^ (l >> 27n)) * XB);
    h = U64((h ^ (h >> 27n)) * XB);
    l ^= l >> 31n;
    h ^= h >> 31n;
    return this.set(Number(BigInt.asIntN(32, l)), Number(BigInt.asIntN(32, l >> 32n)), Number(BigInt.asIntN(32, h)), Number(BigInt.asIntN(32, h >> 32n)));
  }

  next() {
    const l0 = this.l0;
    const l1 = this.l1;
    const h0 = this.h0;
    const h1 = this.h1;
    // n = rotl(l + h, 17) + l
    let sum = (l0 >>> 0) + (h0 >>> 0);
    const a0 = sum | 0;
    const a1 = (l1 + h1 + (sum >= TWO32 ? 1 : 0)) | 0;
    const b0 = (a0 << 17) | (a1 >>> 15);
    const b1 = (a1 << 17) | (a0 >>> 15);
    sum = (b0 >>> 0) + (l0 >>> 0);
    this.r0 = sum | 0;
    this.r1 = (b1 + l1 + (sum >= TWO32 ? 1 : 0)) | 0;
    // h ^= l; lo = rotl(l, 49) ^ h ^ (h << 21); hi = rotl(h, 28)
    const x0 = h0 ^ l0;
    const x1 = h1 ^ l1;
    this.l0 = ((l1 << 17) | (l0 >>> 15)) ^ x0 ^ (x0 << 21);
    this.l1 = ((l0 << 17) | (l1 >>> 15)) ^ x1 ^ ((x1 << 21) | (x0 >>> 11));
    this.h0 = (x0 << 28) | (x1 >>> 4);
    this.h1 = (x1 << 28) | (x0 >>> 4);
  }

  nextDouble() {
    this.next();
    return ((this.r1 >>> 0) * 2097152 + (this.r0 >>> 11)) * 1.1102230246251565e-16;
  }

  // n chico (hasta 256): el producto de 32 bits por n entra en un double
  nextInt(n) {
    this.next();
    let r = (this.r0 >>> 0) * n;
    let low = r % TWO32;
    if (low < n) {
      const limit = (TWO32 - n) % n;
      while (low < limit) {
        this.next();
        r = (this.r0 >>> 0) * n;
        low = r % TWO32;
      }
    }
    return Math.floor(r / TWO32);
  }
}
