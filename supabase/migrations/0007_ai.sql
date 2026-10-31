-- Venus Launcher · 0007 · Asistente de IA: planes, suscripciones y cuotas de uso.
-- Lo usa la Edge Function "ai-assistant" (supabase/functions/ai-assistant) con la service role:
-- elige el modelo según el plan del usuario y aplica la cuota (consultas por día y tokens por mes).
-- Desde el launcher (anon / authenticated) solo se puede LEER el catálogo de planes y el uso propio:
-- ninguna tabla acepta escrituras del cliente y las funciones de cuota solo las ejecuta la service role.
-- Los planes de los usuarios los asigna la service role (a mano desde el panel o, más adelante, el
-- webhook de pagos). Cómo editar los planes y asignarlos: docs/backend-ia.md.
-- Idempotente: se puede volver a aplicar sin romper nada y sin pisar los planes ya editados.

-- ---------- Planes ----------

create table if not exists public.ai_plans (
  id text primary key check (id ~ '^[a-z][a-z0-9_-]{1,31}$'),
  name text not null check (char_length(name) between 1 and 40),
  model text not null default 'claude-opus-5-5' check (model ~ '^claude-[a-z0-9][a-z0-9-]{1,62}$'),
  daily_messages integer not null check (daily_messages >= 0),
  monthly_tokens bigint not null check (monthly_tokens >= 0),
  max_tokens_per_request integer not null default 16000 check (max_tokens_per_request between 1000 and 16000),
  max_calls_per_turn integer not null default 30 check (max_calls_per_turn between 1 and 200),
  requests_per_minute integer not null default 30 check (requests_per_minute between 1 and 600),
  sort integer not null default 100,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.ai_plans is 'Planes de la IA del launcher. Editar desde el panel o con SQL (ver docs/backend-ia.md).';
comment on column public.ai_plans.model is 'Modelo de Claude que usa el plan (la Edge Function nunca acepta el modelo del cliente).';
comment on column public.ai_plans.daily_messages is 'Consultas por día: cada pregunta del usuario cuenta una vez aunque la IA use varias herramientas.';
comment on column public.ai_plans.monthly_tokens is 'Tokens por mes calendario: entrada + salida + lectura de caché.';
comment on column public.ai_plans.max_tokens_per_request is 'Tope de max_tokens por llamada (nunca más de 16000).';
comment on column public.ai_plans.max_calls_per_turn is 'Llamadas a la IA permitidas dentro de una misma pregunta (ciclo de herramientas).';
comment on column public.ai_plans.requests_per_minute is 'Llamadas por minuto por usuario (protege el límite de la organización en Anthropic).';
comment on column public.ai_plans.active is 'Si es false, el plan no se puede usar: sus usuarios pasan al plan free.';

-- Valores PROVISORIOS: el dueño del proyecto todavía no definió la tabla de planes. No pisa filas existentes.
insert into public.ai_plans (id, name, model, daily_messages, monthly_tokens, max_tokens_per_request, max_calls_per_turn, requests_per_minute, sort)
values
  ('free', 'Free', 'claude-opus-5-5', 15, 2000000, 8000, 30, 30, 10),
  ('plus', 'Plus', 'claude-opus-5-5', 100, 15000000, 16000, 50, 40, 20),
  ('pro', 'Pro', 'claude-opus-5-5', 400, 60000000, 16000, 80, 60, 30)
on conflict (id) do nothing;

-- ---------- Suscripciones ----------
-- Una fila por usuario con plan pago (o asignado a mano). Sin fila, el usuario usa el plan free.

create table if not exists public.ai_subscriptions (
  user_id uuid primary key references auth.users (id) on delete cascade,
  plan_id text not null references public.ai_plans (id) on update cascade on delete restrict,
  status text not null default 'active' check (status in ('active', 'trialing', 'past_due', 'paused', 'canceled', 'expired')),
  -- Fin del período pago; null = sin vencimiento (planes asignados a mano).
  current_period_end timestamptz,
  -- De dónde viene: 'manual', o el proveedor de pagos que use el webhook.
  source text not null default 'manual' check (char_length(source) between 1 and 32),
  -- Identificador de la suscripción en el proveedor de pagos.
  external_ref text check (char_length(external_ref) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ai_subscriptions_plan on public.ai_subscriptions (plan_id);

comment on table public.ai_subscriptions is 'Plan de IA de cada usuario. Solo escribe la service role. Vale con status active/trialing y período vigente.';

-- ---------- Uso ----------

-- Uso por usuario y día (el día se cuenta en la zona horaria de public.ai_quota_tz()).
create table if not exists public.ai_usage_daily (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  messages integer not null default 0 check (messages >= 0),
  requests integer not null default 0 check (requests >= 0),
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  cache_read_tokens bigint not null default 0 check (cache_read_tokens >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

comment on table public.ai_usage_daily is 'Uso diario: messages = preguntas (turn_id distintos), requests = llamadas a la IA, input_tokens incluye la escritura de caché.';

-- Preguntas registradas: cada turn_id cuenta una sola consulta aunque haga varias llamadas.
create table if not exists public.ai_turns (
  user_id uuid not null references auth.users (id) on delete cascade,
  turn_id text not null check (char_length(turn_id) between 1 and 100),
  day date not null,
  calls integer not null default 1 check (calls >= 0),
  created_at timestamptz not null default now(),
  primary key (user_id, turn_id, day)
);

-- Ventana de un minuto por usuario para limitar ráfagas de llamadas.
create table if not exists public.ai_rate (
  user_id uuid primary key references auth.users (id) on delete cascade,
  window_start timestamptz not null default now(),
  calls integer not null default 0 check (calls >= 0)
);

-- ---------- updated_at automático ----------

create or replace function public.ai_touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists ai_plans_touch on public.ai_plans;
create trigger ai_plans_touch
  before update on public.ai_plans
  for each row execute function public.ai_touch_updated_at();

drop trigger if exists ai_subscriptions_touch on public.ai_subscriptions;
create trigger ai_subscriptions_touch
  before update on public.ai_subscriptions
  for each row execute function public.ai_touch_updated_at();

-- ---------- RLS: el cliente solo lee; escribe únicamente la service role ----------

alter table public.ai_plans enable row level security;
alter table public.ai_subscriptions enable row level security;
alter table public.ai_usage_daily enable row level security;
alter table public.ai_turns enable row level security;
alter table public.ai_rate enable row level security;

drop policy if exists "ai_plans_select_active" on public.ai_plans;
create policy "ai_plans_select_active" on public.ai_plans
  for select to authenticated using (active);

drop policy if exists "ai_subscriptions_select_own" on public.ai_subscriptions;
create policy "ai_subscriptions_select_own" on public.ai_subscriptions
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "ai_usage_daily_select_own" on public.ai_usage_daily;
create policy "ai_usage_daily_select_own" on public.ai_usage_daily
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "ai_turns_select_own" on public.ai_turns;
create policy "ai_turns_select_own" on public.ai_turns
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "ai_rate_select_own" on public.ai_rate;
create policy "ai_rate_select_own" on public.ai_rate
  for select to authenticated using ((select auth.uid()) = user_id);

revoke all on public.ai_plans, public.ai_subscriptions, public.ai_usage_daily, public.ai_turns, public.ai_rate
  from anon, authenticated;
grant select on public.ai_plans, public.ai_subscriptions, public.ai_usage_daily, public.ai_turns, public.ai_rate
  to authenticated;
grant all on public.ai_plans, public.ai_subscriptions, public.ai_usage_daily, public.ai_turns, public.ai_rate
  to service_role;

-- ---------- Funciones de plan y cuota (solo service role) ----------
-- Todas son SECURITY DEFINER con search_path vacío y nombres calificados.

-- Zona horaria de las cuotas: el día y el mes se cuentan acá. Para que la cuota diaria se renueve a
-- la medianoche de Argentina, cambiá 'UTC' por 'America/Argentina/Buenos_Aires' y volvé a aplicar.
create or replace function public.ai_quota_tz() returns text
language sql stable set search_path = '' as $$
  select 'UTC'::text
$$;

create or replace function public.ai_today() returns date
language sql stable set search_path = '' as $$
  select (now() at time zone public.ai_quota_tz())::date
$$;

-- Plan vigente del usuario: su suscripción activa (y con plan activo) o 'free'.
create or replace function public.ai_effective_plan(p_user uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select s.plan_id
      from public.ai_subscriptions s
      join public.ai_plans p on p.id = s.plan_id and p.active
     where s.user_id = p_user
       and s.status in ('active', 'trialing')
       and (s.current_period_end is null or s.current_period_end > now())
  ), 'free')
$$;

-- Estado de la cuota con la forma que espera el launcher:
-- { plan, planName, model, daily: { used, limit }, monthlyTokens: { used, limit }, resetsAt }.
-- resetsAt es cuándo se renueva el límite que importa: el mes si se agotaron los tokens, si no el día.
create or replace function public.ai_quota_status(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_tz text := public.ai_quota_tz();
  v_today date := public.ai_today();
  v_month date := date_trunc('month', v_today::timestamp)::date;
  v_plan_id text := public.ai_effective_plan(p_user);
  v_name text;
  v_model text;
  v_daily_limit integer;
  v_monthly_limit bigint;
  v_daily_used bigint;
  v_monthly_used numeric;
  v_resets timestamptz;
begin
  select p.name, p.model, p.daily_messages, p.monthly_tokens
    into v_name, v_model, v_daily_limit, v_monthly_limit
    from public.ai_plans p
   where p.id = v_plan_id and p.active;
  if not found then
    -- Plan inexistente o desactivado: sin cupo.
    v_name := v_plan_id;
    v_model := '';
    v_daily_limit := 0;
    v_monthly_limit := 0;
  end if;

  select coalesce(sum(u.messages) filter (where u.day = v_today), 0),
         coalesce(sum(u.input_tokens + u.output_tokens + u.cache_read_tokens), 0)
    into v_daily_used, v_monthly_used
    from public.ai_usage_daily u
   where u.user_id = p_user
     and u.day >= v_month;

  if v_monthly_used >= v_monthly_limit then
    v_resets := (date_trunc('month', v_today::timestamp) + interval '1 month') at time zone v_tz;
  else
    v_resets := (v_today + 1)::timestamp at time zone v_tz;
  end if;

  return jsonb_build_object(
    'plan', v_plan_id,
    'planName', v_name,
    'model', v_model,
    'daily', jsonb_build_object('used', v_daily_used, 'limit', v_daily_limit),
    'monthlyTokens', jsonb_build_object('used', v_monthly_used, 'limit', v_monthly_limit),
    'resetsAt', to_char(v_resets at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );
end $$;

-- Registra una llamada de la pregunta p_turn y decide si se permite. En una sola transacción:
--   1) ráfaga: no más de requests_per_minute llamadas por minuto;
--   2) tokens del mes: si ya se agotaron, no se permite;
--   3) pregunta ya abierta (hoy o ayer, por si cruzó la medianoche): suma una llamada, hasta
--      max_calls_per_turn, sin gastar otra consulta;
--   4) pregunta nueva: suma una consulta del día si queda cupo (el contador sube de forma atómica,
--      así dos pedidos simultáneos no pueden pasarse del límite).
-- Devuelve { allowed, reason ('rate'|'monthly'|'turn'|'daily'|'plan'|null), counted, maxTokensPerRequest, quota }.
create or replace function public.ai_register_turn(p_user uuid, p_turn text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_today date := public.ai_today();
  v_month date := date_trunc('month', v_today::timestamp)::date;
  v_plan public.ai_plans%rowtype;
  v_minute_calls integer;
  v_tokens numeric;
  v_rows integer;
  v_reason text;
  v_counted boolean := false;
begin
  if p_user is null or p_turn is null or char_length(p_turn) not between 1 and 100 then
    raise exception 'ai_register_turn: parámetros inválidos' using errcode = '22023';
  end if;

  select p.* into v_plan
    from public.ai_plans p
   where p.id = public.ai_effective_plan(p_user) and p.active;
  if not found then
    v_reason := 'plan';
  end if;

  -- 1) Ráfaga (cuenta también los intentos rechazados).
  if v_reason is null then
    insert into public.ai_rate as r (user_id, window_start, calls)
    values (p_user, now(), 1)
    on conflict (user_id) do update
      set window_start = case when r.window_start > now() - interval '1 minute' then r.window_start else now() end,
          calls = case when r.window_start > now() - interval '1 minute' then r.calls + 1 else 1 end
    returning r.calls into v_minute_calls;
    if v_minute_calls > v_plan.requests_per_minute then
      v_reason := 'rate';
    end if;
  end if;

  -- 2) Tokens del mes.
  if v_reason is null then
    select coalesce(sum(u.input_tokens + u.output_tokens + u.cache_read_tokens), 0)
      into v_tokens
      from public.ai_usage_daily u
     where u.user_id = p_user
       and u.day >= v_month;
    if v_tokens >= v_plan.monthly_tokens then
      v_reason := 'monthly';
    end if;
  end if;

  if v_reason is null then
    -- Limpieza de preguntas viejas del usuario.
    delete from public.ai_turns t
     where t.user_id = p_user
       and t.day < v_today - 2;

    -- 3) Pregunta ya abierta.
    update public.ai_turns t
       set calls = t.calls + 1
     where t.user_id = p_user
       and t.turn_id = p_turn
       and t.day >= v_today - 1
       and t.calls < v_plan.max_calls_per_turn;
    if not found then
      if exists (select 1 from public.ai_turns t
                  where t.user_id = p_user and t.turn_id = p_turn and t.day >= v_today - 1) then
        v_reason := 'turn';
      else
        -- 4) Pregunta nueva.
        insert into public.ai_turns (user_id, turn_id, day, calls)
        values (p_user, p_turn, v_today, 1)
        on conflict (user_id, turn_id, day) do nothing;
        get diagnostics v_rows = row_count;
        if v_rows = 0 then
          -- Otro pedido con el mismo turn_id la abrió recién: es una llamada más de esa pregunta.
          update public.ai_turns t
             set calls = t.calls + 1
           where t.user_id = p_user
             and t.turn_id = p_turn
             and t.day = v_today
             and t.calls < v_plan.max_calls_per_turn;
          if not found then
            v_reason := case
              when exists (select 1 from public.ai_turns t
                            where t.user_id = p_user and t.turn_id = p_turn and t.day = v_today) then 'turn'
              else 'daily'
            end;
          end if;
        elsif v_plan.daily_messages <= 0 then
          v_reason := 'daily';
        else
          insert into public.ai_usage_daily as u (user_id, day, messages)
          values (p_user, v_today, 1)
          on conflict (user_id, day) do update
            set messages = u.messages + 1,
                updated_at = now()
            where u.messages < v_plan.daily_messages;
          get diagnostics v_rows = row_count;
          if v_rows = 0 then
            v_reason := 'daily';
          else
            v_counted := true;
          end if;
        end if;
        -- Si la pregunta nueva no entró en el cupo, no queda registrada.
        if v_reason = 'daily' then
          delete from public.ai_turns t
           where t.user_id = p_user
             and t.turn_id = p_turn
             and t.day = v_today
             and t.calls <= 1;
        end if;
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'allowed', v_reason is null,
    'reason', v_reason,
    'counted', v_counted,
    'maxTokensPerRequest', coalesce(v_plan.max_tokens_per_request, 0),
    'quota', public.ai_quota_status(p_user)
  );
end $$;

-- Devuelve la consulta de una pregunta nueva cuya primera llamada falló del lado de la IA
-- (saturación o caída): no se descuenta. Solo si la pregunta tuvo una sola llamada.
create or replace function public.ai_release_turn(p_user uuid, p_turn text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_today date := public.ai_today();
  v_day date;
begin
  if p_user is null or p_turn is null then
    raise exception 'ai_release_turn: parámetros inválidos' using errcode = '22023';
  end if;

  select t.day into v_day
    from public.ai_turns t
   where t.user_id = p_user
     and t.turn_id = p_turn
     and t.day >= v_today - 1
     and t.calls <= 1
   order by t.day desc
   limit 1
   for update;

  if found then
    delete from public.ai_turns t
     where t.user_id = p_user
       and t.turn_id = p_turn
       and t.day = v_day
       and t.calls <= 1;
    if found then
      update public.ai_usage_daily u
         set messages = greatest(u.messages - 1, 0),
             updated_at = now()
       where u.user_id = p_user
         and u.day = v_day;
    end if;
  end if;

  return public.ai_quota_status(p_user);
end $$;

-- Suma el uso real de una llamada (lo que informó la API) y devuelve la cuota actualizada.
-- p_input incluye la escritura de caché; p_cache_read es la lectura de caché.
create or replace function public.ai_add_tokens(p_user uuid, p_input bigint, p_output bigint, p_cache_read bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_today date := public.ai_today();
  v_input bigint := least(greatest(coalesce(p_input, 0), 0), 100000000);
  v_output bigint := least(greatest(coalesce(p_output, 0), 0), 100000000);
  v_cache_read bigint := least(greatest(coalesce(p_cache_read, 0), 0), 100000000);
begin
  if p_user is null then
    raise exception 'ai_add_tokens: falta el usuario' using errcode = '22023';
  end if;

  insert into public.ai_usage_daily as u (user_id, day, requests, input_tokens, output_tokens, cache_read_tokens)
  values (p_user, v_today, 1, v_input, v_output, v_cache_read)
  on conflict (user_id, day) do update
    set requests = u.requests + 1,
        input_tokens = u.input_tokens + excluded.input_tokens,
        output_tokens = u.output_tokens + excluded.output_tokens,
        cache_read_tokens = u.cache_read_tokens + excluded.cache_read_tokens,
        updated_at = now();

  return public.ai_quota_status(p_user);
end $$;

-- Estado de la cuota del usuario que llama (solo lectura, para la interfaz del launcher).
create or replace function public.ai_my_quota() returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when auth.uid() is null then null else public.ai_quota_status(auth.uid()) end
$$;

-- ---------- Permisos de las funciones ----------
-- Postgres y Supabase dan EXECUTE a todos por defecto: se quita y se da solo a quien corresponde.

revoke all on function public.ai_touch_updated_at() from public, anon, authenticated;
revoke all on function public.ai_quota_tz() from public, anon, authenticated;
revoke all on function public.ai_today() from public, anon, authenticated;
revoke all on function public.ai_effective_plan(uuid) from public, anon, authenticated;
revoke all on function public.ai_quota_status(uuid) from public, anon, authenticated;
revoke all on function public.ai_register_turn(uuid, text) from public, anon, authenticated;
revoke all on function public.ai_release_turn(uuid, text) from public, anon, authenticated;
revoke all on function public.ai_add_tokens(uuid, bigint, bigint, bigint) from public, anon, authenticated;
revoke all on function public.ai_my_quota() from public, anon;

grant execute on function public.ai_quota_tz() to service_role;
grant execute on function public.ai_today() to service_role;
grant execute on function public.ai_effective_plan(uuid) to service_role;
grant execute on function public.ai_quota_status(uuid) to service_role;
grant execute on function public.ai_register_turn(uuid, text) to service_role;
grant execute on function public.ai_release_turn(uuid, text) to service_role;
grant execute on function public.ai_add_tokens(uuid, bigint, bigint, bigint) to service_role;
grant execute on function public.ai_my_quota() to authenticated, service_role;
