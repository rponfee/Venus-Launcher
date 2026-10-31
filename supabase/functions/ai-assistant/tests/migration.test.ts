// Revisión estática de supabase/migrations/0008_ai_plans.sql (sin Postgres): la carga de planes y precios
// es exactamente la tabla del dueño, las tablas tienen RLS, las funciones tienen search_path vacío y los
// permisos justos, y el JSON que arma el SQL tiene las claves que lee la Edge Function.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FALLBACK_MODELS, MODEL_KEYS } from '../config.ts';
import { DENIAL_MESSAGES, usageLines } from '../quota.ts';
import { MODEL_PRICES, OWNER_PLANS } from './owner-plans.ts';

function load(name: string): string {
  const raw = readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), 'utf8');
  // Sin comentarios (ningún texto entre comillas de estas migraciones tiene "--").
  return raw.replace(/--[^\n]*/g, '');
}

const SQL = load('0008_ai_plans.sql');
const SQL_0007 = load('0007_ai.sql');

interface FnDef {
  name: string;
  argNames: string[];
  types: string;
  returns: string;
  header: string;
  body: string;
}

function functions(sql: string): FnDef[] {
  const out: FnDef[] = [];
  const re = /create or replace function public\.(\w+)\(([^)]*)\)([\s\S]*?)\bas \$\$([\s\S]*?)\$\$;/g;
  for (const m of sql.matchAll(re)) {
    const args = m[2].split(',').map((a) => a.trim()).filter(Boolean).map((a) => a.split(/\s+/));
    out.push({
      name: m[1],
      argNames: args.map((a) => a[0]),
      types: args.map((a) => a.slice(1).join(' ')).join(', '),
      returns: (/returns\s+([\w.[\]]+)/.exec(m[3]) ?? [])[1] ?? '',
      header: m[3],
      body: m[4],
    });
  }
  return out;
}

const FNS = functions(SQL);

function fn(name: string, types?: string): FnDef {
  const found = FNS.find((f) => f.name === name && (types === undefined || f.types === types));
  assert.ok(found, `falta la función ${name}(${types ?? ''})`);
  return found;
}

/** Bloque de un insert: desde `start` hasta `end`. */
function block(start: string, end: string): string {
  const i = SQL.indexOf(start);
  assert.ok(i >= 0, `no está: ${start}`);
  const j = SQL.indexOf(end, i);
  assert.ok(j > i, `no está: ${end}`);
  return SQL.slice(i, j);
}

/** Claves de todos los jsonb_build_object(...) de un texto. */
function jsonKeys(text: string): Set<string> {
  const keys = new Set<string>();
  for (const m of text.matchAll(/jsonb_build_object\(/g)) {
    let depth = 0;
    let k = (m.index ?? 0) + 'jsonb_build_object'.length;
    const start = k;
    for (; k < text.length; k++) {
      if (text[k] === '(') depth++;
      else if (text[k] === ')' && --depth === 0) break;
    }
    // Pares 'clave', valor: la clave es el literal al principio o después de una coma de primer nivel.
    const inner = text.slice(start + 1, k);
    let level = 0;
    let piece = '';
    const pieces: string[] = [];
    for (const ch of inner) {
      if (ch === '(') level++;
      if (ch === ')') level--;
      if (ch === ',' && level === 0) {
        pieces.push(piece);
        piece = '';
      } else piece += ch;
    }
    pieces.push(piece);
    for (let p = 0; p < pieces.length; p += 2) {
      const key = /^\s*'([A-Za-z]+)'\s*$/.exec(pieces[p]);
      if (key) keys.add(key[1]);
    }
  }
  return keys;
}

test('la carga de ai_plans es exactamente la tabla del dueño', () => {
  const text = block('insert into public.ai_plans as p', 'on conflict (id) do update');
  const rows = [...text.matchAll(/\('([a-z]+)', '([^']+)', '(claude-[a-z0-9-]+)', (\d+), (\d+), (\d+), (\d+), (\d+), (\d+), (true|false), ([\d.]+), ([\d.]+), '([A-Z]{3})'\)/g)].map(
    (m) => ({
      id: m[1],
      name: m[2],
      legacyModel: m[3],
      legacy: [Number(m[4]), Number(m[5])],
      maxTokens: Number(m[6]),
      maxCallsPerTurn: Number(m[7]),
      rpm: Number(m[8]),
      sort: Number(m[9]),
      active: m[10] === 'true',
      priceUsd: Number(m[11]),
      budgetUsd: Number(m[12]),
      currency: m[13],
    }),
  );
  assert.deepEqual(
    rows,
    OWNER_PLANS.map((p) => ({
      id: p.id,
      name: p.name,
      legacyModel: p.legacyModel,
      legacy: [0, 0],
      maxTokens: p.maxTokens,
      maxCallsPerTurn: p.maxCallsPerTurn,
      rpm: p.rpm,
      sort: p.sort,
      active: true,
      priceUsd: p.priceUsd,
      budgetUsd: p.budgetUsd,
      currency: 'USD',
    })),
  );
  // Volver a aplicar no pisa planes editados; los provisorios de 0007 se desactivan.
  assert.match(SQL, /on conflict \(id\) do update[\s\S]*?where p\.price_usd = 0 and p\.monthly_budget_usd = 0;/);
  assert.match(SQL, /update public\.ai_plans\s+set active = false\s+where id in \('free', 'plus'\)/);
});

test('la carga de ai_plan_models es exactamente la tabla del dueño', () => {
  const text = block('insert into public.ai_plan_models', 'on conflict (plan_id, model_id) do nothing');
  const rows = [...text.matchAll(/\('([a-z]+)', '([a-z]+)', array\[([^\]]*)\], (\d+), (\d+), (\d+)\)/g)].map((m) => ({
    plan: m[1],
    model: m[2],
    efforts: m[3].split(',').map((e) => e.trim().replace(/'/g, '')),
    daily: Number(m[4]),
    weekly: Number(m[5]),
    sort: Number(m[6]),
  }));
  const expected = OWNER_PLANS.flatMap((p) => p.models.map((m) => ({ plan: p.id, model: m.model, efforts: m.efforts, daily: m.daily, weekly: m.weekly, sort: m.sort })));
  assert.deepEqual(rows, expected);
  assert.equal(rows.length, 13);
  // Solo carga los modelos de un plan que todavía no tiene ninguno.
  assert.match(text, /where not exists \(select 1 from public\.ai_plan_models pm where pm\.plan_id = v\.plan_id\)/);
});

test('precios de ai_models: lista de octubre de 2026 y filas de solo precio para los reintentos', () => {
  const text = block('insert into public.ai_models', 'on conflict (id) do nothing');
  const n = (v: string) => (v === 'null' ? null : Number(v));
  const rows = [
    ...text.matchAll(
      /\('([a-z0-9-]+)', '(claude-[a-z0-9-]+)', '([^']+)', ([\d.]+), ([\d.]+), ([\d.]+), ([\d.]+), (null|\d+), (null|[\d.]+), (null|[\d.]+), (null|[\d.]+), (null|[\d.]+), (true|false),\s+(null|'[^']*'), (\d+), (true|false)\)/g,
    ),
  ].map((m) => ({
    id: m[1],
    modelId: m[2],
    label: m[3],
    input: Number(m[4]),
    output: Number(m[5]),
    cacheRead: Number(m[6]),
    cacheWrite: Number(m[7]),
    long: m[8] === 'null' ? null : { threshold: n(m[8]), input: n(m[9]), output: n(m[10]), cacheRead: n(m[11]), cacheWrite: n(m[12]) },
    fallback: m[13] === 'true',
    sort: Number(m[15]),
    active: m[16] === 'true',
  }));
  assert.deepEqual(rows, MODEL_PRICES);
  // Lo que se ofrece en los planes es lo que acepta el protocolo; fallbacks solo en Opus y Sonnet 5.5.
  assert.deepEqual(rows.filter((r) => r.active).map((r) => r.id), [...MODEL_KEYS]);
  assert.deepEqual(rows.filter((r) => r.fallback).map((r) => r.modelId).sort(), [...FALLBACK_MODELS].sort());
  // La caché de Haiku figura como estimada.
  assert.match(text, /'haiku'[\s\S]*?ESTIMADOS, verificar/);
});

test('zona horaria de Buenos Aires para el día, la semana (lunes) y el mes', () => {
  assert.match(fn('ai_quota_tz').body, /^\s*select 'America\/Argentina\/Buenos_Aires'::text\s*$/);
  const status = fn('ai_quota_status').body;
  assert.match(status, /v_week date := date_trunc\('week', v_now\)::date/);
  assert.match(status, /v_month date := date_trunc\('month', v_now\)::date/);
  assert.match(status, /'daily', public\.ai_iso\(\(v_today \+ 1\)::timestamp at time zone v_tz\)/);
  assert.match(status, /'weekly', public\.ai_iso\(\(v_week \+ 7\)::timestamp at time zone v_tz\)/);
  assert.match(status, /'monthly', public\.ai_iso\(\(v_month \+ interval '1 month'\) at time zone v_tz\)/);
});

test('RLS en todas las tablas nuevas, y el cliente solo puede leer', () => {
  const tables = [...SQL.matchAll(/create table if not exists public\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(tables, ['ai_models', 'ai_plan_models', 'ai_usage_model_daily']);
  for (const table of tables) {
    assert.match(SQL, new RegExp(`alter table public\\.${table} enable row level security;`), table);
    assert.match(SQL, new RegExp(`create policy "\\w+" on public\\.${table}\\s+for select to authenticated using`), table);
  }
  assert.match(SQL, /revoke all on public\.ai_models, public\.ai_plan_models, public\.ai_usage_model_daily from anon, authenticated;/);
  assert.match(SQL, /grant select on public\.ai_models, public\.ai_plan_models, public\.ai_usage_model_daily to authenticated;/);
  assert.doesNotMatch(SQL, /for (insert|update|delete|all) to/, 'ninguna política de escritura');
  assert.match(SQL, /"ai_usage_model_daily_select_own"[\s\S]*?using \(\(select auth\.uid\(\)\) = user_id\)/);
});

test('funciones: search_path vacío, EXECUTE solo para la service role (salvo ai_my_quota)', () => {
  assert.ok(FNS.length >= 15);
  for (const f of FNS) {
    assert.match(f.header, /set search_path = ''/, `${f.name}: search_path`);
    const revokeFrom = f.name === 'ai_my_quota' ? 'public, anon' : 'public, anon, authenticated';
    const grantTo = f.name === 'ai_my_quota' ? 'authenticated, service_role' : 'service_role';
    const signature = `public.${f.name}(${f.types})`.replace(/[.()[\]]/g, '\\$&');
    assert.match(SQL, new RegExp(`revoke all on function ${signature} from ${revokeFrom};`), `${f.name}(${f.types}): revoke`);
    assert.match(SQL, new RegExp(`grant execute on function ${signature} to ${grantTo};`), `${f.name}(${f.types}): grant`);
  }
  const grants = [...SQL.matchAll(/grant execute on function public\.(\w+)\([^)]*\) to ([^;]+);/g)];
  assert.deepEqual(grants.filter((g) => /authenticated/.test(g[2])).map((g) => g[1]), ['ai_my_quota']);
  assert.ok(!grants.some((g) => /\banon\b/.test(g[2])), 'nada para anon');
  // Las que leen o escriben tablas con datos de usuarios son SECURITY DEFINER.
  for (const name of ['ai_effective_plan', 'ai_quota_status', 'ai_catalog', 'ai_register_turn', 'ai_release_turn', 'ai_add_usage', 'ai_my_quota']) {
    for (const f of FNS.filter((x) => x.name === name)) assert.match(f.header, /security definer/, name);
  }
});

test('las funciones que reemplazan a las de 0007 mantienen nombres de parámetros y tipo de retorno', () => {
  const old = functions(SQL_0007);
  let replaced = 0;
  for (const f of FNS) {
    const before = old.find((o) => o.name === f.name && o.types === f.types);
    if (!before) continue;
    replaced++;
    assert.deepEqual(f.argNames, before.argNames, `${f.name}: CREATE OR REPLACE no deja cambiar los nombres de los parámetros`);
    assert.equal(f.returns, before.returns, `${f.name}: CREATE OR REPLACE no deja cambiar el tipo de retorno`);
  }
  assert.equal(replaced, 6, 'ai_quota_tz, ai_effective_plan, ai_quota_status, ai_register_turn (2 args), ai_release_turn y ai_my_quota');
  // La versión de 0007 de ai_register_turn queda, pero rechaza siempre.
  const legacy = fn('ai_register_turn', 'uuid, text');
  assert.match(legacy.body, /'allowed', false/);
});

test('el JSON del SQL tiene las claves que lee la Edge Function', () => {
  const register = fn('ai_register_turn', 'uuid, text, text, text');
  assert.deepEqual([...jsonKeys(register.body)].sort(), ['allowed', 'counted', 'effort', 'fallback', 'maxTokensPerRequest', 'model', 'modelId', 'quota', 'reason'].sort());
  // Los motivos de rechazo del SQL son exactamente los que conoce el protocolo.
  const reasons = new Set<string>();
  for (const m of register.body.matchAll(/v_reason := ([^;]+);/g)) for (const lit of m[1].matchAll(/'([a-z_]+)'/g)) reasons.add(lit[1]);
  assert.deepEqual([...reasons].sort(), Object.keys(DENIAL_MESSAGES).sort());

  const status = fn('ai_quota_status');
  assert.deepEqual(
    [...jsonKeys(status.body)].sort(),
    ['budget', 'daily', 'efforts', 'id', 'label', 'lastModel', 'limit', 'limitUsd', 'model', 'models', 'monthly', 'plan', 'planName', 'priceUsd', 'resets', 'status', 'timezone', 'used', 'usedUsd', 'weekly'].sort(),
  );
  const catalog = fn('ai_catalog');
  assert.deepEqual([...jsonKeys(catalog.body)].sort(), ['budgetUsd', 'daily', 'efforts', 'id', 'label', 'models', 'name', 'priceUsd', 'weekly'].sort());

  // ai_add_usage lee del renglón de uso las mismas claves que arma usageLines().
  const add = fn('ai_add_usage');
  assert.deepEqual([...jsonKeys(add.body)].sort(), ['costUsd', 'quota', 'unpriced']);
  const read = new Set([...add.body.matchAll(/v_line ->>? '(\w+)'/g)].map((m) => m[1]));
  const line = usageLines({ input_tokens: 1 }, 'claude-haiku-5-5')[0];
  assert.deepEqual([...read].sort(), Object.keys(line).sort());
});

test('el costo usa los precios de ai_models y la tarifa de contexto largo por pedido', () => {
  const price = fn('ai_price_line');
  assert.match(price.body, /\(p_model\)\.long_context_threshold is not null/);
  assert.match(price.body, /coalesce\(p_input, 0\) \+ coalesce\(p_cache_read, 0\) \+ coalesce\(p_cache_write, 0\) > \(p_model\)\.long_context_threshold/);
  for (const col of ['input', 'output', 'cache_read', 'cache_write']) {
    assert.match(price.body, new RegExp(`\\(p_model\\)\\.long_${col}_usd_mtok`), col);
    assert.match(price.body, new RegExp(`\\(p_model\\)\\.${col}_usd_mtok`), col);
  }
  const add = fn('ai_add_usage').body;
  assert.match(add, /select m\.\* into v_price from public\.ai_models m where m\.model_id = v_line_model;/);
  assert.match(add, /v_cost := v_cost \+ public\.ai_price_line\(v_price, v_in, v_out, v_cache_read, v_cache_write\);/);
});
