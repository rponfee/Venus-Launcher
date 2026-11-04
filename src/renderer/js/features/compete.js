// Competir (docs/wip/competir-33.md): lo que corre con el launcher abierto aunque no se abra la página. Manda lo jugado si
// el usuario prendió compartir (apagado de entrada), avisa de los desafíos (al recibir, al aceptar y al terminar) y de lo
// anotado en el calendario, 15 minutos antes. Reglas y RPC: supabase/migrations/0031_competencia.sql.
//   startup(), competeBackend() -> { fake, signedIn, userId, onAuth, rpc, friends }, errText(err)
//   shareEnabled(), setShare(on), forgetShared(), reportNow(), shareCard() -> Element (Ajustes -> Privacidad)
//   getChallenges() -> { data, error, at }, onChallenges(fn) -> off, loadChallenges({ force? }), tellFriend(userId)
//   loadMyEvents({ force? })
import { h, icon, ensureCss, mount, confirmDialog, fail, ok, setBusy, switchEl, registerIcons } from '../ui.js';
import { store, api } from '../store.js';
import { t, loadNs, has } from '../i18n.js';
import { navigate, setNavBadge } from '../app.js';
import { social } from '../social.js';
import { backend } from '../pages/rewards/backend.js';
import { registerSettingsCard } from '../settings-cards.js';
import { actionToast, pushOverlay, isPlaying } from './party/toasts.js';
import { loadSummary } from './rewards.js';
import { challengeNotices, groupChallenges, nextSettleAt, normalizeChallenge, normalizeEvent, dueReminders, pruneReminded, reminderKey } from '../pages/compete/logic.js';
import { friendName, goalText, metricName } from '../pages/compete/format.js';

registerIcons({
  cpDiamond: '<path d="M6 3h12l4 6-10 12L2 9z"/><path d="M11 3 8 9l4 12 4-12-3-6"/><path d="M2 9h20"/>',
});

const C = (key, vars) => t(`compete.${key}`, vars);
const SIGNAL = 'compete-update'; // un amigo cambió un desafío: volver a preguntar
const REPORT_EVERY_MS = 5 * 60000;
const FIRST_LOOK_MS = 20000; // la primera consulta espera a que el launcher termine de arrancar
const POLL_MS = 15 * 60000;
const CHALLENGES_TTL = 60000;
const EVENTS_TTL = 30 * 60000;
const PAUSE_MS = 60 * 60000; // sin servicio (o sin la migración): no insistir por una hora
const MAX_TIMER_MS = 6 * 3600000;

// ---------- Datos ----------
let fakeCompete = null;

/** El backend de Venus Points (real o, en capturas, el falso), con los datos de ejemplo de Competir cuando corresponde. */
export async function competeBackend() {
  const b = await backend();
  if (b.fake) {
    if (!fakeCompete) {
      const { createFakeCompete } = await import('../pages/compete/fake.js');
      const scenario = await api.invoke('rewards:fakeMode').catch(() => null);
      fakeCompete = createFakeCompete(typeof scenario === 'string' ? scenario : 'demo');
    }
    return { fake: true, signedIn: b.signedIn, userId: b.userId, onAuth: b.onAuth, rpc: (name, args) => fakeCompete.rpc(name, args), friends: async () => fakeCompete.friends() };
  }
  return { fake: false, signedIn: b.signedIn, userId: b.userId, onAuth: b.onAuth, rpc: (name, args) => b.rpc(name, args), friends: socialFriends };
}

// Los amigos de la cuenta (social arranca solo, pero puede estar cargando todavía).
async function socialFriends() {
  await social.init?.();
  for (let i = 0; i < 40 && social.state === 'loading'; i++) await new Promise((r) => setTimeout(r, 100));
  return (social.friends || []).map((f) => ({ id: f.id, name: f.name || f.profile?.username || '?' }));
}

const messageOf = (err) => String(err?.message ?? '').split(':')[0];

/** Mensaje para el usuario de un error del servidor. */
export function errText(err) {
  const msg = messageOf(err);
  if (has(`compete.err_${msg}`)) return C(`err_${msg}`);
  return err?.code && has(`compete.err_${err.code}`) ? C(`err_${err.code}`) : C('err_server');
}

// ---------- Compartir ----------
export const shareEnabled = () => store.settings?.compete?.share === true;

let reporting = null;
let retryTimer = null;
let pausedUntil = 0;

async function sendReport(b, report, week = report.week) {
  try {
    await b.rpc('ranking_report', { p_minutes: report.minutes, p_diamonds: report.diamonds, p_mobs: report.mobs, p_blocks: report.blocks, p_deaths: report.deaths, p_week: week });
    return true;
  } catch (err) {
    const msg = messageOf(err);
    if (msg === 'bad_week' && week) return sendReport(b, report, null); // el reloj de la PC está corrido: que decida el servidor
    if (msg === 'too_soon') {
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => reportNow(), 90000);
    } else if (msg === 'share_off') {
      // Se apagó desde otra PC: acá tampoco se manda más.
      await store.setSettings({ compete: { share: false } }).catch(() => {});
      await api.invoke('compete:reset').catch(() => {});
    } else if (err?.code === 'unavailable' || err?.code === 'banned') {
      pausedUntil = Date.now() + PAUSE_MS;
    } else if (err?.code !== 'network' && err?.code !== 'noSession') {
      console.warn('[compete] envío', err?.message || err);
    }
    return false;
  }
}

async function doReport() {
  if (!shareEnabled() || Date.now() < pausedUntil) return false;
  const b = await competeBackend();
  if (!b.signedIn()) return false;
  const res = await api.invoke('compete:collect', { userId: b.userId() });
  for (const report of res?.reports || []) {
    if (!(await sendReport(b, report))) return false;
    await api.invoke('compete:commit', res.token, report.week);
  }
  return true;
}

/** Manda lo jugado desde el último envío, si compartir está prendido. Nunca lanza. */
export function reportNow() {
  if (!reporting) {
    reporting = doReport()
      .catch((err) => {
        console.warn('[compete] envío', err?.message || err);
        return false;
      })
      .finally(() => {
        reporting = null;
      });
  }
  return reporting;
}

/**
 * Prende o apaga compartir (para la cuenta y en esta PC). Al prender se anota lo que ya hay como punto de partida: nunca
 * se manda lo anterior. Al apagar, esta PC deja de mandar aunque el servidor no responda; si no responde, lanza el error.
 */
export async function setShare(on) {
  const b = await competeBackend();
  if (on) {
    await b.rpc('ranking_set_share', { p_on: true });
    await api.invoke('compete:reset');
    await store.setSettings({ compete: { share: true } });
    pausedUntil = 0;
    await reportNow();
    return;
  }
  await store.setSettings({ compete: { share: false } });
  await api.invoke('compete:reset');
  await b.rpc('ranking_set_share', { p_on: false });
}

/** Borra del servidor lo enviado y apaga compartir. */
export async function forgetShared() {
  const b = await competeBackend();
  await b.rpc('ranking_forget');
  await store.setSettings({ compete: { share: false } });
  await api.invoke('compete:reset');
}

function watchGames() {
  const running = new Set();
  let timer = null;
  api.on('game:state', (id, st) => {
    if (!st || st.quiet) return;
    if (st.state === 'running') {
      running.add(id);
      timer ||= setInterval(() => reportNow(), REPORT_EVERY_MS);
    } else if (running.delete(id)) {
      // El juego ya guardó sus estadísticas y el registro de partidas ya tiene esta: se manda lo que faltaba.
      setTimeout(() => reportNow(), 15000);
      if (!running.size) {
        clearInterval(timer);
        timer = null;
      }
    }
  });
}

// ---------- Desafíos ----------
const state = { data: null, error: null, at: 0, user: null };
const listeners = new Set();
let loading = null;
let settleTimer = null;

export const getChallenges = () => state;

export function onChallenges(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  const pending = state.data ? groupChallenges(state.data.challenges).incoming.length : 0;
  setNavBadge('compete', pending || 0, 'badge');
  for (const fn of [...listeners]) {
    try {
      fn(state);
    } catch (err) {
      console.error('[compete]', err);
    }
  }
}

function notice({ type, challenge: c }) {
  const name = friendName(c.friend);
  const detail = `${metricName(c.metric)} · ${goalText(c)}`;
  const view = { label: C('toastView'), icon: 'swords', primary: true, run: () => navigate('compete/challenges') };
  let title;
  let msg = detail;
  let kind = 'info';
  if (type === 'received') title = C('toastReceived', { name });
  else if (type === 'accepted') title = C('toastAccepted', { name });
  else if (type === 'declined') title = C('toastDeclined', { name });
  else if (type === 'expired') title = C('toastExpired', { name });
  else if (c.outcome === 'win' && c.won) {
    title = C('toastWon', { name });
    kind = 'good';
    msg = c.prize > 0 ? C('toastPrize', { n: c.prize }) : C(`note_${c.prizeNote || 'none'}`);
  } else if (c.outcome === 'win') title = C('toastLost', { name });
  else if (c.outcome === 'tie') title = C('toastTie', { name });
  else {
    title = C('toastNoPrize', { name });
    msg = C(`outcome_${c.outcome === 'no_target' ? 'no_target' : 'no_activity'}`);
  }
  if (!document.body.classList.contains('onboarding')) actionToast({ kind, icon: type === 'finished' ? 'trophy' : 'swords', title, msg, actions: [view], key: `compete:${c.id}`, ms: 9000 });
  if (isPlaying(store.running)) pushOverlay({ kind: 'alert', icon: type === 'finished' ? 'points' : 'friend', title, body: msg, ttl: 8 });
}

async function announce(user, list) {
  const saved = store.settings?.compete?.seen?.[user];
  const { notices, seen } = challengeNotices(Array.isArray(saved) ? saved : null, list);
  for (const n of notices) notice(n);
  if (notices.some((n) => n.type === 'finished' && n.challenge.prize > 0)) loadSummary({ force: true }).catch(() => {});
  if (JSON.stringify(saved) !== JSON.stringify(seen)) await store.setSettings({ compete: { seen: { [user]: seen } } }).catch(() => {});
}

// Al terminar el plazo más próximo se vuelve a preguntar: el servidor cierra y paga, y llega el aviso.
function scheduleSettle(list) {
  clearTimeout(settleTimer);
  const at = nextSettleAt((list || []).map(normalizeChallenge).filter(Boolean));
  if (!at) return;
  settleTimer = setTimeout(() => loadChallenges({ force: true }), Math.min(Math.max(at - Date.now(), 0) + 5000, MAX_TIMER_MS));
}

/** challenges_me: cierra lo vencido, trae la lista y avisa lo nuevo. */
export async function loadChallenges({ force = false } = {}) {
  const b = await competeBackend();
  if (!b.signedIn()) {
    Object.assign(state, { data: null, error: null, at: 0, user: null });
    clearTimeout(settleTimer);
    emit();
    return state;
  }
  const user = b.userId();
  if (!force && state.user === user && state.at && Date.now() - state.at < CHALLENGES_TTL) return state;
  if (!force && Date.now() < pausedUntil) return state;
  if (loading) return loading;
  loading = (async () => {
    try {
      await loadNs('compete');
      const data = await b.rpc('challenges_me');
      Object.assign(state, { data, error: null, at: Date.now(), user });
      await announce(user, data?.challenges);
      scheduleSettle(data?.challenges);
    } catch (err) {
      Object.assign(state, { error: err, at: Date.now(), user });
      if (err?.code === 'unavailable' || err?.code === 'banned') pausedUntil = Date.now() + PAUSE_MS;
    } finally {
      loading = null;
    }
    emit();
    return state;
  })();
  return loading;
}

/** Avisa a un amigo que cambió un desafío, para que no espere a la próxima consulta. Si no se puede, no pasa nada. */
export function tellFriend(userId) {
  if (!userId || fakeCompete) return;
  Promise.resolve().then(() => social.sendSignal(userId, SIGNAL, {})).catch(() => {});
}

// ---------- Recordatorios del calendario (sin push: solo con el launcher abierto) ----------
let myEvents = [];
let myEventsAt = 0;

/** Lo que anotó la cuenta y todavía no terminó. */
export async function loadMyEvents({ force = false } = {}) {
  const b = await competeBackend();
  if (!b.signedIn()) {
    myEvents = [];
    myEventsAt = 0;
    return myEvents;
  }
  if (!force && myEventsAt && Date.now() - myEventsAt < EVENTS_TTL) return myEvents;
  if (!force && Date.now() < pausedUntil) return myEvents;
  try {
    myEvents = (await b.rpc('events_mine') || []).map(normalizeEvent).filter(Boolean);
    myEventsAt = Date.now();
    checkReminders();
  } catch (err) {
    if (err?.code === 'unavailable' || err?.code === 'banned') pausedUntil = Date.now() + PAUSE_MS;
    else if (err?.code !== 'network') console.warn('[compete] eventos', err?.message || err);
  }
  return myEvents;
}

function remind(ev, now) {
  const minutes = Math.max(1, Math.ceil((ev.startsAt - now) / 60000));
  const title = C('reminderTitle', { title: ev.title });
  const msg = C('reminderText', { count: minutes });
  const actions = [{ label: C('toastView'), icon: 'calendar', primary: true, run: () => navigate(`compete/events/${ev.id}`) }];
  if (ev.server) actions.push({ label: C('evJoinServer'), icon: 'play', run: async () => (await import('./serverlist.js')).joinServer(ev.server) });
  if (!document.body.classList.contains('onboarding')) actionToast({ kind: 'info', icon: 'bell', title, msg, actions, key: `compete-ev:${ev.id}`, ms: 20000 });
  pushOverlay({ kind: 'alert', icon: 'info', title, body: msg, ttl: 12 });
  if (document.hasFocus() || typeof Notification === 'undefined' || Notification.permission === 'denied') return;
  try {
    const n = new Notification(title, { body: msg, icon: 'assets/logo-64.png', tag: `venus-event-${ev.id}` });
    n.onclick = () => {
      window.focus();
      navigate(`compete/events/${ev.id}`);
    };
  } catch {
    /* sin notificaciones del sistema: quedan el aviso y el overlay */
  }
}

function checkReminders() {
  const now = Date.now();
  const reminded = store.settings?.compete?.reminded;
  const due = dueReminders(myEvents, reminded, now);
  if (!due.length) return;
  for (const ev of due) remind(ev, now);
  store.setSettings({ compete: { reminded: pruneReminded([...(reminded || []), ...due.map(reminderKey)], myEvents, now) } }).catch(() => {});
}

// ---------- Tarjeta de Ajustes ----------
/** Compartir en Ajustes -> Privacidad: qué se manda, quién lo ve, el interruptor y borrar lo enviado. */
export function shareCard() {
  ensureCss('pages/compete');
  const el = h('section', { class: 'card cfg-card', dataset: { anchor: 'compete' } });
  loadNs('compete').then(async () => {
    const b = await competeBackend();
    const forget = h('button', { type: 'button', class: 'btn sm' }, icon('trash'), C('shareForget'));
    forget.addEventListener('click', async () => {
      if (!(await confirmDialog(C('shareForget'), C('shareForgetText'), { danger: true }))) return;
      const done = setBusy(forget);
      try {
        await forgetShared();
        ok(C('shareForgotten'));
        draw();
      } catch (err) {
        fail(C('shareError'), errText(err));
      } finally {
        done();
      }
    });
    function draw() {
      mount(el,
        h('div', { class: 'cfg-card-head' }, h('h3', { class: 'card-title' }, icon('trophy'), h('span', {}, C('shareTitle')))),
        shareWhat(),
        h('div', { class: 'toggle-row' },
          h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, C('shareToggle')), h('div', { class: 'tr-sub' }, b.signedIn() ? C('shareToggleSub') : C('shareNeedsAccount'))),
          b.signedIn() ? shareSwitch(draw) : null),
        b.signedIn() ? h('div', { class: 'cp-share-actions' }, forget) : null);
    }
    draw();
  }).catch((err) => console.warn('[compete] tarjeta', err?.message || err));
  return el;
}

/** Qué se manda y quién lo ve (lo mismo en Ajustes y en la página). */
export function shareWhat() {
  return h('ul', { class: 'cp-share-list' },
    h('li', {}, icon('upload'), h('span', {}, C('shareSends'))),
    h('li', {}, icon('users'), h('span', {}, C('shareSees'))),
    h('li', {}, icon('eyeOff'), h('span', {}, C('shareNotSent'))));
}

/** Interruptor de compartir. Si falla vuelve a mostrar el estado real. */
export function shareSwitch(after) {
  return switchEl(shareEnabled(), async (on) => {
    try {
      await setShare(on);
      if (on) ok(C('shareOn'));
    } catch (err) {
      fail(on ? C('shareError') : C('shareOffError'), errText(err));
    }
    after?.();
  }, C('shareToggle'));
}

// ---------- Arranque ----------
let started = false;
export async function startup() {
  if (started) return;
  started = true;
  registerSettingsCard('privacy', () => shareCard());
  try {
    await loadNs('compete');
  } catch (err) {
    console.warn('[compete] textos', err?.message || err);
  }
  watchGames();
  social?.onSignal?.(SIGNAL, () => loadChallenges({ force: true }));
  const b = await competeBackend().catch(() => null);
  if (!b) return;
  b.onAuth?.(() => {
    pausedUntil = 0;
    loadChallenges({ force: true });
    loadMyEvents({ force: true });
    reportNow();
  });
  setInterval(checkReminders, 30000);
  if (store.info?.devshot && !b.fake) return; // capturas sin datos falsos: no consultar nada
  const look = () => {
    loadChallenges();
    loadMyEvents();
  };
  setTimeout(() => {
    look();
    reportNow();
  }, FIRST_LOOK_MS);
  setInterval(look, POLL_MS);
}
