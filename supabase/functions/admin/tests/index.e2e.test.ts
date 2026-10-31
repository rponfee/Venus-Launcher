// Prueba del index.ts real de "admin" con @supabase/supabase-js de node_modules contra un fetch falso (Supabase Auth,
// la API de administración de Auth, Storage, PostgREST y la API de Stripe): verifica los secretos que lee, los
// pedidos exactos de supabase-js (baneo, borrar cuenta y archivos) y que todo pase por la service role. Sin red.
// Arma una copia temporal con el import npm: apuntando a node_modules (en %TEMP%/venus-admin-e2e-*) y la borra al final.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ADMIN, FakeAdminDb, FakeStripe, USER } from './fakes.ts';

const SUPABASE = 'https://proyecto-prueba.supabase.co';
const env: Record<string, string> = {
  SUPABASE_URL: SUPABASE,
  SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  STRIPE_SECRET_KEY: 'sk_test_e2e0123456789',
};

function resolveOrNull(specifier: string): string | null {
  try {
    return import.meta.resolve(specifier);
  } catch {
    return null;
  }
}

const supabaseUrl = resolveOrNull('@supabase/supabase-js');
const db = new FakeAdminDb();
const stripe = new FakeStripe();
const calls: { method: string; url: string; headers: Headers; body: unknown }[] = [];
let handler: ((req: Request) => Promise<Response>) | null = null;
let workDir = '';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const authUser = (id: string, email: string) => ({
  id,
  aud: 'authenticated',
  role: 'authenticated',
  email,
  email_confirmed_at: '2026-01-01T00:00:00Z',
  is_anonymous: false,
  app_metadata: {},
  user_metadata: {},
  created_at: '2026-01-01T00:00:00Z',
});

async function fakeFetch(input: unknown, init: RequestInit = {}): Promise<Response> {
  const req = input instanceof Request ? input : null;
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (req as Request).url;
  const method = (init.method ?? req?.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers ?? req?.headers);
  if (url.startsWith('https://api.stripe.com/')) return stripe.fetch(url, init);
  let text = '';
  if (typeof init.body === 'string') text = init.body;
  else if (init.body) text = await new Response(init.body).text();
  const body = text ? JSON.parse(text) : null;
  calls.push({ method, url, headers, body });
  if (url === `${SUPABASE}/auth/v1/user`) {
    const auth = headers.get('authorization');
    if (auth === 'Bearer jwt-admin') return jsonResponse(200, authUser(ADMIN, 'admin@example.com'));
    if (auth === 'Bearer jwt-user') return jsonResponse(200, authUser(USER, 'jugador@example.com'));
    return jsonResponse(403, { code: 403, error_code: 'bad_jwt', msg: 'invalid JWT' });
  }
  let m: RegExpExecArray | null;
  if ((m = /^https:\/\/proyecto-prueba\.supabase\.co\/auth\/v1\/admin\/users\/([\w-]+)$/.exec(url))) {
    if (method === 'PUT') return jsonResponse(200, authUser(m[1], 'jugador@example.com'));
    if (method === 'DELETE') return jsonResponse(200, {});
  }
  if ((m = /^https:\/\/proyecto-prueba\.supabase\.co\/storage\/v1\/object\/([\w-]+)$/.exec(url)) && method === 'DELETE') {
    return jsonResponse(200, (body?.prefixes ?? []).map((name: string) => ({ name, bucket_id: m![1] })));
  }
  if (url.startsWith(`${SUPABASE}/rest/v1/rpc/`)) {
    const fn = url.slice(`${SUPABASE}/rest/v1/rpc/`.length).split('?')[0];
    try {
      return jsonResponse(200, await db.rpc(fn, body ?? {}));
    } catch (err) {
      return jsonResponse(404, { code: (err as { code?: string }).code ?? 'XX000', message: 'falla', details: null, hint: null });
    }
  }
  throw new TypeError(`fetch no esperado: ${method} ${url}`);
}

if (supabaseUrl) {
  workDir = mkdtempSync(join(tmpdir(), 'venus-admin-e2e-'));
  const functionsDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const copy = (fn: string, files: string[]) => {
    mkdirSync(join(workDir, fn), { recursive: true });
    for (const file of files) copyFileSync(join(functionsDir, fn, file), join(workDir, fn, file));
  };
  copy('billing', ['config.ts', 'http.ts', 'stripe.ts']);
  copy('admin', ['actions.ts', 'coupons.ts', 'errors.ts', 'handler.ts', 'prices.ts', 'stripe-admin.ts', 'validate.ts']);
  const index = readFileSync(join(functionsDir, 'admin', 'index.ts'), 'utf8').replace("'npm:@supabase/supabase-js@2'", `'${supabaseUrl}'`);
  assert.ok(!index.includes("'npm:"), 'quedaron imports npm: sin reemplazar en admin/index.ts');
  writeFileSync(join(workDir, 'admin', 'index.ts'), index);
  writeFileSync(join(workDir, 'package.json'), '{"type":"module","private":true}\n');

  (globalThis as Record<string, unknown>).Deno = {
    env: { get: (name: string) => env[name] },
    serve: (h: (req: Request) => Promise<Response>) => {
      handler = h;
      return {};
    },
  };
  (globalThis as Record<string, unknown>).fetch = fakeFetch;
  await import(pathToFileURL(join(workDir, 'admin', 'index.ts')).href);
}

after(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

const skip = supabaseUrl ? false : 'falta @supabase/supabase-js en node_modules';

async function call(action: string, payload: unknown, token = 'jwt-admin') {
  const res = await handler!(
    new Request(`${SUPABASE}/functions/v1/admin`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, apikey: 'anon-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, payload }),
    }),
  );
  return { status: res.status, body: await res.json() };
}

test('index.ts: la sesión se verifica con Auth y el permiso con la service role', { skip }, async () => {
  const res = await call('me', {});
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.result.stripe, { configured: true, mode: 'test' });
  const check = calls.find((c) => c.url === `${SUPABASE}/rest/v1/rpc/admin_is_admin_user`);
  assert.ok(check, 'no preguntó si es admin');
  assert.equal(check.headers.get('apikey'), 'service-key');
  assert.deepEqual(check.body, { p_user: ADMIN });
  const denied = await call('overview', {}, 'jwt-user');
  assert.equal(denied.status, 403);
  assert.equal((await call('me', {}, 'jwt-vencido')).status, 401);
});

test('index.ts: banear usa la API de administración de Auth (PUT ban_duration) con la service role', { skip }, async () => {
  const res = await call('users.ban', { ids: [USER], duration: '30d', reason: 'trampas' });
  assert.equal(res.status, 200);
  assert.equal(res.body.result.results[0].ok, true);
  const put = calls.find((c) => c.method === 'PUT' && c.url === `${SUPABASE}/auth/v1/admin/users/${USER}`);
  assert.ok(put, 'no llamó a la API de administración de Auth');
  assert.deepEqual(put.body, { ban_duration: '720h' });
  assert.equal(put.headers.get('apikey'), 'service-key');
  assert.equal(db.actions.at(-1)?.action, 'users.ban');
});

test('index.ts: borrar una cuenta borra sus archivos con Storage y después la cuenta con Auth', { skip }, async () => {
  const res = await call('users.delete', { ids: [USER], confirm: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.result.results[0].filesRemoved, 3);
  const storage = calls.filter((c) => c.method === 'DELETE' && c.url.startsWith(`${SUPABASE}/storage/v1/object/`));
  assert.deepEqual(
    storage.map((c) => [c.url.split('/').pop(), c.body]),
    [
      ['world-saves', { prefixes: [`${USER}/w/part1`, `${USER}/w/part2`] }],
      ['screenshots', { prefixes: [`${USER}/a.png`] }],
    ],
  );
  const del = calls.findIndex((c) => c.method === 'DELETE' && c.url === `${SUPABASE}/auth/v1/admin/users/${USER}`);
  assert.ok(del > calls.indexOf(storage[1]), 'la cuenta se borra después de los archivos');
});

test('index.ts: cupones con la clave de Stripe del entorno', { skip }, async () => {
  const res = await call('coupons.list', {});
  assert.equal(res.status, 200);
  assert.equal(res.body.result.configured, true);
  const get = stripe.callsTo('GET', '/v1/coupons')[0];
  assert.equal(get.headers.get('authorization'), 'Bearer sk_test_e2e0123456789');
  assert.equal(get.headers.get('stripe-version'), '2025-03-31.basil');
});
