'use strict';
// Modo familia: reglas sin Electron ni disco (pruebas en test/logic.test.js). Reloj siempre a mano.
//   normalizeConfig(raw)            -> { limitMin, schedule: { enabled, from, to }, servers: { enabled, list } }
//   dayKey(ms) · startOfDay(ms)     -> dia local: el tope vuelve a cero a medianoche
//   advance(usage, ahora, jugando)  -> suma el tiempo jugado partiendo el tramo que cruza medianoche
//   allowedNow / windowInfo         -> horario permitido, tambien el que cruza medianoche (22:00 a 02:00)
//   remaining(usage, cfg, ahora)    -> { ms, reason } hasta tener que cerrar
//   tick(state, cfg, { now, playing }) -> avisos: warn (faltan 10 min), countdown (60 s), cancelled (se extendio), close
//   parseConnect(linea)             -> servidor al que se conecta el juego segun su registro (o null)
//   serverAllowed(list, direccion)  -> ¿esta en la lista? (*.dominio; sin puerto vale cualquier puerto)
const MIN = 60 * 1000;
const WARN_MS = 10 * MIN;
const COUNTDOWN_MS = 60 * 1000;
const SERVER_GRACE_MS = 15 * 1000;
// Un hueco mas largo entre revisiones es la PC suspendida, no tiempo jugado.
const MAX_GAP_MS = 2 * MIN;
const LIMIT_MAX_MIN = 24 * 60;
const SERVERS_MAX = 200;
const DEFAULT_SCHEDULE = { enabled: false, from: '08:00', to: '21:00' };

const pad = (n) => String(n).padStart(2, '0');
const clock = (s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  return hh > 23 || mm > 59 ? null : hh * 60 + mm;
};
const fmtClock = (mins) => `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;

// 'Play.Example.com.:25565' -> { host: 'play.example.com', port: 25565 } (o null). Se lee tambien '*.dominio'.
function parseAddress(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s || s.length > 300 || /[\s/\\@"'<>]/.test(s)) return null;
  // IPv6 entre corchetes o sin puerto
  let host = s;
  let port = null;
  const v6 = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/.exec(s);
  if (v6) {
    host = v6[1];
    port = v6[2] ? Number(v6[2]) : null;
  } else if ((s.match(/:/g) || []).length === 1) {
    const [h, p] = s.split(':');
    if (!/^\d{1,5}$/.test(p)) return null;
    host = h;
    port = Number(p);
  } else if (s.includes(':') && !/^[0-9a-f:.]+$/.test(s)) {
    return null;
  }
  host = host.replace(/\.+$/, '');
  if (!host || (port !== null && (port < 1 || port > 65535))) return null;
  return { host, port };
}

function normalizeServerList(raw) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(raw) ? raw : []) {
    const a = parseAddress(item);
    if (!a) continue;
    const text = a.port ? `${a.host}:${a.port}` : a.host;
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= SERVERS_MAX) break;
  }
  return out;
}

function normalizeConfig(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const s = r.schedule && typeof r.schedule === 'object' ? r.schedule : {};
  const v = r.servers && typeof r.servers === 'object' ? r.servers : {};
  const limit = Math.round(Number(r.limitMin));
  const from = clock(s.from);
  const to = clock(s.to);
  return {
    limitMin: Number.isFinite(limit) ? Math.min(LIMIT_MAX_MIN, Math.max(0, limit)) : 0,
    schedule: { enabled: s.enabled === true, from: from === null ? DEFAULT_SCHEDULE.from : fmtClock(from), to: to === null ? DEFAULT_SCHEDULE.to : fmtClock(to) },
    servers: { enabled: v.enabled === true, list: normalizeServerList(v.list) },
  };
}

// ---------- Dias y tiempo jugado ----------
function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function startOfDay(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

const startOfNextDay = (ms) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
};

function createUsage(saved, now) {
  const today = dayKey(now);
  const s = saved && typeof saved === 'object' ? saved : {};
  const extendUntil = Number(s.extendUntil) > now ? Number(s.extendUntil) : 0;
  return { day: today, usedMs: s.day === today ? Math.max(0, Number(s.usedMs) || 0) : 0, extendUntil, last: now };
}

// Suma lo jugado desde la ultima revision. Lo que cae despues de medianoche cuenta para el dia nuevo.
function advance(usage, now, playing) {
  const today = dayKey(now);
  let delta = playing ? now - usage.last : 0;
  if (delta < 0 || delta > MAX_GAP_MS) delta = 0; // reloj atrasado o PC suspendida
  if (usage.day !== today) {
    usage.day = today;
    usage.usedMs = Math.min(delta, now - startOfDay(now));
  } else usage.usedMs += delta;
  usage.last = now;
  return usage;
}

// ---------- Horario ----------
// { inside, msLeft (hasta que cierra), opensAt (ms de la proxima apertura) }. from === to = todo el dia.
function windowInfo(schedule, now) {
  if (!schedule?.enabled) return { inside: true, msLeft: Infinity, opensAt: null };
  const from = clock(schedule.from);
  const to = clock(schedule.to);
  if (from === null || to === null || from === to) return { inside: true, msLeft: Infinity, opensAt: null };
  const midnight = startOfDay(now);
  const d = new Date(now);
  const at = (base, mins) => {
    const b = new Date(base);
    return new Date(b.getFullYear(), b.getMonth(), b.getDate(), Math.floor(mins / 60), mins % 60).getTime();
  };
  const cur = d.getHours() * 60 + d.getMinutes();
  const crosses = to < from;
  const inside = crosses ? cur >= from || cur < to : cur >= from && cur < to;
  if (inside) {
    const closeBase = crosses && cur >= from ? startOfNextDay(now) : midnight;
    return { inside: true, msLeft: Math.max(0, at(closeBase, to) - now), opensAt: null };
  }
  const openBase = cur < from ? midnight : startOfNextDay(now);
  return { inside: false, msLeft: 0, opensAt: at(openBase, from) };
}

const allowedNow = (schedule, now) => windowInfo(schedule, now).inside;

// ---------- Cuanto falta ----------
function remaining(usage, cfg, now) {
  const limitMs = cfg.limitMin > 0 ? cfg.limitMin * MIN : Infinity;
  let byLimit = Infinity;
  if (limitMs !== Infinity) {
    byLimit = limitMs - usage.usedMs;
    // Si alcanza hasta medianoche el tope vuelve a cero antes de agotarse: no hay que avisar por algo que no va a pasar.
    const toMidnight = startOfNextDay(now) - now;
    if (byLimit > toMidnight) byLimit = toMidnight + limitMs;
  }
  const win = windowInfo(cfg.schedule, now);
  const byWindow = win.inside ? win.msLeft : 0;
  const ms = Math.min(byLimit, byWindow);
  const extra = usage.extendUntil > now ? usage.extendUntil - now : 0;
  if (extra > 0 && extra > ms) return { ms: extra, reason: 'extended' };
  return { ms: Math.max(0, ms), reason: byWindow <= byLimit ? 'schedule' : 'limit' };
}

// ¿Se puede arrancar una partida ahora? { ok, reason: 'schedule' | 'limit', opensAt }
function canLaunch(usage, cfg, now) {
  const r = remaining(usage, cfg, now);
  if (r.ms > 0) return { ok: true };
  return { ok: false, reason: r.reason, opensAt: windowInfo(cfg.schedule, now).opensAt };
}

// ---------- Avisos ----------
const createTickState = () => ({ phase: 'idle', endsAt: 0, reason: null });

// state.phase: idle -> warned (faltan 10 min) -> countdown (60 s) -> closing (se pidio cerrar, hasta que no haya juego)
function tick(state, usage, cfg, { now, playing }) {
  if (!playing) {
    const was = state.phase;
    Object.assign(state, createTickState());
    return was === 'countdown' ? [{ type: 'cancelled' }] : [];
  }
  if (state.phase === 'closing') return [];
  const r = remaining(usage, cfg, now);
  if (state.phase === 'countdown') {
    if (r.ms > 0) {
      state.phase = r.ms <= WARN_MS ? 'warned' : 'idle';
      state.endsAt = 0;
      return [{ type: 'cancelled' }];
    }
    if (now >= state.endsAt) {
      state.phase = 'closing';
      return [{ type: 'close', reason: state.reason }];
    }
    return [];
  }
  if (r.ms <= 0) {
    state.phase = 'countdown';
    state.reason = r.reason;
    state.endsAt = now + COUNTDOWN_MS;
    return [{ type: 'countdown', reason: r.reason, endsAt: state.endsAt }];
  }
  if (r.ms <= WARN_MS) {
    if (state.phase === 'warned') return [];
    state.phase = 'warned';
    return [{ type: 'warn', reason: r.reason, minutes: Math.max(1, Math.ceil(r.ms / MIN)) }];
  }
  state.phase = 'idle';
  return [];
}

// ---------- Servidores ----------
// El registro de Minecraft dice "Connecting to <host>, <puerto>" al entrar a un servidor. Una linea de chat puede decir
// lo mismo (el texto lo escribe cualquiera en el servidor): solo cuenta si es el mensaje entero, no si es [CHAT].
function parseConnect(line) {
  const text = String(line ?? '');
  if (/\[CHAT\]|\[System\]/i.test(text)) return null;
  const m = /(?:^|\]:\s)Connecting to ([^\s,]+),\s*(\d{1,5})\s*$/.exec(text);
  if (!m) return null;
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return null;
  const host = m[1].toLowerCase().replace(/\.+$/, '');
  return host ? { host, port } : null;
}

function serverAllowed(list, address) {
  const a = typeof address === 'string' ? parseAddress(address) : address;
  if (!a?.host) return false;
  const port = a.port || 25565;
  for (const item of Array.isArray(list) ? list : []) {
    const rule = parseAddress(item);
    if (!rule) continue;
    if (rule.port && rule.port !== port) continue;
    if (rule.host === a.host) return true;
    if (rule.host.startsWith('*.')) {
      const base = rule.host.slice(2);
      if (base && a.host.endsWith(`.${base}`)) return true;
    }
  }
  return false;
}

module.exports = {
  MIN,
  WARN_MS,
  COUNTDOWN_MS,
  SERVER_GRACE_MS,
  MAX_GAP_MS,
  normalizeConfig,
  normalizeServerList,
  parseAddress,
  dayKey,
  startOfDay,
  createUsage,
  advance,
  windowInfo,
  allowedNow,
  remaining,
  canLaunch,
  createTickState,
  tick,
  parseConnect,
  serverAllowed,
};
