'use strict';
// Cola de los links venus://: guarda lo que llega hasta que la interfaz avisa que está lista y no repite un mismo
// link en unos segundos (dos clics, o una página que lo abre varias veces). Un link que ya se mandó no vuelve.
const DUPLICATE_MS = 3000;
const MAX_PENDING = 5;

function createLinkQueue(send, { now = Date.now } = {}) {
  let ready = false;
  let pending = [];
  const last = new Map(); // link -> cuándo llegó

  const deliver = (action) => {
    try {
      send(action);
    } catch {
      /* ventana cerrada */
    }
  };

  return {
    push(action) {
      if (!action?.link) return false;
      const at = now();
      for (const [link, when] of last) if (at - when >= DUPLICATE_MS) last.delete(link);
      if (last.has(action.link)) return false;
      last.set(action.link, at);
      if (ready) {
        deliver(action);
        return true;
      }
      if (pending.length >= MAX_PENDING) return false;
      pending.push(action);
      return true;
    },
    // La interfaz terminó de arrancar (se vuelve a llamar si se recarga).
    ready() {
      ready = true;
      const list = pending;
      pending = [];
      list.forEach(deliver);
      return list.length;
    },
    size: () => pending.length,
  };
}

module.exports = { createLinkQueue, DUPLICATE_MS, MAX_PENDING };
