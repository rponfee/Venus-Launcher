'use strict';
// Panel de administración (lado del launcher), sin Electron: pregunta si el usuario es admin (RPC is_admin, barata:
// no gasta una invocación de la Edge Function en cada usuario que abre el launcher) y le pasa las acciones del
// panel a la Edge Function "admin" con el token del usuario. Lo usa ../admin.js, que le pasa las dependencias
// reales (fetch, sesión guardada por cloud.js, textos); las pruebas (test/client.test.js) le pasan dobles.
// El servidor vuelve a verificar al admin en CADA acción: esto solo decide si se muestra el panel.

const FUNCTION = 'admin';
const ACTION = /^[a-z][A-Za-z]{1,30}(\.[A-Za-z]{1,30})?$/;
const ME_TTL_MS = 5 * 60 * 1000;
// Las acciones en lote (hasta 100 usuarios) pueden tardar: Auth, Stripe y la base por cada uno.
const CALL_TIMEOUT_MS = 120000;
const CHECK_TIMEOUT_MS = 15000;

function coded(code, message, extra) {
  const err = new Error(message);
  err.code = code;
  if (extra && typeof extra === 'object') {
    for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null) err[k] = v;
  }
  return err;
}

const str = (v) => (typeof v === 'string' && v ? v : null);

function createAdminClient(deps) {
  const t = deps.t;
  const now = deps.now || Date.now;
  let meCache = null; // { userId, at, value }

  async function config() {
    const cfg = await deps.cloudConfig();
    if (!cfg || !cfg.configured) throw coded('noCloud', t('admin.errNoCloud'));
    return cfg;
  }

  async function request(url, init, timeoutMs) {
    let res;
    try {
      res = await deps.fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw coded('network', t('admin.errNetwork'));
    }
    const data = await res.json().catch(() => null);
    return { res, data };
  }

  function serverError(status, data) {
    const e = data && typeof data === 'object' ? data : {};
    const extra = { reason: str(e.reason), field: str(e.field), stripeCode: str(e.stripeCode), status };
    if (status === 401) {
      meCache = null;
      return coded('noSession', t('admin.errSession'), extra);
    }
    if (status === 403) {
      meCache = null;
      return coded('forbidden', e.reason === 'unconfirmed' ? t('admin.errUnconfirmed') : t('admin.errForbidden'), extra);
    }
    // 404 con { error: 'not_found' } es de la función; sin ese cuerpo, la función no está desplegada.
    if (status === 404 && e.error === 'not_found') return coded('notFound', str(e.message) || t('admin.errNotFound'), extra);
    if (status === 404) return coded('unavailable', t('admin.errUnavailable'), extra);
    if (e.error === 'bad_request') return coded('badRequest', str(e.message) || t('admin.errRequest'), extra);
    if (e.error === 'conflict') return coded('conflict', e.reason === 'promo_code_taken' ? t('admin.errPromoTaken') : str(e.message) || t('admin.errConflict'), extra);
    if (e.error === 'stripe_not_configured') return coded('stripeNotConfigured', t('admin.errStripeNotConfigured'), extra);
    if (e.error === 'stripe') return coded('stripe', t('admin.errStripe'), extra);
    if (e.error === 'backend_not_ready' || e.error === 'not_configured') return coded('unavailable', t('admin.errBackendNotReady'), extra);
    if (e.error === 'db_unavailable' && e.reason === 'price_not_saved') return coded('server', str(e.message) || t('admin.errServer'), extra);
    if (status >= 500) return coded('server', t('admin.errServer'), extra);
    return coded('error', t('admin.errRequestStatus', { status }), extra);
  }

  // ¿El usuario con sesión es admin? { isAdmin, email, userId, reason, checkedAt }.
  // reason: null | 'noCloud' | 'noSession' | 'notReady' (falta 0012) | 'network' | 'error'.
  async function me(opts = {}) {
    if (deps.fake) return deps.fake.me();
    const base = (reason, s) => ({ isAdmin: false, email: (s && s.email) || null, userId: (s && s.userId) || null, reason, checkedAt: new Date(now()).toISOString() });
    let cfg;
    try {
      cfg = await config();
    } catch {
      return base('noCloud');
    }
    const s = await deps.session();
    if (!s || !s.userId) {
      meCache = null;
      return base('noSession');
    }
    if (!opts.force && meCache && meCache.userId === s.userId && now() - meCache.at < ME_TTL_MS) return meCache.value;
    let token;
    try {
      token = await deps.accessToken();
    } catch {
      return base('noSession', s);
    }
    let value;
    try {
      const { res, data } = await request(
        `${cfg.url}/rest/v1/rpc/is_admin`,
        { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: cfg.anonKey, Authorization: `Bearer ${token}` }, body: '{}' },
        CHECK_TIMEOUT_MS,
      );
      if (res.ok) value = { ...base(null, s), isAdmin: data === true };
      else if (res.status === 404 || (data && data.code === 'PGRST202')) value = base('notReady', s);
      else if (res.status === 401) value = base('noSession', s);
      else value = base('error', s);
    } catch {
      return base('network', s); // sin red: no se guarda, se vuelve a preguntar
    }
    if (value.reason !== 'error') meCache = { userId: s.userId, at: now(), value };
    return value;
  }

  // Acción del panel -> result de la Edge Function (formas en docs/admin.md). Errores con err.code:
  // noCloud, noSession, forbidden, notFound, unavailable, badRequest, conflict, stripeNotConfigured, stripe,
  // server, network, error (y err.reason / err.field / err.stripeCode cuando el servidor los manda).
  async function call(action, payload) {
    if (typeof action !== 'string' || !ACTION.test(action)) throw coded('badRequest', t('admin.errAction'));
    if (payload !== undefined && payload !== null && (typeof payload !== 'object' || Array.isArray(payload))) throw coded('badRequest', t('admin.errAction'));
    if (deps.fake) return deps.fake.call(action, payload || {});
    const cfg = await config();
    const token = await deps.accessToken(); // lanza noSession
    // payments.*: configuración de Mercado Pago y PayPal (Edge Function "payments", que también verifica al admin).
    const fn = action.startsWith('payments.') ? 'payments' : FUNCTION;
    const { res, data } = await request(
      `${cfg.url}/functions/v1/${fn}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: cfg.anonKey, Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action, payload: payload || {} }),
      },
      CALL_TIMEOUT_MS,
    );
    if (res.ok && data && data.ok === true) return data.result;
    throw serverError(res.status, data);
  }

  return {
    me,
    call,
    clearCache() {
      meCache = null;
    },
  };
}

module.exports = { createAdminClient, coded, ME_TTL_MS };
