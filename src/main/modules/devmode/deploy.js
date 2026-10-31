'use strict';
// Despliegue del jar en el servidor de desarrollo y recarga del plugin:
//  - servidor apagado: se copia a plugins/ (reemplaza la version anterior) y se carga al iniciar.
//  - "restart" (por defecto, lo mas seguro): stop -> copiar -> start.
//  - "reload": el jar nuevo va a plugins/update/ con el nombre del actual y se manda "reload confirm"
//    (Paper y Spigot lo reemplazan cuando ya cerraron el anterior, sin pelear con archivos bloqueados).
//  - "plugman": /plugman unload -> copiar -> /plugman load (PlugManX). Si algo falla, reinicio completo.
// Tambien arma la bandera de depuracion remota (JDWP) para IntelliJ.
const fsp = require('fs/promises');
const net = require('net');
const path = require('path');
const plugman = require('./plugman');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const JDWP_RE = /(^|\s)-agentlib:jdwp=\S+/g;

// Nombre fijo del jar en plugins/: "MiPlugin.jar" (asi /reload y PlugManX siempre encuentran el mismo archivo).
function stableName(name) {
  const base =
    String(name || 'plugin')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^\w.-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 60) || 'plugin';
  return `${base}.jar`;
}

function portFree(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

// Java con el que corre el servidor (para la sintaxis de JDWP: Java 8 no entiende "*:puerto").
function serverJavaMajor(s) {
  if (s?.javaMajor) return Number(s.javaMajor);
  const m = String(s?.mcVersion || '').match(/^1\.(\d+)/);
  if (m && Number(m[1]) < 17) return 8;
  return 21;
}

function debugFlag({ port, anyHost }, javaMajor) {
  let address;
  if (javaMajor && javaMajor < 9) address = anyHost ? String(port) : `127.0.0.1:${port}`;
  else address = `${anyHost ? '*' : '127.0.0.1'}:${port}`;
  return `-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=${address}`;
}

// Argumentos de Java del servidor con (o sin) la bandera de depuracion; respeta el resto de lo que haya.
function withDebugArgs(args, flag) {
  const clean = String(args || '').replace(JDWP_RE, ' ').replace(/\s+/g, ' ').trim();
  return flag ? `${clean} ${flag}`.trim() : clean;
}

function createDeployer({ servers, tasks, t, trash, onPhase, onEvent }) {
  const phase = (projectId, p) => onPhase?.(projectId, p);
  const event = (projectId, level, kind, key, vars) => onEvent?.(projectId, { level, kind, key, vars: vars || {} });

  const pluginsDir = (sid) => path.join(servers.dir ? servers.dir(sid) : require('../../core/paths').server(sid), 'plugins');

  async function stateOf(sid) {
    if (typeof servers.runtimeState === 'function') return servers.runtimeState(sid);
    try {
      return (await servers.get(sid)).state || 'offline';
    } catch {
      return 'offline';
    }
  }

  // Espera un estado del servidor (o el tiempo maximo). Devuelve el estado final.
  // initial=false: solo cuenta un cambio que llegue despues (por ejemplo, esperar "online" antes de iniciar).
  function waitState(sid, wanted, ms, { initial = true } = {}) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (st) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        servers.events.off('state', onState);
        resolve(st);
      };
      const onState = (id, st) => {
        if (id === sid && wanted.includes(st.state)) finish(st.state);
      };
      const timer = setTimeout(async () => finish(await stateOf(sid)), ms);
      servers.events.on('state', onState);
      if (initial) stateOf(sid).then((st) => wanted.includes(st) && finish(st));
    });
  }

  // Espera una linea de la consola. ok/fail: listas de expresiones. -> { status: 'ok'|'fail'|'timeout'|'offline', line }
  function waitForLog(sid, { ok = [], fail = [] }, ms) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (r) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        servers.events.off('log', onLog);
        servers.events.off('state', onState);
        resolve(r);
      };
      const onLog = (id, line) => {
        if (id !== sid || !line?.text) return;
        if (fail.some((re) => re.test(line.text))) finish({ status: 'fail', line: line.text });
        else if (ok.some((re) => re.test(line.text))) finish({ status: 'ok', line: line.text });
      };
      const onState = (id, st) => {
        if (id === sid && st.state === 'offline') finish({ status: 'offline' });
      };
      const timer = setTimeout(() => finish({ status: 'timeout' }), ms);
      servers.events.on('log', onLog);
      servers.events.on('state', onState);
    });
  }

  // Durante un rato despues de cargar, avisa si el plugin fallo al habilitarse.
  function watchPluginErrors(projectId, sid, { name, file }, ms = 30000) {
    const res = [
      name && new RegExp(`Error occurred while (enabling|loading) ${esc(name)}\\b`, 'i'),
      file && new RegExp(`Could not load (plugin )?'[^']*${esc(file)}'`, 'i'),
      name && new RegExp(`Ambiguous plugin name .?${esc(name)}\\b`, 'i'),
      name && new RegExp(`(Error|Exception) (occurred )?while (enabling|loading|initializing) .*\\b${esc(name)}\\b`, 'i'),
    ].filter(Boolean);
    let reported = false;
    const onLog = (id, line) => {
      if (reported || id !== sid || !line?.text) return;
      if (res.some((re) => re.test(line.text))) {
        reported = true;
        event(projectId, 'bad', 'deploy', 'ev_pluginError', { line: line.text.slice(0, 300) });
      }
    };
    servers.events.on('log', onLog);
    setTimeout(() => servers.events.off('log', onLog), ms);
  }

  async function removeQuiet(p) {
    try {
      if (trash) await trash(p);
      else await fsp.rm(p, { force: true });
    } catch {
      await fsp.rm(p, { force: true }).catch(() => {});
    }
  }

  // Copia atomica (tmp + rename) con reintentos si el archivo destino esta bloqueado.
  async function copyInto(src, dest, retries = 8) {
    const tmp = `${dest}.venus-tmp`;
    await fsp.copyFile(src, tmp);
    let last = null;
    for (let i = 0; i < retries; i++) {
      try {
        await fsp.rename(tmp, dest);
        return;
      } catch (err) {
        last = err;
        if (!['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) break;
        await sleep(350 + i * 150);
      }
    }
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw Object.assign(new Error(t('devmode.errLocked', { file: path.basename(dest) })), { code: 'locked', cause: last });
  }

  // Copia con el servidor apagado (o el plugin descargado): reemplaza y quita copias viejas del mismo plugin.
  async function place({ jar, sid, previous }) {
    const dir = pluginsDir(sid);
    await fsp.mkdir(dir, { recursive: true });
    const name = jar.plugin?.name || null;
    const target = stableName(name || path.basename(jar.file, path.extname(jar.file)));
    const scanned = await plugman.scanPlugins(dir);
    await copyInto(jar.path, path.join(dir, target));
    for (const o of scanned) {
      if (o.file.toLowerCase() === target.toLowerCase()) continue;
      const same = name && o.name && o.name.toLowerCase() === name.toLowerCase();
      const prev = previous && o.file.toLowerCase() === previous.toLowerCase();
      if (same || prev) await removeQuiet(o.path);
    }
    // Restos de un /reload anterior que no se aplico
    await fsp.rm(path.join(dir, 'update', target), { force: true }).catch(() => {});
    return { file: target };
  }

  // Bandera de depuracion en los argumentos de Java del servidor (antes de cada inicio).
  async function applyDebug(project, sid) {
    const s = await servers.get(sid);
    const opts = project.server || {};
    const flag = opts.debug ? debugFlag({ port: opts.debugPort, anyHost: opts.debugAnyHost }, serverJavaMajor(s)) : null;
    if (flag && !(await portFree(opts.debugPort, opts.debugAnyHost ? '0.0.0.0' : '127.0.0.1'))) throw new Error(t('devmode.errDebugPort', { port: opts.debugPort }));
    const next = withDebugArgs(s.java?.args, flag);
    if (next === String(s.java?.args || '').trim()) return flag;
    if (typeof servers.update === 'function') await servers.update(sid, { java: { args: next } });
    else await servers.patchMeta(sid, (cur) => ({ ...cur, java: { ...(cur.java || {}), args: next } }));
    return flag;
  }

  async function stopAndWait(sid) {
    if ((await stateOf(sid)) === 'offline') return true;
    servers.stop(sid);
    let st = await waitState(sid, ['offline'], 70000);
    if (st !== 'offline') {
      if (typeof servers.kill === 'function') servers.kill(sid);
      st = await waitState(sid, ['offline'], 15000);
    }
    return st === 'offline';
  }

  async function startServer(project, sid, title) {
    await applyDebug(project, sid);
    return tasks.run(title, (task) => servers.start(sid, task), { serverId: sid, devmode: project.id });
  }

  // Reinicio completo con el jar nuevo.
  async function restartWith({ project, jar, sid, server, previous }) {
    phase(project.id, 'stopping');
    event(project.id, 'info', 'reload', 'ev_restart', {});
    const ok = await stopAndWait(sid);
    if (!ok) throw new Error(t('devmode.errStopTimeout'));
    phase(project.id, 'copying');
    const placed = await place({ jar, sid, previous });
    phase(project.id, 'starting');
    const onlineWait = waitState(sid, ['online', 'offline'], 5 * 60 * 1000, { initial: false });
    await startServer(project, sid, t('devmode.taskRestart', { name: server.name }));
    watchPluginErrors(project.id, sid, { name: jar.plugin?.name, file: placed.file }, 6 * 60 * 1000);
    phase(project.id, 'waiting');
    const st = await onlineWait;
    if (st === 'online') event(project.id, 'good', 'reload', 'ev_restartDone', { name: jar.plugin?.name || project.name, version: jar.plugin?.version || '' });
    else event(project.id, 'bad', 'server', 'ev_restartFailed', {});
    return { ...placed, mode: 'restart', ok: st === 'online' };
  }

  // "/reload confirm" usando la carpeta update/ de Bukkit/Paper.
  async function reloadWith({ project, jar, sid, previous, current }) {
    const dir = pluginsDir(sid);
    let file;
    if (!current) {
      phase(project.id, 'copying');
      file = (await place({ jar, sid, previous })).file;
    } else {
      phase(project.id, 'copying');
      const upd = path.join(dir, 'update');
      // Por temporal y renombrado: el jar de update/ puede estar enlazado (deduplicación) con el de otro servidor.
      await require('../packs/safety').copyFileAtomic(jar.path, path.join(upd, current.file));
      file = current.file;
    }
    phase(project.id, 'reloading');
    const started = Date.now();
    const wait = waitForLog(sid, { ok: [/Reload complete/i] }, 3 * 60 * 1000);
    watchPluginErrors(project.id, sid, { name: jar.plugin?.name, file }, 3 * 60 * 1000);
    servers.command(sid, 'reload confirm');
    event(project.id, 'info', 'reload', 'ev_reloadSent', {});
    const r = await wait;
    if (r.status === 'offline') throw new Error(t('devmode.errServerStopped'));
    // Si el servidor no aplico update/ (otra implementacion), se reinicia para no dejar la version vieja.
    if (current) {
      const pendingFile = path.join(dir, 'update', current.file);
      const stillThere = await fsp
        .stat(pendingFile)
        .then(() => true)
        .catch(() => false);
      if (stillThere) {
        await fsp.rm(pendingFile, { force: true }).catch(() => {});
        event(project.id, 'warn', 'reload', 'ev_reloadNotApplied', {});
        return restartWith({ project, jar, sid, server: await servers.get(sid), previous: current.file });
      }
    }
    if (r.status === 'timeout') event(project.id, 'warn', 'reload', 'ev_reloadTimeout', {});
    else event(project.id, 'good', 'reload', 'ev_reloadDone', { ms: Date.now() - started });
    return { file, mode: 'reload', ok: r.status === 'ok' };
  }

  // Recarga en caliente con PlugManX. Cae a reinicio completo si no esta o si algo falla.
  async function plugmanWith({ project, jar, sid, server, previous, current, scanned }) {
    const fallback = (key, vars) => {
      event(project.id, 'warn', 'reload', key, vars || {});
      return restartWith({ project, jar, sid, server, previous: current?.file || previous });
    };
    const pm = await plugman.installed(null, scanned);
    if (!pm) return fallback('ev_plugmanMissing');
    if (jar.plugin?.paper) return fallback('ev_plugmanPaperPlugin');
    const name = current?.name || jar.plugin?.name;
    const failRe = /\[PlugMan[^\]]*\].*\b(not|cannot|could ?n.?t|invalid|fail\w*|error|already|unable)\b/i;
    const started = Date.now();
    if (current && name) {
      phase(project.id, 'unloading');
      const w = waitForLog(sid, { ok: [new RegExp(`Disabling ${esc(name)}\\b`, 'i'), new RegExp(`${esc(name)}\\b.*\\bunloaded`, 'i')], fail: [failRe] }, 20000);
      servers.command(sid, `plugman unload ${name}`);
      const r = await w;
      if (r.status === 'offline') throw new Error(t('devmode.errServerStopped'));
      if (r.status === 'fail') return fallback('ev_plugmanFail', { line: r.line.slice(0, 240) });
      // PlugManX cierra el classloader despues de deshabilitar: se le da un momento antes de reemplazar el jar.
      await sleep(600);
    }
    phase(project.id, 'copying');
    let placed;
    try {
      placed = await place({ jar, sid, previous: current?.file || previous });
    } catch (err) {
      if (err.code === 'locked') return fallback('ev_plugmanLocked', { file: current?.file || '' });
      throw err;
    }
    phase(project.id, 'loading');
    const newName = jar.plugin?.name || name;
    const w2 = waitForLog(sid, { ok: [new RegExp(`Enabling ${esc(newName)}\\b`, 'i'), new RegExp(`${esc(newName)}\\b.*(?<!un)loaded`, 'i')], fail: [failRe] }, 30000);
    watchPluginErrors(project.id, sid, { name: newName, file: placed.file }, 40000);
    servers.command(sid, `plugman load ${placed.file.replace(/\.jar$/i, '')}`);
    const r2 = await w2;
    if (r2.status === 'offline') throw new Error(t('devmode.errServerStopped'));
    if (r2.status === 'fail') return fallback('ev_plugmanFail', { line: r2.line.slice(0, 240) });
    if (r2.status === 'timeout') event(project.id, 'warn', 'reload', 'ev_plugmanTimeout', {});
    else event(project.id, 'good', 'reload', 'ev_plugmanDone', { ms: Date.now() - started, version: jar.plugin?.version || '' });
    return { ...placed, mode: 'plugman', ok: r2.status === 'ok' };
  }

  /**
   * Despliega un jar. project: config del proyecto; jar: { path, file, plugin }.
   * Devuelve { file, mode, ok } (mode: 'offline' | 'restart' | 'reload' | 'plugman').
   */
  async function deploy(project, jar) {
    const sid = project.server.id;
    let server = await servers.get(sid);
    let st = await stateOf(sid);
    if (st === 'starting') {
      phase(project.id, 'waiting');
      st = await waitState(sid, ['online', 'offline'], 5 * 60 * 1000);
    } else if (st === 'stopping') {
      phase(project.id, 'waiting');
      st = await waitState(sid, ['offline'], 90000);
    }
    server = await servers.get(sid);
    const previous = project.deployed?.file || null;
    if (st !== 'online') {
      phase(project.id, 'copying');
      const placed = await place({ jar, sid, previous });
      return { ...placed, mode: 'offline', ok: true };
    }
    const scanned = await plugman.scanPlugins(pluginsDir(sid));
    const name = jar.plugin?.name;
    const current =
      (name && scanned.find((p) => p.name && p.name.toLowerCase() === name.toLowerCase())) || (previous && scanned.find((p) => p.file.toLowerCase() === previous.toLowerCase())) || null;
    const mode = project.server.reload;
    const ctx = { project, jar, sid, server, previous, current, scanned };
    if (mode === 'reload') return reloadWith(ctx);
    if (mode === 'plugman') return plugmanWith(ctx);
    return restartWith(ctx);
  }

  return { deploy, place, applyDebug, startServer, stopAndWait, waitState, waitForLog, pluginsDir, stateOf, watchPluginErrors };
}

module.exports = { createDeployer, stableName, debugFlag, withDebugArgs, serverJavaMajor, portFree };
