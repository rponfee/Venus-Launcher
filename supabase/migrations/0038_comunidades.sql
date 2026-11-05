-- 0038: comunidades personalizables, categorías, anuncios y foros.
-- Conserva las firmas de 0033; no elimina ni cambia datos de clanes.
-- Contrato: docs/implementacion/clanes-comunidades.md. Aplicar una sola vez después de 0037.

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
create function private.community_channel_access(p_channel uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.community_channels c where c.id = p_channel
    and private.community_access(c.community_id, p_user)
    and (not c.is_private or private.community_role(c.community_id, p_user) in ('owner','moderator')))
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
create function private.community_can_post(p_channel uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.community_channels c where c.id = p_channel and c.kind <> 'voice'
    and private.community_channel_access(c.id, p_user)
    and (c.posting_role = 'members' or private.community_role(c.community_id, p_user) in ('owner','moderator'))
    and public.moderation_social_block(p_user) is null
    and not exists (select 1 from public.community_mutes m where m.community_id = c.community_id
      and m.user_id = p_user and m.muted_until > now()))
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

create function private.community_channel_json(p_channel uuid, p_me uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', c.id, 'kind', c.kind, 'name', c.name, 'position', c.position,
    'topic', c.topic, 'icon', c.icon, 'categoryId', c.category_id, 'slowmodeSeconds', c.slowmode_seconds,
    'postingRole', c.posting_role, 'isPrivate', c.is_private, 'canPost', private.community_can_post(c.id, p_me),
    'nextPostAt', case when private.community_role(c.community_id, p_me) = 'member' and c.slowmode_seconds > 0
      then (select max(m.created_at) + make_interval(secs => c.slowmode_seconds)
        from public.community_messages m where m.channel_id = c.id and m.author = p_me
        having max(m.created_at) + make_interval(secs => c.slowmode_seconds) > now()) end,
    'people', case when c.kind = 'voice' then (select coalesce(jsonb_agg(private.group_person(v.user_id) order by v.joined_at), '[]'::jsonb)
      from public.voice_members v where v.room_id = c.voice_room_id and not v.banned
        and v.last_seen > now() - interval '75 seconds' and private.community_channel_access(c.id, v.user_id))
      else '[]'::jsonb end)
  from public.community_channels c where c.id = p_channel and private.community_channel_access(c.id, p_me)
$$;
create or replace function private.community_card(p_community uuid, p_me uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', c.id, 'name', c.name, 'description', c.description, 'isPublic', c.is_public,
    'createdAt', c.created_at, 'theme', c.theme, 'color', c.color, 'icon', c.icon, 'banner', c.banner,
    'maxMembers', 500, 'maxChannels', 50, 'maxCategories', 20,
    'memberCount', (select count(*) from public.community_members m where m.community_id = c.id),
    'channelCount', (select count(*) from public.community_channels ch where ch.community_id = c.id
      and (not ch.is_private or private.community_role(c.id, p_me) in ('owner','moderator'))),
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
    'channels', (select coalesce(jsonb_agg(private.community_channel_json(ch.id, me) order by ch.position, ch.created_at, ch.id), '[]'::jsonb)
      from public.community_channels ch where ch.community_id = p_community and private.community_channel_access(ch.id, me)));
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
create function private.community_write_channel(p_channel uuid, p_kinds text[]) returns public.community_channels
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
create or replace function private.community_message_json(p_m public.community_messages, p_me uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id',(p_m).id,'channelId',(p_m).channel_id,'communityId',(p_m).community_id,'authorId',(p_m).author,
    'at',(p_m).created_at,'deleted',(p_m).deleted,'hidden',h.hidden,
    'body',case when h.hidden or (p_m).deleted then '' else (p_m).body end,
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
  ch := private.community_write_channel(p_channel,array['text','announcement']);
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
  ch := private.community_write_channel(p_channel,array['forum']);
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
  ch := private.community_write_channel(root.channel_id,array['forum']);
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
  if m.author <> me and v_role = 'member' then raise exception 'forbidden' using errcode = '42501'; end if;
  perform 1 from public.community_messages where id = p_id for update;
  update public.community_messages set deleted = true, body = '', title = null, deleted_by = me
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
  if new.deleted then new.body := ''; new.title := null; end if;
  if ch.kind = 'voice' then raise exception 'bad_kind' using errcode = '22023'; end if;
  if ch.kind in ('text','announcement') and (new.parent_id is not null or new.title is not null) then raise exception 'bad_kind' using errcode = '22023'; end if;
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
      and private.community_channel_access(c.id,p_user))
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
      and not private.community_channel_access(c.id,old.user_id) and not v.banned;
  return null;
end $$;
create trigger community_members_voice_cleanup after update of role or delete on public.community_members
  for each row execute function private.community_members_voice_cleanup();
create function private.community_channel_voice_cleanup() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.voice_room_id is not null then
    delete from public.voice_members v where v.room_id = new.voice_room_id and not v.banned
      and not private.community_channel_access(new.id,v.user_id);
  end if;
  return null;
end $$;
create trigger community_channel_voice_cleanup after update of is_private on public.community_channels
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
