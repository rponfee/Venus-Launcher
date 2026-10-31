'use strict';
// Huella de archivos de CurseForge: MurmurHash2 de 32 bits con semilla 1 sobre el contenido del archivo
// sin los bytes de espacio en blanco (9, 10, 13 y 32). Es lo que usa la API en /v1/fingerprints.
const fs = require('fs');

const M = 0x5bd1e995;
const WHITESPACE = new Uint8Array(256);
for (const b of [9, 10, 13, 32]) WHITESPACE[b] = 1;

// Estado incremental: hace falta conocer el largo total (ya filtrado) antes de empezar.
class Murmur2 {
  constructor(length, seed = 1) {
    this.h = (seed ^ length) >>> 0;
    this.tail = [];
  }

  // bytes ya filtrados
  update(bytes) {
    let i = 0;
    let h = this.h;
    if (this.tail.length) {
      while (this.tail.length < 4 && i < bytes.length) this.tail.push(bytes[i++]);
      if (this.tail.length < 4) return this;
      h = mix(h, this.tail[0] | (this.tail[1] << 8) | (this.tail[2] << 16) | (this.tail[3] << 24));
      this.tail = [];
    }
    const end = bytes.length - ((bytes.length - i) % 4);
    for (; i < end; i += 4) h = mix(h, bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24));
    for (; i < bytes.length; i++) this.tail.push(bytes[i]);
    this.h = h;
    return this;
  }

  digest() {
    let h = this.h;
    const tail = this.tail;
    switch (tail.length) {
      case 3:
        h ^= tail[2] << 16;
      // falls through
      case 2:
        h ^= tail[1] << 8;
      // falls through
      case 1:
        h ^= tail[0];
        h = Math.imul(h, M);
    }
    h ^= h >>> 13;
    h = Math.imul(h, M);
    h ^= h >>> 15;
    return h >>> 0;
  }
}

function mix(h, k) {
  k = Math.imul(k, M);
  k ^= k >>> 24;
  k = Math.imul(k, M);
  return (Math.imul(h, M) ^ k) >>> 0;
}

// MurmurHash2 clasico (sin filtrar) sobre un buffer.
function murmur2(buffer, seed = 1) {
  return new Murmur2(buffer.length, seed).update(buffer).digest();
}

function filterWhitespace(buffer) {
  const out = Buffer.allocUnsafe(buffer.length);
  let n = 0;
  for (let i = 0; i < buffer.length; i++) {
    const b = buffer[i];
    if (!WHITESPACE[b]) out[n++] = b;
  }
  return out.subarray(0, n);
}

function countNonWhitespace(buffer) {
  let n = 0;
  for (let i = 0; i < buffer.length; i++) if (!WHITESPACE[buffer[i]]) n++;
  return n;
}

// Huella de CurseForge para un buffer (Buffer o Uint8Array).
function computeFingerprint(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  return murmur2(filterWhitespace(buf), 1);
}

// Huella de un archivo sin cargarlo entero en memoria (dos pasadas: largo filtrado y hash).
async function fingerprintFile(file) {
  let length = 0;
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 20 })) length += countNonWhitespace(chunk);
  const state = new Murmur2(length, 1);
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 20 })) state.update(filterWhitespace(chunk));
  return state.digest();
}

module.exports = { computeFingerprint, fingerprintFile, murmur2 };
