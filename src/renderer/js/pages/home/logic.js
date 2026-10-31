// Logica pura del Inicio (sin DOM ni Electron): resumen de partidas, ultimos 7 dias, ping y MOTD
// de servidores, amigos/presencia y validacion de URLs. Se puede probar con Node directamente.

// ---------- Utilidades ----------

export const isMissingHandler = (err) => /No handler registered/i.test(String(err?.message || err || ''));

export const str = (v, max = 60) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

// Solo se muestran imagenes file:, https: o data:image (una ruta absoluta se convierte a file:)
export function imgUrl(u) {
  if (typeof u !== 'string' || !u.trim()) return null;
  const s = u.trim();
  const enc = (p) => encodeURI(p).replace(/[?#]/g, encodeURIComponent);
  if (/^[a-zA-Z]:[\\/]/.test(s)) return `file:///${enc(s.replace(/\\/g, '/'))}`;
  if (s.startsWith('/') && !s.startsWith('//')) return `file://${enc(s)}`;
  if (/^(?:file|https):\/\//i.test(s)) return s;
  if (/^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(s)) return s.replace(/\s+/g, '');
  return null;
}

// "host", "host:puerto" o "[ipv6]:puerto" -> { host, port }
export function splitAddress(address) {
  const a = String(address || '').trim();
  const v6 = a.match(/^\[([^\]]+)\](?::(\d{1,5}))?$/);
  if (v6) return { host: v6[1], port: Number(v6[2]) || 25565 };
  const m = a.match(/^([^:\s]+)(?::(\d{1,5}))?$/);
  return m ? { host: m[1], port: Number(m[2]) || 25565 } : { host: a, port: 25565 };
}

export const pingKey = (address) => String(address || '').trim().toLowerCase();

export const latencyClass = (ms) => (ms < 80 ? 'good' : ms < 160 ? 'warn' : 'bad');

// ---------- Partidas ----------

export const durOf = (s) => Math.max(0, Number(s?.duration ?? (Number(s?.end) || 0) - (Number(s?.start) || 0)) || 0);

export function dayStart(ts, offsetDays = 0) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  if (offsetDays) d.setDate(d.getDate() + offsetDays);
  return d.getTime();
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

// Resumen calculado con las sesiones crudas (respaldo si stats:summary no existe)
export function summarize(sessions, now = Date.now()) {
  const today = dayStart(now);
  const weekStart = dayStart(today, -6);
  let totalMs = 0;
  let weekMs = 0;
  let todayMs = 0;
  let lastPlayed = 0;
  const days = new Set();
  const perInstance = new Map();
  for (const s of Array.isArray(sessions) ? sessions : []) {
    const start = Number(s?.start) || 0;
    if (!start) continue;
    const dur = durOf(s);
    totalMs += dur;
    if (start >= weekStart) weekMs += dur;
    if (start >= today) todayMs += dur;
    lastPlayed = Math.max(lastPlayed, Number(s.end) || start);
    days.add(dayKey(start));
    if (s.instanceId) {
      const cur = perInstance.get(s.instanceId) || { id: s.instanceId, name: s.name || null, ms: 0 };
      cur.ms += dur;
      if (s.name) cur.name = s.name;
      perInstance.set(s.instanceId, cur);
    }
  }
  // La racha sigue viva si jugaste ayer aunque hoy todavia no
  const playedToday = days.has(dayKey(today));
  const cursor = new Date(today);
  if (!playedToday) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (days.has(dayKey(cursor.getTime()))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  const favoriteInstance = [...perInstance.values()].sort((a, b) => b.ms - a.ms)[0] || null;
  return { totalMs, weekMs, todayMs, streak, playedToday, sessions: Array.isArray(sessions) ? sessions.length : 0, lastPlayed, favoriteInstance };
}

// Tiempo jugado en cada uno de los ultimos 7 dias (hoy al final), por dia de inicio de la partida
export function lastSevenDays(sessions, now = Date.now()) {
  const today = dayStart(now);
  const days = [];
  for (let i = 6; i >= 0; i--) days.push({ start: dayStart(today, -i), ms: 0 });
  const end = dayStart(today, 1);
  for (const s of Array.isArray(sessions) ? sessions : []) {
    const start = Number(s?.start) || 0;
    if (start < days[0].start || start >= end) continue;
    for (let i = days.length - 1; i >= 0; i--) {
      if (start >= days[i].start) {
        days[i].ms += durOf(s);
        break;
      }
    }
  }
  return days;
}

// ---------- Servidores ----------

export function normalizePing(d) {
  if (!d || typeof d !== 'object') return { online: false, latency: null, playersOnline: null, playersMax: null, sample: [], version: null, mcVersion: null, motd: null, favicon: null };
  const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Math.max(0, Math.round(Number(v))));
  const players = d.players && typeof d.players === 'object' ? d.players : {};
  const sample = Array.isArray(players.sample)
    ? players.sample.map((p) => String((typeof p === 'string' ? p : p?.name) || '')).filter((n) => /^[A-Za-z0-9_]{3,16}$/.test(n))
    : [];
  const rawVersion = typeof d.version === 'string' ? d.version : typeof d.version?.name === 'string' ? d.version.name : '';
  return {
    online: d.online !== false,
    latency: num(d.latency ?? d.ping),
    playersOnline: num(players.online),
    playersMax: num(players.max),
    sample: [...new Set(sample)],
    version: rawVersion.replace(/§./g, '').trim().slice(0, 80) || null,
    mcVersion: str(d.mcVersion, 30),
    motd: d.motd ?? d.description ?? null,
    favicon: imgUrl(d.favicon),
  };
}

// MOTD con colores de Minecraft: codigos §, §x hexadecimales (formato BungeeCord) o componentes JSON
export const MC_COLORS = {
  0: '#4d4d4d', // negro y azul oscuro aclarados para que se lean sobre el fondo oscuro
  1: '#3d3dd6',
  2: '#00aa00',
  3: '#00aaaa',
  4: '#d03030',
  5: '#aa00aa',
  6: '#ffaa00',
  7: '#aaaaaa',
  8: '#6e6e6e',
  9: '#5555ff',
  a: '#55ff55',
  b: '#55ffff',
  c: '#ff5555',
  d: '#ff55ff',
  e: '#ffff55',
  f: '#ffffff',
};
const MC_NAMED = { black: '0', dark_blue: '1', dark_green: '2', dark_aqua: '3', dark_red: '4', dark_purple: '5', gold: '6', gray: '7', dark_gray: '8', blue: '9', green: 'a', aqua: 'b', red: 'c', light_purple: 'd', yellow: 'e', white: 'f' };
const MOTD_TOKEN = /§x§([0-9a-f])§([0-9a-f])§([0-9a-f])§([0-9a-f])§([0-9a-f])§([0-9a-f])|§([0-9a-fk-or])/gi;

function legacySegments(text, base, out) {
  let st = { ...base };
  let last = 0;
  for (const m of text.matchAll(MOTD_TOKEN)) {
    if (m.index > last) out.push({ ...st, text: text.slice(last, m.index) });
    last = m.index + m[0].length;
    if (m[7] === undefined) {
      st = { color: `#${m.slice(1, 7).join('')}`.toLowerCase() };
      continue;
    }
    const c = m[7].toLowerCase();
    if (MC_COLORS[c]) st = { color: MC_COLORS[c] }; // un color reinicia el formato, como en el juego
    else if (c === 'r') st = { ...base };
    else if (c === 'l') st.bold = true;
    else if (c === 'o') st.italic = true;
    else if (c === 'n') st.underline = true;
    else if (c === 'm') st.strike = true;
    // §k (texto ofuscado) se muestra normal
  }
  if (last < text.length) out.push({ ...st, text: text.slice(last) });
}

// -> [{ text, color?, bold?, italic?, underline?, strike? }]
export function motdSegments(motd) {
  const out = [];
  const walk = (node, style, depth) => {
    if (node === null || node === undefined || depth > 20) return;
    if (typeof node === 'string' || typeof node === 'number') {
      legacySegments(String(node), style, out);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((n) => walk(n, style, depth + 1));
      return;
    }
    if (typeof node !== 'object') return;
    const st = { ...style };
    if (typeof node.color === 'string') st.color = MC_COLORS[MC_NAMED[node.color]] || (/^#[0-9a-f]{6}$/i.test(node.color) ? node.color.toLowerCase() : st.color);
    if (typeof node.bold === 'boolean') st.bold = node.bold;
    if (typeof node.italic === 'boolean') st.italic = node.italic;
    if (typeof node.underlined === 'boolean') st.underline = node.underlined;
    if (typeof node.strikethrough === 'boolean') st.strike = node.strikethrough;
    if (typeof node.text === 'string' || typeof node.text === 'number') walk(String(node.text), st, depth + 1);
    if (Array.isArray(node.extra)) node.extra.forEach((n) => walk(n, st, depth + 1));
  };
  walk(motd, {}, 0);
  return out.filter((s) => s.text);
}

export const motdPlain = (motd) =>
  motdSegments(motd)
    .map((s) => s.text)
    .join('')
    .replace(/[ \t]+/g, ' ')
    .trim();

// ---------- Amigos ----------

// Entrada de social.friends: { id, name, profile, presence, activity, lastSeen, statusText }.
// presenceOf(id) (si existe) devuelve { presence, activity, lastSeen, statusText } y es la fuente mas fresca.
export function normalizeFriend(f, presenceOf) {
  if (!f || typeof f !== 'object') return null;
  const prof = [f.profile, f.friend, f.user].find((x) => x && typeof x === 'object') || f;
  const id = f.userId || f.user_id || (prof !== f ? prof.id : null) || f.friendId || f.friend_id || f.id || f.code;
  if (!id) return null;
  const name = (str(f.name, 32) || str(prof.display_name, 32) || str(prof.displayName, 32) || str(prof.username, 32) || str(prof.mc_name, 32) || String(id)).slice(0, 32);
  let pres = null;
  try {
    pres = typeof presenceOf === 'function' ? presenceOf(id) : null;
  } catch {
    pres = null;
  }
  const p = pres && typeof pres === 'object' ? pres : f;
  let status = ([p.presence, f.presence, p.state].find((v) => typeof v === 'string' && v) || '').toLowerCase();
  if (status === 'idle') status = 'away';
  if (status === 'dnd') status = 'busy';
  if (status === 'playing' || status === 'ingame') status = 'online';
  const online = p.online === true || ['online', 'away', 'busy'].includes(status);
  if (!online) status = 'offline';
  else if (!['online', 'away', 'busy'].includes(status)) status = 'online';
  const raw = p.activity || f.activity || null;
  const activity =
    raw && typeof raw === 'object'
      ? {
          type: str(raw.type, 20) || (str(raw.address) ? 'server' : raw.world ? 'singleplayer' : 'menu'),
          address: str(raw.address, 80),
          instance: str(raw.instanceName) || str(raw.instance),
          version: str(raw.mcVersion, 24) || str(raw.version, 24),
        }
      : null;
  const seen = p.lastSeen ?? f.lastSeen ?? prof.last_seen ?? null;
  const lastSeen = seen ? new Date(seen).getTime() || null : null;
  return {
    id: String(id),
    name,
    avatar: str(prof.mc_uuid, 40) || str(prof.mc_name, 16) || str(prof.username, 32) || name,
    online,
    status,
    activity: online ? activity : null,
    statusText: online ? str(p.statusText ?? f.statusText ?? prof.status_text, 80) : null,
    lastSeen,
  };
}

// Primero los que estan en un servidor, despues los que juegan, los conectados y al final los desconectados
export function sortFriends(list) {
  const rank = (f) => (f.online ? (f.activity?.type === 'server' ? 0 : f.activity ? 1 : 2) : 3);
  return [...list].sort((a, b) => rank(a) - rank(b) || (b.lastSeen || 0) - (a.lastSeen || 0) || a.name.localeCompare(b.name));
}

// ---------- Novedades ----------

const NEWS_BASE = 'https://launchercontent.mojang.com';

export function newsImageUrl(e) {
  const u = e?.image?.url;
  return typeof u === 'string' && /^\/[\w\-./%]+$/.test(u) && !u.includes('..') ? `${NEWS_BASE}${u}` : null;
}

export function sortNews(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((e) => e && typeof e.title === 'string' && typeof e.contentPath === 'string')
    .sort((a, b) => (new Date(b.date).getTime() || 0) - (new Date(a.date).getTime() || 0));
}

// Modo de juego de level.dat (numero o texto) -> clave de traduccion
const MODES = ['survival', 'creative', 'adventure', 'spectator'];
export function gameModeKey(mode, hardcore) {
  if (hardcore || mode === 'hardcore') return 'hardcore';
  const key = typeof mode === 'number' || /^\d$/.test(String(mode ?? '')) ? MODES[Number(mode)] : String(mode || '').toLowerCase();
  return MODES.includes(key) ? key : null;
}
