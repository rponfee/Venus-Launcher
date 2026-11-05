import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../../../features/communities/permissions.js';

const open = { view: true, write: true, embeds: true, react: true, connect: true, speak: true };
const allowed = (res) => Object.fromEntries(Object.entries(res).map(([k, v]) => [k, v.allowed]));

test('cada tipo de canal solo tiene los permisos que le tocan', () => {
  assert.deepEqual(P.permsFor('text'), ['view', 'write', 'embeds', 'react']);
  assert.deepEqual(P.permsFor('announcement'), ['view', 'write', 'embeds', 'react']);
  assert.deepEqual(P.permsFor('forum'), ['view', 'write', 'embeds', 'react']);
  assert.deepEqual(P.permsFor('voice'), ['view', 'connect', 'speak']);
  assert.equal(P.permApplies('voice', 'write'), false);
  assert.equal(P.permApplies('text', 'connect'), false);
});

test('dueño y moderador saltean todo, menos lo que no aplica al tipo de canal', () => {
  const everyone = { ...open, view: false, write: false, embeds: false, react: false };
  for (const base of ['owner', 'moderator']) {
    const text = allowed(P.explainPerms({ kind: 'text', base, everyone }));
    assert.deepEqual(text, { view: true, write: true, embeds: true, react: true, connect: false, speak: false });
    assert.equal(P.explainPerms({ kind: 'text', base, everyone }).view.source, 'staff');
    assert.deepEqual(allowed(P.explainPerms({ kind: 'voice', base, everyone })), { view: true, write: false, embeds: false, react: false, connect: true, speak: true });
  }
});

test('un miembro sin roles propios recibe lo que concede el canal', () => {
  assert.deepEqual(allowed(P.explainPerms({ kind: 'text', everyone: open })), { view: true, write: true, embeds: true, react: true, connect: false, speak: false });
  const readOnly = P.explainPerms({ kind: 'text', everyone: { ...open, write: false } });
  assert.equal(readOnly.write.allowed, false);
  assert.equal(readOnly.write.source, 'everyone_deny');
  assert.equal(readOnly.embeds.allowed, false, 'sin escribir no hay enlaces');
  assert.equal(readOnly.embeds.source, 'needs_write');
  assert.equal(readOnly.react.allowed, true, 'reaccionar solo pide ver');
  const hidden = P.explainPerms({ kind: 'text', everyone: { ...open, view: false } });
  assert.deepEqual(allowed(hidden), { view: false, write: false, embeds: false, react: false, connect: false, speak: false });
  assert.equal(hidden.write.source, 'needs_view');
  const listener = P.explainPerms({ kind: 'voice', everyone: { ...open, connect: false } });
  assert.equal(listener.connect.allowed, false);
  assert.equal(listener.speak.allowed, false);
  assert.equal(listener.speak.source, 'needs_connect');
});

test('un rol propio permite o niega encima de lo de todos', () => {
  const everyone = { ...open, view: false, embeds: false };
  const team = P.explainPerms({ kind: 'text', everyone, overrides: { view: 'allow', embeds: 'allow' } });
  assert.deepEqual(allowed(team), { view: true, write: true, embeds: true, react: true, connect: false, speak: false });
  assert.equal(team.view.source, 'role_allow');
  const muted = P.explainPerms({ kind: 'text', everyone: open, overrides: { write: 'deny' } });
  assert.equal(muted.write.allowed, false);
  assert.equal(muted.write.source, 'role_deny');
  assert.equal(muted.embeds.allowed, false);
  const voice = P.explainPerms({ kind: 'voice', everyone: { ...open, connect: false }, overrides: { connect: 'allow', speak: 'deny' } });
  assert.deepEqual(allowed(voice), { view: true, write: false, embeds: false, react: false, connect: true, speak: false });
  assert.equal(voice.speak.source, 'role_deny');
});

test('con varios roles, si alguno permite se permite', () => {
  assert.deepEqual(P.mergeOverrides([{ write: 'deny', react: 'allow' }, { write: 'allow' }, null]), { write: 'allow', react: 'allow' });
  assert.deepEqual(P.mergeOverrides([{ write: 'allow' }, { write: 'deny' }]), { write: 'allow' });
  assert.deepEqual(P.mergeOverrides([{ view: 'deny' }, {}]), { view: 'deny' });
  assert.deepEqual(P.mergeOverrides([]), {});
});

test('diferencias entre lo guardado y lo editado', () => {
  assert.deepEqual(P.diffPerms({ view: true, write: true }, { view: false, write: true }, { isEveryone: true }), { view: false });
  assert.deepEqual(P.diffPerms({}, { write: 'deny', react: 'inherit' }), { write: 'deny' });
  assert.deepEqual(P.diffPerms({ write: 'deny' }, { write: undefined, react: 'allow' }), { write: 'inherit', react: 'allow' });
  assert.deepEqual(P.diffPerms({ write: 'deny' }, { write: 'deny' }), {});
});

test('"todos" a partir del canal', () => {
  assert.deepEqual(P.everyoneOf({ isPrivate: true, postingRole: 'staff' }), { view: false, write: false, embeds: true, react: true, connect: true, speak: true });
  assert.deepEqual(P.everyoneOf({ everyone: { view: true, write: true, embeds: false, react: true, connect: false, speak: true } }), { view: true, write: true, embeds: false, react: true, connect: false, speak: true });
});

test('permisos de un canal ya calculados por el servidor', () => {
  assert.equal(P.channelCan({ canPost: false }, 'write'), false);
  assert.equal(P.channelCan({ canEmbed: false }, 'embeds'), false);
  assert.equal(P.channelCan({ can: { speak: false } }, 'speak'), false);
  assert.equal(P.channelCan({}, 'write'), true);
});

test('nombres y colores de rol', () => {
  const roles = [{ id: 'a', name: 'Constructores' }];
  assert.deepEqual(P.validateRoleName('  Redactores ', roles), { ok: true, value: 'Redactores' });
  assert.equal(P.validateRoleName('', roles).error, 'bad_role_name');
  assert.equal(P.validateRoleName('x'.repeat(31), roles).error, 'bad_role_name');
  assert.equal(P.validateRoleName('<b>', roles).error, 'bad_role_name');
  assert.equal(P.validateRoleName('constructores', roles).error, 'role_name_taken');
  assert.equal(P.validateRoleName('Constructores', roles, 'a').ok, true, 'renombrarse a sí mismo no choca');
  assert.equal(P.roleColor('#ABCDEF'), '#abcdef');
  assert.equal(P.roleColor('rojo'), P.DEFAULT_ROLE_COLOR);
  assert.deepEqual(P.rolesOf({ roles }, ['a', 'z']).map((r) => r.id), ['a']);
});
