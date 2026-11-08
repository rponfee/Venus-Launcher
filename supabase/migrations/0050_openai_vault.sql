-- La clave de OpenAI se configura desde Administración > Integraciones.
-- Vault cifra el valor; el launcher solo recibe un estado y cuatro caracteres.
create or replace function public.admin_openai_status() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v text;
begin
  if not public.admin_is_admin_user(auth.uid()) then
    raise exception 'admin_only' using errcode = '42501';
  end if;
  select nullif(d.decrypted_secret, '') into v
    from vault.decrypted_secrets d where d.name = 'venus_openai_key';
  return jsonb_build_object('configured', v is not null,
    'hint', case when v is null then null else right(v, 4) end);
end $$;

create or replace function public.admin_set_openai_key(p_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); v_key text := btrim(coalesce(p_key, '')); v_id uuid;
begin
  if not public.admin_is_admin_user(me) then
    raise exception 'admin_only' using errcode = '42501';
  end if;
  if v_key <> '' and (length(v_key) not between 20 and 300 or v_key !~ '^sk-[A-Za-z0-9_-]+$') then
    raise exception 'bad_key' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(437050, 1);
  select id into v_id from vault.secrets where name = 'venus_openai_key';
  if v_key = '' then
    if v_id is not null then delete from vault.secrets where id = v_id; end if;
  elsif v_id is null then
    perform vault.create_secret(v_key, 'venus_openai_key', 'Venus IA: OpenAI');
  else
    perform vault.update_secret(v_id, v_key, 'venus_openai_key', 'Venus IA: OpenAI');
  end if;
  perform public.admin_log(me, (select email from auth.users where id = me),
    'openai.key', null, jsonb_build_object('configured', v_key <> ''));
  return jsonb_build_object('configured', v_key <> '',
    'hint', case when v_key = '' then null else right(v_key, 4) end);
end $$;

create or replace function public.ai_openai_key() returns text
language sql stable security definer set search_path = '' as $$
  select nullif(d.decrypted_secret, '') from vault.decrypted_secrets d
   where d.name = 'venus_openai_key' limit 1
$$;

revoke all on function public.admin_openai_status(),
  public.admin_set_openai_key(text), public.ai_openai_key()
  from public, anon, authenticated;
grant execute on function public.admin_openai_status(),
  public.admin_set_openai_key(text) to authenticated;
grant execute on function public.ai_openai_key() to service_role;
