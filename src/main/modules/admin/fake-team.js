'use strict';
// Equipo del panel (0057_admin_equipo.sql) y las RPC directas del Resumen, SOLO para el modo de datos de ejemplo
// (VENUS_DEVSHOT + VENUS_ADMIN_FAKE=1; lo usa fake.js con la acción 'rpc'). Todo en memoria: no habla con Supabase,
// así que no da ni quita permisos reales. Imita las reglas y los códigos de error del servidor (owner_only,
// cannot_self, owner_locked, unconfirmed, banned, bad_rank, admin_locked...) para poder ver cada caso en la interfaz.
// VENUS_ADMIN_FAKE_ROLE=admin muestra el panel como un admin común (el dueño es otra cuenta).

const DAY = 86400000;
const iso = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'));

function fail(code) {
  // Como PostgREST: el código en el mensaje y en el hint.
  const err = new Error(code);
  err.hint = code;
  return err;
}

/**
 * deps: { users() (lista viva de fake.js), adminId (quien mira), owner (¿quien mira es el dueño?), now, log(action,
 * target, details), audit() (registro, para la última acción) }.
 */
function createFakeTeam({ users, adminId, owner = true, now, log, audit }) {
  const list = () => users();
  const find = (id) => list().find((u) => u.id === id) || null;
  const ownerId = owner ? adminId : list()[4].id;
  const admins = new Map([[ownerId, now - 300 * DAY]]);
  if (!owner) admins.set(adminId, now - 90 * DAY);
  admins.set(list()[1].id, now - 40 * DAY);
  const ranks = new Map([[ownerId, 'owner'], [list()[1].id, 'admin'], [list()[5].id, 'mod']]);
  if (!owner) ranks.set(adminId, 'admin');
  // Soporte: uno activo y uno que se cambió el email (la fila sigue pero ya no vale).
  const staff = new Map([[list()[2].id, { since: now - 20 * DAY, valid: true }], [list()[7].id, { since: now - 60 * DAY, valid: false }]]);

  const banned = (u) => Boolean(u.moderation.bannedUntil && u.moderation.bannedUntil > now);
  const isAdmin = (id) => admins.has(id) && Boolean(find(id)) && !banned(find(id));
  const isOwner = (id) => isAdmin(id) && ranks.get(id) === 'owner';
  const lastAction = (id) => audit().find((a) => a.adminId === id)?.createdAt || null;
  const person = (id) => {
    const u = find(id);
    return { userId: id, username: u ? u.username : null, displayName: u ? u.username : null, email: u ? u.email : null };
  };

  function blocker(id) {
    const u = find(id);
    if (!u) return 'unknown_user';
    if (u.extra.unconfirmed) return 'unconfirmed';
    if (banned(u)) return 'banned';
    return null;
  }

  const handlers = {
    admin_team() {
      if (!isAdmin(adminId)) throw fail('admin_only');
      return {
        me: { userId: adminId, isOwner: isOwner(adminId) },
        admins: [...admins].map(([id, at]) => ({ ...person(id), grantedAt: iso(at), isOwner: ranks.get(id) === 'owner', active: isAdmin(id), lastActionAt: lastAction(id) })),
        staff: [...staff].map(([id, s]) => ({ ...person(id), since: iso(s.since), active: s.valid && !banned(find(id) || { moderation: {} }) })),
      };
    },
    admin_grant_admin({ p_user: id }) {
      if (!isOwner(adminId)) throw fail('owner_only');
      const why = blocker(id);
      if (why) throw fail(why);
      const before = ranks.get(id) || null;
      const changed = !admins.has(id) || !['admin', 'owner'].includes(before);
      admins.set(id, admins.get(id) || Date.now());
      if (!['admin', 'owner'].includes(before)) ranks.set(id, 'admin');
      if (changed) log('admin.grant', id, { rankFrom: before, rankTo: ranks.get(id) });
      return { userId: id, isAdmin: true, changed, rank: ranks.get(id) };
    },
    admin_revoke_admin({ p_user: id }) {
      if (!isOwner(adminId)) throw fail('owner_only');
      if (id === adminId) throw fail('cannot_self');
      if (!find(id)) throw fail('unknown_user');
      if (ranks.get(id) === 'owner') throw fail('owner_locked');
      const before = ranks.get(id) || null;
      const had = admins.delete(id);
      if (before === 'admin') ranks.delete(id);
      const changed = had || before === 'admin';
      if (changed) log('admin.revoke', id, { rankFrom: before, rankTo: before === 'admin' ? null : before, hadAccess: had });
      return { userId: id, isAdmin: false, changed, rank: ranks.get(id) || null };
    },
    admin_set_support_staff({ p_user: id, p_active: on }) {
      if (!isAdmin(adminId)) throw fail('admin_only');
      if (!id || typeof on !== 'boolean') throw fail('bad_request');
      let changed;
      if (on) {
        const why = blocker(id);
        if (why) throw fail(why);
        changed = !staff.get(id)?.valid;
        staff.set(id, { since: changed ? Date.now() : staff.get(id).since, valid: true });
      } else changed = staff.delete(id);
      if (changed) log(on ? 'support.staffGranted' : 'support.staffRevoked', id, { role: 'support', source: 'admin_panel' });
      return { userId: id, staff: on, changed };
    },
    admin_set_rank({ p_user: id, p_rank: rank }) {
      if (!isAdmin(adminId)) throw fail('admin_only');
      if (rank !== null && !['helper', 'mod'].includes(rank)) throw fail('bad_rank');
      if (!find(id)) throw fail('not_found');
      const before = ranks.get(id) || null;
      if (before === 'owner') throw fail('owner_locked');
      if (before === 'admin' && isAdmin(id)) throw fail('admin_locked');
      if (before !== rank) {
        if (rank) ranks.set(id, rank);
        else ranks.delete(id);
        log('rank.set', id, { from: before, to: rank });
      }
      return { rank };
    },
    // Resumen: motores de la IA (0056), claves y lo pendiente.
    admin_ai_providers: () => ({
      since: '2026-10-01',
      keys: { anthropic: false, openai: true },
      providers: [
        { provider: 'anthropic', monthUsd: 21.4402, monthCalls: 6020, wallets: 9, walletsLeftUsd: 61.2 },
        { provider: 'openai', monthUsd: 38.9113, monthCalls: 1180, wallets: 14, walletsLeftUsd: 102.75 },
      ],
    }),
    admin_openai_status: () => ({ configured: true, hint: 'a1b2' }),
    admin_anthropic_status: () => ({ configured: false, hint: null }),
    admin_klipy_status: () => ({ configured: true, hint: '9f3c' }),
    admin_curseforge_status: () => ({ configured: true, hint: '77aa' }),
    support_queue: () => ({ items: [], total: 3, page: 0, limit: 1, counts: { pending: 5, waiting: 3, unassigned: 2, mine: 1, closed: 40, ratingAvg: 4.6, ratingCount: 12 } }),
    admin_profile_reports: () => [{ id: 'rep-1', status: 'open' }, { id: 'rep-2', status: 'open' }, { id: 'rep-3', status: 'closed' }],
    admin_gallery_list: () => ({ items: [{ id: 'clip-1' }], more: false }),
  };

  return {
    isAdmin,
    rank: (id) => ranks.get(id) || null,
    rpc(name, args) {
      const fn = Object.prototype.hasOwnProperty.call(handlers, name) ? handlers[name] : null;
      if (!fn) {
        const err = new Error(`Could not find the function public.${String(name).slice(0, 60)}`);
        err.code = 'PGRST202';
        throw err;
      }
      return fn(args && typeof args === 'object' ? args : {});
    },
  };
}

module.exports = { createFakeTeam };
