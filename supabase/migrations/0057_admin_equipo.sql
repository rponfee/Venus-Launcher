-- Venus Launcher · 0057 · Equipo del panel de administración: dar y quitar el acceso de administrador desde el panel
-- (solo el dueño), personal de soporte (atiende tickets sin ser admin) y el rango "admin" atado al acceso real.
-- Se aplica DESPUÉS de 0012, 0014, 0016, 0023 y 0045. Idempotente: se puede volver a aplicar sin perder datos.
--
-- Quién puede qué (lo decide SIEMPRE la base, dentro de cada función; el launcher solo decide qué mostrar):
--   - Dueño = administrador activo (admin_is_admin_user) cuyo perfil tiene rank = 'owner'. 'owner' se carga a mano
--     con SQL: ninguna función de acá lo da ni lo quita.
--   - admin_team(): cualquier administrador activo (solo lectura).
--   - admin_grant_admin / admin_revoke_admin: solo el dueño. Nadie se quita a sí mismo ni a una cuenta owner.
--   - admin_set_support_staff: cualquier administrador activo.
--   - admin_set_rank (0023): ya no acepta 'admin' ni cambia el rango de un administrador activo.
-- El acceso real sigue siendo la fila de app_admins + el email (actual, confirmado) en app_admin_emails, y
-- admin_is_admin_user lo vuelve a revisar en cada pedido: quitar el acceso corta al instante.
-- Todo lo que cambia algo queda en admin_actions con admin_log, sin el email de la cuenta afectada.
-- Errores con el código como mensaje y como hint (estables, los traduce el launcher): owner_only, admin_only,
-- unknown_user, anonymous, unconfirmed, banned, bad_email, cannot_self, owner_locked, admin_locked, bad_rank,
-- not_found, bad_request y grant_failed. Guía: docs/admin.md (sección "Equipo").

-- ---------- Dueño ----------

create or replace function private.admin_is_owner(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_user is not null
     and public.admin_is_admin_user(p_user)
     and exists (select 1 from public.profiles p where p.id = p_user and p.rank = 'owner')
$$;

-- Por qué una cuenta no puede recibir un rol del equipo (null si puede). Mismas condiciones que
-- admin_is_admin_user y private.support_is_staff: existe, no está borrada, no es anónima, email confirmado y
-- sin baneo (ni en Auth ni en user_moderation).
create or replace function private.admin_team_blocker(p_user uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_email text;
  v_confirmed timestamptz;
  v_deleted timestamptz;
  v_banned timestamptz;
  v_anon boolean;
begin
  if p_user is null then return 'unknown_user'; end if;
  select lower(u.email), u.email_confirmed_at, u.deleted_at, u.banned_until, coalesce(u.is_anonymous, false)
    into v_email, v_confirmed, v_deleted, v_banned, v_anon
    from auth.users u
   where u.id = p_user;
  if not found or v_deleted is not null then return 'unknown_user'; end if;
  if v_anon then return 'anonymous'; end if;
  if v_email is null or v_confirmed is null then return 'unconfirmed'; end if;
  if (v_banned is not null and v_banned > now())
     or exists (select 1 from public.user_moderation m where m.user_id = p_user and m.banned_until > now()) then
    return 'banned';
  end if;
  -- El check de app_admin_emails (y de support_staff) pide este formato.
  if char_length(v_email) not between 3 and 254 or v_email !~ '^[^@\s]+@[^@\s]+$' then return 'bad_email'; end if;
  return null;
end $$;

-- ---------- Lectura: quiénes forman el equipo ----------

-- { me: { userId, isOwner }, admins: [{ userId, username, displayName, email, grantedAt, isOwner, active,
--   lastActionAt }], staff: [{ userId, username, displayName, email, since, active }] }
-- active (admins) = admin_is_admin_user ahora; active (staff) = puede atender tickets ahora (email igual al de la
-- fila, confirmado, sin baneo). Solo administradores.
create or replace function public.admin_team() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
begin
  if not public.admin_is_admin_user(me) then raise exception 'admin_only' using errcode = '42501', hint = 'admin_only'; end if;
  return jsonb_build_object(
    'me', jsonb_build_object('userId', me, 'isOwner', private.admin_is_owner(me)),
    'admins', coalesce((
      select jsonb_agg(jsonb_build_object(
               'userId', a.user_id,
               'username', p.username,
               'displayName', p.display_name,
               'email', u.email,
               'grantedAt', public.admin_iso(a.granted_at),
               'isOwner', coalesce(p.rank = 'owner', false),
               'active', public.admin_is_admin_user(a.user_id),
               'lastActionAt', public.admin_iso((select max(x.created_at) from public.admin_actions x where x.admin_id = a.user_id))
             ) order by coalesce(p.rank = 'owner', false) desc, a.granted_at, a.user_id)
        from public.app_admins a
        left join auth.users u on u.id = a.user_id
        left join public.profiles p on p.id = a.user_id), '[]'::jsonb),
    'staff', coalesce((
      select jsonb_agg(jsonb_build_object(
               'userId', s.user_id,
               'username', p.username,
               'displayName', p.display_name,
               'email', u.email,
               'since', public.admin_iso(s.granted_at),
               'active', private.support_is_staff(s.user_id)
             ) order by s.granted_at, s.user_id)
        from public.support_staff s
        left join auth.users u on u.id = s.user_id
        left join public.profiles p on p.id = s.user_id
       where s.active), '[]'::jsonb)
  );
end $$;

-- ---------- Dar acceso de administrador (solo el dueño) ----------

-- Agrega el email ACTUAL de la cuenta a app_admin_emails y su fila a app_admins (o le actualiza el email si lo
-- cambió), y le pone rank 'admin' si no tenía uno igual o mayor. Idempotente: si ya era admin no registra nada.
-- { userId, isAdmin, changed, rank }
create or replace function public.admin_grant_admin(p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_block text;
  v_email text;
  v_rank text;
  v_rank_after text;
  v_found boolean;
  v_n integer;
  v_changed boolean := false;
begin
  if not private.admin_is_owner(me) then raise exception 'owner_only' using errcode = '42501', hint = 'owner_only'; end if;
  -- Un cambio del equipo a la vez (dos clics, dos ventanas).
  perform pg_advisory_xact_lock(hashtext('venus-admin-team'));
  v_block := private.admin_team_blocker(p_user);
  if v_block is not null then raise exception '%', v_block using errcode = '22023', hint = v_block; end if;
  select lower(u.email) into v_email from auth.users u where u.id = p_user;

  insert into public.app_admin_emails (email, note) values (v_email, 'Panel de administración: Equipo')
  on conflict (email) do nothing;
  get diagnostics v_n = row_count;
  v_changed := v_n > 0;

  insert into public.app_admins as a (user_id, email) values (p_user, v_email)
  on conflict (user_id) do update set email = excluded.email
   where a.email is distinct from excluded.email;
  get diagnostics v_n = row_count;
  v_changed := v_changed or v_n > 0;

  select p.rank into v_rank from public.profiles p where p.id = p_user for update;
  v_found := found;
  v_rank_after := v_rank;
  if v_found and (v_rank is null or v_rank in ('helper', 'mod')) then
    update public.profiles set rank = 'admin' where id = p_user;
    v_rank_after := 'admin';
    v_changed := true;
  end if;

  -- Red de seguridad: si por algo no quedó con acceso, no se guarda nada.
  if not public.admin_is_admin_user(p_user) then raise exception 'grant_failed' using errcode = 'P0001', hint = 'grant_failed'; end if;

  if v_changed then
    perform public.admin_log(me, (select u.email from auth.users u where u.id = me), 'admin.grant', p_user,
      jsonb_build_object('rankFrom', v_rank, 'rankTo', v_rank_after));
  end if;
  return jsonb_build_object('userId', p_user, 'isAdmin', true, 'changed', v_changed, 'rank', v_rank_after);
end $$;

-- ---------- Quitar acceso de administrador (solo el dueño) ----------

-- Borra la fila de app_admins y saca de app_admin_emails el email con el que se cargó y el actual, salvo que otra
-- cuenta de app_admins todavía lo use (como email guardado o como su email de ahora): así no se corta a nadie más.
-- Baja el rango 'admin' a sin rango. El acceso se corta al instante (admin_is_admin_user revisa en cada pedido).
-- También sirve para limpiar una insignia 'admin' vieja sin acceso. { userId, isAdmin, changed, rank }
create or replace function public.admin_revoke_admin(p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_rank text;
  v_rank_after text;
  v_row_email text;
  v_cur_email text;
  v_had boolean;
  v_removed integer := 0;
  v_changed boolean := false;
begin
  if not private.admin_is_owner(me) then raise exception 'owner_only' using errcode = '42501', hint = 'owner_only'; end if;
  if p_user is null then raise exception 'unknown_user' using errcode = '22023', hint = 'unknown_user'; end if;
  if p_user = me then raise exception 'cannot_self' using errcode = '22023', hint = 'cannot_self'; end if;
  perform pg_advisory_xact_lock(hashtext('venus-admin-team'));
  if not exists (select 1 from auth.users u where u.id = p_user) then
    raise exception 'unknown_user' using errcode = '22023', hint = 'unknown_user';
  end if;
  select p.rank into v_rank from public.profiles p where p.id = p_user for update;
  if v_rank = 'owner' then raise exception 'owner_locked' using errcode = '22023', hint = 'owner_locked'; end if;
  select lower(u.email) into v_cur_email from auth.users u where u.id = p_user;

  delete from public.app_admins a where a.user_id = p_user returning lower(a.email) into v_row_email;
  v_had := found;

  delete from public.app_admin_emails e
   where e.email in (v_row_email, v_cur_email)
     and not exists (
       select 1
         from public.app_admins o
         left join auth.users ou on ou.id = o.user_id
        where o.user_id <> p_user
          and (lower(o.email) = e.email or lower(ou.email) = e.email));
  get diagnostics v_removed = row_count;

  v_rank_after := v_rank;
  if v_rank = 'admin' then
    update public.profiles set rank = null where id = p_user;
    v_rank_after := null;
  end if;

  v_changed := v_had or v_removed > 0 or v_rank is distinct from v_rank_after;
  if v_changed then
    perform public.admin_log(me, (select u.email from auth.users u where u.id = me), 'admin.revoke', p_user,
      jsonb_build_object('rankFrom', v_rank, 'rankTo', v_rank_after, 'hadAccess', v_had, 'listRemoved', v_removed));
  end if;
  return jsonb_build_object('userId', p_user, 'isAdmin', public.admin_is_admin_user(p_user), 'changed', v_changed, 'rank', v_rank_after);
end $$;

-- ---------- Personal de soporte (cualquier administrador) ----------

-- Da o saca el rol de soporte de 0016 (atiende tickets, no entra al panel). Respeta el índice único
-- support_staff_one_active_email: una sola fila activa por email; si otra fila activa tenía ese email (una cuenta
-- que después se lo cambió), se desactiva, como hace 0016. La fila guarda el email actual y deja de valer si la
-- cuenta lo cambia (private.support_is_staff lo compara en cada pedido). { userId, staff, changed }
create or replace function public.admin_set_support_staff(p_user uuid, p_active boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_block text;
  v_email text;
  v_n integer;
  v_changed boolean := false;
begin
  if not public.admin_is_admin_user(me) then raise exception 'admin_only' using errcode = '42501', hint = 'admin_only'; end if;
  if p_user is null or p_active is null then raise exception 'bad_request' using errcode = '22023', hint = 'bad_request'; end if;
  perform pg_advisory_xact_lock(hashtext('venus-support-staff'));
  if p_active then
    v_block := private.admin_team_blocker(p_user);
    if v_block is not null then raise exception '%', v_block using errcode = '22023', hint = v_block; end if;
    select lower(u.email) into v_email from auth.users u where u.id = p_user;
    update public.support_staff s set active = false, updated_at = now()
     where s.email = v_email and s.user_id <> p_user and s.active;
    insert into public.support_staff as s (user_id, email, note) values (p_user, v_email, 'Panel de administración: Equipo')
    on conflict (user_id) do update
      set email = excluded.email, active = true, updated_at = now(),
          granted_at = case when s.active then s.granted_at else now() end
     where s.email is distinct from excluded.email or not s.active;
    get diagnostics v_n = row_count;
    v_changed := v_n > 0;
  else
    update public.support_staff s set active = false, updated_at = now() where s.user_id = p_user and s.active;
    get diagnostics v_n = row_count;
    v_changed := v_n > 0;
  end if;
  if v_changed then
    perform public.admin_log(me, (select u.email from auth.users u where u.id = me),
      case when p_active then 'support.staffGranted' else 'support.staffRevoked' end, p_user,
      jsonb_build_object('role', 'support', 'source', 'admin_panel'));
  end if;
  return jsonb_build_object('userId', p_user, 'staff', p_active, 'changed', v_changed);
end $$;

-- ---------- Rangos (reemplaza el de 0023, misma firma) ----------

-- helper y mod siguen igual. 'admin' va atado al acceso real: lo ponen admin_grant_admin y lo saca
-- admin_revoke_admin, así que acá no se acepta ni se le cambia el rango a un administrador activo. Una insignia
-- 'admin' vieja (sin acceso) sí se puede cambiar. 'owner' no se toca desde el panel.
create or replace function public.admin_set_rank(p_user uuid, p_rank text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  v_before text;
begin
  if not public.admin_is_admin_user(me) then raise exception 'admin_only' using errcode = '42501', hint = 'admin_only'; end if;
  if p_rank is not null and p_rank not in ('helper', 'mod') then raise exception 'bad_rank' using errcode = '22023', hint = 'bad_rank'; end if;
  select rank into v_before from public.profiles where id = p_user for update;
  if not found then raise exception 'not_found' using errcode = '22023', hint = 'not_found'; end if;
  if v_before = 'owner' then raise exception 'owner_locked' using errcode = '22023', hint = 'owner_locked'; end if;
  if v_before = 'admin' and public.admin_is_admin_user(p_user) then
    raise exception 'admin_locked' using errcode = '22023', hint = 'admin_locked';
  end if;
  if v_before is not distinct from p_rank then return jsonb_build_object('rank', p_rank); end if;
  update public.profiles set rank = p_rank where id = p_user;
  perform public.admin_log(me, (select email from auth.users where id = me), 'rank.set', p_user, jsonb_build_object('from', v_before, 'to', p_rank));
  return jsonb_build_object('rank', p_rank);
end $$;

-- ---------- Datos ----------

-- La insignia de los administradores activos que no tenían rango (o uno menor) pasa a 'admin', como si se lo
-- hubiera dado admin_grant_admin. No toca 'owner' ni saca insignias 'admin' viejas (eso lo decide el dueño).
update public.profiles p
   set rank = 'admin'
 where (p.rank is null or p.rank in ('helper', 'mod'))
   and p.id in (select a.user_id from public.app_admins a)
   and public.admin_is_admin_user(p.id);

-- ---------- Permisos ----------

revoke all on function private.admin_is_owner(uuid) from public, anon, authenticated;
revoke all on function private.admin_team_blocker(uuid) from public, anon, authenticated;
revoke all on function public.admin_team() from public, anon;
revoke all on function public.admin_grant_admin(uuid) from public, anon;
revoke all on function public.admin_revoke_admin(uuid) from public, anon;
revoke all on function public.admin_set_support_staff(uuid, boolean) from public, anon;
revoke all on function public.admin_set_rank(uuid, text) from public, anon;

grant execute on function private.admin_is_owner(uuid) to service_role;
grant execute on function private.admin_team_blocker(uuid) to service_role;
grant execute on function public.admin_team() to authenticated;
grant execute on function public.admin_grant_admin(uuid) to authenticated;
grant execute on function public.admin_revoke_admin(uuid) to authenticated;
grant execute on function public.admin_set_support_staff(uuid, boolean) to authenticated;
grant execute on function public.admin_set_rank(uuid, text) to authenticated;
