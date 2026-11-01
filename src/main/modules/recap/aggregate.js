'use strict';
// "Tu resumen de Venus" (sin Electron): junta las partidas de data/stats.json, el tiempo por mundo y por
// servidor (data/stats-activity*.json) y lo que hay hoy en las instancias, para la tarjeta que se comparte.
// Periodos: los mismos que usa el resto del launcher. "Esta semana" son los ultimos 7 dias con hoy incluido
// (igual que "Esta semana" de Inicio y "Ultimos 7 dias" de Estadisticas), "Este mes" los ultimos 30 dias y
// "Desde siempre" todo el historial, con las sesiones archivadas. Nunca lanza con datos vacios o rotos: lo que
// no se puede calcular queda afuera (null o sin cifra) y la tarjeta no lo muestra.

const DAY = 86400000;
const MAX_SESSION_MS = 30 * DAY; // igual que core/stats: una sesion mas larga es un reloj roto (va entera a su dia)
const MIN_PLACE_MS = 60000; // menos de un minuto en un mundo o servidor no lo hace "el mas jugado"
const PERIODS = [
  { id: 'week', days: 7 },
  { id: 'month', days: 30 },
  { id: 'all', days: null },
];
const LOADER_KEYS = new Set(['vanilla', 'fabric', 'quilt', 'forge', 'neoforge', 'optifine', 'iris', 'legacyfabric', 'babric']);
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const NAME_MAX = 120;

const pad = (n) => String(n).padStart(2, '0');
function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function addDays(ts, n) {
  const d = new Date(ts);
  d.setDate(d.getDate() + n);
  return d.getTime();
}
function keyDate(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}
const obj =(v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const positive = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const text = (v, max = NAME_MAX) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

// Reparte [start, end) entre los dias que abarca (hora local), como core/stats.
function splitDays(start, end, cb) {
  if (!(end > start)) return;
  if (end - start > MAX_SESSION_MS) {
    cb(dayKey(start), end - start);
    return;
  }
  let t = start;
  while (t < end) {
    const d = new Date(t);
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    const stop = Math.min(next > t ? next : end, end);
    cb(dayKey(t), stop - t);
    t = stop;
  }
}

function cleanSessions(list) {
  const out = [];
  for (const s of Array.isArray(list) ? list : []) {
    if (!s || typeof s !== 'object') continue;
    const start = Number(s.start);
    const end = Number(s.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end < start) continue;
    out.push({
      instanceId: typeof s.instanceId === 'string' ? s.instanceId : String(s.instanceId ?? ''),
      name: text(s.name),
      mcVersion: text(s.mcVersion, 40),
      loader: text(s.loader, 40),
      start,
      end,
      duration: end - start,
    });
  }
  return out;
}

// Sesiones viejas resumidas por core/stats (data.archived): solo totales, por dia y por instancia.
function cleanArchive(a) {
  if (!a || typeof a !== 'object') return null;
  const ms = Number(a.ms);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const first = Number(a.firstPlay);
  return {
    ms,
    sessions: positive(a.sessions),
    firstPlay: Number.isFinite(first) && first > 0 ? first : null,
    longestMs: positive(a.longest?.ms),
    days: obj(a.days),
    daySessions: obj(a.daySessions),
    byInstance: obj(a.byInstance),
  };
}

function loaderKey(v) {
  return typeof v === 'string' && LOADER_KEYS.has(v) ? v : null;
}

// Racha actual (hoy o, si hoy no se jugo, hasta ayer) y la mas larga, como core/stats.
function streaks(days, now) {
  const keys = Object.keys(days)
    .filter((k) => days[k] > 0)
    .sort();
  let longest = 0;
  let run = 0;
  let prev = null;
  for (const k of keys) {
    run = prev && dayKey(addDays(keyDate(prev), 1)) === k ? run + 1 : 1;
    if (run > longest) longest = run;
    prev = k;
  }
  let cur = startOfDay(now);
  const playedToday = (days[dayKey(cur)] || 0) > 0;
  if (!playedToday) cur = addDays(cur, -1);
  let current = 0;
  while ((days[dayKey(cur)] || 0) > 0) {
    current++;
    cur = addDays(cur, -1);
  }
  return { current, longest, playedToday };
}

// Direcciones que no conviene mostrar en una imagen publica: IP sueltas, la red local, tuneles para jugar con
// amigos y DNS dinamicos de servidores caseros (dejan llegar a la PC de alguien). Solo se muestran dominios.
const PRIVATE_HOSTS = new RegExp(
  `(^|\\.)(${[
    'localhost', 'local', 'lan', 'internal', 'home', 'e4mc\\.link', 'bore\\.pub', 'playit\\.gg', 'ply\\.gg', 'joinmc\\.link', 'ngrok\\.io', 'ngrok-free\\.app', 'trycloudflare\\.com',
    'duckdns\\.org', 'ddns\\.net', 'no-ip\\.[a-z]+', 'noip\\.me', 'hopto\\.org', 'zapto\\.org', 'servegame\\.com', 'sytes\\.net', 'myftp\\.org', 'freeddns\\.org', 'dynu\\.net', 'mooo\\.com', 'dyndns\\.org', 'ddnsfree\\.com',
  ].join('|')})$`,
  'i',
);
function publicServer(address) {
  const raw = typeof address === 'string' ? address.trim().toLowerCase() : '';
  if (!raw || raw.length > 253) return null;
  let host = raw;
  if (host.startsWith('[')) return null; // IPv6 entre corchetes
  const colon = host.lastIndexOf(':');
  if (colon > 0) {
    if (host.indexOf(':') !== colon) return null; // IPv6 sin corchetes
    host = host.slice(0, colon);
  }
  host = host.replace(/\.$/, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  // Ningun dominio termina en numeros: 192.168.0.10, 10.1.5 o 127.1 son IP (Minecraft acepta las cortas)
  if (/^\d+$/.test(host.slice(host.lastIndexOf('.') + 1))) return null;
  if (PRIVATE_HOSTS.test(host)) return null;
  return host;
}

function sumKeys(map, keys) {
  let total = 0;
  for (const k of keys) total += positive(map[k]);
  return total;
}

// Mundo o servidor con mas tiempo en el periodo (keys = dias del periodo, null = todo el historial).
function placesIn(places, keys) {
  let best = null;
  let worlds = 0;
  let servers = 0;
  for (const p of Array.isArray(places) ? places : []) {
    if (!p || typeof p !== 'object') continue;
    const world = p.kind === 'world' ? text(p.world, 255) : null;
    const server = p.kind === 'server' ? text(p.address, 260) : null;
    if (!world && !server) continue;
    const ms = keys ? sumKeys(obj(p.days), keys) : positive(p.ms);
    if (!(ms > 0)) continue;
    if (world) worlds++;
    else servers++;
    if (ms < MIN_PLACE_MS) continue;
    if (world) {
      const instanceId = text(p.instanceId, 255);
      if (!instanceId) continue;
      if (!best || ms > best.ms) best = { kind: 'world', instanceId, world, instanceName: text(p.instanceName), ms };
    } else {
      const host = publicServer(server);
      if (host && (!best || ms > best.ms)) best = { kind: 'server', address: host, ms };
    }
  }
  return { top: best, worlds, servers };
}

/**
 * Arma el resumen.
 *   data: lo de stats.get() ({ sessions, archived, milestones, firstUse })
 *   places: lo de statsplus/activity.aggregate() (tiempo por mundo y por servidor, con ms por dia)
 *   instances: instancias que existen hoy ({ id, name, mcVersion, loader, preset })
 *   collection: { instances, mods, worlds, perInstance: { [id]: { mods, worlds } } } o null
 *   milestoneIds: ids de core/stats.MILESTONES
 */
function buildRecap({ data, places, instances, collection, milestoneIds, now = Date.now() } = {}) {
  const raw = obj(data);
  const sessions = cleanSessions(raw.sessions);
  const arch = cleanArchive(raw.archived);
  const list = (Array.isArray(instances) ? instances : []).filter((i) => i && typeof i.id === 'string' && i.id);
  const byId = new Map(list.map((i) => [i.id, i]));
  const perInstance = obj(collection?.perInstance);

  // Tiempo por dia (las sesiones archivadas traen sus propios totales por dia)
  const days = {};
  const addTo = (map, k, v) => {
    if (v > 0) map[k] = (map[k] || 0) + v;
  };
  if (arch) {
    for (const [k, v] of Object.entries(arch.days)) if (DAY_KEY.test(k)) addTo(days, k, positive(v));
  }
  for (const s of sessions) splitDays(s.start, s.end, (k, ms) => addTo(days, k, ms));
  const st = streaks(days, now);

  // Ultima partida de cada instancia (version y loader si la instancia ya no existe)
  const lastOf = new Map();
  for (const s of sessions) {
    const prev = lastOf.get(s.instanceId);
    if (!prev || s.end > prev.end) lastOf.set(s.instanceId, s);
  }
  const favoriteFrom = (byInst) => {
    let best = null;
    for (const [id, v] of byInst) if (id && v.ms > 0 && (!best || v.ms > best.ms)) best = { id, ...v };
    if (!best) return null;
    const inst = byId.get(best.id);
    const last = lastOf.get(best.id);
    const counts = inst ? obj(perInstance[best.id]) : {};
    return {
      id: best.id,
      name: text(inst?.name) || best.name || last?.name || best.id.slice(0, NAME_MAX),
      mcVersion: text(inst?.mcVersion, 40) || last?.mcVersion || null,
      loader: inst ? (inst.preset === 'iris' ? 'iris' : loaderKey(inst.loader) || 'vanilla') : loaderKey(last?.loader),
      ms: best.ms,
      sessions: best.sessions,
      exists: Boolean(inst),
      mods: inst && Number.isInteger(counts.mods) && counts.mods >= 0 ? counts.mods : null,
    };
  };

  const firstPlay = Math.min(arch?.firstPlay ?? Infinity, ...sessions.map((s) => s.start));
  const allMs = (arch?.ms || 0) + sessions.reduce((a, s) => a + s.duration, 0);
  const allSessions = (arch?.sessions || 0) + sessions.length;
  const ids = Array.isArray(milestoneIds) ? milestoneIds.filter((x) => typeof x === 'string') : [];
  const stored = obj(raw.milestones);
  const milestones = { achieved: ids.filter((id) => Number.isFinite(Number(stored[id])) && Number(stored[id]) > 0).length, total: ids.length };

  const today = startOfDay(now);
  const periods = {};
  for (const def of PERIODS) {
    let ms;
    let count;
    let daysPlayed;
    let from;
    let longestMs = 0;
    let keys = null;
    const byInst = new Map();
    const bump = (id, ms2, n) => {
      const e = byInst.get(id) || { ms: 0, sessions: 0, name: null };
      e.ms += ms2;
      e.sessions += n;
      byInst.set(id, e);
      return e;
    };
    if (def.days) {
      from = addDays(today, -(def.days - 1));
      const until = addDays(today, 1);
      keys = [];
      for (let i = def.days - 1; i >= 0; i--) keys.push(dayKey(addDays(today, -i)));
      ms = sumKeys(days, keys);
      daysPlayed = keys.filter((k) => (days[k] || 0) > 0).length;
      // Partidas del periodo: las que suman tiempo adentro. Una que empezo la noche anterior al periodo y siguio
      // despues de medianoche tambien cuenta (nunca "1 h de juego en 0 partidas"). De las archivadas solo se
      // sabe cuantas empezaron cada dia.
      count = arch ? sumKeys(arch.daySessions, keys) : 0;
      for (const s of sessions) {
        const starts = s.start >= from && s.start < until;
        // Un reloj roto (mas de 30 dias) va entero al dia en que empezo, igual que en `days`
        const part = s.duration > MAX_SESSION_MS ? (starts ? s.duration : 0) : Math.min(s.end, until) - Math.max(s.start, from);
        if (part > 0 || starts) {
          count++;
          const e = bump(s.instanceId, Math.max(0, part), 1);
          e.name = s.name || e.name;
        }
        if (starts && s.duration <= MAX_SESSION_MS) longestMs = Math.max(longestMs, s.duration);
      }
    } else {
      ms = allMs;
      count = allSessions;
      daysPlayed = Object.values(days).filter((v) => v > 0).length;
      from = Number.isFinite(firstPlay) ? firstPlay : null;
      if (arch) {
        for (const [id, v] of Object.entries(arch.byInstance)) {
          const e = bump(id, positive(v?.ms), positive(v?.sessions));
          e.name = text(v?.name) || e.name;
        }
        longestMs = arch.longestMs <= MAX_SESSION_MS ? arch.longestMs : 0;
      }
      for (const s of sessions) {
        const e = bump(s.instanceId, s.duration, 1);
        e.name = s.name || e.name;
        if (s.duration <= MAX_SESSION_MS) longestMs = Math.max(longestMs, s.duration);
      }
    }
    const where = placesIn(places, keys);
    const figures = [];
    if (def.days) {
      if (daysPlayed > 0) figures.push({ id: 'daysPlayed', value: daysPlayed, total: def.days });
      if (st.current > 0) figures.push({ id: 'streak', value: st.current });
      if (count >= 2 && longestMs > 0) figures.push({ id: 'longest', value: longestMs });
      if (where.worlds > 0) figures.push({ id: 'worlds', value: where.worlds });
      if (where.servers > 0) figures.push({ id: 'servers', value: where.servers });
      if (count >= 2 && ms > 0) figures.push({ id: 'avg', value: Math.round(ms / count) });
    } else {
      if (st.longest > 0) figures.push({ id: 'bestStreak', value: st.longest });
      if (count >= 2 && longestMs > 0) figures.push({ id: 'longest', value: longestMs });
      if (milestones.achieved > 0) figures.push({ id: 'milestones', value: milestones.achieved, total: milestones.total });
      if (daysPlayed > 0) figures.push({ id: 'totalDays', value: daysPlayed });
      if (count >= 2 && ms > 0) figures.push({ id: 'avg', value: Math.round(ms / count) });
    }
    periods[def.id] = {
      id: def.id,
      days: def.days,
      from,
      to: now,
      ms,
      sessions: count,
      daysPlayed,
      longestMs,
      favorite: favoriteFrom(byInst),
      top: where.top,
      worldsVisited: where.worlds,
      serversVisited: where.servers,
      figures,
    };
  }

  const count = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
  return {
    generatedAt: now,
    hasPlaytime: allMs > 0,
    firstPlay: Number.isFinite(firstPlay) ? firstPlay : null,
    streak: st,
    milestones,
    collection: collection
      ? { instances: count(collection.instances) ?? list.length, mods: count(collection.mods), worlds: count(collection.worlds) }
      : { instances: list.length, mods: null, worlds: null },
    periods,
  };
}

module.exports = { buildRecap, publicServer, splitDays, dayKey, PERIODS, MIN_PLACE_MS };
