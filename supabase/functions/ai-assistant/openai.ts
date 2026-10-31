// Traducción entre el formato de Anthropic (el que habla el launcher) y la Responses API de OpenAI, para
// cuando OpenAI atiende un pedido (proveedor secundario o, si se configura así, principal).
// Sin dependencias externas: index.ts hace la llamada con el SDK oficial de OpenAI; acá solo se arma el
// pedido y se traduce la respuesta, así que se prueba con Node. Nunca registra contenido.
//
// Ida (Anthropic -> OpenAI):
//   system (política del servidor + system del launcher)  -> instructions
//   mensajes del usuario: text / image                    -> mensaje "user" con input_text / input_image
//   tool_result                                           -> function_call_output (call_id = tool_use_id)
//   mensajes de la IA: text                               -> mensaje "assistant" (phase commentary/final_answer)
//   tool_use                                              -> function_call (call_id = id del tool_use)
//   thinking, redacted_thinking, fallback                 -> se omiten (son de Anthropic; OpenAI no los lee)
//   tools (name, description, input_schema, strict)      -> function tools (parameters, strict)
//   effort low/medium/high                                -> reasoning.effort (según ai_tier_fallbacks)
//   max_tokens                                            -> max_output_tokens
//   task "json" + schema                                  -> text.format json_schema (strict si se puede)
// Vuelta (OpenAI -> Anthropic): content [text, tool_use], stop_reason, usage y model.
import { OPENAI_MIN_OUTPUT_TOKENS, OPENAI_MODEL_PATTERN } from './config.ts';
import type { Effort, OpenAIEffort, Task } from './config.ts';
import type { UpstreamFailure } from './errors.ts';
import type { SystemBlock } from './policy.ts';
import type { UsageLine } from './quota.ts';

/** Lo que hace falta del pedido ya armado (handler.ts ModelCall cumple esta forma). */
export interface OpenAICallInput {
  task: Task;
  system: SystemBlock[];
  messages: unknown[];
  tools: Record<string, unknown>[] | null;
  /** JSON Schema de la respuesta (task "json"). */
  schema: Record<string, unknown> | null;
  maxTokens: number;
  effort: Effort;
}

export interface OpenAITarget {
  /** Id del modelo en la API de OpenAI (de ai_models, nunca del cliente). */
  model: string;
  /** reasoning.effort, o null para no mandarlo. */
  effort: OpenAIEffort | null;
}

/**
 * Qué propiedades opcionales se volvieron obligatorias con null para el modo estricto de OpenAI. Al volver,
 * un null en esas propiedades se quita (para el launcher, la propiedad no vino).
 */
export interface NullTree {
  added?: string[];
  props?: Record<string, NullTree>;
  items?: NullTree;
}

export interface OpenAIRequest {
  /** Cuerpo para responses.create (sin streaming). */
  body: Record<string, unknown>;
  restore: { tools: Map<string, NullTree>; format: NullTree | null };
}

/** Respuesta traducida a la forma de Anthropic (la misma que handler.ts ModelResult). */
export interface TranslatedResult {
  content: Record<string, unknown>[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal';
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };
  model: string;
  parsed: unknown;
}

/** Nombre del formato de salida estructurada (letras, números, _ y -). */
export const JSON_FORMAT_NAME = 'venus_respuesta';

/** Prefijo de un tool_result con is_error (OpenAI no tiene ese campo). */
export const TOOL_ERROR_PREFIX = 'Error: ';

/** Ids que acepta el launcher (validate.ts) y Anthropic para un tool_use. */
const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,200}$/;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,128}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

// ---------- Esquemas en modo estricto ----------

// Palabras de JSON Schema que acepta el modo estricto de OpenAI (structured outputs, "Supported schemas").
const STRICT_KEYWORDS: ReadonlySet<string> = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description',
  'pattern', 'format', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minItems', 'maxItems',
]);
// Anotaciones que no cambian la validación: se quitan en la versión estricta.
const ANNOTATIONS: ReadonlySet<string> = new Set(['title', 'default', 'examples', '$comment']);
const STRICT_TYPES: ReadonlySet<string> = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
const STRICT_FORMATS: ReadonlySet<string> = new Set(['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'ipv4', 'ipv6', 'uuid']);
const MAX_STRICT_DEPTH = 10;
const MAX_STRICT_PROPERTIES = 5000;

function typesOf(node: Record<string, unknown>): string[] | null {
  if (node.type === undefined) return [];
  if (typeof node.type === 'string') return [node.type];
  if (Array.isArray(node.type) && node.type.every((t) => typeof t === 'string')) return node.type as string[];
  return null;
}

function acceptsNull(node: Record<string, unknown>): boolean {
  if ((typesOf(node) ?? []).includes('null')) return true;
  if (Array.isArray(node.enum) && node.enum.includes(null)) return true;
  return 'const' in node && node.const === null;
}

/** La misma propiedad aceptando además null (para emular una propiedad opcional en modo estricto). */
function withNull(node: Record<string, unknown>): Record<string, unknown> | null {
  const types = typesOf(node);
  if (types === null) return null;
  const out: Record<string, unknown> = { ...node };
  if (types.length) out.type = [...types, 'null'];
  if (Array.isArray(node.enum)) out.enum = [...node.enum, null];
  else if ('const' in node) {
    delete out.const;
    out.enum = [node.const, null];
  }
  if (!types.length && !Array.isArray(node.enum) && !('const' in node)) return null;
  return out;
}

function strictNode(node: unknown, depth: number, budget: { props: number }): { schema: Record<string, unknown>; tree: NullTree | null } | null {
  if (!isObject(node) || depth > MAX_STRICT_DEPTH) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (ANNOTATIONS.has(key)) continue;
    if (!STRICT_KEYWORDS.has(key)) return null;
    out[key] = value;
  }
  const types = typesOf(node);
  if (types === null || types.some((t) => !STRICT_TYPES.has(t))) return null;
  if (node.format !== undefined && (typeof node.format !== 'string' || !STRICT_FORMATS.has(node.format))) return null;
  const isObj = types.includes('object') || (!types.length && node.properties !== undefined);
  const isArr = types.includes('array') || (!types.length && node.items !== undefined);
  if (isObj && isArr) return null;
  if (!types.length && !isObj && !isArr && !Array.isArray(node.enum) && !('const' in node)) return null;

  if (isObj) {
    if (node.additionalProperties !== undefined && node.additionalProperties !== false) return null;
    const props = node.properties === undefined ? {} : node.properties;
    if (!isObject(props)) return null;
    const required = node.required === undefined ? [] : node.required;
    if (!Array.isArray(required) || !required.every((r) => typeof r === 'string')) return null;
    const keys = Object.keys(props);
    budget.props += keys.length;
    if (budget.props > MAX_STRICT_PROPERTIES) return null;
    const outProps: Record<string, unknown> = {};
    const tree: NullTree = {};
    for (const key of keys) {
      const child = strictNode(props[key], depth + 1, budget);
      if (!child) return null;
      let schema = child.schema;
      if (!required.includes(key) && !acceptsNull(schema)) {
        const nullable = withNull(schema);
        if (!nullable) return null;
        schema = nullable;
        (tree.added ??= []).push(key);
      }
      outProps[key] = schema;
      if (child.tree) (tree.props ??= {})[key] = child.tree;
    }
    out.properties = outProps;
    out.required = keys;
    out.additionalProperties = false;
    if (!types.length) out.type = 'object';
    return { schema: out, tree: tree.added || tree.props ? tree : null };
  }
  if (isArr) {
    if (node.items === undefined) return null;
    const child = strictNode(node.items, depth + 1, budget);
    if (!child) return null;
    out.items = child.schema;
    return { schema: out, tree: child.tree ? { items: child.tree } : null };
  }
  return { schema: out, tree: null };
}

/**
 * Versión del esquema para el modo estricto de OpenAI: todas las propiedades obligatorias (las opcionales
 * aceptan null) y additionalProperties false en todos los objetos. null si usa algo que el modo estricto no
 * acepta (anyOf, $ref, additionalProperties con esquema...): en ese caso se manda el esquema tal cual, sin modo
 * estricto (el launcher igual valida todo de nuevo).
 */
export function strictSchema(schema: unknown): { schema: Record<string, unknown>; tree: NullTree | null } | null {
  if (!isObject(schema) || schema.type !== 'object') return null;
  return strictNode(schema, 1, { props: 0 });
}

/** Quita los null que agregó strictSchema en propiedades que eran opcionales. */
export function restoreNulls(value: unknown, tree: NullTree | null | undefined): unknown {
  if (!tree) return value;
  if (Array.isArray(value)) return tree.items ? value.map((item) => restoreNulls(item, tree.items)) : value;
  if (!isObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null && tree.added?.includes(key)) continue;
    out[key] = tree.props?.[key] ? restoreNulls(item, tree.props[key]) : item;
  }
  return out;
}

// ---------- Ida: Anthropic -> OpenAI ----------

type Item = Record<string, unknown>;

function imagePart(block: Record<string, unknown>): Item | null {
  const source = isObject(block.source) ? block.source : null;
  if (!source || source.type !== 'base64' || typeof source.media_type !== 'string' || typeof source.data !== 'string') return null;
  return { type: 'input_image', image_url: `data:${source.media_type};base64,${source.data}`, detail: 'auto' };
}

function toolOutput(block: Record<string, unknown>): Item {
  const parts: Item[] = [];
  const content = block.content;
  if (typeof content === 'string') parts.push({ type: 'input_text', text: content });
  else if (Array.isArray(content)) {
    for (const part of content) {
      if (!isObject(part)) continue;
      if (part.type === 'text' && typeof part.text === 'string') parts.push({ type: 'input_text', text: part.text });
      else if (part.type === 'image') {
        const image = imagePart(part);
        if (image) parts.push(image);
      }
    }
  }
  const failed = block.is_error === true;
  let output: string | Item[];
  if (parts.every((p) => p.type === 'input_text')) {
    output = `${failed ? TOOL_ERROR_PREFIX : ''}${parts.map((p) => p.text as string).join('\n\n')}`;
  } else {
    output = failed ? [{ type: 'input_text', text: TOOL_ERROR_PREFIX.trim() }, ...parts] : parts;
  }
  return { type: 'function_call_output', call_id: String(block.tool_use_id), output };
}

function userItems(content: unknown): Item[] {
  if (typeof content === 'string') return [{ role: 'user', content }];
  if (!Array.isArray(content)) return [];
  const out: Item[] = [];
  let parts: Item[] = [];
  const flush = () => {
    if (parts.length) out.push({ role: 'user', content: parts });
    parts = [];
  };
  for (const block of content) {
    if (!isObject(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push({ type: 'input_text', text: block.text });
    else if (block.type === 'image') {
      const image = imagePart(block);
      if (image) parts.push(image);
    } else if (block.type === 'tool_result') {
      // Las salidas de herramientas van como items propios, en el mismo orden.
      flush();
      out.push(toolOutput(block));
    }
  }
  flush();
  return out;
}

function assistantItems(content: unknown): Item[] {
  if (typeof content === 'string') return content.trim() ? [{ role: 'assistant', content, phase: 'final_answer' }] : [];
  if (!Array.isArray(content)) return [];
  // Texto antes de llamar herramientas = comentario intermedio; sin herramientas = respuesta final.
  const phase = content.some((b) => isObject(b) && b.type === 'tool_use') ? 'commentary' : 'final_answer';
  const out: Item[] = [];
  let text: string[] = [];
  const flush = () => {
    if (text.length) out.push({ role: 'assistant', content: text.join('\n\n'), phase });
    text = [];
  };
  for (const block of content) {
    if (!isObject(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      if (block.text.trim()) text.push(block.text);
    } else if (block.type === 'tool_use') {
      flush();
      // Sin "id" del item: es un item armado acá, no uno guardado en OpenAI (store: false).
      out.push({
        type: 'function_call',
        call_id: String(block.id),
        name: String(block.name),
        arguments: JSON.stringify(isObject(block.input) ? block.input : {}),
      });
    }
    // thinking, redacted_thinking y fallback: son de Anthropic y se omiten (siguen en la conversación del launcher).
  }
  flush();
  return out;
}

/** Mensajes del launcher (formato Anthropic) como items de input de la Responses API. */
export function toOpenAIInput(messages: unknown[]): Item[] {
  const items: Item[] = [];
  for (const message of messages) {
    if (!isObject(message)) continue;
    if (message.role === 'user') items.push(...userItems(message.content));
    else if (message.role === 'assistant') items.push(...assistantItems(message.content));
  }
  return items;
}

/** Herramientas del launcher como function tools (strict solo si el launcher lo pidió y el esquema lo permite). */
export function toOpenAITools(tools: Record<string, unknown>[]): { tools: Item[]; trees: Map<string, NullTree> } {
  const trees = new Map<string, NullTree>();
  const out = tools.map((tool) => {
    const name = String(tool.name);
    const strict = tool.strict === true ? strictSchema(tool.input_schema) : null;
    if (strict?.tree) trees.set(name, strict.tree);
    const fn: Item = { type: 'function', name };
    if (typeof tool.description === 'string') fn.description = tool.description;
    fn.parameters = strict ? strict.schema : tool.input_schema;
    fn.strict = Boolean(strict);
    return fn;
  });
  return { tools: out, trees };
}

/**
 * Pedido completo para responses.create. Nunca manda temperature, top_p, tool_choice ni nada que el plan no
 * controle. store: false para que OpenAI no guarde la respuesta (el launcher manda siempre la conversación entera).
 */
export function buildOpenAIRequest(call: OpenAICallInput, target: OpenAITarget): OpenAIRequest {
  const body: Record<string, unknown> = {
    model: target.model,
    instructions: call.system.map((block) => block.text).join('\n\n'),
    input: toOpenAIInput(call.messages),
    max_output_tokens: Math.max(OPENAI_MIN_OUTPUT_TOKENS, Math.floor(call.maxTokens)),
    store: false,
  };
  if (target.effort) body.reasoning = { effort: target.effort };
  let trees = new Map<string, NullTree>();
  if (call.tools && call.tools.length) {
    const converted = toOpenAITools(call.tools);
    body.tools = converted.tools;
    trees = converted.trees;
  }
  let format: NullTree | null = null;
  if (call.task === 'json' && call.schema) {
    const strict = strictSchema(call.schema);
    body.text = { format: { type: 'json_schema', name: JSON_FORMAT_NAME, schema: strict ? strict.schema : call.schema, strict: Boolean(strict) } };
    format = strict?.tree ?? null;
  }
  return { body, restore: { tools: trees, format } };
}

// ---------- Vuelta: OpenAI -> Anthropic ----------

/** Respuesta de OpenAI que en realidad es una falla (status "failed"): el handler la trata como un error. */
export class UpstreamResponseError extends Error {
  readonly failure: UpstreamFailure;
  constructor(failure: UpstreamFailure) {
    super('respuesta fallida del proveedor');
    this.name = 'UpstreamResponseError';
    this.failure = failure;
  }
}

// Fallas de seguridad de OpenAI: son rechazos de la IA (nunca pasan al otro proveedor).
const SAFETY_CODES: ReadonlySet<string> = new Set(['bio_policy', 'misalignment_policy_violation', 'image_content_policy_violation', 'invalid_prompt']);
const RETRYABLE_CODES: Readonly<Record<string, { status: number; type: string }>> = {
  server_error: { status: 500, type: 'api_error' },
  rate_limit_exceeded: { status: 429, type: 'rate_limit_error' },
  vector_store_timeout: { status: 504, type: 'timeout_error' },
  data_residency_mismatch: { status: 403, type: 'permission_error' },
};

function failedResponse(error: unknown): UpstreamFailure {
  const code = isObject(error) && typeof error.code === 'string' ? error.code : '';
  const detail = isObject(error) && typeof error.message === 'string' ? error.message : null;
  const known = RETRYABLE_CODES[code];
  if (known) return { kind: 'status', status: known.status, type: known.type, detail: null, requestId: null };
  // Imágenes inválidas y otros problemas del pedido: 400 (no pasa al otro proveedor).
  if (code) return { kind: 'status', status: 400, type: 'invalid_request_error', detail, requestId: null };
  return { kind: 'status', status: 500, type: 'api_error', detail: null, requestId: null };
}

/** Uso de OpenAI con la forma de Anthropic: input_tokens es solo la entrada sin caché. */
export function anthropicUsage(usage: unknown): TranslatedResult['usage'] {
  const raw: Record<string, unknown> = isObject(usage) ? usage : {};
  const details: Record<string, unknown> = isObject(raw.input_tokens_details) ? raw.input_tokens_details : {};
  const total = count(raw.input_tokens);
  const cached = count(details.cached_tokens);
  const written = count(details.cache_write_tokens);
  return {
    input_tokens: Math.max(total - cached - written, 0),
    output_tokens: count(raw.output_tokens),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: written,
  };
}

/**
 * Renglón de costo para ai_add_usage, con el modelo PEDIDO (el id de ai_models; la respuesta puede traer un
 * snapshot con fecha). input_tokens de OpenAI incluye la caché: acá se separa en entrada sin caché, lectura
 * (cached_tokens) y escritura (cache_write_tokens). La salida incluye el razonamiento. La escritura de 12 horas
 * cuesta el doble que la de 30 minutos (la que tiene ai_models): cada token de 12 h cuenta como dos.
 */
export function openaiUsageLines(usage: unknown, model: string): UsageLine[] {
  if (!isObject(usage)) return [];
  const translated = anthropicUsage(usage);
  const details: Record<string, unknown> = isObject(usage.input_tokens_details) ? usage.input_tokens_details : {};
  const ttl: Record<string, unknown> = isObject(details.cache_write_tokens_details) ? details.cache_write_tokens_details : {};
  const longLived = Math.min(count(ttl.ttl_12h_tokens), translated.cache_creation_input_tokens);
  return [{
    model,
    input: translated.input_tokens,
    output: translated.output_tokens,
    cacheRead: translated.cache_read_input_tokens,
    cacheWrite: translated.cache_creation_input_tokens + longLived,
  }];
}

function toolUseId(callId: unknown, index: number, used: Set<string>): string {
  let id = typeof callId === 'string' && TOOL_USE_ID.test(callId)
    ? callId
    : `call_${index}_${String(callId ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)}`;
  while (used.has(id)) id = `${id}_${index}`;
  used.add(id);
  return id;
}

function toolName(name: unknown): string {
  if (typeof name === 'string' && TOOL_NAME.test(name)) return name;
  const clean = String(name ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128);
  return clean || 'herramienta_desconocida';
}

function parseArguments(raw: unknown): Record<string, unknown> {
  if (isObject(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const value = JSON.parse(raw);
    return isObject(value) ? value : {};
  } catch {
    // Argumentos cortados o inválidos: el launcher valida la entrada y le contesta el error a la IA.
    return {};
  }
}

/**
 * Traduce la respuesta de responses.create a la forma de Anthropic que espera el launcher.
 * - content: [{ type: 'text', text }] y [{ type: 'tool_use', id: call_id, name, input }], en orden. Los ids de
 *   las llamadas pasan tal cual (así el tool_result del launcher vuelve con el mismo call_id, a OpenAI o a
 *   Anthropic). Los items de razonamiento se omiten.
 * - stop_reason: refusal (rechazo o filtro de contenido), max_tokens (respuesta incompleta), tool_use o end_turn.
 * Lanza UpstreamResponseError si la respuesta vino con status "failed" (salvo los rechazos de seguridad).
 */
export function fromOpenAIResponse(raw: unknown, request: OpenAIRequest, task: Task, requestedModel: string): TranslatedResult {
  if (!isObject(raw)) throw new UpstreamResponseError({ kind: 'unknown', name: 'OpenAIResponse' });
  const status = raw.status === undefined ? 'completed' : raw.status;
  const usage = anthropicUsage(raw.usage);
  const model = typeof raw.model === 'string' && OPENAI_MODEL_PATTERN.test(raw.model) ? raw.model : requestedModel;
  if (status === 'failed') {
    const code = isObject(raw.error) && typeof raw.error.code === 'string' ? raw.error.code : '';
    if (SAFETY_CODES.has(code)) return { content: [], stop_reason: 'refusal', usage, model, parsed: null };
    throw new UpstreamResponseError(failedResponse(raw.error));
  }
  if (status !== 'completed' && status !== 'incomplete') {
    throw new UpstreamResponseError({ kind: 'unknown', name: `status ${String(status).slice(0, 20)}` });
  }

  const content: Record<string, unknown>[] = [];
  const used = new Set<string>();
  const texts: string[] = [];
  let refusal = false;
  let calls = 0;
  const output = Array.isArray(raw.output) ? raw.output : [];
  for (const item of output) {
    if (!isObject(item)) continue;
    if (item.type === 'message') {
      for (const part of Array.isArray(item.content) ? item.content : []) {
        if (!isObject(part)) continue;
        if (part.type === 'output_text' && typeof part.text === 'string' && part.text) {
          content.push({ type: 'text', text: part.text });
          texts.push(part.text);
        } else if (part.type === 'refusal') {
          refusal = true;
        }
      }
    } else if (item.type === 'function_call') {
      const name = toolName(item.name);
      const input = restoreNulls(parseArguments(item.arguments), request.restore.tools.get(name));
      content.push({ type: 'tool_use', id: toolUseId(item.call_id, calls, used), name, input: isObject(input) ? input : {} });
      calls++;
    }
    // reasoning y cualquier otro tipo de item: no se guardan en la conversación.
  }

  const incomplete = status === 'incomplete' ? (isObject(raw.incomplete_details) ? raw.incomplete_details.reason : null) : null;
  let stop: TranslatedResult['stop_reason'];
  if (refusal || incomplete === 'content_filter') stop = 'refusal';
  else if (status === 'incomplete') stop = 'max_tokens';
  else if (calls) stop = 'tool_use';
  else stop = 'end_turn';

  let parsed: unknown = null;
  if (task === 'json' && stop === 'end_turn') {
    try {
      const value = JSON.parse(texts.join(''));
      parsed = isObject(value) ? restoreNulls(value, request.restore.format) : null;
    } catch {
      parsed = null;
    }
  }
  return { content: stop === 'refusal' ? [] : content, stop_reason: stop, usage, model, parsed };
}

// ---------- Errores del SDK ----------

const BILLING_CODES: ReadonlySet<string> = new Set(['insufficient_quota', 'billing_hard_limit_reached', 'billing_not_active']);
const CONFIG_CODES: ReadonlySet<string> = new Set(['unsupported_parameter', 'unsupported_value', 'invalid_value']);
// Parámetros que pone el servidor (no el usuario): un 400 por estos es un problema de configuración.
const SERVER_PARAMS = /^(model|reasoning|store|max_output_tokens|text\.verbosity|prompt_cache|service_tier)/;

/**
 * Error HTTP de la API de OpenAI como UpstreamFailure, con los tipos de Anthropic que entiende errors.ts:
 * sin crédito (insufficient_quota) -> billing_error; 401 -> authentication_error; 403 -> permission_error;
 * 404 o model_not_found -> not_found_error; 429 -> rate_limit_error; 5xx -> api_error (504 timeout_error);
 * 400 por un parámetro del servidor (por ejemplo un esfuerzo que el modelo no acepta) -> config_error;
 * otros 400 -> invalid_request_error.
 */
export function openaiStatusFailure(info: { status?: unknown; type?: unknown; code?: unknown; param?: unknown; message?: unknown; requestId?: unknown }): UpstreamFailure {
  const status = typeof info.status === 'number' ? info.status : null;
  const code = typeof info.code === 'string' ? info.code : '';
  const type = typeof info.type === 'string' ? info.type : '';
  const param = typeof info.param === 'string' ? info.param : '';
  let mapped: string;
  if (BILLING_CODES.has(code) || BILLING_CODES.has(type)) mapped = 'billing_error';
  else if (status === 401) mapped = 'authentication_error';
  else if (status === 403) mapped = 'permission_error';
  else if (status === 404 || code === 'model_not_found') mapped = 'not_found_error';
  else if (status === 429) mapped = 'rate_limit_error';
  else if (status === 529 || /overloaded/i.test(code) || /overloaded/i.test(type)) mapped = 'overloaded_error';
  else if (status === 504) mapped = 'timeout_error';
  else if (status !== null && status >= 500) mapped = 'api_error';
  else if (CONFIG_CODES.has(code) && SERVER_PARAMS.test(param)) mapped = 'config_error';
  else if (status === 400 || status === 413 || status === 422) mapped = 'invalid_request_error';
  else mapped = (type || code).slice(0, 40);
  return {
    kind: 'status',
    status,
    type: mapped,
    detail: typeof info.message === 'string' ? info.message : null,
    requestId: typeof info.requestId === 'string' ? info.requestId : null,
  };
}
