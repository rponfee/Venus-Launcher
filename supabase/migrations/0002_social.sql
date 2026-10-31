-- Venus Launcher · 0002 · Social: amigos, presencia/actividad, conversaciones 1:1 y mensajes privados.
-- Requiere 0001_base.sql (profiles). Se puede volver a ejecutar sin romper nada.
-- AVISO: no la vuelvas a aplicar sola. 0012 y 0014 reemplazan funciones y políticas de este archivo (silencios y
-- baneos, editar sin ser amigos, señales sin límite, auxiliares en private): reaplicarla sola las deja como acá sin
-- avisar. Se reaplican todas juntas y en orden (docs/supabase.md, sección 2); un cambio va en una migración nueva.
--
-- Modelo de seguridad (RLS activado en todas las tablas):
--   * friendships: la ven solo sus dos participantes (un bloqueo lo ve solo quien bloqueo).
--     No tiene politicas de escritura: se modifica unicamente con las funciones social_* de abajo.
--   * user_activity: la escribe cada uno con social_heartbeat(); la leen solo los amigos aceptados (are_friends).
--   * conversations / conversation_members: solo sus dos miembros. Se crean con social_get_or_create_conversation().
--   * messages / message_reactions: solo los miembros de la conversacion; escribir exige seguir siendo amigos.
--     Cada uno edita o borra (borrado suave) solo sus mensajes.
--   * Realtime Broadcast privado "inbox:<userId>": lo escucha solo su dueño; las señales se mandan con
--     social_send_signal() (el servidor pone el remitente, nadie puede hacerse pasar por otro).

-- =====================================================================
-- Amistades
-- =====================================================================
create table if not exists public.friendships (
  id uuid primary key default gen_random_uuid(),
  requester uuid not null references public.profiles (id) on delete cascade, -- en un bloqueo: quien bloquea
  addressee uuid not null references public.profiles (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'blocked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint friendships_not_self check (requester <> addressee)
);

-- Una sola fila por pareja, sin importar quien la creo.
create unique index if not exists friendships_pair_key
  on public.friendships (least(requester, addressee), greatest(requester, addressee));
create index if not exists friendships_requester_idx on public.friendships (requester, status);
create index if not exists friendships_addressee_idx on public.friendships (addressee, status);

alter table public.friendships enable row level security;

drop policy if exists "friendships_select_participants" on public.friendships;
create policy "friendships_select_participants" on public.friendships
  for select to authenticated
  using (requester = (select auth.uid()) or (addressee = (select auth.uid()) and status <> 'blocked'));

revoke all on public.friendships from anon;
revoke insert, update, delete, truncate on public.friendships from authenticated;
grant select on public.friendships to authenticated;

-- true si a y b son amigos aceptados. Solo responde por parejas que incluyen a quien pregunta
-- (no sirve para espiar el grafo de amistades de otros).
create or replace function public.are_friends(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select a is not null and b is not null and a <> b
     and (select auth.uid()) in (a, b)
     and exists (
       select 1 from public.friendships f
        where f.status = 'accepted'
          and least(f.requester, f.addressee) = least(a, b)
          and greatest(f.requester, f.addressee) = greatest(a, b));
$$;

-- =====================================================================
-- Presencia y actividad (que esta jugando cada uno)
-- =====================================================================
create table if not exists public.user_activity (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  status text not null default 'offline' check (status in ('online', 'away', 'busy', 'offline')),
  activity jsonb check (activity is null or (jsonb_typeof(activity) = 'object' and octet_length(activity::text) <= 1024)),
  updated_at timestamptz not null default now()
);

alter table public.user_activity enable row level security;

drop policy if exists "user_activity_select_friends" on public.user_activity;
create policy "user_activity_select_friends" on public.user_activity
  for select to authenticated
  using (user_id = (select auth.uid()) or public.are_friends((select auth.uid()), user_id));

revoke all on public.user_activity from anon;
revoke insert, update, delete, truncate on public.user_activity from authenticated;
grant select on public.user_activity to authenticated;

-- =====================================================================
-- Conversaciones 1:1
-- =====================================================================
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_lo uuid not null references public.profiles (id) on delete cascade,
  user_hi uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  last_message_at timestamptz,
  constraint conversations_pair_order check (user_lo < user_hi),
  constraint conversations_pair_key unique (user_lo, user_hi)
);
create index if not exists conversations_user_hi_idx on public.conversations (user_hi);

alter table public.conversations enable row level security;

drop policy if exists "conversations_select_members" on public.conversations;
create policy "conversations_select_members" on public.conversations
  for select to authenticated
  using ((select auth.uid()) in (user_lo, user_hi));

revoke all on public.conversations from anon;
revoke insert, update, delete, truncate on public.conversations from authenticated;
grant select on public.conversations to authenticated;

-- Miembros (con id propio: los eventos DELETE de Realtime solo exponen la clave primaria).
create table if not exists public.conversation_members (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  last_read_at timestamptz not null default now(),
  joined_at timestamptz not null default now(),
  constraint conversation_members_key unique (conversation_id, user_id)
);
create index if not exists conversation_members_user_idx on public.conversation_members (user_id);

alter table public.conversation_members enable row level security;

-- true si quien pregunta es miembro de la conversacion.
create or replace function public.social_is_member(conv uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.conversations c
     where c.id = conv and (select auth.uid()) in (c.user_lo, c.user_hi));
$$;

-- true si quien pregunta es miembro y sigue siendo amigo del otro (puede escribir).
create or replace function public.social_can_send(conv uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.conversations c
     where c.id = conv
       and (select auth.uid()) in (c.user_lo, c.user_hi)
       and public.are_friends(c.user_lo, c.user_hi));
$$;

drop policy if exists "conversation_members_select" on public.conversation_members;
create policy "conversation_members_select" on public.conversation_members
  for select to authenticated
  using (public.social_is_member(conversation_id));

revoke all on public.conversation_members from anon;
revoke insert, update, delete, truncate on public.conversation_members from authenticated;
grant select on public.conversation_members to authenticated;

-- =====================================================================
-- Mensajes
-- =====================================================================
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(), -- el cliente puede elegirlo: reintentos sin duplicados
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_id uuid not null references public.profiles (id) on delete cascade,
  body text not null,
  reply_to uuid references public.messages (id) on delete set null,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted boolean not null default false,
  constraint messages_body_length check (char_length(body) <= 2000),
  constraint messages_body_present check (deleted or char_length(btrim(body)) > 0)
);
create index if not exists messages_conversation_created_idx on public.messages (conversation_id, created_at desc);
create index if not exists messages_sender_created_idx on public.messages (sender_id, created_at desc);
create index if not exists messages_reply_to_idx on public.messages (reply_to) where reply_to is not null;

alter table public.messages enable row level security;

drop policy if exists "messages_select_members" on public.messages;
create policy "messages_select_members" on public.messages
  for select to authenticated
  using (public.social_is_member(conversation_id));

drop policy if exists "messages_insert_own" on public.messages;
create policy "messages_insert_own" on public.messages
  for insert to authenticated
  with check (sender_id = (select auth.uid()) and public.social_can_send(conversation_id));

drop policy if exists "messages_update_own" on public.messages;
create policy "messages_update_own" on public.messages
  for update to authenticated
  using (sender_id = (select auth.uid()))
  with check (sender_id = (select auth.uid()));

revoke all on public.messages from anon;
revoke insert, update, delete, truncate on public.messages from authenticated;
grant select on public.messages to authenticated;
grant insert (id, conversation_id, sender_id, body, reply_to) on public.messages to authenticated;
grant update (body, deleted) on public.messages to authenticated;

-- Antes de guardar: limite anti-spam, fechas del servidor, respuesta dentro de la misma conversacion, columnas fijas.
create or replace function public.social_messages_before() returns trigger
language plpgsql set search_path = public as $$
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
    new.edited_at := now();
  else
    new.edited_at := old.edited_at;
  end if;
  return new;
end $$;

drop trigger if exists social_messages_before on public.messages;
create trigger social_messages_before
  before insert or update on public.messages
  for each row execute function public.social_messages_before();

-- Despues de un mensaje nuevo: ultima actividad de la conversacion y "leido" de quien lo mando.
create or replace function public.social_messages_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.conversations set last_message_at = new.created_at where id = new.conversation_id;
  update public.conversation_members set last_read_at = new.created_at
   where conversation_id = new.conversation_id and user_id = new.sender_id and last_read_at < new.created_at;
  return null;
end $$;

drop trigger if exists social_messages_after_insert on public.messages;
create trigger social_messages_after_insert
  after insert on public.messages
  for each row execute function public.social_messages_after_insert();

-- =====================================================================
-- Reacciones
-- =====================================================================
create table if not exists public.message_reactions (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  emoji text not null check (char_length(emoji) between 1 and 16),
  created_at timestamptz not null default now(),
  constraint message_reactions_key unique (message_id, user_id, emoji)
);
create index if not exists message_reactions_conversation_idx on public.message_reactions (conversation_id);

alter table public.message_reactions enable row level security;

drop policy if exists "message_reactions_select_members" on public.message_reactions;
create policy "message_reactions_select_members" on public.message_reactions
  for select to authenticated
  using (public.social_is_member(conversation_id));

drop policy if exists "message_reactions_insert_own" on public.message_reactions;
create policy "message_reactions_insert_own" on public.message_reactions
  for insert to authenticated
  with check (user_id = (select auth.uid()) and public.social_can_send(conversation_id));

drop policy if exists "message_reactions_delete_own" on public.message_reactions;
create policy "message_reactions_delete_own" on public.message_reactions
  for delete to authenticated
  using (user_id = (select auth.uid()));

revoke all on public.message_reactions from anon;
revoke insert, update, delete, truncate on public.message_reactions from authenticated;
grant select, delete on public.message_reactions to authenticated;
grant insert (message_id, conversation_id, user_id, emoji) on public.message_reactions to authenticated;

-- La conversacion sale siempre del mensaje (no se puede reaccionar "desde" otra conversacion).
create or replace function public.social_reactions_before() returns trigger
language plpgsql set search_path = public as $$
declare
  msg record;
begin
  select m.conversation_id, m.deleted into msg from public.messages m where m.id = new.message_id;
  if not found or msg.deleted then
    raise exception 'message_not_found' using errcode = 'P0002';
  end if;
  new.conversation_id := msg.conversation_id;
  new.created_at := now();
  if (select count(*) from public.message_reactions r where r.message_id = new.message_id and r.user_id = new.user_id) >= 12 then
    raise exception 'too_many_reactions' using errcode = '54000';
  end if;
  return new;
end $$;

drop trigger if exists social_reactions_before on public.message_reactions;
create trigger social_reactions_before
  before insert on public.message_reactions
  for each row execute function public.social_reactions_before();

-- =====================================================================
-- Funciones (RPC) que usa el launcher
-- =====================================================================

-- Enviar solicitud por codigo de amigo (VENUS-XXXXXX) o nombre de usuario exacto.
-- Devuelve { result: 'sent' | 'accepted' | 'already_sent' | 'already_friends', user_id }.
create or replace function public.social_send_friend_request(target text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  q text := btrim(coalesce(target, ''));
  other_id uuid;
  existing public.friendships%rowtype;
  pending_count int;
begin
  if me is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  q := ltrim(q, '@');
  if q !~* '^venus-?[a-z0-9]{6}$' and q !~ '^[A-Za-z0-9_]{3,20}$' then
    raise exception 'invalid_query' using errcode = '22023';
  end if;
  if q ~* '^venus-?[a-z0-9]{6}$' then
    select p.id into other_id from public.profiles p where p.friend_code = 'VENUS-' || upper(right(q, 6));
  end if;
  -- Si no era un codigo (o no existe), se prueba como nombre de usuario exacto.
  if other_id is null and q ~ '^[A-Za-z0-9_]{3,20}$' then
    select p.id into other_id from public.profiles p where lower(p.username) = lower(q);
  end if;
  if other_id is null then
    raise exception 'user_not_found' using errcode = 'P0002';
  end if;
  if other_id = me then
    raise exception 'cannot_add_self' using errcode = '22023';
  end if;

  select * into existing from public.friendships f
   where least(f.requester, f.addressee) = least(me, other_id)
     and greatest(f.requester, f.addressee) = greatest(me, other_id)
   for update;

  if found then
    if existing.status = 'accepted' then
      return jsonb_build_object('result', 'already_friends', 'user_id', other_id);
    elsif existing.status = 'blocked' then
      if existing.requester = me then
        raise exception 'user_blocked' using errcode = '42501';
      end if;
      raise exception 'user_not_found' using errcode = 'P0002'; -- no revelar que te bloquearon
    elsif existing.requester = me then
      return jsonb_build_object('result', 'already_sent', 'user_id', other_id);
    end if;
    -- El otro ya me habia mandado una solicitud: quedan como amigos.
    update public.friendships set status = 'accepted', updated_at = now() where id = existing.id;
    return jsonb_build_object('result', 'accepted', 'user_id', other_id);
  end if;

  select count(*) into pending_count from public.friendships f where f.requester = me and f.status = 'pending';
  if pending_count >= 100 then
    raise exception 'too_many_requests' using errcode = '54000';
  end if;

  begin
    insert into public.friendships (requester, addressee, status) values (me, other_id, 'pending');
  exception when unique_violation then
    -- Carrera: el otro mando su solicitud al mismo tiempo; se vuelve a evaluar con la fila ya creada.
    return public.social_send_friend_request(target);
  end;
  return jsonb_build_object('result', 'sent', 'user_id', other_id);
end $$;

-- Aceptar o rechazar una solicitud recibida.
create or replace function public.social_respond_friend_request(other uuid, accept boolean) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  fid uuid;
begin
  if me is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if accept then
    update public.friendships set status = 'accepted', updated_at = now()
     where requester = other and addressee = me and status = 'pending'
    returning id into fid;
  else
    delete from public.friendships
     where requester = other and addressee = me and status = 'pending'
    returning id into fid;
  end if;
  if fid is null then
    raise exception 'request_not_found' using errcode = 'P0002';
  end if;
  return true;
end $$;

-- Quitar un amigo, cancelar una solicitud enviada o rechazar una recibida.
create or replace function public.social_remove_friend(other uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  delete from public.friendships
   where least(requester, addressee) = least(me, other)
     and greatest(requester, addressee) = greatest(me, other)
     and status in ('pending', 'accepted');
  return found;
end $$;

-- Bloquear: corta la amistad y las solicitudes. El bloqueado no ve la fila.
create or replace function public.social_block_user(other uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  existing public.friendships%rowtype;
begin
  if me is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if other is null or other = me or not exists (select 1 from public.profiles p where p.id = other) then
    raise exception 'user_not_found' using errcode = 'P0002';
  end if;
  select * into existing from public.friendships f
   where least(f.requester, f.addressee) = least(me, other)
     and greatest(f.requester, f.addressee) = greatest(me, other)
   for update;
  if found then
    if existing.status = 'blocked' then
      return true; -- ya existe un bloqueo entre los dos
    end if;
    update public.friendships set requester = me, addressee = other, status = 'blocked', updated_at = now()
     where id = existing.id;
  else
    insert into public.friendships (requester, addressee, status) values (me, other, 'blocked');
  end if;
  return true;
end $$;

-- Desbloquear (solo quien bloqueo).
create or replace function public.social_unblock_user(other uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  delete from public.friendships where requester = me and addressee = other and status = 'blocked';
  return found;
end $$;

-- Conversacion 1:1 con un amigo (la crea la primera vez). Devuelve su id.
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
    if not public.are_friends(me, other) then
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

-- Marcar como leida una conversacion (hora del servidor). Devuelve la marca guardada.
create or replace function public.social_mark_read(conv uuid) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  ts timestamptz;
begin
  if me is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  update public.conversation_members set last_read_at = now()
   where conversation_id = conv and user_id = me
  returning last_read_at into ts;
  if ts is null then
    raise exception 'conversation_not_found' using errcode = 'P0002';
  end if;
  return ts;
end $$;

-- Resumen de mis conversaciones: el otro miembro, no leidos, ultimo mensaje y lecturas.
-- security invoker: las politicas RLS se aplican igual que en una consulta normal.
create or replace function public.social_conversations()
returns table (
  conv_id uuid,
  other_user uuid,
  conv_created_at timestamptz,
  conv_last_message_at timestamptz,
  my_last_read_at timestamptz,
  other_last_read_at timestamptz,
  unread_count integer,
  last_id uuid,
  last_sender uuid,
  last_body text,
  last_deleted boolean,
  last_created_at timestamptz
)
language sql stable security invoker set search_path = public as $$
  select c.id,
         case when c.user_lo = (select auth.uid()) then c.user_hi else c.user_lo end,
         c.created_at,
         c.last_message_at,
         mine.last_read_at,
         theirs.last_read_at,
         (select count(*)::int from public.messages m
           where m.conversation_id = c.id
             and m.sender_id <> (select auth.uid())
             and not m.deleted
             and m.created_at > mine.last_read_at),
         lm.id,
         lm.sender_id,
         left(lm.body, 200),
         lm.deleted,
         lm.created_at
    from public.conversations c
    join public.conversation_members mine
      on mine.conversation_id = c.id and mine.user_id = (select auth.uid())
    left join public.conversation_members theirs
      on theirs.conversation_id = c.id and theirs.user_id <> (select auth.uid())
    left join lateral (
      select m.id, m.sender_id, m.body, m.deleted, m.created_at
        from public.messages m
       where m.conversation_id = c.id
       order by m.created_at desc
       limit 1
    ) lm on true
   where (select auth.uid()) in (c.user_lo, c.user_hi)
   order by coalesce(c.last_message_at, c.created_at) desc;
$$;

-- Latido de presencia (cada ~60 s y al cambiar de estado). Devuelve la hora del servidor.
create or replace function public.social_heartbeat(p_status text, p_activity jsonb default null) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  ts timestamptz := now();
begin
  if me is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if p_status is null or p_status not in ('online', 'away', 'busy', 'offline') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;
  if p_activity is not null and (jsonb_typeof(p_activity) <> 'object' or octet_length(p_activity::text) > 1024) then
    raise exception 'invalid_activity' using errcode = '22023';
  end if;
  if p_status = 'offline' then
    p_activity := null;
  end if;
  insert into public.user_activity (user_id, status, activity, updated_at)
  values (me, p_status, p_activity, ts)
  on conflict (user_id) do update
    set status = excluded.status, activity = excluded.activity, updated_at = excluded.updated_at;
  return ts;
end $$;

-- Señal efimera al buzon de un amigo (invitaciones de voz, modpacks, "unite a mi mundo", escribiendo...).
-- Viaja por Realtime Broadcast privado al canal "inbox:<amigo>"; el remitente lo pone el servidor.
create or replace function public.social_send_signal(target uuid, kind text, payload jsonb default '{}'::jsonb) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if kind is null or kind !~ '^[A-Za-z_][A-Za-z0-9_.:-]{0,39}$' then
    raise exception 'invalid_signal' using errcode = '22023';
  end if;
  if payload is not null and (jsonb_typeof(payload) <> 'object' or octet_length(payload::text) > 4096) then
    raise exception 'invalid_signal' using errcode = '22023';
  end if;
  if not public.are_friends(me, target) then
    raise exception 'not_friends' using errcode = '42501';
  end if;
  perform realtime.send(
    jsonb_build_object('from', me, 'kind', kind, 'payload', coalesce(payload, '{}'::jsonb), 'at', now()),
    'signal',
    'inbox:' || target::text,
    true
  );
  return true;
end $$;

-- =====================================================================
-- Permisos de las funciones (nunca para anon)
-- =====================================================================
revoke all on function public.are_friends(uuid, uuid) from public, anon;
revoke all on function public.social_is_member(uuid) from public, anon;
revoke all on function public.social_can_send(uuid) from public, anon;
revoke all on function public.social_send_friend_request(text) from public, anon;
revoke all on function public.social_respond_friend_request(uuid, boolean) from public, anon;
revoke all on function public.social_remove_friend(uuid) from public, anon;
revoke all on function public.social_block_user(uuid) from public, anon;
revoke all on function public.social_unblock_user(uuid) from public, anon;
revoke all on function public.social_get_or_create_conversation(uuid) from public, anon;
revoke all on function public.social_mark_read(uuid) from public, anon;
revoke all on function public.social_conversations() from public, anon;
revoke all on function public.social_heartbeat(text, jsonb) from public, anon;
revoke all on function public.social_send_signal(uuid, text, jsonb) from public, anon;
revoke all on function public.social_messages_before() from public, anon, authenticated;
revoke all on function public.social_messages_after_insert() from public, anon, authenticated;
revoke all on function public.social_reactions_before() from public, anon, authenticated;

grant execute on function public.are_friends(uuid, uuid) to authenticated;
grant execute on function public.social_is_member(uuid) to authenticated;
grant execute on function public.social_can_send(uuid) to authenticated;
grant execute on function public.social_send_friend_request(text) to authenticated;
grant execute on function public.social_respond_friend_request(uuid, boolean) to authenticated;
grant execute on function public.social_remove_friend(uuid) to authenticated;
grant execute on function public.social_block_user(uuid) to authenticated;
grant execute on function public.social_unblock_user(uuid) to authenticated;
grant execute on function public.social_get_or_create_conversation(uuid) to authenticated;
grant execute on function public.social_mark_read(uuid) to authenticated;
grant execute on function public.social_conversations() to authenticated;
grant execute on function public.social_heartbeat(text, jsonb) to authenticated;
grant execute on function public.social_send_signal(uuid, text, jsonb) to authenticated;

-- =====================================================================
-- Realtime
-- =====================================================================
-- Cambios en vivo (Postgres Changes respeta las politicas RLS de cada tabla).
do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['friendships', 'user_activity', 'conversation_members', 'messages', 'message_reactions'] loop
      if not exists (
        select 1 from pg_publication_tables
         where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

-- Buzon personal: solo su dueño puede escuchar "inbox:<su id>" (canal privado).
-- Nadie tiene permiso para mandar por el socket: las señales entran solo por social_send_signal().
do $$
begin
  if to_regclass('realtime.messages') is not null then
    execute 'drop policy if exists "venus_inbox_receive_own" on realtime.messages';
    execute $policy$
      create policy "venus_inbox_receive_own" on realtime.messages
        for select to authenticated
        using (
          realtime.messages.extension = 'broadcast'
          and (select realtime.topic()) = 'inbox:' || (select auth.uid())::text
        )
    $policy$;
  end if;
end $$;
