// Ruido de Perlin por octavas, ruido doble y simplex 2D. Port de noise.c de cubiomes (MIT, ver LICENSE-cubiomes.txt).
// Los datos de las octavas van en arreglos tipados por grupo: es el codigo mas caliente del generador y aca no hay BigInt
// ni objetos por muestra.
import { Xoroshiro } from './rng.js';

// Mismos valores que indexedLerp() en cubiomes
function grad(idx, a, b, c) {
  switch (idx & 15) {
    case 0:
      return a + b;
    case 1:
      return -a + b;
    case 2:
      return a - b;
    case 3:
      return -a - b;
    case 4:
      return a + c;
    case 5:
      return -a + c;
    case 6:
      return a - c;
    case 7:
      return -a - c;
    case 8:
      return b + c;
    case 9:
      return -b + c;
    case 10:
      return b - c;
    case 11:
      return -b - c;
    case 12:
      return a + b;
    case 13:
      return -b + c;
    case 14:
      return -a + b;
    default:
      return -b - c;
  }
}

const PERM = 257;
// grad() en forma de tabla: en el codigo caliente evita los saltos mal predichos del switch (los indices son al azar) y da
// lo mismo salvo por el signo de un cero, que no cambia nada de lo que sigue
const GX = Float64Array.of(1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0, 1, 0, -1, 0);
const GY = Float64Array.of(1, 1, -1, -1, 0, 0, 0, 0, 1, -1, 1, -1, 1, -1, 1, -1);
const GZ = Float64Array.of(0, 0, 0, 0, 1, 1, -1, -1, 1, 1, -1, -1, 0, 1, 0, -1);

export class Octaves {
  constructor(n) {
    this.n = n;
    this.a = new Float64Array(n);
    this.b = new Float64Array(n);
    this.c = new Float64Array(n);
    this.amp = new Float64Array(n);
    this.lac = new Float64Array(n);
    this.d2 = new Float64Array(n);
    this.t2 = new Float64Array(n);
    this.h2 = new Uint8Array(n);
    this.perm = new Uint8Array(n * PERM);
  }

  // Comun a las dos formas de arrancar una octava: `rng` puede ser Xoroshiro o JavaRandom
  init(i, rng, amp, lac) {
    this.a[i] = rng.nextDouble() * 256;
    this.b[i] = rng.nextDouble() * 256;
    this.c[i] = rng.nextDouble() * 256;
    this.amp[i] = amp;
    this.lac[i] = lac;
    const base = i * PERM;
    const idx = this.perm;
    for (let k = 0; k < 256; k++) idx[base + k] = k;
    for (let k = 0; k < 256; k++) {
      const j = rng.nextInt(256 - k) + k;
      const v = idx[base + k];
      idx[base + k] = idx[base + j];
      idx[base + j] = v;
    }
    idx[base + 256] = idx[base];
    const i2 = Math.floor(this.b[i]);
    const d2 = this.b[i] - i2;
    this.h2[i] = i2;
    this.d2[i] = d2;
    this.t2[i] = d2 * d2 * d2 * (d2 * (d2 * 6 - 15) + 10);
  }
}

// sampleOctave() con samplePerlin() adentro
function sampleOctaves(o, x, y, z) {
  const { a, b, c, amp, lac, d2: D2, t2: T2, h2: H2, perm: p, n } = o;
  let v = 0;
  for (let i = 0; i < n; i++) {
    const lf = lac[i];
    let d1 = x * lf + a[i];
    let d2 = y * lf;
    let d3 = z * lf + c[i];
    let h2;
    let t2;
    if (d2 === 0) {
      d2 = D2[i];
      h2 = H2[i];
      t2 = T2[i];
    } else {
      d2 += b[i];
      const i2 = Math.floor(d2);
      d2 -= i2;
      h2 = i2 & 255;
      t2 = d2 * d2 * d2 * (d2 * (d2 * 6 - 15) + 10);
    }
    const i1 = Math.floor(d1);
    const i3 = Math.floor(d3);
    d1 -= i1;
    d3 -= i3;
    const h1 = i1 & 255;
    const h3 = i3 & 255;
    const t1 = d1 * d1 * d1 * (d1 * (d1 * 6 - 15) + 10);
    const t3 = d3 * d3 * d3 * (d3 * (d3 * 6 - 15) + 10);

    const base = i * PERM;
    const a1 = (p[base + h1] + h2) & 255;
    const b1 = (p[base + h1 + 1] + h2) & 255;
    const a2 = (p[base + a1] + h3) & 255;
    const b2 = (p[base + a1 + 1] + h3) & 255;
    const a3 = (p[base + b1] + h3) & 255;
    const b3 = (p[base + b1 + 1] + h3) & 255;

    const e1 = d1 - 1;
    const e2 = d2 - 1;
    const e3 = d3 - 1;
    let g = p[base + a2] & 15;
    let l1 = GX[g] * d1 + GY[g] * d2 + GZ[g] * d3;
    g = p[base + a2 + 1] & 15;
    let l5 = GX[g] * d1 + GY[g] * d2 + GZ[g] * e3;
    g = p[base + a3] & 15;
    const l2 = GX[g] * e1 + GY[g] * d2 + GZ[g] * d3;
    g = p[base + a3 + 1] & 15;
    const l6 = GX[g] * e1 + GY[g] * d2 + GZ[g] * e3;
    g = p[base + b2] & 15;
    let l3 = GX[g] * d1 + GY[g] * e2 + GZ[g] * d3;
    g = p[base + b2 + 1] & 15;
    let l7 = GX[g] * d1 + GY[g] * e2 + GZ[g] * e3;
    g = p[base + b3] & 15;
    const l4 = GX[g] * e1 + GY[g] * e2 + GZ[g] * d3;
    g = p[base + b3 + 1] & 15;
    const l8 = GX[g] * e1 + GY[g] * e2 + GZ[g] * e3;

    l1 += t1 * (l2 - l1);
    l3 += t1 * (l4 - l3);
    l5 += t1 * (l6 - l5);
    l7 += t1 * (l8 - l7);
    l1 += t2 * (l3 - l1);
    l5 += t2 * (l7 - l5);
    v += amp[i] * (l1 + t3 * (l5 - l1));
  }
  return v;
}

export class DoublePerlin {
  constructor(amplitude, octA, octB) {
    this.amplitude = amplitude;
    this.octA = octA;
    this.octB = octB;
  }
}

const DP_F = 337 / 331;

export function sampleDoublePerlin(n, x, y, z) {
  return (sampleOctaves(n.octA, x, y, z) + sampleOctaves(n.octB, x * DP_F, y * DP_F, z * DP_F)) * n.amplitude;
}

// ---------- Arranque 1.18+ (xDoublePerlinInit) ----------
const hexPair = (lo, hi) => [Number(BigInt.asIntN(32, lo)), Number(BigInt.asIntN(32, lo >> 32n)), Number(BigInt.asIntN(32, hi)), Number(BigInt.asIntN(32, hi >> 32n))];

// md5 de "octave_-12" ... "octave_0"
const MD5_OCTAVE = [
  [0xb198de63a8012672n, 0x7b84cad43ef7b5a8n],
  [0x0fd787bfbc403ec3n, 0x74a4a31ca21b48b8n],
  [0x36d326eed40efeb2n, 0x5be9ce18223c636an],
  [0x082fe255f8be6631n, 0x4e96119e22dedc81n],
  [0x0ef68ec68504005en, 0x48b6bf93a2789640n],
  [0xf11268128982754fn, 0x257a1d670430b0aan],
  [0xe51c98ce7d1de664n, 0x5f9478a733040c45n],
  [0x6d7b49e7e429850an, 0x2e3063c622a24777n],
  [0xbd90d5377ba1b762n, 0xc07317d419a7548dn],
  [0x53d39c6752dac858n, 0xbcd1c5a80ab65b3en],
  [0xb4a24d7a84e7677bn, 0x023ff9668e89b5c4n],
  [0xdffa22b534c5f608n, 0xb9b67517d3665ca9n],
  [0xd50708086cef4d7cn, 0x6e1651ecc7f43309n],
].map(([lo, hi]) => hexPair(lo, hi));

const PERSIST_INI = [0, 1, 2 / 3, 4 / 7, 8 / 15, 16 / 31, 32 / 63, 64 / 127, 128 / 255, 256 / 511];
const AMP_INI = [0, 5 / 6, 10 / 9, 15 / 12, 20 / 15, 25 / 18, 30 / 21, 35 / 24, 40 / 27, 45 / 30];

function xOctaves(xr, amps, omin, len) {
  let lacuna = 2 ** omin;
  let persist = PERSIST_INI[len];
  xr.next();
  const lo0 = xr.r0;
  const lo1 = xr.r1;
  xr.next();
  const hi0 = xr.r0;
  const hi1 = xr.r1;
  let count = 0;
  for (let i = 0; i < len; i++) if (amps[i] !== 0) count++;
  const o = new Octaves(count);
  const px = new Xoroshiro();
  let n = 0;
  for (let i = 0; i < len; i++, lacuna *= 2, persist *= 0.5) {
    if (amps[i] === 0) continue;
    const m = MD5_OCTAVE[12 + omin + i];
    px.set(lo0 ^ m[0], lo1 ^ m[1], hi0 ^ m[2], hi1 ^ m[3]);
    o.init(n, px, amps[i] * persist, lacuna);
    n++;
  }
  return o;
}

export function xDoublePerlin(xr, amps, omin) {
  const len = amps.length;
  const octA = xOctaves(xr, amps, omin, len);
  const octB = xOctaves(xr, amps, omin, len);
  // Las amplitudes en cero de las puntas no cuentan para la amplitud total
  let trimmed = len;
  for (let i = len - 1; i >= 0 && amps[i] === 0; i--) trimmed--;
  for (let i = 0; amps[i] === 0; i++) trimmed--;
  return new DoublePerlin(AMP_INI[trimmed], octA, octB);
}

// ---------- Arranque con Random de Java (Nether) ----------
function javaOctaves(rng, omin, len) {
  const end = omin + len - 1;
  let persist = 1 / (2 ** len - 1);
  let lacuna = 2 ** end;
  const o = new Octaves(len);
  // Las octavas de arriba de `end` igual consumen numeros
  rng.skip(-end * 262);
  for (let i = 0; i < len; i++) {
    o.init(i, rng, persist, lacuna);
    persist *= 2;
    lacuna *= 0.5;
  }
  return o;
}

export function javaDoublePerlin(rng, omin, len) {
  const amplitude = ((10 / 6) * len) / (len + 1);
  const octA = javaOctaves(rng, omin, len);
  const octB = javaOctaves(rng, omin, len);
  return new DoublePerlin(amplitude, octA, octB);
}

// ---------- Simplex 2D (islas del End) ----------
const SKEW = 0.5 * (Math.sqrt(3) - 1);
const UNSKEW = (3 - Math.sqrt(3)) / 6;

function simplexGrad(idx, x, y, d) {
  let con = d - x * x - y * y;
  if (con < 0) return 0;
  con *= con;
  return con * con * grad(idx, x, y, 0);
}

export function sampleSimplex2D(perm, x, y) {
  const hf = (x + y) * SKEW;
  const hx = Math.floor(x + hf);
  const hz = Math.floor(y + hf);
  const mhxz = (hx + hz) * UNSKEW;
  const x0 = x - (hx - mhxz);
  const y0 = y - (hz - mhxz);
  const offx = x0 > y0 ? 1 : 0;
  const offz = offx ? 0 : 1;
  const x1 = x0 - offx + UNSKEW;
  const y1 = y0 - offz + UNSKEW;
  const x2 = x0 - 1 + 2 * UNSKEW;
  const y2 = y0 - 1 + 2 * UNSKEW;
  let gi0 = perm[hz & 255];
  let gi1 = perm[(hz + offz) & 255];
  let gi2 = perm[(hz + 1) & 255];
  gi0 = perm[(gi0 + hx) & 255];
  gi1 = perm[(gi1 + hx + offx) & 255];
  gi2 = perm[(gi2 + hx + 1) & 255];
  let t = 0;
  t += simplexGrad(gi0 % 12, x0, y0, 0.5);
  t += simplexGrad(gi1 % 12, x1, y1, 0.5);
  t += simplexGrad(gi2 % 12, x2, y2, 0.5);
  return 70 * t;
}
