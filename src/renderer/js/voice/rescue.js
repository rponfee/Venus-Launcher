// Piezas del respaldo del Voice Chat que no necesitan red ni DOM: el codigo de respaldo (codigo de sala + clave) para
// salas de emergencia, la lista de salas guardadas con su clave, como distinguir "el servidor no responde" de un error
// de la sala y los servidores STUN publicos.
import { SECRET_RE } from './seal.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LEN = 6;
export const SECRET_LEN = 24;
const BACKUP_CODE_RE = new RegExp(`^[${ALPHABET}]{${CODE_LEN + SECRET_LEN}}$`);

const pick = (n) => {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return [...bytes].map((b) => ALPHABET[b % 32]).join('');
};

// ---------- Codigo de respaldo ----------
// "ABC234-KQ7M-XT2P-RN9W-HJ4E-C5VD-B8YF": los 6 primeros son el codigo de la sala (el de siempre) y los 24 siguientes la
// clave que cifra el respaldo. Quien lo tiene entra a la sala por el camino de respaldo: se comparte solo con quienes
// pueden entrar, como una contraseña. Una sala del servidor suma al final "R" y su id (32 hex): hace falta para que las
// firmas coincidan (cada mensaje se firma con el id de la sala). Una sala de emergencia usa "bk:<codigo>" y no lo necesita.
export function formatBackupCode(code, secret, roomId = null) {
  const s = String(secret).toUpperCase();
  let out = `${String(code).toUpperCase()}-${s.match(/.{1,4}/g).join('-')}`;
  const hex = String(roomId || '').replace(/-/g, '').toUpperCase();
  if (/^[0-9A-F]{32}$/.test(hex)) out += `-R${hex.slice(0, 8)}-${hex.slice(8, 16)}-${hex.slice(16, 24)}-${hex.slice(24)}`;
  return out;
}

// -> { code, secret, roomId|null } o null
export function parseBackupCode(input) {
  const raw = String(input ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  const head = raw.slice(0, CODE_LEN + SECRET_LEN);
  if (!BACKUP_CODE_RE.test(head)) return null;
  const out = { code: raw.slice(0, CODE_LEN), secret: raw.slice(CODE_LEN, CODE_LEN + SECRET_LEN), roomId: null };
  if (raw.length === CODE_LEN + SECRET_LEN) return out;
  const tail = raw.slice(CODE_LEN + SECRET_LEN);
  if (!/^R[0-9A-F]{32}$/.test(tail)) return null;
  const h = tail.slice(1).toLowerCase();
  out.roomId = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  return out;
}

// Sala de emergencia nueva: codigo y clave al azar (120 bits de clave)
export function newEmergencyRoom() {
  return { code: pick(CODE_LEN), secret: pick(SECRET_LEN) };
}

// La clave de una sala del servidor se puede compartir como codigo de respaldo si usa el mismo alfabeto
export function shareableSecret(secret) {
  return typeof secret === 'string' && new RegExp(`^[${ALPHABET}]{${SECRET_LEN}}$`).test(secret.toUpperCase());
}

// ---------- Salas guardadas ----------
// Por cuenta (o "anon" sin sesion). Las claves se guardan en el equipo para poder volver a entrar por el respaldo cuando el
// servidor no responde y no se las puede pedir. Tope y vencimiento para que no crezca ni quede para siempre.
const VAULT_KEY = 'venus.voice.backup.v1';
export const VAULT_MAX = 24;
export const VAULT_TTL = 30 * 24 * 3600 * 1000;

function browserStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

export class RoomVault {
  constructor(storage = browserStorage(), now = () => Date.now()) {
    this.storage = storage;
    this.now = now;
    this.mem = {};
  }

  read() {
    try {
      const raw = this.storage?.getItem(VAULT_KEY);
      const data = raw ? JSON.parse(raw) : this.mem;
      return data && typeof data === 'object' ? data : {};
    } catch {
      return this.mem;
    }
  }

  write(data) {
    this.mem = data;
    try {
      this.storage?.setItem(VAULT_KEY, JSON.stringify(data));
    } catch {
      /* sin almacenamiento: queda en memoria hasta cerrar */
    }
  }

  scopeList(data, scope) {
    const now = this.now();
    const list = data[scope] && typeof data[scope] === 'object' ? Object.values(data[scope]) : [];
    return list.filter((e) => e && typeof e.code === 'string' && SECRET_RE.test(String(e.secret)) && now - (Number(e.used) || 0) < VAULT_TTL).sort((a, b) => b.used - a.used);
  }

  list(scope) {
    return this.scopeList(this.read(), scope || 'anon');
  }

  get(scope, code) {
    return this.list(scope).find((e) => e.code === code) || null;
  }

  // entry: { code, secret, name?, roomId?, ownerId?, emergency? }
  put(scope, entry) {
    if (!entry?.code || !SECRET_RE.test(String(entry.secret))) return null;
    const data = this.read();
    const key = scope || 'anon';
    const prev = (data[key] || {})[entry.code] || {};
    const row = {
      code: String(entry.code).slice(0, 8),
      secret: String(entry.secret),
      name: String(entry.name ?? prev.name ?? '').slice(0, 40),
      roomId: entry.roomId ?? prev.roomId ?? null,
      ownerId: entry.ownerId ?? prev.ownerId ?? null,
      emergency: Boolean(entry.emergency ?? prev.emergency),
      used: this.now(),
    };
    const keep = this.scopeList({ [key]: { ...(data[key] || {}), [row.code]: row } }, key).slice(0, VAULT_MAX);
    data[key] = Object.fromEntries(keep.map((e) => [e.code, e]));
    this.write(data);
    return row;
  }

  remove(scope, code) {
    const data = this.read();
    const key = scope || 'anon';
    if (data[key]?.[code]) {
      delete data[key][code];
      this.write(data);
    }
  }
}

// ---------- ¿Es el servidor o es la sala? ----------
// supabase-js devuelve { error: { message, code } } y el estado HTTP. Un error con codigo de Postgres/PostgREST (o un 4xx)
// es una respuesta del servidor: la sala no existe, falta permiso... Sin codigo, y con 0/5xx o un fallo de red, el
// servidor no esta respondiendo y vale el respaldo.
export function isOutage(error, status = null) {
  if (!error) return false;
  if (error.name === 'VoiceTimeout') return true;
  const code = String(error.code ?? '');
  const st = status === null || status === undefined ? NaN : Number(status);
  if (code && /^(PGRST|[0-9A-Z]{5}$)/.test(code) && !(st >= 500)) return false;
  if (st >= 500 || st === 408 || st === 0) return true;
  return /failed to fetch|fetch failed|network|load failed|timed? ?out|abort|econn|enotfound|socket|unreachable|offline|err_|failed to send a request/i.test(`${error.name || ''} ${error.message || ''}`);
}

// ---------- STUN ----------
// Servidores publicos (probados el 5/11/2026). Los dos primeros son de proveedores distintos: si uno se cae o esta
// bloqueado, el otro alcanza. Los demas se suman cuando la conexion no logra salir (reinicio de ICE o respaldo) para
// no cargar el arranque de cada llamada con servidores de mas.
export const STUN_BASE = ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'];
export const STUN_MORE = ['stun:global.stun.twilio.com:3478', 'stun:stun.nextcloud.com:3478', 'stun:stun1.l.google.com:19302', 'stun:stun.sipgate.net:3478'];

export function stunServers(level = 0) {
  return [{ urls: level > 0 ? [...STUN_BASE, ...STUN_MORE] : [...STUN_BASE] }];
}
