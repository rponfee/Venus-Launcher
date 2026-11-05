'use strict';
// Widget de rendimiento del overlay (3.1): RAM y CPU del proceso del juego, ping del servidor en el que esta
// jugando y tiempo de sesion, cada 2 segundos. Los FPS no se pueden medir desde afuera del juego: los informa el mod
// Venus Badge con un archivo (perfhistory/fps.js) y llegan por getFps; sin el mod no hay FPS.
//   createSampler({ pid, startedAt, getAddress, getFps, onSample, ... }) -> { stop() }
// En Windows abre un ayudante de PowerShell que queda vivo (Get-Process cada 2 s, sin WMI: barato) y escribe una
// linea JSON por muestra; en otros sistemas usa pidusage. El ping se mide con el Server List Ping de Multijugador
// (modules/serverlist) cada 10 s, solo si se sabe a que servidor entro (core/game activity).
// Las cuentas (buildSample, parseHelperLine) no dependen de Electron: las prueban overlay/test/perf.test.js.
const { spawn } = require('child_process');

const INTERVAL_MS = 2000;
const PING_EVERY_MS = 10000;
const PING_STALE_MS = 60000;
const PING_TIMEOUT_MS = 8000;

// Ayudante: una linea JSON cada 2 s mientras el juego (y el launcher) sigan vivos. cpu10 = CPU en decimas de por
// ciento sobre todos los nucleos (-10 = todavia no se sabe). Los numeros van como enteros (sin coma decimal).
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$gamePid = [int]$env:VENUS_GAME_PID
$parentPid = [int]$env:VENUS_PARENT_PID
$cores = [Math]::Max(1, [Environment]::ProcessorCount)
$prevCpu = -1
$prevAt = [DateTime]::UtcNow
$out = [Console]::Out
while ($true) {
  try { $p = Get-Process -Id $gamePid -ErrorAction Stop } catch { break }
  if ($p.HasExited) { break }
  if ($parentPid -gt 0) { try { $null = Get-Process -Id $parentPid -ErrorAction Stop } catch { break } }
  $now = [DateTime]::UtcNow
  $cpuMs = -1
  try { $cpuMs = $p.TotalProcessorTime.TotalMilliseconds } catch { $cpuMs = -1 }
  $cpu10 = -10
  if ($cpuMs -ge 0 -and $prevCpu -ge 0) {
    $elapsed = ($now - $prevAt).TotalMilliseconds
    if ($elapsed -gt 0) { $cpu10 = [int][Math]::Round(($cpuMs - $prevCpu) / $elapsed / $cores * 1000) }
  }
  $prevCpu = $cpuMs
  $prevAt = $now
  $mem = [long]$p.WorkingSet64
  $out.WriteLine('{"ok":1,"mem":' + $mem + ',"cpu10":' + $cpu10 + '}')
  $out.Flush()
  Start-Sleep -Milliseconds ${INTERVAL_MS}
}
$out.WriteLine('{"end":1}')
$out.Flush()
`;

// Programa, argumentos y entorno del ayudante (aparte, para que las pruebas los revisen sin abrir nada).
function command({ pid, parentPid = process.pid }) {
  return {
    file: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', SCRIPT],
    env: { ...process.env, VENUS_GAME_PID: String(pid), VENUS_PARENT_PID: String(parentPid || 0) },
  };
}

// Linea JSON del ayudante -> { end: true } | { mem (bytes), cpu (0 a 100 o null) } | null si no sirve.
function parseHelperLine(line) {
  let d;
  try {
    d = JSON.parse(String(line).trim());
  } catch {
    return null;
  }
  if (!d || typeof d !== 'object') return null;
  if (d.end) return { end: true };
  if (!d.ok) return null;
  const mem = Number(d.mem);
  const cpu10 = Number(d.cpu10);
  return {
    mem: Number.isFinite(mem) && mem >= 0 ? mem : null,
    cpu: Number.isFinite(cpu10) && cpu10 >= 0 ? Math.min(100, cpu10 / 10) : null,
  };
}

// Medidas crudas -> evento del contrato 1 ({ kind: 'perf', fps?, ram (MB), cpu (%), ping (ms), session (s) }).
function buildSample({ mem, cpu, ping, fps, startedAt, now = Date.now() }) {
  const ram = Number.isFinite(mem) && mem >= 0 ? Math.round(mem / 1048576) : null;
  const c = Number.isFinite(cpu) && cpu >= 0 ? Math.min(100, Math.round(cpu * 10) / 10) : null;
  const p = Number.isFinite(ping) && ping >= 0 ? Math.round(ping) : null;
  const started = Number(startedAt);
  const session = Number.isFinite(started) && started > 0 ? Math.max(0, Math.floor((now - started) / 1000)) : null;
  const out = { kind: 'perf', ram, cpu: c, ping: p, session };
  if (Number.isFinite(fps) && fps >= 0) out.fps = Math.round(fps);
  return out;
}

// Ping del servidor con lo que usa Multijugador (Server List Ping). Devuelve ms o null.
async function pingServer(address) {
  let serverlist;
  try {
    serverlist = require('../serverlist');
  } catch {
    return null;
  }
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), PING_TIMEOUT_MS));
  try {
    const r = await Promise.race([serverlist.ping(address, { force: true }), timeout]);
    const ms = Number(r?.latency);
    return r?.online && Number.isFinite(ms) && ms >= 0 ? ms : null;
  } catch {
    return null;
  }
}

/**
 * Muestras cada 2 s del juego `pid`. getAddress() -> direccion del servidor actual o null; getFps() -> FPS o null;
 * onSample(evento).
 * Opcionales para las pruebas: platform, spawnFn, pingFn, usage (pidusage), now, interval.
 */
function createSampler({ pid, startedAt, parentPid, getAddress, getFps, onSample, platform = process.platform, spawnFn = spawn, pingFn = pingServer, usage, now = Date.now, interval = INTERVAL_MS }) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  let stopped = false;
  let ended = false; // el ayudante aviso que el juego termino
  let child = null;
  let timer = null;
  let last = { mem: null, cpu: null };
  let ping = { address: null, ms: null, at: 0, busy: false };

  const emit = () => {
    if (stopped) return;
    const address = typeof getAddress === 'function' ? getAddress() : null;
    const fresh = address && ping.address === address && now() - ping.at < PING_STALE_MS ? ping.ms : null;
    try {
      const fps = typeof getFps === 'function' ? getFps() : null;
      onSample?.(buildSample({ mem: last.mem, cpu: last.cpu, ping: fresh, fps, startedAt, now: now() }));
    } catch (err) {
      console.warn('[overlay] muestra de rendimiento', err?.message || err);
    }
    refreshPing(address);
  };

  const refreshPing = (address) => {
    if (!address || ping.busy) return;
    if (ping.address === address && now() - ping.at < PING_EVERY_MS) return;
    ping.busy = true;
    Promise.resolve(pingFn(address))
      .then((ms) => {
        ping = { address, ms: Number.isFinite(ms) ? ms : null, at: now(), busy: false };
      })
      .catch(() => {
        ping = { address, ms: null, at: now(), busy: false };
      });
  };

  // Windows: ayudante de PowerShell con una linea por muestra.
  const startHelper = () => {
    const cmd = command({ pid, parentPid });
    try {
      child = spawnFn(cmd.file, cmd.args, { env: cmd.env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      child = null;
      return false;
    }
    if (!child) return false;
    let buf = '';
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > 65536) buf = buf.slice(-4096);
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const info = parseHelperLine(line);
        if (!info) continue;
        if (info.end) {
          ended = true;
          return stop();
        }
        last = { mem: info.mem, cpu: info.cpu };
        emit();
      }
      return undefined;
    });
    // Si el ayudante no abre o se cae (PowerShell bloqueado, un antivirus) se pasa a medir con pidusage; solo si el juego
    // sigue: cuando termina el juego el ayudante escribe su linea de fin antes de salir.
    const lost = () => {
      if (stopped || ended) return;
      child = null;
      startPolling();
    };
    child.on?.('error', lost);
    child.on?.('close', lost);
    return true;
  };

  // Otros sistemas (o si el ayudante no abre): pidusage cada 2 s (ps, barato fuera de Windows).
  const startPolling = () => {
    let pidusage = usage;
    if (!pidusage) {
      try {
        pidusage = require('pidusage');
      } catch {
        pidusage = null;
      }
    }
    const cores = Math.max(1, require('os').cpus().length || 1);
    const poll = async () => {
      if (stopped) return;
      if (pidusage) {
        try {
          const u = await pidusage(pid);
          last = { mem: Number(u?.memory), cpu: Number(u?.cpu) / cores };
        } catch {
          return stop(); // el proceso termino
        }
      }
      emit();
      if (!stopped) timer = setTimeout(poll, interval);
      return undefined;
    };
    timer = setTimeout(poll, 0);
  };

  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    timer = null;
    if (child) {
      try {
        child.kill();
      } catch {
        /* ya termino */
      }
      child = null;
    }
  }

  if (!(platform === 'win32' && startHelper())) startPolling();
  return { stop, pid };
}

module.exports = { createSampler, buildSample, parseHelperLine, command, SCRIPT, INTERVAL_MS, PING_EVERY_MS, PING_STALE_MS };
