// Errores de la Edge Function "admin": cada uno tiene un código estable (para el launcher), un estado HTTP y un
// mensaje en español. Nunca llevan secretos, datos de pago ni mensajes crudos de Stripe o de la base.
// Sin dependencias externas: se prueba con Node (node --test).

export const MESSAGES = {
  unauthorized: 'Tu sesión de Venus venció. Volvé a iniciar sesión.',
  anonymous: 'El panel de administración necesita una cuenta de Venus con email.',
  unconfirmed: 'Confirmá el email de tu cuenta para usar el panel de administración.',
  notAdmin: 'Tu cuenta no tiene acceso al panel de administración.',
  authUnavailable: 'No se pudo verificar tu sesión. Probá de nuevo en un rato.',
  notConfigured: 'Al servidor de Venus le faltan los secretos de Supabase.',
  backendNotReady: 'Al servidor de Venus le falta la migración del panel (0012_admin.sql).',
  dbUnavailable: 'No se pudo consultar la base de datos. Probá de nuevo en un rato.',
  badMethod: 'Método no permitido (usá POST).',
  badJson: 'El pedido tiene que ser JSON (Content-Type: application/json).',
  badBody: 'El cuerpo del pedido no es JSON válido o es demasiado grande.',
  badAction: 'Acción desconocida.',
  notFound: 'No existe.',
  stripeNotConfigured: 'Stripe no está configurado en el servidor (falta el secreto STRIPE_SECRET_KEY).',
  stripe: 'Stripe rechazó el pedido o no respondió. Probá de nuevo en un rato.',
  promoTaken: 'Ya existe un código de promoción activo con ese texto.',
  confirmRequired: 'Falta confirmar la acción.',
  internal: 'Error interno del panel de administración.',
} as const;

export type ErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'auth_unavailable'
  | 'not_configured'
  | 'backend_not_ready'
  | 'db_unavailable'
  | 'bad_request'
  | 'not_found'
  | 'conflict'
  | 'stripe_not_configured'
  | 'stripe'
  | 'internal';

/** Error que se responde tal cual: { error: code, message, ...extra }. */
export class AdminError extends Error {
  code: ErrorCode;
  status: number;
  extra: Record<string, unknown>;

  constructor(code: ErrorCode, status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'AdminError';
    this.code = code;
    this.status = status;
    this.extra = extra;
  }

  body(): Record<string, unknown> {
    return { ok: false, error: this.code, message: this.message, ...this.extra };
  }
}

/** Pedido inválido (400) con el campo que falló. */
export function badRequest(message: string, field?: string): AdminError {
  return new AdminError('bad_request', 400, message, field ? { field } : {});
}

export function notFound(message: string = MESSAGES.notFound): AdminError {
  return new AdminError('not_found', 404, message);
}

export function stripeNotConfigured(): AdminError {
  return new AdminError('stripe_not_configured', 503, MESSAGES.stripeNotConfigured);
}

/** Falla de la base (código de PostgREST o de Postgres, sin el mensaje). */
export class DbError extends Error {
  code: string;
  constructor(code: string) {
    super(`falla de la base: ${code}`);
    this.name = 'DbError';
    this.code = code;
  }
}

/** Falla de la API de administración de Supabase Auth (estado HTTP, sin el mensaje). */
export class AuthAdminError extends Error {
  status: number;
  constructor(status: number) {
    super(`Auth respondió ${status || 'sin respuesta'}`);
    this.name = 'AuthAdminError';
    this.status = status;
  }
}

/** Funciones o tablas que faltan: la migración 0012 no está aplicada. */
export const DB_NOT_READY: ReadonlySet<string> = new Set(['PGRST202', 'PGRST205', '42883', '42P01']);

/** Código de error de un objeto de error cualquiera (para los logs), sin datos. */
export function errorCode(err: unknown): string {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' && code ? code.slice(0, 40) : 'sin-codigo';
}

export function errorName(err: unknown): string {
  if (err instanceof Error) return err.name.slice(0, 60);
  return typeof err;
}
