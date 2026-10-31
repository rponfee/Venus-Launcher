// Errores del protocolo y traducción de fallas de la API de la IA (Anthropic u OpenAI) a respuestas seguras.
// Sin dependencias externas: index.ts convierte el error del SDK en un UpstreamFailure (los de OpenAI pasan
// antes por openai.ts, que los lleva a los tipos de Anthropic) y acá se decide el código HTTP. Nunca se
// devuelve 401, 404 ni 429 por fallas del proveedor: el launcher los usa para "sesión vencida", "backend sin
// asistente" y "cuota del plan".

export type UpstreamKind = 'status' | 'connection' | 'timeout' | 'aborted' | 'unknown';

/** Descripción neutral de una falla al llamar a la IA (sin contenido del pedido). */
export interface UpstreamFailure {
  kind: UpstreamKind;
  /** Código HTTP de Anthropic (kind "status"). */
  status?: number | null;
  /** error.type de Anthropic, por ejemplo "rate_limit_error". */
  type?: string | null;
  /** error.message de Anthropic: solo se devuelve en los 400 y nunca se registra en los logs. */
  detail?: string | null;
  /** request-id de Anthropic, para los logs. */
  requestId?: string | null;
  /** Nombre del error (kind "unknown"), para los logs. */
  name?: string | null;
}

export interface ErrorBody {
  error: 'upstream' | 'bad_request';
  message: string;
  code: string;
}

export interface MappedError {
  status: number;
  body: ErrorBody;
  /** Si la consulta que abrió este pedido se puede devolver (la IA no llegó a procesarlo). */
  release: boolean;
  /** Nivel de log ('warn' | 'error'), o null si no hace falta registrar nada. */
  log: 'warn' | 'error' | null;
}

export const MESSAGES = {
  timeout: 'La IA tardó demasiado en responder. Probá de nuevo o pedí algo más corto.',
  aborted: 'El pedido se canceló.',
  network: 'No se pudo conectar con el servicio de IA. Probá de nuevo en un rato.',
  busy: 'El servicio de IA está saturado. Probá de nuevo en unos minutos.',
  unavailable: 'El servicio de IA no está disponible en este momento. Probá de nuevo en un rato.',
  misconfigured: 'El asistente de IA no está bien configurado en el servidor. Avisale al equipo de Venus Launcher.',
  model: 'El modelo de IA de tu plan no está disponible en este momento.',
  unknown: 'Hubo un error inesperado con el servicio de IA. Probá de nuevo en un rato.',
  rejected: 'La IA rechazó el pedido',
  notConfigured: 'El asistente de IA no está configurado en el servidor.',
  authUnavailable: 'No se pudo verificar tu sesión. Probá de nuevo en un rato.',
  quotaUnavailable: 'No se pudo consultar la cuota de tu plan. Probá de nuevo en un rato.',
  backendNotReady: 'Al servidor le faltan las migraciones del asistente (supabase/migrations/0007_ai.sql y 0008_ai_plans.sql).',
  internal: 'Error interno del servidor del asistente.',
} as const;

/** Limpia y recorta el mensaje de Anthropic que se devuelve en un 400. */
export function cleanDetail(detail: unknown, max = 300): string {
  if (typeof detail !== 'string') return '';
  const flat = detail.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function upstream(status: number, code: string, message: string, release: boolean, log: 'warn' | 'error' | null): MappedError {
  return { status, body: { error: 'upstream', message, code }, release, log };
}

function mapStatus(failure: UpstreamFailure): MappedError {
  const status = typeof failure.status === 'number' ? failure.status : 0;
  const type = failure.type ?? '';
  const detail = cleanDetail(failure.detail);
  // Sin crédito en la cuenta de Anthropic: es un problema del servidor, no del usuario.
  if (type === 'billing_error' || status === 402 || /credit balance/i.test(detail)) {
    return upstream(503, 'upstream_billing', MESSAGES.unavailable, false, 'error');
  }
  if (status === 401 || type === 'authentication_error') return upstream(502, 'upstream_auth', MESSAGES.misconfigured, false, 'error');
  if (status === 403 || type === 'permission_error') return upstream(502, 'upstream_permission', MESSAGES.misconfigured, false, 'error');
  if (status === 404 || type === 'not_found_error') return upstream(502, 'upstream_model', MESSAGES.model, false, 'error');
  // Límites de la organización o sobrecarga: no son culpa del usuario, se devuelve la consulta.
  if (status === 429 || type === 'rate_limit_error') return upstream(503, 'upstream_rate_limited', MESSAGES.busy, true, 'warn');
  if (status === 529 || type === 'overloaded_error') return upstream(503, 'upstream_overloaded', MESSAGES.busy, true, 'warn');
  if (status === 504 || type === 'timeout_error') return upstream(503, 'upstream_timeout', MESSAGES.timeout, true, 'warn');
  if (status >= 500) return upstream(503, 'upstream_unavailable', MESSAGES.unavailable, true, 'warn');
  // Un parámetro que pone el servidor y que el modelo no acepta (lo marca openai.ts): configuración del servidor.
  if (type === 'config_error') return upstream(502, 'upstream_config', MESSAGES.misconfigured, false, 'error');
  if (status === 400 || status === 413 || status === 422 || type === 'invalid_request_error' || type === 'request_too_large') {
    // Un beta no habilitado en la organización es un problema de configuración del servidor.
    if (/anthropic-beta/i.test(detail)) return upstream(502, 'upstream_config', MESSAGES.misconfigured, false, 'error');
    return {
      status: 400,
      body: { error: 'bad_request', message: detail ? `${MESSAGES.rejected}: ${detail}` : `${MESSAGES.rejected}.`, code: 'upstream_invalid_request' },
      release: false,
      log: null,
    };
  }
  return upstream(502, 'upstream_error', MESSAGES.unknown, false, 'error');
}

/** Decide la respuesta HTTP para una falla al llamar a la IA. */
export function mapUpstreamError(failure: UpstreamFailure): MappedError {
  switch (failure.kind) {
    case 'timeout':
      return upstream(503, 'upstream_timeout', MESSAGES.timeout, false, 'warn');
    case 'aborted':
      return upstream(503, 'aborted', MESSAGES.aborted, false, null);
    case 'connection':
      return upstream(502, 'upstream_network', MESSAGES.network, false, 'warn');
    case 'status':
      return mapStatus(failure);
    default:
      return upstream(502, 'upstream_error', MESSAGES.unknown, false, 'error');
  }
}

/** Línea de log sin contenido de la conversación ni datos del usuario. */
export function failureLogLine(failure: UpstreamFailure, mapped: MappedError, provider?: string): string {
  const parts = [`[ai-assistant] falla de la IA: ${mapped.body.code}`, `kind=${failure.kind}`];
  if (provider) parts.push(`provider=${provider}`);
  if (typeof failure.status === 'number') parts.push(`status=${failure.status}`);
  if (failure.type) parts.push(`type=${String(failure.type).slice(0, 40)}`);
  if (failure.requestId) parts.push(`request_id=${String(failure.requestId).slice(0, 80)}`);
  if (failure.name) parts.push(`name=${String(failure.name).slice(0, 60)}`);
  return parts.join(' ');
}
