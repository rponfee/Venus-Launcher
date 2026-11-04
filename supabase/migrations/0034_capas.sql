-- 0034_capas.sql · Venus 3.4 · Capas de Venus en el juego.
-- Guía: docs/implementacion/capas.md. Se aplica después de 0021 (shop_items, mc_verified) y 0012 (moderation_social_block). Idempotente.
--
--   * Capas: ítems de shop_items con kind = 'cape' que se compran con shop_buy, como el resto de la tienda. data.cape es
--     el id de la textura, una de la lista fija que viene dentro del mod (mod/venus-badge: Capes.java): nunca una URL ni
--     algo subido por un usuario. Si el mod no conoce el id, no dibuja nada. Las premium_only vienen con Premium.
--   * user_capes: la capa puesta de cada cuenta de Venus. Sin acceso directo: se escribe con cape_equip y se lee con cape_mine.
--     No va en profiles.equipped porque profile_customize reemplaza ese objeto entero y las versiones viejas del launcher
--     lo mandarían sin la capa.
--   * Consultar (badge_capes): anon o con sesión, hasta 100 UUID por pedido, como badge_lookup y badge_styles. Solo devuelve
--     UUID y capa de cuentas de Minecraft verificadas con Mojang (mc_verified: no profiles.mc_uuid, que lo escribe el
--     usuario), que no estén baneadas y que sigan teniendo esa capa. Nunca la lista completa ni datos de la cuenta de Venus.
--   * La capa no depende de la insignia: quien la apaga (badge_remove) sigue con su capa puesta hasta sacársela. Sí hace falta
--     el mod para verla, igual que la insignia.

-- ---------- Tipo de ítem ----------
-- Los mismos de 0020 y uno más. Cada capa tiene que decir su textura.
alter table public.shop_items drop constraint if exists shop_items_kind_check;
alter table public.shop_items add constraint shop_items_kind_check
  check (kind in ('frame', 'name_effect', 'badge_style', 'title', 'banner', 'cape'));
alter table public.shop_items drop constraint if exists shop_items_cape_data;
alter table public.shop_items add constraint shop_items_cape_data
  check (kind <> 'cape' or coalesce((data ->> 'cape') ~ '^[a-z0-9_]{1,24}$', false));

-- ---------- Capa puesta ----------
create table if not exists public.user_capes (
  user_id uuid primary key references auth.users (id) on delete cascade,
  item_id text not null references public.shop_items (id) on update cascade on delete cascade,
  equipped_at timestamptz not null default now()
);
alter table public.user_capes enable row level security;
revoke all on public.user_capes from public, anon, authenticated;

-- ---------- Tienda ----------
-- Las texturas las dibuja mod/venus-badge/make-capes.js. Para sumar una: docs/implementacion/capas.md.
insert into public.shop_items (id, kind, price, premium_only, sort, data) values
  ('cape_dawn', 'cape', 1000, false, 400, '{"cape":"dawn"}'),
  ('cape_nebula', 'cape', 1500, false, 401, '{"cape":"nebula"}'),
  ('cape_aurora', 'cape', 1500, false, 402, '{"cape":"aurora"}'),
  ('cape_magma', 'cape', 2500, false, 403, '{"cape":"magma"}'),
  ('cape_orbit', 'cape', 0, true, 404, '{"cape":"orbit"}')
on conflict (id) do update set kind = excluded.kind, price = excluded.price, premium_only = excluded.premium_only,
  sort = excluded.sort, data = excluded.data;

-- ---------- Con la sesión de Venus ----------
-- Se pone una capa o, con null, se saca la que tiene. Errores (22023): bad_item, premium_required, not_owned:<ítem>.
create or replace function public.cape_equip(p_item text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  it record;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if public.moderation_social_block(me) = 'user_banned' then raise exception 'user_banned' using errcode = '42501'; end if;
  if p_item is null then
    delete from public.user_capes c where c.user_id = me;
    return jsonb_build_object('ok', true, 'item', null);
  end if;
  select * into it from public.shop_items si where si.id = p_item and si.kind = 'cape' and si.active;
  if not found then raise exception 'bad_item' using errcode = '22023'; end if;
  if not exists (select 1 from public.user_items ui where ui.user_id = me and ui.item_id = p_item) then
    if not it.premium_only then raise exception 'not_owned:%', p_item using errcode = '22023'; end if;
    if not public.venus_is_premium(me) then raise exception 'premium_required' using errcode = '22023'; end if;
  end if;
  insert into public.user_capes (user_id, item_id, equipped_at) values (me, p_item, now())
  on conflict (user_id) do update set item_id = excluded.item_id, equipped_at = excluded.equipped_at;
  return jsonb_build_object('ok', true, 'item', p_item);
end $$;

-- La capa puesta por quien llama, o null: { item, cape, active }. active = false si ya no se ve (se le venció Premium o el ítem se retiró).
create or replace function public.cape_mine() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('item', c.item_id, 'cape', si.data ->> 'cape', 'active', si.active
           and (exists (select 1 from public.user_items ui where ui.user_id = c.user_id and ui.item_id = c.item_id)
                or (si.premium_only and public.venus_is_premium(c.user_id))))
    from public.user_capes c
    join public.shop_items si on si.id = c.item_id
   where c.user_id = auth.uid()
$$;

-- ---------- Consultar (el mod, sin sesión) ----------
-- Como badge_styles (0021) pero con la capa. Se vuelve a comprobar que la tenga: lo premium deja de verse al perder Premium.
create or replace function public.badge_capes(p_uuids uuid[])
returns table (mc_uuid uuid, cape text)
language sql stable security definer set search_path = '' as $$
  select v.mc_uuid, si.data ->> 'cape'
    from public.mc_verified v
    join public.user_capes c on c.user_id = v.user_id
    join public.shop_items si on si.id = c.item_id and si.kind = 'cape' and si.active
   where v.mc_uuid = any (coalesce(p_uuids[1:100], '{}'))
     and public.moderation_social_block(v.user_id) is distinct from 'user_banned'
     and (exists (select 1 from public.user_items ui where ui.user_id = v.user_id and ui.item_id = si.id)
          or (si.premium_only and public.venus_is_premium(v.user_id)))
$$;

-- ---------- Permisos ----------
-- En Supabase las funciones nuevas de public quedan ejecutables por anon y authenticated: se les quita y se da lo justo.
revoke all on function public.cape_equip(text) from public, anon, authenticated;
revoke all on function public.cape_mine() from public, anon, authenticated;
revoke all on function public.badge_capes(uuid[]) from public, anon, authenticated;
grant execute on function public.cape_equip(text) to authenticated;
grant execute on function public.cape_mine() to authenticated;
grant execute on function public.badge_capes(uuid[]) to anon, authenticated;
