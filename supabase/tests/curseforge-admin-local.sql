-- 0037: ensayo funcional y de permisos en PostgreSQL local descartable.
-- Ejecutar mediante scripts/run-curseforge-admin-local.ps1: carga 0001..0036 completas.
-- Solo identidades/valores ficticios. El sustituto de Vault NO prueba cifrado ni ACL administradas reales.
-- Contrato de create_secret/update_secret: https://supabase.com/docs/guides/database/vault
-- No prueba HTTP, JWT real, el proveedor CurseForge ni concurrencia entre conexiones.
\set ON_ERROR_STOP on
\set ON_ERROR_ROLLBACK off
\if :{?venus_disposable}
\else
  \echo 'Falta -v venus_disposable=on: solo base local descartable.'
  \quit 3
\endif
\if :venus_disposable
\else
  \quit 3
\endif

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '90s';
SET LOCAL idle_in_transaction_session_timeout = '120s';
SET LOCAL timezone = 'UTC';
SET LOCAL search_path = public, pg_catalog;

DO $guard$
begin
  if current_database() <> 'venus_sql_test' or inet_server_addr() is null
     or not inet_server_addr() <<= '127.0.0.0/8'::inet
     or not (select rolsuper from pg_roles where rolname = session_user) then
    raise exception 'Solo postgres de venus_sql_test descartable en loopback, sin túneles';
  end if;
  if exists (select 1 from auth.users) or exists (select 1 from vault.secrets) then
    raise exception 'El ensayo requiere fixtures sin usuarios ni secretos';
  end if;
  if to_regclass('public.community_extensions') is null or to_regclass('public.clan_prefs') is null
     or to_regclass('private.curseforge_rate') is not null then
    raise exception 'Se requiere 0001..0036, sin 0037';
  end if;
  if exists (select 1 from pg_extension where extname in ('supabase_vault', 'pgsodium'))
     or to_regprocedure('vault.create_secret(text,text,text)') is not null
     or not exists (select 1 from pg_constraint where conrelid = 'vault.secrets'::regclass
       and contype = 'c' and pg_get_constraintdef(oid) = 'CHECK (false)') then
    raise exception 'Solo se puede sustituir el Vault vacío de managed-schemas-minimal.sql';
  end if;
end $guard$;

-- Evita hooks de Auth; las cuentas se crean solo como fixtures de esta transacción.
ALTER TABLE auth.users DISABLE TRIGGER USER;
-- nextval no es transaccional; RESTART sí. Aísla secuencias para comprobar rollback exacto.
DO $sequences$
declare s record; last_n bigint; called boolean;
begin
  for s in select c.oid::regclass as name, q.seqincrement
    from pg_class c join pg_sequence q on q.seqrelid = c.oid
    where c.relnamespace in ('public'::regnamespace, 'private'::regnamespace) loop
    execute format('select last_value, is_called from %s', s.name) into last_n, called;
    execute format('alter sequence %s restart with %s', s.name,
      last_n + case when called then s.seqincrement else 0 end);
  end loop;
end $sequences$;

-- Sustituto local, limitado a valores reconocibles de prueba; nunca cifra datos.
-- Todo este reemplazo también desaparece con ROLLBACK; no modifica el fixture compartido.
DROP VIEW vault.decrypted_secrets;
DROP TABLE vault.secrets;
CREATE TABLE vault.secrets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text UNIQUE NOT NULL,
  secret text NOT NULL CHECK (secret LIKE 'venus-fixture-%'),
  description text
);
CREATE VIEW vault.decrypted_secrets AS
  SELECT id, name, secret AS decrypted_secret FROM vault.secrets;
CREATE FUNCTION vault.create_secret(new_secret text, new_name text DEFAULT NULL, new_description text DEFAULT '')
RETURNS uuid LANGUAGE plpgsql SET search_path = '' AS $fn$
declare result uuid;
begin
  insert into vault.secrets (secret, name, description) values (new_secret, new_name, new_description)
    returning id into result;
  return result;
end $fn$;
CREATE FUNCTION vault.update_secret(secret_id uuid, new_secret text DEFAULT NULL,
  new_name text DEFAULT NULL, new_description text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SET search_path = '' AS $fn$
begin
  update vault.secrets set secret = coalesce(new_secret, secret),
    name = coalesce(new_name, name), description = coalesce(new_description, description)
    where id = secret_id;
end $fn$;
REVOKE ALL ON SCHEMA vault FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL TABLES IN SCHEMA vault FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA vault FROM PUBLIC, anon, authenticated, service_role;

CREATE TEMP TABLE venus_cf_checks (label text PRIMARY KEY);
DO $temp_access$
begin
  execute format('grant usage on schema %I to anon, authenticated, service_role',
    (select nspname from pg_namespace where oid = pg_my_temp_schema()));
end $temp_access$;
GRANT INSERT ON venus_cf_checks TO anon, authenticated, service_role;
CREATE FUNCTION pg_temp.cf_assert(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $fn$
begin
  if ok is distinct from true then raise exception 'FAIL: %', label; end if;
  insert into pg_temp.venus_cf_checks values (label);
end $fn$;
CREATE FUNCTION pg_temp.cf_login(who uuid, db_role text DEFAULT 'authenticated')
RETURNS void LANGUAGE plpgsql AS $fn$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claim', '', true);
  perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', db_role)::text, true);
  execute format('set local role %I', db_role);
end $fn$;
CREATE FUNCTION pg_temp.cf_expect_state(command text, expected text, label text)
RETURNS void LANGUAGE plpgsql AS $fn$
declare caught boolean := false;
begin
  begin
    execute command;
  exception when others then
    if sqlstate <> expected then raise; end if;
    caught := true;
  end;
  perform pg_temp.cf_assert(caught, label);
end $fn$;

\ir ../migrations/0037_curseforge_admin.sql

DO $catalog$
declare f record; r text;
begin
  perform pg_temp.cf_assert((select relrowsecurity from pg_class
    where oid = 'private.curseforge_rate'::regclass), 'ACL rate con RLS');
  for f in select p.* from pg_proc p where p.oid in (
    'public.admin_curseforge_status()'::regprocedure, 'public.admin_set_curseforge_key(text)'::regprocedure,
    'public.curseforge_status()'::regprocedure, 'public.curseforge_proxy_access(uuid)'::regprocedure) loop
    perform pg_temp.cf_assert(f.prosecdef, 'ACL security definer ' || f.proname);
    perform pg_temp.cf_assert(exists (select 1 from unnest(f.proconfig) c
      where c in ('search_path=""', 'search_path=')), 'ACL search_path vacío ' || f.proname);
    perform pg_temp.cf_assert(not exists (select 1 from aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) a
      where a.grantee = 0 and a.privilege_type = 'EXECUTE'), 'ACL sin PUBLIC ' || f.proname);
    perform pg_temp.cf_assert(has_function_privilege('anon', f.oid, 'EXECUTE') =
      (f.proname = 'curseforge_status'), 'ACL anon ' || f.proname);
    perform pg_temp.cf_assert(has_function_privilege('authenticated', f.oid, 'EXECUTE') =
      (f.proname <> 'curseforge_proxy_access'), 'ACL authenticated ' || f.proname);
  end loop;
  perform pg_temp.cf_assert(has_function_privilege('service_role',
    'public.curseforge_proxy_access(uuid)', 'EXECUTE'), 'ACL proxy disponible para service_role');
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    perform pg_temp.cf_assert(not has_table_privilege(r, 'vault.secrets', 'SELECT,INSERT,UPDATE,DELETE')
      and not has_table_privilege(r, 'vault.decrypted_secrets', 'SELECT'),
      'ACL Vault de prueba sin lectura directa ' || r);
  end loop;
  foreach r in array array['anon', 'authenticated'] loop
    perform pg_temp.cf_assert(not has_table_privilege(r, 'private.curseforge_rate',
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'), 'ACL rate sin acceso directo ' || r);
  end loop;
end $catalog$;

DO $scenarios$
declare
  staff uuid := gen_random_uuid(); a uuid := gen_random_uuid(); b uuid := gen_random_uuid();
  banned uuid := gen_random_uuid(); guest uuid := gen_random_uuid(); deleted uuid := gen_random_uuid();
  moderated uuid := gen_random_uuid(); unknown_user uuid := gen_random_uuid();
  staff_email text := 'curseforge-fixture@example.invalid';
  key_a text := 'venus-fixture-cf-first-1001'; key_b text := 'venus-fixture-cf-replacement-2002';
  secret_id uuid; v jsonb; i integer; accepted integer := 0; old_window timestamptz;
  bad text; target uuid; rejected integer := 0;
begin
  insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data)
    select id, 'authenticated', 'authenticated', case when id = staff then staff_email
      else 'cf-' || id::text || '@example.invalid' end, now(), '{}', '{}'
    from unnest(array[staff, a, b, banned, guest, deleted, moderated]) id;
  insert into public.app_admin_emails (email) values (staff_email);
  insert into public.app_admins (user_id, email) values (staff, staff_email) on conflict (user_id) do nothing;
  update auth.users set banned_until = now() + interval '1 day' where id = banned;
  update auth.users set is_anonymous = true where id = guest;
  update auth.users set deleted_at = now() where id = deleted;
  insert into public.user_moderation (user_id, banned_until) values (moderated, now() + interval '1 day');
  perform pg_temp.cf_assert(public.admin_is_admin_user(staff), 'admin fixture confirmado');

  perform pg_temp.cf_login(null, 'anon');
  perform pg_temp.cf_assert(public.curseforge_status() = '{"configured":false}', 'estado anon sin configurar');
  perform pg_temp.cf_expect_state('select public.admin_curseforge_status()', '42501', 'admin estado rechaza rol anon');
  perform pg_temp.cf_expect_state(format('select public.admin_set_curseforge_key(%L)', key_a),
    '42501', 'admin guardar rechaza rol anon');
  perform pg_temp.cf_expect_state(format('select public.curseforge_proxy_access(%L)', a),
    '42501', 'proxy rechaza rol anon');
  perform pg_temp.cf_expect_state('select decrypted_secret from vault.decrypted_secrets',
    '42501', 'Vault lectura directa anon denegada');
  execute 'reset role';

  perform pg_temp.cf_login(a);
  perform pg_temp.cf_expect_state('select public.admin_curseforge_status()', '42501', 'admin estado rechaza cuenta común');
  perform pg_temp.cf_expect_state(format('select public.admin_set_curseforge_key(%L)', key_a),
    '42501', 'admin guardar rechaza cuenta común');
  perform pg_temp.cf_expect_state(format('select public.curseforge_proxy_access(%L)', a),
    '42501', 'proxy rechaza authenticated');
  perform pg_temp.cf_expect_state('select decrypted_secret from vault.decrypted_secrets',
    '42501', 'Vault lectura directa authenticated denegada');
  execute 'reset role';

  perform pg_temp.cf_login(null);
  perform pg_temp.cf_expect_state('select public.admin_curseforge_status()', '42501', 'admin estado exige identidad');
  perform pg_temp.cf_expect_state(format('select public.admin_set_curseforge_key(%L)', key_a),
    '42501', 'admin guardar exige identidad');
  execute 'reset role';
  perform pg_temp.cf_login(null, 'service_role');
  perform pg_temp.cf_expect_state('select public.admin_curseforge_status()', '42501', 'admin estado sin uid service denegado');
  perform pg_temp.cf_expect_state(format('select public.admin_set_curseforge_key(%L)', key_a),
    '42501', 'admin guardar sin uid service denegado');
  perform pg_temp.cf_assert(public.curseforge_proxy_access(a) = '{"error":"not_configured"}',
    'proxy sin configuración');
  perform pg_temp.cf_expect_state('select decrypted_secret from vault.decrypted_secrets',
    '42501', 'Vault lectura directa service denegada en fixture');
  execute 'reset role';
  perform pg_temp.cf_assert(not exists (select 1 from private.curseforge_rate), 'sin clave no consume cuota');

  perform pg_temp.cf_login(staff);
  perform pg_temp.cf_assert(public.admin_curseforge_status() = '{"configured":false,"hint":null}', 'admin estado inicial');
  perform pg_temp.cf_assert(public.admin_set_curseforge_key('  ' || key_a || '  ') =
    '{"configured":true,"hint":"1001"}', 'admin guarda clave con trim y solo hint');
  perform pg_temp.cf_assert(public.admin_curseforge_status() = '{"configured":true,"hint":"1001"}', 'admin lee hint');
  execute 'reset role';
  select id into secret_id from vault.secrets where name = 'venus_curseforge_key';
  perform pg_temp.cf_assert(secret_id is not null and (select secret = key_a from vault.secrets where id = secret_id),
    'Vault stub guarda valor ficticio');
  perform pg_temp.cf_login(null, 'anon');
  perform pg_temp.cf_assert(public.curseforge_status() = '{"configured":true}', 'anon recibe solo configured');
  execute 'reset role';
  perform pg_temp.cf_login(a);
  perform pg_temp.cf_assert(public.curseforge_status() = '{"configured":true}', 'cuenta recibe solo configured');
  execute 'reset role';

  perform pg_temp.cf_login(staff);
  perform pg_temp.cf_assert(public.admin_set_curseforge_key(key_b) = '{"configured":true,"hint":"2002"}',
    'admin reemplaza clave y hint');
  perform pg_temp.cf_assert(public.admin_curseforge_status() = '{"configured":true,"hint":"2002"}',
    'admin estado después de reemplazar');
  i := 0;
  foreach bad in array array['short', repeat('x', 201), 'venus-fixture-con espacio', E'venus-fixture-linea\nnueva'] loop
    i := i + 1;
    perform pg_temp.cf_expect_state(format('select public.admin_set_curseforge_key(%L)', bad),
      '22023', 'admin formato inválido ' || i::text);
  end loop;
  execute 'reset role';
  perform pg_temp.cf_assert((select count(*) = 1 from vault.secrets)
    and (select id = secret_id and secret = key_b from vault.secrets where name = 'venus_curseforge_key'),
    'reemplazo conserva id sin duplicar; entradas inválidas no cambian valor');

  update auth.users set banned_until = now() + interval '1 day' where id = staff;
  perform pg_temp.cf_login(staff);
  perform pg_temp.cf_expect_state('select public.admin_curseforge_status()', '42501', 'admin baneado sin estado');
  perform pg_temp.cf_expect_state(format('select public.admin_set_curseforge_key(%L)', key_a),
    '42501', 'admin baneado no modifica');
  execute 'reset role';
  update auth.users set banned_until = null, email_confirmed_at = null where id = staff;
  perform pg_temp.cf_login(staff);
  perform pg_temp.cf_expect_state('select public.admin_curseforge_status()', '42501', 'admin email sin confirmar sin estado');
  perform pg_temp.cf_expect_state(format('select public.admin_set_curseforge_key(%L)', key_a),
    '42501', 'admin email sin confirmar no modifica');
  execute 'reset role';
  update auth.users set email_confirmed_at = now() where id = staff;

  perform pg_temp.cf_login(null, 'service_role');
  foreach target in array array[null::uuid, unknown_user, banned, guest, deleted, moderated] loop
    v := public.curseforge_proxy_access(target);
    if v = '{"error":"forbidden"}' then rejected := rejected + 1; end if;
  end loop;
  perform pg_temp.cf_assert(rejected = 6, 'proxy rechaza null inexistente ban Auth anónimo borrado y ban social');
  execute 'reset role';
  perform pg_temp.cf_assert(not exists (select 1 from private.curseforge_rate), 'cuentas rechazadas sin cuota');

  perform pg_temp.cf_login(null, 'service_role');
  v := public.curseforge_proxy_access(a);
  perform pg_temp.cf_assert(v = jsonb_build_object('key', key_b), 'proxy service recibe solo clave ficticia vigente');
  accepted := 1;
  for i in 2..240 loop
    if public.curseforge_proxy_access(a) = jsonb_build_object('key', key_b) then accepted := accepted + 1; end if;
  end loop;
  perform pg_temp.cf_assert(accepted = 240, 'rate admite exactamente primeras 240 consultas');
  perform pg_temp.cf_assert(public.curseforge_proxy_access(a) = '{"error":"rate_limit"}', 'rate consulta 241 denegada');
  perform pg_temp.cf_assert(public.curseforge_proxy_access(a) = '{"error":"rate_limit"}', 'rate reintento sigue denegado');
  perform pg_temp.cf_assert(public.curseforge_proxy_access(b) = jsonb_build_object('key', key_b),
    'rate segunda cuenta conserva cuota independiente');
  execute 'reset role';
  select window_at into old_window from private.curseforge_rate where user_id = a;
  perform pg_temp.cf_assert((select requests = 240 from private.curseforge_rate where user_id = a)
    and (select requests = 1 from private.curseforge_rate where user_id = b), 'rate contadores 240 y 1');
  perform pg_temp.cf_assert(old_window > clock_timestamp() - interval '1 minute', 'rate ensayado dentro de una ventana');
  -- Mueve solo el reloj de la fila ficticia; no espera un minuto ni altera funciones de producción.
  update private.curseforge_rate set window_at = clock_timestamp() - interval '2 minutes' where user_id = a;
  perform pg_temp.cf_login(null, 'service_role');
  perform pg_temp.cf_assert(public.curseforge_proxy_access(a) = jsonb_build_object('key', key_b), 'rate nueva ventana permite consulta');
  execute 'reset role';
  perform pg_temp.cf_assert((select requests = 1 and window_at > old_window from private.curseforge_rate where user_id = a),
    'rate nueva ventana reinicia contador y fecha');
  delete from auth.users where id = b;
  perform pg_temp.cf_assert(not exists (select 1 from private.curseforge_rate where user_id = b)
    and exists (select 1 from private.curseforge_rate where user_id = a), 'rate cascada elimina solo cuenta borrada');
  perform pg_temp.cf_login(null, 'service_role');
  perform pg_temp.cf_assert(public.curseforge_proxy_access(b) = '{"error":"forbidden"}', 'proxy cuenta eliminada sin acceso');
  execute 'reset role';

  perform pg_temp.cf_login(staff);
  perform pg_temp.cf_assert(public.admin_set_curseforge_key('   ') = '{"configured":false,"hint":null}',
    'admin quita clave con blanco');
  perform pg_temp.cf_assert(public.admin_set_curseforge_key(null) = '{"configured":false,"hint":null}',
    'admin quitar ausente con null es válido');
  perform pg_temp.cf_assert(public.admin_curseforge_status() = '{"configured":false,"hint":null}',
    'admin estado después de quitar');
  execute 'reset role';
  perform pg_temp.cf_assert(not exists (select 1 from vault.secrets), 'Vault stub vacío después de quitar');
  perform pg_temp.cf_login(null, 'anon');
  perform pg_temp.cf_assert(public.curseforge_status() = '{"configured":false}', 'anon estado después de quitar');
  execute 'reset role';
  perform pg_temp.cf_login(null, 'service_role');
  perform pg_temp.cf_assert(public.curseforge_proxy_access(a) = '{"error":"not_configured"}', 'proxy sin clave después de quitar');
  execute 'reset role';
  perform pg_temp.cf_assert((select requests = 1 from private.curseforge_rate where user_id = a),
    'quitar clave no consume cuota');
  perform pg_temp.cf_assert((select count(*) = 4 from public.admin_actions where action = 'curseforge.key'),
    'audit cuatro operaciones válidas y ninguna rechazada');
  perform pg_temp.cf_assert(not exists (select 1 from public.admin_actions where action = 'curseforge.key'
    and (admin_id is distinct from staff or admin_email is distinct from staff_email or target_user is not null
      or details not in ('{"configured":true}'::jsonb, '{"configured":false}'::jsonb))),
    'audit solo identidad y estado configured');
  perform pg_temp.cf_assert(not exists (select 1 from public.admin_actions x
    where to_jsonb(x)::text like '%' || key_a || '%' or to_jsonb(x)::text like '%' || key_b || '%'
      or details ? 'key' or details ? 'hint' or details ? 'secret'),
    'audit sin valores de clave ni hint');
end $scenarios$;

SELECT label FROM pg_temp.venus_cf_checks ORDER BY label;
SELECT count(*) AS checks FROM pg_temp.venus_cf_checks;
SELECT count(*) AS cf_checks FROM pg_temp.venus_cf_checks \gset
\echo CURSEFORGE_CHECKS=:cf_checks
ROLLBACK;

DO $rolled_back$
begin
  if to_regclass('private.curseforge_rate') is not null
     or to_regprocedure('public.curseforge_status()') is not null
     or exists (select 1 from auth.users) or exists (select 1 from vault.secrets)
     or exists (select 1 from public.admin_actions where action = 'curseforge.key')
     or to_regprocedure('vault.create_secret(text,text,text)') is not null then
    raise exception 'Rollback incompleto de esquema o filas';
  end if;
end $rolled_back$;
\echo CURSEFORGE_ROLLBACK_OK
