'use strict';
// IA del launcher (Claude). Va siempre por el backend: la Edge Function "ai-assistant" del proyecto de Supabase
// del launcher (protocolo 2), con la cuenta de Venus del usuario. El plan define que modelos (haiku, sonnet, opus)
// y niveles de esfuerzo (low, medium, high) puede usar, cuantas preguntas por modelo por dia y por semana y el
// tope de gasto del mes; las claves de Anthropic y OpenAI viven en el servidor. Sin suscripcion no hay IA.
// (La API key propia de versiones anteriores ya no existe: la clave segura 'ai.apiKey' se ignora.)
// Uso desde otros modulos del proceso principal:
//   const ai = require('./ai');
//   if (await ai.available()) {
//     const texto = await ai.text({ system, prompt, model: 'haiku', effort: 'medium' });
//     const datos = await ai.json({ system, prompt, schema, model: 'haiku', effort: 'low' }); // schema = JSON Schema (type: 'object')
//     const msg = await ai.messages({ system, messages, tools, turnId, model, effort });      // bajo nivel (asistente con herramientas)
//   }
// model: 'haiku' | 'sonnet' | 'opus' (tambien acepta el id completo, por ejemplo 'claude-haiku-5-5').
// Sin model, text/json usan Haiku y el asistente el primer modelo del plan. effort: 'low' | 'medium' | 'high'
// (por defecto 'medium'; si el plan no lo permite, las tareas internas se reintentan con el mas parecido).
// Cada respuesta trae served_by: { provider: 'anthropic' | 'openai', model, failover } (respaldo en OpenAI).
const secure = require('../core/secure');
const settings = require('../core/settings');
const { t } = require('../core/i18n');

const SESSION_KEY = 'ui:sb.venus-auth'; // sesion de Supabase que guarda cloud.js (cifrada)
const FUNCTION = 'ai-assistant';
// Alias del protocolo 2 -> id del modelo (para mostrarlo y compararlo con lo que manda el backend)
const MODEL_ALIASES = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' };
const MODELS = [
  { id: 'claude-opus-5-5', alias: 'opus', label: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', alias: 'sonnet', label: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', alias: 'haiku', label: 'Claude Haiku 5.5' },
];
const EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const TASK_MODEL = 'haiku'; // tareas internas (text/json) si no piden otro modelo
const CLIENT = { app: 'venus-launcher', protocol: 2 };
const CATALOG_TTL = 5 * 60 * 1000; // el GET (cuota + catalogo de planes) se repite como mucho cada 5 min

let lastQuota = null; // QuotaV2 del usuario con sesion
let catalog = null; // { plans: Catalog, at }
let lastGetAt = 0;
let getting = null; // GET en curso (se comparte entre llamadas simultaneas a status)
let cacheOwner = null; // usuario de Supabase al que pertenece lastQuota
const turnSubst = new Map(); // turnId -> { model, effort, to } (reemplazo despues de un 403 plan)
let sendToUi = () => {};

// ---------- Modelos y esfuerzo ----------

// 'haiku' | 'sonnet' | 'opus' a partir de un alias o un id completo; null si no es ninguno.
function modelAlias(m) {
  if (typeof m !== 'string') return null;
  const s = m.trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(MODEL_ALIASES, s)) return s;
  return MODELS.find((x) => x.id === s)?.alias || null;
}

function modelId(m) {
  const alias = modelAlias(m);
  return alias ? MODEL_ALIASES[alias] : null;
}

// Nombre para mostrar: el que manda el backend en la cuota o el de la lista local.
function modelLabel(m, quota = lastQuota) {
  if (!m) return '';
  const alias = modelAlias(m);
  const list = Array.isArray(quota?.models) ? quota.models : [];
  const hit = list.find((x) => x && (x.id === m || x.model === m || (alias && (modelAlias(x.id) || modelAlias(x.model)) === alias)));
  if (typeof hit?.label === 'string' && hit.label) return hit.label;
  return MODELS.find((x) => x.alias === alias)?.label || String(m);
}

function normalizeEffort(e) {
  const s = typeof e === 'string' ? e.trim().toLowerCase() : '';
  return EFFORTS.includes(s) ? s : null;
}

// Esfuerzo permitido mas parecido al pedido: el mismo si se puede; si no, el mas alto por debajo; si no, el
// mas bajo de los permitidos. null si no se sabe cuales permite.
function bestEffort(wanted, allowed) {
  const list = EFFORTS.filter((e) => Array.isArray(allowed) && allowed.includes(e));
  if (!list.length) return null;
  const w = normalizeEffort(wanted) || 'medium';
  if (list.includes(w)) return w;
  const below = list.filter((e) => EFFORTS.indexOf(e) < EFFORTS.indexOf(w));
  return below.length ? below[below.length - 1] : list[0];
}

function effortLabel(e) {
  return normalizeEffort(e) ? t(`ai.effort_${normalizeEffort(e)}`) : String(e || '');
}

// Primer modelo del plan (el que usa el backend cuando no se manda model).
function firstPlanModel(q) {
  for (const m of Array.isArray(q?.models) ? q.models : []) {
    const alias = modelAlias(m?.id) || modelAlias(m?.model);
    if (alias) return { alias, efforts: Array.isArray(m.efforts) ? m.efforts : null };
  }
  return null;
}

// Id del modelo que se muestra con el backend: el ultimo usado o el primero del plan.
function quotaModelId(q) {
  if (!q) return null;
  return modelId(q.lastModel) || modelId(firstPlanModel(q)?.alias) || (typeof q.model === 'string' ? q.model : null);
}

// ---------- Configuracion ----------

// Siempre el proyecto del launcher (core/cloud-defaults.js): los ajustes viejos (settings.cloud) se ignoran.
async function cloudConfig() {
  return require('../core/cloud-defaults').config();
}

async function storedSession() {
  const raw = await secure.get(SESSION_KEY);
  if (!raw) return null;
  try {
    const s = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return s?.access_token ? s : null;
  } catch {
    return null;
  }
}

// La cuota guardada es de un usuario: si cambia la sesion (otra cuenta o ninguna) se descarta.
function syncOwner(session) {
  const owner = session?.user?.id || null;
  if (owner === cacheOwner) return;
  cacheOwner = owner;
  lastQuota = null;
  lastGetAt = 0;
  turnSubst.clear();
}

// Sesion con el token de acceso vigente. Si esta por vencer, le pide a la interfaz (cloud.js) que renueve
// la sesion: el refresh token rota, asi que solo lo renueva un lado para no cerrar la sesion del usuario.
async function freshSession() {
  let s = await storedSession();
  const fresh = (x) => x && (!x.expires_at || x.expires_at * 1000 - Date.now() > 60000);
  if (fresh(s)) return s;
  if (!s) throw coded('unavailable', t('ai.errSignIn'));
  sendToUi('cloud:refreshSession');
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 200));
    s = await storedSession();
    if (fresh(s)) return s;
  }
  throw coded('session', t('ai.errSession'));
}

// Que conexion se usa ahora: 'backend' (IA activada y sesion de Venus iniciada) o null (sin IA disponible).
async function provider() {
  const s = await settings.get();
  if (s.ai?.enabled === false) return null;
  const cfg = await cloudConfig();
  return cfg.configured && (await storedSession()) ? 'backend' : null;
}

async function available() {
  return Boolean(await provider());
}

function textOf(content) {
  return (content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

// ---------- Transporte: backend (Edge Function) ----------

// Error traducido con un codigo estable para la interfaz (err.code):
// unavailable | session | noplan | plan | quota | backend | refused | network | ratelimit | error
// Los de cuota y plan traen ademas err.reason, err.model (alias), err.effort y err.resetAt (ISO) si se saben.
function coded(code, message, extra) {
  const err = new Error(message);
  err.code = code;
  for (const [k, v] of Object.entries(extra || {})) if (v !== undefined && v !== null) err[k] = v;
  return err;
}

function fmtReset(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '';
    return d.toLocaleString(require('../core/i18n').getLanguage(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function setQuota(q) {
  if (!q || typeof q !== 'object' || Array.isArray(q)) return;
  lastQuota = q;
  sendToUi('ai:quota', q);
}

function setCatalog(plans) {
  if (!Array.isArray(plans)) return;
  catalog = { plans: plans.filter((p) => p && typeof p === 'object' && typeof p.id === 'string'), at: Date.now() };
}

// 429: limites del plan. daily/weekly son por modelo; budget es el tope de gasto del mes (resets.monthly).
function quotaError(data, q, plan, ctx) {
  const reason = typeof data.reason === 'string' ? data.reason : null;
  if (reason === 'rate') return coded('ratelimit', t('ai.errQuotaRate'), { reason });
  const model = modelAlias(data.model) || ctx.model || firstPlanModel(q)?.alias || null;
  const extra = { reason, model, quota: data.quota };
  if (reason === 'turn') return coded('quota', t('ai.errQuotaTurn', { plan }), extra);
  const resets = q.resets && typeof q.resets === 'object' ? q.resets : {};
  const resetAt = { daily: resets.daily, weekly: resets.weekly, budget: resets.monthly, monthly: resets.monthly }[reason] || q.resetsAt || null;
  const reset = fmtReset(resetAt);
  const label = model ? modelLabel(model, q) : '';
  let msg = null;
  if (reset && reason === 'daily' && label) msg = t('ai.errQuotaDaily', { model: label, plan, reset });
  else if (reset && reason === 'weekly' && label) msg = t('ai.errQuotaWeekly', { model: label, plan, reset });
  else if (reason === 'budget' || reason === 'monthly') msg = t('ai.errSupportBudget', { plan });
  return coded('quota', msg || t('ai.errQuota', { plan }), { ...extra, resetAt });
}

// Respuestas de error de la Edge Function (ver supabase/functions/ai-assistant y docs/backend-ia.md).
// ctx = { model, effort } que se pidieron (para nombrarlos en el mensaje).
function backendError(status, data, ctx = {}) {
  const q = data.quota && typeof data.quota === 'object' ? data.quota : lastQuota || {};
  const plan = q.planName || q.plan || '?';
  if (status === 401) return coded('session', t('ai.errSession'));
  if (status === 402 || data.error === 'noplan') {
    setCatalog(data.plans);
    return coded('noplan', t('ai.errNoPlan'), { quota: data.quota });
  }
  if (data.error === 'plan') {
    const model = modelAlias(data.model) || ctx.model || firstPlanModel(q)?.alias || null;
    const label = model ? modelLabel(model, q) : '';
    const reason = data.reason === 'effort' ? 'effort' : 'model';
    let msg;
    if (reason === 'effort' && label && ctx.effort) msg = t('ai.errPlanEffort', { plan, model: label, effort: effortLabel(ctx.effort) });
    else if (reason === 'model' && label) msg = t('ai.errPlanModel', { plan, model: label });
    else msg = t('ai.errPlan', { plan });
    return coded('plan', msg, { reason, model, effort: ctx.effort, quota: data.quota });
  }
  if (status === 403) {
    const why = data.code === 'unconfirmed' || /confirm/i.test(data.message || '') ? 'unconfirmed' : data.code === 'anonymous' ? 'anonymous' : null;
    return coded('unavailable', t(why === 'unconfirmed' ? 'ai.errUnconfirmed' : why === 'anonymous' ? 'ai.errAnonymous' : 'ai.errSignIn'), { reason: why });
  }
  if (status === 404) return coded('backend', t('ai.errBackendMissing'));
  if (status === 429 || data.error === 'quota') return quotaError(data, q, plan, ctx);
  if (status === 422 || data.error === 'refusal') return coded('refused', t('ai.errRefused'));
  if (status === 400 || data.error === 'bad_request') return coded('error', t('ai.errRequest', { detail: data.message || '' }));
  const byCode = {
    upstream_rate_limited: ['ratelimit', 'ai.errBusy'],
    upstream_overloaded: ['ratelimit', 'ai.errBusy'],
    upstream_timeout: ['network', 'ai.errTimeout'],
    upstream_network: ['network', 'ai.errNetwork'],
    upstream_unavailable: ['network', 'ai.errServerDown'],
    upstream_billing: ['backend', 'ai.errServerDown'],
    upstream_auth: ['backend', 'ai.errServerConfig'],
    upstream_permission: ['backend', 'ai.errServerConfig'],
    upstream_config: ['backend', 'ai.errServerConfig'],
    not_configured: ['backend', 'ai.errServerConfig'],
    upstream_model: ['backend', 'ai.errModelPlan'],
    auth_unavailable: ['network', 'ai.errAuthUnavailable'],
    quota_unavailable: ['network', 'ai.errQuotaUnavailable'],
    backend_not_ready: ['backend', 'ai.errBackendMissing'],
    aborted: ['error', 'ai.errAborted'],
  }[data.code];
  if (byCode) return coded(byCode[0], t(byCode[1]));
  return coded('error', t('ai.errApi', { status, detail: data.message || data.error || '' }));
}

async function backendFetch(method, body, signal, ctx) {
  const cfg = await cloudConfig();
  if (!cfg.configured) throw coded('unavailable', t('ai.errNoCloud'));
  const session = await freshSession();
  syncOwner(session);
  let res;
  try {
    res = await fetch(`${cfg.url}/functions/v1/${FUNCTION}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}`, apikey: cfg.anonKey },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw coded('network', t('ai.errNetwork'));
  }
  let data;
  try {
    data = await res.json();
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    data = null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
  setQuota(data.quota);
  if (Array.isArray(data.plans)) setCatalog(data.plans);
  if (!res.ok) throw backendError(res.status, data, ctx);
  return data;
}

function rememberSubst(turnId, from, to) {
  turnSubst.delete(turnId);
  turnSubst.set(turnId, { model: from.model, effort: from.effort, to });
  while (turnSubst.size > 50) turnSubst.delete(turnSubst.keys().next().value);
}

// Reemplazo para un 403 plan: el primer modelo del plan con el esfuerzo permitido mas parecido. Sin datos
// del plan, sin model ni effort (los elige el backend). null si no cambiaria nada.
function planFallback(q, choice) {
  const first = firstPlanModel(q);
  const alt = first ? { model: first.alias, effort: bestEffort(choice.effort, first.efforts) || undefined } : { model: undefined, effort: undefined };
  return alt.model === choice.model && alt.effort === choice.effort ? null : alt;
}

// POST al backend. Una tarea interna (text/json) que pide un modelo o un esfuerzo que el plan no incluye
// (403 plan) se reintenta UNA vez con el primer modelo del plan y el esfuerzo permitido mas parecido (asi la
// explicacion de crashes, el buscador y las traducciones andan en cualquier plan). El asistente no se
// reintenta: el error llega con code 'plan' para que el usuario elija otro modelo.
async function backendPost(base, choice, { task, turnId, signal }) {
  const memo = task !== 'assistant' && turnId ? turnSubst.get(turnId) : null;
  const first = memo && memo.model === choice.model && memo.effort === choice.effort ? memo.to : choice;
  try {
    return await backendFetch('POST', { ...base, model: first.model, effort: first.effort }, signal, first);
  } catch (err) {
    if (task === 'assistant' || err?.code !== 'plan' || signal?.aborted) throw err;
    const alt = planFallback(lastQuota, first);
    if (!alt) throw err;
    const data = await backendFetch('POST', { ...base, model: alt.model, effort: alt.effort }, signal, alt);
    if (turnId) rememberSubst(turnId, choice, alt);
    return data;
  }
}

// ---------- API comun ----------

// Pedido de bajo nivel. Devuelve { content, stop_reason, usage, model, served_by, parsed, quota, via }.
// task: 'assistant' (con tools) | 'text' | 'json'. turnId agrupa las llamadas de una misma pregunta
// del usuario (el backend cuenta una sola "consulta" por turnId y la ata al modelo de su primera llamada).
async function request({ task = 'text', system, prompt, messages, tools, schema, maxTokens = 16000, effort = 'medium', model, turnId, signal } = {}) {
  const via = await provider();
  if (!via) throw coded('unavailable', t('ai.errUnavailable'));
  const msgs = messages || [{ role: 'user', content: prompt }];
  const choice = { model: modelAlias(model) || (task === 'assistant' ? undefined : TASK_MODEL), effort: normalizeEffort(effort) || 'medium' };
  const base = { task, system, messages: msgs, tools: tools || undefined, schema: schema || undefined, max_tokens: maxTokens, turn_id: turnId || undefined, client: CLIENT };
  const data = await backendPost(base, choice, { task, turnId, signal });
  const out = { ...data.message, parsed: data.parsed ?? null, quota: data.quota || null, via };
  if (out.stop_reason === 'refusal') throw coded('refused', t('ai.errRefused'));
  return out;
}

// Para el asistente: conversacion con herramientas. No corta en max_tokens (lo maneja quien llama).
// Todas las llamadas de un mismo turnId tienen que usar el mismo model.
async function messages({ system, messages: msgs, tools, maxTokens = 16000, effort = 'medium', model, turnId, signal }) {
  return request({ task: 'assistant', system, messages: msgs, tools, maxTokens, effort, model, turnId, signal });
}

// Respuesta en texto (markdown simple).
async function text(opts) {
  const res = await request({ ...opts, task: 'text' });
  if (res.stop_reason === 'max_tokens') throw new Error(t('ai.errTooLong'));
  return textOf(res.content);
}

// Respuesta validada contra un JSON Schema (type: 'object', con required y additionalProperties: false).
async function json(opts) {
  const res = await request({ ...opts, task: 'json' });
  if (res.stop_reason === 'max_tokens') throw new Error(t('ai.errTooLong'));
  if (res.parsed) return res.parsed;
  try {
    return JSON.parse(textOf(res.content));
  } catch {
    throw new Error(t('ai.errParse'));
  }
}

// Cuota del plan que se conoce ahora (sin pedirla): QuotaV2 o null.
function cachedQuota() {
  return lastQuota;
}

async function status({ refresh = false } = {}) {
  const s = await settings.get();
  const cfg = await cloudConfig();
  const session = cfg.configured ? await storedSession() : null;
  const via = await provider();
  if (via === 'backend') {
    syncOwner(session);
    if (getting || refresh || !lastQuota || Date.now() - lastGetAt > CATALOG_TTL) {
      if (!getting) {
        lastGetAt = Date.now();
        getting = backendFetch('GET', null) // { quota, plans }
          .catch(() => {
            /* el estado del plan es informativo */
          })
          .finally(() => {
            getting = null;
          });
      }
      await getting;
    }
  }
  return {
    provider: via, // 'backend' | null
    enabled: s.ai?.enabled !== false,
    cloudConfigured: cfg.configured,
    signedIn: Boolean(session),
    configured: via === 'backend', // la IA esta lista para usarse (activada y con sesion de Venus)
    model: via === 'backend' ? quotaModelId(lastQuota) : null,
    models: MODELS,
    efforts: EFFORTS,
    quota: via === 'backend' ? lastQuota : null, // QuotaV2
    plans: catalog ? catalog.plans : null, // catalogo de planes del backend
  };
}

function register({ handle, send }) {
  sendToUi = send;
  handle('ai:status', (opts) => status(opts || {}));
  handle('ai:test', async () => {
    const reply = await text({ prompt: 'Respond with the single word OK.', maxTokens: 2000, effort: 'low' });
    return { ok: /ok/i.test(reply), reply: reply.slice(0, 200) };
  });
}

module.exports = {
  register,
  available,
  provider,
  request,
  messages,
  text,
  json,
  status,
  textOf,
  cachedQuota,
  modelAlias,
  modelId,
  modelLabel,
  normalizeEffort,
  bestEffort,
  MODELS,
  MODEL_ALIASES,
  EFFORTS,
};
