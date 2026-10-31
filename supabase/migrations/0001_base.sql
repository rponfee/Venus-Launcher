-- Venus Launcher · 0001 · Esquema base: perfiles publicos de jugadores.
-- Aplicar en orden todas las migraciones de esta carpeta (SQL Editor de Supabase o `supabase db push`).

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null unique check (username ~ '^[A-Za-z0-9_]{3,20}$'),
  display_name text check (char_length(display_name) <= 32),
  friend_code text not null unique,
  mc_name text check (char_length(mc_name) <= 16),
  mc_uuid text check (char_length(mc_uuid) <= 36),
  bio text check (char_length(bio) <= 200),
  banner text check (char_length(banner) <= 64),
  badges text[] not null default '{}',
  status text not null default 'online' check (status in ('online', 'away', 'busy', 'invisible')),
  status_text text check (char_length(status_text) <= 80),
  last_seen timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create unique index if not exists profiles_username_lower on public.profiles (lower(username));

alter table public.profiles enable row level security;

drop policy if exists "profiles_select_authenticated" on public.profiles;
create policy "profiles_select_authenticated" on public.profiles
  for select to authenticated using (true);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

-- Solo se pueden editar estas columnas (friend_code y badges los maneja el servidor).
revoke update on public.profiles from authenticated, anon;
grant update (username, display_name, mc_name, mc_uuid, bio, banner, status, status_text, last_seen)
  on public.profiles to authenticated;

-- Codigo de amigo legible: VENUS-XXXXXX (sin letras/numeros que se confunden)
create or replace function public.venus_friend_code() returns text
language plpgsql set search_path = public as $$
declare
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  code text;
begin
  loop
    code := 'VENUS-';
    for i in 1..6 loop
      code := code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.profiles p where p.friend_code = code);
  end loop;
  return code;
end $$;

-- Al registrarse se crea el perfil con el nombre elegido (o uno libre parecido).
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  base text;
  candidate text;
  n int := 0;
begin
  base := regexp_replace(coalesce(new.raw_user_meta_data ->> 'username', split_part(new.email, '@', 1), 'player'), '[^A-Za-z0-9_]', '', 'g');
  if char_length(base) < 3 then
    base := base || 'player';
  end if;
  base := left(base, 16);
  candidate := base;
  while exists (select 1 from public.profiles p where lower(p.username) = lower(candidate)) loop
    n := n + 1;
    candidate := base || n::text;
  end loop;
  insert into public.profiles (id, username, display_name, friend_code)
  values (new.id, candidate, left(coalesce(new.raw_user_meta_data ->> 'username', candidate), 32), public.venus_friend_code());
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
