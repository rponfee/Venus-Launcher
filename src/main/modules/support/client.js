'use strict';
// Tickets de Soporte (consultas generales). Los planes se pagan desde Planes: un ticket no pide ni activa planes.

const CATEGORIES = new Set(['general', 'account', 'payments', 'assistant', 'bug', 'other']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function coded(code, message) { return Object.assign(new Error(message), { code }); }
function text(value, name, min, max) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) {
    throw coded('badRequest', `${name}: ingresá entre ${min} y ${max} caracteres.`);
  }
  return value.trim();
}
function ticketId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw coded('badRequest', 'El ticket no es válido.');
  return value;
}
function rpcRequest(action, payload = {}) {
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  switch (action) {
    case 'staffState': return ['support_staff_state', {}];
    case 'list': return ['support_list_tickets', { p_admin: p.admin === true }];
    case 'create': {
      if (!CATEGORIES.has(p.category)) throw coded('badRequest', 'Elegí de qué se trata la consulta.');
      return ['support_open_ticket', { p_subject: text(p.subject, 'Asunto', 3, 120), p_category: p.category, p_message: text(p.message, 'Mensaje', 1, 4000) }];
    }
    case 'detail': return ['support_ticket_detail', { p_ticket: ticketId(p.ticketId) }];
    case 'reply': return ['support_add_message', { p_ticket: ticketId(p.ticketId), p_body: text(p.body, 'Mensaje', 1, 4000) }];
    case 'resolve': return ['support_resolve_ticket', { p_ticket: ticketId(p.ticketId), p_confirm_payment: false, p_note: text(p.note ?? '', 'Nota', 0, 2000) }];
    default: throw coded('badRequest', 'La acción de soporte no es válida.');
  }
}

function createSupportClient({ fetch, cloudConfig, accessToken }) {
  async function call(action, payload, expectedOwner) {
    const [name, body] = rpcRequest(action, payload);
    const cfg = await cloudConfig();
    if (!cfg?.configured) throw coded('noCloud', 'Soporte todavía no está conectado al servidor.');
    const token = await accessToken(expectedOwner);
    let response;
    try {
      response = await fetch(`${cfg.url}/rest/v1/rpc/${name}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', apikey: cfg.anonKey, Authorization: `Bearer ${token}` },
        body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
      });
    } catch {
      throw coded('network', 'No se pudo conectar con soporte. Revisá tu conexión y volvé a intentar.');
    }
    const data = await response.json().catch(() => null);
    if (response.ok) return data;
    if (response.status === 401) throw coded('noSession', 'Tu sesión venció. Volvé a iniciar sesión.');
    if (data?.code === 'P0002') throw coded('notFound', 'No se encontró ese ticket.');
    if (response.status === 404 || ['PGRST202', '42883', '42P01'].includes(data?.code)) throw coded('unavailable', 'El servidor todavía no tiene activado Soporte. El administrador debe instalar la actualización del servidor.');
    if (response.status === 403 || data?.code === '42501') throw coded('forbidden', 'No tenés permiso para realizar esta acción.');
    // Los textos del servidor (límites, ticket cerrado, datos inválidos) ya están pensados para mostrarse.
    const message = typeof data?.message === 'string' && data.message.length <= 200 ? data.message : null;
    if (response.status === 409 || data?.code === '23505') throw coded('conflict', message || 'Ya tenés demasiadas consultas abiertas. Seguí por una de esas.');
    if (['22023', '54000'].includes(data?.code) && message) throw coded('server', message);
    throw coded('server', 'No se pudo completar la solicitud de soporte. Actualizá los tickets antes de volver a intentar.');
  }
  return { call };
}
module.exports = { createSupportClient, rpcRequest, coded, CATEGORIES };
