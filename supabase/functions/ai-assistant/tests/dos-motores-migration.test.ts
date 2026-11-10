// Revisión estática de supabase/migrations/0056_ia_dos_motores.sql (sin Postgres): los diez planes son exactamente
// la tabla del dueño (docs/implementacion/ia-dos-motores.md), cada clave de modelo tiene su modelo en los dos
// motores, las funciones tienen search_path vacío y permisos justos, la clave de Anthropic solo la lee la service
// role, y la respuesta de ai_register_turn conserva lo que exige la Edge Function de la 6.0.0 (modelId de Claude).
// Los escenarios contra una base real están en supabase/tests/ia-dos-motores-rollback.sql.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const RAW = readFileSync(new URL('../../../migrations/0056_ia_dos_motores.sql', import.meta.url), 'utf8');
// Sin comentarios (ningún texto entre comillas de esta migración tiene "--").
const SQL = RAW.replace(/--[^\n]*/g, '');

// Tabla del dueño: [id, motor, nivel, precio, saldo, tokens por respuesta, modelos, esfuerzos]
const PLANS: [string, string, string, number, number, number, string[], string[]][] = [
  ['basic', 'openai', 'basic', 6, 3.5, 12000, ['haiku'], ['low']],
  ['go', 'openai', 'go', 10, 6.75, 32000, ['haiku'], ['low', 'medium', 'high']],
  ['pro', 'openai', 'pro', 18, 12.5, 44000, ['haiku'], ['low', 'medium', 'high']],
  ['max', 'openai', 'max', 32, 26, 78000, ['haiku', 'sonnet'], ['low', 'medium', 'high']],
  ['ultra', 'openai', 'ultra', 40, 28, 128000, ['haiku', 'sonnet'], ['low', 'medium', 'high']],
  ['claude_basic', 'anthropic', 'basic', 6, 3.5, 12000, ['haiku'], ['low', 'medium']],
  ['claude_go', 'anthropic', 'go', 10, 6.75, 32000, ['haiku'], ['low', 'medium', 'high']],
  ['claude_pro', 'anthropic', 'pro', 18, 12.5, 44000, ['haiku', 'sonnet'], ['low', 'medium', 'high']],
  ['claude_max', 'anthropic', 'max', 32, 26, 78000, ['haiku', 'sonnet'], ['low', 'medium', 'high', 'xhigh']],
  ['claude_ultra', 'anthropic', 'ultra', 40, 32, 128000, ['haiku', 'sonnet'], ['low', 'medium', 'high', 'xhigh', 'max']],
];

function rows(table: string): string[][] {
  const start = SQL.indexOf(`insert into public.${table} (`);
  assert.ok(start >= 0, `falta el insert de ${table}`);
  const values = SQL.indexOf('values', start);
  const end = SQL.indexOf(';', values);
  const body = SQL.slice(values + 6, end).split(/on conflict/)[0];
  const out: string[][] = [];
  for (const m of body.matchAll(/\(\s*('[^\n]*?)\)\s*(?:,|$)/gm)) {
    // Separa por comas que no están dentro de array[...]
    const cells: string[] = [];
    let depth = 0;
    let cur = '';
    for (const ch of m[1]) {
      if (ch === '[') depth++;
      if (ch === ']') depth--;
      if (ch === ',' && depth === 0) {
        cells.push(cur.trim());
        cur = '';
      } else cur += ch;
    }
    cells.push(cur.trim());
    out.push(cells);
  }
  return out;
}

const unquote = (s: string) => s.replace(/^'|'$/g, '');
const list = (s: string) => [...s.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);

test('los diez planes son la tabla del dueño (precio, saldo, tokens, motor y nivel)', () => {
  const got = rows('ai_plans');
  assert.equal(got.length, 10);
  for (const [id, provider, tier, price, budget, tokens] of PLANS) {
    const row = got.find((r) => unquote(r[0]) === id);
    assert.ok(row, `falta el plan ${id}`);
    // id, name, model, ai_provider, tier, price_usd, monthly_budget_usd, max_tokens_per_request, ...
    assert.equal(unquote(row[3]), provider, `${id}: motor`);
    assert.equal(unquote(row[4]), tier, `${id}: nivel`);
    assert.equal(Number(row[5]), price, `${id}: precio`);
    assert.equal(Number(row[6]), budget, `${id}: saldo`);
    assert.equal(Number(row[7]), tokens, `${id}: tokens por respuesta`);
    assert.match(unquote(row[2]), provider === 'anthropic' ? /^claude-/ : /^gpt-/, `${id}: modelo de referencia`);
    assert.ok(price > budget, `${id}: el precio tiene que ser mayor que el saldo`);
  }
});

test('modelos y esfuerzos de cada plan', () => {
  const got = rows('ai_plan_models');
  for (const [id, , , , , , models, efforts] of PLANS) {
    const mine = got.filter((r) => unquote(r[0]) === id);
    assert.deepEqual(mine.map((r) => unquote(r[1])).sort(), [...models].sort(), `${id}: modelos`);
    for (const r of mine) assert.deepEqual(list(r[2]), efforts, `${id}/${unquote(r[1])}: esfuerzos`);
  }
  assert.equal(got.length, PLANS.reduce((n, p) => n + p[6].length, 0));
});

test('cada clave tiene su modelo en los dos motores, con precio', () => {
  assert.match(SQL, /set model_id = 'claude-haiku-5-5', label = 'Haiku 5\.5', active = true/);
  assert.match(SQL, /set model_id = 'claude-sonnet-5-5', label = 'Sonnet 5\.5', active = true/);
  assert.match(SQL, /values \('gpt-5-6-sol', 'gpt-5\.6-sol', 'openai', 'GPT-5\.6 Sol', 4, 20, 0\.40, 5, 272000, 8, 30, 0\.80, 10, false/);
  assert.match(SQL, /set model_id = 'gpt-6-luna'[\s\S]{0,200}where tier = 'haiku'/);
  assert.match(SQL, /set model_id = 'gpt-5-6-sol'[\s\S]{0,200}where tier = 'sonnet'/);
  // Las filas de OpenAI siguen siendo solo de precio (un check de 0011 impide activarlas).
  assert.doesNotMatch(SQL, /'gpt-5-6-sol'[^;]*,\s*true\)/);
});

test('todas las funciones: security definer o inmutables, con search_path vacío', () => {
  const defs = [...SQL.matchAll(/create or replace function (public|private)\.(\w+)\([\s\S]*?\bas \$\$/g)];
  assert.ok(defs.length >= 25, `se esperaban al menos 25 funciones y hay ${defs.length}`);
  for (const d of defs) assert.match(d[0], /set search_path = ''/, `${d[1]}.${d[2]} sin search_path`);
});

test('permisos: la clave de Anthropic y la admisión son solo de la service role; elegir saldo, del usuario', () => {
  assert.match(SQL, /revoke all on function public\.admin_anthropic_status\(\), public\.admin_set_anthropic_key\(text\), public\.ai_anthropic_key\(\)\s+from public, anon, authenticated;/);
  assert.match(SQL, /grant execute on function public\.ai_anthropic_key\(\) to service_role;/);
  assert.doesNotMatch(SQL, /grant execute on function public\.ai_anthropic_key\(\) to [^;]*authenticated/);
  assert.match(SQL, /revoke all on function public\.ai_register_turn\(uuid, text, text, text, integer, integer\) from public, anon, authenticated;/);
  assert.match(SQL, /grant execute on function public\.ai_register_turn\(uuid, text, text, text, integer, integer\) to service_role;/);
  assert.match(SQL, /revoke all on function public\.ai_use_wallet\(text\) from public, anon;\s*grant execute on function public\.ai_use_wallet\(text\) to authenticated;/);
  // Las funciones privadas no quedan ejecutables por los usuarios.
  assert.match(SQL, /revoke all on function private\.ai_fit_effort\(text\[\], text\)[\s\S]*?from public, anon, authenticated;/);
  // La tabla de saldos: cada usuario lee solo lo suyo y nadie escribe desde el cliente.
  assert.match(SQL, /alter table public\.ai_wallets enable row level security;/);
  assert.match(SQL, /revoke all on public\.ai_wallets from public, anon, authenticated;\s*grant select on public\.ai_wallets to authenticated;/);
  assert.match(SQL, /create policy ai_wallets_read on public\.ai_wallets for select to authenticated using \(user_id = \(select auth\.uid\(\)\)\);/);
});

test('la clave de Anthropic se valida, va a Vault y queda en el registro sin el valor', () => {
  const body = /create or replace function public\.admin_set_anthropic_key[\s\S]*?end \$\$;/.exec(SQL)?.[0] ?? '';
  assert.match(body, /admin_is_admin_user\(me\)/);
  assert.match(body, /\^sk-ant-\[A-Za-z0-9_-\]\+\$/);
  assert.match(body, /vault\.create_secret\(v_key, 'venus_anthropic_key'/);
  assert.match(body, /'anthropic\.key', null, jsonb_build_object\('configured', v_key <> ''\)/);
  // Solo vuelven los últimos cuatro caracteres.
  assert.match(body, /right\(v_key, 4\)/);
});

test('ai_register_turn: compatibilidad con la función de la 6.0.0 y contrato nuevo', () => {
  const body = /create or replace function public\.ai_register_turn[\s\S]*?end \$\$;/.exec(SQL)?.[0] ?? '';
  // La firma vieja se reemplaza por una con dos parámetros opcionales al final.
  assert.match(SQL, /drop function if exists public\.ai_register_turn\(uuid, text, text, text\);/);
  assert.match(body, /p_max_tokens integer default null, p_input_bytes integer default null/);
  // modelId sigue siendo el id de Claude de la clave; el del proveedor va en models.
  assert.match(body, /'modelId', case when v_reason is null then v_info\.model_id end/);
  assert.match(body, /'provider', v_plan\.ai_provider/);
  assert.match(body, /'models', case when v_reason is null then jsonb_build_object\(/);
  assert.match(body, /'switched', v_switched/);
  assert.match(body, /'openaiEffort'/);
  // El cambio de saldo avisa solo cuando cambia el motor, con los dos motivos del contrato.
  assert.match(body, /jsonb_build_object\('from', v_plan\.ai_provider, 'to', v_to, 'reason', 'budget'\)/);
  assert.match(body, /jsonb_build_object\('from', v_from, 'to', v_to, 'reason', 'noplan'\)/);
  // Mismo candado por cuenta que la liquidación y los pagos.
  assert.match(body, /pg_advisory_xact_lock\(hashtextextended\(p_user::text, 816\)\)/);
  assert.match(body, /p_effort not in \('low', 'medium', 'high', 'xhigh', 'max'\)/);
});

test('la cuota conserva el id de Claude en models[].model y suma providerModel, provider y wallets', () => {
  const body = /create or replace function public\.ai_quota_status[\s\S]*?end \$\$;/.exec(SQL)?.[0] ?? '';
  assert.match(body, /'model', m\.model_id,\s*'providerModel', r\.model_id,\s*'label', r\.label/);
  for (const key of ["'provider', v_plan.ai_provider", "'tier', v_plan.tier", "'wallets', private.ai_wallets_json(p_user)", "'maxTokensPerRequest'"]) {
    assert.ok(body.includes(key), `la cuota no trae ${key}`);
  }
});

test('pagos: el saldo que se suma es el del mismo motor y las Comunidades quedan sin planes', () => {
  const paid = /create or replace function public\.payments_mark_paid[\s\S]*?end \$\$;/.exec(SQL)?.[0] ?? '';
  assert.match(paid, /w\.ai_provider = v_plan\.ai_provider/);
  assert.match(paid, /insert into public\.ai_wallets \(user_id, ai_provider, plan_id, period_id\)/);
  const status = /create or replace function public\.payments_mark_status[\s\S]*?end \$\$;/.exec(SQL)?.[0] ?? '';
  // El paso al otro saldo se decide con la orden ya marcada como devuelta.
  assert.ok(status.indexOf("set status = 'refunded'") < status.indexOf('private.ai_wallet_activate'), 'activa el otro saldo antes de marcar la devolución');
  assert.match(SQL, /'clans', '\[\]'::jsonb\)/);
  assert.match(SQL, /'planName', case p\.ai_provider when 'anthropic' then 'Claude ' else 'ChatGPT ' end \|\| p\.name/);
});

test('un motor sin clave cargada no se vende ni se elige solo', () => {
  const ready = /create or replace function private\.ai_provider_ready[\s\S]*?\$\$;/.exec(SQL)?.[0] ?? '';
  assert.match(ready, /when 'anthropic' then 'venus_anthropic_key' when 'openai' then 'venus_openai_key'/);
  assert.match(ready, /nullif\(d\.decrypted_secret, ''\) is not null/);
  assert.match(SQL, /private\.ai_provider_ready\(text\)\s+from public, anon, authenticated;/);
  // Las dos formas de cambio automático (plan que dejó de valer y saldo agotado) la consultan.
  const turn = /create or replace function public\.ai_register_turn[\s\S]*?end \$\$;/.exec(SQL)?.[0] ?? '';
  assert.equal(turn.split('private.ai_provider_ready(w.ai_provider)').length - 1, 2);
  // El catálogo lo dice y pagos no arma un precio.
  const catalog = /create or replace function public\.ai_catalog[\s\S]*?\$\$;/.exec(SQL)?.[0] ?? '';
  assert.match(catalog, /'available', private\.ai_provider_ready\(p\.ai_provider\)/);
  const quote = /create or replace function private\.payments_quote[\s\S]*?end \$\$;/.exec(SQL)?.[0] ?? '';
  assert.match(quote, /if not private\.ai_provider_ready\(p\.ai_provider\) then return null; end if;/);
});

test('cierre de una llamada: igual que en 0053 más la reserva exacta (p_call), con la firma vieja reemplazada', () => {
  const old = readFileSync(new URL('../../../migrations/0053_ai_reservation_settlement.sql', import.meta.url), 'utf8');
  const squash = (s: string) => s.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
  const before = (name: string) => squash(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?AS \\$function\\$([\\s\\S]*?)\\$function\\$;`).exec(old)![1]);
  const after = (name: string) => squash(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?as \\$\\$([\\s\\S]*?)\\$\\$;`).exec(RAW)![1]);
  assert.equal(
    after('ai_add_usage'),
    before('ai_add_usage').replace(
      "where c.user_id = p_user and c.model_id = p_model and c.status = 'reserved' order by",
      "where c.user_id = p_user and c.status = 'reserved' and ((p_call is not null and c.id = p_call) or (p_call is null and c.model_id = p_model)) order by",
    ),
  );
  assert.equal(
    after('ai_end_call'),
    before('ai_end_call').replace(
      "where c.user_id = p_user and c.status = 'reserved' order by",
      "where c.user_id = p_user and c.status = 'reserved' and (p_call is null or c.id = p_call) order by",
    ),
  );
  assert.match(SQL, /drop function if exists public\.ai_add_usage\(uuid, text, jsonb\);/);
  assert.match(SQL, /drop function if exists public\.ai_end_call\(uuid\);/);
  assert.match(SQL, /function public\.ai_add_usage\(p_user uuid, p_model text, p_usage jsonb, p_call uuid default null\)/);
  assert.match(SQL, /function public\.ai_end_call\(p_user uuid, p_call uuid default null\)/);
  assert.match(SQL, /revoke all on function public\.ai_add_usage\(uuid, text, jsonb, uuid\), public\.ai_end_call\(uuid, uuid\) from public, anon, authenticated;/);
  assert.match(SQL, /grant execute on function public\.ai_add_usage\(uuid, text, jsonb, uuid\), public\.ai_end_call\(uuid, uuid\) to service_role;/);
});

test('ai_register_turn: una pregunta abierta después de un cambio de saldo se ajusta al plan en uso', () => {
  const body = /create or replace function public\.ai_register_turn[\s\S]*?end \$\$;/.exec(SQL)?.[0] ?? '';
  assert.match(body, /v_refit boolean := false;/);
  assert.match(body, /if v_turn_found and not v_moved and v_model is not null\s+and private\.ai_plan_key\(v_plan_id, v_model\) is distinct from v_model then\s+v_refit := true;\s+v_model := private\.ai_plan_key\(v_plan_id, coalesce\(v_turn_model, v_model\)\);/);
  assert.match(body, /elsif v_moved or v_turn_found then\s+v_effort := private\.ai_fit_effort\(v_pm\.efforts, v_effort\);/);
  assert.match(body, /v_turn_model <> v_model and not v_moved and not v_refit then/);
  assert.match(body, /model_id = case when v_moved or v_refit then v_model else coalesce\(t\.model_id, v_model\) end/);
});

test('un plan dado a mano vigente no se pisa con un saldo pagado', () => {
  const body = /create or replace function private\.ai_wallet_activate[\s\S]*?end \$\$;/.exec(SQL)?.[0] ?? '';
  const guard = body.indexOf("s.source = 'admin'");
  assert.ok(guard > 0 && guard < body.indexOf('insert into public.ai_subscriptions'), 'falta el control del plan dado a mano');
  assert.match(body, /and public\.ai_effective_plan\(p_user\) is not null then\s+return false;/);
});

test('pagos: se arrastra todo el saldo y las llamadas en curso pasan al período nuevo', () => {
  const paid = /create or replace function public\.payments_mark_paid[\s\S]*?end \$\$;/.exec(SQL)?.[0] ?? '';
  assert.match(paid, /v_carry := greatest\(0, v_prev\.budget_usd - v_prev\.spent_usd\);/);
  assert.doesNotMatch(paid, /v_reserved/);
  assert.match(paid, /update public\.ai_call_reservations\s+set period_id = v_period\s+where period_id = v_prev\.id and user_id = v_order\.user_id and status = 'reserved';/);
  assert.ok(paid.indexOf('returning id into v_period') < paid.indexOf('update public.ai_call_reservations'), 'mueve las reservas antes de crear el período');
});

test('panel: Quitar plan es el de 0012 más el candado de la IA y el borrado de los saldos', () => {
  const old = readFileSync(new URL('../../../migrations/0012_admin.sql', import.meta.url), 'utf8');
  const squash = (s: string) => s.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
  const fn = (src: string) => squash(/create or replace function public\.admin_remove_plan\(p_user uuid\)[\s\S]*?end \$\$;/.exec(src)![0]);
  assert.equal(
    fn(RAW),
    fn(old)
      .replace(
        "perform pg_advisory_xact_lock(hashtext('venus-billing:' || p_user::text));",
        "perform pg_advisory_xact_lock(hashtext('venus-billing:' || p_user::text)); perform pg_advisory_xact_lock(hashtextextended(p_user::text, 816));",
      )
      .replace('where s.user_id = p_user; return', 'where s.user_id = p_user; delete from public.ai_wallets w where w.user_id = p_user; return'),
  );
  assert.match(SQL, /revoke all on function public\.admin_remove_plan\(uuid\) from public, anon, authenticated;\s*grant execute on function public\.admin_remove_plan\(uuid\) to service_role;/);
});

test('panel: el Resumen es el de 0017 con los planes con nivel en lugar de la lista fija', () => {
  const old = readFileSync(new URL('../../../migrations/0017_pagos_directos.sql', import.meta.url), 'utf8');
  const squash = (s: string) => s.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
  const fn = (src: string) => squash(/create or replace function public\.admin_overview\(\)[\s\S]*?end \$\$;/.exec(src)![0]);
  const now = fn(RAW);
  assert.doesNotMatch(now, /'basic','go','pro','max'/);
  assert.equal(
    now,
    fn(old)
      .replace("set search_path=''", "set search_path = ''")
      .replace("p.active and p.id in ('basic','go','pro','max') )", 'p.active and p.tier is not null )')
      .replace("where p.active and p.id in ('basic','go','pro','max');", 'where p.active and p.tier is not null;'),
  );
  assert.match(SQL, /revoke all on function public\.admin_overview\(\) from public, anon;\s*grant execute on function public\.admin_overview\(\) to authenticated, service_role;/);
});

test('soporte: el formulario acepta los diez planes (y los valores de la 6.0.0)', () => {
  const body = /create or replace function private\.support_details_clean[\s\S]*?end \$\$;/.exec(SQL)?.[0] ?? '';
  const plans = /"plan":\[([^\]]*)\]/.exec(body)?.[1].replace(/"/g, '').split(',') ?? [];
  assert.deepEqual(plans, ['none', 'basic', 'go', 'pro', 'max', 'ultra', 'claude_basic', 'claude_go', 'claude_pro', 'claude_max', 'claude_ultra']);
  assert.deepEqual(plans.slice(1).sort(), PLANS.map((p) => p[0]).sort());
});

test('sin secretos ni emails en la migración', () => {
  assert.doesNotMatch(RAW, /sk-ant-[A-Za-z0-9]{8,}|sk-[A-Za-z0-9]{20,}/);
  assert.doesNotMatch(RAW, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/);
});
