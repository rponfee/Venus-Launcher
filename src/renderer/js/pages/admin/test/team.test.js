'use strict';
// Pestaña Equipo (team.js) con un DOM mínimo y RPC falsas: el dueño ve Dar/Quitar acceso, un admin común ve la lista
// en solo lectura; las confirmaciones mandan la RPC justa (directo, no la Edge Function) y los errores se muestran por
// código, sin el texto crudo del servidor.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ui, loadRenderer, turn } = require('../../../features/clipstudio/test/ui-harness');

const ROOT = path.resolve(__dirname, '../../../../../..');
const readDict = (file) => {
  const ctx = { module: { exports: {} } };
  vm.runInNewContext(fs.readFileSync(file, 'utf8').replace(/^export default/m, 'module.exports ='), ctx);
  return ctx.module.exports;
};
const strings = readDict(path.join(ROOT, 'src/renderer/i18n/es/admin.js'));
const T = (key, vars = {}) => {
  const v = strings[key] ?? strings[`${key}_other`];
  assert.equal(typeof v, 'string', 'Falta admin.' + key);
  return v.replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m);
};
const LOGIC = loadRenderer(path.join(__dirname, '../team-logic.js'), ['TEAM_ERRORS', 'normalizeTeam', 'teamView', 'revokeState', 'personName', 'teamErrorCode'], {});

const OWNER = '00000000-0000-4000-8000-0000000000b1';
const ADMIN = '00000000-0000-4000-8000-0000000000b2';
const STAFF = '00000000-0000-4000-8000-0000000000b3';
const USER = '00000000-0000-4000-8000-0000000000b4';

const teamData = (meId, isOwner) => ({
  me: { userId: meId, isOwner },
  admins: [
    { userId: OWNER, username: 'Dueño', email: 'owner@example.test', grantedAt: '2026-01-01T00:00:00Z', isOwner: true, active: true, lastActionAt: '2026-11-01T00:00:00Z' },
    { userId: ADMIN, username: 'Lu', email: 'lu@example.test', grantedAt: '2026-09-01T00:00:00Z', isOwner: false, active: true, lastActionAt: null },
  ],
  staff: [{ userId: STAFF, username: 'Tomi', email: 'tomi@example.test', since: '2026-10-01T00:00:00Z', active: true }],
});

function rig({ meId = OWNER, isOwner = true, rpc, users = [] } = {}) {
  const dom = ui();
  const calls = [];
  const confirms = [];
  const notices = [];
  const h = (tag, props, ...children) => {
    const node = dom.deps.h(tag, props, ...children);
    node.dataset ||= {};
    return node;
  };
  // actionDialog: corre run() como el botón OK y devuelve el resultado o el texto del error (como el diálogo real).
  const actionDialog = async (opts) => {
    const d = { opts, error: null };
    confirms.push(d);
    try {
      return await opts.run();
    } catch (err) {
      d.error = err.message;
      return null;
    }
  };
  const respond = rpc || (async (name) => (name === 'admin_team' ? teamData(meId, isOwner) : { changed: true }));
  const deps = {
    ...dom.deps,
    ...LOGIC,
    h,
    T,
    ok: (text) => notices.push(text),
    debounce: (fn) => fn,
    fmtDay: (v) => `día(${v})`,
    fmtRelative: (v) => `hace(${v})`,
    displayName: (u) => u.username || u.email || u.id,
    card: ({ title, actions }, ...body) => h('section', { class: 'card' }, h('h2', {}, title), ...(actions || []).filter(Boolean), ...body),
    errorBox: (err, retry) => h('div', { class: 'error' }, err.message, h('button', { onclick: retry }, T('retry'))),
    skeletonRows: () => h('div', { class: 'skel' }),
    actionDialog,
    call: async (action, payload) => {
      calls.push({ kind: 'call', action, payload });
      return { users };
    },
    rpc: async (name, args) => {
      calls.push({ kind: 'rpc', name, args });
      return respond(name, args);
    },
  };
  const mod = loadRenderer(path.join(__dirname, '../team.js'), ['render', 'grantDialog', 'revokeDialog', 'staffDialog', 'pickUser', 'teamErrorText', 'fetchTeam'], deps);
  const root = h('div');
  root.attached = true;
  const ctx = { selfId: meId, team: () => mod.fetchTeam(), invalidateTeam() {}, onTeamChanged() { ctx.changed = (ctx.changed || 0) + 1; } };
  const api = mod.render(root, ctx);
  return { ...dom, mod, root, api, calls, confirms, notices, ctx };
}

const buttons = (el, key) => el.querySelectorAll('button').filter((b) => b.textContent.includes(T(key)));
const row = (r, id) => r.root.querySelectorAll('li').find((li) => li.dataset.user === id);

test('el dueño ve Dar acceso y Quitar acceso, pero no sobre sí mismo ni sobre otro dueño', async () => {
  const r = rig();
  await turn();
  assert.equal(r.calls[0].name, 'admin_team');
  assert.equal(buttons(r.root, 'team_grant').length, 1);
  assert.equal(buttons(row(r, OWNER), 'team_revoke').length, 0);
  assert.equal(buttons(row(r, ADMIN), 'team_revoke').length, 1);
  assert.ok(row(r, OWNER).textContent.includes(T('team_role_owner')));
  assert.ok(row(r, OWNER).textContent.includes(T('team_you')));
  assert.ok(row(r, OWNER).textContent.includes(T('team_lastAction', { when: 'hace(2026-11-01T00:00:00Z)' })));
  assert.ok(row(r, ADMIN).textContent.includes(T('team_noActions')));
  assert.equal(r.root.textContent.includes(T('team_readOnly')), false);
  assert.equal(buttons(row(r, STAFF), 'team_removeStaff').length, 1);
});

test('un admin común ve la lista en solo lectura: sin Dar ni Quitar acceso, con soporte', async () => {
  const r = rig({ meId: ADMIN, isOwner: false });
  await turn();
  assert.ok(r.root.textContent.includes(T('team_readOnly')));
  assert.equal(buttons(r.root, 'team_grant').length, 0);
  assert.equal(buttons(r.root, 'team_revoke').length, 0);
  assert.equal(buttons(r.root, 'team_addStaff').length, 1);
  assert.ok(row(r, ADMIN).textContent.includes(T('team_you')));
});

test('Quitar acceso confirma con el nombre y manda admin_revoke_admin por RPC', async () => {
  const r = rig();
  await turn();
  await buttons(row(r, ADMIN), 'team_revoke')[0].click();
  await turn();
  const d = r.confirms[0];
  assert.equal(d.opts.danger, true);
  assert.ok(d.opts.body.textContent.includes(T('team_revokeText', { name: 'Lu' })));
  const sent = r.calls.find((c) => c.name === 'admin_revoke_admin');
  assert.deepEqual(JSON.parse(JSON.stringify(sent.args)), { p_user: ADMIN });
  assert.equal(r.calls.some((c) => c.kind === 'call' && c.action !== 'users.list'), false, 'nada por la Edge Function');
  assert.deepEqual(r.notices, [T('team_revoked', { name: 'Lu' })]);
  assert.equal(r.ctx.changed, 1);
});

test('Dar acceso explica qué puede hacer un admin y manda admin_grant_admin', async () => {
  const r = rig();
  await turn();
  const res = await r.mod.grantDialog({ id: USER, name: 'Juli' });
  const body = r.confirms[0].opts.body.textContent;
  for (const k of ['team_grantCan1', 'team_grantCan2', 'team_grantCan3', 'team_grantCan4', 'team_grantCannot', 'team_grantWarn']) assert.ok(body.includes(T(k)), k);
  assert.ok(body.includes(T('team_grantLead', { name: 'Juli' })));
  assert.deepEqual(JSON.parse(JSON.stringify(r.calls.at(-1))), { kind: 'rpc', name: 'admin_grant_admin', args: { p_user: USER } });
  assert.deepEqual(JSON.parse(JSON.stringify(res)), { changed: true });
});

for (const [code, raw] of [
  ['owner_only', { message: 'owner_only', hint: 'owner_only', details: 'FAKE_PRIVATE_BODY' }],
  ['unconfirmed', new Error("Error invoking remote method 'admin:call': Error: unconfirmed")],
  ['cannot_self', { message: 'cannot_self' }],
  ['not_ready', { code: 'PGRST202', message: 'Could not find the function FAKE_PRIVATE_BODY' }],
  ['error', new Error('FAKE_PRIVATE_BODY')],
]) {
  test(`un error ${code} se muestra con su texto, sin el detalle del servidor`, async () => {
    const r = rig({ rpc: async (name) => { if (name === 'admin_team') return teamData(OWNER, true); throw raw; } });
    await turn();
    const res = await r.mod.grantDialog({ id: USER, name: 'Juli' });
    assert.equal(res, null);
    assert.equal(r.confirms[0].error, T(`team_err_${code}`));
    assert.equal(String(r.confirms[0].error).includes('FAKE_PRIVATE_BODY'), false);
  });
}

test('si el equipo no carga se ve el error traducido con Reintentar', async () => {
  let n = 0;
  const r = rig({ rpc: async (name) => { if (name === 'admin_team' && ++n === 1) throw { code: 'PGRST202', message: 'FAKE_PRIVATE_BODY' }; return teamData(OWNER, true); } });
  await turn();
  const box = r.root.querySelector('.error');
  assert.ok(box);
  assert.ok(box.textContent.includes(T('team_err_not_ready')));
  assert.equal(r.root.textContent.includes('FAKE_PRIVATE_BODY'), false);
  await buttons(box, 'retry')[0].onclick();
  await turn();
  assert.equal(buttons(r.root, 'team_grant').length, 1);
});

test('el buscador marca y deshabilita a quien ya es admin y no busca con menos de 2 letras', async () => {
  const r = rig({ users: [{ id: ADMIN, username: 'Lu', email: 'lu@example.test', emailConfirmed: true }, { id: USER, username: 'Juli', email: 'juli@example.test', emailConfirmed: true }] });
  await turn();
  const picking = r.mod.pickUser({ title: 'x', mark: (u) => (u.id === ADMIN ? T('team_pickAlready') : null) });
  const modalEl = () => r.dialogs.at(-1).el;
  const input = modalEl().querySelector('input');
  input.value = 'a';
  await input.listeners.input();
  assert.equal(r.calls.filter((c) => c.action === 'users.list').length, 0);
  input.value = 'ju';
  await input.listeners.input();
  await turn();
  const sent = r.calls.find((c) => c.action === 'users.list');
  assert.equal(sent.payload.search, 'ju');
  const picks = modalEl().querySelectorAll('button').filter((b) => b.role === 'listitem');
  assert.equal(picks.length, 2);
  assert.equal(picks[0].disabled, true);
  assert.ok(picks[0].textContent.includes(T('team_pickAlready')));
  picks[1].onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(await picking)), { id: USER, name: 'Juli' });
});
