-- Venus Launcher · 0003 · Voice Chat: salas de voz con codigo, miembros admitidos, moderacion y
-- autorizacion de los canales privados de Realtime "voice:<codigo>" (señalizacion WebRTC + presencia).
-- Requiere 0001_base.sql (profiles). Con 0002_social.sql aplicada, el lobby muestra las salas activas
-- de los amigos. Se puede volver a ejecutar sin romper nada.
--
-- Modelo de seguridad (RLS activado en todas las tablas):
--   * voice_rooms: la ve su dueño, los miembros admitidos y los amigos del dueño si la sala no es privada.
--     Solo el dueño la edita o la borra. Se crea unicamente con voice_create_room() (codigo y hash de la
--     contraseña del lado del servidor). Cualquiera que tenga el codigo puede ver los datos publicos con
--     voice_room_by_code(), nunca el hash de la contraseña (columna sin permiso de lectura).
--   * voice_members: admision a cada sala (entrar con la contraseña, ser invitado o ser el dueño), bloqueos
--     y la clave publica de la sesion actual. La ve cada uno (su fila) y el dueño de la sala. Se escribe
--     solo con las funciones voice_*; borrar la propia fila = olvidar la sala (salvo si esta bloqueado).
--   * voice_throttle: limites de intentos (codigos o contraseñas equivocados, invitaciones). Sin acceso directo.
--   * Realtime: solo el dueño y los miembros admitidos no bloqueados pueden escuchar y mandar en el canal
--     privado "voice:<codigo>" (broadcast y presence).

create extension if not exists pgcrypto with schema extensions;

-- =====================================================================
-- Tablas
-- =====================================================================
create table if not exists public.voice_rooms (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 40),
  code text not null unique check (code ~ '^[A-HJ-NP-Z2-9]{6}$'),
  is_private boolean not null default false,
  password_hash text,
  has_password boolean generated always as (password_hash is not null) stored,
  max_members smallint not null default 8 check (max_members between 2 and 8),
  is_locked boolean not null default false,
  created_at timestamptz not null default now(),
  last_active timestamptz not null default now()
);

create index if not exists voice_rooms_owner_idx on public.voice_rooms (owner, last_active desc);
create index if not exists voice_rooms_active_idx on public.voice_rooms (last_active desc) where not is_private;

create table if not exists public.voice_members (
  room_id uuid not null references public.voice_rooms (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  banned boolean not null default false,
  invited_by uuid references public.profiles (id) on delete set null,
  invited_at timestamptz,
  session_id text check (session_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  session_key text check (char_length(session_key) <= 400), -- clave publica ECDSA (JWK) de la sesion actual
  joined_at timestamptz not null default now(),
  last_seen timestamptz,                                     -- latido cada 30 s mientras esta en la sala
  primary key (room_id, user_id)
);

create index if not exists voice_members_user_idx on public.voice_members (user_id);
create index if not exists voice_members_seen_idx on public.voice_members (room_id, last_seen);

create table if not exists public.voice_throttle (
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null,
  window_start timestamptz not null default now(),
  hits int not null default 0,
  primary key (user_id, kind)
);

alter table public.voice_rooms enable row level security;
alter table public.voice_members enable row level security;
alter table public.voice_throttle enable row level security;

-- =====================================================================
-- Funciones auxiliares (security definer: no dependen de las politicas, asi no hay recursion)
-- =====================================================================

-- Amigos aceptados de quien llama (tabla friendships de 0002). null si el modulo social no esta instalado.
create or replace function public.voice_friend_array() returns uuid[]
language plpgsql stable security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  ids uuid[];
begin
  if me is null or to_regclass('public.friendships') is null then
    return null;
  end if;
  execute $q$
    select coalesce(array_agg(case when f.requester = $1 then f.addressee else f.requester end), '{}'::uuid[])
      from public.friendships f
     where f.status = 'accepted' and (f.requester = $1 or f.addressee = $1)
  $q$ into ids using me;
  return ids;
end $$;

create or replace function public.voice_is_owner(p_room uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.voice_rooms r where r.id = p_room and r.owner = (select auth.uid()));
$$;

-- Dueño o miembro admitido (no bloqueado)
create or replace function public.voice_is_member(p_room uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.voice_is_owner(p_room)
      or exists (select 1 from public.voice_members m
                  where m.room_id = p_room and m.user_id = (select auth.uid()) and not m.banned);
$$;

-- Autorizacion de Realtime: "voice:<codigo>" solo para el dueño y los miembros admitidos
create or replace function public.voice_can_use_topic(p_topic text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(p_topic, '') like 'voice:%'
     and exists (
       select 1 from public.voice_rooms r
        where r.code = substr(p_topic, 7)
          and (r.owner = (select auth.uid())
               or exists (select 1 from public.voice_members m
                           where m.room_id = r.id and m.user_id = (select auth.uid()) and not m.banned)));
$$;

-- Limite de intentos por usuario y tipo
create or replace function public.voice__throttled(p_kind text, p_limit int, p_window interval) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.voice_throttle t
                  where t.user_id = (select auth.uid()) and t.kind = p_kind
                    and t.window_start > now() - p_window and t.hits >= p_limit);
$$;

create or replace function public.voice__hit(p_kind text, p_window interval) returns void
language sql security definer set search_path = public as $$
  insert into public.voice_throttle as t (user_id, kind, window_start, hits)
  values ((select auth.uid()), p_kind, now(), 1)
  on conflict (user_id, kind) do update set
    hits = case when t.window_start <= now() - p_window then 1 else t.hits + 1 end,
    window_start = case when t.window_start <= now() - p_window then now() else t.window_start end;
$$;

-- Sala en JSON para la interfaz (nunca incluye el hash de la contraseña).
-- p_people: incluir quienes estan ahora (solo para miembros o amigos que pueden ver la sala).
create or replace function public.voice__room_json(r public.voice_rooms, p_people boolean) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', r.id,
    'code', r.code,
    'name', r.name,
    'owner', r.owner,
    'owner_name', (select coalesce(nullif(btrim(p.display_name), ''), p.username) from public.profiles p where p.id = r.owner),
    'owner_avatar', (select coalesce(p.mc_uuid, p.mc_name, p.username) from public.profiles p where p.id = r.owner),
    'is_owner', r.owner = (select auth.uid()),
    'is_private', r.is_private,
    'has_password', r.password_hash is not null,
    'max_members', r.max_members,
    'is_locked', r.is_locked,
    'created_at', r.created_at,
    'last_active', r.last_active,
    'active', (select count(*) from public.voice_members m
                where m.room_id = r.id and not m.banned and m.last_seen > now() - interval '75 seconds'),
    'people', case when p_people then coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', m.user_id,
                 'name', coalesce(nullif(btrim(p.display_name), ''), p.username),
                 'avatar', coalesce(p.mc_uuid, p.mc_name, p.username)) order by m.joined_at)
          from public.voice_members m
          join public.profiles p on p.id = m.user_id
         where m.room_id = r.id and not m.banned and m.last_seen > now() - interval '75 seconds'), '[]'::jsonb)
      else '[]'::jsonb end
  );
$$;

-- =====================================================================
-- Politicas
-- =====================================================================
drop policy if exists "voice_rooms_select" on public.voice_rooms;
create policy "voice_rooms_select" on public.voice_rooms
  for select to authenticated
  using (
    owner = (select auth.uid())
    or public.voice_is_member(id)
    or (not is_private and owner = any (coalesce((select public.voice_friend_array()), '{}'::uuid[])))
  );

drop policy if exists "voice_rooms_update_owner" on public.voice_rooms;
create policy "voice_rooms_update_owner" on public.voice_rooms
  for update to authenticated
  using (owner = (select auth.uid()))
  with check (owner = (select auth.uid()));

drop policy if exists "voice_rooms_delete_owner" on public.voice_rooms;
create policy "voice_rooms_delete_owner" on public.voice_rooms
  for delete to authenticated
  using (owner = (select auth.uid()));

-- Sin politica de insert: las salas se crean con voice_create_room().

drop policy if exists "voice_members_select" on public.voice_members;
create policy "voice_members_select" on public.voice_members
  for select to authenticated
  using (user_id = (select auth.uid()) or public.voice_is_owner(room_id));

-- Olvidar una sala (la propia fila, si no esta bloqueado) o, siendo el dueño, desbloquear o quitar a alguien
drop policy if exists "voice_members_delete" on public.voice_members;
create policy "voice_members_delete" on public.voice_members
  for delete to authenticated
  using ((user_id = (select auth.uid()) and not banned) or public.voice_is_owner(room_id));

-- Permisos de columnas: el hash de la contraseña y las claves de sesion no se leen directo
revoke all on public.voice_rooms from anon, authenticated;
grant select (id, owner, name, code, is_private, has_password, max_members, is_locked, created_at, last_active)
  on public.voice_rooms to authenticated;
grant update (name, is_private, max_members, is_locked) on public.voice_rooms to authenticated;
grant delete on public.voice_rooms to authenticated;

revoke all on public.voice_members from anon, authenticated;
grant select (room_id, user_id, banned, invited_by, invited_at, joined_at, last_seen) on public.voice_members to authenticated;
grant delete on public.voice_members to authenticated;

revoke all on public.voice_throttle from anon, authenticated;

-- =====================================================================
-- Funciones para la interfaz (todas devuelven { error: '<codigo>' } en los casos esperables)
-- =====================================================================

-- Crea una sala con un codigo unico de 6 caracteres (sin I, O, 0 ni 1) y la deja admitida para el dueño.
create or replace function public.voice_create_room(p_name text, p_private boolean default false, p_password text default null, p_max_members int default 8)
returns jsonb
language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  me uuid := auth.uid();
  v_name text := btrim(coalesce(p_name, ''));
  v_code text;
  v_bytes bytea;
  v_room public.voice_rooms;
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
begin
  if me is null then
    return jsonb_build_object('error', 'auth');
  end if;
  if char_length(v_name) not between 1 and 40 then
    return jsonb_build_object('error', 'bad_name');
  end if;
  if coalesce(p_password, '') <> '' and char_length(p_password) not between 4 and 64 then
    return jsonb_build_object('error', 'bad_password_format');
  end if;
  if (select count(*) from public.voice_rooms r where r.owner = me) >= 12 then
    return jsonb_build_object('error', 'too_many_rooms');
  end if;
  loop
    v_bytes := gen_random_bytes(6);
    v_code := '';
    for i in 0..5 loop
      v_code := v_code || substr(alphabet, 1 + (get_byte(v_bytes, i) % 32), 1);
    end loop;
    exit when not exists (select 1 from public.voice_rooms r where r.code = v_code);
  end loop;
  insert into public.voice_rooms (owner, name, code, is_private, password_hash, max_members)
  values (me, v_name, v_code, coalesce(p_private, false),
          case when coalesce(p_password, '') = '' then null else crypt(p_password, gen_salt('bf', 8)) end,
          greatest(2, least(8, coalesce(p_max_members, 8))))
  returning * into v_room;
  insert into public.voice_members (room_id, user_id) values (v_room.id, me) on conflict do nothing;
  return jsonb_build_object('room', public.voice__room_json(v_room, true));
end $$;

-- Datos publicos de una sala para quien tiene el codigo (antes de entrar: nombre, si pide contraseña...).
create or replace function public.voice_room_by_code(p_code text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  v_room public.voice_rooms;
  v_member public.voice_members;
  v_admitted boolean;
begin
  if me is null then
    return jsonb_build_object('error', 'auth');
  end if;
  if public.voice__throttled('lookup', 40, interval '10 minutes') then
    return jsonb_build_object('error', 'throttled');
  end if;
  select * into v_room from public.voice_rooms r where r.code = v_code;
  if not found then
    perform public.voice__hit('lookup', interval '10 minutes');
    return jsonb_build_object('error', 'not_found');
  end if;
  select * into v_member from public.voice_members m where m.room_id = v_room.id and m.user_id = me;
  v_admitted := v_room.owner = me or (v_member.user_id is not null and not v_member.banned);
  return jsonb_build_object('room', public.voice__room_json(v_room, v_admitted)
    || jsonb_build_object('admitted', v_admitted, 'banned', coalesce(v_member.banned, false)));
end $$;

-- Entrar a una sala: controla bloqueo, cupo, sala cerrada y contraseña; guarda la clave publica de la sesion.
create or replace function public.voice_join(p_code text, p_password text default null, p_session text default null, p_key text default null)
returns jsonb
language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  me uuid := auth.uid();
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  v_room public.voice_rooms;
  v_member public.voice_members;
  v_has_member boolean;
  v_present boolean;
  v_invited boolean;
  v_active int;
begin
  if me is null then
    return jsonb_build_object('error', 'auth');
  end if;
  if p_session is null or p_session !~ '^[A-Za-z0-9_-]{8,64}$' or p_key is null or char_length(p_key) > 400 then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if public.voice__throttled('join', 12, interval '10 minutes') then
    return jsonb_build_object('error', 'throttled');
  end if;
  select * into v_room from public.voice_rooms r where r.code = v_code;
  if not found then
    perform public.voice__hit('join', interval '10 minutes');
    return jsonb_build_object('error', 'not_found');
  end if;
  select * into v_member from public.voice_members m where m.room_id = v_room.id and m.user_id = me;
  v_has_member := v_member.user_id is not null;
  if v_has_member and v_member.banned then
    return jsonb_build_object('error', 'banned');
  end if;
  v_present := v_has_member and coalesce(v_member.last_seen > now() - interval '75 seconds', false);
  v_invited := v_has_member and coalesce(v_member.invited_at > now() - interval '30 minutes', false);
  if v_room.owner <> me then
    if v_room.is_locked and not v_present and not v_invited then
      return jsonb_build_object('error', 'locked');
    end if;
    select count(*) into v_active from public.voice_members m
     where m.room_id = v_room.id and m.user_id <> me and not m.banned and m.last_seen > now() - interval '75 seconds';
    if v_active >= v_room.max_members then
      return jsonb_build_object('error', 'full', 'max', v_room.max_members);
    end if;
    if v_room.password_hash is not null and not v_has_member then
      if coalesce(p_password, '') = '' then
        return jsonb_build_object('error', 'password_required');
      end if;
      if crypt(p_password, v_room.password_hash) <> v_room.password_hash then
        perform public.voice__hit('join', interval '10 minutes');
        return jsonb_build_object('error', 'bad_password');
      end if;
    end if;
  end if;
  insert into public.voice_members as m (room_id, user_id, session_id, session_key, joined_at, last_seen)
  values (v_room.id, me, p_session, p_key, now(), now())
  on conflict (room_id, user_id) do update
    set session_id = excluded.session_id, session_key = excluded.session_key,
        joined_at = now(), last_seen = now(), invited_at = null;
  update public.voice_rooms r set last_active = now() where r.id = v_room.id returning * into v_room;
  return jsonb_build_object('room', public.voice__room_json(v_room, true));
end $$;

-- Latido mientras se esta en la sala (cada 30 s). Avisa si a uno lo sacaron, lo bloquearon, la sala ya no
-- existe o entro desde otro lado.
create or replace function public.voice_heartbeat(p_room uuid, p_session text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  v_room public.voice_rooms;
  v_member public.voice_members;
begin
  if me is null then
    return jsonb_build_object('error', 'auth');
  end if;
  select * into v_room from public.voice_rooms r where r.id = p_room;
  if not found then
    return jsonb_build_object('error', 'gone');
  end if;
  select * into v_member from public.voice_members m where m.room_id = p_room and m.user_id = me;
  if not found then
    return jsonb_build_object('error', 'kicked');
  end if;
  if v_member.banned then
    return jsonb_build_object('error', 'banned');
  end if;
  if v_member.session_id is distinct from p_session then
    return jsonb_build_object('error', 'replaced');
  end if;
  update public.voice_members m set last_seen = now() where m.room_id = p_room and m.user_id = me;
  update public.voice_rooms r set last_active = now() where r.id = p_room returning * into v_room;
  return jsonb_build_object('room', public.voice__room_json(v_room, true));
end $$;

create or replace function public.voice_leave(p_room uuid, p_session text) returns void
language sql volatile security definer set search_path = public as $$
  update public.voice_members m set last_seen = null
   where m.room_id = p_room and m.user_id = (select auth.uid()) and m.session_id is not distinct from p_session;
$$;

-- Claves publicas de las sesiones activas (para verificar señales, chat y ordenes del anfitrion) + nombres.
create or replace function public.voice_member_keys(p_room uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.voice_is_member(p_room) then
    return jsonb_build_object('error', 'not_member');
  end if;
  return jsonb_build_object('members', coalesce((
    select jsonb_agg(jsonb_build_object(
             'user_id', m.user_id,
             'session', m.session_id,
             'key', m.session_key,
             'name', coalesce(nullif(btrim(p.display_name), ''), p.username),
             'avatar', coalesce(p.mc_uuid, p.mc_name, p.username),
             'joined_at', m.joined_at))
      from public.voice_members m
      join public.profiles p on p.id = m.user_id
     where m.room_id = p_room and not m.banned and m.session_key is not null
       and m.last_seen > now() - interval '10 minutes'), '[]'::jsonb));
end $$;

-- Invitar a alguien: queda admitido (no necesita la contraseña) y durante 30 minutos puede entrar aunque
-- el dueño haya cerrado la sala. Solo puede invitar el dueño o alguien que esta en la sala ahora.
create or replace function public.voice_invite(p_room uuid, p_user uuid) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  v_room public.voice_rooms;
begin
  if me is null then
    return jsonb_build_object('error', 'auth');
  end if;
  if p_user is null or p_user = me or not exists (select 1 from public.profiles p where p.id = p_user) then
    return jsonb_build_object('error', 'bad_request');
  end if;
  select * into v_room from public.voice_rooms r where r.id = p_room;
  if not found then
    return jsonb_build_object('error', 'gone');
  end if;
  if v_room.owner <> me and not exists (
      select 1 from public.voice_members m
       where m.room_id = p_room and m.user_id = me and not m.banned and m.last_seen > now() - interval '75 seconds') then
    return jsonb_build_object('error', 'not_member');
  end if;
  if v_room.is_locked and v_room.owner <> me then
    return jsonb_build_object('error', 'locked');
  end if;
  if public.voice__throttled('invite', 40, interval '10 minutes') then
    return jsonb_build_object('error', 'throttled');
  end if;
  perform public.voice__hit('invite', interval '10 minutes');
  if exists (select 1 from public.voice_members m where m.room_id = p_room and m.user_id = p_user and m.banned) then
    return jsonb_build_object('error', 'banned');
  end if;
  insert into public.voice_members (room_id, user_id, invited_by, invited_at)
  values (p_room, p_user, me, now())
  on conflict (room_id, user_id) do update set invited_by = excluded.invited_by, invited_at = excluded.invited_at;
  return jsonb_build_object('ok', true);
end $$;

-- Sacar (y opcionalmente bloquear) a alguien. Solo el dueño.
create or replace function public.voice_kick(p_room uuid, p_user uuid, p_ban boolean default false) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    return jsonb_build_object('error', 'auth');
  end if;
  if not exists (select 1 from public.voice_rooms r where r.id = p_room and r.owner = me) then
    return jsonb_build_object('error', 'not_owner');
  end if;
  if p_user is null or p_user = me then
    return jsonb_build_object('error', 'bad_request');
  end if;
  if coalesce(p_ban, false) then
    insert into public.voice_members (room_id, user_id, banned)
    values (p_room, p_user, true)
    on conflict (room_id, user_id) do update
      set banned = true, last_seen = null, session_id = null, session_key = null, invited_at = null;
  else
    delete from public.voice_members m where m.room_id = p_room and m.user_id = p_user and not m.banned;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- Cambiar o quitar la contraseña (solo el dueño). Una contraseña nueva vale para todos los que no estan
-- en la sala en este momento: se les quita la admision anterior.
create or replace function public.voice_set_password(p_room uuid, p_password text) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  me uuid := auth.uid();
  v_room public.voice_rooms;
begin
  if me is null then
    return jsonb_build_object('error', 'auth');
  end if;
  if coalesce(p_password, '') <> '' and char_length(p_password) not between 4 and 64 then
    return jsonb_build_object('error', 'bad_password_format');
  end if;
  update public.voice_rooms r
     set password_hash = case when coalesce(p_password, '') = '' then null else crypt(p_password, gen_salt('bf', 8)) end
   where r.id = p_room and r.owner = me
  returning * into v_room;
  if not found then
    return jsonb_build_object('error', 'not_owner');
  end if;
  if coalesce(p_password, '') <> '' then
    delete from public.voice_members m
     where m.room_id = p_room and m.user_id <> me and not m.banned
       and (m.last_seen is null or m.last_seen <= now() - interval '75 seconds');
  end if;
  return jsonb_build_object('room', public.voice__room_json(v_room, true));
end $$;

-- Lobby: mis salas, salas recientes (donde fui admitido) y salas visibles de mis amigos con gente adentro.
create or replace function public.voice_list_rooms() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  v_friends uuid[];
begin
  if me is null then
    return jsonb_build_object('error', 'auth');
  end if;
  v_friends := public.voice_friend_array();
  return jsonb_build_object(
    'mine', coalesce((
      select jsonb_agg(x.j order by x.la desc) from (
        select public.voice__room_json(r, true) as j, r.last_active as la
          from public.voice_rooms r
         where r.owner = me
         order by r.last_active desc
         limit 12) x), '[]'::jsonb),
    'recent', coalesce((
      select jsonb_agg(x.j order by x.la desc) from (
        select public.voice__room_json(r, true) as j, r.last_active as la
          from public.voice_rooms r
         where r.owner <> me
           and exists (select 1 from public.voice_members m where m.room_id = r.id and m.user_id = me and not m.banned)
         order by r.last_active desc
         limit 20) x), '[]'::jsonb),
    'friends', coalesce((
      select jsonb_agg(x.j order by x.la desc) from (
        select public.voice__room_json(r, true) as j, r.last_active as la
          from public.voice_rooms r
         where not r.is_private
           and r.owner <> me
           and r.last_active > now() - interval '3 minutes'
           and exists (select 1 from public.voice_members a
                        where a.room_id = r.id and not a.banned and a.last_seen > now() - interval '75 seconds')
           and (r.owner = any (coalesce(v_friends, '{}'::uuid[]))
                or exists (select 1 from public.voice_members f
                            where f.room_id = r.id and not f.banned and f.last_seen > now() - interval '75 seconds'
                              and f.user_id = any (coalesce(v_friends, '{}'::uuid[]))))
           and not exists (select 1 from public.voice_members b where b.room_id = r.id and b.user_id = me and b.banned)
         order by r.last_active desc
         limit 30) x), '[]'::jsonb),
    'friends_supported', v_friends is not null
  );
end $$;

-- =====================================================================
-- Permisos de las funciones (nunca para anon)
-- =====================================================================
revoke all on function public.voice_friend_array() from public, anon;
revoke all on function public.voice_is_owner(uuid) from public, anon;
revoke all on function public.voice_is_member(uuid) from public, anon;
revoke all on function public.voice_can_use_topic(text) from public, anon;
revoke all on function public.voice__throttled(text, int, interval) from public, anon, authenticated;
revoke all on function public.voice__hit(text, interval) from public, anon, authenticated;
revoke all on function public.voice__room_json(public.voice_rooms, boolean) from public, anon, authenticated;
revoke all on function public.voice_create_room(text, boolean, text, int) from public, anon;
revoke all on function public.voice_room_by_code(text) from public, anon;
revoke all on function public.voice_join(text, text, text, text) from public, anon;
revoke all on function public.voice_heartbeat(uuid, text) from public, anon;
revoke all on function public.voice_leave(uuid, text) from public, anon;
revoke all on function public.voice_member_keys(uuid) from public, anon;
revoke all on function public.voice_invite(uuid, uuid) from public, anon;
revoke all on function public.voice_kick(uuid, uuid, boolean) from public, anon;
revoke all on function public.voice_set_password(uuid, text) from public, anon;
revoke all on function public.voice_list_rooms() from public, anon;

-- Las de las politicas tambien las evalua el rol authenticated
grant execute on function public.voice_friend_array() to authenticated;
grant execute on function public.voice_is_owner(uuid) to authenticated;
grant execute on function public.voice_is_member(uuid) to authenticated;
grant execute on function public.voice_can_use_topic(text) to authenticated;
grant execute on function public.voice_create_room(text, boolean, text, int) to authenticated;
grant execute on function public.voice_room_by_code(text) to authenticated;
grant execute on function public.voice_join(text, text, text, text) to authenticated;
grant execute on function public.voice_heartbeat(uuid, text) to authenticated;
grant execute on function public.voice_leave(uuid, text) to authenticated;
grant execute on function public.voice_member_keys(uuid) to authenticated;
grant execute on function public.voice_invite(uuid, uuid) to authenticated;
grant execute on function public.voice_kick(uuid, uuid, boolean) to authenticated;
grant execute on function public.voice_set_password(uuid, text) to authenticated;
grant execute on function public.voice_list_rooms() to authenticated;

-- =====================================================================
-- Realtime: canal privado "voice:<codigo>" (señalizacion WebRTC, chat, soundboard, moderacion y presencia)
-- =====================================================================
do $$
begin
  if to_regclass('realtime.messages') is not null then
    execute 'drop policy if exists "voice_room_receive" on realtime.messages';
    execute $policy$
      create policy "voice_room_receive" on realtime.messages
        for select to authenticated
        using (
          realtime.messages.extension in ('broadcast', 'presence')
          and (select realtime.topic()) like 'voice:%'
          and (select public.voice_can_use_topic((select realtime.topic())))
        )
    $policy$;
    execute 'drop policy if exists "voice_room_send" on realtime.messages';
    execute $policy$
      create policy "voice_room_send" on realtime.messages
        for insert to authenticated
        with check (
          realtime.messages.extension in ('broadcast', 'presence')
          and (select realtime.topic()) like 'voice:%'
          and (select public.voice_can_use_topic((select realtime.topic())))
        )
    $policy$;
  end if;
end $$;
