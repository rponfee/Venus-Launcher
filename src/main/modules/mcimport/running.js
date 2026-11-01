'use strict';
// ¿Hay un Minecraft abierto desde una carpeta? Sin Electron: lee la linea de comandos de los procesos de Java
// (el launcher oficial siempre pasa --gameDir) y la compara con las carpetas que se van a copiar. Es solo una
// consulta local (nada sale de la PC ni se guarda); si no se puede saber, devuelve null y la importacion sigue
// (los mundos abiertos se detectan igual por su session.lock al copiarlos).
const { execFile } = require('child_process');
const path = require('path');
const { samePath } = require('./scan');

// La salida en UTF-8: con la pagina de codigos de la consola, una ruta como C:\Users\José\... llega rota y no
// coincide con la carpeta que se va a copiar.
const PS_SCRIPT = "$ErrorActionPreference='SilentlyContinue'; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-CimInstance Win32_Process -Filter \"Name='javaw.exe' OR Name='java.exe'\" | ForEach-Object { $_.CommandLine }";

function execText(cmd, args, timeout) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout || '')));
    } catch {
      resolve(null);
    }
  });
}

// "--gameDir C:\x\.minecraft" o "--gameDir "C:\con espacios\.minecraft"" -> rutas (una por proceso).
function parseGameDirs(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /--gameDir(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(line);
    const dir = m && (m[1] || m[2] || m[3]);
    if (dir && dir.length <= 1024) out.push(dir);
  }
  return out;
}

/**
 * Carpetas de juego de los Minecraft abiertos, o null si no se pudo saber.
 * opts: { platform, exec(cmd, args, timeout) -> texto o null, timeout }
 */
async function gameDirsInUse({ platform = process.platform, exec = execText, timeout = 8000 } = {}) {
  const text = platform === 'win32' ? await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT], timeout) : await exec('ps', ['-axww', '-o', 'command='], timeout);
  if (text === null || text === undefined) return null;
  return parseGameDirs(text).map((d) => path.resolve(d));
}

// Primera carpeta de la lista que se esta usando (comparando rutas reales cuando se puede).
function findInUse(dirs, inUse, { platform = process.platform } = {}) {
  if (!Array.isArray(inUse) || !inUse.length) return null;
  return dirs.find((d) => inUse.some((u) => samePath(u, d, platform))) || null;
}

module.exports = { parseGameDirs, gameDirsInUse, findInUse, PS_SCRIPT };
