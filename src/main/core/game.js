'use strict';
// Gestor de partidas en ejecucion: prepara, lanza, sigue el proceso y registra estadisticas.
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const instances = require('./instances');
const launch = require('./launch');
const java = require('./java');
const stats = require('./stats');
const tasks = require('./tasks');
const { t, getLanguage } = require('./i18n');

const events = new EventEmitter();
const running = new Map(); // instanceId -> { child, pid, startedAt, logs, state, quiet }
// A file operation may need the source stopped for its full duration. Claim before
// the first await; start() checks the same lease before preparing any game files.
const stoppedLeases = new Set();
function fileOperationBusy() {
  const err = new Error(getLanguage() === 'es' ? 'Esperá a que termine la operación de archivos de esta instancia.' : 'Wait for this instance file operation to finish.');
  err.code = 'instanceBusy';
  return err;
}
async function withStoppedInstance(id, operation) {
  if (running.has(id)) {
    const err = new Error(t('core.errAlreadyRunning'));
    err.code = 'alreadyRunning';
    throw err;
  }
  if (stoppedLeases.has(id)) throw fileOperationBusy();
  stoppedLeases.add(id);
  try { return await operation(); }
  finally { stoppedLeases.delete(id); }
}
const MAX_LOG = 5000;

// Chequeos previos al lanzamiento que registran otros modulos (seguridad, mixins, rendimiento...).
// Cada funcion recibe { id, instance, resolved, settings, quiet } y puede devolver
// { block: true, message } para impedir el arranque, { warnings: [texto, ...] } para avisar y/o
// { memory: { min, max } } (MB) para la memoria de esta partida cuando la instancia no tiene memoria propia.
// `settings` es una copia para esta partida: modificarla (p. ej. settings.memory) no toca los ajustes guardados.
const beforeLaunch = [];
function addBeforeLaunch(fn) {
  beforeLaunch.push(fn);
}

// { min, max } en MB devuelto por un chequeo previo, o null si no es valido.
function hookMemory(m) {
  if (!m || typeof m !== 'object') return null;
  const max = Math.round(Number(m.max));
  if (!Number.isFinite(max) || max <= 0) return null;
  const min = Math.round(Number(m.min));
  return { min: Number.isFinite(min) && min > 0 ? Math.min(min, max) : Math.min(1024, max), max };
}

// Copia de los ajustes para una partida (los chequeos previos pueden ajustarla sin persistir nada).
function launchSettings(s) {
  if (!s || typeof s !== 'object') return {};
  try {
    return structuredClone(s);
  } catch {
    return { ...s };
  }
}

const PRIORITY = {
  low: os.constants.priority.PRIORITY_BELOW_NORMAL,
  normal: os.constants.priority.PRIORITY_NORMAL,
  above: os.constants.priority.PRIORITY_ABOVE_NORMAL,
  high: os.constants.priority.PRIORITY_HIGH,
};

function pushLogs(id, lines) {
  const r = running.get(id);
  if (r) {
    r.logs.push(...lines);
    if (r.logs.length > MAX_LOG) r.logs.splice(0, r.logs.length - MAX_LOG);
  }
  events.emit('log', id, lines);
  for (const l of lines) detectActivity(id, l.text || '');
}

// ---------- Actividad (que esta haciendo el jugador) ----------
// { type: 'menu' } | { type: 'singleplayer', world: '<carpeta en saves/>' | null } | { type: 'server', address }
// La usan Discord, amigos (presencia) y la linea de tiempo de mundos: events.on('activity', (id, act) => ...)
const activities = new Map();

function setActivity(id, act) {
  // En las partidas de prueba (quiet) la actividad lleva la marca para que se pueda ignorar.
  const next = running.get(id)?.quiet ? { ...act, quiet: true } : { ...act };
  const prev = activities.get(id);
  if (prev && JSON.stringify({ ...prev, since: 0 }) === JSON.stringify({ ...next, since: 0 })) return;
  const value = { ...next, since: Date.now() };
  activities.set(id, value);
  events.emit('activity', id, value);
}

async function currentWorldFolder(id) {
  // El mundo abierto es el que tiene el session.lock mas reciente.
  const fsp = require('fs/promises');
  const saves = path.join(instances.dir(id), 'saves');
  let best = null;
  try {
    for (const name of await fsp.readdir(saves)) {
      const st = await fsp.stat(path.join(saves, name, 'session.lock')).catch(() => null);
      if (st && (!best || st.mtimeMs > best.time)) best = { name, time: st.mtimeMs };
    }
  } catch {
    /* sin carpeta saves */
  }
  return best && Date.now() - best.time < 5 * 60 * 1000 ? best.name : null;
}

function detectActivity(id, text) {
  let m = text.match(/Connecting to ([^\s,]+),\s*(\d+)/);
  if (m) {
    setActivity(id, { type: 'server', address: m[2] === '25565' ? m[1] : `${m[1]}:${m[2]}` });
    return;
  }
  if (/Starting integrated minecraft server/i.test(text)) {
    setActivity(id, { type: 'singleplayer', world: null });
    setTimeout(async () => {
      const world = await currentWorldFolder(id);
      const cur = activities.get(id);
      if (world && cur?.type === 'singleplayer') setActivity(id, { type: 'singleplayer', world });
    }, 4000);
    return;
  }
  if (/Stopping singleplayer server|Stopping server|Disconnecting from server|Lost connection|Disconnected from server/i.test(text)) {
    setActivity(id, { type: 'menu' });
  }
}

function activity(id) {
  return activities.get(id) || null;
}

/**
 * opts: { account, settings, quickPlay, launcherVersion, skipChecks, quiet }
 *  - skipChecks: no corre los chequeos previos (addBeforeLaunch).
 *  - quiet: partida de prueba (la busqueda del culpable de un crash): no se registra en estadisticas
 *    ni suma tiempo jugado/partidas, y cada evento 'state', 'session' y 'activity' lleva quiet: true
 *    (al cerrar, la actividad es null y la marca va como tercer argumento: (id, null, { quiet: true })).
 */
async function start(id, opts = {}) {
  if (stoppedLeases.has(id)) throw fileOperationBusy();
  if (running.has(id)) {
    const err = new Error(t('core.errAlreadyRunning'));
    err.code = 'alreadyRunning';
    throw err;
  }
  const quiet = opts.quiet === true;
  const mark = (payload) => (quiet ? { ...payload, quiet: true } : payload);
  const { account } = opts;
  const settings = launchSettings(opts.settings);
  running.set(id, { child: null, pid: null, startedAt: Date.now(), logs: [], state: 'preparing', quiet });
  events.emit('state', id, mark({ state: 'preparing' }));
  // Si algo falla antes de abrir el juego, la instancia no queda marcada como "en ejecucion".
  const fail = (err) => {
    running.delete(id);
    events.emit('state', id, mark({ state: 'stopped', error: err?.message || String(err) }));
    return err;
  };
  let prepared;
  try {
    const inst0 = await instances.get(id);
    prepared = await tasks.run(t('instances.taskPreparing', { name: inst0.name }), (task) => instances.prepare(id, task), { instanceId: id });
  } catch (err) {
    throw fail(err);
  }
  const { instance, resolved, javaPath } = prepared;
  let memoryFromChecks = null;
  if (!opts.skipChecks) {
    const warnings = [];
    for (const check of beforeLaunch) {
      let r = null;
      try {
        r = await check({ id, instance, resolved, settings, quiet });
      } catch (err) {
        console.error('[game] chequeo previo', err);
      }
      if (r?.block) {
        running.delete(id);
        events.emit('state', id, mark({ state: 'stopped', error: r.message }));
        const err = new Error(r.message || t('core.errLaunchBlocked'));
        err.code = 'blocked';
        throw err;
      }
      if (r?.warnings?.length) warnings.push(...r.warnings);
      const m = hookMemory(r?.memory);
      if (m) memoryFromChecks = m; // si varios devuelven memoria, gana el ultimo
    }
    if (warnings.length) events.emit('warnings', id, warnings);
  }
  // Memoria: la propia de la instancia; si no tiene, la que calculo un chequeo previo (rendimiento) o la global.
  // (Los chequeos viejos que asignan settings.memory siguen funcionando: es la copia de esta partida.)
  const mem = (instance.memory?.override ? instance.memory : memoryFromChecks || settings.memory) || {};
  const win = instance.window?.override ? instance.window : settings.window || {};
  const jvmArgs = [settings.jvmArgs, instance.java?.args].filter(Boolean).join(' ');

  let info;
  let cmd;
  try {
    info = await java.getJavaVersion(javaPath);
    cmd = await launch.buildCommand({
      resolved,
      gameDir: instance.dir,
      account,
      javaPath,
      javaMajor: info?.major,
      memory: mem,
      jvmPreset: instance.java?.preset || settings.jvmPreset,
      jvmArgs,
      window: win,
      quickPlay: opts.quickPlay,
      launcherVersion: opts.launcherVersion,
    });
  } catch (err) {
    throw fail(err);
  }

  const entry = running.get(id);
  const memVars = { min: mem.min ?? '?', max: mem.max ?? '?', account: account?.name ?? '?' };
  pushLogs(id, [
    { level: 'INFO', text: `[Venus] ${t('core.logStarting', { name: instance.name, version: resolved.id, java: info?.version || '?' })}` },
    { level: 'INFO', text: `[Venus] ${t(account?.type === 'msa' ? 'core.logMemoryMicrosoft' : 'core.logMemoryOffline', memVars)}` },
  ]);
  const startedAt = Date.now();
  const onExit = async (code) => {
    const r = running.get(id);
    running.delete(id);
    const endedAt = Date.now();
    const crashed = code !== 0 && code !== null && !r?.killed;
    events.emit('state', id, mark({ state: crashed ? 'crashed' : 'stopped', code, logs: crashed ? (r?.logs || []).slice(-80) : undefined }));
    events.emit('session', mark({ instanceId: id, start: startedAt, end: endedAt, crashed, code, killed: Boolean(r?.killed), logs: r?.logs || [] }));
    activities.delete(id);
    if (quiet) events.emit('activity', id, null, { quiet: true });
    else events.emit('activity', id, null);
    if (quiet) return; // partida de prueba: no cuenta en estadisticas, tiempo jugado ni partidas
    try {
      const cur = await instances.get(id);
      await instances.update(id, {
        lastPlayed: endedAt,
        playtime: (cur.playtime || 0) + (endedAt - startedAt),
        launches: (cur.launches || 0) + 1,
      });
      await stats.recordSession({
        instanceId: id,
        name: cur.name,
        mcVersion: cur.mcVersion,
        loader: cur.preset || cur.loader,
        start: startedAt,
        end: endedAt,
        crashed,
      });
    } catch {
      /* la instancia pudo ser borrada */
    }
  };
  let child;
  try {
    child = launch.spawnGame(cmd, { onLine: (l) => pushLogs(id, [l]), onExit });
  } catch (err) {
    throw fail(err);
  }
  entry.child = child;
  entry.pid = child.pid;
  entry.state = 'running';
  entry.startedAt = startedAt;
  if (child.pid && settings.priority && settings.priority !== 'normal') {
    try {
      os.setPriority(child.pid, PRIORITY[settings.priority] ?? PRIORITY.normal);
    } catch {
      /* sin permisos para cambiar prioridad */
    }
  }
  events.emit('state', id, mark({ state: 'running', pid: child.pid, startedAt }));
  setActivity(id, { type: 'menu' });
  return { pid: child.pid };
}

function stop(id) {
  const r = running.get(id);
  if (!r || !r.child) return false;
  r.killed = true;
  try {
    if (process.platform === 'win32') {
      require('child_process').spawn('taskkill', ['/pid', String(r.pid), '/T', '/F'], { windowsHide: true });
    } else {
      r.child.kill('SIGTERM');
    }
  } catch {
    r.child.kill();
  }
  return true;
}

function status() {
  const out = {};
  for (const [id, r] of running) out[id] = r.quiet ? { state: r.state, pid: r.pid, startedAt: r.startedAt, quiet: true } : { state: r.state, pid: r.pid, startedAt: r.startedAt };
  return out;
}

function logs(id) {
  return running.get(id)?.logs || [];
}

function pids() {
  return [...running.values()].filter((r) => r.pid).map((r) => r.pid);
}

module.exports = { start, stop, status, logs, pids, events, addBeforeLaunch, activity, withStoppedInstance, crashReportsDir: (inst) => path.join(inst.dir, 'crash-reports') };
