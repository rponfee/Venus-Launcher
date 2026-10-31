// Pruebas de errors.ts (node --test, ver supabase/functions/README.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanDetail, failureLogLine, mapUpstreamError } from '../errors.ts';
import type { UpstreamFailure } from '../errors.ts';

function status(code: number, type: string | null = null, detail: string | null = null): UpstreamFailure {
  return { kind: 'status', status: code, type, detail, requestId: 'req_123' };
}

test('saturación y caídas de Anthropic: 503 y se devuelve la consulta', () => {
  for (const [code, type, expected] of [
    [429, 'rate_limit_error', 'upstream_rate_limited'],
    [529, 'overloaded_error', 'upstream_overloaded'],
    [500, 'api_error', 'upstream_unavailable'],
    [503, null, 'upstream_unavailable'],
    [504, 'timeout_error', 'upstream_timeout'],
  ] as const) {
    const mapped = mapUpstreamError(status(code, type));
    assert.equal(mapped.status, 503, `${code}`);
    assert.equal(mapped.body.error, 'upstream');
    assert.equal(mapped.body.code, expected);
    assert.equal(mapped.release, true);
    assert.equal(mapped.log, 'warn');
  }
});

test('problemas de configuración del servidor: 502, sin devolver la consulta y con log de error', () => {
  for (const [code, type, expected] of [
    [401, 'authentication_error', 'upstream_auth'],
    [403, 'permission_error', 'upstream_permission'],
    [404, 'not_found_error', 'upstream_model'],
  ] as const) {
    const mapped = mapUpstreamError(status(code, type));
    assert.equal(mapped.status, 502, `${code}`);
    assert.equal(mapped.body.code, expected);
    assert.equal(mapped.release, false);
    assert.equal(mapped.log, 'error');
  }
  const beta = mapUpstreamError(status(400, 'invalid_request_error', 'Unexpected value(s) `x` for the `anthropic-beta` header.'));
  assert.equal(beta.status, 502);
  assert.equal(beta.body.code, 'upstream_config');
});

test('sin crédito en Anthropic: 503 sin mostrar el detalle', () => {
  for (const failure of [
    status(402, 'billing_error', 'Your credit balance is too low'),
    status(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API.'),
  ]) {
    const mapped = mapUpstreamError(failure);
    assert.equal(mapped.status, 503);
    assert.equal(mapped.body.code, 'upstream_billing');
    assert.doesNotMatch(mapped.body.message, /credit/i);
    assert.equal(mapped.release, false);
  }
});

test('pedido inválido para la API: 400 bad_request con el detalle recortado', () => {
  const mapped = mapUpstreamError(status(400, 'invalid_request_error', 'messages.1: tool_use ids were found without tool_result blocks'));
  assert.equal(mapped.status, 400);
  assert.equal(mapped.body.error, 'bad_request');
  assert.match(mapped.body.message, /^La IA rechazó el pedido: messages\.1: tool_use ids/);
  assert.equal(mapped.release, false);
  assert.equal(mapped.log, null);
  const tooLarge = mapUpstreamError(status(413, 'request_too_large', null));
  assert.equal(tooLarge.status, 400);
  assert.equal(tooLarge.body.message, 'La IA rechazó el pedido.');
});

test('red, plazo vencido, cancelación y errores desconocidos', () => {
  const timeout = mapUpstreamError({ kind: 'timeout' });
  assert.equal(timeout.status, 503);
  assert.equal(timeout.body.code, 'upstream_timeout');
  assert.equal(timeout.release, false, 'la IA pudo haber procesado (y cobrado) el pedido');
  const network = mapUpstreamError({ kind: 'connection' });
  assert.equal(network.status, 502);
  assert.equal(network.body.code, 'upstream_network');
  const aborted = mapUpstreamError({ kind: 'aborted' });
  assert.equal(aborted.body.code, 'aborted');
  assert.equal(aborted.log, null);
  const unknown = mapUpstreamError({ kind: 'unknown', name: 'TypeError' });
  assert.equal(unknown.status, 502);
  assert.equal(unknown.body.code, 'upstream_error');
});

test('nunca responde 401, 404 ni 429 por fallas de Anthropic', () => {
  const reserved = new Set([401, 404, 429]);
  for (let code = 400; code < 600; code++) {
    assert.ok(!reserved.has(mapUpstreamError(status(code)).status), `status ${code}`);
  }
  for (const kind of ['timeout', 'aborted', 'connection', 'unknown'] as const) {
    assert.ok(!reserved.has(mapUpstreamError({ kind }).status), kind);
  }
});

test('cleanDetail limpia caracteres de control y recorta', () => {
  assert.equal(cleanDetail('hola\n\tmundo\u0000!'), 'hola mundo !');
  assert.equal(cleanDetail(42), '');
  const long = cleanDetail('x'.repeat(500));
  assert.equal(long.length, 300);
  assert.ok(long.endsWith('…'));
});

test('las líneas de log no incluyen el detalle (puede citar contenido del pedido)', () => {
  const failure = status(400, 'invalid_request_error', 'texto secreto del usuario');
  const line = failureLogLine(failure, mapUpstreamError(failure));
  assert.doesNotMatch(line, /secreto/);
  assert.match(line, /status=400/);
  assert.match(line, /request_id=req_123/);
});
