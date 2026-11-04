'use strict';
// Sigue la ventana del juego (solo Windows), con la misma idea que ingame/window.js: un PowerShell oculto busca
// la ventana del proceso del juego (clase GLFW o LWJGL; si no hay, la ventana visible mas grande de ese proceso)
// y escribe una linea JSON cuando cambia algo: rectangulo del area de juego en pixeles fisicos (el hilo es
// consciente de la escala de cada monitor), si esta minimizada, que ventana esta en primer plano y si ocupa
// todo el monitor. Sondea unas 4 veces por segundo (mas rapido mientras la ventana se mueve) y termina solo
// cuando se cierra el juego o el launcher. Por su entrada recibe una orden: "front <hwnd>" pone esa ventana adelante
// (al abrir un panel del overlay y al volver al juego). Sin Electron: lo prueban las pruebas con un spawn falso.
const { spawn } = require('child_process');
const { parseLine } = require('./geometry');

const WAIT_WINDOW_MIN = 15; // los modpacks grandes tardan en abrir la ventana

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
public static class VenusOverlayTracker {
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);

  static bool Alive(IntPtr p) { return p != IntPtr.Zero && WaitForSingleObject(p, 0) != 0; }

  // Windows solo deja cambiar la ventana de adelante a quien tiene el foco: se engancha un momento a ese hilo.
  static void Front(IntPtr h) {
    if (!IsWindow(h)) return;
    if (IsIconic(h)) ShowWindow(h, 9);
    uint other;
    uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out other);
    uint me = GetCurrentThreadId();
    bool attached = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);
    SetForegroundWindow(h);
    if (attached) AttachThreadInput(me, fgThread, false);
  }

  // Ordenes por la entrada estandar (hilo aparte: el bucle de abajo no se detiene). Sin entrada, termina y listo.
  static void ReadOrders() {
    try {
      string line;
      while ((line = Console.In.ReadLine()) != null) {
        if (!line.StartsWith("front ")) continue;
        long hwnd;
        if (long.TryParse(line.Substring(6).Trim(), out hwnd) && hwnd != 0) Front(new IntPtr(hwnd));
      }
    } catch (Exception) { }
  }

  static IntPtr Find(uint pid) {
    IntPtr game = IntPtr.Zero, big = IntPtr.Zero;
    long bigArea = 0;
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      uint p;
      GetWindowThreadProcessId(h, out p);
      if (p != pid || !IsWindowVisible(h)) return true;
      StringBuilder c = new StringBuilder(64);
      GetClassName(h, c, 64);
      string cls = c.ToString();
      if (cls.StartsWith("GLFW") || cls == "LWJGL") { game = h; return false; }
      RECT r;
      if (GetWindow(h, 4) == IntPtr.Zero && GetClientRect(h, out r)) {
        long area = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
        if (r.Right - r.Left >= 200 && r.Bottom - r.Top >= 150 && area > bigArea) { big = h; bigArea = area; }
      }
      return true;
    }, IntPtr.Zero);
    return game != IntPtr.Zero ? game : big;
  }

  static string Describe(IntPtr h) {
    bool min = IsIconic(h);
    RECT r; GetClientRect(h, out r);
    POINT o = new POINT(); ClientToScreen(h, ref o);
    int w = r.Right - r.Left, ht = r.Bottom - r.Top;
    int full = 0;
    MONITORINFO mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
    if (!min && GetMonitorInfo(MonitorFromWindow(h, 2), ref mi)) {
      if (o.X <= mi.rcMonitor.Left && o.Y <= mi.rcMonitor.Top && o.X + w >= mi.rcMonitor.Right && o.Y + ht >= mi.rcMonitor.Bottom) full = 1;
    }
    uint dpi = 96;
    try { dpi = GetDpiForWindow(h); } catch (Exception) { }
    return "{\"ok\":1,\"hwnd\":" + h.ToInt64() + ",\"fgw\":" + GetForegroundWindow().ToInt64() +
      ",\"x\":" + o.X + ",\"y\":" + o.Y + ",\"w\":" + w + ",\"h\":" + ht +
      ",\"min\":" + (min ? 1 : 0) + ",\"vis\":" + (IsWindowVisible(h) ? 1 : 0) + ",\"full\":" + full + ",\"dpi\":" + dpi + "}";
  }

  public static void Run(uint gamePid, uint parentPid, int waitMinutes) {
    try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch (Exception) { }
    Console.Out.Flush();
    Thread orders = new Thread(ReadOrders);
    orders.IsBackground = true;
    orders.Start();
    IntPtr game = OpenProcess(0x00100000, false, gamePid);
    IntPtr parent = parentPid > 0 ? OpenProcess(0x00100000, false, parentPid) : IntPtr.Zero;
    DateTime deadline = DateTime.UtcNow.AddMinutes(waitMinutes);
    IntPtr h = IntPtr.Zero;
    string last = null;
    DateTime sent = DateTime.MinValue;
    int fast = 0;
    while (Alive(game) && (parentPid == 0 || Alive(parent))) {
      if (h == IntPtr.Zero || !IsWindow(h)) h = Find(gamePid);
      if (h == IntPtr.Zero && DateTime.UtcNow > deadline) break;
      string line = h == IntPtr.Zero ? "{\"ok\":0}" : Describe(h);
      if (line != last || (DateTime.UtcNow - sent).TotalMilliseconds > 2000) {
        if (line != last && last != null) fast = 5;
        Console.Out.WriteLine(line);
        Console.Out.Flush();
        last = line;
        sent = DateTime.UtcNow;
      }
      int wait = h == IntPtr.Zero ? 1000 : (fast > 0 ? 70 : 250);
      if (fast > 0) fast--;
      Thread.Sleep(wait);
    }
    Console.Out.WriteLine("{\"end\":1}");
    Console.Out.Flush();
  }
}
'@
[VenusOverlayTracker]::Run([uint32]$env:VENUS_GAME_PID, [uint32]$env:VENUS_PARENT_PID, [int]$env:VENUS_WAIT_MIN)
`;

// Programa, argumentos y entorno del ayudante (aparte, para que las pruebas los revisen sin abrir nada).
function command({ pid, parentPid = process.pid }) {
  return {
    file: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', SCRIPT],
    env: { ...process.env, VENUS_GAME_PID: String(pid), VENUS_PARENT_PID: String(parentPid || 0), VENUS_WAIT_MIN: String(WAIT_WINDOW_MIN) },
  };
}

// Abre el ayudante para un juego en marcha. onUpdate(info) con cada linea valida (ver geometry.parseLine),
// onEnd() una sola vez cuando termina. Devuelve { stop() } o null si no corresponde (otro sistema, pid malo).
function track({ pid, parentPid, onUpdate, onEnd, platform = process.platform, spawnFn = spawn }) {
  if (platform !== 'win32' || !Number.isInteger(pid) || pid <= 0) return null;
  const cmd = command({ pid, parentPid });
  let child;
  try {
    child = spawnFn(cmd.file, cmd.args, { env: cmd.env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
  let ended = false;
  let buf = '';
  const finish = () => {
    if (ended) return;
    ended = true;
    try {
      onEnd?.();
    } catch (err) {
      console.warn('[overlay] fin del seguimiento', err?.message || err);
    }
  };
  child.stdout?.setEncoding?.('utf8');
  child.stdout?.on('data', (chunk) => {
    buf += chunk;
    if (buf.length > 65536) buf = buf.slice(-4096); // nunca deberia pasar: lineas cortas
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const info = parseLine(line);
      if (!info) continue;
      if (info.end) finish();
      else onUpdate?.(info);
    }
  });
  child.on?.('error', finish);
  child.on?.('exit', finish);
  child.stdin?.on?.('error', () => {}); // el ayudante pudo terminar justo antes de escribirle
  return {
    // Pone adelante una ventana (el juego, o el overlay si Windows no le dio el foco). hwnd: el texto que dio el ayudante.
    front(hwnd) {
      if (ended || !/^-?\d{1,20}$/.test(String(hwnd))) return false;
      try {
        return Boolean(child.stdin?.write?.(`front ${hwnd}\n`));
      } catch {
        return false;
      }
    },
    stop() {
      ended = true;
      try {
        child.kill();
      } catch {
        /* ya termino */
      }
    },
  };
}

module.exports = { track, command, SCRIPT, WAIT_WINDOW_MIN };
