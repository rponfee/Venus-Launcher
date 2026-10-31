'use strict';
// Proyectos del modo desarrollador (data/devmode.json) y su registro de eventos (data/devmode-events.json).
// Cada proyecto guarda su configuracion (build, servidor, cliente) y el ultimo build/despliegue.
const path = require('path');
const paths = require('../../core/paths');
const { readJson, writeJson, uid } = require('../../core/util');

const FILE = () => paths.data('devmode.json');
const EVENTS_FILE = () => paths.data('devmode-events.json');
const VERSION = 1;
const MAX_EVENTS = 200;
const RELOAD_MODES = ['restart', 'reload', 'plugman'];
const SERVER_TYPES = ['paper', 'purpur', 'folia'];

const bool = (v, d) => (typeof v === 'boolean' ? v : d);
const int = (v, d, min, max) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : d;
};
const text = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');

function normalizeProject(p = {}) {
  const b = p.build || {};
  const s = p.server || {};
  const c = p.client || {};
  return {
    id: typeof p.id === 'string' && /^[\w-]{1,40}$/.test(p.id) ? p.id : uid(10),
    name: text(p.name, 60) || path.basename(String(p.dir || '')) || 'plugin',
    dir: path.resolve(String(p.dir || '.')),
    created: Number(p.created) || Date.now(),
    build: {
      tool: b.tool === 'gradle' || b.tool === 'maven' ? b.tool : null,
      task: typeof b.task === 'string' && b.task.trim() ? b.task.trim().slice(0, 120) : null,
      args: text(b.args, 300),
      skipTests: bool(b.skipTests, true),
      jdk: text(b.jdk, 500),
      auto: bool(b.auto, false),
      watchJar: bool(b.watchJar, false),
      debounceMs: int(b.debounceMs, 1500, 300, 10000),
      autoDeploy: bool(b.autoDeploy, true),
    },
    jar: { path: typeof p.jar?.path === 'string' && p.jar.path ? path.resolve(p.jar.path) : null },
    server: {
      id: typeof s.id === 'string' && /^[\w.-]{1,80}$/.test(s.id) ? s.id : null,
      reload: RELOAD_MODES.includes(s.reload) ? s.reload : 'restart',
      debug: bool(s.debug, false),
      debugPort: int(s.debugPort, 5005, 1024, 65535),
      debugAnyHost: bool(s.debugAnyHost, false),
    },
    client: {
      instanceId: typeof c.instanceId === 'string' && c.instanceId ? c.instanceId.slice(0, 120) : null,
      autoLaunch: bool(c.autoLaunch, false),
    },
    last: {
      build: p.last?.build && typeof p.last.build === 'object' ? p.last.build : null,
      deploy: p.last?.deploy && typeof p.last.deploy === 'object' ? p.last.deploy : null,
    },
    deployed: p.deployed && typeof p.deployed === 'object' ? { file: p.deployed.file || null, sha1: p.deployed.sha1 || null, at: p.deployed.at || null, name: p.deployed.name || null, version: p.deployed.version || null } : { file: null, sha1: null, at: null, name: null, version: null },
  };
}

let state = null;
let chain = Promise.resolve();

async function load() {
  if (state) return state;
  const raw = await readJson(FILE(), null);
  state = { version: VERSION, selected: null, projects: [] };
  if (raw && Array.isArray(raw.projects)) {
    const ids = new Set();
    for (const p of raw.projects) {
      if (!p || typeof p.dir !== 'string') continue;
      const n = normalizeProject(p);
      if (ids.has(n.id)) n.id = uid(10);
      ids.add(n.id);
      state.projects.push(n);
    }
    state.selected = state.projects.some((p) => p.id === raw.selected) ? raw.selected : state.projects[0]?.id || null;
  }
  return state;
}

function save() {
  const snapshot = JSON.parse(JSON.stringify(state));
  chain = chain.then(() => writeJson(FILE(), snapshot)).catch((err) => console.error('[devmode] No se pudo guardar devmode.json:', err));
  return chain;
}

async function list() {
  return (await load()).projects;
}

async function get(id) {
  return (await load()).projects.find((p) => p.id === id) || null;
}

async function add(project) {
  const s = await load();
  const p = normalizeProject(project);
  s.projects.push(p);
  s.selected = p.id;
  await save();
  return p;
}

// Aplica un parche ya validado (merge de un nivel en build/server/client/jar/last/deployed).
async function patch(id, fn) {
  const s = await load();
  const i = s.projects.findIndex((p) => p.id === id);
  if (i < 0) return null;
  const cur = s.projects[i];
  const next = typeof fn === 'function' ? fn(JSON.parse(JSON.stringify(cur))) : fn;
  s.projects[i] = normalizeProject({ ...cur, ...next, id: cur.id });
  await save();
  return s.projects[i];
}

async function remove(id) {
  const s = await load();
  s.projects = s.projects.filter((p) => p.id !== id);
  if (s.selected === id) s.selected = s.projects[0]?.id || null;
  await save();
  const ev = await loadEvents();
  if (ev[id]) {
    delete ev[id];
    scheduleEvents();
  }
}

async function select(id) {
  const s = await load();
  if (!s.projects.some((p) => p.id === id)) return s.selected;
  s.selected = id;
  await save();
  return id;
}

// ---------- Registro de eventos ----------

let events = null;
let eventsTimer = null;

async function loadEvents() {
  if (events) return events;
  const raw = await readJson(EVENTS_FILE(), {});
  events = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  for (const k of Object.keys(events)) if (!Array.isArray(events[k])) delete events[k];
  return events;
}

function scheduleEvents() {
  clearTimeout(eventsTimer);
  eventsTimer = setTimeout(() => {
    eventsTimer = null;
    writeJson(EVENTS_FILE(), events).catch((err) => console.error('[devmode] No se pudo guardar el registro:', err));
  }, 1000);
}

async function addEvent(projectId, entry) {
  const ev = await loadEvents();
  const list2 = ev[projectId] || (ev[projectId] = []);
  list2.push(entry);
  if (list2.length > MAX_EVENTS) list2.splice(0, list2.length - MAX_EVENTS);
  scheduleEvents();
  return entry;
}

async function getEvents(projectId) {
  return [...((await loadEvents())[projectId] || [])];
}

async function clearEvents(projectId) {
  const ev = await loadEvents();
  ev[projectId] = [];
  scheduleEvents();
}

async function flush() {
  if (eventsTimer) {
    clearTimeout(eventsTimer);
    eventsTimer = null;
    await writeJson(EVENTS_FILE(), events).catch(() => {});
  }
  await chain;
}

// Solo para pruebas: olvida el estado en memoria.
function reset() {
  state = null;
  events = null;
}

module.exports = { load, list, get, add, patch, remove, select, save, addEvent, getEvents, clearEvents, flush, reset, normalizeProject, RELOAD_MODES, SERVER_TYPES };
