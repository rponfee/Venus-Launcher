-- 0045_soporte_mejoras.sql · Venus 4.6 · Soporte: categorías con campos propios, diagnóstico opcional, capturas,
-- valoración, reapertura, prioridad, asignación, notas internas y respuestas guardadas para el equipo.
-- Guía: docs/wip/soporte-46.md. Se aplica después de 0017 (y de 0037). Idempotente.
--
-- Parte de las funciones que hoy están en producción (leídas con pg_get_functiondef: 0016 + 0017):
--   * support_open_ticket(text,text,text), support_list_tickets(boolean), support_ticket_detail(uuid),
--     support_add_message(uuid,text) y support_resolve_ticket(uuid,boolean,text) conservan firma y errores; solo
--     SUMAN campos al JSON y avisos legibles por máquina en `hint` (el texto sigue en español para los launchers
--     viejos). support_create_ticket (planes por ticket) NO se toca: sigue cerrada desde 0017 y los pagos van por
--     payment_orders, como hoy.
--   * Nuevo: support_submit_ticket (con campos propios y diagnóstico), support_queue (cola del equipo con filtros),
--     support_staff_panel / support_staff_list, support_assign, support_set_priority, support_add_note,
--     support_macros_list / support_macro_save / support_macro_delete, support_mark_seen, support_unread_summary,
--     support_reopen_ticket, support_close_own_ticket, support_rate_ticket, support_set_diagnostic,
--     support_register_attachments y support_attachment_info.
--   * Capturas: bucket privado support-attachments (png, jpeg y webp de hasta 4 MiB). Se sube a
--     <usuario>/<consulta>/<uuid>.<ext>; solo la persona que sube, el dueño de la consulta y el equipo las leen.
--   * Notas internas y respuestas guardadas viven en tablas sin ningún permiso directo: solo las funciones del equipo.
--
-- Topes (servidor): 3 consultas abiertas y 5 por día (como hoy); 10 mensajes por minuto, 500 por consulta y
-- 150 por día; 3 capturas por envío, 12 por consulta y 15 por día; 60 archivos por persona en el bucket;
-- diagnóstico de hasta 12000 caracteres; reabrir hasta 3 veces y dentro de los 14 días de cerrada.

-- ---------- 1) Columnas nuevas de support_tickets ----------
alter table public.support_tickets
  add column if not exists priority text not null default 'normal',
  add column if not exists assigned_to uuid references auth.users(id) on delete set null,
  add column if not exists assigned_at timestamptz,
  add column if not exists details jsonb not null default '{}'::jsonb,
  add column if not exists diagnostic text,
  add column if not exists diagnostic_at timestamptz,
  add column if not exists last_user_message_at timestamptz,
  add column if not exists last_staff_reply_at timestamptz,
  add column if not exists user_seen_at timestamptz,
  add column if not exists rating smallint,
  add column if not exists rating_comment text,
  add column if not exists rated_at timestamptz,
  add column if not exists reopen_count smallint not null default 0;

alter table public.support_tickets drop constraint if exists support_tickets_category_check;
alter table public.support_tickets add constraint support_tickets_category_check
  check (category in ('general','account','payments','assistant','bug','game','suggestion','other'));
alter table public.support_tickets drop constraint if exists support_tickets_priority_check;
alter table public.support_tickets add constraint support_tickets_priority_check
  check (priority in ('low','normal','high','urgent'));
alter table public.support_tickets drop constraint if exists support_tickets_details_check;
alter table public.support_tickets add constraint support_tickets_details_check
  check (jsonb_typeof(details) = 'object' and pg_column_size(details) < 4096);
alter table public.support_tickets drop constraint if exists support_tickets_diagnostic_check;
alter table public.support_tickets add constraint support_tickets_diagnostic_check
  check (diagnostic is null or char_length(diagnostic) between 1 and 12000);
alter table public.support_tickets drop constraint if exists support_tickets_rating_check;
alter table public.support_tickets add constraint support_tickets_rating_check
  check (rating is null or rating between 1 and 5);
alter table public.support_tickets drop constraint if exists support_tickets_rating_comment_check;
alter table public.support_tickets add constraint support_tickets_rating_comment_check
  check (rating_comment is null or char_length(rating_comment) <= 500);
alter table public.support_tickets drop constraint if exists support_tickets_reopen_check;
alter table public.support_tickets add constraint support_tickets_reopen_check
  check (reopen_count between 0 and 10);

-- Las consultas que ya existen no aparecen como "sin leer": se parte de ahora.
update public.support_tickets t set
  last_user_message_at = coalesce(t.last_user_message_at,
    (select max(m.created_at) from public.support_messages m where m.ticket_id = t.id and not m.is_admin), t.created_at),
  last_staff_reply_at = coalesce(t.last_staff_reply_at,
    (select max(m.created_at) from public.support_messages m where m.ticket_id = t.id and m.is_admin)),
  user_seen_at = coalesce(t.user_seen_at, now())
where t.last_user_message_at is null or t.user_seen_at is null;

create index if not exists support_tickets_queue2 on public.support_tickets (status, priority, updated_at desc);
create index if not exists support_tickets_owner on public.support_tickets (user_id, updated_at desc);
create index if not exists support_tickets_assignee on public.support_tickets (assigned_to) where status in ('open', 'in_progress');
create index if not exists support_messages_author on public.support_messages (author_id, created_at desc);

-- code marca los mensajes del sistema (cierre, reapertura) para que el launcher los muestre en el idioma de cada persona.
alter table public.support_messages add column if not exists code text;
alter table public.support_messages drop constraint if exists support_messages_code_check;
alter table public.support_messages add constraint support_messages_code_check
  check (code is null or code in ('closed', 'closed_self', 'reopened'));

-- ---------- 2) Tablas nuevas (sin permisos directos: todo pasa por las funciones de abajo) ----------
create table if not exists public.support_attachments (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.support_tickets(id) on delete cascade,
  message_id uuid references public.support_messages(id) on delete cascade,
  uploader_id uuid references auth.users(id) on delete set null,
  path text not null unique check (char_length(path) between 40 and 200),
  file_name text not null check (char_length(file_name) between 1 and 80),
  mime text not null check (mime in ('image/png', 'image/jpeg', 'image/webp')),
  size_bytes integer not null check (size_bytes between 1 and 4194304),
  created_at timestamptz not null default now()
);
create index if not exists support_attachments_ticket on public.support_attachments (ticket_id, created_at);
create index if not exists support_attachments_message on public.support_attachments (message_id);
create index if not exists support_attachments_uploader on public.support_attachments (uploader_id, created_at);

create table if not exists public.support_notes (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.support_tickets(id) on delete cascade,
  author_id uuid references auth.users(id) on delete set null,
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists support_notes_ticket on public.support_notes (ticket_id, created_at);

create table if not exists public.support_macros (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 60),
  body text not null check (char_length(body) between 1 and 2000),
  shared boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists support_macros_owner on public.support_macros (owner_id);

alter table public.support_attachments enable row level security;
alter table public.support_notes enable row level security;
alter table public.support_macros enable row level security;
revoke all on public.support_attachments, public.support_notes, public.support_macros from anon, authenticated;
grant all on public.support_attachments, public.support_notes, public.support_macros to service_role;
-- Las capturas se pueden consultar como los mensajes: la persona dueña de la consulta y el equipo.
grant select on public.support_attachments to authenticated;
drop policy if exists support_attachments_read on public.support_attachments;
create policy support_attachments_read on public.support_attachments for select to authenticated
  using (exists (select 1 from public.support_tickets t where t.id = ticket_id
    and (t.user_id = (select auth.uid()) or (select private.support_is_staff()))));
-- support_notes y support_macros: RLS activa y ninguna política = ningún acceso directo (ni siquiera de lectura).

-- ---------- 3) Ayudas internas ----------
create or replace function private.support_write_user() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v_user uuid := private.support_user();
begin
  if public.moderation_social_block(v_user) = 'user_banned' then
    raise exception 'Tu cuenta no puede abrir consultas nuevas ni adjuntar archivos por ahora.' using errcode = '42501', hint = 'banned';
  end if;
  return v_user;
end $$;

create or replace function private.support_priority_for(p_category text) returns text
language sql immutable set search_path = '' as $$
  select case p_category when 'payments' then 'high' when 'suggestion' then 'low' else 'normal' end
$$;

create or replace function private.support_name(p_user uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(nullif(btrim(p.username), ''), nullif(btrim(p.display_name), ''), 'Equipo')
  from (select p_user as id) x left join public.profiles p on p.id = x.id
$$;

-- Campos propios de cada categoría: enumerados (valores válidos) y de texto libre (largo máximo). Lo demás se rechaza.
create or replace function private.support_details_clean(p_category text, p_details jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  v_out jsonb := '{}'::jsonb; v_key text; v_val jsonb; v_text text; v_enums jsonb; v_free jsonb;
begin
  if p_details is null or jsonb_typeof(p_details) = 'null' then return v_out; end if;
  if jsonb_typeof(p_details) <> 'object' or pg_column_size(p_details) > 8192 then
    raise exception 'Revisá los datos de la consulta.' using errcode = '22023', hint = 'bad_details';
  end if;
  v_enums := case p_category
    when 'bug' then '{"area":["launcher","install","update","account","social","other"],"frequency":["always","sometimes","once"]}'
    when 'game' then '{"loader":["vanilla","fabric","quilt","forge","neoforge","other"],"moment":["launch","loading","playing","closing"],"modsChanged":["yes","no","unknown"]}'
    when 'payments' then '{"topic":["login","profile","sanction","payment","refund","other"],"method":["mercado_pago","paypal","other"]}'
    when 'assistant' then '{"plan":["none","basic","go","pro","max"],"issue":["noreply","limit","wrong","billing","other"]}'
    when 'suggestion' then '{"area":["launcher","play","social","ai","other"]}'
    else '{}' end::jsonb;
  v_free := case p_category
    when 'bug' then '{"steps":600}'
    when 'game' then '{"mcVersion":24,"steps":600}'
    when 'payments' then '{"paidOn":10,"orderRef":80}'
    when 'suggestion' then '{"benefit":400}'
    else '{}' end::jsonb;
  for v_key, v_val in select * from jsonb_each(p_details) loop
    if jsonb_typeof(v_val) <> 'string' then
      raise exception 'Revisá los datos de la consulta.' using errcode = '22023', hint = 'bad_details';
    end if;
    v_text := btrim(v_val #>> '{}');
    if v_text = '' then continue; end if;
    if v_enums ? v_key then
      if not ((v_enums -> v_key) ? v_text) then
        raise exception 'Revisá los datos de la consulta.' using errcode = '22023', hint = 'bad_details';
      end if;
    elsif v_free ? v_key then
      if char_length(v_text) > (v_free ->> v_key)::integer or v_text ~ '[\x00-\x08\x0b-\x1f]'
         or (v_key in ('mcVersion', 'paidOn', 'orderRef') and v_text ~ '[\r\n<>]')
         or (v_key = 'paidOn' and v_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') then
        raise exception 'Revisá los datos de la consulta.' using errcode = '22023', hint = 'bad_details';
      end if;
    else
      raise exception 'Revisá los datos de la consulta.' using errcode = '22023', hint = 'bad_details';
    end if;
    v_out := v_out || jsonb_build_object(v_key, v_text);
  end loop;
  return v_out;
end $$;

-- Diagnóstico: texto plano (el launcher ya sacó rutas y datos personales); acá solo se acota.
create or replace function private.support_diagnostic_clean(p_diagnostic text) returns text
language plpgsql immutable set search_path = '' as $$
declare v text := nullif(btrim(coalesce(p_diagnostic, ''), E' \t\r\n'), '');
begin
  if v is null then return null; end if;
  if char_length(v) > 12000 or v ~ '[\x00-\x08\x0b\x0c\x0e-\x1f]' then
    raise exception 'El diagnóstico es demasiado largo o tiene caracteres no válidos.' using errcode = '22023', hint = 'bad_diagnostic';
  end if;
  return v;
end $$;

-- ---------- 4) JSON de consultas y mensajes (superconjunto del de 0017: los launchers viejos ignoran lo nuevo) ----------
create or replace function private.support_message_json(m public.support_messages) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', m.id, 'ticketId', m.ticket_id, 'authorId', m.author_id, 'isAdmin', m.is_admin,
    'body', m.body, 'createdAt', public.ai_iso(m.created_at), 'code', m.code,
    'attachments', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.file_name, 'mime', a.mime, 'size', a.size_bytes)
      order by a.created_at, a.id) from public.support_attachments a where a.message_id = m.id), '[]'::jsonb))
$$;

create or replace function private.support_ticket_json(t public.support_tickets) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', t.id, 'userId', t.user_id, 'name', t.name, 'subject', coalesce(t.subject,
      case when t.plan_name is not null then 'Plan ' || t.plan_name end), 'category', t.category, 'plan', t.plan_id,
    'planName', t.plan_name, 'priceUsd', t.price_usd, 'paymentMethod', t.payment_method, 'status', t.status,
    'createdAt', public.ai_iso(t.created_at), 'updatedAt', public.ai_iso(t.updated_at),
    'closedAt', public.ai_iso(t.closed_at), 'activatedUntil', public.ai_iso(t.activated_until),
    'priority', t.priority, 'assigned', t.assigned_to is not null,
    'lastUserMessageAt', public.ai_iso(t.last_user_message_at), 'lastReplyAt', public.ai_iso(t.last_staff_reply_at),
    'unread', (t.last_staff_reply_at is not null and (t.user_seen_at is null or t.last_staff_reply_at > t.user_seen_at)),
    'rating', t.rating, 'ratedAt', public.ai_iso(t.rated_at), 'reopenCount', t.reopen_count,
    'reopenUntil', case when t.status = 'closed' then public.ai_iso(t.closed_at + interval '14 days') end,
    'hasDiagnostic', t.diagnostic is not null,
    'attachmentCount', (select count(*) from public.support_attachments a where a.ticket_id = t.id))
$$;

-- ---------- 5) Abrir consultas ----------
create or replace function private.support_open_impl(p_subject text, p_category text, p_message text, p_details jsonb, p_diagnostic text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := private.support_write_user();
  v_ticket public.support_tickets%rowtype; v_msg public.support_messages%rowtype;
  v_details jsonb; v_diag text;
begin
  if p_subject is null or char_length(btrim(p_subject)) not between 3 and 120
     or coalesce(p_category, '') not in ('general', 'account', 'payments', 'assistant', 'bug', 'game', 'suggestion', 'other')
     or p_message is null or char_length(btrim(p_message)) not between 1 and 4000 then
    raise exception 'Revisá el asunto, el tema y el mensaje.' using errcode = '22023', hint = 'bad_input';
  end if;
  v_details := private.support_details_clean(p_category, p_details);
  v_diag := private.support_diagnostic_clean(p_diagnostic);
  perform pg_advisory_xact_lock(hashtextextended(v_user::text, 815));
  if (select count(*) from public.support_tickets where user_id = v_user and status in ('open', 'in_progress')) >= 3 then
    raise exception 'Ya tenés 3 consultas abiertas. Seguí por una de esas.' using errcode = '23505', hint = 'too_many_open';
  end if;
  if (select count(*) from public.support_tickets where user_id = v_user and created_at > now() - interval '1 day') >= 5 then
    raise exception 'Llegaste al límite de consultas de hoy.' using errcode = '54000', hint = 'daily_limit';
  end if;
  insert into public.support_tickets (user_id, subject, category, priority, details, diagnostic, diagnostic_at,
                                      last_user_message_at, user_seen_at)
  values (v_user, btrim(p_subject), p_category, private.support_priority_for(p_category), v_details, v_diag,
          case when v_diag is not null then now() end, clock_timestamp(), clock_timestamp())
  returning * into v_ticket;
  insert into public.support_messages (ticket_id, author_id, is_admin, body, created_at)
  values (v_ticket.id, v_user, false, btrim(p_message), clock_timestamp()) returning * into v_msg;
  return private.support_ticket_json(v_ticket) || jsonb_build_object('firstMessageId', v_msg.id);
end $$;

create or replace function public.support_open_ticket(p_subject text, p_category text, p_message text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  return private.support_open_impl(p_subject, p_category, p_message, '{}'::jsonb, null);
end $$;

create or replace function public.support_submit_ticket(p_subject text, p_category text, p_message text, p_details jsonb, p_diagnostic text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  return private.support_open_impl(p_subject, p_category, p_message, p_details, p_diagnostic);
end $$;

-- ---------- 6) Leer ----------
create or replace function public.support_list_tickets(p_admin boolean default false) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_user uuid := private.support_user(); v_result jsonb;
begin
  if coalesce(p_admin, false) and not private.support_is_staff(v_user) then
    raise exception 'Solo el equipo de soporte.' using errcode = '42501', hint = 'not_staff';
  end if;
  select coalesce(jsonb_agg(private.support_ticket_json(t) || jsonb_build_object('lastReplyPreview',
      (select left(regexp_replace(m.body, '\s+', ' ', 'g'), 140) from public.support_messages m
        where m.ticket_id = t.id and m.is_admin and m.code is null order by m.created_at desc, m.id desc limit 1))
    order by case when t.status in ('open', 'in_progress') then 0 else 1 end, t.updated_at desc), '[]'::jsonb)
  into v_result from (select * from public.support_tickets s
    where coalesce(p_admin, false) or s.user_id = v_user
    order by case when status in ('open', 'in_progress') then 0 else 1 end, updated_at desc limit 200) t;
  return v_result;
end $$;

create or replace function public.support_ticket_detail(p_ticket uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_user uuid := private.support_user(); v_ticket public.support_tickets%rowtype;
begin
  select * into v_ticket from public.support_tickets t where t.id = p_ticket
    and (t.user_id = v_user or private.support_is_staff(v_user));
  if not found then raise exception 'Ticket no disponible.' using errcode = '42501', hint = 'not_available'; end if;
  return jsonb_build_object(
    'ticket', private.support_ticket_json(v_ticket) || jsonb_build_object('details', v_ticket.details,
      'diagnostic', v_ticket.diagnostic, 'ratingComment', v_ticket.rating_comment),
    'viewer', case when v_ticket.user_id = v_user then 'owner' else 'staff' end,
    'messages', coalesce((select jsonb_agg(private.support_message_json(m) order by m.created_at, m.id)
      from public.support_messages m where m.ticket_id = p_ticket), '[]'::jsonb));
end $$;

-- La persona vio la conversación: se apaga el aviso de "respuesta nueva".
create or replace function public.support_mark_seen(p_ticket uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := private.support_user();
begin
  update public.support_tickets set user_seen_at = clock_timestamp() where id = p_ticket and user_id = v_user;
  return jsonb_build_object('ok', found);
end $$;

-- Para el aviso del launcher: cuántas consultas tienen respuesta nueva y cuáles son las últimas.
create or replace function public.support_unread_summary() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_user uuid := private.support_user();
begin
  return jsonb_build_object(
    'open', (select count(*) from public.support_tickets t where t.user_id = v_user and t.status in ('open', 'in_progress')),
    'unread', (select count(*) from public.support_tickets t where t.user_id = v_user
      and t.last_staff_reply_at is not null and (t.user_seen_at is null or t.last_staff_reply_at > t.user_seen_at)),
    'latest', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'subject', x.subject, 'at', public.ai_iso(x.last_staff_reply_at))
        order by x.last_staff_reply_at desc)
      from (select t.id, t.subject, t.last_staff_reply_at from public.support_tickets t where t.user_id = v_user
        and t.last_staff_reply_at is not null and (t.user_seen_at is null or t.last_staff_reply_at > t.user_seen_at)
        order by t.last_staff_reply_at desc limit 5) x), '[]'::jsonb));
end $$;

-- ---------- 7) Mensajes ----------
create or replace function public.support_add_message(p_ticket uuid, p_body text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := private.support_user(); v_staff boolean := private.support_is_staff(v_user); v_team boolean;
  v_ticket public.support_tickets%rowtype; v_message public.support_messages%rowtype;
begin
  if p_body is null or char_length(btrim(p_body)) not between 1 and 4000 then
    raise exception 'Escribí un mensaje de hasta 4000 caracteres.' using errcode = '22023', hint = 'bad_input';
  end if;
  select * into v_ticket from public.support_tickets where id = p_ticket and (user_id = v_user or v_staff) for update;
  if not found then raise exception 'Ticket no disponible.' using errcode = '42501', hint = 'not_available'; end if;
  -- Quien atiende su propia consulta escribe como persona usuaria, no como equipo.
  v_team := v_staff and v_ticket.user_id <> v_user;
  if v_ticket.status not in ('open', 'in_progress') then
    raise exception 'El ticket ya está cerrado.' using errcode = '22023', hint = 'closed';
  end if;
  if (select count(*) from public.support_messages where author_id = v_user and created_at > now() - interval '1 minute') >= 10 then
    raise exception 'Esperá un minuto antes de enviar más mensajes.' using errcode = '54000', hint = 'rate_minute';
  end if;
  if not v_staff and (select count(*) from public.support_messages where author_id = v_user and created_at > now() - interval '1 day') >= 150 then
    raise exception 'Llegaste al límite de mensajes de hoy.' using errcode = '54000', hint = 'daily_messages';
  end if;
  if (select count(*) from public.support_messages where ticket_id = p_ticket) >= 500 then
    raise exception 'El ticket alcanzó el límite de mensajes.' using errcode = '54000', hint = 'ticket_full';
  end if;
  insert into public.support_messages (ticket_id, author_id, is_admin, body, created_at)
  values (p_ticket, v_user, v_team, btrim(p_body), clock_timestamp()) returning * into v_message;
  update public.support_tickets set updated_at = now(),
    status = case when v_team then 'in_progress' else status end,
    assigned_to = case when v_team and assigned_to is null then v_user else assigned_to end,
    assigned_at = case when v_team and assigned_to is null then now() else assigned_at end,
    last_staff_reply_at = case when v_team then clock_timestamp() else last_staff_reply_at end,
    last_user_message_at = case when v_team then last_user_message_at else clock_timestamp() end,
    user_seen_at = case when v_team then user_seen_at else clock_timestamp() end
  where id = p_ticket;
  return private.support_message_json(v_message);
end $$;

-- ---------- 8) Cerrar, reabrir y valorar ----------
-- Cierre del equipo (0017 + code/tiempos). Seguir sin confirmar pagos: se acreditan solos desde Planes.
create or replace function public.support_resolve_ticket(p_ticket uuid, p_confirm_payment boolean, p_note text default '') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_admin uuid := private.support_user(); v_ticket public.support_tickets%rowtype; v_email text;
begin
  if not private.support_is_staff(v_admin) then raise exception 'Solo el equipo de soporte.' using errcode = '42501', hint = 'not_staff'; end if;
  if coalesce(p_confirm_payment, false) then
    raise exception 'Los pagos ya no se confirman por ticket: se acreditan solos al pagar desde Planes.' using errcode = '22023', hint = 'payments_moved';
  end if;
  if char_length(coalesce(p_note, '')) > 2000 then raise exception 'Revisá la resolución del ticket.' using errcode = '22023', hint = 'bad_input'; end if;
  select * into v_ticket from public.support_tickets where id = p_ticket for update;
  if not found then raise exception 'Ticket no disponible.' using errcode = 'P0002', hint = 'not_available'; end if;
  if v_ticket.status in ('closed', 'paid') then return private.support_ticket_json(v_ticket); end if;
  update public.support_tickets set status = 'closed', closed_at = now(), closed_by = v_admin, updated_at = now(),
    last_staff_reply_at = clock_timestamp(), assigned_to = coalesce(assigned_to, v_admin), assigned_at = coalesce(assigned_at, now())
  where id = p_ticket returning * into v_ticket;
  insert into public.support_messages (ticket_id, author_id, is_admin, body, code, created_at)
  values (p_ticket, v_admin, true, 'Consulta cerrada.' || case when nullif(btrim(p_note), '') is not null then ' ' || btrim(p_note) else '' end, 'closed', clock_timestamp());
  select email into v_email from auth.users where id = v_admin;
  perform public.admin_log(v_admin, v_email, 'support.closed', v_ticket.user_id, jsonb_build_object('ticketId', v_ticket.id,
    'actorRole', case when public.admin_is_admin_user(v_admin) then 'admin' else 'support' end));
  return private.support_ticket_json(v_ticket);
end $$;

-- La persona da por resuelta su consulta.
create or replace function public.support_close_own_ticket(p_ticket uuid, p_note text default '') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := private.support_user(); v_ticket public.support_tickets%rowtype; v_note text := btrim(coalesce(p_note, ''));
begin
  if char_length(v_note) > 500 then raise exception 'La nota puede tener hasta 500 caracteres.' using errcode = '22023', hint = 'bad_input'; end if;
  select * into v_ticket from public.support_tickets where id = p_ticket and user_id = v_user for update;
  if not found then raise exception 'Ticket no disponible.' using errcode = '42501', hint = 'not_available'; end if;
  if v_ticket.status in ('closed', 'paid') then return private.support_ticket_json(v_ticket); end if;
  update public.support_tickets set status = 'closed', closed_at = now(), closed_by = v_user, updated_at = now(), user_seen_at = clock_timestamp()
  where id = p_ticket returning * into v_ticket;
  insert into public.support_messages (ticket_id, author_id, is_admin, body, code, created_at)
  values (p_ticket, v_user, false, 'Consulta cerrada.' || case when v_note <> '' then ' ' || v_note else '' end, 'closed_self', clock_timestamp());
  return private.support_ticket_json(v_ticket);
end $$;

-- Reabrir: la persona (14 días, hasta 3 veces y con un mensaje) o el equipo (sin esos topes, para poder contestar).
create or replace function public.support_reopen_ticket(p_ticket uuid, p_message text default '') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := private.support_user(); v_staff boolean := private.support_is_staff(v_user);
  v_ticket public.support_tickets%rowtype; v_owner boolean; v_msg text := btrim(coalesce(p_message, '')); v_email text;
begin
  if char_length(v_msg) > 4000 then raise exception 'Escribí un mensaje de hasta 4000 caracteres.' using errcode = '22023', hint = 'bad_input'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_user::text, 815));
  select * into v_ticket from public.support_tickets where id = p_ticket and (user_id = v_user or v_staff) for update;
  if not found then raise exception 'Ticket no disponible.' using errcode = '42501', hint = 'not_available'; end if;
  if v_ticket.status <> 'closed' then raise exception 'Solo se puede reabrir una consulta cerrada.' using errcode = '22023', hint = 'not_closed'; end if;
  v_owner := v_ticket.user_id = v_user;
  if v_owner then
    perform private.support_write_user();
    if v_msg = '' then raise exception 'Contanos por qué la reabrís.' using errcode = '22023', hint = 'bad_input'; end if;
    if v_ticket.closed_at is null or v_ticket.closed_at < now() - interval '14 days' then
      raise exception 'Pasaron más de 14 días: abrí una consulta nueva.' using errcode = '22023', hint = 'reopen_expired';
    end if;
    if v_ticket.reopen_count >= 3 then
      raise exception 'Esta consulta ya se reabrió 3 veces: abrí una nueva.' using errcode = '22023', hint = 'reopen_limit';
    end if;
    if (select count(*) from public.support_tickets where user_id = v_user and status in ('open', 'in_progress')) >= 3 then
      raise exception 'Ya tenés 3 consultas abiertas. Seguí por una de esas.' using errcode = '23505', hint = 'too_many_open';
    end if;
  end if;
  if (select count(*) from public.support_messages where author_id = v_user and created_at > now() - interval '1 minute') >= 10 then
    raise exception 'Esperá un minuto antes de enviar más mensajes.' using errcode = '54000', hint = 'rate_minute';
  end if;
  update public.support_tickets set status = case when v_owner then 'open' else 'in_progress' end,
    closed_at = null, closed_by = null, updated_at = now(),
    reopen_count = case when v_owner then reopen_count + 1 else reopen_count end,
    assigned_to = case when v_owner then assigned_to else coalesce(assigned_to, v_user) end,
    last_user_message_at = case when v_owner then clock_timestamp() else last_user_message_at end,
    user_seen_at = case when v_owner then clock_timestamp() else user_seen_at end,
    last_staff_reply_at = case when v_owner then last_staff_reply_at else clock_timestamp() end
  where id = p_ticket returning * into v_ticket;
  insert into public.support_messages (ticket_id, author_id, is_admin, body, code, created_at)
  values (p_ticket, v_user, not v_owner, case when v_msg <> '' then v_msg else 'Consulta reabierta.' end, 'reopened', clock_timestamp());
  if not v_owner then
    select email into v_email from auth.users where id = v_user;
    perform public.admin_log(v_user, v_email, 'support.reopened', v_ticket.user_id, jsonb_build_object('ticketId', v_ticket.id,
      'actorRole', case when public.admin_is_admin_user(v_user) then 'admin' else 'support' end));
  end if;
  return private.support_ticket_json(v_ticket);
end $$;

-- Valoración de la atención: de 1 a 5 y un comentario opcional, solo en consultas cerradas (se puede corregir).
create or replace function public.support_rate_ticket(p_ticket uuid, p_rating integer, p_comment text default '') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := private.support_write_user(); v_ticket public.support_tickets%rowtype; v_comment text := btrim(coalesce(p_comment, ''));
begin
  if p_rating is null or p_rating not between 1 and 5 or char_length(v_comment) > 500 or v_comment ~ '[\x00-\x08\x0b\x0c\x0e-\x1f]' then
    raise exception 'Elegí de 1 a 5 estrellas y un comentario de hasta 500 caracteres.' using errcode = '22023', hint = 'bad_input';
  end if;
  select * into v_ticket from public.support_tickets where id = p_ticket and user_id = v_user for update;
  if not found then raise exception 'Ticket no disponible.' using errcode = '42501', hint = 'not_available'; end if;
  if v_ticket.status <> 'closed' then raise exception 'Podés valorar la atención cuando la consulta esté cerrada.' using errcode = '22023', hint = 'not_closed'; end if;
  update public.support_tickets set rating = p_rating, rating_comment = nullif(v_comment, ''), rated_at = now()
  where id = p_ticket returning * into v_ticket;
  return private.support_ticket_json(v_ticket);
end $$;

-- ---------- 9) Diagnóstico agregado después ----------
create or replace function public.support_set_diagnostic(p_ticket uuid, p_diagnostic text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := private.support_write_user(); v_ticket public.support_tickets%rowtype; v_diag text := private.support_diagnostic_clean(p_diagnostic);
begin
  if v_diag is null then raise exception 'Tildá lo que querés enviar antes de adjuntar el diagnóstico.' using errcode = '22023', hint = 'bad_input'; end if;
  select * into v_ticket from public.support_tickets where id = p_ticket and user_id = v_user for update;
  if not found then raise exception 'Ticket no disponible.' using errcode = '42501', hint = 'not_available'; end if;
  if v_ticket.status not in ('open', 'in_progress') then raise exception 'El ticket ya está cerrado.' using errcode = '22023', hint = 'closed'; end if;
  if v_ticket.diagnostic_at is not null and v_ticket.diagnostic_at > now() - interval '30 seconds' then
    raise exception 'Esperá unos segundos antes de volver a enviar el diagnóstico.' using errcode = '54000', hint = 'rate_minute';
  end if;
  update public.support_tickets set diagnostic = v_diag, diagnostic_at = now(), updated_at = now(), last_user_message_at = clock_timestamp(), user_seen_at = clock_timestamp()
  where id = p_ticket returning * into v_ticket;
  return private.support_ticket_json(v_ticket);
end $$;

-- ---------- 10) Capturas ----------
-- La ruta del objeto manda: <quién sube>/<consulta>/<uuid>.<png|jpg|webp>. Escribir exige una consulta abierta de esa persona
-- (o atendida por el equipo) y una cuenta sin baneo; leer, ser dueña de la consulta o del equipo.
create or replace function private.support_object_ok(p_name text, p_write boolean) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_dirs text[] := storage.foldername(p_name); v_ticket public.support_tickets%rowtype;
begin
  if v_uid is null or coalesce(array_length(v_dirs, 1), 0) <> 2 then return false; end if;
  if p_name !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$' then
    return false;
  end if;
  select * into v_ticket from public.support_tickets where id = v_dirs[2]::uuid;
  if not found then return false; end if;
  if p_write then
    return v_dirs[1] = v_uid::text and v_ticket.status in ('open', 'in_progress')
      and (v_ticket.user_id = v_uid or private.support_is_staff(v_uid))
      and public.moderation_social_block(v_uid) is distinct from 'user_banned';
  end if;
  return v_ticket.user_id = v_uid or private.support_is_staff(v_uid);
end $$;
revoke all on function private.support_object_ok(text, boolean) from public, anon;
grant execute on function private.support_object_ok(text, boolean) to authenticated, service_role;

-- Topes de archivos en el bucket (aparte del trigger de 0014: ese solo conoce sus tres buckets).
create or replace function private.support_attachment_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_owner text; v_ticket text; v_total integer; v_in_ticket integer;
begin
  if new.bucket_id <> 'support-attachments' then return new; end if;
  if tg_op = 'UPDATE' and new.bucket_id = old.bucket_id and new.name = old.name then return new; end if;
  if coalesce(array_length(storage.foldername(new.name), 1), 0) <> 2 then
    raise exception 'storage_bad_path' using errcode = '42501';
  end if;
  v_owner := (storage.foldername(new.name))[1];
  v_ticket := (storage.foldername(new.name))[2];
  perform pg_advisory_xact_lock(hashtext('venus-support-attach:' || coalesce(v_owner, '')));
  select count(*), count(*) filter (where o.name collate "C" >= (v_owner || '/' || v_ticket || '/')
                                      and o.name collate "C" < (v_owner || '/' || v_ticket || '0'))
    into v_total, v_in_ticket
    from storage.objects o
   where o.bucket_id = new.bucket_id
     and o.name collate "C" >= (v_owner || '/') and o.name collate "C" < (v_owner || '0')
     and o.name <> new.name;
  if v_total >= 60 or v_in_ticket >= 15 then
    raise exception 'storage_quota_exceeded' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function private.support_attachment_before() from public, anon, authenticated;

do $storage$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('support-attachments', 'support-attachments', false, 4194304, array['image/png', 'image/jpeg', 'image/webp'])
    on conflict (id) do update
      set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
  end if;
  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists "support_attachments_select" on storage.objects';
    execute $p$create policy "support_attachments_select" on storage.objects for select to authenticated
      using (bucket_id = 'support-attachments' and private.support_object_ok(name, false))$p$;
    execute 'drop policy if exists "support_attachments_insert" on storage.objects';
    execute $p$create policy "support_attachments_insert" on storage.objects for insert to authenticated
      with check (bucket_id = 'support-attachments' and private.support_object_ok(name, true))$p$;
    -- Sin política de UPDATE ni DELETE: lo enviado queda como evidencia y no se pisa ni se mueve desde el launcher.
    execute 'drop trigger if exists venus_support_attach_quota on storage.objects';
    execute 'create trigger venus_support_attach_quota before insert or update on storage.objects
      for each row execute function private.support_attachment_before()';
  end if;
end $storage$;

-- Registra capturas ya subidas: la fila sale de lo que Storage realmente guardó (tamaño y tipo), no de lo que dice el cliente.
create or replace function public.support_register_attachments(p_ticket uuid, p_message uuid, p_files jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := private.support_write_user(); v_ticket public.support_tickets%rowtype; v_item jsonb; v_path text; v_name text;
  v_size bigint; v_mime text; v_out jsonb := '[]'::jsonb; v_row public.support_attachments%rowtype; v_new integer;
begin
  if p_files is null or jsonb_typeof(p_files) <> 'array' or jsonb_array_length(p_files) not between 1 and 3 then
    raise exception 'Podés adjuntar hasta 3 capturas por envío.' using errcode = '22023', hint = 'attach_limit';
  end if;
  v_new := jsonb_array_length(p_files);
  select * into v_ticket from public.support_tickets where id = p_ticket and (user_id = v_user or private.support_is_staff(v_user)) for update;
  if not found then raise exception 'Ticket no disponible.' using errcode = '42501', hint = 'not_available'; end if;
  if v_ticket.status not in ('open', 'in_progress') then raise exception 'El ticket ya está cerrado.' using errcode = '22023', hint = 'closed'; end if;
  if p_message is not null and not exists (select 1 from public.support_messages m
       where m.id = p_message and m.ticket_id = p_ticket and m.author_id = v_user) then
    raise exception 'El mensaje no es válido.' using errcode = '22023', hint = 'bad_input';
  end if;
  if (select count(*) from public.support_attachments a where a.ticket_id = p_ticket) + v_new > 12 then
    raise exception 'La consulta ya tiene el máximo de capturas (12).' using errcode = '54000', hint = 'attach_ticket_full';
  end if;
  if (select count(*) from public.support_attachments a where a.uploader_id = v_user and a.created_at > now() - interval '1 day') + v_new > 15 then
    raise exception 'Llegaste al límite de capturas de hoy.' using errcode = '54000', hint = 'attach_daily';
  end if;
  for v_item in select * from jsonb_array_elements(p_files) loop
    v_path := v_item ->> 'path';
    if v_path is null or v_path !~ ('^' || v_user::text || '/' || p_ticket::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$') then
      raise exception 'La captura no es válida.' using errcode = '22023', hint = 'attach_bad';
    end if;
    select (o.metadata ->> 'size')::bigint, o.metadata ->> 'mimetype' into v_size, v_mime
      from storage.objects o where o.bucket_id = 'support-attachments' and o.name = v_path;
    if not found or v_size is null or v_size not between 1 and 4194304 or v_mime not in ('image/png', 'image/jpeg', 'image/webp') then
      raise exception 'La captura no se subió bien. Probá de nuevo.' using errcode = '22023', hint = 'attach_missing';
    end if;
    if exists (select 1 from public.support_attachments a where a.path = v_path) then
      raise exception 'La captura no es válida.' using errcode = '22023', hint = 'attach_bad';
    end if;
    v_name := left(btrim(regexp_replace(coalesce(v_item ->> 'name', ''), '[\x00-\x1f<>:"/\\|?*]', '', 'g')), 80);
    if v_name = '' then v_name := 'captura'; end if;
    insert into public.support_attachments (ticket_id, message_id, uploader_id, path, file_name, mime, size_bytes)
    values (p_ticket, p_message, v_user, v_path, v_name, v_mime, v_size::integer) returning * into v_row;
    v_out := v_out || jsonb_build_array(jsonb_build_object('id', v_row.id, 'name', v_row.file_name, 'mime', v_row.mime, 'size', v_row.size_bytes));
  end loop;
  update public.support_tickets set updated_at = now() where id = p_ticket;
  return v_out;
end $$;

-- Ruta de una captura para descargarla (el permiso real lo vuelve a comprobar Storage con la misma regla).
create or replace function public.support_attachment_info(p_attachment uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_user uuid := private.support_user(); v_row public.support_attachments%rowtype;
begin
  select a.* into v_row from public.support_attachments a join public.support_tickets t on t.id = a.ticket_id
   where a.id = p_attachment and (t.user_id = v_user or private.support_is_staff(v_user));
  if not found then raise exception 'Captura no disponible.' using errcode = '42501', hint = 'not_available'; end if;
  return jsonb_build_object('id', v_row.id, 'path', v_row.path, 'mime', v_row.mime, 'name', v_row.file_name, 'size', v_row.size_bytes);
end $$;

-- ---------- 11) Equipo: cola, contexto, asignación, prioridad, notas y respuestas guardadas ----------
create or replace function public.support_queue(p_filter jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_user uuid := private.support_user(); f jsonb := coalesce(p_filter, '{}'::jsonb);
  v_status text := coalesce(f ->> 'status', 'pending'); v_cat text := nullif(f ->> 'category', ''); v_prio text := nullif(f ->> 'priority', '');
  v_assigned text := coalesce(f ->> 'assigned', 'any'); v_sort text := coalesce(f ->> 'sort', 'priority');
  v_search text := lower(btrim(coalesce(f ->> 'search', '')));
  v_limit integer := case when coalesce(f ->> 'limit', '') ~ '^[0-9]{1,6}$' then least(greatest((f ->> 'limit')::integer, 1), 100) else 40 end;
  v_page integer := case when coalesce(f ->> 'page', '') ~ '^[0-9]{1,4}$' then (f ->> 'page')::integer else 0 end;
  v_items jsonb; v_total integer; v_counts jsonb;
begin
  if not private.support_is_staff(v_user) then raise exception 'Solo el equipo de soporte.' using errcode = '42501', hint = 'not_staff'; end if;
  if v_status not in ('pending', 'waiting', 'progress', 'closed', 'all') or v_assigned not in ('any', 'me', 'none')
     or v_sort not in ('priority', 'newest', 'oldest') or char_length(v_search) > 60
     or (v_cat is not null and v_cat not in ('general', 'account', 'payments', 'assistant', 'bug', 'game', 'suggestion', 'other'))
     or (v_prio is not null and v_prio not in ('low', 'normal', 'high', 'urgent')) then
    raise exception 'Revisá los filtros.' using errcode = '22023', hint = 'bad_input';
  end if;

  with base as (
    select t.*, (t.status in ('open', 'in_progress')) as is_pending,
      (t.status in ('open', 'in_progress') and (t.last_staff_reply_at is null or t.last_user_message_at > t.last_staff_reply_at)) as is_waiting,
      private.support_name(t.user_id) as owner_name
    from public.support_tickets t
  ), filtered as (
    select * from base b
    where case v_status when 'pending' then b.is_pending when 'waiting' then b.is_waiting when 'progress' then b.status = 'in_progress'
            when 'closed' then b.status in ('closed', 'paid') else true end
      and (v_cat is null or b.category = v_cat) and (v_prio is null or b.priority = v_prio)
      and (case v_assigned when 'me' then b.assigned_to = v_user when 'none' then b.assigned_to is null else true end)
      and (v_search = '' or position(v_search in lower(coalesce(b.subject, ''))) > 0 or position(v_search in lower(b.owner_name)) > 0)
  ), ranked as (
    select f2.id, f2.is_waiting, f2.owner_name, row_number() over (order by
      case when v_sort = 'priority' then (case when f2.is_pending then 0 else 1 end) end,
      case when v_sort = 'priority' then (case when f2.is_waiting then 0 else 1 end) end,
      case when v_sort = 'priority' then (case f2.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end) end,
      case when v_sort = 'priority' then coalesce(f2.last_user_message_at, f2.created_at) end asc,
      case when v_sort = 'newest' then f2.updated_at end desc,
      case when v_sort = 'oldest' then f2.created_at end asc,
      f2.id) as rn
    from filtered f2
  )
  select coalesce(jsonb_agg(private.support_ticket_json(t) || jsonb_build_object(
      'userName', r.owner_name, 'waiting', r.is_waiting, 'mine', t.assigned_to = v_user,
      'assigneeName', case when t.assigned_to is not null then private.support_name(t.assigned_to) end,
      'lastPreview', (select left(regexp_replace(m.body, '\s+', ' ', 'g'), 160) from public.support_messages m
                       where m.ticket_id = t.id order by m.created_at desc, m.id desc limit 1),
      'lastFromTeam', (select m.is_admin from public.support_messages m where m.ticket_id = t.id order by m.created_at desc, m.id desc limit 1))
    order by r.rn), '[]'::jsonb)
    into v_items
  from ranked r join public.support_tickets t on t.id = r.id
  where r.rn > v_page * v_limit and r.rn <= (v_page + 1) * v_limit;

  select count(*) into v_total from public.support_tickets b where
    case v_status when 'pending' then b.status in ('open', 'in_progress')
      when 'waiting' then b.status in ('open', 'in_progress') and (b.last_staff_reply_at is null or b.last_user_message_at > b.last_staff_reply_at)
      when 'progress' then b.status = 'in_progress' when 'closed' then b.status in ('closed', 'paid') else true end
    and (v_cat is null or b.category = v_cat) and (v_prio is null or b.priority = v_prio)
    and (case v_assigned when 'me' then b.assigned_to = v_user when 'none' then b.assigned_to is null else true end)
    and (v_search = '' or position(v_search in lower(coalesce(b.subject, ''))) > 0 or position(v_search in lower(private.support_name(b.user_id))) > 0);

  select jsonb_build_object(
    'pending', count(*) filter (where t.status in ('open', 'in_progress')),
    'waiting', count(*) filter (where t.status in ('open', 'in_progress') and (t.last_staff_reply_at is null or t.last_user_message_at > t.last_staff_reply_at)),
    'unassigned', count(*) filter (where t.status in ('open', 'in_progress') and t.assigned_to is null),
    'mine', count(*) filter (where t.status in ('open', 'in_progress') and t.assigned_to = v_user),
    'closed', count(*) filter (where t.status in ('closed', 'paid')),
    'ratingAvg', (select round(avg(r.rating)::numeric, 2) from public.support_tickets r where r.rated_at > now() - interval '30 days'),
    'ratingCount', (select count(*) from public.support_tickets r where r.rated_at > now() - interval '30 days'))
    into v_counts from public.support_tickets t;

  return jsonb_build_object('items', v_items, 'total', v_total, 'counts', v_counts, 'page', v_page, 'limit', v_limit);
end $$;

-- Quién atiende (para elegir a quién asignar).
create or replace function public.support_staff_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_user uuid := private.support_user();
begin
  if not private.support_is_staff(v_user) then raise exception 'Solo el equipo de soporte.' using errcode = '42501', hint = 'not_staff'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'me', x.id = v_user) order by x.name)
    from (select u.id, private.support_name(u.id) as name from auth.users u
           where private.support_is_staff(u.id)
             and (u.id in (select s.user_id from public.support_staff s where s.active) or public.admin_is_admin_user(u.id))) x), '[]'::jsonb);
end $$;

-- Notas internas y datos de la cuenta, solo los necesarios para atender (sin correo, sin IP, sin pagos).
create or replace function public.support_staff_panel(p_ticket uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_user uuid := private.support_user(); v_ticket public.support_tickets%rowtype; v_ctx jsonb;
begin
  if not private.support_is_staff(v_user) then raise exception 'Solo el equipo de soporte.' using errcode = '42501', hint = 'not_staff'; end if;
  select * into v_ticket from public.support_tickets where id = p_ticket;
  if not found then raise exception 'Ticket no disponible.' using errcode = '42501', hint = 'not_available'; end if;
  select jsonb_build_object(
    'username', private.support_name(u.id),
    'memberSince', public.ai_iso(u.created_at),
    'emailConfirmed', u.email_confirmed_at is not null,
    'plan', public.ai_effective_plan(u.id),
    'sanction', case when coalesce(u.banned_until > now(), false) or coalesce(m.banned_until > now(), false) then 'banned'
                     when coalesce(m.muted_until > now(), false) then 'muted' else 'none' end,
    'sanctionUntil', public.ai_iso(case when coalesce(u.banned_until > now(), false) or coalesce(m.banned_until > now(), false)
                       then greatest(u.banned_until, m.banned_until) when coalesce(m.muted_until > now(), false) then m.muted_until end),
    'tickets', jsonb_build_object(
      'total', (select count(*) from public.support_tickets x where x.user_id = u.id),
      'open', (select count(*) from public.support_tickets x where x.user_id = u.id and x.status in ('open', 'in_progress')),
      'closed', (select count(*) from public.support_tickets x where x.user_id = u.id and x.status in ('closed', 'paid'))))
    into v_ctx
  from auth.users u left join public.user_moderation m on m.user_id = u.id where u.id = v_ticket.user_id;
  return jsonb_build_object('context', coalesce(v_ctx, '{}'::jsonb),
    'assignee', case when v_ticket.assigned_to is not null then jsonb_build_object('id', v_ticket.assigned_to,
      'name', private.support_name(v_ticket.assigned_to), 'me', v_ticket.assigned_to = v_user) end,
    'notes', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'body', n.body, 'author', private.support_name(n.author_id),
        'mine', n.author_id = v_user, 'createdAt', public.ai_iso(n.created_at)) order by n.created_at, n.id)
      from public.support_notes n where n.ticket_id = p_ticket), '[]'::jsonb));
end $$;

create or replace function public.support_assign(p_ticket uuid, p_to uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := private.support_user(); v_ticket public.support_tickets%rowtype; v_email text;
begin
  if not private.support_is_staff(v_user) then raise exception 'Solo el equipo de soporte.' using errcode = '42501', hint = 'not_staff'; end if;
  if p_to is not null and not private.support_is_staff(p_to) then
    raise exception 'Esa persona no atiende consultas.' using errcode = '22023', hint = 'bad_input';
  end if;
  select * into v_ticket from public.support_tickets where id = p_ticket for update;
  if not found then raise exception 'Ticket no disponible.' using errcode = '42501', hint = 'not_available'; end if;
  if v_ticket.status not in ('open', 'in_progress') then raise exception 'El ticket ya está cerrado.' using errcode = '22023', hint = 'closed'; end if;
  update public.support_tickets set assigned_to = p_to, assigned_at = case when p_to is null then null else now() end,
    status = case when p_to is not null and status = 'open' then 'in_progress' else status end, updated_at = now()
  where id = p_ticket returning * into v_ticket;
  select email into v_email from auth.users where id = v_user;
  perform public.admin_log(v_user, v_email, 'support.assigned', v_ticket.user_id, jsonb_build_object('ticketId', v_ticket.id,
    'assignedTo', p_to, 'actorRole', case when public.admin_is_admin_user(v_user) then 'admin' else 'support' end));
  return private.support_ticket_json(v_ticket);
end $$;

create or replace function public.support_set_priority(p_ticket uuid, p_priority text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := private.support_user(); v_ticket public.support_tickets%rowtype; v_email text;
begin
  if not private.support_is_staff(v_user) then raise exception 'Solo el equipo de soporte.' using errcode = '42501', hint = 'not_staff'; end if;
  if coalesce(p_priority, '') not in ('low', 'normal', 'high', 'urgent') then
    raise exception 'Elegí una prioridad válida.' using errcode = '22023', hint = 'bad_input';
  end if;
  update public.support_tickets set priority = p_priority, updated_at = now() where id = p_ticket returning * into v_ticket;
  if not found then raise exception 'Ticket no disponible.' using errcode = '42501', hint = 'not_available'; end if;
  select email into v_email from auth.users where id = v_user;
  perform public.admin_log(v_user, v_email, 'support.priority', v_ticket.user_id, jsonb_build_object('ticketId', v_ticket.id,
    'priority', p_priority, 'actorRole', case when public.admin_is_admin_user(v_user) then 'admin' else 'support' end));
  return private.support_ticket_json(v_ticket);
end $$;

create or replace function public.support_add_note(p_ticket uuid, p_body text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := private.support_user(); v_note public.support_notes%rowtype;
begin
  if not private.support_is_staff(v_user) then raise exception 'Solo el equipo de soporte.' using errcode = '42501', hint = 'not_staff'; end if;
  if p_body is null or char_length(btrim(p_body)) not between 1 and 2000 or p_body ~ '[\x00-\x08\x0b\x0c\x0e-\x1f]' then
    raise exception 'Escribí una nota de hasta 2000 caracteres.' using errcode = '22023', hint = 'bad_input';
  end if;
  if not exists (select 1 from public.support_tickets where id = p_ticket) then
    raise exception 'Ticket no disponible.' using errcode = '42501', hint = 'not_available';
  end if;
  if (select count(*) from public.support_notes where author_id = v_user and created_at > now() - interval '1 minute') >= 20 then
    raise exception 'Esperá un minuto antes de escribir más notas.' using errcode = '54000', hint = 'rate_minute';
  end if;
  if (select count(*) from public.support_notes where ticket_id = p_ticket) >= 100 then
    raise exception 'La consulta alcanzó el límite de notas.' using errcode = '54000', hint = 'ticket_full';
  end if;
  insert into public.support_notes (ticket_id, author_id, body) values (p_ticket, v_user, btrim(p_body)) returning * into v_note;
  return jsonb_build_object('id', v_note.id, 'body', v_note.body, 'author', private.support_name(v_user), 'mine', true,
    'createdAt', public.ai_iso(v_note.created_at));
end $$;

create or replace function public.support_macros_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_user uuid := private.support_user();
begin
  if not private.support_is_staff(v_user) then raise exception 'Solo el equipo de soporte.' using errcode = '42501', hint = 'not_staff'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'title', m.title, 'body', m.body, 'shared', m.shared,
      'mine', m.owner_id = v_user, 'owner', case when m.owner_id <> v_user then private.support_name(m.owner_id) end)
      order by (m.owner_id = v_user) desc, lower(m.title), m.id)
    from public.support_macros m where m.owner_id = v_user or m.shared), '[]'::jsonb);
end $$;

create or replace function public.support_macro_save(p_id uuid, p_title text, p_body text, p_shared boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := private.support_user(); v_row public.support_macros%rowtype;
begin
  if not private.support_is_staff(v_user) then raise exception 'Solo el equipo de soporte.' using errcode = '42501', hint = 'not_staff'; end if;
  if p_title is null or char_length(btrim(p_title)) not between 1 and 60 or p_body is null or char_length(btrim(p_body)) not between 1 and 2000
     or p_title ~ '[\x00-\x1f]' or p_body ~ '[\x00-\x08\x0b\x0c\x0e-\x1f]' then
    raise exception 'Revisá el título (hasta 60) y el texto (hasta 2000).' using errcode = '22023', hint = 'bad_input';
  end if;
  if p_id is null then
    if (select count(*) from public.support_macros where owner_id = v_user) >= 40 then
      raise exception 'Llegaste al máximo de 40 respuestas guardadas.' using errcode = '54000', hint = 'macro_limit';
    end if;
    insert into public.support_macros (owner_id, title, body, shared) values (v_user, btrim(p_title), btrim(p_body), coalesce(p_shared, false))
    returning * into v_row;
  else
    update public.support_macros set title = btrim(p_title), body = btrim(p_body), shared = coalesce(p_shared, false), updated_at = now()
    where id = p_id and owner_id = v_user returning * into v_row;
    if not found then raise exception 'Respuesta no disponible.' using errcode = '42501', hint = 'not_available'; end if;
  end if;
  return jsonb_build_object('id', v_row.id, 'title', v_row.title, 'body', v_row.body, 'shared', v_row.shared, 'mine', true);
end $$;

create or replace function public.support_macro_delete(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := private.support_user();
begin
  if not private.support_is_staff(v_user) then raise exception 'Solo el equipo de soporte.' using errcode = '42501', hint = 'not_staff'; end if;
  delete from public.support_macros where id = p_id and owner_id = v_user;
  return jsonb_build_object('ok', found);
end $$;

-- ---------- 12) Permisos ----------
revoke all on function private.support_write_user(), private.support_priority_for(text), private.support_name(uuid),
  private.support_details_clean(text, jsonb), private.support_diagnostic_clean(text),
  private.support_open_impl(text, text, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.support_open_ticket(text, text, text), public.support_submit_ticket(text, text, text, jsonb, text),
  public.support_list_tickets(boolean), public.support_ticket_detail(uuid), public.support_mark_seen(uuid),
  public.support_unread_summary(), public.support_add_message(uuid, text), public.support_resolve_ticket(uuid, boolean, text),
  public.support_close_own_ticket(uuid, text), public.support_reopen_ticket(uuid, text), public.support_rate_ticket(uuid, integer, text),
  public.support_set_diagnostic(uuid, text), public.support_register_attachments(uuid, uuid, jsonb), public.support_attachment_info(uuid),
  public.support_queue(jsonb), public.support_staff_list(), public.support_staff_panel(uuid), public.support_assign(uuid, uuid),
  public.support_set_priority(uuid, text), public.support_add_note(uuid, text), public.support_macros_list(),
  public.support_macro_save(uuid, text, text, boolean), public.support_macro_delete(uuid) from public, anon;
grant execute on function public.support_open_ticket(text, text, text), public.support_submit_ticket(text, text, text, jsonb, text),
  public.support_list_tickets(boolean), public.support_ticket_detail(uuid), public.support_mark_seen(uuid),
  public.support_unread_summary(), public.support_add_message(uuid, text), public.support_resolve_ticket(uuid, boolean, text),
  public.support_close_own_ticket(uuid, text), public.support_reopen_ticket(uuid, text), public.support_rate_ticket(uuid, integer, text),
  public.support_set_diagnostic(uuid, text), public.support_register_attachments(uuid, uuid, jsonb), public.support_attachment_info(uuid),
  public.support_queue(jsonb), public.support_staff_list(), public.support_staff_panel(uuid), public.support_assign(uuid, uuid),
  public.support_set_priority(uuid, text), public.support_add_note(uuid, text), public.support_macros_list(),
  public.support_macro_save(uuid, text, text, boolean), public.support_macro_delete(uuid) to authenticated;
