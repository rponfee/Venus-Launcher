'use strict';
// Bucle del agente: una pregunta del usuario = un turno (turnId) que puede tener varias rondas de
// herramientas. Historial solo-agregar: los bloques del asistente se guardan exactamente como llegaron y
// cada ronda de tool_use recibe TODOS sus tool_result en un unico mensaje de usuario (is_error en las fallas).
// Limite de rondas, cancelacion con AbortController, confirmaciones en la interfaz sin auto-aprobar nunca.
// Modelo y esfuerzo: un turno usa un solo modelo en todas sus llamadas (el backend ata el turn_id al modelo
// de su primera llamada). Se recuerda la ultima eleccion por conversacion y global (settings.ai.
// assistantModel / assistantEffort); una conversacion puede cambiar de modelo entre preguntas.
const { t, getLanguage } = require('../../core/i18n');
const instances = require('../../core/instances');
const settings = require('../../core/settings');
const secure = require('../../core/secure');
const { uid } = require('../../core/util');
const store = require('./store');
const toolDefs = require('./tool-defs');
const { systemPrompt, externalPrompt } = require('./prompt');
const tools = require('./tools');
const config = require('./config');
const undo = require('./undo');
const { validate, ToolError } = require('./guards');
const { currentRedactor } = require('./redact');
const { modelOptions, fitChoice, normalizeModel, normalizeEffort } = require('./models');

const MAX_ROUNDS = 24;
const MAX_TOKENS = 16000;
const PLAN_TOKEN_LIMITS = Object.freeze({ basic: 12000, go: 16000, pro: 24000, max: 36000 });
function responseTokenLimit() {
  const quota = deps.ai?.cachedQuota?.();
  const limit = quota?.maxTokensPerRequest ?? PLAN_TOKEN_LIMITS[quota?.plan];
  return Number.isInteger(limit) && limit > 0 ? Math.min(limit, 36000) : MAX_TOKENS;
}
const EFFORT = 'medium';
const MAX_INPUT = 8000;
const MAX_RESULT = 24000;
const BULK_LIMIT = 4;
const CACHE_MAX = 20;
const SESSION_KEY = 'ui:sb.venus-auth'; // sesion de Supabase que guarda cloud.js (cifrada)

const deps = {
  ai: null, // { messages(opts), cachedQuota?(), provider?() } — modules/ai o un falso para pruebas
  send: () => {}, // (canal, ...args) hacia la interfaz
  optional: () => null, // carga perezosa de otros modulos (snapshots, crash, perf, compat, curseforge)
  user: currentUser, // () => id de la cuenta de Venus con la sesion abierta, o null
  snapshotTimeoutMs: 20000,
  // Servidores MCP que agrego el usuario (./mcp-servers): sus herramientas se suman en cada turno. null = ninguno
  mcp: null,
  // Motores externos (./engines): el Claude Code o el Codex del usuario responden en vez del backend. null = solo Venus IA
  engines: null,
};
const EXTERNAL_ENGINES = ['claude', 'chatgpt'];
const MCP_MAX_RESULT = 32000; // el texto ya viene recortado a 20 000 caracteres; esto deja lugar al JSON
const NO_MCP = Object.freeze({ defs: [], map: new Map(), skipped: [], truncated: false });

function configure(d = {}) {
  Object.assign(deps, Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined)));
}

const live = new Map(); // conversationId -> { conv, turn }
const confirms = new Map(); // requestId -> { convId, resolve(state) }
const loaded = new Map(); // conversationId -> conv (cache LRU de conversaciones abiertas)
const defsCache = new Map(); // hash -> { system, tools }
const saveTimers = new Map();

// ---------- Cuenta de Venus ----------
// Cada conversacion es de la cuenta de Venus que la empezo (conv.userId; null = sin sesion): otra cuenta que use
// el launcher en la misma PC no la ve ni la continua (con su cuota).
async function currentUser() {
  try {
    const raw = await secure.get(SESSION_KEY);
    const s = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return s?.access_token && s.user?.id ? String(s.user.id) : null;
  } catch {
    return null;
  }
}

// Las conversaciones de antes de guardar la cuenta (sin userId) las adopta la primera cuenta que las abre.
async function owns(conv, user) {
  if (conv.userId === undefined && user) {
    conv.userId = user;
    await store.save(conv, { touch: false });
  }
  return conv.userId === user;
}

// ---------- Conversaciones en memoria ----------
function remember(conv) {
  loaded.delete(conv.id);
  loaded.set(conv.id, conv);
  while (loaded.size > CACHE_MAX) {
    const oldest = [...loaded.keys()].find((id) => !live.has(id));
    if (!oldest) break;
    loaded.delete(oldest);
  }
}

async function getConv(id) {
  if (live.has(id)) return live.get(id).conv;
  if (loaded.has(id)) return loaded.get(id);
  const conv = await store.load(id);
  if (!conv) return null;
  if (repair(conv)) await store.save(conv);
  remember(conv);
  return conv;
}

// Si el launcher se cerro a mitad de un turno: cada tool_use sin respuesta recibe un tool_result de error
// (se agrega al final, nunca se edita lo anterior) y el turno queda marcado como interrumpido.
function repair(conv) {
  let changed = false;
  const last = conv.messages[conv.messages.length - 1];
  if (last && last.role === 'assistant' && Array.isArray(last.content)) {
    const uses = last.content.filter((b) => b && b.type === 'tool_use');
    if (uses.length) {
      conv.messages.push({ role: 'user', content: uses.map((u) => resultBlock(u.id, { ok: false, error: 'The launcher was closed before this tool ran. Nothing was changed.' }, true)) });
      changed = true;
    }
  }
  const starts = conv.events.filter((e) => e.type === 'turn-start');
  const lastStart = starts[starts.length - 1];
  if (lastStart && !conv.events.some((e) => e.type === 'done' && e.turnId === lastStart.turnId) && !live.has(conv.id)) {
    conv.events.push({ type: 'done', turnId: lastStart.turnId, stopReason: 'interrupted', seq: ++conv.seq, at: Date.now() });
    changed = true;
  }
  return changed;
}

function scheduleSave(conv) {
  if (saveTimers.has(conv.id)) return;
  saveTimers.set(
    conv.id,
    setTimeout(() => {
      saveTimers.delete(conv.id);
      store.save(conv).catch((err) => console.error('[assistant] No se pudo guardar la conversacion:', err.message));
    }, 400),
  );
}

async function flush(conv) {
  const timer = saveTimers.get(conv.id);
  if (timer) {
    clearTimeout(timer);
    saveTimers.delete(conv.id);
  }
  await store.save(conv).catch((err) => console.error('[assistant] No se pudo guardar la conversacion:', err.message));
}

function emit(conv, ev, { persist = true } = {}) {
  const e = { ...ev, seq: ++conv.seq, at: Date.now() };
  if (persist) {
    conv.events.push(e);
    scheduleSave(conv);
  }
  try {
    deps.send('assistant:event', conv.id, e);
  } catch {
    /* ventana cerrada */
  }
  return e;
}

// ---------- Definiciones congeladas por conversacion ----------
async function currentDefs() {
  const defs = { system: systemPrompt(), tools: toolDefs.build() };
  const hash = await store.saveDefs(defs);
  defsCache.set(hash, defs);
  return hash;
}

async function getDefs(conv) {
  if (conv.defs && defsCache.has(conv.defs)) return defsCache.get(conv.defs);
  let defs = conv.defs ? await store.loadDefs(conv.defs) : null;
  if (!defs) {
    conv.defs = await currentDefs();
    defs = defsCache.get(conv.defs);
  }
  defsCache.set(conv.defs, defs);
  return defs;
}

// Vista que se manda al modelo: el historial tal cual, salvo despues de una recuperacion por firmas de
// "thinking" invalidas (se quitan, de forma estable, los bloques de razonamiento anteriores a ese punto).
function requestView(conv) {
  const cut = conv.stripThinkingBefore;
  if (!cut) return conv.messages;
  const out = [];
  conv.messages.forEach((m, i) => {
    if (i >= cut || m.role !== 'assistant' || !Array.isArray(m.content)) {
      out.push(m);
      return;
    }
    const content = m.content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking');
    if (content.length) out.push({ ...m, content });
  });
  return out;
}

// ---------- Mensajes ----------
function makeTitle(text) {
  const line = String(text).replace(/[`*_#>[\]]/g, '').replace(/\s+/g, ' ').trim();
  if (line.length <= 60) return line;
  const cut = line.slice(0, 60);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > 30 ? cut.slice(0, sp) : cut).trim()}…`;
}

// Las notas llevan titulos de mods y nombres de instancias (datos ajenos): sin < ni > no pueden cerrar el
// bloque <launcher_context> y agregar texto que el modelo lea como del usuario.
function consumeNotes(conv) {
  const notes = conv.notes.splice(0, conv.notes.length);
  return notes.filter((n) => typeof n === 'string' && n).map((n) => n.replace(/[<>]/g, ''));
}

// extraNotes: avisos de este turno (por ejemplo, un servidor MCP que no respondio); sin < ni >, como las notas.
async function contextBlock(conv, instanceId, redact, extraNotes = []) {
  const lines = [];
  const s = await settings.get();
  lines.push(`launcher_language: ${s.language || getLanguage()}`);
  let inst = null;
  if (instanceId) inst = await instances.get(instanceId).catch(() => null);
  // El nombre viene del pack importado: < y > escapados (sigue siendo JSON valido) por la misma razon
  const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  lines.push(inst ? `selected_instance: ${json({ id: inst.id, name: inst.name, mc_version: inst.mcVersion, loader: inst.loader })}` : 'selected_instance: none');
  const notes = [...consumeNotes(conv), ...extraNotes.filter((n) => typeof n === 'string' && n).map((n) => n.replace(/[<>]/g, ''))];
  if (notes.length) lines.push('notes:', ...notes.map((n) => `- ${n}`));
  return { text: `<launcher_context>\n${redact(lines.join('\n'))}\n</launcher_context>`, inst };
}

function resultBlock(toolUseId, payload, isError, max = MAX_RESULT) {
  let content;
  try {
    content = JSON.stringify(payload);
  } catch {
    content = JSON.stringify({ ok: false, error: 'Unserializable result' });
  }
  // Resultado demasiado grande: se recorta, pero sigue siendo JSON valido
  if (content.length > max) content = JSON.stringify({ truncated: true, note: 'The result was too large and was cut. Use filters or pagination to see the rest.', partial: content.slice(0, max - 300) });
  return { type: 'tool_result', tool_use_id: toolUseId, content, ...(isError ? { is_error: true } : {}) };
}

// Entrada de la herramienta resumida para la interfaz (sin textos largos).
function uiInput(input) {
  const out = {};
  for (const [k, v] of Object.entries(input || {})) {
    if (typeof v === 'string') out[k] = v.length > 160 ? `${v.slice(0, 159)}…` : v;
    else if (Array.isArray(v)) out[k] = v.slice(0, 20).map((x) => (typeof x === 'string' ? x.slice(0, 80) : x));
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

// ---------- Errores de la IA ----------
function coded(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesTemplate(msg, key) {
  const raw = t(key);
  if (raw === key) return false;
  if (!raw.includes('{')) return msg === raw;
  return new RegExp(`^${raw.split(/\{\w+\}/).map(escapeRe).join('[\\s\\S]*')}$`).test(msg);
}

// { code, message } + reason / model / effort / resetAt cuando el error de modules/ai los trae (cuota y plan).
// code: unavailable | session | noplan | plan | quota | backend | refused | network | ratelimit | error
function classify(err) {
  const message = err?.message || String(err);
  const is = (...keys) => keys.some((k) => matchesTemplate(message, k));
  const extra = {};
  for (const k of ['reason', 'model', 'effort', 'resetAt']) if (typeof err?.[k] === 'string' && err[k]) extra[k] = err[k];
  const KNOWN = ['unavailable', 'session', 'noplan', 'plan', 'quota', 'backend', 'refused', 'network', 'ratelimit', 'error', 'engine', 'engineLogin', 'engineLimit', 'engineMissing', 'engineTimeout'];
  if (err?.code && KNOWN.includes(err.code)) return { code: err.code, message, ...extra };
  let code = 'error';
  if (is('ai.errUnavailable', 'ai.errSignIn', 'ai.errNoCloud', 'ai.errUnconfirmed', 'ai.errAnonymous')) code = 'unavailable';
  else if (is('ai.errSession')) code = 'session';
  else if (is('ai.errNoPlan')) code = 'noplan';
  else if (is('ai.errPlan', 'ai.errPlanModel', 'ai.errPlanEffort')) code = 'plan';
  else if (is('ai.errQuota', 'ai.errQuotaDaily', 'ai.errQuotaWeekly', 'ai.errQuotaBudget', 'ai.errQuotaTurn')) code = 'quota';
  else if (is('ai.errBackendMissing')) code = 'backend';
  else if (is('ai.errRefused')) code = 'refused';
  else if (is('ai.errNetwork')) code = 'network';
  else if (is('ai.errQuotaRate', 'ai.errBusy')) code = 'ratelimit';
  return { code, message, ...extra };
}

function isThinkingSignatureError(err) {
  return /signature|bound to a different conversation|thinking.?block/i.test(err?.message || '');
}

// ---------- Confirmaciones ----------
// payload.allowAlways: la interfaz ofrece "Permitir siempre" (herramientas MCP); si el usuario lo elige, out.always.
function requestConfirm(conv, turn, payload, out = null) {
  return new Promise((resolve) => {
    const requestId = `r${uid(12)}`;
    let done = false;
    const finish = (state, extra = {}) => {
      if (done) return;
      done = true;
      confirms.delete(requestId);
      const always = state === 'approved' && extra.always === true;
      if (out && always) out.always = true;
      emit(conv, { type: 'confirm', turnId: turn.id, requestId, state, ...(always ? { always: true } : {}) });
      flush(conv);
      resolve(state === 'approved');
    };
    confirms.set(requestId, { convId: conv.id, resolve: finish, allowAlways: payload.allowAlways === true });
    emit(conv, { type: 'confirm', turnId: turn.id, requestId, state: 'pending', ...payload });
    flush(conv);
    const signal = turn.controller.signal;
    if (signal.aborted) finish('cancelled');
    else signal.addEventListener('abort', () => finish('cancelled'), { once: true });
  });
}

// opts.always: "Permitir siempre" (solo en las confirmaciones que lo ofrecen).
function confirm(requestId, approved, opts = {}) {
  const c = confirms.get(requestId);
  if (!c) throw new Error(t('assistant.errConfirmGone'));
  const always = approved === true && opts?.always === true && c.allowAlways;
  c.resolve(approved === true ? 'approved' : 'denied', always ? { always: true } : {});
  return true;
}

// ---------- Snapshot completo (modulo de instantaneas) ----------
async function ensureFullSnapshot(conv, instanceId) {
  if (conv.fullSnapshots[instanceId] !== undefined || conv.createdInstances.includes(instanceId)) return;
  conv.fullSnapshots[instanceId] = false;
  const snaps = deps.optional('snapshots');
  if (!snaps || typeof snaps.create !== 'function') return;
  try {
    const r = await Promise.race([snaps.create(instanceId, { reason: t('assistant.snapshotReason'), worlds: 'none' }), new Promise((res) => setTimeout(() => res(null), deps.snapshotTimeoutMs))]);
    conv.fullSnapshots[instanceId] = (r && (r.id || r)) || false;
  } catch (err) {
    console.warn('[assistant] No se pudo crear la instantanea completa:', err.message);
  }
}

// ---------- Herramientas ----------
async function projectTitles(ids) {
  const mr = ids.filter((x) => !/^cf:/i.test(x));
  if (!mr.length) return ids;
  try {
    const modrinth = require('../../core/modrinth');
    const list = await Promise.race([modrinth.getProjects(mr), new Promise((r) => setTimeout(() => r([]), 4000))]);
    return ids.map((id) => list.find((p) => p.id === id || p.slug === id)?.title || id);
  } catch {
    return ids;
  }
}

// Guarda para el punto 3 de la especificacion: 4 o mas instalaciones en un mismo turno sobre una instancia que
// ya existia antes de la conversacion -> confirmacion en la interfaz antes de instalar.
async function bulkGuard(conv, turn, entries) {
  const byInst = new Map();
  for (const e of entries) {
    if (!tools.INSTALL_TOOLS.has(e.u.name) || !e.tool || !e.level || e.invalid) continue;
    const id = e.input.instance_id;
    if (typeof id !== 'string') continue;
    if (!byInst.has(id)) byInst.set(id, []);
    byInst.get(id).push(e);
  }
  for (const [instId, list] of byInst) {
    const before = turn.installs.get(instId) || 0;
    turn.installs.set(instId, before + list.length);
    if (turn.bulkApproved.has(instId) || before + list.length < BULK_LIMIT) continue;
    const inst = await tools.getInstance(instId).catch(() => null);
    if (!inst) continue;
    const existedBefore = !conv.createdInstances.includes(instId) && (inst.created || 0) < conv.createdAt;
    if (!existedBefore) continue;
    const titles = await projectTitles(list.map((e) => String(e.input.project_id || '?')));
    const ok = await requestConfirm(conv, turn, {
      kind: 'bulk',
      tool: list[0].u.name,
      title: t('assistant.confirmBulkTitle'),
      message: t('assistant.confirmBulkText', { count: before + list.length, name: inst.name }),
      items: titles,
      okText: t('assistant.confirmBulkOk'),
      danger: false,
    });
    if (ok) turn.bulkApproved.add(instId);
    else {
      for (const e of list) e.denied = 'bulk';
      turn.installs.set(instId, before);
    }
  }
}

function genericConfirm(name) {
  return { kind: 'destructive', title: t('assistant.confirmGenericTitle'), message: t('assistant.confirmGenericText', { tool: name }), danger: true };
}

// ---------- Herramientas MCP (servidores que agrego el usuario) ----------
// Pide confirmacion en el launcher salvo que sea de solo lectura (readOnlyHint) o "Permitir siempre"; el
// resultado (recortado y marcado como no confiable por mcp-servers) pasa por el anonimizador como todos.
async function runMcp(conv, turn, e, redact) {
  const { u, mcp: entry } = e;
  const signal = turn.controller.signal;
  const info = entry ? { server: entry.server.name, serverId: entry.server.id, tool: entry.tool.name, title: entry.tool.title || null, readOnly: entry.tool.readOnly === true } : { server: null, tool: String(u.name).slice(0, 80) };
  const fail = (message, extra = {}) => {
    emit(conv, { type: 'tool-result', turnId: turn.id, toolUseId: u.id, name: u.name, ok: false, error: message, summary: message, declined: Boolean(extra.user_declined), mcp: info });
    return resultBlock(u.id, redact({ ok: false, error: message, ...extra }), true);
  };
  emit(conv, { type: 'tool-start', turnId: turn.id, toolUseId: u.id, name: u.name, level: e.level || 'mcp', input: uiInput(e.input), mcp: info });
  if (!entry || !deps.mcp) return fail(t('assistant.mcpErrToolGone', { name: String(u.name).slice(0, 80) }));
  if (e.invalid) return fail(t('assistant.errBadInput', { errors: e.invalid }));
  if (signal.aborted) return fail(t('assistant.errCancelledBefore'));
  try {
    if (!entry.tool.readOnly && !(await deps.mcp.isAlwaysAllowed(entry.server.id, entry.tool.name))) {
      const out = {};
      const ok = await requestConfirm(
        conv,
        turn,
        {
          kind: 'mcp',
          toolUseId: u.id,
          tool: u.name,
          title: t('assistant.mcpConfirmTitle', { server: entry.server.name }),
          message: t('assistant.mcpConfirmText', { tool: entry.tool.title || entry.tool.name, server: entry.server.name }),
          items: deps.mcp.argLines(e.input),
          okText: t('assistant.mcpConfirmOk'),
          danger: entry.tool.destructive === true,
          allowAlways: true,
          mcp: info,
        },
        out,
      );
      if (!ok) throw new ToolError(signal.aborted ? t('assistant.errCancelledBefore') : t('assistant.errUserDeclined'), 'declined');
      if (out.always) await deps.mcp.setAlwaysAllow(entry.server.id, entry.tool.name, true).catch((err) => console.warn('[assistant] Permitir siempre:', err?.message || err));
    }
    if (signal.aborted) throw new ToolError(t('assistant.errCancelledBefore'), 'cancelled');
    const r = await deps.mcp.call(entry, e.input, { signal });
    const summary = r.isError ? t('assistant.mcpResultError') : r.truncated ? t('assistant.mcpResultCut', { total: r.chars, max: deps.mcp.LIMITS.resultChars }) : t('assistant.mcpResult', { count: r.chars });
    emit(conv, { type: 'tool-result', turnId: turn.id, toolUseId: u.id, name: u.name, ok: !r.isError, summary, ...(r.isError ? { error: summary } : {}), warnings: [], undoId: null, noChange: false, mcp: info });
    return resultBlock(u.id, redact(r.payload), r.isError, MCP_MAX_RESULT);
  } catch (err) {
    const declined = err instanceof ToolError && err.code === 'declined';
    let message = err?.message || String(err);
    if (!(err instanceof ToolError)) {
      if (signal.aborted || err?.code === 'aborted') message = t('assistant.errCancelled');
      else console.warn(`[assistant] ${u.name}:`, message);
    }
    return fail(message, declined ? { user_declined: true } : {});
  }
}

async function mcpToolsForTurn(conv, turn) {
  if (!deps.mcp) return NO_MCP;
  try {
    const r = await deps.mcp.toolsForTurn();
    if (r?.skipped?.length) emit(conv, { type: 'notice', turnId: turn.id, kind: 'mcp', text: t('assistant.mcpSkipped', { count: r.skipped.length, servers: r.skipped.map((s) => `«${s.name}»`).join(', ') }), details: r.skipped.map((s) => ({ name: s.name, error: s.error })) });
    return r && Array.isArray(r.defs) && r.map instanceof Map ? r : NO_MCP;
  } catch (err) {
    console.warn('[assistant] Herramientas MCP:', err?.message || err);
    return NO_MCP;
  }
}

async function runOne(conv, turn, e, redact) {
  const { u } = e;
  const signal = turn.controller.signal;
  const fail = (message, extra = {}) => {
    emit(conv, { type: 'tool-result', turnId: turn.id, toolUseId: u.id, name: u.name, ok: false, error: message, summary: message, declined: Boolean(extra.user_declined) });
    return resultBlock(u.id, redact({ ok: false, error: message, ...extra }), true);
  };
  if (!e.tool) {
    emit(conv, { type: 'tool-start', turnId: turn.id, toolUseId: u.id, name: u.name, level: 'read', input: {} });
    return fail(t('assistant.errUnknownTool', { name: String(u.name).slice(0, 60) }));
  }
  emit(conv, { type: 'tool-start', turnId: turn.id, toolUseId: u.id, name: u.name, level: e.level || 'read', input: uiInput(e.input) });
  if (!e.level) return fail(t('assistant.errToolDisabled', { name: u.name }));
  if (e.invalid) return fail(t('assistant.errBadInput', { errors: e.invalid }));
  if (signal.aborted) return fail(t('assistant.errCancelledBefore'));
  if (e.denied === 'bulk') return fail(t('assistant.errBulkDeclined'), { user_declined: true });

  let action = null;
  try {
    const prep = await e.tool.prepare(e.input, { conv, turn, signal });
    const needsConfirm = prep.confirm || (e.level === 'destructive' ? genericConfirm(u.name) : null);
    if (needsConfirm) {
      const ok = await requestConfirm(conv, turn, { ...needsConfirm, toolUseId: u.id, tool: u.name });
      if (!ok) throw new ToolError(signal.aborted ? t('assistant.errCancelledBefore') : t('assistant.errUserDeclined'), 'declined');
    }
    if (signal.aborted) throw new ToolError(t('assistant.errCancelledBefore'), 'cancelled');
    const snapshot = prep.scope && (e.tool.minLevel === 'reversible' || e.level === 'reversible');
    if (snapshot) {
      if (prep.scope === 'instance' && prep.instanceId && !prep.skipFullSnapshot) await ensureFullSnapshot(conv, prep.instanceId);
      action = await undo.begin({ conversationId: conv.id, toolUseId: u.id, tool: u.name, instanceId: prep.scope === 'instance' ? prep.instanceId || null : null, serverId: prep.scope === 'server' ? prep.serverId || null : null, scope: prep.scope });
    }
    const r = await e.tool.run(prep, { conv, turn, signal, action, toolUseId: u.id });
    let undoId = null;
    if (action) {
      if (r.noChange) await undo.abort(action);
      else undoId = await undo.commit(action, { summary: r.summary });
    }
    emit(conv, { type: 'tool-result', turnId: turn.id, toolUseId: u.id, name: u.name, ok: true, summary: r.summary || '', warnings: r.warnings || [], undoId, noChange: Boolean(r.noChange) });
    return resultBlock(u.id, redact({ ok: true, ...(r.data || {}), ...(undoId ? { undo_available: true } : {}) }), false);
  } catch (err) {
    if (action) {
      const w = await undo.abort(action).catch(() => []);
      if (w?.length) console.warn('[assistant] Reversion parcial:', w.join(' | '));
    }
    const declined = err instanceof ToolError && err.code === 'declined';
    let message = err?.message || String(err);
    if (!(err instanceof ToolError)) {
      if (signal.aborted) message = t('assistant.errCancelled');
      else console.warn(`[assistant] ${u.name}:`, message);
    }
    return fail(message, { ...(declined ? { user_declined: true } : {}), ...(err?.data ? { details: err.data } : {}) });
  }
}

async function executeBatch(conv, turn, uses, redact) {
  const defs = await getDefs(conv);
  const schemas = new Map((defs.tools || []).map((d) => [d.name, d.input_schema]));
  const entries = uses.map((u) => {
    // Herramienta de un servidor MCP: solo las de este turno (una de otro turno ya no esta disponible)
    if (deps.mcp && deps.mcp.isMcpName(u.name)) {
      const entry = turn.mcp?.map.get(u.name) || null;
      const invalid = entry ? deps.mcp.checkInput(entry.def.input_schema, u.input ?? {}) : null;
      return { u, mcp: entry, isMcp: true, tool: null, level: entry ? (entry.tool.readOnly ? 'read' : 'mcp') : null, input: u.input && typeof u.input === 'object' ? u.input : {}, invalid };
    }
    const tool = tools.REGISTRY[u.name] || null;
    const level = tool ? config.effectiveLevel(u.name, tool.minLevel) : null;
    const schema = schemas.get(u.name) || toolDefs.build().find((d) => d.name === u.name)?.input_schema;
    const v = validate(schema, u.input ?? {});
    return { u, tool, level, input: v.ok ? v.value : u.input || {}, invalid: v.ok ? null : v.errors.slice(0, 6).join('; ') };
  });
  await bulkGuard(conv, turn, entries);
  const results = new Array(entries.length);
  const run = (e) => (e.isMcp ? runMcp(conv, turn, e, redact) : runOne(conv, turn, e, redact));
  // Lecturas en paralelo; cambios (y herramientas MCP que piden permiso) de a uno y en orden: evita carreras
  // sobre la misma instancia y confirmaciones superpuestas
  await Promise.all(entries.map(async (e, i) => {
    if (e.level === 'read' || !e.level || (!e.tool && !e.isMcp)) results[i] = await run(e);
  }));
  for (let i = 0; i < entries.length; i++) {
    if (!results[i]) results[i] = await run(entries[i]);
  }
  return results;
}

// ---------- Turno ----------
async function runTurn(conv, turn) {
  const signal = turn.controller.signal;
  let rounds = 0;
  let outcome = 'end_turn';
  let stripRetried = false;
  try {
    const redact = await currentRedactor();
    // Primero se muestra la pregunta: listar las herramientas MCP puede tardar (un servidor local que arranca)
    const inst = turn.instanceId ? await instances.get(turn.instanceId).catch(() => null) : null;
    emit(conv, { type: 'turn-start', turnId: turn.id, text: turn.text, instanceId: inst?.id || null, instanceName: inst?.name || null, model: turn.model, effort: turn.effort });
    turn.mcp = await mcpToolsForTurn(conv, turn);
    const mcpNotes = turn.mcp.skipped.map((s) => `The MCP server "${s.name}" that the user connected did not answer, so its tools are not available in this question.`);
    const ctx = await contextBlock(conv, turn.instanceId, redact, mcpNotes);
    conv.messages.push({ role: 'user', content: [{ type: 'text', text: ctx.text }, { type: 'text', text: turn.text }] });
    await flush(conv);

    for (;;) {
      if (signal.aborted) {
        outcome = 'cancelled';
        break;
      }
      emit(conv, { type: 'thinking', turnId: turn.id, active: true }, { persist: false });
      let res;
      try {
        const defs = await getDefs(conv);
        // Las herramientas MCP van despues de las propias (las mismas en todas las llamadas del turno)
        const turnTools = turn.mcp?.defs.length ? [...defs.tools, ...turn.mcp.defs] : defs.tools;
        // El mismo modelo y esfuerzo en todas las llamadas del turno (model undefined = el primero del plan)
        res = await deps.ai.messages({ system: defs.system, messages: requestView(conv), tools: turnTools, turnId: turn.id, maxTokens: responseTokenLimit(), model: turn.model || undefined, effort: turn.effort || EFFORT, signal });
      } catch (err) {
        if (signal.aborted) {
          outcome = 'cancelled';
          break;
        }
        // Firma de "thinking" rechazada (historial alterado o de otro modelo): una sola vez, se reintenta sin
        // los bloques de razonamiento anteriores (recuperacion documentada por la API).
        if (!stripRetried && isThinkingSignatureError(err)) {
          stripRetried = true;
          conv.stripThinkingBefore = conv.messages.length;
          console.warn('[assistant] Firma de thinking rechazada; se reintenta sin el razonamiento anterior.');
          continue;
        }
        const info = classify(err);
        emit(conv, { type: 'error', turnId: turn.id, ...info });
        outcome = 'error';
        break;
      }
      if (typeof res.model === 'string' && res.model) turn.servedBy = res.model;
      // Respondio el proveedor de respaldo (OpenAI) porque el principal fallo: la interfaz lo avisa con una nota
      const failover = res.served_by?.failover === true;
      if (failover) turn.failover = true;
      if (res.quota) emit(conv, { type: 'quota', quota: res.quota }, { persist: false });
      const u = res.usage || {};
      conv.usage.input += Number(u.input_tokens) || 0;
      conv.usage.output += Number(u.output_tokens) || 0;
      conv.usage.cacheRead += Number(u.cache_read_input_tokens) || 0;
      conv.usage.requests += 1;

      const content = Array.isArray(res.content) ? res.content : [];
      // Los bloques se guardan exactamente como llegaron (un mensaje vacio no se puede reenviar: se omite)
      if (content.length) conv.messages.push({ role: 'assistant', content });
      const uses = content.filter((b) => b && b.type === 'tool_use');
      const text = content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n\n')
        .trim();
      const cut = res.stop_reason === 'max_tokens' || res.stop_reason === 'model_context_window_exceeded';
      if (text) emit(conv, { type: 'text', turnId: turn.id, text, truncated: cut && !uses.length, ...(failover ? { failover: true } : {}) });

      if (uses.length) {
        let results;
        if (cut) {
          // Respuesta cortada: los tool_use pueden estar incompletos, no se ejecutan
          results = uses.map((x) => {
            emit(conv, { type: 'tool-start', turnId: turn.id, toolUseId: x.id, name: x.name, level: 'read', input: {} });
            const msg = t('assistant.errTruncatedCall');
            emit(conv, { type: 'tool-result', turnId: turn.id, toolUseId: x.id, name: x.name, ok: false, error: msg, summary: msg });
            return resultBlock(x.id, { ok: false, error: 'Your previous answer was cut off before this tool call was complete, so it was NOT executed. Retry it with a shorter answer.' }, true);
          });
        } else {
          results = await executeBatch(conv, turn, uses, await currentRedactor());
        }
        const notes = consumeNotes(conv);
        const extra = notes.length ? [{ type: 'text', text: `<launcher_context>\n${redact(`notes:\n${notes.map((n) => `- ${n}`).join('\n')}`)}\n</launcher_context>` }] : [];
        conv.messages.push({ role: 'user', content: [...results, ...extra] });
        await flush(conv);
        rounds++;
        if (signal.aborted) {
          outcome = 'cancelled';
          break;
        }
        if (res.stop_reason === 'model_context_window_exceeded') {
          emit(conv, { type: 'error', turnId: turn.id, code: 'context', message: t('assistant.errContext') });
          outcome = 'context';
          break;
        }
        if (rounds >= MAX_ROUNDS) {
          emit(conv, { type: 'error', turnId: turn.id, code: 'rounds', message: t('assistant.errRounds', { count: MAX_ROUNDS }) });
          outcome = 'rounds';
          break;
        }
        continue;
      }
      await flush(conv);
      if (res.stop_reason === 'pause_turn') {
        rounds++;
        if (rounds >= MAX_ROUNDS) {
          emit(conv, { type: 'error', turnId: turn.id, code: 'rounds', message: t('assistant.errRounds', { count: MAX_ROUNDS }) });
          outcome = 'rounds';
          break;
        }
        continue;
      }
      if (res.stop_reason === 'model_context_window_exceeded') {
        emit(conv, { type: 'error', turnId: turn.id, code: 'context', message: t('assistant.errContext') });
        outcome = 'context';
        break;
      }
      outcome = res.stop_reason || 'end_turn';
      break;
    }
  } catch (err) {
    console.error('[assistant] Error en el turno:', err);
    emit(conv, { type: 'error', turnId: turn.id, code: 'error', message: err?.message || String(err) });
    outcome = 'error';
  } finally {
    for (const [, c] of confirms) if (c.convId === conv.id) c.resolve('cancelled');
    conv.lastTurn = { id: turn.id, state: outcome, at: Date.now() };
    emit(conv, { type: 'done', turnId: turn.id, stopReason: outcome, rounds, model: turn.model, effort: turn.effort, servedBy: turn.servedBy || null, failover: turn.failover === true });
    await flush(conv);
  }
  return outcome;
}

// ---------- Turno con un motor externo (el Claude Code o el Codex del usuario) ----------
// El CLI del usuario lleva el bucle de herramientas; Venus le da el prompt (contexto + pregunta), su prompt de
// sistema y su servidor MCP local como unica herramienta, y traduce la salida del CLI a los mismos eventos de la
// interfaz (text, tool-start, tool-result, error, done). El resumen, los avisos y el Deshacer de cada herramienta
// salen de la Actividad MCP, que el servidor registra al ejecutarla. La sesion del CLI (conv.external.sessionId)
// continua la conversacion en las preguntas siguientes.
function externalLevel(name) {
  const reg = tools.REGISTRY[name];
  if (reg) return config.effectiveLevel(name, reg.minLevel) || reg.minLevel || 'read';
  return name === 'undo_last_action' ? 'reversible' : 'read';
}

function parseToolJson(text) {
  try {
    const v = JSON.parse(String(text || ''));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

async function runExternalTurn(conv, turn) {
  const eng = deps.engines;
  const mcp = deps.optional('mcp');
  const engine = conv.engine;
  const app = eng?.APP_NAME?.[engine] || engine;
  const { signal } = turn.controller;
  let outcome = 'error';
  const texts = [];
  try {
    const redact = await currentRedactor();
    const inst = turn.instanceId ? await instances.get(turn.instanceId).catch(() => null) : null;
    emit(conv, { type: 'turn-start', turnId: turn.id, text: turn.text, instanceId: inst?.id || null, instanceName: inst?.name || null, model: turn.model, effort: turn.effort, engine });
    if (!eng || !mcp || typeof mcp.localEndpoint !== 'function') throw coded('engine', t('assistant.errEngineUnavailable'));
    const ctx = await contextBlock(conv, turn.instanceId, redact);
    conv.messages.push({ role: 'user', content: [{ type: 'text', text: ctx.text }, { type: 'text', text: turn.text }] });
    await flush(conv);
    emit(conv, { type: 'thinking', turnId: turn.id, active: true }, { persist: false });
    // Servidor MCP local del launcher (arranca si hace falta; exige plan Go o superior)
    const endpoint = await mcp.localEndpoint();
    const startedAt = Date.now();
    const starts = new Map(); // toolUseId -> { name, at }
    const used = new Set(); // entradas de la actividad ya asociadas a un resultado
    const activityFor = (name, since) => {
      const list = (typeof mcp.activitySince === 'function' ? mcp.activitySince(since - 1500) : []).filter((e) => e.kind === 'tool' && e.tool === name && e.state !== 'running' && e.state !== 'pending' && !used.has(e.id)).sort((a, b) => a.at - b.at);
      const hit = list[0] || null;
      if (hit) used.add(hit.id);
      return hit;
    };
    const r = await eng.runTurn({
      engine,
      prompt: `${ctx.text}\n\n${turn.text}`,
      system: externalPrompt({ app, provider: eng.PROVIDER_NAME?.[engine] }),
      mcpUrl: endpoint.url,
      model: turn.model,
      effort: turn.effort,
      sessionId: conv.external?.sessionId || null,
      maxTurns: MAX_ROUNDS,
      signal,
      onEvent: (ev) => {
        switch (ev.type) {
          case 'session':
            if (ev.id) {
              conv.external = { ...(conv.external || {}), sessionId: ev.id };
              scheduleSave(conv);
            }
            if (ev.model) turn.servedBy = ev.model;
            break;
          case 'model':
            if (ev.model) turn.servedBy = ev.model;
            break;
          case 'text':
            texts.push(ev.text);
            emit(conv, { type: 'text', turnId: turn.id, text: ev.text });
            break;
          case 'tool-start': {
            const name = eng.toolShortName(ev.name);
            starts.set(ev.toolUseId, { name, at: Date.now() });
            emit(conv, { type: 'tool-start', turnId: turn.id, toolUseId: ev.toolUseId, name, level: externalLevel(name), input: uiInput(ev.input) });
            break;
          }
          case 'tool-result': {
            const s = starts.get(ev.toolUseId);
            const name = s?.name || eng.toolShortName(ev.name);
            const act = activityFor(name, s?.at || startedAt);
            const payload = parseToolJson(ev.text);
            const ok = !ev.isError && payload?.ok !== false && act?.state !== 'error' && act?.state !== 'denied';
            const error = ok ? null : payload?.error || act?.error || (ev.isError && ev.text ? String(ev.text).slice(0, 300) : t('assistant.errEngineTool'));
            emit(conv, {
              type: 'tool-result',
              turnId: turn.id,
              toolUseId: ev.toolUseId,
              name,
              ok,
              error,
              summary: act?.summary || (ok ? '' : error),
              warnings: Array.isArray(act?.warnings) ? act.warnings : [],
              undoId: act?.undoId || (typeof payload?.undo_id === 'string' ? payload.undo_id : null),
              noChange: Boolean(act?.noChange),
              declined: act?.state === 'denied' || /declined|did not confirm|no confirm/i.test(String(error || '')),
            });
            break;
          }
          case 'limits':
            emit(conv, { type: 'limits', turnId: turn.id, engine, fiveHour: ev.fiveHour, sevenDay: ev.sevenDay, fiveHourResetsAt: ev.fiveHourResetsAt, sevenDayResetsAt: ev.sevenDayResetsAt }, { persist: false });
            break;
          case 'mcp-failed':
            emit(conv, { type: 'notice', turnId: turn.id, kind: 'engine', text: t('assistant.engineMcpFailed', { app }) });
            break;
          default:
            break;
        }
      },
    });
    if (r.sessionId) conv.external = { ...(conv.external || {}), sessionId: r.sessionId };
    if (r.model) turn.servedBy = r.model;
    const u = r.usage || {};
    conv.usage.input += Number(u.input_tokens) || 0;
    conv.usage.output += Number(u.output_tokens) || 0;
    conv.usage.cacheRead += Number(u.cache_read_input_tokens ?? u.cached_input_tokens) || 0;
    conv.usage.requests += 1;
    if (texts.length) conv.messages.push({ role: 'assistant', content: [{ type: 'text', text: texts.join('\n\n') }] });
    if (r.outcome === 'cancelled') outcome = 'cancelled';
    else if (r.outcome === 'rounds') {
      emit(conv, { type: 'error', turnId: turn.id, code: 'rounds', message: t('assistant.errRounds', { count: MAX_ROUNDS }) });
      outcome = 'rounds';
    } else if (r.outcome === 'error') {
      const detail = String(r.error || '').trim();
      const message = { engineLogin: t('assistant.errEngineLogin', { app }), engineLimit: t('assistant.errEngineLimit', { app, detail }), engineMissing: t('assistant.errEngineMissing', { app }), engineTimeout: t('assistant.errEngineTimeout', { app }) }[r.code] || t('assistant.errEngine', { app, detail });
      emit(conv, { type: 'error', turnId: turn.id, code: r.code || 'engine', message });
      outcome = 'error';
    } else outcome = 'end_turn';
  } catch (err) {
    if (signal.aborted) outcome = 'cancelled';
    else {
      console.error('[assistant] Turno externo:', err);
      const code = err?.code === 'plan' ? 'noplan' : err?.code === 'unavailable' || err?.code === 'disabled' ? 'engine' : err?.code || 'engine';
      emit(conv, { type: 'error', turnId: turn.id, code, message: err?.message || String(err) });
      outcome = 'error';
    }
  } finally {
    conv.lastTurn = { id: turn.id, state: outcome, at: Date.now() };
    emit(conv, { type: 'done', turnId: turn.id, stopReason: outcome, rounds: 0, model: turn.model, effort: turn.effort, servedBy: turn.servedBy || null, failover: false, engine });
    await flush(conv);
  }
  return outcome;
}

// Motor de una conversacion nueva: el pedido de la interfaz o el elegido en Ajustes (settings.ai.engine).
async function pickEngine(opts) {
  const s = await settings.get();
  const want = typeof opts?.engine === 'string' ? opts.engine : s.ai?.engine;
  return EXTERNAL_ENGINES.includes(want) ? want : 'venus';
}

// Un motor externo exige: plan Go o superior (el mismo control que el MCP), el CLI instalado y con sesion.
async function assertEngineUsable(engine) {
  const eng = deps.engines;
  const mcp = deps.optional('mcp');
  if (!eng || !mcp || typeof mcp.planState !== 'function') throw coded('engine', t('assistant.errEngineUnavailable'));
  const plan = await mcp.planState({ wait: 8000 });
  if (!plan?.entitled) throw coded(plan?.reason === 'signedOut' ? 'session' : 'noplan', t('assistant.errEnginePlan'));
  const det = await eng.detect({});
  const e = det?.[engine];
  const app = eng.APP_NAME[engine] || engine;
  if (!e?.installed) throw coded('engineMissing', t('assistant.errEngineMissing', { app }));
  if (e.loggedIn === false) throw coded('engineLogin', t('assistant.errEngineLogin', { app }));
}

// Modelo y esfuerzo de un motor externo: lo que manda la interfaz, lo ultimo de la conversacion o lo recordado.
async function resolveExternalChoice(engine, conv, opts) {
  const eng = deps.engines;
  const s = await settings.get();
  const saved = s.ai?.engineChoice?.[engine] || {};
  const wantModel = typeof opts?.model === 'string' && opts.model ? opts.model : null;
  const wantEffort = typeof opts?.effort === 'string' && opts.effort ? opts.effort : null;
  return { model: eng.normalizeModel(engine, wantModel || conv.model || saved.model), effort: eng.normalizeEffort(wantEffort || conv.effort || saved.effort), explicit: Boolean(wantModel || wantEffort) };
}

async function rememberExternalChoice(engine, { model, effort }) {
  try {
    const s = await settings.get();
    const cur = s.ai?.engineChoice?.[engine] || {};
    if (cur.model === model && cur.effort === effort) return;
    await settings.set({ ai: { engineChoice: { [engine]: { model, effort } } } });
    deps.send('assistant:settingsChanged');
  } catch (err) {
    console.warn('[assistant] No se pudo guardar la eleccion del motor:', err?.message || err);
  }
}

// ---------- Modelo y esfuerzo del turno ----------
// Una eleccion recordada (no la que manda la interfaz en este envio) se ajusta a lo que permite el plan
// segun la ultima cuota conocida: si el plan bajo de categoria se usa el primer modelo y el esfuerzo
// permitido mas parecido en vez de fallar. La eleccion explicita se respeta tal cual (decide el backend).
async function fitToPlan(choice) {
  try {
    const ai = deps.ai;
    if (typeof ai?.cachedQuota !== 'function') return choice;
    if (typeof ai.provider === 'function' && (await ai.provider()) !== 'backend') return choice;
    const options = modelOptions({ provider: 'backend', enabled: true, quota: ai.cachedQuota() });
    return options.length ? fitChoice(choice, options) : choice;
  } catch {
    return choice;
  }
}

// opts.model / opts.effort; si no vienen, lo ultimo de la conversacion o la ultima eleccion global.
// model null = el que elija el backend (primer modelo del plan).
async function resolveChoice(conv, opts) {
  const wantModel = normalizeModel(opts?.model);
  const wantEffort = normalizeEffort(opts?.effort);
  const s = await settings.get();
  const choice = {
    model: wantModel || normalizeModel(conv.model) || normalizeModel(s.ai?.assistantModel) || null,
    effort: wantEffort || normalizeEffort(conv.effort) || normalizeEffort(s.ai?.assistantEffort) || EFFORT,
  };
  if (wantModel || wantEffort) return { ...choice, explicit: true };
  return { ...(await fitToPlan(choice)), explicit: false };
}

async function rememberChoice({ model, effort }) {
  try {
    const s = await settings.get();
    if (s.ai?.assistantModel === model && s.ai?.assistantEffort === effort) return;
    await settings.set({ ai: { assistantModel: model, assistantEffort: effort } });
    deps.send('assistant:settingsChanged');
  } catch (err) {
    console.warn('[assistant] No se pudo guardar el modelo elegido:', err?.message || err);
  }
}

// ---------- API del modulo ----------
// opts = { instanceId?, model?: 'haiku'|'sonnet'|'opus' (o id completo), effort?: 'low'|'medium'|'high' }
async function send(conversationId, text, opts = {}) {
  if (!deps.ai) throw new Error(t('assistant.errNotReady'));
  const body = String(text ?? '').trim();
  if (!body) throw new Error(t('assistant.errEmpty'));
  if (body.length > MAX_INPUT) throw new Error(t('assistant.errTooLong', { max: MAX_INPUT }));
  const user = await deps.user();
  let conv = null;
  if (conversationId) {
    if (!store.validId(conversationId)) throw new Error(t('assistant.errConvNotFound'));
    conv = await getConv(conversationId);
    if (!conv || !(await owns(conv, user))) throw new Error(t('assistant.errConvNotFound'));
    if (live.has(conv.id)) throw new Error(t('assistant.errBusy'));
  } else {
    conv = store.create();
    conv.userId = user;
    conv.defs = await currentDefs();
    remember(conv);
  }
  let instanceId = null;
  if (opts && typeof opts.instanceId === 'string' && opts.instanceId) {
    instanceId = (await instances.get(opts.instanceId).catch(() => null))?.id || null;
  }
  // El motor queda fijo en la primera pregunta de la conversacion (la sesion del CLI externo sigue la charla)
  const engine = conversationId ? (EXTERNAL_ENGINES.includes(conv.engine) ? conv.engine : 'venus') : await pickEngine(opts);
  const external = engine !== 'venus';
  if (external) await assertEngineUsable(engine);
  const choice = external ? await resolveExternalChoice(engine, conv, opts) : await resolveChoice(conv, opts);
  // Otro envio a la misma conversacion pudo entrar mientras se esperaba
  if (live.has(conv.id)) throw new Error(t('assistant.errBusy'));
  const turn = { id: `t${uid(12)}`, text: body, instanceId, model: choice.model, effort: choice.effort, servedBy: null, controller: new AbortController(), installs: new Map(), bulkApproved: new Set(), engine };
  if (!conv.title) conv.title = makeTitle(body);
  conv.model = choice.model;
  conv.effort = choice.effort;
  conv.engine = engine;
  live.set(conv.id, { conv, turn });
  const done = new Promise((resolve) => {
    setImmediate(() => {
      (external ? runExternalTurn(conv, turn) : runTurn(conv, turn))
        .catch((err) => console.error('[assistant] Turno:', err))
        .finally(() => {
          live.delete(conv.id);
          resolve();
        });
    });
  });
  turn.done = done;
  if (choice.explicit) await (external ? rememberExternalChoice(engine, choice) : rememberChoice(choice));
  return { conversationId: conv.id, turnId: turn.id, model: turn.model, effort: turn.effort, engine };
}

function cancel(conversationId) {
  const l = live.get(conversationId);
  if (!l) return false;
  l.turn.controller.abort(new Error('cancelled'));
  for (const [, c] of confirms) if (c.convId === conversationId) c.resolve('cancelled');
  return true;
}

// Espera a que termine el turno en curso de una conversacion (pruebas y cierre ordenado).
async function waitIdle(conversationId) {
  const l = live.get(conversationId);
  if (l?.turn.done) await l.turn.done;
}

async function undoAction(undoId) {
  if (typeof undoId !== 'string' || !/^u[a-z0-9]{6,32}$/.test(undoId)) throw new Error(t('assistant.undoErrNotFound'));
  const { entry, warnings, cascaded } = await undo.undo(undoId);
  const conv = entry.conversationId ? await getConv(entry.conversationId).catch(() => null) : null;
  if (conv) {
    conv.notes.push(
      `The user pressed Undo in the launcher on your earlier change "${entry.summary || entry.tool}" (tool ${entry.tool}); that change was reverted${cascaded.length ? ` together with ${cascaded.length} later change(s) on the same instance` : ''}. Do not re-apply it unless the user asks.`,
    );
    for (const x of [entry, ...cascaded]) emit(conv, { type: 'undo', undoId: x.id, toolUseId: x.toolUseId, state: 'undone', warnings: x === entry ? warnings : [] });
    await flush(conv);
  }
  try {
    deps.send('instances:changed');
    if (entry.serverId) deps.send('servers:changed');
  } catch {
    /* ventana cerrada */
  }
  return { ok: true, undoId, warnings, message: t('assistant.undoDone', { action: entry.summary || entry.tool }) };
}

// Solo las de la cuenta actual (las de antes de guardar la cuenta se leen para adoptarlas).
async function conversations() {
  const user = await deps.user();
  const out = [];
  for (const c of await store.list()) {
    const mine = c.userId === undefined ? await getConv(c.id).then((conv) => Boolean(conv) && owns(conv, user)).catch(() => false) : c.userId === user;
    if (mine) out.push({ ...c, running: live.has(c.id) });
  }
  return out;
}

async function conversation(id) {
  if (!store.validId(id)) throw new Error(t('assistant.errConvNotFound'));
  const conv = await getConv(id);
  if (!conv || !(await owns(conv, await deps.user()))) throw new Error(t('assistant.errConvNotFound'));
  const undoIds = conv.events.filter((e) => e.type === 'tool-result' && e.undoId).map((e) => e.undoId);
  return {
    id: conv.id,
    title: conv.title,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    running: live.has(conv.id),
    model: conv.model || null, // ultimo modelo elegido en esta conversacion (null = el del plan)
    effort: conv.effort || null,
    engine: EXTERNAL_ENGINES.includes(conv.engine) ? conv.engine : 'venus',
    seq: conv.seq,
    events: conv.events,
    undoStates: await undo.states(undoIds),
    pendingConfirms: conv.events.filter((e) => e.type === 'confirm' && e.state === 'pending' && confirms.has(e.requestId)).map((e) => e.requestId),
  };
}

async function deleteConversation(id) {
  if (!store.validId(id)) throw new Error(t('assistant.errConvNotFound'));
  const conv = await getConv(id).catch(() => null);
  if (conv && !(await owns(conv, await deps.user()))) throw new Error(t('assistant.errConvNotFound'));
  if (live.has(id)) {
    cancel(id);
    await waitIdle(id);
  }
  const timer = saveTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    saveTimers.delete(id);
  }
  loaded.delete(id);
  return store.remove(id);
}

function runningIds() {
  return [...live.keys()];
}

// Al cerrar el launcher: cancelar los turnos, guardar todo y cerrar los servidores MCP locales.
async function shutdown() {
  const ids = [...live.keys()];
  for (const id of ids) cancel(id);
  // En paralelo con la espera de los turnos (el cierre completo tiene 4 s)
  const mcpClosed = Promise.race([Promise.resolve(deps.mcp?.closeAll?.()).catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
  await Promise.race([Promise.allSettled(ids.map((id) => waitIdle(id))), new Promise((r) => setTimeout(r, 3000))]);
  for (const conv of loaded.values()) if (saveTimers.has(conv.id)) await flush(conv);
  await mcpClosed;
}

module.exports = {
  configure,
  send,
  cancel,
  confirm,
  undoAction,
  conversations,
  conversation,
  deleteConversation,
  runningIds,
  waitIdle,
  shutdown,
  getConv,
  requestView,
  classify,
  MAX_ROUNDS,
  BULK_LIMIT,
};
