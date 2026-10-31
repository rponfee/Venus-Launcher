'use strict';
// Registro "Actividad MCP": cada pedido de Claude o ChatGPT (conexiones y herramientas) con su resultado.
// Se guardan las ultimas 200 entradas en <datos>/mcp/activity.json (solo en esta PC) y cada alta o cambio se
// avisa a la interfaz con el evento mcp:activity (entrada completa; { cleared: true } al vaciar).
// Entrada: { id, at, kind: 'tool' | 'connect' | 'blocked', tool, level, client, source, state, summary, error,
//            warnings, undoId, noChange, input, durationMs }
// state: 'running' | 'pending' (esperando confirmacion) | 'ok' | 'error' | 'denied' | 'undone' | 'interrupted'
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const MAX = 200;

function createActivity({ file = null, send = () => {}, max = MAX, now = Date.now, saveDelayMs = 800 } = {}) {
  let entries = []; // de la mas vieja a la mas nueva
  let timer = null;
  let writing = Promise.resolve();

  function emit(payload) {
    try {
      send('mcp:activity', payload);
    } catch {
      /* ventana cerrada */
    }
  }

  function schedule() {
    if (!file || timer) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, saveDelayMs);
    timer.unref?.();
  }

  function flush() {
    if (!file) return Promise.resolve();
    clearTimeout(timer);
    timer = null;
    const data = JSON.stringify({ version: 1, entries }, null, 1);
    writing = writing
      .then(async () => {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await fsp.writeFile(tmp, data);
        await fsp.rename(tmp, file);
      })
      .catch((err) => console.warn('[mcp] No se pudo guardar la actividad:', err.message));
    return writing;
  }

  async function load() {
    if (!file) return;
    try {
      const data = JSON.parse(await fsp.readFile(file, 'utf8'));
      const list = Array.isArray(data?.entries) ? data.entries.filter((e) => e && typeof e.id === 'string' && typeof e.at === 'number') : [];
      // Lo que quedo a medias cuando se cerro el launcher
      for (const e of list) if (e.state === 'running' || e.state === 'pending') e.state = 'interrupted';
      entries = list.slice(-max);
    } catch {
      entries = [];
    }
  }

  function add(fields) {
    const e = { id: `m${crypto.randomBytes(6).toString('hex')}`, at: now(), state: 'running', ...fields };
    entries.push(e);
    if (entries.length > max) entries.splice(0, entries.length - max);
    schedule();
    emit({ ...e });
    return e;
  }

  function update(id, patch) {
    const e = entries.find((x) => x.id === id);
    if (!e) return null;
    Object.assign(e, patch);
    schedule();
    emit({ ...e });
    return e;
  }

  function byUndoId(undoId) {
    return entries.find((x) => x.undoId === undoId) || null;
  }

  // De la mas nueva a la mas vieja (como se muestra).
  function list() {
    return entries.slice().reverse().map((e) => ({ ...e }));
  }

  function clear() {
    entries = entries.filter((e) => e.state === 'running' || e.state === 'pending');
    schedule();
    emit({ cleared: true });
    return true;
  }

  return { load, add, update, byUndoId, list, clear, flush, get size() {
    return entries.length;
  } };
}

module.exports = { createActivity, MAX };
