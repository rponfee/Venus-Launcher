// Validación estricta del cuerpo de POST /functions/v1/ai-assistant (protocolos 1 y 2 del launcher).
// Sin dependencias externas: se prueba con Node. Los mensajes se validan pero se reenvían intactos
// (el launcher devuelve los bloques de la IA tal cual los recibió, firmas de "thinking" incluidas).
// Acá solo se revisa la forma: si el plan incluye el modelo y el esfuerzo lo decide la base
// (ai_register_turn), que también elige los valores por defecto.
import { CLIENT_APP, EFFORTS, LIMITS, MODEL_KEYS, PROTOCOLS, TASKS, TOOL_NAMES, TURN_ID_PATTERN, isMcpToolName } from './config.ts';
import type { Effort, ModelKey, Protocol, Task } from './config.ts';

export interface ValidRequest {
  protocol: Protocol;
  task: Task;
  /** Modelo pedido (protocolo 2) o null: el de la pregunta abierta o el primero del plan. */
  model: ModelKey | null;
  /** Esfuerzo pedido o null: medium si el plan lo permite (lo resuelve la base). */
  effort: Effort | null;
  /** Texto de sistema del launcher (va después de la política del servidor). */
  system: string | null;
  /** Conversación tal cual llegó (validada). */
  messages: unknown[];
  /** Definiciones de herramientas (solo task "assistant"). */
  tools: Record<string, unknown>[] | null;
  /** JSON Schema de la respuesta (solo task "json"). */
  schema: Record<string, unknown> | null;
  /** max_tokens pedido por el launcher (después se recorta según el plan). */
  maxTokens: number | null;
  turnId: string | null;
}

export type ValidationResult = { ok: true; value: ValidRequest } | { ok: false; message: string };

const TOP_LEVEL_KEYS = new Set(['task', 'model', 'system', 'messages', 'tools', 'schema', 'max_tokens', 'effort', 'turn_id', 'client']);
const TOOL_KEYS = new Set(['name', 'description', 'input_schema', 'strict', 'cache_control', 'type']);
// Bloques que acepta la API y que usa el launcher. Nada de documentos, URLs ni herramientas del servidor.
const USER_BLOCKS: ReadonlySet<string> = new Set(['text', 'image', 'tool_result']);
const ASSISTANT_BLOCKS: ReadonlySet<string> = new Set(['text', 'thinking', 'redacted_thinking', 'tool_use', 'fallback']);
const TOOL_RESULT_BLOCKS: ReadonlySet<string> = new Set(['text', 'image']);
const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const TOOL_USE_NAME_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const encoder = new TextEncoder();

/** Largo en bytes UTF-8. */
export function byteLength(text: string): number {
  return encoder.encode(text).length;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** true si el valor tiene más de `limit` niveles de objetos o listas anidados (sin recursión). */
export function exceedsDepth(value: unknown, limit: number): boolean {
  const stack: [unknown, number][] = [[value, 1]];
  while (stack.length) {
    const [item, depth] = stack.pop() as [unknown, number];
    if (typeof item !== 'object' || item === null) continue;
    if (depth > limit) return true;
    const children = Array.isArray(item) ? item : Object.values(item);
    for (const child of children) {
      if (typeof child === 'object' && child !== null) stack.push([child, depth + 1]);
    }
  }
  return false;
}

function fail(message: string): ValidationResult {
  return { ok: false, message };
}

// Recorta nombres que vienen del cliente antes de ponerlos en un mensaje de error.
function clip(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 40);
}

// Solo la caché de 5 minutos: es la que se cobra con ai_models.cache_write_usd_mtok. La de 1 hora cuesta
// más y dejaría gastar por encima del presupuesto del plan.
function isCacheControl(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (!isPlainObject(value) || value.type !== 'ephemeral') return false;
  return value.ttl === undefined || value.ttl === '5m';
}

function checkImage(block: Record<string, unknown>, where: string): string | null {
  const source = block.source;
  if (!isPlainObject(source) || source.type !== 'base64') return `${where}: solo se aceptan imágenes en base64.`;
  if (typeof source.media_type !== 'string' || !IMAGE_MEDIA_TYPES.has(source.media_type)) {
    return `${where}: formato de imagen no soportado.`;
  }
  if (typeof source.data !== 'string' || source.data.length === 0) return `${where}: la imagen está vacía.`;
  return null;
}

function checkToolResult(block: Record<string, unknown>, where: string): string | null {
  if (typeof block.tool_use_id !== 'string' || !ID_PATTERN.test(block.tool_use_id)) return `${where}.tool_use_id no es válido.`;
  if (block.is_error !== undefined && block.is_error !== null && typeof block.is_error !== 'boolean') {
    return `${where}.is_error tiene que ser true o false.`;
  }
  const content = block.content;
  if (content === undefined || content === null || typeof content === 'string') return null;
  if (!Array.isArray(content)) return `${where}.content tiene que ser texto o una lista de bloques.`;
  if (content.length > LIMITS.maxBlocksPerMessage) return `${where}.content tiene demasiados bloques.`;
  for (let k = 0; k < content.length; k++) {
    const error = checkBlock(content[k], TOOL_RESULT_BLOCKS, `${where}.content[${k}]`);
    if (error) return error;
  }
  return null;
}

function checkBlock(block: unknown, allowed: ReadonlySet<string>, where: string): string | null {
  if (!isPlainObject(block)) return `${where} tiene que ser un objeto.`;
  const type = block.type;
  if (typeof type !== 'string' || !allowed.has(type)) {
    return `${where}: tipo de bloque no permitido (${typeof type === 'string' ? `"${clip(type)}"` : 'sin tipo'}).`;
  }
  if (!isCacheControl(block.cache_control)) return `${where}.cache_control no es válido.`;
  switch (type) {
    case 'text':
      return typeof block.text === 'string' ? null : `${where}.text tiene que ser texto.`;
    case 'image':
      return checkImage(block, where);
    case 'tool_result':
      return checkToolResult(block, where);
    case 'thinking':
      return typeof block.thinking === 'string' && typeof block.signature === 'string'
        ? null
        : `${where}: el bloque "thinking" necesita "thinking" y "signature".`;
    case 'redacted_thinking':
      return typeof block.data === 'string' ? null : `${where}: el bloque "redacted_thinking" necesita "data".`;
    case 'tool_use':
      if (typeof block.id !== 'string' || !ID_PATTERN.test(block.id)) return `${where}.id no es válido.`;
      if (typeof block.name !== 'string' || !TOOL_USE_NAME_PATTERN.test(block.name)) return `${where}.name no es válido.`;
      return isPlainObject(block.input) ? null : `${where}.input tiene que ser un objeto.`;
    case 'fallback':
      // Marca de cambio de modelo que devuelve la API; se reenvía en su lugar original.
      return isPlainObject(block.from) && isPlainObject(block.to) ? null : `${where}: el bloque "fallback" necesita "from" y "to".`;
    default:
      return `${where}: tipo de bloque no permitido.`;
  }
}

function checkContent(content: unknown, role: 'user' | 'assistant', where: string): string | null {
  if (typeof content === 'string') return content.trim() ? null : `${where}.content está vacío.`;
  if (!Array.isArray(content) || content.length === 0) {
    return `${where}.content tiene que ser texto o una lista de bloques con al menos un elemento.`;
  }
  if (content.length > LIMITS.maxBlocksPerMessage) return `${where}.content tiene demasiados bloques.`;
  const allowed = role === 'user' ? USER_BLOCKS : ASSISTANT_BLOCKS;
  for (let j = 0; j < content.length; j++) {
    const error = checkBlock(content[j], allowed, `${where}.content[${j}]`);
    if (error) return error;
  }
  return null;
}

function checkMessages(list: unknown): string | null {
  if (!Array.isArray(list) || list.length === 0) return 'messages tiene que ser una lista con al menos un mensaje.';
  if (list.length > LIMITS.maxMessages) return `Demasiados mensajes (máximo ${LIMITS.maxMessages}).`;
  for (let i = 0; i < list.length; i++) {
    const message = list[i];
    const where = `messages[${i}]`;
    if (!isPlainObject(message)) return `${where} tiene que ser un objeto.`;
    for (const key of Object.keys(message)) {
      if (key !== 'role' && key !== 'content') return `${where}: campo no permitido ("${clip(key)}").`;
    }
    if (message.role !== 'user' && message.role !== 'assistant') return `${where}.role tiene que ser "user" o "assistant".`;
    const error = checkContent(message.content, message.role, where);
    if (error) return error;
  }
  const first = list[0] as Record<string, unknown>;
  const last = list[list.length - 1] as Record<string, unknown>;
  if (first.role !== 'user') return 'El primer mensaje tiene que ser del usuario.';
  if (last.role !== 'user') return 'El último mensaje tiene que ser del usuario.';
  return null;
}

type ToolsCheck = { error: string } | { tools: Record<string, unknown>[] | null };

// Herramientas: las propias del launcher (nombres canónicos de TOOL_LEVELS) y las de los servidores MCP que el
// usuario agregó en el launcher (mcp__<servidor>__<herramienta>), que también ejecuta el launcher. Nunca
// herramientas del servidor de IA (búsqueda web, código, bash, conectores MCP de Anthropic...).
function checkTools(raw: unknown): ToolsCheck {
  if (raw === undefined || raw === null) return { tools: null };
  if (!Array.isArray(raw)) return { error: 'tools tiene que ser una lista.' };
  if (raw.length === 0) return { tools: null };
  if (raw.length > LIMITS.maxTools + LIMITS.maxMcpTools) return { error: `Demasiadas herramientas (máximo ${LIMITS.maxTools + LIMITS.maxMcpTools}).` };
  const seen = new Set<string>();
  let schemaBytes = 0;
  let own = 0;
  let mcp = 0;
  let mcpBytes = 0;
  for (let i = 0; i < raw.length; i++) {
    const tool = raw[i];
    const where = `tools[${i}]`;
    if (!isPlainObject(tool)) return { error: `${where} tiene que ser un objeto.` };
    for (const key of Object.keys(tool)) {
      if (!TOOL_KEYS.has(key)) return { error: `${where}: campo no permitido ("${clip(key)}").` };
    }
    if (tool.type !== undefined && tool.type !== 'custom') {
      return { error: `${where}: solo se permiten las herramientas propias del launcher.` };
    }
    const name = tool.name;
    const isOwn = typeof name === 'string' && TOOL_NAMES.has(name);
    const isMcp = !isOwn && isMcpToolName(name);
    if (typeof name !== 'string' || (!isOwn && !isMcp)) {
      return { error: `${where}: herramienta no permitida (${typeof name === 'string' ? `"${clip(name)}"` : 'sin nombre'}).` };
    }
    if (seen.has(name)) return { error: `${where}: herramienta repetida ("${clip(name)}").` };
    seen.add(name);
    if (tool.description !== undefined && (typeof tool.description !== 'string' || tool.description.length > LIMITS.toolDescriptionChars)) {
      return { error: `${where}.description tiene que ser texto de hasta ${LIMITS.toolDescriptionChars} caracteres.` };
    }
    if (!isPlainObject(tool.input_schema) || tool.input_schema.type !== 'object') {
      return { error: `${where}.input_schema tiene que ser un JSON Schema de tipo "object".` };
    }
    if (tool.strict !== undefined && typeof tool.strict !== 'boolean') return { error: `${where}.strict tiene que ser true o false.` };
    if (!isCacheControl(tool.cache_control)) return { error: `${where}.cache_control no es válido.` };
    if (isOwn) {
      own++;
      if (own > LIMITS.maxTools) return { error: `Demasiadas herramientas (máximo ${LIMITS.maxTools}).` };
      schemaBytes += byteLength(JSON.stringify(tool.input_schema));
      if (schemaBytes > LIMITS.toolSchemasBytes) {
        return { error: `Los esquemas de las herramientas superan los ${LIMITS.toolSchemasBytes / 1024} KB en total.` };
      }
      continue;
    }
    // Herramienta de un servidor MCP del usuario: sin modo estricto (la API admite pocas y son de las propias)
    if (tool.strict === true) return { error: `${where}: las herramientas MCP no pueden usar strict.` };
    mcp++;
    if (mcp > LIMITS.maxMcpTools) return { error: `Demasiadas herramientas MCP (máximo ${LIMITS.maxMcpTools}).` };
    mcpBytes += byteLength(JSON.stringify(tool));
    if (mcpBytes > LIMITS.mcpToolsBytes) {
      return { error: `Las herramientas MCP superan los ${LIMITS.mcpToolsBytes / 1024} KB en total.` };
    }
  }
  return { tools: raw as Record<string, unknown>[] };
}

type SchemaCheck = { error: string } | { schema: Record<string, unknown> | null };

function checkSchema(raw: unknown): SchemaCheck {
  if (raw === undefined || raw === null) return { schema: null };
  if (!isPlainObject(raw) || raw.type !== 'object') return { error: 'schema tiene que ser un JSON Schema de tipo "object".' };
  if (byteLength(JSON.stringify(raw)) > LIMITS.schemaBytes) {
    return { error: `schema es demasiado grande (máximo ${LIMITS.schemaBytes / 1024} KB).` };
  }
  return { schema: raw };
}

/** Valida el cuerpo ya parseado. Nunca modifica lo que recibe. */
export function validateRequest(body: unknown): ValidationResult {
  if (!isPlainObject(body)) return fail('El cuerpo tiene que ser un objeto JSON.');
  for (const key of Object.keys(body)) {
    if (!TOP_LEVEL_KEYS.has(key)) return fail(`Campo desconocido: "${clip(key)}".`);
  }
  if (exceedsDepth(body, LIMITS.maxDepth)) return fail(`El pedido tiene demasiados niveles anidados (máximo ${LIMITS.maxDepth}).`);

  const client = body.client;
  if (!isPlainObject(client) || client.app !== CLIENT_APP) return fail(`Cliente no reconocido (client.app tiene que ser "${CLIENT_APP}").`);
  const protocol = client.protocol;
  if (typeof protocol !== 'number' || !(PROTOCOLS as readonly number[]).includes(protocol)) {
    return fail(`Versión de protocolo no soportada (se aceptan ${PROTOCOLS.join(' y ')}).`);
  }

  // Protocolo 1: el cliente no elige el modelo (igual que antes, "model" es un campo desconocido).
  let model: ModelKey | null = null;
  if (protocol === 1) {
    if (body.model !== undefined) return fail('Campo desconocido: "model" (para elegir el modelo usá el protocolo 2).');
  } else if (body.model !== undefined && body.model !== null) {
    if (typeof body.model !== 'string' || !(MODEL_KEYS as readonly string[]).includes(body.model)) {
      return fail(`model tiene que ser ${MODEL_KEYS.map((m) => `"${m}"`).join(', ')}.`);
    }
    model = body.model as ModelKey;
  }

  const task = body.task;
  if (typeof task !== 'string' || !(TASKS as readonly string[]).includes(task)) {
    return fail('task tiene que ser "assistant", "text" o "json".');
  }

  let system: string | null = null;
  if (body.system !== undefined && body.system !== null) {
    if (typeof body.system !== 'string') return fail('system tiene que ser texto.');
    if (byteLength(body.system) > LIMITS.systemBytes) return fail(`system es demasiado largo (máximo ${LIMITS.systemBytes / 1024} KB).`);
    system = body.system.trim() ? body.system : null;
  }

  const messagesError = checkMessages(body.messages);
  if (messagesError) return fail(messagesError);

  const tools = checkTools(body.tools);
  if ('error' in tools) return fail(tools.error);

  const schema = checkSchema(body.schema);
  if ('error' in schema) return fail(schema.error);

  let maxTokens: number | null = null;
  if (body.max_tokens !== undefined && body.max_tokens !== null) {
    const n = body.max_tokens;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > LIMITS.maxTokensValue) {
      return fail('max_tokens tiene que ser un número entero positivo.');
    }
    maxTokens = n;
  }

  let effort: Effort | null = null;
  if (body.effort !== undefined && body.effort !== null) {
    if (typeof body.effort !== 'string' || !(EFFORTS as readonly string[]).includes(body.effort)) {
      return fail('effort tiene que ser "low", "medium" o "high".');
    }
    effort = body.effort as Effort;
  }

  let turnId: string | null = null;
  if (body.turn_id !== undefined && body.turn_id !== null) {
    if (typeof body.turn_id !== 'string' || !TURN_ID_PATTERN.test(body.turn_id)) {
      return fail('turn_id no es válido (letras, números y _ . : -, hasta 100 caracteres).');
    }
    turnId = body.turn_id;
  }

  if (tools.tools && task !== 'assistant') return fail('Las herramientas solo se aceptan con task "assistant".');
  if (schema.schema && task !== 'json') return fail('schema solo se acepta con task "json".');
  if (task === 'json' && !schema.schema) return fail('task "json" necesita un schema.');

  return {
    ok: true,
    value: {
      protocol: protocol as Protocol,
      task: task as Task,
      model,
      effort,
      system,
      messages: body.messages as unknown[],
      tools: tools.tools,
      schema: schema.schema,
      maxTokens,
      turnId,
    },
  };
}
