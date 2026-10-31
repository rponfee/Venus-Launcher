'use strict';
// Motores externos del asistente: la pregunta la responde la app de IA del propio usuario, instalada en su PC y con
// su sesion iniciada, en vez del backend de Venus. Gasta los limites de SU plan de Claude o de ChatGPT:
//   'claude'  -> el CLI de Claude Code (`claude -p`), con la cuenta de Claude del usuario (Pro, Max, Team...)
//   'chatgpt' -> el CLI de Codex (`codex exec`), con la cuenta de ChatGPT del usuario (Plus, Pro, Business...)
// Venus lanza el ejecutable tal cual lo instalo el usuario (no lo modifica, no toca ni guarda sus credenciales: la
// sesion se inicia en la propia app, `claude auth login` o `codex login`) y le conecta el servidor MCP local del
// launcher (modules/mcp) como UNICA herramienta: el modelo usa las mismas herramientas y protecciones del asistente
// (plan, confirmaciones en la ventana de Venus, Deshacer, Actividad MCP). Las herramientas propias del CLI quedan
// apagadas (no lee archivos ni ejecuta comandos). Solo con plan Go o superior: lo controla agent.js con mcp.planState.
// La interfaz muestra los limites del plan de Claude (ventana de 5 h y semanal) que el CLI informa en cada respuesta.
//
// Uso desde agent.js:
//   engines.detect({ refresh })  -> { at, claude: { installed, cli, loggedIn, method, plan, error }, chatgpt: {...} }
//   engines.runTurn({ engine, prompt, system, mcpUrl, model, effort, sessionId, maxTurns, signal, onEvent })
//     -> { outcome: 'end_turn' | 'rounds' | 'error' | 'cancelled', code, error, sessionId, model, usage }
//     onEvent recibe { type: 'session' | 'text' | 'tool-start' | 'tool-result' | 'limits' | 'mcp-failed' | 'model' }
// Funciones puras (se prueban sin red ni CLI): claudeArgs, codexArgs, parseClaudeLine, parseCodexLine,
// toolShortName, classifyFailure, childEnv.
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const paths = require('../../core/paths');
const installers = require('../mcp/installers');
const files = require('../mcp/files');

const ENGINES = Object.freeze(['venus', 'claude', 'chatgpt']);
const EXTERNAL = Object.freeze(['claude', 'chatgpt']);
const SERVER = installers.SERVER_NAME; // 'venus-launcher'
const TOOL_PREFIX = `mcp__${SERVER}__`;
const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh']);
// Modelos que se pueden elegir por motor. 'default' = el que tenga configurado la app del usuario.
const MODELS = Object.freeze({
  claude: Object.freeze([
    { id: 'default', label: null },
    { id: 'fable', label: 'Claude Fable' },
    { id: 'opus', label: 'Claude Opus' },
    { id: 'sonnet', label: 'Claude Sonnet' },
    { id: 'haiku', label: 'Claude Haiku' },
  ]),
  chatgpt: Object.freeze([{ id: 'default', label: null }]),
});
const APP_NAME = Object.freeze({ claude: 'Claude Code', chatgpt: 'Codex' });
const PROVIDER_NAME = Object.freeze({ claude: 'Anthropic', chatgpt: 'OpenAI' });
const DETECT_TTL = 60000;
const DETECT_TIMEOUT = 20000;
const TURN_TIMEOUT_MS = 20 * 60000;
const MAX_LINE = 4 * 1024 * 1024;
const STDERR_KEEP = 4000;

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// ---------- Deteccion (cada 60 s como mucho; se inyecta para las pruebas) ----------
const D = {
  at: 0,
  value: null,
  inflight: null,
  onChange: () => {},
  runCli: (cli, args, o) => installers.runCli(cli, args, o),
  findClaude: () => installers.findClaudeCli(),
  findCodex: () => installers.findCodexCli(),
  env: process.env,
};

function configure(o = {}) {
  for (const k of ['runCli', 'findClaude', 'findCodex', 'onChange', 'env']) if (o[k] !== undefined) D[k] = o[k];
}

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
    const changed = JSON.stringify({ ...value, at: 0 }) !== JSON.stringify({ ...(D.value || {}), at: 0 });
    D.value = value;
    D.at = value.at;
    D.inflight = null;
    if (changed) {
      try {
        D.onChange(value);
      } catch (err) {
        console.warn('[assistant] engines.onChange:', err?.message || err);
      }
    }
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

// ---------- Eleccion de modelo y esfuerzo ----------
function normalizeModel(engine, m) {
  const list = MODELS[engine] || [];
  const s = typeof m === 'string' ? m.trim().toLowerCase() : '';
  return list.some((x) => x.id === s) ? s : 'default';
}

function normalizeEffort(e) {
  const s = typeof e === 'string' ? e.trim().toLowerCase() : '';
  return EFFORTS.includes(s) ? s : 'medium';
}

// ---------- Carpeta de trabajo y archivos ----------
// Cada motor corre en una carpeta vacia propia (sin CLAUDE.md ni AGENTS.md ajenos; las sesiones del CLI quedan
// asociadas a ella, lo que permite continuar la conversacion).
function workDir(engine) {
  return path.join(paths.data('assistant'), 'engines', engine);
}

const SYSTEM_FILE = '.venus-system-prompt.md';
const MCP_FILE = '.venus-mcp.json';
const AGENTS_FILE = 'AGENTS.md';

async function prepareFiles(engine, cwd, { system, mcpUrl }) {
  await files.ensurePrivateDir(cwd);
  const out = { cwd };
  if (engine === 'claude') {
    out.sysFile = path.join(cwd, SYSTEM_FILE);
    out.mcpFile = path.join(cwd, MCP_FILE);
    await files.writePrivate(out.sysFile, String(system || ''));
    await files.writePrivate(out.mcpFile, JSON.stringify({ mcpServers: { [SERVER]: { type: 'http', url: mcpUrl } } }, null, 2));
  } else {
    // Codex lee AGENTS.md de la carpeta de trabajo como instrucciones del proyecto
    out.agentsFile = path.join(cwd, AGENTS_FILE);
    await files.writePrivate(out.agentsFile, String(system || ''));
  }
  return out;
}

// ---------- Argumentos de cada CLI (puros) ----------
// Claude Code en modo no interactivo: sin herramientas propias (--tools ""), sin ajustes ni CLAUDE.md del usuario
// (--setting-sources ""), solo nuestro servidor MCP (--strict-mcp-config) con sus herramientas permitidas sin
// preguntar (las confirmaciones las hace Venus), prompt de sistema propio, salida JSON por linea y la sesion
// elegida por Venus (--session-id la primera vez, --resume despues).
function claudeArgs({ sysFile, mcpFile, model = 'default', effort = 'medium', sessionId = null, newSessionId = null, maxTurns = 24 }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', mcpFile, '--allowedTools', `mcp__${SERVER}`, '--permission-prompts', 'none', '--permission-mode', 'default', '--system-prompt-file', sysFile, '--max-turns', String(maxTurns)];
  if (model && model !== 'default') args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (sessionId) args.push('--resume', sessionId);
  else if (newSessionId) args.push('--session-id', newSessionId);
  return args;
}

// Codex no interactivo: eventos JSON por linea, fuera de un repositorio git, sin la configuracion del usuario (la
// sesion de ChatGPT se usa igual), caja de arena de solo lectura y sin herramientas de shell; solo nuestro servidor
// MCP por -c (no se toca ~/.codex/config.toml). El prompt va por stdin ("-"). Para continuar: `exec resume <id>`.
function codexArgs({ mcpUrl, effort = 'medium', sessionId = null, model = 'default' }) {
  const common = ['--json', '--skip-git-repo-check', '--ignore-user-config', '--sandbox', 'read-only', '--disable', 'shell_tool', '--disable', 'unified_exec', '-c', `mcp_servers.${SERVER}.url=${mcpUrl}`, '-c', `model_reasoning_effort=${effort || 'medium'}`];
  if (model && model !== 'default') common.push('-m', model);
  return sessionId ? ['exec', ...common, 'resume', sessionId, '-'] : ['exec', ...common, '-'];
}

// Entorno de los procesos hijos: el del launcher sin las marcas de Electron, con tiempos de MCP largos (una
// confirmacion en la ventana de Venus puede tardar) y sin trafico accesorio de Claude Code (telemetria,
// actualizaciones). No se toca nada de la autenticacion del usuario.
function childEnv(base = process.env, engine = 'claude') {
  const env = { ...base };
  for (const k of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT']) delete env[k];
  if (engine === 'claude') {
    env.MCP_TOOL_TIMEOUT = env.MCP_TOOL_TIMEOUT || '600000';
    env.MCP_TIMEOUT = env.MCP_TIMEOUT || '30000';
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  }
  return env;
}

// ---------- Salida de cada CLI -> eventos (puros) ----------
function toolShortName(name) {
  const s = String(name || '');
  return s.startsWith(TOOL_PREFIX) ? s.slice(TOOL_PREFIX.length) : s;
}

function blockText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => (c && typeof c === 'object' && typeof c.text === 'string' ? c.text : ''))
    .filter(Boolean)
    .join('\n');
}

const pct = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v * 100))) : null);
const seconds = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v * 1000 : null);

// Una linea de `claude -p --output-format stream-json` -> lista de eventos normalizados.
function parseClaudeLine(msg) {
  const out = [];
  if (!isObject(msg)) return out;
  const type = msg.type || (msg.total_cost_usd !== undefined || ('is_error' in msg && 'subtype' in msg) ? 'result' : null);
  switch (type) {
    case 'system': {
      if (msg.subtype !== 'init') break;
      out.push({ type: 'session', id: typeof msg.session_id === 'string' ? msg.session_id : null, model: typeof msg.model === 'string' ? msg.model : null });
      const servers = Array.isArray(msg.mcp_servers) ? msg.mcp_servers : [];
      const srv = servers.find((s) => s && s.name === SERVER);
      if (!srv || (srv.status && srv.status !== 'connected' && srv.status !== 'pending')) out.push({ type: 'mcp-failed', status: srv ? String(srv.status) : 'missing' });
      break;
    }
    case 'assistant': {
      if (msg.parent_tool_use_id) break;
      const m = isObject(msg.message) ? msg.message : {};
      if (typeof m.model === 'string' && m.model) out.push({ type: 'model', model: m.model });
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (!isObject(b)) continue;
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) out.push({ type: 'text', text: b.text });
        else if (b.type === 'tool_use') out.push({ type: 'tool-start', toolUseId: String(b.id || ''), name: String(b.name || ''), input: isObject(b.input) ? b.input : {} });
      }
      break;
    }
    case 'user': {
      if (msg.parent_tool_use_id) break;
      const content = msg.message?.content;
      if (!Array.isArray(content)) break;
      for (const b of content) {
        if (!isObject(b) || b.type !== 'tool_result') continue;
        out.push({ type: 'tool-result', toolUseId: String(b.tool_use_id || ''), text: blockText(b.content), isError: b.is_error === true });
      }
      break;
    }
    case 'rate_limit_event': {
      const info = isObject(msg.rate_limit_info) ? msg.rate_limit_info : {};
      const w = isObject(info.unifiedWindows) ? info.unifiedWindows : {};
      out.push({
        type: 'limits',
        fiveHour: pct(w.five_hour?.utilization),
        sevenDay: pct(w.seven_day?.utilization),
        fiveHourResetsAt: seconds(w.five_hour?.resetsAt),
        sevenDayResetsAt: seconds(w.seven_day?.resetsAt),
        status: typeof info.status === 'string' ? info.status : null,
      });
      break;
    }
    case 'result': {
      out.push({
        type: 'result',
        subtype: typeof msg.subtype === 'string' ? msg.subtype : 'success',
        isError: msg.is_error === true,
        text: typeof msg.result === 'string' ? msg.result : '',
        errors: Array.isArray(msg.errors) ? msg.errors.map(String) : [],
        sessionId: typeof msg.session_id === 'string' ? msg.session_id : null,
        usage: isObject(msg.usage) ? msg.usage : null,
        costUsd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : null,
        turns: Number.isInteger(msg.num_turns) ? msg.num_turns : null,
        stopReason: typeof msg.stop_reason === 'string' ? msg.stop_reason : null,
      });
      break;
    }
    default:
      break;
  }
  return out;
}

function codexResultText(result) {
  if (typeof result === 'string') return result;
  if (!isObject(result)) return '';
  if (Array.isArray(result.content)) return blockText(result.content);
  if (result.structured_content !== undefined) {
    try {
      return JSON.stringify(result.structured_content);
    } catch {
      return '';
    }
  }
  return '';
}

// Una linea de `codex exec --json` -> lista de eventos normalizados.
function parseCodexLine(msg) {
  const out = [];
  if (!isObject(msg)) return out;
  const item = isObject(msg.item) ? msg.item : null;
  switch (msg.type) {
    case 'thread.started':
      out.push({ type: 'session', id: typeof msg.thread_id === 'string' ? msg.thread_id : null, model: null });
      break;
    case 'item.started':
      if (item && item.type === 'mcp_tool_call') out.push({ type: 'tool-start', toolUseId: String(item.id || ''), name: `mcp__${item.server || ''}__${item.tool || ''}`, input: isObject(item.arguments) ? item.arguments : {} });
      break;
    case 'item.completed': {
      if (!item) break;
      if (item.type === 'agent_message' && typeof item.text === 'string' && item.text.trim()) out.push({ type: 'text', text: item.text });
      else if (item.type === 'mcp_tool_call') {
        const failed = item.status === 'failed' || isObject(item.error);
        const text = codexResultText(item.result) || (isObject(item.error) ? JSON.stringify({ ok: false, error: item.error.message || 'error' }) : '');
        out.push({ type: 'tool-result', toolUseId: String(item.id || ''), text, isError: failed, name: `mcp__${item.server || ''}__${item.tool || ''}` });
      } else if (item.type === 'error' && typeof item.message === 'string') out.push({ type: 'error', message: item.message });
      break;
    }
    case 'turn.completed':
      out.push({ type: 'result', subtype: 'success', isError: false, text: '', errors: [], sessionId: null, usage: isObject(msg.usage) ? msg.usage : null, costUsd: null, turns: null, stopReason: 'end_turn' });
      break;
    case 'turn.failed':
      out.push({ type: 'result', subtype: 'error', isError: true, text: String(msg.error?.message || msg.message || 'turn failed'), errors: [], sessionId: null, usage: null, costUsd: null, turns: null, stopReason: null });
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
// plan de Claude o ChatGPT), 'engineMissing' (no se pudo lanzar), 'engine' (otro).
function classifyFailure(text, { spawnError = false } = {}) {
  const s = String(text || '');
  if (spawnError) return 'engineMissing';
  if (/not logged in|please run \/login|\/login|login required|invalid api key|authentication_error|oauth token|token has expired|expired.*credentials|credentials.*expired|unauthorized|\b401\b/i.test(s)) return 'engineLogin';
  if (/rate.?limit|usage limit|limit reached|out of (extra )?usage|too many requests|quota|\b429\b|overloaded/i.test(s)) return 'engineLimit';
  return 'engine';
}

// ---------- Ejecucion ----------
function tail(s, n) {
  const str = String(s || '');
  return str.length > n ? str.slice(str.length - n) : str;
}

function runProcess({ cli, args, cwd, stdin, env, signal, timeoutMs, onLine, onStderr }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = installers.spawnCli(cli, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: -1, spawnError: err?.message || String(err), timedOut: false, aborted: false });
      return;
    }
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let spawnError = null;
    let timer = null;
    const kill = () => {
      try {
        child.kill();
      } catch {
        /* ya termino */
      }
    };
    const onAbort = () => {
      aborted = true;
      kill();
    };
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, spawnError, timedOut, aborted });
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    timer.unref?.();

    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > MAX_LINE) buf = buf.slice(-MAX_LINE);
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line.trim()) onLine(line);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => onStderr(chunk));
    child.on('error', (err) => {
      spawnError = err?.message || String(err);
      finish(-1);
    });
    child.on('close', (code) => {
      if (buf.trim()) onLine(buf.replace(/\r$/, ''));
      finish(typeof code === 'number' ? code : -1);
    });
    try {
      child.stdin.on('error', () => {});
      child.stdin.end(String(stdin || ''));
    } catch {
      /* el proceso ya cerro la entrada */
    }
  });
}

// Un turno completo con un motor externo (ver cabecera). Nunca lanza: devuelve outcome 'error' con code y error.
async function runTurn(spec) {
  const engine = spec.engine;
  const none = { sessionId: spec.sessionId || null, model: null, usage: null, mcpFailed: null };
  if (!EXTERNAL.includes(engine)) return { ...none, outcome: 'error', code: 'engine', error: `Unknown engine: ${engine}` };
  const onEvent = typeof spec.onEvent === 'function' ? spec.onEvent : () => {};
  const cli = spec.cli || (await detect({}))[engine]?.cli;
  if (!cli) return { ...none, outcome: 'error', code: 'engineMissing', error: `${APP_NAME[engine]} not found` };
  const cwd = spec.cwd || workDir(engine);
  const prepared = await prepareFiles(engine, cwd, spec);
  const model = normalizeModel(engine, spec.model);
  const effort = normalizeEffort(spec.effort);
  const newSessionId = engine === 'claude' && !spec.sessionId ? crypto.randomUUID() : null;
  const args = engine === 'claude' ? claudeArgs({ sysFile: prepared.sysFile, mcpFile: prepared.mcpFile, model, effort, sessionId: spec.sessionId || null, newSessionId, maxTurns: spec.maxTurns || 24 }) : codexArgs({ mcpUrl: spec.mcpUrl, effort, sessionId: spec.sessionId || null, model });
  const parse = engine === 'claude' ? parseClaudeLine : parseCodexLine;

  const st = { sessionId: spec.sessionId || newSessionId, model: null, usage: null, result: null, errors: [], stderr: '', texts: 0, badLines: 0, mcpFailed: null };
  const r = await runProcess({
    cli,
    args,
    cwd,
    stdin: String(spec.prompt || ''),
    env: childEnv(spec.env || D.env, engine),
    signal: spec.signal,
    timeoutMs: spec.timeoutMs || TURN_TIMEOUT_MS,
    onStderr: (chunk) => {
      st.stderr = tail(st.stderr + chunk, STDERR_KEEP);
    },
    onLine: (line) => {
      let msg = null;
      try {
        msg = JSON.parse(line);
      } catch {
        st.badLines++;
        st.stderr = tail(`${st.stderr}\n${line}`, STDERR_KEEP);
        return;
      }
      for (const ev of parse(msg)) {
        if (ev.type === 'session') {
          if (ev.id) st.sessionId = ev.id;
          if (ev.model) st.model = ev.model;
        } else if (ev.type === 'model') st.model = ev.model;
        else if (ev.type === 'result') {
          st.result = ev;
          if (ev.sessionId) st.sessionId = ev.sessionId;
          if (ev.usage) st.usage = ev.usage;
        } else if (ev.type === 'error') st.errors.push(ev.message);
        else if (ev.type === 'mcp-failed') st.mcpFailed = ev.status;
        if (ev.type === 'text') st.texts++;
        try {
          onEvent(ev);
        } catch (err) {
          console.warn('[assistant] engines.onEvent:', err?.message || err);
        }
      }
    },
  });

  // Limpieza de los archivos del turno (el prompt de sistema y la URL con el secreto no quedan en disco)
  for (const f of [prepared.sysFile, prepared.mcpFile]) if (f) await fsp.rm(f, { force: true }).catch(() => {});

  const base = { sessionId: st.sessionId, model: st.model, usage: st.usage, mcpFailed: st.mcpFailed };
  if (r.aborted) return { ...base, outcome: 'cancelled', code: null, error: null };
  if (r.timedOut) return { ...base, outcome: 'error', code: 'engineTimeout', error: `${APP_NAME[engine]} did not finish in time` };
  if (r.spawnError) return { ...base, outcome: 'error', code: 'engineMissing', error: r.spawnError };
  const res = st.result;
  if (res && !res.isError && res.subtype === 'success') return { ...base, outcome: 'end_turn', code: null, error: null, text: res.text };
  if (res && res.subtype === 'error_max_turns') return { ...base, outcome: 'rounds', code: 'rounds', error: null };
  const detail = [res?.text, ...(res?.errors || []), ...st.errors].filter((x) => typeof x === 'string' && x.trim()).join(' · ') || st.stderr.trim();
  if (res && res.isError && res.subtype === 'success' && st.texts && !detail) return { ...base, outcome: 'end_turn', code: null, error: null };
  return { ...base, outcome: 'error', code: classifyFailure(detail || `exit ${r.code}`), error: (detail || `${APP_NAME[engine]} exited with code ${r.code}`).slice(0, 600) };
}

module.exports = {
  ENGINES,
  EXTERNAL,
  MODELS,
  EFFORTS,
  APP_NAME,
  PROVIDER_NAME,
  TOOL_PREFIX,
  configure,
  detect,
  cached,
  stale,
  usable,
  normalizeModel,
  normalizeEffort,
  workDir,
  claudeArgs,
  codexArgs,
  childEnv,
  parseClaudeLine,
  parseCodexLine,
  toolShortName,
  classifyFailure,
  runTurn,
  _detectState: D,
};
