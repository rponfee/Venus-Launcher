// Revisión estática de supabase/migrations/0011_ai_providers.sql (sin Postgres): los precios de OpenAI y el
// mapeo de modelos son exactamente los de owner-plans.ts, la configuración por defecto coincide con config.ts,
// las tablas nuevas son solo de la service role, las funciones tienen search_path vacío y permisos justos, y el
// JSON y los renglones de uso tienen las claves que usa la Edge Function.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ANTHROPIC_MODEL_PATTERN, DEFAULT_FAILOVER_ON, FAILOVER_KINDS, MODEL_KEYS, OPENAI_EFFORTS, OPENAI_MODEL_PATTERN } from '../config.ts';
import { openaiUsageLines } from '../openai.ts';
import { parseProviderSettings } from '../providers.ts';
import { usageLines } from '../quota.ts';
import { FakeDb } from './fake-db.ts';
import { OPENAI_PRICES, TIER_FALLBACKS } from './owner-plans.ts';

function load(name: string): string {
  const raw = readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), 'utf8');
  // Sin comentarios (ningún texto entre comillas de estas migraciones tiene "--").
  return raw.replace(/--[^\n]*/g, '');
}

const SQL = load('0011_ai_providers.sql');
const SQL_0008 = load('0008_ai_plans.sql');

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

function fn(name: string): FnDef {
  const found = FNS.find((f) => f.name === name);
  assert.ok(found, `falta la función ${name}`);
  return found;
}

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

/** Literales de un array['a', 'b']::text[]. */
function arrayLiterals(text: string): string[] {
  return [...text.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

test('ai_models: columna provider y checks por proveedor (idempotentes)', () => {
  assert.match(SQL, /alter table public\.ai_models add column if not exists provider text not null default 'anthropic';/);
  // El check de 0008 (solo ids "claude-...") se busca por su definición y se reemplaza.
  assert.match(SQL, /pg_catalog\.pg_get_constraintdef\(c\.oid\) like '%model_id%'/);
  assert.match(SQL, /c\.conname <> 'ai_models_model_id_format'/);
  assert.match(SQL, /execute format\('alter table public\.ai_models drop constraint %I', v_name\);/);
  for (const name of ['ai_models_provider_check', 'ai_models_model_id_format', 'ai_models_openai_price_only', 'ai_models_id_provider_key']) {
    assert.match(SQL, new RegExp(`c\\.conname = '${name}'\\) then\\s+alter table public\\.ai_models add constraint ${name} `), name);
  }
  // Los patrones del SQL son los mismos que usa la Edge Function.
  const format = block('add constraint ai_models_model_id_format', 'end if;');
  assert.ok(format.includes(`(provider = 'anthropic' and model_id ~ '${ANTHROPIC_MODEL_PATTERN.source}')`), 'patrón de Anthropic');
  assert.ok(format.includes(`(provider = 'openai' and model_id ~ '${OPENAI_MODEL_PATTERN.source}')`), 'patrón de OpenAI');
  assert.match(SQL, /add constraint ai_models_openai_price_only check \(\s*provider = 'anthropic' or \(not active and not supports_fallback\)\s*\)/);
  assert.match(SQL, /add constraint ai_models_id_provider_key unique \(id, provider\)/);
  // El check viejo de 0008 es el que se reemplaza.
  assert.match(SQL_0008, /model_id text not null unique check \(model_id ~ '\^claude-/);
});

test('precios de OpenAI: exactamente los de owner-plans.ts, filas de solo precio', () => {
  const text = block('insert into public.ai_models', 'on conflict do nothing');
  const n = (v: string) => Number(v);
  const rows = [
    ...text.matchAll(
      /\('([a-z0-9-]+)', '([a-z0-9.-]+)', '(openai)', '([^']+)', ([\d.]+), ([\d.]+), ([\d.]+), ([\d.]+), (\d+), ([\d.]+), ([\d.]+), ([\d.]+), ([\d.]+), (true|false),\s+'[^']*', (\d+), (true|false)\)/g,
    ),
  ].map((m) => ({
    id: m[1],
    modelId: m[2],
    label: m[4],
    input: n(m[5]),
    output: n(m[6]),
    cacheRead: n(m[7]),
    cacheWrite: n(m[8]),
    long: { threshold: n(m[9]), input: n(m[10]), output: n(m[11]), cacheRead: n(m[12]), cacheWrite: n(m[13]) },
    fallback: m[14] === 'true',
    sort: n(m[15]),
    active: m[16] === 'true',
    provider: m[3],
  }));
  assert.deepEqual(rows, OPENAI_PRICES);
  for (const row of rows) {
    assert.match(row.id, /^[a-z][a-z0-9_-]{1,31}$/, row.id);
    assert.match(row.modelId, OPENAI_MODEL_PATTERN, row.modelId);
    assert.ok(row.label.length <= 40, row.label);
    // Tarifa de más de 272K: el doble la entrada y la caché, 1,5 veces la salida.
    assert.equal(row.long.input, row.input * 2, row.id);
    assert.equal(row.long.cacheRead, row.cacheRead * 2, row.id);
    assert.equal(row.long.cacheWrite, row.cacheWrite * 2, row.id);
    assert.equal(row.long.output, row.output * 1.5, row.id);
    // Escritura de caché de 30 minutos = 1,25 veces la entrada.
    assert.equal(row.cacheWrite, row.input * 1.25, row.id);
  }
  assert.match(text, /VERIFICAR/);
  assert.match(SQL, /on conflict do nothing;/, 'no pisa precios editados');
});

test('ai_tier_fallbacks: modelos equivalentes (chico, intermedio, el más capaz) y clave foránea a filas de OpenAI', () => {
  const text = block('insert into public.ai_tier_fallbacks', 'on conflict (tier) do nothing');
  const rows = [...text.matchAll(/\('([a-z]+)', '([a-z0-9-]+)', '([a-z]+)', '([a-z]+)', '([a-z]+)', '[^']*'\)/g)].map((m) => ({
    tier: m[1],
    model: m[2],
    efforts: { low: m[3], medium: m[4], high: m[5] },
  }));
  assert.deepEqual(rows, TIER_FALLBACKS);
  assert.deepEqual(rows.map((r) => r.tier), [...MODEL_KEYS]);
  for (const row of rows) {
    assert.ok(OPENAI_PRICES.some((p) => p.id === row.model), row.model);
    for (const effort of Object.values(row.efforts)) assert.ok((OPENAI_EFFORTS as readonly string[]).includes(effort), effort);
  }
  assert.match(SQL, /constraint ai_tier_fallbacks_model_fkey foreign key \(model_id, provider\)\s+references public\.ai_models \(id, provider\) on update cascade on delete restrict/);
  assert.match(SQL, /constraint ai_tier_fallbacks_provider_check check \(provider = 'openai'\)/);
  assert.match(SQL, /tier text primary key references public\.ai_models \(id\) on update cascade on delete cascade/);
  assert.match(SQL, /create index if not exists ai_tier_fallbacks_model on public\.ai_tier_fallbacks \(model_id, provider\);/);
  const allowed = block('constraint ai_tier_fallbacks_efforts_check', 'constraint ai_tier_fallbacks_model_fkey');
  assert.deepEqual([...new Set(arrayLiterals(allowed))], [...OPENAI_EFFORTS]);
});

test('ai_provider_config: Anthropic principal, OpenAI secundario, respaldo activo y las fallas de config.ts', () => {
  const table = block('create table if not exists public.ai_provider_config', ');\n');
  assert.match(table, /primary_provider text not null default 'anthropic'/);
  assert.match(table, /secondary_provider text default 'openai'/);
  assert.match(table, /failover_enabled boolean not null default true/);
  assert.match(table, /constraint ai_provider_config_single check \(id = 'default'\)/);
  assert.match(table, /secondary_provider <> primary_provider/);
  const defaults = /failover_on text\[\] not null default array\[([^\]]*)\]::text\[\]/.exec(table);
  assert.ok(defaults);
  assert.deepEqual(arrayLiterals(defaults[1]), [...DEFAULT_FAILOVER_ON]);
  const check = /failover_on <@ array\[([^\]]*)\]::text\[\]/.exec(table);
  assert.ok(check);
  assert.deepEqual(arrayLiterals(check[1]), [...FAILOVER_KINDS]);
  // Ni el rechazo de la IA ni un pedido inválido pueden activar el respaldo.
  for (const never of ['refusal', 'invalid_request', 'aborted']) assert.ok(!arrayLiterals(check[1]).includes(never), never);
  assert.match(SQL, /insert into public\.ai_provider_config \(id\) values \('default'\) on conflict \(id\) do nothing;/);
});

test('RLS: las tablas nuevas son solo de la service role (sin políticas para el cliente)', () => {
  const tables = [...SQL.matchAll(/create table if not exists public\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(tables, ['ai_tier_fallbacks', 'ai_provider_config']);
  for (const table of tables) {
    assert.match(SQL, new RegExp(`alter table public\\.${table} enable row level security;`), table);
    assert.match(SQL, new RegExp(`drop trigger if exists ${table}_touch on public\\.${table};`), table);
  }
  assert.doesNotMatch(SQL, /create policy/);
  assert.match(SQL, /revoke all on public\.ai_tier_fallbacks, public\.ai_provider_config from anon, authenticated;/);
  assert.match(SQL, /grant all on public\.ai_tier_fallbacks, public\.ai_provider_config to service_role;/);
  assert.doesNotMatch(SQL, /grant [^;]* to (anon|authenticated)/);
});

test('funciones: search_path vacío, SECURITY DEFINER y EXECUTE solo para la service role', () => {
  assert.deepEqual(FNS.map((f) => f.name).sort(), ['ai_add_usage', 'ai_provider_settings']);
  for (const f of FNS) {
    assert.match(f.header, /set search_path = ''/, f.name);
    assert.match(f.header, /security definer/, f.name);
    const signature = `public.${f.name}(${f.types})`.replace(/[.()[\]]/g, '\\$&');
    assert.match(SQL, new RegExp(`revoke all on function ${signature} from public, anon, authenticated;`), f.name);
    assert.match(SQL, new RegExp(`grant execute on function ${signature} to service_role;`), f.name);
    // Nombres calificados: ninguna tabla sin esquema (se saltean las funciones del sistema, como
    // jsonb_array_elements(...), las variables v_* y el "do update set" del upsert).
    for (const m of f.body.matchAll(/\b(?:from|join|into|update)\s+([a-z_]+\.)?([a-z_]+)\b(?!\s*\()/g)) {
      if (['set'].includes(m[2]) || m[2].startsWith('v_')) continue;
      assert.ok(m[1] === 'public.' || m[1] === 'pg_catalog.', `${f.name}: ${m[0]}`);
    }
  }
});

test('ai_provider_settings: el JSON tiene las claves que lee la Edge Function (y la base de prueba lo replica)', () => {
  const settings = fn('ai_provider_settings');
  assert.deepEqual(
    [...jsonKeys(settings.body)].sort(),
    ['efforts', 'failoverEnabled', 'failoverOn', 'high', 'low', 'medium', 'model', 'openai', 'primary', 'secondary'].sort(),
  );
  assert.match(settings.body, /join public\.ai_models m on m\.id = f\.model_id and m\.provider = 'openai'/);
  assert.match(settings.body, /where f\.active/);
  assert.match(settings.body, /left join public\.ai_provider_config c on c\.id = 'default'/);
  // La réplica de la base de prueba devuelve lo que parsea la Edge Function con los valores por defecto.
  const parsed = parseProviderSettings(new FakeDb().providerSettings());
  assert.ok(parsed);
  assert.deepEqual([parsed.primary, parsed.secondary, parsed.failoverEnabled], ['anthropic', 'openai', true]);
  assert.deepEqual([...parsed.failoverOn], [...DEFAULT_FAILOVER_ON]);
  assert.deepEqual(Object.fromEntries(Object.entries(parsed.openai).map(([k, v]) => [k, v?.model])), { haiku: 'gpt-6-luna', sonnet: 'gpt-6.1-sol', opus: 'gpt-6-astra' });
});

test('ai_add_usage: misma firma que 0008, mismas claves de renglón y el uso de OpenAI en la fila de su modelo', () => {
  const add = fn('ai_add_usage');
  const before = functions(SQL_0008).find((f) => f.name === 'ai_add_usage');
  assert.ok(before);
  // CREATE OR REPLACE no deja cambiar los nombres de los parámetros ni el tipo de retorno.
  assert.deepEqual(add.argNames, before.argNames);
  assert.equal(add.types, before.types);
  assert.equal(add.returns, before.returns);
  assert.deepEqual([...jsonKeys(add.body)].sort(), ['costUsd', 'quota', 'unpriced']);
  // Lee las mismas claves que arman usageLines (Anthropic) y openaiUsageLines (OpenAI).
  const read = new Set([...add.body.matchAll(/v_line ->>? '(\w+)'/g)].map((m) => m[1]));
  assert.deepEqual([...read].sort(), Object.keys(usageLines({ input_tokens: 1 }, 'claude-haiku-5-5')[0]).sort());
  assert.deepEqual([...read].sort(), Object.keys(openaiUsageLines({ input_tokens: 1 }, 'gpt-6-luna')[0]).sort());
  // Cada intento con el precio del modelo que lo corrió; OpenAI en su fila, Anthropic en la de la pregunta.
  assert.match(add.body, /select m\.\* into v_price from public\.ai_models m where m\.model_id = v_line_model;/);
  assert.match(add.body, /v_line_cost := public\.ai_price_line\(v_price, v_in, v_out, v_cache_read, v_cache_write\);/);
  assert.match(add.body, /v_target := case when v_price\.provider = 'openai' then v_price\.id else p_model end;/);
  assert.match(add.body, /values \(p_user, v_today, v_ids\[v_idx\], 1,/);
  assert.match(add.body, /if cardinality\(v_ids\) = 0 then\s+v_ids := array\[p_model\];/);
  // Las preguntas nunca se tocan acá (las suma ai_register_turn en el modelo de Venus).
  assert.doesNotMatch(add.body, /questions/);
});
