// Pruebas de "badge" (node --test): sesión, desafío de un solo uso, verificación con Mojang y topes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBadgeHandler, mojangHasJoined, normalizeUuid } from '../handler.ts';

const USER = '11111111-2222-3333-4444-555555555555';
const MC = '0f8a5c2e-1b3d-4e6f-9a7b-8c9d0e1f2a3b';
const MC_HEX = MC.replace(/-/g, '');
const SERVER_ID = 'a'.repeat(40);

function setup(over = {}) {
  const calls = { take: [], joined: [], enroll: [] };
  const challenges = new Set([`${USER}:${SERVER_ID}`]);
  const handler = createBadgeHandler({
    async verifyUser(token) {
      if (token === 'token-de-usuario-valido') return { status: 'ok', userId: USER };
      if (token === 'token-de-sesion-anonima') return { status: 'forbidden' };
      if (token === 'token-con-supabase-caido') throw new Error('red');
      return { status: 'invalid' };
    },
    async takeChallenge(userId, serverId) {
      calls.take.push([userId, serverId]);
      return challenges.delete(`${userId}:${serverId}`);
    },
    async hasJoined(name, serverId) {
      calls.joined.push([name, serverId]);
      return name === 'Steve' && serverId === SERVER_ID ? { id: MC_HEX, name: 'Steve' } : null;
    },
    async enroll(userId, uuid) {
      calls.enroll.push([userId, uuid]);
      return 'ok';
    },
    ...over,
  });
  return { handler, calls };
}

const post = (body, token = 'token-de-usuario-valido') => new Request('https://x.supabase.co/functions/v1/badge', {
  method: 'POST',
  headers: token ? { authorization: `Bearer ${token}`, 'content-type': 'application/json' } : {},
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

const ok = { uuid: MC, name: 'Steve', serverId: SERVER_ID };

test('anota la cuenta cuando Mojang confirma que entró con el desafío', async () => {
  const { handler, calls } = setup();
  const res = await handler(post(ok));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), { uuid: MC, name: 'Steve' });
  assert.deepEqual(calls.enroll, [[USER, MC]]);
});

test('acepta el UUID sin guiones y lo guarda normalizado', async () => {
  const { handler, calls } = setup();
  const res = await handler(post({ ...ok, uuid: MC_HEX.toUpperCase() }));
  assert.equal(res.status, 200);
  assert.deepEqual(calls.enroll, [[USER, MC]]);
});

test('el desafío es de un solo uso', async () => {
  const { handler } = setup();
  assert.equal((await handler(post(ok))).status, 200);
  const again = await handler(post(ok));
  assert.equal(again.status, 409);
  assert.deepEqual(await again.json(), { error: { code: 'challenge_invalid' } });
});

test('no anota un UUID ajeno: Mojang devuelve otra cuenta', async () => {
  const other = 'ffffffff-1b3d-4e6f-9a7b-8c9d0e1f2a3b';
  const { handler, calls } = setup();
  const res = await handler(post({ ...ok, uuid: other }));
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: { code: 'not_verified' } });
  assert.equal(calls.enroll.length, 0);
});

test('no anota si la cuenta no entró con ese desafío (nombre ajeno)', async () => {
  const { handler, calls } = setup();
  const res = await handler(post({ ...ok, name: 'Alex' }));
  assert.equal(res.status, 403);
  assert.equal(calls.enroll.length, 0);
});

test('sin desafío válido ni siquiera le pregunta a Mojang', async () => {
  const { handler, calls } = setup();
  const res = await handler(post({ ...ok, serverId: 'b'.repeat(40) }));
  assert.equal(res.status, 409);
  assert.equal(calls.joined.length, 0);
});

test('pide sesión de Venus y rechaza las anónimas', async () => {
  const { handler } = setup();
  assert.equal((await handler(post(ok, null))).status, 401);
  assert.equal((await handler(post(ok, 'token-cualquiera-que-no-sirve'))).status, 401);
  assert.equal((await handler(post(ok, 'token-de-sesion-anonima'))).status, 403);
  assert.equal((await handler(post(ok, 'token-con-supabase-caido'))).status, 503);
});

test('rechaza datos inválidos', async () => {
  const { handler, calls } = setup();
  for (const body of ['no es json', { ...ok, uuid: 'nada' }, { ...ok, name: 'con espacio' }, { ...ok, serverId: 'xyz' },
    { ...ok, uuid: '0f8a5c2e-1b3d-3e6f-9a7b-8c9d0e1f2a3b' }, JSON.stringify({ ...ok, pad: 'x'.repeat(2000) })]) {
    assert.equal((await handler(post(body))).status, 400);
  }
  assert.equal(calls.take.length, 0);
  assert.equal((await handler(new Request('https://x/badge', { method: 'GET' }))).status, 405);
});

test('Mojang caído: 503 sin anotar', async () => {
  const { handler, calls } = setup({ hasJoined: async () => { throw new Error('timeout'); } });
  const res = await handler(post(ok));
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: { code: 'mojang_unavailable' } });
  assert.equal(calls.enroll.length, 0);
});

test('topes y baneos de la base', async () => {
  for (const [result, status, code] of [['too_many_accounts', 409, 'too_many_accounts'], ['user_banned', 403, 'user_banned'], ['raro', 500, 'server_error']]) {
    const { handler } = setup({ enroll: async () => result });
    const res = await handler(post(ok));
    assert.equal(res.status, status);
    assert.deepEqual(await res.json(), { error: { code } });
  }
});

test('mojangHasJoined arma el pedido y entiende 200 y 204', async () => {
  const urls = [];
  const fake = async (url) => {
    urls.push(url);
    return url.includes('Steve') ? new Response(JSON.stringify({ id: MC_HEX, name: 'Steve' }), { status: 200 }) : new Response(null, { status: 204 });
  };
  assert.deepEqual(await mojangHasJoined(fake, 'Steve', SERVER_ID), { id: MC_HEX, name: 'Steve' });
  assert.equal(await mojangHasJoined(fake, 'Alex', SERVER_ID), null);
  assert.equal(urls[0], `https://sessionserver.mojang.com/session/minecraft/hasJoined?username=Steve&serverId=${SERVER_ID}`);
  await assert.rejects(mojangHasJoined(async () => new Response('', { status: 429 }), 'Steve', SERVER_ID));
});

test('normalizeUuid', () => {
  assert.equal(normalizeUuid(MC_HEX), MC);
  assert.equal(normalizeUuid(MC.toUpperCase()), MC);
  assert.equal(normalizeUuid('nada'), null);
  assert.equal(normalizeUuid(42), null);
});

test('mcverify: enroll puede devolver { result, rewarded } y se agrega a la respuesta', async () => {
  const { handler } = setup({ enroll: async () => ({ result: 'ok', rewarded: true }) });
  const res = await handler(post(ok));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { uuid: MC, name: 'Steve', rewarded: true });
  const banned = setup({ enroll: async () => ({ result: 'user_banned' }) });
  assert.equal((await banned.handler(post(ok))).status, 403);
});
