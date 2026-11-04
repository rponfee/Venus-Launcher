'use strict';
// Extensiones instaladas: registro, archivos y almacenamiento propio de cada una. Sin Electron (se prueba con Node puro).
//   <dir>/registry.json          { v, items: { id: {...} }, blocklist: { ids, hashes, at }, safeMode }
//   <dir>/<id>/package/...       los archivos del paquete, tal como se validaron
//   <dir>/<id>/storage.json      el permiso storage: hasta 1 MB por extensión
// Apagada por defecto: instalar nunca la prende. Bloqueada o en modo seguro no se sirve nada, aunque esté activada.
const fsp = require('fs/promises');
const path = require('path');
const { readJson, writeJson } = require('../../core/util');
const safety = require('../packs/safety');
const { ExtensionError, ID_RE, launcherSupports, addedPermissions } = require('./manifest');
const { writePackage, LIMITS: PKG } = require('./package');

const REGISTRY_VERSION = 1;
const STORAGE_QUOTA = 1024 * 1024;
const MAX_KEYS = 500;
const KEY_RE = /^[A-Za-z0-9._-]{1,64}$/;
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_BLOCKLIST = 5000;
const HASH_RE = /^[0-9a-f]{64}$/;

function createRegistry({ dir, launcherVersion, forceSafeMode = false }) {
  let state = null;
  let loading = null;
  const storageCache = new Map(); // id -> objeto sin prototipo
  const queues = new Map(); // id -> promesa: escrituras en serie por extensión

  const file = () => path.join(dir, 'registry.json');
  const assertId = (id) => {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new ExtensionError('not_found', 'id');
    return id;
  };
  const extDir = (id) => path.join(dir, assertId(id));
  const pkgDir = (id) => path.join(extDir(id), 'package');
  const storageFile = (id) => path.join(extDir(id), 'storage.json');

  async function load() {
    if (state) return state;
    if (!loading) {
      loading = readJson(file(), null).then((raw) => {
        const r = raw && typeof raw === 'object' && raw.v === REGISTRY_VERSION ? raw : {};
        const items = Object.create(null);
        for (const [id, it] of Object.entries(r.items && typeof r.items === 'object' ? r.items : {})) {
          if (ID_RE.test(id) && it && typeof it === 'object' && it.manifest) items[id] = it;
        }
        state = {
          v: REGISTRY_VERSION,
          items,
          blocklist: {
            ids: Array.isArray(r.blocklist?.ids) ? r.blocklist.ids.filter((x) => typeof x === 'string') : [],
            hashes: Array.isArray(r.blocklist?.hashes) ? r.blocklist.hashes.filter((x) => typeof x === 'string') : [],
            at: Number(r.blocklist?.at) || 0,
          },
          safeMode: r.safeMode === true,
        };
        return state;
      });
    }
    return loading;
  }

  const save = async () => {
    await fsp.mkdir(dir, { recursive: true });
    await writeJson(file(), { ...state, items: { ...state.items } });
  };

  const isSafeMode = () => forceSafeMode || state?.safeMode === true;
  const isBlocked = (id, sha256) => Boolean(state && (state.blocklist.ids.includes(id) || (sha256 && state.blocklist.hashes.includes(sha256))));

  function itemView(id, it) {
    const m = it.manifest;
    const blocked = isBlocked(id, it.sha256);
    return {
      id,
      name: m.name,
      version: m.version,
      author: m.author,
      description: m.description,
      minLauncherVersion: m.minLauncherVersion,
      permissions: [...(it.granted || [])],
      hasPage: Boolean(m.entry),
      hasHomeCard: Boolean(m.homeCard),
      homeCardEnabled: Boolean(it.homeCard && m.homeCard),
      enabled: Boolean(it.enabled) && !blocked,
      blocked,
      source: it.source === 'catalog' ? 'catalog' : 'local',
      sha256: it.sha256 || '',
      size: Number(it.size) || 0,
      installedAt: Number(it.installedAt) || 0,
      updatedAt: Number(it.updatedAt) || 0,
    };
  }

  async function list() {
    await load();
    const items = Object.keys(state.items)
      .map((id) => itemView(id, state.items[id]))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { items, safeMode: isSafeMode(), safeModeForced: forceSafeMode, blocklistAt: state.blocklist.at };
  }

  async function get(id) {
    await load();
    const it = state.items[assertId(id)];
    if (!it) throw new ExtensionError('not_found', id);
    return it;
  }

  // ¿Se le puede servir algo? Es lo primero que mira el protocolo en cada pedido.
  function servable(id) {
    if (!state || isSafeMode()) return false;
    const it = state.items[id];
    return Boolean(it && it.enabled && !isBlocked(id, it.sha256));
  }

  // Comparación de lo que llega con lo instalado (para el resumen de instalación).
  async function compare(pkg) {
    await load();
    const it = state.items[pkg.manifest.id];
    const added = it ? addedPermissions(it.granted, pkg.manifest.permissions) : pkg.manifest.permissions;
    return {
      installed: it ? itemView(pkg.manifest.id, it) : null,
      addedPermissions: added,
      newHomeCard: Boolean(pkg.manifest.homeCard && !it?.manifest?.homeCard),
      blocked: isBlocked(pkg.manifest.id, pkg.sha256),
      launcherOk: launcherSupports(pkg.manifest, launcherVersion),
    };
  }

  // accepted: permisos aceptados por la persona. Tienen que estar todos: no hay instalación a medias.
  async function install(pkg, { accepted = [], homeCard = false, source = 'local' } = {}) {
    await load();
    const m = pkg.manifest;
    if (!launcherSupports(m, launcherVersion)) throw new ExtensionError('launcher_too_old', m.minLauncherVersion);
    if (isBlocked(m.id, pkg.sha256)) throw new ExtensionError('blocked', m.id);
    if (addedPermissions(accepted, m.permissions).length) throw new ExtensionError('permissions_required', m.id);
    const prev = state.items[m.id] || null;
    await fsp.mkdir(extDir(m.id), { recursive: true });
    await writePackage(pkg, pkgDir(m.id));
    const now = Date.now();
    state.items[m.id] = {
      manifest: m,
      granted: [...m.permissions],
      enabled: prev ? Boolean(prev.enabled) : false,
      homeCard: Boolean(homeCard && m.homeCard),
      source: source === 'catalog' ? 'catalog' : 'local',
      sha256: pkg.sha256,
      size: pkg.size,
      installedAt: prev?.installedAt || now,
      updatedAt: now,
    };
    await save();
    return itemView(m.id, state.items[m.id]);
  }

  async function setEnabled(id, on) {
    const it = await get(id);
    if (on && isBlocked(id, it.sha256)) throw new ExtensionError('blocked', id);
    it.enabled = Boolean(on);
    await save();
    return itemView(id, it);
  }

  async function setHomeCard(id, on) {
    const it = await get(id);
    it.homeCard = Boolean(on && it.manifest.homeCard);
    await save();
    return itemView(id, it);
  }

  // Desinstalar borra también sus datos: nada de la extensión queda en la PC.
  async function uninstall(id) {
    await get(id);
    delete state.items[id];
    storageCache.delete(id);
    await save();
    await fsp.rm(extDir(id), { recursive: true, force: true });
    return true;
  }

  async function setSafeMode(on) {
    await load();
    state.safeMode = Boolean(on);
    await save();
    return isSafeMode();
  }

  // Lista de bloqueadas del catálogo: las que coinciden quedan apagadas. Se guarda para cumplirla también sin conexión.
  async function applyBlocklist({ ids, hashes } = {}) {
    await load();
    state.blocklist = {
      ids: (Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'string' && ID_RE.test(x)).slice(0, MAX_BLOCKLIST),
      hashes: (Array.isArray(hashes) ? hashes : []).filter((x) => typeof x === 'string' && HASH_RE.test(x)).slice(0, MAX_BLOCKLIST),
      at: Date.now(),
    };
    const disabled = [];
    for (const [id, it] of Object.entries(state.items)) {
      if (!isBlocked(id, it.sha256)) continue;
      if (it.enabled) disabled.push(id);
      it.enabled = false;
    }
    await save();
    return disabled;
  }

  // Archivo del paquete, o null. Se vuelve a validar la ruta aunque el protocolo ya lo haya hecho.
  async function read(id, rel) {
    const base = pkgDir(id);
    const full = safety.resolveInside(base, rel, { instance: false, maxLength: PKG.MAX_PATH, maxDepth: PKG.MAX_DEPTH });
    if (!full) return null;
    try {
      const st = await fsp.lstat(full);
      if (!st.isFile() || st.size > PKG.MAX_FILE) return null;
      return await fsp.readFile(full);
    } catch {
      return null;
    }
  }

  // ---------- Almacenamiento propio (permiso storage) ----------
  function serial(id, fn) {
    const run = (queues.get(id) || Promise.resolve()).then(fn, fn);
    queues.set(
      id,
      run.catch(() => {}),
    );
    return run;
  }

  async function readStorage(id) {
    if (storageCache.has(id)) return storageCache.get(id);
    const raw = await readJson(storageFile(id), null);
    const data = Object.create(null);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw)) if (KEY_RE.test(k) && !BAD_KEYS.has(k)) data[k] = v;
    }
    storageCache.set(id, data);
    return data;
  }

  async function assertStorage(id) {
    const it = await get(id);
    if (!(it.granted || []).includes('storage') || !servable(id)) throw new ExtensionError('permission_denied', 'storage');
    return it;
  }

  const assertKey = (key) => {
    if (typeof key !== 'string' || !KEY_RE.test(key) || BAD_KEYS.has(key)) throw new ExtensionError('bad_request', 'key');
    return key;
  };

  async function storageGet(id, key) {
    await assertStorage(id);
    assertKey(key);
    const data = await readStorage(id);
    return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
  }

  async function storageKeys(id) {
    await assertStorage(id);
    return Object.keys(await readStorage(id));
  }

  function storageSet(id, key, value) {
    return serial(id, async () => {
      await assertStorage(id);
      assertKey(key);
      const text = JSON.stringify(value);
      if (text === undefined) throw new ExtensionError('bad_request', 'value');
      const data = await readStorage(id);
      const next = Object.assign(Object.create(null), data, { [key]: JSON.parse(text) });
      if (Object.keys(next).length > MAX_KEYS) throw new ExtensionError('quota_exceeded', 'keys');
      if (Buffer.byteLength(JSON.stringify(next), 'utf8') > STORAGE_QUOTA) throw new ExtensionError('quota_exceeded', 'bytes');
      await writeJson(storageFile(id), { ...next });
      storageCache.set(id, next);
      return true;
    });
  }

  function storageRemove(id, key) {
    return serial(id, async () => {
      await assertStorage(id);
      assertKey(key);
      const data = await readStorage(id);
      if (!Object.prototype.hasOwnProperty.call(data, key)) return false;
      const next = Object.assign(Object.create(null), data);
      delete next[key];
      await writeJson(storageFile(id), { ...next });
      storageCache.set(id, next);
      return true;
    });
  }

  return {
    load,
    list,
    get,
    compare,
    install,
    setEnabled,
    setHomeCard,
    uninstall,
    setSafeMode,
    applyBlocklist,
    read,
    servable,
    isSafeMode,
    storageGet,
    storageKeys,
    storageSet,
    storageRemove,
  };
}

module.exports = { createRegistry, STORAGE_QUOTA, MAX_KEYS };
