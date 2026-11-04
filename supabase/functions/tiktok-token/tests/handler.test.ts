// Pruebas de "tiktok-token" (node --test): sesion, validacion y que el secreto solo vaya a TikTok.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTokenHandler } from '../handler.ts';

const TOKEN = 'a'.repeat(40);

function setup(over: Record<string, unknown> = {}) {
  const calls: { url: string; body: URLSearchParams }[] = [];
  const handler = createTokenHandler({
    clientKey: 'key',
    clientSecret: 'shh-secret',
    verifyUser: async () => 'ok',
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, body: new URLSearchParams(String(init.body)) });
      return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', open_id: 'o', scope: 'video.upload', expires_in: 7200, refresh_expires_in: 100 }), { status: 200 });
    }) as typeof fetch,
    ...over,
  });
  return { handler, calls };
}

const post = (body: unknown, token: string | null = TOKEN) =>
  new Request('https://x.test/', { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body) });

test('sin sesion, con sesion anonima o sin secretos no hace nada', async () => {
  const { handler, calls } = setup();
  assert.equal((await handler(post({ action: 'refresh', refreshToken: 'r' }, null))).status, 401);
  assert.equal((await setup({ verifyUser: async () => 'forbidden' }).handler(post({ action: 'refresh', refreshToken: 'r' }))).status, 401);
  assert.equal((await setup({ clientSecret: '' }).handler(post({ action: 'refresh', refreshToken: 'r' }))).status, 503);
  assert.equal(calls.length, 0);
});

test('intercambia el code con el secreto del servidor y no lo devuelve', async () => {
  const { handler, calls } = setup();
  const res = await handler(post({ action: 'exchange', code: 'c0de', codeVerifier: 'v'.repeat(64), redirectUri: 'http://127.0.0.1:53124/callback/' }));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.access_token, 'at');
  assert.ok(!JSON.stringify(data).includes('shh-secret'));
  assert.equal(calls[0].url, 'https://open.tiktokapis.com/v2/oauth/token/');
  assert.equal(calls[0].body.get('client_secret'), 'shh-secret');
  assert.equal(calls[0].body.get('grant_type'), 'authorization_code');
  assert.equal(calls[0].body.get('code_verifier'), 'v'.repeat(64));
});

test('solo acepta un retorno en loopback', async () => {
  const { handler, calls } = setup();
  const res = await handler(post({ action: 'exchange', code: 'c0de', codeVerifier: 'v'.repeat(64), redirectUri: 'https://evil.test/callback/' }));
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test('renovar y revocar', async () => {
  const { handler, calls } = setup();
  assert.equal((await handler(post({ action: 'refresh', refreshToken: 'rt1' }))).status, 200);
  assert.equal(calls[0].body.get('grant_type'), 'refresh_token');
  assert.equal((await handler(post({ action: 'revoke', token: 'at1' }))).status, 200);
  assert.equal(calls[1].url, 'https://open.tiktokapis.com/v2/oauth/revoke/');
  assert.equal(calls[1].body.get('token'), 'at1');
});

test('un grant vencido se distingue de una falla de TikTok', async () => {
  const bad = setup({ fetch: (async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 200 })) as typeof fetch });
  const res = await bad.handler(post({ action: 'refresh', refreshToken: 'rt1' }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'invalid_grant');
  const down = setup({ fetch: (async () => { throw new Error('net'); }) as typeof fetch });
  assert.equal((await down.handler(post({ action: 'refresh', refreshToken: 'rt1' }))).status, 502);
});
