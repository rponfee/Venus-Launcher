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
// model: 'haiku' (rapido) | 'sonnet' (avanzado) (tambien acepta el id completo, por ejemplo 'claude-haiku-5-5' o
// 'gpt-6-luna'); el modelo real lo decide la familia del plan en uso (Claude u OpenAI). Sin model, text/json usan
// Haiku y el asistente el primer modelo del plan. effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' (por defecto
// 'medium'; si el plan no lo permite, las tareas internas se reintentan con el mas parecido).
// Cada respuesta trae served_by: { provider: 'anthropic' | 'openai', model, failover } y switched ({ from, to,
// reason } o null) si en esa llamada el servidor paso al otro saldo (planes de Claude y de ChatGPT, 6.1).
const secure = require('../core/secure');
const settings = require('../core/settings');
const { t } = require('../core/i18n');

const SESSION_KEY = 'ui:sb.venus-auth'; // sesion de Supabase que guarda cloud.js (cifrada)
const FUNCTION = 'ai-assistant';
// Dos familias de planes (6.1, docs/implementacion/ia-dos-motores.md): cada plan es de una y da saldo de esa API.
// Una cuota vieja (sin provider) es de OpenAI, el unico proveedor de la 6.0.
const FAMILIES = ['anthropic', 'openai'];
const FAMILY_NAMES = { anthropic: 'Claude', openai: 'ChatGPT' }; // marcas: no se traducen
const TIERS = ['basic', 'go', 'pro', 'max', 'ultra'];
// Clave del protocolo (haiku = rapido, sonnet = avanzado) -> id real segun la familia del plan. Es solo el
// respaldo: la cuota trae el suyo en models[].model y el nombre para mostrar en models[].label.
const FAMILY_MODELS = Object.freeze({
  anthropic: Object.freeze({ haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' }),
  openai: Object.freeze({ haiku: 'gpt-6-luna', sonnet: 'gpt-5.6-sol' }),
});
const ALIASES = ['haiku', 'sonnet', 'opus'];
const MODEL_ALIASES = FAMILY_MODELS.openai; // compatibilidad: ids de la 6.0
const MODELS = [
  { id: 'claude-haiku-5-5', alias: 'haiku', provider: 'anthropic', label: 'Haiku 5.5' },
  { id: 'claude-sonnet-5-5', alias: 'sonnet', provider: 'anthropic', label: 'Sonnet 5.5' },
  { id: 'gpt-6-luna', alias: 'haiku', provider: 'openai', label: 'GPT-6 Luna' },
  { id: 'gpt-5.6-sol', alias: 'sonnet', provider: 'openai', label: 'GPT-5.6 Sol' },
];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const SWITCH_REPEAT_MS = 2 * 60 * 1000; // el mismo cambio de saldo informado por llamadas simultaneas se avisa una vez
const TASK_MODEL = 'haiku'; // tareas internas (text/json) si no piden otro modelo
const CLIENT = { app: 'venus-launcher', protocol: 2 };
const CATALOG_TTL = 5 * 60 * 1000; // el GET (cuota + catalogo de planes) se repite como mucho cada 5 min

let lastQuota = null; // QuotaV2 del usuario con sesion
let catalog = null; // { plans: Catalog, at }
let lastGetAt = 0;
let getting = null; // GET en curso (se comparte entre llamadas simultaneas a status)
let cacheOwner = null; // usuario de Supabase al que pertenece lastQuota
const turnSubst = new Map(); // turnId -> { model, effort, to } (reemplazo despues de un 403 plan)
let lastSwitch = null; // { key: 'from>to', at } ultimo cambio de saldo avisado
let sendToUi = () => {};

// ---------- Familia y nivel del plan ----------

// 'anthropic' | 'openai' de una cuota, un saldo o un plan del catalogo ({ provider, plan|id }) o de un id de plan.
// null si no hay plan. Los planes de Claude tienen id claude_*; los de ChatGPT conservan los de la 6.0.
function planFamily(q) {
  if (q && typeof q === 'object' && FAMILIES.includes(q.provider)) return q.provider;
  const plan = String((q && typeof q === 'object' ? q.plan ?? q.id : q) || '').toLowerCase();
  if (!plan) return null;
  return plan.startsWith('claude_') ? 'anthropic' : 'openai';
}

// 'basic' | 'go' | 'pro' | 'max' | 'ultra' (el nivel, igual en las dos familias) o null si no se sabe.
function planTier(q) {
  if (q && typeof q === 'object' && TIERS.includes(q.tier)) return q.tier;
  const plan = String((q && typeof q === 'object' ? q.plan ?? q.id : q) || '').toLowerCase().replace(/^claude_/, '');
  return TIERS.includes(plan) ? plan : null;
}

// "Claude Pro" / "ChatGPT Pro" para los mensajes; con una cuota vieja (sin provider), solo el nombre del plan.
function planDisplayName(q) {
  const name = q?.planName || q?.plan || '';
  if (!name || !q || !FAMILIES.includes(q.provider)) return name;
  return `${FAMILY_NAMES[q.provider]} ${name}`;
}

// ---------- Modelos y esfuerzo ----------

// 'haiku' | 'sonnet' | 'opus' a partir de un alias o un id completo (de cualquier familia); null si no es ninguno.
function modelAlias(m) {
  if (typeof m !== 'string') return null;
  const s = m.trim().toLowerCase();
  if (ALIASES.includes(s)) return s;
  for (const f of FAMILIES) {
    const hit = Object.entries(FAMILY_MODELS[f]).find(([, id]) => id === s);
    if (hit) return hit[0];
  }
  return null;
}

// Id real de una clave en la familia del plan (por defecto, la de la ultima cuota).
function modelId(m, family = planFamily(lastQuota) || 'openai') {
  const alias = modelAlias(m);
  if (!alias) return null;
  return FAMILY_MODELS[family]?.[alias] || FAMILY_MODELS.anthropic[alias] || null;
}

// Nombre para mostrar: el que manda el backend en la cuota (label). Sin eso, el del id real de esa familia.
function modelLabel(m, quota = lastQuota) {
  if (!m) return '';
  const alias = modelAlias(m);
  const list = Array.isArray(quota?.models) ? quota.models : [];
  const hit = list.find((x) => x && (x.id === m || x.model === m || (alias && (modelAlias(x.id) || modelAlias(x.model)) === alias)));
  if (typeof hit?.label === 'string' && hit.label) return hit.label;
  const id = (typeof hit?.providerModel === 'string' && hit.providerModel) || modelId(alias, planFamily(quota) || 'openai');
  return MODELS.find((x) => x.id === id)?.label || MODELS.find((x) => x.id === String(m).toLowerCase())?.label || String(m);
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

// Id del modelo que se muestra con el backend: el ultimo usado o el primero del plan (el de la cuota si lo trae).
function quotaModelId(q) {
  if (!q) return null;
  const family = planFamily(q) || 'openai';
  const fromQuota = (alias) => {
    const m = (Array.isArray(q.models) ? q.models : []).find((x) => x && (modelAlias(x.id) || modelAlias(x.model)) === alias);
    // providerModel = id real del motor; model sigue siendo el id de Claude de la clave (servidor de la 6.1)
    return (typeof m?.providerModel === 'string' && m.providerModel) || (family === 'anthropic' && typeof m?.model === 'string' && m.model) || modelId(alias, family);
  };
  const alias = modelAlias(q.lastModel) || firstPlanModel(q)?.alias;
  return (alias && fromQuota(alias)) || (typeof q.model === 'string' ? q.model : null);
}

// ---------- Cambio de saldo (switched) ----------

// { from, to, reason } valido o null.
function switchedOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const from = FAMILIES.includes(raw.from) ? raw.from : null;
  const to = FAMILIES.includes(raw.to) ? raw.to : null;
  if (!from || !to || from === to) return null;
  return { from, to, reason: raw.reason === 'noplan' ? 'noplan' : 'budget' };
}

// El servidor paso solo al otro saldo en esta llamada. Se avisa una vez por cambio: llamadas simultaneas que traen
// el mismo cambio no repiten el aviso. El asistente lo muestra en su chat (vuelve en la respuesta); el resto de las
// funciones con IA, con un aviso de la interfaz (ai:switched).
function noteSwitched(raw, task) {
  const s = switchedOf(raw);
  if (!s) return null;
  const key = `${s.from}>${s.to}`;
  const now = Date.now();
  if (lastSwitch && lastSwitch.key === key && now - lastSwitch.at < SWITCH_REPEAT_MS) return null;
  lastSwitch = { key, at: now };
  if (task !== 'assistant') sendToUi('ai:switched', { ...s, task: task || 'text' });
  return s;
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
  lastSwitch = null;
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
  else if (reason === 'budget' || reason === 'monthly') msg = budgetMessage(q, plan);
  return coded('quota', msg || t('ai.errQuota', { plan }), { ...extra, resetAt });
}

// Sin saldo. Con el servidor de la 6.1 (cuota con provider) "budget" quiere decir que ningun saldo alcanza: se
// ofrece comprar mas del mismo motor o un plan del otro. Con una cuota vieja, el texto de siempre.
function budgetMessage(q, plan) {
  if (!FAMILIES.includes(q?.provider)) return t('ai.errSupportBudget', { plan });
  const family = q.provider;
  const other = FAMILIES.find((f) => f !== family);
  return t('ai.errBudgetOut', { plan, family: FAMILY_NAMES[family], other: FAMILY_NAMES[other] });
}

// Respuestas de error de la Edge Function (ver supabase/functions/ai-assistant y docs/backend-ia.md).
// ctx = { model, effort } que se pidieron (para nombrarlos en el mensaje).
function backendError(status, data, ctx = {}) {
  const q = data.quota && typeof data.quota === 'object' ? data.quota : lastQuota || {};
  const plan = planDisplayName(q) || '?';
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
  // switched llega en la respuesta y tambien en los errores con cuota (ver ia-dos-motores.md §4)
  const switched = method === 'POST' ? noteSwitched(data.switched, ctx?.task) : null;
  if (!res.ok) {
    const err = backendError(res.status, data, ctx);
    if (switched) err.switched = switched;
    throw err;
  }
  return { ...data, switched };
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
    return await backendFetch('POST', { ...base, model: first.model, effort: first.effort }, signal, { ...first, task });
  } catch (err) {
    if (task === 'assistant' || err?.code !== 'plan' || signal?.aborted) throw err;
    const alt = planFallback(lastQuota, first);
    if (!alt) throw err;
    const data = await backendFetch('POST', { ...base, model: alt.model, effort: alt.effort }, signal, { ...alt, task });
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
  const out = { ...data.message, parsed: data.parsed ?? null, quota: data.quota || null, switched: data.switched || null, via };
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
  const q = via === 'backend' ? lastQuota : null;
  return {
    provider: via, // 'backend' | null
    enabled: s.ai?.enabled !== false,
    cloudConfigured: cfg.configured,
    signedIn: Boolean(session),
    configured: via === 'backend', // la IA esta lista para usarse (activada y con sesion de Venus)
    model: via === 'backend' ? quotaModelId(lastQuota) : null,
    models: MODELS,
    efforts: EFFORTS,
    quota: q, // QuotaV2 (QuotaV3 con el servidor de la 6.1: provider, tier y wallets)
    planFamily: q && q.plan ? planFamily(q) : null, // familia del saldo en uso: 'anthropic' | 'openai'
    planTier: q ? planTier(q) : null, // nivel del plan en uso: 'basic' ... 'ultra'
    plans: catalog ? catalog.plans : null, // catalogo de planes del backend
  };
}

// Elige que saldo usar (RPC ai_use_wallet con la sesion del usuario). Devuelve la cuota nueva.
async function useWallet(family) {
  if (!FAMILIES.includes(family)) throw coded('error', t('ai.errWallet'));
  const cfg = await cloudConfig();
  if (!cfg.configured) throw coded('unavailable', t('ai.errNoCloud'));
  const session = await freshSession();
  syncOwner(session);
  let res;
  try {
    res = await fetch(`${cfg.url}/rest/v1/rpc/ai_use_wallet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}`, apikey: cfg.anonKey },
      body: JSON.stringify({ p_provider: family }),
    });
  } catch {
    throw coded('network', t('ai.errNetwork'));
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401) throw coded('session', t('ai.errSession'));
    if (res.status === 404 || data?.code === 'PGRST202') throw coded('backend', t('ai.errBackendMissing'));
    throw coded('error', t('ai.errWallet'));
  }
  lastSwitch = null;
  if (data && typeof data === 'object' && !Array.isArray(data) && Array.isArray(data.models)) {
    lastGetAt = Date.now();
    setQuota(data);
  } else {
    await status({ refresh: true });
  }
  return lastQuota;
}

function register({ handle, send }) {
  sendToUi = send;
  handle('ai:status', (opts) => status(opts || {}));
  handle('ai:useWallet', (family) => useWallet(String(family || '')));
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
  useWallet,
  modelAlias,
  modelId,
  modelLabel,
  normalizeEffort,
  bestEffort,
  planFamily,
  planTier,
  planDisplayName,
  switchedOf,
  MODELS,
  MODEL_ALIASES,
  FAMILY_MODELS,
  FAMILIES,
  FAMILY_NAMES,
  TIERS,
  EFFORTS,
};
