'use strict';
// Memoria automatica: cuanta RAM darle a cada instancia segun la PC y el tamaño de la instancia.
// "base" = lo que recibe una instancia vanilla o con pocos mods; "cap" = el tope para modpacks grandes.
const os = require('os');
const fsp = require('fs/promises');
const path = require('path');
const mcver = require('./mcver');

const MB = 1048576;

const floorTo = (mb, step) => Math.floor(mb / step) * step;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Segun la RAM total del equipo (lo que informa el sistema: una PC de 16 GB suele mostrar ~15,8 GB).
function plan(totalMb = os.totalmem() / MB) {
  const gb = totalMb / 1024;
  if (gb < 3.5) return { base: 1536, cap: 2048, floor: 1024 };
  if (gb < 5.5) return { base: 2048, cap: 2560, floor: 1536 };
  if (gb < 7) return { base: 2560, cap: 3584, floor: 2048 };
  if (gb < 11) return { base: 3072, cap: 4608, floor: 2048 };
  if (gb < 14) return { base: 4096, cap: 6144, floor: 2048 };
  if (gb < 20) return { base: 4096, cap: 8192, floor: 2048 };
  if (gb < 28) return { base: 5120, cap: 9216, floor: 2048 };
  if (gb < 48) return { base: 6144, cap: 10240, floor: 2048 };
  return { base: 6144, cap: 12288, floor: 2048 };
}

// Memoria inicial (-Xms): la mitad de la maxima (como el launcher oficial), entre 512 MB y 4 GB.
function deriveMin(max) {
  return Math.min(max, clamp(floorTo(max / 2, 256), 512, 4096));
}

// Cuanta memoria pide una instancia por su contenido.
function demand({ mcVersion, modCount = 0, isModpack = false, shaders = false } = {}) {
  let need;
  if (modCount <= 0) need = mcver.atLeast(mcVersion, '1.18') ? 3072 : mcver.atLeast(mcVersion, '1.13') ? 2560 : 2048;
  else need = 3072 + Math.max(0, modCount - 20) * 26; // ~100 mods: 5 GB, ~200: 7,5 GB, ~300: 10 GB
  if (isModpack) need += 512;
  if (shaders) need += 1024;
  return need;
}

// Calcula { min, max } para una instancia. freeMb (opcional) es la RAM libre en este momento.
function compute({ totalMb = os.totalmem() / MB, freeMb = null, lowEnd = false, ...inst } = {}) {
  const p = plan(totalMb);
  const need = demand(inst);
  let max;
  if (lowEnd) {
    max = Math.min(p.cap, (inst.modCount || 0) > 0 ? 3072 : 2048);
  } else {
    const comfortable = Math.min(p.cap, Math.max(p.base, need));
    max = comfortable;
    // Con poca RAM libre no pedimos mas de lo necesario (pero nunca menos de lo que la instancia necesita)
    if (freeMb && freeMb - 768 < comfortable) max = Math.min(comfortable, Math.max(need, freeMb - 768));
  }
  max = clamp(floorTo(max, 512), p.floor, p.cap);
  return {
    min: deriveMin(max),
    max,
    need,
    plan: p,
    limited: need > p.cap, // la PC no llega a lo que pide la instancia
    lowFree: Boolean(freeMb && freeMb < Math.min(need, max)),
  };
}

// Zonas del deslizador manual: debajo de "low" es poco, encima de "high" es demasiado.
function zones(totalMb = os.totalmem() / MB, need = null) {
  const p = plan(totalMb);
  const sliderMax = Math.max(2048, floorTo(totalMb - 1024, 256));
  const high = Math.min(sliderMax, Math.max(p.floor + 512, floorTo(Math.min(totalMb * 0.7, Math.max(p.cap, 16384)), 256)));
  let low = p.floor;
  if (need) low = clamp(floorTo(need * 0.7, 256), p.floor, Math.max(p.floor, high - 1024));
  return { min: 1024, max: sliderMax, step: 256, low, high };
}

// Lee el contenido de una instancia (cantidad de mods, si es modpack, si usa shaders).
async function inspect(inst) {
  const dir = inst.dir;
  let files = [];
  try {
    files = await fsp.readdir(path.join(dir, 'mods'));
  } catch {
    files = [];
  }
  const jars = files.filter((f) => /\.(jar|zip)$/i.test(f));
  const shaderMod = inst.loader === 'optifine' || inst.preset === 'iris' || jars.some((f) => /^(iris|oculus)[-_+]|optifine/i.test(f));
  let packs = 0;
  if (shaderMod) {
    try {
      packs = (await fsp.readdir(path.join(dir, 'shaderpacks'))).filter((n) => !n.startsWith('.') && !/\.txt$/i.test(n)).length;
    } catch {
      packs = 0;
    }
  }
  return {
    modCount: jars.length,
    isModpack: Boolean(inst.modrinth?.pack || inst.pack || jars.length >= 120),
    shaders: shaderMod && packs > 0,
  };
}

// Memoria automatica para una instancia ya creada.
async function forInstance(inst, { totalMb, freeMb, lowEnd } = {}) {
  const info = await inspect(inst);
  return { ...compute({ totalMb, freeMb, lowEnd, mcVersion: inst.mcVersion, ...info }), ...info };
}

// Ejemplos para explicar el modo automatico en la pagina de Rendimiento.
function examples(totalMb = os.totalmem() / MB) {
  return [
    { kind: 'vanilla', max: compute({ totalMb, mcVersion: '1.21', modCount: 0 }).max },
    { kind: 'mods', count: 80, max: compute({ totalMb, mcVersion: '1.21', modCount: 80 }).max },
    { kind: 'modpack', count: 300, max: compute({ totalMb, mcVersion: '1.21', modCount: 300, isModpack: true }).max },
  ];
}

module.exports = { plan, deriveMin, demand, compute, zones, inspect, forInstance, examples, MB };
