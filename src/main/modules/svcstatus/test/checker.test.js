'use strict';
// Pruebas de la ronda de consultas: caché, una sola ronda a la vez, modo sin conexión y la prueba de conexión.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createChecker } = require('../checker');
const { buildDefs } = require('../services');
const { createFakeFetch } = require('../fake');
const { fakeClock, fakeFetch, gate, CLOUD } = require('./helpers');

function setup(rules = {}, { key = 'cf-secret', offline = false, clock = fakeClock(), gateOn = null, timeoutMs = 40 } = {}) {
  const fetch = fakeFetch(rules, clock, { gate: gateOn });
  const checker = createChecker({
    fetch,
    now: clock.now,
    isOffline: async () => offline,
    defs: () => buildDefs({ curseforgeApiKey: key, cloud: CLOUD, userAgent: 'VenusLauncher/test' }),
    timeoutMs,
  });
  return { fetch, checker, clock };
}

const state = (summary, id) => summary.results.find((r) => r.id === id)?.state;

test('todo responde: veredicto ok, con conexión y en el orden del catálogo', async () => {
  const { checker, fetch } = setup({ '*': 200 });
  const s = await checker.check();
  assert.equal(s.offlineMode, false);
  assert.equal(s.internet, 'ok');
  assert.equal(s.dns, 'ok');
  assert.deepEqual(s.verdict, { kind: 'ok', ids: [] });
  assert.deepEqual(s.results.map((r) => r.id), ['internet', 'microsoft', 'xbox', 'minecraftServices', 'mojangMeta', 'mojangLibraries', 'mojangAssets', 'modrinth', 'curseforge', 'venus']);
  assert.ok(s.results.every((r) => r.state === 'ok'));
  assert.equal(fetch.calls.length, 11); // la conexión son dos pedidos (por nombre y por IP)
  assert.equal(typeof s.checkedAt, 'number');
  assert.equal(s.nextCheckAt, s.checkedAt + 20000);
});

test('modo sin conexión: no se consulta nada', async () => {
  const { checker, fetch } = setup({ '*': 200 }, { offline: true });
  const s = await checker.check();
  assert.equal(fetch.calls.length, 0);
  assert.equal(s.offlineMode, true);
  assert.equal(s.verdict.kind, 'offline');
  assert.ok(s.results.every((r) => r.state === 'skipped' && r.reason === 'offline'));
});

test('la key de CurseForge viaja solo en el pedido a api.curseforge.com', async () => {
  const { checker, fetch } = setup({ '*': 200 });
  await checker.check();
  for (const c of fetch.calls) {
    const headers = Object.keys(c.init.headers).map((h) => h.toLowerCase());
    if (c.host === 'api.curseforge.com') assert.deepEqual(c.init.headers['x-api-key'], 'cf-secret');
    else assert.ok(!headers.includes('x-api-key'), c.host);
    if (!c.host.endsWith('.supabase.co')) assert.ok(!headers.includes('apikey'), c.host);
    assert.ok(!headers.includes('cookie') && !headers.includes('authorization'), c.host);
  }
});

test('sin key, CurseForge queda "skipped" y no se consulta', async () => {
  const { checker, fetch } = setup({ '*': 200 }, { key: '' });
  const s = await checker.check();
  assert.equal(state(s, 'curseforge'), 'skipped');
  assert.equal(fetch.count('api.curseforge.com'), 0);
  assert.equal(s.verdict.kind, 'ok');
});

test('caché: lo de menos de 20 s se reusa; después se vuelve a consultar', async () => {
  const { checker, fetch, clock } = setup({ '*': 200 });
  await checker.check({ ids: ['modrinth'] });
  assert.equal(fetch.count('api.modrinth.com'), 1);
  clock.advance(10000);
  const again = await checker.check({ ids: ['modrinth'] });
  assert.equal(again.cached, true);
  assert.equal(fetch.count('api.modrinth.com'), 1);
  // El panel completo reusa Modrinth y consulta solo lo que falta
  await checker.check();
  assert.equal(fetch.count('api.modrinth.com'), 1);
  assert.equal(fetch.count('login.live.com'), 1);
  clock.advance(20001);
  const later = await checker.check({ ids: ['modrinth'] });
  assert.equal(later.cached, false);
  assert.equal(fetch.count('api.modrinth.com'), 2);
});

test('nunca dos rondas a la vez: los pedidos simultáneos esperan y reusan', async () => {
  const g = gate();
  const { checker, fetch } = setup({ '*': 200 }, { gateOn: g });
  const a = checker.check({ ids: ['modrinth'] });
  const b = checker.check({ ids: ['modrinth'] });
  const c = checker.check({ ids: ['xbox'] });
  await new Promise((r) => setImmediate(r));
  // Mientras la primera ronda está colgada, nadie más empezó a consultar
  assert.deepEqual(fetch.calls.map((x) => x.host).sort(), ['1.1.1.1', 'api.modrinth.com', 'www.cloudflare.com']);
  g.open();
  const [sa, sb, sc] = await Promise.all([a, b, c]);
  assert.equal(fetch.count('api.modrinth.com'), 1);
  assert.equal(sb.cached, true);
  assert.equal(state(sa, 'modrinth'), 'ok');
  assert.equal(state(sc, 'xbox'), 'ok');
  // Xbox empezó recién cuando terminó la ronda de Modrinth
  const ev = fetch.events;
  assert.ok(ev.indexOf('start user.auth.xboxlive.com') > ev.indexOf('end api.modrinth.com'));
  assert.equal(fetch.count('www.cloudflare.com'), 1);
});

test('después de un error ("auto"): si un servicio contestó, no se consulta a Cloudflare', async () => {
  const { checker, fetch } = setup({ 'login.live.com': 503, '*': 200 });
  const s = await checker.check({ ids: ['microsoft', 'xbox', 'minecraftServices'], connectivity: 'auto' });
  assert.equal(fetch.count('www.cloudflare.com') + fetch.count('1.1.1.1'), 0);
  assert.equal(s.internet, 'ok'); // alguien contestó: internet anda
  assert.deepEqual(s.verdict, { kind: 'down', ids: ['microsoft'] });
  assert.deepEqual(s.results.map((r) => r.id), ['microsoft', 'xbox', 'minecraftServices']);
});

test('después de un error ("auto"): si nadie contestó, se prueba la conexión', async () => {
  const { checker, fetch } = setup({ '*': { error: 'EAI_AGAIN' }, '1.1.1.1': { error: 'ENETUNREACH' } });
  const s = await checker.check({ ids: ['microsoft', 'xbox', 'minecraftServices'], connectivity: 'auto' });
  assert.equal(fetch.count('www.cloudflare.com'), 1);
  assert.equal(s.internet, 'down');
  assert.equal(s.verdict.kind, 'internet');
  // Microsoft caído de verdad: los servicios no contestan pero internet sí
  const other = setup({ 'www.cloudflare.com': 200, '1.1.1.1': 200, '*': 'timeout' });
  const s2 = await other.checker.check({ ids: ['microsoft', 'xbox', 'minecraftServices'], connectivity: 'auto' });
  assert.equal(s2.internet, 'ok');
  assert.deepEqual(s2.verdict, { kind: 'down', ids: ['microsoft', 'xbox', 'minecraftServices'] });
});

test('veredictos de punta a punta: DNS, antivirus/proxy (TLS), red bloqueada y lentitud', async () => {
  let s = await setup({ '*': { error: 'ENOTFOUND' }, '1.1.1.1': 200 }).checker.check();
  assert.equal(s.internet, 'ok');
  assert.equal(s.dns, 'down');
  assert.equal(s.verdict.kind, 'dns');

  s = await setup({ '*': { error: 'SELF_SIGNED_CERT_IN_CHAIN' } }).checker.check();
  assert.equal(s.internet, 'down');
  assert.equal(s.verdict.kind, 'tls');

  s = await setup({ 'www.cloudflare.com': 200, '1.1.1.1': 200, '*': 'timeout' }).checker.check();
  assert.equal(s.verdict.kind, 'blocked');

  s = await setup({ 'piston-meta.mojang.com': 503, 'libraries.minecraft.net': 'timeout', '*': 200 }).checker.check();
  assert.deepEqual(s.verdict, { kind: 'down', ids: ['mojangMeta', 'mojangLibraries'] });

  s = await setup({ 'api.modrinth.com': { status: 200, delay: 3000 }, '*': 200 }).checker.check({ ids: ['modrinth'], connectivity: 'auto' });
  assert.equal(state(s, 'modrinth'), 'slow');
  assert.deepEqual(s.verdict, { kind: 'slow', ids: ['modrinth'] });
});

test('Cloudflare bloqueado o caído no culpa a tu internet si los servicios contestan', async () => {
  // Bloqueado en esa red (por nombre y por IP): la conexión se deduce de los demás
  let s = await setup({ 'www.cloudflare.com': 'timeout', '1.1.1.1': 'timeout', '*': 200 }).checker.check();
  assert.equal(s.internet, 'ok');
  assert.equal(s.internetReason, null);
  assert.deepEqual(s.verdict, { kind: 'ok', ids: [] });
  const inet = s.results.find((r) => r.id === 'internet');
  assert.equal(inet.state, 'ok');
  assert.equal(inet.inferred, true);
  assert.equal(inet.ms, null);

  // Cloudflare contesta con 5xx (caída de Cloudflare): contestó, así que internet anda
  s = await setup({ 'www.cloudflare.com': 500, '1.1.1.1': 'timeout', '*': 200 }).checker.check();
  assert.equal(s.internet, 'ok');
  assert.equal(state(s, 'internet'), 'ok');
  assert.equal(s.results.find((r) => r.id === 'internet').httpStatus, 500);
  assert.deepEqual(s.verdict, { kind: 'ok', ids: [] });

  // Cloudflare con 5xx y Mojang con 503: es Mojang, no tu conexión
  s = await setup({ 'www.cloudflare.com': 500, '1.1.1.1': 500, 'piston-meta.mojang.com': 503, '*': 200 }).checker.check();
  assert.deepEqual(s.verdict, { kind: 'down', ids: ['mojangMeta'] });

  // Después de un error al iniciar sesión: Microsoft no contesta y Cloudflare da 5xx -> Microsoft caído
  s = await setup({ 'www.cloudflare.com': 502, '1.1.1.1': 502, '*': 'timeout' }).checker.check({ ids: ['microsoft', 'xbox', 'minecraftServices'], connectivity: 'auto' });
  assert.equal(s.internet, 'ok');
  assert.deepEqual(s.verdict, { kind: 'down', ids: ['microsoft', 'xbox', 'minecraftServices'] });

  // Sin ninguna respuesta de nadie sigue siendo tu conexión
  s = await setup({ '*': 'timeout' }).checker.check();
  assert.equal(s.internet, 'down');
  assert.equal(s.verdict.kind, 'internet');
});

test('la conexión deducida es una copia: lo guardado de Cloudflare no cambia', async () => {
  const rules = { 'www.cloudflare.com': 'timeout', '1.1.1.1': 'timeout', '*': 200 };
  const { checker } = setup(rules);
  const first = await checker.check({ ids: ['modrinth'] });
  assert.equal(first.results.find((r) => r.id === 'internet').inferred, true);
  // Ahora Xbox tampoco contesta y no hay otra respuesta en el pedido: la prueba de Cloudflare guardada (fresca)
  // tiene que seguir diciendo que no contestó.
  rules['user.auth.xboxlive.com'] = 'timeout';
  const second = await checker.check({ ids: ['xbox'], connectivity: 'auto' });
  assert.equal(second.internet, 'down');
  assert.equal(second.verdict.kind, 'internet');
});

test('failed: lo que el launcher vio fallar de su lado no queda como "responde" (y lo guardado no cambia)', async () => {
  const { checker, fetch } = setup({ '*': 200 });
  // Modrinth contesta bien a la consulta, pero una descarga acaba de recibir un 503 de su CDN
  let s = await checker.check({ failed: ['modrinth'] });
  const mr = s.results.find((r) => r.id === 'modrinth');
  assert.deepEqual([mr.state, mr.reason, mr.detail], ['down', 'failed', null]);
  assert.equal(s.internet, 'ok');
  assert.deepEqual(s.verdict, { kind: 'down', ids: ['modrinth'] });
  // Sin la evidencia (otra llamada, con lo guardado): vuelve a "responde" sin consultar de nuevo
  s = await checker.check({ ids: ['modrinth'] });
  assert.equal(state(s, 'modrinth'), 'ok');
  assert.equal(s.cached, true);
  assert.equal(fetch.count('api.modrinth.com'), 1);
  // Ids desconocidos, la conexión o basura no hacen nada
  s = await checker.check({ failed: ['internet', 'nada', 42, null] });
  assert.equal(s.verdict.kind, 'ok');
  assert.equal(state(s, 'internet'), 'ok');
  // Si la consulta ya da caído (sin respuesta), se respeta su motivo
  const other = setup({ 'login.live.com': 'timeout', '*': 200 });
  s = await other.checker.check({ ids: ['microsoft'], connectivity: 'auto', failed: ['microsoft'] });
  const ms = s.results.find((r) => r.id === 'microsoft');
  assert.deepEqual([ms.state, ms.reason], ['down', 'timeout']);
  // En modo sin conexión no hay nada que marcar
  s = await setup({ '*': 200 }, { offline: true }).checker.check({ failed: ['modrinth'] });
  assert.equal(s.verdict.kind, 'offline');
});

test('"muy lenta" es tu conexión solo si ningún servicio contestó rápido', async () => {
  // Reloj real con demoras cortas: cada pedido mide su propia demora.
  const slowFetch = (slowHosts) => (url, init = {}) =>
    new Promise((resolve, reject) => {
      const host = new URL(url).host;
      const timer = setTimeout(() => resolve({ status: 200, ok: true, body: null }), slowHosts.includes(host) || slowHosts.includes('*') ? 150 : 0);
      init.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(init.signal.reason);
      });
    });
  const make = (hosts) => createChecker({ fetch: slowFetch(hosts), isOffline: async () => false, defs: () => buildDefs({ curseforgeApiKey: '', cloud: CLOUD }), timeoutMs: 2000, slowMs: 60 });
  // Solo Cloudflare tarda: los servicios contestaron rápido, la conexión anda bien
  let s = await make(['www.cloudflare.com', '1.1.1.1']).check();
  assert.equal(state(s, 'internet'), 'slow');
  assert.equal(s.internetSlow, false);
  assert.deepEqual(s.verdict, { kind: 'ok', ids: [] });
  // Todo tarda: es tu conexión
  s = await make(['*']).check();
  assert.equal(s.internetSlow, true);
  assert.equal(s.verdict.kind, 'internetSlow');
});

test('el veredicto mira solo los servicios pedidos', async () => {
  const { checker } = setup({ 'api.modrinth.com': 503, '*': 200 });
  await checker.check(); // Modrinth caído en la ronda completa
  const login = await checker.check({ ids: ['microsoft', 'xbox', 'minecraftServices'], connectivity: 'auto' });
  assert.deepEqual(login.verdict, { kind: 'ok', ids: [] });
});

test('fetch simulado de las capturas: cada escenario da su veredicto sin red', async () => {
  const run = async (scenario) => {
    // Demoras del fetch simulado: 70 a 300 ms por host; "timeout" no contesta nunca.
    const checker = createChecker({
      fetch: createFakeFetch(scenario),
      isOffline: async () => false,
      defs: () => buildDefs({ curseforgeApiKey: 'k', cloud: CLOUD }),
      timeoutMs: 400,
      slowMs: 1000,
    });
    return (await checker.check()).verdict;
  };
  assert.equal((await run('ok')).kind, 'ok');
  assert.equal((await run('internet')).kind, 'internet');
  assert.equal((await run('dns')).kind, 'dns');
  assert.equal((await run('tls')).kind, 'tls');
  assert.deepEqual(await run('microsoft'), { kind: 'down', ids: ['microsoft', 'xbox'] });
  assert.deepEqual(await run('modrinth'), { kind: 'down', ids: ['modrinth'] });
  assert.deepEqual(await run('venus'), { kind: 'down', ids: ['venus'] });
  assert.equal((await run('blocked')).kind, 'blocked');
  assert.deepEqual(await run('cloudflare'), { kind: 'ok', ids: [] });
});
