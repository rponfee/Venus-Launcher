'use strict';
// Lector de archivos .class de Java (JVMS cap. 4): constant pool, banderas de acceso, this/super,
// interfaces, campos, métodos y atributos (Code, anotaciones visibles e invisibles con todos los tipos
// de valor, anotaciones de parámetros, AnnotationDefault, Signature, SourceFile, InnerClasses,
// BootstrapMethods...). También decodifica bytecode para el análisis de seguridad.
// Es tolerante: un atributo roto no impide leer el resto (el malware a veces daña atributos a propósito
// para trabar a los analizadores). Los errores fatales lanzan ClassFormatError.

class ClassFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ClassFormatError';
  }
}

const TAG = {
  Utf8: 1,
  Integer: 3,
  Float: 4,
  Long: 5,
  Double: 6,
  Class: 7,
  String: 8,
  Fieldref: 9,
  Methodref: 10,
  InterfaceMethodref: 11,
  NameAndType: 12,
  MethodHandle: 15,
  MethodType: 16,
  Dynamic: 17,
  InvokeDynamic: 18,
  Module: 19,
  Package: 20,
};

const ACC = {
  PUBLIC: 0x0001,
  PRIVATE: 0x0002,
  PROTECTED: 0x0004,
  STATIC: 0x0008,
  FINAL: 0x0010,
  SUPER: 0x0020,
  SYNCHRONIZED: 0x0020,
  VOLATILE: 0x0040,
  BRIDGE: 0x0040,
  TRANSIENT: 0x0080,
  VARARGS: 0x0080,
  NATIVE: 0x0100,
  INTERFACE: 0x0200,
  ABSTRACT: 0x0400,
  STRICT: 0x0800,
  SYNTHETIC: 0x1000,
  ANNOTATION: 0x2000,
  ENUM: 0x4000,
  MODULE: 0x8000,
};

// ---------- Lectura con control de limites ----------

class Reader {
  constructor(buf, pos = 0, end = buf.length) {
    this.buf = buf;
    this.pos = pos;
    this.end = end;
  }

  need(n) {
    if (this.pos + n > this.end) throw new ClassFormatError(`Fin inesperado (pos ${this.pos}, faltan ${n} bytes)`);
  }

  u1() {
    this.need(1);
    return this.buf[this.pos++];
  }

  u2() {
    this.need(2);
    const v = (this.buf[this.pos] << 8) | this.buf[this.pos + 1];
    this.pos += 2;
    return v;
  }

  u4() {
    this.need(4);
    const v = this.buf.readUInt32BE(this.pos);
    this.pos += 4;
    return v;
  }

  s4() {
    this.need(4);
    const v = this.buf.readInt32BE(this.pos);
    this.pos += 4;
    return v;
  }

  bytes(n) {
    this.need(n);
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  skip(n) {
    this.need(n);
    this.pos += n;
  }
}

// UTF-8 modificado de la JVM: el 0 va como C0 80 y los caracteres suplementarios como pares sustitutos.
function decodeModifiedUtf8(buf, start, end) {
  let ascii = true;
  for (let i = start; i < end; i++) {
    if (buf[i] & 0x80 || buf[i] === 0) {
      ascii = false;
      break;
    }
  }
  if (ascii) return buf.latin1Slice ? buf.latin1Slice(start, end) : buf.toString('latin1', start, end);
  const units = [];
  let out = '';
  let i = start;
  while (i < end) {
    const a = buf[i++];
    if (a < 0x80) units.push(a);
    else if ((a & 0xe0) === 0xc0 && i < end) {
      const b = buf[i++];
      units.push(((a & 0x1f) << 6) | (b & 0x3f));
    } else if ((a & 0xf0) === 0xe0 && i + 1 < end) {
      const b = buf[i++];
      const c = buf[i++];
      units.push(((a & 0x0f) << 12) | ((b & 0x3f) << 6) | (c & 0x3f));
    } else {
      units.push(0xfffd); // byte invalido: se reemplaza y se sigue
    }
    if (units.length >= 8192) {
      out += String.fromCharCode.apply(null, units);
      units.length = 0;
    }
  }
  return out + String.fromCharCode.apply(null, units);
}

// ---------- Constant pool ----------

class ConstantPool {
  constructor(count) {
    this.count = count;
    this.tags = new Uint8Array(count);
    this.a = new Int32Array(count); // primer indice / valor entero
    this.b = new Int32Array(count); // segundo indice
    this.vals = new Array(count); // Utf8 decodificado, numeros, long/double
  }

  tag(i) {
    return i > 0 && i < this.count ? this.tags[i] : 0;
  }

  check(i, tag) {
    if (this.tag(i) !== tag) throw new ClassFormatError(`Índice ${i} del constant pool inválido`);
  }

  utf8(i) {
    this.check(i, TAG.Utf8);
    return this.vals[i];
  }

  // Version que no lanza (para atributos dañados).
  utf8Safe(i) {
    return this.tag(i) === TAG.Utf8 ? this.vals[i] : null;
  }

  className(i) {
    this.check(i, TAG.Class);
    return this.utf8(this.a[i]);
  }

  string(i) {
    this.check(i, TAG.String);
    return this.utf8(this.a[i]);
  }

  nameAndType(i) {
    this.check(i, TAG.NameAndType);
    return { name: this.utf8(this.a[i]), desc: this.utf8(this.b[i]) };
  }

  // Fieldref / Methodref / InterfaceMethodref -> { kind, owner, name, desc }
  ref(i) {
    const tag = this.tag(i);
    if (tag !== TAG.Fieldref && tag !== TAG.Methodref && tag !== TAG.InterfaceMethodref) throw new ClassFormatError(`Índice ${i} no es una referencia`);
    const nt = this.nameAndType(this.b[i]);
    const kind = tag === TAG.Fieldref ? 'field' : tag === TAG.Methodref ? 'method' : 'imethod';
    return { kind, owner: this.className(this.a[i]), name: nt.name, desc: nt.desc };
  }

  // Valor de ldc / ConstantValue: string, numero, bigint, { class }, { methodType }, { handle }, { dynamic }
  value(i) {
    switch (this.tag(i)) {
      case TAG.String:
        return this.string(i);
      case TAG.Integer:
        return this.a[i];
      case TAG.Float:
      case TAG.Long:
      case TAG.Double:
        return this.vals[i];
      case TAG.Class:
        return { class: this.className(i) };
      case TAG.MethodType:
        return { methodType: this.utf8(this.a[i]) };
      case TAG.MethodHandle:
        return { handle: this.a[i], ref: this.ref(this.b[i]) };
      case TAG.Dynamic:
        return { dynamic: this.nameAndType(this.b[i]), bootstrap: this.a[i] };
      default:
        throw new ClassFormatError(`Constante ${i} sin valor`);
    }
  }

  // Todos los textos (CONSTANT_String) del pool.
  strings() {
    const out = [];
    for (let i = 1; i < this.count; i++) if (this.tags[i] === TAG.String && this.tags[this.a[i]] === TAG.Utf8) out.push(this.vals[this.a[i]]);
    return out;
  }

  // Todas las entradas Utf8 (nombres, descriptores, textos, valores de anotaciones).
  utf8s() {
    const out = [];
    for (let i = 1; i < this.count; i++) if (this.tags[i] === TAG.Utf8) out.push(this.vals[i]);
    return out;
  }

  classes() {
    const out = [];
    for (let i = 1; i < this.count; i++) {
      if (this.tags[i] === TAG.Class && this.tags[this.a[i]] === TAG.Utf8) out.push(this.vals[this.a[i]]);
    }
    return out;
  }

  // Referencias a métodos y campos de otras clases (las usa el análisis de APIs).
  refs() {
    const out = [];
    for (let i = 1; i < this.count; i++) {
      const tag = this.tags[i];
      if (tag === TAG.Fieldref || tag === TAG.Methodref || tag === TAG.InterfaceMethodref) {
        try {
          out.push(this.ref(i));
        } catch {
          /* referencia rota: se ignora */
        }
      }
    }
    return out;
  }
}

function readConstantPool(r) {
  const count = r.u2();
  if (count === 0) throw new ClassFormatError('Constant pool vacío');
  const cp = new ConstantPool(count);
  for (let i = 1; i < count; i++) {
    const tag = r.u1();
    cp.tags[i] = tag;
    switch (tag) {
      case TAG.Utf8: {
        const len = r.u2();
        r.need(len);
        cp.vals[i] = decodeModifiedUtf8(r.buf, r.pos, r.pos + len);
        r.pos += len;
        break;
      }
      case TAG.Integer:
        r.need(4);
        cp.a[i] = r.buf.readInt32BE(r.pos);
        r.pos += 4;
        break;
      case TAG.Float:
        r.need(4);
        cp.vals[i] = r.buf.readFloatBE(r.pos);
        r.pos += 4;
        break;
      case TAG.Long: {
        r.need(8);
        const v = r.buf.readBigInt64BE(r.pos);
        cp.vals[i] = v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
        r.pos += 8;
        i++; // ocupa dos lugares
        if (i < count) cp.tags[i] = 0;
        break;
      }
      case TAG.Double:
        r.need(8);
        cp.vals[i] = r.buf.readDoubleBE(r.pos);
        r.pos += 8;
        i++;
        if (i < count) cp.tags[i] = 0;
        break;
      case TAG.Class:
      case TAG.String:
      case TAG.MethodType:
      case TAG.Module:
      case TAG.Package:
        cp.a[i] = r.u2();
        break;
      case TAG.Fieldref:
      case TAG.Methodref:
      case TAG.InterfaceMethodref:
      case TAG.NameAndType:
      case TAG.Dynamic:
      case TAG.InvokeDynamic:
        cp.a[i] = r.u2();
        cp.b[i] = r.u2();
        break;
      case TAG.MethodHandle:
        cp.a[i] = r.u1(); // reference_kind
        cp.b[i] = r.u2();
        break;
      default:
        throw new ClassFormatError(`Etiqueta de constante desconocida ${tag} en el índice ${i}`);
    }
  }
  return cp;
}

// ---------- Anotaciones ----------
// Valores tipados: { tag, value } para constantes (B C D F I J S Z s), { tag: 'e', type, name } para enums,
// { tag: 'c', desc } para clases, { tag: '@', annotation } y { tag: '[', values: [...] }.

function readElementValue(r, cp, depth = 0) {
  if (depth > 32) throw new ClassFormatError('Anotación demasiado anidada');
  const tag = String.fromCharCode(r.u1());
  switch (tag) {
    case 'B':
    case 'C':
    case 'I':
    case 'S':
    case 'Z': {
      const idx = r.u2();
      if (cp.tag(idx) !== TAG.Integer) throw new ClassFormatError('Valor de anotación inválido');
      const n = cp.a[idx];
      const value = tag === 'Z' ? n !== 0 : tag === 'C' ? String.fromCharCode(n) : n;
      return { tag, value };
    }
    case 'D':
    case 'F':
    case 'J':
      return { tag, value: cp.vals[r.u2()] };
    case 's':
      return { tag, value: cp.utf8(r.u2()) };
    case 'e': {
      const type = cp.utf8(r.u2());
      const name = cp.utf8(r.u2());
      return { tag, type, name };
    }
    case 'c':
      return { tag, desc: cp.utf8(r.u2()) };
    case '@':
      return { tag, annotation: readAnnotation(r, cp, depth + 1) };
    case '[': {
      const n = r.u2();
      const values = [];
      for (let i = 0; i < n; i++) values.push(readElementValue(r, cp, depth + 1));
      return { tag, values };
    }
    default:
      throw new ClassFormatError(`Tipo de valor de anotación desconocido '${tag}'`);
  }
}

function readAnnotation(r, cp, depth = 0) {
  const type = cp.utf8(r.u2());
  const n = r.u2();
  const values = {};
  for (let i = 0; i < n; i++) {
    const name = cp.utf8(r.u2());
    values[name] = readElementValue(r, cp, depth);
  }
  return { type, values };
}

function readAnnotations(r, cp) {
  const n = r.u2();
  const out = [];
  for (let i = 0; i < n; i++) out.push(readAnnotation(r, cp));
  return out;
}

function readParameterAnnotations(r, cp) {
  const n = r.u1();
  const out = [];
  for (let i = 0; i < n; i++) out.push(readAnnotations(r, cp));
  return out;
}

// Convierte un valor tipado a JS simple: enums -> { enum, value }, clases -> { class }, anotaciones -> { annotation, values }.
function plain(ev) {
  if (!ev) return undefined;
  switch (ev.tag) {
    case 'e':
      return { enum: ev.type, value: ev.name };
    case 'c':
      return { class: ev.desc };
    case '@':
      return plainAnnotation(ev.annotation);
    case '[':
      return ev.values.map(plain);
    default:
      return typeof ev.value === 'bigint' ? ev.value.toString() : ev.value;
  }
}

function plainAnnotation(ann) {
  const values = {};
  for (const [k, v] of Object.entries(ann.values)) values[k] = plain(v);
  return { annotation: ann.type, values };
}

// ---------- Atributos ----------

function readAttributes(r, cp, owner, errors) {
  const count = r.u2();
  const attrs = {};
  for (let i = 0; i < count; i++) {
    const nameIdx = r.u2();
    const len = r.u4();
    const start = r.pos;
    r.need(len);
    const end = start + len;
    const name = cp.utf8Safe(nameIdx);
    const sub = new Reader(r.buf, start, end);
    try {
      readAttribute(name, sub, cp, attrs, owner, errors);
    } catch (err) {
      errors.push(`${owner}: atributo ${name || nameIdx} dañado (${err.message})`);
    }
    r.pos = end;
  }
  return attrs;
}

function readAttribute(name, r, cp, attrs, owner, errors) {
  switch (name) {
    case 'Code': {
      const maxStack = r.u2();
      const maxLocals = r.u2();
      const len = r.u4();
      const code = r.bytes(len);
      const n = r.u2();
      const handlers = [];
      for (let i = 0; i < n; i++) {
        const startPc = r.u2();
        const endPc = r.u2();
        const handlerPc = r.u2();
        const typeIdx = r.u2();
        handlers.push({ startPc, endPc, handlerPc, type: typeIdx ? cp.className(typeIdx) : null });
      }
      const sub = readAttributes(r, cp, `${owner}.Code`, errors);
      attrs.code = { maxStack, maxLocals, code, handlers, attrs: sub };
      break;
    }
    case 'RuntimeVisibleAnnotations':
      attrs.visible = readAnnotations(r, cp);
      break;
    case 'RuntimeInvisibleAnnotations':
      attrs.invisible = readAnnotations(r, cp);
      break;
    case 'RuntimeVisibleParameterAnnotations':
      attrs.paramVisible = readParameterAnnotations(r, cp);
      break;
    case 'RuntimeInvisibleParameterAnnotations':
      attrs.paramInvisible = readParameterAnnotations(r, cp);
      break;
    case 'AnnotationDefault':
      attrs.annotationDefault = readElementValue(r, cp);
      break;
    case 'Signature':
      attrs.signature = cp.utf8(r.u2());
      break;
    case 'SourceFile':
      attrs.sourceFile = cp.utf8(r.u2());
      break;
    case 'ConstantValue':
      attrs.constantValue = cp.value(r.u2());
      break;
    case 'Exceptions': {
      const n = r.u2();
      attrs.exceptions = [];
      for (let i = 0; i < n; i++) attrs.exceptions.push(cp.className(r.u2()));
      break;
    }
    case 'InnerClasses': {
      const n = r.u2();
      attrs.innerClasses = [];
      for (let i = 0; i < n; i++) {
        const inner = r.u2();
        const outer = r.u2();
        const innerName = r.u2();
        const access = r.u2();
        attrs.innerClasses.push({
          inner: inner ? cp.className(inner) : null,
          outer: outer ? cp.className(outer) : null,
          name: innerName ? cp.utf8(innerName) : null,
          access,
        });
      }
      break;
    }
    case 'EnclosingMethod': {
      const cls = r.u2();
      const method = r.u2();
      attrs.enclosingMethod = { owner: cp.className(cls), method: method ? cp.nameAndType(method) : null };
      break;
    }
    case 'BootstrapMethods': {
      const n = r.u2();
      attrs.bootstrapMethods = [];
      for (let i = 0; i < n; i++) {
        const ref = r.u2();
        const argc = r.u2();
        const args = [];
        for (let j = 0; j < argc; j++) args.push(r.u2());
        attrs.bootstrapMethods.push({ ref, args });
      }
      break;
    }
    case 'NestHost':
      attrs.nestHost = cp.className(r.u2());
      break;
    case 'NestMembers':
    case 'PermittedSubclasses': {
      const n = r.u2();
      const list = [];
      for (let i = 0; i < n; i++) list.push(cp.className(r.u2()));
      attrs[name === 'NestMembers' ? 'nestMembers' : 'permittedSubclasses'] = list;
      break;
    }
    case 'Deprecated':
      attrs.deprecated = true;
      break;
    case 'Synthetic':
      attrs.synthetic = true;
      break;
    case 'MethodParameters': {
      const n = r.u1();
      attrs.methodParameters = [];
      for (let i = 0; i < n; i++) {
        const nameIdx = r.u2();
        attrs.methodParameters.push({ name: nameIdx ? cp.utf8(nameIdx) : null, access: r.u2() });
      }
      break;
    }
    default:
      // LineNumberTable, LocalVariableTable, StackMapTable, Record, Module, TypeAnnotations...: no hacen falta.
      if (name) {
        attrs.other = attrs.other || [];
        attrs.other.push({ name, length: r.end - r.pos });
      }
  }
}

// ---------- Clase ----------

/**
 * Lee un .class. Devuelve { version, access, name, superName, interfaces, pool, fields, methods, attrs, errors }.
 * Cada campo/metodo: { access, name, desc, attrs }. Los metodos con cuerpo tienen attrs.code.code (Buffer).
 */
function parseClass(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  const r = new Reader(buf);
  if (r.u4() !== 0xcafebabe) throw new ClassFormatError('No es un archivo .class (falta CAFEBABE)');
  const minor = r.u2();
  const major = r.u2();
  const pool = readConstantPool(r);
  const access = r.u2();
  const thisIdx = r.u2();
  const superIdx = r.u2();
  const name = pool.className(thisIdx);
  const superName = superIdx ? pool.className(superIdx) : null;
  const ni = r.u2();
  const interfaces = [];
  for (let i = 0; i < ni; i++) interfaces.push(pool.className(r.u2()));
  const errors = [];
  const readMembers = (kind) => {
    const n = r.u2();
    const out = [];
    for (let i = 0; i < n; i++) {
      const acc = r.u2();
      const mName = pool.utf8(r.u2());
      const desc = pool.utf8(r.u2());
      const attrs = readAttributes(r, pool, `${name}.${mName}`, errors);
      out.push({ kind, access: acc, name: mName, desc, attrs });
    }
    return out;
  };
  const fields = readMembers('field');
  const methods = readMembers('method');
  let attrs = {};
  try {
    attrs = readAttributes(r, pool, name, errors);
  } catch (err) {
    errors.push(`${name}: atributos de clase ilegibles (${err.message})`);
  }
  return { version: { major, minor }, access, name, superName, interfaces, pool, fields, methods, attrs, errors };
}

// Todas las anotaciones (visibles + invisibles) de un elemento.
function annotationsOf(member) {
  const a = member?.attrs || {};
  return [...(a.visible || []), ...(a.invisible || [])];
}

function findAnnotation(member, ...types) {
  for (const ann of annotationsOf(member)) if (types.includes(ann.type)) return ann;
  return null;
}

// ---------- Bytecode ----------

const OP = {
  ICONST_M1: 0x02,
  ICONST_0: 0x03,
  ICONST_5: 0x08,
  BIPUSH: 0x10,
  SIPUSH: 0x11,
  LDC: 0x12,
  LDC_W: 0x13,
  LDC2_W: 0x14,
  BALOAD: 0x33,
  CALOAD: 0x34,
  BASTORE: 0x54,
  CASTORE: 0x55,
  DUP: 0x59,
  IXOR: 0x82,
  TABLESWITCH: 0xaa,
  LOOKUPSWITCH: 0xab,
  GETSTATIC: 0xb2,
  PUTSTATIC: 0xb3,
  GETFIELD: 0xb4,
  PUTFIELD: 0xb5,
  INVOKEVIRTUAL: 0xb6,
  INVOKESPECIAL: 0xb7,
  INVOKESTATIC: 0xb8,
  INVOKEINTERFACE: 0xb9,
  INVOKEDYNAMIC: 0xba,
  NEW: 0xbb,
  NEWARRAY: 0xbc,
  ANEWARRAY: 0xbd,
  CHECKCAST: 0xc0,
  INSTANCEOF: 0xc1,
  WIDE: 0xc4,
  MULTIANEWARRAY: 0xc5,
};

// Largo fijo de cada opcode (0 = variable o invalido).
const LEN = new Uint8Array(256);
(() => {
  for (let op = 0x00; op <= 0x0f; op++) LEN[op] = 1;
  LEN[0x10] = 2;
  LEN[0x11] = 3;
  LEN[0x12] = 2;
  LEN[0x13] = 3;
  LEN[0x14] = 3;
  for (let op = 0x15; op <= 0x19; op++) LEN[op] = 2;
  for (let op = 0x1a; op <= 0x35; op++) LEN[op] = 1;
  for (let op = 0x36; op <= 0x3a; op++) LEN[op] = 2;
  for (let op = 0x3b; op <= 0x83; op++) LEN[op] = 1;
  LEN[0x84] = 3;
  for (let op = 0x85; op <= 0x98; op++) LEN[op] = 1;
  for (let op = 0x99; op <= 0xa8; op++) LEN[op] = 3;
  LEN[0xa9] = 2;
  for (let op = 0xac; op <= 0xb1; op++) LEN[op] = 1;
  for (let op = 0xb2; op <= 0xb8; op++) LEN[op] = 3;
  LEN[0xb9] = 5;
  LEN[0xba] = 5;
  LEN[0xbb] = 3;
  LEN[0xbc] = 2;
  LEN[0xbd] = 3;
  LEN[0xbe] = 1;
  LEN[0xbf] = 1;
  LEN[0xc0] = 3;
  LEN[0xc1] = 3;
  LEN[0xc2] = 1;
  LEN[0xc3] = 1;
  LEN[0xc5] = 4;
  LEN[0xc6] = 3;
  LEN[0xc7] = 3;
  LEN[0xc8] = 5;
  LEN[0xc9] = 5;
})();

/**
 * Decodifica el bytecode de un metodo. Devuelve { ops, args, pcs, length, truncated }:
 *  - ops[i]: opcode
 *  - args[i]: operando principal (valor para iconst/bipush/sipush, indice del pool para ldc/invoke/field/new,
 *    tipo para newarray, local para load/store, salto relativo para branches)
 * Si encuentra un opcode invalido corta ahi (truncated = true) sin lanzar.
 */
function decodeCode(code) {
  const max = code.length;
  const ops = new Uint8Array(max);
  const args = new Int32Array(max);
  const pcs = new Int32Array(max);
  let n = 0;
  let pc = 0;
  let truncated = false;
  while (pc < max) {
    const op = code[pc];
    let len = LEN[op];
    let arg = 0;
    if (op >= 0x02 && op <= 0x08) arg = op - 0x03;
    else if (op === OP.BIPUSH) arg = pc + 1 < max ? (code[pc + 1] << 24) >> 24 : 0;
    else if (op === OP.SIPUSH) arg = pc + 2 < max ? (((code[pc + 1] << 8) | code[pc + 2]) << 16) >> 16 : 0;
    else if (op === OP.LDC || op === 0xbc || (op >= 0x15 && op <= 0x19) || (op >= 0x36 && op <= 0x3a) || op === 0xa9) arg = pc + 1 < max ? code[pc + 1] : 0;
    else if (len === 3 || op === 0xb9 || op === 0xba || op === OP.MULTIANEWARRAY) {
      arg = pc + 2 < max ? (code[pc + 1] << 8) | code[pc + 2] : 0;
      if (op >= 0x99 && op <= 0xa8) arg = (arg << 16) >> 16;
      if (op === 0xc6 || op === 0xc7) arg = (arg << 16) >> 16;
    } else if (op === 0xc8 || op === 0xc9) {
      arg = pc + 4 < max ? code.readInt32BE(pc + 1) : 0;
    }
    if (op === OP.TABLESWITCH || op === OP.LOOKUPSWITCH) {
      const base = pc + 1 + ((4 - ((pc + 1) % 4)) % 4);
      if (base + (op === OP.TABLESWITCH ? 12 : 8) > max) {
        truncated = true;
        break;
      }
      arg = code.readInt32BE(base);
      if (op === OP.TABLESWITCH) {
        const low = code.readInt32BE(base + 4);
        const high = code.readInt32BE(base + 8);
        const count = high - low + 1;
        if (count < 0 || count > 65536) {
          truncated = true;
          break;
        }
        len = base + 12 + count * 4 - pc;
      } else {
        const pairs = code.readInt32BE(base + 4);
        if (pairs < 0 || pairs > 65536) {
          truncated = true;
          break;
        }
        len = base + 8 + pairs * 8 - pc;
      }
    } else if (op === OP.WIDE) {
      const next = pc + 1 < max ? code[pc + 1] : 0;
      len = next === 0x84 ? 6 : 4;
      arg = pc + 3 < max ? (code[pc + 2] << 8) | code[pc + 3] : 0;
    }
    if (!len || pc + len > max) {
      truncated = true;
      break;
    }
    ops[n] = op;
    args[n] = arg;
    pcs[n] = pc;
    n++;
    pc += len;
  }
  return { ops: ops.subarray(0, n), args: args.subarray(0, n), pcs: pcs.subarray(0, n), length: n, truncated };
}

const isInvoke = (op) => op >= OP.INVOKEVIRTUAL && op <= OP.INVOKEINTERFACE;

// Valor entero que empuja una instruccion constante (o null si no es constante).
function intConst(dec, pool, i) {
  const op = dec.ops[i];
  if (op >= 0x02 && op <= 0x08) return dec.args[i];
  if (op === OP.BIPUSH || op === OP.SIPUSH) return dec.args[i];
  if (op === OP.LDC || op === OP.LDC_W) {
    const idx = dec.args[i];
    if (pool.tag(idx) === TAG.Integer) return pool.a[idx];
  }
  return null;
}

module.exports = {
  ClassFormatError,
  ConstantPool,
  TAG,
  ACC,
  OP,
  parseClass,
  decodeCode,
  decodeModifiedUtf8,
  annotationsOf,
  findAnnotation,
  plain,
  plainAnnotation,
  isInvoke,
  intConst,
};
