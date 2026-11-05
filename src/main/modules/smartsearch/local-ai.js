'use strict';
// IA local del Buscador inteligente: el Claude Code o el Codex que la persona ya tiene instalado y con sesion en SU PC
// responden el plan de busqueda. Es la alternativa a Venus IA (nunca las dos a la vez; ver ai-source.js): no gasta la
// cuota de Venus IA, gasta los limites del plan propio de Claude o ChatGPT.
//
// Mismas garantias que los motores del Asistente (assistant/engines.js): se lanza el ejecutable tal cual lo instalo la
// persona, sin tocar sus credenciales, y SIN herramientas (ni de archivos ni de shell ni MCP): solo texto de entrada y
// una respuesta JSON. Lo unico que sale es lo que escribio para buscar (ver el aviso de privacidad de la interfaz).
//
//   json({ system, prompt, schema, engine, signal, timeoutMs }) -> objeto JSON de la respuesta (lanza con err.code)
//   Misma forma que ai.json(): ai-plan.js usa cualquiera de las dos.
const path = require('path');
const engines = require('../assistant/engines');
const installers = require('../mcp/installers');
const files = require('../mcp/files');
const paths = require('../../core/paths');

const MAX_OUTPUT = 400 * 1024;
const SYSTEM_FILE = '.venus-search-system.md';

const coded = (code, message) => Object.assign(new Error(message || code), { code });

// Argumentos de cada CLI: sin herramientas, sin ajustes del usuario, sin servidores MCP, un solo turno.
function claudeArgs({ sysFile, model = 'haiku' }) {
  return ['-p', '--output-format', 'stream-json', '--verbose', '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--permission-mode', 'default', '--system-prompt-file', sysFile, '--max-turns', '1', '--model', model, '--effort', 'low'];
}
function codexArgs() {
  return ['exec', '--json', '--skip-git-repo-check', '--ignore-user-config', '--sandbox', 'read-only', '--disable', 'shell_tool', '--disable', 'unified_exec', '-c', 'model_reasoning_effort=low', '-'];
}

// El esquema va dentro del prompt: los CLIs no lo validan, ai-plan.js ya valida y limpia lo que vuelve.
function withSchema(prompt, schema) {
  return `${prompt}\n\nReply with ONLY one JSON object (no markdown fences, no commentary) that follows this JSON Schema:\n${JSON.stringify(schema)}`;
}

// Primer objeto JSON de un texto que puede traer cercos de codigo o frases alrededor.
function parseObject(text) {
  const s = String(text || '').replace(/```(?:json)?/gi, '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    const value = JSON.parse(s.slice(a, b + 1));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function run({ cli, args, cwd, stdin, env, signal, timeoutMs, parse }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = installers.spawnCli(cli, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: -1, spawnError: err?.message || String(err), texts: [], result: '', stderr: '' });
      return;
    }
    const texts = [];
    let result = '';
    let stderr = '';
    let buf = '';
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let spawnError = null;
    const kill = () => {
      try {
        child.kill();
      } catch {
        /* ya termino */
      }
    };
    const done = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, spawnError, timedOut, aborted, texts, result, stderr });
    };
    const onAbort = () => {
      aborted = true;
      kill();
    };
    const line = (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      for (const ev of parse(msg)) {
        if (ev.type === 'text') texts.push(ev.text);
        else if (ev.type === 'result' && ev.text) result = ev.text;
        else if (ev.type === 'error') stderr += `${ev.message}\n`;
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    timer.unref?.();
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > MAX_OUTPUT) buf = buf.slice(-MAX_OUTPUT);
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (raw.trim()) line(raw);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.on('error', (err) => {
      spawnError = err?.message || String(err);
      done(-1);
    });
    child.on('close', (code) => {
      if (buf.trim()) line(buf.replace(/\r$/, ''));
      done(typeof code === 'number' ? code : -1);
    });
    try {
      child.stdin.on('error', () => {});
      child.stdin.end(String(stdin || ''));
    } catch {
      /* el proceso ya cerro la entrada */
    }
  });
}

async function json({ system = '', prompt = '', schema, engine, signal, timeoutMs = 60000, cli = null, prefixArgs = [], cwd = null } = {}) {
  if (!engines.EXTERNAL.includes(engine)) throw coded('engine', 'Unknown local engine');
  const path_ = cli || (engines.cached() || (await engines.detect({})))?.[engine]?.cli;
  if (!path_) throw coded('engineMissing', `${engines.APP_NAME[engine]} not found`);
  const dir = cwd || path.join(paths.data('smartsearch'), 'engine', engine);
  await files.ensurePrivateDir(dir);
  const text = withSchema(prompt, schema || { type: 'object' });
  let args;
  let stdin;
  let parse;
  if (engine === 'claude') {
    const sysFile = path.join(dir, SYSTEM_FILE);
    await files.writePrivate(sysFile, String(system || ''));
    args = claudeArgs({ sysFile });
    stdin = text;
    parse = engines.parseClaudeLine;
  } else {
    args = codexArgs();
    stdin = `${system}\n\n${text}`;
    parse = engines.parseCodexLine;
  }
  const out = await run({ cli: path_, args: [...prefixArgs, ...args], cwd: dir, stdin, env: engines.childEnv(process.env, engine), signal, timeoutMs, parse });
  if (out.aborted) throw coded('cancelled', 'cancelled');
  if (out.timedOut) throw coded('engineTimeout', 'timeout');
  const failure = `${out.stderr}\n${out.result}`;
  const reply = out.result || out.texts.join('\n');
  if (out.spawnError && !reply) throw coded('engineMissing', out.spawnError);
  const value = parseObject(reply);
  if (!value) throw coded(out.code && out.code !== 0 ? engines.classifyFailure(failure) : 'parse', (failure.trim() || 'no JSON in the response').slice(0, 300));
  return value;
}

module.exports = { json, claudeArgs, codexArgs, withSchema, parseObject };
