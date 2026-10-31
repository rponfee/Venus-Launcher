// Pruebas del flujo HTTP de "admin": quién puede entrar (en CADA pedido), errores y plumbing (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, ADMIN2, USER, setup } from './fakes.ts';

test('OPTIONS responde CORS y un método raro 405', async () => {
  const { handler, URL_FN } = setup();
  const res = await handler(new Request(URL_FN, { method: 'OPTIONS' }));
  assert.equal(res.status, 204);
  assert.match(res.headers.get('access-control-allow-headers') ?? '', /authorization/);
  const put = await handler(new Request(URL_FN, { method: 'PUT', headers: { Authorization: 'Bearer admin' } }));
  assert.equal(put.status, 405);
});

test('sesión: sin token o inválida 401, Auth caído 503', async () => {
  const { handler, URL_FN, call } = setup();
  const none = await handler(new Request(URL_FN, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } }));
  assert.equal(none.status, 401);
  assert.equal((await none.json()).error, 'unauthorized');
  assert.equal((await call('me', {}, 'vencido')).status, 401);
  const down = await call('me', {}, 'down');
  assert.equal(down.status, 503);
  assert.equal(down.body.error, 'auth_unavailable');
});

test('un usuario que no es admin recibe 403 not_admin y no toca nada', async () => {
  const { call, db, auth } = setup();
  const res = await call('users.ban', { ids: [ADMIN2], duration: '24h', reason: 'probando' }, 'user');
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'forbidden');
  assert.equal(res.body.reason, 'not_admin');
  assert.deepEqual(auth.bans, []);
  assert.equal(db.actions.length, 0);
  // Ni siquiera llegó a buscar a los usuarios.
  assert.equal(db.callsTo('admin_targets').length, 0);
  assert.equal((await call('overview', {}, 'user')).status, 403);
  assert.equal(db.callsTo('admin_overview').length, 0);
});

test('email sin confirmar: 403 unconfirmed aunque el email esté en la lista de admins', async () => {
  const { call, db } = setup();
  const res = await call('overview', {}, 'unconfirmed');
  assert.equal(res.status, 403);
  assert.equal(res.body.reason, 'unconfirmed');
  assert.match(String(res.body.message), /Confirmá el email/);
  assert.equal(db.callsTo('admin_overview').length, 0);
});

test('cuenta anónima: 403 anonymous', async () => {
  const { call } = setup();
  const res = await call('me', {}, 'anon');
  assert.equal(res.status, 403);
  assert.equal(res.body.reason, 'anonymous');
});

test('cada pedido vuelve a verificar al admin en la base (sacarlo de la lista corta el acceso al instante)', async () => {
  const { call, db } = setup();
  const first = await call('me');
  assert.equal(first.status, 200);
  assert.equal((first.body.result as Record<string, unknown>).isAdmin, true);
  assert.equal((first.body.result as Record<string, unknown>).userId, ADMIN);
  await call('overview');
  assert.equal(db.callsTo('admin_is_admin_user').length, 2);
  assert.deepEqual(db.callsTo('admin_is_admin_user')[1], { p_user: ADMIN });
  db.adminEmails.delete('admin@example.com');
  const after = await call('overview');
  assert.equal(after.status, 403);
  assert.equal(after.body.reason, 'not_admin');
});

test('un admin baneado (en Auth) deja de ser admin', async () => {
  const { call, db } = setup();
  db.users.get(ADMIN)!.bannedUntil = Date.UTC(2027, 0, 1);
  assert.equal((await call('me')).status, 403);
});

test('GET es "me" y devuelve el estado de Stripe', async () => {
  const { handler, URL_FN } = setup();
  const res = await handler(new Request(URL_FN, { headers: { Authorization: 'Bearer admin' } }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.action, 'me');
  assert.deepEqual(body.result.stripe, { configured: true, mode: 'test' });
  assert.equal(body.result.email, 'admin@example.com');
});

test('cuerpo inválido, acción desconocida y payload que no es objeto: 400', async () => {
  const { handler, URL_FN, call } = setup();
  const bad = await handler(new Request(URL_FN, { method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' }, body: '{nope' }));
  assert.equal(bad.status, 400);
  const noJson = await handler(new Request(URL_FN, { method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'text/plain' }, body: '{}' }));
  assert.equal(noJson.status, 400);
  const unknown = await call('users.hack', {});
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.field, 'action');
  const proto = await call('__proto__', {});
  assert.equal(proto.status, 400);
  const notObj = await handler(new Request(URL_FN, { method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'overview', payload: [1] }) }));
  assert.equal(notObj.status, 400);
});

test('sin la migración 0012: 503 backend_not_ready', async () => {
  const { call, db } = setup();
  db.failures.set('admin_is_admin_user', 'PGRST202');
  const res = await call('me');
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'backend_not_ready');
});

test('sin los secretos de Supabase: 503 not_configured', async () => {
  const { call } = setup({ supabaseReady: false });
  const res = await call('me');
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'not_configured');
});

test('users.list pasa los filtros validados a admin_list_users', async () => {
  const { call, db } = setup();
  const res = await call('users.list', { search: '  venus-abc  ', plan: 'none', status: 'active', banned: false, sort: 'spend', page: 2, perPage: 50 });
  assert.equal(res.status, 200);
  assert.deepEqual(db.callsTo('admin_list_users')[0], {
    p_search: 'venus-abc',
    p_plan: 'none',
    p_status: 'active',
    p_banned: false,
    p_muted: null,
    p_sort: 'spend',
    p_page: 2,
    p_per_page: 50,
  });
  assert.equal((await call('users.list', { perPage: 500 })).status, 400);
  assert.equal((await call('users.list', { status: 'raro' })).status, 400);
  assert.equal((await call('users.list', { plan: 'Pro!' })).status, 400);
});

test('users.get: ficha o 404 not_found (con cuerpo, para distinguirlo de "la función no existe")', async () => {
  const { call } = setup();
  const ok = await call('users.get', { id: USER });
  assert.equal(ok.status, 200);
  assert.equal(((ok.body.result as Record<string, unknown>).account as Record<string, unknown>).email, 'jugador@example.com');
  const missing = await call('users.get', { id: '99999999-9999-4999-8999-999999999999' });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'not_found');
  assert.equal((await call('users.get', { id: 'no-es-uuid' })).status, 400);
});

test('audit.list valida los filtros', async () => {
  const { call, db } = setup();
  const res = await call('audit.list', { action: 'users.', targetUser: USER, since: '2026-10-01T00:00:00Z', perPage: 20 });
  assert.equal(res.status, 200);
  assert.deepEqual(db.callsTo('admin_list_actions')[0], {
    p_action: 'users.',
    p_admin: null,
    p_target: USER,
    p_since: '2026-10-01T00:00:00.000Z',
    p_until: null,
    p_page: 1,
    p_per_page: 20,
  });
  assert.equal((await call('audit.list', { action: "users'; drop table x" })).status, 400);
});

test('una falla de la base no filtra detalles: 503 db_unavailable', async () => {
  const { call, db, log } = setup();
  db.failures.set('admin_overview', '57014');
  const res = await call('overview');
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'db_unavailable');
  assert.ok(log.lines.some((l) => l.includes('57014')));
});
