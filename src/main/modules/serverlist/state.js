'use strict';
// Datos propios del modulo (data/serverlist.json): historial de servidores consultados o jugados
// y la instancia que eligio el jugador para cada servidor.
const paths = require('../../core/paths');
const { readJson, writeJson } = require('../../core/util');
const { parseAddress, addressKey } = require('./address');

const FILE = () => paths.data('serverlist.json');
const MAX_HISTORY = 15;
let cache = null;
let queue = Promise.resolve();

async function load() {
  if (!cache) {
    const d = await readJson(FILE(), {});
    cache = {
      history: Array.isArray(d.history) ? d.history.filter((h) => h && typeof h.address === 'string') : [],
      preferred: d.preferred && typeof d.preferred === 'object' && !Array.isArray(d.preferred) ? d.preferred : {},
    };
  }
  return cache;
}

function save() {
  const snapshot = JSON.parse(JSON.stringify(cache));
  queue = queue.then(() => writeJson(FILE(), snapshot)).catch((err) => console.warn('[serverlist] no se pudo guardar el historial:', err.message));
  return queue;
}

// kind: 'lookup' (consulta) | 'join' (entro a jugar)
async function remember(address, { kind = 'lookup', name = null } = {}) {
  const addr = parseAddress(address);
  if (!addr) return;
  const d = await load();
  const prev = d.history.find((h) => h.key === addr.key);
  const entry = {
    address: addr.display,
    key: addr.key,
    kind: prev?.kind === 'join' || kind === 'join' ? 'join' : 'lookup',
    name: name ? String(name).slice(0, 64) : prev?.name || null,
    at: Date.now(),
  };
  d.history = [entry, ...d.history.filter((h) => h.key !== addr.key)].slice(0, MAX_HISTORY);
  await save();
}

async function history() {
  return (await load()).history.map((h) => ({ ...h }));
}

async function clearHistory() {
  (await load()).history = [];
  await save();
  return true;
}

async function preferred(address) {
  return (await load()).preferred[addressKey(address)] || null;
}

async function setPreferred(address, instanceId) {
  const d = await load();
  const k = addressKey(address);
  if (instanceId) d.preferred[k] = String(instanceId);
  else delete d.preferred[k];
  await save();
  return true;
}

module.exports = { remember, history, clearHistory, preferred, setPreferred };
