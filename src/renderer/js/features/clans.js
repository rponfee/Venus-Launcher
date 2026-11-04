// Clanes y comunidades (docs/wip/clanes-comunidades-34.md): lo que corre con el launcher abierto aunque no se abra la página.
// Mira las invitaciones y solicitudes pendientes, avisa de las nuevas y pone el número en el menú. Reglas y RPC: 0033_clanes_comunidades.sql.
//   startup(), getMine() -> { data, error }, onMine(fn) -> off, loadMine({ force? }), tellFriend(userId)
import { store } from '../store.js';
import { t, loadNs } from '../i18n.js';
import { navigate, setNavBadge } from '../app.js';
import { social } from '../social.js';
import { actionToast } from './party/toasts.js';
import { groupsBackend } from './clans/backend.js';
import { isClanStaff } from './clans/logic.js';

const SIGNAL = 'clan-update'; // un amigo te invitó o respondió: volver a preguntar. El contenido no se usa: decide el servidor
const FIRST_LOOK_MS = 20000; // la primera consulta espera a que el launcher termine de arrancar
const POLL_MS = 15 * 60000;
const TTL_MS = 30000;
const PAUSE_MS = 60 * 60000; // sin servicio (o sin la migración): no insistir por una hora
const MAX_SEEN = 100;

const listeners = new Set();
let mine = { data: null, error: null, at: 0 };
let running = null;
let pausedUntil = 0;
let started = false;

export const getMine = () => mine;

export function onMine(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const seenKey = (invite) => `${invite?.clan?.id}:${invite?.at}`;

async function announce(data) {
  const invites = Array.isArray(data?.invites) ? data.invites : [];
  const seen = Array.isArray(store.settings?.clans?.seen) ? store.settings.clans.seen : [];
  const fresh = invites.filter((x) => !seen.includes(seenKey(x)));
  if (!fresh.length) return;
  await loadNs('clans').catch(() => {});
  for (const invite of fresh.slice(0, 3)) {
    actionToast({
      icon: 'shield',
      title: t('clans.inviteToastTitle'),
      msg: t('clans.inviteToastText', { name: invite.clan?.name || '', tag: invite.clan?.tag || '' }),
      key: `clan-invite:${invite.clan?.id}`,
      actions: [{ label: t('clans.inviteToastOpen'), icon: 'shield', primary: true, run: () => navigate('clans') }],
    });
  }
  const next = [...seen, ...fresh.map(seenKey)].slice(-MAX_SEEN);
  await store.setSettings({ clans: { seen: next } }).catch(() => {});
}

function publish(data, error) {
  mine = { data, error, at: Date.now() };
  const invites = Array.isArray(data?.invites) ? data.invites.length : 0;
  const requests = isClanStaff(data?.clan?.myRole) && Array.isArray(data?.clan?.requests) ? data.clan.requests.length : 0;
  setNavBadge('clans', invites + requests);
  for (const fn of listeners) {
    try {
      fn(mine);
    } catch (err) {
      console.warn('[clans]', err?.message || err);
    }
  }
}

/** Pide el estado de la cuenta (clan, invitaciones y solicitudes). Nunca lanza: el error queda en getMine().error. */
export function loadMine({ force = false } = {}) {
  if (running) return running;
  if (!force && Date.now() - mine.at < TTL_MS) return Promise.resolve(mine);
  if (!force && Date.now() < pausedUntil) return Promise.resolve(mine);
  running = (async () => {
    const b = await groupsBackend();
    if (!b.signedIn()) {
      publish(null, null);
      return mine;
    }
    try {
      const data = await b.rpc('clan_me');
      publish(data, null);
      announce(data).catch(() => {});
    } catch (err) {
      if (err?.code === 'unavailable') pausedUntil = Date.now() + PAUSE_MS;
      publish(mine.data, err);
    }
    return mine;
  })().finally(() => {
    running = null;
  });
  return running;
}

/** Le avisa a un amigo que algo cambió para que vuelva a preguntar. Si no llega, lo ve en la próxima consulta. */
export function tellFriend(userId) {
  if (userId) social.sendSignal?.(userId, SIGNAL, {})?.catch?.(() => {});
}

export async function startup() {
  if (started) return;
  started = true;
  const b = await groupsBackend();
  setTimeout(() => loadMine(), FIRST_LOOK_MS);
  setInterval(() => {
    if (document.visibilityState === 'visible') loadMine();
  }, POLL_MS);
  social.onSignal?.(SIGNAL, () => loadMine({ force: true }));
  let user = b.userId();
  b.onAuth?.(() => {
    if (b.userId() === user) return; // renovar la sesión no cuenta
    user = b.userId();
    pausedUntil = 0;
    mine = { data: null, error: null, at: 0 };
    loadMine({ force: true });
  });
}
