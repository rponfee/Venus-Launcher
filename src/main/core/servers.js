'use strict';
// Servidores locales: instalacion (Vanilla, Paper, Purpur, Folia, Spigot, Fabric, Quilt, Forge, NeoForge,
// Mohist, Youer, Velocity y Waterfall), consola en vivo, comandos, server.properties, jugadores conectados
// y plugins/mods de Modrinth. Las funciones avanzadas (gamerules, mundo, copias, automatizacion,
// servidor espejo) viven en src/main/modules/serverx.
const os = require('os');
const net = require('net');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const paths = require('./paths');
const http = require('./http');
const minecraft = require('./minecraft');
const java = require('./java');
const modrinth = require('./modrinth');
const props = require('./server-properties');
const { t } = require('./i18n');
const { readJson, writeJson, exists, uid, hashFile, offlineUUID, dashUUID } = require('./util');

const META = 'venus-server.json';
const events = new EventEmitter();
events.setMaxListeners(50);
const running = new Map(); // id -> { child, state, players: Map(nombre -> { uuid, ip, since }), startedAt, stopRequested, killTimer, type }
const consoles = new Map(); // id -> lineas de la ultima sesion o instalacion (sobreviven al apagado)
const busy = new Set(); // ids instalando o arrancando
let trashFn = null;

function setTrash(fn) {
  trashFn = fn;
}

const dir = (id) => paths.server(id);

// ---------- Tipos de servidor ----------
// kind: vanilla | plugins | mods | hybrid | proxy. folder: carpeta de complementos.
// modrinth: loaders de Modrinth para plugins / mods.
const TYPES = {
  vanilla: { name: 'Vanilla', kind: 'vanilla', color: '#5fae4d', letter: 'V', snapshots: true, source: 'Mojang', site: 'https://www.minecraft.net/download/server' },
  paper: { name: 'Paper', kind: 'plugins', color: '#e8e2da', letter: 'P', source: 'PaperMC', site: 'https://papermc.io/software/paper', modrinth: { plugin: ['paper', 'spigot', 'bukkit'] }, snapshots: true },
  purpur: { name: 'Purpur', kind: 'plugins', color: '#c77dff', letter: 'P', source: 'PurpurMC', site: 'https://purpurmc.org', modrinth: { plugin: ['purpur', 'paper', 'spigot', 'bukkit'] } },
  folia: { name: 'Folia', kind: 'plugins', color: '#4cbf7a', letter: 'F', source: 'PaperMC', site: 'https://papermc.io/software/folia', modrinth: { plugin: ['folia'] }, experimental: true },
  spigot: { name: 'Spigot', kind: 'plugins', color: '#f0932b', letter: 'S', source: 'SpigotMC (BuildTools)', site: 'https://www.spigotmc.org/wiki/buildtools/', modrinth: { plugin: ['spigot', 'bukkit'] }, slow: true, snapshots: true },
  fabric: { name: 'Fabric', kind: 'mods', color: '#dbb98d', letter: 'F', source: 'FabricMC', site: 'https://fabricmc.net', modrinth: { mod: ['fabric'] }, loaderVersions: true, snapshots: true },
  quilt: { name: 'Quilt', kind: 'mods', color: '#b884f0', letter: 'Q', source: 'QuiltMC', site: 'https://quiltmc.org', modrinth: { mod: ['quilt', 'fabric'] }, loaderVersions: true, snapshots: true },
  forge: { name: 'Forge', kind: 'mods', color: '#6f8cff', letter: 'F', source: 'MinecraftForge', site: 'https://files.minecraftforge.net', modrinth: { mod: ['forge'] }, loaderVersions: true },
  neoforge: { name: 'NeoForge', kind: 'mods', color: '#ff8a3d', letter: 'N', source: 'NeoForged', site: 'https://neoforged.net', modrinth: { mod: ['neoforge'] }, loaderVersions: true },
  mohist: { name: 'Mohist', kind: 'hybrid', color: '#4f9cf0', letter: 'M', source: 'MohistMC', site: 'https://mohistmc.com', modrinth: { mod: ['forge'], plugin: ['spigot', 'bukkit', 'paper'] }, experimental: true },
  youer: { name: 'Youer', kind: 'hybrid', color: '#36c2b4', letter: 'Y', source: 'MohistMC', site: 'https://mohistmc.com', modrinth: { mod: ['neoforge'], plugin: ['spigot', 'bukkit', 'paper'] }, experimental: true },
  velocity: { name: 'Velocity', kind: 'proxy', color: '#1fa8e0', letter: 'V', source: 'PaperMC', site: 'https://papermc.io/software/velocity', modrinth: { plugin: ['velocity'] }, snapshots: true, defaultPort: 25577 },
  waterfall: { name: 'Waterfall', kind: 'proxy', color: '#5b8def', letter: 'W', source: 'PaperMC', site: 'https://papermc.io/software/waterfall', modrinth: { plugin: ['waterfall', 'bungeecord'] }, deprecated: true, defaultPort: 25577 },
};
const FILL_PROJECTS = new Set(['paper', 'folia', 'velocity', 'waterfall']);
const MOHIST_PROJECTS = new Set(['mohist', 'youer']);

function typeInfo(type) {
  const m = TYPES[type];
  if (!m) return null;
  return {
    id: type,
    ...m,
    plugins: m.kind === 'plugins' || m.kind === 'hybrid' || m.kind === 'proxy',
    mods: m.kind === 'mods' || m.kind === 'hybrid',
    proxy: m.kind === 'proxy',
    eula: m.kind !== 'proxy',
    folder: m.kind === 'mods' ? 'mods' : m.kind === 'vanilla' ? null : 'plugins',
    folders: m.kind === 'hybrid' ? ['mods', 'plugins'] : m.kind === 'mods' ? ['mods'] : m.kind === 'vanilla' ? [] : ['plugins'],
    snapshots: Boolean(m.snapshots),
    loaderVersions: Boolean(m.loaderVersions),
    experimental: Boolean(m.experimental),
    deprecated: Boolean(m.deprecated),
    slow: Boolean(m.slow),
    description: t(`servers.typeDesc_${type}`),
  };
}

function types() {
  return Object.keys(TYPES).map(typeInfo);
}

const isProxy = (s) => TYPES[s?.type]?.kind === 'proxy';

// ---------- Metadatos ----------

const locks = new Map();
function withLock(id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(
    id,
    next.catch(() => {}).finally(() => {
      if (locks.get(id) === next) locks.delete(id);
    }),
  );
  return next;
}

async function list() {
  let entries = [];
  try {
    entries = await fsp.readdir(paths.servers(), { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const meta = await readJson(path.join(dir(e.name), META), null);
    if (meta && meta.type) out.push(withRuntime({ ...meta, id: e.name, dir: dir(e.name) }));
  }
  return out.sort((a, b) => (b.created || 0) - (a.created || 0));
}

function withRuntime(s) {
  const r = running.get(s.id);
  const info = r ? [...r.players.entries()].map(([name, p]) => ({ name, uuid: p.uuid || null, ip: p.ip || null, since: p.since })) : [];
  return {
    ...s,
    state: r ? r.state : 'offline',
    players: info.map((p) => p.name),
    playerInfo: info,
    startedAt: r?.startedAt || null,
    pid: r?.child?.pid || null,
    busy: busy.has(s.id),
  };
}

async function get(id) {
  if (typeof id !== 'string' || !/^[\w.-]+$/.test(id) || /^\.+$/.test(id)) throw new Error(t('servers.errNotFound'));
  const meta = await readJson(path.join(dir(id), META), null);
  if (!meta) throw new Error(t('servers.errNotFound'));
  return withRuntime({ ...meta, id, dir: dir(id) });
}

async function save(s) {
  const { dir: _d, state: _s, players: _p, playerInfo: _pi, startedAt: _a, pid: _pid, busy: _b, ...data } = s;
  await writeJson(path.join(dir(s.id), META), data);
}

// Parche interno sin restricciones (lo usan la instalacion y los modulos del servidor).
function patchMeta(id, patch) {
  return withLock(id, async () => {
    const cur = await get(id);
    const next = typeof patch === 'function' ? await patch(cur) : { ...cur, ...patch };
    await save({ ...next, id });
    return get(id);
  });
}

function clampMemory(mem, cur = {}) {
  const max = Math.round(Math.min(65536, Math.max(512, Number(mem?.max ?? cur.max ?? 2048))));
  const min = Math.round(Math.min(max, Math.max(256, Number(mem?.min ?? cur.min ?? Math.min(1024, max)))));
  return { min, max };
}

function mergeDeep(base, patch) {
  const out = { ...(base || {}) };
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k]) ? mergeDeep(out[k], v) : v;
  }
  return out;
}

// Cambios que puede pedir la interfaz (servers:update). Valida cada campo.
async function update(id, patch = {}) {
  const cur = await get(id);
  const next = {};
  if (patch.name !== undefined) {
    const name = String(patch.name).replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!name) throw new Error(t('servers.errName'));
    next.name = name;
  }
  if (patch.memory) next.memory = clampMemory(patch.memory, cur.memory);
  if (patch.flags !== undefined) next.flags = patch.flags === 'none' ? 'none' : 'aikar';
  if (patch.java) {
    const j = mergeDeep(cur.java, patch.java);
    next.java = { path: String(j.path || '').slice(0, 500), args: String(j.args || '').slice(0, 2000) };
  }
  if (patch.automation) next.automation = mergeDeep(cur.automation, patch.automation);
  if (patch.proxy) next.proxy = mergeDeep(cur.proxy, patch.proxy);
  if (patch.notes !== undefined) next.notes = String(patch.notes).slice(0, 2000);
  if (patch.loaderVersion !== undefined && patch.loaderVersion !== cur.loaderVersion) {
    next.loaderVersion = String(patch.loaderVersion || 'latest');
    next.installed = false;
  }
  let port = null;
  if (patch.port !== undefined && Number(patch.port) !== cur.port) {
    port = Number(patch.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(t('servers.errPort'));
    next.port = port;
  }
  const out = await patchMeta(id, next);
  if (port && !isProxy(cur)) await writePropertiesRaw(id, { 'server-port': String(port) });
  return out;
}

// ---------- server.properties ----------

const propsFile = (id) => {
  if (typeof id !== 'string' || !/^[\w.-]+$/.test(id) || /^\.+$/.test(id)) throw new Error(t('servers.errNotFound'));
  return path.join(dir(id), 'server.properties');
};

async function readProperties(id) {
  const text = await fsp.readFile(propsFile(id), 'utf8').catch(() => '');
  return props.parse(text);
}

async function writePropertiesRaw(id, patch) {
  const file = propsFile(id);
  const text = await fsp.readFile(file, 'utf8').catch(() => '');
  const next = props.applyPatch(text, patch);
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, next, 'utf8');
  await fsp.rename(tmp, file);
  return props.parse(next);
}

// patch: { clave: valor | null (borra) }. Valida tipos y rangos segun el esquema.
async function writeProperties(id, patch = {}) {
  const clean = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (!props.isValidKey(k)) throw new Error(t('servers.errPropKey', { key: k }));
    try {
      clean[k] = props.normalizeValue(k, v);
    } catch (err) {
      if (err.code === 'range') throw new Error(t('servers.errPropRange', { key: k, min: err.min, max: err.max }));
      if (err.code === 'int') throw new Error(t('servers.errPropInt', { key: k }));
      throw new Error(t('servers.errPropBool', { key: k }));
    }
  }
  const result = await writePropertiesRaw(id, clean);
  if (clean['server-port']) await patchMeta(id, { port: Number(clean['server-port']) });
  return result;
}

// ---------- Versiones ----------

const HOUR = 3600 * 1000;
const isStable = (v) => !/(-|\bpre|rc\d|snapshot|w\d{2}[a-z])/i.test(v);
const enc = encodeURIComponent;

async function mohistVersions(project) {
  const cacheFile = paths.cache(`servers-${project}-versions.json`);
  try {
    const st = await fsp.stat(cacheFile);
    if (Date.now() - st.mtimeMs < 6 * HOUR) return await readJson(cacheFile);
  } catch {
    /* sin cache */
  }
  try {
    const raw = await http.getJson(`https://api.mohistmc.com/project/${project}/versions`);
    const names = (Array.isArray(raw) ? raw : []).map((v) => v.name || v).filter((v) => typeof v === 'string');
    // Solo versiones con builds publicados (la API lista algunas vacias).
    const out = [];
    await Promise.all(
      names.map(async (v) => {
        try {
          const b = await http.getJson(`https://api.mohistmc.com/project/${project}/${enc(v)}/builds/latest`, { retries: 1 });
          if (b?.id) out.push(v);
        } catch {
          /* sin builds */
        }
      }),
    );
    out.sort((a, b) => props.compareMc(b, a));
    await writeJson(cacheFile, out).catch(() => {});
    return out;
  } catch (err) {
    const cached = await readJson(cacheFile, null);
    if (cached) return cached;
    throw err;
  }
}

// Lista de versiones (la mas nueva primero). opts.snapshots incluye snapshots, pre-releases y builds de prueba.
async function versions(type, opts = {}) {
  const snapshots = Boolean(opts.snapshots);
  const keep = (list) => (snapshots ? list : list.filter(isStable));
  if (!TYPES[type]) throw new Error(t('servers.errType', { type }));
  if (FILL_PROJECTS.has(type)) {
    const data = await http.getJson(`https://fill.papermc.io/v3/projects/${type}`, { cacheFile: paths.cache(`servers-${type}-versions.json`), cacheMaxAge: HOUR });
    const all = Object.values(data.versions || {}).flat();
    if (type === 'velocity') return snapshots ? all : all.filter((v) => !/snapshot/i.test(v));
    return keep(all);
  }
  if (type === 'purpur') {
    const data = await http.getJson('https://api.purpurmc.org/v2/purpur', { cacheFile: paths.cache('servers-purpur-versions.json'), cacheMaxAge: HOUR });
    return keep([...(data.versions || [])].reverse());
  }
  if (type === 'spigot') {
    const cacheFile = paths.cache('servers-spigot-versions.json');
    let list;
    try {
      const st = await fsp.stat(cacheFile);
      if (Date.now() - st.mtimeMs < HOUR) list = await readJson(cacheFile);
    } catch {
      /* sin cache */
    }
    if (!list) {
      try {
        const html = await http.getText('https://hub.spigotmc.org/versions/');
        list = [...new Set([...html.matchAll(/href="([0-9][\w.-]*)\.json"/g)].map((m) => m[1]))].sort((a, b) => props.compareMc(b, a));
        await writeJson(cacheFile, list).catch(() => {});
      } catch (err) {
        list = await readJson(cacheFile, null);
        if (!list) throw err;
      }
    }
    return keep(list);
  }
  if (MOHIST_PROJECTS.has(type)) return keep(await mohistVersions(type));
  if (type === 'fabric' || type === 'quilt') {
    const fabric = require('./loaders/fabric');
    const list = await fabric.getGameVersions(type);
    return list.filter((v) => snapshots || v.stable).map((v) => v.version);
  }
  if (type === 'forge' || type === 'neoforge') {
    const forge = require('./loaders/forge');
    const m = await minecraft.getManifest();
    const order = new Map(m.versions.map((v, i) => [v.id, i]));
    return keep((await forge.getGameVersions(type)).filter((id) => order.has(id)).sort((a, b) => order.get(a) - order.get(b)));
  }
  // Vanilla: el manifest oficial (los servidores existen desde la 1.2.5)
  const m = await minecraft.getManifest();
  return m.versions
    .filter((v) => (v.type === 'release' && v.releaseTime >= '2012-03-29') || (snapshots && v.type === 'snapshot'))
    .map((v) => v.id);
}

// Versiones del loader para Fabric, Quilt, Forge y NeoForge: [{ version, label, stable, recommended }]
async function loaderVersions(type, mcVersion) {
  if (type === 'fabric' || type === 'quilt') return require('./loaders/fabric').getLoaderVersions(type, mcVersion);
  if (type === 'forge' || type === 'neoforge') return require('./loaders/forge').getLoaderVersions(type, mcVersion);
  return [];
}

// Puerto libre sugerido para un servidor nuevo (no repetir el de otro servidor de Venus).
async function suggestPort(type) {
  const used = new Set((await list()).map((s) => s.port));
  let port = TYPES[type]?.defaultPort || 25565;
  while (used.has(port) && port < 65535) port++;
  return port;
}

// ---------- Crear ----------

function slug(name, type) {
  return (
    String(name || `servidor-${type}`)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 40) || 'servidor'
  );
}

function nowStamp() {
  // Formato de fecha de los JSON de baneos de Minecraft: "2026-10-27 12:00:00 +0000"
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

/**
 * opts: { name, type, mcVersion, loaderVersion, port, memory:{min,max}, motd, maxPlayers, gamemode, difficulty,
 *         onlineMode, pvp, seed, levelType, hardcore, whitelist, viewDistance, op:{ name, uuid }, eula, flags }
 */
async function create(opts = {}) {
  const type = opts.type || 'vanilla';
  const meta = TYPES[type];
  if (!meta) throw new Error(t('servers.errType', { type }));
  if (meta.kind !== 'proxy' && opts.eula !== true) throw new Error(t('servers.errEula'));
  if (!opts.mcVersion || typeof opts.mcVersion !== 'string') throw new Error(t('servers.errVersion'));
  const base = slug(opts.name, type);
  let id = base;
  while (await exists(dir(id))) id = `${base}-${uid(4)}`;
  await fsp.mkdir(dir(id), { recursive: true });
  const port = Number(opts.port) || (await suggestPort(type));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(t('servers.errPort'));
  const name = String(opts.name || t('servers.defaultName', { type: meta.name })).replace(/\s+/g, ' ').trim().slice(0, 60);
  const mc = opts.mcVersion;
  const server = {
    id,
    name,
    type,
    mcVersion: mc,
    loaderVersion: opts.loaderVersion || 'latest',
    port,
    memory: clampMemory(opts.memory || (meta.kind === 'proxy' ? { min: 512, max: 1024 } : undefined)),
    flags: opts.flags === 'none' ? 'none' : 'aikar',
    java: { path: '', args: '' },
    automation: { autoRestart: false, autostart: false, restart: { mode: 'off', hours: 6, time: '05:00' }, backup: { mode: 'off', hours: 6, time: '04:00', keep: 5 } },
    created: Date.now(),
    installed: false,
    launch: null,
    mirror: opts.mirror || null,
  };
  const pending = {};
  await save(server);

  if (meta.kind !== 'proxy') {
    await fsp.writeFile(
      path.join(dir(id), 'eula.txt'),
      `#${t('servers.eulaComment')} (https://aka.ms/MinecraftEULA)\n#${new Date().toString()}\neula=true\n`,
    );
    const modernRules = props.atLeast(mc, '1.21.9');
    const onlineMode = opts.onlineMode !== false;
    const initial = {
      'server-port': String(port),
      motd: String(opts.motd || t('servers.defaultMotd', { name })).replace(/\r?\n/g, '\n').slice(0, 300),
      'max-players': String(Math.max(1, Math.min(10000, Number(opts.maxPlayers) || 10))),
      'online-mode': onlineMode ? 'true' : 'false',
      gamemode: ['survival', 'creative', 'adventure', 'spectator'].includes(opts.gamemode) ? opts.gamemode : 'survival',
      difficulty: ['peaceful', 'easy', 'normal', 'hard'].includes(opts.difficulty) ? opts.difficulty : 'normal',
      'level-seed': String(opts.seed || ''),
      'white-list': opts.whitelist ? 'true' : 'false',
      hardcore: opts.hardcore ? 'true' : 'false',
    };
    if (opts.levelType) initial['level-type'] = String(opts.levelType);
    if (opts.viewDistance) initial['view-distance'] = String(Math.max(3, Math.min(32, Number(opts.viewDistance) || 10)));
    // Las cuentas sin conexion no tienen clave de perfil: con online-mode=false conviene no exigirla.
    if (!onlineMode && props.atLeast(mc, '1.19')) initial['enforce-secure-profile'] = 'false';
    if (modernRules) {
      if (opts.pvp === false) pending.pvp = false;
    } else {
      initial.pvp = opts.pvp === false ? 'false' : 'true';
      initial['enable-command-block'] = 'true';
    }
    await writePropertiesRaw(id, initial);

    // El creador queda como operador (y en la lista blanca si esta activada).
    const op = opts.op && /^[A-Za-z0-9_]{1,16}$/.test(opts.op.name || '') ? opts.op : null;
    if (op) {
      const uuid = onlineMode && op.uuid ? dashUUID(String(op.uuid)) : dashUUID(offlineUUID(op.name));
      await writeJson(path.join(dir(id), 'ops.json'), [{ uuid, name: op.name, level: 4, bypassesPlayerLimit: false }]);
      if (opts.whitelist) await writeJson(path.join(dir(id), 'whitelist.json'), [{ uuid, name: op.name }]);
    }
  }
  if (Object.keys(pending).length) await patchMeta(id, { pendingGamerules: pending });
  return get(id);
}

// ---------- Java ----------

const RUNTIME_BY_MAJOR = [
  [8, 'jre-legacy'],
  [16, 'java-runtime-alpha'],
  [17, 'java-runtime-gamma'],
  [21, 'java-runtime-delta'],
  [25, 'java-runtime-epsilon'],
];

function runtimeFor(major) {
  const hit = RUNTIME_BY_MAJOR.find(([m]) => m >= major);
  // Versiones nuevas que Mojang todavia no publica: se usa Adoptium (ensureRuntime cae a Adoptium solo).
  return hit ? { component: hit[1], major: hit[0] } : { component: `adoptium-${major}`, major };
}

async function vanillaJavaMajor(mcVersion) {
  try {
    const v = await minecraft.getVersionJson(mcVersion);
    return v.javaVersion?.majorVersion || 8;
  } catch {
    return 21;
  }
}

async function ensureJava(major, task) {
  const r = runtimeFor(major);
  return java.toConsoleJava(await java.ensureRuntime(r.component, r.major, task));
}

async function javaFor(s, task) {
  if (s.java?.path && (await exists(s.java.path))) return java.toConsoleJava(s.java.path);
  const major = s.javaMajor || (isProxy(s) ? 21 : await vanillaJavaMajor(s.mcVersion));
  return ensureJava(major, task);
}

// ---------- Registro de la consola ----------

const LEVELS = { WARNING: 'WARN', SEVERE: 'ERROR', TRACE: 'DEBUG' };
function detectLevel(text, prev) {
  const m =
    text.match(/^\[[^\]]*\]\s?\[[^\]]*\/(INFO|WARN|WARNING|ERROR|SEVERE|FATAL|DEBUG|TRACE)\]/) ||
    text.match(/^\[[\d:.]+\s+(INFO|WARN|WARNING|ERROR|SEVERE|FATAL|DEBUG|TRACE)\]/) ||
    text.match(/^\[(INFO|WARN|WARNING|ERROR|SEVERE|FATAL|DEBUG|TRACE)\]/) ||
    text.match(/^\d{2}:\d{2}:\d{2}\s+\[(INFO|WARN|WARNING|ERROR|SEVERE|FATAL|DEBUG|TRACE)\]/);
  if (m) return LEVELS[m[1]] || m[1];
  if (/^\s+at |^\s*Caused by:|^\s*\.\.\. \d+ more|^[\w.$]+(Exception|Error)(:|$)/.test(text)) return prev === 'WARN' ? 'WARN' : 'ERROR';
  return 'INFO';
}

function pushLog(id, line) {
  let buf = consoles.get(id);
  if (!buf) consoles.set(id, (buf = []));
  const entry = { level: line.level || 'INFO', text: String(line.text ?? ''), t: Date.now() };
  buf.push(entry);
  if (buf.length > 5000) buf.splice(0, buf.length - 5000);
  events.emit('log', id, entry);
}

function venusLog(id, text, level = 'VENUS') {
  pushLog(id, { level, text: `[Venus] ${text}` });
}

function logs(id) {
  return consoles.get(id) || [];
}

function clearLogs(id) {
  consoles.delete(id);
  return true;
}

// Ejecuta un proceso (instaladores, BuildTools) mandando su salida a la consola del servidor.
function runProcess(exe, args, { cwd, task, id, label, onLine } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(exe, args, { cwd, windowsHide: true });
    } catch (err) {
      reject(err);
      return;
    }
    const tail = [];
    let buf = '';
    let prev = 'INFO';
    const handle = (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n|\r/);
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > 30) tail.shift();
        prev = detectLevel(line, prev);
        if (id) pushLog(id, { level: prev, text: line });
        task?.update({ detail: `${label}: ${line.trim().slice(0, 140)}` });
        if (onLine) onLine(line);
      }
    };
    child.stdout.on('data', handle);
    child.stderr.on('data', handle);
    const onAbort = () => child.kill();
    task?.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => {
      task?.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('exit', (code) => {
      task?.signal?.removeEventListener('abort', onAbort);
      if (buf.trim()) handle('\n');
      if (task?.signal?.aborted) reject(task.signal.reason || new Error(t('servers.errCancelled')));
      else if (code === 0) resolve(tail);
      else reject(new Error(t('servers.errProcess', { name: label, code, tail: tail.slice(-8).join('\n') })));
    });
  });
}

// ---------- Instalacion ----------

async function downloadJar(task, item, label) {
  let got = 0;
  const total = item.size || 0;
  task?.update({ detail: label, progress: total ? 0 : null });
  await http.download(item, {
    verify: 'hash',
    signal: task?.signal,
    onBytes: (n) => {
      got += n;
      if (total) task?.update({ detail: `${label} · ${(got / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`, progress: Math.min(1, got / total) });
    },
  });
  task?.update({ progress: null });
}

function httpError(err, type, version) {
  if (err?.status === 404) return new Error(t('servers.errNoBuild', { type: TYPES[type]?.name || type, version }));
  return err;
}

async function findArgsFile(serverDir) {
  const bases = ['libraries/net/minecraftforge/forge', 'libraries/net/neoforged/neoforge', 'libraries/net/neoforged/forge'];
  const name = process.platform === 'win32' ? 'win_args.txt' : 'unix_args.txt';
  for (const b of bases) {
    const root = path.join(serverDir, b);
    let vers = [];
    try {
      vers = await fsp.readdir(root);
    } catch {
      continue;
    }
    vers.sort((a, b2) => b2.localeCompare(a, 'en', { numeric: true }));
    for (const v of vers) {
      const f = path.join(root, v, name);
      if (await exists(f)) return path.relative(serverDir, f).split(path.sep).join('/');
    }
  }
  return null;
}

const FORGE_MAVEN = 'https://maven.minecraftforge.net/';
const NEO_MAVEN = 'https://maven.neoforged.net/releases/';

async function forgeFullVersion(kind, mcVersion, wanted) {
  const forge = require('./loaders/forge');
  const list = await forge.getLoaderVersions(kind, mcVersion);
  if (!list.length) throw new Error(t('servers.errNoLoader', { type: TYPES[kind].name, version: mcVersion }));
  if (!wanted || wanted === 'latest') return (list.find((l) => l.recommended) || list.find((l) => l.stable) || list[0]).version;
  const hit = list.find((l) => l.version === wanted || l.label === wanted || l.version === `${mcVersion}-${wanted}`);
  return hit ? hit.version : wanted;
}

function forgeInstallerUrl(kind, full) {
  if (kind === 'forge') return `${FORGE_MAVEN}net/minecraftforge/forge/${full}/forge-${full}-installer.jar`;
  if (/^1\.20\.1-/.test(full)) return `${NEO_MAVEN}net/neoforged/forge/${full}/forge-${full}-installer.jar`;
  return `${NEO_MAVEN}net/neoforged/neoforge/${full}/neoforge-${full}-installer.jar`;
}

async function pickLoader(type, mcVersion, wanted) {
  if (wanted && wanted !== 'latest') return wanted;
  const fabric = require('./loaders/fabric');
  const list = await fabric.getLoaderVersions(type, mcVersion);
  if (!list.length) throw new Error(t('servers.errNoLoader', { type: TYPES[type].name, version: mcVersion }));
  return (list.find((l) => l.stable) || list[0]).version;
}

async function installType(s, sdir, task) {
  const type = s.type;
  const name = TYPES[type].name;
  const label = t('servers.detailDownloading', { name, version: s.mcVersion });
  const out = { loaderVersion: s.loaderVersion, javaMajor: null, build: null };

  if (type === 'vanilla') {
    const v = await minecraft.getVersionJson(s.mcVersion);
    const srv = v.downloads?.server;
    if (!srv) throw new Error(t('servers.errNoVanillaServer', { version: s.mcVersion }));
    await downloadJar(task, { url: srv.url, path: path.join(sdir, 'server.jar'), sha1: srv.sha1, size: srv.size }, label);
    out.javaMajor = v.javaVersion?.majorVersion || 8;
    out.launch = { args: ['-jar', 'server.jar', 'nogui'] };
    return out;
  }

  if (FILL_PROJECTS.has(type)) {
    let b;
    try {
      b = await http.getJson(`https://fill.papermc.io/v3/projects/${type}/versions/${enc(s.mcVersion)}/builds/latest`);
    } catch (err) {
      throw httpError(err, type, s.mcVersion);
    }
    const dl = b.downloads?.['server:default'];
    if (!dl) throw new Error(t('servers.errNoBuild', { type: name, version: s.mcVersion }));
    await downloadJar(task, { url: dl.url, path: path.join(sdir, `${type}.jar`), sha256: dl.checksums?.sha256, size: dl.size }, label);
    out.build = String(b.id);
    out.loaderVersion = String(b.id);
    out.channel = b.channel || null;
    if (TYPES[type].kind === 'proxy') {
      const info = await http
        .getJson(`https://fill.papermc.io/v3/projects/${type}/versions/${enc(s.mcVersion)}`, { cacheFile: paths.cache(`servers-${type}-${s.mcVersion}.json`), cacheMaxAge: 6 * HOUR })
        .catch(() => null);
      out.javaMajor = Math.max(21, info?.version?.java?.version?.minimum || 17);
      out.launch = { args: ['-jar', `${type}.jar`] };
    } else {
      out.javaMajor = await vanillaJavaMajor(s.mcVersion);
      out.launch = { args: ['-jar', `${type}.jar`, '--nogui'] };
    }
    return out;
  }

  if (type === 'purpur') {
    let b;
    try {
      b = await http.getJson(`https://api.purpurmc.org/v2/purpur/${enc(s.mcVersion)}/latest`);
    } catch (err) {
      throw httpError(err, type, s.mcVersion);
    }
    if (!b?.build) throw new Error(t('servers.errNoBuild', { type: name, version: s.mcVersion }));
    const file = path.join(sdir, 'purpur.jar');
    const current = (await exists(file)) && b.md5 ? await hashFile(file, 'md5') : null;
    if (current !== b.md5) {
      await downloadJar(task, { url: `https://api.purpurmc.org/v2/purpur/${enc(s.mcVersion)}/${enc(b.build)}/download`, path: file, force: true }, label);
      if (b.md5 && (await hashFile(file, 'md5')) !== String(b.md5).toLowerCase()) {
        await fsp.rm(file, { force: true });
        throw new Error(t('servers.errHash', { file: 'purpur.jar' }));
      }
    }
    out.build = String(b.build);
    out.loaderVersion = String(b.build);
    out.javaMajor = await vanillaJavaMajor(s.mcVersion);
    out.launch = { args: ['-jar', 'purpur.jar', '--nogui'] };
    return out;
  }

  if (MOHIST_PROJECTS.has(type)) {
    let b;
    try {
      b = await http.getJson(`https://api.mohistmc.com/project/${type}/${enc(s.mcVersion)}/builds/latest`);
    } catch (err) {
      throw httpError(err, type, s.mcVersion);
    }
    if (!b?.id) throw new Error(t('servers.errNoBuild', { type: name, version: s.mcVersion }));
    await downloadJar(
      task,
      { url: `https://api.mohistmc.com/project/${type}/${enc(s.mcVersion)}/builds/${enc(b.id)}/download`, path: path.join(sdir, `${type}.jar`), sha256: b.file_sha256 },
      label,
    );
    out.build = String(b.id);
    out.loaderVersion = String(b.id);
    out.javaMajor = await vanillaJavaMajor(s.mcVersion);
    out.launch = { args: ['-jar', `${type}.jar`, 'nogui'] };
    return out;
  }

  if (type === 'fabric') {
    const lv = await pickLoader('fabric', s.mcVersion, s.loaderVersion);
    const installers = await http.getJson('https://meta.fabricmc.net/v2/versions/installer', { cacheFile: paths.cache('fabric-installers.json'), cacheMaxAge: 6 * HOUR });
    const inst = (installers.find((i) => i.stable) || installers[0]).version;
    await downloadJar(
      task,
      { url: `https://meta.fabricmc.net/v2/versions/loader/${enc(s.mcVersion)}/${enc(lv)}/${enc(inst)}/server/jar`, path: path.join(sdir, 'fabric-server-launch.jar'), force: true },
      label,
    );
    out.loaderVersion = lv;
    out.javaMajor = await vanillaJavaMajor(s.mcVersion);
    out.launch = { args: ['-jar', 'fabric-server-launch.jar', 'nogui'] };
    return out;
  }

  out.javaMajor = await vanillaJavaMajor(s.mcVersion);

  if (type === 'quilt') {
    const lv = await pickLoader('quilt', s.mcVersion, s.loaderVersion);
    const installers = await http.getJson('https://meta.quiltmc.org/v3/versions/installer', { cacheFile: paths.cache('quilt-installers.json'), cacheMaxAge: 6 * HOUR });
    const inst = installers[0];
    if (!inst?.url) throw new Error(t('servers.errNoLoader', { type: name, version: s.mcVersion }));
    const jar = paths.cache('installers', `quilt-installer-${inst.version}.jar`);
    await downloadJar(task, { url: inst.url, path: jar, sha256: inst.hashes?.sha256, size: inst.file_size }, t('servers.detailInstallerDownload', { name }));
    const javaExe = await ensureJava(out.javaMajor, task);
    await fsp.rm(path.join(sdir, 'quilt-server-launch.jar'), { force: true });
    await runProcess(javaExe, ['-jar', jar, 'install', 'server', s.mcVersion, lv, '--download-server', '--install-dir=.'], { cwd: sdir, task, id: s.id, label: t('servers.labelInstaller', { name }) });
    // El instalador de Quilt termina con codigo 0 aunque falle: se verifica el resultado.
    if (!(await exists(path.join(sdir, 'quilt-server-launch.jar'))) || !(await exists(path.join(sdir, 'server.jar')))) {
      throw new Error(t('servers.errInstallFailed', { name }));
    }
    out.loaderVersion = lv;
    out.launch = { args: ['-jar', 'quilt-server-launch.jar', 'nogui'] };
    return out;
  }

  if (type === 'forge' || type === 'neoforge') {
    const full = await forgeFullVersion(type, s.mcVersion, s.loaderVersion);
    const installer = paths.cache('installers', `${type}-${full}-installer.jar`);
    try {
      await downloadJar(task, { url: forgeInstallerUrl(type, full), path: installer }, t('servers.detailInstallerDownload', { name }));
    } catch (err) {
      if (err?.status === 404) throw new Error(t('servers.errOldForge', { name, version: full }));
      throw err;
    }
    const javaExe = await ensureJava(out.javaMajor, task);
    task?.update({ detail: t('servers.detailRunningInstaller', { name }), progress: null });
    await runProcess(javaExe, ['-jar', installer, '--installServer', sdir], { cwd: sdir, task, id: s.id, label: t('servers.labelInstaller', { name }) });
    out.loaderVersion = full;
    const argsFile = await findArgsFile(sdir);
    if (argsFile) out.launch = { args: [`@${argsFile}`, 'nogui'] };
    else {
      const files = await fsp.readdir(sdir);
      const jar = files.find((f) => /^(forge|neoforge).*\.jar$/i.test(f) && !/installer/i.test(f));
      if (!jar) throw new Error(t('servers.errNoJar'));
      out.launch = { args: ['-jar', jar, 'nogui'] };
    }
    return out;
  }

  if (type === 'spigot') {
    let info = null;
    try {
      info = await http.getJson(`https://hub.spigotmc.org/versions/${enc(s.mcVersion)}.json`, { cacheFile: paths.cache(`spigot-${s.mcVersion}.json`), cacheMaxAge: HOUR });
    } catch (err) {
      throw httpError(err, type, s.mcVersion);
    }
    const [minClass] = info.javaVersions || [];
    if (minClass) out.javaMajor = Math.max(8, minClass - 44);
    const javaExe = await ensureJava(out.javaMajor, task);
    // Los scripts de parches de BuildTools fallan con caracteres especiales o no ASCII en la ruta
    // (por ejemplo un usuario de Windows con tildes): en ese caso se compila en ProgramData.
    let work = paths.cache('buildtools');
    if (/[^A-Za-z0-9 _.:\\/-]/.test(work) && process.platform === 'win32' && process.env.ProgramData) work = path.join(process.env.ProgramData, 'VenusLauncher', 'buildtools');
    await fsp.mkdir(work, { recursive: true });
    const tools = path.join(work, 'BuildTools.jar');
    const st = await fsp.stat(tools).catch(() => null);
    if (!st || Date.now() - st.mtimeMs > 24 * HOUR) {
      await downloadJar(task, { url: 'https://hub.spigotmc.org/jenkins/job/BuildTools/lastSuccessfulBuild/artifact/target/BuildTools.jar', path: tools, force: true }, t('servers.detailBuildToolsDownload'));
    }
    venusLog(s.id, t('servers.logBuildTools', { version: s.mcVersion }));
    for (const f of await fsp.readdir(sdir)) if (/^spigot.*\.jar$/i.test(f)) await fsp.rm(path.join(sdir, f), { force: true });
    const steps = [
      [/Starting clone|Cloning|Pulling updates/i, 0.08],
      [/Applying patches|Patching/i, 0.35],
      [/Building|Compiling|\[INFO\] Building/i, 0.55],
      [/BUILD SUCCESS|Success! Everything completed/i, 0.95],
    ];
    let progress = 0.02;
    task?.update({ detail: t('servers.detailBuildTools'), progress });
    await runProcess(javaExe, ['-jar', tools, '--nogui', '--rev', s.mcVersion, '--output-dir', sdir, '--final-name', 'spigot.jar'], {
      cwd: work,
      task,
      id: s.id,
      label: 'BuildTools',
      onLine: (line) => {
        for (const [re, p] of steps) {
          if (p > progress && re.test(line)) {
            progress = p;
            task?.update({ progress });
          }
        }
      },
    });
    const jar = (await fsp.readdir(sdir)).find((f) => /^spigot.*\.jar$/i.test(f));
    if (!jar) throw new Error(t('servers.errNoJar'));
    if (jar !== 'spigot.jar') await fsp.rename(path.join(sdir, jar), path.join(sdir, 'spigot.jar'));
    out.build = info.name || null;
    out.loaderVersion = info.name ? String(info.name) : s.loaderVersion;
    out.launch = { args: ['-jar', 'spigot.jar', 'nogui'] };
    return out;
  }

  throw new Error(t('servers.errType', { type }));
}

async function install(id, task) {
  const s = await get(id);
  if (running.has(id)) throw new Error(t('servers.errStopFirst'));
  const sdir = dir(id);
  const name = TYPES[s.type]?.name || s.type;
  venusLog(id, t('servers.logInstalling', { name, version: s.mcVersion }));
  try {
    const res = await installType(s, sdir, task);
    venusLog(id, t('servers.logInstalled', { name, version: s.mcVersion }));
    return patchMeta(id, {
      installed: true,
      launch: res.launch,
      loaderVersion: res.loaderVersion || s.loaderVersion,
      javaMajor: res.javaMajor || null,
      build: res.build || null,
      channel: res.channel || null,
      installedAt: Date.now(),
    });
  } catch (err) {
    if (!task?.signal?.aborted) venusLog(id, t('servers.logInstallFailed', { error: err.message }), 'ERROR');
    throw err;
  }
}

// Ultimo build disponible (para avisar de actualizaciones de Paper, Purpur, Folia, Mohist...).
async function checkUpdate(id) {
  const s = await get(id);
  let latest = null;
  try {
    if (FILL_PROJECTS.has(s.type)) latest = String((await http.getJson(`https://fill.papermc.io/v3/projects/${s.type}/versions/${enc(s.mcVersion)}/builds/latest`)).id);
    else if (s.type === 'purpur') latest = String((await http.getJson(`https://api.purpurmc.org/v2/purpur/${enc(s.mcVersion)}/latest`)).build);
    else if (MOHIST_PROJECTS.has(s.type)) latest = String((await http.getJson(`https://api.mohistmc.com/project/${s.type}/${enc(s.mcVersion)}/builds/latest`)).id);
  } catch {
    latest = null;
  }
  return { current: s.build || null, latest, available: Boolean(latest && s.build && latest !== s.build) };
}

// ---------- Ejecucion ----------

function setState(id, state, extra = {}) {
  const r = running.get(id);
  if (r) r.state = state;
  const players = r ? [...r.players.keys()] : [];
  events.emit('state', id, { state, players, playerInfo: r ? [...r.players.entries()].map(([name, p]) => ({ name, ...p })) : [], ...extra });
}

function portFree(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, host || '0.0.0.0');
  });
}

const AIKAR_FLAGS = [
  '-XX:+UseG1GC',
  '-XX:+ParallelRefProcEnabled',
  '-XX:MaxGCPauseMillis=200',
  '-XX:+UnlockExperimentalVMOptions',
  '-XX:+DisableExplicitGC',
  '-XX:+AlwaysPreTouch',
  '-XX:G1NewSizePercent=30',
  '-XX:G1MaxNewSizePercent=40',
  '-XX:G1HeapRegionSize=8M',
  '-XX:G1ReservePercent=20',
  '-XX:G1HeapWastePercent=5',
  '-XX:G1MixedGCCountTarget=4',
  '-XX:InitiatingHeapOccupancyPercent=15',
  '-XX:G1MixedGCLiveThresholdPercent=90',
  '-XX:G1RSetUpdatingPauseTimePercent=5',
  '-XX:SurvivorRatio=32',
  '-XX:+PerfDisableSharedMem',
  '-XX:MaxTenuringThreshold=1',
  '-Dusing.aikars.flags=https://mcflags.emc.gs',
  '-Daikars.new.flags=true',
];
// Flags recomendadas por Velocity para proxies.
const PROXY_FLAGS = ['-XX:+UseG1GC', '-XX:G1HeapRegionSize=4M', '-XX:+UnlockExperimentalVMOptions', '-XX:+ParallelRefProcEnabled', '-XX:+AlwaysPreTouch', '-XX:MaxInlineLevel=15'];
const CONSOLE_UTF8 = ['-Dfile.encoding=UTF-8', '-Dsun.stdout.encoding=UTF-8', '-Dsun.stderr.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8'];

function splitArgs(str) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(str || ''))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// Waterfall no acepta el puerto por linea de comandos: se escribe en config.yml (si falta, uno minimo que completa solo).
async function applyProxyPort(s) {
  if (s.type !== 'waterfall') return;
  const file = path.join(dir(s.id), 'config.yml');
  const text = await fsp.readFile(file, 'utf8').catch(() => null);
  if (text === null) {
    await fsp.writeFile(file, `listeners:\n- host: 0.0.0.0:${s.port}\n  query_port: ${s.port}\n`);
    return;
  }
  const next = text.replace(/^(\s*-?\s*host:\s*)(['"]?)([^\s'":]+):(\d+)\2\s*$/m, (m0, pre, q, host) => `${pre}${q}${host}:${s.port}${q}`);
  if (next !== text) await fsp.writeFile(file, next);
}

const STOP_COMMAND = { velocity: 'shutdown', waterfall: 'end' };

function handleLine(id, r, line) {
  if (/Done \([\d.,]+m?s\)!|Listening on \//.test(line) && r.state === 'starting') setState(id, 'online');
  let m = line.match(/UUID of player ([A-Za-z0-9_]{1,16}) is ([0-9a-f-]{32,36})/i);
  if (m) {
    const p = r.players.get(m[1]) || r.pending.get(m[1]) || {};
    r.pending.set(m[1], { ...p, uuid: m[2] });
  }
  m = line.match(/\]: ([A-Za-z0-9_]{1,16})\[\/(.+):\d+\] logged in with entity id/);
  if (m) {
    const p = r.pending.get(m[1]) || {};
    r.pending.set(m[1], { ...p, ip: m[2].replace(/^\[|\]$/g, '') });
  }
  m = line.match(/\]: ([A-Za-z0-9_]{1,16}) joined the game/) || line.match(/\[connected player\] ([A-Za-z0-9_]{1,16}) \([^)]*\) has connected/);
  if (m) {
    r.players.set(m[1], { ...(r.pending.get(m[1]) || {}), since: Date.now() });
    r.pending.delete(m[1]);
    setState(id, r.state);
    events.emit('player', id, { type: 'join', name: m[1] });
  }
  m = line.match(/\]: ([A-Za-z0-9_]{1,16}) left the game/) || line.match(/\[connected player\] ([A-Za-z0-9_]{1,16}) \([^)]*\) has disconnected/);
  if (m && r.players.has(m[1])) {
    r.players.delete(m[1]);
    setState(id, r.state);
    events.emit('player', id, { type: 'leave', name: m[1] });
  }
  // Respuesta de "list": "There are 2 of a max of 20 players online: Steve, Alex"
  m = line.match(/There are (\d+) (?:of a max of|out of maximum) \d+ players online[:.]\s*(.*)$/);
  if (m) {
    const names = Number(m[1]) === 0 ? [] : m[2].split(/,\s*/).map((n) => n.trim()).filter((n) => /^[A-Za-z0-9_]{1,16}$/.test(n));
    if (Number(m[1]) === 0 || names.length) {
      const next = new Map();
      for (const n of names) next.set(n, r.players.get(n) || { since: Date.now() });
      const changed = next.size !== r.players.size || names.some((n) => !r.players.has(n));
      r.players = next;
      if (changed) setState(id, r.state);
    }
  }
}

async function start(id, task) {
  if (running.has(id)) throw new Error(t('servers.errRunning'));
  if (busy.has(id)) throw new Error(t('servers.errBusy'));
  busy.add(id);
  let s;
  try {
    s = await get(id);
    if (!s.installed || !s.launch) s = await install(id, task);
    task?.update({ detail: t('servers.detailJava'), progress: null });
    const javaExe = await javaFor(s, task);
    if (!isProxy(s)) {
      const p = await readProperties(id);
      const port = Number(p['server-port']) || s.port;
      if (port !== s.port) s = await patchMeta(id, { port });
      if (!(await portFree(port, p['server-ip'] || undefined))) throw new Error(t('servers.errPortInUse', { port }));
    } else {
      if (!(await portFree(s.port))) throw new Error(t('servers.errPortInUse', { port: s.port }));
      await applyProxyPort(s);
    }
    const mem = clampMemory(s.memory);
    const flags = s.flags === 'none' ? [] : isProxy(s) ? PROXY_FLAGS : AIKAR_FLAGS;
    const launchArgs = [...s.launch.args];
    if (s.type === 'velocity') launchArgs.push('--port', String(s.port));
    const args = [`-Xms${mem.min}M`, `-Xmx${mem.max}M`, ...flags, ...splitArgs(s.java?.args), ...CONSOLE_UTF8, ...launchArgs];
    consoles.set(id, []);
    const r = { child: null, state: 'starting', players: new Map(), pending: new Map(), startedAt: Date.now(), stopRequested: false, type: s.type };
    running.set(id, r);
    setState(id, 'starting');
    venusLog(id, t('servers.logStarting', { name: s.name, type: TYPES[s.type]?.name || s.type, version: s.mcVersion, port: s.port }));
    venusLog(id, t('servers.logMemory', { min: mem.min, max: mem.max, java: path.basename(path.dirname(path.dirname(javaExe))) }));
    let child;
    try {
      child = spawn(javaExe, args, { cwd: dir(id), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      running.delete(id);
      setState(id, 'offline', { error: err.message });
      throw err;
    }
    r.child = child;
    let buf = '';
    let prev = 'INFO';
    const onData = (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const raw of lines) {
        const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
        if (!line.trim() || line.trim() === '>') continue;
        prev = detectLevel(line, prev);
        pushLog(id, { level: prev, text: line });
        handleLine(id, r, line);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.stdin.on('error', () => {});
    child.on('error', (err) => venusLog(id, t('servers.logSpawnError', { error: err.message }), 'ERROR'));
    child.on('exit', (code, signal) => {
      clearTimeout(r.killTimer);
      const crashed = !r.stopRequested && code !== 0;
      venusLog(id, crashed ? t('servers.logCrashed', { code: code ?? signal }) : t('servers.logStopped', { code: code ?? 0 }), crashed ? 'ERROR' : 'VENUS');
      running.delete(id);
      events.emit('state', id, { state: 'offline', code, crashed, players: [], playerInfo: [] });
      patchMeta(id, { lastStopped: Date.now(), lastExitCode: code ?? null }).catch(() => {});
    });
    await patchMeta(id, { lastStarted: Date.now() });
    return true;
  } finally {
    busy.delete(id);
  }
}

function command(id, cmd) {
  const r = running.get(id);
  if (!r?.child) throw new Error(t('servers.errOffline'));
  const text = String(cmd ?? '').replace(/[\r\n]+/g, ' ').trim().replace(/^\//, '');
  if (!text) return false;
  pushLog(id, { level: 'CMD', text: `> ${text}` });
  r.child.stdin.write(`${text}\n`);
  return true;
}

function stop(id) {
  const r = running.get(id);
  if (!r?.child) return false;
  r.stopRequested = true;
  setState(id, 'stopping');
  try {
    r.child.stdin.write(`${STOP_COMMAND[r.type] || 'stop'}\n`);
  } catch {
    /* stdin cerrado */
  }
  clearTimeout(r.killTimer);
  r.killTimer = setTimeout(() => r.child?.kill(), 60000);
  return true;
}

function kill(id) {
  const r = running.get(id);
  if (!r?.child) return false;
  r.stopRequested = true;
  r.child.kill();
  return true;
}

// Espera a que el servidor se apague (true) o se cumpla el tiempo (false).
function waitOffline(id, ms = 70000) {
  if (!running.has(id)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      events.off('state', onState);
      resolve(false);
    }, ms);
    const onState = (sid, st) => {
      if (sid === id && st.state === 'offline') {
        clearTimeout(timer);
        events.off('state', onState);
        resolve(true);
      }
    };
    events.on('state', onState);
  });
}

// Espera una linea de la consola que cumpla la expresion (por ejemplo "Saved the game").
function waitForLine(id, re, ms = 30000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      events.off('log', onLog);
      resolve(null);
    }, ms);
    const onLog = (sid, line) => {
      if (sid === id && re.test(line.text)) {
        clearTimeout(timer);
        events.off('log', onLog);
        resolve(line.text);
      }
    };
    events.on('log', onLog);
  });
}

async function restart(id, task) {
  if (running.has(id)) {
    stop(id);
    if (!(await waitOffline(id))) {
      kill(id);
      await waitOffline(id, 10000);
    }
  }
  return start(id, task);
}

const isRunning = (id) => running.has(id);
const runtimeState = (id) => running.get(id)?.state || 'offline';

async function remove(id) {
  const server = await get(id);
  if (running.has(id) || busy.has(id)) throw new Error(t('servers.errStopBeforeDelete'));
  // Un servidor tiene mundos: sin papelera no se borra (mismo criterio que serverx/world.js).
  const fail = () => new Error(t('servers.errTrash', { name: server?.name || id }));
  if (!trashFn) throw fail();
  try {
    await trashFn(dir(id));
  } catch {
    throw fail();
  }
  consoles.delete(id);
  return true;
}

function stopAll() {
  for (const id of running.keys()) stop(id);
}

function hasRunning() {
  return running.size > 0;
}

function killAll() {
  for (const id of running.keys()) kill(id);
}

function localAddresses() {
  const out = [];
  for (const [name, list2] of Object.entries(os.networkInterfaces())) {
    for (const a of list2 || []) if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
  }
  return out;
}

// ---------- Plugins y mods (Modrinth) ----------

function serverLoaders(s, projectType) {
  const m = TYPES[s?.type]?.modrinth || {};
  const mods = s?.type === 'neoforge' && s.mcVersion === '1.20.1' ? ['neoforge', 'forge'] : m.mod || [];
  if (projectType === 'mod') return mods;
  if (projectType === 'plugin') return m.plugin || [];
  return [...mods, ...(m.plugin || [])];
}

// opts.check(plan, { installed, dir }): lo llama justo antes de descargar (el asistente verifica los hosts de descarga
// y guarda las copias para Deshacer ahi); si lanza un error no se descarga nada.
async function installProject(id, projectId, versionId, task, opts = {}) {
  const s = await get(id);
  const meta = TYPES[s.type];
  if (!meta || meta.kind === 'vanilla') throw new Error(t('servers.errVanillaAddons'));
  const installed = s.modrinth?.projects || {};
  const target = { gameVersion: meta.kind === 'proxy' ? undefined : s.mcVersion, installed, loadersFor: () => serverLoaders(s) };
  const { plan, warnings } = await modrinth.resolveInstall(target, projectId, versionId, {});
  const modLoaders = new Set(meta.modrinth?.mod || []);
  for (const p of plan) {
    if (meta.kind === 'mods') p.type = 'mod';
    else if (meta.kind === 'hybrid') p.type = (p.version.loaders || []).some((l) => modLoaders.has(l)) ? 'mod' : 'plugin';
    else p.type = 'plugin';
  }
  if (typeof opts.check === 'function') await opts.check(plan, { installed, dir: dir(id) });
  const records = await modrinth.executePlan(dir(id), plan, { installed, task });
  await patchMeta(id, (cur) => ({ ...cur, modrinth: { ...(cur.modrinth || {}), projects: { ...(cur.modrinth?.projects || {}), ...records } } }));
  return { installed: Object.values(records).map((r) => r.title), warnings, records };
}

async function content(id) {
  const s = await get(id);
  const info = typeInfo(s.type);
  const folders = [];
  for (const folder of info?.folders || []) folders.push({ folder, files: await modrinth.listFolder(dir(id), folder) });
  const first = folders[0] || { folder: info?.folder || 'plugins', files: [] };
  return { folder: first.folder, files: first.files, folders };
}

module.exports = {
  setTrash,
  list,
  get,
  create,
  update,
  patchMeta,
  install,
  start,
  stop,
  kill,
  restart,
  command,
  logs,
  clearLogs,
  remove,
  stopAll,
  hasRunning,
  killAll,
  isRunning,
  runtimeState,
  waitOffline,
  waitForLine,
  readProperties,
  writeProperties,
  writePropertiesRaw,
  localAddresses,
  installProject,
  serverLoaders,
  content,
  checkUpdate,
  versions,
  loaderVersions,
  suggestPort,
  types,
  typeInfo,
  isProxy,
  javaFor,
  venusLog,
  dir,
  nowStamp,
  TYPES,
  events,
};
