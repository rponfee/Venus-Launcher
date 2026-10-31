-- Venus Launcher · 0010 · Ajustes que sugirieron los advisors de Supabase al aplicar 0001-0007.
-- Idempotente: se puede volver a ejecutar.

-- 1) Seguridad: handle_new_user es la funcion del trigger de alta de usuarios; no tiene que poder
--    llamarse por la API (/rest/v1/rpc/handle_new_user).
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- 2) Rendimiento: (select auth.uid()) se evalua una vez por consulta y no una vez por fila.
alter policy "profiles_update_own" on public.profiles
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

alter policy "shared_media_select_own" on public.shared_media
  using (owner = (select auth.uid()));
alter policy "shared_media_insert_own" on public.shared_media
  with check (owner = (select auth.uid()));
alter policy "shared_media_update_own" on public.shared_media
  using (owner = (select auth.uid()))
  with check (owner = (select auth.uid()));
alter policy "shared_media_delete_own" on public.shared_media
  using (owner = (select auth.uid()));

-- 3) Indices para claves foraneas sin indice.
create index if not exists message_reactions_user_idx on public.message_reactions (user_id);
create index if not exists voice_members_invited_by_idx on public.voice_members (invited_by);
