'use strict';
// Cache de SHA-1 por archivo fisico (dispositivo + id de archivo) para no volver a leer los mods en cada analisis.
// Una entrada vale solo si coinciden tamaño, fecha de modificacion y de cambio (ctime): un archivo nuevo que
// reutilice el mismo id nunca hereda un hash viejo.
const paths = require('../../core/paths');
const { readJson, writeJson } = require('../../core/util');
const { sha1File } = require('./fsutil');

const FILE = () => paths.data('storage-hashes.json');
const MAX_UNSEEN = 30 * 24 * 3600 * 1000; // se olvidan las entradas que no aparecen hace 30 dias

let cache = null;
let loadedFor = null;
let dirty = false;

async function load() {
  const file = FILE();
  if (cache && loadedFor === file) return cache;
  const raw = await readJson(file, {});
  cache = new Map(Object.entries(raw && raw.v === 1 && raw.entries ? raw.entries : {}));
  loadedFor = file;
  dirty = false;
  return cache;
}

function lookup(st) {
  const e = cache?.get(st.key);
  if (!e || e.size !== st.size || e.m !== st.mtimeNs || e.c !== st.ctimeNs) return null;
  e.seen = Date.now();
  return e.sha1;
}

function remember(st, sha1) {
  if (!cache) return;
  cache.set(st.key, { size: st.size, m: st.mtimeNs, c: st.ctimeNs, sha1, seen: Date.now() });
  dirty = true;
}

// Hash de un archivo usando la cache (st = statExact del mismo archivo).
async function sha1(p, st, signal) {
  await load();
  const hit = lookup(st);
  if (hit) return { sha1: hit, cached: true };
  const value = await sha1File(p, signal);
  remember(st, value);
  return { sha1: value, cached: false };
}

async function save() {
  if (!cache || !dirty) return;
  const now = Date.now();
  for (const [k, e] of cache) if (!e.seen || now - e.seen > MAX_UNSEEN) cache.delete(k);
  await writeJson(FILE(), { v: 1, entries: Object.fromEntries(cache) });
  dirty = false;
}

module.exports = { load, lookup, remember, sha1, save };
