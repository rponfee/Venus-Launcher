-- 0032_galeria_clips.sql · Venus 3.4 · Galería pública de clips con likes.
-- Guía: docs/implementacion/clips.md. Se aplica después de 0005, 0012, 0014 y 0027 (usa shared_media, moderation_social_block,
-- admin_guard, admin_log y friendships). Idempotente.
--
--   * Publicar un clip que el usuario ya compartió (shared_media): título de hasta 80 caracteres, solo el dueño y hasta 5 por
--     día. Es un acto explícito: lo ve cualquiera con sesión de Venus.
--   * No alarga nada: el clip sigue en el bucket privado 'clips', con el mismo link firmado. La publicación guarda su
--     vencimiento y nunca lo corre (renovar el link de un clip no lo hace seguir en la galería: hay que volver a publicarlo).
--     Vencido, sale de la lista; el dueño lo sigue viendo en gallery_mine con el aviso.
--   * El dueño puede cambiar su fila de shared_media (url y expires_at), así que la lista no confía en ella: solo muestra
--     links firmados del Storage de Supabase para esa misma ruta (private.gallery_url_ok). Con eso un clip nunca le hace
--     cargar a otro usuario una dirección cualquiera.
--   * Like y quitar like, uno por usuario y 200 por día. Lista por recientes o por likes de la semana. Baneados y
--     anónimos no publican ni dan like; silenciados no publican (el título es texto para todos).
--   * Denuncias (10 por día, una abierta por clip). Admin: ocultar, mostrar y borrar, todo con admin_log.
--   * Todo por RPC: las tablas no se leen ni se escriben directo.

-- ---------- Tablas ----------
create table if not exists public.clip_gallery (
  id uuid primary key default gen_random_uuid(),
  media_id uuid not null unique references public.shared_media (id) on delete cascade,
  owner uuid not null references auth.users (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 80),
  -- Miniatura chica (JPEG en data:, la hace el launcher del dueño): así la grilla no baja un video por tarjeta
  thumb text check (thumb is null or (char_length(thumb) <= 32768 and thumb like 'data:image/jpeg;base64,%')),
  expires_at timestamptz not null,
  hidden boolean not null default false,
  hidden_at timestamptz,
  hidden_by uuid references auth.users (id) on delete set null,
  hidden_reason text check (char_length(hidden_reason) <= 200),
  created_at timestamptz not null default now()
);
create index if not exists clip_gallery_recent on public.clip_gallery (created_at desc) where not hidden;
create index if not exists clip_gallery_owner on public.clip_gallery (owner, created_at desc);
alter table public.clip_gallery enable row level security;
revoke all on public.clip_gallery from public, anon, authenticated;

create table if not exists public.clip_gallery_likes (
  clip_id uuid not null references public.clip_gallery (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (clip_id, user_id)
);
create index if not exists clip_gallery_likes_week on public.clip_gallery_likes (clip_id, created_at desc);
create index if not exists clip_gallery_likes_user on public.clip_gallery_likes (user_id, created_at desc);
alter table public.clip_gallery_likes enable row level security;
revoke all on public.clip_gallery_likes from public, anon, authenticated;

-- La denuncia guarda el título y el dueño: si el clip se borra, queda de qué se trataba
create table if not exists public.clip_gallery_reports (
  id uuid primary key default gen_random_uuid(),
  clip_id uuid references public.clip_gallery (id) on delete set null,
  clip_title text not null,
  clip_owner uuid references auth.users (id) on delete set null,
  reporter uuid not null references auth.users (id) on delete cascade,
  reason text not null check (reason in ('offensive', 'spam', 'stolen', 'other')),
  text text check (char_length(text) <= 300),
  status text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  closed_by uuid references auth.users (id) on delete set null
);
create unique index if not exists clip_gallery_reports_open on public.clip_gallery_reports (clip_id, reporter) where status = 'open';
create index if not exists clip_gallery_reports_reporter on public.clip_gallery_reports (reporter, created_at desc);
create index if not exists clip_gallery_reports_status on public.clip_gallery_reports (status, created_at desc);
alter table public.clip_gallery_reports enable row level security;
revoke all on public.clip_gallery_reports from public, anon, authenticated;

-- ---------- Ayudantes ----------
-- Link firmado del Storage para esa ruta exacta del bucket clips (<dueño>/<uuid>.<extensión>)
create or replace function private.gallery_url_ok(p_url text, p_path text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(
    p_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.[a-z0-9]{1,8}$'
    and p_url ~ '^https://[a-z0-9]+\.supabase\.co/storage/v1/object/sign/clips/[^?#]+\?token=[A-Za-z0-9._-]+$'
    and split_part(split_part(p_url, '/object/sign/clips/', 2), '?', 1) = p_path, false)
$$;

-- Corta a quien no tiene una cuenta de verdad (sin sesión o anónima)
create or replace function private.gallery_me() returns uuid
language plpgsql stable set search_path = '' as $$
declare me uuid := auth.uid();
begin
  if me is null or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  return me;
end $$;

-- Lo que hace falta para que un clip se vea hoy (sin mirar al que lo pide)
create or replace function private.gallery_visible(p_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select not g.hidden and g.expires_at > now() and m.expires_at > now()
       and m.url is not null and private.gallery_url_ok(m.url, m.path)
       and public.moderation_social_block(g.owner) is distinct from 'user_banned'
      from public.clip_gallery g join public.shared_media m on m.id = g.media_id
     where g.id = p_id), false)
$$;

create or replace function private.gallery_author(p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', a.id, 'username', a.username, 'displayName', a.display_name, 'mcName', a.mc_name)
    from public.profiles a where a.id = p_user
$$;

-- ---------- Publicar ----------
/**
 * Publica un clip compartido por quien llama. Errores: not_authenticated, user_banned, user_muted (42501);
 * bad_title, bad_thumb, not_shared (no es un clip suyo), bad_link, expired, already_published, hidden_by_admin,
 * too_many_today (22023). Devuelve { id, expiresAt }.
 */
create or replace function public.gallery_publish(p_media uuid, p_title text, p_thumb text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.gallery_me();
  v_block text := public.moderation_social_block(me);
  v_title text := btrim(coalesce(p_title, ''));
  m record;
  v_prev record;
  v_id uuid;
  v_until timestamptz;
begin
  if v_block is not null then raise exception '%', v_block using errcode = '42501'; end if;
  if v_title = '' or char_length(v_title) > 80 or v_title ~ '[\x00-\x1f\x7f]' then raise exception 'bad_title' using errcode = '22023'; end if;
  if p_thumb is not null and (char_length(p_thumb) > 32768 or p_thumb !~ '^data:image/jpeg;base64,[A-Za-z0-9+/]+=*$') then raise exception 'bad_thumb' using errcode = '22023'; end if;
  select * into m from public.shared_media x where x.id = p_media and x.owner = me and x.kind = 'clip';
  if not found then raise exception 'not_shared' using errcode = '22023'; end if;
  if not private.gallery_url_ok(m.url, m.path) then raise exception 'bad_link' using errcode = '22023'; end if;
  if m.expires_at is null or m.expires_at <= now() then raise exception 'expired' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext('gallery:' || me::text));
  select g.hidden, g.expires_at into v_prev from public.clip_gallery g where g.media_id = p_media;
  if found then
    if v_prev.hidden then raise exception 'hidden_by_admin' using errcode = '22023'; end if;
    if v_prev.expires_at > now() then raise exception 'already_published' using errcode = '22023'; end if;
    delete from public.clip_gallery g where g.media_id = p_media; -- venció y renovó el link: se publica de nuevo
  end if;
  if (select count(*) from public.clip_gallery g where g.owner = me and g.created_at > now() - interval '1 day') >= 5 then
    raise exception 'too_many_today' using errcode = '22023';
  end if;
  -- Lo vencido hace rato de este usuario ya no sirve ni para el aviso
  delete from public.clip_gallery g where g.owner = me and not g.hidden and g.expires_at < now() - interval '30 days';
  v_until := least(m.expires_at, now() + interval '366 days');
  insert into public.clip_gallery (media_id, owner, title, thumb, expires_at) values (p_media, me, v_title, p_thumb, v_until) returning id into v_id;
  return jsonb_build_object('id', v_id, 'expiresAt', v_until);
end $$;

-- Saca un clip propio de la galería. Lo que ocultó el equipo no se puede sacar para volver a publicarlo.
create or replace function public.gallery_unpublish(p_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.gallery_me();
  v_hidden boolean;
begin
  select g.hidden into v_hidden from public.clip_gallery g where g.id = p_id and g.owner = me for update;
  if not found then return false; end if;
  if v_hidden then raise exception 'hidden_by_admin' using errcode = '22023'; end if;
  update public.clip_gallery_reports r set status = 'closed', closed_at = now() where r.clip_id = p_id and r.status = 'open';
  delete from public.clip_gallery g where g.id = p_id;
  return true;
end $$;

-- ---------- Ver ----------
/**
 * Una página de la galería. p_sort: 'recent' o 'week' (likes de los últimos 7 días). Solo lo que se puede ver hoy y sin
 * los usuarios bloqueados, en las dos direcciones. Devuelve { items: [...], more }.
 */
create or replace function public.gallery_list(p_sort text default 'recent', p_offset integer default 0, p_limit integer default 24) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := private.gallery_me();
  v_limit integer := least(greatest(coalesce(p_limit, 24), 1), 48);
  v_offset integer := least(greatest(coalesce(p_offset, 0), 0), 5000);
  v_week boolean := p_sort = 'week';
  v jsonb;
begin
  with visible as (
    select g.id, g.owner, g.title, g.thumb, g.created_at, g.expires_at, m.url
      from public.clip_gallery g
      join public.shared_media m on m.id = g.media_id
     where not g.hidden and g.expires_at > now() and m.expires_at > now()
       and m.url is not null and private.gallery_url_ok(m.url, m.path)
       and public.moderation_social_block(g.owner) is distinct from 'user_banned'
       and not exists (select 1 from public.friendships f where f.status = 'blocked'
                        and ((f.requester = me and f.addressee = g.owner) or (f.requester = g.owner and f.addressee = me)))
  ), scored as (
    select v.*,
           (select count(*) from public.clip_gallery_likes l where l.clip_id = v.id) as likes,
           (select count(*) from public.clip_gallery_likes l where l.clip_id = v.id and l.created_at > now() - interval '7 days') as likes_week
      from visible v
  ), page as (
    select s.* from scored s
     order by case when v_week then s.likes_week end desc nulls last, s.created_at desc, s.id
     limit v_limit + 1 offset v_offset
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'title', p.title, 'url', p.url, 'thumb', p.thumb, 'at', p.created_at, 'expiresAt', p.expires_at,
      'likes', p.likes, 'likesWeek', p.likes_week, 'mine', p.owner = me,
      'liked', exists (select 1 from public.clip_gallery_likes l where l.clip_id = p.id and l.user_id = me),
      'author', private.gallery_author(p.owner))
      order by case when v_week then p.likes_week end desc nulls last, p.created_at desc, p.id), '[]'::jsonb)
    into v from page p;
  return jsonb_build_object('items', coalesce((select jsonb_agg(x) from (select x from jsonb_array_elements(v) with ordinality t (x, n) where n <= v_limit order by n) y), '[]'::jsonb),
                            'more', jsonb_array_length(v) > v_limit);
end $$;

-- Lo publicado por quien llama, también lo vencido o lo que ocultó el equipo (para mostrarle el aviso)
create or replace function public.gallery_mine() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := private.gallery_me();
begin
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', g.id, 'mediaId', g.media_id, 'title', g.title, 'thumb', g.thumb, 'at', g.created_at, 'expiresAt', g.expires_at,
      'url', case when g.expires_at > now() and m.expires_at > now() and private.gallery_url_ok(m.url, m.path) then m.url end,
      'expired', g.expires_at <= now() or m.expires_at <= now() or m.url is null or not private.gallery_url_ok(m.url, m.path),
      'hidden', g.hidden, 'hiddenReason', g.hidden_reason,
      'likes', (select count(*) from public.clip_gallery_likes l where l.clip_id = g.id),
      'likesWeek', (select count(*) from public.clip_gallery_likes l where l.clip_id = g.id and l.created_at > now() - interval '7 days'))
      order by g.created_at desc)
    from (select * from public.clip_gallery x where x.owner = me order by x.created_at desc limit 100) g
    join public.shared_media m on m.id = g.media_id), '[]'::jsonb);
end $$;

-- ---------- Likes ----------
/**
 * Da o saca el like de quien llama (uno por usuario). Errores: not_authenticated, user_banned (42501); not_found,
 * own_clip, too_many_today (22023). Devuelve { liked, likes, likesWeek }.
 */
create or replace function public.gallery_like(p_id uuid, p_like boolean default true) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.gallery_me();
  v_owner uuid;
  v_like boolean := coalesce(p_like, true);
begin
  if public.moderation_social_block(me) = 'user_banned' then raise exception 'user_banned' using errcode = '42501'; end if;
  select g.owner into v_owner from public.clip_gallery g where g.id = p_id;
  if not found or not private.gallery_visible(p_id) then raise exception 'not_found' using errcode = '22023'; end if;
  if v_owner = me then raise exception 'own_clip' using errcode = '22023'; end if;
  if v_like then
    perform pg_advisory_xact_lock(hashtext('gallery-like:' || me::text));
    if not exists (select 1 from public.clip_gallery_likes l where l.clip_id = p_id and l.user_id = me) then
      if (select count(*) from public.clip_gallery_likes l where l.user_id = me and l.created_at > now() - interval '1 day') >= 200 then
        raise exception 'too_many_today' using errcode = '22023';
      end if;
      insert into public.clip_gallery_likes (clip_id, user_id) values (p_id, me) on conflict do nothing;
    end if;
  else
    delete from public.clip_gallery_likes l where l.clip_id = p_id and l.user_id = me;
  end if;
  return jsonb_build_object('liked', v_like,
    'likes', (select count(*) from public.clip_gallery_likes l where l.clip_id = p_id),
    'likesWeek', (select count(*) from public.clip_gallery_likes l where l.clip_id = p_id and l.created_at > now() - interval '7 days'));
end $$;

-- ---------- Denuncias ----------
-- Errores: user_banned (42501); not_found, own_clip, bad_reason, bad_text, too_many_today (22023). Volver a denunciar
-- un clip con una denuncia propia abierta no suma otra.
create or replace function public.gallery_report(p_id uuid, p_reason text, p_text text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.gallery_me();
  v_text text := nullif(btrim(coalesce(p_text, '')), '');
  g record;
begin
  if public.moderation_social_block(me) = 'user_banned' then raise exception 'user_banned' using errcode = '42501'; end if;
  select x.owner, x.title into g from public.clip_gallery x where x.id = p_id;
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
  if g.owner = me then raise exception 'own_clip' using errcode = '22023'; end if;
  if p_reason is null or p_reason not in ('offensive', 'spam', 'stolen', 'other') then raise exception 'bad_reason' using errcode = '22023'; end if;
  if v_text is not null and (char_length(v_text) > 300 or v_text ~ '[\x00-\x08\x0b-\x1f]') then raise exception 'bad_text' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext('gallery-report:' || me::text));
  if exists (select 1 from public.clip_gallery_reports r where r.clip_id = p_id and r.reporter = me and r.status = 'open') then
    return jsonb_build_object('ok', true, 'repeated', true);
  end if;
  if (select count(*) from public.clip_gallery_reports r where r.reporter = me and r.created_at > now() - interval '1 day') >= 10 then
    raise exception 'too_many_today' using errcode = '22023';
  end if;
  insert into public.clip_gallery_reports (clip_id, clip_title, clip_owner, reporter, reason, text) values (p_id, g.title, g.owner, me, p_reason, v_text);
  return jsonb_build_object('ok', true);
end $$;

-- ---------- Administración ----------
/**
 * Para el panel: p_filter 'reported' (con denuncias abiertas), 'hidden' o 'all'. Hasta 50 por página.
 * { items: [{ id, title, url, thumb, at, expiresAt, expired, hidden, hiddenReason, likes, author, reports }], more }
 */
create or replace function public.admin_gallery_list(p_filter text default 'reported', p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_filter text := case when p_filter in ('hidden', 'all') then p_filter else 'reported' end;
  v_offset integer := least(greatest(coalesce(p_offset, 0), 0), 5000);
  v jsonb;
begin
  perform public.admin_guard();
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', g.id, 'title', g.title, 'thumb', g.thumb,
      'url', case when g.expires_at > now() and m.expires_at > now() and private.gallery_url_ok(m.url, m.path) then m.url end,
      'at', g.created_at, 'expiresAt', g.expires_at,
      'expired', g.expires_at <= now() or m.expires_at <= now() or m.url is null or not private.gallery_url_ok(m.url, m.path),
      'hidden', g.hidden, 'hiddenReason', g.hidden_reason,
      'likes', (select count(*) from public.clip_gallery_likes l where l.clip_id = g.id),
      'author', private.gallery_author(g.owner),
      'reports', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'reason', r.reason, 'text', r.text, 'at', r.created_at, 'reporter', private.gallery_author(r.reporter)) order by r.created_at desc)
                             from public.clip_gallery_reports r where r.clip_id = g.id and r.status = 'open'), '[]'::jsonb))
      order by g.created_at desc), '[]'::jsonb)
    into v
    from (select * from public.clip_gallery x
           where v_filter = 'all'
              or (v_filter = 'hidden' and x.hidden)
              or (v_filter = 'reported' and exists (select 1 from public.clip_gallery_reports r where r.clip_id = x.id and r.status = 'open'))
           order by x.created_at desc limit 51 offset v_offset) g
    join public.shared_media m on m.id = g.media_id;
  return jsonb_build_object('items', coalesce((select jsonb_agg(x) from (select x from jsonb_array_elements(v) with ordinality t (x, n) where n <= 50 order by n) y), '[]'::jsonb),
                            'more', jsonb_array_length(v) > 50);
end $$;

-- Oculta o vuelve a mostrar un clip. Ocultar cierra sus denuncias.
create or replace function public.admin_gallery_hide(p_id uuid, p_hidden boolean default true, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_hide boolean := coalesce(p_hidden, true);
  v_reason text := nullif(left(btrim(coalesce(p_reason, '')), 200), '');
  g record;
begin
  perform public.admin_guard();
  select * into g from public.clip_gallery x where x.id = p_id;
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
  update public.clip_gallery x set hidden = v_hide, hidden_at = case when v_hide then now() end, hidden_by = case when v_hide then me end, hidden_reason = case when v_hide then v_reason end where x.id = p_id;
  if v_hide then
    update public.clip_gallery_reports r set status = 'closed', closed_at = now(), closed_by = me where r.clip_id = p_id and r.status = 'open';
  end if;
  perform public.admin_log(me, (select email from auth.users where id = me), case when v_hide then 'gallery.hide' else 'gallery.show' end, g.owner, jsonb_build_object('clip', p_id, 'title', g.title, 'reason', v_reason));
  return jsonb_build_object('ok', true, 'hidden', v_hide);
end $$;

-- Borra la publicación (el archivo sigue siendo del dueño, en su bucket). Sus denuncias quedan cerradas con el título.
create or replace function public.admin_gallery_delete(p_id uuid, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_reason text := nullif(left(btrim(coalesce(p_reason, '')), 200), '');
  g record;
begin
  perform public.admin_guard();
  select * into g from public.clip_gallery x where x.id = p_id;
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
  update public.clip_gallery_reports r set status = 'closed', closed_at = now(), closed_by = me where r.clip_id = p_id and r.status = 'open';
  delete from public.clip_gallery x where x.id = p_id;
  perform public.admin_log(me, (select email from auth.users where id = me), 'gallery.delete', g.owner, jsonb_build_object('clip', p_id, 'media', g.media_id, 'title', g.title, 'reason', v_reason));
  return jsonb_build_object('ok', true);
end $$;

-- Cierra las denuncias de un clip sin tocar el clip
create or replace function public.admin_gallery_reports_close(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_owner uuid;
  n integer;
begin
  perform public.admin_guard();
  select x.owner into v_owner from public.clip_gallery x where x.id = p_id;
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
  update public.clip_gallery_reports r set status = 'closed', closed_at = now(), closed_by = me where r.clip_id = p_id and r.status = 'open';
  get diagnostics n = row_count;
  perform public.admin_log(me, (select email from auth.users where id = me), 'gallery.close', v_owner, jsonb_build_object('clip', p_id, 'closed', n));
  return jsonb_build_object('ok', true, 'closed', n);
end $$;

-- ---------- Permisos ----------
revoke all on function private.gallery_url_ok(text, text), private.gallery_me(), private.gallery_visible(uuid), private.gallery_author(uuid) from public, anon, authenticated;
revoke all on function public.gallery_publish(uuid, text, text) from public, anon;
revoke all on function public.gallery_unpublish(uuid) from public, anon;
revoke all on function public.gallery_list(text, integer, integer) from public, anon;
revoke all on function public.gallery_mine() from public, anon;
revoke all on function public.gallery_like(uuid, boolean) from public, anon;
revoke all on function public.gallery_report(uuid, text, text) from public, anon;
revoke all on function public.admin_gallery_list(text, integer) from public, anon;
revoke all on function public.admin_gallery_hide(uuid, boolean, text) from public, anon;
revoke all on function public.admin_gallery_delete(uuid, text) from public, anon;
revoke all on function public.admin_gallery_reports_close(uuid) from public, anon;
grant execute on function public.gallery_publish(uuid, text, text) to authenticated;
grant execute on function public.gallery_unpublish(uuid) to authenticated;
grant execute on function public.gallery_list(text, integer, integer) to authenticated;
grant execute on function public.gallery_mine() to authenticated;
grant execute on function public.gallery_like(uuid, boolean) to authenticated;
grant execute on function public.gallery_report(uuid, text, text) to authenticated;
grant execute on function public.admin_gallery_list(text, integer) to authenticated;
grant execute on function public.admin_gallery_hide(uuid, boolean, text) to authenticated;
grant execute on function public.admin_gallery_delete(uuid, text) to authenticated;
grant execute on function public.admin_gallery_reports_close(uuid) to authenticated;
