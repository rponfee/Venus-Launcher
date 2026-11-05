-- 0047_voz_respaldo.sql · Venus 4.6 · Voice Chat: clave de respaldo de cada sala.
-- Guía: docs/wip/voz-respaldo-46.md. Se aplica después de 0014 (y de la 0038 si existe: usa private.voice_is_member,
-- que 0038 redefine con la misma firma). Idempotente. No redefine ninguna función de voz existente.
--
-- Si el servidor de Venus (Realtime y RPC) deja de responder, el launcher pasa a señalizar la llamada por brokers
-- MQTT públicos, todo cifrado y firmado (js/voice/seal.js). Los brokers son de cualquiera, así que el tema y la clave
-- de cifrado salen de un secreto de la sala que solo conocen sus miembros. Ese secreto vive acá:
--   * voice_room_secrets: un secreto de 24 símbolos (120 bits) por sala, creado la primera vez que un miembro lo pide.
--     Sin políticas ni permisos: solo lo tocan las funciones de abajo.
--   * voice_fallback_secret(p_room): lo devuelve a quien es miembro admitido de la sala (dueño o admitido y no
--     bloqueado; en salas de comunidad, con acceso al canal). Si el dueño cerró la sala, solo a quien está adentro ahora.
--     Hasta 60 pedidos cada 10 minutos por persona.
--   * Rotación: el secreto se borra (y el próximo pedido crea otro) cuando alguien es bloqueado en la sala, cuando el dueño
--     la cierra o cuando se cambia su contraseña. Así lo que un expulsado tenía guardado deja de servir.
-- Lo que el respaldo no puede verificar sin servidor (bloqueos nuevos, cupo de la sala, contraseña de quien nunca entró)
-- está explicado en el documento.

create table if not exists public.voice_room_secrets (
  room_id uuid primary key references public.voice_rooms (id) on delete cascade,
  secret text not null check (secret ~ '^[A-HJ-NP-Z2-9]{24}$'),
  created_at timestamptz not null default now()
);

alter table public.voice_room_secrets enable row level security;
revoke all on public.voice_room_secrets from anon, authenticated;

-- 24 símbolos al azar del mismo alfabeto que los códigos de sala (sin I, O, 0 ni 1): sirve también para compartirlo a mano
create or replace function private.voice_new_secret() returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  bytes bytea := extensions.gen_random_bytes(24);
  result text := '';
begin
  for i in 0..23 loop
    result := result || substr(alphabet, 1 + (get_byte(bytes, i) % 32), 1);
  end loop;
  return result;
end $$;

create or replace function public.voice_fallback_secret(p_room uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  r public.voice_rooms;
  m public.voice_members;
  v_secret text;
begin
  if me is null then
    return jsonb_build_object('error', 'auth');
  end if;
  if p_room is null then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if public.voice__throttled('fallback', 60, interval '10 minutes') then
    return jsonb_build_object('error', 'throttled');
  end if;
  perform public.voice__hit('fallback', interval '10 minutes');
  select * into r from public.voice_rooms x where x.id = p_room;
  if not found then
    return jsonb_build_object('error', 'gone');
  end if;
  if not private.voice_is_member(p_room) then
    return jsonb_build_object('error', 'not_member');
  end if;
  -- Sala cerrada: como en voice_join, solo el dueño o quien está en la sala ahora
  select * into m from public.voice_members x where x.room_id = p_room and x.user_id = me;
  if r.is_locked and r.owner <> me and not coalesce(m.last_seen > now() - interval '75 seconds', false) then
    return jsonb_build_object('error', 'locked');
  end if;
  insert into public.voice_room_secrets (room_id, secret) values (p_room, private.voice_new_secret())
    on conflict (room_id) do nothing;
  select s.secret into v_secret from public.voice_room_secrets s where s.room_id = p_room;
  return jsonb_build_object('secret', v_secret);
end $$;

-- ---------- Rotación ----------
create or replace function private.voice_secret_rotate_member() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.voice_room_secrets where room_id = new.room_id;
  return null;
end $$;

create or replace function private.voice_secret_rotate_room() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.voice_room_secrets where room_id = new.id;
  return null;
end $$;

-- Alguien bloqueado (por voice_kick con p_ban, que inserta o actualiza su fila)
drop trigger if exists voice_secret_ban_insert on public.voice_members;
create trigger voice_secret_ban_insert after insert on public.voice_members
  for each row when (new.banned) execute function private.voice_secret_rotate_member();
drop trigger if exists voice_secret_ban_update on public.voice_members;
create trigger voice_secret_ban_update after update of banned on public.voice_members
  for each row when (new.banned and not old.banned) execute function private.voice_secret_rotate_member();

-- Sala que se cierra o cambia de contraseña
drop trigger if exists voice_secret_room_change on public.voice_rooms;
create trigger voice_secret_room_change after update of is_locked, password_hash on public.voice_rooms
  for each row when ((new.is_locked and not old.is_locked) or new.password_hash is distinct from old.password_hash)
  execute function private.voice_secret_rotate_room();

-- ---------- Permisos ----------
revoke all on function private.voice_new_secret() from public, anon, authenticated;
revoke all on function private.voice_secret_rotate_member() from public, anon, authenticated;
revoke all on function private.voice_secret_rotate_room() from public, anon, authenticated;
revoke all on function public.voice_fallback_secret(uuid) from public, anon;
grant execute on function public.voice_fallback_secret(uuid) to authenticated;
