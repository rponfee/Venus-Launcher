-- Venus Launcher 3.0.10: lo que salió de auditar pagos y permisos.
-- 1) Un pago de prueba (sandbox) ya no da saldo real, salvo a los administradores, que lo usan para probar el flujo.
-- 2) Una devolución también corta el saldo de esa orden que había pasado a una compra posterior.
-- 3) Permisos de más en profiles: RLS ya los frenaba (no hay políticas de insert ni delete), pero no hacen falta.

-- ---------- 1) Acreditar un pago confirmado por el proveedor (0017), sin saldo real para pagos de prueba ----------
create or replace function public.payments_mark_paid(p_order uuid, p_payment_id text, p_amount numeric, p_currency text,
  p_live boolean, p_provider_status text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_order public.payment_orders%rowtype; v_plan public.ai_plans%rowtype; v_prev public.ai_paid_periods%rowtype;
 v_carry numeric:=0; v_period uuid; v_reserved numeric;
begin
 if p_payment_id is null or char_length(p_payment_id) not between 1 and 200 then
   raise exception 'bad_payment' using errcode='22023';
 end if;
 select * into v_order from public.payment_orders where id=p_order for update;
 if not found then return jsonb_build_object('applied',false,'reason','order_not_found'); end if;
 if v_order.status='paid' then
   return jsonb_build_object('applied',false,'reason','already_paid','order',private.payments_order_json(v_order));
 end if;
 if v_order.status='refunded' then
   return jsonb_build_object('applied',false,'reason','refunded','order',private.payments_order_json(v_order));
 end if;
 if not coalesce(p_live,false) and not public.admin_is_admin_user(v_order.user_id) then
   if v_order.provider_status is distinct from 'test_payment' then
     perform public.admin_log(null,null,'payments.testRejected',v_order.user_id,jsonb_build_object('orderId',v_order.id,
       'provider',v_order.provider,'paymentId',p_payment_id));
   end if;
   update public.payment_orders set status='failed', provider_status='test_payment', live=false, checked_at=now(), updated_at=now() where id=p_order;
   return jsonb_build_object('applied',false,'reason','test_payment');
 end if;
 if upper(coalesce(p_currency,''))<>v_order.currency or p_amount is null or p_amount<v_order.amount-0.01 then
   update public.payment_orders set provider_status='amount_mismatch', checked_at=now(), updated_at=now() where id=p_order;
   perform public.admin_log(null,null,'payments.amountMismatch',v_order.user_id,jsonb_build_object('orderId',v_order.id,
     'expected',v_order.amount,'currency',v_order.currency,'received',p_amount,'receivedCurrency',p_currency,'paymentId',p_payment_id));
   return jsonb_build_object('applied',false,'reason','amount_mismatch');
 end if;
 select * into v_plan from public.ai_plans where id=v_order.plan_id;
 perform pg_advisory_xact_lock(hashtextextended(v_order.user_id::text,816));
 -- Saldo que quedaba del período vigente (menos lo reservado por preguntas en curso).
 select pp.* into v_prev from public.ai_subscriptions s join public.ai_paid_periods pp on pp.id=s.support_period_id
  where s.user_id=v_order.user_id and s.source='support' and (pp.ends_at is null or pp.ends_at>now());
 if found then
   select coalesce(sum(r.reserved_usd),0) into v_reserved from public.ai_call_reservations r
    where r.period_id=v_prev.id and r.status='reserved';
   v_carry:=greatest(0, v_prev.budget_usd-v_prev.spent_usd-v_reserved);
   if public.ai_effective_plan(v_order.user_id) is null then v_carry:=0; end if;
 end if;
 insert into public.ai_paid_periods(user_id,order_id,plan_id,starts_at,ends_at,budget_usd)
 values (v_order.user_id, v_order.id, v_order.plan_id, now(), null, least(v_order.budget_usd+v_carry, 9999))
 returning id into v_period;
 insert into public.ai_subscriptions(user_id,plan_id,status,current_period_end,source,external_ref,support_period_id)
 values (v_order.user_id, v_order.plan_id, 'active', null, 'support', 'order:'||v_order.id, v_period)
 on conflict (user_id) do update set plan_id=excluded.plan_id, status='active', current_period_end=null,
   source='support', external_ref=excluded.external_ref, support_period_id=v_period,
   stripe_customer_id=null, stripe_subscription_id=null, stripe_price_id=null, stripe_status=null,
   cancel_at_period_end=false, grace_until=null, budget_cap_usd=null, budget_cap_until=null, updated_at=now();
 update public.payment_orders set status='paid', paid_at=now(), provider_payment_id=p_payment_id,
   provider_status=coalesce(left(p_provider_status,60),'paid'), live=coalesce(p_live,live), period_id=v_period,
   carried_usd=v_carry, checked_at=now(), updated_at=now()
  where id=p_order returning * into v_order;
 perform public.admin_log(null,null,'payments.paid',v_order.user_id,jsonb_build_object('orderId',v_order.id,'plan',v_order.plan_id,
   'provider',v_order.provider,'amount',v_order.amount,'currency',v_order.currency,'priceUsd',v_order.price_usd,
   'live',v_order.live,'carriedUsd',v_carry,'periodId',v_period));
 return jsonb_build_object('applied',true,'order',private.payments_order_json(v_order));
end $$;

-- ---------- 2) Pago rechazado, cancelado, vencido o devuelto (0017) ----------
-- Una devolución corta el saldo que dio esa orden. Si ya hubo otra compra, lo que quedaba pasó al período nuevo:
-- se le descuenta eso (nunca más que lo que dio la orden devuelta ni por debajo de lo ya gastado).
create or replace function public.payments_mark_status(p_order uuid, p_status text, p_provider_status text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_order public.payment_orders%rowtype; v_current uuid; v_carried numeric;
begin
 if p_status not in ('failed','cancelled','expired','refunded') then raise exception 'bad_status' using errcode='22023'; end if;
 select * into v_order from public.payment_orders where id=p_order for update;
 if not found then return jsonb_build_object('applied',false,'reason','order_not_found'); end if;
 if p_status='refunded' then
   if v_order.status<>'paid' then return jsonb_build_object('applied',false,'reason','not_paid'); end if;
   perform pg_advisory_xact_lock(hashtextextended(v_order.user_id::text,816));
   update public.ai_paid_periods set ends_at=greatest(now(), starts_at+interval '1 second')
    where id=v_order.period_id and (ends_at is null or ends_at>now());
   select s.support_period_id into v_current from public.ai_subscriptions s where s.user_id=v_order.user_id and s.source='support';
   if v_current is not null and v_current is distinct from v_order.period_id then
     select o.carried_usd into v_carried from public.payment_orders o
      where o.user_id=v_order.user_id and o.id<>v_order.id and o.status='paid' and o.paid_at>=v_order.paid_at order by o.paid_at limit 1;
     update public.ai_paid_periods set budget_usd=greatest(spent_usd, budget_usd-least(coalesce(v_carried,0), v_order.budget_usd))
      where id=v_current;
   end if;
   update public.payment_orders set status='refunded', provider_status=coalesce(left(p_provider_status,60),'refunded'),
     checked_at=now(), updated_at=now() where id=p_order returning * into v_order;
   perform public.admin_log(null,null,'payments.refunded',v_order.user_id,jsonb_build_object('orderId',v_order.id,
     'provider',v_order.provider,'amount',v_order.amount,'currency',v_order.currency,'carriedRemoved',coalesce(v_carried,0)));
 elsif v_order.status='pending' then
   update public.payment_orders set status=p_status, provider_status=coalesce(left(p_provider_status,60),p_status),
     checked_at=now(), updated_at=now() where id=p_order returning * into v_order;
 else
   return jsonb_build_object('applied',false,'reason','not_pending','order',private.payments_order_json(v_order));
 end if;
 return jsonb_build_object('applied',true,'order',private.payments_order_json(v_order));
end $$;

revoke all on function public.payments_mark_paid(uuid,text,numeric,text,boolean,text) from public, anon, authenticated;
revoke all on function public.payments_mark_status(uuid,text,text) from public, anon, authenticated;

-- ---------- 3) Permisos de más ----------
revoke insert, update, delete on public.profiles from anon;
revoke insert, delete on public.profiles from authenticated;
