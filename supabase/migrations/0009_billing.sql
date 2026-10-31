-- Venus Launcher · 0009 · Pagos con Stripe de los planes de Venus IA (suscripciones mensuales en USD).
-- Lo usan dos Edge Functions, siempre con la service role:
--   - "billing": checkout, portal de facturación y estado del plan (la llama el launcher con la sesión del usuario).
--   - "stripe-webhook": eventos firmados de Stripe; vuelve a leer la suscripción de Stripe y la guarda acá.
-- Necesita 0007_ai.sql (ai_plans, ai_subscriptions, ai_touch_updated_at) y los planes de 0008_ai_plans.sql
-- (go, pro, super, ultra, max, supreme): aplicala después de las dos.
-- Desde el launcher (anon / authenticated) solo se puede leer el catálogo de precios (billing_catalog) y el
-- estado de facturación propio (billing_my_state, más la fila propia de ai_subscriptions que ya permitía 0007).
-- Ninguna tabla acepta escrituras del cliente. Paso a paso de Stripe: docs/pagos.md.
-- Idempotente: se puede volver a aplicar sin perder datos.

-- ---------- Clientes de Stripe (uno por usuario) ----------

create table if not exists public.stripe_customers (
  user_id uuid primary key references auth.users (id) on delete cascade,
  customer_id text not null unique check (customer_id ~ '^cus_[A-Za-z0-9_]{1,250}$'),
  -- Modo de Stripe del cliente: los de prueba no existen en producción (y al revés).
  livemode boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.stripe_customers is 'Cliente de Stripe de cada usuario (lo crea la función billing). Solo la service role.';

-- ---------- Eventos de Stripe recibidos (idempotencia del webhook) ----------

create table if not exists public.stripe_events (
  id text primary key check (id ~ '^evt_[A-Za-z0-9_]{1,250}$'),
  type text not null check (char_length(type) between 1 and 100),
  livemode boolean not null default false,
  received_at timestamptz not null default now(),
  -- Veces que llegó sin haber terminado de procesarse (reintentos de Stripe).
  attempts integer not null default 1 check (attempts >= 1),
  -- null = todavía no se procesó bien (Stripe lo reintenta y se vuelve a procesar).
  processed_at timestamptz,
  outcome text check (char_length(outcome) <= 60)
);

create index if not exists stripe_events_received on public.stripe_events (received_at);

comment on table public.stripe_events is 'Eventos del webhook de Stripe ya recibidos (se borran solos a los 90 días). Solo la service role.';
comment on column public.stripe_events.outcome is 'Resultado: applied, stale, other_active, unknown_price, no_user, unknown_user, subscription_missing...';

-- ---------- Precios de Stripe de cada plan ----------
-- Los carga scripts/stripe-setup.js (o se cargan a mano con billing_upsert_price). Un precio de Stripe no se
-- puede cambiar: si cambia el monto se crea otro y el anterior queda con active = false. Las filas inactivas
-- NO se borran: siguen sirviendo para reconocer las suscripciones que se hicieron con ese precio.

create table if not exists public.ai_plan_prices (
  price_id text primary key check (price_id ~ '^price_[A-Za-z0-9_]{1,250}$'),
  plan_id text not null references public.ai_plans (id) on update cascade on delete restrict,
  provider text not null default 'stripe' check (provider = 'stripe'),
  lookup_key text check (lookup_key is null or lookup_key ~ '^[A-Za-z0-9_.:-]{1,200}$'),
  currency text not null default 'usd' check (currency ~ '^[a-z]{3}$'),
  -- Monto en centavos (350 = US$ 3,50).
  unit_amount integer not null check (unit_amount > 0 and unit_amount <= 100000000),
  "interval" text not null default 'month' check ("interval" = 'month'),
  livemode boolean not null default false,
  -- true = es el precio que se ofrece hoy para ese plan (uno solo por plan y modo).
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists ai_plan_prices_one_active on public.ai_plan_prices (plan_id, provider, livemode) where active;
create index if not exists ai_plan_prices_plan on public.ai_plan_prices (plan_id);

comment on table public.ai_plan_prices is 'Precio de Stripe de cada plan (price_id -> plan_id). Las filas inactivas se conservan para mapear suscripciones viejas.';
comment on column public.ai_plan_prices.active is 'Precio que se ofrece hoy (uno por plan y modo). Inactivo = ya no se vende, pero sigue mapeando suscripciones.';

-- ---------- Suscripciones: columnas de Stripe ----------
-- Siguen valiendo las reglas de 0007: da acceso con status active/trialing y current_period_end null o futuro.
-- El webhook guarda: past_due como 'active' con current_period_end = least(fin del período, falla + gracia);
-- unpaid, canceled, incomplete, incomplete_expired y paused como 'canceled'.

alter table public.ai_subscriptions
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_subscription_id text,
  add column if not exists stripe_price_id text,
  add column if not exists cancel_at_period_end boolean not null default false,
  add column if not exists grace_until timestamptz,
  add column if not exists stripe_status text,
  add column if not exists last_synced_at timestamptz;

-- Formato de las columnas nuevas, con nombre fijo: volver a aplicar la migración no los duplica.
do $$
declare
  v_checks constant text[][] := array[
    array['ai_subscriptions_stripe_customer_id_check', 'stripe_customer_id ~ ''^cus_[A-Za-z0-9_]{1,250}$'''],
    array['ai_subscriptions_stripe_subscription_id_check', 'stripe_subscription_id ~ ''^sub_[A-Za-z0-9_]{1,250}$'''],
    array['ai_subscriptions_stripe_price_id_check', 'stripe_price_id ~ ''^price_[A-Za-z0-9_]{1,250}$'''],
    array['ai_subscriptions_stripe_status_check', 'stripe_status ~ ''^[a-z_]{1,40}$''']
  ];
  i integer;
begin
  for i in 1 .. array_length(v_checks, 1) loop
    if not exists (
      select 1 from pg_catalog.pg_constraint c
       where c.conrelid = 'public.ai_subscriptions'::regclass and c.conname = v_checks[i][1]
    ) then
      execute format('alter table public.ai_subscriptions add constraint %I check (%s)', v_checks[i][1], v_checks[i][2]);
    end if;
  end loop;
end $$;

create unique index if not exists ai_subscriptions_stripe_subscription on public.ai_subscriptions (stripe_subscription_id);

comment on column public.ai_subscriptions.stripe_status is 'Estado tal cual lo informa Stripe (active, past_due, unpaid, canceled...).';
comment on column public.ai_subscriptions.grace_until is 'Con un pago fallido (past_due): hasta cuándo se mantiene el acceso.';
comment on column public.ai_subscriptions.last_synced_at is 'Momento en que se leyó la suscripción de Stripe: una lectura más vieja nunca pisa una más nueva.';

-- ---------- updated_at automático (función de 0007) ----------

drop trigger if exists stripe_customers_touch on public.stripe_customers;
create trigger stripe_customers_touch
  before update on public.stripe_customers
  for each row execute function public.ai_touch_updated_at();

drop trigger if exists ai_plan_prices_touch on public.ai_plan_prices;
create trigger ai_plan_prices_touch
  before update on public.ai_plan_prices
  for each row execute function public.ai_touch_updated_at();

-- ---------- RLS: el cliente solo lee los precios vigentes; el resto, solo la service role ----------

alter table public.stripe_customers enable row level security;
alter table public.stripe_events enable row level security;
alter table public.ai_plan_prices enable row level security;

-- stripe_customers y stripe_events no tienen políticas: nadie fuera de la service role las ve.
drop policy if exists "ai_plan_prices_select_active" on public.ai_plan_prices;
create policy "ai_plan_prices_select_active" on public.ai_plan_prices
  for select to authenticated using (active);

revoke all on public.stripe_customers, public.stripe_events, public.ai_plan_prices from anon, authenticated;
grant select on public.ai_plan_prices to authenticated;
grant all on public.stripe_customers, public.stripe_events, public.ai_plan_prices to service_role;

-- ---------- Funciones ----------
-- Todas son SECURITY DEFINER con search_path vacío y nombres calificados. Las ejecuta solo la service role,
-- salvo billing_my_state (usuarios con sesión) y billing_catalog (cualquiera: son los precios públicos).

-- Fecha en ISO 8601 UTC ("2026-11-27T12:00:00Z") o null.
create or replace function public.billing_iso(p_at timestamptz) returns text
language sql stable set search_path = '' as $$
  select to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
$$;

-- Estado de facturación de un usuario. p_livemode filtra el cliente de Stripe por modo (null = cualquiera).
-- { plan, planName, status, active, currentPeriodEnd, cancelAtPeriodEnd, graceUntil, inGrace, source,
--   stripeStatus, managedByStripe, hasCustomer, lastSyncedAt, customerId, stripeSubscriptionId }
create or replace function public.billing_state(p_user uuid, p_livemode boolean default null) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'plan', s.plan_id,
    'planName', p.name,
    'status', s.status,
    'active', coalesce(
      s.status in ('active', 'trialing')
      and (s.current_period_end is null or s.current_period_end > now())
      and p.active, false),
    'currentPeriodEnd', public.billing_iso(s.current_period_end),
    'cancelAtPeriodEnd', coalesce(s.cancel_at_period_end, false),
    'graceUntil', public.billing_iso(s.grace_until),
    'inGrace', coalesce(s.stripe_status = 'past_due' and s.grace_until > now(), false),
    'source', s.source,
    'stripeStatus', s.stripe_status,
    'managedByStripe', coalesce(s.source = 'stripe' and s.stripe_subscription_id is not null, false),
    'hasCustomer', c.customer_id is not null,
    'lastSyncedAt', public.billing_iso(s.last_synced_at),
    'customerId', c.customer_id,
    'stripeSubscriptionId', s.stripe_subscription_id
  )
    from (select p_user as id) u
    left join public.ai_subscriptions s on s.user_id = u.id
    left join public.ai_plans p on p.id = s.plan_id
    left join public.stripe_customers c on c.user_id = u.id and (p_livemode is null or c.livemode = p_livemode)
   where p_user is not null
$$;

-- Estado de facturación del usuario que llama (para la interfaz del launcher), sin los ids internos.
create or replace function public.billing_my_state() returns jsonb
language sql stable security definer set search_path = '' as $$
  select case
    when auth.uid() is null then null
    else public.billing_state(auth.uid(), null) - 'customerId' - 'stripeSubscriptionId'
  end
$$;

-- Catálogo público: planes activos con su precio vigente, ordenados. Si hay precios de producción
-- (livemode) muestra esos; si no, los de prueba. [{ id, name, sort, price: { amount, currency, interval }, livemode }]
create or replace function public.billing_catalog() returns jsonb
language sql stable security definer set search_path = '' as $$
  with modo as (
    select coalesce(bool_or(pp.livemode), false) as live
      from public.ai_plan_prices pp
      join public.ai_plans p on p.id = pp.plan_id and p.active
     where pp.active and pp.provider = 'stripe'
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id,
           'name', p.name,
           'sort', p.sort,
           'price', jsonb_build_object('amount', pp.unit_amount, 'currency', pp.currency, 'interval', pp."interval"),
           'livemode', pp.livemode
         ) order by p.sort, p.id), '[]'::jsonb)
    from public.ai_plan_prices pp
    join public.ai_plans p on p.id = pp.plan_id and p.active
   where pp.active
     and pp.provider = 'stripe'
     and pp.livemode = (select m.live from modo m)
$$;

-- Precios vigentes de un modo, con su price_id (para armar el checkout).
-- [{ plan, planName, sort, priceId, amount, currency, interval }]
create or replace function public.billing_prices(p_livemode boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'plan', p.id,
           'planName', p.name,
           'sort', p.sort,
           'priceId', pp.price_id,
           'amount', pp.unit_amount,
           'currency', pp.currency,
           'interval', pp."interval"
         ) order by p.sort, p.id), '[]'::jsonb)
    from public.ai_plan_prices pp
    join public.ai_plans p on p.id = pp.plan_id and p.active
   where pp.active
     and pp.provider = 'stripe'
     and pp.livemode = coalesce(p_livemode, false)
$$;

-- Todos los precios conocidos (también los inactivos) -> plan: { "price_...": "pro", ... }.
create or replace function public.billing_price_map() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(pp.price_id, pp.plan_id), '{}'::jsonb)
    from public.ai_plan_prices pp
   where pp.provider = 'stripe'
$$;

-- Usuario dueño de un cliente de Stripe (o null).
create or replace function public.billing_user_for_customer(p_customer text) returns uuid
language sql stable security definer set search_path = '' as $$
  select c.user_id from public.stripe_customers c where c.customer_id = p_customer
$$;

-- Guarda el cliente de Stripe de un usuario y devuelve el que quedó guardado. Si el usuario ya tenía uno del
-- mismo modo, gana el guardado salvo con p_replace (el guardado ya no existe en Stripe). Si el que tenía es del
-- otro modo (prueba / producción), se reemplaza. null si el usuario no existe.
create or replace function public.billing_link_customer(p_user uuid, p_customer text, p_livemode boolean, p_replace boolean default false)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_current public.stripe_customers%rowtype;
begin
  if p_user is null or p_customer is null or p_customer !~ '^cus_[A-Za-z0-9_]{1,250}$' then
    raise exception 'billing_link_customer: parámetros inválidos' using errcode = '22023';
  end if;
  if not exists (select 1 from auth.users u where u.id = p_user) then
    return null;
  end if;
  perform pg_advisory_xact_lock(hashtext('venus-billing:' || p_user::text));

  select c.* into v_current from public.stripe_customers c where c.user_id = p_user;
  if found then
    if v_current.customer_id = p_customer then
      return p_customer;
    end if;
    if v_current.livemode = coalesce(p_livemode, false) and not coalesce(p_replace, false) then
      return v_current.customer_id;
    end if;
  end if;

  if exists (select 1 from public.stripe_customers c where c.customer_id = p_customer and c.user_id <> p_user) then
    raise exception 'billing_link_customer: el cliente % ya es de otro usuario', p_customer using errcode = '23505';
  end if;

  insert into public.stripe_customers as c (user_id, customer_id, livemode)
  values (p_user, p_customer, coalesce(p_livemode, false))
  on conflict (user_id) do update
    set customer_id = excluded.customer_id,
        livemode = excluded.livemode;
  return p_customer;
end $$;

-- Idempotencia del webhook: registra el evento y dice si hay que procesarlo ('process') o si ya se procesó
-- ('duplicate'). Un evento que llegó antes pero no terminó (falla o reintento) se vuelve a procesar: es
-- seguro, porque el webhook siempre vuelve a leer la suscripción de Stripe.
create or replace function public.billing_begin_event(p_id text, p_type text, p_livemode boolean) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_processed timestamptz;
begin
  if p_id is null or p_id !~ '^evt_[A-Za-z0-9_]{1,250}$' or p_type is null or char_length(p_type) not between 1 and 100 then
    raise exception 'billing_begin_event: parámetros inválidos' using errcode = '22023';
  end if;

  insert into public.stripe_events (id, type, livemode)
  values (p_id, p_type, coalesce(p_livemode, false))
  on conflict (id) do nothing;
  if found then
    -- Limpieza: Stripe reintenta hasta 3 días; 90 alcanzan para revisar.
    delete from public.stripe_events e where e.received_at < now() - interval '90 days';
    return 'process';
  end if;

  select e.processed_at into v_processed from public.stripe_events e where e.id = p_id for update;
  if v_processed is not null then
    return 'duplicate';
  end if;
  update public.stripe_events e set attempts = e.attempts + 1 where e.id = p_id;
  return 'process';
end $$;

-- Marca un evento como procesado (con su resultado).
create or replace function public.billing_finish_event(p_id text, p_outcome text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update public.stripe_events e
     set processed_at = now(),
         outcome = left(coalesce(p_outcome, ''), 60)
   where e.id = p_id;
  return found;
end $$;

-- Guarda en ai_subscriptions una suscripción leída de Stripe (ya traducida por el webhook o por billing).
-- p_status: 'active' | 'trialing' | 'canceled'. p_current_period_end ya trae la gracia o la cancelación.
-- Reglas:
--   - misma suscripción: una lectura más vieja (p_synced_at < last_synced_at) no pisa una más nueva;
--   - otra suscripción (o un plan manual): si la fila actual da acceso y la nueva no, no se toca;
--   - una suscripción que estaba en la fila de otro usuario (se cambió su metadata) se le quita a ese usuario.
-- Devuelve { applied, reason, granted, switched, plan, status, currentPeriodEnd }.
create or replace function public.billing_apply_subscription(
  p_user uuid,
  p_plan text,
  p_status text,
  p_current_period_end timestamptz,
  p_grace_until timestamptz,
  p_cancel_at_period_end boolean,
  p_customer text,
  p_subscription text,
  p_price text,
  p_stripe_status text,
  p_synced_at timestamptz,
  p_livemode boolean default false
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.ai_subscriptions%rowtype;
  v_found boolean;
  v_new_grants boolean;
  v_old_grants boolean := false;
  v_switched boolean := false;
  v_synced timestamptz := coalesce(p_synced_at, now());
begin
  if p_user is null or p_plan is null or p_status is null or p_status not in ('active', 'trialing', 'canceled')
     or p_subscription is null or p_subscription !~ '^sub_[A-Za-z0-9_]{1,250}$'
     or p_customer is null or p_customer !~ '^cus_[A-Za-z0-9_]{1,250}$'
     or (p_price is not null and p_price !~ '^price_[A-Za-z0-9_]{1,250}$')
     or (p_stripe_status is not null and p_stripe_status !~ '^[a-z_]{1,40}$') then
    raise exception 'billing_apply_subscription: parámetros inválidos' using errcode = '22023';
  end if;
  -- Un plan con acceso necesita fecha de fin: null en ai_subscriptions significa "sin vencimiento".
  if p_status in ('active', 'trialing') and p_current_period_end is null then
    raise exception 'billing_apply_subscription: falta el fin del período' using errcode = '22023';
  end if;

  if not exists (select 1 from auth.users u where u.id = p_user) then
    return jsonb_build_object('applied', false, 'reason', 'unknown_user');
  end if;
  if not exists (select 1 from public.ai_plans p where p.id = p_plan) then
    return jsonb_build_object('applied', false, 'reason', 'unknown_plan');
  end if;

  -- Un solo cambio a la vez por usuario (webhook y sincronización pueden llegar juntos).
  perform pg_advisory_xact_lock(hashtext('venus-billing:' || p_user::text));

  v_new_grants := p_status in ('active', 'trialing') and p_current_period_end > now();

  select s.* into v_row from public.ai_subscriptions s where s.user_id = p_user for update;
  v_found := found;

  if v_found then
    if v_row.stripe_subscription_id is not distinct from p_subscription then
      if v_row.last_synced_at is not null and v_synced < v_row.last_synced_at then
        return jsonb_build_object('applied', false, 'reason', 'stale');
      end if;
    else
      v_old_grants := v_row.status in ('active', 'trialing')
        and (v_row.current_period_end is null or v_row.current_period_end > now())
        and exists (select 1 from public.ai_plans p where p.id = v_row.plan_id and p.active);
      if v_old_grants and not v_new_grants then
        return jsonb_build_object('applied', false, 'reason', 'other_active');
      end if;
      v_switched := v_old_grants and v_row.stripe_subscription_id is not null;
    end if;
  end if;

  -- La suscripción estaba guardada para otro usuario: deja de valer para él.
  update public.ai_subscriptions s
     set status = 'canceled',
         stripe_subscription_id = null,
         last_synced_at = v_synced
   where s.stripe_subscription_id = p_subscription
     and s.user_id <> p_user;

  insert into public.ai_subscriptions as s (
    user_id, plan_id, status, current_period_end, source, external_ref,
    stripe_customer_id, stripe_subscription_id, stripe_price_id, cancel_at_period_end,
    grace_until, stripe_status, last_synced_at
  ) values (
    p_user, p_plan, p_status, p_current_period_end, 'stripe', left(p_subscription, 200),
    p_customer, p_subscription, p_price, coalesce(p_cancel_at_period_end, false),
    p_grace_until, p_stripe_status, v_synced
  )
  on conflict (user_id) do update
    set plan_id = excluded.plan_id,
        status = excluded.status,
        current_period_end = excluded.current_period_end,
        source = excluded.source,
        external_ref = excluded.external_ref,
        stripe_customer_id = excluded.stripe_customer_id,
        stripe_subscription_id = excluded.stripe_subscription_id,
        stripe_price_id = excluded.stripe_price_id,
        cancel_at_period_end = excluded.cancel_at_period_end,
        grace_until = excluded.grace_until,
        stripe_status = excluded.stripe_status,
        last_synced_at = excluded.last_synced_at;

  -- Si el usuario todavía no tenía cliente guardado, queda este (nunca pisa uno existente).
  insert into public.stripe_customers (user_id, customer_id, livemode)
  values (p_user, p_customer, coalesce(p_livemode, false))
  on conflict do nothing;

  return jsonb_build_object(
    'applied', true,
    'reason', null,
    'granted', v_new_grants,
    'switched', v_switched,
    'plan', p_plan,
    'status', p_status,
    'currentPeriodEnd', public.billing_iso(p_current_period_end)
  );
end $$;

-- Carga el precio vigente de un plan (lo usa scripts/stripe-setup.js): lo deja activo y desactiva el
-- anterior de ese plan y modo, en una sola transacción. Devuelve { plan, priceId, active }.
create or replace function public.billing_upsert_price(
  p_plan text,
  p_price text,
  p_lookup_key text,
  p_currency text,
  p_amount integer,
  p_interval text,
  p_livemode boolean
) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if p_plan is null or p_price is null or p_price !~ '^price_[A-Za-z0-9_]{1,250}$'
     or p_amount is null or p_amount <= 0 or coalesce(p_interval, 'month') <> 'month'
     or lower(coalesce(p_currency, 'usd')) !~ '^[a-z]{3}$' then
    raise exception 'billing_upsert_price: parámetros inválidos' using errcode = '22023';
  end if;
  if not exists (select 1 from public.ai_plans p where p.id = p_plan) then
    raise exception 'billing_upsert_price: falta el plan "%" en ai_plans (aplicá 0008_ai_plans.sql)', p_plan
      using errcode = '23503';
  end if;

  -- Primero se apaga el precio vigente anterior: el índice único admite uno solo por plan y modo.
  update public.ai_plan_prices pp
     set active = false,
         lookup_key = case when pp.lookup_key = p_lookup_key then null else pp.lookup_key end
   where pp.provider = 'stripe'
     and pp.plan_id = p_plan
     and pp.livemode = coalesce(p_livemode, false)
     and pp.active
     and pp.price_id <> p_price;

  insert into public.ai_plan_prices as pp (price_id, plan_id, provider, lookup_key, currency, unit_amount, "interval", livemode, active)
  values (p_price, p_plan, 'stripe', p_lookup_key, lower(coalesce(p_currency, 'usd')), p_amount, coalesce(p_interval, 'month'),
          coalesce(p_livemode, false), true)
  on conflict (price_id) do update
    set plan_id = excluded.plan_id,
        lookup_key = excluded.lookup_key,
        currency = excluded.currency,
        unit_amount = excluded.unit_amount,
        "interval" = excluded."interval",
        livemode = excluded.livemode,
        active = true;

  return jsonb_build_object('plan', p_plan, 'priceId', p_price, 'active', true);
end $$;

-- ---------- Permisos de las funciones ----------
-- Postgres y Supabase dan EXECUTE a todos por defecto: se quita y se da solo a quien corresponde.

revoke all on function public.billing_iso(timestamptz) from public, anon, authenticated;
revoke all on function public.billing_state(uuid, boolean) from public, anon, authenticated;
revoke all on function public.billing_my_state() from public, anon;
revoke all on function public.billing_catalog() from public;
revoke all on function public.billing_prices(boolean) from public, anon, authenticated;
revoke all on function public.billing_price_map() from public, anon, authenticated;
revoke all on function public.billing_user_for_customer(text) from public, anon, authenticated;
revoke all on function public.billing_link_customer(uuid, text, boolean, boolean) from public, anon, authenticated;
revoke all on function public.billing_begin_event(text, text, boolean) from public, anon, authenticated;
revoke all on function public.billing_finish_event(text, text) from public, anon, authenticated;
revoke all on function public.billing_apply_subscription(uuid, text, text, timestamptz, timestamptz, boolean, text, text, text, text, timestamptz, boolean)
  from public, anon, authenticated;
revoke all on function public.billing_upsert_price(text, text, text, text, integer, text, boolean) from public, anon, authenticated;

grant execute on function public.billing_iso(timestamptz) to service_role;
grant execute on function public.billing_state(uuid, boolean) to service_role;
grant execute on function public.billing_my_state() to authenticated, service_role;
grant execute on function public.billing_catalog() to anon, authenticated, service_role;
grant execute on function public.billing_prices(boolean) to service_role;
grant execute on function public.billing_price_map() to service_role;
grant execute on function public.billing_user_for_customer(text) to service_role;
grant execute on function public.billing_link_customer(uuid, text, boolean, boolean) to service_role;
grant execute on function public.billing_begin_event(text, text, boolean) to service_role;
grant execute on function public.billing_finish_event(text, text) to service_role;
grant execute on function public.billing_apply_subscription(uuid, text, text, timestamptz, timestamptz, boolean, text, text, text, text, timestamptz, boolean)
  to service_role;
grant execute on function public.billing_upsert_price(text, text, text, text, integer, text, boolean) to service_role;
