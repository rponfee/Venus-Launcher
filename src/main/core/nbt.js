'use strict';
// Lector/escritor de NBT (formato binario de Minecraft: level.dat, servers.dat, playerdata, chunks).
//   nbt.read(buffer)      -> { name, value } con valores JS simples (detecta gzip/zlib solo)
//   nbt.readFile(ruta)    -> igual, desde un archivo
//   nbt.parse(buffer)     -> igual que read pero sin descomprimir
//   nbt.readTyped(buffer) -> arbol con tipos ({ type, value }) para modificar y volver a escribir
//   nbt.write(raiz, { gzip }) -> Buffer, a partir de un arbol con tipos (ver builders T.*)
// Valores simples: Compound -> objeto, List -> array, Long -> BigInt, Byte/Int/Long_Array -> Int8Array/Int32Array/BigInt64Array.
const fs = require('fs/promises');
const zlib = require('zlib');

const TAG = { End: 0, Byte: 1, Short: 2, Int: 3, Long: 4, Float: 5, Double: 6, ByteArray: 7, String: 8, List: 9, Compound: 10, IntArray: 11, LongArray: 12 };

function decompress(buf) {
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) return zlib.gunzipSync(buf);
  if (buf.length > 2 && buf[0] === 0x78) return zlib.inflateSync(buf);
  return buf;
}

// UTF-8 modificado de Java (los caracteres fuera del BMP vienen como pares sustitutos de 3 bytes).
function decodeMutf8(buf, start, end) {
  let out = '';
  let units = [];
  let i = start;
  while (i < end) {
    const a = buf[i++];
    if (a < 0x80) units.push(a);
    else if ((a & 0xe0) === 0xc0) units.push(((a & 0x1f) << 6) | (buf[i++] & 0x3f));
    else {
      const b = buf[i++];
      const c = buf[i++];
      units.push(((a & 0x0f) << 12) | ((b & 0x3f) << 6) | (c & 0x3f));
    }
    if (units.length >= 4096) {
      out += String.fromCharCode(...units);
      units = [];
    }
  }
  return out + String.fromCharCode(...units);
}

function encodeMutf8(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c !== 0 && c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return Buffer.from(bytes);
}

class Reader {
  constructor(buf, typed) {
    this.buf = buf;
    this.pos = 0;
    this.typed = typed;
  }
  byte() {
    return this.buf.readInt8(this.pos++);
  }
  ubyte() {
    return this.buf[this.pos++];
  }
  short() {
    const v = this.buf.readInt16BE(this.pos);
    this.pos += 2;
    return v;
  }
  ushort() {
    const v = this.buf.readUInt16BE(this.pos);
    this.pos += 2;
    return v;
  }
  int() {
    const v = this.buf.readInt32BE(this.pos);
    this.pos += 4;
    return v;
  }
  long() {
    const v = this.buf.readBigInt64BE(this.pos);
    this.pos += 8;
    return v;
  }
  float() {
    const v = this.buf.readFloatBE(this.pos);
    this.pos += 4;
    return v;
  }
  double() {
    const v = this.buf.readDoubleBE(this.pos);
    this.pos += 8;
    return v;
  }
  string() {
    const len = this.ushort();
    const s = decodeMutf8(this.buf, this.pos, this.pos + len);
    this.pos += len;
    return s;
  }
  payload(type) {
    switch (type) {
      case TAG.Byte:
        return this.byte();
      case TAG.Short:
        return this.short();
      case TAG.Int:
        return this.int();
      case TAG.Long:
        return this.long();
      case TAG.Float:
        return this.float();
      case TAG.Double:
        return this.double();
      case TAG.ByteArray: {
        const len = this.int();
        const arr = new Int8Array(len);
        for (let i = 0; i < len; i++) arr[i] = this.byte();
        return arr;
      }
      case TAG.String:
        return this.string();
      case TAG.List: {
        const itemType = this.ubyte();
        const len = this.int();
        const items = new Array(Math.max(0, len));
        for (let i = 0; i < len; i++) items[i] = this.payload(itemType);
        return this.typed ? { itemType, items: items.map((v) => ({ type: itemType, value: v })) } : items;
      }
      case TAG.Compound: {
        const obj = {};
        for (;;) {
          const t = this.ubyte();
          if (t === TAG.End) break;
          const name = this.string();
          const v = this.payload(t);
          obj[name] = this.typed ? { type: t, value: v } : v;
        }
        return obj;
      }
      case TAG.IntArray: {
        const len = this.int();
        const arr = new Int32Array(len);
        for (let i = 0; i < len; i++) arr[i] = this.int();
        return arr;
      }
      case TAG.LongArray: {
        const len = this.int();
        const arr = new BigInt64Array(len);
        for (let i = 0; i < len; i++) arr[i] = this.long();
        return arr;
      }
      default:
        throw new Error(`NBT: tipo de etiqueta desconocido ${type} en ${this.pos}`);
    }
  }
  root() {
    const type = this.ubyte();
    if (type !== TAG.Compound) throw new Error('NBT: la raiz no es un Compound');
    const name = this.string();
    return { name, type, value: this.payload(type) };
  }
}

// En modo con tipos, los items de una lista quedan como { type, value }; el valor de la lista es { itemType, items }.
function parse(buf, { typed = false } = {}) {
  const r = new Reader(buf, typed);
  const root = r.root();
  return typed ? root : { name: root.name, value: root.value };
}

function read(buf) {
  return parse(decompress(buf));
}

function readTyped(buf) {
  return parse(decompress(buf), { typed: true });
}

async function readFile(file) {
  return read(await fs.readFile(file));
}

class Writer {
  constructor() {
    this.chunks = [];
  }
  push(b) {
    this.chunks.push(b);
  }
  num(type, v) {
    let b;
    switch (type) {
      case TAG.Byte:
        b = Buffer.alloc(1);
        b.writeInt8(Number(v));
        break;
      case TAG.Short:
        b = Buffer.alloc(2);
        b.writeInt16BE(Number(v));
        break;
      case TAG.Int:
        b = Buffer.alloc(4);
        b.writeInt32BE(Number(v));
        break;
      case TAG.Long:
        b = Buffer.alloc(8);
        b.writeBigInt64BE(BigInt(v));
        break;
      case TAG.Float:
        b = Buffer.alloc(4);
        b.writeFloatBE(Number(v));
        break;
      case TAG.Double:
        b = Buffer.alloc(8);
        b.writeDoubleBE(Number(v));
        break;
      default:
        throw new Error(`NBT: tipo numerico invalido ${type}`);
    }
    this.push(b);
  }
  string(s) {
    const enc = encodeMutf8(String(s));
    const len = Buffer.alloc(2);
    len.writeUInt16BE(enc.length);
    this.push(len);
    this.push(enc);
  }
  payload(type, value) {
    switch (type) {
      case TAG.Byte:
      case TAG.Short:
      case TAG.Int:
      case TAG.Long:
      case TAG.Float:
      case TAG.Double:
        return this.num(type, value);
      case TAG.String:
        return this.string(value);
      case TAG.ByteArray:
      case TAG.IntArray:
      case TAG.LongArray: {
        const itemType = type === TAG.ByteArray ? TAG.Byte : type === TAG.IntArray ? TAG.Int : TAG.Long;
        this.num(TAG.Int, value.length);
        for (const v of value) this.num(itemType, v);
        return undefined;
      }
      case TAG.List: {
        const items = value.items || [];
        const itemType = items.length ? value.itemType ?? items[0].type : value.itemType || TAG.End;
        this.push(Buffer.from([itemType]));
        this.num(TAG.Int, items.length);
        for (const it of items) this.payload(itemType, it.value);
        return undefined;
      }
      case TAG.Compound:
        for (const [name, tag] of Object.entries(value)) {
          if (!tag) continue;
          this.push(Buffer.from([tag.type]));
          this.string(name);
          this.payload(tag.type, tag.value);
        }
        this.push(Buffer.from([TAG.End]));
        return undefined;
      default:
        throw new Error(`NBT: no se puede escribir el tipo ${type}`);
    }
  }
}

function write(root, { gzip = false } = {}) {
  const w = new Writer();
  w.push(Buffer.from([TAG.Compound]));
  w.string(root.name || '');
  w.payload(TAG.Compound, root.value);
  const out = Buffer.concat(w.chunks);
  return gzip ? zlib.gzipSync(out) : out;
}

// Builders para armar arboles con tipos: T.compound({ ip: T.string('x'), hidden: T.byte(0) })
const T = {
  byte: (v) => ({ type: TAG.Byte, value: v }),
  short: (v) => ({ type: TAG.Short, value: v }),
  int: (v) => ({ type: TAG.Int, value: v }),
  long: (v) => ({ type: TAG.Long, value: BigInt(v) }),
  float: (v) => ({ type: TAG.Float, value: v }),
  double: (v) => ({ type: TAG.Double, value: v }),
  string: (v) => ({ type: TAG.String, value: String(v) }),
  list: (itemType, items) => ({ type: TAG.List, value: { itemType, items } }),
  compound: (obj) => ({ type: TAG.Compound, value: obj }),
  byteArray: (arr) => ({ type: TAG.ByteArray, value: Int8Array.from(arr) }),
  intArray: (arr) => ({ type: TAG.IntArray, value: Int32Array.from(arr) }),
  longArray: (arr) => ({ type: TAG.LongArray, value: BigInt64Array.from(arr, (x) => BigInt(x)) }),
};

module.exports = { TAG, T, read, readFile, readTyped, parse, write, decompress };
