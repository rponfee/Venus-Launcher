// Revisión estática de supabase/migrations/0057_admin_equipo.sql (sin Postgres): las funciones del Equipo tienen
// search_path vacío y son security definer, los permisos son explícitos (nada para anon; authenticated solo en las
// que llama el panel), quién puede qué lo decide cada función (dueño / administrador), los códigos de error son los
// que traduce el launcher, todo cambio queda en admin_log y en el archivo no hay emails reales.
// El comportamiento contra una base de verdad lo prueba el guion prueba-0057.sql del integrador.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const RAW = readFileSync(new URL('../../../migrations/0057_admin_equipo.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
// Sin comentarios (ningún texto entre comillas de esta migración tiene "--").
const SQL = RAW.replace(/--[^\n]*/g, '');

interface FnDef {
  schema: string;
  name: string;
  types: string;
  header: string;
  body: string;
}

function functions(sql: string): FnDef[] {
  const out: FnDef[] = [];
  const re = /create or replace function (public|private)\.(\w+)\(([^)]*)\)([\s\S]*?)\bas \$\$([\s\S]*?)\$\$;/g;
  for (const m of sql.matchAll(re)) {
    const types = m[3]
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean)
      .map((a) => a.split(/\s+/).slice(1).join(' '))
      .join(', ');
    out.push({ schema: m[1], name: m[2], types, header: m[4], body: m[5] });
  }
  return out;
}

const FNS = functions(SQL);
const fn = (schema: string, name: string) => {
  const f = FNS.find((x) => x.schema === schema && x.name === name);
  assert.ok(f, `falta la función ${schema}.${name}`);
  return f;
};
const esc = (s: string) => s.replace(/[.()[\]]/g, (c) => `\\${c}`);

const PUBLIC = [
  ['admin_team', ''],
  ['admin_grant_admin', 'uuid'],
  ['admin_revoke_admin', 'uuid'],
  ['admin_set_support_staff', 'uuid, boolean'],
  ['admin_set_rank', 'uuid, text'],
] as const;
const PRIVATE = [
  ['admin_is_owner', 'uuid'],
  ['admin_team_blocker', 'uuid'],
] as const;

test('todas las funciones son security definer con search_path vacío y las firmas esperadas', () => {
  assert.equal(FNS.length, PUBLIC.length + PRIVATE.length, 'no hay funciones de más');
  for (const [name, types] of PUBLIC) assert.equal(fn('public', name).types, types, name);
  for (const [name, types] of PRIVATE) assert.equal(fn('private', name).types, types, name);
  for (const f of FNS) {
    assert.match(f.header, /security definer set search_path = ''/, `${f.schema}.${f.name}`);
    assert.doesNotMatch(f.header, /security invoker/, f.name);
  }
  // Cuerpos con nombres calificados: nada de tablas sin esquema.
  for (const f of FNS) {
    for (const m of f.body.matchAll(/\b(?:from|join|into|update)\s+([a-z_]+)\b(?!\.)/g)) {
      // Variables y parámetros de plpgsql (v_..., p_...) y "do update set" no son tablas.
      if (/^[vp]_/.test(m[1]) || m[1] === 'set') continue;
      assert.fail(`${f.name}: referencia sin esquema (${m[0]})`);
    }
  }
});

test('permisos explícitos: sin public ni anon, authenticated solo en lo que llama el panel, private solo service_role', () => {
  for (const [name, types] of PUBLIC) {
    assert.match(SQL, new RegExp(`revoke all on function public\\.${name}\\(${esc(types)}\\) from public, anon;`), `revoke ${name}`);
    assert.match(SQL, new RegExp(`grant execute on function public\\.${name}\\(${esc(types)}\\) to authenticated;`), `grant ${name}`);
  }
  for (const [name, types] of PRIVATE) {
    assert.match(SQL, new RegExp(`revoke all on function private\\.${name}\\(${esc(types)}\\) from public, anon, authenticated;`), `revoke ${name}`);
    assert.match(SQL, new RegExp(`grant execute on function private\\.${name}\\(${esc(types)}\\) to service_role;`), `grant ${name}`);
    assert.doesNotMatch(SQL, new RegExp(`grant execute on function private\\.${name}\\([^)]*\\) to [^;]*authenticated`), name);
  }
  assert.doesNotMatch(SQL, /grant [^;]* to [^;]*\banon\b/, 'nada para anon');
  assert.doesNotMatch(SQL, /grant (?:all|insert|update|delete)[^;]* on (?:table )?public\.(app_admins|app_admin_emails|support_staff|admin_actions)/, 'las tablas siguen cerradas');
});

test('el dueño es un admin activo con rank owner, y solo él da o quita admins', () => {
  const owner = fn('private', 'admin_is_owner').body;
  assert.match(owner, /public\.admin_is_admin_user\(p_user\)/);
  assert.match(owner, /p\.rank = 'owner'/);
  for (const name of ['admin_grant_admin', 'admin_revoke_admin']) {
    const body = fn('public', name).body;
    const guard = body.indexOf("if not private.admin_is_owner(me) then raise exception 'owner_only'");
    assert.ok(guard >= 0, `${name}: exige al dueño`);
    // El control va antes de cualquier escritura.
    for (const write of ['insert into', 'delete from', 'update public.']) {
      const at = body.indexOf(write);
      if (at >= 0) assert.ok(guard < at, `${name}: controla antes de ${write}`);
    }
    assert.match(body, /me uuid := auth\.uid\(\)/, `${name}: quien llama sale del JWT, no de un parámetro`);
    assert.match(body, /pg_advisory_xact_lock\(hashtext\('venus-admin-team'\)\)/, `${name}: serializa`);
  }
  // Las demás exigen un administrador activo.
  for (const name of ['admin_team', 'admin_set_support_staff', 'admin_set_rank']) {
    assert.match(fn('public', name).body, /if not public\.admin_is_admin_user\(me\) then raise exception 'admin_only'/, name);
  }
});

test('dar admin valida la cuenta destino y es idempotente', () => {
  const blocker = fn('private', 'admin_team_blocker').body;
  for (const code of ['unknown_user', 'anonymous', 'unconfirmed', 'banned', 'bad_email']) assert.match(blocker, new RegExp(`return '${code}'`), code);
  assert.match(blocker, /u\.deleted_at/);
  assert.match(blocker, /coalesce\(u\.is_anonymous, false\)/);
  assert.match(blocker, /u\.email_confirmed_at/);
  assert.match(blocker, /u\.banned_until/);
  assert.match(blocker, /public\.user_moderation m where m\.user_id = p_user and m\.banned_until > now\(\)/);

  const grant = fn('public', 'admin_grant_admin').body;
  assert.match(grant, /v_block := private\.admin_team_blocker\(p_user\);/);
  assert.match(grant, /raise exception '%', v_block using errcode = '22023', hint = v_block/);
  // El email que se carga es el actual de la cuenta, en minúsculas.
  assert.match(grant, /select lower\(u\.email\) into v_email from auth\.users u where u\.id = p_user;/);
  assert.match(grant, /insert into public\.app_admin_emails \(email, note\) values \(v_email, [^)]*\)\s+on conflict \(email\) do nothing;/);
  assert.match(grant, /insert into public\.app_admins as a \(user_id, email\) values \(p_user, v_email\)\s+on conflict \(user_id\) do update set email = excluded\.email\s+where a\.email is distinct from excluded\.email;/);
  // Rango: solo sube (helper/mod/sin rango -> admin); admin y owner se quedan.
  assert.match(grant, /v_rank is null or v_rank in \('helper', 'mod'\)/);
  assert.match(grant, /update public\.profiles set rank = 'admin' where id = p_user;/);
  assert.match(grant, /if not public\.admin_is_admin_user\(p_user\) then raise exception 'grant_failed'/);
  assert.match(grant, /if v_changed then\s+perform public\.admin_log\(me, [^;]*'admin\.grant', p_user,/);
});

test('quitar admin: ni a sí mismo ni a un owner, sin cortar a otra cuenta que comparta el email', () => {
  const revoke = fn('public', 'admin_revoke_admin').body;
  assert.match(revoke, /if p_user = me then raise exception 'cannot_self'/);
  assert.match(revoke, /if v_rank = 'owner' then raise exception 'owner_locked'/);
  assert.ok(revoke.indexOf("'cannot_self'") < revoke.indexOf('delete from'), 'controla antes de borrar');
  assert.ok(revoke.indexOf("'owner_locked'") < revoke.indexOf('delete from'), 'controla antes de borrar');
  assert.match(revoke, /delete from public\.app_admins a where a\.user_id = p_user returning lower\(a\.email\) into v_row_email;/);
  // Los dos emails (el guardado y el actual), salvo que otra fila de app_admins todavía lo use.
  assert.match(revoke, /where e\.email in \(v_row_email, v_cur_email\)\s+and not exists \(/);
  assert.match(revoke, /o\.user_id <> p_user\s+and \(lower\(o\.email\) = e\.email or lower\(ou\.email\) = e\.email\)/);
  assert.match(revoke, /if v_rank = 'admin' then\s+update public\.profiles set rank = null where id = p_user;/);
  assert.match(revoke, /perform public\.admin_log\(me, [^;]*'admin\.revoke', p_user,/);
  assert.doesNotMatch(revoke, /delete from public\.app_admin_emails e\s+where e\.email = /, 'no borra por un solo email sin revisar');
});

test('soporte respeta el índice único por email y registra el cambio', () => {
  const staff = fn('public', 'admin_set_support_staff').body;
  assert.match(staff, /raise exception 'bad_request'/);
  assert.match(staff, /v_block := private\.admin_team_blocker\(p_user\);/);
  // Primero desactiva otra fila activa con el mismo email (support_staff_one_active_email), después activa.
  const off = staff.indexOf('update public.support_staff s set active = false, updated_at = now()\n     where s.email = v_email and s.user_id <> p_user and s.active;');
  const on = staff.indexOf('insert into public.support_staff');
  assert.ok(off >= 0 && on > off, 'desactiva el duplicado antes de insertar');
  assert.match(staff, /on conflict \(user_id\) do update/);
  assert.match(staff, /'support\.staffGranted' else 'support\.staffRevoked'/);
  assert.match(staff, /pg_advisory_xact_lock\(hashtext\('venus-support-staff'\)\)/);
});

test('admin_set_rank ya no acepta admin ni cambia el rango de un administrador activo', () => {
  const rank = fn('public', 'admin_set_rank').body;
  assert.match(rank, /p_rank not in \('helper', 'mod'\)/);
  assert.doesNotMatch(rank, /'helper', 'mod', 'admin'/);
  assert.match(rank, /if v_before = 'owner' then raise exception 'owner_locked'/);
  assert.match(rank, /if v_before = 'admin' and public\.admin_is_admin_user\(p_user\) then\s+raise exception 'admin_locked'/);
  assert.match(rank, /'rank\.set'/);
});

test('admin_team devuelve las claves que lee la pestaña Equipo', () => {
  const team = fn('public', 'admin_team').body;
  for (const key of ['me', 'isOwner', 'admins', 'staff', 'userId', 'username', 'displayName', 'email', 'grantedAt', 'active', 'lastActionAt', 'since']) {
    assert.match(team, new RegExp(`'${key}'`), key);
  }
  assert.match(team, /'active', public\.admin_is_admin_user\(a\.user_id\)/);
  assert.match(team, /'active', private\.support_is_staff\(s\.user_id\)/);
  assert.match(team, /where s\.active/);
});

test('códigos de error estables: mensaje y hint iguales', () => {
  for (const m of SQL.matchAll(/raise exception '([a-z_]+)' using errcode = '(\w+)'(?:, hint = '([a-z_]+)')?/g)) {
    assert.equal(m[3], m[1], `hint de ${m[1]}`);
  }
  for (const code of ['owner_only', 'admin_only', 'cannot_self', 'owner_locked', 'admin_locked', 'bad_rank', 'bad_request', 'grant_failed', 'unknown_user']) {
    assert.match(SQL, new RegExp(`raise exception '${code}'`), code);
  }
});

test('lo registrado no lleva el email de la cuenta afectada y el archivo no tiene emails reales', () => {
  for (const m of SQL.matchAll(/perform public\.admin_log\(([\s\S]*?)\);/g)) {
    const details = m[1].slice(m[1].indexOf('jsonb_build_object'));
    assert.doesNotMatch(details, /email'|v_email|u\.email/, 'detalles sin email');
  }
  // Ningún email literal (ni siquiera de ejemplo) en todo el archivo, comentarios incluidos.
  assert.doesNotMatch(RAW, /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
  assert.doesNotMatch(RAW, /service_role_key|sk-[A-Za-z0-9]/i);
});

test('idempotente: create or replace y la carga de datos se puede repetir', () => {
  assert.doesNotMatch(SQL, /\bcreate function\b/);
  assert.doesNotMatch(SQL, /\bcreate table\b(?! if not exists)/);
  assert.doesNotMatch(SQL, /\bdrop (table|function)\b/);
  const backfill = /update public\.profiles p\s+set rank = 'admin'\s+where \(p\.rank is null or p\.rank in \('helper', 'mod'\)\)\s+and p\.id in \(select a\.user_id from public\.app_admins a\)\s+and public\.admin_is_admin_user\(p\.id\);/;
  assert.match(SQL, backfill);
});
