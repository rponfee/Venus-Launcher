'use strict';
// Historial de rendimiento por partida. Mientras el juego corre se toma una muestra cada 10 s: RAM y CPU del proceso
// (pidusage) y FPS si el mod los informa (perfhistory/fps.js); al cerrar se resume y se guarda (perfhistory/summary.js y
// store.js). Las pruebas de la busqueda del culpable (quiet) no se registran. Es todo local: no sale de la PC.
//   perfhistory:list({ instanceId?, limit? }) -> [partida sin la serie], de la mas nueva a la mas vieja
//   perfhistory:get(id)    -> partida con su serie { t, ram, cpu, fps } (o null)
//   perfhistory:remove(id) -> true · perfhistory:clear() -> true
// Evento perfhistory:updated (cuando se guarda o se borra una partida).
const os = require('os');
const path = require('path');
const paths = require('../core/paths');
const game = require('../core/game');
const instances = require('../core/instances');
const { readFps } = require('./perfhistory/fps');
const { summarize } = require('./perfhistory/summary');
const { createStore } = require('./perfhistory/store');

const SAMPLE_MS = 10 * 1000;
const CHECKPOINT_EVERY = 30; // cada 5 minutos se guarda lo que va (si el launcher se cierra de golpe, no se pierde todo)
const MAX_SAMPLES = 20000; // casi 56 horas seguidas

const st = { ctx: null, store: null, live: new Map(), timer: null, sampling: false };

function pidusage() {
  return require('pidusage');
}

function begin(id, pid, startedAt) {
  // Se anota antes de leer la instancia: un juego que se cierra enseguida no queda midiendo para siempre.
  const session = { id: `${startedAt}-${id}`, instanceId: id, instanceName: id, mcVersion: null, loader: null, start: startedAt, pid, gameDir: null, samples: [] };
  st.live.set(id, session);
  instances
    .get(id)
    .then((inst) => Object.assign(session, { instanceName: inst.name || id, mcVersion: inst.mcVersion || null, loader: inst.preset || inst.loader || null, gameDir: inst.dir || null }))
    .catch(() => {});
  if (!st.timer) {
    st.timer = setInterval(() => sampleAll().catch((err) => console.warn('[perfhistory]', err?.message || err)), SAMPLE_MS);
    st.timer.unref?.();
  }
}

async function sampleOne(s, cpus) {
  let usage;
  try {
    usage = await pidusage()(s.pid);
  } catch {
    return; // el proceso ya no esta: lo cierra el evento de estado
  }
  const fps = s.gameDir ? readFps(s.gameDir) : null;
  s.samples.push({ t: Date.now() - s.start, ram: Math.round(usage.memory / 1048576), cpu: Math.round((usage.cpu / cpus) * 10) / 10, fps: fps ? fps.fps : null });
  // Tope para partidas de dias: se queda con una de cada dos, sin perder la forma de la curva
  if (s.samples.length > MAX_SAMPLES) s.samples = s.samples.filter((_, i) => i % 2 === 0);
  if (s.samples.length % CHECKPOINT_EVERY === 0) await persist(s, { partial: true });
}

async function sampleAll() {
  if (st.sampling) return; // pidusage tarda mas de lo normal: no se pisan
  st.sampling = true;
  try {
    const cpus = os.cpus().length || 1;
    for (const s of [...st.live.values()]) await sampleOne(s, cpus);
  } finally {
    st.sampling = false;
  }
}

async function persist(s, { crashed = false, partial = false } = {}) {
  if (!s.samples.length) return false;
  await st.store.save(summarize({ ...s, end: Date.now(), crashed, partial }));
  return true;
}

async function finish(id, crashed) {
  const s = st.live.get(id);
  if (!s) return;
  st.live.delete(id);
  if (!st.live.size && st.timer) {
    clearInterval(st.timer);
    st.timer = null;
  }
  try {
    pidusage().clear?.();
    if (await persist(s, { crashed })) st.ctx?.send?.('perfhistory:updated', { id: s.id });
  } catch (err) {
    console.warn('[perfhistory] guardar:', err?.message || err);
  }
}

function register({ handle, send, onQuit }) {
  st.ctx = { send };
  st.store = createStore(path.join(paths.root(), 'data', 'perfhistory'));
  st.store.rotate().catch((err) => console.warn('[perfhistory] rotacion:', err?.message || err));

  game.events.on('state', (id, state) => {
    if (state?.quiet) return;
    if (state?.state === 'running' && state.pid) begin(id, state.pid, state.startedAt || Date.now());
    else if (state?.state === 'stopped' || state?.state === 'crashed') finish(id, state.state === 'crashed');
  });

  handle('perfhistory:list', (filter) => {
    const f = filter && typeof filter === 'object' ? filter : {};
    return st.store.list({ instanceId: typeof f.instanceId === 'string' ? f.instanceId : null, limit: Math.max(0, Math.min(2000, Number(f.limit) || 0)) });
  });
  handle('perfhistory:get', (id) => (typeof id === 'string' ? st.store.get(id) : null));
  handle('perfhistory:remove', async (id) => {
    const ok = typeof id === 'string' && (await st.store.remove(id));
    send('perfhistory:updated', { id, removed: true });
    return ok;
  });
  handle('perfhistory:clear', async () => {
    await st.store.clear();
    send('perfhistory:updated', { cleared: true });
    return true;
  });

  onQuit?.(async () => {
    clearInterval(st.timer);
    st.timer = null;
    // El juego puede seguir abierto: queda lo medido hasta aca, marcado como incompleto.
    for (const s of st.live.values()) await persist(s, { partial: true }).catch(() => {});
  });
}

module.exports = { register, SAMPLE_MS };
