-- 0038: comunidades personalizables, categorías, anuncios y foros.
-- Conserva las firmas de 0033; no elimina ni cambia datos de clanes.
-- Contrato: docs/implementacion/clanes-comunidades.md y docs/wip/comunidades-46.md. Aplicar una sola vez después de 0037.
--
-- Ampliación 4.6 (la 0038 nunca se aplicó, por eso se amplía en su lugar):
--   * Roles propios por comunidad (community_roles / community_member_roles) y permisos por canal y por rol: ver, escribir,
--     enlaces y GIFs, reaccionar, entrar a voz y hablar. Dueño y moderadores saltean los permisos. El servidor los aplica en
--     RLS y en cada RPC (private.community_perms_for); is_private y posting_role son el "ver" y el "escribir" de todos.
--   * GIFs: de KLIPY (private.klipy_url, como los banners) y subidos al bucket privado community-media. Un archivo subido nace
--     pendiente y solo lo ven quien lo subió, el dueño y los administradores de Venus hasta que uno lo aprueba.
--   * Mensajes de bienvenida y de despedida configurables (community_greetings) con GIF opcional, y reacciones.

alter table public.communities
  add column theme text not null default 'default' check (theme in ('default','cozy','compact')),
  add column color text not null default '#f6b45a' check (color ~ '^#[0-9a-fA-F]{6}$'),
  add column icon text not null default 'users',
  add column banner text not null default 'none' check (banner in ('none','aurora','sunset','forest','ocean','stars')),
  add column welcome text not null default '' check (char_length(welcome) <= 2000),
  add column rules text not null default '' check (char_length(rules) <= 4000);

create table public.community_categories (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  position integer not null default 0,
  unique (id, community_id)
);
create index community_categories_order on public.community_categories(community_id, position, id);
alter table public.community_categories enable row level security;
revoke all on public.community_categories from public, anon, authenticated;
grant all on public.community_categories to service_role;

alter table public.community_channels drop constraint community_channels_kind_check;
alter table public.community_channels
  add constraint community_channels_kind_check check (kind in ('text','voice','announcement','forum')),
  add column topic text not null default '' check (char_length(topic) <= 500),
  add column icon text not null default 'hash',
  add column category_id uuid,
  add column slowmode_seconds integer not null default 0 check (slowmode_seconds between 0 and 21600),
  add column posting_role text not null default 'members' check (posting_role in ('members','staff')),
  add column is_private boolean not null default false,
  add constraint community_channels_category_fk foreign key(category_id, community_id)
    references public.community_categories(id, community_id) on delete set null (category_id),
  add constraint community_channels_publication_check check (
    (kind <> 'announcement' or posting_role = 'staff') and
    (kind <> 'voice' or (slowmode_seconds = 0 and posting_role = 'members')));
create index community_channels_category on public.community_channels(category_id);
update public.community_channels set icon = 'headphones' where kind = 'voice';
alter table public.community_messages
  add column parent_id uuid,
  add column title text,
  add constraint community_messages_id_channel unique(id, channel_id),
  add constraint community_messages_parent_fk foreign key(parent_id, channel_id)
    references public.community_messages(id, channel_id) on delete cascade,
  add constraint community_messages_title_check check (title is null or (parent_id is null and char_length(title) between 3 and 120));
create index community_messages_thread on public.community_messages(parent_id, created_at, id);
create index community_messages_topics on public.community_messages(channel_id, created_at desc, id desc) where parent_id is null;
create index community_messages_slowmode on public.community_messages(channel_id, author, created_at desc);

-- ---------- Ampliación 4.6: roles propios, permisos por canal, GIFs, reacciones y mensajes automáticos ----------
-- Permisos por canal para "todos" (los miembros sin rol propio). "Ver" es is_private y "escribir" es posting_role.
alter table public.community_channels
  add column perm_embeds boolean not null default true,
  add column perm_react boolean not null default true,
  add column perm_connect boolean not null default true,
  add column perm_speak boolean not null default true,
  add constraint community_channels_id_community unique (id, community_id);
-- Un GIF (de KLIPY o subido) o un mensaje automático de bienvenida/despedida. Un GIF solo puede ir sin texto.
alter table public.community_messages
  add column media jsonb,
  add column system text,
  add constraint community_messages_media_check check (media is null or (jsonb_typeof(media) = 'object' and octet_length(media::text) <= 1200)),
  add constraint community_messages_system_check check (system is null or system in ('join','leave'));
alter table public.community_messages drop constraint community_messages_present;
alter table public.community_messages
  add constraint community_messages_present check (deleted or char_length(btrim(body)) > 0 or media is not null);
alter table public.group_reports drop constraint group_reports_kind_check;
alter table public.group_reports add constraint group_reports_kind_check check (kind in ('message','community','clan','media'));

-- Roles propios de cada comunidad (además de dueño, moderador y miembro). Solo ordenan permisos por canal: no moderan.
create table public.community_roles (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 30),
  color text not null default '#94a3b8' check (color ~ '^#[0-9a-f]{6}$'),
  position integer not null default 0,
  created_at timestamptz not null default now(),
  unique (id, community_id)
);
create unique index community_roles_name on public.community_roles(community_id, lower(name));
create index community_roles_order on public.community_roles(community_id, position, id);
create table public.community_member_roles (
  community_id uuid not null,
  user_id uuid not null,
  role_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (community_id, user_id, role_id),
  constraint community_member_roles_member_fk foreign key (community_id, user_id)
    references public.community_members(community_id, user_id) on delete cascade,
  constraint community_member_roles_role_fk foreign key (role_id, community_id)
    references public.community_roles(id, community_id) on delete cascade
);
create index community_member_roles_role on public.community_member_roles(role_id);
-- Excepciones de un rol propio en un canal: permitir o negar un permiso. Sin fila, el rol hereda lo que dice el canal.
create table public.community_channel_perms (
  channel_id uuid not null,
  role_id uuid not null,
  community_id uuid not null,
  perm text not null check (perm in ('view','write','embeds','react','connect','speak')),
  mode text not null check (mode in ('allow','deny')),
  primary key (channel_id, role_id, perm),
  constraint community_channel_perms_channel_fk foreign key (channel_id, community_id)
    references public.community_channels(id, community_id) on delete cascade,
  constraint community_channel_perms_role_fk foreign key (role_id, community_id)
    references public.community_roles(id, community_id) on delete cascade
);
create index community_channel_perms_role on public.community_channel_perms(role_id);
create index community_channel_perms_community on public.community_channel_perms(community_id);

create table public.community_reactions (
  message_id uuid not null references public.community_messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  emoji text not null check (emoji in ('like','love','laugh','wow','sad','party','fire','eyes')),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);
create index community_reactions_user on public.community_reactions(user_id);

-- GIFs subidos por una comunidad. El archivo está en el bucket privado community-media (<comunidad>/<id>.<ext>). Nace pendiente:
-- nadie más que quien lo subió, el dueño y los administradores de Venus lo ve hasta que un administrador lo aprueba.
create table public.community_media (
  id uuid primary key,
  community_id uuid not null references public.communities(id) on delete cascade,
  uploaded_by uuid references auth.users(id) on delete set null,
  name text not null check (char_length(name) between 1 and 40),
  path text not null unique check (char_length(path) <= 120),
  mime text not null check (mime in ('image/gif','image/webp','image/png')),
  bytes integer not null check (bytes between 1 and 2097152),
  width integer not null check (width between 16 and 1024),
  height integer not null check (height between 16 and 1024),
  status text not null default 'pending' check (status in ('pending','approved','rejected','removed')),
  reject_reason text check (reject_reason is null or char_length(reject_reason) <= 200),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create index community_media_community on public.community_media(community_id, status, created_at desc);
create index community_media_queue on public.community_media(created_at) where status = 'pending';
create index community_media_uploaded_by on public.community_media(uploaded_by);
create index community_media_reviewed_by on public.community_media(reviewed_by);

-- Mensaje de bienvenida ('join') y de despedida ('leave'): texto con {usuario}, {comunidad} y {miembros}, canal y GIF opcional.
create table public.community_greetings (
  community_id uuid not null references public.communities(id) on delete cascade,
  kind text not null check (kind in ('join','leave')),
  enabled boolean not null default false,
  channel_id uuid,
  body text not null default '' check (char_length(body) <= 500),
  media jsonb check (media is null or (jsonb_typeof(media) = 'object' and octet_length(media::text) <= 1200)),
  updated_at timestamptz not null default now(),
  primary key (community_id, kind),
  constraint community_greetings_channel_fk foreign key (channel_id, community_id)
    references public.community_channels(id, community_id) on delete set null (channel_id)
);
create index community_greetings_channel on public.community_greetings(channel_id);
do $rls$
declare t text;
begin
  foreach t in array array['community_roles','community_member_roles','community_channel_perms','community_reactions','community_media','community_greetings'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $rls$;

create function private.community_icons() returns text[] language sql immutable set search_path = '' as $$
  select array['users','gamepad','star','heart','shield','flame','mountain','moon','zap','book','message-circle','headphones','megaphone','hash']
$$;
alter table public.communities add constraint communities_icon_check check (icon = any(private.community_icons()));
alter table public.community_channels add constraint community_channels_icon_check check (icon = any(private.community_icons()));

-- Auxiliares privadas: identidad, membresía y bloqueos se comprueban de nuevo en cada lectura.
create function private.community_blocked(p_a uuid, p_b uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.friendships f where f.status = 'blocked'
    and ((f.requester = p_a and f.addressee = p_b) or (f.requester = p_b and f.addressee = p_a)))
$$;
create function private.community_access(p_community uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.community_members m join auth.users u on u.id = m.user_id
    where m.community_id = p_community and m.user_id = p_user
      and u.deleted_at is null)
    and public.moderation_social_block(p_user) is distinct from 'user_banned'
    and not exists (select 1 from public.community_bans b where b.community_id = p_community and b.user_id = p_user)
    and not exists (select 1 from public.community_members o where o.community_id = p_community and o.role = 'owner'
      and private.community_blocked(o.user_id, p_user))
$$;
create or replace function private.community_need(p_community uuid, p_me uuid, p_roles text[]) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_role text := private.community_role(p_community, p_me);
begin
  if v_role is null then raise exception 'not_member' using errcode = '42501'; end if;
  if not private.community_access(p_community, p_me) or not (v_role = any(p_roles)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return v_role;
end $$;
create or replace function private.community_is_member(p_community uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.community_access(p_community, (select auth.uid()))
$$;
-- ---------- Motor de permisos por canal ----------
-- Seis permisos. Dueño y moderadores los tienen todos (saltean las reglas). Para el resto: lo que concede el canal a todos
-- (is_private, posting_role y perm_*), después las excepciones de los roles propios de esa cuenta. Si algún rol niega y otro
-- permite, gana permitir (como en Discord). Dependencias: sin "ver" no hay nada, "enlaces y GIFs" necesita "escribir" y "hablar"
-- necesita "entrar". La voz solo tiene ver, entrar y hablar; el texto, ver, escribir, enlaces y reaccionar.
create function private.community_perms() returns text[] language sql immutable set search_path = '' as $$
  select array['view','write','embeds','react','connect','speak']
$$;
create function private.community_perm_applies(p_kind text, p_perm text) returns boolean
language sql immutable set search_path = '' as $$
  select case when p_perm = 'view' then true
              when p_kind = 'voice' then p_perm in ('connect','speak')
              else p_perm in ('write','embeds','react') end
$$;
create function private.community_perm_base(p_ch public.community_channels, p_perm text) returns boolean
language sql immutable set search_path = '' as $$
  select case p_perm when 'view' then not (p_ch).is_private when 'write' then (p_ch).posting_role = 'members'
    when 'embeds' then (p_ch).perm_embeds when 'react' then (p_ch).perm_react when 'connect' then (p_ch).perm_connect
    when 'speak' then (p_ch).perm_speak else false end
$$;
create function private.community_perm_calc(p_ch public.community_channels, p_base text, p_allow text[], p_deny text[]) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare p text; raw jsonb := '{}'::jsonb; v boolean; view_ok boolean; write_ok boolean; conn_ok boolean;
begin
  foreach p in array private.community_perms() loop
    if not private.community_perm_applies(p_ch.kind, p) then v := false;
    elsif p_base in ('owner','moderator') then v := true;
    else
      v := private.community_perm_base(p_ch, p);
      if p = any(coalesce(p_deny, '{}')) then v := false; end if;
      if p = any(coalesce(p_allow, '{}')) then v := true; end if;
    end if;
    raw := raw || jsonb_build_object(p, v);
  end loop;
  view_ok := (raw->>'view')::boolean;
  write_ok := view_ok and (raw->>'write')::boolean;
  conn_ok := view_ok and (raw->>'connect')::boolean;
  return jsonb_build_object('view', view_ok, 'write', write_ok, 'embeds', write_ok and (raw->>'embeds')::boolean,
    'react', view_ok and (raw->>'react')::boolean, 'connect', conn_ok, 'speak', conn_ok and (raw->>'speak')::boolean);
end $$;
-- Lo que esa cuenta puede hacer en ese canal ahora (membresía vigente, sin baneo ni bloqueo del dueño). Una sola pasada.
create function private.community_perms_for(p_channel uuid, p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare ch public.community_channels; v_role text; v_allow text[]; v_deny text[];
begin
  select * into ch from public.community_channels where id = p_channel;
  if not found or p_user is null or not private.community_access(ch.community_id, p_user) then
    return jsonb_build_object('view', false, 'write', false, 'embeds', false, 'react', false, 'connect', false, 'speak', false);
  end if;
  v_role := private.community_role(ch.community_id, p_user);
  select coalesce(array_agg(x.perm) filter (where x.mode = 'allow'), '{}'), coalesce(array_agg(x.perm) filter (where x.mode = 'deny'), '{}')
    into v_allow, v_deny
    from public.community_channel_perms x
    join public.community_member_roles r on r.role_id = x.role_id and r.community_id = x.community_id and r.user_id = p_user
   where x.channel_id = ch.id;
  return private.community_perm_calc(ch, v_role, v_allow, v_deny);
end $$;
create function private.community_perm(p_channel uuid, p_user uuid, p_perm text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((private.community_perms_for(p_channel, p_user) ->> p_perm)::boolean, false)
$$;
create function private.community_channel_access(p_channel uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.community_perm(p_channel, p_user, 'view')
$$;
create function private.community_channel_need(p_channel uuid, p_user uuid) returns public.community_channels
language plpgsql stable security definer set search_path = '' as $$
declare ch public.community_channels;
begin
  select * into ch from public.community_channels where id = p_channel;
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
  perform private.community_need(ch.community_id, p_user, array['owner','moderator','member']);
  if not private.community_channel_access(p_channel, p_user) then raise exception 'forbidden' using errcode = '42501'; end if;
  return ch;
end $$;
-- Escribir, mandar enlaces o GIFs y reaccionar además piden no estar silenciado ni sancionado.
create function private.community_can_act(p_channel uuid, p_user uuid, p_perm text) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.community_perm(p_channel, p_user, p_perm)
    and public.moderation_social_block(p_user) is null
    and not exists (select 1 from public.community_channels c join public.community_mutes m on m.community_id = c.community_id
      where c.id = p_channel and m.user_id = p_user and m.muted_until > now())
$$;
create function private.community_can_post(p_channel uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.community_can_act(p_channel, p_user, 'write')
$$;
create function private.community_has_link(p_text text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(p_text, '') ~* '(https?://|www\.|discord\.gg/|discord(app)?\.com/invite)'
$$;
-- La política de la tabla y las RPC usan el mismo filtro, incluidos padres bloqueados en foros.
create function private.community_message_visible(p_channel uuid, p_author uuid, p_parent uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.community_channel_access(p_channel, (select auth.uid()))
    and exists (select 1 from public.community_channels c where c.id = p_channel and c.kind in ('text','announcement','forum'))
    and not private.community_blocked((select auth.uid()), p_author)
    and (p_parent is null or exists (select 1 from public.community_messages r
      where r.id = p_parent and r.channel_id = p_channel and r.parent_id is null
        and not private.community_blocked((select auth.uid()), r.author)))
$$;
drop policy community_messages_select_members on public.community_messages;
create policy community_messages_select_members on public.community_messages for select to authenticated
  using (private.community_message_visible(channel_id, author, parent_id));

-- null si esa cuenta no puede ver el canal. can: permisos del canal; canPost/canEmbed/canReact suman silencios y sanciones.
create function private.community_channel_json(p_channel uuid, p_me uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.community_channels; v_can jsonb; v_limited boolean;
begin
  select * into c from public.community_channels where id = p_channel;
  if not found then return null; end if;
  v_can := private.community_perms_for(p_channel, p_me);
  if not (v_can->>'view')::boolean then return null; end if;
  v_limited := public.moderation_social_block(p_me) is not null or exists (select 1 from public.community_mutes m
    where m.community_id = c.community_id and m.user_id = p_me and m.muted_until > now());
  return jsonb_build_object('id', c.id, 'kind', c.kind, 'name', c.name, 'position', c.position,
    'topic', c.topic, 'icon', c.icon, 'categoryId', c.category_id, 'slowmodeSeconds', c.slowmode_seconds,
    'postingRole', c.posting_role, 'isPrivate', c.is_private, 'can', v_can,
    'canPost', (v_can->>'write')::boolean and not v_limited, 'canEmbed', (v_can->>'embeds')::boolean and not v_limited,
    'canReact', (v_can->>'react')::boolean and not v_limited,
    'canConnect', (v_can->>'connect')::boolean, 'canSpeak', (v_can->>'speak')::boolean,
    'nextPostAt', case when private.community_role(c.community_id, p_me) = 'member' and c.slowmode_seconds > 0
      then (select max(m.created_at) + make_interval(secs => c.slowmode_seconds)
        from public.community_messages m where m.channel_id = c.id and m.author = p_me
        having max(m.created_at) + make_interval(secs => c.slowmode_seconds) > now()) end,
    'people', case when c.kind = 'voice' then (select coalesce(jsonb_agg(private.group_person(v.user_id) order by v.joined_at), '[]'::jsonb)
      from public.voice_members v where v.room_id = c.voice_room_id and not v.banned
        and v.last_seen > now() - interval '75 seconds' and private.community_perm(c.id, v.user_id, 'connect'))
      else '[]'::jsonb end);
end $$;
create or replace function private.community_card(p_community uuid, p_me uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', c.id, 'name', c.name, 'description', c.description, 'isPublic', c.is_public,
    'createdAt', c.created_at, 'theme', c.theme, 'color', c.color, 'icon', c.icon, 'banner', c.banner,
    'maxMembers', 500, 'maxChannels', 50, 'maxCategories', 20,
    'memberCount', (select count(*) from public.community_members m where m.community_id = c.id),
    'channelCount', (select count(*) from public.community_channels ch where ch.community_id = c.id
      and (not ch.is_private or p_me is null or private.community_perm(ch.id, p_me, 'view'))),
    'myRole', private.community_role(c.id, p_me))
  from public.communities c where c.id = p_community
$$;
create or replace function public.community_get(p_community uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := private.group_me(); c public.communities; v_role text;
begin
  select * into c from public.communities where id = p_community;
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
  v_role := private.community_role(p_community, me);
  if v_role is null then
    if not c.is_public or private.community_owner_blocks(p_community, me) then raise exception 'not_found' using errcode = '22023'; end if;
    return private.community_card(p_community, me) || jsonb_build_object('bannedHere',
      exists (select 1 from public.community_bans b where b.community_id = p_community and b.user_id = me));
  end if;
  perform private.community_need(p_community, me, array['owner','moderator','member']);
  return private.community_card(p_community, me) || jsonb_build_object('welcome', c.welcome, 'rules', c.rules,
    'inviteCode', case when v_role in ('owner','moderator') then c.invite_code end,
    'mutedUntil', (select x.muted_until from public.community_mutes x
      where x.community_id = p_community and x.user_id = me and x.muted_until > now()),
    'categories', (select coalesce(jsonb_agg(jsonb_build_object('id', k.id, 'name', k.name, 'position', k.position)
      order by k.position, k.id), '[]'::jsonb) from public.community_categories k where k.community_id = p_community),
    'roles', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name, 'color', r.color, 'position', r.position,
      'memberCount', (select count(*) from public.community_member_roles mr where mr.role_id = r.id)) order by r.position, r.id), '[]'::jsonb)
      from public.community_roles r where r.community_id = p_community),
    'myRoleIds', (select coalesce(jsonb_agg(mr.role_id), '[]'::jsonb) from public.community_member_roles mr
      where mr.community_id = p_community and mr.user_id = me),
    'maxRoles', 15,
    'greetings', case when v_role = 'owner' then private.community_greetings_json(p_community) end,
    'channels', (select coalesce(jsonb_agg(x.j order by x.position, x.created_at, x.id), '[]'::jsonb)
      from (select private.community_channel_json(ch.id, me) as j, ch.position, ch.created_at, ch.id
        from public.community_channels ch where ch.community_id = p_community) x where x.j is not null));
end $$;

create function public.community_customize(p_community uuid, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := private.group_writer(); k text; v text; c public.communities;
begin
  select * into c from public.communities where id = p_community for update;
  perform private.community_need(p_community, me, array['owner']);
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or octet_length(p_patch::text) > 20000 then
    raise exception 'bad_request' using errcode = '22023';
  end if;
  for k in select jsonb_object_keys(p_patch) loop
    if k not in ('theme','color','icon','banner','welcome','rules') or jsonb_typeof(p_patch->k) <> 'string' then
      raise exception 'bad_request' using errcode = '22023';
    end if;
    v := p_patch->>k;
    if k = 'theme' then
      if v not in ('default','cozy','compact') then raise exception 'bad_theme' using errcode = '22023'; end if;
      c.theme := v;
    elsif k = 'color' then
      if v !~ '^#[0-9a-fA-F]{6}$' then raise exception 'bad_color' using errcode = '22023'; end if;
      c.color := lower(v);
    elsif k = 'icon' then
      if not (v = any(private.community_icons())) then raise exception 'bad_icon' using errcode = '22023'; end if;
      c.icon := v;
    elsif k = 'banner' then
      if v not in ('none','aurora','sunset','forest','ocean','stars') then raise exception 'bad_banner' using errcode = '22023'; end if;
      c.banner := v;
    else
      v := private.group_text(v);
      if v is null or char_length(v) > (case when k = 'welcome' then 2000 else 4000 end) then
        raise exception '%', 'bad_' || k using errcode = '22023';
      end if;
      if k = 'welcome' then c.welcome := v; else c.rules := v; end if;
    end if;
  end loop;
  update public.communities set theme = c.theme, color = c.color, icon = c.icon,
    banner = c.banner, welcome = c.welcome, rules = c.rules where id = p_community;
  return public.community_get(p_community);
end $$;

create function public.community_category_save(p_community uuid, p_name text, p_category uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := private.group_writer(); v_name text := private.group_line(p_name); k public.community_categories;
begin
  perform 1 from public.communities where id = p_community for update;
  perform private.community_need(p_community, me, array['owner','moderator']);
  if v_name is null or char_length(v_name) not between 1 and 40 then raise exception 'bad_category_name' using errcode = '22023'; end if;
  if p_category is null then
    if (select count(*) from public.community_categories where community_id = p_community) >= 20 then raise exception 'too_many_categories' using errcode = '22023'; end if;
    insert into public.community_categories(community_id, name, position)
      values(p_community, v_name, coalesce((select max(position)+1 from public.community_categories where community_id = p_community),0)) returning * into k;
  else
    update public.community_categories set name = v_name where id = p_category and community_id = p_community returning * into k;
    if not found then raise exception 'bad_category' using errcode = '22023'; end if;
  end if;
  return jsonb_build_object('id', k.id, 'name', k.name, 'position', k.position);
end $$;
create function public.community_category_delete(p_category uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := private.group_me(); c uuid;
begin
  select community_id into c from public.community_categories where id = p_category;
  if not found then raise exception 'bad_category' using errcode = '22023'; end if;
  perform 1 from public.communities where id = c for update;
  perform private.community_need(c, me, array['owner','moderator']);
  delete from public.community_categories where id = p_category;
  return jsonb_build_object('ok', true);
end $$;
create function public.community_category_reorder(p_community uuid, p_ids uuid[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := private.group_me();
begin
  perform 1 from public.communities where id = p_community for update;
  perform private.community_need(p_community, me, array['owner','moderator']);
  if p_ids is null or cardinality(p_ids) <> (select count(*) from public.community_categories where community_id = p_community)
    or (select count(distinct x) from unnest(p_ids) x) <> cardinality(p_ids)
    or exists (select 1 from unnest(p_ids) x where not exists (select 1 from public.community_categories where id = x and community_id = p_community)) then
    raise exception 'bad_order' using errcode = '22023';
  end if;
  update public.community_categories k set position = o.n-1 from unnest(p_ids) with ordinality o(id,n) where k.id = o.id;
  return jsonb_build_object('ok', true);
end $$;

-- Canales: se conservan create/rename/delete/reorder de 0033.
create or replace function public.community_channel_create(p_community uuid, p_kind text, p_name text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := private.group_writer(); v_name text := private.group_line(p_name); v_id uuid;
begin
  perform 1 from public.communities where id = p_community for update;
  perform private.community_need(p_community, me, array['owner','moderator']);
  if p_kind is null or p_kind not in ('text','voice','announcement','forum') then raise exception 'bad_kind' using errcode = '22023'; end if;
  if v_name is null or char_length(v_name) not between 1 and 30 then raise exception 'bad_channel_name' using errcode = '22023'; end if;
  if (select count(*) from public.community_channels where community_id = p_community) >= 50 then raise exception 'too_many_channels' using errcode = '22023'; end if;
  insert into public.community_channels(community_id, kind, name, position, posting_role, icon)
    values(p_community, p_kind, v_name, coalesce((select max(position)+1 from public.community_channels where community_id = p_community),0),
      case when p_kind = 'announcement' then 'staff' else 'members' end,
      case p_kind when 'voice' then 'headphones' when 'announcement' then 'megaphone' when 'forum' then 'book' else 'hash' end)
    returning id into v_id;
  return private.community_channel_json(v_id, me);
end $$;
create function public.community_channel_configure(p_channel uuid, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := private.group_writer(); ch public.community_channels; k text; v text; cid uuid;
begin
  select community_id into cid from public.community_channels where id = p_channel;
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
  perform 1 from public.communities where id = cid for update;
  perform private.community_need(cid, me, array['owner','moderator']);
  select * into ch from public.community_channels where id = p_channel for update;
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or octet_length(p_patch::text) > 8000 then raise exception 'bad_request' using errcode = '22023'; end if;
  for k in select jsonb_object_keys(p_patch) loop
    if k not in ('name','topic','icon','categoryId','slowmodeSeconds','postingRole','isPrivate') then raise exception 'bad_request' using errcode = '22023'; end if;
    v := p_patch->>k;
    if k in ('name','topic','icon','postingRole') and jsonb_typeof(p_patch->k) <> 'string' then raise exception 'bad_request' using errcode = '22023'; end if;
    if k = 'name' then
      v := private.group_line(v);
      if v is null or char_length(v) not between 1 and 30 then raise exception 'bad_channel_name' using errcode = '22023'; end if;
      ch.name := v;
    elsif k = 'topic' then
      v := private.group_text(v);
      if v is null or char_length(v) > 500 then raise exception 'bad_topic' using errcode = '22023'; end if;
      ch.topic := v;
    elsif k = 'icon' then
      if not (v = any(private.community_icons())) then raise exception 'bad_icon' using errcode = '22023'; end if;
      ch.icon := v;
    elsif k = 'categoryId' then
      if jsonb_typeof(p_patch->k) = 'null' then ch.category_id := null;
      else
        if jsonb_typeof(p_patch->k) <> 'string' or v !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'bad_category' using errcode = '22023'; end if;
        if not exists (select 1 from public.community_categories where id = v::uuid and community_id = cid) then raise exception 'bad_category' using errcode = '22023'; end if;
        ch.category_id := v::uuid;
      end if;
    elsif k = 'slowmodeSeconds' then
      if jsonb_typeof(p_patch->k) <> 'number' or v !~ '^[0-9]{1,5}$' or v::numeric > 21600 then raise exception 'bad_slowmode' using errcode = '22023'; end if;
      ch.slowmode_seconds := v::integer;
    elsif k = 'postingRole' then
      if v not in ('members','staff') then raise exception 'bad_posting_role' using errcode = '22023'; end if;
      ch.posting_role := v;
    elsif k = 'isPrivate' then
      if jsonb_typeof(p_patch->k) <> 'boolean' then raise exception 'bad_request' using errcode = '22023'; end if;
      ch.is_private := v::boolean;
    end if;
  end loop;
  if ch.kind = 'announcement' and ch.posting_role <> 'staff' then raise exception 'bad_posting_role' using errcode = '22023'; end if;
  if ch.kind = 'voice' and (ch.posting_role <> 'members' or ch.slowmode_seconds <> 0) then raise exception 'bad_request' using errcode = '22023'; end if;
  update public.community_channels set name = ch.name, topic = ch.topic, icon = ch.icon, category_id = ch.category_id,
    slowmode_seconds = ch.slowmode_seconds, posting_role = ch.posting_role, is_private = ch.is_private where id = p_channel;
  update public.voice_rooms r set name = btrim(left((select name from public.communities where id = cid) || ' · ' || ch.name,40)),
    is_private = true, is_locked = true where r.id = ch.voice_room_id;
  return private.community_channel_json(p_channel, me);
end $$;
create function public.community_channel_create_configured(p_community uuid, p_kind text, p_name text, p_patch jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  v := public.community_channel_create(p_community, p_kind, p_name);
  return public.community_channel_configure((v->>'id')::uuid, p_patch);
end $$;
create or replace function public.community_channel_rename(p_channel uuid, p_name text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform public.community_channel_configure(p_channel, jsonb_build_object('name',p_name));
  return jsonb_build_object('ok',true);
end $$;
create or replace function public.community_channel_delete(p_channel uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := private.group_me(); cid uuid;
begin
  select community_id into cid from public.community_channels where id = p_channel;
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
  perform 1 from public.communities where id = cid for update;
  perform private.community_need(cid, me, array['owner','moderator']);
  -- Borrado definitivo pedido por el dueño: FK elimina mensajes; el trigger de 0033 elimina la sala.
  delete from public.community_channels where id = p_channel;
  return jsonb_build_object('ok',true);
end $$;
create or replace function public.community_channels_reorder(p_community uuid, p_ids uuid[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := private.group_me();
begin
  perform 1 from public.communities where id = p_community for update;
  perform private.community_need(p_community, me, array['owner','moderator']);
  if p_ids is null or cardinality(p_ids) <> (select count(*) from public.community_channels where community_id = p_community)
    or (select count(distinct x) from unnest(p_ids) x) <> cardinality(p_ids)
    or exists (select 1 from unnest(p_ids) x where not exists (select 1 from public.community_channels where id = x and community_id = p_community)) then
    raise exception 'bad_order' using errcode = '22023';
  end if;
  update public.community_channels c set position = o.n-1 from unnest(p_ids) with ordinality o(id,n) where c.id = o.id;
  return jsonb_build_object('ok',true);
end $$;

-- Publicar: candado por comunidad contra cambios de rol/configuración; por cuenta/canal para slowmode.
-- p_embeds: el mensaje lleva un enlace o un GIF y además pide el permiso "enlaces y GIFs" del canal.
create function private.community_write_channel(p_channel uuid, p_kinds text[], p_embeds boolean default false) returns public.community_channels
language plpgsql security definer set search_path = '' as $$
declare me uuid := private.group_writer(); ch public.community_channels; cid uuid; next_at timestamptz;
begin
  select community_id into cid from public.community_channels where id = p_channel;
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
  perform 1 from public.communities where id = cid for share;
  perform 1 from public.community_members where community_id = cid and user_id = me for share;
  ch := private.community_channel_need(p_channel, me);
  if not (ch.kind = any(p_kinds)) then raise exception 'bad_kind' using errcode = '22023'; end if;
  if exists (select 1 from public.community_mutes where community_id = cid and user_id = me and muted_until > now()) then
    raise exception 'community_muted' using errcode = '22023';
  end if;
  if not private.community_can_post(p_channel, me) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_embeds and not private.community_can_act(p_channel, me, 'embeds') then raise exception 'embeds_forbidden' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('community-message:' || p_channel::text || ':' || me::text,0));
  if private.community_role(cid, me) = 'member' and ch.slowmode_seconds > 0 then
    select max(created_at) + make_interval(secs => ch.slowmode_seconds) into next_at
      from public.community_messages where channel_id = p_channel and author = me;
    if next_at > clock_timestamp() then
      raise exception 'slowmode' using errcode = 'PT429', detail = jsonb_build_object('nextPostAt',next_at)::text;
    end if;
  end if;
  perform private.group_hit(me,'community_msg',30,interval '1 minute');
  return ch;
end $$;
-- Un GIF subido se muestra (y entrega su ruta) solo con el archivo aprobado de esa misma comunidad.
create function private.community_media_view(p_media jsonb, p_community uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when p_media is null then null
    when p_media->>'kind' is distinct from 'upload' then p_media
    else coalesce((select jsonb_build_object('kind','upload','id',m.id,'name',m.name,'path',m.path,'width',m.width,'height',m.height)
      from public.community_media m where m.id::text = p_media->>'id' and m.community_id = p_community and m.status = 'approved'),
      jsonb_build_object('kind','upload','id',p_media->>'id','unavailable',true)) end
$$;
create function private.community_reactions_json(p_message uuid, p_me uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('emoji', r.emoji, 'count', r.n, 'mine', r.mine) order by r.first_at, r.emoji), '[]'::jsonb)
  from (select x.emoji, count(*) as n, bool_or(x.user_id = p_me) as mine, min(x.created_at) as first_at
    from public.community_reactions x where x.message_id = p_message and not private.community_blocked(p_me, x.user_id)
    group by x.emoji) r
$$;
create or replace function private.community_message_json(p_m public.community_messages, p_me uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id',(p_m).id,'channelId',(p_m).channel_id,'communityId',(p_m).community_id,'authorId',(p_m).author,
    'at',(p_m).created_at,'deleted',(p_m).deleted,'hidden',h.hidden,'system',(p_m).system,
    'body',case when h.hidden or (p_m).deleted then '' else (p_m).body end,
    'media',case when h.hidden or (p_m).deleted then null else private.community_media_view((p_m).media,(p_m).community_id) end,
    'reactions',case when h.hidden or (p_m).deleted then '[]'::jsonb else private.community_reactions_json((p_m).id,p_me) end,
    'title',case when h.hidden or (p_m).deleted then null else (p_m).title end,'parentId',(p_m).parent_id,
    'replyCount',(select count(*) from public.community_messages r where r.parent_id = (p_m).id and not r.deleted
      and not private.community_blocked(p_me,r.author)),
    'author',private.group_person((p_m).author) || jsonb_build_object('role',private.community_role((p_m).community_id,(p_m).author)))
    from (select private.community_blocked(p_me,(p_m).author) as hidden) h
$$;
create or replace function public.community_messages_page(p_channel uuid, p_before timestamptz default null, p_limit integer default 50) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := private.group_me(); ch public.community_channels;
begin
  ch := private.community_channel_need(p_channel,me);
  if ch.kind not in ('text','announcement') then raise exception 'bad_kind' using errcode = '22023'; end if;
  return (select coalesce(jsonb_agg(private.community_message_json(m,me) order by m.created_at,m.id),'[]'::jsonb)
    from (select * from public.community_messages x where x.channel_id = p_channel and x.parent_id is null
      and (p_before is null or x.created_at < p_before) and private.community_message_visible(x.channel_id,x.author,x.parent_id)
      order by x.created_at desc,x.id desc limit least(greatest(coalesce(p_limit,50),1),100)) m);
end $$;
create or replace function public.community_send(p_channel uuid, p_body text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := private.group_writer(); ch public.community_channels; body_text text := private.group_text(coalesce(p_body,'')); m public.community_messages;
begin
  if body_text is null or char_length(body_text) not between 1 and 2000 then raise exception 'bad_body' using errcode = '22023'; end if;
  ch := private.community_write_channel(p_channel,array['text','announcement'],private.community_has_link(body_text));
  insert into public.community_messages(community_id,channel_id,author,body,created_at)
    values(ch.community_id,p_channel,me,body_text,clock_timestamp()) returning * into m;
  return private.community_message_json(m,me);
end $$;
create function public.community_forum_topics(p_channel uuid, p_before timestamptz default null, p_limit integer default 30) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := private.group_me(); ch public.community_channels;
begin
  ch := private.community_channel_need(p_channel,me);
  if ch.kind <> 'forum' then raise exception 'bad_kind' using errcode = '22023'; end if;
  return (select coalesce(jsonb_agg(private.community_message_json(m,me) order by m.created_at desc,m.id desc),'[]'::jsonb)
    from (select * from public.community_messages x where x.channel_id = p_channel and x.parent_id is null
      and (p_before is null or x.created_at < p_before) and private.community_message_visible(x.channel_id,x.author,x.parent_id)
      order by x.created_at desc,x.id desc limit least(greatest(coalesce(p_limit,30),1),100)) m);
end $$;
create function public.community_forum_topic_create(p_channel uuid, p_title text, p_body text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := private.group_writer(); ch public.community_channels; m public.community_messages;
  title_text text := private.group_line(p_title); body_text text := private.group_text(coalesce(p_body,''));
begin
  if title_text is null or char_length(title_text) not between 3 and 120 then raise exception 'bad_title' using errcode = '22023'; end if;
  if body_text is null or char_length(body_text) not between 1 and 2000 then raise exception 'bad_body' using errcode = '22023'; end if;
  ch := private.community_write_channel(p_channel,array['forum'],private.community_has_link(title_text || ' ' || body_text));
  insert into public.community_messages(community_id,channel_id,author,title,body,created_at)
    values(ch.community_id,p_channel,me,title_text,body_text,clock_timestamp()) returning * into m;
  return private.community_message_json(m,me);
end $$;
create function public.community_forum_replies(p_topic uuid, p_before timestamptz default null, p_limit integer default 50) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := private.group_me(); root public.community_messages; ch public.community_channels;
begin
  select * into root from public.community_messages where id = p_topic and parent_id is null;
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
  ch := private.community_channel_need(root.channel_id,me);
  if ch.kind <> 'forum' then raise exception 'bad_kind' using errcode = '22023'; end if;
  if not private.community_message_visible(root.channel_id,root.author,null) then raise exception 'not_found' using errcode = '22023'; end if;
  if root.deleted then raise exception 'thread_deleted' using errcode = '22023'; end if;
  return (select coalesce(jsonb_agg(private.community_message_json(m,me) order by m.created_at,m.id),'[]'::jsonb)
    from (select * from public.community_messages x where x.parent_id = p_topic
      and (p_before is null or x.created_at < p_before) and private.community_message_visible(x.channel_id,x.author,x.parent_id)
      order by x.created_at desc,x.id desc limit least(greatest(coalesce(p_limit,50),1),100)) m);
end $$;
create function public.community_forum_reply(p_topic uuid, p_body text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := private.group_writer(); root public.community_messages; ch public.community_channels; m public.community_messages;
  body_text text := private.group_text(coalesce(p_body,''));
begin
  if body_text is null or char_length(body_text) not between 1 and 2000 then raise exception 'bad_body' using errcode = '22023'; end if;
  select * into root from public.community_messages where id = p_topic and parent_id is null;
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
  ch := private.community_write_channel(root.channel_id,array['forum'],private.community_has_link(body_text));
  -- Mismo orden que borrar: comunidad antes de fila del tema. Impide respuestas posteriores al borrado.
  select * into root from public.community_messages where id = p_topic for update;
  if not found or root.deleted then raise exception 'thread_deleted' using errcode = '22023'; end if;
  if not private.community_message_visible(root.channel_id,root.author,null) then raise exception 'not_found' using errcode = '22023'; end if;
  insert into public.community_messages(community_id,channel_id,author,body,parent_id,created_at)
    values(ch.community_id,ch.id,me,body_text,root.id,clock_timestamp()) returning * into m;
  return private.community_message_json(m,me);
end $$;
create or replace function public.community_message_delete(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := private.group_me(); m public.community_messages; ch public.community_channels; v_role text;
begin
  select * into m from public.community_messages where id = p_id;
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
  perform 1 from public.communities where id = m.community_id for share;
  ch := private.community_channel_need(m.channel_id,me);
  v_role := private.community_role(m.community_id,me);
  -- Los mensajes automáticos de bienvenida y despedida los borra solo el equipo.
  if (m.author <> me or m.system is not null) and v_role = 'member' then raise exception 'forbidden' using errcode = '42501'; end if;
  perform 1 from public.community_messages where id = p_id for update;
  update public.community_messages set deleted = true, body = '', title = null, media = null, deleted_by = me
    where id = p_id and not deleted;
  return jsonb_build_object('ok',true);
end $$;

-- Integridad por tipo y borrado suave de hilos, también al moderar desde Administración.
create function private.community_message_shape() returns trigger
language plpgsql security definer set search_path = '' as $$
declare ch public.community_channels; root public.community_messages;
begin
  select * into ch from public.community_channels where id = new.channel_id;
  if not found or ch.community_id <> new.community_id then raise exception 'bad_request' using errcode = '22023'; end if;
  if new.deleted then new.body := ''; new.title := null; new.media := null; end if;
  if ch.kind = 'voice' then raise exception 'bad_kind' using errcode = '22023'; end if;
  if ch.kind in ('text','announcement') and (new.parent_id is not null or new.title is not null) then raise exception 'bad_kind' using errcode = '22023'; end if;
  -- GIFs y mensajes automáticos solo en canales de texto y de anuncios, nunca en foros ni en respuestas.
  if (new.media is not null or new.system is not null) and (ch.kind not in ('text','announcement') or new.parent_id is not null) then
    raise exception 'bad_kind' using errcode = '22023';
  end if;
  if ch.kind = 'forum' then
    if new.parent_id is null then
      if not new.deleted and (new.title is null or char_length(new.title) not between 3 and 120) then raise exception 'bad_title' using errcode = '22023'; end if;
    else
      select * into root from public.community_messages where id = new.parent_id and channel_id = new.channel_id for key share;
      if not found or root.parent_id is not null then raise exception 'not_found' using errcode = '22023'; end if;
      if root.deleted and not new.deleted then raise exception 'thread_deleted' using errcode = '22023'; end if;
      if new.title is not null then raise exception 'bad_title' using errcode = '22023'; end if;
    end if;
  end if;
  return new;
end $$;
create trigger community_message_shape before insert or update on public.community_messages
  for each row execute function private.community_message_shape();
create function private.community_thread_deleted() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.deleted and not old.deleted and new.parent_id is null then
    update public.community_messages set deleted = true, body = '', title = null, deleted_by = new.deleted_by
      where parent_id = new.id and not deleted;
  end if;
  return null;
end $$;
create trigger community_thread_deleted after update of deleted on public.community_messages
  for each row execute function private.community_thread_deleted();

-- Una sala normal no cambia. Una sala de comunidad exige membresía y acceso al canal en cada vía.
create function private.community_voice_access(p_room uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select not exists (select 1 from public.community_channels c where c.voice_room_id = p_room)
    or exists (select 1 from public.community_channels c where c.voice_room_id = p_room and c.kind = 'voice'
      and private.community_perm(c.id,p_user,'connect'))
$$;
-- "Hablar": el servidor no entrega la clave de sesión de quien no puede hablar en una sala de comunidad (ver voice_member_keys),
-- así que los demás clientes no pueden verificar ni aceptar su audio. Escucha, pero no lo oyen.
create function private.community_voice_speaks(p_room uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select not exists (select 1 from public.community_channels c where c.voice_room_id = p_room)
    or exists (select 1 from public.community_channels c where c.voice_room_id = p_room and c.kind = 'voice'
      and private.community_perm(c.id,p_user,'speak'))
$$;
create function private.community_voice_visible(p_room uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.community_voice_access(p_room,(select auth.uid()))
$$;
create policy community_voice_rooms_select on public.voice_rooms as restrictive for select to authenticated
  using (private.community_voice_visible(id));
create policy community_voice_members_select on public.voice_members as restrictive for select to authenticated
  using (private.community_voice_visible(room_id));

-- Quitar el rol staff, salir o hacer privado un canal revoca admisión y sesión previas.
create function private.community_members_voice_cleanup() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.voice_members v using public.community_channels c
    where c.community_id = old.community_id and c.voice_room_id = v.room_id and v.user_id = old.user_id
      and not private.community_perm(c.id,old.user_id,'connect') and not v.banned;
  return null;
end $$;
create trigger community_members_voice_cleanup after update of role or delete on public.community_members
  for each row execute function private.community_members_voice_cleanup();
-- Un rol propio que se asigna, se quita o cambia sus permisos también revoca las admisiones de voz que ya no correspondan.
create function private.community_voice_revalidate(p_community uuid, p_user uuid default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.voice_members v using public.community_channels c
    where c.community_id = p_community and c.voice_room_id = v.room_id and not v.banned
      and (p_user is null or v.user_id = p_user)
      and not private.community_perm(c.id,v.user_id,'connect');
end $$;
create function private.community_perms_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare cid uuid; uid uuid;
begin
  if tg_op = 'DELETE' then cid := old.community_id; else cid := new.community_id; end if;
  if tg_table_name = 'community_member_roles' then
    if tg_op = 'DELETE' then uid := old.user_id; else uid := new.user_id; end if;
  end if;
  perform private.community_voice_revalidate(cid, uid);
  return null;
end $$;
create trigger community_member_roles_voice after insert or delete on public.community_member_roles
  for each row execute function private.community_perms_changed();
create trigger community_channel_perms_voice after insert or update or delete on public.community_channel_perms
  for each row execute function private.community_perms_changed();
create function private.community_channel_voice_cleanup() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.voice_room_id is not null then
    delete from public.voice_members v where v.room_id = new.voice_room_id and not v.banned
      and not private.community_perm(new.id,v.user_id,'connect');
  end if;
  return null;
end $$;
create trigger community_channel_voice_cleanup after update of is_private, perm_connect on public.community_channels
  for each row execute function private.community_channel_voice_cleanup();
-- Cierra también altas/latidos a través de las RPC de voz preexistentes; no afecta salas independientes.
create function private.community_voice_member_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare cid uuid;
begin
  select community_id into cid from public.community_channels where voice_room_id = new.room_id;
  if cid is not null and not new.banned and (new.last_seen is not null or new.invited_at is not null) then
    perform 1 from public.communities where id = cid for share;
    if not private.community_voice_access(new.room_id,new.user_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  end if;
  return new;
end $$;
create trigger community_voice_member_guard before insert or update on public.voice_members
  for each row execute function private.community_voice_member_guard();

create or replace function private.voice_is_member(p_room uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.community_voice_access(p_room,(select auth.uid())) and (
    private.voice_is_owner(p_room) or exists (select 1 from public.voice_members m join public.voice_rooms r on r.id = m.room_id
      where m.room_id = p_room and m.user_id = (select auth.uid()) and not m.banned
        and not exists (select 1 from public.friendships f where f.requester = r.owner and f.addressee = m.user_id and f.status = 'blocked')))
$$;

-- Contratos de voz de 0003/0014 conservados; solo se agrega la barrera de comunidad.
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
  perform 1 from public.communities c join public.community_channels x on x.community_id = c.id where x.id = p_channel for share of c;
  select * into ch from public.community_channels c where c.id = p_channel and c.kind = 'voice' for update;
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
  perform private.community_channel_need(p_channel, me);
  if not private.community_perm(p_channel, me, 'connect') then raise exception 'voice_forbidden' using errcode = '42501'; end if;
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
  return jsonb_build_object('code', r.code, 'roomId', r.id, 'name', r.name, 'max', r.max_members,
    'canSpeak', private.community_perm(p_channel, me, 'speak'));
end $$;

create or replace function public.community_report(p_kind text, p_id uuid, p_reason text, p_text text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.group_me();
  v_clean text := private.group_text(coalesce(p_text, ''));
  v_community uuid;
  v_user uuid;
  v_snapshot jsonb;
  m public.community_messages;
  md public.community_media;
begin
  if p_kind not in ('message', 'community', 'clan', 'media') then raise exception 'bad_kind' using errcode = '22023'; end if;
  if p_reason not in ('spam', 'abuse', 'nsfw', 'other') then raise exception 'bad_reason' using errcode = '22023'; end if;
  if v_clean is null or char_length(v_clean) > 300 then raise exception 'bad_text' using errcode = '22023'; end if;
  if p_kind = 'message' then
    select * into m from public.community_messages x where x.id = p_id and not x.deleted;
    if not found then raise exception 'not_found' using errcode = '22023'; end if;
    perform private.community_channel_need(m.channel_id, me);
    if not private.community_message_visible(m.channel_id,m.author,m.parent_id) then raise exception 'not_found' using errcode = '22023'; end if;
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
  elsif p_kind = 'media' then
    -- Solo se denuncia un GIF ya aprobado y solo desde dentro de su comunidad: lo pendiente no lo ve nadie más.
    select * into md from public.community_media x where x.id = p_id and x.status = 'approved';
    if not found or not private.community_access(md.community_id, me) then raise exception 'not_found' using errcode = '22023'; end if;
    if md.uploaded_by = me then raise exception 'bad_target' using errcode = '22023'; end if;
    v_community := md.community_id;
    v_user := md.uploaded_by;
    v_snapshot := jsonb_build_object('name', md.name, 'path', md.path, 'mime', md.mime, 'width', md.width, 'height', md.height,
      'community', (select c.name from public.communities c where c.id = md.community_id));
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

create or replace function private.voice_can_use_topic(p_topic text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(p_topic, '') like 'voice:%'
     and exists (
       select 1 from public.voice_rooms r
        where r.code = substr(p_topic, 7)
          and private.community_voice_access(r.id,(select auth.uid()))
          and (r.owner = (select auth.uid())
               or (exists (select 1 from public.voice_members m
                            where m.room_id = r.id and m.user_id = (select auth.uid()) and not m.banned
                              and m.last_seen > now() - interval '75 seconds')
                   and not exists (select 1 from public.friendships f
                                    where f.requester = r.owner and f.addressee = (select auth.uid()) and f.status = 'blocked'))));
$$;

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
  if not private.community_voice_access(v_room.id,me) then
    return jsonb_build_object('error','not_found');
  end if;
  if v_room.owner <> me and exists (select 1 from public.friendships f
                                     where f.requester = v_room.owner and f.addressee = me and f.status = 'blocked') then
    return jsonb_build_object('error', 'not_found');
  end if;
  select * into v_member from public.voice_members m where m.room_id = v_room.id and m.user_id = me;
  v_admitted := v_room.owner = me or (v_member.user_id is not null and not v_member.banned);
  return jsonb_build_object('room', public.voice__room_json(v_room, v_admitted)
    || jsonb_build_object('admitted', v_admitted, 'banned', coalesce(v_member.banned, false)));
end $$;

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
  if not private.community_voice_access(v_room.id,me) then
    return jsonb_build_object('error','not_found');
  end if;
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
  if not private.community_voice_access(v_room.id,me) then
    return jsonb_build_object('error','gone');
  end if;
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
  if not private.community_voice_access(p_room,me) or not private.community_voice_access(p_room,p_user) then
    return jsonb_build_object('error','not_member');
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
         where private.community_voice_access(r.id,me) and r.owner = me
         order by r.last_active desc
         limit 12) x), '[]'::jsonb),
    'recent', coalesce((
      select jsonb_agg(x.j order by x.la desc) from (
        select public.voice__room_json(r, true) as j, r.last_active as la
          from public.voice_rooms r
         where private.community_voice_access(r.id,me) and r.owner <> me
           and exists (select 1 from public.voice_members m where m.room_id = r.id and m.user_id = me and not m.banned)
           and not exists (select 1 from public.friendships fb where fb.requester = r.owner and fb.addressee = me and fb.status = 'blocked')
         order by r.last_active desc
         limit 20) x), '[]'::jsonb),
    'friends', coalesce((
      select jsonb_agg(x.j order by x.la desc) from (
        select public.voice__room_json(r, true) as j, r.last_active as la
          from public.voice_rooms r
         where private.community_voice_access(r.id,me) and not r.is_private
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
  ) where private.community_voice_access(r.id,(select auth.uid()));
$$;

-- "Hablar" (ver community_voice_speaks): copia de 0014 con un filtro más. Una sala que no es de comunidad no cambia.
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
       and m.last_seen > now() - interval '10 minutes'
       and private.community_voice_speaks(p_room, m.user_id)), '[]'::jsonb));
end $$;

-- ---------- Roles propios ----------
-- El dueño crea, renombra y borra roles (hasta 15); el dueño y los moderadores los asignan a miembros (hasta 5 por cuenta).
-- Los roles no moderan: solo cambian lo que cada cuenta puede hacer en cada canal. Errores (22023): bad_role_name, reserved_name,
-- bad_color, role_name_taken, too_many_roles, bad_role, not_member_target, bad_target, too_many_member_roles.
create function public.community_role_save(p_community uuid, p_name text, p_color text default '#94a3b8', p_role uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := private.group_writer(); v_name text := private.group_line(p_name); v_color text := lower(coalesce(p_color, '')); r public.community_roles;
begin
  perform 1 from public.communities where id = p_community for update;
  perform private.community_need(p_community, me, array['owner']);
  if v_name is null or char_length(v_name) not between 1 and 30 then raise exception 'bad_role_name' using errcode = '22023'; end if;
  if private.group_reserved(v_name) then raise exception 'reserved_name' using errcode = '22023'; end if;
  if v_color !~ '^#[0-9a-f]{6}$' then raise exception 'bad_color' using errcode = '22023'; end if;
  if exists (select 1 from public.community_roles x where x.community_id = p_community and lower(x.name) = lower(v_name)
    and x.id is distinct from p_role) then raise exception 'role_name_taken' using errcode = '22023'; end if;
  if p_role is null then
    if (select count(*) from public.community_roles where community_id = p_community) >= 15 then raise exception 'too_many_roles' using errcode = '22023'; end if;
    insert into public.community_roles(community_id, name, color, position)
      values(p_community, v_name, v_color, coalesce((select max(position) + 1 from public.community_roles where community_id = p_community), 0))
      returning * into r;
  else
    update public.community_roles set name = v_name, color = v_color where id = p_role and community_id = p_community returning * into r;
    if not found then raise exception 'bad_role' using errcode = '22023'; end if;
  end if;
  return jsonb_build_object('id', r.id, 'name', r.name, 'color', r.color, 'position', r.position);
end $$;
create function public.community_role_delete(p_role uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := private.group_me(); cid uuid;
begin
  select community_id into cid from public.community_roles where id = p_role;
  if not found then raise exception 'bad_role' using errcode = '22023'; end if;
  perform 1 from public.communities where id = cid for update;
  perform private.community_need(cid, me, array['owner']);
  delete from public.community_roles where id = p_role;
  return jsonb_build_object('ok', true);
end $$;
create function public.community_role_assign(p_community uuid, p_user uuid, p_role uuid, p_on boolean default true) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := private.group_writer(); v_target text;
begin
  perform 1 from public.communities where id = p_community for update;
  perform private.community_need(p_community, me, array['owner','moderator']);
  v_target := private.community_role(p_community, p_user);
  if v_target is null then raise exception 'not_member_target' using errcode = '22023'; end if;
  -- Dueño y moderadores ya saltean los permisos por canal: un rol propio no les cambia nada.
  if v_target <> 'member' then raise exception 'bad_target' using errcode = '22023'; end if;
  if not exists (select 1 from public.community_roles where id = p_role and community_id = p_community) then raise exception 'bad_role' using errcode = '22023'; end if;
  if coalesce(p_on, true) then
    if not exists (select 1 from public.community_member_roles where community_id = p_community and user_id = p_user and role_id = p_role)
      and (select count(*) from public.community_member_roles where community_id = p_community and user_id = p_user) >= 5 then
      raise exception 'too_many_member_roles' using errcode = '22023';
    end if;
    insert into public.community_member_roles(community_id, user_id, role_id) values(p_community, p_user, p_role) on conflict do nothing;
  else
    delete from public.community_member_roles where community_id = p_community and user_id = p_user and role_id = p_role;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- ---------- Permisos por canal: leer, cambiar y explicar ----------
-- Configuración tal como se edita: "todos" en booleanos y cada rol propio con allow / deny / ausente (hereda).
create function private.community_perms_json(p_channel uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.community_channels;
begin
  select * into c from public.community_channels where id = p_channel;
  if not found then return null; end if;
  return jsonb_build_object('channelId', c.id, 'kind', c.kind,
    'applies', (select to_jsonb(coalesce(array_agg(p order by n), '{}')) from unnest(private.community_perms()) with ordinality u(p, n)
      where private.community_perm_applies(c.kind, p)),
    'everyone', jsonb_build_object('view', not c.is_private, 'write', c.posting_role = 'members', 'embeds', c.perm_embeds,
      'react', c.perm_react, 'connect', c.perm_connect, 'speak', c.perm_speak),
    'roles', (select coalesce(jsonb_agg(jsonb_build_object('roleId', r.id, 'name', r.name, 'color', r.color,
        'perms', (select coalesce(jsonb_object_agg(x.perm, x.mode), '{}'::jsonb) from public.community_channel_perms x
          where x.channel_id = c.id and x.role_id = r.id)) order by r.position, r.id), '[]'::jsonb)
      from public.community_roles r where r.community_id = c.community_id));
end $$;
create function public.community_channel_perms_get(p_channel uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := private.group_me(); cid uuid;
begin
  select community_id into cid from public.community_channels where id = p_channel;
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
  perform private.community_need(cid, me, array['owner','moderator']);
  return private.community_perms_json(p_channel);
end $$;
-- p_role null = "todos": {permiso: true|false}. Con un rol propio: {permiso: 'allow'|'deny'|'inherit'}. Todo o nada.
create function public.community_channel_perms_set(p_channel uuid, p_role uuid, p_perms jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := private.group_writer(); ch public.community_channels; cid uuid; k text; v jsonb; b boolean;
begin
  select community_id into cid from public.community_channels where id = p_channel;
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
  perform 1 from public.communities where id = cid for update;
  perform private.community_need(cid, me, array['owner','moderator']);
  select * into ch from public.community_channels where id = p_channel for update;
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
  if p_perms is null or jsonb_typeof(p_perms) <> 'object' or octet_length(p_perms::text) > 2000 then raise exception 'bad_request' using errcode = '22023'; end if;
  if p_role is not null and not exists (select 1 from public.community_roles where id = p_role and community_id = cid) then raise exception 'bad_role' using errcode = '22023'; end if;
  for k, v in select e.key, e.value from jsonb_each(p_perms) e loop
    if not (k = any(private.community_perms())) or not private.community_perm_applies(ch.kind, k) then raise exception 'bad_permission' using errcode = '22023'; end if;
    if p_role is null then
      if jsonb_typeof(v) <> 'boolean' then raise exception 'bad_permission' using errcode = '22023'; end if;
      b := (v #>> '{}')::boolean;
      if k = 'view' then ch.is_private := not b;
      elsif k = 'write' then
        if b and ch.kind = 'announcement' then raise exception 'bad_posting_role' using errcode = '22023'; end if;
        ch.posting_role := case when b then 'members' else 'staff' end;
      elsif k = 'embeds' then ch.perm_embeds := b;
      elsif k = 'react' then ch.perm_react := b;
      elsif k = 'connect' then ch.perm_connect := b;
      else ch.perm_speak := b;
      end if;
    elsif jsonb_typeof(v) = 'null' or v = '"inherit"'::jsonb then
      delete from public.community_channel_perms where channel_id = p_channel and role_id = p_role and perm = k;
    elsif v in ('"allow"'::jsonb, '"deny"'::jsonb) then
      insert into public.community_channel_perms(channel_id, role_id, community_id, perm, mode) values(p_channel, p_role, cid, k, v #>> '{}')
        on conflict (channel_id, role_id, perm) do update set mode = excluded.mode;
    else
      raise exception 'bad_permission' using errcode = '22023';
    end if;
  end loop;
  if p_role is null then
    update public.community_channels set is_private = ch.is_private, posting_role = ch.posting_role, perm_embeds = ch.perm_embeds,
      perm_react = ch.perm_react, perm_connect = ch.perm_connect, perm_speak = ch.perm_speak where id = p_channel;
  end if;
  return private.community_perms_json(p_channel);
end $$;
-- "Qué puede hacer este rol aquí": p_subject = 'owner', 'moderator', 'everyone' (un miembro sin roles propios) o el id de un rol propio.
-- source: staff, everyone_allow, everyone_deny, role_allow, role_deny, needs_view, needs_write, needs_connect, not_applicable.
create function public.community_perms_explain(p_channel uuid, p_subject text default 'everyone') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := private.group_me(); ch public.community_channels; v_base text := 'member'; v_role uuid;
  v_allow text[] := '{}'; v_deny text[] := '{}'; calc jsonb; p text; src text; res jsonb := '[]'::jsonb;
begin
  select * into ch from public.community_channels where id = p_channel;
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
  perform private.community_need(ch.community_id, me, array['owner','moderator']);
  if p_subject in ('owner','moderator') then v_base := p_subject;
  elsif p_subject = 'everyone' then v_base := 'member';
  elsif p_subject ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_role := p_subject::uuid;
    if not exists (select 1 from public.community_roles where id = v_role and community_id = ch.community_id) then raise exception 'bad_role' using errcode = '22023'; end if;
    select coalesce(array_agg(x.perm) filter (where x.mode = 'allow'), '{}'), coalesce(array_agg(x.perm) filter (where x.mode = 'deny'), '{}')
      into v_allow, v_deny from public.community_channel_perms x where x.channel_id = ch.id and x.role_id = v_role;
  else
    raise exception 'bad_request' using errcode = '22023';
  end if;
  calc := private.community_perm_calc(ch, v_base, v_allow, v_deny);
  foreach p in array private.community_perms() loop
    if not private.community_perm_applies(ch.kind, p) then src := 'not_applicable';
    elsif v_base in ('owner','moderator') then src := 'staff';
    elsif p <> 'view' and not (calc->>'view')::boolean then src := 'needs_view';
    elsif p = 'embeds' and not (calc->>'write')::boolean then src := 'needs_write';
    elsif p = 'speak' and not (calc->>'connect')::boolean then src := 'needs_connect';
    elsif p = any(v_allow) then src := 'role_allow';
    elsif p = any(v_deny) then src := 'role_deny';
    elsif private.community_perm_base(ch, p) then src := 'everyone_allow';
    else src := 'everyone_deny';
    end if;
    res := res || jsonb_build_object('perm', p, 'allowed', (calc->>p)::boolean, 'source', src);
  end loop;
  return jsonb_build_object('channelId', ch.id, 'subject', p_subject, 'perms', res);
end $$;

-- ---------- Reacciones ----------
-- Ocho reacciones fijas (like, love, laugh, wow, sad, party, fire, eyes), hasta 5 por cuenta y mensaje, 60 por minuto.
-- Pide el permiso "reaccionar" del canal; quitar la propia siempre se puede. Errores: bad_emoji, too_many_reactions,
-- not_found (42501: react_forbidden).
create function public.community_react(p_message uuid, p_emoji text, p_on boolean default true) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := private.group_me(); m public.community_messages;
begin
  select * into m from public.community_messages where id = p_message;
  if not found or m.deleted then raise exception 'not_found' using errcode = '22023'; end if;
  perform private.community_channel_need(m.channel_id, me);
  if not private.community_message_visible(m.channel_id, m.author, m.parent_id) then raise exception 'not_found' using errcode = '22023'; end if;
  if p_emoji is null or p_emoji not in ('like','love','laugh','wow','sad','party','fire','eyes') then raise exception 'bad_emoji' using errcode = '22023'; end if;
  if coalesce(p_on, true) then
    if not private.community_can_act(m.channel_id, me, 'react') then raise exception 'react_forbidden' using errcode = '42501'; end if;
    if not exists (select 1 from public.community_reactions where message_id = p_message and user_id = me and emoji = p_emoji)
      and (select count(*) from public.community_reactions where message_id = p_message and user_id = me) >= 5 then
      raise exception 'too_many_reactions' using errcode = '22023';
    end if;
    perform private.group_hit(me, 'community_react', 60, interval '1 minute');
    insert into public.community_reactions(message_id, user_id, emoji) values(p_message, me, p_emoji) on conflict do nothing;
  else
    delete from public.community_reactions where message_id = p_message and user_id = me and emoji = p_emoji;
  end if;
  return jsonb_build_object('id', p_message, 'reactions', private.community_reactions_json(p_message, me));
end $$;

-- ---------- GIFs: de KLIPY y subidos con aprobación ----------
-- p_media = { kind: 'klipy', url, still?, slug? } (URL validada con private.klipy_url, como los banners del perfil) o
-- { kind: 'upload', id } (archivo de la propia comunidad; p_approved exige que ya esté aprobado). Devuelve la forma normalizada.
create function private.community_media_check(p_community uuid, p_media jsonb, p_approved boolean) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_kind text; md public.community_media;
begin
  if p_media is null or jsonb_typeof(p_media) <> 'object' then raise exception 'bad_media' using errcode = '22023'; end if;
  v_kind := p_media->>'kind';
  if v_kind = 'klipy' then
    if exists (select 1 from jsonb_object_keys(p_media) k where k not in ('kind','url','still','slug'))
      or not coalesce(private.klipy_url(p_media->'url'), false)
      or (p_media ? 'still' and not coalesce(private.klipy_url(p_media->'still'), false))
      or (p_media ? 'slug' and (coalesce(jsonb_typeof(p_media->'slug'), '') <> 'string' or (p_media->>'slug') !~ '^[A-Za-z0-9_-]{1,120}$')) then
      raise exception 'bad_media' using errcode = '22023';
    end if;
    return jsonb_strip_nulls(jsonb_build_object('kind', 'klipy', 'url', p_media->>'url', 'still', p_media->>'still', 'slug', p_media->>'slug'));
  elsif v_kind = 'upload' then
    if coalesce(jsonb_typeof(p_media->'id'), '') <> 'string' or (p_media->>'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or exists (select 1 from jsonb_object_keys(p_media) k where k not in ('kind','id')) then
      raise exception 'bad_media' using errcode = '22023';
    end if;
    select * into md from public.community_media where id = (p_media->>'id')::uuid and community_id = p_community;
    if not found or not (md.status = 'approved' or (not p_approved and md.status = 'pending')) then raise exception 'bad_media' using errcode = '22023'; end if;
    return jsonb_build_object('kind', 'upload', 'id', md.id);
  end if;
  raise exception 'bad_media' using errcode = '22023';
end $$;
-- Un GIF solo (o con un texto de hasta 500). Pide escribir y el permiso "enlaces y GIFs"; cuenta como una publicación (slowmode y tope).
create function public.community_send_media(p_channel uuid, p_media jsonb, p_body text default '') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := private.group_writer(); ch public.community_channels; v_media jsonb; m public.community_messages;
  body_text text := private.group_text(coalesce(p_body, ''));
begin
  if body_text is null or char_length(body_text) > 500 then raise exception 'bad_body' using errcode = '22023'; end if;
  ch := private.community_write_channel(p_channel, array['text','announcement'], true);
  v_media := private.community_media_check(ch.community_id, p_media, true);
  insert into public.community_messages(community_id, channel_id, author, body, media, created_at)
    values(ch.community_id, p_channel, me, body_text, v_media, clock_timestamp()) returning * into m;
  return private.community_message_json(m, me);
end $$;

-- Ayudantes de Storage: bucket privado community-media, archivos <comunidad>/<id>.<gif|webp|png>.
create function private.community_media_folder(p_name text) returns uuid
language sql immutable set search_path = '' as $$
  select case when p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(gif|webp|png)$'
    then split_part(p_name, '/', 1)::uuid end
$$;
-- Subir: dueño o moderador de la comunidad, sin sanciones, hasta 30 archivos por comunidad (cuenta también los rechazados).
create function private.community_media_can_upload(p_community uuid, p_user uuid) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_community is null or p_user is null or p_user is distinct from auth.uid() then return false; end if;
  perform pg_advisory_xact_lock(hashtext('community-media:' || p_community::text));
  return private.community_role(p_community, p_user) in ('owner','moderator')
    and private.community_access(p_community, p_user)
    and public.moderation_social_block(p_user) is null
    and (select count(*) from storage.objects o where o.bucket_id = 'community-media' and (storage.foldername(o.name))[1] = p_community::text) < 30;
end $$;
-- Ver el archivo: la cuenta que lo subió y el dueño (mientras estén en la comunidad), los administradores de Venus y, solo
-- cuando está aprobado, cualquier miembro. Pendiente, rechazado o retirado no lo ve nadie más.
create function private.community_media_can_read(p_name text, p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_user is not null and p_user = (select auth.uid()) and (
    public.admin_is_admin_user(p_user)
    or exists (select 1 from public.community_media m where m.path = p_name and private.community_access(m.community_id, p_user)
      and (m.status = 'approved' or m.uploaded_by = p_user or private.community_role(m.community_id, p_user) = 'owner'))
    -- Recién subido y todavía sin registrar: solo el equipo de esa comunidad.
    or (not exists (select 1 from public.community_media m where m.path = p_name)
      and private.community_media_folder(p_name) is not null
      and private.community_access(private.community_media_folder(p_name), p_user)
      and private.community_role(private.community_media_folder(p_name), p_user) in ('owner','moderator')))
$$;
create function private.community_media_can_delete(p_name text, p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_user is not null and p_user = (select auth.uid()) and (
    public.admin_is_admin_user(p_user)
    or exists (select 1 from public.community_media m where m.path = p_name and private.community_access(m.community_id, p_user)
      and (m.uploaded_by = p_user or private.community_role(m.community_id, p_user) = 'owner'))
    or (not exists (select 1 from public.community_media m where m.path = p_name)
      and private.community_media_folder(p_name) is not null
      and private.community_access(private.community_media_folder(p_name), p_user)
      and private.community_role(private.community_media_folder(p_name), p_user) in ('owner','moderator')))
$$;
-- Un archivo para la interfaz. La ruta (y con ella el archivo) solo para quien puede verlo.
create function private.community_media_json(p_m public.community_media, p_me uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', (p_m).id, 'communityId', (p_m).community_id, 'name', (p_m).name, 'status', (p_m).status,
    'mime', (p_m).mime, 'bytes', (p_m).bytes, 'width', (p_m).width, 'height', (p_m).height, 'createdAt', (p_m).created_at,
    'reviewedAt', (p_m).reviewed_at, 'mine', (p_m).uploaded_by = p_me,
    'rejectReason', case when (p_m).uploaded_by = p_me or private.community_role((p_m).community_id, p_me) = 'owner' then (p_m).reject_reason end,
    'path', case when (p_m).status = 'approved' or (p_m).uploaded_by = p_me or private.community_role((p_m).community_id, p_me) = 'owner' then (p_m).path end,
    'uploadedBy', case when (p_m).uploaded_by is not null then private.group_person((p_m).uploaded_by) end)
$$;
-- Registra un archivo ya subido: el tamaño y el tipo salen de Storage, no del cliente. Nace pendiente. Errores (22023): bad_id,
-- bad_media_name, bad_dimensions (16 a 1024 px por lado), no_file, bad_type, too_big (2 MB), media_limit (20), media_pending_limit (5).
create function public.community_media_register(p_id uuid, p_community uuid, p_name text, p_width integer, p_height integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := private.group_writer(); v_name text := private.group_line(p_name); v_path text; v_meta jsonb; v_mime text; v_bytes bigint;
  md public.community_media;
begin
  if p_id is null then raise exception 'bad_id' using errcode = '22023'; end if;
  perform 1 from public.communities where id = p_community for update;
  perform private.community_need(p_community, me, array['owner','moderator']);
  if v_name is null or char_length(v_name) not between 1 and 40 then raise exception 'bad_media_name' using errcode = '22023'; end if;
  if coalesce(p_width, 0) not between 16 and 1024 or coalesce(p_height, 0) not between 16 and 1024 then raise exception 'bad_dimensions' using errcode = '22023'; end if;
  if exists (select 1 from public.community_media where id = p_id) then raise exception 'bad_id' using errcode = '22023'; end if;
  select o.name, o.metadata into v_path, v_meta from storage.objects o
    where o.bucket_id = 'community-media' and o.name ~ ('^' || p_community::text || '/' || p_id::text || '\.(gif|webp|png)$');
  if not found then raise exception 'no_file' using errcode = '22023'; end if;
  v_mime := case right(v_path, 4) when '.gif' then 'image/gif' when 'webp' then 'image/webp' else 'image/png' end;
  if (v_meta ->> 'mimetype') is distinct from v_mime then raise exception 'bad_type' using errcode = '22023'; end if;
  v_bytes := coalesce((v_meta ->> 'size')::bigint, 0);
  if v_bytes < 1 or v_bytes > 2097152 then raise exception 'too_big' using errcode = '22023'; end if;
  if (select count(*) from public.community_media where community_id = p_community and status in ('pending','approved')) >= 20 then raise exception 'media_limit' using errcode = '22023'; end if;
  if (select count(*) from public.community_media where community_id = p_community and status = 'pending') >= 5 then raise exception 'media_pending_limit' using errcode = '22023'; end if;
  perform private.group_hit(me, 'community_media', 10, interval '1 day');
  insert into public.community_media(id, community_id, uploaded_by, name, path, mime, bytes, width, height)
    values(p_id, p_community, me, v_name, v_path, v_mime, v_bytes, p_width, p_height) returning * into md;
  return private.community_media_json(md, me);
end $$;
-- Miembros: los aprobados. Dueño: todos, con el estado y el motivo. Cualquier otro: los aprobados y lo que subió él.
create function public.community_media_list(p_community uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := private.group_me(); v_role text := private.community_need(p_community, me, array['owner','moderator','member']);
begin
  return (select coalesce(jsonb_agg(private.community_media_json(m, me) order by m.created_at desc, m.id), '[]'::jsonb)
    from public.community_media m where m.community_id = p_community
      and (m.status = 'approved' or v_role = 'owner' or m.uploaded_by = me));
end $$;
-- Para dibujar los GIFs subidos de los mensajes: solo los aprobados de comunidades a las que se puede entrar.
create function public.community_media_resolve(p_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := private.group_me();
begin
  if p_ids is null or cardinality(p_ids) > 30 then raise exception 'bad_request' using errcode = '22023'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'communityId', m.community_id, 'name', m.name, 'path', m.path,
      'width', m.width, 'height', m.height)), '[]'::jsonb)
    from public.community_media m where m.id = any(p_ids) and m.status = 'approved' and private.community_access(m.community_id, me));
end $$;
-- Borra el registro (quien lo subió o el dueño). Devuelve la ruta: el cliente borra el archivo con su sesión.
create function public.community_media_delete(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := private.group_me(); md public.community_media;
begin
  select * into md from public.community_media where id = p_id for update;
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
  perform 1 from public.communities where id = md.community_id for share;
  perform private.community_need(md.community_id, me, array['owner','moderator','member']);
  if md.uploaded_by is distinct from me and private.community_role(md.community_id, me) <> 'owner' then raise exception 'forbidden' using errcode = '42501'; end if;
  delete from public.community_media where id = p_id;
  return jsonb_build_object('ok', true, 'path', md.path);
end $$;

-- ---------- Mensajes de bienvenida y de despedida ----------
-- Texto de hasta 500 con {usuario}, {comunidad} y {miembros} (también {user}, {community} y {members}). Mismas reglas en
-- features/communities/greeting.js (renderGreeting): si cambia acá, cambia allá.
create function private.community_greeting_vars_ok(p_text text) returns boolean
language sql immutable set search_path = '' as $$
  select not exists (select 1 from regexp_matches(coalesce(p_text, ''), '\{([^{}]*)\}', 'g') m
    where lower(m[1]) not in ('usuario','user','comunidad','community','miembros','members'))
$$;
create function private.community_greeting_render(p_text text, p_user text, p_community text, p_members integer) returns text
language sql immutable set search_path = '' as $$
  select btrim(regexp_replace(regexp_replace(regexp_replace(coalesce(p_text, ''),
    '\{(usuario|user)\}', replace(translate(coalesce(p_user, ''), '{}', ''), '\', '\\'), 'gi'),
    '\{(comunidad|community)\}', replace(translate(coalesce(p_community, ''), '{}', ''), '\', '\\'), 'gi'),
    '\{(miembros|members)\}', coalesce(p_members, 0)::text, 'gi'), E' \t\r\n')
$$;
create function private.community_greeting_json(p_community uuid, p_kind text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce((select jsonb_build_object('enabled', g.enabled, 'channelId', g.channel_id, 'body', g.body, 'media', g.media,
      'mediaStatus', case when g.media->>'kind' = 'upload' then coalesce((select m.status from public.community_media m
        where m.id::text = g.media->>'id' and m.community_id = g.community_id), 'missing') end)
    from public.community_greetings g where g.community_id = p_community and g.kind = p_kind),
    jsonb_build_object('enabled', false, 'channelId', null, 'body', '', 'media', null, 'mediaStatus', null))
$$;
create function private.community_greetings_json(p_community uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('join', private.community_greeting_json(p_community, 'join'), 'leave', private.community_greeting_json(p_community, 'leave'))
$$;
-- Solo el dueño. p_patch con enabled, channelId (canal de texto o de anuncios que no sea privado), body y media (GIF de KLIPY o
-- subido; uno subido puede estar pendiente: el mensaje sale sin él hasta que se apruebe). Errores (22023): bad_request,
-- bad_greeting_channel, bad_greeting_text, bad_greeting_variable, bad_media, greeting_needs_channel, greeting_empty.
create function public.community_greeting_save(p_community uuid, p_kind text, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := private.group_writer(); g public.community_greetings; k text; v text; v_enabled boolean; v_channel uuid; v_body text; v_media jsonb; ch public.community_channels;
begin
  perform 1 from public.communities where id = p_community for update;
  perform private.community_need(p_community, me, array['owner']);
  if p_kind is null or p_kind not in ('join','leave') then raise exception 'bad_kind' using errcode = '22023'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or octet_length(p_patch::text) > 4000 then raise exception 'bad_request' using errcode = '22023'; end if;
  select * into g from public.community_greetings where community_id = p_community and kind = p_kind;
  v_enabled := coalesce(g.enabled, false); v_channel := g.channel_id; v_body := coalesce(g.body, ''); v_media := g.media;
  for k in select jsonb_object_keys(p_patch) loop
    if k not in ('enabled','channelId','body','media') then raise exception 'bad_request' using errcode = '22023'; end if;
    v := p_patch->>k;
    if k = 'enabled' then
      if jsonb_typeof(p_patch->k) <> 'boolean' then raise exception 'bad_request' using errcode = '22023'; end if;
      v_enabled := v::boolean;
    elsif k = 'channelId' then
      if jsonb_typeof(p_patch->k) = 'null' then v_channel := null;
      else
        if jsonb_typeof(p_patch->k) <> 'string' or v !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'bad_greeting_channel' using errcode = '22023'; end if;
        select * into ch from public.community_channels where id = v::uuid and community_id = p_community;
        if not found or ch.kind not in ('text','announcement') or ch.is_private then raise exception 'bad_greeting_channel' using errcode = '22023'; end if;
        v_channel := ch.id;
      end if;
    elsif k = 'body' then
      if jsonb_typeof(p_patch->k) <> 'string' then raise exception 'bad_request' using errcode = '22023'; end if;
      v := private.group_text(v);
      if v is null or char_length(v) > 500 then raise exception 'bad_greeting_text' using errcode = '22023'; end if;
      if not private.community_greeting_vars_ok(v) then raise exception 'bad_greeting_variable' using errcode = '22023'; end if;
      v_body := v;
    else
      v_media := case when jsonb_typeof(p_patch->k) = 'null' then null else private.community_media_check(p_community, p_patch->k, false) end;
    end if;
  end loop;
  if v_enabled and v_channel is null then raise exception 'greeting_needs_channel' using errcode = '22023'; end if;
  if v_enabled and v_body = '' and v_media is null then raise exception 'greeting_empty' using errcode = '22023'; end if;
  insert into public.community_greetings(community_id, kind, enabled, channel_id, body, media, updated_at)
    values(p_community, p_kind, v_enabled, v_channel, v_body, v_media, now())
    on conflict (community_id, kind) do update set enabled = excluded.enabled, channel_id = excluded.channel_id, body = excluded.body,
      media = excluded.media, updated_at = excluded.updated_at;
  return private.community_greetings_json(p_community);
end $$;
-- Publica el mensaje automático al entrar ('join') o salir ('leave'). Un mismo usuario no repite el mismo aviso antes de 10 minutos
-- (entrar y salir en bucle no inunda el canal). El texto se arma con los datos de ese momento y queda guardado.
create function private.community_greet(p_community uuid, p_user uuid, p_kind text) returns void
language plpgsql security definer set search_path = '' as $$
declare g public.community_greetings; ch public.community_channels; v_name text; v_body text; v_media jsonb;
begin
  select * into g from public.community_greetings where community_id = p_community and kind = p_kind and enabled and channel_id is not null;
  if not found then return; end if;
  select * into ch from public.community_channels where id = g.channel_id;
  if not found or ch.kind not in ('text','announcement') or ch.is_private then return; end if;
  if exists (select 1 from public.community_messages x where x.community_id = p_community and x.author = p_user and x.system = p_kind
    and x.created_at > now() - interval '10 minutes') then return; end if;
  select coalesce(nullif(btrim(p.display_name), ''), p.username) into v_name from public.profiles p where p.id = p_user;
  v_body := left(private.community_greeting_render(g.body, v_name, (select c.name from public.communities c where c.id = p_community),
    (select count(*)::integer from public.community_members m where m.community_id = p_community)), 2000);
  v_media := case when g.media->>'kind' = 'upload' then (select jsonb_build_object('kind', 'upload', 'id', m.id) from public.community_media m
      where m.id::text = g.media->>'id' and m.community_id = p_community and m.status = 'approved') else g.media end;
  if v_body = '' and v_media is null then return; end if;
  insert into public.community_messages(community_id, channel_id, author, body, media, system, created_at)
    values(p_community, ch.id, p_user, v_body, v_media, p_kind, clock_timestamp());
end $$;
-- Entrar y salir de 0033, con el aviso. Expulsar, banear o borrar la cuenta no publican despedida.
create or replace function private.community_add_member(p_community uuid, p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtext('community-user:' || p_user::text));
  perform 1 from public.communities c where c.id = p_community for update;
  if not found or private.community_owner_blocks(p_community, p_user) then raise exception 'not_found' using errcode = '22023'; end if;
  if exists (select 1 from public.community_bans b where b.community_id = p_community and b.user_id = p_user) then raise exception 'banned_here' using errcode = '22023'; end if;
  if exists (select 1 from public.community_members m where m.community_id = p_community and m.user_id = p_user) then return; end if;
  if (select count(*) from public.community_members m where m.community_id = p_community) >= 500 then raise exception 'community_full' using errcode = '22023'; end if;
  if (select count(*) from public.community_members m where m.user_id = p_user) >= 100 then raise exception 'too_many_joined' using errcode = '22023'; end if;
  insert into public.community_members (community_id, user_id) values (p_community, p_user) on conflict do nothing;
  if found then perform private.community_greet(p_community, p_user, 'join'); end if;
end $$;
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
  if exists (select 1 from public.communities c where c.id = p_community) then perform private.community_greet(p_community, me, 'leave'); end if;
  return jsonb_build_object('ok', true, 'dissolved', not exists (select 1 from public.communities c where c.id = p_community));
end $$;
-- Miembros de a 100 (0033) con los ids de sus roles propios.
create or replace function public.community_members_list(p_community uuid, p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := private.group_me();
  v_role text := private.community_need(p_community, me, array['owner', 'moderator', 'member']);
  v_staff boolean := v_role in ('owner', 'moderator');
begin
  return jsonb_build_object('total', (select count(*) from public.community_members m where m.community_id = p_community),
    'members', (select coalesce(jsonb_agg(private.group_person(x.user_id) || jsonb_build_object('role', x.role, 'joinedAt', x.joined_at,
                  'mutedUntil', case when v_staff or x.user_id = me then x.muted_until end,
                  'roleIds', (select coalesce(jsonb_agg(mr.role_id order by mr.created_at, mr.role_id), '[]'::jsonb) from public.community_member_roles mr
                    where mr.community_id = p_community and mr.user_id = x.user_id)) order by x.ord, x.joined_at), '[]'::jsonb)
      from (select m.*, case m.role when 'owner' then 0 when 'moderator' then 1 else 2 end as ord,
                   (select u.muted_until from public.community_mutes u where u.community_id = m.community_id and u.user_id = m.user_id and u.muted_until > now()) as muted_until
              from public.community_members m where m.community_id = p_community
             order by ord, m.joined_at offset greatest(coalesce(p_offset, 0), 0) limit 100) x));
end $$;

-- ---------- Administración de Venus: cola de GIFs subidos (admin_guard; todo lo que cambia queda en admin_log) ----------
create function public.admin_community_media_queue(p_status text default 'pending', p_limit integer default 50, p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_limit integer := greatest(1, least(coalesce(p_limit, 50), 100)); v_offset integer := greatest(0, coalesce(p_offset, 0));
begin
  perform public.admin_guard();
  if p_status is null or p_status not in ('pending','approved','rejected','removed') then raise exception 'bad_request' using errcode = '22023'; end if;
  return jsonb_build_object(
    'pending', (select count(*) from public.community_media where status = 'pending'),
    'total', (select count(*) from public.community_media where status = p_status),
    'items', (select coalesce(jsonb_agg(x.j order by x.n), '[]'::jsonb) from (
      select row_number() over (order by case when p_status = 'pending' then m.created_at end asc nulls last, m.created_at desc, m.id) as n,
        jsonb_build_object('id', m.id, 'communityId', m.community_id, 'community', (select c.name from public.communities c where c.id = m.community_id),
          'name', m.name, 'path', m.path, 'mime', m.mime, 'bytes', m.bytes, 'width', m.width, 'height', m.height, 'status', m.status,
          'rejectReason', m.reject_reason, 'createdAt', m.created_at, 'reviewedAt', m.reviewed_at,
          'uploadedBy', case when m.uploaded_by is not null then private.group_person(m.uploaded_by) end,
          'reports', (select count(*) from public.group_reports r where r.kind = 'media' and r.target_id = m.id and r.status = 'open')) as j
      from public.community_media m where m.status = p_status
      order by case when p_status = 'pending' then m.created_at end asc nulls last, m.created_at desc, m.id
      limit v_limit offset v_offset) x));
end $$;
-- decision: 'approve' y 'reject' (solo pendientes) o 'remove' (retira uno aprobado, por ejemplo tras una denuncia). Rechazar y retirar piden motivo.
create function public.admin_community_media_review(p_id uuid, p_decision text, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); m public.community_media; v_reason text := nullif(private.group_line(coalesce(p_reason, '')), ''); v_status text;
begin
  perform public.admin_guard();
  if p_decision is null or p_decision not in ('approve','reject','remove') then raise exception 'bad_decision' using errcode = '22023'; end if;
  select * into m from public.community_media where id = p_id for update;
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
  if p_decision in ('approve','reject') and m.status <> 'pending' then raise exception 'bad_state' using errcode = '22023'; end if;
  if p_decision = 'remove' and m.status <> 'approved' then raise exception 'bad_state' using errcode = '22023'; end if;
  if p_decision <> 'approve' and (v_reason is null or char_length(v_reason) not between 3 and 200) then raise exception 'reason_required' using errcode = '22023'; end if;
  v_status := case p_decision when 'approve' then 'approved' when 'reject' then 'rejected' else 'removed' end;
  update public.community_media set status = v_status, reject_reason = case when p_decision = 'approve' then null else v_reason end,
    reviewed_by = me, reviewed_at = now() where id = p_id;
  if p_decision = 'remove' then
    update public.group_reports r set status = 'closed', closed_at = now(), closed_by = me where r.kind = 'media' and r.target_id = p_id and r.status = 'open';
  end if;
  perform public.admin_log(me, (select u.email from auth.users u where u.id = me), 'communityMedia.' || p_decision, m.uploaded_by,
    jsonb_build_object('media', m.id, 'community', m.community_id, 'name', m.name, 'path', m.path, 'reason', v_reason));
  return jsonb_build_object('ok', true, 'status', v_status);
end $$;
-- Cierra una denuncia (0033). Con p_remove borra el mensaje denunciado o retira el GIF denunciado.
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
  elsif coalesce(p_remove, false) and r.kind = 'media' then
    update public.community_media m set status = 'removed', reject_reason = 'report', reviewed_by = me, reviewed_at = now()
      where m.id = r.target_id and m.status = 'approved';
    v_removed := found;
    update public.group_reports x set status = 'closed', closed_at = now(), closed_by = me where x.kind = 'media' and x.target_id = r.target_id and x.status = 'open';
  end if;
  perform public.admin_log(me, (select u.email from auth.users u where u.id = me), 'groupReport.close', r.target_user,
    jsonb_build_object('report', p_id, 'kind', r.kind, 'target', r.target_id, 'removed', v_removed));
  return jsonb_build_object('ok', true, 'removed', v_removed);
end $$;

-- ACL: las RPC de comunidades siguen requiriendo sesión. Las auxiliares solo son internas.
do $acl$
declare f record;
begin
  for f in select p.oid::regprocedure as sig,n.nspname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public','private') and p.proname like 'community\_%' escape '\' loop
    execute format('revoke all on function %s from public, anon, authenticated',f.sig);
    if f.nspname = 'public' then execute format('grant execute on function %s to authenticated',f.sig); end if;
  end loop;
end $acl$;
grant execute on function private.community_is_member(uuid), private.community_message_visible(uuid,uuid,uuid),
  private.community_voice_visible(uuid) to authenticated;
-- Las funciones de voz reemplazadas conservan los grants de 0014.

-- Panel de Venus: solo con sesión; admin_guard decide quién es administrador.
revoke all on function public.admin_community_media_queue(text, integer, integer), public.admin_community_media_review(uuid, text, text)
  from public, anon;
grant execute on function public.admin_community_media_queue(text, integer, integer), public.admin_community_media_review(uuid, text, text)
  to authenticated;

-- ---------- Bucket privado community-media y sus políticas ----------
-- GIFs subidos: <comunidad>/<id>.<gif|webp|png>, hasta 2 MB. Privado: se ve con URL firmada y la política decide quién la pide.
-- Solo suben el dueño y los moderadores; ver, solo lo permite community_media_can_read (aprobado, o dueño/autor/administrador).
-- Las políticas llaman a funciones de private que corren como definer; por eso authenticated necesita ejecutarlas.
grant execute on function private.community_media_folder(text), private.community_media_can_upload(uuid, uuid),
  private.community_media_can_read(text, uuid), private.community_media_can_delete(text, uuid) to authenticated;
do $storage$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('community-media', 'community-media', false, 2097152, array['image/gif', 'image/webp', 'image/png'])
    on conflict (id) do update
      set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
  end if;
  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists "community_media_insert" on storage.objects';
    execute $p$create policy "community_media_insert" on storage.objects for insert to authenticated
      with check (bucket_id = 'community-media' and private.community_media_folder(name) is not null
        and private.community_media_can_upload(private.community_media_folder(name), (select auth.uid())))$p$;
    execute 'drop policy if exists "community_media_select" on storage.objects';
    execute $p$create policy "community_media_select" on storage.objects for select to authenticated
      using (bucket_id = 'community-media' and private.community_media_can_read(name, (select auth.uid())))$p$;
    execute 'drop policy if exists "community_media_delete" on storage.objects';
    execute $p$create policy "community_media_delete" on storage.objects for delete to authenticated
      using (bucket_id = 'community-media' and private.community_media_can_delete(name, (select auth.uid())))$p$;
  end if;
end $storage$;

-- Creación anterior de tres argumentos, con iconos iniciales apropiados por tipo.
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
  insert into public.community_channels (community_id, kind, name, position, icon) values (v_id, 'text', 'general', 0, 'hash'), (v_id, 'voice', 'general', 1, 'headphones');
  return private.community_card(v_id, me);
end $$;
