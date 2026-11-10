'use strict';
// Modo de datos de ejemplo del panel (admin/fake.js + admin/fake-team.js): el Equipo y las RPC directas del Resumen
// responden como el servidor (mismas formas y códigos de error de 0057) sin hablar con ninguna red, y el registro
// queda con las acciones nuevas. Sirve para ver el panel como dueño y como admin común (VENUS_ADMIN_FAKE_ROLE=admin).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeAdmin, FAKE_ADMIN_ID } = require('../fake');
const { createAdminClient } = require('../client');

const rpc = (fake, name, args) => fake.call('rpc', { name, args });
const codeOf = async (p) => {
  try {
    await p;
    return null;
  } catch (err) {
    return err.message;
  }
};

test('como dueño: ve el equipo, da y quita admin, con los mismos controles que el servidor', async () => {
  const fake = createFakeAdmin();
  const team = await rpc(fake, 'admin_team');
  assert.equal(team.me.userId, FAKE_ADMIN_ID);
  assert.equal(team.me.isOwner, true);
  assert.ok(team.admins.some((a) => a.userId === FAKE_ADMIN_ID && a.isOwner && a.active));
  assert.ok(team.staff.length >= 1);

  const list = await fake.call('users.list', { search: 'lunacraft' });
  const target = list.users[0];
  assert.equal(target.isAdmin, false);
  const granted = await rpc(fake, 'admin_grant_admin', { p_user: target.id });
  assert.equal(granted.changed, true);
  assert.equal(granted.rank, 'admin');
  assert.equal((await rpc(fake, 'admin_grant_admin', { p_user: target.id })).changed, false, 'idempotente');
  assert.equal((await fake.call('users.list', { search: 'lunacraft' })).users[0].isAdmin, true);
  assert.equal((await fake.call('users.get', { id: target.id })).profile.rank, 'admin');

  assert.equal(await codeOf(rpc(fake, 'admin_revoke_admin', { p_user: FAKE_ADMIN_ID })), 'cannot_self');
  assert.equal(await codeOf(rpc(fake, 'admin_set_rank', { p_user: target.id, p_rank: 'admin' })), 'bad_rank');
  assert.equal(await codeOf(rpc(fake, 'admin_set_rank', { p_user: target.id, p_rank: 'mod' })), 'admin_locked');
  const revoked = await rpc(fake, 'admin_revoke_admin', { p_user: target.id });
  assert.equal(revoked.changed, true);
  assert.equal(revoked.rank, null);

  const unconfirmed = (await fake.call('users.list', { search: 'juli.pixel' })).users[0];
  assert.equal(await codeOf(rpc(fake, 'admin_grant_admin', { p_user: unconfirmed.id })), 'unconfirmed');
  const banned = (await fake.call('users.list', { search: 'creeperking' })).users[0];
  assert.equal(await codeOf(rpc(fake, 'admin_grant_admin', { p_user: banned.id })), 'banned');
  assert.equal(await codeOf(rpc(fake, 'admin_grant_admin', { p_user: '00000000-0000-4000-8000-0000000000ff' })), 'unknown_user');

  const audit = await fake.call('audit.list', { action: 'admin.', adminId: FAKE_ADMIN_ID });
  assert.deepEqual(audit.actions.map((a) => a.action).sort(), ['admin.grant', 'admin.revoke']);
  assert.equal((await fake.call('audit.list', { adminId: '00000000-0000-4000-8000-0000000000ff' })).total, 0);
});

test('como admin común: lee el equipo y maneja soporte, pero no da ni quita admin', async () => {
  const fake = createFakeAdmin({ owner: false });
  const team = await rpc(fake, 'admin_team');
  assert.equal(team.me.isOwner, false);
  const owner = team.admins.find((a) => a.isOwner);
  assert.notEqual(owner.userId, FAKE_ADMIN_ID);
  const someone = (await fake.call('users.list', { search: 'bauti' })).users[0];
  assert.equal(await codeOf(rpc(fake, 'admin_grant_admin', { p_user: someone.id })), 'owner_only');
  assert.equal(await codeOf(rpc(fake, 'admin_revoke_admin', { p_user: owner.userId })), 'owner_only');
  const added = await rpc(fake, 'admin_set_support_staff', { p_user: someone.id, p_active: true });
  assert.equal(added.changed, true);
  assert.ok((await rpc(fake, 'admin_team')).staff.some((s) => s.userId === someone.id && s.active));
  assert.equal((await rpc(fake, 'admin_set_support_staff', { p_user: someone.id, p_active: false })).changed, true);
  assert.equal(await codeOf(rpc(fake, 'admin_set_support_staff', { p_user: someone.id, p_active: 'sí' })), 'bad_request');
});

test('Resumen: motores, claves y pendientes de ejemplo; una RPC desconocida responde como si faltara', async () => {
  const fake = createFakeAdmin();
  const providers = await rpc(fake, 'admin_ai_providers');
  assert.deepEqual(providers.providers.map((p) => p.provider), ['anthropic', 'openai']);
  assert.equal(typeof providers.keys.anthropic, 'boolean');
  assert.equal((await rpc(fake, 'admin_openai_status')).configured, true);
  assert.ok((await rpc(fake, 'support_queue', { p_filter: { status: 'waiting', limit: 1 } })).counts.waiting > 0);
  assert.match(await codeOf(rpc(fake, 'admin_algo_que_no_existe')), /Could not find the function/);
});

test('el cliente del launcher pasa la acción rpc al modo de ejemplo sin tocar la red', async () => {
  const client = createAdminClient({
    fetch: () => assert.fail('no debe usar la red'),
    cloudConfig: async () => assert.fail('no debe leer la nube'),
    accessToken: async () => assert.fail('no debe pedir el token'),
    session: async () => null,
    t: (k) => k,
    fake: createFakeAdmin(),
  });
  const team = await client.call('rpc', { name: 'admin_team', args: {} });
  assert.equal(team.me.isOwner, true);
});
