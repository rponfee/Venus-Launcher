-- Venus Launcher · 0012 · Panel de administración: admins por email confirmado, registro de acciones,
-- moderación (baneos y silencios) y las funciones que usan el panel del launcher y la Edge Function "admin".
-- Se aplica DESPUÉS de 0011 y necesita 0001 (perfiles), 0002 (social), 0007 y 0008 (IA) y 0009 (pagos).
--
-- Quién puede qué:
--   - Un usuario es admin si su email está en app_admin_emails y está CONFIRMADO (app_admins se llena solo con
--     un trigger sobre auth.users). is_admin() lo responde para quien llama.
--   - Las lecturas del panel (admin_overview, admin_list_users, admin_user_detail, admin_plans,
--     admin_list_actions) exigen is_admin() o la service role. El registro admin_actions lo leen solo los admins.
--   - Todo lo que cambia algo (planes, baneos, silencios, sesiones, uso, borrar usuarios, cupones, precios) lo
--     hace la Edge Function "admin" con la service role, después de volver a verificar que quien llama es admin.
--   - Las funciones sociales de 0002 se reemplazan (mismas firmas) para que una cuenta silenciada o baneada no
--     pueda mandar mensajes, reacciones, señales ni solicitudes de amistad.
-- Guía: docs/admin.md. Idempotente: se puede volver a aplicar sin perder datos.

-- ---------- Admins ----------

-- Lista de emails con acceso al panel. Para sumar un admin: insert into public.app_admin_emails (email) values ('...');
create table if not exists public.app_admin_emails (
  email text primary key check (email = lower(btrim(email)) and char_length(email) between 3 and 254 and email ~ '^[^@\s]+@[^@\s]+$'),
  note text check (char_length(note) <= 200),
  created_at timestamptz not null default now()
);

comment on table public.app_admin_emails is 'Emails con acceso al panel de administración (en minúsculas). El acceso se da solo cuando el email está confirmado. Solo la service role.';

insert into public.app_admin_emails (email, note)
values ('admin@example.com', 'Dueño del proyecto')
on conflict (email) do nothing;

-- Usuarios admin (la mantiene el trigger de auth.users y el de app_admin_emails; no se edita a mano).
create table if not exists public.app_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  granted_at timestamptz not null default now()
);

comment on table public.app_admins is 'Usuarios con acceso al panel: email de app_admin_emails y confirmado. La llenan triggers; is_admin() igual vuelve a revisar todo.';

-- ---------- Registro de acciones de los admins ----------

create table if not exists public.admin_actions (
  id bigint generated always as identity primary key,
  admin_id uuid references auth.users (id) on delete set null,
  admin_email text check (char_length(admin_email) <= 254),
  action text not null check (action ~ '^[a-z][A-Za-z]{1,30}(\.[A-Za-z]{1,30})?$'),
  -- Sin clave foránea a propósito: el registro de un usuario borrado tiene que quedar.
  target_user uuid,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object' and octet_length(details::text) <= 8192),
  created_at timestamptz not null default now()
);

create index if not exists admin_actions_created on public.admin_actions (created_at desc);
create index if not exists admin_actions_target on public.admin_actions (target_user, created_at desc);
create index if not exists admin_actions_admin on public.admin_actions (admin_id, created_at desc);

comment on table public.admin_actions is 'Registro de lo que hicieron los admins (solo se agrega, con admin_log). Lo leen los admins.';

-- ---------- Moderación ----------

create table if not exists public.user_moderation (
  user_id uuid primary key references auth.users (id) on delete cascade,
  -- Baneo: también se aplica en Supabase Auth (ban_duration). Permanente = dentro de 100 años.
  banned_until timestamptz,
  ban_reason text check (char_length(ban_reason) <= 500),
  -- Silencio: solo social (mensajes, reacciones, señales y solicitudes de amistad).
  muted_until timestamptz,
  mute_reason text check (char_length(mute_reason) <= 500),
  notes text check (char_length(notes) <= 2000),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

create index if not exists user_moderation_banned on public.user_moderation (banned_until) where banned_until is not null;
create index if not exists user_moderation_muted on public.user_moderation (muted_until) where muted_until is not null;
create index if not exists user_moderation_updated_by on public.user_moderation (updated_by);

comment on table public.user_moderation is 'Baneos, silencios y notas internas de cada usuario. Solo la service role (el panel lo lee con admin_user_detail).';

-- ---------- RLS ----------

alter table public.app_admin_emails enable row level security;
alter table public.app_admins enable row level security;
alter table public.admin_actions enable row level security;
alter table public.user_moderation enable row level security;

revoke all on public.app_admin_emails, public.app_admins, public.admin_actions, public.user_moderation from anon, authenticated;
grant all on public.app_admin_emails, public.app_admins, public.user_moderation to service_role;
-- El registro solo se agrega (con admin_log): ni la service role puede editarlo o borrarlo por la API.
revoke all on public.admin_actions from service_role;
grant select on public.admin_actions to service_role;
grant select on public.admin_actions to authenticated;

-- ---------- Funciones base ----------

-- Fecha en ISO 8601 UTC ("2026-11-27T12:00:00Z") o null.
create or replace function public.admin_iso(p_at timestamptz) returns text
language sql stable set search_path = '' as $$
  select to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
$$;

-- true si el usuario es admin AHORA: está en app_admins, su email (confirmado) sigue en la lista y no está
-- baneado. La Edge Function lo pregunta en cada pedido.
create or replace function public.admin_is_admin_user(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_user is not null and exists (
    select 1
      from public.app_admins a
      join auth.users u on u.id = a.user_id
      join public.app_admin_emails e on e.email = lower(u.email)
     where a.user_id = p_user
       and u.email_confirmed_at is not null
       and u.deleted_at is null
       and (u.banned_until is null or u.banned_until <= now())
  )
$$;

-- ¿Quien llama es admin? (para el launcher: muestra o esconde el panel; el servidor igual verifica todo).
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.admin_is_admin_user(auth.uid())
$$;

-- Corta si quien llama no es admin ni la service role. Las conexiones directas a la base (SQL Editor, psql)
-- no tienen JWT y pasan: ya tienen acceso completo.
create or replace function public.admin_guard() returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  v_claims text := nullif(current_setting('request.jwt.claims', true), '');
  v_role text := coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), v_claims::jsonb ->> 'role');
begin
  if v_role = 'service_role' then
    return;
  end if;
  if v_role is null and session_user::text <> 'authenticator' then
    return;
  end if;
  if public.admin_is_admin_user(auth.uid()) then
    return;
  end if;
  raise exception 'admin_only' using errcode = '42501';
end $$;

-- Recalcula app_admins desde app_admin_emails y auth.users. Devuelve cuántos admins quedaron.
create or replace function public.admin_sync_all() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  delete from public.app_admins a
   where not exists (
     select 1
       from auth.users u
       join public.app_admin_emails e on e.email = lower(u.email)
      where u.id = a.user_id
        and u.email_confirmed_at is not null
        and u.deleted_at is null);
  insert into public.app_admins (user_id, email)
  select u.id, lower(u.email)
    from auth.users u
    join public.app_admin_emails e on e.email = lower(u.email)
   where u.email_confirmed_at is not null
     and u.deleted_at is null
  on conflict (user_id) do update set email = excluded.email;
  select count(*) into v_count from public.app_admins;
  return v_count;
end $$;

-- Trigger de auth.users: al registrarse, confirmar el email o cambiarlo, entra o sale de app_admins.
-- Nunca hace fallar un alta o un inicio de sesión (is_admin() vuelve a revisar todo igual).
create or replace function public.admin_sync_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    if new.email is not null
       and new.email_confirmed_at is not null
       and new.deleted_at is null
       and exists (select 1 from public.app_admin_emails e where e.email = lower(new.email)) then
      insert into public.app_admins (user_id, email)
      values (new.id, lower(new.email))
      on conflict (user_id) do update set email = excluded.email;
    else
      delete from public.app_admins a where a.user_id = new.id;
    end if;
  exception when others then
    raise warning 'admin_sync_user: %', sqlerrm;
  end;
  return null;
end $$;

drop trigger if exists on_auth_user_admin_sync on auth.users;
create trigger on_auth_user_admin_sync
  after insert or update of email, email_confirmed_at on auth.users
  for each row execute function public.admin_sync_user();

-- Trigger de app_admin_emails: agregar o quitar un email recalcula los admins.
create or replace function public.admin_sync_emails() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.admin_sync_all();
  return null;
end $$;

drop trigger if exists app_admin_emails_sync on public.app_admin_emails;
create trigger app_admin_emails_sync
  after insert or update or delete or truncate on public.app_admin_emails
  for each statement execute function public.admin_sync_emails();

-- ---------- Moderación: lo que consultan las funciones sociales ----------

-- null si el usuario puede usar lo social; si no, 'user_banned' o 'user_muted'.
create or replace function public.moderation_social_block(p_user uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when p_user is null then null
    when exists (select 1 from auth.users u where u.id = p_user and u.banned_until > now()) then 'user_banned'
    when exists (select 1 from public.user_moderation m where m.user_id = p_user and m.banned_until > now()) then 'user_banned'
    when exists (select 1 from public.user_moderation m where m.user_id = p_user and m.muted_until > now()) then 'user_muted'
  end
$$;

-- Lo mismo para quien llama (lo usa el trigger de mensajes, que corre con los permisos del usuario).
create or replace function public.moderation_self_block() returns text
language sql stable security definer set search_path = '' as $$
  select public.moderation_social_block(auth.uid())
$$;

-- Estado de moderación propio (para que el launcher pueda avisar "Tu cuenta está silenciada hasta ...").
-- Sin motivos ni notas internas: { muted, mutedUntil, banned, bannedUntil }.
create or replace function public.my_moderation() returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when auth.uid() is null then null else (
    select jsonb_build_object(
      'muted', coalesce(m.muted_until > now(), false),
      'mutedUntil', case when m.muted_until > now() then public.admin_iso(m.muted_until) end,
      'banned', coalesce(m.banned_until > now(), false),
      'bannedUntil', case when m.banned_until > now() then public.admin_iso(m.banned_until) end
    )
      from (select auth.uid() as id) me
      left join public.user_moderation m on m.user_id = me.id
  ) end
$$;

-- ---------- Social (0002): mismas firmas, ahora respetan silencios y baneos ----------

-- true si quien pregunta es miembro y sigue siendo amigo del otro (puede escribir). Con la cuenta silenciada
-- o baneada corta con el error 'user_muted' / 'user_banned' (mensajes y reacciones).
create or replace function public.social_can_send(conv uuid) returns boolean
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
       and public.are_friends(c.user_lo, c.user_hi));
end $$;

-- Antes de guardar: limite anti-spam, fechas del servidor, respuesta dentro de la misma conversacion, columnas fijas.
-- 0012: con la cuenta silenciada o baneada no se puede editar el texto de un mensaje (sí borrarlo).
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
    v_block := public.moderation_self_block();
    if v_block is not null then
      raise exception '%', v_block using errcode = 'P0001';
    end if;
    new.edited_at := now();
  else
    new.edited_at := old.edited_at;
  end if;
  return new;
end $$;

-- Enviar solicitud por codigo de amigo (VENUS-XXXXXX) o nombre de usuario exacto.
-- Devuelve { result: 'sent' | 'accepted' | 'already_sent' | 'already_friends', user_id }.
-- 0012: con la cuenta silenciada o baneada corta con 'user_muted' / 'user_banned'.
create or replace function public.social_send_friend_request(target text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  q text := btrim(coalesce(target, ''));
  other_id uuid;
  existing public.friendships%rowtype;
  pending_count int;
  v_block text;
begin
  if me is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  v_block := public.moderation_social_block(me);
  if v_block is not null then
    raise exception '%', v_block using errcode = 'P0001';
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

-- Señal efimera al buzon de un amigo (invitaciones de voz, modpacks, "unite a mi mundo", escribiendo...).
-- Viaja por Realtime Broadcast privado al canal "inbox:<amigo>"; el remitente lo pone el servidor.
-- 0012: con la cuenta silenciada o baneada corta con 'user_muted' / 'user_banned'.
create or replace function public.social_send_signal(target uuid, kind text, payload jsonb default '{}'::jsonb) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  v_block text;
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

-- ---------- Lecturas del panel (admins con sesión o service role) ----------

-- Resumen: usuarios, suscripciones por plan, MRR estimado y gasto de IA del mes.
-- MRR = suscripciones de Stripe que dan acceso (sin las de prueba) con el precio de ai_plan_prices que pagan
-- (o el price_usd del plan); los planes regalados por un admin o cargados a mano no suman. Sin descuentos.
create or replace function public.admin_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_month date := date_trunc('month', public.ai_local_now())::date;
  v_users jsonb;
  v_subs jsonb;
  v_mrr numeric;
  v_by_plan jsonb;
  v_ai jsonb;
  v_by_model jsonb;
begin
  perform public.admin_guard();

  select jsonb_build_object(
           'total', count(*),
           'new7d', count(*) filter (where u.created_at > now() - interval '7 days'),
           'new30d', count(*) filter (where u.created_at > now() - interval '30 days'),
           'confirmed', count(*) filter (where u.email_confirmed_at is not null),
           'banned', count(*) filter (where u.banned_until > now() or m.banned_until > now()),
           'muted', count(*) filter (where m.muted_until > now()),
           'admins', (select count(*) from public.app_admins)
         )
    into v_users
    from auth.users u
    left join public.user_moderation m on m.user_id = u.id
   where u.deleted_at is null;

  with subs as (
    select s.plan_id, s.source, s.status, s.stripe_status, s.cancel_at_period_end,
           coalesce(pp.unit_amount / 100.0, p.price_usd) as monthly_usd
      from public.ai_subscriptions s
      join public.ai_plans p on p.id = s.plan_id and p.active
      left join public.ai_plan_prices pp on pp.price_id = s.stripe_price_id
     where s.status in ('active', 'trialing')
       and (s.current_period_end is null or s.current_period_end > now())
  )
  select jsonb_build_object(
           'active', count(*),
           'paying', count(*) filter (where source = 'stripe' and status <> 'trialing'),
           'trialing', count(*) filter (where status = 'trialing'),
           'manual', count(*) filter (where source <> 'stripe'),
           'pastDue', count(*) filter (where stripe_status in ('past_due', 'unpaid')),
           'canceling', count(*) filter (where cancel_at_period_end)
         ),
         coalesce(sum(monthly_usd) filter (where source = 'stripe' and status <> 'trialing'), 0)
    into v_subs, v_mrr
    from subs;

  select coalesce(jsonb_agg(jsonb_build_object(
           'plan', p.id,
           'name', p.name,
           'planActive', p.active,
           'priceUsd', p.price_usd,
           'active', coalesce(c.active, 0),
           'paying', coalesce(c.paying, 0),
           'manual', coalesce(c.manual, 0),
           'mrrUsd', round(coalesce(c.mrr, 0), 2)
         ) order by p.sort, p.id), '[]'::jsonb)
    into v_by_plan
    from public.ai_plans p
    left join lateral (
      select count(*) as active,
             count(*) filter (where s.source = 'stripe' and s.status <> 'trialing') as paying,
             count(*) filter (where s.source <> 'stripe') as manual,
             sum(coalesce(pp.unit_amount / 100.0, p.price_usd)) filter (where s.source = 'stripe' and s.status <> 'trialing') as mrr
        from public.ai_subscriptions s
        left join public.ai_plan_prices pp on pp.price_id = s.stripe_price_id
       where s.plan_id = p.id
         and s.status in ('active', 'trialing')
         and (s.current_period_end is null or s.current_period_end > now())
    ) c on true
   where p.active or coalesce(c.active, 0) > 0;

  select jsonb_build_object(
           'monthUsd', round(coalesce(sum(d.cost_usd), 0), 4),
           'monthQuestions', coalesce(sum(d.questions), 0),
           'monthCalls', coalesce(sum(d.calls), 0),
           'activeUsers', count(distinct d.user_id)
         )
    into v_ai
    from public.ai_usage_model_daily d
   where d.day >= v_month;

  select coalesce(jsonb_agg(jsonb_build_object(
           'model', x.model_id,
           'label', coalesce(m.label, x.model_id),
           'usd', round(x.usd, 4),
           'questions', x.questions,
           'calls', x.calls
         ) order by x.usd desc, x.model_id), '[]'::jsonb)
    into v_by_model
    from (
      select d.model_id, sum(d.cost_usd) as usd, sum(d.questions) as questions, sum(d.calls) as calls
        from public.ai_usage_model_daily d
       where d.day >= v_month
       group by d.model_id
    ) x
    left join public.ai_models m on m.id = x.model_id;

  return jsonb_build_object(
    'users', v_users,
    'subscriptions', v_subs || jsonb_build_object('byPlan', v_by_plan),
    'revenue', jsonb_build_object('mrrUsd', round(v_mrr, 2), 'currency', 'usd'),
    'ai', v_ai || jsonb_build_object('byModel', v_by_model, 'since', v_month),
    'generatedAt', public.admin_iso(now())
  );
end $$;

-- Lista de usuarios con perfil, plan, uso del mes y moderación (paginada).
--   p_search: email, nombre de usuario, nombre visible, código de amigo, nombre de Minecraft o id exacto.
--   p_plan: id de plan (con acceso hoy) o 'none' (sin plan vigente).
--   p_status: 'active' | 'inactive' | 'none' | 'past_due' | 'canceling' | 'stripe' | 'manual'.
--   p_banned / p_muted: true o false (null = todos).
--   p_sort: 'created' (por defecto) | 'lastSignIn' | 'spend' | 'email'.
-- Devuelve { total, page, perPage, users: [...] }.
create or replace function public.admin_list_users(
  p_search text default null,
  p_plan text default null,
  p_status text default null,
  p_banned boolean default null,
  p_muted boolean default null,
  p_sort text default 'created',
  p_page integer default 1,
  p_per_page integer default 25
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_per integer := least(greatest(coalesce(p_per_page, 25), 1), 100);
  v_q text := nullif(btrim(coalesce(p_search, '')), '');
  v_like text;
  v_uuid uuid;
  v_sort text := coalesce(p_sort, 'created');
  v_month date := date_trunc('month', public.ai_local_now())::date;
  v_total bigint;
  v_rows jsonb;
begin
  perform public.admin_guard();
  if v_q is not null then
    if char_length(v_q) > 100 then
      raise exception 'admin_list_users: búsqueda demasiado larga' using errcode = '22023';
    end if;
    v_like := '%' || replace(replace(replace(lower(v_q), '\', '\\'), '%', '\%'), '_', '\_') || '%';
    if v_q ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      v_uuid := v_q::uuid;
    end if;
  end if;
  if p_status is not null and p_status not in ('active', 'inactive', 'none', 'past_due', 'canceling', 'stripe', 'manual') then
    raise exception 'admin_list_users: estado inválido' using errcode = '22023';
  end if;
  if v_sort not in ('created', 'lastSignIn', 'spend', 'email') then
    v_sort := 'created';
  end if;

  with base as (
    select u.id, u.email, u.created_at, u.last_sign_in_at, u.email_confirmed_at,
           u.banned_until as auth_banned_until,
           pr.username, pr.display_name, pr.friend_code, pr.mc_name,
           s.user_id is not null as has_row,
           s.plan_id, s.status as sub_status, s.source, s.current_period_end, s.cancel_at_period_end,
           s.stripe_status, s.stripe_subscription_id,
           pl.name as plan_name,
           coalesce(s.status in ('active', 'trialing')
                    and (s.current_period_end is null or s.current_period_end > now())
                    and pl.active, false) as has_access,
           m.banned_until, m.ban_reason, m.muted_until,
           coalesce(us.usd, 0) as month_usd,
           coalesce(us.questions, 0) as month_questions,
           exists (select 1 from public.app_admins a where a.user_id = u.id) as is_admin
      from auth.users u
      left join public.profiles pr on pr.id = u.id
      left join public.ai_subscriptions s on s.user_id = u.id
      left join public.ai_plans pl on pl.id = s.plan_id
      left join public.user_moderation m on m.user_id = u.id
      left join lateral (
        select sum(d.cost_usd) as usd, sum(d.questions) as questions
          from public.ai_usage_model_daily d
         where d.user_id = u.id and d.day >= v_month
      ) us on true
     where u.deleted_at is null
       and (v_q is null
            or u.id = v_uuid
            or lower(coalesce(u.email, '')) like v_like escape '\'
            or lower(coalesce(pr.username, '')) like v_like escape '\'
            or lower(coalesce(pr.display_name, '')) like v_like escape '\'
            or lower(coalesce(pr.friend_code, '')) like v_like escape '\'
            or lower(coalesce(pr.mc_name, '')) like v_like escape '\')
  ),
  filtered as (
    select b.*,
           (coalesce(b.banned_until > now(), false) or coalesce(b.auth_banned_until > now(), false)) as is_banned,
           coalesce(b.muted_until > now(), false) as is_muted
      from base b
     where (p_plan is null
            or (p_plan = 'none' and not b.has_access)
            or (b.plan_id = p_plan and b.has_access))
       and (p_status is null
            or (p_status = 'active' and b.has_access)
            or (p_status = 'inactive' and b.has_row and not b.has_access)
            or (p_status = 'none' and not b.has_row)
            or (p_status = 'past_due' and b.stripe_status in ('past_due', 'unpaid'))
            or (p_status = 'canceling' and b.has_access and coalesce(b.cancel_at_period_end, false))
            or (p_status = 'stripe' and b.has_access and b.source = 'stripe')
            or (p_status = 'manual' and b.has_access and b.source <> 'stripe'))
       and (p_banned is null
            or p_banned = (coalesce(b.banned_until > now(), false) or coalesce(b.auth_banned_until > now(), false)))
       and (p_muted is null or p_muted = coalesce(b.muted_until > now(), false))
  ),
  page as (
    select f.*,
           row_number() over (
             order by
               case when v_sort = 'email' then lower(f.email) end asc nulls last,
               case when v_sort = 'lastSignIn' then f.last_sign_in_at end desc nulls last,
               case when v_sort = 'spend' then f.month_usd end desc nulls last,
               f.created_at desc,
               f.id
           ) as rn
      from filtered f
     order by rn
     limit v_per offset (v_page - 1) * v_per
  )
  select (select count(*) from filtered),
         coalesce((
           select jsonb_agg(jsonb_build_object(
                    'id', g.id,
                    'email', g.email,
                    'emailConfirmed', g.email_confirmed_at is not null,
                    'createdAt', public.admin_iso(g.created_at),
                    'lastSignInAt', public.admin_iso(g.last_sign_in_at),
                    'username', g.username,
                    'displayName', g.display_name,
                    'friendCode', g.friend_code,
                    'mcName', g.mc_name,
                    'isAdmin', g.is_admin,
                    'plan', case when g.has_row then jsonb_build_object(
                              'id', g.plan_id,
                              'name', g.plan_name,
                              'status', g.sub_status,
                              'active', g.has_access,
                              'source', g.source,
                              'currentPeriodEnd', public.admin_iso(g.current_period_end),
                              'cancelAtPeriodEnd', coalesce(g.cancel_at_period_end, false),
                              'stripeStatus', g.stripe_status,
                              'managedByStripe', coalesce(g.source = 'stripe' and g.stripe_subscription_id is not null, false)
                            ) end,
                    'usage', jsonb_build_object('monthUsd', round(g.month_usd, 4), 'monthQuestions', g.month_questions),
                    'moderation', jsonb_build_object(
                      'banned', g.is_banned,
                      'bannedUntil', public.admin_iso(case when g.is_banned then greatest(g.banned_until, g.auth_banned_until) end),
                      'banReason', case when g.is_banned then g.ban_reason end,
                      'muted', g.is_muted,
                      'mutedUntil', public.admin_iso(case when g.is_muted then g.muted_until end)
                    )
                  ) order by g.rn)
             from page g
         ), '[]'::jsonb)
    into v_total, v_rows;

  return jsonb_build_object('total', v_total, 'page', v_page, 'perPage', v_per, 'users', v_rows);
end $$;

-- Ficha completa de un usuario (null si no existe): cuenta, perfil, plan con los ids de Stripe, uso de IA de hoy,
-- la semana y el mes por modelo (con la cuota QuotaV2), moderación (con notas) y las últimas 20 acciones de admins.
create or replace function public.admin_user_detail(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_now timestamp := public.ai_local_now();
  v_today date := v_now::date;
  v_week date := date_trunc('week', v_now)::date;
  v_month date := date_trunc('month', v_now)::date;
  v_account jsonb;
  v_profile jsonb;
  v_sub jsonb;
  v_customer jsonb;
  v_models jsonb;
  v_totals jsonb;
  v_moderation jsonb;
  v_actions jsonb;
begin
  perform public.admin_guard();
  if p_user is null then
    raise exception 'admin_user_detail: falta el usuario' using errcode = '22023';
  end if;

  select jsonb_build_object(
           'id', u.id,
           'email', u.email,
           'emailConfirmed', u.email_confirmed_at is not null,
           'emailConfirmedAt', public.admin_iso(u.email_confirmed_at),
           'createdAt', public.admin_iso(u.created_at),
           'lastSignInAt', public.admin_iso(u.last_sign_in_at),
           'bannedUntil', public.admin_iso(case when u.banned_until > now() then u.banned_until end),
           'providers', coalesce(u.raw_app_meta_data -> 'providers', '[]'::jsonb),
           'isAdmin', public.admin_is_admin_user(u.id)
         )
    into v_account
    from auth.users u
   where u.id = p_user;
  if v_account is null then
    return null;
  end if;

  select jsonb_build_object(
           'username', p.username,
           'displayName', p.display_name,
           'friendCode', p.friend_code,
           'mcName', p.mc_name,
           'mcUuid', p.mc_uuid,
           'bio', p.bio,
           'badges', to_jsonb(p.badges),
           'status', p.status,
           'statusText', p.status_text,
           'lastSeen', public.admin_iso(p.last_seen),
           'createdAt', public.admin_iso(p.created_at)
         )
    into v_profile
    from public.profiles p
   where p.id = p_user;

  select jsonb_build_object(
           'planId', s.plan_id,
           'planName', p.name,
           'status', s.status,
           'active', coalesce(s.status in ('active', 'trialing')
                              and (s.current_period_end is null or s.current_period_end > now())
                              and p.active, false),
           'source', s.source,
           'currentPeriodEnd', public.admin_iso(s.current_period_end),
           'cancelAtPeriodEnd', coalesce(s.cancel_at_period_end, false),
           'graceUntil', public.admin_iso(s.grace_until),
           'stripeStatus', s.stripe_status,
           'stripeCustomerId', s.stripe_customer_id,
           'stripeSubscriptionId', s.stripe_subscription_id,
           'stripePriceId', s.stripe_price_id,
           'managedByStripe', coalesce(s.source = 'stripe' and s.stripe_subscription_id is not null, false),
           'lastSyncedAt', public.admin_iso(s.last_synced_at),
           'createdAt', public.admin_iso(s.created_at),
           'updatedAt', public.admin_iso(s.updated_at)
         )
    into v_sub
    from public.ai_subscriptions s
    left join public.ai_plans p on p.id = s.plan_id
   where s.user_id = p_user;

  select jsonb_build_object('customerId', c.customer_id, 'livemode', c.livemode)
    into v_customer
    from public.stripe_customers c
   where c.user_id = p_user;

  with per_model as (
    select d.model_id,
           coalesce(sum(d.cost_usd) filter (where d.day = v_today), 0) as today_usd,
           coalesce(sum(d.questions) filter (where d.day = v_today), 0) as today_q,
           coalesce(sum(d.calls) filter (where d.day = v_today), 0) as today_calls,
           coalesce(sum(d.cost_usd) filter (where d.day >= v_week), 0) as week_usd,
           coalesce(sum(d.questions) filter (where d.day >= v_week), 0) as week_q,
           coalesce(sum(d.calls) filter (where d.day >= v_week), 0) as week_calls,
           coalesce(sum(d.cost_usd) filter (where d.day >= v_month), 0) as month_usd,
           coalesce(sum(d.questions) filter (where d.day >= v_month), 0) as month_q,
           coalesce(sum(d.calls) filter (where d.day >= v_month), 0) as month_calls,
           coalesce(sum(d.input_tokens + d.output_tokens + d.cache_read_tokens + d.cache_write_tokens) filter (where d.day >= v_month), 0) as month_tokens
      from public.ai_usage_model_daily d
     where d.user_id = p_user
       and d.day >= least(v_week, v_month)
     group by d.model_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'model', x.model_id,
           'label', coalesce(m.label, x.model_id),
           'today', jsonb_build_object('usd', round(x.today_usd, 4), 'questions', x.today_q, 'calls', x.today_calls),
           'week', jsonb_build_object('usd', round(x.week_usd, 4), 'questions', x.week_q, 'calls', x.week_calls),
           'month', jsonb_build_object('usd', round(x.month_usd, 4), 'questions', x.month_q, 'calls', x.month_calls, 'tokens', x.month_tokens)
         ) order by coalesce(m.sort, 100), x.model_id), '[]'::jsonb),
         jsonb_build_object(
           'today', jsonb_build_object('usd', round(coalesce(sum(x.today_usd), 0), 4), 'questions', coalesce(sum(x.today_q), 0), 'calls', coalesce(sum(x.today_calls), 0)),
           'week', jsonb_build_object('usd', round(coalesce(sum(x.week_usd), 0), 4), 'questions', coalesce(sum(x.week_q), 0), 'calls', coalesce(sum(x.week_calls), 0)),
           'month', jsonb_build_object('usd', round(coalesce(sum(x.month_usd), 0), 4), 'questions', coalesce(sum(x.month_q), 0), 'calls', coalesce(sum(x.month_calls), 0))
         )
    into v_models, v_totals
    from per_model x
    left join public.ai_models m on m.id = x.model_id;

  select jsonb_build_object(
           'banned', coalesce(m.banned_until > now(), false),
           'bannedUntil', public.admin_iso(case when m.banned_until > now() then m.banned_until end),
           'banReason', m.ban_reason,
           'muted', coalesce(m.muted_until > now(), false),
           'mutedUntil', public.admin_iso(case when m.muted_until > now() then m.muted_until end),
           'muteReason', m.mute_reason,
           'notes', m.notes,
           'updatedBy', m.updated_by,
           'updatedByEmail', ub.email,
           'updatedAt', public.admin_iso(m.updated_at)
         )
    into v_moderation
    from public.user_moderation m
    left join auth.users ub on ub.id = m.updated_by
   where m.user_id = p_user;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', a.id,
           'action', a.action,
           'adminId', a.admin_id,
           'adminEmail', a.admin_email,
           'details', a.details,
           'createdAt', public.admin_iso(a.created_at)
         ) order by a.created_at desc, a.id desc), '[]'::jsonb)
    into v_actions
    from (
      select * from public.admin_actions x
       where x.target_user = p_user
       order by x.created_at desc, x.id desc
       limit 20
    ) a;

  return jsonb_build_object(
    'account', v_account,
    'profile', v_profile,
    'subscription', v_sub,
    'stripeCustomer', v_customer,
    'usage', jsonb_build_object('models', v_models, 'totals', v_totals, 'quota', public.ai_quota_status(p_user)),
    'moderation', coalesce(v_moderation, jsonb_build_object('banned', false, 'muted', false)),
    'actions', v_actions
  );
end $$;

-- Un plan con sus modelos, precios de Stripe (todos, también los inactivos) y suscriptores con acceso.
create or replace function public.admin_plan_json(p_plan text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
           'id', p.id,
           'name', p.name,
           'active', p.active,
           'sort', p.sort,
           'priceUsd', p.price_usd,
           'currency', p.currency,
           'monthlyBudgetUsd', p.monthly_budget_usd,
           'maxTokensPerRequest', p.max_tokens_per_request,
           'maxCallsPerTurn', p.max_calls_per_turn,
           'requestsPerMinute', p.requests_per_minute,
           'subscribers', (
             select count(*) from public.ai_subscriptions s
              where s.plan_id = p.id
                and s.status in ('active', 'trialing')
                and (s.current_period_end is null or s.current_period_end > now())),
           'models', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'id', pm.model_id,
                      'label', m.label,
                      'modelActive', m.active,
                      'efforts', public.ai_effort_list(pm.efforts),
                      'daily', pm.daily_questions,
                      'weekly', pm.weekly_questions,
                      'sort', pm.sort
                    ) order by pm.sort, m.sort, m.id)
               from public.ai_plan_models pm
               join public.ai_models m on m.id = pm.model_id
              where pm.plan_id = p.id), '[]'::jsonb),
           'prices', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'priceId', pp.price_id,
                      'amount', pp.unit_amount,
                      'currency', pp.currency,
                      'interval', pp."interval",
                      'livemode', pp.livemode,
                      'active', pp.active,
                      'lookupKey', pp.lookup_key,
                      'createdAt', public.admin_iso(pp.created_at)
                    ) order by pp.active desc, pp.created_at desc)
               from public.ai_plan_prices pp
              where pp.plan_id = p.id), '[]'::jsonb)
         )
    from public.ai_plans p
   where p.id = p_plan
$$;

-- Todos los planes (también los inactivos) y los modelos que se pueden ofrecer. { plans: [...], models: [...] }
create or replace function public.admin_plans() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.admin_guard();
  return jsonb_build_object(
    'plans', coalesce((select jsonb_agg(public.admin_plan_json(p.id) order by p.sort, p.id) from public.ai_plans p), '[]'::jsonb),
    'models', coalesce((
      select jsonb_agg(jsonb_build_object('id', m.id, 'label', m.label, 'active', m.active) order by m.sort, m.id)
        from public.ai_models m
       where m.active), '[]'::jsonb)
  );
end $$;

-- Registro de acciones con filtros. p_action: exacta ('users.ban') o un grupo terminado en punto ('users.').
-- { total, page, perPage, actions: [{ id, action, adminId, adminEmail, targetUser, targetEmail, targetUsername, details, createdAt }] }
create or replace function public.admin_list_actions(
  p_action text default null,
  p_admin uuid default null,
  p_target uuid default null,
  p_since timestamptz default null,
  p_until timestamptz default null,
  p_page integer default 1,
  p_per_page integer default 50
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_per integer := least(greatest(coalesce(p_per_page, 50), 1), 200);
  v_action text := nullif(btrim(coalesce(p_action, '')), '');
  v_total bigint;
  v_rows jsonb;
begin
  perform public.admin_guard();
  if v_action is not null and v_action !~ '^[a-z][A-Za-z]{1,30}(\.([A-Za-z]{1,30})?)?$' then
    raise exception 'admin_list_actions: acción inválida' using errcode = '22023';
  end if;

  with filtered as (
    select a.*
      from public.admin_actions a
     where (v_action is null
            or (right(v_action, 1) = '.' and left(a.action, char_length(v_action)) = v_action)
            or a.action = v_action)
       and (p_admin is null or a.admin_id = p_admin)
       and (p_target is null or a.target_user = p_target)
       and (p_since is null or a.created_at >= p_since)
       and (p_until is null or a.created_at < p_until)
  ),
  page as (
    select f.*
      from filtered f
     order by f.created_at desc, f.id desc
     limit v_per offset (v_page - 1) * v_per
  )
  select (select count(*) from filtered),
         coalesce((
           select jsonb_agg(jsonb_build_object(
                    'id', g.id,
                    'action', g.action,
                    'adminId', g.admin_id,
                    'adminEmail', g.admin_email,
                    'targetUser', g.target_user,
                    'targetEmail', tu.email,
                    'targetUsername', tp.username,
                    'details', g.details,
                    'createdAt', public.admin_iso(g.created_at)
                  ) order by g.created_at desc, g.id desc)
             from page g
             left join auth.users tu on tu.id = g.target_user
             left join public.profiles tp on tp.id = g.target_user
         ), '[]'::jsonb)
    into v_total, v_rows;

  return jsonb_build_object('total', v_total, 'page', v_page, 'perPage', v_per, 'actions', v_rows);
end $$;

-- ---------- Escrituras (solo la service role: las llama la Edge Function "admin") ----------

-- Lo que hace falta saber de cada usuario antes de una acción en lote (en el orden pedido).
-- [{ id, exists, email, username, isAdmin, planId, status, source, hasAccess, stripeSubscriptionId,
--    stripeStatus, customerId, customerLivemode }]
create or replace function public.admin_targets(p_ids uuid[]) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', i.id,
           'exists', u.id is not null,
           'email', u.email,
           'username', p.username,
           'isAdmin', public.admin_is_admin_user(i.id),
           'planId', s.plan_id,
           'status', s.status,
           'source', s.source,
           'hasAccess', coalesce(s.status in ('active', 'trialing')
                                 and (s.current_period_end is null or s.current_period_end > now()), false),
           'stripeSubscriptionId', s.stripe_subscription_id,
           'stripeStatus', s.stripe_status,
           'customerId', c.customer_id,
           'customerLivemode', c.livemode
         ) order by i.ord), '[]'::jsonb)
    from unnest(p_ids) with ordinality as i (id, ord)
    left join auth.users u on u.id = i.id and u.deleted_at is null
    left join public.profiles p on p.id = i.id
    left join public.ai_subscriptions s on s.user_id = i.id
    left join public.stripe_customers c on c.user_id = i.id
$$;

-- Plan asignado por un admin (source 'admin'): activo hasta p_until (null = sin vencimiento). Como los planes
-- manuales de docs/pagos.md, deja vacías las columnas de Stripe: un evento viejo de una suscripción cancelada no
-- lo pisa, pero una suscripción de Stripe que sigue activa sí lo reemplaza en su próximo evento.
-- Devuelve { applied, reason?, previous }.
create or replace function public.admin_set_plan(p_user uuid, p_plan text, p_until timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_prev public.ai_subscriptions%rowtype;
  v_found boolean;
begin
  if p_user is null or p_plan is null then
    raise exception 'admin_set_plan: parámetros inválidos' using errcode = '22023';
  end if;
  if p_until is not null and p_until <= now() then
    raise exception 'admin_set_plan: la fecha de fin ya pasó' using errcode = '22023';
  end if;
  if not exists (select 1 from auth.users u where u.id = p_user) then
    return jsonb_build_object('applied', false, 'reason', 'not_found');
  end if;
  if not exists (select 1 from public.ai_plans p where p.id = p_plan and p.active) then
    return jsonb_build_object('applied', false, 'reason', 'unknown_plan');
  end if;

  -- El mismo candado que usan billing y el webhook: un solo cambio a la vez por usuario.
  perform pg_advisory_xact_lock(hashtext('venus-billing:' || p_user::text));
  select s.* into v_prev from public.ai_subscriptions s where s.user_id = p_user for update;
  v_found := found;

  insert into public.ai_subscriptions as s (user_id, plan_id, status, current_period_end, source)
  values (p_user, p_plan, 'active', p_until, 'admin')
  on conflict (user_id) do update
    set plan_id = excluded.plan_id,
        status = 'active',
        current_period_end = excluded.current_period_end,
        source = 'admin',
        external_ref = null,
        stripe_subscription_id = null,
        stripe_price_id = null,
        stripe_status = null,
        grace_until = null,
        cancel_at_period_end = false,
        last_synced_at = null;

  return jsonb_build_object(
    'applied', true,
    'previous', case when v_found then jsonb_build_object(
      'planId', v_prev.plan_id,
      'status', v_prev.status,
      'source', v_prev.source,
      'currentPeriodEnd', public.admin_iso(v_prev.current_period_end),
      'stripeSubscriptionId', v_prev.stripe_subscription_id,
      'stripeStatus', v_prev.stripe_status
    ) end
  );
end $$;

-- Quita el plan (queda 'canceled', source 'admin'). Devuelve { applied, reason?, previous }.
create or replace function public.admin_remove_plan(p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_prev public.ai_subscriptions%rowtype;
begin
  if p_user is null then
    raise exception 'admin_remove_plan: parámetros inválidos' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('venus-billing:' || p_user::text));
  select s.* into v_prev from public.ai_subscriptions s where s.user_id = p_user for update;
  if not found then
    return jsonb_build_object('applied', false, 'reason', 'no_plan');
  end if;

  update public.ai_subscriptions s
     set status = 'canceled',
         source = 'admin',
         current_period_end = least(coalesce(s.current_period_end, now()), now()),
         external_ref = null,
         stripe_subscription_id = null,
         stripe_price_id = null,
         stripe_status = null,
         grace_until = null,
         cancel_at_period_end = false,
         last_synced_at = null
   where s.user_id = p_user;

  return jsonb_build_object(
    'applied', true,
    'previous', jsonb_build_object(
      'planId', v_prev.plan_id,
      'status', v_prev.status,
      'source', v_prev.source,
      'currentPeriodEnd', public.admin_iso(v_prev.current_period_end),
      'stripeSubscriptionId', v_prev.stripe_subscription_id,
      'stripeStatus', v_prev.stripe_status
    )
  );
end $$;

-- Cambia la moderación de un usuario. p_patch solo trae las claves que cambian:
-- banned_until, ban_reason, muted_until, mute_reason, notes (null borra). Devuelve { applied, reason?, moderation }.
create or replace function public.admin_moderate(p_user uuid, p_patch jsonb, p_admin uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.user_moderation%rowtype;
begin
  if p_user is null or p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'admin_moderate: parámetros inválidos' using errcode = '22023';
  end if;
  if not exists (select 1 from auth.users u where u.id = p_user) then
    return jsonb_build_object('applied', false, 'reason', 'not_found');
  end if;

  insert into public.user_moderation as m (user_id, banned_until, ban_reason, muted_until, mute_reason, notes, updated_by, updated_at)
  values (
    p_user,
    (p_patch ->> 'banned_until')::timestamptz,
    left(p_patch ->> 'ban_reason', 500),
    (p_patch ->> 'muted_until')::timestamptz,
    left(p_patch ->> 'mute_reason', 500),
    left(p_patch ->> 'notes', 2000),
    p_admin,
    now()
  )
  on conflict (user_id) do update
    set banned_until = case when p_patch ? 'banned_until' then excluded.banned_until else m.banned_until end,
        ban_reason = case when p_patch ? 'ban_reason' then excluded.ban_reason else m.ban_reason end,
        muted_until = case when p_patch ? 'muted_until' then excluded.muted_until else m.muted_until end,
        mute_reason = case when p_patch ? 'mute_reason' then excluded.mute_reason else m.mute_reason end,
        notes = case when p_patch ? 'notes' then excluded.notes else m.notes end,
        updated_by = excluded.updated_by,
        updated_at = now()
  returning m.* into v_row;

  return jsonb_build_object(
    'applied', true,
    'moderation', jsonb_build_object(
      'bannedUntil', public.admin_iso(v_row.banned_until),
      'banReason', v_row.ban_reason,
      'mutedUntil', public.admin_iso(v_row.muted_until),
      'muteReason', v_row.mute_reason,
      'notes', v_row.notes
    )
  );
end $$;

-- Cierra todas las sesiones del usuario: borra sus sesiones (y con ellas los refresh tokens) y revoca los tokens
-- sueltos. Los tokens de acceso ya emitidos valen hasta que vencen (1 hora por defecto). Devuelve las sesiones borradas.
create or replace function public.admin_revoke_sessions(p_user uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer := 0;
begin
  if p_user is null then
    raise exception 'admin_revoke_sessions: falta el usuario' using errcode = '22023';
  end if;
  delete from auth.sessions s where s.user_id = p_user;
  get diagnostics v_count = row_count;
  update auth.refresh_tokens r set revoked = true where r.user_id = p_user::text and not coalesce(r.revoked, false);
  return v_count;
end $$;

-- Reinicia los contadores de preguntas de la IA de hoy o de la semana (no toca el gasto en dólares, que es el
-- historial real de costos). También vacía la ventana de llamadas por minuto. Devuelve las filas cambiadas.
create or replace function public.admin_reset_usage(p_user uuid, p_scope text) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamp := public.ai_local_now();
  v_from date;
  v_count integer := 0;
begin
  if p_user is null or p_scope is null or p_scope not in ('today', 'week') then
    raise exception 'admin_reset_usage: parámetros inválidos' using errcode = '22023';
  end if;
  v_from := case p_scope when 'today' then v_now::date else date_trunc('week', v_now)::date end;
  update public.ai_usage_model_daily d
     set questions = 0,
         updated_at = now()
   where d.user_id = p_user
     and d.day >= v_from
     and d.questions > 0;
  get diagnostics v_count = row_count;
  delete from public.ai_rate r where r.user_id = p_user;
  return v_count;
end $$;

-- Agrega una entrada al registro. Devuelve su id.
create or replace function public.admin_log(p_admin uuid, p_admin_email text, p_action text, p_target uuid, p_details jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_id bigint;
begin
  insert into public.admin_actions (admin_id, admin_email, action, target_user, details)
  values (p_admin, left(p_admin_email, 254), p_action, p_target, coalesce(p_details, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end $$;

-- Edita un plan (solo la base: el precio de Stripe se cambia con la Edge Function). p_patch con las claves que
-- cambian: monthly_budget_usd, max_tokens_per_request, max_calls_per_turn, requests_per_minute, active,
-- price_usd y models: [{ model_id, efforts, daily_questions, weekly_questions, sort?, remove? }].
-- Los límites los validan los checks de las tablas. Devuelve el plan (admin_plan_json).
create or replace function public.admin_update_plan(p_plan text, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_item jsonb;
  v_models integer;
begin
  if p_plan is null or p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'admin_update_plan: parámetros inválidos' using errcode = '22023';
  end if;
  if not exists (select 1 from public.ai_plans p where p.id = p_plan) then
    raise exception 'admin_update_plan: plan desconocido' using errcode = 'P0002';
  end if;

  update public.ai_plans p
     set monthly_budget_usd = case when p_patch ? 'monthly_budget_usd' then (p_patch ->> 'monthly_budget_usd')::numeric else p.monthly_budget_usd end,
         max_tokens_per_request = case when p_patch ? 'max_tokens_per_request' then (p_patch ->> 'max_tokens_per_request')::integer else p.max_tokens_per_request end,
         max_calls_per_turn = case when p_patch ? 'max_calls_per_turn' then (p_patch ->> 'max_calls_per_turn')::integer else p.max_calls_per_turn end,
         requests_per_minute = case when p_patch ? 'requests_per_minute' then (p_patch ->> 'requests_per_minute')::integer else p.requests_per_minute end,
         active = case when p_patch ? 'active' then (p_patch ->> 'active')::boolean else p.active end,
         price_usd = case when p_patch ? 'price_usd' then (p_patch ->> 'price_usd')::numeric else p.price_usd end
   where p.id = p_plan;

  if p_patch ? 'models' then
    if jsonb_typeof(p_patch -> 'models') <> 'array' then
      raise exception 'admin_update_plan: models tiene que ser una lista' using errcode = '22023';
    end if;
    for v_item in select e.item from jsonb_array_elements(p_patch -> 'models') as e (item) loop
      if jsonb_typeof(v_item) <> 'object' or coalesce(v_item ->> 'model_id', '') = '' then
        raise exception 'admin_update_plan: modelo inválido' using errcode = '22023';
      end if;
      if coalesce((v_item ->> 'remove')::boolean, false) then
        delete from public.ai_plan_models pm where pm.plan_id = p_plan and pm.model_id = v_item ->> 'model_id';
      else
        if jsonb_typeof(v_item -> 'efforts') <> 'array' then
          raise exception 'admin_update_plan: esfuerzos inválidos' using errcode = '22023';
        end if;
        insert into public.ai_plan_models as pm (plan_id, model_id, efforts, daily_questions, weekly_questions, sort)
        values (
          p_plan,
          v_item ->> 'model_id',
          array(select jsonb_array_elements_text(v_item -> 'efforts')),
          (v_item ->> 'daily_questions')::integer,
          (v_item ->> 'weekly_questions')::integer,
          coalesce((v_item ->> 'sort')::integer, 100)
        )
        on conflict (plan_id, model_id) do update
          set efforts = excluded.efforts,
              daily_questions = excluded.daily_questions,
              weekly_questions = excluded.weekly_questions,
              sort = case when v_item ? 'sort' then excluded.sort else pm.sort end;
      end if;
    end loop;

    select count(*) into v_models
      from public.ai_plan_models pm
      join public.ai_models m on m.id = pm.model_id and m.active
     where pm.plan_id = p_plan;
    if v_models = 0 then
      raise exception 'admin_update_plan: el plan tiene que tener al menos un modelo' using errcode = '23514';
    end if;
  end if;

  return public.admin_plan_json(p_plan);
end $$;

-- Archivos del usuario en Storage (world-saves, screenshots y clips: carpeta <userId>/), hasta 1000 por bucket.
-- La Edge Function los borra con la API de Storage antes de borrar la cuenta. { "world-saves": [...], ... }
create or replace function public.admin_user_files(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_out jsonb := '{}'::jsonb;
  v_bucket text;
  v_names jsonb;
begin
  if p_user is null then
    raise exception 'admin_user_files: falta el usuario' using errcode = '22023';
  end if;
  if to_regclass('storage.objects') is null then
    return v_out;
  end if;
  foreach v_bucket in array array['world-saves', 'screenshots', 'clips'] loop
    select coalesce(jsonb_agg(x.name), '[]'::jsonb)
      into v_names
      from (
        select o.name
          from storage.objects o
         where o.bucket_id = v_bucket
           and split_part(o.name, '/', 1) = p_user::text
         order by o.name
         limit 1000
      ) x;
    v_out := v_out || jsonb_build_object(v_bucket, v_names);
  end loop;
  return v_out;
end $$;

-- ---------- Permisos de las funciones ----------
-- Postgres y Supabase dan EXECUTE a todos por defecto: se quita y se da solo a quien corresponde.

revoke all on function public.admin_iso(timestamptz) from public, anon, authenticated;
revoke all on function public.admin_is_admin_user(uuid) from public, anon, authenticated;
revoke all on function public.is_admin() from public, anon;
revoke all on function public.admin_guard() from public, anon, authenticated;
revoke all on function public.admin_sync_all() from public, anon, authenticated;
revoke all on function public.admin_sync_user() from public, anon, authenticated;
revoke all on function public.admin_sync_emails() from public, anon, authenticated;
revoke all on function public.moderation_social_block(uuid) from public, anon, authenticated;
revoke all on function public.moderation_self_block() from public, anon;
revoke all on function public.my_moderation() from public, anon;
revoke all on function public.admin_overview() from public, anon;
revoke all on function public.admin_list_users(text, text, text, boolean, boolean, text, integer, integer) from public, anon;
revoke all on function public.admin_user_detail(uuid) from public, anon;
revoke all on function public.admin_plan_json(text) from public, anon, authenticated;
revoke all on function public.admin_plans() from public, anon;
revoke all on function public.admin_list_actions(text, uuid, uuid, timestamptz, timestamptz, integer, integer) from public, anon;
revoke all on function public.admin_targets(uuid[]) from public, anon, authenticated;
revoke all on function public.admin_set_plan(uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.admin_remove_plan(uuid) from public, anon, authenticated;
revoke all on function public.admin_moderate(uuid, jsonb, uuid) from public, anon, authenticated;
revoke all on function public.admin_revoke_sessions(uuid) from public, anon, authenticated;
revoke all on function public.admin_reset_usage(uuid, text) from public, anon, authenticated;
revoke all on function public.admin_log(uuid, text, text, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.admin_update_plan(text, jsonb) from public, anon, authenticated;
revoke all on function public.admin_user_files(uuid) from public, anon, authenticated;
-- Las funciones sociales reemplazadas conservan los permisos de 0002 (solo authenticated).
revoke all on function public.social_can_send(uuid) from public, anon;
revoke all on function public.social_send_friend_request(text) from public, anon;
revoke all on function public.social_send_signal(uuid, text, jsonb) from public, anon;
revoke all on function public.social_messages_before() from public, anon, authenticated;

grant execute on function public.admin_iso(timestamptz) to service_role;
grant execute on function public.admin_is_admin_user(uuid) to service_role;
grant execute on function public.is_admin() to authenticated, service_role;
grant execute on function public.admin_sync_all() to service_role;
grant execute on function public.moderation_social_block(uuid) to service_role;
grant execute on function public.moderation_self_block() to authenticated, service_role;
grant execute on function public.my_moderation() to authenticated, service_role;
grant execute on function public.admin_overview() to authenticated, service_role;
grant execute on function public.admin_list_users(text, text, text, boolean, boolean, text, integer, integer) to authenticated, service_role;
grant execute on function public.admin_user_detail(uuid) to authenticated, service_role;
grant execute on function public.admin_plan_json(text) to service_role;
grant execute on function public.admin_plans() to authenticated, service_role;
grant execute on function public.admin_list_actions(text, uuid, uuid, timestamptz, timestamptz, integer, integer) to authenticated, service_role;
grant execute on function public.admin_targets(uuid[]) to service_role;
grant execute on function public.admin_set_plan(uuid, text, timestamptz) to service_role;
grant execute on function public.admin_remove_plan(uuid) to service_role;
grant execute on function public.admin_moderate(uuid, jsonb, uuid) to service_role;
grant execute on function public.admin_revoke_sessions(uuid) to service_role;
grant execute on function public.admin_reset_usage(uuid, text) to service_role;
grant execute on function public.admin_log(uuid, text, text, uuid, jsonb) to service_role;
grant execute on function public.admin_update_plan(text, jsonb) to service_role;
grant execute on function public.admin_user_files(uuid) to service_role;
grant execute on function public.social_can_send(uuid) to authenticated;
grant execute on function public.social_send_friend_request(text) to authenticated;
grant execute on function public.social_send_signal(uuid, text, jsonb) to authenticated;

-- ---------- Políticas ----------

-- El registro lo leen solo los admins (nadie lo escribe desde el cliente).
drop policy if exists "admin_actions_select_admins" on public.admin_actions;
create policy "admin_actions_select_admins" on public.admin_actions
  for select to authenticated using ((select public.is_admin()));

-- ---------- Carga inicial ----------
-- Admins que ya existen (por ejemplo, la cuenta del dueño creada antes de esta migración).
select public.admin_sync_all();
