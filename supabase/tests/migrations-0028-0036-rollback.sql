-- Rehearsal local de 0028–0036. Ejecutar con psql -X -v venus_disposable=on -f este_archivo.
-- Requiere una base descartable con 0001–0027, sin usuarios ni integraciones externas.
-- No usar en producción. No usa Auth API, Storage API, pg_net ni credenciales de Vault.
\set ON_ERROR_STOP on
\set ON_ERROR_ROLLBACK off
\if :{?venus_disposable}
\else
  \echo 'Falta -v venus_disposable=on: solo se admite una base local descartable.'
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
  if inet_server_addr() is not null and not (inet_server_addr() <<= '127.0.0.0/8'::inet or inet_server_addr() = '::1'::inet) then
    raise exception 'Solo conexión loopback o socket local; sin túneles a otras bases';
  end if;
  if not (select rolsuper from pg_roles where rolname = session_user) then
    raise exception 'Usar el postgres del entorno local descartable';
  end if;
  if to_regclass('auth.users') is null or to_regclass('public.profile_gifts') is null then
    raise exception 'Falta el esquema base de Supabase y Venus hasta 0027';
  end if;
  if exists (select 1 from auth.users) then raise exception 'La base contiene usuarios: abortado'; end if;
  if to_regclass('public.settings_sync') is not null or to_regclass('public.clan_prefs') is not null
     or to_regclass('public.community_extensions') is not null then
    raise exception 'Este ensayo requiere 0028–0036 todavía sin aplicar';
  end if;
  -- No ejecutar webhooks personalizados: en public solo se aceptan los triggers base revisados del repositorio.
  if exists (
    select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid
    where c.relnamespace = 'public'::regnamespace and not t.tgisinternal and t.tgenabled <> 'D'
      and p.proname not in ('share__touch', 'featured_servers_touch', 'ai_touch_updated_at', 'social_messages_before',
        'social_messages_after_insert', 'social_reactions_before', 'cloud_saves_before', 'shared_media_before', 'payment_orders_check')
  ) then raise exception 'Hay triggers personalizados: revisar antes de usar el harness'; end if;
end $guard$;

-- Los hooks de Auth y Storage no son parte de este ensayo: los datos son solo filas ficticias.
ALTER TABLE auth.users DISABLE TRIGGER USER;
ALTER TABLE storage.objects DISABLE TRIGGER USER;
ALTER TABLE storage.buckets DISABLE TRIGGER USER;

-- nextval/setval no se revierten. RESTART es transaccional: aísla el estado de las secuencias preexistentes.
DO $sequences$
declare s record; last_n bigint; called boolean;
begin
  for s in select c.oid::regclass as name, q.seqincrement
             from pg_class c join pg_sequence q on q.seqrelid = c.oid
            where c.relnamespace in ('public'::regnamespace, 'private'::regnamespace) loop
    execute format('select last_value, is_called from %s', s.name) into last_n, called;
    execute format('alter sequence %s restart with %s', s.name, last_n + case when called then s.seqincrement else 0 end);
  end loop;
end $sequences$;

CREATE TEMP TABLE venus_checks (label text primary key);
DO $temp_access$
begin
  execute format('grant usage on schema %I to authenticated, anon, service_role', (select nspname from pg_namespace where oid = pg_my_temp_schema()));
end $temp_access$;
GRANT INSERT ON venus_checks TO authenticated, anon, service_role;
CREATE FUNCTION pg_temp.venus_assert(ok boolean, label text) RETURNS void
LANGUAGE plpgsql AS $fn$
begin
  if ok is distinct from true then raise exception 'FAIL: %', label; end if;
  insert into pg_temp.venus_checks values (label);
end $fn$;

CREATE FUNCTION pg_temp.venus_login(who uuid, db_role text default 'authenticated') RETURNS void
LANGUAGE plpgsql AS $fn$
begin
  -- Limpiar también los claims antiguos: auth.uid y admin_guard pueden darles prioridad.
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', db_role, 'is_anonymous', false)::text, true);
  execute format('set local role %I', db_role);
end $fn$;

CREATE TEMP TABLE venus_before_functions AS
  SELECT p.oid, pg_get_functiondef(p.oid) AS definition
    FROM pg_proc p WHERE p.pronamespace IN ('public'::regnamespace, 'private'::regnamespace) AND p.prokind = 'f';
CREATE TEMP TABLE venus_before_tables AS
  SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p');

\ir ../migrations/0028_sync_ajustes.sql
\ir ../migrations/0029_resenas_servidores.sql
\ir ../migrations/0030_stickers.sql
\ir ../migrations/0031_competencia.sql
\ir ../migrations/0032_galeria_clips.sql
\ir ../migrations/0033_clanes_comunidades.sql
\ir ../migrations/0034_capas.sql
\ir ../migrations/0035_app_celular.sql
\ir ../migrations/0036_extensiones.sql

-- Inspección real del catálogo antes de sustituir los dos destinos de efectos externos.
DO $structure$
declare f record; t record; r text; allowed boolean; expr text; accepted boolean; n integer := 0;
begin
  for f in select p.*, ns.nspname from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
             left join pg_temp.venus_before_functions b on b.oid = p.oid
            where ns.nspname in ('public', 'private') and p.prokind = 'f'
              and (b.oid is null or b.definition is distinct from pg_get_functiondef(p.oid)) loop
    n := n + 1;
    perform pg_temp.venus_assert(f.proowner = (select oid from pg_roles where rolname = session_user), 'owner:' || f.oid::regprocedure);
    perform pg_temp.venus_assert(exists (select 1 from unnest(f.proconfig) c where c in ('search_path=""', 'search_path=')), 'search_path:' || f.oid::regprocedure);
    perform pg_temp.venus_assert(not exists (select 1 from aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) a
      where a.grantee = 0 and a.privilege_type = 'EXECUTE'), 'no_PUBLIC_execute:' || f.oid::regprocedure);
    allowed := f.nspname = 'public' and f.proname in ('featured_reviews_summary', 'featured_reviews_list', 'badge_capes', 'extension_blocklist');
    perform pg_temp.venus_assert(has_function_privilege('anon', f.oid, 'EXECUTE') = allowed, 'anon_execute:' || f.oid::regprocedure);
    allowed := (f.nspname = 'public' and f.proname not in ('push_claim', 'push_drop'))
      or (f.nspname = 'private' and f.proname in ('sticker_can_upload', 'community_is_member', 'extension_can_read', 'extension_can_upload'));
    perform pg_temp.venus_assert(has_function_privilege('authenticated', f.oid, 'EXECUTE') = allowed, 'authenticated_execute:' || f.oid::regprocedure);
  end loop;
  perform pg_temp.venus_assert(n = 183, '183 funciones nuevas o reemplazadas');
  perform pg_temp.venus_assert((select count(*) = 32 from pg_class c left join pg_temp.venus_before_tables b on b.oid = c.oid
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and b.oid is null), '32 tablas nuevas');
  for t in select c.* from pg_class c left join pg_temp.venus_before_tables b on b.oid = c.oid
            where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and b.oid is null loop
    perform pg_temp.venus_assert(t.relrowsecurity, 'RLS:' || t.relname);
    perform pg_temp.venus_assert(t.relowner = (select oid from pg_roles where rolname = session_user), 'table_owner:' || t.relname);
    perform pg_temp.venus_assert(not exists (select 1 from aclexplode(coalesce(t.relacl, acldefault('r', t.relowner))) a where a.grantee = 0), 'no_PUBLIC_table:' || t.relname);
    foreach r in array array['anon', 'authenticated'] loop
      perform pg_temp.venus_assert(not has_table_privilege(r, t.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'), 'no_table_write:' || r || ':' || t.relname);
      perform pg_temp.venus_assert(not has_any_column_privilege(r, t.oid, 'INSERT,UPDATE,REFERENCES'), 'no_column_write:' || r || ':' || t.relname);
      allowed := r = 'authenticated' and t.relname = 'community_messages';
      perform pg_temp.venus_assert(has_table_privilege(r, t.oid, 'SELECT') = allowed, 'table_read:' || r || ':' || t.relname);
    end loop;
  end loop;
  perform pg_temp.venus_assert(not has_sequence_privilege('anon', 'public.ranking_reports_id_seq', 'USAGE,SELECT,UPDATE')
    and not has_sequence_privilege('authenticated', 'public.ranking_reports_id_seq', 'USAGE,SELECT,UPDATE'), 'secuencia ranking privada');
  perform pg_temp.venus_assert(exists (select 1 from pg_policy where polrelid = 'public.community_messages'::regclass
    and polname = 'community_messages_select_members' and polcmd = 'r'
    and pg_get_expr(polqual, polrelid) like '%community_is_member%'), 'política de miembros para mensajes');
  perform pg_temp.venus_assert((select count(*) = 5 from pg_policy where polrelid = 'storage.objects'::regclass
    and ((polname = 'stickers_insert_own' and polcmd = 'a') or (polname = 'stickers_select_own' and polcmd = 'r')
      or (polname = 'stickers_delete_own' and polcmd = 'd') or (polname = 'extension_packages_select' and polcmd = 'r')
      or (polname = 'extension_packages_insert' and polcmd = 'a'))
    and polroles = array[(select oid from pg_roles where rolname = 'authenticated')]), 'políticas Storage declaradas');
  perform pg_temp.venus_assert((select not public and file_size_limit = 5242880 from storage.buckets where id = 'extension-packages'), 'paquetes privados de hasta 5 MB');
  perform pg_temp.venus_assert((select public and file_size_limit = 262144 from storage.buckets where id = 'stickers'), 'stickers públicos de hasta 256 KB');
  perform pg_temp.venus_assert(has_function_privilege('service_role', 'public.push_claim(uuid,text,text)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.push_drop(uuid[])', 'EXECUTE')
    and not has_function_privilege('service_role', 'private.push_configure(text,text)', 'EXECUTE'), 'roles push y Vault');
  select pg_get_expr(conbin, conrelid) into expr from pg_constraint
    where conrelid = 'public.points_ledger'::regclass and conname = 'points_ledger_reason_check';
  foreach r in array array['daily','achievement','referral','referred','shop','admin','mission','pass','pass_refund','gift_in','gift_out','challenge'] loop
    execute format('select %s from (select %L::text as reason) fixture', expr, r) into accepted;
    perform pg_temp.venus_assert(accepted, 'points_ledger admite ' || r);
  end loop;
  perform pg_temp.venus_assert(exists (select 1 from pg_attribute a join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attrelid = 'public.clan_prefs'::regclass and a.attname = 'share_playtime' and a.attnotnull
      and pg_get_expr(d.adbin, d.adrelid) = 'false'), 'permiso de clan apagado por defecto');
  perform pg_temp.venus_assert((select count(*) = 2 from pg_trigger where not tgisinternal and tgenabled = 'O'
    and ((tgrelid = 'public.messages'::regclass and tgname = 'push_on_message')
      or (tgrelid = 'public.friendships'::regclass and tgname = 'push_on_friend_request'))), 'dos triggers push instalados');
end $structure$;

-- Barrera sin red: los triggers siguen activos para comprobar su ruta; su destino solo registra el tipo de aviso.
-- Se reemplaza antes del PRIMER usuario, mensaje, amistad o suscripción ficticio. No se consulta Vault.
CREATE TEMP TABLE venus_push_calls (kind text);
CREATE OR REPLACE FUNCTION private.push_dispatch(p_user uuid, p_kind text, p_key text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $sink$
begin
  insert into pg_temp.venus_push_calls values (p_kind);
end $sink$;

-- realtime.send también se reemplaza, preservando los nombres y defaults de la versión instalada.
DO $realtime$
declare p oid := to_regprocedure('realtime.send(jsonb,text,text,boolean)');
begin
  if p is null or pg_get_function_result(p) <> 'void' then raise exception 'Revisar la firma local de realtime.send'; end if;
  execute format('create or replace function realtime.send(%s) returns void language plpgsql security invoker set search_path = %L as %L',
    pg_get_function_arguments(p), '', 'begin return; end');
end $realtime$;

-- A partir de aquí solo uso legítimo de filas creadas en esta misma transacción.
DO $scenarios$
declare
  a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); staff uuid := gen_random_uuid();
  server_id uuid := gen_random_uuid(); sticker_id uuid := gen_random_uuid(); media_id uuid := gen_random_uuid(); mc uuid := gen_random_uuid();
  tag text := 'T' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 4));
  nonce text := substr(replace(a::text, '-', ''), 1, 8);
  v jsonb; challenge_id uuid; event_id uuid; clan_id uuid; community_id uuid; channel_id uuid;
  clip_id uuid; version_id uuid; v_conversation_id uuid; received_id uuid;
  path text; clip_url text; extension_id text; endpoint text; n integer;
begin
  insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data) values
    (a, 'authenticated', 'authenticated', 'a-' || nonce || '@example.invalid', now(), '{}', '{}'),
    (b, 'authenticated', 'authenticated', 'b-' || nonce || '@example.invalid', now(), '{}', '{}'),
    (staff, 'authenticated', 'authenticated', 'staff-' || nonce || '@example.invalid', now(), '{}', '{}');
  insert into public.profiles (id, username, display_name, friend_code) values
    (a, 'fixture_a_' || nonce, 'Cuenta ficticia A', 'TEST-A-' || nonce),
    (b, 'fixture_b_' || nonce, 'Cuenta ficticia B', 'TEST-B-' || nonce),
    (staff, 'fixture_s_' || nonce, 'Equipo ficticio', 'TEST-S-' || nonce);
  insert into public.app_admin_emails (email) values ('staff-' || nonce || '@example.invalid');
  insert into public.app_admins (user_id, email) values (staff, 'staff-' || nonce || '@example.invalid');
  insert into public.friendships (requester, addressee, status) values (a, b, 'accepted');
  insert into public.featured_servers (id, name, address) values (server_id, 'Servidor ficticio', 'fixture-' || nonce || '.invalid');

  perform pg_temp.venus_login(a);
  v := public.settings_sync_save('{"theme":"dark"}', 0);
  perform pg_temp.venus_assert(v ->> 'version' = '1', '0028 crear copia propia');
  v := public.settings_sync_save('{"theme":"light"}', 0);
  perform pg_temp.venus_assert(v ->> 'conflict' = 'true' and v #>> '{data,theme}' = 'dark', '0028 conflicto normal entre PCs');
  v := public.settings_sync_save('{"theme":"light"}', 1);
  perform pg_temp.venus_assert(v ->> 'version' = '2' and public.settings_sync_get() #>> '{data,theme}' = 'light', '0028 actualizar versión');
  execute 'reset role';
  perform pg_temp.venus_login(b);
  perform pg_temp.venus_assert(public.settings_sync_get() ->> 'version' = '0', '0028 cada cuenta ve su copia');
  execute 'reset role';

  perform pg_temp.venus_login(a);
  v := public.featured_review_save(server_id, 5, 'Reseña ficticia de uso normal');
  perform pg_temp.venus_assert(v ->> 'mine' = 'true' and v ->> 'stars' = '5', '0029 reseña propia');
  perform pg_temp.venus_assert(public.featured_server_vote(server_id) ->> 'ok' = 'true', '0029 primer voto');
  perform pg_temp.venus_assert(public.featured_server_vote(server_id) ->> 'ok' = 'false', '0029 reintento sin doble voto');
  execute 'reset role';
  perform pg_temp.venus_login(null, 'anon');
  perform pg_temp.venus_assert(public.featured_reviews_summary(array[server_id]) #>> array[server_id::text, 'count'] = '1', '0029 lectura pública permitida');
  execute 'reset role';

  path := a::text || '/' || sticker_id::text || '.png';
  insert into storage.objects (bucket_id, name, metadata) values ('stickers', path, '{"mimetype":"image/png","size":128}');
  perform pg_temp.venus_login(a);
  perform pg_temp.venus_assert(public.sticker_create(sticker_id, 'ensayo', 'png') ->> 'userId' = a::text, '0030 registrar metadatos ficticios propios');
  perform pg_temp.venus_assert(jsonb_array_length(public.sticker_mine() -> 'items') = 1, '0030 lista propia');
  perform pg_temp.venus_assert(private.sticker_can_upload(a), '0030 cuota propia con lugar disponible');
  execute 'reset role';
  perform pg_temp.venus_login(b);
  perform pg_temp.venus_assert(jsonb_array_length(public.sticker_resolve(array[sticker_id])) = 1, '0030 resolver sticker compartido');
  execute 'reset role';

  perform pg_temp.venus_login(a);
  perform public.ranking_set_share(true);
  perform pg_temp.venus_assert(public.clan_me() ->> 'sharePlaytime' = 'false', '0033 compartir amigos no activa clan');
  v := public.challenge_create(b, 'diamonds', 24, 3); challenge_id := (v ->> 'id')::uuid;
  execute 'reset role';
  perform pg_temp.venus_login(b);
  perform public.ranking_set_share(true);
  perform pg_temp.venus_assert(public.challenge_respond(challenge_id, true) ->> 'status' = 'active', '0031 aceptar desafío entre amigos');
  perform public.ranking_report(10, 1, 2, 3, 0);
  execute 'reset role';
  perform pg_temp.venus_login(a);
  perform public.ranking_report(10, 3, 2, 3, 0);
  v := public.challenge_settle(challenge_id);
  perform pg_temp.venus_assert(v #>> '{challenge,status}' = 'finished' and v #>> '{challenge,prize}' = '25', '0031 cierre y premio legítimo');
  perform public.challenge_settle(challenge_id);
  execute 'reset role';
  perform pg_temp.venus_assert((select count(*) = 1 and sum(delta) = 25 from public.points_ledger
    where user_id = a and reason = 'challenge' and ref = challenge_id::text), '0031 premio único después de todas las migraciones');

  perform pg_temp.venus_login(staff);
  v := public.admin_event_save(jsonb_build_object('title', 'Evento ficticio', 'kind', 'tournament',
    'startsAt', now() + interval '1 day', 'endsAt', now() + interval '2 days', 'capacity', 2));
  event_id := (v ->> 'id')::uuid;
  execute 'reset role';
  perform pg_temp.venus_login(b);
  perform public.event_join(event_id);
  perform pg_temp.venus_assert(public.event_join(event_id) ->> 'signups' = '1', '0031 inscripción idempotente');
  perform pg_temp.venus_assert(public.event_leave(event_id) ->> 'joined' = 'false', '0031 baja propia');
  execute 'reset role';

  path := a::text || '/' || media_id::text || '.webm';
  clip_url := 'https://venusfixture.supabase.co/storage/v1/object/sign/clips/' || path || '?token=fixture';
  insert into public.shared_media (id, owner, kind, bucket, path, file_name, url, expires_at)
    values (media_id, a, 'clip', 'clips', path, 'ficticio.webm', clip_url, now() + interval '1 day');
  perform pg_temp.venus_login(a);
  v := public.gallery_publish(media_id, 'Clip ficticio'); clip_id := (v ->> 'id')::uuid;
  perform pg_temp.venus_assert(jsonb_array_length(public.gallery_mine()) = 1, '0032 publicación propia');
  execute 'reset role';
  perform pg_temp.venus_login(b);
  perform pg_temp.venus_assert(public.gallery_like(clip_id, true) ->> 'likes' = '1', '0032 like de otro miembro');
  perform pg_temp.venus_assert(jsonb_array_length(public.gallery_list() -> 'items') = 1, '0032 galería visible');
  execute 'reset role';
  perform pg_temp.venus_login(staff);
  perform pg_temp.venus_assert(public.admin_gallery_list('all') #>> '{items,0,url}' = clip_url, '0032 URL validada para moderación');
  execute 'reset role';
  -- Vencimiento normal: ninguna lectura debe seguir ofreciendo un enlace vencido.
  update public.shared_media set expires_at = now() - interval '1 second' where id = media_id;
  perform pg_temp.venus_login(a);
  perform pg_temp.venus_assert(public.gallery_mine() #>> '{0,url}' is null, '0032 enlace vencido sin URL propia');
  execute 'reset role';
  perform pg_temp.venus_login(staff);
  perform pg_temp.venus_assert(public.admin_gallery_list('all') #>> '{items,0,url}' is null, '0032 enlace vencido sin URL de moderación');
  execute 'reset role';

  perform pg_temp.venus_login(a);
  v := public.clan_create('Ensayo ' || nonce, tag); clan_id := (v ->> 'id')::uuid;
  perform public.clan_invite(b);
  execute 'reset role';
  perform pg_temp.venus_login(b);
  perform public.clan_invite_respond(clan_id, true);
  perform pg_temp.venus_assert(public.clan_get(clan_id) #>> '{shared,weekMinutes}' = '0', '0033 horas de amigos no son públicas por defecto');
  perform pg_temp.venus_assert(public.clan_ranking() #>> '{mine,minutes}' = '0', '0033 ranking sin consentimiento');
  execute 'reset role';
  perform pg_temp.venus_login(a);
  perform pg_temp.venus_assert(public.clan_share_playtime(true) ->> 'sharePlaytime' = 'true', '0033 activar permiso propio');
  perform pg_temp.venus_assert(public.clan_get(clan_id) #>> '{shared,weekMinutes}' = '0', '0033 un aportante no publica horas');
  execute 'reset role';
  perform pg_temp.venus_login(b);
  perform pg_temp.venus_assert(public.clan_me() ->> 'sharePlaytime' = 'false', '0033 permiso no cambia el de otra cuenta');
  perform public.clan_share_playtime(true);
  perform pg_temp.venus_assert(public.clan_get(clan_id) #>> '{shared,weekMinutes}' = '20', '0033 dos consentimientos suman horas');
  perform pg_temp.venus_assert(public.clan_ranking() #>> '{mine,minutes}' = '20', '0033 ranking respeta ambos permisos');
  execute 'reset role';
  perform pg_temp.venus_login(a);
  perform public.clan_share_playtime(false);
  perform pg_temp.venus_assert(public.clan_get(clan_id) #>> '{shared,weekMinutes}' = '0', '0033 retirar permiso retira aporte');
  perform pg_temp.venus_assert(public.ranking_friends('hours') ->> 'share' = 'true', '0033 retirar permiso no cambia amigos');
  perform pg_temp.venus_assert(public.clan_share_playtime(null) ->> 'sharePlaytime' = 'false', '0033 null mantiene apagado');
  perform public.clan_share_playtime(true);
  perform public.ranking_set_share(false);
  perform pg_temp.venus_assert(public.clan_ranking() #>> '{mine,minutes}' = '0', '0033 no ampliar el permiso de amigos');
  perform public.ranking_set_share(true);
  perform public.clan_transfer(b);
  execute 'reset role';
  perform pg_temp.venus_login(b);
  perform pg_temp.venus_assert(public.clan_get(clan_id) ->> 'myRole' = 'leader', '0033 transferencia legítima de liderazgo');
  execute 'reset role';

  perform pg_temp.venus_login(a);
  v := public.community_create('Comunidad ' || nonce); community_id := (v ->> 'id')::uuid;
  v := public.community_get(community_id);
  select (j ->> 'id')::uuid into channel_id from jsonb_array_elements(v -> 'channels') j where j ->> 'kind' = 'text';
  execute 'reset role';
  perform pg_temp.venus_login(b);
  perform public.community_join(community_id);
  perform public.community_send(channel_id, 'Mensaje ficticio de comunidad');
  execute 'reset role';
  perform pg_temp.venus_login(a);
  select count(*) into n from public.community_messages msg where msg.community_id = (v ->> 'id')::uuid;
  perform pg_temp.venus_assert(n = 1, '0033 lectura RLS de miembro');
  perform public.community_transfer(community_id, b);
  execute 'reset role';
  perform pg_temp.venus_login(b);
  perform pg_temp.venus_assert(public.community_get(community_id) ->> 'myRole' = 'owner', '0033 transferencia legítima de comunidad');
  execute 'reset role';

  insert into public.user_items (user_id, item_id) values (a, 'cape_dawn');
  insert into public.mc_verified (mc_uuid, user_id) values (mc, a);
  perform pg_temp.venus_login(a);
  perform public.cape_equip('cape_dawn');
  perform pg_temp.venus_assert(public.cape_mine() ->> 'active' = 'true', '0034 equipar capa adquirida ficticia');
  execute 'reset role';
  perform pg_temp.venus_login(null, 'anon');
  perform pg_temp.venus_assert((select cape = 'dawn' from public.badge_capes(array[mc])), '0034 consulta pública de UUID ficticio');
  execute 'reset role';

  endpoint := 'https://fcm.googleapis.com/fixture/' || nonce;
  perform pg_temp.venus_login(a);
  perform pg_temp.venus_assert(public.push_subscribe(endpoint, 'Celular ficticio') ->> 'count' = '1', '0035 suscripción ficticia propia');
  execute 'reset role';
  perform pg_temp.venus_login(staff);
  perform public.social_send_friend_request('fixture_a_' || nonce);
  execute 'reset role';
  perform pg_temp.venus_login(b);
  v_conversation_id := public.social_get_or_create_conversation(a);
  -- now() es constante durante el ensayo: simular una lectura anterior al mensaje nuevo.
  execute 'reset role';
  update public.conversation_members cm set last_read_at = now() - interval '1 second'
    where cm.conversation_id = v_conversation_id and cm.user_id = a;
  perform pg_temp.venus_login(b);
  insert into public.messages (conversation_id, sender_id, body) values (v_conversation_id, b, 'Mensaje ficticio recibido');
  clip_url := 'https://venusfixture.supabase.co/storage/v1/object/sign/clips/' || b::text || '/' || gen_random_uuid()::text || '.webm?token=fixture';
  perform public.social_send_signal(a, 'media-share', jsonb_build_object('name', 'Clip ficticio recibido', 'url', clip_url));
  execute 'reset role';
  select id into received_id from public.media_received where recipient = a;
  perform pg_temp.venus_assert((select count(distinct kind) = 3 from pg_temp.venus_push_calls where kind in ('request','message','clip')), '0035 tres rutas capturadas sin red');
  perform pg_temp.venus_login(a);
  perform pg_temp.venus_assert(jsonb_array_length(public.app_inbox(false) -> 'messages') = 1 and public.app_inbox(false) #>> '{messages,0,text}' is null, '0035 bandeja sin vista previa');
  perform pg_temp.venus_assert(public.app_inbox(true) #>> '{messages,0,text}' = 'Mensaje ficticio recibido', '0035 vista previa explícita');
  perform pg_temp.venus_assert(jsonb_array_length(public.media_received_list()) = 1, '0035 recibido por su dueño');
  perform pg_temp.venus_assert(public.media_received_seen(array[received_id]) = 1, '0035 visto propio');
  perform public.social_block_user(b);
  perform pg_temp.venus_assert(jsonb_array_length(public.app_inbox(true) -> 'messages') = 0, '0035 bloqueo oculta conversación en bandeja');
  perform pg_temp.venus_assert(jsonb_array_length(public.media_received_list()) = 0, '0035 bloqueo oculta recibidos');
  execute 'reset role';
  perform pg_temp.venus_login(null, 'service_role');
  perform pg_temp.venus_assert(public.push_claim(a, 'message', v_conversation_id::text) ->> 'allowed' = 'true', '0035 claim legítimo de backend');
  perform pg_temp.venus_assert(public.push_claim(a, 'message', v_conversation_id::text) ->> 'reason' = 'throttled', '0035 claim repetido limitado');
  execute 'reset role';
  perform pg_temp.venus_login(a);
  perform pg_temp.venus_assert(public.push_unsubscribe(endpoint), '0035 baja del celular propio');
  execute 'reset role';

  extension_id := 'fixture-' || nonce;
  perform pg_temp.venus_login(a);
  v := public.extension_submit(extension_id, '1.0.0', jsonb_build_object('manifestVersion', 1, 'id', extension_id,
    'name', 'Ensayo local', 'version', '1.0.0', 'author', 'Cuenta ficticia', 'minLauncherVersion', '3.1.0',
    'permissions', '[]'::jsonb, 'entry', 'index.html'), repeat('a', 64), 128);
  version_id := (v ->> 'id')::uuid; path := v ->> 'path';
  perform pg_temp.venus_assert(jsonb_array_length(public.extension_my_submissions()) = 1, '0036 envío propio pendiente');
  execute 'reset role';
  insert into storage.objects (bucket_id, name, metadata) values ('extension-packages', path, '{"mimetype":"application/zip","size":128}');
  perform pg_temp.venus_login(staff);
  perform public.admin_extension_review(version_id, 'approve');
  execute 'reset role';
  perform pg_temp.venus_login(a);
  perform pg_temp.venus_assert(jsonb_array_length(public.extension_catalog(null, array[extension_id])) = 1, '0036 catálogo aprobado');
  execute 'reset role';
  perform pg_temp.venus_login(staff);
  perform public.admin_extension_block(extension_id, true, 'Bloqueo ficticio de ensayo');
  execute 'reset role';
  perform pg_temp.venus_login(null, 'anon');
  perform pg_temp.venus_assert((public.extension_blocklist() -> 'ids') ? extension_id, '0036 lista pública de bloqueadas');
  execute 'reset role';
  perform pg_temp.venus_login(a);
  perform pg_temp.venus_assert(jsonb_array_length(public.extension_catalog(null, array[extension_id])) = 0, '0036 catálogo refleja moderación');
  perform pg_temp.venus_assert(public.settings_sync_delete(), '0028 borrar copia propia');
  perform pg_temp.venus_assert(public.sticker_delete(sticker_id) ->> 'ok' = 'true', '0030 borrar sticker propio');
  perform public.cape_equip(null);
  execute 'reset role';
end $scenarios$;

-- Solo etiquetas y cantidades: nunca contenido de usuarios, endpoints ni secretos.
SELECT count(*) AS comprobaciones_ok FROM pg_temp.venus_checks;
SELECT label FROM pg_temp.venus_checks WHERE label ~ '^00' ORDER BY label;
ROLLBACK;

DO $after$
begin
  if exists (select 1 from auth.users) or to_regclass('public.settings_sync') is not null
     or to_regclass('public.clan_prefs') is not null or to_regclass('public.community_extensions') is not null then
    raise exception 'El estado final no coincide con la base vacía anterior al ensayo';
  end if;
end $after$;
\echo 'OK: migraciones y escenarios revertidos. Push, Realtime y Storage reales NO probados.'
