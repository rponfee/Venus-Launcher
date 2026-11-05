-- Solo PostgreSQL local descartable: 0001..0037 completas, 0038 y 0044 dentro de BEGIN/ROLLBACK.
-- Planes de clan: compra, renovación, mejora, devolución, vencimiento, límites, galería, fondos y escenarios.
-- Datos propios ficticios; sin cuentas reales, HTTP ni pagos reales (el proveedor se simula con private.payments_secret).
\set ON_ERROR_STOP on
\set ON_ERROR_ROLLBACK off
\if :{?venus_disposable}
\else
  \quit 3
\endif
\if :venus_disposable
\else
  \quit 3
\endif
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '90s';
SET LOCAL timezone = 'UTC';
SET LOCAL search_path = public, pg_catalog;
DO $guard$
begin
  if current_database() <> 'venus_sql_test' or inet_server_addr() is null or not inet_server_addr() <<= '127.0.0.0/8'::inet
    or not (select rolsuper from pg_roles where rolname = session_user) then
    raise exception 'Solo postgres de base descartable local, sin túneles';
  end if;
  if exists (select 1 from auth.users) or to_regclass('public.community_categories') is not null then
    raise exception 'Se requiere fixture vacío hasta 0037, sin 0038';
  end if;
end $guard$;
ALTER TABLE auth.users DISABLE TRIGGER USER;
CREATE TEMP TABLE com_checks(label text primary key);
DO $access$
begin
  execute format('grant usage on schema %I to anon,authenticated,service_role', (select nspname from pg_namespace where oid=pg_my_temp_schema()));
end $access$;
GRANT INSERT ON com_checks TO anon,authenticated,service_role;
CREATE FUNCTION pg_temp.com_assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $f$
begin
  if ok is distinct from true then raise exception 'FAIL: %',label; end if;
  insert into pg_temp.com_checks values(label);
end $f$;
CREATE FUNCTION pg_temp.com_login(who uuid,db_role text default 'authenticated') RETURNS void LANGUAGE plpgsql AS $f$
begin
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claim.role','',true);
  perform set_config('request.jwt.claims',json_build_object('sub',who,'role',db_role)::text,true);
  execute format('set local role %I',db_role);
end $f$;
CREATE FUNCTION pg_temp.com_expect(command text,expected text,message text,label text) RETURNS void LANGUAGE plpgsql AS $f$
declare caught boolean := false;
begin
  begin execute command;
  exception when others then
    if sqlstate <> expected or (message is not null and sqlerrm <> message) then raise; end if;
    caught := true;
  end;
  perform pg_temp.com_assert(caught,label);
end $f$;

\ir ../migrations/0038_comunidades.sql

CREATE OR REPLACE FUNCTION private.push_dispatch(p_user uuid,p_kind text,p_key text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $f$ begin return; end $f$;
DO $rt$
declare p oid := to_regprocedure('realtime.send(jsonb,text,text,boolean)');
begin
  execute format('create or replace function realtime.send(%s) returns void language plpgsql security invoker set search_path=%L as %L',
    pg_get_function_arguments(p),'','begin return; end');
end $rt$;

-- Antes de 0044: dos funciones con el Venus Pass todavía existen y no hay órdenes de pase.
DO $before$
begin
  perform pg_temp.com_assert(to_regprocedure('private.pass_quote(text,text,uuid)') is not null and to_regprocedure('private.pass_tier_rank(text)') is not null,
    'antes de 0044 el Pass todavía se vende');
end $before$;
CREATE TEMP TABLE pass_tables AS SELECT count(*) AS tiers FROM public.pass_tiers;

\ir ../migrations/0044_clanes_planes.sql
-- Idempotente: aplicarla dos veces no rompe ni duplica nada.
\ir ../migrations/0044_clanes_planes.sql

-- El proveedor "configurado" sin Vault real: secretos de utilería y cotización.
CREATE OR REPLACE FUNCTION private.payments_secret(p_key text) RETURNS text LANGUAGE sql AS $f$ select 'secreto-de-prueba'::text $f$;
UPDATE public.payment_settings SET mercado_pago_enabled = true, paypal_enabled = true, ars_per_usd = 1500, ars_rounding = 100;

CREATE FUNCTION pg_temp.com_user(nm text) RETURNS uuid LANGUAGE plpgsql AS $f$
declare u uuid := gen_random_uuid();
begin
  insert into auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data)
    values(u,'authenticated','authenticated','pl-'||u::text||'@example.invalid',now(),'{}','{}');
  insert into public.profiles(id,username,display_name,friend_code)
    values(u,'pl_'||substr(replace(u::text,'-',''),1,16),nm,'TEST-'||substr(replace(u::text,'-',''),1,12));
  return u;
end $f$;
-- Un archivo ya subido a Storage (la política de inserción se prueba en la suite de comunidades) y su registro.
CREATE FUNCTION pg_temp.com_file(cid uuid,mid uuid,who uuid,ext text,bytes bigint,mime text) RETURNS void LANGUAGE plpgsql AS $f$
begin
  insert into storage.objects(bucket_id,name,owner,metadata) values('community-media',cid::text||'/'||mid::text||'.'||ext,who,jsonb_build_object('size',bytes,'mimetype',mime));
end $f$;
-- Corre el tiempo para atrás: lo que era "hace 40 días" pasa a ser "ahora".
CREATE FUNCTION pg_temp.com_age(cid uuid,d interval) RETURNS void LANGUAGE sql AS $f$
  update public.community_plan_periods set starts_at = starts_at - d, ends_at = ends_at - d where community_id = cid
$f$;
CREATE FUNCTION pg_temp.com_pay(uid uuid,plan text,cid uuid,provider text default 'paypal',live boolean default true) RETURNS jsonb LANGUAGE plpgsql AS $f$
declare o jsonb; r jsonb;
begin
  o := public.payments_create_order(uid, plan, provider, live, cid);
  r := public.payments_mark_paid((o->>'id')::uuid, 'pay-'||gen_random_uuid()::text, (o->>'amount')::numeric, o->>'currency', live, 'approved');
  return jsonb_build_object('order', o, 'result', r);
end $f$;
CREATE FUNCTION pg_temp.com_plan(cid uuid) RETURNS text LANGUAGE sql AS $f$ select (private.community_plan(cid)).id $f$;

DO $acl$
declare f text;
begin
  perform pg_temp.com_assert(to_regprocedure('private.pass_quote(text,text,uuid)') is null and to_regprocedure('private.pass_fulfill(public.payment_orders)') is null
    and to_regprocedure('private.pass_revoke(public.payment_orders)') is null and to_regprocedure('private.pass_tier_rank(text)') is null
    and to_regprocedure('private.pass_purchase(uuid,text)') is null,'fuera las funciones de compra del Pass');
  perform pg_temp.com_assert(to_regclass('public.pass_tiers') is not null and to_regclass('public.pass_purchases') is not null
    and (select count(*) from public.pass_tiers) = (select tiers from pg_temp.pass_tables),'pass_tiers y pass_purchases intactas');
  perform pg_temp.com_assert(to_regprocedure('public.payments_create_order(uuid,text,text,boolean)') is null,'sin la firma vieja de payments_create_order');
  perform pg_temp.com_assert((public.payments_catalog()) ? 'pass' is false and (public.payments_catalog()) ? 'clans','el catálogo ya no trae pass y trae clans');
  perform pg_temp.com_assert(jsonb_array_length(public.payments_catalog()->'clans') = 4
    and (select array_agg(x->>'id' order by (x->>'priceUsd')::numeric) from jsonb_array_elements(public.payments_catalog()->'clans') x) = array['clan_go','clan_pro','clan_max','clan_ultra'],
    'cuatro planes de clan en el catálogo, de menor a mayor');
  perform pg_temp.com_assert((select array_agg((x->>'priceUsd')::numeric order by (x->>'priceUsd')::numeric) from jsonb_array_elements(public.payments_catalog()->'clans') x) = array[2,4,6,10]::numeric[],'precios US$ 2, 4, 6 y 10');
  perform pg_temp.com_assert((public.payments_catalog()->'clans'->0->'prices'->'mercado_pago'->>'total')::numeric = 3000
    and (public.payments_catalog()->'clans'->0->'prices'->'paypal'->>'total')::numeric = 2,'precio en pesos (2 x 1500) y en dólares');
  for f in select unnest(array['public.payments_create_order(uuid,text,text,boolean,uuid)','public.payments_mark_paid(uuid,text,numeric,text,boolean,text)',
      'public.payments_mark_status(uuid,text,text)']) loop
    perform pg_temp.com_assert(not has_function_privilege('anon',f,'EXECUTE') and not has_function_privilege('authenticated',f,'EXECUTE')
      and has_function_privilege('service_role',f,'EXECUTE'),'pagos solo para service_role '||f);
  end loop;
  for f in select unnest(array['public.community_plan_get(uuid)','public.community_backdrops_get(uuid)','public.community_backdrop_set(uuid,text,uuid,text,text,integer,integer)',
      'public.community_backdrop_clear(uuid,text,uuid)','public.community_stage_get(uuid)','public.community_media_add_klipy(uuid,text,text,text,text)',
      'public.community_media_register(uuid,uuid,text,integer,integer,boolean)','public.admin_community_plans()','public.admin_community_plan_save(text,jsonb)',
      'public.admin_community_plan_state(uuid)','public.admin_community_plan_grant(uuid,text,integer)','public.admin_community_plan_revoke(uuid)']) loop
    perform pg_temp.com_assert(has_function_privilege('authenticated',f,'EXECUTE') and not has_function_privilege('anon',f,'EXECUTE'),'ACL '||f);
  end loop;
  perform pg_temp.com_assert(not has_function_privilege('anon','private.community_plan_grant(uuid,text,text,uuid,uuid,integer)','EXECUTE')
    and not has_function_privilege('authenticated','private.community_plan_grant(uuid,text,text,uuid,uuid,integer)','EXECUTE'),'community_plan_grant solo interna');
  foreach f in array array['community_plans','community_plan_periods','community_presets','community_backdrops'] loop
    perform pg_temp.com_assert((select relrowsecurity from pg_class where oid=('public.'||f)::regclass)
      and not has_table_privilege('authenticated','public.'||f,'SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('anon','public.'||f,'SELECT,INSERT,UPDATE,DELETE'),'RLS y sin acceso directo '||f);
  end loop;
  perform pg_temp.com_assert((select count(*) = 5 from public.community_plans) and (select count(*) = 12 from public.community_presets)
    and (select count(*) between 8 and 12 from public.community_presets),'cinco planes y doce fondos incluidos');
  perform pg_temp.com_assert(exists(select 1 from storage.buckets where id='community-media' and file_size_limit=4194304
    and allowed_mime_types=array['image/gif','image/webp','image/png','image/jpeg']),'bucket con JPEG y 4 MB');
  perform pg_temp.com_assert((select (max_media,max_backdrops,max_stages,allow_animated) = (10,0,0,false) from public.community_plans where id='free')
    and (select (max_media,max_backdrops,max_stages,allow_animated) = (50,2,1,false) from public.community_plans where id='go')
    and (select (max_media,max_backdrops,max_stages,allow_animated) = (150,6,4,true) from public.community_plans where id='pro')
    and (select (max_media,max_backdrops,max_stages,allow_animated) = (400,15,10,true) from public.community_plans where id='max')
    and (select (max_media,max_backdrops,max_stages,allow_animated,priority_review,max_members,max_channels,max_roles) = (1000,40,25,true,true,5000,150,50) from public.community_plans where id='ultra'),
    'tabla de planes como se pidió');
end $acl$;

DO $scenarios$
declare
  own uuid; own2 uuid; modu uuid; mem uuid; mem2 uuid; out_u uuid; adm uuid;
  ca uuid; ca2 uuid; cb uuid; cc uuid; ch_text uuid; ch_voice uuid; cb_text uuid; cb_text2 uuid; cb_voice uuid; cb_voice2 uuid;
  v jsonb; w jsonb; o jsonb; n integer; i integer; m uuid; room uuid; ends1 timestamptz; pay1 jsonb; pay2 jsonb; pay3 jsonb; pay4 jsonb;
  ids uuid[] := '{}'; kid uuid; pid uuid;
  nonce text := substr(replace(gen_random_uuid()::text,'-',''),1,8);
  klipy text := 'https://static.klipy.com/ii/abc123/def456.gif';
begin
  own := pg_temp.com_user('Dueña A'); own2 := pg_temp.com_user('Dueño B'); modu := pg_temp.com_user('Moderador'); mem := pg_temp.com_user('Miembro');
  mem2 := pg_temp.com_user('Miembro dos'); out_u := pg_temp.com_user('Ajena'); adm := pg_temp.com_user('Admin Venus');
  insert into public.app_admin_emails(email) select lower(email) from auth.users where id=adm;
  insert into public.app_admins(user_id,email) select id,lower(email) from auth.users where id=adm;

  perform pg_temp.com_login(own);
  ca := (public.community_create('Plan A '||nonce)->>'id')::uuid;
  ca2 := (public.community_create('Plan A dos '||nonce)->>'id')::uuid;
  perform pg_temp.com_login(own2); cb := (public.community_create('Plan B '||nonce)->>'id')::uuid; cc := (public.community_create('Plan C '||nonce)->>'id')::uuid;
  perform pg_temp.com_login(mem); perform public.community_join(ca); perform public.community_join(cb);
  perform pg_temp.com_login(modu); perform public.community_join(ca);
  perform pg_temp.com_login(own); perform public.community_set_role(ca, modu, 'moderator');
  execute 'reset role';

  -- ---- Gratis ----
  perform pg_temp.com_assert(pg_temp.com_plan(ca) = 'free', 'una comunidad nueva es gratis');
  perform pg_temp.com_login(mem);
  v := public.community_plan_get(ca);
  perform pg_temp.com_assert(v#>>'{plan,id}' = 'free' and (v#>>'{plan,limits,media}')::int = 10 and (v#>>'{usage,members}')::int = 3 and (v->>'isOwner')::boolean is false
    and v#>>'{plan,endsAt}' is null and jsonb_array_length(v->'plans') = 5, 'un miembro ve el plan gratis, sus límites y el uso');
  perform pg_temp.com_login(out_u);
  perform pg_temp.com_expect(format('select public.community_plan_get(%L)', ca), '42501', 'not_member', 'quien no es miembro no ve el plan');
  execute 'reset role';

  -- ---- Quién puede comprar ----
  perform pg_temp.com_expect(format('select public.payments_create_order(%L,%L,%L,true,%L)', mem, 'clan_go', 'paypal', ca), '42501', 'not_owner', 'un miembro no compra');
  perform pg_temp.com_expect(format('select public.payments_create_order(%L,%L,%L,true,%L)', modu, 'clan_go', 'paypal', ca), '42501', 'not_owner', 'un moderador no compra');
  perform pg_temp.com_expect(format('select public.payments_create_order(%L,%L,%L,true,%L)', own2, 'clan_go', 'paypal', ca), '42501', 'not_owner', 'el dueño de otra comunidad no compra');
  perform pg_temp.com_expect(format('select public.payments_create_order(%L,%L,%L,true,null)', own, 'clan_go', 'paypal'), '22023', 'unknown_community', 'sin comunidad no hay plan de clan');
  perform pg_temp.com_expect(format('select public.payments_create_order(%L,%L,%L,true,%L)', own, 'clan_go', 'paypal', gen_random_uuid()), '22023', 'unknown_community', 'comunidad inexistente');
  perform pg_temp.com_expect(format('select public.payments_create_order(%L,%L,%L,true,%L)', own, 'pass_go', 'paypal', ca), '22023', 'unknown_plan', 'el Pass ya no se compra');
  perform pg_temp.com_expect(format('select public.payments_create_order(%L,%L,%L,true,%L)', own, 'clan_free', 'paypal', ca), '22023', 'unknown_plan', 'no hay plan clan_free');
  perform pg_temp.com_expect(format('select public.payments_create_order(%L,%L,%L,true,%L)', own, 'clan_go', 'stripe', ca), '22023', 'provider_disabled', 'medio de pago inválido');
  perform pg_temp.com_expect(format('select public.payments_create_order(%L,%L,%L,true,%L)', own, 'go', 'paypal', ca), '22023', null, 'x') where false;

  -- ---- Compra ----
  o := public.payments_create_order(own, 'clan_go', 'mercado_pago', true, ca);
  perform pg_temp.com_assert(o->>'product' = 'clan_plan' and o->>'communityId' = ca::text and o->>'planName' = 'Clanes Go' and (o->>'amount')::numeric = 3000 and o->>'currency' = 'ARS'
    and o->'quote'->>'periodDays' = '30', 'la orden de un plan de clan lleva la comunidad y el monto en pesos');
  w := public.payments_mark_paid((o->>'id')::uuid, 'pay-test-1', 3000, 'ARS', false, 'approved');
  perform pg_temp.com_assert(w->>'reason' = 'test_payment' and pg_temp.com_plan(ca) = 'free', 'un pago de prueba no activa el plan');
  o := public.payments_create_order(own, 'clan_go', 'paypal', true, ca);
  w := public.payments_mark_paid((o->>'id')::uuid, 'pay-test-2', 1, 'USD', true, 'approved');
  perform pg_temp.com_assert(w->>'reason' = 'amount_mismatch' and pg_temp.com_plan(ca) = 'free', 'con otro monto no se activa');
  w := public.payments_mark_paid((o->>'id')::uuid, 'pay-test-3', 2, 'ARS', true, 'approved');
  perform pg_temp.com_assert(w->>'reason' = 'amount_mismatch', 'con otra moneda tampoco');
  w := public.payments_mark_paid((o->>'id')::uuid, 'pay-test-4', 2, 'USD', true, 'approved');
  perform pg_temp.com_assert((w->>'applied')::boolean and pg_temp.com_plan(ca) = 'go', 'el pago acreditado activa Clanes Go');
  v := private.community_plan_json(ca);
  ends1 := (v->>'endsAt')::timestamptz;
  perform pg_temp.com_assert(ends1 between now() + interval '29 days 23 hours' and now() + interval '30 days 1 hour', 'dura 30 días');
  perform pg_temp.com_assert(pg_temp.com_plan(ca2) = 'free' and pg_temp.com_plan(cb) = 'free', 'el pago de una persona no activa otra comunidad, ni siquiera suya');
  w := public.payments_mark_paid((o->>'id')::uuid, 'pay-test-4', 2, 'USD', true, 'approved');
  perform pg_temp.com_assert(w->>'reason' = 'already_paid' and (select count(*) from public.community_plan_periods where community_id = ca) = 1, 'un aviso repetido no da dos períodos');

  -- ---- Renovación a mano: no se pierde lo que queda ----
  pay2 := pg_temp.com_pay(own, 'clan_go', ca);
  perform pg_temp.com_assert((select count(*) from public.community_plan_periods where community_id = ca) = 2
    and (select starts_at from public.community_plan_periods where order_id = (pay2->'order'->>'id')::uuid) = ends1
    and (private.community_plan_json(ca)->>'endsAt')::timestamptz = ends1 + interval '30 days', 'renovar empieza cuando termina el que queda: son 60 días');

  -- ---- Un plan mayor empieza ya y pausa al menor; uno menor espera ----
  pay3 := pg_temp.com_pay(own, 'clan_pro', ca, 'mercado_pago');
  perform pg_temp.com_assert(pg_temp.com_plan(ca) = 'pro' and (private.community_plan_json(ca)->>'endsAt')::timestamptz between now() + interval '29 days 23 hours' and now() + interval '30 days 1 hour',
    'Pro empieza ya y gana');
  perform pg_temp.com_assert((select max(ends_at) from public.community_plan_periods where community_id = ca and plan_id = 'go') = ends1 + interval '60 days'
    and (select min(starts_at) from public.community_plan_periods where community_id = ca and plan_id = 'go' and starts_at > now()) = ends1 + interval '30 days',
    'el tiempo de Go se pausa mientras corre Pro (los 60 días de Go no se pierden)');
  pay4 := pg_temp.com_pay(own, 'clan_go', ca);
  perform pg_temp.com_assert((select starts_at from public.community_plan_periods where order_id = (pay4->'order'->>'id')::uuid) = ends1 + interval '60 days',
    'un plan menor espera a que terminen los mayores y los iguales');
  -- Devolución: quita ese período y Go vuelve.
  w := public.payments_mark_status((pay3->'order'->>'id')::uuid, 'refunded', 'refunded');
  perform pg_temp.com_assert((w->>'applied')::boolean and pg_temp.com_plan(ca) = 'go' and (select revoked_at is not null from public.community_plan_periods where order_id = (pay3->'order'->>'id')::uuid),
    'una devolución quita el plan Pro y vuelve Go');
  w := public.payments_mark_status((pay3->'order'->>'id')::uuid, 'refunded', 'refunded');
  perform pg_temp.com_assert(w->>'reason' = 'not_paid', 'devolver dos veces no hace nada');
  w := public.payments_mark_paid((pay3->'order'->>'id')::uuid, 'pay-otra-vez', 4, 'USD', true, 'approved');
  perform pg_temp.com_assert(w->>'reason' = 'refunded' and pg_temp.com_plan(ca) = 'go', 'una orden devuelta no se vuelve a acreditar');
  -- Vencimiento: pasan 400 días y no queda nada.
  perform pg_temp.com_age(ca, interval '400 days');
  perform pg_temp.com_assert(pg_temp.com_plan(ca) = 'free', 'al vencer vuelve a gratis');
  perform pg_temp.com_login(own);
  v := public.community_plan_get(ca);
  perform pg_temp.com_assert(v#>>'{plan,id}' = 'free' and v#>>'{plan,endsAt}' is null and (v->>'isOwner')::boolean, 'community_plan_get del dueño tras vencer');
  execute 'reset role';

  -- ---- Lo que pasa del límite gratis se oculta (los más nuevos primero) y vuelve al renovar ----
  perform pg_temp.com_pay(own2, 'clan_go', cb);
  for i in 1..12 loop
    m := gen_random_uuid(); ids := ids || m;
    insert into public.community_media(id, community_id, uploaded_by, name, path, mime, bytes, width, height, status, created_at)
      values(m, cb, own2, 'Imagen '||i, cb::text||'/'||m::text||'.png', 'image/png', 1000, 100, 100, 'approved', now() - make_interval(mins => 30 - i));
  end loop;
  perform pg_temp.com_login(mem);
  perform pg_temp.com_assert(jsonb_array_length(public.community_media_list(cb)) = 12, 'con Go se ven las 12 imágenes');
  execute 'reset role';
  perform pg_temp.com_age(cb, interval '40 days');
  perform pg_temp.com_assert(pg_temp.com_plan(cb) = 'free', 'Go de B venció');
  perform pg_temp.com_login(mem);
  v := public.community_media_list(cb);
  perform pg_temp.com_assert(jsonb_array_length(v) = 10 and not exists (select 1 from jsonb_array_elements(v) e where (e->>'id')::uuid in (ids[11], ids[12])),
    'sin plan un miembro ve 10 y faltan las dos más nuevas');
  perform pg_temp.com_assert(jsonb_array_length(public.community_media_resolve(array[ids[1], ids[12]])) = 1, 'resolve no entrega lo oculto');
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', mem, 'role', 'authenticated')::text, true);
  perform pg_temp.com_assert(private.community_media_can_read(cb::text||'/'||ids[1]::text||'.png', mem) and not private.community_media_can_read(cb::text||'/'||ids[12]::text||'.png', mem),
    'Storage tampoco entrega lo oculto a un miembro');
  perform pg_temp.com_login(own2);
  v := public.community_media_list(cb);
  perform pg_temp.com_assert(jsonb_array_length(v) = 12 and (select count(*) from jsonb_array_elements(v) e where (e->>'hidden')::boolean) = 2 and public.community_plan_get(cb)->>'hiddenMedia' = '2',
    'el dueño ve las 12 y cuáles están ocultas');
  execute 'reset role';
  perform pg_temp.com_pay(own2, 'clan_go', cb);
  perform pg_temp.com_login(mem);
  perform pg_temp.com_assert(jsonb_array_length(public.community_media_list(cb)) = 12, 'al renovar vuelven las 12');
  execute 'reset role';

  -- ---- Registro de archivos: límites por plan, JPEG, fotos grandes, animación ----
  m := gen_random_uuid(); perform pg_temp.com_file(cb, m, own2, 'jpg', 3000000, 'image/jpeg'); perform pg_temp.com_login(own2);
  v := public.community_media_register(m, cb, 'Foto', 2000, 1200);
  perform pg_temp.com_assert(v->>'mime' = 'image/jpeg' and v->>'status' = 'pending' and (v->>'animated')::boolean is false, 'una foto JPEG de 3 MB y 2000 px entra');
  execute 'reset role';
  m := gen_random_uuid(); perform pg_temp.com_file(cb, m, own2, 'gif', 3000000, 'image/gif'); perform pg_temp.com_login(own2);
  perform pg_temp.com_expect(format('select public.community_media_register(%L,%L,%L,200,200)', m, cb, 'Gif grande'), '22023', 'too_big', 'un GIF de 3 MB sobra');
  execute 'reset role';
  m := gen_random_uuid(); perform pg_temp.com_file(cb, m, own2, 'gif', 1000, 'image/gif'); perform pg_temp.com_login(own2);
  perform pg_temp.com_expect(format('select public.community_media_register(%L,%L,%L,2000,200)', m, cb, 'Gif ancho'), '22023', 'bad_dimensions', 'un GIF pasa de 1024 px');
  v := public.community_media_register(m, cb, 'Gif chico', 200, 200);
  perform pg_temp.com_assert((v->>'animated')::boolean, 'un GIF es animado');
  execute 'reset role';
  m := gen_random_uuid(); perform pg_temp.com_file(cb, m, own2, 'png', 5000000, 'image/png'); perform pg_temp.com_login(own2);
  perform pg_temp.com_expect(format('select public.community_media_register(%L,%L,%L,200,200)', m, cb, 'Png grande'), '22023', 'too_big', 'una foto pasa de 4 MB');
  execute 'reset role';
  m := gen_random_uuid(); perform pg_temp.com_file(cb, m, own2, 'png', 5000, 'image/png'); perform pg_temp.com_login(own2);
  perform pg_temp.com_expect(format('select public.community_media_register(%L,%L,%L,3000,200)', m, cb, 'Png ancho'), '22023', 'bad_dimensions', 'una foto pasa de 2560 px');
  execute 'reset role';
  m := gen_random_uuid(); perform pg_temp.com_file(cb, m, own2, 'webp', 5000, 'image/webp'); perform pg_temp.com_login(own2);
  v := public.community_media_register(m, cb, 'Webp animado', 300, 300, true);
  perform pg_temp.com_assert((v->>'animated')::boolean, 'un WebP animado se registra como animado');
  execute 'reset role';
  -- Límite del plan, editado desde Administración (la tabla es editable).
  perform pg_temp.com_login(mem);
  perform pg_temp.com_expect($q$select public.admin_community_plan_save('free','{"media":12}')$q$, '42501', 'admin_only', 'un miembro no edita planes');
  perform pg_temp.com_login(adm);
  perform pg_temp.com_expect($q$select public.admin_community_plan_save('free','{"inventado":1}')$q$, '22023', 'bad_request', 'campo inventado');
  perform pg_temp.com_expect($q$select public.admin_community_plan_save('free','{"priceUsd":5}')$q$, '22023', 'bad_request', 'el plan gratis no se cobra');
  perform pg_temp.com_expect($q$select public.admin_community_plan_save('go','{"priceUsd":-1}')$q$, '22023', 'bad_value', 'precio negativo');
  perform pg_temp.com_expect($q$select public.admin_community_plan_save('zzz','{"media":1}')$q$, '22023', 'not_found', 'plan inexistente');
  perform public.admin_community_plan_save('free', '{"media":12,"pending":1,"channels":3,"roles":1,"members":2}');
  execute 'reset role';
  perform pg_temp.com_assert((select (max_media, max_pending, max_channels, max_roles, max_members) = (12,1,3,1,2) from public.community_plans where id = 'free'), 'el administrador edita los límites');
  -- ca2 (gratis, 12 de cupo): llega al tope con registros aprobados a mano.
  for i in 1..12 loop
    m := gen_random_uuid();
    perform pg_temp.com_file(ca2, m, own, 'png', 1000, 'image/png');
    perform pg_temp.com_login(own);
    perform public.community_media_register(m, ca2, 'Foto '||i, 100, 100);
    execute 'reset role';
    update public.community_media set status = 'approved' where id = m;
  end loop;
  m := gen_random_uuid(); perform pg_temp.com_file(ca2, m, own, 'png', 1000, 'image/png'); perform pg_temp.com_login(own);
  perform pg_temp.com_expect(format('select public.community_media_register(%L,%L,%L,100,100)', m, ca2, 'De más'), '22023', 'media_limit', 'el plan gratis tiene tope de galería');
  execute 'reset role';
  perform pg_temp.com_login(adm); perform public.admin_community_plan_save('free', '{"media":14}'); execute 'reset role';
  perform pg_temp.com_login(own);
  perform public.community_media_register(m, ca2, 'Pendiente', 100, 100);
  execute 'reset role';
  m := gen_random_uuid(); perform pg_temp.com_file(ca2, m, own, 'png', 1000, 'image/png'); perform pg_temp.com_login(own);
  perform pg_temp.com_expect(format('select public.community_media_register(%L,%L,%L,100,100)', m, ca2, 'Otra'), '22023', 'media_pending_limit', 'tope de pendientes del plan');
  execute 'reset role';

  -- ---- Cupos de miembros, canales y roles (y Ultra) ----
  perform pg_temp.com_login(own);
  v := public.community_get(ca2);
  perform pg_temp.com_assert(jsonb_array_length(v->'channels') = 2 and v->>'maxChannels' = '3' and v->>'maxRoles' = '1' and v#>>'{plan,id}' = 'free', 'community_get trae el cupo del plan');
  perform public.community_channel_create(ca2, 'text', 'tercero');
  perform pg_temp.com_expect(format('select public.community_channel_create(%L,%L,%L)', ca2, 'text', 'cuarto'), '22023', 'too_many_channels', 'tope de canales del plan');
  perform public.community_role_save(ca2, 'Veterano', '#aabbcc');
  perform pg_temp.com_expect(format('select public.community_role_save(%L,%L,%L)', ca2, 'Otro', '#aabbcc'), '22023', 'too_many_roles', 'tope de roles del plan');
  perform pg_temp.com_login(mem); perform public.community_join(ca2);
  perform pg_temp.com_login(mem2);
  perform pg_temp.com_expect(format('select public.community_join(%L)', ca2), '22023', 'community_full', 'tope de miembros del plan');
  execute 'reset role';
  perform pg_temp.com_login(adm);
  perform public.admin_community_plan_grant(ca2, 'ultra', 30);
  execute 'reset role';
  perform pg_temp.com_login(own);
  perform public.community_channel_create(ca2, 'text', 'cuarto');
  perform public.community_role_save(ca2, 'Otro', '#aabbcc');
  perform pg_temp.com_login(mem2); perform public.community_join(ca2);
  v := public.community_get(ca2);
  perform pg_temp.com_assert(v->>'maxChannels' = '150' and v->>'maxRoles' = '50' and v->>'maxMembers' = '5000', 'Ultra da más cupo de canales, roles y miembros');
  execute 'reset role';
  perform pg_temp.com_login(adm); perform public.admin_community_plan_save('free', '{"media":10,"pending":5,"channels":50,"roles":15,"members":500}'); execute 'reset role';

  -- ---- Fondos del chat y escenarios ----
  perform pg_temp.com_login(own2);
  select (x->>'id')::uuid into cb_text from jsonb_array_elements(public.community_get(cb)->'channels') x where x->>'kind' = 'text' limit 1;
  select (x->>'id')::uuid into cb_voice from jsonb_array_elements(public.community_get(cb)->'channels') x where x->>'kind' = 'voice' limit 1;
  cb_text2 := (public.community_channel_create(cb, 'text', 'segundo')->>'id')::uuid;
  cb_voice2 := (public.community_channel_create(cb, 'voice', 'otra sala')->>'id')::uuid;
  execute 'reset role';
  perform pg_temp.com_login(own);
  perform pg_temp.com_expect(format('select public.community_backdrop_set(%L,%L,null,%L,%L)', ca, 'chat', 'preset', 'soft_grid'), '22023', 'plan_limit', 'una comunidad gratis no tiene cupo de fondos');
  execute 'reset role';
  perform pg_temp.com_login(mem);
  perform pg_temp.com_expect(format('select public.community_backdrop_set(%L,%L,null,%L,%L)', cb, 'chat', 'preset', 'soft_grid'), '42501', 'forbidden', 'un miembro no cambia fondos');
  perform pg_temp.com_expect(format('select public.community_backdrop_clear(%L,%L)', cb, 'chat'), '42501', 'forbidden', 'ni los quita');
  execute 'reset role';
  perform pg_temp.com_login(own2);
  perform public.community_backdrop_set(cb, 'chat', null, 'preset', 'soft_grid', 40, 2);
  perform public.community_backdrop_set(cb, 'chat', cb_text, 'preset', 'dunes');
  perform pg_temp.com_expect(format('select public.community_backdrop_set(%L,%L,%L,%L,%L)', cb, 'chat', cb_text2, 'preset', 'paper_dots'), '22023', 'plan_limit', 'Go tiene dos fondos');
  perform public.community_backdrop_set(cb, 'chat', cb_text, 'preset', 'paper_dots');
  execute 'reset role';
  perform pg_temp.com_assert((select count(*) from public.community_backdrops where community_id = cb and kind = 'chat') = 2, 'cambiar un fondo existente no gasta otro cupo');
  perform pg_temp.com_login(own2);
  perform pg_temp.com_expect(format('select public.community_backdrop_set(%L,%L,%L,%L,%L)', cb, 'chat', cb_voice, 'preset', 'dunes'), '22023', 'bad_channel', 'un fondo de chat no va en un canal de voz');
  perform pg_temp.com_expect(format('select public.community_backdrop_set(%L,%L,%L,%L,%L)', cb, 'stage', cb_text, 'preset', 'night_forest'), '22023', 'bad_channel', 'un escenario no va en un canal de texto');
  perform pg_temp.com_expect(format('select public.community_backdrop_set(%L,%L,null,%L,%L)', cb, 'chat', 'preset', 'night_forest'), '22023', 'bad_preset', 'un escenario no es un fondo de chat');
  perform pg_temp.com_expect(format('select public.community_backdrop_set(%L,%L,null,%L,%L,90,0)', cb, 'chat', 'preset', 'soft_grid'), '22023', 'bad_value', 'oscurecer hasta 80');
  perform pg_temp.com_expect(format('select public.community_backdrop_set(%L,%L,%L,%L,%L)', cb, 'stage', cb_voice, 'preset', 'aurora'), '22023', 'plan_animated', 'Go no permite fondos animados');
  perform public.community_backdrop_set(cb, 'stage', cb_voice, 'preset', 'night_forest');
  perform pg_temp.com_expect(format('select public.community_backdrop_set(%L,%L,%L,%L,%L)', cb, 'stage', cb_voice2, 'preset', 'neon_city'), '22023', 'plan_limit', 'Go tiene un solo escenario');
  perform pg_temp.com_expect(format('select public.community_backdrop_set(%L,%L,null,%L,%L)', cb, 'chat', 'media', 'no-es-uuid'), '22023', 'bad_media', 'media inválida');
  -- Una imagen de la galería (aprobada) como fondo; una pendiente no.
  perform public.community_backdrop_set(cb, 'chat', null, 'media', ids[1]::text, 20, 0);
  execute 'reset role';
  perform pg_temp.com_assert((select source = 'media' and media_id = ids[1] and dim = 20 from public.community_backdrops where community_id = cb and kind = 'chat' and channel_id is null), 'una imagen aprobada de la galería sirve de fondo');
  perform pg_temp.com_login(own2);
  select (e->>'id')::uuid into pid from jsonb_array_elements(public.community_media_list(cb)) e where e->>'status' = 'pending' limit 1;
  perform pg_temp.com_expect(format('select public.community_backdrop_set(%L,%L,null,%L,%L)', cb, 'chat', 'media', pid), '22023', 'bad_media', 'una pendiente no sirve de fondo');
  execute 'reset role';
  perform pg_temp.com_login(mem);
  v := public.community_backdrops_get(cb);
  perform pg_temp.com_assert(jsonb_array_length(v->'items') = 3 and jsonb_array_length(v->'presets') = 12, 'un miembro ve los fondos que valen y el catálogo de incluidos');
  execute 'reset role';
  -- Escenario de la sala de voz.
  perform pg_temp.com_login(own2);
  room := (public.community_voice_room(cb_voice)->>'roomId')::uuid;
  execute 'reset role';
  perform pg_temp.com_login(mem);
  w := public.community_stage_get(room);
  perform pg_temp.com_assert(w#>>'{stage,preset}' = 'night_forest' and w->>'channelId' = cb_voice::text, 'la sala de voz recibe su escenario');
  perform pg_temp.com_login(out_u);
  perform pg_temp.com_expect(format('select public.community_stage_get(%L)', room), '42501', 'not_member', 'quien no es miembro no recibe el escenario');
  perform pg_temp.com_assert(public.community_stage_get(gen_random_uuid()) is null, 'una sala común no tiene escenario');
  execute 'reset role';
  -- Vence el plan: el miembro ya no ve fondos ni escenario; el equipo ve el motivo; al renovar vuelven.
  perform pg_temp.com_age(cb, interval '400 days');
  perform pg_temp.com_login(mem);
  perform pg_temp.com_assert(jsonb_array_length(public.community_backdrops_get(cb)->'items') = 0 and public.community_stage_get(room)->'stage' = 'null'::jsonb, 'sin plan se ocultan fondos y escenarios');
  perform pg_temp.com_login(own2);
  perform pg_temp.com_assert((select bool_and(e->>'state' = 'hidden_plan') from jsonb_array_elements(public.community_backdrops_get(cb)->'items') e), 'el equipo ve que están ocultos por el plan');
  perform pg_temp.com_expect(format('select public.community_backdrop_set(%L,%L,%L,%L,%L)', cb, 'chat', cb_text2, 'preset', 'dunes'), '22023', 'plan_limit', 'sin plan no se suman fondos');
  execute 'reset role';
  perform pg_temp.com_pay(own2, 'clan_go', cb);
  perform pg_temp.com_login(mem);
  perform pg_temp.com_assert(jsonb_array_length(public.community_backdrops_get(cb)->'items') = 3 and public.community_stage_get(room)#>>'{stage,preset}' = 'night_forest', 'al renovar vuelven');
  execute 'reset role';

  -- ---- KLIPY en la galería: pendiente, revisión, Pro para los animados ----
  perform pg_temp.com_login(mem);
  perform pg_temp.com_expect(format('select public.community_media_add_klipy(%L,%L,%L)', cb, 'Gato', klipy), '42501', 'forbidden', 'un miembro no suma GIF');
  perform pg_temp.com_login(own2);
  perform pg_temp.com_expect(format('select public.community_media_add_klipy(%L,%L,%L)', cb, 'Malo', 'https://evil.example/x.gif'), '22023', 'bad_media', 'solo direcciones de KLIPY');
  v := public.community_media_add_klipy(cb, 'Gato feliz', klipy, 'https://static2.klipy.com/ii/abc123/def456.jpg', 'gato_feliz-1');
  kid := (v->>'id')::uuid;
  perform pg_temp.com_assert(v->>'status' = 'pending' and v->>'source' = 'klipy' and (v->>'animated')::boolean and v->>'url' = klipy, 'nace pendiente');
  perform pg_temp.com_expect(format('select public.community_backdrop_set(%L,%L,null,%L,%L)', cb, 'chat', 'media', kid), '22023', 'bad_media', 'sin aprobar no es fondo');
  perform pg_temp.com_login(mem);
  perform pg_temp.com_assert(not exists (select 1 from jsonb_array_elements(public.community_media_list(cb)) e where e->>'id' = kid::text), 'el miembro no ve un GIF pendiente');
  perform pg_temp.com_login(adm);
  perform pg_temp.com_assert(exists (select 1 from jsonb_array_elements(public.admin_community_media_queue('pending')->'items') e where e->>'id' = kid::text and e->>'url' = klipy and e->>'source' = 'klipy'),
    'la cola de Administración ve el GIF de KLIPY');
  perform public.admin_community_media_review(kid, 'approve');
  perform pg_temp.com_login(own2);
  perform pg_temp.com_expect(format('select public.community_backdrop_set(%L,%L,null,%L,%L)', cb, 'chat', 'media', kid), '22023', 'plan_animated', 'un GIF animado pide Pro');
  perform pg_temp.com_login(adm); perform public.admin_community_plan_grant(cb, 'pro', 30);
  perform pg_temp.com_login(own2);
  perform public.community_backdrop_set(cb, 'chat', null, 'media', kid::text);
  execute 'reset role';
  perform pg_temp.com_assert((select media_id = kid from public.community_backdrops where community_id = cb and kind = 'chat' and channel_id is null), 'con Pro entra el GIF de KLIPY');
  perform pg_temp.com_login(own2);
  perform pg_temp.com_assert(public.community_send_media(cb_text, jsonb_build_object('kind', 'upload', 'id', kid))->'media'->>'kind' = 'klipy', 'un GIF de KLIPY de la galería viaja al chat como KLIPY');
  execute 'reset role';

  -- ---- Administración: ver, dar y quitar, cola con prioridad ----
  perform pg_temp.com_login(mem);
  perform pg_temp.com_expect('select public.admin_community_plans()', '42501', 'admin_only', 'un miembro no ve los planes');
  perform pg_temp.com_expect(format('select public.admin_community_plan_grant(%L,%L,30)', cb, 'ultra'), '42501', 'admin_only', 'un miembro no da planes');
  perform pg_temp.com_expect(format('select public.admin_community_plan_revoke(%L)', cb), '42501', 'admin_only', 'un miembro no quita planes');
  perform pg_temp.com_login(adm);
  v := public.admin_community_plans();
  perform pg_temp.com_assert(jsonb_array_length(v->'plans') = 5 and (v->>'revenueUsd')::numeric > 0 and (select (e->>'communities')::int from jsonb_array_elements(v->'plans') e where e->>'id' = 'ultra') = 1,
    'Administración ve los planes, quién los usa y lo cobrado');
  perform pg_temp.com_expect(format('select public.admin_community_plan_grant(%L,%L,30)', cb, 'free'), '22023', 'unknown_plan', 'free no se regala');
  perform pg_temp.com_expect(format('select public.admin_community_plan_grant(%L,%L,0)', cb, 'go'), '22023', 'bad_value', 'días fuera de rango');
  v := public.admin_community_plan_state(cb);
  perform pg_temp.com_assert(v#>>'{plan,id}' = 'pro' and jsonb_array_length(v->'periods') >= 2, 'estado de una comunidad con sus períodos');
  w := public.admin_community_plan_revoke(cb);
  execute 'reset role';
  perform pg_temp.com_assert((w->>'periods')::int >= 1 and pg_temp.com_plan(cb) = 'free', 'quitar a mano deja la comunidad gratis');
  perform pg_temp.com_assert((select count(*) from public.admin_actions where action in ('communityPlan.grant','communityPlan.revoke','communityPlan.edit','communityPlan.purchased','communityPlan.refunded')) >= 6,
    'todo queda en el registro de administración');
  execute 'reset role';
  -- Cola de revisión: una comunidad Ultra pasa primero aunque haya subido después.
  insert into public.community_media(id, community_id, uploaded_by, name, source, url, animated, status, created_at) values (gen_random_uuid(), cb, own2, 'Vieja', 'klipy', klipy, true, 'pending', now() - interval '2 hours');
  insert into public.community_media(id, community_id, uploaded_by, name, source, url, animated, status, created_at) values (gen_random_uuid(), ca2, own, 'Ultra nueva', 'klipy', klipy, true, 'pending', now());
  perform pg_temp.com_login(adm);
  v := public.admin_community_media_queue('pending');
  perform pg_temp.com_assert(v#>>'{items,0,communityId}' = ca2::text and (v#>>'{items,0,priority}')::boolean and v#>>'{items,0,plan}' = 'ultra', 'la cola pone primero a las comunidades Ultra');
  execute 'reset role';

  -- ---- Comunidad borrada tras pagar ----
  o := public.payments_create_order(own2, 'clan_go', 'paypal', true, cc);
  perform pg_temp.com_login(own2); perform public.community_delete(cc); execute 'reset role';
  perform pg_temp.com_assert((select community_id is null from public.payment_orders where id = (o->>'id')::uuid), 'la orden sobrevive a la comunidad borrada');
  w := public.payments_mark_paid((o->>'id')::uuid, 'pay-orphan', 2, 'USD', true, 'approved');
  perform pg_temp.com_assert((w->>'applied')::boolean and exists (select 1 from public.admin_actions where action = 'communityPlan.orphan'), 'el pago se registra y queda el aviso para devolverlo');
  w := public.payments_mark_status((o->>'id')::uuid, 'refunded', 'refunded');
  perform pg_temp.com_assert((w->>'applied')::boolean, 'y se puede devolver');
  -- Los planes de IA siguen igual.
  o := public.payments_create_order(own, 'go', 'paypal', true);
  perform pg_temp.com_assert(o->>'product' = 'ai_plan' and o->>'communityId' is null and (o->>'amount')::numeric = 8, 'los planes de IA se compran como antes');
  w := public.payments_mark_paid((o->>'id')::uuid, 'pay-ia', 8, 'USD', true, 'approved');
  perform pg_temp.com_assert((w->>'applied')::boolean and exists (select 1 from public.ai_paid_periods where order_id = (o->>'id')::uuid), 'y dan su saldo de IA');
  perform pg_temp.com_assert(not exists (select 1 from private.payments_revenue_rows() r where r.plan_id like 'clan\_%'), 'las estadísticas de IA no mezclan planes de clan');
end $scenarios$;

SELECT label FROM pg_temp.com_checks ORDER BY label;
SELECT count(*) AS com_checks FROM pg_temp.com_checks \gset
\echo PLANS_CHECKS=:com_checks
ROLLBACK;
DO $rollback$
begin
  if to_regclass('public.community_plans') is not null or to_regclass('public.community_media') is not null or exists(select 1 from auth.users)
    or to_regprocedure('public.community_plan_get(uuid)') is not null then raise exception 'Rollback incompleto'; end if;
end $rollback$;
\echo PLANS_ROLLBACK_OK
