// Revisión estática de supabase/migrations/0012_admin.sql (sin Postgres): RLS y permisos de cada tabla, search_path
// y EXECUTE de cada función, lecturas protegidas con admin_guard, escrituras solo para la service role, las
// funciones sociales de 0002 con las mismas firmas (y ahora con el chequeo de moderación), el trigger de
// auth.users y que la Edge Function solo llame funciones que existen con las claves que lee.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function load(name: string): string {
  const raw = readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), 'utf8');
  // Sin comentarios (ningún texto entre comillas de estas migraciones tiene "--").
  return raw.replace(/--[^\n]*/g, '');
}

const SQL = load('0012_admin.sql');
const SQL_0002 = load('0002_social.sql');
const SQL_0009 = load('0009_billing.sql');
const src = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

interface FnDef {
  name: string;
  types: string;
  returns: string;
  header: string;
  body: string;
}

function functions(sql: string): FnDef[] {
  const out: FnDef[] = [];
  const re = /create or replace function public\.(\w+)\(([^)]*)\)([\s\S]*?)\bas \$\$([\s\S]*?)\$\$;/g;
  for (const m of sql.matchAll(re)) {
    const types = m[2]
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean)
      .map((a) => {
        const words = a.split(/\s+/);
        const cut = words.indexOf('default');
        return words.slice(1, cut < 0 ? undefined : cut).join(' ');
      })
      .join(', ');
    out.push({ name: m[1], types, returns: (/returns\s+([\w.[\]]+)/.exec(m[3]) ?? [])[1] ?? '', header: m[3], body: m[4] });
  }
  return out;
}

const FNS = functions(SQL);
const fn = (name: string) => {
  const f = FNS.find((x) => x.name === name);
  assert.ok(f, `falta la función ${name}`);
  return f;
};

const TABLES = ['app_admin_emails', 'app_admins', 'admin_actions', 'user_moderation'];
const READS = ['admin_overview', 'admin_list_users', 'admin_user_detail', 'admin_plans', 'admin_list_actions'];
const WRITES = [
  'admin_is_admin_user',
  'admin_sync_all',
  'admin_targets',
  'admin_set_plan',
  'admin_remove_plan',
  'admin_moderate',
  'admin_revoke_sessions',
  'admin_reset_usage',
  'admin_log',
  'admin_update_plan',
  'admin_user_files',
  'admin_plan_json',
];
const SOCIAL = ['social_can_send', 'social_send_friend_request', 'social_send_signal', 'social_messages_before'];

test('tablas: idempotentes, con RLS y sin permisos para anon ni authenticated', () => {
  for (const t of TABLES) {
    assert.match(SQL, new RegExp(`create table if not exists public\\.${t} \\(`), t);
    assert.match(SQL, new RegExp(`alter table public\\.${t} enable row level security;`), t);
  }
  assert.match(SQL, /revoke all on public\.app_admin_emails, public\.app_admins, public\.admin_actions, public\.user_moderation from anon, authenticated;/);
  // El registro solo se agrega con admin_log: ni la service role lo edita por la API.
  assert.match(SQL, /revoke all on public\.admin_actions from service_role;/);
  assert.match(SQL, /grant select on public\.admin_actions to service_role;/);
  assert.ok(!/grant (all|insert|update|delete)[^;]*on public\.admin_actions/.test(SQL));
  // Los admins leen el registro; nadie más tiene políticas.
  assert.match(SQL, /drop policy if exists "admin_actions_select_admins" on public\.admin_actions;/);
  assert.match(SQL, /create policy "admin_actions_select_admins" on public\.admin_actions\s+for select to authenticated using \(\(select public\.is_admin\(\)\)\);/);
  assert.equal((SQL.match(/create policy/g) ?? []).length, 1);
});

test('el email del dueño está cargado y la lista se aplica a los usuarios existentes', () => {
  assert.match(SQL, /insert into public\.app_admin_emails \(email, note\)\s+values \('admin@example\.com', [^)]*\)\s+on conflict \(email\) do nothing;/);
  assert.match(SQL, /select public\.admin_sync_all\(\);\s*$/);
});

test('admin = email de la lista + confirmado (+ sin baneo), en el trigger, en la carga y en cada consulta', () => {
  const check = fn('admin_is_admin_user').body;
  assert.match(check, /from public\.app_admins a/);
  assert.match(check, /join public\.app_admin_emails e on e\.email = lower\(u\.email\)/);
  assert.match(check, /u\.email_confirmed_at is not null/);
  assert.match(check, /u\.banned_until is null or u\.banned_until <= now\(\)/);
  assert.match(fn('is_admin').body, /public\.admin_is_admin_user\(auth\.uid\(\)\)/);
  for (const name of ['admin_sync_all', 'admin_sync_user']) assert.match(fn(name).body, /email_confirmed_at is not null/, name);
  // El trigger nunca hace fallar un alta o un inicio de sesión.
  assert.match(fn('admin_sync_user').body, /exception when others then\s+raise warning/);
  assert.match(SQL, /drop trigger if exists on_auth_user_admin_sync on auth\.users;\s+create trigger on_auth_user_admin_sync\s+after insert or update of email, email_confirmed_at on auth\.users\s+for each row execute function public\.admin_sync_user\(\);/);
  assert.match(SQL, /create trigger app_admin_emails_sync\s+after insert or update or delete or truncate on public\.app_admin_emails\s+for each statement/);
});

test('todas las funciones SECURITY DEFINER fijan search_path', () => {
  for (const f of FNS) {
    if (/security definer/.test(f.header)) assert.match(f.header, /set search_path = /, f.name);
    if (!SOCIAL.includes(f.name)) assert.match(f.header, /set search_path = ''/, `${f.name}: search_path vacío`);
  }
});

test('permisos: se quita EXECUTE a public/anon en todas y las escrituras son solo de la service role', () => {
  for (const f of FNS) {
    const sig = `public.${f.name}(${f.types})`.replace(/[.()[\]]/g, (c) => `\\${c}`);
    assert.match(SQL, new RegExp(`revoke all on function ${sig} from public, anon`), `revoke de ${f.name}(${f.types})`);
  }
  for (const name of WRITES) {
    const f = fn(name);
    const sig = `public.${name}(${f.types})`.replace(/[.()[\]]/g, (c) => `\\${c}`);
    assert.match(SQL, new RegExp(`revoke all on function ${sig} from public, anon, authenticated;`), name);
    assert.ok(!new RegExp(`grant execute on function ${sig} to [^;]*authenticated`).test(SQL), `${name} no puede ser de authenticated`);
  }
  for (const name of ['admin_guard', 'admin_sync_user', 'admin_sync_emails']) {
    assert.ok(!new RegExp(`grant execute on function public\\.${name}\\(`).test(SQL), `${name} no se le da a nadie`);
  }
  for (const name of [...READS, 'is_admin', 'my_moderation']) {
    const f = fn(name);
    const sig = `public.${name}(${f.types})`.replace(/[.()[\]]/g, (c) => `\\${c}`);
    assert.match(SQL, new RegExp(`grant execute on function ${sig} to authenticated, service_role;`), name);
  }
});

test('las lecturas del panel exigen admin (o service role) antes de leer nada', () => {
  for (const name of READS) {
    const body = fn(name).body;
    assert.match(body, /^\s*(declare[\s\S]*?)?begin\s+perform public\.admin_guard\(\);/, name);
  }
  const guard = fn('admin_guard').body;
  assert.match(guard, /v_role = 'service_role'/);
  assert.match(guard, /session_user::text <> 'authenticator'/);
  assert.match(guard, /public\.admin_is_admin_user\(auth\.uid\(\)\)/);
  assert.match(guard, /raise exception 'admin_only' using errcode = '42501'/);
});

test('funciones sociales: mismas firmas y retornos que en 0002, ahora con el chequeo de moderación', () => {
  const before = functions(SQL_0002);
  for (const name of SOCIAL) {
    const old = before.find((f) => f.name === name);
    const now = fn(name);
    assert.ok(old, `0002 no tiene ${name}`);
    assert.equal(now.types, old.types, `${name}: argumentos`);
    assert.equal(now.returns, old.returns, `${name}: retorno`);
    assert.equal(/security definer/.test(now.header), /security definer/.test(old.header), `${name}: security definer`);
  }
  assert.match(fn('social_can_send').body, /public\.moderation_social_block\(\(select auth\.uid\(\)\)\)/);
  assert.match(fn('social_send_friend_request').body, /v_block := public\.moderation_social_block\(me\);/);
  assert.match(fn('social_send_signal').body, /v_block := public\.moderation_social_block\(me\);/);
  assert.match(fn('social_messages_before').body, /elsif new\.body is distinct from old\.body then\s+v_block := public\.moderation_self_block\(\);/);
  // El resto de la lógica de 0002 sigue igual.
  assert.match(fn('social_messages_before').body, /raise exception 'rate_limited' using errcode = 'PT429';/);
  assert.match(fn('social_send_friend_request').body, /return public\.social_send_friend_request\(target\);/);
  assert.match(fn('social_send_friend_request').body, /raise exception 'too_many_requests' using errcode = '54000';/);
  assert.match(fn('social_send_signal').body, /perform realtime\.send\(/);
  assert.match(fn('social_can_send').body, /public\.are_friends\(c\.user_lo, c\.user_hi\)/);
  const block = fn('moderation_social_block').body;
  assert.match(block, /'user_banned'/);
  assert.match(block, /'user_muted'/);
  assert.match(block, /u\.banned_until > now\(\)/);
});

test('la Edge Function solo llama funciones que existen (0012 o 0009)', () => {
  const known = new Set([...FNS.map((f) => f.name), ...functions(SQL_0009).map((f) => f.name)]);
  const files = ['actions.ts', 'handler.ts', 'prices.ts', 'coupons.ts'];
  const called = new Set<string>();
  for (const file of files) {
    for (const m of src(file).matchAll(/(?:db|rpc)\('([a-z_]+)'/g)) called.add(m[1]);
  }
  assert.ok(called.size >= 15, `pocas llamadas encontradas: ${[...called].join(', ')}`);
  for (const name of called) assert.ok(known.has(name), `la función ${name} no existe en las migraciones`);
});

test('admin_targets devuelve las claves que lee actions.ts', () => {
  const body = fn('admin_targets').body;
  const keys = [...body.matchAll(/'([A-Za-z]+)', /g)].map((m) => m[1]);
  const actions = src('actions.ts');
  const loader = actions.slice(actions.indexOf('async function loadTargets'), actions.indexOf('/** Corre tareas'));
  const read = [...loader.matchAll(/\br\.([A-Za-z]+)\b/g)].map((m) => m[1]);
  assert.ok(read.length >= 10);
  for (const k of new Set(read)) assert.ok(keys.includes(k), `admin_targets no devuelve "${k}"`);
});

test('duraciones: los planes regalados y el registro usan los nombres de acción que acepta la tabla', () => {
  const pattern = /^[a-z][A-Za-z]{1,30}(\.[A-Za-z]{1,30})?$/;
  assert.match(SQL, /action text not null check \(action ~ '\^\[a-z\]\[A-Za-z\]\{1,30\}\(\\\.\[A-Za-z\]\{1,30\}\)\?\$'\)/);
  const actions = [...src('actions.ts').matchAll(/action: '([^']+)'/g), ...src('actions.ts').matchAll(/ctx\.log\('([^']+)'/g)].map((m) => m[1]);
  assert.ok(actions.length >= 12);
  for (const a of actions) assert.match(a, pattern, a);
});
