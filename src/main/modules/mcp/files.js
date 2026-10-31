'use strict';
// Archivos del MCP en <datos>/mcp/:
//   bridge.json            puerto, secreto y estado del servidor local (lo lee el puente stdio)
//   tools.json             ultima lista de herramientas, instrucciones y textos (el puente la usa con el
//                          launcher cerrado o el MCP apagado)
//   venus-mcp-bridge.js    copia del puente, afuera del .asar para poder ejecutarlo con ELECTRON_RUN_AS_NODE
//   activity.json          registro "Actividad MCP"
//   bin/                   cloudflared (solo si se uso el tunel)
// Permisos: en macOS y Linux la carpeta queda 0700 y los archivos 0600. En Windows la carpeta queda solo para el
// usuario actual con icacls (sin herencia, por su SID); si icacls falla (por ejemplo en un pendrive FAT) se
// restablece la herencia y se sigue: %APPDATA% ya es privada del usuario.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const MARKER = '.private';

function exec(cmd, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

async function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (err) {
      if (i >= 6 || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err;
      await new Promise((r) => setTimeout(r, 100 * (i + 1)));
    }
  }
}

// Escrituras en serie por archivo: la ultima que se pide es la que queda.
const chains = new Map();

/** Escribe un archivo de forma atomica, solo legible por el usuario (0600 fuera de Windows). */
function writePrivate(file, data) {
  const prev = chains.get(file) || Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(async () => {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`;
      try {
        await fsp.writeFile(tmp, data, { mode: 0o600 });
        await renameRetry(tmp, file);
      } catch (err) {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
      if (process.platform !== 'win32') await fsp.chmod(file, 0o600).catch(() => {});
    });
  const tail = next.catch(() => {});
  chains.set(file, tail);
  tail.then(() => {
    if (chains.get(file) === tail) chains.delete(file);
  });
  return next;
}

// Herramientas de Windows con ruta completa (en el PATH puede haber otro "whoami", por ejemplo el de Git).
const sys32 = (exe) => path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', exe);

let sidCache;
async function currentSid() {
  if (sidCache !== undefined) return sidCache;
  const r = await exec(sys32('whoami.exe'), ['/user', '/fo', 'csv', '/nh']);
  const m = /"(S-1-[\d-]+)"/.exec(r.stdout);
  sidCache = m ? m[1] : null;
  return sidCache;
}

/** Crea la carpeta del MCP y la deja privada para el usuario (una sola vez: marca .private). */
async function ensurePrivateDir(dir) {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  if (fs.existsSync(path.join(dir, MARKER))) return true;
  let ok = true;
  if (process.platform === 'win32') {
    const sid = await currentSid();
    const r = sid ? await exec(sys32('icacls.exe'), [dir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`]) : { ok: false };
    if (!r.ok) {
      ok = false;
      if (sid) await exec(sys32('icacls.exe'), [dir, '/reset', '/T']);
    }
  } else {
    await fsp.chmod(dir, 0o700).catch(() => {
      ok = false;
    });
  }
  try {
    await fsp.writeFile(path.join(dir, MARKER), 'Venus Launcher: carpeta privada del MCP\n');
  } catch {
    // Nunca dejar la carpeta inaccesible: se vuelve a la herencia normal
    ok = false;
    if (process.platform === 'win32') await exec(sys32('icacls.exe'), [dir, '/reset', '/T']);
  }
  return ok;
}

/** Copia el puente al lado de bridge.json si cambio (el original esta dentro del .asar). */
async function installBridge(src, dest) {
  const want = await fsp.readFile(src);
  let have = null;
  try {
    have = await fsp.readFile(dest);
  } catch {
    have = null;
  }
  if (have && have.equals(want)) return { path: dest, changed: false };
  await writePrivate(dest, want);
  return { path: dest, changed: true };
}

module.exports = { writePrivate, ensurePrivateDir, installBridge, renameRetry };
