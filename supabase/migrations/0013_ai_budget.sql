-- Venus Launcher · 0013 · IA: el presupuesto del mes sin agujeros (cambios de plan y llamadas en curso).
-- Se aplica DESPUÉS de 0012 y necesita 0007 y 0008 (IA), 0009 (pagos) y 0011 (proveedores): reemplaza
-- ai_quota_status, ai_register_turn, ai_add_usage y billing_apply_subscription (mismas firmas) y agrega
-- ai_budget_limit, ai_call_reserve y ai_end_call.
--
-- Qué cambia:
--   - Cambiar de plan en medio del período de Stripe: Stripe cobra (o acredita) solo el prorrateo del tiempo que
--     queda, así que la diferencia de presupuesto también se prorratea hasta el fin de ese período
--     (ai_subscriptions.budget_cap_usd y budget_cap_until, que calcula billing_apply_subscription). Antes, subir de
--     plan unos minutos antes de la renovación daba todo el presupuesto del plan caro.
--   - Llamadas en curso (ai_rate.inflight): hasta 3 por usuario a la vez, y cada llamada en curso reserva el costo
--     máximo de una llamada de ese modelo. Antes, las llamadas simultáneas pasaban todas el control del
--     presupuesto, porque el costo se suma recién cuando la IA responde.
--   - ai_end_call: cierra una llamada que terminó sin respuesta. Las que tuvieron respuesta, o que se cortaron y se
--     cobran estimadas (plazo vencido, cancelación del launcher o conexión caída), las cierra ai_add_usage.
-- Guía: docs/backend-ia.md (secciones 3 y 8) y docs/pagos.md. Idempotente: se puede volver a aplicar.

-- ---------- Llamadas en curso ----------

alter table public.ai_rate add column if not exists inflight integer not null default 0 check (inflight >= 0);
alter table public.ai_rate add column if not exists inflight_at timestamptz;

comment on column public.ai_rate.inflight is 'Llamadas a la IA en curso: las sube ai_register_turn y las bajan ai_add_usage y ai_end_call. Vencen a los 150 s de inflight_at (por si una función se cortó sin cerrarlas).';
comment on column public.ai_rate.inflight_at is 'Cuándo empezó la última llamada en curso.';

-- ---------- Tope del presupuesto al cambiar de plan ----------

alter table public.ai_subscriptions add column if not exists budget_cap_usd numeric(10,4) check (budget_cap_usd >= 0);
alter table public.ai_subscriptions add column if not exists budget_cap_until timestamptz;

comment on column public.ai_subscriptions.budget_cap_usd is 'Tope del presupuesto del mes después de cambiar de plan en medio del período de Stripe: lo pagado antes más la diferencia prorrateada por el tiempo que quedaba. Vale hasta budget_cap_until y solo con source = ''stripe''.';
comment on column public.ai_subscriptions.budget_cap_until is 'Fin del período de facturación en el que se cambió de plan; desde ahí rige el presupuesto entero del plan.';

-- ---------- Funciones auxiliares ----------

-- Presupuesto del mes de un usuario con el plan p_plan: el del plan o, si cambió de plan en medio del período de
-- Stripe, el tope prorrateado hasta el fin de ese período (lo que de verdad pagó). null si el plan no existe.
create or replace function public.ai_budget_limit(p_user uuid, p_plan text) returns numeric
language sql stable security definer set search_path = '' as $$
  select case
    when s.source = 'stripe' and s.budget_cap_until > now() and s.budget_cap_usd is not null
      then least(p.monthly_budget_usd, s.budget_cap_usd)
    else p.monthly_budget_usd
  end
    from public.ai_plans p
    left join public.ai_subscriptions s on s.user_id = p_user
   where p.id = p_plan
$$;

-- Costo máximo de UNA llamada a un modelo de Venus, para reservar las llamadas en curso: el cuerpo más grande que
-- acepta la Edge Function (400 KB, unos 136.534 tokens) como escritura de caché y p_max_tokens de salida, con el
-- precio del modelo o el de su respaldo en OpenAI (el más caro de los dos). Para verlo:
--   select public.ai_call_reserve('opus', 16000);
create or replace function public.ai_call_reserve(p_model text, p_max_tokens integer) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(max(public.ai_price_line(m, 0, greatest(coalesce(p_max_tokens, 0), 0), 0, 136534)), 0)
    from public.ai_models m
   where m.id = p_model
      or m.id in (select f.model_id from public.ai_tier_fallbacks f where f.tier = p_model and f.active)
$$;

-- ---------- Cuota ----------

-- Igual que en 0008, pero budget.limitUsd es el presupuesto que rige (ai_budget_limit: con el tope si cambió de plan).
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

  select coalesce(sum(d.cost_usd), 0)
    into v_spent
    from public.ai_usage_model_daily d
   where d.user_id = p_user
     and d.day >= v_month;

  return jsonb_build_object(
    'plan', v_plan_id,
    'planName', v_plan.name,
    'priceUsd', v_plan.price_usd,
    'status', v_status,
    'models', v_models,
    'budget', jsonb_build_object('usedUsd', round(v_spent, 4), 'limitUsd', coalesce(public.ai_budget_limit(p_user, v_plan_id), 0)),
    'resets', jsonb_build_object(
      'daily', public.ai_iso((v_today + 1)::timestamp at time zone v_tz),
      'weekly', public.ai_iso((v_week + 7)::timestamp at time zone v_tz),
      'monthly', public.ai_iso((v_month + interval '1 month') at time zone v_tz)
    ),
    'timezone', v_tz,
    'lastModel', v_last
  );
end $$;

-- Igual que en 0008, con dos cambios:
--   5) además de la ráfaga, no más de 3 llamadas en curso a la vez ('rate');
--   6) el presupuesto es el que rige (ai_budget_limit) y las llamadas en curso reservan su costo máximo
--      (ai_call_reserve): si con esa reserva se podría pasar, se espera a que terminen ('rate').
-- Una llamada permitida queda en curso hasta que la Edge Function la cierra (ai_add_usage o ai_end_call).
-- Devuelve { allowed, reason, model, modelId, fallback, effort, counted, maxTokensPerRequest, quota }.
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
begin
  if p_user is null or p_turn is null or char_length(p_turn) not between 1 and 100 then
    raise exception 'ai_register_turn: parámetros inválidos' using errcode = '22023';
  end if;
  if p_model is not null and char_length(p_model) not between 1 and 32 then
    raise exception 'ai_register_turn: modelo inválido' using errcode = '22023';
  end if;
  if p_effort is not null and p_effort not in ('low', 'medium', 'high') then
    raise exception 'ai_register_turn: esfuerzo inválido' using errcode = '22023';
  end if;

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
    returning r.calls, case when r.inflight_at > now() - interval '150 seconds' then r.inflight else 0 end
      into v_minute_calls, v_inflight;
    if v_minute_calls > v_plan.requests_per_minute or v_inflight >= 3 then
      v_reason := 'rate';
    end if;
  end if;

  -- 6) Presupuesto del mes: el del plan, o el tope prorrateado si cambió de plan en este período. Las llamadas en
  --    curso todavía no sumaron su costo: cada una reserva el máximo de una llamada de este modelo.
  if v_reason is null then
    select coalesce(sum(d.cost_usd), 0)
      into v_spent
      from public.ai_usage_model_daily d
     where d.user_id = p_user
       and d.day >= v_month;
    v_budget := public.ai_budget_limit(p_user, v_plan_id);
    if v_spent >= v_budget then
      v_reason := 'budget';
    elsif v_inflight > 0
          and v_spent + v_inflight * public.ai_call_reserve(v_model, v_plan.max_tokens_per_request) >= v_budget then
      v_reason := 'rate';
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

  -- La llamada permitida queda en curso hasta que la Edge Function la cierra (ai_add_usage o ai_end_call).
  if v_reason is null then
    update public.ai_rate r
       set inflight = v_inflight + 1,
           inflight_at = now()
     where r.user_id = p_user;
  end if;

  return jsonb_build_object(
    'allowed', v_reason is null,
    'reason', v_reason,
    'model', v_model,
    'modelId', case when v_reason is null then v_info.model_id end,
    'fallback', v_reason is null and coalesce(v_info.supports_fallback, false),
    'effort', v_effort,
    'counted', v_counted,
    'maxTokensPerRequest', coalesce(v_plan.max_tokens_per_request, 0),
    'quota', public.ai_quota_status(p_user)
  );
end $$;

-- Igual que en 0011, y además cierra la llamada (deja de estar en curso). También la usa la Edge Function para
-- cobrar una estimación de las llamadas que se cortaron sin respuesta (plazo vencido, cancelación del launcher o
-- conexión caída): el proveedor pudo haberlas procesado y facturado.
-- Devuelve { quota, costUsd, unpriced }.
create or replace function public.ai_add_usage(p_user uuid, p_model text, p_usage jsonb) returns jsonb
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
begin
  if p_user is null or p_model is null then
    raise exception 'ai_add_usage: parámetros inválidos' using errcode = '22023';
  end if;
  if p_usage is null or jsonb_typeof(p_usage) <> 'array' or jsonb_array_length(p_usage) > 50 then
    raise exception 'ai_add_usage: uso inválido' using errcode = '22023';
  end if;
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

  return jsonb_build_object(
    'quota', public.ai_quota_status(p_user),
    'costUsd', round(v_cost, 6),
    'unpriced', v_unpriced
  );
end $$;

-- Cierra una llamada que terminó sin respuesta de la IA y sin nada que cobrar (proveedor saturado o caído, pedido
-- inválido, sin proveedor configurado...): deja de estar en curso. Devuelve la cuota (QuotaV2).
create or replace function public.ai_end_call(p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if p_user is null then
    raise exception 'ai_end_call: parámetros inválidos' using errcode = '22023';
  end if;
  update public.ai_rate r
     set inflight = case when r.inflight_at > now() - interval '150 seconds' then greatest(r.inflight - 1, 0) else 0 end
   where r.user_id = p_user
     and r.inflight > 0;
  return public.ai_quota_status(p_user);
end $$;

-- ---------- Pagos ----------

-- Igual que en 0009, y además el tope del presupuesto (budget_cap_usd / budget_cap_until). Si la misma suscripción
-- cambia de plan en medio del período, Stripe cobra (o acredita) solo el prorrateo del tiempo que queda: el
-- presupuesto también se prorratea, anterior + (nuevo - anterior) x (lo que queda del período / un mes), hasta el
-- fin de ese período. La misma suscripción conserva su tope mientras dure; una suscripción nueva (pagada entera) no
-- tiene tope.
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
  v_cap numeric;
  v_cap_until timestamptz;
  v_old_budget numeric;
  v_new_budget numeric;
  v_left numeric;
  v_len numeric;
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

  -- Tope del presupuesto: solo la misma suscripción. Al cambiar de plan con acceso, lo pagado en este período
  -- (el tope vigente o, si no hay, el presupuesto del plan anterior) más la diferencia de presupuesto de los dos
  -- planes por lo que queda del período, igual que el prorrateo de Stripe (al bajar, la diferencia resta).
  if v_found and v_row.stripe_subscription_id is not distinct from p_subscription then
    if v_row.budget_cap_until > now() then
      v_cap := v_row.budget_cap_usd;
      v_cap_until := v_row.budget_cap_until;
    end if;
    if v_row.plan_id <> p_plan and v_new_grants then
      select p.monthly_budget_usd into v_old_budget from public.ai_plans p where p.id = v_row.plan_id;
      select p.monthly_budget_usd into v_new_budget from public.ai_plans p where p.id = p_plan;
      -- El período es de un mes (los precios de ai_plan_prices son mensuales). Con la gracia de un pago fallido,
      -- el fin es antes y la parte que queda sale más chica.
      v_left := extract(epoch from (p_current_period_end - now()));
      v_len := extract(epoch from (p_current_period_end - (p_current_period_end - interval '1 month')));
      v_cap := greatest(round(coalesce(v_cap, v_old_budget) + (v_new_budget - v_old_budget) * least(v_left / v_len, 1), 4), 0);
      v_cap_until := p_current_period_end;
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
    grace_until, stripe_status, last_synced_at, budget_cap_usd, budget_cap_until
  ) values (
    p_user, p_plan, p_status, p_current_period_end, 'stripe', left(p_subscription, 200),
    p_customer, p_subscription, p_price, coalesce(p_cancel_at_period_end, false),
    p_grace_until, p_stripe_status, v_synced, v_cap, v_cap_until
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
        last_synced_at = excluded.last_synced_at,
        budget_cap_usd = excluded.budget_cap_usd,
        budget_cap_until = excluded.budget_cap_until;

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

-- ---------- Permisos de las funciones ----------
-- Postgres y Supabase dan EXECUTE a todos por defecto: se quita y se da solo a la service role.

revoke all on function public.ai_budget_limit(uuid, text) from public, anon, authenticated;
revoke all on function public.ai_call_reserve(text, integer) from public, anon, authenticated;
revoke all on function public.ai_quota_status(uuid) from public, anon, authenticated;
revoke all on function public.ai_register_turn(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.ai_add_usage(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.ai_end_call(uuid) from public, anon, authenticated;
revoke all on function public.billing_apply_subscription(uuid, text, text, timestamptz, timestamptz, boolean, text, text, text, text, timestamptz, boolean)
  from public, anon, authenticated;

grant execute on function public.ai_budget_limit(uuid, text) to service_role;
grant execute on function public.ai_call_reserve(text, integer) to service_role;
grant execute on function public.ai_quota_status(uuid) to service_role;
grant execute on function public.ai_register_turn(uuid, text, text, text) to service_role;
grant execute on function public.ai_add_usage(uuid, text, jsonb) to service_role;
grant execute on function public.ai_end_call(uuid) to service_role;
grant execute on function public.billing_apply_subscription(uuid, text, text, timestamptz, timestamptz, boolean, text, text, text, text, timestamptz, boolean)
  to service_role;
