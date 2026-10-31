'use strict';
// Datos del equipo para el asistente (sin nada personal: ni nombre del equipo, ni usuario, ni rutas) y una
// prueba rapida de rendimiento. Usa el modulo de rendimiento (./perf) cuando esta disponible.
const os = require('os');
const { Worker } = require('worker_threads');
const settings = require('../../core/settings');
const java = require('../../core/java');

const MB = 1048576;
const GB = 1073741824;
const TIERS = ['low', 'mid', 'high', 'ultra'];

let optional = () => null; // carga perezosa de otros modulos (se inyecta desde assistant.js)
let gpuProvider = null; // app.getGPUInfo

function configure({ optional: opt, gpu } = {}) {
  if (opt) optional = opt;
  if (gpu !== undefined) gpuProvider = gpu;
}

function osName() {
  const rel = os.release();
  if (process.platform === 'win32') {
    const build = Number(rel.split('.')[2]) || 0;
    return `${build >= 22000 ? 'Windows 11' : 'Windows 10'} (${rel})`;
  }
  if (process.platform === 'darwin') return `macOS (Darwin ${rel})`;
  return `Linux ${rel}`;
}

function cleanCpu(raw) {
  return String(raw || 'CPU')
    .replace(/\(R\)|\(TM\)|®|™/gi, '')
    .replace(/\s+CPU\s+@.*$/i, '')
    .replace(/\s+@\s*[\d.]+\s*GHz.*$/i, '')
    .replace(/\s+\d+-Core Processor$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function cleanGpu(raw) {
  let s = String(raw || '').trim();
  const angle = s.match(/^ANGLE \((.*)\)$/s);
  if (angle) {
    const parts = angle[1].split(/,\s*/);
    s = parts.length >= 2 ? parts[1] : parts[0];
  }
  return s.replace(/\s*\(0x[0-9a-f]+\)/gi, '').replace(/\s+(Direct3D|D3D|OpenGL|Vulkan|Metal)\b.*$/i, '').replace(/\(R\)|\(TM\)/gi, '').replace(/\s{2,}/g, ' ').trim();
}

// Gama de GPU por nombre (heuristica para las familias comunes).
function gpuTier(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return 'entry';
  if (/basic (render|display)|llvmpipe|swiftshader|virtual|vmware|virtualbox/.test(n)) return 'integrated';
  let m = n.match(/rtx\s*(\d{2})(\d{2})/);
  if (m) return Number(m[2]) >= 60 ? 'high' : 'mid';
  if (/\brtx\b/.test(n)) return 'high';
  m = n.match(/gtx\s*(\d{3,4})/);
  if (m) return Number(m[1]) % 100 >= 60 ? 'mid' : 'entry';
  m = n.match(/\brx\s*(\d{4})/);
  if (m) {
    const v = Number(m[1]);
    if (v >= 9000) return v % 100 >= 60 ? 'high' : 'mid';
    const tier = Math.floor((v % 1000) / 100);
    return tier >= 6 ? 'high' : tier === 5 ? 'mid' : 'entry';
  }
  if (/\barc\b/.test(n)) return /a3\d\d|graphics/.test(n) ? 'entry' : 'mid';
  if (/radeon.*\b\d{3}m\b/.test(n)) return 'entry';
  if (/intel|iris|uhd|hd graphics|radeon\(tm\) graphics|radeon graphics|vega \d\b/.test(n)) return 'integrated';
  if (/apple\s*m\d/.test(n)) return /max|ultra/.test(n) ? 'high' : /pro/.test(n) ? 'mid' : 'entry';
  return 'entry';
}

async function electronGpu() {
  if (!gpuProvider) return null;
  try {
    const g = await gpuProvider();
    const raw = g?.auxAttributes?.glRenderer || g?.gpuDevice?.find((d) => d.active)?.deviceString || g?.gpuDevice?.[0]?.deviceString;
    return raw ? cleanGpu(raw) : null;
  } catch {
    return null;
  }
}

async function javaMajors() {
  try {
    const list = await java.listInstalledRuntimes();
    return [...new Set(list.map((r) => r.major).filter(Boolean))].sort((a, b) => a - b);
  } catch {
    return [];
  }
}

// Datos del equipo (perf.system cuando existe; si no, Node + GPU de Electron).
async function specs() {
  const perf = optional('perf');
  let p = null;
  if (perf && typeof perf.system === 'function') {
    try {
      p = await perf.system();
    } catch {
      p = null;
    }
  }
  const cpus = os.cpus();
  const gpu = p?.gpu || (await electronGpu());
  const total = os.totalmem();
  return {
    os: osName(),
    arch: process.arch,
    cpu: p?.cpuModel || cleanCpu(cpus[0]?.model),
    cores: p?.cores || null,
    threads: p?.threads || cpus.length || 1,
    ram_total_gb: Math.round((total / GB) * 10) / 10,
    ram_free_gb: Math.round((os.freemem() / GB) * 10) / 10,
    gpu: gpu || null,
    gpu_tier: p?.gpuTier || (gpu ? gpuTier(gpu) : null),
    java_installed: await javaMajors(),
    ram_recommended_mb: settings.recommendedMemory().max,
  };
}

// ---------- Prueba rapida de CPU propia (si ./perf no esta) ----------
const BENCH_CODE = `
const { parentPort, workerData } = require('worker_threads');
function work(seed) {
  let x = (seed * 2654435761) | 0, acc = 0;
  const arr = new Int32Array(2048);
  for (let i = 0; i < 2048; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; arr[i] = x; }
  for (let r = 0; r < 6; r++) for (let i = 0; i < 2048; i++) { const j = (arr[i] >>> 21) & 2047; arr[i] = (Math.imul(arr[i], 31) + arr[j]) | 0; acc += Math.sqrt(arr[i] & 0xffff) * 0.5; }
  const m = new Map(); for (let i = 0; i < 256; i++) m.set(arr[i] & 511, i);
  return acc + m.size;
}
let sink = 0; for (let i = 0; i < 20; i++) sink += work(i);
const start = performance.now(); let n = 0;
while (performance.now() - start < workerData.ms) { sink += work(n); n++; }
parentPort.postMessage({ n, elapsed: performance.now() - start, ok: sink !== 0 });
`;

function quickBenchmark(ms = 300) {
  return new Promise((resolve) => {
    let worker;
    try {
      worker = new Worker(BENCH_CODE, { eval: true, workerData: { ms } });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      worker.terminate().catch(() => {});
      resolve(null);
    }, ms + 5000);
    worker.once('message', (r) => {
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      // 1000 puntos ~ un nucleo moderno de gama media (misma escala aproximada que el modulo de rendimiento)
      resolve(r && r.elapsed > 0 ? Math.round((r.n / r.elapsed / 23.5) * 1000) : null);
    });
    worker.once('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

function cpuTier(score, threads) {
  let r = !score ? 1 : score < 380 ? 0 : score < 650 ? 1 : score < 950 ? 2 : 3;
  if (threads <= 2) r = 0;
  else if (threads <= 4) r = Math.min(r, 1);
  else if (threads <= 6) r = Math.min(r, 2);
  return TIERS[r];
}

function ramTier(totalMb) {
  const gb = totalMb / 1024;
  return gb < 6 ? 'low' : gb < 12 ? 'mid' : gb < 24 ? 'high' : 'ultra';
}

const GPU_TO_TIER = { integrated: 'low', entry: 'mid', mid: 'high', high: 'ultra' };

// Sugerencias simples por gama (las decide el modelo; esto es una referencia).
const SUGGEST = {
  low: { render_distance: 6, simulation_distance: 5, graphics: 'fast' },
  mid: { render_distance: 10, simulation_distance: 6, graphics: 'fast' },
  high: { render_distance: 14, simulation_distance: 8, graphics: 'fancy' },
  ultra: { render_distance: 20, simulation_distance: 12, graphics: 'fancy' },
};

async function benchmark() {
  const perf = optional('perf');
  if (perf && typeof perf.system === 'function') {
    try {
      const r = await perf.system({ rerun: true });
      if (r && r.tier) {
        return {
          cpu_score: r.cpuScore ?? null,
          cpu_tier: r.tiers?.cpu || null,
          gpu: r.gpu || null,
          gpu_tier: r.gpuTier || null,
          ram_tier: r.tiers?.ram || null,
          overall_tier: r.tier,
          threads: r.threads || null,
          ram_total_gb: Math.round(((r.totalMem || os.totalmem()) / GB) * 10) / 10,
          ram_recommended_mb: settings.recommendedMemory().max,
          suggested: SUGGEST[r.tier] || SUGGEST.mid,
          source: 'perf',
        };
      }
    } catch {
      /* se usa la prueba propia */
    }
  }
  const threads = os.cpus().length || 1;
  const score = await quickBenchmark();
  const gpu = await electronGpu();
  const gTier = gpu ? gpuTier(gpu) : 'entry';
  const tiers = { cpu: cpuTier(score, threads), gpu: GPU_TO_TIER[gTier] || 'mid', ram: ramTier(os.totalmem() / MB) };
  const overall = TIERS[Math.min(...Object.values(tiers).map((x) => TIERS.indexOf(x)))];
  return {
    cpu_score: score,
    cpu_tier: tiers.cpu,
    gpu,
    gpu_tier: gTier,
    ram_tier: tiers.ram,
    overall_tier: overall,
    threads,
    ram_total_gb: Math.round((os.totalmem() / GB) * 10) / 10,
    ram_recommended_mb: settings.recommendedMemory().max,
    suggested: SUGGEST[overall] || SUGGEST.mid,
    source: 'assistant',
  };
}

module.exports = { configure, specs, benchmark, gpuTier, quickBenchmark };
