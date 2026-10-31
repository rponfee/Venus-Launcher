'use strict';
// Registro de Venus Launcher en los clientes MCP de esta PC (boton "Conectar" del panel):
//   - Claude Desktop: claude_desktop_config.json -> mcpServers['venus-launcher'] en Windows (%APPDATA%\Claude y,
//     si existe, la carpeta de la version de la Microsoft Store), macOS (~/Library/Application Support/Claude)
//     y Linux (~/.config/Claude).
//   - Claude Code: `claude mcp add --scope user` si el comando existe; si no (o si falla), el archivo de usuario
//     ~/.claude.json (o $CLAUDE_CONFIG_DIR/.claude.json) -> mcpServers['venus-launcher'].
// Antes de escribir un archivo se guarda una copia "<archivo>.venus-backup" (el estado justo antes de tocarlo).
// Es idempotente (si la entrada ya es igual no se escribe nada), un archivo que no es JSON valido no se toca
// y "Desconectar" borra solo nuestra entrada. La entrada lanza el puente stdio con el propio ejecutable del
// launcher: { command: <exe>, args: [<datos>/mcp/venus-mcp-bridge.js], env: { ELECTRON_RUN_AS_NODE: '1' } }.
// Sin Electron: rutas, comando y ejecucion del CLI llegan por parametro (las pruebas usan carpetas temporales).
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SERVER_NAME = 'venus-launcher';
const BACKUP_SUFFIX = '.venus-backup';

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

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
    xdgConfig: o.xdgConfig || env.XDG_CONFIG_HOME || path.join(homedir, '.config'),
  };
}

const existsSync = (p) => {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
};

const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

// ---------- Entradas ----------
function desktopEntry(spec) {
  return { command: spec.command, args: [...spec.args], env: { ...(spec.env || {}) } };
}

function codeEntry(spec) {
  return { type: 'stdio', command: spec.command, args: [...spec.args], env: { ...(spec.env || {}) } };
}

function sameEntry(a, b) {
  if (!isObject(a) || !isObject(b)) return false;
  if (String(a.command || '') !== String(b.command || '')) return false;
  if (JSON.stringify(a.args || []) !== JSON.stringify(b.args || [])) return false;
  const ea = isObject(a.env) ? a.env : {};
  const eb = isObject(b.env) ? b.env : {};
  const keys = new Set([...Object.keys(ea), ...Object.keys(eb)]);
  for (const k of keys) if (String(ea[k] ?? '') !== String(eb[k] ?? '')) return false;
  if (b.type && a.type && a.type !== b.type) return false;
  return true;
}

// ---------- Archivos JSON ----------
async function readConfig(file) {
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { exists: false, data: {} };
    return { exists: true, error: 'read', detail: err.message };
  }
  raw = raw.replace(/^﻿/, '');
  if (!raw.trim()) return { exists: true, data: {} };
  try {
    const data = JSON.parse(raw);
    if (!isObject(data)) return { exists: true, error: 'shape' };
    if (data.mcpServers !== undefined && !isObject(data.mcpServers)) return { exists: true, error: 'shape' };
    return { exists: true, data };
  } catch {
    return { exists: true, error: 'json' };
  }
}

async function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (err) {
      if (i >= 6 || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err;
      await new Promise((r) => setTimeout(r, 120 * (i + 1)));
    }
  }
}

// Copia de seguridad + escritura atomica conservando los permisos del archivo original.
async function writeConfig(file, data, existed) {
  let mode;
  if (existed) {
    await fsp.copyFile(file, `${file}${BACKUP_SUFFIX}`);
    try {
      mode = (await fsp.stat(file)).mode & 0o777;
    } catch {
      mode = undefined;
    }
  }
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.venus-${process.pid}-${Date.now()}.tmp`;
  try {
    await fsp.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, mode ? { mode } : undefined);
    await renameRetry(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Agrega o actualiza mcpServers['venus-launcher']. status: 'added' | 'updated' | 'already' | 'error'. */
async function upsertServer(file, entry) {
  const r = await readConfig(file);
  if (r.error) return { status: 'error', file, error: r.error, detail: r.detail };
  const data = r.data;
  const servers = isObject(data.mcpServers) ? data.mcpServers : {};
  if (sameEntry(servers[SERVER_NAME], entry)) return { status: 'already', file };
  const had = Object.prototype.hasOwnProperty.call(servers, SERVER_NAME);
  data.mcpServers = { ...servers, [SERVER_NAME]: entry };
  try {
    await writeConfig(file, data, r.exists);
  } catch (err) {
    return { status: 'error', file, error: 'write', detail: err.message };
  }
  return { status: had ? 'updated' : 'added', file, backup: r.exists ? `${file}${BACKUP_SUFFIX}` : null };
}

/** Saca solo nuestra entrada. status: 'removed' | 'absent' | 'error'. */
async function removeServer(file) {
  const r = await readConfig(file);
  if (!r.exists) return { status: 'absent', file };
  if (r.error) return { status: 'error', file, error: r.error, detail: r.detail };
  const servers = r.data.mcpServers;
  if (!isObject(servers) || !Object.prototype.hasOwnProperty.call(servers, SERVER_NAME)) return { status: 'absent', file };
  const next = { ...servers };
  delete next[SERVER_NAME];
  r.data.mcpServers = next;
  try {
    await writeConfig(file, r.data, true);
  } catch (err) {
    return { status: 'error', file, error: 'write', detail: err.message };
  }
  return { status: 'removed', file, backup: `${file}${BACKUP_SUFFIX}` };
}

// Estado de nuestra entrada en un archivo: 'missing' | 'current' | 'outdated' | 'error'.
async function entryState(file, entry) {
  const r = await readConfig(file);
  if (r.error) return { state: 'error', error: r.error, exists: true };
  const cur = isObject(r.data.mcpServers) ? r.data.mcpServers[SERVER_NAME] : undefined;
  if (!cur) return { state: 'missing', exists: r.exists };
  return { state: sameEntry(cur, entry) ? 'current' : 'outdated', exists: r.exists };
}

// Un estado combinado de varios archivos (Claude Desktop puede tener dos).
function combine(results, kind) {
  const by = (s) => results.some((r) => r.status === s);
  if (kind === 'install') {
    if (results.length && results.every((r) => r.status === 'error')) return 'error';
    if (by('added')) return 'added';
    if (by('updated')) return 'updated';
    if (by('already')) return 'already';
    return results.length ? 'error' : 'notInstalled';
  }
  if (results.length && results.every((r) => r.status === 'error')) return 'error';
  if (by('removed')) return 'removed';
  return 'absent';
}

// ---------- Claude Desktop ----------
function claudeDesktopTargets(o = {}) {
  const e = envOf(o);
  if (e.platform === 'darwin') return [{ id: 'standard', file: path.join(e.homedir, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json') }];
  if (e.platform !== 'win32') return [{ id: 'standard', file: path.join(e.xdgConfig, 'Claude', 'claude_desktop_config.json') }];
  const out = [{ id: 'standard', file: path.join(e.appData, 'Claude', 'claude_desktop_config.json') }];
  // Version de la Microsoft Store: guarda la configuracion en una carpeta virtualizada del paquete.
  const packages = path.join(e.localAppData, 'Packages');
  let dirs = [];
  try {
    dirs = fs.readdirSync(packages).filter((d) => /^Claude_/i.test(d));
  } catch {
    dirs = [];
  }
  for (const d of dirs) out.push({ id: 'store', file: path.join(packages, d, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json') });
  return out;
}

function claudeDesktopApps(o = {}) {
  const e = envOf(o);
  if (e.platform === 'win32') return [path.join(e.localAppData, 'AnthropicClaude'), path.join(e.localAppData, 'Programs', 'Claude'), path.join(e.localAppData, 'Programs', 'claude-desktop')];
  if (e.platform === 'darwin') return ['/Applications/Claude.app', path.join(e.homedir, 'Applications', 'Claude.app')];
  return [];
}

function claudeDesktopInstalled(o = {}) {
  const targets = claudeDesktopTargets(o);
  return targets.some((x) => existsSync(path.dirname(x.file))) || claudeDesktopApps(o).some(existsSync);
}

async function claudeDesktopStatus(spec, o = {}) {
  const installed = claudeDesktopInstalled(o);
  const entry = desktopEntry(spec);
  const files = [];
  for (const x of claudeDesktopTargets(o)) {
    if (!existsSync(path.dirname(x.file))) continue;
    files.push({ file: x.file, store: x.id === 'store', ...(await entryState(x.file, entry)) });
  }
  const registered = files.some((f) => f.state === 'current' || f.state === 'outdated');
  return { installed, registered, outdated: files.some((f) => f.state === 'outdated'), error: files.find((f) => f.state === 'error')?.error || null, files, configPath: files[0]?.file || claudeDesktopTargets(o)[0].file };
}

async function installClaudeDesktop(spec, o = {}) {
  if (!claudeDesktopInstalled(o)) return { status: 'notInstalled', results: [] };
  const entry = desktopEntry(spec);
  const targets = claudeDesktopTargets(o);
  // Si la app esta pero nunca se abrio, se crea la carpeta de la configuracion estandar
  const usable = targets.filter((x) => existsSync(path.dirname(x.file)));
  if (!usable.length) usable.push(targets[0]);
  const results = [];
  for (const x of usable) results.push(await upsertServer(x.file, entry));
  return { status: combine(results, 'install'), results };
}

async function uninstallClaudeDesktop(o = {}) {
  const results = [];
  for (const x of claudeDesktopTargets(o)) if (existsSync(x.file)) results.push(await removeServer(x.file));
  return { status: combine(results, 'remove'), results };
}

// ---------- Claude Code ----------
function claudeCodeFile(o = {}) {
  const e = envOf(o);
  return e.env.CLAUDE_CONFIG_DIR ? path.join(e.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(e.homedir, '.claude.json');
}

// Busca el comando `claude` en el PATH y en las carpetas habituales (el PATH de una app abierta desde el
// escritorio puede no incluirlas).
function findClaudeCli(o = {}) {
  const e = envOf(o);
  const win = e.platform === 'win32';
  const names = win ? ['claude.exe', 'claude.cmd', 'claude.bat'] : ['claude'];
  const fromPath = String(e.env.PATH || e.env.Path || '')
    .split(win ? ';' : ':')
    .map((d) => d.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
  const extra = win
    ? [path.join(e.homedir, '.local', 'bin'), path.join(e.appData, 'npm'), path.join(e.localAppData, 'Microsoft', 'WinGet', 'Links'), path.join(e.homedir, '.claude', 'local'), path.join(e.localAppData, 'Programs', 'claude')]
    : [path.join(e.homedir, '.local', 'bin'), path.join(e.homedir, '.claude', 'local'), '/usr/local/bin', '/opt/homebrew/bin', path.join(e.homedir, '.npm-global', 'bin'), path.join(e.homedir, '.bun', 'bin')];
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

function claudeCodeInstalled(o = {}, cli = undefined) {
  const e = envOf(o);
  const c = cli === undefined ? findClaudeCli(o) : cli;
  return Boolean(c) || existsSync(claudeCodeFile(o)) || existsSync(path.join(e.homedir, '.claude'));
}

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

/** Ejecuta el CLI de Claude Code (o Codex) y junta su salida (los .cmd van por cmd.exe con argumentos verificados). */
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

async function claudeCodeStatus(spec, o = {}) {
  const cli = o.cli !== undefined ? o.cli : findClaudeCli(o);
  const file = claudeCodeFile(o);
  const st = await entryState(file, codeEntry(spec));
  return { installed: claudeCodeInstalled(o, cli), cli: cli || null, registered: st.state === 'current' || st.state === 'outdated', outdated: st.state === 'outdated', error: st.state === 'error' ? st.error : null, configPath: file };
}

/**
 * Con el CLI: `claude mcp remove` (por si habia una entrada vieja) + `claude mcp add --scope user`.
 * Sin CLI (o si falla): edita el archivo de usuario. Devuelve { status, method: 'cli' | 'file', ... }.
 */
async function installClaudeCode(spec, o = {}) {
  const cli = o.cli !== undefined ? o.cli : findClaudeCli(o);
  const run = o.runCli || runCli;
  const file = claudeCodeFile(o);
  const entry = codeEntry(spec);
  const before = await entryState(file, entry);
  if (before.state === 'current') return { status: 'already', method: cli ? 'cli' : 'file', file };
  if (!claudeCodeInstalled(o, cli)) return { status: 'notInstalled' };
  let cliError = null;
  if (cli) {
    const envArgs = Object.entries(spec.env || {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    await run(cli, ['mcp', 'remove', SERVER_NAME, '-s', 'user'], { platform: o.platform }).catch(() => null);
    const r = await run(cli, ['mcp', 'add', SERVER_NAME, '-s', 'user', ...envArgs, '--', spec.command, ...spec.args], { platform: o.platform });
    if (r && r.code === 0) return { status: before.state === 'missing' ? 'added' : 'updated', method: 'cli', cli, file };
    cliError = String((r && (r.stderr || r.stdout)) || '').trim().slice(-400) || 'cli';
  }
  const up = await upsertServer(file, entry);
  return { ...up, method: 'file', cli: cli || null, cliError };
}

async function uninstallClaudeCode(o = {}) {
  const cli = o.cli !== undefined ? o.cli : findClaudeCli(o);
  const run = o.runCli || runCli;
  const file = claudeCodeFile(o);
  let viaCli = false;
  if (cli) {
    const r = await run(cli, ['mcp', 'remove', SERVER_NAME, '-s', 'user'], { platform: o.platform }).catch(() => null);
    viaCli = Boolean(r && r.code === 0);
  }
  // Si quedo algo en el archivo (sin CLI, o el CLI fallo), se saca a mano
  const r = await removeServer(file);
  if (r.status === 'removed') return { ...r, method: 'file' };
  if (viaCli) return { status: 'removed', method: 'cli', file };
  return { ...r, method: 'file' };
}

// ---------- App de escritorio de ChatGPT (solo deteccion) ----------
// ChatGPT no tiene un archivo local de servidores MCP: se agregan desde chatgpt.com (Plugins > + > "Add custom
// MCP server") con la URL publica del tunel, asi que aca solo se detecta si la app esta instalada.
// Windows: paquete de la Microsoft Store (%LOCALAPPDATA%\Packages\OpenAI.ChatGPT*). macOS: ChatGPT.app en
// /Applications (o ~/Applications). La ruta del instalador clasico de Windows no esta documentada: no se adivina.
function chatgptDesktopApps(o = {}) {
  const e = envOf(o);
  if (e.platform === 'darwin') return [path.join(o.applications || '/Applications', 'ChatGPT.app'), path.join(e.homedir, 'Applications', 'ChatGPT.app')];
  if (e.platform !== 'win32') return [];
  const packages = path.join(e.localAppData, 'Packages');
  let dirs = [];
  try {
    dirs = fs.readdirSync(packages).filter((d) => /^OpenAI\.ChatGPT/i.test(d));
  } catch {
    dirs = [];
  }
  return dirs.map((d) => path.join(packages, d));
}

function chatgptDesktopStatus(o = {}) {
  const found = chatgptDesktopApps(o).find(existsSync) || null;
  return { installed: Boolean(found), path: found };
}

// ---------- Codex (el CLI de OpenAI, con la cuenta de ChatGPT) ----------
// Busca el comando `codex`: en el PATH, en las carpetas habituales de npm y en la instalacion de la app de
// escritorio de Codex (Windows: %LOCALAPPDATA%\OpenAI\Codex\bin\<version>\codex.exe, la mas nueva primero).
function findCodexCli(o = {}) {
  const e = envOf(o);
  const win = e.platform === 'win32';
  const names = win ? ['codex.exe', 'codex.cmd', 'codex.bat'] : ['codex'];
  const fromPath = String(e.env.PATH || e.env.Path || '')
    .split(win ? ';' : ':')
    .map((d) => d.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
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

// La app de escritorio de Codex (Microsoft Store: %LOCALAPPDATA%\Packages\OpenAI.Codex_*; macOS: Codex.app).
function codexDesktopInstalled(o = {}) {
  const e = envOf(o);
  if (e.platform === 'darwin') return [path.join(o.applications || '/Applications', 'Codex.app'), path.join(e.homedir, 'Applications', 'Codex.app')].some(existsSync);
  if (e.platform !== 'win32') return false;
  try {
    return fs.readdirSync(path.join(e.localAppData, 'Packages')).some((d) => /^OpenAI\.Codex/i.test(d));
  } catch {
    return false;
  }
}

module.exports = {
  SERVER_NAME,
  BACKUP_SUFFIX,
  desktopEntry,
  codeEntry,
  sameEntry,
  readConfig,
  upsertServer,
  removeServer,
  entryState,
  claudeDesktopTargets,
  claudeDesktopInstalled,
  claudeDesktopStatus,
  installClaudeDesktop,
  uninstallClaudeDesktop,
  claudeCodeFile,
  findClaudeCli,
  claudeCodeInstalled,
  claudeCodeStatus,
  installClaudeCode,
  uninstallClaudeCode,
  runCli,
  spawnCli,
  chatgptDesktopApps,
  chatgptDesktopStatus,
  findCodexCli,
  codexDesktopInstalled,
};
