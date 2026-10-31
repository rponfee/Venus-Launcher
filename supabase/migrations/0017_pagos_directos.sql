-- 0017_pagos_directos.sql · Venus 1.0.12
-- Los planes se pagan directo desde el launcher con Mercado Pago (pesos) o PayPal (dólares) y se activan solos
-- cuando el proveedor confirma el pago. Soporte queda para consultas: los tickets ya no piden ni activan planes.
-- Aplicar después de 0016. Idempotente.
--
-- Piezas:
--   payment_settings    configuración sin secretos (proveedores activos, cotización, redondeo e impuestos)
--   vault               las claves de Mercado Pago y PayPal (cifradas; solo las leen las Edge Functions)
--   payment_orders      cada intento de pago; el estado SIEMPRE se confirma consultando al proveedor
--   ai_paid_periods     ahora puede salir de un ticket viejo o de una orden pagada
-- El saldo de IA usa el mismo circuito que 0016 (ai_subscriptions.source = 'support' = saldo prepago).

-- ---------- 1) Precios y saldos nuevos ----------
update public.ai_plans set price_usd=4,  monthly_budget_usd=2   where id='basic';
update public.ai_plans set price_usd=8,  monthly_budget_usd=4.5 where id='go';
update public.ai_plans set price_usd=15, monthly_budget_usd=8.5 where id='pro';
update public.ai_plans set price_usd=35, monthly_budget_usd=20  where id='max';
comment on column public.ai_plans.price_usd is 'Precio de lista en USD por pago único (PayPal cobra esto; Mercado Pago lo pasa a pesos con payment_settings).';

-- ---------- 2) Configuración (sin secretos) ----------
create or replace function private.payments_valid_taxes(p jsonb) returns boolean
language sql immutable set search_path='' as $$
 select jsonb_typeof(p)='object'
   and (select bool_and(k in ('ARS','USD')) from jsonb_object_keys(p) k) is not false
   and coalesce((select bool_and(
         jsonb_typeof(v)='array' and jsonb_array_length(v)<=5
         and coalesce((select bool_and(
               jsonb_typeof(e)='object'
               and coalesce(e->>'id','') ~ '^[a-z0-9_-]{1,24}$'
               and char_length(coalesce(e->>'label','')) between 1 and 40
               and jsonb_typeof(e->'rate')='number' and (e->>'rate')::numeric between 0 and 100
               and coalesce(e->>'mode','') in ('included','added','estimate'))
             from jsonb_array_elements(v) e), true))
       from jsonb_each(p) x(k,v)), true)
$$;

create table if not exists public.payment_settings (
 id boolean primary key default true check (id),
 mercado_pago_enabled boolean not null default false,
 paypal_enabled boolean not null default false,
 paypal_env text not null default 'sandbox' check (paypal_env in ('sandbox','live')),
 ars_per_usd numeric(12,2) check (ars_per_usd is null or ars_per_usd between 1 and 100000000),
 ars_rounding integer not null default 10 check (ars_rounding in (1,10,50,100,500,1000)),
 rate_updated_at timestamptz,
 taxes jsonb not null default '{"ARS":[{"id":"iva","label":"IVA","rate":21,"mode":"included"}],"USD":[{"id":"percepcion","label":"Percepción RG 5617","rate":30,"mode":"estimate"}]}'::jsonb
   check (private.payments_valid_taxes(taxes)),
 statement_descriptor text not null default 'VENUS LAUNCHER' check (statement_descriptor ~ '^[A-Za-z0-9 .-]{3,22}$'),
 updated_at timestamptz not null default now(),
 updated_by uuid references auth.users(id) on delete set null
);
insert into public.payment_settings(id) values (true) on conflict (id) do nothing;
alter table public.payment_settings enable row level security;
revoke all on public.payment_settings from public, anon, authenticated;
grant all on public.payment_settings to service_role;
comment on table public.payment_settings is 'Una sola fila. Las claves de los proveedores NO van acá: están en vault (venus_pay_*).';

-- Nombres de los secretos en vault.
create or replace function private.payments_secret_name(p_key text) returns text
language sql immutable set search_path='' as $$
 select case p_key
   when 'mpAccessToken' then 'venus_pay_mp_access_token'
   when 'mpWebhookSecret' then 'venus_pay_mp_webhook_secret'
   when 'paypalClientId' then 'venus_pay_paypal_client_id'
   when 'paypalSecret' then 'venus_pay_paypal_secret'
   when 'paypalWebhookId' then 'venus_pay_paypal_webhook_id'
 end
$$;

create or replace function private.payments_secret(p_key text) returns text
language sql stable security definer set search_path='' as $$
 select nullif(d.decrypted_secret,'') from vault.decrypted_secrets d where d.name=private.payments_secret_name(p_key) limit 1
$$;

-- Últimos 4 caracteres para mostrar en el panel (nunca la clave completa).
create or replace function private.payments_hint(p_value text) returns text
language sql immutable set search_path='' as $$
 select case when p_value is null then null else '…'||right(p_value,4) end
$$;

-- ---------- 3) Órdenes de pago ----------
create table if not exists public.payment_orders (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 plan_id text not null references public.ai_plans(id),
 plan_name text not null,
 provider text not null check (provider in ('mercado_pago','paypal')),
 currency text not null check (currency in ('ARS','USD')),
 amount numeric(14,2) not null check (amount>0),
 price_usd numeric(8,2) not null check (price_usd>0),
 budget_usd numeric(12,6) not null check (budget_usd>=0),
 quote jsonb not null,
 live boolean not null default false,
 status text not null default 'pending' check (status in ('pending','paid','failed','cancelled','expired','refunded')),
 provider_order_id text check (char_length(provider_order_id)<=200),
 provider_payment_id text check (char_length(provider_payment_id)<=200),
 provider_status text check (char_length(provider_status)<=60),
 checkout_url text check (char_length(checkout_url)<=2000),
 period_id uuid references public.ai_paid_periods(id),
 carried_usd numeric(12,6) not null default 0 check (carried_usd>=0),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 paid_at timestamptz,
 checked_at timestamptz,
 expires_at timestamptz not null default now()+interval '2 days',
 constraint payment_orders_paid_evidence check (status not in ('paid','refunded') or (paid_at is not null and provider_payment_id is not null))
);
create unique index if not exists payment_orders_payment_once on public.payment_orders(provider, provider_payment_id) where provider_payment_id is not null;
create unique index if not exists payment_orders_provider_order on public.payment_orders(provider, provider_order_id) where provider_order_id is not null;
create index if not exists payment_orders_user on public.payment_orders(user_id, created_at desc);
create index if not exists payment_orders_recent on public.payment_orders(created_at desc);
alter table public.payment_orders enable row level security;
revoke all on public.payment_orders from public, anon, authenticated;
grant select on public.payment_orders to authenticated;
grant all on public.payment_orders to service_role;
drop policy if exists payment_orders_read on public.payment_orders;
create policy payment_orders_read on public.payment_orders for select to authenticated using (user_id=(select auth.uid()));

-- Un período pagado sale de un ticket (historial de 1.0.4-1.0.11) o de una orden.
alter table public.ai_paid_periods alter column ticket_id drop not null;
alter table public.ai_paid_periods add column if not exists order_id uuid unique references public.payment_orders(id);
alter table public.ai_paid_periods drop constraint if exists ai_paid_periods_one_source;
alter table public.ai_paid_periods add constraint ai_paid_periods_one_source check (num_nonnulls(ticket_id, order_id)=1);
comment on column public.ai_subscriptions.source is 'support = saldo prepago (por ticket histórico o por orden de pago); admin/stripe/manual = otros orígenes.';

create or replace function private.payments_order_json(o public.payment_orders) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('id',o.id,'userId',o.user_id,'plan',o.plan_id,'planName',o.plan_name,'provider',o.provider,
   'currency',o.currency,'amount',o.amount,'priceUsd',o.price_usd,'budgetUsd',o.budget_usd,'quote',o.quote,'live',o.live,
   'status',case when o.status='pending' and o.expires_at<=now() then 'expired' else o.status end,
   'providerStatus',o.provider_status,'providerOrderId',o.provider_order_id,'checkoutUrl',o.checkout_url,
   'carriedUsd',o.carried_usd,'createdAt',public.ai_iso(o.created_at),'updatedAt',public.ai_iso(o.updated_at),
   'paidAt',public.ai_iso(o.paid_at),'expiresAt',public.ai_iso(o.expires_at))
$$;

-- ---------- 4) Precio de un plan con un proveedor ----------
-- included: el impuesto ya está dentro del precio (se informa cuánto es; Ley 27.743: precio final y "precio sin
-- impuestos"). added: se suma y se cobra. estimate: lo suma el banco del comprador (por ejemplo la percepción de
-- RG 5617 con tarjeta argentina en pesos): se informa, pero no lo cobra Venus.
create or replace function private.payments_quote(p_plan text, p_provider text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare s public.payment_settings%rowtype; p public.ai_plans%rowtype; v_cur text; v_sub numeric; v_total numeric;
 v_taxes jsonb:='[]'::jsonb; t jsonb; v_rate numeric; v_amt numeric; v_included numeric:=0; v_estimate numeric:=0;
begin
 select * into s from public.payment_settings where id;
 select * into p from public.ai_plans where id=p_plan and active and id in ('basic','go','pro','max');
 if not found or p.price_usd is null or p.price_usd<=0 then return null; end if;
 if p_provider='mercado_pago' then
   if s.ars_per_usd is null then return null; end if;
   v_cur:='ARS';
   v_sub:=ceil(p.price_usd*s.ars_per_usd/s.ars_rounding)*s.ars_rounding;
 elsif p_provider='paypal' then
   v_cur:='USD';
   v_sub:=p.price_usd;
 else
   return null;
 end if;
 v_total:=v_sub;
 for t in select e from jsonb_array_elements(coalesce(s.taxes->v_cur,'[]'::jsonb)) e loop
   v_rate:=(t->>'rate')::numeric;
   if t->>'mode'='added' then
     v_amt:=round(v_sub*v_rate/100,2);
     v_total:=v_total+v_amt;
   elsif t->>'mode'='estimate' then
     v_amt:=round(v_sub*v_rate/100,2);
     v_estimate:=v_estimate+v_amt;
   else
     v_amt:=round(v_sub-v_sub/(1+v_rate/100),2);
     v_included:=v_included+v_amt;
   end if;
   v_taxes:=v_taxes||jsonb_build_array(jsonb_build_object('id',t->>'id','label',t->>'label','rate',v_rate,'mode',t->>'mode','amount',v_amt));
 end loop;
 return jsonb_build_object('provider',p_provider,'currency',v_cur,'subtotal',v_sub,'taxes',v_taxes,'total',round(v_total,2),
   'net',round(v_sub-v_included,2),'estimatedTotal',case when v_estimate>0 then round(v_total+v_estimate,2) end,
   'priceUsd',p.price_usd,'budgetUsd',p.monthly_budget_usd,'plan',p.id,'planName',p.name,
   'arsPerUsd',case when v_cur='ARS' then s.ars_per_usd end);
end $$;

create or replace function private.payments_provider_ready(p_provider text) returns boolean
language sql stable security definer set search_path='' as $$
 select case p_provider
   when 'mercado_pago' then s.mercado_pago_enabled and s.ars_per_usd is not null and private.payments_secret('mpAccessToken') is not null
   when 'paypal' then s.paypal_enabled and private.payments_secret('paypalClientId') is not null and private.payments_secret('paypalSecret') is not null
   else false end
 from public.payment_settings s where s.id
$$;

-- Catálogo público: planes, precio en pesos (Mercado Pago) y en dólares (PayPal), con los impuestos.
create or replace function public.payments_catalog() returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
   'providers', jsonb_build_object(
     'mercado_pago', jsonb_build_object('enabled', private.payments_provider_ready('mercado_pago'), 'currency','ARS'),
     'paypal', jsonb_build_object('enabled', private.payments_provider_ready('paypal'), 'currency','USD')),
   'arsPerUsd', s.ars_per_usd, 'rateUpdatedAt', public.ai_iso(s.rate_updated_at),
   'plans', coalesce((select jsonb_agg(c.plan || jsonb_build_object('prices', jsonb_strip_nulls(jsonb_build_object(
       'mercado_pago', private.payments_quote(c.plan->>'id','mercado_pago'),
       'paypal', private.payments_quote(c.plan->>'id','paypal')))) order by c.ord)
     from jsonb_array_elements(public.ai_catalog()) with ordinality c(plan, ord)), '[]'::jsonb))
 from public.payment_settings s where s.id
$$;
revoke all on function public.payments_catalog() from public;
grant execute on function public.payments_catalog() to anon, authenticated, service_role;

-- ---------- 5) Órdenes: crear, enlazar con el proveedor y leer (solo Edge Functions) ----------
create or replace function public.payments_create_order(p_user uuid, p_plan text, p_provider text, p_live boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_quote jsonb; v_order public.payment_orders%rowtype;
begin
 if p_user is null or not exists (select 1 from auth.users u where u.id=p_user and u.deleted_at is null
     and not coalesce(u.is_anonymous,false) and (u.banned_until is null or u.banned_until<=now())) then
   raise exception 'Iniciá sesión con tu cuenta de Venus.' using errcode='42501';
 end if;
 if not private.payments_provider_ready(p_provider) then
   raise exception 'provider_disabled' using errcode='22023';
 end if;
 v_quote:=private.payments_quote(p_plan, p_provider);
 if v_quote is null then raise exception 'unknown_plan' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user::text, 817));
 -- Doble clic o reintento: la misma orden pendiente, si el precio no cambió.
 select * into v_order from public.payment_orders o
  where o.user_id=p_user and o.plan_id=p_plan and o.provider=p_provider and o.status='pending'
    and o.live=coalesce(p_live,false) and o.amount=(v_quote->>'total')::numeric and o.checkout_url is not null
    and o.created_at>now()-interval '30 minutes' and o.expires_at>now()
  order by o.created_at desc limit 1;
 if found then return private.payments_order_json(v_order)||jsonb_build_object('reused',true); end if;
 if (select count(*) from public.payment_orders o where o.user_id=p_user and o.created_at>now()-interval '1 hour')>=8
   or (select count(*) from public.payment_orders o where o.user_id=p_user and o.created_at>now()-interval '1 day')>=25 then
   raise exception 'too_many_orders' using errcode='54000';
 end if;
 insert into public.payment_orders(user_id,plan_id,plan_name,provider,currency,amount,price_usd,budget_usd,quote,live)
 values (p_user, p_plan, v_quote->>'planName', p_provider, v_quote->>'currency', (v_quote->>'total')::numeric,
   (v_quote->>'priceUsd')::numeric, (v_quote->>'budgetUsd')::numeric, v_quote, coalesce(p_live,false))
 returning * into v_order;
 return private.payments_order_json(v_order)||jsonb_build_object('reused',false);
end $$;

create or replace function public.payments_attach_checkout(p_order uuid, p_provider_order_id text, p_url text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_order public.payment_orders%rowtype;
begin
 if p_url is null or p_url !~ '^https://[^\s]+$' or char_length(p_url)>2000
   or p_provider_order_id is null or char_length(p_provider_order_id) not between 1 and 200 then
   raise exception 'bad_checkout' using errcode='22023';
 end if;
 update public.payment_orders set provider_order_id=p_provider_order_id, checkout_url=p_url, updated_at=now()
  where id=p_order and status='pending' returning * into v_order;
 if not found then raise exception 'order_not_found' using errcode='P0002'; end if;
 return private.payments_order_json(v_order);
end $$;

-- Orden completa (para la Edge Function). p_user: si viene, la orden tiene que ser de ese usuario.
create or replace function public.payments_get_order(p_order uuid, p_user uuid default null) returns jsonb
language sql stable security definer set search_path='' as $$
 select private.payments_order_json(o) from public.payment_orders o
  where o.id=p_order and (p_user is null or o.user_id=p_user)
$$;

create or replace function public.payments_find_order(p_provider text, p_provider_order_id text) returns jsonb
language sql stable security definer set search_path='' as $$
 select private.payments_order_json(o) from public.payment_orders o
  where o.provider=p_provider and o.provider_order_id=p_provider_order_id
$$;

create or replace function public.payments_touch(p_order uuid, p_provider_status text default null) returns void
language sql security definer set search_path='' as $$
 update public.payment_orders set checked_at=now(),
   provider_status=coalesce(left(p_provider_status,60), provider_status), updated_at=now() where id=p_order
$$;

-- ---------- 6) Acreditar un pago confirmado por el proveedor ----------
-- Idempotente. El monto y la moneda tienen que coincidir con la orden. Si quedaba saldo de un pago anterior,
-- se suma al nuevo (lo ya pagado no se pierde).
create or replace function public.payments_mark_paid(p_order uuid, p_payment_id text, p_amount numeric, p_currency text,
  p_live boolean, p_provider_status text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_order public.payment_orders%rowtype; v_plan public.ai_plans%rowtype; v_prev public.ai_paid_periods%rowtype;
 v_carry numeric:=0; v_period uuid; v_reserved numeric;
begin
 if p_payment_id is null or char_length(p_payment_id) not between 1 and 200 then
   raise exception 'bad_payment' using errcode='22023';
 end if;
 select * into v_order from public.payment_orders where id=p_order for update;
 if not found then return jsonb_build_object('applied',false,'reason','order_not_found'); end if;
 if v_order.status='paid' then
   return jsonb_build_object('applied',false,'reason','already_paid','order',private.payments_order_json(v_order));
 end if;
 if v_order.status='refunded' then
   return jsonb_build_object('applied',false,'reason','refunded','order',private.payments_order_json(v_order));
 end if;
 if upper(coalesce(p_currency,''))<>v_order.currency or p_amount is null or p_amount<v_order.amount-0.01 then
   update public.payment_orders set provider_status='amount_mismatch', checked_at=now(), updated_at=now() where id=p_order;
   perform public.admin_log(null,null,'payments.amountMismatch',v_order.user_id,jsonb_build_object('orderId',v_order.id,
     'expected',v_order.amount,'currency',v_order.currency,'received',p_amount,'receivedCurrency',p_currency,'paymentId',p_payment_id));
   return jsonb_build_object('applied',false,'reason','amount_mismatch');
 end if;
 select * into v_plan from public.ai_plans where id=v_order.plan_id;
 perform pg_advisory_xact_lock(hashtextextended(v_order.user_id::text,816));
 -- Saldo que quedaba del período vigente (menos lo reservado por preguntas en curso).
 select pp.* into v_prev from public.ai_subscriptions s join public.ai_paid_periods pp on pp.id=s.support_period_id
  where s.user_id=v_order.user_id and s.source='support' and (pp.ends_at is null or pp.ends_at>now());
 if found then
   select coalesce(sum(r.reserved_usd),0) into v_reserved from public.ai_call_reservations r
    where r.period_id=v_prev.id and r.status='reserved';
   v_carry:=greatest(0, v_prev.budget_usd-v_prev.spent_usd-v_reserved);
   if public.ai_effective_plan(v_order.user_id) is null then v_carry:=0; end if;
 end if;
 insert into public.ai_paid_periods(user_id,order_id,plan_id,starts_at,ends_at,budget_usd)
 values (v_order.user_id, v_order.id, v_order.plan_id, now(), null, least(v_order.budget_usd+v_carry, 9999))
 returning id into v_period;
 insert into public.ai_subscriptions(user_id,plan_id,status,current_period_end,source,external_ref,support_period_id)
 values (v_order.user_id, v_order.plan_id, 'active', null, 'support', 'order:'||v_order.id, v_period)
 on conflict (user_id) do update set plan_id=excluded.plan_id, status='active', current_period_end=null,
   source='support', external_ref=excluded.external_ref, support_period_id=v_period,
   stripe_customer_id=null, stripe_subscription_id=null, stripe_price_id=null, stripe_status=null,
   cancel_at_period_end=false, grace_until=null, budget_cap_usd=null, budget_cap_until=null, updated_at=now();
 update public.payment_orders set status='paid', paid_at=now(), provider_payment_id=p_payment_id,
   provider_status=coalesce(left(p_provider_status,60),'paid'), live=coalesce(p_live,live), period_id=v_period,
   carried_usd=v_carry, checked_at=now(), updated_at=now()
  where id=p_order returning * into v_order;
 perform public.admin_log(null,null,'payments.paid',v_order.user_id,jsonb_build_object('orderId',v_order.id,'plan',v_order.plan_id,
   'provider',v_order.provider,'amount',v_order.amount,'currency',v_order.currency,'priceUsd',v_order.price_usd,
   'live',v_order.live,'carriedUsd',v_carry,'periodId',v_period));
 return jsonb_build_object('applied',true,'order',private.payments_order_json(v_order));
end $$;

-- Pago rechazado, cancelado, vencido o devuelto. Una devolución corta el saldo que dio esa orden.
create or replace function public.payments_mark_status(p_order uuid, p_status text, p_provider_status text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_order public.payment_orders%rowtype;
begin
 if p_status not in ('failed','cancelled','expired','refunded') then raise exception 'bad_status' using errcode='22023'; end if;
 select * into v_order from public.payment_orders where id=p_order for update;
 if not found then return jsonb_build_object('applied',false,'reason','order_not_found'); end if;
 if p_status='refunded' then
   if v_order.status<>'paid' then return jsonb_build_object('applied',false,'reason','not_paid'); end if;
   perform pg_advisory_xact_lock(hashtextextended(v_order.user_id::text,816));
   update public.ai_paid_periods set ends_at=greatest(now(), starts_at+interval '1 second')
    where id=v_order.period_id and (ends_at is null or ends_at>now());
   update public.payment_orders set status='refunded', provider_status=coalesce(left(p_provider_status,60),'refunded'),
     checked_at=now(), updated_at=now() where id=p_order returning * into v_order;
   perform public.admin_log(null,null,'payments.refunded',v_order.user_id,jsonb_build_object('orderId',v_order.id,
     'provider',v_order.provider,'amount',v_order.amount,'currency',v_order.currency));
 elsif v_order.status='pending' then
   update public.payment_orders set status=p_status, provider_status=coalesce(left(p_provider_status,60),p_status),
     checked_at=now(), updated_at=now() where id=p_order returning * into v_order;
 else
   return jsonb_build_object('applied',false,'reason','not_pending','order',private.payments_order_json(v_order));
 end if;
 return jsonb_build_object('applied',true,'order',private.payments_order_json(v_order));
end $$;

-- Pagos del usuario con sesión (para el historial en Planes).
create or replace function public.payments_my_orders() returns jsonb
language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(private.payments_order_json(o) - 'checkoutUrl' - 'userId' - 'quote' - 'providerOrderId' order by o.created_at desc),'[]'::jsonb)
 from (select * from public.payment_orders where user_id=auth.uid() order by created_at desc limit 20) o
$$;

-- ---------- 7) Configuración desde el panel de admin (por la Edge Function "payments") ----------
create or replace function public.payments_admin_get() returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
   'mercadoPago', jsonb_build_object('enabled',s.mercado_pago_enabled,'ready',private.payments_provider_ready('mercado_pago'),
     'tokenHint',private.payments_hint(private.payments_secret('mpAccessToken')),
     -- Las credenciales de prueba de Checkout Pro también empiezan con APP_USR-: el modo real lo dice "Probar conexión".
     'tokenKind',case when private.payments_secret('mpAccessToken') like 'TEST-%' then 'test'
                      when private.payments_secret('mpAccessToken') like 'APP_USR-%' then 'app' end,
     'webhookSecret',private.payments_secret('mpWebhookSecret') is not null),
   'paypal', jsonb_build_object('enabled',s.paypal_enabled,'ready',private.payments_provider_ready('paypal'),'env',s.paypal_env,
     'clientIdHint',private.payments_hint(private.payments_secret('paypalClientId')),
     'secret',private.payments_secret('paypalSecret') is not null,
     'webhookId',private.payments_secret('paypalWebhookId') is not null),
   'arsPerUsd',s.ars_per_usd,'arsRounding',s.ars_rounding,'rateUpdatedAt',public.ai_iso(s.rate_updated_at),
   'taxes',s.taxes,'statementDescriptor',s.statement_descriptor,
   'updatedAt',public.ai_iso(s.updated_at),'updatedBy',(select u.email from auth.users u where u.id=s.updated_by))
 from public.payment_settings s where s.id
$$;

-- Secretos en crudo: solo para las Edge Functions.
create or replace function public.payments_secrets() returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('mpAccessToken',private.payments_secret('mpAccessToken'),
   'mpWebhookSecret',private.payments_secret('mpWebhookSecret'),
   'paypalClientId',private.payments_secret('paypalClientId'),'paypalSecret',private.payments_secret('paypalSecret'),
   'paypalWebhookId',private.payments_secret('paypalWebhookId'),'paypalEnv',s.paypal_env,
   'statementDescriptor',s.statement_descriptor)
 from public.payment_settings s where s.id
$$;

-- p_settings: { mercadoPagoEnabled?, paypalEnabled?, paypalEnv?, arsPerUsd?, arsRounding?, taxes?, statementDescriptor? }
-- p_secrets: { mpAccessToken?, mpWebhookSecret?, paypalClientId?, paypalSecret?, paypalWebhookId? } ("" borra).
create or replace function public.payments_admin_save(p_user uuid, p_settings jsonb, p_secrets jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_email text; k text; v text; v_name text; v_id uuid; v_changed text[]:='{}'; v_pattern text;
begin
 if not public.admin_is_admin_user(p_user) then raise exception 'admin_only' using errcode='42501'; end if;
 select email into v_email from auth.users where id=p_user;
 p_settings:=coalesce(p_settings,'{}'::jsonb); p_secrets:=coalesce(p_secrets,'{}'::jsonb);
 if jsonb_typeof(p_settings)<>'object' or jsonb_typeof(p_secrets)<>'object' then raise exception 'bad_request' using errcode='22023'; end if;
 for k, v in select key, value from jsonb_each_text(p_secrets) loop
   v_name:=private.payments_secret_name(k);
   if v_name is null then raise exception 'bad_secret:%', k using errcode='22023'; end if;
   v:=btrim(coalesce(v,''));
   v_pattern:=case k when 'mpAccessToken' then '^(APP_USR|TEST)-[A-Za-z0-9-]{20,300}$'
     when 'mpWebhookSecret' then '^[A-Za-z0-9]{16,200}$'
     when 'paypalClientId' then '^[A-Za-z0-9_-]{20,200}$'
     when 'paypalSecret' then '^[A-Za-z0-9_-]{20,200}$'
     when 'paypalWebhookId' then '^[A-Z0-9]{8,64}$' end;
   if v<>'' and v !~ v_pattern then raise exception 'bad_secret:%', k using errcode='22023'; end if;
   select id into v_id from vault.secrets where name=v_name;
   if v='' then
     if v_id is not null then delete from vault.secrets where id=v_id; end if;
   elsif v_id is null then
     perform vault.create_secret(v, v_name, 'Venus Launcher: '||k);
   else
     perform vault.update_secret(v_id, v, v_name, 'Venus Launcher: '||k);
   end if;
   v_changed:=v_changed||k;
 end loop;
 update public.payment_settings s set
   mercado_pago_enabled=coalesce((p_settings->>'mercadoPagoEnabled')::boolean, s.mercado_pago_enabled),
   paypal_enabled=coalesce((p_settings->>'paypalEnabled')::boolean, s.paypal_enabled),
   paypal_env=coalesce(p_settings->>'paypalEnv', s.paypal_env),
   ars_per_usd=case when p_settings ? 'arsPerUsd' then (p_settings->>'arsPerUsd')::numeric else s.ars_per_usd end,
   rate_updated_at=case when p_settings ? 'arsPerUsd' and (p_settings->>'arsPerUsd')::numeric is distinct from s.ars_per_usd then now() else s.rate_updated_at end,
   ars_rounding=coalesce((p_settings->>'arsRounding')::integer, s.ars_rounding),
   taxes=coalesce(p_settings->'taxes', s.taxes),
   statement_descriptor=coalesce(p_settings->>'statementDescriptor', s.statement_descriptor),
   updated_at=now(), updated_by=p_user
  where s.id;
 perform public.admin_log(p_user, v_email, 'payments.configUpdated', null,
   jsonb_build_object('settings',(select coalesce(jsonb_agg(x),'[]'::jsonb) from jsonb_object_keys(p_settings) x),'secrets',to_jsonb(v_changed)));
 return public.payments_admin_get();
end $$;

-- Últimas órdenes para el panel (sin datos de pago del comprador: Mercado Pago y PayPal los guardan ellos).
create or replace function public.payments_admin_orders(p_limit integer default 50) returns jsonb
language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(private.payments_order_json(o) - 'checkoutUrl' - 'quote' || jsonb_build_object('email',u.email) order by o.created_at desc),'[]'::jsonb)
 from (select * from public.payment_orders order by created_at desc limit least(greatest(coalesce(p_limit,50),1),200)) o
 left join auth.users u on u.id=o.user_id
$$;

revoke all on function private.payments_valid_taxes(jsonb), private.payments_secret_name(text), private.payments_secret(text),
  private.payments_hint(text), private.payments_order_json(public.payment_orders), private.payments_quote(text,text),
  private.payments_provider_ready(text) from public, anon, authenticated;
revoke all on function public.payments_create_order(uuid,text,text,boolean), public.payments_attach_checkout(uuid,text,text),
  public.payments_get_order(uuid,uuid), public.payments_find_order(text,text), public.payments_touch(uuid,text),
  public.payments_mark_paid(uuid,text,numeric,text,boolean,text), public.payments_mark_status(uuid,text,text),
  public.payments_admin_get(), public.payments_secrets(), public.payments_admin_save(uuid,jsonb,jsonb),
  public.payments_admin_orders(integer), public.payments_my_orders() from public, anon, authenticated;
grant execute on function public.payments_create_order(uuid,text,text,boolean), public.payments_attach_checkout(uuid,text,text),
  public.payments_get_order(uuid,uuid), public.payments_find_order(text,text), public.payments_touch(uuid,text),
  public.payments_mark_paid(uuid,text,numeric,text,boolean,text), public.payments_mark_status(uuid,text,text),
  public.payments_admin_get(), public.payments_secrets(), public.payments_admin_save(uuid,jsonb,jsonb),
  public.payments_admin_orders(integer) to service_role;
grant execute on function public.payments_my_orders() to authenticated, service_role;

-- ---------- 8) El plan vigente sale de un ticket pagado (historial) o de una orden pagada ----------
create or replace function public.ai_effective_plan(p_user uuid) returns text
language sql stable security definer set search_path='' as $$
 select s.plan_id from public.ai_subscriptions s
 join public.ai_plans p on p.id=s.plan_id and p.active and p.id in ('basic','go','pro','max')
 join public.ai_paid_periods allocation on allocation.id=s.support_period_id
   and allocation.user_id=s.user_id and allocation.plan_id=s.plan_id
 where s.user_id=p_user and s.source='support' and s.status='active'
   and (s.current_period_end is null or s.current_period_end>now())
   and (allocation.ends_at is null or allocation.ends_at>now())
   and (exists (select 1 from public.support_tickets ticket where ticket.id=allocation.ticket_id
          and ticket.user_id=s.user_id and ticket.plan_id=s.plan_id and ticket.status='paid')
     or exists (select 1 from public.payment_orders o where o.id=allocation.order_id
          and o.user_id=s.user_id and o.plan_id=s.plan_id and o.status='paid'))
$$;

-- ---------- 9) Soporte para consultas (sin planes) ----------
alter table public.support_tickets add column if not exists subject text check (subject is null or char_length(subject) between 3 and 120);
alter table public.support_tickets add column if not exists category text not null default 'general'
  check (category in ('general','account','payments','assistant','bug','other'));
alter table public.support_tickets alter column name drop not null;
alter table public.support_tickets alter column plan_id drop not null;
alter table public.support_tickets alter column plan_name drop not null;
alter table public.support_tickets alter column price_usd drop not null;
alter table public.support_tickets alter column payment_method drop not null;
drop index if exists public.support_one_open_ticket;

create or replace function private.support_ticket_json(t public.support_tickets) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('id',t.id,'userId',t.user_id,'name',t.name,'subject',coalesce(t.subject,
     case when t.plan_name is not null then 'Plan '||t.plan_name end),'category',t.category,'plan',t.plan_id,
   'planName',t.plan_name,'priceUsd',t.price_usd,'paymentMethod',t.payment_method,'status',t.status,
   'createdAt',public.ai_iso(t.created_at),'updatedAt',public.ai_iso(t.updated_at),
   'closedAt',public.ai_iso(t.closed_at),'activatedUntil',public.ai_iso(t.activated_until))
$$;

create or replace function public.support_open_ticket(p_subject text, p_category text, p_message text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_user uuid:=private.support_user(); v_ticket public.support_tickets%rowtype;
begin
 if p_subject is null or char_length(btrim(p_subject)) not between 3 and 120
   or coalesce(p_category,'') not in ('general','account','payments','assistant','bug','other')
   or p_message is null or char_length(btrim(p_message)) not between 1 and 4000 then
   raise exception 'Revisá el asunto, el tema y el mensaje.' using errcode='22023';
 end if;
 perform pg_advisory_xact_lock(hashtextextended(v_user::text,815));
 if (select count(*) from public.support_tickets where user_id=v_user and status in ('open','in_progress'))>=3 then
   raise exception 'Ya tenés 3 consultas abiertas. Seguí por una de esas.' using errcode='23505';
 end if;
 if (select count(*) from public.support_tickets where user_id=v_user and created_at>now()-interval '1 day')>=5 then
   raise exception 'Llegaste al límite de consultas de hoy.' using errcode='54000';
 end if;
 insert into public.support_tickets(user_id,subject,category) values (v_user, btrim(p_subject), p_category) returning * into v_ticket;
 insert into public.support_messages(ticket_id,author_id,is_admin,body) values (v_ticket.id, v_user, false, btrim(p_message));
 return private.support_ticket_json(v_ticket);
end $$;
revoke all on function public.support_open_ticket(text,text,text) from public, anon;
grant execute on function public.support_open_ticket(text,text,text) to authenticated;

-- Las versiones viejas del launcher pedían planes por ticket: ahora se compran desde Planes.
create or replace function public.support_create_ticket(p_plan text,p_name text,p_payment_method text,p_message text default '') returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 perform private.support_user();
 raise exception 'Los planes ahora se pagan desde Planes con Mercado Pago o PayPal. Actualizá Venus Launcher.' using errcode='22023';
end $$;

-- Cerrar un ticket. Ya no se confirman pagos por ticket: se acreditan solos al pagar desde Planes.
create or replace function public.support_resolve_ticket(p_ticket uuid,p_confirm_payment boolean,p_note text default '') returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_admin uuid:=private.support_user(); v_ticket public.support_tickets%rowtype; v_email text;
begin
 if not private.support_is_staff(v_admin) then raise exception 'Solo el equipo de soporte.' using errcode='42501'; end if;
 if coalesce(p_confirm_payment,false) then
   raise exception 'Los pagos ya no se confirman por ticket: se acreditan solos al pagar desde Planes.' using errcode='22023';
 end if;
 if char_length(coalesce(p_note,''))>2000 then raise exception 'Revisá la resolución del ticket.' using errcode='22023'; end if;
 select * into v_ticket from public.support_tickets where id=p_ticket for update;
 if not found then raise exception 'Ticket no disponible.' using errcode='P0002'; end if;
 if v_ticket.status in ('closed','paid') then return private.support_ticket_json(v_ticket); end if;
 update public.support_tickets set status='closed', closed_at=now(), closed_by=v_admin, updated_at=now()
  where id=p_ticket returning * into v_ticket;
 insert into public.support_messages(ticket_id,author_id,is_admin,body)
 values (p_ticket, v_admin, true, 'Consulta cerrada.'||case when nullif(btrim(p_note),'') is not null then ' '||btrim(p_note) else '' end);
 select email into v_email from auth.users where id=v_admin;
 perform public.admin_log(v_admin, v_email, 'support.closed', v_ticket.user_id, jsonb_build_object('ticketId',v_ticket.id,
   'actorRole',case when public.admin_is_admin_user(v_admin) then 'admin' else 'support' end));
 return private.support_ticket_json(v_ticket);
end $$;

-- ---------- 10) Resumen del panel: ingresos de tickets viejos + órdenes pagadas (solo reales, no de prueba) ----------
create or replace function private.payments_revenue_rows() returns table(plan_id text, price_usd numeric, paid_at timestamptz)
language sql stable security definer set search_path='' as $$
 select t.plan_id, t.price_usd, t.closed_at from public.support_tickets t where t.status='paid' and t.plan_id is not null
 union all
 select o.plan_id, o.price_usd, o.paid_at from public.payment_orders o where o.status='paid' and o.live
$$;
revoke all on function private.payments_revenue_rows() from public, anon, authenticated;

create or replace function public.admin_overview() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare
 v_month date:=date_trunc('month',public.ai_local_now())::date;
 v_month_start timestamptz:=v_month::timestamp at time zone public.ai_quota_tz();
 v_users jsonb; v_subs jsonb; v_revenue jsonb; v_by_plan jsonb; v_ai jsonb; v_by_model jsonb;
begin
 perform public.admin_guard();
 select jsonb_build_object('total',count(*),'new7d',count(*) filter(where u.created_at>now()-interval '7 days'),
   'new30d',count(*) filter(where u.created_at>now()-interval '30 days'),
   'confirmed',count(*) filter(where u.email_confirmed_at is not null),
   'banned',count(*) filter(where u.banned_until>now() or m.banned_until>now()),
   'muted',count(*) filter(where m.muted_until>now()),'admins',(select count(*) from public.app_admins))
 into v_users from auth.users u left join public.user_moderation m on m.user_id=u.id where u.deleted_at is null;

 with subs as (
   select s.*,public.ai_effective_plan(s.user_id) as effective_plan from public.ai_subscriptions s
   join public.ai_plans p on p.id=s.plan_id and p.active and p.id in ('basic','go','pro','max')
 ) select jsonb_build_object('active',count(*) filter(where effective_plan is not null),
   'paying',count(*) filter(where effective_plan is not null and source='support'),
   'support',count(*) filter(where effective_plan is not null and source='support'),
   'manual',0,'trialing',0,'legacy',count(*) filter(where source<>'support'),
   'pastDue',count(*) filter(where stripe_status in ('past_due','unpaid')),
   'canceling',count(*) filter(where cancel_at_period_end)) into v_subs from subs;

 select coalesce(jsonb_agg(jsonb_build_object('plan',p.id,'name',p.name,'planActive',p.active,'priceUsd',p.price_usd,
   'active',coalesce(s.active,0),'paying',coalesce(s.active,0),'support',coalesce(s.active,0),
   'manual',0,'legacy',coalesce(s.legacy,0),'confirmedUsd',coalesce(r.usd,0),
   'confirmedPayments',coalesce(r.payments,0),'mrrUsd',0) order by p.sort,p.id),'[]'::jsonb)
 into v_by_plan from public.ai_plans p
 left join lateral (select count(*) filter(where public.ai_effective_plan(x.user_id)=p.id) as active,
   count(*) filter(where x.source<>'support') as legacy from public.ai_subscriptions x where x.plan_id=p.id) s on true
 left join lateral (select count(*) as payments,sum(x.price_usd) as usd from private.payments_revenue_rows() x
   where x.plan_id=p.id) r on true
 where p.active and p.id in ('basic','go','pro','max');

 select jsonb_build_object('mode','one_time','currency','usd','confirmedUsd',coalesce(sum(r.price_usd),0),
   'confirmedPayments',count(*),'monthUsd',coalesce(sum(r.price_usd) filter(where r.paid_at>=v_month_start),0),
   'monthPayments',count(*) filter(where r.paid_at>=v_month_start),'mrrUsd',0)
 into v_revenue from private.payments_revenue_rows() r;

 select jsonb_build_object('monthUsd',round(coalesce(sum(d.cost_usd),0),4),
   'monthQuestions',coalesce(sum(d.questions),0),'monthCalls',coalesce(sum(d.calls),0),
   'activeUsers',count(distinct d.user_id)) into v_ai from public.ai_usage_model_daily d where d.day>=v_month;
 select coalesce(jsonb_agg(jsonb_build_object('model',x.model_id,'label',coalesce(m.label,x.model_id),
   'usd',round(x.usd,4),'questions',x.questions,'calls',x.calls) order by x.usd desc,x.model_id),'[]'::jsonb)
 into v_by_model from (select d.model_id,sum(d.cost_usd) as usd,sum(d.questions) as questions,sum(d.calls) as calls
   from public.ai_usage_model_daily d where d.day>=v_month group by d.model_id) x
 left join public.ai_models m on m.id=x.model_id;
 return jsonb_build_object('users',v_users,'subscriptions',v_subs||jsonb_build_object('byPlan',v_by_plan),
   'revenue',v_revenue,'ai',v_ai||jsonb_build_object('byModel',v_by_model,'since',v_month),
   'generatedAt',public.ai_iso(now()));
end $$;
revoke all on function public.admin_overview() from public,anon;
grant execute on function public.admin_overview() to authenticated,service_role;
