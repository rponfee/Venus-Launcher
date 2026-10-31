'use strict';
// Cliente MCP (Model Context Protocol) para los servidores que el usuario le agrega al asistente del launcher
// (Ajustes > IA > Servidores MCP del asistente). Sin dependencias ni Electron: lo usan
// assistant/mcp-servers.js y las pruebas (mcp/test/client.test.js).
//
// Transportes:
//   - stdio: lanza el programa SIN shell (spawn con argumentos, nunca shell: true), con el entorno que se le
//     pasa (minimalEnv() + las variables del usuario), y habla JSON-RPC en lineas por stdin/stdout. En
//     Windows, un .cmd/.bat de npm (npx, por ejemplo) se resuelve al script de Node que envuelve: nunca se
//     ejecuta cmd.exe. Al cerrar se corta stdin y despues se termina el arbol de procesos.
//   - Streamable HTTP: un POST por mensaje; la respuesta llega como JSON o como flujo SSE. En la era heredada
//     se respeta la sesion (Mcp-Session-Id) y se vuelve a iniciar una vez si el servidor la da por vencida.
//     Sin redirecciones (podrian llevar el token a otro lado).
// Versiones: primero la moderna (2026-07-28: sin handshake, server/discover y _meta en cada pedido, mas los
// encabezados MCP-Protocol-Version, Mcp-Method y Mcp-Name en HTTP); si el servidor no la conoce, la heredada
// con initialize + notifications/initialized (2025-11-25, 2025-06-18, 2025-03-26 y 2024-11-05).
// Cada pedido tiene plazo y se puede cancelar con un AbortSignal: al cortar se avisa notifications/cancelled.
//
// createClient({ type: 'stdio', command, args, env, cwd } | { type: 'http', url, token }, opciones)
//   -> { connect, listTools, callTool, close, info(), alive, era }
// Errores: McpError con code 'notFound' | 'cmdScript' | 'spawn' | 'exited' | 'closed' | 'timeout' | 'aborted' |
//   'network' | 'http' | 'auth' | 'redirect' | 'protocol' | 'version' | 'rpc' | 'tooLarge'.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { MODERN_VERSIONS, LEGACY_VERSIONS, META, ERR } = require('./protocol');

const MODERN = MODERN_VERSIONS[0];
const LATEST_LEGACY = LEGACY_VERSIONS[0];
const DEFAULTS = {
  connectMs: 30000, // conectar (incluye el arranque de un programa local, que con npx puede tardar)
  requestMs: 30000, // pedidos sin plazo propio (tools/list)
  discoverMs: 4000, // cuanto se espera server/discover en stdio antes de probar initialize
  maxMessageBytes: 8 * 1024 * 1024,
  maxPages: 20,
};

class McpError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    if (data && typeof data === 'object') Object.assign(this, data);
  }
}

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const sameId = (a, b) => a !== undefined && a !== null && String(a) === String(b);

// ---------- Entorno minimo ----------
// Lo justo para que un programa funcione (carpetas del usuario, PATH, temporales); nada de las variables del
// launcher (ELECTRON_RUN_AS_NODE, NODE_OPTIONS, VENUS_*...). Encima van las variables que puso el usuario.
const WIN_ENV = new Set(['APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'USERPROFILE', 'USERNAME', 'USERDOMAIN', 'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'SYSTEMDRIVE', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'PROGRAMDATA', 'COMMONPROGRAMFILES', 'COMSPEC', 'OS']);
const POSIX_ENV = new Set(['HOME', 'LOGNAME', 'USER', 'PATH', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']);

function minimalEnv(extra = {}, { env = process.env, platform = process.platform, homedir = os.homedir() } = {}) {
  const win = platform === 'win32';
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    // Las funciones exportadas de bash ("() { ... }") no se pasan
    if (typeof v !== 'string' || v.startsWith('()')) continue;
    if ((win ? WIN_ENV : POSIX_ENV).has(win ? k.toUpperCase() : k)) out[k] = v;
  }
  if (!win) {
    // Una app abierta desde el escritorio (macOS) tiene un PATH minimo: se suman las carpetas habituales
    const parts = String(out.PATH || '/usr/bin:/bin').split(':').filter(Boolean);
    for (const p of ['/usr/local/bin', '/opt/homebrew/bin', path.join(homedir, '.local', 'bin')]) if (!parts.includes(p)) parts.push(p);
    out.PATH = parts.join(':');
  }
  for (const [k, v] of Object.entries(extra || {})) {
    // En Windows los nombres no distinguen mayusculas: "Path" del usuario reemplaza a "PATH"
    if (win) for (const old of Object.keys(out)) if (old.toUpperCase() === k.toUpperCase()) delete out[old];
    out[k] = String(v);
  }
  return out;
}

// ---------- Programa a lanzar (sin shell) ----------
function envGet(env, name, platform) {
  if (platform !== 'win32') return env[name];
  const k = Object.keys(env || {}).find((x) => x.toUpperCase() === name);
  return k ? env[k] : undefined;
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// npm, pnpm y yarn instalan un .cmd que llama a node con un script, directo ("%dp0%\node_modules\...\cli.js" %*)
// o con variables (SET "NPX_CLI_JS=%~dp0\node_modules\npm\bin\npx-cli.js" y despues "%NODE_EXE%" "%NPX_CLI_JS%" %*).
// Devuelve la ruta del script (siempre dentro de la carpeta del .cmd) o null.
function parseCmdShim(file) {
  let text;
  try {
    if (fs.statSync(file).size > 64 * 1024) return null;
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const dir = path.dirname(file);
  const vars = new Map(); // VARIABLE -> valores que se le asignan (en orden)
  for (const m of text.matchAll(/^[ \t]*@?SET[ \t]+"?([A-Za-z_][\w]*)=([^"\r\n]*)"?[ \t]*$/gim)) {
    const k = m[1].toUpperCase();
    if (!vars.has(k)) vars.set(k, []);
    vars.get(k).push(m[2]);
  }
  const lines = text.split(/\r?\n/).filter((l) => l.includes('%*')).reverse();
  for (const line of lines) {
    for (const q of [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1])) {
      const ref = /^%([A-Za-z_][\w]*)%$/.exec(q);
      for (const v of ref ? vars.get(ref[1].toUpperCase()) || [] : [q]) {
        if (!/\.[cm]?js$/i.test(v)) continue;
        const rel = v.replace(/^(?:%~dp0|%dp0%)\\?/i, '');
        if (rel === v || /%/.test(rel)) continue;
        const script = path.resolve(dir, rel);
        if ((script === dir || script.startsWith(dir + path.sep)) && isFile(script)) return script;
      }
    }
  }
  return null;
}

/**
 * Resuelve el programa como lo haria la consola, pero para lanzarlo sin ella. En Windows busca en el PATH con
 * las extensiones de PATHEXT y convierte un .cmd/.bat de npm en node.exe + script; cualquier otro .cmd/.bat
 * se rechaza (code 'cmdScript'). En macOS y Linux se deja tal cual (spawn ya busca en el PATH).
 * -> { file, args (van antes de los del usuario), shim? }
 */
function resolveCommand(command, { env = process.env, platform = process.platform } = {}) {
  const cmd = String(command || '').trim();
  if (!cmd) throw new McpError('notFound', 'Empty command', { command: cmd });
  if (platform !== 'win32') return { file: cmd, args: [] };
  const exts = String(envGet(env, 'PATHEXT', platform) || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => /^\.[a-z0-9]+$/.test(e));
  const hasPath = /[\\/]/.test(cmd) || path.win32.isAbsolute(cmd);
  const ext = path.extname(cmd).toLowerCase();
  // Sin extension conocida se prueban las de PATHEXT (nunca un archivo sin extension del PATH: suele ser un
  // script de bash, como el "npx" que trae Node)
  const names = exts.includes(ext) ? [cmd] : [...exts.map((e) => cmd + e), ...(hasPath ? [cmd] : [])];
  const dirs = hasPath
    ? ['']
    : String(envGet(env, 'PATH', platform) || '')
        .split(';')
        .map((d) => d.trim().replace(/^"|"$/g, ''))
        .filter(Boolean);
  let found = null;
  for (const dir of dirs) {
    for (const n of names) {
      const full = dir ? path.join(dir, n) : n;
      if (isFile(full)) {
        found = path.resolve(full);
        break;
      }
    }
    if (found) break;
  }
  if (!found) throw new McpError('notFound', `Command not found: ${cmd}`, { command: cmd });
  if (/\.(cmd|bat)$/i.test(found)) {
    const script = parseCmdShim(found);
    if (!script) throw new McpError('cmdScript', `${cmd} is a .cmd/.bat script`, { command: cmd });
    let node = isFile(path.join(path.dirname(found), 'node.exe')) ? path.join(path.dirname(found), 'node.exe') : null;
    if (!node) {
      try {
        node = resolveCommand('node', { env, platform }).file;
      } catch {
        node = null;
      }
    }
    if (!node || !/\.(exe|com)$/i.test(node)) throw new McpError('notFound', 'node.exe not found', { command: 'node' });
    return { file: node, args: [script], shim: found };
  }
  return { file: found, args: [] };
}

// ---------- Procesos vivos (se cierran al salir) ----------
const children = new Set();
let exitHooked = false;
function trackChild(child) {
  children.add(child);
  child.once('exit', () => children.delete(child));
  if (!exitHooked) {
    exitHooked = true;
    // Respaldo si el launcher se cierra sin pasar por close(): el proceso directo se corta igual
    process.once('exit', () => {
      for (const c of children) {
        try {
          c.kill();
        } catch {
          /* ya cerrado */
        }
      }
    });
  }
}

// Termina el proceso y sus hijos (npx lanza el servidor real como otro proceso).
function killTree(child, platform = process.platform) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, 3000);
    child.once('exit', done);
    if (platform === 'win32') {
      const taskkill = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'taskkill.exe');
      try {
        const k = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
        k.on('error', () => {
          try {
            child.kill();
          } catch {
            /* ya cerrado */
          }
        });
      } catch {
        try {
          child.kill();
        } catch {
          /* ya cerrado */
        }
      }
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        try {
          child.kill('SIGTERM');
        } catch {
          /* ya cerrado */
        }
      }
      setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* ya cerrado */
        }
      }, 1500).unref?.();
    }
  });
}

// ---------- Plazos y cancelacion ----------
// Une el AbortSignal de quien llama con un plazo. kind() dice que corto: 'timeout' o 'aborted'.
function deadline(signal, ms) {
  const ctl = new AbortController();
  let why = null;
  const onAbort = () => {
    why = why || 'aborted';
    ctl.abort();
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const timer = Number.isFinite(ms) && ms > 0 ? setTimeout(() => {
    why = why || 'timeout';
    ctl.abort();
  }, ms) : null;
  return {
    signal: ctl.signal,
    kind: () => why,
    done() {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

const timeoutError = () => new McpError('timeout', 'The MCP server did not answer in time');
const abortError = () => new McpError('aborted', 'Cancelled');

// ---------- Transporte stdio ----------
function createStdioTransport(o, onServerMessage, onExit) {
  let child = null;
  let starting = null;
  let exited = null; // { code, signal, stderr }
  let buf = '';
  let stderr = '';
  let nextId = 1;
  const pending = new Map(); // id -> { resolve, reject }
  const decoder = new StringDecoder('utf8');
  const platform = o.platform || process.platform;

  function failAll(err) {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  }

  function onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // algunos servidores escriben avisos por stdout: no es JSON, se ignora
    }
    for (const m of Array.isArray(msg) ? msg : [msg]) {
      if (!isObject(m)) continue;
      if (m.method === undefined && ('result' in m || 'error' in m)) {
        const key = String(m.id);
        const p = pending.get(key);
        if (p) {
          pending.delete(key);
          p.resolve(m);
        }
      } else if (typeof m.method === 'string') onServerMessage(m, (reply) => write(reply));
    }
  }

  function write(msg) {
    if (!child || exited || !child.stdin?.writable) throw new McpError('closed', 'The MCP server process is not running');
    child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  function start() {
    if (starting) return starting;
    starting = new Promise((resolve, reject) => {
      let r;
      try {
        r = resolveCommand(o.command, { env: o.env || process.env, platform });
      } catch (err) {
        reject(err);
        return;
      }
      try {
        child = spawn(r.file, [...r.args, ...(o.args || [])], {
          cwd: o.cwd || os.homedir(),
          env: o.env || minimalEnv(),
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          // En macOS y Linux, grupo de procesos propio para poder cerrar tambien a sus hijos
          detached: platform !== 'win32',
        });
      } catch (err) {
        reject(new McpError('spawn', err.message || String(err), { command: o.command }));
        return;
      }
      trackChild(child);
      child.once('spawn', () => resolve());
      child.once('error', (err) => {
        const e = err.code === 'ENOENT' ? new McpError('notFound', `Command not found: ${o.command}`, { command: o.command }) : new McpError('spawn', err.message || String(err), { command: o.command });
        if (!exited) exited = { code: null, signal: null, stderr };
        failAll(e);
        reject(e);
      });
      child.stdout.on('data', (chunk) => {
        buf += decoder.write(chunk);
        if (buf.length > o.maxMessageBytes) {
          // Un mensaje gigante sin fin de linea: se corta el proceso
          buf = '';
          failAll(new McpError('tooLarge', 'The MCP server sent a message that is too large'));
          killTree(child, platform);
          return;
        }
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, '');
          buf = buf.slice(i + 1);
          if (line.trim()) onLine(line);
        }
      });
      child.stderr.on('data', (d) => {
        stderr = (stderr + d.toString('utf8')).slice(-4000);
      });
      child.stdin.on('error', () => {}); // EPIPE si el proceso ya se cerro
      child.once('exit', (code, signal) => {
        exited = { code, signal, stderr };
        failAll(new McpError('exited', `The MCP server exited (${code ?? signal})`, { exitCode: code, stderr: tail(stderr) }));
        onExit?.(exited);
      });
    });
    return starting;
  }

  async function request(method, params, { signal, timeoutMs, noticeMeta } = {}) {
    await start();
    const id = nextId++;
    const dl = deadline(signal, timeoutMs);
    try {
      return await new Promise((resolve, reject) => {
        const key = String(id);
        pending.set(key, { resolve, reject });
        dl.signal.addEventListener(
          'abort',
          () => {
            if (!pending.delete(key)) return;
            // Se le avisa al servidor que ya no hace falta (si sigue vivo)
            try {
              write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: dl.kind() === 'timeout' ? 'timeout' : 'cancelled by the user', ...(noticeMeta ? { _meta: noticeMeta } : {}) } });
            } catch {
              /* proceso cerrado */
            }
            reject(dl.kind() === 'timeout' ? timeoutError() : abortError());
          },
          { once: true },
        );
        try {
          write({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
        } catch (err) {
          pending.delete(key);
          reject(err);
        }
      });
    } finally {
      dl.done();
    }
  }

  async function notify(method, params) {
    await start();
    write({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) });
  }

  async function close({ force = false } = {}) {
    if (!child || exited) return;
    const c = child;
    // Cierre ordenado: sin stdin el servidor deberia terminar solo; si no, se corta el arbol de procesos
    try {
      c.stdin.end();
    } catch {
      /* ya cerrado */
    }
    if (!force) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 700);
        c.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    await killTree(c, platform);
  }

  return {
    start,
    request,
    notify,
    close,
    get alive() {
      return Boolean(child) && !exited;
    },
    get stderr() {
      return tail(stderr);
    },
    get pid() {
      return child?.pid || null;
    },
  };
}

function tail(text) {
  // Sin codigos de color de la consola
  return String(text || '')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .trim()
    .slice(-1200);
}

// ---------- Transporte Streamable HTTP ----------
// Valor de encabezado seguro (Mcp-Name): ASCII visible tal cual; si no, en Base64 ("=?base64?...?=").
function headerValue(v) {
  const s = String(v ?? '');
  return /^[\x21-\x7E](?:[\x20-\x7E]*[\x21-\x7E])?$/.test(s) ? s : `=?base64?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

async function readLimited(res, max) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      reader.cancel().catch(() => {});
      throw new McpError('tooLarge', 'The MCP server answer is too large');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function createHttpTransport(o, onServerMessage) {
  const fetchImpl = o.fetch || globalThis.fetch;
  let sessionId = null;
  let nextId = 1;
  let host = '?';
  try {
    host = new URL(o.url).host;
  } catch {
    host = '?';
  }

  function baseHeaders(extra) {
    const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (o.token) h.Authorization = `Bearer ${o.token}`;
    if (sessionId) h['Mcp-Session-Id'] = sessionId;
    return { ...h, ...(extra || {}) };
  }

  // Encabezados de un mensaje que no es un pedido (aviso o respuesta): solo la version, sin Mcp-Name.
  function plainHeaders(headers, method) {
    if (!headers) return undefined;
    const h = {};
    if (headers['MCP-Protocol-Version']) h['MCP-Protocol-Version'] = headers['MCP-Protocol-Version'];
    if (method && headers['Mcp-Method']) h['Mcp-Method'] = method;
    return h;
  }

  // Mensajes de un cuerpo (JSON o evento SSE): devuelve la respuesta esperada si esta; el resto (avisos y
  // pedidos del servidor) se atiende aparte.
  function pick(payload, expectId, headers) {
    let data;
    try {
      data = JSON.parse(payload);
    } catch {
      throw new McpError('protocol', 'The MCP server sent invalid JSON');
    }
    let found = null;
    for (const m of Array.isArray(data) ? data : [data]) {
      if (!isObject(m)) continue;
      if (m.method === undefined && ('result' in m || 'error' in m)) {
        if (sameId(m.id, expectId)) found = m;
      } else if (typeof m.method === 'string') {
        onServerMessage(m, (reply) => post(reply, { headers: plainHeaders(headers) }).catch(() => {}));
      }
    }
    return found;
  }

  async function readSse(res, expectId, headers) {
    if (!res.body) throw new McpError('protocol', 'Empty SSE stream');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let size = 0;
    let data = [];
    const flush = () => {
      if (!data.length) return null;
      const payload = data.join('\n');
      data = [];
      return pick(payload, expectId, headers);
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > o.maxMessageBytes) throw new McpError('tooLarge', 'The MCP server answer is too large');
        buf += decoder.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, '');
          buf = buf.slice(i + 1);
          if (line === '') {
            const found = flush();
            if (found) return found;
            continue;
          }
          if (line.startsWith(':')) continue;
          const c = line.indexOf(':');
          const field = c < 0 ? line : line.slice(0, c);
          let val = c < 0 ? '' : line.slice(c + 1);
          if (val.startsWith(' ')) val = val.slice(1);
          if (field === 'data') data.push(val);
        }
      }
      if (buf.trim()) {
        const c = buf.indexOf(':');
        if (c > 0 && buf.slice(0, c) === 'data') data.push(buf.slice(c + 1).replace(/^ /, ''));
      }
      const found = flush();
      if (found) return found;
      throw new McpError('protocol', 'The SSE stream ended without an answer');
    } finally {
      reader.cancel().catch(() => {});
    }
  }

  // Un POST. Con expectId espera esa respuesta (JSON o SSE); sin el (avisos y respuestas) solo lo manda.
  async function post(body, { signal, timeoutMs, headers, expectId } = {}) {
    const dl = deadline(signal, timeoutMs || o.requestMs);
    const hadSession = Boolean(sessionId);
    try {
      let res;
      try {
        res = await fetchImpl(o.url, { method: 'POST', headers: baseHeaders(headers), body: JSON.stringify(body), signal: dl.signal, redirect: 'manual' });
      } catch (err) {
        if (dl.kind() === 'timeout') throw timeoutError();
        if (dl.kind() === 'aborted') throw abortError();
        throw new McpError('network', `Could not connect to ${host}: ${err?.cause?.code || err?.message || err}`, { host });
      }
      if (res.status >= 300 && res.status < 400) {
        res.body?.cancel().catch(() => {});
        throw new McpError('redirect', `The MCP server redirected to another address (HTTP ${res.status})`, { status: res.status });
      }
      const sid = res.headers.get('mcp-session-id');
      if (sid && /^[\x21-\x7E]{1,256}$/.test(sid)) sessionId = sid;
      if (expectId === undefined) {
        res.body?.cancel().catch(() => {});
        return null;
      }
      if (res.status === 401 || res.status === 403) {
        res.body?.cancel().catch(() => {});
        throw new McpError('auth', `HTTP ${res.status}`, { status: res.status });
      }
      if (res.status === 404 && hadSession) {
        // La sesion de la era heredada vencio: hay que iniciar de nuevo
        sessionId = null;
        res.body?.cancel().catch(() => {});
        throw new McpError('sessionExpired', 'The MCP session expired', { status: 404 });
      }
      if (!res.ok) {
        const text = await readLimited(res, 4096).catch(() => '');
        let j = null;
        try {
          j = JSON.parse(text);
        } catch {
          j = null;
        }
        const detail = String(j?.error?.message || j?.message || '').slice(0, 200);
        throw new McpError('http', `HTTP ${res.status}${detail ? `: ${detail}` : ''}`, { status: res.status, rpcCode: j?.error?.code });
      }
      const type = String(res.headers.get('content-type') || '').toLowerCase();
      let found;
      try {
        if (type.includes('text/event-stream')) found = await readSse(res, expectId, headers);
        else if (type.includes('json')) found = pick(await readLimited(res, o.maxMessageBytes), expectId, headers);
        else {
          res.body?.cancel().catch(() => {});
          throw new McpError('protocol', `Unexpected content type: ${type.slice(0, 60) || 'none'}`);
        }
      } catch (err) {
        if (dl.kind() === 'timeout') throw timeoutError();
        if (dl.kind() === 'aborted') throw abortError();
        throw err;
      }
      if (!found) throw new McpError('protocol', 'The MCP server did not answer the request');
      return found;
    } finally {
      dl.done();
    }
  }

  async function request(method, params, { signal, timeoutMs, headers, noticeMeta } = {}) {
    const id = nextId++;
    try {
      return await post({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }, { signal, timeoutMs, headers, expectId: id });
    } catch (err) {
      if (err.code === 'aborted' || err.code === 'timeout') {
        // Se le avisa al servidor que ya no hace falta (el corte de la conexion tambien lo cancela)
        const params2 = { requestId: id, reason: err.code === 'timeout' ? 'timeout' : 'cancelled by the user', ...(noticeMeta ? { _meta: noticeMeta } : {}) };
        post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: params2 }, { headers: plainHeaders(headers, 'notifications/cancelled'), timeoutMs: 3000 }).catch(() => {});
      }
      throw err;
    }
  }

  async function notify(method, params, { headers } = {}) {
    await post({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) }, { headers, timeoutMs: 5000 }).catch(() => {});
  }

  async function close() {
    if (!sessionId) return;
    const sid = sessionId;
    sessionId = null;
    // Fin de la sesion heredada (opcional para el servidor: si no lo admite responde 405)
    const dl = deadline(null, 2000);
    try {
      const res = await fetchImpl(o.url, { method: 'DELETE', headers: { ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}), 'Mcp-Session-Id': sid }, signal: dl.signal, redirect: 'manual' });
      res.body?.cancel().catch(() => {});
    } catch {
      /* sin conexion */
    } finally {
      dl.done();
    }
  }

  return {
    start: async () => {},
    request,
    notify,
    close,
    get alive() {
      return true;
    },
    get stderr() {
      return '';
    },
    get session() {
      return sessionId;
    },
    resetSession() {
      sessionId = null;
    },
  };
}

// ---------- Cliente ----------
// Errores que no tiene sentido reintentar con la otra era (el servidor ni siquiera responde bien).
const FATAL = new Set(['notFound', 'cmdScript', 'spawn', 'exited', 'closed', 'network', 'auth', 'redirect', 'aborted', 'tooLarge']);

function createClient(spec, opts = {}) {
  const o = { ...DEFAULTS, ...spec, ...opts };
  const clientInfo = { name: 'venus-launcher', title: 'Venus Launcher', version: String(o.version || '0.0.0') };
  const state = { era: null, version: null, serverInfo: null, instructions: '', capabilities: {}, closed: false };
  let connecting = null;

  // Mensajes que inicia el servidor: avisos (lista de herramientas cambiada) y pedidos (ping). No ofrecemos
  // sampling, roots ni elicitation: esos pedidos reciben "metodo no encontrado".
  function onServerMessage(m, reply) {
    if (m.id === undefined || m.id === null) {
      if (m.method === 'notifications/tools/list_changed') {
        try {
          o.onListChanged?.();
        } catch {
          /* solo informativo */
        }
      }
      return;
    }
    const answer = m.method === 'ping' ? { jsonrpc: '2.0', id: m.id, result: {} } : { jsonrpc: '2.0', id: m.id, error: { code: ERR.METHOD_NOT_FOUND, message: 'Method not supported by this client' } };
    try {
      reply(answer);
    } catch {
      /* conexion cerrada */
    }
  }

  const tx = o.type === 'http' ? createHttpTransport(o, onServerMessage) : createStdioTransport(o, onServerMessage, (info) => o.onExit?.(info));

  const modernMeta = () => ({ [META.version]: MODERN, [META.clientInfo]: clientInfo, [META.clientCapabilities]: {} });

  function headersFor(method, name) {
    if (o.type !== 'http') return undefined;
    if (state.era === 'modern') return { 'MCP-Protocol-Version': MODERN, 'Mcp-Method': method, ...(name !== undefined ? { 'Mcp-Name': headerValue(name) } : {}) };
    if (state.era === 'legacy' && state.version) return { 'MCP-Protocol-Version': state.version };
    return undefined;
  }

  function resultOf(res) {
    if (!isObject(res)) throw new McpError('protocol', 'Invalid JSON-RPC answer');
    if (res.error) {
      const e = isObject(res.error) ? res.error : {};
      throw new McpError('rpc', String(e.message || 'Error').slice(0, 500), { rpcCode: e.code });
    }
    if (!('result' in res)) throw new McpError('protocol', 'The answer has no result');
    const r = res.result;
    if (state.era === 'modern' && isObject(r) && r.resultType !== undefined && r.resultType !== 'complete') {
      // Resultados que piden algo al usuario (por ejemplo, completar datos): este cliente no los admite
      throw new McpError('protocol', `Unsupported result type: ${String(r.resultType).slice(0, 40)}`);
    }
    return r;
  }

  async function rawRpc(method, params, { signal, timeoutMs, name } = {}) {
    const modern = state.era === 'modern';
    const p = modern ? { ...(isObject(params) ? params : {}), _meta: { ...(isObject(params?._meta) ? params._meta : {}), ...modernMeta() } } : params;
    const res = await tx.request(method, p, { signal, timeoutMs: timeoutMs || o.requestMs, headers: headersFor(method, name), noticeMeta: modern ? modernMeta() : undefined });
    return resultOf(res);
  }

  // server/discover (era moderna). Devuelve true si el servidor la admite; false si hay que usar initialize.
  async function discover(ms) {
    const res = await tx.request('server/discover', { _meta: modernMeta() }, {
      timeoutMs: ms,
      headers: o.type === 'http' ? { 'MCP-Protocol-Version': MODERN, 'Mcp-Method': 'server/discover' } : undefined,
    });
    if (!isObject(res) || res.error || !isObject(res.result)) return false;
    const r = res.result;
    const supported = Array.isArray(r.supportedVersions) ? r.supportedVersions : [];
    if (!supported.includes(MODERN)) return false;
    state.era = 'modern';
    state.version = MODERN;
    const si = (isObject(r._meta) && r._meta[META.serverInfo]) || r.serverInfo;
    state.serverInfo = isObject(si) ? si : null;
    state.capabilities = isObject(r.capabilities) ? r.capabilities : {};
    state.instructions = typeof r.instructions === 'string' ? r.instructions : '';
    return true;
  }

  async function initialize(ms) {
    // Una sesion que haya abierto el intento moderno no vale para initialize
    tx.resetSession?.();
    const res = await tx.request('initialize', { protocolVersion: LATEST_LEGACY, capabilities: {}, clientInfo }, { timeoutMs: ms });
    if (!isObject(res)) throw new McpError('protocol', 'Invalid JSON-RPC answer');
    if (res.error) throw new McpError('rpc', String(res.error.message || 'Error').slice(0, 500), { rpcCode: res.error.code });
    const r = isObject(res.result) ? res.result : null;
    if (!r) throw new McpError('protocol', 'The initialize answer has no result');
    const v = typeof r.protocolVersion === 'string' ? r.protocolVersion : null;
    if (!v || !LEGACY_VERSIONS.includes(v)) throw new McpError('version', `Unsupported MCP version: ${String(v).slice(0, 30)}`, { version: v });
    state.era = 'legacy';
    state.version = v;
    state.serverInfo = isObject(r.serverInfo) ? r.serverInfo : null;
    state.capabilities = isObject(r.capabilities) ? r.capabilities : {};
    state.instructions = typeof r.instructions === 'string' ? r.instructions : '';
    await tx.notify('notifications/initialized', undefined, { headers: o.type === 'http' ? { 'MCP-Protocol-Version': v } : undefined }).catch(() => {});
  }

  async function doConnect() {
    if (state.closed) throw new McpError('closed', 'The MCP client is closed');
    await tx.start();
    const until = Date.now() + o.connectMs;
    const left = () => Math.max(1000, until - Date.now());
    let discoverTimedOut = false;
    if (o.eraHint !== 'legacy') {
      try {
        // En stdio el programa puede tardar en arrancar (npx descarga el paquete): se espera poco y, si no
        // contesta, se prueba initialize igual (lo que llegue tarde de server/discover se ignora)
        if (await discover(o.type === 'http' ? Math.min(left(), 15000) : Math.min(left(), o.discoverMs))) return info();
      } catch (err) {
        if (FATAL.has(err.code)) throw err;
        if (err.code === 'timeout') discoverTimedOut = true;
      }
    }
    try {
      await initialize(left());
    } catch (err) {
      // Un servidor solo moderno que tardo en arrancar: ahora si contesta server/discover
      if (discoverTimedOut && err.code === 'rpc' && (await discover(Math.min(left(), 10000)).catch(() => false))) return info();
      throw err;
    }
    return info();
  }

  async function connect({ signal } = {}) {
    if (state.era) return info();
    if (!connecting) {
      connecting = doConnect().finally(() => {
        connecting = null;
      });
    }
    // El corte de quien espera no corta la conexion (otro pedido puede estar usandola)
    if (!signal) return connecting;
    if (signal.aborted) throw abortError();
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(abortError());
      signal.addEventListener('abort', onAbort, { once: true });
      connecting.then(
        (v) => {
          signal.removeEventListener('abort', onAbort);
          resolve(v);
        },
        (err) => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        },
      );
    });
  }

  // Un pedido con la era ya elegida. Si la sesion HTTP heredada vencio, se inicia de nuevo una vez.
  async function call(method, params, opts = {}) {
    await connect({ signal: opts.signal });
    try {
      return await rawRpc(method, params, opts);
    } catch (err) {
      if (err.code !== 'sessionExpired') throw err;
      state.era = null;
      state.version = null;
      await connect({ signal: opts.signal });
      return rawRpc(method, params, opts);
    }
  }

  async function listTools({ signal, timeoutMs } = {}) {
    const all = [];
    let cursor = null;
    for (let page = 0; page < o.maxPages; page++) {
      let r;
      try {
        r = await call('tools/list', cursor ? { cursor } : {}, { signal, timeoutMs });
      } catch (err) {
        // Un servidor sin herramientas (no las anuncia y no conoce el metodo)
        if (err.code === 'rpc' && err.rpcCode === ERR.METHOD_NOT_FOUND && !state.capabilities.tools) return [];
        throw err;
      }
      const tools = Array.isArray(r?.tools) ? r.tools : [];
      all.push(...tools);
      cursor = typeof r?.nextCursor === 'string' && r.nextCursor ? r.nextCursor : null;
      if (!cursor || all.length >= 1000) break;
    }
    return all;
  }

  async function callTool(name, args, { signal, timeoutMs } = {}) {
    const r = await call('tools/call', { name, arguments: isObject(args) ? args : {} }, { signal, timeoutMs, name });
    if (!isObject(r)) throw new McpError('protocol', 'Invalid tools/call result');
    return r;
  }

  function info() {
    return {
      era: state.era,
      version: state.version,
      serverInfo: state.serverInfo ? { name: String(state.serverInfo.name || '').slice(0, 80), title: typeof state.serverInfo.title === 'string' ? state.serverInfo.title.slice(0, 80) : null, version: String(state.serverInfo.version || '').slice(0, 40) } : null,
      instructions: state.instructions.slice(0, 4000),
      hasTools: Boolean(state.capabilities.tools),
    };
  }

  async function close({ force = false } = {}) {
    state.closed = true;
    await tx.close({ force }).catch(() => {});
  }

  return {
    connect,
    listTools,
    callTool,
    close,
    info,
    get era() {
      return state.era;
    },
    get alive() {
      return !state.closed && tx.alive;
    },
    get stderr() {
      return tx.stderr;
    },
    get pid() {
      return tx.pid || null;
    },
  };
}

module.exports = { createClient, McpError, minimalEnv, resolveCommand, parseCmdShim, headerValue, killTree, DEFAULTS, MODERN, LATEST_LEGACY };
