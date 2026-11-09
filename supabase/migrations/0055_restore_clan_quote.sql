-- 0055_restore_clan_quote.sql
-- 0048_limpieza_retiros.sql retiró funciones con el prefijo private.clan_*.
-- También borró por accidente esta función de pagos de planes de Comunidades (0044).
-- payments_catalog() y payments_create_order() aún la llaman; sin ella falla
-- todo el catálogo, incluso los planes de Venus IA y PayPal.
-- No toca órdenes, precios, credenciales ni la configuración de proveedores.

create or replace function private.clan_quote(p_plan text, p_provider text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare p public.community_plans; q jsonb;
begin
  if p_plan is null or p_plan !~ '^clan_(go|pro|max|ultra)$' then return null; end if;
  select * into p from public.community_plans where id = substr(p_plan, 6) and active and price_usd > 0;
  if not found then return null; end if;
  q := private.payments_price(p.price_usd, p_provider);
  if q is null then return null; end if;
  return q || jsonb_build_object('product', 'clan_plan', 'budgetUsd', 0, 'plan', 'clan_' || p.id, 'planName', 'Clanes ' || p.name, 'tier', p.id, 'periodDays', p.period_days);
end $$;

revoke all on function private.clan_quote(text, text) from public, anon, authenticated;

-- El catálogo se evalúa completo: si alguna otra dependencia falta, la
-- migración falla antes de quedar registrada.
do $$
declare v_catalog jsonb;
begin
  v_catalog := public.payments_catalog();
  if v_catalog is null or jsonb_typeof(v_catalog -> 'providers') <> 'object'
      or jsonb_typeof(v_catalog -> 'plans') <> 'array'
      or jsonb_typeof(v_catalog -> 'clans') <> 'array' then
    raise exception 'payments_catalog_invalid' using errcode = '22023';
  end if;
end $$;
