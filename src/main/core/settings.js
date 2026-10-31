'use strict';
// Ajustes globales del launcher.
const os = require('os');
const paths = require('./paths');
const { readJson, writeJson } = require('./util');

const FILE = () => paths.data('settings.json');

function recommendedMemory() {
  const totalMb = Math.floor(os.totalmem() / 1048576);
  if (totalMb >= 15000) return { min: 1024, max: 6144 };
  if (totalMb >= 7500) return { min: 1024, max: 4096 };
  if (totalMb >= 5500) return { min: 1024, max: 3072 };
  return { min: 512, max: 2048 };
}

// Cada modulo nuevo guarda sus opciones bajo su propia clave (ej. settings.netplay, settings.discord)
// y aplica sus valores por defecto al leerlas: no hace falta tocar este archivo para agregar opciones.
// Las claves que ya no se usan (github, autoUpdate, peer, music de versiones viejas) se conservan y se ignoran.
function defaults() {
  return {
    language: null, // se elige en la bienvenida; null = todavia no se eligio
    onboarded: false,
    memory: recommendedMemory(),
    memoryMode: 'auto', // 'auto' (segun el equipo) | 'manual'
    jvmPreset: 'auto',
    jvmArgs: '',
    priority: 'normal',
    window: { width: 0, height: 0, fullscreen: false },
    afterLaunch: 'minimize',
    openConsoleOnLaunch: false,
    selectedInstance: null,
    // La nube es siempre la del launcher (core/cloud-defaults.js): las claves cloud y ai.model/ai.provider de
    // versiones anteriores quedan en el archivo y se ignoran.
    ai: { enabled: true },
    voice: {
      inputDevice: 'default',
      outputDevice: 'default',
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      muteShortcut: 'CommandOrControl+Shift+M',
      pushToTalk: false,
      pttKey: 'KeyV',
    },
    profile: { displayName: '' },
    // Documentados aca; sus modulos ya aplican estos mismos valores por defecto.
    downloads: { maxKBps: 0, concurrency: 0, offline: false }, // core/http.js: KB/s (0 = sin limite), descargas a la vez (0 = automatico), sin conexion
    storage: { autoDedupe: false }, // modules/storage.js: unificar duplicados al abrir
    // Conexiones que el launcher haría por su cuenta: apagadas hasta que el usuario las active (aviso al terminar la
    // bienvenida y Ajustes > Privacidad). decided = ya respondió el aviso. Ver README > Privacy policy.
    privacy: { decided: false, autoUpdates: false, news: false, featuredServers: false, playerHeads: false },
  };
}

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

let cache = null;
let loading = null;
let changes = Promise.resolve();

async function get() {
  if (cache) return cache;
  if (!loading) {
    loading = readJson(FILE(), {}).then(saved => {
      // Share initialization: an older disk read cannot overwrite a newly committed cache.
      cache = deepMerge(defaults(), saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {});
      return cache;
    }).finally(() => { loading = null; });
  }
  return loading;
}

const listeners = new Set();

function set(patch) {
  let snapshot;
  try { snapshot = structuredClone(patch || {}); }
  catch (error) { return Promise.reject(error); }
  // Merge against the last committed state, not the state seen when the request arrived.
  // Notify listeners only after the atomic file write succeeds. A failure keeps the old cache.
  const change = changes.then(async () => {
    const next = deepMerge(await get(), snapshot);
    await writeJson(FILE(), next);
    cache = next;
    for (const fn of listeners) {
      try {
        fn(cache, snapshot);
      } catch (err) {
        console.error('[settings]', err);
      }
    }
    return cache;
  });
  changes = change.catch(() => {});
  return change;
}

// Avisa a los modulos cuando cambian los ajustes: onChange((settings, patch) => ...)
function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

module.exports = { get, set, onChange, defaults, recommendedMemory, deepMerge };
