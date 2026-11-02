'use strict';
// Busca la ventana del juego por el pid del proceso (solo Windows), como ingame/window.js: un PowerShell oculto
// recorre las ventanas visibles hasta encontrar la de GLFW (1.13+) o LWJGL (versiones viejas) de ese proceso,
// escribe su handle y termina. Con ese handle se arma el id de desktopCapturer ("window:<handle>:0").
// Si no aparece en WAIT_MIN minutos o el juego se cierra, termina sin escribir nada.
const { spawn } = require('child_process');

const WAIT_MIN = 15; // los modpacks grandes tardan en abrir la ventana

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class VenusCaptureWindow {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextLength(IntPtr h);
  public static long Find(uint pid, bool anyClass) {
    long found = 0;
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      uint p;
      GetWindowThreadProcessId(h, out p);
      if (p != pid || !IsWindowVisible(h)) return true;
      StringBuilder c = new StringBuilder(64);
      GetClassName(h, c, 64);
      string cls = c.ToString();
      if (cls.StartsWith("GLFW") || cls == "LWJGL" || (anyClass && GetWindowTextLength(h) > 0)) { found = h.ToInt64(); return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
$gamePid = [uint32]$env:VENUS_GAME_PID
$any = $env:VENUS_ANY_CLASS -eq '1'
$deadline = (Get-Date).AddMinutes([int]$env:VENUS_WAIT_MIN)
while ($true) {
  if (-not (Get-Process -Id $gamePid -ErrorAction SilentlyContinue)) { break }
  $h = [VenusCaptureWindow]::Find($gamePid, $any)
  if ($h -ne 0) { [Console]::Out.WriteLine("hwnd:$h"); break }
  if ((Get-Date) -gt $deadline) { break }
  Start-Sleep -Milliseconds 1500
}
`;

// Programa, argumentos y entorno (aparte, para que las pruebas los revisen sin abrir nada).
function command({ pid, anyClass = false, waitMin = WAIT_MIN }) {
  return {
    file: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', SCRIPT],
    env: { ...process.env, VENUS_GAME_PID: String(pid), VENUS_ANY_CLASS: anyClass ? '1' : '0', VENUS_WAIT_MIN: String(waitMin) },
  };
}

// Handle de la salida del script ("hwnd:123456") o null
function parseOutput(text) {
  const m = /hwnd:(\d{1,20})/.exec(String(text || ''));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

const sourceId = (hwnd) => `window:${hwnd}:0`;

/**
 * Espera la ventana del proceso. Devuelve { promise (handle o null), cancel() }.
 * anyClass: acepta cualquier ventana visible con titulo (para pruebas con otra aplicacion).
 */
function findWindow({ pid, anyClass = false, waitMin = WAIT_MIN, platform = process.platform, spawnFn = spawn }) {
  if (platform !== 'win32' || !Number.isInteger(pid) || pid <= 0) return { promise: Promise.resolve(null), cancel() {} };
  let child = null;
  let done = false;
  const promise = new Promise((resolve) => {
    const cmd = command({ pid, anyClass, waitMin });
    let out = '';
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    try {
      child = spawnFn(cmd.file, cmd.args, { env: cmd.env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      finish(null);
      return;
    }
    child.on?.('error', () => finish(null));
    child.stdout?.on?.('data', (d) => {
      out += String(d);
      const h = parseOutput(out);
      if (h) finish(h);
    });
    child.on?.('exit', () => finish(parseOutput(out)));
  });
  return {
    promise,
    cancel() {
      if (done) return;
      done = true;
      try {
        child?.kill?.();
      } catch {
        /* ya termino */
      }
    },
  };
}

// Respaldo por titulo: la ventana de Minecraft se llama "Minecraft 1.21.1", "Minecraft* 1.20.1 - Un jugador"...
// (ingame le agrega " · Venus Launcher" al final). Devuelve la fuente que mejor coincide o null.
function matchByTitle(sources, { suffix = ' · Venus Launcher' } = {}) {
  const list = Array.isArray(sources) ? sources : [];
  const named = (s) => String(s?.name || '');
  const game = (s) => /^Minecraft\*?\s+\d/i.test(named(s)); // "Minecraft 1.21.1...", nunca "Minecraft Launcher"
  return list.find((s) => game(s) && named(s).endsWith(suffix)) || list.find(game) || null;
}

module.exports = { findWindow, command, parseOutput, sourceId, matchByTitle, SCRIPT, WAIT_MIN };
