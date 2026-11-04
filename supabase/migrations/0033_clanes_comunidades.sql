-- 0033_clanes_comunidades.sql · Clanes (tag, perfil, ranking y logros propios) y comunidades con canales fijos de texto y voz.
-- Guía: docs/wip/clanes-comunidades-34.md. Se aplica después de 0027. No necesita 0031: sin sus tablas el ranking de clanes da
-- cero y lo dice (available: false); las lee con SQL dinámico. Idempotente.
--
--   * Clanes: una cuenta en un solo clan (la clave de clan_members es user_id), 50 miembros y un clan creado por cuenta mientras
--     exista. Roles: líder, oficial y miembro. Se entra por invitación a un amigo, por código o, si es abierto, con una
--     solicitud que aprueba un oficial. Si se va el último, el clan se disuelve. El líder pasa el liderazgo antes de irse; si se
--     borra su cuenta lo toma el oficial (o el miembro) más antiguo.
--   * Ranking y logros del clan: se calculan al pedirlos con miembros, antigüedad y las horas de 0031 de quienes eligieron
--     compartir (ranking_prefs.share), sin baneados. Sin puntos ni dinero. Con menos de 2 miembros compartiendo las horas dan
--     cero: Competir promete que los números de cada uno los ven solo sus amigos, y una suma de una sola persona los mostraría.
--   * Comunidades: hasta 3 por cuenta y 500 miembros; dueño, moderador y miembro. Públicas (se buscan y se entra) o por código.
--     Hasta 20 canales fijos. Expulsar deja afuera hasta que un moderador lo deshaga (community_bans). El silencio
--     (community_mutes) no depende de ser miembro: salir y volver a entrar no lo borra.
--   * Mensajes: community_messages tiene RLS de miembros (por la tabla y por Realtime) y se escribe solo con community_send:
--     30 por minuto por cuenta. El borrado es suave y vacía el texto. No están cifrados de punta a punta.
--   * Voz: community_voice_room crea a pedido una sala de 0003 y la reutiliza. La sala queda cerrada (is_locked) y cada pedido
--     invita 30 minutos a quien lo hizo, así que el código solo no alcanza: voice_join responde 'locked' a quien no es miembro.
--     El dueño de la sala es el dueño de la comunidad, porque voice_rooms.owner no admite otra cosa.
--   * Códigos: uno equivocado devuelve { error } en vez de cortar, porque cortar desharía el intento y no quedaría contado.

-- ---------- 1) Ayudantes sin tablas ----------
-- Texto de una línea: junta espacios y rechaza controles, < >, guiones suaves, marcas de dirección y de ancho cero. null si no sirve.
create or replace function private.group_line(p text) returns text
language sql immutable set search_path = '' as $$
  select case when p ~ '[\x00-\x1f\x7f<>­​-‏‪-‮⁠-⁯﻿]' then null
         else regexp_replace(btrim(p), '\s+', ' ', 'g') end
$$;

-- Texto de varias líneas: acepta saltos y emojis compuestos; rechaza controles y marcas que invierten el texto. null si no sirve.
create or replace function private.group_text(p text) returns text
language sql immutable set search_path = '' as $$
  select case when p ~ '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f‪-‮⁦-⁩]' then null
         else btrim(p, E' \t\r\n') end
$$;

-- Palabras reservadas, también escritas con números o letras cirílicas parecidas. 'mod' solo como palabra entera, para no
-- rechazar "Moderno". Misma lista en features/clans/logic.js (isReserved): si cambia acá, cambia allá.
create or replace function private.group_reserved(p text) returns boolean
language sql immutable set search_path = '' as $$
  with f as (select translate(lower(coalesce(p, '')),
                     'áàäâãéèëêíìïîóòöôõúùüûñçаеорсуіхѕ013457@$',
                     'aaaaaeeeeiiiiooooouuuuncaeopcyixsoieastas') as s),
       j as (select s, regexp_replace(s, '[^a-z0-9]+', '', 'g') as joined from f)
  select s ~ '(^|[^a-z0-9])(admin|administrador|administrator|venus|staff|mod|mods|moderador|moderadora|moderator|moderacion|oficial|official|soporte|support|owner|dueno)($|[^a-z0-9])'
      or joined ~ '^(admin|venus|staff|oficial|official|moderador|moderator|moderacion|soporte|support)'
      or joined ~ '(admin|venus|staff|oficial|official)$'
      or joined in ('mod', 'mods', 'ofi', 'ofic', 'owner', 'dueno')
    from j
$$;

create or replace function private.clan_emblems() returns text[]
language sql immutable set search_path = '' as $$
  select array['shield', 'swords', 'crown', 'flame', 'skull', 'star', 'pickaxe', 'mountain', 'moon', 'zap', 'heart', 'trophy']
$$;

-- Seis caracteres del alfabeto de las salas de voz (sin I, O, 0 ni 1).
create or replace function private.group_code() returns text
language plpgsql volatile set search_path = '' as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_bytes bytea := extensions.gen_random_bytes(6);
  v text := '';
begin
  for i in 0..5 loop
    v := v || substr(alphabet, 1 + (get_byte(v_bytes, i) % 32), 1);
  end loop;
  return v;
end $$;

-- Quien llama: con sesión y sin baneo.
create or replace function private.group_me() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if public.moderation_social_block(me) = 'user_banned' then raise exception 'user_banned' using errcode = '42501'; end if;
  return me;
end $$;

-- Quien llama y puede escribir algo que ven otros: sin baneo ni silencio.
create or replace function private.group_writer() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_block text;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  v_block := public.moderation_social_block(me);
  if v_block is not null then raise exception '%', v_block using errcode = '42501'; end if;
  return me;
end $$;

-- Límite por cuenta y tipo sobre private.social_throttle (0014). PT429 = HTTP 429 en PostgREST.
create or replace function private.group_hit(p_user uuid, p_kind text, p_limit integer, p_window interval) returns void
language plpgsql security definer set search_path = '' as $$
declare v_hits integer;
begin
  insert into private.social_throttle as t (user_id, kind, window_start, hits)
  values (p_user, p_kind, now(), 1)
  on conflict on constraint social_throttle_pkey do update set
    hits = case when t.window_start <= now() - p_window then 1 else t.hits + 1 end,
    window_start = case when t.window_start <= now() - p_window then now() else t.window_start end
  returning t.hits into v_hits;
  if v_hits > p_limit then raise exception 'rate_limited' using errcode = 'PT429'; end if;
end $$;

-- Lunes (UTC) de la semana de un instante, como la 0031.
create or replace function private.group_week(p_at timestamp) returns date
language sql immutable set search_path = '' as $$ select (date_trunc('week', p_at))::date $$;

create or replace function private.group_person(p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('userId', p.id, 'username', p.username, 'displayName', p.display_name, 'mcName', p.mc_name, 'mcUuid', p.mc_uuid)
    from public.profiles p where p.id = p_user
$$;

-- Texto de búsqueda para ILIKE, con los comodines escapados y hasta 40 caracteres.
create or replace function private.group_like(p text) returns text
language sql immutable set search_path = '' as $$
  select replace(replace(replace(left(btrim(coalesce(p, '')), 40), '\', '\\'), '%', '\%'), '_', '\_')
$$;

-- ---------- 2) Tablas ----------
create table if not exists public.clans (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 3 and 30),
  tag text not null check (tag ~ '^[A-Z0-9]{2,5}$'),
  description text not null default '' check (char_length(description) <= 300),
  color text not null default '#7c5cff' check (color ~ '^#[0-9a-f]{6}$'),
  emblem text not null default 'shield',
  is_open boolean not null default false,
  invite_code text not null unique check (invite_code ~ '^CLAN-[A-HJ-NP-Z2-9]{6}$'),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index if not exists clans_name_key on public.clans (lower(name));
create unique index if not exists clans_tag_key on public.clans (tag);
create unique index if not exists clans_created_by_key on public.clans (created_by) where created_by is not null;

create table if not exists public.clan_members (
  user_id uuid primary key references auth.users (id) on delete cascade, -- una cuenta, un clan
  clan_id uuid not null references public.clans (id) on delete cascade,
  role text not null default 'member' check (role in ('leader', 'officer', 'member')),
  joined_at timestamptz not null default now()
);
create index if not exists clan_members_clan on public.clan_members (clan_id, joined_at);
create unique index if not exists clan_members_one_leader on public.clan_members (clan_id) where role = 'leader';

create table if not exists public.clan_invites (
  clan_id uuid not null references public.clans (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (clan_id, user_id)
);
create index if not exists clan_invites_user on public.clan_invites (user_id, created_at desc);
create index if not exists clan_invites_invited_by on public.clan_invites (invited_by);

create table if not exists public.clan_requests (
  clan_id uuid not null references public.clans (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (clan_id, user_id)
);
create index if not exists clan_requests_user on public.clan_requests (user_id, created_at desc);

create table if not exists public.communities (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 3 and 40),
  description text not null default '' check (char_length(description) <= 500),
  is_public boolean not null default true,
  invite_code text not null unique check (invite_code ~ '^COM-[A-HJ-NP-Z2-9]{6}$'),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index if not exists communities_name_key on public.communities (lower(name));
create index if not exists communities_created_by on public.communities (created_by);

create table if not exists public.community_members (
  community_id uuid not null references public.communities (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'moderator', 'member')),
  joined_at timestamptz not null default now(),
  primary key (community_id, user_id)
);
create index if not exists community_members_user on public.community_members (user_id, role);
create unique index if not exists community_members_one_owner on public.community_members (community_id) where role = 'owner';

create table if not exists public.community_bans (
  community_id uuid not null references public.communities (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  banned_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (community_id, user_id)
);
create index if not exists community_bans_user on public.community_bans (user_id);
create index if not exists community_bans_banned_by on public.community_bans (banned_by);

create table if not exists public.community_mutes (
  community_id uuid not null references public.communities (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  muted_until timestamptz not null,
  primary key (community_id, user_id)
);
create index if not exists community_mutes_user on public.community_mutes (user_id);

create table if not exists public.community_channels (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities (id) on delete cascade,
  kind text not null check (kind in ('text', 'voice')),
  name text not null check (char_length(name) between 1 and 30),
  position integer not null default 0,
  voice_room_id uuid references public.voice_rooms (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists community_channels_community on public.community_channels (community_id, position);
create index if not exists community_channels_voice_room on public.community_channels (voice_room_id);

create table if not exists public.community_messages (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities (id) on delete cascade,
  channel_id uuid not null references public.community_channels (id) on delete cascade,
  author uuid not null references auth.users (id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  deleted boolean not null default false,
  deleted_by uuid references auth.users (id) on delete set null,
  constraint community_messages_length check (char_length(body) <= 2000),
  constraint community_messages_present check (deleted or char_length(btrim(body)) > 0)
);
create index if not exists community_messages_channel on public.community_messages (channel_id, created_at desc);
create index if not exists community_messages_community on public.community_messages (community_id);
create index if not exists community_messages_author on public.community_messages (author);
create index if not exists community_messages_deleted_by on public.community_messages (deleted_by);

-- Denuncias de mensajes, comunidades y clanes. snapshot guarda lo denunciado: la denuncia queda aunque después se borre.
create table if not exists public.group_reports (
  id uuid primary key default gen_random_uuid(),
  reporter uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('message', 'community', 'clan')),
  target_id uuid not null,
  community_id uuid references public.communities (id) on delete set null,
  target_user uuid references auth.users (id) on delete set null,
  snapshot jsonb not null default '{}'::jsonb check (octet_length(snapshot::text) <= 8192),
  reason text not null check (reason in ('spam', 'abuse', 'nsfw', 'other')),
  text text check (char_length(text) <= 300),
  status text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  closed_by uuid references auth.users (id) on delete set null
);
create index if not exists group_reports_status on public.group_reports (status, created_at desc);
create index if not exists group_reports_reporter on public.group_reports (reporter, created_at desc);
create index if not exists group_reports_community on public.group_reports (community_id);
create index if not exists group_reports_target_user on public.group_reports (target_user);
create index if not exists group_reports_closed_by on public.group_reports (closed_by);
create unique index if not exists group_reports_once on public.group_reports (reporter, kind, target_id) where status = 'open';

-- RLS en todas y sin acceso directo: todo pasa por las funciones de abajo, salvo leer mensajes (lo que usa Realtime).
do $$
declare t text;
begin
  foreach t in array array['clans', 'clan_members', 'clan_invites', 'clan_requests', 'communities', 'community_members', 'community_bans',
                           'community_mutes', 'community_channels', 'community_messages', 'group_reports'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

-- true si quien pregunta es miembro y no está baneado. La usa la política de mensajes: es lo que filtra también Realtime.
create or replace function private.community_is_member(p_community uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.community_members m where m.community_id = p_community and m.user_id = (select auth.uid()))
     and public.moderation_social_block((select auth.uid())) is distinct from 'user_banned'
$$;

grant select on public.community_messages to authenticated;
drop policy if exists "community_messages_select_members" on public.community_messages;
create policy "community_messages_select_members" on public.community_messages
  for select to authenticated using (private.community_is_member(community_id));

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'community_messages') then
    execute 'alter publication supabase_realtime add table public.community_messages';
  end if;
end $$;

-- ---------- 3) Clanes: ayudantes ----------
create or replace function private.clan_new_code() returns text
language plpgsql volatile security definer set search_path = '' as $$
declare v text;
begin
  loop
    v := 'CLAN-' || private.group_code();
    exit when not exists (select 1 from public.clans c where c.invite_code = v);
  end loop;
  return v;
end $$;

-- El clan de quien llama si tiene uno de esos roles; si no, corta.
create or replace function private.clan_mine(p_me uuid, p_roles text[]) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare m public.clan_members;
begin
  select * into m from public.clan_members x where x.user_id = p_me;
  if not found then raise exception 'not_in_clan' using errcode = '22023'; end if;
  if not (m.role = any (p_roles)) then raise exception 'forbidden' using errcode = '42501'; end if;
  return m.clan_id;
end $$;

create or replace function private.clan_role_of(p_clan uuid, p_user uuid) returns text
language sql stable security definer set search_path = '' as $$
  select m.role from public.clan_members m where m.clan_id = p_clan and m.user_id = p_user
$$;

create or replace function private.clan_leader_blocks(p_clan uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.clan_members l
                   join public.friendships f on f.requester = l.user_id and f.addressee = p_user and f.status = 'blocked'
                  where l.clan_id = p_clan and l.role = 'leader')
$$;

-- Lo público de un clan (tarjeta del buscador, invitaciones y panel).
create or replace function private.clan_card(p_clan uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', c.id, 'name', c.name, 'tag', c.tag, 'description', c.description, 'color', c.color, 'emblem', c.emblem,
    'isOpen', c.is_open, 'createdAt', c.created_at, 'maxMembers', 50,
    'memberCount', (select count(*) from public.clan_members m where m.clan_id = c.id))
    from public.clans c where c.id = p_clan
$$;

-- Horas compartidas: solo de quienes eligieron compartir en Competir y sin baneados.
create or replace function private.clan_shared(p_clan uuid, p_week date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_sharing integer := 0;
  v_week bigint := 0;
  v_total bigint := 0;
begin
  if to_regclass('public.ranking_weekly') is null or to_regclass('public.ranking_prefs') is null then
    return jsonb_build_object('available', false, 'sharing', 0, 'weekMinutes', 0, 'totalMinutes', 0);
  end if;
  execute $q$
    select count(*)::integer,
           coalesce(sum((select w.minutes from public.ranking_weekly w where w.user_id = m.user_id and w.week = $2)), 0)::bigint,
           coalesce(sum((select sum(w.minutes) from public.ranking_weekly w where w.user_id = m.user_id)), 0)::bigint
      from public.clan_members m
      join public.ranking_prefs p on p.user_id = m.user_id and p.share
     where m.clan_id = $1 and public.moderation_social_block(m.user_id) is distinct from 'user_banned'
  $q$ into v_sharing, v_week, v_total using p_clan, p_week;
  if v_sharing < 2 then
    v_week := 0;
    v_total := 0;
  end if;
  return jsonb_build_object('available', true, 'sharing', v_sharing, 'weekMinutes', v_week, 'totalMinutes', v_total);
end $$;

create or replace function private.clan_achievements(p_members integer, p_days integer, p_minutes bigint) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_agg(jsonb_build_object('id', a.id, 'kind', a.kind, 'goal', a.goal, 'value', a.val, 'unlocked', a.val >= a.goal) order by a.ord)
    from (values
      (1, 'members_5', 'members', 5, p_members::bigint),
      (2, 'members_20', 'members', 20, p_members::bigint),
      (3, 'members_50', 'members', 50, p_members::bigint),
      (4, 'age_30', 'days', 30, p_days::bigint),
      (5, 'age_180', 'days', 180, p_days::bigint),
      (6, 'age_365', 'days', 365, p_days::bigint),
      (7, 'hours_100', 'minutes', 6000, p_minutes),
      (8, 'hours_1000', 'minutes', 60000, p_minutes),
      (9, 'hours_5000', 'minutes', 300000, p_minutes)) a (ord, id, kind, goal, val)
$$;

-- Perfil completo del clan. El código, las solicitudes y las invitaciones solo los ve quien las maneja.
create or replace function private.clan_json(p_clan uuid, p_me uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  c public.clans;
  v_role text;
  v_staff boolean;
  v_count integer;
  v_shared jsonb;
begin
  select * into c from public.clans x where x.id = p_clan;
  if not found then return null; end if;
  v_role := (select m.role from public.clan_members m where m.clan_id = p_clan and m.user_id = p_me);
  v_staff := coalesce(v_role in ('leader', 'officer'), false);
  v_count := (select count(*) from public.clan_members m where m.clan_id = p_clan);
  v_shared := private.clan_shared(p_clan, private.group_week((now() at time zone 'UTC')::timestamp));
  return private.clan_card(p_clan) || jsonb_build_object(
    'myRole', v_role,
    'inviteCode', case when v_staff then c.invite_code end,
    'shared', v_shared,
    'requested', exists (select 1 from public.clan_requests r where r.clan_id = p_clan and r.user_id = p_me),
    'achievements', private.clan_achievements(v_count, (extract(epoch from now() - c.created_at) / 86400)::integer, (v_shared ->> 'totalMinutes')::bigint),
    'members', (select coalesce(jsonb_agg(private.group_person(m.user_id) || jsonb_build_object('role', m.role, 'joinedAt', m.joined_at)
                  order by case m.role when 'leader' then 0 when 'officer' then 1 else 2 end, m.joined_at), '[]'::jsonb)
                  from public.clan_members m where m.clan_id = p_clan),
    'requests', case when v_staff then (select coalesce(jsonb_agg(jsonb_build_object('user', private.group_person(r.user_id), 'at', r.created_at) order by r.created_at), '[]'::jsonb)
                  from public.clan_requests r where r.clan_id = p_clan) else '[]'::jsonb end,
    'invited', case when v_staff then (select coalesce(jsonb_agg(jsonb_build_object('user', private.group_person(i.user_id), 'at', i.created_at) order by i.created_at desc), '[]'::jsonb)
                  from public.clan_invites i where i.clan_id = p_clan and i.created_at > now() - interval '7 days') else '[]'::jsonb end);
end $$;

-- Suma un miembro respetando el cupo (la fila del clan queda bloqueada) y borra sus otras invitaciones y solicitudes.
create or replace function private.clan_add_member(p_clan uuid, p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.clans c where c.id = p_clan for update;
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
  if (select count(*) from public.clan_members m where m.clan_id = p_clan) >= 50 then raise exception 'clan_full' using errcode = '22023'; end if;
  begin
    insert into public.clan_members (user_id, clan_id) values (p_user, p_clan);
  exception when unique_violation then
    raise exception 'already_in_clan' using errcode = '22023';
  end;
  delete from public.clan_invites i where i.user_id = p_user;
  delete from public.clan_requests r where r.user_id = p_user;
end $$;

-- Cuando sale un miembro, por lo que sea (también si se borra la cuenta): el último disuelve el clan y sin líder lo toma el más antiguo.
create or replace function private.clan_members_after_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_next uuid;
begin
  if not exists (select 1 from public.clans c where c.id = old.clan_id) then return null; end if;
  select m.user_id into v_next from public.clan_members m where m.clan_id = old.clan_id
   order by (m.role = 'leader') desc, (m.role = 'officer') desc, m.joined_at, m.user_id limit 1;
  if v_next is null then
    delete from public.clans c where c.id = old.clan_id;
  elsif old.role = 'leader' then
    update public.clan_members m set role = 'leader' where m.user_id = v_next;
  end if;
  return null;
end $$;
drop trigger if exists clan_members_after_delete on public.clan_members;
create trigger clan_members_after_delete after delete on public.clan_members
  for each row execute function private.clan_members_after_delete();

-- ---------- 4) Clanes: RPC ----------
-- Errores (22023): bad_name, reserved_name, bad_tag, reserved_tag, bad_description, bad_color, bad_emblem, already_in_clan,
-- already_created, name_taken, tag_taken; user_banned / user_muted (42501); rate_limited (PT429: 5 por día).
create or replace function public.clan_create(p_name text, p_tag text, p_description text default '', p_color text default '#7c5cff', p_emblem text default 'shield', p_open boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.group_writer();
  v_name text := private.group_line(p_name);
  v_tag text := upper(btrim(coalesce(p_tag, '')));
  v_desc text := private.group_text(coalesce(p_description, ''));
  v_id uuid;
  v_con text;
begin
  if v_name is null or char_length(v_name) not between 3 and 30 then raise exception 'bad_name' using errcode = '22023'; end if;
  if private.group_reserved(v_name) then raise exception 'reserved_name' using errcode = '22023'; end if;
  if v_tag !~ '^[A-Z0-9]{2,5}$' then raise exception 'bad_tag' using errcode = '22023'; end if;
  if private.group_reserved(v_tag) then raise exception 'reserved_tag' using errcode = '22023'; end if;
  if v_desc is null or char_length(v_desc) > 300 then raise exception 'bad_description' using errcode = '22023'; end if;
  if coalesce(p_color, '') !~ '^#[0-9a-fA-F]{6}$' then raise exception 'bad_color' using errcode = '22023'; end if;
  if not (coalesce(p_emblem, '') = any (private.clan_emblems())) then raise exception 'bad_emblem' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext('clan-user:' || me::text));
  if exists (select 1 from public.clan_members m where m.user_id = me) then raise exception 'already_in_clan' using errcode = '22023'; end if;
  if exists (select 1 from public.clans c where c.created_by = me) then raise exception 'already_created' using errcode = '22023'; end if;
  perform private.group_hit(me, 'clan_create', 5, interval '1 day');
  begin
    insert into public.clans (name, tag, description, color, emblem, is_open, invite_code, created_by)
    values (v_name, v_tag, v_desc, lower(p_color), p_emblem, coalesce(p_open, false), private.clan_new_code(), me)
    returning id into v_id;
  exception when unique_violation then
    get stacked diagnostics v_con = constraint_name;
    raise exception '%', case v_con when 'clans_tag_key' then 'tag_taken' when 'clans_created_by_key' then 'already_created' else 'name_taken' end using errcode = '22023';
  end;
  insert into public.clan_members (user_id, clan_id, role) values (me, v_id, 'leader');
  delete from public.clan_invites i where i.user_id = me;
  delete from public.clan_requests r where r.user_id = me;
  return private.clan_json(v_id, me);
end $$;

-- Solo el líder: description, color, emblem, isOpen. El nombre y el tag no cambian.
create or replace function public.clan_update(p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.group_writer();
  v_clan uuid := private.clan_mine(me, array['leader']);
  v_desc text;
  k text;
begin
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'bad_request' using errcode = '22023'; end if;
  for k in select jsonb_object_keys(p_patch) loop
    if k not in ('description', 'color', 'emblem', 'isOpen') then raise exception 'bad_request' using errcode = '22023'; end if;
  end loop;
  if p_patch ? 'description' then
    v_desc := case when jsonb_typeof(p_patch -> 'description') = 'string' then private.group_text(p_patch ->> 'description') end;
    if v_desc is null or char_length(v_desc) > 300 then raise exception 'bad_description' using errcode = '22023'; end if;
    update public.clans c set description = v_desc where c.id = v_clan;
  end if;
  if p_patch ? 'color' then
    if jsonb_typeof(p_patch -> 'color') <> 'string' or (p_patch ->> 'color') !~ '^#[0-9a-fA-F]{6}$' then raise exception 'bad_color' using errcode = '22023'; end if;
    update public.clans c set color = lower(p_patch ->> 'color') where c.id = v_clan;
  end if;
  if p_patch ? 'emblem' then
    if jsonb_typeof(p_patch -> 'emblem') <> 'string' or not ((p_patch ->> 'emblem') = any (private.clan_emblems())) then raise exception 'bad_emblem' using errcode = '22023'; end if;
    update public.clans c set emblem = p_patch ->> 'emblem' where c.id = v_clan;
  end if;
  if p_patch ? 'isOpen' then
    if jsonb_typeof(p_patch -> 'isOpen') <> 'boolean' then raise exception 'bad_request' using errcode = '22023'; end if;
    update public.clans c set is_open = (p_patch ->> 'isOpen')::boolean where c.id = v_clan;
    if not (p_patch ->> 'isOpen')::boolean then delete from public.clan_requests r where r.clan_id = v_clan; end if;
  end if;
  return private.clan_json(v_clan, me);
end $$;

-- Lo mío: clan (o null), invitaciones que recibí y solicitudes que mandé.
create or replace function public.clan_me() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_clan uuid;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  select m.clan_id into v_clan from public.clan_members m where m.user_id = me;
  return jsonb_build_object(
    'clan', case when v_clan is not null then private.clan_json(v_clan, me) end,
    'invites', (select coalesce(jsonb_agg(jsonb_build_object('clan', private.clan_card(i.clan_id), 'invitedBy', private.group_person(i.invited_by), 'at', i.created_at) order by i.created_at desc), '[]'::jsonb)
                  from public.clan_invites i where i.user_id = me and i.created_at > now() - interval '7 days'),
    'requests', (select coalesce(jsonb_agg(jsonb_build_object('clan', private.clan_card(r.clan_id), 'at', r.created_at) order by r.created_at desc), '[]'::jsonb)
                   from public.clan_requests r where r.user_id = me));
end $$;

create or replace function public.clan_get(p_clan uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v jsonb;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  v := private.clan_json(p_clan, me);
  if v is null then raise exception 'not_found' using errcode = '22023'; end if;
  return v;
end $$;

-- Buscador: solo clanes abiertos, por nombre o tag, sin los de un líder que te bloqueó.
create or replace function public.clan_search(p_query text default '') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_q text := private.group_like(p_query);
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(private.clan_card(x.id) order by x.n desc, x.created_at), '[]'::jsonb) from (
    select c.id, c.created_at, (select count(*) from public.clan_members m where m.clan_id = c.id) as n
      from public.clans c
     where c.is_open and not private.clan_leader_blocks(c.id, me)
       and (v_q = '' or c.name ilike '%' || v_q || '%' or c.tag ilike v_q || '%')
     order by n desc, c.created_at limit 40) x);
end $$;

-- Etiqueta de hasta 100 cuentas: [{ userId, clanId, tag, name, color, emblem }]. Las cuentas sin clan no aparecen.
create or replace function public.clan_tags(p_users uuid[]) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('userId', m.user_id, 'clanId', c.id, 'tag', c.tag, 'name', c.name, 'color', c.color, 'emblem', c.emblem)), '[]'::jsonb)
            from public.clan_members m join public.clans c on c.id = m.clan_id
           where m.user_id = any ((coalesce(p_users, '{}'::uuid[]))[1:100]));
end $$;

-- Invita a un amigo. Oficial o líder; 40 por hora. Errores: not_friends, target_banned, target_in_clan, clan_full, too_many_invites.
create or replace function public.clan_invite(p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.group_writer();
  v_clan uuid := private.clan_mine(me, array['leader', 'officer']);
begin
  if p_user is null or not private.are_friends(me, p_user) then raise exception 'not_friends' using errcode = '22023'; end if;
  if public.moderation_social_block(p_user) = 'user_banned' then raise exception 'target_banned' using errcode = '22023'; end if;
  if exists (select 1 from public.clan_members m where m.user_id = p_user) then raise exception 'target_in_clan' using errcode = '22023'; end if;
  if (select count(*) from public.clan_members m where m.clan_id = v_clan) >= 50 then raise exception 'clan_full' using errcode = '22023'; end if;
  if (select count(*) from public.clan_invites i where i.clan_id = v_clan) >= 100 then raise exception 'too_many_invites' using errcode = '22023'; end if;
  perform private.group_hit(me, 'clan_invite', 40, interval '1 hour');
  insert into public.clan_invites (clan_id, user_id, invited_by) values (v_clan, p_user, me)
  on conflict (clan_id, user_id) do update set invited_by = excluded.invited_by, created_at = now();
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.clan_invite_cancel(p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_clan uuid;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  v_clan := private.clan_mine(me, array['leader', 'officer']);
  delete from public.clan_invites i where i.clan_id = v_clan and i.user_id = p_user;
  return jsonb_build_object('ok', true);
end $$;

-- Responde una invitación recibida. Errores: not_invited, invite_expired, already_in_clan, clan_full; user_banned.
create or replace function public.clan_invite_respond(p_clan uuid, p_accept boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_at timestamptz;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  select i.created_at into v_at from public.clan_invites i where i.clan_id = p_clan and i.user_id = me;
  if not found then raise exception 'not_invited' using errcode = '22023'; end if;
  if not coalesce(p_accept, false) then
    delete from public.clan_invites i where i.clan_id = p_clan and i.user_id = me;
    return jsonb_build_object('ok', true, 'joined', false);
  end if;
  perform private.group_me();
  if v_at <= now() - interval '7 days' then raise exception 'invite_expired' using errcode = '22023'; end if;
  perform private.clan_add_member(p_clan, me);
  return jsonb_build_object('ok', true, 'joined', true, 'clan', private.clan_json(p_clan, me));
end $$;

-- Pide entrar a un clan abierto. Hasta 5 pendientes por cuenta y 100 por clan. Errores: not_found, not_open, already_in_clan, too_many_requests.
create or replace function public.clan_request(p_clan uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.group_me();
  v_open boolean;
begin
  select c.is_open into v_open from public.clans c where c.id = p_clan;
  if not found or private.clan_leader_blocks(p_clan, me) then raise exception 'not_found' using errcode = '22023'; end if;
  if not v_open then raise exception 'not_open' using errcode = '22023'; end if;
  if exists (select 1 from public.clan_members m where m.user_id = me) then raise exception 'already_in_clan' using errcode = '22023'; end if;
  if exists (select 1 from public.clan_requests r where r.clan_id = p_clan and r.user_id = me) then return jsonb_build_object('ok', true); end if;
  if (select count(*) from public.clan_requests r where r.user_id = me) >= 5
     or (select count(*) from public.clan_requests r where r.clan_id = p_clan) >= 100 then
    raise exception 'too_many_requests' using errcode = '22023';
  end if;
  perform private.group_hit(me, 'clan_request', 20, interval '1 hour');
  insert into public.clan_requests (clan_id, user_id) values (p_clan, me) on conflict do nothing;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.clan_request_cancel(p_clan uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  delete from public.clan_requests r where r.clan_id = p_clan and r.user_id = me;
  return jsonb_build_object('ok', true);
end $$;

-- Aprueba o rechaza una solicitud. Oficial o líder. Errores: not_found, target_banned, already_in_clan, clan_full.
create or replace function public.clan_request_respond(p_user uuid, p_accept boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.group_me();
  v_clan uuid := private.clan_mine(me, array['leader', 'officer']);
begin
  if not exists (select 1 from public.clan_requests r where r.clan_id = v_clan and r.user_id = p_user) then raise exception 'not_found' using errcode = '22023'; end if;
  if coalesce(p_accept, false) then
    if public.moderation_social_block(p_user) = 'user_banned' then raise exception 'target_banned' using errcode = '22023'; end if;
    perform private.clan_add_member(v_clan, p_user);
  else
    delete from public.clan_requests r where r.clan_id = v_clan and r.user_id = p_user;
  end if;
  return jsonb_build_object('ok', true, 'joined', coalesce(p_accept, false));
end $$;

-- Entra con el código (CLAN-XXXXXX o solo los seis). Un código equivocado devuelve { error: 'not_found' } y queda contado: 20 cada 10 minutos.
create or replace function public.clan_join_code(p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.group_me();
  v_raw text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  v_clan uuid;
begin
  if exists (select 1 from public.clan_members m where m.user_id = me) then raise exception 'already_in_clan' using errcode = '22023'; end if;
  perform private.group_hit(me, 'clan_code', 20, interval '10 minutes');
  if v_raw ~ '^(CLAN)?[A-Z0-9]{6}$' then
    select c.id into v_clan from public.clans c where c.invite_code = 'CLAN-' || right(v_raw, 6);
  end if;
  if v_clan is null or private.clan_leader_blocks(v_clan, me) then return jsonb_build_object('error', 'not_found'); end if;
  perform private.clan_add_member(v_clan, me);
  return jsonb_build_object('ok', true, 'clan', private.clan_json(v_clan, me));
end $$;

create or replace function public.clan_regen_code() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.group_me();
  v_clan uuid := private.clan_mine(me, array['leader', 'officer']);
  v_code text := private.clan_new_code();
begin
  update public.clans c set invite_code = v_code where c.id = v_clan;
  return jsonb_build_object('inviteCode', v_code);
end $$;

-- Salir (aunque esté baneado). El líder con más gente pasa el liderazgo antes: leader_must_transfer.
create or replace function public.clan_leave() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  m public.clan_members;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  select * into m from public.clan_members x where x.user_id = me;
  if not found then raise exception 'not_in_clan' using errcode = '22023'; end if;
  if m.role = 'leader' and (select count(*) from public.clan_members x where x.clan_id = m.clan_id) > 1 then
    raise exception 'leader_must_transfer' using errcode = '22023';
  end if;
  delete from public.clan_members x where x.user_id = me;
  return jsonb_build_object('ok', true, 'dissolved', not exists (select 1 from public.clans c where c.id = m.clan_id));
end $$;

-- Expulsa: el líder a cualquiera, el oficial solo a miembros. El código cambia para que no vuelva a entrar con el mismo.
create or replace function public.clan_kick(p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.group_me();
  v_clan uuid := private.clan_mine(me, array['leader', 'officer']);
  v_mine text := private.clan_role_of(v_clan, me);
  v_target text := private.clan_role_of(v_clan, p_user);
begin
  if v_target is null then raise exception 'not_in_clan' using errcode = '22023'; end if;
  if p_user = me or v_target = 'leader' or (v_mine = 'officer' and v_target <> 'member') then raise exception 'forbidden' using errcode = '42501'; end if;
  delete from public.clan_members m where m.user_id = p_user and m.clan_id = v_clan;
  update public.clans c set invite_code = private.clan_new_code() where c.id = v_clan;
  return jsonb_build_object('ok', true);
end $$;

-- Promueve o baja a oficial. Solo el líder.
create or replace function public.clan_set_role(p_user uuid, p_role text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.group_me();
  v_clan uuid := private.clan_mine(me, array['leader']);
  v_target text := private.clan_role_of(v_clan, p_user);
begin
  if p_role not in ('officer', 'member') then raise exception 'bad_role' using errcode = '22023'; end if;
  if v_target is null then raise exception 'not_in_clan' using errcode = '22023'; end if;
  if v_target = 'leader' then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.clan_members m set role = p_role where m.user_id = p_user;
  return jsonb_build_object('ok', true);
end $$;

-- Pasa el liderazgo: quien lo deja queda de oficial.
create or replace function public.clan_transfer(p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.group_me();
  v_clan uuid := private.clan_mine(me, array['leader']);
  v_target text := private.clan_role_of(v_clan, p_user);
begin
  if v_target is null then raise exception 'not_in_clan' using errcode = '22023'; end if;
  if p_user = me then raise exception 'forbidden' using errcode = '42501'; end if;
  if public.moderation_social_block(p_user) = 'user_banned' then raise exception 'target_banned' using errcode = '22023'; end if;
  update public.clan_members m set role = 'officer' where m.user_id = me;
  update public.clan_members m set role = 'leader' where m.user_id = p_user;
  return jsonb_build_object('ok', true);
end $$;

-- Ranking de la semana (lunes UTC). Sin 0031, o sin nadie que comparta, todo da cero y available/sharing lo dicen.
-- Devuelve { week, available, rows: [{ id, name, tag, color, emblem, members, sharing, minutes, pos, mine }] (hasta 50), mine }.
create or replace function public.clan_ranking(p_week date default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_week date := private.group_week(coalesce(p_week::timestamp, (now() at time zone 'UTC')::timestamp));
  v_has boolean := to_regclass('public.ranking_weekly') is not null and to_regclass('public.ranking_prefs') is not null;
  v_totals text;
  v_rows jsonb;
  v_mine jsonb;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  v_totals := case when v_has then $s$
      select m.clan_id, count(*)::integer as sharing, case when count(*) >= 2 then coalesce(sum(w.minutes), 0) else 0 end::bigint as minutes
        from public.clan_members m
        join public.ranking_prefs p on p.user_id = m.user_id and p.share
        left join public.ranking_weekly w on w.user_id = m.user_id and w.week = $1
       where public.moderation_social_block(m.user_id) is distinct from 'user_banned'
       group by m.clan_id $s$
    else $s$ select null::uuid as clan_id, 0::integer as sharing, 0::bigint as minutes where $1 is null $s$ end;
  execute format($q$
    with t as (%s),
    base as (
      select c.id, c.name, c.tag, c.color, c.emblem, c.created_at,
             (select count(*) from public.clan_members x where x.clan_id = c.id)::integer as members,
             coalesce(t.sharing, 0) as sharing, coalesce(t.minutes, 0) as minutes,
             exists (select 1 from public.clan_members y where y.clan_id = c.id and y.user_id = $2) as mine
        from public.clans c left join t on t.clan_id = c.id),
    r as (select b.id, b.name, b.tag, b.color, b.emblem, b.members, b.sharing, b.minutes, b.mine,
                 row_number() over (order by b.minutes desc, b.members desc, b.created_at) as pos from base b)
    select (select coalesce(jsonb_agg(to_jsonb(x) order by x.pos), '[]'::jsonb) from (select * from r where r.pos <= 50) x),
           (select to_jsonb(y) from (select * from r where r.mine limit 1) y)
  $q$, v_totals) into v_rows, v_mine using v_week, me;
  return jsonb_build_object('week', v_week, 'available', v_has, 'rows', v_rows, 'mine', v_mine);
end $$;

-- ---------- 5) Comunidades: ayudantes ----------
create or replace function private.community_new_code() returns text
language plpgsql volatile security definer set search_path = '' as $$
declare v text;
begin
  loop
    v := 'COM-' || private.group_code();
    exit when not exists (select 1 from public.communities c where c.invite_code = v);
  end loop;
  return v;
end $$;

create or replace function private.community_role(p_community uuid, p_user uuid) returns text
language sql stable security definer set search_path = '' as $$
  select m.role from public.community_members m where m.community_id = p_community and m.user_id = p_user
$$;

-- El rol de quien llama si es uno de esos; si no, corta (not_member o forbidden).
create or replace function private.community_need(p_community uuid, p_me uuid, p_roles text[]) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_role text := private.community_role(p_community, p_me);
begin
  if v_role is null then raise exception 'not_member' using errcode = '42501'; end if;
  if not (v_role = any (p_roles)) then raise exception 'forbidden' using errcode = '42501'; end if;
  return v_role;
end $$;

create or replace function private.community_owner_blocks(p_community uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.community_members o
                   join public.friendships f on f.requester = o.user_id and f.addressee = p_user and f.status = 'blocked'
                  where o.community_id = p_community and o.role = 'owner')
$$;

create or replace function private.community_card(p_community uuid, p_me uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', c.id, 'name', c.name, 'description', c.description, 'isPublic', c.is_public, 'createdAt', c.created_at,
    'maxMembers', 500, 'maxChannels', 20,
    'memberCount', (select count(*) from public.community_members m where m.community_id = c.id),
    'channelCount', (select count(*) from public.community_channels x where x.community_id = c.id),
    'myRole', private.community_role(c.id, p_me))
    from public.communities c where c.id = p_community
$$;

-- Salas de voz de la comunidad: el dueño de cada sala sigue al dueño de la comunidad.
create or replace function private.community_sync_rooms(p_community uuid) returns void
language sql security definer set search_path = '' as $$
  update public.voice_rooms r set owner = o.user_id
    from public.community_channels c, public.community_members o
   where c.community_id = p_community and c.voice_room_id = r.id
     and o.community_id = p_community and o.role = 'owner' and r.owner is distinct from o.user_id
$$;

-- Saca a alguien de las salas de voz de la comunidad; con p_ban además no puede volver a entrar (ni con el código de la sala).
create or replace function private.community_voice_out(p_community uuid, p_user uuid, p_ban boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_ban then
    insert into public.voice_members (room_id, user_id, banned)
    select c.voice_room_id, p_user, true from public.community_channels c
     where c.community_id = p_community and c.voice_room_id is not null
    on conflict (room_id, user_id) do update set banned = true, last_seen = null, session_id = null, session_key = null, invited_at = null;
  else
    delete from public.voice_members m using public.community_channels c
     where c.community_id = p_community and c.voice_room_id = m.room_id and m.user_id = p_user and not m.banned;
  end if;
end $$;

-- Suma un miembro respetando el cupo, las expulsiones y los bloqueos. Hasta 100 comunidades por cuenta.
create or replace function private.community_add_member(p_community uuid, p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.communities c where c.id = p_community for update;
  if not found or private.community_owner_blocks(p_community, p_user) then raise exception 'not_found' using errcode = '22023'; end if;
  if exists (select 1 from public.community_bans b where b.community_id = p_community and b.user_id = p_user) then raise exception 'banned_here' using errcode = '22023'; end if;
  if exists (select 1 from public.community_members m where m.community_id = p_community and m.user_id = p_user) then return; end if;
  if (select count(*) from public.community_members m where m.community_id = p_community) >= 500 then raise exception 'community_full' using errcode = '22023'; end if;
  if (select count(*) from public.community_members m where m.user_id = p_user) >= 100 then raise exception 'too_many_joined' using errcode = '22023'; end if;
  insert into public.community_members (community_id, user_id) values (p_community, p_user) on conflict do nothing;
end $$;

-- Cuando sale un miembro, por lo que sea: el último borra la comunidad y sin dueño la toma el moderador (o miembro) más antiguo.
create or replace function private.community_members_after_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_next uuid;
begin
  if not exists (select 1 from public.communities c where c.id = old.community_id) then return null; end if;
  select m.user_id into v_next from public.community_members m where m.community_id = old.community_id
   order by (m.role = 'owner') desc, (m.role = 'moderator') desc, m.joined_at, m.user_id limit 1;
  if v_next is null then
    delete from public.communities c where c.id = old.community_id;
  elsif old.role = 'owner' then
    update public.community_members m set role = 'owner' where m.community_id = old.community_id and m.user_id = v_next;
    perform private.community_sync_rooms(old.community_id);
  end if;
  return null;
end $$;
drop trigger if exists community_members_after_delete on public.community_members;
create trigger community_members_after_delete after delete on public.community_members
  for each row execute function private.community_members_after_delete();

-- Un canal de voz que se borra se lleva su sala, también cuando se borra la comunidad entera.
create or replace function private.community_channels_after_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.voice_room_id is not null then delete from public.voice_rooms r where r.id = old.voice_room_id; end if;
  return null;
end $$;
drop trigger if exists community_channels_after_delete on public.community_channels;
create trigger community_channels_after_delete after delete on public.community_channels
  for each row execute function private.community_channels_after_delete();

-- Mensaje para la interfaz. El de alguien que bloqueaste llega sin texto y con hidden. Una función por fila: es una página de hasta 100.
create or replace function private.community_message_json(p_m public.community_messages, p_me uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', (p_m).id, 'channelId', (p_m).channel_id, 'communityId', (p_m).community_id, 'authorId', (p_m).author,
      'at', (p_m).created_at, 'deleted', (p_m).deleted, 'hidden', v.hidden, 'body', case when v.hidden then '' else (p_m).body end,
      'author', private.group_person((p_m).author) || jsonb_build_object('role', private.community_role((p_m).community_id, (p_m).author)))
    from (select exists (select 1 from public.friendships f where f.requester = p_me and f.addressee = (p_m).author and f.status = 'blocked') as hidden) v
$$;

-- ---------- 6) Comunidades: RPC ----------
-- Errores (22023): bad_name, reserved_name, bad_description, name_taken, too_many_communities; user_banned / user_muted (42501);
-- rate_limited (PT429: 5 por día). Arranca con un canal de texto y uno de voz.
create or replace function public.community_create(p_name text, p_description text default '', p_public boolean default true) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.group_writer();
  v_name text := private.group_line(p_name);
  v_desc text := private.group_text(coalesce(p_description, ''));
  v_id uuid;
begin
  if v_name is null or char_length(v_name) not between 3 and 40 then raise exception 'bad_name' using errcode = '22023'; end if;
  if private.group_reserved(v_name) then raise exception 'reserved_name' using errcode = '22023'; end if;
  if v_desc is null or char_length(v_desc) > 500 then raise exception 'bad_description' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext('community-user:' || me::text));
  if (select count(*) from public.community_members m where m.user_id = me and m.role = 'owner') >= 3 then raise exception 'too_many_communities' using errcode = '22023'; end if;
  if (select count(*) from public.community_members m where m.user_id = me) >= 100 then raise exception 'too_many_joined' using errcode = '22023'; end if;
  perform private.group_hit(me, 'community_create', 5, interval '1 day');
  begin
    insert into public.communities (name, description, is_public, invite_code, created_by)
    values (v_name, v_desc, coalesce(p_public, true), private.community_new_code(), me) returning id into v_id;
  exception when unique_violation then
    raise exception 'name_taken' using errcode = '22023';
  end;
  insert into public.community_members (community_id, user_id, role) values (v_id, me, 'owner');
  insert into public.community_channels (community_id, kind, name, position) values (v_id, 'text', 'general', 0), (v_id, 'voice', 'general', 1);
  return private.community_card(v_id, me);
end $$;

-- Solo el dueño: name, description, isPublic.
create or replace function public.community_update(p_community uuid, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.group_writer();
  v_text text;
  k text;
begin
  perform private.community_need(p_community, me, array['owner']);
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'bad_request' using errcode = '22023'; end if;
  for k in select jsonb_object_keys(p_patch) loop
    if k not in ('name', 'description', 'isPublic') then raise exception 'bad_request' using errcode = '22023'; end if;
  end loop;
  if p_patch ? 'name' then
    v_text := case when jsonb_typeof(p_patch -> 'name') = 'string' then private.group_line(p_patch ->> 'name') end;
    if v_text is null or char_length(v_text) not between 3 and 40 then raise exception 'bad_name' using errcode = '22023'; end if;
    if private.group_reserved(v_text) then raise exception 'reserved_name' using errcode = '22023'; end if;
    begin
      update public.communities c set name = v_text where c.id = p_community;
    exception when unique_violation then
      raise exception 'name_taken' using errcode = '22023';
    end;
  end if;
  if p_patch ? 'description' then
    v_text := case when jsonb_typeof(p_patch -> 'description') = 'string' then private.group_text(p_patch ->> 'description') end;
    if v_text is null or char_length(v_text) > 500 then raise exception 'bad_description' using errcode = '22023'; end if;
    update public.communities c set description = v_text where c.id = p_community;
  end if;
  if p_patch ? 'isPublic' then
    if jsonb_typeof(p_patch -> 'isPublic') <> 'boolean' then raise exception 'bad_request' using errcode = '22023'; end if;
    update public.communities c set is_public = (p_patch ->> 'isPublic')::boolean where c.id = p_community;
  end if;
  return private.community_card(p_community, me);
end $$;

create or replace function public.community_delete(p_community uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  perform private.community_need(p_community, me, array['owner']);
  delete from public.communities c where c.id = p_community;
  return jsonb_build_object('ok', true);
end $$;

-- Pasa la comunidad a otro miembro: quien la deja queda de moderador. Error: target_too_many (ya tiene 3).
create or replace function public.community_transfer(p_community uuid, p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := private.group_me();
begin
  perform private.community_need(p_community, me, array['owner']);
  if private.community_role(p_community, p_user) is null then raise exception 'not_member_target' using errcode = '22023'; end if;
  if p_user = me then raise exception 'forbidden' using errcode = '42501'; end if;
  if public.moderation_social_block(p_user) = 'user_banned' then raise exception 'target_banned' using errcode = '22023'; end if;
  if (select count(*) from public.community_members m where m.user_id = p_user and m.role = 'owner') >= 3 then raise exception 'target_too_many' using errcode = '22023'; end if;
  update public.community_members m set role = 'moderator' where m.community_id = p_community and m.user_id = me;
  update public.community_members m set role = 'owner' where m.community_id = p_community and m.user_id = p_user;
  delete from public.community_mutes x where x.community_id = p_community and x.user_id = p_user;
  perform private.community_sync_rooms(p_community);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.community_my() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(private.community_card(m.community_id, me) order by m.joined_at), '[]'::jsonb)
            from public.community_members m where m.user_id = me);
end $$;

-- Buscador: solo públicas, sin las que te expulsaron ni las de un dueño que te bloqueó.
create or replace function public.community_search(p_query text default '') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_q text := private.group_like(p_query);
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(private.community_card(x.id, me) order by x.n desc, x.created_at), '[]'::jsonb) from (
    select c.id, c.created_at, (select count(*) from public.community_members m where m.community_id = c.id) as n
      from public.communities c
     where c.is_public and not private.community_owner_blocks(c.id, me)
       and not exists (select 1 from public.community_bans b where b.community_id = c.id and b.user_id = me)
       and (v_q = '' or c.name ilike '%' || v_q || '%')
     order by n desc, c.created_at limit 40) x);
end $$;

-- Para miembros: canales (con quién está en cada canal de voz). Para el resto, solo la tarjeta de una pública. Por código: not_found.
create or replace function public.community_get(p_community uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := private.group_me();
  c public.communities;
  v_role text;
begin
  select * into c from public.communities x where x.id = p_community;
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
  v_role := private.community_role(p_community, me);
  if v_role is null then
    if not c.is_public or private.community_owner_blocks(p_community, me) then raise exception 'not_found' using errcode = '22023'; end if;
    return private.community_card(p_community, me)
      || jsonb_build_object('bannedHere', exists (select 1 from public.community_bans b where b.community_id = p_community and b.user_id = me));
  end if;
  return private.community_card(p_community, me) || jsonb_build_object(
    'inviteCode', case when v_role in ('owner', 'moderator') then c.invite_code end,
    'mutedUntil', (select x.muted_until from public.community_mutes x where x.community_id = p_community and x.user_id = me and x.muted_until > now()),
    'channels', (select coalesce(jsonb_agg(jsonb_build_object('id', ch.id, 'kind', ch.kind, 'name', ch.name, 'position', ch.position,
        'people', case when ch.kind = 'voice' then (select coalesce(jsonb_agg(private.group_person(v.user_id) order by v.joined_at), '[]'::jsonb)
                     from public.voice_members v where v.room_id = ch.voice_room_id and not v.banned and v.last_seen > now() - interval '75 seconds')
                   else '[]'::jsonb end) order by ch.position, ch.created_at), '[]'::jsonb)
      from public.community_channels ch where ch.community_id = p_community));
end $$;

create or replace function public.community_join(p_community uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := private.group_me();
begin
  if not exists (select 1 from public.communities c where c.id = p_community and c.is_public) then raise exception 'not_found' using errcode = '22023'; end if;
  perform private.community_add_member(p_community, me);
  return private.community_card(p_community, me);
end $$;

-- Entra con el código (COM-XXXXXX o solo los seis). Un código equivocado devuelve { error: 'not_found' } y queda contado: 20 cada 10 minutos.
create or replace function public.community_join_code(p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.group_me();
  v_raw text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  v_id uuid;
begin
  perform private.group_hit(me, 'community_code', 20, interval '10 minutes');
  if v_raw ~ '^(COM)?[A-Z0-9]{6}$' then
    select c.id into v_id from public.communities c where c.invite_code = 'COM-' || right(v_raw, 6);
  end if;
  if v_id is null or private.community_owner_blocks(v_id, me) then return jsonb_build_object('error', 'not_found'); end if;
  perform private.community_add_member(v_id, me);
  return private.community_card(v_id, me);
end $$;

create or replace function public.community_regen_code(p_community uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.group_me();
  v_code text;
begin
  perform private.community_need(p_community, me, array['owner', 'moderator']);
  v_code := private.community_new_code();
  update public.communities c set invite_code = v_code where c.id = p_community;
  return jsonb_build_object('inviteCode', v_code);
end $$;

-- Salir (aunque esté baneado). El dueño con más gente la pasa antes: owner_must_transfer. También queda afuera de las salas de voz.
create or replace function public.community_leave(p_community uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_role text;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  v_role := private.community_role(p_community, me);
  if v_role is null then raise exception 'not_member' using errcode = '42501'; end if;
  if v_role = 'owner' and (select count(*) from public.community_members m where m.community_id = p_community) > 1 then
    raise exception 'owner_must_transfer' using errcode = '22023';
  end if;
  perform private.community_voice_out(p_community, me, false);
  delete from public.community_members m where m.community_id = p_community and m.user_id = me;
  return jsonb_build_object('ok', true, 'dissolved', not exists (select 1 from public.communities c where c.id = p_community));
end $$;

-- Miembros de a 100, de mayor a menor rol. mutedUntil solo lo ve quien modera y cada uno el suyo.
create or replace function public.community_members_list(p_community uuid, p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := private.group_me();
  v_role text := private.community_need(p_community, me, array['owner', 'moderator', 'member']);
  v_staff boolean := v_role in ('owner', 'moderator');
begin
  return jsonb_build_object('total', (select count(*) from public.community_members m where m.community_id = p_community),
    'members', (select coalesce(jsonb_agg(private.group_person(x.user_id) || jsonb_build_object('role', x.role, 'joinedAt', x.joined_at,
                  'mutedUntil', case when v_staff or x.user_id = me then x.muted_until end) order by x.ord, x.joined_at), '[]'::jsonb)
      from (select m.*, case m.role when 'owner' then 0 when 'moderator' then 1 else 2 end as ord,
                   (select u.muted_until from public.community_mutes u where u.community_id = m.community_id and u.user_id = m.user_id and u.muted_until > now()) as muted_until
              from public.community_members m where m.community_id = p_community
             order by ord, m.joined_at offset greatest(coalesce(p_offset, 0), 0) limit 100) x));
end $$;

-- Roles: el dueño nombra o saca moderadores.
create or replace function public.community_set_role(p_community uuid, p_user uuid, p_role text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.group_me();
  v_target text;
begin
  perform private.community_need(p_community, me, array['owner']);
  if p_role not in ('moderator', 'member') then raise exception 'bad_role' using errcode = '22023'; end if;
  v_target := private.community_role(p_community, p_user);
  if v_target is null then raise exception 'not_member_target' using errcode = '22023'; end if;
  if v_target = 'owner' then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.community_members m set role = p_role where m.community_id = p_community and m.user_id = p_user;
  return jsonb_build_object('ok', true);
end $$;

-- Silencia de 1 minuto a 30 días (0 o null lo quita). El dueño a cualquiera; el moderador solo a miembros.
create or replace function public.community_mute(p_community uuid, p_user uuid, p_minutes integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.group_me();
  v_mine text := private.community_need(p_community, me, array['owner', 'moderator']);
  v_target text := private.community_role(p_community, p_user);
  v_until timestamptz;
begin
  if v_target is null then raise exception 'not_member_target' using errcode = '22023'; end if;
  if p_user = me or v_target = 'owner' or (v_mine = 'moderator' and v_target <> 'member') then raise exception 'forbidden' using errcode = '42501'; end if;
  if coalesce(p_minutes, 0) not between 0 and 43200 then raise exception 'bad_minutes' using errcode = '22023'; end if;
  delete from public.community_mutes x where x.community_id = p_community and (x.user_id = p_user or x.muted_until <= now());
  if coalesce(p_minutes, 0) > 0 then
    v_until := now() + make_interval(mins => p_minutes);
    insert into public.community_mutes (community_id, user_id, muted_until) values (p_community, p_user, v_until);
  end if;
  return jsonb_build_object('ok', true, 'mutedUntil', v_until);
end $$;

-- Expulsa y deja afuera (también de las salas de voz) hasta community_unban. El dueño a cualquiera; el moderador solo a miembros.
create or replace function public.community_kick(p_community uuid, p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.group_me();
  v_mine text := private.community_need(p_community, me, array['owner', 'moderator']);
  v_target text := private.community_role(p_community, p_user);
begin
  if v_target is null then raise exception 'not_member_target' using errcode = '22023'; end if;
  if p_user = me or v_target = 'owner' or (v_mine = 'moderator' and v_target <> 'member') then raise exception 'forbidden' using errcode = '42501'; end if;
  delete from public.community_members m where m.community_id = p_community and m.user_id = p_user;
  insert into public.community_bans (community_id, user_id, banned_by) values (p_community, p_user, me) on conflict do nothing;
  perform private.community_voice_out(p_community, p_user, true);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.community_unban(p_community uuid, p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := private.group_me();
begin
  perform private.community_need(p_community, me, array['owner', 'moderator']);
  delete from public.community_bans b where b.community_id = p_community and b.user_id = p_user;
  delete from public.voice_members v using public.community_channels c
   where c.community_id = p_community and c.voice_room_id = v.room_id and v.user_id = p_user and v.banned;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.community_bans_list(p_community uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := private.group_me();
begin
  perform private.community_need(p_community, me, array['owner', 'moderator']);
  return (select coalesce(jsonb_agg(private.group_person(b.user_id) || jsonb_build_object('at', b.created_at) order by b.created_at desc), '[]'::jsonb)
            from (select * from public.community_bans x where x.community_id = p_community order by x.created_at desc limit 200) b);
end $$;

-- Canales: dueño y moderadores. Hasta 20 por comunidad. Errores: bad_kind, bad_channel_name, too_many_channels, not_found, last_text_channel, bad_order.
create or replace function public.community_channel_create(p_community uuid, p_kind text, p_name text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.group_writer();
  v_name text := private.group_line(p_name);
  v_id uuid;
begin
  perform private.community_need(p_community, me, array['owner', 'moderator']);
  if p_kind not in ('text', 'voice') then raise exception 'bad_kind' using errcode = '22023'; end if;
  if v_name is null or char_length(v_name) not between 1 and 30 then raise exception 'bad_channel_name' using errcode = '22023'; end if;
  perform 1 from public.communities c where c.id = p_community for update;
  if (select count(*) from public.community_channels x where x.community_id = p_community) >= 20 then raise exception 'too_many_channels' using errcode = '22023'; end if;
  insert into public.community_channels (community_id, kind, name, position)
  values (p_community, p_kind, v_name, coalesce((select max(x.position) + 1 from public.community_channels x where x.community_id = p_community), 0))
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'kind', p_kind, 'name', v_name);
end $$;

create or replace function public.community_channel_rename(p_channel uuid, p_name text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.group_writer();
  v_name text := private.group_line(p_name);
  v_community uuid;
begin
  select c.community_id into v_community from public.community_channels c where c.id = p_channel;
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
  perform private.community_need(v_community, me, array['owner', 'moderator']);
  if v_name is null or char_length(v_name) not between 1 and 30 then raise exception 'bad_channel_name' using errcode = '22023'; end if;
  update public.community_channels c set name = v_name where c.id = p_channel;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.community_channel_delete(p_channel uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.group_me();
  ch public.community_channels;
begin
  select * into ch from public.community_channels c where c.id = p_channel;
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
  perform private.community_need(ch.community_id, me, array['owner', 'moderator']);
  if ch.kind = 'text' and (select count(*) from public.community_channels c where c.community_id = ch.community_id and c.kind = 'text') <= 1 then
    raise exception 'last_text_channel' using errcode = '22023';
  end if;
  delete from public.community_channels c where c.id = p_channel;
  return jsonb_build_object('ok', true);
end $$;

-- p_ids: todos los canales de la comunidad en el orden nuevo.
create or replace function public.community_channels_reorder(p_community uuid, p_ids uuid[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := private.group_me();
begin
  perform private.community_need(p_community, me, array['owner', 'moderator']);
  if p_ids is null or cardinality(p_ids) <> (select count(*) from public.community_channels c where c.community_id = p_community)
     or (select count(distinct i) from unnest(p_ids) i) <> cardinality(p_ids)
     or exists (select 1 from unnest(p_ids) i where not exists (select 1 from public.community_channels c where c.id = i and c.community_id = p_community)) then
    raise exception 'bad_order' using errcode = '22023';
  end if;
  update public.community_channels c set position = o.ord - 1
    from unnest(p_ids) with ordinality o (id, ord) where c.id = o.id;
  return jsonb_build_object('ok', true);
end $$;

-- Historial de un canal de texto, del más viejo al más nuevo. p_before: los anteriores a ese momento. Hasta 100 por página.
create or replace function public.community_messages_page(p_channel uuid, p_before timestamptz default null, p_limit integer default 50) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := private.group_me();
  v_community uuid;
begin
  select c.community_id into v_community from public.community_channels c where c.id = p_channel and c.kind = 'text';
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
  perform private.community_need(v_community, me, array['owner', 'moderator', 'member']);
  return (select coalesce(jsonb_agg(private.community_message_json(x, me) order by x.created_at, x.id), '[]'::jsonb)
            from public.community_messages x
           where x.id in (select m.id from public.community_messages m
                           where m.channel_id = p_channel and (p_before is null or m.created_at < p_before)
                           order by m.created_at desc, m.id desc limit least(greatest(coalesce(p_limit, 50), 1), 100)));
end $$;

-- Escribe en un canal de texto. Errores: not_found, community_muted, bad_body; not_member, user_banned, user_muted (42501); rate_limited (PT429: 30 por minuto).
create or replace function public.community_send(p_channel uuid, p_body text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.group_writer();
  v_body text := private.group_text(coalesce(p_body, ''));
  v_community uuid;
  m public.community_messages;
begin
  select c.community_id into v_community from public.community_channels c where c.id = p_channel and c.kind = 'text';
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
  if private.community_role(v_community, me) is null then raise exception 'not_member' using errcode = '42501'; end if;
  if exists (select 1 from public.community_mutes x where x.community_id = v_community and x.user_id = me and x.muted_until > now()) then
    raise exception 'community_muted' using errcode = '22023';
  end if;
  if v_body is null or v_body = '' or char_length(v_body) > 2000 then raise exception 'bad_body' using errcode = '22023'; end if;
  perform private.group_hit(me, 'community_msg', 30, interval '1 minute');
  insert into public.community_messages (community_id, channel_id, author, body) values (v_community, p_channel, me, v_body) returning * into m;
  return private.community_message_json(m, me);
end $$;

-- Borra (suave y sin texto) el propio; dueño y moderadores, el de cualquiera.
create or replace function public.community_message_delete(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.group_me();
  m public.community_messages;
  v_role text;
begin
  select * into m from public.community_messages x where x.id = p_id;
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
  v_role := private.community_need(m.community_id, me, array['owner', 'moderator', 'member']);
  if m.author <> me and v_role = 'member' then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.community_messages x set deleted = true, body = '', deleted_by = me where x.id = p_id and not x.deleted;
  return jsonb_build_object('ok', true);
end $$;

-- Sala de voz de un canal, solo para miembros: la crea si hace falta, la cierra para quien no pase por acá e invita a quien pide.
-- Devuelve { code, roomId, name, max }. Errores: not_found, voice_banned; not_member, user_banned (42501).
create or replace function public.community_voice_room(p_channel uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.group_me();
  ch public.community_channels;
  v_owner uuid;
  v_name text;
  v_code text;
  r public.voice_rooms;
begin
  select * into ch from public.community_channels c where c.id = p_channel and c.kind = 'voice' for update;
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
  perform private.community_need(ch.community_id, me, array['owner', 'moderator', 'member']);
  select m.user_id into v_owner from public.community_members m where m.community_id = ch.community_id and m.role = 'owner';
  v_name := btrim(left((select c.name from public.communities c where c.id = ch.community_id) || ' · ' || ch.name, 40));
  select * into r from public.voice_rooms x where x.id = ch.voice_room_id;
  if not found then
    loop
      v_code := private.group_code();
      exit when not exists (select 1 from public.voice_rooms x where x.code = v_code);
    end loop;
    insert into public.voice_rooms (owner, name, code, is_private, is_locked) values (v_owner, v_name, v_code, true, true) returning * into r;
    insert into public.voice_members (room_id, user_id) values (r.id, v_owner) on conflict do nothing;
    update public.community_channels c set voice_room_id = r.id where c.id = ch.id;
  else
    update public.voice_rooms x set owner = v_owner, name = v_name, is_private = true, is_locked = true where x.id = r.id returning * into r;
  end if;
  if exists (select 1 from public.voice_members v where v.room_id = r.id and v.user_id = me and v.banned) then raise exception 'voice_banned' using errcode = '22023'; end if;
  if me <> v_owner then
    insert into public.voice_members (room_id, user_id, invited_by, invited_at) values (r.id, me, v_owner, now())
    on conflict (room_id, user_id) do update set invited_by = excluded.invited_by, invited_at = excluded.invited_at;
  end if;
  -- Las salas cuentan para el tope de voice_create_room de su dueño: las que llevan una hora sin uso se borran y se recrean a pedido.
  delete from public.voice_rooms x using public.community_channels c
   where c.voice_room_id = x.id and x.owner = v_owner and c.id <> ch.id and x.last_active < now() - interval '1 hour';
  return jsonb_build_object('code', r.code, 'roomId', r.id, 'name', r.name, 'max', r.max_members);
end $$;

-- Denuncia un mensaje, una comunidad o un clan. 10 por día y una abierta por cosa. Errores: bad_kind, bad_reason, bad_text, not_found, bad_target, too_many_today; not_member.
create or replace function public.community_report(p_kind text, p_id uuid, p_reason text, p_text text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.group_me();
  v_clean text := private.group_text(coalesce(p_text, ''));
  v_community uuid;
  v_user uuid;
  v_snapshot jsonb;
  m public.community_messages;
begin
  if p_kind not in ('message', 'community', 'clan') then raise exception 'bad_kind' using errcode = '22023'; end if;
  if p_reason not in ('spam', 'abuse', 'nsfw', 'other') then raise exception 'bad_reason' using errcode = '22023'; end if;
  if v_clean is null or char_length(v_clean) > 300 then raise exception 'bad_text' using errcode = '22023'; end if;
  if p_kind = 'message' then
    select * into m from public.community_messages x where x.id = p_id and not x.deleted;
    if not found then raise exception 'not_found' using errcode = '22023'; end if;
    perform private.community_need(m.community_id, me, array['owner', 'moderator', 'member']);
    if m.author = me then raise exception 'bad_target' using errcode = '22023'; end if;
    v_community := m.community_id;
    v_user := m.author;
    v_snapshot := jsonb_build_object('body', left(m.body, 1000), 'at', m.created_at, 'channel', (select c.name from public.community_channels c where c.id = m.channel_id),
      'community', (select c.name from public.communities c where c.id = m.community_id));
  elsif p_kind = 'community' then
    select jsonb_build_object('name', c.name, 'description', c.description) into v_snapshot from public.communities c
     where c.id = p_id and (c.is_public or private.community_role(c.id, me) is not null);
    if not found then raise exception 'not_found' using errcode = '22023'; end if;
    v_community := p_id;
    v_user := (select o.user_id from public.community_members o where o.community_id = p_id and o.role = 'owner');
  else
    select jsonb_build_object('name', c.name, 'tag', c.tag, 'description', c.description) into v_snapshot from public.clans c where c.id = p_id;
    if not found then raise exception 'not_found' using errcode = '22023'; end if;
    v_user := (select l.user_id from public.clan_members l where l.clan_id = p_id and l.role = 'leader');
  end if;
  perform pg_advisory_xact_lock(hashtext('group-reports:' || me::text));
  if (select count(*) from public.group_reports r where r.reporter = me and r.created_at > now() - interval '1 day') >= 10 then
    raise exception 'too_many_today' using errcode = '22023';
  end if;
  insert into public.group_reports (reporter, kind, target_id, community_id, target_user, snapshot, reason, text)
  values (me, p_kind, p_id, v_community, v_user, v_snapshot, p_reason, nullif(v_clean, ''))
  on conflict (reporter, kind, target_id) where status = 'open' do nothing;
  return jsonb_build_object('ok', true);
end $$;

-- ---------- 7) Panel de administración (admin_guard; lo que cambia algo queda en admin_log) ----------
create or replace function public.admin_groups(p_kind text default 'clan', p_query text default '') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_q text := private.group_like(p_query);
begin
  perform public.admin_guard();
  if p_kind = 'clan' then
    return (select coalesce(jsonb_agg(private.clan_card(x.id) || jsonb_build_object(
        'leader', private.group_person((select m.user_id from public.clan_members m where m.clan_id = x.id and m.role = 'leader')),
        'reports', (select count(*) from public.group_reports r where r.kind = 'clan' and r.target_id = x.id and r.status = 'open')) order by x.created_at desc), '[]'::jsonb)
      from (select c.id, c.created_at from public.clans c
             where v_q = '' or c.name ilike '%' || v_q || '%' or c.tag ilike v_q || '%' order by c.created_at desc limit 100) x);
  elsif p_kind = 'community' then
    return (select coalesce(jsonb_agg(private.community_card(x.id, null) || jsonb_build_object(
        'owner', private.group_person((select m.user_id from public.community_members m where m.community_id = x.id and m.role = 'owner')),
        'reports', (select count(*) from public.group_reports r where r.community_id = x.id and r.status = 'open')) order by x.created_at desc), '[]'::jsonb)
      from (select c.id, c.created_at from public.communities c
             where v_q = '' or c.name ilike '%' || v_q || '%' order by c.created_at desc limit 100) x);
  end if;
  raise exception 'bad_kind' using errcode = '22023';
end $$;

-- Miembros (y canales) para revisar antes de actuar.
create or replace function public.admin_group_detail(p_kind text, p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  perform public.admin_guard();
  if p_kind = 'clan' then
    v := private.clan_card(p_id);
    if v is null then raise exception 'not_found' using errcode = '22023'; end if;
    return v || jsonb_build_object('members', (select coalesce(jsonb_agg(private.group_person(m.user_id) || jsonb_build_object('role', m.role, 'joinedAt', m.joined_at) order by m.joined_at), '[]'::jsonb)
      from public.clan_members m where m.clan_id = p_id));
  elsif p_kind = 'community' then
    v := private.community_card(p_id, null);
    if v is null then raise exception 'not_found' using errcode = '22023'; end if;
    return v || jsonb_build_object(
      'members', (select coalesce(jsonb_agg(private.group_person(m.user_id) || jsonb_build_object('role', m.role, 'joinedAt', m.joined_at) order by m.joined_at), '[]'::jsonb)
        from public.community_members m where m.community_id = p_id),
      'channels', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'kind', c.kind, 'name', c.name) order by c.position), '[]'::jsonb)
        from public.community_channels c where c.community_id = p_id));
  end if;
  raise exception 'bad_kind' using errcode = '22023';
end $$;

create or replace function public.admin_group_dissolve(p_kind text, p_id uuid, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v jsonb;
  v_user uuid;
begin
  perform public.admin_guard();
  if p_kind = 'clan' then
    v := private.clan_card(p_id);
    v_user := (select m.user_id from public.clan_members m where m.clan_id = p_id and m.role = 'leader');
    delete from public.clans c where c.id = p_id;
  elsif p_kind = 'community' then
    v := private.community_card(p_id, null);
    v_user := (select m.user_id from public.community_members m where m.community_id = p_id and m.role = 'owner');
    delete from public.communities c where c.id = p_id;
  else
    raise exception 'bad_kind' using errcode = '22023';
  end if;
  if v is null then raise exception 'not_found' using errcode = '22023'; end if;
  perform public.admin_log(me, (select u.email from auth.users u where u.id = me), case p_kind when 'clan' then 'clan.dissolve' else 'community.dissolve' end, v_user,
    jsonb_build_object('id', p_id, 'name', v ->> 'name', 'tag', v ->> 'tag', 'members', v -> 'memberCount', 'reason', left(p_reason, 200)));
  return jsonb_build_object('ok', true);
end $$;

-- Quita a alguien. De una comunidad queda afuera como con community_kick; del clan, el código cambia.
create or replace function public.admin_group_remove(p_kind text, p_id uuid, p_user uuid, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v jsonb;
  n integer;
begin
  perform public.admin_guard();
  if p_kind = 'clan' then
    v := private.clan_card(p_id);
    delete from public.clan_members m where m.clan_id = p_id and m.user_id = p_user;
    get diagnostics n = row_count;
    if n > 0 then update public.clans c set invite_code = private.clan_new_code() where c.id = p_id; end if;
  elsif p_kind = 'community' then
    v := private.community_card(p_id, null);
    delete from public.community_members m where m.community_id = p_id and m.user_id = p_user;
    get diagnostics n = row_count;
    if n > 0 and exists (select 1 from public.communities c where c.id = p_id) then
      insert into public.community_bans (community_id, user_id, banned_by) values (p_id, p_user, me) on conflict do nothing;
      perform private.community_voice_out(p_id, p_user, true);
    end if;
  else
    raise exception 'bad_kind' using errcode = '22023';
  end if;
  if v is null or n = 0 then raise exception 'not_found' using errcode = '22023'; end if;
  perform public.admin_log(me, (select u.email from auth.users u where u.id = me), case p_kind when 'clan' then 'clan.removeMember' else 'community.removeMember' end, p_user,
    jsonb_build_object('id', p_id, 'name', v ->> 'name', 'reason', left(p_reason, 200)));
  return jsonb_build_object('ok', true);
end $$;

-- Denuncias abiertas (hasta 200) y las últimas 50 cerradas.
create or replace function public.admin_group_reports() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.admin_guard();
  return (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'kind', r.kind, 'targetId', r.target_id, 'communityId', r.community_id, 'reason', r.reason, 'text', r.text,
      'status', r.status, 'snapshot', r.snapshot, 'at', r.created_at, 'closedAt', r.closed_at, 'reporter', private.group_person(r.reporter), 'targetUser', private.group_person(r.target_user))
      order by (r.status = 'open') desc, r.created_at desc), '[]'::jsonb)
    from ((select * from public.group_reports x where x.status = 'open' order by x.created_at desc limit 200)
          union all
          (select * from public.group_reports x where x.status = 'closed' order by x.created_at desc limit 50)) r);
end $$;

-- Cierra una denuncia; con p_remove borra el mensaje denunciado.
create or replace function public.admin_group_report_close(p_id uuid, p_remove boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  r public.group_reports;
  v_removed boolean := false;
begin
  perform public.admin_guard();
  select * into r from public.group_reports x where x.id = p_id;
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
  update public.group_reports x set status = 'closed', closed_at = now(), closed_by = me where x.id = p_id;
  if coalesce(p_remove, false) and r.kind = 'message' then
    update public.community_messages m set deleted = true, body = '', deleted_by = me where m.id = r.target_id and not m.deleted;
    v_removed := found;
  end if;
  perform public.admin_log(me, (select u.email from auth.users u where u.id = me), 'groupReport.close', r.target_user,
    jsonb_build_object('report', p_id, 'kind', r.kind, 'target', r.target_id, 'removed', v_removed));
  return jsonb_build_object('ok', true, 'removed', v_removed);
end $$;

-- ---------- 8) Permisos ----------
-- Por nombre para que ninguna quede afuera: las RPC solo con sesión y las internas para nadie, salvo la que evalúa la política.
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, n.nspname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where (n.nspname = 'public' and p.proname ~ '^(clan_|community_|admin_group)')
               or (n.nspname = 'private' and p.proname ~ '^(clan_|community_|group_)') loop
    if f.nspname = 'public' then
      execute format('revoke all on function %s from public, anon', f.sig);
      execute format('grant execute on function %s to authenticated', f.sig);
    else
      execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    end if;
  end loop;
end $$;
grant execute on function private.community_is_member(uuid) to authenticated;
