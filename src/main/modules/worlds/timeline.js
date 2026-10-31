'use strict';
// Linea de tiempo de cada mundo.
//  - Partidas registradas: escucha la actividad del juego (game.events 'activity' y 'session') y guarda
//    cada tramo jugado en un mundo como { id, instanceId, world, start, end } en data/worlds-timeline.json.
//  - Partidas estimadas: para lo que se jugo antes de instalar el launcher (o en otro launcher) se agrupan
//    las fechas que el juego guarda en advancements/*.json (las recetas se desbloquean todo el tiempo
//    mientras se juega) y la ultima vez jugado del level.dat.
//  - Capturas y clips: se asignan a un mundo si se sacaron durante una partida registrada; si no, al
//    mundo con actividad mas cercana (hasta 20 minutos) y se marcan como "probables".
const fsp = require('fs/promises');
const path = require('path');
const { EventEmitter } = require('events');
const paths = require('../../core/paths');
const { readJson, writeJson, uid } = require('../../core/util');

const FILE = () => paths.data('worlds-timeline.json');
const MAX_SESSIONS = 20000;
const MIN_SESSION_MS = 10 * 1000;
const MAX_SESSION_MS = 3 * 86400000;
const PAD = 2 * 60 * 1000; // margen para considerar que algo paso "durante" una partida
const CLUSTER_GAP = 45 * 60 * 1000; // dos marcas a mas de 45 min son partidas distintas
const GUESS_MAX = 20 * 60 * 1000; // maxima distancia para asignar una captura por cercania
const MEDIA_PAD = 60 * 1000;

const events = new EventEmitter(); // 'changed' ({ instanceId, world, live })
const open = new Map(); // instanceId -> { world, start }
let data = null;
let chain = Promise.resolve();
let hooks = { instanceDir: (id) => paths.instance(id) };

function configure(h = {}) {
  hooks = { ...hooks, ...h };
}

function serial(fn) {
  const run = chain.then(fn);
  chain = run.catch((err) => console.error('[worlds] linea de tiempo:', err));
  return run;
}

function validRecord(r) {
  return (
    r &&
    typeof r.instanceId === 'string' &&
    r.instanceId &&
    typeof r.world === 'string' &&
    r.world &&
    Number.isFinite(r.start) &&
    Number.isFinite(r.end) &&
    r.end > r.start
  );
}

async function load() {
  if (!data) {
    const raw = await readJson(FILE(), null);
    data = { version: 1, sessions: Array.isArray(raw?.sessions) ? raw.sessions.filter(validRecord) : [] };
  }
  return data;
}

// Para pruebas: vuelve a leer el archivo
function reset() {
  data = null;
  open.clear();
}

// ---------- Registro de partidas ----------

// El mundo de un tramo sin carpeta conocida: el que tiene session.lock o level.dat modificado durante el tramo.
async function resolveWorld(instanceId, start, end) {
  const saves = path.join(hooks.instanceDir(instanceId), 'saves');
  let best = null;
  try {
    for (const name of await fsp.readdir(saves)) {
      for (const f of ['session.lock', 'level.dat']) {
        const st = await fsp.stat(path.join(saves, name, f)).catch(() => null);
        if (st && st.mtimeMs >= start - 60000 && st.mtimeMs <= end + 5 * 60000 && (!best || st.mtimeMs > best.time)) best = { name, time: st.mtimeMs };
      }
    }
  } catch {
    /* sin carpeta saves */
  }
  return best ? best.name : null;
}

function append(rec) {
  return serial(async () => {
    const d = await load();
    d.sessions.push(rec);
    if (d.sessions.length > MAX_SESSIONS) d.sessions.splice(0, d.sessions.length - MAX_SESSIONS);
    await writeJson(FILE(), d);
    return rec;
  });
}

async function closeSegment(instanceId, end) {
  const seg = open.get(instanceId);
  if (!seg) return null;
  open.delete(instanceId);
  const stop = Math.min(Math.max(seg.start, Number(end) || Date.now()), seg.start + MAX_SESSION_MS);
  if (stop - seg.start < MIN_SESSION_MS) {
    if (seg.world) events.emit('changed', { instanceId, world: seg.world, live: false });
    return null;
  }
  const world = seg.world || (await resolveWorld(instanceId, seg.start, stop).catch(() => null));
  if (!world) return null;
  const rec = await append({ id: uid(12), instanceId, world, start: seg.start, end: stop });
  events.emit('changed', { instanceId, world, live: false });
  return rec;
}

// Actividad del juego: { type: 'menu' } | { type: 'singleplayer', world } | { type: 'server', address } | null
function onActivity(instanceId, act) {
  if (!instanceId) return;
  const now = Date.now();
  const at = Number.isFinite(act?.since) ? Math.min(act.since, now) : now;
  const cur = open.get(instanceId);
  if (act?.type === 'singleplayer') {
    if (cur) {
      if (!act.world || act.world === cur.world) return; // mismo tramo
      if (!cur.world) {
        // la carpeta del mundo se conoce unos segundos despues de entrar
        cur.world = act.world;
        events.emit('changed', { instanceId, world: cur.world, live: true });
        return;
      }
      closeSegment(instanceId, at);
    }
    open.set(instanceId, { world: act.world || null, start: at });
    if (act.world) events.emit('changed', { instanceId, world: act.world, live: true });
    return;
  }
  if (cur) closeSegment(instanceId, at);
}

// Fin de la partida (game.events 'session'): cierra el tramo con la hora real de cierre.
function onSession(s) {
  if (s?.instanceId && open.has(s.instanceId)) closeSegment(s.instanceId, s.end);
}

function start(gameEvents) {
  gameEvents.on('activity', (id, act, meta) => {
    if (act?.quiet || meta?.quiet) return; // pruebas del buscador de mods culpables
    try {
      onActivity(id, act);
    } catch (err) {
      console.error('[worlds] actividad:', err);
    }
  });
  gameEvents.on('session', (s) => {
    if (s?.quiet) return;
    try {
      onSession(s);
    } catch (err) {
      console.error('[worlds] partida:', err);
    }
  });
}

// Al cerrar el launcher: guarda los tramos abiertos.
async function flush() {
  const now = Date.now();
  await Promise.all([...open.keys()].map((id) => closeSegment(id, now).catch(() => null)));
  await chain;
}

// Mundo abierto ahora en una instancia (o null)
function liveWorld(instanceId) {
  const seg = open.get(instanceId);
  return seg && seg.world ? { world: seg.world, start: seg.start } : null;
}

async function sessions({ instanceId = null, world = null } = {}) {
  await chain;
  const d = await load();
  return d.sessions.filter((s) => (!instanceId || s.instanceId === instanceId) && (!world || s.world === world));
}

// Partidas registradas de un mundo (con la que esta en curso)
async function tracked(instanceId, world) {
  const list = (await sessions({ instanceId, world })).map((s) => ({ id: s.id, start: s.start, end: s.end, tracked: true }));
  const live = liveWorld(instanceId);
  if (live && live.world === world) list.push({ id: 'live', start: live.start, end: Math.max(live.start, Date.now()), tracked: true, live: true });
  return list.sort((a, b) => a.start - b.start);
}

// Borra las partidas de un mundo (al borrarlo del todo). No se usa al mandarlo a la papelera.
function forget(instanceId, world) {
  return serial(async () => {
    const d = await load();
    const before = d.sessions.length;
    d.sessions = d.sessions.filter((s) => !(s.instanceId === instanceId && s.world === world));
    if (d.sessions.length !== before) await writeJson(FILE(), d);
  });
}

// Copia las partidas de un mundo a otro (al restaurar una copia como mundo nuevo: solo las anteriores a la copia)
function copySessions(from, to, { until = Infinity } = {}) {
  return serial(async () => {
    const d = await load();
    const add = d.sessions
      .filter((s) => s.instanceId === from.instanceId && s.world === from.world && s.end <= until)
      .map((s) => ({ ...s, id: uid(12), instanceId: to.instanceId, world: to.world }));
    if (!add.length) return 0;
    d.sessions.push(...add);
    if (d.sessions.length > MAX_SESSIONS) d.sessions.splice(0, d.sessions.length - MAX_SESSIONS);
    await writeJson(FILE(), d);
    return add.length;
  });
}

// ---------- Logica pura (se puede probar con Node) ----------

const within = (ts, s, pad) => ts >= s.start - pad && ts <= s.end + pad;

// Agrupa marcas de tiempo sueltas en partidas estimadas.
function clusters(stamps, gap = CLUSTER_GAP) {
  const out = [];
  let cur = null;
  for (const ts of [...stamps].sort((a, b) => a - b)) {
    if (cur && ts - cur.end <= gap) cur.end = ts;
    else {
      cur = { start: ts, end: ts };
      out.push(cur);
    }
  }
  return out;
}

// Partidas registradas + estimadas a partir de las marcas que no cubre ninguna registrada.
function mergeSessions(trackedList, stamps) {
  const tr = trackedList.map((s) => ({ ...s, tracked: true }));
  const free = stamps.filter((ts) => !tr.some((s) => within(ts, s, PAD)));
  const inferred = clusters(free).map((c) => ({ id: `est-${c.start}`, start: c.start, end: c.end, tracked: false, inferred: true }));
  return [...tr, ...inferred].sort((a, b) => a.start - b.start);
}

// Partida que contiene ts (preferencia: registradas) o la mas cercana hasta maxGap.
function sessionFor(list, ts, pad, maxGap) {
  let best = null;
  let bestDist = Infinity;
  for (const s of list) {
    if (within(ts, s, pad)) {
      const dist = s.tracked ? -1 : 0;
      if (dist < bestDist) {
        best = s;
        bestDist = dist;
      }
      continue;
    }
    const dist = ts < s.start ? s.start - ts : ts - s.end;
    if (dist <= maxGap && dist < bestDist) {
      best = s;
      bestDist = dist;
    }
  }
  return best;
}

const pad2 = (n) => String(n).padStart(2, '0');
function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function dayStart(ts) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * Arma la linea de tiempo agrupada por dia y por partida.
 * input: { tracked: [{ id, start, end, live? }], stamps: [ms], advancements: [{ id, at, ... }],
 *          media: [{ time, ... }], created: { at, source } | null, now }
 * -> { days: [{ key, date, ms, approx, live, sessions: [...] }], totals, created }
 */
function build({ tracked: trackedList = [], stamps = [], advancements = [], media = [], created = null, now = Date.now() } = {}) {
  const list = mergeSessions(trackedList, stamps).map((s) => ({
    id: s.id,
    start: s.start,
    end: s.live ? Math.max(s.end, now) : s.end,
    ms: Math.max(0, (s.live ? Math.max(s.end, now) : s.end) - s.start),
    tracked: Boolean(s.tracked),
    inferred: Boolean(s.inferred),
    live: Boolean(s.live),
    advancements: [],
    media: [],
  }));
  const loose = new Map(); // dia -> partida "suelta" con lo que no cae en ninguna partida
  const looseFor = (ts) => {
    const key = dayKey(ts);
    if (!loose.has(key)) loose.set(key, { id: `loose-${key}`, start: ts, end: ts, ms: 0, tracked: false, inferred: false, live: false, loose: true, advancements: [], media: [] });
    const l = loose.get(key);
    l.start = Math.min(l.start, ts);
    l.end = Math.max(l.end, ts);
    return l;
  };
  for (const a of advancements) {
    if (!a || !Number.isFinite(a.at) || !a.at) continue;
    const s = sessionFor(list, a.at, PAD, CLUSTER_GAP);
    (s || looseFor(a.at)).advancements.push(a);
  }
  for (const m of media) {
    if (!m || !Number.isFinite(m.time)) continue;
    const s = sessionFor(list, m.time, MEDIA_PAD, GUESS_MAX);
    (s || looseFor(m.time)).media.push(m);
  }
  const all = [...list, ...loose.values()];
  for (const s of all) {
    s.advancements.sort((a, b) => a.at - b.at);
    s.media.sort((a, b) => a.time - b.time);
  }
  // Partidas estimadas sin nada que mostrar y de un solo instante: se dejan (son "actividad registrada")
  const byDay = new Map();
  for (const s of all) {
    const key = dayKey(s.start);
    if (!byDay.has(key)) byDay.set(key, { key, date: dayStart(s.start), ms: 0, approx: false, live: false, sessions: [], created: null });
    const day = byDay.get(key);
    day.sessions.push(s);
    day.ms += s.ms;
    if (s.inferred && s.ms > 0) day.approx = true;
    if (s.live) day.live = true;
  }
  if (created && Number.isFinite(created.at) && created.at > 0) {
    const key = dayKey(created.at);
    if (!byDay.has(key)) byDay.set(key, { key, date: dayStart(created.at), ms: 0, approx: false, live: false, sessions: [], created: null });
    byDay.get(key).created = { at: created.at, source: created.source || 'folder' };
  }
  const days = [...byDay.values()].sort((a, b) => b.date - a.date);
  for (const d of days) d.sessions.sort((a, b) => b.start - a.start);
  const real = list;
  const totals = {
    trackedMs: real.filter((s) => s.tracked).reduce((a, s) => a + s.ms, 0),
    estimatedMs: real.filter((s) => s.inferred).reduce((a, s) => a + s.ms, 0),
    sessions: real.length,
    trackedSessions: real.filter((s) => s.tracked).length,
    days: days.filter((d) => d.sessions.length).length,
    advancements: advancements.filter((a) => a && a.at).length,
    screenshots: media.filter((m) => m.kind === 'screenshot').length,
    clips: media.filter((m) => m.kind === 'clip').length,
    first: real.length ? real[0].start : null,
    last: real.length ? Math.max(...real.map((s) => s.end)) : null,
  };
  return { days, totals, created: created && created.at ? created : null };
}

/**
 * Asigna cada captura o clip de una instancia a un mundo.
 * worlds: [{ folder, stamps: [ms] }] · trackedAll: [{ world, start, end }] · items: [{ time, ... }]
 * -> Map(item -> { world, how: 'session' | 'guess' })
 */
function attribute(worlds, trackedAll, items) {
  const out = new Map();
  for (const it of items) {
    const ts = it.time;
    if (!Number.isFinite(ts)) continue;
    const s = trackedAll.find((x) => within(ts, x, MEDIA_PAD));
    if (s) {
      out.set(it, { world: s.world, how: 'session' });
      continue;
    }
    let best = null;
    let bestDist = Infinity;
    for (const w of worlds) {
      const d = nearest(w.stamps, ts);
      if (d < bestDist) {
        bestDist = d;
        best = w.folder;
      }
    }
    if (best && bestDist <= GUESS_MAX) out.set(it, { world: best, how: 'guess' });
  }
  return out;
}

// Distancia a la marca mas cercana (busqueda binaria sobre un arreglo ordenado)
function nearest(sorted, ts) {
  if (!sorted || !sorted.length) return Infinity;
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < ts) lo = mid + 1;
    else hi = mid;
  }
  let best = Math.abs(sorted[lo] - ts);
  if (lo > 0) best = Math.min(best, Math.abs(sorted[lo - 1] - ts));
  return best;
}

// Cuando empezo el mundo: la fecha mas temprana que se conozca.
function createdOf({ birth = 0, stamps = [], trackedList = [] } = {}) {
  const cands = [];
  if (birth > 0) cands.push({ at: birth, source: 'folder' });
  if (stamps.length) cands.push({ at: stamps[0], source: 'advancement' });
  if (trackedList.length) cands.push({ at: Math.min(...trackedList.map((s) => s.start)), source: 'session' });
  if (!cands.length) return null;
  return cands.reduce((a, b) => (b.at < a.at ? b : a));
}

module.exports = {
  configure,
  start,
  flush,
  onActivity,
  onSession,
  liveWorld,
  sessions,
  tracked,
  forget,
  copySessions,
  reset,
  events,
  // logica pura
  clusters,
  mergeSessions,
  sessionFor,
  build,
  attribute,
  nearest,
  createdOf,
  dayKey,
  PAD,
  GUESS_MAX,
};
