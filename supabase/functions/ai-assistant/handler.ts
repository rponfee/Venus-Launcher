// Flujo HTTP de la Edge Function "ai-assistant" (protocolos 1 y 2 del launcher, ver docs/backend-ia.md).
// No importa nada de npm ni de Deno: index.ts le pasa las dependencias reales (Supabase y los SDK de
// Anthropic y de OpenAI) y las pruebas le pasan dobles. Nunca registra contenido de la conversación.
// Proveedores: Anthropic es el principal y OpenAI el respaldo (providers.ts). Si el principal falla por un
// problema del proveedor (no por un rechazo de la IA ni por un pedido inválido), el pedido pasa al otro.
import { CORS_HEADERS, LIMITS, MIN_FAILOVER_MS, PROVIDER_SETTINGS_TTL_MS } from './config.ts';
import type { Effort, Provider, Task } from './config.ts';
import { failureLogLine, mapUpstreamError, MESSAGES } from './errors.ts';
import type { MappedError, UpstreamFailure } from './errors.ts';
import { buildOpenAIRequest, fromOpenAIResponse, openaiUsageLines, UpstreamResponseError } from './openai.ts';
import { buildSystem } from './policy.ts';
import type { SystemBlock } from './policy.ts';
import { ANTHROPIC_ONLY, failoverKind, parseProviderSettings, planAttempts } from './providers.ts';
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
import type { CatalogPlan, Quota, TurnCheck, UsageLine } from './quota.ts';
import { validateRequest } from './validate.ts';

export type AuthResult =
  | { status: 'ok'; userId: string }
  | { status: 'invalid' }
  | { status: 'forbidden'; reason: 'anonymous' | 'unconfirmed' }
  | { status: 'unavailable' };

/** Pedido ya armado para la IA: el modelo y el esfuerzo salen del plan y el system empieza con la política. */
export interface ModelCall {
  /** Id del modelo en la API de Anthropic (ai_models.model_id; nunca el texto del cliente). */
  model: string;
  /** Mandar `fallbacks: "default"` con su beta (solo Opus 5.5 y Sonnet 5.5). */
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
  /** Está ANTHROPIC_API_KEY (proveedor principal). */
  modelReady: boolean;
  /** Está OPENAI_API_KEY (proveedor secundario). Sin el campo, como si no estuviera. */
  openaiReady?: boolean;
  /** Tiempo máximo de espera a la IA (ms), para todos los intentos juntos. */
  timeoutMs: number;
  verifyUser(token: string): Promise<AuthResult>;
  /** Llama a una función SQL con la service role. Si falla lanza un error con `code`. */
  rpc(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** Prepara el formato de salida estructurada. Lanza si el schema no sirve. */
  prepareFormat(schema: Record<string, unknown>): unknown;
  /** Llama a Anthropic (Claude). */
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
  /** true si respondió el proveedor secundario porque el principal falló o no está configurado. */
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

export type BodyRead = { ok: true; text: string } | { ok: false; reason: 'too_large' | 'unreadable' };

/** Lee el cuerpo sin pasar `limit` bytes (corta apenas se pasa) y lo decodifica como UTF-8 estricto. */
export async function readBody(req: Request, limit: number): Promise<BodyRead> {
  const declared = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > limit) return { ok: false, reason: 'too_large' };
  if (!req.body) return { ok: true, text: '' };
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
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
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
    let settings: ProviderSettings = ANTHROPIC_ONLY;
    try {
      const parsed = parseProviderSettings(await deps.rpc('ai_provider_settings', {}));
      if (parsed) settings = parsed;
      else logger.warn('[ai-assistant] la configuración de proveedores no tiene la forma esperada: se usa solo Anthropic');
    } catch (err) {
      // Sin la migración 0011 (o con la base caída): solo Anthropic, como antes.
      logger.warn(`[ai-assistant] no se pudo leer la configuración de proveedores (${rpcCode(err)}): se usa solo Anthropic`);
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

/** Modelo que corre un intento: el de la pregunta en Anthropic o el de respaldo en OpenAI (ids de ai_models.model_id). */
function attemptModel(attempt: Attempt, call: ModelCall): string {
  return attempt.provider === 'anthropic' ? call.model : attempt.tier.model;
}

/** Un intento con un proveedor. Lanza si el proveedor falla (también si OpenAI responde con status "failed"). */
async function runAttempt(attempt: Attempt, call: ModelCall, signal: AbortSignal, deps: Deps): Promise<Served> {
  if (attempt.provider === 'anthropic') {
    // Igual que siempre: el SDK de Anthropic con el pedido intacto (index.ts).
    const result = await deps.callModel(call, signal);
    return { provider: 'anthropic', result, lines: usageLines(result.usage, call.model, result.model), requested: call.model };
  }
  if (!deps.callOpenAI) throw new Error('sin cliente de OpenAI');
  const target = { model: attempt.tier.model, effort: attempt.tier.efforts[call.effort] };
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

/** Respuesta 503 not_configured (falta la clave del proveedor, o ningún proveedor puede atender). */
function notConfigured(quota?: Quota): Response {
  return json(503, { error: 'upstream', message: MESSAGES.notConfigured, code: 'not_configured', ...(quota ? { quota } : {}) });
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
async function endCall(deps: Deps, logger: Logger, userId: string, quota: Quota): Promise<Quota> {
  try {
    return normalizeQuota(await deps.rpc('ai_end_call', { p_user: userId })) ?? quota;
  } catch (err) {
    logger.warn(`[ai-assistant] no se pudo cerrar la llamada: ${rpcCode(err)}`);
    return quota;
  }
}

/** Registra el uso de una llamada y su costo (ai_add_usage, que además la cierra). Si falla, sigue con `quota`. */
async function addUsage(deps: Deps, logger: Logger, userId: string, model: string, lines: UsageLine[], quota: Quota): Promise<Quota> {
  try {
    const usage = parseUsageResult(await deps.rpc('ai_add_usage', { p_user: userId, p_model: model, p_usage: lines }));
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

async function handlePost(req: Request, deps: Deps, logger: Logger, userId: string, ctx: HandlerContext): Promise<Response> {
  const ready: Readiness = { anthropic: deps.modelReady, openai: Boolean(deps.openaiReady && deps.callOpenAI) };
  if (!ready.anthropic && !ready.openai) return notConfigured();

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

  // Proveedores: sin OPENAI_API_KEY no hay nada que leer (solo Anthropic, exactamente como antes). Si ningún
  // proveedor puede atender, se corta acá, antes de gastar una pregunta.
  const settings = ready.openai ? await ctx.providerSettings() : ANTHROPIC_ONLY;
  if (!planAttempts(settings, ready, request.model).attempts.length) return notConfigured();

  // Plan y cuota: resuelve el modelo y el esfuerzo, abre la pregunta (turn_id) o suma una llamada a una
  // pregunta ya abierta. Todo en la base, en una sola transacción (ai_register_turn). La pregunta se cuenta
  // siempre en el modelo de Venus (haiku, sonnet u opus), la atienda el proveedor que la atienda.
  const turnId = request.turnId ?? newTurnId();
  let check: TurnCheck | null;
  try {
    check = parseTurnCheck(
      await deps.rpc('ai_register_turn', { p_user: userId, p_turn: turnId, p_model: request.model, p_effort: request.effort }),
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
  const { model: questionModel, modelId, effort } = check;
  if (!questionModel || !modelId || !effort) return rpcFailure({ code: 'respuesta-invalida' }, logger);

  const call: ModelCall = {
    model: modelId,
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

  // Orden de los proveedores para esta pregunta (el principal y, si el respaldo lo permite, el secundario).
  const plan = planAttempts(settings, ready, questionModel);
  if (!plan.attempts.length) {
    // Por ejemplo: OpenAI es el único proveedor disponible y no tiene un modelo para esta pregunta.
    logger.error(`[ai-assistant] ningún proveedor puede atender el modelo ${questionModel}`);
    return notConfigured(await endCall(deps, logger, userId, await releaseTurn(deps, logger, userId, turnId, check)));
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
  const clientSignal: AbortSignal | undefined = req.signal;
  const onClientAbort = () => controller.abort();
  clientSignal?.addEventListener('abort', onClientAbort, { once: true });

  const failures: Failed[] = [];
  if (plan.primarySkipped) {
    // El principal no puede atender (por ejemplo, falta ANTHROPIC_API_KEY): va directo al secundario.
    failures.push({
      provider: settings.primary,
      model: '',
      failure: { kind: 'unknown', name: 'not_configured' },
      mapped: { status: 503, body: { error: 'upstream', message: MESSAGES.notConfigured, code: 'not_configured' }, release: true, log: null },
      skipped: true,
    });
    logger.warn(`[ai-assistant] respaldo: ${settings.primary} -> ${plan.attempts[0].provider} (not_configured)`);
  }
  let served: Served | null = null;
  let servedIndex = -1;
  try {
    if (clientSignal?.aborted) controller.abort();
    for (let i = 0; i < plan.attempts.length; i++) {
      const attempt = plan.attempts[i];
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
        failures.push({ provider: attempt.provider, model: attemptModel(attempt, call), failure, mapped });
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
    // estimación del peor caso: si no, ese gasto no llegaba al presupuesto y la misma pregunta se podía repetir
    // sin límite. Esas fallas nunca devuelven la pregunta.
    const billed = failures.filter((f) => !f.skipped && BILLED_KINDS.has(f.failure.kind));
    if (billed.length) {
      const lines = billed.map((f) => estimatedUsageLine(f.model, read.text.length, call.maxTokens));
      return json(final.mapped.status, { ...final.mapped.body, quota: await addUsage(deps, logger, userId, questionModel, lines, check.quota) });
    }
    // La pregunta nueva se devuelve si ningún proveedor la procesó (saturados o caídos). Un 400 del respaldo
    // que no es la respuesta final no cuenta: ese proveedor tampoco la procesó.
    const release = failures.every((f) => f.mapped.release || (f !== final && f.mapped.status === 400));
    const quota = release ? await releaseTurn(deps, logger, userId, turnId, check) : check.quota;
    return json(final.mapped.status, { ...final.mapped.body, quota: await endCall(deps, logger, userId, quota) });
  }
  const result = served.result;
  const servedBy: ServedBy = {
    provider: served.provider,
    model: typeof result.model === 'string' && result.model ? result.model : served.requested,
    failover: servedIndex > 0 || plan.primarySkipped,
  };

  // Se cuenta todo lo que informó la API, también en respuestas cortadas o rechazadas. Cada intento
  // (también los reintentos en otro modelo) va con el modelo que lo corrió: la base lo cobra con su precio.
  // La pregunta sigue en el modelo de Venus (questionModel); el uso de OpenAI queda en la fila de su modelo.
  const quota = await addUsage(deps, logger, userId, questionModel, served.lines, check.quota);

  // Un rechazo de la IA nunca pasa al otro proveedor.
  if (result.stop_reason === 'refusal') return json(422, { error: 'refusal', quota });

  const out: Record<string, unknown> = {
    message: { content: result.content, stop_reason: result.stop_reason, usage: result.usage, model: result.model, served_by: servedBy },
    quota,
  };
  if (request.task === 'json') out.parsed = result.parsed ?? null;
  return json(200, out);
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
