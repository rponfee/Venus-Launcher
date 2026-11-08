-- OpenAI es el proveedor único de Venus IA. El alias haiku del protocolo sigue
-- existiendo para cuentas y turnos antiguos; todas las llamadas van a GPT-6 Luna.
-- No modifica monthly_budget_usd: el límite de gasto de cada plan se conserva.
update public.ai_provider_config
   set primary_provider = 'openai', secondary_provider = null,
       failover_enabled = false, note = 'Venus IA: OpenAI único proveedor'
 where id = 'default';

update public.ai_tier_fallbacks
   set model_id = 'gpt-6-luna', effort_low = 'low', effort_medium = 'medium',
       effort_high = 'high', active = true,
       note = 'Todos los planes usan GPT-6 Luna'
 where tier in ('haiku', 'sonnet', 'opus');

-- El protocolo admite xhigh desde 0016; se añade su traducción a OpenAI.
alter table public.ai_tier_fallbacks add column if not exists effort_xhigh text default 'xhigh';
alter table public.ai_tier_fallbacks drop constraint if exists ai_tier_fallbacks_effort_xhigh_check;
alter table public.ai_tier_fallbacks add constraint ai_tier_fallbacks_effort_xhigh_check
  check (effort_xhigh is null or effort_xhigh in ('none','minimal','low','medium','high','xhigh','max'));

create or replace function public.ai_provider_settings() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'primary', 'openai', 'secondary', null,
    'failoverEnabled', false, 'failoverOn', '[]'::jsonb,
    'openai', coalesce((
      select jsonb_object_agg(f.tier, jsonb_build_object(
        'model', m.model_id,
        'efforts', jsonb_build_object('low', f.effort_low,
          'medium', f.effort_medium, 'high', f.effort_high,
          'xhigh', f.effort_xhigh)))
        from public.ai_tier_fallbacks f
        join public.ai_models m on m.id = f.model_id and m.provider = 'openai'
       where f.active and f.provider = 'openai'
    ), '{}'::jsonb))
$$;

-- Solo cambia la oferta del modelo y el esfuerzo. Los precios y presupuestos
-- mensuales que estableció el propietario permanecen intactos.
-- `haiku` sigue siendo el identificador interno de preguntas antiguas. El
-- proveedor real se toma de ai_tier_fallbacks; no se invoca su model_id legado.
update public.ai_models
   set label = 'GPT-6 Luna (Venus IA)',
       input_usd_mtok = 0.10, output_usd_mtok = 0.50,
       cache_read_usd_mtok = 0.01, cache_write_usd_mtok = 0.125,
       long_context_threshold = 272000,
       long_input_usd_mtok = 0.20, long_output_usd_mtok = 0.75,
       long_cache_read_usd_mtok = 0.02, long_cache_write_usd_mtok = 0.25
 where id = 'haiku';
update public.ai_models set active = false where id in ('sonnet', 'opus');
-- La restricción anterior solo admitía identificadores Claude. Mantenerlos
-- válidos para filas históricas y admitir el modelo OpenAI de los planes.
alter table public.ai_plans drop constraint if exists ai_plans_model_check;
alter table public.ai_plans add constraint ai_plans_model_check
  check (model ~ '^(claude-[a-z0-9][a-z0-9-]{1,62}|gpt-[a-z0-9][a-z0-9.-]{0,60}|o[0-9][a-z0-9.-]{0,60})$');
update public.ai_plans set model = 'gpt-6-luna' where id in ('basic','go','pro','max');
delete from public.ai_plan_models
 where plan_id in ('basic','go','pro','max') and model_id <> 'haiku';
update public.ai_plan_models pm
   set efforts = case pm.plan_id
     when 'basic' then array['low']::text[]
     when 'go' then array['medium']::text[]
     when 'pro' then array['high']::text[]
     when 'max' then array['xhigh']::text[] end
 where pm.plan_id in ('basic','go','pro','max') and pm.model_id = 'haiku';

create or replace function public.ai_default_effort(p_efforts text[]) returns text
language sql immutable set search_path = '' as $$
  select case when 'xhigh' = any(p_efforts) then 'xhigh'
              when 'high' = any(p_efforts) then 'high'
              when 'medium' = any(p_efforts) then 'medium'
              when 'low' = any(p_efforts) then 'low' end
$$;

revoke all on function public.ai_provider_settings() from public, anon, authenticated;
grant execute on function public.ai_provider_settings() to service_role;

