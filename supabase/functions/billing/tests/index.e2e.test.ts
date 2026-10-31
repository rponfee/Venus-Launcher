// Prueba de los index.ts reales de "billing" y "stripe-webhook" con @supabase/supabase-js de node_modules
// contra un fetch falso (Supabase Auth + PostgREST + API de Stripe): verifica los secretos que leen, las
// funciones SQL que llaman y los pedidos exactos a Stripe. Sin red. Arma una copia temporal de las dos
// funciones con el import npm: apuntando a node_modules (en %TEMP%/venus-billing-e2e-*) y la borra al final.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { signatureHeader } from '../../stripe-webhook/signature.ts';
import { EMAIL, FakeDb, FakeStripe, NOW_SEC, USER, subscription } from './fakes.ts';

const SUPABASE = 'https://proyecto-prueba.supabase.co';
const WHSEC = 'whsec_e2e_secreto_0123456789';
const env: Record<string, string> = {
  SUPABASE_URL: SUPABASE,
  SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  STRIPE_SECRET_KEY: 'sk_test_e2e0123456789',
  STRIPE_WEBHOOK_SECRET: WHSEC,
  BILLING_AUTOMATIC_TAX: '1',
};

function resolveOrNull(specifier: string): string | null {
  try {
    return import.meta.resolve(specifier);
  } catch {
    return null;
  }
}

const supabaseUrl = resolveOrNull('@supabase/supabase-js');
const db = new FakeDb();
const stripe = new FakeStripe();
const supabaseCalls: { url: string; headers: Headers }[] = [];
const handlers: ((req: Request) => Promise<Response>)[] = [];
let workDir = '';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function fakeFetch(input: unknown, init: RequestInit = {}): Promise<Response> {
  const req = input instanceof Request ? input : null;
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (req as Request).url;
  const headers = new Headers(init.headers ?? req?.headers);
  if (url.startsWith('https://api.stripe.com/')) return stripe.fetch(url, init);
  supabaseCalls.push({ url, headers });
  if (url === `${SUPABASE}/auth/v1/user`) {
    const auth = headers.get('authorization');
    if (auth === 'Bearer jwt-good') {
      return jsonResponse(200, { id: USER, aud: 'authenticated', role: 'authenticated', email: EMAIL, is_anonymous: false, app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' });
    }
    if (auth === 'Bearer jwt-anon') {
      return jsonResponse(200, { id: 'anon-uuid', aud: 'authenticated', role: 'authenticated', is_anonymous: true, app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' });
    }
    return jsonResponse(403, { code: 403, error_code: 'bad_jwt', msg: 'invalid JWT' });
  }
  if (url.startsWith(`${SUPABASE}/rest/v1/rpc/`)) {
    const fn = url.slice(`${SUPABASE}/rest/v1/rpc/`.length).split('?')[0];
    let text = '';
    if (typeof init.body === 'string') text = init.body;
    else if (init.body) text = await new Response(init.body).text();
    try {
      return jsonResponse(200, await db.rpc(fn, text ? JSON.parse(text) : {}));
    } catch (err) {
      return jsonResponse(404, { code: (err as { code?: string }).code ?? 'XX000', message: 'falla', details: null, hint: null });
    }
  }
  throw new TypeError(`fetch no esperado: ${url}`);
}

if (supabaseUrl) {
  workDir = mkdtempSync(join(tmpdir(), 'venus-billing-e2e-'));
  const functionsDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const copy = (fn: string, files: string[]) => {
    mkdirSync(join(workDir, fn), { recursive: true });
    for (const file of files) copyFileSync(join(functionsDir, fn, file), join(workDir, fn, file));
    const index = readFileSync(join(functionsDir, fn, 'index.ts'), 'utf8').replace("'npm:@supabase/supabase-js@2'", `'${supabaseUrl}'`);
    assert.ok(!index.includes("'npm:"), `quedaron imports npm: sin reemplazar en ${fn}/index.ts`);
    writeFileSync(join(workDir, fn, 'index.ts'), index);
  };
  copy('billing', ['config.ts', 'http.ts', 'stripe.ts', 'sync.ts', 'handler.ts']);
  copy('stripe-webhook', ['signature.ts', 'handler.ts']);
  writeFileSync(join(workDir, 'package.json'), '{"type":"module","private":true}\n');

  (globalThis as Record<string, unknown>).Deno = {
    env: { get: (name: string) => env[name] },
    serve: (h: (req: Request) => Promise<Response>) => {
      handlers.push(h);
      return {};
    },
  };
  (globalThis as Record<string, unknown>).fetch = fakeFetch;
  await import(pathToFileURL(join(workDir, 'billing', 'index.ts')).href);
  await import(pathToFileURL(join(workDir, 'stripe-webhook', 'index.ts')).href);
}

after(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

const skip = supabaseUrl ? false : 'falta @supabase/supabase-js en node_modules';
const billing = (req: Request) => handlers[0](req);
const webhook = (req: Request) => handlers[1](req);

test('index.ts de billing: GET con la sesión real de supabase-js devuelve estado y catálogo', { skip }, async () => {
  const res = await billing(new Request(`${SUPABASE}/functions/v1/billing`, { headers: { Authorization: 'Bearer jwt-good', apikey: 'anon-key' } }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.mode, 'test');
  assert.equal(body.catalog.length, 6);
  assert.equal(body.state.plan, null);
  const rpc = supabaseCalls.find((c) => c.url === `${SUPABASE}/rest/v1/rpc/billing_state`);
  assert.ok(rpc, 'no llamó a billing_state');
  assert.equal(rpc.headers.get('apikey'), 'service-key');
  const anon = await billing(new Request(`${SUPABASE}/functions/v1/billing`, { headers: { Authorization: 'Bearer jwt-anon' } }));
  assert.equal(anon.status, 403);
  const bad = await billing(new Request(`${SUPABASE}/functions/v1/billing`, { headers: { Authorization: 'Bearer jwt-vencido' } }));
  assert.equal(bad.status, 401);
});

test('index.ts de billing: checkout con la clave y los secretos del entorno (impuestos automáticos)', { skip }, async () => {
  const res = await billing(
    new Request(`${SUPABASE}/functions/v1/billing`, {
      method: 'POST',
      headers: { Authorization: 'Bearer jwt-good', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'checkout', plan: 'supreme', locale: 'es' }),
    }),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.kind, 'checkout');
  const session = stripe.callsTo('POST', '/v1/checkout/sessions')[0];
  assert.equal(session.headers.get('authorization'), 'Bearer sk_test_e2e0123456789');
  assert.equal(session.headers.get('stripe-version'), '2025-03-31.basil');
  assert.equal(session.params['line_items[0][price]'], 'price_supreme1');
  assert.equal(session.params['automatic_tax[enabled]'], 'true');
  assert.equal(session.params.success_url, `${SUPABASE}/functions/v1/stripe-webhook?return=success`);
  assert.equal(db.customers.get(USER)?.customerId, session.params.customer);
});

test('index.ts de stripe-webhook: evento firmado -> lee la suscripción y activa el plan', { skip }, async () => {
  const customer = db.customers.get(USER)!.customerId;
  stripe.subscriptions.set('sub_E2E', subscription({ id: 'sub_E2E', customer }, { price: 'price_supreme1' }));
  const now = Math.floor(Date.now() / 1000);
  const raw = JSON.stringify({
    id: 'evt_e2e_1',
    object: 'event',
    type: 'checkout.session.completed',
    livemode: false,
    created: NOW_SEC,
    data: { object: { id: 'cs_e2e', object: 'checkout.session', mode: 'subscription', client_reference_id: USER, customer, subscription: 'sub_E2E' } },
  });
  const res = await webhook(
    new Request(`${SUPABASE}/functions/v1/stripe-webhook`, {
      method: 'POST',
      headers: { 'stripe-signature': await signatureHeader(WHSEC, now, raw), 'content-type': 'application/json' },
      body: raw,
    }),
  );
  assert.equal(res.status, 200);
  assert.equal((await res.json()).outcome, 'applied');
  assert.equal(db.subs.get(USER)?.plan_id, 'supreme');
  assert.equal(db.events.get('evt_e2e_1')?.outcome, 'applied');
  const page = await webhook(new Request(`${SUPABASE}/functions/v1/stripe-webhook?return=success`));
  assert.match(await page.text(), /Listo, volvé a Venus Launcher/);
  const unsigned = await webhook(new Request(`${SUPABASE}/functions/v1/stripe-webhook`, { method: 'POST', body: raw }));
  assert.equal(unsigned.status, 400);
});
