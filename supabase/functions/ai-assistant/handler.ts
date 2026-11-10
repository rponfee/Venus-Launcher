// Flujo HTTP de la Edge Function "ai-assistant" (protocolos 1 y 2 del launcher, ver docs/backend-ia.md).
// No importa nada de npm ni de Deno: index.ts le pasa las dependencias reales (Supabase y los SDK de
// Anthropic y de OpenAI) y las pruebas le pasan dobles. Nunca registra contenido de la conversación.
// Proveedores (6.1, 0056, ver docs/implementacion/ia-dos-motores.md): cada llamada la atiende el proveedor del saldo
// que la paga (`provider` de ai_register_turn: Claude -> Anthropic, ChatGPT -> OpenAI). Si ese proveedor no tiene
// clave, 503 not_configured. El respaldo entre proveedores por una caída (ai_provider_config, providers.ts) sigue
// disponible pero apagado: solo con failover_enabled una falla del proveedor (no un rechazo de la IA ni un pedido
// inválido) pasa el pedido al otro.
import { CORS_HEADERS, ESTIMATE_OUTPUT_TOKENS_PER_SECOND, LIMITS, MAX_OUTPUT_TOKENS, MIN_FAILOVER_MS, PROVIDER_SETTINGS_TTL_MS } from './config.ts';
import type { Effort, Provider, Task } from './config.ts';
import { failureLogLine, mapUpstreamError, MESSAGES } from './errors.ts';
import type { MappedError, UpstreamFailure } from './errors.ts';
import { buildOpenAIRequest, fromOpenAIResponse, openaiUsageLines, UpstreamResponseError } from './openai.ts';
import { buildSystem } from './policy.ts';
import type { SystemBlock } from './policy.ts';
import { ANTHROPIC_ONLY, OPENAI_ONLY, callTargets, failoverKind, otherProvider, parseProviderSettings, planAttempts } from './providers.ts';
import type { Attempt, ProviderSettings, Readiness } from './providers.ts';
import {
  clampMaxTokens,
  denialResponse,
  estimatedUsageLine,
  newTurnId,
  normalizeCatalog,
  normalizeQuota,
  parseTurnCheck,
  parseUsageResult,
  usageLines,
} from './quota.ts';
import type { CatalogPlan, Quota, Switched, TurnCheck, UsageLine } from './quota.ts';
import { validateRequest } from './validate.ts';

export type AuthResult =
  | { status: 'ok'; userId: string }
  | { status: 'invalid' }
  | { status: 'forbidden'; reason: 'anonymous' | 'unconfirmed' }
  | { status: 'unavailable' };

/** Pedido ya armado para la IA: el modelo y el esfuerzo salen del plan y el system empieza con la política. */
export interface ModelCall {
  /** Id del modelo en la API de Anthropic (de ai_register_turn; nunca el texto del cliente). */
  model: string;
  /** Mandar `fallbacks: "default"` con su beta (solo Opus 5.5 y Sonnet 5.5, y solo si la base lo dice). */
  fallback: boolean;
  task: Task;
  system: SystemBlock[];
  messages: unknown[];
  tools: Record<string, unknown>[] | null;
  maxTokens: number;
  effort: Effort;
  /** Formato de salida estructurada preparado por deps.prepareFormat (task "json"); opaco acá. */
  format: unknown;
  /** JSON Schema de la respuesta tal cual lo mandó el launcher (task "json"; lo usa la traducción a OpenAI). */
  schema: Record<string, unknown> | null;
}

export interface ModelResult {
  content: unknown;
  stop_reason: unknown;
  usage: unknown;
  model: unknown;
  parsed: unknown;
}

export interface Logger {
  warn(message: string): void;
  error(message: string): void;
}

export interface ErrorContext {
  timedOut: boolean;
  clientAborted: boolean;
}

export interface Deps {
  /** Están SUPABASE_URL, SUPABASE_ANON_KEY y SUPABASE_SERVICE_ROLE_KEY. */
  supabaseReady: boolean;
  /** Puede haber clave de Anthropic (ANTHROPIC_API_KEY o el acceso a Vault). */
  modelReady: boolean;
  /** Puede haber clave de OpenAI (OPENAI_API_KEY o el acceso a Vault). Sin el campo, como si no hubiera. */
  openaiReady?: boolean;
  /**
   * Si hay una clave vigente de ese proveedor (index.ts: Vault con un caché corto, o la variable de entorno). Sin el
   * campo, alcanza con modelReady / openaiReady.
   */
  providerReady?(provider: Provider): Promise<boolean>;
  /** Tiempo máximo de espera a la IA (ms), para todos los intentos juntos. */
  timeoutMs: number;
  verifyUser(token: string): Promise<AuthResult>;
  /** Llama a una función SQL con la service role. Si falla lanza un error con `code`. */
  rpc(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** Prepara el formato de salida estructurada. Lanza si el schema no sirve. */
  prepareFormat(schema: Record<string, unknown>): unknown;
  /** Llama a Anthropic (Claude) con el SDK oficial. */
  callModel(call: ModelCall, signal: AbortSignal): Promise<ModelResult>;
  describeError(err: unknown, context: ErrorContext): UpstreamFailure;
  /** Llama a la Responses API de OpenAI con el pedido ya traducido (openai.ts) y devuelve la respuesta tal cual. */
  callOpenAI?(body: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  /** Traduce un error del SDK de OpenAI a una descripción neutral (ver openai.ts openaiStatusFailure). */
  describeOpenAIError?(err: unknown, context: ErrorContext): UpstreamFailure;
  /** Cuánto se guarda en memoria la configuración de proveedores (ms). Por defecto PROVIDER_SETTINGS_TTL_MS. */
  providerSettingsTtlMs?: number;
  /** Reloj en ms (para las pruebas). Por defecto Date.now. */
  now?(): number;
  logger?: Logger;
}

/** Quién respondió, como lo recibe el launcher en message.served_by. */
export interface ServedBy {
  provider: Provider;
  /** Modelo que respondió (puede ser un modelo de respaldo). */
  model: string;
  /** true si respondió el otro proveedor porque el de la llamada falló o no está configurado (respaldo). */
  failover: boolean;
}

interface HandlerContext {
  providerSettings(): Promise<ProviderSettings>;
}

const FORBIDDEN_MESSAGES = {
  anonymous: 'Iniciá sesión con una cuenta de Venus para usar la IA.',
  unconfirmed: 'Confirmá el email de tu cuenta de Venus para usar la IA.',
} as const;

const DB_NOT_READY = new Set(['PGRST202', '42883', '42P01']);

function json(status: number, body: unknown, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(extraHeaders ?? {}),
    },
  });
}

/** 400 de un pedido mal armado (code fijo, para distinguirlo de turn_model y upstream_invalid_request). */
function badRequest(message: string): Response {
  return json(400, { error: 'bad_request', code: 'invalid_request', message });
}

function errorName(err: unknown): string {
  if (err instanceof Error) return err.name.slice(0, 60);
  return typeof err;
}

function rpcCode(err: unknown): string {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' && code ? code.slice(0, 40) : 'sin-codigo';
}

function rpcFailure(err: unknown, logger: Logger): Response {
  const code = rpcCode(err);
  logger.error(`[ai-assistant] falla de la base de datos: ${code}`);
  if (DB_NOT_READY.has(code)) return json(503, { error: 'upstream', message: MESSAGES.backendNotReady, code: 'backend_not_ready' });
  return json(503, { error: 'upstream', message: MESSAGES.quotaUnavailable, code: 'quota_unavailable' });
}

/** Catálogo de planes para el 402 (si falla, lista vacía: el rechazo igual llega). */
async function loadCatalog(deps: Deps, logger: Logger): Promise<CatalogPlan[]> {
  try {
    return normalizeCatalog(await deps.rpc('ai_catalog', {}));
  } catch (err) {
    logger.warn(`[ai-assistant] no se pudo leer el catálogo: ${rpcCode(err)}`);
    return [];
  }
}

/** Token de "Authorization: Bearer <jwt>" (o null). */
export function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/i.exec(header.trim());
  if (!match || match[1].length > 8192) return null;
  return match[1];
}

export type BodyRead = { ok: true; text: string; bytes: number } | { ok: false; reason: 'too_large' | 'unreadable' };

/** Lee el cuerpo sin pasar `limit` bytes (corta apenas se pasa) y lo decodifica como UTF-8 estricto. */
export async function readBody(req: Request, limit: number): Promise<BodyRead> {
  const declared = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > limit) return { ok: false, reason: 'too_large' };
  if (!req.body) return { ok: true, text: '', bytes: 0 };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        reader.cancel().catch(() => {});
        return { ok: false, reason: 'too_large' };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), bytes: total };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

/** Configuración de proveedores con un caché en memoria (una lectura por minuto por instancia). */
function createContext(deps: Deps, logger: Logger): HandlerContext {
  const ttl = typeof deps.providerSettingsTtlMs === 'number' ? deps.providerSettingsTtlMs : PROVIDER_SETTINGS_TTL_MS;
  const clock = deps.now ?? Date.now;
  let cache: { at: number; settings: ProviderSettings } | null = null;
  let loading: Promise<ProviderSettings> | null = null;

  async function load(): Promise<ProviderSettings> {
    let settings: ProviderSettings = deps.modelReady ? ANTHROPIC_ONLY : OPENAI_ONLY;
    try {
      const parsed = parseProviderSettings(await deps.rpc('ai_provider_settings', {}));
      if (parsed) settings = parsed;
      else logger.warn('[ai-assistant] la configuración de proveedores no tiene la forma esperada: sin respaldo');
    } catch (err) {
      // Sin la migración 0011 (o con la base caída): sin respaldo entre proveedores.
      logger.warn(`[ai-assistant] no se pudo leer la configuración de proveedores (${rpcCode(err)}): sin respaldo`);
    }
    cache = { at: clock(), settings };
    return settings;
  }

  return {
    providerSettings(): Promise<ProviderSettings> {
      if (cache && clock() - cache.at < ttl) return Promise.resolve(cache.settings);
      loading ??= load().finally(() => {
        loading = null;
      });
      return loading;
    },
  };
}

interface Served {
  provider: Provider;
  result: ModelResult;
  /** Renglones de uso para ai_add_usage: cada intento con el modelo que lo corrió. */
  lines: UsageLine[];
  /** Modelo pedido (si la respuesta no trae uno válido). */
  requested: string;
}

interface Failed {
  provider: Provider;
  /** Modelo que corrió el intento (para cobrar una estimación si se cortó). */
  model: string;
  failure: UpstreamFailure;
  mapped: MappedError;
  /** Cuánto duró el intento (ms): acota la salida que se cobra si se cortó. */
  elapsedMs: number;
  /** El principal no se llamó (no estaba configurado): no es un intento real. */
  skipped?: boolean;
}

/**
 * Fallas después de las que la IA pudo haber procesado (y facturado) el pedido: el plazo vencido, la cancelación del
 * launcher y la conexión cortada. Se cobra una estimación: si no, el presupuesto no vería ese gasto.
 */
const BILLED_KINDS: ReadonlySet<UpstreamFailure['kind']> = new Set(['timeout', 'aborted', 'connection']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Un intento con un proveedor. Lanza si el proveedor falla (también si OpenAI responde con status "failed"). */
async function runAttempt(attempt: Attempt, call: ModelCall, signal: AbortSignal, deps: Deps): Promise<Served> {
  if (attempt.provider === 'anthropic') {
    // El SDK de Anthropic con el pedido intacto (index.ts). fallbacks solo con el modelo que la base habilitó.
    const own: ModelCall = { ...call, model: attempt.model, fallback: call.fallback && attempt.model === call.model };
    const result = await deps.callModel(own, signal);
    return { provider: 'anthropic', result, lines: usageLines(result.usage, own.model, result.model), requested: own.model };
  }
  if (!deps.callOpenAI) throw new Error('sin cliente de OpenAI');
  const target = { model: attempt.model, effort: attempt.effort };
  const request = buildOpenAIRequest(call, target);
  const raw = await deps.callOpenAI(request.body, signal);
  const result = fromOpenAIResponse(raw, request, call.task, target.model);
  // El costo va con el modelo pedido (el id de ai_models), aunque la respuesta traiga un snapshot con fecha.
  return { provider: 'openai', result, lines: openaiUsageLines(isRecord(raw) ? raw.usage : null, target.model), requested: target.model };
}

function describeAttemptError(attempt: Attempt, err: unknown, context: ErrorContext, deps: Deps): UpstreamFailure {
  if (attempt.provider === 'anthropic') return deps.describeError(err, context);
  if (context.timedOut) return { kind: 'timeout' };
  if (context.clientAborted) return { kind: 'aborted' };
  if (err instanceof UpstreamResponseError) return err.failure;
  return deps.describeOpenAIError ? deps.describeOpenAIError(err, context) : { kind: 'unknown', name: errorName(err) };
}

/**
 * Respuesta 503 not_configured: falta la clave del proveedor de la llamada (`provider`, para que el launcher sepa
 * cuál) o ningún proveedor puede atender. `switched` si en esta llamada el servidor pasó al otro saldo.
 */
function notConfigured(quota?: Quota, provider?: Provider, switched?: Switched | null): Response {
  return json(503, {
    error: 'upstream',
    message: MESSAGES.notConfigured,
    code: 'not_configured',
    ...(provider ? { provider } : {}),
    ...(quota ? { quota } : {}),
    ...(switched ? { switched } : {}),
  });
}

/** Devuelve la pregunta nueva que no se pudo atender (si se contó en este pedido). */
async function releaseTurn(deps: Deps, logger: Logger, userId: string, turnId: string, check: TurnCheck): Promise<Quota> {
  if (!check.counted) return check.quota;
  try {
    return normalizeQuota(await deps.rpc('ai_release_turn', { p_user: userId, p_turn: turnId })) ?? check.quota;
  } catch (releaseErr) {
    logger.warn(`[ai-assistant] no se pudo devolver la pregunta: ${rpcCode(releaseErr)}`);
    return check.quota;
  }
}

/**
 * Cierra en la base una llamada sin respuesta y sin uso que cobrar (ai_end_call, 0013): deja de contar como llamada
 * en curso. Las que se cobran las cierra ai_add_usage.
 */
async function endCall(deps: Deps, logger: Logger, userId: string, quota: Quota, callId: string | null = null): Promise<Quota> {
  try {
    // Con la reserva (0056) se cierra esa llamada y no la más vieja del usuario.
    const args = callId ? { p_user: userId, p_call: callId } : { p_user: userId };
    return normalizeQuota(await deps.rpc('ai_end_call', args)) ?? quota;
  } catch (err) {
    logger.warn(`[ai-assistant] no se pudo cerrar la llamada: ${rpcCode(err)}`);
    return quota;
  }
}

/** Registra el uso de una llamada y su costo (ai_add_usage, que además la cierra). Si falla, sigue con `quota`. */
async function addUsage(deps: Deps, logger: Logger, userId: string, model: string, lines: UsageLine[], quota: Quota, callId: string | null = null): Promise<Quota> {
  try {
    // Con la reserva (0056) el costo va al saldo que pagó ESTA llamada, aunque haya otra en curso con el otro saldo.
    const args = { p_user: userId, p_model: model, p_usage: lines, ...(callId ? { p_call: callId } : {}) };
    const usage = parseUsageResult(await deps.rpc('ai_add_usage', args));
    if (!usage) {
      logger.error('[ai-assistant] no se pudo registrar el uso: respuesta-invalida');
      return quota;
    }
    if (usage.unpriced.length) logger.warn(`[ai-assistant] modelo sin precio en ai_models: ${usage.unpriced.join(', ')}`);
    return usage.quota;
  } catch (err) {
    logger.error(`[ai-assistant] no se pudo registrar el uso: ${rpcCode(err)}`);
    return quota;
  }
}

/** Hay clave vigente para `provider` (sin providerReady, alcanza con que pueda haberla). */
async function isProviderReady(deps: Deps, logger: Logger, provider: Provider, possible: Readiness): Promise<boolean> {
  if (!possible[provider]) return false;
  if (!deps.providerReady) return true;
  try {
    return await deps.providerReady(provider);
  } catch (err) {
    logger.warn(`[ai-assistant] no se pudo leer la clave de ${provider}: ${rpcCode(err)}`);
    return false;
  }
}

async function handlePost(req: Request, deps: Deps, logger: Logger, userId: string, ctx: HandlerContext): Promise<Response> {
  // Si no puede haber clave de ningún proveedor, se corta acá, antes de gastar una pregunta.
  const possible: Readiness = { anthropic: deps.modelReady, openai: Boolean(deps.openaiReady && deps.callOpenAI) };
  if (!possible.anthropic && !possible.openai) return notConfigured();

  const contentType = (req.headers.get('content-type') ?? '').trim().toLowerCase();
  if (!contentType.startsWith('application/json')) return badRequest('El pedido tiene que ser JSON (Content-Type: application/json).');
  const read = await readBody(req, LIMITS.bodyBytes);
  if (!read.ok) {
    return badRequest(
      read.reason === 'too_large'
        ? `El pedido es demasiado grande (máximo ${LIMITS.bodyBytes / 1024} KB).`
        : 'No se pudo leer el cuerpo del pedido (tiene que ser texto UTF-8).',
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(read.text);
  } catch {
    return badRequest('El cuerpo del pedido no es JSON válido.');
  }
  const valid = validateRequest(body);
  if (!valid.ok) return badRequest(valid.message);
  const request = valid.value;

  // El schema se prepara antes de tocar la cuota: un schema inválido no gasta una consulta.
  let format: unknown = null;
  if (request.task === 'json' && request.schema) {
    try {
      format = deps.prepareFormat(request.schema);
    } catch {
      return badRequest('El schema no sirve para una respuesta estructurada (cada propiedad necesita un "type").');
    }
  }

  // Plan, saldo y cuota: resuelve el modelo, el esfuerzo y el proveedor (el del saldo que paga, 0056), abre la
  // pregunta (turn_id) o suma una llamada a una pregunta ya abierta. Todo en la base, en una sola transacción
  // (ai_register_turn). p_max_tokens (ya recortado a MAX_OUTPUT_TOKENS) y p_input_bytes ajustan la reserva al pedido
  // real: si el saldo no alcanza para ese max_tokens, la base lo baja (maxTokensPerRequest) o pasa al otro saldo.
  const turnId = request.turnId ?? newTurnId();
  const maxTokens = request.maxTokens === null ? null : Math.min(request.maxTokens, MAX_OUTPUT_TOKENS);
  let check: TurnCheck | null;
  try {
    check = parseTurnCheck(
      await deps.rpc('ai_register_turn', {
        p_user: userId,
        p_turn: turnId,
        p_model: request.model,
        p_effort: request.effort,
        p_max_tokens: maxTokens,
        p_input_bytes: read.bytes,
      }),
    );
  } catch (err) {
    return rpcFailure(err, logger);
  }
  if (!check) return rpcFailure({ code: 'respuesta-invalida' }, logger);
  if (!check.allowed) {
    const plans = check.reason === 'noplan' ? await loadCatalog(deps, logger) : [];
    const denial = denialResponse(check, plans);
    return json(denial.status, denial.body);
  }
  const { model: questionModel, modelId, effort, switched } = check;
  if (!questionModel || !modelId || !effort) return rpcFailure({ code: 'respuesta-invalida' }, logger);
  if (switched) logger.warn(`[ai-assistant] cambio de saldo: ${switched.from} -> ${switched.to} (${switched.reason})`);
  // Toda respuesta de aquí en adelante avisa el cambio de saldo, si lo hubo.
  const withSwitch = (out: Record<string, unknown>): Record<string, unknown> => (switched ? { ...out, switched } : out);

  // Proveedor de la llamada: el del saldo (0056) o, con una base anterior, el principal de ai_provider_settings.
  // La configuración de proveedores solo hace falta para el respaldo (si el otro proveedor puede tener clave).
  let settings: ProviderSettings;
  if (check.provider) {
    settings = possible[otherProvider(check.provider)] ? await ctx.providerSettings() : ANTHROPIC_ONLY;
  } else {
    settings = possible.openai ? await ctx.providerSettings() : possible.anthropic ? ANTHROPIC_ONLY : OPENAI_ONLY;
  }
  const primary: Provider = check.provider ?? settings.primary;
  const ready: Readiness = { anthropic: false, openai: false };
  ready[primary] = await isProviderReady(deps, logger, primary, possible);
  if (settings.failoverEnabled) {
    const other = otherProvider(primary);
    ready[other] = await isProviderReady(deps, logger, other, possible);
  }
  const targets = callTargets(check, settings);

  const call: ModelCall = {
    model: targets.anthropic ?? modelId,
    fallback: check.fallback,
    task: request.task,
    system: buildSystem(request.task, request.system),
    messages: request.messages,
    tools: request.tools,
    maxTokens: clampMaxTokens(request.maxTokens, check.maxTokensPerRequest),
    effort,
    format,
    schema: request.schema,
  };

  // Orden de los proveedores para esta llamada (el de la llamada y, si el respaldo lo permite, el otro).
  const plan = planAttempts(primary, settings, ready, targets);
  if (!plan.attempts.length) {
    // El proveedor de la llamada no tiene clave (por ejemplo, todavía no se cargó la de Claude): la pregunta se
    // devuelve y la llamada se cierra, sin cobrar nada.
    logger.error(`[ai-assistant] ${primary} no está configurado: no puede atender el modelo ${questionModel}`);
    const quota = await endCall(deps, logger, userId, await releaseTurn(deps, logger, userId, turnId, check), check.callId);
    return notConfigured(quota, primary, switched);
  }

  // Si el launcher canceló antes de que el pedido saliera hacia un proveedor, nadie lo procesó: no se cobra nada, la
  // pregunta se devuelve y la llamada se cierra (como sin proveedor configurado). Responde la cancelación de siempre.
  const clientSignal: AbortSignal | undefined = req.signal;
  if (clientSignal?.aborted) {
    const cancelled = mapUpstreamError({ kind: 'aborted' });
    const quota = await endCall(deps, logger, userId, await releaseTurn(deps, logger, userId, turnId, check), check.callId);
    return json(cancelled.status, withSwitch({ ...cancelled.body, quota }));
  }

  // Plazo máximo (para todos los intentos juntos) y corte si el launcher cancela (así no se sigue pagando una
  // respuesta que nadie lee).
  const clock = deps.now ?? Date.now;
  const deadline = clock() + deps.timeoutMs;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, deps.timeoutMs);
  const onClientAbort = () => controller.abort();
  clientSignal?.addEventListener('abort', onClientAbort, { once: true });

  const failures: Failed[] = [];
  if (plan.primarySkipped) {
    // El de la llamada no puede atender (sin clave): va directo al otro (solo con el respaldo y not_configured).
    failures.push({
      provider: primary,
      model: '',
      failure: { kind: 'unknown', name: 'not_configured' },
      mapped: { status: 503, body: { error: 'upstream', message: MESSAGES.notConfigured, code: 'not_configured' }, release: true, log: null },
      elapsedMs: 0,
      skipped: true,
    });
    logger.warn(`[ai-assistant] respaldo: ${primary} -> ${plan.attempts[0].provider} (not_configured)`);
  }
  let served: Served | null = null;
  let servedIndex = -1;
  try {
    for (let i = 0; i < plan.attempts.length; i++) {
      const attempt = plan.attempts[i];
      const startedAt = clock();
      try {
        served = await runAttempt(attempt, call, controller.signal, deps);
        servedIndex = i;
        break;
      } catch (err) {
        const context: ErrorContext = { timedOut, clientAborted: !timedOut && Boolean(clientSignal?.aborted) };
        const failure = describeAttemptError(attempt, err, context, deps);
        const mapped = mapUpstreamError(failure);
        // Un 400 de OpenAI suele ser un problema de la traducción o de la configuración: queda en el log.
        const level = attempt.provider === 'openai' && mapped.body.code === 'upstream_invalid_request' ? 'error' : mapped.log;
        if (level) logger[level](failureLogLine(failure, mapped, attempt.provider));
        failures.push({ provider: attempt.provider, model: attempt.model, failure, mapped, elapsedMs: Math.max(0, clock() - startedAt) });
        const next = plan.attempts[i + 1];
        if (!next) break;
        // Respaldo solo por fallas del proveedor configuradas en failover_on: nunca por un rechazo de la IA
        // (no es un error), por un pedido inválido (400) ni por una cancelación del launcher.
        const kind = failoverKind(mapped.body.code);
        if (!kind || !settings.failoverOn.has(kind) || context.clientAborted || timedOut) break;
        if (deadline - clock() < MIN_FAILOVER_MS) {
          logger.warn(`[ai-assistant] sin tiempo para el respaldo: ${attempt.provider} -> ${next.provider} (${mapped.body.code})`);
          break;
        }
        logger.warn(`[ai-assistant] respaldo: ${attempt.provider} -> ${next.provider} (${mapped.body.code})`);
      }
    }
  } finally {
    clearTimeout(timer);
    clientSignal?.removeEventListener('abort', onClientAbort);
  }

  if (!served) {
    // Ningún proveedor respondió. Se informa la falla del último que se probó, salvo que haya rechazado el
    // pedido traducido (400) después de que otro proveedor falló: ahí, la de ese otro (para él, el pedido del
    // launcher era válido). Un principal que no se llamó (sin configurar) no cuenta como intento.
    const last = failures[failures.length - 1];
    const earlier = failures.slice(0, -1).find((f) => !f.skipped);
    const final = last.mapped.status === 400 && earlier ? earlier : last;
    // Si la IA pudo haber procesado el pedido (plazo vencido, cancelación o conexión cortada), se cobra una
    // estimación: si no, ese gasto no llegaba al saldo y la misma pregunta se podía repetir sin límite. La entrada,
    // entera; la salida, la que pudo generar en lo que duró ESE intento (a ESTIMATE_OUTPUT_TOKENS_PER_SECOND, de
    // más), nunca más que max_tokens. Esas fallas nunca devuelven la pregunta.
    const billed = failures.filter((f) => !f.skipped && BILLED_KINDS.has(f.failure.kind));
    if (billed.length) {
      const lines = billed.map((f) =>
        estimatedUsageLine(f.model, read.text.length, Math.min(call.maxTokens, Math.ceil((f.elapsedMs / 1000) * ESTIMATE_OUTPUT_TOKENS_PER_SECOND))),
      );
      const quota = await addUsage(deps, logger, userId, questionModel, lines, check.quota, check.callId);
      return json(final.mapped.status, withSwitch({ ...final.mapped.body, quota }));
    }
    // La pregunta nueva se devuelve si ningún proveedor la procesó (saturados o caídos). Un 400 del respaldo
    // que no es la respuesta final no cuenta: ese proveedor tampoco la procesó.
    const release = failures.every((f) => f.mapped.release || (f !== final && f.mapped.status === 400));
    const quota = release ? await releaseTurn(deps, logger, userId, turnId, check) : check.quota;
    return json(final.mapped.status, withSwitch({ ...final.mapped.body, quota: await endCall(deps, logger, userId, quota, check.callId) }));
  }
  const result = served.result;
  const servedBy: ServedBy = {
    provider: served.provider,
    model: typeof result.model === 'string' && result.model ? result.model : served.requested,
    failover: servedIndex > 0 || plan.primarySkipped,
  };

  // Se cuenta todo lo que informó la API, también en respuestas cortadas o rechazadas. Cada intento
  // (también los reintentos en otro modelo) va con el modelo que lo corrió: la base lo cobra con su precio.
  // La pregunta sigue en el modelo de Venus (questionModel: haiku o sonnet), la atienda quien la atienda.
  const quota = await addUsage(deps, logger, userId, questionModel, served.lines, check.quota, check.callId);

  // Un rechazo de la IA nunca pasa al otro proveedor.
  if (result.stop_reason === 'refusal') return json(422, withSwitch({ error: 'refusal', quota }));

  const out: Record<string, unknown> = {
    message: { content: result.content, stop_reason: result.stop_reason, usage: result.usage, model: result.model, served_by: servedBy },
    quota,
  };
  if (request.task === 'json') out.parsed = result.parsed ?? null;
  return json(200, withSwitch(out));
}

async function handle(req: Request, deps: Deps, logger: Logger, ctx: HandlerContext): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...CORS_HEADERS } });
  if (req.method !== 'GET' && req.method !== 'POST') {
    return json(
      405,
      { error: 'bad_request', code: 'method_not_allowed', message: 'Método no permitido (usá GET o POST).' },
      { Allow: 'GET, POST, OPTIONS' },
    );
  }
  if (!deps.supabaseReady) return json(503, { error: 'upstream', message: MESSAGES.notConfigured, code: 'not_configured' });

  const token = bearerToken(req.headers.get('authorization'));
  if (!token) return json(401, { error: 'unauthorized' });
  let auth: AuthResult;
  try {
    auth = await deps.verifyUser(token);
  } catch {
    auth = { status: 'unavailable' };
  }
  if (auth.status === 'invalid') return json(401, { error: 'unauthorized' });
  if (auth.status === 'forbidden') {
    return json(403, { error: 'unauthorized', code: auth.reason, message: FORBIDDEN_MESSAGES[auth.reason] });
  }
  if (auth.status !== 'ok') return json(503, { error: 'upstream', message: MESSAGES.authUnavailable, code: 'auth_unavailable' });

  if (req.method === 'GET') {
    // Estado del plan y catálogo de planes, sin llamar a la IA.
    try {
      const [rawQuota, rawPlans] = await Promise.all([
        deps.rpc('ai_quota_status', { p_user: auth.userId }),
        deps.rpc('ai_catalog', {}),
      ]);
      const quota = normalizeQuota(rawQuota);
      if (!quota) return rpcFailure({ code: 'respuesta-invalida' }, logger);
      return json(200, { quota, plans: normalizeCatalog(rawPlans) });
    } catch (err) {
      return rpcFailure(err, logger);
    }
  }
  return handlePost(req, deps, logger, auth.userId, ctx);
}

/** Handler para Deno.serve. */
export function createHandler(deps: Deps): (req: Request) => Promise<Response> {
  const logger: Logger = deps.logger ?? console;
  const ctx = createContext(deps, logger);
  return async (req: Request): Promise<Response> => {
    try {
      return await handle(req, deps, logger, ctx);
    } catch (err) {
      logger.error(`[ai-assistant] error interno: ${errorName(err)}`);
      return json(500, { error: 'upstream', message: MESSAGES.internal, code: 'internal' });
    }
  };
}
