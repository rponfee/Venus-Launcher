// Pruebas de "push-notify" (node --test): firma VAPID con claves generadas acá, secreto, límites y vencidos, con fetch falso.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { b64url, endpointOk, fromB64url, importVapidKey, pushTopic, sameSecret, vapidJwt } from '../vapid.ts';
import { createPushHandler } from '../handler.ts';

const USER = '11111111-2222-4333-8444-555555555555';
const CONV = '99999999-2222-4333-8444-555555555555';
const SECRET = 'secreto-de-prueba-de-al-menos-32-letras';
const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
const FCM = 'https://fcm.googleapis.com/fcm/send/dispositivo-a';
const APPLE = 'https://web.push.apple.com/dispositivo-b-abcdef';

async function newKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { publicKey: b64url(raw), privateKey: jwk.d as string, verifyKey: pair.publicKey };
}

// La base y los servicios de push, de mentira.
function world(keys: { publicKey: string; privateKey: string }, opts: { claims?: unknown[]; statuses?: Record<string, number>; claimStatus?: number } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const claims = [...(opts.claims ?? [{ allowed: true, subs: [{ id: 'sub-1', endpoint: FCM }] }])];
  const fakeFetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/rest/v1/rpc/push_claim')) {
      if (opts.claimStatus) return new Response('x', { status: opts.claimStatus });
      return new Response(JSON.stringify(claims.shift() ?? { allowed: false, reason: 'throttled' }), { status: 200 });
    }
    if (url.endsWith('/rest/v1/rpc/push_drop')) return new Response('1', { status: 200 });
    if (opts.statuses && url in opts.statuses && opts.statuses[url] === 0) throw new TypeError('sin red');
    return new Response('', { status: opts.statuses?.[url] ?? 201 });
  }) as typeof fetch;
  const logs: string[] = [];
  const handler = createPushHandler({
    secret: SECRET,
    vapidPublic: keys.publicKey,
    vapidPrivate: keys.privateKey,
    subject: 'mailto:prueba@example.invalid',
    supabaseUrl: 'https://proyecto.supabase.co',
    serviceKey: 'clave-service-role',
    fetch: fakeFetch,
    nowMs: () => NOW,
    log: (m) => logs.push(m),
  });
  return { handler, calls, logs };
}

const post = (body: unknown, secret: string | null = SECRET) => new Request('https://proyecto.supabase.co/functions/v1/push-notify', {
  method: 'POST',
  headers: secret === null ? {} : { 'x-venus-push-secret': secret },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const good = { user: USER, kind: 'message', key: CONV };

test('la firma es un ES256 válido, con aud, exp y sub de VAPID', async () => {
  const keys = await newKeys();
  const key = await importVapidKey({ ...keys, subject: 'mailto:x@example.invalid' });
  assert.ok(key);
  const jwt = await vapidJwt(key!, `${FCM}?a=1`, 'mailto:x@example.invalid', NOW);
  const [head, claims, sig] = jwt.split('.');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(fromB64url(head))), { typ: 'JWT', alg: 'ES256' });
  const c = JSON.parse(new TextDecoder().decode(fromB64url(claims)));
  assert.equal(c.aud, 'https://fcm.googleapis.com');
  assert.equal(c.sub, 'mailto:x@example.invalid');
  assert.equal(c.exp, Math.floor(NOW / 1000) + 3600);
  assert.equal(fromB64url(sig).length, 64);
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, keys.verifyKey, fromB64url(sig), new TextEncoder().encode(`${head}.${claims}`));
  assert.equal(ok, true);
  const other = await newKeys();
  const wrong = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, other.verifyKey, fromB64url(sig), new TextEncoder().encode(`${head}.${claims}`));
  assert.equal(wrong, false);
});

test('el pedido al servicio de push va sin cuerpo y con la clave pública', async () => {
  const keys = await newKeys();
  const { handler, calls } = world(keys);
  const res = await handler(post(good));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, sent: 1, dropped: 0, failed: 0 });
  const push = calls.find((c) => c.url === FCM)!;
  assert.equal(push.init.method, 'POST');
  assert.equal(push.init.body, undefined);
  const headers = push.init.headers as Record<string, string>;
  assert.equal(headers['content-length'], '0');
  assert.equal(headers.ttl, '86400');
  assert.equal(headers.topic, await pushTopic(`message:${CONV}`));
  assert.ok(headers.topic.length <= 32);
  const m = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(headers.authorization);
  assert.ok(m);
  assert.equal(m![2], keys.publicKey);
  const [h, c, s] = m![1].split('.');
  assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, keys.verifyKey, fromB64url(s), new TextEncoder().encode(`${h}.${c}`)));
  // Los pedidos salen sin el secreto del llamador ni la service role
  assert.ok(!JSON.stringify(push.init).includes('service-role'));
  assert.ok(!JSON.stringify(push.init).includes(SECRET));
});

test('sin el secreto correcto no se toca la base ni se manda nada', async () => {
  const keys = await newKeys();
  for (const secret of [null, '', 'otro-secreto']) {
    const { handler, calls } = world(keys);
    const res = await handler(post(good, secret));
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0);
  }
});

test('sameSecret compara bien', async () => {
  assert.equal(await sameSecret(SECRET, SECRET), true);
  assert.equal(await sameSecret(SECRET, `${SECRET}x`), false);
  assert.equal(await sameSecret('', ''), false);
});

test('rechaza lo que no sea usuario, tipo y clave válidos', async () => {
  const keys = await newKeys();
  const bad = [
    'no es json',
    { user: 'x', kind: 'message', key: CONV },
    { user: USER, kind: 'otro', key: CONV },
    { user: USER, kind: 'message', key: 'x' },
    { user: USER, kind: 'message', key: CONV, relleno: 'x'.repeat(500) },
  ];
  for (const body of bad) {
    const { handler, calls } = world(keys);
    const res = await handler(post(body));
    assert.ok(res.status === 400 || res.status === 413, String(res.status));
    assert.equal(calls.length, 0);
  }
});

test('si el límite lo frena, no sale ningún aviso', async () => {
  const keys = await newKeys();
  for (const reason of ['throttled', 'hourly', 'no_subscriptions']) {
    const { handler, calls } = world(keys, { claims: [{ allowed: false, reason }] });
    const res = await handler(post(good));
    assert.deepEqual(await res.json(), { ok: true, sent: 0, skipped: reason });
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith('/push_claim'));
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { p_user: USER, p_kind: 'message', p_key: CONV });
  }
});

test('dos avisos seguidos: el segundo queda frenado por la base', async () => {
  const keys = await newKeys();
  const { handler, calls } = world(keys, { claims: [{ allowed: true, subs: [{ id: 's', endpoint: FCM }] }, { allowed: false, reason: 'throttled' }] });
  assert.equal((await (await handler(post(good))).json()).sent, 1);
  assert.equal((await (await handler(post(good))).json()).sent, 0);
  assert.equal(calls.filter((c) => c.url === FCM).length, 1);
});

test('borra los vencidos (404 y 410) y deja los que fallan por otra cosa', async () => {
  const keys = await newKeys();
  const endpoints = {
    [FCM]: 410,
    [APPLE]: 404,
    'https://updates.push.services.mozilla.com/wpush/v2/caido': 503,
    'https://wns2-by3p.notify.windows.com/w/?token=sinred': 0,
    'https://fcm.googleapis.com/fcm/send/funciona': 201,
  };
  const subs = Object.keys(endpoints).map((endpoint, i) => ({ id: `s${i}`, endpoint }));
  const { handler, calls, logs } = world(keys, { claims: [{ allowed: true, subs }], statuses: endpoints });
  const res = await handler(post(good));
  assert.deepEqual(await res.json(), { ok: true, sent: 1, dropped: 2, failed: 2 });
  const drop = calls.find((c) => c.url.endsWith('/push_drop'))!;
  assert.deepEqual(JSON.parse(String(drop.init.body)), { p_ids: ['s0', 's1'] });
  // Los registros dicen el host, nunca el endpoint
  assert.ok(logs.every((l) => !l.includes('caido') && !l.includes('sinred')));
  assert.ok(logs.some((l) => l.includes('503')));
});

test('nunca llama a una dirección que no sea de un servicio de push', async () => {
  const keys = await newKeys();
  const subs = [
    { id: 'a', endpoint: 'https://169.254.169.254/latest/meta-data' },
    { id: 'b', endpoint: 'http://fcm.googleapis.com/fcm/send/abcdefghij' },
    { id: 'c', endpoint: 'https://fcm.googleapis.com.evil.example/fcm/send/abc' },
    { id: 'd', endpoint: FCM },
  ];
  const { handler, calls } = world(keys, { claims: [{ allowed: true, subs }] });
  const res = await handler(post(good));
  assert.equal((await res.json()).sent, 1);
  const pushed = calls.filter((c) => !c.url.includes('/rest/v1/'));
  assert.deepEqual(pushed.map((c) => c.url), [FCM]);
});

test('endpointOk acepta los servicios conocidos y nada más', () => {
  for (const ok of [FCM, APPLE, 'https://updates.push.services.mozilla.com/wpush/v2/abc', 'https://wns2-by3p.notify.windows.com/w/?token=abc']) assert.equal(endpointOk(ok), true, ok);
  for (const no of ['http://fcm.googleapis.com/fcm/send/abcdefghijkl', 'https://user@fcm.googleapis.com/fcm/send/abcdef', 'https://fcm.googleapis.com:8443/fcm/send/abcdef', 'https://evil.example/fcm/send/abcdefghijklmnop', null, 42]) assert.equal(endpointOk(no), false, String(no));
});

test('GET da solo la clave pública, con CORS', async () => {
  const keys = await newKeys();
  const { handler, calls } = world(keys);
  const res = await handler(new Request('https://x/functions/v1/push-notify'));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { publicKey: keys.publicKey });
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(calls.length, 0);
  const pre = await handler(new Request('https://x/functions/v1/push-notify', { method: 'OPTIONS' }));
  assert.equal(pre.status, 204);
  const put = await handler(new Request('https://x/functions/v1/push-notify', { method: 'PUT' }));
  assert.equal(put.status, 405);
});

test('sin claves o con claves rotas responde 503 y no consulta nada', async () => {
  const keys = await newKeys();
  for (const broken of [{ publicKey: '', privateKey: '' }, { publicKey: keys.publicKey, privateKey: 'corta' }, { publicKey: 'corta', privateKey: keys.privateKey }]) {
    const { handler, calls } = world(broken);
    const res = await handler(new Request('https://x/functions/v1/push-notify'));
    assert.equal(res.status, 503);
    const res2 = await handler(post(good));
    assert.equal(res2.status, 503);
    assert.equal(calls.length, 0);
  }
});

test('si la base no responde, 503 y sin avisos', async () => {
  const keys = await newKeys();
  const { handler, calls } = world(keys, { claimStatus: 500 });
  const res = await handler(post(good));
  assert.equal(res.status, 503);
  assert.equal(calls.length, 1);
});

test('GET sin configurar conserva CORS para que la app pueda leer el 503', async () => {
  const { handler } = world({ publicKey: '', privateKey: '' });
  const res = await handler(new Request('https://proyecto.example/functions/v1/push-notify'));
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('una lectura de cuerpo interrumpida devuelve 400 sin tocar la base', async () => {
  const { handler, calls } = world(await newKeys());
  const req = post(good);
  Object.defineProperty(req, 'body', { value: new ReadableStream({ start(controller) { controller.error(new Error('lectura interrumpida')); } }) });
  assert.equal((await handler(req)).status, 400);
  assert.equal(calls.length, 0);
});

test('el límite del cuerpo cuenta bytes UTF-8 y cancela la lectura al superarlo', async () => {
  const { handler, calls } = world(await newKeys());
  let cancelled = false;
  const req = post(good);
  Object.defineProperty(req, 'body', { value: new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('á'.repeat(201))); },
    cancel() { cancelled = true; },
  }) });
  assert.equal((await handler(req)).status, 413);
  assert.equal(cancelled, true);
  assert.equal(calls.length, 0);
});

test('una respuesta incompleta de la base devuelve 503 sin envíos', async () => {
  const keys = await newKeys();
  for (const claim of [{}, { allowed: true, subs: null }]) {
    const { handler, calls } = world(keys, { claims: [claim] });
    assert.equal((await handler(post(good))).status, 503);
    assert.equal(calls.length, 1);
  }
});

test('la consulta a la base vence y no vuelca detalles del error al registro', async () => {
  const keys = await newKeys();
  const logs: string[] = [];
  let calls = 0;
  const handler = createPushHandler({ secret: SECRET, vapidPublic: keys.publicKey, vapidPrivate: keys.privateKey,
    subject: 'mailto:test@example.invalid', supabaseUrl: 'https://proyecto.example', serviceKey: 'solo-prueba', timeoutMs: 10,
    log: (message) => logs.push(message), fetch: (async (_input, init) => {
      calls++;
      assert.equal(init?.redirect, 'error');
      return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('detalle-simulado-privado')), { once: true }));
    }) as typeof fetch,
  });
  assert.equal((await handler(post(good))).status, 503);
  assert.equal(calls, 1);
  assert.deepEqual(logs, ['no se pudo consultar la base']);
});
