-- Consultas automáticas breves de soporte, gratuitas y con límite por cuenta y global.
create table if not exists private.support_ai_rate (
  user_id uuid primary key references auth.users(id) on delete cascade,
  day date not null,
  requests integer not null check (requests between 1 and 10)
);
create table if not exists private.support_ai_global (
  day date primary key,
  requests integer not null check (requests between 1 and 2000)
);
alter table private.support_ai_rate enable row level security;
alter table private.support_ai_global enable row level security;
revoke all on private.support_ai_rate, private.support_ai_global from public, anon, authenticated;

create or replace function public.support_ai_access(p_user uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_count integer; v_today date := (now() at time zone 'UTC')::date;
begin
  if p_user is null or not exists (
    select 1 from auth.users where id = p_user and deleted_at is null
      and (banned_until is null or banned_until <= now()) and not coalesce(is_anonymous, false)
  ) then return false; end if;
  insert into private.support_ai_rate as r (user_id, day, requests)
  values (p_user, v_today, 1)
  on conflict (user_id) do update
    set day = v_today,
        requests = case when r.day = v_today then r.requests + 1 else 1 end
    where r.day <> v_today or r.requests < 10
  returning requests into v_count;
  if v_count is null then return false; end if;
  insert into private.support_ai_global as g (day, requests)
  values (v_today, 1)
  on conflict (day) do update set requests = g.requests + 1
    where g.requests < 2000
  returning requests into v_count;
  return v_count is not null;
end $$;

revoke all on function public.support_ai_access(uuid) from public, anon, authenticated;
grant execute on function public.support_ai_access(uuid) to service_role;
