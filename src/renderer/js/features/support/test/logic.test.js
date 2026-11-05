// Lógica de Soporte: validación, tarjetas pegadas por error, borradores, preguntas frecuentes, filtros y capturas.
// node --test "src/renderer/js/features/support/test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../logic.js';
import { cleanDetails as mainClean, DETAILS } from '../../../../../main/modules/support/rules.js';

const ok = (over = {}) => ({ category: 'bug', subject: 'No abre el launcher', message: 'Cuando hago clic en el icono no pasa nada y vuelve a cerrarse.', details: { area: 'launcher' }, ...over });

test('formulario válido', () => {
  const r = L.validateTicket(ok());
  assert.equal(r.ok, true);
  assert.equal(r.first, null);
});

test('asunto: 3 a 120 y el primer error manda', () => {
  assert.equal(L.validateTicket(ok({ subject: '' })).errors.subject, 'required');
  assert.equal(L.validateTicket(ok({ subject: '  ab ' })).errors.subject, 'short');
  assert.equal(L.validateTicket(ok({ subject: 'a'.repeat(121) })).errors.subject, 'long');
  assert.equal(L.validateTicket(ok({ subject: 'a'.repeat(120) })).ok, true);
  const r = L.validateTicket(ok({ subject: '', message: '' }));
  assert.equal(r.first, 'subject');
});

test('mensaje: 10 a 4000 caracteres', () => {
  assert.equal(L.validateTicket(ok({ message: '' })).errors.message, 'required');
  assert.equal(L.validateTicket(ok({ message: 'corto' })).errors.message, 'short');
  assert.equal(L.validateTicket(ok({ message: 'x'.repeat(4001) })).errors.message, 'long');
  assert.equal(L.validateTicket(ok({ message: 'x'.repeat(4000) })).ok, true);
  assert.equal(L.validateTicket(ok({ message: `${' '.repeat(50)}hola` })).errors.message, 'short');
});

test('el tema es obligatorio y tiene que ser de la lista', () => {
  assert.equal(L.validateTicket(ok({ category: '' })).errors.category, 'required');
  assert.equal(L.validateTicket(ok({ category: 'plan' })).errors.category, 'required');
  assert.equal(L.validateTicket(ok({ category: 'general' })).errors.category, 'required'); // viejo: no se ofrece
});

test('campos propios obligatorios por tema', () => {
  assert.equal(L.validateTicket(ok({ details: {} })).errors.details.area, 'required');
  const game = L.validateTicket({ category: 'game', subject: 'Se cierra', message: 'Se cierra al cargar el mundo', details: {} });
  assert.deepEqual(Object.keys(game.errors.details).sort(), ['mcVersion', 'moment']);
  assert.equal(game.first, 'details.mcVersion');
  assert.equal(L.validateTicket({ category: 'other', subject: 'Una duda', message: 'Quería saber algo del launcher', details: {} }).ok, true);
});

test('pagos: medio, fecha y referencia solo si es un pago o un reembolso', () => {
  const base = { category: 'payments', subject: 'Pagué y no se activó', message: 'Pagué ayer con Mercado Pago y no veo el plan' };
  assert.equal(L.validateTicket({ ...base, details: { topic: 'login', paidOn: 'ayer' } }).ok, true); // oculto: no se mira
  assert.equal(L.validateTicket({ ...base, details: { topic: 'payment', paidOn: 'ayer' } }).errors.details.paidOn, 'date');
  assert.equal(L.validateTicket({ ...base, details: { topic: 'payment', paidOn: '2026-02-31x' } }).errors.details.paidOn, 'date');
  assert.equal(L.validateTicket({ ...base, details: { topic: 'refund', paidOn: '2026-11-01', orderRef: 'ABC-1' } }).ok, true);
  assert.deepEqual(L.cleanDetails('payments', { topic: 'login', method: 'paypal', paidOn: '2026-11-01' }), { topic: 'login' });
});

test('número de tarjeta: se detecta en asunto, mensaje y campos y no se detectan falsos positivos', () => {
  assert.equal(L.looksLikeCard('mi tarjeta es 4111 1111 1111 1111 y venció'), true);
  assert.equal(L.looksLikeCard('4111-1111-1111-1111'), true);
  assert.equal(L.looksLikeCard('5555555555554444'), true);
  assert.equal(L.looksLikeCard('4111 1111 1111 1112'), false); // Luhn no cierra
  assert.equal(L.looksLikeCard('0000000000000000'), false);
  assert.equal(L.looksLikeCard('el pedido 1234567890 del 2026-11-04'), false);
  assert.equal(L.looksLikeCard('versión 1.21.1 con 4096 MB'), false);
  assert.equal(L.looksLikeCard(''), false);
  assert.equal(L.validateTicket(ok({ message: 'Pagué con 4111 1111 1111 1111 y no se activó el plan' })).errors.message, 'card');
  assert.equal(L.validateTicket(ok({ subject: '4111111111111111' })).errors.subject, 'card');
  assert.equal(L.validateTicket({ category: 'payments', subject: 'Un pago', message: 'Pagué ayer y no se activó nada', details: { topic: 'payment', orderRef: '4111 1111 1111 1111' } }).errors.details.orderRef, 'card');
  assert.equal(L.validateReply('mi tarjeta 4111 1111 1111 1111').error, 'card');
});

test('diagnóstico demasiado largo bloquea el envío', () => {
  assert.equal(L.validateTicket(ok(), { diagnosticChars: 12000 }).ok, true);
  assert.equal(L.validateTicket(ok(), { diagnosticChars: 12001 }).errors.diagnostic, 'long');
});

test('respuesta: vacía, larga o con tarjeta', () => {
  assert.deepEqual(L.validateReply('Hola'), { ok: true, error: null });
  assert.equal(L.validateReply('   ').error, 'required');
  assert.equal(L.validateReply('x'.repeat(4001)).error, 'long');
});

test('contador: ok, cerca y pasado', () => {
  assert.deepEqual(L.counter('hola', 4000), { used: 4, left: 3996, level: 'ok' });
  assert.equal(L.counter('x'.repeat(3700), 4000).level, 'near');
  assert.equal(L.counter('x'.repeat(4001), 4000).level, 'over');
  assert.equal(L.counter('  ', 120).used, 0);
  assert.equal(L.counter('x'.repeat(115), 120).level, 'near');
});

test('datos propios: los de la interfaz y los del proceso principal limpian igual', () => {
  const samples = {
    bug: { area: 'update', frequency: 'once', steps: ' abrir y cerrar ' },
    game: { mcVersion: '1.21.1', loader: 'neoforge', moment: 'closing', modsChanged: 'no', steps: 'x' },
    payments: { topic: 'payment', method: 'paypal', paidOn: '2026-11-04', orderRef: 'AB-12' },
    assistant: { plan: 'pro', issue: 'limit' },
    suggestion: { area: 'ai', benefit: 'ahorra tiempo' },
    other: {},
  };
  for (const [category, details] of Object.entries(samples)) assert.deepEqual(L.cleanDetails(category, details), mainClean(category, details), category);
});

test('los campos de la interfaz coinciden con los valores que acepta el servidor', () => {
  for (const [category, fields] of Object.entries(L.DETAIL_FIELDS)) {
    const server = DETAILS[category];
    for (const field of fields) {
      if (field.kind === 'select') assert.deepEqual([...field.options].sort(), [...server.enums[field.id]].sort(), `${category}.${field.id}`);
      else assert.equal(field.max, server.free[field.id], `${category}.${field.id}`);
    }
    const ids = fields.map((f) => f.id).sort();
    assert.deepEqual(ids, [...Object.keys(server.enums), ...Object.keys(server.free)].sort(), category);
  }
  assert.deepEqual([...L.ALL_CATEGORIES].sort(), Object.keys(DETAILS).sort());
});

test('limpiar datos: descarta valores fuera de lista, vacíos, de otro tipo y con caracteres de control', () => {
  assert.deepEqual(L.cleanDetails('game', { loader: 'windows', mcVersion: '1.21.1', moment: '', steps: `a${String.fromCharCode(7)}b`, desconocido: 'x' }), { mcVersion: '1.21.1' });
  assert.deepEqual(L.cleanDetails('bug', { area: 7, steps: 'a'.repeat(601) }), {});
  assert.deepEqual(L.cleanDetails('nada', { a: 'b' }), {});
});

test('borrador: ida y vuelta, vacío no se guarda y lo dañado se descarta', () => {
  const draft = { category: 'game', subject: 'Se cierra', message: 'Al cargar', details: { loader: 'fabric' }, savedAt: 123 };
  assert.deepEqual(L.parseDraft(L.serializeDraft(draft)), draft);
  assert.equal(L.serializeDraft({ category: 'bug', subject: '  ', message: '', details: {} }), '');
  assert.equal(L.serializeDraft(null), '');
  for (const bad of [null, undefined, '', 'no json', '{"v":2,"subject":"x"}', '[]', '{"v":1}', '{"v":1,"subject":"","message":"","details":{}}', 'x'.repeat(30000)]) assert.equal(L.parseDraft(bad), null, String(bad).slice(0, 20));
  const dirty = L.parseDraft(JSON.stringify({ v: 1, category: 'zzz', subject: 'a'.repeat(500), message: 5, details: { ok: 'sí', 'raro-clave': 'x', num: 3 } }));
  assert.equal(dirty.category, 'bug');
  assert.equal(dirty.subject.length, 120);
  assert.equal(dirty.message, '');
  assert.deepEqual(dirty.details, { ok: 'sí' });
  assert.notEqual(L.draftKey('a'), L.draftKey('b'));
  assert.notEqual(L.replyDraftKey('a', '1'), L.replyDraftKey('a', '2'));
});

test('preguntas frecuentes: una palabra fuerte alcanza, las sueltas no', () => {
  assert.equal(L.matchFaq('pagué el plan pro y no se activó', 'payments')[0].id, 'plan');
  assert.equal(L.matchFaq('Olvidé mi contraseña', 'payments')[0].id, 'signin');
  assert.equal(L.matchFaq('no puedo iniciar sesión', 'other')[0].id, 'signin');
  assert.equal(L.matchFaq('el juego crashea al abrir el mundo', 'game')[0].id, 'crash');
  assert.equal(L.matchFaq('FPS muy bajos y lag', 'game')[0].id, 'slow');
  assert.equal(L.matchFaq('my payment is not active', 'payments')[0].id, 'plan');
  assert.deepEqual(L.matchFaq('hola quería saludar', 'other'), []);
  assert.deepEqual(L.matchFaq('el launcher', 'bug'), []); // palabras sueltas sin una fuerte
  assert.deepEqual(L.matchFaq('', 'bug'), []);
  assert.ok(L.matchFaq('java crash plan fps skin voz', 'game', 3).length <= 3);
  assert.equal(L.matchFaq('problema con la skin', 'bug')[0].id, 'skin');
  assert.ok(L.FAQ.every((f) => f.go && f.strong.length && f.cats.length));
  const ids = L.matchFaq('crash y java en minecraft', 'game').map((x) => x.id);
  assert.ok(ids.includes('crash') && ids.includes('java'));
});

test('tokens: sin tildes, minúsculas y de 3 letras o más', () => {
  assert.deepEqual(L.tokens('Sesión ¡Iniciar! el no'), ['sesion', 'iniciar']);
});

const T = (id, status, extra = {}) => ({ id, status, unread: false, ...extra });
test('mis consultas: filtros y contadores', () => {
  const list = [T('a', 'open'), T('b', 'in_progress', { unread: true }), T('c', 'closed'), T('d', 'paid')];
  assert.deepEqual(L.filterMine(list, 'open').map((t) => t.id), ['a', 'b']);
  assert.deepEqual(L.filterMine(list, 'closed').map((t) => t.id), ['c', 'd']);
  assert.deepEqual(L.filterMine(list, 'unread').map((t) => t.id), ['b']);
  assert.equal(L.filterMine(list, 'otra').length, 4);
  assert.deepEqual(L.mineCounts(list), { all: 4, open: 2, closed: 2, unread: 1 });
  assert.deepEqual(L.filterMine(null), []);
});

test('reabrir: cerrada, dentro de los 14 días y menos de 3 veces', () => {
  const now = Date.parse('2026-11-05T12:00:00Z');
  assert.equal(L.canReopen({ status: 'closed', reopenCount: 0, reopenUntil: '2026-11-10T00:00:00Z' }, now), true);
  assert.equal(L.canReopen({ status: 'closed', reopenCount: 2, reopenUntil: '2026-11-10T00:00:00Z' }, now), true);
  assert.equal(L.canReopen({ status: 'closed', reopenCount: 3, reopenUntil: '2026-11-10T00:00:00Z' }, now), false);
  assert.equal(L.canReopen({ status: 'closed', reopenCount: 0, reopenUntil: '2026-11-01T00:00:00Z' }, now), false);
  assert.equal(L.canReopen({ status: 'open', reopenCount: 0, reopenUntil: '2026-11-10T00:00:00Z' }, now), false);
  assert.equal(L.canReopen({ status: 'paid', reopenUntil: '2026-11-10T00:00:00Z' }, now), false);
  assert.equal(L.canReopen({ status: 'closed' }, now), false);
  assert.equal(L.canReopen(null, now), false);
  assert.equal(L.canRate({ status: 'closed' }), true);
  assert.equal(L.canRate({ status: 'open' }), false);
  assert.deepEqual([1, 5, 0, 6, 2.5, '3', null].map(L.normalizeRating), [1, 5, 0, 0, 0, 3, 0]);
});

test('mensajes del sistema: cierre y reapertura se muestran en el idioma de cada quien', () => {
  assert.equal(L.systemKind({ code: 'closed' }), 'closed');
  assert.equal(L.systemKind({ code: 'reopened' }), 'reopened');
  assert.equal(L.systemKind({ code: null }), null);
  assert.equal(L.systemKind({ code: 'otro' }), null);
  assert.equal(L.messageText({ code: 'closed', body: 'Consulta cerrada. Era un mod viejo' }), 'Era un mod viejo');
  assert.equal(L.messageText({ code: 'closed', body: 'Consulta cerrada.' }), '');
  assert.equal(L.messageText({ code: 'closed_self', body: 'Consulta cerrada.' }), '');
  assert.equal(L.messageText({ code: 'reopened', body: 'Consulta reabierta.' }), '');
  assert.equal(L.messageText({ code: 'reopened', body: 'Volvió a pasar' }), 'Volvió a pasar');
  assert.equal(L.messageText({ code: null, body: 'Consulta cerrada. a mano' }), 'Consulta cerrada. a mano');
  assert.equal(L.messageText(null), '');
});

test('cola del equipo: filtros hacia el servidor, solo con valores conocidos', () => {
  assert.deepEqual(L.buildQueueFilter(L.DEFAULT_QUEUE), { status: 'pending', sort: 'priority' });
  assert.deepEqual(L.buildQueueFilter({ status: 'waiting', category: 'game', priority: 'urgent', assigned: 'me', sort: 'oldest', search: '  crash  ' }, 2),
    { status: 'waiting', category: 'game', priority: 'urgent', assigned: 'me', sort: 'oldest', search: 'crash', page: 2 });
  assert.deepEqual(L.buildQueueFilter({ status: 'x', category: 'x', priority: 'x', assigned: 'x', sort: 'x', search: ' ' }), {});
  assert.equal(L.buildQueueFilter({ search: 'a'.repeat(100) }).search.length, 60);
  assert.equal(L.buildQueueFilter({ assigned: 'any' }).assigned, undefined);
});

test('cola del equipo: cuenta cuántos filtros se salen de los de siempre', () => {
  assert.equal(L.activeFilterCount(L.DEFAULT_QUEUE), 0);
  assert.equal(L.activeFilterCount({}), 0);
  assert.equal(L.activeFilterCount({ status: 'all' }), 1);
  assert.equal(L.activeFilterCount({ status: 'closed', category: 'game', priority: 'high', assigned: 'none', sort: 'newest', search: 'x' }), 6);
  assert.equal(L.activeFilterCount({ search: '   ' }), 0);
});

test('antigüedad de la espera: tonos a las 24 y 72 horas', () => {
  const H = 3600000;
  assert.equal(L.waitLevel(2 * H), 'ok');
  assert.equal(L.waitLevel(24 * H), 'warn');
  assert.equal(L.waitLevel(71 * H), 'warn');
  assert.equal(L.waitLevel(72 * H), 'bad');
  assert.equal(L.waitLevel(NaN), 'ok');
  assert.equal(L.waitLevel(-5), 'ok');
  const now = Date.parse('2026-11-05T12:00:00Z');
  assert.equal(L.waitingSince({ waiting: true, lastUserMessageAt: '2026-11-05T09:00:00Z' }, now), 3 * H);
  assert.equal(L.waitingSince({ waiting: false, lastUserMessageAt: '2026-11-05T09:00:00Z' }, now), null);
  assert.equal(L.waitingSince({ waiting: true }, now), null);
});

test('respuestas guardadas: se completa el nombre y no queda un hueco', () => {
  assert.equal(L.fillMacro('Hola {name}, gracias.', { name: 'Mateo' }), 'Hola Mateo, gracias.');
  assert.equal(L.fillMacro('Hola {name}, gracias.', {}), 'Hola, gracias.');
  assert.equal(L.fillMacro('Hola {name}!', { name: '' }), 'Hola!');
  assert.equal(L.fillMacro('Usá {otro} cosa', {}), 'Usá {otro} cosa');
  assert.equal(L.fillMacro(null), '');
});

test('capturas: tipo, tamaño, cantidad y escala', () => {
  assert.equal(L.validateAttachment({ type: 'image/png', size: 1000, name: 'a.png' }), null);
  assert.equal(L.validateAttachment({ type: 'image/gif', size: 1000 }), 'type');
  assert.equal(L.validateAttachment({ type: 'application/pdf', size: 1000 }), 'type');
  assert.equal(L.validateAttachment({ type: 'image/png', size: 0 }), 'empty');
  assert.equal(L.validateAttachment({ type: 'image/png', size: NaN }), 'empty');
  assert.equal(L.validateAttachment({ type: 'image/png', size: 17 * 1024 * 1024 }), 'big');
  assert.equal(L.validateAttachment({ type: 'image/png', size: 1000 }, 3), 'tooMany');
  assert.deepEqual(L.fitSize(3200, 1800), { width: 1600, height: 900 });
  assert.deepEqual(L.fitSize(800, 600), { width: 800, height: 600 });
  assert.deepEqual(L.fitSize(1000, 4000, 1600), { width: 400, height: 1600 });
  assert.deepEqual(L.fitSize(0, 10), { width: 0, height: 0 });
});

test('errores del proceso principal: cada código conocido tiene su clave', () => {
  assert.equal(L.errorKey({ code: 'too_many_open' }), 'err_too_many_open');
  assert.equal(L.errorKey({ code: 'network' }), 'err_network');
  assert.equal(L.errorKey({ code: 'algo-raro' }), 'err_server');
  assert.equal(L.errorKey(null), 'err_server');
  assert.equal(L.errorKey(new Error('x')), 'err_server');
});
