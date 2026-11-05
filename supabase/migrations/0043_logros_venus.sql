-- 0043_logros_venus.sql · Venus 4.6 · Logros solo de Venus.
-- Guía: docs/wip/logros-46.md. Depende de 0021, 0023, 0024 (logros) y 0029 (reseñas de servidores). Idempotente.
--
-- El dueño pidió que los logros sean solo y exclusivos de Venus: nada de lo que pasa dentro del juego. Un logro vale si se
-- calcula con datos del launcher o de la cuenta de Venus (instancias, mods, capturas, horas y rachas que mide el propio
-- launcher, perfil, amigos, mensajes, Venus Points...). No vale si sale de los mundos o de los logros de Minecraft.
--
--   * Se desactivan (active = false) los 255 logros que no valen. NO se borra ningún desbloqueo (user_achievements) ni se
--     quita ningún punto (points_ledger): quien ya los tenía los conserva y suman al saldo como siempre. Solo dejan de poder
--     conseguirse (achievement_claim, achievements_claim y achievements_sweep ya filtran por active) y de mostrarse.
--   * private.achievement_metric: 'achievements' (los pasos de Cazalogros) cuenta solo los logros activos, y dos medidas
--     nuevas: 'pointsSpent' (Venus Points gastados en la tienda) y 'reviews' (reseñas de servidores publicadas).
--   * achievements_me devuelve solo los desbloqueos y la rareza de los logros activos (la página y el editor de perfil
--     no ven los retirados). Las dos funciones parten de la definición que hay en producción (idéntica a 0023).
--   * El catálogo vuelve a quedar sincronizado con src/renderer/js/pages/achievements/catalog.js (189 logros: 166 de
--     antes con los mismos puntos y 23 nuevos). Los pasos 200, 300 y 400 de Cazalogros quedan fuera de alcance.
--   * Las misiones no cambian. No se redefine profile_public: su 'achievementCount' sigue contando todos los desbloqueos.

-- ---------- Medidas del servidor ----------
-- Valor de una medida del servidor para un usuario (los sí o no valen 0 o 1). Igual que 0023 salvo lo dicho arriba.
create or replace function private.achievement_metric(p_user uuid, p_metric text) returns bigint
language plpgsql stable security definer set search_path = '' as $$
begin
  return case p_metric
    when 'friends' then (select count(*) from public.friendships f where f.status = 'accepted' and p_user in (f.requester, f.addressee))
    when 'referrals' then (select count(*) from public.referrals r where r.referrer = p_user and r.rewarded_at is not null)
    when 'messages' then (select count(*) from public.messages m where m.sender_id = p_user)
    when 'shares' then (select count(*) from public.shared_media m where m.owner = p_user)
    when 'themes' then (select count(*) from public.community_themes t where t.owner = p_user)
    when 'reviews' then (select count(*) from public.featured_server_reviews r where r.user_id = p_user and not r.hidden)
    when 'memberDays' then (select coalesce(extract(day from now() - p.created_at)::bigint, 0) from public.profiles p where p.id = p_user)
    when 'pointsEarned' then (select coalesce(sum(l.delta), 0) from public.points_ledger l where l.user_id = p_user and l.delta > 0)
    when 'pointsSpent' then (select coalesce(sum(-l.delta), 0) from public.points_ledger l where l.user_id = p_user and l.reason = 'shop' and l.delta < 0)
    when 'missions' then (select count(*) from public.points_ledger l where l.user_id = p_user and l.reason = 'mission' and l.ref not like '%:bonus')
    when 'dailies' then (select count(*) from public.points_ledger l where l.user_id = p_user and l.reason = 'daily')
    when 'items' then (select count(*) from public.user_items ui where ui.user_id = p_user)
    when 'achievements' then (select count(*) from public.user_achievements ua join public.achievements a on a.id = ua.achievement_id and a.active where ua.user_id = p_user)
    when 'profile' then (select count(*) from public.profiles p where p.id = p_user and p.bio is not null
                          and (p.pronouns is not null or p.theme <> '{}'::jsonb) and p.banner_style <> '{}'::jsonb)
    when 'verified' then (select least(count(*), 1) from public.mc_verified v where v.user_id = p_user)
    when 'badge' then (select least(count(*), 1) from public.mc_badges b where b.user_id = p_user)
    when 'premium' then case when public.venus_is_premium(p_user) then 1 else 0 end
    else 0
  end;
end $$;

-- ---------- Lo que la página de Logros necesita ----------
-- Desbloqueados, porcentaje de jugadores por logro y medidas del servidor, solo de los logros activos.
create or replace function public.achievements_me() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_total bigint;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  select count(*) into v_total from public.profiles;
  return jsonb_build_object(
    'unlocked', coalesce((select jsonb_object_agg(ua.achievement_id, ua.unlocked_at)
                            from public.user_achievements ua join public.achievements a on a.id = ua.achievement_id and a.active
                           where ua.user_id = me), '{}'::jsonb),
    'totalUsers', v_total,
    'rarity', coalesce((select jsonb_object_agg(r.achievement_id, round((r.n * 100.0 / greatest(v_total, 1))::numeric, 2))
                          from (select ua.achievement_id, count(*) n
                                  from public.user_achievements ua join public.achievements a on a.id = ua.achievement_id and a.active
                                 group by ua.achievement_id) r), '{}'::jsonb),
    'metrics', coalesce((select jsonb_object_agg(m.metric, private.achievement_metric(me, m.metric))
                           from (select distinct metric from public.achievements where active and check_kind = 'server' and metric is not null) m), '{}'::jsonb),
    'clientToday', private.achievements_client_today(me),
    'clientCap', 40);
end $$;

-- ---------- Catálogo ----------
-- Generado por scripts/gen-achievements-sql.js: no editar a mano. Se desactivan 255 logros y el catalogo queda en 189.
-- Los desbloqueos y los puntos ya dados no se tocan: solo dejan de poder conseguirse.
update public.achievements set active = false
 where active and id in (
  'gametime_1', 'gametime_10', 'gametime_50', 'gametime_100',
  'gametime_500', 'gametime_1000', 'gametime_5000', 'blocks_100',
  'blocks_1000', 'blocks_5000', 'blocks_10000', 'blocks_50000',
  'blocks_100000', 'blocks_500000', 'blocks_1000000', 'blocks_5000000',
  'coal_10', 'coal_100', 'coal_1000', 'coal_5000',
  'iron_10', 'iron_100', 'iron_1000', 'iron_5000',
  'gold_10', 'gold_100', 'gold_500', 'gold_2500',
  'redstone_10', 'redstone_100', 'redstone_1000', 'redstone_5000',
  'lapis_10', 'lapis_100', 'lapis_500', 'lapis_2500',
  'diamond_1', 'diamond_10', 'diamond_50', 'diamond_100',
  'diamond_500', 'diamond_1000', 'diamond_5000', 'emerald_1',
  'emerald_10', 'emerald_50', 'emerald_250', 'debris_1',
  'debris_10', 'debris_50', 'debris_100', 'debris_500',
  'quartz_10', 'quartz_100', 'quartz_1000', 'quartz_5000',
  'woodcut_50', 'woodcut_500', 'woodcut_5000', 'woodcut_25000',
  'crafted_50', 'crafted_500', 'crafted_5000', 'crafted_25000',
  'crafted_100000', 'crafted_500000', 'broken_1', 'broken_10',
  'broken_50', 'broken_250', 'broken_1000', 'mobs_10',
  'mobs_100', 'mobs_500', 'mobs_1000', 'mobs_5000',
  'mobs_10000', 'mobs_50000', 'mobs_100000', 'zombies_10',
  'zombies_100', 'zombies_1000', 'zombies_5000', 'skeletons_10',
  'skeletons_100', 'skeletons_1000', 'skeletons_5000', 'creepers_1',
  'creepers_10', 'creepers_100', 'creepers_1000', 'spiders_10',
  'spiders_100', 'spiders_1000', 'endermen_1', 'endermen_25',
  'endermen_250', 'endermen_2500', 'blazes_1', 'blazes_25',
  'blazes_250', 'blazes_1000', 'witches_1', 'witches_25',
  'witches_250', 'dragon_1', 'dragon_5', 'dragon_25',
  'wither_1', 'wither_5', 'wither_25', 'elder_1',
  'elder_3', 'elder_10', 'warden_1', 'warden_3',
  'warden_10', 'pvp_1', 'pvp_10', 'pvp_100',
  'pvp_1000', 'pvp_5000', 'deaths_1', 'deaths_10',
  'deaths_50', 'deaths_100', 'deaths_500', 'deaths_1000',
  'deaths_5000', 'damage_1000', 'damage_10000', 'damage_100000',
  'damage_1000000', 'tanked_100', 'tanked_1000', 'tanked_10000',
  'tanked_100000', 'blocked_100', 'blocked_1000', 'blocked_10000',
  'totems_1', 'totems_5', 'totems_25', 'totems_100',
  'raids_1', 'raids_5', 'raids_25', 'raids_100',
  'distance_1', 'distance_10', 'distance_50', 'distance_100',
  'distance_500', 'distance_1000', 'distance_5000', 'distance_10000',
  'walking_1', 'walking_10', 'walking_100', 'walking_500',
  'walking_2000', 'flying_1', 'flying_10', 'flying_100',
  'flying_1000', 'flying_5000', 'swimming_1', 'swimming_10',
  'swimming_100', 'swimming_500', 'boating_1', 'boating_10',
  'boating_100', 'boating_500', 'riding_1', 'riding_10',
  'riding_100', 'riding_500', 'rails_1', 'rails_10',
  'rails_100', 'rails_500', 'jumps_1000', 'jumps_10000',
  'jumps_50000', 'jumps_100000', 'jumps_500000', 'jumps_1000000',
  'worlds_1', 'worlds_5', 'worlds_10', 'worlds_20',
  'worlds_50', 'worlds_100', 'servers_1', 'servers_5',
  'servers_10', 'servers_25', 'servers_50', 'servers_100',
  'advancements_1', 'advancements_10', 'advancements_25', 'advancements_50',
  'advancements_75', 'advancements_100', 'advancements_200', 'advancements_500',
  'breeder_1', 'breeder_10', 'breeder_100', 'breeder_500',
  'breeder_2500', 'fisher_1', 'fisher_10', 'fisher_100',
  'fisher_500', 'fisher_2500', 'trader_1', 'trader_10',
  'trader_100', 'trader_500', 'trader_2500', 'enchanter_1',
  'enchanter_10', 'enchanter_50', 'enchanter_250', 'enchanter_1000',
  'sleeper_1', 'sleeper_10', 'sleeper_100', 'sleeper_500',
  'sleeper_1000', 'chests_10', 'chests_100', 'chests_1000',
  'chests_10000', 'cake_1', 'cake_25', 'cake_100',
  'records_1', 'records_10', 'records_100', 'notes_1',
  'notes_100', 'notes_1000', 'bells_1', 'bells_25',
  'bells_250', 'shared_100', 'shared_1000', 'shared_10000',
  'achiever_200', 'achiever_300', 'achiever_400'
);

insert into public.achievements (id, points, check_kind, sort, family, tier, metric, target) values
  ('playtime_1', 5, 'client', 10, 'playtime', 'bronze', 'hours', 1),
  ('playtime_5', 5, 'client', 20, 'playtime', 'bronze', 'hours', 5),
  ('playtime_10h', 100, 'client', 30, 'playtime', 'bronze', 'hours', 10),
  ('playtime_25', 10, 'client', 40, 'playtime', 'silver', 'hours', 25),
  ('playtime_50', 10, 'client', 50, 'playtime', 'silver', 'hours', 50),
  ('playtime_100h', 400, 'client', 60, 'playtime', 'gold', 'hours', 100),
  ('playtime_250', 25, 'client', 70, 'playtime', 'gold', 'hours', 250),
  ('playtime_500', 50, 'client', 80, 'playtime', 'diamond', 'hours', 500),
  ('playtime_1000', 50, 'client', 90, 'playtime', 'diamond', 'hours', 1000),
  ('playtime_2500', 100, 'client', 100, 'playtime', 'netherite', 'hours', 2500),
  ('playtime_5000', 100, 'client', 110, 'playtime', 'netherite', 'hours', 5000),
  ('playtime_10000', 100, 'client', 120, 'playtime', 'netherite', 'hours', 10000),
  ('first_launch', 50, 'client', 130, 'sessions', 'bronze', 'sessions', 1),
  ('sessions_5', 5, 'client', 140, 'sessions', 'bronze', 'sessions', 5),
  ('sessions_10', 5, 'client', 150, 'sessions', 'bronze', 'sessions', 10),
  ('sessions_25', 10, 'client', 160, 'sessions', 'silver', 'sessions', 25),
  ('sessions_50', 10, 'client', 170, 'sessions', 'silver', 'sessions', 50),
  ('sessions_100', 25, 'client', 180, 'sessions', 'gold', 'sessions', 100),
  ('sessions_250', 25, 'client', 190, 'sessions', 'gold', 'sessions', 250),
  ('sessions_500', 50, 'client', 200, 'sessions', 'diamond', 'sessions', 500),
  ('sessions_1000', 50, 'client', 210, 'sessions', 'diamond', 'sessions', 1000),
  ('sessions_2500', 100, 'client', 220, 'sessions', 'netherite', 'sessions', 2500),
  ('sessions_5000', 100, 'client', 230, 'sessions', 'netherite', 'sessions', 5000),
  ('streak_3', 5, 'client', 240, 'streak', 'bronze', 'bestStreak', 3),
  ('streak_7', 5, 'client', 250, 'streak', 'bronze', 'bestStreak', 7),
  ('streak_14', 10, 'client', 260, 'streak', 'silver', 'bestStreak', 14),
  ('streak_30', 25, 'client', 270, 'streak', 'gold', 'bestStreak', 30),
  ('streak_60', 25, 'client', 280, 'streak', 'gold', 'bestStreak', 60),
  ('streak_100', 50, 'client', 290, 'streak', 'diamond', 'bestStreak', 100),
  ('streak_180', 100, 'client', 300, 'streak', 'netherite', 'bestStreak', 180),
  ('streak_365', 100, 'client', 310, 'streak', 'netherite', 'bestStreak', 365),
  ('marathon_2', 5, 'client', 320, 'marathon', 'bronze', 'longestHours', 2),
  ('marathon_3', 5, 'client', 330, 'marathon', 'bronze', 'longestHours', 3),
  ('marathon_4', 10, 'client', 340, 'marathon', 'silver', 'longestHours', 4),
  ('marathon_6', 25, 'client', 350, 'marathon', 'gold', 'longestHours', 6),
  ('marathon_8', 50, 'client', 360, 'marathon', 'diamond', 'longestHours', 8),
  ('marathon_12', 100, 'client', 370, 'marathon', 'netherite', 'longestHours', 12),
  ('days_5', 5, 'client', 380, 'days', 'bronze', 'daysPlayed', 5),
  ('days_10', 5, 'client', 390, 'days', 'bronze', 'daysPlayed', 10),
  ('days_25', 10, 'client', 400, 'days', 'silver', 'daysPlayed', 25),
  ('days_50', 25, 'client', 410, 'days', 'gold', 'daysPlayed', 50),
  ('days_100', 25, 'client', 420, 'days', 'gold', 'daysPlayed', 100),
  ('days_200', 50, 'client', 430, 'days', 'diamond', 'daysPlayed', 200),
  ('days_365', 100, 'client', 440, 'days', 'netherite', 'daysPlayed', 365),
  ('days_500', 100, 'client', 450, 'days', 'netherite', 'daysPlayed', 500),
  ('instances_1', 5, 'client', 460, 'instances', 'bronze', 'instances', 1),
  ('instances_3', 5, 'client', 470, 'instances', 'bronze', 'instances', 3),
  ('instances_5', 50, 'client', 480, 'instances', 'silver', 'instances', 5),
  ('instances_10', 25, 'client', 490, 'instances', 'gold', 'instances', 10),
  ('instances_25', 50, 'client', 500, 'instances', 'diamond', 'instances', 25),
  ('instances_50', 100, 'client', 510, 'instances', 'netherite', 'instances', 50),
  ('instances_100', 100, 'client', 520, 'instances', 'netherite', 'instances', 100),
  ('rotation_2', 5, 'client', 530, 'rotation', 'bronze', 'instancesPlayed', 2),
  ('rotation_3', 10, 'client', 540, 'rotation', 'silver', 'instancesPlayed', 3),
  ('rotation_5', 25, 'client', 550, 'rotation', 'gold', 'instancesPlayed', 5),
  ('rotation_10', 50, 'client', 560, 'rotation', 'diamond', 'instancesPlayed', 10),
  ('rotation_20', 100, 'client', 570, 'rotation', 'netherite', 'instancesPlayed', 20),
  ('versions_2', 5, 'client', 580, 'versions', 'bronze', 'versions', 2),
  ('versions_5', 5, 'client', 590, 'versions', 'bronze', 'versions', 5),
  ('versions_10', 10, 'client', 600, 'versions', 'silver', 'versions', 10),
  ('versions_20', 25, 'client', 610, 'versions', 'gold', 'versions', 20),
  ('versions_40', 50, 'client', 620, 'versions', 'diamond', 'versions', 40),
  ('versions_80', 100, 'client', 630, 'versions', 'netherite', 'versions', 80),
  ('loaders_2', 5, 'client', 640, 'loaders', 'bronze', 'loaders', 2),
  ('loaders_3', 10, 'client', 650, 'loaders', 'silver', 'loaders', 3),
  ('loaders_5', 25, 'client', 660, 'loaders', 'gold', 'loaders', 5),
  ('loaders_7', 50, 'client', 670, 'loaders', 'diamond', 'loaders', 7),
  ('loaders_9', 100, 'client', 680, 'loaders', 'netherite', 'loaders', 9),
  ('mods_1', 5, 'client', 690, 'mods', 'bronze', 'mods', 1),
  ('mods_10', 5, 'client', 700, 'mods', 'bronze', 'mods', 10),
  ('mods_50', 10, 'client', 710, 'mods', 'silver', 'mods', 50),
  ('mods_100', 25, 'client', 720, 'mods', 'gold', 'mods', 100),
  ('mods_250', 25, 'client', 730, 'mods', 'gold', 'mods', 250),
  ('mods_500', 50, 'client', 740, 'mods', 'diamond', 'mods', 500),
  ('mods_1000', 100, 'client', 750, 'mods', 'netherite', 'mods', 1000),
  ('mods_2500', 100, 'client', 760, 'mods', 'netherite', 'mods', 2500),
  ('shaders_1', 5, 'client', 770, 'shaders', 'bronze', 'shaders', 1),
  ('shaders_5', 10, 'client', 780, 'shaders', 'silver', 'shaders', 5),
  ('shaders_10', 50, 'client', 790, 'shaders', 'diamond', 'shaders', 10),
  ('shaders_25', 100, 'client', 800, 'shaders', 'netherite', 'shaders', 25),
  ('packs_1', 5, 'client', 810, 'packs', 'bronze', 'resourcepacks', 1),
  ('packs_5', 10, 'client', 820, 'packs', 'silver', 'resourcepacks', 5),
  ('packs_10', 50, 'client', 830, 'packs', 'diamond', 'resourcepacks', 10),
  ('packs_25', 100, 'client', 840, 'packs', 'netherite', 'resourcepacks', 25),
  ('localservers_1', 5, 'client', 850, 'localservers', 'bronze', 'localServers', 1),
  ('localservers_3', 10, 'client', 860, 'localservers', 'silver', 'localServers', 3),
  ('localservers_5', 25, 'client', 870, 'localservers', 'gold', 'localServers', 5),
  ('localservers_10', 50, 'client', 880, 'localservers', 'diamond', 'localServers', 10),
  ('localservers_25', 100, 'client', 890, 'localservers', 'netherite', 'localServers', 25),
  ('first_screenshot', 25, 'client', 900, 'screenshots', 'bronze', 'screenshots', 1),
  ('screenshots_10', 5, 'client', 910, 'screenshots', 'bronze', 'screenshots', 10),
  ('screenshots_50', 10, 'client', 920, 'screenshots', 'silver', 'screenshots', 50),
  ('screenshots_100', 25, 'client', 930, 'screenshots', 'gold', 'screenshots', 100),
  ('screenshots_500', 50, 'client', 940, 'screenshots', 'diamond', 'screenshots', 500),
  ('screenshots_1000', 100, 'client', 950, 'screenshots', 'netherite', 'screenshots', 1000),
  ('screenshots_5000', 100, 'client', 960, 'screenshots', 'netherite', 'screenshots', 5000),
  ('first_clip', 50, 'client', 970, 'clips', 'bronze', 'clips', 1),
  ('clips_5', 5, 'client', 980, 'clips', 'bronze', 'clips', 5),
  ('clips_10', 10, 'client', 990, 'clips', 'silver', 'clips', 10),
  ('clips_25', 25, 'client', 1000, 'clips', 'gold', 'clips', 25),
  ('clips_50', 50, 'client', 1010, 'clips', 'diamond', 'clips', 50),
  ('clips_100', 100, 'client', 1020, 'clips', 'netherite', 'clips', 100),
  ('clips_500', 100, 'client', 1030, 'clips', 'netherite', 'clips', 500),
  ('first_friend', 50, 'server', 1040, 'friends', 'bronze', 'friends', 1),
  ('five_friends', 150, 'server', 1050, 'friends', 'bronze', 'friends', 5),
  ('friends_10', 30, 'server', 1060, 'friends', 'silver', 'friends', 10),
  ('friends_25', 60, 'server', 1070, 'friends', 'gold', 'friends', 25),
  ('friends_50', 120, 'server', 1080, 'friends', 'diamond', 'friends', 50),
  ('friends_100', 250, 'server', 1090, 'friends', 'netherite', 'friends', 100),
  ('first_referral', 200, 'server', 1100, 'referrals', 'bronze', 'referrals', 1),
  ('five_referrals', 1000, 'server', 1110, 'referrals', 'bronze', 'referrals', 5),
  ('referrals_10', 30, 'server', 1120, 'referrals', 'silver', 'referrals', 10),
  ('referrals_25', 60, 'server', 1130, 'referrals', 'gold', 'referrals', 25),
  ('referrals_50', 120, 'server', 1140, 'referrals', 'diamond', 'referrals', 50),
  ('referrals_100', 250, 'server', 1150, 'referrals', 'netherite', 'referrals', 100),
  ('messages_10', 15, 'server', 1160, 'messages', 'bronze', 'messages', 10),
  ('messages_100', 15, 'server', 1170, 'messages', 'bronze', 'messages', 100),
  ('messages_500', 30, 'server', 1180, 'messages', 'silver', 'messages', 500),
  ('messages_1000', 60, 'server', 1190, 'messages', 'gold', 'messages', 1000),
  ('messages_5000', 120, 'server', 1200, 'messages', 'diamond', 'messages', 5000),
  ('messages_10000', 250, 'server', 1210, 'messages', 'netherite', 'messages', 10000),
  ('messages_50000', 250, 'server', 1220, 'messages', 'netherite', 'messages', 50000),
  ('first_share', 50, 'server', 1230, 'shares', 'bronze', 'shares', 1),
  ('shares_5', 30, 'server', 1240, 'shares', 'silver', 'shares', 5),
  ('shares_25', 120, 'server', 1250, 'shares', 'diamond', 'shares', 25),
  ('shares_100', 250, 'server', 1260, 'shares', 'netherite', 'shares', 100),
  ('theme_published', 100, 'server', 1270, 'themes', 'bronze', 'themes', 1),
  ('themes_3', 60, 'server', 1280, 'themes', 'gold', 'themes', 3),
  ('themes_10', 250, 'server', 1290, 'themes', 'netherite', 'themes', 10),
  ('reviews_1', 15, 'server', 1300, 'reviews', 'bronze', 'reviews', 1),
  ('reviews_3', 30, 'server', 1310, 'reviews', 'silver', 'reviews', 3),
  ('reviews_10', 120, 'server', 1320, 'reviews', 'diamond', 'reviews', 10),
  ('reviews_25', 250, 'server', 1330, 'reviews', 'netherite', 'reviews', 25),
  ('member_7', 15, 'server', 1340, 'member', 'bronze', 'memberDays', 7),
  ('member_30', 15, 'server', 1350, 'member', 'bronze', 'memberDays', 30),
  ('member_90', 30, 'server', 1360, 'member', 'silver', 'memberDays', 90),
  ('member_180', 60, 'server', 1370, 'member', 'gold', 'memberDays', 180),
  ('member_365', 120, 'server', 1380, 'member', 'diamond', 'memberDays', 365),
  ('member_730', 250, 'server', 1390, 'member', 'netherite', 'memberDays', 730),
  ('member_1825', 250, 'server', 1400, 'member', 'netherite', 'memberDays', 1825),
  ('earned_100', 15, 'server', 1410, 'earned', 'bronze', 'pointsEarned', 100),
  ('earned_500', 15, 'server', 1420, 'earned', 'bronze', 'pointsEarned', 500),
  ('earned_1000', 30, 'server', 1430, 'earned', 'silver', 'pointsEarned', 1000),
  ('earned_5000', 60, 'server', 1440, 'earned', 'gold', 'pointsEarned', 5000),
  ('earned_10000', 120, 'server', 1450, 'earned', 'diamond', 'pointsEarned', 10000),
  ('earned_50000', 250, 'server', 1460, 'earned', 'netherite', 'pointsEarned', 50000),
  ('earned_100000', 250, 'server', 1470, 'earned', 'netherite', 'pointsEarned', 100000),
  ('spent_100', 15, 'server', 1480, 'spent', 'bronze', 'pointsSpent', 100),
  ('spent_500', 15, 'server', 1490, 'spent', 'bronze', 'pointsSpent', 500),
  ('spent_1000', 30, 'server', 1500, 'spent', 'silver', 'pointsSpent', 1000),
  ('spent_2500', 60, 'server', 1510, 'spent', 'gold', 'pointsSpent', 2500),
  ('spent_5000', 120, 'server', 1520, 'spent', 'diamond', 'pointsSpent', 5000),
  ('spent_10000', 250, 'server', 1530, 'spent', 'netherite', 'pointsSpent', 10000),
  ('missions_1', 15, 'server', 1540, 'missions', 'bronze', 'missions', 1),
  ('missions_10', 15, 'server', 1550, 'missions', 'bronze', 'missions', 10),
  ('missions_50', 30, 'server', 1560, 'missions', 'silver', 'missions', 50),
  ('missions_100', 60, 'server', 1570, 'missions', 'gold', 'missions', 100),
  ('missions_500', 120, 'server', 1580, 'missions', 'diamond', 'missions', 500),
  ('missions_1000', 250, 'server', 1590, 'missions', 'netherite', 'missions', 1000),
  ('missions_5000', 250, 'server', 1600, 'missions', 'netherite', 'missions', 5000),
  ('collector_1', 15, 'server', 1610, 'collector', 'bronze', 'items', 1),
  ('collector_5', 15, 'server', 1620, 'collector', 'bronze', 'items', 5),
  ('collector_10', 30, 'server', 1630, 'collector', 'silver', 'items', 10),
  ('collector_20', 60, 'server', 1640, 'collector', 'gold', 'items', 20),
  ('collector_30', 120, 'server', 1650, 'collector', 'diamond', 'items', 30),
  ('collector_50', 250, 'server', 1660, 'collector', 'netherite', 'items', 50),
  ('achiever_10', 15, 'server', 1670, 'achiever', 'bronze', 'achievements', 10),
  ('achiever_25', 15, 'server', 1680, 'achiever', 'bronze', 'achievements', 25),
  ('achiever_50', 30, 'server', 1690, 'achiever', 'silver', 'achievements', 50),
  ('achiever_100', 60, 'server', 1700, 'achiever', 'gold', 'achievements', 100),
  ('dailies_7', 15, 'server', 1710, 'dailies', 'bronze', 'dailies', 7),
  ('dailies_30', 15, 'server', 1720, 'dailies', 'bronze', 'dailies', 30),
  ('dailies_90', 30, 'server', 1730, 'dailies', 'silver', 'dailies', 90),
  ('dailies_180', 60, 'server', 1740, 'dailies', 'gold', 'dailies', 180),
  ('dailies_365', 120, 'server', 1750, 'dailies', 'diamond', 'dailies', 365),
  ('dailies_1000', 250, 'server', 1760, 'dailies', 'netherite', 'dailies', 1000),
  ('first_party', 75, 'client', 1770, 'first_party', 'bronze', null, 1),
  ('skin_created', 50, 'client', 1780, 'skin_created', 'bronze', null, 1),
  ('first_voice', 25, 'client', 1790, 'first_voice', 'bronze', null, 1),
  ('first_overlay', 15, 'client', 1800, 'first_overlay', 'bronze', null, 1),
  ('night_owl', 25, 'client', 1810, 'night_owl', 'silver', 'flagNightOwl', 1),
  ('early_bird', 25, 'client', 1820, 'early_bird', 'silver', 'flagEarlyBird', 1),
  ('weekend_warrior', 25, 'client', 1830, 'weekend_warrior', 'silver', 'flagWeekend', 1),
  ('crash_survivor', 25, 'client', 1840, 'crash_survivor', 'silver', 'flagCrashSurvivor', 1),
  ('anniversary', 50, 'client', 1850, 'anniversary', 'gold', 'flagAnniversary', 1),
  ('profile_complete', 100, 'server', 1860, 'profile_complete', 'silver', 'profile', 1),
  ('mc_verified', 100, 'server', 1870, 'mc_verified', 'silver', 'verified', 1),
  ('badge_on', 50, 'server', 1880, 'badge_on', 'bronze', 'badge', 1),
  ('premium', 300, 'server', 1890, 'premium', 'gold', 'premium', 1)
on conflict (id) do update set points = excluded.points, check_kind = excluded.check_kind, sort = excluded.sort,
  family = excluded.family, tier = excluded.tier, metric = excluded.metric, target = excluded.target, active = true;
