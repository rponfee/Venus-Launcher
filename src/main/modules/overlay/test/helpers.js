'use strict';
// Carga los modulos ES sin imports de la interfaz (js/overlay/layout.js y logic.js) desde data:, como las pruebas
// de skins: asi Node no avisa por el tipo del paquete.
const fs = require('fs');
const path = require('path');

const RENDERER = path.join(__dirname, '..', '..', '..', '..', 'renderer', 'js', 'overlay');
const cache = new Map();
function esm(name) {
  if (!cache.has(name)) {
    const src = fs.readFileSync(path.join(RENDERER, name)).toString('base64');
    cache.set(name, import(`data:text/javascript;base64,${src}`));
  }
  return cache.get(name);
}

// Reloj falso con temporizadores manuales (para el limite de frecuencia).
function fakeClock(start = 1000) {
  let now = start;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimer: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { fn, at: now + Math.max(0, ms) });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
    },
    pending: () => timers.size,
  };
}

module.exports = { esm, fakeClock };
