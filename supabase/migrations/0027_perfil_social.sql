-- 0027_perfil_social.sql · Venus 3.1 · Perfil y social: temas, burbujas, entrada en voz, estado con vencimiento,
-- libro de visitas, regalos, canción de perfil, denuncias y marcos nuevos.
-- Guía: docs/perfiles.md. Se aplica después de 0025 (y de la 0026 si existe: si esa migración amplía el
-- check de points_ledger.reason, sumar sus motivos al check de abajo antes de aplicar). Idempotente.
--
--   * profiles.status_until: hasta cuándo vale el texto de estado. profile_public y el listado de amigos lo muestran
--     vacío cuando venció. Se escribe con profile_set_status (emoji + texto + vencimiento).
--   * card_style gana theme { id, particles }, bubble { style, color }, entry, song { url, title } y guestbook (bool).
--     Las partículas del tema piden Premium (o el ítem extra_particles, si algún día se vende). La canción solo la
--     devuelve profile_public a los amigos (y al dueño); el archivo vive en el bucket público profile-audio.
--   * showcase gana skinPose, skinBg y rareBadges (hasta 3 logros que la cuenta tiene).
--   * Libro de visitas (profile_guestbook): escriben los amigos del dueño, 5 por día; borra el autor o el dueño.
--   * Regalos (gift_send): puntos (10 a 500, hasta 1000 por día) o un cosmético de la tienda, solo entre amigos. Van al
--     libro de puntos como gift_out / gift_in y quedan en profile_gifts para la bandeja del que recibe.
--   * Denuncias (profile_reports): 10 por día por denunciante; admin_profile_reports para el panel.
--   * Tienda: frame_pulse, frame_orbit, frame_halloween y frame_xmas. Los cosméticos del Venus Pass (season1*, max,
--     traveler, pro) los carga la migración del pase; acá solo se aceptan sus estilos.

-- ---------- Columnas ----------
alter table public.profiles add column if not exists status_until timestamptz;
grant update (status_until) on public.profiles to authenticated;

-- card_style y showcase crecen (canción, tema, burbuja, poses): se agranda el tope de 0023
alter table public.profiles drop constraint if exists profiles_custom3_size;
alter table public.profiles add constraint profiles_custom3_size check (
  pg_column_size(card_style) < 2048 and pg_column_size(links) < 2048 and pg_column_size(showcase) < 2048);

-- ---------- Catálogo que conoce el servidor ----------
create or replace function private.profile_effects() returns text[]
language sql immutable set search_path = '' as $$ select array[
  'none', 'glow', 'gradient', 'shimmer', 'rainbow', 'fire',
  'neon', 'ice', 'ocean', 'sakura', 'toxic', 'vapor', 'gold', 'galaxy', 'glitch', 'season1'] $$;
-- Efectos del Venus Pass: solo con el ítem (Premium no los incluye)
create or replace function private.profile_effects_pass() returns text[]
language sql immutable set search_path = '' as $$ select array['season1'] $$;

create or replace function private.card_themes() returns text[]
language sql immutable set search_path = '' as $$ select array['none', 'nether', 'end', 'ocean', 'cherry', 'space', 'aurora'] $$;
create or replace function private.card_bubbles() returns text[]
language sql immutable set search_path = '' as $$ select array['default', 'round', 'pixel', 'sharp'] $$;
create or replace function private.card_entries() returns text[]
language sql immutable set search_path = '' as $$ select array['none', 'spark', 'nether', 'ender', 'snow'] $$;
create or replace function private.skin_poses() returns text[]
language sql immutable set search_path = '' as $$ select array['stand', 'wave', 'sit', 'walk'] $$;
create or replace function private.skin_bgs() returns text[]
language sql immutable set search_path = '' as $$ select array['none', 'sunset', 'cave', 'end', 'snow'] $$;

-- URL pública de la canción de ese usuario en profile-audio (un solo archivo, song.webm, con ?v= para refrescar la caché)
create or replace function private.profile_audio_url(p_user uuid, v jsonb) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(jsonb_typeof(v) = 'string'
     and char_length(v #>> '{}') <= 300
     and (v #>> '{}') ~ ('^https://[a-z0-9]+\.supabase\.co/storage/v1/object/public/profile-audio/' || p_user::text || '/song\.webm(\?v=[0-9]{1,16})?$'), false)
$$;

-- { id, particles? }
create or replace function private.card_theme_ok(v jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_typeof(v) = 'object'
     and jsonb_typeof(v -> 'id') = 'string' and (v ->> 'id') = any (private.card_themes())
     and (not (v ? 'particles') or jsonb_typeof(v -> 'particles') = 'boolean')
     and not exists (select 1 from jsonb_object_keys(v) x where x not in ('id', 'particles')), false)
$$;
-- { style, color? } (color null o #rrggbb)
create or replace function private.card_bubble_ok(v jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_typeof(v) = 'object'
     and jsonb_typeof(v -> 'style') = 'string' and (v ->> 'style') = any (private.card_bubbles())
     and (not (v ? 'color') or jsonb_typeof(v -> 'color') = 'null' or private.hex_color(v -> 'color'))
     and not exists (select 1 from jsonb_object_keys(v) x where x not in ('style', 'color')), false)
$$;
-- null o { url (profile-audio propio), title? (hasta 60) }
create or replace function private.card_song_ok(p_user uuid, v jsonb) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(jsonb_typeof(v) = 'null' or (jsonb_typeof(v) = 'object'
     and private.profile_audio_url(p_user, v -> 'url')
     and (not (v ? 'title') or (jsonb_typeof(v -> 'title') = 'string' and char_length(v ->> 'title') <= 60 and (v ->> 'title') !~ '[\x00-\x1f<>]'))
     and not exists (select 1 from jsonb_object_keys(v) x where x not in ('url', 'title'))), false)
$$;

/**
 * Cambia la personalización del perfil de quien llama. p_patch solo trae lo que cambia:
 *   pronouns, bio, theme, nameStyle, banner, favoriteServers, publicStats (objeto o null), featured, equipped,
 *   cardStyle, links, showcase.
 * Devuelve el perfil personalizado. Errores (errcode 22023): 'bad_<campo>', 'premium_required:<campo>',
 * 'not_owned:<item>'; 'user_banned' / 'user_muted' (42501) para quien no puede usar lo social.
 * (Copia de 0023 con lo nuevo de la 3.1: cardStyle.theme/bubble/entry/song/guestbook y showcase.skinPose/skinBg/rareBadges.)
 */
create or replace function public.profile_customize(p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  premium boolean;
  v jsonb;
  k text;
  el jsonb;
  v_block text;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  v_block := public.moderation_social_block(me);
  if v_block is not null then raise exception '%', v_block using errcode = '42501'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or pg_column_size(p_patch) > 8192 then
    raise exception 'bad_request' using errcode = '22023';
  end if;
  premium := public.venus_is_premium(me);

  for k in select jsonb_object_keys(p_patch) loop
    if k not in ('pronouns', 'bio', 'theme', 'nameStyle', 'banner', 'favoriteServers', 'publicStats', 'featured', 'equipped', 'cardStyle', 'links', 'showcase') then
      raise exception 'bad_field:%', k using errcode = '22023';
    end if;
  end loop;

  if p_patch ? 'pronouns' then
    v := p_patch -> 'pronouns';
    if jsonb_typeof(v) = 'null' or btrim(v #>> '{}') = '' then
      update public.profiles set pronouns = null where id = me;
    elsif jsonb_typeof(v) <> 'string' or char_length(btrim(v #>> '{}')) > 24 or (v #>> '{}') ~ '[\x00-\x1f<>]' then
      raise exception 'bad_pronouns' using errcode = '22023';
    else
      update public.profiles set pronouns = btrim(v #>> '{}') where id = me;
    end if;
  end if;

  if p_patch ? 'bio' then
    v := p_patch -> 'bio';
    if jsonb_typeof(v) = 'null' then
      update public.profiles set bio = null where id = me;
    elsif jsonb_typeof(v) <> 'string' or char_length(v #>> '{}') > 200 then
      raise exception 'bad_bio' using errcode = '22023';
    else
      update public.profiles set bio = nullif(btrim(v #>> '{}'), '') where id = me;
    end if;
  end if;

  if p_patch ? 'theme' then
    v := p_patch -> 'theme';
    if jsonb_typeof(v) <> 'object'
       or (v ? 'from' and not private.hex_color(v -> 'from'))
       or (v ? 'via' and not private.hex_color(v -> 'via'))
       or (v ? 'to' and not private.hex_color(v -> 'to'))
       or (v ? 'angle' and (jsonb_typeof(v -> 'angle') <> 'number' or (v ->> 'angle')::numeric not between 0 and 360))
       or exists (select 1 from jsonb_object_keys(v) x where x not in ('from', 'via', 'to', 'angle')) then
      raise exception 'bad_theme' using errcode = '22023';
    end if;
    update public.profiles set theme = v where id = me;
  end if;

  if p_patch ? 'nameStyle' then
    v := p_patch -> 'nameStyle';
    if jsonb_typeof(v) <> 'object'
       or (v ? 'font' and (jsonb_typeof(v -> 'font') <> 'string' or not ((v ->> 'font') = any (private.profile_fonts()))))
       or (v ? 'effect' and (jsonb_typeof(v -> 'effect') <> 'string' or not ((v ->> 'effect') = any (private.profile_effects()))))
       or (v ? 'color' and not private.hex_color(v -> 'color'))
       or (v ? 'glow' and (jsonb_typeof(v -> 'glow') <> 'number' or (v ->> 'glow')::numeric not between 0 and 100))
       or (v ? 'caps' and jsonb_typeof(v -> 'caps') <> 'boolean')
       or (v ? 'italic' and jsonb_typeof(v -> 'italic') <> 'boolean')
       or (v ? 'outline' and jsonb_typeof(v -> 'outline') <> 'boolean')
       or exists (select 1 from jsonb_object_keys(v) x where x not in ('font', 'effect', 'color', 'glow', 'caps', 'italic', 'outline')) then
      raise exception 'bad_nameStyle' using errcode = '22023';
    end if;
    -- Los del Venus Pass piden el ítem; los premium, Premium o el ítem
    if (v ->> 'effect') = any (private.profile_effects_pass())
       and not exists (select 1 from public.user_items ui join public.shop_items si on si.id = ui.item_id
                        where ui.user_id = me and si.kind = 'name_effect' and si.data ->> 'effect' = v ->> 'effect') then
      raise exception 'not_owned:effect_%', v ->> 'effect' using errcode = '22023';
    end if;
    if (v ->> 'effect') = any (private.profile_effects_premium()) and not premium
       and not exists (select 1 from public.user_items ui join public.shop_items si on si.id = ui.item_id
                        where ui.user_id = me and si.kind = 'name_effect' and si.data ->> 'effect' = v ->> 'effect') then
      raise exception 'premium_required:nameStyle' using errcode = '22023';
    end if;
    update public.profiles set name_style = v where id = me;
  end if;

  if p_patch ? 'banner' then
    v := p_patch -> 'banner';
    if jsonb_typeof(v) <> 'object' or not (v ? 'kind') then raise exception 'bad_banner' using errcode = '22023'; end if;
    if v ->> 'kind' = 'preset' then
      if not ((v ->> 'preset') = any (private.profile_banners())) then raise exception 'bad_banner' using errcode = '22023'; end if;
      v := jsonb_build_object('kind', 'preset', 'preset', v ->> 'preset');
    elsif v ->> 'kind' in ('image', 'animated') then
      if not private.own_media_url(me, v -> 'url') then raise exception 'bad_banner' using errcode = '22023'; end if;
      if v ->> 'kind' = 'animated' and not premium then raise exception 'premium_required:banner' using errcode = '22023'; end if;
      v := jsonb_build_object('kind', v ->> 'kind', 'url', v ->> 'url');
    elsif v ->> 'kind' = 'klipy' then
      if not private.klipy_url(v -> 'url')
         or (v ? 'still' and not private.klipy_url(v -> 'still'))
         or (v ? 'slug' and (jsonb_typeof(v -> 'slug') <> 'string' or (v ->> 'slug') !~ '^[A-Za-z0-9_-]{1,120}$')) then
        raise exception 'bad_banner' using errcode = '22023';
      end if;
      v := jsonb_strip_nulls(jsonb_build_object('kind', 'klipy', 'url', v ->> 'url', 'still', v ->> 'still', 'slug', v ->> 'slug'));
    elsif v ->> 'kind' = 'none' then
      v := '{}'::jsonb;
    else
      raise exception 'bad_banner' using errcode = '22023';
    end if;
    update public.profiles set banner_style = v where id = me;
  end if;

  if p_patch ? 'favoriteServers' then
    v := p_patch -> 'favoriteServers';
    if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) > 5 then raise exception 'bad_favoriteServers' using errcode = '22023'; end if;
    for el in select * from jsonb_array_elements(v) loop
      if jsonb_typeof(el) <> 'object'
         or jsonb_typeof(el -> 'address') <> 'string'
         or (el ->> 'address') !~ '^[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?$'
         or (el ? 'name' and (jsonb_typeof(el -> 'name') <> 'string' or char_length(el ->> 'name') > 40 or (el ->> 'name') ~ '[\x00-\x1f<>]'))
         or exists (select 1 from jsonb_object_keys(el) x where x not in ('address', 'name')) then
        raise exception 'bad_favoriteServers' using errcode = '22023';
      end if;
    end loop;
    update public.profiles set favorite_servers = v where id = me;
  end if;

  if p_patch ? 'publicStats' then
    v := p_patch -> 'publicStats';
    if jsonb_typeof(v) = 'null' then
      update public.profiles set public_stats = null where id = me;
    elsif jsonb_typeof(v) <> 'object'
       or exists (select 1 from jsonb_object_keys(v) x where x not in ('hours', 'sessions', 'topVersion', 'topLoader', 'since', 'daysPlayed', 'bestStreak', 'longestHours', 'versions', 'loaders', 'instances', 'worlds', 'blocks', 'mobs', 'deaths', 'distanceKm'))
       or (v ? 'hours' and (jsonb_typeof(v -> 'hours') <> 'number' or (v ->> 'hours')::numeric not between 0 and 1000000))
       or (v ? 'sessions' and (jsonb_typeof(v -> 'sessions') <> 'number' or (v ->> 'sessions')::numeric not between 0 and 10000000))
       or (v ? 'topVersion' and (jsonb_typeof(v -> 'topVersion') <> 'string' or char_length(v ->> 'topVersion') > 32))
       or (v ? 'topLoader' and (jsonb_typeof(v -> 'topLoader') <> 'string' or char_length(v ->> 'topLoader') > 16))
       or (v ? 'since' and (jsonb_typeof(v -> 'since') <> 'string' or char_length(v ->> 'since') > 32))
       or exists (select 1 from jsonb_each(v) e where e.key in ('daysPlayed', 'bestStreak', 'longestHours', 'versions', 'loaders', 'instances', 'worlds', 'blocks', 'mobs', 'deaths', 'distanceKm')
                    and (jsonb_typeof(e.value) <> 'number' or (e.value #>> '{}')::numeric not between 0 and 1000000000000)) then
      raise exception 'bad_publicStats' using errcode = '22023';
    else
      update public.profiles set public_stats = v || jsonb_build_object('updatedAt', now()) where id = me;
    end if;
  end if;

  if p_patch ? 'featured' then
    v := p_patch -> 'featured';
    if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) > 6 then raise exception 'bad_featured' using errcode = '22023'; end if;
    for el in select * from jsonb_array_elements(v) loop
      if jsonb_typeof(el) <> 'object' or not private.own_media_url(me, el -> 'url')
         or (el ? 'title' and (jsonb_typeof(el -> 'title') <> 'string' or char_length(el ->> 'title') > 60))
         or exists (select 1 from jsonb_object_keys(el) x where x not in ('url', 'title')) then
        raise exception 'bad_featured' using errcode = '22023';
      end if;
    end loop;
    update public.profiles set featured = v where id = me;
  end if;

  if p_patch ? 'equipped' then
    v := p_patch -> 'equipped';
    if jsonb_typeof(v) <> 'object' then raise exception 'bad_equipped' using errcode = '22023'; end if;
    for k in select jsonb_object_keys(v) loop
      if k not in ('frame', 'nameEffect', 'badgeStyle', 'title') then raise exception 'bad_equipped' using errcode = '22023'; end if;
      if jsonb_typeof(v -> k) = 'null' then continue; end if;
      -- Solo cosas compradas (o premium: lo premium de la tienda viene incluido)
      if not exists (
        select 1 from public.shop_items si
         where si.id = v ->> k and si.active
           and si.kind = case k when 'frame' then 'frame' when 'nameEffect' then 'name_effect' when 'badgeStyle' then 'badge_style' else 'title' end
           and ((si.premium_only and premium) or exists (select 1 from public.user_items ui where ui.user_id = me and ui.item_id = si.id))
      ) then
        raise exception 'not_owned:%', v ->> k using errcode = '22023';
      end if;
    end loop;
    update public.profiles set equipped = jsonb_strip_nulls(v) where id = me;
  end if;

  if p_patch ? 'cardStyle' then
    v := p_patch -> 'cardStyle';
    if jsonb_typeof(v) <> 'object'
       or (v ? 'pattern' and (v ->> 'pattern') not in ('none', 'dots', 'grid', 'stripes', 'stars', 'pixels', 'waves', 'hex', 'circuit'))
       or (v ? 'avatar' and (v ->> 'avatar') not in ('square', 'round', 'hex'))
       or (v ? 'layout' and (v ->> 'layout') not in ('classic', 'center'))
       or (v ? 'accent' and not private.hex_color(v -> 'accent'))
       or (v ? 'theme' and not private.card_theme_ok(v -> 'theme'))
       or (v ? 'bubble' and not private.card_bubble_ok(v -> 'bubble'))
       or (v ? 'entry' and (jsonb_typeof(v -> 'entry') <> 'string' or not ((v ->> 'entry') = any (private.card_entries()))))
       or (v ? 'guestbook' and jsonb_typeof(v -> 'guestbook') <> 'boolean')
       or (v ? 'song' and not private.card_song_ok(me, v -> 'song'))
       or exists (select 1 from jsonb_object_keys(v) x where x not in ('pattern', 'avatar', 'layout', 'accent', 'theme', 'bubble', 'entry', 'song', 'guestbook')) then
      raise exception 'bad_cardStyle' using errcode = '22023';
    end if;
    -- Partículas del tema: Premium (o el ítem extra_particles)
    if coalesce((v -> 'theme' ->> 'particles')::boolean, false) and not premium
       and not exists (select 1 from public.user_items ui where ui.user_id = me and ui.item_id = 'extra_particles') then
      raise exception 'premium_required:cardStyle' using errcode = '22023';
    end if;
    update public.profiles set card_style = jsonb_strip_nulls(v) where id = me;
  end if;

  if p_patch ? 'links' then
    v := p_patch -> 'links';
    if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) > 5 then raise exception 'bad_links' using errcode = '22023'; end if;
    for el in select * from jsonb_array_elements(v) loop
      if jsonb_typeof(el) <> 'object' or jsonb_typeof(el -> 'kind') <> 'string' or jsonb_typeof(el -> 'url') <> 'string'
         or not private.profile_link_ok(el ->> 'kind', el ->> 'url')
         or exists (select 1 from jsonb_object_keys(el) x where x not in ('kind', 'url')) then
        raise exception 'bad_links' using errcode = '22023';
      end if;
    end loop;
    update public.profiles set links = v where id = me;
  end if;

  if p_patch ? 'showcase' then
    v := p_patch -> 'showcase';
    if jsonb_typeof(v) <> 'object'
       or exists (select 1 from jsonb_object_keys(v) x where x not in ('achievements', 'clips', 'skin', 'skinPose', 'skinBg', 'rareBadges'))
       or (v ? 'skin' and jsonb_typeof(v -> 'skin') <> 'boolean')
       or (v ? 'skinPose' and (jsonb_typeof(v -> 'skinPose') <> 'string' or not ((v ->> 'skinPose') = any (private.skin_poses()))))
       or (v ? 'skinBg' and (jsonb_typeof(v -> 'skinBg') <> 'string' or not ((v ->> 'skinBg') = any (private.skin_bgs()))))
       or (v ? 'achievements' and (jsonb_typeof(v -> 'achievements') <> 'array' or jsonb_array_length(v -> 'achievements') > 6))
       or (v ? 'rareBadges' and (jsonb_typeof(v -> 'rareBadges') <> 'array' or jsonb_array_length(v -> 'rareBadges') > 3))
       or (v ? 'clips' and (jsonb_typeof(v -> 'clips') <> 'array' or jsonb_array_length(v -> 'clips') > 2)) then
      raise exception 'bad_showcase' using errcode = '22023';
    end if;
    -- Solo logros que la cuenta desbloqueó (destacados e insignias raras)
    for el in select * from jsonb_array_elements(coalesce(v -> 'achievements', '[]'::jsonb) || coalesce(v -> 'rareBadges', '[]'::jsonb)) loop
      if jsonb_typeof(el) <> 'string' or not exists (select 1 from public.user_achievements ua where ua.user_id = me and ua.achievement_id = el #>> '{}') then
        raise exception 'bad_showcase' using errcode = '22023';
      end if;
    end loop;
    if v ? 'clips' then
      for el in select * from jsonb_array_elements(v -> 'clips') loop
        -- Solo clips compartidos por esta cuenta
        if jsonb_typeof(el) <> 'string' or (el #>> '{}') !~ '^[0-9a-fA-F-]{36}$'
           or not exists (select 1 from public.shared_media m where m.id = (el #>> '{}')::uuid and m.owner = me and m.kind = 'clip') then
          raise exception 'bad_showcase' using errcode = '22023';
        end if;
      end loop;
    end if;
    update public.profiles set showcase = v where id = me;
  end if;

  update public.profiles set customized_at = now() where id = me;
  select jsonb_build_object(
    'pronouns', p.pronouns, 'bio', p.bio, 'theme', p.theme, 'nameStyle', p.name_style, 'banner', p.banner_style,
    'favoriteServers', p.favorite_servers, 'publicStats', p.public_stats, 'featured', p.featured,
    'equipped', p.equipped, 'cardStyle', p.card_style, 'links', p.links, 'showcase', p.showcase,
    'rank', p.rank, 'premium', premium)
    into v from public.profiles p where p.id = me;
  return v;
end $$;

-- Perfil de cualquier usuario con lo personalizado (lo que dibuja la tarjeta de perfil).
-- La canción (cardStyle.song) solo va para los amigos y el dueño; el estado vencido va vacío.
create or replace function public.profile_public(p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', p.id, 'username', p.username, 'displayName', p.display_name, 'friendCode', p.friend_code,
    'mcName', p.mc_name, 'bio', p.bio, 'badges', to_jsonb(p.badges), 'pronouns', p.pronouns, 'theme', p.theme,
    'nameStyle', p.name_style, 'banner', p.banner_style, 'favoriteServers', p.favorite_servers,
    'publicStats', p.public_stats, 'featured', p.featured, 'equipped', p.equipped,
    'cardStyle', p.card_style - 'song', 'links', p.links, 'rank', p.rank,
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
    'achievementCount', (select count(*) from public.user_achievements ua where ua.user_id = p.id),
    'achievementTotal', (select count(*) from public.achievements a where a.active),
    'premium', public.venus_is_premium(p.id), 'createdAt', p.created_at)
  from public.profiles p
  where p.id = p_user and auth.uid() is not null
$$;

-- ---------- Estado con emoji y vencimiento ----------
-- Guarda "<emoji> <texto>" en status_text y hasta cuándo vale. Errores (22023): bad_emoji, bad_status, bad_until.
create or replace function public.profile_set_status(p_emoji text, p_text text, p_until timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_emoji text := nullif(btrim(coalesce(p_emoji, '')), '');
  v_text text := nullif(btrim(coalesce(p_text, '')), '');
  v_full text;
  v_until timestamptz;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if public.moderation_social_block(me) = 'user_banned' then raise exception 'user_banned' using errcode = '42501'; end if;
  -- Un solo símbolo (hasta 8 puntos de código: variantes, tono de piel y uniones), fuera del ASCII y sin letras,
  -- números, espacios ni controles. El launcher además lo elige de una grilla fija.
  if v_emoji is not null and (char_length(v_emoji) > 8 or v_emoji ~ '[[:space:][:cntrl:][:alnum:][:punct:]]' or ascii(substr(v_emoji, 1, 1)) < 8592) then
    raise exception 'bad_emoji' using errcode = '22023';
  end if;
  if v_text is not null and (char_length(v_text) > 70 or v_text ~ '[\x00-\x1f]') then
    raise exception 'bad_status' using errcode = '22023';
  end if;
  if p_until is not null and (p_until < now() or p_until > now() + interval '32 days') then
    raise exception 'bad_until' using errcode = '22023';
  end if;
  v_full := nullif(concat_ws(' ', v_emoji, v_text), '');
  v_until := case when v_full is null then null else p_until end;
  update public.profiles set status_text = v_full, status_until = v_until where id = me;
  return jsonb_build_object('statusText', v_full, 'statusUntil', v_until);
end $$;

-- ---------- Libro de visitas ----------
create table if not exists public.profile_guestbook (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users (id) on delete cascade,
  author uuid not null references auth.users (id) on delete cascade,
  body text not null check (char_length(body) between 1 and 200),
  created_at timestamptz not null default now()
);
create index if not exists profile_guestbook_owner on public.profile_guestbook (owner, created_at desc);
create index if not exists profile_guestbook_author on public.profile_guestbook (author, created_at desc);
alter table public.profile_guestbook enable row level security;
-- Todo pasa por las funciones de abajo: nadie lee ni escribe la tabla directo
revoke all on public.profile_guestbook from anon, authenticated;

create or replace function private.guestbook_entry(p_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', g.id, 'owner', g.owner, 'body', g.body, 'at', g.created_at,
    'author', jsonb_build_object('id', a.id, 'username', a.username, 'displayName', a.display_name, 'mcName', a.mc_name, 'mcUuid', a.mc_uuid))
    from public.profile_guestbook g left join public.profiles a on a.id = g.author where g.id = p_id
$$;

-- Las últimas 10 entradas del libro de p_owner (anteriores a p_before para "ver más"). Vacío si el dueño lo apagó.
create or replace function public.guestbook_list(p_owner uuid, p_before timestamptz default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if p_owner is null then return '[]'::jsonb; end if;
  if me <> p_owner and not coalesce((select (p.card_style ->> 'guestbook')::boolean from public.profiles p where p.id = p_owner), false) then
    return '[]'::jsonb;
  end if;
  return coalesce((select jsonb_agg(private.guestbook_entry(g.id) order by g.created_at desc)
                     from (select x.id, x.created_at from public.profile_guestbook x
                            where x.owner = p_owner and (p_before is null or x.created_at < p_before)
                            order by x.created_at desc limit 10) g), '[]'::jsonb);
end $$;

-- Escribe en el libro de un amigo (o en el propio). 5 por día por autor. Errores (22023): bad_owner, not_friends,
-- blocked, owner_banned, guestbook_off, bad_body, too_many_today; user_banned / user_muted (42501).
create or replace function public.guestbook_post(p_owner uuid, p_body text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_block text;
  v_body text := btrim(coalesce(p_body, ''));
  v_id uuid;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  v_block := public.moderation_social_block(me);
  if v_block is not null then raise exception '%', v_block using errcode = '42501'; end if;
  if p_owner is null or not exists (select 1 from public.profiles p where p.id = p_owner) then raise exception 'bad_owner' using errcode = '22023'; end if;
  if p_owner <> me and not private.are_friends(me, p_owner) then raise exception 'not_friends' using errcode = '22023'; end if;
  if exists (select 1 from public.friendships f where f.status = 'blocked' and ((f.requester = me and f.addressee = p_owner) or (f.requester = p_owner and f.addressee = me))) then
    raise exception 'blocked' using errcode = '22023';
  end if;
  if public.moderation_social_block(p_owner) = 'user_banned' then raise exception 'owner_banned' using errcode = '22023'; end if;
  if not coalesce((select (p.card_style ->> 'guestbook')::boolean from public.profiles p where p.id = p_owner), false) then
    raise exception 'guestbook_off' using errcode = '22023';
  end if;
  if v_body = '' or char_length(v_body) > 200 or v_body ~ '[\x00-\x08\x0b-\x1f]' then raise exception 'bad_body' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext('guestbook:' || me::text));
  if (select count(*) from public.profile_guestbook g where g.author = me and g.created_at > now() - interval '1 day') >= 5 then
    raise exception 'too_many_today' using errcode = '22023';
  end if;
  insert into public.profile_guestbook (owner, author, body) values (p_owner, me, v_body) returning id into v_id;
  return private.guestbook_entry(v_id);
end $$;

-- Borra una entrada: el autor o el dueño del libro. Devuelve true si borró algo.
create or replace function public.guestbook_delete(p_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); n integer;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  delete from public.profile_guestbook g where g.id = p_id and (g.author = me or g.owner = me);
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- Prende o apaga el libro propio (card_style.guestbook)
create or replace function public.guestbook_set(p_enabled boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if public.moderation_social_block(me) = 'user_banned' then raise exception 'user_banned' using errcode = '42501'; end if;
  update public.profiles set card_style = card_style || jsonb_build_object('guestbook', coalesce(p_enabled, false)) where id = me;
  return jsonb_build_object('guestbook', coalesce(p_enabled, false));
end $$;

-- ---------- Regalos ----------
alter table public.points_ledger drop constraint if exists points_ledger_reason_check;
alter table public.points_ledger add constraint points_ledger_reason_check
  check (reason in ('daily', 'achievement', 'referral', 'referred', 'shop', 'admin', 'mission', 'pass', 'pass_refund', 'gift_in', 'gift_out'));

-- Registro de regalos (puntos y cosméticos): la bandeja del que recibe y la revisión del equipo
create table if not exists public.profile_gifts (
  id uuid primary key default gen_random_uuid(),
  sender uuid not null references auth.users (id) on delete cascade,
  receiver uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('points', 'item')),
  value text not null check (char_length(value) between 1 and 40),
  points integer not null check (points >= 0),
  created_at timestamptz not null default now()
);
create index if not exists profile_gifts_receiver on public.profile_gifts (receiver, created_at desc);
create index if not exists profile_gifts_sender on public.profile_gifts (sender, created_at desc);
alter table public.profile_gifts enable row level security;
revoke all on public.profile_gifts from anon, authenticated;

/**
 * Regala a un amigo. p_kind 'points' (p_value: cantidad, de 10 a 500; hasta 1000 por día) o 'item' (p_value: id de
 * shop_items; se paga el precio normal; no si ya lo tiene ni si es premium_only). Errores (22023): bad_target,
 * not_friends, blocked, target_banned, bad_kind, bad_amount, daily_limit, not_enough_points, bad_item, premium_item, owned.
 * Devuelve { ok, kind, value, points, balance }.
 */
create or replace function public.gift_send(p_to uuid, p_kind text, p_value text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_block text;
  v_n integer;
  v_today integer;
  v_balance integer;
  v_stamp text;
  it record;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  v_block := public.moderation_social_block(me);
  if v_block is not null then raise exception '%', v_block using errcode = '42501'; end if;
  if p_to is null or p_to = me or not exists (select 1 from public.profiles p where p.id = p_to) then raise exception 'bad_target' using errcode = '22023'; end if;
  if not private.are_friends(me, p_to) then raise exception 'not_friends' using errcode = '22023'; end if;
  if exists (select 1 from public.friendships f where f.status = 'blocked' and ((f.requester = me and f.addressee = p_to) or (f.requester = p_to and f.addressee = me))) then
    raise exception 'blocked' using errcode = '22023';
  end if;
  if public.moderation_social_block(p_to) = 'user_banned' then raise exception 'target_banned' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext('points:' || me::text));
  v_balance := private.points_balance(me);
  v_stamp := to_char(clock_timestamp() at time zone 'utc', 'YYYYMMDDHH24MISSMS');
  if p_kind = 'points' then
    if coalesce(p_value, '') !~ '^[0-9]{1,4}$' then raise exception 'bad_amount' using errcode = '22023'; end if;
    v_n := p_value::integer;
    if v_n < 10 or v_n > 500 then raise exception 'bad_amount' using errcode = '22023'; end if;
    v_today := coalesce((select -sum(l.delta) from public.points_ledger l where l.user_id = me and l.reason = 'gift_out' and l.created_at > now() - interval '1 day'), 0);
    if v_today + v_n > 1000 then raise exception 'daily_limit' using errcode = '22023'; end if;
    if v_balance < v_n then raise exception 'not_enough_points' using errcode = '22023'; end if;
    perform private.points_award(me, -v_n, 'gift_out', p_to::text || ':' || v_stamp);
    perform private.points_award(p_to, v_n, 'gift_in', me::text || ':' || v_stamp);
    insert into public.profile_gifts (sender, receiver, kind, value, points) values (me, p_to, 'points', v_n::text, v_n);
    return jsonb_build_object('ok', true, 'kind', 'points', 'value', v_n::text, 'points', v_n, 'balance', private.points_balance(me));
  elsif p_kind = 'item' then
    select * into it from public.shop_items si where si.id = p_value and si.active;
    if not found then raise exception 'bad_item' using errcode = '22023'; end if;
    if it.premium_only then raise exception 'premium_item' using errcode = '22023'; end if;
    if exists (select 1 from public.user_items ui where ui.user_id = p_to and ui.item_id = it.id) then raise exception 'owned' using errcode = '22023'; end if;
    if v_balance < it.price then raise exception 'not_enough_points' using errcode = '22023'; end if;
    if it.price > 0 then perform private.points_award(me, -it.price, 'gift_out', p_to::text || ':' || it.id); end if;
    insert into public.user_items (user_id, item_id) values (p_to, it.id) on conflict do nothing;
    insert into public.profile_gifts (sender, receiver, kind, value, points) values (me, p_to, 'item', it.id, it.price);
    return jsonb_build_object('ok', true, 'kind', 'item', 'value', it.id, 'points', it.price, 'balance', private.points_balance(me));
  end if;
  raise exception 'bad_kind' using errcode = '22023';
end $$;

-- Regalos recibidos después de p_since (los últimos 20), con quién los mandó: la bandeja del que recibe.
create or replace function public.gifts_received(p_since timestamptz default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'kind', g.kind, 'value', g.value, 'points', g.points, 'at', g.created_at,
                            'from', jsonb_build_object('id', s.id, 'username', s.username, 'displayName', s.display_name)) order by g.created_at desc)
                     from (select * from public.profile_gifts x where x.receiver = me and (p_since is null or x.created_at > p_since)
                            order by x.created_at desc limit 20) g
                     left join public.profiles s on s.id = g.sender), '[]'::jsonb);
end $$;

-- ---------- Denuncias de perfiles ----------
create table if not exists public.profile_reports (
  id uuid primary key default gen_random_uuid(),
  reporter uuid not null references auth.users (id) on delete cascade,
  target uuid not null references auth.users (id) on delete cascade,
  reason text not null check (reason in ('song', 'content')),
  text text check (char_length(text) <= 300),
  status text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  closed_by uuid references auth.users (id) on delete set null
);
create index if not exists profile_reports_status on public.profile_reports (status, created_at desc);
create index if not exists profile_reports_reporter on public.profile_reports (reporter, created_at desc);
alter table public.profile_reports enable row level security;
revoke all on public.profile_reports from anon, authenticated;

-- Denuncia un perfil ('song': la canción; 'content': el resto). 10 por día. Errores (22023): bad_target, bad_reason,
-- bad_text, too_many_today.
create or replace function public.profile_report(p_user uuid, p_reason text, p_text text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_text text := nullif(btrim(coalesce(p_text, '')), '');
  v_id uuid;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if public.moderation_social_block(me) = 'user_banned' then raise exception 'user_banned' using errcode = '42501'; end if;
  if p_user is null or p_user = me or not exists (select 1 from public.profiles p where p.id = p_user) then raise exception 'bad_target' using errcode = '22023'; end if;
  if p_reason not in ('song', 'content') then raise exception 'bad_reason' using errcode = '22023'; end if;
  if v_text is not null and (char_length(v_text) > 300 or v_text ~ '[\x00-\x08\x0b-\x1f]') then raise exception 'bad_text' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext('reports:' || me::text));
  if (select count(*) from public.profile_reports r where r.reporter = me and r.created_at > now() - interval '1 day') >= 10 then
    raise exception 'too_many_today' using errcode = '22023';
  end if;
  insert into public.profile_reports (reporter, target, reason, text) values (me, p_user, p_reason, v_text) returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- Panel de administración: las denuncias abiertas (hasta 200) y las últimas 50 cerradas, con la canción del denunciado.
create or replace function public.admin_profile_reports() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.admin_guard();
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', r.id, 'reason', r.reason, 'text', r.text, 'status', r.status, 'at', r.created_at, 'closedAt', r.closed_at,
      'reporter', jsonb_build_object('id', a.id, 'username', a.username, 'displayName', a.display_name),
      'target', jsonb_build_object('id', b.id, 'username', b.username, 'displayName', b.display_name, 'song', b.card_style -> 'song', 'bio', b.bio))
      order by (r.status = 'open') desc, r.created_at desc)
    from ((select * from public.profile_reports x where x.status = 'open' order by x.created_at desc limit 200)
          union all
          (select * from public.profile_reports x where x.status = 'closed' order by x.created_at desc limit 50)) r
    left join public.profiles a on a.id = r.reporter
    left join public.profiles b on b.id = r.target), '[]'::jsonb);
end $$;

-- Cierra una denuncia; con p_remove_song saca la canción del perfil denunciado (el archivo queda hasta que el dueño suba otra).
create or replace function public.admin_profile_report_close(p_id uuid, p_remove_song boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  r record;
begin
  perform public.admin_guard();
  select * into r from public.profile_reports x where x.id = p_id;
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
  update public.profile_reports set status = 'closed', closed_at = now(), closed_by = me where id = p_id;
  if coalesce(p_remove_song, false) then
    update public.profiles set card_style = card_style - 'song' where id = r.target;
  end if;
  perform public.admin_log(me, (select email from auth.users where id = me), 'report.close', r.target, jsonb_build_object('report', p_id, 'reason', r.reason, 'removeSong', coalesce(p_remove_song, false)));
  return jsonb_build_object('ok', true, 'id', p_id, 'removedSong', coalesce(p_remove_song, false));
end $$;

-- ---------- Tienda: marcos animados y de temporada (se venden todo el año) ----------
insert into public.shop_items (id, kind, price, premium_only, sort, data) values
  ('frame_pulse', 'frame', 1800, false, 260, '{"style":"pulse"}'),
  ('frame_orbit', 'frame', 2400, false, 261, '{"style":"orbit"}'),
  ('frame_halloween', 'frame', 1200, false, 262, '{"style":"halloween"}'),
  ('frame_xmas', 'frame', 1200, false, 263, '{"style":"xmas"}')
on conflict (id) do update set kind = excluded.kind, price = excluded.price, premium_only = excluded.premium_only,
  sort = excluded.sort, data = excluded.data;

-- ---------- Bucket público profile-audio (la canción del perfil: <uid>/song.webm, audio/webm, 1 MB) ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('profile-audio', 'profile-audio', true, 1048576, array['audio/webm'])
on conflict (id) do update
  set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "profile_audio_insert_own" on storage.objects;
create policy "profile_audio_insert_own" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'profile-audio'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and array_length(storage.foldername(name), 1) = 1
    and storage.filename(name) = 'song.webm'
  );
drop policy if exists "profile_audio_update_own" on storage.objects;
create policy "profile_audio_update_own" on storage.objects
  for update to authenticated
  using (bucket_id = 'profile-audio' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'profile-audio' and (storage.foldername(name))[1] = (select auth.uid())::text and storage.filename(name) = 'song.webm');
drop policy if exists "profile_audio_delete_own" on storage.objects;
create policy "profile_audio_delete_own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'profile-audio' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "profile_audio_select_own" on storage.objects;
create policy "profile_audio_select_own" on storage.objects
  for select to authenticated
  using (bucket_id = 'profile-audio' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- ---------- Permisos ----------
revoke all on function private.profile_effects_pass(), private.card_themes(), private.card_bubbles(), private.card_entries(),
  private.skin_poses(), private.skin_bgs(), private.profile_audio_url(uuid, jsonb), private.card_theme_ok(jsonb),
  private.card_bubble_ok(jsonb), private.card_song_ok(uuid, jsonb), private.guestbook_entry(uuid) from public, anon, authenticated;
revoke all on function public.profile_customize(jsonb) from public, anon;
revoke all on function public.profile_public(uuid) from public, anon;
revoke all on function public.profile_set_status(text, text, timestamptz) from public, anon;
revoke all on function public.guestbook_list(uuid, timestamptz) from public, anon;
revoke all on function public.guestbook_post(uuid, text) from public, anon;
revoke all on function public.guestbook_delete(uuid) from public, anon;
revoke all on function public.guestbook_set(boolean) from public, anon;
revoke all on function public.gift_send(uuid, text, text) from public, anon;
revoke all on function public.gifts_received(timestamptz) from public, anon;
revoke all on function public.profile_report(uuid, text, text) from public, anon;
revoke all on function public.admin_profile_reports() from public, anon;
revoke all on function public.admin_profile_report_close(uuid, boolean) from public, anon;
grant execute on function public.profile_customize(jsonb) to authenticated;
grant execute on function public.profile_public(uuid) to authenticated;
grant execute on function public.profile_set_status(text, text, timestamptz) to authenticated;
grant execute on function public.guestbook_list(uuid, timestamptz) to authenticated;
grant execute on function public.guestbook_post(uuid, text) to authenticated;
grant execute on function public.guestbook_delete(uuid) to authenticated;
grant execute on function public.guestbook_set(boolean) to authenticated;
grant execute on function public.gift_send(uuid, text, text) to authenticated;
grant execute on function public.gifts_received(timestamptz) to authenticated;
grant execute on function public.profile_report(uuid, text, text) to authenticated;
grant execute on function public.admin_profile_reports() to authenticated;
grant execute on function public.admin_profile_report_close(uuid, boolean) to authenticated;
