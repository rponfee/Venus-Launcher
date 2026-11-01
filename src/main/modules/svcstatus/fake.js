'use strict';
// Estado de los servicios: fetch simulado SOLO para capturas de desarrollo (VENUS_DEVSHOT + VENUS_SVCSTATUS_FAKE,
// nunca en la app empaquetada; lo decide svcstatus.js). No habla con ningún servidor: contesta según el host.
// Escenarios: ok, internet, dns, tls, microsoft, mojang, modrinth, venus, slow, blocked, cloudflare (la prueba
// de conexión no contesta pero los servicios sí: la conexión se deduce de ellos).

const SCENARIOS = Object.freeze({
  ok: {},
  cloudflare: { 'www.cloudflare.com': 'netdown', '1.1.1.1': 'netdown' },
  internet: { '*': 'netdown' },
  dns: { '*': 'dns', '1.1.1.1': 'ok' },
  tls: { '*': 'tls' },
  microsoft: { 'login.live.com': 503, 'user.auth.xboxlive.com': 'timeout' },
  mojang: { 'piston-meta.mojang.com': 503, 'libraries.minecraft.net': 'timeout', 'resources.download.minecraft.net': 'slow' },
  modrinth: { 'api.modrinth.com': 502 },
  venus: { '*.supabase.co': 503 },
  slow: { '*': 'slow' },
  blocked: { '*': 'timeout', 'www.cloudflare.com': 'ok', '1.1.1.1': 'ok' },
});

const scenarioName = (name) => (typeof name === 'string' && Object.prototype.hasOwnProperty.call(SCENARIOS, name) ? name : null);

function behaviorFor(scenario, host) {
  const map = SCENARIOS[scenario] || {};
  if (Object.prototype.hasOwnProperty.call(map, host)) return map[host];
  for (const [k, v] of Object.entries(map)) if (k.startsWith('*.') && host.endsWith(k.slice(1))) return v;
  return Object.prototype.hasOwnProperty.call(map, '*') ? map['*'] : 'ok';
}

// Demora estable por host (para que los milisegundos no cambien en cada captura).
function latencyOf(host) {
  let n = 0;
  for (const ch of host) n = (n * 31 + ch.charCodeAt(0)) % 997;
  return 70 + (n % 230);
}

function netError(code) {
  return Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });
}

function createFakeFetch(scenario, { slowMs = 2900 } = {}) {
  const name = scenarioName(scenario) || 'ok';
  return (url, init = {}) =>
    new Promise((resolve, reject) => {
      let host = '';
      try {
        host = new URL(url).host;
      } catch {
        reject(netError('ENOTFOUND'));
        return;
      }
      const b = behaviorFor(name, host);
      const signal = init.signal;
      let timer = null;
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      if (b === 'timeout') return; // no contesta: espera a que se cancele por tiempo
      const fast = b === 'dns' || b === 'netdown' || b === 'tls';
      timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        if (typeof b === 'number') resolve({ status: b, ok: false, body: null });
        else if (b === 'dns') reject(netError('ENOTFOUND'));
        else if (b === 'netdown') reject(netError(/^\d/.test(host) ? 'ENETUNREACH' : 'EAI_AGAIN'));
        else if (b === 'tls') reject(netError('SELF_SIGNED_CERT_IN_CHAIN'));
        else resolve({ status: 200, ok: true, body: null });
      }, fast ? 25 : b === 'slow' ? slowMs : latencyOf(host));
    });
}

module.exports = { SCENARIOS, scenarioName, createFakeFetch, behaviorFor };
