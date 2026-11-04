'use strict';
// Historial de rendimiento: cuentas de una partida, sin Electron ni disco (pruebas en test/summary.test.js).
//   stats(valores)              -> { avg, min, low1, max, n } o null si no hay ningun dato
//   downsample(muestras, tope)  -> la serie reducida por promedios, para guardarla y dibujarla
//   summarize(partida)          -> el registro que se guarda
// low1 es el "1 % bajo": el promedio del 1 % de muestras mas bajas (al menos una). Con una muestra cada 10 s es una
// referencia del peor momento, no el 1 % low por cuadro de un programa de medicion.
const MAX_POINTS = 240;

const round1 = (n) => Math.round(n * 10) / 10;
const numeric = (v) => typeof v === 'number' && Number.isFinite(v);

function stats(values) {
  const list = (Array.isArray(values) ? values : []).filter(numeric);
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const lowCount = Math.max(1, Math.ceil(sorted.length * 0.01));
  const low = sorted.slice(0, lowCount).reduce((a, b) => a + b, 0) / lowCount;
  return { avg: round1(sum / sorted.length), min: round1(sorted[0]), low1: round1(low), max: round1(sorted[sorted.length - 1]), n: sorted.length };
}

function mean(list) {
  const ok = list.filter(numeric);
  return ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : null;
}

// samples: [{ t (ms desde el inicio), ram (MB), cpu (%), fps (o null) }] -> columnas para ocupar menos
function downsample(samples, max = MAX_POINTS) {
  const list = Array.isArray(samples) ? samples : [];
  const bucket = Math.max(1, Math.ceil(list.length / Math.max(1, max)));
  const out = { t: [], ram: [], cpu: [], fps: [] };
  for (let i = 0; i < list.length; i += bucket) {
    const part = list.slice(i, i + bucket);
    const pick = (k) => mean(part.map((s) => s[k]));
    const ram = pick('ram');
    const cpu = pick('cpu');
    const fps = pick('fps');
    out.t.push(Math.round(pick('t') / 1000));
    out.ram.push(ram === null ? null : Math.round(ram));
    out.cpu.push(cpu === null ? null : round1(cpu));
    out.fps.push(fps === null ? null : Math.round(fps));
  }
  if (out.fps.every((v) => v === null)) out.fps = null;
  return out;
}

function summarize(session) {
  const samples = session.samples || [];
  return {
    id: session.id,
    instanceId: session.instanceId,
    instanceName: session.instanceName,
    mcVersion: session.mcVersion,
    loader: session.loader,
    start: session.start,
    end: session.end,
    durationMs: Math.max(0, session.end - session.start),
    crashed: Boolean(session.crashed),
    partial: Boolean(session.partial),
    samples: samples.length,
    ram: stats(samples.map((s) => s.ram)),
    cpu: stats(samples.map((s) => s.cpu)),
    fps: stats(samples.map((s) => s.fps)),
    series: downsample(samples),
  };
}

module.exports = { MAX_POINTS, stats, downsample, summarize };
