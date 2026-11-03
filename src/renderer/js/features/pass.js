// Venus Pass (3.1): el estado del pase que comparten la página y el menú, los minutos jugados que se reportan al
// servidor (1 XP por minuto, hasta 120 por día: pass_playtime), el aviso al subir de nivel y el punto en el menú
// cuando hay premios para reclamar. Reglas y RPC: supabase/migrations/0026_venus_pass.sql · guía: docs/venus-pass.md.
//   startup(), getPass() -> { data, error, at }, onPass(fn) -> off, loadPass({ force? }), claim(level, track),
//   claimAll(), reportPlaytime(minutes), passBackend() -> { rpc }
import { toast, fail } from '../ui.js';
import { store, api } from '../store.js';
import { t, loadNs, has } from '../i18n.js';
import { setNavBadge } from '../app.js';
import { backend } from '../pages/rewards/backend.js';
import { normalizeMe, levelsGained, playtimeBatches, seasonState } from '../pages/pass/logic.js';
import { loadSummary } from './rewards.js';

const P = (key, vars) => t(`pass.${key}`, vars);
const STATE_TTL = 3 * 60 * 1000;
const REPORT_EVERY_MIN = 5; // cada cuántos minutos de juego se avisa al servidor

const state = { data: null, error: null, at: 0, user: null };
const listeners = new Set();
let backendPromise = null;
let fakePass = null;
let loading = null;

export const getPass = () => state;

export function onPass(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  setNavBadge('pass', state.data && state.data.claimable > 0 ? 1 : 0, 'dot');
  for (const fn of [...listeners]) {
    try {
      fn(state);
    } catch (err) {
      console.error(err);
    }
  }
}

// El backend de Venus Points (real o, en capturas, el falso) más el falso del pase cuando corresponde.
export async function passBackend() {
  const b = await backend();
  if (b.fake) {
    if (!fakePass) {
      const { createFakePass } = await import('../pages/pass/fake.js');
      const scenario = await api.invoke('rewards:fakeMode').catch(() => null);
      fakePass = createFakePass(typeof scenario === 'string' ? scenario : 'demo');
    }
    return { fake: true, signedIn: b.signedIn, userId: b.userId, onAuth: b.onAuth, rpc: (name, args) => fakePass.rpc(name, args), grant: (tier) => fakePass.grant(tier) };
  }
  return { fake: false, signedIn: b.signedIn, userId: b.userId, onAuth: b.onAuth, rpc: (name, args) => b.rpc(name, args) };
}

export async function loadPass({ force = false } = {}) {
  const b = await passBackend();
  if (!b.signedIn()) {
    state.data = null;
    state.error = null;
    state.user = null;
    emit();
    return state;
  }
  const user = b.userId();
  if (!force && state.user === user && state.at && Date.now() - state.at < STATE_TTL && !state.error) return state;
  if (loading) return loading;
  loading = (async () => {
    try {
      await loadNs('pass');
      const prev = state.user === user ? state.data : null;
      const data = normalizeMe(await b.rpc('pass_me'));
      state.data = data;
      state.error = null;
      state.user = user;
      state.at = Date.now();
      const gained = levelsGained(prev, data);
      if (gained > 0 && !document.hidden) {
        toast('good', P('levelUpTitle', { level: data.level }), data.claimable > 0 ? P('levelUpClaim', { count: data.claimable, n: data.claimable }) : P('levelUpText'), 6000);
      }
    } catch (err) {
      state.error = err;
      state.at = Date.now();
    } finally {
      loading = null;
    }
    emit();
    return state;
  })();
  return loading;
}

export async function claim(level, track) {
  const b = await passBackend();
  const res = await b.rpc('pass_claim', { p_level: level, p_track: track });
  await Promise.all([loadPass({ force: true }), loadSummary({ force: true }).catch(() => {})]);
  return res;
}

export async function claimAll() {
  const b = await passBackend();
  const res = await b.rpc('pass_claim_all');
  await Promise.all([loadPass({ force: true }), loadSummary({ force: true }).catch(() => {})]);
  return res;
}

// ---------- Minutos jugados ----------
let pendingMinutes = 0;
let reporting = false;

export async function reportPlaytime(minutes) {
  pendingMinutes += Math.max(0, Math.floor(minutes));
  if (reporting || pendingMinutes < 1) return;
  const b = await passBackend();
  if (!b.signedIn()) return;
  const data = state.data;
  if (data && seasonState(data.season) !== 'active') return;
  reporting = true;
  try {
    const batches = playtimeBatches(pendingMinutes, data?.playToday || 0, data?.playCap);
    pendingMinutes = 0;
    for (const n of batches) {
      const r = await b.rpc('pass_playtime', { p_minutes: n });
      if (state.data) state.data.playToday = Math.max(state.data.playToday, Number(r?.today) || 0);
      if (!r || Number(r.added) < n) break; // llegó al tope del día
    }
    if (batches.length) await loadPass({ force: true });
  } catch (err) {
    console.warn('[pass] minutos jugados', err?.message || err);
  } finally {
    reporting = false;
  }
}

function watchGames() {
  const running = new Map(); // id -> último minuto contado
  let timer = null;
  const tick = () => {
    const now = Date.now();
    let minutes = 0;
    for (const [id, last] of running) {
      const whole = Math.floor((now - last) / 60000);
      if (whole >= REPORT_EVERY_MIN) {
        minutes += whole;
        running.set(id, last + whole * 60000);
      }
    }
    if (minutes > 0) reportPlaytime(minutes);
  };
  api.on('game:state', (id, st) => {
    if (!st || st.quiet) return;
    if (st.state === 'running') {
      if (!running.has(id)) running.set(id, Date.now());
    } else if (running.has(id)) {
      const whole = Math.floor((Date.now() - running.get(id)) / 60000);
      running.delete(id);
      if (whole > 0) reportPlaytime(whole);
    }
    if (running.size && !timer) timer = setInterval(tick, 60000);
    if (!running.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  });
}

// ---------- Arranque ----------
let started = false;
export async function startup() {
  if (started) return;
  started = true;
  try {
    await loadNs('pass');
  } catch (err) {
    console.warn('[pass] textos', err?.message || err);
  }
  watchGames();
  // Pago acreditado: el pase (o la edición mejor) ya está en la cuenta.
  api.on('billing:changed', (info) => {
    if (info?.kind === 'pass' || String(info?.plan || '').startsWith('pass_')) loadPass({ force: true }).catch(() => {});
  });
  // Al reclamar logros o misiones cambian los puntos, y los puntos son XP.
  window.addEventListener('venus:achievement', () => setTimeout(() => loadPass({ force: true }).catch(() => {}), 4000));
  window.addEventListener('venus:mission', () => setTimeout(() => loadPass({ force: true }).catch(() => {}), 4000));
  const b = await passBackend().catch(() => null);
  if (!b) return;
  b.onAuth?.(() => loadPass({ force: true }).catch(() => {}));
  if (store.info?.devshot && !b.fake) return; // capturas sin datos falsos: no consultar nada
  loadPass().catch(() => {});
}

/** Nombre traducido de un cosmético del pase (los de la tienda ya los traduce rewards). */
export function passItemName(id) {
  return has(`pass.item_${id}`) ? P(`item_${id}`) : null;
}
