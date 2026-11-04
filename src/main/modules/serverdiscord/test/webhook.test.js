'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const hook = require('../webhook');

const OK_ID = '123456789012345678';
const OK_TOKEN = 'aBcD_eFgH-iJkLmNoPqRsTuVwXyZ0123456789';

test('webhook: solo https en discord.com o discordapp.com, sin nada de más', () => {
  const good = `https://discord.com/api/webhooks/${OK_ID}/${OK_TOKEN}`;
  assert.deepEqual(hook.parseWebhook(good), { url: good, id: OK_ID });
  assert.deepEqual(hook.parseWebhook(`  ${good}/ `), { url: good, id: OK_ID });
  assert.deepEqual(hook.parseWebhook(`https://discordapp.com/api/webhooks/${OK_ID}/${OK_TOKEN}`), { url: good, id: OK_ID }, 'el dominio viejo se normaliza');
  assert.deepEqual(hook.parseWebhook(`https://DISCORD.com/api/webhooks/${OK_ID}/${OK_TOKEN}`), { url: good, id: OK_ID });
  const bad = [
    '',
    null,
    undefined,
    123,
    'discord.com/api/webhooks/1/2',
    `http://discord.com/api/webhooks/${OK_ID}/${OK_TOKEN}`,
    `https://evil.example/api/webhooks/${OK_ID}/${OK_TOKEN}`,
    `https://discord.com.evil.example/api/webhooks/${OK_ID}/${OK_TOKEN}`,
    `https://evil.example/https://discord.com/api/webhooks/${OK_ID}/${OK_TOKEN}`,
    `https://discord.com@evil.example/api/webhooks/${OK_ID}/${OK_TOKEN}`,
    `https://usuario:clave@discord.com/api/webhooks/${OK_ID}/${OK_TOKEN}`,
    `https://discord.com:8443/api/webhooks/${OK_ID}/${OK_TOKEN}`,
    `https://canary.discord.com/api/webhooks/${OK_ID}/${OK_TOKEN}`,
    `https://discord.com/api/webhooks/${OK_ID}`,
    `https://discord.com/api/webhooks/${OK_ID}/${OK_TOKEN}/slack`,
    `https://discord.com/api/webhooks/${OK_ID}/${OK_TOKEN}?wait=true`,
    `https://discord.com/api/webhooks/${OK_ID}/${OK_TOKEN}#x`,
    `https://discord.com/api/webhooks/abc/${OK_TOKEN}`,
    `https://discord.com/api/webhooks/${OK_ID}/corto`,
    `https://discord.com/api/webhooks/${OK_ID}/../../users/@me`,
    `https://discord.com/users/${OK_ID}/${OK_TOKEN}`,
    `file:///api/webhooks/${OK_ID}/${OK_TOKEN}`,
    `https://discord.com/api/webhooks/${OK_ID}/${'x'.repeat(400)}`,
  ];
  for (const url of bad) assert.equal(hook.parseWebhook(url), null, String(url));
});

test('la máscara no deja ver el secreto', () => {
  const masked = hook.maskWebhook(OK_ID);
  assert.ok(masked.includes(OK_ID));
  assert.ok(!masked.includes(OK_TOKEN));
});

test('eventos: valores por defecto y solo los conocidos', () => {
  assert.deepEqual(hook.normalizeEvents(undefined), { started: true, stopped: true, crashed: true, join: false, leave: false, backup: false });
  assert.deepEqual(hook.normalizeEvents({ join: true, started: false, otro: true, leave: 'si' }), { started: false, stopped: true, crashed: true, join: true, leave: false, backup: false });
});

const fakeT = (key, vars = {}) => `${key.split('.')[1]}|${vars.server}|${vars.player}`;

test('mensaje: menciones apagadas siempre, nombres neutralizados', () => {
  const m = hook.buildMessage('join', { server: 'Mi *server*', player: '@everyone_' }, fakeT);
  assert.deepEqual(m.allowed_mentions, { parse: [] });
  assert.equal(m.embeds.length, 1);
  assert.equal(m.content, undefined);
  const title = m.embeds[0].title;
  assert.ok(title.startsWith('discord_join|Mi \\*server\\*|'));
  assert.ok(!title.includes('@everyone'), 'la mención no queda escrita tal cual');
  assert.ok(title.includes('\\_'));
});

test('mensaje: nunca lleva consola, IP ni rutas aunque se las pasen', () => {
  const extra = { server: 'S', player: 'Steve', ip: '192.168.0.5', address: '203.0.113.7:25565', console: 'secreto de consola', logs: ['secreto de consola'], dir: 'C:\\Users\\alguien', file: 'C:\\Users\\alguien\\backup.zip' };
  for (const kind of [...hook.KINDS, 'test']) {
    const m = JSON.stringify(hook.buildMessage(kind, extra, (key, vars) => `${key} ${JSON.stringify(vars)}`));
    for (const forbidden of ['192.168.0.5', '203.0.113.7', 'secreto', 'alguien', 'backup.zip']) assert.ok(!m.includes(forbidden), `${kind}: ${forbidden}`);
  }
});

test('texto no confiable: controles, invisibles, enlaces y largo', () => {
  const clean = hook.cleanText;
  assert.equal(clean('Steve'), 'Steve');
  assert.equal(clean('a\nb\tc'), 'abc');
  assert.equal(clean(`a${String.fromCharCode(0x202e)}b${String.fromCharCode(0x200b)}c`), 'abc');
  assert.equal(clean('Steve_123'), 'Steve\\_123');
  assert.equal(clean('`x` ~y~ |z| [a](b)'), '\\`x\\` \\~y\\~ \\|z\\| \\[a\\]\\(b\\)');
  assert.ok(!clean('https://evil.example').includes('://'));
  assert.ok(!clean('discord.gg/abc').includes('discord.gg'));
  assert.ok(!clean('@here').includes('@here'));
  assert.ok(!clean('<@123456789>').includes('<@1'));
  assert.equal(clean('x'.repeat(500)).length, 64);
  assert.equal(clean(null), '');
});

test('el título se corta al tope de Discord', () => {
  const m = hook.buildMessage('started', { server: 'S' }, () => 'x'.repeat(900));
  assert.equal(m.embeds[0].title.length, 256);
});

// ---------- Cola, con reloj y temporizadores falsos ----------
function harness(script, opts = {}) {
  const state = { clock: 0, timers: [], sent: [], results: [], script: [...script] };
  const queue = hook.createQueue({
    now: () => state.clock,
    setTimer: (fn, ms) => {
      const timer = { at: state.clock + ms, fn };
      state.timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      state.timers = state.timers.filter((x) => x !== timer);
    },
    send: async (payload) => {
      state.sent.push({ payload, at: state.clock });
      const next = state.script.shift() ?? { status: 204 };
      if (next instanceof Error) throw next;
      return next;
    },
    onResult: (r) => state.results.push(r),
    ...opts,
  });
  // Avanza hasta que no quede nada pendiente
  state.drain = async (limit = 200) => {
    for (let i = 0; i < limit; i++) {
      await new Promise((r) => setImmediate(r));
      if (!state.timers.length) {
        await new Promise((r) => setImmediate(r));
        if (!state.timers.length) return;
      }
      state.timers.sort((a, b) => a.at - b.at);
      const timer = state.timers.shift();
      state.clock = Math.max(state.clock, timer.at);
      timer.fn();
    }
    throw new Error('la cola no terminó');
  };
  return { queue, state };
}

test('cola: encolar vuelve al instante aunque Discord tarde', async () => {
  let release;
  const queue = hook.createQueue({
    send: () => new Promise((r) => {
      release = () => r({ status: 204 });
    }),
    minIntervalMs: 0,
  });
  const before = Date.now();
  const p = queue.enqueue({ n: 1 });
  queue.enqueue({ n: 2 });
  assert.ok(Date.now() - before < 50);
  assert.equal(queue.size(), 2);
  while (!release) await new Promise((r) => setImmediate(r));
  release();
  assert.deepEqual(await p, { ok: true });
  queue.clear();
});

test('cola: manda en orden, de a uno y con espacio entre pedidos', async () => {
  const { queue, state } = harness([], { minIntervalMs: 1000 });
  for (let n = 1; n <= 3; n++) queue.enqueue({ n });
  await state.drain();
  assert.deepEqual(state.sent.map((s) => s.payload.n), [1, 2, 3]);
  assert.deepEqual(state.sent.map((s) => s.at), [0, 1000, 2000]);
  assert.ok(state.results.every((r) => r.ok));
  assert.equal(queue.size(), 0);
});

test('cola: respeta el 429 de Discord y reintenta el mismo mensaje después', async () => {
  const { queue, state } = harness([{ status: 429, retryAfterMs: 7000 }, { status: 204 }, { status: 204 }], { minIntervalMs: 1000 });
  queue.enqueue({ n: 1 });
  queue.enqueue({ n: 2 });
  await state.drain();
  assert.deepEqual(state.sent.map((s) => [s.payload.n, s.at]), [[1, 0], [1, 7000], [2, 8000]]);
  assert.deepEqual(state.results.map((r) => r.ok), [true, true]);
});

test('cola: un 429 sin espera válida igual frena al menos un segundo', async () => {
  const { queue, state } = harness([{ status: 429 }, { status: 204 }], { minIntervalMs: 100 });
  queue.enqueue({ n: 1 });
  await state.drain();
  assert.equal(state.sent[1].at, 1000);
});

test('cola: espera acotada, Discord no puede dejarla frenada para siempre', async () => {
  const { queue, state } = harness([{ status: 429, retryAfterMs: 999999999 }, { status: 204 }]);
  queue.enqueue({ n: 1 });
  await state.drain();
  assert.equal(state.sent[1].at, 15 * 60000);
});

test('cola: demasiados 429 seguidos descartan ese mensaje y sigue con el resto', async () => {
  const script = new Array(9).fill({ status: 429, retryAfterMs: 1000 });
  const { queue, state } = harness(script, { maxRetries: 4 });
  queue.enqueue({ n: 1 });
  queue.enqueue({ n: 2 });
  await state.drain();
  assert.deepEqual(state.results.map((r) => [r.ok, r.code]), [[false, 'limit'], [true, undefined]]);
  assert.equal(state.sent.at(-1).payload.n, 2);
});

test('cola: casi sin cupo, espera lo que dice Discord antes del siguiente', async () => {
  const { queue, state } = harness([{ status: 204, remaining: 0, resetAfterMs: 5000 }, { status: 204 }], { minIntervalMs: 100 });
  queue.enqueue({ n: 1 });
  queue.enqueue({ n: 2 });
  await state.drain();
  assert.equal(state.sent[1].at, 5000);
});

test('cola: errores de red y 5xx se reintentan con espera creciente hasta un tope', async () => {
  const net = new Error('sin red');
  const { queue, state } = harness([net, { status: 503 }, net, { status: 500 }, { status: 204 }], { maxRetries: 3, backoffMs: 1000, minIntervalMs: 10 });
  queue.enqueue({ n: 1 });
  queue.enqueue({ n: 2 });
  await state.drain();
  assert.deepEqual(state.sent.map((s) => [s.payload.n, s.at]), [[1, 0], [1, 1000], [1, 3000], [1, 7000], [2, 7010]]);
  assert.deepEqual(state.results.map((r) => [r.ok, r.code, r.retries]), [[false, 'retries', 4], [true, undefined, 0]]);
});

test('cola: webhook borrado (404) descarta lo pendiente y no insiste', async () => {
  for (const status of [401, 403, 404]) {
    const { queue, state } = harness([{ status }]);
    queue.enqueue({ n: 1 });
    queue.enqueue({ n: 2 });
    await state.drain();
    assert.equal(state.sent.length, 1, String(status));
    assert.deepEqual(state.results.map((r) => r.code), ['invalid', 'invalid']);
    assert.equal(queue.isDead(), true);
    const late = await queue.enqueue({ n: 3 });
    assert.deepEqual(late, { ok: false, code: 'invalid' });
    assert.equal(state.sent.length, 1);
    queue.reset();
    queue.enqueue({ n: 4 });
    await state.drain();
    assert.equal(state.sent.at(-1).payload.n, 4);
  }
});

test('cola: otro 4xx pierde ese mensaje y sigue', async () => {
  const { queue, state } = harness([{ status: 400 }, { status: 204 }]);
  queue.enqueue({ n: 1 });
  queue.enqueue({ n: 2 });
  await state.drain();
  assert.deepEqual(state.results.map((r) => [r.ok, r.code]), [[false, 'rejected'], [true, undefined]]);
});

test('cola: con el tope lleno se pierde lo más viejo, nunca lo que está en camino ni una prueba', async () => {
  const { queue, state } = harness([], { maxItems: 3, minIntervalMs: 10 });
  queue.enqueue({ n: 1 });
  queue.enqueue({ n: 'prueba' }, { important: true });
  queue.enqueue({ n: 3 });
  queue.enqueue({ n: 4 });
  queue.enqueue({ n: 5 });
  assert.equal(queue.size(), 3);
  await state.drain();
  assert.deepEqual(state.sent.map((s) => s.payload.n), [1, 'prueba', 5]);
  assert.equal(state.results.filter((r) => r.code === 'overflow').length, 2);
});

test('cola: vaciarla contesta a los que esperaban', async () => {
  const { queue, state } = harness([]);
  const a = queue.enqueue({ n: 1 });
  const b = queue.enqueue({ n: 2 });
  queue.clear();
  assert.deepEqual(await a, { ok: false, code: 'cleared' });
  assert.deepEqual(await b, { ok: false, code: 'cleared' });
  await state.drain();
  assert.equal(state.sent.length, 0);
});

test('respuesta de Discord: Retry-After, retry_after y cupo', async () => {
  const res = (status, headers = {}, body = null) => ({ status, headers: new Headers(headers), json: async () => body });
  assert.deepEqual(await hook.readResponse(res(204)), { status: 204 });
  assert.deepEqual(await hook.readResponse(res(204, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '1.5' })), { status: 204, remaining: 0, resetAfterMs: 1500 });
  assert.deepEqual(await hook.readResponse(res(429, { 'retry-after': '3' })), { status: 429, retryAfterMs: 3000 });
  assert.deepEqual(await hook.readResponse(res(429, {}, { retry_after: 1.25 })), { status: 429, retryAfterMs: 1250 });
  assert.deepEqual(await hook.readResponse(res(429, {}, { nada: 1 })), { status: 429, retryAfterMs: 5000 });
  assert.deepEqual(await hook.readResponse({ status: 429, headers: new Headers(), json: async () => { throw new Error('no es JSON'); } }), { status: 429, retryAfterMs: 5000 });
});
