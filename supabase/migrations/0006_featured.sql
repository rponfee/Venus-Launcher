-- Venus Launcher · 0006 · Servidores destacados (pestaña Multijugador > Destacados).
-- El launcher lee esta tabla con la anon key (solo las filas activas). Nadie la puede modificar
-- desde el cliente: se administra desde el panel de Supabase o con la service role.
-- Idempotente: se puede volver a aplicar sin romper nada.

create table if not exists public.featured_servers (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 64),
  address text not null check (char_length(address) between 3 and 255 and address !~ '\s'),
  description text not null default '' check (char_length(description) <= 300),
  -- Traducciones opcionales de la descripcion: {"en": "...", "pt": "..."}
  descriptions jsonb not null default '{}'::jsonb check (jsonb_typeof(descriptions) = 'object'),
  tags text[] not null default '{}' check (cardinality(tags) <= 8),
  language text not null default 'en' check (language ~ '^([a-z]{2}|multi)$'),
  region text not null default 'GLOBAL' check (char_length(region) <= 16),
  version text not null default '' check (char_length(version) <= 40),
  partner boolean not null default false,
  sort integer not null default 100,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists featured_servers_address_lower on public.featured_servers (lower(address));
create index if not exists featured_servers_listing on public.featured_servers (active, partner desc, sort, name);

-- updated_at automatico
create or replace function public.featured_servers_touch() returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists featured_servers_touch on public.featured_servers;
create trigger featured_servers_touch
  before update on public.featured_servers
  for each row execute function public.featured_servers_touch();

-- RLS: lectura de las filas activas para todos; sin escrituras desde el cliente.
alter table public.featured_servers enable row level security;

drop policy if exists "featured_servers_select_active" on public.featured_servers;
create policy "featured_servers_select_active" on public.featured_servers
  for select to anon, authenticated using (active);

revoke insert, update, delete, truncate on public.featured_servers from anon, authenticated;
grant select on public.featured_servers to anon, authenticated;

-- Lista inicial (la misma que trae el launcher). No pisa filas que ya existan.
insert into public.featured_servers (name, address, description, descriptions, tags, language, region, version, partner, sort)
values
  ('Hypixel', 'mc.hypixel.net', 'La red de minijuegos más grande del mundo: SkyBlock, Bed Wars, SkyWars y muchísimo más.',
    '{"en": "The biggest minigame network in the world: SkyBlock, Bed Wars, SkyWars and much more."}', '{minigames,skyblock,bedwars}', 'en', 'NA', '1.8 – 26.3', false, 10),
  ('Universocraft', 'mc.universocraft.com', 'La red hispana más grande: minijuegos, Bed Wars, SkyWars y supervivencia con miles de jugadores.',
    '{"en": "The largest Spanish-speaking network: minigames, Bed Wars, SkyWars and survival with thousands of players."}', '{minigames,bedwars,survival}', 'es', 'LATAM', '1.8 – 26.3', false, 20),
  ('CubeCraft Games', 'play.cubecraft.net', 'Minijuegos clásicos como EggWars, SkyWars y Lucky Islands, con eventos todo el año.',
    '{"en": "Classic minigames like EggWars, SkyWars and Lucky Islands, with events all year round."}', '{minigames,eggwars,skyblock}', 'en', 'EU', '1.20 – 1.21', false, 30),
  ('MineLatino', 'play.minelatino.com', 'Comunidad latina con supervivencia OP y más de diez modalidades distintas.',
    '{"en": "Latin American community with OP survival and more than ten different game modes."}', '{survival,minigames,pvp}', 'es', 'LATAM', '1.8 – 1.21', false, 40),
  ('Wynncraft', 'play.wynncraft.com', 'Un MMORPG completo dentro de Minecraft: misiones, clases, mazmorras y un mundo enorme.',
    '{"en": "A full MMORPG inside Minecraft: quests, classes, dungeons and a huge world."}', '{mmorpg,adventure}', 'en', 'NA', '1.9 – 26.3', false, 50),
  ('SuperCraft', 'mp.supercraft.es', 'Red española con supervivencias nuevas en cada versión y minijuegos.',
    '{"en": "Spanish network with fresh survival worlds on every version, plus minigames."}', '{survival,minigames}', 'es', 'EU', '1.8 – 26.3', false, 60),
  ('Minehut', 'minehut.com', 'Miles de servidores creados por la comunidad: entrá al lobby y elegí el que quieras.',
    '{"en": "Thousands of community-made servers: join the lobby and pick the one you like."}', '{community,smp}', 'en', 'NA', '1.8 – 26.3', false, 70),
  ('Complex Gaming', 'hub.mc-complex.com', 'La red de Pixelmon más popular, además de supervivencia, SkyBlock y más.',
    '{"en": "The most popular Pixelmon network, plus survival, SkyBlock and more."}', '{pixelmon,survival,skyblock}', 'en', 'NA', '1.8 – 26.3', false, 80),
  ('Librecraft', 'librecraft.com', 'Red española veterana con supervivencia, minijuegos y una comunidad muy activa.',
    '{"en": "A veteran Spanish network with survival, minigames and a very active community."}', '{survival,minigames}', 'es', 'EU', '1.8 – 26.2', false, 90),
  ('PikaNetwork', 'play.pika-network.net', 'Bed Wars, SkyWars, supervivencia y modos de PvP para todas las versiones.',
    '{"en": "Bed Wars, SkyWars, survival and PvP modes for every version."}', '{minigames,bedwars,survival}', 'en', 'EU', '1.8 – 26.3', false, 100),
  ('2b2t', '2b2t.org', 'El servidor anárquico más antiguo: sin reglas, sin reinicios del mapa desde 2010.',
    '{"en": "The oldest anarchy server: no rules and no map resets since 2010."}', '{anarchy,survival}', 'en', 'NA', '1.21', false, 110),
  ('ManaCube', 'play.manacube.com', 'SkyBlock, parkour, prisiones y supervivencia con mucho contenido propio.',
    '{"en": "SkyBlock, parkour, prisons and survival with lots of original content."}', '{skyblock,parkour,prison}', 'en', 'NA', '1.8 – 26.3', false, 120),
  ('BlocksMC', 'blocksmc.com', 'Bed Wars y minijuegos rápidos para jugar partidas cortas con amigos.',
    '{"en": "Bed Wars and quick minigames for short matches with friends."}', '{bedwars,minigames,pvp}', 'en', 'EU', '1.8 – 26.3', false, 130),
  ('Hylex', 'hylex.net', 'Red brasileña de minijuegos con Bed Wars, SkyWars y torneos.',
    '{"en": "Brazilian minigame network with Bed Wars, SkyWars and tournaments."}', '{minigames,bedwars}', 'pt', 'SA', '1.8 – 1.21', false, 140)
on conflict (lower(address)) do nothing;
