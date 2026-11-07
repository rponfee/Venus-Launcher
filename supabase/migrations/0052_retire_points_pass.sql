-- Retira Venus Points, la tienda y el Pass sin borrar saldos, compras ni
-- historial: esos datos siguen disponibles para auditoría y soporte.
update public.shop_items set active = false;
update public.pass_seasons set active = false;
update public.achievements set points = 0;

revoke execute on function public.points_daily_claim(), public.points_me(),
  public.shop_buy(text), public.mission_claim(text),
  public.pass_me(), public.pass_playtime(integer),
  public.pass_claim(integer, text), public.pass_claim_all(),
  public.gift_send(uuid, text, text)
  from authenticated;
