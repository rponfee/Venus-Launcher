// Recordatorio de descansos y tope de horas por dia (3.1). Con game:state (store.running) mide el tiempo de juego
// seguido y el del dia (settings.play.today = { day, minutes }); al cumplirse settings.play.breaks.everyMin avisa en
// el overlay (overlay:push, kind 'alert') y con un toast, y al llegar a dailyLimitMin avisa cada 10 minutos. Nunca
// cierra el juego. Las cuentas estan en pages/tools/breaks.js (sin DOM, con pruebas).
//   startup(); todayMinutesPlayed() -> minutos jugados hoy (para Ajustes)
import { toast } from '../../ui.js';
import { store, api } from '../../store.js';
import { t, loadNs } from '../../i18n.js';
import { normalizeBreaks, createBreakState, tick, dayKey, todayPatch, todayMinutes } from '../../pages/tools/breaks.js';

const T = (key, vars) => t(`tools.${key}`, vars);
const TICK_MS = 30 * 1000;
const SAVE_EVERY_MIN = 5;

let started = false;
let state = null;
let lastSaved = -1;

const playing = () => Object.values(store.running || {}).some((s) => s && s.state === 'running' && !s.quiet);

export function todayMinutesPlayed() {
  if (state && state.day === dayKey()) return todayMinutes(state);
  const saved = store.settings?.play?.today;
  return saved && saved.day === dayKey() ? Math.max(0, Number(saved.minutes) || 0) : 0;
}

function pushOverlay(title, body) {
  api.invoke('overlay:push', { kind: 'alert', icon: 'info', title, body, ttl: 12 }).catch(() => {});
}

async function announce(ev) {
  await loadNs('tools').catch(() => {});
  if (ev.type === 'break') {
    const title = T('breakTitle');
    const body = T('breakBody', { count: ev.minutes });
    toast('info', title, body, 10000);
    pushOverlay(title, body);
  } else if (ev.type === 'limit') {
    const title = T('limitTitle');
    const body = T('limitBody', { minutes: ev.minutes, limit: ev.limit });
    toast('info', title, body, 12000);
    pushOverlay(title, body);
  }
}

function save(force) {
  if (!state) return;
  const mins = todayMinutes(state);
  if (mins === lastSaved) return;
  if (!force && lastSaved >= 0 && mins - lastSaved < SAVE_EVERY_MIN) return;
  lastSaved = mins;
  store.setSettings({ play: { today: todayPatch(state) } }).catch((err) => console.warn('[tools] descansos: guardar', err?.message || err));
}

function step() {
  const day = dayKey();
  if (!state) {
    state = createBreakState(store.settings?.play?.today, day);
    lastSaved = todayMinutes(state);
  }
  const cfg = normalizeBreaks(store.settings?.play?.breaks);
  const now = Date.now();
  const isPlaying = playing();
  const events = tick(state, cfg, { now, playing: isPlaying, day });
  for (const ev of events) announce(ev);
  save(!isPlaying);
}

export function startup() {
  if (started) return;
  started = true;
  step();
  setInterval(step, TICK_MS);
  // Al abrir o cerrar un juego se recalcula enseguida (el rato seguido vuelve a cero al cerrar).
  api.on('game:state', (_id, st) => {
    if (st && !st.quiet) setTimeout(step, 300);
  });
}
