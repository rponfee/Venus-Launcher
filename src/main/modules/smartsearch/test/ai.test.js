'use strict';
// IA del Buscador inteligente: solo de pago, una sola fuente, con aviso y con respaldo al buscador normal.
//   node --test src/main/modules/smartsearch/test/ai.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../ai-source');

// ---------- Datos de prueba ----------
const paidStatus = (plan = 'go') => ({ provider: 'backend', enabled: true, signedIn: true, cloudConfigured: true, configured: true, quota: { status: 'active', plan, planName: plan.toUpperCase() } });
const noPlanStatus = { provider: 'backend', enabled: true, signedIn: true, cloudConfigured: true, configured: true, quota: { status: 'none', plan: null } };
const claudeReady = { claude: { installed: true, loggedIn: true, cli: 'claude' }, chatgpt: { installed: false, loggedIn: null } };
const codexReady = { claude: { installed: false }, chatgpt: { installed: true, loggedIn: true, cli: 'codex' } };
const none = { claude: { installed: false }, chatgpt: { installed: false } };
const consent = (...ids) => Object.fromEntries(ids.map((id) => [id, '2026-11-05T12:00:00.000Z']));

// ---------- Plan de la cuenta ----------

test('plan: pago, sin plan, sin sesion, sin comprobar y IA apagada en Ajustes', () => {
  assert.equal(A.planOf(paidStatus('pro')).state, 'paid');
  assert.equal(A.planOf(paidStatus('pro')).name, 'PRO');
  assert.equal(A.planOf(noPlanStatus).state, 'none');
  assert.equal(A.planOf({ ...noPlanStatus, quota: { status: 'active', plan: null } }).state, 'none');
  assert.equal(A.planOf({ ...paidStatus(), signedIn: false }).state, 'signedOut');
  assert.equal(A.planOf({ ...paidStatus(), cloudConfigured: false }).state, 'signedOut');
  assert.equal(A.planOf({ ...paidStatus(), quota: null }).state, 'unknown');
  assert.equal(A.planOf({ ...paidStatus(), enabled: false }).state, 'disabled');
  assert.equal(A.planOf(null).state, 'unknown');
  assert.equal(A.planOf(undefined).state, 'unknown');
});

// ---------- Solo de pago ----------

test('sin plan de pago la IA nunca esta activa, ni siquiera guardada como prendida con el aviso aceptado', () => {
  for (const status of [noPlanStatus, { ...paidStatus(), signedIn: false }, { ...paidStatus(), quota: null }, { ...paidStatus(), enabled: false }, null]) {
    const view = A.describe({ status, engines: claudeReady, entitled: true, prefs: { useAi: true, aiSource: 'venus', aiConsent: consent('venus', 'local') } });
    assert.equal(view.active, false);
    assert.equal(view.sources.some((s) => s.available), false, 'sin plan no hay ninguna fuente');
    assert.equal(view.choose, false);
    assert.equal(view.source, null);
  }
});

test('whyNot: cada motivo tiene su aviso', () => {
  const why = (status, prefs) => A.whyNot(A.describe({ status, engines: none, entitled: false, prefs }));
  assert.equal(why(noPlanStatus, {}), 'aiNoPlan');
  assert.equal(why({ ...paidStatus(), signedIn: false }, {}), 'aiSignedOut');
  assert.equal(why({ ...paidStatus(), quota: null }, {}), 'aiPlanUnknown');
  assert.equal(why({ ...paidStatus(), enabled: false }, {}), 'aiDisabled');
  assert.equal(why(paidStatus(), { useAi: true, aiConsent: consent('local'), aiSource: 'venus' }), 'aiNeedsConsent');
  assert.equal(why(paidStatus(), { useAi: true, aiConsent: consent('venus'), aiSource: 'venus' }), null);
  assert.equal(why(paidStatus(), {}), null);
});

test('encender la IA sin plan falla con noplan y no cambia nada', () => {
  const view = A.describe({ status: noPlanStatus, engines: none, entitled: false, prefs: {} });
  assert.throws(() => A.applyChange(view, {}, { useAi: true, consent: true }), { code: 'noplan' });
  assert.throws(() => A.applyChange(view, {}, { source: 'venus' }), { code: 'noplan' });
  assert.throws(() => A.applyChange(view, {}, { consent: true }), { code: 'noplan' });
});

// ---------- Aviso de privacidad ----------

test('la IA no se enciende sin aceptar el aviso de la fuente; al aceptarlo queda registrado con la hora', () => {
  const view = A.describe({ status: paidStatus(), engines: none, entitled: false, prefs: {} });
  assert.equal(view.plan, 'paid');
  assert.equal(view.source, 'venus');
  assert.equal(view.active, false);
  assert.throws(() => A.applyChange(view, {}, { useAi: true }), { code: 'consent' });
  const on = A.applyChange(view, {}, { useAi: true, consent: true }, '2026-11-05T15:00:00.000Z');
  assert.equal(on.useAi, true);
  assert.equal(on.aiConsent.venus, '2026-11-05T15:00:00.000Z');
  assert.equal(on.aiConsent.local, null);
  const again = A.describe({ status: paidStatus(), engines: none, entitled: false, prefs: on });
  assert.equal(again.active, true);
  // ya aceptado: se puede apagar y prender sin volver a preguntar
  const off = A.applyChange(again, on, { useAi: false });
  assert.equal(off.useAi, false);
  assert.equal(off.aiConsent.venus, '2026-11-05T15:00:00.000Z');
  assert.equal(A.applyChange(A.describe({ status: paidStatus(), engines: none, entitled: false, prefs: off }), off, { useAi: true }).useAi, true);
});

test('versiones anteriores guardaban useAi: true sin avisar: ahora cuenta como apagada hasta aceptar el aviso', () => {
  const view = A.describe({ status: paidStatus(), engines: none, entitled: false, prefs: { perType: 5, compatibleOnly: true, useAi: true } });
  assert.equal(view.wants, false);
  assert.equal(view.active, false);
  assert.equal(view.needsConsent, false);
});

// ---------- Una sola fuente ----------

test('con plan y una app local usable hay dos fuentes y se elige una sola; nunca las dos a la vez', () => {
  const base = { status: paidStatus('go'), engines: claudeReady, entitled: true };
  const view = A.describe({ ...base, prefs: {} });
  assert.deepEqual(view.sources.map((s) => [s.id, s.available]), [['venus', true], ['local', true]]);
  assert.equal(view.choose, true);
  assert.equal(view.source, 'venus');
  assert.equal(view.sources[1].app, 'Claude Code');
  // por cualquier combinacion de preferencias hay UNA sola fuente elegida y activa
  for (const aiSource of [null, 'venus', 'local', 'otra']) {
    for (const useAi of [false, true]) {
      for (const c of [consent(), consent('venus'), consent('local'), consent('venus', 'local')]) {
        const v = A.describe({ ...base, prefs: { useAi, aiSource, aiConsent: c } });
        assert.ok(v.source === null || ['venus', 'local'].includes(v.source));
        assert.equal(typeof v.source, v.source === null ? 'object' : 'string', 'una sola fuente, no una lista');
        const activeSources = v.sources.filter((s) => s.available && s.id === v.source && v.active);
        assert.ok(activeSources.length <= 1);
      }
    }
  }
});

test('elegir la fuente local: se usa esa y no la otra; sin su aviso aceptado la IA queda apagada', () => {
  const base = { status: paidStatus('go'), engines: claudeReady, entitled: true };
  const withVenus = A.describe({ ...base, prefs: { useAi: true, aiSource: 'venus', aiConsent: consent('venus') } });
  assert.equal(withVenus.active, true);
  assert.equal(withVenus.source, 'venus');
  // cambia a la local sin haber aceptado su aviso: apaga la IA hasta aceptarlo
  const prefs1 = A.applyChange(withVenus, { useAi: true, aiSource: 'venus', aiConsent: consent('venus') }, { source: 'local' });
  assert.equal(prefs1.aiSource, 'local');
  assert.equal(prefs1.useAi, false);
  const view1 = A.describe({ ...base, prefs: prefs1 });
  assert.equal(view1.source, 'local');
  assert.equal(view1.active, false);
  // cambia aceptando el aviso de la otra fuente en el mismo paso
  const prefs2 = A.applyChange(withVenus, { useAi: true, aiSource: 'venus', aiConsent: consent('venus') }, { source: 'local', useAi: true, consent: true }, '2026-11-05T16:00:00.000Z');
  const view2 = A.describe({ ...base, prefs: prefs2 });
  assert.equal(view2.source, 'local');
  assert.equal(view2.active, true);
  assert.equal(view2.consent.local, true);
  assert.equal(view2.consent.venus, true);
});

test('la fuente local solo se ofrece con plan Go o superior y con la app instalada y con sesion', () => {
  const local = (o) => A.describe({ prefs: {}, ...o }).sources.find((s) => s.id === 'local');
  assert.equal(local({ status: paidStatus('go'), engines: claudeReady, entitled: true }).available, true);
  assert.equal(local({ status: paidStatus('basic'), engines: claudeReady, entitled: false }).available, false, 'plan Basic: solo Venus IA');
  assert.equal(local({ status: paidStatus('go'), engines: none, entitled: true }).available, false);
  assert.equal(local({ status: paidStatus('go'), engines: { claude: { installed: true, loggedIn: false } }, entitled: true }).available, false, 'sin sesion en la app');
  assert.equal(local({ status: paidStatus('go'), engines: codexReady, entitled: true }).app, 'Codex');
  assert.equal(local({ status: paidStatus('go'), engines: claudeReady, entitled: false }).installed, true);
  const venusOnly = A.describe({ status: paidStatus('basic'), engines: claudeReady, entitled: false, prefs: {} });
  assert.equal(venusOnly.choose, false);
  assert.equal(venusOnly.source, 'venus');
  assert.throws(() => A.applyChange(venusOnly, {}, { source: 'local' }), { code: 'sourceUnavailable' });
  assert.throws(() => A.applyChange(venusOnly, {}, { source: 'otra' }), { code: 'badSource' });
});

test('motor local: se prefiere el elegido en Ajustes y, si no sirve, el primero que este listo', () => {
  const both = { claude: { installed: true, loggedIn: true }, chatgpt: { installed: true, loggedIn: true } };
  assert.equal(A.pickEngine(both, 'chatgpt').engine, 'chatgpt');
  assert.equal(A.pickEngine(both, undefined).engine, 'claude');
  assert.equal(A.pickEngine({ claude: { installed: true, loggedIn: false }, chatgpt: { installed: true, loggedIn: null } }, 'claude').engine, 'chatgpt');
  assert.equal(A.pickEngine(none, 'claude'), null);
  assert.equal(A.pickEngine(null, 'claude'), null);
});

test('si la fuente guardada deja de estar disponible (cambio de plan) se vuelve a Venus IA sin romper nada', () => {
  const prefs = { useAi: true, aiSource: 'local', aiConsent: consent('venus', 'local') };
  const view = A.describe({ status: paidStatus('basic'), engines: claudeReady, entitled: false, prefs });
  assert.equal(view.source, 'venus');
  assert.equal(view.active, true);
});

// ---------- IA local: Claude Code / Codex sin herramientas ----------

const localAi = require('../local-ai');
const FAKE = path.join(__dirname, 'fixtures', 'fake-search-cli.js');
const SCHEMA = { type: 'object' };

async function runLocal(engine, scenario, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venus-ss-'));
  const argsFile = path.join(dir, 'args.json');
  process.env.VENUS_FAKE_SEARCH = scenario;
  process.env.VENUS_FAKE_SEARCH_FILE = argsFile;
  try {
    const value = await localAi.json({ engine, system: 'Eres un planificador.', prompt: 'mods de zombies', schema: SCHEMA, cli: process.execPath, prefixArgs: [FAKE], cwd: path.join(dir, 'w'), timeoutMs: 8000, ...extra });
    return { value, saved: JSON.parse(fs.readFileSync(argsFile, 'utf8')), dir };
  } catch (err) {
    err.saved = fs.existsSync(argsFile) ? JSON.parse(fs.readFileSync(argsFile, 'utf8')) : null;
    throw err;
  } finally {
    delete process.env.VENUS_FAKE_SEARCH;
    delete process.env.VENUS_FAKE_SEARCH_FILE;
  }
}

test('IA local con Claude Code: devuelve el JSON aunque venga entre cercos y no le da ninguna herramienta', async () => {
  const { value, saved, dir } = await runLocal('claude', 'claude-ok');
  assert.equal(value.mcVersion, '1.20.1');
  assert.deepEqual(value.types, ['mod', 'shader']);
  const args = saved.args;
  assert.deepEqual(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2), ['--tools', '']);
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(!args.includes('--mcp-config'), 'sin servidores MCP: no puede tocar el launcher');
  assert.ok(!args.includes('--allowedTools'));
  assert.deepEqual(args.slice(args.indexOf('--setting-sources'), args.indexOf('--setting-sources') + 2), ['--setting-sources', '']);
  assert.equal(args[args.indexOf('--max-turns') + 1], '1');
  assert.match(saved.prompt, /mods de zombies/);
  assert.match(saved.prompt, /JSON Schema/);
  // el prompt de sistema va en un archivo propio dentro de la carpeta de trabajo
  assert.ok(fs.existsSync(path.join(dir, 'w', '.venus-search-system.md')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('IA local con Codex: caja de arena de solo lectura, sin shell y el pedido por stdin', async () => {
  const { value, saved, dir } = await runLocal('chatgpt', 'codex-ok');
  assert.equal(value.loader, 'fabric');
  const args = saved.args;
  assert.equal(args[0], 'exec');
  assert.deepEqual(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2), ['--sandbox', 'read-only']);
  assert.ok(args.includes('--ignore-user-config'));
  assert.ok(args.filter((a) => a === '--disable').length === 2);
  assert.ok(!args.some((a) => /mcp_servers/.test(a)));
  assert.match(saved.prompt, /Eres un planificador/);
  assert.match(saved.prompt, /mods de zombies/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('IA local: errores con su codigo (sin sesion, limite, respuesta ilegible, tiempo)', async () => {
  await assert.rejects(runLocal('claude', 'claude-login'), { code: 'engineLogin' });
  await assert.rejects(runLocal('claude', 'claude-limit'), { code: 'engineLimit' });
  await assert.rejects(runLocal('claude', 'bad-json'), { code: 'parse' });
  await assert.rejects(runLocal('claude', 'hang', { timeoutMs: 700 }), { code: 'engineTimeout' });
  await assert.rejects(localAi.json({ engine: 'otro', prompt: 'x', schema: SCHEMA }), { code: 'engine' });
  await assert.rejects(localAi.json({ engine: 'claude', prompt: 'x', schema: SCHEMA, cli: path.join(os.tmpdir(), 'no-existe-venus-cli'), cwd: path.join(os.tmpdir(), 'venus-ss-x') }), { code: 'engineMissing' });
});

test('IA local: cancelar corta el proceso', async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  await assert.rejects(runLocal('claude', 'hang', { signal: controller.signal, timeoutMs: 8000 }), { code: 'cancelled' });
});

test('IA local: parseObject saca el objeto de cercos y textos alrededor', () => {
  assert.deepEqual(localAi.parseObject('hola ```json\n{"a":1}\n``` chau'), { a: 1 });
  assert.equal(localAi.parseObject('sin json'), null);
  assert.equal(localAi.parseObject('[1,2]'), null);
  assert.equal(localAi.parseObject('{roto'), null);
});

// ---------- Todo junto en el proceso principal (con dobles de Venus IA y de la PC) ----------

function loadSmartsearch({ status, engines = none, json, prefs = {} }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'venus-ss-main-'));
  const paths = require('../../../core/paths');
  paths.setRoot(root);
  fs.writeFileSync(path.join(root, 'data', 'settings.json'), JSON.stringify({ language: 'es', smartsearch: { prefs } }));
  delete require.cache[require.resolve('../../../core/settings')];
  const settings = require('../../../core/settings');
  // los modulos con red se reemplazan: nada sale de la PC
  const aiPath = require.resolve('../../ai');
  const enginesPath = require.resolve('../cli');
  const calls = { ai: 0, json: [] };
  require.cache[aiPath] = { id: aiPath, filename: aiPath, loaded: true, exports: { status: async () => (status instanceof Error ? Promise.reject(status) : status), json: async (o) => { calls.ai++; calls.json.push(o); return json(o); } } };
  const realEngines = require(enginesPath);
  const originalCached = realEngines.cached;
  const originalStale = realEngines.stale;
  realEngines.cached = () => engines;
  realEngines.stale = () => false;
  delete require.cache[require.resolve('../../smartsearch')];
  const smartsearch = require('../../smartsearch');
  return { smartsearch, settings, calls, restore: () => { realEngines.cached = originalCached; realEngines.stale = originalStale; delete require.cache[aiPath]; fs.rmSync(root, { recursive: true, force: true }); } };
}

const aiPlanJson = () => ({ types: ['mod'], mcVersion: '1.20.1', loader: 'fabric', mode: 'singleplayer', themes: ['zombie apocalypse'], hardware: 'normal', searches: [{ type: 'mod', query: 'zombie', categories: ['mobs'], weight: 1 }], summary: 'Kit' });

test('buscar con la IA pedida pero sin plan de pago: usa el buscador normal, avisa y no manda nada', async () => {
  const env = loadSmartsearch({ status: noPlanStatus, json: aiPlanJson, prefs: { useAi: true, aiSource: 'venus', aiConsent: consent('venus') } });
  try {
    const warnings = [];
    const { plan } = await env.smartsearch._makePlan('mods de zombies', { useAi: true }, { warnings });
    assert.equal(plan.source, 'local');
    assert.deepEqual(warnings.map((w) => w.key), ['aiNoPlan']);
    assert.equal(env.calls.ai, 0, 'sin plan no se llama a la IA');
  } finally {
    env.restore();
  }
});

test('con plan pero sin aceptar el aviso: no se manda lo que escribe', async () => {
  const env = loadSmartsearch({ status: paidStatus(), json: aiPlanJson, prefs: { useAi: true, aiSource: 'venus', aiConsent: {} } });
  try {
    const warnings = [];
    const { plan } = await env.smartsearch._makePlan('mods de zombies', { useAi: true }, { warnings });
    assert.equal(plan.source, 'local');
    assert.equal(env.calls.ai, 0);
    assert.deepEqual(warnings, []);
  } finally {
    env.restore();
  }
});

test('con plan y aviso aceptado: usa Venus IA y solo manda el pedido y el contexto de busqueda', async () => {
  const env = loadSmartsearch({ status: paidStatus(), json: aiPlanJson, prefs: { useAi: true, aiSource: 'venus', aiConsent: consent('venus') } });
  try {
    const warnings = [];
    const { plan } = await env.smartsearch._makePlan('mods de zombies', { useAi: true, instanceId: null }, { warnings });
    assert.equal(plan.source, 'ai');
    assert.equal(plan.aiVia, 'venus');
    assert.equal(env.calls.ai, 1);
    const sent = env.calls.json[0].prompt;
    assert.match(sent, /mods de zombies/);
    assert.doesNotMatch(sent, /access_token|sb-|email|\\Users\\/i);
    assert.deepEqual(warnings, []);
  } finally {
    env.restore();
  }
});

test('sin conexion con la IA: el buscador normal responde igual y avisa', async () => {
  const offline = () => { throw Object.assign(new Error('fetch failed'), { code: 'network' }); };
  const env = loadSmartsearch({ status: paidStatus(), json: offline, prefs: { useAi: true, aiSource: 'venus', aiConsent: consent('venus') } });
  try {
    const warnings = [];
    const { plan } = await env.smartsearch._makePlan('mods de zombies', { useAi: true }, { warnings });
    assert.equal(plan.source, 'local');
    assert.ok(plan.types.length);
    assert.deepEqual(warnings.map((w) => w.key), ['aiOffline']);
  } finally {
    env.restore();
  }
});

test('plan de la cuenta imposible de comprobar (sin red): IA apagada y buscador normal', async () => {
  const env = loadSmartsearch({ status: new Error('network'), json: aiPlanJson, prefs: { useAi: true, aiSource: 'venus', aiConsent: consent('venus') } });
  try {
    const warnings = [];
    const { plan } = await env.smartsearch._makePlan('mods de zombies', { useAi: true }, { warnings });
    assert.equal(plan.source, 'local');
    assert.deepEqual(warnings.map((w) => w.key), ['aiPlanUnknown']);
    assert.equal(env.calls.ai, 0);
  } finally {
    env.restore();
  }
});

test('con dos fuentes se usa solo la elegida: la local no llama a Venus IA', async () => {
  // el CLI no existe: nunca se lanza el Claude Code real de esta PC desde una prueba
  const missing = { claude: { installed: true, loggedIn: true, cli: path.join(os.tmpdir(), 'venus-no-such-cli') }, chatgpt: { installed: false } };
  const env = loadSmartsearch({ status: paidStatus('go'), engines: missing, json: aiPlanJson, prefs: { useAi: true, aiSource: 'local', aiConsent: consent('venus', 'local') } });
  try {
    const view = await env.smartsearch.aiView();
    assert.equal(view.source, 'local');
    assert.equal(view.active, true);
    assert.equal(view.choose, true);
    // La IA local lanza el CLI real: aca se comprueba que NO se llamo a Venus IA aunque fallo (no hay CLI de prueba)
    const warnings = [];
    const { plan } = await env.smartsearch._makePlan('mods de zombies', { useAi: true }, { warnings });
    assert.equal(env.calls.ai, 0, 'con la fuente local no se toca Venus IA');
    assert.equal(plan.source, 'local');
    assert.equal(warnings.length, 1);
  } finally {
    env.restore();
  }
});
