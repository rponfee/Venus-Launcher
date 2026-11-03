// Logros de Venus (3.0): comprueba con los datos de esta PC cuales se cumplieron, los reclama de a varios y pide al
// servidor que compruebe los suyos. No hay tope de cantidad: el catalogo esta en pages/achievements/catalog.js.
//   startup()                 lo llama app.js: revisa un rato despues de abrir, al cerrar el juego y cada 30 minutos
//   checkAchievements({ force? }) -> revisa ahora (la pagina de Logros lo usa al abrirse)
//   loadAchievements({ force? }) -> estado compartido; getAchievements(); onAchievements(fn) -> off
// Estado: { user, unlocked: Map(id -> fecha), rarity, totalUsers, serverMetrics, metrics, clientToday, clientCap, error }
// Los que informa la PC tienen un tope diario en el servidor: lo que no entra se vuelve a intentar en la proxima revision.
import { toast } from '../ui.js';
import { store, api } from '../store.js';
import { t, loadNs, locale } from '../i18n.js';
import { backend } from '../pages/rewards/backend.js';
import { metricsFrom, clientMet, ACHIEVEMENT_BY_ID } from '../pages/achievements/catalog.js';
import { achievementName } from '../pages/achievements/names.js';
import { formatPoints } from '../pages/rewards/logic.js';
import { loadSummary } from './rewards.js';

const A = (key, vars) => t(`achievements.${key}`, vars);
const STATE_TTL = 60 * 1000;
const CHECK_EVERY = 30 * 60 * 1000;
const FIRST_CHECK = 45 * 1000;
const TOASTS_MAX = 3;

const state = { user: null, unlocked: new Map(), rarity: {}, totalUsers: 0, serverMetrics: {}, metrics: {}, clientToday: 0, clientCap: 40, error: null, at: 0 };
const listeners = new Set();

function changed() {
  for (const fn of [...listeners]) {
    try {
      fn(state);
    } catch (err) {
      console.error(err);
    }
  }
}

export const getAchievements = () => state;
export function onAchievements(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Medidas locales: cada fuente es opcional (la pagina dibuja lo que haya)
async function collectMetrics() {
  const [report, ingame, local, media] = await Promise.all([
    api.invoke('stats:report').catch(() => null),
    api.invoke('stats:ingame', {}).catch(() => null),
    api.invoke('achievements:localCounts').catch(() => null),
    api.invoke('worlds:media', {}).catch(() => null),
  ]);
  const counts = { ...(local || {}), screenshots: media?.counts?.screenshots, clips: media?.counts?.clips };
  const metrics = metricsFrom({ report, ingame, local: counts, instances: store.instances?.length ?? null, localServers: store.servers?.length ?? null });
  state.metrics = metrics;
  return metrics;
}

export async function loadAchievements({ force = false } = {}) {
  const b = await backend();
  const user = b.signedIn() ? b.userId() : null;
  if (!user) {
    Object.assign(state, { user: null, unlocked: new Map(), rarity: {}, totalUsers: 0, serverMetrics: {}, error: 'noSession', at: Date.now() });
    changed();
    return state;
  }
  if (!force && state.user === user && Date.now() - state.at < STATE_TTL && !state.error) return state;
  try {
    const d = await b.rpc('achievements_me');
    Object.assign(state, {
      user,
      unlocked: new Map(Object.entries(d?.unlocked || {})),
      rarity: d?.rarity || {},
      totalUsers: Number(d?.totalUsers) || 0,
      serverMetrics: d?.metrics || {},
      clientToday: Number(d?.clientToday) || 0,
      clientCap: Number(d?.clientCap) || 40,
      error: null,
      at: Date.now(),
    });
  } catch (err) {
    state.error = err?.code || 'server';
    if (state.user !== user) Object.assign(state, { user, unlocked: new Map() });
  }
  changed();
  return state;
}

async function announce(list) {
  if (!list.length) return;
  await Promise.all([loadNs('achievements'), loadNs('rewards')]).catch(() => {});
  const total = list.reduce((sum, x) => sum + (Number(x.points) || 0), 0);
  if (list.length > TOASTS_MAX) {
    // Los que ya estaban cumplidos al actualizar llegan juntos: un solo aviso
    toast('good', A('toastMany', { n: list.length }), total > 0 ? A('toastPoints', { points: formatPoints(total, locale()) }) : null, 7000);
    return;
  }
  for (const x of list) {
    const name = achievementName(x.id);
    toast('good', A('toastOne', { name }), x.points > 0 ? A('toastPoints', { points: formatPoints(x.points, locale()) }) : null, 6000);
    api.invoke('overlay:push', { kind: 'alert', title: A('toastOverlay'), body: name, icon: 'achievement', ttl: 6 }).catch(() => {});
  }
  window.dispatchEvent(new CustomEvent('venus:mission', { detail: { metric: 'achievements', amount: list.length } }));
}

let checking = null;
export function checkAchievements({ force = false } = {}) {
  if (checking) return checking;
  checking = (async () => {
    const b = await backend();
    if (!b.signedIn()) {
      await collectMetrics().catch(() => null);
      await loadAchievements();
      return;
    }
    const before = await loadAchievements({ force });
    if (before.error === 'unavailable' || before.error === 'banned') return;
    const metrics = await collectMetrics();
    const fresh = [];
    const pending = clientMet(metrics, before.unlocked);
    if (pending.length) {
      const res = await b.rpc('achievements_claim', { p_ids: pending.slice(0, 100) }).catch((err) => {
        console.warn('[logros] reclamar:', err?.code || err?.message || err);
        return null;
      });
      fresh.push(...(res?.unlocked || []));
    }
    const sweep = await b.rpc('achievements_sweep').catch((err) => {
      console.warn('[logros] servidor:', err?.code || err?.message || err);
      return null;
    });
    fresh.push(...(sweep?.unlocked || []));
    const known = fresh.filter((x) => x && typeof x.id === 'string' && ACHIEVEMENT_BY_ID.has(x.id));
    if (fresh.length) {
      await loadAchievements({ force: true });
      loadSummary({ force: true }).catch(() => {});
    } else changed();
    await announce(known);
  })()
    .catch((err) => console.warn('[logros]', err?.message || err))
    .finally(() => {
      checking = null;
    });
  return checking;
}

let started = false;
export async function startup() {
  if (started) return;
  started = true;
  await loadNs('achievements').catch(() => {});
  setTimeout(() => checkAchievements(), FIRST_CHECK);
  setInterval(() => checkAchievements(), CHECK_EVERY);
  // Al cerrar el juego cambian las estadisticas
  api.on('game:state', (_id, st) => {
    if (st && !st.quiet && st.state !== 'running' && st.state !== 'preparing') setTimeout(() => checkAchievements({ force: true }), 5000);
  });
  // Primera vez que el overlay se ve sobre el juego (las pruebas de Ajustes no cuentan)
  api.on('overlay:state', (s) => {
    if (s?.visible && !s.testing && !s.editing && s.running) window.dispatchEvent(new CustomEvent('venus:achievement', { detail: { id: 'first_overlay' } }));
  });
  // Logros que avisa otra parte del launcher (ver features/rewards.js): se reflejan en la pagina
  window.addEventListener('venus:achievement', () => setTimeout(() => loadAchievements({ force: true }).catch(() => {}), 2500));
  const { cloud } = await import('../cloud.js');
  cloud.on('auth', () => setTimeout(() => checkAchievements({ force: true }), 3000));
}
