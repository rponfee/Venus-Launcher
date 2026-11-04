'use strict';
// Seguridad del control remoto con pedidos HTTP de verdad, escuchando en 127.0.0.1 (quien elige la IP de la red local
// es serverremote.js con lanAddresses, probado en security.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createRemoteHost, MAX_BODY, TTL_MS, TOKEN_HEADER, AFTER_HEADER } = require('../host');

const IP = '127.0.0.1';

function fakeBackend() {
  const calls = [];
  return {
    calls,
    fail: null,
    snapshot: async () => ({
      name: 'Mi server',
      typeName: 'Paper',
      version: '1.21.4',
      state: 'online',
      busy: false,
      startedAt: 123,
      players: [{ name: 'Steve', since: 1, ip: '192.168.0.99', uuid: 'secreto' }],
      // Cualquier otra cosa del servidor no tiene que salir
      dir: 'C:\\Users\\alguien\\servidor',
      ip: '192.168.0.99',
    }),
    async action(a) {
      if (this.fail) throw this.fail;
      calls.push(a);
    },
  };
}

function open(t, opts = {}) {
  const backend = opts.backend || fakeBackend();
  const events = [];
  const host = createRemoteHost({
    ip: IP,
    backend,
    strings: () => ({ lang: 'es', page_start: 'Iniciar' }),
    onEvent: (kind, data) => events.push({ kind, ...data }),
    ...opts,
  });
  t.after(() => host.stop('fin'));
  return { host, backend, events };
}

// Pedido crudo: con http.request se puede mandar cualquier Host, sin él o repetido.
function send(host, { path = '/api/state', method = 'GET', headers = {}, body, setHost = true, hostHeader, localAddress } = {}) {
  const { port } = host.info();
  return new Promise((resolve, reject) => {
    const req = http.request({ host: IP, port, path, method, headers: { ...(setHost ? { Host: hostHeader ?? `${IP}:${port}` } : {}), ...headers }, setHost: false, localAddress, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* no era JSON */
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const tokenOf = (host) => new URL(host.info().url).hash.slice(3);
const auth = (host, extra = {}) => ({ [TOKEN_HEADER]: tokenOf(host), ...extra });
const postJson = (host, obj, extra = {}) => send(host, { path: '/api/action', method: 'POST', headers: { ...auth(host), 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(obj) });

function assertSafeHeaders(res) {
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.ok(res.headers['content-security-policy']?.includes("default-src 'none'"));
  for (const name of Object.keys(res.headers)) assert.ok(!name.startsWith('access-control-'), `sin CORS: ${name}`);
}

test('escucha solo en la IP indicada, en otra dirección no contesta', { skip: process.platform === 'darwin' }, async (t) => {
  const { host } = open(t);
  await host.start();
  const { port } = host.info();
  assert.equal(host.info().address, IP);
  await assert.rejects(
    new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.2', port, path: '/', agent: false, timeout: 1500 }, resolve);
      req.on('timeout', () => req.destroy(new Error('sin respuesta')));
      req.on('error', reject);
    }),
  );
});

test('el token viaja en el fragmento: la URL no tiene query string y el código se regenera en cada encendido', async (t) => {
  const a = open(t);
  const b = open(t);
  await a.host.start();
  await b.host.start();
  const url = new URL(a.host.info().url);
  assert.equal(url.search, '');
  assert.match(url.hash, /^#t=[0-9A-Z]{28}$/);
  assert.equal(url.origin, a.host.info().baseUrl);
  assert.notEqual(tokenOf(a.host), tokenOf(b.host));
  assert.equal(a.host.info().code.replaceAll('-', ''), tokenOf(a.host));
});

test('sin token o con token malo no hay datos', async (t) => {
  const { host, backend } = open(t);
  await host.start();
  for (const headers of [{}, { [TOKEN_HEADER]: '' }, { [TOKEN_HEADER]: 'X'.repeat(28) }, { [TOKEN_HEADER]: 'corto' }, { authorization: `Bearer ${tokenOf(host)}` }, { cookie: `t=${tokenOf(host)}` }]) {
    const res = await send(host, { headers });
    assert.equal(res.status, 401);
    assert.equal(res.json?.error, 'bad_token');
    assert.ok(!res.text.includes('Mi server'));
    assertSafeHeaders(res);
    if (host.info().rejected >= 4) break;
  }
  const denied = await send(host, { path: '/api/action', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"action":"start"}' });
  assert.ok([401, 429].includes(denied.status));
  assert.equal(backend.calls.length, 0);
});

test('con el token en el header entra y solo ve lo permitido', async (t) => {
  const { host, events } = open(t);
  await host.start();
  host.pushLine({ level: 'INFO', t: 5, text: '[12:00:00] Steve[/192.168.0.99:51234] logged in' });
  const res = await send(host, { headers: auth(host) });
  assert.equal(res.status, 200);
  assertSafeHeaders(res);
  assert.equal(res.json.server.name, 'Mi server');
  assert.deepEqual(res.json.players, [{ name: 'Steve', since: 1 }]);
  assert.ok(!res.text.includes('192.168.0.99'), 'sin IP de jugadores');
  assert.ok(!res.text.includes('secreto'));
  assert.ok(!res.text.includes('alguien'), 'sin rutas');
  assert.ok(!res.text.includes(tokenOf(host)), 'sin el token');
  assert.equal(res.json.lines.length, 1);
  assert.ok(res.json.lines[0].text.includes('Steve[/•••]'));
  assert.equal(host.info().clients.length, 1);
  assert.equal(host.info().clients[0].ip, IP);
  assert.ok(events.some((e) => e.kind === 'connected'));
});

test('el token en la URL no sirve: un pedido con query string se rechaza', async (t) => {
  const { host } = open(t);
  await host.start();
  for (const path of [`/api/state?token=${tokenOf(host)}`, `/api/state?t=${tokenOf(host)}`, `/?t=${tokenOf(host)}`, '/?x=1', '/api/state?']) {
    const res = await send(host, { path });
    assert.equal(res.status, 400, path);
    assert.ok(!res.text.includes('Mi server'));
    assertSafeHeaders(res);
  }
  assert.equal(host.info().rejected, 0, 'no cuenta como intento de token');
});

test('DNS rebinding: Host distinto del real se corta en todas las rutas', async (t) => {
  const { host } = open(t);
  await host.start();
  const { port } = host.info();
  for (const path of ['/', '/app.js', '/strings.json', '/api/state']) {
    for (const hostHeader of ['evil.example', `evil.example:${port}`, `localhost:${port}`, `${IP}:${port + 1}`, IP, `${IP}.evil.example:${port}`]) {
      const res = await send(host, { path, hostHeader, headers: auth(host) });
      assert.equal(res.status, 403, `${path} con ${hostHeader}`);
      assertSafeHeaders(res);
    }
    const none = await send(host, { path, setHost: false, headers: auth(host) });
    assert.ok([400, 403].includes(none.status), `${path} sin Host: ${none.status}`);
  }
  // El token bueno con un Host malo tampoco deja nada anotado como cliente
  assert.equal(host.info().clients.length, 0);
});

test('un pedido que viene de una IP pública se corta en todas las rutas, aun con el token', async (t) => {
  const { host, backend } = open(t, { peerAllowed: () => false });
  await host.start();
  for (const path of ['/', '/app.js', '/strings.json', '/api/state']) assert.equal((await send(host, { path, headers: auth(host) })).status, 403, path);
  assert.equal((await postJson(host, { action: 'start' })).status, 403);
  assert.equal(backend.calls.length, 0);
  assert.equal(host.info().clients.length, 0);
});

test('Host repetido: se rechaza', async (t) => {
  const { host } = open(t);
  await host.start();
  const { port } = host.info();
  const res = await new Promise((resolve, reject) => {
    const req = http.request({ host: IP, port, path: '/', method: 'GET', setHost: false, agent: false }, resolve);
    req.setHeader('Host', [`${IP}:${port}`, 'evil.example']);
    req.on('error', reject);
    req.end();
  });
  res.resume();
  assert.ok([400, 403].includes(res.statusCode), String(res.statusCode));
});

test('sin CORS: ni preflight ni otro Origin', async (t) => {
  const { host, backend } = open(t);
  await host.start();
  const pre = await send(host, { path: '/api/action', method: 'OPTIONS', headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': TOKEN_HEADER } });
  assert.ok([403, 405].includes(pre.status));
  assertSafeHeaders(pre);
  const same = await send(host, { path: '/api/action', method: 'OPTIONS', headers: { Origin: host.info().baseUrl } });
  assert.equal(same.status, 405);
  assertSafeHeaders(same);
  for (const origin of ['http://evil.example', 'null']) {
    const res = await postJson(host, { action: 'start' }, { Origin: origin });
    assert.equal(res.status, 403, origin);
  }
  const site = await postJson(host, { action: 'start' }, { 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(site.status, 403);
  assert.equal(backend.calls.length, 0);
  const ok = await postJson(host, { action: 'start' }, { Origin: host.info().baseUrl, 'Sec-Fetch-Site': 'same-origin' });
  assert.equal(ok.status, 200);
});

test('no-store y demás cabeceras también en la página y en los errores', async (t) => {
  const { host } = open(t);
  await host.start();
  for (const [path, status] of [['/', 200], ['/app.js', 200], ['/app.css', 200], ['/strings.json', 200], ['/nada', 404], ['/favicon.ico', 204]]) {
    const res = await send(host, { path });
    assert.equal(res.status, status, path);
    assertSafeHeaders(res);
  }
});

test('la página no trae secretos ni código en línea', async (t) => {
  const { host } = open(t);
  await host.start();
  const html = await send(host, { path: '/' });
  assert.match(html.headers['content-type'], /text\/html/);
  assert.ok(!html.text.includes(tokenOf(host)));
  assert.ok(!html.text.includes('Mi server'));
  assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html.text), 'sin scripts en línea');
  assert.ok(!/\son\w+=/i.test(html.text), 'sin manejadores en línea');
  assert.ok(!/<style/i.test(html.text));
  const js = await send(host, { path: '/app.js' });
  assert.ok(!js.text.includes('innerHTML'));
  assert.ok(!js.text.includes('eval('));
  // El token sale del fragmento y va solo en el header
  assert.ok(js.text.includes('X-Venus-Token'));
  assert.ok(js.text.includes('history.replaceState'));
  assert.ok(!/\/api\/[a-z]+\?/.test(js.text), 'sin query string');
  const strings = await send(host, { path: '/strings.json' });
  assert.equal(strings.json.page_start, 'Iniciar');
});

test('rutas: lista cerrada, nada se resuelve contra el disco', async (t) => {
  const { host } = open(t);
  await host.start();
  for (const path of ['/../package.json', '/..\\..\\secret', '/page/app.js', '/host.js', '/security.js', '/index.html', '/api', '/api/', '/api/state/', '/API/STATE']) {
    assert.equal((await send(host, { path, headers: auth(host) })).status, 404, path);
  }
  for (const path of ['/%2e%2e/package.json', '/app%2ejs', `/${'a'.repeat(200)}`]) assert.equal((await send(host, { path })).status, 400, path);
  assert.equal((await send(host, { path: '/api/state', method: 'POST', headers: auth(host) })).status, 405);
  assert.equal((await send(host, { path: '/api/action', method: 'GET', headers: auth(host) })).status, 405);
  assert.equal((await send(host, { path: '/', method: 'POST' })).status, 405);
  assert.equal((await send(host, { path: '/', method: 'DELETE' })).status, 405);
});

test('límite de intentos: token malo bloquea a esa IP, aun con el token bueno, y se libera', async (t) => {
  let clock = 1_000_000;
  const { host, backend } = open(t, { now: () => clock, limits: { perIp: { max: 3, windowMs: 60000, blockMs: 60000 } } });
  await host.start();
  for (let i = 0; i < 3; i++) assert.equal((await send(host, { headers: { [TOKEN_HEADER]: 'Z'.repeat(28) } })).status, 401);
  const blocked = await send(host, { headers: auth(host) });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers['retry-after'], '60');
  assert.equal(blocked.json.retryAfter, 60);
  assertSafeHeaders(blocked);
  assert.equal((await postJson(host, { action: 'start' })).status, 429);
  assert.equal(backend.calls.length, 0);
  assert.equal(host.info().rejected, 5);
  clock += 61000;
  assert.equal((await send(host, { headers: auth(host) })).status, 200);
});

test('bloqueo general: frena a los que no entraron, sin cortar a un dispositivo ya conectado', { skip: process.platform === 'darwin' }, async (t) => {
  const { host } = open(t, { limits: { perIp: { max: 100 }, global: { max: 3, windowMs: 60000, blockMs: 60000 } } });
  await host.start();
  // Un celular ya emparejado (127.0.0.3) y un atacante con otra IP (127.0.0.2)
  assert.equal((await send(host, { headers: auth(host), localAddress: '127.0.0.3' })).status, 200);
  for (let i = 0; i < 3; i++) assert.equal((await send(host, { headers: { [TOKEN_HEADER]: 'Z'.repeat(28) }, localAddress: '127.0.0.2' })).status, 401);
  assert.equal((await send(host, { headers: { [TOKEN_HEADER]: 'Z'.repeat(28) }, localAddress: '127.0.0.2' })).status, 429);
  assert.equal((await send(host, { headers: auth(host), localAddress: '127.0.0.4' })).status, 429, 'alguien nuevo espera');
  assert.equal((await send(host, { headers: auth(host), localAddress: '127.0.0.3' })).status, 200, 'el conectado sigue');
});

test('tope de tamaño: pedidos grandes no entran y no llegan a la acción', async (t) => {
  const { host, backend } = open(t);
  await host.start();
  const big = JSON.stringify({ action: 'command', command: 'x'.repeat(MAX_BODY), confirm: true });
  assert.equal((await send(host, { path: '/api/action', method: 'POST', headers: { ...auth(host), 'Content-Type': 'application/json' }, body: big })).status, 413);
  // Sin Content-Length, de a pedazos: se corta al pasar el tope
  const { port } = host.info();
  const chunked = await new Promise((resolve) => {
    const req = http.request({ host: IP, port, path: '/api/action', method: 'POST', setHost: false, agent: false, headers: { Host: `${IP}:${port}`, ...auth(host), 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve('cortado'));
    req.write('x'.repeat(MAX_BODY));
    req.write('x'.repeat(MAX_BODY));
    req.end();
  });
  assert.ok(chunked === 413 || chunked === 'cortado', String(chunked));
  // Encabezados gigantes los corta Node antes de llegar al código
  const huge = await send(host, { headers: { 'X-Relleno': 'x'.repeat(20000) } }).catch(() => ({ status: 'cortado' }));
  assert.ok(huge.status === 431 || huge.status === 'cortado', String(huge.status));
  assert.equal(backend.calls.length, 0);
});

test('acciones: solo la lista cerrada, con confirmación y con JSON', async (t) => {
  const { host, backend } = open(t);
  await host.start();
  const textPost = await send(host, { path: '/api/action', method: 'POST', headers: { ...auth(host), 'Content-Type': 'text/plain' }, body: '{"action":"start"}' });
  assert.equal(textPost.status, 415);
  const noType = await send(host, { path: '/api/action', method: 'POST', headers: auth(host), body: '{"action":"start"}' });
  assert.equal(noType.status, 415);
  for (const [body, code] of [
    [{ action: 'kill' }, 'unknown_action'],
    [{ action: 'delete' }, 'unknown_action'],
    [{ action: 'stop' }, 'confirm_required'],
    [{ action: 'restart' }, 'confirm_required'],
    [{ action: 'command', command: 'op alguien' }, 'confirm_required'],
    [{ action: 'command', command: 'a\nb', confirm: true }, 'bad_command'],
    [{ action: 'start', path: '/etc/passwd' }, 'bad_field'],
  ]) {
    const res = await postJson(host, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.json.error, code);
  }
  assert.equal(backend.calls.length, 0);
  assert.equal((await postJson(host, { action: 'start' })).status, 200);
  assert.equal((await postJson(host, { action: 'stop', confirm: true })).status, 200);
  assert.equal((await postJson(host, { action: 'restart', confirm: true })).status, 200);
  assert.equal((await postJson(host, { action: 'command', command: ' list ', confirm: true })).status, 200);
  assert.deepEqual(backend.calls.map((c) => [c.action, c.command]), [['start', undefined], ['stop', undefined], ['restart', undefined], ['command', 'list']]);
  assert.deepEqual(Object.keys(backend.calls[0]).sort(), ['action', 'device']);
});

test('errores del servidor: el código, sin el detalle', async (t) => {
  const { host, backend } = open(t);
  await host.start();
  backend.fail = Object.assign(new Error('detalle C:\\ruta'), { code: 'busy' });
  const busy = await postJson(host, { action: 'start' });
  assert.equal(busy.status, 409);
  assert.deepEqual(busy.json, { error: 'busy' });
  backend.fail = new Error('algo con C:\\Users\\alguien');
  const boom = await postJson(host, { action: 'start' });
  assert.equal(boom.status, 500);
  assert.deepEqual(boom.json, { error: 'failed' });
  assertSafeHeaders(boom);
});

test('consola: solo llegan las líneas nuevas, con tope', async (t) => {
  const { host } = open(t);
  await host.start();
  for (let i = 1; i <= 250; i++) host.pushLine({ level: 'INFO', t: i, text: `linea ${i}` });
  const first = await send(host, { headers: auth(host) });
  assert.equal(first.json.lines.length, 200);
  assert.equal(first.json.lines.at(-1).text, 'linea 250');
  assert.equal(first.json.seq, 250);
  host.pushLine({ level: 'WARN', t: 251, text: 'linea 251' });
  const next = await send(host, { headers: auth(host, { [AFTER_HEADER]: String(first.json.seq) }) });
  assert.deepEqual(next.json.lines.map((l) => l.text), ['linea 251']);
  const weird = await send(host, { headers: auth(host, { [AFTER_HEADER]: 'abc' }) });
  assert.equal(weird.json.lines.length, 200);
});

test('cortar a un dispositivo: no vuelve ni con el código nuevo y el código viejo deja de servir', { skip: process.platform === 'darwin' }, async (t) => {
  const { host } = open(t);
  await host.start();
  const oldToken = tokenOf(host);
  assert.equal((await send(host, { headers: { [TOKEN_HEADER]: oldToken }, localAddress: '127.0.0.2' })).status, 200);
  assert.equal((await send(host, { headers: { [TOKEN_HEADER]: oldToken } })).status, 200);
  assert.equal(host.info().clients.length, 2);
  assert.ok(host.kick('127.0.0.2'));
  assert.notEqual(tokenOf(host), oldToken);
  assert.equal(host.info().clients.length, 0);
  const cut = await send(host, { headers: auth(host), localAddress: '127.0.0.2' });
  assert.equal(cut.status, 403);
  assert.equal(cut.json.error, 'cut');
  // Otra IP con el código viejo: afuera. Con el nuevo: adentro.
  assert.equal((await send(host, { headers: { [TOKEN_HEADER]: oldToken } })).status, 401);
  assert.equal((await send(host, { headers: auth(host) })).status, 200);
  assert.equal(host.kick('10.9.9.9'), null, 'una IP que no está conectada no hace nada');
});

test('cambiar el código: el anterior deja de servir', async (t) => {
  const { host } = open(t);
  await host.start();
  const oldToken = tokenOf(host);
  assert.equal((await send(host, { headers: { [TOKEN_HEADER]: oldToken } })).status, 200);
  host.rotate();
  assert.equal((await send(host, { headers: { [TOKEN_HEADER]: oldToken } })).status, 401);
  assert.equal((await send(host, { headers: auth(host) })).status, 200);
});

test('vence solo: 12 h por defecto y al vencer no contesta más', async (t) => {
  assert.equal(TTL_MS, 12 * 3600 * 1000);
  const { host, events } = open(t, { ttlMs: 80 });
  await host.start();
  const { port } = host.info();
  assert.equal((await send(host, { headers: auth(host) })).status, 200);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(host.isStopped(), true);
  assert.deepEqual(events.find((e) => e.kind === 'stopped'), { kind: 'stopped', reason: 'expired' });
  await assert.rejects(
    new Promise((resolve, reject) => {
      const req = http.get({ host: IP, port, path: '/', agent: false }, resolve);
      req.on('error', reject);
    }),
  );
});

test('vencido por el reloj: contesta 410 y se apaga aunque el temporizador no haya saltado', async (t) => {
  let clock = 5000;
  const { host, events } = open(t, { ttlMs: 1000, now: () => clock });
  await host.start();
  assert.equal((await send(host, { headers: auth(host) })).status, 200);
  clock += 1000;
  assert.equal((await send(host, { headers: auth(host) })).status, 410);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(host.isStopped(), true);
  assert.ok(events.some((e) => e.kind === 'stopped' && e.reason === 'expired'));
});

test('apagar: corta conexiones, borra el token y no queda escuchando', async (t) => {
  const { host } = open(t);
  await host.start();
  const { port } = host.info();
  host.stop('stopped');
  host.stop('stopped');
  const off = host.info();
  assert.equal(off.on, false);
  assert.equal(off.url, '');
  assert.equal(off.code, '');
  assert.deepEqual(off.clients, []);
  await assert.rejects(
    new Promise((resolve, reject) => {
      const req = http.get({ host: IP, port, path: '/', agent: false }, resolve);
      req.on('error', reject);
    }),
  );
  assert.equal(host.rotate(), null);
});

test('una IP que no se puede usar rechaza al prender', async () => {
  const host = createRemoteHost({ ip: '203.0.113.1', backend: fakeBackend() });
  await assert.rejects(host.start());
});
