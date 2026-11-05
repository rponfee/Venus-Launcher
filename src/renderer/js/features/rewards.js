// Venus Points (docs/venus-points.md): logros automáticos, saldo compartido y el chip de la barra lateral.
//   startup()            lo llama app.js al abrir el launcher (se puede llamar más de una vez). Escucha
//                        'venus:achievement' (contrato 3) y detecta solo los logros de la PC que se pueden comprobar
//                        con datos del launcher: first_launch (al abrir el juego), playtime_10h/playtime_100h
//                        (stats:summary) e instances_5 (store.instances). También prueba los del servidor cuando
//                        pueden haberse cumplido (verificar la cuenta, un amigo nuevo, premium...) y tolera not_met.
//   pointsChip()         -> Element (con .destroy()): saldo para la barra lateral; lleva a #/rewards
//   claimAchievement(id, { force?, silent? }) -> Promise<resultado de achievement_claim o null>
//   loadSummary({ force? }), getSummary(), onSummary(fn) -> off: el resumen de points_me que comparten la página y el chip
// Cada logro se pide una sola vez por cuenta: los reclamados se recuerdan en settings.rewards.claimed[<userId>] y
// los de la PC que se cumplieron sin sesión (o sin servicio) esperan en settings.rewards.pending.
import { pointsTicket } from './cosmic-art.js';
import { h, icon, toast, ensureCss, registerIcons } from '../ui.js';
import { store, api } from '../store.js';
import { t, has, loadNs, locale, onLanguageChange } from '../i18n.js';
import { navigate, setNavBadge } from '../app.js';
import { social } from '../social.js';
import { backend } from '../pages/rewards/backend.js';
import { ACHIEVEMENT_ID, serverHints, formatPoints, humanizeId, nextUtcMidnight } from '../pages/rewards/logic.js';
import { isPremium, onPremiumChange } from './premium.js';
import { CLIENT_IDS } from '../pages/achievements/catalog.js';
import { achievementName as catalogName, achievementDesc as catalogDesc } from '../pages/achievements/names.js';

// Venus Point: un planeta con anillo (lo usan la página, el chip y la tienda)
registerIcons({
  vpoint: '<circle cx="12" cy="12" r="5.5"/><path d="M17.3 9.2c3-.9 4.9-.7 5.2.3.5 1.7-4.1 5-10.2 7.4S1.8 20.1 1.4 18.5c-.3-1 1.1-2.4 3.8-3.8"/>',
});

const R = (key, vars) => t(`rewards.${key}`, vars);
const SUMMARY_TTL = 60 * 1000;
const RETRY_NOT_MET = 60 * 1000; // un logro del servidor que no se cumplió no se vuelve a probar antes de esto

/** Nombre, descripción e ítems de la tienda con respaldo si falta la traducción. */
export const achievementName = (id) => catalogName(id);
export const achievementDesc = (id) => catalogDesc(id);
// Los cosméticos del Venus Pass (0026) se nombran en el namespace "pass" (features/pass.js lo carga al arrancar).
export const itemName = (id) => (has(`rewards.item_${id}`) ? R(`item_${id}`) : has(`pass.item_${id}`) ? t(`pass.item_${id}`) : humanizeId(id));

// ---------- Resumen compartido (points_me) ----------
const summary = { user: null, data: null, error: null, at: 0 };
let summaryPending = null;
const summaryListeners = new Set();
let refreshTimer = null;

function setSummary(patch) {
  Object.assign(summary, patch);
  setNavBadge('rewards', summary.data && !summary.data.dailyClaimed ? 1 : 0, 'dot');
  for (const fn of [...summaryListeners]) {
    try {
      fn(summary);
    } catch (err) {
      console.error(err);
    }
  }
}

export const getSummary = () => summary;

export function onSummary(fn) {
  summaryListeners.add(fn);
  return () => summaryListeners.delete(fn);
}

export async function loadSummary({ force = false } = {}) {
  const b = await backend();
  const user = b.signedIn() ? b.userId() : null;
  if (!user) {
    if (summary.user || summary.data || summary.error !== 'noSession') setSummary({ user: null, data: null, error: 'noSession', at: Date.now() });
    return summary;
  }
  if (!force && summary.user === user && summary.data && Date.now() - summary.at < SUMMARY_TTL) return summary;
  if (!force && summaryPending?.user === user) return summaryPending.promise;
  const promise = b
    .rpc('points_me')
    .then(
      (data) => {
        if (b.userId() !== user) return summary;
        const clean = data && typeof data === 'object' ? data : null;
        if (clean) rememberUnlocked(user, (clean.achievements || []).filter((a) => a?.unlockedAt).map((a) => a.id));
        setSummary({ user, data: clean, error: clean ? null : 'server', at: Date.now() });
        return summary;
      },
      (err) => {
        if (b.userId() !== user) return summary;
        // Con un error se conserva el saldo anterior de la misma cuenta (el chip no parpadea)
        setSummary({ user, data: summary.user === user ? summary.data : null, error: err?.code || 'server', at: Date.now() });
        return summary;
      },
    )
    .finally(() => {
      if (summaryPending?.promise === promise) summaryPending = null;
    });
  summaryPending = { user, promise };
  return promise;
}

function refreshSoon(ms = 1500) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => loadSummary({ force: true }).catch(() => {}), ms);
}

// ---------- Memoria local de logros (settings.rewards) ----------
const memClaimed = new Map(); // userId -> Set
let memPending = null; // Set
let saving = Promise.resolve();

function rewardsSettings() {
  const r = store.settings?.rewards;
  return r && typeof r === 'object' ? r : {};
}

function claimedSet(user) {
  if (!memClaimed.has(user)) {
    const list = rewardsSettings().claimed?.[user];
    memClaimed.set(user, new Set(Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []));
  }
  return memClaimed.get(user);
}

function pendingSet() {
  if (!memPending) {
    const list = rewardsSettings().pending;
    memPending = new Set(Array.isArray(list) ? list.filter((x) => CLIENT_IDS.includes(x)) : []);
  }
  return memPending;
}

function save(patch) {
  saving = saving.then(() => store.setSettings({ rewards: patch })).catch((err) => console.warn('[rewards] no se pudo guardar:', err?.message || err));
  return saving;
}

function rememberUnlocked(user, ids) {
  const set = claimedSet(user);
  const before = set.size;
  for (const id of ids) if (ACHIEVEMENT_ID.test(id)) set.add(id);
  let pendingChanged = false;
  for (const id of ids) if (pendingSet().delete(id)) pendingChanged = true;
  if (set.size !== before || pendingChanged) save({ claimed: { [user]: [...set] }, ...(pendingChanged ? { pending: [...pendingSet()] } : {}) });
}

function addPending(id) {
  if (!CLIENT_IDS.includes(id) || pendingSet().has(id)) return;
  pendingSet().add(id);
  save({ pending: [...pendingSet()] });
}

// ---------- Reclamar logros ----------
const inflight = new Map(); // `${user}:${id}` -> promesa
const lastTry = new Map(); // `${user}:${id}` -> ms
const skipped = new Set(); // ids que el servidor no conoce (bad_achievement): no se vuelven a pedir en esta sesión
let pausedUntil = 0; // servicio caído o cuenta suspendida: no se insiste por un rato

async function overlayAlert(event) {
  try {
    await api.invoke('overlay:push', event);
  } catch {
    /* sin overlay (agente B) o el juego cerrado: alcanza con el aviso del launcher */
  }
}

async function announce(id, points) {
  await Promise.all([loadNs('rewards'), loadNs('achievements')]).catch(() => {});
  const name = achievementName(id);
  const pts = formatPoints(points, locale());
  toast('good', R('achToastTitle', { name }), points > 0 ? R('achToastText', { points: pts }) : null, 6000);
  overlayAlert({ kind: 'alert', title: R('achOverlayTitle'), body: points > 0 ? R('achOverlayBody', { name, points: pts }) : name, icon: 'achievement', ttl: 6 });
}

export async function claimAchievement(id, { force = false, silent = false } = {}) {
  if (typeof id !== 'string' || !ACHIEVEMENT_ID.test(id) || skipped.has(id)) return null;
  const isPc = CLIENT_IDS.includes(id);
  let b;
  try {
    b = await backend();
  } catch {
    return null;
  }
  const user = b.signedIn() ? b.userId() : null;
  if (!user) {
    if (isPc) addPending(id); // se reclama al iniciar sesión
    return null;
  }
  if (claimedSet(user).has(id)) return null;
  if (Date.now() < pausedUntil) {
    if (isPc) addPending(id);
    return null;
  }
  const key = `${user}:${id}`;
  if (inflight.has(key)) return inflight.get(key);
  if (!force && !isPc && Date.now() - (lastTry.get(key) || 0) < RETRY_NOT_MET) return null;
  const promise = (async () => {
    lastTry.set(key, Date.now());
    try {
      const res = await b.rpc('achievement_claim', { p_id: id });
      if (b.userId() !== user) return null;
      rememberUnlocked(user, [id]);
      if (res && res.unlocked && !res.already) {
        if (typeof res.balance === 'number' && summary.user === user && summary.data) setSummary({ data: { ...summary.data, balance: res.balance } });
        if (!silent) announce(id, Number(res.points) || 0);
        refreshSoon();
      }
      return res || null;
    } catch (err) {
      const code = err?.code;
      if (code === 'not_met') return null;
      if (code === 'bad_achievement') {
        skipped.add(id);
        if (pendingSet().delete(id)) save({ pending: [...pendingSet()] });
        return null;
      }
      if (code === 'unavailable' || code === 'banned') pausedUntil = Date.now() + 10 * 60 * 1000;
      // too_many_today, red, servicio: los de la PC quedan pendientes para la próxima
      if (isPc) addPending(id);
      return null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, promise);
  return promise;
}

/** Pide al servidor que compruebe los logros suyos (lo usa la página al abrirse). */
export async function sweepServerAchievements() {
  const { checkAchievements } = await import('./achievements.js');
  return checkAchievements();
}

// Logros de la PC con los datos del launcher + pendientes + los del servidor con pistas.
let checkTimer = null;
let checking = false;
async function checkLocal() {
  if (checking) return;
  checking = true;
  try {
    const b = await backend();
    if (!b.signedIn()) return;
    for (const id of [...pendingSet()]) await claimAchievement(id);
    await loadSummary().catch(() => {});
    const d = summary.data;
    const premium = await isPremium().catch(() => false);
    const hints = serverHints({
      premium,
      mcVerified: d?.mcVerified === true,
      referralsRewarded: Number(d?.referrals?.rewarded) || 0,
      friends: social.friends?.length || 0,
      badgeEnrolled: store.settings?.ingame?.badgeEnrolled === true,
    });
    for (const id of hints) await claimAchievement(id);
  } catch (err) {
    console.warn('[rewards] logros', err?.message || err);
  } finally {
    checking = false;
  }
}

function scheduleCheck(ms) {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(checkLocal, ms);
}

// A la medianoche UTC vuelve el premio diario: se actualiza el resumen (chip y punto del menú).
let midnightTimer = null;
function scheduleMidnight() {
  clearTimeout(midnightTimer);
  midnightTimer = setTimeout(() => {
    loadSummary({ force: true }).catch(() => {});
    scheduleMidnight();
  }, Math.max(5000, nextUtcMidnight(Date.now()) - Date.now() + 5000));
}

let started = false;
export async function startup() {
  if (started) {
    scheduleCheck(500);
    return;
  }
  started = true;
  await loadNs('rewards').catch(() => {});

  window.addEventListener('venus:achievement', (e) => {
    const id = e?.detail?.id;
    if (typeof id === 'string') claimAchievement(id, { force: true });
  });
  api.on('game:state', (_id, st) => {
    if (st?.state === 'running' && !st.quiet) claimAchievement('first_launch');
  });
  api.on('stats:updated', (p) => {
    if (!p || p.kind === 'session') scheduleCheck(2000);
  });
  store.on('instances', (list) => {
    if (Array.isArray(list) && list.length >= 5) claimAchievement('instances_5');
  });
  api.on('ingame:badgeStatus', (st) => {
    if (st?.state === 'ok') claimAchievement('badge_on', { force: true });
  });
  social.on('friends', (list) => {
    const n = Array.isArray(list) ? list.length : 0;
    if (n >= 1) claimAchievement('first_friend');
    if (n >= 5) claimAchievement('five_friends');
  });
  onPremiumChange((premium) => {
    if (premium) claimAchievement('premium', { force: true });
    refreshSoon(500); // el multiplicador cambia con premium
  });

  const b = await backend();
  let lastUser = b.userId();
  b.onAuth(() => {
    const id = b.userId();
    if (id === lastUser) return; // renovar el token no cambia nada
    lastUser = id;
    swept.clear();
    loadSummary({ force: true }).catch(() => {});
    scheduleCheck(1500);
  });
  loadSummary().catch(() => {});
  scheduleMidnight();
  scheduleCheck(4000); // después del arranque, para no competir con la primera página
}

// ---------- Chip de la barra lateral ----------
export function pointsChip() {
  Promise.all([ensureCss('pages/rewards'), ensureCss('features/cosmic-art')]);
  const value = h('span', { class: 'rw-chip-value num' });
  const label = h('span', { class: 'rw-chip-label' });
  const dot = h('span', { class: 'rw-chip-dot', hidden: true, 'aria-hidden': 'true' });
  const el = h('button', { type: 'button', class: 'rw-chip', hidden: true, onclick: () => navigate('rewards') }, h('span', { class: 'rw-chip-ticket', 'aria-hidden': 'true' }, pointsTicket('', { compact: true })), h('span', { class: 'rw-chip-main' }, value, label), dot);
  let ready = false;

  function paint() {
    const d = summary.data;
    if (!ready || !d || !summary.user) {
      el.hidden = true;
      return;
    }
    const points = formatPoints(d.balance, locale());
    const daily = d.dailyClaimed === false;
    value.textContent = points;
    label.textContent = daily ? R('chipDaily') : R('chipLabel');
    dot.hidden = !daily;
    el.classList.toggle('daily', daily);
    const text = daily ? R('chipAriaDaily', { points }) : R('chipAria', { points });
    el.title = text;
    el.setAttribute('aria-label', text);
    el.hidden = false;
  }

  const offSummary = onSummary(paint);
  const offLang = onLanguageChange(() => loadNs('rewards').then(paint).catch(() => {}));
  loadNs('rewards')
    .then(() => {
      ready = true;
      paint();
      return loadSummary();
    })
    .catch(() => {});
  el.destroy = () => {
    offSummary();
    offLang();
  };
  return el;
}
