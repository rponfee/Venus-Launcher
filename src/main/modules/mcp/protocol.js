'use strict';
// Protocolo MCP (JSON-RPC 2.0) del servidor de Venus Launcher. Sin dependencias ni Electron: lo usan el
// transporte HTTP (http-server.js) y las pruebas. Es un servidor "de las dos eras" de la especificacion:
//   - moderna (2026-07-28): sin handshake. Cada pedido trae en params._meta la version
//     ('io.modelcontextprotocol/protocolVersion') y las capacidades del cliente; los resultados llevan
//     resultType 'complete' y serverInfo en _meta. server/discover devuelve versiones y capacidades.
//   - heredada (2025-11-25, 2025-06-18, 2025-03-26 y 2024-11-05): initialize + notifications/initialized.
// Sin estado: no hay sesiones (Mcp-Session-Id) y ningun pedido depende de uno anterior.
//
// prepare(mensaje, ctx) valida y decide la respuesta: { kind: 'reply', status, body } (body null = 202, sin
// cuerpo) o { kind: 'run', status, streamable, run(ctx) -> body } para lo que hace trabajo (tools/list y
// tools/call). El transporte decide si responde con JSON o con un flujo SSE (progreso de tools/call).
// ctx = { transport: 'http' | 'stdio', headers: { protocolVersion, method, name }, onConnect(info),
//         onCancel(requestId), signal, progress(message) }

const MODERN_VERSIONS = Object.freeze(['2026-07-28']);
const LEGACY_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
const SUPPORTED_VERSIONS = Object.freeze([...MODERN_VERSIONS, ...LEGACY_VERSIONS]);
const LATEST_LEGACY = LEGACY_VERSIONS[0];

const META = Object.freeze({
  version: 'io.modelcontextprotocol/protocolVersion',
  clientInfo: 'io.modelcontextprotocol/clientInfo',
  clientCapabilities: 'io.modelcontextprotocol/clientCapabilities',
  serverInfo: 'io.modelcontextprotocol/serverInfo',
});

const ERR = Object.freeze({
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  HEADER_MISMATCH: -32020,
  MISSING_CAPABILITY: -32021,
  UNSUPPORTED_VERSION: -32022,
});

// Metodos que en HTTP moderno llevan el encabezado Mcp-Name (params.name o params.uri).
const NAMED = new Set(['tools/call', 'resources/read', 'prompts/get']);
// Listas que no ofrecemos pero que algunos clientes piden igual: se contestan vacias en vez de con error.
const EMPTY_LISTS = { 'resources/list': 'resources', 'resources/templates/list': 'resourceTemplates', 'prompts/list': 'prompts' };

// Error de protocolo (JSON-RPC) que puede lanzar callTool, por ejemplo una herramienta desconocida.
class ProtocolError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const validId = (id) => (typeof id === 'string' && id.length <= 200) || (typeof id === 'number' && Number.isFinite(id));

function errorResponse(id, code, message, data) {
  return { jsonrpc: '2.0', id: validId(id) ? id : null, error: { code, message: String(message || 'Error'), ...(data !== undefined ? { data } : {}) } };
}

function resultResponse(id, result) {
  return { jsonrpc: '2.0', id, result };
}

// Valor de un encabezado que puede venir en Base64 ("=?base64?...?="), como Mcp-Name.
function decodeHeaderValue(v) {
  if (typeof v !== 'string') return undefined;
  const m = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(v);
  if (!m) return v;
  try {
    return Buffer.from(m[1], 'base64').toString('utf8');
  } catch {
    return undefined;
  }
}

// Codigo HTTP de un error segun la era (moderna: 400/404 como pide la especificacion; heredada: 200 salvo
// pedidos mal armados).
function httpStatusFor(code, era) {
  if (code === ERR.PARSE || code === ERR.INVALID_REQUEST) return 400;
  if (era !== 'modern') return 200;
  if (code === ERR.METHOD_NOT_FOUND) return 404;
  if ([ERR.INVALID_PARAMS, ERR.HEADER_MISMATCH, ERR.MISSING_CAPABILITY, ERR.UNSUPPORTED_VERSION].includes(code)) return 400;
  return 200;
}

// Nombre corto y seguro de un cliente (para el registro de actividad).
function cleanClientInfo(info) {
  if (!isObject(info)) return null;
  const name = typeof info.name === 'string' ? info.name.replace(/[^\w .:@/()+-]/g, '').trim().slice(0, 60) : '';
  const version = typeof info.version === 'string' ? info.version.replace(/[^\w .:+-]/g, '').trim().slice(0, 30) : '';
  return name ? { name, version } : null;
}

/**
 * opts:
 *   serverInfo()            -> { name, title, version }
 *   instructions()          -> texto para el modelo
 *   listTools(ctx)          -> Promise<Tool[]> (definiciones MCP: name, title, description, inputSchema, annotations)
 *   callTool(name, args, ctx) -> Promise<{ content, isError }> (puede lanzar ProtocolError)
 *   onConnect(info, ctx)    -> opcional: { era, version, clientInfo } en initialize y server/discover
 */
function createProtocol(opts) {
  const serverInfo = () => {
    const s = (opts.serverInfo && opts.serverInfo()) || {};
    return { name: s.name || 'venus-launcher', title: s.title || 'Venus Launcher', version: s.version || '0.0.0' };
  };
  // Conexion de un cliente (initialize o server/discover): para el registro de actividad
  const connected = (info, ctx) => {
    try {
      opts.onConnect?.(info, ctx);
      ctx.onConnect?.(info);
    } catch {
      /* solo informativo */
    }
  };
  const instructions = () => (opts.instructions ? String(opts.instructions() || '') : '');

  const reply = (status, body) => ({ kind: 'reply', status, body });
  const accepted = () => reply(202, null);
  const failure = (id, era, code, message, data) => reply(httpStatusFor(code, era), errorResponse(id, code, message, data));

  // Convierte el resultado (o el error) de un trabajo en la respuesta JSON-RPC.
  function runner(id, era, work, streamable = false) {
    return {
      kind: 'run',
      status: 200,
      streamable,
      era,
      run: async (ctx) => {
        try {
          return resultResponse(id, await work(ctx || {}));
        } catch (err) {
          if (err instanceof ProtocolError) return errorResponse(id, err.code, err.message, err.data);
          return errorResponse(id, ERR.INTERNAL, err?.message || 'Internal error');
        }
      },
    };
  }

  const modern = (result) => ({ resultType: 'complete', ...result, _meta: { ...(isObject(result?._meta) ? result._meta : {}), [META.serverInfo]: serverInfo() } });
  // Pistas de cache OBLIGATORIAS en la revision 2026-07-28 para server/discover y las listas (tools/list, prompts/list,
  // resources/list, resources/templates/list): sin ttlMs y cacheScope, clientes como Claude Code 2.1.286 descartan el
  // resultado ("INVALID_RESULT") y se quedan sin herramientas. La lista de herramientas depende del plan de la cuenta:
  // 'private' y un minuto; lo demas es igual para todos: 'public' y cinco minutos.
  const CACHE_PRIVATE = { ttlMs: 60000, cacheScope: 'private' };
  const CACHE_PUBLIC = { ttlMs: 300000, cacheScope: 'public' };

  function toolCallParams(id, era, params) {
    if (typeof params.name !== 'string' || !params.name) return { error: failure(id, era, ERR.INVALID_PARAMS, 'Invalid params: "name" must be a string') };
    if (params.arguments !== undefined && params.arguments !== null && !isObject(params.arguments)) return { error: failure(id, era, ERR.INVALID_PARAMS, 'Invalid params: "arguments" must be an object') };
    return { name: params.name, args: isObject(params.arguments) ? params.arguments : {} };
  }

  // ---------- Era moderna ----------
  function prepareModern(msg, params, meta, version, ctx) {
    const id = msg.id;
    if (!version) return failure(id, 'modern', ERR.INVALID_PARAMS, `Invalid params: missing _meta["${META.version}"]`);
    if (!MODERN_VERSIONS.includes(version)) return failure(id, 'modern', ERR.UNSUPPORTED_VERSION, 'Unsupported protocol version', { supported: [...SUPPORTED_VERSIONS], requested: version });
    if (!isObject(meta[META.clientCapabilities])) return failure(id, 'modern', ERR.INVALID_PARAMS, `Invalid params: missing _meta["${META.clientCapabilities}"]`);
    if (ctx.transport === 'http') {
      const h = ctx.headers || {};
      if (h.protocolVersion !== version) return failure(id, 'modern', ERR.HEADER_MISMATCH, `Header mismatch: MCP-Protocol-Version header value '${String(h.protocolVersion ?? '').slice(0, 40)}' does not match body value '${version}'`);
      if (h.method !== msg.method) return failure(id, 'modern', ERR.HEADER_MISMATCH, `Header mismatch: Mcp-Method header value '${String(h.method ?? '').slice(0, 60)}' does not match body value '${msg.method.slice(0, 60)}'`);
      if (NAMED.has(msg.method)) {
        const want = msg.method === 'resources/read' ? params.uri : params.name;
        const got = decodeHeaderValue(h.name);
        if (typeof want === 'string' && got !== want) return failure(id, 'modern', ERR.HEADER_MISMATCH, `Header mismatch: Mcp-Name header value '${String(got ?? '').slice(0, 60)}' does not match body value '${want.slice(0, 60)}'`);
      }
    }
    const client = cleanClientInfo(meta[META.clientInfo]);
    switch (msg.method) {
      case 'server/discover':
        connected({ era: 'modern', version, clientInfo: client }, ctx);
        return reply(200, resultResponse(id, modern({ supportedVersions: [...SUPPORTED_VERSIONS], capabilities: { tools: {} }, ...(instructions() ? { instructions: instructions() } : {}), ...CACHE_PUBLIC })));
      case 'ping':
        return reply(200, resultResponse(id, modern({})));
      case 'tools/list':
        return runner(id, 'modern', async (c) => modern({ tools: await opts.listTools({ ...ctx, ...c, era: 'modern', version, clientInfo: client }), ...CACHE_PRIVATE }));
      case 'tools/call': {
        const p = toolCallParams(id, 'modern', params);
        if (p.error) return p.error;
        return runner(id, 'modern', async (c) => modern(await opts.callTool(p.name, p.args, { ...ctx, ...c, era: 'modern', version, clientInfo: client })), meta.progressToken !== undefined);
      }
      default:
        if (EMPTY_LISTS[msg.method]) return reply(200, resultResponse(id, modern({ [EMPTY_LISTS[msg.method]]: [], ...CACHE_PUBLIC })));
        return failure(id, 'modern', ERR.METHOD_NOT_FOUND, `Method not found: ${msg.method.slice(0, 80)}`);
    }
  }

  // ---------- Era heredada ----------
  function prepareLegacy(msg, params, ctx) {
    const id = msg.id;
    if (ctx.transport === 'http') {
      const hv = ctx.headers?.protocolVersion;
      // Sin encabezado: version 2025-03-26 (la especificacion lo permite para clientes viejos)
      if (hv && !LEGACY_VERSIONS.includes(hv)) return reply(400, errorResponse(id, ERR.INVALID_REQUEST, `Unsupported MCP-Protocol-Version: ${String(hv).slice(0, 40)}`, { supported: [...SUPPORTED_VERSIONS] }));
    }
    switch (msg.method) {
      case 'initialize': {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
        const version = requested && LEGACY_VERSIONS.includes(requested) ? requested : LATEST_LEGACY;
        connected({ era: 'legacy', version, clientInfo: cleanClientInfo(params.clientInfo) }, ctx);
        const text = instructions();
        return reply(200, resultResponse(id, { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: serverInfo(), ...(text ? { instructions: text } : {}) }));
      }
      case 'ping':
        return reply(200, resultResponse(id, {}));
      case 'tools/list':
        return runner(id, 'legacy', async (c) => ({ tools: await opts.listTools({ ...ctx, ...c, era: 'legacy' }) }));
      case 'tools/call': {
        const p = toolCallParams(id, 'legacy', params);
        if (p.error) return p.error;
        const progressToken = isObject(params._meta) ? params._meta.progressToken : undefined;
        return runner(id, 'legacy', async (c) => opts.callTool(p.name, p.args, { ...ctx, ...c, era: 'legacy' }), progressToken !== undefined);
      }
      case 'logging/setLevel':
        return reply(200, resultResponse(id, {}));
      default:
        if (EMPTY_LISTS[msg.method]) return reply(200, resultResponse(id, { [EMPTY_LISTS[msg.method]]: [] }));
        return failure(id, 'legacy', ERR.METHOD_NOT_FOUND, `Method not found: ${msg.method.slice(0, 80)}`);
    }
  }

  /** Valida un mensaje JSON-RPC y decide que hacer con el (ver el comentario del principio). */
  function prepare(msg, ctx = {}) {
    if (!isObject(msg)) return reply(400, errorResponse(null, ERR.INVALID_REQUEST, 'Invalid Request'));
    // Respuestas del cliente: este servidor nunca le manda pedidos, se ignoran
    if (msg.method === undefined && ('result' in msg || 'error' in msg)) return accepted();
    if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string' || !msg.method || msg.method.length > 200) {
      return reply(400, errorResponse(validId(msg.id) ? msg.id : null, ERR.INVALID_REQUEST, 'Invalid Request'));
    }
    const isRequest = Object.prototype.hasOwnProperty.call(msg, 'id');
    if (isRequest && !validId(msg.id)) return reply(400, errorResponse(null, ERR.INVALID_REQUEST, 'Invalid Request: id must be a string or a number'));
    const params = msg.params === undefined || msg.params === null ? {} : msg.params;
    if (!isObject(params)) return isRequest ? reply(400, errorResponse(msg.id, ERR.INVALID_PARAMS, 'Invalid params')) : accepted();

    // Notificaciones: nunca llevan respuesta
    if (!isRequest) {
      if (msg.method === 'notifications/cancelled' && params.requestId !== undefined) ctx.onCancel?.(params.requestId);
      return accepted();
    }

    const meta = isObject(params._meta) ? params._meta : null;
    const bodyVersion = meta && typeof meta[META.version] === 'string' ? meta[META.version] : null;
    const headerVersion = ctx.transport === 'http' ? ctx.headers?.protocolVersion : undefined;
    let era = 'legacy';
    if (bodyVersion !== null) era = LEGACY_VERSIONS.includes(bodyVersion) ? 'legacy' : 'modern';
    else if (msg.method === 'server/discover') era = 'modern';
    else if (headerVersion && MODERN_VERSIONS.includes(headerVersion)) era = 'modern';
    return era === 'modern' ? prepareModern(msg, params, meta || {}, bodyVersion, ctx) : prepareLegacy(msg, params, ctx);
  }

  /** Atiende un mensaje completo (sin flujo de progreso): { status, body }. */
  async function handleMessage(msg, ctx = {}) {
    const p = prepare(msg, ctx);
    if (p.kind === 'reply') return { status: p.status, body: p.body };
    return { status: p.status, body: await p.run(ctx) };
  }

  /**
   * Cuerpo HTTP completo: un mensaje o un lote (arreglo, solo clientes 2025-03-26). Devuelve { status, body }
   * (body null = 202 sin cuerpo).
   */
  async function handlePayload(payload, ctx = {}) {
    if (!Array.isArray(payload)) return handleMessage(payload, ctx);
    if (!payload.length) return { status: 400, body: errorResponse(null, ERR.INVALID_REQUEST, 'Invalid Request: empty batch') };
    if (payload.length > 50) return { status: 400, body: errorResponse(null, ERR.INVALID_REQUEST, 'Invalid Request: batch too large') };
    const out = await Promise.all(payload.map((m) => handleMessage(m, ctx).catch(() => ({ status: 200, body: errorResponse(null, ERR.INTERNAL, 'Internal error') }))));
    const bodies = out.map((r) => r.body).filter(Boolean);
    return bodies.length ? { status: 200, body: bodies } : { status: 202, body: null };
  }

  return { prepare, handleMessage, handlePayload };
}

// Resultado de herramienta con un texto JSON (lo que leen Claude y ChatGPT).
function textResult(payload, isError = false) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return { content: [{ type: 'text', text }], isError: Boolean(isError) };
}

module.exports = {
  createProtocol,
  ProtocolError,
  textResult,
  errorResponse,
  decodeHeaderValue,
  httpStatusFor,
  cleanClientInfo,
  MODERN_VERSIONS,
  LEGACY_VERSIONS,
  SUPPORTED_VERSIONS,
  LATEST_LEGACY,
  META,
  ERR,
};
