// Lógica pura de los Avisos (features/notify.js): ajustes por defecto, cambios de actividad de un amigo que
// merecen aviso, límite de avisos por amigo, lista de servidores favoritos y la máquina de estados de cada servidor
// vigilado (vuelve a estar en línea, se llena, se vacía). Vive en features/party/ porque es la carpeta auxiliar
// del agente F; no usa DOM ni Electron y se prueba con Node (party/test).
import { cleanAddress, addressKey, cleanText, isUserId } from './logic.js';

export const FRIEND_COOLDOWN_MS = 10 * 60_000; // un aviso por amigo cada 10 minutos
export const SERVER_CHECK_MS = 5 * 60_000; // los favoritos se revisan cada 5 minutos (solo con el launcher abierto)
export const OFFLINE_AFTER = 2; // fallos seguidos antes de dar un servidor por caído (un ping perdido no cuenta)
export const MAX_WATCH = 20; // servidores marcados en esta PC
export const MAX_MUTED = 200;

// settings.notify
export const NOTIFY_DEFAULTS = Object.freeze({
  friendServers: true, // un amigo entra a un servidor
  friendWorlds: true, // un amigo entra a un mundo de un jugador
  serverOnline: true, // un favorito vuelve a estar en línea
  serverFull: false, // un favorito se llena
  serverEmpty: false, // un favorito se queda sin jugadores
  profileServers: false, // vigilar también los favoritos del perfil (apagado: lo que el launcher hace por su cuenta arranca apagado)
  quietWhilePlaying: true, // sin avisos en el launcher mientras se juega (el overlay sigue)
  overlay: true, // mandar los avisos al overlay del juego
  muted: [], // ids de amigos silenciados
  watch: [], // [{ address, name }] servidores marcados en esta PC
});

export function readNotify(raw) {
  const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = { ...NOTIFY_DEFAULTS };
  for (const k of Object.keys(NOTIFY_DEFAULTS)) {
    if (typeof NOTIFY_DEFAULTS[k] === 'boolean' && typeof s[k] === 'boolean') out[k] = s[k];
  }
  out.muted = [...new Set((Array.isArray(s.muted) ? s.muted : []).filter(isUserId))].slice(0, MAX_MUTED);
  out.watch = normalizeWatch(s.watch);
  return out;
}

// ---------- Actividad de amigos ----------

// prev/next = activity de social ({ type: 'menu'|'singleplayer'|'server', address?, world?, ... } o null).
// Devuelve { kind: 'server', address } o { kind: 'world', world } cuando entró a algo nuevo; si no, null.
export function activityChange(prev, next) {
  if (!next || typeof next !== 'object') return null;
  if (next.type === 'server') {
    const key = addressKey(next.address);
    if (!key) return null;
    if (prev?.type === 'server' && addressKey(prev.address) === key) return null;
    return { kind: 'server', address: cleanAddress(next.address) };
  }
  if (next.type === 'singleplayer') {
    const world = cleanText(next.world, 48);
    if (prev?.type === 'singleplayer' && cleanText(prev.world, 48) === world) return null;
    return { kind: 'world', world };
  }
  return null;
}

// Decide si un cambio de actividad se avisa (sin contar el límite de tiempo)
export function friendEventAllowed(change, cfg, friendId) {
  if (!change) return false;
  if (cfg.muted.includes(friendId)) return false;
  return change.kind === 'server' ? cfg.friendServers : cfg.friendWorlds;
}

// Límite por clave (amigo): uno cada `windowMs`. allow() lo registra; peek() solo consulta.
export function createLimiter(windowMs = FRIEND_COOLDOWN_MS) {
  const last = new Map();
  return {
    peek(key, now = Date.now()) {
      const at = last.get(key);
      return at === undefined || now - at >= windowMs;
    },
    allow(key, now = Date.now()) {
      if (!this.peek(key, now)) return false;
      last.set(key, now);
      if (last.size > 500) last.delete(last.keys().next().value);
      return true;
    },
    reset(key) {
      if (key === undefined) last.clear();
      else last.delete(key);
    },
  };
}

// Recuerda la última actividad de cada amigo. La primera vez que se ve a alguien (al abrir el launcher o al
// conectarse) solo se anota: avisar de lo que ya estaba pasando sería ruido.
export function createActivityTracker() {
  const seen = new Map();
  return {
    update(userId, activity, presence) {
      const next = presence === 'offline' ? null : activity || null;
      if (!seen.has(userId)) {
        seen.set(userId, next);
        return null;
      }
      const prev = seen.get(userId);
      seen.set(userId, next);
      return activityChange(prev, next);
    },
    // Anota a un amigo sin avisar, solo si todavía no se lo vio (al arrancar o al cambiar la lista de amigos)
    seed(userId, activity, presence) {
      if (!seen.has(userId)) seen.set(userId, presence === 'offline' ? null : activity || null);
    },
    has(userId) {
      return seen.has(userId);
    },
    clear() {
      seen.clear();
    },
    get size() {
      return seen.size;
    },
  };
}

// ---------- Entrega ----------

// Dónde mostrar un aviso: toast en el launcher y/o alerta en el overlay.
export function deliveryFor(cfg, { playing = false } = {}) {
  return { toast: !(playing && cfg.quietWhilePlaying), overlay: Boolean(cfg.overlay) };
}

// ---------- Servidores favoritos ----------

export function normalizeWatch(list) {
  const out = [];
  const keys = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const address = cleanAddress(typeof raw === 'string' ? raw : raw?.address);
    const key = addressKey(address);
    if (!address || keys.has(key)) continue;
    keys.add(key);
    out.push({ address, name: cleanText(typeof raw === 'object' ? raw?.name : '', 40) });
    if (out.length >= MAX_WATCH) break;
  }
  return out;
}

// Favoritos del perfil ([{ address, name }] de profile_public) + marcados en esta PC, sin repetir.
export function mergeFavorites(profileList, localList, { includeProfile = true } = {}) {
  const out = [];
  const keys = new Map();
  const add = (raw, source) => {
    const address = cleanAddress(raw?.address);
    const key = addressKey(address);
    if (!address) return;
    if (keys.has(key)) {
      keys.get(key).sources.add(source);
      return;
    }
    const item = { key, address, name: cleanText(raw?.name, 40) || address, sources: new Set([source]) };
    keys.set(key, item);
    out.push(item);
  };
  if (includeProfile) for (const s of (Array.isArray(profileList) ? profileList : []).slice(0, 10)) add(s, 'profile');
  for (const s of normalizeWatch(localList)) add(s, 'local');
  return out.map((x) => ({ ...x, sources: [...x.sources] }));
}

export function toggleWatch(list, address, name) {
  const cur = normalizeWatch(list);
  const key = addressKey(address);
  if (!key) return cur;
  if (cur.some((s) => addressKey(s.address) === key)) return cur.filter((s) => addressKey(s.address) !== key);
  return normalizeWatch([...cur, { address, name }]);
}

// Estado de un servidor vigilado + resultado de un ping -> { state, events }.
//   state = { online: true|false|null, fails, players, max }
//   events: 'online' (volvió después de estar caído), 'full' (se llenó), 'empty' (se quedó sin jugadores)
// El primer resultado solo se anota. Un servidor se da por caído recién después de OFFLINE_AFTER fallos seguidos.
export function nextServerState(prev, res) {
  const events = [];
  const ok = Boolean(res && res.online);
  const players = ok && Number.isFinite(res.players?.online) ? Math.max(0, res.players.online) : null;
  const max = ok && Number.isFinite(res.players?.max) ? Math.max(0, res.players.max) : null;
  if (!prev) {
    return { state: { online: ok ? true : null, fails: ok ? 0 : 1, players, max }, events };
  }
  if (!ok) {
    const fails = (prev.fails || 0) + 1;
    const online = fails >= OFFLINE_AFTER ? false : prev.online;
    return { state: { ...prev, online, fails }, events };
  }
  if (prev.online === false) events.push('online');
  else if (prev.online === true) {
    const wasFull = prev.max > 0 && prev.players >= prev.max;
    const isFull = max > 0 && players >= max;
    if (!wasFull && isFull) events.push('full');
    if (prev.players > 0 && players === 0) events.push('empty');
  }
  return { state: { online: true, fails: 0, players, max }, events };
}

// Filtra los eventos por los ajustes
export function serverEventsAllowed(events, cfg) {
  return events.filter((e) => (e === 'online' ? cfg.serverOnline : e === 'full' ? cfg.serverFull : e === 'empty' ? cfg.serverEmpty : false));
}
