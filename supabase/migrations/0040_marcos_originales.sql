-- 0040_marcos_originales.sql · Venus 4.6 · Marcos de perfil originales (dibujados con código, sin arte de terceros)
-- Guía: docs/wip/marcos-46.md. Se aplica después de 0021 (shop_items, points_ledger), 0026 (source), 0027 (regalos) y 0039.
-- Idempotente. NO redefine profile_customize ni profile_public (ya validan equipar con `si.active`).
--
--   * Catálogo nuevo: 36 marcos de la tienda (kind 'frame', data.style = estilo que dibuja social/frames.js). Los 8 del Venus Pass
--     (pass_frame_1..8) los inserta 0041 con source 'pass'.
--   * Los marcos anteriores se DESACTIVAN (active = false; no se borran: pass_rewards y user_items tienen claves foráneas):
--     los 17 de la tienda y pass_s1_frame, pass_s1_frame_legend, pass_s1_free_frame y pass_max_frame.
--   * profiles.equipped: se saca el marco si ya no es un marco activo.
--   * Reintegro: a quien compró un marco anterior se le devuelve lo que pagó (una fila positiva en points_ledger, motivo 'shop',
--     ref 'refund:<item>'; la clave única (user_id, reason, ref) lo hace una sola vez). Los regalos de marcos no se reintegran.
--   * gift_send (0027) no regala lo que no es de la tienda (source <> 'shop'): los marcos del Pase se ganan jugando.

-- ---------- Un marco necesita decir su estilo ----------
alter table public.shop_items drop constraint if exists shop_items_frame_data;
alter table public.shop_items add constraint shop_items_frame_data
  check (kind <> 'frame' or coalesce((data ->> 'style') ~ '^[a-z0-9]{1,24}$', false));

-- ---------- Catálogo nuevo ----------
-- Los de solo Premium valen 0 y vienen con el plan (shop_buy los rechaza). sort 600 en adelante.
insert into public.shop_items (id, kind, price, premium_only, sort, data, source) values
  ('frame_nebula', 'frame', 500, false, 600, '{"style":"nebula"}', 'shop'),
  ('frame_comet', 'frame', 700, false, 610, '{"style":"comet"}', 'shop'),
  ('frame_rings', 'frame', 1100, false, 620, '{"style":"rings"}', 'shop'),
  ('frame_eclipse', 'frame', 1800, false, 630, '{"style":"eclipse"}', 'shop'),
  ('frame_constellation', 'frame', 0, true, 640, '{"style":"constellation"}', 'shop'),
  ('frame_leaves', 'frame', 400, false, 650, '{"style":"leaves"}', 'shop'),
  ('frame_vines', 'frame', 600, false, 660, '{"style":"vines"}', 'shop'),
  ('frame_blossom', 'frame', 1000, false, 670, '{"style":"blossom"}', 'shop'),
  ('frame_dandelion', 'frame', 1200, false, 680, '{"style":"dandelion"}', 'shop'),
  ('frame_firefly', 'frame', 1700, false, 690, '{"style":"firefly"}', 'shop'),
  ('frame_tide', 'frame', 600, false, 700, '{"style":"tide"}', 'shop'),
  ('frame_gale', 'frame', 800, false, 710, '{"style":"gale"}', 'shop'),
  ('frame_frost', 'frame', 1100, false, 720, '{"style":"frost"}', 'shop'),
  ('frame_flame', 'frame', 1600, false, 730, '{"style":"flame"}', 'shop'),
  ('frame_storm', 'frame', 1900, false, 740, '{"style":"storm"}', 'shop'),
  ('frame_ruby', 'frame', 1000, false, 750, '{"style":"ruby"}', 'shop'),
  ('frame_sapphire', 'frame', 1200, false, 760, '{"style":"sapphire"}', 'shop'),
  ('frame_prism', 'frame', 2000, false, 770, '{"style":"prism"}', 'shop'),
  ('frame_opal', 'frame', 0, true, 780, '{"style":"opal"}', 'shop'),
  ('frame_bits', 'frame', 400, false, 790, '{"style":"bits"}', 'shop'),
  ('frame_coins', 'frame', 700, false, 800, '{"style":"coins"}', 'shop'),
  ('frame_arcade', 'frame', 1000, false, 810, '{"style":"arcade"}', 'shop'),
  ('frame_glitch', 'frame', 1300, false, 820, '{"style":"glitch"}', 'shop'),
  ('frame_equalizer', 'frame', 700, false, 830, '{"style":"equalizer"}', 'shop'),
  ('frame_radar', 'frame', 900, false, 840, '{"style":"radar"}', 'shop'),
  ('frame_synth', 'frame', 1400, false, 850, '{"style":"synth"}', 'shop'),
  ('frame_circuit', 'frame', 1600, false, 860, '{"style":"circuit"}', 'shop'),
  ('frame_hologram', 'frame', 0, true, 870, '{"style":"hologram"}', 'shop'),
  ('frame_cupid', 'frame', 1000, false, 880, '{"style":"cupid"}', 'shop'),
  ('frame_spooky', 'frame', 1200, false, 890, '{"style":"spooky"}', 'shop'),
  ('frame_garland', 'frame', 1200, false, 900, '{"style":"garland"}', 'shop'),
  ('frame_fireworks', 'frame', 1500, false, 910, '{"style":"fireworks"}', 'shop'),
  ('frame_runes', 'frame', 1800, false, 920, '{"style":"runes"}', 'shop'),
  ('frame_dragon', 'frame', 2600, false, 930, '{"style":"dragon"}', 'shop'),
  ('frame_wings', 'frame', 0, true, 940, '{"style":"wings"}', 'shop'),
  ('frame_phoenix', 'frame', 3000, false, 950, '{"style":"phoenix"}', 'shop')
on conflict (id) do update set kind = excluded.kind, price = excluded.price, premium_only = excluded.premium_only,
  sort = excluded.sort, data = excluded.data, source = excluded.source;

-- ---------- Reintegro (antes de desactivar nada: se lee del libro de puntos) ----------
-- Lo que pagó cada cuenta por un marco anterior, tal cual está en el libro (shop_buy anota ref = id del ítem).
insert into public.points_ledger (user_id, delta, reason, ref)
select l.user_id, -l.delta, 'shop', 'refund:' || l.ref
  from public.points_ledger l
 where l.reason = 'shop' and l.delta < 0
   and l.ref in ('frame_pixel', 'frame_neon', 'frame_gold', 'frame_venus', 'frame_ice', 'frame_emerald', 'frame_amethyst', 'frame_redstone',
                 'frame_fire', 'frame_ender', 'frame_rainbow', 'frame_diamond', 'frame_cosmic', 'frame_pulse', 'frame_orbit', 'frame_halloween', 'frame_xmas')
on conflict (user_id, reason, ref) do nothing;

-- ---------- Los marcos anteriores se desactivan ----------
update public.shop_items set active = false
 where active and id in ('frame_pixel', 'frame_neon', 'frame_gold', 'frame_venus', 'frame_ice', 'frame_emerald', 'frame_amethyst', 'frame_redstone',
                         'frame_fire', 'frame_ender', 'frame_rainbow', 'frame_diamond', 'frame_cosmic', 'frame_pulse', 'frame_orbit', 'frame_halloween', 'frame_xmas',
                         'pass_s1_frame', 'pass_s1_frame_legend', 'pass_s1_free_frame', 'pass_max_frame');

-- ---------- Perfiles: sin marcos que ya no existen ----------
update public.profiles p set equipped = p.equipped - 'frame'
 where p.equipped ? 'frame'
   and not exists (select 1 from public.shop_items si where si.id = p.equipped ->> 'frame' and si.kind = 'frame' and si.active);

-- ---------- Regalos: solo lo de la tienda (0027 + la guarda de source) ----------
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
    -- Lo que viene del Venus Pass (source 'pass') se gana jugando: no se regala
    select * into it from public.shop_items si where si.id = p_value and si.active and si.source = 'shop';
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
revoke all on function public.gift_send(uuid, text, text) from public, anon;
grant execute on function public.gift_send(uuid, text, text) to authenticated;
