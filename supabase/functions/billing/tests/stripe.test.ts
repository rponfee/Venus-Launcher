// Pruebas del cliente REST de Stripe y de la configuración compartida (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StripeError, createStripeClient, encodeForm, stripePath } from '../stripe.ts';
import { STRIPE_API_VERSION, buildReturnUrls, keyMode, parseFlag, parseGraceDays, parseSecrets, returnPage, stripeLocale } from '../config.ts';

test('encodeForm: anidado como lo espera Stripe, sin null/undefined', () => {
  const body = encodeForm({
    mode: 'subscription',
    line_items: [{ price: 'price_1', quantity: 1 }],
    subscription_data: { metadata: { user_id: 'u-1', plan_id: 'pro' } },
    allow_promotion_codes: true,
    expand: ['latest_invoice'],
    skip: null,
    nada: undefined,
    texto: 'a b&c=d/ñ',
  });
  assert.equal(
    body,
    'mode=subscription&line_items[0][price]=price_1&line_items[0][quantity]=1' +
      '&subscription_data[metadata][user_id]=u-1&subscription_data[metadata][plan_id]=pro' +
      '&allow_promotion_codes=true&expand[0]=latest_invoice&texto=a%20b%26c%3Dd%2F%C3%B1',
  );
  const parsed = new URLSearchParams(body);
  assert.equal(parsed.get('texto'), 'a b&c=d/ñ');
  assert.equal(parsed.get('line_items[0][price]'), 'price_1');
  assert.equal(encodeForm(null), '');
});

test('stripePath valida y codifica ids', () => {
  assert.equal(stripePath('/v1/subscriptions/', 'sub_123'), '/v1/subscriptions/sub_123');
  assert.throws(() => stripePath('/v1/subscriptions/', '../customers'), StripeError);
  assert.throws(() => stripePath('/v1/subscriptions/', 'sub_1?expand=x'), StripeError);
});

function fakeFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    fetch: async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return respond(url, init);
    },
  };
}

test('cliente: GET con parámetros en la URL, cabeceras de Stripe y versión fija', async () => {
  const f = fakeFetch(() => new Response(JSON.stringify({ id: 'sub_1', object: 'subscription' }), { status: 200 }));
  const stripe = createStripeClient({ secretKey: 'sk_test_abc12345678', fetch: f.fetch });
  const sub = await stripe.get('/v1/subscriptions/sub_1', { expand: ['latest_invoice'] });
  assert.equal(sub.id, 'sub_1');
  assert.equal(f.calls[0].url, 'https://api.stripe.com/v1/subscriptions/sub_1?expand[0]=latest_invoice');
  const h = new Headers(f.calls[0].init.headers);
  assert.equal(h.get('authorization'), 'Bearer sk_test_abc12345678');
  assert.equal(h.get('stripe-version'), STRIPE_API_VERSION);
  assert.equal(h.get('content-type'), null);
  assert.equal(f.calls[0].init.body, undefined);
  assert.ok(f.calls[0].init.signal instanceof AbortSignal);
});

test('cliente: POST form-encoded con Idempotency-Key', async () => {
  const f = fakeFetch(() => new Response(JSON.stringify({ id: 'cus_1' }), { status: 200 }));
  const stripe = createStripeClient({ secretKey: 'sk_test_abc12345678', fetch: f.fetch });
  await stripe.post('/v1/customers', { email: 'a@b.c', metadata: { user_id: 'u' } }, { idempotencyKey: 'clave-1' });
  const h = new Headers(f.calls[0].init.headers);
  assert.equal(f.calls[0].url, 'https://api.stripe.com/v1/customers');
  assert.equal(f.calls[0].init.method, 'POST');
  assert.equal(h.get('content-type'), 'application/x-www-form-urlencoded');
  assert.equal(h.get('idempotency-key'), 'clave-1');
  assert.equal(f.calls[0].init.body, 'email=a%40b.c&metadata[user_id]=u');
});

test('cliente: errores de Stripe sin su mensaje (puede traer datos del cliente)', async () => {
  const f = fakeFetch(
    () =>
      new Response(JSON.stringify({ error: { type: 'card_error', code: 'card_declined', param: 'source', message: 'Tarjeta de juan@x.com rechazada' } }), {
        status: 402,
        headers: { 'request-id': 'req_123' },
      }),
  );
  const stripe = createStripeClient({ secretKey: 'sk_test_abc12345678', fetch: f.fetch });
  await assert.rejects(stripe.post('/v1/customers', {}), (err: unknown) => {
    assert.ok(err instanceof StripeError);
    assert.equal(err.status, 402);
    assert.equal(err.type, 'card_error');
    assert.equal(err.code, 'card_declined');
    assert.equal(err.param, 'source');
    assert.equal(err.requestId, 'req_123');
    assert.equal(err.retryable, false);
    assert.doesNotMatch(`${err.message} ${err.describe()}`, /juan@x\.com/);
    return true;
  });
});

test('cliente: 404 = missing, 5xx y red = reintentable, ruta inválida rechazada', async () => {
  const notFound = createStripeClient({
    secretKey: 'sk_test_abc12345678',
    fetch: async () => new Response(JSON.stringify({ error: { type: 'invalid_request_error', code: 'resource_missing' } }), { status: 404 }),
  });
  await assert.rejects(notFound.get('/v1/customers/cus_x'), (err: StripeError) => err.missing && !err.retryable);
  const down = createStripeClient({ secretKey: 'sk_test_abc12345678', fetch: async () => new Response('<html>', { status: 503 }) });
  await assert.rejects(down.get('/v1/customers/cus_x'), (err: StripeError) => err.status === 503 && err.retryable);
  const offline = createStripeClient({
    secretKey: 'sk_test_abc12345678',
    fetch: async () => {
      throw new TypeError('fetch failed');
    },
  });
  await assert.rejects(offline.get('/v1/customers/cus_x'), (err: StripeError) => err.status === 0 && err.type === 'network_error' && err.retryable);
  await assert.rejects(down.get('https://evil.example/v1/x'), (err: StripeError) => err.code === 'invalid_path');
});

test('config: modo de la clave, secretos, gracia y banderas', () => {
  assert.equal(keyMode('sk_live_51Habc123456'), 'live');
  assert.equal(keyMode('rk_live_51Habc123456'), 'live');
  assert.equal(keyMode('sk_test_51Habc123456'), 'test');
  assert.equal(keyMode('pk_test_51Habc123456'), null);
  assert.equal(keyMode(''), null);
  assert.deepEqual(parseSecrets(' whsec_abcdefgh123, whsec_zyxw98765 basura'), ['whsec_abcdefgh123', 'whsec_zyxw98765']);
  assert.deepEqual(parseSecrets(undefined), []);
  assert.equal(parseGraceDays(undefined), 3);
  assert.equal(parseGraceDays('7'), 7);
  assert.equal(parseGraceDays('0'), 0);
  assert.equal(parseGraceDays('-1'), 3);
  assert.equal(parseGraceDays('mucho'), 3);
  assert.equal(parseGraceDays('400'), 30);
  assert.equal(parseFlag('1'), true);
  assert.equal(parseFlag('sí'), true);
  assert.equal(parseFlag('0'), false);
  assert.equal(parseFlag(undefined), false);
});

test('config: URLs de vuelta (BILLING_RETURN_URL o la página pública de stripe-webhook)', () => {
  assert.deepEqual(buildReturnUrls('', 'https://abc.supabase.co/'), {
    success: 'https://abc.supabase.co/functions/v1/stripe-webhook?return=success',
    cancel: 'https://abc.supabase.co/functions/v1/stripe-webhook?return=cancel',
    portal: 'https://abc.supabase.co/functions/v1/stripe-webhook?return=portal',
  });
  assert.deepEqual(buildReturnUrls('https://venus.example/pagos?src=app#x', 'https://abc.supabase.co'), {
    success: 'https://venus.example/pagos?src=app&return=success#x',
    cancel: 'https://venus.example/pagos?src=app&return=cancel#x',
    portal: 'https://venus.example/pagos?src=app&return=portal#x',
  });
  // http solo en la máquina local (pruebas con supabase functions serve).
  assert.equal(buildReturnUrls('http://127.0.0.1:54321/functions/v1/stripe-webhook', null)?.success, 'http://127.0.0.1:54321/functions/v1/stripe-webhook?return=success');
  // Inválidas: se usa la de Supabase; sin ninguna, null. SUPABASE_URL local de Docker (http://kong:8000) no sirve.
  assert.equal(buildReturnUrls('http://venus.example/pagos', 'https://abc.supabase.co')?.cancel, 'https://abc.supabase.co/functions/v1/stripe-webhook?return=cancel');
  assert.equal(buildReturnUrls('javascript:alert(1)', null), null);
  assert.equal(buildReturnUrls('', 'http://kong:8000'), null);
});

test('config: página de vuelta en texto plano', async () => {
  const ok = returnPage(new Request('https://abc.supabase.co/functions/v1/billing?return=success'));
  assert.ok(ok);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type') ?? '', /^text\/plain/);
  assert.match(await ok.text(), /^Listo, volvé a Venus Launcher/);
  assert.match(await returnPage(new Request('https://x.co/f?return=cancel'))!.text(), /No se hizo ningún cobro/);
  assert.match(await returnPage(new Request('https://x.co/f?return=portal'))!.text(), /Listo, volvé a Venus Launcher/);
  assert.equal(returnPage(new Request('https://x.co/f?return=otra')), null);
  assert.equal(returnPage(new Request('https://x.co/f')), null);
  assert.equal(returnPage(new Request('https://x.co/f?return=success', { method: 'POST', body: '{}' })), null);
});

test('config: idioma del launcher -> idioma de Stripe', () => {
  assert.equal(stripeLocale('es'), 'es-419');
  assert.equal(stripeLocale('pt'), 'pt-BR');
  assert.equal(stripeLocale('en'), 'en');
  assert.equal(stripeLocale('uk'), 'auto');
  assert.equal(stripeLocale(undefined), 'auto');
});
