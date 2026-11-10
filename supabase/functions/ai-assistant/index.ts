// Edge Function "ai-assistant": la IA del launcher pasa por acá cuando el usuario usa su cuenta de Venus.
// - Verifica la sesión (JWT de Supabase) y aplica el plan, la cuota por modelo y el saldo (funciones SQL de
//   0008_ai_plans.sql, 0013, 0053 y 0056_ia_dos_motores.sql).
// - Venus IA con dos motores (6.1): cada llamada la atiende el proveedor del saldo que la paga (Claude -> Anthropic,
//   ChatGPT -> OpenAI), según ai_register_turn. El proveedor y el modelo nunca salen del cliente.
// - Las claves de Anthropic y de OpenAI salen de Vault (RPC ai_anthropic_key y ai_openai_key, solo service_role) con
//   un caché corto en memoria; ANTHROPIC_API_KEY y OPENAI_API_KEY son un respaldo opcional. Nunca van a los logs.
// - Antepone la política fija del servidor (policy.ts) y solo deja pasar las herramientas del launcher.
// - No registra el contenido de las conversaciones.
// Desplegar: supabase functions deploy ai-assistant. Ver docs/backend-ia.md y docs/implementacion/ia-dos-motores.md.
import Anthropic from 'npm:@anthropic-ai/sdk@^1.3.0';
import { betaJSONSchemaOutputFormat } from 'npm:@anthropic-ai/sdk@^1.3.0/helpers/beta/json-schema';
import OpenAI from 'npm:openai@^7.38.0';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { BETA_FALLBACK, PROVIDER_KEY_TTL_MS, parseTimeoutMs } from './config.ts';
import type { Provider } from './config.ts';
import type { UpstreamFailure } from './errors.ts';
import { createHandler } from './handler.ts';
import type { AuthResult, ErrorContext, ModelCall, ModelResult } from './handler.ts';
import { openaiStatusFailure } from './openai.ts';

function env(name: string): string {
  return (Deno.env.get(name) ?? '').trim();
}

const SUPABASE_URL = env('SUPABASE_URL');
const SUPABASE_ANON_KEY = env('SUPABASE_ANON_KEY');
const SUPABASE_SERVICE_ROLE_KEY = env('SUPABASE_SERVICE_ROLE_KEY');
// Respaldos opcionales de servidor: las claves principales viven en Vault (Administración -> Integraciones).
const ANTHROPIC_API_KEY = env('ANTHROPIC_API_KEY');
const OPENAI_API_KEY = env('OPENAI_API_KEY');
const TIMEOUT_MS = parseTimeoutMs(env('AI_UPSTREAM_TIMEOUT_MS'));
// Opcional: exigir el email confirmado para usar la IA.
const REQUIRE_CONFIRMED_EMAIL = /^(1|true|yes|si|sí)$/i.test(env('AI_REQUIRE_CONFIRMED_EMAIL'));

const supabaseOptions = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
// Cliente con la anon key: solo para verificar el JWT del usuario.
const authClient = SUPABASE_URL && SUPABASE_ANON_KEY ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, supabaseOptions) : null;
// Cliente con la service role: solo para las funciones de plan y cuota (no se expone nunca al usuario).
const adminClient =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, supabaseOptions) : null;
if (!authClient || !adminClient) console.error('[ai-assistant] faltan SUPABASE_URL, SUPABASE_ANON_KEY o SUPABASE_SERVICE_ROLE_KEY');

/**
 * Clave vigente de un proveedor: la de Vault (RPC de solo service_role) o, si Vault no tiene una, la variable de
 * entorno. Se guarda en memoria PROVIDER_KEY_TTL_MS (no un RPC por llamada); si el RPC falla (por ejemplo, sin la
 * migración 0056), el respaldo se guarda solo 10 s, así se vuelve a probar pronto sin un RPC por llamada. La clave
 * nunca se registra.
 */
function keyStore(rpcName: string, fallback: string): () => Promise<string | null> {
  let cache: { at: number; key: string | null } | null = null;
  let loading: Promise<string | null> | null = null;
  async function load(): Promise<string | null> {
    if (!adminClient) return fallback || null;
    try {
      const value = await rpc(rpcName, {});
      const key = typeof value === 'string' && value.trim() ? value.trim() : fallback || null;
      cache = { at: Date.now(), key };
      return key;
    } catch (err) {
      console.warn(`[ai-assistant] no se pudo leer la clave de Vault (${rpcName}): ${(err as { code?: string }).code || 'sin-codigo'}`);
      cache = { at: Date.now() - PROVIDER_KEY_TTL_MS + 10000, key: fallback || null };
      return fallback || null;
    }
  }
  return () => {
    if (cache && Date.now() - cache.at < PROVIDER_KEY_TTL_MS) return Promise.resolve(cache.key);
    loading ??= load().finally(() => {
      loading = null;
    });
    return loading;
  };
}

const keys: Record<Provider, () => Promise<string | null>> = {
  anthropic: keyStore('ai_anthropic_key', ANTHROPIC_API_KEY),
  openai: keyStore('ai_openai_key', OPENAI_API_KEY),
};

// Un cliente del SDK por clave: se crea de nuevo solo si la clave cambió (por ejemplo, se cargó una nueva en Vault).
// logLevel fijo: el SDK en modo debug registraría los pedidos completos (con el contenido de la charla), aunque
// alguien configure ANTHROPIC_LOG u OPENAI_LOG=debug. Anthropic reintenta 2 veces (fallas de red o 5xx); OpenAI no
// reintenta (un 429 por falta de crédito no se arregla reintentando).
let anthropicClient: { key: string; sdk: Anthropic } | null = null;
let openaiClient: { key: string; sdk: OpenAI } | null = null;

async function anthropicSdk(): Promise<Anthropic | null> {
  const key = await keys.anthropic();
  if (!key) return null;
  if (anthropicClient?.key !== key) {
    anthropicClient = { key, sdk: new Anthropic({ apiKey: key, maxRetries: 2, timeout: TIMEOUT_MS, logLevel: 'warn' }) };
  }
  return anthropicClient.sdk;
}

async function openaiSdk(): Promise<OpenAI | null> {
  const key = await keys.openai();
  if (!key) return null;
  if (openaiClient?.key !== key) {
    openaiClient = { key, sdk: new OpenAI({ apiKey: key, maxRetries: 0, timeout: TIMEOUT_MS, logLevel: 'warn' }) };
  }
  return openaiClient.sdk;
}

async function providerReady(provider: Provider): Promise<boolean> {
  return Boolean(await keys[provider]());
}

async function verifyUser(token: string): Promise<AuthResult> {
  if (!authClient) return { status: 'unavailable' };
  const { data, error } = await authClient.auth.getUser(token);
  const user = data?.user ?? null;
  if (user?.id && !error) {
    if (user.is_anonymous === true) return { status: 'forbidden', reason: 'anonymous' };
    if (REQUIRE_CONFIRMED_EMAIL && !user.email_confirmed_at) return { status: 'forbidden', reason: 'unconfirmed' };
    return { status: 'ok', userId: user.id };
  }
  const rawStatus = (error as { status?: unknown } | null)?.status;
  const status = typeof rawStatus === 'number' ? rawStatus : 0;
  // 4xx: token vencido o inválido, o usuario que ya no existe. Lo demás (red, 5xx): Auth no respondió.
  if (!error || (status >= 400 && status < 500)) return { status: 'invalid' };
  return { status: 'unavailable' };
}

async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (!adminClient) throw Object.assign(new Error('sin cliente de Supabase'), { code: 'not_configured' });
  const { data, error } = await adminClient.rpc(name, args);
  if (error) throw Object.assign(new Error('falla de rpc'), { code: String(error.code ?? '') });
  return data;
}

// Salida estructurada (task "json") con el helper del SDK. Su parse() lanza si el texto no es JSON
// (por ejemplo, una respuesta cortada por max_tokens): acá devuelve null, así el launcher recibe el
// stop_reason y el uso se registra igual.
function prepareFormat(schema: Record<string, unknown>): unknown {
  const base = betaJSONSchemaOutputFormat(schema as unknown as { type: 'object' });
  return {
    ...base,
    parse: (content: string) => {
      try {
        return base.parse(content);
      } catch {
        return null;
      }
    },
  };
}

async function callModel(call: ModelCall, signal: AbortSignal): Promise<ModelResult> {
  const anthropic = await anthropicSdk();
  if (!anthropic) throw Object.assign(new Error('sin clave de Anthropic'), { code: 'not_configured' });
  const params: Record<string, unknown> = {
    model: call.model,
    max_tokens: call.maxTokens,
    // Caché automática del prefijo (política, herramientas e historial).
    cache_control: { type: 'ephemeral' },
    system: call.system,
    // Los mensajes van tal cual los mandó el launcher (incluidos los bloques "thinking" firmados).
    messages: call.messages,
    // Haiku, Sonnet y Opus 5.5 piensan siempre (adaptive): no se manda "thinking" ni "temperature"; la
    // profundidad se controla con effort (el que permite el plan).
    // tool_choice queda sin definir (auto): el modo forzado no está permitido en estos modelos.
    output_config: call.format ? { effort: call.effort, format: call.format } : { effort: call.effort },
  };
  if (call.tools && call.tools.length) params.tools = call.tools;
  if (call.fallback) {
    // Solo Opus 5.5 y Sonnet 5.5 (nunca Haiku): si el clasificador de seguridad rechaza el pedido, la API lo
    // reintenta en el modelo recomendado. Ese intento se cobra aparte (usage.iterations).
    params.betas = [BETA_FALLBACK];
    params.fallbacks = 'default';
  }
  const body = params as unknown as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
  // timeout explícito: sin él, el SDK (1.3.0, calculateNonstreamingTimeout) rechaza un pedido sin streaming cuyo
  // max_tokens pueda tardar más de 10 minutos (más de ~21.000 tokens), y los planes llegan a 128.000.
  const options = { signal, timeout: TIMEOUT_MS, maxRetries: 2 };
  if (call.format) {
    const res = await anthropic.beta.messages.parse(body, options);
    return { content: res.content, stop_reason: res.stop_reason, usage: res.usage, model: res.model, parsed: res.parsed_output ?? null };
  }
  const res = await anthropic.beta.messages.create(body, options);
  return { content: res.content, stop_reason: res.stop_reason, usage: res.usage, model: res.model, parsed: null };
}

// OpenAI (planes de ChatGPT): el pedido ya viene traducido a la Responses API (openai.ts) y la respuesta vuelve tal
// cual (el handler la traduce a la forma de Anthropic). store: false va en el cuerpo.
async function callOpenAI(body: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  const client = await openaiSdk();
  if (!client) throw Object.assign(new Error('sin clave de OpenAI'), { code: 'not_configured' });
  const params = body as unknown as OpenAI.Responses.ResponseCreateParamsNonStreaming;
  return await client.responses.create(params, { signal, timeout: TIMEOUT_MS, maxRetries: 0 });
}

// Errores tipados del SDK de OpenAI, llevados a los tipos de Anthropic que entiende errors.ts (openai.ts).
function describeOpenAIError(err: unknown, context: ErrorContext): UpstreamFailure {
  if ((err as { code?: unknown } | null)?.code === 'not_configured')
    return { kind: 'status', status: 503, type: 'config_error' };
  if (context.timedOut) return { kind: 'timeout' };
  if (context.clientAborted) return { kind: 'aborted' };
  if (err instanceof OpenAI.APIUserAbortError) return { kind: 'aborted' };
  if (err instanceof OpenAI.APIConnectionTimeoutError) return { kind: 'timeout' };
  if (err instanceof OpenAI.APIConnectionError) return { kind: 'connection' };
  if (err instanceof OpenAI.APIError) {
    const payload = err.error as { message?: unknown } | undefined;
    return openaiStatusFailure({
      status: err.status,
      type: err.type,
      code: err.code,
      param: err.param,
      message: payload?.message,
      requestId: err.requestID,
    });
  }
  return { kind: 'unknown', name: err instanceof Error ? err.name : typeof err };
}

// Traduce los errores tipados del SDK a una descripción neutral (errors.ts decide la respuesta).
function describeError(err: unknown, context: { timedOut: boolean; clientAborted: boolean }): UpstreamFailure {
  if ((err as { code?: unknown } | null)?.code === 'not_configured') return { kind: 'status', status: 503, type: 'config_error' };
  if (context.timedOut) return { kind: 'timeout' };
  if (context.clientAborted) return { kind: 'aborted' };
  if (err instanceof Anthropic.APIUserAbortError) return { kind: 'aborted' };
  if (err instanceof Anthropic.APIConnectionTimeoutError) return { kind: 'timeout' };
  if (err instanceof Anthropic.APIConnectionError) return { kind: 'connection' };
  if (err instanceof Anthropic.APIError) {
    const payload = err.error as { error?: { message?: unknown } } | undefined;
    return {
      kind: 'status',
      status: typeof err.status === 'number' ? err.status : null,
      type: err.type ?? null,
      detail: typeof payload?.error?.message === 'string' ? payload.error.message : null,
      requestId: err.requestID ?? null,
    };
  }
  return { kind: 'unknown', name: err instanceof Error ? err.name : typeof err };
}

Deno.serve(
  createHandler({
    supabaseReady: Boolean(authClient && adminClient),
    // "Puede haber clave": la confirma providerReady (Vault o la variable de entorno) después de ai_register_turn.
    modelReady: Boolean(ANTHROPIC_API_KEY || adminClient),
    openaiReady: Boolean(OPENAI_API_KEY || adminClient),
    providerReady,
    timeoutMs: TIMEOUT_MS,
    verifyUser,
    rpc,
    prepareFormat,
    callModel,
    describeError,
    callOpenAI,
    describeOpenAIError,
  }),
);

