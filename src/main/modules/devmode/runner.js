'use strict';
// Ejecuta el build del proyecto (Gradle o Maven): arma el comando, lo lanza con el JDK elegido,
// manda la salida en vivo (clasificada por nivel), detecta exito o error, extrae el resumen de
// errores y permite cancelarlo matando el arbol de procesos. Node puro: se puede probar sin Electron.
const { spawn } = require('child_process');
const path = require('path');

const WIN = process.platform === 'win32';
const TOKEN = /^[\w:.\-=+,/@]+$/;

class ArgsError extends Error {
  constructor(code, value) {
    super(code);
    this.code = code;
    this.value = value;
  }
}

// Separa y valida tareas o argumentos escritos por el usuario (sin comillas ni caracteres de la consola).
function splitTokens(text, re = TOKEN) {
  const parts = String(text || '')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const p of parts) if (!re.test(p) || p.length > 200) throw new ArgsError('badArgs', p);
  return parts;
}

// Comando del build: { exe, args, display }
function buildCommand({ tool, runner, task, args, skipTests }) {
  if (!runner) throw new ArgsError('noRunner');
  const tasks = splitTokens(task, /^[\w:.\-]+$/);
  const extra = splitTokens(args);
  if (tool === 'gradle') {
    const list = tasks.length ? tasks : ['build'];
    const out = [...list, '--console=plain'];
    if (skipTests && list.some((x) => /^(build|check|test)$/.test(x.split(':').pop()))) out.push('-x', 'test');
    out.push(...extra);
    return { exe: runner.exe, args: out, display: [runner.display, ...out].join(' ') };
  }
  if (tool === 'maven') {
    const list = tasks.length ? tasks : ['package'];
    const out = ['-B', ...list];
    if (skipTests) out.push('-DskipTests');
    out.push(...extra);
    return { exe: runner.exe, args: out, display: [runner.display, ...out].join(' ') };
  }
  throw new ArgsError('noTool');
}

// Entorno del build: JAVA_HOME del JDK elegido y salida en UTF-8.
function buildEnv(base, { jdkHome, tool }) {
  const env = { ...base };
  if (jdkHome) {
    env.JAVA_HOME = jdkHome;
    const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
    env[key] = `${path.join(jdkHome, 'bin')}${path.delimiter}${env[key] || ''}`;
  }
  const utf8 = '-Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8';
  if (tool === 'gradle') env.GRADLE_OPTS = `${env.GRADLE_OPTS || ''} ${utf8}`.trim();
  if (tool === 'maven') env.MAVEN_OPTS = `${env.MAVEN_OPTS || ''} ${utf8}`.trim();
  env.TERM = 'dumb';
  return env;
}

// Entre comillas cmd.exe toma & | < > ^ ! como texto; solo " y % (expansion de variables) no son seguros.
function quoteWin(arg) {
  const s = String(arg);
  if (s === '') return '""';
  if (/["%\r\n]/.test(s)) throw new ArgsError('badArgs', s);
  return /[\s=,;()&|<>^!]/.test(s) ? `"${s}"` : s;
}

// Lanza el ejecutable. En Windows los .bat/.cmd necesitan cmd.exe (Node no los ejecuta directo).
function spawnTool(exe, args, { cwd, env }) {
  if (WIN && /\.(bat|cmd)$/i.test(exe)) {
    const line = [exe, ...args].map(quoteWin).join(' ');
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { cwd, env, windowsHide: true, windowsVerbatimArguments: true });
  }
  if (!WIN && /(^|\/)(gradlew|mvnw)$/.test(exe)) return spawn('sh', [exe, ...args], { cwd, env });
  return spawn(exe, args, { cwd, env, windowsHide: true });
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (WIN) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {});
    else child.kill('SIGTERM');
  } catch {
    try {
      child.kill();
    } catch {
      /* ya termino */
    }
  }
}

// ---------- Salida ----------

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

function classify(line) {
  if (/^> Task |^\[INFO\] --- /.test(line)) return 'TASK';
  if (/BUILD SUCCESSFUL|BUILD SUCCESS\b/.test(line)) return 'GOOD';
  if (/^\[ERROR\]|^\[FATAL\]|\berror:|^e: |FAILURE:|BUILD FAILED|BUILD FAILURE|^\* What went wrong:|^\s*> .*(failed|error)|Exception( in thread|:)/i.test(line)) return 'ERROR';
  if (/^\[WARNING\]|\bwarning:|^w: |^\s*warning\b|Deprecated Gradle features/i.test(line)) return 'WARN';
  return 'INFO';
}

// Resumen de errores (lo importante para mostrar sin abrir toda la salida) y una pista si se reconoce el problema.
function summarize(lines, tool) {
  const out = [];
  const push = (s) => {
    const v = s.trim();
    if (v && !out.includes(v) && out.length < 10) out.push(v.length > 300 ? `${v.slice(0, 300)}…` : v);
  };
  for (const l of lines) if (/\.(java|kt|groovy|scala):\d+:?\s*(\d+:\s*)?error:|^e: (file:|[A-Za-z]:\\|\/)/.test(l)) push(l);
  if (tool === 'gradle') {
    const i = lines.findIndex((l) => /^\* What went wrong:/.test(l));
    if (i >= 0) {
      for (let k = i + 1; k < lines.length && !/^\* (Try|Get more help|Exception is)/.test(lines[k]); k++) {
        if (lines[k].trim()) push(lines[k].replace(/^>\s*/, ''));
      }
    }
  } else if (tool === 'maven') {
    for (const l of lines) {
      if (!/^\[(ERROR|FATAL)\]/.test(l)) continue;
      const v = l.replace(/^\[(ERROR|FATAL)\]\s*/, '');
      if (!v.trim() || /^-> \[Help|^To see the full stack|^Re-run Maven|^For more information about|^\[Help \d|^$|^After correcting the problems/.test(v)) continue;
      push(v);
    }
  }
  const all = lines.join('\n');
  let hint = null;
  if (/JAVA_HOME is not set|JAVA_HOME is set to an invalid directory|'java' is not recognized|"java" no se reconoce|java: command not found|No Java runtime present|Unable to locate a Java Runtime/i.test(all)) hint = 'noJava';
  else if (/Unsupported class file major version|Unsupported Java\. *Your build is currently configured to use Java|Gradle requires JVM \d+ or later|which is not supported for Gradle|incompatible with the Java version/i.test(all)) hint = 'javaVersion';
  else if (/Cannot find a Java installation on your machine matching|No matching toolchains found|Toolchain installation .* does not provide the required capabilities|invalid source release|invalid target release|release version \d+ not supported/i.test(all)) hint = 'toolchain';
  else if (/Task '[^']+' not found|Unknown lifecycle phase|Could not find goal|Task .* not found in root project/i.test(all)) hint = 'badTask';
  else if (/Could not (resolve|GET|HEAD) |Could not transfer artifact|Unknown host|UnknownHostException|Connection timed out|PKIX path building failed/i.test(all)) hint = 'network';
  else if (/is not recognized as an internal or external command|No such file or directory|cannot execute|Permission denied/i.test(all)) hint = 'noRunner';
  return { lines: out, hint };
}

/**
 * Ejecuta un build. opts: { exe, args, cwd, env, tool, onLines(lines), maxLines }
 * Devuelve { promise, cancel() }. La promesa resuelve { ok, code, cancelled, ms, summary, hint, tail }.
 */
function runBuild({ exe, args, cwd, env, tool, onLines, maxLines = 4000 }) {
  const startedAt = Date.now();
  const all = [];
  let child;
  let cancelled = false;
  let pending = [];
  let flushTimer = null;
  const flush = () => {
    flushTimer = null;
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    try {
      onLines?.(batch);
    } catch (err) {
      console.error('[devmode] onLines', err);
    }
  };
  const emit = (text) => {
    const line = { level: classify(text), text, t: Date.now() };
    all.push(text);
    if (all.length > maxLines) all.splice(0, all.length - maxLines);
    pending.push(line);
    if (!flushTimer) flushTimer = setTimeout(flush, 90);
  };

  const promise = new Promise((resolve) => {
    let buf = '';
    const onData = (d) => {
      buf += d.toString('utf8');
      const lines = buf.split(/\r?\n|\r(?!\n)/);
      buf = lines.pop();
      for (const raw of lines) {
        const text = raw.replace(ANSI, '').replace(/\s+$/, '');
        if (text) emit(text);
      }
    };
    let finished = false;
    const finish = (code, err) => {
      if (finished) return;
      finished = true;
      if (buf.trim()) emit(buf.replace(ANSI, '').trim());
      buf = '';
      clearTimeout(flushTimer);
      flush();
      const ms = Date.now() - startedAt;
      if (err) {
        resolve({ ok: false, code: null, cancelled, ms, summary: [err.message], hint: err.code === 'ENOENT' ? 'noRunner' : null, tail: all.slice(-40) });
        return;
      }
      const ok = !cancelled && code === 0;
      const sum = ok || cancelled ? { lines: [], hint: null } : summarize(all, tool);
      resolve({ ok, code, cancelled, ms, summary: sum.lines, hint: sum.hint, tail: all.slice(-40) });
    };
    try {
      child = spawnTool(exe, args, { cwd, env });
    } catch (err) {
      finish(null, err);
      return;
    }
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => finish(null, err));
    child.on('close', (code) => finish(code));
  });

  return {
    promise,
    startedAt,
    cancel() {
      cancelled = true;
      killTree(child);
    },
    get pid() {
      return child?.pid || null;
    },
  };
}

module.exports = { buildCommand, buildEnv, runBuild, splitTokens, classify, summarize, quoteWin, killTree, ArgsError };
