'use strict';
// Extensiones de la comunidad (módulo "extensions"). Guía de autores: docs/extensiones.md · Por dentro: docs/wip/extensiones-34.md.
// El código de una extensión es hostil por definición: corre en un iframe sandbox de origen opaco (features/extensions/
// frame.js), servido por el protocolo venus-ext:// con una CSP sin red ni inline, y solo habla con el launcher por el
// puente de postMessage. Este módulo valida los paquetes, los guarda y sirve sus archivos.
//   extensions:list                       { items, safeMode, safeModeForced, blocklistAt }
//   extensions:inspectFile(ruta?)         sin ruta abre el selector -> resumen para confirmar (o null si se canceló)
//   extensions:inspectBytes(bytes, opts)  lo mismo con un paquete del catálogo; opts.sha256: se verifica contra los bytes
//   extensions:install(stageId, opts)     { accepted: [...permisos], homeCard } -> la extensión instalada, apagada
//   extensions:setEnabled, setHomeCard, uninstall, setSafeMode, applyBlocklist
//   extensions:openSession(id, 'page'|'card')   URL de un solo uso para el iframe
//   extensions:storage(id, op, clave, valor)    el permiso storage; lo vuelve a comprobar acá
//   extensions:readForSubmit()            elige y valida un paquete para mandarlo al catálogo -> { manifest, sha256, size, bytes }
//   extensions:review(bytes, opts)        contenido de un paquete para el panel de admin, sin instalar ni ejecutar nada
//   evento extensions:changed
const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');
const paths = require('../core/paths');
const { t } = require('../core/i18n');
const { SCHEME, respond } = require('./extensions/server');
const { ExtensionError } = require('./extensions/manifest');
const { readPackage, contentTypeOf } = require('./extensions/package');
const { createRegistry } = require('./extensions/registry');

const TOKEN_TTL = 30 * 1000;
const STAGE_TTL = 15 * 60 * 1000;
const MAX_STAGES = 3;
const MAX_REVIEW_TEXT = 256 * 1024;
const SAFE_MODE_ARG = '--venus-safe-mode';

let registry = null;
const tokens = new Map(); // ficha -> { id, rel, at }
const stages = new Map(); // stageId -> { pkg, source, at }

// Error traducido con un código estable (la interfaz compara por err.code).
function translated(err) {
  if (err instanceof ExtensionError) {
    const out = new Error(t(`extensions.err_${err.code}`, { detail: err.detail }));
    out.code = err.code;
    return out;
  }
  return err;
}

const guarded =
  (fn) =>
  async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      throw translated(err);
    }
  };

// ---------- Protocolo ----------
function takeToken(id, rel, token) {
  const now = Date.now();
  for (const [k, v] of tokens) if (now - v.at > TOKEN_TTL) tokens.delete(k);
  const rec = tokens.get(token);
  if (!rec) return false;
  tokens.delete(token);
  return rec.id === id && rec.rel === rel;
}

function protocolContext() {
  return { servable: (id) => registry.servable(id), takeToken, read: (id, rel) => registry.read(id, rel) };
}

function preReady() {
  const { protocol } = require('electron');
  // Sin secure ni corsEnabled: el marco no es un contexto seguro (menos API del navegador a mano) y no hay fetch.
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: false, supportFetchAPI: false, corsEnabled: false, bypassCSP: false, stream: false, allowServiceWorkers: false } }]);
}

function registerProtocol() {
  const { protocol } = require('electron');
  protocol.handle(SCHEME, async (request) => {
    const res = await respond({ url: request.url, method: request.method }, protocolContext()).catch((err) => {
      console.warn('[extensions] protocolo:', err?.message || err);
      return { status: 500 };
    });
    return new Response(res.status === 200 ? res.body : null, { status: res.status, headers: res.headers || {} });
  });
}

// Segunda capa después de la CSP de la ventana (frame-src): un marco no navega a nada que no sea venus-ext:// .
function guardFrames(app) {
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-frame-navigate', (details) => {
      if (details.isMainFrame) return;
      const url = String(details.url || '');
      if (url.startsWith(`${SCHEME}://`) || url === 'about:blank' || url === 'about:srcdoc') return;
      details.preventDefault();
      console.warn('[extensions] navegación de un marco bloqueada');
    });
  });
}

// ---------- Instalar ----------
function stageSummary(stageId, pkg, source, cmp) {
  return {
    stageId,
    source,
    manifest: pkg.manifest,
    sha256: pkg.sha256,
    size: pkg.size,
    fileCount: pkg.files.length,
    files: pkg.files.map((f) => ({ path: f.path, size: f.size })),
    ...cmp,
  };
}

async function stage(pkg, source) {
  const now = Date.now();
  for (const [k, v] of stages) if (now - v.at > STAGE_TTL) stages.delete(k);
  while (stages.size >= MAX_STAGES) stages.delete(stages.keys().next().value);
  const stageId = crypto.randomBytes(12).toString('hex');
  const cmp = await registry.compare(pkg);
  if (cmp.blocked) throw new ExtensionError('blocked', pkg.manifest.id);
  stages.set(stageId, { pkg, source, at: now });
  return stageSummary(stageId, pkg, source, cmp);
}

function bytesOf(raw) {
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof Uint8Array) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  throw new ExtensionError('bad_zip', 'bytes');
}

function verifyHash(buffer, expected) {
  if (!expected) return;
  const got = crypto.createHash('sha256').update(buffer).digest('hex');
  if (got !== String(expected).toLowerCase()) throw new ExtensionError('hash_mismatch', '');
}

async function readFileLimited(file) {
  const st = await fsp.stat(file);
  if (!st.isFile()) throw new ExtensionError('bad_zip', 'file');
  if (st.size > 5 * 1024 * 1024) throw new ExtensionError('package_too_large', 'package');
  return fsp.readFile(file);
}

async function pickFile(getWindow, titleKey) {
  const { dialog } = require('electron');
  const r = await dialog.showOpenDialog(getWindow(), { title: t(titleKey), properties: ['openFile'], filters: [{ name: t('extensions.filterName'), extensions: ['venusext'] }] });
  return r.canceled || !r.filePaths?.[0] ? null : r.filePaths[0];
}

// Contenido de un paquete para revisar: los textos como texto y las imágenes en base64. Nada se ejecuta.
function reviewView(pkg) {
  return {
    manifest: pkg.manifest,
    sha256: pkg.sha256,
    size: pkg.size,
    files: pkg.files.map((f) => {
      const type = contentTypeOf(f.path) || '';
      const isText = type.startsWith('text/');
      return {
        path: f.path,
        size: f.size,
        type,
        text: isText ? f.data.toString('utf8', 0, Math.min(f.size, MAX_REVIEW_TEXT)) : null,
        truncated: isText && f.size > MAX_REVIEW_TEXT,
        image: !isText && f.size <= MAX_REVIEW_TEXT ? f.data.toString('base64') : null,
      };
    }),
  };
}

// ---------- Registro ----------
function register({ app, handle, send, getWindow }) {
  registry = createRegistry({
    dir: path.join(paths.root(), 'extensions'),
    launcherVersion: app.getVersion(),
    forceSafeMode: process.argv.includes(SAFE_MODE_ARG),
  });
  registerProtocol();
  guardFrames(app);
  const changed = () => {
    try {
      send('extensions:changed');
    } catch {
      /* ventana cerrada */
    }
  };

  handle('extensions:list', guarded(() => registry.list()));

  handle(
    'extensions:inspectFile',
    guarded(async (file) => {
      const target = typeof file === 'string' && file ? file : await pickFile(getWindow, 'extensions.pickTitle');
      if (!target) return null;
      return stage(readPackage(await readFileLimited(target)), 'local');
    }),
  );

  handle(
    'extensions:inspectBytes',
    guarded(async (bytes, opts = {}) => {
      const buffer = bytesOf(bytes);
      verifyHash(buffer, opts?.sha256);
      const pkg = readPackage(buffer);
      if (opts?.id && pkg.manifest.id !== opts.id) throw new ExtensionError('bad_manifest', 'id');
      if (opts?.version && pkg.manifest.version !== opts.version) throw new ExtensionError('bad_manifest', 'version');
      return stage(pkg, 'catalog');
    }),
  );

  handle(
    'extensions:install',
    guarded(async (stageId, opts = {}) => {
      const st = stages.get(stageId);
      if (!st || Date.now() - st.at >= STAGE_TTL) {
        stages.delete(stageId);
        throw new ExtensionError('stage_expired', '');
      }
      const view = await registry.install(st.pkg, { accepted: opts?.accepted, homeCard: opts?.homeCard === true, source: st.source });
      stages.delete(stageId);
      changed();
      return view;
    }),
  );

  const after =
    (fn) =>
    async (...args) => {
      const out = await fn(...args);
      changed();
      return out;
    };
  handle('extensions:setEnabled', guarded(after((id, on) => registry.setEnabled(id, on === true))));
  handle('extensions:setHomeCard', guarded(after((id, on) => registry.setHomeCard(id, on === true))));
  handle('extensions:uninstall', guarded(after((id) => registry.uninstall(id))));
  handle('extensions:setSafeMode', guarded(after((on) => registry.setSafeMode(on === true))));
  handle(
    'extensions:applyBlocklist',
    guarded(async (list) => {
      const disabled = await registry.applyBlocklist(list);
      if (disabled.length) changed();
      return disabled;
    }),
  );

  handle(
    'extensions:openSession',
    guarded(async (id, surface) => {
      const it = await registry.get(id);
      if (!registry.servable(id)) throw new ExtensionError('not_enabled', id);
      const rel = surface === 'card' ? it.homeCard && it.manifest.homeCard : it.manifest.entry;
      if (!rel) throw new ExtensionError('not_found', id);
      const token = crypto.randomBytes(24).toString('hex');
      tokens.set(token, { id, rel, at: Date.now() });
      return { url: `${SCHEME}://${id}/${rel.split('/').map(encodeURIComponent).join('/')}?t=${token}` };
    }),
  );

  handle(
    'extensions:storage',
    guarded((id, op, key, value) => {
      if (op === 'get') return registry.storageGet(id, key);
      if (op === 'set') return registry.storageSet(id, key, value);
      if (op === 'remove') return registry.storageRemove(id, key);
      if (op === 'keys') return registry.storageKeys(id);
      throw new ExtensionError('bad_request', 'op');
    }),
  );

  handle(
    'extensions:readForSubmit',
    guarded(async (file) => {
      const target = typeof file === 'string' && file ? file : await pickFile(getWindow, 'extensions.submitPickTitle');
      if (!target) return null;
      const buffer = await readFileLimited(target);
      const pkg = readPackage(buffer);
      return { manifest: pkg.manifest, sha256: pkg.sha256, size: pkg.size, bytes: buffer };
    }),
  );

  handle(
    'extensions:review',
    guarded(async (bytes, opts = {}) => {
      const buffer = bytesOf(bytes);
      verifyHash(buffer, opts?.sha256);
      return reviewView(readPackage(buffer));
    }),
  );

  registry.load().catch((err) => console.warn('[extensions] registro:', err?.message || err));
}

module.exports = { preReady, register };
