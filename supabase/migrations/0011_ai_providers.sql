-- Venus Launcher · 0011 · IA: dos proveedores. Anthropic (Claude) es el principal y OpenAI (ChatGPT) el
-- secundario: si Anthropic falla por un problema del proveedor (saturación, caída, límites de la organización,
-- sin crédito, clave o modelo mal configurados), la Edge Function "ai-assistant" pasa el pedido a OpenAI.
-- Se aplica DESPUÉS de 0008_ai_plans.sql: usa ai_models, ai_usage_model_daily y reemplaza ai_add_usage.
--
-- Qué agrega:
--   - ai_models.provider ('anthropic' | 'openai') y las filas de precio de los modelos de OpenAI. Son filas de
--     solo precio (active = false): nunca se ofrecen en los planes. Los planes siguen hablando de haiku,
--     sonnet y opus, y las preguntas se siguen contando en esos modelos.
--   - ai_tier_fallbacks: qué modelo de OpenAI reemplaza a cada modelo de Venus y cómo se traduce el esfuerzo.
--   - ai_provider_config: proveedor principal y secundario, si el respaldo está activo y qué fallas lo activan.
--   - ai_provider_settings(): la configuración que lee la Edge Function (una vez por minuto).
--   - ai_add_usage: el uso de OpenAI se registra en la fila de SU modelo con SU precio (el presupuesto del mes
--     suma todas las filas, así que sigue siendo exacto). El uso de Anthropic, igual que en 0008.
--
-- Las tablas nuevas solo las lee y escribe la service role (Edge Function y panel): RLS activada y sin políticas.
-- Idempotente: se puede volver a aplicar. No pisa la configuración ni las filas editadas después.
-- Cómo cambiar el orden de los proveedores o apagar el respaldo: docs/backend-ia.md, sección 12.

-- ---------- Modelos: proveedor ----------

alter table public.ai_models add column if not exists provider text not null default 'anthropic';

comment on table public.ai_models is 'Modelos de IA (Anthropic y OpenAI) y su precio de lista (USD por millón de tokens). Los inactivos solo se usan para calcular el costo (reintentos en otro modelo y respaldo en OpenAI).';
comment on column public.ai_models.provider is 'anthropic u openai. Los de OpenAI son solo de precio (active = false): los usa el respaldo (ai_tier_fallbacks), nunca los planes.';
comment on column public.ai_models.model_id is 'Identificador del modelo en la API de su proveedor. La Edge Function siempre usa este valor (nunca el texto del cliente).';
comment on column public.ai_models.cache_read_usd_mtok is 'Lectura de caché (en OpenAI, "cached input").';
comment on column public.ai_models.cache_write_usd_mtok is 'Escritura de caché: 5 minutos en Anthropic (la única que usa el backend); 30 minutos en OpenAI (en los modelos de OpenAI que no la cobran aparte, igual a la entrada).';

do $$
declare
  v_name text;
begin
  -- 0008 solo aceptaba ids "claude-...": ese check se reemplaza por uno que depende del proveedor.
  for v_name in
    select c.conname
      from pg_catalog.pg_constraint c
     where c.conrelid = 'public.ai_models'::regclass
       and c.contype = 'c'
       and c.conname <> 'ai_models_model_id_format'
       and pg_catalog.pg_get_constraintdef(c.oid) like '%model_id%'
       and pg_catalog.pg_get_constraintdef(c.oid) like '%claude-%'
  loop
    execute format('alter table public.ai_models drop constraint %I', v_name);
  end loop;

  if not exists (select 1 from pg_catalog.pg_constraint c
                  where c.conrelid = 'public.ai_models'::regclass and c.conname = 'ai_models_provider_check') then
    alter table public.ai_models add constraint ai_models_provider_check check (provider in ('anthropic', 'openai'));
  end if;

  if not exists (select 1 from pg_catalog.pg_constraint c
                  where c.conrelid = 'public.ai_models'::regclass and c.conname = 'ai_models_model_id_format') then
    alter table public.ai_models add constraint ai_models_model_id_format check (
      (provider = 'anthropic' and model_id ~ '^claude-[a-z0-9][a-z0-9-]{1,62}$')
      or (provider = 'openai' and model_id ~ '^(gpt-[a-z0-9][a-z0-9.-]{0,60}|o[0-9][a-z0-9.-]{0,60})$')
    );
  end if;

  -- Un modelo de OpenAI nunca se ofrece en un plan ni usa los reintentos de Anthropic.
  if not exists (select 1 from pg_catalog.pg_constraint c
                  where c.conrelid = 'public.ai_models'::regclass and c.conname = 'ai_models_openai_price_only') then
    alter table public.ai_models add constraint ai_models_openai_price_only check (
      provider = 'anthropic' or (not active and not supports_fallback)
    );
  end if;

  -- Para que ai_tier_fallbacks solo pueda apuntar a modelos de OpenAI (clave foránea compuesta).
  if not exists (select 1 from pg_catalog.pg_constraint c
                  where c.conrelid = 'public.ai_models'::regclass and c.conname = 'ai_models_id_provider_key') then
    alter table public.ai_models add constraint ai_models_id_provider_key unique (id, provider);
  end if;
end $$;

-- Precios de lista de OpenAI (nivel Standard) de octubre de 2026, en USD por millón de tokens: entrada, salida,
-- entrada en caché, escritura de caché de 30 minutos y, para pedidos de más de 272.000 tokens de entrada, las
-- columnas long_* (el doble la entrada y la caché, 1,5 veces la salida). Fuente: https://developers.openai.com/api/docs/pricing
-- y las páginas de cada modelo. VERIFICAR antes de abrir el respaldo. No pisa filas existentes: para corregir un
-- precio, editá la fila.
insert into public.ai_models (id, model_id, provider, label, input_usd_mtok, output_usd_mtok, cache_read_usd_mtok,
                              cache_write_usd_mtok, long_context_threshold, long_input_usd_mtok, long_output_usd_mtok,
                              long_cache_read_usd_mtok, long_cache_write_usd_mtok, supports_fallback, price_note, sort, active)
values
  ('gpt-6-luna', 'gpt-6-luna', 'openai', 'GPT-6 Luna (respaldo)', 0.10, 0.50, 0.01, 0.125, 272000, 0.20, 0.75, 0.02, 0.25, false,
   'OpenAI, lista de oct. 2026 (Standard), VERIFICAR en developers.openai.com/api/docs/pricing. Escritura de caché de 30 min. Sin Fast, Flex ni procesamiento regional (+10 %).', 110, false),
  ('gpt-6-1-terra', 'gpt-6.1-terra', 'openai', 'GPT-6.1 Terra (respaldo)', 1, 5, 0.05, 1.25, 272000, 2, 7.50, 0.10, 2.50, false,
   'OpenAI, lista de oct. 2026 (Standard), VERIFICAR en developers.openai.com/api/docs/pricing. Escritura de caché de 30 min. Sin Fast, Flex ni procesamiento regional (+10 %).', 120, false),
  ('gpt-6-1-sol', 'gpt-6.1-sol', 'openai', 'GPT-6.1 Sol (respaldo)', 2, 10, 0.10, 2.50, 272000, 4, 15, 0.20, 5, false,
   'OpenAI, lista de oct. 2026 (Standard), VERIFICAR en developers.openai.com/api/docs/pricing. Escritura de caché de 30 min. Sin Fast, Flex ni procesamiento regional (+10 %).', 130, false),
  ('gpt-6-astra', 'gpt-6-astra', 'openai', 'GPT-6 Astra (respaldo)', 10, 50, 1, 12.50, 272000, 20, 75, 2, 25, false,
   'OpenAI, lista de oct. 2026 (Standard), VERIFICAR en developers.openai.com/api/docs/pricing. Escritura de caché de 30 min. Sin Fast, Flex ni procesamiento regional (+10 %).', 140, false)
on conflict do nothing;

-- ---------- Modelo de respaldo de cada modelo de Venus ----------

create table if not exists public.ai_tier_fallbacks (
  -- Modelo de Venus (ai_models.id): haiku, sonnet u opus.
  tier text primary key references public.ai_models (id) on update cascade on delete cascade,
  provider text not null default 'openai',
  -- Modelo de OpenAI que lo reemplaza (ai_models.id de una fila con provider = 'openai').
  model_id text not null,
  -- Esfuerzo de Venus -> reasoning.effort de OpenAI. null: no se manda (el modelo usa el suyo por defecto).
  effort_low text default 'low',
  effort_medium text default 'medium',
  effort_high text default 'high',
  active boolean not null default true,
  note text check (char_length(note) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_tier_fallbacks_provider_check check (provider = 'openai'),
  constraint ai_tier_fallbacks_efforts_check check (
    (effort_low is null or effort_low in ('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'))
    and (effort_medium is null or effort_medium in ('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'))
    and (effort_high is null or effort_high in ('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'))
  ),
  constraint ai_tier_fallbacks_model_fkey foreign key (model_id, provider)
    references public.ai_models (id, provider) on update cascade on delete restrict
);

create index if not exists ai_tier_fallbacks_model on public.ai_tier_fallbacks (model_id, provider);

comment on table public.ai_tier_fallbacks is 'Modelo de OpenAI que atiende las preguntas de cada modelo de Venus cuando responde el respaldo. La pregunta se sigue contando en el modelo de Venus; el costo, con el precio del modelo de OpenAI.';
comment on column public.ai_tier_fallbacks.effort_low is 'reasoning.effort de OpenAI para el esfuerzo "low" de Venus (none, minimal, low, medium, high, xhigh o max; cuáles acepta depende del modelo). null: no se manda.';
comment on column public.ai_tier_fallbacks.active is 'false: ese modelo de Venus no tiene respaldo (si Anthropic falla, el error llega al launcher).';

-- Modelos equivalentes: chico y rápido para Haiku, intermedio para Sonnet y el más capaz para Opus. Solo carga los
-- modelos de Venus que todavía no tienen fila: volver a aplicar no pisa lo editado.
insert into public.ai_tier_fallbacks (tier, provider, model_id, effort_low, effort_medium, effort_high, note)
select v.tier, 'openai', v.model_id, v.effort_low, v.effort_medium, v.effort_high, v.note
  from (values
    ('haiku', 'gpt-6-luna', 'low', 'medium', 'high', 'El más eficiente de OpenAI: mismo precio de lista que Haiku 5.5.'),
    ('sonnet', 'gpt-6-1-sol', 'low', 'medium', 'high', 'Cerca del más capaz: mismo precio de lista que Sonnet 5.5.'),
    ('opus', 'gpt-6-astra', 'low', 'medium', 'high', 'El más capaz de OpenAI: cuesta unas 2,5 veces Opus 5.5 (el presupuesto lo cobra con su precio).')
  ) as v (tier, model_id, effort_low, effort_medium, effort_high, note)
 where exists (select 1 from public.ai_models m where m.id = v.tier and m.provider = 'anthropic')
   and exists (select 1 from public.ai_models m where m.id = v.model_id and m.provider = 'openai')
on conflict (tier) do nothing;

-- ---------- Proveedores: principal, secundario y cuándo se pasa al otro ----------

create table if not exists public.ai_provider_config (
  -- Una sola fila ('default').
  id text primary key default 'default',
  primary_provider text not null default 'anthropic',
  -- null: sin proveedor secundario.
  secondary_provider text default 'openai',
  failover_enabled boolean not null default true,
  -- Fallas del proveedor que pasan el pedido al otro. Nunca se pueden agregar el rechazo de la IA ni un pedido
  -- inválido (400): no son fallas del proveedor.
  failover_on text[] not null default array['rate_limited', 'overloaded', 'unavailable', 'timeout', 'network', 'billing',
                                              'auth', 'permission', 'config', 'model', 'not_configured']::text[],
  note text check (char_length(note) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_provider_config_single check (id = 'default'),
  constraint ai_provider_config_primary_check check (primary_provider in ('anthropic', 'openai')),
  constraint ai_provider_config_secondary_check check (
    secondary_provider is null or (secondary_provider in ('anthropic', 'openai') and secondary_provider <> primary_provider)
  ),
  constraint ai_provider_config_failover_on_check check (
    failover_on <@ array['rate_limited', 'overloaded', 'unavailable', 'timeout', 'network', 'billing', 'auth', 'permission',
                         'config', 'model', 'not_configured', 'unknown']::text[]
  )
);

comment on table public.ai_provider_config is 'Proveedores de la IA (una sola fila): principal, secundario, si el respaldo está activo y qué fallas lo activan. La Edge Function la lee una vez por minuto.';
comment on column public.ai_provider_config.failover_on is 'rate_limited (429), overloaded (529), unavailable (5xx), timeout, network, billing (sin crédito), auth (401), permission (403), config (beta o parámetro no habilitado), model (404, modelo no disponible), not_configured (falta la clave del principal) y, opcional, unknown (otros errores).';

insert into public.ai_provider_config (id) values ('default') on conflict (id) do nothing;

-- ---------- updated_at automático (función de 0007) ----------

drop trigger if exists ai_tier_fallbacks_touch on public.ai_tier_fallbacks;
create trigger ai_tier_fallbacks_touch
  before update on public.ai_tier_fallbacks
  for each row execute function public.ai_touch_updated_at();

drop trigger if exists ai_provider_config_touch on public.ai_provider_config;
create trigger ai_provider_config_touch
  before update on public.ai_provider_config
  for each row execute function public.ai_touch_updated_at();

-- ---------- RLS: solo la service role ----------

alter table public.ai_tier_fallbacks enable row level security;
alter table public.ai_provider_config enable row level security;

-- Sin políticas: el launcher (anon / authenticated) no las ve. La service role no pasa por RLS.
revoke all on public.ai_tier_fallbacks, public.ai_provider_config from anon, authenticated;
grant all on public.ai_tier_fallbacks, public.ai_provider_config to service_role;

comment on table public.ai_usage_model_daily is 'Uso diario por modelo: preguntas, llamadas, tokens y costo en USD. El día es el de ai_quota_tz(). Las filas de modelos de OpenAI (respaldo) tienen llamadas, tokens y costo, nunca preguntas.';
comment on column public.ai_usage_model_daily.model_id is 'Modelo de la pregunta (ai_models.id), o el modelo de OpenAI que respondió como respaldo. Los reintentos de Anthropic en otro modelo se suman al modelo de la pregunta con el precio del modelo que respondió.';

-- ---------- Funciones ----------

-- Configuración de proveedores para la Edge Function:
-- { primary, secondary, failoverEnabled, failoverOn: [...], openai: { haiku: { model, efforts: { low, medium, high } }, ... } }.
-- Sin la fila de ai_provider_config: solo Anthropic (sin respaldo).
create or replace function public.ai_provider_settings() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'primary', coalesce(c.primary_provider, 'anthropic'),
    'secondary', c.secondary_provider,
    'failoverEnabled', coalesce(c.failover_enabled, false),
    'failoverOn', coalesce(to_jsonb(c.failover_on), '[]'::jsonb),
    'openai', coalesce((
      select jsonb_object_agg(f.tier, jsonb_build_object(
               'model', m.model_id,
               'efforts', jsonb_build_object('low', f.effort_low, 'medium', f.effort_medium, 'high', f.effort_high)
             ))
        from public.ai_tier_fallbacks f
        join public.ai_models m on m.id = f.model_id and m.provider = 'openai'
       where f.active
         and f.provider = 'openai'
    ), '{}'::jsonb)
  )
    from (select 1) as one
    left join public.ai_provider_config c on c.id = 'default'
$$;

-- Suma el uso real de UNA llamada a la IA y su costo. p_model es el modelo de la pregunta (ai_models.id);
-- p_usage es la lista de intentos que informó la API:
--   [{ "model": "claude-opus-5-5", "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }, ...]
-- Cada intento se cobra con el precio del modelo que lo corrió (ai_models.model_id); si ese modelo no está en
-- ai_models, con el de p_model, y su id vuelve en "unpriced" para avisar en el log.
-- Dónde queda: los intentos de Anthropic (también sus reintentos en otro modelo) en la fila de p_model, igual que
-- en 0008; los de OpenAI (respaldo), en la fila de SU modelo, sin sumar preguntas. Para OpenAI, la Edge Function
-- manda la entrada sin caché en "input", la entrada en caché en "cacheRead", la escritura de caché en
-- "cacheWrite" y la salida con el razonamiento incluido en "output".
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

-- ---------- Permisos de las funciones ----------
-- Postgres y Supabase dan EXECUTE a todos por defecto: se quita y se da solo a la service role.

revoke all on function public.ai_provider_settings() from public, anon, authenticated;
revoke all on function public.ai_add_usage(uuid, text, jsonb) from public, anon, authenticated;

grant execute on function public.ai_provider_settings() to service_role;
grant execute on function public.ai_add_usage(uuid, text, jsonb) to service_role;
