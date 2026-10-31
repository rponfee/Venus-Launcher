'use strict';
// TOML mínimo para META-INF/mods.toml y neoforge.mods.toml: tablas, arreglos de tablas ([[mods]],
// [[mixins]]), claves con puntos o comillas, textos (básicos, literales y multilínea), números,
// booleanos, fechas (como texto), arreglos y tablas en línea. Si una línea no se entiende se saltea:
// mejor leer lo que se pueda que fallar con un archivo escrito a mano.

function parse(src) {
  const text = String(src || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const root = {};
  let current = root;
  let i = 0;
  const n = text.length;

  const isWs = (c) => c === ' ' || c === '\t';
  const skipWs = () => {
    while (i < n && isWs(text[i])) i++;
  };
  const skipLine = () => {
    while (i < n && text[i] !== '\n') i++;
  };
  // espacios, saltos y comentarios (dentro de arreglos)
  const skipAll = () => {
    for (;;) {
      while (i < n && (isWs(text[i]) || text[i] === '\n')) i++;
      if (text[i] === '#') skipLine();
      else break;
    }
  };

  function fail(msg) {
    const err = new Error(msg);
    err.toml = true;
    throw err;
  }

  function parseBasicString() {
    // i en la comilla inicial
    if (text.startsWith('"""', i)) {
      i += 3;
      if (text[i] === '\n') i++;
      let out = '';
      while (i < n && !text.startsWith('"""', i)) {
        if (text[i] === '\\') {
          if (text[i + 1] === '\n' || (isWs(text[i + 1]) && /^[ \t]*\n/.test(text.slice(i + 1, i + 40)))) {
            i++;
            while (i < n && (isWs(text[i]) || text[i] === '\n')) i++;
            continue;
          }
          out += escape();
        } else out += text[i++];
      }
      i += 3;
      while (text[i] === '"') {
        out += '"';
        i++;
      }
      return out;
    }
    i++;
    let out = '';
    while (i < n && text[i] !== '"') {
      if (text[i] === '\n') fail('Texto sin cerrar');
      if (text[i] === '\\') out += escape();
      else out += text[i++];
    }
    i++;
    return out;
  }

  function escape() {
    const c = text[i + 1];
    i += 2;
    switch (c) {
      case 'b':
        return '\b';
      case 't':
        return '\t';
      case 'n':
        return '\n';
      case 'f':
        return '\f';
      case 'r':
        return '\r';
      case 'e':
        return '\x1b';
      case '"':
        return '"';
      case '\\':
        return '\\';
      case 'u':
      case 'U': {
        const len = c === 'u' ? 4 : 8;
        const hex = text.slice(i, i + len);
        i += len;
        const cp = parseInt(hex, 16);
        return Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
      }
      default:
        return c || '';
    }
  }

  function parseLiteralString() {
    if (text.startsWith("'''", i)) {
      i += 3;
      if (text[i] === '\n') i++;
      const end = text.indexOf("'''", i);
      if (end < 0) fail('Texto sin cerrar');
      let out = text.slice(i, end);
      i = end + 3;
      while (text[i] === "'") {
        out += "'";
        i++;
      }
      return out;
    }
    i++;
    const end = text.indexOf("'", i);
    const nl = text.indexOf('\n', i);
    if (end < 0 || (nl >= 0 && nl < end)) fail('Texto sin cerrar');
    const out = text.slice(i, end);
    i = end + 1;
    return out;
  }

  function parseKey() {
    const parts = [];
    for (;;) {
      skipWs();
      if (text[i] === '"') parts.push(parseBasicString());
      else if (text[i] === "'") parts.push(parseLiteralString());
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(text.slice(i, i + 256));
        if (!m) fail('Clave inválida');
        parts.push(m[0]);
        i += m[0].length;
      }
      skipWs();
      if (text[i] === '.') {
        i++;
        continue;
      }
      return parts;
    }
  }

  function parseValue() {
    skipWs();
    const c = text[i];
    if (c === '"') return parseBasicString();
    if (c === "'") return parseLiteralString();
    if (c === '[') {
      i++;
      const arr = [];
      for (;;) {
        skipAll();
        if (text[i] === ']') {
          i++;
          return arr;
        }
        arr.push(parseValue());
        skipAll();
        if (text[i] === ',') i++;
        else if (text[i] === ']') {
          i++;
          return arr;
        } else fail('Arreglo inválido');
      }
    }
    if (c === '{') {
      i++;
      const obj = {};
      skipWs();
      if (text[i] === '}') {
        i++;
        return obj;
      }
      for (;;) {
        const key = parseKey();
        if (text[i] !== '=') fail('Falta "="');
        i++;
        setPath(obj, key, parseValue());
        skipWs();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === '}') {
          i++;
          return obj;
        }
        fail('Tabla en línea inválida');
      }
    }
    const m = /^[^\s,\]}#]+/.exec(text.slice(i, i + 256));
    if (!m) fail('Valor inválido');
    let raw = m[0];
    i += raw.length;
    // fechas con hora separada por espacio: 1979-05-27 07:32:00
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw) && /^ \d{2}:\d{2}/.test(text.slice(i, i + 6))) {
      const t = /^ [0-9:.+Z-]+/.exec(text.slice(i, i + 64));
      raw += t[0];
      i += t[0].length;
    }
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (/^[+-]?(inf|nan)$/.test(raw)) return raw.includes('nan') ? NaN : raw.startsWith('-') ? -Infinity : Infinity;
    const num = raw.replace(/_/g, '');
    if (/^[+-]?(0x[0-9a-fA-F]+|0o[0-7]+|0b[01]+)$/.test(num)) {
      const neg = num.startsWith('-');
      const body = num.replace(/^[+-]/, '');
      const v = parseInt(body.slice(2), body[1] === 'x' ? 16 : body[1] === 'o' ? 8 : 2);
      return neg ? -v : v;
    }
    if (/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(num)) return Number(num);
    return raw; // fechas y valores raros quedan como texto
  }

  function setPath(obj, parts, value) {
    let o = obj;
    for (let k = 0; k < parts.length - 1; k++) {
      const p = parts[k];
      if (o[p] === undefined) o[p] = {};
      else if (Array.isArray(o[p])) o = o[p][o[p].length - 1];
      if (typeof o[p] !== 'object' || o[p] === null) o[p] = {};
      o = o[p];
    }
    o[parts[parts.length - 1]] = value;
  }

  function tablePath(parts, isArray) {
    let o = root;
    for (let k = 0; k < parts.length; k++) {
      const p = parts[k];
      const last = k === parts.length - 1;
      if (last && isArray) {
        if (!Array.isArray(o[p])) o[p] = [];
        const t = {};
        o[p].push(t);
        return t;
      }
      if (o[p] === undefined) o[p] = {};
      if (Array.isArray(o[p])) o = o[p][o[p].length - 1];
      else {
        if (typeof o[p] !== 'object' || o[p] === null) o[p] = {};
        o = o[p];
      }
    }
    return o;
  }

  while (i < n) {
    skipWs();
    const c = text[i];
    if (c === undefined) break;
    if (c === '\n') {
      i++;
      continue;
    }
    if (c === '#') {
      skipLine();
      continue;
    }
    const lineStart = i;
    try {
      if (c === '[') {
        const isArray = text[i + 1] === '[';
        i += isArray ? 2 : 1;
        const parts = parseKey();
        if (text[i] !== ']') fail('Encabezado inválido');
        i += isArray ? 2 : 1;
        current = tablePath(parts, isArray);
      } else {
        const key = parseKey();
        if (text[i] !== '=') fail('Falta "="');
        i++;
        setPath(current, key, parseValue());
      }
      skipWs();
      if (text[i] === '#') skipLine();
    } catch (err) {
      if (!err.toml) throw err;
      // linea ilegible: se saltea
      i = Math.max(i, lineStart + 1);
      skipLine();
    }
  }
  return root;
}

module.exports = { parse };
