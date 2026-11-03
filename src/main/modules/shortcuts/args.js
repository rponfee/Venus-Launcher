'use strict';
// Accesos directos: logica sin Electron (argumentos del .lnk, nombre seguro del archivo y lectura de
// --play-instance=<id> de la linea de comandos). Pruebas: node --test "src/main/modules/shortcuts/test/"
const path = require('path');

const PLAY_FLAG = '--play-instance';
// Mismo criterio que core/instances.validSegment: un id es un solo segmento de ruta seguro.
const BAD_ID = /[\\/\x00-\x1f<>:"|?*]/;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?=\.|$)/i;
const NAME_MAX = 60;

function validId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 255 && id !== '.' && id !== '..' && id.trim() === id && !BAD_ID.test(id);
}

// Lista de argumentos (process.argv o los de 'second-instance') o una cadena (args de un .lnk) -> id o null.
// Acepta --play-instance=<id> y --play-instance <id>; el id puede ir entre comillas.
function parsePlayArg(argv) {
  const tokens = Array.isArray(argv) ? argv.map((a) => String(a ?? '')) : splitArgs(argv);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    let value = null;
    if (tok.startsWith(`${PLAY_FLAG}=`)) value = tok.slice(PLAY_FLAG.length + 1);
    else if (tok === PLAY_FLAG && i + 1 < tokens.length && !tokens[i + 1].startsWith('--')) value = tokens[i + 1];
    if (value === null) continue;
    const id = value.replace(/^"(.*)"$/, '$1');
    return validId(id) ? id : null;
  }
  return null;
}

// Separa una linea de argumentos respetando comillas dobles (tambien dentro de un token: --x="a b").
function splitArgs(line) {
  const out = [];
  let cur = '';
  let has = false;
  let quoted = false;
  for (const ch of String(line ?? '')) {
    if (ch === '"') {
      quoted = !quoted;
      has = true;
    } else if (!quoted && /\s/.test(ch)) {
      if (has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

// Nombre de archivo seguro para <nombre>.lnk en Windows (sin caracteres prohibidos ni nombres de dispositivo).
function safeLinkName(name, fallback = 'Venus Launcher') {
  let out = String(name ?? '')
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  out = Array.from(out).slice(0, NAME_MAX).join('').replace(/[. ]+$/g, '').trim();
  if (RESERVED.test(out)) out = `${out} (instancia)`;
  return out || fallback;
}

function quote(s) {
  return /[\s"]/.test(s) ? `"${String(s).replace(/"/g, '\\"')}"` : s;
}

/**
 * Datos del acceso directo: ruta, destino y argumentos.
 *  - empaquetado: destino = el .exe (o el .exe portable) con --play-instance=<id>
 *  - desarrollo: destino = electron con la carpeta de la app como primer argumento
 */
function buildShortcut({ id, name, desktopDir, execPath, portableExe = '', appPath = '', isPackaged = true, icon = '', description = '' }) {
  if (!validId(id)) throw new Error('id');
  const target = portableExe || execPath;
  const args = [isPackaged ? null : quote(appPath), `${PLAY_FLAG}=${quote(id)}`].filter(Boolean).join(' ');
  const base = safeLinkName(name);
  const file = path.win32.join(desktopDir, `${base}.lnk`);
  return {
    path: file,
    altPath: path.win32.join(desktopDir, `${safeLinkName(`${base} (${id})`)}.lnk`),
    name: base,
    target,
    cwd: path.win32.dirname(target),
    args,
    icon: icon || target,
    iconIndex: 0,
    description: description || name || '',
  };
}

module.exports = { PLAY_FLAG, validId, parsePlayArg, splitArgs, safeLinkName, buildShortcut };
