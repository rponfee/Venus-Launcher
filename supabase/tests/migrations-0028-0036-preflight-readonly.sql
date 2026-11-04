-- Inspección de metadatos solamente. SQL puro: apto para execute_sql del parent.
-- No aplica migraciones ni crea fixtures. No imprime cuerpos de funciones, secretos, endpoints ni filas de usuarios.
-- La ausencia de objetos 0028–0036 es esperada en una base que llega hasta 0027.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = pg_catalog;

SELECT name AS esquema, to_regnamespace(name) IS NOT NULL AS existe
  FROM unnest(array['public','private','auth','storage','realtime','extensions','vault','net']) name;
SELECT name AS tabla_base, to_regclass(name) IS NOT NULL AS existe
  FROM unnest(array['auth.users','public.profiles','public.profile_gifts','public.points_ledger','public.shop_items',
    'public.shared_media','public.messages','public.friendships','storage.objects','storage.buckets']) name;
SELECT name AS funcion_base, to_regprocedure(name) IS NOT NULL AS existe
  FROM unnest(array['auth.uid()','auth.jwt()','private.are_friends(uuid,uuid)','private.points_award(uuid,integer,text,text)',
    'public.admin_guard()','public.admin_log(uuid,text,text,uuid,jsonb)','realtime.send(jsonb,text,text,boolean)',
    'extensions.gen_random_bytes(integer)','net.http_post(text,jsonb,jsonb,jsonb,integer)']) name;
SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles
 WHERE rolname IN ('postgres','supabase_admin','authenticator','anon','authenticated','service_role') ORDER BY rolname;
SELECT extname, extversion, extnamespace::regnamespace::text AS esquema FROM pg_extension
 WHERE extname IN ('pg_net','pgcrypto','supabase_vault');
-- Solo esa clave de PostgREST: no leer ni volcar el resto de configuraciones.
SELECT current_setting('pgrst.db_schemas', true) AS esquemas_api_en_esta_sesion;
SELECT coalesce(r.rolname, '(todos)') AS rol, split_part(s.value, '=', 2) AS esquemas_api_configurados
  FROM pg_db_role_setting cfg LEFT JOIN pg_roles r ON r.oid = cfg.setrole
  CROSS JOIN LATERAL unnest(cfg.setconfig) s(value)
 WHERE s.value LIKE 'pgrst.db_schemas=%';

WITH expected AS (SELECT unnest(array['settings_sync', 'featured_server_reviews', 'featured_server_votes', 'featured_review_reports', 'user_stickers', 'ranking_prefs', 'ranking_weekly', 'ranking_reports', 'challenges', 'calendar_events', 'calendar_signups', 'clip_gallery', 'clip_gallery_likes', 'clip_gallery_reports', 'clan_prefs', 'clans', 'clan_members', 'clan_invites', 'clan_requests', 'communities', 'community_members', 'community_bans', 'community_mutes', 'community_channels', 'community_messages', 'group_reports', 'user_capes', 'push_subscriptions', 'push_throttle', 'media_received', 'community_extensions', 'community_extension_versions']) AS name)
SELECT e.name AS tabla, c.oid IS NOT NULL AS existe, c.relrowsecurity AS rls, c.relforcerowsecurity AS rls_forzada,
       pg_get_userbyid(c.relowner) AS propietario
  FROM expected e LEFT JOIN pg_class c ON c.relnamespace = to_regnamespace('public') AND c.relname = e.name
 ORDER BY e.name;

SELECT c.relname AS tabla, r.rolname AS rol,
       has_table_privilege(r.oid, c.oid, 'SELECT') AS lectura,
       has_table_privilege(r.oid, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS escritura_o_control,
       has_any_column_privilege(r.oid, c.oid, 'INSERT,UPDATE,REFERENCES') AS escritura_columnas
  FROM pg_class c CROSS JOIN pg_roles r
 WHERE c.relnamespace = to_regnamespace('public') AND c.relname = ANY(array['settings_sync', 'featured_server_reviews', 'featured_server_votes', 'featured_review_reports', 'user_stickers', 'ranking_prefs', 'ranking_weekly', 'ranking_reports', 'challenges', 'calendar_events', 'calendar_signups', 'clip_gallery', 'clip_gallery_likes', 'clip_gallery_reports', 'clan_prefs', 'clans', 'clan_members', 'clan_invites', 'clan_requests', 'communities', 'community_members', 'community_bans', 'community_mutes', 'community_channels', 'community_messages', 'group_reports', 'user_capes', 'push_subscriptions', 'push_throttle', 'media_received', 'community_extensions', 'community_extension_versions'])
   AND r.rolname IN ('anon','authenticated','service_role') ORDER BY c.relname, r.rolname;

WITH expected(schema_name, function_name) AS (VALUES
    ('public', 'settings_sync_get'),
    ('public', 'settings_sync_save'),
    ('public', 'settings_sync_delete'),
    ('private', 'review_writer'),
    ('private', 'review_author_visible'),
    ('private', 'review_entry'),
    ('private', 'review_stats'),
    ('public', 'featured_reviews_summary'),
    ('public', 'featured_reviews_list'),
    ('public', 'featured_review_save'),
    ('public', 'featured_review_delete'),
    ('public', 'featured_server_vote'),
    ('public', 'featured_review_report'),
    ('public', 'admin_reviews_list'),
    ('public', 'admin_review_set_hidden'),
    ('public', 'admin_review_delete'),
    ('public', 'admin_review_dismiss'),
    ('private', 'sticker_max'),
    ('private', 'sticker_can_upload'),
    ('private', 'sticker_json'),
    ('public', 'sticker_mine'),
    ('public', 'sticker_resolve'),
    ('public', 'sticker_emojis'),
    ('public', 'sticker_create'),
    ('public', 'sticker_delete'),
    ('public', 'admin_stickers'),
    ('public', 'admin_sticker_delete'),
    ('private', 'compete_week'),
    ('private', 'ranking_cap'),
    ('public', 'ranking_set_share'),
    ('public', 'ranking_forget'),
    ('public', 'ranking_report'),
    ('public', 'ranking_friends'),
    ('private', 'challenge_tally'),
    ('private', 'challenge_finish'),
    ('private', 'challenge_json'),
    ('public', 'challenge_create'),
    ('public', 'challenge_respond'),
    ('public', 'challenge_cancel'),
    ('public', 'challenge_settle'),
    ('public', 'challenges_me'),
    ('private', 'event_json'),
    ('public', 'events_list'),
    ('public', 'events_mine'),
    ('public', 'event_signups'),
    ('public', 'event_join'),
    ('public', 'event_leave'),
    ('public', 'admin_events'),
    ('public', 'admin_event_save'),
    ('public', 'admin_event_delete'),
    ('private', 'gallery_url_ok'),
    ('private', 'gallery_me'),
    ('private', 'gallery_visible'),
    ('private', 'gallery_author'),
    ('public', 'gallery_publish'),
    ('public', 'gallery_unpublish'),
    ('public', 'gallery_list'),
    ('public', 'gallery_mine'),
    ('public', 'gallery_like'),
    ('public', 'gallery_report'),
    ('public', 'admin_gallery_list'),
    ('public', 'admin_gallery_hide'),
    ('public', 'admin_gallery_delete'),
    ('public', 'admin_gallery_reports_close'),
    ('private', 'group_line'),
    ('private', 'group_text'),
    ('private', 'group_reserved'),
    ('private', 'clan_emblems'),
    ('private', 'group_code'),
    ('private', 'group_me'),
    ('private', 'group_writer'),
    ('private', 'group_hit'),
    ('private', 'group_week'),
    ('private', 'group_person'),
    ('private', 'group_like'),
    ('private', 'community_is_member'),
    ('private', 'clan_new_code'),
    ('private', 'clan_mine'),
    ('private', 'clan_role_of'),
    ('private', 'clan_leader_blocks'),
    ('private', 'clan_card'),
    ('private', 'clan_shared'),
    ('private', 'clan_achievements'),
    ('private', 'clan_json'),
    ('private', 'clan_add_member'),
    ('private', 'clan_members_after_delete'),
    ('public', 'clan_create'),
    ('public', 'clan_update'),
    ('public', 'clan_share_playtime'),
    ('public', 'clan_me'),
    ('public', 'clan_get'),
    ('public', 'clan_search'),
    ('public', 'clan_tags'),
    ('public', 'clan_invite'),
    ('public', 'clan_invite_cancel'),
    ('public', 'clan_invite_respond'),
    ('public', 'clan_request'),
    ('public', 'clan_request_cancel'),
    ('public', 'clan_request_respond'),
    ('public', 'clan_join_code'),
    ('public', 'clan_regen_code'),
    ('public', 'clan_leave'),
    ('public', 'clan_kick'),
    ('public', 'clan_set_role'),
    ('public', 'clan_transfer'),
    ('public', 'clan_ranking'),
    ('private', 'community_new_code'),
    ('private', 'community_role'),
    ('private', 'community_need'),
    ('private', 'community_owner_blocks'),
    ('private', 'community_card'),
    ('private', 'community_sync_rooms'),
    ('private', 'community_voice_out'),
    ('private', 'community_add_member'),
    ('private', 'community_members_after_delete'),
    ('private', 'community_channels_after_delete'),
    ('private', 'community_message_json'),
    ('public', 'community_create'),
    ('public', 'community_update'),
    ('public', 'community_delete'),
    ('public', 'community_transfer'),
    ('public', 'community_my'),
    ('public', 'community_search'),
    ('public', 'community_get'),
    ('public', 'community_join'),
    ('public', 'community_join_code'),
    ('public', 'community_regen_code'),
    ('public', 'community_leave'),
    ('public', 'community_members_list'),
    ('public', 'community_set_role'),
    ('public', 'community_mute'),
    ('public', 'community_kick'),
    ('public', 'community_unban'),
    ('public', 'community_bans_list'),
    ('public', 'community_channel_create'),
    ('public', 'community_channel_rename'),
    ('public', 'community_channel_delete'),
    ('public', 'community_channels_reorder'),
    ('public', 'community_messages_page'),
    ('public', 'community_send'),
    ('public', 'community_message_delete'),
    ('public', 'community_voice_room'),
    ('public', 'community_report'),
    ('public', 'admin_groups'),
    ('public', 'admin_group_detail'),
    ('public', 'admin_group_dissolve'),
    ('public', 'admin_group_remove'),
    ('public', 'admin_group_reports'),
    ('public', 'admin_group_report_close'),
    ('public', 'cape_equip'),
    ('public', 'cape_mine'),
    ('public', 'badge_capes'),
    ('private', 'push_endpoint_ok'),
    ('private', 'media_share_url_ok'),
    ('private', 'push_dispatch'),
    ('private', 'push_configure'),
    ('private', 'media_share_note'),
    ('private', 'push_on_message'),
    ('private', 'push_on_friend_request'),
    ('public', 'social_send_signal'),
    ('public', 'push_subscribe'),
    ('public', 'push_unsubscribe'),
    ('public', 'app_inbox'),
    ('public', 'media_received_list'),
    ('public', 'media_received_seen'),
    ('public', 'media_received_remove'),
    ('public', 'push_claim'),
    ('public', 'push_drop'),
    ('private', 'extension_permissions'),
    ('private', 'extension_text_ok'),
    ('private', 'extension_name_ok'),
    ('private', 'extension_version_ok'),
    ('private', 'extension_page_ok'),
    ('private', 'extension_manifest_ok'),
    ('private', 'extension_can_read'),
    ('private', 'extension_can_upload'),
    ('public', 'extension_catalog'),
    ('public', 'extension_blocklist'),
    ('public', 'extension_submit'),
    ('public', 'extension_my_submissions'),
    ('public', 'admin_extensions'),
    ('public', 'admin_extension_review'),
    ('public', 'admin_extension_block')
)
SELECT e.schema_name, e.function_name, p.oid IS NOT NULL AS existe,
       pg_get_function_identity_arguments(p.oid) AS argumentos,
       pg_get_userbyid(p.proowner) AS propietario, p.prosecdef AS security_definer,
       (SELECT setting FROM unnest(p.proconfig) setting WHERE setting LIKE 'search_path=%') AS search_path,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute,
       has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_execute,
       EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_execute
  FROM expected e LEFT JOIN pg_namespace n ON n.nspname = e.schema_name
  LEFT JOIN pg_proc p ON p.pronamespace = n.oid AND p.proname = e.function_name AND p.prokind = 'f'
 ORDER BY e.schema_name, e.function_name;

SELECT n.nspname AS esquema, c.relname AS tabla, pol.polname, pol.polcmd, pol.polpermissive,
       ARRAY(SELECT CASE WHEN role_id = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(role_id) END FROM unnest(pol.polroles) role_id) AS roles,
       pol.polqual IS NOT NULL AS tiene_using, pol.polwithcheck IS NOT NULL AS tiene_with_check
  FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE (n.nspname = 'public' AND c.relname = ANY(array['settings_sync', 'featured_server_reviews', 'featured_server_votes', 'featured_review_reports', 'user_stickers', 'ranking_prefs', 'ranking_weekly', 'ranking_reports', 'challenges', 'calendar_events', 'calendar_signups', 'clip_gallery', 'clip_gallery_likes', 'clip_gallery_reports', 'clan_prefs', 'clans', 'clan_members', 'clan_invites', 'clan_requests', 'communities', 'community_members', 'community_bans', 'community_mutes', 'community_channels', 'community_messages', 'group_reports', 'user_capes', 'push_subscriptions', 'push_throttle', 'media_received', 'community_extensions', 'community_extension_versions']))
    OR (n.nspname = 'storage' AND c.relname = 'objects' AND pol.polname IN
      ('stickers_insert_own','stickers_select_own','stickers_delete_own','extension_packages_select','extension_packages_insert'))
 ORDER BY n.nspname, c.relname, pol.polname;

SELECT conname, convalidated, pg_get_constraintdef(oid) AS definicion
  FROM pg_constraint WHERE conrelid = to_regclass('public.points_ledger') AND conname = 'points_ledger_reason_check';
SELECT t.tgrelid::regclass::text AS tabla, t.tgname, t.tgenabled, t.tgfoid::regprocedure::text AS funcion,
       p.prosrc ~ '(net[.]http_|http_request|vault[.])' AS menciona_red_o_vault
  FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
 WHERE NOT t.tgisinternal AND t.tgrelid IN (to_regclass('auth.users'), to_regclass('storage.buckets'),
   to_regclass('storage.objects'), to_regclass('public.shop_items'), to_regclass('public.messages'),
   to_regclass('public.friendships'), to_regclass('public.community_messages')) ORDER BY tabla, t.tgname;
SELECT e.evtname, e.evtevent, e.evtenabled, e.evtfoid::regprocedure::text AS funcion,
       p.prosrc ~ '(net[.]http_|http_request|vault[.])' AS menciona_red_o_vault
  FROM pg_event_trigger e JOIN pg_proc p ON p.oid = e.evtfoid ORDER BY e.evtname;
ROLLBACK;
