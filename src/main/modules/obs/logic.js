'use strict';
// Reglas de la integracion con OBS, sin Electron (se prueban con node:test): ajustes, host permitido, espera entre
// reintentos y qué escena poner al abrir o cerrar el juego.
const DEFAULT_PORT = 4455;
const BACKOFF = { first: 3000, max: 5 * 60000 };

// Solo la misma PC o la red local: la contraseña no sale a internet y nada se conecta afuera
function isLocalHost(raw) {
  const host = String(raw || '').trim().toLowerCase();
  if (!host || host.length > 253) return false;
  if (host === 'localhost' || host === '::1' || /\.local$/.test(host)) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((n) => n > 255)) return false;
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

const cleanScene = (v) => (typeof v === 'string' ? v.trim().slice(0, 256) : '');

// settings.obs completo. Apagado por defecto; los ajustes antiguos de streamer se ignoran.
function normalizeSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const port = Math.round(Number(s.port));
  return {
    enabled: s.enabled === true,
    host: isLocalHost(s.host) ? String(s.host).trim() : '127.0.0.1',
    port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_PORT,
    sceneOnOpen: cleanScene(s.sceneOnOpen),
    sceneOnClose: cleanScene(s.sceneOnClose),
  };
}

// Espera antes del intento n (0, 1, 2...): crece al doble hasta 5 minutos. Con OBS cerrado no molesta a nadie.
function backoff(attempt) {
  const n = Math.max(0, Math.floor(Number(attempt) || 0));
  return Math.min(BACKOFF.max, BACKOFF.first * 2 ** Math.min(n, 12));
}

// Escena a poner cuando se abre o se cierra el juego (solo si hay otro juego abierto, la de cerrar no se pone)
function sceneFor(event, cfg, { othersRunning = false } = {}) {
  if (event === 'open') return cfg.sceneOnOpen || null;
  if (event === 'close') return othersRunning ? null : cfg.sceneOnClose || null;
  return null;
}

module.exports = { DEFAULT_PORT, BACKOFF, isLocalHost, normalizeSettings, backoff, sceneFor };
