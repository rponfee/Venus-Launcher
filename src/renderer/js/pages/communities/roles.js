// Comunidades: roles propios. El dueño crea, renombra y borra roles (hasta 15); el dueño y los moderadores se los asignan a miembros
// comunes (hasta 5 por cuenta). Un rol no modera: solo cambia lo que su gente puede hacer en cada canal (pages/communities/perms.js).
import { h, icon, mount, modal, ok, fail, confirmDialog, emptyState } from '../../ui.js';
import { t } from '../../i18n.js';
import { errText } from '../../features/communities/backend.js';
import { DEFAULT_ROLE_COLOR, ROLE_COLORS, ROLE_LIMITS, roleColor, validateRoleName } from '../../features/communities/permissions.js';
import { personName } from './logic.js';

const C = (key, vars) => t(`communities.${key}`, vars);

/** Dueño: lista de roles, crear, editar y borrar. reload devuelve la comunidad ya actualizada. */
export function openRolesDialog(b, initial, { reload } = {}) {
  if (initial.myRole !== 'owner') return null;
  let community = initial;
  let editing = null; // { id?, name, color }
  let busy = false;
  let closed = false;
  const body = h('div', { class: 'stack cm-roles' });
  const m = modal({ title: C('rolesTitle'), subtitle: community.name, icon: 'tag', size: 'lg', body, onClose: () => { closed = true; } });

  async function run(fn, success) {
    if (busy || closed) return;
    busy = true;
    draw();
    try {
      await fn();
      if (success) ok(success);
      const next = await reload?.();
      if (next && !closed) community = next;
      editing = null;
    } catch (err) {
      fail(C('actionError'), errText(err));
    } finally {
      busy = false;
      if (!closed) draw();
    }
  }

  function form() {
    const name = h('input', { class: 'input', id: 'cm-role-name', maxlength: String(ROLE_LIMITS.name), value: editing.name, autocomplete: 'off', placeholder: C('roleNamePlaceholder') });
    const swatches = h('div', { class: 'cm-swatches', role: 'radiogroup', 'aria-label': C('roleColor') });
    const error = h('div', { class: 'field-error', role: 'alert', hidden: true });
    const drawSwatches = () => mount(swatches, ROLE_COLORS.map((c) => h('button', { type: 'button', class: ['cm-swatch', c === editing.color && 'active'], role: 'radio', 'aria-checked': String(c === editing.color), 'aria-label': c, style: { background: c }, onclick: () => { editing.color = c; drawSwatches(); } })));
    drawSwatches();
    const save = h('button', { class: 'btn primary cm-role-save', type: 'button', disabled: busy ? true : null }, icon('save'), C('formSave'));
    save.addEventListener('click', () => {
      const check = validateRoleName(name.value, community.roles, editing.id || null);
      if (!check.ok) { error.textContent = C(`err_${check.error}`); error.hidden = false; return; }
      run(() => b.rpc('community_role_save', { p_community: community.id, p_name: check.value, p_color: editing.color, p_role: editing.id || null }), C('roleSaved'));
    });
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') save.click(); });
    return h('div', { class: 'card cm-role-form' },
      h('div', { class: 'field' }, h('label', { for: 'cm-role-name' }, C('roleName')), name),
      h('div', { class: 'field' }, h('span', { class: 'label' }, C('roleColor')), swatches),
      error,
      h('div', { class: 'row' }, save, h('button', { class: 'btn ghost', type: 'button', onclick: () => { editing = null; draw(); } }, C('cancel'))));
  }

  function draw() {
    if (closed) return;
    const roles = community.roles || [];
    const full = roles.length >= (community.maxRoles || ROLE_LIMITS.roles);
    mount(body,
      h('p', { class: 'card-sub' }, C('rolesIntro')),
      h('div', { class: 'row wrap' }, h('button', { class: 'btn primary cm-role-new', type: 'button', disabled: busy || full || !!editing, onclick: () => { editing = { name: '', color: DEFAULT_ROLE_COLOR }; draw(); } }, icon('plus'), C('roleCreate')),
        h('span', { class: 'cl-muted small' }, C('rolesCount', { n: roles.length, max: community.maxRoles || ROLE_LIMITS.roles }))),
      editing ? form() : null,
      roles.length ? h('ul', { class: 'cl-list cm-role-list' }, roles.map((r) => h('li', { class: 'cl-row cm-role-row', dataset: { id: r.id } },
        h('span', { class: 'cm-role-dot', style: { background: roleColor(r.color) } }),
        h('span', { class: 'cl-row-name ellipsis selectable', title: r.name }, r.name),
        h('span', { class: 'cl-muted small' }, C('roleMembers', { n: r.memberCount ?? 0, count: r.memberCount ?? 0 })),
        h('button', { class: 'icon-btn sm', type: 'button', disabled: busy, title: C('roleEdit'), 'aria-label': C('roleEdit'), onclick: () => { editing = { id: r.id, name: r.name, color: roleColor(r.color) }; draw(); } }, icon('edit')),
        h('button', { class: 'icon-btn sm', type: 'button', disabled: busy, title: C('roleDelete'), 'aria-label': C('roleDelete'), onclick: async () => {
          if (await confirmDialog(C('roleDeleteTitle'), C('roleDeleteText', { name: r.name }), { okText: C('delete'), danger: true })) run(() => b.rpc('community_role_delete', { p_role: r.id }), C('roleDeleted'));
        } }, icon('trash'))))) : emptyState('tag', C('rolesEmpty'), C('rolesEmptyText')));
  }
  draw();
  return m;
}

/** Equipo: roles propios de un miembro común. Cada casilla manda su cambio en el momento. */
export function openMemberRolesDialog(b, community, member, { reload } = {}) {
  if (!['owner', 'moderator'].includes(community.myRole) || member.role !== 'member') return null;
  const mine = new Set(member.roleIds || []);
  const pending = new Set();
  const list = h('ul', { class: 'cl-list cm-member-roles' });
  const note = h('p', { class: 'field-help' });
  const name = personName(member) || C('someone');
  const m = modal({ title: C('memberRolesTitle'), subtitle: name, icon: 'tag', size: 'sm', body: h('div', { class: 'stack' }, h('p', { class: 'card-sub' }, C('memberRolesIntro')), list, note) });

  function draw() {
    const roles = community.roles || [];
    note.textContent = C('memberRolesCount', { n: mine.size, max: ROLE_LIMITS.perMember });
    mount(list, roles.length ? roles.map((r) => {
      const box = h('input', { type: 'checkbox', checked: mine.has(r.id), disabled: pending.has(r.id) ? true : null, 'aria-label': r.name });
      box.addEventListener('change', async () => {
        const on = box.checked;
        pending.add(r.id);
        box.disabled = true;
        try {
          await b.rpc('community_role_assign', { p_community: community.id, p_user: member.userId, p_role: r.id, p_on: on });
          if (on) mine.add(r.id); else mine.delete(r.id);
          member.roleIds = [...mine];
          ok(C(on ? 'memberRoleAdded' : 'memberRoleRemoved', { role: r.name }));
          Promise.resolve(reload?.()).catch(() => {});
        } catch (err) {
          box.checked = !on;
          fail(C('actionError'), errText(err));
        } finally {
          pending.delete(r.id);
          draw();
        }
      });
      return h('li', { class: 'cl-row' }, h('label', { class: 'cm-check cl-row-name' }, box, h('span', { class: 'cm-role-dot', style: { background: roleColor(r.color) } }), h('span', { class: 'ellipsis' }, r.name)));
    }) : emptyState('tag', C('rolesEmpty'), community.myRole === 'owner' ? C('memberRolesCreateFirst') : C('memberRolesAskOwner')));
  }
  draw();
  return m;
}
