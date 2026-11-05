'use strict';
// CLIs de IA que la persona ya tiene en su PC (Claude Code y Codex) para la IA local del Buscador inteligente:
// los busca, mira si tienen sesion iniciada, los lanza sin shell y traduce su salida JSON. No toca sus credenciales
// ni su configuracion. (Antes vivia repartido entre los motores del Asistente y el MCP; el MCP se borro en la 4.6.)
//
//   detect({ refresh }) -> { at, claude: { installed, cli, loggedIn, method, plan, error }, chatgpt: {...} }
//   cached() / stale() / usable(det, engine) · spawnCli · runCli · writePrivate · ensurePrivateDir
// Funciones puras (se prueban sin CLI): parseClaudeLine, parseCodexLine, classifyFailure, childEnv.
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const EXTERNAL = Object.freeze(['claude', 'chatgpt']);
const APP_NAME = Object.freeze({ claude: 'Claude Code', chatgpt: 'Codex' });
const DETECT_TTL = 60000;
const DETECT_TIMEOUT = 20000;

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// ---------- Busqueda de los ejecutables ----------
// Entorno (inyectable para las pruebas).
function envOf(o = {}) {
  const env = o.env || process.env;
  const platform = o.platform || process.platform;
  const homedir = o.homedir || os.homedir();
  return {
    env,
    platform,
    homedir,
    appData: o.appData || env.APPDATA || path.join(homedir, 'AppData', 'Roaming'),
    localAppData: o.localAppData || env.LOCALAPPDATA || path.join(homedir, 'AppData', 'Local'),
  };
}

const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

// Primer ejecutable con alguno de esos nombres en el PATH o en las carpetas extra (el PATH de una app abierta desde
// el escritorio puede no incluirlas).
function firstExecutable(e, names, extra) {
  const win = e.platform === 'win32';
  const fromPath = String(e.env.PATH || e.env.Path || '')
    .split(win ? ';' : ':')
    .map((d) => d.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
  for (const dir of [...fromPath, ...extra]) {
    for (const n of names) {
      const full = path.join(dir, n);
      if (!isFile(full)) continue;
      if (!win) {
        try {
          fs.accessSync(full, fs.constants.X_OK);
        } catch {
          continue;
        }
      }
      return full;
    }
  }
  return null;
}

// Busca el comando `claude`.
function findClaudeCli(o = {}) {
  const e = envOf(o);
  const win = e.platform === 'win32';
  const names = win ? ['claude.exe', 'claude.cmd', 'claude.bat'] : ['claude'];
  const extra = win
    ? [path.join(e.homedir, '.local', 'bin'), path.join(e.appData, 'npm'), path.join(e.localAppData, 'Microsoft', 'WinGet', 'Links'), path.join(e.homedir, '.claude', 'local'), path.join(e.localAppData, 'Programs', 'claude')]
    : [path.join(e.homedir, '.local', 'bin'), path.join(e.homedir, '.claude', 'local'), '/usr/local/bin', '/opt/homebrew/bin', path.join(e.homedir, '.npm-global', 'bin'), path.join(e.homedir, '.bun', 'bin')];
  return firstExecutable(e, names, extra);
}

// Busca el comando `codex` (Windows: tambien la instalacion de la app de escritorio, la version mas nueva primero).
function findCodexCli(o = {}) {
  const e = envOf(o);
  const win = e.platform === 'win32';
  const names = win ? ['codex.exe', 'codex.cmd', 'codex.bat'] : ['codex'];
  const extra = [];
  if (win) {
    const bin = path.join(e.localAppData, 'OpenAI', 'Codex', 'bin');
    let versions = [];
    try {
      versions = fs
        .readdirSync(bin, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => {
          const full = path.join(bin, d.name);
          let mtime = 0;
          try {
            mtime = fs.statSync(path.join(full, 'codex.exe')).mtimeMs;
          } catch {
            mtime = 0;
          }
          return { full, mtime };
        })
        .filter((x) => x.mtime > 0)
        .sort((a, b) => b.mtime - a.mtime)
        .map((x) => x.full);
    } catch {
      versions = [];
    }
    extra.push(...versions, bin, path.join(e.appData, 'npm'), path.join(e.homedir, '.local', 'bin'), path.join(e.localAppData, 'Microsoft', 'WinGet', 'Links'), path.join(e.homedir, '.bun', 'bin'));
  } else {
    extra.push(path.join(e.homedir, '.local', 'bin'), '/usr/local/bin', '/opt/homebrew/bin', path.join(e.homedir, '.npm-global', 'bin'), path.join(e.homedir, '.bun', 'bin'), path.join(e.homedir, '.codex', 'bin'));
    if (e.platform === 'darwin') extra.push('/Applications/Codex.app/Contents/Resources', path.join(e.homedir, 'Applications', 'Codex.app', 'Contents', 'Resources'));
  }
  return firstExecutable(e, names, extra);
}

// ---------- Lanzar un CLI ----------
// Argumentos que se pueden pasar sin riesgo por cmd.exe (claude.cmd de npm).
const CMD_SAFE = (a) => typeof a === 'string' && !/["%!\r\n^]/.test(a);
function quoteCmd(a) {
  // "=", "," y ";" tambien separan argumentos en cmd: van entre comillas
  return /[\s&|<>()=,;]/.test(a) || !a ? `"${a}"` : a;
}

/**
 * Lanza un CLI (claude, codex) sin shell; los .cmd y .bat de npm van por cmd.exe con argumentos verificados.
 * Devuelve el proceso hijo. Lanza si los argumentos no son seguros para cmd.exe o si spawn falla.
 */
function spawnCli(cli, args, { platform = process.platform, ...opts } = {}) {
  const base = { windowsHide: true, ...opts };
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(cli)) {
    if (![cli, ...args].every(CMD_SAFE)) throw new Error('unsafe-args');
    const line = [cli, ...args].map(quoteCmd).join(' ');
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...base, windowsVerbatimArguments: true });
  }
  return spawn(cli, args, base);
}

/** Ejecuta el CLI y junta su salida. */
function runCli(cli, args, { timeout = 45000, platform = process.platform } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnCli(cli, args, { platform, timeout, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: err.message });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      if (stdout.length < 20000) stdout += d;
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < 20000) stderr += d;
    });
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: stderr || err.message }));
    child.on('close', (code) => resolve({ code: typeof code === 'number' ? code : -1, stdout, stderr }));
  });
}

// ---------- Archivos privados ----------
// Permisos: en macOS y Linux la carpeta queda 0700 y los archivos 0600. En Windows la carpeta queda solo para el
// usuario actual con icacls (sin herencia, por su SID); si icacls falla se restablece la herencia y se sigue.
const MARKER = '.private';

function exec(cmd, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

async function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (err) {
      if (i >= 6 || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err;
      await new Promise((r) => setTimeout(r, 100 * (i + 1)));
    }
  }
}

// Escrituras en serie por archivo: la ultima que se pide es la que queda.
const chains = new Map();

/** Escribe un archivo de forma atomica, solo legible por el usuario (0600 fuera de Windows). */
function writePrivate(file, data) {
  const prev = chains.get(file) || Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(async () => {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`;
      try {
        await fsp.writeFile(tmp, data, { mode: 0o600 });
        await renameRetry(tmp, file);
      } catch (err) {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
      if (process.platform !== 'win32') await fsp.chmod(file, 0o600).catch(() => {});
    });
  const tail = next.catch(() => {});
  chains.set(file, tail);
  tail.then(() => {
    if (chains.get(file) === tail) chains.delete(file);
  });
  return next;
}

// Herramientas de Windows con ruta completa (en el PATH puede haber otro "whoami", por ejemplo el de Git).
const sys32 = (exe) => path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', exe);

let sidCache;
async function currentSid() {
  if (sidCache !== undefined) return sidCache;
  const r = await exec(sys32('whoami.exe'), ['/user', '/fo', 'csv', '/nh']);
  const m = /"(S-1-[\d-]+)"/.exec(r.stdout);
  sidCache = m ? m[1] : null;
  return sidCache;
}

/** Crea la carpeta y la deja privada para el usuario (una sola vez: marca .private). */
async function ensurePrivateDir(dir) {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  if (fs.existsSync(path.join(dir, MARKER))) return true;
  let ok = true;
  if (process.platform === 'win32') {
    const sid = await currentSid();
    const r = sid ? await exec(sys32('icacls.exe'), [dir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`]) : { ok: false };
    if (!r.ok) {
      ok = false;
      if (sid) await exec(sys32('icacls.exe'), [dir, '/reset', '/T']);
    }
  } else {
    await fsp.chmod(dir, 0o700).catch(() => {
      ok = false;
    });
  }
  try {
    await fsp.writeFile(path.join(dir, MARKER), 'Venus Launcher: carpeta privada\n');
  } catch {
    // Nunca dejar la carpeta inaccesible: se vuelve a la herencia normal
    ok = false;
    if (process.platform === 'win32') await exec(sys32('icacls.exe'), [dir, '/reset', '/T']);
  }
  return ok;
}

// ---------- Deteccion (cada 60 s como mucho; se inyecta para las pruebas) ----------
const D = {
  at: 0,
  value: null,
  inflight: null,
  runCli: (cli, args, o) => runCli(cli, args, o),
  findClaude: () => findClaudeCli(),
  findCodex: () => findCodexCli(),
};

// El primer objeto JSON de una salida que puede traer avisos antes o despues.
function parseJsonLoose(text) {
  const s = String(text || '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch {
    return null;
  }
}

const empty = (error = null) => ({ installed: false, cli: null, loggedIn: null, method: null, plan: null, error });

async function detectClaude() {
  const cli = D.findClaude();
  const out = { ...empty(), installed: Boolean(cli), cli };
  if (!cli) return out;
  const r = await D.runCli(cli, ['auth', 'status'], { timeout: DETECT_TIMEOUT });
  const json = parseJsonLoose(r.stdout);
  if (json && typeof json.loggedIn === 'boolean') {
    out.loggedIn = json.loggedIn;
    const method = String(json.authMethod || '');
    out.method = method === 'claude.ai' ? 'subscription' : /api/i.test(method) ? 'apiKey' : method || null;
    out.plan = typeof json.subscriptionType === 'string' ? json.subscriptionType : null;
  } else if (r.code === -1) {
    out.error = String(r.stderr || 'spawn').trim().slice(0, 200);
  } else if (/not logged in|logged out/i.test(`${r.stdout}\n${r.stderr}`)) {
    out.loggedIn = false;
  } else if (r.code === 0 && /logged in/i.test(r.stdout)) {
    out.loggedIn = true;
  }
  return out;
}

async function detectCodex() {
  const cli = D.findCodex();
  const out = { ...empty(), installed: Boolean(cli), cli };
  if (!cli) return out;
  const r = await D.runCli(cli, ['login', 'status'], { timeout: DETECT_TIMEOUT });
  const text = `${r.stdout}\n${r.stderr}`;
  if (r.code === -1) out.error = String(r.stderr || 'spawn').trim().slice(0, 200);
  else if (/not logged in/i.test(text)) out.loggedIn = false;
  else if (/logged in/i.test(text)) {
    out.loggedIn = true;
    out.method = /chatgpt/i.test(text) ? 'chatgpt' : /api key/i.test(text) ? 'apiKey' : null;
  }
  return out;
}

// Estado de los dos CLIs. Con refresh (o pasado el TTL) vuelve a preguntar; si no, lo ultimo que se supo.
function detect({ refresh = false } = {}) {
  const fresh = D.value && Date.now() - D.at < DETECT_TTL;
  if (fresh && !refresh) return Promise.resolve(D.value);
  if (D.inflight) return D.inflight;
  D.inflight = (async () => {
    const [claude, chatgpt] = await Promise.all([detectClaude().catch((err) => empty(err?.message || String(err))), detectCodex().catch((err) => empty(err?.message || String(err)))]);
    const value = { at: Date.now(), claude, chatgpt };
    D.value = value;
    D.at = value.at;
    D.inflight = null;
    return value;
  })();
  return D.inflight;
}

function cached() {
  return D.value;
}

function stale() {
  return !D.value || Date.now() - D.at >= DETECT_TTL;
}

// Se puede usar: instalado y con sesion (null = no se pudo saber: se intenta igual y el CLI lo dira).
function usable(det, engine) {
  const e = det?.[engine];
  return Boolean(e?.installed) && e.loggedIn !== false;
}

// ---------- Entorno y salida de cada CLI (puros) ----------
// Entorno de los procesos hijos: el del launcher sin las marcas de Electron y sin el trafico accesorio de Claude Code
// (telemetria, actualizaciones). No se toca nada de la autenticacion del usuario.
function childEnv(base = process.env, engine = 'claude') {
  const env = { ...base };
  for (const k of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT']) delete env[k];
  if (engine === 'claude') env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  return env;
}

function blockText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => (c && typeof c === 'object' && typeof c.text === 'string' ? c.text : ''))
    .filter(Boolean)
    .join('\n');
}

// Una linea de `claude -p --output-format stream-json` -> lista de eventos { type: 'text' | 'result' | 'error' }.
function parseClaudeLine(msg) {
  const out = [];
  if (!isObject(msg)) return out;
  const type = msg.type || (msg.total_cost_usd !== undefined || ('is_error' in msg && 'subtype' in msg) ? 'result' : null);
  if (type === 'assistant') {
    if (msg.parent_tool_use_id) return out;
    const m = isObject(msg.message) ? msg.message : {};
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (isObject(b) && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) out.push({ type: 'text', text: b.text });
    }
  } else if (type === 'result') {
    out.push({
      type: 'result',
      subtype: typeof msg.subtype === 'string' ? msg.subtype : 'success',
      isError: msg.is_error === true,
      text: typeof msg.result === 'string' ? msg.result : '',
      errors: Array.isArray(msg.errors) ? msg.errors.map(String) : [],
    });
  }
  return out;
}

// Una linea de `codex exec --json` -> lista de eventos { type: 'text' | 'result' | 'error' }.
function parseCodexLine(msg) {
  const out = [];
  if (!isObject(msg)) return out;
  const item = isObject(msg.item) ? msg.item : null;
  switch (msg.type) {
    case 'item.completed':
      if (!item) break;
      if (item.type === 'agent_message' && typeof item.text === 'string' && item.text.trim()) out.push({ type: 'text', text: item.text });
      else if (item.type === 'error' && typeof item.message === 'string') out.push({ type: 'error', message: item.message });
      break;
    case 'turn.completed':
      out.push({ type: 'result', subtype: 'success', isError: false, text: '', errors: [] });
      break;
    case 'turn.failed':
      out.push({ type: 'result', subtype: 'error', isError: true, text: String(msg.error?.message || msg.message || 'turn failed'), errors: [] });
      break;
    case 'error':
      out.push({ type: 'error', message: String(msg.message || msg.error?.message || 'error') });
      break;
    default:
      break;
  }
  return out;
}

// Motivo de una falla del CLI -> codigo para la interfaz: 'engineLogin' (sin sesion), 'engineLimit' (limite del
// plan de Claude o ChatGPT), 'engine' (otro).
function classifyFailure(text) {
  const s = String(text || '');
  if (/not logged in|please run \/login|\/login|login required|invalid api key|authentication_error|oauth token|token has expired|expired.*credentials|credentials.*expired|unauthorized|401/i.test(s)) return 'engineLogin';
  if (/rate.?limit|usage limit|limit reached|out of (extra )?usage|too many requests|quota|\b429\b|overloaded/i.test(s)) return 'engineLimit';
  return 'engine';
}

module.exports = {
  EXTERNAL,
  APP_NAME,
  findClaudeCli,
  findCodexCli,
  spawnCli,
  runCli,
  writePrivate,
  ensurePrivateDir,
  detect,
  cached,
  stale,
  usable,
  childEnv,
  parseClaudeLine,
  parseCodexLine,
  classifyFailure,
  _detectState: D,
};
