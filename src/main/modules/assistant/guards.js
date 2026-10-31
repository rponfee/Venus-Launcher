'use strict';
// Guardas de seguridad del asistente. Todo lo que llega del modelo es dato no confiable:
// ids de instancia, nombres de archivo, URLs de descarga y argumentos de las herramientas se validan aca,
// en codigo, antes de tocar el disco o la red.
const fsp = require('fs/promises');
const path = require('path');
const { t } = require('../../core/i18n');

// Error de una herramienta: el mensaje vuelve al modelo (y a la interfaz) como tool_result con is_error.
class ToolError extends Error {
  constructor(message, code = 'tool') {
    super(message);
    this.code = code;
  }
}

// Carpetas de contenido sobre las que puede operar el asistente (nunca saves/, config/, logs/ para escribir).
const CONTENT_KINDS = ['mods', 'resourcepacks', 'shaderpacks'];
const MOD_FILE = /\.(jar|zip|litemod)(\.disabled)?$/i;

// Hosts de descarga permitidos: Modrinth (exacto) y CurseForge (cualquier subdominio de forgecdn.net).
const DOWNLOAD_HOSTS = {
  modrinth: { exact: ['cdn.modrinth.com'], suffix: [] },
  curseforge: { exact: [], suffix: ['forgecdn.net'] },
};

const ID_RE = /^[\w.+-]{1,120}$/;

// Un nombre de archivo "pelado": sin rutas, separadores, unidades, caracteres de control ni nombres especiales.
function assertBareFileName(name) {
  if (typeof name !== 'string' || !name.length || name.length > 255) throw new ToolError(t('assistant.errFileName'), 'file');
  if (name !== name.trim() || name === '.' || name === '..') throw new ToolError(t('assistant.errFileName'), 'file');
  if (/[\\/:*?"<>|\x00-\x1f]/.test(name)) throw new ToolError(t('assistant.errFileName'), 'file');
  if (path.basename(name) !== name) throw new ToolError(t('assistant.errFileName'), 'file');
  return name;
}

// Resuelve una ruta y verifica que quede dentro de la carpeta base (nunca la base misma).
function insideDir(base, ...parts) {
  const root = path.resolve(base);
  const full = path.resolve(root, ...parts);
  if (full === root || !full.startsWith(root + path.sep)) throw new ToolError(t('assistant.errOutside'), 'path');
  return full;
}

function assertKind(kind) {
  if (!CONTENT_KINDS.includes(kind)) throw new ToolError(t('assistant.errKind', { kind: String(kind) }), 'kind');
  return kind;
}

// Archivo existente dentro de <instancia>/<kind>/ (sin enlaces simbolicos). Devuelve { full, name, isDir }.
async function existingContent(instanceDir, kind, name, { allowDir = false } = {}) {
  assertKind(kind);
  assertBareFileName(name);
  if (kind === 'mods' && !MOD_FILE.test(name)) throw new ToolError(t('assistant.errNotModFile', { file: name }), 'file');
  const full = insideDir(instanceDir, kind, name);
  const st = await fsp.lstat(full).catch(() => null);
  if (!st) throw new ToolError(t('assistant.errMissingFile', { file: name, kind }), 'missing');
  if (st.isSymbolicLink()) throw new ToolError(t('assistant.errFileName'), 'file');
  if (st.isDirectory() && !allowDir) throw new ToolError(t('assistant.errNotAFile', { file: name }), 'file');
  if (!st.isDirectory() && !st.isFile()) throw new ToolError(t('assistant.errFileName'), 'file');
  return { full, name, isDir: st.isDirectory(), size: st.size, mtimeMs: st.mtimeMs };
}

// Solo https y solo los hosts de la fuente indicada.
function assertDownloadUrl(url, source) {
  const allow = DOWNLOAD_HOSTS[source];
  let u;
  try {
    u = new URL(String(url));
  } catch {
    throw new ToolError(t('assistant.errDownloadHost', { host: '?' }), 'host');
  }
  const host = u.hostname.toLowerCase();
  const ok = Boolean(allow) && u.protocol === 'https:' && !u.username && !u.password && (allow.exact.includes(host) || allow.suffix.some((s) => host === s || host.endsWith(`.${s}`)));
  if (!ok) throw new ToolError(t('assistant.errDownloadHost', { host: host || '?' }), 'host');
  return u.href;
}

function assertId(value, what = 'id') {
  if (typeof value !== 'string' || !ID_RE.test(value) || value === '.' || value === '..') throw new ToolError(t('assistant.errBadId', { what }), 'id');
  return value;
}

// ---------- Validacion del input contra el JSON Schema de la herramienta ----------
// Subconjunto usado por las definiciones: object/properties/required/additionalProperties:false,
// string/integer/number/boolean/array, enum (sin distinguir mayusculas: el valor queda normalizado) e items.
function validate(schema, value, at = 'input') {
  const errors = [];
  const out = check(schema, value, at, errors);
  return { ok: errors.length === 0, errors, value: out };
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function check(schema, value, at, errors) {
  if (!schema || typeof schema !== 'object') return value;
  const want = schema.type;
  const got = typeOf(value);
  const typeOk =
    !want ||
    want === got ||
    (want === 'number' && got === 'integer') ||
    (Array.isArray(want) && (want.includes(got) || (want.includes('number') && got === 'integer')));
  if (!typeOk) {
    errors.push(`${at}: expected ${Array.isArray(want) ? want.join('|') : want}, got ${got}`);
    return value;
  }
  if (schema.enum) {
    const hit = schema.enum.find((e) => e === value || (typeof e === 'string' && typeof value === 'string' && e.toLowerCase() === value.toLowerCase()));
    if (hit === undefined) {
      errors.push(`${at}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
      return value;
    }
    return hit;
  }
  if (got === 'string' && value.length > 4000) {
    errors.push(`${at}: too long`);
    return value;
  }
  if (got === 'array') {
    if (value.length > 100) {
      errors.push(`${at}: too many items`);
      return value;
    }
    return value.map((v, i) => check(schema.items, v, `${at}[${i}]`, errors));
  }
  if (got === 'object') {
    const props = schema.properties || {};
    const out = {};
    for (const req of schema.required || []) {
      if (value[req] === undefined || value[req] === null) errors.push(`${at}.${req}: required`);
    }
    for (const [k, v] of Object.entries(value)) {
      if (!Object.prototype.hasOwnProperty.call(props, k)) {
        if (schema.additionalProperties === false) errors.push(`${at}.${k}: unknown property`);
        continue;
      }
      // null en un campo opcional = no enviado
      if (v === null && !(schema.required || []).includes(k)) continue;
      out[k] = check(props[k], v, `${at}.${k}`, errors);
    }
    return out;
  }
  return value;
}

module.exports = {
  ToolError,
  CONTENT_KINDS,
  MOD_FILE,
  DOWNLOAD_HOSTS,
  assertBareFileName,
  insideDir,
  assertKind,
  existingContent,
  assertDownloadUrl,
  assertId,
  validate,
};
