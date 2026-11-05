-- Escenarios de la migración 0045 (Soporte). Sin \i ni metacomandos de psql: el ejecutor arma
--   BEGIN; <0045_soporte_mejoras.sql>; <este archivo>; ROLLBACK;
-- Sirve igual contra el PostgreSQL local descartable (scripts/run-support-local.ps1) y contra producción con
-- execute_sql, siempre terminando en ROLLBACK. Datos ficticios; nada de usuarios reales.

create temp table sp_checks(label text primary key);

-- Llama una consulta (que devuelve jsonb) como una persona. Devuelve el resultado o {error,state,hint}.
create function pg_temp.sp_call(who uuid, q text) returns jsonb language plpgsql as $f$
declare r jsonb; v_hint text;
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    execute q into r;
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint;
    execute 'reset role';
    return jsonb_build_object('error', sqlerrm, 'state', sqlstate, 'hint', v_hint);
  end;
  execute 'reset role';
  return r;
end $f$;

-- Cantidad de filas que ve una persona en una tabla (lectura directa, con RLS).
create function pg_temp.sp_rows(who uuid, q text) returns jsonb language plpgsql as $f$
declare n bigint;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    execute q into n;
  exception when others then
    execute 'reset role';
    return jsonb_build_object('error', sqlerrm, 'state', sqlstate);
  end;
  execute 'reset role';
  return to_jsonb(n);
end $f$;

create function pg_temp.sp_ok(ok boolean, label text) returns void language plpgsql as $f$
begin
  if ok is distinct from true then raise exception 'FALLÓ: %', label; end if;
  insert into sp_checks values (label);
end $f$;

create function pg_temp.sp_hint(r jsonb) returns text language sql as $f$ select r ->> 'hint' $f$;

do $sp$
declare
  alice uuid := '00000000-0000-4000-8000-0000000000a1';
  bob   uuid := '00000000-0000-4000-8000-0000000000a2';
  carol uuid := '00000000-0000-4000-8000-0000000000a3';  -- equipo
  grace uuid := '00000000-0000-4000-8000-0000000000a4';  -- equipo
  erin  uuid := '00000000-0000-4000-8000-0000000000a5';  -- baneada en Auth
  frank uuid := '00000000-0000-4000-8000-0000000000a6';  -- baneada solo por moderación
  hank  uuid := '00000000-0000-4000-8000-0000000000a7';  -- silenciada
  r jsonb; r2 jsonb; t1 uuid; t2 uuid; t3 uuid; m1 uuid; n int; i int; objs int;
  -- Lo que ya hay en la base (en producción hay consultas reales; acá no se las toca ni se las copia): los conteos se comparan contra esto.
  b_all int; b_pending int; b_closed int; b_waiting int; b_pay int;
  p_alice text; p_bob text; f1 text; f2 text; f3 text; f4 text;
begin
  -- Supabase protege storage.objects contra borrados directos (trigger protect_objects_delete); acá se permite, dentro de la transacción que termina en ROLLBACK.
  perform set_config('storage.allow_delete_query', 'true', true);

  -- ---------- Personas ----------
  insert into auth.users (id, aud, role, email, email_confirmed_at, raw_user_meta_data, created_at, updated_at) values
    (alice, 'authenticated', 'authenticated', 'sp-alice@example.invalid', now(), '{}', now() - interval '40 days', now()),
    (bob,   'authenticated', 'authenticated', 'sp-bob@example.invalid',   now(), '{}', now(), now()),
    (carol, 'authenticated', 'authenticated', 'sp-carol@example.invalid', now(), '{}', now(), now()),
    (grace, 'authenticated', 'authenticated', 'sp-grace@example.invalid', now(), '{}', now(), now()),
    (erin,  'authenticated', 'authenticated', 'sp-erin@example.invalid',  now(), '{}', now(), now()),
    (frank, 'authenticated', 'authenticated', 'sp-frank@example.invalid', now(), '{}', now(), now()),
    (hank,  'authenticated', 'authenticated', 'sp-hank@example.invalid',  now(), '{}', now(), now());
  select count(*), count(*) filter (where status in ('open', 'in_progress')), count(*) filter (where status in ('closed', 'paid')),
    count(*) filter (where status in ('open', 'in_progress') and (last_staff_reply_at is null or last_user_message_at > last_staff_reply_at)),
    count(*) filter (where category = 'payments')
    into b_all, b_pending, b_closed, b_waiting, b_pay from public.support_tickets;
  update auth.users set banned_until = now() + interval '30 days' where id = erin;
  insert into public.user_moderation (user_id, banned_until, ban_reason) values (frank, now() + interval '30 days', 'prueba');
  insert into public.user_moderation (user_id, muted_until, mute_reason) values (hank, now() + interval '3 days', 'prueba');
  insert into public.support_staff (user_id, email, note) values (carol, 'sp-carol@example.invalid', 'prueba'), (grace, 'sp-grace@example.invalid', 'prueba');
  insert into public.profiles (id, username, friend_code) values (alice, 'SpAlice', 'SPALICE001') on conflict (id) do update set username = 'SpAlice';
  insert into public.profiles (id, username, friend_code) values (carol, 'SpCarol', 'SPCAROL001') on conflict (id) do update set username = 'SpCarol';
  insert into public.profiles (id, username, friend_code) values (grace, 'SpGrace', 'SPGRACE001') on conflict (id) do update set username = 'SpGrace';

  -- ---------- Abrir consultas: campos propios, prioridad y validación ----------
  r := pg_temp.sp_call(alice, $q$select public.support_submit_ticket('No arranca la 1.21.1', 'game',
    'Se cierra al cargar el mundo', '{"mcVersion":"1.21.1","loader":"fabric","moment":"loading","modsChanged":"yes","steps":"abrir y esperar"}',
    E'launcher: 4.6.0\nos: Windows 11')$q$);
  perform pg_temp.sp_ok(r ->> 'id' is not null and r ->> 'firstMessageId' is not null and r ->> 'priority' = 'normal' and r ->> 'category' = 'game', 'abrir: consulta de juego con campos propios');
  t1 := (r ->> 'id')::uuid; m1 := (r ->> 'firstMessageId')::uuid;
  perform pg_temp.sp_ok((select details ->> 'loader' = 'fabric' and details ->> 'mcVersion' = '1.21.1' and diagnostic like 'launcher: 4.6.0%' and user_seen_at is not null and last_user_message_at is not null
    from public.support_tickets where id = t1), 'abrir: guarda detalles, diagnóstico y marcas de tiempo');
  r := pg_temp.sp_call(alice, $q$select public.support_submit_ticket('Pagué y no se activó zzpago', 'payments', 'Pagué ayer', '{"topic":"payment","method":"paypal","paidOn":"2026-11-01","orderRef":"ABC-123"}', null)$q$);
  perform pg_temp.sp_ok(r ->> 'priority' = 'high', 'abrir: cuenta y pagos arranca con prioridad alta');
  t2 := (r ->> 'id')::uuid;
  r := pg_temp.sp_call(alice, $q$select public.support_submit_ticket('Una idea para el launcher', 'suggestion', 'Sería lindo tener temas', '{"area":"launcher","benefit":"más comodidad"}', null)$q$);
  perform pg_temp.sp_ok(r ->> 'priority' = 'low', 'abrir: sugerencia arranca con prioridad baja');
  t3 := (r ->> 'id')::uuid;
  r := pg_temp.sp_call(alice, $q$select public.support_open_ticket('Cuarta consulta', 'general', 'x')$q$);
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'too_many_open' and r ->> 'state' = '23505', 'tope: la cuarta consulta abierta se rechaza');
  update public.support_tickets set status = 'closed', closed_at = now(), closed_by = alice where id = t3;

  r := pg_temp.sp_call(alice, $q$select public.support_submit_ticket('Asunto válido', 'game', 'Hola', '{"nope":"x"}', null)$q$);
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'bad_details', 'validar: campo desconocido');
  r := pg_temp.sp_call(alice, $q$select public.support_submit_ticket('Asunto válido', 'game', 'Hola', '{"loader":"windows"}', null)$q$);
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'bad_details', 'validar: valor fuera de la lista');
  r := pg_temp.sp_call(alice, $q$select public.support_submit_ticket('Asunto válido', 'bug', 'Hola', '{"area":1}', null)$q$);
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'bad_details', 'validar: valor que no es texto');
  r := pg_temp.sp_call(alice, format($q$select public.support_submit_ticket('Asunto válido', 'bug', 'Hola', '{"steps":"%s"}', null)$q$, repeat('a', 601)));
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'bad_details', 'validar: texto libre demasiado largo');
  r := pg_temp.sp_call(alice, $q$select public.support_submit_ticket('Asunto válido', 'payments', 'Hola', '{"paidOn":"ayer"}', null)$q$);
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'bad_details', 'validar: fecha mal formada');
  r := pg_temp.sp_call(alice, $q$select public.support_submit_ticket('Asunto válido', 'planes', 'Hola', '{}', null)$q$);
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'bad_input', 'validar: categoría desconocida');
  r := pg_temp.sp_call(alice, $q$select public.support_submit_ticket('ab', 'bug', 'Hola', '{}', null)$q$);
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'bad_input', 'validar: asunto muy corto');
  r := pg_temp.sp_call(alice, format($q$select public.support_submit_ticket('Asunto válido', 'bug', 'Hola', '{}', '%s')$q$, repeat('x', 12001)));
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'bad_diagnostic', 'validar: diagnóstico de más de 12000 caracteres');
  r := pg_temp.sp_call(alice, $q$select public.support_submit_ticket('Asunto válido', 'bug', 'Hola', '{}', 'a' || chr(7) || 'b')$q$);
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'bad_diagnostic', 'validar: diagnóstico con caracteres de control');
  perform pg_temp.sp_ok((select count(*) from public.support_tickets where user_id = alice) = 3, 'validar: nada de lo rechazado quedó guardado');

  -- Tope diario de 5 consultas
  insert into public.support_tickets (user_id, subject, category, status, closed_at, closed_by) select bob, 'Previa ' || g, 'other', 'closed', now(), bob from generate_series(1, 5) g;
  r := pg_temp.sp_call(bob, $q$select public.support_open_ticket('Sexta del día', 'general', 'x')$q$);
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'daily_limit' and r ->> 'state' = '54000', 'tope: 5 consultas por día');
  delete from public.support_tickets where user_id = bob;
  r := pg_temp.sp_call(bob, format($q$select public.support_submit_ticket('Con emojis', 'game', 'Hola mundo, cargando', '{"steps":"%s","mcVersion":"%s"}', null)$q$, repeat(chr(128512), 600), repeat('x', 24)));
  perform pg_temp.sp_ok(r ? 'id', 'validar: 600 caracteres de cuatro bytes caben en los datos propios');
  delete from public.support_tickets where user_id = bob;

  -- Compatibilidad: la firma vieja sigue andando y el JSON conserva sus campos
  r := pg_temp.sp_call(bob, $q$select public.support_open_ticket('Consulta de Bob', 'assistant', 'Tengo una duda')$q$);
  perform pg_temp.sp_ok(r ->> 'status' = 'open' and r ->> 'subject' = 'Consulta de Bob' and r ? 'createdAt' and r ? 'userId', 'compatibilidad: support_open_ticket (3 argumentos)');
  r2 := pg_temp.sp_call(alice, $q$select public.support_create_ticket('basic', 'Alice', 'paypal', '')$q$);
  perform pg_temp.sp_ok(r2 ->> 'error' like 'Los planes ahora se pagan desde Planes%', 'pagos: support_create_ticket sigue cerrada como en 0017');

  -- ---------- Nadie ve consultas ajenas; el equipo sí ----------
  perform pg_temp.sp_ok(pg_temp.sp_rows(bob, 'select count(*) from public.support_tickets') = '1'::jsonb, 'permisos: Bob solo lee su propia fila de support_tickets');
  perform pg_temp.sp_ok(pg_temp.sp_rows(bob, $q$select count(*) from public.support_messages where ticket_id = '$q$ || t1 || $q$'$q$) = '0'::jsonb, 'permisos: Bob no lee mensajes ajenos');
  perform pg_temp.sp_ok(pg_temp.sp_rows(alice, 'select count(*) from public.support_tickets') = '3'::jsonb, 'permisos: Alice lee las suyas (3)');
  perform pg_temp.sp_ok(pg_temp.sp_rows(carol, 'select count(*) from public.support_tickets') = to_jsonb(b_all + 4), 'permisos: el equipo lee todas');
  r := pg_temp.sp_call(bob, format($q$select public.support_ticket_detail('%s')$q$, t1));
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'not_available' and r ->> 'state' = '42501', 'permisos: Bob no abre el detalle de Alice');
  r := pg_temp.sp_call(bob, format($q$select public.support_add_message('%s', 'hola')$q$, t1));
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'not_available', 'permisos: Bob no escribe en la consulta de Alice');
  r := pg_temp.sp_call(bob, format($q$select public.support_close_own_ticket('%s')$q$, t1));
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'not_available', 'permisos: Bob no cierra la consulta de Alice');
  r := pg_temp.sp_call(bob, format($q$select public.support_set_diagnostic('%s', 'x')$q$, t1));
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'not_available', 'permisos: Bob no agrega diagnóstico a la consulta de Alice');
  r := pg_temp.sp_call(bob, format($q$select public.support_mark_seen('%s')$q$, t1));
  perform pg_temp.sp_ok((r ->> 'ok')::boolean is false, 'permisos: Bob no marca como vista la consulta de Alice');
  r := pg_temp.sp_call(bob, $q$select public.support_list_tickets(true)$q$);
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'not_staff', 'permisos: Bob no lista como equipo');
  r := pg_temp.sp_call(bob, $q$select public.support_queue('{}')$q$);
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'not_staff', 'permisos: Bob no ve la cola');
  r := pg_temp.sp_call(bob, format($q$select public.support_staff_panel('%s')$q$, t1));
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'not_staff', 'permisos: Bob no ve el panel del equipo');
  r := pg_temp.sp_call(bob, format($q$select public.support_add_note('%s', 'nota')$q$, t1));
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'not_staff', 'permisos: Bob no escribe notas internas');
  r := pg_temp.sp_call(bob, format($q$select public.support_assign('%s', null)$q$, t1));
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'not_staff', 'permisos: Bob no asigna');
  r := pg_temp.sp_call(bob, format($q$select public.support_set_priority('%s', 'urgent')$q$, t1));
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'not_staff', 'permisos: Bob no cambia la prioridad');
  r := pg_temp.sp_call(bob, $q$select public.support_macros_list()$q$);
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'not_staff', 'permisos: Bob no ve las respuestas guardadas');
  r := pg_temp.sp_call(bob, format($q$select public.support_resolve_ticket('%s', false, 'x')$q$, t1));
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'not_staff', 'permisos: Bob no cierra como equipo');
  perform pg_temp.sp_ok(pg_temp.sp_rows(alice, 'select count(*) from public.support_notes') ->> 'state' = '42501', 'permisos: nadie lee support_notes directo');
  perform pg_temp.sp_ok(pg_temp.sp_rows(carol, 'select count(*) from public.support_notes') ->> 'state' = '42501', 'permisos: ni siquiera el equipo lee support_notes directo');
  perform pg_temp.sp_ok(pg_temp.sp_rows(carol, 'select count(*) from public.support_macros') ->> 'state' = '42501', 'permisos: nadie lee support_macros directo');
  r := pg_temp.sp_call(alice, format($q$select public.support_ticket_detail('%s')$q$, t1));
  perform pg_temp.sp_ok(r ->> 'viewer' = 'owner' and not (r ? 'notes') and not (r ? 'context') and r #>> '{ticket,diagnostic}' like 'launcher%', 'detalle: la dueña ve diagnóstico, no ve notas ni contexto');
  r := pg_temp.sp_call(carol, format($q$select public.support_ticket_detail('%s')$q$, t1));
  perform pg_temp.sp_ok(r ->> 'viewer' = 'staff', 'detalle: el equipo lo abre como equipo');

  -- ---------- Conversación, sin leer y asignación automática ----------
  r := pg_temp.sp_call(alice, $q$select public.support_unread_summary()$q$);
  perform pg_temp.sp_ok((r ->> 'unread')::int = 0 and (r ->> 'open')::int = 2, 'avisos: sin respuestas del equipo, 0 sin leer');
  r := pg_temp.sp_call(carol, format($q$select public.support_add_message('%s', 'Probá desactivar los mods')$q$, t1));
  perform pg_temp.sp_ok(r ->> 'isAdmin' = 'true', 'mensajes: el equipo responde como equipo');
  perform pg_temp.sp_ok((select status = 'in_progress' and assigned_to = carol and last_staff_reply_at is not null from public.support_tickets where id = t1), 'mensajes: responder pasa a En atención y asigna a quien responde');
  r := pg_temp.sp_call(alice, $q$select public.support_unread_summary()$q$);
  perform pg_temp.sp_ok((r ->> 'unread')::int = 1 and r #>> '{latest,0,id}' = t1::text, 'avisos: la respuesta del equipo cuenta como sin leer');
  r := pg_temp.sp_call(alice, $q$select public.support_list_tickets(false)$q$);
  perform pg_temp.sp_ok(r @> format('[{"id":"%s","unread":true,"assigned":true,"lastReplyPreview":"Probá desactivar los mods"}]', t1)::jsonb, 'lista: marca sin leer, atendida y muestra la última respuesta');
  r := pg_temp.sp_call(alice, format($q$select public.support_mark_seen('%s')$q$, t1));
  perform pg_temp.sp_ok((r ->> 'ok')::boolean, 'avisos: marcar vista');
  r := pg_temp.sp_call(alice, $q$select public.support_unread_summary()$q$);
  perform pg_temp.sp_ok((r ->> 'unread')::int = 0, 'avisos: al verla queda en 0');
  r := pg_temp.sp_call(alice, format($q$select public.support_add_message('%s', 'Sigue igual')$q$, t1));
  perform pg_temp.sp_ok(r ->> 'isAdmin' = 'false', 'mensajes: la dueña escribe como usuaria');
  -- Quien atiende su propia consulta escribe como usuaria, no como equipo
  r := pg_temp.sp_call(carol, $q$select public.support_open_ticket('Consulta de la propia Carol', 'general', 'x')$q$);
  r2 := pg_temp.sp_call(carol, format($q$select public.support_add_message('%s', 'seguimiento mío')$q$, r ->> 'id'));
  perform pg_temp.sp_ok(r2 ->> 'isAdmin' = 'false', 'mensajes: el equipo no se responde a sí mismo como equipo');
  delete from public.support_tickets where subject = 'Consulta de la propia Carol';

  -- Topes de mensajes
  insert into public.support_messages (ticket_id, author_id, is_admin, body, created_at)
    select t1, alice, false, 'm' || g, now() - interval '5 minutes' from generate_series(1, 10) g;
  r := pg_temp.sp_call(alice, format($q$select public.support_add_message('%s', 'otro')$q$, t1));
  perform pg_temp.sp_ok(r ->> 'state' = 'ok' or r ? 'id', 'topes: mensajes viejos no cuentan para el minuto');
  insert into public.support_messages (ticket_id, author_id, is_admin, body) select t1, alice, false, 'r' || g from generate_series(1, 10) g;
  r := pg_temp.sp_call(alice, format($q$select public.support_add_message('%s', 'otro más')$q$, t1));
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'rate_minute', 'topes: 10 mensajes por minuto');
  delete from public.support_messages where ticket_id = t1 and body ~ '^[mr][0-9]+$';
  insert into public.support_messages (ticket_id, author_id, is_admin, body, created_at)
    select t1, alice, false, 'd' || g, now() - interval '2 hours' from generate_series(1, 150) g;
  r := pg_temp.sp_call(alice, format($q$select public.support_add_message('%s', 'uno más')$q$, t1));
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'daily_messages', 'topes: 150 mensajes por día para personas usuarias');
  r := pg_temp.sp_call(carol, format($q$select public.support_add_message('%s', 'el equipo no tiene tope diario')$q$, t1));
  perform pg_temp.sp_ok(r ? 'id', 'topes: el equipo no tiene el tope diario');
  delete from public.support_messages where ticket_id = t1 and body ~ '^d[0-9]+$';

  -- ---------- Capturas ----------
  p_alice := alice::text || '/' || t1::text || '/' || gen_random_uuid()::text || '.png';
  f1 := p_alice;
  perform set_config('request.jwt.claims', json_build_object('sub', alice, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  insert into storage.objects (bucket_id, name, owner, metadata) values ('support-attachments', f1, alice, '{"size":120000,"mimetype":"image/png"}');
  execute 'reset role';
  perform pg_temp.sp_ok(exists (select 1 from storage.objects where name = f1), 'capturas: la dueña sube a su carpeta de su consulta');
  -- otra carpeta, otra consulta, extensión mala, profundidad mala
  perform set_config('request.jwt.claims', json_build_object('sub', alice, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin insert into storage.objects (bucket_id, name, owner, metadata) values ('support-attachments', bob::text || '/' || t1::text || '/' || gen_random_uuid()::text || '.png', alice, '{}'); f2 := 'dentro'; exception when others then f2 := 'bloqueado'; end;
  begin insert into storage.objects (bucket_id, name, owner, metadata) values ('support-attachments', alice::text || '/' || gen_random_uuid()::text || '/' || gen_random_uuid()::text || '.png', alice, '{}'); f3 := 'dentro'; exception when others then f3 := 'bloqueado'; end;
  begin insert into storage.objects (bucket_id, name, owner, metadata) values ('support-attachments', alice::text || '/' || t1::text || '/' || gen_random_uuid()::text || '.exe', alice, '{}'); f4 := 'dentro'; exception when others then f4 := 'bloqueado'; end;
  execute 'reset role';
  perform pg_temp.sp_ok(f2 = 'bloqueado', 'capturas: no se sube a la carpeta de otra persona');
  perform pg_temp.sp_ok(f3 = 'bloqueado', 'capturas: no se sube a una consulta que no existe');
  perform pg_temp.sp_ok(f4 = 'bloqueado', 'capturas: solo png, jpg y webp');
  -- Bob no puede subir a la consulta de Alice, ni siquiera a su propia carpeta
  perform set_config('request.jwt.claims', json_build_object('sub', bob, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin insert into storage.objects (bucket_id, name, owner, metadata) values ('support-attachments', bob::text || '/' || t1::text || '/' || gen_random_uuid()::text || '.png', bob, '{}'); f2 := 'dentro'; exception when others then f2 := 'bloqueado'; end;
  execute 'reset role';
  perform pg_temp.sp_ok(f2 = 'bloqueado', 'capturas: otra persona no sube a una consulta ajena');
  -- Lectura: dueña y equipo sí; otra persona no
  perform pg_temp.sp_ok(pg_temp.sp_rows(alice, $q$select count(*) from storage.objects where bucket_id = 'support-attachments'$q$) = '1'::jsonb, 'capturas: la dueña la ve');
  perform pg_temp.sp_ok(pg_temp.sp_rows(carol, $q$select count(*) from storage.objects where bucket_id = 'support-attachments'$q$) = '1'::jsonb, 'capturas: el equipo la ve');
  perform pg_temp.sp_ok(pg_temp.sp_rows(bob, $q$select count(*) from storage.objects where bucket_id = 'support-attachments'$q$) = '0'::jsonb, 'capturas: otra persona no la ve');
  -- Registro: el tamaño y el tipo salen de Storage, no del cliente
  r := pg_temp.sp_call(alice, format($q$select public.support_register_attachments('%s', null, '[{"path":"%s","name":"mi captura.png","size":1,"mime":"text/html"}]')$q$, t1, f1));
  perform pg_temp.sp_ok(r #>> '{0,size}' = '120000' and r #>> '{0,mime}' = 'image/png' and r #>> '{0,name}' = 'mi captura.png', 'capturas: el registro usa el tamaño y tipo de Storage');
  r := pg_temp.sp_call(alice, format($q$select public.support_register_attachments('%s', null, '[{"path":"%s"}]')$q$, t1, f1));
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'attach_bad', 'capturas: no se registra dos veces el mismo archivo');
  r := pg_temp.sp_call(alice, format($q$select public.support_register_attachments('%s', null, '[{"path":"%s/%s/%s.png"}]')$q$, t1, alice, t1, gen_random_uuid()));
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'attach_missing', 'capturas: no se registra un archivo que no existe en Storage');
  r := pg_temp.sp_call(alice, format($q$select public.support_register_attachments('%s', null, '[{"path":"a/b/c.png"}]')$q$, t1));
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'attach_bad', 'capturas: ruta que no es de la persona');
  r := pg_temp.sp_call(alice, format($q$select public.support_register_attachments('%s', null, '[{},{},{},{}]')$q$, t1));
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'attach_limit', 'capturas: 3 por envío');
  r := pg_temp.sp_call(bob, format($q$select public.support_register_attachments('%s', null, '[{"path":"%s"}]')$q$, t1, f1));
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'not_available', 'capturas: otra persona no registra en una consulta ajena');
  select id into m1 from public.support_attachments where path = f1;
  r := pg_temp.sp_call(carol, format($q$select public.support_attachment_info('%s')$q$, m1));
  perform pg_temp.sp_ok(r ->> 'path' = f1, 'capturas: el equipo obtiene la ruta');
  r := pg_temp.sp_call(bob, format($q$select public.support_attachment_info('%s')$q$, m1));
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'not_available', 'capturas: otra persona no obtiene la ruta');
  perform pg_temp.sp_ok(pg_temp.sp_rows(bob, 'select count(*) from public.support_attachments') = '0'::jsonb, 'capturas: la tabla de registros tampoco se ve ajena');
  perform pg_temp.sp_ok(pg_temp.sp_rows(alice, 'select count(*) from public.support_attachments') = '1'::jsonb, 'capturas: la dueña ve sus registros');
  r := pg_temp.sp_call(alice, format($q$select public.support_ticket_detail('%s')$q$, t1));
  perform pg_temp.sp_ok((r ->> 'viewer') = 'owner' and (r #>> '{ticket,attachmentCount}') = '1', 'capturas: el detalle cuenta los adjuntos');

  -- Topes de capturas: 15 archivos por consulta y 60 por persona (sube cualquiera, por la política)
  for i in 1..14 loop
    insert into storage.objects (bucket_id, name, owner, metadata) values ('support-attachments', alice::text || '/' || t1::text || '/' || gen_random_uuid()::text || '.webp', alice, '{"size":1000,"mimetype":"image/webp"}');
  end loop;
  begin
    insert into storage.objects (bucket_id, name, owner, metadata) values ('support-attachments', alice::text || '/' || t1::text || '/' || gen_random_uuid()::text || '.webp', alice, '{"size":1000,"mimetype":"image/webp"}');
    f2 := 'dentro';
  exception when others then f2 := 'bloqueado'; end;
  perform pg_temp.sp_ok(f2 = 'bloqueado', 'topes: 15 archivos por consulta en el bucket');
  for i in 1..9 loop
    insert into storage.objects (bucket_id, name, owner, metadata) values ('support-attachments', alice::text || '/' || t2::text || '/' || gen_random_uuid()::text || '.webp', alice, '{"size":1000,"mimetype":"image/webp"}');
  end loop;
  for i in 1..6 loop
    insert into storage.objects (bucket_id, name, owner, metadata) values ('support-attachments', alice::text || '/' || gen_random_uuid()::text || '/' || gen_random_uuid()::text || '.webp', alice, '{"size":1000,"mimetype":"image/webp"}') on conflict do nothing;
  end loop;
  -- (los de consultas inexistentes no pasan la política, pero acá se insertan como superusuario para llenar el tope de 60)
  begin
    insert into storage.objects (bucket_id, name, owner, metadata) values ('support-attachments', alice::text || '/' || t2::text || '/' || gen_random_uuid()::text || '.webp', alice, '{"size":1000,"mimetype":"image/webp"}');
    f3 := 'dentro';
  exception when others then f3 := 'bloqueado'; end;
  select count(*) into objs from storage.objects where bucket_id = 'support-attachments' and name like alice::text || '/%';
  perform pg_temp.sp_ok(objs = 15 + 9 + 6 + 1 and f3 = 'dentro', 'topes: bajo el tope de 60 por persona sigue subiendo (' || objs || ')');
  for i in 1..60 - objs loop
    insert into storage.objects (bucket_id, name, owner, metadata) values ('support-attachments', alice::text || '/' || gen_random_uuid()::text || '/' || gen_random_uuid()::text || '.webp', alice, '{"size":1000,"mimetype":"image/webp"}');
  end loop;
  begin
    insert into storage.objects (bucket_id, name, owner, metadata) values ('support-attachments', alice::text || '/' || gen_random_uuid()::text || '/' || gen_random_uuid()::text || '.webp', alice, '{"size":1000,"mimetype":"image/webp"}');
    f3 := 'dentro';
  exception when others then f3 := 'bloqueado'; end;
  perform pg_temp.sp_ok(f3 = 'bloqueado', 'topes: 60 archivos por persona en el bucket');
  delete from storage.objects where bucket_id = 'support-attachments' and name like alice::text || '/%' and name <> f1;

  -- Topes de registro: 12 por consulta y 15 por día
  for i in 1..11 loop
    insert into storage.objects (bucket_id, name, metadata) values ('support-attachments', alice::text || '/' || t1::text || '/' || gen_random_uuid()::text || '.jpg', '{"size":2000,"mimetype":"image/jpeg"}');
    insert into public.support_attachments (ticket_id, uploader_id, path, file_name, mime, size_bytes)
      select t1, alice, name, 'x', 'image/jpeg', 2000 from storage.objects where bucket_id = 'support-attachments' and name like '%.jpg' and name like alice::text || '/' || t1::text || '/%' and name not in (select path from public.support_attachments);
  end loop;
  select count(*) into n from public.support_attachments where ticket_id = t1;
  insert into storage.objects (bucket_id, name, metadata) values ('support-attachments', alice::text || '/' || t1::text || '/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png', '{"size":2000,"mimetype":"image/png"}');
  r := pg_temp.sp_call(alice, format($q$select public.support_register_attachments('%s', null, '[{"path":"%s/%s/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png"}]')$q$, t1, alice, t1));
  perform pg_temp.sp_ok(n = 12 and pg_temp.sp_hint(r) = 'attach_ticket_full', 'topes: 12 capturas por consulta (' || n || ')');
  delete from public.support_attachments where ticket_id = t1 and path <> f1;
  delete from storage.objects where bucket_id = 'support-attachments' and name <> f1;
  -- 15 por día: llenar con registros de otra consulta
  insert into public.support_attachments (ticket_id, uploader_id, path, file_name, mime, size_bytes)
    select t2, alice, 'fake/' || g || '/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-' || g || '.png' || repeat('x', 20), 'x', 'image/png', 10 from generate_series(1, 12) g;
  insert into storage.objects (bucket_id, name, metadata) values ('support-attachments', alice::text || '/' || t1::text || '/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png', '{"size":2000,"mimetype":"image/png"}');
  insert into storage.objects (bucket_id, name, metadata) values ('support-attachments', alice::text || '/' || t1::text || '/cccccccc-cccc-4ccc-8ccc-cccccccccccc.png', '{"size":2000,"mimetype":"image/png"}');
  insert into storage.objects (bucket_id, name, metadata) values ('support-attachments', alice::text || '/' || t1::text || '/dddddddd-dddd-4ddd-8ddd-dddddddddddd.png', '{"size":2000,"mimetype":"image/png"}');
  r := pg_temp.sp_call(alice, format($q$select public.support_register_attachments('%s', null, '[{"path":"%s/%s/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png"},{"path":"%s/%s/cccccccc-cccc-4ccc-8ccc-cccccccccccc.png"},{"path":"%s/%s/dddddddd-dddd-4ddd-8ddd-dddddddddddd.png"}]')$q$, t1, alice, t1, alice, t1, alice, t1));
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'attach_daily', 'topes: 15 capturas por día');
  delete from public.support_attachments where ticket_id = t2;
  delete from storage.objects where bucket_id = 'support-attachments' and name <> f1;

  -- Personas sin permiso de escribir
  r := pg_temp.sp_call(erin, $q$select public.support_open_ticket('Consulta de Erin', 'general', 'x')$q$);
  perform pg_temp.sp_ok(r ->> 'state' = '42501', 'baneos: con baneo de Auth no hay acceso a Soporte');
  r := pg_temp.sp_call(erin, $q$select public.support_unread_summary()$q$);
  perform pg_temp.sp_ok(r ->> 'state' = '42501', 'baneos: ni siquiera el resumen de avisos');
  r := pg_temp.sp_call(frank, $q$select public.support_open_ticket('Consulta de Frank', 'general', 'x')$q$);
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'banned', 'baneos: el baneo de moderación no abre consultas nuevas');
  r := pg_temp.sp_call(frank, $q$select public.support_submit_ticket('Consulta de Frank', 'bug', 'x', '{}', null)$q$);
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'banned', 'baneos: tampoco con la función nueva');
  r := pg_temp.sp_call(hank, $q$select public.support_open_ticket('Consulta de Hank', 'general', 'x')$q$);
  perform pg_temp.sp_ok(r ? 'id', 'baneos: el silencio del chat no impide pedir ayuda');
  -- Frank con una consulta abierta: puede leer y responder, no adjuntar ni reabrir
  insert into public.support_tickets (id, user_id, subject, category) values ('00000000-0000-4000-8000-0000000000f1', frank, 'Apelación', 'general');
  r := pg_temp.sp_call(frank, $q$select public.support_add_message('00000000-0000-4000-8000-0000000000f1', 'Quiero apelar')$q$);
  perform pg_temp.sp_ok(r ? 'id', 'baneos: la persona baneada por moderación puede responder en una consulta que ya tenía');
  r := pg_temp.sp_call(frank, $q$select public.support_register_attachments('00000000-0000-4000-8000-0000000000f1', null, '[{}]')$q$);
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'banned', 'baneos: no adjunta capturas');
  perform set_config('request.jwt.claims', json_build_object('sub', frank, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin insert into storage.objects (bucket_id, name, owner, metadata) values ('support-attachments', frank::text || '/00000000-0000-4000-8000-0000000000f1/' || gen_random_uuid()::text || '.png', frank, '{}'); f2 := 'dentro'; exception when others then f2 := 'bloqueado'; end;
  execute 'reset role';
  perform pg_temp.sp_ok(f2 = 'bloqueado', 'baneos: no sube archivos');
  delete from public.support_tickets where id = '00000000-0000-4000-8000-0000000000f1';

  -- ---------- Equipo: contexto, asignación, prioridad, notas, respuestas guardadas ----------
  r := pg_temp.sp_call(carol, format($q$select public.support_staff_panel('%s')$q$, t2));
  perform pg_temp.sp_ok(r #>> '{context,username}' = 'SpAlice' and (r #>> '{context,emailConfirmed}') = 'true' and r #>> '{context,sanction}' = 'none'
    and (r #>> '{context,tickets,total}')::int >= 3 and not (r -> 'context' ? 'email') and not (r -> 'context' ? 'userId'), 'contexto: solo lo necesario, sin correo ni identificadores');
  r := pg_temp.sp_call(carol, format($q$select public.support_assign('%s', '%s')$q$, t2, grace));
  perform pg_temp.sp_ok((r ->> 'assigned')::boolean and (select status = 'in_progress' and assigned_to = grace from public.support_tickets where id = t2), 'asignar: a otra persona del equipo pasa a En atención');
  r := pg_temp.sp_call(carol, format($q$select public.support_assign('%s', '%s')$q$, t2, bob));
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'bad_input', 'asignar: no se asigna a quien no es del equipo');
  r := pg_temp.sp_call(carol, format($q$select public.support_assign('%s', null)$q$, t2));
  perform pg_temp.sp_ok(not (r ->> 'assigned')::boolean, 'asignar: soltar');
  r := pg_temp.sp_call(carol, format($q$select public.support_set_priority('%s', 'urgent')$q$, t2));
  perform pg_temp.sp_ok(r ->> 'priority' = 'urgent', 'prioridad: el equipo la cambia');
  r := pg_temp.sp_call(carol, format($q$select public.support_set_priority('%s', 'enorme')$q$, t2));
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'bad_input', 'prioridad: valor inválido');
  r := pg_temp.sp_call(carol, format($q$select public.support_add_note('%s', 'Revisar el pago a mano')$q$, t2));
  perform pg_temp.sp_ok(r ->> 'author' = 'SpCarol', 'notas: el equipo escribe');
  r := pg_temp.sp_call(grace, format($q$select public.support_staff_panel('%s')$q$, t2));
  perform pg_temp.sp_ok(r #>> '{notes,0,body}' = 'Revisar el pago a mano' and (r #>> '{notes,0,mine}') = 'false', 'notas: otra persona del equipo las lee');
  r := pg_temp.sp_call(alice, format($q$select public.support_ticket_detail('%s')$q$, t2));
  perform pg_temp.sp_ok(position('Revisar el pago' in r::text) = 0, 'notas: la dueña no las ve en ninguna parte del detalle');
  r := pg_temp.sp_call(alice, $q$select public.support_list_tickets(false)$q$);
  perform pg_temp.sp_ok(position('Revisar el pago' in r::text) = 0 and position('assigneeName' in r::text) = 0, 'notas: ni en su lista');
  r := pg_temp.sp_call(alice, $q$select public.support_staff_list()$q$);
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'not_staff', 'equipo: la lista de quién atiende es del equipo');
  r := pg_temp.sp_call(carol, $q$select public.support_staff_list()$q$);
  perform pg_temp.sp_ok((select count(*) from jsonb_array_elements(r) x where x ->> 'name' in ('SpCarol', 'SpGrace')) = 2, 'equipo: lista a las dos personas activas');
  r := pg_temp.sp_call(carol, $q$select public.support_macro_save(null, 'Saludo', 'Hola {name}, gracias por escribirnos.', true)$q$);
  perform pg_temp.sp_ok(r ? 'id' and (r ->> 'shared')::boolean, 'respuestas: guardar');
  r2 := pg_temp.sp_call(grace, $q$select public.support_macros_list()$q$);
  perform pg_temp.sp_ok(r2 #>> '{0,title}' = 'Saludo' and (r2 #>> '{0,mine}') = 'false', 'respuestas: las compartidas las ve otra persona del equipo');
  r2 := pg_temp.sp_call(grace, format($q$select public.support_macro_save('%s', 'Robo', 'x', false)$q$, r ->> 'id'));
  perform pg_temp.sp_ok(pg_temp.sp_hint(r2) = 'not_available', 'respuestas: no se editan las de otra persona');
  r2 := pg_temp.sp_call(grace, format($q$select public.support_macro_delete('%s')$q$, r ->> 'id'));
  perform pg_temp.sp_ok(not (r2 ->> 'ok')::boolean, 'respuestas: no se borran las de otra persona');
  r2 := pg_temp.sp_call(carol, format($q$select public.support_macro_save('%s', 'Saludo 2', 'Hola', false)$q$, r ->> 'id'));
  perform pg_temp.sp_ok(r2 ->> 'title' = 'Saludo 2' and not (r2 ->> 'shared')::boolean, 'respuestas: editar las propias');
  r2 := pg_temp.sp_call(grace, $q$select public.support_macros_list()$q$);
  perform pg_temp.sp_ok(jsonb_array_length(r2) = 0, 'respuestas: dejar de compartir las oculta');
  r2 := pg_temp.sp_call(carol, format($q$select public.support_macro_delete('%s')$q$, r ->> 'id'));
  perform pg_temp.sp_ok((r2 ->> 'ok')::boolean, 'respuestas: borrar las propias');
  for i in 1..40 loop insert into public.support_macros (owner_id, title, body) values (carol, 'm' || i, 'b'); end loop;
  r := pg_temp.sp_call(carol, $q$select public.support_macro_save(null, 'Una más', 'x', false)$q$);
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'macro_limit', 'respuestas: tope de 40');
  delete from public.support_macros;
  r := pg_temp.sp_call(carol, $q$select public.support_macro_save(null, '', 'x', false)$q$);
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'bad_input', 'respuestas: título vacío');

  -- ---------- Cola con filtros ----------
  update public.support_tickets set priority = 'normal' where id = t1;
  r := pg_temp.sp_call(carol, $q$select public.support_queue('{}')$q$);
  perform pg_temp.sp_ok(jsonb_array_length(r -> 'items') = 4 + b_pending and (r #>> '{counts,pending}')::int = 4 + b_pending, 'cola: por defecto, las pendientes');
  perform pg_temp.sp_ok(r #>> '{items,0,id}' = t2::text and r #>> '{items,0,priority}' = 'urgent', 'cola: la urgente va primero');
  perform pg_temp.sp_ok((r -> 'items' -> 0) ? 'userName' and (r -> 'items' -> 0) ? 'waiting' and not (r -> 'items' -> 0 ? 'email'), 'cola: trae nombre de usuario y no el correo');
  r := pg_temp.sp_call(carol, $q$select public.support_queue('{"status":"closed"}')$q$);
  perform pg_temp.sp_ok((r ->> 'total')::int = 1 + b_closed, 'cola: cerradas');
  r := pg_temp.sp_call(carol, $q$select public.support_queue('{"status":"all","category":"payments"}')$q$);
  perform pg_temp.sp_ok((r ->> 'total')::int = 1 + b_pay and r #>> '{items,0,id}' = t2::text, 'cola: por categoría');
  r := pg_temp.sp_call(carol, $q$select public.support_queue('{"priority":"urgent"}')$q$);
  perform pg_temp.sp_ok((r ->> 'total')::int = 1, 'cola: por prioridad');
  r := pg_temp.sp_call(carol, $q$select public.support_queue('{"assigned":"me"}')$q$);
  perform pg_temp.sp_ok((r ->> 'total')::int = 1 and r #>> '{items,0,id}' = t1::text, 'cola: asignadas a mí');
  r := pg_temp.sp_call(carol, $q$select public.support_queue('{"assigned":"none"}')$q$);
  perform pg_temp.sp_ok((r ->> 'total')::int = 3 + b_pending, 'cola: sin asignar');
  r := pg_temp.sp_call(carol, $q$select public.support_queue('{"search":"ZZPAGO"}')$q$);
  perform pg_temp.sp_ok((r ->> 'total')::int = 1, 'cola: búsqueda por asunto sin distinguir mayúsculas');
  r := pg_temp.sp_call(carol, $q$select public.support_queue('{"search":"spalice","status":"all"}')$q$);
  perform pg_temp.sp_ok((r ->> 'total')::int = 3, 'cola: búsqueda por nombre de usuario (Alice tiene 3)');
  r := pg_temp.sp_call(carol, $q$select public.support_queue('{"search":"%"}')$q$);
  perform pg_temp.sp_ok((r ->> 'total')::int = 0, 'cola: el comodín % se busca como texto');
  r := pg_temp.sp_call(carol, $q$select public.support_queue('{"status":"waiting"}')$q$);
  perform pg_temp.sp_ok((r ->> 'total')::int = 3 + b_waiting and (r #>> '{counts,waiting}')::int = (r ->> 'total')::int, 'cola: esperando al equipo coincide con el contador');
  r := pg_temp.sp_call(carol, $q$select public.support_queue('{"status":"all","limit":1,"page":1,"sort":"oldest"}')$q$);
  perform pg_temp.sp_ok(jsonb_array_length(r -> 'items') = 1 and (r ->> 'total')::int = b_all + 5 and (r ->> 'page')::int = 1, 'cola: paginado y orden');
  r := pg_temp.sp_call(carol, $q$select public.support_queue('{"status":"todas"}')$q$);
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'bad_input', 'cola: filtro inválido');
  r := pg_temp.sp_call(carol, $q$select public.support_queue('{"category":"x; drop table"}')$q$);
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'bad_input', 'cola: categoría inválida');
  r := pg_temp.sp_call(carol, $q$select public.support_queue('{"limit":"5000"}')$q$);
  perform pg_temp.sp_ok((r ->> 'limit')::int = 100, 'cola: el tamaño de página tiene tope');

  -- ---------- Cerrar, valorar y reabrir ----------
  r := pg_temp.sp_call(alice, format($q$select public.support_rate_ticket('%s', 5, 'bien')$q$, t1));
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'not_closed', 'valorar: solo consultas cerradas');
  r := pg_temp.sp_call(carol, format($q$select public.support_resolve_ticket('%s', false, 'Era un mod viejo')$q$, t1));
  perform pg_temp.sp_ok(r ->> 'status' = 'closed', 'cerrar: el equipo cierra');
  perform pg_temp.sp_ok((select code = 'closed' and body = 'Consulta cerrada. Era un mod viejo' and is_admin from public.support_messages where ticket_id = t1 order by created_at desc, id desc limit 1), 'cerrar: el mensaje de cierre conserva el texto de siempre y suma el código');
  r := pg_temp.sp_call(carol, format($q$select public.support_resolve_ticket('%s', true, 'x')$q$, t1));
  perform pg_temp.sp_ok(r ->> 'state' = '22023', 'cerrar: confirmar pagos por ticket sigue deshabilitado');
  r := pg_temp.sp_call(alice, format($q$select public.support_add_message('%s', 'más')$q$, t1));
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'closed', 'cerrar: no se responde una consulta cerrada');
  r := pg_temp.sp_call(alice, format($q$select public.support_rate_ticket('%s', 0, '')$q$, t1));
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'bad_input', 'valorar: 0 estrellas no vale');
  r := pg_temp.sp_call(alice, format($q$select public.support_rate_ticket('%s', 6, '')$q$, t1));
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'bad_input', 'valorar: 6 estrellas no vale');
  r := pg_temp.sp_call(alice, format($q$select public.support_rate_ticket('%s', 4, '%s')$q$, t1, repeat('a', 501)));
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'bad_input', 'valorar: comentario de más de 500');
  r := pg_temp.sp_call(bob, format($q$select public.support_rate_ticket('%s', 1, 'mal')$q$, t1));
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'not_available', 'valorar: solo la dueña');
  r := pg_temp.sp_call(alice, format($q$select public.support_rate_ticket('%s', 4, 'Rápido y claro')$q$, t1));
  perform pg_temp.sp_ok((r ->> 'rating')::int = 4, 'valorar: 4 estrellas');
  r := pg_temp.sp_call(alice, format($q$select public.support_rate_ticket('%s', 5, '')$q$, t1));
  perform pg_temp.sp_ok((r ->> 'rating')::int = 5, 'valorar: se puede corregir');
  r := pg_temp.sp_call(carol, $q$select public.support_queue('{"status":"closed"}')$q$);
  perform pg_temp.sp_ok((r #>> '{counts,ratingAvg}')::numeric = 5 and (r #>> '{counts,ratingCount}')::int = 1, 'valorar: el equipo ve el promedio de 30 días');
  r := pg_temp.sp_call(alice, format($q$select public.support_reopen_ticket('%s', '')$q$, t1));
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'bad_input', 'reabrir: pide un mensaje');
  r := pg_temp.sp_call(bob, format($q$select public.support_reopen_ticket('%s', 'x')$q$, t1));
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'not_available', 'reabrir: no la de otra persona');
  r := pg_temp.sp_call(alice, format($q$select public.support_reopen_ticket('%s', 'Volvió a pasar')$q$, t1));
  perform pg_temp.sp_ok(r ->> 'status' = 'open' and (r ->> 'reopenCount')::int = 1, 'reabrir: la dueña reabre dentro del plazo');
  perform pg_temp.sp_ok((select code = 'reopened' and not is_admin and body = 'Volvió a pasar' from public.support_messages where ticket_id = t1 order by created_at desc, id desc limit 1), 'reabrir: queda su mensaje con el código');
  r := pg_temp.sp_call(alice, format($q$select public.support_reopen_ticket('%s', 'otra vez')$q$, t1));
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'not_closed', 'reabrir: una consulta abierta no se reabre');
  r := pg_temp.sp_call(alice, format($q$select public.support_close_own_ticket('%s', 'Ya está')$q$, t1));
  perform pg_temp.sp_ok(r ->> 'status' = 'closed', 'cerrar: la dueña da por resuelta su consulta');
  perform pg_temp.sp_ok((select code = 'closed_self' and not is_admin from public.support_messages where ticket_id = t1 order by created_at desc, id desc limit 1), 'cerrar: el mensaje de cierre propio lleva su código');
  update public.support_tickets set closed_at = now() - interval '15 days' where id = t1;
  r := pg_temp.sp_call(alice, format($q$select public.support_reopen_ticket('%s', 'tarde')$q$, t1));
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'reopen_expired', 'reabrir: pasados 14 días no se puede');
  update public.support_tickets set closed_at = now(), reopen_count = 3 where id = t1;
  r := pg_temp.sp_call(alice, format($q$select public.support_reopen_ticket('%s', 'otra más')$q$, t1));
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'reopen_limit', 'reabrir: hasta 3 veces');
  r := pg_temp.sp_call(carol, format($q$select public.support_reopen_ticket('%s', '')$q$, t1));
  perform pg_temp.sp_ok(r ->> 'status' = 'in_progress', 'reabrir: el equipo reabre sin esos topes ni mensaje');
  update public.support_tickets set status = 'paid', closed_at = now(), closed_by = carol, payment_reference = 'x', plan_id = 'basic', plan_name = 'Basic', price_usd = 4, payment_method = 'paypal' where id = t2;
  r := pg_temp.sp_call(alice, format($q$select public.support_reopen_ticket('%s', 'x')$q$, t2));
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'not_closed', 'reabrir: los pedidos de plan viejos (paid) no se reabren');
  update public.support_tickets set diagnostic_at = now() - interval '1 minute' where id = t1;
  r := pg_temp.sp_call(alice, format($q$select public.support_set_diagnostic('%s', 'launcher: 4.6.0')$q$, t1));
  perform pg_temp.sp_ok((r ->> 'hasDiagnostic')::boolean, 'diagnóstico: se agrega después');
  r := pg_temp.sp_call(alice, format($q$select public.support_set_diagnostic('%s', 'otra vez')$q$, t1));
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) = 'rate_minute', 'diagnóstico: no se reenvía seguido');
  r := pg_temp.sp_call(alice, format($q$select public.support_set_diagnostic('%s', '   ')$q$, t1));
  perform pg_temp.sp_ok(pg_temp.sp_hint(r) in ('bad_input', 'rate_minute'), 'diagnóstico: vacío no se acepta');

  -- ---------- Permisos de ejecución ----------
  perform pg_temp.sp_ok(not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in ('support_submit_ticket', 'support_queue', 'support_staff_panel', 'support_assign', 'support_set_priority',
        'support_add_note', 'support_macros_list', 'support_macro_save', 'support_macro_delete', 'support_mark_seen', 'support_unread_summary',
        'support_reopen_ticket', 'support_close_own_ticket', 'support_rate_ticket', 'support_set_diagnostic', 'support_register_attachments',
        'support_attachment_info', 'support_staff_list', 'support_open_ticket', 'support_list_tickets', 'support_ticket_detail', 'support_add_message',
        'support_resolve_ticket')
      and (has_function_privilege('anon', p.oid, 'execute') or not has_function_privilege('authenticated', p.oid, 'execute'))),
    'ejecución: anon no ejecuta nada y authenticated sí');
  perform pg_temp.sp_ok(not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'private' and p.proname in ('support_write_user', 'support_priority_for', 'support_name', 'support_details_clean',
        'support_diagnostic_clean', 'support_open_impl', 'support_attachment_before')
      and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))),
    'ejecución: las ayudas privadas no las ejecuta nadie desde afuera');
  perform pg_temp.sp_ok(has_function_privilege('anon', 'public.support_create_ticket(text,text,text,text)'::regprocedure, 'execute') is false, 'ejecución: support_create_ticket sigue sin anon');
  perform pg_temp.sp_ok(not has_table_privilege('authenticated', 'public.support_notes', 'select') and not has_table_privilege('authenticated', 'public.support_macros', 'select')
    and not has_table_privilege('anon', 'public.support_attachments', 'select') and has_table_privilege('authenticated', 'public.support_attachments', 'select'), 'ejecución: tablas nuevas sin permisos directos (salvo leer capturas con RLS)');
  perform pg_temp.sp_ok((select public from storage.buckets where id = 'support-attachments') is false
    and (select file_size_limit from storage.buckets where id = 'support-attachments') = 4194304
    and (select allowed_mime_types from storage.buckets where id = 'support-attachments') = array['image/png', 'image/jpeg', 'image/webp'], 'bucket: privado, 4 MiB y solo png, jpeg y webp');
  perform pg_temp.sp_ok(not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'support_attachments%' and cmd in ('UPDATE', 'DELETE', 'ALL')),
    'bucket: sin políticas de actualizar ni borrar');
  perform pg_temp.sp_ok(not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'
    and c.relname in ('support_attachments', 'support_notes', 'support_macros') and not c.relrowsecurity), 'tablas nuevas: RLS activa');
end $sp$;

select 'SOPORTE_CHECKS=' || count(*) from sp_checks;
