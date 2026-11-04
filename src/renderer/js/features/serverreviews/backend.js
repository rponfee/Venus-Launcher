// Reseñas de servidores: acceso a la base (RPC de 0029_resenas_servidores.sql). Leer anda sin sesión; opinar pide una
// cuenta que no sea anónima. Los errores llegan como ReviewsError con .code (logic.js: classifyError).
// useDemo() cambia todo por datos de ejemplo en memoria (fake.js), solo para capturas: no habla con ningún servidor.
import { cloud } from '../../cloud.js';
import { classifyError } from './logic.js';

export class ReviewsError extends Error {
  constructor(code, cause) {
    super(code);
    this.name = 'ReviewsError';
    this.code = code;
    this.reviewsCode = code;
    this.cause = cause;
  }
}

const SUMMARY_RETRY_MS = 10 * 60000;
let summaryOffUntil = 0;

const real = {
  demo: false,
  signedIn: () => cloud.isSignedIn() && cloud.user?.is_anonymous !== true,
  userId: () => cloud.user?.id || null,
  async rpc(name, args) {
    await cloud.ready();
    if (!cloud.isConfigured()) throw new ReviewsError('unavailable');
    let res;
    try {
      res = await cloud.client.rpc(name, args);
    } catch (err) {
      throw wrap(err, name);
    }
    if (res?.error) throw wrap(res.error, name);
    return res?.data ?? null;
  },
};

let active = real;

function wrap(err, where) {
  const code = classifyError(err);
  if (['unavailable', 'server', 'network'].includes(code)) console.warn(`[serverreviews] ${where}:`, err?.code || '', err?.message || err);
  return new ReviewsError(code, err);
}

export const signedIn = () => active.signedIn();

export async function useDemo(scenario = 'signedIn') {
  const { createDemo } = await import('./fake.js');
  active = createDemo(scenario, ReviewsError);
  summaryOffUntil = 0;
}

// Resumen de varios servidores para las tarjetas. Si falla no rompe nada, y si el servicio no está no vuelve a preguntar enseguida.
export async function summary(ids) {
  const list = (ids || []).slice(0, 100);
  if (!list.length || Date.now() < summaryOffUntil) return {};
  try {
    return (await active.rpc('featured_reviews_summary', { p_servers: list })) || {};
  } catch (err) {
    if (err?.code === 'unavailable') summaryOffUntil = Date.now() + SUMMARY_RETRY_MS;
    return {};
  }
}

export const list = (server, before = null, limit = 10) => active.rpc('featured_reviews_list', { p_server: server, p_before: before, p_limit: limit });
export const save = (server, stars, body) => active.rpc('featured_review_save', { p_server: server, p_stars: stars, p_body: body });
export const remove = (id) => active.rpc('featured_review_delete', { p_id: id });
export const vote = (server) => active.rpc('featured_server_vote', { p_server: server });
export const report = (id, reason, text) => active.rpc('featured_review_report', { p_id: id, p_reason: reason, p_text: text || null });

export const adminList = (filter, before = null) => active.rpc('admin_reviews_list', { p_filter: filter, p_before: before });
export const adminSetHidden = (id, hidden) => active.rpc('admin_review_set_hidden', { p_id: id, p_hidden: hidden });
export const adminDelete = (id) => active.rpc('admin_review_delete', { p_id: id });
export const adminDismiss = (id) => active.rpc('admin_review_dismiss', { p_id: id });
