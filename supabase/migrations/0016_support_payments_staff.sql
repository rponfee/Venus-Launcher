
-- Source: 0015_support_plans.sql
-- Venus 1.0.4: payments are confirmed by support, never by the client.
-- Apply after 0014. Existing Stripe subscriptions are retained for audit, but checkout and
-- automatic grants from Stripe are retired. Paid API balances have no automatic expiration or renewal.

alter table public.ai_plans drop constraint if exists ai_plans_max_tokens_per_request_check;
alter table public.ai_plans add constraint ai_plans_max_tokens_per_request_check
  check (max_tokens_per_request between 1000 and 36000);
alter table public.ai_plan_models drop constraint if exists ai_plan_models_efforts_check;
alter table public.ai_plan_models add constraint ai_plan_models_efforts_check
  check (cardinality(efforts) between 1 and 4 and efforts <@ array['low','medium','high','xhigh']::text[]);

insert into public.ai_plans (id,name,model,max_tokens_per_request,max_calls_per_turn,requests_per_minute,
                            sort,active,price_usd,monthly_budget_usd,currency)
values
  ('basic','Basic','claude-haiku-5-5',12000,40,30,10,true,3,1.8,'USD'),
  ('go','Go','claude-haiku-5-5',16000,40,30,20,true,8,6.5,'USD'),
  ('pro','Pro','claude-sonnet-5-5',24000,60,40,30,true,12,10,'USD'),
  ('max','Max','claude-sonnet-5-5',36000,60,60,40,true,32,28,'USD')
on conflict (id) do update set name=excluded.name, model=excluded.model,
  max_tokens_per_request=excluded.max_tokens_per_request, max_calls_per_turn=excluded.max_calls_per_turn,
  requests_per_minute=excluded.requests_per_minute, sort=excluded.sort, active=true,
  price_usd=excluded.price_usd,monthly_budget_usd=excluded.monthly_budget_usd,currency='USD';
-- Old plans remain readable in history but cannot be bought or used for new requests.
update public.ai_plans set active=false where id not in ('basic','go','pro','max');
delete from public.ai_plan_models where plan_id in ('basic','go','pro','max');
insert into public.ai_plan_models (plan_id,model_id,efforts,daily_questions,weekly_questions,sort)
values
  ('basic','haiku',array['low','medium'],2147483647,2147483647,10),
  ('go','haiku',array['low','medium','high'],2147483647,2147483647,10),
  ('pro','haiku',array['low','medium','high'],2147483647,2147483647,10),
  ('pro','sonnet',array['low','medium','high'],2147483647,2147483647,20),
  ('max','haiku',array['low','medium','high','xhigh'],2147483647,2147483647,10),
  ('max','sonnet',array['low','medium','high','xhigh'],2147483647,2147483647,20);
-- No automatic fallback to a model outside the purchased plan, and no automatic SDK retries.
update public.ai_models set supports_fallback=false;
update public.ai_models set model_id='claude-haiku-5-5',label='Haiku 5.5',active=true,
  input_usd_mtok=.10,output_usd_mtok=.50,cache_read_usd_mtok=.01,cache_write_usd_mtok=.125,
  long_context_threshold=100000,long_input_usd_mtok=.50,long_output_usd_mtok=2.50,
  long_cache_read_usd_mtok=.05,long_cache_write_usd_mtok=.625 where id='haiku';
update public.ai_models set model_id='claude-sonnet-5-5',label='Sonnet 5.5',active=true,
  input_usd_mtok=2,output_usd_mtok=10,cache_read_usd_mtok=.10,cache_write_usd_mtok=2.50,
  long_context_threshold=null,long_input_usd_mtok=null,long_output_usd_mtok=null,
  long_cache_read_usd_mtok=null,long_cache_write_usd_mtok=null where id='sonnet';
update public.ai_plan_prices set active=false;

create or replace function public.ai_effort_list(p_efforts text[]) returns jsonb
language sql immutable set search_path='' as $$
 select coalesce(jsonb_agg(e.effort order by e.position),'[]'::jsonb)
 from unnest(array['low','medium','high','xhigh']::text[]) with ordinality e(effort,position)
 where e.effort=any(p_efforts)
$$;

create table if not exists public.support_tickets (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 name text not null check (char_length(name) between 2 and 120),
 plan_id text not null references public.ai_plans(id),
 plan_name text not null,
 price_usd numeric(8,2) not null check(price_usd>0),
 payment_method text not null check(payment_method in ('mercado_pago','paypal')),
 status text not null default 'open' check(status in ('open','in_progress','paid','closed')),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 closed_at timestamptz,
 closed_by uuid references auth.users(id),
 payment_reference text check(char_length(payment_reference)<=200),
 activated_until timestamptz,
 constraint support_paid_evidence check(status<>'paid' or
   (closed_at is not null and closed_by is not null and payment_reference is not null))
);
create unique index if not exists support_one_open_ticket on public.support_tickets(user_id)
 where status in ('open','in_progress');
create unique index if not exists support_payment_once on public.support_tickets(payment_method,lower(payment_reference))
 where status='paid';
create index if not exists support_tickets_queue on public.support_tickets(status,updated_at desc);

create table if not exists public.support_messages (
 id uuid primary key default gen_random_uuid(),
 ticket_id uuid not null references public.support_tickets(id) on delete cascade,
 author_id uuid not null references auth.users(id),
 is_admin boolean not null,
 body text not null check(char_length(body) between 1 and 4000),
 created_at timestamptz not null default now()
);
create index if not exists support_messages_ticket on public.support_messages(ticket_id,created_at,id);

-- Immutable paid periods preserve old usage when an administrator confirms a new payment.
create table if not exists public.ai_paid_periods (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 ticket_id uuid not null unique references public.support_tickets(id),
 plan_id text not null references public.ai_plans(id),
 starts_at timestamptz not null,
 ends_at timestamptz,
 budget_usd numeric(12,6) not null check(budget_usd>=0),
 spent_usd numeric(12,6) not null default 0 check(spent_usd>=0),
 check(ends_at is null or ends_at>starts_at)
);
alter table public.ai_subscriptions add column if not exists support_period_id uuid references public.ai_paid_periods(id);

-- A reservation is never silently dropped on timeout. If a worker dies it remains reserved until
-- explicit reconciliation, preventing another request from spending the same money.
create table if not exists public.ai_call_reservations (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 period_id uuid references public.ai_paid_periods(id),
 model_id text not null references public.ai_models(id),
 reserved_usd numeric(12,6) not null check(reserved_usd>0),
 status text not null default 'reserved' check(status in ('reserved','settled','released','estimated')),
 actual_usd numeric(12,6),
 created_at timestamptz not null default now(),
 settled_at timestamptz
);
create index if not exists ai_call_reservations_pending on public.ai_call_reservations(user_id,period_id) where status='reserved';

alter table public.support_tickets enable row level security;
alter table public.support_messages enable row level security;
alter table public.ai_paid_periods enable row level security;
alter table public.ai_call_reservations enable row level security;
revoke all on public.support_tickets,public.support_messages,public.ai_paid_periods,public.ai_call_reservations from anon,authenticated;
grant select on public.support_tickets,public.support_messages,public.ai_paid_periods to authenticated;
grant all on public.support_tickets,public.support_messages,public.ai_paid_periods,public.ai_call_reservations to service_role;
create policy support_tickets_read on public.support_tickets for select to authenticated
 using(user_id=(select auth.uid()) or (select public.is_admin()));
create policy support_messages_read on public.support_messages for select to authenticated
 using(exists(select 1 from public.support_tickets t where t.id=ticket_id
   and (t.user_id=(select auth.uid()) or (select public.is_admin()))));
create policy support_periods_read on public.ai_paid_periods for select to authenticated
 using(user_id=(select auth.uid()) or (select public.is_admin()));

create or replace function private.support_user() returns uuid
language plpgsql stable security definer set search_path='' as $$
declare v_user uuid:=auth.uid();
begin
 if v_user is null or not exists(select 1 from auth.users u where u.id=v_user
   and u.deleted_at is null and not coalesce(u.is_anonymous,false) and (u.banned_until is null or u.banned_until<=now())) then
   raise exception 'Iniciá sesión con tu cuenta de Venus.' using errcode='42501';
 end if;
 return v_user;
end $$;

create or replace function private.support_ticket_json(t public.support_tickets) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('id',t.id,'userId',t.user_id,'name',t.name,'plan',t.plan_id,
 'planName',t.plan_name,'priceUsd',t.price_usd,'paymentMethod',t.payment_method,'status',t.status,
 'createdAt',public.ai_iso(t.created_at),'updatedAt',public.ai_iso(t.updated_at),
 'closedAt',public.ai_iso(t.closed_at),'activatedUntil',public.ai_iso(t.activated_until))
$$;
create or replace function private.support_message_json(m public.support_messages) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('id',m.id,'ticketId',m.ticket_id,'authorId',m.author_id,'isAdmin',m.is_admin,
 'body',m.body,'createdAt',public.ai_iso(m.created_at))
$$;

create or replace function public.support_list_tickets(p_admin boolean default false) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_user uuid:=private.support_user(); v_result jsonb;
begin
 if coalesce(p_admin,false) and not public.admin_is_admin_user(v_user) then
   raise exception 'Solo administradores.' using errcode='42501';
 end if;
 select coalesce(jsonb_agg(private.support_ticket_json(t) order by t.updated_at desc),'[]'::jsonb)
 into v_result from (select * from public.support_tickets s
   where coalesce(p_admin,false) or s.user_id=v_user
   order by case when status in ('open','in_progress') then 0 else 1 end,updated_at desc limit 200) t;
 return v_result;
end $$;

create or replace function public.support_ticket_detail(p_ticket uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_user uuid:=private.support_user(); v_ticket public.support_tickets%rowtype;
begin
 select * into v_ticket from public.support_tickets t where t.id=p_ticket
   and (t.user_id=v_user or public.admin_is_admin_user(v_user));
 if not found then raise exception 'Ticket no disponible.' using errcode='42501'; end if;
 return jsonb_build_object('ticket',private.support_ticket_json(v_ticket),'messages',
   coalesce((select jsonb_agg(private.support_message_json(m) order by m.created_at,m.id)
   from public.support_messages m where m.ticket_id=p_ticket),'[]'::jsonb));
end $$;

create or replace function public.support_create_ticket(p_plan text,p_name text,p_payment_method text,p_message text default '') returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_user uuid:=private.support_user(); v_plan public.ai_plans%rowtype; v_ticket public.support_tickets%rowtype;
begin
 if p_name is null or char_length(btrim(p_name)) not between 2 and 120 or
   p_payment_method is null or p_payment_method not in ('mercado_pago','paypal') or
   char_length(coalesce(p_message,''))>4000 then
   raise exception 'Revisá el nombre, el método de pago y el mensaje.' using errcode='22023';
 end if;
 select * into v_plan from public.ai_plans where id=p_plan and active and id in ('basic','go','pro','max');
 if not found then raise exception 'El plan no está disponible.' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended(v_user::text,815));
 select * into v_ticket from public.support_tickets where user_id=v_user and status in ('open','in_progress');
 if found then
   if v_ticket.plan_id=p_plan and v_ticket.payment_method=p_payment_method and v_ticket.name=btrim(p_name) then
     return private.support_ticket_json(v_ticket);
   end if;
   raise exception 'Ya tenés un ticket abierto. Continuá por ese ticket.' using errcode='23505';
 end if;
 if (select count(*) from public.support_tickets where user_id=v_user and created_at>now()-interval '1 day')>=5 then
   raise exception 'Llegaste al límite de solicitudes de hoy.' using errcode='54000';
 end if;
 insert into public.support_tickets(user_id,name,plan_id,plan_name,price_usd,payment_method)
 values(v_user,btrim(p_name),v_plan.id,v_plan.name,v_plan.price_usd,p_payment_method) returning * into v_ticket;
 if nullif(btrim(p_message),'') is not null then
   insert into public.support_messages(ticket_id,author_id,is_admin,body) values(v_ticket.id,v_user,false,btrim(p_message));
 end if;
 return private.support_ticket_json(v_ticket);
end $$;

create or replace function public.support_add_message(p_ticket uuid,p_body text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_user uuid:=private.support_user(); v_admin boolean:=public.admin_is_admin_user(v_user);
 v_ticket public.support_tickets%rowtype; v_message public.support_messages%rowtype;
begin
 if p_body is null or char_length(btrim(p_body)) not between 1 and 4000 then
   raise exception 'Escribí un mensaje de hasta 4000 caracteres.' using errcode='22023';
 end if;
 select * into v_ticket from public.support_tickets where id=p_ticket and (user_id=v_user or v_admin) for update;
 if not found then raise exception 'Ticket no disponible.' using errcode='42501'; end if;
 if v_ticket.status not in ('open','in_progress') then raise exception 'El ticket ya está cerrado.' using errcode='22023'; end if;
 if (select count(*) from public.support_messages where author_id=v_user and created_at>now()-interval '1 minute')>=10 then
   raise exception 'Esperá un minuto antes de enviar más mensajes.' using errcode='54000';
 end if;
 if (select count(*) from public.support_messages where ticket_id=p_ticket)>=500 then
   raise exception 'El ticket alcanzó el límite de mensajes.' using errcode='54000';
 end if;
 insert into public.support_messages(ticket_id,author_id,is_admin,body)
 values(p_ticket,v_user,v_admin,btrim(p_body)) returning * into v_message;
 update public.support_tickets set updated_at=now(),status=case when v_admin then 'in_progress' else status end where id=p_ticket;
 return private.support_message_json(v_message);
end $$;

create or replace function public.support_resolve_ticket(p_ticket uuid,p_confirm_payment boolean,p_note text default '') returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_admin uuid:=private.support_user(); v_ticket public.support_tickets%rowtype;
 v_plan public.ai_plans%rowtype; v_until timestamptz; v_period uuid; v_email text;
begin
 if not public.admin_is_admin_user(v_admin) then raise exception 'Solo administradores.' using errcode='42501'; end if;
 if p_confirm_payment is null or char_length(coalesce(p_note,''))>2000 then
   raise exception 'Revisá la resolución del ticket.' using errcode='22023';
 end if;
 select * into v_ticket from public.support_tickets where id=p_ticket for update;
 if not found then raise exception 'Ticket no disponible.' using errcode='P0002'; end if;
 -- A repeated network request or double click returns the same completed result, without a new grant.
 if v_ticket.status='paid' and p_confirm_payment then return private.support_ticket_json(v_ticket); end if;
 if v_ticket.status='closed' and not p_confirm_payment then return private.support_ticket_json(v_ticket); end if;
 if v_ticket.status not in ('open','in_progress') then raise exception 'El ticket ya está cerrado.' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended(v_ticket.user_id::text,816));
 if p_confirm_payment then
   if nullif(btrim(p_note),'') is null or char_length(btrim(p_note))>200 then
     raise exception 'Ingresá la referencia del pago verificado (máximo 200 caracteres) antes de activar el plan.' using errcode='22023';
   end if;
   select * into v_plan from public.ai_plans where id=v_ticket.plan_id and active;
   if not found or v_plan.price_usd<>v_ticket.price_usd then
     raise exception 'El precio del plan cambió. Cerrá la solicitud y creá una nueva.' using errcode='22023';
   end if;
   -- A new verified full payment replaces the active period. History and pending reservations remain.
   v_until:=null; -- Credit does not expire; only another confirmed payment grants a new allocation.
   insert into public.ai_paid_periods(user_id,ticket_id,plan_id,starts_at,ends_at,budget_usd)
   values(v_ticket.user_id,v_ticket.id,v_plan.id,now(),v_until,v_plan.monthly_budget_usd) returning id into v_period;
   insert into public.ai_subscriptions(user_id,plan_id,status,current_period_end,source,external_ref,support_period_id)
   values(v_ticket.user_id,v_plan.id,'active',v_until,'support',v_ticket.id::text,v_period)
   on conflict(user_id) do update set plan_id=excluded.plan_id,status='active',current_period_end=v_until,
     source='support',external_ref=excluded.external_ref,support_period_id=v_period,
     stripe_customer_id=null,stripe_subscription_id=null,stripe_price_id=null,stripe_status=null,
     cancel_at_period_end=false,grace_until=null,budget_cap_usd=null,budget_cap_until=null,updated_at=now();
 end if;
 update public.support_tickets set status=case when p_confirm_payment then 'paid' else 'closed' end,
   payment_reference=case when p_confirm_payment then btrim(p_note) end,closed_at=now(),closed_by=v_admin,
   activated_until=v_until,updated_at=now() where id=p_ticket returning * into v_ticket;
 insert into public.support_messages(ticket_id,author_id,is_admin,body)
 values(p_ticket,v_admin,true,case when p_confirm_payment then 'Pago confirmado. Tu plan '||v_ticket.plan_name||' está activo. El saldo no vence y se renueva únicamente con otro pago confirmado.'
   else 'Solicitud cerrada sin activar un plan.'||case when nullif(btrim(p_note),'') is not null then ' '||btrim(p_note) else '' end end);
 select email into v_email from auth.users where id=v_admin;
 perform public.admin_log(v_admin,v_email,case when p_confirm_payment then 'support.paymentConfirmed' else 'support.closed' end,
   v_ticket.user_id,jsonb_build_object('ticketId',v_ticket.id,'plan',v_ticket.plan_id,'amountUsd',v_ticket.price_usd,
   'paymentMethod',v_ticket.payment_method,'periodId',v_period,'until',public.ai_iso(v_until)));
 return private.support_ticket_json(v_ticket);
end $$;

revoke all on function private.support_user(),private.support_ticket_json(public.support_tickets),
 private.support_message_json(public.support_messages) from public,anon,authenticated;
revoke all on function public.support_list_tickets(boolean),public.support_ticket_detail(uuid),
 public.support_create_ticket(text,text,text,text),public.support_add_message(uuid,text),
 public.support_resolve_ticket(uuid,boolean,text) from public,anon;
grant execute on function public.support_list_tickets(boolean),public.support_ticket_detail(uuid),
 public.support_create_ticket(text,text,text,text),public.support_add_message(uuid,text),
 public.support_resolve_ticket(uuid,boolean,text) to authenticated;

-- These helpers are internal; they always use the active paid period, never the calendar month.
create or replace function public.ai_budget_limit(p_user uuid,p_plan text) returns numeric
language sql stable security definer set search_path='' as $$
 select case when s.source='support' then coalesce(pp.budget_usd,0)
   when s.source='stripe' and s.budget_cap_until>now() and s.budget_cap_usd is not null
     then least(p.monthly_budget_usd,s.budget_cap_usd) else p.monthly_budget_usd end
 from public.ai_plans p left join public.ai_subscriptions s on s.user_id=p_user
 left join public.ai_paid_periods pp on pp.id=s.support_period_id where p.id=p_plan
$$;
create or replace function private.ai_current_spend(p_user uuid) returns numeric
language sql stable security definer set search_path='' as $$
 select case when s.source='support' then coalesce(pp.spent_usd,0) else
   (select coalesce(sum(d.cost_usd),0) from public.ai_usage_model_daily d
     where d.user_id=p_user and d.day>=date_trunc('month',public.ai_local_now())::date) end
 from public.ai_subscriptions s left join public.ai_paid_periods pp on pp.id=s.support_period_id where s.user_id=p_user
$$;
-- Bound all UTF-8 request bytes as tokens, plus 90KB for server policy/schema framing.
-- No prompt caching is requested by 1.0.4; use input price and the more expensive context tier.
create or replace function public.ai_call_reserve(p_model text,p_max_tokens integer) returns numeric
language sql stable security definer set search_path='' as $$
 select ceil((500000*greatest(m.input_usd_mtok,coalesce(m.long_input_usd_mtok,0))+
   greatest(coalesce(p_max_tokens,0),0)*greatest(m.output_usd_mtok,coalesce(m.long_output_usd_mtok,0)))/1000000*1000000)/1000000
 from public.ai_models m where m.id=p_model
$$;
revoke all on function private.ai_current_spend(uuid) from public,anon,authenticated;
-- BEGIN GENERATED QUOTA ROUTINES
create or replace function public.ai_quota_status(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_tz text := public.ai_quota_tz();
  v_now timestamp := public.ai_local_now();
  v_today date := v_now::date;
  v_week date := date_trunc('week', v_now)::date;
  v_month date := date_trunc('month', v_now)::date;
  v_plan_id text := public.ai_effective_plan(p_user);
  v_plan public.ai_plans%rowtype;
  v_status text := 'none';
  v_models jsonb := '[]'::jsonb;
  v_spent numeric;
  v_last text;
begin
  if v_plan_id is not null then
    select p.* into v_plan from public.ai_plans p where p.id = v_plan_id;

    select s.status into v_status
      from public.ai_subscriptions s
     where s.user_id = p_user;
    v_status := case when v_status = 'trialing' then 'trialing' else 'active' end;

    select coalesce(jsonb_agg(jsonb_build_object(
             'id', m.id,
             'model', m.model_id,
             'label', m.label,
             'efforts', public.ai_effort_list(pm.efforts),
             'daily', jsonb_build_object('used', coalesce(u.used_today, 0), 'limit', pm.daily_questions),
             'weekly', jsonb_build_object('used', coalesce(u.used_week, 0), 'limit', pm.weekly_questions)
           ) order by pm.sort, m.sort, m.id), '[]'::jsonb)
      into v_models
      from public.ai_plan_models pm
      join public.ai_models m on m.id = pm.model_id and m.active
      left join lateral (
        select sum(d.questions) filter (where d.day = v_today) as used_today,
               sum(d.questions) as used_week
          from public.ai_usage_model_daily d
         where d.user_id = p_user
           and d.model_id = pm.model_id
           and d.day >= v_week
      ) u on true
     where pm.plan_id = v_plan_id;

    -- Último modelo usado, solo si el plan actual lo sigue ofreciendo.
    select d.model_id into v_last
      from public.ai_usage_model_daily d
      join public.ai_plan_models pm on pm.plan_id = v_plan_id and pm.model_id = d.model_id
      join public.ai_models m on m.id = d.model_id and m.active
     where d.user_id = p_user
     order by d.day desc, d.updated_at desc
     limit 1;
  end if;

  v_spent := coalesce(private.ai_current_spend(p_user),0);

  return jsonb_build_object(
    'plan', v_plan_id,
    'planName', v_plan.name,
    'priceUsd', v_plan.price_usd,
    'maxTokensPerRequest', v_plan.max_tokens_per_request,
    'status', v_status,
    'models', v_models,
    'budget', jsonb_build_object('usedUsd', round(v_spent, 4), 'limitUsd', coalesce(public.ai_budget_limit(p_user, v_plan_id), 0)),
    'resets', jsonb_build_object(
      'daily', public.ai_iso((v_today + 1)::timestamp at time zone v_tz),
      'weekly', public.ai_iso((v_week + 7)::timestamp at time zone v_tz),
      'monthly', case when exists(select 1 from public.ai_subscriptions s where s.user_id=p_user and s.source='support') then null
        else public.ai_iso((v_month + interval '1 month') at time zone v_tz) end
    ),
    'timezone', v_tz,
    'lastModel', v_last
  );
end $$;

create or replace function public.ai_register_turn(p_user uuid, p_turn text, p_model text, p_effort text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamp := public.ai_local_now();
  v_today date := v_now::date;
  v_week date := date_trunc('week', v_now)::date;
  v_month date := date_trunc('month', v_now)::date;
  v_plan_id text;
  v_plan public.ai_plans%rowtype;
  v_pm public.ai_plan_models%rowtype;
  v_info public.ai_models%rowtype;
  v_model text := p_model;
  v_effort text := p_effort;
  v_turn_found boolean := false;
  v_turn_day date;
  v_turn_model text;
  v_turn_calls integer;
  v_minute_calls integer;
  v_inflight integer;
  v_spent numeric;
  v_budget numeric;
  v_week_before bigint;
  v_today_questions integer;
  v_rows integer;
  v_reason text;
  v_counted boolean := false;
  v_reserved numeric;
  v_reserve numeric;
  v_call uuid;
  v_period uuid;
begin
  if p_user is null or p_turn is null or char_length(p_turn) not between 1 and 100 then
    raise exception 'ai_register_turn: parámetros inválidos' using errcode = '22023';
  end if;
  if p_model is not null and char_length(p_model) not between 1 and 32 then
    raise exception 'ai_register_turn: modelo inválido' using errcode = '22023';
  end if;
  if p_effort is not null and p_effort not in ('low', 'medium', 'high', 'xhigh') then
    raise exception 'ai_register_turn: esfuerzo inválido' using errcode = '22023';
  end if;

  -- Serialize admission, settlement and payment activation for this account.
  perform pg_advisory_xact_lock(hashtextextended(p_user::text,816));
  select support_period_id into v_period from public.ai_subscriptions where user_id=p_user and source='support';

  -- 1) Plan vigente.
  v_plan_id := public.ai_effective_plan(p_user);
  if v_plan_id is null then
    v_reason := 'noplan';
  else
    select p.* into v_plan from public.ai_plans p where p.id = v_plan_id;
  end if;

  if v_reason is null then
    -- La pregunta, si ya está abierta (hoy o ayer, por si cruzó la medianoche). Queda bloqueada hasta el
    -- final: las llamadas simultáneas de una misma pregunta se ordenan.
    select t.day, t.model_id, t.calls
      into v_turn_day, v_turn_model, v_turn_calls
      from public.ai_turns t
     where t.user_id = p_user
       and t.turn_id = p_turn
       and t.day >= v_today - 1
     order by t.day desc
     limit 1
     for update;
    v_turn_found := found;

    -- 2) Modelo.
    if v_model is null then
      v_model := v_turn_model;
    end if;
    if v_model is null then
      select pm.model_id into v_model
        from public.ai_plan_models pm
        join public.ai_models m on m.id = pm.model_id and m.active
       where pm.plan_id = v_plan_id
       order by pm.sort, m.sort, m.id
       limit 1;
    end if;
    select pm.* into v_pm
      from public.ai_plan_models pm
      join public.ai_models m on m.id = pm.model_id and m.active
     where pm.plan_id = v_plan_id
       and pm.model_id = v_model;
    if not found then
      v_reason := 'model';
    else
      select m.* into v_info from public.ai_models m where m.id = v_model;
    end if;
  end if;

  -- 3) Esfuerzo.
  if v_reason is null then
    if v_effort is null then
      v_effort := public.ai_default_effort(v_pm.efforts);
    end if;
    if v_effort is null or not (v_effort = any (v_pm.efforts)) then
      v_reason := 'effort';
    end if;
  end if;

  -- 4) Una pregunta abierta sigue con su modelo (cambiar de modelo es una pregunta nueva).
  if v_reason is null and v_turn_found and v_turn_model is not null and v_turn_model <> v_model then
    v_reason := 'turn_model';
  end if;

  -- 5) Ráfaga y llamadas en curso (cuenta también los intentos que después se rechazan por presupuesto o cupo).
  --    La fila de ai_rate queda bloqueada hasta el final: dos pedidos simultáneos no pasan juntos este control.
  if v_reason is null then
    insert into public.ai_rate as r (user_id, window_start, calls)
    values (p_user, now(), 1)
    on conflict (user_id) do update
      set window_start = case when r.window_start > now() - interval '1 minute' then r.window_start else now() end,
          calls = case when r.window_start > now() - interval '1 minute' then r.calls + 1 else 1 end
    returning r.calls, (select count(*)::integer from public.ai_call_reservations c where c.user_id=p_user and c.status='reserved')
      into v_minute_calls, v_inflight;
    if v_minute_calls > v_plan.requests_per_minute or v_inflight >= 3 then
      v_reason := 'rate';
    end if;
  end if;

  -- 6) Remaining paid allocation, without calendar reset; pending requests retain their own reservations.
  if v_reason is null then
    v_spent := coalesce(private.ai_current_spend(p_user),0);
    v_budget := public.ai_budget_limit(p_user,v_plan_id);
    v_reserve := public.ai_call_reserve(v_model,v_plan.max_tokens_per_request);
    select coalesce(sum(c.reserved_usd),0) into v_reserved from public.ai_call_reservations c
      where c.user_id=p_user and c.status='reserved' and c.period_id is not distinct from v_period;
    -- Include THIS call, even when there are no other requests in flight.
    if v_reserve is null or v_spent+v_reserved+v_reserve>v_budget then
      v_reason := case when v_reserved>0 then 'rate' else 'budget' end;
    end if;
  end if;

  -- 7) Pregunta ya abierta.
  if v_reason is null and v_turn_found then
    if v_turn_calls >= v_plan.max_calls_per_turn then
      v_reason := 'turn';
    else
      update public.ai_turns t
         set calls = t.calls + 1,
             model_id = coalesce(t.model_id, v_model)
       where t.user_id = p_user
         and t.turn_id = p_turn
         and t.day = v_turn_day;
    end if;
  end if;

  -- 8) Pregunta nueva.
  if v_reason is null and not v_turn_found then
    -- Limpieza de preguntas viejas del usuario.
    delete from public.ai_turns t
     where t.user_id = p_user
       and t.day < v_today - 2;

    insert into public.ai_turns (user_id, turn_id, day, calls, model_id)
    values (p_user, p_turn, v_today, 1, v_model)
    on conflict (user_id, turn_id, day) do nothing;
    get diagnostics v_rows = row_count;

    if v_rows = 0 then
      -- Otro pedido con el mismo turn_id la abrió recién: es una llamada más de esa pregunta.
      update public.ai_turns t
         set calls = t.calls + 1
       where t.user_id = p_user
         and t.turn_id = p_turn
         and t.day = v_today
         and t.model_id = v_model
         and t.calls < v_plan.max_calls_per_turn;
      if not found then
        v_reason := case
          when exists (select 1 from public.ai_turns t
                        where t.user_id = p_user and t.turn_id = p_turn and t.day = v_today
                          and t.model_id is distinct from v_model) then 'turn_model'
          else 'turn'
        end;
      end if;
    else
      -- Preguntas de este modelo en los días anteriores de la semana (esas filas ya no cambian).
      select coalesce(sum(d.questions), 0)
        into v_week_before
        from public.ai_usage_model_daily d
       where d.user_id = p_user
         and d.model_id = v_model
         and d.day >= v_week
         and d.day < v_today;

      if v_pm.daily_questions <= 0 then
        v_reason := 'daily';
      elsif v_week_before >= v_pm.weekly_questions then
        v_reason := 'weekly';
      else
        -- La fila del día queda bloqueada mientras se revisa el cupo: el aumento es atómico.
        insert into public.ai_usage_model_daily as d (user_id, day, model_id, questions)
        values (p_user, v_today, v_model, 1)
        on conflict (user_id, day, model_id) do update
          set questions = d.questions + 1,
              updated_at = now()
          where d.questions < v_pm.daily_questions
            and d.questions + v_week_before < v_pm.weekly_questions;
        get diagnostics v_rows = row_count;
        if v_rows = 0 then
          select d.questions into v_today_questions
            from public.ai_usage_model_daily d
           where d.user_id = p_user
             and d.day = v_today
             and d.model_id = v_model;
          v_reason := case when coalesce(v_today_questions, 0) >= v_pm.daily_questions then 'daily' else 'weekly' end;
        else
          v_counted := true;
        end if;
      end if;

      -- Si la pregunta nueva no entró en el cupo, no queda registrada.
      if v_reason is not null then
        delete from public.ai_turns t
         where t.user_id = p_user
           and t.turn_id = p_turn
           and t.day = v_today
           and t.calls <= 1;
      end if;
    end if;
  end if;

  if v_reason is null then
    insert into public.ai_call_reservations(user_id,period_id,model_id,reserved_usd)
      values(p_user,v_period,v_model,v_reserve) returning id into v_call;
  end if;
  -- La llamada permitida queda en curso hasta que la Edge Function la cierra (ai_add_usage o ai_end_call).
  if v_reason is null then
    update public.ai_rate r
       set inflight = v_inflight + 1,
           inflight_at = now()
     where r.user_id = p_user;
  end if;

  return jsonb_build_object(
    'allowed', v_reason is null,
    'callId',v_call,
    'reason', v_reason,
    'model', v_model,
    'modelId', case when v_reason is null then v_info.model_id end,
    'fallback',false,
    'effort', v_effort,
    'counted', v_counted,
    'maxTokensPerRequest', coalesce(v_plan.max_tokens_per_request, 0),
    'quota', public.ai_quota_status(p_user)
  );
end $$;

create or replace function public.ai_catalog() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id,
           'name', p.name,
           'priceUsd', p.price_usd,
           'budgetUsd', p.monthly_budget_usd,
           'maxTokensPerRequest',p.max_tokens_per_request,
           'models', (
             select coalesce(jsonb_agg(jsonb_build_object(
                      'id', m.id,
                      'label', m.label,
                      'efforts', public.ai_effort_list(pm.efforts),
                      'daily', pm.daily_questions,
                      'weekly', pm.weekly_questions
                    ) order by pm.sort, m.sort, m.id), '[]'::jsonb)
               from public.ai_plan_models pm
               join public.ai_models m on m.id = pm.model_id and m.active
              where pm.plan_id = p.id
           )
         ) order by p.sort, p.id), '[]'::jsonb)
    from public.ai_plans p
   where p.active and p.id in ('basic','go','pro','max')
$$;

-- Complete exactly one admitted call. The account lock is shared with admission and activation.
create or replace function public.ai_settle_call(p_user uuid,p_call uuid,p_usage jsonb default '[]'::jsonb,
                                                p_release boolean default false,p_estimated boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_call public.ai_call_reservations%rowtype; v_result jsonb; v_cost numeric:=0;
begin
 if p_user is null or p_call is null then raise exception 'Missing reservation.' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user::text,816));
 select * into v_call from public.ai_call_reservations where id=p_call and user_id=p_user for update;
 if not found then raise exception 'Unknown reservation.' using errcode='22023'; end if;
 if v_call.status<>'reserved' then
   return jsonb_build_object('quota',public.ai_quota_status(p_user),'costUsd',coalesce(v_call.actual_usd,0),'unpriced','[]'::jsonb);
 end if;
 if p_release then
   update public.ai_call_reservations set status='released',actual_usd=0,settled_at=now() where id=p_call;
 elsif p_estimated then
   v_cost:=v_call.reserved_usd;
   insert into public.ai_usage_model_daily(user_id,day,model_id,calls,cost_usd)
   values(p_user,public.ai_today(),v_call.model_id,1,v_cost)
   on conflict(user_id,day,model_id) do update set calls=public.ai_usage_model_daily.calls+1,
     cost_usd=public.ai_usage_model_daily.cost_usd+excluded.cost_usd,updated_at=now();
   update public.ai_call_reservations set status='estimated',actual_usd=v_cost,settled_at=now() where id=p_call;
 else
   -- Provider usage is trusted only from the Edge Function; callers cannot execute this RPC.
   v_result:=public.ai_add_usage(p_user,v_call.model_id,p_usage);
   v_cost:=(v_result->>'costUsd')::numeric;
   update public.ai_call_reservations set status='settled',actual_usd=v_cost,settled_at=now() where id=p_call;
 end if;
 if v_call.period_id is not null then
   update public.ai_paid_periods set spent_usd=spent_usd+v_cost where id=v_call.period_id;
 end if;
 update public.ai_rate set inflight=(select count(*) from public.ai_call_reservations
   where user_id=p_user and status='reserved') where user_id=p_user;
 return jsonb_build_object('quota',public.ai_quota_status(p_user),'costUsd',v_cost,
   'unpriced',coalesce(v_result->'unpriced','[]'::jsonb));
end $$;
revoke all on function public.ai_settle_call(uuid,uuid,jsonb,boolean,boolean) from public,anon,authenticated;
grant execute on function public.ai_settle_call(uuid,uuid,jsonb,boolean,boolean) to service_role;

-- Retire automatic Stripe activation. Old webhook retries cannot overwrite a support grant.
create or replace function public.billing_apply_subscription(
 p_user uuid,p_plan text,p_status text,p_current_period_end timestamptz,p_grace_until timestamptz,
 p_cancel_at_period_end boolean,p_customer text,p_subscription text,p_price text,p_stripe_status text,
 p_synced_at timestamptz,p_livemode boolean default false) returns jsonb
language sql security definer set search_path='' as $$
 select jsonb_build_object('applied',false,'reason','support_required','granted',false,'switched',false)
$$;
update public.ai_provider_config set primary_provider='anthropic',secondary_provider=null,failover_enabled=false;
comment on column public.ai_plans.max_tokens_per_request is 'Server output limit per request, including reasoning; up to 36000.';
comment on column public.ai_plans.monthly_budget_usd is 'Legacy column name: API allowance per confirmed payment, with no expiration or automatic replenishment.';
comment on column public.ai_plans.price_usd is 'Price in USD per confirmed support payment; no automatic recurring charge.';

-- Only an actual support payment grants AI access. Keep legacy subscriptions for history,
-- including the owner's Stripe test, without turning those rows into a fresh paid allocation.
create or replace function public.ai_effective_plan(p_user uuid) returns text
language sql stable security definer set search_path='' as $$
 select s.plan_id from public.ai_subscriptions s
 join public.ai_plans p on p.id=s.plan_id and p.active and p.id in ('basic','go','pro','max')
 join public.ai_paid_periods allocation on allocation.id=s.support_period_id
   and allocation.user_id=s.user_id and allocation.plan_id=s.plan_id
 join public.support_tickets ticket on ticket.id=allocation.ticket_id
   and ticket.user_id=s.user_id and ticket.plan_id=s.plan_id and ticket.status='paid'
 where s.user_id=p_user and s.source='support' and s.status='active'
   and (s.current_period_end is null or s.current_period_end>now())
   and (allocation.ends_at is null or allocation.ends_at>now())
$$;

create or replace function public.billing_state(p_user uuid,p_livemode boolean default null) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('plan',p.id,'planName',p.name,
   'status',case when p.id is not null then 'active' else 'none' end,'active',p.id is not null,
   'currentPeriodEnd',case when p.id is not null then public.billing_iso(s.current_period_end) end,
   'cancelAtPeriodEnd',false,'graceUntil',null,'inGrace',false,
   'source',case when p.id is not null then 'support' end,'stripeStatus',null,'managedByStripe',false,
   'hasCustomer',c.customer_id is not null,'lastSyncedAt',public.billing_iso(s.last_synced_at),
   'customerId',c.customer_id,'stripeSubscriptionId',s.stripe_subscription_id)
 from (select p_user as id,public.ai_effective_plan(p_user) as plan) u
 left join public.ai_subscriptions s on s.user_id=u.id
 left join public.ai_plans p on p.id=u.plan
 left join public.stripe_customers c on c.user_id=u.id and (p_livemode is null or c.livemode=p_livemode)
 where p_user is not null
$$;

create or replace function public.billing_catalog() returns jsonb
language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'sort',p.sort,
   'price',jsonb_build_object('amount',round(p.price_usd*100)::integer,'currency','usd','interval','payment'),
   'mode','support','livemode',false) order by p.sort,p.id),'[]'::jsonb)
 from public.ai_plans p where p.active and p.id in ('basic','go','pro','max')
$$;

create or replace function public.admin_plan_json(p_plan text) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',p.id,'name',p.name,'active',p.active,'sort',p.sort,
   'priceUsd',p.price_usd,'currency',p.currency,'monthlyBudgetUsd',p.monthly_budget_usd,
   'maxTokensPerRequest',p.max_tokens_per_request,'maxCallsPerTurn',p.max_calls_per_turn,
   'requestsPerMinute',p.requests_per_minute,'subscribers',
     (select count(*) from public.ai_subscriptions s where public.ai_effective_plan(s.user_id)=p.id),
   'models',coalesce((select jsonb_agg(jsonb_build_object('id',pm.model_id,'label',m.label,
     'modelActive',m.active,'efforts',public.ai_effort_list(pm.efforts),
     'daily',pm.daily_questions,'weekly',pm.weekly_questions,'sort',pm.sort) order by pm.sort,m.sort,m.id)
     from public.ai_plan_models pm join public.ai_models m on m.id=pm.model_id and m.active
     where pm.plan_id=p.id and m.id in ('haiku','sonnet')),'[]'::jsonb),
   'prices','[]'::jsonb)
 from public.ai_plans p where p.id=p_plan and p.active and p.id in ('basic','go','pro','max')
$$;

create or replace function public.admin_plans() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 perform public.admin_guard();
 return jsonb_build_object('plans',coalesce((select jsonb_agg(public.admin_plan_json(p.id) order by p.sort,p.id)
   from public.ai_plans p where p.active and p.id in ('basic','go','pro','max')),'[]'::jsonb),
   'models',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'label',m.label,'active',m.active) order by m.sort,m.id)
   from public.ai_models m where m.active and m.id in ('haiku','sonnet')),'[]'::jsonb));
end $$;

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
   'manual',0,'legacy',coalesce(s.legacy,0),'confirmedUsd',coalesce(t.usd,0),
   'confirmedPayments',coalesce(t.payments,0),'mrrUsd',0) order by p.sort,p.id),'[]'::jsonb)
 into v_by_plan from public.ai_plans p
 left join lateral (select count(*) filter(where public.ai_effective_plan(x.user_id)=p.id) as active,
   count(*) filter(where x.source<>'support') as legacy from public.ai_subscriptions x where x.plan_id=p.id) s on true
 left join lateral (select count(*) as payments,sum(x.price_usd) as usd from public.support_tickets x
   where x.plan_id=p.id and x.status='paid') t on true
 where p.active and p.id in ('basic','go','pro','max');

 select jsonb_build_object('mode','one_time','currency','usd','confirmedUsd',coalesce(sum(t.price_usd),0),
   'confirmedPayments',count(*),'monthUsd',coalesce(sum(t.price_usd) filter(where t.closed_at>=v_month_start),0),
   'monthPayments',count(*) filter(where t.closed_at>=v_month_start),'mrrUsd',0)
 into v_revenue from public.support_tickets t where t.status='paid';

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
revoke all on function public.admin_overview(),public.admin_plans() from public,anon;
revoke all on function public.admin_plan_json(text) from public,anon,authenticated;
grant execute on function public.admin_overview(),public.admin_plans() to authenticated,service_role;
grant execute on function public.admin_plan_json(text) to service_role;

-- Source: 0016_support_staff.sql
-- Venus 1.0.5: ticket staff can attend payments without receiving general administrator privileges.
-- Apply once, after 0015. Enrollment is a one-time snapshot of an existing confirmed owner account.
-- No auth.users trigger, email allowlist promotion or client-writable role is installed.

create table if not exists public.support_staff (
 user_id uuid primary key references auth.users(id) on delete cascade,
 email text not null check(email=lower(btrim(email)) and char_length(email) between 3 and 254),
 active boolean not null default true,
 granted_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 note text check(char_length(note)<=300)
);
create unique index if not exists support_staff_one_active_email on public.support_staff(email) where active;
alter table public.support_staff enable row level security;
revoke all on public.support_staff from public,anon,authenticated;
grant all on public.support_staff to service_role;
comment on table public.support_staff is 'Explicit ticket-only staff grants, bound to a user UUID and its current confirmed email. No automatic grants on registration.';

-- Check the current account on every request. Changing email, losing confirmation, deletion, a ban,
-- or setting active=false revokes the ticket role immediately without relying on client UI state.
create or replace function private.support_is_staff(p_user uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select p_user is not null and exists (
   select 1 from auth.users u where u.id=p_user and u.deleted_at is null
     and u.email_confirmed_at is not null and not coalesce(u.is_anonymous,false)
     and (u.banned_until is null or u.banned_until<=now())
     and (public.admin_is_admin_user(u.id) or exists (
       select 1 from public.support_staff s where s.user_id=u.id and s.active and s.email=lower(u.email)
     ))
 )
$$;
-- Policies may only inspect their caller; the parameterized helper is not exposed to authenticated.
create or replace function private.support_is_staff() returns boolean
language sql stable security definer set search_path='' as $$
 select private.support_is_staff(auth.uid())
$$;
revoke all on function private.support_is_staff(uuid) from public,anon,authenticated;
revoke all on function private.support_is_staff() from public,anon;
grant execute on function private.support_is_staff(uuid) to service_role;
grant execute on function private.support_is_staff() to authenticated,service_role;

create or replace function public.support_staff_state() returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('isStaff',private.support_is_staff(auth.uid()))
$$;
revoke all on function public.support_staff_state() from public,anon;
grant execute on function public.support_staff_state() to authenticated,service_role;

-- Enrollment happens only NOW, and only if exactly one confirmed, non-banned account already exists.
-- If it is not ready, complete verification and explicitly execute ../activate-owner-support.sql.
do $$
declare v_ids uuid[]; v_user uuid; v_changed uuid;
begin
 select array_agg(u.id) into v_ids from auth.users u
 where lower(u.email)='admin@example.com' and u.email_confirmed_at is not null
   and u.deleted_at is null and not coalesce(u.is_anonymous,false)
   and (u.banned_until is null or u.banned_until<=now());
 if coalesce(cardinality(v_ids),0)<>1 then
   raise warning 'Soporte de admin@example.com NO activado: debe existir exactamente una cuenta confirmada, no anónima y sin baneo. Confirmá y verificá la cuenta y ejecutá supabase/activate-owner-support.sql. No se promoverán registros futuros automáticamente.';
 else
   v_user:=v_ids[1];
   update public.support_staff set active=false,updated_at=now()
     where email='admin@example.com' and user_id<>v_user and active;
   insert into public.support_staff as s(user_id,email,note)
   values(v_user,'admin@example.com','Propietario: atención de tickets (migración 0016)')
   on conflict(user_id) do update set email=excluded.email,active=true,updated_at=now(),note=excluded.note
     where s.email is distinct from excluded.email or not s.active
   returning user_id into v_changed;
   if v_changed is not null then
     perform public.admin_log(null,null,'support.staffGranted',v_user,
       jsonb_build_object('email','admin@example.com','source','migration_0016','role','support'));
   end if;
   raise notice 'Soporte activado para la cuenta existente y confirmada admin@example.com (UUID %). No se concedieron privilegios de administración general.',v_user;
 end if;
end $$;

-- Existing administrator permissions remain intact. Only ticket rows/messages gain the staff reader.
drop policy if exists support_tickets_read on public.support_tickets;
create policy support_tickets_read on public.support_tickets for select to authenticated
 using(user_id=(select auth.uid()) or (select private.support_is_staff()));
drop policy if exists support_messages_read on public.support_messages;
create policy support_messages_read on public.support_messages for select to authenticated
 using(exists(select 1 from public.support_tickets t where t.id=ticket_id
   and (t.user_id=(select auth.uid()) or (select private.support_is_staff()))));
-- ai_paid_periods and all general administration policies/roles deliberately keep their existing scope.

create or replace function public.support_list_tickets(p_admin boolean default false) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_user uuid:=private.support_user(); v_result jsonb;
begin
 if coalesce(p_admin,false) and not private.support_is_staff(v_user) then
   raise exception 'Solo el equipo de soporte.' using errcode='42501';
 end if;
 select coalesce(jsonb_agg(private.support_ticket_json(t) order by case when t.status in ('open','in_progress') then 0 else 1 end,t.updated_at desc),'[]'::jsonb)
 into v_result from (select * from public.support_tickets s
   where coalesce(p_admin,false) or s.user_id=v_user
   order by case when status in ('open','in_progress') then 0 else 1 end,updated_at desc limit 200) t;
 return v_result;
end $$;

create or replace function public.support_ticket_detail(p_ticket uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_user uuid:=private.support_user(); v_ticket public.support_tickets%rowtype;
begin
 select * into v_ticket from public.support_tickets t where t.id=p_ticket
   and (t.user_id=v_user or private.support_is_staff(v_user));
 if not found then raise exception 'Ticket no disponible.' using errcode='42501'; end if;
 return jsonb_build_object('ticket',private.support_ticket_json(v_ticket),'messages',
   coalesce((select jsonb_agg(private.support_message_json(m) order by m.created_at,m.id)
   from public.support_messages m where m.ticket_id=p_ticket),'[]'::jsonb));
end $$;

create or replace function public.support_add_message(p_ticket uuid,p_body text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_user uuid:=private.support_user(); v_admin boolean:=private.support_is_staff(v_user);
 v_ticket public.support_tickets%rowtype; v_message public.support_messages%rowtype;
begin
 if p_body is null or char_length(btrim(p_body)) not between 1 and 4000 then
   raise exception 'Escribí un mensaje de hasta 4000 caracteres.' using errcode='22023';
 end if;
 select * into v_ticket from public.support_tickets where id=p_ticket and (user_id=v_user or v_admin) for update;
 if not found then raise exception 'Ticket no disponible.' using errcode='42501'; end if;
 if v_ticket.status not in ('open','in_progress') then raise exception 'El ticket ya está cerrado.' using errcode='22023'; end if;
 if (select count(*) from public.support_messages where author_id=v_user and created_at>now()-interval '1 minute')>=10 then
   raise exception 'Esperá un minuto antes de enviar más mensajes.' using errcode='54000';
 end if;
 if (select count(*) from public.support_messages where ticket_id=p_ticket)>=500 then
   raise exception 'El ticket alcanzó el límite de mensajes.' using errcode='54000';
 end if;
 insert into public.support_messages(ticket_id,author_id,is_admin,body)
 values(p_ticket,v_user,v_admin,btrim(p_body)) returning * into v_message;
 update public.support_tickets set updated_at=now(),status=case when v_admin then 'in_progress' else status end where id=p_ticket;
 return private.support_message_json(v_message);
end $$;

create or replace function public.support_resolve_ticket(p_ticket uuid,p_confirm_payment boolean,p_note text default '') returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_admin uuid:=private.support_user(); v_ticket public.support_tickets%rowtype;
 v_plan public.ai_plans%rowtype; v_until timestamptz; v_period uuid; v_email text;
begin
 if not private.support_is_staff(v_admin) then raise exception 'Solo el equipo de soporte.' using errcode='42501'; end if;
 if p_confirm_payment is null or char_length(coalesce(p_note,''))>2000 then
   raise exception 'Revisá la resolución del ticket.' using errcode='22023';
 end if;
 select * into v_ticket from public.support_tickets where id=p_ticket for update;
 if not found then raise exception 'Ticket no disponible.' using errcode='P0002'; end if;
 -- A repeated network request or double click returns the same completed result, without a new grant.
 if v_ticket.status='paid' and p_confirm_payment then return private.support_ticket_json(v_ticket); end if;
 if v_ticket.status='closed' and not p_confirm_payment then return private.support_ticket_json(v_ticket); end if;
 if v_ticket.status not in ('open','in_progress') then raise exception 'El ticket ya está cerrado.' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended(v_ticket.user_id::text,816));
 if p_confirm_payment then
   if nullif(btrim(p_note),'') is null or char_length(btrim(p_note))>200 then
     raise exception 'Ingresá la referencia del pago verificado (máximo 200 caracteres) antes de activar el plan.' using errcode='22023';
   end if;
   select * into v_plan from public.ai_plans where id=v_ticket.plan_id and active;
   if not found or v_plan.price_usd<>v_ticket.price_usd then
     raise exception 'El precio del plan cambió. Cerrá la solicitud y creá una nueva.' using errcode='22023';
   end if;
   -- A new verified full payment replaces the active period. History and pending reservations remain.
   v_until:=null; -- Credit does not expire; only another confirmed payment grants a new allocation.
   insert into public.ai_paid_periods(user_id,ticket_id,plan_id,starts_at,ends_at,budget_usd)
   values(v_ticket.user_id,v_ticket.id,v_plan.id,now(),v_until,v_plan.monthly_budget_usd) returning id into v_period;
   insert into public.ai_subscriptions(user_id,plan_id,status,current_period_end,source,external_ref,support_period_id)
   values(v_ticket.user_id,v_plan.id,'active',v_until,'support',v_ticket.id::text,v_period)
   on conflict(user_id) do update set plan_id=excluded.plan_id,status='active',current_period_end=v_until,
     source='support',external_ref=excluded.external_ref,support_period_id=v_period,
     stripe_customer_id=null,stripe_subscription_id=null,stripe_price_id=null,stripe_status=null,
     cancel_at_period_end=false,grace_until=null,budget_cap_usd=null,budget_cap_until=null,updated_at=now();
 end if;
 update public.support_tickets set status=case when p_confirm_payment then 'paid' else 'closed' end,
   payment_reference=case when p_confirm_payment then btrim(p_note) end,closed_at=now(),closed_by=v_admin,
   activated_until=v_until,updated_at=now() where id=p_ticket returning * into v_ticket;
 insert into public.support_messages(ticket_id,author_id,is_admin,body)
 values(p_ticket,v_admin,true,case when p_confirm_payment then 'Pago confirmado. Tu plan '||v_ticket.plan_name||' está activo. El saldo no vence y se renueva únicamente con otro pago confirmado.'
   else 'Solicitud cerrada sin activar un plan.'||case when nullif(btrim(p_note),'') is not null then ' '||btrim(p_note) else '' end end);
 select email into v_email from auth.users where id=v_admin;
 perform public.admin_log(v_admin,v_email,case when p_confirm_payment then 'support.paymentConfirmed' else 'support.closed' end,
   v_ticket.user_id,jsonb_build_object('actorRole',case when public.admin_is_admin_user(v_admin) then 'admin' else 'support' end,'ticketId',v_ticket.id,'plan',v_ticket.plan_id,'amountUsd',v_ticket.price_usd,
   'paymentMethod',v_ticket.payment_method,'periodId',v_period,'until',public.ai_iso(v_until)));
 return private.support_ticket_json(v_ticket);
end $$;

-- isAdmin is the historical message field: true means a response by authorized ticket staff.
comment on column public.support_messages.is_admin is 'Historical field name: true for a message by ticket support staff or a general administrator.';
revoke all on function public.support_list_tickets(boolean),public.support_ticket_detail(uuid),
 public.support_add_message(uuid,text),public.support_resolve_ticket(uuid,boolean,text) from public,anon;
grant execute on function public.support_list_tickets(boolean),public.support_ticket_detail(uuid),
 public.support_add_message(uuid,text),public.support_resolve_ticket(uuid,boolean,text) to authenticated;
