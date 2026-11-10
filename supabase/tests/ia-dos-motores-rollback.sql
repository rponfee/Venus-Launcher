-- Escenarios de la migración 0056_ia_dos_motores.sql contra una base real, SIN dejar cambios.
--
-- Cómo se usa: en una sola consulta, pegar en este orden
--     begin;
--     <todo 0056_ia_dos_motores.sql>
--     <este archivo>
--     rollback;
-- El bloque termina SIEMPRE con una excepción ("RESULTADOS {...}" si todo salió bien, o el escenario que falló):
-- así la transacción queda abortada aunque falte el rollback final. No copia ni muestra datos de usuarios: solo
-- usa los ids dentro de la transacción y devuelve planes, saldos y banderas.
--
-- Necesita una cuenta con un saldo pagado de ChatGPT (ai_subscriptions.source = 'support') y la clave de OpenAI
-- cargada. Si además hay una cuenta con un plan dado a mano (source = 'admin'), prueba ese caso también. Si la
-- clave de Claude todavía no está cargada, prueba primero que sus planes no se venden ni se eligen solos y después
-- pone una de mentira DENTRO de la transacción para seguir (se deshace con el resto).
do $t$
declare
  u uuid; adm uuid; r jsonb; r2 jsonb; x jsonb; res jsonb := '{}'::jsonb; o uuid; pclaude uuid; popen uuid; q jsonb;
  v_nokey boolean; v_sells boolean; v_spent numeric; v_spent2 numeric; v_sid uuid; o2 uuid; pnew uuid; v_left numeric;
begin
  select s.user_id into u from public.ai_subscriptions s where s.source = 'support' and s.status = 'active' limit 1;
  select s.user_id into adm from public.ai_subscriptions s where s.source = 'admin' and s.status = 'active' limit 1;
  if u is null then raise exception 'SIN DATOS: hace falta una cuenta con un saldo pagado'; end if;
  if not private.ai_provider_ready('openai') then raise exception 'SIN DATOS: hace falta la clave de OpenAI cargada'; end if;
  v_nokey := not private.ai_provider_ready('anthropic');
  -- ¿Hay algún medio de pago configurado? (si no, ningún plan tiene precio y esa parte no se puede comprobar)
  v_sells := private.payments_quote('pro', 'paypal') is not null or private.payments_quote('pro', 'mercado_pago') is not null;
  res := res || jsonb_build_object('sinClaveDeClaude', v_nokey, 'hayMedioDePago', v_sells);

  -- 0) Sin la clave de Claude, sus planes salen como no disponibles y sin precio; los de ChatGPT, normales.
  if v_nokey then
    if exists (select 1 from jsonb_array_elements(public.ai_catalog()) e where e ->> 'provider' = 'anthropic' and (e ->> 'available')::boolean)
       or exists (select 1 from jsonb_array_elements(public.ai_catalog()) e where e ->> 'provider' = 'openai' and not (e ->> 'available')::boolean)
       or exists (select 1 from jsonb_array_elements(public.payments_catalog() -> 'plans') e where e ->> 'provider' = 'anthropic' and e -> 'prices' <> '{}'::jsonb)
       or private.payments_quote('claude_pro', 'paypal') is not null or private.payments_quote('claude_pro', 'mercado_pago') is not null then
      raise exception 'FALLA 0 (planes de un motor sin clave)';
    end if;
  end if;

  -- 1) El saldo que ya existía quedó como saldo de ChatGPT y la cuota trae los campos nuevos.
  q := public.ai_quota_status(u);
  if q ->> 'provider' <> 'openai' or jsonb_array_length(q -> 'wallets') <> 1 or (q -> 'wallets' -> 0 ->> 'active')::boolean is not true
     or q -> 'models' -> 0 ->> 'label' <> 'GPT-6 Luna' or q -> 'models' -> 0 ->> 'model' <> 'claude-haiku-5-5'
     or q -> 'models' -> 0 ->> 'providerModel' <> 'gpt-6-luna' then
    raise exception 'FALLA 1 (cuota inicial): %', q;
  end if;
  res := res || jsonb_build_object('s1', jsonb_build_object('plan', q -> 'plan', 'provider', q -> 'provider', 'tier', q -> 'tier'));

  -- 2) Las firmas viejas siguen funcionando (la Edge Function de la 6.0.0): ai_register_turn con cuatro parámetros,
  --    ai_end_call con uno y ai_add_usage con tres. modelId sigue siendo el id de Claude.
  r := public.ai_register_turn(u, 't-old', null, null);
  if (r ->> 'allowed')::boolean is not true or r ->> 'provider' <> 'openai' or r ->> 'modelId' not like 'claude-%'
     or r -> 'models' ->> 'openai' <> 'gpt-6-luna' then
    raise exception 'FALLA 2 (firma vieja): %', r - 'quota';
  end if;
  perform public.ai_end_call(u);
  if (select status from public.ai_call_reservations where id = (r ->> 'callId')::uuid) <> 'released' then
    raise exception 'FALLA 2 (ai_end_call de un parámetro)';
  end if;

  -- 3) La reserva sale del pedido real: 50.000 bytes y 16.000 tokens con GPT-6 Luna = US$ 0,01525.
  r := public.ai_register_turn(u, 't-1', 'haiku', 'high', 16000, 50000);
  if (r ->> 'allowed')::boolean is not true or (r ->> 'maxTokensPerRequest')::integer <> 16000
     or (select reserved_usd from public.ai_call_reservations where id = (r ->> 'callId')::uuid) <> 0.015250 then
    raise exception 'FALLA 3 (reserva): %', r - 'quota';
  end if;
  perform public.ai_add_usage(u, 'haiku', '[]'::jsonb);
  if (select status from public.ai_call_reservations where id = (r ->> 'callId')::uuid) <> 'settled' then
    raise exception 'FALLA 3 (ai_add_usage de tres parámetros)';
  end if;

  -- 4) Comprar un plan de Claude: saldo nuevo, queda en uso y el de ChatGPT no se toca.
  insert into public.payment_orders (user_id, plan_id, plan_name, provider, currency, amount, price_usd, budget_usd, quote, live, product)
  values (u, 'claude_pro', 'Claude Pro', 'paypal', 'USD', 18, 18, 12.5, '{}'::jsonb, true, 'ai_plan') returning id into o;
  r := public.payments_mark_paid(o, 'TEST-0056-A', 18, 'USD', true);
  select w.period_id into pclaude from public.ai_wallets w where w.user_id = u and w.ai_provider = 'anthropic';
  select w.period_id into popen from public.ai_wallets w where w.user_id = u and w.ai_provider = 'openai';
  q := public.ai_quota_status(u);
  if (r ->> 'applied')::boolean is not true or (r -> 'order' ->> 'carriedUsd')::numeric <> 0 or q ->> 'plan' <> 'claude_pro'
     or q ->> 'provider' <> 'anthropic' or jsonb_array_length(q -> 'wallets') <> 2 or q -> 'models' -> 1 ->> 'label' <> 'Sonnet 5.5' then
    raise exception 'FALLA 4 (compra de Claude): % / %', r, q;
  end if;

  -- 4b) Sin la clave de Claude, el cambio automático no elige ese saldo aunque tenga fondos. Después se pone una
  --     clave de mentira (dentro de la transacción) y sus planes pasan a estar disponibles.
  if v_nokey then
    perform private.ai_wallet_activate(u, 'openai');
    select spent_usd into v_spent from public.ai_paid_periods where id = popen;
    update public.ai_paid_periods set spent_usd = budget_usd - 0.000001 where id = popen;
    r := public.ai_register_turn(u, 't-nokey', null, null, 8000, 20000);
    if (r ->> 'allowed')::boolean is not false or r ->> 'reason' <> 'budget' or r -> 'switched' <> 'null'::jsonb
       or public.ai_quota_status(u) ->> 'provider' <> 'openai' then
      raise exception 'FALLA 4b (cambio a un motor sin clave): %', r - 'quota';
    end if;
    update public.ai_paid_periods set spent_usd = v_spent where id = popen;
    select s.id into v_sid from vault.secrets s where s.name = 'venus_anthropic_key';
    if v_sid is null then perform vault.create_secret('valor-de-prueba', 'venus_anthropic_key');
    else perform vault.update_secret(v_sid, 'valor-de-prueba');
    end if;
    perform private.ai_wallet_activate(u, 'anthropic');
  end if;
  if not private.ai_provider_ready('anthropic')
     or exists (select 1 from jsonb_array_elements(public.ai_catalog()) e where not (e ->> 'available')::boolean)
     or (v_sells and private.payments_quote('claude_pro', 'paypal') is null and private.payments_quote('claude_pro', 'mercado_pago') is null) then
    raise exception 'FALLA 4b (planes con la clave cargada)';
  end if;

  -- 5) Sonnet en el plan de Claude va a Anthropic.
  r := public.ai_register_turn(u, 't-2', 'sonnet', 'high', 44000, 60000);
  if (r ->> 'allowed')::boolean is not true or r ->> 'provider' <> 'anthropic' or r -> 'models' ->> 'anthropic' <> 'claude-sonnet-5-5'
     or r -> 'models' ->> 'openai' <> 'gpt-5.6-sol' or (r ->> 'maxTokensPerRequest')::integer <> 44000 then
    raise exception 'FALLA 5 (Sonnet en Claude): %', r - 'quota';
  end if;
  perform public.ai_end_call(u);

  -- 5b) Dos llamadas en curso, una por saldo: cada una se cierra y se cobra en su período (p_call).
  r := public.ai_register_turn(u, 't-a', 'haiku', 'low', 2000, 2000);
  perform private.ai_wallet_activate(u, 'openai');
  r2 := public.ai_register_turn(u, 't-b', 'haiku', 'low', 2000, 2000);
  select spent_usd into v_spent from public.ai_paid_periods where id = pclaude;
  select spent_usd into v_spent2 from public.ai_paid_periods where id = popen;
  x := public.ai_add_usage(u, 'haiku', '[{"model":"gpt-6-luna","input":1000,"output":500,"cacheRead":0,"cacheWrite":0}]'::jsonb, (r2 ->> 'callId')::uuid);
  if r ->> 'provider' <> 'anthropic' or r2 ->> 'provider' <> 'openai'
     or (select status from public.ai_call_reservations where id = (r2 ->> 'callId')::uuid) <> 'settled'
     or (select status from public.ai_call_reservations where id = (r ->> 'callId')::uuid) <> 'reserved'
     or (select spent_usd from public.ai_paid_periods where id = popen) <> v_spent2 + 0.00035
     or (select spent_usd from public.ai_paid_periods where id = pclaude) <> v_spent then
    raise exception 'FALLA 5b (cierre exacto): % / % / %', r - 'quota', r2 - 'quota', x - 'quota';
  end if;
  perform public.ai_end_call(u, (r ->> 'callId')::uuid);
  if (select status from public.ai_call_reservations where id = (r ->> 'callId')::uuid) <> 'released' then
    raise exception 'FALLA 5b (ai_end_call con p_call)';
  end if;
  perform private.ai_wallet_activate(u, 'anthropic');

  -- 6) Con US$ 0,50 de saldo, la salida se recorta a lo que alcanza (y la reserva no pasa del saldo).
  update public.ai_paid_periods set spent_usd = budget_usd - 0.50 where id = pclaude;
  r := public.ai_register_turn(u, 't-3', 'sonnet', 'high', 44000, 20000);
  if (r ->> 'allowed')::boolean is not true or (r ->> 'maxTokensPerRequest')::integer not between 2048 and 43999
     or (select reserved_usd from public.ai_call_reservations where id = (r ->> 'callId')::uuid) > 0.50 then
    raise exception 'FALLA 6 (recorte por saldo): %', r - 'quota';
  end if;
  perform public.ai_end_call(u);

  -- 7) Saldo de Claude agotado: pasa solo al de ChatGPT, avisa, y la pregunta abierta sigue con el modelo que el
  --    otro plan sí tiene.
  update public.ai_paid_periods set spent_usd = budget_usd - 0.001 where id = pclaude;
  r := public.ai_register_turn(u, 't-3', null, null, 44000, 20000);
  if (r ->> 'allowed')::boolean is not true or r ->> 'provider' <> 'openai' or r -> 'switched' ->> 'from' <> 'anthropic'
     or r -> 'switched' ->> 'to' <> 'openai' or r -> 'switched' ->> 'reason' <> 'budget' or r ->> 'model' <> 'haiku'
     or r -> 'quota' ->> 'provider' <> 'openai' then
    raise exception 'FALLA 7 (cambio automático): %', r - 'quota';
  end if;
  perform public.ai_end_call(u);

  -- 7b) La llamada siguiente de esa pregunta repite el modelo y el esfuerzo del principio del turno (como el
  --     launcher): se ajusta al plan en uso en vez de rechazarse (antes, 403 model o effort).
  r := public.ai_register_turn(u, 't-3', 'sonnet', 'high', 44000, 20000);
  if (r ->> 'allowed')::boolean is not true or r ->> 'provider' <> 'openai' or r -> 'switched' <> 'null'::jsonb
     or r ->> 'model' <> 'haiku' or not (r ->> 'effort' = any (array['low', 'medium', 'high'])) then
    raise exception 'FALLA 7b (pregunta abierta después del cambio): %', r - 'quota';
  end if;
  perform public.ai_end_call(u);

  -- 8) El usuario elige el saldo a mano; un motor desconocido se rechaza.
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
  q := public.ai_use_wallet('anthropic');
  if q ->> 'provider' <> 'anthropic' then raise exception 'FALLA 8 (elegir saldo): %', q; end if;
  begin
    q := public.ai_use_wallet('gemini');
    raise exception 'FALLA 8 (motor desconocido aceptado)';
  exception when sqlstate '22023' then null;
  end;

  -- 9) Los dos saldos agotados: se rechaza por saldo, sin cambiar de motor.
  update public.ai_paid_periods set spent_usd = budget_usd where id in (pclaude, popen);
  r := public.ai_register_turn(u, 't-5', null, null, 8000, 20000);
  if (r ->> 'allowed')::boolean is not false or r ->> 'reason' <> 'budget' or r -> 'switched' <> 'null'::jsonb then
    raise exception 'FALLA 9 (sin saldo): %', r - 'quota';
  end if;

  -- 10) Devolución de la compra de Claude: ese saldo desaparece y vuelve a usarse el de ChatGPT.
  update public.ai_paid_periods set spent_usd = 0 where id = popen;
  r := public.payments_mark_status(o, 'refunded');
  q := public.ai_quota_status(u);
  if (r ->> 'applied')::boolean is not true or q ->> 'provider' <> 'openai' or jsonb_array_length(q -> 'wallets') <> 1
     or (q -> 'wallets' -> 0 ->> 'active')::boolean is not true then
    raise exception 'FALLA 10 (devolución): % / %', r, q;
  end if;

  -- 10b) Comprar otro plan del mismo motor con una llamada en curso: se arrastra todo lo que quedaba y la llamada
  --      pasa al período nuevo, donde se cierra y se cobra (antes lo reservado quedaba varado en el período viejo).
  r := public.ai_register_turn(u, 't-9', 'haiku', 'low', 2000, 2000);
  select pp.budget_usd - pp.spent_usd into v_left from public.ai_paid_periods pp where pp.id = popen;
  insert into public.payment_orders (user_id, plan_id, plan_name, provider, currency, amount, price_usd, budget_usd, quote, live, product)
  values (u, 'basic', 'ChatGPT Basic', 'paypal', 'USD', 6, 6, 3.5, '{}'::jsonb, true, 'ai_plan') returning id into o2;
  r2 := public.payments_mark_paid(o2, 'TEST-0056-B', 6, 'USD', true);
  select w.period_id into pnew from public.ai_wallets w where w.user_id = u and w.ai_provider = 'openai';
  x := public.ai_add_usage(u, 'haiku', '[{"model":"gpt-6-luna","input":1000,"output":500,"cacheRead":0,"cacheWrite":0}]'::jsonb, (r ->> 'callId')::uuid);
  if (r ->> 'allowed')::boolean is not true or r ->> 'provider' <> 'openai' or (r2 ->> 'applied')::boolean is not true
     or (r2 -> 'order' ->> 'carriedUsd')::numeric <> v_left or pnew is null or pnew = popen
     or (select c.period_id from public.ai_call_reservations c where c.id = (r ->> 'callId')::uuid) is distinct from pnew
     or (select c.status from public.ai_call_reservations c where c.id = (r ->> 'callId')::uuid) <> 'settled'
     or (select pp.budget_usd from public.ai_paid_periods pp where pp.id = pnew) <> 3.5 + v_left
     or (select pp.spent_usd from public.ai_paid_periods pp where pp.id = pnew) <> 0.00035
     or (select pp.spent_usd from public.ai_paid_periods pp where pp.id = popen) <> 0 then
    raise exception 'FALLA 10b (compra con una llamada en curso): % / % / %', r - 'quota', r2, x - 'quota';
  end if;

  -- 10c) Un plan dado a mano vigente no se pisa con el saldo pagado: ni el usuario (ai_use_wallet) ni el cambio
  --      automático cuando se agota (responde budget y la asignación queda). El plan a mano se agota con un uso
  --      del mes de mentira (dentro de la transacción).
  r := public.admin_set_plan(u, 'pro', null);
  begin
    q := public.ai_use_wallet('openai');
    raise exception 'FALLA 10c (ai_use_wallet pisó el plan dado a mano)';
  exception when sqlstate '22023' then null;
  end;
  insert into public.ai_usage_model_daily as d (user_id, day, model_id, cost_usd)
  values (u, public.ai_today(), 'sonnet', 1000)
  on conflict (user_id, day, model_id) do update set cost_usd = d.cost_usd + 1000;
  r2 := public.ai_register_turn(u, 't-10', null, null, 8000, 20000);
  if (r ->> 'applied')::boolean is not true or (r2 ->> 'allowed')::boolean is not false or r2 ->> 'reason' <> 'budget'
     or r2 -> 'switched' <> 'null'::jsonb
     or (select s.source || ':' || s.plan_id from public.ai_subscriptions s where s.user_id = u) <> 'admin:pro' then
    raise exception 'FALLA 10c (plan dado a mano agotado): % / %', r, r2 - 'quota';
  end if;

  -- 10d) Quitar plan corta la IA aunque la cuenta tenga un saldo pagado (el de ChatGPT de 10b): borra los saldos.
  --      admin_remove_plan no exige una sesión de administrador (la llama la Edge Function admin con la service
  --      role), así que se llama directo.
  r := public.admin_remove_plan(u);
  r2 := public.ai_register_turn(u, 't-rm', null, null, 8000, 20000);
  if (r ->> 'applied')::boolean is not true or (r2 ->> 'allowed')::boolean is not false or r2 ->> 'reason' <> 'noplan'
     or exists (select 1 from public.ai_wallets w where w.user_id = u) then
    raise exception 'FALLA 10d (quitar plan): % / %', r, r2 - 'quota';
  end if;
  begin
    q := public.ai_use_wallet('openai');
    raise exception 'FALLA 10d (el saldo volvió después de quitar el plan)';
  exception when sqlstate '22023' then null;
  end;

  -- 11) Un plan dado a mano por un administrador no es un saldo, pero funciona.
  if adm is not null then
    q := public.ai_quota_status(adm);
    r := public.ai_register_turn(adm, 't-adm', null, null, 8000, 20000);
    if (r ->> 'allowed')::boolean is not true or q ->> 'provider' is null then
      raise exception 'FALLA 11 (plan dado a mano): % / %', r - 'quota', q;
    end if;
    res := res || jsonb_build_object('s11', jsonb_build_object('plan', q -> 'plan', 'provider', q -> 'provider', 'wallets', jsonb_array_length(q -> 'wallets')));
  end if;

  -- 12) Catálogo, precios, panel y formulario de soporte.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  if jsonb_array_length(public.ai_catalog()) <> 10 or jsonb_array_length(public.payments_catalog() -> 'plans') <> 10
     or jsonb_array_length(public.payments_catalog() -> 'clans') <> 0 or jsonb_array_length(public.admin_plans() -> 'plans') <> 10
     or jsonb_array_length(public.admin_ai_providers() -> 'providers') <> 2
     or jsonb_array_length(public.admin_overview() -> 'subscriptions' -> 'byPlan') <> 10
     or (public.admin_ai_providers() -> 'keys' ->> 'anthropic')::boolean is not true then
    raise exception 'FALLA 12 (catálogo o panel)';
  end if;
  if private.support_details_clean('assistant', '{"plan":"claude_max","issue":"limit"}'::jsonb) ->> 'plan' <> 'claude_max'
     or private.support_details_clean('assistant', '{"plan":"go"}'::jsonb) ->> 'plan' <> 'go' then
    raise exception 'FALLA 12 (formulario de soporte)';
  end if;
  begin
    perform private.support_details_clean('assistant', '{"plan":"gemini"}'::jsonb);
    raise exception 'FALLA 12 (plan desconocido aceptado en soporte)';
  exception when sqlstate '22023' then null;
  end;
  res := res || jsonb_build_object('catalogo', (select jsonb_agg(jsonb_build_object('id', e -> 'id', 'motor', e -> 'provider', 'usd', e -> 'priceUsd',
    'saldo', e -> 'budgetUsd', 'tokens', e -> 'maxTokensPerRequest')) from jsonb_array_elements(public.ai_catalog()) e));

  -- Huella de cada función que creó la migración en esta transacción (el cuerpo sin espacios): sirve para comprobar
  -- que lo que corrió es exactamente el archivo.
  res := res || jsonb_build_object('fns', (select jsonb_agg(md5(regexp_replace(p.prosrc, '\s+', '', 'g')) order by 1) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'private') and p.xmin::text = (txid_current() % 4294967296)::text));

  raise exception 'RESULTADOS %', res::text;
end $t$;
