'use strict';
// Manifiesto de una extensión de la comunidad (manifest.json del paquete .venusext). Sin Electron: se prueba con
// Node puro. El esquema es cerrado: una clave desconocida o un permiso que no existe rechazan el paquete entero.
// validateManifest(texto u objeto) -> copia limpia del manifiesto, o lanza ExtensionError con .code y .detail.
const { compareSemver } = require('../../core/util');
const safety = require('../packs/safety');

class ExtensionError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'ExtensionError';
    this.code = code;
    this.detail = String(detail || '');
  }
}

// Lo único que una extensión puede pedir. Ningún permiso da acceso a cuentas, tokens, archivos, red, mensajes ni amigos.
const PERMISSIONS = Object.freeze(['storage', 'notify', 'read.instances', 'read.gameState', 'action.openPage', 'action.launchInstance']);
const PERMISSION_SET = new Set(PERMISSIONS);

const MANIFEST_VERSION = 1;
const MAX_MANIFEST_BYTES = 16 * 1024;
const LIMITS = Object.freeze({ name: 40, author: 60, description: 300, version: 32, path: 180 });
const ID_RE = /^[a-z0-9-]{3,40}$/;
const VERSION_RE = /^\d{1,6}\.\d{1,6}\.\d{1,6}(-[0-9A-Za-z.-]{1,16})?$/;
const KEYS = new Set(['manifestVersion', 'id', 'name', 'version', 'author', 'description', 'minLauncherVersion', 'permissions', 'entry', 'homeCard']);
// Controles, invisibles y marcas de dirección (permiten disfrazar un nombre) y los signos de HTML.
const span = (a, b) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`;
const BAD_TEXT = new RegExp(`[${[span(0, 0x1f), span(0x7f, 0x9f), span(0xad, 0xad), span(0x200b, 0x200f), span(0x2028, 0x202e), span(0x2060, 0x206f), span(0xfeff, 0xfeff)].join('')}<>]`);
const COMBINING = new RegExp(`[${span(0x300, 0x36f)}]`, 'g');
const BOM = String.fromCharCode(0xfeff);
// Una extensión no se puede presentar como parte del launcher ni de quienes hacen el juego.
const RESERVED = ['venus', 'oficial', 'official', 'mojang', 'microsoft'];

function plainLetters(text) {
  return String(text)
    .normalize('NFKD')
    .replace(COMBINING, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function impersonates(text) {
  const plain = plainLetters(text);
  return RESERVED.some((word) => plain.includes(word));
}

function textField(raw, field, max, { required = true } = {}) {
  if (raw === undefined || raw === null) {
    if (required) throw new ExtensionError('bad_manifest', field);
    return '';
  }
  if (typeof raw !== 'string') throw new ExtensionError('bad_manifest', field);
  const value = raw.normalize('NFC').trim();
  if ((required && !value) || value.length > max || BAD_TEXT.test(value)) throw new ExtensionError('bad_manifest', field);
  return value;
}

function pagePath(raw, field) {
  if (typeof raw !== 'string' || raw !== raw.trim()) throw new ExtensionError('bad_manifest', field);
  const clean = safety.safeRelPath(raw, { instance: false, maxLength: LIMITS.path, maxDepth: 8 });
  if (!clean || clean !== raw || !clean.toLowerCase().endsWith('.html')) throw new ExtensionError('bad_manifest', field);
  return clean;
}

function validateManifest(input) {
  let raw = input;
  if (Buffer.isBuffer(raw)) {
    if (raw.length > MAX_MANIFEST_BYTES) throw new ExtensionError('bad_manifest', 'size');
    raw = raw.toString('utf8');
  }
  if (typeof raw === 'string') {
    if (raw.length > MAX_MANIFEST_BYTES) throw new ExtensionError('bad_manifest', 'size');
    try {
      raw = JSON.parse(raw.startsWith(BOM) ? raw.slice(1) : raw);
    } catch {
      throw new ExtensionError('bad_manifest', 'json');
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ExtensionError('bad_manifest', 'json');
  for (const key of Object.keys(raw)) if (!KEYS.has(key)) throw new ExtensionError('bad_manifest', key.slice(0, 40));

  if (raw.manifestVersion !== MANIFEST_VERSION) throw new ExtensionError('bad_manifest', 'manifestVersion');
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id) || raw.id.startsWith('-') || raw.id.endsWith('-')) throw new ExtensionError('bad_manifest', 'id');
  if (impersonates(raw.id)) throw new ExtensionError('reserved_name', raw.id);

  const name = textField(raw.name, 'name', LIMITS.name);
  if (impersonates(name)) throw new ExtensionError('reserved_name', name);
  const author = textField(raw.author, 'author', LIMITS.author);
  if (impersonates(author)) throw new ExtensionError('reserved_name', author);
  const description = textField(raw.description, 'description', LIMITS.description, { required: false });

  if (typeof raw.version !== 'string' || raw.version.length > LIMITS.version || !VERSION_RE.test(raw.version)) throw new ExtensionError('bad_manifest', 'version');
  if (typeof raw.minLauncherVersion !== 'string' || raw.minLauncherVersion.length > LIMITS.version || !VERSION_RE.test(raw.minLauncherVersion)) {
    throw new ExtensionError('bad_manifest', 'minLauncherVersion');
  }

  if (!Array.isArray(raw.permissions) || raw.permissions.length > PERMISSIONS.length) throw new ExtensionError('bad_manifest', 'permissions');
  const permissions = [];
  for (const p of raw.permissions) {
    if (typeof p !== 'string' || !PERMISSION_SET.has(p)) throw new ExtensionError('bad_permission', String(p).slice(0, 40));
    if (permissions.includes(p)) throw new ExtensionError('bad_manifest', 'permissions');
    permissions.push(p);
  }

  const entry = pagePath(raw.entry, 'entry');
  const homeCard = raw.homeCard === undefined ? null : pagePath(raw.homeCard, 'homeCard');

  return { manifestVersion: MANIFEST_VERSION, id: raw.id, name, version: raw.version, author, description, minLauncherVersion: raw.minLauncherVersion, permissions, entry, homeCard };
}

// ¿Este launcher alcanza para la extensión?
function launcherSupports(manifest, launcherVersion) {
  return compareSemver(launcherVersion, manifest.minLauncherVersion) >= 0;
}

// Permisos de `next` que no estaban aceptados: los que obligan a preguntar de nuevo al actualizar.
function addedPermissions(granted, next) {
  const have = new Set(Array.isArray(granted) ? granted : []);
  return (Array.isArray(next) ? next : []).filter((p) => !have.has(p));
}

module.exports = { ExtensionError, PERMISSIONS, MANIFEST_VERSION, LIMITS, ID_RE, validateManifest, launcherSupports, addedPermissions, impersonates, plainLetters };
