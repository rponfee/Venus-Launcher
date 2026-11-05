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
    perform pg_temp.com_assert(f.prosecdef or f.proname in ('community_icons','community_perms','community_perm_applies','community_perm_base',
      'community_perm_calc','community_has_link','community_media_folder','community_greeting_vars_ok','community_greeting_render'),'definer '||f.oid::regprocedure);
    perform pg_temp.com_assert(exists(select 1 from unnest(f.proconfig)c where c in ('search_path=""','search_path=')),'search_path '||f.oid::regprocedure);
    perform pg_temp.com_assert(not has_function_privilege('anon',f.oid,'EXECUTE'),'sin anon '||f.oid::regprocedure);
    perform pg_temp.com_assert(not exists(select 1 from aclexplode(coalesce(f.proacl,acldefault('f',f.proowner)))a
      where a.grantee=0 and a.privilege_type='EXECUTE'),'sin PUBLIC '||f.oid::regprocedure);
    perform pg_temp.com_assert(has_function_privilege('authenticated',f.oid,'EXECUTE') =
      (f.nspname='public' or f.proname in ('community_is_member','community_message_visible','community_voice_visible',
        'community_media_folder','community_media_can_upload','community_media_can_read','community_media_can_delete')),
      'ACL authenticated '||f.oid::regprocedure);
  end loop;
  perform pg_temp.com_assert(n >= 60,'inventario de funciones ampliadas');
  foreach r in array array['community_roles','community_member_roles','community_channel_perms','community_reactions','community_media','community_greetings'] loop
    perform pg_temp.com_assert((select relrowsecurity from pg_class where oid=('public.'||r)::regclass),'RLS '||r);
    perform pg_temp.com_assert(not has_table_privilege('authenticated','public.'||r,'SELECT,INSERT,UPDATE,DELETE')
      and not has_table_privilege('anon','public.'||r,'SELECT,INSERT,UPDATE,DELETE'),'sin acceso directo '||r);
  end loop;
  perform pg_temp.com_assert(exists(select 1 from storage.buckets where id='community-media' and not public and file_size_limit=2097152
    and allowed_mime_types=array['image/gif','image/webp','image/png']),'bucket privado community-media con límites');
  perform pg_temp.com_assert((select count(*)=3 from pg_policies where schemaname='storage' and tablename='objects' and policyname like 'community\_media\_%'),
    'tres políticas de community-media');
  perform pg_temp.com_assert(has_function_privilege('authenticated','public.admin_community_media_queue(text,integer,integer)','EXECUTE')
    and not has_function_privilege('anon','public.admin_community_media_review(uuid,text,text)','EXECUTE'),'ACL panel de GIFs');
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

-- ---------- Ampliación 4.6: roles propios y permisos por canal ----------
CREATE FUNCTION pg_temp.com_user(nm text) RETURNS uuid LANGUAGE plpgsql AS $f$
declare x uuid:=gen_random_uuid();
begin
  insert into auth.users(id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data)
    values(x,'authenticated','authenticated','com-'||x::text||'@example.invalid',now(),'{}','{}');
  insert into public.profiles(id,username,display_name,friend_code)
    values(x,'com_'||substr(replace(x::text,'-',''),1,16),nm,'TEST-'||substr(replace(x::text,'-',''),1,12));
  return x;
end $f$;
CREATE FUNCTION pg_temp.com_count(q text) RETURNS bigint LANGUAGE plpgsql AS $f$
declare n bigint;
begin execute q into n; return n; end $f$;
-- Lo que la cuenta ve de un canal (el objeto can de community_get) o null si no lo ve. Se llama sin rol puesto.
CREATE FUNCTION pg_temp.com_can(cid uuid,who uuid,ch uuid) RETURNS jsonb LANGUAGE plpgsql AS $f$
declare r jsonb;
begin
  perform pg_temp.com_login(who);
  select x into r from jsonb_array_elements(public.community_get(cid)->'channels')x where x->>'id'=ch::text;
  execute 'reset role';
  return r;
end $f$;
CREATE FUNCTION pg_temp.com_post(ch uuid,who uuid,body text) RETURNS jsonb LANGUAGE plpgsql AS $f$
declare r jsonb;
begin
  perform pg_temp.com_login(who);
  r:=public.community_send(ch,body);
  execute 'reset role';
  return r;
end $f$;

DO $perms$
declare
  own uuid; modu uuid; alice uuid; bob uuid; carl uuid; eve uuid; owner2 uuid;
  cid uuid; ocid uuid; v jsonb; w jsonb; actual jsonb; n integer; i integer; usr uuid; chn uuid; subj text; p text; elem jsonb;
  r_team uuid; r_listen uuid; r_writer uuid; r_foreign uuid; r_extra uuid[];
  ch_read uuid; ch_priv uuid; ch_embed uuid; ch_react uuid; ch_voice uuid; ch_ann uuid; ch_plain uuid;
  msg uuid; room uuid; code text; keys jsonb;
  nonce text:=substr(replace(gen_random_uuid()::text,'-',''),1,8);
  klipy jsonb:='{"kind":"klipy","url":"https://static.klipy.com/ii/abc123/def456.gif","slug":"gato-feliz"}';
begin
  own:=pg_temp.com_user('Dueña'); modu:=pg_temp.com_user('Moderador'); alice:=pg_temp.com_user('Alicia'); bob:=pg_temp.com_user('Beto');
  carl:=pg_temp.com_user('Carlos'); eve:=pg_temp.com_user('Eva'); owner2:=pg_temp.com_user('Otra dueña');
  perform pg_temp.com_login(owner2);
  ocid:=(public.community_create('Ajena '||nonce)->>'id')::uuid;
  r_foreign:=(public.community_role_save(ocid,'Ajeno')->>'id')::uuid;
  execute 'reset role';
  perform pg_temp.com_login(own);
  cid:=(public.community_create('Permisos '||nonce)->>'id')::uuid;
  execute 'reset role';
  foreach usr in array array[modu,alice,bob,carl] loop
    perform pg_temp.com_login(usr); perform public.community_join(cid); execute 'reset role';
  end loop;
  perform pg_temp.com_login(own);
  perform public.community_set_role(cid,modu,'moderator');

  -- Roles propios: solo el dueño los crea; nombres válidos, únicos y sin hacerse pasar por el equipo.
  v:=public.community_role_save(cid,'Equipo','#3B82F6'); r_team:=(v->>'id')::uuid;
  perform pg_temp.com_assert(v->>'color'='#3b82f6' and v->>'name'='Equipo','rol propio creado con color normalizado');
  r_listen:=(public.community_role_save(cid,'Oyentes','#22c55e')->>'id')::uuid;
  r_writer:=(public.community_role_save(cid,'Redactores')->>'id')::uuid;
  perform pg_temp.com_expect(format('select public.community_role_save(%L,%L)',cid,'Staff'),'22023','reserved_name','rol no imita al equipo');
  perform pg_temp.com_expect(format('select public.community_role_save(%L,%L)',cid,'equipo'),'22023','role_name_taken','rol con nombre repetido sin importar mayúsculas');
  perform pg_temp.com_expect(format('select public.community_role_save(%L,%L,%L)',cid,'Color malo','azul'),'22023','bad_color','color de rol validado');
  perform pg_temp.com_expect(format('select public.community_role_save(%L,%L)',cid,'   '),'22023','bad_role_name','nombre de rol vacío rechazado');
  perform pg_temp.com_expect(format('select public.community_role_save(%L,%L,%L,%L)',cid,'Renombrado','#111111',r_foreign),'22023','bad_role','no edita roles de otra comunidad');
  perform public.community_role_save(cid,'Redactores','#f59e0b',r_writer);
  execute 'reset role';
  perform pg_temp.com_login(modu);
  perform pg_temp.com_expect(format('select public.community_role_save(%L,%L)',cid,'Del moderador'),'42501','forbidden','moderador no crea roles');
  perform pg_temp.com_expect(format('select public.community_role_delete(%L)',r_team),'42501','forbidden','moderador no borra roles');
  -- Asignar: dueño y moderadores, solo a miembros comunes.
  perform public.community_role_assign(cid,alice,r_team);
  perform public.community_role_assign(cid,carl,r_listen);
  perform pg_temp.com_expect(format('select public.community_role_assign(%L,%L,%L)',cid,modu,r_team),'22023','bad_target','el equipo no recibe roles propios');
  perform pg_temp.com_expect(format('select public.community_role_assign(%L,%L,%L)',cid,eve,r_team),'22023','not_member_target','no asigna a quien no es miembro');
  perform pg_temp.com_expect(format('select public.community_role_assign(%L,%L,%L)',cid,alice,r_foreign),'22023','bad_role','no asigna roles de otra comunidad');
  execute 'reset role';
  perform pg_temp.com_login(bob);
  perform pg_temp.com_expect(format('select public.community_role_assign(%L,%L,%L)',cid,bob,r_team),'42501','forbidden','miembro no se asigna roles');
  v:=public.community_get(cid);
  perform pg_temp.com_assert(jsonb_array_length(v->'roles')=3 and v->'myRoleIds'='[]' and v->'greetings'='null' and (v->>'maxRoles')::int=15,
    'miembro ve la lista de roles pero no la bienvenida del dueño');
  execute 'reset role';
  perform pg_temp.com_login(alice);
  perform pg_temp.com_assert((public.community_get(cid)->'myRoleIds')->>0=r_team::text,'myRoleIds de la cuenta con rol');
  perform pg_temp.com_assert(exists(select 1 from jsonb_array_elements(public.community_members_list(cid)->'members')m
    where m->>'userId'=alice::text and m->'roleIds'->>0=r_team::text),'lista de miembros trae roleIds');
  execute 'reset role';

  -- Canales con permisos distintos.
  perform pg_temp.com_login(own);
  ch_read:=(public.community_channel_create_configured(cid,'text','reglas','{"postingRole":"staff"}')->>'id')::uuid;
  ch_priv:=(public.community_channel_create_configured(cid,'text','equipo','{"isPrivate":true}')->>'id')::uuid;
  ch_embed:=(public.community_channel_create(cid,'text','medios')->>'id')::uuid;
  ch_react:=(public.community_channel_create(cid,'text','muro')->>'id')::uuid;
  ch_plain:=(public.community_channel_create(cid,'text','libre')->>'id')::uuid;
  ch_ann:=(public.community_channel_create(cid,'announcement','avisos')->>'id')::uuid;
  ch_voice:=(public.community_channel_create(cid,'voice','sala')->>'id')::uuid;
  perform public.community_channel_perms_set(ch_embed,null,'{"embeds":false}');
  perform public.community_channel_perms_set(ch_embed,r_team,'{"embeds":"allow"}');
  perform public.community_channel_perms_set(ch_priv,r_team,'{"view":"allow"}');
  perform public.community_channel_perms_set(ch_read,r_writer,'{"write":"allow"}');
  perform public.community_channel_perms_set(ch_react,null,'{"react":false}');
  perform public.community_channel_perms_set(ch_react,r_team,'{"react":"allow"}');
  perform public.community_channel_perms_set(ch_voice,null,'{"connect":false}');
  perform public.community_channel_perms_set(ch_voice,r_team,'{"connect":"allow"}');
  perform public.community_channel_perms_set(ch_voice,r_listen,'{"connect":"allow","speak":"deny"}');
  v:=public.community_channel_perms_get(ch_embed);
  perform pg_temp.com_assert(v#>>'{everyone,embeds}'='false' and v#>>'{everyone,write}'='true' and jsonb_array_length(v->'roles')=3
    and (select x->'perms'->>'embeds' from jsonb_array_elements(v->'roles')x where x->>'roleId'=r_team::text)='allow'
    and v->'applies'='["view","write","embeds","react"]'::jsonb,'configuración de permisos legible para editar');
  perform pg_temp.com_assert(public.community_channel_perms_get(ch_voice)->'applies'='["view","connect","speak"]'::jsonb,'la voz solo tiene ver, entrar y hablar');
  -- Validaciones: todo o nada, solo permisos que tienen sentido en ese tipo de canal.
  perform pg_temp.com_expect(format('select public.community_channel_perms_set(%L,null,%L)',ch_voice,'{"write":false}'),'22023','bad_permission','la voz no tiene escribir');
  perform pg_temp.com_expect(format('select public.community_channel_perms_set(%L,null,%L)',ch_embed,'{"connect":false}'),'22023','bad_permission','el texto no tiene entrar');
  perform pg_temp.com_expect(format('select public.community_channel_perms_set(%L,null,%L)',ch_embed,'{"admin":true}'),'22023','bad_permission','permiso desconocido');
  perform pg_temp.com_expect(format('select public.community_channel_perms_set(%L,null,%L)',ch_embed,'{"react":"allow"}'),'22023','bad_permission','todos usa booleanos');
  perform pg_temp.com_expect(format('select public.community_channel_perms_set(%L,%L,%L)',ch_embed,r_team,'{"react":"maybe"}'),'22023','bad_permission','un rol usa allow, deny o inherit');
  perform pg_temp.com_expect(format('select public.community_channel_perms_set(%L,null,%L)',ch_ann,'{"write":true}'),'22023','bad_posting_role','anuncios siguen siendo del equipo para todos');
  perform pg_temp.com_expect(format('select public.community_channel_perms_set(%L,%L,%L)',ch_embed,r_foreign,'{"react":"allow"}'),'22023','bad_role','no usa roles de otra comunidad');
  perform pg_temp.com_expect(format('select public.community_channel_perms_set(%L,null,%L)',ch_embed,'{"react":false,"bogus":true}'),'22023','bad_permission','cambio inválido se revierte entero');
  perform pg_temp.com_assert(public.community_channel_perms_get(ch_embed)#>>'{everyone,react}'='true','el cambio inválido no dejó nada a medias');
  execute 'reset role';
  perform pg_temp.com_login(bob);
  perform pg_temp.com_expect(format('select public.community_channel_perms_set(%L,null,%L)',ch_embed,'{"embeds":true}'),'42501','forbidden','miembro no edita permisos');
  perform pg_temp.com_expect(format('select public.community_channel_perms_get(%L)',ch_embed),'42501','forbidden','miembro no lee la configuración');
  perform pg_temp.com_expect(format('select public.community_perms_explain(%L)',ch_embed),'42501','forbidden','miembro no pide la vista de permisos');
  execute 'reset role';

  -- Una cuenta sin roles propios (bob): ve, escribe y reacciona según lo que concede el canal.
  perform pg_temp.com_login(bob);
  v:=public.community_get(cid);
  perform pg_temp.com_assert(not exists(select 1 from jsonb_array_elements(v->'channels')x where x->>'id'=ch_priv::text),'canal privado invisible sin rol');
  perform pg_temp.com_assert(exists(select 1 from jsonb_array_elements(v->'channels')x where x->>'id'=ch_read::text and x->>'canPost'='false' and x#>>'{can,write}'='false'),'solo lectura sin rol');
  perform pg_temp.com_assert(exists(select 1 from jsonb_array_elements(v->'channels')x where x->>'id'=ch_embed::text and x->>'canPost'='true' and x->>'canEmbed'='false'),'medios: escribe pero sin enlaces ni GIFs');
  perform pg_temp.com_assert(exists(select 1 from jsonb_array_elements(v->'channels')x where x->>'id'=ch_react::text and x->>'canReact'='false'),'muro: sin reaccionar');
  perform pg_temp.com_assert(exists(select 1 from jsonb_array_elements(v->'channels')x where x->>'id'=ch_voice::text and x->>'canConnect'='false'),'sala: sin entrar');
  perform pg_temp.com_expect(format('select public.community_messages_page(%L)',ch_priv),'42501','forbidden','historial privado cerrado por la RPC');
  perform pg_temp.com_expect(format('select public.community_send(%L,%L)',ch_priv,'hola'),'42501','forbidden','escribir en privado cerrado por la RPC');
  perform pg_temp.com_expect(format('select public.community_send(%L,%L)',ch_read,'hola'),'42501','forbidden','escribir en solo lectura cerrado');
  perform pg_temp.com_assert(public.community_send(ch_embed,'solo texto')->>'body'='solo texto','texto simple permitido sin el permiso de enlaces');
  perform pg_temp.com_expect(format('select public.community_send(%L,%L)',ch_embed,'mirá https://example.com'),'42501','embeds_forbidden','enlace https sin permiso');
  perform pg_temp.com_expect(format('select public.community_send(%L,%L)',ch_embed,'mirá www.example.com'),'42501','embeds_forbidden','enlace www sin permiso');
  perform pg_temp.com_expect(format('select public.community_send(%L,%L)',ch_embed,'entrá a discord.gg/abc'),'42501','embeds_forbidden','invitación de Discord sin permiso');
  perform pg_temp.com_expect(format('select public.community_send_media(%L,%L)',ch_embed,klipy),'42501','embeds_forbidden','GIF de KLIPY sin permiso');
  perform pg_temp.com_expect(format('select public.community_send_media(%L,%L)',ch_embed,'{"kind":"klipy","url":"https://evil.example/x.gif"}'::jsonb),'42501','embeds_forbidden','el permiso se revisa antes que la URL');
  perform pg_temp.com_expect(format('select public.community_voice_room(%L)',ch_voice),'42501','voice_forbidden','entrar a la voz sin permiso');
  perform pg_temp.com_assert(pg_temp.com_count(format('select count(*) from public.community_messages where channel_id=%L',ch_priv))=0,'RLS no entrega el canal privado sin rol');
  -- Intentos de saltear las reglas desde las tablas.
  perform pg_temp.com_expect(format('insert into public.community_messages(community_id,channel_id,author,body) values(%L,%L,%L,%L)',cid,ch_read,bob,'directo'),'42501',null,'tabla de mensajes sin INSERT');
  perform pg_temp.com_expect(format('update public.community_channels set is_private=false where id=%L',ch_priv),'42501',null,'tabla de canales sin UPDATE');
  perform pg_temp.com_expect('select * from public.community_channel_perms','42501',null,'permisos por rol sin acceso directo');
  perform pg_temp.com_expect('select * from public.community_roles','42501',null,'roles sin acceso directo');
  perform pg_temp.com_expect(format('insert into public.community_member_roles(community_id,user_id,role_id) values(%L,%L,%L)',cid,bob,r_team),'42501',null,'asignaciones sin INSERT directo');
  perform pg_temp.com_expect(format('insert into public.community_reactions(message_id,user_id,emoji) values(%L,%L,%L)',gen_random_uuid(),bob,'like'),'42501',null,'reacciones sin INSERT directo');
  perform pg_temp.com_expect('select * from public.community_greetings','42501',null,'mensajes automáticos sin acceso directo');
  perform pg_temp.com_expect('select * from public.community_media','42501',null,'GIFs subidos sin acceso directo');
  execute 'reset role';
  -- Todavía hay un mensaje para reaccionar en "muro".
  msg:=(pg_temp.com_post(ch_react,own,'primer mensaje del muro')->>'id')::uuid;
  perform pg_temp.com_login(bob);
  perform pg_temp.com_expect(format('select public.community_react(%L,%L)',msg,'like'),'42501','react_forbidden','reaccionar sin permiso');
  perform public.community_react(msg,'like',false);
  execute 'reset role';

  -- Con el rol Equipo (alice) el panorama cambia canal por canal.
  perform pg_temp.com_login(alice);
  v:=public.community_get(cid);
  perform pg_temp.com_assert(exists(select 1 from jsonb_array_elements(v->'channels')x where x->>'id'=ch_priv::text),'el rol Equipo ve el canal privado');
  perform pg_temp.com_assert(public.community_send(ch_priv,'hola equipo')->>'body'='hola equipo','el rol Equipo escribe en el privado');
  perform pg_temp.com_assert(pg_temp.com_count(format('select count(*) from public.community_messages where channel_id=%L',ch_priv))=1,'RLS entrega el canal privado al rol Equipo');
  perform pg_temp.com_assert(public.community_send(ch_embed,'mirá https://example.com/guia')->>'body' like '%guia','el rol Equipo manda enlaces');
  perform pg_temp.com_assert(public.community_send_media(ch_embed,klipy,'un gato')->'media'->>'kind'='klipy','el rol Equipo manda GIFs de KLIPY');
  perform pg_temp.com_assert(jsonb_array_length(public.community_react(msg,'like')->'reactions')=1,'el rol Equipo reacciona en el muro');
  perform pg_temp.com_expect(format('select public.community_send(%L,%L)',ch_read,'sigo sin poder'),'42501','forbidden','el rol Equipo no escribe en solo lectura');
  execute 'reset role';

  -- Dependencias: sin "escribir" no hay enlaces aunque el rol los permita; el rol Redactores sí escribe en solo lectura.
  perform pg_temp.com_login(own);
  perform public.community_channel_perms_set(ch_embed,r_team,'{"write":"deny"}');
  w:=public.community_perms_explain(ch_embed,r_team::text);
  perform pg_temp.com_assert((select x->>'source' from jsonb_array_elements(w->'perms')x where x->>'perm'='embeds')='needs_write'
    and (select x->>'allowed' from jsonb_array_elements(w->'perms')x where x->>'perm'='embeds')='false','enlaces necesitan escribir (explicado)');
  execute 'reset role';
  perform pg_temp.com_login(alice);
  perform pg_temp.com_expect(format('select public.community_send_media(%L,%L)',ch_embed,klipy),'42501','forbidden','denegar escribir quita también los GIFs');
  execute 'reset role';
  perform pg_temp.com_login(own);
  perform public.community_channel_perms_set(ch_embed,r_team,'{"write":"inherit"}');
  execute 'reset role';
  perform pg_temp.com_login(own);
  perform public.community_role_assign(cid,bob,r_writer);
  execute 'reset role';
  perform pg_temp.com_login(bob);
  perform pg_temp.com_assert(public.community_send(ch_read,'redactor escribe')->>'body'='redactor escribe','rol Redactores escribe en solo lectura');
  perform pg_temp.com_expect(format('select public.community_send(%L,%L)',ch_ann,'anuncio'),'42501','forbidden','Redactores sin permiso en anuncios');
  execute 'reset role';
  perform pg_temp.com_login(own);
  perform public.community_role_assign(cid,bob,r_writer,false);
  execute 'reset role';

  -- Voz: entrar y hablar.
  perform pg_temp.com_login(alice);
  v:=public.community_voice_room(ch_voice); room:=(v->>'roomId')::uuid; code:=v->>'code';
  perform pg_temp.com_assert((v->>'canSpeak')::boolean,'rol Equipo puede hablar');
  perform pg_temp.com_assert(public.voice_join(code,null,'session-alice-0001','key-alice-public') ? 'room','rol Equipo entra a la sala');
  execute 'reset role';
  perform pg_temp.com_login(carl);
  v:=public.community_voice_room(ch_voice);
  perform pg_temp.com_assert(not (v->>'canSpeak')::boolean,'rol Oyentes no puede hablar');
  perform pg_temp.com_assert(public.voice_join(code,null,'session-carl-0001','key-carl-public') ? 'room','rol Oyentes entra a la sala');
  keys:=public.voice_member_keys(room);
  perform pg_temp.com_assert(exists(select 1 from jsonb_array_elements(keys->'members')k where k->>'user_id'=alice::text)
    and not exists(select 1 from jsonb_array_elements(keys->'members')k where k->>'user_id'=carl::text),'el servidor no entrega la clave de quien no puede hablar');
  execute 'reset role';
  perform pg_temp.com_login(alice);
  keys:=public.voice_member_keys(room);
  perform pg_temp.com_assert(not exists(select 1 from jsonb_array_elements(keys->'members')k where k->>'user_id'=carl::text),'los demás tampoco reciben la clave de quien no habla');
  execute 'reset role';
  perform pg_temp.com_login(bob);
  perform pg_temp.com_assert(public.voice_join(code,null,'session-bob-00001','key-bob-public')->>'error'='not_found','sin permiso de entrar, el código no sirve');
  perform pg_temp.com_assert(public.voice_room_by_code(code)->>'error'='not_found','la sala no existe para quien no puede entrar');
  perform pg_temp.com_assert(public.voice_member_keys(room)->>'error'='not_member','sin claves de sesión para quien no puede entrar');
  execute 'reset role';
  perform pg_temp.com_login(modu);
  v:=public.community_voice_room(ch_voice);
  perform pg_temp.com_assert((v->>'canSpeak')::boolean and public.voice_join(code,null,'session-mod-000001','key-mod-public') ? 'room','el moderador entra y habla sin reglas');
  execute 'reset role';
  -- Quitar el rol revoca la admisión y la sesión ya abiertas.
  perform pg_temp.com_login(modu);
  perform public.community_role_assign(cid,alice,r_team,false);
  execute 'reset role';
  perform pg_temp.com_assert(not exists(select 1 from public.voice_members where room_id=room and user_id=alice),'quitar el rol revoca la admisión de voz');
  perform pg_temp.com_login(alice);
  perform pg_temp.com_assert(public.voice_heartbeat(room,'session-alice-0001')->>'error'='gone','el latido de la sesión retirada termina');
  perform pg_temp.com_assert(not exists(select 1 from jsonb_array_elements(public.community_get(cid)->'channels')x where x->>'id'=ch_priv::text),'sin el rol deja de ver el canal privado');
  perform pg_temp.com_assert(pg_temp.com_count(format('select count(*) from public.community_messages where channel_id=%L',ch_priv))=0,'sin el rol RLS deja de entregar el privado');
  execute 'reset role';
  perform pg_temp.com_login(modu);
  perform public.community_role_assign(cid,alice,r_team);
  execute 'reset role';

  -- Moderador y dueño saltean todas las reglas.
  execute 'reset role';
  foreach usr in array array[modu,own] loop
    perform pg_temp.com_assert((pg_temp.com_can(cid,usr,ch_priv)->'can'->>'view')::boolean,'staff ve el canal privado '||usr::text);
    perform pg_temp.com_assert((pg_temp.com_can(cid,usr,ch_read)->>'canPost')::boolean,'staff escribe en solo lectura '||usr::text);
    perform pg_temp.com_assert((pg_temp.com_can(cid,usr,ch_embed)->>'canEmbed')::boolean,'staff manda enlaces sin permiso '||usr::text);
    perform pg_temp.com_assert((pg_temp.com_can(cid,usr,ch_react)->>'canReact')::boolean,'staff reacciona sin permiso '||usr::text);
    perform pg_temp.com_assert((pg_temp.com_can(cid,usr,ch_voice)->>'canConnect')::boolean and (pg_temp.com_can(cid,usr,ch_voice)->>'canSpeak')::boolean,'staff entra y habla '||usr::text);
  end loop;
  perform pg_temp.com_login(own);
  perform pg_temp.com_assert(not exists(select 1 from jsonb_array_elements(public.community_perms_explain(ch_priv,'moderator')->'perms')x
    where x->>'perm' in ('view','write','embeds','react') and (x->>'source'<>'staff' or x->>'allowed'<>'true')),'explicación del moderador: todo por ser equipo');
  execute 'reset role';

  -- La vista "qué puede hacer este rol aquí" coincide con lo que la cuenta ve de verdad.
  foreach subj in array array['everyone',r_team::text,r_listen::text] loop
    usr:=case subj when 'everyone' then bob when r_team::text then alice else carl end;
    foreach chn in array array[ch_read,ch_priv,ch_embed,ch_react,ch_voice,ch_ann,ch_plain] loop
      perform pg_temp.com_login(own);
      w:=public.community_perms_explain(chn,subj);
      execute 'reset role';
      actual:=pg_temp.com_can(cid,usr,chn);
      for elem in select e from jsonb_array_elements(w->'perms')e loop
        perform pg_temp.com_assert((elem->>'allowed')::boolean = coalesce((actual->'can'->>(elem->>'perm'))::boolean,false),
          'explicación coincide '||subj||' '||chn::text||' '||(elem->>'perm'));
      end loop;
    end loop;
  end loop;

  -- Roles y reglas ajenos a la comunidad no se cruzan, tampoco por la tabla.
  perform pg_temp.com_assert((select count(*)=0 from (select 1) s where exists(select 1 from public.community_channel_perms where community_id<>cid and channel_id=ch_embed)),
    'permisos no apuntan a otra comunidad');
  perform pg_temp.com_expect(format('insert into public.community_channel_perms(channel_id,role_id,community_id,perm,mode) values(%L,%L,%L,%L,%L)',
    ch_embed,r_foreign,cid,'react','allow'),'23503',null,'integridad: rol de otra comunidad en un canal');
  perform pg_temp.com_expect(format('insert into public.community_member_roles(community_id,user_id,role_id) values(%L,%L,%L)',cid,bob,r_foreign),'23503',null,'integridad: asignar un rol ajeno');

  -- Topes: 15 roles por comunidad, 5 por cuenta.
  perform pg_temp.com_login(own);
  select count(*) into n from jsonb_array_elements(public.community_get(cid)->'roles');
  for i in n+1..15 loop r_extra:=r_extra||(public.community_role_save(cid,'Rol extra '||i)->>'id')::uuid; end loop;
  perform pg_temp.com_expect(format('select public.community_role_save(%L,%L)',cid,'Rol 16'),'22023','too_many_roles','tope de quince roles');
  for i in 1..5 loop perform public.community_role_assign(cid,bob,r_extra[i]); end loop;
  perform pg_temp.com_expect(format('select public.community_role_assign(%L,%L,%L)',cid,bob,r_extra[6]),'22023','too_many_member_roles','tope de cinco roles por cuenta');
  perform public.community_role_delete(r_extra[1]);
  perform pg_temp.com_assert(not exists(select 1 from jsonb_array_elements(public.community_members_list(cid)->'members')m
    where m->>'userId'=bob::text and m->'roleIds' @> to_jsonb(r_extra[1]::text)),'borrar un rol lo quita de quien lo tenía');
  execute 'reset role';

  -- Borrar un rol limpia sus excepciones; expulsar quita los roles y no vuelven.
  perform pg_temp.com_login(own);
  perform public.community_role_delete(r_team);
  execute 'reset role';
  perform pg_temp.com_assert(not exists(select 1 from public.community_channel_perms where role_id=r_team),'borrar un rol limpia sus permisos por canal');
  perform pg_temp.com_assert(not exists(select 1 from public.community_member_roles where role_id=r_team),'borrar un rol limpia sus asignaciones');
  perform pg_temp.com_login(own);
  perform public.community_kick(cid,carl);
  execute 'reset role';
  perform pg_temp.com_assert(not exists(select 1 from public.community_member_roles where community_id=cid and user_id=carl),'expulsar quita los roles propios');
  perform pg_temp.com_assert(not exists(select 1 from public.voice_members where room_id=room and user_id=carl and not banned),'expulsar saca de la sala');
  perform pg_temp.com_login(own);
  perform public.community_unban(cid,carl);
  execute 'reset role';
  perform pg_temp.com_login(carl);
  perform public.community_join(cid);
  perform pg_temp.com_assert(public.community_get(cid)->'myRoleIds'='[]'::jsonb,'volver a entrar no devuelve los roles');
  execute 'reset role';

  -- Bloqueo del dueño y baneo global cortan todos los permisos.
  insert into public.friendships(requester,addressee,status) values(own,bob,'blocked');
  perform pg_temp.com_assert(not private.community_perm(ch_plain,bob,'view') and not private.community_perm(ch_plain,bob,'write'),'bloqueo del dueño quita todos los permisos');
  delete from public.friendships where requester=own and addressee=bob;
  update auth.users set banned_until=now()+interval '1 day' where id=carl;
  perform pg_temp.com_assert(not private.community_perm(ch_plain,carl,'view'),'baneo global quita todos los permisos');
  update auth.users set banned_until=null where id=carl;
  perform pg_temp.com_assert(private.community_perm(ch_plain,carl,'write') and not private.community_perm(ch_plain,eve,'view'),'quien no es miembro nunca tiene permisos');
end $perms$;

-- ---------- Reacciones ----------
DO $react$
declare own uuid; a uuid; b uuid; c uuid; d uuid; e uuid; d2 uuid; cid uuid; ch uuid; ch_off uuid; msg uuid; gone uuid; v jsonb; i integer;
  nonce text:=substr(replace(gen_random_uuid()::text,'-',''),1,8);
begin
  own:=pg_temp.com_user('Dueña'); a:=pg_temp.com_user('Ana'); b:=pg_temp.com_user('Beto'); c:=pg_temp.com_user('Cora'); d:=pg_temp.com_user('Dani');
  perform pg_temp.com_login(own);
  cid:=(public.community_create('Reacciones '||nonce)->>'id')::uuid;
  execute 'reset role';
  e:=pg_temp.com_user('Eli');
  foreach d2 in array array[a,b,c,d,e] loop
    perform pg_temp.com_login(d2); perform public.community_join(cid); execute 'reset role';
  end loop;
  perform pg_temp.com_login(own);
  select (x->>'id')::uuid into ch from jsonb_array_elements(public.community_get(cid)->'channels')x where x->>'kind'='text';
  execute 'reset role';
  msg:=(pg_temp.com_post(ch,b,'mensaje para reaccionar')->>'id')::uuid;
  perform pg_temp.com_login(a);
  v:=public.community_react(msg,'like');
  perform pg_temp.com_assert(v->'reactions'->0->>'emoji'='like' and v->'reactions'->0->>'count'='1' and v->'reactions'->0->>'mine'='true','reacción propia contada');
  perform pg_temp.com_assert(public.community_react(msg,'like')->'reactions'->0->>'count'='1','reaccionar dos veces lo mismo no duplica');
  execute 'reset role';
  perform pg_temp.com_login(c);
  v:=public.community_react(msg,'like');
  perform pg_temp.com_assert(v->'reactions'->0->>'count'='2','dos cuentas, dos reacciones');
  execute 'reset role';
  perform pg_temp.com_login(b);
  v:=public.community_messages_page(ch);
  perform pg_temp.com_assert(v->0->'reactions'->0->>'count'='2' and v->0->'reactions'->0->>'mine'='false','el historial trae las reacciones');
  perform pg_temp.com_expect(format('select public.community_react(%L,%L)',msg,'poop'),'22023','bad_emoji','solo las ocho reacciones fijas');
  execute 'reset role';
  -- Cinco distintas por cuenta y mensaje.
  perform pg_temp.com_login(d);
  perform public.community_react(msg,'love'); perform public.community_react(msg,'laugh'); perform public.community_react(msg,'wow');
  perform public.community_react(msg,'sad'); perform public.community_react(msg,'party');
  perform pg_temp.com_expect(format('select public.community_react(%L,%L)',msg,'fire'),'22023','too_many_reactions','tope de cinco reacciones por cuenta y mensaje');
  perform pg_temp.com_assert(jsonb_array_length(public.community_react(msg,'party',false)->'reactions')=5,'quitar la propia reacción');
  execute 'reset role';
  -- Quien bloqueaste no cuenta en lo que ves.
  insert into public.friendships(requester,addressee,status) values(b,c,'blocked');
  perform pg_temp.com_login(b);
  perform pg_temp.com_assert((select (x->>'count')::int from jsonb_array_elements(public.community_messages_page(ch)->0->'reactions')x where x->>'emoji'='like')=1,
    'las reacciones de quien bloqueaste no se cuentan');
  execute 'reset role';
  delete from public.friendships where requester=b and addressee=c;
  -- Silenciado en la comunidad: no agrega, pero puede quitar.
  perform pg_temp.com_login(own); perform public.community_mute(cid,a,60); execute 'reset role';
  perform pg_temp.com_login(a);
  perform pg_temp.com_expect(format('select public.community_react(%L,%L)',msg,'fire'),'42501','react_forbidden','silenciado no reacciona');
  perform pg_temp.com_assert(public.community_react(msg,'like',false)->'reactions'->0->>'count'='1','silenciado igual puede quitar la suya');
  execute 'reset role';
  perform pg_temp.com_login(own); perform public.community_mute(cid,a,0); execute 'reset role';
  -- Permiso por canal "reaccionar" y mensajes borrados.
  perform pg_temp.com_login(own);
  ch_off:=(public.community_channel_create_configured(cid,'text','sin reacciones','{}')->>'id')::uuid;
  perform public.community_channel_perms_set(ch_off,null,'{"react":false}');
  execute 'reset role';
  gone:=(pg_temp.com_post(ch_off,own,'mensaje del equipo')->>'id')::uuid;
  perform pg_temp.com_login(a);
  perform pg_temp.com_expect(format('select public.community_react(%L,%L)',gone,'like'),'42501','react_forbidden','canal sin reacciones');
  execute 'reset role';
  perform pg_temp.com_login(own);
  perform pg_temp.com_assert(public.community_react(gone,'like')->'reactions'->0->>'count'='1','el equipo reacciona donde los demás no');
  perform public.community_message_delete(msg);
  perform pg_temp.com_expect(format('select public.community_react(%L,%L)',msg,'like'),'22023','not_found','no se reacciona a un mensaje borrado');
  execute 'reset role';
  perform pg_temp.com_assert((select count(*) from public.community_reactions where message_id=msg)>=0 and (select media is null from public.community_messages where id=msg),'mensaje borrado sin GIF');
  -- 60 por minuto.
  perform pg_temp.com_login(own);
  v:=public.community_send(ch,'mensaje para el tope');
  msg:=(v->>'id')::uuid;
  execute 'reset role';
  perform pg_temp.com_login(e);
  for i in 1..60 loop
    perform public.community_react(msg,'fire'); perform public.community_react(msg,'fire',false);
  end loop;
  perform pg_temp.com_expect(format('select public.community_react(%L,%L)',msg,'fire'),'PT429','rate_limited','tope de sesenta reacciones por minuto');
  execute 'reset role';
end $react$;

-- ---------- GIFs subidos con aprobación, KLIPY, denuncias y cola de Venus ----------
-- Cuenta filas visibles para esa cuenta (RLS incluido). Se llama sin rol puesto.
CREATE FUNCTION pg_temp.com_sel(who uuid,q text) RETURNS bigint LANGUAGE plpgsql AS $f$
declare n bigint;
begin
  perform pg_temp.com_login(who);
  execute q into n;
  execute 'reset role';
  return n;
end $f$;
CREATE FUNCTION pg_temp.com_page(ch uuid,who uuid) RETURNS jsonb LANGUAGE plpgsql AS $f$
declare r jsonb;
begin
  perform pg_temp.com_login(who);
  r:=public.community_messages_page(ch);
  execute 'reset role';
  return r;
end $f$;
CREATE FUNCTION pg_temp.com_file(cid uuid,mid uuid,who uuid,ext text default 'gif',bytes bigint default 2048,mime text default 'image/gif') RETURNS void LANGUAGE plpgsql AS $f$
begin
  perform pg_temp.com_login(who);
  insert into storage.objects(bucket_id,name,owner,metadata) values('community-media',cid::text||'/'||mid::text||'.'||ext,who,
    jsonb_build_object('size',bytes,'mimetype',mime));
  execute 'reset role';
end $f$;

DO $media$
declare
  own uuid; modu uuid; bob uuid; eve uuid; adm uuid; owner2 uuid; j1 uuid; j2 uuid;
  cid uuid; ocid uuid; ch uuid; och uuid; v jsonb; w jsonb; n integer; i integer; path1 text; msg uuid; rep uuid; pend uuid[];
  m1 uuid:=gen_random_uuid(); m2 uuid:=gen_random_uuid(); m3 uuid:=gen_random_uuid(); m4 uuid:=gen_random_uuid(); m5 uuid:=gen_random_uuid();
  m6 uuid:=gen_random_uuid(); m7 uuid:=gen_random_uuid(); mx uuid:=gen_random_uuid(); mo uuid:=gen_random_uuid(); bad_id uuid:=gen_random_uuid();
  nonce text:=substr(replace(gen_random_uuid()::text,'-',''),1,8);
  klipy jsonb:='{"kind":"klipy","url":"https://static.klipy.com/ii/abc123/def456.gif","still":"https://static2.klipy.com/ii/abc123/def456.jpg","slug":"gato_feliz-1"}';
begin
  own:=pg_temp.com_user('Dueña'); modu:=pg_temp.com_user('Moderador'); bob:=pg_temp.com_user('Beto'); eve:=pg_temp.com_user('Eva');
  adm:=pg_temp.com_user('Admin Venus'); owner2:=pg_temp.com_user('Otra dueña'); j1:=pg_temp.com_user('Juan'); j2:=pg_temp.com_user('Julia');
  insert into public.app_admin_emails(email) select lower(email) from auth.users where id=adm on conflict do nothing;
  insert into public.app_admins(user_id,email) select id,lower(email) from auth.users where id=adm on conflict do nothing;
  perform pg_temp.com_assert(exists(select 1 from public.app_admins where user_id=adm),'administrador de prueba registrado');
  perform pg_temp.com_login(owner2);
  ocid:=(public.community_create('Medios ajenos '||nonce)->>'id')::uuid;
  execute 'reset role';
  perform pg_temp.com_login(own);
  cid:=(public.community_create('Medios '||nonce)->>'id')::uuid;
  select (x->>'id')::uuid into ch from jsonb_array_elements(public.community_get(cid)->'channels')x where x->>'kind'='text';
  execute 'reset role';
  perform pg_temp.com_login(modu); perform public.community_join(cid); execute 'reset role';
  perform pg_temp.com_login(bob); perform public.community_join(cid); execute 'reset role';
  perform pg_temp.com_login(own); perform public.community_set_role(cid,modu,'moderator'); execute 'reset role';
  perform pg_temp.com_login(owner2);
  select (x->>'id')::uuid into och from jsonb_array_elements(public.community_get(ocid)->'channels')x where x->>'kind'='text';
  execute 'reset role';

  -- Subir: solo el equipo de esa comunidad, con nombre de archivo válido.
  perform pg_temp.com_login(bob);
  perform pg_temp.com_expect(format('insert into storage.objects(bucket_id,name,owner,metadata) values(%L,%L,%L,%L)','community-media',cid||'/'||gen_random_uuid()||'.gif',bob,'{}'),
    '42501',null,'un miembro común no sube GIFs');
  execute 'reset role';
  perform pg_temp.com_login(eve);
  perform pg_temp.com_expect(format('insert into storage.objects(bucket_id,name,owner,metadata) values(%L,%L,%L,%L)','community-media',cid||'/'||gen_random_uuid()||'.gif',eve,'{}'),
    '42501',null,'quien no es miembro no sube GIFs');
  execute 'reset role';
  perform pg_temp.com_login(owner2);
  perform pg_temp.com_expect(format('insert into storage.objects(bucket_id,name,owner,metadata) values(%L,%L,%L,%L)','community-media',cid||'/'||gen_random_uuid()||'.gif',owner2,'{}'),
    '42501',null,'el dueño de otra comunidad no sube a esta carpeta');
  execute 'reset role';
  perform pg_temp.com_login(modu);
  perform pg_temp.com_expect(format('insert into storage.objects(bucket_id,name,owner,metadata) values(%L,%L,%L,%L)','community-media',cid||'/nombre-libre.gif',modu,'{}'),
    '42501',null,'el nombre del archivo debe ser <comunidad>/<id>.<ext>');
  perform pg_temp.com_expect(format('insert into storage.objects(bucket_id,name,owner,metadata) values(%L,%L,%L,%L)','community-media',cid||'/'||gen_random_uuid()||'.exe',modu,'{}'),
    '42501',null,'solo gif, webp o png');
  execute 'reset role';
  perform pg_temp.com_file(cid,m1,modu);
  perform pg_temp.com_file(cid,mo,own);
  perform pg_temp.com_assert(exists(select 1 from storage.objects where bucket_id='community-media' and name=cid||'/'||m1||'.gif'),'el equipo sube su GIF');

  -- Registrar: tamaño y tipo salen de Storage; dimensiones acotadas.
  perform pg_temp.com_login(modu);
  perform pg_temp.com_expect(format('select public.community_media_register(%L,%L,%L,8,100)',m1,cid,'Gato'),'22023','bad_dimensions','dimensiones mínimas');
  perform pg_temp.com_expect(format('select public.community_media_register(%L,%L,%L,100,2000)',m1,cid,'Gato'),'22023','bad_dimensions','dimensiones máximas');
  perform pg_temp.com_expect(format('select public.community_media_register(%L,%L,%L,100,100)',m1,cid,'   '),'22023','bad_media_name','nombre obligatorio');
  perform pg_temp.com_expect(format('select public.community_media_register(%L,%L,%L,100,100)',bad_id,cid,'Fantasma'),'22023','no_file','archivo inexistente');
  execute 'reset role';
  perform pg_temp.com_file(cid,m2,modu,'gif',2048,'image/png');
  perform pg_temp.com_file(cid,m3,modu,'gif',3000000,'image/gif');
  perform pg_temp.com_login(modu);
  perform pg_temp.com_expect(format('select public.community_media_register(%L,%L,%L,100,100)',m2,cid,'Tipo'),'22023','bad_type','el tipo lo dice Storage, no el cliente');
  perform pg_temp.com_expect(format('select public.community_media_register(%L,%L,%L,100,100)',m3,cid,'Pesado'),'22023','too_big','más de 2 MB');
  execute 'reset role';
  perform pg_temp.com_login(eve);
  perform pg_temp.com_expect(format('select public.community_media_register(%L,%L,%L,100,100)',m1,cid,'Ajeno'),'42501','not_member','no miembro no registra');
  execute 'reset role';
  perform pg_temp.com_login(bob);
  perform pg_temp.com_expect(format('select public.community_media_register(%L,%L,%L,100,100)',m1,cid,'Ajeno'),'42501','forbidden','miembro común no registra');
  execute 'reset role';
  perform pg_temp.com_login(modu);
  v:=public.community_media_register(m1,cid,'Gato bailando',320,240); path1:=v->>'path';
  perform pg_temp.com_assert(v->>'status'='pending' and v->>'mine'='true' and path1=cid||'/'||m1||'.gif' and v->>'mime'='image/gif','el GIF registrado nace pendiente');
  perform pg_temp.com_expect(format('select public.community_media_register(%L,%L,%L,100,100)',m1,cid,'Repetido'),'22023','bad_id','id repetido');
  execute 'reset role';

  -- Pendiente: no lo ve nadie más que quien lo subió, el dueño y los administradores.
  perform pg_temp.com_login(bob);
  perform pg_temp.com_assert(not exists(select 1 from jsonb_array_elements(public.community_media_list(cid))x where x->>'id'=m1::text),'pendiente invisible en la lista de un miembro');
  perform pg_temp.com_assert(public.community_media_resolve(array[m1])='[]'::jsonb,'pendiente no se resuelve para un miembro');
  perform pg_temp.com_expect(format('select public.community_send_media(%L,%L)',ch,jsonb_build_object('kind','upload','id',m1)),'22023','bad_media','pendiente no se puede mandar al chat');
  execute 'reset role';
  perform pg_temp.com_assert(pg_temp.com_sel(bob,format('select count(*) from storage.objects where bucket_id=%L and name=%L','community-media',path1))=0,'pendiente: Storage no lo entrega a un miembro');
  perform pg_temp.com_assert(pg_temp.com_sel(eve,format('select count(*) from storage.objects where bucket_id=%L and name=%L','community-media',path1))=0,'pendiente: Storage no lo entrega a un extraño');
  perform pg_temp.com_assert(pg_temp.com_sel(owner2,format('select count(*) from storage.objects where bucket_id=%L and name=%L','community-media',path1))=0,'pendiente: Storage no lo entrega a otra comunidad');
  perform pg_temp.com_assert(pg_temp.com_sel(modu,format('select count(*) from storage.objects where bucket_id=%L and name=%L','community-media',path1))=1,'pendiente: lo ve quien lo subió');
  perform pg_temp.com_assert(pg_temp.com_sel(own,format('select count(*) from storage.objects where bucket_id=%L and name=%L','community-media',path1))=1,'pendiente: lo ve el dueño');
  perform pg_temp.com_assert(pg_temp.com_sel(adm,format('select count(*) from storage.objects where bucket_id=%L and name=%L','community-media',path1))=1,'pendiente: lo ve un administrador de Venus');
  perform pg_temp.com_login(own);
  perform pg_temp.com_assert((select x->>'status' from jsonb_array_elements(public.community_media_list(cid))x where x->>'id'=m1::text)='pending','el dueño ve el estado pendiente');
  execute 'reset role';
  perform pg_temp.com_login(modu);
  perform pg_temp.com_assert((select x->>'path' from jsonb_array_elements(public.community_media_list(cid))x where x->>'id'=m1::text)=path1,'quien lo subió ve su pendiente');
  execute 'reset role';

  -- Un GIF pendiente puede elegirse para la bienvenida, pero el mensaje sale sin él hasta que se apruebe.
  perform pg_temp.com_login(own);
  perform pg_temp.com_expect(format('select public.community_greeting_save(%L,%L,%L)',cid,'join',jsonb_build_object('media',jsonb_build_object('kind','upload','id',bad_id))),
    '22023','bad_media','la bienvenida no acepta un archivo inexistente');
  perform pg_temp.com_expect(format('select public.community_greeting_save(%L,%L,%L)',cid,'join',jsonb_build_object('media',jsonb_build_object('kind','upload','id',m1,'path','x'))),
    '22023','bad_media','la bienvenida no acepta claves de más');
  v:=public.community_greeting_save(cid,'join',jsonb_build_object('enabled',true,'channelId',ch,'body','Hola {usuario}',
    'media',jsonb_build_object('kind','upload','id',m1)));
  perform pg_temp.com_assert(v#>>'{join,mediaStatus}'='pending' and v#>>'{join,enabled}'='true','la bienvenida guarda el GIF pendiente y lo informa');
  execute 'reset role';
  perform pg_temp.com_login(j1); perform public.community_join(cid); execute 'reset role';
  perform pg_temp.com_assert((select count(*)=1 from jsonb_array_elements(pg_temp.com_page(ch,bob))x where x->>'system'='join' and x->'media'='null'),
    'con el GIF pendiente la bienvenida sale solo con texto');

  -- Cola de Venus: solo administradores; aprobar, rechazar y retirar dejan registro.
  perform pg_temp.com_login(bob);
  perform pg_temp.com_expect('select public.admin_community_media_queue()','42501','admin_only','un miembro no abre la cola');
  perform pg_temp.com_expect(format('select public.admin_community_media_review(%L,%L)',m1,'approve'),'42501','admin_only','un miembro no aprueba');
  execute 'reset role';
  perform pg_temp.com_login(modu);
  perform pg_temp.com_expect(format('select public.admin_community_media_review(%L,%L)',m1,'approve'),'42501','admin_only','el moderador de la comunidad tampoco aprueba');
  perform pg_temp.com_expect('select public.admin_community_media_queue()','42501','admin_only','ni abre la cola');
  execute 'reset role';
  perform pg_temp.com_login(adm);
  v:=public.admin_community_media_queue();
  perform pg_temp.com_assert((v->>'pending')::int>=1 and exists(select 1 from jsonb_array_elements(v->'items')x
    where x->>'id'=m1::text and x->>'community'='Medios '||nonce and x#>>'{uploadedBy,displayName}'='Moderador' and x->>'path'=path1 and x->>'width'='320'),
    'la cola muestra comunidad, autor, ruta y medidas');
  perform pg_temp.com_expect(format('select public.admin_community_media_review(%L,%L)',m1,'ban'),'22023','bad_decision','decisión desconocida');
  perform pg_temp.com_expect(format('select public.admin_community_media_review(%L,%L)',gen_random_uuid(),'approve'),'22023','not_found','el panel no revisa un archivo inexistente');
  perform pg_temp.com_expect(format('select public.admin_community_media_review(%L,%L)',m1,'reject'),'22023','reason_required','rechazar pide motivo');
  perform pg_temp.com_expect(format('select public.admin_community_media_review(%L,%L,%L)',m1,'reject','ab'),'22023','reason_required','motivo demasiado corto');
  perform pg_temp.com_expect(format('select public.admin_community_media_review(%L,%L,%L)',m1,'remove','Motivo largo'),'22023','bad_state','retirar exige uno aprobado');
  execute 'reset role';

  -- Más archivos para probar los topes y el rechazo.
  perform pg_temp.com_file(cid,m4,modu); perform pg_temp.com_file(cid,m5,modu); perform pg_temp.com_file(cid,m6,modu);
  perform pg_temp.com_login(modu);
  perform public.community_media_register(m4,cid,'Dos',100,100); perform public.community_media_register(m5,cid,'Tres',100,100);
  perform public.community_media_register(m6,cid,'Cuatro',100,100);
  v:=public.community_media_register(mo,cid,'Cinco',100,100);
  perform pg_temp.com_assert(v->>'status'='pending','quinto pendiente de la comunidad');
  execute 'reset role';
  perform pg_temp.com_file(cid,bad_id,own);
  perform pg_temp.com_login(own);
  perform pg_temp.com_expect(format('select public.community_media_register(%L,%L,%L,100,100)',bad_id,cid,'Sexto'),'22023','media_pending_limit','tope de cinco pendientes');
  execute 'reset role';

  perform pg_temp.com_login(adm);
  perform pg_temp.com_assert(public.admin_community_media_review(m1,'approve')->>'status'='approved','el administrador aprueba');
  perform pg_temp.com_expect(format('select public.admin_community_media_review(%L,%L)',m1,'approve'),'22023','bad_state','no se aprueba dos veces');
  perform pg_temp.com_assert(public.admin_community_media_review(m4,'reject','Contenido no apto para todo público')->>'status'='rejected','el administrador rechaza con motivo');
  perform pg_temp.com_expect(format('select public.admin_community_media_review(%L,%L)',m4,'approve'),'22023','bad_state','un rechazado no se aprueba después');
  perform pg_temp.com_assert(public.admin_community_media_review(m5,'approve')->>'status'='approved' and public.admin_community_media_review(m6,'approve')->>'status'='approved','aprueba otros dos');
  perform pg_temp.com_assert(public.admin_community_media_review(m5,'remove','Retirado por revisión')->>'status'='removed','retira uno aprobado con motivo');
  execute 'reset role';
  perform pg_temp.com_assert((select count(*)=1 from public.admin_actions where action='communityMedia.approve' and target_user=modu and details->>'media'=m1::text and admin_id=adm),
    'aprobar queda en admin_log');
  perform pg_temp.com_assert((select count(*)=1 from public.admin_actions where action='communityMedia.reject' and details->>'reason'='Contenido no apto para todo público'),
    'rechazar queda en admin_log con el motivo');
  perform pg_temp.com_assert((select count(*)=1 from public.admin_actions where action='communityMedia.remove' and details->>'media'=m5::text),'retirar queda en admin_log');

  -- Aprobado: lo ven los miembros (lista, Storage, chat) y no los extraños.
  perform pg_temp.com_login(bob);
  perform pg_temp.com_assert((select x->>'path' from jsonb_array_elements(public.community_media_list(cid))x where x->>'id'=m1::text)=path1,'aprobado visible en la lista de un miembro');
  perform pg_temp.com_assert(not exists(select 1 from jsonb_array_elements(public.community_media_list(cid))x where x->>'id' in (m4::text,m5::text)),'rechazado y retirado invisibles para un miembro');
  perform pg_temp.com_assert(jsonb_array_length(public.community_media_resolve(array[m1,m4,m5]))=1,'resolve entrega solo el aprobado');
  v:=public.community_send_media(ch,jsonb_build_object('kind','upload','id',m1),'mirá');
  msg:=(v->>'id')::uuid;
  perform pg_temp.com_assert(v#>>'{media,kind}'='upload' and v#>>'{media,path}'=path1 and v#>>'{media,name}'='Gato bailando','un miembro manda el GIF aprobado');
  perform pg_temp.com_assert(pg_temp.com_count(format('select count(*) from public.community_messages where id=%L and not (media ? %L)',msg,'path'))=1,'la fila de Realtime no lleva la ruta, solo el id');
  execute 'reset role';
  perform pg_temp.com_assert(pg_temp.com_sel(bob,format('select count(*) from storage.objects where bucket_id=%L and name=%L','community-media',path1))=1,'aprobado: Storage lo entrega a un miembro');
  perform pg_temp.com_assert(pg_temp.com_sel(eve,format('select count(*) from storage.objects where bucket_id=%L and name=%L','community-media',path1))=0,'aprobado: un extraño sigue sin verlo');
  perform pg_temp.com_assert(pg_temp.com_sel(owner2,format('select count(*) from storage.objects where bucket_id=%L and name=%L','community-media',path1))=0,'aprobado: otra comunidad tampoco');
  perform pg_temp.com_assert(pg_temp.com_sel(bob,format('select count(*) from storage.objects where bucket_id=%L and name=%L','community-media',cid||'/'||m4||'.gif'))=0,'rechazado: Storage no lo entrega a un miembro');
  perform pg_temp.com_assert(pg_temp.com_sel(modu,format('select count(*) from storage.objects where bucket_id=%L and name=%L','community-media',cid||'/'||m4||'.gif'))=1,'rechazado: lo ve quien lo subió');
  perform pg_temp.com_assert(pg_temp.com_sel(bob,format('select count(*) from storage.objects where bucket_id=%L and name=%L','community-media',cid||'/'||m5||'.gif'))=0,'retirado: Storage no lo entrega a un miembro');
  -- El dueño ve motivo y estado; quien subió, también; el resto no.
  perform pg_temp.com_login(own);
  perform pg_temp.com_assert((select x->>'rejectReason' from jsonb_array_elements(public.community_media_list(cid))x where x->>'id'=m4::text)='Contenido no apto para todo público','el dueño ve el motivo del rechazo');
  execute 'reset role';
  perform pg_temp.com_login(modu);
  perform pg_temp.com_assert((select x->>'status' from jsonb_array_elements(public.community_media_list(cid))x where x->>'id'=m4::text)='rejected','quien subió ve que lo rechazaron');
  execute 'reset role';
  -- La bienvenida ya usa el GIF aprobado.
  perform pg_temp.com_login(j2); perform public.community_join(cid); execute 'reset role';
  perform pg_temp.com_assert(exists(select 1 from jsonb_array_elements(pg_temp.com_page(ch,bob))x where x->>'system'='join' and x#>>'{media,id}'=m1::text and x#>>'{media,path}'=path1),
    'con el GIF aprobado la bienvenida lo lleva');

  -- Denuncias de un GIF ya aprobado.
  perform pg_temp.com_login(bob);
  perform pg_temp.com_assert(public.community_report('media',m1,'nsfw','no corresponde')->>'ok'='true','un miembro denuncia un GIF aprobado');
  perform pg_temp.com_assert(public.community_report('media',m1,'nsfw','otra vez')->>'ok'='true','la misma denuncia abierta no se duplica');
  perform pg_temp.com_expect(format('select public.community_report(%L,%L,%L)','media',m4,'nsfw'),'22023','not_found','un rechazado no se denuncia');
  execute 'reset role';
  perform pg_temp.com_assert((select count(*)=1 from public.group_reports where kind='media' and target_id=m1 and status='open' and snapshot->>'path'=path1 and target_user=modu),'denuncia guardada con copia del GIF');
  perform pg_temp.com_login(modu);
  perform pg_temp.com_expect(format('select public.community_report(%L,%L,%L)','media',m1,'spam'),'22023','bad_target','no se denuncia el propio');
  execute 'reset role';
  perform pg_temp.com_login(eve);
  perform pg_temp.com_expect(format('select public.community_report(%L,%L,%L)','media',m1,'spam'),'22023','not_found','un extraño no denuncia ni sabe que existe');
  execute 'reset role';
  perform pg_temp.com_login(adm);
  perform pg_temp.com_assert(exists(select 1 from jsonb_array_elements(public.admin_group_reports())x where x->>'kind'='media' and x->'snapshot'->>'path'=path1),'la cola de denuncias trae el GIF');
  perform pg_temp.com_assert((select (x->>'reports')::int from jsonb_array_elements(public.admin_community_media_queue('approved')->'items')x where x->>'id'=m1::text)=1,'la cola de aprobados cuenta la denuncia');
  rep:=(select (x->>'id')::uuid from jsonb_array_elements(public.admin_group_reports())x where x->>'kind'='media' and x->>'targetId'=m1::text);
  perform pg_temp.com_assert(public.admin_group_report_close(rep,true)->>'removed'='true','cerrar la denuncia retirando el GIF');
  execute 'reset role';
  perform pg_temp.com_assert((select status='removed' and reject_reason='report' from public.community_media where id=m1),'el GIF denunciado quedó retirado');
  perform pg_temp.com_assert((select count(*)=1 from public.admin_actions where action='groupReport.close' and details->>'kind'='media'),'cerrar la denuncia queda en admin_log');
  perform pg_temp.com_login(bob);
  perform pg_temp.com_assert((select x->'media'->>'unavailable' from jsonb_array_elements(public.community_messages_page(ch))x where x->>'id'=msg::text)='true','el mensaje con el GIF retirado ya no lo muestra');
  perform pg_temp.com_assert(not exists(select 1 from jsonb_array_elements(public.community_messages_page(ch))x where x#>>'{media,path}'=path1),'sin ruta del GIF retirado en los mensajes');
  execute 'reset role';
  perform pg_temp.com_assert(pg_temp.com_sel(bob,format('select count(*) from storage.objects where bucket_id=%L and name=%L','community-media',path1))=0,'retirado por denuncia: Storage deja de entregarlo');

  -- Borrar: quien lo subió o el dueño; lo demás no.
  perform pg_temp.com_login(bob);
  perform pg_temp.com_expect(format('select public.community_media_delete(%L)',m6),'42501','forbidden','un miembro no borra GIFs ajenos');
  execute 'reset role';
  perform pg_temp.com_login(modu);
  perform pg_temp.com_assert(public.community_media_delete(m4)->>'path'=cid||'/'||m4||'.gif','quien lo subió lo borra y recibe la ruta');
  execute 'reset role';
  perform pg_temp.com_login(own);
  perform pg_temp.com_assert(public.community_media_delete(m6)->>'ok'='true','el dueño borra GIFs ajenos');
  perform pg_temp.com_expect(format('select public.community_media_delete(%L)',m6),'22023','not_found','ya no existe');
  execute 'reset role';
  perform pg_temp.com_assert(pg_temp.com_sel(own,format('select count(*) from storage.objects where bucket_id=%L and name=%L','community-media',cid||'/'||m6||'.gif'))=1,
    'el archivo sigue en Storage hasta que el cliente lo borra');
  perform pg_temp.com_login(own);
  delete from storage.objects where bucket_id='community-media' and name=cid||'/'||m6||'.gif';
  perform pg_temp.com_assert(pg_temp.com_count(format('select count(*) from storage.objects where bucket_id=%L and name=%L','community-media',cid||'/'||m6||'.gif'))=0,'el dueño borra el archivo con su sesión');
  execute 'reset role';
  perform pg_temp.com_login(bob);
  delete from storage.objects where bucket_id='community-media' and name=cid||'/'||mo||'.gif';
  execute 'reset role';
  perform pg_temp.com_assert(exists(select 1 from storage.objects where bucket_id='community-media' and name=cid||'/'||mo||'.gif'),'un miembro no borra archivos ajenos de Storage');

  -- Tope de veinte entre pendientes y aprobados.
  for i in 1..20 loop
    insert into public.community_media(id,community_id,uploaded_by,name,path,mime,bytes,width,height,status)
      values(gen_random_uuid(),cid,own,'Relleno '||i,'relleno/'||nonce||'/'||i,'image/gif',10,32,32,'approved');
  end loop;
  perform pg_temp.com_file(cid,m7,modu);
  perform pg_temp.com_login(adm); perform public.admin_community_media_review(mo,'reject','Rechazado para liberar cupo'); execute 'reset role';
  perform pg_temp.com_login(modu);
  perform pg_temp.com_expect(format('select public.community_media_register(%L,%L,%L,100,100)',m7,cid,'Extra'),
    '22023','media_limit','tope de veinte GIFs por comunidad');
  execute 'reset role';
  delete from public.community_media where path like 'relleno/%';

  -- Un archivo aprobado de otra comunidad (mx) existe, pero no se usa desde esta.
  perform pg_temp.com_file(ocid,mx,owner2);
  perform pg_temp.com_login(owner2); perform public.community_media_register(mx,ocid,'Ajeno',64,64); execute 'reset role';
  perform pg_temp.com_login(adm); perform public.admin_community_media_review(mx,'approve'); execute 'reset role';

  -- KLIPY: mismas reglas de URL que los banners del perfil.
  perform pg_temp.com_login(bob);
  perform pg_temp.com_assert(public.community_send_media(ch,klipy)->'media'->>'slug'='gato_feliz-1' and public.community_send_media(ch,klipy)->>'body'='','GIF de KLIPY sin texto');
  perform pg_temp.com_expect(format('select public.community_send_media(%L,%L)',ch,'{"kind":"klipy","url":"https://evil.example/x.gif"}'::jsonb),'22023','bad_media','solo direcciones de KLIPY');
  perform pg_temp.com_expect(format('select public.community_send_media(%L,%L)',ch,'{"kind":"klipy","url":"http://static.klipy.com/a/b.gif"}'::jsonb),'22023','bad_media','solo https');
  perform pg_temp.com_expect(format('select public.community_send_media(%L,%L)',ch,'{"kind":"klipy"}'::jsonb),'22023','bad_media','sin dirección no hay GIF');
  perform pg_temp.com_expect(format('select public.community_send_media(%L,%L)',ch,'{"kind":"klipy","url":"https://static.klipy.com/a/b.gif","extra":1}'::jsonb),'22023','bad_media','sin claves de más');
  perform pg_temp.com_expect(format('select public.community_send_media(%L,%L)',ch,'{"kind":"klipy","url":"https://static.klipy.com/a/b.gif","slug":"con espacios"}'::jsonb),'22023','bad_media','slug validado');
  perform pg_temp.com_expect(format('select public.community_send_media(%L,%L)',ch,'{"kind":"klipy","url":"https://static.klipy.com/a/b.gif","still":"https://evil.example/s.jpg"}'::jsonb),'22023','bad_media','still validado');
  perform pg_temp.com_expect(format('select public.community_send_media(%L,%L)',ch,'"texto"'::jsonb),'22023','bad_media','el GIF es un objeto');
  perform pg_temp.com_expect(format('select public.community_send_media(%L,%L,%L)',ch,klipy,repeat('x',501)),'22023','bad_body','texto del GIF acotado');
  perform pg_temp.com_expect(format('select public.community_send_media(%L,%L)',och,klipy),'42501','not_member','no se manda a un canal de otra comunidad');
  perform pg_temp.com_expect(format('select public.community_send_media(%L,%L)',ch,jsonb_build_object('kind','upload','id',mx)),'22023','bad_media','un archivo aprobado de otra comunidad no sirve');
  v:=public.community_send_media(ch,klipy,'un gato');
  perform public.community_message_delete((v->>'id')::uuid);
  execute 'reset role';
  perform pg_temp.com_assert((select media is null and deleted from public.community_messages where id=(v->>'id')::uuid),'borrar el mensaje borra el GIF');
  -- Sin sesión nada de esto existe.
  perform pg_temp.com_login(null,'anon');
  perform pg_temp.com_expect(format('select public.community_media_list(%L)',cid),'42501',null,'anon no lista GIFs');
  perform pg_temp.com_expect('select * from public.community_media','42501',null,'anon no lee la tabla de GIFs');
  perform pg_temp.com_assert(pg_temp.com_count(format('select count(*) from storage.objects where bucket_id=%L','community-media'))=0,'anon no lee el bucket');
  execute 'reset role';
  -- Al borrar la comunidad se va todo registro suyo.
  perform pg_temp.com_login(own); perform public.community_delete(cid); execute 'reset role';
  perform pg_temp.com_assert(not exists(select 1 from public.community_media where community_id=cid)
    and not exists(select 1 from public.community_greetings where community_id=cid),'borrar la comunidad limpia GIFs y mensajes automáticos');
end $media$;

-- ---------- Mensajes de bienvenida y despedida ----------
DO $greet$
declare own uuid; modu uuid; u1 uuid; u2 uuid; u3 uuid; viewer uuid; eve uuid; cid uuid; ch uuid; ch2 uuid; ch_priv uuid; ch_voice uuid; ch_ann uuid; v jsonb; n integer;
  nm text; nonce text:=substr(replace(gen_random_uuid()::text,'-',''),1,8);
  klipy jsonb:='{"kind":"klipy","url":"https://static.klipy.com/ii/abc123/def456.gif"}';
begin
  own:=pg_temp.com_user('Dueña'); modu:=pg_temp.com_user('Moderador'); u1:=pg_temp.com_user('Ana'); u2:=pg_temp.com_user('Bruno'); u3:=pg_temp.com_user('Cata');
  viewer:=pg_temp.com_user('Lector'); eve:=pg_temp.com_user('Eva');
  nm:='Bienvenidas '||nonce;
  perform pg_temp.com_assert(private.community_greeting_render('Hola {usuario} en {Comunidad}, somos {MIEMBROS} ({user}/{community}/{members})','A{b}c\d&e','Co{x}',3)
    ='Hola Abc\d&e en Cox, somos 3 (Abc\d&e/Cox/3)','plantilla: variables en español e inglés, sin llaves ni barras colándose');
  perform pg_temp.com_assert(private.community_greeting_vars_ok('Hola {usuario} {comunidad} {miembros} {user} {community} {members}')
    and not private.community_greeting_vars_ok('Hola {nombre}') and not private.community_greeting_vars_ok('{}'),'solo variables conocidas');
  perform pg_temp.com_assert(private.community_greeting_render('',  'A','B',1)='','plantilla vacía');
  perform pg_temp.com_login(own);
  cid:=(public.community_create(nm)->>'id')::uuid;
  select (x->>'id')::uuid into ch from jsonb_array_elements(public.community_get(cid)->'channels')x where x->>'kind'='text';
  select (x->>'id')::uuid into ch_voice from jsonb_array_elements(public.community_get(cid)->'channels')x where x->>'kind'='voice';
  ch2:=(public.community_channel_create(cid,'text','despedidas')->>'id')::uuid;
  ch_priv:=(public.community_channel_create_configured(cid,'text','reservado','{"isPrivate":true}')->>'id')::uuid;
  ch_ann:=(public.community_channel_create(cid,'announcement','novedades')->>'id')::uuid;
  v:=public.community_get(cid);
  perform pg_temp.com_assert(v#>>'{greetings,join,enabled}'='false' and v#>>'{greetings,leave,enabled}'='false' and v#>>'{greetings,join,body}'='','sin configurar: apagadas');
  execute 'reset role';
  perform pg_temp.com_login(modu); perform public.community_join(cid); execute 'reset role';
  perform pg_temp.com_login(own); perform public.community_set_role(cid,modu,'moderator'); execute 'reset role';
  perform pg_temp.com_login(viewer); perform public.community_join(cid); execute 'reset role';

  -- Validaciones del guardado: solo el dueño.
  perform pg_temp.com_login(modu);
  perform pg_temp.com_expect(format('select public.community_greeting_save(%L,%L,%L)',cid,'join','{"enabled":false}'),'42501','forbidden','el moderador no configura mensajes automáticos');
  perform pg_temp.com_assert(public.community_get(cid)->'greetings'='null'::jsonb,'solo el dueño recibe la configuración');
  execute 'reset role';
  perform pg_temp.com_login(own);
  perform pg_temp.com_expect(format('select public.community_greeting_save(%L,%L,%L)',cid,'otro','{}'),'22023','bad_kind','solo bienvenida o despedida');
  perform pg_temp.com_expect(format('select public.community_greeting_save(%L,%L,%L)',cid,'join','{"color":"red"}'),'22023','bad_request','claves desconocidas');
  perform pg_temp.com_expect(format('select public.community_greeting_save(%L,%L,%L)',cid,'join','{"body":"Hola {nombre}"}'),'22023','bad_greeting_variable','variable desconocida');
  perform pg_temp.com_expect(format('select public.community_greeting_save(%L,%L,%L)',cid,'join',jsonb_build_object('body',repeat('x',501))),'22023','bad_greeting_text','texto de hasta 500');
  perform pg_temp.com_expect(format('select public.community_greeting_save(%L,%L,%L)',cid,'join',jsonb_build_object('channelId',ch_priv)),'22023','bad_greeting_channel','no en un canal privado');
  perform pg_temp.com_expect(format('select public.community_greeting_save(%L,%L,%L)',cid,'join',jsonb_build_object('channelId',ch_voice)),'22023','bad_greeting_channel','no en un canal de voz');
  perform pg_temp.com_expect(format('select public.community_greeting_save(%L,%L,%L)',cid,'join',jsonb_build_object('channelId',gen_random_uuid())),'22023','bad_greeting_channel','canal inexistente');
  perform pg_temp.com_expect(format('select public.community_greeting_save(%L,%L,%L)',cid,'join','{"enabled":true,"body":"Hola"}'),'22023','greeting_needs_channel','activar pide un canal');
  perform pg_temp.com_expect(format('select public.community_greeting_save(%L,%L,%L)',cid,'join',jsonb_build_object('enabled',true,'channelId',ch)),'22023','greeting_empty','activar pide texto o GIF');
  perform pg_temp.com_expect(format('select public.community_greeting_save(%L,%L,%L)',cid,'join',jsonb_build_object('media','{"kind":"klipy","url":"https://evil.example/x.gif"}'::jsonb)),'22023','bad_media','GIF de KLIPY validado como en los banners');
  perform pg_temp.com_expect(format('select public.community_greeting_save(%L,%L,%L)',cid,'join','{"enabled":"si"}'),'22023','bad_request','enabled es booleano');
  perform pg_temp.com_assert(public.community_get(cid)#>>'{greetings,join,enabled}'='false','los errores no dejan nada a medias');
  v:=public.community_greeting_save(cid,'join',jsonb_build_object('enabled',true,'channelId',ch,'body','¡Hola {usuario}! Bienvenido a {comunidad}. Ya somos {miembros}.','media',klipy));
  perform pg_temp.com_assert(v#>>'{join,enabled}'='true' and v#>>'{join,media,kind}'='klipy' and v#>>'{join,channelId}'=ch::text and v#>>'{leave,enabled}'='false','bienvenida configurada');
  v:=public.community_greeting_save(cid,'leave',jsonb_build_object('enabled',true,'channelId',ch2,'body','{usuario} salió de {comunidad}. Quedamos {miembros}.'));
  perform pg_temp.com_assert(v#>>'{leave,channelId}'=ch2::text,'despedida en otro canal');
  execute 'reset role';

  -- Entrar: aviso con los datos del momento, el GIF y la marca de sistema.
  perform pg_temp.com_login(u1); perform public.community_join(cid); execute 'reset role';
  v:=pg_temp.com_page(ch,viewer);
  perform pg_temp.com_assert((select count(*)=1 from jsonb_array_elements(v)x where x->>'system'='join' and x->>'authorId'=u1::text
    and x->>'body'='¡Hola Ana! Bienvenido a Bienvenidas '||nonce||'. Ya somos 4.' and x#>>'{media,kind}'='klipy'),'bienvenida al entrar con el texto armado y el GIF');
  perform pg_temp.com_login(u1); perform public.community_join(cid); execute 'reset role';
  perform pg_temp.com_assert((select count(*)=1 from jsonb_array_elements(pg_temp.com_page(ch,viewer))x where x->>'system'='join'),'volver a pedir entrar no repite el aviso');
  -- Salir: aviso en el canal elegido; entrar y salir en bucle no inunda.
  perform pg_temp.com_login(u1); perform public.community_leave(cid); execute 'reset role';
  perform pg_temp.com_assert((select count(*)=1 from jsonb_array_elements(pg_temp.com_page(ch2,viewer))x where x->>'system'='leave' and x->>'body'='Ana salió de Bienvenidas '||nonce||'. Quedamos 3.'),
    'despedida al salir con el texto armado');
  perform pg_temp.com_login(u1); perform public.community_join(cid); perform public.community_leave(cid); execute 'reset role';
  perform pg_temp.com_assert((select count(*)=1 from jsonb_array_elements(pg_temp.com_page(ch,viewer))x where x->>'system'='join')
    and (select count(*)=1 from jsonb_array_elements(pg_temp.com_page(ch2,viewer))x where x->>'system'='leave'),'entrar y salir en bucle no repite avisos en diez minutos');
  update public.community_messages set created_at=created_at-interval '11 minutes' where system is not null and community_id=cid;
  perform pg_temp.com_login(u1); perform public.community_join(cid); execute 'reset role';
  perform pg_temp.com_assert((select count(*)=2 from jsonb_array_elements(pg_temp.com_page(ch,viewer))x where x->>'system'='join'),'pasados diez minutos vuelve a avisar');
  -- Los avisos son del equipo: un miembro no los borra.
  perform pg_temp.com_login(viewer);
  perform pg_temp.com_expect(format('select public.community_message_delete(%L)',(select (x->>'id')::uuid from jsonb_array_elements(public.community_messages_page(ch))x where x->>'system'='join' limit 1)),
    '42501','forbidden','un miembro no borra avisos automáticos');
  execute 'reset role';
  perform pg_temp.com_login(modu);
  perform pg_temp.com_assert(public.community_message_delete((select (x->>'id')::uuid from jsonb_array_elements(public.community_messages_page(ch))x where x->>'system'='join' limit 1))->>'ok'='true',
    'el equipo borra avisos');
  execute 'reset role';
  perform pg_temp.com_assert(not exists(select 1 from public.community_messages where community_id=cid and system is not null and deleted and (media is not null or body<>'')),'el aviso borrado pierde texto y GIF');

  -- Expulsados y baneados no publican despedida ni bienvenida; bloqueados no ven al bloqueado.
  perform pg_temp.com_login(u2); perform public.community_join(cid); execute 'reset role';
  perform pg_temp.com_login(own); perform public.community_kick(cid,u2); execute 'reset role';
  perform pg_temp.com_assert(not exists(select 1 from public.community_messages where community_id=cid and author=u2 and system='leave'),'expulsar no publica despedida');
  perform pg_temp.com_login(u2);
  perform pg_temp.com_expect(format('select public.community_join(%L)',cid),'22023','banned_here','el expulsado no vuelve a entrar');
  execute 'reset role';
  perform pg_temp.com_assert((select count(*)=1 from public.community_messages where community_id=cid and author=u2 and system='join'),'el expulsado no suma otra bienvenida');
  insert into public.friendships(requester,addressee,status) values(viewer,u3,'blocked');
  perform pg_temp.com_login(u3); perform public.community_join(cid); execute 'reset role';
  perform pg_temp.com_assert(not exists(select 1 from jsonb_array_elements(pg_temp.com_page(ch,viewer))x where x->>'authorId'=u3::text),'quien bloqueaste no aparece en las bienvenidas que ves');
  perform pg_temp.com_assert(pg_temp.com_sel(viewer,format('select count(*) from public.community_messages where author=%L',u3))=0,'RLS tampoco las entrega');
  perform pg_temp.com_assert(exists(select 1 from jsonb_array_elements(pg_temp.com_page(ch,modu))x where x->>'authorId'=u3::text),'el resto sí las ve');
  delete from public.friendships where requester=viewer and addressee=u3;
  perform pg_temp.com_assert(pg_temp.com_sel(eve,format('select count(*) from public.community_messages where community_id=%L',cid))=0,'un extraño no recibe los avisos');

  -- Apagada, canal borrado, canal vuelto privado o vacío: no publica y no rompe entrar.
  update public.community_messages set created_at=created_at-interval '11 minutes' where system is not null and community_id=cid;
  perform pg_temp.com_login(own);
  perform public.community_greeting_save(cid,'join','{"enabled":false}');
  execute 'reset role';
  n:=pg_temp.com_count(format('select count(*) from public.community_messages where community_id=%L and system=%L',cid,'join'));
  perform pg_temp.com_login(eve); perform public.community_join(cid); execute 'reset role';
  perform pg_temp.com_assert(pg_temp.com_count(format('select count(*) from public.community_messages where community_id=%L and system=%L',cid,'join'))=n,'apagada: no publica');
  perform pg_temp.com_login(eve); perform public.community_leave(cid); execute 'reset role';
  perform pg_temp.com_login(own);
  perform public.community_greeting_save(cid,'join','{"enabled":true}');
  perform public.community_channel_configure(ch,'{"isPrivate":true}');
  execute 'reset role';
  update public.community_messages set created_at=created_at-interval '11 minutes' where system is not null and community_id=cid;
  perform pg_temp.com_login(eve); perform public.community_join(cid); execute 'reset role';
  perform pg_temp.com_assert(pg_temp.com_count(format('select count(*) from public.community_messages where community_id=%L and system=%L',cid,'join'))=n,'canal vuelto privado: no publica');
  perform pg_temp.com_login(own);
  perform public.community_channel_configure(ch,'{"isPrivate":false}');
  perform public.community_channel_delete(ch);
  execute 'reset role';
  perform pg_temp.com_assert((select channel_id is null and enabled from public.community_greetings where community_id=cid and kind='join'),'borrar el canal deja la bienvenida sin canal pero configurada');
  perform pg_temp.com_login(eve); perform public.community_leave(cid); perform public.community_join(cid); execute 'reset role';
  perform pg_temp.com_login(own);
  perform pg_temp.com_expect(format('select public.community_greeting_save(%L,%L,%L)',cid,'join','{"enabled":true}'),'22023','greeting_needs_channel','sin canal no se puede activar');
  perform public.community_greeting_save(cid,'join',jsonb_build_object('enabled',true,'channelId',ch_ann,'body','Bienvenido/a {usuario}'));
  execute 'reset role';
  update public.community_messages set created_at=created_at-interval '11 minutes' where system is not null and community_id=cid;
  perform pg_temp.com_login(eve); perform public.community_leave(cid); perform public.community_join(cid); execute 'reset role';
  perform pg_temp.com_assert(exists(select 1 from jsonb_array_elements(pg_temp.com_page(ch_ann,viewer))x where x->>'system'='join' and x->>'body'='Bienvenido/a Eva'),'también en un canal de anuncios');
  -- La última cuenta que sale disuelve la comunidad sin error aunque tenga despedida activada.
  perform pg_temp.com_login(u3);
  cid:=(public.community_create('Efimera '||nonce)->>'id')::uuid;
  select (x->>'id')::uuid into ch from jsonb_array_elements(public.community_get(cid)->'channels')x where x->>'kind'='text';
  perform public.community_greeting_save(cid,'leave',jsonb_build_object('enabled',true,'channelId',ch,'body','Chau {usuario}'));
  perform pg_temp.com_assert(public.community_leave(cid)->>'dissolved'='true','la última cuenta disuelve la comunidad sin error con despedida activa');
  execute 'reset role';
end $greet$;

SELECT label FROM pg_temp.com_checks ORDER BY label;
SELECT count(*) AS checks FROM pg_temp.com_checks;
SELECT count(*) AS com_checks FROM pg_temp.com_checks \gset
\echo COMMUNITIES_CHECKS=:com_checks
ROLLBACK;
DO $rollback$
begin
  if to_regclass('public.community_categories') is not null or to_regclass('public.community_roles') is not null
    or to_regclass('public.community_media') is not null or exists(select 1 from storage.buckets where id='community-media')
    or exists(select 1 from storage.objects where bucket_id='community-media')
    or to_regprocedure('public.community_customize(uuid,jsonb)') is not null
    or exists(select 1 from auth.users) then raise exception 'Rollback incompleto'; end if;
end $rollback$;
\echo COMMUNITIES_ROLLBACK_OK
