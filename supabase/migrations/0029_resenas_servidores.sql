-- 0029_resenas_servidores.sql · Venus 3.2 · Reseñas y votos de los servidores destacados.
-- Guía: docs/wip/servidores-32.md. Depende de 0006 (featured_servers), 0012 y 0014 (moderación y admin) y 0020 (perfiles).
-- Idempotente.
--
--   * Reseñas (featured_server_reviews): una por usuario y servidor, de 1 a 5 estrellas y hasta 300 caracteres. La edita
--     y la borra su autor; un admin la oculta o la borra. Ocultar no se deshace editando.
--   * Votos (featured_server_votes): uno por usuario y servidor cada 24 h. Una fila por usuario y servidor con el total
--     y el último voto: no crece con el tiempo.
--   * Denuncias (featured_review_reports): una por usuario y reseña, 10 por día por denunciante.
--   * Todo por RPC: las tablas no se leen ni se escriben directo. Leer no pide sesión (sin sesión se ve pero no se opina);
--     opinar y votar piden una cuenta que no sea anónima y sin baneo ni silencio.
--   * Lo escrito por un usuario baneado no se muestra ni se cuenta mientras dure el baneo.

-- ---------- Tablas ----------
create table if not exists public.featured_server_reviews (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references public.featured_servers (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  stars smallint not null check (stars between 1 and 5),
  body text not null default '' check (char_length(body) <= 300),
  hidden boolean not null default false,
  hidden_at timestamptz,
  hidden_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (server_id, user_id)
);
create index if not exists featured_server_reviews_listing on public.featured_server_reviews (server_id, created_at desc) where not hidden;
create index if not exists featured_server_reviews_user on public.featured_server_reviews (user_id, created_at desc);
create index if not exists featured_server_reviews_hidden on public.featured_server_reviews (created_at desc) where hidden;
alter table public.featured_server_reviews enable row level security;
revoke all on public.featured_server_reviews from public, anon, authenticated;

create table if not exists public.featured_server_votes (
  server_id uuid not null references public.featured_servers (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  total integer not null default 1 check (total >= 1),
  last_at timestamptz not null default now(),
  primary key (server_id, user_id)
);
create index if not exists featured_server_votes_user on public.featured_server_votes (user_id);
alter table public.featured_server_votes enable row level security;
revoke all on public.featured_server_votes from public, anon, authenticated;

create table if not exists public.featured_review_reports (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.featured_server_reviews (id) on delete cascade,
  reporter uuid not null references auth.users (id) on delete cascade,
  reason text not null check (reason in ('spam', 'abuse', 'other')),
  text text check (char_length(text) <= 300),
  status text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  closed_by uuid references auth.users (id) on delete set null,
  unique (review_id, reporter)
);
create index if not exists featured_review_reports_open on public.featured_review_reports (created_at desc) where status = 'open';
create index if not exists featured_review_reports_reporter on public.featured_review_reports (reporter, created_at desc);
alter table public.featured_review_reports enable row level security;
revoke all on public.featured_review_reports from public, anon, authenticated;

-- ---------- Auxiliares (fuera de la API) ----------
-- Quién puede opinar: una cuenta con sesión, que no sea anónima y sin baneo (ni silencio, salvo p_allow_muted).
-- Errores (42501): not_authenticated, user_banned, user_muted. Devuelve el id de quien llama.
create or replace function private.review_writer(p_allow_muted boolean default false) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_block text;
begin
  if me is null or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  v_block := public.moderation_social_block(me);
  if v_block = 'user_banned' or (v_block = 'user_muted' and not p_allow_muted) then
    raise exception '%', v_block using errcode = '42501';
  end if;
  return me;
end $$;

-- Lo de un usuario baneado no se muestra ni cuenta mientras dure el baneo
create or replace function private.review_author_visible(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select not exists (select 1 from public.user_moderation m where m.user_id = p_user and m.banned_until > now())
$$;

create or replace function private.review_entry(p_id uuid, p_me uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', r.id, 'stars', r.stars, 'body', r.body, 'at', r.created_at, 'updatedAt', r.updated_at,
    'mine', p_me is not null and r.user_id = p_me, 'hidden', r.hidden and p_me is not null and r.user_id = p_me,
    'author', jsonb_build_object('username', p.username, 'displayName', p.display_name, 'mcName', p.mc_name))
    from public.featured_server_reviews r left join public.profiles p on p.id = r.user_id
   where r.id = p_id
$$;

-- Promedio, cantidad de reseñas y votos de un servidor
create or replace function private.review_stats(p_server uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'avg', (select round(avg(r.stars)::numeric, 2) from public.featured_server_reviews r
             where r.server_id = p_server and not r.hidden and private.review_author_visible(r.user_id)),
    'count', (select count(*) from public.featured_server_reviews r
               where r.server_id = p_server and not r.hidden and private.review_author_visible(r.user_id)),
    'votes', coalesce((select sum(v.total) from public.featured_server_votes v
                        where v.server_id = p_server and private.review_author_visible(v.user_id)), 0))
$$;

-- ---------- Leer (también sin sesión) ----------
-- Promedio, cantidad y votos de varios servidores a la vez, para las tarjetas: { "<id>": { avg, count, votes } }.
-- Hasta 100 ids; los que no existen o están inactivos no aparecen.
create or replace function public.featured_reviews_summary(p_servers uuid[]) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(s.id, private.review_stats(s.id)), '{}'::jsonb)
    from public.featured_servers s
   where s.active and s.id = any ((coalesce(p_servers, '{}'::uuid[]))[1:100])
$$;

/**
 * El detalle de un servidor: { avg, count, votes, mine, vote: { total, lastAt, nextAt } | null, items, next }.
 * items: reseñas visibles de los demás, de la más nueva a la más vieja (p_limit de 1 a 30), anteriores a p_before.
 * next: el valor de p_before para pedir la página siguiente, o null. mine: la reseña de quien llama (con su marca de
 * oculta). Error (22023): bad_server.
 */
create or replace function public.featured_reviews_list(p_server uuid, p_before timestamptz default null, p_limit integer default 10) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_limit integer := greatest(1, least(coalesce(p_limit, 10), 30));
  v_items jsonb;
  v_vote record;
  v_last timestamptz;
  v_more boolean;
begin
  if p_server is null or not exists (select 1 from public.featured_servers s where s.id = p_server and s.active) then
    raise exception 'bad_server' using errcode = '22023';
  end if;
  select jsonb_agg(private.review_entry(x.id, me) order by x.created_at desc), min(x.created_at)
    into v_items, v_last
    from (select r.id, r.created_at from public.featured_server_reviews r
           where r.server_id = p_server and not r.hidden and private.review_author_visible(r.user_id)
             and (me is null or r.user_id <> me) and (p_before is null or r.created_at < p_before)
           order by r.created_at desc limit v_limit) x;
  v_more := v_last is not null and exists (select 1 from public.featured_server_reviews r
           where r.server_id = p_server and not r.hidden and private.review_author_visible(r.user_id)
             and (me is null or r.user_id <> me) and r.created_at < v_last);
  select v.total, v.last_at into v_vote from public.featured_server_votes v where v.server_id = p_server and v.user_id = me;
  return private.review_stats(p_server) || jsonb_build_object(
    'mine', (select private.review_entry(r.id, me) from public.featured_server_reviews r where r.server_id = p_server and r.user_id = me),
    'vote', case when v_vote.total is null then null else jsonb_build_object('total', v_vote.total, 'lastAt', v_vote.last_at, 'nextAt', v_vote.last_at + interval '24 hours') end,
    'items', coalesce(v_items, '[]'::jsonb),
    'next', case when v_more then v_last else null end);
end $$;

-- ---------- Opinar ----------
/**
 * Guarda la reseña de quien llama (la crea o la edita). 20 reseñas nuevas por día; editar la misma, una vez cada 5 s.
 * Una reseña oculta sigue oculta. Errores (22023): bad_server, bad_stars, bad_body, too_many_today, too_fast;
 * (42501): not_authenticated, user_banned, user_muted.
 */
create or replace function public.featured_review_save(p_server uuid, p_stars integer, p_body text default '') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.review_writer();
  v_body text := btrim(coalesce(p_body, ''));
  v_cur record;
  v_id uuid;
begin
  if p_server is null or not exists (select 1 from public.featured_servers s where s.id = p_server and s.active) then
    raise exception 'bad_server' using errcode = '22023';
  end if;
  if p_stars is null or p_stars not between 1 and 5 then raise exception 'bad_stars' using errcode = '22023'; end if;
  if char_length(v_body) > 300 or v_body ~ '[\x00-\x08\x0b-\x1f\x7f]' then raise exception 'bad_body' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext('reviews:' || me::text));
  select r.id, r.updated_at into v_cur from public.featured_server_reviews r where r.server_id = p_server and r.user_id = me;
  if v_cur.id is not null then
    if v_cur.updated_at > now() - interval '5 seconds' then raise exception 'too_fast' using errcode = '22023'; end if;
    update public.featured_server_reviews set stars = p_stars, body = v_body, updated_at = now() where id = v_cur.id;
    v_id := v_cur.id;
  else
    if (select count(*) from public.featured_server_reviews r where r.user_id = me and r.created_at > now() - interval '1 day') >= 20 then
      raise exception 'too_many_today' using errcode = '22023';
    end if;
    insert into public.featured_server_reviews (server_id, user_id, stars, body) values (p_server, me, p_stars, v_body) returning id into v_id;
  end if;
  return private.review_entry(v_id, me) || jsonb_build_object('stats', private.review_stats(p_server));
end $$;

-- Borra la reseña de quien llama (también con la cuenta silenciada o baneada: lo suyo lo puede sacar). Devuelve true si borró.
create or replace function public.featured_review_delete(p_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  n integer;
begin
  if me is null or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  delete from public.featured_server_reviews r where r.id = p_id and r.user_id = me;
  get diagnostics n = row_count;
  return n > 0;
end $$;

/**
 * Vota un servidor: una vez por usuario y servidor cada 24 h. Devuelve { ok, votes, total, nextAt }; ok es false si
 * todavía no pasaron las 24 h. Errores (22023): bad_server; (42501): not_authenticated, user_banned, user_muted.
 */
create or replace function public.featured_server_vote(p_server uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.review_writer();
  n integer;
  v_vote record;
begin
  if p_server is null or not exists (select 1 from public.featured_servers s where s.id = p_server and s.active) then
    raise exception 'bad_server' using errcode = '22023';
  end if;
  insert into public.featured_server_votes as v (server_id, user_id) values (p_server, me)
  on conflict (server_id, user_id) do update
    set total = v.total + 1, last_at = now()
    where v.last_at <= now() - interval '24 hours';
  get diagnostics n = row_count;
  select v.total, v.last_at into v_vote from public.featured_server_votes v where v.server_id = p_server and v.user_id = me;
  return jsonb_build_object('ok', n > 0, 'votes', private.review_stats(p_server) -> 'votes', 'total', v_vote.total, 'nextAt', v_vote.last_at + interval '24 hours');
end $$;

/**
 * Denuncia una reseña ('spam', 'abuse' u 'other'). Una por usuario y reseña (repetir no hace nada) y 10 por día.
 * Errores (22023): bad_review, own_review, bad_reason, bad_text, too_many_today; (42501): not_authenticated, user_banned.
 */
create or replace function public.featured_review_report(p_id uuid, p_reason text, p_text text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.review_writer(true);
  v_text text := nullif(btrim(coalesce(p_text, '')), '');
  v_owner uuid;
  v_id uuid;
begin
  select r.user_id into v_owner from public.featured_server_reviews r where r.id = p_id and not r.hidden;
  if v_owner is null then raise exception 'bad_review' using errcode = '22023'; end if;
  if v_owner = me then raise exception 'own_review' using errcode = '22023'; end if;
  if p_reason is null or p_reason not in ('spam', 'abuse', 'other') then raise exception 'bad_reason' using errcode = '22023'; end if;
  if v_text is not null and (char_length(v_text) > 300 or v_text ~ '[\x00-\x08\x0b-\x1f\x7f]') then raise exception 'bad_text' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext('review_reports:' || me::text));
  if exists (select 1 from public.featured_review_reports x where x.review_id = p_id and x.reporter = me) then
    return jsonb_build_object('ok', true, 'repeated', true);
  end if;
  if (select count(*) from public.featured_review_reports x where x.reporter = me and x.created_at > now() - interval '1 day') >= 10 then
    raise exception 'too_many_today' using errcode = '22023';
  end if;
  insert into public.featured_review_reports (review_id, reporter, reason, text) values (p_id, me, p_reason, v_text) returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- ---------- Panel de administración ----------
/**
 * Reseñas para moderar. p_filter: 'reported' (con denuncias abiertas, las más denunciadas primero), 'hidden' o 'all'
 * (las últimas). Hasta 50, anteriores a p_before. Cada una trae el servidor, el autor y las denuncias abiertas.
 */
create or replace function public.admin_reviews_list(p_filter text default 'reported', p_before timestamptz default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_filter text := coalesce(p_filter, 'reported');
begin
  perform public.admin_guard();
  if v_filter not in ('reported', 'hidden', 'all') then raise exception 'bad_filter' using errcode = '22023'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
        'id', r.id, 'stars', r.stars, 'body', r.body, 'hidden', r.hidden, 'hiddenAt', r.hidden_at, 'at', r.created_at, 'updatedAt', r.updated_at,
        'server', jsonb_build_object('id', s.id, 'name', s.name, 'address', s.address),
        'author', jsonb_build_object('id', p.id, 'username', p.username, 'displayName', p.display_name),
        'openReports', r.open_reports,
        'reports', coalesce((select jsonb_agg(jsonb_build_object('reason', x.reason, 'text', x.text, 'at', x.created_at, 'reporter', a.username) order by x.created_at desc)
                               from public.featured_review_reports x left join public.profiles a on a.id = x.reporter
                              where x.review_id = r.id and x.status = 'open'), '[]'::jsonb))
        order by r.open_reports desc, r.created_at desc)
      from (select q.*, (select count(*) from public.featured_review_reports x where x.review_id = q.id and x.status = 'open') as open_reports
              from public.featured_server_reviews q
             where (p_before is null or q.created_at < p_before)
               and case v_filter
                     when 'reported' then exists (select 1 from public.featured_review_reports x where x.review_id = q.id and x.status = 'open')
                     when 'hidden' then q.hidden
                     else true end
             order by q.created_at desc limit 50) r
      left join public.featured_servers s on s.id = r.server_id
      left join public.profiles p on p.id = r.user_id), '[]'::jsonb);
end $$;

-- Oculta (p_hidden true) o vuelve a mostrar una reseña. Ocultar cierra sus denuncias. Queda en el registro de admins.
create or replace function public.admin_review_set_hidden(p_id uuid, p_hidden boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  r record;
  v_hidden boolean := coalesce(p_hidden, true);
begin
  perform public.admin_guard();
  select * into r from public.featured_server_reviews x where x.id = p_id for update;
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
  update public.featured_server_reviews
     set hidden = v_hidden, hidden_at = case when v_hidden then now() end, hidden_by = case when v_hidden then me end
   where id = p_id;
  if v_hidden then
    update public.featured_review_reports set status = 'closed', closed_at = now(), closed_by = me where review_id = p_id and status = 'open';
  end if;
  perform public.admin_log(me, (select email from auth.users where id = me), case when v_hidden then 'review.hide' else 'review.show' end, r.user_id,
    jsonb_build_object('review', p_id, 'server', r.server_id, 'stars', r.stars, 'body', r.body));
  return jsonb_build_object('ok', true, 'id', p_id, 'hidden', v_hidden);
end $$;

-- Borra una reseña para siempre. Queda en el registro de admins, con su texto.
create or replace function public.admin_review_delete(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  r record;
begin
  perform public.admin_guard();
  select * into r from public.featured_server_reviews x where x.id = p_id for update;
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
  delete from public.featured_server_reviews where id = p_id;
  perform public.admin_log(me, (select email from auth.users where id = me), 'review.delete', r.user_id,
    jsonb_build_object('review', p_id, 'server', r.server_id, 'stars', r.stars, 'body', r.body));
  return jsonb_build_object('ok', true, 'id', p_id);
end $$;

-- Descarta las denuncias de una reseña sin tocarla. Queda en el registro de admins.
create or replace function public.admin_review_dismiss(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  r record;
  n integer;
begin
  perform public.admin_guard();
  select * into r from public.featured_server_reviews x where x.id = p_id;
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
  update public.featured_review_reports set status = 'closed', closed_at = now(), closed_by = me where review_id = p_id and status = 'open';
  get diagnostics n = row_count;
  perform public.admin_log(me, (select email from auth.users where id = me), 'review.dismiss', r.user_id, jsonb_build_object('review', p_id, 'reports', n));
  return jsonb_build_object('ok', true, 'id', p_id, 'closed', n);
end $$;

-- ---------- Permisos ----------
revoke all on function private.review_writer(boolean), private.review_author_visible(uuid), private.review_entry(uuid, uuid), private.review_stats(uuid) from public, anon, authenticated;
revoke all on function public.featured_reviews_summary(uuid[]) from public;
revoke all on function public.featured_reviews_list(uuid, timestamptz, integer) from public;
revoke all on function public.featured_review_save(uuid, integer, text) from public, anon;
revoke all on function public.featured_review_delete(uuid) from public, anon;
revoke all on function public.featured_server_vote(uuid) from public, anon;
revoke all on function public.featured_review_report(uuid, text, text) from public, anon;
revoke all on function public.admin_reviews_list(text, timestamptz) from public, anon;
revoke all on function public.admin_review_set_hidden(uuid, boolean) from public, anon;
revoke all on function public.admin_review_delete(uuid) from public, anon;
revoke all on function public.admin_review_dismiss(uuid) from public, anon;
grant execute on function public.featured_reviews_summary(uuid[]) to anon, authenticated;
grant execute on function public.featured_reviews_list(uuid, timestamptz, integer) to anon, authenticated;
grant execute on function public.featured_review_save(uuid, integer, text) to authenticated;
grant execute on function public.featured_review_delete(uuid) to authenticated;
grant execute on function public.featured_server_vote(uuid) to authenticated;
grant execute on function public.featured_review_report(uuid, text, text) to authenticated;
grant execute on function public.admin_reviews_list(text, timestamptz) to authenticated;
grant execute on function public.admin_review_set_hidden(uuid, boolean) to authenticated;
grant execute on function public.admin_review_delete(uuid) to authenticated;
grant execute on function public.admin_review_dismiss(uuid) to authenticated;
