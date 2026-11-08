-- 0054: add a short burst limit to the low-reasoning support assistant.
-- Existing limits remain 10 requests/user/day and 2000 requests/day globally.
alter table private.support_ai_rate
  add column if not exists window_start timestamptz not null default now();
alter table private.support_ai_rate
  add column if not exists window_requests integer not null default 0;
alter table private.support_ai_rate
  add constraint support_ai_rate_window_requests_check
  check (window_requests between 0 and 3);

create or replace function public.support_ai_access(p_user uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_count integer;
  v_today date := (now() at time zone 'UTC')::date;
begin
  if p_user is null or not exists (
    select 1 from auth.users where id = p_user and deleted_at is null
      and (banned_until is null or banned_until <= now())
      and not coalesce(is_anonymous, false)
  ) then
    return false;
  end if;

  -- The upsert locks this user's row and atomically enforces both limits.
  insert into private.support_ai_rate as r
    (user_id, day, requests, window_start, window_requests)
  values (p_user, v_today, 1, now(), 1)
  on conflict (user_id) do update
    set day = v_today,
        requests = case when r.day = v_today then r.requests + 1 else 1 end,
        window_start = case
          when r.window_start > now() - interval '1 minute' then r.window_start
          else now() end,
        window_requests = case
          when r.window_start > now() - interval '1 minute' then r.window_requests + 1
          else 1 end
    where (r.day <> v_today or r.requests < 10)
      and (r.window_start <= now() - interval '1 minute' or r.window_requests < 3)
  returning requests into v_count;
  if v_count is null then return false; end if;

  insert into private.support_ai_global as g (day, requests)
  values (v_today, 1)
  on conflict (day) do update
    set requests = g.requests + 1
    where g.requests < 2000
  returning requests into v_count;
  return v_count is not null;
end
$function$;

revoke execute on function public.support_ai_access(uuid)
  from public, anon, authenticated;
grant execute on function public.support_ai_access(uuid) to service_role;
