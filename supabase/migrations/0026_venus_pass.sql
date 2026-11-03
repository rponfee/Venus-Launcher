-- Venus Launcher 3.1: Venus Pass (pase de temporada). Guía: docs/venus-pass.md.
-- Se compra con Mercado Pago o PayPal como los planes de IA (misma tabla payment_orders, producto 'pass'). Tres
-- ediciones por temporada (go, pro, max): todas abren la pista premium; pro y max suman niveles al instante y max,
-- además, XP extra. Pasar a una edición mejor cuesta la diferencia. Nada del progreso se calcula en la PC: la XP sale
-- de los Venus Points ganados en la temporada (premio diario, misiones, logros e invitaciones: 1 punto = 1 XP) y del
-- tiempo jugado que reporta el launcher (1 XP por minuto, hasta 120 por día). Premium multiplica por 1,2.
-- Depende de 0025 (payments_mark_paid y payments_mark_status se vuelven a definir acá, con el producto nuevo).

-- ---------- 1) Tablas ----------
create table if not exists public.pass_seasons (
  id text primary key check (id ~ '^[a-z0-9_-]{2,40}$'),
  name text not null check (char_length(name) between 1 and 60),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  active boolean not null default false,
  levels integer not null default 50 check (levels between 10 and 200),
  xp_per_level integer not null default 150 check (xp_per_level between 10 and 100000),
  created_at timestamptz not null default now(),
  constraint pass_seasons_dates check (ends_at > starts_at)
);
create table if not exists public.pass_tiers (
  season_id text not null references public.pass_seasons (id) on delete cascade,
  tier text not null check (tier in ('go', 'pro', 'max')),
  price_usd numeric(8,2) not null check (price_usd > 0),
  bonus_levels integer not null default 0 check (bonus_levels between 0 and 100),
  xp_mult numeric(4,2) not null default 1 check (xp_mult between 1 and 3),
  perk_items text[] not null default '{}',
  primary key (season_id, tier)
);
create table if not exists public.pass_rewards (
  season_id text not null references public.pass_seasons (id) on delete cascade,
  level integer not null check (level between 1 and 200),
  track text not null check (track in ('free', 'premium')),
  kind text not null check (kind in ('points', 'item')),
  amount integer check (amount between 1 and 100000),
  item_id text references public.shop_items (id) on update cascade,
  primary key (season_id, level, track),
  constraint pass_rewards_value check ((kind = 'points' and amount is not null) or (kind = 'item' and item_id is not null))
);
create table if not exists public.pass_purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  season_id text not null references public.pass_seasons (id) on delete cascade,
  tier text not null check (tier in ('go', 'pro', 'max')),
  order_id uuid references public.payment_orders (id),
  granted_by uuid,
  created_at timestamptz not null default now(),
  upgraded_at timestamptz,
  revoked_at timestamptz,
  unique (user_id, season_id)
);
create table if not exists public.pass_playtime (
  user_id uuid not null references auth.users (id) on delete cascade,
  season_id text not null references public.pass_seasons (id) on delete cascade,
  day date not null,
  minutes integer not null default 0 check (minutes between 0 and 1440),
  primary key (user_id, season_id, day)
);
create table if not exists public.pass_claims (
  user_id uuid not null references auth.users (id) on delete cascade,
  season_id text not null references public.pass_seasons (id) on delete cascade,
  level integer not null,
  track text not null check (track in ('free', 'premium')),
  claimed_at timestamptz not null default now(),
  primary key (user_id, season_id, level, track)
);
do $$
declare t text;
begin
  foreach t in array array['pass_seasons', 'pass_tiers', 'pass_rewards', 'pass_purchases', 'pass_playtime', 'pass_claims'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

-- Cosméticos que no se venden: vienen del pase (o los da un admin). shop_buy los rechaza y la tienda no los lista.
alter table public.shop_items add column if not exists source text not null default 'shop' check (source in ('shop', 'pass', 'grant'));

-- Puntos que da el pase (y los que quita una devolución)
alter table public.points_ledger drop constraint if exists points_ledger_reason_check;
alter table public.points_ledger add constraint points_ledger_reason_check
  check (reason in ('daily', 'achievement', 'referral', 'referred', 'shop', 'admin', 'mission', 'pass', 'pass_refund', 'gift_in', 'gift_out'));

-- Órdenes de pago: producto 'ai_plan' (como siempre) o 'pass'. plan_id deja de ser clave foránea a ai_plans: un disparador
-- lo valida según el producto ('pass_go', 'pass_pro' o 'pass_max' para el pase).
alter table public.payment_orders add column if not exists product text not null default 'ai_plan' check (product in ('ai_plan', 'pass'));
alter table public.payment_orders add column if not exists season_id text references public.pass_seasons (id);
alter table public.payment_orders add column if not exists pass_tier text check (pass_tier in ('go', 'pro', 'max'));
do $$
declare c text;
begin
  for c in select conname from pg_constraint where conrelid = 'public.payment_orders'::regclass and contype = 'f'
             and conkey = array[(select attnum from pg_attribute where attrelid = 'public.payment_orders'::regclass and attname = 'plan_id')] loop
    execute format('alter table public.payment_orders drop constraint %I', c);
  end loop;
end $$;
create or replace function private.payment_orders_check() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.product = 'pass' then
    if new.season_id is null or new.pass_tier is null or new.plan_id <> 'pass_' || new.pass_tier then
      raise exception 'bad_pass_order' using errcode = '22023';
    end if;
  elsif not exists (select 1 from public.ai_plans p where p.id = new.plan_id) then
    raise exception 'bad_plan' using errcode = '22023';
  end if;
  return new;
end $$;
drop trigger if exists payment_orders_check on public.payment_orders;
create trigger payment_orders_check before insert or update of plan_id, product, season_id, pass_tier on public.payment_orders
  for each row execute function private.payment_orders_check();

-- ---------- 2) Temporada 1 ----------
insert into public.shop_items (id, kind, price, premium_only, sort, data, source) values
  ('pass_s1_frame', 'frame', 0, false, 300, '{"style":"season1"}', 'pass'),
  ('pass_s1_effect', 'name_effect', 0, false, 301, '{"effect":"season1"}', 'pass'),
  ('pass_s1_title', 'title', 0, false, 302, '{"title":"season1"}', 'pass'),
  ('pass_s1_frame_legend', 'frame', 0, false, 303, '{"style":"season1legend"}', 'pass'),
  ('pass_s1_free_title', 'title', 0, false, 304, '{"title":"traveler"}', 'pass'),
  ('pass_s1_free_frame', 'frame', 0, false, 305, '{"style":"season1free"}', 'pass'),
  ('pass_pro_title', 'title', 0, false, 306, '{"title":"pro"}', 'pass'),
  ('pass_max_frame', 'frame', 0, false, 307, '{"style":"max"}', 'pass')
on conflict (id) do update set kind = excluded.kind, price = excluded.price, premium_only = excluded.premium_only,
  sort = excluded.sort, data = excluded.data, source = excluded.source;

insert into public.pass_seasons (id, name, starts_at, ends_at, active, levels, xp_per_level)
values ('temporada-1', 'Amanecer en Venus', '2026-11-10 00:00:00+00', '2027-01-05 00:00:00+00', true, 50, 150)
on conflict (id) do nothing;
insert into public.pass_tiers (season_id, tier, price_usd, bonus_levels, xp_mult, perk_items) values
  ('temporada-1', 'go', 1.99, 0, 1, '{}'),
  ('temporada-1', 'pro', 4.99, 10, 1, '{pass_pro_title}'),
  ('temporada-1', 'max', 6.99, 25, 1.25, '{pass_pro_title,pass_max_frame}')
on conflict (season_id, tier) do update set price_usd = excluded.price_usd, bonus_levels = excluded.bonus_levels,
  xp_mult = excluded.xp_mult, perk_items = excluded.perk_items;
-- Premios: la pista gratis da puntos en los niveles impares (más en los múltiplos de 10) y dos cosméticos; la premium
-- da puntos en todos los niveles y cuatro cosméticos exclusivos.
do $$
declare lv integer;
begin
  for lv in 1..50 loop
    if lv = 20 then
      insert into public.pass_rewards values ('temporada-1', lv, 'free', 'item', null, 'pass_s1_free_title') on conflict do nothing;
    elsif lv = 40 then
      insert into public.pass_rewards values ('temporada-1', lv, 'free', 'item', null, 'pass_s1_free_frame') on conflict do nothing;
    elsif lv % 10 = 0 then
      insert into public.pass_rewards values ('temporada-1', lv, 'free', 'points', 50, null) on conflict do nothing;
    elsif lv % 2 = 1 then
      insert into public.pass_rewards values ('temporada-1', lv, 'free', 'points', 20, null) on conflict do nothing;
    end if;
    if lv = 1 then
      insert into public.pass_rewards values ('temporada-1', lv, 'premium', 'item', null, 'pass_s1_frame') on conflict do nothing;
    elsif lv = 15 then
      insert into public.pass_rewards values ('temporada-1', lv, 'premium', 'item', null, 'pass_s1_effect') on conflict do nothing;
    elsif lv = 30 then
      insert into public.pass_rewards values ('temporada-1', lv, 'premium', 'item', null, 'pass_s1_title') on conflict do nothing;
    elsif lv = 50 then
      insert into public.pass_rewards values ('temporada-1', lv, 'premium', 'item', null, 'pass_s1_frame_legend') on conflict do nothing;
    elsif lv % 10 = 0 then
      insert into public.pass_rewards values ('temporada-1', lv, 'premium', 'points', 150, null) on conflict do nothing;
    else
      insert into public.pass_rewards values ('temporada-1', lv, 'premium', 'points', 50, null) on conflict do nothing;
    end if;
  end loop;
end $$;

-- ---------- 3) Lectura de la temporada y del progreso ----------
create or replace function private.pass_current() returns public.pass_seasons
language sql stable security definer set search_path = '' as $$
  select s from public.pass_seasons s where s.active order by s.starts_at desc limit 1
$$;

create or replace function private.pass_tier_rank(p_tier text) returns integer
language sql immutable set search_path = '' as $$
  select case p_tier when 'go' then 1 when 'pro' then 2 when 'max' then 3 else 0 end
$$;

-- Compra vigente (sin devolver) de un usuario en una temporada.
create or replace function private.pass_purchase(p_user uuid, p_season text) returns public.pass_purchases
language sql stable security definer set search_path = '' as $$
  select p from public.pass_purchases p where p.user_id = p_user and p.season_id = p_season and p.revoked_at is null
$$;

-- XP de la temporada: puntos ganados en ella (sin regalos ni ajustes de admin) + minutos jugados, por los multiplicadores.
-- Devuelve { xp, fromPoints, fromPlay, bonusLevels, premiumMult, tierMult, total (xp + niveles bonus en XP) }.
create or replace function private.pass_xp(p_user uuid, p_season public.pass_seasons) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_points bigint;
  v_play bigint;
  v_premium numeric := case when public.venus_is_premium(p_user) then 1.2 else 1 end;
  v_tier numeric := 1;
  v_bonus integer := 0;
  v_purchase public.pass_purchases;
  v_xp bigint;
begin
  select coalesce(sum(l.delta), 0) into v_points from public.points_ledger l
   where l.user_id = p_user and l.delta > 0 and l.reason in ('daily', 'achievement', 'referral', 'referred', 'mission')
     and l.created_at >= p_season.starts_at and l.created_at < p_season.ends_at;
  select coalesce(sum(pt.minutes), 0) into v_play from public.pass_playtime pt where pt.user_id = p_user and pt.season_id = p_season.id;
  v_purchase := private.pass_purchase(p_user, p_season.id);
  if v_purchase.id is not null then
    select t.xp_mult, t.bonus_levels into v_tier, v_bonus from public.pass_tiers t where t.season_id = p_season.id and t.tier = v_purchase.tier;
  end if;
  v_xp := floor((v_points + v_play) * v_premium * coalesce(v_tier, 1));
  return jsonb_build_object('xp', v_xp, 'fromPoints', v_points, 'fromPlay', v_play, 'bonusLevels', coalesce(v_bonus, 0),
    'premiumMult', v_premium, 'tierMult', coalesce(v_tier, 1), 'total', v_xp + coalesce(v_bonus, 0) * p_season.xp_per_level);
end $$;

create or replace function private.pass_level(p_season public.pass_seasons, p_total bigint) returns integer
language sql immutable set search_path = '' as $$
  select least(p_season.levels, (p_total / p_season.xp_per_level)::integer)
$$;

-- Lo que ve la página del pase. Sin temporada activa: { season: null }.
create or replace function public.pass_me() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  s public.pass_seasons;
  x jsonb;
  v_level integer;
  v_purchase public.pass_purchases;
  v_owned_rank integer := 0;
  v_owned_price numeric := 0;
  today date := (now() at time zone 'utc')::date;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  s := private.pass_current();
  if s.id is null then return jsonb_build_object('season', null); end if;
  x := private.pass_xp(me, s);
  v_level := private.pass_level(s, (x ->> 'total')::bigint);
  v_purchase := private.pass_purchase(me, s.id);
  if v_purchase.id is not null then
    v_owned_rank := private.pass_tier_rank(v_purchase.tier);
    select t.price_usd into v_owned_price from public.pass_tiers t where t.season_id = s.id and t.tier = v_purchase.tier;
  end if;
  return jsonb_build_object(
    'season', jsonb_build_object('id', s.id, 'name', s.name, 'startsAt', public.ai_iso(s.starts_at), 'endsAt', public.ai_iso(s.ends_at),
      'levels', s.levels, 'xpPerLevel', s.xp_per_level, 'started', now() >= s.starts_at, 'ended', now() >= s.ends_at),
    'purchase', case when v_purchase.id is null then null else jsonb_build_object('tier', v_purchase.tier, 'at', public.ai_iso(v_purchase.created_at)) end,
    'xp', x, 'level', v_level,
    'levelXp', case when v_level >= s.levels then s.xp_per_level else ((x ->> 'total')::bigint % s.xp_per_level) end,
    'playToday', coalesce((select pt.minutes from public.pass_playtime pt where pt.user_id = me and pt.season_id = s.id and pt.day = today), 0),
    'playCap', 120,
    'claimable', (select count(*) from public.pass_rewards r
                   where r.season_id = s.id and r.level <= v_level and (r.track = 'free' or v_purchase.id is not null)
                     and not exists (select 1 from public.pass_claims c where c.user_id = me and c.season_id = s.id and c.level = r.level and c.track = r.track)),
    'rewards', coalesce((select jsonb_agg(jsonb_build_object('level', r.level, 'track', r.track, 'kind', r.kind, 'amount', r.amount, 'itemId', r.item_id,
                           'claimed', exists (select 1 from public.pass_claims c where c.user_id = me and c.season_id = s.id and c.level = r.level and c.track = r.track))
                           order by r.level, r.track)
                         from public.pass_rewards r where r.season_id = s.id), '[]'::jsonb),
    'tiers', coalesce((select jsonb_agg(jsonb_build_object('tier', t.tier, 'priceUsd', t.price_usd, 'bonusLevels', t.bonus_levels, 'xpMult', t.xp_mult,
                           'perkItems', to_jsonb(t.perk_items), 'owned', private.pass_tier_rank(t.tier) <= v_owned_rank,
                           'upgradePriceUsd', case when private.pass_tier_rank(t.tier) > v_owned_rank then round(t.price_usd - v_owned_price, 2) end)
                           order by private.pass_tier_rank(t.tier))
                       from public.pass_tiers t where t.season_id = s.id), '[]'::jsonb));
end $$;

-- Minutos jugados que reporta el launcher (de a 1 a 30 por llamada, hasta 120 por día). Devuelve { today, added }.
create or replace function public.pass_playtime(p_minutes integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  s public.pass_seasons;
  today date := (now() at time zone 'utc')::date;
  v_before integer;
  v_after integer;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if p_minutes is null or p_minutes < 1 or p_minutes > 30 then raise exception 'bad_minutes' using errcode = '22023'; end if;
  s := private.pass_current();
  if s.id is null or now() < s.starts_at or now() >= s.ends_at then return jsonb_build_object('today', 0, 'added', 0); end if;
  insert into public.pass_playtime (user_id, season_id, day, minutes) values (me, s.id, today, 0) on conflict do nothing;
  select pt.minutes into v_before from public.pass_playtime pt where pt.user_id = me and pt.season_id = s.id and pt.day = today for update;
  v_after := least(120, v_before + p_minutes);
  update public.pass_playtime set minutes = v_after where user_id = me and season_id = s.id and day = today;
  return jsonb_build_object('today', v_after, 'added', v_after - v_before);
end $$;

-- Reclama el premio de un nivel. Errores (22023): no_season, bad_reward, locked (nivel no alcanzado), no_pass, already.
create or replace function public.pass_claim(p_level integer, p_track text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  s public.pass_seasons;
  r public.pass_rewards;
  v_level integer;
  v_purchase public.pass_purchases;
  v_points integer := 0;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if public.moderation_social_block(me) = 'user_banned' then raise exception 'user_banned' using errcode = '42501'; end if;
  s := private.pass_current();
  if s.id is null then raise exception 'no_season' using errcode = '22023'; end if;
  select * into r from public.pass_rewards where season_id = s.id and level = p_level and track = p_track;
  if not found then raise exception 'bad_reward' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext('points:' || me::text));
  v_purchase := private.pass_purchase(me, s.id);
  if r.track = 'premium' and v_purchase.id is null then raise exception 'no_pass' using errcode = '22023'; end if;
  v_level := private.pass_level(s, (private.pass_xp(me, s) ->> 'total')::bigint);
  if r.level > v_level then raise exception 'locked' using errcode = '22023'; end if;
  if exists (select 1 from public.pass_claims c where c.user_id = me and c.season_id = s.id and c.level = r.level and c.track = r.track) then
    raise exception 'already' using errcode = '22023';
  end if;
  insert into public.pass_claims (user_id, season_id, level, track) values (me, s.id, r.level, r.track);
  if r.kind = 'points' then
    v_points := private.points_award(me, r.amount, 'pass', s.id || ':' || r.level || ':' || r.track);
  else
    insert into public.user_items (user_id, item_id) values (me, r.item_id) on conflict do nothing;
  end if;
  return jsonb_build_object('level', r.level, 'track', r.track, 'kind', r.kind, 'points', v_points, 'itemId', r.item_id, 'balance', private.points_balance(me));
end $$;

-- Reclama todo lo que esté disponible. Devuelve { claimed: [...], points, balance }.
create or replace function public.pass_claim_all() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  s public.pass_seasons;
  r record;
  v_level integer;
  v_purchase public.pass_purchases;
  v_out jsonb := '[]'::jsonb;
  v_points integer := 0;
  v_one jsonb;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  s := private.pass_current();
  if s.id is null then raise exception 'no_season' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext('points:' || me::text));
  v_level := private.pass_level(s, (private.pass_xp(me, s) ->> 'total')::bigint);
  v_purchase := private.pass_purchase(me, s.id);
  for r in select x.* from public.pass_rewards x
            where x.season_id = s.id and x.level <= v_level and (x.track = 'free' or v_purchase.id is not null)
              and not exists (select 1 from public.pass_claims c where c.user_id = me and c.season_id = s.id and c.level = x.level and c.track = x.track)
            order by x.level, x.track loop
    v_one := public.pass_claim(r.level, r.track);
    v_points := v_points + coalesce((v_one ->> 'points')::integer, 0);
    v_out := v_out || jsonb_build_array(v_one - 'balance');
  end loop;
  return jsonb_build_object('claimed', v_out, 'points', v_points, 'balance', private.points_balance(me));
end $$;

-- ---------- 4) Compra: precio, orden, acreditación y devolución ----------
-- Lo que cuesta un monto en dólares con un proveedor, con los impuestos de payment_settings (antes vivía en payments_quote).
create or replace function private.payments_price(p_usd numeric, p_provider text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.payment_settings%rowtype; v_cur text; v_sub numeric; v_total numeric;
 v_taxes jsonb := '[]'::jsonb; t jsonb; v_rate numeric; v_amt numeric; v_included numeric := 0; v_estimate numeric := 0;
begin
 select * into s from public.payment_settings where id;
 if p_usd is null or p_usd <= 0 then return null; end if;
 if p_provider = 'mercado_pago' then
   if s.ars_per_usd is null then return null; end if;
   v_cur := 'ARS';
   v_sub := ceil(p_usd * s.ars_per_usd / s.ars_rounding) * s.ars_rounding;
 elsif p_provider = 'paypal' then
   v_cur := 'USD';
   v_sub := p_usd;
 else
   return null;
 end if;
 v_total := v_sub;
 for t in select e from jsonb_array_elements(coalesce(s.taxes -> v_cur, '[]'::jsonb)) e loop
   v_rate := (t ->> 'rate')::numeric;
   if t ->> 'mode' = 'added' then
     v_amt := round(v_sub * v_rate / 100, 2);
     v_total := v_total + v_amt;
   elsif t ->> 'mode' = 'estimate' then
     v_amt := round(v_sub * v_rate / 100, 2);
     v_estimate := v_estimate + v_amt;
   else
     v_amt := round(v_sub - v_sub / (1 + v_rate / 100), 2);
     v_included := v_included + v_amt;
   end if;
   v_taxes := v_taxes || jsonb_build_array(jsonb_build_object('id', t ->> 'id', 'label', t ->> 'label', 'rate', v_rate, 'mode', t ->> 'mode', 'amount', v_amt));
 end loop;
 return jsonb_build_object('provider', p_provider, 'currency', v_cur, 'subtotal', v_sub, 'taxes', v_taxes, 'total', round(v_total, 2),
   'net', round(v_sub - v_included, 2), 'estimatedTotal', case when v_estimate > 0 then round(v_total + v_estimate, 2) end,
   'priceUsd', p_usd, 'arsPerUsd', case when v_cur = 'ARS' then s.ars_per_usd end);
end $$;

-- Precio de un plan de IA (como en 0017, ahora sobre payments_price).
create or replace function private.payments_quote(p_plan text, p_provider text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare p public.ai_plans%rowtype; q jsonb;
begin
 select * into p from public.ai_plans where id = p_plan and active and id in ('basic', 'go', 'pro', 'max');
 if not found or p.price_usd is null or p.price_usd <= 0 then return null; end if;
 q := private.payments_price(p.price_usd, p_provider);
 if q is null then return null; end if;
 return q || jsonb_build_object('product', 'ai_plan', 'budgetUsd', p.monthly_budget_usd, 'plan', p.id, 'planName', p.name);
end $$;

-- Precio de una edición del pase para un usuario: la diferencia si ya tiene una edición menor; null si no se puede comprar.
create or replace function private.pass_quote(p_tier text, p_provider text, p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.pass_seasons; t public.pass_tiers%rowtype; v_purchase public.pass_purchases; v_owned numeric := 0; q jsonb; v_price numeric;
begin
 s := private.pass_current();
 if s.id is null or now() >= s.ends_at then return null; end if;
 select * into t from public.pass_tiers where season_id = s.id and tier = p_tier;
 if not found then return null; end if;
 if p_user is not null then
   v_purchase := private.pass_purchase(p_user, s.id);
   if v_purchase.id is not null then
     if private.pass_tier_rank(v_purchase.tier) >= private.pass_tier_rank(p_tier) then return null; end if;
     select x.price_usd into v_owned from public.pass_tiers x where x.season_id = s.id and x.tier = v_purchase.tier;
   end if;
 end if;
 v_price := round(t.price_usd - coalesce(v_owned, 0), 2);
 q := private.payments_price(v_price, p_provider);
 if q is null then return null; end if;
 return q || jsonb_build_object('product', 'pass', 'budgetUsd', 0, 'plan', 'pass_' || p_tier, 'planName', 'Venus Pass ' || initcap(p_tier),
   'seasonId', s.id, 'seasonName', s.name, 'tier', p_tier, 'upgradeFrom', v_purchase.tier, 'fullPriceUsd', t.price_usd);
end $$;

create or replace function private.payments_order_json(o public.payment_orders) returns jsonb
language sql stable set search_path = '' as $$
 select jsonb_build_object('id', o.id, 'userId', o.user_id, 'plan', o.plan_id, 'planName', o.plan_name, 'provider', o.provider,
   'product', o.product, 'seasonId', o.season_id, 'passTier', o.pass_tier,
   'currency', o.currency, 'amount', o.amount, 'priceUsd', o.price_usd, 'budgetUsd', o.budget_usd, 'quote', o.quote, 'live', o.live,
   'status', case when o.status = 'pending' and o.expires_at <= now() then 'expired' else o.status end,
   'providerStatus', o.provider_status, 'providerOrderId', o.provider_order_id, 'checkoutUrl', o.checkout_url,
   'carriedUsd', o.carried_usd, 'createdAt', public.ai_iso(o.created_at), 'updatedAt', public.ai_iso(o.updated_at),
   'paidAt', public.ai_iso(o.paid_at), 'expiresAt', public.ai_iso(o.expires_at))
$$;

-- Catálogo público: planes de IA (como en 0017) y el pase de la temporada activa (precios completos; la diferencia por
-- una edición mejor la informa pass_me).
create or replace function public.payments_catalog() returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object(
   'providers', jsonb_build_object(
     'mercado_pago', jsonb_build_object('enabled', private.payments_provider_ready('mercado_pago'), 'currency', 'ARS'),
     'paypal', jsonb_build_object('enabled', private.payments_provider_ready('paypal'), 'currency', 'USD')),
   'arsPerUsd', s.ars_per_usd, 'rateUpdatedAt', public.ai_iso(s.rate_updated_at),
   'plans', coalesce((select jsonb_agg(c.plan || jsonb_build_object('prices', jsonb_strip_nulls(jsonb_build_object(
       'mercado_pago', private.payments_quote(c.plan ->> 'id', 'mercado_pago'),
       'paypal', private.payments_quote(c.plan ->> 'id', 'paypal')))) order by c.ord)
     from jsonb_array_elements(public.ai_catalog()) with ordinality c(plan, ord)), '[]'::jsonb),
   'pass', (select case when cs.id is null then null else jsonb_build_object(
       'season', jsonb_build_object('id', cs.id, 'name', cs.name, 'startsAt', public.ai_iso(cs.starts_at), 'endsAt', public.ai_iso(cs.ends_at), 'levels', cs.levels, 'xpPerLevel', cs.xp_per_level),
       'tiers', coalesce((select jsonb_agg(jsonb_build_object('id', 'pass_' || t.tier, 'tier', t.tier, 'priceUsd', t.price_usd, 'bonusLevels', t.bonus_levels, 'xpMult', t.xp_mult,
           'prices', jsonb_strip_nulls(jsonb_build_object('mercado_pago', private.pass_quote(t.tier, 'mercado_pago', null), 'paypal', private.pass_quote(t.tier, 'paypal', null))))
           order by private.pass_tier_rank(t.tier)) from public.pass_tiers t where t.season_id = cs.id), '[]'::jsonb)) end
     from (select * from private.pass_current()) cs))
 from public.payment_settings s where s.id
$$;

create or replace function public.payments_create_order(p_user uuid, p_plan text, p_provider text, p_live boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_quote jsonb; v_order public.payment_orders%rowtype; v_pass boolean := p_plan like 'pass\_%';
begin
 if p_user is null or not exists (select 1 from auth.users u where u.id = p_user and u.deleted_at is null
     and not coalesce(u.is_anonymous, false) and (u.banned_until is null or u.banned_until <= now())) then
   raise exception 'Iniciá sesión con tu cuenta de Venus.' using errcode = '42501';
 end if;
 if not private.payments_provider_ready(p_provider) then
   raise exception 'provider_disabled' using errcode = '22023';
 end if;
 v_quote := case when v_pass then private.pass_quote(substr(p_plan, 6), p_provider, p_user) else private.payments_quote(p_plan, p_provider) end;
 if v_quote is null then raise exception 'unknown_plan' using errcode = '22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user::text, 817));
 -- Doble clic o reintento: la misma orden pendiente, si el precio no cambió.
 select * into v_order from public.payment_orders o
  where o.user_id = p_user and o.plan_id = p_plan and o.provider = p_provider and o.status = 'pending'
    and o.live = coalesce(p_live, false) and o.amount = (v_quote ->> 'total')::numeric and o.checkout_url is not null
    and o.created_at > now() - interval '30 minutes' and o.expires_at > now()
  order by o.created_at desc limit 1;
 if found then return private.payments_order_json(v_order) || jsonb_build_object('reused', true); end if;
 if (select count(*) from public.payment_orders o where o.user_id = p_user and o.created_at > now() - interval '1 hour') >= 8
   or (select count(*) from public.payment_orders o where o.user_id = p_user and o.created_at > now() - interval '1 day') >= 25 then
   raise exception 'too_many_orders' using errcode = '54000';
 end if;
 insert into public.payment_orders (user_id, plan_id, plan_name, provider, currency, amount, price_usd, budget_usd, quote, live, product, season_id, pass_tier)
 values (p_user, p_plan, v_quote ->> 'planName', p_provider, v_quote ->> 'currency', (v_quote ->> 'total')::numeric,
   (v_quote ->> 'priceUsd')::numeric, (v_quote ->> 'budgetUsd')::numeric, v_quote, coalesce(p_live, false),
   case when v_pass then 'pass' else 'ai_plan' end, v_quote ->> 'seasonId', v_quote ->> 'tier')
 returning * into v_order;
 return private.payments_order_json(v_order) || jsonb_build_object('reused', false);
end $$;

-- El pase queda activo (o pasa a la edición mejor) y se entregan los cosméticos de la edición.
create or replace function private.pass_fulfill(o public.payment_orders) returns void
language plpgsql security definer set search_path = '' as $$
declare v_existing public.pass_purchases; v_item text; t public.pass_tiers%rowtype;
begin
 select * into v_existing from public.pass_purchases where user_id = o.user_id and season_id = o.season_id;
 if v_existing.id is null then
   insert into public.pass_purchases (user_id, season_id, tier, order_id) values (o.user_id, o.season_id, o.pass_tier, o.id);
 else
   update public.pass_purchases set tier = case when v_existing.revoked_at is not null or private.pass_tier_rank(o.pass_tier) > private.pass_tier_rank(v_existing.tier)
       then o.pass_tier else v_existing.tier end,
     order_id = o.id, revoked_at = null, upgraded_at = case when v_existing.revoked_at is null then now() else upgraded_at end
    where id = v_existing.id;
 end if;
 select * into t from public.pass_tiers where season_id = o.season_id and tier = o.pass_tier;
 foreach v_item in array coalesce(t.perk_items, '{}') loop
   insert into public.user_items (user_id, item_id) values (o.user_id, v_item) on conflict do nothing;
 end loop;
end $$;

-- Devolución. De una compra: se quita el pase, los cosméticos de la edición y lo reclamado en la pista premium (puntos
-- incluidos). De un pase a una edición mejor: se vuelve a la edición anterior y se quita solo lo que dio la mejor (sus
-- cosméticos y los premios premium de los niveles que ya no se alcanzan).
create or replace function private.pass_revoke(o public.payment_orders) returns void
language plpgsql security definer set search_path = '' as $$
declare v_points integer; t public.pass_tiers%rowtype; v_prev text := o.quote ->> 'upgradeFrom'; v_from_level integer := 0;
 v_keep text[] := '{}'; s public.pass_seasons;
begin
 select * into t from public.pass_tiers where season_id = o.season_id and tier = o.pass_tier;
 if v_prev is not null and exists (select 1 from public.pass_tiers where season_id = o.season_id and tier = v_prev) then
   update public.pass_purchases set tier = v_prev, upgraded_at = null where user_id = o.user_id and season_id = o.season_id and revoked_at is null;
   select * into s from public.pass_seasons where id = o.season_id;
   v_from_level := private.pass_level(s, (private.pass_xp(o.user_id, s) ->> 'total')::bigint);
   select coalesce(x.perk_items, '{}') into v_keep from public.pass_tiers x where x.season_id = o.season_id and x.tier = v_prev;
 else
   update public.pass_purchases set revoked_at = now() where user_id = o.user_id and season_id = o.season_id and revoked_at is null;
   v_from_level := -1;
 end if;
 delete from public.user_items ui where ui.user_id = o.user_id
   and ((ui.item_id = any (coalesce(t.perk_items, '{}')) and not ui.item_id = any (v_keep))
     or ui.item_id in (select r.item_id from public.pass_rewards r join public.pass_claims c on c.season_id = r.season_id and c.level = r.level and c.track = r.track
                        where c.user_id = o.user_id and r.season_id = o.season_id and r.track = 'premium' and r.kind = 'item' and r.level > v_from_level));
 select coalesce(sum(r.amount), 0) into v_points from public.pass_rewards r join public.pass_claims c on c.season_id = r.season_id and c.level = r.level and c.track = r.track
  where c.user_id = o.user_id and r.season_id = o.season_id and r.track = 'premium' and r.kind = 'points' and r.level > v_from_level;
 if v_points > 0 then perform private.points_award(o.user_id, -least(v_points, greatest(private.points_balance(o.user_id), 0)), 'pass_refund', o.season_id || ':' || o.id); end if;
 delete from public.pass_claims where user_id = o.user_id and season_id = o.season_id and track = 'premium' and level > v_from_level;
 -- Lo equipado que ya no se tiene se destraba solo: profile_customize lo valida al guardar y la interfaz lo ignora.
end $$;

-- Acreditar un pago confirmado (0025, más el producto 'pass').
create or replace function public.payments_mark_paid(p_order uuid, p_payment_id text, p_amount numeric, p_currency text,
  p_live boolean, p_provider_status text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_order public.payment_orders%rowtype; v_plan public.ai_plans%rowtype; v_prev public.ai_paid_periods%rowtype;
 v_carry numeric := 0; v_period uuid; v_reserved numeric;
begin
 if p_payment_id is null or char_length(p_payment_id) not between 1 and 200 then
   raise exception 'bad_payment' using errcode = '22023';
 end if;
 select * into v_order from public.payment_orders where id = p_order for update;
 if not found then return jsonb_build_object('applied', false, 'reason', 'order_not_found'); end if;
 if v_order.status = 'paid' then
   return jsonb_build_object('applied', false, 'reason', 'already_paid', 'order', private.payments_order_json(v_order));
 end if;
 if v_order.status = 'refunded' then
   return jsonb_build_object('applied', false, 'reason', 'refunded', 'order', private.payments_order_json(v_order));
 end if;
 if not coalesce(p_live, false) and not public.admin_is_admin_user(v_order.user_id) then
   if v_order.provider_status is distinct from 'test_payment' then
     perform public.admin_log(null, null, 'payments.testRejected', v_order.user_id, jsonb_build_object('orderId', v_order.id,
       'provider', v_order.provider, 'paymentId', p_payment_id));
   end if;
   update public.payment_orders set status = 'failed', provider_status = 'test_payment', live = false, checked_at = now(), updated_at = now() where id = p_order;
   return jsonb_build_object('applied', false, 'reason', 'test_payment');
 end if;
 if upper(coalesce(p_currency, '')) <> v_order.currency or p_amount is null or p_amount < v_order.amount - 0.01 then
   update public.payment_orders set provider_status = 'amount_mismatch', checked_at = now(), updated_at = now() where id = p_order;
   perform public.admin_log(null, null, 'payments.amountMismatch', v_order.user_id, jsonb_build_object('orderId', v_order.id,
     'expected', v_order.amount, 'currency', v_order.currency, 'received', p_amount, 'receivedCurrency', p_currency, 'paymentId', p_payment_id));
   return jsonb_build_object('applied', false, 'reason', 'amount_mismatch');
 end if;
 perform pg_advisory_xact_lock(hashtextextended(v_order.user_id::text, 816));
 if v_order.product = 'pass' then
   perform private.pass_fulfill(v_order);
 else
   select * into v_plan from public.ai_plans where id = v_order.plan_id;
   -- Saldo que quedaba del período vigente (menos lo reservado por preguntas en curso).
   select pp.* into v_prev from public.ai_subscriptions s join public.ai_paid_periods pp on pp.id = s.support_period_id
    where s.user_id = v_order.user_id and s.source = 'support' and (pp.ends_at is null or pp.ends_at > now());
   if found then
     select coalesce(sum(r.reserved_usd), 0) into v_reserved from public.ai_call_reservations r
      where r.period_id = v_prev.id and r.status = 'reserved';
     v_carry := greatest(0, v_prev.budget_usd - v_prev.spent_usd - v_reserved);
     if public.ai_effective_plan(v_order.user_id) is null then v_carry := 0; end if;
   end if;
   insert into public.ai_paid_periods (user_id, order_id, plan_id, starts_at, ends_at, budget_usd)
   values (v_order.user_id, v_order.id, v_order.plan_id, now(), null, least(v_order.budget_usd + v_carry, 9999))
   returning id into v_period;
   insert into public.ai_subscriptions (user_id, plan_id, status, current_period_end, source, external_ref, support_period_id)
   values (v_order.user_id, v_order.plan_id, 'active', null, 'support', 'order:' || v_order.id, v_period)
   on conflict (user_id) do update set plan_id = excluded.plan_id, status = 'active', current_period_end = null,
     source = 'support', external_ref = excluded.external_ref, support_period_id = v_period,
     stripe_customer_id = null, stripe_subscription_id = null, stripe_price_id = null, stripe_status = null,
     cancel_at_period_end = false, grace_until = null, budget_cap_usd = null, budget_cap_until = null, updated_at = now();
 end if;
 update public.payment_orders set status = 'paid', paid_at = now(), provider_payment_id = p_payment_id,
   provider_status = coalesce(left(p_provider_status, 60), 'paid'), live = coalesce(p_live, live), period_id = v_period,
   carried_usd = v_carry, checked_at = now(), updated_at = now()
  where id = p_order returning * into v_order;
 perform public.admin_log(null, null, case when v_order.product = 'pass' then 'pass.purchased' else 'payments.paid' end, v_order.user_id,
   jsonb_build_object('orderId', v_order.id, 'plan', v_order.plan_id, 'provider', v_order.provider, 'amount', v_order.amount, 'currency', v_order.currency,
     'priceUsd', v_order.price_usd, 'live', v_order.live, 'carriedUsd', v_carry, 'periodId', v_period, 'seasonId', v_order.season_id, 'tier', v_order.pass_tier));
 return jsonb_build_object('applied', true, 'order', private.payments_order_json(v_order));
end $$;

-- Pago rechazado, cancelado, vencido o devuelto (0025, más el producto 'pass').
create or replace function public.payments_mark_status(p_order uuid, p_status text, p_provider_status text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_order public.payment_orders%rowtype; v_current uuid; v_carried numeric;
begin
 if p_status not in ('failed', 'cancelled', 'expired', 'refunded') then raise exception 'bad_status' using errcode = '22023'; end if;
 select * into v_order from public.payment_orders where id = p_order for update;
 if not found then return jsonb_build_object('applied', false, 'reason', 'order_not_found'); end if;
 if p_status = 'refunded' then
   if v_order.status <> 'paid' then return jsonb_build_object('applied', false, 'reason', 'not_paid'); end if;
   perform pg_advisory_xact_lock(hashtextextended(v_order.user_id::text, 816));
   if v_order.product = 'pass' then
     perform private.pass_revoke(v_order);
   else
     update public.ai_paid_periods set ends_at = greatest(now(), starts_at + interval '1 second')
      where id = v_order.period_id and (ends_at is null or ends_at > now());
     select s.support_period_id into v_current from public.ai_subscriptions s where s.user_id = v_order.user_id and s.source = 'support';
     if v_current is not null and v_current is distinct from v_order.period_id then
       select o.carried_usd into v_carried from public.payment_orders o
        where o.user_id = v_order.user_id and o.id <> v_order.id and o.status = 'paid' and o.paid_at >= v_order.paid_at order by o.paid_at limit 1;
       update public.ai_paid_periods set budget_usd = greatest(spent_usd, budget_usd - least(coalesce(v_carried, 0), v_order.budget_usd))
        where id = v_current;
     end if;
   end if;
   update public.payment_orders set status = 'refunded', provider_status = coalesce(left(p_provider_status, 60), 'refunded'),
     checked_at = now(), updated_at = now() where id = p_order returning * into v_order;
   perform public.admin_log(null, null, case when v_order.product = 'pass' then 'pass.refunded' else 'payments.refunded' end, v_order.user_id,
     jsonb_build_object('orderId', v_order.id, 'provider', v_order.provider, 'amount', v_order.amount, 'currency', v_order.currency,
       'carriedRemoved', coalesce(v_carried, 0), 'seasonId', v_order.season_id, 'tier', v_order.pass_tier));
 elsif v_order.status = 'pending' then
   update public.payment_orders set status = p_status, provider_status = coalesce(left(p_provider_status, 60), p_status),
     checked_at = now(), updated_at = now() where id = p_order returning * into v_order;
 else
   return jsonb_build_object('applied', false, 'reason', 'not_pending', 'order', private.payments_order_json(v_order));
 end if;
 return jsonb_build_object('applied', true, 'order', private.payments_order_json(v_order));
end $$;

-- La tienda no vende lo que viene del pase (0021, más source).
create or replace function public.shop_buy(p_item text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  it record;
  v_balance integer;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if public.moderation_social_block(me) = 'user_banned' then raise exception 'user_banned' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtext('points:' || me::text));
  select * into it from public.shop_items where id = p_item and active;
  if not found or it.source <> 'shop' then raise exception 'bad_item' using errcode = '22023'; end if;
  if it.premium_only then raise exception 'premium_item' using errcode = '22023'; end if;
  if exists (select 1 from public.user_items where user_id = me and item_id = p_item) then raise exception 'owned' using errcode = '22023'; end if;
  v_balance := private.points_balance(me);
  if v_balance < it.price then raise exception 'not_enough_points' using errcode = '22023'; end if;
  if it.price > 0 then perform private.points_award(me, -it.price, 'shop', p_item); end if;
  insert into public.user_items (user_id, item_id) values (me, p_item);
  return jsonb_build_object('ok', true, 'balance', private.points_balance(me));
end $$;

-- ---------- 5) Administración ----------
create or replace function public.admin_pass_seasons() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.admin_guard();
  return coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'startsAt', public.ai_iso(s.starts_at), 'endsAt', public.ai_iso(s.ends_at),
      'active', s.active, 'levels', s.levels, 'xpPerLevel', s.xp_per_level,
      'tiers', coalesce((select jsonb_agg(jsonb_build_object('tier', t.tier, 'priceUsd', t.price_usd, 'bonusLevels', t.bonus_levels, 'xpMult', t.xp_mult, 'perkItems', to_jsonb(t.perk_items),
          'sold', (select count(*) from public.pass_purchases p where p.season_id = s.id and p.tier = t.tier and p.revoked_at is null))
          order by private.pass_tier_rank(t.tier)) from public.pass_tiers t where t.season_id = s.id), '[]'::jsonb),
      'sold', (select count(*) from public.pass_purchases p where p.season_id = s.id and p.revoked_at is null),
      'refunded', (select count(*) from public.pass_purchases p where p.season_id = s.id and p.revoked_at is not null),
      'revenueUsd', (select coalesce(sum(o.price_usd), 0) from public.payment_orders o where o.season_id = s.id and o.status = 'paid'),
      'rewards', (select count(*) from public.pass_rewards r where r.season_id = s.id))
      order by s.starts_at desc) from public.pass_seasons s), '[]'::jsonb);
end $$;

-- Crea o cambia una temporada: { id, name, startsAt, endsAt, active, levels, xpPerLevel, tiers: [{ tier, priceUsd, bonusLevels, xpMult }],
-- copyRewardsFrom? } (los premios de una temporada nueva se copian de otra). Una sola activa a la vez.
create or replace function public.admin_pass_season_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_id text := p ->> 'id'; v_new boolean; t jsonb; v_from text := p ->> 'copyRewardsFrom';
begin
  perform public.admin_guard();
  if v_id is null or v_id !~ '^[a-z0-9_-]{2,40}$' then raise exception 'bad_id' using errcode = '22023'; end if;
  v_new := not exists (select 1 from public.pass_seasons where id = v_id);
  insert into public.pass_seasons (id, name, starts_at, ends_at, active, levels, xp_per_level)
  values (v_id, left(p ->> 'name', 60), (p ->> 'startsAt')::timestamptz, (p ->> 'endsAt')::timestamptz, coalesce((p ->> 'active')::boolean, false),
    coalesce((p ->> 'levels')::integer, 50), coalesce((p ->> 'xpPerLevel')::integer, 150))
  on conflict (id) do update set name = excluded.name, starts_at = excluded.starts_at, ends_at = excluded.ends_at, active = excluded.active,
    levels = excluded.levels, xp_per_level = excluded.xp_per_level;
  if coalesce((p ->> 'active')::boolean, false) then update public.pass_seasons set active = false where id <> v_id and active; end if;
  for t in select e from jsonb_array_elements(coalesce(p -> 'tiers', '[]'::jsonb)) e loop
    insert into public.pass_tiers (season_id, tier, price_usd, bonus_levels, xp_mult, perk_items)
    values (v_id, t ->> 'tier', (t ->> 'priceUsd')::numeric, coalesce((t ->> 'bonusLevels')::integer, 0), coalesce((t ->> 'xpMult')::numeric, 1),
      coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(t -> 'perkItems', '[]'::jsonb)) x), '{}'))
    on conflict (season_id, tier) do update set price_usd = excluded.price_usd, bonus_levels = excluded.bonus_levels, xp_mult = excluded.xp_mult, perk_items = excluded.perk_items;
  end loop;
  if v_new and v_from is not null then
    insert into public.pass_rewards (season_id, level, track, kind, amount, item_id)
    select v_id, r.level, r.track, r.kind, r.amount, r.item_id from public.pass_rewards r where r.season_id = v_from on conflict do nothing;
  end if;
  perform public.admin_log(auth.uid(), null, 'pass.seasonSaved', null, jsonb_build_object('seasonId', v_id, 'new', v_new));
  return (select x from jsonb_array_elements(public.admin_pass_seasons()) x where x ->> 'id' = v_id);
end $$;

-- Premios de una temporada (para editarlos) y cambio de uno: { level, track, kind, amount?, itemId? } (kind 'none' lo borra).
create or replace function public.admin_pass_rewards(p_season text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.admin_guard();
  return coalesce((select jsonb_agg(jsonb_build_object('level', r.level, 'track', r.track, 'kind', r.kind, 'amount', r.amount, 'itemId', r.item_id) order by r.level, r.track)
    from public.pass_rewards r where r.season_id = p_season), '[]'::jsonb);
end $$;
create or replace function public.admin_pass_reward_set(p_season text, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_level integer := (p ->> 'level')::integer; v_track text := p ->> 'track'; v_kind text := p ->> 'kind';
begin
  perform public.admin_guard();
  if v_kind = 'none' then
    delete from public.pass_rewards where season_id = p_season and level = v_level and track = v_track;
  else
    insert into public.pass_rewards (season_id, level, track, kind, amount, item_id)
    values (p_season, v_level, v_track, v_kind, (p ->> 'amount')::integer, p ->> 'itemId')
    on conflict (season_id, level, track) do update set kind = excluded.kind, amount = excluded.amount, item_id = excluded.item_id;
  end if;
  return public.admin_pass_rewards(p_season);
end $$;

-- Da una edición sin pago (pruebas, regalos del equipo). Se registra.
create or replace function public.admin_pass_grant(p_user uuid, p_tier text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.pass_seasons; o public.payment_orders%rowtype;
begin
  perform public.admin_guard();
  s := private.pass_current();
  if s.id is null then raise exception 'no_season' using errcode = '22023'; end if;
  if p_tier not in ('go', 'pro', 'max') or not exists (select 1 from auth.users where id = p_user) then raise exception 'bad_request' using errcode = '22023'; end if;
  o.user_id := p_user; o.season_id := s.id; o.pass_tier := p_tier; o.id := null;
  perform private.pass_fulfill(o);
  update public.pass_purchases set granted_by = auth.uid() where user_id = p_user and season_id = s.id;
  perform public.admin_log(auth.uid(), null, 'pass.granted', p_user, jsonb_build_object('seasonId', s.id, 'tier', p_tier));
  return jsonb_build_object('ok', true);
end $$;

-- ---------- 6) Permisos ----------
revoke all on function private.pass_current(), private.pass_tier_rank(text), private.pass_purchase(uuid, text), private.pass_xp(uuid, public.pass_seasons),
  private.pass_level(public.pass_seasons, bigint), private.payments_price(numeric, text), private.pass_quote(text, text, uuid),
  private.pass_fulfill(public.payment_orders), private.pass_revoke(public.payment_orders), private.payment_orders_check() from public, anon, authenticated;
revoke all on function public.pass_me(), public.pass_playtime(integer), public.pass_claim(integer, text), public.pass_claim_all(),
  public.admin_pass_seasons(), public.admin_pass_season_save(jsonb), public.admin_pass_rewards(text), public.admin_pass_reward_set(text, jsonb),
  public.admin_pass_grant(uuid, text) from public, anon;
grant execute on function public.pass_me(), public.pass_playtime(integer), public.pass_claim(integer, text), public.pass_claim_all(),
  public.admin_pass_seasons(), public.admin_pass_season_save(jsonb), public.admin_pass_rewards(text), public.admin_pass_reward_set(text, jsonb),
  public.admin_pass_grant(uuid, text) to authenticated;
grant execute on function public.pass_me(), public.pass_playtime(integer), public.pass_claim(integer, text), public.pass_claim_all(),
  public.admin_pass_seasons(), public.admin_pass_season_save(jsonb), public.admin_pass_rewards(text), public.admin_pass_reward_set(text, jsonb),
  public.admin_pass_grant(uuid, text) to service_role;
revoke all on function public.payments_mark_paid(uuid, text, numeric, text, boolean, text), public.payments_mark_status(uuid, text, text),
  public.payments_create_order(uuid, text, text, boolean) from public, anon, authenticated;
grant execute on function public.payments_mark_paid(uuid, text, numeric, text, boolean, text), public.payments_mark_status(uuid, text, text),
  public.payments_create_order(uuid, text, text, boolean) to service_role;
revoke all on function public.payments_catalog() from public;
grant execute on function public.payments_catalog() to anon, authenticated, service_role;
