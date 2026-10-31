// Revisión estática de supabase/migrations/0013_ai_budget.sql (sin Postgres): las funciones que reemplaza mantienen
// la firma, el JSON y todo lo que hacían (solo se agregan las líneas nuevas), son SECURITY DEFINER con search_path
// vacío y EXECUTE solo para la service role, y los números del SQL (3 llamadas en curso, 150 s, la llamada más
// grande) son los de la Edge Function y los de la base de prueba (tests/fake-db.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LIMITS } from '../config.ts';
import { DENIAL_MESSAGES } from '../quota.ts';
import { MAX_INFLIGHT, RESERVE_INPUT_TOKENS } from './fake-db.ts';

function load(name: string): string {
  const raw = readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), 'utf8');
  // Sin comentarios (ningún texto entre comillas de estas migraciones tiene "--").
  return raw.replace(/--[^\n]*/g, '');
}

const SQL = load('0013_ai_budget.sql');

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
      types: args.map((a) => a.slice(1).join(' ').replace(/\s+default\s+.*$/i, '')).join(', '),
      returns: (/returns\s+([\w.[\]]+)/.exec(m[3]) ?? [])[1] ?? '',
      header: m[3],
      body: m[4],
    });
  }
  return out;
}

const FNS = functions(SQL);

function fn(name: string, sql = SQL): FnDef {
  const found = functions(sql).find((f) => f.name === name && (name !== 'ai_register_turn' || f.argNames.length === 4));
  assert.ok(found, `falta la función ${name}`);
  return found;
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

/** Líneas (sin espacios de los bordes) de la versión anterior que ya no están en la nueva. */
function removedLines(before: string, after: string): string[] {
  const now = new Set(after.split('\n').map((l) => l.trim()));
  return before.split('\n').map((l) => l.trim()).filter((l) => l && !now.has(l));
}

const PREVIOUS: Record<string, string> = {
  ai_quota_status: '0008_ai_plans.sql',
  ai_register_turn: '0008_ai_plans.sql',
  ai_add_usage: '0011_ai_providers.sql',
  billing_apply_subscription: '0009_billing.sql',
};

/** Decremento de las llamadas en curso (el mismo en ai_add_usage y ai_end_call). */
const CLOSE_CALL =
  /update public\.ai_rate r\s+set inflight = case when r\.inflight_at > now\(\) - interval '150 seconds' then greatest\(r\.inflight - 1, 0\) else 0 end\s+where r\.user_id = p_user\s+and r\.inflight > 0;/;

test('funciones: SECURITY DEFINER, search_path vacío, nombres calificados y EXECUTE solo para la service role', () => {
  assert.deepEqual(FNS.map((f) => f.name).sort(), [
    'ai_add_usage',
    'ai_budget_limit',
    'ai_call_reserve',
    'ai_end_call',
    'ai_quota_status',
    'ai_register_turn',
    'billing_apply_subscription',
  ]);
  for (const f of FNS) {
    assert.match(f.header, /set search_path = ''/, f.name);
    assert.match(f.header, /security definer/, f.name);
    const signature = `public.${f.name}(${f.types})`.replace(/[.()[\]]/g, '\\$&');
    assert.match(SQL, new RegExp(`revoke all on function ${signature}\\s+from public, anon, authenticated;`), `${f.name}: revoke`);
    assert.match(SQL, new RegExp(`grant execute on function ${signature}\\s+to service_role;`), `${f.name}: grant`);
    // Ninguna tabla sin esquema (se saltean las funciones, las variables v_* y p_*, "join lateral" y el "do update set").
    for (const m of f.body.matchAll(/\b(?:from|join|into|update)\s+([a-z_]+)(\.[a-z_]+)?\b(\s*\()?/g)) {
      if (m[2]) {
        assert.ok(['public', 'auth', 'pg_catalog'].includes(m[1]), `${f.name}: ${m[0]}`);
        continue;
      }
      assert.ok(m[3] || ['set', 'lateral'].includes(m[1]) || /^[vp]_/.test(m[1]), `${f.name}: ${m[0]}`);
    }
  }
  assert.doesNotMatch(SQL, /grant [^;]* to (anon|authenticated)/);
  assert.doesNotMatch(SQL, /create table/, 'solo columnas nuevas');
});

test('las funciones que reemplaza mantienen nombres de parámetros, tipos, retorno y JSON', () => {
  for (const [name, file] of Object.entries(PREVIOUS)) {
    const before = fn(name, load(file));
    const after = fn(name);
    // CREATE OR REPLACE no deja cambiar los nombres de los parámetros ni el tipo de retorno.
    assert.deepEqual(after.argNames, before.argNames, name);
    assert.equal(after.types, before.types, name);
    assert.equal(after.returns, before.returns, name);
    assert.equal(/\bstable\b/.test(after.header), /\bstable\b/.test(before.header), `${name}: volatilidad`);
    assert.deepEqual([...jsonKeys(after.body)].sort(), [...jsonKeys(before.body)].sort(), `${name}: claves del JSON`);
  }
  // billing_apply_subscription conserva el valor por defecto de p_livemode.
  assert.match(SQL, /p_livemode boolean default false\n\) returns jsonb/);
});

test('columnas nuevas: idempotentes y sin valores inválidos', () => {
  assert.match(SQL, /alter table public\.ai_rate add column if not exists inflight integer not null default 0 check \(inflight >= 0\);/);
  assert.match(SQL, /alter table public\.ai_rate add column if not exists inflight_at timestamptz;/);
  assert.match(SQL, /alter table public\.ai_subscriptions add column if not exists budget_cap_usd numeric\(10,4\) check \(budget_cap_usd >= 0\);/);
  assert.match(SQL, /alter table public\.ai_subscriptions add column if not exists budget_cap_until timestamptz;/);
});

test('ai_register_turn: lo de 0008 más las llamadas en curso, el presupuesto que rige y la reserva', () => {
  const before = fn('ai_register_turn', load('0008_ai_plans.sql'));
  const after = fn('ai_register_turn');
  // Solo cambian la ráfaga (ahora también las llamadas en curso) y la comparación con el presupuesto.
  assert.deepEqual(removedLines(before.body, after.body), [
    'returning r.calls into v_minute_calls;',
    'if v_minute_calls > v_plan.requests_per_minute then',
    'if v_spent >= v_plan.monthly_budget_usd then',
  ]);
  // Los motivos de rechazo siguen siendo exactamente los del protocolo.
  const reasons = new Set<string>();
  for (const m of after.body.matchAll(/v_reason := ([^;]+);/g)) for (const lit of m[1].matchAll(/'([a-z_]+)'/g)) reasons.add(lit[1]);
  assert.deepEqual([...reasons].sort(), Object.keys(DENIAL_MESSAGES).sort());
  // Llamadas en curso: vencen a los 150 s y hay hasta MAX_INFLIGHT a la vez (los mismos números que la base de prueba).
  assert.match(after.body, /returning r\.calls, case when r\.inflight_at > now\(\) - interval '150 seconds' then r\.inflight else 0 end\s+into v_minute_calls, v_inflight;/);
  assert.match(after.body, new RegExp(`if v_minute_calls > v_plan\\.requests_per_minute or v_inflight >= ${MAX_INFLIGHT} then\\s+v_reason := 'rate';`));
  // Presupuesto: el que rige (con el tope) y, con llamadas en curso, la reserva de su costo máximo ('rate', no 'budget').
  assert.match(after.body, /v_budget := public\.ai_budget_limit\(p_user, v_plan_id\);\s+if v_spent >= v_budget then\s+v_reason := 'budget';/);
  assert.match(after.body, /elsif v_inflight > 0\s+and v_spent \+ v_inflight \* public\.ai_call_reserve\(v_model, v_plan\.max_tokens_per_request\) >= v_budget then\s+v_reason := 'rate';/);
  // La llamada permitida queda en curso: al final (después de los cupos), con la fila de ai_rate ya bloqueada.
  assert.ok(after.body.indexOf('set inflight = v_inflight + 1') > after.body.indexOf('v_counted := true;'));
  assert.match(after.body, /if v_reason is null then\s+update public\.ai_rate r\s+set inflight = v_inflight \+ 1,\s+inflight_at = now\(\)\s+where r\.user_id = p_user;\s+end if;\s+return jsonb_build_object/);
});

test('ai_quota_status: igual que en 0008 salvo el presupuesto que rige', () => {
  const before = fn('ai_quota_status', load('0008_ai_plans.sql'));
  const after = fn('ai_quota_status');
  assert.deepEqual(removedLines(before.body, after.body), [
    "'budget', jsonb_build_object('usedUsd', round(v_spent, 4), 'limitUsd', coalesce(v_plan.monthly_budget_usd, 0)),",
  ]);
  assert.match(after.body, /'limitUsd', coalesce\(public\.ai_budget_limit\(p_user, v_plan_id\), 0\)/);
});

test('ai_add_usage y ai_end_call: cierran la llamada; ai_add_usage lo hace antes de tocar el uso (orden de bloqueo)', () => {
  const before = fn('ai_add_usage', load('0011_ai_providers.sql'));
  const after = fn('ai_add_usage');
  assert.deepEqual(removedLines(before.body, after.body), [], 'todo lo de 0011 sigue igual');
  assert.match(after.body, CLOSE_CALL);
  const close = after.body.search(CLOSE_CALL);
  assert.ok(close > after.body.indexOf('ai_add_usage: modelo desconocido'), 'después de validar');
  assert.ok(close < after.body.indexOf('for v_line in'), 'antes de bloquear las filas de uso (como ai_register_turn)');
  const end = fn('ai_end_call');
  assert.match(end.body, CLOSE_CALL);
  assert.match(end.body, /return public\.ai_quota_status\(p_user\);/);
  assert.match(end.body, /if p_user is null then\s+raise exception 'ai_end_call: parámetros inválidos' using errcode = '22023';/);
});

test('ai_call_reserve y ai_budget_limit: la llamada más grande y el tope solo de Stripe y vigente', () => {
  const reserve = fn('ai_call_reserve').body;
  // 400 KB de cuerpo a unos 3 caracteres por token, como la estimación de la Edge Function.
  assert.equal(RESERVE_INPUT_TOKENS, Math.ceil(LIMITS.bodyBytes / 3));
  assert.match(reserve, new RegExp(`public\\.ai_price_line\\(m, 0, greatest\\(coalesce\\(p_max_tokens, 0\\), 0\\), 0, ${RESERVE_INPUT_TOKENS}\\)`));
  assert.match(reserve, /or m\.id in \(select f\.model_id from public\.ai_tier_fallbacks f where f\.tier = p_model and f\.active\)/);
  const limit = fn('ai_budget_limit').body;
  assert.match(limit, /when s\.source = 'stripe' and s\.budget_cap_until > now\(\) and s\.budget_cap_usd is not null\s+then least\(p\.monthly_budget_usd, s\.budget_cap_usd\)/);
  assert.match(limit, /left join public\.ai_subscriptions s on s\.user_id = p_user/);
});

test('billing_apply_subscription: lo de 0009 más el tope prorrateado al subir de plan', () => {
  const before = fn('billing_apply_subscription', load('0009_billing.sql'));
  const after = fn('billing_apply_subscription');
  // Solo cambian las listas de columnas del upsert (se agregan las del tope).
  assert.deepEqual(removedLines(before.body, after.body), [
    'grace_until, stripe_status, last_synced_at',
    'p_grace_until, p_stripe_status, v_synced',
    'last_synced_at = excluded.last_synced_at;',
  ]);
  assert.match(after.body, /grace_until, stripe_status, last_synced_at, budget_cap_usd, budget_cap_until/);
  assert.match(after.body, /p_grace_until, p_stripe_status, v_synced, v_cap, v_cap_until/);
  assert.match(after.body, /budget_cap_usd = excluded\.budget_cap_usd,\s+budget_cap_until = excluded\.budget_cap_until;/);
  // Solo la misma suscripción: conserva su tope vigente y, si cambia de plan con acceso, prorratea la diferencia.
  assert.match(after.body, /if v_found and v_row\.stripe_subscription_id is not distinct from p_subscription then\s+if v_row\.budget_cap_until > now\(\) then/);
  assert.match(after.body, /if v_row\.plan_id <> p_plan and v_new_grants then/);
  assert.match(after.body, /select p\.monthly_budget_usd into v_old_budget from public\.ai_plans p where p\.id = v_row\.plan_id;/);
  assert.match(after.body, /select p\.monthly_budget_usd into v_new_budget from public\.ai_plans p where p\.id = p_plan;/);
  assert.match(after.body, /v_left := extract\(epoch from \(p_current_period_end - now\(\)\)\);/);
  assert.match(after.body, /v_len := extract\(epoch from \(p_current_period_end - \(p_current_period_end - interval '1 month'\)\)\);/);
  // Lo ya pagado en el período (el tope vigente o el plan anterior) más la diferencia por lo que queda.
  assert.match(
    after.body,
    /v_cap := greatest\(round\(coalesce\(v_cap, v_old_budget\) \+ \(v_new_budget - v_old_budget\) \* least\(v_left \/ v_len, 1\), 4\), 0\);\s+v_cap_until := p_current_period_end;/,
  );
});
