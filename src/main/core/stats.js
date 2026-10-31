'use strict';
// Estadisticas del launcher: historial de partidas (data/stats.json), resumen rapido para Inicio,
// reporte completo para la pagina de Estadisticas e hitos con su fecha de logro.
// game.js llama a recordSession({ instanceId, name, mcVersion, loader, start, end, crashed }) al cerrar cada partida.
// No usa Electron: se puede probar con Node (paths.setRoot(carpetaTemporal)).
const fsp = require('fs/promises');
const { EventEmitter } = require('events');
const paths = require('./paths');
const { writeJson } = require('./util');

const FILE = () => paths.data('stats.json');
const MAX_SESSIONS = 10000; // las mas viejas se resumen en "archived" (los totales no se pierden)
const HOUR = 3600000;
const DAY = 86400000;
const MAX_SESSION_MS = 30 * DAY; // una sesion mas larga es un reloj roto: no se reparte por horas

const events = new EventEmitter(); // 'session' (sesion guardada), 'reset'
let cache = null;
let loadingPromise = null;
let queue = Promise.resolve();
let rev = 0; // cambia con cada modificacion (invalida el calculo memorizado)
let memo = null;
const pending = new Map(); // `${instanceId}:${start}` -> { extra, at } (codigo de salida y causa del crash)

// ---------- Fechas (hora local) ----------
const pad = (n) => String(n).padStart(2, '0');
function dayKey(ts) {
  const d = ts instanceof Date ? ts : new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function keyDate(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(y, m - 1, d);
}
function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}
function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d;
}
// Semanas de lunes a domingo
function startOfWeek(ts) {
  const d = startOfDay(ts);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

// Reparte [start, end) en tramos que no cruzan de hora (para dias, horas y dia de la semana).
function eachHourChunk(start, end, cb) {
  if (!(end > start)) return;
  if (end - start > MAX_SESSION_MS) {
    cb(new Date(start), end - start);
    return;
  }
  let t = start;
  while (t < end) {
    const d = new Date(t);
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime();
    const stop = Math.min(next > t ? next : t + HOUR, end);
    cb(d, stop - t);
    t = stop;
  }
}

// ---------- Datos ----------
function fresh() {
  return { version: 2, firstUse: Date.now(), sessions: [], archived: null, milestones: {}, milestonesSeen: [], counters: { failedLaunches: 0 } };
}

const EXTRA_FIELDS = ['code', 'killed', 'reason', 'reasonKind'];
function pickExtra(extra = {}) {
  const out = {};
  if (extra.code !== undefined && extra.code !== null && Number.isFinite(Number(extra.code))) out.code = Number(extra.code);
  if (extra.killed) out.killed = true;
  if (extra.reason) out.reason = String(extra.reason).slice(0, 300);
  if (extra.reasonKind) out.reasonKind = String(extra.reasonKind).slice(0, 40);
  return out;
}

function cleanSession(s) {
  if (!s || typeof s !== 'object') return null;
  const start = Number(s.start);
  const end = Number(s.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end < start) return null;
  const out = {
    instanceId: String(s.instanceId || ''),
    name: String(s.name || s.instanceId || ''),
    mcVersion: s.mcVersion ? String(s.mcVersion) : null,
    loader: s.loader ? String(s.loader) : 'vanilla',
    start,
    end,
    duration: end - start,
    crashed: Boolean(s.crashed),
  };
  for (const k of EXTRA_FIELDS) if (s[k] !== undefined) Object.assign(out, pickExtra({ [k]: s[k] }));
  return out;
}

function emptyArchive() {
  return {
    ms: 0,
    sessions: 0,
    crashes: 0,
    firstPlay: null,
    lastPlayed: 0,
    longest: null,
    days: {},
    daySessions: {},
    hours: new Array(24).fill(0),
    weekdayHour: Array.from({ length: 7 }, () => new Array(24).fill(0)),
    byInstance: {},
    byVersion: {},
    byLoader: {},
  };
}

// Suma una sesion a un acumulado (lo usan el archivo de sesiones viejas y el calculo del reporte).
function accumulate(acc, s) {
  acc.ms += s.duration;
  acc.sessions++;
  if (s.crashed) acc.crashes++;
  acc.firstPlay = acc.firstPlay === null ? s.start : Math.min(acc.firstPlay, s.start);
  acc.lastPlayed = Math.max(acc.lastPlayed || 0, s.end);
  if (!acc.longest || s.duration > acc.longest.ms) {
    acc.longest = { ms: s.duration, start: s.start, end: s.end, instanceId: s.instanceId, name: s.name, mcVersion: s.mcVersion };
  }
  const sk = dayKey(s.start);
  acc.daySessions[sk] = (acc.daySessions[sk] || 0) + 1;
  eachHourChunk(s.start, s.end, (d, ms) => {
    const k = dayKey(d);
    acc.days[k] = (acc.days[k] || 0) + ms;
    acc.hours[d.getHours()] += ms;
    acc.weekdayHour[d.getDay()][d.getHours()] += ms;
  });
  const inst = acc.byInstance[s.instanceId] || (acc.byInstance[s.instanceId] = { name: s.name, ms: 0, sessions: 0, crashes: 0, lastPlayed: 0 });
  inst.name = s.name || inst.name;
  inst.ms += s.duration;
  inst.sessions++;
  if (s.crashed) inst.crashes++;
  inst.lastPlayed = Math.max(inst.lastPlayed, s.end);
  for (const [map, key] of [
    [acc.byVersion, s.mcVersion || '?'],
    [acc.byLoader, s.loader || 'vanilla'],
  ]) {
    const e = map[key] || (map[key] = { ms: 0, sessions: 0, lastPlayed: 0 });
    e.ms += s.duration;
    e.sessions++;
    e.lastPlayed = Math.max(e.lastPlayed || 0, s.end);
  }
}

function migrate(raw) {
  const d = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : fresh();
  d.sessions = (Array.isArray(d.sessions) ? d.sessions : []).map(cleanSession).filter(Boolean);
  if (!Number.isFinite(d.firstUse)) d.firstUse = d.sessions.reduce((a, s) => Math.min(a, s.start), Date.now());
  if (!d.milestones || typeof d.milestones !== 'object' || Array.isArray(d.milestones)) d.milestones = {};
  if (!Array.isArray(d.milestonesSeen)) d.milestonesSeen = [];
  if (!d.counters || typeof d.counters !== 'object') d.counters = { failedLaunches: 0 };
  if (d.archived && (typeof d.archived !== 'object' || !Number.isFinite(d.archived.ms))) d.archived = null;
  if (d.archived) d.archived = { ...emptyArchive(), ...d.archived };
  d.version = 2;
  return d;
}

async function load() {
  if (cache) return cache;
  if (!loadingPromise) {
    loadingPromise = (async () => {
      let raw = null;
      try {
        raw = await fsp.readFile(FILE(), 'utf8');
      } catch {
        raw = null;
      }
      let parsed = null;
      if (raw && raw.trim()) {
        try {
          parsed = JSON.parse(raw);
        } catch {
          // Archivo danado: se guarda una copia para no perder nada y se empieza de cero.
          await fsp.rename(FILE(), `${FILE()}.corrupt-${Date.now()}`).catch(() => {});
          console.warn('[stats] stats.json estaba dañado: se guardó una copia y se empezó de cero');
        }
      }
      cache = migrate(parsed);
      loadingPromise = null;
      return cache;
    })();
  }
  return loadingPromise;
}

function enqueue(fn) {
  const run = queue.then(fn);
  queue = run.catch((err) => console.error('[stats]', err));
  return run;
}

const save = () => writeJson(FILE(), cache);

function trim(data) {
  if (data.sessions.length <= MAX_SESSIONS) return;
  data.sessions.sort((a, b) => a.start - b.start);
  const old = data.sessions.splice(0, data.sessions.length - MAX_SESSIONS);
  const arch = data.archived || emptyArchive();
  for (const s of old) accumulate(arch, s);
  data.archived = arch;
}

function takePending(instanceId, start) {
  const key = `${instanceId}:${start}`;
  const p = pending.get(key);
  pending.delete(key);
  return p ? p.extra : {};
}

// ---------- API de escritura ----------
function recordSession(s) {
  const extra = takePending(s?.instanceId, Number(s?.start));
  return enqueue(async () => {
    const data = await load();
    const rec = cleanSession({ ...s, ...extra });
    if (!rec) return;
    data.sessions.push(rec);
    trim(data);
    rev++;
    await save();
    events.emit('session', rec);
  });
}

// Datos extra de una partida (codigo de salida, causa del crash). Llega por game.events 'session',
// normalmente antes de recordSession: se guarda en espera y se une al registrar la sesion.
function annotateSession({ instanceId, start, ...extra } = {}) {
  const st = Number(start);
  if (!instanceId || !Number.isFinite(st)) return;
  const now = Date.now();
  for (const [k, v] of pending) if (now - v.at > 10 * 60000) pending.delete(k);
  const clean = pickExtra(extra);
  const existing = cache?.sessions.find((x) => x.instanceId === instanceId && x.start === st);
  if (existing) {
    Object.assign(existing, clean);
    rev++;
    enqueue(save);
    return;
  }
  pending.set(`${instanceId}:${st}`, { extra: clean, at: now });
}

function countFailedLaunch() {
  return enqueue(async () => {
    const data = await load();
    data.counters.failedLaunches = (data.counters.failedLaunches || 0) + 1;
    rev++;
    await save();
  });
}

function markMilestonesSeen(ids) {
  const list = (Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'string' && MILESTONES.some((m) => m.id === x));
  return enqueue(async () => {
    const data = await load();
    const seen = new Set(data.milestonesSeen);
    let changed = false;
    for (const id of list) {
      if (!seen.has(id)) {
        seen.add(id);
        changed = true;
      }
    }
    if (!changed) return true;
    data.milestonesSeen = [...seen];
    rev++;
    await save();
    return true;
  });
}

async function get() {
  return load();
}

function reset() {
  return enqueue(async () => {
    cache = fresh();
    pending.clear();
    rev++;
    memo = null;
    await save();
    events.emit('reset');
    return cache;
  });
}

function onReset(fn) {
  events.on('reset', fn);
  return () => events.off('reset', fn);
}

function flush() {
  return queue;
}

// ---------- Calculos ----------
function aggregate(data) {
  if (memo && memo.rev === rev && memo.data === data) return memo.acc;
  const acc = data.archived ? structuredClone(data.archived) : emptyArchive();
  for (const s of data.sessions) accumulate(acc, s);
  memo = { rev, data, acc };
  return acc;
}

function sumDays(days, from, to) {
  let total = 0;
  for (let d = new Date(from); d <= to; d = addDays(d, 1)) total += days[dayKey(d)] || 0;
  return total;
}

function streaks(days, now) {
  const keys = Object.keys(days)
    .filter((k) => days[k] > 0)
    .sort();
  let longest = { days: 0, from: null, to: null };
  let run = 0;
  let from = null;
  let prev = null;
  for (const k of keys) {
    if (prev && dayKey(addDays(keyDate(prev), 1)) === k) run++;
    else {
      run = 1;
      from = k;
    }
    if (run > longest.days) longest = { days: run, from, to: k };
    prev = k;
  }
  let cur = startOfDay(now);
  const playedToday = (days[dayKey(cur)] || 0) > 0;
  if (!playedToday) cur = addDays(cur, -1);
  let current = 0;
  let currentFrom = null;
  while ((days[dayKey(cur)] || 0) > 0) {
    current++;
    currentFrom = dayKey(cur);
    cur = addDays(cur, -1);
  }
  return { current, currentFrom, longest, playedToday };
}

function median(values) {
  if (!values.length) return 0;
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function maxEntry(obj) {
  let best = null;
  for (const [k, v] of Object.entries(obj || {})) if (v > 0 && (!best || v > best[1])) best = [k, v];
  return best;
}

// Resumen barato (lo usa Inicio): { totalMs, weekMs, todayMs, streak, sessions, lastPlayed, favoriteInstance }
async function summary(now = Date.now()) {
  const data = await load();
  const acc = aggregate(data);
  const today = startOfDay(now);
  const st = streaks(acc.days, now);
  let fav = null;
  for (const [id, v] of Object.entries(acc.byInstance)) if (!fav || v.ms > fav.ms) fav = { id, name: v.name, ms: v.ms, sessions: v.sessions };
  return {
    totalMs: acc.ms,
    weekMs: sumDays(acc.days, addDays(today, -6), today),
    todayMs: acc.days[dayKey(today)] || 0,
    monthMs: sumDays(acc.days, addDays(today, -29), today),
    streak: st.current,
    longestStreak: st.longest.days,
    playedToday: st.playedToday,
    sessions: acc.sessions,
    avgSessionMs: acc.sessions ? Math.round(acc.ms / acc.sessions) : 0,
    lastPlayed: acc.lastPlayed || null,
    firstPlay: acc.firstPlay,
    favoriteInstance: fav,
    favoriteInstanceId: fav ? fav.id : null,
  };
}

// ---------- Hitos ----------
const MILESTONES = [
  { id: 'time1', group: 'time', icon: 'clock', unit: 'hours', target: 1 },
  { id: 'time10', group: 'time', icon: 'clock', unit: 'hours', target: 10 },
  { id: 'time50', group: 'time', icon: 'clock', unit: 'hours', target: 50 },
  { id: 'time100', group: 'time', icon: 'clock', unit: 'hours', target: 100 },
  { id: 'time250', group: 'time', icon: 'clock', unit: 'hours', target: 250 },
  { id: 'time500', group: 'time', icon: 'clock', unit: 'hours', target: 500 },
  { id: 'time1000', group: 'time', icon: 'crown', unit: 'hours', target: 1000 },
  { id: 'sessions1', group: 'sessions', icon: 'play', unit: 'count', target: 1 },
  { id: 'sessions10', group: 'sessions', icon: 'gamepad', unit: 'count', target: 10 },
  { id: 'sessions50', group: 'sessions', icon: 'gamepad', unit: 'count', target: 50 },
  { id: 'sessions100', group: 'sessions', icon: 'gamepad', unit: 'count', target: 100 },
  { id: 'sessions500', group: 'sessions', icon: 'rocket', unit: 'count', target: 500 },
  { id: 'streak3', group: 'streak', icon: 'flame', unit: 'days', target: 3 },
  { id: 'streak7', group: 'streak', icon: 'flame', unit: 'days', target: 7 },
  { id: 'streak14', group: 'streak', icon: 'flame', unit: 'days', target: 14 },
  { id: 'streak30', group: 'streak', icon: 'flame', unit: 'days', target: 30 },
  { id: 'marathon3', group: 'special', icon: 'zap', unit: 'hours', target: 3 },
  { id: 'marathon6', group: 'special', icon: 'zap', unit: 'hours', target: 6 },
  { id: 'instances3', group: 'collection', icon: 'layers', unit: 'count', target: 3 },
  { id: 'instances10', group: 'collection', icon: 'layers', unit: 'count', target: 10 },
  { id: 'instances25', group: 'collection', icon: 'layers', unit: 'count', target: 25 },
  { id: 'versions5', group: 'collection', icon: 'history', unit: 'count', target: 5 },
  { id: 'loaders3', group: 'collection', icon: 'puzzle', unit: 'count', target: 3 },
  { id: 'worlds5', group: 'explore', icon: 'globe', unit: 'count', target: 5 },
  { id: 'worlds20', group: 'explore', icon: 'map', unit: 'count', target: 20 },
  { id: 'servers1', group: 'explore', icon: 'server', unit: 'count', target: 1 },
  { id: 'servers5', group: 'explore', icon: 'network', unit: 'count', target: 5 },
  { id: 'crashSurvivor', group: 'special', icon: 'shield', unit: 'bool', target: 1 },
  { id: 'nightOwl', group: 'special', icon: 'moon', unit: 'bool', target: 1 },
  { id: 'earlyBird', group: 'special', icon: 'sun', unit: 'bool', target: 1 },
  { id: 'weekend', group: 'special', icon: 'calendar', unit: 'bool', target: 1 },
  { id: 'anniversary', group: 'special', icon: 'star', unit: 'days', target: 365 },
];

// ctx: { instances: [{ id, created }], worldsFirst: [ts], serversFirst: [ts] }
function evaluateMilestones(data, acc, st, ctx = {}, now = Date.now()) {
  const sorted = data.sessions.slice().sort((a, b) => a.end - b.end);
  const arch = data.archived;
  const archMs = arch?.ms || 0;
  const archN = arch?.sessions || 0;
  const archLast = arch?.lastPlayed || null;
  const firstSession = (pred) => sorted.find(pred) || null;
  const nth = (list, n) => {
    const xs = (list || []).filter(Number.isFinite).sort((a, b) => a - b);
    return xs.length >= n ? xs[n - 1] : null;
  };
  const timeDate = (ms) => {
    if (archMs >= ms) return archLast;
    let a = archMs;
    for (const s of sorted) {
      a += s.duration;
      if (a >= ms) return s.end;
    }
    return null;
  };
  const nthSession = (n) => (archN >= n ? archLast : sorted[n - archN - 1]?.end ?? null);
  const dayKeys = Object.keys(acc.days)
    .filter((k) => acc.days[k] > 0)
    .sort();
  const streakDate = (n) => {
    let run = 0;
    let prev = null;
    for (const k of dayKeys) {
      run = prev && dayKey(addDays(keyDate(prev), 1)) === k ? run + 1 : 1;
      if (run >= n) return keyDate(k).getTime() + 12 * HOUR;
      prev = k;
    }
    return null;
  };
  const distinctDate = (field, archMap, n) => {
    const set = new Set(Object.keys(archMap || {}));
    if (set.size >= n) return archLast;
    for (const s of sorted) {
      set.add(s[field] || (field === 'loader' ? 'vanilla' : '?'));
      if (set.size >= n) return s.end;
    }
    return null;
  };
  const instances = ctx.instances || [];
  const worldsFirst = ctx.worldsFirst || [];
  const serversFirst = ctx.serversFirst || [];

  const results = [];
  const unlocks = {};
  for (const m of MILESTONES) {
    let value = 0;
    let at = null;
    switch (m.id) {
      case 'time1':
      case 'time10':
      case 'time50':
      case 'time100':
      case 'time250':
      case 'time500':
      case 'time1000':
        value = acc.ms / HOUR;
        if (value >= m.target) at = timeDate(m.target * HOUR);
        break;
      case 'sessions1':
      case 'sessions10':
      case 'sessions50':
      case 'sessions100':
      case 'sessions500':
        value = acc.sessions;
        if (value >= m.target) at = nthSession(m.target);
        break;
      case 'streak3':
      case 'streak7':
      case 'streak14':
      case 'streak30':
        value = st.longest.days;
        if (value >= m.target) at = streakDate(m.target);
        break;
      case 'marathon3':
      case 'marathon6': {
        value = (acc.longest?.ms || 0) / HOUR;
        if (value >= m.target) {
          const s = firstSession((x) => x.duration >= m.target * HOUR);
          at = s ? s.end : arch?.longest?.end || null;
        }
        break;
      }
      case 'instances3':
      case 'instances10':
      case 'instances25':
        value = instances.length;
        if (value >= m.target) at = nth(instances.map((i) => i.created || now), m.target);
        break;
      case 'versions5':
        value = Object.keys(acc.byVersion).filter((k) => k !== '?').length;
        if (value >= m.target) at = distinctDate('mcVersion', arch?.byVersion, m.target);
        break;
      case 'loaders3':
        value = Object.keys(acc.byLoader).length;
        if (value >= m.target) at = distinctDate('loader', arch?.byLoader, m.target);
        break;
      case 'worlds5':
      case 'worlds20':
        value = worldsFirst.length;
        if (value >= m.target) at = nth(worldsFirst, m.target);
        break;
      case 'servers1':
      case 'servers5':
        value = serversFirst.length;
        if (value >= m.target) at = nth(serversFirst, m.target);
        break;
      case 'crashSurvivor': {
        const crash = firstSession((x) => x.crashed);
        const after = crash ? sorted.find((x) => x.start >= crash.end) : null;
        if (after) {
          value = 1;
          at = after.start;
        } else if ((arch?.crashes || 0) > 0 && acc.sessions > arch.crashes) {
          value = 1;
          at = archLast;
        }
        break;
      }
      case 'nightOwl': {
        for (const s of data.sessions.slice().sort((a, b) => a.start - b.start)) {
          eachHourChunk(s.start, s.end, (d) => {
            if (!at && d.getHours() >= 2 && d.getHours() < 5) at = d.getTime();
          });
          if (at) break;
        }
        value = at ? 1 : 0;
        break;
      }
      case 'earlyBird': {
        const s = data.sessions
          .slice()
          .sort((a, b) => a.start - b.start)
          .find((x) => {
            const h = new Date(x.start).getHours();
            return h >= 5 && h < 8;
          });
        if (s) {
          value = 1;
          at = s.start;
        }
        break;
      }
      case 'weekend': {
        for (const k of dayKeys) {
          const d = keyDate(k);
          if (d.getDay() === 6 && (acc.days[dayKey(addDays(d, 1))] || 0) > 0) {
            value = 1;
            at = addDays(d, 1).getTime() + 12 * HOUR;
            break;
          }
        }
        break;
      }
      case 'anniversary': {
        const first = acc.firstPlay;
        if (first) {
          value = Math.max(0, Math.floor(((acc.lastPlayed || first) - first) / DAY));
          const s = sorted.find((x) => x.start >= first + 365 * DAY);
          if (s) at = s.start;
          else if (value >= 365) at = acc.lastPlayed;
        }
        break;
      }
      default:
        break;
    }
    const stored = data.milestones[m.id];
    let achievedAt = Number.isFinite(stored) ? stored : null;
    if (!achievedAt && value >= m.target) {
      achievedAt = Number.isFinite(at) ? at : now;
      unlocks[m.id] = achievedAt;
    }
    results.push({
      id: m.id,
      group: m.group,
      icon: m.icon,
      unit: m.unit,
      target: m.target,
      value: Math.round(value * 100) / 100,
      progress: Math.max(0, Math.min(1, m.target ? value / m.target : 0)),
      achievedAt,
      isNew: Boolean(achievedAt) && !data.milestonesSeen.includes(m.id),
    });
  }
  return { results, unlocks };
}

// Reporte completo para la pagina. ctx agrega datos de otros lugares (instancias, mundos y servidores).
async function report(ctx = {}, now = Date.now()) {
  const data = await load();
  const acc = aggregate(data);
  const today = startOfDay(now);
  const st = streaks(acc.days, now);

  // Ultimas 26 semanas (lunes a domingo)
  const weeks = [];
  const thisWeek = startOfWeek(now);
  for (let i = 25; i >= 0; i--) {
    const ws = addDays(thisWeek, -7 * i);
    let ms = 0;
    for (let j = 0; j < 7; j++) ms += acc.days[dayKey(addDays(ws, j))] || 0;
    weeks.push({ start: ws.getTime(), key: dayKey(ws), ms, sessions: 0 });
  }
  const weekIdx = new Map(weeks.map((w, i) => [w.key, i]));
  for (const s of data.sessions) {
    const i = weekIdx.get(dayKey(startOfWeek(s.start)));
    if (i !== undefined) weeks[i].sessions++;
  }

  // Ultimos 12 meses
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    months.push({ key: `${d.getFullYear()}-${pad(d.getMonth() + 1)}`, ms: 0, days: 0, sessions: 0 });
  }
  const monthIdx = new Map(months.map((m, i) => [m.key, i]));
  for (const [k, ms] of Object.entries(acc.days)) {
    const i = monthIdx.get(k.slice(0, 7));
    if (i !== undefined && ms > 0) {
      months[i].ms += ms;
      months[i].days++;
    }
  }
  for (const [k, n] of Object.entries(acc.daySessions)) {
    const i = monthIdx.get(k.slice(0, 7));
    if (i !== undefined) months[i].sessions += n;
  }

  // Mejor semana de todo el historial
  const weekTotals = new Map();
  for (const [k, ms] of Object.entries(acc.days)) {
    const wk = dayKey(startOfWeek(keyDate(k)));
    weekTotals.set(wk, (weekTotals.get(wk) || 0) + ms);
  }
  let bestWeek = null;
  for (const [k, ms] of weekTotals) if (ms > 0 && (!bestWeek || ms > bestWeek.ms)) bestWeek = { start: k, ms };

  const bestDay = maxEntry(acc.days);
  const busiestDay = maxEntry(acc.daySessions);
  const daysPlayed = Object.values(acc.days).filter((v) => v > 0).length;
  const list = (obj) =>
    Object.entries(obj)
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => b.ms - a.ms);

  const crashes = data.sessions
    .filter((s) => s.crashed)
    .sort((a, b) => b.start - a.start)
    .slice(0, 100)
    .map((s) => ({
      start: s.start,
      end: s.end,
      duration: s.duration,
      instanceId: s.instanceId,
      name: s.name,
      mcVersion: s.mcVersion,
      loader: s.loader,
      code: s.code ?? null,
      reason: s.reason || null,
      reasonKind: s.reasonKind || null,
    }));

  const { results: milestones, unlocks } = evaluateMilestones(data, acc, st, ctx, now);
  if (Object.keys(unlocks).length) {
    enqueue(async () => {
      const d = await load();
      for (const [id, at] of Object.entries(unlocks)) if (!Number.isFinite(d.milestones[id])) d.milestones[id] = at;
      rev++;
      await save();
    });
  }

  return {
    generatedAt: now,
    firstUse: data.firstUse,
    firstPlay: acc.firstPlay,
    lastPlayed: acc.lastPlayed || null,
    totals: {
      ms: acc.ms,
      sessions: acc.sessions,
      launches: acc.sessions,
      failedLaunches: data.counters.failedLaunches || 0,
      crashes: acc.crashes,
      crashRate: acc.sessions ? acc.crashes / acc.sessions : 0,
      avgMs: acc.sessions ? acc.ms / acc.sessions : 0,
      medianMs: median(data.sessions.map((s) => s.duration)),
      todayMs: acc.days[dayKey(today)] || 0,
      weekMs: sumDays(acc.days, addDays(today, -6), today),
      monthMs: sumDays(acc.days, addDays(today, -29), today),
      yearMs: sumDays(acc.days, addDays(today, -364), today),
      daysPlayed,
      instancesPlayed: Object.keys(acc.byInstance).length,
      versionsPlayed: Object.keys(acc.byVersion).filter((k) => k !== '?').length,
      loadersPlayed: Object.keys(acc.byLoader).length,
    },
    streak: { current: st.current, currentFrom: st.currentFrom, playedToday: st.playedToday, longest: st.longest },
    records: {
      longestSession: acc.longest,
      bestDay: bestDay ? { day: bestDay[0], ms: bestDay[1] } : null,
      bestWeek,
      busiestDay: busiestDay ? { day: busiestDay[0], count: busiestDay[1] } : null,
    },
    days: acc.days,
    daySessions: acc.daySessions,
    hours: acc.hours,
    weekdayHour: acc.weekdayHour,
    weeks,
    months,
    byInstance: list(acc.byInstance),
    byVersion: list(acc.byVersion),
    byLoader: list(acc.byLoader),
    crashes,
    milestones,
    newlyUnlocked: Object.keys(unlocks),
  };
}

module.exports = {
  recordSession,
  annotateSession,
  countFailedLaunch,
  markMilestonesSeen,
  get,
  reset,
  onReset,
  flush,
  summary,
  report,
  events,
  MILESTONES,
  // utilidades de fechas compartidas con el modulo statsplus
  dayKey,
  eachHourChunk,
};
