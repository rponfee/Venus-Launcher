-- 0039_perfil_circular_banners.sql · Venus 4.6 · Avatar siempre circular y banners sin diseños ni GIF propios
-- Guía: docs/perfiles.md y docs/wip/perfil-46.md. Se aplica después de 0027 (la última que redefine profile_customize y
-- profile_public: en producción son idénticas a las de 0027, se comprobó con md5 de pg_proc.prosrc) y de 0037. Idempotente.
-- Quien redefina profile_customize o profile_public después (marcos 0040, canción 0042) tiene que partir de ESTA versión.
--
--   * Avatar: el dibujo de la cabeza es siempre un círculo y no se elige. cardStyle.avatar solo acepta 'round' (cuadrada y
--     hexagonal ya no existen) y profile_customize lo guarda siempre; profile_public siempre lo devuelve 'round'. Los perfiles
--     existentes se pasan a 'round' acá mismo, para que las versiones viejas del launcher (que leen la tabla) también lo dibujen redondo.
--   * Banner: se sacan los diseños prediseñados (banner_style.kind = 'preset') y el GIF propio de Premium ('animated'). Quedan el
--     color clásico (banner_style vacío, el de siempre, que es el de por defecto), el GIF de KLIPY ('klipy') y la imagen propia
--     quieta ('image': webp, jpg o png). Los perfiles con 'preset' o 'animated' pasan al color clásico.
--   * Imagen propia: en el servidor se acepta solo por la ruta (private.banner_image_url: banner[-id].webp|jpg|jpeg|png en la
--     carpeta del usuario) y el bucket profile-media deja de aceptar gif para todos, Premium incluido. La ruta no prueba que un
--     webp o un png esté quieto: eso lo mira el launcher por el contenido del archivo antes de subirlo (features/profile-editor/media.js).
--   * No se toca la canción (private.card_song_ok, agente G) ni la validación de los marcos de equipped (agente D).

-- ---------- Ayudante: URL de una imagen de banner propia ----------
-- https://<proyecto>.supabase.co/storage/v1/object/public/profile-media/<uid>/banner[-<id>].(webp|jpg|jpeg|png)
create or replace function private.banner_image_url(p_user uuid, v jsonb) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(jsonb_typeof(v) = 'string'
     and char_length(v #>> '{}') <= 400
     and (v #>> '{}') ~ ('^https://[a-z0-9]+\.supabase\.co/storage/v1/object/public/profile-media/' || p_user::text || '/banner(-[A-Za-z0-9_-]{1,64})?\.(webp|jpg|jpeg|png)$'), false)
$$;

-- ---------- Datos existentes ----------
-- Banner: los diseños y los GIF propios pasan al color clásico (el de la columna banner de siempre, que no se toca); una imagen
-- que no cumple la regla de arriba (por ejemplo, apuntaba a un .gif) también
update public.profiles set banner_style = '{}'::jsonb
 where banner_style ->> 'kind' in ('preset', 'animated')
    or (banner_style ->> 'kind' = 'image' and not private.banner_image_url(id, banner_style -> 'url'));
-- Avatar: siempre redondo (la guarda de tamaño es por profiles_custom3_size, que pide menos de 2 KB en card_style)
update public.profiles set card_style = (card_style - 'avatar') || jsonb_build_object('avatar', 'round')
 where card_style ->> 'avatar' is distinct from 'round' and pg_column_size(card_style) < 1900;

-- ---------- Bucket profile-media: sin gif para nadie ----------
-- (los banners y las capturas destacadas se achican y se pasan a webp o jpg en la PC antes de subirse)
update storage.buckets set allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp'] where id = 'profile-media';

drop policy if exists "profile_media_insert_own" on storage.objects;
create policy "profile_media_insert_own" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'profile-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and array_length(storage.foldername(name), 1) = 1
    and storage.filename(name) ~ '^[A-Za-z0-9._-]{1,80}$'
    and private.profile_media_count((select auth.uid())) < 12
    and lower(storage.extension(name)) in ('webp', 'jpg', 'jpeg', 'png')
  );

drop policy if exists "profile_media_update_own" on storage.objects;
create policy "profile_media_update_own" on storage.objects
  for update to authenticated
  using (bucket_id = 'profile-media' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (
    bucket_id = 'profile-media' and (storage.foldername(name))[1] = (select auth.uid())::text
    and lower(storage.extension(name)) in ('webp', 'jpg', 'jpeg', 'png')
  );

/**
 * Cambia la personalización del perfil de quien llama. p_patch solo trae lo que cambia:
 *   pronouns, bio, theme, nameStyle, banner, favoriteServers, publicStats (objeto o null), featured, equipped,
 *   cardStyle, links, showcase.
 * Devuelve el perfil personalizado. Errores (errcode 22023): 'bad_<campo>', 'premium_required:<campo>',
 * 'not_owned:<item>'; 'user_banned' / 'user_muted' (42501) para quien no puede usar lo social.
 * (Copia de 0027 con lo de la 4.6: banner solo 'none' | 'image' (quieta, de la carpeta propia) | 'klipy', sin 'preset' ni 'animated',
 * y cardStyle.avatar solo 'round', que se guarda siempre.)
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
    if v ->> 'kind' = 'image' then
      -- Imagen propia quieta: solo webp, jpg o png con nombre de banner, en la carpeta del propio usuario (nunca gif ni apng)
      if not private.banner_image_url(me, v -> 'url') then raise exception 'bad_banner' using errcode = '22023'; end if;
      v := jsonb_build_object('kind', 'image', 'url', v ->> 'url');
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
       or (v ? 'avatar' and (jsonb_typeof(v -> 'avatar') <> 'string' or (v ->> 'avatar') <> 'round'))
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
    -- El avatar es siempre redondo: se guarda 'round' lo mande o no el launcher (las versiones viejas lo leen directo de la tabla)
    update public.profiles set card_style = jsonb_strip_nulls(v) || jsonb_build_object('avatar', 'round') where id = me;
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
-- (Copia de 0027 con lo de la 4.6: el banner viejo (preset, animated o una imagen que no cumple la regla) va como color clásico y el avatar siempre 'round'.)
create or replace function public.profile_public(p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
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
    'achievementCount', (select count(*) from public.user_achievements ua where ua.user_id = p.id),
    'achievementTotal', (select count(*) from public.achievements a where a.active),
    'premium', public.venus_is_premium(p.id), 'createdAt', p.created_at)
  from public.profiles p
  where p.id = p_user and auth.uid() is not null
$$;

-- ---------- Permisos ----------
revoke all on function private.banner_image_url(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.profile_customize(jsonb) from public, anon;
revoke all on function public.profile_public(uuid) from public, anon;
grant execute on function public.profile_customize(jsonb) to authenticated;
grant execute on function public.profile_public(uuid) to authenticated;

-- Sin uso desde esta migración (se dejan por si hay que volver atrás; se pueden borrar con un drop function):
--   private.profile_banners()  -- la lista de los 16 diseños; profile_customize ya no la mira
