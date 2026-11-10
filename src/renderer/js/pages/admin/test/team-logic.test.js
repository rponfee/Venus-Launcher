'use strict';
// Lógica del Equipo y de las mejoras del panel (team-logic.js), sin DOM: errores por código, quién ve qué, armado de
// las listas, rango de la ficha, Resumen (motores, claves, pendientes), Registro y pestañas. Además revisa que cada
// texto que usan las pestañas tocadas exista en español e inglés.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadRenderer } = require('../../../features/clipstudio/test/ui-harness');

const ROOT = path.resolve(__dirname, '../../../../../..');
const readDict = (file) => {
  const ctx = { module: { exports: {} } };
  vm.runInNewContext(fs.readFileSync(file, 'utf8').replace(/^export default/m, 'module.exports ='), ctx);
  return ctx.module.exports;
};
const ES = readDict(path.join(ROOT, 'src/renderer/i18n/es/admin.js'));
const EN = readDict(path.join(ROOT, 'src/renderer/i18n/en/admin.js'));

const NAMES = ['TEAM_ERRORS', 'teamErrorCode', 'normalizeTeam', 'personName', 'teamView', 'revokeState', 'roleOf', 'accessState', 'RANK_OPTIONS', 'rankState', 'aiByEngine', 'engineKeyStates', 'KEY_CHECKS', 'keyState', 'paymentsState', 'keyAlerts', 'pendingShortcuts', 'AUDIT_ACTIONS', 'AUDIT_GROUPS', 'auditLabelKey', 'auditTone', 'TAB_GROUPS', 'TAB_ORDER', 'nextTab'];
const L = loadRenderer(path.join(__dirname, '../team-logic.js'), NAMES, {});
const plain = (v) => JSON.parse(JSON.stringify(v));

const OWNER = '00000000-0000-4000-8000-0000000000a1';
const ADMIN = '00000000-0000-4000-8000-0000000000a2';
const STAFF = '00000000-0000-4000-8000-0000000000a3';
const USER = '00000000-0000-4000-8000-0000000000a4';
const OLD = '00000000-0000-4000-8000-0000000000a5';

function team(meId, isOwner) {
  return L.normalizeTeam({
    me: { userId: meId, isOwner },
    admins: [
      { userId: ADMIN, username: 'Lu', email: 'lu@example.test', grantedAt: '2026-09-01T00:00:00Z', isOwner: false, active: true, lastActionAt: null },
      { userId: OLD, username: 'Viejo', grantedAt: '2026-01-01T00:00:00Z', isOwner: false, active: false },
      { userId: OWNER, username: 'Dueño', grantedAt: '2026-03-01T00:00:00Z', isOwner: true, active: true, lastActionAt: '2026-10-01T00:00:00Z' },
      { userId: 'no-es-uuid', username: 'x', active: true },
      { userId: ADMIN, username: 'duplicado', active: true },
    ],
    staff: [{ userId: STAFF, username: 'Tomi', since: '2026-10-01T00:00:00Z', active: true }],
  });
}

test('teamErrorCode: reconoce el código por hint, mensaje o el texto del IPC, y nada más', () => {
  assert.equal(L.teamErrorCode({ hint: 'owner_only', message: 'owner_only' }), 'owner_only');
  assert.equal(L.teamErrorCode({ message: "Error invoking remote method 'admin:call': Error: cannot_self" }), 'cannot_self');
  assert.equal(L.teamErrorCode({ message: 'unknown_user' }), 'unknown_user');
  assert.equal(L.teamErrorCode({ code: 'PGRST202', message: 'Could not find the function public.admin_team' }), 'not_ready');
  assert.equal(L.teamErrorCode({ message: 'Could not find the function public.admin_grant_admin(p_user)' }), 'not_ready');
  assert.equal(L.teamErrorCode({ message: 'FAKE_PRIVATE_BODY not_owner_onlyx' }), 'error');
  assert.equal(L.teamErrorCode(new Error('fetch failed')), 'error');
  assert.equal(L.teamErrorCode(null), 'error');
});

test('normalizeTeam: dueño primero, activos antes que inactivos, sin ids raros ni repetidos', () => {
  const t = team(OWNER, true);
  assert.deepEqual(t.admins.map((a) => a.userId), [OWNER, ADMIN, OLD]);
  assert.equal(t.admins[1].username, 'Lu');
  assert.equal(t.me.isOwner, true);
  assert.equal(L.normalizeTeam({ me: { isOwner: 'true' } }).me.isOwner, false, 'solo true cuenta');
  assert.deepEqual(plain(L.normalizeTeam(null)), { me: { userId: null, isOwner: false }, admins: [], staff: [] });
  assert.equal(L.personName({ email: 'a@example.test' }), 'a@example.test');
});

test('quién ve qué: el dueño da y quita; un admin común solo mira y maneja soporte', () => {
  assert.deepEqual(plain(L.teamView(team(OWNER, true))), { isOwner: true, canManageAdmins: true, canManageStaff: true, readOnly: false });
  assert.deepEqual(plain(L.teamView(team(ADMIN, false))), { isOwner: false, canManageAdmins: false, canManageStaff: true, readOnly: true });
  const owner = team(OWNER, true);
  const admin = team(ADMIN, false);
  assert.equal(L.revokeState(owner.admins[1], owner).ok, true);
  assert.equal(L.revokeState(owner.admins[0], owner).reason, 'self');
  assert.equal(L.revokeState({ userId: OLD, isOwner: true }, owner).reason, 'owner');
  assert.equal(L.revokeState(admin.admins[0], admin).reason, 'notOwner');
  assert.equal(L.revokeState(admin.admins[2], admin).reason, 'notOwner');
});

test('roleOf: solo con acceso vigente', () => {
  const t = team(OWNER, true);
  assert.equal(L.roleOf(OWNER, t), 'owner');
  assert.equal(L.roleOf(ADMIN, t), 'admin');
  assert.equal(L.roleOf(STAFF, t), 'support');
  assert.equal(L.roleOf(OLD, t), null, 'en la lista pero sin acceso');
  assert.equal(L.roleOf(USER, t), null);
  assert.equal(L.roleOf(USER, null), null);
});

test('accessState de la ficha: avisos previos y botones según quién mira', () => {
  const owner = team(OWNER, true);
  const admin = team(ADMIN, false);
  const ok = { account: { emailConfirmed: true }, moderation: {} };
  let s = L.accessState(USER, owner, OWNER, ok);
  assert.equal(s.canGrant, true);
  assert.equal(s.canRevoke, false);
  assert.equal(s.canToggleStaff, true);
  s = L.accessState(USER, owner, OWNER, { account: { emailConfirmed: false } });
  assert.equal(s.canGrant, false);
  assert.equal(s.grantBlocker, 'unconfirmed');
  assert.equal(s.canToggleStaff, false);
  s = L.accessState(USER, owner, OWNER, { account: { emailConfirmed: true }, moderation: { banned: true } });
  assert.equal(s.grantBlocker, 'banned');
  s = L.accessState(ADMIN, owner, OWNER, ok);
  assert.equal(s.isAdmin, true);
  assert.equal(s.canRevoke, true);
  assert.equal(s.grantBlocker, 'already');
  assert.equal(L.accessState(OWNER, owner, OWNER, ok).revokeReason, 'self');
  // Un admin común no ve Dar ni Quitar, pero sí soporte.
  s = L.accessState(USER, admin, ADMIN, ok);
  assert.equal(s.canGrant, false);
  assert.equal(s.canRevoke, false);
  assert.equal(s.canToggleStaff, true);
  s = L.accessState(OWNER, admin, ADMIN, ok);
  assert.equal(s.canRevoke, false);
  assert.equal(s.revokeReason, 'notOwner');
  // Soporte inactivo por cambio de email: se puede sacar aunque la cuenta tenga un problema.
  s = L.accessState(STAFF, owner, OWNER, { account: { emailConfirmed: false } });
  assert.equal(s.isStaff, true);
  assert.equal(s.canToggleStaff, true);
});

test('rango de la ficha: admin ya no se elige; owner y admin activo quedan bloqueados', () => {
  assert.deepEqual(plain(L.RANK_OPTIONS), ['', 'helper', 'mod']);
  assert.equal(L.rankState('owner', true).mode, 'owner');
  assert.equal(L.rankState('admin', true).mode, 'admin');
  assert.deepEqual(plain(L.rankState('mod', false)), { mode: 'edit', options: ['', 'helper', 'mod'], legacy: false });
  assert.deepEqual(plain(L.rankState('admin', false)), { mode: 'edit', options: ['admin', '', 'helper', 'mod'], legacy: true });
  assert.equal(L.rankState('', true).options.includes('admin'), false);
});

test('Resumen: uso por motor y claves desde admin_ai_providers; sin el dato no se inventa', () => {
  const data = { since: '2026-11-01', keys: { anthropic: false, openai: true }, providers: [{ provider: 'openai', monthUsd: 1.5, monthCalls: 10, wallets: 2, walletsLeftUsd: 3 }, { provider: 'anthropic', monthUsd: '2.25', monthCalls: 4, wallets: 1, walletsLeftUsd: 1 }, { provider: 'otro', monthUsd: 9 }] };
  assert.deepEqual(plain(L.aiByEngine(data)), [
    { engine: 'anthropic', usd: 2.25, calls: 4, wallets: 1, walletsLeftUsd: 1 },
    { engine: 'openai', usd: 1.5, calls: 10, wallets: 2, walletsLeftUsd: 3 },
  ]);
  assert.equal(L.aiByEngine(null), null);
  assert.equal(L.aiByEngine({ byModel: [{ model: 'haiku', usd: 1 }] }), null);
  assert.equal(L.aiByEngine({ providers: [] }), null);
  assert.deepEqual(plain(L.engineKeyStates(data)), { anthropic: 'missing', openai: 'ok' });
  assert.equal(L.engineKeyStates({}), null);
});

test('Resumen: estado de cada clave, avisos de lo que falta y accesos directos', () => {
  assert.equal(L.keyState({ ok: true, data: { configured: true } }), 'ok');
  assert.equal(L.keyState({ ok: true, data: { configured: false } }), 'missing');
  assert.equal(L.keyState({ ok: false, error: { code: 'PGRST202' } }), 'notReady');
  assert.equal(L.keyState({ ok: false, error: new Error('red') }), 'unknown');
  assert.equal(L.paymentsState({ ok: true, data: { config: { mercadoPago: { ready: false }, paypal: { ready: true } } } }), 'ok');
  assert.equal(L.paymentsState({ ok: true, data: { config: {} } }), 'missing');
  assert.equal(L.paymentsState({ ok: false }), 'unknown');
  assert.deepEqual(plain(L.keyAlerts({ openai: 'ok', anthropic: 'missing', payments: 'unknown', klipy: 'missing' })), ['anthropic'], 'KLIPY es opcional; desconocido no alarma');
  assert.deepEqual(plain(L.pendingShortcuts({ tickets: 3, reports: 0, gallery: null, payments: 1 })), [
    { id: 'tickets', tab: 'support', count: 3 },
    { id: 'payments', tab: 'payments', count: 1 },
  ]);
});

test('Registro: textos para las acciones nuevas y grupos que acepta el servidor', () => {
  for (const a of ['admin.grant', 'admin.revoke', 'anthropic.key', 'openai.key', 'support.staffGranted', 'rank.set']) assert.ok(L.auditLabelKey(a), a);
  assert.equal(L.auditLabelKey('algo.nuevo'), null);
  const SERVER_ACTION = /^[a-z][A-Za-z]{1,30}(\.([A-Za-z]{1,30})?)?$/; // admin_list_actions
  for (const a of [...L.AUDIT_ACTIONS, ...L.AUDIT_GROUPS]) assert.match(a, SERVER_ACTION, a);
  for (const g of L.AUDIT_GROUPS) assert.ok(g.endsWith('.'), g);
  assert.equal(L.auditTone('admin.revoke'), 'bad');
  assert.equal(L.auditTone('users.ban'), 'bad');
  assert.equal(L.auditTone('admin.grant'), 'accent');
  assert.equal(L.auditTone('anthropic.key'), 'accent');
  assert.equal(L.auditTone('users.setPlan'), 'info');
});

test('pestañas: 12 sin Comunidades, Equipo en Ajustes, flechas en ronda', () => {
  assert.equal(L.TAB_ORDER.length, 12);
  assert.equal(new Set(L.TAB_ORDER).size, 12);
  assert.equal(L.TAB_ORDER.includes('communities'), false);
  assert.ok(L.TAB_GROUPS.find((g) => g.id === 'settings').tabs.includes('team'));
  assert.equal(L.TAB_ORDER[0], 'overview');
  assert.equal(L.nextTab('audit', 'ArrowRight'), 'overview');
  assert.equal(L.nextTab('overview', 'ArrowLeft'), 'audit');
  assert.equal(L.nextTab('users', 'Home'), 'overview');
  assert.equal(L.nextTab('users', 'End'), 'audit');
  assert.equal(L.nextTab('users', 'a'), null);
});

test('textos: cada clave que usan las pestañas tocadas existe en español e inglés con las mismas variables', () => {
  const vars = (v) => [...String(v).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  const has = (dict, key) => typeof dict[key] === 'string' || typeof dict[`${key}_other`] === 'string';
  const files = ['team.js', 'overview.js', 'users.js', 'audit.js', 'user-drawer.js', '../admin.js'];
  const keys = new Set();
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    for (const m of src.matchAll(/\bT\('([A-Za-z0-9_]+)'/g)) keys.add(m[1]);
  }
  // Las que se arman con un código.
  for (const code of [...L.TEAM_ERRORS, 'not_ready', 'error']) keys.add(`team_err_${code}`);
  for (const r of ['owner', 'admin', 'support']) keys.add(`team_role_${r}`), keys.add(`team_role_${r}Text`), keys.add(`access_${r}`);
  for (const k of L.KEY_CHECKS) keys.add(`key_${k.id}`);
  for (const s of ['ok', 'missing', 'notReady', 'unknown']) keys.add(`keyState_${s}`);
  for (const p of ['tickets', 'reports', 'gallery', 'payments']) keys.add(`pending_${p}`), keys.add(`pendingName_${p}`);
  for (const e of ['anthropic', 'openai']) keys.add(`engine_${e}`);
  for (const a of L.AUDIT_ACTIONS) keys.add(L.auditLabelKey(a));
  for (const g of L.AUDIT_GROUPS) keys.add(`group_${g.slice(0, -1)}`);
  for (const t of L.TAB_ORDER) keys.add(`tab_${t}`);
  for (const k of keys) {
    assert.ok(has(ES, k), `falta admin.${k} en español`);
    assert.ok(has(EN, k), `falta admin.${k} en inglés`);
    const one = ES[k] ?? ES[`${k}_other`];
    const two = EN[k] ?? EN[`${k}_other`];
    assert.equal(vars(two), vars(one), `variables de ${k}`);
  }
  // Voseo y sin "admin" como rango para elegir.
  assert.match(ES.team_grantWarn, /Dáselo|asegurate/);
  assert.doesNotMatch(ES.rankHelp, /No da acceso a este panel/);
});
