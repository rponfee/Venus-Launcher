'use strict';
// Modo desarrollador de plugins: proyectos de Paper/Spigot (Gradle o Maven), build con la salida en vivo,
// compilacion automatica al guardar, servidor Paper/Purpur/Folia de prueba (mundo plano, creativo,
// depuracion remota para IntelliJ), despliegue del jar con reinicio, /reload o PlugManX, y cliente
// conectado con Quick Play.
// Canales: devmode:state, devmode:project, devmode:addProject, devmode:removeProject, devmode:select,
//   devmode:update, devmode:detect, devmode:jdks, devmode:build, devmode:cancelBuild, devmode:buildLog,
//   devmode:deploy, devmode:events, devmode:clearEvents, devmode:serverOptions, devmode:linkableServers,
//   devmode:createServer, devmode:linkServer, devmode:unlinkServer, devmode:startServer, devmode:stopServer,
//   devmode:restartServer, devmode:killServer, devmode:command, devmode:serverLogs, devmode:setOnlineMode,
//   devmode:plugman, devmode:installPlugman, devmode:startSession, devmode:open, devmode:clientLaunched
// Eventos: devmode:changed (projectId), devmode:status (projectId, estado), devmode:buildLog (projectId, lineas),
//   devmode:event (projectId, entrada), devmode:autoLaunch (projectId, { instanceId, port })
const fsp = require('fs/promises');
const path = require('path');
const { t } = require('../core/i18n');
const servers = require('../core/servers');
const tasks = require('../core/tasks');
const { hashFile, uid } = require('../core/util');
const store = require('./devmode/store');
const detect = require('./devmode/detect');
const runner = require('./devmode/runner');
const plugman = require('./devmode/plugman');
const { isTemplated } = require('./devmode/pluginyml');
const { SourceWatcher, JarWatcher, waitStable } = require('./devmode/watch');
const { createDeployer, debugFlag, serverJavaMajor } = require('./devmode/deploy');

const WIN = process.platform === 'win32';
const PLUGIN_SERVER_TYPES = new Set(['paper', 'purpur', 'folia', 'spigot', 'mohist', 'youer']);
const TYPE_NAMES = { paper: 'Paper', purpur: 'Purpur', folia: 'Folia', spigot: 'Spigot', mohist: 'Mohist', youer: 'Youer' };

let ctx = null;
let deployer = null;
const runtime = new Map(); // projectId -> estado en memoria (build, cola, despliegue, vigilancia)
let jdkCache = null;

const send = (...a) => ctx?.send(...a);
const samePath = (a, b) => (WIN ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
const isFile = (p) => fsp.stat(p).then((s) => s.isFile()).catch(() => false);
const isDir = (p) => fsp.stat(p).then((s) => s.isDirectory()).catch(() => false);

function rt(id) {
  if (!runtime.has(id)) {
    runtime.set(id, { build: null, queued: null, lines: [], deploying: false, phase: null, chain: Promise.resolve(), srcWatcher: null, jarWatcher: null, detect: null, autoLaunch: false, lastJarSig: null });
  }
  return runtime.get(id);
}

function statusOf(id) {
  const r = rt(id);
  return {
    building: Boolean(r.build),
    buildStartedAt: r.build?.startedAt || null,
    buildAuto: Boolean(r.build?.auto),
    queued: Boolean(r.queued),
    deploying: r.deploying,
    phase: r.phase,
    watchingSources: Boolean(r.srcWatcher),
    watchingJar: Boolean(r.jarWatcher),
  };
}

const pushStatus = (id) => send('devmode:status', id, statusOf(id));
const changed = (id) => send('devmode:changed', id || null);

async function logEvent(projectId, { level = 'info', kind = 'info', key, vars = {} }) {
  const entry = { id: uid(8), t: Date.now(), level, kind, key, vars };
  try {
    await store.addEvent(projectId, entry);
  } catch (err) {
    console.warn('[devmode] registro', err);
  }
  send('devmode:event', projectId, entry);
  return entry;
}

async function need(id) {
  const p = await store.get(id);
  if (!p) throw new Error(t('devmode.errNotFound'));
  return p;
}

function requireServer(p) {
  if (!p.server.id) throw new Error(t('devmode.errNoServer'));
  return p.server.id;
}

async function getServer(sid) {
  try {
    return await servers.get(sid);
  } catch {
    throw new Error(t('devmode.errServerMissing'));
  }
}

// ---------- Deteccion ----------

async function detectFor(p, { force = false } = {}) {
  const r = rt(p.id);
  if (r.detect && !force && Date.now() - r.detect.at < 15000) return r.detect.value;
  let value;
  try {
    value = { ...(await detect.detectProject(p.dir)), exists: true };
  } catch (err) {
    value = { exists: false, root: p.dir, tools: [], tool: null, name: p.name, gradle: null, maven: null, modules: [], mcHint: null, java: { major: null, toolchain: false }, source: null, error: err.code || err.message };
  }
  r.detect = { at: Date.now(), value };
  return value;
}

const toolOf = (p, d) => (p.build.tool && d.tools?.includes(p.build.tool) ? p.build.tool : d.tool);
const taskOf = (p, d, tool) => p.build.task || (tool === 'maven' ? d.maven?.defaultTask : d.gradle?.defaultTask) || (tool === 'maven' ? 'package' : 'build');

async function currentJar(p) {
  if (p.jar.path) {
    const j = await detect.jarDetails(p.jar.path);
    return j ? { ...j, manual: true } : { path: p.jar.path, file: path.basename(p.jar.path), missing: true, manual: true, plugin: null };
  }
  const j = await detect.findOutputJar(p.dir);
  return j ? { ...j, manual: false } : null;
}

async function jdks(force = false) {
  if (!jdkCache || force || Date.now() - jdkCache.at > 60000) jdkCache = { at: Date.now(), list: await detect.findJdks() };
  return jdkCache.list;
}

// JDK para compilar: el elegido en el proyecto, JAVA_HOME si sirve, o el mejor instalado.
async function jdkFor(p, d) {
  const list = await jdks();
  if (p.build.jdk) {
    const hit = list.find((j) => samePath(j.home, p.build.jdk)) || (await detect.jdkAt(p.build.jdk));
    if (hit) return { ...hit, auto: false };
  }
  const tool = toolOf(p, d);
  const want = d.java?.major || null;
  const toolchain = Boolean(d.java?.toolchain);
  const maxMajor = tool === 'gradle' ? d.gradle?.maxJava || null : null;
  const envHome = process.env.JAVA_HOME ? list.find((j) => samePath(j.home, process.env.JAVA_HOME.replace(/^"|"$/g, ''))) : null;
  if (envHome?.major && (!maxMajor || envHome.major <= maxMajor) && (toolchain || !want || envHome.major >= want)) return { ...envHome, auto: true, env: true };
  const pick = detect.pickJdk(list, { want, toolchain, maxMajor });
  return pick ? { ...pick, auto: true } : null;
}

// ---------- Build ----------

function appendLines(id, lines) {
  const r = rt(id);
  r.lines.push(...lines);
  if (r.lines.length > 3000) r.lines.splice(0, r.lines.length - 3000);
  send('devmode:buildLog', id, lines);
}

async function build(id, { auto = false, reason = null, deploy = 'auto' } = {}) {
  const p = await need(id);
  const r = rt(id);
  if (r.build) {
    if (auto) {
      r.queued = { reason };
      pushStatus(id);
      return { queued: true };
    }
    throw new Error(t('devmode.errBuilding'));
  }
  const d = await detectFor(p, { force: !auto });
  if (!d.exists) throw new Error(t('devmode.errNotDir'));
  const tool = toolOf(p, d);
  if (!tool) throw new Error(t('devmode.errNoTool'));
  const runnerInfo = detect.runnerFor(d.root, tool);
  if (!runnerInfo) throw new Error(t(tool === 'maven' ? 'devmode.errNoMaven' : 'devmode.errNoGradle'));
  const task = taskOf(p, d, tool);
  let cmd;
  try {
    cmd = runner.buildCommand({ tool, runner: runnerInfo, task, args: p.build.args, skipTests: p.build.skipTests });
  } catch (err) {
    throw new Error(err.code === 'badArgs' ? t('devmode.errBadArgs', { value: err.value || '' }) : t('devmode.errNoTool'));
  }
  if (WIN) {
    try {
      runner.quoteWin(cmd.exe);
    } catch {
      throw new Error(t('devmode.errBadPath'));
    }
  }
  const jdk = await jdkFor(p, d);
  const env = runner.buildEnv(process.env, { jdkHome: jdk?.home || null, tool });

  r.lines = [];
  appendLines(id, [
    { level: 'CMD', text: `> ${cmd.display}`, t: Date.now() },
    { level: 'INFO', text: jdk ? t('devmode.logJdk', { home: jdk.home, major: jdk.major || '?' }) : t('devmode.logNoJdk'), t: Date.now() },
  ]);
  const run = runner.runBuild({ exe: cmd.exe, args: cmd.args, cwd: d.root, env, tool, onLines: (lines) => appendLines(id, lines) });
  r.build = { run, startedAt: run.startedAt, auto, task, tool };
  pushStatus(id);
  const toolName = tool === 'maven' ? 'Maven' : 'Gradle';
  logEvent(id, { kind: 'build', key: auto ? 'ev_buildAuto' : 'ev_buildStart', vars: { tool: toolName, task, file: reason?.file || '', count: reason?.more || 0 } });

  let res;
  if (auto) res = await run.promise;
  else {
    try {
      res = await tasks.run(
        t('devmode.taskBuild', { name: p.name }),
        async (task2) => {
          task2.update({ detail: cmd.display });
          task2.signal.addEventListener('abort', () => run.cancel(), { once: true });
          const out = await run.promise;
          if (out.cancelled) throw new Error(t('devmode.buildCancelled'));
          if (!out.ok) throw new Error(t('devmode.buildFailed', { error: out.summary[0] || t('devmode.buildFailedCode', { code: out.code ?? '?' }) }));
          return out;
        },
        { devmode: id },
      );
    } catch {
      res = await run.promise;
    }
  }
  r.build = null;
  const record = { at: Date.now(), ok: res.ok, ms: res.ms, code: res.code, cancelled: res.cancelled, task, tool, auto, summary: res.summary || [], hint: res.hint || null };
  if (!(await store.get(id))) return record; // el proyecto se quito mientras compilaba
  await store.patch(id, (cur) => ({ ...cur, last: { ...cur.last, build: record } }));
  if (res.cancelled) logEvent(id, { level: 'warn', kind: 'build', key: 'ev_buildCancel' });
  else if (res.ok) logEvent(id, { level: 'good', kind: 'build', key: 'ev_buildOk', vars: { ms: res.ms } });
  else logEvent(id, { level: 'bad', kind: 'build', key: 'ev_buildFail', vars: { ms: res.ms, error: (res.summary || [])[0] || '', hint: res.hint || '' } });

  const queued = r.queued;
  r.queued = null;
  if (res.ok) {
    // El jar nuevo ya lo maneja el build: que el vigilante del jar no lo despliegue otra vez.
    const jar = await currentJar(p).catch(() => null);
    if (jar && !jar.missing) r.lastJarSig = `${jar.path}:${jar.mtime}:${jar.size}`;
  }
  pushStatus(id);
  changed(id);
  if (queued) {
    // Hubo cambios durante el build: se compila de nuevo y se despliega ese resultado.
    setTimeout(() => build(id, { auto: true, reason: queued.reason, deploy }).catch((err) => logEvent(id, { level: 'bad', kind: 'build', key: 'ev_buildError', vars: { error: err.message } })), 150);
  } else if (res.ok && deploy) {
    // deploy: 'auto' (segun el ajuste del proyecto) | 'force' (boton "Compilar y desplegar") | false
    const fresh = await store.get(id);
    if (fresh?.server.id && (deploy === 'force' || fresh.build.autoDeploy)) scheduleDeploy(id, { reason: 'build' }).catch(() => {});
  }
  return record;
}

// ---------- Despliegue ----------

function scheduleDeploy(id, opts = {}) {
  const r = rt(id);
  const next = r.chain.then(() => deployNow(id, opts));
  r.chain = next.catch(() => {});
  return next.catch(async (err) => {
    await logEvent(id, { level: 'bad', kind: 'deploy', key: 'ev_deployFail', vars: { error: err.message } });
    throw err;
  });
}

function kindLabel(kind) {
  return t(`devmode.kind_${kind}`);
}

async function deployNow(id, { reason = 'manual', force = false } = {}) {
  const p = await need(id);
  if (!p.server.id) {
    if (reason === 'manual') throw new Error(t('devmode.errNoServer'));
    return { skipped: 'noServer' };
  }
  await getServer(p.server.id);
  const jar = await currentJar(p);
  if (!jar || jar.missing) throw new Error(t('devmode.errNoJar'));
  if (jar.plugin?.kind !== 'plugin') {
    throw new Error(jar.plugin?.kind ? t('devmode.errJarKind', { file: jar.file, kind: kindLabel(jar.plugin.kind) }) : t('devmode.errNotPlugin', { file: jar.file }));
  }
  const sha1 = await hashFile(jar.path, 'sha1');
  const pdir = deployer.pluginsDir(p.server.id);
  const present = p.deployed.file ? await isFile(path.join(pdir, p.deployed.file)) : false;
  if (!force && sha1 === p.deployed.sha1 && present) {
    if (reason === 'manual' || reason === 'jar') logEvent(id, { kind: 'deploy', key: 'ev_deploySkip' });
    return { skipped: 'same' };
  }
  const r = rt(id);
  r.deploying = true;
  r.phase = 'copying';
  pushStatus(id);
  try {
    const res = await deployer.deploy(p, jar);
    const now = Date.now();
    await store.patch(id, (cur) => ({
      ...cur,
      deployed: { file: res.file, sha1, at: now, name: jar.plugin.name, version: jar.plugin.version },
      last: { ...cur.last, deploy: { at: now, ok: res.ok !== false, mode: res.mode, file: res.file, version: jar.plugin.version } },
    }));
    if (res.mode === 'offline') logEvent(id, { kind: 'deploy', key: 'ev_deployOffline', vars: { file: res.file, bytes: jar.size, version: jar.plugin.version || '' } });
    return res;
  } catch (err) {
    await store.patch(id, (cur) => ({ ...cur, last: { ...cur.last, deploy: { at: Date.now(), ok: false, error: err.message } } }));
    throw err;
  } finally {
    r.deploying = false;
    r.phase = null;
    pushStatus(id);
    changed(id);
  }
}

// ---------- Vigilancia de archivos ----------

function closeWatchers(id) {
  const r = rt(id);
  r.srcWatcher?.close();
  r.jarWatcher?.close();
  r.srcWatcher = null;
  r.jarWatcher = null;
}

async function syncWatchers(id) {
  const p = await store.get(id);
  const r = rt(id);
  closeWatchers(id);
  if (!p || !(await isDir(p.dir))) {
    pushStatus(id);
    return;
  }
  if (p.build.auto) {
    const bases = [p.dir, ...(await detect.moduleDirs(p.dir))];
    r.srcWatcher = new SourceWatcher({
      roots: bases.map((b) => path.join(b, 'src')),
      rootDir: p.dir,
      debounceMs: p.build.debounceMs,
      onChange: (files) => onSourcesChanged(id, files),
      onError: (err) => console.warn('[devmode] vigilancia de fuentes:', err.message),
    }).start();
  }
  if (p.build.watchJar) {
    const d = await detectFor(p);
    const dirs = p.jar.path ? [path.dirname(p.jar.path)] : await detect.expectedOutputDirs(p.dir, toolOf(p, d));
    const jar = await currentJar(p).catch(() => null);
    r.lastJarSig = jar && !jar.missing ? `${jar.path}:${jar.mtime}:${jar.size}` : null;
    r.jarWatcher = new JarWatcher({ dirs, onJar: () => onJarChanged(id).catch((err) => console.warn('[devmode] jar:', err.message)), onError: (err) => console.warn('[devmode] vigilancia del jar:', err.message) }).start();
  }
  pushStatus(id);
}

async function onSourcesChanged(id, files) {
  const p = await store.get(id);
  if (!p) return;
  const rel = files.length ? path.relative(p.dir, files[0]).split(path.sep).join('/') : '';
  build(id, { auto: true, reason: { file: rel, more: Math.max(0, files.length - 1) } }).catch((err) =>
    logEvent(id, { level: 'bad', kind: 'build', key: 'ev_buildError', vars: { error: err.message } }),
  );
}

async function onJarChanged(id) {
  const r = rt(id);
  if (r.build) return; // nuestro propio build: lo despliega el final del build
  const p = await store.get(id);
  if (!p) return;
  const first = await currentJar(p);
  if (!first || first.missing) return;
  if (!(await waitStable(first.path))) return;
  if (r.build) return;
  const jar = await currentJar(p);
  if (!jar || jar.missing) return;
  const sig = `${jar.path}:${jar.mtime}:${jar.size}`;
  if (sig === r.lastJarSig) return;
  r.lastJarSig = sig;
  changed(id);
  if (jar.plugin?.kind !== 'plugin') return;
  logEvent(id, { kind: 'watch', key: 'ev_jarChanged', vars: { file: jar.file } });
  if (p.server.id && p.build.autoDeploy) scheduleDeploy(id, { reason: 'jar' }).catch(() => {});
}

// ---------- Servidor ----------

function slimServer(s) {
  return { id: s.id, name: s.name, type: s.type, mcVersion: s.mcVersion, port: s.port, state: s.state || 'offline', installed: Boolean(s.installed), busy: Boolean(s.busy), players: s.players || [], build: s.build || null, javaMajor: s.javaMajor || null };
}

async function suggestPort() {
  try {
    if (typeof servers.suggestPort === 'function') return await servers.suggestPort('paper');
  } catch {
    /* sin sugerencia */
  }
  return 25565;
}

async function versionsFor(type) {
  if (typeof servers.versions === 'function') return servers.versions(type, {});
  const http = require('../core/http');
  const paths = require('../core/paths');
  if (type === 'purpur') {
    const data = await http.getJson('https://api.purpurmc.org/v2/purpur', { cacheFile: paths.cache('devmode-purpur-versions.json'), cacheMaxAge: 3600 * 1000 });
    return [...(data.versions || [])].reverse();
  }
  const data = await http.getJson(`https://fill.papermc.io/v3/projects/${type}`, { cacheFile: paths.cache(`devmode-${type}-versions.json`), cacheMaxAge: 3600 * 1000 });
  return Object.values(data.versions || {}).flat();
}

// Version sugerida: la que usa el build (paper-api x.y.z), la familia del api-version o la ultima.
function suggestVersion(versions, mcHint, apiVersion) {
  if (mcHint && versions.includes(mcHint)) return { version: mcHint, reason: 'build' };
  if (apiVersion && /^\d+\.\d+(\.\d+)?$/.test(apiVersion)) {
    const fam = versions.filter((v) => v === apiVersion || v.startsWith(`${apiVersion}.`));
    if (fam.length) return { version: fam[0], reason: 'api' };
  }
  return { version: versions[0] || null, reason: 'latest' };
}

async function serverOptions(id, type = 'paper') {
  const p = await need(id);
  if (!store.SERVER_TYPES.includes(type)) throw new Error(t('devmode.errType'));
  const d = await detectFor(p);
  const jar = await currentJar(p).catch(() => null);
  const info = jar?.plugin?.kind === 'plugin' ? jar.plugin : d.source;
  const apiVersion = info?.apiVersion && !isTemplated(info.apiVersion) ? info.apiVersion : null;
  let versions;
  try {
    versions = await versionsFor(type);
  } catch (err) {
    throw new Error(t('devmode.errVersions', { error: err.message }));
  }
  versions = [...new Set(versions)].filter((v) => /^\d+\.\d+(\.\d+)?$/.test(v)).sort((a, b) => detect.compareMc(b, a));
  const pick = suggestVersion(versions, d.mcHint, apiVersion);
  return { type, versions, suggested: pick.version, reason: pick.reason, mcHint: d.mcHint, apiVersion, port: await suggestPort(), pluginName: info?.name && !isTemplated(info.name) ? info.name : p.name };
}

async function createServer(id, opts = {}) {
  const p = await need(id);
  if (opts.eula !== true) throw new Error(t('devmode.errEula'));
  if (!store.SERVER_TYPES.includes(opts.type)) throw new Error(t('devmode.errType'));
  const mcVersion = String(opts.mcVersion || '').trim();
  if (!/^\d+\.\d+(\.\d+)?$/.test(mcVersion)) throw new Error(t('devmode.errVersion'));
  const port = opts.port === undefined || opts.port === null || opts.port === '' ? undefined : Number(opts.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 1024 || port > 65535)) throw new Error(t('devmode.errPort'));
  const memMax = Math.round(Math.min(16384, Math.max(1024, Number(opts.memory) || 2048)));
  const jar = await currentJar(p).catch(() => null);
  const d = await detectFor(p);
  const info = jar?.plugin?.kind === 'plugin' ? jar.plugin : d.source;
  const pluginName = info?.name && !isTemplated(info.name) ? info.name : p.name;
  const onlineMode = opts.onlineMode !== false;
  const op = opts.op && /^[A-Za-z0-9_]{1,16}$/.test(String(opts.op.name || '')) ? { name: String(opts.op.name), uuid: typeof opts.op.uuid === 'string' ? opts.op.uuid : undefined } : undefined;
  const modern = detect.compareMc(mcVersion, '1.19') >= 0;
  const s = await servers.create({
    name: t('devmode.serverName', { name: pluginName }),
    type: opts.type,
    mcVersion,
    eula: true,
    port,
    memory: { min: Math.min(1024, memMax), max: memMax },
    onlineMode,
    gamemode: 'creative',
    levelType: modern ? 'minecraft:flat' : 'flat',
    maxPlayers: 5,
    motd: t('devmode.motd', { name: pluginName }),
    viewDistance: 8,
    op,
  });
  // Ajustes de prueba que create() no cubre
  try {
    await servers.writeProperties(s.id, { 'spawn-protection': 0, 'allow-flight': true });
  } catch (err) {
    console.warn('[devmode] propiedades', err.message);
  }
  await store.patch(id, (cur) => ({ ...cur, server: { ...cur.server, id: s.id }, deployed: { file: null, sha1: null, at: null, name: null, version: null } }));
  logEvent(id, { level: 'good', kind: 'server', key: 'ev_serverCreated', vars: { name: s.name, type: TYPE_NAMES[s.type] || s.type, version: s.mcVersion } });
  send('servers:changed');
  changed(id);
  if (jar && !jar.missing && jar.plugin?.kind === 'plugin') scheduleDeploy(id, { reason: 'start' }).catch(() => {});
  tasks
    .run(t('devmode.taskInstallServer', { name: s.name }), (task) => servers.install(s.id, task), { serverId: s.id, devmode: id })
    .then(() => logEvent(id, { level: 'good', kind: 'server', key: 'ev_serverInstalled', vars: { name: s.name } }))
    .catch((err) => logEvent(id, { level: 'bad', kind: 'server', key: 'ev_serverInstallFail', vars: { error: err.message } }))
    .finally(() => {
      send('servers:changed');
      changed(id);
    });
  return slimServer(s);
}

async function linkableServers() {
  const list = await servers.list();
  return list.filter((s) => PLUGIN_SERVER_TYPES.has(s.type)).map(slimServer);
}

async function linkServer(id, sid) {
  await need(id);
  const s = await getServer(String(sid || ''));
  if (!PLUGIN_SERVER_TYPES.has(s.type)) throw new Error(t('devmode.errServerType'));
  await store.patch(id, (cur) => ({ ...cur, server: { ...cur.server, id: s.id }, deployed: { file: null, sha1: null, at: null, name: null, version: null } }));
  logEvent(id, { kind: 'server', key: 'ev_serverLinked', vars: { name: s.name } });
  changed(id);
  return slimServer(s);
}

async function unlinkServer(id) {
  await need(id);
  await store.patch(id, (cur) => ({ ...cur, server: { ...cur.server, id: null }, deployed: { file: null, sha1: null, at: null, name: null, version: null } }));
  rt(id).autoLaunch = false;
  changed(id);
  return true;
}

async function maybeAutoLaunch(p, server) {
  const r = rt(p.id);
  if (!r.autoLaunch) return;
  r.autoLaunch = false;
  if (!p.client.instanceId) {
    logEvent(p.id, { level: 'warn', kind: 'client', key: 'ev_clientNoInstance' });
    return;
  }
  try {
    const game = require('../core/game');
    if (game.status()[p.client.instanceId]) return; // el cliente ya esta abierto
  } catch {
    /* sin estado de juego */
  }
  send('devmode:autoLaunch', p.id, { instanceId: p.client.instanceId, port: server.port });
}

async function startServer(id, { launchClient } = {}) {
  const p = await need(id);
  const sid = requireServer(p);
  const server = await getServer(sid);
  const r = rt(id);
  const wantClient = launchClient ?? p.client.autoLaunch;
  const st = await deployer.stateOf(sid);
  if (st === 'online' || st === 'starting') {
    if (wantClient) {
      r.autoLaunch = true;
      if (st === 'online') await maybeAutoLaunch(p, server);
    }
    return { already: true };
  }
  if (st === 'stopping') throw new Error(t('devmode.errServerBusy'));
  // El jar mas nuevo va a plugins/ antes de arrancar.
  const jar = await currentJar(p).catch(() => null);
  if (jar && !jar.missing && jar.plugin?.kind === 'plugin') await scheduleDeploy(id, { reason: 'start' }).catch(() => {});
  r.autoLaunch = Boolean(wantClient);
  logEvent(id, { kind: 'server', key: 'ev_serverStart', vars: { name: server.name } });
  try {
    await deployer.startServer(p, sid, t('devmode.taskStartServer', { name: server.name }));
  } catch (err) {
    r.autoLaunch = false;
    throw err;
  }
  if (p.server.debug) logEvent(id, { kind: 'server', key: 'ev_debugOn', vars: { port: p.server.debugPort } });
  send('servers:changed');
  changed(id);
  return { started: true };
}

async function restartServer(id) {
  const p = await need(id);
  const sid = requireServer(p);
  const server = await getServer(sid);
  const r = rt(id);
  if (r.deploying) throw new Error(t('devmode.errServerBusy'));
  r.deploying = true;
  r.phase = 'stopping';
  pushStatus(id);
  try {
    if (!(await deployer.stopAndWait(sid))) throw new Error(t('devmode.errStopTimeout'));
  } finally {
    r.deploying = false;
    r.phase = null;
    pushStatus(id);
  }
  const jar = await currentJar(p).catch(() => null);
  if (jar && !jar.missing && jar.plugin?.kind === 'plugin') await scheduleDeploy(id, { reason: 'start' }).catch(() => {});
  logEvent(id, { kind: 'server', key: 'ev_serverRestart', vars: { name: server.name } });
  await deployer.startServer(p, sid, t('devmode.taskRestart', { name: server.name }));
  changed(id);
  return true;
}

async function onServerState(sid, st) {
  const list = (await store.list()).filter((p) => p.server.id === sid);
  for (const p of list) {
    const r = rt(p.id);
    if (st.state === 'online') {
      let server = null;
      try {
        server = await servers.get(sid);
      } catch {
        continue;
      }
      if (!r.deploying) logEvent(p.id, { level: 'good', kind: 'server', key: 'ev_serverOnline', vars: { port: server.port } });
      await maybeAutoLaunch(p, server);
    } else if (st.state === 'offline') {
      r.autoLaunch = false;
      if (st.crashed) logEvent(p.id, { level: 'bad', kind: 'server', key: 'ev_serverCrashed', vars: { code: st.code ?? '?' } });
      else if (!r.deploying) logEvent(p.id, { kind: 'server', key: 'ev_serverStopped' });
    }
    pushStatus(p.id);
  }
}

// ---------- Sesion completa: compilar si hace falta, iniciar o recargar, abrir el cliente ----------

async function startSession(id, { client = true } = {}) {
  const p = await need(id);
  const sid = requireServer(p);
  await getServer(sid);
  const d = await detectFor(p, { force: true });
  const jar = await currentJar(p).catch(() => null);
  const tool = toolOf(p, d);
  let built = false;
  if (!p.jar.path && tool && detect.runnerFor(d.root, tool) && !rt(id).build) {
    const lastOk = p.last.build?.ok ? p.last.build.at : 0;
    const changedAt = await detect.latestSourceChange(p.dir);
    if (!jar || jar.missing || !lastOk || changedAt > lastOk || jar.mtime < changedAt) {
      const res = await build(id, { deploy: false });
      built = true;
      if (!res.ok) return { built, ok: false };
    }
  }
  const finalJar = await currentJar(await need(id)).catch(() => null);
  if (!finalJar || finalJar.missing) throw new Error(t('devmode.errNoJar'));
  const st = await deployer.stateOf(sid);
  if (st === 'online' || st === 'starting') {
    await scheduleDeploy(id, { reason: 'session' }).catch(() => {});
    if (client) {
      rt(id).autoLaunch = true;
      if (st === 'online') await maybeAutoLaunch(await need(id), await getServer(sid));
    }
  } else {
    await startServer(id, { launchClient: Boolean(client) });
  }
  return { built, ok: true };
}

// ---------- Detalle para la interfaz ----------

async function projectDetail(id) {
  const p = await need(id);
  const d = await detectFor(p);
  const tool = toolOf(p, d);
  const runnerInfo = d.exists && tool ? detect.runnerFor(d.root, tool) : null;
  const jar = d.exists || p.jar.path ? await currentJar(p).catch(() => null) : null;
  let server = null;
  let missing = false;
  let plug = null;
  if (p.server.id) {
    try {
      server = slimServer(await servers.get(p.server.id));
    } catch {
      missing = true;
    }
    if (server) {
      const scanned = await plugman.scanPlugins(deployer.pluginsDir(p.server.id));
      const pm = await plugman.installed(null, scanned);
      plug = pm ? { installed: true, version: pm.version, file: pm.file } : { installed: false };
      const pr = await servers.readProperties(p.server.id).catch(() => ({}));
      server.onlineMode = pr['online-mode'] !== 'false';
      server.deployedPresent = Boolean(p.deployed.file && scanned.some((x) => x.file === p.deployed.file));
      server.plugins = scanned.length;
    }
  }
  const jdk = d.exists ? await jdkFor(p, d).catch(() => null) : null;
  const pluginInfo = jar?.plugin?.kind === 'plugin' ? jar.plugin : d.source || null;
  return {
    id: p.id,
    name: p.name,
    dir: p.dir,
    created: p.created,
    build: p.build,
    client: p.client,
    last: p.last,
    deployed: p.deployed,
    detect: {
      exists: d.exists,
      tools: d.tools || [],
      tool,
      task: tool ? taskOf(p, d, tool) : null,
      tasks: (tool === 'maven' ? d.maven?.tasks : d.gradle?.tasks) || [],
      runner: runnerInfo ? { kind: runnerInfo.kind, display: runnerInfo.display } : null,
      gradle: d.gradle ? { version: d.gradle.version, wrapper: d.gradle.wrapper, shadow: d.gradle.shadow, paperweight: d.gradle.paperweight, maxJava: d.gradle.maxJava } : null,
      maven: d.maven ? { wrapper: d.maven.wrapper, shade: d.maven.shade } : null,
      modules: d.modules || [],
      mcHint: d.mcHint || null,
      java: d.java || null,
      source: d.source || null,
    },
    jar: jar ? { path: jar.path, file: jar.file, size: jar.size || 0, mtime: jar.mtime || 0, manual: Boolean(jar.manual), missing: Boolean(jar.missing), plugin: jar.plugin || null } : null,
    plugin: pluginInfo,
    pluginFromJar: jar?.plugin?.kind === 'plugin',
    jdk: jdk ? { home: jdk.home, major: jdk.major, version: jdk.version, vendor: jdk.vendor, auto: jdk.auto, env: Boolean(jdk.env) } : null,
    server: {
      ...p.server,
      info: server,
      missing,
      debugFlag: server && p.server.debug ? debugFlag({ port: p.server.debugPort, anyHost: p.server.debugAnyHost }, serverJavaMajor(server)) : null,
    },
    plugman: plug,
    status: statusOf(id),
  };
}

// ---------- Proyectos ----------

async function addProject(dir) {
  if (typeof dir !== 'string' || !dir.trim() || !path.isAbsolute(dir)) throw new Error(t('devmode.errNotDir'));
  const root = path.resolve(dir);
  const same = (await store.list()).find((p) => samePath(p.dir, root));
  if (same) {
    await store.select(same.id);
    changed(same.id);
    return { ...same, existing: true };
  }
  let d;
  try {
    d = await detect.detectProject(root);
  } catch {
    throw new Error(t('devmode.errNotDir'));
  }
  const name = d.source?.name && !isTemplated(d.source.name) ? d.source.name : d.name;
  const p = await store.add({ dir: root, name });
  rt(p.id).detect = { at: Date.now(), value: { ...d, exists: true } };
  logEvent(p.id, { level: 'good', kind: 'project', key: d.tool ? 'ev_projectAdded' : 'ev_projectAddedNoTool', vars: { name, tool: d.tool === 'maven' ? 'Maven' : 'Gradle' } });
  changed(p.id);
  return p;
}

async function removeProject(id, { deleteServer = false } = {}) {
  const p = await need(id);
  const r = rt(id);
  if (deleteServer && p.server.id) {
    let s = null;
    try {
      s = await servers.get(p.server.id);
    } catch {
      s = null;
    }
    if (s) {
      if (s.state !== 'offline') throw new Error(t('devmode.errStopServerFirst'));
      await servers.remove(p.server.id);
      send('servers:changed');
    }
  }
  r.build?.run.cancel();
  closeWatchers(id);
  await store.remove(id);
  runtime.delete(id);
  changed(null);
  return true;
}

function clampInt(v, min, max, err) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(err);
  return n;
}

async function updateProject(id, patch = {}) {
  const p = await need(id);
  const next = JSON.parse(JSON.stringify(p));
  if (patch.name !== undefined) {
    const n = String(patch.name).replace(/\s+/g, ' ').trim().slice(0, 60);
    if (n) next.name = n;
  }
  const b = patch.build || {};
  if (b.tool !== undefined) next.build.tool = b.tool === 'gradle' || b.tool === 'maven' ? b.tool : null;
  if (b.task !== undefined) {
    if (!b.task) next.build.task = null;
    else {
      try {
        runner.splitTokens(b.task, /^[\w:.\-]+$/);
      } catch {
        throw new Error(t('devmode.errBadTask'));
      }
      next.build.task = String(b.task).replace(/\s+/g, ' ').trim().slice(0, 120);
    }
  }
  if (b.args !== undefined) {
    try {
      runner.splitTokens(b.args);
    } catch (err) {
      throw new Error(t('devmode.errBadArgs', { value: err.value || '' }));
    }
    next.build.args = String(b.args || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  }
  for (const k of ['skipTests', 'auto', 'watchJar', 'autoDeploy']) if (b[k] !== undefined) next.build[k] = Boolean(b[k]);
  if (b.debounceMs !== undefined) next.build.debounceMs = clampInt(b.debounceMs, 300, 10000, t('devmode.errDebounce'));
  if (b.jdk !== undefined) {
    if (!b.jdk) next.build.jdk = '';
    else {
      const j = await detect.jdkAt(path.resolve(String(b.jdk)));
      if (!j) throw new Error(t('devmode.errJdk'));
      next.build.jdk = j.home;
    }
  }
  if (patch.jar !== undefined) {
    const jp = patch.jar?.path;
    if (!jp) next.jar.path = null;
    else {
      const full = path.resolve(String(jp));
      if (!/\.jar$/i.test(full) || !(await isFile(full))) throw new Error(t('devmode.errJarPick'));
      next.jar.path = full;
    }
  }
  const s = patch.server || {};
  if (s.reload !== undefined) {
    if (!store.RELOAD_MODES.includes(s.reload)) throw new Error(t('devmode.errReload'));
    next.server.reload = s.reload;
  }
  if (s.debug !== undefined) next.server.debug = Boolean(s.debug);
  if (s.debugPort !== undefined) next.server.debugPort = clampInt(s.debugPort, 1024, 65535, t('devmode.errPort'));
  if (s.debugAnyHost !== undefined) next.server.debugAnyHost = Boolean(s.debugAnyHost);
  const c = patch.client || {};
  if (c.instanceId !== undefined) next.client.instanceId = c.instanceId ? String(c.instanceId).slice(0, 120) : null;
  if (c.autoLaunch !== undefined) next.client.autoLaunch = Boolean(c.autoLaunch);

  const saved = await store.patch(id, next);
  const watchChanged =
    saved.build.auto !== p.build.auto || saved.build.watchJar !== p.build.watchJar || saved.jar.path !== p.jar.path || saved.build.tool !== p.build.tool || saved.build.debounceMs !== p.build.debounceMs;
  if (watchChanged) {
    rt(id).detect = null;
    await syncWatchers(id);
  }
  if (saved.build.auto !== p.build.auto) logEvent(id, { kind: 'watch', key: saved.build.auto ? 'ev_watchOn' : 'ev_watchOff', vars: { ms: saved.build.debounceMs } });
  if (saved.build.watchJar !== p.build.watchJar) logEvent(id, { kind: 'watch', key: saved.build.watchJar ? 'ev_jarWatchOn' : 'ev_jarWatchOff' });
  if (saved.jar.path !== p.jar.path) logEvent(id, { kind: 'project', key: saved.jar.path ? 'ev_jarManual' : 'ev_jarAuto', vars: { file: saved.jar.path ? path.basename(saved.jar.path) : '' } });
  if (saved.server.reload !== p.server.reload) logEvent(id, { kind: 'reload', key: 'ev_reloadMode', vars: { mode: saved.server.reload } });
  const debugChanged = saved.server.debug !== p.server.debug || saved.server.debugPort !== p.server.debugPort || saved.server.debugAnyHost !== p.server.debugAnyHost;
  if (debugChanged && saved.server.id) {
    const st = await deployer.stateOf(saved.server.id).catch(() => 'offline');
    if (st !== 'offline') logEvent(id, { level: 'warn', kind: 'server', key: 'ev_debugRestart' });
  }
  changed(id);
  return saved;
}

async function setOnlineMode(id, on) {
  const p = await need(id);
  const sid = requireServer(p);
  const s = await getServer(sid);
  const patch = { 'online-mode': Boolean(on) };
  if (!on) patch['enforce-secure-profile'] = false;
  await servers.writeProperties(sid, patch);
  logEvent(id, { kind: 'server', key: on ? 'ev_onlineOn' : 'ev_onlineOff' });
  changed(id);
  return { onlineMode: Boolean(on), restartNeeded: s.state !== 'offline' };
}

// ---------- PlugManX ----------

async function plugmanInfo(id) {
  const p = await need(id);
  const sid = requireServer(p);
  const s = await getServer(sid);
  const pm = await plugman.installed(deployer.pluginsDir(sid));
  let avail = null;
  let error = null;
  try {
    avail = await plugman.available(s.type, s.mcVersion);
  } catch (err) {
    error = err.message;
  }
  return { installed: Boolean(pm), version: pm?.version || null, file: pm?.file || null, available: avail ? { versionNumber: avail.versionNumber, id: avail.id } : null, error, page: plugman.PAGE, state: s.state };
}

async function installPlugman(id) {
  const p = await need(id);
  const sid = requireServer(p);
  const s = await getServer(sid);
  const avail = await plugman.available(s.type, s.mcVersion);
  if (!avail) throw new Error(t('devmode.errPlugmanNone', { type: TYPE_NAMES[s.type] || s.type, version: s.mcVersion }));
  const { shell } = require('electron');
  const res = await tasks.run(
    t('devmode.taskPlugman'),
    async (task) => {
      let got = 0;
      const total = avail.file.size || 0;
      return plugman.install(deployer.pluginsDir(sid), avail, {
        signal: task.signal,
        trash: (f) => shell.trashItem(f),
        onBytes: (n) => {
          got += n;
          if (total) task.update({ progress: Math.min(1, got / total) });
        },
      });
    },
    { serverId: sid, devmode: id },
  );
  const running = (await deployer.stateOf(sid)) !== 'offline';
  logEvent(id, { level: 'good', kind: 'plugman', key: running ? 'ev_plugmanInstalledRestart' : 'ev_plugmanInstalled', vars: { version: res.version } });
  changed(id);
  return { ...res, restartNeeded: running };
}

// ---------- Abrir carpetas ----------

async function openThing(id, what) {
  const { shell } = require('electron');
  const p = await need(id);
  if (what === 'project') {
    if (!(await isDir(p.dir))) throw new Error(t('devmode.errNotDir'));
    const err = await shell.openPath(p.dir);
    if (err) throw new Error(err);
    return true;
  }
  if (what === 'jar') {
    const jar = await currentJar(p);
    if (!jar || jar.missing) throw new Error(t('devmode.errNoJar'));
    shell.showItemInFolder(jar.path);
    return true;
  }
  if (what === 'plugins' || what === 'server') {
    const sid = requireServer(p);
    await getServer(sid);
    const dir = ctx.safePath(what === 'plugins' ? deployer.pluginsDir(sid) : path.dirname(deployer.pluginsDir(sid)));
    await fsp.mkdir(dir, { recursive: true });
    const err = await shell.openPath(dir);
    if (err) throw new Error(err);
    return true;
  }
  throw new Error(t('devmode.errOpen'));
}

// ---------- Registro ----------

function register(c) {
  ctx = c;
  const { shell } = require('electron');
  deployer = createDeployer({
    servers,
    tasks,
    t,
    trash: (p) => shell.trashItem(p),
    onPhase: (id, phase) => {
      rt(id).phase = phase;
      pushStatus(id);
    },
    onEvent: (id, e) => logEvent(id, e),
  });
  servers.events.on('state', (sid, st) => {
    onServerState(sid, st || {}).catch((err) => console.warn('[devmode] estado del servidor:', err.message));
  });

  const { handle } = c;
  handle('devmode:state', async () => {
    const s = await store.load();
    return { selected: s.selected, projects: s.projects.map((p) => ({ id: p.id, name: p.name, dir: p.dir })) };
  });
  handle('devmode:project', (id) => projectDetail(id));
  handle('devmode:addProject', (dir) => addProject(dir));
  handle('devmode:removeProject', (id, opts) => removeProject(id, opts || {}));
  handle('devmode:select', async (id) => {
    const sel = await store.select(id);
    changed(sel);
    return sel;
  });
  handle('devmode:update', (id, patch) => updateProject(id, patch || {}));
  handle('devmode:detect', async (id) => {
    const p = await need(id);
    rt(id).detect = null;
    jdkCache = null;
    await detectFor(p, { force: true });
    changed(id);
    return projectDetail(id);
  });
  handle('devmode:jdks', (force) => jdks(Boolean(force)));
  handle('devmode:build', (id, opts) => build(id, { auto: false, deploy: opts?.deploy === 'force' ? 'force' : 'auto' }));
  handle('devmode:cancelBuild', (id) => {
    const r = rt(id);
    r.queued = null;
    if (!r.build) return false;
    r.build.run.cancel();
    return true;
  });
  handle('devmode:buildLog', (id) => {
    const r = rt(id);
    return { lines: r.lines, status: statusOf(id) };
  });
  handle('devmode:deploy', (id) => scheduleDeploy(id, { reason: 'manual', force: true }));
  handle('devmode:events', (id) => store.getEvents(id));
  handle('devmode:clearEvents', async (id) => {
    await store.clearEvents(id);
    return true;
  });
  handle('devmode:serverOptions', (id, type) => serverOptions(id, type || 'paper'));
  handle('devmode:linkableServers', () => linkableServers());
  handle('devmode:createServer', (id, opts) => createServer(id, opts || {}));
  handle('devmode:linkServer', (id, sid) => linkServer(id, sid));
  handle('devmode:unlinkServer', (id) => unlinkServer(id));
  handle('devmode:startServer', (id, opts) => startServer(id, opts || {}));
  handle('devmode:stopServer', async (id) => {
    const p = await need(id);
    rt(id).autoLaunch = false;
    return servers.stop(requireServer(p));
  });
  handle('devmode:restartServer', (id) => restartServer(id));
  handle('devmode:killServer', async (id) => {
    const p = await need(id);
    return typeof servers.kill === 'function' ? servers.kill(requireServer(p)) : servers.stop(requireServer(p));
  });
  handle('devmode:command', async (id, cmd) => {
    const p = await need(id);
    return servers.command(requireServer(p), String(cmd || '').slice(0, 1000));
  });
  handle('devmode:serverLogs', async (id) => {
    const p = await need(id);
    if (!p.server.id || typeof servers.logs !== 'function') return [];
    return servers.logs(p.server.id).slice(-2500);
  });
  handle('devmode:setOnlineMode', (id, on) => setOnlineMode(id, on));
  handle('devmode:plugman', (id) => plugmanInfo(id));
  handle('devmode:installPlugman', (id) => installPlugman(id));
  handle('devmode:startSession', (id, opts) => startSession(id, { client: opts?.client !== false }));
  handle('devmode:open', (id, what) => openThing(id, what));
  handle('devmode:clientLaunched', async (id, instanceId) => {
    const p = await need(id);
    let name = String(instanceId || '');
    try {
      name = (await require('../core/instances').get(String(instanceId))).name;
    } catch {
      /* instancia borrada */
    }
    let port = null;
    if (p.server.id) port = (await servers.get(p.server.id).catch(() => null))?.port || null;
    logEvent(id, { kind: 'client', key: 'ev_clientLaunch', vars: { instance: name, port: port || 25565 } });
    return true;
  });

  // La vigilancia de archivos sigue activa entre sesiones del launcher.
  store
    .list()
    .then((list) => list.filter((p) => p.build.auto || p.build.watchJar).forEach((p) => syncWatchers(p.id).catch((err) => console.warn('[devmode] vigilancia:', err.message))))
    .catch((err) => console.warn('[devmode] proyectos:', err.message));

  c.onQuit(async () => {
    for (const [id, r] of runtime) {
      r.build?.run.cancel();
      closeWatchers(id);
    }
    await store.flush();
  });
}

module.exports = { register, suggestVersion };
