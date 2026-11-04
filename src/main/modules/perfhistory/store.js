'use strict';
// Historial de rendimiento en disco: un archivo por mes (data/perfhistory/AAAA-MM.json), 90 dias de vida y tope de
// tamanio por archivo. Con 4 meses vivos como mucho, el total no pasa de 8 MB.
//   monthKey(ms)              -> 'AAAA-MM' (hora local, el mes en que empezo la partida)
//   pruneOld(lista, ahora)    -> sin las partidas de mas de 90 dias
//   fitSize(lista, tope)      -> primero se pierden las series de las mas viejas y despues partidas enteras
//   createStore(dir)          -> { list, get, save, remove, clear, rotate }
const fsp = require('fs/promises');
const path = require('path');
const { readJson } = require('../../core/util');
const { writeFileAtomic } = require('../packs/safety');

const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const FILE_RE = /^(\d{4})-(\d{2})\.json$/;

const pad = (n) => String(n).padStart(2, '0');

function monthKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

function pruneOld(list, now = Date.now(), maxAge = MAX_AGE_MS) {
  return (Array.isArray(list) ? list : []).filter((s) => s && now - (s.end || s.start || 0) <= maxAge);
}

const sizeOf = (list) => Buffer.byteLength(JSON.stringify({ version: 1, sessions: list }));

function fitSize(list, maxBytes = MAX_FILE_BYTES) {
  const out = [...list].sort((a, b) => a.start - b.start);
  let size = sizeOf(out);
  for (let i = 0; size > maxBytes && i < out.length; i++) {
    if (!out[i].series) continue;
    size -= Buffer.byteLength(JSON.stringify(out[i].series));
    out[i] = { ...out[i], series: null };
  }
  while (out.length > 1 && sizeOf(out) > maxBytes) out.shift();
  return out;
}

// El mes entero ya vencio (el dia 1 del mes siguiente quedo mas viejo que el tope)
function monthExpired(name, now, maxAge) {
  const m = FILE_RE.exec(name);
  return Boolean(m) && now - new Date(Number(m[1]), Number(m[2]), 1).getTime() > maxAge;
}

function createStore(dir, { now = () => Date.now(), maxAge = MAX_AGE_MS, maxBytes = MAX_FILE_BYTES } = {}) {
  const fileOf = (key) => path.join(dir, `${key}.json`);
  // Todo en fila: guardar y borrar leen el archivo entero y lo vuelven a escribir.
  let chain = Promise.resolve();
  const inOrder = (fn) => {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  };

  const months = async () => (await fsp.readdir(dir).catch(() => [])).filter((n) => FILE_RE.test(n)).sort();
  const read = async (key) => {
    const doc = await readJson(fileOf(key), null);
    return Array.isArray(doc?.sessions) ? doc.sessions : [];
  };
  const write = async (key, list) => {
    // Compacto a proposito: con sangria, cada numero de la serie ocuparia una linea entera.
    if (list.length) await writeFileAtomic(fileOf(key), JSON.stringify({ version: 1, sessions: list }));
    else await fsp.rm(fileOf(key), { force: true }).catch(() => {});
  };

  const save = (session) =>
    inOrder(async () => {
      const key = monthKey(session.start);
      const list = (await read(key)).filter((s) => s.id !== session.id);
      list.push(session);
      await write(key, fitSize(pruneOld(list, now(), maxAge), maxBytes));
    });

  const rotate = () =>
    inOrder(async () => {
      const t = now();
      for (const name of await months()) {
        if (monthExpired(name, t, maxAge)) {
          await fsp.rm(path.join(dir, name), { force: true }).catch(() => {});
          continue;
        }
        const key = name.slice(0, -5);
        const list = await read(key);
        const kept = fitSize(pruneOld(list, t, maxAge), maxBytes);
        if (kept.length !== list.length) await write(key, kept);
      }
    });

  // Partidas sin la serie, de la mas nueva a la mas vieja.
  const list = (filter = {}) =>
    inOrder(async () => {
      const out = [];
      const t = now();
      for (const name of (await months()).reverse()) {
        for (const s of await read(name.slice(0, -5))) {
          if (filter.instanceId && s.instanceId !== filter.instanceId) continue;
          if (t - (s.end || s.start || 0) > maxAge) continue;
          const { series, ...rest } = s;
          out.push({ ...rest, hasSeries: Boolean(series) });
        }
      }
      out.sort((a, b) => b.start - a.start);
      return filter.limit ? out.slice(0, filter.limit) : out;
    });

  const get = (id) =>
    inOrder(async () => {
      for (const name of (await months()).reverse()) {
        const hit = (await read(name.slice(0, -5))).find((s) => s.id === id);
        if (hit) return hit;
      }
      return null;
    });

  const remove = (id) =>
    inOrder(async () => {
      for (const name of await months()) {
        const key = name.slice(0, -5);
        const list = await read(key);
        const next = list.filter((s) => s.id !== id);
        if (next.length !== list.length) {
          await write(key, next);
          return true;
        }
      }
      return false;
    });

  const clear = () =>
    inOrder(async () => {
      for (const name of await months()) await fsp.rm(path.join(dir, name), { force: true }).catch(() => {});
      return true;
    });

  return { list, get, save, remove, clear, rotate };
}

module.exports = { MAX_AGE_MS, MAX_FILE_BYTES, monthKey, pruneOld, fitSize, createStore };
