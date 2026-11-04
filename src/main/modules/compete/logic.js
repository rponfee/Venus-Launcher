'use strict';
// Competir: lógica pura de lo que se comparte (sin Electron ni disco). Semanas de lunes a domingo (UTC), minutos
// jugados por semana a partir del registro de partidas y diferencias de las estadísticas del juego contra el último envío.
// Se prueba con Node: node --test "src/main/modules/compete/test/*.test.js"
const MINUTE = 60000;
const DAY = 24 * 60 * MINUTE;
const WEEK = 7 * DAY;
const STAT_KEYS = ['diamonds', 'mobs', 'blocks', 'deaths'];
// Una partida no puede sumar más tiempo de juego que el jugado (el juego guarda sus estadísticas cada tanto: de ahí el
// margen). Si suma más, es un mundo importado o duplicado: se toma como nuevo punto de partida y no se envía.
const IMPORT_MARGIN_MS = 15 * MINUTE;

/** Lunes 00:00 UTC de la semana de un instante, en ms. */
function weekStartMs(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - ((d.getUTCDay() + 6) % 7) * DAY;
}

/** La semana de un instante como 'AAAA-MM-DD' (su lunes), igual que private.compete_week en el servidor. */
function weekKey(ms) {
  return new Date(weekStartMs(ms)).toISOString().slice(0, 10);
}

// Tramos jugados dentro de (desde, hasta], unidos: dos instancias abiertas a la vez no cuentan doble.
function mergeIntervals(sessions, from, to) {
  const list = [];
  for (const s of Array.isArray(sessions) ? sessions : []) {
    const a = Math.max(Number(s?.start), from);
    const b = Math.min(Number(s?.end), to);
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) list.push([a, b]);
  }
  list.sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of list) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * Lo jugado desde `cursor` hasta `now`, por semana y en orden: [{ week, ms, minutes, cursor }]. `cursor` es hasta dónde
 * llega lo contado: en la última semana lo que sobra (menos de un minuto) queda para el próximo envío; una semana que ya
 * pasó se cierra entera, porque esos segundos ya no van a sumar a nada.
 */
function playedByWeek(sessions, cursor, now) {
  const byWeek = new Map();
  for (const [from, to] of mergeIntervals(sessions, cursor, now)) {
    let a = from;
    while (a < to) {
      const start = weekStartMs(a);
      const stop = Math.min(to, start + WEEK);
      if (!byWeek.has(start)) byWeek.set(start, []);
      byWeek.get(start).push([a, stop]);
      a = stop;
    }
  }
  const current = weekStartMs(now);
  return [...byWeek.entries()].sort((x, y) => x[0] - y[0]).map(([start, parts]) => {
    const ms = parts.reduce((sum, [a, b]) => sum + (b - a), 0);
    const minutes = Math.floor(ms / MINUTE);
    let end = start + WEEK;
    if (start >= current) {
      let rest = minutes * MINUTE;
      end = minutes ? parts[0][0] : cursor;
      for (const [a, b] of parts) {
        if (rest <= 0) break;
        const used = Math.min(rest, b - a);
        end = a + used;
        rest -= used;
      }
    }
    return { week: weekKey(start), ms, minutes, cursor: end };
  });
}

/** Las cuatro medidas que se comparten (más el tiempo de juego, en ticks) de un archivo ya normalizado por statsplus/ingame. */
function totalsOf(norm) {
  const custom = norm?.custom || {};
  const mined = norm?.mined || {};
  const blocks = Object.values(mined).reduce((sum, v) => sum + (Number(v) || 0), 0);
  return {
    diamonds: (Number(mined['minecraft:diamond_ore']) || 0) + (Number(mined['minecraft:deepslate_diamond_ore']) || 0),
    mobs: Number(custom['minecraft:mob_kills']) || 0,
    blocks,
    deaths: Number(custom['minecraft:deaths']) || 0,
    play: Number(custom['minecraft:play_time']) || 0,
  };
}

/**
 * Diferencia entre dos totales de un mismo archivo. Un valor que bajó (mundo restaurado, estadísticas borradas) no resta:
 * ese valor es el nuevo punto de partida. ms: tiempo de juego que sumó el archivo.
 */
function diffTotals(prev, cur) {
  const out = {};
  for (const k of STAT_KEYS) out[k] = Math.max(0, Math.floor((Number(cur?.[k]) || 0) - (Number(prev?.[k]) || 0)));
  out.ms = Math.max(0, (Number(cur?.play) || 0) - (Number(prev?.play) || 0)) * 50;
  return out;
}

const isZero = (delta) => STAT_KEYS.every((k) => !delta[k]);

/**
 * Arma lo que hay para enviar.
 *   baseline: { clave: { mtimeMs, size, diamonds, mobs, blocks, deaths, play } } (el último envío)
 *   scanned:  [{ key, unchanged: true } | { key, mtimeMs, size, totals }]
 *   sessions, cursor, now: el registro de partidas y hasta dónde se contó
 * Devuelve { reports: [{ week, minutes, diamonds, mobs, blocks, deaths, files, cursor }] (en orden, solo la semana actual y
 * la anterior, que es lo que acepta ranking_report), silent (archivos que cambian sin enviar nada), cursor (hasta dónde
 * avanza el cursor sin enviar nada, o null) }. Cada archivo cuenta en la semana en que se escribió.
 */
function buildReports({ baseline = {}, scanned = [], sessions = [], cursor, now }) {
  const played = playedByWeek(sessions, cursor, now);
  const playedMs = played.reduce((sum, p) => sum + p.ms, 0);
  const current = weekKey(now);
  const previous = weekKey(now - WEEK);
  const reportable = (week) => week === current || week === previous;
  const byWeek = new Map();
  const reportOf = (week) => {
    if (!byWeek.has(week)) byWeek.set(week, { week, minutes: 0, diamonds: 0, mobs: 0, blocks: 0, deaths: 0, files: {}, cursor: null });
    return byWeek.get(week);
  };
  const silent = {};
  let silentCursor = null;
  for (const p of played) {
    if (reportable(p.week) && p.minutes > 0) {
      const r = reportOf(p.week);
      r.minutes = p.minutes;
      r.cursor = p.cursor;
    } else if (p.week !== current) {
      silentCursor = p.cursor; // semana vieja o menos de un minuto que ya no va a sumar
    }
  }
  for (const file of scanned) {
    if (file.unchanged || !file.totals) continue;
    const snapshot = { mtimeMs: file.mtimeMs, size: file.size, ...file.totals };
    const delta = diffTotals(baseline[file.key], file.totals);
    const when = Math.min(Number(file.mtimeMs) || now, now);
    if (isZero(delta) || delta.ms > playedMs + IMPORT_MARGIN_MS || !reportable(weekKey(when))) {
      silent[file.key] = snapshot;
      continue;
    }
    const r = reportOf(weekKey(when));
    for (const k of STAT_KEYS) r[k] += delta[k];
    r.files[file.key] = snapshot;
  }
  const reports = [...byWeek.values()].sort((a, b) => (a.week < b.week ? -1 : 1));
  return { reports, silent, cursor: silentCursor };
}

/** Foto inicial: lo que ya estaba al prender compartir no se envía nunca. */
function firstSnapshot(scanned) {
  const out = {};
  for (const file of scanned || []) if (file.totals) out[file.key] = { mtimeMs: file.mtimeMs, size: file.size, ...file.totals };
  return out;
}

module.exports = { MINUTE, DAY, WEEK, STAT_KEYS, IMPORT_MARGIN_MS, weekStartMs, weekKey, mergeIntervals, playedByWeek, totalsOf, diffTotals, buildReports, firstSnapshot };
