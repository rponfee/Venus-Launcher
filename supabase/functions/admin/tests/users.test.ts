// Pruebas de las acciones sobre usuarios de "admin": baneos, silencios, sesiones, uso, planes, borrar cuentas y
// cancelar suscripciones, con la base, Auth, Storage y Stripe falsos (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, ADMIN2, DAY, HOUR, LIVE_PAYER, MISSING, NOW, PAYER, USER, setup } from './fakes.ts';

type Obj = Record<string, unknown>;
const result = (body: Obj) => body.result as Obj;
const items = (body: Obj) => (result(body).results as Obj[]);

test('banear: no a uno mismo ni a otros admins; los demás se banean en Auth, en la base y se cierran sus sesiones', async () => {
  const { call, auth, db } = setup();
  const res = await call('users.ban', { ids: [ADMIN, ADMIN2, USER, MISSING], duration: '7d', reason: '  Spam en el chat  ' });
  assert.equal(res.status, 200);
  assert.deepEqual(
    items(res.body).map((r) => [r.id, r.ok, r.error ?? null]),
    [
      [ADMIN, false, 'self'],
      [ADMIN2, false, 'target_admin'],
      [USER, true, null],
      [MISSING, false, 'not_found'],
    ],
  );
  assert.deepEqual(result(res.body).summary, { ok: 1, failed: 3 });
  // Supabase Auth: ban_duration en horas (7 días = 168h); solo al usuario común.
  assert.deepEqual(auth.bans, [{ id: USER, duration: '168h' }]);
  const until = new Date(NOW + 7 * DAY).toISOString();
  assert.deepEqual(db.callsTo('admin_moderate')[0], { p_user: USER, p_patch: { banned_until: until, ban_reason: 'Spam en el chat' }, p_admin: ADMIN });
  assert.deepEqual(db.callsTo('admin_revoke_sessions'), [{ p_user: USER }]);
  assert.equal(items(res.body)[2].sessionsRevoked, 2);
  // Una fila de registro por usuario afectado, con el admin y el motivo.
  assert.equal(db.actions.length, 1);
  assert.equal(db.actions[0].action, 'users.ban');
  assert.equal(db.actions[0].target_user, USER);
  assert.equal(db.actions[0].admin_id, ADMIN);
  assert.equal(db.actions[0].admin_email, 'admin@example.com');
  assert.deepEqual(db.actions[0].details, { duration: '7d', reason: 'Spam en el chat', until, sessionsRevoked: 2 });
});

test('banear: duraciones de Auth exactas (permanente = 876000h) y motivo obligatorio', async () => {
  const { call, auth } = setup();
  for (const [duration, expected] of [['1h', '1h'], ['24h', '24h'], ['30d', '720h'], ['permanent', '876000h']]) {
    const res = await call('users.ban', { ids: [USER], duration, reason: 'x' });
    assert.equal(res.status, 200, duration);
    assert.equal(auth.bans.at(-1)?.duration, expected);
  }
  assert.equal((await call('users.ban', { ids: [USER], duration: '2d', reason: 'x' })).status, 400);
  const noReason = await call('users.ban', { ids: [USER], duration: '1h', reason: '   ' });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.body.field, 'reason');
  assert.equal((await call('users.ban', { ids: [], duration: '1h', reason: 'x' })).status, 400);
  assert.equal((await call('users.ban', { ids: Array.from({ length: 101 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`), duration: '1h', reason: 'x' })).status, 400);
});

test('banear: si Auth falla, ese usuario queda con error "auth" y no se marca en la base', async () => {
  const { call, auth, db } = setup();
  auth.fail.add(USER);
  const res = await call('users.ban', { ids: [USER, PAYER], duration: '24h', reason: 'x' });
  assert.equal(res.status, 200);
  assert.equal(items(res.body)[0].ok, false);
  assert.equal(items(res.body)[0].error, 'auth');
  assert.equal(items(res.body)[1].ok, true);
  assert.deepEqual(db.callsTo('admin_moderate').map((a) => a.p_user), [PAYER]);
});

test('desbanear: ban_duration "none" y se limpia la base', async () => {
  const { call, auth, db } = setup();
  const res = await call('users.unban', { ids: [USER] });
  assert.equal(res.status, 200);
  assert.deepEqual(auth.bans, [{ id: USER, duration: 'none' }]);
  assert.deepEqual(db.callsTo('admin_moderate')[0].p_patch, { banned_until: null, ban_reason: null });
  assert.equal(db.actions[0].action, 'users.unban');
});

test('silenciar y quitar el silencio: solo social (sin tocar Auth ni las sesiones)', async () => {
  const { call, auth, db } = setup();
  const res = await call('users.mute', { ids: [USER, ADMIN2], duration: '24h', reason: 'Insultos' });
  assert.equal(items(res.body)[0].ok, true);
  assert.equal(items(res.body)[1].error, 'target_admin');
  assert.deepEqual(db.callsTo('admin_moderate')[0].p_patch, { muted_until: new Date(NOW + 24 * HOUR).toISOString(), mute_reason: 'Insultos' });
  assert.deepEqual(auth.bans, []);
  assert.equal(db.callsTo('admin_revoke_sessions').length, 0);
  await call('users.unmute', { ids: [USER] });
  assert.deepEqual(db.callsTo('admin_moderate')[1].p_patch, { muted_until: null, mute_reason: null });
  assert.deepEqual(db.actions.map((a) => a.action), ['users.mute', 'users.unmute']);
});

test('cerrar sesiones: no a uno mismo', async () => {
  const { call, db } = setup();
  const res = await call('users.signOut', { ids: [USER, ADMIN] });
  assert.equal(items(res.body)[0].sessionsRevoked, 2);
  assert.equal(items(res.body)[1].error, 'self');
  assert.deepEqual(db.callsTo('admin_revoke_sessions'), [{ p_user: USER }]);
});

test('reiniciar uso: hoy o la semana', async () => {
  const { call, db } = setup();
  assert.equal((await call('users.resetUsage', { ids: [USER], scope: 'week' })).status, 200);
  assert.deepEqual(db.usageResets, [{ user: USER, scope: 'week' }]);
  assert.equal((await call('users.resetUsage', { ids: [USER], scope: 'month' })).status, 400);
  assert.deepEqual(db.actions[0].details, { scope: 'week', rows: 3 });
});

test('cambiar plan: source admin con vencimiento; avisa si tiene una suscripción de Stripe activa', async () => {
  const { call, db } = setup();
  const until = '2026-12-31T23:59:59.000Z';
  const res = await call('users.setPlan', { ids: [USER, PAYER], planId: 'go', until, note: 'Tester' });
  assert.equal(res.status, 200);
  assert.deepEqual(db.callsTo('admin_set_plan'), [
    { p_user: USER, p_plan: 'go', p_until: until },
    { p_user: PAYER, p_plan: 'go', p_until: until },
  ]);
  assert.equal(db.subs.get(USER)?.source, 'admin');
  assert.deepEqual(result(res.body).warnings, [{ id: PAYER, email: 'paga@example.com', code: 'stripe_active', subscriptionId: 'sub_PAY' }]);
  assert.equal(items(res.body)[1].previousPlan, 'pro');
  assert.equal(db.actions.length, 2);
  assert.deepEqual(db.actions[0].details, { planId: 'go', until, note: 'Tester', previousPlan: null, previousSource: null, stripeActive: false });
});

test('cambiar plan: la suscripción activa también se detecta en Stripe aunque la base ya no la tenga', async () => {
  const { call, db, stripe } = setup();
  db.subs.set(PAYER, { plan_id: 'go', status: 'active', source: 'admin', current_period_end: null, stripe_subscription_id: null, stripe_status: null });
  const res = await call('users.setPlan', { ids: [PAYER], planId: 'pro' });
  assert.deepEqual(result(res.body).warnings, [{ id: PAYER, email: 'paga@example.com', code: 'stripe_active', subscriptionId: 'sub_PAY' }]);
  assert.equal(stripe.callsTo('GET', '/v1/subscriptions')[0].params.customer, 'cus_PAY');
});

test('cambiar plan: plan inexistente o desactivado, fecha pasada', async () => {
  const { call } = setup();
  assert.equal((await call('users.setPlan', { ids: [USER], planId: 'nope' })).status, 400);
  const inactive = await call('users.setPlan', { ids: [USER], planId: 'old' });
  assert.equal(inactive.status, 400);
  assert.match(String(inactive.body.message), /desactivado/);
  const past = await call('users.setPlan', { ids: [USER], planId: 'go', until: '2026-10-01T00:00:00Z' });
  assert.equal(past.status, 400);
  assert.equal(past.body.field, 'until');
});

test('quitar plan: marca el cambio y avisa por Stripe', async () => {
  const { call, db } = setup();
  const res = await call('users.removePlan', { ids: [PAYER, USER] });
  assert.equal(items(res.body)[0].changed, true);
  assert.equal(items(res.body)[1].changed, false);
  assert.equal(db.subs.get(PAYER)?.status, 'canceled');
  assert.equal((result(res.body).warnings as Obj[])[0].code, 'stripe_active');
});

test('borrar: exige confirmación, no a uno mismo ni a admins; cancela Stripe ANTES de borrar y borra sus archivos', async () => {
  const { call, auth, db, stripe, storage } = setup();
  const noConfirm = await call('users.delete', { ids: [PAYER] });
  assert.equal(noConfirm.status, 400);
  assert.equal(noConfirm.body.field, 'confirm');
  assert.deepEqual(auth.deleted, []);

  const res = await call('users.delete', { ids: [ADMIN, ADMIN2, PAYER, USER], confirm: true });
  assert.equal(res.status, 200);
  assert.deepEqual(items(res.body).map((r) => r.error ?? 'ok'), ['self', 'target_admin', 'ok', 'ok']);
  // Stripe: solo la suscripción abierta (la cancelada se ignora), sin factura final ni prorrateo.
  const del = stripe.callsTo('DELETE', /^\/v1\/subscriptions\//);
  assert.equal(del.length, 1);
  assert.equal(del[0].path, '/v1/subscriptions/sub_PAY');
  assert.equal(del[0].params.invoice_now, 'false');
  assert.equal(del[0].params.prorate, 'false');
  assert.equal(del[0].headers.get('idempotency-key'), `venus-admin-cancel-sub_PAY-${Math.floor(NOW / 60000)}`);
  assert.deepEqual(items(res.body)[2].canceledSubscriptions, ['sub_PAY']);
  // Orden: primero la cancelación (ya pasó) y los archivos, al final la cuenta.
  assert.deepEqual(auth.order.filter((o) => o.includes(USER)), [`delete:${USER}`]);
  assert.deepEqual(auth.deleted.sort(), [PAYER, USER].sort());
  assert.ok(auth.order.indexOf(`files:world-saves`) < auth.order.indexOf(`delete:${USER}`));
  assert.deepEqual(storage.removed, [
    { bucket: 'world-saves', paths: [`${USER}/w/part1`, `${USER}/w/part2`] },
    { bucket: 'screenshots', paths: [`${USER}/a.png`] },
  ]);
  assert.equal(items(res.body)[3].filesRemoved, 3);
  // El registro guarda el email enmascarado (la cuenta ya no existe).
  const logged = db.actions.find((a) => a.target_user === PAYER)!;
  assert.equal(logged.action, 'users.delete');
  assert.equal((logged.details as Obj).email, 'p**a@example.com');
  assert.deepEqual((logged.details as Obj).canceledSubscriptions, ['sub_PAY']);
});

test('borrar: sin Stripe configurado no borra a quien tiene cliente de Stripe (seguiría pagando)', async () => {
  const { call, auth } = setup({ noStripe: true });
  const res = await call('users.delete', { ids: [PAYER, USER], confirm: true });
  assert.equal(items(res.body)[0].error, 'stripe_not_configured');
  assert.equal(items(res.body)[1].ok, true);
  assert.deepEqual(auth.deleted, [USER]);
});

test('borrar: un cliente de Stripe de otro modo (producción con clave de prueba) no se borra', async () => {
  const { call, auth } = setup();
  const res = await call('users.delete', { ids: [LIVE_PAYER], confirm: true });
  assert.equal(items(res.body)[0].error, 'stripe_mode');
  assert.deepEqual(auth.deleted, []);
});

test('borrar: si cancelar en Stripe falla, la cuenta NO se borra', async () => {
  const { call, auth, stripe } = setup();
  stripe.failures.set('DELETE /v1/subscriptions/sub_PAY', () => new Response(JSON.stringify({ error: { type: 'api_error' } }), { status: 500 }));
  const res = await call('users.delete', { ids: [PAYER], confirm: true });
  assert.equal(items(res.body)[0].error, 'stripe');
  assert.deepEqual(auth.deleted, []);
});

test('borrar: si Auth falla después de cancelar Stripe y borrar archivos, el registro guarda lo que se hizo', async () => {
  const { call, auth, db } = setup();
  auth.fail.add(PAYER);
  db.files.set(PAYER, { 'world-saves': [`${PAYER}/w/part1`], screenshots: [`${PAYER}/a.png`], clips: [] });
  const res = await call('users.delete', { ids: [PAYER, USER], confirm: true });
  assert.equal(items(res.body)[0].ok, false);
  assert.equal(items(res.body)[0].error, 'auth');
  assert.deepEqual(auth.deleted, [USER]);
  const failed = db.actions.find((a) => a.target_user === PAYER)!;
  assert.equal(failed.action, 'users.delete');
  assert.deepEqual(failed.details, { cancelStripe: true, purgeFiles: true, canceledSubscriptions: ['sub_PAY'], filesRemoved: 2, failed: true, error: 'auth' });
  // Una falla sin nada hecho (Stripe sin configurar) no deja fila.
  const off = setup({ noStripe: true });
  await off.call('users.delete', { ids: [PAYER], confirm: true });
  assert.equal(off.db.actions.length, 0);
});

test('borrar: con más de 1000 archivos por bucket repite hasta borrarlos todos', async () => {
  const { call, auth, db, storage } = setup();
  const parts = Array.from({ length: 2350 }, (_, i) => `${USER}/w/${String(i).padStart(5, '0')}`);
  db.files.set(USER, { 'world-saves': parts, screenshots: [`${USER}/a.png`], clips: [] });
  const res = await call('users.delete', { ids: [USER], confirm: true });
  assert.equal(items(res.body)[0].ok, true);
  assert.equal(items(res.body)[0].filesRemoved, 2351);
  assert.equal(db.callsTo('admin_user_files').length, 3);
  assert.deepEqual(db.files.get(USER), { 'world-saves': [], screenshots: [], clips: [] });
  assert.ok(storage.removed.every((r) => r.paths.length <= 100));
  assert.deepEqual(auth.deleted, [USER]);
  assert.deepEqual(result(res.body).warnings, []);
});

test('borrar: si Storage no borra nada, no da vueltas de más y avisa files_not_removed', async () => {
  const { call, auth, db, storage } = setup();
  storage.stuck = true;
  db.files.set(USER, { 'world-saves': Array.from({ length: 1000 }, (_, i) => `${USER}/w/${i}`), screenshots: [], clips: [] });
  const res = await call('users.delete', { ids: [USER], confirm: true });
  assert.equal(items(res.body)[0].ok, true);
  assert.equal(db.callsTo('admin_user_files').length, 1);
  assert.deepEqual((result(res.body).warnings as Obj[]).map((w) => w.code), ['files_not_removed']);
  assert.deepEqual(auth.deleted, [USER]);
});

test('borrar con cancelStripe: false borra igual pero avisa que la suscripción sigue', async () => {
  const { call, auth, stripe } = setup();
  const res = await call('users.delete', { ids: [PAYER], confirm: true, cancelStripe: false, purgeFiles: false });
  assert.equal(items(res.body)[0].ok, true);
  assert.deepEqual(auth.deleted, [PAYER]);
  assert.equal(stripe.calls.length, 0);
  assert.equal((result(res.body).warnings as Obj[])[0].code, 'stripe_not_canceled');
});

test('cancelar la suscripción de Stripe de un usuario: ahora o al fin del período', async () => {
  const { call, stripe, db } = setup();
  const end = await call('stripe.cancelSubscription', { userId: PAYER, when: 'period_end' });
  assert.equal(end.status, 200);
  const post = stripe.callsTo('POST', '/v1/subscriptions/sub_PAY')[0];
  assert.equal(post.params.cancel_at_period_end, 'true');
  assert.deepEqual(result(end.body).canceled, [{ id: 'sub_PAY', status: 'active', cancelAtPeriodEnd: true }]);
  const now = await call('stripe.cancelSubscription', { userId: PAYER });
  assert.equal(result(now.body).when, 'now');
  assert.equal(stripe.callsTo('DELETE', '/v1/subscriptions/sub_PAY').length, 1);
  assert.deepEqual(db.actions.map((a) => a.action), ['stripe.cancelSubscription', 'stripe.cancelSubscription']);
  // Sin suscripciones abiertas no hay nada que cancelar (ni registro).
  const none = await call('stripe.cancelSubscription', { userId: USER });
  assert.deepEqual(result(none.body).canceled, []);
  assert.equal(db.actions.length, 2);
  // Otro modo de Stripe: 409 con el motivo.
  const live = await call('stripe.cancelSubscription', { userId: LIVE_PAYER });
  assert.equal(live.status, 409);
  assert.equal(live.body.reason, 'stripe_mode');
  // Sin Stripe: 503 stripe_not_configured.
  const off = setup({ noStripe: true });
  const res = await off.call('stripe.cancelSubscription', { userId: PAYER });
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'stripe_not_configured');
});

test('cancelar en Stripe: si una cancelación falla, las anteriores quedan en el registro', async () => {
  const { call, stripe, db } = setup();
  stripe.subscriptions.set('sub_PAY2', { id: 'sub_PAY2', object: 'subscription', customer: 'cus_PAY', status: 'active', cancel_at_period_end: false });
  stripe.failures.set('DELETE /v1/subscriptions/sub_PAY2', () => new Response(JSON.stringify({ error: { type: 'api_error' } }), { status: 500 }));
  const res = await call('stripe.cancelSubscription', { userId: PAYER });
  assert.equal(res.status, 502);
  assert.equal(stripe.subscriptions.get('sub_PAY')?.status, 'canceled');
  assert.equal(db.actions.length, 1);
  assert.equal(db.actions[0].action, 'stripe.cancelSubscription');
  assert.deepEqual(db.actions[0].details, { when: 'now', subscriptions: ['sub_PAY'], failed: true, error: 'stripe' });
});

test('cancelar al fin del período: la clave de idempotencia cambia cada minuto', async () => {
  let clock = NOW;
  const { call, stripe } = setup({ nowMs: () => clock });
  await call('stripe.cancelSubscription', { userId: PAYER, when: 'period_end' });
  // Doble clic en el mismo minuto: la misma clave (Stripe devuelve la respuesta guardada).
  await call('stripe.cancelSubscription', { userId: PAYER, when: 'period_end' });
  // El usuario la reactiva en el portal y el admin la vuelve a cancelar más tarde: esta vez llega a Stripe.
  stripe.subscriptions.get('sub_PAY')!.cancel_at_period_end = false;
  clock += 5 * 60 * 1000;
  const again = await call('stripe.cancelSubscription', { userId: PAYER, when: 'period_end' });
  assert.equal(again.status, 200);
  assert.equal(stripe.subscriptions.get('sub_PAY')!.cancel_at_period_end, true);
  const keys = stripe.callsTo('POST', '/v1/subscriptions/sub_PAY').map((c) => c.headers.get('idempotency-key'));
  assert.deepEqual(keys, [
    `venus-admin-cancel-end-sub_PAY-${Math.floor(NOW / 60000)}`,
    `venus-admin-cancel-end-sub_PAY-${Math.floor(NOW / 60000)}`,
    `venus-admin-cancel-end-sub_PAY-${Math.floor(clock / 60000)}`,
  ]);
});

test('banear: si la base falla después de banear en Auth, el registro lo dice (y una falla sin cambios no se anota)', async () => {
  const { call, auth, db } = setup();
  db.failures.set('admin_moderate', '57014');
  auth.fail.add(PAYER);
  const res = await call('users.ban', { ids: [USER, PAYER], duration: '24h', reason: 'x' });
  assert.deepEqual(items(res.body).map((r) => r.error), ['db', 'auth']);
  assert.deepEqual(auth.bans, [{ id: USER, duration: '24h' }]);
  assert.equal(db.actions.length, 1);
  assert.equal(db.actions[0].target_user, USER);
  assert.deepEqual(db.actions[0].details, { duration: '24h', reason: 'x', authBan: '24h', failed: true, error: 'db' });
});

test('notas internas: se guardan en la moderación y el registro no copia el texto', async () => {
  const { call, db } = setup();
  const res = await call('users.setNotes', { id: USER, notes: 'Reincidente.\nAvisado por Discord.' });
  assert.equal(res.status, 200);
  assert.deepEqual(db.callsTo('admin_moderate')[0].p_patch, { notes: 'Reincidente.\nAvisado por Discord.' });
  assert.deepEqual(db.actions[0].details, { length: 33 });
  assert.equal((await call('users.setNotes', { id: MISSING, notes: 'x' })).status, 404);
});

test('si el registro falla, la acción se hace igual y avisa audit_failed', async () => {
  const { call, db, auth } = setup();
  db.failures.set('admin_log', '57014');
  const res = await call('users.ban', { ids: [USER], duration: '1h', reason: 'x' });
  assert.equal(items(res.body)[0].ok, true);
  assert.deepEqual(auth.bans, [{ id: USER, duration: '1h' }]);
  assert.deepEqual((result(res.body).warnings as Obj[]).at(-1), { code: 'audit_failed', count: 1 });
});
