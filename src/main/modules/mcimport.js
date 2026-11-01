'use strict';
// Importar desde el launcher oficial de Minecraft: los perfiles pasan a instancias nuevas de Venus con sus mundos,
// mods, paquetes de recursos, shaders, configuracion, opciones (options.txt, optionsof.txt) y servidores
// (servers.dat). Solo copia: nunca escribe, mueve ni borra nada de la carpeta del launcher oficial, y no importa
// cuentas, tokens ni argumentos de Java.
// La logica sin Electron vive en ./mcimport/: profiles.js (launcher_profiles*.json), versions.js (version y
// loader), scan.js (carpetas y contenido), plan.js (que va a cada instancia), runner.js (copia y crea) y
// running.js (Minecraft abierto). Pruebas: node --test "src/main/modules/mcimport/test/"
//
// Canales:
//   mcimport:detect()          -> { found, dir, profiles, worlds }  rapido y sin red (sugerencia de la bienvenida)
//   mcimport:scan(dir?)        -> escaneo completo (sin dir: la carpeta por defecto; si no, una elegida con pickFolder)
//   mcimport:pickFolder()      -> carpeta elegida (o null)
//   mcimport:import(seleccion) -> tarea { kind: 'mcimport' }; { instances: [{ id, name, ... }], stats, bytes, worlds }
//   mcimport:cancel()          -> cancela la importacion en curso
//   mcimport:status()          -> { running, taskId }
// Errores con err.code: busy, notAllowed, nothing, changed, tooMany, gameRunning, worldOpen, noSpace, cancelled, failed.
// Carpeta propia: <datos>/mcimport/ (solo temporales de la copia; se borran al terminar y al abrir el launcher).
// Marca en cada instancia creada: venus-instance.json -> mcimport { from: 'official', dir, profile, profileName, at }.
const fsp = require('fs/promises');
const path = require('path');
const paths = require('../core/paths');
const instances = require('../core/instances');
const tasks = require('../core/tasks');
const { t } = require('../core/i18n');
const { devEnv } = require('../core/app-config');
const scanner = require('./mcimport/scan');
const { buildPlan, normalizeSelection } = require('./mcimport/plan');
const { runPlan, cleanStaging, freeSpace } = require('./mcimport/runner');
const running = require('./mcimport/running'); // por el objeto: las pruebas reemplazan gameDirsInUse

const SCAN_TTL = 15 * 60 * 1000;
const SPACE_MARGIN = 256 * 1024 * 1024;
const MANIFEST_TIMEOUT = 8000;
const MAX_MANIFEST = 8 * 1024 * 1024;

let current = null; // { task, done }
let starting = false; // un pedido de importar que todavia arma el plan (dos clics seguidos: el segundo es "busy")
const allowed = new Set(); // carpetas que la interfaz puede pedir escanear (la de por defecto y las elegidas)
const scans = new Map(); // carpeta -> { scan, at }

const keyOf = (dir) => (process.platform === 'win32' ? path.resolve(dir).toLowerCase() : path.resolve(dir));

function codeError(key, code, vars) {
  return Object.assign(new Error(t(`mcimport.${key}`, vars)), { code });
}

function fmtBytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Math.max(0, Number(n) || 0);
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

function stagingRoot() {
  return path.join(paths.root(), 'mcimport');
}

// Carpeta del launcher oficial. En desarrollo (sin empaquetar) VENUS_MC_DIR la pisa para probar con una falsa.
function defaultDir() {
  const env = devEnv() && typeof process.env.VENUS_MC_DIR === 'string' ? process.env.VENUS_MC_DIR.trim() : '';
  return env ? path.resolve(env) : scanner.defaultDirs()[0];
}

function isAllowed(dir) {
  return typeof dir === 'string' && dir.length > 0 && dir.length <= 1024 && allowed.has(keyOf(dir));
}

const NAMES = {
  latestRelease: (v) => t('mcimport.nameLatestRelease', { version: v }),
  latestSnapshot: (v) => t('mcimport.nameLatestSnapshot', { version: v }),
  unnamed: (loader, v) => t('mcimport.nameUnnamed', { loader: instances.LOADER_NAMES[loader] || loader, version: v }),
};

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('timeout')), ms)))]).finally(() => clearTimeout(timer));
}

async function readSmallJson(file) {
  try {
    const st = await fsp.stat(file);
    if (!st.isFile() || st.size > MAX_MANIFEST) return null;
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

const validManifest = (m) => Boolean(m && typeof m === 'object' && Array.isArray(m.versions) && m.latest && typeof m.latest.release === 'string');

// Manifest de Mojang para "ultima version" y para reconocer versiones vanilla: primero el que ya guardo Venus,
// despues la copia del launcher oficial y, si no hay ninguno, la red (el usuario abrio el dialogo).
async function manifestFor(root, { network }) {
  const cached = await readSmallJson(paths.cache('version_manifest_v2.json'));
  if (validManifest(cached)) return cached;
  for (const f of ['version_manifest_v2.json', 'version_manifest.json']) {
    const m = await readSmallJson(path.join(root, 'versions', f));
    if (validManifest(m)) return m;
  }
  if (!network) return null;
  try {
    const m = await withTimeout(require('../core/minecraft').getManifest(), MANIFEST_TIMEOUT);
    return validManifest(m) ? m : null;
  } catch {
    return null;
  }
}

async function realList(list) {
  if (!Array.isArray(list)) return null;
  return Promise.all(list.map((d) => fsp.realpath(d).catch(() => path.resolve(d))));
}

async function doScan(dir) {
  const target = path.resolve(dir);
  const existing = await instances.list().catch(() => []);
  const manifest = await manifestFor(target, { network: true });
  const scan = await scanner.scanFolder(target, { venusRoot: paths.root(), manifest, existing, names: NAMES });
  if (scan.dir) {
    allowed.add(keyOf(scan.dir));
    scans.set(keyOf(scan.dir), { scan, at: Date.now() });
  }
  scans.set(keyOf(target), { scan, at: Date.now() });
  return scan;
}

// Lo que ve la interfaz (sin rutas que no hagan falta: el contenido se identifica por carpeta y nombre).
// defReal: la carpeta por defecto resuelta (scan.dir es la real: si .minecraft es una union, igual es "la detectada").
function publicScan(scan, requested, defReal) {
  const def = defaultDir();
  const dir = scan.dir || requested;
  return {
    dir,
    defaultDir: def,
    isDefault: scanner.samePath(dir, def) || Boolean(defReal && scanner.samePath(dir, defReal)),
    found: scan.found,
    reason: scan.reason || null,
    files: scan.files || [],
    errors: scan.errors || [],
    latest: scan.latest || null,
    links: scan.links || 0,
    partial: Boolean(scan.partial),
    profiles: (scan.profiles || []).map((p) => ({
      id: p.id,
      type: p.type,
      name: p.name,
      suggestedName: p.suggestedName,
      versionId: p.versionId,
      latestType: p.latestType,
      synthetic: p.synthetic,
      source: p.source,
      icon: p.icon,
      lastUsed: p.lastUsed,
      selected: p.selected,
      groupId: p.groupId,
      version: p.version,
      modded: p.modded,
      imported: p.imported,
    })),
    groups: (scan.groups || []).map((g) => ({ id: g.id, dir: g.dir, label: g.label, isRoot: g.isRoot, exists: g.exists, problem: g.problem, shared: g.shared, profileIds: g.profileIds, hasContent: g.hasContent, content: g.content })),
  };
}

function progressText(p) {
  if (p.phase === 'create') return t('mcimport.stepCreate', { name: p.instance });
  return t(`mcimport.copy_${p.category}`, { name: p.instance, done: fmtBytes(p.done), total: fmtBytes(p.total) });
}

// Error del copiado -> mensaje para el usuario con codigo estable.
function userError(err) {
  if (err?.code === 'worldOpen') return codeError('errWorldOpen', 'worldOpen', { name: err.world || '' });
  if (err?.code === 'ENOSPC') return codeError('errDiskFull', 'noSpace');
  if (['busy', 'notAllowed', 'nothing', 'changed', 'tooMany', 'gameRunning', 'noSpace', 'cancelled', 'failed'].includes(err?.code) && err.message) return err;
  const out = codeError('errFailed', 'failed', { error: err?.message || String(err) });
  out.cause = err;
  return out;
}

async function runImport(scan, plan, send) {
  const task = new tasks.Task(t('mcimport.taskTitle', { count: plan.instances.length }), { kind: 'mcimport' });
  let release;
  current = { task, done: new Promise((r) => (release = r)) };
  const aborted = () => task.signal.aborted;
  try {
    task.update({ detail: t('mcimport.stepCheck'), progress: null });
    // Minecraft abierto desde una carpeta que se va a copiar: los mundos podrian quedar a medio guardar.
    const dirs = plan.groups.map((g) => g.dir);
    if (dirs.length) {
      const inUse = await realList(await running.gameDirsInUse().catch(() => null));
      const busyDir = running.findInUse(dirs, inUse);
      if (busyDir) throw codeError('errGameRunning', 'gameRunning', { dir: busyDir });
    }
    if (aborted()) throw task.signal.reason;
    const free = await freeSpace(paths.root());
    if (free !== null && plan.bytes + SPACE_MARGIN > free) throw codeError('errNoSpace', 'noSpace', { need: fmtBytes(plan.bytes), free: fmtBytes(free) });
    let last = 0;
    const result = await runPlan(plan, {
      stagingRoot: stagingRoot(),
      venusRoot: paths.root(),
      signal: task.signal,
      meta: { dir: scan.dir },
      createInstance: (o) => instances.create(o),
      markInstance: (id, meta) => instances.update(id, { mcimport: meta }),
      removeInstance: (id) => fsp.rm(instances.dir(id), { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }),
      onProgress: (p) => {
        const now = Date.now();
        if (p.phase === 'copy' && now - last < 150) return;
        last = now;
        task.update({ detail: progressText(p), progress: p.phase === 'create' ? 0.97 : Math.min(0.95, (p.done / p.total) * 0.95) });
      },
    });
    scans.clear(); // los perfiles importados cambian la marca de "ya importado"
    task.done(t('mcimport.taskDone', { count: result.instances.length }));
    send('instances:changed');
    return { instances: result.instances, stats: result.stats, bytes: plan.bytes, worlds: plan.worlds };
  } catch (err) {
    send('instances:changed');
    if (aborted()) {
      // El panel de tareas lo muestra como cancelado (el motivo es el de core/tasks) y la interfaz recibe el codigo.
      task.fail(task.signal.reason instanceof Error ? task.signal.reason : new Error('Cancelado por el usuario'));
      throw codeError('errCancelled', 'cancelled');
    }
    const out = userError(err);
    if (out.code === 'failed') console.error('[mcimport] importacion', err);
    task.fail(out);
    throw out;
  } finally {
    current = null;
    release();
  }
}

function register({ handle, send, getWindow, onQuit }) {
  allowed.add(keyOf(defaultDir()));
  cleanStaging(stagingRoot()).catch(() => {});
  const emit = (channel, ...args) => {
    try {
      send(channel, ...args);
    } catch {
      /* ventana cerrada */
    }
  };

  handle('mcimport:detect', async () => {
    try {
      const dir = defaultDir();
      const r = await scanner.quickDetect(dir, { venusRoot: paths.root() });
      if (!r.found) return { found: false };
      allowed.add(keyOf(r.dir));
      return { found: true, dir: r.dir, profiles: r.profiles, worlds: r.worlds };
    } catch {
      return { found: false };
    }
  });

  handle('mcimport:scan', async (dir) => {
    const target = typeof dir === 'string' && dir ? dir : defaultDir();
    if (!isAllowed(target)) throw codeError('errNotAllowed', 'notAllowed');
    const scan = await doScan(target);
    const defReal = await fsp.realpath(defaultDir()).catch(() => null);
    return publicScan(scan, target, defReal);
  });

  handle('mcimport:pickFolder', async () => {
    const { dialog } = require('electron');
    const def = defaultDir();
    const defExists = await fsp.stat(def).then((s) => s.isDirectory()).catch(() => false);
    const r = await dialog.showOpenDialog(getWindow(), {
      title: t('mcimport.pickTitle'),
      defaultPath: defExists ? def : path.dirname(def),
      properties: ['openDirectory', 'showHiddenFiles'],
    });
    if (r.canceled || !r.filePaths?.[0]) return null;
    let dir = path.resolve(r.filePaths[0]);
    // Si eligio la carpeta de arriba (por ejemplo Roaming), se usa la .minecraft de adentro.
    const inner = path.join(dir, path.basename(def));
    const hasProfiles = (d) => fsp.stat(path.join(d, 'launcher_profiles.json')).then(() => true, () => false);
    if (!(await hasProfiles(dir)) && (await hasProfiles(inner))) dir = inner;
    allowed.add(keyOf(dir));
    return dir;
  });

  handle('mcimport:import', async (selection) => {
    if (current || starting) throw codeError('errBusy', 'busy');
    starting = true;
    let scan;
    let plan;
    try {
      const sel = normalizeSelection(selection);
      if (!isAllowed(sel.dir)) throw codeError('errNotAllowed', 'notAllowed');
      let entry = scans.get(keyOf(sel.dir));
      if (!entry || Date.now() - entry.at > SCAN_TTL) entry = { scan: await doScan(sel.dir) };
      scan = entry.scan;
      if (!scan.found) throw codeError('errChanged', 'changed');
      const existing = await instances.list().catch(() => []);
      plan = buildPlan(scan, sel, { existingNames: existing.map((i) => i.name) });
      if (plan.error) {
        const key = { nothing: 'errNothing', tooMany: 'errTooMany' }[plan.error] || 'errChanged';
        throw codeError(key, plan.error);
      }
    } finally {
      starting = false;
    }
    // runImport marca la tarea en curso antes de su primer await: no queda un hueco para otro pedido.
    return runImport(scan, plan, emit);
  });

  handle('mcimport:cancel', () => {
    if (!current) return false;
    current.task.cancel();
    return true;
  });

  handle('mcimport:status', () => ({ running: Boolean(current), taskId: current?.task.id || null }));

  // Al cerrar el launcher: se cancela y se espera la limpieza (sin instancias a medias ni temporales).
  onQuit(async () => {
    if (!current) return;
    const { done } = current;
    current.task.cancel();
    await withTimeout(done, 3500).catch(() => {});
  });
}

module.exports = { register, defaultDir };
