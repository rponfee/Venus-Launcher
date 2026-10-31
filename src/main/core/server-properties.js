'use strict';
// server.properties: esquema de todas las propiedades vanilla (tipo, valor por defecto, rango, grupo y
// versiones en las que existen) + lector/escritor del formato .properties de Java que respeta
// comentarios, orden y escapes (\uXXXX, \:, continuaciones de linea).
// No depende de Electron: se puede probar con Node puro.

// ---------- Versiones de Minecraft ----------

// Ciclos de snapshots semanales (AAwSS): [año, ultima semana del ciclo, version a la que llevan]
const SNAPSHOT_CYCLES = [
  [17, 18, '1.12'],
  [18, 22, '1.13'],
  [18, 33, '1.13.1'],
  [19, 14, '1.14'],
  [19, 46, '1.15'],
  [20, 22, '1.16'],
  [20, 30, '1.16.2'],
  [21, 20, '1.17'],
  [21, 44, '1.18'],
  [22, 7, '1.18.2'],
  [22, 24, '1.19'],
  [22, 46, '1.19.3'],
  [23, 7, '1.19.4'],
  [23, 18, '1.20'],
  [23, 35, '1.20.2'],
  [23, 46, '1.20.3'],
  [24, 14, '1.20.5'],
  [24, 21, '1.21'],
  [24, 40, '1.21.2'],
  [24, 46, '1.21.4'],
  [25, 10, '1.21.5'],
  [25, 21, '1.21.6'],
  [25, 37, '1.21.9'],
  [25, 53, '1.21.11'],
];

// "1.21.11" -> [1, 21, 11, 0]; "1.20.5-rc1" / "26.4-snapshot-5" -> [.., -1] (anterior a la version final);
// "25w44a" -> version del ciclo con -1. Lo que no se entiende (proxies) cuenta como "la ultima".
function mcTuple(v) {
  const s = String(v || '').trim().toLowerCase();
  let m = s.match(/^(\d{2})w(\d{2})[a-z~]?$/);
  if (m) {
    const yy = Number(m[1]);
    const ww = Number(m[2]);
    const hit = SNAPSHOT_CYCLES.find(([y, w]) => yy < y || (yy === y && ww <= w));
    const base = mcTuple(hit ? hit[2] : '26.1');
    return [base[0], base[1], base[2], -1];
  }
  m = s.match(/^(\d+)\.(\d+)(?:\.(\d+))?(.*)$/);
  if (!m) return [9999, 0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3] || 0), m[4] && /\S/.test(m[4]) ? -1 : 0];
}

function compareMc(a, b) {
  const x = mcTuple(a);
  const y = mcTuple(b);
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

// Compara solo la version base (las pre-releases y snapshots de X ya traen los cambios de X).
function atLeast(version, min) {
  const x = mcTuple(version);
  const y = mcTuple(min);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return true;
}

function availableIn(entry, version) {
  if (!version) return true;
  if (entry.since && !atLeast(version, entry.since)) return false;
  if (entry.until && atLeast(version, entry.until)) return false;
  return true;
}

// ---------- Esquema ----------

const GROUPS = ['general', 'world', 'players', 'security', 'network', 'performance', 'advanced'];

const LEVEL_TYPES_NEW = ['minecraft:normal', 'minecraft:flat', 'minecraft:large_biomes', 'minecraft:amplified', 'minecraft:single_biome_surface'];
const LEVEL_TYPES_OLD = ['default', 'flat', 'largeBiomes', 'amplified'];

// type: bool | int | enum | string. adv: solo con "mostrar avanzados". secret: se muestra como contraseña.
// since/until: version de Minecraft en la que aparece / desaparece. special: editor propio en la interfaz.
const P = (key, type, def, group, extra = {}) => ({ key, type, default: def, group, ...extra });
const MAX_INT = 2147483647;

const SCHEMA = [
  // General
  P('motd', 'string', 'A Minecraft Server', 'general', { special: 'motd' }),
  P('max-players', 'int', 20, 'general', { min: 0, max: MAX_INT }),
  P('gamemode', 'enum', 'survival', 'general', { values: ['survival', 'creative', 'adventure', 'spectator'] }),
  P('difficulty', 'enum', 'easy', 'general', { values: ['peaceful', 'easy', 'normal', 'hard'] }),
  P('hardcore', 'bool', false, 'general'),
  P('force-gamemode', 'bool', false, 'general'),
  P('pvp', 'bool', true, 'general', { until: '1.21.9', gamerule: 'pvp' }),
  P('allow-flight', 'bool', false, 'general'),
  P('enable-command-block', 'bool', false, 'general', { until: '1.21.9', gamerule: 'command_blocks_work' }),

  // Mundo
  P('level-name', 'string', 'world', 'world'),
  P('level-seed', 'string', '', 'world'),
  P('level-type', 'enum', 'minecraft:normal', 'world', { special: 'levelType' }),
  P('generate-structures', 'bool', true, 'world'),
  P('spawn-protection', 'int', 16, 'world', { min: 0, max: MAX_INT }),
  P('allow-nether', 'bool', true, 'world', { until: '1.21.9', gamerule: 'allow_entering_nether_using_portals' }),
  P('spawn-monsters', 'bool', true, 'world', { until: '1.21.9', gamerule: 'spawn_monsters' }),
  P('spawn-animals', 'bool', true, 'world', { until: '1.21.2' }),
  P('spawn-npcs', 'bool', true, 'world', { until: '1.21.2' }),
  P('generator-settings', 'string', '{}', 'world', { adv: true }),
  P('max-world-size', 'int', 29999984, 'world', { min: 1, max: 29999984, adv: true }),
  P('initial-enabled-packs', 'string', 'vanilla', 'world', { since: '1.19.3', adv: true }),
  P('initial-disabled-packs', 'string', '', 'world', { since: '1.19.3', adv: true }),
  P('max-build-height', 'int', 256, 'world', { until: '1.17', min: 64, max: 256, adv: true }),

  // Jugadores
  P('white-list', 'bool', false, 'players'),
  P('enforce-whitelist', 'bool', false, 'players'),
  P('player-idle-timeout', 'int', 0, 'players', { min: 0, max: MAX_INT }),
  P('op-permission-level', 'int', 4, 'players', { min: 0, max: 4 }),
  P('hide-online-players', 'bool', false, 'players', { since: '1.18' }),
  P('function-permission-level', 'int', 2, 'players', { min: 1, max: 4, adv: true, since: '1.14.4' }),
  P('broadcast-console-to-ops', 'bool', true, 'players', { adv: true }),
  P('chat-spam-threshold-seconds', 'int', 10, 'players', { min: 0, max: MAX_INT, adv: true, since: '26.1' }),
  P('command-spam-threshold-seconds', 'int', 10, 'players', { min: 0, max: MAX_INT, adv: true, since: '26.1' }),
  P('enable-code-of-conduct', 'bool', false, 'players', { adv: true, since: '1.21.9' }),
  P('announce-player-achievements', 'bool', true, 'players', { adv: true, until: '1.12' }),

  // Seguridad
  P('online-mode', 'bool', true, 'security', { special: 'onlineMode' }),
  P('enforce-secure-profile', 'bool', true, 'security', { since: '1.19' }),
  P('enable-rcon', 'bool', false, 'security'),
  P('rcon.port', 'int', 25575, 'security', { min: 1, max: 65534 }),
  P('rcon.password', 'string', '', 'security', { secret: true }),
  P('log-ips', 'bool', true, 'security', { since: '1.20.2' }),
  P('prevent-proxy-connections', 'bool', false, 'security', { adv: true }),
  P('broadcast-rcon-to-ops', 'bool', true, 'security', { adv: true }),
  P('text-filtering-config', 'string', '', 'security', { adv: true, since: '1.17' }),
  P('text-filtering-version', 'int', 0, 'security', { min: 0, max: 1, adv: true, since: '1.21.9' }),
  P('allowed-connection-ids', 'string', '', 'security', { adv: true, since: '26.4' }),
  P('management-server-enabled', 'bool', false, 'security', { adv: true, since: '1.21.9' }),
  P('management-server-host', 'string', 'localhost', 'security', { adv: true, since: '1.21.9' }),
  P('management-server-port', 'int', 0, 'security', { min: 0, max: 65534, adv: true, since: '1.21.9' }),
  P('management-server-secret', 'string', '', 'security', { secret: true, adv: true, since: '1.21.9' }),
  P('management-server-tls-enabled', 'bool', true, 'security', { adv: true, since: '1.21.9' }),
  P('management-server-tls-keystore', 'string', '', 'security', { adv: true, since: '1.21.9' }),
  P('management-server-tls-keystore-password', 'string', '', 'security', { secret: true, adv: true, since: '1.21.9' }),
  P('management-server-allowed-origins', 'string', '', 'security', { adv: true, since: '26.1' }),

  // Red
  P('server-port', 'int', 25565, 'network', { min: 1, max: 65534 }),
  P('server-ip', 'string', '', 'network'),
  P('enable-status', 'bool', true, 'network', { since: '1.16' }),
  P('enable-query', 'bool', false, 'network'),
  P('query.port', 'int', 25565, 'network', { min: 1, max: 65534 }),
  P('resource-pack', 'string', '', 'network', { special: 'url' }),
  P('resource-pack-sha1', 'string', '', 'network', { special: 'sha1' }),
  P('resource-pack-id', 'string', '', 'network', { since: '1.20.3' }),
  P('resource-pack-prompt', 'string', '', 'network', { since: '1.17' }),
  P('require-resource-pack', 'bool', false, 'network', { since: '1.17' }),
  P('network-compression-threshold', 'int', 256, 'network', { min: -1, max: MAX_INT, adv: true }),
  P('rate-limit', 'int', 0, 'network', { min: 0, max: MAX_INT, adv: true, since: '1.16.2' }),
  P('accepts-transfers', 'bool', false, 'network', { adv: true, since: '1.20.5' }),
  P('use-native-transport', 'bool', true, 'network', { adv: true }),
  P('bug-report-link', 'string', '', 'network', { adv: true, since: '1.21' }),
  P('enable-legacy-status', 'bool', true, 'network', { adv: true, since: '26.4' }),
  P('status-contact-details', 'string', '', 'network', { adv: true, since: '26.4' }),
  P('status-heartbeat-interval', 'int', 0, 'network', { min: 0, max: MAX_INT, adv: true, since: '1.21.9' }),

  // Rendimiento
  P('view-distance', 'int', 10, 'performance', { min: 3, max: 32 }),
  P('simulation-distance', 'int', 10, 'performance', { min: 3, max: 32, since: '1.18' }),
  P('entity-broadcast-range-percentage', 'int', 100, 'performance', { min: 10, max: 1000, since: '1.16' }),
  P('pause-when-empty-seconds', 'int', 60, 'performance', { min: 0, max: MAX_INT, since: '1.21.2' }),
  P('max-tick-time', 'int', 60000, 'performance', { min: -1, max: MAX_INT, adv: true }),
  P('sync-chunk-writes', 'bool', true, 'performance', { adv: true, since: '1.16' }),
  P('max-chained-neighbor-updates', 'int', 1000000, 'performance', { min: -1, max: MAX_INT, adv: true, since: '1.19' }),
  P('region-file-compression', 'enum', 'deflate', 'performance', { values: ['deflate', 'lz4', 'none'], adv: true, since: '1.20.5' }),

  // Avanzado
  P('enable-jmx-monitoring', 'bool', false, 'advanced', { adv: true, since: '1.16' }),
  P('snooper-enabled', 'bool', true, 'advanced', { adv: true, until: '1.18' }),
  P('debug', 'bool', false, 'advanced', { adv: true }),
];

const BY_KEY = new Map(SCHEMA.map((e) => [e.key, e]));

// Clave de traduccion de cada propiedad: "max-players" -> "p_max_players" (+ "_desc")
function labelKey(key) {
  return `p_${String(key).replace(/[^a-zA-Z0-9]+/g, '_')}`;
}

// Esquema resuelto para una version (serializable por IPC: sin funciones).
function schemaFor(mcVersion) {
  return SCHEMA.map((e) => {
    const out = { ...e, labelKey: labelKey(e.key), descKey: `${labelKey(e.key)}_desc`, available: availableIn(e, mcVersion) };
    if (e.key === 'level-type') {
      const modern = !mcVersion || atLeast(mcVersion, '1.19');
      out.type = 'enum';
      out.values = modern ? LEVEL_TYPES_NEW : LEVEL_TYPES_OLD;
      out.default = modern ? 'minecraft:normal' : 'default';
    }
    if (e.key === 'white-list' && mcVersion && atLeast(mcVersion, '26.3')) out.default = true;
    if (e.key === 'difficulty' && mcVersion && !atLeast(mcVersion, '1.13')) out.default = 'easy';
    return out;
  });
}

// Valida y normaliza un valor segun el esquema. Devuelve el texto a escribir o lanza un Error con { code }.
function normalizeValue(key, value) {
  const e = BY_KEY.get(key);
  if (value === null || value === undefined) return null;
  if (!e) return String(value);
  if (e.type === 'bool') {
    if (value === true || value === 'true') return 'true';
    if (value === false || value === 'false') return 'false';
    throw Object.assign(new Error(`invalid bool ${key}`), { code: 'bool', key });
  }
  if (e.type === 'int') {
    const s = String(value).trim();
    if (!/^-?\d+$/.test(s)) throw Object.assign(new Error(`invalid int ${key}`), { code: 'int', key });
    const n = Number(s);
    if ((e.min !== undefined && n < e.min) || (e.max !== undefined && n > e.max)) {
      throw Object.assign(new Error(`out of range ${key}`), { code: 'range', key, min: e.min, max: e.max });
    }
    return String(n);
  }
  return String(value);
}

// ---------- Formato .properties ----------

function unescapeProps(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = s[++i];
    if (n === undefined) break;
    if (n === 't') out += '\t';
    else if (n === 'n') out += '\n';
    else if (n === 'r') out += '\r';
    else if (n === 'f') out += '\f';
    else if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 1, i + 5))) {
      out += String.fromCharCode(parseInt(s.slice(i + 1, i + 5), 16));
      i += 4;
    } else out += n;
  }
  return out;
}

function escapeProps(s, isKey) {
  const str = String(s ?? '');
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    const code = str.charCodeAt(i);
    if (c === '\\') out += '\\\\';
    else if (c === '\n') out += '\\n';
    else if (c === '\r') out += '\\r';
    else if (c === '\t') out += '\\t';
    else if (c === '\f') out += '\\f';
    else if (c === ' ' && (isKey || i === 0)) out += '\\ ';
    else if (c === '=' || c === ':' || c === '#' || c === '!') out += `\\${c}`;
    else if (code < 0x20 || code > 0x7e) out += `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`;
    else out += c;
  }
  return out;
}

function endsWithContinuation(line) {
  let n = 0;
  for (let i = line.length - 1; i >= 0 && line[i] === '\\'; i--) n++;
  return n % 2 === 1;
}

function splitKeyValue(logical) {
  let i = 0;
  let key = '';
  while (i < logical.length) {
    const c = logical[i];
    if (c === '\\') {
      key += c + (logical[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (c === '=' || c === ':' || c === ' ' || c === '\t' || c === '\f') break;
    key += c;
    i++;
  }
  while (i < logical.length && /[ \t\f]/.test(logical[i])) i++;
  if (logical[i] === '=' || logical[i] === ':') i++;
  while (i < logical.length && /[ \t\f]/.test(logical[i])) i++;
  return { key: unescapeProps(key), value: unescapeProps(logical.slice(i)) };
}

// Devuelve las entradas con las lineas fisicas que ocupa cada una (para reemplazarlas sin tocar el resto).
function parseEntries(text) {
  const lines = String(text || '').split(/\r?\n/);
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].replace(/^[ \t\f]+/, '');
    if (!trimmed || trimmed[0] === '#' || trimmed[0] === '!') continue;
    const start = i;
    let logical = trimmed;
    while (endsWithContinuation(logical) && i + 1 < lines.length) {
      logical = logical.slice(0, -1) + lines[++i].replace(/^[ \t\f]+/, '');
    }
    const { key, value } = splitKeyValue(logical);
    entries.push({ key, value, start, end: i });
  }
  return { lines, entries };
}

function parse(text) {
  const map = {};
  for (const e of parseEntries(text).entries) map[e.key] = e.value;
  return map;
}

// Aplica un parche { clave: valor | null } conservando comentarios, orden y formato del resto.
function applyPatch(text, patch) {
  const original = String(text || '');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const { lines, entries } = parseEntries(original);
  const pending = new Map(Object.entries(patch || {}));
  const replace = new Map(); // indice de linea inicial -> { end, text | null }
  for (const e of entries) {
    if (!pending.has(e.key)) continue;
    const v = pending.get(e.key);
    replace.set(e.start, { end: e.end, text: v === null || v === undefined ? null : `${escapeProps(e.key, true)}=${escapeProps(v)}` });
  }
  for (const e of entries) if (pending.has(e.key)) pending.delete(e.key);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const r = replace.get(i);
    if (!r) {
      out.push(lines[i]);
      continue;
    }
    if (r.text !== null) out.push(r.text);
    i = r.end;
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  if (!out.length) out.push('#Minecraft server properties', `#${new Date().toUTCString()}`);
  for (const [k, v] of pending) {
    if (v === null || v === undefined) continue;
    out.push(`${escapeProps(k, true)}=${escapeProps(v)}`);
  }
  return out.join(eol) + eol;
}

// Claves validas para propiedades nuevas que agrega el usuario.
function isValidKey(key) {
  return typeof key === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(key);
}

module.exports = {
  GROUPS,
  SCHEMA,
  LEVEL_TYPES_NEW,
  LEVEL_TYPES_OLD,
  schemaFor,
  normalizeValue,
  labelKey,
  parse,
  parseEntries,
  applyPatch,
  escapeProps,
  unescapeProps,
  isValidKey,
  mcTuple,
  compareMc,
  atLeast,
  availableIn,
};
