-- 0048_limpieza_retiros.sql · Venus 4.6 · Limpieza de lo que dejaron los retiros de la 4.6
-- Informes: docs/supabase.md (sección 0048), docs/insignia.md (capas) y docs/retirada-funciones.md.
-- Se aplica después de 0047. Idempotente (se puede correr dos veces) y SIN aplicar al escribirse: la aplica el dueño.
--
--   * Competir (0031): tablas ranking_prefs, ranking_weekly, ranking_reports, challenges, calendar_events y calendar_signups, y sus funciones.
--     El motivo 'challenge' SE CONSERVA en points_ledger_reason_check (el historial de puntos todavía lo muestra).
--   * Extensiones (0036): tablas community_extensions y community_extension_versions, sus funciones y las políticas del bucket
--     'extension-packages'. El bucket NO se puede borrar por SQL (storage.protect_delete): se borra desde el panel o la API de Storage.
--   * Capas (0034): tabla user_capes, funciones cape_equip, cape_mine y badge_capes, filas kind = 'cape' de shop_items y su restricción.
--     Quien compró capas recibe el reintegro UNA sola vez (fila positiva de points_ledger, motivo 'shop', ref 'refund:<item>'; la
--     clave única (user_id, reason, ref) lo impide repetir, igual que en 0040).
--   * Clanes viejos (0033): tablas clan_prefs, clans, clan_members, clan_invites y clan_requests, y sus funciones. Comunidades se queda.
--     Antes se redefinen SIN la rama 'clan' admin_groups, admin_group_detail, admin_group_dissolve, admin_group_remove y community_report
--     (partiendo de la definición vigente en producción) y group_reports_kind_check pasa a ('message', 'community', 'media').
--   * profile_public: achievementCount cuenta solo logros activos (la 0043 desactivó los del Minecraft).
--
-- NO toca nada del Venus Pass ni de pagos (pass_tiers, pass_purchases, pass_quote, payments_*).
-- Los GIF subidos y los paquetes de Storage no se tocan: el bucket 'community-media' sigue y 'extension-packages' debe estar vacío.

-- ---------- Guardas: no se borra nada que tenga datos que esta migración no sepa conservar ----------
do $do$
begin
  if to_regclass('public.pass_rewards') is not null and exists (
       select 1 from public.pass_rewards r join public.shop_items s on s.id = r.item_id where s.kind = 'cape') then
    raise exception 'pass_rewards_use_capes: una recompensa del Pase todavía es una capa; sacala antes de limpiar' using errcode = '23503';
  end if;
  if exists (select 1 from storage.objects o where o.bucket_id = 'extension-packages') then
    raise exception 'extension_packages_not_empty: borrá los paquetes del bucket extension-packages desde la API de Storage antes de limpiar' using errcode = '23503';
  end if;
end $do$;

-- ---------- Administración y denuncias de Comunidades, sin la rama 'clan' ----------
-- Se parte de la definición de producción (pg_get_functiondef). admin_groups pasa a 'community' como valor por defecto.
create or replace function public.admin_groups(p_kind text default 'community'::text, p_query text default ''::text)
 returns jsonb language plpgsql stable security definer set search_path to ''
as $function$
declare v_q text := private.group_like(p_query);
begin
  perform public.admin_guard();
  if p_kind = 'community' then
    return (select coalesce(jsonb_agg(private.community_card(x.id, null) || jsonb_build_object(
        'owner', private.group_person((select m.user_id from public.community_members m where m.community_id = x.id and m.role = 'owner')),
        'reports', (select count(*) from public.group_reports r where r.community_id = x.id and r.status = 'open')) order by x.created_at desc), '[]'::jsonb)
      from (select c.id, c.created_at from public.communities c
             where v_q = '' or c.name ilike '%' || v_q || '%' order by c.created_at desc limit 100) x);
  end if;
  raise exception 'bad_kind' using errcode = '22023';
end $function$;

create or replace function public.admin_group_detail(p_kind text, p_id uuid)
 returns jsonb language plpgsql stable security definer set search_path to ''
as $function$
declare v jsonb;
begin
  perform public.admin_guard();
  if p_kind = 'community' then
    v := private.community_card(p_id, null);
    if v is null then raise exception 'not_found' using errcode = '22023'; end if;
    return v || jsonb_build_object(
      'members', (select coalesce(jsonb_agg(private.group_person(m.user_id) || jsonb_build_object('role', m.role, 'joinedAt', m.joined_at) order by m.joined_at), '[]'::jsonb)
        from public.community_members m where m.community_id = p_id),
      'channels', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'kind', c.kind, 'name', c.name) order by c.position), '[]'::jsonb)
        from public.community_channels c where c.community_id = p_id));
  end if;
  raise exception 'bad_kind' using errcode = '22023';
end $function$;

create or replace function public.admin_group_dissolve(p_kind text, p_id uuid, p_reason text default null::text)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  me uuid := auth.uid();
  v jsonb;
  v_user uuid;
begin
  perform public.admin_guard();
  if p_kind = 'community' then
    v := private.community_card(p_id, null);
    v_user := (select m.user_id from public.community_members m where m.community_id = p_id and m.role = 'owner');
    delete from public.communities c where c.id = p_id;
  else
    raise exception 'bad_kind' using errcode = '22023';
  end if;
  if v is null then raise exception 'not_found' using errcode = '22023'; end if;
  perform public.admin_log(me, (select u.email from auth.users u where u.id = me), 'community.dissolve', v_user,
    jsonb_build_object('id', p_id, 'name', v ->> 'name', 'tag', v ->> 'tag', 'members', v -> 'memberCount', 'reason', left(p_reason, 200)));
  return jsonb_build_object('ok', true);
end $function$;

create or replace function public.admin_group_remove(p_kind text, p_id uuid, p_user uuid, p_reason text default null::text)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  me uuid := auth.uid();
  v jsonb;
  n integer;
begin
  perform public.admin_guard();
  if p_kind = 'community' then
    v := private.community_card(p_id, null);
    delete from public.community_members m where m.community_id = p_id and m.user_id = p_user;
    get diagnostics n = row_count;
    if n > 0 and exists (select 1 from public.communities c where c.id = p_id) then
      insert into public.community_bans (community_id, user_id, banned_by) values (p_id, p_user, me) on conflict do nothing;
      perform private.community_voice_out(p_id, p_user, true);
    end if;
  else
    raise exception 'bad_kind' using errcode = '22023';
  end if;
  if v is null or n = 0 then raise exception 'not_found' using errcode = '22023'; end if;
  perform public.admin_log(me, (select u.email from auth.users u where u.id = me), 'community.removeMember', p_user,
    jsonb_build_object('id', p_id, 'name', v ->> 'name', 'reason', left(p_reason, 200)));
  return jsonb_build_object('ok', true);
end $function$;

create or replace function public.community_report(p_kind text, p_id uuid, p_reason text, p_text text default null::text)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  me uuid := private.group_me();
  v_clean text := private.group_text(coalesce(p_text, ''));
  v_community uuid;
  v_user uuid;
  v_snapshot jsonb;
  m public.community_messages;
  md public.community_media;
begin
  if p_kind not in ('message', 'community', 'media') then raise exception 'bad_kind' using errcode = '22023'; end if;
  if p_reason not in ('spam', 'abuse', 'nsfw', 'other') then raise exception 'bad_reason' using errcode = '22023'; end if;
  if v_clean is null or char_length(v_clean) > 300 then raise exception 'bad_text' using errcode = '22023'; end if;
  if p_kind = 'message' then
    select * into m from public.community_messages x where x.id = p_id and not x.deleted;
    if not found then raise exception 'not_found' using errcode = '22023'; end if;
    perform private.community_channel_need(m.channel_id, me);
    if not private.community_message_visible(m.channel_id,m.author,m.parent_id) then raise exception 'not_found' using errcode = '22023'; end if;
    if m.author = me then raise exception 'bad_target' using errcode = '22023'; end if;
    v_community := m.community_id;
    v_user := m.author;
    v_snapshot := jsonb_build_object('body', left(m.body, 1000), 'at', m.created_at, 'channel', (select c.name from public.community_channels c where c.id = m.channel_id),
      'community', (select c.name from public.communities c where c.id = m.community_id));
  elsif p_kind = 'community' then
    select jsonb_build_object('name', c.name, 'description', c.description) into v_snapshot from public.communities c
     where c.id = p_id and (c.is_public or private.community_role(c.id, me) is not null);
    if not found then raise exception 'not_found' using errcode = '22023'; end if;
    v_community := p_id;
    v_user := (select o.user_id from public.community_members o where o.community_id = p_id and o.role = 'owner');
  else
    -- Solo se denuncia un GIF ya aprobado y solo desde dentro de su comunidad: lo pendiente no lo ve nadie más.
    select * into md from public.community_media x where x.id = p_id and x.status = 'approved';
    if not found or not private.community_access(md.community_id, me) then raise exception 'not_found' using errcode = '22023'; end if;
    if md.uploaded_by = me then raise exception 'bad_target' using errcode = '22023'; end if;
    v_community := md.community_id;
    v_user := md.uploaded_by;
    v_snapshot := jsonb_build_object('name', md.name, 'path', md.path, 'mime', md.mime, 'width', md.width, 'height', md.height,
      'community', (select c.name from public.communities c where c.id = md.community_id));
  end if;
  perform pg_advisory_xact_lock(hashtext('group-reports:' || me::text));
  if (select count(*) from public.group_reports r where r.reporter = me and r.created_at > now() - interval '1 day') >= 10 then
    raise exception 'too_many_today' using errcode = '22023';
  end if;
  insert into public.group_reports (reporter, kind, target_id, community_id, target_user, snapshot, reason, text)
  values (me, p_kind, p_id, v_community, v_user, v_snapshot, p_reason, nullif(v_clean, ''))
  on conflict (reporter, kind, target_id) where status = 'open' do nothing;
  return jsonb_build_object('ok', true);
end $function$;

-- Las denuncias de clanes ya no tienen a qué apuntar (el sistema viejo desaparece). Producción no tiene ninguna.
delete from public.group_reports where kind = 'clan';
alter table public.group_reports drop constraint if exists group_reports_kind_check;
alter table public.group_reports add constraint group_reports_kind_check check (kind in ('message', 'community', 'media'));

-- ---------- Perfil público: el contador de logros solo cuenta los activos ----------
create or replace function public.profile_public(p_user uuid)
 returns jsonb language sql stable security definer set search_path to ''
as $function$
  select jsonb_build_object(
    'id', p.id, 'username', p.username, 'displayName', p.display_name, 'friendCode', p.friend_code,
    'mcName', p.mc_name, 'bio', p.bio, 'badges', to_jsonb(p.badges), 'pronouns', p.pronouns, 'theme', p.theme,
    'nameStyle', p.name_style,
    -- Los diseños (preset), los GIF propios (animated) y las imagenes que no cumplen la regla de banner se muestran como el color clasico
    'banner', case when p.banner_style ->> 'kind' in ('preset', 'animated')
                     or (p.banner_style ->> 'kind' = 'image' and not private.banner_image_url(p.id, p.banner_style -> 'url'))
                   then '{}'::jsonb else p.banner_style end,
    'favoriteServers', p.favorite_servers,
    'publicStats', p.public_stats, 'featured', p.featured, 'equipped', p.equipped,
    'cardStyle', (p.card_style - 'song' - 'avatar') || jsonb_build_object('avatar', 'round'), 'links', p.links, 'rank', p.rank,
    'statusText', case when p.status_until is not null and p.status_until < now() then null else p.status_text end,
    'statusUntil', case when p.status_until is not null and p.status_until < now() then null else p.status_until end,
    'song', case when p.id = auth.uid() or private.are_friends(auth.uid(), p.id) then p.card_style -> 'song' else null end,
    'showcase', jsonb_build_object(
      'skin', coalesce((p.showcase ->> 'skin')::boolean, false),
      'skinPose', p.showcase ->> 'skinPose',
      'skinBg', p.showcase ->> 'skinBg',
      'achievements', coalesce((select jsonb_agg(jsonb_build_object('id', ua.achievement_id, 'at', ua.unlocked_at))
                                  from jsonb_array_elements_text(coalesce(p.showcase -> 'achievements', '[]'::jsonb)) x (id)
                                  join public.user_achievements ua on ua.user_id = p.id and ua.achievement_id = x.id), '[]'::jsonb),
      'rareBadges', coalesce((select jsonb_agg(jsonb_build_object('id', ua.achievement_id, 'at', ua.unlocked_at))
                                from jsonb_array_elements_text(coalesce(p.showcase -> 'rareBadges', '[]'::jsonb)) x (id)
                                join public.user_achievements ua on ua.user_id = p.id and ua.achievement_id = x.id), '[]'::jsonb),
      -- Los clips que el dueño dejó de compartir o que vencieron ya no se muestran
      'clips', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'url', m.url, 'title', coalesce(m.world, m.instance_name), 'expiresAt', m.expires_at))
                           from jsonb_array_elements_text(coalesce(p.showcase -> 'clips', '[]'::jsonb)) x (id)
                           join public.shared_media m on m.id = x.id::uuid and m.owner = p.id
                          where m.url is not null and (m.expires_at is null or m.expires_at > now())), '[]'::jsonb)),
    -- Solo logros activos: la 0043 desactivó los del Minecraft y no deben inflar el contador
    'achievementCount', (select count(*) from public.user_achievements ua join public.achievements a on a.id = ua.achievement_id and a.active where ua.user_id = p.id),
    'achievementTotal', (select count(*) from public.achievements a where a.active),
    'premium', public.venus_is_premium(p.id), 'createdAt', p.created_at)
  from public.profiles p
  where p.id = p_user and auth.uid() is not null
$function$;

-- ---------- Capas: reintegro (una sola vez) y fuera del catálogo ----------
-- Lo que pagó cada cuenta por una capa, tal cual está en el libro (shop_buy anota ref = id del ítem).
insert into public.points_ledger (user_id, delta, reason, ref)
select l.user_id, -l.delta, 'shop', 'refund:' || l.ref
  from public.points_ledger l
 where l.reason = 'shop' and l.delta < 0
   and l.ref in ('cape_dawn', 'cape_nebula', 'cape_aurora', 'cape_magma', 'cape_orbit')
on conflict (user_id, reason, ref) do nothing;

-- Al borrar el catálogo caen en cascada user_items y user_capes de esas capas (el cobro ya quedó reintegrado arriba).
delete from public.shop_items where kind = 'cape';
alter table public.shop_items drop constraint if exists shop_items_cape_data;
alter table public.shop_items drop constraint if exists shop_items_kind_check;
alter table public.shop_items add constraint shop_items_kind_check check (kind in ('frame', 'name_effect', 'badge_style', 'title', 'banner'));

-- ---------- Extensiones: políticas del bucket (el bucket se borra aparte, desde Storage) ----------
drop policy if exists "extension_packages_select" on storage.objects;
drop policy if exists "extension_packages_insert" on storage.objects;

-- ---------- Funciones de lo retirado ----------
-- El disparador de clanes va antes que su función y que la tabla.
do $do$
begin
  if to_regclass('public.clan_members') is not null then
    drop trigger if exists clan_members_after_delete on public.clan_members;
  end if;
end $do$;

do $do$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where p.prokind in ('f', 'p') and (
       (n.nspname = 'public' and (p.proname like 'clan\_%' or p.proname like 'extension\_%' or p.proname = any (array[
          'admin_event_delete', 'admin_event_save', 'admin_events', 'admin_extension_block', 'admin_extension_review', 'admin_extensions',
          'badge_capes', 'cape_equip', 'cape_mine',
          'challenge_cancel', 'challenge_create', 'challenge_respond', 'challenge_settle', 'challenges_me',
          'event_join', 'event_leave', 'event_signups', 'events_list', 'events_mine',
          'ranking_forget', 'ranking_friends', 'ranking_report', 'ranking_set_share'])))
       or
       (n.nspname = 'private' and (p.proname like 'clan\_%' or p.proname like 'extension\_%' or p.proname = any (array[
          'challenge_finish', 'challenge_json', 'challenge_tally', 'compete_week', 'event_json', 'ranking_cap']))))
  loop
    execute 'drop function ' || f.sig;
  end loop;
end $do$;

-- ---------- Tablas (sin cascade: si algo más dependiera de ellas, esto falla en voz alta) ----------
drop table if exists
  public.clan_requests, public.clan_invites, public.clan_members, public.clans, public.clan_prefs,
  public.ranking_reports, public.ranking_weekly, public.ranking_prefs,
  public.challenges, public.calendar_signups, public.calendar_events,
  public.community_extension_versions, public.community_extensions,
  public.user_capes;
