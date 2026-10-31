'use strict';
// Deteccion del equipo (CPU, nucleos, GPU, RAM) y una prueba rapida de CPU para elegir ajustes.
// La prueba corre en un hilo aparte (~200 ms) y se guarda en data/perf.json para no repetirla.
const os = require('os');
const fsp = require('fs/promises');
const { execFile } = require('child_process');
const { Worker } = require('worker_threads');
const paths = require('../../core/paths');
const { readJson, writeJson } = require('../../core/util');

const MB = 1048576;
const DATA = () => paths.data('perf.json');
const BENCH_MS = 200;
// 1000 puntos ~ un nucleo de un Ryzen 7 5700G (23.500 bloques de trabajo por segundo).
const REF_CHUNKS_PER_SEC = 23.5;
const HW_MAX_AGE = 30 * 24 * 3600 * 1000;

const TIERS = ['low', 'mid', 'high', 'ultra'];
const RANK = { low: 0, mid: 1, high: 2, ultra: 3 };

// ---------- Prueba de CPU ----------
// Carga fija y determinista (enteros, coma flotante, arrays, mapas y objetos): se cuenta cuantas
// veces entra en BENCH_MS. Un hilo, porque el hilo principal de Minecraft es el que manda.
const BENCH_CODE = `
const { parentPort, workerData } = require('worker_threads');
function chunk(seed) {
  let x = (seed * 2654435761) | 0;
  let acc = 0;
  const arr = new Int32Array(2048);
  for (let i = 0; i < 2048; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; arr[i] = x; }
  for (let r = 0; r < 6; r++) {
    for (let i = 0; i < 2048; i++) {
      const j = (arr[i] >>> 21) & 2047;
      arr[i] = (Math.imul(arr[i], 31) + arr[j]) | 0;
      acc += Math.sqrt(arr[i] & 0xffff) * 0.5;
    }
  }
  const m = new Map();
  for (let i = 0; i < 256; i++) m.set(arr[i] & 511, i);
  const o = [];
  for (let i = 0; i < 64; i++) o.push({ a: arr[i], b: i });
  o.sort((p, q) => p.a - q.a);
  return acc + m.size + o[0].b;
}
let sink = 0;
for (let i = 0; i < 30; i++) sink += chunk(i);
// Tres tandas cortas: se queda con la mejor (si otro programa usa la CPU un instante, no arruina la medicion)
let best = 0;
const slice = workerData.ms / 3;
for (let round = 0; round < 3; round++) {
  const start = performance.now();
  let n = 0;
  while (performance.now() - start < slice) { sink += chunk(n); n++; }
  best = Math.max(best, n / (performance.now() - start));
}
parentPort.postMessage({ rate: best, ok: sink !== 0 });
`;

function runBenchmark(ms = BENCH_MS) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    let worker;
    try {
      worker = new Worker(BENCH_CODE, { eval: true, workerData: { ms } });
    } catch {
      finish(null);
      return;
    }
    const timer = setTimeout(() => {
      worker.terminate().catch(() => {});
      finish(null);
    }, ms + 5000);
    worker.once('message', (r) => {
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      finish(r && r.rate > 0 ? Math.round((r.rate / REF_CHUNKS_PER_SEC) * 1000) : null);
    });
    worker.once('error', () => {
      clearTimeout(timer);
      finish(null);
    });
  });
}

// ---------- Nombres y gamas de GPU ----------
const VIRTUAL_GPU = /basic (render|display)|remote display|llvmpipe|softpipe|swiftshader|virtual|vmware|virtualbox|parsec|citrix|spacedesk|idd ?driver|displaylink|meta quest|oray/i;

function cleanGpuName(raw) {
  let s = String(raw || '').trim();
  const angle = s.match(/^ANGLE \((.*)\)$/s);
  if (angle) {
    const parts = angle[1].split(/,\s*/);
    s = parts.length >= 2 ? parts[1] : parts[0];
  }
  return s
    .replace(/^ANGLE \w+ Renderer:\s*/i, '')
    .replace(/\s*\(0x[0-9a-f]+\)/gi, '')
    .replace(/\s+(Direct3D|D3D)\d*.*$/i, '')
    .replace(/\s+(OpenGL|Vulkan|Metal)\b.*$/i, '')
    .replace(/\s+vs_\d.*$/i, '')
    .replace(/\/PCIe.*$/i, '')
    .replace(/\s*\((radeonsi|llvm|drm)[^)]*\).*$/i, '')
    .replace(/^Mesa\s+/i, '')
    .replace(/\(R\)|\(TM\)|®|™/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function cleanCpuName(raw) {
  return String(raw || 'CPU')
    .replace(/\(R\)|\(TM\)|®|™/gi, '')
    .replace(/\s+CPU\s+@.*$/i, '')
    .replace(/\s+@\s*[\d.]+\s*GHz.*$/i, '')
    .replace(/\s+\d+-Core Processor$/i, '')
    .replace(/\s+with Radeon.*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// 'integrated' | 'entry' | 'mid' | 'high' segun el nombre (heuristica para las familias comunes).
function gpuTier(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return 'entry';
  if (VIRTUAL_GPU.test(n)) return 'integrated';
  let m;
  // NVIDIA
  if (/\brtx\b/.test(n)) {
    m = n.match(/rtx\s*(\d{2})(\d{2})/);
    if (m) return Number(m[2]) >= 60 ? 'high' : 'mid';
    m = n.match(/rtx\s*a(\d{3,4})/);
    if (m) return Number(m[1]) >= 4000 ? 'high' : 'mid';
    return 'high';
  }
  m = n.match(/gtx\s*(\d{3,4})/);
  if (m) return Number(m[1]) % 100 >= 60 ? 'mid' : 'entry';
  if (/\b(gt|mx)\s*\d{3}|quadro|\bnvs\b|geforce\s*\d{3}/.test(n)) return 'entry';
  // AMD
  m = n.match(/\brx\s*(\d{4})/);
  if (m) {
    const v = Number(m[1]);
    if (v >= 9000) return v % 100 >= 60 ? 'high' : 'mid'; // RX 9060 / 9070
    const tier = Math.floor((v % 1000) / 100); // RX 5500, 6600, 7800...
    if (tier >= 6) return 'high';
    if (tier === 5) return v < 6000 ? 'mid' : 'entry';
    return 'entry';
  }
  m = n.match(/\brx\s*(\d{3})\b/);
  if (m) return Number(m[1]) % 100 >= 70 ? 'mid' : 'entry';
  if (/vega\s*(56|64)|radeon vii|\bw\d{4}\b/.test(n)) return 'mid';
  if (/radeon.*\b\d{3}m\b/.test(n)) return 'entry'; // 680M / 780M / 890M: APU potentes
  if (/\br9\s*\d{3}|\br7\s*\d{3}|\bhd\s*\d{4}/.test(n)) return 'entry';
  if (/radeon/.test(n)) return 'integrated'; // "AMD Radeon Graphics", "Radeon Vega 8"
  // Intel
  if (/\barc\b/.test(n)) {
    if (/arc\s*(a3\d\d|a\d\dm)/.test(n) || /arc\s*graphics/.test(n)) return 'entry';
    return 'mid';
  }
  if (/intel|iris|uhd|hd graphics/.test(n)) return 'integrated';
  // Apple
  if (/apple\s*m\d/.test(n)) return /max|ultra/.test(n) ? 'high' : /pro/.test(n) ? 'mid' : 'entry';
  if (/adreno|mali|powervr|qualcomm/.test(n)) return 'integrated';
  return 'entry';
}

const GPU_RANK = { integrated: 0, entry: 1, mid: 2, high: 3 };

function bestGpu(names) {
  const real = names.filter((n) => n && !VIRTUAL_GPU.test(n));
  const list = real.length ? real : names.filter(Boolean);
  let best = null;
  for (const name of list) {
    const tier = gpuTier(name);
    if (!best || GPU_RANK[tier] > GPU_RANK[best.tier]) best = { name, tier };
  }
  return best;
}

// ---------- Hardware del sistema ----------
let gpuProvider = null; // () => Promise<GPUInfo> (app.getGPUInfo de Electron)
let electronGpuCache = null;

function setGpuProvider(fn) {
  gpuProvider = fn;
  electronGpuCache = null;
}

async function electronGpus() {
  if (electronGpuCache) return electronGpuCache;
  const names = [];
  if (gpuProvider) {
    try {
      const g = await gpuProvider();
      const gl = g?.auxAttributes?.glRenderer;
      if (gl) names.push(cleanGpuName(gl));
      for (const d of g?.gpuDevice || []) if (d.deviceString) names.push(cleanGpuName(d.deviceString));
    } catch {
      /* sin informacion de GPU */
    }
  }
  electronGpuCache = [...new Set(names.filter(Boolean))];
  return electronGpuCache;
}

function execText(cmd, args, timeout = 10000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout, maxBuffer: 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout || '')));
  });
}

// Windows: nucleos fisicos y todas las placas de video (la GPU que usa la interfaz puede ser la integrada).
async function windowsHardware() {
  const ps = [
    "$ErrorActionPreference='SilentlyContinue'",
    '$c = @(Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors)',
    '$g = @(Get-CimInstance Win32_VideoController | Select-Object Name)',
    '[pscustomobject]@{cpu=$c;gpu=$g} | ConvertTo-Json -Compress -Depth 3',
  ].join('; ');
  const out = await execText('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
  if (!out) return null;
  try {
    const data = JSON.parse(out.trim());
    const cpus = [].concat(data.cpu || []);
    const gpus = [].concat(data.gpu || []).map((g) => cleanGpuName(g?.Name)).filter(Boolean);
    const cores = cpus.reduce((a, c) => a + (Number(c?.NumberOfCores) || 0), 0) || null;
    return { cores, gpus };
  } catch {
    return null;
  }
}

async function linuxCores() {
  try {
    const text = await fsp.readFile('/proc/cpuinfo', 'utf8');
    const set = new Set();
    let phys = '0';
    for (const line of text.split('\n')) {
      const [k, v] = line.split(':').map((s) => (s || '').trim());
      if (k === 'physical id') phys = v;
      else if (k === 'core id') set.add(`${phys}:${v}`);
    }
    return set.size || null;
  } catch {
    return null;
  }
}

async function detectHardware() {
  const threads = os.cpus().length || 1;
  let cores = null;
  let gpus = [];
  if (process.platform === 'win32') {
    const hw = await windowsHardware();
    if (hw) {
      cores = hw.cores;
      gpus = hw.gpus;
    }
  } else if (process.platform === 'linux') {
    cores = await linuxCores();
  } else if (process.platform === 'darwin') {
    const out = await execText('sysctl', ['-n', 'hw.physicalcpu'], 4000);
    cores = Number.parseInt(out || '', 10) || null;
  }
  return { cores: cores || threads, gpus, threads, at: Date.now() };
}

// ---------- Gamas ----------
function ramTier(totalMb) {
  const gb = totalMb / 1024;
  if (gb < 6) return 'low';
  if (gb < 12) return 'mid';
  if (gb < 24) return 'high';
  return 'ultra';
}

// Umbrales lejos de las CPU mas comunes para que la gama no "salte" entre una medicion y otra.
function cpuTier(score, threads) {
  let r = !score ? 1 : score < 400 ? 0 : score < 700 ? 1 : score < 1150 ? 2 : 3;
  if (threads <= 2) r = 0;
  else if (threads <= 4) r = Math.min(r, 1);
  else if (threads <= 6) r = Math.min(r, 2);
  return TIERS[r];
}

const GPU_TO_TIER = { integrated: 'low', entry: 'mid', mid: 'high', high: 'ultra' };

function combineTiers(...tiers) {
  return TIERS[Math.min(...tiers.map((t) => RANK[t] ?? 1))];
}

// ---------- API ----------
let inflight = null;
let memo = null;

async function compute(rerun) {
  const cpus = os.cpus();
  const cpuModel = cleanCpuName(cpus[0]?.model);
  const threads = cpus.length || 1;
  const saved = await readJson(DATA(), {});
  const fresh = (x) => x && x.cpuModel === cpuModel && x.threads === threads && Date.now() - (x.at || 0) < HW_MAX_AGE;

  let hw = saved.hw;
  if (rerun || !fresh(hw)) hw = { ...(await detectHardware()), cpuModel };
  let bench = saved.bench;
  if (rerun || !fresh(bench) || !bench.cpuScore) {
    const score = await runBenchmark();
    bench = { cpuScore: score || bench?.cpuScore || null, cpuModel, threads, at: Date.now() };
  }
  if (hw !== saved.hw || bench !== saved.bench) await writeJson(DATA(), { ...saved, hw, bench }).catch(() => {});

  const gpuNames = [...new Set([...(await electronGpus()), ...(hw.gpus || [])])];
  const best = bestGpu(gpuNames);
  const totalMem = os.totalmem();
  const tiers = {
    ram: ramTier(totalMem / MB),
    cpu: cpuTier(bench.cpuScore, threads),
    gpu: best ? GPU_TO_TIER[best.tier] : 'mid',
  };
  return {
    totalMem,
    freeMem: os.freemem(),
    cpuModel,
    cores: hw.cores || threads,
    threads,
    gpu: best?.name || null,
    gpuTier: best?.tier || 'entry',
    gpus: gpuNames,
    cpuScore: bench.cpuScore,
    tier: combineTiers(tiers.ram, tiers.cpu, tiers.gpu),
    tiers,
    benchmarkedAt: bench.at,
    platform: process.platform,
    arch: process.arch,
  };
}

// get({ rerun }) -> datos del equipo. La memoria libre se actualiza en cada llamada.
async function get({ rerun = false } = {}) {
  if (!rerun && memo) return { ...memo, freeMem: os.freemem() };
  if (!rerun && inflight) return { ...(await inflight), freeMem: os.freemem() };
  const run = (inflight ? inflight.catch(() => null) : Promise.resolve()).then(() => compute(rerun));
  inflight = run;
  try {
    memo = await run;
    return { ...memo, freeMem: os.freemem() };
  } finally {
    if (inflight === run) inflight = null;
  }
}

module.exports = { get, setGpuProvider, runBenchmark, cleanGpuName, cleanCpuName, gpuTier, bestGpu, ramTier, cpuTier, combineTiers, TIERS, RANK };
