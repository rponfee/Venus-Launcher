// Flujo HTTP de la Edge Function "admin" (panel de administración del launcher):
//   POST { action, payload } -> 200 { ok: true, action, result }
//   GET                      -> igual que POST { action: 'me' }
//   OPTIONS                  -> CORS
// Errores: { ok: false, error, message, ...extra } con 400, 401, 403, 404, 405, 409, 500, 502 y 503.
// EN CADA PEDIDO se vuelve a verificar: sesión válida (auth.getUser), cuenta no anónima, email confirmado y que el
// usuario siga siendo admin en la base (admin_is_admin_user: app_admins + email de la lista + confirmado + sin baneo).
// No importa nada de npm ni de Deno: index.ts le pasa Supabase, Auth y Stripe; las pruebas, dobles.
import { CORS_HEADERS } from '../billing/config.ts';
import { bearerToken, decodeUtf8, json, readBodyBytes } from '../billing/http.ts';
import { ACTIONS } from './actions.ts';
import type { ActionDeps, Ctx } from './actions.ts';
import { AdminError, AuthAdminError, DB_NOT_READY, DbError, MESSAGES, errorCode, errorName } from './errors.ts';
import type { Logger } from './prices.ts';
import { StripeError } from './stripe-admin.ts';
import { LIMITS, obj } from './validate.ts';

const TAG = 'admin';

export interface AuthUser {
  userId: string;
  email: string | null;
  emailConfirmed: boolean;
  anonymous: boolean;
}

export type AuthResult = { status: 'ok'; user: AuthUser } | { status: 'invalid' } | { status: 'unavailable' };

export interface AdminDeps extends ActionDeps {
  /** Están SUPABASE_URL, SUPABASE_ANON_KEY y SUPABASE_SERVICE_ROLE_KEY. */
  supabaseReady: boolean;
  verifyUser(token: string): Promise<AuthResult>;
  /** Llama a una función SQL con la service role. Si falla lanza un error con `code`. */
  rpc(name: string, args: Record<string, unknown>): Promise<unknown>;
  nowMs?: () => number;
  logger?: Logger;
}

const ACTION_PATTERN = /^[a-z][A-Za-z]{1,30}(\.[A-Za-z]{1,30})?$/;
/** Errores de la base que vienen de un dato inválido (los checks de las tablas y las validaciones del SQL). */
const DB_BAD_INPUT = new Set(['22023', '22P02', '22007', '22008', '23502', '23503', '23514', 'P0002']);

function errorResponse(err: unknown, logger: Logger, action: string): Response {
  if (err instanceof AdminError) return json(err.status, err.body());
  if (err instanceof DbError) {
    if (DB_NOT_READY.has(err.code)) {
      logger.error(`[${TAG}] falta la migración 0012 (${err.code})`);
      return json(503, { ok: false, error: 'backend_not_ready', message: MESSAGES.backendNotReady });
    }
    if (DB_BAD_INPUT.has(err.code)) return json(400, { ok: false, error: 'bad_request', message: 'La base rechazó los datos (fuera de los límites permitidos).', dbCode: err.code });
    logger.error(`[${TAG}] falla de la base en ${action}: ${err.code}`);
    return json(503, { ok: false, error: 'db_unavailable', message: MESSAGES.dbUnavailable });
  }
  if (err instanceof StripeError) {
    logger.error(`[${TAG}] Stripe falló en ${action}: ${err.describe()}`);
    if (err.code === 'resource_already_exists' || (err.status === 400 && err.param === 'code')) {
      return json(409, { ok: false, error: 'conflict', reason: 'promo_code_taken', message: MESSAGES.promoTaken });
    }
    if (err.missing) return json(404, { ok: false, error: 'not_found', reason: 'stripe_missing', message: 'No existe en Stripe (¿modo de prueba o de producción?).' });
    return json(502, { ok: false, error: 'stripe', message: MESSAGES.stripe, stripeCode: err.code ?? err.type });
  }
  if (err instanceof AuthAdminError) {
    logger.error(`[${TAG}] Auth falló en ${action}: ${err.status}`);
    return json(502, { ok: false, error: 'auth_unavailable', message: MESSAGES.authUnavailable });
  }
  logger.error(`[${TAG}] error interno en ${action}: ${errorName(err)}`);
  return json(500, { ok: false, error: 'internal', message: MESSAGES.internal });
}

export function createAdminHandler(deps: AdminDeps): (req: Request) => Promise<Response> {
  const logger: Logger = deps.logger ?? console;
  const now = deps.nowMs ?? Date.now;

  async function db(name: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      return await deps.rpc(name, args);
    } catch (err) {
      throw new DbError(errorCode(err));
    }
  }

  /** Quien llama, verificado de punta a punta (o un AdminError 401 / 403 / 503). */
  async function authorize(req: Request): Promise<{ id: string; email: string | null }> {
    const token = bearerToken(req.headers.get('authorization'));
    if (!token) throw new AdminError('unauthorized', 401, MESSAGES.unauthorized);
    let auth: AuthResult;
    try {
      auth = await deps.verifyUser(token);
    } catch {
      auth = { status: 'unavailable' };
    }
    if (auth.status === 'invalid') throw new AdminError('unauthorized', 401, MESSAGES.unauthorized);
    if (auth.status !== 'ok') throw new AdminError('auth_unavailable', 503, MESSAGES.authUnavailable);
    const user = auth.user;
    if (user.anonymous || !user.email) throw new AdminError('forbidden', 403, MESSAGES.anonymous, { reason: 'anonymous' });
    if (!user.emailConfirmed) throw new AdminError('forbidden', 403, MESSAGES.unconfirmed, { reason: 'unconfirmed' });
    const isAdmin = await db('admin_is_admin_user', { p_user: user.userId });
    if (isAdmin !== true) {
      logger.warn(`[${TAG}] acceso denegado: ${user.userId}`);
      throw new AdminError('forbidden', 403, MESSAGES.notAdmin, { reason: 'not_admin' });
    }
    return { id: user.userId, email: user.email };
  }

  async function readBody(req: Request): Promise<{ action: string; payload: Record<string, unknown> }> {
    const contentType = (req.headers.get('content-type') ?? '').trim().toLowerCase();
    if (!contentType.startsWith('application/json')) throw new AdminError('bad_request', 400, MESSAGES.badJson);
    const read = await readBodyBytes(req, LIMITS.bodyBytes);
    const text = read.ok ? decodeUtf8(read.bytes) : null;
    let body: Record<string, unknown> | null = null;
    try {
      body = text === null ? null : obj(JSON.parse(text));
    } catch {
      body = null;
    }
    if (!body) throw new AdminError('bad_request', 400, MESSAGES.badBody);
    const action = typeof body.action === 'string' ? body.action : '';
    if (!ACTION_PATTERN.test(action) || !Object.prototype.hasOwnProperty.call(ACTIONS, action)) {
      throw new AdminError('bad_request', 400, MESSAGES.badAction, { field: 'action' });
    }
    const payload = body.payload === undefined || body.payload === null ? {} : obj(body.payload);
    if (!payload) throw new AdminError('bad_request', 400, MESSAGES.badBody, { field: 'payload' });
    return { action, payload };
  }

  async function handle(req: Request): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...CORS_HEADERS } });
    if (req.method !== 'GET' && req.method !== 'POST') {
      return json(405, { ok: false, error: 'bad_request', message: MESSAGES.badMethod }, { Allow: 'GET, POST, OPTIONS' });
    }
    if (!deps.supabaseReady) return json(503, { ok: false, error: 'not_configured', message: MESSAGES.notConfigured });

    let action = 'me';
    try {
      // Primero la sesión y el permiso (un pedido de alguien que no es admin no llega ni a leer el cuerpo).
      const admin = await authorize(req);
      let payload: Record<string, unknown> = {};
      if (req.method === 'POST') ({ action, payload } = await readBody(req));
      const ctx: Ctx = {
        admin,
        deps,
        now,
        db,
        logger,
        async log(name, target, details) {
          try {
            await deps.rpc('admin_log', { p_admin: admin.id, p_admin_email: admin.email, p_action: name, p_target: target, p_details: details });
            return true;
          } catch (err) {
            logger.error(`[${TAG}] no se pudo guardar el registro de ${name}: ${errorCode(err)}`);
            return false;
          }
        },
      };
      const result = await ACTIONS[action](ctx, payload);
      return json(200, { ok: true, action, result });
    } catch (err) {
      return errorResponse(err, logger, action);
    }
  }

  return async (req: Request): Promise<Response> => {
    try {
      return await handle(req);
    } catch (err) {
      logger.error(`[${TAG}] error interno: ${errorName(err)}`);
      return json(500, { ok: false, error: 'internal', message: MESSAGES.internal });
    }
  };
}
