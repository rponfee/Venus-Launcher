'use strict';
// Ayudantes de las pruebas de la musica de perfil: respuestas guardadas de Openverse, fetch falso y reloj falso. Sin red.
const fs = require('fs');
const path = require('path');

const FIXTURES = path.join(__dirname, 'fixtures');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

// Respuestas guardadas de api.openverse.org/v1/audio/ (pedidos reales del 5/11/2026; titulos y autores reemplazados).
//   jamendo-search / wikimedia-search / mixed-search / freesound-search: 200 con resultados reales
//   throttled-429: el cuerpo documentado de un 429 (no se pudo provocar uno real: la API aguantó 24 pedidos seguidos)
function jsonResponse(status, body, headers = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function fakeClock(start = 1_800_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms), set: (v) => (t = v), sleep: async (ms) => void (t += ms) };
}

// Almacen en memoria con la misma interfaz que el de disco
function memoryStore(initial = null) {
  let data = initial;
  return {
    read: async () => (data ? JSON.parse(JSON.stringify(data)) : null),
    write: async (s) => void (data = JSON.parse(JSON.stringify(s))),
    peek: () => data,
  };
}

// responder: array de respuestas (o funciones) que se usan en orden (la ultima se repite), o una funcion (url, init, n)
function fakeFetch(responder) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const r = typeof responder === 'function' ? responder(String(url), init, calls.length) : responder[Math.min(calls.length - 1, responder.length - 1)];
    const v = typeof r === 'function' ? r(String(url), init) : r;
    if (v instanceof Error) throw v;
    return v instanceof Promise ? v : v;
  };
  fn.calls = calls;
  return fn;
}

module.exports = { fixture, jsonResponse, fakeClock, memoryStore, fakeFetch };
