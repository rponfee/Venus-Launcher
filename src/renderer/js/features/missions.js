// Misiones de Venus (3.0): 3 diarias y 3 semanales por cuenta, elegidas por el servidor (missions_me, 0023). El launcher
// cuenta el progreso de esta PC en settings.rewards.missions y el servidor paga cada una una sola vez por periodo.
// Otras partes suman progreso con window 'venus:mission' ({ metric, amount? }). El periodo es UTC, igual que en el servidor.
//   startup(), getMissions(), onMissions(fn) -> off, loadMissions({ force? }), claimMission(id) -> resultado
import { toast, fail } from '../ui.js';
import { store, api } from '../store.js';
import { t, loadNs, locale } from '../i18n.js';
import { setNavBadge } from '../app.js';
import { backend } from '../pages/rewards/backend.js';
import { formatPoints } from '../pages/rewards/logic.js';
import { missionText } from '../pages/achievements/names.js';
import { dailyKey, weeklyKey } from '../pages/achievements/catalog.js';
import { loadSummary } from './rewards.js';

const A = (key, vars) => t(`achievements.${key}`, vars);
const STATE_TTL = 5 * 60 * 1000;


const state = { data: null, error: null, at: 0, user: null };
const listeners = new Set();
const notified = new Set();

function progressStore() {
  const m = store.settings?.rewards?.missions;
  const out = m && typeof m === 'object' ? m : {};
  return { daily: out.daily || { key: null, m: {} }, weekly: out.weekly || { key: null, m: {} } };
}

let mem = null;
let saveTimer = null;
function progress() {
  if (!mem) mem = progressStore();
  const dk = dailyKey();
  const wk = weeklyKey();
  if (mem.daily.key !== dk) mem.daily = { key: dk, m: {} };
  if (mem.weekly.key !== wk) mem.weekly = { key: wk, m: {} };
  return mem;
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    store.setSettings({ rewards: { missions: mem } }).catch((err) => console.warn('[misiones] guardar:', err?.message || err));
  }, 4000);
}

export function missionValue(period, metric) {
  return Number(progress()[period]?.m?.[metric]) || 0;
}

function changed() {
  const ready = claimable();
  setNavBadge('achievements', ready.length ? 1 : 0, 'dot');
  for (const fn of [...listeners]) {
    try {
      fn(state);
    } catch (err) {
      console.error(err);
    }
  }
}

function claimable() {
  const out = [];
  for (const period of ['daily', 'weekly']) {
    for (const m of state.data?.[period]?.missions || []) if (!m.claimed && missionValue(period, m.metric) >= m.target) out.push({ ...m, period });
  }
  return out;
}

export function bump(metric, amount = 1) {
  const p = progress();
  for (const period of ['daily', 'weekly']) p[period].m[metric] = (Number(p[period].m[metric]) || 0) + amount;
  save();
  for (const m of claimable()) {
    if (notified.has(`${state.data?.[m.period]?.key}:${m.id}`)) continue;
    notified.add(`${state.data?.[m.period]?.key}:${m.id}`);
    toast('good', A('missionReady'), missionText(m.metric, m.target), 6000);
  }
  changed();
}

export const getMissions = () => state;
export function onMissions(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function loadMissions({ force = false } = {}) {
  const b = await backend();
  const user = b.signedIn() ? b.userId() : null;
  if (!user) {
    Object.assign(state, { data: null, error: 'noSession', user: null, at: Date.now() });
    changed();
    return state;
  }
  const stale = state.data && (state.data.daily?.key !== dailyKey() || state.data.weekly?.key !== weeklyKey());
  if (!force && !stale && state.user === user && state.data && Date.now() - state.at < STATE_TTL) return state;
  try {
    Object.assign(state, { data: await b.rpc('missions_me'), error: null, user, at: Date.now() });
  } catch (err) {
    Object.assign(state, { error: err?.code || 'server', user, at: Date.now() });
  }
  changed();
  return state;
}

export async function claimMission(id) {
  const b = await backend();
  try {
    const res = await b.rpc('mission_claim', { p_id: id });
    await loadMissions({ force: true });
    loadSummary({ force: true }).catch(() => {});
    if (res?.points > 0) {
      const pts = (Number(res.points) || 0) + (Number(res.bonus) || 0);
      toast('good', res.bonus > 0 ? A('missionBonusDone') : A('missionDone'), A('toastPoints', { points: formatPoints(pts, locale()) }), 5000);
    }
    return res;
  } catch (err) {
    if (err?.code !== 'bad_mission') fail(A('missionError'), err);
    await loadMissions({ force: true });
    return null;
  }
}

let started = false;
export async function startup() {
  if (started) return;
  started = true;
  await loadNs('achievements').catch(() => {});
  loadMissions().catch(() => {});

  window.addEventListener('venus:mission', (e) => {
    const metric = e?.detail?.metric;
    if (typeof metric === 'string') bump(metric, Number(e.detail.amount) || 1);
  });
  // Tiempo de juego: un minuto por minuto con el juego abierto (las partidas de prueba no cuentan)
  setInterval(() => {
    const running = Object.values(store.running || {}).some((s) => s?.state === 'running' && !s.quiet);
    if (running) bump('playMinutes');
  }, 60 * 1000);
  api.on('game:state', (_id, st) => {
    if (st?.state === 'running' && !st.quiet) bump('launches');
  });
  const seenPlaces = new Set();
  api.on('game:activity', (id, act, meta) => {
    if (!act || act.quiet || meta?.quiet) return;
    const key = `${id}:${act.type}:${act.address || act.world || ''}`;
    if (seenPlaces.has(key)) return;
    seenPlaces.add(key);
    if (act.type === 'server') bump('serverJoins');
    else if (act.type === 'singleplayer') bump('worldVisits');
  });
  api.on('capture:saved', (evt) => {
    if (evt?.kind === 'screenshot' || evt?.type === 'screenshot') bump('screenshots');
    else if (evt) bump('clips');
  });
  try {
    const { voice } = await import('../voice.js');
    let inRoom = Boolean(voice.room);
    voice.on('room', () => {
      const now = Boolean(voice.room);
      if (now && !inRoom) {
        bump('voiceJoins');
        window.dispatchEvent(new CustomEvent('venus:achievement', { detail: { id: 'first_voice' } }));
      }
      inRoom = now;
    });
  } catch {
    /* sin voz: esas misiones se completan con otra cosa */
  }
  // Cambio de dia o semana con el launcher abierto
  setInterval(() => loadMissions().catch(() => {}), 10 * 60 * 1000);
}
