// Configuración fija del asistente de IA del launcher.
// Sin dependencias externas ni APIs de Deno: se puede probar con Node (node --test).

/** Identidad del cliente que acepta el backend (ver src/main/modules/ai.js). */
export const CLIENT_APP = 'venus-launcher';

/**
 * Versiones del protocolo que acepta el backend:
 * - 1: el launcher no elige el modelo (se usa el primero del plan).
 * - 2: el launcher puede elegir el modelo (`model`) entre los de su plan.
 */
export const PROTOCOLS = [1, 2] as const;
export type Protocol = (typeof PROTOCOLS)[number];
export const PROTOCOL = 2;

/**
 * Modelos que puede pedir el launcher (ids de public.ai_models). El id real de la API de Anthropic sale
 * siempre de la base (ai_models.model_id), nunca del texto del cliente.
 */
export const MODEL_KEYS = ['haiku', 'sonnet', 'opus'] as const;
export type ModelKey = (typeof MODEL_KEYS)[number];

/** Forma de un id de modelo de la API de Anthropic (defensa extra sobre lo que devuelve la base). */
export const ANTHROPIC_MODEL_PATTERN = /^claude-[a-z0-9][a-z0-9-]{1,62}$/;

/** Beta del reintento automático en otro modelo cuando el clasificador rechaza el pedido. */
export const BETA_FALLBACK = 'server-side-fallback-2026-07-01';

/**
 * Únicos modelos con los que se usa `fallbacks: "default"`, aunque la base diga otra cosa
 * (ai_models.supports_fallback). Haiku 5.5 no tiene reintento en otro modelo.
 */
export const FALLBACK_MODELS: ReadonlySet<string> = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);

/**
 * Proveedores de IA del backend. Por defecto Anthropic es el principal y OpenAI el secundario (respaldo);
 * el orden y el respaldo se configuran en public.ai_provider_config (0011_ai_providers.sql).
 */
export const PROVIDERS = ['anthropic', 'openai'] as const;
export type Provider = (typeof PROVIDERS)[number];

/** Forma de un id de modelo de la API de OpenAI (defensa extra sobre lo que devuelve la base). */
export const OPENAI_MODEL_PATTERN = /^(gpt-[a-z0-9][a-z0-9.-]{0,60}|o[0-9][a-z0-9.-]{0,60})$/;

/** Esfuerzos de razonamiento de la API de OpenAI (reasoning.effort). Cuáles acepta cada modelo depende del modelo. */
export const OPENAI_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type OpenAIEffort = (typeof OPENAI_EFFORTS)[number];

/**
 * Fallas del proveedor principal que pueden pasar el pedido al secundario (ai_provider_config.failover_on).
 * Nunca están (ni se pueden agregar) el rechazo de la IA (stop_reason "refusal"), los 400 del pedido ni la
 * cancelación del launcher.
 */
export const FAILOVER_KINDS = [
  'rate_limited',
  'overloaded',
  'unavailable',
  'timeout',
  'network',
  'billing',
  'auth',
  'permission',
  'config',
  'model',
  'not_configured',
  'unknown',
] as const;
export type FailoverKind = (typeof FAILOVER_KINDS)[number];

/** Las que activan el respaldo si la base no dice otra cosa (todas menos 'unknown'). */
export const DEFAULT_FAILOVER_ON: readonly FailoverKind[] = FAILOVER_KINDS.filter((kind) => kind !== 'unknown');

/** Tiempo que tiene que quedar del plazo de la función para probar con el proveedor secundario. */
export const MIN_FAILOVER_MS = 15000;

/** Cuánto se guarda en memoria la configuración de proveedores (ai_provider_settings) en cada instancia. */
export const PROVIDER_SETTINGS_TTL_MS = 60000;

/** Mínimo de max_output_tokens que acepta la API de OpenAI. */
export const OPENAI_MIN_OUTPUT_TOKENS = 16;

/** Tope duro de tokens de salida: los pedidos no usan streaming. */
export const MAX_OUTPUT_TOKENS = 16000;

/** Tiempo máximo de espera a la IA. Supabase corta a los 150 s sin respuesta. */
export const DEFAULT_TIMEOUT_MS = 140000;
export const MIN_TIMEOUT_MS = 10000;
export const MAX_TIMEOUT_MS = 390000;

export const TASKS = ['assistant', 'text', 'json'] as const;
export type Task = (typeof TASKS)[number];

/** Esfuerzos que acepta el protocolo. Cuáles permite cada modelo lo decide el plan (ai_plan_models). */
export const EFFORTS = ['low', 'medium', 'high'] as const;
export type Effort = (typeof EFFORTS)[number];

/** Límites del cuerpo del pedido (en bytes UTF-8 salvo que se indique otra cosa). */
export const LIMITS = {
  bodyBytes: 400 * 1024,
  systemBytes: 20 * 1024,
  schemaBytes: 20 * 1024,
  /** Esquemas de las herramientas propias del launcher (las de TOOL_LEVELS). */
  toolSchemasBytes: 64 * 1024,
  /** Herramientas propias del launcher por pedido (hoy 55: instancias, servidores locales, instantáneas y mundos). */
  maxTools: 80,
  /** Herramientas de servidores MCP del usuario por pedido (el launcher manda hasta 40). */
  maxMcpTools: 48,
  /** Definiciones completas (nombre, descripción y esquema) de las herramientas MCP de un pedido. */
  mcpToolsBytes: 128 * 1024,
  toolDescriptionChars: 4000,
  maxMessages: 1000,
  maxBlocksPerMessage: 500,
  maxTokensValue: 1000000,
  /** Niveles de anidamiento del cuerpo (JSON.stringify revienta la pila con miles de niveles). */
  maxDepth: 64,
};

/** turn_id: identificador de una pregunta del usuario (agrupa las llamadas de su ciclo de herramientas). */
export const TURN_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,100}$/;

export type ToolLevel = 'read' | 'reversible' | 'destructive';

/**
 * Herramientas del asistente: nombres canónicos (los mismos que usa el launcher) y nivel de permiso.
 * - read: se ejecutan sin confirmación.
 * - reversible: el launcher guarda una copia de la configuración antes y muestra "Deshacer".
 * - destructive: el launcher pide confirmación explícita en la interfaz antes de ejecutarlas.
 * El backend solo deja pasar definiciones de herramientas con estos nombres.
 */
export const TOOL_LEVELS: Readonly<Record<string, ToolLevel>> = {
  list_instances: 'read',
  get_instance_info: 'read',
  list_mods: 'read',
  get_system_specs: 'read',
  search_mods: 'read',
  search_resource_packs: 'read',
  search_shaders: 'read',
  get_mod_versions: 'read',
  check_compatibility: 'read',
  read_crash_summary: 'read',
  run_benchmark: 'read',
  create_instance: 'reversible',
  install_mod: 'reversible',
  install_resource_pack: 'reversible',
  install_shader: 'reversible',
  update_mod: 'reversible',
  toggle_mod: 'reversible',
  set_ram: 'reversible',
  set_option: 'reversible',
  set_java_version: 'reversible',
  set_jvm_args: 'reversible',
  change_instance_version: 'reversible',
  remove_mod: 'destructive',
  // Servidores locales, RAM, instantáneas y mundos (el nivel lo aplica el launcher; acá solo se valida el nombre)
  list_servers: 'read',
  get_server_info: 'read',
  read_server_console: 'read',
  get_server_properties: 'read',
  list_server_plugins: 'read',
  search_server_plugins: 'read',
  list_server_backups: 'read',
  recommend_ram: 'read',
  list_snapshots: 'read',
  list_worlds: 'read',
  create_server: 'reversible',
  start_server: 'reversible',
  stop_server: 'reversible',
  restart_server: 'reversible',
  send_server_command: 'reversible',
  set_server_property: 'reversible',
  set_server_ram: 'reversible',
  install_server_plugin: 'reversible',
  update_server_plugin: 'reversible',
  replace_server_plugin: 'reversible',
  toggle_server_plugin: 'reversible',
  backup_server_world: 'reversible',
  duplicate_instance: 'reversible',
  rename_instance: 'reversible',
  create_snapshot: 'reversible',
  backup_world: 'reversible',
  remove_server_plugin: 'destructive',
  restore_server_backup: 'destructive',
  restore_snapshot: 'destructive',
  whitelist_add: 'destructive',
  whitelist_remove: 'destructive',
  op_player: 'destructive',
};

export const TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(TOOL_LEVELS));

/**
 * Herramientas de servidores MCP que el usuario agregó a mano en el launcher (Ajustes > IA): se llaman
 * mcp__<servidor>__<herramienta> y tienen hasta 64 caracteres (el límite de nombres de OpenAI). No son
 * herramientas del servidor de IA: las ejecuta el launcher en la PC del usuario y pide su confirmación antes de
 * cada llamada (salvo las de solo lectura o las que el usuario permitió siempre). El identificador del servidor
 * no lleva "_", así que el nombre se separa sin ambigüedad.
 */
export const MCP_TOOL_PATTERN = /^mcp__[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?__[A-Za-z0-9_-]+$/;
export const MCP_TOOL_NAME_MAX = 64;

export function isMcpToolName(name: unknown): name is string {
  return typeof name === 'string' && name.length <= MCP_TOOL_NAME_MAX && MCP_TOOL_PATTERN.test(name);
}

export const CORS_HEADERS: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

/** Lee AI_UPSTREAM_TIMEOUT_MS (opcional) y lo deja dentro de un rango seguro. */
export function parseTimeoutMs(raw: string | null | undefined): number {
  const n = Number(String(raw ?? '').trim());
  if (!raw || !Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(n)));
}
