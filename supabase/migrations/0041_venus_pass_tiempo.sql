-- Venus Launcher 4.6: el Venus Pass pasa a ganarse solo jugando. Guía: docs/wip/pase-46.md.
-- Depende de 0026 (tablas y RPC del pase) y de 0027 (motivo 'pass' en el libro de puntos). Idempotente.
--
--   * Una sola pista, sin compra: ya no hay ediciones (Go, Pro, Max), ni precio, ni pista premium separada. Todos
--     recorren los mismos 380 niveles (60 XP por nivel). Los premios van en la pista 'free' de pass_rewards (la columna
--     `track` de 0026 se conserva; nada usa 'premium').
--   * La XP sale solo de los minutos jugados (pass_playtime, 1 XP por minuto, hasta 120 por día). Venus Premium da +20 %
--     por los minutos jugados mientras se tiene Premium: se anota en pass_playtime.premium_minutes cuando se reporta, así
--     que perder Premium no baja el nivel ya ganado. Los Venus Points y las misiones ya no cuentan.
--   * Progresión permanente: temporada nueva 'venus-pass' (pass_seasons.permanent, ends_at lejano) y 'temporada-1'
--     desactivada. Se conservan sus tablas, su compra de prueba y sus 80 reclamos de pruebas (no hay dinero real).
--   * Premios: puntos en cada nivel, títulos, efectos de nombre y los marcos pass_frame_1..8 (bloque generado por
--     scripts/gen-pass-rewards-sql.js a partir de src/renderer/js/pages/pass/plan.js).
--   * La parte de pagos NO se toca (payments_mark_paid, payments_mark_status, payments_create_order, payments_catalog,
--     private.pass_quote, pass_fulfill y pass_revoke, pass_tiers, pass_purchases): sin ediciones a la venta,
--     pass_quote devuelve null y la orden se rechaza con 'unknown_plan'. Esas piezas quedan sin uso hasta que las limpie
--     la migración de pagos (docs/wip/pase-46.md).

-- ---------- 1) Límites, columnas y estado ----------
-- 380 niveles: pass_seasons.levels y pass_rewards.level pasan de 200 a 1000 como tope.
alter table public.pass_seasons drop constraint if exists pass_seasons_levels_check;
alter table public.pass_seasons add constraint pass_seasons_levels_check check (levels between 10 and 1000);
alter table public.pass_rewards drop constraint if exists pass_rewards_level_check;
alter table public.pass_rewards add constraint pass_rewards_level_check check (level between 1 and 1000);

-- Temporada permanente: la interfaz muestra "Permanente" en vez de los días que faltan.
alter table public.pass_seasons add column if not exists permanent boolean not null default false;
-- Minutos del día jugados con Venus Premium (de ahí sale el +20 %).
alter table public.pass_playtime add column if not exists premium_minutes integer not null default 0;
alter table public.pass_playtime drop constraint if exists pass_playtime_premium_check;
alter table public.pass_playtime add constraint pass_playtime_premium_check check (premium_minutes between 0 and minutes);

-- ---------- 2) Temporada permanente, marcos y premios ----------
insert into public.pass_seasons (id, name, starts_at, ends_at, active, levels, xp_per_level, permanent)
values ('venus-pass', 'Venus Pass', '2026-01-01 12:00:00+00', '2099-12-31 23:59:59+00', true, 380, 60, true)
on conflict (id) do nothing;
-- La vieja queda para el historial, pero ya no es la que se juega (pass_current elige la activa más reciente).
update public.pass_seasons set active = false where id = 'temporada-1' and active;

-- >>> premios-generados (scripts/gen-pass-rewards-sql.js: no editar a mano; para cambiarlos se edita pages/pass/plan.js y se vuelve a correr el script)
-- 380 niveles: 359 de puntos (6800 Venus Points en total) y 21 cosméticos.
-- Marcos del pase (los dibuja social/frames.js; el id pass_frame_N va con el estilo passN).
insert into public.shop_items (id, kind, price, premium_only, sort, data, source) values
  ('pass_frame_1', 'frame', 0, false, 310, '{"style":"pass1"}', 'pass'),
  ('pass_frame_2', 'frame', 0, false, 311, '{"style":"pass2"}', 'pass'),
  ('pass_frame_3', 'frame', 0, false, 312, '{"style":"pass3"}', 'pass'),
  ('pass_frame_4', 'frame', 0, false, 313, '{"style":"pass4"}', 'pass'),
  ('pass_frame_5', 'frame', 0, false, 314, '{"style":"pass5"}', 'pass'),
  ('pass_frame_6', 'frame', 0, false, 315, '{"style":"pass6"}', 'pass'),
  ('pass_frame_7', 'frame', 0, false, 316, '{"style":"pass7"}', 'pass'),
  ('pass_frame_8', 'frame', 0, false, 317, '{"style":"pass8"}', 'pass')
on conflict (id) do update set kind = excluded.kind, price = excluded.price, premium_only = excluded.premium_only,
  sort = excluded.sort, data = excluded.data, source = excluded.source;

-- Todo cosmético de la pista tiene que existir en shop_items (si falta uno, la migración se detiene con el nombre).
do $$
declare v_missing text;
begin
  select string_agg(x, ', ' order by x) into v_missing from unnest(array['pass_s1_free_title', 'pass_frame_1', 'title_explorer', 'effect_shimmer', 'pass_frame_2', 'pass_s1_title', 'pass_frame_3', 'effect_ocean', 'title_collector', 'pass_frame_4', 'pass_s1_effect', 'title_hardcore', 'pass_frame_5', 'effect_gold', 'title_veteran', 'pass_frame_6', 'effect_galaxy', 'pass_frame_7', 'title_legend', 'effect_glitch', 'pass_frame_8']) x
   where not exists (select 1 from public.shop_items s where s.id = x);
  if v_missing is not null then raise exception 'pass_items_missing: %', v_missing using errcode = '22023'; end if;
end $$;

insert into public.pass_rewards (season_id, level, track, kind, amount, item_id) values
  ('venus-pass', 1, 'free', 'points', 10, null),
  ('venus-pass', 2, 'free', 'points', 10, null),
  ('venus-pass', 3, 'free', 'points', 10, null),
  ('venus-pass', 4, 'free', 'points', 10, null),
  ('venus-pass', 5, 'free', 'points', 10, null),
  ('venus-pass', 6, 'free', 'points', 10, null),
  ('venus-pass', 7, 'free', 'points', 10, null),
  ('venus-pass', 8, 'free', 'points', 10, null),
  ('venus-pass', 9, 'free', 'points', 10, null),
  ('venus-pass', 10, 'free', 'item', null, 'pass_s1_free_title'),
  ('venus-pass', 11, 'free', 'points', 10, null),
  ('venus-pass', 12, 'free', 'points', 10, null),
  ('venus-pass', 13, 'free', 'points', 10, null),
  ('venus-pass', 14, 'free', 'points', 10, null),
  ('venus-pass', 15, 'free', 'points', 10, null),
  ('venus-pass', 16, 'free', 'points', 10, null),
  ('venus-pass', 17, 'free', 'points', 10, null),
  ('venus-pass', 18, 'free', 'points', 10, null),
  ('venus-pass', 19, 'free', 'points', 10, null),
  ('venus-pass', 20, 'free', 'points', 30, null),
  ('venus-pass', 21, 'free', 'points', 10, null),
  ('venus-pass', 22, 'free', 'points', 10, null),
  ('venus-pass', 23, 'free', 'points', 10, null),
  ('venus-pass', 24, 'free', 'points', 10, null),
  ('venus-pass', 25, 'free', 'item', null, 'pass_frame_1'),
  ('venus-pass', 26, 'free', 'points', 10, null),
  ('venus-pass', 27, 'free', 'points', 10, null),
  ('venus-pass', 28, 'free', 'points', 10, null),
  ('venus-pass', 29, 'free', 'points', 10, null),
  ('venus-pass', 30, 'free', 'points', 30, null),
  ('venus-pass', 31, 'free', 'points', 10, null),
  ('venus-pass', 32, 'free', 'points', 10, null),
  ('venus-pass', 33, 'free', 'points', 10, null),
  ('venus-pass', 34, 'free', 'points', 10, null),
  ('venus-pass', 35, 'free', 'item', null, 'title_explorer'),
  ('venus-pass', 36, 'free', 'points', 10, null),
  ('venus-pass', 37, 'free', 'points', 10, null),
  ('venus-pass', 38, 'free', 'points', 10, null),
  ('venus-pass', 39, 'free', 'points', 10, null),
  ('venus-pass', 40, 'free', 'points', 30, null),
  ('venus-pass', 41, 'free', 'points', 10, null),
  ('venus-pass', 42, 'free', 'points', 10, null),
  ('venus-pass', 43, 'free', 'points', 10, null),
  ('venus-pass', 44, 'free', 'points', 10, null),
  ('venus-pass', 45, 'free', 'item', null, 'effect_shimmer'),
  ('venus-pass', 46, 'free', 'points', 10, null),
  ('venus-pass', 47, 'free', 'points', 10, null),
  ('venus-pass', 48, 'free', 'points', 10, null),
  ('venus-pass', 49, 'free', 'points', 10, null),
  ('venus-pass', 50, 'free', 'points', 30, null),
  ('venus-pass', 51, 'free', 'points', 12, null),
  ('venus-pass', 52, 'free', 'points', 12, null),
  ('venus-pass', 53, 'free', 'points', 12, null),
  ('venus-pass', 54, 'free', 'points', 12, null),
  ('venus-pass', 55, 'free', 'points', 12, null),
  ('venus-pass', 56, 'free', 'points', 12, null),
  ('venus-pass', 57, 'free', 'points', 12, null),
  ('venus-pass', 58, 'free', 'points', 12, null),
  ('venus-pass', 59, 'free', 'points', 12, null),
  ('venus-pass', 60, 'free', 'item', null, 'pass_frame_2'),
  ('venus-pass', 61, 'free', 'points', 12, null),
  ('venus-pass', 62, 'free', 'points', 12, null),
  ('venus-pass', 63, 'free', 'points', 12, null),
  ('venus-pass', 64, 'free', 'points', 12, null),
  ('venus-pass', 65, 'free', 'points', 12, null),
  ('venus-pass', 66, 'free', 'points', 12, null),
  ('venus-pass', 67, 'free', 'points', 12, null),
  ('venus-pass', 68, 'free', 'points', 12, null),
  ('venus-pass', 69, 'free', 'points', 12, null),
  ('venus-pass', 70, 'free', 'points', 36, null),
  ('venus-pass', 71, 'free', 'points', 12, null),
  ('venus-pass', 72, 'free', 'points', 12, null),
  ('venus-pass', 73, 'free', 'points', 12, null),
  ('venus-pass', 74, 'free', 'points', 12, null),
  ('venus-pass', 75, 'free', 'points', 12, null),
  ('venus-pass', 76, 'free', 'points', 12, null),
  ('venus-pass', 77, 'free', 'points', 12, null),
  ('venus-pass', 78, 'free', 'points', 12, null),
  ('venus-pass', 79, 'free', 'points', 12, null),
  ('venus-pass', 80, 'free', 'points', 36, null),
  ('venus-pass', 81, 'free', 'points', 12, null),
  ('venus-pass', 82, 'free', 'points', 12, null),
  ('venus-pass', 83, 'free', 'points', 12, null),
  ('venus-pass', 84, 'free', 'points', 12, null),
  ('venus-pass', 85, 'free', 'item', null, 'pass_s1_title'),
  ('venus-pass', 86, 'free', 'points', 12, null),
  ('venus-pass', 87, 'free', 'points', 12, null),
  ('venus-pass', 88, 'free', 'points', 12, null),
  ('venus-pass', 89, 'free', 'points', 12, null),
  ('venus-pass', 90, 'free', 'points', 36, null),
  ('venus-pass', 91, 'free', 'points', 12, null),
  ('venus-pass', 92, 'free', 'points', 12, null),
  ('venus-pass', 93, 'free', 'points', 12, null),
  ('venus-pass', 94, 'free', 'points', 12, null),
  ('venus-pass', 95, 'free', 'points', 12, null),
  ('venus-pass', 96, 'free', 'points', 12, null),
  ('venus-pass', 97, 'free', 'points', 12, null),
  ('venus-pass', 98, 'free', 'points', 12, null),
  ('venus-pass', 99, 'free', 'points', 12, null),
  ('venus-pass', 100, 'free', 'item', null, 'pass_frame_3'),
  ('venus-pass', 101, 'free', 'points', 14, null),
  ('venus-pass', 102, 'free', 'points', 14, null),
  ('venus-pass', 103, 'free', 'points', 14, null),
  ('venus-pass', 104, 'free', 'points', 14, null),
  ('venus-pass', 105, 'free', 'points', 14, null),
  ('venus-pass', 106, 'free', 'points', 14, null),
  ('venus-pass', 107, 'free', 'points', 14, null),
  ('venus-pass', 108, 'free', 'points', 14, null),
  ('venus-pass', 109, 'free', 'points', 14, null),
  ('venus-pass', 110, 'free', 'item', null, 'effect_ocean'),
  ('venus-pass', 111, 'free', 'points', 14, null),
  ('venus-pass', 112, 'free', 'points', 14, null),
  ('venus-pass', 113, 'free', 'points', 14, null),
  ('venus-pass', 114, 'free', 'points', 14, null),
  ('venus-pass', 115, 'free', 'points', 14, null),
  ('venus-pass', 116, 'free', 'points', 14, null),
  ('venus-pass', 117, 'free', 'points', 14, null),
  ('venus-pass', 118, 'free', 'points', 14, null),
  ('venus-pass', 119, 'free', 'points', 14, null),
  ('venus-pass', 120, 'free', 'points', 42, null),
  ('venus-pass', 121, 'free', 'points', 14, null),
  ('venus-pass', 122, 'free', 'points', 14, null),
  ('venus-pass', 123, 'free', 'points', 14, null),
  ('venus-pass', 124, 'free', 'points', 14, null),
  ('venus-pass', 125, 'free', 'item', null, 'title_collector'),
  ('venus-pass', 126, 'free', 'points', 14, null),
  ('venus-pass', 127, 'free', 'points', 14, null),
  ('venus-pass', 128, 'free', 'points', 14, null),
  ('venus-pass', 129, 'free', 'points', 14, null),
  ('venus-pass', 130, 'free', 'points', 42, null),
  ('venus-pass', 131, 'free', 'points', 14, null),
  ('venus-pass', 132, 'free', 'points', 14, null),
  ('venus-pass', 133, 'free', 'points', 14, null),
  ('venus-pass', 134, 'free', 'points', 14, null),
  ('venus-pass', 135, 'free', 'points', 14, null),
  ('venus-pass', 136, 'free', 'points', 14, null),
  ('venus-pass', 137, 'free', 'points', 14, null),
  ('venus-pass', 138, 'free', 'points', 14, null),
  ('venus-pass', 139, 'free', 'points', 14, null),
  ('venus-pass', 140, 'free', 'points', 42, null),
  ('venus-pass', 141, 'free', 'points', 14, null),
  ('venus-pass', 142, 'free', 'points', 14, null),
  ('venus-pass', 143, 'free', 'points', 14, null),
  ('venus-pass', 144, 'free', 'points', 14, null),
  ('venus-pass', 145, 'free', 'points', 14, null),
  ('venus-pass', 146, 'free', 'points', 14, null),
  ('venus-pass', 147, 'free', 'points', 14, null),
  ('venus-pass', 148, 'free', 'points', 14, null),
  ('venus-pass', 149, 'free', 'points', 14, null),
  ('venus-pass', 150, 'free', 'item', null, 'pass_frame_4'),
  ('venus-pass', 151, 'free', 'points', 16, null),
  ('venus-pass', 152, 'free', 'points', 16, null),
  ('venus-pass', 153, 'free', 'points', 16, null),
  ('venus-pass', 154, 'free', 'points', 16, null),
  ('venus-pass', 155, 'free', 'points', 16, null),
  ('venus-pass', 156, 'free', 'points', 16, null),
  ('venus-pass', 157, 'free', 'points', 16, null),
  ('venus-pass', 158, 'free', 'points', 16, null),
  ('venus-pass', 159, 'free', 'points', 16, null),
  ('venus-pass', 160, 'free', 'points', 48, null),
  ('venus-pass', 161, 'free', 'points', 16, null),
  ('venus-pass', 162, 'free', 'points', 16, null),
  ('venus-pass', 163, 'free', 'points', 16, null),
  ('venus-pass', 164, 'free', 'points', 16, null),
  ('venus-pass', 165, 'free', 'item', null, 'pass_s1_effect'),
  ('venus-pass', 166, 'free', 'points', 16, null),
  ('venus-pass', 167, 'free', 'points', 16, null),
  ('venus-pass', 168, 'free', 'points', 16, null),
  ('venus-pass', 169, 'free', 'points', 16, null),
  ('venus-pass', 170, 'free', 'points', 48, null),
  ('venus-pass', 171, 'free', 'points', 16, null),
  ('venus-pass', 172, 'free', 'points', 16, null),
  ('venus-pass', 173, 'free', 'points', 16, null),
  ('venus-pass', 174, 'free', 'points', 16, null),
  ('venus-pass', 175, 'free', 'item', null, 'title_hardcore'),
  ('venus-pass', 176, 'free', 'points', 16, null),
  ('venus-pass', 177, 'free', 'points', 16, null),
  ('venus-pass', 178, 'free', 'points', 16, null),
  ('venus-pass', 179, 'free', 'points', 16, null),
  ('venus-pass', 180, 'free', 'points', 48, null),
  ('venus-pass', 181, 'free', 'points', 16, null),
  ('venus-pass', 182, 'free', 'points', 16, null),
  ('venus-pass', 183, 'free', 'points', 16, null),
  ('venus-pass', 184, 'free', 'points', 16, null),
  ('venus-pass', 185, 'free', 'points', 16, null),
  ('venus-pass', 186, 'free', 'points', 16, null),
  ('venus-pass', 187, 'free', 'points', 16, null),
  ('venus-pass', 188, 'free', 'points', 16, null),
  ('venus-pass', 189, 'free', 'points', 16, null),
  ('venus-pass', 190, 'free', 'points', 48, null),
  ('venus-pass', 191, 'free', 'points', 16, null),
  ('venus-pass', 192, 'free', 'points', 16, null),
  ('venus-pass', 193, 'free', 'points', 16, null),
  ('venus-pass', 194, 'free', 'points', 16, null),
  ('venus-pass', 195, 'free', 'points', 16, null),
  ('venus-pass', 196, 'free', 'points', 16, null),
  ('venus-pass', 197, 'free', 'points', 16, null),
  ('venus-pass', 198, 'free', 'points', 16, null),
  ('venus-pass', 199, 'free', 'points', 16, null),
  ('venus-pass', 200, 'free', 'item', null, 'pass_frame_5'),
  ('venus-pass', 201, 'free', 'points', 18, null),
  ('venus-pass', 202, 'free', 'points', 18, null),
  ('venus-pass', 203, 'free', 'points', 18, null),
  ('venus-pass', 204, 'free', 'points', 18, null),
  ('venus-pass', 205, 'free', 'points', 18, null),
  ('venus-pass', 206, 'free', 'points', 18, null),
  ('venus-pass', 207, 'free', 'points', 18, null),
  ('venus-pass', 208, 'free', 'points', 18, null),
  ('venus-pass', 209, 'free', 'points', 18, null),
  ('venus-pass', 210, 'free', 'points', 54, null),
  ('venus-pass', 211, 'free', 'points', 18, null),
  ('venus-pass', 212, 'free', 'points', 18, null),
  ('venus-pass', 213, 'free', 'points', 18, null),
  ('venus-pass', 214, 'free', 'points', 18, null),
  ('venus-pass', 215, 'free', 'item', null, 'effect_gold'),
  ('venus-pass', 216, 'free', 'points', 18, null),
  ('venus-pass', 217, 'free', 'points', 18, null),
  ('venus-pass', 218, 'free', 'points', 18, null),
  ('venus-pass', 219, 'free', 'points', 18, null),
  ('venus-pass', 220, 'free', 'points', 54, null),
  ('venus-pass', 221, 'free', 'points', 18, null),
  ('venus-pass', 222, 'free', 'points', 18, null),
  ('venus-pass', 223, 'free', 'points', 18, null),
  ('venus-pass', 224, 'free', 'points', 18, null),
  ('venus-pass', 225, 'free', 'points', 18, null),
  ('venus-pass', 226, 'free', 'points', 18, null),
  ('venus-pass', 227, 'free', 'points', 18, null),
  ('venus-pass', 228, 'free', 'points', 18, null),
  ('venus-pass', 229, 'free', 'points', 18, null),
  ('venus-pass', 230, 'free', 'item', null, 'title_veteran'),
  ('venus-pass', 231, 'free', 'points', 18, null),
  ('venus-pass', 232, 'free', 'points', 18, null),
  ('venus-pass', 233, 'free', 'points', 18, null),
  ('venus-pass', 234, 'free', 'points', 18, null),
  ('venus-pass', 235, 'free', 'points', 18, null),
  ('venus-pass', 236, 'free', 'points', 18, null),
  ('venus-pass', 237, 'free', 'points', 18, null),
  ('venus-pass', 238, 'free', 'points', 18, null),
  ('venus-pass', 239, 'free', 'points', 18, null),
  ('venus-pass', 240, 'free', 'points', 54, null),
  ('venus-pass', 241, 'free', 'points', 18, null),
  ('venus-pass', 242, 'free', 'points', 18, null),
  ('venus-pass', 243, 'free', 'points', 18, null),
  ('venus-pass', 244, 'free', 'points', 18, null),
  ('venus-pass', 245, 'free', 'points', 18, null),
  ('venus-pass', 246, 'free', 'points', 18, null),
  ('venus-pass', 247, 'free', 'points', 18, null),
  ('venus-pass', 248, 'free', 'points', 18, null),
  ('venus-pass', 249, 'free', 'points', 18, null),
  ('venus-pass', 250, 'free', 'points', 54, null),
  ('venus-pass', 251, 'free', 'points', 20, null),
  ('venus-pass', 252, 'free', 'points', 20, null),
  ('venus-pass', 253, 'free', 'points', 20, null),
  ('venus-pass', 254, 'free', 'points', 20, null),
  ('venus-pass', 255, 'free', 'points', 20, null),
  ('venus-pass', 256, 'free', 'points', 20, null),
  ('venus-pass', 257, 'free', 'points', 20, null),
  ('venus-pass', 258, 'free', 'points', 20, null),
  ('venus-pass', 259, 'free', 'points', 20, null),
  ('venus-pass', 260, 'free', 'item', null, 'pass_frame_6'),
  ('venus-pass', 261, 'free', 'points', 20, null),
  ('venus-pass', 262, 'free', 'points', 20, null),
  ('venus-pass', 263, 'free', 'points', 20, null),
  ('venus-pass', 264, 'free', 'points', 20, null),
  ('venus-pass', 265, 'free', 'points', 20, null),
  ('venus-pass', 266, 'free', 'points', 20, null),
  ('venus-pass', 267, 'free', 'points', 20, null),
  ('venus-pass', 268, 'free', 'points', 20, null),
  ('venus-pass', 269, 'free', 'points', 20, null),
  ('venus-pass', 270, 'free', 'points', 60, null),
  ('venus-pass', 271, 'free', 'points', 20, null),
  ('venus-pass', 272, 'free', 'points', 20, null),
  ('venus-pass', 273, 'free', 'points', 20, null),
  ('venus-pass', 274, 'free', 'points', 20, null),
  ('venus-pass', 275, 'free', 'points', 20, null),
  ('venus-pass', 276, 'free', 'points', 20, null),
  ('venus-pass', 277, 'free', 'points', 20, null),
  ('venus-pass', 278, 'free', 'points', 20, null),
  ('venus-pass', 279, 'free', 'points', 20, null),
  ('venus-pass', 280, 'free', 'item', null, 'effect_galaxy'),
  ('venus-pass', 281, 'free', 'points', 20, null),
  ('venus-pass', 282, 'free', 'points', 20, null),
  ('venus-pass', 283, 'free', 'points', 20, null),
  ('venus-pass', 284, 'free', 'points', 20, null),
  ('venus-pass', 285, 'free', 'points', 20, null),
  ('venus-pass', 286, 'free', 'points', 20, null),
  ('venus-pass', 287, 'free', 'points', 20, null),
  ('venus-pass', 288, 'free', 'points', 20, null),
  ('venus-pass', 289, 'free', 'points', 20, null),
  ('venus-pass', 290, 'free', 'points', 60, null),
  ('venus-pass', 291, 'free', 'points', 20, null),
  ('venus-pass', 292, 'free', 'points', 20, null),
  ('venus-pass', 293, 'free', 'points', 20, null),
  ('venus-pass', 294, 'free', 'points', 20, null),
  ('venus-pass', 295, 'free', 'points', 20, null),
  ('venus-pass', 296, 'free', 'points', 20, null),
  ('venus-pass', 297, 'free', 'points', 20, null),
  ('venus-pass', 298, 'free', 'points', 20, null),
  ('venus-pass', 299, 'free', 'points', 20, null),
  ('venus-pass', 300, 'free', 'points', 60, null),
  ('venus-pass', 301, 'free', 'points', 22, null),
  ('venus-pass', 302, 'free', 'points', 22, null),
  ('venus-pass', 303, 'free', 'points', 22, null),
  ('venus-pass', 304, 'free', 'points', 22, null),
  ('venus-pass', 305, 'free', 'points', 22, null),
  ('venus-pass', 306, 'free', 'points', 22, null),
  ('venus-pass', 307, 'free', 'points', 22, null),
  ('venus-pass', 308, 'free', 'points', 22, null),
  ('venus-pass', 309, 'free', 'points', 22, null),
  ('venus-pass', 310, 'free', 'points', 66, null),
  ('venus-pass', 311, 'free', 'points', 22, null),
  ('venus-pass', 312, 'free', 'points', 22, null),
  ('venus-pass', 313, 'free', 'points', 22, null),
  ('venus-pass', 314, 'free', 'points', 22, null),
  ('venus-pass', 315, 'free', 'points', 22, null),
  ('venus-pass', 316, 'free', 'points', 22, null),
  ('venus-pass', 317, 'free', 'points', 22, null),
  ('venus-pass', 318, 'free', 'points', 22, null),
  ('venus-pass', 319, 'free', 'points', 22, null),
  ('venus-pass', 320, 'free', 'item', null, 'pass_frame_7'),
  ('venus-pass', 321, 'free', 'points', 22, null),
  ('venus-pass', 322, 'free', 'points', 22, null),
  ('venus-pass', 323, 'free', 'points', 22, null),
  ('venus-pass', 324, 'free', 'points', 22, null),
  ('venus-pass', 325, 'free', 'points', 22, null),
  ('venus-pass', 326, 'free', 'points', 22, null),
  ('venus-pass', 327, 'free', 'points', 22, null),
  ('venus-pass', 328, 'free', 'points', 22, null),
  ('venus-pass', 329, 'free', 'points', 22, null),
  ('venus-pass', 330, 'free', 'points', 66, null),
  ('venus-pass', 331, 'free', 'points', 22, null),
  ('venus-pass', 332, 'free', 'points', 22, null),
  ('venus-pass', 333, 'free', 'points', 22, null),
  ('venus-pass', 334, 'free', 'points', 22, null),
  ('venus-pass', 335, 'free', 'points', 22, null),
  ('venus-pass', 336, 'free', 'points', 22, null),
  ('venus-pass', 337, 'free', 'points', 22, null),
  ('venus-pass', 338, 'free', 'points', 22, null),
  ('venus-pass', 339, 'free', 'points', 22, null),
  ('venus-pass', 340, 'free', 'item', null, 'title_legend'),
  ('venus-pass', 341, 'free', 'points', 22, null),
  ('venus-pass', 342, 'free', 'points', 22, null),
  ('venus-pass', 343, 'free', 'points', 22, null),
  ('venus-pass', 344, 'free', 'points', 22, null),
  ('venus-pass', 345, 'free', 'points', 22, null),
  ('venus-pass', 346, 'free', 'points', 22, null),
  ('venus-pass', 347, 'free', 'points', 22, null),
  ('venus-pass', 348, 'free', 'points', 22, null),
  ('venus-pass', 349, 'free', 'points', 22, null),
  ('venus-pass', 350, 'free', 'item', null, 'effect_glitch'),
  ('venus-pass', 351, 'free', 'points', 24, null),
  ('venus-pass', 352, 'free', 'points', 24, null),
  ('venus-pass', 353, 'free', 'points', 24, null),
  ('venus-pass', 354, 'free', 'points', 24, null),
  ('venus-pass', 355, 'free', 'points', 24, null),
  ('venus-pass', 356, 'free', 'points', 24, null),
  ('venus-pass', 357, 'free', 'points', 24, null),
  ('venus-pass', 358, 'free', 'points', 24, null),
  ('venus-pass', 359, 'free', 'points', 24, null),
  ('venus-pass', 360, 'free', 'points', 72, null),
  ('venus-pass', 361, 'free', 'points', 24, null),
  ('venus-pass', 362, 'free', 'points', 24, null),
  ('venus-pass', 363, 'free', 'points', 24, null),
  ('venus-pass', 364, 'free', 'points', 24, null),
  ('venus-pass', 365, 'free', 'points', 24, null),
  ('venus-pass', 366, 'free', 'points', 24, null),
  ('venus-pass', 367, 'free', 'points', 24, null),
  ('venus-pass', 368, 'free', 'points', 24, null),
  ('venus-pass', 369, 'free', 'points', 24, null),
  ('venus-pass', 370, 'free', 'points', 72, null),
  ('venus-pass', 371, 'free', 'points', 24, null),
  ('venus-pass', 372, 'free', 'points', 24, null),
  ('venus-pass', 373, 'free', 'points', 24, null),
  ('venus-pass', 374, 'free', 'points', 24, null),
  ('venus-pass', 375, 'free', 'points', 24, null),
  ('venus-pass', 376, 'free', 'points', 24, null),
  ('venus-pass', 377, 'free', 'points', 24, null),
  ('venus-pass', 378, 'free', 'points', 24, null),
  ('venus-pass', 379, 'free', 'points', 24, null),
  ('venus-pass', 380, 'free', 'item', null, 'pass_frame_8')
on conflict (season_id, level, track) do nothing;
-- <<< premios-generados

-- ---------- 3) XP y nivel ----------
-- XP del pase: los minutos jugados (pass_playtime) más el 20 % de los que se jugaron con Venus Premium (división entera:
-- floor). Devuelve { xp, fromPlay, fromBonus, premiumMult (1,2 si hoy tiene Premium: es solo informativo), total }.
-- pass_revoke (0026, pagos) lee `total`; se conserva.
create or replace function private.pass_xp(p_user uuid, p_season public.pass_seasons) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_play bigint;
  v_premium bigint;
  v_bonus bigint;
begin
  select coalesce(sum(pt.minutes), 0), coalesce(sum(pt.premium_minutes), 0) into v_play, v_premium
    from public.pass_playtime pt where pt.user_id = p_user and pt.season_id = p_season.id;
  v_bonus := v_premium / 5;
  return jsonb_build_object('xp', v_play + v_bonus, 'fromPlay', v_play, 'fromBonus', v_bonus,
    'premiumMult', case when public.venus_is_premium(p_user) then 1.2 else 1 end, 'total', v_play + v_bonus);
end $$;

-- Lo que ve la página del pase. Sin temporada activa: { season: null }.
create or replace function public.pass_me() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  s public.pass_seasons;
  x jsonb;
  v_level integer;
  today date := (now() at time zone 'utc')::date;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  s := private.pass_current();
  if s.id is null then return jsonb_build_object('season', null); end if;
  x := private.pass_xp(me, s);
  v_level := private.pass_level(s, (x ->> 'total')::bigint);
  return jsonb_build_object(
    'season', jsonb_build_object('id', s.id, 'name', s.name, 'startsAt', public.ai_iso(s.starts_at), 'endsAt', public.ai_iso(s.ends_at),
      'levels', s.levels, 'xpPerLevel', s.xp_per_level, 'started', now() >= s.starts_at, 'ended', not s.permanent and now() >= s.ends_at,
      'permanent', s.permanent),
    'xp', x, 'level', v_level,
    'levelXp', case when v_level >= s.levels then s.xp_per_level else ((x ->> 'total')::bigint % s.xp_per_level) end,
    'playToday', coalesce((select pt.minutes from public.pass_playtime pt where pt.user_id = me and pt.season_id = s.id and pt.day = today), 0),
    'playCap', 120,
    'claimable', (select count(*) from public.pass_rewards r
                   where r.season_id = s.id and r.track = 'free' and r.level <= v_level
                     and not exists (select 1 from public.pass_claims c where c.user_id = me and c.season_id = s.id and c.level = r.level and c.track = r.track)),
    'rewards', coalesce((select jsonb_agg(jsonb_build_object('level', r.level, 'kind', r.kind, 'amount', r.amount, 'itemId', r.item_id, 'claimed', c.user_id is not null)
                           order by r.level)
                         from public.pass_rewards r
                         left join public.pass_claims c on c.user_id = me and c.season_id = r.season_id and c.level = r.level and c.track = r.track
                        where r.season_id = s.id and r.track = 'free'), '[]'::jsonb));
end $$;

-- Minutos jugados que reporta el launcher (de a 1 a 30 por llamada, hasta 120 por día). Devuelve { today, added }.
-- (0026 más premium_minutes: los minutos que se suman mientras la cuenta tiene Venus Premium.)
create or replace function public.pass_playtime(p_minutes integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  s public.pass_seasons;
  today date := (now() at time zone 'utc')::date;
  v_before integer;
  v_after integer;
  v_premium boolean;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if p_minutes is null or p_minutes < 1 or p_minutes > 30 then raise exception 'bad_minutes' using errcode = '22023'; end if;
  s := private.pass_current();
  if s.id is null or now() < s.starts_at or now() >= s.ends_at then return jsonb_build_object('today', 0, 'added', 0); end if;
  v_premium := public.venus_is_premium(me);
  insert into public.pass_playtime (user_id, season_id, day, minutes) values (me, s.id, today, 0) on conflict do nothing;
  select pt.minutes into v_before from public.pass_playtime pt where pt.user_id = me and pt.season_id = s.id and pt.day = today for update;
  v_after := least(120, v_before + p_minutes);
  update public.pass_playtime set minutes = v_after, premium_minutes = premium_minutes + case when v_premium then v_after - v_before else 0 end
   where user_id = me and season_id = s.id and day = today;
  return jsonb_build_object('today', v_after, 'added', v_after - v_before);
end $$;

-- ---------- 4) Reclamar ----------
-- Registra el reclamo y entrega el premio (puntos o cosmético). Quien llama ya tomó el candado de puntos y comprobó
-- el nivel y que no estuviera reclamado.
create or replace function private.pass_grant(p_user uuid, p_season public.pass_seasons, r public.pass_rewards) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_points integer := 0;
begin
  insert into public.pass_claims (user_id, season_id, level, track) values (p_user, p_season.id, r.level, r.track);
  if r.kind = 'points' then
    v_points := private.points_award(p_user, r.amount, 'pass', p_season.id || ':' || r.level || ':' || r.track);
  else
    insert into public.user_items (user_id, item_id) values (p_user, r.item_id) on conflict do nothing;
  end if;
  return jsonb_build_object('level', r.level, 'track', r.track, 'kind', r.kind, 'points', v_points, 'itemId', r.item_id);
end $$;

-- Reclama el premio de un nivel. Errores (22023): no_season, bad_reward, locked (nivel no alcanzado), already.
-- p_track se conserva por los launchers anteriores: la única pista es 'free'.
create or replace function public.pass_claim(p_level integer, p_track text default 'free') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  s public.pass_seasons;
  r public.pass_rewards;
  v_level integer;
  v_one jsonb;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if public.moderation_social_block(me) = 'user_banned' then raise exception 'user_banned' using errcode = '42501'; end if;
  s := private.pass_current();
  if s.id is null then raise exception 'no_season' using errcode = '22023'; end if;
  select * into r from public.pass_rewards where season_id = s.id and level = p_level and track = coalesce(p_track, 'free');
  if not found then raise exception 'bad_reward' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext('points:' || me::text));
  v_level := private.pass_level(s, (private.pass_xp(me, s) ->> 'total')::bigint);
  if r.level > v_level then raise exception 'locked' using errcode = '22023'; end if;
  if exists (select 1 from public.pass_claims c where c.user_id = me and c.season_id = s.id and c.level = r.level and c.track = r.track) then
    raise exception 'already' using errcode = '22023';
  end if;
  v_one := private.pass_grant(me, s, r);
  -- El saldo se lee en otra sentencia: así ya cuenta los puntos recién entregados.
  return v_one || jsonb_build_object('balance', private.points_balance(me));
end $$;

-- Reclama todo lo que esté disponible, en una sola pasada (el nivel se calcula una vez). Devuelve { claimed: [...], points, balance }.
create or replace function public.pass_claim_all() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  s public.pass_seasons;
  r public.pass_rewards;
  v_level integer;
  v_out jsonb := '[]'::jsonb;
  v_points integer := 0;
  v_one jsonb;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if public.moderation_social_block(me) = 'user_banned' then raise exception 'user_banned' using errcode = '42501'; end if;
  s := private.pass_current();
  if s.id is null then raise exception 'no_season' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext('points:' || me::text));
  v_level := private.pass_level(s, (private.pass_xp(me, s) ->> 'total')::bigint);
  for r in select x.* from public.pass_rewards x
            where x.season_id = s.id and x.track = 'free' and x.level <= v_level
              and not exists (select 1 from public.pass_claims c where c.user_id = me and c.season_id = s.id and c.level = x.level and c.track = x.track)
            order by x.level loop
    v_one := private.pass_grant(me, s, r);
    v_points := v_points + (v_one ->> 'points')::integer;
    v_out := v_out || jsonb_build_array(v_one);
  end loop;
  return jsonb_build_object('claimed', v_out, 'points', v_points, 'balance', private.points_balance(me));
end $$;

-- ---------- 5) Administración ----------
-- Las temporadas con su actividad: jugadores con minutos, minutos totales y premios reclamados.
create or replace function public.admin_pass_seasons() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.admin_guard();
  return coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'startsAt', public.ai_iso(s.starts_at), 'endsAt', public.ai_iso(s.ends_at),
      'active', s.active, 'permanent', s.permanent, 'levels', s.levels, 'xpPerLevel', s.xp_per_level,
      'rewards', (select count(*) from public.pass_rewards r where r.season_id = s.id),
      'players', (select count(distinct pt.user_id) from public.pass_playtime pt where pt.season_id = s.id),
      'minutes', (select coalesce(sum(pt.minutes), 0) from public.pass_playtime pt where pt.season_id = s.id),
      'claims', (select count(*) from public.pass_claims c where c.season_id = s.id))
      order by s.active desc, s.starts_at desc) from public.pass_seasons s), '[]'::jsonb);
end $$;

-- Crea o cambia una temporada: { id, name, startsAt, endsAt, active, permanent, levels, xpPerLevel, copyRewardsFrom? }
-- (los premios de una temporada nueva se copian de otra). Una sola activa a la vez. Cambiar los niveles o la XP por
-- nivel mueve a todos de nivel; los reclamos ya hechos no se tocan.
create or replace function public.admin_pass_season_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_id text := p ->> 'id';
  v_new boolean;
  v_from text := p ->> 'copyRewardsFrom';
  v_perm boolean := coalesce((p ->> 'permanent')::boolean, false);
  v_starts timestamptz := (p ->> 'startsAt')::timestamptz;
  v_ends timestamptz := (p ->> 'endsAt')::timestamptz;
  v_levels integer := coalesce((p ->> 'levels')::integer, 380);
  v_xp integer := coalesce((p ->> 'xpPerLevel')::integer, 60);
  v_active boolean := coalesce((p ->> 'active')::boolean, false);
begin
  perform public.admin_guard();
  if v_id is null or v_id !~ '^[a-z0-9_-]{2,40}$' then raise exception 'bad_id' using errcode = '22023'; end if;
  if p ->> 'name' is null or char_length(btrim(p ->> 'name')) not between 1 and 60 then raise exception 'bad_name' using errcode = '22023'; end if;
  if v_perm and v_ends is null then v_ends := '2099-12-31 23:59:59+00'; end if;
  if v_starts is null or v_ends is null or v_ends <= v_starts then raise exception 'bad_dates' using errcode = '22023'; end if;
  if v_levels not between 10 and 1000 then raise exception 'bad_levels' using errcode = '22023'; end if;
  if v_xp not between 10 and 100000 then raise exception 'bad_xp' using errcode = '22023'; end if;
  v_new := not exists (select 1 from public.pass_seasons where id = v_id);
  insert into public.pass_seasons (id, name, starts_at, ends_at, active, levels, xp_per_level, permanent)
  values (v_id, btrim(p ->> 'name'), v_starts, v_ends, v_active, v_levels, v_xp, v_perm)
  on conflict (id) do update set name = excluded.name, starts_at = excluded.starts_at, ends_at = excluded.ends_at, active = excluded.active,
    levels = excluded.levels, xp_per_level = excluded.xp_per_level, permanent = excluded.permanent;
  if v_active then update public.pass_seasons set active = false where id <> v_id and active; end if;
  if v_new and v_from is not null then
    insert into public.pass_rewards (season_id, level, track, kind, amount, item_id)
    select v_id, r.level, r.track, r.kind, r.amount, r.item_id from public.pass_rewards r
     where r.season_id = v_from and r.track = 'free' and r.level <= v_levels on conflict do nothing;
  end if;
  perform public.admin_log(auth.uid(), null, 'pass.seasonSaved', null, jsonb_build_object('seasonId', v_id, 'new', v_new));
  return (select x from jsonb_array_elements(public.admin_pass_seasons()) x where x ->> 'id' = v_id);
end $$;

-- Premios de una temporada (para editarlos) y cambio de uno: { level, kind: 'none' | 'points' | 'item', amount?, itemId? }.
create or replace function public.admin_pass_rewards(p_season text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.admin_guard();
  return coalesce((select jsonb_agg(jsonb_build_object('level', r.level, 'kind', r.kind, 'amount', r.amount, 'itemId', r.item_id) order by r.level)
    from public.pass_rewards r where r.season_id = p_season and r.track = 'free'), '[]'::jsonb);
end $$;
create or replace function public.admin_pass_reward_set(p_season text, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.pass_seasons;
  v_level integer := (p ->> 'level')::integer;
  v_kind text := p ->> 'kind';
  v_amount integer := (p ->> 'amount')::integer;
  v_item text := p ->> 'itemId';
begin
  perform public.admin_guard();
  select * into s from public.pass_seasons where id = p_season;
  if not found then raise exception 'no_season' using errcode = '22023'; end if;
  if v_level is null or v_level not between 1 and s.levels then raise exception 'bad_level' using errcode = '22023'; end if;
  if v_kind = 'none' then
    delete from public.pass_rewards where season_id = p_season and level = v_level and track = 'free';
  elsif v_kind = 'points' then
    if v_amount is null or v_amount not between 1 and 100000 then raise exception 'bad_amount' using errcode = '22023'; end if;
    insert into public.pass_rewards (season_id, level, track, kind, amount, item_id) values (p_season, v_level, 'free', 'points', v_amount, null)
    on conflict (season_id, level, track) do update set kind = 'points', amount = excluded.amount, item_id = null;
  elsif v_kind = 'item' then
    if v_item is null or not exists (select 1 from public.shop_items where id = v_item) then raise exception 'bad_item' using errcode = '22023'; end if;
    insert into public.pass_rewards (season_id, level, track, kind, amount, item_id) values (p_season, v_level, 'free', 'item', null, v_item)
    on conflict (season_id, level, track) do update set kind = 'item', amount = null, item_id = excluded.item_id;
  else
    raise exception 'bad_kind' using errcode = '22023';
  end if;
  perform public.admin_log(auth.uid(), null, 'pass.rewardSet', null, jsonb_build_object('seasonId', p_season, 'level', v_level, 'kind', v_kind));
  return public.admin_pass_rewards(p_season);
end $$;

-- Ya no se regalan ediciones: el pase solo se gana jugando.
drop function if exists public.admin_pass_grant(uuid, text);

-- ---------- 6) Permisos ----------
revoke all on function private.pass_xp(uuid, public.pass_seasons), private.pass_grant(uuid, public.pass_seasons, public.pass_rewards)
  from public, anon, authenticated;
revoke all on function public.pass_me(), public.pass_playtime(integer), public.pass_claim(integer, text), public.pass_claim_all(),
  public.admin_pass_seasons(), public.admin_pass_season_save(jsonb), public.admin_pass_rewards(text), public.admin_pass_reward_set(text, jsonb)
  from public, anon;
grant execute on function public.pass_me(), public.pass_playtime(integer), public.pass_claim(integer, text), public.pass_claim_all(),
  public.admin_pass_seasons(), public.admin_pass_season_save(jsonb), public.admin_pass_rewards(text), public.admin_pass_reward_set(text, jsonb)
  to authenticated, service_role;
