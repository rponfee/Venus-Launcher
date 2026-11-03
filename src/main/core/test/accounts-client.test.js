'use strict';
// Cliente de Microsoft: sin configurar nada todo sigue igual; con app-config.msClientId las cuentas nuevas usan la app
// propia de Azure y cada cuenta se renueva siempre con el cliente que le dio su token.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const paths = require('../paths');
const accounts = require('../accounts');

const LEGACY_ID = '00000000402b5328';
const AZURE_ID = '11111111-2222-3333-4444-555555555555';
const jwt = `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400, xuid: '123' })).toString('base64url')}.y`;
const PROFILE = { id: 'aabbccddeeff00112233445566778899', name: 'Prueba' };

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// Simula Microsoft, Xbox Live y Minecraft; anota lo que se le pidió a los endpoints de tokens de Microsoft.
function fakeServices() {
  const tokenCalls = [];
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('oauth20_token.srf') || u.includes('oauth2/v2.0/token')) {
      tokenCalls.push({ url: u, body: Object.fromEntries(new URLSearchParams(String(init.body))) });
      return json({ access_token: 'ms-access', refresh_token: 'ms-refresh' });
    }
    if (u.includes('user.auth.xboxlive.com')) return json({ Token: 'xbl', DisplayClaims: { xui: [{ uhs: 'uhs' }] } });
    if (u.includes('xsts.auth.xboxlive.com')) return json({ Token: 'xsts', DisplayClaims: { xui: [{ uhs: 'uhs' }] } });
    if (u.includes('login_with_xbox')) return json({ access_token: jwt, expires_in: 86400 });
    if (u.includes('/entitlements/')) return json({ items: [{ name: 'game_minecraft' }] });
    if (u.includes('/minecraft/profile')) return json(PROFILE);
    throw new Error(`pedido inesperado: ${u}`);
  };
  return tokenCalls;
}

function setup(t, clientId) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venus-accounts-'));
  paths.setRoot(dir);
  const realFetch = global.fetch;
  if (clientId) process.env.VENUS_MS_CLIENT_ID = clientId;
  else delete process.env.VENUS_MS_CLIENT_ID;
  t.after(() => {
    global.fetch = realFetch;
    delete process.env.VENUS_MS_CLIENT_ID;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function login(redirectOf) {
  let opened = null;
  accounts.configure({
    encrypt: (s) => s,
    decrypt: (s) => s,
    openLoginWindow: async (url, redirect) => {
      opened = { url: new URL(url), redirect };
      return `${redirectOf || redirect}?code=codigo`;
    },
  });
  return accounts.loginMicrosoft().then((list) => ({ opened, list }));
}

const saved = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'data', 'accounts.json'), 'utf8')).accounts[0];

test('sin app propia usa el cliente de siempre', async (t) => {
  const dir = setup(t, null);
  const tokenCalls = fakeServices();
  const { opened, list } = await login();
  assert.equal(list.accounts[0].name, 'Prueba');
  assert.equal(opened.url.origin, 'https://login.live.com');
  assert.equal(opened.url.searchParams.get('client_id'), LEGACY_ID);
  assert.equal(opened.url.searchParams.get('scope'), 'service::user.auth.xboxlive.com::MBI_SSL');
  assert.equal(opened.url.searchParams.get('code_challenge'), null);
  assert.equal(opened.redirect, 'https://login.live.com/oauth20_desktop.srf');
  assert.equal(tokenCalls[0].url, 'https://login.live.com/oauth20_token.srf');
  assert.equal(tokenCalls[0].body.client_id, LEGACY_ID);
  assert.equal(saved(dir).msClient, LEGACY_ID);
});

test('con app propia las cuentas nuevas usan Azure, con PKCE', async (t) => {
  const dir = setup(t, AZURE_ID);
  const tokenCalls = fakeServices();
  const { opened } = await login();
  assert.equal(opened.url.origin, 'https://login.microsoftonline.com');
  assert.equal(opened.url.pathname, '/consumers/oauth2/v2.0/authorize');
  assert.equal(opened.url.searchParams.get('client_id'), AZURE_ID);
  assert.equal(opened.url.searchParams.get('scope'), 'XboxLive.signin offline_access');
  assert.equal(opened.url.searchParams.get('code_challenge_method'), 'S256');
  const challenge = opened.url.searchParams.get('code_challenge');
  assert.ok(challenge);
  assert.equal(opened.redirect, 'https://login.microsoftonline.com/common/oauth2/nativeclient');
  assert.equal(tokenCalls[0].url, 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token');
  assert.equal(tokenCalls[0].body.client_id, AZURE_ID);
  const expected = require('crypto').createHash('sha256').update(tokenCalls[0].body.code_verifier).digest('base64url');
  assert.equal(expected, challenge);
  assert.equal(saved(dir).msClient, AZURE_ID);

  await accounts.refreshAccount(saved(dir).id);
  assert.equal(tokenCalls[1].url, 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token');
  assert.equal(tokenCalls[1].body.client_id, AZURE_ID);
  assert.equal(tokenCalls[1].body.grant_type, 'refresh_token');
});

test('una cuenta vieja se sigue renovando con su cliente aunque ya haya app propia', async (t) => {
  const dir = setup(t, AZURE_ID);
  const tokenCalls = fakeServices();
  accounts.configure({ encrypt: (s) => s, decrypt: (s) => s });
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const id = `msa-${PROFILE.id}`;
  fs.writeFileSync(path.join(dir, 'data', 'accounts.json'), JSON.stringify({
    selected: id,
    accounts: [{ id, type: 'msa', name: PROFILE.name, uuid: PROFILE.id, refresh: 'refresh-viejo', token: 'viejo', expiresAt: 0 }],
  }));
  await accounts.refreshAccount(id);
  assert.equal(tokenCalls[0].url, 'https://login.live.com/oauth20_token.srf');
  assert.equal(tokenCalls[0].body.client_id, LEGACY_ID);
  assert.equal(tokenCalls[0].body.refresh_token, 'refresh-viejo');
  assert.equal(saved(dir).msClient, LEGACY_ID);
});
