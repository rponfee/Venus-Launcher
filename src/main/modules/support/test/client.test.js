'use strict';
// Pruebas del cliente de Soporte: consultas generales, sin planes ni confirmación de pagos.
const test = require('node:test');
const assert = require('node:assert/strict');
const { rpcRequest } = require('../client');

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';

test('crear: asunto, tema y mensaje van a support_open_ticket', () => {
  assert.deepEqual(rpcRequest('create', { subject: '  No anda el chat ', category: 'assistant', message: 'Hola' }),
    ['support_open_ticket', { p_subject: 'No anda el chat', p_category: 'assistant', p_message: 'Hola' }]);
  assert.throws(() => rpcRequest('create', { subject: 'Hola', category: 'plan', message: 'x' }), { code: 'badRequest' });
  assert.throws(() => rpcRequest('create', { subject: 'ab', category: 'general', message: 'x' }), { code: 'badRequest' });
  assert.throws(() => rpcRequest('create', { subject: 'Asunto', category: 'general', message: '' }), { code: 'badRequest' });
});

test('cerrar: nunca confirma un pago', () => {
  assert.deepEqual(rpcRequest('resolve', { ticketId: ID, confirmPayment: true, note: 'listo' }),
    ['support_resolve_ticket', { p_ticket: ID, p_confirm_payment: false, p_note: 'listo' }]);
  assert.throws(() => rpcRequest('resolve', { ticketId: 'x' }), { code: 'badRequest' });
});

test('acciones desconocidas', () => {
  assert.throws(() => rpcRequest('activatePlan', {}), { code: 'badRequest' });
});
