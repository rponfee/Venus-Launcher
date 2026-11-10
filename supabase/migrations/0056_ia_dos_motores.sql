-- 0056_ia_dos_motores.sql · Venus 6.1 · Venus IA con dos motores: planes de Claude y planes de ChatGPT.
-- Contrato: docs/implementacion/ia-dos-motores.md. Aplicar después de 0055. Idempotente.
--
-- Parte de producción tal como está el 10 de noviembre de 2026 (0001..0055 menos 0052, más
-- "allow_admin_ai_subscriptions_in_effective_plan"), leída con pg_get_functiondef: OpenAI era el único proveedor
-- (0049), los planes basic/go/pro/max usaban la clave interna 'haiku' apuntada a GPT-6 Luna, y había un solo saldo
-- por cuenta (ai_subscriptions.support_period_id -> ai_paid_periods).
--
-- Qué cambia:
--   * ai_plans.ai_provider ('anthropic' | 'openai') y ai_plans.tier (basic..ultra). Diez planes: cinco por motor.
--   * Las claves de modelo 'haiku' (rápido) y 'sonnet' (avanzado) valen para los dos motores: el modelo real lo
--     decide el motor del plan (Claude: Haiku 5.5 y Sonnet 5.5; ChatGPT: GPT-6 Luna y GPT-5.6 Sol).
--   * ai_wallets: un saldo por motor y por cuenta. ai_subscriptions sigue siendo "el saldo en uso".
--   * ai_register_turn elige el proveedor de la llamada, reserva según el pedido real, recorta max_tokens a lo que
--     alcanza el saldo y, si el saldo en uso no alcanza y el del otro motor sí, cambia solo y lo avisa (switched).
--   * La clave de Anthropic se carga desde Administración > Integraciones (Vault), igual que la de OpenAI.
--   * Esfuerzo nuevo: 'max'.
--   * Panel: "Quitar plan" también borra los saldos de la cuenta, y el Resumen cuenta todos los planes con nivel.
-- No toca saldos, compras ni uso ya registrados: los períodos pagados conservan su presupuesto y lo gastado.

-- ---------- 1) Planes: motor, nivel y límites ----------
alter table public.ai_plans add column if not exists ai_provider text not null default 'openai';
alter table public.ai_plans add column if not exists tier text;
alter table public.ai_plans drop constraint if exists ai_plans_ai_provider_check;
alter table public.ai_plans add constraint ai_plans_ai_provider_check check (ai_provider in ('anthropic', 'openai'));
alter table public.ai_plans drop constraint if exists ai_plans_tier_check;
alter table public.ai_plans add constraint ai_plans_tier_check check (tier is null or tier in ('basic', 'go', 'pro', 'max', 'ultra'));
alter table public.ai_plans drop constraint if exists ai_plans_max_tokens_per_request_check;
alter table public.ai_plans add constraint ai_plans_max_tokens_per_request_check
  check (max_tokens_per_request between 1000 and 128000);
alter table public.ai_plan_models drop constraint if exists ai_plan_models_efforts_check;
alter table public.ai_plan_models add constraint ai_plan_models_efforts_check
  check (cardinality(efforts) between 1 and 5 and efforts <@ array['low', 'medium', 'high', 'xhigh', 'max']::text[]);
comment on column public.ai_plans.ai_provider is 'Motor del plan: anthropic (Claude) u openai (ChatGPT). Decide a qué API va cada llamada.';
comment on column public.ai_plans.tier is 'Nivel de la oferta (basic..ultra). null = plan viejo: no se vende ni da acceso.';

-- Los planes viejos (free, plus, super, supreme) quedan sin nivel: ni se venden ni valen.
update public.ai_plans set ai_provider = case when model like 'claude-%' then 'anthropic' else 'openai' end where tier is null;

-- ---------- 2) Modelos y precios ----------
-- 'haiku' y 'sonnet' vuelven a ser las filas de Claude (0049 había rotulado 'haiku' como GPT-6 Luna). El costo de una
-- respuesta de OpenAI ya se cobra con la fila de su modelo (ai_add_usage busca por model_id).
update public.ai_models
   set model_id = 'claude-haiku-5-5', label = 'Haiku 5.5', active = true,
       input_usd_mtok = 0.10, output_usd_mtok = 0.50, cache_read_usd_mtok = 0.01, cache_write_usd_mtok = 0.125,
       long_context_threshold = 100000, long_input_usd_mtok = 0.50, long_output_usd_mtok = 2.50,
       long_cache_read_usd_mtok = 0.05, long_cache_write_usd_mtok = 0.625,
       price_note = 'Anthropic, noviembre de 2026. Pedidos de más de 100K tokens de entrada: 0,50 / 2,50. Caché estimada (0,1x y 1,25x).'
 where id = 'haiku';
update public.ai_models
   set model_id = 'claude-sonnet-5-5', label = 'Sonnet 5.5', active = true,
       input_usd_mtok = 2, output_usd_mtok = 10, cache_read_usd_mtok = 0.10, cache_write_usd_mtok = 2.50,
       long_context_threshold = null, long_input_usd_mtok = null, long_output_usd_mtok = null,
       long_cache_read_usd_mtok = null, long_cache_write_usd_mtok = null,
       price_note = 'Anthropic, noviembre de 2026.'
 where id = 'sonnet';
update public.ai_models set label = 'GPT-6 Luna' where id = 'gpt-6-luna';
insert into public.ai_models (id, model_id, provider, label, input_usd_mtok, output_usd_mtok, cache_read_usd_mtok, cache_write_usd_mtok,
                              long_context_threshold, long_input_usd_mtok, long_output_usd_mtok, long_cache_read_usd_mtok,
                              long_cache_write_usd_mtok, supports_fallback, price_note, sort, active)
values ('gpt-5-6-sol', 'gpt-5.6-sol', 'openai', 'GPT-5.6 Sol', 4, 20, 0.40, 5, 272000, 8, 30, 0.80, 10, false,
        'OpenAI Standard, 10/11/2026 (precio promocional hasta el 30/11/2026: verificar después). Más de 272K de entrada: 2x entrada, 1,5x salida.',
        125, false)
on conflict (id) do update
  set model_id = excluded.model_id, provider = excluded.provider, label = excluded.label,
      input_usd_mtok = excluded.input_usd_mtok, output_usd_mtok = excluded.output_usd_mtok,
      cache_read_usd_mtok = excluded.cache_read_usd_mtok, cache_write_usd_mtok = excluded.cache_write_usd_mtok,
      long_context_threshold = excluded.long_context_threshold, long_input_usd_mtok = excluded.long_input_usd_mtok,
      long_output_usd_mtok = excluded.long_output_usd_mtok, long_cache_read_usd_mtok = excluded.long_cache_read_usd_mtok,
      long_cache_write_usd_mtok = excluded.long_cache_write_usd_mtok, price_note = excluded.price_note;

-- Qué modelo de ChatGPT corresponde a cada clave, y cómo se traduce el esfuerzo (ahora también 'max').
alter table public.ai_tier_fallbacks add column if not exists effort_max text default 'xhigh';
alter table public.ai_tier_fallbacks drop constraint if exists ai_tier_fallbacks_effort_max_check;
alter table public.ai_tier_fallbacks add constraint ai_tier_fallbacks_effort_max_check
  check (effort_max is null or effort_max in ('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'));
update public.ai_tier_fallbacks
   set model_id = 'gpt-6-luna', effort_low = 'low', effort_medium = 'medium', effort_high = 'high', effort_xhigh = 'xhigh',
       effort_max = 'xhigh', active = true, note = 'ChatGPT: modelo rápido (GPT-6 Luna)'
 where tier = 'haiku';
update public.ai_tier_fallbacks
   set model_id = 'gpt-5-6-sol', effort_low = 'low', effort_medium = 'medium', effort_high = 'high', effort_xhigh = 'xhigh',
       effort_max = 'max', active = true, note = 'ChatGPT: modelo avanzado (GPT-5.6 Sol)'
 where tier = 'sonnet';
update public.ai_tier_fallbacks set active = false, note = 'Sin uso: ningún plan ofrece Opus' where tier = 'opus';

-- ---------- 3) Los diez planes ----------
-- Precio, saldo de uso de la API y tokens por respuesta: la tabla del dueño (docs/implementacion/ia-dos-motores.md).
-- Los de ChatGPT conservan los ids de la 6.0.0. 'ultra' existía como plan viejo sin compras: pasa a ser el Ultra de ChatGPT.
insert into public.ai_plans (id, name, model, ai_provider, tier, price_usd, monthly_budget_usd, max_tokens_per_request,
                             max_calls_per_turn, requests_per_minute, sort, active, currency)
values
  ('basic',        'Basic', 'gpt-6-luna',       'openai',    'basic',  6,  3.50,  12000, 40, 30,  10, true, 'USD'),
  ('go',           'Go',    'gpt-6-luna',       'openai',    'go',    10,  6.75,  32000, 40, 30,  20, true, 'USD'),
  ('pro',          'Pro',   'gpt-6-luna',       'openai',    'pro',   18, 12.50,  44000, 60, 40,  30, true, 'USD'),
  ('max',          'Max',   'gpt-6-luna',       'openai',    'max',   32, 26.00,  78000, 60, 60,  40, true, 'USD'),
  ('ultra',        'Ultra', 'gpt-6-luna',       'openai',    'ultra', 40, 28.00, 128000, 60, 60,  50, true, 'USD'),
  ('claude_basic', 'Basic', 'claude-haiku-5-5', 'anthropic', 'basic',  6,  3.50,  12000, 40, 30, 110, true, 'USD'),
  ('claude_go',    'Go',    'claude-haiku-5-5', 'anthropic', 'go',    10,  6.75,  32000, 40, 30, 120, true, 'USD'),
  ('claude_pro',   'Pro',   'claude-haiku-5-5', 'anthropic', 'pro',   18, 12.50,  44000, 60, 40, 130, true, 'USD'),
  ('claude_max',   'Max',   'claude-haiku-5-5', 'anthropic', 'max',   32, 26.00,  78000, 60, 60, 140, true, 'USD'),
  ('claude_ultra', 'Ultra', 'claude-haiku-5-5', 'anthropic', 'ultra', 40, 32.00, 128000, 60, 60, 150, true, 'USD')
on conflict (id) do update
  set name = excluded.name, model = excluded.model, ai_provider = excluded.ai_provider, tier = excluded.tier,
      price_usd = excluded.price_usd, monthly_budget_usd = excluded.monthly_budget_usd,
      max_tokens_per_request = excluded.max_tokens_per_request, max_calls_per_turn = excluded.max_calls_per_turn,
      requests_per_minute = excluded.requests_per_minute, sort = excluded.sort, active = true, currency = 'USD';
create unique index if not exists ai_plans_offer on public.ai_plans (ai_provider, tier) where tier is not null;

delete from public.ai_plan_models where plan_id in (select id from public.ai_plans where tier is not null);
insert into public.ai_plan_models (plan_id, model_id, efforts, daily_questions, weekly_questions, sort)
values
  ('basic',        'haiku',  array['low'],                                   2147483647, 2147483647, 10),
  ('go',           'haiku',  array['low', 'medium', 'high'],                 2147483647, 2147483647, 10),
  ('pro',          'haiku',  array['low', 'medium', 'high'],                 2147483647, 2147483647, 10),
  ('max',          'haiku',  array['low', 'medium', 'high'],                 2147483647, 2147483647, 10),
  ('max',          'sonnet', array['low', 'medium', 'high'],                 2147483647, 2147483647, 20),
  ('ultra',        'haiku',  array['low', 'medium', 'high'],                 2147483647, 2147483647, 10),
  ('ultra',        'sonnet', array['low', 'medium', 'high'],                 2147483647, 2147483647, 20),
  ('claude_basic', 'haiku',  array['low', 'medium'],                         2147483647, 2147483647, 10),
  ('claude_go',    'haiku',  array['low', 'medium', 'high'],                 2147483647, 2147483647, 10),
  ('claude_pro',   'haiku',  array['low', 'medium', 'high'],                 2147483647, 2147483647, 10),
  ('claude_pro',   'sonnet', array['low', 'medium', 'high'],                 2147483647, 2147483647, 20),
  ('claude_max',   'haiku',  array['low', 'medium', 'high', 'xhigh'],        2147483647, 2147483647, 10),
  ('claude_max',   'sonnet', array['low', 'medium', 'high', 'xhigh'],        2147483647, 2147483647, 20),
  ('claude_ultra', 'haiku',  array['low', 'medium', 'high', 'xhigh', 'max'], 2147483647, 2147483647, 10),
  ('claude_ultra', 'sonnet', array['low', 'medium', 'high', 'xhigh', 'max'], 2147483647, 2147483647, 20);

create or replace function public.ai_effort_list(p_efforts text[]) returns jsonb
language sql immutable set search_path = '' as $$
 select coalesce(jsonb_agg(e.effort order by e.position), '[]'::jsonb)
 from unnest(array['low', 'medium', 'high', 'xhigh', 'max']::text[]) with ordinality e(effort, position)
 where e.effort = any(p_efforts)
$$;

-- Sin esfuerzo pedido: medio si el plan lo permite; si no, el permitido más cercano (0049 elegía siempre el más alto
-- porque cada plan tenía uno solo).
create or replace function public.ai_default_effort(p_efforts text[]) returns text
language sql immutable set search_path = '' as $$
  select case when 'medium' = any(p_efforts) then 'medium'
              when 'low' = any(p_efforts) then 'low'
              when 'high' = any(p_efforts) then 'high'
              when 'xhigh' = any(p_efforts) then 'xhigh'
              when 'max' = any(p_efforts) then 'max' end
$$;

-- El esfuerzo pedido, o el permitido más alto por debajo; si no hay ninguno por debajo, el más bajo permitido.
create or replace function private.ai_fit_effort(p_efforts text[], p_effort text) returns text
language sql immutable set search_path = '' as $$
  with ord as (select e.effort, e.position from unnest(array['low', 'medium', 'high', 'xhigh', 'max']::text[]) with ordinality e(effort, position)),
       want as (select coalesce((select o.position from ord o where o.effort = p_effort), 2) as position)
  select coalesce(
    (select o.effort from ord o, want w where o.effort = any(p_efforts) and o.position <= w.position order by o.position desc limit 1),
    (select o.effort from ord o where o.effort = any(p_efforts) order by o.position limit 1))
$$;

-- ---------- 4) Clave de Anthropic en Vault (igual que la de OpenAI, 0050) ----------
create or replace function public.admin_anthropic_status() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v text;
begin
  if not public.admin_is_admin_user(auth.uid()) then
    raise exception 'admin_only' using errcode = '42501';
  end if;
  select nullif(d.decrypted_secret, '') into v
    from vault.decrypted_secrets d where d.name = 'venus_anthropic_key';
  return jsonb_build_object('configured', v is not null,
    'hint', case when v is null then null else right(v, 4) end);
end $$;

create or replace function public.admin_set_anthropic_key(p_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); v_key text := btrim(coalesce(p_key, '')); v_id uuid;
begin
  if not public.admin_is_admin_user(me) then
    raise exception 'admin_only' using errcode = '42501';
  end if;
  if v_key <> '' and (length(v_key) not between 20 and 300 or v_key !~ '^sk-ant-[A-Za-z0-9_-]+$') then
    raise exception 'bad_key' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(437050, 2);
  select id into v_id from vault.secrets where name = 'venus_anthropic_key';
  if v_key = '' then
    if v_id is not null then delete from vault.secrets where id = v_id; end if;
  elsif v_id is null then
    perform vault.create_secret(v_key, 'venus_anthropic_key', 'Venus IA: Anthropic');
  else
    perform vault.update_secret(v_id, v_key, 'venus_anthropic_key', 'Venus IA: Anthropic');
  end if;
  perform public.admin_log(me, (select email from auth.users where id = me),
    'anthropic.key', null, jsonb_build_object('configured', v_key <> ''));
  return jsonb_build_object('configured', v_key <> '',
    'hint', case when v_key = '' then null else right(v_key, 4) end);
end $$;

create or replace function public.ai_anthropic_key() returns text
language sql stable security definer set search_path = '' as $$
  select nullif(d.decrypted_secret, '') from vault.decrypted_secrets d
   where d.name = 'venus_anthropic_key' limit 1
$$;

revoke all on function public.admin_anthropic_status(), public.admin_set_anthropic_key(text), public.ai_anthropic_key()
  from public, anon, authenticated;
grant execute on function public.admin_anthropic_status(), public.admin_set_anthropic_key(text) to authenticated;
grant execute on function public.ai_anthropic_key() to service_role;

-- ---------- 5) Saldos: uno por motor ----------
create table if not exists public.ai_wallets (
  user_id uuid not null references auth.users (id) on delete cascade,
  ai_provider text not null check (ai_provider in ('anthropic', 'openai')),
  plan_id text not null references public.ai_plans (id) on update cascade,
  period_id uuid not null references public.ai_paid_periods (id),
  updated_at timestamptz not null default now(),
  primary key (user_id, ai_provider)
);
create index if not exists ai_wallets_period on public.ai_wallets (period_id);
comment on table public.ai_wallets is 'Saldo pagado de cada motor por cuenta. El que está en uso es el de ai_subscriptions.support_period_id.';
alter table public.ai_wallets enable row level security;
revoke all on public.ai_wallets from public, anon, authenticated;
grant select on public.ai_wallets to authenticated;
grant all on public.ai_wallets to service_role;
drop policy if exists ai_wallets_read on public.ai_wallets;
create policy ai_wallets_read on public.ai_wallets for select to authenticated using (user_id = (select auth.uid()));

-- Los saldos que ya existían (todos de ChatGPT) pasan a ser el saldo de su motor.
insert into public.ai_wallets (user_id, ai_provider, plan_id, period_id)
select s.user_id, p.ai_provider, s.plan_id, s.support_period_id
  from public.ai_subscriptions s
  join public.ai_plans p on p.id = s.plan_id
  join public.ai_paid_periods pp on pp.id = s.support_period_id and pp.user_id = s.user_id
 where s.source = 'support'
on conflict (user_id, ai_provider) do nothing;

-- Plan del saldo de un motor si VALE (mismas condiciones que ai_effective_plan para un saldo pagado), o null.
create or replace function private.ai_wallet_plan(p_user uuid, p_provider text) returns text
language sql stable security definer set search_path = '' as $$
  select w.plan_id
    from public.ai_wallets w
    join public.ai_plans p on p.id = w.plan_id and p.active and p.tier is not null and p.ai_provider = w.ai_provider
    join public.ai_paid_periods pp on pp.id = w.period_id and pp.user_id = w.user_id and pp.plan_id = w.plan_id
   where w.user_id = p_user and w.ai_provider = p_provider
     and (pp.ends_at is null or pp.ends_at > now())
     and (exists (select 1 from public.support_tickets t
                   where t.id = pp.ticket_id and t.user_id = w.user_id and t.plan_id = w.plan_id and t.status = 'paid')
       or exists (select 1 from public.payment_orders o
                   where o.id = pp.order_id and o.user_id = w.user_id and o.plan_id = w.plan_id and o.status = 'paid'))
$$;

-- Lo que le queda a un saldo (presupuesto - gastado - reservado por llamadas en curso). 0 si el saldo no vale.
create or replace function private.ai_wallet_left(p_user uuid, p_provider text) returns numeric
language sql stable security definer set search_path = '' as $$
  select case when private.ai_wallet_plan(p_user, p_provider) is null then 0 else coalesce((
    select greatest(0, pp.budget_usd - pp.spent_usd - coalesce((
             select sum(c.reserved_usd) from public.ai_call_reservations c
              where c.user_id = p_user and c.period_id = pp.id and c.status = 'reserved'), 0))
      from public.ai_wallets w join public.ai_paid_periods pp on pp.id = w.period_id
     where w.user_id = p_user and w.ai_provider = p_provider), 0) end
$$;

-- Pone un saldo como "en uso": ai_subscriptions pasa a apuntar a su plan y a su período. Un plan dado a mano por un
-- administrador que sigue vigente no se pisa (ni por el cambio automático ni por el usuario): su presupuesto es por
-- mes y vuelve a servir al mes siguiente. Cuando vence o se quita, el saldo pagado se puede usar.
create or replace function private.ai_wallet_activate(p_user uuid, p_provider text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare w public.ai_wallets%rowtype;
begin
  if exists (select 1 from public.ai_subscriptions s where s.user_id = p_user and s.source = 'admin')
     and public.ai_effective_plan(p_user) is not null then
    return false;
  end if;
  if private.ai_wallet_plan(p_user, p_provider) is null then return false; end if;
  select * into w from public.ai_wallets where user_id = p_user and ai_provider = p_provider;
  insert into public.ai_subscriptions (user_id, plan_id, status, current_period_end, source, support_period_id)
  values (p_user, w.plan_id, 'active', null, 'support', w.period_id)
  on conflict (user_id) do update
    set plan_id = excluded.plan_id, status = 'active', current_period_end = null, source = 'support',
        support_period_id = excluded.support_period_id, stripe_customer_id = null, stripe_subscription_id = null,
        stripe_price_id = null, stripe_status = null, cancel_at_period_end = false, grace_until = null,
        budget_cap_usd = null, budget_cap_until = null, updated_at = now();
  return true;
end $$;

-- Fila de precio (y id de la API) del modelo real de una clave en un motor. Sin fila = ese motor no ofrece la clave.
create or replace function private.ai_model_for(p_provider text, p_key text) returns public.ai_models
language sql stable security definer set search_path = '' as $$
  select m.* from public.ai_models m
   where p_provider = 'anthropic' and m.id = p_key and m.provider = 'anthropic' and m.active
  union all
  select m.* from public.ai_tier_fallbacks f join public.ai_models m on m.id = f.model_id and m.provider = 'openai'
   where p_provider = 'openai' and f.tier = p_key and f.active
  limit 1
$$;

-- Costo máximo de una llamada: toda la entrada al precio más caro que puede tener (escritura de caché, y la tarifa
-- de contexto largo si la cota de entrada pasa el umbral) más toda la salida pedida.
create or replace function private.ai_reserve_usd(p_provider text, p_key text, p_max_tokens integer, p_input_tokens integer) returns numeric
language sql stable security definer set search_path = '' as $$
  select ceil((
      greatest(coalesce(p_input_tokens, 500000), 0)::numeric
        * case when m.long_context_threshold is not null and coalesce(p_input_tokens, 500000) > m.long_context_threshold
               then greatest(m.long_input_usd_mtok, coalesce(m.long_cache_write_usd_mtok, 0))
               else greatest(m.input_usd_mtok, coalesce(m.cache_write_usd_mtok, 0)) end
    + greatest(coalesce(p_max_tokens, 0), 0)::numeric
        * case when m.long_context_threshold is not null and coalesce(p_input_tokens, 500000) > m.long_context_threshold
               then m.long_output_usd_mtok else m.output_usd_mtok end
    )) / 1000000
    from private.ai_model_for(p_provider, p_key) m
   where m.id is not null
$$;

-- Tokens de salida que se pueden conceder con lo que queda: el pedido entero si alcanza, menos si no, y 0 si no
-- alcanza ni para el mínimo útil (2.048, o el pedido si pedía menos).
create or replace function private.ai_afford_tokens(p_provider text, p_key text, p_want integer, p_input_tokens integer, p_left numeric) returns integer
language plpgsql stable security definer set search_path = '' as $$
declare v_fixed numeric; v_one numeric; v_afford numeric; v_min integer := least(greatest(p_want, 1), 2048);
begin
  v_fixed := private.ai_reserve_usd(p_provider, p_key, 0, p_input_tokens);
  if v_fixed is null or p_left is null then return 0; end if;
  -- Precio de un token de salida (la diferencia entre reservar un millón y ninguno).
  v_one := (private.ai_reserve_usd(p_provider, p_key, 1000000, p_input_tokens) - v_fixed) / 1000000;
  if p_left - v_fixed - 0.000002 <= 0 then return 0; end if;
  v_afford := case when v_one <= 0 then p_want else floor((p_left - v_fixed - 0.000002) / v_one) end;
  if v_afford < v_min then return 0; end if;
  return least(greatest(p_want, 1), v_afford)::integer;
end $$;

-- ¿El motor tiene su clave cargada en Administración > Integraciones (Vault)? Sin clave, ese motor no se ofrece para
-- comprar ni se elige solo al cambiar de saldo.
create or replace function private.ai_provider_ready(p_provider text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from vault.decrypted_secrets d
                  where d.name = case p_provider when 'anthropic' then 'venus_anthropic_key' when 'openai' then 'venus_openai_key' end
                    and nullif(d.decrypted_secret, '') is not null)
$$;

-- Clave de modelo que le corresponde a un plan: la pedida si el plan la tiene (y su motor la ofrece); si no, la
-- primera del plan.
create or replace function private.ai_plan_key(p_plan text, p_key text) returns text
language sql stable security definer set search_path = '' as $$
  select pm.model_id
    from public.ai_plan_models pm
    join public.ai_plans p on p.id = pm.plan_id
    join public.ai_models m on m.id = pm.model_id and m.active
   where pm.plan_id = p_plan and (private.ai_model_for(p.ai_provider, pm.model_id)).id is not null
   order by (pm.model_id = p_key) desc, pm.sort, m.sort, m.id
   limit 1
$$;

revoke all on function private.ai_fit_effort(text[], text), private.ai_wallet_plan(uuid, text), private.ai_wallet_left(uuid, text),
  private.ai_wallet_activate(uuid, text), private.ai_model_for(text, text), private.ai_reserve_usd(text, text, integer, integer),
  private.ai_afford_tokens(text, text, integer, integer, numeric), private.ai_plan_key(text, text),
  private.ai_provider_ready(text)
  from public, anon, authenticated;

-- ---------- 6) Plan vigente, cuota y catálogo ----------
-- Igual que en producción, con el nivel en lugar de la lista fija de ids.
create or replace function public.ai_effective_plan(p_user uuid) returns text
language sql stable security definer set search_path = '' as $$
  select s.plan_id
    from public.ai_subscriptions s
    join public.ai_plans p
      on p.id = s.plan_id
     and p.active
     and p.tier is not null
    left join public.ai_paid_periods allocation
      on allocation.id = s.support_period_id
     and allocation.user_id = s.user_id
     and allocation.plan_id = s.plan_id
   where s.user_id = p_user
     and s.status = 'active'
     and (s.current_period_end is null or s.current_period_end > now())
     and (
       s.source = 'admin'
       or (
         s.source = 'support'
         and allocation.id is not null
         and (allocation.ends_at is null or allocation.ends_at > now())
         and (
           exists (
             select 1
               from public.support_tickets ticket
              where ticket.id = allocation.ticket_id
                and ticket.user_id = s.user_id
                and ticket.plan_id = s.plan_id
                and ticket.status = 'paid'
           )
           or exists (
             select 1
               from public.payment_orders o
              where o.id = allocation.order_id
                and o.user_id = s.user_id
                and o.plan_id = s.plan_id
                and o.status = 'paid'
           )
         )
       )
     )
   limit 1
$$;

-- Saldos válidos de la cuenta, para la cuota.
create or replace function private.ai_wallets_json(p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'provider', w.ai_provider, 'plan', w.plan_id, 'planName', p.name, 'tier', p.tier,
           'usedUsd', round(pp.spent_usd, 4), 'limitUsd', pp.budget_usd,
           'remainingUsd', round(greatest(0, pp.budget_usd - pp.spent_usd), 4),
           'active', coalesce(s.source = 'support' and s.support_period_id = w.period_id, false)
         ) order by (w.ai_provider = 'anthropic') desc), '[]'::jsonb)
    from public.ai_wallets w
    join public.ai_plans p on p.id = w.plan_id
    join public.ai_paid_periods pp on pp.id = w.period_id
    left join public.ai_subscriptions s on s.user_id = w.user_id
   where w.user_id = p_user and private.ai_wallet_plan(w.user_id, w.ai_provider) is not null
$$;
revoke all on function private.ai_wallets_json(uuid) from public, anon, authenticated;

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

    -- La etiqueta y providerModel son del modelo REAL del motor del plan (haiku = Haiku 5.5 o GPT-6 Luna). "model"
    -- sigue siendo el id de Claude de la clave: la Edge Function de la 6.0.0 descarta los modelos que no lo traen.
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', m.id,
             'model', m.model_id,
             'providerModel', r.model_id,
             'label', r.label,
             'efforts', public.ai_effort_list(pm.efforts),
             'daily', jsonb_build_object('used', coalesce(u.used_today, 0), 'limit', pm.daily_questions),
             'weekly', jsonb_build_object('used', coalesce(u.used_week, 0), 'limit', pm.weekly_questions)
           ) order by pm.sort, m.sort, m.id), '[]'::jsonb)
      into v_models
      from public.ai_plan_models pm
      join public.ai_models m on m.id = pm.model_id and m.active
      join lateral private.ai_model_for(v_plan.ai_provider, pm.model_id) r on r.id is not null
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

  v_spent := coalesce(private.ai_current_spend(p_user), 0);

  return jsonb_build_object(
    'plan', v_plan_id,
    'planName', v_plan.name,
    'priceUsd', v_plan.price_usd,
    'provider', v_plan.ai_provider,
    'tier', v_plan.tier,
    'maxTokensPerRequest', v_plan.max_tokens_per_request,
    'status', v_status,
    'models', v_models,
    'budget', jsonb_build_object('usedUsd', round(v_spent, 4), 'limitUsd', coalesce(public.ai_budget_limit(p_user, v_plan_id), 0)),
    'wallets', private.ai_wallets_json(p_user),
    'resets', jsonb_build_object(
      'daily', public.ai_iso((v_today + 1)::timestamp at time zone v_tz),
      'weekly', public.ai_iso((v_week + 7)::timestamp at time zone v_tz),
      'monthly', case when exists (select 1 from public.ai_subscriptions s where s.user_id = p_user and s.source = 'support') then null
        else public.ai_iso((v_month + interval '1 month') at time zone v_tz) end
    ),
    'timezone', v_tz,
    'lastModel', v_last
  );
end $$;

create or replace function public.ai_catalog() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id,
           'name', p.name,
           'provider', p.ai_provider,
           'tier', p.tier,
           'available', private.ai_provider_ready(p.ai_provider),
           'priceUsd', p.price_usd,
           'budgetUsd', p.monthly_budget_usd,
           'maxTokensPerRequest', p.max_tokens_per_request,
           'models', (
             select coalesce(jsonb_agg(jsonb_build_object(
                      'id', m.id,
                      'label', r.label,
                      'efforts', public.ai_effort_list(pm.efforts),
                      'daily', pm.daily_questions,
                      'weekly', pm.weekly_questions
                    ) order by pm.sort, m.sort, m.id), '[]'::jsonb)
               from public.ai_plan_models pm
               join public.ai_models m on m.id = pm.model_id and m.active
               join lateral private.ai_model_for(p.ai_provider, pm.model_id) r on r.id is not null
              where pm.plan_id = p.id
           )
         ) order by p.sort, p.id), '[]'::jsonb)
    from public.ai_plans p
   where p.active and p.tier is not null
$$;

-- Configuración de proveedores para la Edge Function: el proveedor de cada llamada ya no sale de acá (lo decide el
-- saldo, ai_register_turn); queda el respaldo opcional entre proveedores (ai_provider_config, apagado) y el mapa de
-- modelos de cada motor.
create or replace function public.ai_provider_settings() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'primary', c.primary_provider, 'secondary', c.secondary_provider,
    'failoverEnabled', c.failover_enabled, 'failoverOn', to_jsonb(c.failover_on),
    'openai', coalesce((
      select jsonb_object_agg(f.tier, jsonb_build_object(
        'model', m.model_id,
        'efforts', jsonb_build_object('low', f.effort_low, 'medium', f.effort_medium, 'high', f.effort_high,
          'xhigh', f.effort_xhigh, 'max', f.effort_max)))
        from public.ai_tier_fallbacks f
        join public.ai_models m on m.id = f.model_id and m.provider = 'openai'
       where f.active and f.provider = 'openai'
    ), '{}'::jsonb),
    'anthropic', coalesce((
      select jsonb_object_agg(m.id, jsonb_build_object('model', m.model_id))
        from public.ai_models m
       where m.provider = 'anthropic' and m.active and m.id in ('haiku', 'sonnet')
    ), '{}'::jsonb))
    from public.ai_provider_config c
   where c.id = 'default'
$$;
revoke all on function public.ai_provider_settings() from public, anon, authenticated;
grant execute on function public.ai_provider_settings() to service_role;
update public.ai_provider_config
   set note = 'Venus IA 6.1: el proveedor de cada llamada lo decide el saldo (ai_register_turn). Esta fila solo gobierna el respaldo entre proveedores.'
 where id = 'default';

-- ---------- 7) Admisión de una llamada ----------
-- Firma nueva (dos parámetros opcionales al final): la Edge Function vieja, que manda cuatro, sigue funcionando.
drop function if exists public.ai_register_turn(uuid, text, text, text);
create or replace function public.ai_register_turn(p_user uuid, p_turn text, p_model text, p_effort text,
                                                   p_max_tokens integer default null, p_input_bytes integer default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamp := public.ai_local_now();
  v_today date := v_now::date;
  v_week date := date_trunc('week', v_now)::date;
  v_plan_id text;
  v_plan public.ai_plans%rowtype;
  v_pm public.ai_plan_models%rowtype;
  v_info public.ai_models%rowtype;
  v_real public.ai_models%rowtype;
  v_fb public.ai_tier_fallbacks%rowtype;
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
  v_left numeric;
  v_week_before bigint;
  v_today_questions integer;
  v_rows integer;
  v_reason text;
  v_counted boolean := false;
  v_reserved numeric := 0;
  v_reserve numeric;
  v_call uuid;
  v_period uuid;
  v_source text;
  v_want integer;
  v_grant integer := 0;
  v_in integer;
  v_pass integer := 0;
  v_from text;
  v_to text;
  v_to_plan text;
  v_to_key text;
  v_switched jsonb;
  v_moved boolean := false;
  v_refit boolean := false;
begin
  if p_user is null or p_turn is null or char_length(p_turn) not between 1 and 100 then
    raise exception 'ai_register_turn: parámetros inválidos' using errcode = '22023';
  end if;
  if p_model is not null and char_length(p_model) not between 1 and 32 then
    raise exception 'ai_register_turn: modelo inválido' using errcode = '22023';
  end if;
  if p_effort is not null and p_effort not in ('low', 'medium', 'high', 'xhigh', 'max') then
    raise exception 'ai_register_turn: esfuerzo inválido' using errcode = '22023';
  end if;
  if (p_max_tokens is not null and p_max_tokens not between 1 and 1000000)
     or (p_input_bytes is not null and p_input_bytes not between 0 and 100000000) then
    raise exception 'ai_register_turn: tamaño inválido' using errcode = '22023';
  end if;
  -- Cota de los tokens de entrada: un token ocupa al menos un byte del pedido; se suma el margen de la política y
  -- del formato de las herramientas. Sin el dato (función vieja), el peor caso de siempre.
  v_in := least(coalesce(p_input_bytes + 8000, 500000), 500000);

  -- Serialize admission, settlement and payment activation for this account.
  perform pg_advisory_xact_lock(hashtextextended(p_user::text, 816));
  -- A crashed or disconnected Edge worker must not block the account forever.
  update public.ai_call_reservations
     set status = 'released', settled_at = now()
   where user_id = p_user and status = 'reserved'
     and created_at < now() - interval '5 minutes';

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
  if v_model is null then
    v_model := v_turn_model;
  end if;

  -- 1) Plan vigente. Si el plan en uso dejó de valer (por ejemplo, una devolución) y la cuenta tiene otro saldo
  --    válido con fondos (de un motor con su clave cargada), pasa a ese.
  v_plan_id := public.ai_effective_plan(p_user);
  if v_plan_id is null then
    select w.ai_provider into v_to
      from public.ai_wallets w
     where w.user_id = p_user and private.ai_wallet_left(p_user, w.ai_provider) > 0
       and private.ai_provider_ready(w.ai_provider)
     order by private.ai_wallet_left(p_user, w.ai_provider) desc
     limit 1;
    if v_to is not null then
      select p.ai_provider into v_from
        from public.ai_subscriptions s join public.ai_plans p on p.id = s.plan_id
       where s.user_id = p_user;
      if private.ai_wallet_activate(p_user, v_to) then
        v_plan_id := public.ai_effective_plan(p_user);
        v_moved := v_plan_id is not null;
        if v_moved and v_from is not null and v_from <> v_to then
          v_switched := jsonb_build_object('from', v_from, 'to', v_to, 'reason', 'noplan');
        end if;
      end if;
    end if;
  end if;
  if v_plan_id is null then
    v_reason := 'noplan';
  end if;

  -- Hasta dos pasadas: la segunda solo si en la primera el saldo en uso no alcanzó y se pasó al otro.
  while v_reason is null loop
    v_pass := v_pass + 1;
    select p.* into v_plan from public.ai_plans p where p.id = v_plan_id;
    select s.source, case when s.source = 'support' then s.support_period_id end
      into v_source, v_period
      from public.ai_subscriptions s where s.user_id = p_user;

    -- 2) Modelo: el pedido, el de la pregunta abierta o el primero del plan. Tiene que estar en el plan y el motor
    --    del plan tiene que ofrecerlo. Después de cambiar de saldo, si el plan nuevo no lo tiene, va el primero. Una
    --    pregunta ya abierta cuyo modelo pedido no está en el plan en uso (porque una llamada anterior pasó al otro
    --    saldo) se ajusta a ese plan en vez de rechazarse: el launcher repite el modelo del principio del turno.
    if v_turn_found and not v_moved and v_model is not null
       and private.ai_plan_key(v_plan_id, v_model) is distinct from v_model then
      v_refit := true;
      v_model := private.ai_plan_key(v_plan_id, coalesce(v_turn_model, v_model));
    elsif v_model is null or v_moved then
      v_model := private.ai_plan_key(v_plan_id, v_model);
    end if;
    select pm.* into v_pm
      from public.ai_plan_models pm
      join public.ai_models m on m.id = pm.model_id and m.active
     where pm.plan_id = v_plan_id
       and pm.model_id = v_model;
    if found then
      select m.* into v_info from public.ai_models m where m.id = v_model;
      v_real := private.ai_model_for(v_plan.ai_provider, v_model);
    end if;
    if v_pm.model_id is null or v_real.id is null then
      v_reason := 'model';
      exit;
    end if;

    -- 3) Esfuerzo. Después de cambiar de saldo (en esta llamada o en una anterior de la misma pregunta) se ajusta al
    --    permitido más parecido.
    if v_effort is null then
      v_effort := public.ai_default_effort(v_pm.efforts);
    elsif v_moved or v_turn_found then
      v_effort := private.ai_fit_effort(v_pm.efforts, v_effort);
    end if;
    if v_effort is null or not (v_effort = any (v_pm.efforts)) then
      v_reason := 'effort';
      exit;
    end if;

    if v_pass = 1 then
      -- 4) Una pregunta abierta sigue con su modelo (cambiar de modelo es una pregunta nueva).
      if v_turn_found and v_turn_model is not null and v_turn_model <> v_model and not v_moved and not v_refit then
        v_reason := 'turn_model';
        exit;
      end if;

      -- 5) Ráfaga y llamadas en curso (cuenta también los intentos que después se rechazan por presupuesto o cupo).
      --    La fila de ai_rate queda bloqueada hasta el final: dos pedidos simultáneos no pasan juntos este control.
      insert into public.ai_rate as r (user_id, window_start, calls)
      values (p_user, now(), 1)
      on conflict (user_id) do update
        set window_start = case when r.window_start > now() - interval '1 minute' then r.window_start else now() end,
            calls = case when r.window_start > now() - interval '1 minute' then r.calls + 1 else 1 end
      returning r.calls, (select count(*)::integer from public.ai_call_reservations c where c.user_id = p_user and c.status = 'reserved')
        into v_minute_calls, v_inflight;
      if v_minute_calls > v_plan.requests_per_minute or v_inflight >= 3 then
        v_reason := 'rate';
        exit;
      end if;
    end if;

    -- 6) Saldo. La reserva es el costo máximo de ESTA llamada (su entrada y la salida pedida). Si no alcanza para
    --    toda la salida pedida, se concede la que alcanza; si no alcanza ni para el mínimo, se prueba el otro saldo.
    v_want := least(v_plan.max_tokens_per_request, coalesce(p_max_tokens, v_plan.max_tokens_per_request));
    v_spent := coalesce(private.ai_current_spend(p_user), 0);
    v_budget := coalesce(public.ai_budget_limit(p_user, v_plan_id), 0);
    select coalesce(sum(c.reserved_usd), 0) into v_reserved from public.ai_call_reservations c
     where c.user_id = p_user and c.status = 'reserved' and c.period_id is not distinct from v_period;
    v_left := v_budget - v_spent - v_reserved;
    v_grant := private.ai_afford_tokens(v_plan.ai_provider, v_model, v_want, v_in, v_left);
    exit when v_grant > 0;

    if v_pass = 1 and not v_moved then
      -- Otro saldo válido (el del otro motor) que pueda pagarla. Un plan dado a mano vigente no se reemplaza
      -- (ai_wallet_activate devuelve false): responde 'budget' y vuelve a servir al mes siguiente.
      select w.ai_provider, w.plan_id into v_to, v_to_plan
        from public.ai_wallets w
       where w.user_id = p_user
         and w.period_id is distinct from v_period
         and private.ai_wallet_plan(p_user, w.ai_provider) is not null
         and private.ai_provider_ready(w.ai_provider)
       order by private.ai_wallet_left(p_user, w.ai_provider) desc
       limit 1;
      if v_to is not null then
        v_to_key := private.ai_plan_key(v_to_plan, v_model);
        if v_to_key is not null and private.ai_afford_tokens(v_to, v_to_key,
             least((select p.max_tokens_per_request from public.ai_plans p where p.id = v_to_plan),
                   coalesce(p_max_tokens, 2147483647)),
             v_in, private.ai_wallet_left(p_user, v_to)) > 0
           and private.ai_wallet_activate(p_user, v_to) then
          if v_to <> v_plan.ai_provider then
            v_switched := jsonb_build_object('from', v_plan.ai_provider, 'to', v_to, 'reason', 'budget');
          end if;
          v_moved := true;
          v_plan_id := v_to_plan;
          continue;
        end if;
      end if;
    end if;
    -- Con llamadas en curso el saldo puede alcanzar cuando terminen: que el launcher reintente.
    v_reason := case when v_reserved > 0 then 'rate' else 'budget' end;
  end loop;

  if v_reason is null then
    v_reserve := greatest(private.ai_reserve_usd(v_plan.ai_provider, v_model, v_grant, v_in), 0.000001);
  end if;

  -- 7) Pregunta ya abierta.
  if v_reason is null and v_turn_found then
    if v_turn_calls >= v_plan.max_calls_per_turn then
      v_reason := 'turn';
    else
      update public.ai_turns t
         set calls = t.calls + 1,
             model_id = case when v_moved or v_refit then v_model else coalesce(t.model_id, v_model) end
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
    insert into public.ai_call_reservations (user_id, period_id, model_id, reserved_usd)
    values (p_user, v_period, v_model, v_reserve) returning id into v_call;
    -- La llamada permitida queda en curso hasta que la Edge Function la cierra (ai_add_usage o ai_end_call).
    update public.ai_rate r
       set inflight = coalesce(v_inflight, 0) + 1,
           inflight_at = now()
     where r.user_id = p_user;
    select f.* into v_fb from public.ai_tier_fallbacks f where f.tier = v_model and f.active;
  end if;

  return jsonb_build_object(
    'allowed', v_reason is null,
    'callId', v_call,
    'reason', v_reason,
    'model', v_model,
    'provider', v_plan.ai_provider,
    -- modelId: siempre el id de Claude de la clave (la Edge Function de la 6.0.0 lo exige). El de la llamada es models[provider].
    'modelId', case when v_reason is null then v_info.model_id end,
    'models', case when v_reason is null then jsonb_build_object(
        'anthropic', case when v_info.provider = 'anthropic' then v_info.model_id end,
        'openai', (private.ai_model_for('openai', v_model)).model_id) end,
    'openaiEffort', case when v_reason is null then
        case v_effort when 'low' then v_fb.effort_low when 'medium' then v_fb.effort_medium when 'high' then v_fb.effort_high
                      when 'xhigh' then v_fb.effort_xhigh when 'max' then v_fb.effort_max end end,
    'fallback', false,
    'effort', v_effort,
    'counted', v_counted,
    'maxTokensPerRequest', case when v_reason is null then v_grant else coalesce(v_plan.max_tokens_per_request, 0) end,
    'switched', v_switched,
    'quota', public.ai_quota_status(p_user)
  );
end $$;
revoke all on function public.ai_register_turn(uuid, text, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.ai_register_turn(uuid, text, text, text, integer, integer) to service_role;

-- ---------- 7b) Cierre de una llamada ----------
-- Igual que en 0053, con un parámetro opcional al final: la reserva exacta que se cierra (callId de ai_register_turn).
-- La Edge Function de la 6.0.0, que no lo manda, sigue funcionando.
drop function if exists public.ai_add_usage(uuid, text, jsonb);
create or replace function public.ai_add_usage(p_user uuid, p_model text, p_usage jsonb, p_call uuid default null)
 returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_today date := public.ai_today();
  v_base public.ai_models%rowtype;
  v_price public.ai_models%rowtype;
  v_line jsonb;
  v_line_model text;
  v_target text;
  v_in bigint;
  v_out bigint;
  v_cache_read bigint;
  v_cache_write bigint;
  v_line_cost numeric;
  v_idx integer;
  v_ids text[] := array[]::text[];
  v_sum_in bigint[] := array[]::bigint[];
  v_sum_out bigint[] := array[]::bigint[];
  v_sum_cache_read bigint[] := array[]::bigint[];
  v_sum_cache_write bigint[] := array[]::bigint[];
  v_sum_cost numeric[] := array[]::numeric[];
  v_cost numeric := 0;
  v_unpriced jsonb := '[]'::jsonb;
  v_call uuid;
  v_period uuid;
begin
  if p_user is null or p_model is null then
    raise exception 'ai_add_usage: parámetros inválidos' using errcode = '22023';
  end if;
  if p_usage is null or jsonb_typeof(p_usage) <> 'array' or jsonb_array_length(p_usage) > 50 then
    raise exception 'ai_add_usage: uso inválido' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user::text,816));
  select m.* into v_base from public.ai_models m where m.id = p_model;
  if not found then
    raise exception 'ai_add_usage: modelo desconocido' using errcode = '22023';
  end if;

  -- La llamada deja de estar en curso. Va primero: el mismo orden de bloqueo que ai_register_turn (ai_rate antes
  -- que el uso del día), así dos pedidos del mismo usuario no se bloquean entre sí.
  update public.ai_rate r
     set inflight = case when r.inflight_at > now() - interval '150 seconds' then greatest(r.inflight - 1, 0) else 0 end
   where r.user_id = p_user
     and r.inflight > 0;

  for v_line in select e.item from jsonb_array_elements(p_usage) as e (item) loop
    continue when jsonb_typeof(v_line) <> 'object';
    v_in := public.ai_token_count(v_line -> 'input');
    v_out := public.ai_token_count(v_line -> 'output');
    v_cache_read := public.ai_token_count(v_line -> 'cacheRead');
    v_cache_write := public.ai_token_count(v_line -> 'cacheWrite');
    v_line_model := left(v_line ->> 'model', 64);

    select m.* into v_price from public.ai_models m where m.model_id = v_line_model;
    if not found then
      v_price := v_base;
      if v_line_model is not null and not (v_unpriced ? v_line_model) then
        v_unpriced := v_unpriced || to_jsonb(v_line_model);
      end if;
    end if;

    v_line_cost := public.ai_price_line(v_price, v_in, v_out, v_cache_read, v_cache_write);
    v_cost := v_cost + v_line_cost;

    -- OpenAI: en la fila de su modelo. Anthropic (y los modelos sin precio): en la del modelo de la pregunta.
    v_target := case when v_price.provider = 'openai' then v_price.id else p_model end;
    v_idx := array_position(v_ids, v_target);
    if v_idx is null then
      v_ids := v_ids || v_target;
      v_sum_in := v_sum_in || v_in;
      v_sum_out := v_sum_out || v_out;
      v_sum_cache_read := v_sum_cache_read || v_cache_read;
      v_sum_cache_write := v_sum_cache_write || v_cache_write;
      v_sum_cost := v_sum_cost || v_line_cost;
    else
      v_sum_in[v_idx] := v_sum_in[v_idx] + v_in;
      v_sum_out[v_idx] := v_sum_out[v_idx] + v_out;
      v_sum_cache_read[v_idx] := v_sum_cache_read[v_idx] + v_cache_read;
      v_sum_cache_write[v_idx] := v_sum_cache_write[v_idx] + v_cache_write;
      v_sum_cost[v_idx] := v_sum_cost[v_idx] + v_line_cost;
    end if;
  end loop;

  -- Sin intentos válidos, la llamada se cuenta igual en el modelo de la pregunta (como en 0008).
  if cardinality(v_ids) = 0 then
    v_ids := array[p_model];
    v_sum_in := array[0]::bigint[];
    v_sum_out := array[0]::bigint[];
    v_sum_cache_read := array[0]::bigint[];
    v_sum_cache_write := array[0]::bigint[];
    v_sum_cost := array[0]::numeric[];
  end if;

  for v_idx in 1 .. cardinality(v_ids) loop
    insert into public.ai_usage_model_daily as d (user_id, day, model_id, calls, input_tokens, output_tokens,
                                                  cache_read_tokens, cache_write_tokens, cost_usd)
    values (p_user, v_today, v_ids[v_idx], 1, v_sum_in[v_idx], v_sum_out[v_idx], v_sum_cache_read[v_idx],
            v_sum_cache_write[v_idx], v_sum_cost[v_idx])
    on conflict (user_id, day, model_id) do update
      set calls = d.calls + 1,
          input_tokens = d.input_tokens + excluded.input_tokens,
          output_tokens = d.output_tokens + excluded.output_tokens,
          cache_read_tokens = d.cache_read_tokens + excluded.cache_read_tokens,
          cache_write_tokens = d.cache_write_tokens + excluded.cache_write_tokens,
          cost_usd = d.cost_usd + excluded.cost_usd,
          updated_at = now();
  end loop;

  -- Close the reserved call and count its actual USD cost in the paid period.
  -- La llamada que se cierra: la indicada (p_call) o, si la Edge Function es la de la 6.0.0, la más vieja de ese
  -- modelo. Con dos saldos puede haber llamadas simultáneas de la misma clave en períodos distintos.
  select c.id, c.period_id into v_call, v_period
    from public.ai_call_reservations c
   where c.user_id = p_user and c.status = 'reserved'
     and ((p_call is not null and c.id = p_call) or (p_call is null and c.model_id = p_model))
   order by c.created_at, c.id limit 1 for update;
  if v_call is not null then
    update public.ai_call_reservations
       set status = 'settled', actual_usd = v_cost, settled_at = now()
     where id = v_call;
    if v_period is not null then
      update public.ai_paid_periods
         set spent_usd = spent_usd + v_cost
       where id = v_period and user_id = p_user;
    end if;
  end if;

  return jsonb_build_object(
    'quota', public.ai_quota_status(p_user),
    'costUsd', round(v_cost, 6),
    'unpriced', v_unpriced
  );
end $$;

drop function if exists public.ai_end_call(uuid);
create or replace function public.ai_end_call(p_user uuid, p_call uuid default null)
 returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_call uuid;
begin
  if p_user is null then
    raise exception 'ai_end_call: parámetros inválidos' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user::text,816));
  update public.ai_rate r
     set inflight = case when r.inflight_at > now() - interval '150 seconds' then greatest(r.inflight - 1, 0) else 0 end
   where r.user_id = p_user
     and r.inflight > 0;
  select c.id into v_call from public.ai_call_reservations c
   where c.user_id = p_user and c.status = 'reserved' and (p_call is null or c.id = p_call)
   order by c.created_at, c.id limit 1 for update;
  if v_call is not null then
    update public.ai_call_reservations
       set status = 'released', settled_at = now()
     where id = v_call;
  end if;
  return public.ai_quota_status(p_user);
end $$;

revoke all on function public.ai_add_usage(uuid, text, jsonb, uuid), public.ai_end_call(uuid, uuid) from public, anon, authenticated;
grant execute on function public.ai_add_usage(uuid, text, jsonb, uuid), public.ai_end_call(uuid, uuid) to service_role;

-- El usuario elige qué saldo usar (cuando tiene los dos).
create or replace function public.ai_use_wallet(p_provider text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if p_provider is null or p_provider not in ('anthropic', 'openai') then
    raise exception 'bad_provider' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(me::text, 816));
  if not private.ai_wallet_activate(me, p_provider) then
    raise exception 'no_wallet' using errcode = '22023';
  end if;
  return public.ai_quota_status(me);
end $$;
revoke all on function public.ai_use_wallet(text) from public, anon;
grant execute on function public.ai_use_wallet(text) to authenticated;

-- ---------- 8) Pagos ----------
-- El nombre del plan en la orden lleva el motor ("Claude Pro", "ChatGPT Pro"): es lo que ve el comprador.
-- (El "provider" de pagos es el medio de pago; el motor de IA va como "aiProvider".)
create or replace function private.payments_quote(p_plan text, p_provider text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare p public.ai_plans%rowtype; q jsonb;
begin
 select * into p from public.ai_plans where id = p_plan and active and tier is not null;
 if not found or p.price_usd is null or p.price_usd <= 0 then return null; end if;
 -- Un plan de un motor sin clave cargada no se vende: respondería "no configurado".
 if not private.ai_provider_ready(p.ai_provider) then return null; end if;
 q := private.payments_price(p.price_usd, p_provider);
 if q is null then return null; end if;
 return q || jsonb_build_object('product', 'ai_plan', 'budgetUsd', p.monthly_budget_usd, 'plan', p.id,
   'planName', case p.ai_provider when 'anthropic' then 'Claude ' else 'ChatGPT ' end || p.name,
   'aiProvider', p.ai_provider, 'tier', p.tier);
end $$;

-- Catálogo público. Las Comunidades se retiraron en la 6.1: "clans" queda vacío (los launchers anteriores dejan de
-- ofrecer planes de clan).
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
   'clans', '[]'::jsonb)
 from public.payment_settings s where s.id
$$;

-- Acreditar un pago: el saldo nuevo suma lo que quedaba en el saldo DEL MISMO MOTOR y queda como saldo en uso. El saldo
-- del otro motor no se toca. (Lo demás, igual que en 0044.)
create or replace function public.payments_mark_paid(p_order uuid, p_payment_id text, p_amount numeric, p_currency text,
  p_live boolean, p_provider_status text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_order public.payment_orders%rowtype; v_plan public.ai_plans%rowtype; v_prev public.ai_paid_periods%rowtype;
 v_carry numeric := 0; v_period uuid; v_cperiod public.community_plan_periods;
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
  if v_order.product = 'clan_plan' then
    -- El período va a la comunidad de LA ORDEN (no a otra del mismo pagador). Si la comunidad ya no existe, queda el aviso.
    if v_order.community_id is not null then
      v_cperiod := private.community_plan_grant(v_order.community_id, substr(v_order.plan_id, 6), 'payment', v_order.id, null);
    else
      perform public.admin_log(null, null, 'communityPlan.orphan', v_order.user_id, jsonb_build_object('orderId', v_order.id, 'plan', v_order.plan_id));
    end if;
  else
    select * into v_plan from public.ai_plans where id = v_order.plan_id;
    -- Todo lo que quedaba en el saldo de ese motor, si todavía vale. Las llamadas en curso pasan al período nuevo
    -- (abajo): se cierran y se cobran ahí, y lo que reservaron de más vuelve al saldo nuevo.
    if private.ai_wallet_plan(v_order.user_id, v_plan.ai_provider) is not null then
      select pp.* into v_prev from public.ai_wallets w join public.ai_paid_periods pp on pp.id = w.period_id
       where w.user_id = v_order.user_id and w.ai_provider = v_plan.ai_provider;
      if found then
        v_carry := greatest(0, v_prev.budget_usd - v_prev.spent_usd);
      end if;
    end if;
    insert into public.ai_paid_periods (user_id, order_id, plan_id, starts_at, ends_at, budget_usd)
    values (v_order.user_id, v_order.id, v_order.plan_id, now(), null, least(v_order.budget_usd + v_carry, 9999))
    returning id into v_period;
    if v_prev.id is not null then
      update public.ai_call_reservations
         set period_id = v_period
       where period_id = v_prev.id and user_id = v_order.user_id and status = 'reserved';
    end if;
    insert into public.ai_wallets (user_id, ai_provider, plan_id, period_id)
    values (v_order.user_id, v_plan.ai_provider, v_order.plan_id, v_period)
    on conflict (user_id, ai_provider) do update
      set plan_id = excluded.plan_id, period_id = excluded.period_id, updated_at = now();
    -- Lo que se acaba de comprar pasa a ser el saldo en uso.
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
  perform public.admin_log(null, null, case when v_order.product = 'clan_plan' then 'communityPlan.purchased' else 'payments.paid' end, v_order.user_id,
    jsonb_build_object('orderId', v_order.id, 'plan', v_order.plan_id, 'provider', v_order.provider, 'amount', v_order.amount, 'currency', v_order.currency,
      'priceUsd', v_order.price_usd, 'live', v_order.live, 'carriedUsd', v_carry, 'periodId', v_period,
      'community', v_order.community_id, 'endsAt', v_cperiod.ends_at, 'aiProvider', v_plan.ai_provider));
  return jsonb_build_object('applied', true, 'order', private.payments_order_json(v_order));
end $$;

-- Pago rechazado, cancelado, vencido o devuelto. Una devolución corta el saldo que dio esa orden; lo que de ese saldo
-- había pasado a una compra posterior DEL MISMO MOTOR se descuenta de ahí. Si la cuenta se queda sin el saldo en uso
-- y tiene el del otro motor, pasa a ese.
create or replace function public.payments_mark_status(p_order uuid, p_status text, p_provider_status text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_order public.payment_orders%rowtype; v_current uuid; v_carried numeric; v_provider text; v_other text;
begin
  if p_status not in ('failed', 'cancelled', 'expired', 'refunded') then raise exception 'bad_status' using errcode = '22023'; end if;
  select * into v_order from public.payment_orders where id = p_order for update;
  if not found then return jsonb_build_object('applied', false, 'reason', 'order_not_found'); end if;
  if p_status = 'refunded' then
    if v_order.status <> 'paid' then return jsonb_build_object('applied', false, 'reason', 'not_paid'); end if;
    perform pg_advisory_xact_lock(hashtextextended(v_order.user_id::text, 816));
    if v_order.product = 'clan_plan' then
      -- Una devolución quita el período de esa orden (el tiempo de otros períodos de la comunidad no se toca).
      update public.community_plan_periods set revoked_at = now() where order_id = v_order.id and revoked_at is null;
    else
      select p.ai_provider into v_provider from public.ai_plans p where p.id = v_order.plan_id;
      update public.ai_paid_periods set ends_at = greatest(now(), starts_at + interval '1 second')
       where id = v_order.period_id and (ends_at is null or ends_at > now());
      select w.period_id into v_current from public.ai_wallets w where w.user_id = v_order.user_id and w.ai_provider = v_provider;
      if v_current is not null and v_current is distinct from v_order.period_id then
        select o.carried_usd into v_carried from public.payment_orders o join public.ai_plans p on p.id = o.plan_id
         where o.user_id = v_order.user_id and o.id <> v_order.id and o.status = 'paid' and o.product = 'ai_plan'
           and p.ai_provider = v_provider and o.paid_at >= v_order.paid_at order by o.paid_at limit 1;
        update public.ai_paid_periods set budget_usd = greatest(spent_usd, budget_usd - least(coalesce(v_carried, 0), v_order.budget_usd))
         where id = v_current;
      elsif v_current is not null then
        -- El saldo de ese motor era el de la orden devuelta: deja de existir.
        delete from public.ai_wallets w where w.user_id = v_order.user_id and w.ai_provider = v_provider;
      end if;
    end if;
    update public.payment_orders set status = 'refunded', provider_status = coalesce(left(p_provider_status, 60), 'refunded'),
      checked_at = now(), updated_at = now() where id = p_order returning * into v_order;
    -- Con la orden ya devuelta: si el saldo en uso dejó de valer y queda el del otro motor, se usa ese.
    if v_order.product = 'ai_plan' and public.ai_effective_plan(v_order.user_id) is null then
      select w.ai_provider into v_other from public.ai_wallets w
       where w.user_id = v_order.user_id and private.ai_wallet_plan(w.user_id, w.ai_provider) is not null
       order by private.ai_wallet_left(w.user_id, w.ai_provider) desc limit 1;
      if v_other is not null then perform private.ai_wallet_activate(v_order.user_id, v_other); end if;
    end if;
    perform public.admin_log(null, null, case when v_order.product = 'clan_plan' then 'communityPlan.refunded' else 'payments.refunded' end, v_order.user_id,
      jsonb_build_object('orderId', v_order.id, 'provider', v_order.provider, 'amount', v_order.amount, 'currency', v_order.currency,
        'carriedRemoved', coalesce(v_carried, 0), 'community', v_order.community_id));
  elsif v_order.status = 'pending' then
    update public.payment_orders set status = p_status, provider_status = coalesce(left(p_provider_status, 60), p_status),
      checked_at = now(), updated_at = now() where id = p_order returning * into v_order;
  else
    return jsonb_build_object('applied', false, 'reason', 'not_pending', 'order', private.payments_order_json(v_order));
  end if;
  return jsonb_build_object('applied', true, 'order', private.payments_order_json(v_order));
end $$;

revoke all on function private.payments_quote(text, text) from public, anon, authenticated;
revoke all on function public.payments_catalog() from public;
grant execute on function public.payments_catalog() to anon, authenticated, service_role;
revoke all on function public.payments_mark_paid(uuid, text, numeric, text, boolean, text),
  public.payments_mark_status(uuid, text, text) from public, anon, authenticated;
grant execute on function public.payments_mark_paid(uuid, text, numeric, text, boolean, text),
  public.payments_mark_status(uuid, text, text) to service_role;

-- ---------- 9) Panel de administración ----------
create or replace function public.admin_plan_json(p_plan text) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object('id', p.id, 'name', p.name, 'provider', p.ai_provider, 'tier', p.tier, 'active', p.active, 'sort', p.sort,
   'priceUsd', p.price_usd, 'currency', p.currency, 'monthlyBudgetUsd', p.monthly_budget_usd,
   'maxTokensPerRequest', p.max_tokens_per_request, 'maxCallsPerTurn', p.max_calls_per_turn,
   'requestsPerMinute', p.requests_per_minute, 'subscribers',
     (select count(*) from public.ai_subscriptions s where public.ai_effective_plan(s.user_id) = p.id),
   'wallets', (select count(*) from public.ai_wallets w where w.plan_id = p.id and private.ai_wallet_plan(w.user_id, w.ai_provider) is not null),
   'models', coalesce((select jsonb_agg(jsonb_build_object('id', pm.model_id, 'label', coalesce(r.label, m.label),
     'modelActive', m.active, 'efforts', public.ai_effort_list(pm.efforts),
     'daily', pm.daily_questions, 'weekly', pm.weekly_questions, 'sort', pm.sort) order by pm.sort, m.sort, m.id)
     from public.ai_plan_models pm join public.ai_models m on m.id = pm.model_id and m.active
     left join lateral private.ai_model_for(p.ai_provider, pm.model_id) r on true
     where pm.plan_id = p.id and m.id in ('haiku', 'sonnet')), '[]'::jsonb),
   'prices', '[]'::jsonb)
 from public.ai_plans p where p.id = p_plan and p.tier is not null
$$;

create or replace function public.admin_plans() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
 perform public.admin_guard();
 return jsonb_build_object('plans', coalesce((select jsonb_agg(public.admin_plan_json(p.id) order by p.sort, p.id)
   from public.ai_plans p where p.tier is not null), '[]'::jsonb),
   'models', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'label', m.label, 'active', m.active) order by m.sort, m.id)
   from public.ai_models m where m.active and m.id in ('haiku', 'sonnet')), '[]'::jsonb));
end $$;
revoke all on function public.admin_plans() from public, anon;
revoke all on function public.admin_plan_json(text) from public, anon, authenticated;
grant execute on function public.admin_plans() to authenticated, service_role;
grant execute on function public.admin_plan_json(text) to service_role;

-- Uso de la IA del mes por motor y saldos vigentes, para el Resumen del panel.
create or replace function public.admin_ai_providers() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_month date := date_trunc('month', public.ai_local_now())::date;
begin
  perform public.admin_guard();
  return jsonb_build_object(
    'since', v_month,
    'keys', jsonb_build_object('anthropic', private.ai_provider_ready('anthropic'), 'openai', private.ai_provider_ready('openai')),
    'providers', coalesce((
      select jsonb_agg(jsonb_build_object('provider', x.provider,
               'monthUsd', round(x.usd, 4), 'monthCalls', x.calls,
               'wallets', (select count(*) from public.ai_wallets w
                            where w.ai_provider = x.provider and private.ai_wallet_plan(w.user_id, w.ai_provider) is not null),
               'walletsLeftUsd', (select coalesce(round(sum(private.ai_wallet_left(w.user_id, w.ai_provider)), 2), 0)
                                    from public.ai_wallets w where w.ai_provider = x.provider)) order by x.provider)
        from (select pr.provider, coalesce(sum(d.cost_usd), 0) as usd, coalesce(sum(d.calls), 0) as calls
                from (values ('anthropic'), ('openai')) pr(provider)
                left join public.ai_models m on m.provider = pr.provider
                left join public.ai_usage_model_daily d on d.model_id = m.id and d.day >= v_month
               group by pr.provider) x), '[]'::jsonb));
end $$;
revoke all on function public.admin_ai_providers() from public, anon;
grant execute on function public.admin_ai_providers() to authenticated, service_role;

-- Quitar plan (Usuarios > Quitar plan): igual que en 0012, y además borra los saldos de la cuenta (como una
-- devolución). Si no, la llamada siguiente volvía a poner en uso un saldo pagado y la cuenta seguía con la IA. Los
-- períodos pagados (ai_paid_periods) quedan como historial. Toma también el candado de la IA para no cruzarse con
-- un ai_register_turn en curso.
create or replace function public.admin_remove_plan(p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_prev public.ai_subscriptions%rowtype;
begin
  if p_user is null then
    raise exception 'admin_remove_plan: parámetros inválidos' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('venus-billing:' || p_user::text));
  perform pg_advisory_xact_lock(hashtextextended(p_user::text, 816));
  select s.* into v_prev from public.ai_subscriptions s where s.user_id = p_user for update;
  if not found then
    return jsonb_build_object('applied', false, 'reason', 'no_plan');
  end if;

  update public.ai_subscriptions s
     set status = 'canceled',
         source = 'admin',
         current_period_end = least(coalesce(s.current_period_end, now()), now()),
         external_ref = null,
         stripe_subscription_id = null,
         stripe_price_id = null,
         stripe_status = null,
         grace_until = null,
         cancel_at_period_end = false,
         last_synced_at = null
   where s.user_id = p_user;
  delete from public.ai_wallets w where w.user_id = p_user;

  return jsonb_build_object(
    'applied', true,
    'previous', jsonb_build_object(
      'planId', v_prev.plan_id,
      'status', v_prev.status,
      'source', v_prev.source,
      'currentPeriodEnd', public.admin_iso(v_prev.current_period_end),
      'stripeSubscriptionId', v_prev.stripe_subscription_id,
      'stripeStatus', v_prev.stripe_status
    )
  );
end $$;
revoke all on function public.admin_remove_plan(uuid) from public, anon, authenticated;
grant execute on function public.admin_remove_plan(uuid) to service_role;

-- Resumen del panel: igual que en 0017, con los planes que se venden (con nivel) en lugar de la lista fija de ids,
-- para que cuenten los de Claude y los Ultra.
create or replace function public.admin_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
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
   join public.ai_plans p on p.id=s.plan_id and p.active and p.tier is not null
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
 where p.active and p.tier is not null;

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
revoke all on function public.admin_overview() from public, anon;
grant execute on function public.admin_overview() to authenticated, service_role;

-- ---------- 9b) Soporte ----------
-- El formulario de "Asistente IA" pregunta qué plan tiene la cuenta: acepta los planes nuevos. Lo demás, igual que en
-- 0045 (los valores de antes siguen valiendo, así que el launcher 6.0.0 no nota el cambio).
create or replace function private.support_details_clean(p_category text, p_details jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  v_out jsonb := '{}'::jsonb; v_key text; v_val jsonb; v_text text; v_enums jsonb; v_free jsonb;
begin
  if p_details is null or jsonb_typeof(p_details) = 'null' then return v_out; end if;
  if jsonb_typeof(p_details) <> 'object' or pg_column_size(p_details) > 8192 then
    raise exception 'Revisá los datos de la consulta.' using errcode = '22023', hint = 'bad_details';
  end if;
  v_enums := case p_category
    when 'bug' then '{"area":["launcher","install","update","account","social","other"],"frequency":["always","sometimes","once"]}'
    when 'game' then '{"loader":["vanilla","fabric","quilt","forge","neoforge","other"],"moment":["launch","loading","playing","closing"],"modsChanged":["yes","no","unknown"]}'
    when 'payments' then '{"topic":["login","profile","sanction","payment","refund","other"],"method":["mercado_pago","paypal","other"]}'
    when 'assistant' then '{"plan":["none","basic","go","pro","max","ultra","claude_basic","claude_go","claude_pro","claude_max","claude_ultra"],"issue":["noreply","limit","wrong","billing","other"]}'
    when 'suggestion' then '{"area":["launcher","play","social","ai","other"]}'
    else '{}' end::jsonb;
  v_free := case p_category
    when 'bug' then '{"steps":600}'
    when 'game' then '{"mcVersion":24,"steps":600}'
    when 'payments' then '{"paidOn":10,"orderRef":80}'
    when 'suggestion' then '{"benefit":400}'
    else '{}' end::jsonb;
  for v_key, v_val in select * from jsonb_each(p_details) loop
    if jsonb_typeof(v_val) <> 'string' then
      raise exception 'Revisá los datos de la consulta.' using errcode = '22023', hint = 'bad_details';
    end if;
    v_text := btrim(v_val #>> '{}');
    if v_text = '' then continue; end if;
    if v_enums ? v_key then
      if not ((v_enums -> v_key) ? v_text) then
        raise exception 'Revisá los datos de la consulta.' using errcode = '22023', hint = 'bad_details';
      end if;
    elsif v_free ? v_key then
      if char_length(v_text) > (v_free ->> v_key)::integer or v_text ~ '[\x00-\x08\x0b-\x1f]'
         or (v_key in ('mcVersion', 'paidOn', 'orderRef') and v_text ~ '[\r\n<>]')
         or (v_key = 'paidOn' and v_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') then
        raise exception 'Revisá los datos de la consulta.' using errcode = '22023', hint = 'bad_details';
      end if;
    else
      raise exception 'Revisá los datos de la consulta.' using errcode = '22023', hint = 'bad_details';
    end if;
    v_out := v_out || jsonb_build_object(v_key, v_text);
  end loop;
  return v_out;
end $$;

-- ---------- 10) Comprobación ----------
-- La migración falla (y no queda registrada) si el catálogo o la cuota no salen con la forma del contrato.
do $$
declare v_catalog jsonb; v_pay jsonb; v_n integer;
begin
  v_catalog := public.ai_catalog();
  if jsonb_typeof(v_catalog) <> 'array' or jsonb_array_length(v_catalog) <> 10 then
    raise exception 'ai_catalog_invalid: % planes', jsonb_array_length(v_catalog) using errcode = '22023';
  end if;
  select count(*) into v_n from jsonb_array_elements(v_catalog) e
   where e ->> 'provider' in ('anthropic', 'openai') and e ->> 'tier' is not null and jsonb_array_length(e -> 'models') >= 1;
  if v_n <> 10 then raise exception 'ai_catalog_invalid: planes sin motor, nivel o modelos' using errcode = '22023'; end if;
  v_pay := public.payments_catalog();
  if v_pay is null or jsonb_typeof(v_pay -> 'plans') <> 'array' or jsonb_array_length(v_pay -> 'plans') <> 10
     or jsonb_typeof(v_pay -> 'clans') <> 'array' then
    raise exception 'payments_catalog_invalid' using errcode = '22023';
  end if;
  if private.ai_reserve_usd('openai', 'sonnet', 1000, 1000) is null or private.ai_reserve_usd('anthropic', 'haiku', 1000, 1000) is null then
    raise exception 'ai_models_invalid: falta el precio de un modelo' using errcode = '22023';
  end if;
  if private.support_details_clean('assistant', '{"plan":"claude_ultra","issue":"limit"}'::jsonb) ->> 'plan' is distinct from 'claude_ultra' then
    raise exception 'support_details_invalid' using errcode = '22023';
  end if;
end $$;
