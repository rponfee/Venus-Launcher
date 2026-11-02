'use strict';
// Verificación de la cuenta de Minecraft para las invitaciones (rewards/verify.js) con un badgeClient falso.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createVerifier, mapCode, ERROR_CODES } = require('../verify');

const t = (key, vars) => `${key}${vars?.name ? `|${vars.name}` : ''}`;
const MSA = { type: 'msa', name: 'Steve', uuid: '853c80ef-3c37-49fd-aa49-938b674adae6', accessToken: 'secreto-de-minecraft', xuid: '1' };

function coded(code) {
  return Object.assign(new Error(`${code}: detalle técnico`), { code });
}

function setup({ account = MSA, accountError = null, enroll } = {}) {
  const calls = [];
  const warns = [];
  const client = {
    async enroll(acc, opts) {
      calls.push({ acc, opts });
      return enroll ? enroll(acc, opts) : { uuid: acc.uuid, rewarded: false };
    },
  };
  const verifier = createVerifier({
    badgeClient: () => client,
    getAccount: async () => {
      if (accountError) throw accountError;
      return account;
    },
    t,
    warn: (...args) => warns.push(args.join(' ')),
  });
  return { verifier, calls, warns };
}

test('verifica con la cuenta de Microsoft elegida y la Edge Function mcverify', async () => {
  const { verifier, calls } = setup({ enroll: (acc) => ({ uuid: acc.uuid, rewarded: true }) });
  const res = await verifier.verify();
  assert.deepEqual(res, { uuid: MSA.uuid, name: 'Steve', rewarded: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].opts, { fn: 'mcverify' });
  assert.equal(calls[0].acc, MSA);
});

test('nunca devuelve el token de Minecraft', async () => {
  const { verifier } = setup();
  const res = await verifier.verify();
  assert.equal(JSON.stringify(res).includes('secreto'), false);
  assert.equal(res.rewarded, false);
});

test('dos pedidos seguidos comparten la misma verificación', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { verifier, calls } = setup({ enroll: async (acc) => (await gate, { uuid: acc.uuid, rewarded: false }) });
  const a = verifier.verify();
  const b = verifier.verify();
  assert.equal(verifier.busy(), true);
  release();
  assert.equal(await a, await b);
  assert.equal(calls.length, 1);
  assert.equal(verifier.busy(), false);
  await verifier.verify();
  assert.equal(calls.length, 2);
});

test('cuenta sin conexión y sin cuentas', async () => {
  const offline = setup({ account: { type: 'offline', name: 'Alex', uuid: 'x', accessToken: '0' } });
  await assert.rejects(offline.verifier.verify(), (err) => err.code === 'offlineAccount' && err.message === 'rewards.err_offlineAccount|Alex');
  assert.equal(offline.calls.length, 0);
  const none = setup({ accountError: coded('noAccount') });
  await assert.rejects(none.verifier.verify(), { code: 'noAccount' });
  const empty = setup({ account: null });
  await assert.rejects(empty.verifier.verify(), { code: 'noAccount' });
});

test('errores de la cuenta de Microsoft: volver a entrar o red', async () => {
  await assert.rejects(setup({ accountError: coded('sessionExpired') }).verifier.verify(), { code: 'accountSession' });
  await assert.rejects(setup({ accountError: coded('xstsFailed') }).verifier.verify(), { code: 'accountSession' });
  await assert.rejects(setup({ accountError: coded('refreshFailed') }).verifier.verify(), { code: 'network' });
});

test('los errores del cliente de la insignia llegan traducidos con su código', async () => {
  for (const code of ['noCloud', 'noSession', 'network', 'unavailable', 'multiplayerDisabled', 'mojangSession', 'mojang', 'notVerified', 'tooManyAccounts', 'banned', 'rateLimited', 'offlineAccount']) {
    const { verifier } = setup({ enroll: () => { throw coded(code); } });
    await assert.rejects(verifier.verify(), (err) => err.code === code && err.message.startsWith(`rewards.err_${code}`), code);
  }
});

test('un código desconocido o una respuesta rara cuentan como server y van a la consola', async () => {
  const odd = setup({ enroll: () => { throw coded('algoNuevo'); } });
  await assert.rejects(odd.verifier.verify(), { code: 'server' });
  assert.equal(odd.warns.length, 1);
  const noUuid = setup({ enroll: () => ({ rewarded: true }) });
  await assert.rejects(noUuid.verifier.verify(), { code: 'server' });
  const quiet = setup({ enroll: () => { throw coded('notVerified'); } });
  await assert.rejects(quiet.verifier.verify(), { code: 'notVerified' });
  assert.equal(quiet.warns.length, 0, 'los errores esperables no ensucian la consola');
});

test('mapCode', () => {
  assert.equal(mapCode('refreshFailed'), 'network');
  assert.equal(mapCode('sessionExpired'), 'accountSession');
  assert.equal(mapCode('mojang'), 'mojang');
  assert.equal(mapCode(undefined), 'server');
  assert.ok(ERROR_CODES.every((c) => mapCode(c) === c));
});

test('cada código tiene su texto en es y en', () => {
  const es = require('../../../i18n/es/rewards');
  const en = require('../../../i18n/en/rewards');
  for (const code of ERROR_CODES) {
    assert.equal(typeof es[`err_${code}`], 'string', `es err_${code}`);
    assert.equal(typeof en[`err_${code}`], 'string', `en err_${code}`);
  }
});
