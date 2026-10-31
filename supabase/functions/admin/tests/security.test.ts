// Revisión estática de supabase/migrations/0014_security.sql (sin Postgres): cuotas de Storage en un trigger, sin
// UPDATE en screenshots y clips, admins sin promoción automática, Voice Chat solo para quien está en la sala, las
// auxiliares de las políticas en private (y ninguna referencia a las de public), topes de filas, límite de señales,
// firmas iguales a las que reemplaza y search_path en las security definer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function load(name: string): string {
  const raw = readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), 'utf8');
  // Sin comentarios (ningún texto entre comillas de estas migraciones tiene "--").
  return raw.replace(/--[^\n]*/g, '');
}

const SQL = load('0014_security.sql');
const BEFORE = ['0002_social.sql', '0003_voice.sql', '0004_share.sql', '0005_media.sql', '0012_admin.sql'].map(load).join('\n');

interface FnDef {
  schema: string;
  name: string;
  types: string;
  returns: string;
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
      .map((a) => {
        const words = a.split(/\s+/);
        const cut = words.indexOf('default');
        return words.slice(1, cut < 0 ? undefined : cut).join(' ');
      })
      .join(', ');
    out.push({ schema: m[1], name: m[2], types, returns: (/returns\s+([\w.[\]]+)/.exec(m[4]) ?? [])[1] ?? '', header: m[4], body: m[5] });
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

const HELPERS = ['are_friends', 'social_is_member', 'social_can_send', 'moderation_self_block', 'voice_friend_array', 'voice_is_owner', 'voice_is_member', 'voice_can_use_topic', 'share_is_owner', 'share_is_member'];

test('storage: las cuotas van en un trigger de cada escritura y screenshots/clips no tienen UPDATE', () => {
  assert.match(SQL, /drop trigger if exists venus_storage_quota on storage\.objects;\s+create trigger venus_storage_quota\s+before insert or update on storage\.objects\s+for each row execute function private\.storage_quota_before\(\);/);
  const quota = fn('private', 'storage_quota_before');
  assert.match(quota.header, /security definer set search_path = ''/);
  assert.match(quota.body, /pg_advisory_xact_lock\(hashtext\('venus-storage:'/);
  assert.match(quota.body, /v_used \+ v_size > 2147483648/);
  assert.match(quota.body, /new\.bucket_id = 'screenshots' and v_files >= 500/);
  assert.match(quota.body, /new\.bucket_id = 'clips' and v_files >= 100/);
  assert.match(quota.body, /array_length\(storage\.foldername\(new\.name\), 1\), 0\) <> 1/);
  // 42501 = el mismo 403 "row-level security" que el launcher ya traduce como cuota llena.
  assert.match(quota.body, /raise exception 'storage_quota_exceeded' using errcode = '42501'/);
  assert.match(SQL, /drop policy if exists "venus_media_update_own" on storage\.objects;/);
  assert.ok(!/create policy "venus_media_update_own"/.test(SQL));
  // Las políticas de INSERT ya no cuentan nada (lo hace el trigger) y las funciones viejas se borran.
  for (const policy of ['world_saves_insert_own', 'venus_media_insert_own']) {
    const at = SQL.indexOf(`create policy "${policy}"`);
    assert.ok(at > 0, `falta la política ${policy}`);
    assert.ok(!/quota|venus_media_count/.test(SQL.slice(at, SQL.indexOf(';', at))), `${policy}: la cuenta la hace el trigger`);
  }
  assert.match(SQL, /drop function if exists public\.cloud_saves_quota_ok\(\);/);
  assert.match(SQL, /drop function if exists public\.venus_media_count\(text\);/);
});

test('admins: sin triggers que promuevan por email, sin sembrar emails y sin admin_sync_all', () => {
  assert.match(SQL, /drop trigger if exists on_auth_user_admin_sync on auth\.users;/);
  assert.match(SQL, /drop trigger if exists app_admin_emails_sync on public\.app_admin_emails;/);
  for (const name of ['admin_sync_user', 'admin_sync_emails', 'admin_sync_all']) assert.match(SQL, new RegExp(`drop function if exists public\\.${name}\\(\\);`));
  assert.ok(!/create trigger[^;]*on auth\.users/.test(SQL));
  assert.ok(!/insert into public\.app_admin_emails/.test(SQL));
  assert.ok(!/admin_sync_all\(\)\s*;/.test(SQL.replace(/drop function if exists public\.admin_sync_all\(\);/, '')));
  // El email que siembra 0012 se borra solo si esa cuenta no es admin (la del dueño queda).
  assert.match(SQL, /delete from public\.app_admin_emails e\s+where e\.email = 'admin@example\.com'\s+and not exists \(select 1 from public\.app_admins a where a\.email = e\.email\);/);
});

test('auxiliares de las políticas: en private, solo para authenticated y sin referencias a las de public', () => {
  assert.match(SQL, /create schema if not exists private;/);
  assert.match(SQL, /grant usage on schema private to authenticated, service_role;/);
  for (const name of HELPERS) {
    const f = fn('private', name);
    const sig = esc(`private.${name}(${f.types})`);
    assert.match(SQL, new RegExp(`revoke all on function ${sig} from public, anon;`), name);
    assert.match(SQL, new RegExp(`grant execute on function ${sig} to authenticated`), name);
    assert.match(SQL, new RegExp(`drop function if exists public\\.${name}\\(`), name);
    // Fuera del drop, nadie llama a la versión de public.
    const uses = SQL.replace(new RegExp(`drop function if exists public\\.${name}\\([^)]*\\);`, 'g'), '');
    assert.ok(!new RegExp(`public\\.${name}\\(`).test(uses), `queda una referencia a public.${name}`);
  }
  // Las políticas que antes usaban las de public ahora usan las de private.
  for (const policy of ['user_activity_select_friends', 'conversation_members_select', 'messages_select_members', 'messages_insert_own', 'message_reactions_select_members', 'message_reactions_insert_own', 'voice_rooms_select', 'voice_members_select', 'voice_members_delete', 'shared_packs_select', 'shared_pack_members_select', 'shared_pack_members_delete', 'voice_room_receive', 'voice_room_send']) {
    const at = SQL.indexOf(`create policy "${policy}"`);
    assert.ok(at > 0, `falta la política ${policy}`);
    assert.match(SQL.slice(at, SQL.indexOf(';', at)), /private\.\w+\(/, policy);
  }
  assert.match(SQL, /revoke all on function public\.venus_friend_code\(\) from public, anon, authenticated;/);
});

test('voz: el canal solo para quien está en la sala, salir borra la sesión, invitar solo a amigos, bloqueados afuera', () => {
  const topic = fn('private', 'voice_can_use_topic').body;
  assert.match(topic, /m\.last_seen > now\(\) - interval '75 seconds'/);
  assert.ok(!/invited_at/.test(topic), 'una invitación sin entrar no da el canal');
  assert.match(topic, /f\.requester = r\.owner and f\.addressee = \(select auth\.uid\(\)\) and f\.status = 'blocked'/);
  assert.match(fn('public', 'voice_leave').body, /set last_seen = null, session_id = null, session_key = null/);
  assert.match(fn('public', 'voice_invite').body, /if not private\.are_friends\(me, p_user\) then\s+return jsonb_build_object\('error', 'bad_request'\);/);
  for (const name of ['voice_join', 'voice_room_by_code']) {
    assert.match(fn('public', name).body, /f\.requester = v_room\.owner and f\.addressee = me and f\.status = 'blocked'\) then\s+return jsonb_build_object\('error', 'not_found'\);/, name);
  }
  const beat = fn('public', 'voice_heartbeat').body;
  assert.match(beat, /v_room\.is_locked and v_room\.owner <> me\s+and \(v_member\.last_seen is null or v_member\.last_seen <= now\(\) - interval '75 seconds'\) then\s+return jsonb_build_object\('error', 'locked'\);/);
  assert.match(beat, /f\.status = 'blocked'\) then\s+return jsonb_build_object\('error', 'gone'\);/);
});

test('social: editar exige poder escribir; señales con límite de 120 por minuto (PT429)', () => {
  const before = fn('public', 'social_messages_before').body;
  assert.match(before, /elsif new\.body is distinct from old\.body then\s+v_block := private\.moderation_self_block\(\);/);
  assert.match(before, /if \(select auth\.uid\(\)\) is not null and not private\.social_can_send\(old\.conversation_id\) then\s+raise exception 'not_friends' using errcode = '42501';/);
  // Borrar (deleted = true) no pasa por ese chequeo.
  assert.ok(before.indexOf('if new.deleted then') < before.indexOf('private.social_can_send'));
  const signal = fn('public', 'social_send_signal').body;
  assert.match(signal, /insert into private\.social_throttle as t/);
  assert.match(signal, /on conflict on constraint social_throttle_pkey do update/);
  assert.match(signal, /if v_hits > 120 then\s+raise exception 'rate_limited' using errcode = 'PT429';/);
  assert.ok(signal.indexOf('social_throttle') < signal.indexOf('realtime.send'), 'el límite va antes de mandar');
  assert.match(SQL, /alter table private\.social_throttle enable row level security;/);
});

test('topes de filas: 1000 en cloud_saves y 600 en shared_media, con candado por usuario', () => {
  for (const [table, limit] of [['cloud_saves', 1000], ['shared_media', 600]] as const) {
    const body = fn('private', `${table}_before`).body;
    assert.match(body, /perform pg_advisory_xact_lock\(hashtext\(/, table);
    assert.match(body, new RegExp(`from public\\.${table} \\w+ where \\w+\\.owner = new\\.owner\\) >= ${limit} then\\s+raise exception 'too_many_rows' using errcode = '54000';`), table);
    assert.match(SQL, new RegExp(`create trigger ${table}_before\\s+before insert on public\\.${table}\\s+for each row execute function private\\.${table}_before\\(\\);`), table);
  }
});

test('las funciones de public que reemplaza mantienen argumentos, retorno y security definer', () => {
  const old = functions(BEFORE);
  const replaced = FNS.filter((f) => f.schema === 'public');
  assert.ok(replaced.length >= 10);
  for (const f of replaced) {
    const prev = old.filter((x) => x.name === f.name).at(-1);
    assert.ok(prev, `${f.name} no existía antes`);
    assert.equal(f.types, prev.types, `${f.name}: argumentos`);
    assert.equal(f.returns, prev.returns, `${f.name}: retorno`);
    assert.equal(/security definer/.test(f.header), /security definer/.test(prev.header), `${f.name}: security definer`);
  }
  // Las auxiliares movidas también mantienen su firma.
  for (const name of HELPERS) {
    const prev = old.filter((x) => x.name === name).at(-1);
    const now = fn('private', name);
    assert.ok(prev, name);
    assert.equal(now.types, prev.types, `${name}: argumentos`);
    assert.equal(now.returns, prev.returns, `${name}: retorno`);
  }
});

test('todas las security definer fijan search_path', () => {
  for (const f of FNS) if (/security definer/.test(f.header)) assert.match(f.header, /set search_path = /, `${f.schema}.${f.name}`);
});
