-- 0023_venus3.sql · Venus 3.0 · Rangos, más personalización del perfil, vitrina detallada, KLIPY, logros sin tope y misiones
-- Guías: docs/perfiles.md y docs/venus-points.md. Se aplica después de 0022. El catálogo de logros y misiones se carga
-- en la migración generada que le sigue (scripts/gen-achievements-sql.js). Idempotente.
--
--   * Rango (helper, mod, admin, owner): columna de profiles que el usuario no puede escribir (solo admin_set_rank).
--     Es lo que se ve en el perfil; el acceso al panel de administración sigue siendo app_admins.
--   * Perfil: estilo de la tarjeta (dibujo de fondo, forma de la cabeza, acento, disposición), redes, fade de tres
--     colores, nombre en mayúsculas, cursiva o con contorno, 28 tipografías, 8 banners, 9 efectos, 9 marcos y 12 títulos.
--   * Vitrina: logros y clips destacados, skin en 3D, hasta 6 capturas y más estadísticas.
--   * KLIPY: banner con un GIF elegido en el launcher. Las condiciones de KLIPY piden que los pedidos salgan de la app
--     del usuario, así que el servidor no hace de intermediario: guarda la clave en el Vault y se la da al launcher.
--   * Logros: cada fila dice qué medida y objetivo la cumplen; achievements_sweep comprueba los del servidor de una vez.
--   * Misiones: 3 diarias y 3 semanales por usuario, elegidas siempre igual para cada período.

-- ---------- Columnas nuevas (ninguna se puede escribir directo: 0001 solo da UPDATE sobre columnas listadas) ----------
alter table public.profiles add column if not exists rank text;
do $$ begin
  alter table public.profiles add constraint profiles_rank_valid check (rank is null or rank in ('helper', 'mod', 'admin', 'owner'));
exception when duplicate_object then null; end $$;
-- { pattern, avatar, accent: '#rrggbb', layout }
alter table public.profiles add column if not exists card_style jsonb not null default '{}'::jsonb;
-- [{ kind, url }] hasta 5
alter table public.profiles add column if not exists links jsonb not null default '[]'::jsonb;
-- { achievements: [ids], clips: [ids de shared_media], skin: true }
alter table public.profiles add column if not exists showcase jsonb not null default '{}'::jsonb;
do $$ begin
  alter table public.profiles add constraint profiles_custom3_size check (
    pg_column_size(card_style) < 512 and pg_column_size(links) < 2048 and pg_column_size(showcase) < 1024);
exception when duplicate_object then null; end $$;

-- ---------- Catálogo que conoce el servidor ----------
create or replace function private.profile_fonts() returns text[]
language sql immutable set search_path = '' as $$ select array[
  'default', 'pixel', 'outfit', 'serif', 'mono', 'rounded', 'condensed',
  'press', 'vt323', 'silkscreen', 'elite', 'orbitron', 'audiowide', 'exo', 'blackops', 'russo', 'bungee', 'righteous',
  'bangers', 'creepster', 'monoton', 'anton', 'bebas', 'oswald', 'lobster', 'pacifico', 'dancing', 'caveat', 'marker',
  'cinzel', 'playfair', 'abril', 'fredoka', 'comfortaa', 'baloo'] $$;
create or replace function private.profile_effects() returns text[]
language sql immutable set search_path = '' as $$ select array[
  'none', 'glow', 'gradient', 'shimmer', 'rainbow', 'fire',
  'neon', 'ice', 'ocean', 'sakura', 'toxic', 'vapor', 'gold', 'galaxy', 'glitch'] $$;
create or replace function private.profile_effects_premium() returns text[]
language sql immutable set search_path = '' as $$ select array[
  'shimmer', 'rainbow', 'fire', 'neon', 'ice', 'ocean', 'sakura', 'toxic', 'vapor', 'gold', 'galaxy', 'glitch'] $$;
create or replace function private.profile_banners() returns text[]
language sql immutable set search_path = '' as $$ select array[
  'stars', 'sunset', 'nebula', 'forest', 'ocean', 'nether', 'end', 'aurora',
  'cherry', 'desert', 'snow', 'deepdark', 'lush', 'mesa', 'mushroom', 'void'] $$;

-- URL de KLIPY tal como la devuelve su API (dominios de static.klipy.com, con los parámetros que traiga)
create or replace function private.klipy_url(v jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(v) = 'string' and char_length(v #>> '{}') <= 400
     and (v #>> '{}') ~ '^https://static[0-9]*\.klipy\.com/[A-Za-z0-9/._~-]+(\?[A-Za-z0-9=&._~%-]*)?$'
$$;

-- Redes del perfil: solo estos sitios, con https
create or replace function private.profile_link_ok(p_kind text, p_url text) returns boolean
language sql immutable set search_path = '' as $$
  select char_length(p_url) <= 200 and p_url ~ (
    '^https://(www\.)?' || case p_kind
      when 'youtube' then '(youtube\.com|youtu\.be)'
      when 'twitch' then 'twitch\.tv'
      when 'kick' then 'kick\.com'
      when 'tiktok' then 'tiktok\.com'
      when 'x' then '(x\.com|twitter\.com)'
      when 'instagram' then 'instagram\.com'
      when 'github' then 'github\.com'
      when 'discord' then '(discord\.gg|discord\.com)'
      when 'modrinth' then 'modrinth\.com'
      when 'curseforge' then 'curseforge\.com'
      else 'invalido\.invalid'
    end || '/[A-Za-z0-9@._~/?=&%+-]{1,160}$')
$$;

/**
 * Cambia la personalización del perfil de quien llama. p_patch solo trae lo que cambia:
 *   pronouns, bio, theme, nameStyle, banner, favoriteServers, publicStats (objeto o null), featured, equipped,
 *   cardStyle, links, showcase.
 * Devuelve el perfil personalizado. Errores (errcode 22023): 'bad_<campo>', 'premium_required:<campo>',
 * 'not_owned:<item>'; 'user_banned' / 'user_muted' (42501) para quien no puede usar lo social.
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
      -- GIF de KLIPY: para todos. Se guarda la dirección tal como la dio su API; la imagen la carga cada launcher.
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
       or exists (select 1 from jsonb_object_keys(v) x where x not in ('pattern', 'avatar', 'layout', 'accent')) then
      raise exception 'bad_cardStyle' using errcode = '22023';
    end if;
    update public.profiles set card_style = v where id = me;
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
       or exists (select 1 from jsonb_object_keys(v) x where x not in ('achievements', 'clips', 'skin'))
       or (v ? 'skin' and jsonb_typeof(v -> 'skin') <> 'boolean')
       or (v ? 'achievements' and (jsonb_typeof(v -> 'achievements') <> 'array' or jsonb_array_length(v -> 'achievements') > 6))
       or (v ? 'clips' and (jsonb_typeof(v -> 'clips') <> 'array' or jsonb_array_length(v -> 'clips') > 2)) then
      raise exception 'bad_showcase' using errcode = '22023';
    end if;
    if v ? 'achievements' then
      for el in select * from jsonb_array_elements(v -> 'achievements') loop
        -- Solo logros que la cuenta desbloqueó
        if jsonb_typeof(el) <> 'string' or not exists (select 1 from public.user_achievements ua where ua.user_id = me and ua.achievement_id = el #>> '{}') then
          raise exception 'bad_showcase' using errcode = '22023';
        end if;
      end loop;
    end if;
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
create or replace function public.profile_public(p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', p.id, 'username', p.username, 'displayName', p.display_name, 'friendCode', p.friend_code,
    'mcName', p.mc_name, 'bio', p.bio, 'badges', to_jsonb(p.badges), 'pronouns', p.pronouns, 'theme', p.theme,
    'nameStyle', p.name_style, 'banner', p.banner_style, 'favoriteServers', p.favorite_servers,
    'publicStats', p.public_stats, 'featured', p.featured, 'equipped', p.equipped,
    'cardStyle', p.card_style, 'links', p.links, 'rank', p.rank,
    'showcase', jsonb_build_object(
      'skin', coalesce((p.showcase ->> 'skin')::boolean, false),
      'achievements', coalesce((select jsonb_agg(jsonb_build_object('id', ua.achievement_id, 'at', ua.unlocked_at))
                                  from jsonb_array_elements_text(coalesce(p.showcase -> 'achievements', '[]'::jsonb)) x (id)
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

-- ---------- Rangos ----------
-- Cambia el rango de una cuenta. Solo admins del panel; 'owner' no se da ni se quita desde acá (se carga a mano).
create or replace function public.admin_set_rank(p_user uuid, p_rank text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_before text;
begin
  if not public.admin_is_admin_user(me) then raise exception 'admin_only' using errcode = '42501'; end if;
  if p_rank is not null and p_rank not in ('helper', 'mod', 'admin') then raise exception 'bad_rank' using errcode = '22023'; end if;
  select rank into v_before from public.profiles where id = p_user for update;
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
  if v_before = 'owner' then raise exception 'owner_locked' using errcode = '22023'; end if;
  update public.profiles set rank = p_rank where id = p_user;
  perform public.admin_log(me, (select email from auth.users where id = me), 'rank.set', p_user, jsonb_build_object('from', v_before, 'to', p_rank));
  return jsonb_build_object('rank', p_rank);
end $$;

-- ---------- KLIPY ----------
-- La clave vive en el Vault. Las condiciones de KLIPY piden que los pedidos salgan de la app del usuario, así que el
-- launcher la pide acá (con sesión y sin suspensión) y consulta a KLIPY directamente; es una clave de app, no un secreto.
create or replace function public.klipy_key() returns text
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if public.moderation_social_block(auth.uid()) = 'user_banned' then raise exception 'user_banned' using errcode = '42501'; end if;
  return (select nullif(d.decrypted_secret, '') from vault.decrypted_secrets d where d.name = 'venus_klipy_key' limit 1);
end $$;

create or replace function public.admin_klipy_status() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v text;
begin
  if not public.admin_is_admin_user(auth.uid()) then raise exception 'admin_only' using errcode = '42501'; end if;
  select nullif(d.decrypted_secret, '') into v from vault.decrypted_secrets d where d.name = 'venus_klipy_key' limit 1;
  return jsonb_build_object('configured', v is not null, 'hint', case when v is null then null else right(v, 4) end);
end $$;

create or replace function public.admin_set_klipy_key(p_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_key text := btrim(coalesce(p_key, ''));
  v_id uuid;
begin
  if not public.admin_is_admin_user(me) then raise exception 'admin_only' using errcode = '42501'; end if;
  if v_key <> '' and v_key !~ '^[A-Za-z0-9_-]{8,200}$' then raise exception 'bad_key' using errcode = '22023'; end if;
  select id into v_id from vault.secrets where name = 'venus_klipy_key';
  if v_key = '' then
    if v_id is not null then delete from vault.secrets where id = v_id; end if;
  elsif v_id is null then
    perform vault.create_secret(v_key, 'venus_klipy_key', 'Venus Launcher: KLIPY');
  else
    perform vault.update_secret(v_id, v_key, 'venus_klipy_key', 'Venus Launcher: KLIPY');
  end if;
  perform public.admin_log(me, (select email from auth.users where id = me), 'klipy.key', null, jsonb_build_object('configured', v_key <> ''));
  return jsonb_build_object('configured', v_key <> '', 'hint', case when v_key = '' then null else right(v_key, 4) end);
end $$;

-- ---------- Tienda: cosméticos nuevos ----------
insert into public.shop_items (id, kind, price, premium_only, sort, data) values
  ('frame_ice', 'frame', 900, false, 200, '{"style":"ice"}'),
  ('frame_emerald', 'frame', 1000, false, 201, '{"style":"emerald"}'),
  ('frame_amethyst', 'frame', 1000, false, 202, '{"style":"amethyst"}'),
  ('frame_redstone', 'frame', 1100, false, 203, '{"style":"redstone"}'),
  ('frame_fire', 'frame', 1400, false, 204, '{"style":"fire"}'),
  ('frame_ender', 'frame', 1600, false, 205, '{"style":"ender"}'),
  ('frame_rainbow', 'frame', 2200, false, 206, '{"style":"rainbow"}'),
  ('frame_diamond', 'frame', 3000, false, 207, '{"style":"diamond"}'),
  ('frame_cosmic', 'frame', 0, true, 208, '{"style":"cosmic"}'),
  ('effect_neon', 'name_effect', 1200, false, 220, '{"effect":"neon"}'),
  ('effect_ice', 'name_effect', 1200, false, 221, '{"effect":"ice"}'),
  ('effect_ocean', 'name_effect', 1200, false, 222, '{"effect":"ocean"}'),
  ('effect_sakura', 'name_effect', 1300, false, 223, '{"effect":"sakura"}'),
  ('effect_toxic', 'name_effect', 1400, false, 224, '{"effect":"toxic"}'),
  ('effect_vapor', 'name_effect', 1500, false, 225, '{"effect":"vapor"}'),
  ('effect_gold', 'name_effect', 2200, false, 226, '{"effect":"gold"}'),
  ('effect_galaxy', 'name_effect', 2600, false, 227, '{"effect":"galaxy"}'),
  ('effect_glitch', 'name_effect', 2800, false, 228, '{"effect":"glitch"}'),
  ('title_miner', 'title', 300, false, 240, '{"title":"miner"}'),
  ('title_farmer', 'title', 300, false, 241, '{"title":"farmer"}'),
  ('title_architect', 'title', 400, false, 242, '{"title":"architect"}'),
  ('title_modder', 'title', 400, false, 243, '{"title":"modder"}'),
  ('title_streamer', 'title', 500, false, 244, '{"title":"streamer"}'),
  ('title_pvp', 'title', 500, false, 245, '{"title":"pvp"}'),
  ('title_nightowl', 'title', 700, false, 246, '{"title":"nightowl"}'),
  ('title_speedrunner', 'title', 800, false, 247, '{"title":"speedrunner"}'),
  ('title_collector', 'title', 1000, false, 248, '{"title":"collector"}'),
  ('title_hardcore', 'title', 1200, false, 249, '{"title":"hardcore"}'),
  ('title_veteran', 'title', 2000, false, 250, '{"title":"veteran"}'),
  ('title_vip', 'title', 0, true, 251, '{"title":"vip"}')
on conflict (id) do update set kind = excluded.kind, price = excluded.price, premium_only = excluded.premium_only,
  sort = excluded.sort, data = excluded.data;

-- ---------- Logros: medida y objetivo en cada fila ----------
alter table public.achievements add column if not exists family text;
alter table public.achievements add column if not exists tier text;
alter table public.achievements add column if not exists metric text;
alter table public.achievements add column if not exists target bigint;

-- Misiones entran al libro de puntos
alter table public.points_ledger drop constraint if exists points_ledger_reason_check;
alter table public.points_ledger add constraint points_ledger_reason_check
  check (reason in ('daily', 'achievement', 'referral', 'referred', 'shop', 'admin', 'mission'));

-- Valor de una medida del servidor para un usuario (los sí o no valen 0 o 1)
create or replace function private.achievement_metric(p_user uuid, p_metric text) returns bigint
language plpgsql stable security definer set search_path = '' as $$
begin
  return case p_metric
    when 'friends' then (select count(*) from public.friendships f where f.status = 'accepted' and p_user in (f.requester, f.addressee))
    when 'referrals' then (select count(*) from public.referrals r where r.referrer = p_user and r.rewarded_at is not null)
    when 'messages' then (select count(*) from public.messages m where m.sender_id = p_user)
    when 'shares' then (select count(*) from public.shared_media m where m.owner = p_user)
    when 'themes' then (select count(*) from public.community_themes t where t.owner = p_user)
    when 'memberDays' then (select coalesce(extract(day from now() - p.created_at)::bigint, 0) from public.profiles p where p.id = p_user)
    when 'pointsEarned' then (select coalesce(sum(l.delta), 0) from public.points_ledger l where l.user_id = p_user and l.delta > 0)
    when 'missions' then (select count(*) from public.points_ledger l where l.user_id = p_user and l.reason = 'mission' and l.ref not like '%:bonus')
    when 'dailies' then (select count(*) from public.points_ledger l where l.user_id = p_user and l.reason = 'daily')
    when 'items' then (select count(*) from public.user_items ui where ui.user_id = p_user)
    when 'achievements' then (select count(*) from public.user_achievements ua where ua.user_id = p_user)
    when 'profile' then (select count(*) from public.profiles p where p.id = p_user and p.bio is not null
                          and (p.pronouns is not null or p.theme <> '{}'::jsonb) and p.banner_style <> '{}'::jsonb)
    when 'verified' then (select least(count(*), 1) from public.mc_verified v where v.user_id = p_user)
    when 'badge' then (select least(count(*), 1) from public.mc_badges b where b.user_id = p_user)
    when 'premium' then case when public.venus_is_premium(p_user) then 1 else 0 end
    else 0
  end;
end $$;

create or replace function private.achievement_met(p_user uuid, p_id text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare a record;
begin
  select metric, target into a from public.achievements where id = p_id;
  if not found or a.metric is null then return false; end if;
  return private.achievement_metric(p_user, a.metric) >= coalesce(a.target, 1);
end $$;

-- Tope diario de los logros que informa la PC (el resto queda pendiente en el launcher para otro día)
create or replace function private.achievements_client_today(p_user uuid) returns integer
language sql stable security definer set search_path = '' as $$
  select count(*)::integer from public.user_achievements ua join public.achievements x on x.id = ua.achievement_id
   where ua.user_id = p_user and x.check_kind = 'client' and ua.unlocked_at > now() - interval '1 day'
$$;

-- Desbloquea un logro y da sus puntos (lo siguen usando las versiones 2.x). Errores (22023): bad_achievement, not_met, too_many_today.
create or replace function public.achievement_claim(p_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  a record;
  v_points integer;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if public.moderation_social_block(me) = 'user_banned' then raise exception 'user_banned' using errcode = '42501'; end if;
  select * into a from public.achievements where id = p_id and active;
  if not found then raise exception 'bad_achievement' using errcode = '22023'; end if;
  if exists (select 1 from public.user_achievements where user_id = me and achievement_id = p_id) then
    return jsonb_build_object('unlocked', true, 'points', 0, 'already', true);
  end if;
  if a.check_kind = 'server' then
    if not private.achievement_met(me, p_id) then raise exception 'not_met' using errcode = '22023'; end if;
  elsif private.achievements_client_today(me) >= 40 then
    raise exception 'too_many_today' using errcode = '22023';
  end if;
  insert into public.user_achievements (user_id, achievement_id) values (me, p_id) on conflict do nothing;
  v_points := private.points_award(me, a.points * private.points_mult(me), 'achievement', p_id);
  return jsonb_build_object('unlocked', true, 'points', v_points, 'balance', private.points_balance(me));
end $$;

-- Reclama varios logros de la PC de una vez. Devuelve { unlocked: [{ id, points }], skipped, balance }.
create or replace function public.achievements_claim(p_ids text[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_id text;
  a record;
  v_left integer;
  v_points integer;
  v_mult integer;
  v_out jsonb := '[]'::jsonb;
  v_skipped integer := 0;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if public.moderation_social_block(me) = 'user_banned' then raise exception 'user_banned' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtext('achievements:' || me::text));
  v_left := 40 - private.achievements_client_today(me);
  v_mult := private.points_mult(me);
  foreach v_id in array coalesce(p_ids[1:100], '{}') loop
    select * into a from public.achievements where id = v_id and active and check_kind = 'client';
    if not found or exists (select 1 from public.user_achievements where user_id = me and achievement_id = v_id) then continue; end if;
    if v_left <= 0 then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    insert into public.user_achievements (user_id, achievement_id) values (me, v_id) on conflict do nothing;
    v_points := private.points_award(me, greatest(a.points, 1) * v_mult, 'achievement', v_id);
    v_out := v_out || jsonb_build_object('id', v_id, 'points', v_points);
    v_left := v_left - 1;
  end loop;
  return jsonb_build_object('unlocked', v_out, 'skipped', v_skipped, 'balance', private.points_balance(me));
end $$;

-- Comprueba de una vez los logros del servidor que faltan. Devuelve { unlocked: [{ id, points }], balance }.
create or replace function public.achievements_sweep() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  a record;
  v_seen jsonb := '{}'::jsonb;
  v_value bigint;
  v_points integer;
  v_mult integer;
  v_out jsonb := '[]'::jsonb;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if public.moderation_social_block(me) = 'user_banned' then raise exception 'user_banned' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtext('achievements:' || me::text));
  v_mult := private.points_mult(me);
  for a in select x.* from public.achievements x
            where x.active and x.check_kind = 'server' and x.metric is not null
              and not exists (select 1 from public.user_achievements ua where ua.user_id = me and ua.achievement_id = x.id)
            order by x.sort loop
    -- 'achievements' cuenta lo que se va desbloqueando acá mismo: no se guarda
    if a.metric <> 'achievements' and v_seen ? a.metric then
      v_value := (v_seen ->> a.metric)::bigint;
    else
      v_value := private.achievement_metric(me, a.metric);
      v_seen := v_seen || jsonb_build_object(a.metric, v_value);
    end if;
    if v_value >= coalesce(a.target, 1) then
      insert into public.user_achievements (user_id, achievement_id) values (me, a.id) on conflict do nothing;
      v_points := private.points_award(me, greatest(a.points, 1) * v_mult, 'achievement', a.id);
      v_out := v_out || jsonb_build_object('id', a.id, 'points', v_points);
    end if;
  end loop;
  return jsonb_build_object('unlocked', v_out, 'balance', private.points_balance(me));
end $$;

-- Resumen de puntos (el chip y la tienda). La lista de logros sigue siendo la de la 2.x para que esas versiones no
-- muestren cientos de logros sin nombre; la 3.0 los lee de achievements_me.
create or replace function public.points_me() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  today date := (now() at time zone 'utc')::date;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  return jsonb_build_object(
    'balance', private.points_balance(me),
    'premium', public.venus_is_premium(me),
    'multiplier', private.points_mult(me),
    'dailyClaimed', exists (select 1 from public.points_ledger where user_id = me and reason = 'daily' and ref = today::text),
    'referralCode', (select code from public.referral_codes where user_id = me),
    'referredBy', (select jsonb_build_object('username', p.username, 'rewarded', r.rewarded_at is not null)
                     from public.referrals r join public.profiles p on p.id = r.referrer where r.referred = me),
    'canClaimReferral', not exists (select 1 from public.referrals where referred = me)
                        and (select created_at from auth.users where id = me) > now() - interval '14 days',
    'referrals', jsonb_build_object(
      'total', (select count(*) from public.referrals where referrer = me),
      'rewarded', (select count(*) from public.referrals where referrer = me and rewarded_at is not null)),
    'mcVerified', exists (select 1 from public.mc_verified where user_id = me),
    'achievements', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'points', a.points, 'kind', a.check_kind,
                                'unlockedAt', ua.unlocked_at) order by a.sort)
                                from public.achievements a
                                left join public.user_achievements ua on ua.achievement_id = a.id and ua.user_id = me
                               where a.active and a.id in ('first_launch', 'playtime_10h', 'playtime_100h', 'instances_5', 'first_screenshot', 'first_clip',
                                 'first_party', 'skin_created', 'profile_complete', 'first_friend', 'five_friends', 'mc_verified', 'badge_on', 'first_share',
                                 'first_referral', 'five_referrals', 'theme_published', 'premium')), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(ui.item_id) from public.user_items ui where ui.user_id = me), '[]'::jsonb),
    'history', coalesce((select jsonb_agg(jsonb_build_object('delta', l.delta, 'reason', l.reason, 'ref', l.ref, 'at', l.created_at)
                                order by l.created_at desc)
                           from (select * from public.points_ledger where user_id = me order by created_at desc limit 30) l), '[]'::jsonb));
end $$;

-- Lo que la página de Logros necesita: desbloqueados, porcentaje de jugadores por logro y medidas del servidor.
create or replace function public.achievements_me() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_total bigint;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  select count(*) into v_total from public.profiles;
  return jsonb_build_object(
    'unlocked', coalesce((select jsonb_object_agg(ua.achievement_id, ua.unlocked_at) from public.user_achievements ua where ua.user_id = me), '{}'::jsonb),
    'totalUsers', v_total,
    'rarity', coalesce((select jsonb_object_agg(r.achievement_id, round((r.n * 100.0 / greatest(v_total, 1))::numeric, 2))
                          from (select achievement_id, count(*) n from public.user_achievements group by achievement_id) r), '{}'::jsonb),
    'metrics', coalesce((select jsonb_object_agg(m.metric, private.achievement_metric(me, m.metric))
                           from (select distinct metric from public.achievements where active and check_kind = 'server' and metric is not null) m), '{}'::jsonb),
    'clientToday', private.achievements_client_today(me),
    'clientCap', 40);
end $$;

-- ---------- Misiones ----------
create table if not exists public.missions (
  id text primary key check (id ~ '^[a-z0-9_]{2,40}$'),
  period text not null check (period in ('daily', 'weekly')),
  metric text not null check (char_length(metric) <= 40),
  target integer not null check (target > 0),
  points integer not null check (points between 1 and 10000),
  active boolean not null default true
);
alter table public.missions enable row level security;
drop policy if exists "missions_select" on public.missions;
create policy "missions_select" on public.missions for select to authenticated using (active);
revoke all on public.missions from anon, authenticated;
grant select on public.missions to authenticated;

create or replace function private.mission_period_key(p_period text) returns text
language sql stable set search_path = '' as $$
  select case p_period when 'daily' then to_char(now() at time zone 'utc', 'YYYY-MM-DD') else to_char(now() at time zone 'utc', 'IYYY-"W"IW') end
$$;

-- Cuándo termina el período actual (medianoche UTC del día siguiente o del próximo lunes)
create or replace function private.mission_period_end(p_period text) returns timestamptz
language sql stable set search_path = '' as $$
  select case p_period
    when 'daily' then (date_trunc('day', now() at time zone 'utc') + interval '1 day') at time zone 'utc'
    else (date_trunc('week', now() at time zone 'utc') + interval '1 week') at time zone 'utc'
  end
$$;

-- Las 3 misiones del período para un usuario: siempre las mismas durante el período, sin repetir la medida.
create or replace function private.missions_current(p_user uuid, p_period text)
returns setof public.missions
language sql stable security definer set search_path = '' as $$
  with k as (select private.mission_period_key(p_period) as key),
  ranked as (
    select distinct on (m.metric) m.*, md5(p_user::text || k.key || m.metric) as h, md5(p_user::text || k.key || m.id) as h2
      from public.missions m, k
     where m.active and m.period = p_period
     order by m.metric, md5(p_user::text || k.key || m.id)
  )
  select r.id, r.period, r.metric, r.target, r.points, r.active from ranked r order by r.h limit 3
$$;

-- Bono por completar las 3 del período
create or replace function private.mission_bonus(p_period text) returns integer
language sql immutable set search_path = '' as $$ select case p_period when 'daily' then 25 else 100 end $$;

create or replace function public.missions_me() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_mult integer;
  v_out jsonb := '{}'::jsonb;
  p text;
  k text;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  v_mult := private.points_mult(me);
  foreach p in array array['daily', 'weekly'] loop
    k := private.mission_period_key(p);
    v_out := v_out || jsonb_build_object(p, jsonb_build_object(
      'key', k,
      'endsAt', private.mission_period_end(p),
      'bonus', private.mission_bonus(p) * v_mult,
      'bonusClaimed', exists (select 1 from public.points_ledger l where l.user_id = me and l.reason = 'mission' and l.ref = k || ':bonus'),
      'missions', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'metric', c.metric, 'target', c.target, 'points', c.points * v_mult,
                              'claimed', exists (select 1 from public.points_ledger l where l.user_id = me and l.reason = 'mission' and l.ref = k || ':' || c.id)))
                              from private.missions_current(me, p) c), '[]'::jsonb)));
  end loop;
  return v_out || jsonb_build_object('multiplier', v_mult);
end $$;

-- Reclama una misión del período actual. El progreso lo cuenta el launcher: por eso son pocos puntos y un tope fijo
-- por período. Errores (22023): bad_mission. Devuelve { points, bonus, balance, already? }.
create or replace function public.mission_claim(p_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  m record;
  k text;
  v_mult integer;
  v_points integer;
  v_bonus integer := 0;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if public.moderation_social_block(me) = 'user_banned' then raise exception 'user_banned' using errcode = '42501'; end if;
  select * into m from public.missions where id = p_id and active;
  if not found then raise exception 'bad_mission' using errcode = '22023'; end if;
  if not exists (select 1 from private.missions_current(me, m.period) c where c.id = p_id) then raise exception 'bad_mission' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext('points:' || me::text));
  k := private.mission_period_key(m.period);
  v_mult := private.points_mult(me);
  v_points := private.points_award(me, m.points * v_mult, 'mission', k || ':' || p_id);
  if v_points = 0 then
    return jsonb_build_object('points', 0, 'bonus', 0, 'already', true, 'balance', private.points_balance(me));
  end if;
  if not exists (select 1 from private.missions_current(me, m.period) c
                  where not exists (select 1 from public.points_ledger l where l.user_id = me and l.reason = 'mission' and l.ref = k || ':' || c.id)) then
    v_bonus := private.points_award(me, private.mission_bonus(m.period) * v_mult, 'mission', k || ':bonus');
  end if;
  return jsonb_build_object('points', v_points, 'bonus', v_bonus, 'balance', private.points_balance(me));
end $$;

-- ---------- Permisos ----------
revoke all on function private.klipy_url(jsonb), private.profile_link_ok(text, text), private.achievement_metric(uuid, text),
  private.achievements_client_today(uuid), private.mission_period_key(text), private.mission_period_end(text),
  private.missions_current(uuid, text), private.mission_bonus(text) from public, anon, authenticated;
revoke all on function public.profile_customize(jsonb) from public, anon;
revoke all on function public.profile_public(uuid) from public, anon;
revoke all on function public.admin_set_rank(uuid, text) from public, anon;
revoke all on function public.klipy_key() from public, anon;
revoke all on function public.admin_klipy_status() from public, anon;
revoke all on function public.admin_set_klipy_key(text) from public, anon;
revoke all on function public.achievement_claim(text) from public, anon;
revoke all on function public.achievements_claim(text[]) from public, anon;
revoke all on function public.achievements_sweep() from public, anon;
revoke all on function public.achievements_me() from public, anon;
revoke all on function public.missions_me() from public, anon;
revoke all on function public.mission_claim(text) from public, anon;
grant execute on function public.profile_customize(jsonb) to authenticated;
grant execute on function public.profile_public(uuid) to authenticated;
grant execute on function public.admin_set_rank(uuid, text) to authenticated;
grant execute on function public.klipy_key() to authenticated;
grant execute on function public.admin_klipy_status() to authenticated;
grant execute on function public.admin_set_klipy_key(text) to authenticated;
grant execute on function public.achievement_claim(text) to authenticated;
grant execute on function public.achievements_claim(text[]) to authenticated;
grant execute on function public.achievements_sweep() to authenticated;
grant execute on function public.achievements_me() to authenticated;
grant execute on function public.missions_me() to authenticated;
grant execute on function public.mission_claim(text) to authenticated;
