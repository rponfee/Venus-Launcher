'use strict';
// Tiempo por mundo y por servidor. Escucha la actividad del juego (game.events 'activity' y 'session') y guarda
// cada tramo jugado como una linea JSON en data/stats-activity.json (solo se agregan lineas al final).
// Cuando el archivo crece demasiado se compacta en data/stats-activity-archive.json (totales por mundo/servidor
// y por dia) y se vacia. Cada linea lleva un numero de secuencia: si la app se cierra a mitad de la compactacion,
// las lineas ya compactadas se ignoran al leer y no se cuentan dos veces.
const fsp = require('fs/promises');
const path = require('path');
const { EventEmitter } = require('events');
const paths = require('../../core/paths');
const { readJson, writeJson } = require('../../core/util');

const ACTIVE = () => paths.data('stats-activity.json');
const ARCHIVE = () => paths.data('stats-activity-archive.json');
const ROTATE_BYTES = 768 * 1024;
const MIN_SEGMENT_MS = 5000;
const MAX_SEGMENT_MS = 3 * 86400000;

const events = new EventEmitter(); // 'segment' (tramo guardado), 'cleared'
const open = new Map(); // instanceId -> { kind: 'world'|'server', world, address, start }
let seq = null; // ultimo numero de secuencia usado
let chain = Promise.resolve();
let hooks = {
  resolveWorld: async () => null, // (instanceId, start, end) -> carpeta del mundo o null
  instanceName: async () => null, // (instanceId) -> nombre visible
};

function configure(h = {}) {
  hooks = { ...hooks, ...h };
}

function serial(fn) {
  const run = chain.then(fn);
  chain = run.catch((err) => console.error('[stats] actividad:', err));
  return run;
}

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function normAddress(a) {
  return String(a || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/:25565$/, '');
}

// Reparte un tramo entre los dias que abarca.
function splitDays(start, end, cb) {
  let t = start;
  while (t < end) {
    const d = new Date(t);
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    const stop = Math.min(next > t ? next : end, end);
    cb(dayKey(d), stop - t);
    t = stop;
  }
}

function validRecord(r) {
  return (
    r &&
    Number.isFinite(r.seq) &&
    typeof r.instanceId === 'string' &&
    r.instanceId &&
    (r.kind === 'world' || r.kind === 'server') &&
    Number.isFinite(r.start) &&
    Number.isFinite(r.end) &&
    r.end > r.start &&
    (r.kind === 'world' || (typeof r.address === 'string' && r.address))
  );
}

async function readLines() {
  let text = '';
  try {
    text = await fsp.readFile(ACTIVE(), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    try {
      const r = JSON.parse(l);
      if (validRecord(r)) out.push(r);
    } catch {
      /* linea cortada por un cierre abrupto */
    }
  }
  return out;
}

function emptyArchive() {
  return { version: 1, seq: 0, places: {} };
}

async function readArchive() {
  const a = await readJson(ARCHIVE(), null);
  return a && typeof a === 'object' && a.places && typeof a.places === 'object' ? { ...emptyArchive(), ...a } : emptyArchive();
}

const placeKey = (r) => (r.kind === 'world' ? `w|${r.instanceId}|${r.world ?? ''}` : `s|${r.address}`);

// Suma un tramo al total de su mundo o servidor.
function fold(places, r) {
  const key = placeKey(r);
  let p = places[key];
  if (!p) {
    p =
      r.kind === 'world'
        ? { kind: 'world', instanceId: r.instanceId, instanceName: null, world: r.world ?? null, ms: 0, visits: 0, first: r.start, last: r.end, days: {} }
        : { kind: 'server', address: r.address, ms: 0, visits: 0, first: r.start, last: r.end, days: {}, instances: {} };
    places[key] = p;
  }
  const ms = r.end - r.start;
  p.ms += ms;
  p.visits++;
  p.first = Math.min(p.first, r.start);
  p.last = Math.max(p.last, r.end);
  if (r.kind === 'world') {
    if (r.instanceName) p.instanceName = r.instanceName;
  } else {
    const prev = p.instances[r.instanceId] || { name: null, ms: 0, last: 0 };
    p.instances[r.instanceId] = { name: r.instanceName || prev.name, ms: prev.ms + ms, last: Math.max(prev.last, r.end) };
  }
  splitDays(r.start, r.end, (k, part) => {
    p.days[k] = (p.days[k] || 0) + part;
  });
  return p;
}

// Si un cierre abrupto dejo la ultima linea cortada, la siguiente tiene que empezar en una linea nueva.
async function endsWithNewline(file) {
  let fh = null;
  try {
    fh = await fsp.open(file, 'r');
    const { size } = await fh.stat();
    if (!size) return true;
    const buf = Buffer.alloc(1);
    await fh.read(buf, 0, 1, size - 1);
    return buf[0] === 0x0a;
  } catch {
    return true;
  } finally {
    await fh?.close().catch(() => {});
  }
}

async function ensureSeq() {
  if (seq !== null) return;
  const arch = await readArchive();
  let max = arch.seq || 0;
  for (const r of await readLines()) if (r.seq > max) max = r.seq;
  seq = max;
}

async function rotate() {
  const arch = await readArchive();
  let max = arch.seq || 0;
  for (const r of await readLines()) {
    if (r.seq <= arch.seq) continue;
    fold(arch.places, r);
    if (r.seq > max) max = r.seq;
  }
  arch.seq = max;
  arch.rotatedAt = Date.now();
  await writeJson(ARCHIVE(), arch);
  await fsp.writeFile(ACTIVE(), '', 'utf8');
}

function persistSegment(instanceId, seg, end) {
  const start = seg.start;
  if (!(end - start >= MIN_SEGMENT_MS)) return Promise.resolve(null);
  const stop = start + Math.min(end - start, MAX_SEGMENT_MS);
  return serial(async () => {
    let world = seg.world;
    if (seg.kind === 'world' && !world) world = await Promise.resolve(hooks.resolveWorld(instanceId, start, stop)).catch(() => null);
    const name = await Promise.resolve(hooks.instanceName(instanceId)).catch(() => null);
    await ensureSeq();
    const rec = { seq: seq + 1, instanceId, kind: seg.kind, start, end: stop };
    if (name) rec.instanceName = String(name).slice(0, 80);
    if (seg.kind === 'world') rec.world = world || null;
    else rec.address = seg.address;
    await fsp.mkdir(path.dirname(ACTIVE()), { recursive: true });
    const prefix = (await endsWithNewline(ACTIVE())) ? '' : '\n';
    await fsp.appendFile(ACTIVE(), `${prefix}${JSON.stringify(rec)}\n`, 'utf8');
    seq = rec.seq;
    const st = await fsp.stat(ACTIVE()).catch(() => null);
    if (st && st.size >= ROTATE_BYTES) await rotate();
    events.emit('segment', rec);
    return rec;
  });
}

// Actividad del juego: { type: 'menu' } | { type: 'singleplayer', world } | { type: 'server', address } | null
function onActivity(instanceId, act) {
  if (!instanceId) return;
  const now = Date.now();
  const at = Number.isFinite(act?.since) ? Math.min(act.since, now) : now;
  const cur = open.get(instanceId);
  if (cur && cur.kind === 'world' && act?.type === 'singleplayer') {
    if (!act.world || act.world === cur.world) return; // mismo tramo
    if (!cur.world) {
      // El mundo se identifica unos segundos despues de entrar: se completa el tramo abierto.
      cur.world = act.world;
      return;
    }
  }
  if (cur && cur.kind === 'server' && act?.type === 'server' && normAddress(act.address) === cur.address) return;
  if (cur) {
    open.delete(instanceId);
    persistSegment(instanceId, cur, at);
  }
  if (act?.type === 'singleplayer') open.set(instanceId, { kind: 'world', world: act.world || null, start: at });
  else if (act?.type === 'server' && normAddress(act.address)) open.set(instanceId, { kind: 'server', address: normAddress(act.address), start: at });
}

// Fin de la partida (game.events 'session'): cierra el tramo abierto con la hora real de cierre.
function endInstance(instanceId, end = Date.now()) {
  const cur = open.get(instanceId);
  if (!cur) return Promise.resolve(null);
  open.delete(instanceId);
  return persistSegment(instanceId, cur, Math.max(cur.start, Number(end) || Date.now()));
}

// Al cerrar el launcher: guarda los tramos abiertos.
async function flush() {
  const now = Date.now();
  for (const [id, seg] of [...open]) {
    open.delete(id);
    persistSegment(id, seg, now);
  }
  await chain;
}

function start(gameEvents) {
  gameEvents.on('activity', (id, act, meta) => {
    if (act?.quiet || meta?.quiet) return; // pruebas del buscador de mods culpables
    try {
      onActivity(id, act);
    } catch (err) {
      console.error('[stats] actividad:', err);
    }
  });
}

// Totales por mundo y servidor (archivo compactado + lineas nuevas + tramos en curso).
async function aggregate({ includeOpen = true } = {}) {
  await chain;
  const arch = await readArchive();
  const places = structuredClone(arch.places);
  for (const r of await readLines()) if (r.seq > (arch.seq || 0)) fold(places, r);
  if (includeOpen) {
    const now = Date.now();
    for (const [id, seg] of open) {
      if (now - seg.start < MIN_SEGMENT_MS) continue;
      const p = fold(places, { ...seg, instanceId: id, end: now });
      p.live = true;
      p.liveMs = (p.liveMs || 0) + (now - seg.start);
    }
  }
  return Object.values(places);
}

// Un mundo o servidor puntual: place({ kind: 'world', instanceId, world }) / place({ kind: 'server', address })
async function place(q) {
  const key = q.kind === 'world' ? `w|${q.instanceId}|${q.world ?? ''}` : `s|${normAddress(q.address)}`;
  const all = await aggregate();
  return all.find((p) => placeKey(p) === key) || null;
}

function clear() {
  open.clear();
  return serial(async () => {
    await fsp.rm(ACTIVE(), { force: true });
    await fsp.rm(ARCHIVE(), { force: true });
    seq = 0;
    events.emit('cleared');
  });
}

module.exports = { configure, start, onActivity, endInstance, flush, aggregate, place, clear, events, normAddress, _rotate: () => serial(rotate) };
