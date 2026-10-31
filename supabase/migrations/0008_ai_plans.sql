-- Venus Launcher · 0008 · IA: los planes reales (modelos, esfuerzos, preguntas por modelo y presupuesto).
-- Se aplica DESPUÉS de 0007_ai.sql: usa sus tablas ai_plans, ai_subscriptions, ai_turns y ai_rate.
--
-- Qué cambia respecto de 0007:
--   - No hay plan gratis: sin una suscripción vigente el usuario no tiene IA (la Edge Function responde 402).
--   - Cada plan ofrece uno o más modelos (ai_plan_models), cada uno con sus niveles de esfuerzo y su cupo de
--     preguntas por día y por semana. Los modelos y sus precios de lista están en ai_models.
--   - Cada plan tiene un presupuesto mensual en dólares (monthly_budget_usd): el gasto en la API de Anthropic
--     de cada usuario se calcula llamada por llamada (ai_usage_model_daily.cost_usd) y no puede pasarlo.
--   - El día, la semana (desde el lunes) y el mes se cuentan en la zona horaria de ai_quota_tz()
--     (America/Argentina/Buenos_Aires).
--   - Columnas viejas de ai_plans que ya no se usan: model, daily_messages y monthly_tokens (quedan por
--     compatibilidad). La tabla ai_usage_daily y la función ai_add_tokens de 0007 tampoco se usan más.
--
-- Desde el launcher (anon / authenticated) solo se puede LEER: el catálogo (planes y modelos activos) y el uso
-- propio. Las funciones de cuota solo las ejecuta la service role (la Edge Function "ai-assistant"), salvo
-- ai_my_quota(), que cada usuario puede usar para leer su propia cuota.
-- Idempotente: se puede volver a aplicar. No pisa precios, planes ni modelos editados después (ver
-- docs/backend-ia.md, "Planes: ver y editar").

-- ---------- Zona horaria y fechas ----------

-- Zona horaria de las cuotas: el día, la semana (lunes 00:00) y el mes se cuentan en esta zona.
-- Para cambiarla, reemplazá el texto (un nombre de la base de zonas horarias, por ejemplo 'UTC' o
-- 'America/Montevideo') y volvé a ejecutar solo esta función.
create or replace function public.ai_quota_tz() returns text
language sql stable set search_path = '' as $$
  select 'America/Argentina/Buenos_Aires'::text
$$;

-- Fecha y hora local (sin zona) según ai_quota_tz().
create or replace function public.ai_local_now() returns timestamp
language sql stable set search_path = '' as $$
  select now() at time zone public.ai_quota_tz()
$$;

-- Instante en formato ISO 8601 (UTC), como lo recibe el launcher.
create or replace function public.ai_iso(p_ts timestamptz) returns text
language sql stable set search_path = '' as $$
  select to_char(p_ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
$$;

-- ---------- Modelos y precios ----------
-- Una fila por modelo de Claude que conoce el backend, con su precio de lista en dólares por millón de
-- tokens. Los activos se pueden ofrecer en los planes; los inactivos sirven solo para calcular el costo
-- de los reintentos que la API hace en otro modelo (fallbacks: "default").

create table if not exists public.ai_models (
  id text primary key check (id ~ '^[a-z][a-z0-9_-]{1,31}$'),
  model_id text not null unique check (model_id ~ '^claude-[a-z0-9][a-z0-9-]{1,62}$'),
  label text not null check (char_length(label) between 1 and 40),
  input_usd_mtok numeric(10,4) not null check (input_usd_mtok >= 0),
  output_usd_mtok numeric(10,4) not null check (output_usd_mtok >= 0),
  cache_read_usd_mtok numeric(10,4) not null check (cache_read_usd_mtok >= 0),
  cache_write_usd_mtok numeric(10,4) not null check (cache_write_usd_mtok >= 0),
  -- Tarifa de contexto largo (opcional): si la entrada total de un pedido pasa este umbral, todo el pedido
  -- se cobra con las columnas long_*.
  long_context_threshold integer check (long_context_threshold > 0),
  long_input_usd_mtok numeric(10,4) check (long_input_usd_mtok >= 0),
  long_output_usd_mtok numeric(10,4) check (long_output_usd_mtok >= 0),
  long_cache_read_usd_mtok numeric(10,4) check (long_cache_read_usd_mtok >= 0),
  long_cache_write_usd_mtok numeric(10,4) check (long_cache_write_usd_mtok >= 0),
  supports_fallback boolean not null default false,
  price_note text check (char_length(price_note) <= 300),
  sort integer not null default 100,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_models_long_context_complete check (
    (long_context_threshold is null and long_input_usd_mtok is null and long_output_usd_mtok is null
      and long_cache_read_usd_mtok is null and long_cache_write_usd_mtok is null)
    or (long_context_threshold is not null and long_input_usd_mtok is not null and long_output_usd_mtok is not null
      and long_cache_read_usd_mtok is not null and long_cache_write_usd_mtok is not null)
  )
);

comment on table public.ai_models is 'Modelos de Claude y su precio de lista (USD por millón de tokens). Los inactivos solo se usan para calcular el costo de los reintentos en otro modelo.';
comment on column public.ai_models.id is 'Identificador corto que usa el protocolo (haiku, sonnet, opus). Para ofrecer un id nuevo hay que agregarlo también a MODEL_KEYS en supabase/functions/ai-assistant/config.ts.';
comment on column public.ai_models.model_id is 'Identificador del modelo en la API de Anthropic. La Edge Function siempre usa este valor (nunca el texto del cliente).';
comment on column public.ai_models.cache_write_usd_mtok is 'Escritura de caché de 5 minutos (la única que usa el backend).';
comment on column public.ai_models.long_context_threshold is 'Umbral de la tarifa de contexto largo: entrada + lectura + escritura de caché de UN pedido. Si lo pasa, todo el pedido usa las columnas long_*.';
comment on column public.ai_models.supports_fallback is 'Si la API puede reintentar en otro modelo (fallbacks: "default"). La Edge Function además solo lo usa con claude-opus-5-5 y claude-sonnet-5-5.';
comment on column public.ai_models.price_note is 'Aclaración sobre los precios (por ejemplo, cuáles son estimados).';
comment on column public.ai_models.active is 'false: no se puede ofrecer en los planes (las filas de solo precio de los modelos de respaldo están en false).';

-- Precios de lista de octubre de 2026. No pisa filas existentes: para corregir un precio, editá la fila.
insert into public.ai_models (id, model_id, label, input_usd_mtok, output_usd_mtok, cache_read_usd_mtok, cache_write_usd_mtok,
                              long_context_threshold, long_input_usd_mtok, long_output_usd_mtok, long_cache_read_usd_mtok,
                              long_cache_write_usd_mtok, supports_fallback, price_note, sort, active)
values
  ('haiku', 'claude-haiku-5-5', 'Haiku 5.5', 0.10, 0.50, 0.01, 0.125, 100000, 0.50, 2.50, 0.05, 0.625, false,
   'ESTIMADOS, verificar: lectura y escritura de caché (0,1x y 1,25x de la entrada), también en la tarifa de más de 100K tokens.', 10, true),
  ('sonnet', 'claude-sonnet-5-5', 'Sonnet 5.5', 2, 10, 0.20, 2.50, null, null, null, null, null, true, null, 20, true),
  ('opus', 'claude-opus-5-5', 'Opus 5.5', 4, 20, 0.20, 5, null, null, null, null, null, true, null, 30, true),
  -- Solo precio: modelos en los que la API puede reintentar un pedido rechazado (no se ofrecen en los planes).
  ('opus-5', 'claude-opus-5', 'Opus 5 (respaldo)', 5, 25, 0.50, 6.25, null, null, null, null, null, false,
   'Solo para el costo de los reintentos de Opus 5.5. Caché según los multiplicadores estándar: verificar.', 90, false),
  ('opus-4-8', 'claude-opus-4-8', 'Opus 4.8 (respaldo)', 5, 25, 0.50, 6.25, null, null, null, null, null, false,
   'Solo para el costo de los reintentos de Opus 5.5. Caché según los multiplicadores estándar: verificar.', 91, false),
  ('sonnet-5', 'claude-sonnet-5', 'Sonnet 5 (respaldo)', 2, 10, 0.20, 2.50, null, null, null, null, null, false,
   'Solo para el costo de los reintentos de Sonnet 5.5. Caché según los multiplicadores estándar: verificar.', 92, false)
on conflict (id) do nothing;

-- ---------- Planes: precio y presupuesto ----------

alter table public.ai_plans add column if not exists price_usd numeric(8,2) not null default 0 check (price_usd >= 0);
alter table public.ai_plans add column if not exists monthly_budget_usd numeric(8,2) not null default 0 check (monthly_budget_usd >= 0);
alter table public.ai_plans add column if not exists currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$');
-- Columnas viejas sin uso: con valor por defecto, un plan nuevo no necesita completarlas.
alter table public.ai_plans alter column daily_messages set default 0;
alter table public.ai_plans alter column monthly_tokens set default 0;

comment on column public.ai_plans.price_usd is 'Precio del plan por mes (en currency). Solo informativo: lo cobra el proveedor de pagos.';
comment on column public.ai_plans.monthly_budget_usd is 'Gasto máximo en la API de Anthropic por usuario y por mes calendario (USD). Con 0 el plan no da IA.';
comment on column public.ai_plans.currency is 'Moneda de price_usd (los presupuestos y costos son siempre en USD).';
comment on column public.ai_plans.model is 'SIN USO desde 0008: los modelos del plan están en ai_plan_models.';
comment on column public.ai_plans.daily_messages is 'SIN USO desde 0008: el cupo es por modelo (ai_plan_models.daily_questions y weekly_questions).';
comment on column public.ai_plans.monthly_tokens is 'SIN USO desde 0008: el límite mensual es monthly_budget_usd.';
comment on column public.ai_plans.max_tokens_per_request is 'Tope de max_tokens por llamada (nunca más de 16000).';
comment on column public.ai_plans.active is 'Si es false, el plan no se puede usar: sus usuarios se quedan sin IA (no hay plan gratis).';

-- La tabla real de planes. Solo completa planes nuevos o que todavía no tienen precio ni presupuesto
-- (por ejemplo 'pro' de 0007): volver a aplicar la migración no pisa los planes editados.
insert into public.ai_plans as p (id, name, model, daily_messages, monthly_tokens, max_tokens_per_request,
                                  max_calls_per_turn, requests_per_minute, sort, active, price_usd, monthly_budget_usd, currency)
values
  ('go', 'Go', 'claude-haiku-5-5', 0, 0, 8000, 30, 30, 10, true, 3.50, 1.50, 'USD'),
  ('pro', 'Pro', 'claude-sonnet-5-5', 0, 0, 16000, 40, 40, 20, true, 9.25, 5.00, 'USD'),
  ('super', 'Super', 'claude-sonnet-5-5', 0, 0, 16000, 40, 40, 30, true, 13.50, 7.00, 'USD'),
  ('ultra', 'Ultra', 'claude-sonnet-5-5', 0, 0, 16000, 60, 60, 40, true, 25.50, 12.00, 'USD'),
  ('max', 'Max', 'claude-opus-5-5', 0, 0, 16000, 60, 60, 50, true, 36.50, 19.00, 'USD'),
  ('supreme', 'Supreme', 'claude-opus-5-5', 0, 0, 16000, 60, 60, 60, true, 42.50, 23.00, 'USD')
on conflict (id) do update
  set name = excluded.name,
      model = excluded.model,
      daily_messages = excluded.daily_messages,
      monthly_tokens = excluded.monthly_tokens,
      max_tokens_per_request = excluded.max_tokens_per_request,
      max_calls_per_turn = excluded.max_calls_per_turn,
      requests_per_minute = excluded.requests_per_minute,
      sort = excluded.sort,
      active = excluded.active,
      price_usd = excluded.price_usd,
      monthly_budget_usd = excluded.monthly_budget_usd,
      currency = excluded.currency
  where p.price_usd = 0 and p.monthly_budget_usd = 0;

-- Los planes provisorios de 0007 dejan de usarse (las filas quedan por las suscripciones que los nombren).
update public.ai_plans
   set active = false
 where id in ('free', 'plus')
   and active
   and price_usd = 0
   and monthly_budget_usd = 0;

-- ---------- Modelos de cada plan ----------

create table if not exists public.ai_plan_models (
  plan_id text not null references public.ai_plans (id) on update cascade on delete cascade,
  model_id text not null references public.ai_models (id) on update cascade on delete restrict,
  -- Niveles de esfuerzo permitidos con este modelo en este plan.
  efforts text[] not null check (cardinality(efforts) between 1 and 3 and efforts <@ array['low', 'medium', 'high']::text[]),
  daily_questions integer not null check (daily_questions >= 0),
  weekly_questions integer not null check (weekly_questions >= 0),
  sort integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (plan_id, model_id)
);

create index if not exists ai_plan_models_model on public.ai_plan_models (model_id);

comment on table public.ai_plan_models is 'Modelos que ofrece cada plan, con sus esfuerzos y su cupo de preguntas por día y por semana (lunes a domingo).';
comment on column public.ai_plan_models.efforts is 'Esfuerzos permitidos: low, medium y/o high. Sin esfuerzo en el pedido se usa medium (o el más alto permitido por debajo).';
comment on column public.ai_plan_models.daily_questions is 'Preguntas por día con este modelo (una pregunta cuenta una vez aunque la IA use varias herramientas).';
comment on column public.ai_plan_models.weekly_questions is 'Preguntas por semana con este modelo (la semana empieza el lunes a las 00:00).';
comment on column public.ai_plan_models.sort is 'Orden: el primero es el modelo por defecto del plan (el que usa el protocolo 1).';

-- La tabla del dueño del proyecto. Solo carga los modelos de un plan que todavía no tiene ninguno:
-- volver a aplicar la migración no vuelve a agregar un modelo que quitaste de un plan.
insert into public.ai_plan_models (plan_id, model_id, efforts, daily_questions, weekly_questions, sort)
select v.plan_id, v.model_id, v.efforts, v.daily_questions, v.weekly_questions, v.sort
  from (values
    ('go', 'haiku', array['low', 'medium'], 35, 170, 10),
    ('pro', 'haiku', array['low', 'medium', 'high'], 25, 115, 10),
    ('pro', 'sonnet', array['low', 'medium'], 5, 20, 20),
    ('super', 'haiku', array['low', 'medium', 'high'], 25, 115, 10),
    ('super', 'sonnet', array['low', 'medium'], 6, 30, 20),
    ('ultra', 'haiku', array['low', 'medium', 'high'], 25, 115, 10),
    ('ultra', 'sonnet', array['low', 'medium', 'high'], 8, 40, 20),
    ('max', 'haiku', array['low', 'medium', 'high'], 25, 115, 10),
    ('max', 'sonnet', array['low', 'medium', 'high'], 8, 40, 20),
    ('max', 'opus', array['low', 'medium'], 4, 20, 30),
    ('supreme', 'haiku', array['low', 'medium', 'high'], 25, 115, 10),
    ('supreme', 'sonnet', array['low', 'medium', 'high'], 10, 50, 20),
    ('supreme', 'opus', array['low', 'medium', 'high'], 4, 20, 30)
  ) as v (plan_id, model_id, efforts, daily_questions, weekly_questions, sort)
 where not exists (select 1 from public.ai_plan_models pm where pm.plan_id = v.plan_id)
on conflict (plan_id, model_id) do nothing;

-- ---------- Uso por modelo ----------

-- Uso por usuario, día (local) y modelo. questions = preguntas nuevas, calls = llamadas a la IA,
-- cost_usd = lo que cobra Anthropic por esas llamadas según ai_models (incluidos los reintentos en otro modelo).
create table if not exists public.ai_usage_model_daily (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  model_id text not null references public.ai_models (id) on update cascade on delete restrict,
  questions integer not null default 0 check (questions >= 0),
  calls integer not null default 0 check (calls >= 0),
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  cache_read_tokens bigint not null default 0 check (cache_read_tokens >= 0),
  cache_write_tokens bigint not null default 0 check (cache_write_tokens >= 0),
  cost_usd numeric(12,6) not null default 0 check (cost_usd >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, day, model_id)
);

create index if not exists ai_usage_model_daily_model on public.ai_usage_model_daily (model_id);

comment on table public.ai_usage_model_daily is 'Uso diario por modelo: preguntas, llamadas, tokens y costo en USD. El día es el de ai_quota_tz(). Reemplaza a ai_usage_daily.';
comment on column public.ai_usage_model_daily.model_id is 'Modelo de la pregunta (ai_models.id). Si la API reintentó en otro modelo, el costo de ese intento se suma acá con el precio del modelo que respondió.';
comment on column public.ai_usage_model_daily.input_tokens is 'Entrada sin caché (la escritura y la lectura de caché van aparte).';
comment on column public.ai_usage_model_daily.output_tokens is 'Salida, incluido el razonamiento.';

comment on table public.ai_usage_daily is 'SIN USO desde 0008 (queda el historial): el uso está en ai_usage_model_daily.';

-- Cada pregunta queda atada al modelo con el que empezó.
alter table public.ai_turns add column if not exists model_id text references public.ai_models (id) on update cascade;
create index if not exists ai_turns_model on public.ai_turns (model_id);
comment on column public.ai_turns.model_id is 'Modelo de la pregunta (ai_models.id): todas sus llamadas usan ese modelo. null = pregunta de antes de 0008.';

-- ---------- updated_at automático ----------

drop trigger if exists ai_models_touch on public.ai_models;
create trigger ai_models_touch
  before update on public.ai_models
  for each row execute function public.ai_touch_updated_at();

drop trigger if exists ai_plan_models_touch on public.ai_plan_models;
create trigger ai_plan_models_touch
  before update on public.ai_plan_models
  for each row execute function public.ai_touch_updated_at();

-- ---------- RLS: el cliente solo lee; escribe únicamente la service role ----------

alter table public.ai_models enable row level security;
alter table public.ai_plan_models enable row level security;
alter table public.ai_usage_model_daily enable row level security;

drop policy if exists "ai_models_select_active" on public.ai_models;
create policy "ai_models_select_active" on public.ai_models
  for select to authenticated using (active);

drop policy if exists "ai_plan_models_select_active" on public.ai_plan_models;
create policy "ai_plan_models_select_active" on public.ai_plan_models
  for select to authenticated using (exists (select 1 from public.ai_plans p where p.id = ai_plan_models.plan_id and p.active));

drop policy if exists "ai_usage_model_daily_select_own" on public.ai_usage_model_daily;
create policy "ai_usage_model_daily_select_own" on public.ai_usage_model_daily
  for select to authenticated using ((select auth.uid()) = user_id);

revoke all on public.ai_models, public.ai_plan_models, public.ai_usage_model_daily from anon, authenticated;
grant select on public.ai_models, public.ai_plan_models, public.ai_usage_model_daily to authenticated;
grant all on public.ai_models, public.ai_plan_models, public.ai_usage_model_daily to service_role;

-- ---------- Funciones auxiliares ----------

-- Esfuerzo por defecto entre los permitidos: medium si está; si no, el más alto por debajo (low); si
-- tampoco está, el único que queda (high).
create or replace function public.ai_default_effort(p_efforts text[]) returns text
language sql immutable set search_path = '' as $$
  select case
    when 'medium' = any (p_efforts) then 'medium'
    when 'low' = any (p_efforts) then 'low'
    when 'high' = any (p_efforts) then 'high'
  end
$$;

-- Esfuerzos permitidos como lista JSON en orden fijo (low, medium, high), sin repetidos ni valores raros.
create or replace function public.ai_effort_list(p_efforts text[]) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_agg(e.effort_name order by e.effort_order), '[]'::jsonb)
    from unnest(array['low', 'medium', 'high']::text[]) with ordinality as e (effort_name, effort_order)
   where e.effort_name = any (p_efforts)
$$;

-- Número de tokens que manda la Edge Function: entero entre 0 y 100 millones (cualquier otra cosa es 0).
create or replace function public.ai_token_count(p_value jsonb) returns bigint
language sql immutable set search_path = '' as $$
  select case
    when jsonb_typeof(p_value) = 'number' then least(greatest(floor((p_value #>> '{}')::numeric), 0), 100000000)::bigint
    else 0::bigint
  end
$$;

-- Costo en USD de UN pedido a la API con los precios de p_model. Si el modelo tiene tarifa de contexto
-- largo y la entrada total del pedido (entrada + lectura + escritura de caché) pasa el umbral, todo el
-- pedido se cobra con esa tarifa. Para probarla:
--   select public.ai_price_line(m, 120000, 1000, 0, 0) from public.ai_models m where m.id = 'haiku';
create or replace function public.ai_price_line(p_model public.ai_models, p_input bigint, p_output bigint,
                                                p_cache_read bigint, p_cache_write bigint) returns numeric
language sql immutable set search_path = '' as $$
  select case
    when (p_model).long_context_threshold is not null
         and coalesce(p_input, 0) + coalesce(p_cache_read, 0) + coalesce(p_cache_write, 0) > (p_model).long_context_threshold
      then (coalesce(p_input, 0) * (p_model).long_input_usd_mtok
            + coalesce(p_output, 0) * (p_model).long_output_usd_mtok
            + coalesce(p_cache_read, 0) * (p_model).long_cache_read_usd_mtok
            + coalesce(p_cache_write, 0) * (p_model).long_cache_write_usd_mtok) / 1000000
    else (coalesce(p_input, 0) * (p_model).input_usd_mtok
          + coalesce(p_output, 0) * (p_model).output_usd_mtok
          + coalesce(p_cache_read, 0) * (p_model).cache_read_usd_mtok
          + coalesce(p_cache_write, 0) * (p_model).cache_write_usd_mtok) / 1000000
  end
$$;

-- ---------- Plan y cuota (solo service role) ----------
-- Todas son SECURITY DEFINER con search_path vacío y nombres calificados.

-- Plan vigente del usuario: suscripción active/trialing, sin vencer y con el plan activo. Si no, null
-- (no hay plan gratis). Para dar días de gracia con past_due, agregalo acá.
create or replace function public.ai_effective_plan(p_user uuid) returns text
language sql stable security definer set search_path = '' as $$
  select s.plan_id
    from public.ai_subscriptions s
    join public.ai_plans p on p.id = s.plan_id and p.active
   where s.user_id = p_user
     and s.status in ('active', 'trialing')
     and (s.current_period_end is null or s.current_period_end > now())
$$;

-- Estado de la cuota con la forma que recibe el launcher (QuotaV2, ver docs/backend-ia.md):
-- { plan, planName, priceUsd, status, models: [{ id, model, label, efforts, daily, weekly }],
--   budget: { usedUsd, limitUsd }, resets: { daily, weekly, monthly }, timezone, lastModel }.
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
    'budget', jsonb_build_object('usedUsd', round(v_spent, 4), 'limitUsd', coalesce(v_plan.monthly_budget_usd, 0)),
    'resets', jsonb_build_object(
      'daily', public.ai_iso((v_today + 1)::timestamp at time zone v_tz),
      'weekly', public.ai_iso((v_week + 7)::timestamp at time zone v_tz),
      'monthly', public.ai_iso((v_month + interval '1 month') at time zone v_tz)
    ),
    'timezone', v_tz,
    'lastModel', v_last
  );
end $$;

-- Catálogo de planes activos para mostrar: [{ id, name, priceUsd, budgetUsd, models: [{ id, label, efforts,
-- daily, weekly }] }], ordenado por sort.
create or replace function public.ai_catalog() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id,
           'name', p.name,
           'priceUsd', p.price_usd,
           'budgetUsd', p.monthly_budget_usd,
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
   where p.active
$$;

-- Registra una llamada de la pregunta p_turn con el modelo p_model (o null) y el esfuerzo p_effort (o null)
-- y decide si se permite. En una sola transacción:
--   1) plan vigente (si no hay: 'noplan');
--   2) modelo: el pedido, el de la pregunta ya abierta o el primero del plan; tiene que estar en el plan ('model');
--   3) esfuerzo: el pedido o el predeterminado; tiene que estar permitido para ese modelo ('effort');
--   4) una pregunta abierta sigue con su modelo ('turn_model');
--   5) ráfaga: no más de requests_per_minute llamadas por minuto ('rate');
--   6) presupuesto del mes: lo gastado (todos los modelos) tiene que ser menor que monthly_budget_usd ('budget');
--   7) pregunta ya abierta (hoy o ayer): suma una llamada, hasta max_calls_per_turn ('turn'), sin gastar otra pregunta;
--   8) pregunta nueva: suma una pregunta del día y de la semana de ese modelo si queda cupo ('daily' / 'weekly').
--      El contador sube de forma atómica: dos pedidos simultáneos no pueden pasarse del límite.
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
  v_spent numeric;
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

  -- 5) Ráfaga (cuenta también los intentos que después se rechazan por presupuesto o cupo).
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

  -- 6) Presupuesto del mes.
  if v_reason is null then
    select coalesce(sum(d.cost_usd), 0)
      into v_spent
      from public.ai_usage_model_daily d
     where d.user_id = p_user
       and d.day >= v_month;
    if v_spent >= v_plan.monthly_budget_usd then
      v_reason := 'budget';
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

-- La versión de 0007 (sin modelo ni esfuerzo) ya no sirve con los planes reales: rechaza siempre, así
-- una Edge Function vieja que siga desplegada no puede gastar fuera del presupuesto. Desplegá la nueva.
create or replace function public.ai_register_turn(p_user uuid, p_turn text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'allowed', false,
    'reason', 'plan',
    'counted', false,
    'maxTokensPerRequest', 0,
    'quota', public.ai_quota_status(p_user)
  )
$$;

-- Devuelve la pregunta nueva cuya primera llamada falló del lado de la IA (saturación o caída): no se
-- descuenta del día ni de la semana de su modelo. Solo si la pregunta tuvo una sola llamada.
create or replace function public.ai_release_turn(p_user uuid, p_turn text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_today date := public.ai_today();
  v_day date;
  v_model text;
begin
  if p_user is null or p_turn is null then
    raise exception 'ai_release_turn: parámetros inválidos' using errcode = '22023';
  end if;

  select t.day, t.model_id
    into v_day, v_model
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
    if found and v_model is not null then
      update public.ai_usage_model_daily d
         set questions = greatest(d.questions - 1, 0),
             updated_at = now()
       where d.user_id = p_user
         and d.day = v_day
         and d.model_id = v_model;
    end if;
  end if;

  return public.ai_quota_status(p_user);
end $$;

-- Suma el uso real de UNA llamada a la IA y su costo. p_model es el modelo de la pregunta (ai_models.id);
-- p_usage es la lista de intentos que informó la API (más de uno si hubo reintento en otro modelo):
--   [{ "model": "claude-opus-5-5", "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }, ...]
-- Cada intento se cobra con el precio del modelo que lo corrió (ai_models.model_id); si ese modelo no está
-- en ai_models, con el de p_model, y su id vuelve en "unpriced" para avisar en el log.
-- Devuelve { quota, costUsd, unpriced }.
create or replace function public.ai_add_usage(p_user uuid, p_model text, p_usage jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_today date := public.ai_today();
  v_base public.ai_models%rowtype;
  v_price public.ai_models%rowtype;
  v_line jsonb;
  v_line_model text;
  v_in bigint;
  v_out bigint;
  v_cache_read bigint;
  v_cache_write bigint;
  v_sum_in bigint := 0;
  v_sum_out bigint := 0;
  v_sum_cache_read bigint := 0;
  v_sum_cache_write bigint := 0;
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

    v_cost := v_cost + public.ai_price_line(v_price, v_in, v_out, v_cache_read, v_cache_write);
    v_sum_in := v_sum_in + v_in;
    v_sum_out := v_sum_out + v_out;
    v_sum_cache_read := v_sum_cache_read + v_cache_read;
    v_sum_cache_write := v_sum_cache_write + v_cache_write;
  end loop;

  insert into public.ai_usage_model_daily as d (user_id, day, model_id, calls, input_tokens, output_tokens,
                                                cache_read_tokens, cache_write_tokens, cost_usd)
  values (p_user, v_today, p_model, 1, v_sum_in, v_sum_out, v_sum_cache_read, v_sum_cache_write, v_cost)
  on conflict (user_id, day, model_id) do update
    set calls = d.calls + 1,
        input_tokens = d.input_tokens + excluded.input_tokens,
        output_tokens = d.output_tokens + excluded.output_tokens,
        cache_read_tokens = d.cache_read_tokens + excluded.cache_read_tokens,
        cache_write_tokens = d.cache_write_tokens + excluded.cache_write_tokens,
        cost_usd = d.cost_usd + excluded.cost_usd,
        updated_at = now();

  return jsonb_build_object(
    'quota', public.ai_quota_status(p_user),
    'costUsd', round(v_cost, 6),
    'unpriced', v_unpriced
  );
end $$;

-- Estado de la cuota del usuario que llama (solo lectura, para la interfaz del launcher). Igual que en
-- 0007, pero ahora devuelve la forma nueva (QuotaV2).
create or replace function public.ai_my_quota() returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when auth.uid() is null then null else public.ai_quota_status(auth.uid()) end
$$;

-- ---------- Permisos de las funciones ----------
-- Postgres y Supabase dan EXECUTE a todos por defecto: se quita y se da solo a quien corresponde.

revoke all on function public.ai_quota_tz() from public, anon, authenticated;
revoke all on function public.ai_local_now() from public, anon, authenticated;
revoke all on function public.ai_iso(timestamptz) from public, anon, authenticated;
revoke all on function public.ai_default_effort(text[]) from public, anon, authenticated;
revoke all on function public.ai_effort_list(text[]) from public, anon, authenticated;
revoke all on function public.ai_token_count(jsonb) from public, anon, authenticated;
revoke all on function public.ai_price_line(public.ai_models, bigint, bigint, bigint, bigint) from public, anon, authenticated;
revoke all on function public.ai_effective_plan(uuid) from public, anon, authenticated;
revoke all on function public.ai_quota_status(uuid) from public, anon, authenticated;
revoke all on function public.ai_catalog() from public, anon, authenticated;
revoke all on function public.ai_register_turn(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.ai_register_turn(uuid, text) from public, anon, authenticated;
revoke all on function public.ai_release_turn(uuid, text) from public, anon, authenticated;
revoke all on function public.ai_add_usage(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.ai_my_quota() from public, anon;

grant execute on function public.ai_quota_tz() to service_role;
grant execute on function public.ai_local_now() to service_role;
grant execute on function public.ai_iso(timestamptz) to service_role;
grant execute on function public.ai_default_effort(text[]) to service_role;
grant execute on function public.ai_effort_list(text[]) to service_role;
grant execute on function public.ai_token_count(jsonb) to service_role;
grant execute on function public.ai_price_line(public.ai_models, bigint, bigint, bigint, bigint) to service_role;
grant execute on function public.ai_effective_plan(uuid) to service_role;
grant execute on function public.ai_quota_status(uuid) to service_role;
grant execute on function public.ai_catalog() to service_role;
grant execute on function public.ai_register_turn(uuid, text, text, text) to service_role;
grant execute on function public.ai_register_turn(uuid, text) to service_role;
grant execute on function public.ai_release_turn(uuid, text) to service_role;
grant execute on function public.ai_add_usage(uuid, text, jsonb) to service_role;
grant execute on function public.ai_my_quota() to authenticated, service_role;
