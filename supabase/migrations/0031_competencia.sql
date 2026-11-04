-- 0031_competencia.sql · Competir: rankings entre amigos, desafíos con Venus Points y calendario de eventos.
-- Guía: docs/wip/competir-33.md. Se aplica después de 0027 (motivos de points_ledger, private.are_friends, admin_guard). Idempotente.
--
--   * Rankings: lo informa cada PC (ranking_report), así que sirve para jugar entre amigos, no como competencia oficial.
--     Semanas de lunes a domingo (UTC). Compartir es opcional (ranking_prefs.share, apagado de entrada): sin compartir no
--     se acepta ningún envío y ranking_friends no te muestra. Topes por semana y por envío para frenar lo imposible.
--   * Desafíos: uno contra un amigo con plazo de 24 h, 3 o 7 días, a un objetivo (gana el primero en llegar) o "el que más
--     haga". Decide el servidor con lo informado durante el plazo y paga 25 puntos (motivo 'challenge', ref = el desafío).
--     Para que no sea una fábrica de puntos: 3 premios por semana por cuenta, 1 premiado por semana con el mismo amigo y
--     los dos tienen que haber informado al menos 10 minutos jugados durante el plazo. Sin multiplicador de premium y
--     pass_xp (0026) no cuenta este motivo.
--   * Eventos: los crea el equipo (admin_event_save). Los usuarios se anotan y se dan de baja; un torneo muestra quiénes
--     se anotaron, se cierra al llegar al cupo y al empezar. El aviso de 15 minutos antes lo da cada launcher abierto.

-- ---------- 1) Semanas y topes ----------
-- Lunes (UTC) de la semana de un instante.
create or replace function private.compete_week(p_at timestamptz) returns date
language sql immutable set search_path = '' as $$
  select (date_trunc('week', p_at at time zone 'UTC'))::date
$$;

-- Lo máximo que se acepta de cada métrica por semana (hours va en minutos: 168 h). null = métrica desconocida.
create or replace function private.ranking_cap(p_metric text) returns integer
language sql immutable set search_path = '' as $$
  select case p_metric when 'hours' then 10080 when 'diamonds' then 5000 when 'mobs' then 100000
                       when 'blocks' then 1000000 when 'deaths' then 5000 end
$$;

-- ---------- 2) Tablas ----------
create table if not exists public.ranking_prefs (
  user_id uuid primary key references auth.users (id) on delete cascade,
  share boolean not null default false,
  updated_at timestamptz not null default now()
);
-- Totales de cada semana: de acá sale el ranking.
create table if not exists public.ranking_weekly (
  user_id uuid not null references auth.users (id) on delete cascade,
  week date not null check (extract(isodow from week) = 1),
  minutes integer not null default 0 check (minutes between 0 and 10080),
  diamonds integer not null default 0 check (diamonds between 0 and 5000),
  mobs integer not null default 0 check (mobs between 0 and 100000),
  blocks integer not null default 0 check (blocks between 0 and 1000000),
  deaths integer not null default 0 check (deaths between 0 and 5000),
  updated_at timestamptz not null default now(),
  primary key (user_id, week)
);
create index if not exists ranking_weekly_week on public.ranking_weekly (week);
-- Cada envío aceptado, con su momento: de acá salen los desafíos. Se guardan 30 días.
create table if not exists public.ranking_reports (
  id bigserial primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  week date not null,
  at timestamptz not null default now(),
  minutes integer not null default 0,
  diamonds integer not null default 0,
  mobs integer not null default 0,
  blocks integer not null default 0,
  deaths integer not null default 0
);
create index if not exists ranking_reports_user on public.ranking_reports (user_id, at);

create table if not exists public.challenges (
  id uuid primary key default gen_random_uuid(),
  challenger uuid not null references auth.users (id) on delete cascade,
  opponent uuid not null references auth.users (id) on delete cascade,
  metric text not null check (metric in ('hours', 'diamonds', 'mobs', 'blocks', 'deaths')),
  target integer check (target is null or target > 0), -- null = "el que más haga"; hours va en minutos
  hours integer not null check (hours in (24, 72, 168)),
  status text not null default 'pending' check (status in ('pending', 'active', 'declined', 'canceled', 'expired', 'finished')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  starts_at timestamptz,
  ends_at timestamptz,
  settled_at timestamptz,
  winner uuid references auth.users (id) on delete set null,
  outcome text check (outcome in ('win', 'tie', 'no_activity', 'no_target')),
  prize integer not null default 0 check (prize >= 0),
  prize_week date,
  prize_note text check (prize_note in ('banned', 'not_friends', 'week_cap', 'friend_cap')), -- por qué un ganador no cobró
  challenger_value integer,
  opponent_value integer,
  challenger_minutes integer,
  opponent_minutes integer,
  constraint challenges_pair check (challenger <> opponent)
);
-- Un solo desafío abierto por pareja y un solo premio por semana por pareja, también bajo concurrencia.
create unique index if not exists challenges_open_pair on public.challenges (least(challenger, opponent), greatest(challenger, opponent))
  where status in ('pending', 'active');
create unique index if not exists challenges_prize_pair on public.challenges (least(challenger, opponent), greatest(challenger, opponent), prize_week)
  where prize > 0;
create index if not exists challenges_challenger on public.challenges (challenger, created_at desc);
create index if not exists challenges_opponent on public.challenges (opponent, created_at desc);
create index if not exists challenges_winner on public.challenges (winner, prize_week) where prize > 0;

create table if not exists public.calendar_events (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 80),
  description text not null default '' check (char_length(description) <= 2000),
  kind text not null default 'event' check (kind in ('event', 'tournament')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  capacity integer check (capacity between 1 and 100000), -- null = sin cupo (solo en eventos)
  server text check (server ~ '^[A-Za-z0-9._-]{1,120}(:[0-9]{1,5})?$'),
  link text check (char_length(link) <= 308 and link ~ '^https://[^[:space:]<>"]+$'),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint calendar_events_dates check (ends_at > starts_at),
  constraint calendar_events_tournament check (kind <> 'tournament' or capacity is not null)
);
create index if not exists calendar_events_starts on public.calendar_events (starts_at);
create table if not exists public.calendar_signups (
  event_id uuid not null references public.calendar_events (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (event_id, user_id)
);
create index if not exists calendar_signups_user on public.calendar_signups (user_id, created_at desc);

do $$
declare t text;
begin
  foreach t in array array['ranking_prefs', 'ranking_weekly', 'ranking_reports', 'challenges', 'calendar_events', 'calendar_signups'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;
revoke all on sequence public.ranking_reports_id_seq from public, anon, authenticated;

-- Premio de los desafíos en el libro de puntos
alter table public.points_ledger drop constraint if exists points_ledger_reason_check;
alter table public.points_ledger add constraint points_ledger_reason_check
  check (reason in ('daily', 'achievement', 'referral', 'referred', 'shop', 'admin', 'mission', 'pass', 'pass_refund', 'gift_in', 'gift_out', 'challenge'));

-- ---------- 3) Rankings ----------
-- Prende o apaga compartir para la cuenta. Apagado: no se aceptan envíos y tus amigos dejan de verte.
create or replace function public.ranking_set_share(p_on boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if public.moderation_social_block(me) = 'user_banned' then raise exception 'user_banned' using errcode = '42501'; end if;
  insert into public.ranking_prefs (user_id, share) values (me, coalesce(p_on, false))
  on conflict (user_id) do update set share = excluded.share, updated_at = now();
  return jsonb_build_object('share', coalesce(p_on, false));
end $$;

-- Borra lo que informó la cuenta y apaga compartir.
create or replace function public.ranking_forget() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtext('ranking:' || me::text));
  delete from public.ranking_reports where user_id = me;
  delete from public.ranking_weekly where user_id = me;
  insert into public.ranking_prefs (user_id, share) values (me, false)
  on conflict (user_id) do update set share = false, updated_at = now();
  return jsonb_build_object('share', false);
end $$;

/**
 * Lo que la PC jugó desde el último envío. p_week: la semana (lunes) de esa actividad, la actual o la anterior (null = la
 * actual). Lo que supera el tope de la semana se descarta y los minutos no pueden ser más que el tiempo que pasó desde el
 * último envío de esa semana (con 10 de margen). Un envío por minuto por semana. Errores (22023): bad_week, bad_value,
 * share_off, too_soon; user_banned (42501). Devuelve { week, accepted: { minutes, diamonds, mobs, blocks, deaths }, clamped }.
 */
create or replace function public.ranking_report(p_minutes integer, p_diamonds integer, p_mobs integer, p_blocks integer, p_deaths integer, p_week date default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_current date := private.compete_week(now());
  v_week date := coalesce(p_week, v_current);
  v_start timestamptz := v_week::timestamp at time zone 'UTC';
  v_last timestamptz;
  w public.ranking_weekly;
  v_room integer;
  v_min integer;
  v_dia integer;
  v_mob integer;
  v_blo integer;
  v_dea integer;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if public.moderation_social_block(me) = 'user_banned' then raise exception 'user_banned' using errcode = '42501'; end if;
  if v_week not in (v_current, v_current - 7) then raise exception 'bad_week' using errcode = '22023'; end if;
  if least(coalesce(p_minutes, 0), coalesce(p_diamonds, 0), coalesce(p_mobs, 0), coalesce(p_blocks, 0), coalesce(p_deaths, 0)) < 0 then
    raise exception 'bad_value' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('ranking:' || me::text));
  if not coalesce((select p.share from public.ranking_prefs p where p.user_id = me), false) then
    raise exception 'share_off' using errcode = '22023';
  end if;
  select max(r.at) into v_last from public.ranking_reports r where r.user_id = me and r.week = v_week;
  if v_last > now() - interval '1 minute' then raise exception 'too_soon' using errcode = '22023'; end if;
  insert into public.ranking_weekly (user_id, week) values (me, v_week) on conflict do nothing;
  select * into w from public.ranking_weekly x where x.user_id = me and x.week = v_week for update;
  v_room := greatest(0, ceil(extract(epoch from least(now(), v_start + interval '7 days') - coalesce(v_last, v_start)) / 60)::integer) + 10;
  v_min := least(coalesce(p_minutes, 0), 10080 - w.minutes, v_room);
  v_dia := least(coalesce(p_diamonds, 0), 5000 - w.diamonds);
  v_mob := least(coalesce(p_mobs, 0), 100000 - w.mobs);
  v_blo := least(coalesce(p_blocks, 0), 1000000 - w.blocks);
  v_dea := least(coalesce(p_deaths, 0), 5000 - w.deaths);
  if v_min > 0 or v_dia > 0 or v_mob > 0 or v_blo > 0 or v_dea > 0 then
    update public.ranking_weekly x set minutes = x.minutes + v_min, diamonds = x.diamonds + v_dia, mobs = x.mobs + v_mob,
      blocks = x.blocks + v_blo, deaths = x.deaths + v_dea, updated_at = now()
     where x.user_id = me and x.week = v_week;
    insert into public.ranking_reports (user_id, week, minutes, diamonds, mobs, blocks, deaths)
    values (me, v_week, v_min, v_dia, v_mob, v_blo, v_dea);
    delete from public.ranking_reports r where r.user_id = me and r.at < now() - interval '30 days';
  end if;
  return jsonb_build_object('week', v_week,
    'accepted', jsonb_build_object('minutes', v_min, 'diamonds', v_dia, 'mobs', v_mob, 'blocks', v_blo, 'deaths', v_dea),
    'clamped', v_min < coalesce(p_minutes, 0) or v_dia < coalesce(p_diamonds, 0) or v_mob < coalesce(p_mobs, 0)
      or v_blo < coalesce(p_blocks, 0) or v_dea < coalesce(p_deaths, 0));
end $$;

/**
 * Ranking de una semana entre quien llama y sus amigos que comparten. Solo amigos aceptados y sin baneados; de cada amigo
 * solo se ve la métrica pedida. p_week: cualquier día de la semana (null = la actual). Error (22023): bad_metric.
 * Devuelve { week, metric, share, mine: { minutes, diamonds, mobs, blocks, deaths } | null, rows: [{ userId, username,
 * displayName, mcName, mcUuid, value, rank, me }] }. hours va en minutos.
 */
create or replace function public.ranking_friends(p_metric text, p_week date default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_week date := private.compete_week(coalesce(p_week::timestamp at time zone 'UTC', now()));
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if private.ranking_cap(p_metric) is null then raise exception 'bad_metric' using errcode = '22023'; end if;
  return jsonb_build_object('week', v_week, 'metric', p_metric,
    'share', coalesce((select p.share from public.ranking_prefs p where p.user_id = me), false),
    'mine', (select jsonb_build_object('minutes', w.minutes, 'diamonds', w.diamonds, 'mobs', w.mobs, 'blocks', w.blocks, 'deaths', w.deaths)
               from public.ranking_weekly w where w.user_id = me and w.week = v_week),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object('userId', t.id, 'username', t.username, 'displayName', t.display_name, 'mcName', t.mc_name,
               'mcUuid', t.mc_uuid, 'value', t.val, 'rank', t.pos, 'me', t.id = me) order by t.pos, t.username)
        from (
          with members as (
            select f.addressee as id from public.friendships f where f.status = 'accepted' and f.requester = me
            union
            select f.requester from public.friendships f where f.status = 'accepted' and f.addressee = me
            union
            select me
          )
          select pr.id, pr.username, pr.display_name, pr.mc_name, pr.mc_uuid, x.val, rank() over (order by x.val desc) as pos
            from (
              select m.id, coalesce(case p_metric when 'hours' then w.minutes when 'diamonds' then w.diamonds when 'mobs' then w.mobs
                                                  when 'blocks' then w.blocks else w.deaths end, 0) as val
                from members m
                join public.ranking_prefs rp on rp.user_id = m.id and rp.share
                left join public.ranking_weekly w on w.user_id = m.id and w.week = v_week
               where public.moderation_social_block(m.id) is distinct from 'user_banned'
            ) x
            join public.profiles pr on pr.id = x.id
        ) t), '[]'::jsonb));
end $$;

-- ---------- 4) Desafíos ----------
-- Lo informado por un usuario durante el plazo: el valor de la métrica, los minutos jugados y cuándo llegó al objetivo.
-- Lo de la semana anterior a la que empezó el desafío no cuenta aunque se haya enviado durante el plazo.
create or replace function private.challenge_tally(c public.challenges, p_user uuid) returns table (val bigint, minutes bigint, reached_at timestamptz)
language sql stable security definer set search_path = '' as $$
  with counted as (
    select r.id, r.at, r.minutes,
           case c.metric when 'hours' then r.minutes when 'diamonds' then r.diamonds when 'mobs' then r.mobs
                         when 'blocks' then r.blocks else r.deaths end as v
      from public.ranking_reports r
     where r.user_id = p_user and r.at >= c.starts_at and r.at < c.ends_at and r.week >= private.compete_week(c.starts_at)
  )
  select coalesce((select sum(k.v) from counted k), 0)::bigint,
         coalesce((select sum(k.minutes) from counted k), 0)::bigint,
         (select min(s.at) from (select k.at, sum(k.v) over (order by k.at, k.id) as total from counted k) s
           where c.target is not null and s.total >= c.target)
$$;

/**
 * Cierra un desafío si corresponde y devuelve cómo quedó. Se puede llamar las veces que sea: lo cerrado no se toca y el
 * premio entra una sola vez (fila bloqueada + points_ledger único por (motivo, ref)). Lo llaman solo las RPC de los
 * participantes (private.are_friends responde únicamente a ellos).
 *   pendiente  -> expired a las 48 h sin respuesta
 *   a objetivo -> gana el primero en llegar: cierra apenas llegó alguien y los dos ya jugaron; si no, al terminar el plazo
 *   al que más -> cierra al terminar el plazo
 *   outcome: 'win', 'tie', 'no_target' (nadie llegó) o 'no_activity' (alguno no llegó a los 10 minutos jugados)
 */
create or replace function private.challenge_finish(p_id uuid) returns public.challenges
language plpgsql security definer set search_path = '' as $$
declare
  c public.challenges;
  a record;
  b record;
  v_due boolean;
  v_active boolean;
  v_winner uuid;
  v_outcome text;
  v_note text;
  v_prize integer := 0;
  v_week date := private.compete_week(now());
begin
  select * into c from public.challenges x where x.id = p_id for update;
  if not found then return null; end if;
  if c.status = 'pending' then
    if c.created_at <= now() - interval '48 hours' then
      update public.challenges x set status = 'expired', settled_at = now() where x.id = p_id returning * into c;
    end if;
    return c;
  end if;
  if c.status <> 'active' then return c; end if;

  select * into a from private.challenge_tally(c, c.challenger);
  select * into b from private.challenge_tally(c, c.opponent);
  v_due := now() >= c.ends_at;
  v_active := a.minutes >= 10 and b.minutes >= 10;
  if c.target is null then
    if not v_due then return c; end if;
    if not v_active then v_outcome := 'no_activity';
    elsif a.val = b.val then v_outcome := 'tie';
    else
      v_outcome := 'win';
      v_winner := case when a.val > b.val then c.challenger else c.opponent end;
    end if;
  elsif a.reached_at is null and b.reached_at is null then
    if not v_due then return c; end if;
    v_outcome := case when v_active then 'no_target' else 'no_activity' end;
  elsif not v_active then
    if not v_due then return c; end if;
    v_outcome := 'no_activity';
  elsif a.reached_at = b.reached_at then
    v_outcome := 'tie';
  else
    v_outcome := 'win';
    v_winner := case when b.reached_at is null or a.reached_at < b.reached_at then c.challenger else c.opponent end;
  end if;

  if v_outcome = 'win' then
    if public.moderation_social_block(c.challenger) = 'user_banned' or public.moderation_social_block(c.opponent) = 'user_banned' then
      v_note := 'banned';
    elsif not private.are_friends(c.challenger, c.opponent) then
      v_note := 'not_friends';
    else
      perform pg_advisory_xact_lock(hashtext('points:' || v_winner::text));
      if (select count(*) from public.challenges x where x.winner = v_winner and x.prize > 0 and x.prize_week = v_week) >= 3 then
        v_note := 'week_cap';
      elsif exists (select 1 from public.challenges x
                     where x.prize > 0 and x.prize_week = v_week
                       and least(x.challenger, x.opponent) = least(c.challenger, c.opponent)
                       and greatest(x.challenger, x.opponent) = greatest(c.challenger, c.opponent)) then
        v_note := 'friend_cap';
      else
        v_prize := private.points_award(v_winner, 25, 'challenge', c.id::text);
      end if;
    end if;
  end if;
  update public.challenges x
     set status = 'finished', settled_at = now(), winner = v_winner, outcome = v_outcome, prize = v_prize,
         prize_week = case when v_prize > 0 then v_week end, prize_note = v_note,
         challenger_value = a.val, opponent_value = b.val, challenger_minutes = a.minutes, opponent_minutes = b.minutes
   where x.id = p_id returning * into c;
  return c;
end $$;

-- Cómo ve un desafío uno de los dos participantes.
create or replace function private.challenge_json(c public.challenges, p_me uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_mine boolean := c.challenger = p_me;
  v_other uuid := case when c.challenger = p_me then c.opponent else c.challenger end;
  v_my bigint := case when v_mine then c.challenger_value else c.opponent_value end;
  v_their bigint := case when v_mine then c.opponent_value else c.challenger_value end;
  v_my_min bigint := case when v_mine then c.challenger_minutes else c.opponent_minutes end;
  v_their_min bigint := case when v_mine then c.opponent_minutes else c.challenger_minutes end;
begin
  if c.status = 'active' then
    select t.val, t.minutes into v_my, v_my_min from private.challenge_tally(c, p_me) t;
    select t.val, t.minutes into v_their, v_their_min from private.challenge_tally(c, v_other) t;
  end if;
  return jsonb_build_object('id', c.id, 'mine', v_mine, 'metric', c.metric, 'target', c.target, 'hours', c.hours, 'status', c.status,
    'createdAt', public.ai_iso(c.created_at), 'startsAt', public.ai_iso(c.starts_at), 'endsAt', public.ai_iso(c.ends_at), 'settledAt', public.ai_iso(c.settled_at),
    'expiresAt', case when c.status = 'pending' then public.ai_iso(c.created_at + interval '48 hours') end,
    'outcome', c.outcome, 'won', c.winner = p_me, 'prize', c.prize, 'prizeNote', c.prize_note,
    'friend', (select jsonb_build_object('id', pr.id, 'username', pr.username, 'displayName', pr.display_name, 'mcName', pr.mc_name, 'mcUuid', pr.mc_uuid)
                 from public.profiles pr where pr.id = v_other),
    'myValue', v_my, 'theirValue', v_their, 'myMinutes', v_my_min, 'theirMinutes', v_their_min);
end $$;

/**
 * Desafía a un amigo. p_hours: 24, 72 o 168. p_target: el objetivo (hours en minutos) o null para "el que más haga".
 * Errores (22023): bad_target, not_friends, target_banned, bad_metric, bad_hours, bad_goal, share_off, already_open,
 * too_many_open (10 abiertos), too_many_today (10 por día); user_banned / user_muted (42501). Devuelve el desafío.
 */
create or replace function public.challenge_create(p_friend uuid, p_metric text, p_hours integer, p_target integer default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_block text;
  c public.challenges;
  x record;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  v_block := public.moderation_social_block(me);
  if v_block is not null then raise exception '%', v_block using errcode = '42501'; end if;
  if p_friend is null or p_friend = me or not exists (select 1 from public.profiles p where p.id = p_friend) then raise exception 'bad_target' using errcode = '22023'; end if;
  if not private.are_friends(me, p_friend) then raise exception 'not_friends' using errcode = '22023'; end if;
  if public.moderation_social_block(p_friend) = 'user_banned' then raise exception 'target_banned' using errcode = '22023'; end if;
  if private.ranking_cap(p_metric) is null then raise exception 'bad_metric' using errcode = '22023'; end if;
  if p_hours is null or p_hours not in (24, 72, 168) then raise exception 'bad_hours' using errcode = '22023'; end if;
  if p_target is not null and (p_target < 1 or p_target > private.ranking_cap(p_metric)) then raise exception 'bad_goal' using errcode = '22023'; end if;
  if not coalesce((select p.share from public.ranking_prefs p where p.user_id = me), false) then raise exception 'share_off' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext('challenges:' || me::text));
  -- Lo que venció sin que nadie lo mirara deja de contar como abierto.
  for x in select y.id from public.challenges y where me in (y.challenger, y.opponent) and y.status in ('pending', 'active') loop
    perform private.challenge_finish(x.id);
  end loop;
  if exists (select 1 from public.challenges y where y.status in ('pending', 'active')
              and least(y.challenger, y.opponent) = least(me, p_friend) and greatest(y.challenger, y.opponent) = greatest(me, p_friend)) then
    raise exception 'already_open' using errcode = '22023';
  end if;
  if (select count(*) from public.challenges y where me in (y.challenger, y.opponent) and y.status in ('pending', 'active')) >= 10 then
    raise exception 'too_many_open' using errcode = '22023';
  end if;
  if (select count(*) from public.challenges y where y.challenger = me and y.created_at > now() - interval '1 day') >= 10 then
    raise exception 'too_many_today' using errcode = '22023';
  end if;
  insert into public.challenges (challenger, opponent, metric, target, hours) values (me, p_friend, p_metric, p_target, p_hours) returning * into c;
  return private.challenge_json(c, me);
end $$;

-- El desafiado acepta (empieza el plazo) o rechaza. Errores (22023): not_found, not_pending, share_off, not_friends,
-- target_banned; user_banned (42501). Devuelve el desafío.
create or replace function public.challenge_respond(p_id uuid, p_accept boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  c public.challenges;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if public.moderation_social_block(me) = 'user_banned' then raise exception 'user_banned' using errcode = '42501'; end if;
  c := private.challenge_finish(p_id);
  if c.id is null or c.opponent <> me then raise exception 'not_found' using errcode = '22023'; end if;
  if c.status <> 'pending' then raise exception 'not_pending' using errcode = '22023'; end if;
  if coalesce(p_accept, false) then
    if not coalesce((select p.share from public.ranking_prefs p where p.user_id = me), false) then raise exception 'share_off' using errcode = '22023'; end if;
    if not private.are_friends(me, c.challenger) then raise exception 'not_friends' using errcode = '22023'; end if;
    if public.moderation_social_block(c.challenger) = 'user_banned' then raise exception 'target_banned' using errcode = '22023'; end if;
    update public.challenges x set status = 'active', responded_at = now(), starts_at = now(), ends_at = now() + make_interval(hours => c.hours)
     where x.id = p_id returning * into c;
  else
    update public.challenges x set status = 'declined', responded_at = now(), settled_at = now() where x.id = p_id returning * into c;
  end if;
  return private.challenge_json(c, me);
end $$;

-- El que desafió retira un desafío que todavía no respondieron. Errores (22023): not_found, not_pending.
create or replace function public.challenge_cancel(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  c public.challenges;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  c := private.challenge_finish(p_id);
  if c.id is null or c.challenger <> me then raise exception 'not_found' using errcode = '22023'; end if;
  if c.status <> 'pending' then raise exception 'not_pending' using errcode = '22023'; end if;
  update public.challenges x set status = 'canceled', settled_at = now() where x.id = p_id returning * into c;
  return private.challenge_json(c, me);
end $$;

-- Cierra lo que corresponda: un desafío (devuelve { challenge }) o todos los abiertos de quien llama ({ settled: n }).
-- Sin doble pago: ver private.challenge_finish. Errores: not_found (22023); user_banned (42501).
create or replace function public.challenge_settle(p_id uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  c public.challenges;
  x record;
  v_n integer := 0;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if public.moderation_social_block(me) = 'user_banned' then raise exception 'user_banned' using errcode = '42501'; end if;
  if p_id is not null then
    if not exists (select 1 from public.challenges y where y.id = p_id and me in (y.challenger, y.opponent)) then raise exception 'not_found' using errcode = '22023'; end if;
    c := private.challenge_finish(p_id);
    return jsonb_build_object('challenge', private.challenge_json(c, me));
  end if;
  for x in select y.id from public.challenges y where me in (y.challenger, y.opponent) and y.status in ('pending', 'active') order by y.id loop
    c := private.challenge_finish(x.id);
    if c.status not in ('pending', 'active') then v_n := v_n + 1; end if;
  end loop;
  return jsonb_build_object('settled', v_n);
end $$;

-- Lo que ve la página: cierra lo vencido y devuelve los abiertos y los últimos 20 cerrados.
create or replace function public.challenges_me() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  x record;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if public.moderation_social_block(me) = 'user_banned' then raise exception 'user_banned' using errcode = '42501'; end if;
  for x in select y.id from public.challenges y where me in (y.challenger, y.opponent) and y.status in ('pending', 'active') order by y.id loop
    perform private.challenge_finish(x.id);
  end loop;
  return jsonb_build_object(
    'rules', jsonb_build_object('prize', 25, 'weekCap', 3, 'minMinutes', 10, 'pendingHours', 48),
    'share', coalesce((select p.share from public.ranking_prefs p where p.user_id = me), false),
    'prizesThisWeek', (select count(*) from public.challenges y where y.winner = me and y.prize > 0 and y.prize_week = private.compete_week(now())),
    'challenges', coalesce((select jsonb_agg(private.challenge_json(c, me) order by c.created_at desc)
      from public.challenges c
     where c.id in (select y.id from public.challenges y where me in (y.challenger, y.opponent) and y.status in ('pending', 'active')
                    union all
                    (select y.id from public.challenges y where me in (y.challenger, y.opponent) and y.status not in ('pending', 'active')
                      order by y.settled_at desc nulls last limit 20))), '[]'::jsonb));
end $$;

-- ---------- 5) Eventos ----------
create or replace function private.event_json(e public.calendar_events, p_me uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', e.id, 'title', e.title, 'description', e.description, 'kind', e.kind,
    'startsAt', public.ai_iso(e.starts_at), 'endsAt', public.ai_iso(e.ends_at), 'capacity', e.capacity, 'server', e.server, 'link', e.link,
    'signups', (select count(*) from public.calendar_signups s where s.event_id = e.id),
    'joined', exists (select 1 from public.calendar_signups s where s.event_id = e.id and s.user_id = p_me))
$$;

-- Agenda: lo que pasa entre dos fechas (hasta 400 días y 300 eventos). Por defecto, de ahora a 90 días.
create or replace function public.events_list(p_from timestamptz default null, p_to timestamptz default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_from timestamptz := coalesce(p_from, now());
  v_to timestamptz := coalesce(p_to, coalesce(p_from, now()) + interval '90 days');
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if v_to <= v_from or v_to > v_from + interval '400 days' then raise exception 'bad_range' using errcode = '22023'; end if;
  return coalesce((select jsonb_agg(private.event_json(e, me) order by e.starts_at)
    from public.calendar_events e
   where e.id in (select y.id from public.calendar_events y where y.ends_at > v_from and y.starts_at < v_to order by y.starts_at limit 300)), '[]'::jsonb);
end $$;

-- Lo que anotó quien llama y todavía no terminó: de acá salen los avisos de 15 minutos antes.
create or replace function public.events_mine() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(private.event_json(e, me) order by e.starts_at)
    from public.calendar_events e
   where e.ends_at > now() and e.id in (select s.event_id from public.calendar_signups s where s.user_id = me)), '[]'::jsonb);
end $$;

-- Los anotados de un torneo (de un evento común solo se muestra cuántos). Errores (22023): not_found, not_tournament.
create or replace function public.event_signups(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_kind text;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  select e.kind into v_kind from public.calendar_events e where e.id = p_id;
  if v_kind is null then raise exception 'not_found' using errcode = '22023'; end if;
  if v_kind <> 'tournament' then raise exception 'not_tournament' using errcode = '22023'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('userId', pr.id, 'username', pr.username, 'displayName', pr.display_name, 'mcName', pr.mc_name,
             'mcUuid', pr.mc_uuid, 'at', public.ai_iso(s.created_at), 'me', pr.id = me) order by s.created_at)
    from public.calendar_signups s join public.profiles pr on pr.id = s.user_id
   where s.event_id = p_id), '[]'::jsonb);
end $$;

-- Anotarse. Un torneo se cierra al empezar; un evento, al terminar. Se puede llamar dos veces (no anota de nuevo).
-- Errores (22023): not_found, closed, full, too_many (50 anotados a la vez); user_banned (42501). Devuelve el evento.
create or replace function public.event_join(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  e public.calendar_events;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if public.moderation_social_block(me) = 'user_banned' then raise exception 'user_banned' using errcode = '42501'; end if;
  select * into e from public.calendar_events x where x.id = p_id for update; -- el cupo se revisa de a uno
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
  if exists (select 1 from public.calendar_signups s where s.event_id = p_id and s.user_id = me) then return private.event_json(e, me); end if;
  if now() >= e.ends_at or (e.kind = 'tournament' and now() >= e.starts_at) then raise exception 'closed' using errcode = '22023'; end if;
  if e.capacity is not null and (select count(*) from public.calendar_signups s where s.event_id = p_id) >= e.capacity then raise exception 'full' using errcode = '22023'; end if;
  if (select count(*) from public.calendar_signups s join public.calendar_events x on x.id = s.event_id where s.user_id = me and x.ends_at > now()) >= 50 then
    raise exception 'too_many' using errcode = '22023';
  end if;
  insert into public.calendar_signups (event_id, user_id) values (p_id, me);
  return private.event_json(e, me);
end $$;

-- Darse de baja hasta que termine. Errores (22023): not_found, closed. Devuelve el evento.
create or replace function public.event_leave(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  e public.calendar_events;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  select * into e from public.calendar_events x where x.id = p_id;
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
  if now() >= e.ends_at then raise exception 'closed' using errcode = '22023'; end if;
  delete from public.calendar_signups s where s.event_id = p_id and s.user_id = me;
  return private.event_json(e, me);
end $$;

-- ---------- 6) Administración ----------
create or replace function public.admin_events() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.admin_guard();
  return coalesce((select jsonb_agg(private.event_json(e, auth.uid()) order by e.starts_at desc)
    from public.calendar_events e
   where e.id in (select y.id from public.calendar_events y order by y.starts_at desc limit 200)), '[]'::jsonb);
end $$;

-- Crea o cambia un evento: { id?, title, description?, kind, startsAt, endsAt, capacity?, server?, link? }.
-- Errores (22023): not_found, bad_title, bad_description, bad_kind, bad_dates, bad_capacity, bad_server, bad_link.
create or replace function public.admin_event_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_id uuid;
  v_title text := btrim(coalesce(p ->> 'title', ''));
  v_desc text := btrim(coalesce(p ->> 'description', ''));
  v_kind text := p ->> 'kind';
  v_server text := nullif(btrim(coalesce(p ->> 'server', '')), '');
  v_link text := nullif(btrim(coalesce(p ->> 'link', '')), '');
  v_starts timestamptz;
  v_ends timestamptz;
  v_capacity integer;
  e public.calendar_events;
begin
  perform public.admin_guard();
  if p ->> 'id' is not null then
    begin
      v_id := (p ->> 'id')::uuid;
    exception when others then
      raise exception 'not_found' using errcode = '22023';
    end;
    if not exists (select 1 from public.calendar_events x where x.id = v_id) then raise exception 'not_found' using errcode = '22023'; end if;
  end if;
  if char_length(v_title) not between 1 and 80 or v_title ~ '[\x00-\x1f]' then raise exception 'bad_title' using errcode = '22023'; end if;
  if char_length(v_desc) > 2000 or v_desc ~ '[\x00-\x08\x0b-\x1f]' then raise exception 'bad_description' using errcode = '22023'; end if;
  if v_kind is null or v_kind not in ('event', 'tournament') then raise exception 'bad_kind' using errcode = '22023'; end if;
  begin
    v_starts := (p ->> 'startsAt')::timestamptz;
    v_ends := (p ->> 'endsAt')::timestamptz;
  exception when others then
    raise exception 'bad_dates' using errcode = '22023';
  end;
  if v_starts is null or v_ends is null or v_ends <= v_starts then raise exception 'bad_dates' using errcode = '22023'; end if;
  begin
    v_capacity := (p ->> 'capacity')::integer;
  exception when others then
    raise exception 'bad_capacity' using errcode = '22023';
  end;
  if (v_capacity is not null and v_capacity not between 1 and 100000) or (v_kind = 'tournament' and v_capacity is null) then
    raise exception 'bad_capacity' using errcode = '22023';
  end if;
  if v_server is not null and v_server !~ '^[A-Za-z0-9._-]{1,120}(:[0-9]{1,5})?$' then raise exception 'bad_server' using errcode = '22023'; end if;
  if v_link is not null and (char_length(v_link) > 308 or v_link !~ '^https://[^[:space:]<>"]+$') then raise exception 'bad_link' using errcode = '22023'; end if;
  if v_id is null then
    insert into public.calendar_events (title, description, kind, starts_at, ends_at, capacity, server, link, created_by)
    values (v_title, v_desc, v_kind, v_starts, v_ends, v_capacity, v_server, v_link, me) returning * into e;
  else
    update public.calendar_events x set title = v_title, description = v_desc, kind = v_kind, starts_at = v_starts, ends_at = v_ends,
      capacity = v_capacity, server = v_server, link = v_link, updated_at = now()
     where x.id = v_id returning * into e;
  end if;
  perform public.admin_log(me, null, 'event.saved', null, jsonb_build_object('eventId', e.id, 'new', v_id is null, 'title', e.title));
  return private.event_json(e, me);
end $$;

-- Borra un evento con sus anotados. Error (22023): not_found.
create or replace function public.admin_event_delete(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_title text;
begin
  perform public.admin_guard();
  delete from public.calendar_events x where x.id = p_id returning x.title into v_title;
  if v_title is null then raise exception 'not_found' using errcode = '22023'; end if;
  perform public.admin_log(me, null, 'event.deleted', null, jsonb_build_object('eventId', p_id, 'title', v_title));
  return jsonb_build_object('ok', true, 'id', p_id);
end $$;

-- ---------- 7) Permisos ----------
revoke all on function private.compete_week(timestamptz), private.ranking_cap(text), private.challenge_tally(public.challenges, uuid),
  private.challenge_finish(uuid), private.challenge_json(public.challenges, uuid), private.event_json(public.calendar_events, uuid)
  from public, anon, authenticated;
revoke all on function public.ranking_set_share(boolean), public.ranking_forget(), public.ranking_report(integer, integer, integer, integer, integer, date),
  public.ranking_friends(text, date), public.challenge_create(uuid, text, integer, integer), public.challenge_respond(uuid, boolean),
  public.challenge_cancel(uuid), public.challenge_settle(uuid), public.challenges_me(), public.events_list(timestamptz, timestamptz),
  public.events_mine(), public.event_signups(uuid), public.event_join(uuid), public.event_leave(uuid),
  public.admin_events(), public.admin_event_save(jsonb), public.admin_event_delete(uuid) from public, anon;
grant execute on function public.ranking_set_share(boolean), public.ranking_forget(), public.ranking_report(integer, integer, integer, integer, integer, date),
  public.ranking_friends(text, date), public.challenge_create(uuid, text, integer, integer), public.challenge_respond(uuid, boolean),
  public.challenge_cancel(uuid), public.challenge_settle(uuid), public.challenges_me(), public.events_list(timestamptz, timestamptz),
  public.events_mine(), public.event_signups(uuid), public.event_join(uuid), public.event_leave(uuid),
  public.admin_events(), public.admin_event_save(jsonb), public.admin_event_delete(uuid) to authenticated, service_role;
