'use strict';
// Ayudantes de las pruebas de Estado de los servicios: fetch falso (por host) y reloj falso. Sin red.

// Reloj que solo avanza a mano (o desde el fetch falso, para simular demoras).
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms), set: (v) => (t = v) };
}

function netError(code) {
  return Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });
}

// rules: { 'host': comportamiento, '*': por defecto }. Comportamiento: número (status), 'ok', 'timeout'
// (nunca contesta hasta que se cancela), { status, delay } (delay avanza el reloj falso), { error: 'ENOTFOUND' }
// o una función (url, init) => Promise. Registra cada llamada en calls y el orden de inicio/fin en events.
function fakeFetch(rules = {}, clock = null, { gate = null } = {}) {
  const calls = [];
  const events = [];
  const fn = async (url, init = {}) => {
    const host = new URL(url).host;
    calls.push({ url, host, init });
    events.push(`start ${host}`);
    if (gate) await gate.promise;
    let rule = Object.prototype.hasOwnProperty.call(rules, host) ? rules[host] : Object.prototype.hasOwnProperty.call(rules, '*') ? rules['*'] : 'ok';
    try {
      if (typeof rule === 'function') return await rule(url, init);
      if (rule === 'timeout') {
        await new Promise((resolve, reject) => {
          if (init.signal?.aborted) reject(init.signal.reason);
          init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        });
      }
      if (rule === 'ok') rule = 200;
      if (typeof rule === 'number') rule = { status: rule };
      if (rule && rule.error) throw netError(rule.error);
      if (rule && rule.delay && clock) clock.advance(rule.delay);
      return { status: rule.status, ok: rule.status < 400, body: null };
    } finally {
      events.push(`end ${host}`);
    }
  };
  fn.calls = calls;
  fn.events = events;
  fn.count = (host) => calls.filter((c) => c.host === host).length;
  return fn;
}

// Promesa que se abre a mano (para dejar pedidos colgados mientras se prueba la concurrencia).
function gate() {
  let open;
  const promise = new Promise((resolve) => (open = resolve));
  return { promise, open };
}

const CLOUD = { url: 'https://abcdefghijklmnop.supabase.co', anonKey: 'public-anon-key', configured: true };

module.exports = { fakeClock, fakeFetch, gate, netError, CLOUD };
