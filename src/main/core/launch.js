'use strict';
// Construccion de la linea de comandos de Java y ejecucion del juego.
const os = require('os');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const paths = require('./paths');
const minecraft = require('./minecraft');
const { t } = require('./i18n');
const { flattenArgs, substitute } = require('./rules');
const { CP_SEP, exists } = require('./util');

const AIKAR_FLAGS = [
  '-XX:+UseG1GC',
  '-XX:+ParallelRefProcEnabled',
  '-XX:MaxGCPauseMillis=200',
  '-XX:+UnlockExperimentalVMOptions',
  '-XX:+DisableExplicitGC',
  '-XX:+AlwaysPreTouch',
  '-XX:G1NewSizePercent=30',
  '-XX:G1MaxNewSizePercent=40',
  '-XX:G1HeapRegionSize=8M',
  '-XX:G1ReservePercent=20',
  '-XX:G1HeapWastePercent=5',
  '-XX:G1MixedGCCountTarget=4',
  '-XX:InitiatingHeapOccupancyPercent=15',
  '-XX:G1MixedGCLiveThresholdPercent=90',
  '-XX:G1RSetUpdatingPauseTimePercent=5',
  '-XX:SurvivorRatio=32',
  '-XX:+PerfDisableSharedMem',
  '-XX:MaxTenuringThreshold=1',
];

// Salida de Java en UTF-8 (el log se lee como UTF-8). En Java 18+ ya es el valor por defecto;
// en Java 8-17 evita textos rotos con tildes cuando la salida va a un pipe.
const CONSOLE_UTF8 = ['-Dfile.encoding=UTF-8', '-Dsun.stdout.encoding=UTF-8', '-Dsun.stderr.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8'];

const VANILLA_G1 = [
  '-XX:+UnlockExperimentalVMOptions',
  '-XX:+UseG1GC',
  '-XX:G1NewSizePercent=20',
  '-XX:G1ReservePercent=20',
  '-XX:MaxGCPauseMillis=50',
  '-XX:G1HeapRegionSize=32M',
];

// Divide una cadena de argumentos respetando comillas.
function splitArgs(str) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(str || ''))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// ZGC: produccion desde Java 15; generacional opcional en 21-22 y unico modo desde 23
// (en 24+ -XX:+ZGenerational ya no existe y puede impedir que arranque).
function zgcFlags(javaMajor) {
  if (!javaMajor || javaMajor < 15) return null;
  return javaMajor >= 21 && javaMajor < 23 ? ['-XX:+UseZGC', '-XX:+ZGenerational'] : ['-XX:+UseZGC'];
}

const GC_SELECTORS = /^-XX:\+Use(G1|Z|Shenandoah|Parallel|Serial|ConcMarkSweep)GC$/;

// Quita flags que esa version de Java no entiende (por ejemplo con un Java elegido a mano).
function sanitizeForJava(flags, javaMajor) {
  if (!javaMajor) return flags;
  return flags.filter((a) => {
    if (a === '-XX:+UseCompactObjectHeaders') return javaMajor >= 25;
    if (a === '-XX:+UseZGC') return javaMajor >= 15;
    if (/^-XX:[+-]ZGenerational$/.test(a)) return javaMajor >= 21 && javaMajor < 23;
    if (a === '-XX:+UseShenandoahGC') return javaMajor >= 12;
    return true;
  });
}

// 'auto': lo que recomienda Mojang para esa version (26.x: ZGC + cabeceras compactas con Java 25),
// adaptado al Java real y al equipo: con poca memoria o pocos hilos ZGC rinde peor que G1.
function autoFlags(javaMajor, resolved, features, maxMb) {
  if (!resolved.defaultUserJvm) return VANILLA_G1;
  let flags = sanitizeForJava(flattenArgs(resolved.defaultUserJvm, features).filter((a) => !/^-Xm[sx]/.test(a)), javaMajor);
  const weakPc = (maxMb && maxMb < 3072) || os.cpus().length <= 4;
  if (flags.includes('-XX:+UseZGC') && weakPc) flags = flags.filter((a) => a !== '-XX:+UseZGC' && !/ZGenerational/.test(a));
  if (!flags.some((a) => GC_SELECTORS.test(a))) flags = [...flags, ...VANILLA_G1];
  return [...new Set(flags)];
}

function gcArgs(preset, javaMajor, resolved, features, maxMb) {
  switch (preset) {
    case 'aikar':
      return AIKAR_FLAGS;
    case 'zgc':
      return zgcFlags(javaMajor) || VANILLA_G1;
    case 'g1':
      return VANILLA_G1;
    case 'none':
      return [];
    default:
      return autoFlags(javaMajor, resolved, features, maxMb);
  }
}

function legacyJvmArgs() {
  const a = [];
  if (process.platform === 'win32') a.push('-XX:HeapDumpPath=MojangTricksIntelDriversForPerformance_javaw.exe_minecraft.exe.heapdump');
  if (process.platform === 'darwin') a.push('-XstartOnFirstThread');
  if (process.arch === 'ia32') a.push('-Xss1M');
  a.push(
    '-Djava.library.path=${natives_directory}',
    '-Dminecraft.launcher.brand=${launcher_name}',
    '-Dminecraft.launcher.version=${launcher_version}',
    '-cp',
    '${classpath}',
  );
  return a;
}

function supportsQuickPlay(resolved) {
  return resolved.arguments.game.some((a) => a && typeof a === 'object' && a.rules?.some((r) => r.features?.is_quick_play_multiplayer));
}

/**
 * opts: { resolved, gameDir, account, javaPath, javaMajor, memory:{min,max}, jvmPreset, jvmArgs,
 *         window:{width,height,fullscreen}, quickPlay:{server, port, world}, launcherVersion }
 */
async function buildCommand(opts) {
  const { resolved, gameDir, account } = opts;
  const nativesDir = paths.natives(resolved.id);
  await minecraft.extractNatives(resolved, nativesDir);
  for (const sub of ['java', 'jna', 'lwjgl', 'netty']) await fsp.mkdir(path.join(nativesDir, sub), { recursive: true });
  await fsp.mkdir(gameDir, { recursive: true });
  await minecraft.mapResourcesToGameDir(resolved, gameDir);

  const classpath = minecraft
    .allLibraryFiles(resolved)
    .filter((f) => f.classpath)
    .map((f) => f.path);
  const jar = paths.versionJar(resolved.id);
  classpath.push((await exists(jar)) ? jar : minecraft.clientJarPath(resolved));

  const win = opts.window || {};
  const qp = opts.quickPlay || {};
  const quickPlay = supportsQuickPlay(resolved);
  const features = {
    is_demo_user: false,
    has_custom_resolution: Boolean(win.width && win.height),
    has_quick_plays_support: false,
    is_quick_play_singleplayer: Boolean(quickPlay && qp.world),
    is_quick_play_multiplayer: Boolean(quickPlay && qp.server),
    is_quick_play_realms: false,
  };

  const log = minecraft.loggingFile(resolved);
  const vars = {
    auth_player_name: account.name,
    version_name: resolved.id,
    game_directory: gameDir,
    assets_root: paths.assets(),
    game_assets: minecraft.assetsGameDir(resolved, gameDir),
    assets_index_name: resolved.assetIndex?.id || resolved.assets || 'legacy',
    auth_uuid: account.uuid,
    auth_access_token: account.accessToken || '0',
    auth_session: account.type === 'msa' ? `token:${account.accessToken}:${account.uuid}` : '-',
    clientid: account.clientId || '0',
    auth_xuid: account.xuid || '0',
    user_type: account.type === 'msa' ? 'msa' : 'legacy',
    version_type: 'Venus Launcher',
    user_properties: '{}',
    resolution_width: win.width || 854,
    resolution_height: win.height || 480,
    natives_directory: nativesDir,
    launcher_name: 'venus-launcher',
    launcher_version: opts.launcherVersion || '1.0.0',
    classpath: classpath.join(CP_SEP),
    classpath_separator: CP_SEP,
    library_directory: paths.libraries(),
    quickPlayPath: path.join(gameDir, 'quickPlay', 'log.json'),
    quickPlaySingleplayer: qp.world || '',
    quickPlayMultiplayer: qp.server ? `${qp.server}:${qp.port || 25565}` : '',
    quickPlayRealms: '',
    path: log ? log.path : '',
  };

  let jvm = flattenArgs(resolved.arguments.jvm, features);
  if (!jvm.some((a) => a.includes('${classpath}'))) jvm = [...legacyJvmArgs(), ...jvm];
  jvm = jvm.map((a) => substitute(a, vars));

  const mem = opts.memory || {};
  const min = Math.max(256, Math.min(mem.min || 1024, mem.max || 4096));
  const max = Math.max(min, mem.max || 4096);
  const extra = [
    `-Xms${min}M`,
    `-Xmx${max}M`,
    ...gcArgs(opts.jvmPreset, opts.javaMajor, resolved, features, max),
    ...CONSOLE_UTF8,
    ...splitArgs(opts.jvmArgs),
  ];
  if (log && (await exists(log.path))) extra.push(substitute(resolved.logging.client.argument, vars));

  let game = [];
  if (resolved.minecraftArguments) game = resolved.minecraftArguments.split(/\s+/).filter(Boolean);
  game.push(...flattenArgs(resolved.arguments.game, features));
  game = game.map((a) => substitute(a, vars));
  if (features.has_custom_resolution && !game.includes('--width')) game.push('--width', String(win.width), '--height', String(win.height));
  if (win.fullscreen && !game.includes('--fullscreen')) game.push('--fullscreen');
  if (qp.server && !quickPlay) game.push('--server', qp.server, '--port', String(qp.port || 25565));

  return {
    java: opts.javaPath,
    args: [...jvm, ...extra, resolved.mainClass, ...game],
    cwd: gameDir,
  };
}

// Parser del log de Minecraft: soporta el formato XML de log4j y texto plano.
class LogParser {
  constructor() {
    this.buf = '';
  }

  push(chunk) {
    this.buf += chunk;
    const out = [];
    for (;;) {
      const start = this.buf.indexOf('<log4j:Event');
      if (start === -1) {
        const nl = this.buf.lastIndexOf('\n');
        if (nl === -1) break;
        for (const line of this.buf.slice(0, nl).split(/\r?\n/)) if (line.trim()) out.push(plainLine(line));
        this.buf = this.buf.slice(nl + 1);
        break;
      }
      if (start > 0) {
        const before = this.buf.slice(0, start);
        for (const line of before.split(/\r?\n/)) if (line.trim()) out.push(plainLine(line));
        this.buf = this.buf.slice(start);
        continue;
      }
      const end = this.buf.indexOf('</log4j:Event>');
      if (end === -1) break;
      const xml = this.buf.slice(0, end + 14);
      this.buf = this.buf.slice(end + 14);
      const level = (xml.match(/level="([^"]+)"/) || [])[1] || 'INFO';
      const thread = (xml.match(/thread="([^"]+)"/) || [])[1] || '';
      const ts = Number((xml.match(/timestamp="(\d+)"/) || [])[1]) || Date.now();
      const msg = (xml.match(/<log4j:Message><!\[CDATA\[([\s\S]*?)\]\]><\/log4j:Message>/) || [])[1] ?? '';
      const thr = (xml.match(/<log4j:Throwable><!\[CDATA\[([\s\S]*?)\]\]><\/log4j:Throwable>/) || [])[1];
      const time = new Date(ts).toTimeString().slice(0, 8);
      out.push({ level, text: `[${time}] [${thread}/${level}]: ${msg}${thr ? `\n${thr}` : ''}` });
    }
    if (this.buf.length > 1_000_000) this.buf = this.buf.slice(-100_000);
    return out;
  }
}

function plainLine(line) {
  const m = line.match(/\/(ERROR|WARN|INFO|DEBUG|FATAL)\]/) || line.match(/\[(ERROR|WARN|SEVERE|WARNING)\]/);
  let level = m ? m[1] : 'INFO';
  if (level === 'SEVERE') level = 'ERROR';
  if (level === 'WARNING') level = 'WARN';
  if (/^\s*(at |Caused by:|Exception in thread)/.test(line)) level = 'ERROR';
  return { level, text: line };
}

function spawnGame(cmd, { onLine, onExit } = {}) {
  const child = spawn(cmd.java, cmd.args, {
    cwd: cmd.cwd,
    detached: true,
    windowsHide: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  const parser = new LogParser();
  const errParser = new LogParser();
  let exited = false;
  const finish = (code, signal) => {
    if (exited) return;
    exited = true;
    if (onExit) onExit(code, signal);
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => parser.push(d).forEach((l) => onLine && onLine(l)));
  child.stderr.on('data', (d) =>
    errParser.push(d).forEach((l) => onLine && onLine({ ...l, level: l.level === 'INFO' ? 'WARN' : l.level })),
  );
  child.on('exit', (code, signal) => finish(code, signal));
  child.on('error', (err) => {
    if (onLine) onLine({ level: 'ERROR', text: t('java.spawnFailed', { error: err.message }) });
    finish(-1, null);
  });
  return child;
}

module.exports = { buildCommand, spawnGame, splitArgs, LogParser, AIKAR_FLAGS, CONSOLE_UTF8, VANILLA_G1, gcArgs, sanitizeForJava };
