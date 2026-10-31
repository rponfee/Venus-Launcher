'use strict';
// Archivos de idioma de Minecraft: JSON (1.13+) y .lang "clave=valor" (1.12 y anteriores).
// Los mods a veces traen JSON con comentarios o comas de mas: se leen con tolerancia.

// Quita comentarios // y /* */ que esten fuera de los strings.
function stripJsonComments(text) {
  let out = '';
  let inStr = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\' && i + 1 < text.length) {
        out += text[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// Dentro de los strings, los saltos de linea crudos no son JSON valido (algunos mods los dejan igual).
function escapeRawNewlines(text) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') {
        out += c + (text[i + 1] ?? '');
        i++;
        continue;
      }
      if (c === '"') inStr = false;
      if (c === '\n') {
        out += '\\n';
        continue;
      }
      if (c === '\r') continue;
      if (c === '\t') {
        out += '\\t';
        continue;
      }
      out += c;
      continue;
    }
    if (c === '"') inStr = true;
    out += c;
  }
  return out;
}

function decodeText(buf) {
  let text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf ?? '');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

// JSON.parse con segundas oportunidades (comentarios, comas finales, saltos de linea crudos).
function parseJsonLenient(input) {
  const text = decodeText(input);
  try {
    return JSON.parse(text);
  } catch {
    const cleaned = escapeRawNewlines(stripJsonComments(text)).replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(cleaned);
  }
}

const COMMENT_KEY = /^_+comment/i;

// JSON de idioma -> Map(clave -> texto). Ignora valores que no son texto (componentes JSON, numeros).
function parseLangJson(buf) {
  const obj = parseJsonLenient(buf);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('lang: formato invalido');
  const map = new Map();
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v !== 'string' || !k || COMMENT_KEY.test(k)) continue;
    map.set(k, v);
  }
  return map;
}

// Escapes estilo Java (los usa Forge 1.12 cuando el archivo empieza con #PARSE_ESCAPES).
function unescapeJava(s) {
  return s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (m, c) => {
    if (c[0] === 'u' && c.length === 5) return String.fromCharCode(parseInt(c.slice(1), 16));
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
      default:
        return c;
    }
  });
}

function escapeJava(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

// .lang -> { map, escapes }. Las lineas vacias y las que empiezan con # son comentarios.
function parseLangFile(buf) {
  const text = decodeText(buf);
  const lines = text.split(/\r?\n/);
  const escapes = lines.some((l) => l.trim() === '#PARSE_ESCAPES');
  const map = new Map();
  for (const line of lines) {
    if (!line || line[0] === '#') continue;
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const key = line.slice(0, i);
    const value = line.slice(i + 1);
    map.set(key, escapes ? unescapeJava(value) : value);
  }
  return { map, escapes };
}

// Lee un archivo de idioma segun su extension.
function parseLang(buf, ext) {
  if (String(ext).toLowerCase() === 'lang') return parseLangFile(buf);
  return { map: parseLangJson(buf), escapes: false };
}

// entries: [[clave, texto], ...] en el orden deseado.
function serializeJson(entries) {
  const obj = {};
  for (const [k, v] of entries) obj[k] = v;
  return `${JSON.stringify(obj, null, 2)}\n`;
}

// .lang: con escapes solo si hace falta (Forge los entiende con #PARSE_ESCAPES; vanilla no).
function serializeLang(entries, { allowEscapes = false } = {}) {
  const needs = allowEscapes && entries.some(([, v]) => /[\n\r\t\\]/.test(v));
  const lines = [];
  if (needs) lines.push('#PARSE_ESCAPES');
  for (const [k, v] of entries) {
    if (!k || k.includes('\n') || k.includes('=')) continue;
    lines.push(`${k}=${needs ? escapeJava(v) : String(v).replace(/[\r\n]+/g, ' ')}`);
  }
  return `${lines.join('\n')}\n`;
}

module.exports = { parseJsonLenient, parseLangJson, parseLangFile, parseLang, serializeJson, serializeLang, stripJsonComments, unescapeJava, escapeJava };
