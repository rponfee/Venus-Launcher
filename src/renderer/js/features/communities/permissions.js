// Comunidades: permisos por canal y roles propios, lógica pura sin DOM. Es el espejo de private.community_perm_calc
// (supabase/migrations/0038_comunidades.sql), que es el que decide: acá solo sirve para mostrar, para la vista previa de lo que se
// está editando y para ocultar botones. Seis permisos: ver, escribir, enlaces y GIFs, reaccionar, entrar a voz y hablar.
export const PERMS = ['view', 'write', 'embeds', 'react', 'connect', 'speak'];
export const ROLE_LIMITS = { roles: 15, perMember: 5, name: 30 };
export const DEFAULT_ROLE_COLOR = '#94a3b8';
export const ROLE_COLORS = ['#94a3b8', '#ef4444', '#f59e0b', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'];

/** Qué permisos tienen sentido en cada tipo de canal: la voz no tiene texto y el texto no tiene voz. */
export function permsFor(kind) {
  return PERMS.filter((p) => p === 'view' || (kind === 'voice' ? p === 'connect' || p === 'speak' : p === 'write' || p === 'embeds' || p === 'react'));
}
export const permApplies = (kind, perm) => permsFor(kind).includes(perm);

/** "Todos" a partir del canal tal como lo devuelve community_get / community_channel_perms_get. */
export function everyoneOf(channel) {
  const e = channel?.everyone;
  if (e) return { view: e.view !== false, write: e.write !== false, embeds: e.embeds !== false, react: e.react !== false, connect: e.connect !== false, speak: e.speak !== false };
  return { view: !channel?.isPrivate, write: channel?.postingRole !== 'staff', embeds: true, react: true, connect: true, speak: true };
}

/**
 * Lo que puede hacer un rol en un canal. base: 'owner' | 'moderator' | 'member'. everyone: booleans de "todos".
 * overrides: { permiso: 'allow' | 'deny' } del rol propio (o la unión de los de una cuenta). Devuelve { perm: { allowed, source } }.
 * source: staff, everyone_allow, everyone_deny, role_allow, role_deny, needs_view, needs_write, needs_connect, not_applicable.
 */
export function explainPerms({ kind, base = 'member', everyone, overrides = {} }) {
  const out = {};
  const raw = {};
  for (const p of PERMS) {
    if (!permApplies(kind, p)) raw[p] = false;
    else if (base === 'owner' || base === 'moderator') raw[p] = true;
    else {
      let v = everyone[p] !== false;
      if (overrides[p] === 'deny') v = false;
      if (overrides[p] === 'allow') v = true;
      raw[p] = v;
    }
  }
  const view = raw.view;
  const final = {
    view, write: view && raw.write, embeds: view && raw.write && raw.embeds, react: view && raw.react,
    connect: view && raw.connect, speak: view && raw.connect && raw.speak,
  };
  for (const p of PERMS) {
    let source;
    if (!permApplies(kind, p)) source = 'not_applicable';
    else if (base === 'owner' || base === 'moderator') source = 'staff';
    else if (p !== 'view' && !view) source = 'needs_view';
    else if (p === 'embeds' && !final.write) source = 'needs_write';
    else if (p === 'speak' && !final.connect) source = 'needs_connect';
    else if (overrides[p] === 'allow') source = 'role_allow';
    else if (overrides[p] === 'deny') source = 'role_deny';
    else source = everyone[p] !== false ? 'everyone_allow' : 'everyone_deny';
    out[p] = { allowed: final[p], source };
  }
  return out;
}

/** Cuentas con varios roles propios: si alguno niega y otro permite, gana permitir (igual que el servidor). */
export function mergeOverrides(list) {
  const merged = {};
  for (const overrides of list) {
    for (const [perm, mode] of Object.entries(overrides || {})) {
      if (mode === 'allow') merged[perm] = 'allow';
      else if (mode === 'deny' && merged[perm] !== 'allow') merged[perm] = 'deny';
    }
  }
  return merged;
}

/** Lo que cambió entre dos estados del mismo sujeto, listo para community_channel_perms_set. {} si no hay cambios. */
export function diffPerms(before = {}, after = {}, { isEveryone = false } = {}) {
  const patch = {};
  for (const p of PERMS) {
    if (!(p in after)) continue;
    if (isEveryone) {
      if (Boolean(after[p]) !== Boolean(before[p])) patch[p] = Boolean(after[p]);
    } else if ((after[p] || 'inherit') !== (before[p] || 'inherit')) {
      patch[p] = after[p] || 'inherit';
    }
  }
  return patch;
}

/** Los permisos del canal para mostrar avisos: community_get ya trae can/canPost/canEmbed/canReact/canConnect/canSpeak. */
export function channelCan(channel, perm) {
  const flag = { write: 'canPost', embeds: 'canEmbed', react: 'canReact', connect: 'canConnect', speak: 'canSpeak' }[perm];
  if (flag && typeof channel?.[flag] === 'boolean') return channel[flag];
  if (typeof channel?.can?.[perm] === 'boolean') return channel.can[perm];
  return true;
}

export const sourceKey = (source) => `permSource_${source}`;
export const roleColor = (value) => (/^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value).toLowerCase() : DEFAULT_ROLE_COLOR);

/** Valida el nombre de un rol propio antes de mandarlo (misma regla que el servidor, salvo palabras reservadas). */
export function validateRoleName(value, existing = [], selfId = null) {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!name || [...name].length > ROLE_LIMITS.name || /[\u0000-\u001f\u007f<>]/.test(name)) return { ok: false, error: 'bad_role_name' };
  if (existing.some((r) => r.id !== selfId && String(r.name).toLowerCase() === name.toLowerCase())) return { ok: false, error: 'role_name_taken' };
  return { ok: true, value: name };
}

/** Roles propios de una cuenta a partir de los ids que trae la lista de miembros. */
export const rolesOf = (community, roleIds) => (community?.roles || []).filter((r) => (roleIds || []).includes(r.id));
