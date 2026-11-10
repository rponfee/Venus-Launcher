'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ui, loadRenderer, turn, deferred } = require('../../../features/clipstudio/test/ui-harness');

const ROOT = path.resolve(__dirname, '../../../../../..');
const readDict = file => {
  const ctx = { module: { exports: {} } };
  vm.runInNewContext(fs.readFileSync(file, 'utf8').replace(/^export default/m, 'module.exports ='), ctx);
  return ctx.module.exports;
};
const strings = readDict(path.join(ROOT, 'src/renderer/i18n/es/admin.js'));
const T = (key, vars = {}) => {
  assert.equal(typeof strings[key], 'string', 'Falta admin.' + key);
  return strings[key].replace(/\{(\w+)\}/g, (match, k) => vars[k] ?? match);
};
const result = (configured = false, hint = '') => ({ data: { configured, hint }, error: null });
const button = (root, key) => root.querySelectorAll('button').find(el => el.textContent.includes(T(key)));

async function rig(rpc = async () => result(), invoke = async () => ({ data: { data: [] }, error: null })) {
  const dom = ui(), calls = [], checks = [], notices = [], errors = [];
  const h = (tag, props, ...children) => {
    const node = dom.deps.h(tag, props, ...children);
    node.dataset ||= {};
    return node;
  };
  const deps = {
    ...dom.deps, h, T,
    card: ({ title, sub }, ...body) => h('section', {}, h('h2', {}, title), h('p', {}, sub), ...body),
    field: (label, input, help) => h('label', {}, label, input, help),
    skeletonRows: () => h('div', {}, 'loading'),
    errorBox: (error, retry) => {
      errors.push(error);
      return h('div', { class: 'error' }, error.message, h('button', { onclick: retry }, T('retry')));
    },
    ok: (...args) => notices.push(args),
    fail: (...args) => dom.failures.push(args),
    console: { log() { throw new Error('No registrar claves'); }, error() { throw new Error('No registrar errores'); } },
    localStorage: { setItem() { throw new Error('No persistir claves'); } },
    cloud: { client: {
      rpc: async (name, args) => { calls.push({ name, args }); return rpc(name, args); },
      functions: { invoke: async (name, args) => { checks.push({ name, args }); return invoke(name, args); } },
    } },
  };
  const { render } = loadRenderer(path.join(__dirname, '../integrations.js'), ['render'], deps);
  const root = h('div'); root.attached = true;
  const api = render(root);
  await turn();
  return { ...dom, root, calls, checks, notices, errors, api, card: id => root.children.find(el => el.dataset.integration === id) };
}

for (const failed of ['curseforge', 'klipy']) {
  test(failed + ': su error y reintento no reemplazan la otra tarjeta', async () => {
    const slow = deferred(); let attempts = 0;
    const other = failed === 'curseforge' ? 'klipy' : 'curseforge';
    const r = await rig(async name => {
      if (name === 'admin_' + failed + '_status' && ++attempts === 1) return slow.promise;
      return result();
    });
    assert.ok(r.card(other).querySelector('input'), 'la otra tarjeta carga mientras esta espera');
    const otherInput = r.card(other).querySelector('input');
    slow.resolve({ data: null, error: { message: 'missing RPC with FAKE_PRIVATE_BODY', code: 'PGRST202' } });
    await turn();
    assert.ok(r.card(failed).querySelector('.error'));
    assert.equal(r.root.textContent.includes('FAKE_PRIVATE_BODY'), false);
    assert.equal(otherInput, r.card(other).querySelector('input'));
    const retry = button(r.card(failed), 'retry');
    const request = retry.click();
    retry.onclick();
    await request;
    assert.ok(r.card(failed).querySelector('input'));
    assert.equal(attempts, 2);
    assert.equal(r.calls.filter(c => c.name === 'admin_' + other + '_status').length, 1);
    r.api.destroy();
  });
}

test('CurseForge: guardar, reemplazar y quitar usan el contrato y muestran solo la pista', async () => {
  const r = await rig(async (name, args) => name === 'admin_set_curseforge_key' ? result(Boolean(args.p_key), args.p_key.slice(-4)) : result());
  const card = r.card('curseforge'), input = card.querySelector('input');
  assert.equal(input.type, 'password');
  assert.equal(input.autocomplete, 'off');
  assert.equal(input.value, '');
  assert.equal(button(card, 'curseforgeRemove').disabled, true);
  assert.equal(button(card, 'curseforgeTest').disabled, true);
  input.value = '   ';
  await button(card, 'curseforgeSave').click();
  assert.equal(r.calls.length, 4, 'solo las cuatro consultas de estado');
  for (const [key, value] of [['curseforgeSave', 'test-only-key-0001'], ['curseforgeReplace', 'test-only-key-0002']]) {
    input.value = '  ' + value + '  ';
    await button(card, key).click();
    assert.equal(r.calls.at(-1).name, 'admin_set_curseforge_key');
    assert.equal(r.calls.at(-1).args.p_key, value);
    assert.equal(input.value, '');
    assert.ok(card.textContent.includes(T('curseforgeOn', { hint: value.slice(-4) })));
    assert.ok(input.placeholder.includes(value.slice(-4)));
    assert.equal(button(card, 'curseforgeTest').disabled, false);
    assert.equal(r.root.textContent.includes(value), false);
  }
  await button(card, 'curseforgeRemove').click();
  assert.equal(r.calls.at(-1).args.p_key, '');
  assert.ok(card.textContent.includes(T('curseforgeOff')));
  assert.equal(button(card, 'curseforgeRemove').disabled, true);
  assert.equal(button(card, 'curseforgeTest').disabled, true);
  assert.ok(button(card, 'curseforgeSave'));
  assert.equal(r.checks.length, 0, 'guardar no afirma ni prueba validez');
  r.api.destroy();
});

test('una peticion bloquea todas las acciones de su tarjeta y evita carreras entre guardar, quitar y probar', async () => {
  const pending = deferred();
  const r = await rig(async name => name === 'admin_set_curseforge_key' ? pending.promise : result(true, '0001'));
  const card = r.card('curseforge'), input = card.querySelector('input');
  input.value = 'test-only-race-key';
  const save = button(card, 'curseforgeReplace'), remove = button(card, 'curseforgeRemove'), check = button(card, 'curseforgeTest');
  const request = save.click();
  assert.ok(card.querySelectorAll('input,button').every(el => el.disabled));
  assert.equal(r.card('klipy').querySelector('input').disabled, false);
  save.listeners.click(); remove.listeners.click(); check.listeners.click();
  assert.equal(r.calls.filter(c => c.name === 'admin_set_curseforge_key').length, 1);
  assert.equal(r.checks.length, 0);
  pending.resolve(result(true, '0002'));
  await request;
  assert.equal(input.value, '');
  assert.ok(card.querySelectorAll('input,button').every(el => !el.disabled));
  r.api.destroy();
});

for (const mode of ['returned', 'thrown', 'bad_key']) {
  test('error ' + mode + ': vacia el campo y nunca refleja el detalle confidencial', async () => {
    const r = await rig(async name => {
      if (name.endsWith('_status')) return result(true, '0001');
      const error = new Error((mode === 'bad_key' ? 'bad_key ' : '') + 'FAKE_PRIVATE_BODY');
      if (mode === 'returned') return { data: null, error };
      throw error;
    });
    const card = r.card('curseforge'), input = card.querySelector('input');
    input.value = 'test-only-not-a-real-key';
    await button(card, 'curseforgeReplace').click();
    assert.equal(input.value, '');
    assert.equal(input.disabled, false);
    assert.equal(r.failures.length, 1);
    assert.equal(r.failures[0][1], T(mode === 'bad_key' ? 'curseforgeBadKey' : 'curseforgeRetryHint'));
    assert.equal(JSON.stringify(r.failures).includes('FAKE_PRIVATE_BODY'), false);
    assert.ok(card.textContent.includes(T('curseforgeOn', { hint: '0001' })));
    r.api.destroy();
  });
}

test('KLIPY conserva sus RPC, limpia la clave y no recarga CurseForge al guardar', async () => {
  const r = await rig(async (name, args) => name === 'admin_set_klipy_key' ? result(Boolean(args.p_key), '1234') : result());
  const card = r.card('klipy'), input = card.querySelector('input');
  input.value = 'test-only-klipy-key';
  await button(card, 'klipySave').click();
  assert.equal(input.value, '');
  assert.equal(r.calls.at(-1).name, 'admin_set_klipy_key');
  assert.equal(r.calls.at(-1).args.p_key, 'test-only-klipy-key');
  assert.equal(r.calls.filter(c => c.name === 'admin_curseforge_status').length, 1);
  await button(card, 'klipyRemove').click();
  assert.equal(r.calls.at(-1).args.p_key, '');
  assert.equal(button(card, 'klipyRemove').disabled, true);
  r.api.destroy();
});

test('Probar consulta busqueda de Minecraft por Venus, sin enviar el contenido del campo', async () => {
  const pending = deferred();
  const r = await rig(async () => result(true, '0001'), () => pending.promise);
  const card = r.card('curseforge'), input = card.querySelector('input');
  input.value = 'test-only-unsaved-key';
  const check = button(card, 'curseforgeTest'), request = check.click();
  check.listeners.click();
  button(card, 'curseforgeRemove').listeners.click();
  assert.equal(r.checks.length, 1);
  assert.equal(r.checks[0].name, 'curseforge');
  assert.deepEqual(JSON.parse(JSON.stringify(r.checks[0].args)), { body: { method: 'GET', path: '/v1/mods/search?gameId=432&classId=6&pageSize=1' } });
  assert.ok(card.querySelectorAll('input,button').every(el => el.disabled));
  pending.resolve({ data: { data: [{ id: 1, name: 'Test category' }] }, error: null });
  await request;
  assert.equal(input.value, '');
  assert.deepEqual(r.notices, [[T('curseforgeTestOk')]]);
  assert.ok(card.textContent.includes(T('curseforgeOn', { hint: '0001' })));
  r.api.destroy();
});

for (const mode of ['transport', 'body', 'unavailable']) {
  test('Probar: error ' + mode + ' muestra un mensaje propio y permite reintentar', async () => {
    const r = await rig(async () => result(true, '0001'), async () => {
      if (mode === 'unavailable') throw new Error('FAKE_PRIVATE_BODY');
      if (mode === 'transport') return { error: { message: 'FAKE_PRIVATE_BODY', context: { json() { throw new Error('No leer cuerpos'); } } } };
      return { data: { error: 'FAKE_PRIVATE_BODY' }, error: null };
    });
    const card = r.card('curseforge'), input = card.querySelector('input');
    input.value = 'test-only-unsaved-key';
    await button(card, 'curseforgeTest').click();
    assert.equal(input.value, '');
    assert.equal(button(card, 'curseforgeTest').disabled, false);
    assert.equal(r.failures[0][0], T('curseforgeTestFailed'));
    assert.equal(JSON.stringify(r.failures).includes('FAKE_PRIVATE_BODY'), false);
    assert.equal(r.notices.length, 0);
    r.api.destroy();
  });
}

test('un hint incorrecto no expone una clave completa ni impide reemplazarla', async () => {
  const r = await rig(async () => result(true, 'test-only-long-private-key'));
  const card = r.card('curseforge'), input = card.querySelector('input');
  assert.equal(card.textContent.includes('test-only-long-private-key'), false);
  assert.equal(input.placeholder.includes('test-only-long-private-key'), false);
  assert.ok(card.textContent.includes(T('curseforgeSaved')));
  assert.equal(button(card, 'curseforgeReplace').disabled, false);
  r.api.destroy();
});

test('una respuesta de estado invalida queda aislada y ofrece reintento', async () => {
  const r = await rig(async name => name === 'admin_curseforge_status' ? { data: { configured: 'true', hint: 'FAKE_PRIVATE_BODY' } } : result());
  assert.ok(r.card('curseforge').querySelector('.error'));
  assert.ok(button(r.card('curseforge'), 'retry'));
  assert.ok(r.card('klipy').querySelector('input'));
  assert.equal(r.root.textContent.includes('FAKE_PRIVATE_BODY'), false);
  r.api.destroy();
});

test('al salir durante un guardado se borra la clave y la respuesta tardia no modifica la vista', async () => {
  const pending = deferred();
  const r = await rig(async name => name === 'admin_set_curseforge_key' ? pending.promise : result(true, '0001'));
  const card = r.card('curseforge'), input = card.querySelector('input'), before = card.textContent;
  input.value = 'test-only-pending-key';
  const request = button(card, 'curseforgeReplace').click();
  r.api.destroy();
  assert.equal(input.value, '');
  pending.resolve(result(true, '9999'));
  await request;
  assert.equal(card.textContent, before);
  assert.equal(r.notices.length, 0);
  assert.equal(r.failures.length, 0);
  assert.ok(card.querySelectorAll('input,button').every(el => el.disabled));
});

test('salir durante la carga impide montar formularios con respuestas tardias', async () => {
  const pending = deferred();
  const r = await rig(() => pending.promise);
  r.api.destroy();
  pending.resolve(result(true, '0001'));
  await turn();
  assert.equal(r.root.querySelectorAll('input').length, 0);
});

test('los textos nuevos existen en es/en y errSignIn en los catorce idiomas con variables intactas', () => {
  const en = readDict(path.join(ROOT, 'src/renderer/i18n/en/admin.js'));
  const variables = value => [...value.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');
  for (const key of Object.keys(strings).filter(k => k.startsWith('curseforge') || ['klipyLoadFailed', 'klipyRetryHint', 'klipyOn', 'a_curseforge_key'].includes(k))) {
    assert.equal(typeof en[key], 'string', key);
    assert.equal(variables(en[key]), variables(strings[key]), key);
  }
  const languages = ['es', 'en', 'pt', 'fr', 'de', 'it', 'nl', 'pl', 'ru', 'uk', 'tr', 'ja', 'ko', 'zh'];
  for (const lang of languages) {
    const dict = require(path.join(ROOT, 'src/main/i18n', lang, 'curseforge.js'));
    assert.ok(dict.errSignIn.includes('Venus') && dict.errSignIn.includes('CurseForge'), lang);
    assert.ok(dict.errNoKey.includes('CurseForge'), lang);
    assert.equal(variables(dict.errSignIn), '', lang);
    assert.equal(variables(dict.errNoKey), '', lang);
  }
  assert.equal(require(path.join(ROOT, 'src/main/i18n/es/curseforge.js')).errSignIn, 'Iniciá sesión con tu cuenta de Venus para usar CurseForge.');
});

// Códigos nuevos del servidor (4.6): cada uno explica una cosa distinta, sin mostrar texto remoto.
for (const [code, status, expected] of [['blocked', 403, 'curseforge.testBlocked'], ['not_configured', 503, 'curseforge.testNotConfigured'], ['unavailable', 503, 'curseforge.testUnavailable'], ['upstream', 502, 'curseforge.testUpstream'], ['denied', 403, 'curseforge.testUpstream']]) {
  test('la prueba explica ' + code + ' con su propio mensaje y sin reflejar el cuerpo remoto', async () => {
    const r = await rig(async () => result(true, '0001'), async () => ({ error: { context: new Response(JSON.stringify({ error: { code }, detail: 'FAKE_PRIVATE_BODY' }), { status }) } }));
    await button(r.card('curseforge'), 'curseforgeTest').click();
    assert.equal(r.failures[0][1], expected);
    assert.equal(JSON.stringify(r.failures).includes('FAKE_PRIVATE_BODY'), false);
    r.api.destroy();
  });
}

test('un código desconocido cae en el mensaje genérico de reintento', async () => {
  const r = await rig(async () => result(true, '0001'), async () => ({ error: { context: new Response(JSON.stringify({ error: { code: 'something_new' } }), { status: 418 }) } }));
  await button(r.card('curseforge'), 'curseforgeTest').click();
  assert.equal(r.failures[0][1], T('curseforgeRetryHint'));
  r.api.destroy();
});

test('los textos nuevos de CurseForge existen en español e inglés con las mismas variables', () => {
  const es = readDict(path.join(ROOT, 'src/renderer/i18n/es/curseforge.js'));
  const en = readDict(path.join(ROOT, 'src/renderer/i18n/en/curseforge.js'));
  assert.deepEqual(Object.keys(en).sort(), Object.keys(es).sort());
  for (const [key, value] of Object.entries(es)) {
    assert.equal(typeof value, 'string', key);
    assert.ok(value.trim().length > 0 && en[key].trim().length > 0, key);
  }
  const main = ['es', 'en'].map((lang) => require(path.join(ROOT, 'src/main/i18n', lang, 'curseforge.js')));
  for (const key of ['errBlocked', 'errDenied']) assert.ok(main[0][key] && main[1][key], key);
});

for (const [code, key] of [['badkey', 'curseforgeKeyRejected'], ['forbidden', 'curseforgeAccessDenied'], ['unauthorized', 'curseforgeSessionExpired'], ['rate_limit', 'curseforgeRateLimit']]) {
  test('la prueba explica ' + code + ' sin reflejar el cuerpo remoto', async () => {
    const r = await rig(async () => result(true, '0001'), async () => ({ error: { context: new Response(JSON.stringify({ error: { code }, detail: 'FAKE_PRIVATE_BODY' }), { status: code === 'unauthorized' ? 401 : code === 'rate_limit' ? 429 : 403 }) } }));
    await button(r.card('curseforge'), 'curseforgeTest').click();
    assert.equal(r.failures[0][1], T(key));
    assert.equal(JSON.stringify(r.failures).includes('FAKE_PRIVATE_BODY'), false);
    assert.equal(r.calls.some(c => c.name === 'admin_set_curseforge_key'), false);
    r.api.destroy();
  });
}

// 6.1: Venus IA con dos motores. La tarjeta de Claude (Anthropic) usa los RPC propios con la misma forma que OpenAI.
test('Claude (Anthropic): tarjeta propia entre OpenAI y KLIPY, con sus RPC y sin mostrar la clave', async () => {
  const r = await rig(async (name, args) => name === 'admin_set_anthropic_key' ? result(Boolean(args.p_key), args.p_key.slice(-4)) : result());
  assert.deepEqual(r.root.children.map(el => el.dataset.integration), ['openai', 'anthropic', 'klipy', 'curseforge']);
  assert.ok(r.calls.some(c => c.name === 'admin_anthropic_status'));
  const card = r.card('anthropic'), input = card.querySelector('input');
  assert.equal(input.type, 'password');
  assert.ok(card.textContent.includes(T('anthropicTitle')) && card.textContent.includes(T('anthropicOff')));
  input.value = '  sk-ant-test-only-0001  ';
  await button(card, 'anthropicSave').click();
  assert.equal(r.calls.at(-1).name, 'admin_set_anthropic_key');
  assert.equal(r.calls.at(-1).args.p_key, 'sk-ant-test-only-0001');
  assert.equal(input.value, '');
  assert.ok(card.textContent.includes(T('anthropicOn', { hint: '0001' })));
  assert.equal(r.root.textContent.includes('sk-ant-test-only-0001'), false);
  await button(card, 'anthropicRemove').click();
  assert.equal(r.calls.at(-1).args.p_key, '');
  assert.ok(card.textContent.includes(T('anthropicOff')));
  r.api.destroy();
});

test('Claude (Anthropic): bad_key explica el formato sk-ant- sin reflejar el detalle', async () => {
  const r = await rig(async name => {
    if (name.endsWith('_status')) return result();
    return { data: null, error: new Error('bad_key FAKE_PRIVATE_BODY') };
  });
  const card = r.card('anthropic'), input = card.querySelector('input');
  input.value = 'sk-test-only-wrong';
  await button(card, 'anthropicSave').click();
  assert.equal(input.value, '');
  assert.deepEqual(r.failures[0], [T('anthropicFailed'), T('anthropicBadKey')]);
  assert.equal(JSON.stringify(r.failures).includes('FAKE_PRIVATE_BODY'), false);
  r.api.destroy();
});

test('los textos de Claude (Anthropic) existen en es/en con las mismas variables', () => {
  const en = readDict(path.join(ROOT, 'src/renderer/i18n/en/admin.js'));
  const variables = value => [...value.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');
  const keys = Object.keys(strings).filter(k => k.startsWith('anthropic'));
  assert.equal(keys.length, 16);
  for (const key of keys) assert.equal(variables(en[key]), variables(strings[key]), key);
  assert.ok(strings.anthropicBadKey.includes('sk-ant-'));
});
