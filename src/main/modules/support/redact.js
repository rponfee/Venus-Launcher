'use strict';
// Quita datos personales y rutas de lo que se adjunta a una consulta (diagnóstico y registro del juego).
// Parte del anonimizador del asistente (carpeta del usuario, usuario del sistema, equipo, nombres de las cuentas del
// launcher, correos, UUID, IP, claves y tokens) y suma lo que un registro de Minecraft trae de más: rutas absolutas
// de cualquier disco (solo queda el archivo y, si es una carpeta conocida del juego, la carpeta de arriba), chat,
// nombres de quienes entran y salen y datos de la sesión.
const os = require('os');
const { createRedactor } = require('../assistant/redact');

// Carpetas del juego que no dicen nada de la persona y ayudan a entender el error.
const SAFE_DIRS = new Set(['mods', 'config', 'logs', 'crash-reports', 'resourcepacks', 'shaderpacks', 'datapacks', 'saves', 'versions',
  'libraries', 'assets', 'natives', 'runtime', 'bin', 'lib', 'screenshots']);

// Unidad:\carpeta\archivo (las carpetas pueden tener espacios; el último tramo, no), \\equipo\recurso\... y rutas de Unix.
const WIN_PATH = /(?<![\w])[A-Za-z]:[\\/](?:[^\\/:*?"<>|\r\n;]+[\\/])*[^\\/:*?"<>|\s;]*/g;
const UNC_PATH = /\\\\[^\s\\/:*?"<>|]+(?:[\\/][^\\/:*?"<>|\r\n;]+)*[\\/][^\\/:*?"<>|\s;]*/g;
const UNIX_PATH = /(?<![\w.:~/-])\/(?:home|Users|root|mnt|media|opt|var|tmp|srv|private|Volumes)(?:\/[^/:*?"<>|\r\n;]+)*\/[^/:*?"<>|\s;]*/g;
// Rutas que quedaron como ~\carpeta\archivo después de sacar la carpeta del usuario: dentro puede haber nombres propios.
const HOME_PATH = /(?<![\w])~[\\/](?:[^\\/:*?"<>|\r\n;]+[\\/])*[^\\/:*?"<>|\s;]*/g;
// El nombre de la carpeta de una instancia lo elige la persona.
const INSTANCE_DIR = /(<launcher>[\\/]instances[\\/])[^\\/\s]+/gi;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
// Antes que el resto: si no, el nombre de usuario del sistema tapaba la parte de adelante del correo y dejaba el dominio.
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

// Líneas que el juego escribe con nombres de personas o con lo que se dijo en el chat.
const GAME_RULES = [
  [/(\[CHAT\]).*$/gim, '$1 <oculto>'],
  [/((?:Setting user:|--username|UUID of player)\s+)\S+/gi, '$1<player>'],
  [/(^|[\]:]\s*)([A-Za-z0-9_]{3,16})( (?:joined|left) the game)/gim, '$1<player>$3'],
  [/(^|[\]:]\s*)([A-Za-z0-9_]{3,16})( lost connection)/gim, '$1<player>$3'],
  [/(Logged in with \w+ as )\S+/gi, '$1<player>'],
];

// El anonimizador del asistente solo tapa nombres de usuario y de equipo de 4 letras o más (por las palabras comunes): acá también los
// de 3, salvo estas, que aparecen sueltas en cualquier registro.
const SHORT_COMMON = new Set(['the', 'you', 'and', 'for', 'win', 'mac', 'lan', 'dev', 'pcs', 'usr', 'bin', 'lib', 'log', 'net', 'jvm', 'gpu', 'cpu', 'ram', 'jar', 'mod']);

const PLACEHOLDERS = [
  ['<email>', 'email'], ['<ip>', 'ip'], ['<uuid>', 'uuid'], ['<token>', 'secret'], ['<redacted>', 'secret'], ['<user>', 'user'],
  ['<host>', 'host'], ['<player>', 'player'], ['<ruta>', 'path'], ['<launcher>', 'path'], ['<instancia>', 'path'], ['<oculto>', 'chat'],
];

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function systemUser() {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USERNAME || process.env.USER || '';
  }
}

function squashPath(match) {
  const parts = match.split(/[\\/]+/).filter((x) => x && x !== '~' && !/^[A-Za-z]:$/.test(x));
  if (!parts.length) return '<ruta>';
  const last = parts[parts.length - 1];
  const parent = parts.length > 1 ? parts[parts.length - 2] : '';
  return SAFE_DIRS.has(parent.toLowerCase()) ? `<ruta>/${parent}/${last}` : `<ruta>/${last}`;
}

// Cuenta cuántos datos se taparon, por tipo, mirando los marcadores que quedaron en el texto.
function countRedactions(text) {
  const kinds = {};
  let total = 0;
  const s = String(text ?? '');
  for (const [mark, kind] of PLACEHOLDERS) {
    const n = s.split(mark).length - 1;
    if (n) { kinds[kind] = (kinds[kind] || 0) + n; total += n; }
  }
  return { total, kinds };
}

// opciones: homedir, username, hostname, players (nombres de las cuentas del launcher), dataDir (carpeta de datos del launcher)
function createSupportRedactor(opts = {}) {
  const base = createRedactor({ homedir: opts.homedir ?? os.homedir(), username: opts.username, hostname: opts.hostname ?? os.hostname(), players: opts.players || [] });
  const dataParts = String(opts.dataDir || '').split(/[\\/]+/).filter(Boolean).map(escapeRe);
  const dataRe = dataParts.length >= 2 ? new RegExp(dataParts.join('[\\\\/]+'), 'gi') : null;
  const shortRules = [[opts.username ?? systemUser(), '<user>'], [opts.hostname ?? os.hostname(), '<host>']]
    .map(([value, mark]) => [String(value ?? '').trim(), mark])
    .filter(([value]) => value.length === 3 && /^[\w-]+$/.test(value) && !SHORT_COMMON.has(value.toLowerCase()))
    .map(([value, mark]) => [new RegExp(`(?<![\\w-])${escapeRe(value)}(?![\\w-])`, 'gi'), mark]);
  function text(input) {
    let s = String(input ?? '');
    s = s.replace(EMAIL, '<email>');
    if (dataRe) s = s.replace(dataRe, '<launcher>');
    s = base(s).replace(INSTANCE_DIR, '$1<instancia>');
    s = s.replace(WIN_PATH, squashPath).replace(HOME_PATH, squashPath).replace(UNC_PATH, squashPath).replace(UNIX_PATH, squashPath);
    for (const [re, rep] of shortRules) s = s.replace(re, rep);
    for (const [re, rep] of GAME_RULES) s = s.replace(re, rep);
    return s.replace(CONTROL, '');
  }
  return { text, lines: (arr) => (Array.isArray(arr) ? arr : []).map(text) };
}

module.exports = { createSupportRedactor, countRedactions, squashPath, SAFE_DIRS };
