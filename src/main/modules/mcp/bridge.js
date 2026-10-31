'use strict';
// Puente stdio <-> HTTP local de Venus Launcher para Claude Desktop y Claude Code.
// El launcher lo copia al iniciar a <datos>/mcp/venus-mcp-bridge.js (afuera del .asar) y los clientes lo
// lanzan con el propio ejecutable del launcher, sin Node instalado:
//   ELECTRON_RUN_AS_NODE=1 "<ruta>\Venus Launcher.exe" "<datos>\mcp\venus-mcp-bridge.js"
// Lee cada mensaje JSON-RPC de stdin (uno por linea), lo manda por POST al servidor MCP del launcher
// (http://127.0.0.1:<puerto>/mcp/<secreto>, datos en bridge.json, al lado de este archivo) y escribe las
// respuestas en stdout. Si el launcher esta cerrado (o el MCP apagado) contesta solo: initialize y la lista
// de herramientas (la ultima que guardo el launcher en tools.json) y, al usar una herramienta, "Abri Venus
// Launcher". Cuando cambia la lista (por ejemplo, el launcher se abre o cambia el plan) avisa con
// notifications/tools/list_changed a los clientes de la era con initialize.
// Sin dependencias: solo modulos de Node. No escribe en stdout nada que no sea un mensaje MCP.
const fs = require('fs');
const path = require('path');
const http = require('http');

const DIR = __dirname;
const INFO_FILE = path.join(DIR, 'bridge.json');
const TOOLS_FILE = path.join(DIR, 'tools.json');
const POLL_MS = 10000;
const DEFAULT_MODERN = ['2026-07-28'];
const DEFAULT_LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CLIENT = 'io.modelcontextprotocol/clientInfo';
const META_SERVER = 'io.modelcontextprotocol/serverInfo';

const TEXT = {
  es: {
    offline: 'Venus Launcher no está abierto. Abrí Venus Launcher en esta PC y volvé a intentar.',
    disabled: 'La conexión con Claude y ChatGPT está apagada en Venus Launcher. Activala en Ajustes → Inteligencia artificial → Claude y ChatGPT (MCP) y volvé a intentar.',
    unreachable: 'No se pudo conectar con Venus Launcher. Cerralo y volvé a abrirlo; si sigue igual, tocá "Conectar" otra vez en el panel de MCP.',
    instructions: 'Venus Launcher (launcher de Minecraft) no está abierto ahora: pedile al usuario que lo abra para usar sus herramientas.',
  },
  en: {
    offline: 'Venus Launcher is not open. Open Venus Launcher on this PC and try again.',
    disabled: 'The Claude and ChatGPT connection is turned off in Venus Launcher. Turn it on in Settings → Artificial intelligence → Claude and ChatGPT (MCP) and try again.',
    unreachable: 'Could not connect to Venus Launcher. Close it and open it again; if it keeps failing, press "Connect" again in the MCP panel.',
    instructions: 'Venus Launcher (a Minecraft launcher) is not open right now: ask the user to open it to use its tools.',
  },
};

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Datos del servidor del launcher: { state: 'online' | 'offline' | 'disabled' | 'unreachable', port, secret }.
function launcher() {
  const info = readJson(INFO_FILE);
  if (!isObject(info) || !alive(info.pid)) return { state: 'offline', info };
  if (info.enabled !== true) return { state: 'disabled', info };
  if (info.running !== true) return { state: 'unreachable', info };
  const port = Number(info.port);
  const secret = String(info.secret || '');
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[A-Za-z0-9_-]{16,200}$/.test(secret)) return { state: 'offline', info };
  return { state: 'online', port, secret, info };
}

function cache() {
  const c = readJson(TOOLS_FILE);
  return isObject(c) ? c : {};
}

function lang() {
  const c = cache();
  const l = String(c.lang || readJson(INFO_FILE)?.lang || 'es').slice(0, 2);
  return TEXT[l] ? l : 'en';
}

function message(key) {
  const c = cache();
  if (isObject(c.messages) && typeof c.messages[key] === 'string' && c.messages[key]) return c.messages[key];
  return TEXT[lang()][key];
}

// ---------- Salida ----------
let closed = false;
process.stdout.on('error', () => {
  closed = true;
  process.exit(0);
});
function write(msg) {
  if (closed) return;
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}
function warn(text) {
  try {
    process.stderr.write(`[venus-mcp] ${text}\n`);
  } catch {
    /* sin stderr */
  }
}

// ---------- Estado de la sesion (solo para la era con initialize) ----------
const session = { legacy: false, version: null, client: null, initialized: false, lastToolsSig: null };
const inflight = new Map(); // id -> AbortController

function toolsSig(list) {
  return Array.isArray(list) ? list.map((t) => (t && t.name) || '').join(',') : '';
}

function versionsOf(c = cache()) {
  const modern = Array.isArray(c.modernVersions) && c.modernVersions.length ? c.modernVersions : DEFAULT_MODERN;
  const legacy = Array.isArray(c.legacyVersions) && c.legacyVersions.length ? c.legacyVersions : DEFAULT_LEGACY;
  return { modern, legacy, all: [...modern, ...legacy] };
}

function serverInfo(c = cache()) {
  const s = isObject(c.serverInfo) ? c.serverInfo : {};
  return { name: s.name || 'venus-launcher', title: s.title || 'Venus Launcher', version: s.version || '0.0.0' };
}

// Respuesta local cuando el launcher no esta disponible. state: 'offline' | 'disabled' | 'unreachable'.
function localAnswer(msg, state) {
  const c = cache();
  const meta = isObject(msg.params) && isObject(msg.params._meta) ? msg.params._meta : null;
  const modernVersion = meta && typeof meta[META_VERSION] === 'string' ? meta[META_VERSION] : null;
  const v = versionsOf(c);
  const modern = Boolean(modernVersion) && !v.legacy.includes(modernVersion);
  // Pistas de cache obligatorias en la revision 2026-07-28 (server/discover y las listas); sin ellas Claude Code descarta
  // el resultado. Con el launcher cerrado la lista puede cambiar en cualquier momento: TTL corto y privado.
  const cacheHint = !modern ? {} : msg.method === 'tools/list' ? { ttlMs: 10000, cacheScope: 'private' } : ['server/discover', 'resources/list', 'resources/templates/list', 'prompts/list'].includes(msg.method) ? { ttlMs: 60000, cacheScope: 'public' } : {};
  const reply = (result) => write({ jsonrpc: '2.0', id: msg.id, result: modern ? { resultType: 'complete', ...result, ...cacheHint, _meta: { [META_SERVER]: serverInfo(c) } } : result });
  const fail = (code, text, data) => write({ jsonrpc: '2.0', id: msg.id, error: { code, message: text, ...(data ? { data } : {}) } });
  if (modern && !v.modern.includes(modernVersion)) return fail(-32022, 'Unsupported protocol version', { supported: v.all, requested: modernVersion });
  const instructions = state === 'offline' ? message('instructions') : c.instructions || message('instructions');
  const tools = c.entitled === false ? [] : Array.isArray(c.tools) ? c.tools : [];
  switch (msg.method) {
    case 'initialize': {
      const requested = isObject(msg.params) ? msg.params.protocolVersion : null;
      const version = v.legacy.includes(requested) ? requested : v.legacy[0];
      session.version = version;
      return write({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: version, capabilities: { tools: { listChanged: true } }, serverInfo: serverInfo(c), instructions } });
    }
    case 'server/discover':
      return reply({ supportedVersions: v.all, capabilities: { tools: {} }, instructions });
    case 'ping':
    case 'logging/setLevel':
      return reply({});
    case 'tools/list':
      session.lastToolsSig = toolsSig(tools);
      return reply({ tools });
    case 'tools/call':
      return reply({ content: [{ type: 'text', text: JSON.stringify({ ok: false, error: message(state) }) }], isError: true });
    case 'resources/list':
      return reply({ resources: [] });
    case 'resources/templates/list':
      return reply({ resourceTemplates: [] });
    case 'prompts/list':
      return reply({ prompts: [] });
    default:
      return fail(-32601, `Method not found: ${String(msg.method).slice(0, 80)}`);
  }
}

// Encabezado seguro para HTTP (Mcp-Name): texto ASCII visible o Base64 con el formato de la especificacion.
function headerValue(v) {
  const s = String(v);
  if (/^[\x21-\x7e]([\x20-\x7e]*[\x21-\x7e])?$/.test(s) && !/^=\?base64\?.*\?=$/.test(s)) return s;
  return `=?base64?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

function headersFor(msg) {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'X-Venus-Bridge': '1' };
  const meta = isObject(msg.params) && isObject(msg.params._meta) ? msg.params._meta : null;
  const modernVersion = meta && typeof meta[META_VERSION] === 'string' ? meta[META_VERSION] : null;
  if (modernVersion) {
    h['MCP-Protocol-Version'] = modernVersion;
    if (typeof msg.method === 'string') h['Mcp-Method'] = msg.method;
    const name = msg.method === 'resources/read' ? msg.params.uri : msg.params?.name;
    if (['tools/call', 'resources/read', 'prompts/get'].includes(msg.method) && typeof name === 'string') h['Mcp-Name'] = headerValue(name);
    const ci = meta[META_CLIENT];
    if (isObject(ci) && typeof ci.name === 'string') session.client = ci.name;
  } else if (session.version && msg.method !== 'initialize') {
    h['MCP-Protocol-Version'] = session.version;
  }
  if (session.client) h['X-Venus-Client'] = String(session.client).replace(/[^\w .:@/()+-]/g, '').slice(0, 60);
  return h;
}

// POST al launcher. Devuelve { status, type, body (texto), events (SSE ya separados) } o lanza (sin conexion).
function post(target, msg, signal) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(msg));
    const req = http.request(
      { host: '127.0.0.1', port: target.port, path: `/mcp/${target.secret}`, method: 'POST', headers: { ...headersFor(msg), 'Content-Length': data.length, Host: `127.0.0.1:${target.port}` }, signal },
      (res) => {
        const type = String(res.headers['content-type'] || '');
        if (type.includes('text/event-stream')) {
          // Cada evento "data:" es un mensaje JSON-RPC: se pasa a stdout apenas llega
          let buf = '';
          const seen = { final: false };
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            buf += chunk;
            let m;
            while ((m = /\r?\n\r?\n/.exec(buf))) {
              const block = buf.slice(0, m.index);
              buf = buf.slice(m.index + m[0].length);
              const payload = block
                .split(/\r?\n/)
                .filter((l) => l.startsWith('data:'))
                .map((l) => l.slice(5).replace(/^ /, ''))
                .join('\n');
              if (!payload) continue;
              try {
                const out = JSON.parse(payload);
                if (isObject(out) && out.id === msg.id && (out.result !== undefined || out.error !== undefined)) seen.final = true;
                onServerMessage(out, msg);
              } catch {
                /* evento invalido */
              }
            }
          });
          res.on('end', () => resolve({ status: res.statusCode, type, streamed: true, final: seen.final }));
          res.on('error', reject);
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, type, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

// Mensaje del launcher hacia el cliente (ajusta initialize para avisar cambios de herramientas).
function onServerMessage(out, request) {
  if (isObject(out) && request && out.id === request.id && isObject(out.result)) {
    if (request.method === 'initialize') {
      session.legacy = true;
      session.version = typeof out.result.protocolVersion === 'string' ? out.result.protocolVersion : session.version;
      out.result.capabilities = { ...(isObject(out.result.capabilities) ? out.result.capabilities : {}), tools: { ...(isObject(out.result.capabilities?.tools) ? out.result.capabilities.tools : {}), listChanged: true } };
    } else if (request.method === 'tools/list') {
      session.lastToolsSig = toolsSig(out.result.tools);
    }
  }
  write(out);
}

async function forward(msg) {
  const isRequest = Object.prototype.hasOwnProperty.call(msg, 'id');
  if (msg.method === 'initialize' && isObject(msg.params)) {
    session.legacy = true;
    if (isObject(msg.params.clientInfo) && typeof msg.params.clientInfo.name === 'string') session.client = msg.params.clientInfo.name;
  }
  if (!isRequest) {
    // Notificaciones: cancelar corta el pedido HTTP (el launcher cancela la herramienta); el resto se ignora
    if (msg.method === 'notifications/cancelled' && isObject(msg.params)) inflight.get(String(msg.params.requestId))?.abort();
    if (msg.method === 'notifications/initialized') session.initialized = true;
    return;
  }
  let target = launcher();
  if (target.state !== 'online') return localAnswer(msg, target.state);
  const controller = new AbortController();
  const key = String(msg.id);
  inflight.set(key, controller);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      let r;
      try {
        r = await post(target, msg, controller.signal);
      } catch (err) {
        if (controller.signal.aborted) return; // cancelado por el cliente: no se responde
        target = launcher();
        return localAnswer(msg, target.state === 'online' ? 'unreachable' : target.state);
      }
      if (r.streamed) {
        // El flujo se corto sin la respuesta final: el cliente igual recibe una
        if (!r.final && !controller.signal.aborted) localAnswer(msg, 'unreachable');
        return;
      }
      // 404 sin cuerpo: el secreto cambio (Regenerar); se relee bridge.json y se prueba una vez mas
      if (r.status === 404 && !r.body && attempt === 0) {
        target = launcher();
        if (target.state !== 'online') return localAnswer(msg, target.state);
        continue;
      }
      if (r.status === 202 || !r.body) {
        if (r.status >= 400) return localAnswer(msg, 'unreachable');
        return;
      }
      let out;
      try {
        out = JSON.parse(r.body);
      } catch {
        return localAnswer(msg, 'unreachable');
      }
      if (Array.isArray(out)) return write(out);
      if (isObject(out) && out.error && (out.id === null || out.id === undefined)) out.id = msg.id;
      return onServerMessage(out, msg);
    }
    return localAnswer(msg, 'unreachable');
  } finally {
    inflight.delete(key);
  }
}

// ---------- Entrada ----------
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i).replace(/\r$/, '');
    buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    const list = Array.isArray(msg) ? msg : [msg];
    for (const m of list) {
      if (!isObject(m)) {
        write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
        continue;
      }
      forward(m).catch((err) => {
        warn(err?.message || String(err));
        if (Object.prototype.hasOwnProperty.call(m, 'id')) write({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: 'Internal error' } });
      });
    }
  }
});
process.stdin.on('end', () => {
  for (const c of inflight.values()) c.abort();
  setTimeout(() => process.exit(0), 50);
});

// Aviso de cambios en la lista de herramientas (solo era con initialize, despues de notifications/initialized)
let lastMtime = 0;
const poll = setInterval(() => {
  if (!session.legacy || !session.initialized || session.lastToolsSig === null) return;
  let mtime = 0;
  try {
    mtime = fs.statSync(TOOLS_FILE).mtimeMs;
  } catch {
    mtime = 0;
  }
  if (mtime === lastMtime) return;
  lastMtime = mtime;
  const c = cache();
  const now = toolsSig(c.entitled === false ? [] : c.tools);
  if (now !== session.lastToolsSig) {
    session.lastToolsSig = null;
    write({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  }
}, POLL_MS);
poll.unref();
