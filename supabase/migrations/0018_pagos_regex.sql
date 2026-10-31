-- 0018_pagos_regex.sql · Venus 1.0.13
-- Arreglo de 0017: en Postgres una repetición {m,n} admite como máximo 255, y el formato del Access Token de
-- Mercado Pago usaba {20,300}. Toda clave de Mercado Pago fallaba con 2201B (expresión regular inválida) al
-- guardar. El largo ahora se valida aparte. Idempotente.
create or replace function public.payments_admin_save(p_user uuid, p_settings jsonb, p_secrets jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_email text; k text; v text; v_name text; v_id uuid; v_changed text[]:='{}'; v_pattern text; v_max integer;
begin
 if not public.admin_is_admin_user(p_user) then raise exception 'admin_only' using errcode='42501'; end if;
 select email into v_email from auth.users where id=p_user;
 p_settings:=coalesce(p_settings,'{}'::jsonb); p_secrets:=coalesce(p_secrets,'{}'::jsonb);
 if jsonb_typeof(p_settings)<>'object' or jsonb_typeof(p_secrets)<>'object' then raise exception 'bad_request' using errcode='22023'; end if;
 for k, v in select key, value from jsonb_each_text(p_secrets) loop
   v_name:=private.payments_secret_name(k);
   if v_name is null then raise exception 'bad_secret:%', k using errcode='22023'; end if;
   v:=btrim(coalesce(v,''));
   v_pattern:=case k when 'mpAccessToken' then '^(APP_USR|TEST)-[A-Za-z0-9-]+$'
     when 'mpWebhookSecret' then '^[A-Za-z0-9]+$'
     when 'paypalClientId' then '^[A-Za-z0-9_-]+$'
     when 'paypalSecret' then '^[A-Za-z0-9_-]+$'
     when 'paypalWebhookId' then '^[A-Z0-9]+$' end;
   v_max:=case k when 'mpAccessToken' then 400 when 'paypalWebhookId' then 64 else 200 end;
   if v<>'' and (v !~ v_pattern or char_length(v) < 8 or char_length(v) > v_max) then
     raise exception 'bad_secret:%', k using errcode='22023';
   end if;
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
revoke all on function public.payments_admin_save(uuid,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.payments_admin_save(uuid,jsonb,jsonb) to service_role;
