-- Escenarios de la migración 0057_admin_equipo.sql contra una base real, SIN dejar cambios.
--
-- Cómo se usa: en una sola consulta, pegar en este orden
--     begin;
--     <todo 0057_admin_equipo.sql>
--     <este archivo>
--     rollback;
-- El bloque termina SIEMPRE con una excepción ("RESULTADOS {...}" si todo salió bien, o la comprobación que falló):
-- así la transacción queda abortada aunque falte el rollback final. Usa cuentas simuladas (ids fijos de prueba y
-- emails del dominio reservado .test) que se crean y desaparecen dentro de la transacción; no lee ni muestra datos
-- de usuarios reales.


create or replace function pg_temp.t_as(p_user uuid) returns void language sql as $f$
  select set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true),
         set_config('request.jwt.claims', case when p_user is null then '' else json_build_object('sub', p_user::text, 'role', 'authenticated')::text end, true)
$f$;

-- Corre un SQL y devuelve el mensaje del error (o null si salió bien).
create or replace function pg_temp.t_err(p_sql text) returns text language plpgsql as $f$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlerrm;
end $f$;

create or replace function pg_temp.t_user(p_id uuid, p_email text, p_confirmed boolean default true, p_anon boolean default false) returns void
language sql as $f$
  insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, is_anonymous, raw_user_meta_data, created_at, updated_at)
  values (p_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', p_email,
          case when p_confirmed then now() end, p_anon, '{}'::jsonb, now(), now())
$f$;

do $do$
declare
  -- Cuentas simuladas (ids fijos de prueba, emails del dominio reservado .test).
  o uuid := '00000000-0000-4057-8000-000000000001'; -- dueño
  a uuid := '00000000-0000-4057-8000-000000000002'; -- admin común
  u uuid := '00000000-0000-4057-8000-000000000003'; -- cuenta normal (email con mayúsculas)
  n uuid := '00000000-0000-4057-8000-000000000004'; -- sin confirmar
  b uuid := '00000000-0000-4057-8000-000000000005'; -- baneada en Auth
  m uuid := '00000000-0000-4057-8000-000000000006'; -- baneada en user_moderation
  x uuid := '00000000-0000-4057-8000-000000000007'; -- anónima
  c uuid := '00000000-0000-4057-8000-000000000008'; -- admin con el email "compartido"
  d uuid := '00000000-0000-4057-8000-000000000009'; -- admin que se cambió el email (fila vieja con el compartido)
  w uuid := '00000000-0000-4057-8000-00000000000a'; -- cuenta que después toma el email viejo de u
  o2 uuid := '00000000-0000-4057-8000-00000000000b'; -- otra cuenta owner (no se puede quitar)
  ghost uuid := '00000000-0000-4057-8000-0000000000ff'; -- no existe
  checks integer := 0;
  r jsonb;
  e text;
  before_log bigint;
begin
  perform pg_temp.t_user(o, 'dueno.0057@example.test');
  perform pg_temp.t_user(a, 'admin.0057@example.test');
  perform pg_temp.t_user(u, 'Nuevo.Admin.0057@Example.test');
  perform pg_temp.t_user(n, 'sinconfirmar.0057@example.test', false);
  perform pg_temp.t_user(b, 'baneado.0057@example.test');
  perform pg_temp.t_user(m, 'moderado.0057@example.test');
  perform pg_temp.t_user(x, null, false, true);
  perform pg_temp.t_user(c, 'compartido.0057@example.test');
  perform pg_temp.t_user(d, 'd.nuevo.0057@example.test');
  perform pg_temp.t_user(w, 'otra.0057@example.test');
  perform pg_temp.t_user(o2, 'dueno2.0057@example.test');
  update auth.users set banned_until = now() + interval '7 days' where id = b;
  insert into public.user_moderation (user_id, banned_until, ban_reason) values (m, now() + interval '7 days', 'prueba 0057');

  insert into public.app_admin_emails (email, note) values
    ('dueno.0057@example.test', 'prueba'), ('admin.0057@example.test', 'prueba'), ('compartido.0057@example.test', 'prueba'),
    ('d.nuevo.0057@example.test', 'prueba'), ('dueno2.0057@example.test', 'prueba')
  on conflict (email) do nothing;
  insert into public.app_admins (user_id, email) values
    (o, 'dueno.0057@example.test'), (a, 'admin.0057@example.test'), (c, 'compartido.0057@example.test'),
    (d, 'compartido.0057@example.test'), -- fila vieja: d se registró con el email compartido y después lo cambió
    (o2, 'dueno2.0057@example.test');
  update public.profiles set rank = 'owner' where id in (o, o2);
  update public.profiles set rank = 'admin' where id = a;

  -- ---------- Permisos (anon nunca; authenticated solo lo del panel; private solo service_role) ----------
  if has_function_privilege('anon', 'public.admin_team()', 'execute') then raise exception 'anon puede admin_team'; end if;
  if has_function_privilege('anon', 'public.admin_grant_admin(uuid)', 'execute') then raise exception 'anon puede grant'; end if;
  if not has_function_privilege('authenticated', 'public.admin_grant_admin(uuid)', 'execute') then raise exception 'authenticated sin grant'; end if;
  if has_function_privilege('authenticated', 'private.admin_is_owner(uuid)', 'execute') then raise exception 'authenticated puede admin_is_owner'; end if;
  if has_function_privilege('authenticated', 'private.admin_team_blocker(uuid)', 'execute') then raise exception 'authenticated puede admin_team_blocker'; end if;
  checks := checks + 5;

  -- ---------- Dueño ----------
  if not private.admin_is_owner(o) then raise exception 'o debería ser dueño'; end if;
  if private.admin_is_owner(a) then raise exception 'a no es dueño'; end if;
  if private.admin_is_owner(u) then raise exception 'u no es dueño'; end if;
  checks := checks + 3;

  -- ---------- admin_team ----------
  perform pg_temp.t_as(u);
  e := pg_temp.t_err('select public.admin_team()');
  if e is distinct from 'admin_only' then raise exception 'admin_team sin ser admin: %', e; end if;
  perform pg_temp.t_as(a);
  r := public.admin_team();
  if (r -> 'me' ->> 'isOwner')::boolean then raise exception 'a no debería verse como dueño'; end if;
  if not exists (select 1 from jsonb_array_elements(r -> 'admins') t where t ->> 'userId' = o::text and (t ->> 'isOwner')::boolean and (t ->> 'active')::boolean) then
    raise exception 'admin_team no marca al dueño';
  end if;
  perform pg_temp.t_as(o);
  if not (public.admin_team() -> 'me' ->> 'isOwner')::boolean then raise exception 'o debería verse como dueño'; end if;
  checks := checks + 4;

  -- ---------- Un admin común no puede dar ni quitar (aunque llame el RPC a mano) ----------
  perform pg_temp.t_as(a);
  e := pg_temp.t_err(format('select public.admin_grant_admin(%L)', u));
  if e is distinct from 'owner_only' then raise exception 'grant por admin común: %', e; end if;
  e := pg_temp.t_err(format('select public.admin_revoke_admin(%L)', c));
  if e is distinct from 'owner_only' then raise exception 'revoke por admin común: %', e; end if;
  perform pg_temp.t_as(u);
  e := pg_temp.t_err(format('select public.admin_grant_admin(%L)', u));
  if e is distinct from 'owner_only' then raise exception 'grant a sí mismo por usuario común: %', e; end if;
  perform pg_temp.t_as(null);
  e := pg_temp.t_err(format('select public.admin_grant_admin(%L)', u));
  if e is distinct from 'owner_only' then raise exception 'grant sin sesión: %', e; end if;
  if public.admin_is_admin_user(u) then raise exception 'u no debería ser admin'; end if;
  checks := checks + 5;

  -- ---------- Cuentas que no pueden recibir el acceso ----------
  perform pg_temp.t_as(o);
  e := pg_temp.t_err(format('select public.admin_grant_admin(%L)', ghost));
  if e is distinct from 'unknown_user' then raise exception 'grant inexistente: %', e; end if;
  e := pg_temp.t_err('select public.admin_grant_admin(null)');
  if e is distinct from 'unknown_user' then raise exception 'grant null: %', e; end if;
  e := pg_temp.t_err(format('select public.admin_grant_admin(%L)', n));
  if e is distinct from 'unconfirmed' then raise exception 'grant sin confirmar: %', e; end if;
  e := pg_temp.t_err(format('select public.admin_grant_admin(%L)', b));
  if e is distinct from 'banned' then raise exception 'grant baneado (Auth): %', e; end if;
  e := pg_temp.t_err(format('select public.admin_grant_admin(%L)', m));
  if e is distinct from 'banned' then raise exception 'grant baneado (moderación): %', e; end if;
  e := pg_temp.t_err(format('select public.admin_grant_admin(%L)', x));
  if e is distinct from 'anonymous' then raise exception 'grant anónimo: %', e; end if;
  update auth.users set deleted_at = now() where id = w;
  e := pg_temp.t_err(format('select public.admin_grant_admin(%L)', w));
  if e is distinct from 'unknown_user' then raise exception 'grant borrada: %', e; end if;
  update auth.users set deleted_at = null where id = w;
  if exists (select 1 from public.app_admin_emails where email in ('sinconfirmar.0057@example.test', 'baneado.0057@example.test', 'moderado.0057@example.test')) then
    raise exception 'un grant fallido dejó el email en la lista';
  end if;
  checks := checks + 8;

  -- ---------- Dar admin (email con mayúsculas, idempotente, registro) ----------
  select count(*) into before_log from public.admin_actions where action = 'admin.grant' and target_user = u;
  r := public.admin_grant_admin(u);
  if not (r ->> 'changed')::boolean or r ->> 'rank' <> 'admin' then raise exception 'grant u: %', r; end if;
  if not public.admin_is_admin_user(u) then raise exception 'u debería ser admin'; end if;
  if not exists (select 1 from public.app_admin_emails where email = 'nuevo.admin.0057@example.test') then raise exception 'email no quedó en minúsculas'; end if;
  if (select email from public.app_admins where user_id = u) <> 'nuevo.admin.0057@example.test' then raise exception 'app_admins.email no quedó en minúsculas'; end if;
  if (select rank from public.profiles where id = u) <> 'admin' then raise exception 'rango de u no es admin'; end if;
  r := public.admin_grant_admin(u);
  if (r ->> 'changed')::boolean then raise exception 'el segundo grant debería ser sin cambios: %', r; end if;
  if (select count(*) from public.admin_actions where action = 'admin.grant' and target_user = u) <> before_log + 1 then raise exception 'admin.grant debería registrarse una sola vez'; end if;
  if exists (select 1 from public.admin_actions where action = 'admin.grant' and target_user = u and details::text ilike '%@%') then raise exception 'el registro no debe llevar el email de la cuenta'; end if;
  -- Un rango mayor no se pisa: o2 (owner) sigue owner aunque se le "dé" admin.
  r := public.admin_grant_admin(o2);
  if (select rank from public.profiles where id = o2) <> 'owner' then raise exception 'grant le bajó el rango a un owner'; end if;
  checks := checks + 8;

  -- ---------- Recién nombrado: es admin pero no dueño ----------
  perform pg_temp.t_as(u);
  if (public.admin_team() -> 'me' ->> 'isOwner')::boolean then raise exception 'u no es dueño'; end if;
  e := pg_temp.t_err(format('select public.admin_grant_admin(%L)', w));
  if e is distinct from 'owner_only' then raise exception 'u no puede dar admin: %', e; end if;
  checks := checks + 2;

  -- ---------- Quitar: no a sí mismo, no a un owner ----------
  perform pg_temp.t_as(o);
  e := pg_temp.t_err(format('select public.admin_revoke_admin(%L)', o));
  if e is distinct from 'cannot_self' then raise exception 'revoke a sí mismo: %', e; end if;
  e := pg_temp.t_err(format('select public.admin_revoke_admin(%L)', o2));
  if e is distinct from 'owner_locked' then raise exception 'revoke owner: %', e; end if;
  e := pg_temp.t_err(format('select public.admin_revoke_admin(%L)', ghost));
  if e is distinct from 'unknown_user' then raise exception 'revoke inexistente: %', e; end if;
  if not public.admin_is_admin_user(o2) then raise exception 'o2 debería seguir siendo admin'; end if;
  checks := checks + 4;

  -- ---------- Quitar: corta al instante y baja el rango ----------
  r := public.admin_revoke_admin(u);
  if not (r ->> 'changed')::boolean or (r ->> 'isAdmin')::boolean then raise exception 'revoke u: %', r; end if;
  if public.admin_is_admin_user(u) then raise exception 'u sigue siendo admin'; end if;
  if (select rank from public.profiles where id = u) is not null then raise exception 'el rango admin no se bajó'; end if;
  if exists (select 1 from public.app_admin_emails where email = 'nuevo.admin.0057@example.test') then raise exception 'el email de u quedó en la lista'; end if;
  perform pg_temp.t_as(u);
  e := pg_temp.t_err('select public.admin_team()');
  if e is distinct from 'admin_only' then raise exception 'u todavía lee el equipo: %', e; end if;
  perform pg_temp.t_as(o);
  r := public.admin_revoke_admin(u);
  if (r ->> 'changed')::boolean then raise exception 'el segundo revoke debería ser sin cambios: %', r; end if;
  checks := checks + 6;

  -- ---------- Dos cuentas con el mismo email en la lista ----------
  -- d tiene una fila vieja con el email de c; quitar a d no puede dejar sin acceso a c.
  if not public.admin_is_admin_user(c) then raise exception 'c debería ser admin'; end if;
  r := public.admin_revoke_admin(d);
  if not public.admin_is_admin_user(c) then raise exception 'quitar a d le cortó el acceso a c'; end if;
  if not exists (select 1 from public.app_admin_emails where email = 'compartido.0057@example.test') then raise exception 'se borró el email que usa c'; end if;
  if exists (select 1 from public.app_admin_emails where email = 'd.nuevo.0057@example.test') then raise exception 'quedó el email actual de d'; end if;
  checks := checks + 3;

  -- ---------- Cambio de email después de ser admin ----------
  r := public.admin_grant_admin(w);
  update auth.users set email = 'otra.cambiada.0057@example.test' where id = w;
  if public.admin_is_admin_user(w) then raise exception 'con otro email no debería seguir siendo admin'; end if;
  r := public.admin_grant_admin(w);
  if not public.admin_is_admin_user(w) then raise exception 'volver a dar admin con el email nuevo no funcionó'; end if;
  if (select email from public.app_admins where user_id = w) <> 'otra.cambiada.0057@example.test' then raise exception 'app_admins.email no se actualizó'; end if;
  r := public.admin_revoke_admin(w);
  if exists (select 1 from public.app_admin_emails where email in ('otra.cambiada.0057@example.test')) then raise exception 'quedó el email nuevo de w'; end if;
  checks := checks + 4;

  -- ---------- Rangos ----------
  perform pg_temp.t_as(a);
  e := pg_temp.t_err(format('select public.admin_set_rank(%L, %L)', u, 'admin'));
  if e is distinct from 'bad_rank' then raise exception 'set_rank admin: %', e; end if;
  e := pg_temp.t_err(format('select public.admin_set_rank(%L, %L)', a, 'mod'));
  if e is distinct from 'admin_locked' then raise exception 'set_rank sobre admin activo: %', e; end if;
  e := pg_temp.t_err(format('select public.admin_set_rank(%L, %L)', o, 'mod'));
  if e is distinct from 'owner_locked' then raise exception 'set_rank sobre owner: %', e; end if;
  r := public.admin_set_rank(u, 'mod');
  if (select rank from public.profiles where id = u) <> 'mod' then raise exception 'set_rank mod no se guardó'; end if;
  -- Insignia admin vieja (sin acceso): se puede limpiar.
  update public.profiles set rank = 'admin' where id = n;
  r := public.admin_set_rank(n, null);
  if (select rank from public.profiles where id = n) is not null then raise exception 'no se pudo limpiar una insignia admin vieja'; end if;
  perform pg_temp.t_as(u);
  e := pg_temp.t_err(format('select public.admin_set_rank(%L, %L)', w, 'mod'));
  if e is distinct from 'admin_only' then raise exception 'set_rank por usuario común: %', e; end if;
  checks := checks + 6;

  -- ---------- Personal de soporte ----------
  perform pg_temp.t_as(u);
  e := pg_temp.t_err(format('select public.admin_set_support_staff(%L, true)', u));
  if e is distinct from 'admin_only' then raise exception 'staff por usuario común: %', e; end if;
  perform pg_temp.t_as(a);
  e := pg_temp.t_err(format('select public.admin_set_support_staff(%L, true)', n));
  if e is distinct from 'unconfirmed' then raise exception 'staff sin confirmar: %', e; end if;
  e := pg_temp.t_err(format('select public.admin_set_support_staff(%L, null)', u));
  if e is distinct from 'bad_request' then raise exception 'staff null: %', e; end if;
  r := public.admin_set_support_staff(u, true);
  if not (r ->> 'changed')::boolean or not private.support_is_staff(u) then raise exception 'staff u: %', r; end if;
  if public.admin_is_admin_user(u) then raise exception 'soporte no da admin'; end if;
  r := public.admin_set_support_staff(u, true);
  if (r ->> 'changed')::boolean then raise exception 'staff repetido debería ser sin cambios'; end if;
  if not exists (select 1 from jsonb_array_elements(public.admin_team() -> 'staff') s where s ->> 'userId' = u::text and (s ->> 'active')::boolean) then
    raise exception 'admin_team no lista a u en soporte';
  end if;
  -- u se cambia el email: deja de valer, y otra cuenta que toma ese email puede ser soporte (índice único por email).
  update auth.users set email = 'u.cambiada.0057@example.test' where id = u;
  if private.support_is_staff(u) then raise exception 'soporte con otro email no debería valer'; end if;
  update auth.users set email = 'nuevo.admin.0057@example.test' where id = w;
  r := public.admin_set_support_staff(w, true);
  if not private.support_is_staff(w) then raise exception 'w debería ser soporte'; end if;
  if (select active from public.support_staff where user_id = u) then raise exception 'la fila vieja de u con el mismo email debería quedar inactiva'; end if;
  r := public.admin_set_support_staff(w, false);
  if private.support_is_staff(w) then raise exception 'w debería dejar de ser soporte'; end if;
  if not exists (select 1 from public.admin_actions where action = 'support.staffRevoked' and target_user = w) then raise exception 'falta el registro de soporte'; end if;
  checks := checks + 10;

  raise exception 'RESULTADOS %', jsonb_build_object('comprobaciones', checks, 'fns', (select jsonb_agg(md5(regexp_replace(p.prosrc, '\s+', '', 'g')) order by 1) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'private') and p.xmin::text = (txid_current() % 4294967296)::text))::text;
end $do$;
