'use strict';
// El QR se decodifica de vuelta con un lector independiente, escrito acá a partir de la norma: formato, máscara,
// corrección Reed-Solomon (síndromes en cero) y contenido.
const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeQr, MAX_VERSION } = require('../qr');

// ---------- Lector ----------
const EXP = new Array(512);
const LOG = new Array(256).fill(0);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x = (x << 1) ^ (x & 0x80 ? 0x11d : 0);
    x &= 0xff;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

// Las mismas tablas de la norma, copiadas aparte del codificador a propósito
const TABLE_M = { 1: [10, 1], 2: [16, 1], 3: [26, 1], 4: [18, 2], 5: [24, 2], 6: [16, 4], 7: [18, 4], 8: [22, 4], 9: [22, 5], 10: [26, 5] };
const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };

function functionMask(size, version) {
  const f = Array.from({ length: size }, () => new Array(size).fill(false));
  const box = (x0, y0, x1, y1) => {
    for (let y = Math.max(0, y0); y <= Math.min(size - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(size - 1, x1); x++) f[y][x] = true;
  };
  box(0, 0, 8, 8);
  box(size - 8, 0, size - 1, 8);
  box(0, size - 8, 8, size - 1);
  box(6, 0, 6, size - 1);
  box(0, 6, size - 1, 6);
  const pos = ALIGN[version];
  for (const ax of pos) {
    for (const ay of pos) {
      if ((ax === 6 && ay === 6) || (ax === 6 && ay === pos.at(-1)) || (ax === pos.at(-1) && ay === 6)) continue;
      box(ax - 2, ay - 2, ax + 2, ay + 2);
    }
  }
  if (version >= 7) {
    box(size - 11, 0, size - 9, 5);
    box(0, size - 11, 5, size - 9);
  }
  return f;
}

const MASK_FN = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function readFormat(get, size) {
  let a = 0;
  // Primera copia (bit 14 primero), alrededor del buscador de arriba a la izquierda
  const first = [[0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [7, 8], [8, 8], [8, 7], [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0]];
  for (const [x, y] of first) a = (a << 1) | get(x, y);
  let b = 0;
  const second = [];
  for (let i = 0; i < 7; i++) second.push([8, size - 1 - i]);
  for (let i = 0; i < 8; i++) second.push([size - 8 + i, 8]);
  for (const [x, y] of second) b = (b << 1) | get(x, y);
  return { a: a ^ 0x5412, b: b ^ 0x5412 };
}

function decode({ size, rows }) {
  const version = (size - 17) / 4;
  assert.ok(Number.isInteger(version) && version >= 1 && version <= MAX_VERSION, `versión ${version}`);
  const get = (x, y) => (rows[y][x] === '1' ? 1 : 0);
  const { a, b } = readFormat(get, size);
  assert.equal(a, b, 'las dos copias del formato coinciden');
  assert.equal(a >>> 13, 0, 'corrección M');
  const mask = (a >>> 10) & 7;
  // BCH(15,5) del formato
  let rem = a >>> 10;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  assert.equal(((a >>> 10) << 10) | rem, a, 'BCH del formato');
  // Módulo siempre oscuro
  assert.equal(get(8, size - 8), 1);
  // Buscadores y línea de sincronismo
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    assert.equal(get(cx, cy), 1);
    assert.equal(get(cx - 2, cy), 0);
    assert.equal(get(cx - 3, cy), 1);
  }
  for (let i = 8; i < size - 8; i++) {
    assert.equal(get(i, 6), i % 2 === 0 ? 1 : 0);
    assert.equal(get(6, i), i % 2 === 0 ? 1 : 0);
  }
  // Información de versión (v7 en adelante): BCH(18,6)
  if (version >= 7) {
    let bits = 0;
    for (let i = 17; i >= 0; i--) bits = (bits << 1) | get(size - 11 + (i % 3), Math.floor(i / 3));
    assert.equal(bits >>> 12, version);
    let r = version;
    for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
    assert.equal((version << 12) | r, bits);
  }
  // Zigzag: junta los bits sin la máscara
  const fn = functionMask(size, version);
  const bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < size; v++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - v : v;
        if (!fn[y][x]) bits.push(get(x, y) ^ (MASK_FN[mask](x, y) ? 1 : 0));
      }
    }
  }
  const raw = Math.floor(bits.length / 8);
  const codewords = [];
  for (let i = 0; i < raw; i++) codewords.push(bits.slice(i * 8, i * 8 + 8).reduce((acc, v) => (acc << 1) | v, 0));
  // Desintercala los bloques y verifica los síndromes
  const [ecc, blocks] = TABLE_M[version];
  const shortBlocks = blocks - (raw % blocks);
  const shortLen = Math.floor(raw / blocks) - ecc;
  const data = Array.from({ length: blocks }, () => []);
  const parity = Array.from({ length: blocks }, () => []);
  let at = 0;
  for (let i = 0; i <= shortLen; i++) {
    for (let k = 0; k < blocks; k++) {
      if (i < shortLen || k >= shortBlocks) data[k].push(codewords[at++]);
    }
  }
  for (let i = 0; i < ecc; i++) for (let k = 0; k < blocks; k++) parity[k].push(codewords[at++]);
  assert.equal(at, raw);
  for (let k = 0; k < blocks; k++) {
    const block = [...data[k], ...parity[k]];
    for (let s = 0; s < ecc; s++) {
      let syndrome = 0;
      for (const c of block) syndrome = mul(syndrome, EXP[s]) ^ c;
      assert.equal(syndrome, 0, `síndrome ${s} del bloque ${k}`);
    }
  }
  // Contenido: modo byte
  const stream = data.flat();
  const dataBits = [];
  for (const c of stream) for (let i = 7; i >= 0; i--) dataBits.push((c >>> i) & 1);
  const read = (from, len) => dataBits.slice(from, from + len).reduce((acc, v) => (acc << 1) | v, 0);
  assert.equal(read(0, 4), 0b0100, 'modo byte');
  const countBits = version < 10 ? 8 : 16;
  const len = read(4, countBits);
  const out = [];
  for (let i = 0; i < len; i++) out.push(read(4 + countBits + i * 8, 8));
  return { text: Buffer.from(out).toString('utf8'), version, mask };
}

test('se lee de vuelta: una dirección típica del control remoto', () => {
  const url = 'http://192.168.0.154:49817/#t=0123456789ABCDEFGHJKMNPQRSTV';
  const qr = encodeQr(url);
  const res = decode(qr);
  assert.equal(res.text, url);
  assert.equal(qr.rows.length, qr.size);
  assert.ok(qr.rows.every((r) => r.length === qr.size && /^[01]+$/.test(r)));
});

test('todos los largos que caben en cada versión, hasta la 10', () => {
  for (let len = 1; len <= 213; len += 3) {
    const text = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.repeat(7).slice(0, len);
    const qr = encodeQr(text);
    assert.equal(decode(qr).text, text, `largo ${len}`);
  }
});

test('texto con UTF-8', () => {
  assert.equal(decode(encodeQr('Hola, ¿qué tal? ñandú')).text, 'Hola, ¿qué tal? ñandú');
});

test('usa la versión más chica y más texto agranda el código', () => {
  assert.equal(decode(encodeQr('x'.repeat(14))).version, 1);
  assert.equal(decode(encodeQr('x'.repeat(15))).version, 2);
  assert.equal(decode(encodeQr('x'.repeat(60))).version, 4);
  assert.equal(decode(encodeQr('x'.repeat(213))).version, 10);
});

test('más de lo que entra lanza un error en lugar de dibujar algo ilegible', () => {
  assert.throws(() => encodeQr('x'.repeat(214)), /demasiado largo/);
});

test('elige distintas máscaras según el contenido', () => {
  const masks = new Set();
  for (let i = 0; i < 80; i++) masks.add(decode(encodeQr(`http://10.0.0.${i}:50000/#t=ABCDEFGHJKMNPQRSTVWXYZ012345`)).mask);
  assert.ok(masks.size >= 3, `máscaras usadas: ${[...masks]}`);
});
