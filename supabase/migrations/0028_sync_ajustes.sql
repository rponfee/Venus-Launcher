-- 0028_sync_ajustes.sql · Venus 3.2 · Sincronizar ajustes y temas entre PCs.
-- Guía: docs/wip/datos-32.md. Se aplica después de 0027. Idempotente.
--
--   * settings_sync: una fila por usuario con el JSON de los ajustes que viajan y una versión que sube con cada guardado.
--     El launcher manda solo su lista blanca (apariencia, looks, decoración, menú, inicio, sonidos), con la fecha de cada
--     clave para fusionar del lado del cliente: el servidor no interpreta el contenido, solo lo guarda.
--   * settings_sync_get(): lo que hay en la nube.
--   * settings_sync_save(p_data, p_version): guarda solo si la versión que tiene la PC sigue siendo la de la nube; si otra
--     PC guardó antes, devuelve conflict con lo que hay, para fusionar y volver a guardar. Hasta 64 KB.
--   * settings_sync_delete(): borra la copia de la nube (el interruptor se apaga y el usuario no quiere dejar nada).
-- Errores (22023): bad_data, too_big; not_authenticated (42501).

create table if not exists public.settings_sync (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null,
  version bigint not null default 1 check (version > 0),
  updated_at timestamptz not null default now(),
  constraint settings_sync_size check (octet_length(data::text) <= 65536),
  constraint settings_sync_object check (jsonb_typeof(data) = 'object')
);
alter table public.settings_sync enable row level security;
-- Todo pasa por las funciones de abajo: nadie lee ni escribe la tabla directo
revoke all on public.settings_sync from anon, authenticated;

-- { data, version, updatedAt } o { data: null, version: 0 } si todavía no se subió nada
create or replace function public.settings_sync_get() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v public.settings_sync;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  select * into v from public.settings_sync s where s.user_id = me;
  if not found then return jsonb_build_object('data', null, 'version', 0, 'updatedAt', null); end if;
  return jsonb_build_object('data', v.data, 'version', v.version, 'updatedAt', v.updated_at);
end $$;

-- p_version: la versión que leyó esta PC (0 si no había nada). Devuelve { ok: true, version } o
-- { ok: false, conflict: true, data, version } si en la nube ya hay otra.
create or replace function public.settings_sync_save(p_data jsonb, p_version bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_version bigint;
  v_current public.settings_sync;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' then raise exception 'bad_data' using errcode = '22023'; end if;
  if p_version is null or p_version < 0 then raise exception 'bad_data' using errcode = '22023'; end if;
  if octet_length(p_data::text) > 65536 then raise exception 'too_big' using errcode = '22023'; end if;
  if p_version = 0 then
    insert into public.settings_sync (user_id, data, version) values (me, p_data, 1)
    on conflict (user_id) do nothing
    returning version into v_version;
  else
    update public.settings_sync s set data = p_data, version = s.version + 1, updated_at = now()
     where s.user_id = me and s.version = p_version
    returning s.version into v_version;
  end if;
  if v_version is not null then return jsonb_build_object('ok', true, 'version', v_version); end if;
  select * into v_current from public.settings_sync s where s.user_id = me;
  return jsonb_build_object('ok', false, 'conflict', true, 'data', v_current.data, 'version', coalesce(v_current.version, 0));
end $$;

create or replace function public.settings_sync_delete() returns boolean
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  delete from public.settings_sync s where s.user_id = me;
  return found;
end $$;

-- ---------- Permisos ----------
revoke all on function public.settings_sync_get() from public, anon;
revoke all on function public.settings_sync_save(jsonb, bigint) from public, anon;
revoke all on function public.settings_sync_delete() from public, anon;
grant execute on function public.settings_sync_get() to authenticated;
grant execute on function public.settings_sync_save(jsonb, bigint) to authenticated;
grant execute on function public.settings_sync_delete() to authenticated;
