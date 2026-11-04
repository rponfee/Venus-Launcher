'use strict';
// Llevar todo a otra PC: que entra en un .venusbackup y que no. Sin Electron ni disco (pruebas en test/filter.test.js).
// Se aplica al exportar Y al importar: un archivo armado a mano no puede meter mas que uno hecho por el launcher.
//   neverCarry(rel)         -> cuentas, tokens, claves, registros, temporales y programas
//   keepInstanceFile(rel)   -> archivos de una instancia, sin mundos ni medios (van aparte) ni carpetas internas
//   keepWorldFile(rel) · keepMediaFile(rel) · keepServerFile(rel)
//   instanceMeta(raw) · serverMeta(raw) -> venus-instance.json / venus-server.json con solo los campos que viajan:
//     nunca java.path, argumentos, automatizaciones ni comandos, que correrian algo al jugar en la otra PC
//   cleanSettings(raw)      -> lista blanca de settings.json, sin rutas
//   looksLikePath(texto) · dropPaths(valor) · scrubText(rel, buf, raices) · redactSecrets(rel, buf)
const safety = require('../packs/safety');

const META_INSTANCE = 'venus-instance.json';
const META_SERVER = 'venus-server.json';

// ---------- Archivos ----------
// Carpetas de la raiz de una instancia que no se llevan: se regeneran solas o son de esta PC.
const INSTANCE_SKIP_TOP = new Set(['.venus', 'logs', 'crash-reports', 'natives', 'cache', '.cache', 'webcache', 'webcache2', '.fabric', '.quilt', '.mixin.out', 'debug', 'essential', '.essential', 'downloads', '.optifine']);
// Van en sus propias categorias
const MEDIA_TOP = new Set(['screenshots', 'replay_videos', 'videos', 'recordings', 'clips']);
const SERVER_SKIP_TOP = new Set(['.venus', 'logs', 'crash-reports', 'cache', 'backups', 'libraries', 'versions', 'bundler', '.paper-remapped', '.fabric', '.quilt', 'work', '.mixin.out', 'debug']);
const VIDEO_ROOT = /\.(mp4|webm|mkv|mov|m4v)$/i;
// Cuentas y claves, se llamen como se llamen en cada mod. El nombre solo cuenta en archivos de configuracion: un mod puede
// llamarse secret-rooms.jar o token-pack.zip y tiene que viajar igual.
const CONFIG_NAME = /\.(json5?|txt|toml|cfg|conf|ya?ml|properties|ini|xml|snbt|db|sqlite)$|^[^.]+$/i;
const SECRET_NAME = /(^|[._-])(tokens?|secrets?|credentials?|passwords?|passwd|api[-_]?keys?|oauth|auth)([._-]|$)/i;
const SECRET_FILE = /^(accounts?|launcher_accounts.*|launcher_msa_credentials.*|launcher_profiles.*|launcher_cef_.*|msa_credentials.*|microsoft_accounts?|usercache|usernamecache|command_history|realms_persistence|authlib-injector.*)(\.[\w.]+)?$/i;
const KEY_FILE = /\.(pem|key|p12|pfx|jks|keystore|asc|gpg|ppk|env)$/i;
const SECRET_EXACT = new Set(['.env', 'forwarding.secret', 'secure.json', 'settings.json.corrupt']);
// Programas: un archivo de copia nunca trae nada que el sistema pueda ejecutar directo. Los .js quedan: son los scripts de
// KubeJS y parecidos, parte del modpack, que corren adentro del juego como cualquier mod.
const PROGRAM_FILE = /\.(exe|com|bat|cmd|ps1|psm1|vbs|vbe|jse|wsf|wsh|scr|msi|msp|cpl|lnk|hta|reg|dll|so|dylib|sh|command|pif)$/i;
const LOG_FILE = /(\.log|\.log\.gz|\.tmp|\.part|\.crdownload|\.bak|\.old)$|^hs_err_pid.*|^replay_pid.*|^(Thumbs\.db|desktop\.ini|\.DS_Store)$/i;

const lastOf = (rel) => rel.slice(rel.lastIndexOf('/') + 1);

function neverCarry(rel) {
  const name = lastOf(String(rel));
  if (!name) return true;
  return SECRET_EXACT.has(name.toLowerCase()) || (SECRET_NAME.test(name) && CONFIG_NAME.test(name)) || SECRET_FILE.test(name) || KEY_FILE.test(name) || PROGRAM_FILE.test(name) || LOG_FILE.test(name);
}

function keepInstanceFile(rel, isDir = false) {
  const parts = String(rel).split('/');
  const top = parts[0];
  if (top === 'saves' || INSTANCE_SKIP_TOP.has(top.toLowerCase()) || MEDIA_TOP.has(top)) return false;
  if (parts.length === 1 && !isDir) {
    if (top === META_INSTANCE || VIDEO_ROOT.test(top) || /^options\.txt\.venus/i.test(top)) return false;
  }
  return isDir ? true : !neverCarry(rel);
}

// session.lock: el juego lo crea al abrir el mundo. El resto del mundo viaja entero (sus .dat, sus datapacks).
function keepWorldFile(rel, isDir = false) {
  if (isDir) return true;
  const name = lastOf(String(rel));
  return name.toLowerCase() !== 'session.lock' && !neverCarry(rel);
}

// Capturas y clips: solo imagenes y videos, en sus carpetas de siempre o videos sueltos en la raiz de la instancia.
function keepMediaFile(rel) {
  const parts = String(rel).split('/');
  const name = parts[parts.length - 1];
  if (neverCarry(rel)) return false;
  if (parts.length === 1) return VIDEO_ROOT.test(name);
  return MEDIA_TOP.has(parts[0]) && (VIDEO_ROOT.test(name) || /\.(png|jpe?g|webp)$/i.test(name));
}

function keepServerFile(rel, isDir = false) {
  const parts = String(rel).split('/');
  const top = parts[0];
  if (SERVER_SKIP_TOP.has(top.toLowerCase())) return false;
  if (isDir) return true;
  if (parts.length === 1) {
    // El .jar del servidor no viaja: al importar queda sin instalar y se baja de su fuente, verificado.
    if (top === META_SERVER || /\.jar$/i.test(top) || /^usercache\.json$/i.test(top)) return false;
  }
  return !neverCarry(rel);
}

// ---------- Rutas absolutas ----------
const WIN_PATH = /^[a-zA-Z]:[\\/]/;
const UNC_PATH = /^\\\\/;
const UNIX_PATH = /^\/(home|users|mnt|media|var|opt|tmp|usr|etc|root|applications|volumes|private|run)(\/|$)/i;
const INSIDE_PATH = /[a-zA-Z]:[\\/](users|documents and settings|program files|programdata|windows)[\\/]/i;

function looksLikePath(v) {
  if (typeof v !== 'string' || !v) return false;
  return WIN_PATH.test(v) || UNC_PATH.test(v) || UNIX_PATH.test(v) || /^file:/i.test(v) || /^~[\\/]/.test(v) || /^%[a-z_]+%[\\/]/i.test(v) || INSIDE_PATH.test(v);
}

// Copia de un valor sin ninguna ruta de la PC: el texto queda vacio y en una lista se saca.
function dropPaths(value) {
  if (typeof value === 'string') return looksLikePath(value) ? '' : value;
  if (Array.isArray(value)) return value.filter((x) => !looksLikePath(x)).map(dropPaths);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = dropPaths(v);
    return out;
  }
  return value;
}

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const bool = (v) => v === true;
const str = (v, max = 300) => (typeof v === 'string' && !looksLikePath(v) ? v.slice(0, max) : '');
const num = (v, def = 0, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

// ---------- Metadatos ----------
// Registros de proyectos instalados: lo unico util son los ids y el nombre del archivo dentro de la instancia
function cleanProjects(raw) {
  const src = obj(raw);
  if (!src) return null;
  const out = { projects: {}, pack: obj(src.pack) ? dropPaths(src.pack) : null };
  for (const [id, rec] of Object.entries(obj(src.projects) || {}).slice(0, 5000)) {
    const r = obj(rec);
    if (!r || !/^[\w.-]{1,64}$/.test(id)) continue;
    if (r.file !== undefined && typeof r.file === 'string' && !safety.safeRelPath(r.file.replace(/\\/g, '/'), { instance: true })) continue;
    out.projects[id] = dropPaths(r);
  }
  return out;
}

function instanceMeta(raw) {
  const r = obj(raw) || {};
  const memory = obj(r.memory);
  const win = obj(r.window);
  const out = {
    name: str(r.name, 60),
    mcVersion: str(r.mcVersion, 80),
    loader: str(r.loader, 40) || 'vanilla',
    loaderVersion: str(r.loaderVersion, 80) || 'latest',
    preset: str(r.preset, 40) || null,
    icon: typeof r.icon === 'string' && /^https?:\/\//.test(r.icon) ? r.icon.slice(0, 500) : null,
    group: str(r.group, 40) || null,
    created: num(r.created),
    lastPlayed: num(r.lastPlayed),
    playtime: num(r.playtime),
    launches: num(r.launches),
    memory: memory ? { override: bool(memory.override), min: num(memory.min, 1024, 256, 262144), max: num(memory.max, 4096, 512, 262144) } : null,
    window: win ? { override: bool(win.override), width: num(win.width, 0, 0, 16384), height: num(win.height, 0, 0, 16384), fullscreen: bool(win.fullscreen) } : null,
    modrinth: cleanProjects(r.modrinth),
    curseforge: cleanProjects(r.curseforge),
    cover: typeof r.cover === 'string' && /^cover\.(png|webp|jpe?g)$/i.test(r.cover) ? r.cover : null,
    coverAt: num(r.coverAt) || null,
    tags: Array.isArray(r.tags) ? r.tags.filter((x) => typeof x === 'string').slice(0, 10).map((x) => x.slice(0, 24)) : [],
    favorite: bool(r.favorite),
    notes: obj(r.notes) ? dropPaths(r.notes) : null,
  };
  return out;
}

const SERVER_TYPE = /^[a-z]{1,20}$/;

function serverMeta(raw) {
  const r = obj(raw) || {};
  const memory = obj(r.memory);
  return {
    name: str(r.name, 60),
    type: SERVER_TYPE.test(String(r.type)) ? r.type : '',
    mcVersion: str(r.mcVersion, 80),
    loaderVersion: str(r.loaderVersion, 80) || 'latest',
    port: Number.isInteger(r.port) && r.port > 0 && r.port < 65536 ? r.port : 25565,
    memory: memory ? { min: num(memory.min, 1024, 256, 65536), max: num(memory.max, 2048, 512, 65536) } : null,
    created: num(r.created),
    notes: str(r.notes, 2000),
  };
}

// ---------- Ajustes ----------
// Solo lo que es gusto del usuario. Afuera a proposito: privacy (las conexiones opcionales las decide cada PC), analysis
// (un archivo no puede apagar el analisis de seguridad), assistantMcp y mcp (comandos y puertos), jvmArgs, memory, ai,
// voice (dispositivos de esta PC), discord, updater y todo lo interno.
const SETTINGS_KEYS = ['language', 'appearance', 'branding', 'looks', 'decor', 'nav', 'home', 'a11y', 'versions', 'worlds', 'multiplayer', 'modrinth', 'smartsearch', 'compat', 'snapshots', 'ingame', 'overlay', 'capture', 'notify', 'play', 'news', 'recap', 'skineditor', 'mapviewer', 'backups'];

function cleanAppearance(raw) {
  const a = obj(raw);
  if (!a) return null;
  const { lite: _l, liteOverlay: _o, seasonalBackup: _s, bgFile: _b, music, ...rest } = a;
  const out = { ...rest };
  if (out.background === 'image') out.background = 'stars'; // la imagen propia es un archivo de esta PC
  const m = obj(music);
  if (m) out.music = { volume: m.volume, pauseInGame: m.pauseInGame, enabled: false, file: '' };
  return dropPaths(out);
}

const PICKERS = {
  appearance: cleanAppearance,
  looks: (list) => (Array.isArray(list) ? list.slice(0, 50).map((l) => (obj(l) ? dropPaths({ ...l, appearance: cleanAppearance(l.appearance) }) : null)).filter(Boolean) : null),
  smartsearch: (s) => (obj(s)?.prefs ? { prefs: dropPaths(s.prefs) } : null),
  ingame: (i) => (obj(i) ? { pack: i.pack, window: i.window } : null),
  capture: (c) => {
    if (!obj(c)) return null;
    const { copyTo: _c, ...rest } = c;
    return dropPaths(rest);
  },
  play: (p) => (obj(p) ? dropPaths({ breaks: p.breaks, sessionRecap: p.sessionRecap }) : null),
  news: (n) => (obj(n) ? { newVersions: n.newVersions } : null),
  // Las instancias elegidas son ids de esta PC
  backups: (b) => {
    const sc = obj(obj(b)?.schedule);
    if (!sc) return null;
    const { instances: _i, ...rest } = sc;
    return { schedule: { ...dropPaths(rest), instances: 'all' } };
  },
};

function cleanSettings(raw) {
  const r = obj(raw) || {};
  const out = {};
  for (const key of SETTINGS_KEYS) {
    if (r[key] === undefined || r[key] === null) continue;
    const value = PICKERS[key] ? PICKERS[key](r[key]) : dropPaths(r[key]);
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out;
}

// ---------- Texto de configuraciones ----------
const TEXT_FILE = /\.(json5?|txt|toml|cfg|conf|ya?ml|properties|ini|xml|snbt)$/i;
const SECRET_KEY = /[\w.-]*(password|passwd|secret|token|api[-_]?key)[\w.-]*/i;
const SECRET_JSON = new RegExp(`("${SECRET_KEY.source}"\\s*:\\s*)"[^"\\n]*"`, 'gi');
const SECRET_LINE = new RegExp(`^([ \\t]*["']?${SECRET_KEY.source}["']?[ \\t]*[:=][ \\t]*)(?![ \\t]|true\\b|false\\b|\\d+[ \\t]*\\r?$|\\[|\\{|\\r?$).+$`, 'gim');

// Saca el valor de las claves que parecen contrasenias o tokens (rcon.password, velocity.secret, BotToken...).
function redactSecrets(rel, buf) {
  if (!TEXT_FILE.test(rel) || buf.length > 1024 * 1024) return buf;
  const text = buf.toString('utf8');
  const next = /\.json5?$/i.test(rel) ? text.replace(SECRET_JSON, '$1""') : text.replace(SECRET_LINE, /\.properties$/i.test(rel) ? '$1' : '$1""');
  return next === text ? buf : Buffer.from(next, 'utf8');
}

const variantsOf = (root) => {
  const clean = String(root).replace(/[\\/]+$/, '');
  return [clean, clean.replace(/\\/g, '/'), clean.replace(/\\/g, '\\\\'), clean.replace(/\//g, '\\')];
};

// Las rutas de esta PC que quedaron en una configuracion (carpeta de datos, carpeta del usuario) se van del archivo.
function scrubText(rel, buf, roots) {
  if (!TEXT_FILE.test(rel) || !roots?.length) return buf;
  const needles = [...new Set(roots.filter(Boolean).flatMap(variantsOf))].filter((n) => n.length > 3).sort((a, b) => b.length - a.length);
  if (!needles.some((n) => buf.includes(n))) return buf;
  let text = buf.toString('utf8');
  for (const n of needles) text = text.split(n).join('.');
  return Buffer.from(text, 'utf8');
}

module.exports = {
  META_INSTANCE,
  META_SERVER,
  MEDIA_TOP,
  SETTINGS_KEYS,
  neverCarry,
  keepInstanceFile,
  keepWorldFile,
  keepMediaFile,
  keepServerFile,
  looksLikePath,
  dropPaths,
  instanceMeta,
  serverMeta,
  cleanSettings,
  redactSecrets,
  scrubText,
};
