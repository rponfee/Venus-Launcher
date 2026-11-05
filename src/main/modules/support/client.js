'use strict';
// Soporte: consultas con el equipo de Venus. Los planes se pagan desde Planes: una consulta no pide ni activa planes.
// Cada acción es una función SQL de Supabase (0016 + 0017 + 0045) que se llama con la identidad de la sesión; el permiso
// real lo decide el servidor. Acá se valida lo mismo que él para no gastar un viaje, y los errores salen con .code para
// que la interfaz los muestre en el idioma de la persona (los textos en español de acá son solo el respaldo).
const crypto = require('crypto');
const { CATEGORIES, PRIORITIES, STATUS_FILTERS, ASSIGNED_FILTERS, SORTS, LIMITS, cleanDetails, cleanDiagnostic, coded } = require('./rules');
const { checkUpload, isObjectPath } = require('./images');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEGACY = new Set(['general', 'account', 'payments', 'assistant', 'bug', 'other']);
// Avisos legibles por máquina que manda el servidor en `hint` (la interfaz tiene un texto para cada uno).
const HINTS = new Set(['bad_input', 'bad_details', 'bad_diagnostic', 'too_many_open', 'daily_limit', 'rate_minute', 'daily_messages',
  'ticket_full', 'closed', 'not_available', 'not_staff', 'banned', 'not_closed', 'reopen_expired', 'reopen_limit', 'attach_limit',
  'attach_ticket_full', 'attach_daily', 'attach_bad', 'attach_missing', 'payments_moved', 'macro_limit']);

function text(value, name, min, max) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) {
    throw coded('badRequest', `${name}: ingresá entre ${min} y ${max} caracteres.`);
  }
  return value.trim();
}
function id(value, name = 'El ticket') {
  if (typeof value !== 'string' || !UUID.test(value)) throw coded('badRequest', `${name} no es válido.`);
  return value;
}
function oneOf(value, list, name) {
  if (!list.includes(value)) throw coded('badRequest', `${name} no es válido.`);
  return value;
}

// Filtros de la cola del equipo: solo valores conocidos (el servidor vuelve a validar).
function cleanFilter(f) {
  const src = f && typeof f === 'object' && !Array.isArray(f) ? f : {};
  const out = {};
  if (src.status !== undefined) out.status = oneOf(src.status, STATUS_FILTERS, 'El estado');
  if (src.category) out.category = oneOf(src.category, CATEGORIES, 'El tema');
  if (src.priority) out.priority = oneOf(src.priority, PRIORITIES, 'La prioridad');
  if (src.assigned !== undefined) out.assigned = oneOf(src.assigned, ASSIGNED_FILTERS, 'La asignación');
  if (src.sort !== undefined) out.sort = oneOf(src.sort, SORTS, 'El orden');
  if (src.search !== undefined && src.search !== null && String(src.search).trim()) out.search = text(String(src.search), 'La búsqueda', 1, LIMITS.search);
  if (Number.isInteger(src.page) && src.page >= 0 && src.page < 10000) out.page = src.page;
  if (Number.isInteger(src.limit) && src.limit >= 1) out.limit = Math.min(src.limit, 100);
  return out;
}

function rpcRequest(action, payload = {}) {
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  switch (action) {
    case 'staffState': return ['support_staff_state', {}];
    case 'list': return ['support_list_tickets', { p_admin: p.admin === true }];
    case 'queue': return ['support_queue', { p_filter: cleanFilter(p.filter) }];
    case 'create': {
      oneOf(p.category, CATEGORIES, 'El tema');
      const subject = text(p.subject, 'Asunto', LIMITS.subject[0], LIMITS.subject[1]);
      const message = text(p.message, 'Mensaje', LIMITS.message[0], LIMITS.message[1]);
      const details = cleanDetails(p.category, p.details);
      const diagnostic = cleanDiagnostic(p.diagnostic);
      // Sin campos propios ni diagnóstico y con un tema de siempre: la función de siempre (anda también con un servidor sin 0045).
      if (!Object.keys(details).length && !diagnostic && LEGACY.has(p.category)) {
        return ['support_open_ticket', { p_subject: subject, p_category: p.category, p_message: message }];
      }
      return ['support_submit_ticket', { p_subject: subject, p_category: p.category, p_message: message, p_details: details, p_diagnostic: diagnostic }];
    }
    case 'detail': return ['support_ticket_detail', { p_ticket: id(p.ticketId) }];
    case 'reply': return ['support_add_message', { p_ticket: id(p.ticketId), p_body: text(p.body, 'Mensaje', LIMITS.message[0], LIMITS.message[1]) }];
    case 'resolve': return ['support_resolve_ticket', { p_ticket: id(p.ticketId), p_confirm_payment: false, p_note: text(p.note ?? '', 'Nota', 0, 2000) }];
    case 'closeOwn': return ['support_close_own_ticket', { p_ticket: id(p.ticketId), p_note: text(p.note ?? '', 'Nota', 0, LIMITS.closeNote) }];
    case 'reopen': return ['support_reopen_ticket', { p_ticket: id(p.ticketId), p_message: text(p.message ?? '', 'Mensaje', 0, LIMITS.message[1]) }];
    case 'rate': {
      if (!Number.isInteger(p.rating) || p.rating < LIMITS.rating[0] || p.rating > LIMITS.rating[1]) throw coded('badRequest', 'Elegí de 1 a 5 estrellas.');
      return ['support_rate_ticket', { p_ticket: id(p.ticketId), p_rating: p.rating, p_comment: text(p.comment ?? '', 'Comentario', 0, LIMITS.ratingComment) }];
    }
    case 'markSeen': return ['support_mark_seen', { p_ticket: id(p.ticketId) }];
    case 'unread': return ['support_unread_summary', {}];
    case 'diagnostic': {
      const diagnostic = cleanDiagnostic(p.diagnostic);
      if (!diagnostic) throw coded('badRequest', 'Tildá lo que querés enviar antes de adjuntar el diagnóstico.');
      return ['support_set_diagnostic', { p_ticket: id(p.ticketId), p_diagnostic: diagnostic }];
    }
    case 'attach': {
      const files = Array.isArray(p.files) ? p.files : [];
      if (!files.length || files.length > LIMITS.attachmentsPerSend) throw coded('attach_limit', 'Podés adjuntar hasta 3 capturas por envío.');
      return ['support_register_attachments', {
        p_ticket: id(p.ticketId), p_message: p.messageId ? id(p.messageId, 'El mensaje') : null,
        p_files: files.map((f) => {
          if (!isObjectPath(f?.path)) throw coded('attach_bad', 'La captura no es válida.');
          return { path: f.path, name: String(f.name ?? '').slice(0, LIMITS.attachmentName) };
        }),
      }];
    }
    case 'attachmentInfo': return ['support_attachment_info', { p_attachment: id(p.attachmentId, 'La captura') }];
    case 'assign': return ['support_assign', { p_ticket: id(p.ticketId), p_to: p.to ? id(p.to, 'La persona') : null }];
    case 'priority': return ['support_set_priority', { p_ticket: id(p.ticketId), p_priority: oneOf(p.priority, PRIORITIES, 'La prioridad') }];
    case 'note': return ['support_add_note', { p_ticket: id(p.ticketId), p_body: text(p.body, 'Nota', 1, LIMITS.note) }];
    case 'staffPanel': return ['support_staff_panel', { p_ticket: id(p.ticketId) }];
    case 'staffList': return ['support_staff_list', {}];
    case 'macros': return ['support_macros_list', {}];
    case 'macroSave': return ['support_macro_save', {
      p_id: p.id ? id(p.id, 'La respuesta') : null, p_title: text(p.title, 'Título', 1, LIMITS.macroTitle),
      p_body: text(p.body, 'Texto', 1, LIMITS.macroBody), p_shared: p.shared === true,
    }];
    case 'macroDelete': return ['support_macro_delete', { p_id: id(p.id, 'La respuesta') }];
    default: throw coded('badRequest', 'La acción de soporte no es válida.');
  }
}

// Convierte la respuesta de error de PostgREST o de Storage en un Error con .code.
function failure(response, data) {
  const hint = typeof data?.hint === 'string' && HINTS.has(data.hint) ? data.hint : null;
  // Los textos del servidor (límites, ticket cerrado, datos inválidos) ya están pensados para mostrarse.
  const message = typeof data?.message === 'string' && data.message.length <= 200 ? data.message : null;
  if (response.status === 401) return coded('noSession', 'Tu sesión venció. Volvé a iniciar sesión.');
  if (hint) return coded(hint, message || hint);
  if (data?.code === 'P0002') return coded('notFound', 'No se encontró ese ticket.');
  if (response.status === 404 || ['PGRST202', '42883', '42P01'].includes(data?.code)) {
    return coded('unavailable', 'El servidor todavía no tiene activado Soporte. El administrador debe instalar la actualización del servidor.');
  }
  if (response.status === 403 || data?.code === '42501') return coded('forbidden', 'No tenés permiso para realizar esta acción.');
  if (response.status === 409 || data?.code === '23505') return coded('conflict', message || 'Ya tenés demasiadas consultas abiertas. Seguí por una de esas.');
  if (['22023', '54000'].includes(data?.code) && message) return coded('server', message);
  return coded('server', 'No se pudo completar la solicitud de soporte. Actualizá los tickets antes de volver a intentar.');
}

function createSupportClient({ fetch, cloudConfig, accessToken }) {
  async function ready(expectedOwner) {
    const cfg = await cloudConfig();
    if (!cfg?.configured) throw coded('noCloud', 'Soporte todavía no está conectado al servidor.');
    return { cfg, token: await accessToken(expectedOwner) };
  }

  async function call(action, payload, expectedOwner) {
    const [name, body] = rpcRequest(action, payload);
    const { cfg, token } = await ready(expectedOwner);
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
    throw failure(response, data);
  }

  // Sube una captura a <usuario>/<consulta>/<uuid>.<ext>. Devuelve la ruta para registrarla con la acción attach.
  async function upload({ ticketId, bytes }, owner) {
    id(ticketId);
    id(owner, 'La cuenta');
    const file = checkUpload(bytes);
    const { cfg, token } = await ready(owner);
    const path = `${owner}/${ticketId}/${crypto.randomUUID()}.${file.ext}`;
    let response;
    try {
      response = await fetch(`${cfg.url}/storage/v1/object/support-attachments/${path}`, {
        method: 'POST', headers: { 'Content-Type': file.mime, apikey: cfg.anonKey, Authorization: `Bearer ${token}`, 'x-upsert': 'false' },
        body: file.bytes, signal: AbortSignal.timeout(60000),
      });
    } catch {
      throw coded('network', 'No se pudo subir la captura. Revisá tu conexión y volvé a intentar.');
    }
    if (response.ok) return { path, mime: file.mime, size: file.bytes.length };
    const data = await response.json().catch(() => null);
    if (response.status === 401) throw coded('noSession', 'Tu sesión venció. Volvé a iniciar sesión.');
    if (response.status === 413) throw coded('attach_big', 'La captura pesa más de 4 MB.');
    if (response.status === 404) throw coded('unavailable', 'El servidor todavía no tiene activadas las capturas.');
    throw coded('attach_denied', typeof data?.message === 'string' ? data.message.slice(0, 200) : 'No se pudo subir la captura.');
  }

  // Descarga una captura ya registrada (la ruta sale de attachmentInfo). Storage vuelve a comprobar el permiso.
  async function download(path, owner) {
    if (!isObjectPath(path)) throw coded('attach_bad', 'La captura no es válida.');
    const { cfg, token } = await ready(owner);
    let response;
    try {
      response = await fetch(`${cfg.url}/storage/v1/object/authenticated/support-attachments/${path}`, {
        headers: { apikey: cfg.anonKey, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60000),
      });
    } catch {
      throw coded('network', 'No se pudo cargar la captura.');
    }
    if (response.status === 401) throw coded('noSession', 'Tu sesión venció. Volvé a iniciar sesión.');
    if (!response.ok) throw coded('attach_missing', 'No se pudo cargar la captura.');
    const length = Number(response.headers?.get?.('content-length') || 0);
    if (length > LIMITS.attachmentBytes) throw coded('attach_big', 'La captura pesa más de 4 MB.');
    return checkUpload(Buffer.from(await response.arrayBuffer()));
  }

  return { call, upload, download };
}

module.exports = { createSupportClient, rpcRequest, failure, coded, CATEGORIES, HINTS };
