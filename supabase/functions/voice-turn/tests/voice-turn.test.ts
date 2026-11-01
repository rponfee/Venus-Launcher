// Pruebas de "voice-turn" (node --test): sesión, lista vacía sin secreto y la clave que espera coturn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createTurnHandler, parseTtl, parseUrls, turnCredential } from '../handler.ts';

const USER = '11111111-2222-3333-4444-555555555555';
const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const URLS = ['turn:203.0.113.5:3478?transport=udp', 'turn:203.0.113.5:3478?transport=tcp'];

function handler(over = {}) {
  return createTurnHandler({
    secret: 'secreto-de-prueba',
    urls: URLS,
    ttlSeconds: 3600,
    nowMs: () => NOW,
    async verifyUser(token) {
      if (token === 'token-de-usuario-valido') return { status: 'ok', userId: USER };
      if (token === 'token-de-sesion-anonima') return { status: 'forbidden' };
      if (token === 'token-con-supabase-caido') throw new Error('red');
      return { status: 'invalid' };
    },
    ...over,
  });
}

const post = (token) => new Request('https://x.supabase.co/functions/v1/voice-turn', {
  method: 'POST',
  headers: token ? { authorization: `Bearer ${token}` } : {},
});

test('entrega una clave temporal con el formato de coturn (use-auth-secret)', async () => {
  const res = await handler()(post('token-de-usuario-valido'));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  const expires = NOW / 1000 + 3600;
  assert.equal(body.expiresAt, new Date(expires * 1000).toISOString());
  assert.equal(body.iceServers.length, 1);
  const [ice] = body.iceServers;
  assert.deepEqual(ice.urls, URLS);
  assert.equal(ice.username, `${expires}:${USER}`);
  // Lo mismo que calcula coturn: base64(HMAC-SHA1(static-auth-secret, usuario))
  assert.equal(ice.credential, createHmac('sha1', 'secreto-de-prueba').update(ice.username).digest('base64'));
});

test('sin sesión, con sesión anónima o con Supabase caído no entrega claves', async () => {
  assert.equal((await handler()(post(null))).status, 401);
  assert.equal((await handler()(post('token-que-no-existe-en-supabase'))).status, 401);
  assert.equal((await handler()(post('token-de-sesion-anonima'))).status, 403);
  const down = await handler()(post('token-con-supabase-caido'));
  assert.equal(down.status, 503);
  assert.equal((await down.json()).error.code, 'auth_unavailable');
});

test('sin secreto o sin servidores responde una lista vacía (el Voice Chat sigue con STUN)', async () => {
  for (const over of [{ secret: '' }, { urls: [] }]) {
    const res = await handler(over)(post('token-de-usuario-valido'));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { iceServers: [], expiresAt: null });
  }
});

test('solo acepta direcciones turn/turns/stun y una duración razonable', async () => {
  assert.deepEqual(parseUrls(' turn:a.b:3478?transport=udp, http://x, turns:a.b:5349 ,'), ['turn:a.b:3478?transport=udp', 'turns:a.b:5349']);
  assert.equal(parseTtl('7200'), 7200);
  assert.equal(parseTtl('10'), 86400);
  assert.equal(parseTtl(''), 86400);
  assert.equal(await turnCredential('k', 'u'), createHmac('sha1', 'k').update('u').digest('base64'));
});
