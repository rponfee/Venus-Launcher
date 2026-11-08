-- Retira Venus Points, la tienda y el Pass cuando la nueva versión reemplace 4.6.2.
-- Conserva saldos, compras, historial y los valores anteriores de catálogo para auditoría.
create table if not exists private.points_pass_retire_snapshot (
  source_table text not null check (source_table in ('shop_items','pass_seasons','achievements')),
  row_id text not null,
  was_active boolean,
  previous_points integer,
  captured_at timestamptz not null default now(),
  primary key (source_table, row_id)
);
alter table private.points_pass_retire_snapshot enable row level security;
revoke all on private.points_pass_retire_snapshot from public, anon, authenticated;

insert into private.points_pass_retire_snapshot (source_table, row_id, was_active)
select 'shop_items', id, active from public.shop_items
on conflict (source_table, row_id) do nothing;
insert into private.points_pass_retire_snapshot (source_table, row_id, was_active)
select 'pass_seasons', id, active from public.pass_seasons
on conflict (source_table, row_id) do nothing;
insert into private.points_pass_retire_snapshot (source_table, row_id, was_active, previous_points)
select 'achievements', id, active, points from public.achievements
on conflict (source_table, row_id) do nothing;

update public.shop_items set active = false where active;
update public.pass_seasons set active = false where active;
update public.achievements set points = 0 where points <> 0;

revoke execute on function public.points_daily_claim(), public.points_me(),
  public.shop_buy(text), public.mission_claim(text),
  public.pass_me(), public.pass_playtime(integer),
  public.pass_claim(integer, text), public.pass_claim_all(),
  public.gift_send(uuid, text, text)
  from authenticated;
