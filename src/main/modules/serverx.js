'use strict';
// Servidores locales (funciones avanzadas): tipos y versiones, server.properties con esquema, gamerules,
// jugadores y listas, mundo (info, importar, copias, regenerar, data packs), icono, archivos de
// configuracion, automatizacion y "servidor espejo" a partir de una instancia.
// El nucleo (instalar, iniciar, consola) esta en core/servers.js.
const fsp = require('fs/promises');
const path = require('path');
const servers = require('../core/servers');
const props = require('../core/server-properties');
const tasks = require('../core/tasks');
const { t } = require('../core/i18n');
const gamerules = require('./serverx/gamerules');
const players = require('./serverx/players');
const world = require('./serverx/world');
const mirror = require('./serverx/mirror');
const files = require('./serverx/files');
const automation = require('./serverx/automation');
const safety = require('./packs/safety');

const liveRules = new Map(); // id -> { regla: valor } enviados por comando en la sesion actual

// ---------- Gamerules ----------

async function gamerulesState(id) {
  const s = await servers.get(id);
  if (servers.isProxy(s)) return { proxy: true, rules: [], extra: [] };
  const state = servers.runtimeState(id);
  const { dir: worldDir, folders } = await world.worldFolders(id);
  const read = folders.length ? await gamerules.readWorld(worldDir, s.mcVersion) : { file: null, values: {}, extra: [], style: null };
  const overrides = liveRules.get(id) || {};
  const pending = s.pendingGamerules || {};
  const rules = gamerules.schemaFor(s.mcVersion).map((r) => {
    const inFile = read.values[r.key] !== undefined;
    let value = r.default;
    if (r.key in overrides) value = overrides[r.key];
    else if (r.key in pending) value = pending[r.key];
    else if (inFile) value = read.values[r.key];
    return { ...r, value, inFile, pending: r.key in pending };
  });
  const writable = folders.length > 0 && (Boolean(read.style) || Object.keys(read.values).length > 0);
  return {
    proxy: false,
    state,
    mode: state === 'online' ? 'live' : state !== 'offline' ? 'busy' : writable ? 'file' : 'pending',
    worldExists: folders.length > 0,
    file: read.file,
    newNames: gamerules.usesNewNames(s.mcVersion),
    groups: gamerules.GROUPS,
    rules,
    extra: read.extra.map((e) => ({ ...e, value: e.name in overrides ? String(overrides[e.name]) : e.value })),
    pendingCount: Object.keys(pending).length,
  };
}

async function setGamerules(id, patch = {}, extraPatch = {}) {
  const s = await servers.get(id);
  if (servers.isProxy(s)) throw new Error(t('servers.errProxyFeature'));
  const clean = {};
  for (const [k, v] of Object.entries(patch || {})) {
    const rule = gamerules.BY_KEY.get(k);
    if (!rule) continue;
    try {
      clean[k] = gamerules.validate(rule, v);
    } catch (err) {
      if (err.code === 'range') throw new Error(t('servers.errRuleRange', { key: k, min: err.min ?? '-', max: err.max ?? '∞' }));
      throw new Error(t('servers.errRuleValue', { key: k }));
    }
  }
  const extra = {};
  for (const [k, v] of Object.entries(extraPatch || {})) if (/^[\w:.-]{1,80}$/.test(k) && /^[\w.:-]{1,40}$/.test(String(v).trim())) extra[k] = String(v).trim();
  const state = servers.runtimeState(id);
  if (state === 'online') {
    for (const c of [...gamerules.commands(clean, s.mcVersion), ...Object.entries(extra).map(([k, v]) => `gamerule ${k} ${v}`)]) servers.command(id, c);
    liveRules.set(id, { ...(liveRules.get(id) || {}), ...clean, ...extra });
    return gamerulesState(id);
  }
  if (state !== 'offline') throw new Error(t('servers.errBusy'));
  const { dir: worldDir, folders } = await world.worldFolders(id);
  let skipped = Object.keys(clean);
  let written = [];
  if (folders.length) ({ written, skipped } = await gamerules.writeWorld(worldDir, s.mcVersion, clean, extra));
  await servers.patchMeta(id, (cur) => {
    const pending = { ...(cur.pendingGamerules || {}) };
    for (const k of written) delete pending[k];
    for (const k of skipped) pending[k] = clean[k];
    return { ...cur, pendingGamerules: Object.keys(pending).length ? pending : null };
  });
  return gamerulesState(id);
}

// ---------- server.properties ----------

async function propertiesState(id) {
  const s = await servers.get(id);
  if (servers.isProxy(s)) return { proxy: true };
  const text = await fsp.readFile(path.join(servers.dir(id), 'server.properties'), 'utf8').catch(() => '');
  const values = props.parse(text);
  const schema = props.schemaFor(s.mcVersion);
  const known = new Set(schema.map((e) => e.key));
  return {
    proxy: false,
    mcVersion: s.mcVersion,
    groups: props.GROUPS,
    schema,
    values,
    unknown: Object.keys(values)
      .filter((k) => !known.has(k))
      .map((k) => ({ key: k, value: values[k] })),
    exists: Boolean(text),
    state: servers.runtimeState(id),
  };
}

// ---------- Jugadores ----------

async function playerLists(id) {
  const s = await servers.get(id);
  const p = servers.isProxy(s) ? {} : await servers.readProperties(id);
  const lists = await players.readLists(servers.dir(id));
  return {
    state: s.state,
    running: s.state !== 'offline',
    onlineMode: p['online-mode'] !== 'false',
    whitelistEnabled: p['white-list'] === 'true',
    online: s.playerInfo || [],
    ...lists,
  };
}

async function playerAction(id, action, target, extra = {}) {
  const s = await servers.get(id);
  if (servers.isProxy(s)) throw new Error(t('servers.errProxyFeature'));
  const p = await servers.readProperties(id);
  const live = s.state === 'online';
  if (s.state !== 'offline' && !live) throw new Error(t('servers.errBusy'));
  const res = await players.act(
    { dir: servers.dir(id), running: live, onlineMode: p['online-mode'] !== 'false', command: (c) => servers.command(id, c), stamp: servers.nowStamp },
    action,
    target,
    extra,
  );
  if (res.live) await new Promise((r) => setTimeout(r, 700));
  return playerLists(id);
}

// ---------- Icono ----------

async function iconData(id) {
  try {
    const buf = await fsp.readFile(path.join(servers.dir(id), 'server-icon.png'));
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

async function setIcon(id, file) {
  const { nativeImage } = require('electron');
  await servers.get(id);
  if (typeof file !== 'string' || !/\.(png|jpe?g)$/i.test(file)) throw new Error(t('servers.errIconFormat'));
  let img = nativeImage.createFromPath(file);
  if (img.isEmpty()) throw new Error(t('servers.errIconFormat'));
  const { width, height } = img.getSize();
  const side = Math.min(width, height);
  if (width !== height) img = img.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side });
  if (side !== 64) img = img.resize({ width: 64, height: 64, quality: side < 64 ? 'good' : 'best' });
  await fsp.writeFile(path.join(servers.dir(id), 'server-icon.png'), img.toPNG());
  await servers.patchMeta(id, { iconUpdated: Date.now() });
  return iconData(id);
}

// ---------- Registro ----------

function register({ handle, send, safePath, onQuit }) {
  const { ipcMain, shell } = require('electron');
  const changed = () => send('servers:changed');
  // Valida el id (que exista el servidor) antes de tocar archivos.
  const checked = (fn) => async (id, ...args) => {
    await servers.get(id);
    return fn(id, ...args);
  };
  world.setTrash((p) => shell.trashItem(p));

  // Algunos canales servers:* existen en ipc.js con textos fijos en castellano: se reemplazan por
  // versiones traducidas y con los tipos nuevos (mismo nombre y firma compatible).
  const override = (channel, fn) => {
    try {
      ipcMain.removeHandler(channel);
    } catch {
      /* no estaba registrado */
    }
    handle(channel, fn);
  };

  const installInBackground = (s) => {
    tasks
      .run(t('servers.taskInstall', { name: s.name }), (task) => servers.install(s.id, task), { serverId: s.id })
      .catch(() => {})
      .finally(changed);
  };

  // Tipos y versiones
  handle('servers:types', () => servers.types());
  override('servers:versions', (type, opts) => servers.versions(type, opts || {}));
  handle('servers:loaderVersions', (type, mc) => servers.loaderVersions(type, mc));
  handle('servers:suggestPort', (type) => servers.suggestPort(type));
  handle('servers:checkUpdate', (id) => servers.checkUpdate(id));

  // Ciclo de vida
  override('servers:create', async (opts) => {
    const s = await servers.create(opts || {});
    installInBackground(s);
    changed();
    return s;
  });
  override('servers:start', async (id) => {
    const s = await servers.get(id);
    return tasks.run(t('servers.taskStart', { name: s.name }), (task) => servers.start(id, task), { serverId: id }).finally(changed);
  });
  handle('servers:restart', async (id) => {
    const s = await servers.get(id);
    return tasks.run(t('servers.taskRestart', { name: s.name }), (task) => servers.restart(id, task), { serverId: id }).finally(changed);
  });
  override('servers:reinstall', async (id) => {
    const s = await servers.get(id);
    return tasks.run(t('servers.taskReinstall', { name: s.name }), (task) => servers.install(id, task), { serverId: id }).finally(changed);
  });
  override('servers:installProject', async (id, projectId, versionId) => {
    const s = await servers.get(id);
    return tasks.run(t('servers.taskAddon', { name: s.name }), (task) => servers.installProject(id, projectId, versionId, task), { serverId: id });
  });
  // La carpeta del servidor tiene el mundo y las copias de backups/: va a la papelera y, si la papelera
  // falla, no se borra (core/servers.remove la borraria del todo).
  override('servers:remove', async (id) => {
    const s = await servers.get(id);
    if (servers.isRunning(id) || s.busy) throw new Error(t('servers.errStopBeforeDelete'));
    await world.trash(servers.dir(id), { name: s.name });
    servers.clearLogs(id);
    liveRules.delete(id);
    changed();
    return true;
  });
  handle('servers:clearLogs', checked((id) => servers.clearLogs(id)));
  handle('servers:openPath', async (id, sub = '') => {
    await servers.get(id);
    const allowed = ['', 'world', 'plugins', 'mods', 'config', 'backups', 'logs', 'datapacks', 'crash-reports'];
    if (!allowed.includes(sub)) throw new Error(t('servers.errFile'));
    let target = servers.dir(id);
    if (sub === 'world' || sub === 'datapacks') {
      const w = await world.worldFolders(id);
      target = sub === 'world' ? w.dir : path.join(w.dir, 'datapacks');
    } else if (sub) target = path.join(target, sub);
    const full = safePath(target);
    await fsp.mkdir(full, { recursive: true }).catch(() => {});
    const err = await shell.openPath(full);
    if (err) throw new Error(err);
    return true;
  });

  // server.properties (servers:properties y servers:setProperties siguen en ipc.js y usan core/servers)
  handle('servers:propertiesState', (id) => propertiesState(id));

  // Gamerules
  handle('servers:gamerules', (id) => gamerulesState(id));
  handle('servers:setGamerules', (id, patch, extra) => setGamerules(id, patch, extra));

  // Jugadores
  handle('servers:playerLists', (id) => playerLists(id));
  handle('servers:playerAction', (id, action, target, extra) => playerAction(id, action, target, extra));
  handle('servers:lookupPlayer', async (id, name) => {
    await servers.get(id);
    const p = await servers.readProperties(id);
    return players.lookup(name, p['online-mode'] !== 'false');
  });

  // Mundo
  handle('servers:worldInfo', checked((id) => world.info(id)));
  handle('servers:importWorld', async (id, instanceId, folder, opts) => {
    const s = await servers.get(id);
    return tasks.run(t('servers.taskImportWorld', { name: s.name }), () => world.importFromInstance(id, instanceId, folder, opts || {}), { serverId: id });
  });
  handle('servers:backupWorld', async (id) => {
    const s = await servers.get(id);
    const res = await tasks.run(t('servers.taskBackup', { name: s.name }), (task) => world.backup(id, { task }), { serverId: id });
    await servers.patchMeta(id, { lastBackupAt: Date.now() });
    return res;
  });
  handle('servers:backups', checked((id) => world.listBackups(id)));
  handle('servers:deleteBackup', checked((id, name) => world.deleteBackup(id, name)));
  handle('servers:restoreBackup', async (id, name) => {
    const s = await servers.get(id);
    return tasks.run(t('servers.taskRestore', { name: s.name }), (task) => world.restore(id, name, task), { serverId: id });
  });
  handle('servers:regenerateWorld', checked((id, opts) => world.regenerate(id, opts || {})));
  handle('servers:datapacks', checked((id) => world.listDatapacks(id)));
  handle('servers:addDatapacks', checked((id, filePaths) => world.addDatapacks(id, Array.isArray(filePaths) ? filePaths : [])));
  handle('servers:toggleDatapack', checked((id, name, enable) => world.toggleDatapack(id, name, Boolean(enable))));
  handle('servers:removeDatapack', checked((id, name) => world.removeDatapack(id, name)));

  // Icono
  handle('servers:icon', checked((id) => iconData(id)));
  handle('servers:icons', async () => {
    const out = {};
    for (const s of await servers.list()) out[s.id] = await iconData(s.id);
    return out;
  });
  handle('servers:setIcon', async (id, file) => {
    const data = await setIcon(id, file);
    changed();
    return data;
  });
  handle('servers:removeIcon', async (id) => {
    await servers.get(id);
    await world.trash(path.join(servers.dir(id), 'server-icon.png'), { hard: true });
    changed();
    return true;
  });

  // Plugins y mods locales: activar/desactivar (.disabled) y agregar jars elegidos por el usuario.
  const addonFolder = async (id, folder) => {
    const s = await servers.get(id);
    const info = servers.typeInfo(s.type);
    if (!info?.folders.includes(folder)) throw new Error(t('servers.errFile'));
    return path.join(servers.dir(id), folder);
  };
  handle('servers:toggleFile', async (id, folder, file) => {
    const base = await addonFolder(id, folder);
    const name = path.basename(String(file || ''));
    if (!name || name !== file || !/\.jar(\.disabled)?$/i.test(name)) throw new Error(t('servers.errFile'));
    const next = name.endsWith('.disabled') ? name.slice(0, -9) : `${name}.disabled`;
    await fsp.rename(safePath(path.join(base, name)), safePath(path.join(base, next)));
    return next;
  });
  handle('servers:addFiles', async (id, folder, filePaths) => {
    const base = await addonFolder(id, folder);
    await fsp.mkdir(base, { recursive: true });
    const added = [];
    for (const f of Array.isArray(filePaths) ? filePaths : []) {
      if (typeof f !== 'string' || !/\.jar$/i.test(f)) continue;
      // Temporal + renombrado, nunca encima: el jar con ese nombre puede ser un enlace duro compartido
      // con otros servidores o instancias (storage). Abierto por un servidor encendido no se puede reemplazar.
      try {
        await safety.copyFileAtomic(f, path.join(base, path.basename(f)));
      } catch (err) {
        if (safety.isLockError(err)) throw new Error(t('servers.errFileBusy', { name: path.basename(f) }));
        throw err;
      }
      added.push(path.basename(f));
    }
    return added;
  });

  // Archivos de configuracion
  handle('servers:files', (id) => files.list(id));
  handle('servers:readFile', (id, rel) => files.read(id, rel));
  handle('servers:writeFile', (id, rel, text) => files.write(id, rel, text));

  // Servidor espejo
  handle('servers:mirrorPreview', (instanceId, opts) => mirror.analyze(instanceId, opts || {}));
  handle('servers:createFromInstance', async (instanceId, opts = {}) => {
    const s = await tasks.run(t('servers.taskMirror'), (task) => mirror.create(instanceId, opts || {}, task));
    installInBackground(s);
    changed();
    return s;
  });

  servers.events.on('state', (id, st) => {
    if (st.state === 'offline') liveRules.delete(id);
  });
  automation.init({ onChange: changed });
  onQuit(() => automation.shutdown());
}

module.exports = { register, gamerulesState, setGamerules, propertiesState, playerLists, playerAction };
