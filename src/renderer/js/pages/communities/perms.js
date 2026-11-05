// Comunidades: permisos de un canal. A la izquierda, a quién se le configura (todos, cada rol propio, moderadores y dueño); a la
// derecha, los permisos que tienen sentido en ese tipo de canal (ver, escribir, enlaces y GIFs, reaccionar, entrar a voz, hablar) y
// "qué puede hacer aquí": lo que resulta de verdad, con el motivo de cada uno. Moderadores y dueño saltean estas reglas. El servidor
// las aplica en RLS y en cada RPC (supabase/migrations/0038_comunidades.sql); acá solo se editan y se explican.
import { h, icon, mount, modal, ok, fail, setBusy, skeleton, emptyState, switchEl } from '../../ui.js';
import { t } from '../../i18n.js';
import { errText } from '../../features/communities/backend.js';
import { diffPerms, everyoneOf, explainPerms, permsFor, roleColor, sourceKey } from '../../features/communities/permissions.js';
import { isStaff } from './logic.js';

const C = (key, vars) => t(`communities.${key}`, vars);
const STATES = ['inherit', 'allow', 'deny'];

export function openChannelPermsDialog(b, community, channel, { reload } = {}) {
  if (!isStaff(community.myRole)) return null;
  let cfg = null;
  let draft = null;
  let subject = 'everyone';
  let closed = false;
  let pending = false;
  let seq = 0;
  const side = h('nav', { class: 'cm-perm-subjects', 'aria-label': C('permSubjects') });
  const main = h('div', { class: 'cm-perm-main stack' });
  const error = h('div', { class: 'field-error', role: 'alert', hidden: true });
  const cancel = h('button', { class: 'btn ghost', type: 'button' }, C('cancel'));
  const submit = h('button', { class: 'btn primary cm-perm-save', type: 'button' }, icon('save'), C('formSave'));
  const body = h('div', { class: 'cm-perm-layout' }, side, main);
  const m = modal({ title: C('permTitle'), subtitle: `# ${channel.name}`, icon: 'shield', size: 'lg', body: h('div', { class: 'stack' }, h('p', { class: 'card-sub' }, C('permIntro')), body, error), footer: [cancel, submit], onClose: () => { closed = true; } });
  cancel.addEventListener('click', () => m.close());
  mount(main, skeleton('list', { rows: 6 }));

  const snapshot = (value) => ({ everyone: everyoneOf(value), roles: Object.fromEntries((value.roles || []).map((r) => [r.roleId, { ...r.perms }])) });
  const subjects = () => [
    { id: 'everyone', label: C('permEveryone'), sub: C('permEveryoneSub'), icon: 'users' },
    ...(cfg.roles || []).map((r) => ({ id: r.roleId, label: r.name, color: roleColor(r.color), icon: 'tag' })),
    { id: 'moderator', label: C('role_moderator'), icon: 'shield', fixed: true },
    { id: 'owner', label: C('role_owner'), icon: 'crown', fixed: true },
  ];
  const dirtyPatch = (id) => id === 'everyone'
    ? diffPerms(everyoneOf(cfg), draft.everyone, { isEveryone: true })
    : diffPerms(cfg.roles.find((r) => r.roleId === id)?.perms || {}, draft.roles[id] || {});
  const isDirty = (id) => Object.keys(dirtyPatch(id)).length > 0;
  const anyDirty = () => ['everyone', ...cfg.roles.map((r) => r.roleId)].some(isDirty);

  // Resultado de verdad para el sujeto elegido. Con cambios sin guardar es una vista previa calculada acá; guardado, lo explica el servidor.
  async function effective(id) {
    if (['moderator', 'owner'].includes(id) || anyDirty()) {
      const res = explainPerms({ kind: cfg.kind, base: ['moderator', 'owner'].includes(id) ? id : 'member', everyone: draft.everyone, overrides: ['everyone', 'moderator', 'owner'].includes(id) ? {} : draft.roles[id] || {} });
      return { preview: anyDirty(), perms: Object.entries(res).map(([perm, v]) => ({ perm, ...v })) };
    }
    const res = await b.rpc('community_perms_explain', { p_channel: channel.id, p_subject: id });
    return { preview: false, perms: Array.isArray(res?.perms) ? res.perms : [] };
  }

  function row(perm, id) {
    const label = h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, C(`perm_${perm}`)), h('div', { class: 'tr-sub' }, C(`permHelp_${perm}`)));
    if (id === 'moderator' || id === 'owner') return h('div', { class: 'toggle-row cm-perm-row' }, label, h('span', { class: 'pill good' }, icon('check'), C('permAlways')));
    if (id === 'everyone') {
      return h('div', { class: 'toggle-row cm-perm-row', dataset: { perm } }, label, switchEl(draft.everyone[perm] !== false, (on) => { draft.everyone[perm] = on; error.hidden = true; redraw(); }, C(`perm_${perm}`)));
    }
    const own = (draft.roles[id] ||= {});
    const current = own[perm] || 'inherit';
    return h('div', { class: 'toggle-row cm-perm-row', dataset: { perm } }, label,
      h('div', { class: 'segmented cm-perm-states', role: 'group', 'aria-label': C(`perm_${perm}`) }, STATES.map((s) => h('button', {
        type: 'button', class: [s === current && 'active', `is-${s}`], 'aria-pressed': String(s === current), title: C(`permState_${s}_help`),
        onclick: () => { if (s === 'inherit') delete own[perm]; else own[perm] = s; error.hidden = true; redraw(); },
      }, C(`permState_${s}`)))));
  }

  async function drawEffective(host, id) {
    const my = ++seq;
    mount(host, skeleton('line', { width: 220 }));
    let res;
    try {
      res = await effective(id);
    } catch (err) {
      if (my === seq && !closed) mount(host, h('p', { class: 'field-error' }, errText(err)));
      return;
    }
    if (my !== seq || closed) return;
    const applicable = res.perms.filter((p) => permsFor(cfg.kind).includes(p.perm));
    mount(host,
      h('div', { class: 'row', style: { justifyContent: 'space-between' } }, h('h4', { class: 'cl-h4' }, C('permEffective')), h('span', { class: ['pill', res.preview ? 'warn' : 'good'] }, C(res.preview ? 'permPreview' : 'permSaved'))),
      h('ul', { class: 'cm-perm-effective' }, applicable.map((p) => h('li', { class: p.allowed ? 'is-yes' : 'is-no', dataset: { perm: p.perm } },
        icon(p.allowed ? 'check' : 'x'), h('strong', {}, C(`perm_${p.perm}`)), h('span', { class: 'cl-muted small' }, C(sourceKey(p.source)))))));
  }

  function redraw() {
    if (closed || !cfg) return;
    mount(side, subjects().map((s) => h('button', { type: 'button', class: ['cm-perm-subject', s.id === subject && 'active'], 'aria-current': s.id === subject ? 'true' : null, onclick: () => { subject = s.id; redraw(); } },
      s.color ? h('span', { class: 'cm-role-dot', style: { background: s.color } }) : icon(s.icon),
      h('span', { class: 'ellipsis' }, s.label), !s.fixed && isDirty(s.id) ? h('span', { class: 'cm-perm-dirty', title: C('permUnsaved'), 'aria-label': C('permUnsaved') }, '•') : null)));
    const current = subjects().find((s) => s.id === subject) || subjects()[0];
    const effectiveHost = h('div', { class: 'cm-perm-effective-box' });
    mount(main,
      h('div', {}, h('h3', { class: 'cl-h2' }, C('permFor', { subject: current.label })), current.sub ? h('p', { class: 'card-sub' }, current.sub) : null,
        current.fixed ? h('p', { class: 'card-sub' }, C('permStaffNote')) : subject === 'everyone' ? null : h('p', { class: 'card-sub' }, C('permRoleNote'))),
      h('div', { class: 'cm-perm-list' }, permsFor(cfg.kind).map((perm) => row(perm, subject))),
      !cfg.roles.length && subject === 'everyone' ? h('p', { class: 'cl-note' }, icon('info'), h('span', {}, C('permNoRoles'))) : null,
      effectiveHost);
    submit.disabled = pending || !anyDirty();
    drawEffective(effectiveHost, subject);
  }

  async function load() {
    try {
      cfg = await b.rpc('community_channel_perms_get', { p_channel: channel.id });
      if (closed) return;
      draft = snapshot(cfg);
      if (subject !== 'everyone' && !cfg.roles.some((r) => r.roleId === subject)) subject = 'everyone';
      redraw();
    } catch (err) {
      if (!closed) mount(main, emptyState('alert', errText(err), '', h('button', { class: 'btn', type: 'button', onclick: () => { mount(main, skeleton('list', { rows: 6 })); load(); } }, icon('refresh'), C('retry'))));
    }
  }

  submit.addEventListener('click', async () => {
    if (pending || closed || !cfg || !anyDirty()) return;
    error.hidden = true;
    pending = true;
    submit.disabled = true;
    const done = setBusy(submit);
    try {
      const order = ['everyone', ...cfg.roles.map((r) => r.roleId)].filter(isDirty);
      for (const id of order) {
        await b.rpc('community_channel_perms_set', { p_channel: channel.id, p_role: id === 'everyone' ? null : id, p_perms: dirtyPatch(id) });
      }
      ok(C('permSavedToast'));
      await reload?.();
      if (!closed) await load();
    } catch (err) {
      if (!closed) { error.textContent = errText(err); error.hidden = false; }
      else fail(C('actionError'), errText(err));
      if (!closed) await load();
    } finally {
      pending = false;
      done();
      if (!closed) redraw();
    }
  });
  load();
  return m;
}
