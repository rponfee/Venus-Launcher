'use strict';
// Parser TOML tolerante, suficiente para META-INF/mods.toml y neoforge.mods.toml de Forge/NeoForge:
// tablas, arrays de tablas, claves con puntos o comillas, strings (basicos, literales y multilinea),
// numeros, booleanos, arrays y tablas en linea. Si una linea esta mal, se saltea y se sigue leyendo.

function parse(src) {
  const text = String(src || '').replace(/^﻿/, '');
  const n = text.length;
  let i = 0;
  const root = {};
  let current = root;

  const fail = (what) => {
    const e = new Error(`TOML: ${what} (pos ${i})`);
    e.toml = true;
    throw e;
  };
  const skipWs = () => {
    while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
  };
  const skipComment = () => {
    if (text[i] === '#') while (i < n && text[i] !== '\n') i++;
  };
  const skipWsNl = () => {
    for (;;) {
      skipWs();
      if (text[i] === '#') {
        skipComment();
        continue;
      }
      if (text[i] === '\n' || text[i] === '\r') {
        i++;
        continue;
      }
      break;
    }
  };

  function parseEscape() {
    const c = text[i++];
    switch (c) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case '"':
        return '"';
      case '\\':
        return '\\';
      case 'u':
      case 'U': {
        const len = c === 'u' ? 4 : 8;
        const hex = text.slice(i, i + len);
        i += len;
        const code = parseInt(hex, 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : '';
      }
      default:
        return c || '';
    }
  }

  function parseBasicString() {
    i++; // "
    let out = '';
    while (i < n) {
      const c = text[i];
      if (c === '"') {
        i++;
        return out;
      }
      if (c === '\n') fail('string sin cerrar');
      if (c === '\\') {
        i++;
        out += parseEscape();
        continue;
      }
      out += c;
      i++;
    }
    return fail('string sin cerrar');
  }

  function parseLiteralString() {
    i++; // '
    const end = text.indexOf("'", i);
    const nl = text.indexOf('\n', i);
    if (end < 0 || (nl >= 0 && nl < end)) fail('string literal sin cerrar');
    const out = text.slice(i, end);
    i = end + 1;
    return out;
  }

  function parseMultiBasic() {
    i += 3;
    if (text[i] === '\r') i++;
    if (text[i] === '\n') i++;
    let out = '';
    while (i < n) {
      if (text.startsWith('"""', i)) {
        i += 3;
        // Hasta dos comillas extra pertenecen al contenido
        while (text[i] === '"') {
          out += '"';
          i++;
        }
        return out;
      }
      const c = text[i];
      if (c === '\\') {
        i++;
        if (text[i] === '\n' || text[i] === '\r' || text[i] === ' ' || text[i] === '\t') {
          // Barra al final de linea: recorta saltos y espacios
          while (i < n && /[\s]/.test(text[i])) i++;
          continue;
        }
        out += parseEscape();
        continue;
      }
      out += c;
      i++;
    }
    return fail('string multilinea sin cerrar');
  }

  function parseMultiLiteral() {
    i += 3;
    if (text[i] === '\r') i++;
    if (text[i] === '\n') i++;
    const end = text.indexOf("'''", i);
    if (end < 0) fail('string multilinea sin cerrar');
    let out = text.slice(i, end);
    i = end + 3;
    while (text[i] === "'") {
      out += "'";
      i++;
    }
    return out;
  }

  function parseKey() {
    const parts = [];
    for (;;) {
      skipWs();
      let k;
      if (text[i] === '"') k = parseBasicString();
      else if (text[i] === "'") k = parseLiteralString();
      else {
        const s = i;
        while (i < n && /[A-Za-z0-9_-]/.test(text[i])) i++;
        k = text.slice(s, i);
        if (!k) fail('clave vacía');
      }
      parts.push(k);
      skipWs();
      if (text[i] === '.') {
        i++;
        continue;
      }
      return parts;
    }
  }

  function parseNumberOrBare(raw) {
    const s = raw.replace(/_/g, '');
    if (/^[+-]?(0|[1-9]\d*)$/.test(s)) return Number(s);
    if (/^0x[0-9a-f]+$/i.test(s)) return parseInt(s.slice(2), 16);
    if (/^0o[0-7]+$/i.test(s)) return parseInt(s.slice(2), 8);
    if (/^0b[01]+$/i.test(s)) return parseInt(s.slice(2), 2);
    if (/^[+-]?(\d+)(\.\d+)?([eE][+-]?\d+)?$/.test(s)) return Number(s);
    if (/^[+-]?(inf|nan)$/.test(s)) return s.includes('nan') ? NaN : s.startsWith('-') ? -Infinity : Infinity;
    return raw; // fechas y valores raros quedan como texto
  }

  function parseArray() {
    i++; // [
    const out = [];
    for (;;) {
      skipWsNl();
      if (text[i] === ']') {
        i++;
        return out;
      }
      if (i >= n) fail('array sin cerrar');
      out.push(parseValue());
      skipWsNl();
      if (text[i] === ',') {
        i++;
        continue;
      }
      if (text[i] === ']') {
        i++;
        return out;
      }
      fail('se esperaba , o ]');
    }
  }

  function parseInlineTable() {
    i++; // {
    const out = {};
    skipWs();
    if (text[i] === '}') {
      i++;
      return out;
    }
    for (;;) {
      const path = parseKey();
      skipWs();
      if (text[i] !== '=') fail('se esperaba =');
      i++;
      setPath(out, path, parseValue());
      skipWs();
      if (text[i] === ',') {
        i++;
        skipWs();
        continue;
      }
      if (text[i] === '}') {
        i++;
        return out;
      }
      fail('se esperaba , o }');
    }
  }

  function parseValue() {
    skipWs();
    const c = text[i];
    if (c === '"') return text.startsWith('"""', i) ? parseMultiBasic() : parseBasicString();
    if (c === "'") return text.startsWith("'''", i) ? parseMultiLiteral() : parseLiteralString();
    if (c === '[') return parseArray();
    if (c === '{') return parseInlineTable();
    if (text.startsWith('true', i) && !/[A-Za-z0-9_]/.test(text[i + 4] || '')) {
      i += 4;
      return true;
    }
    if (text.startsWith('false', i) && !/[A-Za-z0-9_]/.test(text[i + 5] || '')) {
      i += 5;
      return false;
    }
    const s = i;
    while (i < n && !/[\r\n,\]}#]/.test(text[i])) i++;
    const raw = text.slice(s, i).trim();
    if (!raw) fail('valor vacío');
    return parseNumberOrBare(raw);
  }

  function container(obj, key) {
    let v = obj[key];
    if (v === undefined) v = obj[key] = {};
    if (Array.isArray(v)) {
      if (!v.length || typeof v[v.length - 1] !== 'object') v.push({});
      return v[v.length - 1];
    }
    if (typeof v !== 'object' || v === null) v = obj[key] = {};
    return v;
  }

  function setPath(obj, path, value) {
    let o = obj;
    for (let k = 0; k < path.length - 1; k++) o = container(o, path[k]);
    o[path[path.length - 1]] = value;
  }

  function tableAt(path) {
    let o = root;
    for (const k of path) o = container(o, k);
    return o;
  }

  function arrayTableAt(path) {
    let o = root;
    for (let k = 0; k < path.length - 1; k++) o = container(o, path[k]);
    const last = path[path.length - 1];
    if (!Array.isArray(o[last])) o[last] = [];
    const item = {};
    o[last].push(item);
    return item;
  }

  while (i < n) {
    skipWsNl();
    if (i >= n) break;
    const lineStart = i;
    try {
      if (text[i] === '[') {
        const isArr = text[i + 1] === '[';
        i += isArr ? 2 : 1;
        const path = parseKey();
        skipWs();
        if (text[i] !== ']') fail('se esperaba ]');
        i++;
        if (isArr) {
          if (text[i] !== ']') fail('se esperaba ]]');
          i++;
        }
        current = isArr ? arrayTableAt(path) : tableAt(path);
      } else {
        const path = parseKey();
        skipWs();
        if (text[i] !== '=') fail('se esperaba =');
        i++;
        setPath(current, path, parseValue());
      }
      skipWs();
      skipComment();
    } catch (err) {
      if (!err.toml) throw err;
      // Linea invalida: saltar hasta el proximo salto de linea
      i = Math.max(i, lineStart + 1);
      while (i < n && text[i] !== '\n') i++;
    }
  }
  return root;
}

module.exports = { parse };
