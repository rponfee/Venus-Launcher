'use strict';
// Subir clips: PKCE, servidor de retorno, YouTube reanudable y TikTok por pedazos, con fetch falso.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const oauth = require('../oauth');
const { createYoutube, cleanMeta, CHUNK, UPLOAD_URL } = require('../youtube');
const { createTiktok, planChunks, INIT_URL, STATUS_URL } = require('../tiktok');

const MIB = 1024 * 1024;
const noSleep = async () => {};

function res(status, body, headers = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { status, ok: status >= 200 && status < 300, headers: { get: (k) => h.get(String(k).toLowerCase()) ?? null }, json: async () => body, text: async () => JSON.stringify(body) };
}

// Lee de un archivo imaginario: los bytes son solo su tamanio
const reader = () => async (pos, len) => Buffer.alloc(len, pos % 251);

// ---------- PKCE ----------

test('PKCE: verificador valido y los dos tipos de desafio', () => {
  const v = oauth.randomVerifier();
  assert.ok(v.length >= 43 && v.length <= 128);
  assert.match(v, /^[A-Za-z0-9._~-]+$/);
  assert.notEqual(oauth.randomVerifier(), v);
  // Ejemplo del RFC 7636, apendice B
  assert.equal(oauth.challengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  // TikTok para escritorio: hexadecimal
  assert.equal(oauth.challengeHex('abc'), crypto.createHash('sha256').update('abc').digest('hex'));
  assert.notEqual(oauth.randomState(), oauth.randomState());
});

// ---------- Servidor de retorno ----------

test('el retorno solo acepta el state correcto y en 127.0.0.1', async () => {
  const loop = await oauth.startLoopback({ path: '/callback/', state: 'abc', page: (ok) => (ok ? 'bien' : 'mal') });
  assert.match(loop.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback\/$/);
  const base = loop.redirectUri;
  assert.equal((await fetch(`${base}?state=otro&code=x`)).status, 400);
  assert.equal((await fetch(`http://127.0.0.1:${loop.port}/otra?state=abc&code=x`)).status, 404);
  const okRes = await fetch(`${base}?state=abc&code=elcodigo`);
  assert.equal(await okRes.text(), 'bien');
  assert.equal(await loop.result, 'elcodigo');
});

test('el retorno distingue rechazo, tiempo y cancelar', async () => {
  const denied = await oauth.startLoopback({ state: 'a', page: () => '' });
  await fetch(`${denied.redirectUri}?state=a&error=access_denied`);
  await assert.rejects(denied.result, (e) => e.code === 'denied');
  const slow = await oauth.startLoopback({ state: 'a', timeoutMs: 15 });
  await assert.rejects(slow.result, (e) => e.code === 'timeout');
  const cancelled = await oauth.startLoopback({ state: 'a' });
  cancelled.close();
  await assert.rejects(cancelled.result, (e) => e.code === 'cancelled');
});

// ---------- YouTube ----------

test('YouTube: URL de autorizacion con PKCE y permiso de subir solamente', () => {
  const yt = createYoutube({ fetch: async () => {}, clientId: 'id-app' });
  const u = new URL(yt.authorizeUrl({ redirectUri: 'http://127.0.0.1:5000/', challenge: 'CH', state: 'ST' }));
  assert.equal(u.host, 'accounts.google.com');
  assert.equal(u.searchParams.get('client_id'), 'id-app');
  assert.equal(u.searchParams.get('code_challenge'), 'CH');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('scope'), 'https://www.googleapis.com/auth/youtube.upload');
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.equal(u.searchParams.get('state'), 'ST');
});

test('YouTube: intercambio y renovacion, sin secreto salvo que se cargue', async () => {
  const calls = [];
  const fetchFake = async (url, init) => {
    calls.push({ url, body: new URLSearchParams(init.body) });
    return res(200, { access_token: 'at', expires_in: 3600, refresh_token: 'rt', scope: 's' });
  };
  const yt = createYoutube({ fetch: fetchFake, clientId: 'id' });
  const t = await yt.exchange({ code: 'c', verifier: 'v', redirectUri: 'r' });
  assert.equal(t.access_token, 'at');
  assert.equal(t.refresh_token, 'rt');
  assert.ok(t.expires_at > Date.now());
  assert.equal(calls[0].body.get('code_verifier'), 'v');
  assert.equal(calls[0].body.get('grant_type'), 'authorization_code');
  assert.equal(calls[0].body.get('client_secret'), null);
  // Google no siempre manda otro token de renovacion: se conserva el que habia
  const r = await createYoutube({ fetch: async () => res(200, { access_token: 'nuevo', expires_in: 10 }), clientId: 'id' }).refresh(t);
  assert.equal(r.access_token, 'nuevo');
  assert.equal(r.refresh_token, 'rt');
  // Con secreto
  const conSecreto = createYoutube({ fetch: fetchFake, clientId: 'id', clientSecret: 'sec' });
  await conSecreto.refresh(t);
  assert.equal(calls.at(-1).body.get('client_secret'), 'sec');
  // Grant vencido: hay que volver a conectar
  const vencido = createYoutube({ fetch: async () => res(400, { error: 'invalid_grant' }), clientId: 'id' });
  await assert.rejects(vencido.refresh(t), (e) => e.code === 'session');
});

test('YouTube: revocar', async () => {
  const calls = [];
  const yt = createYoutube({ fetch: async (u, i) => (calls.push({ u, body: i.body }), res(200, {})), clientId: 'id' });
  assert.equal(await yt.revoke({ refresh_token: 'rt', access_token: 'at' }), true);
  assert.match(calls[0].u, /oauth2\.googleapis\.com\/revoke/);
  assert.equal(new URLSearchParams(calls[0].body).get('token'), 'rt');
  assert.equal(await yt.revoke(null), true);
});

test('metadatos: sin < ni >, recortados y privado por defecto', () => {
  const m = cleanMeta({ title: `<b>${'x'.repeat(200)}`, description: 'a<b>c', privacy: 'cualquiera' });
  assert.equal(m.title.length, 100);
  assert.ok(!m.title.includes('<'));
  assert.equal(m.description, 'abc');
  assert.equal(m.privacy, 'private');
  assert.equal(cleanMeta({ title: 't', privacy: 'unlisted' }).privacy, 'unlisted');
});

// Un servidor de subida que recibe el archivo de a pedazos y contesta como YouTube
function ytServer({ size, onPut } = {}) {
  const st = { received: 0, puts: [], opened: 0, status: 0, token: [] };
  const fetchFake = async (url, init) => {
    if (url === UPLOAD_URL) {
      st.opened += 1;
      st.open = { headers: init.headers, body: JSON.parse(init.body) };
      return res(200, {}, { Location: `https://upload.example/session${st.opened}` });
    }
    st.token.push(init.headers.Authorization);
    const range = init.headers['Content-Range'];
    st.puts.push({ url, range, length: Number(init.headers['Content-Length']), bodyLength: init.body?.length ?? 0, type: init.headers['Content-Type'] });
    if (range.startsWith('bytes */')) {
      if (st.received >= size) return res(201, { id: 'VID123' });
      return res(308, {}, st.received ? { Range: `bytes=0-${st.received - 1}` } : {});
    }
    const custom = onPut?.(st, init);
    if (custom) return custom;
    const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(range);
    assert.equal(Number(m[1]), st.received, 'tiene que seguir donde quedo');
    st.received = Number(m[2]) + 1;
    if (st.received >= size) return res(201, { id: 'VID123' });
    return res(308, {}, { Range: `bytes=0-${st.received - 1}` });
  };
  return { st, fetchFake };
}

const ytUpload = (fetchFake, size, over = {}) =>
  createYoutube({ fetch: fetchFake, clientId: 'id', sleep: noSleep }).upload({
    getToken: async () => 'tok',
    meta: { title: 'Mi clip', description: 'Desc' },
    size,
    mime: 'video/webm',
    read: reader(),
    ...over,
  });

test('YouTube: sube reanudable, de a pedazos multiplos de 256 KB, privado', async () => {
  assert.equal(CHUNK % (256 * 1024), 0);
  const size = 20 * MIB + 123;
  const { st, fetchFake } = ytServer({ size });
  const progress = [];
  const out = await ytUpload(fetchFake, size, { onProgress: (p) => progress.push(p.sent) });
  assert.equal(out.id, 'VID123');
  assert.equal(out.privacy, 'private');
  assert.equal(st.opened, 1);
  assert.equal(st.open.headers['X-Upload-Content-Length'], String(size));
  assert.equal(st.open.headers['X-Upload-Content-Type'], 'video/webm');
  assert.equal(st.open.body.status.privacyStatus, 'private');
  assert.equal(st.open.body.snippet.title, 'Mi clip');
  assert.equal(st.open.body.snippet.categoryId, '20');
  assert.equal(st.puts.length, 3);
  assert.equal(st.puts[0].range, `bytes 0-${CHUNK - 1}/${size}`);
  assert.equal(st.puts[1].range, `bytes ${CHUNK}-${2 * CHUNK - 1}/${size}`);
  assert.equal(st.puts[2].range, `bytes ${2 * CHUNK}-${size - 1}/${size}`);
  assert.equal(st.puts[0].length, CHUNK);
  assert.equal(st.puts[0].bodyLength, CHUNK);
  assert.equal(st.puts[0].type, 'video/webm');
  assert.deepEqual(progress.at(-1), size);
  assert.equal(st.token[0], 'Bearer tok');
});

test('YouTube: despues de un 503 pregunta hasta donde llego y sigue desde ahi', async () => {
  const size = 12 * MIB;
  let failed = false;
  const { st, fetchFake } = ytServer({
    size,
    onPut: () => {
      if (!failed && st_received(st) === CHUNK) {
        failed = true;
        return res(503, {});
      }
      return null;
    },
  });
  const out = await ytUpload(fetchFake, size);
  assert.equal(out.id, 'VID123');
  assert.ok(st.puts.some((p) => p.range === `bytes */${size}`), 'pregunto el estado');
  const after = st.puts.findIndex((p) => p.range === `bytes */${size}`);
  assert.equal(st.puts[after + 1].range, `bytes ${CHUNK}-${size - 1}/${size}`);
});
const st_received = (st) => st.received;

test('YouTube: conexion perdida: sigue desde lo que recibio el servidor', async () => {
  const size = 12 * MIB;
  let thrown = false;
  const { st, fetchFake } = ytServer({ size });
  const flaky = async (url, init) => {
    if (url !== UPLOAD_URL && !thrown && init.headers['Content-Range'].startsWith(`bytes ${CHUNK}-`)) {
      thrown = true;
      throw new Error('ECONNRESET');
    }
    return fetchFake(url, init);
  };
  assert.equal((await ytUpload(flaky, size)).id, 'VID123');
  assert.equal(st.received, size);
});

test('YouTube: si ya recibio todo, el estado trae el video', async () => {
  const size = 4 * MIB;
  let first = true;
  const { st, fetchFake } = ytServer({ size });
  const lostReply = async (url, init) => {
    if (url !== UPLOAD_URL && first && !init.headers['Content-Range'].startsWith('bytes */')) {
      first = false;
      st.received = size; // llego todo, pero se perdio la respuesta
      throw new Error('ECONNRESET');
    }
    return fetchFake(url, init);
  };
  assert.equal((await ytUpload(lostReply, size)).id, 'VID123');
});

test('YouTube: un 401 renueva el token una vez; la sesion vencida vuelve a abrirse', async () => {
  const size = 4 * MIB;
  const { st, fetchFake } = ytServer({ size });
  let once = true;
  const expired = async (url, init) => {
    if (url !== UPLOAD_URL && once) {
      once = false;
      return res(401, { error: { errors: [{ reason: 'authError' }] } });
    }
    return fetchFake(url, init);
  };
  let renewed = 0;
  const out = await ytUpload(expired, size, {
    renewToken: async () => {
      renewed += 1;
      return 'tok2';
    },
  });
  assert.equal(out.id, 'VID123');
  assert.equal(renewed, 1);
  assert.equal(st.token.at(-1), 'Bearer tok2');

  const again = ytServer({ size });
  let gone = true;
  const lost = async (url, init) => {
    if (url !== UPLOAD_URL && gone) {
      gone = false;
      return res(404, {});
    }
    return again.fetchFake(url, init);
  };
  assert.equal((await ytUpload(lost, size)).id, 'VID123');
  assert.equal(again.st.opened, 2);
});

test('YouTube: errores que no se reintentan y cancelar', async () => {
  const size = 4 * MIB;
  const quota = async (url) => (url === UPLOAD_URL ? res(403, { error: { errors: [{ reason: 'quotaExceeded' }] } }) : res(200, {}));
  await assert.rejects(ytUpload(quota, size), (e) => e.code === 'quota');
  const noChannel = async (url) => (url === UPLOAD_URL ? res(403, { error: { errors: [{ reason: 'youtubeSignupRequired' }] } }) : res(200, {}));
  await assert.rejects(ytUpload(noChannel, size), (e) => e.code === 'noChannel');
  const bad = ytServer({ size, onPut: () => res(400, { error: { errors: [{ reason: 'invalidVideo' }] } }) });
  await assert.rejects(ytUpload(bad.fetchFake, size), (e) => e.code === 'badRequest');
  const down = ytServer({ size, onPut: () => res(500, {}) });
  const askAlso500 = async (url, init) => (url !== UPLOAD_URL && init.headers['Content-Range'].startsWith('bytes */') ? res(503, {}) : down.fetchFake(url, init));
  await assert.rejects(ytUpload(askAlso500, size), (e) => e.code === 'server');
  const c = new AbortController();
  c.abort();
  const { fetchFake } = ytServer({ size });
  await assert.rejects(ytUpload(fetchFake, size, { signal: c.signal }), (e) => e.code === 'cancelled');
  await assert.rejects(createYoutube({ fetch: fetchFake, clientId: 'id' }).upload({ getToken: async () => 't', meta: { title: '<>' }, size, read: reader() }), (e) => e.code === 'badRequest');
});

test('YouTube con el fetch de verdad: 308 sin seguir redirecciones, Range y encabezados', async () => {
  // Un servidor local que contesta como YouTube: lo que no se puede probar con un fetch falso es como trata undici el 308
  const size = 10 * MIB;
  const seen = { puts: [], authOk: true };
  let received = 0;
  const server = http.createServer((req, resp) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (req.method === 'POST') {
        assert.equal(req.headers['x-upload-content-length'], String(size));
        assert.equal(JSON.parse(body).status.privacyStatus, 'private');
        resp.writeHead(200, { Location: `http://127.0.0.1:${server.address().port}/session` });
        return resp.end();
      }
      if (req.headers.authorization !== 'Bearer tok') seen.authOk = false;
      const range = req.headers['content-range'];
      seen.puts.push({ range, length: Number(req.headers['content-length']), got: body.length });
      const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(range);
      received = Number(m[2]) + 1;
      if (received >= size) {
        resp.writeHead(201, { 'Content-Type': 'application/json' });
        return resp.end(JSON.stringify({ id: 'REAL1' }));
      }
      // Con un Location raro: si fetch siguiera el 308, se iria a otro lado y la prueba falla
      resp.writeHead(308, { Range: `bytes=0-${received - 1}`, Location: 'http://127.0.0.1:1/nunca' });
      return resp.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const port = server.address().port;
    const doFetch = (url, init) => fetch(url === UPLOAD_URL ? `http://127.0.0.1:${port}/upload` : url, init);
    const out = await createYoutube({ fetch: doFetch, clientId: 'id', sleep: noSleep }).upload({ getToken: async () => 'tok', meta: { title: 'x' }, size, mime: 'video/webm', read: reader() });
    assert.equal(out.id, 'REAL1');
    assert.equal(seen.authOk, true);
    assert.equal(seen.puts.length, 2);
    assert.equal(seen.puts[0].length, CHUNK);
    assert.equal(seen.puts[0].got, CHUNK);
    assert.equal(seen.puts[1].range, `bytes ${CHUNK}-${size - 1}/${size}`);
  } finally {
    server.close();
  }
});

// ---------- TikTok ----------

test('TikTok: pedazos segun sus reglas', () => {
  // Hasta 10 MB va entero (de 5 a 64 MB se acepta un solo pedazo)
  assert.deepEqual(planChunks(1000), { chunkSize: 1000, count: 1, ranges: [{ start: 0, end: 999 }] });
  assert.equal(planChunks(9 * MIB).count, 1);
  // El ultimo se lleva lo que sobra; la cantidad es para abajo
  const p = planChunks(25 * MIB + 7);
  assert.equal(p.chunkSize, 10 * MIB);
  assert.equal(p.count, 2);
  assert.deepEqual(p.ranges[0], { start: 0, end: 10 * MIB - 1 });
  assert.deepEqual(p.ranges[1], { start: 10 * MIB, end: 25 * MIB + 6 });
  assert.ok(p.ranges[1].end - p.ranges[1].start + 1 <= 128 * MIB);
  // Muy grande: nunca mas de 1000 pedazos
  const huge = planChunks(20000 * MIB);
  assert.ok(huge.count <= 1000);
  assert.ok(huge.chunkSize >= 5 * MIB && huge.chunkSize <= 64 * MIB);
  assert.throws(() => planChunks(0), (e) => e.code === 'badRequest');
  assert.throws(() => planChunks(70000 * MIB), (e) => e.code === 'tooBig');
});

test('TikTok: autorizacion con desafio en hexadecimal y sin secreto en el launcher', async () => {
  const brokerCalls = [];
  const tk = createTiktok({
    fetch: async () => assert.fail('el intercambio no sale directo'),
    clientKey: 'ck',
    broker: async (action, params) => {
      brokerCalls.push({ action, params });
      return { access_token: 'at', refresh_token: 'rt2', expires_in: 7200, refresh_expires_in: 100, open_id: 'o' };
    },
  });
  const verifier = oauth.randomVerifier();
  const challenge = oauth.challengeHex(verifier);
  const u = new URL(tk.authorizeUrl({ redirectUri: 'http://127.0.0.1:5/callback/', challenge, state: 's' }));
  assert.equal(`${u.origin}${u.pathname}`, 'https://www.tiktok.com/v2/auth/authorize/');
  assert.equal(u.searchParams.get('client_key'), 'ck');
  assert.equal(u.searchParams.get('scope'), 'video.upload');
  assert.equal(u.searchParams.get('code_challenge'), challenge);
  assert.match(u.searchParams.get('code_challenge'), /^[0-9a-f]{64}$/);
  const t = await tk.exchange({ code: 'c', verifier, redirectUri: 'r' });
  assert.equal(t.open_id, 'o');
  assert.deepEqual(brokerCalls[0], { action: 'exchange', params: { code: 'c', codeVerifier: verifier, redirectUri: 'r' } });
  // Cada renovacion trae otro token de renovacion
  const r = await tk.refresh(t);
  assert.equal(r.refresh_token, 'rt2');
  assert.equal(brokerCalls[1].action, 'refresh');
  await tk.revoke(t);
  assert.equal(brokerCalls[2].action, 'revoke');
  assert.deepEqual(brokerCalls[2].params, { token: 'at' });
});

function tkServer({ size, statuses = ['SEND_TO_USER_INBOX'], onPut, init } = {}) {
  const st = { puts: [], init: null, received: 0, polled: 0 };
  const fetchFake = async (url, opts) => {
    if (url === INIT_URL) {
      st.init = JSON.parse(opts.body);
      st.auth = opts.headers.Authorization;
      return init ? init() : res(200, { data: { publish_id: 'p.1', upload_url: 'https://up.example/put?x=1' }, error: { code: 'ok', message: '' } });
    }
    if (url === STATUS_URL) {
      st.polled += 1;
      const status = statuses[Math.min(st.polled - 1, statuses.length - 1)];
      return res(200, { data: { status, fail_reason: status === 'FAILED' ? 'file_format_check_failed' : undefined }, error: { code: 'ok' } });
    }
    const custom = onPut?.(st);
    if (custom) return custom;
    st.puts.push({ range: opts.headers['Content-Range'], type: opts.headers['Content-Type'], length: Number(opts.headers['Content-Length']), body: opts.body.length });
    const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(opts.headers['Content-Range']);
    assert.equal(Number(m[1]), st.received);
    st.received = Number(m[2]) + 1;
    return res(st.received >= size ? 201 : 206, {});
  };
  return { st, fetchFake };
}

const tkUpload = (fetchFake, size, over = {}) => createTiktok({ fetch: fetchFake, clientKey: 'ck', broker: async () => ({}), sleep: noSleep }).upload({ getToken: async () => 'tok', size, mime: 'video/webm', read: reader(), ...over });

test('TikTok: abre con FILE_UPLOAD, sube en orden y espera la bandeja', async () => {
  const size = 25 * MIB + 7;
  const { st, fetchFake } = tkServer({ size, statuses: ['PROCESSING_UPLOAD', 'SEND_TO_USER_INBOX'] });
  const progress = [];
  const out = await tkUpload(fetchFake, size, { onProgress: (p) => progress.push(p.sent) });
  assert.deepEqual(out, { publishId: 'p.1', status: 'inbox' });
  assert.deepEqual(st.init, { source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: 10 * MIB, total_chunk_count: 2 } });
  assert.equal(st.auth, 'Bearer tok');
  assert.equal(st.puts.length, 2);
  assert.equal(st.puts[0].range, `bytes 0-${10 * MIB - 1}/${size}`);
  assert.equal(st.puts[1].range, `bytes ${10 * MIB}-${size - 1}/${size}`);
  assert.equal(st.puts[0].type, 'video/webm');
  assert.equal(st.puts[1].length, st.puts[1].body);
  assert.equal(progress.at(-1), size);
  assert.equal(st.polled, 2);
});

test('TikTok: reintenta un pedazo que fallo y avisa si TikTok rechaza', async () => {
  const size = 1 * MIB;
  let failures = 2;
  const flaky = tkServer({
    size,
    onPut: () => {
      if (failures > 0) {
        failures -= 1;
        return res(502, {});
      }
      return null;
    },
  });
  assert.equal((await tkUpload(flaky.fetchFake, size)).status, 'inbox');
  const rejected = tkServer({ size, statuses: ['FAILED'] });
  await assert.rejects(tkUpload(rejected.fetchFake, size), (e) => e.code === 'rejected');
  const processing = tkServer({ size, statuses: ['PROCESSING_UPLOAD'] });
  assert.equal((await tkUpload(processing.fetchFake, size)).status, 'processing');
});

test('TikTok: errores de la API y cancelar', async () => {
  const size = 1 * MIB;
  const spam = tkServer({ size, init: () => res(403, { error: { code: 'spam_risk_too_many_pending_share', message: 'x' } }) });
  await assert.rejects(tkUpload(spam.fetchFake, size), (e) => e.code === 'quota');
  let renewed = 0;
  let first = true;
  const stale = tkServer({
    size,
    init: () => {
      if (first) {
        first = false;
        return res(401, { error: { code: 'access_token_invalid' } });
      }
      return res(200, { data: { publish_id: 'p', upload_url: 'https://up.example/x' }, error: { code: 'ok' } });
    },
  });
  const out = await tkUpload(stale.fetchFake, size, {
    renewToken: async () => {
      renewed += 1;
      return 'tok2';
    },
  });
  assert.equal(out.status, 'inbox');
  assert.equal(renewed, 1);
  assert.equal(stale.st.auth, 'Bearer tok2');
  const c = new AbortController();
  const { fetchFake } = tkServer({
    size,
    onPut: () => {
      c.abort();
      return res(500, {});
    },
  });
  await assert.rejects(tkUpload(fetchFake, size, { signal: c.signal }), (e) => e.code === 'cancelled');
});
