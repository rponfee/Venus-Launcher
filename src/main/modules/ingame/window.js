'use strict';
// Icono y titulo de Venus en la ventana del juego (solo Windows). Minecraft no deja elegirlos desde la linea de
// comandos, asi que un PowerShell oculto busca la ventana del proceso del juego y le pone el icono del launcher y
// " · Venus Launcher" al final del titulo. El juego cambia el titulo al entrar a un mundo o a un servidor: el
// script lo vuelve a completar cada segundo y medio y termina solo cuando se cierra el juego.
const { spawn } = require('child_process');

const SUFFIX = ' · Venus Launcher';
const WAIT_WINDOW_MIN = 15; // los modpacks grandes tardan en abrir la ventana

// La ventana de Minecraft es de GLFW (1.13+) o de LWJGL 2 (versiones viejas). WM_SETICON = 0x80, WM_GETICON = 0x7F.
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class VenusGameWindow {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool SetWindowText(IntPtr h, string s);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr LoadImage(IntPtr i, string name, uint type, int cx, int cy, uint load);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  public static IntPtr Find(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      uint p;
      GetWindowThreadProcessId(h, out p);
      if (p != pid || !IsWindowVisible(h)) return true;
      StringBuilder c = new StringBuilder(64);
      GetClassName(h, c, 64);
      string cls = c.ToString();
      if (cls.StartsWith("GLFW") || cls == "LWJGL") { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static string Title(IntPtr h) {
    StringBuilder s = new StringBuilder(512);
    GetWindowText(h, s, 512);
    return s.ToString();
  }
}
'@
$gamePid = [uint32]$env:VENUS_GAME_PID
$suffix = $env:VENUS_TITLE_SUFFIX
$big = [IntPtr]::Zero
$small = [IntPtr]::Zero
if ($env:VENUS_ICON -and (Test-Path -LiteralPath $env:VENUS_ICON)) {
  $big = [VenusGameWindow]::LoadImage([IntPtr]::Zero, $env:VENUS_ICON, 1, 64, 64, 0x10)
  $small = [VenusGameWindow]::LoadImage([IntPtr]::Zero, $env:VENUS_ICON, 1, 32, 32, 0x10)
}
$deadline = (Get-Date).AddMinutes([int]$env:VENUS_WAIT_MIN)
while ($true) {
  if (-not (Get-Process -Id $gamePid -ErrorAction SilentlyContinue)) { break }
  $h = [VenusGameWindow]::Find($gamePid)
  if ($h -ne [IntPtr]::Zero) {
    if ($big -ne [IntPtr]::Zero -and [VenusGameWindow]::SendMessage($h, 0x7F, [IntPtr]1, [IntPtr]::Zero) -ne $big) {
      [void][VenusGameWindow]::SendMessage($h, 0x80, [IntPtr]1, $big)
      [void][VenusGameWindow]::SendMessage($h, 0x80, [IntPtr]0, $small)
    }
    if ($suffix) {
      $title = [VenusGameWindow]::Title($h)
      if ($title -and -not $title.EndsWith($suffix)) { [void][VenusGameWindow]::SetWindowText($h, $title + $suffix) }
    }
  } elseif ((Get-Date) -gt $deadline) { break }
  Start-Sleep -Milliseconds 1500
}
`;

// Programa, argumentos y entorno del ayudante (aparte, para que las pruebas los revisen sin abrir nada).
function command({ pid, iconPath, title = true }) {
  return {
    file: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', SCRIPT],
    env: {
      ...process.env,
      VENUS_GAME_PID: String(pid),
      VENUS_ICON: iconPath || '',
      VENUS_TITLE_SUFFIX: title ? SUFFIX : '',
      VENUS_WAIT_MIN: String(WAIT_WINDOW_MIN),
    },
  };
}

// Abre el ayudante para un juego en marcha. Devuelve el proceso, o null si no corresponde.
function brand({ pid, iconPath, title = true, platform = process.platform, spawnFn = spawn }) {
  if (platform !== 'win32' || !Number.isInteger(pid) || pid <= 0) return null;
  if (!iconPath && !title) return null;
  const cmd = command({ pid, iconPath, title });
  try {
    const child = spawnFn(cmd.file, cmd.args, { env: cmd.env, windowsHide: true, stdio: 'ignore' });
    child.on?.('error', () => {});
    return child;
  } catch {
    return null;
  }
}

module.exports = { brand, command, SUFFIX, SCRIPT };
