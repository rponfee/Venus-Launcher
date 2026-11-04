-- 0035_app_celular.sql · Venus 3.4 · App para celular (PWA de web/app): avisos push sin contenido y clips recibidos.
-- Guía: docs/wip/app-celular-34.md. Se aplica después de 0027 (no depende de 0028 a 0034). Idempotente.
--
--   * push_subscriptions: un endpoint de Web Push por celular. Solo se guarda el endpoint (no hay claves de cifrado
--     porque el aviso viaja sin contenido). Hasta 5 por cuenta. Sin acceso directo: push_subscribe y push_unsubscribe.
--   * Disparo: un trigger sobre messages y otro sobre friendships llaman con pg_net a la Edge Function push-notify, solo
--     si el destinatario tiene un celular anotado. La llamada lleva usuario, tipo y clave; nunca el texto. Si falta pg_net
--     o la configuración (private.push_configure), no pasa nada: un mensaje jamás falla por un aviso.
--   * push_claim y push_drop son solo para la service role (los usa la Edge Function): uno cada 2 minutos por conversación
--     o remitente, y 30 por hora por cuenta.
--   * media_received: lo que un amigo te mandó con la señal media-share, que hasta ahora era efímera y solo se veía con el
--     launcher abierto. social_send_signal se reemplaza con la misma firma para anotarlo (y avisar). shared_media sigue
--     siendo solo de su dueño. La URL se valida: link firmado del Storage y en la carpeta del que manda.
--   * app_inbox: lo que la app y el service worker consultan con la sesión. El texto solo viene si se lo pide.

create schema if not exists private;

-- ---------- pg_net ----------
-- Lo trae Supabase pero viene apagado. Si no se puede prender, los triggers se quedan quietos. Al activarlo, Supabase les
-- da EXECUTE sobre net.http_* a anon y authenticated (desde otro rol: postgres no se los puede sacar). No se llega desde la
-- API mientras el esquema net no se agregue a "Exposed schemas": no lo agregues.
do $$
begin
  create extension if not exists pg_net;
exception when others then
  raise notice '[0035] no se pudo activar pg_net (%): los avisos push quedan apagados', sqlstate;
end $$;

-- ---------- Tablas ----------
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  endpoint text not null unique check (char_length(endpoint) between 24 and 1024),
  label text check (char_length(label) <= 60),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user on public.push_subscriptions (user_id, last_seen_at desc);
alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from public, anon, authenticated;

-- scope: 'message:<conversación>', 'request:<usuario>', 'clip:<usuario>' o 'hour' (hits en la ventana de una hora)
create table if not exists public.push_throttle (
  user_id uuid not null references auth.users (id) on delete cascade,
  scope text not null check (char_length(scope) <= 60),
  last_at timestamptz not null default now(),
  hits integer not null default 1,
  primary key (user_id, scope)
);
alter table public.push_throttle enable row level security;
revoke all on public.push_throttle from public, anon, authenticated;

create table if not exists public.media_received (
  id uuid primary key default gen_random_uuid(),
  recipient uuid not null references auth.users (id) on delete cascade,
  sender uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('screenshot', 'clip')),
  name text not null check (char_length(name) between 1 and 120),
  url text not null check (char_length(url) <= 2000 and url ~ '^https://'),
  created_at timestamptz not null default now(),
  seen_at timestamptz,
  unique (recipient, url)
);
create index if not exists media_received_recipient on public.media_received (recipient, created_at desc);
create index if not exists media_received_sender on public.media_received (sender);
alter table public.media_received enable row level security;
revoke all on public.media_received from public, anon, authenticated;

-- ---------- Ayudantes ----------
-- https y de un servicio de Web Push conocido (Chrome y Android, Firefox, Safari, Edge). Sin usuario, puerto ni otro host.
create or replace function private.push_endpoint_ok(p_endpoint text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(char_length(p_endpoint) between 24 and 1024, false)
     and p_endpoint ~ '^https://(fcm\.googleapis\.com|([a-z0-9-]+\.)*push\.services\.mozilla\.com|([a-z0-9-]+\.)*push\.apple\.com|([a-z0-9-]+\.)*notify\.windows\.com)/[!-~]+$'
$$;

-- Link firmado del Storage (como el que arma el launcher) de una captura o un clip, en la carpeta del que lo manda.
create or replace function private.media_share_url_ok(p_url text, p_sender uuid) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(char_length(p_url) <= 2000, false)
     and p_url !~ '\.\.'
     and p_url ~ ('^https://[a-z0-9-]+\.supabase\.co/storage/v1/object/sign/(screenshots|clips)/' || p_sender::text || '/[^?#[:space:]]+\?token=[A-Za-z0-9._~-]+(&[A-Za-z0-9._~=%-]*)?$')
$$;

-- Llama a la Edge Function si hace falta. Nunca corta lo que la disparó: cualquier falla queda como advertencia.
create or replace function private.push_dispatch(p_user uuid, p_kind text, p_key text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_url text;
  v_secret text;
begin
  if not exists (select 1 from public.push_subscriptions s where s.user_id = p_user) then return; end if;
  -- Ahorra la llamada; el que decide de verdad es push_claim.
  if exists (select 1 from public.push_throttle t
              where t.user_id = p_user and t.scope = p_kind || ':' || p_key and t.last_at > now() - interval '2 minutes') then
    return;
  end if;
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then return; end if;
  select max(d.decrypted_secret) filter (where d.name = 'venus_push_url'),
         max(d.decrypted_secret) filter (where d.name = 'venus_push_secret')
    into v_url, v_secret
    from vault.decrypted_secrets d
   where d.name in ('venus_push_url', 'venus_push_secret');
  if v_url is null or v_secret is null then return; end if;
  perform net.http_post(
    url := v_url,
    body := jsonb_build_object('user', p_user, 'kind', p_kind, 'key', p_key),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-venus-push-secret', v_secret),
    timeout_milliseconds := 8000
  );
exception when others then
  raise warning '[push] no se pudo disparar el aviso (%)', sqlstate;
end $$;

-- Lo corre el dueño una vez desde el SQL Editor, con la dirección de la función y el mismo secreto de VENUS_PUSH_SECRET.
create or replace function private.push_configure(p_url text, p_secret text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if coalesce(p_url, '') !~ '^https://[a-z0-9.-]+/functions/v1/push-notify$' then raise exception 'bad_url' using errcode = '22023'; end if;
  if char_length(coalesce(p_secret, '')) < 32 then raise exception 'weak_secret' using errcode = '22023'; end if;
  select s.id into v_id from vault.secrets s where s.name = 'venus_push_url';
  if v_id is null then perform vault.create_secret(p_url, 'venus_push_url');
  else perform vault.update_secret(v_id, p_url); end if;
  v_id := null;
  select s.id into v_id from vault.secrets s where s.name = 'venus_push_secret';
  if v_id is null then perform vault.create_secret(p_secret, 'venus_push_secret');
  else perform vault.update_secret(v_id, p_secret); end if;
  return true;
end $$;

-- Anota lo que mandó un amigo y avisa. Lo que no pasa la validación sigue siendo solo la señal de siempre.
create or replace function private.media_share_note(p_sender uuid, p_recipient uuid, p_payload jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_url text := p_payload ->> 'url';
  v_kind text;
  v_name text;
  v_id uuid;
begin
  if not private.media_share_url_ok(v_url, p_sender) then return; end if;
  v_kind := case when v_url ~ '/object/sign/clips/' then 'clip' else 'screenshot' end;
  v_name := left(btrim(regexp_replace(coalesce(p_payload ->> 'name', ''), '[[:cntrl:]]', '', 'g')), 120);
  if v_name = '' then v_name := v_kind; end if;
  perform pg_advisory_xact_lock(hashtext('media-received:' || p_recipient::text));
  insert into public.media_received (recipient, sender, kind, name, url)
  values (p_recipient, p_sender, v_kind, v_name, v_url)
  on conflict (recipient, url) do nothing
  returning id into v_id;
  if v_id is null then return; end if;
  -- Tope: lo más nuevo de cada cuenta
  delete from public.media_received m
   where m.id in (select x.id from public.media_received x where x.recipient = p_recipient order by x.created_at desc, x.id offset 200);
  perform private.push_dispatch(p_recipient, 'clip', p_sender::text);
exception when others then
  raise warning '[push] no se pudo anotar lo recibido (%)', sqlstate;
end $$;

-- ---------- Disparadores ----------
create or replace function private.push_on_message() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_to uuid;
begin
  select case when c.user_lo = new.sender_id then c.user_hi else c.user_lo end into v_to
    from public.conversations c where c.id = new.conversation_id;
  if v_to is not null and v_to <> new.sender_id then
    perform private.push_dispatch(v_to, 'message', new.conversation_id::text);
  end if;
  return null;
exception when others then
  raise warning '[push] mensaje (%)', sqlstate;
  return null;
end $$;

create or replace function private.push_on_friend_request() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.push_dispatch(new.addressee, 'request', new.requester::text);
  return null;
exception when others then
  raise warning '[push] solicitud (%)', sqlstate;
  return null;
end $$;

drop trigger if exists push_on_message on public.messages;
create trigger push_on_message
  after insert on public.messages
  for each row execute function private.push_on_message();

drop trigger if exists push_on_friend_request on public.friendships;
create trigger push_on_friend_request
  after insert on public.friendships
  for each row when (new.status = 'pending') execute function private.push_on_friend_request();

-- ---------- Señal media-share ----------
-- Igual a la de 0014 (misma firma y mismos límites); lo único nuevo es la línea de media-share, después de mandarla.
create or replace function public.social_send_signal(target uuid, kind text, payload jsonb default '{}'::jsonb) returns boolean
language plpgsql security definer set search_path = '' as $
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
  if kind = 'media-share' then
    perform private.media_share_note(me, target, payload);
  end if;
  return true;
end $$;

-- ---------- RPC de la app ----------
-- Guarda el celular de quien llama. Un endpoint es de un solo navegador: si estaba en otra cuenta, pasa a esta.
create or replace function public.push_subscribe(p_endpoint text, p_label text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_label text := nullif(left(btrim(regexp_replace(coalesce(p_label, ''), '[[:cntrl:]]', '', 'g')), 60), '');
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if not private.push_endpoint_ok(p_endpoint) then raise exception 'bad_endpoint' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext('push:' || me::text));
  insert into public.push_subscriptions as s (user_id, endpoint, label)
  values (me, p_endpoint, v_label)
  on conflict (endpoint) do update
    set user_id = excluded.user_id, label = coalesce(excluded.label, s.label), last_seen_at = now();
  -- Tope de 5: se cae el que hace más que no se usa
  delete from public.push_subscriptions s
   where s.id in (select x.id from public.push_subscriptions x where x.user_id = me order by x.last_seen_at desc, x.id offset 5);
  return jsonb_build_object('ok', true, 'count', (select count(*) from public.push_subscriptions x where x.user_id = me));
end $$;

-- Borra un celular propio; el de otro no se toca.
create or replace function public.push_unsubscribe(p_endpoint text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  delete from public.push_subscriptions s where s.user_id = me and s.endpoint = p_endpoint;
  return found;
end $$;

-- Lo que está sin ver: la bandeja de la app y lo que consulta el service worker al llegar un aviso.
-- El texto del último mensaje viene solo con p_preview. Quien bloqueaste no aparece.
create or replace function public.app_inbox(p_preview boolean default false) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_messages jsonb;
  v_requests jsonb;
  v_clips jsonb;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;

  select coalesce(jsonb_agg(x.j order by x.at desc), '[]'::jsonb) into v_messages from (
    select lm.created_at as at,
           jsonb_build_object(
             'conv', c.id,
             'userId', o.other,
             'name', coalesce(nullif(btrim(p.display_name), ''), p.username),
             'unread', u.n,
             'at', lm.created_at,
             'messageId', lm.id,
             'text', case when coalesce(p_preview, false) then left(lm.body, 200) end
           ) as j
      from public.conversation_members mine
      join public.conversations c on c.id = mine.conversation_id
      cross join lateral (select case when c.user_lo = me then c.user_hi else c.user_lo end as other) o
      left join public.profiles p on p.id = o.other
      cross join lateral (
        select count(*)::int as n from public.messages m
         where m.conversation_id = c.id and m.sender_id <> me and not m.deleted and m.created_at > mine.last_read_at) u
      cross join lateral (
        select m.id, m.body, m.created_at from public.messages m
         where m.conversation_id = c.id and m.sender_id <> me and not m.deleted
         order by m.created_at desc limit 1) lm
     where mine.user_id = me and u.n > 0
       and not exists (select 1 from public.friendships b
                        where b.requester = me and b.addressee = o.other and b.status = 'blocked')
     order by lm.created_at desc
     limit 20) x;

  select coalesce(jsonb_agg(x.j order by x.at desc), '[]'::jsonb) into v_requests from (
    select f.created_at as at,
           jsonb_build_object(
             'userId', f.requester,
             'name', coalesce(nullif(btrim(p.display_name), ''), p.username),
             'at', f.created_at
           ) as j
      from public.friendships f
      left join public.profiles p on p.id = f.requester
     where f.addressee = me and f.status = 'pending'
     order by f.created_at desc
     limit 20) x;

  select coalesce(jsonb_agg(x.j order by x.at desc), '[]'::jsonb) into v_clips from (
    select r.created_at as at,
           jsonb_build_object(
             'id', r.id,
             'userId', r.sender,
             'from', coalesce(nullif(btrim(p.display_name), ''), p.username),
             'kind', r.kind,
             'name', r.name,
             'at', r.created_at
           ) as j
      from public.media_received r
      left join public.profiles p on p.id = r.sender
     where r.recipient = me and r.seen_at is null
       and not exists (select 1 from public.friendships b
                        where b.requester = me and b.addressee = r.sender and b.status = 'blocked')
     order by r.created_at desc
     limit 20) x;

  return jsonb_build_object('at', now(), 'messages', v_messages, 'requests', v_requests, 'clips', v_clips);
end $$;

-- Lo que me mandaron, de lo más nuevo a lo más viejo.
create or replace function public.media_received_list(p_before timestamptz default null, p_limit integer default 30) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_limit integer := greatest(1, least(coalesce(p_limit, 30), 60));
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(x.j order by x.at desc) from (
      select r.created_at as at,
             jsonb_build_object(
               'id', r.id,
               'userId', r.sender,
               'from', coalesce(nullif(btrim(p.display_name), ''), p.username),
               'kind', r.kind,
               'name', r.name,
               'url', r.url,
               'at', r.created_at,
               'seen', r.seen_at is not null
             ) as j
        from public.media_received r
        left join public.profiles p on p.id = r.sender
       where r.recipient = me
         and (p_before is null or r.created_at < p_before)
         and not exists (select 1 from public.friendships b
                          where b.requester = me and b.addressee = r.sender and b.status = 'blocked')
       order by r.created_at desc
       limit v_limit) x), '[]'::jsonb);
end $$;

-- Marca como visto (null: todo lo mío). Devuelve cuántos cambió.
create or replace function public.media_received_seen(p_ids uuid[] default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_n integer;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if p_ids is not null and cardinality(p_ids) > 100 then raise exception 'too_many' using errcode = '22023'; end if;
  update public.media_received r set seen_at = now()
   where r.recipient = me and r.seen_at is null and (p_ids is null or r.id = any (p_ids));
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- Lo saca de mi lista. No borra el archivo: ese es del que lo mandó.
create or replace function public.media_received_remove(p_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  delete from public.media_received r where r.id = p_id and r.recipient = me;
  return found;
end $$;

-- ---------- Solo para la Edge Function (service role) ----------
-- Decide si este aviso sale y a qué celulares. Uno cada 2 minutos por conversación o remitente y 30 por hora por cuenta.
create or replace function public.push_claim(p_user uuid, p_kind text, p_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_scope text;
  v_subs jsonb;
  v_hits integer;
begin
  if p_user is null or coalesce(p_kind, '') not in ('message', 'request', 'clip')
     or coalesce(p_key, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'bad_request' using errcode = '22023';
  end if;
  v_scope := p_kind || ':' || p_key;
  perform pg_advisory_xact_lock(hashtext('push:' || p_user::text));
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'endpoint', s.endpoint) order by s.last_seen_at desc), '[]'::jsonb) into v_subs
    from public.push_subscriptions s where s.user_id = p_user;
  if jsonb_array_length(v_subs) = 0 then
    return jsonb_build_object('allowed', false, 'reason', 'no_subscriptions');
  end if;
  if exists (select 1 from public.push_throttle t
              where t.user_id = p_user and t.scope = v_scope and t.last_at > now() - interval '2 minutes') then
    return jsonb_build_object('allowed', false, 'reason', 'throttled');
  end if;
  insert into public.push_throttle as t (user_id, scope, last_at, hits)
  values (p_user, 'hour', now(), 1)
  on conflict (user_id, scope) do update set
    hits = case when t.last_at <= now() - interval '1 hour' then 1 else t.hits + 1 end,
    last_at = case when t.last_at <= now() - interval '1 hour' then now() else t.last_at end
  returning t.hits into v_hits;
  if v_hits > 30 then
    return jsonb_build_object('allowed', false, 'reason', 'hourly');
  end if;
  insert into public.push_throttle as t (user_id, scope, last_at, hits)
  values (p_user, v_scope, now(), 1)
  on conflict (user_id, scope) do update set last_at = now(), hits = t.hits + 1;
  delete from public.push_throttle t where t.user_id = p_user and t.last_at < now() - interval '1 day';
  return jsonb_build_object('allowed', true, 'subs', v_subs);
end $$;

-- Borra los celulares que el servicio de push dio por vencidos (404 o 410).
create or replace function public.push_drop(p_ids uuid[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_n integer;
begin
  if p_ids is null then return 0; end if;
  if cardinality(p_ids) > 20 then raise exception 'too_many' using errcode = '22023'; end if;
  delete from public.push_subscriptions s where s.id = any (p_ids);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ---------- Permisos ----------
revoke all on function private.push_endpoint_ok(text) from public, anon, authenticated;
revoke all on function private.media_share_url_ok(text, uuid) from public, anon, authenticated;
revoke all on function private.push_dispatch(uuid, text, text) from public, anon, authenticated;
revoke all on function private.push_configure(text, text) from public, anon, authenticated, service_role;
revoke all on function private.media_share_note(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function private.push_on_message() from public, anon, authenticated;
revoke all on function private.push_on_friend_request() from public, anon, authenticated;

-- La reemplazada conserva los permisos de antes (solo authenticated).
revoke all on function public.social_send_signal(uuid, text, jsonb) from public, anon;
grant execute on function public.social_send_signal(uuid, text, jsonb) to authenticated;

revoke all on function public.push_subscribe(text, text) from public, anon;
revoke all on function public.push_unsubscribe(text) from public, anon;
revoke all on function public.app_inbox(boolean) from public, anon;
revoke all on function public.media_received_list(timestamptz, integer) from public, anon;
revoke all on function public.media_received_seen(uuid[]) from public, anon;
revoke all on function public.media_received_remove(uuid) from public, anon;
grant execute on function public.push_subscribe(text, text) to authenticated;
grant execute on function public.push_unsubscribe(text) to authenticated;
grant execute on function public.app_inbox(boolean) to authenticated;
grant execute on function public.media_received_list(timestamptz, integer) to authenticated;
grant execute on function public.media_received_seen(uuid[]) to authenticated;
grant execute on function public.media_received_remove(uuid) to authenticated;

revoke all on function public.push_claim(uuid, text, text) from public, anon, authenticated;
revoke all on function public.push_drop(uuid[]) from public, anon, authenticated;
grant execute on function public.push_claim(uuid, text, text) to service_role;
grant execute on function public.push_drop(uuid[]) to service_role;
