-- Solo PostgreSQL local descartable: 0001..0037 completas, 0038 dentro de BEGIN/ROLLBACK.
-- Datos propios ficticios; sin cuentas reales, HTTP, micrófono, Vault ni entrega Realtime real.
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
SET LOCAL idle_in_transaction_session_timeout = '120s';
SET LOCAL timezone = 'UTC';
SET LOCAL search_path = public, pg_catalog;
DO $guard$
begin
  if current_database() <> 'venus_sql_test' or inet_server_addr() is null
    or not inet_server_addr() <<= '127.0.0.0/8'::inet
    or not (select rolsuper from pg_roles where rolname = session_user) then
    raise exception 'Solo postgres de base descartable local, sin túneles';
  end if;
  if exists (select 1 from auth.users) or exists (select 1 from vault.secrets)
    or to_regclass('private.curseforge_rate') is null or to_regclass('public.community_categories') is not null then
    raise exception 'Se requiere fixture vacío hasta 0037, sin 0038';
  end if;
end $guard$;
ALTER TABLE auth.users DISABLE TRIGGER USER;
DO $seq$
declare s record; n bigint; called boolean;
begin
  for s in select c.oid::regclass as name,q.seqincrement from pg_class c join pg_sequence q on q.seqrelid=c.oid
    where c.relnamespace in ('public'::regnamespace,'private'::regnamespace,'realtime'::regnamespace) loop
    execute format('select last_value,is_called from %s',s.name) into n,called;
    execute format('alter sequence %s restart with %s',s.name,n+case when called then s.seqincrement else 0 end);
  end loop;
end $seq$;
CREATE TEMP TABLE com_checks(label text primary key);
CREATE TEMP TABLE com_before AS SELECT oid,pg_get_functiondef(oid) AS definition
  FROM pg_proc WHERE pronamespace IN ('public'::regnamespace,'private'::regnamespace) AND prokind='f';
DO $access$
begin
  execute format('grant usage on schema %I to anon,authenticated,service_role',
    (select nspname from pg_namespace where oid=pg_my_temp_schema()));
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
  perform set_config('request.jwt.claim','',true);
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

-- Sin salidas externas incluso si el binario local incorporara pg_net.
CREATE OR REPLACE FUNCTION private.push_dispatch(p_user uuid,p_kind text,p_key text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $f$ begin return; end $f$;
DO $rt$
declare p oid := to_regprocedure('realtime.send(jsonb,text,text,boolean)');
begin
  execute format('create or replace function realtime.send(%s) returns void language plpgsql security invoker set search_path=%L as %L',
    pg_get_function_arguments(p),'','begin return; end');
end $rt$;

DO $catalog$
declare f record; n integer := 0; r text;
begin
  perform pg_temp.com_assert((select relrowsecurity from pg_class where oid='public.community_categories'::regclass),'categorías RLS');
  foreach r in array array['anon','authenticated'] loop
    perform pg_temp.com_assert(not has_table_privilege(r,'public.community_categories','SELECT,INSERT,UPDATE,DELETE'),'categorías sin acceso directo '||r);
  end loop;
  for f in select p.*,ns.nspname from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
    left join pg_temp.com_before b on b.oid=p.oid
    where ns.nspname in ('public','private') and p.prokind='f' and p.proname like 'community\_%' escape '\'
      and (b.oid is null or b.definition is distinct from pg_get_functiondef(p.oid)) loop
    n := n+1;
    perform pg_temp.com_assert(f.prosecdef or f.proname='community_icons','definer '||f.oid::regprocedure);
    perform pg_temp.com_assert(exists(select 1 from unnest(f.proconfig)c where c in ('search_path=""','search_path=')),'search_path '||f.oid::regprocedure);
    perform pg_temp.com_assert(not has_function_privilege('anon',f.oid,'EXECUTE'),'sin anon '||f.oid::regprocedure);
    perform pg_temp.com_assert(not exists(select 1 from aclexplode(coalesce(f.proacl,acldefault('f',f.proowner)))a
      where a.grantee=0 and a.privilege_type='EXECUTE'),'sin PUBLIC '||f.oid::regprocedure);
    perform pg_temp.com_assert(has_function_privilege('authenticated',f.oid,'EXECUTE') =
      (f.nspname='public' or f.proname in ('community_is_member','community_message_visible','community_voice_visible')),
      'ACL authenticated '||f.oid::regprocedure);
  end loop;
  perform pg_temp.com_assert(n >= 30,'inventario de funciones ampliadas');
  perform pg_temp.com_assert(not exists(select 1 from pg_temp.com_before b join pg_proc p on p.oid=b.oid
    where p.proname ~ '^(clan_|group_)' and b.definition is distinct from pg_get_functiondef(p.oid)),'funciones de clanes y auxiliares compartidas intactas');
  perform pg_temp.com_assert(not exists(select 1 from pg_temp.com_before b where not exists(select 1 from pg_proc p where p.oid=b.oid)),
    'todas las firmas anteriores conservadas');
  perform pg_temp.com_assert(exists(select 1 from pg_publication_tables where pubname='supabase_realtime'
    and schemaname='public' and tablename='community_messages'),'publicación Realtime conservada');
end $catalog$;

DO $scenarios$
declare
  owner_id uuid:=gen_random_uuid(); moderator_id uuid:=gen_random_uuid(); member_id uuid:=gen_random_uuid();
  peer_id uuid:=gen_random_uuid(); outsider_id uuid:=gen_random_uuid(); owner2 uuid:=gen_random_uuid();
  rate_user uuid:=gen_random_uuid(); ids uuid[];
  cid uuid; other_cid uuid; text_ch uuid; voice_ch uuid; announce_ch uuid; forum_ch uuid; private_ch uuid;
  cat_a uuid; cat_b uuid; other_cat uuid; root_id uuid; reply_id uuid; msg_id uuid; delete_ch uuid;
  v jsonb; w jsonb; ch_ids uuid[]; n integer; i integer; stamp timestamptz; found_error boolean;
  test_room uuid; room_code text; room_normal uuid; member_session text:='fixture-member-session'; mod_session text:='fixture-moderator-session';
  nonce text:=substr(replace(gen_random_uuid()::text,'-',''),1,8);
begin
  ids:=array[owner_id,moderator_id,member_id,peer_id,outsider_id,owner2,rate_user];
  insert into auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data)
    select x,'authenticated','authenticated','com-'||x::text||'@example.invalid',now(),'{}','{}' from unnest(ids)x;
  insert into public.profiles(id,username,display_name,friend_code)
    select x,'com_'||substr(replace(x::text,'-',''),1,16),'Cuenta ficticia','TEST-'||substr(replace(x::text,'-',''),1,12) from unnest(ids)x;

  perform pg_temp.com_login(owner_id);
  v:=public.community_create('Comunidad prueba '||nonce,'Descripción original',true); cid:=(v->>'id')::uuid;
  perform pg_temp.com_assert(v->>'myRole'='owner' and v->>'maxChannels'='50','create anterior compatible y cupo nuevo');
  v:=public.community_get(cid);
  perform pg_temp.com_assert(v->>'theme'='default' and v->>'color'='#f6b45a' and v->>'icon'='users' and v->'categories'='[]','defaults y shape comunidad');
  select (x->>'id')::uuid into text_ch from jsonb_array_elements(v->'channels')x where x->>'kind'='text';
  select (x->>'id')::uuid into voice_ch from jsonb_array_elements(v->'channels')x where x->>'kind'='voice';
  v:=public.community_customize(cid,'{"theme":"cozy","color":"#12AB34","icon":"book","banner":"forest","welcome":"Bienvenida de prueba","rules":"Respeto y colaboración"}');
  perform pg_temp.com_assert(v->>'color'='#12ab34' and v->>'welcome'='Bienvenida de prueba' and v->>'banner'='forest','personalización completa');
  perform pg_temp.com_expect(format('select public.community_customize(%L,%L)',cid,'{"theme":"extra"}'),'22023','bad_theme','rechaza tema inválido');
  perform pg_temp.com_expect(format('select public.community_customize(%L,%L)',cid,'{"color":"red"}'),'22023','bad_color','rechaza color fuera de formato');
  perform pg_temp.com_expect(format('select public.community_customize(%L,%L)',cid,'{"banner":"https://example.invalid/picture.png"}'),'22023','bad_banner','solo presets sin URLs');
  perform pg_temp.com_expect(format('select public.community_customize(%L,%L)',cid,jsonb_build_object('rules',repeat('x',4001))),'22023','bad_rules','límite reglas');
  perform pg_temp.com_expect(format('select public.community_customize(%L,%L)',cid,'{"owner":"other"}'),'22023','bad_request','rechaza campos no permitidos');
  v:=public.community_update(cid,'{"description":"Descripción nueva"}');
  perform pg_temp.com_assert(v->>'description'='Descripción nueva' and v->>'theme'='cozy','update anterior preserva personalización');
  v:=public.community_category_save(cid,'Conversación'); cat_a:=(v->>'id')::uuid;
  v:=public.community_category_save(cid,'Actividades'); cat_b:=(v->>'id')::uuid;
  perform public.community_category_reorder(cid,array[cat_b,cat_a]);
  v:=public.community_get(cid);
  perform pg_temp.com_assert(v#>>'{categories,0,id}'=cat_b::text,'categorías ordenadas');
  perform public.community_category_save(cid,'Charlas',cat_a);
  perform pg_temp.com_expect(format('select public.community_category_reorder(%L,%L::uuid[])',cid,array[cat_a,cat_a]),'22023','bad_order','orden categorías sin duplicados');
  v:=public.community_channel_create_configured(cid,'announcement','avisos',jsonb_build_object('categoryId',cat_b,'topic','Avisos de prueba','icon','megaphone'));
  announce_ch:=(v->>'id')::uuid;
  perform pg_temp.com_assert(v->>'postingRole'='staff' and v->>'topic'='Avisos de prueba','anuncio configurado atómico');
  v:=public.community_channel_create_configured(cid,'forum','temas',jsonb_build_object('categoryId',cat_a)); forum_ch:=(v->>'id')::uuid;
  v:=public.community_channel_create_configured(cid,'text','equipo','{"isPrivate":true,"postingRole":"staff"}'); private_ch:=(v->>'id')::uuid;
  v:=public.community_get(cid); n:=jsonb_array_length(v->'channels');
  perform pg_temp.com_expect(format('select public.community_channel_create_configured(%L,%L,%L,%L)',cid,'text','fallo propio','{"icon":"unknown"}'),
    '22023','bad_icon','crear configurado rechaza datos inválidos');
  perform pg_temp.com_assert(jsonb_array_length(public.community_get(cid)->'channels')=n,'crear configurado revierte canal parcial');
  perform pg_temp.com_expect(format('select public.community_channel_configure(%L,%L)',announce_ch,'{"postingRole":"members"}'),
    '22023','bad_posting_role','anuncios siempre staff');
  perform pg_temp.com_expect(format('select public.community_channel_configure(%L,%L)',voice_ch,'{"slowmodeSeconds":5}'),
    '22023','bad_request','voz sin opciones de chat');
  perform pg_temp.com_expect(format('select public.community_channel_configure(%L,%L)',text_ch,'{"kind":"voice"}'),
    '22023','bad_request','tipo inmutable');
  perform public.community_channel_rename(text_ch,'charla');
  perform pg_temp.com_assert(exists(select 1 from jsonb_array_elements(public.community_get(cid)->'channels')x where x->>'name'='charla'),'rename anterior compatible');
  perform pg_temp.com_expect(format('select public.community_send(%L,%L)',voice_ch,'texto de prueba'),'22023','bad_kind','voz no admite chat');
  perform pg_temp.com_expect(format('select public.community_messages_page(%L)',voice_ch),'22023','bad_kind','voz no se interpreta como historial');
  perform pg_temp.com_expect(format('select public.community_send(%L,%L)',forum_ch,'texto de prueba'),'22023','bad_kind','foro no usa send de chat');
  perform pg_temp.com_expect(format('select public.community_messages_page(%L)',forum_ch),'22023','bad_kind','foro requiere RPC tópicos');
  execute 'reset role';

  perform pg_temp.com_login(owner2);
  other_cid:=(public.community_create('Otro espacio '||nonce)->>'id')::uuid;
  other_cat:=(public.community_category_save(other_cid,'Categoría ajena')->>'id')::uuid;
  execute 'reset role';
  perform pg_temp.com_login(owner_id);
  perform pg_temp.com_expect(format('select public.community_channel_configure(%L,%L)',text_ch,jsonb_build_object('categoryId',other_cat)),
    '22023','bad_category','no mezcla categorías de comunidades');
  execute 'reset role';

  foreach root_id in array array[moderator_id,member_id,peer_id,rate_user] loop
    perform pg_temp.com_login(root_id);
    perform public.community_join(cid);
    execute 'reset role';
  end loop;
  perform pg_temp.com_login(owner_id);
  perform public.community_set_role(cid,moderator_id,'moderator');
  perform public.community_channel_configure(text_ch,'{"slowmodeSeconds":60}');
  perform public.community_send(announce_ch,'Aviso del dueño');
  perform public.community_send(private_ch,'Mensaje reservado de prueba');
  execute 'reset role';
  perform pg_temp.com_login(member_id);
  v:=public.community_get(cid);
  perform pg_temp.com_assert(not exists(select 1 from jsonb_array_elements(v->'channels')x where x->>'id'=private_ch::text),'canal privado invisible al miembro');
  perform pg_temp.com_assert(exists(select 1 from jsonb_array_elements(v->'channels')x where x->>'id'=announce_ch::text and x->>'canPost'='false'),'miembro ve aviso sin publicar');
  perform pg_temp.com_expect(format('select public.community_customize(%L,%L)',cid,'{"theme":"compact"}'),'42501','forbidden','apariencia solo dueño');
  perform pg_temp.com_expect(format('select public.community_category_save(%L,%L)',cid,'Otra'),'42501','forbidden','miembro no administra categorías');
  perform pg_temp.com_expect(format('select public.community_channel_delete(%L)',text_ch),'42501','forbidden','miembro no borra canal');
  perform pg_temp.com_expect(format('select public.community_messages_page(%L)',private_ch),'42501','forbidden','historial privado protegido');
  perform pg_temp.com_expect(format('select public.community_send(%L,%L)',announce_ch,'Aviso de miembro'),'42501','forbidden','anuncio no publica miembro');
  perform pg_temp.com_assert((select count(*)=0 from public.community_messages where channel_id=private_ch),'RLS no revela mensaje privado');
  v:=public.community_send(text_ch,'Primer mensaje propio'); msg_id:=(v->>'id')::uuid;
  perform pg_temp.com_assert(v->>'body'='Primer mensaje propio' and v->'parentId'='null','chat anterior compatible');
  v:=public.community_get(cid);
  perform pg_temp.com_assert(exists(select 1 from jsonb_array_elements(v->'channels')x where x->>'id'=text_ch::text and x->>'nextPostAt' is not null),'slowmode sobrevive recarga');
  found_error:=false;
  begin perform public.community_send(text_ch,'Segundo mensaje inmediato');
  exception when sqlstate 'PT429' then
    get stacked diagnostics v = pg_exception_detail;
    found_error:=sqlerrm='slowmode' and v->>'nextPostAt' is not null;
  end;
  perform pg_temp.com_assert(found_error,'slowmode entrega fecha de reintento');
  perform public.community_message_delete(msg_id);
  perform pg_temp.com_expect(format('select public.community_send(%L,%L)',text_ch,'Mensaje tras borrar'),'PT429','slowmode','borrar mensaje no reinicia slowmode');
  execute 'reset role';
  update public.community_messages set created_at=clock_timestamp()-interval '2 minutes' where id=msg_id;
  perform pg_temp.com_login(member_id);
  perform pg_temp.com_assert(public.community_send(text_ch,'Ventana nueva')->>'body'='Ventana nueva','slowmode permite nueva ventana');
  execute 'reset role';
  perform pg_temp.com_login(moderator_id);
  perform public.community_send(text_ch,'Moderación uno');
  perform public.community_send(text_ch,'Moderación dos');
  perform pg_temp.com_assert(public.community_send(announce_ch,'Aviso del equipo')->>'body'='Aviso del equipo','moderador publica anuncios y exento slowmode');
  perform pg_temp.com_expect(format('select public.community_customize(%L,%L)',cid,'{"theme":"compact"}'),'42501','forbidden','moderador no cambia apariencia');
  perform pg_temp.com_assert(public.community_category_save(cid,'Nueva categoría')->>'name'='Nueva categoría','moderador administra categorías');
  execute 'reset role';

  perform pg_temp.com_login(peer_id);
  v:=public.community_forum_topic_create(forum_ch,'Tema real de prueba','Texto del tema'); root_id:=(v->>'id')::uuid; stamp:=(v->>'at')::timestamptz;
  perform pg_temp.com_assert(v->>'title'='Tema real de prueba' and v->'parentId'='null','foro crea tema real');
  perform public.community_forum_topic_create(forum_ch,'Segundo tema real','Otro texto');
  perform pg_temp.com_assert(jsonb_array_length(public.community_forum_topics(forum_ch,null,1))=1,'foro pagina temas');
  perform pg_temp.com_assert(jsonb_array_length(public.community_forum_topics(forum_ch,stamp,100))=0,'foro cursor anterior');
  execute 'reset role';
  perform pg_temp.com_login(member_id);
  v:=public.community_forum_reply(root_id,'Respuesta real'); reply_id:=(v->>'id')::uuid; stamp:=(v->>'at')::timestamptz;
  perform pg_temp.com_assert(v->>'parentId'=root_id::text and v->'title'='null','foro reply ligado a raíz');
  perform public.community_forum_reply(root_id,'Segunda respuesta');
  perform pg_temp.com_assert(jsonb_array_length(public.community_forum_replies(root_id,null,1))=1
    and jsonb_array_length(public.community_forum_replies(root_id,stamp,100))=0,'foro pagina respuestas');
  perform pg_temp.com_assert(exists(select 1 from jsonb_array_elements(public.community_forum_topics(forum_ch))x
    where x->>'id'=root_id::text and x->>'replyCount'='2'),'foro cuenta respuestas');
  perform pg_temp.com_expect(format('select public.community_forum_reply(%L,%L)',reply_id,'No anidar'),'22023','not_found','foro no anida respuestas');
  perform pg_temp.com_expect(format('select public.community_forum_topic_create(%L,%L,%L)',text_ch,'Tema','Contenido'),'22023','bad_kind','tema solo en foro');
  perform pg_temp.com_expect(format('select public.community_forum_topic_create(%L,%L,%L)',forum_ch,'ab','Contenido'),'22023','bad_title','título de foro validado');
  perform pg_temp.com_expect(format('select public.community_message_delete(%L)',root_id),'42501','forbidden','miembro no borra tema ajeno');
  execute 'reset role';

  insert into public.friendships(requester,addressee,status) values(member_id,peer_id,'blocked');
  perform pg_temp.com_login(member_id);
  perform pg_temp.com_assert(not exists(select 1 from jsonb_array_elements(public.community_forum_topics(forum_ch))x where x->>'authorId'=peer_id::text),'bloqueo filtra temas RPC');
  perform pg_temp.com_assert((select count(*)=0 from public.community_messages where id=root_id or parent_id=root_id),'RLS filtra raíz bloqueada y respuestas');
  perform pg_temp.com_expect(format('select public.community_forum_replies(%L)',root_id),'22023','not_found','bloqueo filtra lectura hilo');
  execute 'reset role';
  delete from public.friendships where requester=member_id and addressee=peer_id;

  perform pg_temp.com_login(owner_id);
  perform public.community_message_delete(root_id);
  execute 'reset role';
  perform pg_temp.com_assert((select bool_and(deleted and body='' and title is null) from public.community_messages where id=root_id or parent_id=root_id),'borrar raíz borra suavemente todo el hilo');
  perform pg_temp.com_login(member_id);
  perform pg_temp.com_expect(format('select public.community_forum_reply(%L,%L)',root_id,'Respuesta tardía'),'22023','thread_deleted','tema borrado no recibe respuestas');
  perform pg_temp.com_expect(format('select public.community_forum_replies(%L)',root_id),'22023','thread_deleted','leer hilo borrado informa thread_deleted');
  execute 'reset role';

  -- Bloqueos y silencios sobre cuentas propias de este ensayo.
  perform pg_temp.com_login(owner_id);
  perform public.community_mute(cid,member_id,1);
  execute 'reset role';
  perform pg_temp.com_login(member_id);
  perform pg_temp.com_assert(jsonb_array_length(public.community_messages_page(announce_ch))=2,'silencio permite lectura');
  perform pg_temp.com_expect(format('select public.community_forum_topic_create(%L,%L,%L)',forum_ch,'Tema en silencio','Texto'),
    '22023','community_muted','silencio impide publicación foro');
  execute 'reset role';
  perform pg_temp.com_login(owner_id);
  perform public.community_mute(cid,member_id,0);
  execute 'reset role';
  update auth.users set banned_until=now()+interval '1 day' where id=member_id;
  perform pg_temp.com_login(member_id);
  perform pg_temp.com_expect(format('select public.community_get(%L)',cid),'42501','user_banned','baneo global corta RPC');
  perform pg_temp.com_assert((select count(*)=0 from public.community_messages where community_id=cid),'baneo global corta RLS');
  execute 'reset role';
  update auth.users set banned_until=null where id=member_id;

  perform pg_temp.com_login(outsider_id);
  v:=public.community_get(cid);
  perform pg_temp.com_assert(not(v ? 'channels') and not(v ? 'welcome') and not(v ? 'rules') and not(v ? 'categories'),'no miembro solo recibe tarjeta pública');
  perform pg_temp.com_expect(format('select public.community_messages_page(%L)',text_ch),'42501','not_member','no miembro sin historial');
  perform pg_temp.com_assert((select count(*)=0 from public.community_messages where community_id=cid),'no miembro sin mensajes RLS');
  execute 'reset role';
  perform pg_temp.com_login(null,'anon');
  perform pg_temp.com_expect(format('select public.community_get(%L)',cid),'42501',null,'anon no ejecuta RPC');
  perform pg_temp.com_expect('select * from public.community_messages','42501',null,'anon no lee tabla mensajes');
  execute 'reset role';

  -- Tope de publicaciones compartido entre chat, anuncios y foros.
  perform pg_temp.com_login(rate_user);
  for i in 1..30 loop perform public.community_forum_topic_create(forum_ch,'Tema cuota '||i,'Dato propio de prueba'); end loop;
  perform pg_temp.com_expect(format('select public.community_forum_topic_create(%L,%L,%L)',forum_ch,'Tema cuota final','Dato propio'),
    'PT429','rate_limited','cuota treinta publicaciones por minuto');
  execute 'reset role';
  perform pg_temp.com_login(owner_id);
  perform public.community_channel_configure(forum_ch,'{"postingRole":"staff"}');
  execute 'reset role';
  perform pg_temp.com_login(member_id);
  perform pg_temp.com_expect(format('select public.community_forum_topic_create(%L,%L,%L)',forum_ch,'Tema no permitido','Texto'),
    '42501','forbidden','foro staff restringe temas');
  execute 'reset role';
  perform pg_temp.com_login(owner_id);
  v:=public.community_forum_topic_create(forum_ch,'Tema del equipo','Contenido');
  root_id:=(v->>'id')::uuid;
  execute 'reset role';
  perform pg_temp.com_login(member_id);
  perform pg_temp.com_expect(format('select public.community_forum_reply(%L,%L)',root_id,'Respuesta de miembro'),
    '42501','forbidden','foro staff restringe respuestas');
  execute 'reset role';

  -- Voz: flujo normal, privacidad, democión, retiro y políticas Realtime con filas locales.
  perform pg_temp.com_login(member_id);
  v:=public.community_voice_room(voice_ch); test_room:=(v->>'roomId')::uuid; room_code:=v->>'code';
  v:=public.voice_join(room_code,null,member_session,'fixture-public-key-member');
  perform pg_temp.com_assert(v ? 'room','miembro entra por voz existente');
  perform pg_temp.com_assert(private.voice_can_use_topic('voice:'||room_code),'miembro activo autorizado Realtime voz');
  perform set_config('realtime.topic','voice:'||room_code,true);
  insert into realtime.messages(id,topic,extension,payload) values(10001,'voice:'||room_code,'broadcast','{"fixture":true}');
  perform pg_temp.com_assert((select count(*)=1 from realtime.messages where id=10001),'Realtime voz permite fila propia');
  execute 'reset role';
  perform pg_temp.com_login(moderator_id);
  perform public.community_voice_room(voice_ch);
  perform pg_temp.com_assert(public.voice_join(room_code,null,mod_session,'fixture-public-key-moderator') ? 'room','moderador entra en voz');
  execute 'reset role';

  perform pg_temp.com_login(owner_id);
  perform public.community_channel_configure(voice_ch,'{"isPrivate":true}');
  execute 'reset role';
  perform pg_temp.com_assert(not exists(select 1 from public.voice_members vm where vm.room_id=test_room and vm.user_id=member_id),'hacer privado revoca admisión miembro');
  perform pg_temp.com_login(member_id);
  perform pg_temp.com_expect(format('select public.community_voice_room(%L)',voice_ch),'42501','forbidden','miembro sin sala privada');
  perform pg_temp.com_assert(public.voice_join(room_code,null,member_session,'fixture-public-key-member')->>'error'='not_found','código previo no permite reingreso privado');
  perform pg_temp.com_assert(public.voice_heartbeat(test_room,member_session)->>'error'='gone','latido termina sesión retirada');
  perform pg_temp.com_assert(public.voice_room_by_code(room_code)->>'error'='not_found','lookup oculta sala privada');
  perform pg_temp.com_assert(public.voice_member_keys(test_room)->>'error'='not_member','claves públicas de sesión inaccesibles tras retiro');
  perform pg_temp.com_assert(not private.voice_can_use_topic('voice:'||room_code),'Realtime voz deniega miembro retirado');
  perform pg_temp.com_assert((select count(*)=0 from realtime.messages where id=10001),'RLS voz no lee evento tras retiro');
  perform pg_temp.com_expect(format('insert into realtime.messages(id,topic,extension,payload) values(10002,%L,%L,%L)',
    'voice:'||room_code,'broadcast','{"fixture":true}'),'42501',null,'RLS voz no publica tras retiro');
  perform pg_temp.com_assert((select count(*)=0 from public.voice_rooms where id=test_room),'RLS sala privada oculta metadata');
  v:=public.voice_list_rooms();
  perform pg_temp.com_assert(not exists(select 1 from jsonb_array_elements(v->'recent')x where x->>'id'=test_room::text),'Recientes no revela canal privado');
  -- Sala normal independiente: la barrera de comunidades no cambia su contrato.
  v:=public.voice_create_room('Sala propia prueba',true,null,8); room_normal:=(v#>>'{room,id}')::uuid;
  perform pg_temp.com_assert(room_normal is not null,'voz independiente se sigue creando');
  perform pg_temp.com_assert(public.voice_join(v#>>'{room,code}',null,'fixture-normal-session','fixture-public-key-normal') ? 'room',
    'voz independiente se sigue usando');
  execute 'reset role';

  perform pg_temp.com_login(owner_id);
  perform public.community_set_role(cid,moderator_id,'member');
  execute 'reset role';
  perform pg_temp.com_assert(not exists(select 1 from public.voice_members v where v.room_id=test_room and v.user_id=moderator_id),'democión revoca sala staff');
  perform pg_temp.com_login(moderator_id);
  perform pg_temp.com_assert(not private.voice_can_use_topic('voice:'||room_code),'democión revoca Realtime');
  perform pg_temp.com_assert((select count(*)=0 from public.community_messages where channel_id=private_ch),'democión oculta mensajes staff RLS');
  perform pg_temp.com_expect(format('select public.community_channel_configure(%L,%L)',text_ch,'{"name":"cambio"}'),
    '42501','forbidden','democión revoca gestión');
  execute 'reset role';

  perform pg_temp.com_login(owner_id);
  perform public.community_channel_configure(voice_ch,'{"isPrivate":false}');
  execute 'reset role';
  perform pg_temp.com_login(peer_id);
  perform public.community_voice_room(voice_ch);
  perform public.voice_join(room_code,null,'fixture-peer-session','fixture-public-key-peer');
  perform public.community_leave(cid);
  perform pg_temp.com_assert(public.voice_heartbeat(test_room,'fixture-peer-session')->>'error'='gone','salir revoca latido de voz');
  perform pg_temp.com_assert(not private.voice_can_use_topic('voice:'||room_code),'salir revoca Realtime de voz');
  execute 'reset role';
  perform pg_temp.com_login(owner_id);
  perform public.community_kick(cid,moderator_id);
  execute 'reset role';
  perform pg_temp.com_login(moderator_id);
  perform pg_temp.com_assert((select count(*)=0 from public.community_messages where community_id=cid),'expulsión revoca mensajes RLS');
  perform pg_temp.com_expect(format('select public.community_join(%L)',cid),'22023','banned_here','expulsión impide reingreso');
  execute 'reset role';

  insert into public.friendships(requester,addressee,status) values(owner_id,member_id,'blocked');
  perform pg_temp.com_login(member_id);
  perform pg_temp.com_expect(format('select public.community_get(%L)',cid),'42501','forbidden','bloqueo dueño impide lectura existente');
  perform pg_temp.com_assert((select count(*)=0 from public.community_messages where community_id=cid),'bloqueo dueño filtra RLS');
  perform pg_temp.com_expect(format('select public.community_voice_room(%L)',voice_ch),'42501','forbidden','bloqueo dueño impide voz');
  execute 'reset role';
  delete from public.friendships where requester=owner_id and addressee=member_id;

  perform pg_temp.com_login(owner_id);
  -- Reordenación completa, borrar categoría desagrupa, borrar canal elimina su contenido/sala.
  select array_agg((x->>'id')::uuid order by x->>'id' desc) into ch_ids from jsonb_array_elements(public.community_get(cid)->'channels')x;
  perform public.community_channels_reorder(cid,ch_ids);
  perform pg_temp.com_assert(public.community_get(cid)#>>'{channels,0,id}'=ch_ids[1]::text,'orden completo de canales');
  perform pg_temp.com_expect(format('select public.community_channels_reorder(%L,%L::uuid[])',cid,array[text_ch,text_ch]),'22023','bad_order','orden canales rechaza duplicados');
  perform public.community_category_delete(cat_a);
  v:=public.community_get(cid);
  perform pg_temp.com_assert(exists(select 1 from jsonb_array_elements(v->'channels')x where x->>'id'=forum_ch::text and x->'categoryId'='null'),'borrar categoría desagrupa sin borrar canal');
  perform public.community_channel_delete(forum_ch);
  perform public.community_channel_delete(voice_ch);
  execute 'reset role';
  perform pg_temp.com_assert(not exists(select 1 from public.community_messages where channel_id=forum_ch),'borrar foro elimina temas y respuestas');
  perform pg_temp.com_assert(not exists(select 1 from public.voice_rooms where id=test_room),'borrar canal de voz elimina sala');
  perform pg_temp.com_assert(exists(select 1 from public.voice_rooms where id=room_normal),'borrar canal conserva sala independiente');

  perform pg_temp.com_login(owner_id);
  -- Cupos sin modificar las tablas directamente.
  n:=jsonb_array_length(public.community_get(cid)->'categories');
  for i in n+1..20 loop perform public.community_category_save(cid,'Categoría '||i); end loop;
  perform pg_temp.com_expect(format('select public.community_category_save(%L,%L)',cid,'Categoría extra'),
    '22023','too_many_categories','tope veinte categorías');
  n:=jsonb_array_length(public.community_get(cid)->'channels');
  for i in n+1..50 loop perform public.community_channel_create(cid,'text','Canal '||i); end loop;
  perform pg_temp.com_expect(format('select public.community_channel_create(%L,%L,%L)',cid,'text','Canal extra'),
    '22023','too_many_channels','tope cincuenta canales');
  execute 'reset role';

  perform pg_temp.com_login(owner2);
  v:=public.community_get(other_cid);
  for w in select x from jsonb_array_elements(v->'channels')x loop
    perform public.community_channel_delete((w->>'id')::uuid);
  end loop;
  perform pg_temp.com_assert(public.community_get(other_cid)->'channels'='[]','borrar último canal permitido');
  perform public.community_delete(other_cid);
  execute 'reset role';
  perform pg_temp.com_assert(not exists(select 1 from public.community_categories where community_id=other_cid),'borrar comunidad limpia categorías');

  -- Esquema anterior de comunidad y RPC de denuncias continúan existiendo; nada borra clanes.
  perform pg_temp.com_assert(to_regprocedure('public.community_report(text,uuid,text,text)') is not null,'firma de reportes conservada');
end $scenarios$;

SELECT label FROM pg_temp.com_checks ORDER BY label;
SELECT count(*) AS checks FROM pg_temp.com_checks;
SELECT count(*) AS com_checks FROM pg_temp.com_checks \gset
\echo COMMUNITIES_CHECKS=:com_checks
ROLLBACK;
DO $rollback$
begin
  if to_regclass('public.community_categories') is not null
    or to_regprocedure('public.community_customize(uuid,jsonb)') is not null
    or exists(select 1 from auth.users) then raise exception 'Rollback incompleto'; end if;
end $rollback$;
\echo COMMUNITIES_ROLLBACK_OK
