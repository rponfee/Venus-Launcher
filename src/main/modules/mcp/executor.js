'use strict';
// Herramientas del MCP = las del asistente del launcher, con SUS ejecutores, guardas, niveles de permiso,
// diario de Deshacer y anonimizacion (src/main/modules/assistant/*). Aca solo se envuelven para MCP:
//   - Definiciones: assistant/tool-defs.js (mismos nombres, descripciones y esquemas JSON) filtradas por
//     assistant/permissions.json (una herramienta sin nivel no se ofrece ni se ejecuta) + launcher_status y
//     undo_last_action. Titulos traducidos y anotaciones (readOnlyHint, destructiveHint...) para el cliente.
//   - Ejecucion (el mismo orden que assistant/agent.js): validate -> prepare -> confirmacion en el launcher si
//     la pide la herramienta o el nivel es 'destructive' -> instantanea + undo.begin -> run -> undo.commit (o
//     abort si fallo o no cambio nada) -> redact. Los cambios van de a uno (cola); las lecturas, en paralelo.
//   - Instalacion masiva: 4 o mas instalaciones (agent.BULK_LIMIT) en una instancia que no creo el MCP, dentro
//     de 15 minutos, piden una confirmacion (lo mismo que hace el asistente dentro de una pregunta).
//   - Plan: sin plan pago (gate) no hay herramientas y tools/call devuelve el aviso del plan.
// No usa la IA de Venus: el modelo es el Claude o ChatGPT del usuario, asi que no gasta cuota de Venus IA.
const tools = require('../assistant/tools');
const toolDefs = require('../assistant/tool-defs');
const config = require('../assistant/config');
const undo = require('../assistant/undo');
const agent = require('../assistant/agent');
const { validate, ToolError } = require('../assistant/guards');
const { currentRedactor } = require('../assistant/redact');
const { ProtocolError, ERR, textResult } = require('./protocol');

const MAX_RESULT = 24000;
const BULK_WINDOW_MS = 15 * 60 * 1000;
const RATE = { windowMs: 60000, calls: 120, changes: 30 };
const OPEN_WORLD = new Set(['search_mods', 'search_resource_packs', 'search_shaders', 'get_mod_versions', 'check_compatibility', 'create_instance', 'install_mod', 'install_resource_pack', 'install_shader', 'update_mod', 'set_java_version', 'change_instance_version', 'create_server', 'search_server_plugins', 'install_server_plugin', 'update_server_plugin', 'replace_server_plugin']);
const UNDO_PREFIX = 'mcp_';

// Herramientas propias del MCP (no existen en el asistente). Descripciones en ingles: las lee el modelo.
const EXTRA = [
  {
    name: 'launcher_status',
    level: 'read',
    description:
      'Get the state of Venus Launcher: launcher version and language, whether the user is signed in to a Venus account and the Venus AI plan, the selected instance, instances whose game is running, and how many changes made through this connection can still be undone. Call it first when you need context about the launcher.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'undo_last_action',
    level: 'reversible',
    description:
      'Undo a change you made in Venus Launcher through this connection: the most recent one, or a specific one by its undo_id (returned by change tools as undo_id). The launcher restores exactly what that change touched. Fails if a later change touched the same thing (undo that one first) or if the game of that instance is running. Undoing create_instance sends that whole instance to the recycle bin, so it needs the user\'s confirmation in the launcher window. Only use it when the user asks to revert something.',
    inputSchema: { type: 'object', properties: { undo_id: { type: 'string', description: 'Optional undo_id from a previous tool result. Omit to undo the most recent change.' } }, required: [], additionalProperties: false },
  },
];

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// Nombre para mostrar del cliente MCP (registro de actividad y confirmaciones).
function clientLabel(raw, source, t) {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (/claude[-_ ]?code/i.test(name)) return 'Claude Code';
  if (/openai|chatgpt/i.test(name)) return 'ChatGPT';
  if (/claude|anthropic/i.test(name)) return source === 'remote' ? 'claude.ai' : 'Claude Desktop';
  if (name) return name.slice(0, 40);
  return source === 'remote' ? t('mcp.clientRemote') : t('mcp.clientLocal');
}

// Entrada resumida para mostrar en la actividad (sin textos largos).
function shortInput(input) {
  const out = {};
  for (const [k, v] of Object.entries(input || {})) {
    if (typeof v === 'string') out[k] = v.length > 120 ? `${v.slice(0, 119)}…` : v;
    else if (Array.isArray(v)) out[k] = v.slice(0, 12).map((x) => (typeof x === 'string' ? x.slice(0, 60) : x));
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

// JSON del resultado con el mismo tope que el asistente (sigue siendo JSON valido si se recorta).
function clip(payload) {
  let s;
  try {
    s = JSON.stringify(payload);
  } catch {
    s = JSON.stringify({ ok: false, error: 'Unserializable result' });
  }
  if (s.length > MAX_RESULT) s = JSON.stringify({ truncated: true, note: 'The result was too large and was cut. Use filters or pagination to see the rest.', partial: s.slice(0, MAX_RESULT - 300) });
  return s;
}

/**
 * deps:
 *   gate        { ready(), entitled, state }       (gate.js)
 *   approvals   { request(payload, { signal }) }  (approvals.js)
 *   activity    { add, update, byUndoId }          (activity.js)
 *   t           traducciones del proceso principal
 *   statusInfo  async () => datos de launcher_status (sin anonimizar)
 *   optional    (nombre) => modulo hermano opcional ('snapshots') o null
 *   instances   core/instances (para la guarda de instalacion masiva)
 *   approvalTimeoutMs, now
 */
function createExecutor({ gate, approvals, activity, t, statusInfo = async () => ({}), optional = () => null, instances = require('../../core/instances'), approvalTimeoutMs = 50000, now = Date.now, rate = RATE } = {}) {
  // "Conversacion" del MCP para las herramientas: instancias creadas por esta conexion (no piden la
  // confirmacion de instalacion masiva y no llevan la instantanea completa).
  const conv = { id: null, createdAt: now(), createdInstances: [], fullSnapshots: {}, notes: [] };
  const turn = { id: null, installs: new Map(), bulkApproved: new Set() };
  const bulk = new Map(); // instanceId -> { count, last, approved, items }
  const snapped = new Set();
  const calls = [];
  const changes = [];
  let lockTail = Promise.resolve();
  let defsCache = null; // { lang, list }

  // ---------- Definiciones ----------
  function annotations(name, level) {
    return { title: t(`mcp.tool_${name}`), readOnlyHint: level === 'read', destructiveHint: level === 'destructive', idempotentHint: level === 'read', openWorldHint: OPEN_WORLD.has(name) };
  }

  function definitions() {
    const lang = require('../../core/i18n').getLanguage();
    if (defsCache && defsCache.lang === lang) return defsCache.list;
    const list = [];
    for (const d of toolDefs.build()) {
      const tool = tools.REGISTRY[d.name];
      if (!tool) continue;
      const level = config.effectiveLevel(d.name, tool.minLevel);
      if (!level) continue;
      list.push({ name: d.name, title: t(`mcp.tool_${d.name}`), description: d.description, inputSchema: d.input_schema, annotations: annotations(d.name, level) });
    }
    for (const x of EXTRA) list.push({ name: x.name, title: t(`mcp.tool_${x.name}`), description: x.description, inputSchema: x.inputSchema, annotations: annotations(x.name, x.level) });
    defsCache = { lang, list };
    return list;
  }

  function invalidate() {
    defsCache = null;
  }

  function levelOf(name) {
    const extra = EXTRA.find((x) => x.name === name);
    if (extra) return extra.level;
    const tool = tools.REGISTRY[name];
    return tool ? config.effectiveLevel(name, tool.minLevel) : null;
  }

  function schemaOf(name) {
    return definitions().find((d) => d.name === name)?.inputSchema || null;
  }

  async function listTools() {
    await gate.ready();
    return gate.entitled ? definitions() : [];
  }

  // ---------- Ayudas ----------
  function planMessage() {
    const reason = gate.state?.reason;
    const base = t('mcp.errPlan').replace(/[.。]\s*$/, '');
    if (reason === 'signedOut' || reason === 'noCloud') return `${base}. ${t('mcp.errPlanSignIn')}`;
    if (reason === 'offline' || reason === 'error') return `${base}. ${t('mcp.errPlanUnknown')}`;
    return `${base}. ${t('mcp.errPlanUpgrade')}`;
  }

  function rateLimited(level) {
    const cut = now() - rate.windowMs;
    while (calls.length && calls[0] < cut) calls.shift();
    while (changes.length && changes[0] < cut) changes.shift();
    if (calls.length >= rate.calls || (level !== 'read' && changes.length >= rate.changes)) return true;
    calls.push(now());
    if (level !== 'read') changes.push(now());
    return false;
  }

  // Los cambios van de a uno y en orden (evita carreras sobre la misma instancia, como en el asistente).
  function withLock(fn, signal) {
    const run = lockTail.then(() => {
      if (signal?.aborted) throw new ToolError(t('mcp.errCancelled'), 'cancelled');
      return fn();
    });
    lockTail = run.catch(() => {});
    return run;
  }

  function declinedError(answer, kind = 'action') {
    if (answer === 'expired') return new ToolError(t('mcp.errApprovalExpired', { seconds: Math.round(approvalTimeoutMs / 1000) }), 'declined');
    if (answer === 'cancelled') return new ToolError(t('mcp.errCancelled'), 'cancelled');
    return new ToolError(kind === 'bulk' ? t('mcp.errBulkDeclined') : t('mcp.errUserDeclined'), 'declined');
  }

  function genericConfirm(name) {
    return { kind: 'destructive', title: t('mcp.approveGenericTitle'), message: t('mcp.approveGenericText', { tool: t(`mcp.tool_${name}`) }), danger: true };
  }

  async function projectTitles(ids) {
    const mr = ids.filter((x) => !/^cf:/i.test(x));
    if (!mr.length) return ids;
    try {
      const modrinth = require('../../core/modrinth');
      const list = await Promise.race([modrinth.getProjects(mr), new Promise((r) => setTimeout(() => r([]), 4000).unref?.())]);
      return ids.map((id) => (Array.isArray(list) ? list.find((p) => p.id === id || p.slug === id)?.title : null) || id);
    } catch {
      return ids;
    }
  }

  // Primera vez que el MCP cambia una instancia que ya existia: instantanea completa (modulo snapshots).
  async function ensureFullSnapshot(instanceId) {
    if (snapped.has(instanceId) || conv.createdInstances.includes(instanceId)) return;
    snapped.add(instanceId);
    const snaps = optional('snapshots');
    if (!snaps || typeof snaps.create !== 'function') return;
    try {
      await Promise.race([snaps.create(instanceId, { reason: t('mcp.snapshotReason'), worlds: 'none' }), new Promise((r) => setTimeout(r, 20000).unref?.())]);
    } catch (err) {
      console.warn('[mcp] No se pudo crear la instantanea completa:', err?.message || err);
    }
  }

  async function bulkGuard(name, input, entry, who, signal) {
    const id = input.instance_id;
    if (typeof id !== 'string' || conv.createdInstances.includes(id)) return;
    // Solo el id exacto (como las herramientas): un alias con otras mayusculas no lleva un conteo aparte
    const inst = await tools.getInstance(id).catch(() => null);
    if (!inst) return;
    let b = bulk.get(id);
    if (!b || now() - b.last > BULK_WINDOW_MS) b = { count: 0, last: 0, approved: false, items: [] };
    b.last = now();
    bulk.set(id, b);
    const next = b.count + 1;
    const item = String(input.project_id || '?');
    if (b.approved || next < agent.BULK_LIMIT) {
      b.count = next;
      b.items.push(item);
      return;
    }
    activity.update(entry.id, { state: 'pending' });
    const titles = await projectTitles([...b.items, item]);
    const answer = await approvals.request(
      { kind: 'bulk', tool: name, title: t('mcp.approveBulkTitle'), message: t('mcp.approveBulkText', { count: next, name: inst.name, client: who.name }), items: titles, okText: t('mcp.approveBulkOk'), danger: false, client: who.name, source: who.source },
      { signal },
    );
    if (answer !== 'approved') throw declinedError(answer, 'bulk');
    b.approved = true;
    b.count = next;
    b.items.push(item);
    activity.update(entry.id, { state: 'running' });
  }

  function who(ctx) {
    const source = ctx.client?.source === 'remote' ? 'remote' : 'local';
    return { name: clientLabel(ctx.clientInfo?.name || ctx.client?.name, source, t), source };
  }

  function failResult(entry, started, err, redact, signal) {
    const declined = err instanceof ToolError && err.code === 'declined';
    let message = err?.message || String(err);
    if (!(err instanceof ToolError)) {
      if (signal?.aborted) message = t('mcp.errCancelled');
      else console.warn(`[mcp] ${entry?.tool}:`, message);
    }
    if (entry) activity.update(entry.id, { state: declined ? 'denied' : 'error', error: message, summary: message, durationMs: now() - started });
    const extra = { ...(declined ? { user_declined: true } : {}), ...(err?.data ? { details: err.data } : {}) };
    return textResult(clip(redact({ ok: false, error: message, ...extra })), true);
  }

  // ---------- Ejecucion de una herramienta del asistente ----------
  async function execute(name, tool, level, input, ctx) {
    const w = who(ctx);
    const signal = ctx.signal || new AbortController().signal;
    const started = now();
    const entry = activity.add({ kind: 'tool', tool: name, toolTitle: t(`mcp.tool_${name}`), level, client: w.name, source: w.source, input: shortInput(input) });
    const toolUseId = `${UNDO_PREFIX}${entry.id}`;
    const redact = await currentRedactor();
    let action = null;
    try {
      if (signal.aborted) throw new ToolError(t('mcp.errCancelled'), 'cancelled');
      if (tools.INSTALL_TOOLS.has(name)) await bulkGuard(name, input, entry, w, signal);
      const prep = await tool.prepare(input, { conv, turn, signal });
      const needs = prep.confirm || (level === 'destructive' ? genericConfirm(name) : null);
      if (needs) {
        activity.update(entry.id, { state: 'pending' });
        ctx.progress?.(t('mcp.progressApproval'));
        const answer = await approvals.request({ ...needs, tool: name, client: w.name, source: w.source }, { signal });
        if (answer !== 'approved') throw declinedError(answer);
        activity.update(entry.id, { state: 'running' });
      }
      if (signal.aborted) throw new ToolError(t('mcp.errCancelled'), 'cancelled');
      if (level !== 'read') ctx.progress?.(t('mcp.progressRunning', { tool: t(`mcp.tool_${name}`) }));
      const snapshot = prep.scope && (tool.minLevel === 'reversible' || level === 'reversible');
      if (snapshot) {
        if (prep.scope === 'instance' && prep.instanceId && !prep.skipFullSnapshot) await ensureFullSnapshot(prep.instanceId);
        action = await undo.begin({ conversationId: null, toolUseId, tool: name, instanceId: prep.scope === 'instance' ? prep.instanceId || null : null, serverId: prep.scope === 'server' ? prep.serverId || null : null, scope: prep.scope });
      }
      const r = await tool.run(prep, { conv, turn, signal, action, toolUseId });
      let undoId = null;
      if (action) {
        if (r.noChange) await undo.abort(action);
        else undoId = await undo.commit(action, { summary: r.summary });
      }
      activity.update(entry.id, { state: 'ok', summary: r.summary || '', warnings: r.warnings || [], undoId, noChange: Boolean(r.noChange), durationMs: now() - started });
      return textResult(clip(redact({ ok: true, ...(r.data || {}), ...(undoId ? { undo_available: true, undo_id: undoId } : {}) })), false);
    } catch (err) {
      if (action) {
        const warnings = await undo.abort(action).catch(() => []);
        if (warnings?.length) console.warn('[mcp] Reversion parcial:', warnings.join(' | '));
      }
      return failResult(entry, started, err, redact, signal);
    }
  }

  // ---------- Herramientas propias ----------
  async function launcherStatus(ctx) {
    const w = who(ctx);
    const started = now();
    const entry = activity.add({ kind: 'tool', tool: 'launcher_status', toolTitle: t('mcp.tool_launcher_status'), level: 'read', client: w.name, source: w.source, input: {} });
    const redact = await currentRedactor();
    try {
      const info = await statusInfo();
      const all = await undo.list().catch(() => []);
      const undoable = all.filter((e) => e.state === 'active' && String(e.toolUseId || '').startsWith(UNDO_PREFIX)).length;
      activity.update(entry.id, { state: 'ok', summary: t('mcp.sumStatus'), durationMs: now() - started });
      return textResult(clip(redact({ ok: true, ...info, undo: { available_changes: undoable } })), false);
    } catch (err) {
      return failResult(entry, started, err, redact, ctx.signal);
    }
  }

  async function undoChange(undoId, { fromUi = false } = {}) {
    const r = await agent.undoAction(undoId);
    const prev = activity.byUndoId(undoId);
    if (prev) activity.update(prev.id, { state: 'undone', undoneAt: now(), undoneFromUi: fromUi });
    return r;
  }

  async function undoLast(input, ctx) {
    const w = who(ctx);
    const started = now();
    const signal = ctx.signal;
    const entry = activity.add({ kind: 'tool', tool: 'undo_last_action', toolTitle: t('mcp.tool_undo_last_action'), level: 'reversible', client: w.name, source: w.source, input: shortInput(input) });
    const redact = await currentRedactor();
    try {
      let undoId = typeof input.undo_id === 'string' && input.undo_id.trim() ? input.undo_id.trim() : null;
      if (undoId) {
        const e = await undo.get(undoId).catch(() => null);
        if (!e || !String(e.toolUseId || '').startsWith(UNDO_PREFIX)) throw new ToolError(t('mcp.errUndoNotMcp'), 'undo');
      } else {
        const all = await undo.list();
        const last = all.filter((e) => e.state === 'active' && String(e.toolUseId || '').startsWith(UNDO_PREFIX)).pop();
        if (!last) throw new ToolError(t('mcp.errUndoNothing'), 'undo');
        undoId = last.id;
      }
      // Deshacer una creacion manda la instancia entera a la papelera (con lo que se cambio despues, tambien
      // desde el Asistente o a mano): es destructivo y espera la confirmacion del usuario en el launcher.
      const target = await undo.get(undoId).catch(() => null);
      if (target?.scope === 'create' || target?.scope === 'servercreate') {
        const isServer = target.scope === 'servercreate';
        const inst = isServer ? await require('../../core/servers').get(target.serverId).catch(() => null) : await instances.get(target.instanceId).catch(() => null);
        activity.update(entry.id, { state: 'pending' });
        ctx.progress?.(t('mcp.progressApproval'));
        const answer = await approvals.request(
          { kind: 'destructive', tool: 'undo_last_action', title: t(isServer ? 'mcp.approveUndoCreateServerTitle' : 'mcp.approveUndoCreateTitle'), message: t(isServer ? 'mcp.approveUndoCreateServerText' : 'mcp.approveUndoCreateText', { client: w.name, name: inst?.name || target.serverId || target.instanceId }), okText: t('mcp.approveUndoCreateOk'), danger: true, client: w.name, source: w.source },
          { signal },
        );
        if (answer !== 'approved') throw declinedError(answer);
        activity.update(entry.id, { state: 'running' });
      }
      const r = await undoChange(undoId);
      activity.update(entry.id, { state: 'ok', summary: r.message || t('mcp.sumUndone'), warnings: r.warnings || [], durationMs: now() - started });
      return textResult(clip(redact({ ok: true, undone: r.message, undo_id: undoId, warnings: r.warnings || [] })), false);
    } catch (err) {
      return failResult(entry, started, err, redact, signal);
    }
  }

  // ---------- tools/call ----------
  async function callTool(name, args, ctx = {}) {
    await gate.ready();
    const w = who(ctx);
    if (!gate.entitled) {
      activity.add({ kind: 'blocked', tool: String(name).slice(0, 60), client: w.name, source: w.source, state: 'denied', summary: t('mcp.actBlocked') });
      return textResult({ ok: false, error: planMessage(), plan_required: 'go' }, true);
    }
    const level = levelOf(name);
    if (!level || !definitions().some((d) => d.name === name)) throw new ProtocolError(ERR.INVALID_PARAMS, `Unknown tool: ${String(name).slice(0, 80)}`);
    const v = validate(schemaOf(name), isObject(args) ? args : {});
    if (!v.ok) {
      const message = t('mcp.errBadInput', { errors: v.errors.slice(0, 6).join('; ') });
      activity.add({ kind: 'tool', tool: name, toolTitle: t(`mcp.tool_${name}`), level, client: w.name, source: w.source, state: 'error', error: message, summary: message, input: shortInput(args) });
      return textResult({ ok: false, error: message }, true);
    }
    if (rateLimited(level)) return textResult({ ok: false, error: t('mcp.errRate') }, true);
    if (name === 'launcher_status') return launcherStatus(ctx);
    if (name === 'undo_last_action') return withLock(() => undoLast(v.value, ctx), ctx.signal).catch((err) => textResult({ ok: false, error: err?.message || String(err) }, true));
    const tool = tools.REGISTRY[name];
    if (level === 'read') return execute(name, tool, level, v.value, ctx);
    return withLock(() => execute(name, tool, level, v.value, ctx), ctx.signal).catch((err) => textResult({ ok: false, error: err?.message || String(err) }, true));
  }

  /** Deshacer desde la interfaz (aviso "Deshacer" o la lista de actividad). */
  function undoFromUi(undoId) {
    return withLock(() => undoChange(undoId, { fromUi: true }));
  }

  /** Estado de Deshacer de las entradas de la actividad (por si se deshicieron desde el asistente). */
  async function refreshUndoStates(entries) {
    const ids = entries.filter((e) => e.undoId && e.state === 'ok').map((e) => e.undoId);
    if (!ids.length) return entries;
    const states = await undo.states(ids).catch(() => ({}));
    for (const e of entries) {
      if (e.undoId && e.state === 'ok' && (states[e.undoId] === 'undone' || states[e.undoId] === 'expired')) {
        e.undoState = states[e.undoId];
        if (states[e.undoId] === 'undone') {
          e.state = 'undone';
          activity.update(e.id, { state: 'undone' });
        }
      }
    }
    return entries;
  }

  return { listTools, callTool, definitions, invalidate, undoFromUi, refreshUndoStates, planMessage, levelOf, conv };
}

module.exports = { createExecutor, clientLabel, shortInput, clip, EXTRA, UNDO_PREFIX, MAX_RESULT, BULK_WINDOW_MS };
