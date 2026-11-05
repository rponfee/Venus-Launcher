'use strict';
// Pruebas del cliente de Soporte: consultas con campos propios, diagnóstico, capturas y equipo; sin planes ni confirmación de pagos.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSupportClient, rpcRequest, failure } = require('../client');

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const OWNER = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000002';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);

test('crear: asunto, tema y mensaje van a support_open_ticket', () => {
  assert.deepEqual(rpcRequest('create', { subject: '  No anda el chat ', category: 'assistant', message: 'Hola' }),
    ['support_open_ticket', { p_subject: 'No anda el chat', p_category: 'assistant', p_message: 'Hola' }]);
  assert.throws(() => rpcRequest('create', { subject: 'Hola', category: 'plan', message: 'x' }), { code: 'badRequest' });
  assert.throws(() => rpcRequest('create', { subject: 'ab', category: 'general', message: 'x' }), { code: 'badRequest' });
  assert.throws(() => rpcRequest('create', { subject: 'Asunto', category: 'general', message: '' }), { code: 'badRequest' });
});

test('crear: con campos propios o diagnóstico usa support_submit_ticket y limpia los campos', () => {
  const [fn, body] = rpcRequest('create', { subject: 'Se cierra', category: 'game', message: 'Al cargar', details: { mcVersion: ' 1.21.1 ', loader: 'fabric', steps: '', moment: 'loading' }, diagnostic: '  [app]\nlauncher: 4.6.0 \n' });
  assert.equal(fn, 'support_submit_ticket');
  assert.deepEqual(body, { p_subject: 'Se cierra', p_category: 'game', p_message: 'Al cargar', p_details: { mcVersion: '1.21.1', loader: 'fabric', moment: 'loading' }, p_diagnostic: '[app]\nlauncher: 4.6.0' });
  // categoría nueva sin campos: igual necesita la función nueva
  assert.equal(rpcRequest('create', { subject: 'Una idea', category: 'suggestion', message: 'x' })[0], 'support_submit_ticket');
  // tema de siempre con diagnóstico
  assert.equal(rpcRequest('create', { subject: 'Un error', category: 'bug', message: 'x', diagnostic: 'a' })[0], 'support_submit_ticket');
});

test('crear: rechaza campos que la categoría no tiene o con valores fuera de lista', () => {
  const base = { subject: 'Asunto', message: 'Hola' };
  assert.throws(() => rpcRequest('create', { ...base, category: 'game', details: { nope: 'x' } }), { code: 'bad_details' });
  assert.throws(() => rpcRequest('create', { ...base, category: 'game', details: { loader: 'windows' } }), { code: 'bad_details' });
  assert.throws(() => rpcRequest('create', { ...base, category: 'game', details: { steps: 5 } }), { code: 'bad_details' });
  assert.throws(() => rpcRequest('create', { ...base, category: 'bug', details: { steps: 'a'.repeat(601) } }), { code: 'bad_details' });
  assert.throws(() => rpcRequest('create', { ...base, category: 'payments', details: { paidOn: 'ayer' } }), { code: 'bad_details' });
  assert.throws(() => rpcRequest('create', { ...base, category: 'game', details: { mcVersion: '1.21<script>' } }), { code: 'bad_details' });
  assert.throws(() => rpcRequest('create', { ...base, category: 'other', details: { area: 'x' } }), { code: 'bad_details' });
  assert.throws(() => rpcRequest('create', { ...base, category: 'bug', diagnostic: 'x'.repeat(12001) }), { code: 'bad_diagnostic' });
  assert.throws(() => rpcRequest('create', { ...base, category: 'bug', diagnostic: `a${String.fromCharCode(7)}b` }), { code: 'bad_diagnostic' });
});

test('cerrar: nunca confirma un pago', () => {
  assert.deepEqual(rpcRequest('resolve', { ticketId: ID, confirmPayment: true, note: 'listo' }),
    ['support_resolve_ticket', { p_ticket: ID, p_confirm_payment: false, p_note: 'listo' }]);
  assert.throws(() => rpcRequest('resolve', { ticketId: 'x' }), { code: 'badRequest' });
});

test('acciones desconocidas', () => {
  assert.throws(() => rpcRequest('activatePlan', {}), { code: 'badRequest' });
  assert.throws(() => rpcRequest('createPlanTicket', { plan: 'pro' }), { code: 'badRequest' });
});

test('cola del equipo: solo filtros conocidos, con tope de página', () => {
  assert.deepEqual(rpcRequest('queue', { filter: { status: 'waiting', category: 'game', priority: 'high', assigned: 'me', sort: 'oldest', search: '  crash ', page: 2, limit: 500 } }),
    ['support_queue', { p_filter: { status: 'waiting', category: 'game', priority: 'high', assigned: 'me', sort: 'oldest', search: 'crash', page: 2, limit: 100 } }]);
  assert.deepEqual(rpcRequest('queue', {}), ['support_queue', { p_filter: {} }]);
  assert.deepEqual(rpcRequest('queue', { filter: { search: '   ' } }), ['support_queue', { p_filter: {} }]);
  for (const filter of [{ status: 'todas' }, { category: 'x' }, { priority: 'enorme' }, { assigned: 'otro' }, { sort: 'azar' }, { search: 'a'.repeat(61) }]) {
    assert.throws(() => rpcRequest('queue', { filter }), { code: 'badRequest' });
  }
});

test('valorar, reabrir, cerrar y marcar como vista', () => {
  assert.deepEqual(rpcRequest('rate', { ticketId: ID, rating: 4, comment: ' Bien ' }), ['support_rate_ticket', { p_ticket: ID, p_rating: 4, p_comment: 'Bien' }]);
  for (const rating of [0, 6, 2.5, '4', null]) assert.throws(() => rpcRequest('rate', { ticketId: ID, rating }), { code: 'badRequest' });
  assert.throws(() => rpcRequest('rate', { ticketId: ID, rating: 3, comment: 'a'.repeat(501) }), { code: 'badRequest' });
  assert.deepEqual(rpcRequest('reopen', { ticketId: ID, message: 'Volvió' }), ['support_reopen_ticket', { p_ticket: ID, p_message: 'Volvió' }]);
  assert.deepEqual(rpcRequest('closeOwn', { ticketId: ID }), ['support_close_own_ticket', { p_ticket: ID, p_note: '' }]);
  assert.deepEqual(rpcRequest('markSeen', { ticketId: ID }), ['support_mark_seen', { p_ticket: ID }]);
  assert.deepEqual(rpcRequest('unread', {}), ['support_unread_summary', {}]);
});

test('equipo: asignar, prioridad, notas y respuestas guardadas', () => {
  assert.deepEqual(rpcRequest('assign', { ticketId: ID, to: OWNER }), ['support_assign', { p_ticket: ID, p_to: OWNER }]);
  assert.deepEqual(rpcRequest('assign', { ticketId: ID, to: null }), ['support_assign', { p_ticket: ID, p_to: null }]);
  assert.throws(() => rpcRequest('assign', { ticketId: ID, to: 'yo' }), { code: 'badRequest' });
  assert.deepEqual(rpcRequest('priority', { ticketId: ID, priority: 'urgent' }), ['support_set_priority', { p_ticket: ID, p_priority: 'urgent' }]);
  assert.throws(() => rpcRequest('priority', { ticketId: ID, priority: 'enorme' }), { code: 'badRequest' });
  assert.throws(() => rpcRequest('note', { ticketId: ID, body: ' ' }), { code: 'badRequest' });
  assert.throws(() => rpcRequest('note', { ticketId: ID, body: 'a'.repeat(2001) }), { code: 'badRequest' });
  assert.deepEqual(rpcRequest('macroSave', { title: ' Saludo ', body: 'Hola', shared: true }), ['support_macro_save', { p_id: null, p_title: 'Saludo', p_body: 'Hola', p_shared: true }]);
  assert.deepEqual(rpcRequest('macroSave', { id: ID, title: 'T', body: 'B' }), ['support_macro_save', { p_id: ID, p_title: 'T', p_body: 'B', p_shared: false }]);
  assert.throws(() => rpcRequest('macroSave', { title: '', body: 'x' }), { code: 'badRequest' });
  assert.deepEqual(rpcRequest('macroDelete', { id: ID }), ['support_macro_delete', { p_id: ID }]);
});

test('capturas: hasta 3 por envío y solo rutas con la forma <uuid>/<uuid>/<uuid>.<ext>', () => {
  const path = `${OWNER}/${ID}/cccccccc-cccc-4ccc-8ccc-000000000003.png`;
  assert.deepEqual(rpcRequest('attach', { ticketId: ID, messageId: ID, files: [{ path, name: 'a.png' }] }),
    ['support_register_attachments', { p_ticket: ID, p_message: ID, p_files: [{ path, name: 'a.png' }] }]);
  assert.throws(() => rpcRequest('attach', { ticketId: ID, files: [] }), { code: 'attach_limit' });
  assert.throws(() => rpcRequest('attach', { ticketId: ID, files: [{ path }, { path }, { path }, { path }] }), { code: 'attach_limit' });
  assert.throws(() => rpcRequest('attach', { ticketId: ID, files: [{ path: '../../etc/passwd' }] }), { code: 'attach_bad' });
  assert.throws(() => rpcRequest('attach', { ticketId: ID, files: [{ path: `${OWNER}/${ID}/x.exe` }] }), { code: 'attach_bad' });
});

test('errores: el aviso del servidor (hint) pasa a ser el code; sin aviso se decide por el estado', () => {
  assert.equal(failure({ status: 400 }, { code: '23505', hint: 'too_many_open', message: 'Ya tenés 3 consultas abiertas.' }).code, 'too_many_open');
  assert.equal(failure({ status: 400 }, { code: '54000', hint: 'daily_limit', message: 'x' }).code, 'daily_limit');
  assert.equal(failure({ status: 400 }, { code: '42501', hint: 'banned', message: 'x' }).code, 'banned');
  assert.equal(failure({ status: 400 }, { code: '22023', hint: 'inventado', message: 'Texto' }).code, 'server');
  assert.equal(failure({ status: 401 }, null).code, 'noSession');
  assert.equal(failure({ status: 404 }, { code: 'PGRST202' }).code, 'unavailable');
  assert.equal(failure({ status: 403 }, {}).code, 'forbidden');
  assert.equal(failure({ status: 400 }, { code: 'P0002' }).code, 'notFound');
  assert.equal(failure({ status: 409 }, { code: '23505' }).code, 'conflict');
  assert.equal(failure({ status: 500 }, {}).code, 'server');
});

function fakeFetch(handler) {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, init }); return handler(url, init); };
  return { fetch, calls };
}
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, headers: new Map() });
const baseDeps = (fetch) => ({ fetch, cloudConfig: async () => ({ configured: true, url: 'https://x.example.test', anonKey: 'anon' }), accessToken: async () => 'tok' });

test('llamada: POST a /rest/v1/rpc con el token de la sesión y el cuerpo ya validado', async () => {
  const { fetch, calls } = fakeFetch(() => json(200, { ok: true }));
  const client = createSupportClient(baseDeps(fetch));
  assert.deepEqual(await client.call('markSeen', { ticketId: ID }, OWNER), { ok: true });
  assert.equal(calls[0].url, 'https://x.example.test/rest/v1/rpc/support_mark_seen');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(calls[0].init.body), { p_ticket: ID });
});

test('llamada: sin red devuelve network y con error del servidor devuelve el aviso', async () => {
  const offline = createSupportClient(baseDeps(async () => { throw new Error('boom'); }));
  await assert.rejects(offline.call('unread', {}, OWNER), { code: 'network' });
  const refused = createSupportClient(baseDeps(async () => json(400, { code: '54000', hint: 'rate_minute', message: 'Esperá un minuto antes de enviar más mensajes.' })));
  await assert.rejects(refused.call('reply', { ticketId: ID, body: 'hola' }, OWNER), { code: 'rate_minute' });
  const unconfigured = createSupportClient({ ...baseDeps(async () => json(200, {})), cloudConfig: async () => ({ configured: false }) });
  await assert.rejects(unconfigured.call('unread', {}, OWNER), { code: 'noCloud' });
});

test('subir captura: ruta <usuario>/<consulta>/<uuid>.png, tipo detectado por los bytes y nada de sobrescribir', async () => {
  const { fetch, calls } = fakeFetch(() => json(200, { Key: 'k' }));
  const client = createSupportClient(baseDeps(fetch));
  const done = await client.upload({ ticketId: ID, bytes: new Uint8Array(PNG) }, OWNER);
  assert.match(done.path, new RegExp(`^${OWNER}/${ID}/[0-9a-f-]{36}\\.png$`));
  assert.equal(done.mime, 'image/png');
  assert.ok(calls[0].url.startsWith('https://x.example.test/storage/v1/object/support-attachments/'));
  assert.equal(calls[0].init.headers['Content-Type'], 'image/png');
  assert.equal(calls[0].init.headers['x-upsert'], 'false');
});

test('subir captura: rechaza lo que no es imagen, lo vacío y lo de más de 4 MB, y traduce la negativa de Storage', async () => {
  const { fetch } = fakeFetch(() => json(200, {}));
  const client = createSupportClient(baseDeps(fetch));
  await assert.rejects(client.upload({ ticketId: ID, bytes: Buffer.from('<html>no soy imagen</html>') }, OWNER), { code: 'attach_bad' });
  await assert.rejects(client.upload({ ticketId: ID, bytes: Buffer.alloc(0) }, OWNER), { code: 'attach_bad' });
  await assert.rejects(client.upload({ ticketId: ID, bytes: Buffer.concat([PNG, Buffer.alloc(4 * 1024 * 1024)]) }, OWNER), { code: 'attach_big' });
  await assert.rejects(client.upload({ ticketId: 'x', bytes: PNG }, OWNER), { code: 'badRequest' });
  const denied = createSupportClient(baseDeps(async () => json(403, { message: 'new row violates row-level security policy' })));
  await assert.rejects(denied.upload({ ticketId: ID, bytes: PNG }, OWNER), { code: 'attach_denied' });
  const tooBig = createSupportClient(baseDeps(async () => json(413, {})));
  await assert.rejects(tooBig.upload({ ticketId: ID, bytes: PNG }, OWNER), { code: 'attach_big' });
});

test('bajar captura: solo rutas válidas y devuelve imagen verificada', async () => {
  const path = `${OWNER}/${ID}/cccccccc-cccc-4ccc-8ccc-000000000003.png`;
  const { fetch, calls } = fakeFetch(() => ({ ok: true, status: 200, headers: { get: () => '40' }, arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.length) }));
  const client = createSupportClient(baseDeps(fetch));
  const file = await client.download(path, OWNER);
  assert.equal(file.mime, 'image/png');
  assert.equal(calls[0].url, `https://x.example.test/storage/v1/object/authenticated/support-attachments/${path}`);
  await assert.rejects(client.download('../x.png', OWNER), { code: 'attach_bad' });
  const html = createSupportClient(baseDeps(async () => ({ ok: true, status: 200, headers: { get: () => '10' }, arrayBuffer: async () => new Uint8Array(Buffer.from('<html>no soy imagen</html>')).buffer })));
  await assert.rejects(html.download(path, OWNER), { code: 'attach_bad' });
  const missing = createSupportClient(baseDeps(async () => json(404, {})));
  await assert.rejects(missing.download(path, OWNER), { code: 'attach_missing' });
});
