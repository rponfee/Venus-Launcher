-- 0044_clanes_planes.sql · Venus 4.6 · Planes de clan (Comunidades): Clanes Go, Pro, Max y Ultra, galería con límites por plan,
-- fondos del chat, escenarios de voz y pagos. Guía: docs/wip/planes-clan-46.md. Idempotente.
--
-- Parte de producción tal como está (0001..0037 + 0038..0043, 0045 y 0047), leída con pg_get_functiondef:
--   * Pagos (0017/0025/0026): payments_catalog, payments_create_order, payments_mark_paid, payments_mark_status,
--     private.payments_order_json, private.payment_orders_check y payments_revenue_rows. Se SUMA el producto 'clan_plan'
--     (la orden lleva community_id) y se SACA el del Venus Pass (ya no se compra): la rama 'pass', private.pass_quote,
--     pass_fulfill, pass_revoke, pass_tier_rank y pass_purchase. Las tablas pass_tiers y pass_purchases NO se tocan, ni las
--     columnas season_id y pass_tier de payment_orders (quedan sin uso). En producción no hay órdenes 'pass': si hubiera, la
--     migración se detiene antes de cambiar nada.
--   * Comunidades (0038): se redefinen community_card, community_get, private.community_add_member, community_channel_create,
--     community_role_save, community_media_register/list/resolve, private.community_media_* y admin_community_media_queue
--     solo para que lean el límite del PLAN de la comunidad en vez de una constante (500 miembros, 50 canales, 15 roles, 20 GIF).
--
-- Un plan es de UNA comunidad y lo paga su dueño. Cada pago da un período de 30 días (period_days) que se renueva a mano:
-- no hay débito automático. Los períodos se apilan sin perderse: renovar el mismo plan empieza cuando termina el que queda; un
-- plan mayor empieza ya y PAUSA el tiempo de los menores; uno menor espera a que terminen los mayores. Al vencer no se borra
-- nada: lo que pasa del límite gratis se OCULTA (lo más nuevo primero) y vuelve solo al renovar. Una devolución quita ese período.

-- ---------- 1) Pagos: producto clan_plan y fuera el Venus Pass ----------
do $$ begin
  if exists (select 1 from public.payment_orders where product = 'pass') then
    raise exception 'hay_ordenes_pass: no se puede retirar el Venus Pass de los pagos' using errcode = '22023';
  end if;
end $$;

alter table public.payment_orders drop constraint if exists payment_orders_product_check;
alter table public.payment_orders add constraint payment_orders_product_check check (product in ('ai_plan', 'clan_plan'));
alter table public.payment_orders add column if not exists community_id uuid references public.communities (id) on delete set null;
create index if not exists payment_orders_community on public.payment_orders (community_id) where community_id is not null;

-- ---------- 2) Planes (la tabla que edita el administrador) ----------
create table if not exists public.community_plans (
  id text primary key check (id in ('free', 'go', 'pro', 'max', 'ultra')),
  name text not null check (char_length(name) between 1 and 30),
  rank integer not null unique check (rank between 0 and 10),
  price_usd numeric(6, 2) not null default 0 check (price_usd >= 0 and price_usd <= 999),
  period_days integer not null default 30 check (period_days between 1 and 365),
  max_media integer not null check (max_media between 0 and 100000),
  max_pending integer not null default 5 check (max_pending between 0 and 1000),
  max_backdrops integer not null default 0 check (max_backdrops between 0 and 1000),
  max_stages integer not null default 0 check (max_stages between 0 and 1000),
  allow_animated boolean not null default false,
  max_members integer not null default 500 check (max_members between 1 and 100000),
  max_channels integer not null default 50 check (max_channels between 1 and 1000),
  max_roles integer not null default 15 check (max_roles between 0 and 500),
  priority_review boolean not null default false,
  active boolean not null default true,
  updated_at timestamptz not null default now()
);
alter table public.community_plans enable row level security;
revoke all on public.community_plans from public, anon, authenticated;

insert into public.community_plans (id, name, rank, price_usd, max_media, max_pending, max_backdrops, max_stages, allow_animated, max_members, max_channels, max_roles, priority_review) values
  ('free',  'Gratis', 0,  0,    10, 5,  0,  0,  false, 500,  50,  15, false),
  ('go',    'Go',     1,  2,    50, 5,  2,  1,  false, 500,  50,  15, false),
  ('pro',   'Pro',    2,  4,   150, 5,  6,  4,  true,  500,  50,  15, false),
  ('max',   'Max',    3,  6,   400, 10, 15, 10, true,  500,  50,  15, false),
  ('ultra', 'Ultra',  4, 10,  1000, 10, 40, 25, true,  5000, 150, 50, true)
on conflict (id) do nothing;

-- Períodos pagados (o regalados por un administrador) de cada comunidad.
create table if not exists public.community_plan_periods (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities (id) on delete cascade,
  plan_id text not null references public.community_plans (id),
  source text not null check (source in ('payment', 'admin')),
  order_id uuid unique references public.payment_orders (id) on delete set null,
  granted_by uuid references auth.users (id) on delete set null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index if not exists community_plan_periods_community on public.community_plan_periods (community_id, ends_at desc);
alter table public.community_plan_periods enable row level security;
revoke all on public.community_plan_periods from public, anon, authenticated;

-- Fondos y escenarios incluidos (los dibuja la interfaz: features/communities/presets.js).
create table if not exists public.community_presets (
  id text primary key check (id ~ '^[a-z0-9_]{2,32}$'),
  scope text not null check (scope in ('chat', 'stage')),
  animated boolean not null default false,
  sort integer not null default 0
);
alter table public.community_presets enable row level security;
revoke all on public.community_presets from public, anon, authenticated;
insert into public.community_presets (id, scope, animated, sort) values
  ('soft_grid',   'chat',  false, 10), ('dunes',       'chat',  false, 20), ('paper_dots',  'chat',  false, 30),
  ('mesh',        'chat',  false, 40), ('waves',       'chat',  true,  50), ('drift',       'chat',  true,  60),
  ('aurora',      'stage', true,  10), ('neon_city',   'stage', false, 20), ('campfire',    'stage', true,  30),
  ('starfield',   'stage', true,  40), ('sunset_bay',  'stage', false, 50), ('night_forest','stage', false, 60)
on conflict (id) do nothing;

-- Un fondo (chat) o un escenario (voz) configurado. Cada fila gasta un cupo del plan. channel_id vacío = el de toda la comunidad.
create table if not exists public.community_backdrops (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references public.communities (id) on delete cascade,
  kind text not null check (kind in ('chat', 'stage')),
  channel_id uuid,
  source text not null check (source in ('preset', 'media')),
  preset text references public.community_presets (id),
  media_id uuid references public.community_media (id) on delete cascade,
  dim smallint not null default 35 check (dim between 0 and 80),
  blur smallint not null default 0 check (blur between 0 and 20),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (channel_id, community_id) references public.community_channels (id, community_id) on delete cascade,
  check ((source = 'preset' and preset is not null and media_id is null) or (source = 'media' and media_id is not null and preset is null))
);
create unique index if not exists community_backdrops_scope on public.community_backdrops
  (community_id, kind, coalesce(channel_id, '00000000-0000-0000-0000-000000000000'::uuid));
alter table public.community_backdrops enable row level security;
revoke all on public.community_backdrops from public, anon, authenticated;

-- ---------- 3) Galería: GIF de KLIPY, JPEG, fotos más grandes y animación ----------
alter table public.community_media add column if not exists source text not null default 'upload' check (source in ('upload', 'klipy'));
alter table public.community_media add column if not exists url text check (char_length(url) <= 400);
alter table public.community_media add column if not exists still text check (char_length(still) <= 400);
alter table public.community_media add column if not exists slug text check (char_length(slug) <= 120);
alter table public.community_media add column if not exists animated boolean not null default false;
update public.community_media set animated = true where mime = 'image/gif' and not animated;
alter table public.community_media alter column path drop not null;
alter table public.community_media alter column mime drop not null;
alter table public.community_media alter column bytes drop not null;
alter table public.community_media alter column width drop not null;
alter table public.community_media alter column height drop not null;
alter table public.community_media drop constraint if exists community_media_bytes_check;
alter table public.community_media drop constraint if exists community_media_height_check;
alter table public.community_media drop constraint if exists community_media_width_check;
alter table public.community_media drop constraint if exists community_media_mime_check;
alter table public.community_media drop constraint if exists community_media_shape;
-- GIF: hasta 2 MB y 1024 px. Fotos y fondos (PNG, WebP, JPEG): hasta 4 MB y 2560 px. Uno de KLIPY no tiene archivo.
alter table public.community_media add constraint community_media_shape check (
  (source = 'upload' and path is not null and mime in ('image/gif', 'image/webp', 'image/png', 'image/jpeg')
    and bytes >= 1 and bytes <= case when mime = 'image/gif' then 2097152 else 4194304 end
    and width between 16 and case when mime = 'image/gif' then 1024 else 2560 end
    and height between 16 and case when mime = 'image/gif' then 1024 else 2560 end)
  or (source = 'klipy' and url is not null and path is null));
create index if not exists community_media_rank on public.community_media (community_id, created_at, id) where status in ('pending', 'approved');
update storage.buckets set file_size_limit = 4194304, allowed_mime_types = array['image/gif', 'image/webp', 'image/png', 'image/jpeg']
 where id = 'community-media';

-- ---------- 4) Qué plan tiene una comunidad ahora ----------
create or replace function private.community_plan(p_community uuid) returns public.community_plans
language sql stable security definer set search_path = '' as $$
  select p.* from public.community_plans p
   where p.id = coalesce((select pp.plan_id from public.community_plan_periods pp join public.community_plans x on x.id = pp.plan_id
      where pp.community_id = p_community and pp.revoked_at is null and pp.starts_at <= now() and pp.ends_at > now() and x.active
      order by x.rank desc limit 1), 'free')
$$;

create or replace function private.community_plan_limits(p public.community_plans) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('media', (p).max_media, 'pending', (p).max_pending, 'backdrops', (p).max_backdrops, 'stages', (p).max_stages,
    'animated', (p).allow_animated, 'members', (p).max_members, 'channels', (p).max_channels, 'roles', (p).max_roles, 'priority', (p).priority_review)
$$;

create or replace function private.community_plan_json(p_community uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare p public.community_plans := private.community_plan(p_community);
begin
  return jsonb_build_object('id', p.id, 'name', p.name, 'rank', p.rank, 'priceUsd', p.price_usd, 'periodDays', p.period_days,
    -- Hasta cuándo dura este plan contando los períodos que esperan (renovaciones ya pagadas).
    'endsAt', case when p.id = 'free' then null else (select max(pp.ends_at) from public.community_plan_periods pp
      where pp.community_id = p_community and pp.plan_id = p.id and pp.revoked_at is null and pp.ends_at > now()) end,
    'limits', private.community_plan_limits(p));
end $$;

-- Dar un período: renovar empieza cuando termina el que queda, uno mayor empieza ya y pausa a los menores, uno menor espera.
create or replace function private.community_plan_grant(p_community uuid, p_plan text, p_source text, p_order uuid, p_admin uuid, p_days integer default null)
returns public.community_plan_periods
language plpgsql security definer set search_path = '' as $$
declare v_plan public.community_plans; v_start timestamptz; v_end timestamptz; r public.community_plan_periods;
begin
  select * into v_plan from public.community_plans where id = p_plan and id <> 'free';
  if not found then raise exception 'unknown_plan' using errcode = '22023'; end if;
  perform 1 from public.communities where id = p_community for update;
  if not found then raise exception 'unknown_community' using errcode = '22023'; end if;
  select coalesce(max(pp.ends_at), now()) into v_start from public.community_plan_periods pp join public.community_plans x on x.id = pp.plan_id
   where pp.community_id = p_community and pp.revoked_at is null and pp.ends_at > now() and x.rank >= v_plan.rank;
  v_start := greatest(v_start, now());
  v_end := v_start + make_interval(days => coalesce(p_days, v_plan.period_days));
  update public.community_plan_periods pp set ends_at = pp.ends_at + (v_end - v_start),
      starts_at = case when pp.starts_at > v_start then pp.starts_at + (v_end - v_start) else pp.starts_at end
    from public.community_plans x
   where x.id = pp.plan_id and pp.community_id = p_community and pp.revoked_at is null and pp.ends_at > v_start and x.rank < v_plan.rank;
  insert into public.community_plan_periods (community_id, plan_id, source, order_id, granted_by, starts_at, ends_at)
    values (p_community, p_plan, p_source, p_order, p_admin, v_start, v_end) returning * into r;
  return r;
end $$;

-- ---------- 5) Límites del plan en lo que ya existía ----------
create or replace function private.community_card(p_community uuid, p_me uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', c.id, 'name', c.name, 'description', c.description, 'isPublic', c.is_public,
    'createdAt', c.created_at, 'theme', c.theme, 'color', c.color, 'icon', c.icon, 'banner', c.banner,
    'maxMembers', (private.community_plan(c.id)).max_members, 'maxChannels', (private.community_plan(c.id)).max_channels, 'maxCategories', 20,
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
    'maxRoles', (private.community_plan(p_community)).max_roles,
    'plan', private.community_plan_json(p_community),
    'greetings', case when v_role = 'owner' then private.community_greetings_json(p_community) end,
    'channels', (select coalesce(jsonb_agg(x.j order by x.position, x.created_at, x.id), '[]'::jsonb)
      from (select private.community_channel_json(ch.id, me) as j, ch.position, ch.created_at, ch.id
        from public.community_channels ch where ch.community_id = p_community) x where x.j is not null));
end $$;

create or replace function private.community_add_member(p_community uuid, p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtext('community-user:' || p_user::text));
  perform 1 from public.communities c where c.id = p_community for update;
  if not found or private.community_owner_blocks(p_community, p_user) then raise exception 'not_found' using errcode = '22023'; end if;
  if exists (select 1 from public.community_bans b where b.community_id = p_community and b.user_id = p_user) then raise exception 'banned_here' using errcode = '22023'; end if;
  if exists (select 1 from public.community_members m where m.community_id = p_community and m.user_id = p_user) then return; end if;
  if (select count(*) from public.community_members m where m.community_id = p_community) >= (private.community_plan(p_community)).max_members then raise exception 'community_full' using errcode = '22023'; end if;
  if (select count(*) from public.community_members m where m.user_id = p_user) >= 100 then raise exception 'too_many_joined' using errcode = '22023'; end if;
  insert into public.community_members (community_id, user_id) values (p_community, p_user) on conflict do nothing;
  if found then perform private.community_greet(p_community, p_user, 'join'); end if;
end $$;

create or replace function public.community_channel_create(p_community uuid, p_kind text, p_name text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := private.group_writer(); v_name text := private.group_line(p_name); v_id uuid;
begin
  perform 1 from public.communities where id = p_community for update;
  perform private.community_need(p_community, me, array['owner','moderator']);
  if p_kind is null or p_kind not in ('text','voice','announcement','forum') then raise exception 'bad_kind' using errcode = '22023'; end if;
  if v_name is null or char_length(v_name) not between 1 and 30 then raise exception 'bad_channel_name' using errcode = '22023'; end if;
  if (select count(*) from public.community_channels where community_id = p_community) >= (private.community_plan(p_community)).max_channels then raise exception 'too_many_channels' using errcode = '22023'; end if;
  insert into public.community_channels(community_id, kind, name, position, posting_role, icon)
    values(p_community, p_kind, v_name, coalesce((select max(position)+1 from public.community_channels where community_id = p_community),0),
      case when p_kind = 'announcement' then 'staff' else 'members' end,
      case p_kind when 'voice' then 'headphones' when 'announcement' then 'megaphone' when 'forum' then 'book' else 'hash' end)
    returning id into v_id;
  return private.community_channel_json(v_id, me);
end $$;

create or replace function public.community_role_save(p_community uuid, p_name text, p_color text default '#94a3b8', p_role uuid default null) returns jsonb
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
    if (select count(*) from public.community_roles where community_id = p_community) >= (private.community_plan(p_community)).max_roles then raise exception 'too_many_roles' using errcode = '22023'; end if;
    insert into public.community_roles(community_id, name, color, position)
      values(p_community, v_name, v_color, coalesce((select max(position) + 1 from public.community_roles where community_id = p_community), 0))
      returning * into r;
  else
    update public.community_roles set name = v_name, color = v_color where id = p_role and community_id = p_community returning * into r;
    if not found then raise exception 'bad_role' using errcode = '22023'; end if;
  end if;
  return jsonb_build_object('id', r.id, 'name', r.name, 'color', r.color, 'position', r.position);
end $$;

-- ---------- 6) Galería con límites por plan, lo oculto por el plan, KLIPY y fotos ----------
-- Oculto por el plan: pendiente o aprobado y pasado del límite de la galería (los más nuevos primero). Vuelve solo al renovar.
create or replace function private.community_media_hidden(p_m public.community_media) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((p_m).status in ('pending', 'approved') and (
    select count(*) from public.community_media x where x.community_id = (p_m).community_id and x.status in ('pending', 'approved')
      and (x.created_at, x.id) < ((p_m).created_at, (p_m).id)) >= (private.community_plan((p_m).community_id)).max_media, false)
$$;

create or replace function private.community_media_folder(p_name text) returns uuid
language sql immutable set search_path = '' as $$
  select case when p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(gif|webp|png|jpg)$'
    then split_part(p_name, '/', 1)::uuid end
$$;

create or replace function private.community_media_can_upload(p_community uuid, p_user uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_community is null or p_user is null or p_user is distinct from auth.uid() then return false; end if;
  perform pg_advisory_xact_lock(hashtext('community-media:' || p_community::text));
  return private.community_role(p_community, p_user) in ('owner','moderator')
    and private.community_access(p_community, p_user)
    and public.moderation_social_block(p_user) is null
    and (select count(*) from storage.objects o where o.bucket_id = 'community-media' and (storage.foldername(o.name))[1] = p_community::text)
      < (private.community_plan(p_community)).max_media + 10;
end $$;

create or replace function private.community_media_can_read(p_name text, p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_user is not null and p_user = (select auth.uid()) and (
    public.admin_is_admin_user(p_user)
    or exists (select 1 from public.community_media m where m.path = p_name and private.community_access(m.community_id, p_user)
      and ((m.status = 'approved' and not private.community_media_hidden(m)) or m.uploaded_by = p_user or private.community_role(m.community_id, p_user) = 'owner'))
    -- Recién subido y todavía sin registrar: solo el equipo de esa comunidad.
    or (not exists (select 1 from public.community_media m where m.path = p_name)
      and private.community_media_folder(p_name) is not null
      and private.community_access(private.community_media_folder(p_name), p_user)
      and private.community_role(private.community_media_folder(p_name), p_user) in ('owner','moderator')))
$$;

create or replace function private.community_media_json(p_m public.community_media, p_me uuid, p_hidden boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', (p_m).id, 'communityId', (p_m).community_id, 'name', (p_m).name, 'status', (p_m).status,
    'source', (p_m).source, 'animated', (p_m).animated, 'hidden', coalesce(p_hidden, false),
    'mime', (p_m).mime, 'bytes', (p_m).bytes, 'width', (p_m).width, 'height', (p_m).height, 'createdAt', (p_m).created_at,
    'reviewedAt', (p_m).reviewed_at, 'mine', (p_m).uploaded_by = p_me,
    'rejectReason', case when (p_m).uploaded_by = p_me or private.community_role((p_m).community_id, p_me) = 'owner' then (p_m).reject_reason end,
    'path', case when ((p_m).status = 'approved' and not coalesce(p_hidden, false)) or (p_m).uploaded_by = p_me or private.community_role((p_m).community_id, p_me) = 'owner' then (p_m).path end,
    'url', case when ((p_m).status = 'approved' and not coalesce(p_hidden, false)) or (p_m).uploaded_by = p_me or private.community_role((p_m).community_id, p_me) = 'owner' then (p_m).url end,
    'still', case when ((p_m).status = 'approved' and not coalesce(p_hidden, false)) or (p_m).uploaded_by = p_me or private.community_role((p_m).community_id, p_me) = 'owner' then (p_m).still end,
    'uploadedBy', case when (p_m).uploaded_by is not null then private.group_person((p_m).uploaded_by) end)
$$;
create or replace function private.community_media_json(p_m public.community_media, p_me uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select private.community_media_json(p_m, p_me, private.community_media_hidden(p_m))
$$;

create or replace function public.community_media_list(p_community uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := private.group_me(); v_role text := private.community_need(p_community, me, array['owner','moderator','member']);
  v_max integer := (private.community_plan(p_community)).max_media;
begin
  return (select coalesce(jsonb_agg(private.community_media_json(r.m, me, r.hid) order by (r.m).created_at desc, (r.m).id), '[]'::jsonb)
    from (select m, (m.status in ('pending','approved') and (row_number() over (partition by (m.status in ('pending','approved')) order by m.created_at, m.id)) > v_max) as hid
          from public.community_media m where m.community_id = p_community) r
    where ((r.m).status = 'approved' and not r.hid) or v_role = 'owner' or (r.m).uploaded_by = me);
end $$;

create or replace function public.community_media_resolve(p_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := private.group_me();
begin
  if p_ids is null or cardinality(p_ids) > 30 then raise exception 'bad_request' using errcode = '22023'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'communityId', m.community_id, 'name', m.name, 'source', m.source, 'path', m.path,
      'url', m.url, 'still', m.still, 'animated', m.animated, 'width', m.width, 'height', m.height)), '[]'::jsonb)
    from public.community_media m where m.id = any(p_ids) and m.status = 'approved' and private.community_access(m.community_id, me)
      and not private.community_media_hidden(m));
end $$;

create or replace function private.community_media_view(p_media jsonb, p_community uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when p_media is null then null
    when p_media->>'kind' is distinct from 'upload' then p_media
    else coalesce((select case when m.source = 'klipy' then jsonb_build_object('kind','klipy','url',m.url,'still',m.still)
        else jsonb_build_object('kind','upload','id',m.id,'name',m.name,'path',m.path,'width',m.width,'height',m.height) end
      from public.community_media m where m.id::text = p_media->>'id' and m.community_id = p_community and m.status = 'approved'
        and not private.community_media_hidden(m)),
      jsonb_build_object('kind','upload','id',p_media->>'id','unavailable',true)) end
$$;

create or replace function private.community_media_check(p_community uuid, p_media jsonb, p_approved boolean) returns jsonb
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
    if not found or not (md.status = 'approved' or (not p_approved and md.status = 'pending')) or private.community_media_hidden(md) then raise exception 'bad_media' using errcode = '22023'; end if;
    -- Un GIF de KLIPY guardado en la galería viaja como lo que es: KLIPY.
    if md.source = 'klipy' then return jsonb_strip_nulls(jsonb_build_object('kind', 'klipy', 'url', md.url, 'still', md.still, 'slug', md.slug)); end if;
    return jsonb_build_object('kind', 'upload', 'id', md.id);
  end if;
  raise exception 'bad_media' using errcode = '22023';
end $$;

drop function if exists public.community_media_register(uuid, uuid, text, integer, integer);
create or replace function public.community_media_register(p_id uuid, p_community uuid, p_name text, p_width integer, p_height integer, p_animated boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := private.group_writer(); v_name text := private.group_line(p_name); v_path text; v_meta jsonb; v_mime text; v_bytes bigint;
  v_gif boolean; v_maxdim integer; v_maxbytes bigint; pl public.community_plans; md public.community_media;
begin
  if p_id is null then raise exception 'bad_id' using errcode = '22023'; end if;
  perform 1 from public.communities where id = p_community for update;
  perform private.community_need(p_community, me, array['owner','moderator']);
  pl := private.community_plan(p_community);
  if v_name is null or char_length(v_name) not between 1 and 40 then raise exception 'bad_media_name' using errcode = '22023'; end if;
  if exists (select 1 from public.community_media where id = p_id) then raise exception 'bad_id' using errcode = '22023'; end if;
  select o.name, o.metadata into v_path, v_meta from storage.objects o
    where o.bucket_id = 'community-media' and o.name ~ ('^' || p_community::text || '/' || p_id::text || '\.(gif|webp|png|jpg)$');
  if not found then raise exception 'no_file' using errcode = '22023'; end if;
  v_mime := case right(v_path, 3) when 'gif' then 'image/gif' when 'ebp' then 'image/webp' when 'jpg' then 'image/jpeg' else 'image/png' end;
  v_gif := v_mime = 'image/gif';
  v_maxdim := case when v_gif then 1024 else 2560 end;
  v_maxbytes := case when v_gif then 2097152 else 4194304 end;
  if coalesce(p_width, 0) not between 16 and v_maxdim or coalesce(p_height, 0) not between 16 and v_maxdim then raise exception 'bad_dimensions' using errcode = '22023'; end if;
  if (v_meta ->> 'mimetype') is distinct from v_mime then raise exception 'bad_type' using errcode = '22023'; end if;
  v_bytes := coalesce((v_meta ->> 'size')::bigint, 0);
  if v_bytes < 1 or v_bytes > v_maxbytes then raise exception 'too_big' using errcode = '22023'; end if;
  if (select count(*) from public.community_media where community_id = p_community and status in ('pending','approved')) >= pl.max_media then raise exception 'media_limit' using errcode = '22023'; end if;
  if (select count(*) from public.community_media where community_id = p_community and status = 'pending') >= pl.max_pending then raise exception 'media_pending_limit' using errcode = '22023'; end if;
  perform private.group_hit(me, 'community_media', 30, interval '1 day');
  insert into public.community_media(id, community_id, uploaded_by, name, path, mime, bytes, width, height, animated)
    values(p_id, p_community, me, v_name, v_path, v_mime, v_bytes, p_width, p_height, v_gif or (v_mime = 'image/webp' and coalesce(p_animated, false))) returning * into md;
  return private.community_media_json(md, me);
end $$;

-- Un GIF de KLIPY en la galería: no sube archivo, pero nace pendiente como los demás (el servidor no puede saber si es apto).
create or replace function public.community_media_add_klipy(p_community uuid, p_name text, p_url text, p_still text default null, p_slug text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := private.group_writer(); v_name text := private.group_line(p_name); pl public.community_plans; md public.community_media;
begin
  perform 1 from public.communities where id = p_community for update;
  perform private.community_need(p_community, me, array['owner','moderator']);
  pl := private.community_plan(p_community);
  if v_name is null or char_length(v_name) not between 1 and 40 then raise exception 'bad_media_name' using errcode = '22023'; end if;
  if not coalesce(private.klipy_url(to_jsonb(p_url)), false) or (p_still is not null and not coalesce(private.klipy_url(to_jsonb(p_still)), false))
    or (p_slug is not null and p_slug !~ '^[A-Za-z0-9_-]{1,120}$') then raise exception 'bad_media' using errcode = '22023'; end if;
  if (select count(*) from public.community_media where community_id = p_community and status in ('pending','approved')) >= pl.max_media then raise exception 'media_limit' using errcode = '22023'; end if;
  if (select count(*) from public.community_media where community_id = p_community and status = 'pending') >= pl.max_pending then raise exception 'media_pending_limit' using errcode = '22023'; end if;
  perform private.group_hit(me, 'community_media', 30, interval '1 day');
  insert into public.community_media(id, community_id, uploaded_by, name, source, url, still, slug, animated)
    values(gen_random_uuid(), p_community, me, v_name, 'klipy', p_url, p_still, p_slug, true) returning * into md;
  return private.community_media_json(md, me);
end $$;

-- La cola de Administración: los GIF de KLIPY traen su dirección y las comunidades Ultra pasan primero.
create or replace function public.admin_community_media_queue(p_status text default 'pending', p_limit integer default 50, p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_limit integer := greatest(1, least(coalesce(p_limit, 50), 100)); v_offset integer := greatest(0, coalesce(p_offset, 0));
begin
  perform public.admin_guard();
  if p_status is null or p_status not in ('pending','approved','rejected','removed') then raise exception 'bad_request' using errcode = '22023'; end if;
  return jsonb_build_object(
    'pending', (select count(*) from public.community_media where status = 'pending'),
    'total', (select count(*) from public.community_media where status = p_status),
    'items', (select coalesce(jsonb_agg(x.j order by x.n), '[]'::jsonb) from (
      select row_number() over (order by case when p_status = 'pending' then (not (private.community_plan(m.community_id)).priority_review)::int end asc nulls last,
          case when p_status = 'pending' then m.created_at end asc nulls last, m.created_at desc, m.id) as n,
        jsonb_build_object('id', m.id, 'communityId', m.community_id, 'community', (select c.name from public.communities c where c.id = m.community_id),
          'name', m.name, 'path', m.path, 'source', m.source, 'url', m.url, 'still', m.still, 'animated', m.animated,
          'mime', m.mime, 'bytes', m.bytes, 'width', m.width, 'height', m.height, 'status', m.status,
          'plan', (private.community_plan(m.community_id)).id, 'priority', (private.community_plan(m.community_id)).priority_review,
          'rejectReason', m.reject_reason, 'createdAt', m.created_at, 'reviewedAt', m.reviewed_at,
          'uploadedBy', case when m.uploaded_by is not null then private.group_person(m.uploaded_by) end,
          'reports', (select count(*) from public.group_reports r where r.kind = 'media' and r.target_id = m.id and r.status = 'open')) as j
      from public.community_media m where m.status = p_status
      order by case when p_status = 'pending' then (not (private.community_plan(m.community_id)).priority_review)::int end asc nulls last,
        case when p_status = 'pending' then m.created_at end asc nulls last, m.created_at desc, m.id
      limit v_limit offset v_offset) x));
end $$;

-- ---------- 7) Fondos del chat y escenarios de voz ----------
create or replace function private.community_backdrops_json(p_community uuid, p_staff boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(x.j order by x.created_at, x.id) filter (where p_staff or x.state = 'ok'), '[]'::jsonb)
  from (
    select b.id, b.created_at,
      case
        when row_number() over (partition by b.kind order by b.created_at, b.id) > case b.kind when 'chat' then (private.community_plan(b.community_id)).max_backdrops else (private.community_plan(b.community_id)).max_stages end then 'hidden_plan'
        when coalesce(pr.animated, m.animated, false) and not (private.community_plan(b.community_id)).allow_animated then 'hidden_animated'
        when b.media_id is not null and (m.status <> 'approved' or private.community_media_hidden(m)) then 'media_unavailable'
        else 'ok' end as state,
      jsonb_build_object('id', b.id, 'kind', b.kind, 'channelId', b.channel_id, 'source', b.source, 'preset', b.preset, 'dim', b.dim, 'blur', b.blur,
        'animated', coalesce(pr.animated, m.animated, false),
        'media', case when m.id is not null then jsonb_build_object('id', m.id, 'source', m.source, 'path', m.path, 'url', m.url, 'still', m.still,
          'width', m.width, 'height', m.height, 'animated', m.animated, 'name', m.name) end) as j0
    from public.community_backdrops b left join public.community_media m on m.id = b.media_id left join public.community_presets pr on pr.id = b.preset
    where b.community_id = p_community
  ) y cross join lateral (select y.id, y.created_at, y.state, y.j0 || jsonb_build_object('state', y.state) as j) x
$$;

create or replace function public.community_backdrops_get(p_community uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := private.group_me(); v_role text := private.community_need(p_community, me, array['owner','moderator','member']);
begin
  return jsonb_build_object('items', private.community_backdrops_json(p_community, v_role in ('owner','moderator')),
    'presets', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'scope', p.scope, 'animated', p.animated) order by p.scope, p.sort), '[]'::jsonb) from public.community_presets p));
end $$;

create or replace function public.community_backdrop_set(p_community uuid, p_kind text, p_channel uuid, p_source text, p_value text, p_dim integer default 35, p_blur integer default 0) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := private.group_writer(); pl public.community_plans; ch public.community_channels; pr public.community_presets; md public.community_media;
  v_animated boolean; v_existing uuid; v_count integer; v_limit integer; v_id uuid;
begin
  perform 1 from public.communities where id = p_community for update;
  perform private.community_need(p_community, me, array['owner','moderator']);
  pl := private.community_plan(p_community);
  if p_kind is null or p_kind not in ('chat','stage') then raise exception 'bad_kind' using errcode = '22023'; end if;
  if coalesce(p_dim, -1) not between 0 and 80 or coalesce(p_blur, -1) not between 0 and 20 then raise exception 'bad_value' using errcode = '22023'; end if;
  if p_channel is not null then
    select * into ch from public.community_channels where id = p_channel and community_id = p_community;
    if not found or (p_kind = 'stage') <> (ch.kind = 'voice') then raise exception 'bad_channel' using errcode = '22023'; end if;
  end if;
  if p_source = 'preset' then
    select * into pr from public.community_presets where id = p_value and scope = p_kind;
    if not found then raise exception 'bad_preset' using errcode = '22023'; end if;
    v_animated := pr.animated;
  elsif p_source = 'media' then
    if p_value is null or p_value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'bad_media' using errcode = '22023'; end if;
    select * into md from public.community_media where id = p_value::uuid and community_id = p_community;
    if not found or md.status <> 'approved' or private.community_media_hidden(md) then raise exception 'bad_media' using errcode = '22023'; end if;
    v_animated := md.animated;
  else
    raise exception 'bad_source' using errcode = '22023';
  end if;
  if v_animated and not pl.allow_animated then raise exception 'plan_animated' using errcode = '22023'; end if;
  select b.id into v_existing from public.community_backdrops b
   where b.community_id = p_community and b.kind = p_kind and b.channel_id is not distinct from p_channel;
  if v_existing is null then
    v_limit := case p_kind when 'chat' then pl.max_backdrops else pl.max_stages end;
    select count(*) into v_count from public.community_backdrops where community_id = p_community and kind = p_kind;
    if v_count >= v_limit then raise exception 'plan_limit' using errcode = '22023'; end if;
    insert into public.community_backdrops (community_id, kind, channel_id, source, preset, media_id, dim, blur, created_by)
      values (p_community, p_kind, p_channel, p_source, case when p_source = 'preset' then p_value end, md.id, p_dim, p_blur, me) returning id into v_id;
  else
    update public.community_backdrops set source = p_source, preset = case when p_source = 'preset' then p_value end, media_id = md.id,
      dim = p_dim, blur = p_blur, updated_at = now() where id = v_existing;
    v_id := v_existing;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create or replace function public.community_backdrop_clear(p_community uuid, p_kind text, p_channel uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := private.group_writer();
begin
  perform 1 from public.communities where id = p_community for update;
  perform private.community_need(p_community, me, array['owner','moderator']);
  delete from public.community_backdrops where community_id = p_community and kind = p_kind and channel_id is not distinct from p_channel;
  return jsonb_build_object('ok', true);
end $$;

-- El escenario de una sala de voz de comunidad (el del canal, o el de toda la comunidad). Solo para quien puede entrar.
create or replace function public.community_stage_get(p_room uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := private.group_me(); ch public.community_channels; v_all jsonb; v_pick jsonb;
begin
  select * into ch from public.community_channels where voice_room_id = p_room and kind = 'voice' limit 1;
  if not found then return null; end if;
  perform private.community_channel_need(ch.id, me);
  v_all := private.community_backdrops_json(ch.community_id, false);
  select e into v_pick from jsonb_array_elements(v_all) e where e->>'kind' = 'stage' and (e->>'channelId') = ch.id::text limit 1;
  if v_pick is null then
    select e into v_pick from jsonb_array_elements(v_all) e where e->>'kind' = 'stage' and e->>'channelId' is null limit 1;
  end if;
  return jsonb_build_object('communityId', ch.community_id, 'channelId', ch.id, 'stage', v_pick);
end $$;

-- ---------- 8) El plan de una comunidad (lo ve cualquier miembro) ----------
create or replace function public.community_plan_get(p_community uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := private.group_me(); v_role text := private.community_need(p_community, me, array['owner','moderator','member']);
  pl public.community_plans := private.community_plan(p_community);
begin
  return jsonb_build_object('plan', private.community_plan_json(p_community), 'isOwner', v_role = 'owner',
    'usage', jsonb_build_object(
      'media', (select count(*) from public.community_media where community_id = p_community and status in ('pending','approved')),
      'pending', (select count(*) from public.community_media where community_id = p_community and status = 'pending'),
      'backdrops', (select count(*) from public.community_backdrops where community_id = p_community and kind = 'chat'),
      'stages', (select count(*) from public.community_backdrops where community_id = p_community and kind = 'stage'),
      'members', (select count(*) from public.community_members where community_id = p_community),
      'channels', (select count(*) from public.community_channels where community_id = p_community),
      'roles', (select count(*) from public.community_roles where community_id = p_community)),
    'hiddenMedia', greatest(0, (select count(*) from public.community_media where community_id = p_community and status in ('pending','approved')) - pl.max_media),
    'periods', (select coalesce(jsonb_agg(jsonb_build_object('plan', pp.plan_id, 'startsAt', pp.starts_at, 'endsAt', pp.ends_at,
        'current', pp.starts_at <= now()) order by pp.starts_at), '[]'::jsonb)
      from public.community_plan_periods pp where pp.community_id = p_community and pp.revoked_at is null and pp.ends_at > now()),
    'plans', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'rank', x.rank, 'priceUsd', x.price_usd, 'periodDays', x.period_days,
        'limits', private.community_plan_limits(x)) order by x.rank), '[]'::jsonb) from public.community_plans x where x.active));
end $$;

-- ---------- 9) Administración de Venus: ver, editar y dar o quitar un plan a mano ----------
create or replace function public.admin_community_plans() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.admin_guard();
  return jsonb_build_object(
    'plans', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'rank', p.rank, 'priceUsd', p.price_usd, 'periodDays', p.period_days,
        'active', p.active, 'limits', private.community_plan_limits(p),
        'communities', (select count(distinct pp.community_id) from public.community_plan_periods pp where pp.plan_id = p.id and pp.revoked_at is null
          and pp.starts_at <= now() and pp.ends_at > now())) order by p.rank), '[]'::jsonb) from public.community_plans p),
    'revenueUsd', (select coalesce(sum(o.price_usd), 0) from public.payment_orders o where o.product = 'clan_plan' and o.status = 'paid' and o.live));
end $$;

create or replace function public.admin_community_plan_save(p_id text, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); p public.community_plans; k text;
begin
  perform public.admin_guard();
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'bad_request' using errcode = '22023'; end if;
  for k in select jsonb_object_keys(p_patch) loop
    if k not in ('name','priceUsd','periodDays','active','media','pending','backdrops','stages','animated','members','channels','roles','priority') then raise exception 'bad_request' using errcode = '22023'; end if;
  end loop;
  select * into p from public.community_plans where id = p_id for update;
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
  if p.id = 'free' and (p_patch ? 'priceUsd' or p_patch ? 'periodDays' or p_patch ? 'active') then raise exception 'bad_request' using errcode = '22023'; end if;
  update public.community_plans set
    name = coalesce(nullif(btrim(p_patch->>'name'), ''), name),
    price_usd = coalesce((p_patch->>'priceUsd')::numeric, price_usd),
    period_days = coalesce((p_patch->>'periodDays')::integer, period_days),
    active = coalesce((p_patch->>'active')::boolean, active),
    max_media = coalesce((p_patch->>'media')::integer, max_media),
    max_pending = coalesce((p_patch->>'pending')::integer, max_pending),
    max_backdrops = coalesce((p_patch->>'backdrops')::integer, max_backdrops),
    max_stages = coalesce((p_patch->>'stages')::integer, max_stages),
    allow_animated = coalesce((p_patch->>'animated')::boolean, allow_animated),
    max_members = coalesce((p_patch->>'members')::integer, max_members),
    max_channels = coalesce((p_patch->>'channels')::integer, max_channels),
    max_roles = coalesce((p_patch->>'roles')::integer, max_roles),
    priority_review = coalesce((p_patch->>'priority')::boolean, priority_review),
    updated_at = now()
   where id = p_id returning * into p;
  perform public.admin_log(me, (select u.email from auth.users u where u.id = me), 'communityPlan.edit', null, jsonb_build_object('plan', p_id, 'patch', p_patch));
  return jsonb_build_object('ok', true);
exception when invalid_text_representation or numeric_value_out_of_range or check_violation or unique_violation then
  raise exception 'bad_value' using errcode = '22023';
end $$;

create or replace function public.admin_community_plan_state(p_community uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.admin_guard();
  if not exists (select 1 from public.communities where id = p_community) then raise exception 'not_found' using errcode = '22023'; end if;
  return jsonb_build_object('community', (select c.name from public.communities c where c.id = p_community), 'plan', private.community_plan_json(p_community),
    'periods', (select coalesce(jsonb_agg(jsonb_build_object('id', pp.id, 'plan', pp.plan_id, 'source', pp.source, 'startsAt', pp.starts_at, 'endsAt', pp.ends_at,
        'revokedAt', pp.revoked_at) order by pp.starts_at desc), '[]'::jsonb)
      from (select * from public.community_plan_periods where community_id = p_community order by starts_at desc limit 20) pp));
end $$;

create or replace function public.admin_community_plan_grant(p_community uuid, p_plan text, p_days integer default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); r public.community_plan_periods;
begin
  perform public.admin_guard();
  if p_days is not null and p_days not between 1 and 365 then raise exception 'bad_value' using errcode = '22023'; end if;
  r := private.community_plan_grant(p_community, p_plan, 'admin', null, me, p_days);
  perform public.admin_log(me, (select u.email from auth.users u where u.id = me), 'communityPlan.grant', null,
    jsonb_build_object('community', p_community, 'plan', p_plan, 'days', p_days, 'endsAt', r.ends_at));
  return jsonb_build_object('ok', true, 'endsAt', r.ends_at);
end $$;

create or replace function public.admin_community_plan_revoke(p_community uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); v_n integer;
begin
  perform public.admin_guard();
  update public.community_plan_periods set revoked_at = now() where community_id = p_community and revoked_at is null and ends_at > now();
  get diagnostics v_n = row_count;
  perform public.admin_log(me, (select u.email from auth.users u where u.id = me), 'communityPlan.revoke', null, jsonb_build_object('community', p_community, 'periods', v_n));
  return jsonb_build_object('ok', true, 'periods', v_n);
end $$;

-- ---------- 10) Pagos ----------
create or replace function private.payment_orders_check() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.product = 'clan_plan' then
    if new.community_id is null or new.plan_id !~ '^clan_' or not exists (select 1 from public.community_plans p where p.id = substr(new.plan_id, 6) and p.id <> 'free') then
      raise exception 'bad_clan_order' using errcode = '22023';
    end if;
  elsif not exists (select 1 from public.ai_plans p where p.id = new.plan_id) then
    raise exception 'bad_plan' using errcode = '22023';
  end if;
  return new;
end $$;
drop trigger if exists payment_orders_check on public.payment_orders;
create trigger payment_orders_check before insert or update of plan_id, product on public.payment_orders
  for each row execute function private.payment_orders_check();

create or replace function private.payments_order_json(o public.payment_orders) returns jsonb
language sql stable set search_path = '' as $$
 select jsonb_build_object('id', o.id, 'userId', o.user_id, 'plan', o.plan_id, 'planName', o.plan_name, 'provider', o.provider,
   'product', o.product, 'communityId', o.community_id,
   'currency', o.currency, 'amount', o.amount, 'priceUsd', o.price_usd, 'budgetUsd', o.budget_usd, 'quote', o.quote, 'live', o.live,
   'status', case when o.status = 'pending' and o.expires_at <= now() then 'expired' else o.status end,
   'providerStatus', o.provider_status, 'providerOrderId', o.provider_order_id, 'checkoutUrl', o.checkout_url,
   'carriedUsd', o.carried_usd, 'createdAt', public.ai_iso(o.created_at), 'updatedAt', public.ai_iso(o.updated_at),
   'paidAt', public.ai_iso(o.paid_at), 'expiresAt', public.ai_iso(o.expires_at))
$$;

-- Precio de un plan de clan con un medio de pago (el precio sale de community_plans, nunca del cliente).
create or replace function private.clan_quote(p_plan text, p_provider text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare p public.community_plans; q jsonb;
begin
  if p_plan is null or p_plan !~ '^clan_(go|pro|max|ultra)$' then return null; end if;
  select * into p from public.community_plans where id = substr(p_plan, 6) and active and price_usd > 0;
  if not found then return null; end if;
  q := private.payments_price(p.price_usd, p_provider);
  if q is null then return null; end if;
  return q || jsonb_build_object('product', 'clan_plan', 'budgetUsd', 0, 'plan', 'clan_' || p.id, 'planName', 'Clanes ' || p.name, 'tier', p.id, 'periodDays', p.period_days);
end $$;

create or replace function public.payments_catalog() returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object(
   'providers', jsonb_build_object(
     'mercado_pago', jsonb_build_object('enabled', private.payments_provider_ready('mercado_pago'), 'currency', 'ARS'),
     'paypal', jsonb_build_object('enabled', private.payments_provider_ready('paypal'), 'currency', 'USD')),
   'arsPerUsd', s.ars_per_usd, 'rateUpdatedAt', public.ai_iso(s.rate_updated_at),
   'plans', coalesce((select jsonb_agg(c.plan || jsonb_build_object('prices', jsonb_strip_nulls(jsonb_build_object(
       'mercado_pago', private.payments_quote(c.plan ->> 'id', 'mercado_pago'),
       'paypal', private.payments_quote(c.plan ->> 'id', 'paypal')))) order by c.ord)
     from jsonb_array_elements(public.ai_catalog()) with ordinality c(plan, ord)), '[]'::jsonb),
   'clans', coalesce((select jsonb_agg(jsonb_build_object('id', 'clan_' || p.id, 'tier', p.id, 'name', 'Clanes ' || p.name, 'priceUsd', p.price_usd,
       'periodDays', p.period_days, 'limits', private.community_plan_limits(p),
       'prices', jsonb_strip_nulls(jsonb_build_object('mercado_pago', private.clan_quote('clan_' || p.id, 'mercado_pago'),
         'paypal', private.clan_quote('clan_' || p.id, 'paypal')))) order by p.rank)
     from public.community_plans p where p.active and p.id <> 'free' and p.price_usd > 0), '[]'::jsonb))
 from public.payment_settings s where s.id
$$;

drop function if exists public.payments_create_order(uuid, text, text, boolean);
create or replace function public.payments_create_order(p_user uuid, p_plan text, p_provider text, p_live boolean, p_community uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_quote jsonb; v_order public.payment_orders%rowtype; v_clan boolean := p_plan like 'clan\_%';
begin
  if p_user is null or not exists (select 1 from auth.users u where u.id = p_user and u.deleted_at is null
      and not coalesce(u.is_anonymous, false) and (u.banned_until is null or u.banned_until <= now())) then
    raise exception 'Iniciá sesión con tu cuenta de Venus.' using errcode = '42501';
  end if;
  if not private.payments_provider_ready(p_provider) then
    raise exception 'provider_disabled' using errcode = '22023';
  end if;
  if v_clan then
    -- El plan es de una comunidad y lo paga su dueño.
    if p_community is null or not exists (select 1 from public.communities c where c.id = p_community) then
      raise exception 'unknown_community' using errcode = '22023';
    end if;
    if not exists (select 1 from public.community_members m where m.community_id = p_community and m.user_id = p_user and m.role = 'owner') then
      raise exception 'not_owner' using errcode = '42501';
    end if;
    v_quote := private.clan_quote(p_plan, p_provider);
  else
    v_quote := private.payments_quote(p_plan, p_provider);
  end if;
  if v_quote is null then raise exception 'unknown_plan' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user::text, 817));
  -- Doble clic o reintento: la misma orden pendiente, si el precio no cambió.
  select * into v_order from public.payment_orders o
   where o.user_id = p_user and o.plan_id = p_plan and o.provider = p_provider and o.status = 'pending'
     and o.community_id is not distinct from (case when v_clan then p_community end)
     and o.live = coalesce(p_live, false) and o.amount = (v_quote ->> 'total')::numeric and o.checkout_url is not null
     and o.created_at > now() - interval '30 minutes' and o.expires_at > now()
   order by o.created_at desc limit 1;
  if found then return private.payments_order_json(v_order) || jsonb_build_object('reused', true); end if;
  if (select count(*) from public.payment_orders o where o.user_id = p_user and o.created_at > now() - interval '1 hour') >= 8
    or (select count(*) from public.payment_orders o where o.user_id = p_user and o.created_at > now() - interval '1 day') >= 25 then
    raise exception 'too_many_orders' using errcode = '54000';
  end if;
  insert into public.payment_orders (user_id, plan_id, plan_name, provider, currency, amount, price_usd, budget_usd, quote, live, product, community_id)
  values (p_user, p_plan, v_quote ->> 'planName', p_provider, v_quote ->> 'currency', (v_quote ->> 'total')::numeric,
    (v_quote ->> 'priceUsd')::numeric, (v_quote ->> 'budgetUsd')::numeric, v_quote, coalesce(p_live, false),
    case when v_clan then 'clan_plan' else 'ai_plan' end, case when v_clan then p_community end)
  returning * into v_order;
  return private.payments_order_json(v_order) || jsonb_build_object('reused', false);
end $$;

create or replace function public.payments_mark_paid(p_order uuid, p_payment_id text, p_amount numeric, p_currency text,
  p_live boolean, p_provider_status text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_order public.payment_orders%rowtype; v_plan public.ai_plans%rowtype; v_prev public.ai_paid_periods%rowtype;
 v_carry numeric := 0; v_period uuid; v_reserved numeric; v_cperiod public.community_plan_periods;
begin
  if p_payment_id is null or char_length(p_payment_id) not between 1 and 200 then
    raise exception 'bad_payment' using errcode = '22023';
  end if;
  select * into v_order from public.payment_orders where id = p_order for update;
  if not found then return jsonb_build_object('applied', false, 'reason', 'order_not_found'); end if;
  if v_order.status = 'paid' then
    return jsonb_build_object('applied', false, 'reason', 'already_paid', 'order', private.payments_order_json(v_order));
  end if;
  if v_order.status = 'refunded' then
    return jsonb_build_object('applied', false, 'reason', 'refunded', 'order', private.payments_order_json(v_order));
  end if;
  if not coalesce(p_live, false) and not public.admin_is_admin_user(v_order.user_id) then
    if v_order.provider_status is distinct from 'test_payment' then
      perform public.admin_log(null, null, 'payments.testRejected', v_order.user_id, jsonb_build_object('orderId', v_order.id,
        'provider', v_order.provider, 'paymentId', p_payment_id));
    end if;
    update public.payment_orders set status = 'failed', provider_status = 'test_payment', live = false, checked_at = now(), updated_at = now() where id = p_order;
    return jsonb_build_object('applied', false, 'reason', 'test_payment');
  end if;
  if upper(coalesce(p_currency, '')) <> v_order.currency or p_amount is null or p_amount < v_order.amount - 0.01 then
    update public.payment_orders set provider_status = 'amount_mismatch', checked_at = now(), updated_at = now() where id = p_order;
    perform public.admin_log(null, null, 'payments.amountMismatch', v_order.user_id, jsonb_build_object('orderId', v_order.id,
      'expected', v_order.amount, 'currency', v_order.currency, 'received', p_amount, 'receivedCurrency', p_currency, 'paymentId', p_payment_id));
    return jsonb_build_object('applied', false, 'reason', 'amount_mismatch');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_order.user_id::text, 816));
  if v_order.product = 'clan_plan' then
    -- El período va a la comunidad de LA ORDEN (no a otra del mismo pagador). Si la comunidad ya no existe, queda el aviso.
    if v_order.community_id is not null then
      v_cperiod := private.community_plan_grant(v_order.community_id, substr(v_order.plan_id, 6), 'payment', v_order.id, null);
    else
      perform public.admin_log(null, null, 'communityPlan.orphan', v_order.user_id, jsonb_build_object('orderId', v_order.id, 'plan', v_order.plan_id));
    end if;
  else
    select * into v_plan from public.ai_plans where id = v_order.plan_id;
    -- Saldo que quedaba del período vigente (menos lo reservado por preguntas en curso).
    select pp.* into v_prev from public.ai_subscriptions s join public.ai_paid_periods pp on pp.id = s.support_period_id
     where s.user_id = v_order.user_id and s.source = 'support' and (pp.ends_at is null or pp.ends_at > now());
    if found then
      select coalesce(sum(r.reserved_usd), 0) into v_reserved from public.ai_call_reservations r
       where r.period_id = v_prev.id and r.status = 'reserved';
      v_carry := greatest(0, v_prev.budget_usd - v_prev.spent_usd - v_reserved);
      if public.ai_effective_plan(v_order.user_id) is null then v_carry := 0; end if;
    end if;
    insert into public.ai_paid_periods (user_id, order_id, plan_id, starts_at, ends_at, budget_usd)
    values (v_order.user_id, v_order.id, v_order.plan_id, now(), null, least(v_order.budget_usd + v_carry, 9999))
    returning id into v_period;
    insert into public.ai_subscriptions (user_id, plan_id, status, current_period_end, source, external_ref, support_period_id)
    values (v_order.user_id, v_order.plan_id, 'active', null, 'support', 'order:' || v_order.id, v_period)
    on conflict (user_id) do update set plan_id = excluded.plan_id, status = 'active', current_period_end = null,
      source = 'support', external_ref = excluded.external_ref, support_period_id = v_period,
      stripe_customer_id = null, stripe_subscription_id = null, stripe_price_id = null, stripe_status = null,
      cancel_at_period_end = false, grace_until = null, budget_cap_usd = null, budget_cap_until = null, updated_at = now();
  end if;
  update public.payment_orders set status = 'paid', paid_at = now(), provider_payment_id = p_payment_id,
    provider_status = coalesce(left(p_provider_status, 60), 'paid'), live = coalesce(p_live, live), period_id = v_period,
    carried_usd = v_carry, checked_at = now(), updated_at = now()
   where id = p_order returning * into v_order;
  perform public.admin_log(null, null, case when v_order.product = 'clan_plan' then 'communityPlan.purchased' else 'payments.paid' end, v_order.user_id,
    jsonb_build_object('orderId', v_order.id, 'plan', v_order.plan_id, 'provider', v_order.provider, 'amount', v_order.amount, 'currency', v_order.currency,
      'priceUsd', v_order.price_usd, 'live', v_order.live, 'carriedUsd', v_carry, 'periodId', v_period,
      'community', v_order.community_id, 'endsAt', v_cperiod.ends_at));
  return jsonb_build_object('applied', true, 'order', private.payments_order_json(v_order));
end $$;

create or replace function public.payments_mark_status(p_order uuid, p_status text, p_provider_status text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_order public.payment_orders%rowtype; v_current uuid; v_carried numeric;
begin
  if p_status not in ('failed', 'cancelled', 'expired', 'refunded') then raise exception 'bad_status' using errcode = '22023'; end if;
  select * into v_order from public.payment_orders where id = p_order for update;
  if not found then return jsonb_build_object('applied', false, 'reason', 'order_not_found'); end if;
  if p_status = 'refunded' then
    if v_order.status <> 'paid' then return jsonb_build_object('applied', false, 'reason', 'not_paid'); end if;
    perform pg_advisory_xact_lock(hashtextextended(v_order.user_id::text, 816));
    if v_order.product = 'clan_plan' then
      -- Una devolución quita el período de esa orden (el tiempo de otros períodos de la comunidad no se toca).
      update public.community_plan_periods set revoked_at = now() where order_id = v_order.id and revoked_at is null;
    else
      update public.ai_paid_periods set ends_at = greatest(now(), starts_at + interval '1 second')
       where id = v_order.period_id and (ends_at is null or ends_at > now());
      select s.support_period_id into v_current from public.ai_subscriptions s where s.user_id = v_order.user_id and s.source = 'support';
      if v_current is not null and v_current is distinct from v_order.period_id then
        select o.carried_usd into v_carried from public.payment_orders o
         where o.user_id = v_order.user_id and o.id <> v_order.id and o.status = 'paid' and o.paid_at >= v_order.paid_at order by o.paid_at limit 1;
        update public.ai_paid_periods set budget_usd = greatest(spent_usd, budget_usd - least(coalesce(v_carried, 0), v_order.budget_usd))
         where id = v_current;
      end if;
    end if;
    update public.payment_orders set status = 'refunded', provider_status = coalesce(left(p_provider_status, 60), 'refunded'),
      checked_at = now(), updated_at = now() where id = p_order returning * into v_order;
    perform public.admin_log(null, null, case when v_order.product = 'clan_plan' then 'communityPlan.refunded' else 'payments.refunded' end, v_order.user_id,
      jsonb_build_object('orderId', v_order.id, 'provider', v_order.provider, 'amount', v_order.amount, 'currency', v_order.currency,
        'carriedRemoved', coalesce(v_carried, 0), 'community', v_order.community_id));
  elsif v_order.status = 'pending' then
    update public.payment_orders set status = p_status, provider_status = coalesce(left(p_provider_status, 60), p_status),
      checked_at = now(), updated_at = now() where id = p_order returning * into v_order;
  else
    return jsonb_build_object('applied', false, 'reason', 'not_pending', 'order', private.payments_order_json(v_order));
  end if;
  return jsonb_build_object('applied', true, 'order', private.payments_order_json(v_order));
end $$;

-- Las estadísticas de ingresos del panel (función admin sin cambios) siguen viendo solo planes de IA; los de clan se ven en Administración > Comunidades.
create or replace function private.payments_revenue_rows() returns table(plan_id text, price_usd numeric, paid_at timestamptz)
language sql stable security definer set search_path = '' as $$
 select t.plan_id, t.price_usd, t.closed_at from public.support_tickets t where t.status='paid' and t.plan_id is not null
 union all
 select o.plan_id, o.price_usd, o.paid_at from public.payment_orders o where o.status='paid' and o.live and o.product = 'ai_plan'
$$;

-- El Venus Pass ya no se compra: fuera lo que lo vendía. (pass_tiers y pass_purchases quedan como historial.)
drop function if exists private.pass_quote(text, text, uuid);
drop function if exists private.pass_fulfill(public.payment_orders);
drop function if exists private.pass_revoke(public.payment_orders);
drop function if exists private.pass_purchase(uuid, text);
drop function if exists private.pass_tier_rank(text);

-- ---------- 11) Permisos ----------
revoke all on function public.payments_create_order(uuid, text, text, boolean, uuid), public.payments_mark_paid(uuid, text, numeric, text, boolean, text),
  public.payments_mark_status(uuid, text, text) from public, anon, authenticated;
grant execute on function public.payments_create_order(uuid, text, text, boolean, uuid), public.payments_mark_paid(uuid, text, numeric, text, boolean, text),
  public.payments_mark_status(uuid, text, text) to service_role;
revoke all on function public.payments_catalog() from public;
grant execute on function public.payments_catalog() to anon, authenticated, service_role;

revoke all on function public.community_media_register(uuid, uuid, text, integer, integer, boolean), public.community_media_add_klipy(uuid, text, text, text, text),
  public.community_backdrops_get(uuid), public.community_backdrop_set(uuid, text, uuid, text, text, integer, integer),
  public.community_backdrop_clear(uuid, text, uuid), public.community_stage_get(uuid), public.community_plan_get(uuid),
  public.admin_community_plans(), public.admin_community_plan_save(text, jsonb), public.admin_community_plan_state(uuid),
  public.admin_community_plan_grant(uuid, text, integer), public.admin_community_plan_revoke(uuid) from public, anon, authenticated;
grant execute on function public.community_media_register(uuid, uuid, text, integer, integer, boolean), public.community_media_add_klipy(uuid, text, text, text, text),
  public.community_backdrops_get(uuid), public.community_backdrop_set(uuid, text, uuid, text, text, integer, integer),
  public.community_backdrop_clear(uuid, text, uuid), public.community_stage_get(uuid), public.community_plan_get(uuid),
  public.admin_community_plans(), public.admin_community_plan_save(text, jsonb), public.admin_community_plan_state(uuid),
  public.admin_community_plan_grant(uuid, text, integer), public.admin_community_plan_revoke(uuid) to authenticated;

revoke all on function private.community_plan(uuid), private.community_plan_json(uuid), private.community_plan_limits(public.community_plans),
  private.community_plan_grant(uuid, text, text, uuid, uuid, integer), private.community_media_hidden(public.community_media),
  private.community_media_json(public.community_media, uuid, boolean), private.community_backdrops_json(uuid, boolean),
  private.clan_quote(text, text) from public, anon, authenticated;
-- Las políticas de Storage llaman a estas tres como authenticated (ya tenían el permiso desde 0038; create or replace lo conserva).
grant execute on function private.community_media_folder(text), private.community_media_can_upload(uuid, uuid), private.community_media_can_read(text, uuid) to authenticated;
