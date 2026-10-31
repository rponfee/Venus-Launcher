'use strict';
// Canales IPC entre la interfaz y el nucleo. Cada handler devuelve {ok, data} o {ok:false, error, code?}
// (code = err.code del error lanzado; el preload lo deja en el Error que recibe la interfaz).
const os = require('os');
const path = require('path');
const { ipcMain, shell, dialog, app } = require('electron');
const paths = require('./core/paths');
const settings = require('./core/settings');
const accounts = require('./core/accounts');
const minecraft = require('./core/minecraft');
const java = require('./core/java');
const instances = require('./core/instances');
const game = require('./core/game');
const modrinth = require('./core/modrinth');
const servers = require('./core/servers');
const stats = require('./core/stats');
const tasks = require('./core/tasks');
const fabric = require('./core/loaders/fabric');
const forge = require('./core/loaders/forge');
const optifine = require('./core/loaders/optifine');
const secure = require('./core/secure');
const i18n = require('./core/i18n');
const modulesLoader = require('./modules-loader');
const { writeJson, dirSize } = require('./core/util');

const { t } = i18n;

// Error con mensaje traducido (core.<clave>) y un codigo estable para que la interfaz no compare textos.
function coreError(key, code) {
  const err = new Error(t(`core.${key}`));
  if (code) err.code = code;
  return err;
}

const registeredHandlers = new Map();
function handle(channel, fn) {
  registeredHandlers.set(channel, fn);
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      const out = { ok: false, error: err?.message || String(err) };
      if (typeof err?.code === 'string' || typeof err?.code === 'number') out.code = err.code;
      return out;
    }
  });
}

// Solo se permiten abrir rutas dentro de la carpeta de datos del launcher.
function safePath(p) {
  const full = path.resolve(p);
  const root = path.resolve(paths.root());
  if (full !== root && !full.startsWith(root + path.sep)) throw coreError('errPathNotAllowed', 'pathNotAllowed');
  return full;
}

// Nombre legible de la GPU ("ANGLE (Intel, Intel(R) UHD Graphics 620 (0x...) Direct3D11 ...)" -> "Intel UHD Graphics 620").
function cleanGpuName(raw) {
  try {
    return require('./modules/perf/system').cleanGpuName(raw);
  } catch {
    return String(raw || '').trim();
  }
}

// Tipos de loader que publica la meta de Fabric (fabric, quilt, legacyfabric, babric...).
function isFabricKind(kind) {
  const kinds = Array.isArray(fabric.KINDS) ? fabric.KINDS : ['fabric', 'quilt', 'legacyfabric'];
  return kinds.includes(kind);
}

function register({ getWindow }) {
  const win = () => getWindow();

  // ---------- App / ventana ----------
  handle('app:info', () => ({
    version: app.getVersion(),
    name: app.getName(),
    electron: process.versions.electron,
    platform: process.platform,
    arch: process.arch,
    dataDir: paths.root(),
    packaged: app.isPackaged,
    portable: Boolean(process.env.PORTABLE_EXECUTABLE_DIR),
    devshot: Boolean(process.env.VENUS_DEVSHOT),
    skipOnboarding: process.env.VENUS_SKIP_ONBOARDING === '1',
    locale: app.getLocale(),
  }));
  handle('app:window', (action) => {
    const w = win();
    if (!w) return;
    if (action === 'minimize') w.minimize();
    else if (action === 'maximize') (w.isMaximized() ? w.unmaximize() : w.maximize());
    else if (action === 'close') w.close();
    return w.isMaximized();
  });
  handle('app:openExternal', (url) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw coreError('errUrlNotAllowed', 'urlNotAllowed');
    return shell.openExternal(url);
  });
  handle('app:openPath', async (p) => {
    const full = safePath(p);
    await require('fs/promises').mkdir(full, { recursive: true }).catch(() => {});
    const err = await shell.openPath(full);
    if (err) throw new Error(err);
  });
  handle('app:showItem', (p) => shell.showItemInFolder(safePath(p)));
  handle('app:selectFiles', async (opts = {}) => {
    const r = await dialog.showOpenDialog(win(), {
      title: opts.title || t('core.selectFiles'),
      properties: ['openFile', ...(opts.multi ? ['multiSelections'] : [])],
      filters: opts.filters || [],
    });
    return r.canceled ? [] : r.filePaths;
  });
  handle('app:selectFolder', async (opts = {}) => {
    const r = await dialog.showOpenDialog(win(), { title: opts.title || t('core.selectFolder'), properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('app:setDataDir', async (dir) => {
    await writeJson(path.join(app.getPath('userData'), 'venus-location.json'), { dataDir: dir || null });
    return true;
  });
  handle('app:relaunch', () => {
    app.relaunch();
    app.exit(0);
  });
  handle('app:dataUsage', async () => {
    const out = {};
    for (const k of ['versions', 'libraries', 'assets', 'runtime', 'instances', 'servers', 'cache']) out[k] = await dirSize(path.join(paths.root(), k));
    return out;
  });
  handle('app:clearCache', async () => {
    await require('fs/promises').rm(paths.cache(), { recursive: true, force: true });
    await require('fs/promises').mkdir(paths.cache(), { recursive: true });
    return true;
  });

  // ---------- Ajustes / sistema ----------
  handle('settings:get', () => settings.get());
  handle('settings:set', async (patch) => {
    const s = await settings.set(patch);
    if (patch && patch.language) i18n.setLanguage(patch.language);
    return s;
  });

  // ---------- Traducciones ----------
  handle('i18n:available', () => i18n.availableRenderer());

  // ---------- Almacen cifrado para la interfaz (solo claves 'ui:*', p. ej. la sesion de Supabase) ----------
  const uiKey = (k) => {
    if (typeof k !== 'string' || !/^[\w.:-]{1,120}$/.test(k)) throw coreError('errBadKey', 'badKey');
    return `ui:${k}`;
  };
  handle('secure:get', (k) => secure.get(uiKey(k)));
  handle('secure:set', (k, v) => secure.set(uiKey(k), v));
  handle('secure:remove', (k) => secure.remove(uiKey(k)));

  // ---------- Nube (Supabase) ----------
  // Siempre el proyecto del launcher (core/cloud-defaults.js); los ajustes viejos (settings.cloud) se ignoran.
  handle('cloud:config', () => require('./core/cloud-defaults').config());
  // Servidores TURN del Voice Chat (core/app-config.js): [] si el launcher no trae ninguno.
  handle('voice:iceServers', () => {
    const turn = require('./core/app-config').get().turn;
    return turn.urls.length ? [{ urls: turn.urls, username: turn.username || undefined, credential: turn.credential || undefined }] : [];
  });
  let gpuCache = null; // nombre de la GPU ('' si no se pudo saber)
  handle('system:info', async () => {
    if (gpuCache === null) {
      try {
        const g = await app.getGPUInfo('complete');
        const devices = Array.isArray(g?.gpuDevice) ? g.gpuDevice : [];
        const device = devices.find((d) => d?.active && d.deviceString) || devices.find((d) => d?.deviceString);
        // Misma limpieza que perf:system: "Intel(R) UHD Graphics 620" ya no queda en "Intel".
        gpuCache = cleanGpuName(g?.auxAttributes?.glRenderer) || cleanGpuName(device?.deviceString) || '';
      } catch {
        gpuCache = '';
      }
    }
    const cpus = os.cpus();
    return {
      totalMem: os.totalmem(),
      freeMem: os.freemem(),
      cpuModel: cpus[0]?.model?.trim() || 'CPU',
      cpuCores: cpus.length,
      platform: process.platform,
      release: os.release(),
      arch: process.arch,
      hostname: os.hostname(),
      gpu: gpuCache || t('core.gpuUnknown'),
      recommended: settings.recommendedMemory(),
    };
  });
  let lastCpu = os.cpus().map((c) => c.times);
  handle('system:usage', async () => {
    const now = os.cpus().map((c) => c.times);
    let idle = 0;
    let total = 0;
    now.forEach((t, i) => {
      const p = lastCpu[i] || t;
      const sum = (x) => x.user + x.nice + x.sys + x.idle + x.irq;
      idle += t.idle - p.idle;
      total += sum(t) - sum(p);
    });
    lastCpu = now;
    const launcherMem = app.getAppMetrics().reduce((a, m) => a + (m.memory?.workingSetSize || 0) * 1024, 0);
    const games = [];
    const st = game.status();
    const pidusage = require('pidusage');
    for (const [id, g] of Object.entries(st)) {
      if (!g.pid) continue;
      try {
        const u = await pidusage(g.pid);
        games.push({ instanceId: id, pid: g.pid, cpu: u.cpu / os.cpus().length, memory: u.memory, elapsed: u.elapsed });
      } catch {
        /* proceso terminado */
      }
    }
    return { totalMem: os.totalmem(), freeMem: os.freemem(), cpu: total ? (1 - idle / total) * 100 : 0, launcherMem, games };
  });
  handle('java:runtimes', () => java.listInstalledRuntimes());
  handle('java:detect', () => java.detectSystemJava());
  handle('java:test', (p) => java.getJavaVersion(p));

  // ---------- Cuentas ----------
  handle('accounts:list', () => accounts.list());
  handle('accounts:addOffline', (name) => accounts.addOffline(name));
  handle('accounts:loginMicrosoft', () => accounts.loginMicrosoft());
  handle('accounts:select', (id) => accounts.select(id));
  handle('accounts:remove', (id) => accounts.remove(id));

  // ---------- Versiones y loaders ----------
  handle('versions:manifest', (force) => minecraft.getManifest(force));
  handle('versions:patchNotes', () =>
    require('./core/http').getJson('https://launchercontent.mojang.com/v2/javaPatchNotes.json', {
      cacheFile: paths.cache('patch-notes.json'),
      cacheMaxAge: 30 * 60 * 1000,
    }),
  );
  handle('versions:patchNote', async (contentPath) => {
    if (typeof contentPath !== 'string' || !/^[\w/.-]+\.json$/.test(contentPath)) throw coreError('errBadPath', 'badPath');
    return require('./core/http').getJson(`https://launchercontent.mojang.com/v2/${contentPath}`);
  });
  handle('loaders:gameVersions', async (kind) => {
    if (isFabricKind(kind)) return (await fabric.getGameVersions(kind)).map((v) => ({ id: v.version, stable: v.stable }));
    if (kind === 'forge' || kind === 'neoforge') return (await forge.getGameVersions(kind)).map((id) => ({ id, stable: !/pre|rc|snapshot|w\d/.test(id) }));
    if (kind === 'optifine') {
      const list = await optifine.listVersions();
      return [...new Set(list.map((v) => v.mcVersion))].map((id) => ({ id, stable: true }));
    }
    if (kind === 'iris') {
      const p = await modrinth.getProject('iris');
      return p.game_versions.map((id) => ({ id, stable: !/pre|rc|snapshot|w\d/.test(id) })).reverse();
    }
    return [];
  });
  handle('loaders:versions', async (kind, mc) => {
    if (isFabricKind(kind)) return fabric.getLoaderVersions(kind, mc);
    if (kind === 'forge' || kind === 'neoforge') return forge.getLoaderVersions(kind, mc);
    if (kind === 'optifine') {
      const list = await optifine.listVersions();
      return list.filter((v) => v.mcVersion === mc).map((v) => ({ version: v.edition, label: v.name, stable: !v.preview, forge: v.forge, date: v.date }));
    }
    if (kind === 'iris') return fabric.getLoaderVersions('fabric', mc);
    return [];
  });

  // ---------- Instancias ----------
  handle('instances:list', async () => {
    const st = game.status();
    return (await instances.list()).map((i) => ({ ...i, running: st[i.id] || null }));
  });
  handle('instances:get', (id) => instances.get(id));
  handle('instances:create', async (opts) => {
    const inst = await instances.create(opts);
    tasks
      .run(t('instances.taskInstalling', { name: inst.name }), (task) => instances.prepare(inst.id, task), { instanceId: inst.id })
      .then(() => win()?.webContents.send('instances:changed'))
      .catch(() => win()?.webContents.send('instances:changed'));
    return inst;
  });
  handle('instances:update', (id, patch) => instances.update(id, patch));
  handle('instances:remove', async (id) => {
    if (game.status()[id]) throw coreError('errCloseGameToDelete', 'running');
    await instances.remove(id);
    return true;
  });
  handle('instances:duplicate', (id) => instances.duplicate(id));
  handle('instances:repair', async (id) => {
    const inst = await instances.get(id);
    await tasks.run(t('instances.taskRepairing', { name: inst.name }), (task) => instances.prepare(id, task, { verify: 'hash' }), { instanceId: id });
    return true;
  });
  handle('instances:content', (id, folder) => instances.content(id, folder));
  // Mientras se busca el mod culpable de un crash, la carpeta mods es de esa búsqueda
  const modsFree = (id, folder) => {
    if (folder === 'mods') require('./modules/crash').assertNotBisecting(id);
  };
  handle('instances:toggleFile', (id, folder, file) => {
    modsFree(id, folder);
    return instances.toggleFile(id, folder, file);
  });
  handle('instances:deleteFile', (id, folder, file) => {
    modsFree(id, folder);
    return instances.deleteFile(id, folder, file);
  });
  handle('instances:addFiles', (id, folder, files) => {
    modsFree(id, folder);
    return instances.addFiles(id, folder, files);
  });
  handle('instances:openFolder', async (id, sub) => {
    const full = safePath(path.join(instances.dir(id), sub || ''));
    await require('fs/promises').mkdir(full, { recursive: true }).catch(() => {});
    return shell.openPath(full);
  });
  handle('instances:addOptifine', async (id, edition) => {
    const inst = await instances.get(id);
    return tasks.run(t('core.taskAddOptifine', { name: inst.name }), (task) => optifine.installAsMod(inst.mcVersion, edition, path.join(inst.dir, 'mods'), task));
  });
  handle('instances:launch', async (id, opts = {}) => {
    const account = await accounts.getLaunchAccount();
    const s = await settings.get();
    await settings.set({ selectedInstance: id });
    return game.start(id, { account, settings: s, quickPlay: opts.quickPlay, launcherVersion: app.getVersion() });
  });
  handle('instances:stop', (id) => game.stop(id));
  handle('instances:status', () => game.status());
  handle('game:activity', (id) => (id ? game.activity(id) : Object.fromEntries(Object.keys(game.status()).map((k) => [k, game.activity(k)]))));
  handle('instances:logs', (id) => game.logs(id));
  handle('instances:latestLog', async (id) => {
    const fsp = require('fs/promises');
    const dir = instances.dir(id);
    const crash = path.join(dir, 'crash-reports');
    let crashes = [];
    try {
      crashes = (await fsp.readdir(crash)).filter((f) => f.endsWith('.txt')).sort().reverse();
    } catch {
      crashes = [];
    }
    const latest = await fsp.readFile(path.join(dir, 'logs', 'latest.log'), 'utf8').catch(() => '');
    return { latest: latest.slice(-60000), crash: crashes[0] ? await fsp.readFile(path.join(crash, crashes[0]), 'utf8').catch(() => '') : '' };
  });

  // ---------- Modrinth ----------
  handle('modrinth:search', (params) => modrinth.search(params));
  handle('modrinth:project', (id) => modrinth.getProject(id));
  handle('modrinth:versions', (id, filters) => modrinth.getVersions(id, filters));
  handle('modrinth:tags', () => modrinth.getTags());
  handle('modrinth:install', async (instanceId, projectId, versionId, opts = {}) => {
    const inst = await instances.get(instanceId);
    return tasks.run(t('core.taskInstallInto', { name: inst.name }), (task) => instances.installProject(instanceId, projectId, versionId, { ...opts, task }), { instanceId });
  });
  handle('modrinth:installModpack', async (opts = {}) => {
    return tasks.run(t('core.taskModpack'), async (task) => {
      let packFile = opts.file;
      let version = null;
      let project = null;
      if (opts.versionId) {
        const r = await modrinth.downloadPack(opts.versionId, task);
        packFile = r.file;
        version = r.version;
        project = await modrinth.getProject(version.project_id).catch(() => null);
      }
      if (!packFile) throw coreError('errNoModpack', 'noModpack');
      const { index } = await modrinth.readMrpack(packFile);
      const deps = index.dependencies || {};
      const { loader, loaderVersion } = modrinth.packLoader(deps);
      const inst = await instances.create({
        name: opts.name || project?.title || index.name,
        mcVersion: deps.minecraft,
        loader,
        loaderVersion,
        icon: project?.icon_url || null,
        pack: { projectId: project?.id || null, versionId: version?.id || null, name: index.name, version: index.versionId },
      });
      task.update({ title: t('instances.taskInstalling', { name: inst.name }) });
      await modrinth.installPackContents(packFile, inst.dir, task);
      // Estado del pack (modules/packs): asi las actualizaciones saben que archivos son del modpack.
      try {
        const packs = require('./modules/packs');
        if (typeof packs.recordInstall === 'function') {
          await packs.recordInstall(inst.id, packFile, { projectId: project?.id || version?.project_id || null, versionId: version?.id || null });
        }
      } catch (err) {
        console.warn('[ipc] estado del modpack:', err?.message || err);
      }
      await instances.prepare(inst.id, task);
      win()?.webContents.send('instances:changed');
      return inst;
    });
  });
  handle('modrinth:identify', async (instanceId, folder) => {
    const files = await modrinth.listFolder(instances.dir(instanceId), folder);
    return modrinth.identify(instances.dir(instanceId), files);
  });
  handle('modrinth:updates', async (instanceId) => {
    const inst = await instances.get(instanceId);
    const files = await modrinth.listFolder(inst.dir, 'mods');
    const ids = await modrinth.identify(inst.dir, files);
    const hashes = Object.values(ids).map((i) => i.hash);
    const latest = await modrinth.checkUpdates(hashes, modrinth.modLoadersFor(inst), inst.mcVersion);
    const out = [];
    for (const [file, info] of Object.entries(ids)) {
      const nv = latest[info.hash];
      if (nv && nv.id !== info.versionId) out.push({ file, ...info, newVersionId: nv.id, newVersionNumber: nv.version_number });
    }
    return out;
  });

  // ---------- Servidores ----------
  // servers:versions, create, start, reinstall, installProject y remove los registra modules/serverx.js
  // (traducidos y con todos los tipos de servidor).
  handle('servers:list', () => servers.list());
  handle('servers:get', (id) => servers.get(id));
  handle('servers:update', (id, patch) => servers.update(id, patch));
  handle('servers:stop', (id) => servers.stop(id));
  handle('servers:kill', (id) => servers.kill(id));
  handle('servers:command', (id, cmd) => servers.command(id, cmd));
  handle('servers:logs', (id) => servers.logs(id));
  handle('servers:properties', (id) => servers.readProperties(id));
  handle('servers:setProperties', (id, patch) => servers.writeProperties(id, patch));
  handle('servers:addresses', () => servers.localAddresses());
  handle('servers:openFolder', (id) => shell.openPath(safePath(paths.server(id))));
  handle('servers:content', (id) => servers.content(id));
  // Solo un archivo de las carpetas de plugins o mods del tipo de servidor (como servers:toggleFile).
  // Va a la papelera y, si la papelera falla, no se borra.
  handle('servers:deleteFile', async (id, folder, file) => {
    const s = await servers.get(id);
    const name = path.basename(String(file || ''));
    if (!servers.typeInfo(s.type)?.folders.includes(folder) || !name || name !== file) throw new Error(t('servers.errFile'));
    const target = safePath(path.join(paths.server(id), folder, name));
    const st = await require('fs/promises').stat(target).catch(() => null);
    if (!st) return true;
    if (!st.isFile()) throw new Error(t('servers.errFile'));
    await shell.trashItem(target).catch(() => {
      throw new Error(t('servers.errTrash', { name }));
    });
    return true;
  });

  // ---------- Estadisticas / tareas ----------
  handle('stats:get', () => stats.get());
  handle('stats:reset', () => stats.reset());
  handle('tasks:list', () => tasks.list());
  handle('tasks:cancel', (id) => tasks.cancel(id));

  // ---------- Eventos hacia la interfaz ----------
  const send = (ch, ...a) => {
    const w = win();
    if (w && !w.isDestroyed()) w.webContents.send(ch, ...a);
  };
  tasks.bus.on('update', (t) => send('task:update', t));
  const logBuffers = new Map();
  game.events.on('log', (id, lines) => {
    if (!logBuffers.has(id)) {
      logBuffers.set(id, []);
      setTimeout(() => {
        send('game:log', id, logBuffers.get(id));
        logBuffers.delete(id);
      }, 120);
    }
    logBuffers.get(id).push(...lines);
  });
  game.events.on('state', (id, st) => send('game:state', id, st));
  game.events.on('warnings', (id, warnings) => send('game:warnings', id, warnings));
  // Al cerrar una partida de prueba la actividad es null y la marca viaja aparte: (id, null, { quiet: true }).
  game.events.on('activity', (id, act, meta) => (meta ? send('game:activity', id, act, meta) : send('game:activity', id, act)));
  servers.events.on('log', (id, line) => send('server:log', id, line));
  servers.events.on('state', (id, st) => send('server:state', id, st));

  return { send, handle, safePath };
}

// Registra los modulos de src/main/modules (cada uno agrega sus propios canales).
async function registerModules(ctx) {
  await modulesLoader.register(ctx);
}

// Internal service calls reuse the same validation as ordinary UI actions.
// This dispatcher is never exposed directly to renderer code.
async function invokeLocal(channel, ...args) {
  const fn = registeredHandlers.get(channel);
  if (!fn) throw new Error(`Launcher operation unavailable: ${channel}`);
  return fn(...args);
}

module.exports = { register, registerModules, handle, safePath, invokeLocal };
