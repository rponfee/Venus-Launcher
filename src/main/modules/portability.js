'use strict';
// Llevar todo a otra PC: Exportar todo a un .venusbackup e Importar. Que entra lo decide portability/filter.js, el formato
// y sus controles portability/manifest.js y el trabajo portability/archive.js. Nunca incluye cuentas, tokens ni secretos
// (lo cifrado con safeStorage no sirve en otra PC igual), ni cache, ni registros, ni rutas de esta PC. Al importar no se
// pisa nada ni se ejecuta nada de lo que trae el archivo.
//   portability:estimate({ instances, worlds, servers, settings, media }) -> { sizes, total, instances, servers, free, running }
//   portability:export(seleccion)  -> { path, size, files, skipped } o { cancelled: true } (tarea cancelable)
//   portability:pickImport()       -> { token, createdAt, appVersion, instances, servers, settings, categories, free, dropped }
//                                     o { cancelled: true }. Errores: err.code notBackup, badFile, badPath, badManifest,
//                                     newerVersion, tooBig
//   portability:import(token, opciones) -> { instances, worlds, servers, media, settings, skipped } (tarea cancelable). noSpace
//   portability:reveal(ruta)       -> muestra en la carpeta lo ultimo exportado
// Evento portability:imported (el mismo resultado).
const fsp = require('fs/promises');
const path = require('path');
const paths = require('../core/paths');
const game = require('../core/game');
const instances = require('../core/instances');
const servers = require('../core/servers');
const settings = require('../core/settings');
const tasks = require('../core/tasks');
const { t } = require('../core/i18n');
const archive = require('./portability/archive');
const { BackupError } = require('./portability/manifest');

const EXT = 'venusbackup';
const st = { tokens: new Map(), lastExport: null };
const mb = (n) => (n / 1048576).toFixed(n >= 1048576 * 100 ? 0 : 1);

function coded(code, message) {
  return Object.assign(new Error(message), { code });
}

const devDir = (app) => (process.env.VENUS_DEVSHOT && !app.isPackaged ? path.resolve(process.env.VENUS_DEVSHOT) : null);

function friendly(err) {
  if (err instanceof BackupError) {
    const known = ['notBackup', 'badFile', 'badPath', 'badManifest', 'newerVersion', 'tooBig', 'noSpace'];
    const key = known.includes(err.code) ? err.code : 'badFile';
    return coded(key, t(`datatools.import_${key}`, key === 'noSpace' ? { needed: `${mb(err.needed || 0)} MB`, free: `${mb(err.free || 0)} MB` } : undefined));
  }
  return err;
}

// Lo que va a entrar en el archivo tiene que estar quieto
function busyNames(sel, all, srv) {
  const names = [];
  if (sel.instances || sel.worlds || sel.media) {
    const running = game.status();
    for (const i of all) if (running[i.id] && (!sel.instanceIds || sel.instanceIds.includes(i.id))) names.push(i.name);
  }
  if (sel.servers) for (const s of srv) if (s.state !== 'offline' && (!sel.serverIds || sel.serverIds.includes(s.id))) names.push(s.name);
  return names;
}

// Ninguna de estas instancias puede abrirse mientras se comprime
function holdInstances(ids, fn) {
  if (!ids.length) return fn();
  const [first, ...rest] = ids;
  return game.withStoppedInstance(first, () => holdInstances(rest, fn));
}

function register({ app, handle, send, getWindow }) {
  const { dialog, shell } = require('electron');
  const deps = () => ({ instances, servers, settings, appVersion: app.getVersion?.() || '' });

  archive.cleanStaging().catch(() => {});

  handle('portability:estimate', async (selection) => {
    const sel = archive.normalizeSelection(selection);
    const plan = await archive.buildPlan(sel, deps());
    const all = await instances.list().catch(() => []);
    const srv = await servers.list().catch(() => []);
    return {
      sizes: plan.sizes,
      total: plan.total,
      instances: plan.manifest.instances.length,
      servers: plan.manifest.servers.length,
      worlds: plan.manifest.instances.reduce((a, i) => a + i.worlds.length, 0),
      free: await archive.freeBytes(paths.root()),
      running: busyNames(sel, all, srv),
    };
  });

  handle('portability:export', async (selection) => {
    const sel = archive.normalizeSelection(selection);
    if (!archive.CATEGORIES.some((c) => sel[c])) throw coded('badInput', t('datatools.exportNothing'));
    const all = await instances.list().catch(() => []);
    const srv = await servers.list().catch(() => []);
    const busy = busyNames(sel, all, srv);
    if (busy.length) throw coded('gameRunning', t('datatools.exportBusy', { names: busy.slice(0, 3).join(', ') }));

    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const fileName = `Venus-${date}.${EXT}`;
    const dev = devDir(app);
    let dest;
    if (dev) dest = path.join(dev, fileName);
    else {
      const r = await dialog.showSaveDialog(getWindow(), { title: t('datatools.exportDialog'), defaultPath: fileName, filters: [{ name: 'Venus Launcher', extensions: [EXT] }] });
      if (r.canceled || !r.filePath) return { cancelled: true };
      dest = /\.venusbackup$/i.test(r.filePath) ? r.filePath : `${r.filePath}.${EXT}`;
    }
    const ids = sel.instances || sel.worlds || sel.media ? all.filter((i) => !sel.instanceIds || sel.instanceIds.includes(i.id)).map((i) => i.id) : [];
    const res = await tasks.run(
      t('datatools.taskExport'),
      (task) =>
        holdInstances(ids, async () => {
          task.update({ detail: t('datatools.taskScanning'), progress: null });
          const plan = await archive.buildPlan(sel, { ...deps(), signal: task.signal });
          return archive.writeBackup(plan, dest, {
            signal: task.signal,
            onProgress: ({ bytes, totalBytes }) => {
              if (totalBytes) task.update({ detail: t('datatools.taskProgress', { done: mb(bytes), total: mb(totalBytes) }), progress: bytes / totalBytes });
            },
          });
        }),
      { kind: 'portability' },
    );
    st.lastExport = dest;
    return { path: dest, size: res.size, files: res.files, skipped: res.skipped };
  });

  handle('portability:reveal', (p) => {
    if (typeof p !== 'string' || p !== st.lastExport) return false;
    shell.showItemInFolder(p);
    return true;
  });

  handle('portability:pickImport', async () => {
    let file = null;
    const dev = devDir(app);
    if (dev) {
      const names = (await fsp.readdir(dev).catch(() => [])).filter((n) => n.endsWith(`.${EXT}`)).sort();
      if (names.length) file = path.join(dev, names[names.length - 1]);
    }
    if (!file) {
      const r = await dialog.showOpenDialog(getWindow(), { title: t('datatools.importDialog'), properties: ['openFile'], filters: [{ name: 'Venus Launcher', extensions: [EXT] }] });
      if (r.canceled || !r.filePaths?.[0]) return { cancelled: true };
      file = r.filePaths[0];
    }
    let info;
    try {
      info = await archive.inspect(file);
    } catch (err) {
      throw friendly(err);
    }
    const token = String(Date.now());
    st.tokens.clear();
    st.tokens.set(token, file);
    const view = archive.describe(info.manifest, { existingInstances: await instances.list().catch(() => []), existingServers: await servers.list().catch(() => []) });
    return {
      token,
      name: path.basename(file),
      createdAt: info.manifest.createdAt,
      appVersion: info.manifest.appVersion,
      categories: info.manifest.categories,
      settings: info.manifest.settings,
      instances: view.instances,
      servers: view.servers,
      free: await archive.freeBytes(paths.root()),
      dropped: info.valid.dropped,
    };
  });

  handle('portability:import', async (token, options) => {
    const file = st.tokens.get(String(token));
    if (!file) throw coded('badInput', t('datatools.importExpired'));
    let res;
    try {
      res = await tasks.run(
        t('datatools.taskImport'),
        (task) =>
          archive.importBackup(file, options, {
            instances,
            servers,
            settings,
            game,
            signal: task.signal,
            onProgress: ({ bytes, total }) => {
              if (total) task.update({ detail: t('datatools.taskProgress', { done: mb(bytes), total: mb(total) }), progress: bytes / total });
            },
          }),
        { kind: 'portability' },
      );
    } catch (err) {
      throw friendly(err);
    }
    st.tokens.delete(String(token));
    send('instances:changed');
    send('servers:changed');
    send('worlds:updated', { kind: 'list' });
    send('portability:imported', res);
    return res;
  });
}

module.exports = { register };
