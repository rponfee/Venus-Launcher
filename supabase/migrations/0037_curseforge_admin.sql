-- CurseForge configurado por el dueño desde Administración → Integraciones.
-- La clave queda en Vault: solo la Edge Function puede recuperarla. El cliente recibe estado o catálogo.
create table private.curseforge_rate (
  user_id uuid primary key references auth.users(id) on delete cascade,
  window_at timestamptz not null,
  requests integer not null check (requests between 1 and 240)
);
alter table private.curseforge_rate enable row level security;
revoke all on private.curseforge_rate from public, anon, authenticated;

create function public.admin_curseforge_status() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v text;
begin
  if not public.admin_is_admin_user(auth.uid()) then raise exception 'admin_only' using errcode = '42501'; end if;
  select nullif(d.decrypted_secret, '') into v from vault.decrypted_secrets d where d.name = 'venus_curseforge_key';
  return jsonb_build_object('configured', v is not null, 'hint', case when v is null then null else right(v, 4) end);
end $$;

create function public.admin_set_curseforge_key(p_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_key text := btrim(coalesce(p_key, ''));
  v_id uuid;
begin
  if not public.admin_is_admin_user(me) then raise exception 'admin_only' using errcode = '42501'; end if;
  if v_key <> '' and (length(v_key) not between 8 and 200 or v_key !~ '^[!-~]+$') then
    raise exception 'bad_key' using errcode = '22023';
  end if;
  -- Serializa reemplazos y eliminaciones, incluso cuando aún no hay fila en Vault.
  perform pg_advisory_xact_lock(437037, 1);
  select id into v_id from vault.secrets where name = 'venus_curseforge_key';
  if v_key = '' then
    if v_id is not null then delete from vault.secrets where id = v_id; end if;
  elsif v_id is null then
    perform vault.create_secret(v_key, 'venus_curseforge_key', 'Venus Launcher: CurseForge');
  else
    perform vault.update_secret(v_id, v_key, 'venus_curseforge_key', 'Venus Launcher: CurseForge');
  end if;
  perform public.admin_log(me, (select email from auth.users where id = me), 'curseforge.key', null,
    jsonb_build_object('configured', v_key <> ''));
  return jsonb_build_object('configured', v_key <> '', 'hint', case when v_key = '' then null else right(v_key, 4) end);
end $$;

create function public.curseforge_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('configured', exists (
    select 1 from vault.secrets where name = 'venus_curseforge_key'
  ))
$$;

-- Solo service_role. El usuario proviene de auth.getUser en la Edge Function, nunca del cuerpo del pedido.
-- Una fila por cuenta y 240 consultas/minuto, compartidas por todas las instancias de la función.
create function public.curseforge_proxy_access(p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_key text; v_count integer; v_now timestamptz := clock_timestamp();
begin
  if p_user is null or not exists (
    select 1 from auth.users where id = p_user and deleted_at is null
      and (banned_until is null or banned_until <= now()) and not coalesce(is_anonymous, false)
  ) or public.moderation_social_block(p_user) = 'user_banned' then
    return jsonb_build_object('error', 'forbidden');
  end if;
  select nullif(d.decrypted_secret, '') into v_key from vault.decrypted_secrets d where d.name = 'venus_curseforge_key';
  if v_key is null then return jsonb_build_object('error', 'not_configured'); end if;
  insert into private.curseforge_rate as r (user_id, window_at, requests)
  values (p_user, v_now, 1)
  on conflict (user_id) do update
    set window_at = case when r.window_at <= v_now - interval '1 minute' then v_now else r.window_at end,
        requests = case when r.window_at <= v_now - interval '1 minute' then 1 else r.requests + 1 end
    where r.window_at <= v_now - interval '1 minute' or r.requests < 240
  returning requests into v_count;
  if v_count is null then return jsonb_build_object('error', 'rate_limit'); end if;
  return jsonb_build_object('key', v_key);
end $$;

revoke all on function public.admin_curseforge_status(), public.admin_set_curseforge_key(text),
  public.curseforge_status(), public.curseforge_proxy_access(uuid) from public, anon, authenticated;
grant execute on function public.admin_curseforge_status(), public.admin_set_curseforge_key(text) to authenticated;
grant execute on function public.curseforge_status() to anon, authenticated;
grant execute on function public.curseforge_proxy_access(uuid) to service_role;
