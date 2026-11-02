'use strict';
// Ayudante de Música (solo Windows): un PowerShell oculto que queda abierto mientras hace falta. Lee los
// controles multimedia de Windows (SMTC: Spotify gratis o Premium, YouTube Music, Apple Music, navegadores...)
// y el mezclador de volumen (Core Audio), escribe una línea JSON por mensaje en stdout y recibe comandos, también
// de a una línea JSON, por stdin. Se cierra solo si se cierra stdin o desaparece el launcher (VENUS_PARENT_PID).
//
// Mensajes (ayudante -> launcher), solo cuando algo cambió:
//   { t: 'ready', v, smtc, audio, thumbs, error? }   smtc false = este Windows no tiene SMTC (el ayudante termina)
//   { t: 'sessions', system, list: [{ id, app, title, artist, album, key, status, position, start, end, updated,
//       canPlay, canPause, canToggle, canNext, canPrev, canSeek }] }   tiempos en ms; updated = epoch ms
//   { t: 'art', id, key, data }   portada chica (data:image/jpeg;base64 de 20 KB como mucho) o null
//   { t: 'audio', list: [{ pid, exe, pkg, volume (0 a 1), muted, active }] }   sesiones del mezclador
//   { t: 'result', req, ok, error? }   respuesta a un comando con req
//   { t: 'log', msg }
// Comandos (launcher -> ayudante): { req, cmd: play | pause | toggle | next | prev | stop | seek (position, ms
//   en la línea de tiempo de la sesión) , id } · { req, cmd: setVolume, pids, volume } · { req, cmd: setMute,
//   pids, muted } · { cmd: poll } (manda todo de nuevo) · { cmd: ping } · { cmd: quit }
//
// La parte de SMTC es PowerShell (tipos de WinRT con ContentType=WindowsRuntime); el volumen y la portada son C#
// compilado al vuelo con Add-Type (COM de Core Audio y CreateStreamOverRandomAccessStream de shcore), así no
// hace falta ninguna dependencia. El script viaja como argumento de -Command y el C# en una variable de entorno
// (ver command()).

const fs = require('fs');
const path = require('path');

const PROTOCOL_VERSION = 1;
const ART_SIZE = 192; // px de la portada (se achica sola hasta entrar en el límite)
const ART_MAX_CHARS = 20 * 1024; // largo máximo del data: URL

const CSHARP = String.raw`
using System;
using System.IO;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
namespace VenusNp {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class DevEnumCo { }
  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IDevEnum { [PreserveSig] int EnumAudioEndpoints(int flow, int mask, out IDevList list); }
  [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IDevList { [PreserveSig] int GetCount(out int n); [PreserveSig] int Item(int i, out IDev d); }
  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IDev { [PreserveSig] int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); }
  [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ISessMgr {
    [PreserveSig] int GetAudioSessionControl(IntPtr a, int b, out IntPtr c);
    [PreserveSig] int GetSimpleAudioVolume(IntPtr a, int b, out IntPtr c);
    [PreserveSig] int GetSessionEnumerator(out ISessList e);
  }
  [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ISessList { [PreserveSig] int GetCount(out int n); [PreserveSig] int GetSession(int i, out ISess s); }
  [ComImport, Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ISess {
    [PreserveSig] int GetState(out int s);
    [PreserveSig] int GetDisplayName(out IntPtr n);
    [PreserveSig] int SetDisplayName(IntPtr a, IntPtr b);
    [PreserveSig] int GetIconPath(out IntPtr p);
    [PreserveSig] int SetIconPath(IntPtr a, IntPtr b);
    [PreserveSig] int GetGroupingParam(out Guid g);
    [PreserveSig] int SetGroupingParam(IntPtr a, IntPtr b);
    [PreserveSig] int RegisterAudioSessionNotification(IntPtr n);
    [PreserveSig] int UnregisterAudioSessionNotification(IntPtr n);
    [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetSessionInstanceIdentifier(out IntPtr id);
    [PreserveSig] int GetProcessId(out int pid);
    [PreserveSig] int IsSystemSoundsSession();
  }
  [ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IVol {
    [PreserveSig] int SetMasterVolume(float l, ref Guid c);
    [PreserveSig] int GetMasterVolume(out float l);
    [PreserveSig] int SetMute(int m, ref Guid c);
    [PreserveSig] int GetMute(out int m);
  }
  public class AudioSession { public int Pid; public string Exe; public string Pkg; public float Volume; public bool Muted; public int State; }
  delegate void Visit(ISess s, IVol v, int pid);
  public static class Audio {
    static void Release(object o) { try { if (o != null && Marshal.IsComObject(o)) Marshal.ReleaseComObject(o); } catch { } }
    // Recorre las sesiones de todas las salidas de audio activas (no solo la predeterminada)
    static void Each(Visit fn) {
      object co = new DevEnumCo();
      IDevList devs = null;
      try {
        if (((IDevEnum)co).EnumAudioEndpoints(0, 1, out devs) != 0 || devs == null) return;
        int n; devs.GetCount(out n);
        Guid iid = typeof(ISessMgr).GUID;
        for (int i = 0; i < n; i++) {
          IDev dev = null; object o = null; ISessList list = null;
          try {
            if (devs.Item(i, out dev) != 0 || dev == null) continue;
            if (dev.Activate(ref iid, 23, IntPtr.Zero, out o) != 0 || o == null) continue;
            if (((ISessMgr)o).GetSessionEnumerator(out list) != 0 || list == null) continue;
            int c; list.GetCount(out c);
            for (int j = 0; j < c; j++) {
              ISess s = null;
              try {
                if (list.GetSession(j, out s) != 0 || s == null) continue;
                if (s.IsSystemSoundsSession() == 0) continue;
                int pid; s.GetProcessId(out pid);
                IVol v = s as IVol;
                if (pid <= 0 || v == null) continue;
                fn(s, v, pid);
              } catch { } finally { Release(s); }
            }
          } catch { } finally { Release(list); Release(o); Release(dev); }
        }
      } finally { Release(devs); Release(co); }
    }
    // Ejecutable y paquete de la Tienda a partir del identificador de la sesión (sin mandar la ruta completa)
    static void Describe(string id, int pid, AudioSession a) {
      a.Exe = ""; a.Pkg = "";
      string path = "";
      if (id != null) {
        int bar = id.IndexOf('|');
        int end = id.IndexOf("%b", StringComparison.Ordinal);
        if (bar >= 0) path = end > bar ? id.Substring(bar + 1, end - bar - 1) : id.Substring(bar + 1);
      }
      if (path.Length > 0) {
        int slash = path.LastIndexOf('\\');
        a.Exe = slash >= 0 ? path.Substring(slash + 1) : path;
        int w = path.IndexOf("WindowsApps", StringComparison.OrdinalIgnoreCase);
        if (w >= 0) {
          string rest = path.Substring(w + 11).TrimStart('\\');
          int s2 = rest.IndexOf('\\');
          a.Pkg = s2 > 0 ? rest.Substring(0, s2) : rest;
        }
      }
      if (a.Exe.Length == 0) { try { a.Exe = System.Diagnostics.Process.GetProcessById(pid).ProcessName + ".exe"; } catch { } }
    }
    public static List<AudioSession> List() {
      var res = new List<AudioSession>();
      Each(delegate (ISess s, IVol v, int pid) {
        var a = new AudioSession();
        a.Pid = pid;
        int st; s.GetState(out st); a.State = st;
        float lv; v.GetMasterVolume(out lv); a.Volume = lv;
        int m; v.GetMute(out m); a.Muted = m != 0;
        string id = null;
        try { s.GetSessionIdentifier(out id); } catch { }
        Describe(id, pid, a);
        res.Add(a);
      });
      return res;
    }
    public static int SetVolume(int[] pids, float level) {
      if (level < 0) level = 0;
      if (level > 1) level = 1;
      var set = new HashSet<int>(pids ?? new int[0]);
      int n = 0;
      Each(delegate (ISess s, IVol v, int pid) { if (set.Contains(pid)) { Guid g = Guid.Empty; if (v.SetMasterVolume(level, ref g) == 0) n++; } });
      return n;
    }
    public static int SetMute(int[] pids, bool mute) {
      var set = new HashSet<int>(pids ?? new int[0]);
      int n = 0;
      Each(delegate (ISess s, IVol v, int pid) { if (set.Contains(pid)) { Guid g = Guid.Empty; if (v.SetMute(mute ? 1 : 0, ref g) == 0) n++; } });
      return n;
    }
  }
  public static class Thumb {
    [DllImport("shcore.dll")] static extern int CreateStreamOverRandomAccessStream([MarshalAs(UnmanagedType.IUnknown)] object ras, ref Guid iid, out IntPtr stream);
    static byte[] Read(object ras) {
      Guid iid = new Guid("0000000c-0000-0000-C000-000000000046");
      IntPtr p;
      if (CreateStreamOverRandomAccessStream(ras, ref iid, out p) != 0 || p == IntPtr.Zero) return null;
      var s = (System.Runtime.InteropServices.ComTypes.IStream)Marshal.GetObjectForIUnknown(p);
      Marshal.Release(p);
      var ms = new MemoryStream();
      var buf = new byte[65536];
      IntPtr read = Marshal.AllocHGlobal(4);
      try {
        while (ms.Length < 8 * 1024 * 1024) {
          s.Read(buf, buf.Length, read);
          int n = Marshal.ReadInt32(read);
          if (n <= 0) break;
          ms.Write(buf, 0, n);
        }
      } finally { Marshal.FreeHGlobal(read); try { Marshal.ReleaseComObject(s); } catch { } }
      return ms.ToArray();
    }
    static string Encode(Image src, int size, long quality, ImageCodecInfo enc) {
      using (var bmp = new Bitmap(size, size)) {
        using (var g = Graphics.FromImage(bmp)) {
          g.Clear(Color.Black);
          g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
          int side = Math.Min(src.Width, src.Height);
          var rect = new Rectangle((src.Width - side) / 2, (src.Height - side) / 2, side, side);
          g.DrawImage(src, new Rectangle(0, 0, size, size), rect, GraphicsUnit.Pixel);
        }
        var ep = new EncoderParameters(1);
        ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
        using (var outs = new MemoryStream()) { bmp.Save(outs, enc, ep); return Convert.ToBase64String(outs.ToArray()); }
      }
    }
    // Portada cuadrada en JPEG como data: URL de maxChars caracteres como mucho (o null)
    public static string Make(object ras, int size, int maxChars) {
      byte[] data = Read(ras);
      if (data == null || data.Length == 0) return null;
      ImageCodecInfo enc = null;
      foreach (var c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") enc = c;
      if (enc == null) return null;
      using (var src = Image.FromStream(new MemoryStream(data))) {
        if (src.Width < 1 || src.Height < 1) return null;
        int[] sizes = { size, 160, 128, 96 };
        long[] qs = { 80, 70, 60, 50 };
        foreach (int sz in sizes) foreach (long q in qs) {
          string b64 = Encode(src, sz, q, enc);
          if (b64.Length + 23 <= maxChars) return "data:image/jpeg;base64," + b64;
        }
      }
      return null;
    }
  }
}
`;

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding $false
try { [Console]::OutputEncoding = $utf8 } catch { }
$out = [Console]::Out
function Send($o) { $out.WriteLine((ConvertTo-Json -InputObject $o -Compress -Depth 6)); $out.Flush() }
$lastLog = @{}
function Log([string]$where, $err) {
  $now = [DateTime]::UtcNow
  if ($script:lastLog[$where] -and ($now - $script:lastLog[$where]).TotalSeconds -lt 30) { return }
  $script:lastLog[$where] = $now
  $msg = [string]$err
  if ($err -is [System.Management.Automation.ErrorRecord]) { $msg = [string]$err.Exception.Message }
  if ($msg.Length -gt 240) { $msg = $msg.Substring(0, 240) }
  Send @{ t = 'log'; msg = ($where + ': ' + $msg) }
}

$audioOk = $false
try {
  Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition $env:VENUS_NP_CS
  $audioOk = $true
} catch { Log 'compile' $_ }

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -match '^IAsyncOperation.1$' } | Select-Object -First 1
  $mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
  $propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
  $rasType = [Windows.Storage.Streams.IRandomAccessStreamWithContentType]
  function Await($op, [Type]$type, [int]$ms) {
    $task = $script:asTask.MakeGenericMethod($type).Invoke($null, @($op))
    if (-not $task.Wait($ms)) { return $null }
    return $task.Result
  }
  $mgr = Await ($mgrType::RequestAsync()) $mgrType 10000
  if ($null -eq $mgr) { throw 'RequestAsync' }
} catch {
  Send @{ t = 'ready'; v = [int]$env:VENUS_NP_VERSION; smtc = $false; audio = $audioOk; thumbs = $false; error = [string]$_.Exception.Message }
  exit 3
}
Send @{ t = 'ready'; v = [int]$env:VENUS_NP_VERSION; smtc = $true; audio = $audioOk; thumbs = $audioOk }

$artSize = [int]$env:VENUS_NP_ART_SIZE
$artMax = [int]$env:VENUS_NP_ART_MAX
$art = @{}
$lastSessions = ''
$lastAudio = ''
$hasSessions = $false

function Ms($dto) { try { return [long]$dto.ToUnixTimeMilliseconds() } catch { return [long]0 } }

# Sesiones con un id estable: el AppUserModelId de la app (y #2, #3... si la misma app tiene varias)
function Sessions {
  $list = New-Object System.Collections.ArrayList
  $seen = @{}
  foreach ($s in $script:mgr.GetSessions()) {
    $app = [string]$s.SourceAppUserModelId
    $n = 1 + [int]$seen[$app]
    $seen[$app] = $n
    $id = $app
    if ($n -gt 1) { $id = $app + '#' + $n }
    [void]$list.Add(@{ id = $id; app = $app; s = $s })
  }
  return ,$list
}

function FindSession([string]$id) {
  foreach ($it in (Sessions)) { if ($it.id -eq $id) { return $it.s } }
  return $null
}

# Portada: al cambiar de canción y otra vez a los 1,5 y 4,5 s (las apps a veces actualizan la imagen después)
function ArtCheck($it, $mp, [string]$key) {
  $now = [DateTime]::UtcNow
  $a = $script:art[$it.id]
  if ($null -eq $a -or $a.key -ne $key) {
    $a = @{ key = $key; tries = 0; next = $now; last = $null }
    $script:art[$it.id] = $a
  }
  if ($a.tries -ge 3 -or $now -lt $a.next) { return }
  $a.tries = $a.tries + 1
  $a.next = $now.AddMilliseconds(1500 * $a.tries)
  $data = $null
  if ($script:audioOk -and $mp -and $mp.Thumbnail) {
    try {
      $ras = Await ($mp.Thumbnail.OpenReadAsync()) $script:rasType 2500
      if ($ras) {
        $data = [VenusNp.Thumb]::Make($ras, $script:artSize, $script:artMax)
        try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($ras) } catch { }
      }
    } catch { Log 'art' $_ }
  }
  if ($a.tries -eq 1 -or $data -ne $a.last) {
    $a.last = $data
    Send @{ t = 'art'; id = $it.id; key = $key; data = $data }
  }
}

function Poll {
  $items = Sessions
  $cur = $null
  try { $cur = $script:mgr.GetCurrentSession() } catch { }
  $system = ''
  $arr = New-Object System.Collections.ArrayList
  $ids = @{}
  foreach ($it in $items) {
    $s = $it.s
    $ids[$it.id] = $true
    if ($cur -and -not $system -and ([object]::ReferenceEquals($cur, $s) -or [string]$cur.SourceAppUserModelId -eq $it.app)) { $system = $it.id }
    $info = $null; $tl = $null; $mp = $null
    try { $info = $s.GetPlaybackInfo() } catch { }
    try { $tl = $s.GetTimelineProperties() } catch { }
    try { $mp = Await ($s.TryGetMediaPropertiesAsync()) $script:propsType 2000 } catch { }
    $title = ''; $artist = ''; $album = ''
    if ($mp) {
      $title = [string]$mp.Title
      $artist = [string]$mp.Artist
      $album = [string]$mp.AlbumTitle
      if (-not $artist) { $artist = [string]$mp.AlbumArtist }
    }
    $key = '{0:x8}' -f ($it.app + '|' + $title + '|' + $artist + '|' + $album).GetHashCode()
    $o = @{ id = $it.id; app = $it.app; title = $title; artist = $artist; album = $album; key = $key; status = -1 }
    if ($info) {
      $o.status = [int]$info.PlaybackStatus
      $c = $info.Controls
      if ($c) {
        $o.canPlay = [bool]$c.IsPlayEnabled
        $o.canPause = [bool]$c.IsPauseEnabled
        $o.canToggle = [bool]$c.IsPlayPauseToggleEnabled
        $o.canNext = [bool]$c.IsNextEnabled
        $o.canPrev = [bool]$c.IsPreviousEnabled
        $o.canSeek = [bool]$c.IsPlaybackPositionEnabled
      }
    }
    if ($tl) {
      $o.position = [long]$tl.Position.TotalMilliseconds
      $o.start = [long]$tl.StartTime.TotalMilliseconds
      $o.end = [long]$tl.EndTime.TotalMilliseconds
      $o.updated = Ms $tl.LastUpdatedTime
    }
    [void]$arr.Add($o)
    try { ArtCheck $it $mp $key } catch { Log 'art' $_ }
  }
  foreach ($k in @($script:art.Keys)) { if (-not $ids[$k]) { $script:art.Remove($k) } }
  $script:hasSessions = $arr.Count -gt 0
  $json = ConvertTo-Json -InputObject @{ t = 'sessions'; system = $system; list = $arr } -Compress -Depth 5
  if ($json -ne $script:lastSessions) {
    $script:lastSessions = $json
    $out.WriteLine($json)
    $out.Flush()
  }
}

function PollAudio {
  if (-not $script:audioOk) { return }
  $arr = New-Object System.Collections.ArrayList
  foreach ($a in [VenusNp.Audio]::List()) {
    [void]$arr.Add(@{ pid = $a.Pid; exe = $a.Exe; pkg = $a.Pkg; volume = [Math]::Round([double]$a.Volume, 3); muted = $a.Muted; active = ($a.State -eq 1) })
  }
  $json = ConvertTo-Json -InputObject @{ t = 'audio'; list = $arr } -Compress -Depth 4
  if ($json -ne $script:lastAudio) {
    $script:lastAudio = $json
    $out.WriteLine($json)
    $out.Flush()
  }
}

function Handle([string]$line) {
  $m = $null
  try { $m = ConvertFrom-Json $line } catch { return }
  if ($null -eq $m -or -not $m.cmd) { return }
  $req = $m.req
  $ok = $false
  $err = $null
  try {
    switch ([string]$m.cmd) {
      'quit' { exit 0 }
      'ping' { $ok = $true }
      'poll' {
        $script:lastSessions = ''; $script:lastAudio = ''
        foreach ($a in $script:art.Values) { $a.tries = 0; $a.next = [DateTime]::MinValue }
        $script:nextPoll = [DateTime]::MinValue; $script:nextAudio = [DateTime]::MinValue
        $ok = $true
      }
      'setVolume' {
        if (-not $script:audioOk) { $err = 'noAudio' }
        else {
          $ok = [VenusNp.Audio]::SetVolume([int[]]@($m.pids), [float]$m.volume) -gt 0
          if (-not $ok) { $err = 'noAudio' }
          $script:nextAudio = [DateTime]::MinValue
        }
      }
      'setMute' {
        if (-not $script:audioOk) { $err = 'noAudio' }
        else {
          $ok = [VenusNp.Audio]::SetMute([int[]]@($m.pids), [bool]$m.muted) -gt 0
          if (-not $ok) { $err = 'noAudio' }
          $script:nextAudio = [DateTime]::MinValue
        }
      }
      default {
        $s = FindSession ([string]$m.id)
        if ($null -eq $s) { $err = 'noSession' }
        else {
          $op = $null
          switch ([string]$m.cmd) {
            'play' { $op = $s.TryPlayAsync() }
            'pause' { $op = $s.TryPauseAsync() }
            'toggle' { $op = $s.TryTogglePlayPauseAsync() }
            'next' { $op = $s.TrySkipNextAsync() }
            'prev' { $op = $s.TrySkipPreviousAsync() }
            'stop' { $op = $s.TryStopAsync() }
            'seek' { $op = $s.TryChangePlaybackPositionAsync([long]([double]$m.position * 10000)) }
          }
          if ($null -eq $op) { $err = 'badCommand' }
          else {
            $r = Await $op ([bool]) 4000
            $ok = ($r -eq $true)
            if (-not $ok) { $err = 'rejected' }
          }
          $script:nextPoll = [DateTime]::UtcNow.AddMilliseconds(150)
        }
      }
    }
  } catch { $err = 'failed'; Log 'command' $_ }
  if ($null -ne $req) { Send @{ t = 'result'; req = $req; ok = $ok; error = $err } }
}

$stdin = New-Object System.IO.StreamReader -ArgumentList ([Console]::OpenStandardInput()), $utf8
$pending = $stdin.ReadLineAsync()
$parentPid = [int]$env:VENUS_PARENT_PID
$nextPoll = [DateTime]::MinValue
$nextAudio = [DateTime]::MinValue
$nextParent = [DateTime]::UtcNow.AddSeconds(5)
while ($true) {
  $now = [DateTime]::UtcNow
  if ($now -ge $nextPoll) {
    try { Poll } catch { Log 'poll' $_ }
    $nextPoll = [DateTime]::UtcNow.AddMilliseconds($(if ($hasSessions) { 1000 } else { 2000 }))
  }
  if ($now -ge $nextAudio) {
    try { PollAudio } catch { Log 'audio' $_ }
    $nextAudio = [DateTime]::UtcNow.AddMilliseconds(2000)
  }
  if ($now -ge $nextParent) {
    $nextParent = $now.AddSeconds(5)
    if ($parentPid -gt 0) { try { [void][System.Diagnostics.Process]::GetProcessById($parentPid) } catch { exit 0 } }
  }
  $left = [Math]::Min(($nextPoll - [DateTime]::UtcNow).TotalMilliseconds, ($nextAudio - [DateTime]::UtcNow).TotalMilliseconds)
  $wait = [int][Math]::Max(15, [Math]::Min(2000, $left))
  $done = $false
  try { $done = $pending.Wait($wait) } catch { exit 0 }
  if ($done) {
    $line = $pending.Result
    if ($null -eq $line) { exit 0 }
    if ($line.Length -gt 0 -and $line.Length -lt 8192) { Handle $line }
    $pending = $stdin.ReadLineAsync()
  }
}
`;

// PowerShell de Windows por su ruta completa (no el primero que aparezca en el PATH o en la carpeta actual)
function powershellPath(env = process.env, exists = fs.existsSync) {
  const root = env.SystemRoot || env.windir || env.SYSTEMROOT;
  if (root) {
    const full = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    try {
      if (exists(full)) return full;
    } catch {
      /* se usa el del PATH */
    }
  }
  return 'powershell.exe';
}

// Programa, argumentos y entorno del ayudante (aparte, para que las pruebas los revisen sin abrir nada).
// El C# va en una variable de entorno: así el argumento de -Command queda chico y sin barras invertidas.
function command({ parentPid = process.pid, env = process.env, exists = fs.existsSync } = {}) {
  return {
    file: powershellPath(env, exists),
    args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', SCRIPT],
    env: {
      ...env,
      VENUS_PARENT_PID: String(parentPid),
      VENUS_NP_VERSION: String(PROTOCOL_VERSION),
      VENUS_NP_ART_SIZE: String(ART_SIZE),
      VENUS_NP_ART_MAX: String(ART_MAX_CHARS),
      VENUS_NP_CS: CSHARP,
    },
  };
}

module.exports = { command, powershellPath, SCRIPT, CSHARP, PROTOCOL_VERSION, ART_SIZE, ART_MAX_CHARS };
