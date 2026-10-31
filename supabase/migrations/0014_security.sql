-- Venus Launcher · 0014 · Seguridad de la base: cuotas de Storage en cada escritura, admins cargados a mano,
-- Voice Chat solo para quien está en la sala, topes de filas, ediciones y señales con los mismos límites que
-- escribir, y las funciones auxiliares de las políticas fuera de la API (esquema private).
-- Se aplica DESPUÉS de todas las anteriores (necesita 0001 a 0005 y 0012). Guía: docs/supabase.md y docs/admin.md.
-- Idempotente: se puede volver a aplicar, siempre después de las anteriores. Nunca reapliques sola una migración
-- vieja (0002 a 0005 o 0012): volvería a dejar las versiones que esta reemplaza.
--
-- Qué cambia:
--   * Storage: las cuotas (2 GB en world-saves; 500 capturas y 100 clips) las controla un trigger en CADA escritura
--     de storage.objects, también la que hace Storage como service role al subir con una URL firmada, y de a una
--     por usuario (las subidas en paralelo no pasan juntas). Los archivos de screenshots y clips no se pueden mover.
--   * Admins: app_admins ya no se llena solo por el email (con "Confirm email" apagado, quien registrara primero un
--     email de la lista quedaba admin). Se carga a mano después de verificar la cuenta (docs/admin.md).
--   * Voice Chat: el canal "voice:<código>" es solo del dueño y de quien está en la sala ahora; salir borra la
--     sesión; con la sala cerrada, un latido no revive una sesión vieja; se invita solo a amigos, y para quien el
--     dueño bloqueó en social sus salas no existen.
--   * Social: editar un mensaje exige seguir siendo amigos (como escribir uno nuevo); las señales tienen un límite
--     de 120 por minuto.
--   * Topes por usuario: 1000 filas en cloud_saves y 600 en shared_media.
--   * Las funciones que usan las políticas pasan al esquema private (fuera de /rest/v1/rpc) y venus_friend_code deja
--     de poder llamarse por la API.

-- ---------- Esquema private ----------
-- La API (PostgREST) solo publica public: lo que vive acá no se puede llamar por /rest/v1/rpc. authenticated
-- necesita usarlo igual, porque las políticas evalúan estas funciones con sus permisos.
create schema if not exists private;
comment on schema private is 'Funciones internas de Venus (las usan políticas y triggers). Fuera de la API.';
grant usage on schema private to authenticated, service_role;

-- ---------- Social: auxiliares de las políticas (antes en public: 0002 y 0012) ----------

-- true si a y b son amigos aceptados. Solo responde por parejas que incluyen a quien pregunta.
create or replace function private.are_friends(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select a is not null and b is not null and a <> b
     and (select auth.uid()) in (a, b)
     and exists (
       select 1 from public.friendships f
        where f.status = 'accepted'
          and least(f.requester, f.addressee) = least(a, b)
          and greatest(f.requester, f.addressee) = greatest(a, b));
$$;

-- true si quien pregunta es miembro de la conversación.
create or replace function private.social_is_member(conv uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.conversations c
     where c.id = conv and (select auth.uid()) in (c.user_lo, c.user_hi));
$$;

-- Moderación de quien llama (lo usa el trigger de mensajes, que corre con los permisos del usuario).
create or replace function private.moderation_self_block() returns text
language sql stable security definer set search_path = '' as $$
  select public.moderation_social_block(auth.uid())
$$;

-- true si quien pregunta es miembro y sigue siendo amigo del otro (puede escribir). Con la cuenta silenciada
-- o baneada corta con el error 'user_muted' / 'user_banned' (mensajes y reacciones).
create or replace function private.social_can_send(conv uuid) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  v_block text := public.moderation_social_block((select auth.uid()));
begin
  if v_block is not null then
    raise exception '%', v_block using errcode = 'P0001';
  end if;
  return exists (
    select 1 from public.conversations c
     where c.id = conv
       and (select auth.uid()) in (c.user_lo, c.user_hi)
       and private.are_friends(c.user_lo, c.user_hi));
end $$;

-- ---------- Voice Chat: auxiliares de las políticas (antes en public: 0003) ----------

-- Amigos aceptados de quien llama (tabla friendships de 0002). null si el módulo social no está instalado.
create or replace function private.voice_friend_array() returns uuid[]
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

create or replace function private.voice_is_owner(p_room uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.voice_rooms r where r.id = p_room and r.owner = (select auth.uid()));
$$;

-- Dueño o miembro admitido (no bloqueado en la sala). 0014: tampoco si el dueño lo bloqueó en social.
create or replace function private.voice_is_member(p_room uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select private.voice_is_owner(p_room)
      or exists (select 1 from public.voice_members m
                   join public.voice_rooms r on r.id = m.room_id
                  where m.room_id = p_room and m.user_id = (select auth.uid()) and not m.banned
                    and not exists (select 1 from public.friendships f
                                     where f.requester = r.owner and f.addressee = m.user_id and f.status = 'blocked'));
$$;

-- Autorización de Realtime: "voice:<código>" solo para el dueño y para quien está en la sala ahora (entró con
-- voice_join, que va antes de abrir el canal, y sigue con el latido de 30 s). 0014: una admisión vieja ya no
-- alcanza para escuchar el canal sin aparecer en la sala, y nadie bloqueado por el dueño entra.
create or replace function private.voice_can_use_topic(p_topic text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(p_topic, '') like 'voice:%'
     and exists (
       select 1 from public.voice_rooms r
        where r.code = substr(p_topic, 7)
          and (r.owner = (select auth.uid())
               or (exists (select 1 from public.voice_members m
                            where m.room_id = r.id and m.user_id = (select auth.uid()) and not m.banned
                              and m.last_seen > now() - interval '75 seconds')
                   and not exists (select 1 from public.friendships f
                                    where f.requester = r.owner and f.addressee = (select auth.uid()) and f.status = 'blocked'))));
$$;

-- ---------- Compartir: auxiliares de las políticas (antes en public: 0004) ----------

create or replace function private.share_is_owner(p_pack uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.shared_packs p where p.id = p_pack and p.owner = (select auth.uid()));
$$;

create or replace function private.share_is_member(p_pack uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.shared_pack_members m where m.pack_id = p_pack and m.user_id = (select auth.uid()));
$$;

-- Las evalúan las políticas con el rol authenticated (y moderation_self_block, el trigger de mensajes).
revoke all on function private.are_friends(uuid, uuid) from public, anon;
revoke all on function private.social_is_member(uuid) from public, anon;
revoke all on function private.moderation_self_block() from public, anon;
revoke all on function private.social_can_send(uuid) from public, anon;
revoke all on function private.voice_friend_array() from public, anon;
revoke all on function private.voice_is_owner(uuid) from public, anon;
revoke all on function private.voice_is_member(uuid) from public, anon;
revoke all on function private.voice_can_use_topic(text) from public, anon;
revoke all on function private.share_is_owner(uuid) from public, anon;
revoke all on function private.share_is_member(uuid) from public, anon;

grant execute on function private.are_friends(uuid, uuid) to authenticated;
grant execute on function private.social_is_member(uuid) to authenticated;
grant execute on function private.moderation_self_block() to authenticated, service_role;
grant execute on function private.social_can_send(uuid) to authenticated;
grant execute on function private.voice_friend_array() to authenticated;
grant execute on function private.voice_is_owner(uuid) to authenticated;
grant execute on function private.voice_is_member(uuid) to authenticated;
grant execute on function private.voice_can_use_topic(text) to authenticated;
grant execute on function private.share_is_owner(uuid) to authenticated;
grant execute on function private.share_is_member(uuid) to authenticated;

-- ---------- Social: funciones de 0002 y 0012 que llaman a las auxiliares (mismas firmas) ----------

-- Conversación 1:1 con un amigo (la crea la primera vez). Devuelve su id.
create or replace function public.social_get_or_create_conversation(other uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  lo uuid;
  hi uuid;
  cid uuid;
begin
  if me is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if other is null or other = me then
    raise exception 'user_not_found' using errcode = 'P0002';
  end if;
  lo := least(me, other);
  hi := greatest(me, other);
  select c.id into cid from public.conversations c where c.user_lo = lo and c.user_hi = hi;
  if cid is null then
    if not private.are_friends(me, other) then
      raise exception 'not_friends' using errcode = '42501';
    end if;
    insert into public.conversations (user_lo, user_hi) values (lo, hi)
      on conflict (user_lo, user_hi) do nothing
      returning id into cid;
    if cid is null then
      select c.id into cid from public.conversations c where c.user_lo = lo and c.user_hi = hi;
    end if;
  end if;
  insert into public.conversation_members (conversation_id, user_id) values (cid, lo), (cid, hi)
    on conflict (conversation_id, user_id) do nothing;
  return cid;
end $$;

-- Antes de guardar: limite anti-spam, fechas del servidor, respuesta dentro de la misma conversacion, columnas fijas.
-- 0012: con la cuenta silenciada o baneada no se puede editar el texto de un mensaje (sí borrarlo).
-- 0014: editar el texto también exige seguir siendo amigos, como escribir uno nuevo (borrarlo sigue permitido).
create or replace function public.social_messages_before() returns trigger
language plpgsql set search_path = public as $$
declare
  v_block text;
begin
  if tg_op = 'INSERT' then
    -- maximo 40 mensajes por minuto (PT429 = HTTP 429 en PostgREST: el launcher reintenta solo)
    if (select count(*) from public.messages m
         where m.sender_id = new.sender_id and m.created_at > now() - interval '1 minute') >= 40 then
      raise exception 'rate_limited' using errcode = 'PT429';
    end if;
    new.created_at := now();
    new.edited_at := null;
    new.deleted := false;
    if new.reply_to is not null and not exists (
      select 1 from public.messages m where m.id = new.reply_to and m.conversation_id = new.conversation_id) then
      new.reply_to := null;
    end if;
    return new;
  end if;
  -- UPDATE: solo cambian el texto o el borrado; un mensaje borrado ya no se toca.
  if old.deleted then
    return null;
  end if;
  new.id := old.id;
  new.conversation_id := old.conversation_id;
  new.sender_id := old.sender_id;
  new.created_at := old.created_at;
  new.reply_to := old.reply_to;
  if new.deleted then
    new.body := '';
    new.edited_at := now();
  elsif new.body is distinct from old.body then
    v_block := private.moderation_self_block();
    if v_block is not null then
      raise exception '%', v_block using errcode = 'P0001';
    end if;
    -- Sin sesión (SQL Editor) no hay amistad que mirar: moderar a mano sigue pudiendo editar.
    if (select auth.uid()) is not null and not private.social_can_send(old.conversation_id) then
      raise exception 'not_friends' using errcode = '42501';
    end if;
    new.edited_at := now();
  else
    new.edited_at := old.edited_at;
  end if;
  return new;
end $$;

-- Límite de las señales (0014): ventana de un minuto por usuario. Sin acceso directo.
create table if not exists private.social_throttle (
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null,
  window_start timestamptz not null default now(),
  hits int not null default 0,
  primary key (user_id, kind)
);

alter table private.social_throttle enable row level security;
revoke all on private.social_throttle from public, anon, authenticated;

-- Señal efimera al buzon de un amigo (invitaciones de voz, modpacks, "unite a mi mundo", escribiendo...).
-- Viaja por Realtime Broadcast privado al canal "inbox:<amigo>"; el remitente lo pone el servidor.
-- 0012: con la cuenta silenciada o baneada corta con 'user_muted' / 'user_banned'.
-- 0014: como mucho 120 señales por minuto por remitente (cada una es un mensaje de Realtime y una fila en
-- realtime.messages). PT429 = HTTP 429 en PostgREST.
create or replace function public.social_send_signal(target uuid, kind text, payload jsonb default '{}'::jsonb) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  v_block text;
  v_hits int;
begin
  if me is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  v_block := public.moderation_social_block(me);
  if v_block is not null then
    raise exception '%', v_block using errcode = 'P0001';
  end if;
  if kind is null or kind !~ '^[A-Za-z_][A-Za-z0-9_.:-]{0,39}$' then
    raise exception 'invalid_signal' using errcode = '22023';
  end if;
  if payload is not null and (jsonb_typeof(payload) <> 'object' or octet_length(payload::text) > 4096) then
    raise exception 'invalid_signal' using errcode = '22023';
  end if;
  if not private.are_friends(me, target) then
    raise exception 'not_friends' using errcode = '42501';
  end if;
  insert into private.social_throttle as t (user_id, kind, window_start, hits)
  values (me, 'signal', now(), 1)
  on conflict on constraint social_throttle_pkey do update set
    hits = case when t.window_start <= now() - interval '1 minute' then 1 else t.hits + 1 end,
    window_start = case when t.window_start <= now() - interval '1 minute' then now() else t.window_start end
  returning t.hits into v_hits;
  if v_hits > 120 then
    raise exception 'rate_limited' using errcode = 'PT429';
  end if;
  perform realtime.send(
    jsonb_build_object('from', me, 'kind', kind, 'payload', coalesce(payload, '{}'::jsonb), 'at', now()),
    'signal',
    'inbox:' || target::text,
    true
  );
  return true;
end $$;

-- Las reemplazadas conservan los permisos de antes (solo authenticated).
revoke all on function public.social_get_or_create_conversation(uuid) from public, anon;
revoke all on function public.social_send_signal(uuid, text, jsonb) from public, anon;
revoke all on function public.social_messages_before() from public, anon, authenticated;
grant execute on function public.social_get_or_create_conversation(uuid) to authenticated;
grant execute on function public.social_send_signal(uuid, text, jsonb) to authenticated;

-- ---------- Voice Chat: funciones de 0003 (mismas firmas) ----------

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
  -- 0014: si el dueño te bloqueó en social, la sala no existe para vos (como en social, no se avisa del bloqueo).
  if v_room.owner <> me and exists (select 1 from public.friendships f
                                     where f.requester = v_room.owner and f.addressee = me and f.status = 'blocked') then
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
  -- 0014: si el dueño te bloqueó en social, la sala no existe para vos (aunque tengas una admisión vieja).
  if v_room.owner <> me and exists (select 1 from public.friendships f
                                     where f.requester = v_room.owner and f.addressee = me and f.status = 'blocked') then
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
  -- 0014: para quien el dueño bloqueó en social, la sala deja de existir (sale con el próximo latido).
  if v_room.owner <> me and exists (select 1 from public.friendships f
                                     where f.requester = v_room.owner and f.addressee = me and f.status = 'blocked') then
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
  -- 0014: con la sala cerrada, el latido no revive una sesión que ya no estaba (salió o pasó más de 75 s sin
  -- latido): para volver hace falta una invitación, como en voice_join.
  if v_room.is_locked and v_room.owner <> me
     and (v_member.last_seen is null or v_member.last_seen <= now() - interval '75 seconds') then
    return jsonb_build_object('error', 'locked');
  end if;
  update public.voice_members m set last_seen = now() where m.room_id = p_room and m.user_id = me;
  update public.voice_rooms r set last_active = now() where r.id = p_room returning * into v_room;
  return jsonb_build_object('room', public.voice__room_json(v_room, true));
end $$;

-- 0014: salir también borra la sesión (id y clave pública): un latido con la sesión vieja ya no vuelve a poner a
-- nadie en la sala.
create or replace function public.voice_leave(p_room uuid, p_session text) returns void
language sql volatile security definer set search_path = public as $$
  update public.voice_members m set last_seen = null, session_id = null, session_key = null
   where m.room_id = p_room and m.user_id = (select auth.uid()) and m.session_id is not distinct from p_session;
$$;

-- Claves publicas de las sesiones activas (para verificar señales, chat y ordenes del anfitrion) + nombres.
create or replace function public.voice_member_keys(p_room uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not private.voice_is_member(p_room) then
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
-- 0014: solo a amigos (como hace el launcher): la invitación pone la sala en Recientes del invitado.
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
  if not private.are_friends(me, p_user) then
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

-- Lobby: mis salas, salas recientes (donde fui admitido) y salas visibles de mis amigos con gente adentro.
-- 0014: sin las salas de quien me bloqueó en social.
create or replace function public.voice_list_rooms() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  v_friends uuid[];
begin
  if me is null then
    return jsonb_build_object('error', 'auth');
  end if;
  v_friends := private.voice_friend_array();
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
           and not exists (select 1 from public.friendships fb where fb.requester = r.owner and fb.addressee = me and fb.status = 'blocked')
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
           and not exists (select 1 from public.friendships fb where fb.requester = r.owner and fb.addressee = me and fb.status = 'blocked')
         order by r.last_active desc
         limit 30) x), '[]'::jsonb),
    'friends_supported', v_friends is not null
  );
end $$;

-- Las reemplazadas conservan los permisos de 0003 (solo authenticated).
revoke all on function public.voice_room_by_code(text) from public, anon;
revoke all on function public.voice_join(text, text, text, text) from public, anon;
revoke all on function public.voice_heartbeat(uuid, text) from public, anon;
revoke all on function public.voice_leave(uuid, text) from public, anon;
revoke all on function public.voice_member_keys(uuid) from public, anon;
revoke all on function public.voice_invite(uuid, uuid) from public, anon;
revoke all on function public.voice_list_rooms() from public, anon;
grant execute on function public.voice_room_by_code(text) to authenticated;
grant execute on function public.voice_join(text, text, text, text) to authenticated;
grant execute on function public.voice_heartbeat(uuid, text) to authenticated;
grant execute on function public.voice_leave(uuid, text) to authenticated;
grant execute on function public.voice_member_keys(uuid) to authenticated;
grant execute on function public.voice_invite(uuid, uuid) to authenticated;
grant execute on function public.voice_list_rooms() to authenticated;

-- ---------- Políticas: las mismas, ahora con las auxiliares de private ----------

drop policy if exists "user_activity_select_friends" on public.user_activity;
create policy "user_activity_select_friends" on public.user_activity
  for select to authenticated
  using (user_id = (select auth.uid()) or private.are_friends((select auth.uid()), user_id));

drop policy if exists "conversation_members_select" on public.conversation_members;
create policy "conversation_members_select" on public.conversation_members
  for select to authenticated
  using (private.social_is_member(conversation_id));

drop policy if exists "messages_select_members" on public.messages;
create policy "messages_select_members" on public.messages
  for select to authenticated
  using (private.social_is_member(conversation_id));

drop policy if exists "messages_insert_own" on public.messages;
create policy "messages_insert_own" on public.messages
  for insert to authenticated
  with check (sender_id = (select auth.uid()) and private.social_can_send(conversation_id));

drop policy if exists "message_reactions_select_members" on public.message_reactions;
create policy "message_reactions_select_members" on public.message_reactions
  for select to authenticated
  using (private.social_is_member(conversation_id));

drop policy if exists "message_reactions_insert_own" on public.message_reactions;
create policy "message_reactions_insert_own" on public.message_reactions
  for insert to authenticated
  with check (user_id = (select auth.uid()) and private.social_can_send(conversation_id));

drop policy if exists "voice_rooms_select" on public.voice_rooms;
create policy "voice_rooms_select" on public.voice_rooms
  for select to authenticated
  using (
    owner = (select auth.uid())
    or private.voice_is_member(id)
    or (not is_private and owner = any (coalesce((select private.voice_friend_array()), '{}'::uuid[])))
  );

drop policy if exists "voice_members_select" on public.voice_members;
create policy "voice_members_select" on public.voice_members
  for select to authenticated
  using (user_id = (select auth.uid()) or private.voice_is_owner(room_id));

drop policy if exists "voice_members_delete" on public.voice_members;
create policy "voice_members_delete" on public.voice_members
  for delete to authenticated
  using ((user_id = (select auth.uid()) and not banned) or private.voice_is_owner(room_id));

drop policy if exists "shared_packs_select" on public.shared_packs;
create policy "shared_packs_select" on public.shared_packs
  for select to authenticated
  using (owner = (select auth.uid()) or private.share_is_member(id));

drop policy if exists "shared_pack_members_select" on public.shared_pack_members;
create policy "shared_pack_members_select" on public.shared_pack_members
  for select to authenticated
  using (user_id = (select auth.uid()) or private.share_is_owner(pack_id) or private.share_is_member(pack_id));

drop policy if exists "shared_pack_members_delete" on public.shared_pack_members;
create policy "shared_pack_members_delete" on public.shared_pack_members
  for delete to authenticated
  using (user_id = (select auth.uid()) or private.share_is_owner(pack_id));

-- Realtime: canal privado "voice:<codigo>" (señalizacion WebRTC, chat, soundboard, moderacion y presencia)
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
          and (select private.voice_can_use_topic((select realtime.topic())))
        )
    $policy$;
    execute 'drop policy if exists "voice_room_send" on realtime.messages';
    execute $policy$
      create policy "voice_room_send" on realtime.messages
        for insert to authenticated
        with check (
          realtime.messages.extension in ('broadcast', 'presence')
          and (select realtime.topic()) like 'voice:%'
          and (select private.voice_can_use_topic((select realtime.topic())))
        )
    $policy$;
  end if;
end $$;

-- Las de public ya no las usa nadie (el launcher nunca las llamó por la API).
drop function if exists public.are_friends(uuid, uuid);
drop function if exists public.social_is_member(uuid);
drop function if exists public.social_can_send(uuid);
drop function if exists public.moderation_self_block();
drop function if exists public.voice_friend_array();
drop function if exists public.voice_is_owner(uuid);
drop function if exists public.voice_is_member(uuid);
drop function if exists public.voice_can_use_topic(text);
drop function if exists public.share_is_owner(uuid);
drop function if exists public.share_is_member(uuid);

-- ---------- Storage: cuotas en cada escritura ----------

-- Mover exige UPDATE y las políticas UPDATE se combinan con OR: con la de screenshots y clips, un archivo pasaba de
-- world-saves a clips (o al revés) sin cuota ni límite de cantidad. El launcher nunca cambia esos archivos (sube con
-- upsert: false, borra y firma links): sin política de UPDATE no se pueden mover ni pisar.
drop policy if exists "venus_media_update_own" on storage.objects;

-- Las políticas de INSERT solo controlan la carpeta: las cuotas las controla el trigger de abajo.
drop policy if exists "world_saves_insert_own" on storage.objects;
create policy "world_saves_insert_own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'world-saves' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "venus_media_insert_own" on storage.objects;
create policy "venus_media_insert_own" on storage.objects
  for insert to authenticated
  with check (
    bucket_id in ('screenshots', 'clips')
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and array_length(storage.foldername(name), 1) = 1
  );

drop function if exists public.cloud_saves_quota_ok();
drop function if exists public.venus_media_count(text);

-- Cuotas de Storage en CADA escritura de storage.objects (subir, pisar, copiar o mover). Corre también cuando
-- Storage guarda como service role (subida con URL firmada, donde no hay RLS): world-saves hasta 2 GB por usuario;
-- screenshots y clips hasta 500 y 100 archivos, sueltos en la carpeta del usuario. Al firmar o probar el permiso de
-- una subida el tamaño todavía no se conoce (cuenta 0); el real se controla cuando Storage guarda el archivo (si
-- no entra, Storage borra lo que subió). Para cambiar las cuotas, editá esta función.
create or replace function private.storage_quota_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_owner text := (storage.foldername(new.name))[1];
  v_size bigint;
  v_old_id uuid;
  v_used bigint;
  v_files integer;
begin
  if new.bucket_id not in ('world-saves', 'screenshots', 'clips') then
    return new;
  end if;
  v_size := coalesce((new.metadata ->> 'size')::bigint, 0);
  if tg_op = 'UPDATE' then
    -- Un cambio que no mueve el archivo ni lo agranda (fechas, metadatos) no se controla.
    if new.bucket_id = old.bucket_id and new.name = old.name
       and v_size <= coalesce((old.metadata ->> 'size')::bigint, 0) then
      return new;
    end if;
    v_old_id := old.id;
  end if;
  if new.bucket_id <> 'world-saves' and coalesce(array_length(storage.foldername(new.name), 1), 0) <> 1 then
    raise exception 'storage_bad_path' using errcode = '42501';
  end if;
  -- De a una escritura por usuario y bucket: las subidas en paralelo no pasan juntas la cuota.
  perform pg_advisory_xact_lock(hashtext('venus-storage:' || new.bucket_id || ':' || coalesce(v_owner, '')));
  -- Lo que ya hay en su carpeta, sin el archivo que se pisa o se mueve (rango de nombres: usa el índice de Storage).
  select coalesce(sum(coalesce((o.metadata ->> 'size')::bigint, 0)), 0), count(*)
    into v_used, v_files
    from storage.objects o
   where o.bucket_id = new.bucket_id
     and o.name collate "C" >= (v_owner || '/')
     and o.name collate "C" < (v_owner || '0')
     and o.name <> new.name
     and o.id is distinct from v_old_id;
  if (new.bucket_id = 'world-saves' and v_used + v_size > 2147483648)
     or (new.bucket_id = 'screenshots' and v_files >= 500)
     or (new.bucket_id = 'clips' and v_files >= 100) then
    raise exception 'storage_quota_exceeded' using errcode = '42501';
  end if;
  return new;
end $$;

revoke all on function private.storage_quota_before() from public, anon, authenticated;

drop trigger if exists venus_storage_quota on storage.objects;
create trigger venus_storage_quota
  before insert or update on storage.objects
  for each row execute function private.storage_quota_before();

-- ---------- Topes de filas por usuario ----------
-- Como los de salas, modpacks y mensajes: 1000 copias en la nube (mundos y configuraciones) y 600 archivos
-- compartidos (500 capturas + 100 clips). Sin tope, un POST en bucle llenaba el disco de la base.

create or replace function private.cloud_saves_before() returns trigger
language plpgsql set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtext('venus-cloud-saves:' || new.owner::text));
  if (select count(*) from public.cloud_saves c where c.owner = new.owner) >= 1000 then
    raise exception 'too_many_rows' using errcode = '54000';
  end if;
  return new;
end $$;

create or replace function private.shared_media_before() returns trigger
language plpgsql set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtext('venus-shared-media:' || new.owner::text));
  if (select count(*) from public.shared_media m where m.owner = new.owner) >= 600 then
    raise exception 'too_many_rows' using errcode = '54000';
  end if;
  return new;
end $$;

revoke all on function private.cloud_saves_before() from public, anon, authenticated;
revoke all on function private.shared_media_before() from public, anon, authenticated;

drop trigger if exists cloud_saves_before on public.cloud_saves;
create trigger cloud_saves_before
  before insert on public.cloud_saves
  for each row execute function private.cloud_saves_before();

drop trigger if exists shared_media_before on public.shared_media;
create trigger shared_media_before
  before insert on public.shared_media
  for each row execute function private.shared_media_before();

-- ---------- Admins: sin promoción automática por email (0012) ----------
-- email_confirmed_at solo prueba que el email es de esa persona con "Confirm email" activado: con la confirmación
-- apagada, quien registrara primero un email de la lista (o se lo cambiara) quedaba admin solo. Desde 0014 la fila
-- de app_admins se carga a mano después de verificar la cuenta (docs/admin.md); admin_is_admin_user sigue
-- exigiendo esa fila, el email en la lista, confirmado y sin baneo. Los admins que ya están no cambian.
drop trigger if exists on_auth_user_admin_sync on auth.users;
drop trigger if exists app_admin_emails_sync on public.app_admin_emails;
drop function if exists public.admin_sync_user();
drop function if exists public.admin_sync_emails();
drop function if exists public.admin_sync_all();

-- El email que carga 0012 queda solo si esa cuenta ya es admin (en una copia del proyecto no da nada).
delete from public.app_admin_emails e
 where e.email = 'admin@example.com'
   and not exists (select 1 from public.app_admins a where a.email = e.email);

-- ---------- venus_friend_code (0001) ----------
-- Solo la usa handle_new_user (security definer, corre como su dueño): no tiene que poder llamarse por la API.
revoke all on function public.venus_friend_code() from public, anon, authenticated;
