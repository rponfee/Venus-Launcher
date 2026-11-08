-- Repair Venus IA reservations left open after successful responses.
-- Existing function signatures and service-role-only grants are preserved.
CREATE OR REPLACE FUNCTION public.ai_add_usage(p_user uuid, p_model text, p_usage jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  select c.id, c.period_id into v_call, v_period
    from public.ai_call_reservations c
   where c.user_id = p_user and c.model_id = p_model and c.status = 'reserved'
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
end $function$;

CREATE OR REPLACE FUNCTION public.ai_end_call(p_user uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
   where c.user_id = p_user and c.status = 'reserved'
   order by c.created_at, c.id limit 1 for update;
  if v_call is not null then
    update public.ai_call_reservations
       set status = 'released', settled_at = now()
     where id = v_call;
  end if;
  return public.ai_quota_status(p_user);
end $function$;

CREATE OR REPLACE FUNCTION public.ai_register_turn(p_user uuid, p_turn text, p_model text, p_effort text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  -- A crashed or disconnected Edge worker must not block the account forever.
  update public.ai_call_reservations
     set status = 'released', settled_at = now()
   where user_id = p_user and status = 'reserved'
     and created_at < now() - interval '5 minutes';
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
end $function$;

-- Reconcile paid-period spending for the stale calls already recorded in daily usage.
-- Scope to periods with an old reservation; daily usage is the existing cost ledger.
with stale_periods as (
  select distinct period_id from public.ai_call_reservations
   where status = 'reserved' and period_id is not null
     and created_at < now() - interval '5 minutes'
)
update public.ai_paid_periods pp
   set spent_usd = greatest(pp.spent_usd, coalesce((
     select sum(d.cost_usd) from public.ai_usage_model_daily d
      where d.user_id = pp.user_id
        and d.day >= (pp.starts_at at time zone 'America/Argentina/Buenos_Aires')::date
        and d.day <= public.ai_today()
   ), 0))
 where pp.id in (select period_id from stale_periods);

-- Historic API calls were already included in daily usage. Their per-call cost
-- was not stored, so leave actual_usd NULL rather than inventing a value.
update public.ai_call_reservations
   set status = 'settled', settled_at = now()
 where status = 'reserved' and created_at < now() - interval '5 minutes';
