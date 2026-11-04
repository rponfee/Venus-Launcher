'use strict';
// Contadores en pantalla: muertes, bloques minados y tiempo de sesion, desde que se abrio el juego.
//   Un jugador solo: saves/<mundo>/stats/<uuid>.json, que el juego guarda cada pocos minutos y al pausar (por eso los
//   bloques no cambian al instante). Las muertes tambien se cuentan en vivo con el registro del juego (capture/gamelog).
//   Multijugador: el archivo queda en el servidor; solo hay las muertes que aparecen en el chat.
// Sin Electron: lo prueban overlay/test/counters.test.js.
const fsp = require('fs/promises');
const path = require('path');

const INTERVAL_MS = 5000;
const DEATH_GATE_MS = 2000; // el mismo aviso sale dos veces en un mundo propio: por el servidor y por el chat

const count = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

// JSON del archivo de estadisticas -> { deaths, mined }. Desde 1.13 van por categorias; antes, con claves planas.
function parseStats(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { deaths: 0, mined: 0 };
  const stats = raw.stats && typeof raw.stats === 'object' ? raw.stats : null;
  if (stats) {
    const mined = stats['minecraft:mined'] && typeof stats['minecraft:mined'] === 'object' ? Object.values(stats['minecraft:mined']).reduce((a, v) => a + count(v), 0) : 0;
    return { deaths: count(stats['minecraft:custom']?.['minecraft:deaths']), mined };
  }
  let mined = 0;
  for (const [k, v] of Object.entries(raw)) if (k.startsWith('stat.mineBlock.')) mined += count(v);
  return { deaths: count(raw['stat.deaths']), mined };
}

// Cuenta de una partida: cada mundo o servidor es un tramo con la foto inicial de sus estadisticas (base). Lo de antes
// de abrir el juego no suma: se cuenta la diferencia contra esa foto.
function createTally() {
  return { key: null, base: null, last: null, log: 0, done: { deaths: 0, mined: 0 }, sawStats: false };
}

const segment = (t) => {
  const stat = t.base && t.last ? { deaths: Math.max(0, t.last.deaths - t.base.deaths), mined: Math.max(0, t.last.mined - t.base.mined) } : { deaths: 0, mined: 0 };
  return { deaths: Math.max(stat.deaths, t.log), mined: stat.mined };
};

// Entra a otro mundo o servidor (key = 'world:<carpeta>' o 'server:<direccion>'). Lo del tramo anterior queda sumado.
function enter(t, key) {
  if (t.key === key) return;
  const seg = segment(t);
  t.done = { deaths: t.done.deaths + seg.deaths, mined: t.done.mined + seg.mined };
  t.key = key;
  t.base = null;
  t.last = null;
  t.log = 0;
}

// Estadisticas leidas del tramo actual. La primera lectura es la foto inicial.
function observe(t, stats) {
  const s = stats || { deaths: 0, mined: 0 };
  if (!t.base) t.base = { ...s };
  t.last = { ...s };
  t.sawStats = true;
}

function addDeath(t) {
  t.log++;
}

// -> { deaths, mined (null si nunca hubo archivo: solo multijugador), multiplayer }
function view(t) {
  const seg = segment(t);
  return {
    deaths: t.done.deaths + seg.deaths,
    mined: t.sawStats ? t.done.mined + seg.mined : null,
    multiplayer: String(t.key || '').startsWith('server:'),
  };
}

// Una muerte por vez: en un mundo propio la misma muerte aparece por el servidor y por el chat, casi juntas.
function createDeathGate(windowMs = DEATH_GATE_MS, now = Date.now) {
  let last = -Infinity;
  return () => {
    const t = now();
    if (t - last < windowMs) return false;
    last = t;
    return true;
  };
}

// Los archivos de estadisticas llevan el uuid con guiones; las cuentas lo pueden guardar sin ellos
function dashUuid(u) {
  const s = String(u || '').replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(s)) return null;
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

// Carpeta de un mundo: viene de leer saves/, igual se revisa antes de armar una ruta con ella
const validWorld = (s) => typeof s === 'string' && s.length > 0 && s.length <= 255 && s !== '.' && s !== '..' && !/[\\/\x00-\x1f]/.test(s);

// Archivo de estadisticas del jugador en un mundo: el de la cuenta o, si no esta, el mas reciente
async function statsFile(dir, uuid) {
  if (uuid) {
    const own = path.join(dir, `${uuid}.json`);
    const st = await fsp.stat(own).catch(() => null);
    if (st?.isFile()) return { file: own, mtime: st.mtimeMs };
  }
  let names = [];
  try {
    names = (await fsp.readdir(dir)).filter((n) => /\.json$/i.test(n));
  } catch {
    return null;
  }
  let best = null;
  for (const n of names.slice(0, 64)) {
    const st = await fsp.stat(path.join(dir, n)).catch(() => null);
    if (st?.isFile() && (!best || st.mtimeMs > best.mtime)) best = { file: path.join(dir, n), mtime: st.mtimeMs };
  }
  return best;
}

/**
 * Sigue una partida y avisa los contadores. getActivity() -> la de core/game ({ type, world?, address? } o null).
 * onUpdate({ kind: 'counters', deaths, mined, session, multiplayer }) cada `interval` ms.
 */
function createWatch({ instanceDir, uuid = null, startedAt, getActivity, onUpdate, interval = INTERVAL_MS, now = Date.now, gateMs = DEATH_GATE_MS }) {
  const tally = createTally();
  const gate = createDeathGate(gateMs, now);
  let timer = null;
  let stopped = false;
  let busy = false;
  let seen = null;

  const emit = () => {
    if (stopped) return;
    const started = Number(startedAt);
    const session = Number.isFinite(started) && started > 0 ? Math.max(0, Math.floor((now() - started) / 1000)) : null;
    try {
      onUpdate?.({ kind: 'counters', ...view(tally), session });
    } catch (err) {
      console.warn('[overlay] contadores', err?.message || err);
    }
  };

  const read = async () => {
    const act = getActivity?.() || null;
    if (act?.type === 'server' && act.address) enter(tally, `server:${act.address}`);
    else if (act?.type === 'singleplayer' && validWorld(act.world) && instanceDir) {
      const key = `world:${act.world}`;
      if (tally.key !== key) seen = null;
      enter(tally, key);
      const found = await statsFile(path.join(instanceDir, 'saves', act.world, 'stats'), uuid);
      if (!found) {
        // Mundo nuevo: todavia no hay archivo, asi que la foto inicial es cero
        if (!tally.base) observe(tally, null);
      } else if (seen !== `${found.file}|${found.mtime}`) {
        try {
          observe(tally, parseStats(JSON.parse(await fsp.readFile(found.file, 'utf8'))));
          seen = `${found.file}|${found.mtime}`;
        } catch {
          /* el juego lo estaba guardando: va en la proxima vuelta */
        }
      }
    }
  };

  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      await read();
    } catch (err) {
      console.warn('[overlay] contadores', err?.message || err);
    }
    busy = false;
    emit();
    if (!stopped) {
      timer = setTimeout(tick, interval);
      timer.unref?.();
    }
  };
  tick();

  return {
    // Muerte vista en el registro del juego
    death() {
      if (!gate()) return false;
      addDeath(tally);
      emit();
      return true;
    },
    view: () => view(tally),
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

module.exports = { dashUuid, parseStats, createTally, enter, observe, addDeath, view, createDeathGate, createWatch, INTERVAL_MS, DEATH_GATE_MS };
