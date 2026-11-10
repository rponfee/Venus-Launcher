// Lógica sin DOM del panel de administración: el Equipo (quién ve qué, armado de las listas, errores por código), el
// rol de cada usuario, el rango de la ficha, lo pendiente y las claves del Resumen, las acciones del Registro y el
// orden de las pestañas. Sin imports: la prueban test/team-logic.test.js y test/team.test.js.
// La interfaz SOLO decide qué mostrar: quién puede dar o quitar admin lo decide el servidor dentro de cada RPC
// (supabase/migrations/0057_admin_equipo.sql). Guía: docs/admin.md.

// ---------- Errores ----------

// Códigos estables de 0057 (mensaje y hint). El orden importa: los más largos primero.
export const TEAM_ERRORS = ['grant_failed', 'unknown_user', 'owner_locked', 'admin_locked', 'cannot_self', 'owner_only', 'admin_only', 'bad_request', 'unconfirmed', 'bad_email', 'not_found', 'anonymous', 'bad_rank', 'banned'];

/** Código del error de una RPC del equipo ('not_ready' si falta la migración, 'error' si no se reconoce). */
export function teamErrorCode(err) {
  if (!err) return 'error';
  if (err.code === 'PGRST202' || err.code === '42883') return 'not_ready';
  const texts = [err.hint, err.message, err.details].filter((x) => typeof x === 'string' && x);
  for (const text of texts) {
    for (const code of TEAM_ERRORS) {
      if (new RegExp(`(^|[^a-z_])${code}($|[^a-z_])`).test(text)) return code;
    }
    if (/could not find the function|function .* does not exist/i.test(text)) return 'not_ready';
  }
  return 'error';
}

// ---------- Equipo ----------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const isoOf = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null);
const time = (v) => (v ? Date.parse(v) : Infinity);

function person(x) {
  return { userId: x.userId, username: str(x.username, 32), displayName: str(x.displayName, 32), email: str(x.email, 254) };
}

/**
 * Respuesta de admin_team -> { me: { userId, isOwner }, admins: [...], staff: [...] } con tipos seguros.
 * Admins: el dueño primero, después los activos y por antigüedad. Soporte: por antigüedad.
 */
export function normalizeTeam(data) {
  const d = data && typeof data === 'object' ? data : {};
  const me = { userId: UUID.test(d.me?.userId || '') ? d.me.userId : null, isOwner: d.me?.isOwner === true };
  const seen = new Set();
  const admins = (Array.isArray(d.admins) ? d.admins : [])
    .filter((x) => x && UUID.test(x.userId || '') && !seen.has(x.userId) && seen.add(x.userId))
    .map((x) => ({ ...person(x), grantedAt: isoOf(x.grantedAt), lastActionAt: isoOf(x.lastActionAt), isOwner: x.isOwner === true, active: x.active === true }))
    .sort((a, b) => Number(b.isOwner) - Number(a.isOwner) || Number(b.active) - Number(a.active) || time(a.grantedAt) - time(b.grantedAt));
  const seenStaff = new Set();
  const staff = (Array.isArray(d.staff) ? d.staff : [])
    .filter((x) => x && UUID.test(x.userId || '') && !seenStaff.has(x.userId) && seenStaff.add(x.userId))
    .map((x) => ({ ...person(x), since: isoOf(x.since), active: x.active === true }))
    .sort((a, b) => time(a.since) - time(b.since));
  return { me, admins, staff };
}

/** Nombre para mostrar (como el resto del panel: usuario, nombre visible, email o id). */
export function personName(p) {
  return p?.username || p?.displayName || p?.email || p?.userId || '?';
}

/**
 * Qué puede hacer quien mira (solo para la interfaz). Dar y quitar admin: solo el dueño. Soporte: cualquier admin.
 * { isOwner, canManageAdmins, canManageStaff, readOnly }
 */
export function teamView(team) {
  const isOwner = team?.me?.isOwner === true;
  return { isOwner, canManageAdmins: isOwner, canManageStaff: true, readOnly: !isOwner };
}

/** ¿Se le puede quitar el acceso a esta fila? { ok, reason: null | 'notOwner' | 'self' | 'owner' }. */
export function revokeState(row, team, selfId) {
  if (team?.me?.isOwner !== true) return { ok: false, reason: 'notOwner' };
  const me = team.me.userId || selfId;
  if (row?.userId && row.userId === me) return { ok: false, reason: 'self' };
  if (row?.isOwner) return { ok: false, reason: 'owner' };
  return { ok: true, reason: null };
}

/** Rol de un usuario según el equipo: 'owner' | 'admin' | 'support' | null (solo con acceso vigente). */
export function roleOf(userId, team) {
  if (!userId || !team) return null;
  const admin = (team.admins || []).find((a) => a.userId === userId);
  if (admin && admin.active) return admin.isOwner ? 'owner' : 'admin';
  const staff = (team.staff || []).find((s) => s.userId === userId);
  if (staff && staff.active) return 'support';
  return null;
}

/**
 * Sección "Acceso al panel" de la ficha. account: { emailConfirmed, isAnonymous? }, moderation: { banned }.
 * { role, isAdmin, isStaff, canGrant, canRevoke, revokeReason, grantBlocker, canToggleStaff, staffBlocker }
 * grantBlocker es solo un aviso previo ('unconfirmed', 'banned', 'already'); el servidor lo vuelve a revisar.
 */
export function accessState(userId, team, selfId, { account = {}, moderation = {} } = {}) {
  const role = roleOf(userId, team);
  const row = (team?.admins || []).find((a) => a.userId === userId) || null;
  const isAdmin = role === 'owner' || role === 'admin';
  const isStaff = (team?.staff || []).some((s) => s.userId === userId && s.active);
  const view = teamView(team);
  const accountBlocker = account.emailConfirmed === false ? 'unconfirmed' : moderation.banned ? 'banned' : null;
  const grantBlocker = isAdmin ? 'already' : accountBlocker;
  const revoke = row || isAdmin ? revokeState(row || { userId, isOwner: role === 'owner' }, team, selfId) : { ok: false, reason: 'notAdmin' };
  return {
    role,
    isAdmin,
    isStaff,
    canGrant: view.canManageAdmins && !grantBlocker,
    canRevoke: revoke.ok,
    revokeReason: revoke.reason,
    grantBlocker,
    canToggleStaff: view.canManageStaff && (isStaff || !accountBlocker),
    staffBlocker: isStaff ? null : accountBlocker,
  };
}

// ---------- Rango de la ficha ----------

// 'admin' ya no se elige: lo ponen y lo quitan Dar/Quitar acceso. 'owner' no se toca desde el panel.
export const RANK_OPTIONS = ['', 'helper', 'mod'];

/**
 * Cómo se muestra el rango: { mode: 'owner' | 'admin' | 'edit', options, legacy }.
 * legacy: insignia 'admin' vieja sin acceso real (se puede cambiar por otro rango o sacar).
 */
export function rankState(rank, isAdmin) {
  if (rank === 'owner') return { mode: 'owner', options: [], legacy: false };
  if (rank === 'admin' && isAdmin) return { mode: 'admin', options: [], legacy: false };
  const legacy = rank === 'admin';
  return { mode: 'edit', options: legacy ? ['admin', ...RANK_OPTIONS] : RANK_OPTIONS, legacy };
}

// ---------- Resumen ----------

/**
 * Uso de IA del mes por motor desde admin_ai_providers (0056). Sin ese dato (el servidor todavía no tiene la
 * función o respondió otra cosa) devuelve null y el Resumen oculta el bloque: no se adivina por el modelo.
 * -> [{ engine: 'anthropic' | 'openai', usd, calls, wallets, walletsLeftUsd }] o null
 */
export function aiByEngine(data) {
  if (!data || !Array.isArray(data.providers)) return null;
  const out = new Map();
  for (const p of data.providers) {
    if (!p || (p.provider !== 'anthropic' && p.provider !== 'openai') || out.has(p.provider)) continue;
    out.set(p.provider, { engine: p.provider, usd: Number(p.monthUsd) || 0, calls: Number(p.monthCalls) || 0, wallets: Number(p.wallets) || 0, walletsLeftUsd: Number(p.walletsLeftUsd) || 0 });
  }
  return out.size ? ['anthropic', 'openai'].filter((e) => out.has(e)).map((e) => out.get(e)) : null;
}

/** Claves de los motores desde admin_ai_providers: { anthropic, openai } con 'ok' | 'missing' | 'unknown', o null. */
export function engineKeyStates(data) {
  const k = data?.keys;
  if (!k || typeof k !== 'object') return null;
  const st = (v) => (v === true ? 'ok' : v === false ? 'missing' : 'unknown');
  return { anthropic: st(k.anthropic), openai: st(k.openai) };
}

// Claves e integraciones que revisa el Resumen, en orden de importancia. 'needed': sin ella algo deja de andar.
export const KEY_CHECKS = [
  { id: 'openai', rpc: 'admin_openai_status', needed: true },
  { id: 'anthropic', rpc: 'admin_anthropic_status', needed: true },
  { id: 'payments', needed: true },
  { id: 'curseforge', rpc: 'admin_curseforge_status', needed: false },
  { id: 'klipy', rpc: 'admin_klipy_status', needed: false },
];

/** Estado de una clave a partir de su RPC de estado: 'ok' | 'missing' | 'notReady' (falta la función) | 'unknown'. */
export function keyState(result) {
  if (result && result.ok) return result.data?.configured === true ? 'ok' : result.data?.configured === false ? 'missing' : 'unknown';
  if (result && teamErrorCode(result.error) === 'not_ready') return 'notReady';
  return 'unknown';
}

/** Pagos: 'ok' si al menos un medio está listo, 'missing' si ninguno, 'unknown' si no se pudo leer. */
export function paymentsState(result) {
  if (!result || !result.ok) return 'unknown';
  const c = result.data?.config || {};
  if (c.mercadoPago?.ready || c.paypal?.ready) return 'ok';
  return 'missing';
}

/** Avisos del Resumen: las claves necesarias que faltan. */
export function keyAlerts(states) {
  return KEY_CHECKS.filter((k) => k.needed && states?.[k.id] === 'missing').map((k) => k.id);
}

/**
 * Accesos directos a lo pendiente: [{ id, tab, count }] solo con números conocidos y mayores que cero.
 * counts: { tickets, reports, gallery, payments } (null = no se pudo leer).
 */
export function pendingShortcuts(counts) {
  const tabs = { tickets: 'support', reports: 'reports', gallery: 'gallery', payments: 'payments' };
  return Object.keys(tabs)
    .map((id) => ({ id, tab: tabs[id], count: Number.isFinite(counts?.[id]) ? counts[id] : null }))
    .filter((x) => x.count !== null && x.count > 0);
}

// ---------- Registro ----------

// Acciones con texto propio (las demás se muestran con su código). Grupos: prefijo terminado en punto.
export const AUDIT_ACTIONS = [
  'admin.grant',
  'admin.revoke',
  'support.staffGranted',
  'support.staffRevoked',
  'rank.set',
  'users.setPlan',
  'users.removePlan',
  'users.ban',
  'users.unban',
  'users.mute',
  'users.unmute',
  'users.signOut',
  'users.resetUsage',
  'users.delete',
  'users.setNotes',
  'plans.update',
  'plans.setPrice',
  'openai.key',
  'anthropic.key',
  'curseforge.key',
  'klipy.key',
  'gallery.hide',
  'gallery.show',
  'gallery.delete',
  'gallery.close',
  'sticker.delete',
  'stripe.cancelSubscription',
  'coupons.create',
  'coupons.addPromo',
  'coupons.deactivatePromo',
  'coupons.activatePromo',
  'coupons.delete',
];
export const AUDIT_GROUPS = ['admin.', 'support.', 'users.', 'plans.', 'gallery.'];
// Claves del registro de las integraciones (no tienen un prefijo común).
const KEY_ACTIONS = new Set(['openai.key', 'anthropic.key', 'curseforge.key', 'klipy.key']);

/** Clave de texto de una acción conocida ('a_admin_grant') o null. */
export function auditLabelKey(action) {
  return AUDIT_ACTIONS.includes(action) ? `a_${action.replace('.', '_')}` : null;
}

/** Tono de la etiqueta: lo que quita o corta en rojo, lo del equipo y las claves en acento, el resto informativo. */
export function auditTone(action) {
  const a = String(action || '');
  if (a === 'users.delete' || a.endsWith('.ban') || a === 'admin.revoke' || a.endsWith('.delete')) return 'bad';
  if (a.startsWith('admin.') || a.startsWith('support.') || KEY_ACTIONS.has(a)) return 'accent';
  return 'info';
}

// ---------- Pestañas ----------

// Agrupadas por uso: lo de todos los días, moderación y ajustes del proyecto.
export const TAB_GROUPS = [
  { id: 'daily', tabs: ['overview', 'support', 'users', 'payments'] },
  { id: 'moderation', tabs: ['reports', 'gallery', 'reviews', 'stickers'] },
  { id: 'settings', tabs: ['plans', 'integrations', 'team', 'audit'] },
];
export const TAB_ORDER = TAB_GROUPS.flatMap((g) => g.tabs);

/** Pestaña siguiente con el teclado (flechas, Inicio, Fin) o null. */
export function nextTab(current, key, order = TAB_ORDER) {
  const i = Math.max(0, order.indexOf(current));
  if (key === 'ArrowRight' || key === 'ArrowDown') return order[(i + 1) % order.length];
  if (key === 'ArrowLeft' || key === 'ArrowUp') return order[(i - 1 + order.length) % order.length];
  if (key === 'Home') return order[0];
  if (key === 'End') return order[order.length - 1];
  return null;
}
