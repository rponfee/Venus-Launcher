// Pestaña Equipo: administradores (el dueño marcado, desde cuándo y última acción) y personal de soporte. Dar y quitar
// el acceso de administrador lo ve solo el dueño; los demás admins ven la lista en solo lectura y pueden sumar o
// quitar personal de soporte. Va directo por RPC con la sesión (0057_admin_equipo.sql), no por la Edge Function.
// El servidor lo vuelve a decidir en cada RPC: esto solo decide qué se muestra. También exporta los diálogos que usa
// la ficha del usuario (user-drawer.js). Guía: docs/admin.md.
import { h, icon, mount, modal, ok, emptyState, debounce } from '../../ui.js';
import { T, call, rpc, fmtDay, fmtRelative, card, errorBox, skeletonRows, displayName } from './parts.js';
import { actionDialog } from './dialogs.js';
import { TEAM_ERRORS, normalizeTeam, teamView, revokeState, personName, teamErrorCode } from './team-logic.js';

const KNOWN_ERRORS = new Set([...TEAM_ERRORS, 'not_ready', 'error']);

/** Texto del error de una RPC del equipo, por código (nunca el mensaje crudo del servidor). */
export function teamErrorText(err) {
  const code = teamErrorCode(err);
  return T(`team_err_${KNOWN_ERRORS.has(code) ? code : 'error'}`);
}

// Error con el texto ya traducido (lo muestra actionDialog adentro del diálogo).
function failure(err) {
  const e = new Error(teamErrorText(err));
  e.code = teamErrorCode(err);
  return e;
}

async function guarded(name, args) {
  try {
    return await rpc(name, args);
  } catch (err) {
    throw failure(err);
  }
}

/** Equipo actual (admin_team), ya normalizado. */
export async function fetchTeam() {
  return normalizeTeam(await rpc('admin_team'));
}

// ---------- Diálogos (los usa también la ficha) ----------

/** Dar acceso de administrador: explica qué va a poder hacer. user: { id, name }. Devuelve el resultado o null. */
export function grantDialog(user) {
  const can = ['team_grantCan1', 'team_grantCan2', 'team_grantCan3', 'team_grantCan4'];
  return actionDialog({
    title: T('team_grantTitle'),
    body: h(
      'div',
      { class: 'stack' },
      h('p', { class: 'text-2' }, T('team_grantLead', { name: user.name })),
      h('ul', { class: 'adm-team-can' }, can.map((k) => h('li', {}, icon('check'), T(k)))),
      h('p', { class: 'small text-2' }, T('team_grantCannot')),
      h('div', { class: 'notice warn' }, icon('shieldAlert'), h('div', {}, T('team_grantWarn'))),
    ),
    okText: T('team_grantOk'),
    okIcon: 'shieldCheck',
    run: () => guarded('admin_grant_admin', { p_user: user.id }),
  });
}

/** Quitar el acceso de administrador (confirmación con el nombre). */
export function revokeDialog(user) {
  return actionDialog({
    title: T('team_revokeTitle'),
    body: h('p', { class: 'text-2' }, T('team_revokeText', { name: user.name })),
    okText: T('team_revokeOk'),
    okIcon: 'x',
    danger: true,
    run: () => guarded('admin_revoke_admin', { p_user: user.id }),
  });
}

/** Sumar o quitar de soporte. */
export function staffDialog(user, on) {
  return actionDialog({
    title: T(on ? 'team_staffAddTitle' : 'team_staffRemoveTitle'),
    body: h('p', { class: 'text-2' }, T(on ? 'team_staffAddText' : 'team_staffRemoveText', { name: user.name })),
    okText: T(on ? 'team_staffAddOk' : 'team_staffRemoveOk'),
    okIcon: on ? 'plus' : 'x',
    danger: !on,
    run: () => guarded('admin_set_support_staff', { p_user: user.id, p_active: on }),
  });
}

/**
 * Buscador de cuentas (el mismo de la pestaña Usuarios: users.list). mark(user) -> texto que la deshabilita o null.
 * Devuelve { id, name } o null.
 */
export function pickUser({ title, mark = () => null }) {
  return new Promise((resolve) => {
    let done = false;
    let seq = 0;
    const input = h('input', { class: 'input', type: 'search', placeholder: T('team_pickSearch'), 'aria-label': T('team_pickSearch'), maxlength: 100, autocomplete: 'off' });
    const results = h('div', { class: 'adm-pick-list', role: 'list', 'aria-live': 'polite' }, h('p', { class: 'muted small' }, T('team_pickHint')));
    const finish = (value) => {
      if (done) return;
      done = true;
      m.close();
      resolve(value);
    };
    async function search() {
      const q = input.value.trim();
      const my = ++seq;
      if (q.length < 2) return mount(results, h('p', { class: 'muted small' }, T('team_pickHint')));
      mount(results, skeletonRows(3));
      try {
        const data = await call('users.list', { search: q, page: 1, perPage: 8, sort: 'lastSignIn' });
        if (my !== seq || done) return;
        const users = Array.isArray(data?.users) ? data.users : [];
        if (!users.length) return mount(results, h('p', { class: 'muted small' }, T('team_pickEmpty')));
        mount(
          results,
          users.map((u) => {
            const name = displayName(u);
            const why = mark(u);
            return h(
              'button',
              { type: 'button', class: 'adm-pick', role: 'listitem', disabled: Boolean(why), onclick: () => finish({ id: u.id, name }) },
              h('span', { class: 'adm-avatar sm', 'aria-hidden': 'true' }, name.slice(0, 1).toUpperCase()),
              h('span', { class: 'adm-pick-text' }, h('span', { class: 'adm-user-name ellipsis' }, name), h('span', { class: 'adm-user-email ellipsis' }, u.email || '—')),
              why ? h('span', { class: 'badge' }, why) : icon('chevronRight'),
            );
          }),
        );
      } catch (err) {
        if (my === seq && !done) mount(results, errorBox(err, search));
      }
    }
    input.addEventListener('input', debounce(search, 300));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') search();
    });
    const m = modal({
      title,
      body: h('div', { class: 'stack adm-dialog' }, h('div', { class: 'input-icon' }, icon('search'), input), results),
      footer: [h('button', { class: 'btn ghost', type: 'button', onclick: () => finish(null) }, T('cancel'))],
      onClose: () => finish(null),
    });
    setTimeout(() => input.focus?.(), 0);
  });
}

// ---------- Pestaña ----------

function avatar(p) {
  return h('div', { class: 'adm-avatar sm', 'aria-hidden': 'true' }, personName(p).slice(0, 1).toUpperCase());
}

export function render(root, ctx = {}) {
  let alive = true;
  let team = null;
  let seq = 0;
  const host = h('div', { class: 'adm-team' });
  mount(root, host);

  async function load() {
    const my = ++seq;
    if (!team) mount(host, skeletonRows(8));
    try {
      ctx.invalidateTeam?.();
      const next = ctx.team ? await ctx.team() : await fetchTeam();
      if (!alive || my !== seq) return;
      team = next;
      draw();
    } catch (err) {
      if (!alive || my !== seq) return;
      mount(host, errorBox({ message: teamErrorText(err) }, load));
    }
  }

  // Después de un cambio: aviso, equipo nuevo (y la lista de Usuarios con el rol nuevo).
  async function changed(text) {
    ok(text);
    ctx.onTeamChanged?.();
    await load();
  }

  const isAdminRow = (u) => team.admins.some((a) => a.userId === u.id && a.active);
  const isStaffRow = (u) => team.staff.some((s) => s.userId === u.id && s.active);

  async function grant() {
    const user = await pickUser({
      title: T('team_grantTitle'),
      mark: (u) => (isAdminRow(u) ? T('team_pickAlready') : u.emailConfirmed === false ? T('pill_unconfirmed') : u.moderation?.banned ? T('pill_banned') : null),
    });
    if (!user || !alive) return;
    const res = await grantDialog(user);
    if (res) changed(T(res.changed === false ? 'team_grantedSame' : 'team_granted', { name: user.name }));
  }

  async function revoke(row) {
    const user = { id: row.userId, name: personName(row) };
    const res = await revokeDialog(user);
    if (res) changed(T('team_revoked', { name: user.name }));
  }

  async function addStaff() {
    const user = await pickUser({
      title: T('team_staffAddTitle'),
      mark: (u) => (isStaffRow(u) ? T('team_pickStaffAlready') : u.emailConfirmed === false ? T('pill_unconfirmed') : u.moderation?.banned ? T('pill_banned') : null),
    });
    if (!user || !alive) return;
    const res = await staffDialog(user, true);
    if (res) changed(T('team_staffAdded', { name: user.name }));
  }

  async function removeStaff(row) {
    const user = { id: row.userId, name: personName(row) };
    const res = await staffDialog(user, false);
    if (res) changed(T('team_staffRemoved', { name: user.name }));
  }

  function personCell(p, pills) {
    const name = personName(p);
    const open = ctx.openUser ? h('button', { class: 'adm-link adm-user-name', type: 'button', onclick: () => ctx.openUser(p.userId, name) }, name) : h('span', { class: 'adm-user-name ellipsis' }, name);
    return h('div', { class: 'adm-user' }, avatar(p), h('div', { class: 'adm-user-text' }, h('div', { class: 'row wrap adm-team-name' }, open, pills), h('div', { class: 'adm-user-email ellipsis', title: p.email || '' }, p.email || '—')));
  }

  function adminRow(a, view) {
    const me = a.userId === (team.me.userId || ctx.selfId);
    const pills = [
      a.isOwner ? h('span', { class: 'pill good' }, icon('crown'), T('team_role_owner')) : h('span', { class: 'pill info' }, icon('shieldCheck'), T('team_role_admin')),
      me ? h('span', { class: 'pill' }, T('team_you')) : null,
      a.active ? null : h('span', { class: 'pill warn', title: T('team_inactiveHint') }, icon('alert'), T('team_inactive')),
    ];
    const state = revokeState(a, team, ctx.selfId);
    const action = state.ok
      ? h('button', { class: 'btn sm danger', type: 'button', onclick: () => revoke(a) }, icon('x'), T('team_revoke'))
      : view.canManageAdmins && state.reason === 'owner' ? h('span', { class: 'tiny muted' }, T('team_ownerLockedHint')) : null;
    return h(
      'li',
      { class: ['adm-team-row', !a.active && 'off'], dataset: { user: a.userId } },
      personCell(a, pills),
      h('div', { class: 'adm-team-meta small text-2' }, h('div', {}, T('team_since', { date: fmtDay(a.grantedAt) })), h('div', { class: 'tiny muted' }, a.lastActionAt ? T('team_lastAction', { when: fmtRelative(a.lastActionAt) }) : T('team_noActions'))),
      h('div', { class: 'adm-team-actions' }, action),
    );
  }

  function staffRow(s, view) {
    const pills = [s.active ? h('span', { class: 'pill' }, icon('message'), T('team_role_support')) : h('span', { class: 'pill warn', title: T('team_staffInactiveHint') }, icon('alert'), T('team_inactive'))];
    return h(
      'li',
      { class: ['adm-team-row', !s.active && 'off'], dataset: { user: s.userId } },
      personCell(s, pills),
      h('div', { class: 'adm-team-meta small text-2' }, T('team_staffSince', { date: fmtDay(s.since) })),
      h('div', { class: 'adm-team-actions' }, view.canManageStaff ? h('button', { class: 'btn sm', type: 'button', onclick: () => removeStaff(s) }, icon('x'), T('team_removeStaff')) : null),
    );
  }

  function roles() {
    return card(
      { icon: 'info', title: T('team_rolesTitle') },
      h(
        'dl',
        { class: 'adm-roles' },
        ['owner', 'admin', 'support'].map((r) => h('div', { class: 'adm-role' }, h('dt', {}, T(`team_role_${r}`)), h('dd', {}, T(`team_role_${r}Text`)))),
      ),
    );
  }

  function draw() {
    const view = teamView(team);
    const grantBtn = view.canManageAdmins ? h('button', { class: 'btn primary sm', type: 'button', onclick: grant }, icon('plus'), T('team_grant')) : null;
    const staffBtn = view.canManageStaff ? h('button', { class: 'btn sm', type: 'button', onclick: addStaff }, icon('plus'), T('team_addStaff')) : null;
    mount(
      host,
      view.readOnly ? h('div', { class: 'notice info adm-team-note', role: 'note' }, icon('info'), h('div', {}, T('team_readOnly'))) : null,
      card(
        { icon: 'shieldCheck', title: T('team_adminsTitle'), sub: T('team_adminsSub'), actions: [grantBtn] },
        team.admins.length ? h('ul', { class: 'adm-team-list' }, team.admins.map((a) => adminRow(a, view))) : emptyState('shieldCheck', T('team_emptyAdmins'), null),
      ),
      card(
        { icon: 'message', title: T('team_staffTitle'), sub: T('team_staffSub'), actions: [staffBtn] },
        team.staff.length ? h('ul', { class: 'adm-team-list' }, team.staff.map((s) => staffRow(s, view))) : emptyState('message', T('team_emptyStaff'), T('team_emptyStaffText')),
      ),
      roles(),
    );
  }

  load();
  return {
    refresh: load,
    destroy() {
      alive = false;
    },
  };
}
