// Lógica pura de los Grupos para jugar (sin DOM, sin Electron, sin red): el estado del grupo que tiene el líder,
// las transiciones (invitar, aceptar, rechazar, salir, echar, listo, plan, jugar todos), lo que ve un miembro
// (aplicar el estado que manda el líder, líder caído) y la validación de las señales party-* que llegan de amigos.
// Todo lo que viene de otro usuario pasa por acá antes de mostrarse o usarse. Se prueba con Node (party/test).
//
// Topología en estrella: las señales de social solo viajan entre amigos, así que todo pasa por el líder (que es
// amigo de cada miembro). Los miembros entre sí pueden no ser amigos: por eso el estado lleva los nombres.

export const PROTOCOL = 1;
export const MAX_MEMBERS = 8; // con el líder, igual que una sala de voz (voice.MAX_MEMBERS)
export const MAX_PAYLOAD = 4096; // límite de social_send_signal (bytes del JSON)
export const INVITE_TTL_MS = 5 * 60_000; // una invitación sin responder vence a los 5 minutos
export const STATE_EVERY_MS = 60_000; // el líder reenvía el estado cada minuto aunque no cambie nada
export const LEADER_TIMEOUT_MS = 200_000; // sin noticias del líder (3 estados perdidos + margen): grupo disuelto
export const PRESENCE_GRACE_MS = 90_000; // con la presencia en "desconectado", cuánto se espera un estado nuevo
export const JOIN_TIMEOUT_MS = 20_000; // después de aceptar, cuánto se espera el primer estado

export const SIGNALS = Object.freeze({
  invite: 'party-invite',
  accept: 'party-accept',
  decline: 'party-decline',
  leave: 'party-leave',
  kick: 'party-kick',
  ready: 'party-ready',
  state: 'party-state',
  play: 'party-play',
  end: 'party-end',
});
export const SIGNAL_TYPES = Object.freeze(Object.values(SIGNALS));

// Preparación de un miembro para el plan elegido: ok (tiene la instancia), update (tiene el modpack compartido
// pero desactualizado), missing (no tiene nada que sirva), unknown (todavía no hay plan o no se calculó).
export const PREP = Object.freeze(['ok', 'update', 'missing', 'unknown']);
export const END_REASONS = Object.freeze(['closed', 'leader', 'timeout']);
const LOADER_KEYS = ['vanilla', 'fabric', 'forge', 'neoforge', 'quilt', 'optifine', 'iris', 'legacyfabric', 'babric'];

// ---------- Validadores básicos ----------

// Caracteres de control, separadores de línea (U+2028/U+2029) y marcas de dirección/ancho cero: se arman con
// String.fromCharCode para que el archivo no tenga esos caracteres literales.
const cc = (a, b) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`;
const CONTROL = new RegExp(`[${cc(0x00, 0x1f)}${cc(0x7f, 0x9f)}${cc(0x2028, 0x2029)}${cc(0x200b, 0x200f)}${cc(0x202a, 0x202e)}${cc(0x2066, 0x2069)}]`, 'g');
export function cleanText(v, max = 40) {
  if (typeof v !== 'string') return '';
  return v.replace(CONTROL, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const isUserId = (v) => typeof v === 'string' && ID_RE.test(v);

const PARTY_RE = /^[A-Za-z0-9]{8,24}$/;
export const isPartyId = (v) => typeof v === 'string' && PARTY_RE.test(v);

const SHARE_CODE_RE = /^PACK-[A-HJ-NP-Z2-9]{6}$/;
export const isShareCode = (v) => typeof v === 'string' && SHARE_CODE_RE.test(v);

const VOICE_RE = /^[A-HJ-NP-Z2-9]{6}$/;
export const isVoiceCode = (v) => typeof v === 'string' && VOICE_RE.test(v);

const MC_RE = /^[\w.\- ]{1,24}$/;
export const isMcVersion = (v) => typeof v === 'string' && MC_RE.test(v);
export const isLoader = (v) => typeof v === 'string' && LOADER_KEYS.includes(v);

// "host", "host:puerto" o "[ipv6]:puerto". Acepta direcciones de la red local (amigos en la misma casa) y las de
// e4mc / túneles; rechaza espacios, esquemas, rutas y puertos fuera de rango.
export function cleanAddress(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/^minecraft:\/\//i, '').replace(/\/+$/, '').replace(/\.(?=:|$)/, '');
  if (!s || s.length > 260) return null;
  const v6 = s.match(/^\[([0-9a-fA-F:.]{2,45})\](?::(\d{1,5}))?$/);
  if (v6) return !v6[2] || (Number(v6[2]) >= 1 && Number(v6[2]) <= 65535) ? s.toLowerCase() : null;
  const m = s.match(/^([a-zA-Z0-9](?:[a-zA-Z0-9_-]{0,62})(?:\.[a-zA-Z0-9_](?:[a-zA-Z0-9_-]{0,62}))*)(?::(\d{1,5}))?$/);
  if (!m) return null;
  if (m[2] !== undefined && (Number(m[2]) < 1 || Number(m[2]) > 65535)) return null;
  if (/(^|\.)-|-(\.|$)/.test(m[1])) return null;
  return s.toLowerCase();
}

// "host:puerto" -> { server, port } para Quick Play
export function quickPlayOf(address) {
  const a = cleanAddress(address);
  if (!a) return null;
  const v6 = a.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (v6) return { server: `[${v6[1]}]`, port: Number(v6[2] || 25565) };
  const [server, port] = a.split(':');
  return { server, port: Number(port || 25565) };
}

// Clave estable de una dirección (sin el puerto por defecto) para comparar servidores
export function addressKey(address) {
  const a = cleanAddress(address);
  return a ? a.replace(/:25565$/, '') : '';
}

export function payloadBytes(payload) {
  try {
    return new TextEncoder().encode(JSON.stringify(payload)).length;
  } catch {
    return Infinity;
  }
}
export const fitsPayload = (payload) => payloadBytes(payload) <= MAX_PAYLOAD;

export function newPartyId(rand = Math.random) {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 12; i++) out += abc[Math.floor(rand() * abc.length) % abc.length];
  return out;
}

// ---------- Plan (qué se juega y dónde) ----------

export function cleanPack(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const mcVersion = isMcVersion(raw.mcVersion) ? raw.mcVersion : null;
  const loader = isLoader(raw.loader) ? raw.loader : 'vanilla';
  const name = cleanText(raw.name, 60);
  if (raw.kind === 'shared') {
    if (!isShareCode(raw.code) || !mcVersion) return null;
    const revision = Number.isInteger(raw.revision) && raw.revision >= 0 && raw.revision < 1e7 ? raw.revision : 0;
    return { kind: 'shared', code: raw.code, name: name || raw.code, revision, mcVersion, loader };
  }
  if (raw.kind === 'version') {
    if (!mcVersion) return null;
    return { kind: 'version', name, mcVersion, loader };
  }
  return null;
}

export function cleanTarget(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const name = cleanText(raw.name, 60);
  if (raw.kind === 'server') {
    const address = cleanAddress(raw.address);
    return address ? { kind: 'server', address, name: name || address } : null;
  }
  if (raw.kind === 'world') {
    const address = raw.address == null ? null : cleanAddress(raw.address);
    if (raw.address != null && !address) return null;
    return { kind: 'world', address, name };
  }
  return null;
}

export function cleanPlan(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const pack = cleanPack(raw.pack);
  if (!pack) return null;
  const target = raw.target == null ? null : cleanTarget(raw.target);
  if (raw.target != null && !target) return null;
  return { pack, target };
}

// Un plan se puede jugar cuando tiene instancia y destino (el mundo puede no tener dirección todavía: el líder la
// manda apenas e4mc o el túnel la publican, y los miembros entran solos).
export const planComplete = (plan) => Boolean(plan?.pack && plan?.target);

// ---------- Estado del grupo (lo tiene el líder) ----------

const memberOf = (party, id) => party.members.find((m) => m.id === id) || null;
const bump = (party, patch) => ({ ...party, ...patch, rev: party.rev + 1 });
const result = (party, ok = true, error = null) => ({ party, ok, error });
export const memberCount = (party) => (party ? party.members.length : 0);
export const slotsLeft = (party) => (party ? MAX_MEMBERS - party.members.length - party.invited.length : 0);

export function createParty({ id, leader, now = Date.now() } = {}) {
  if (!isPartyId(id) || !leader || !isUserId(leader.id)) throw new Error('bad_party');
  return {
    id,
    leader: leader.id,
    rev: 1,
    createdAt: now,
    members: [{ id: leader.id, name: cleanText(leader.name) || '?', ready: true, prep: 'ok', online: true, leader: true, joinedAt: now }],
    invited: [],
    plan: null,
    voice: null,
    play: null,
  };
}

// errores: self, already (ya está o ya fue invitado), full, bad
export function invite(party, user, now = Date.now()) {
  if (!user || !isUserId(user.id)) return result(party, false, 'bad');
  if (user.id === party.leader) return result(party, false, 'self');
  if (memberOf(party, user.id)) return result(party, false, 'already');
  const pending = party.invited.find((i) => i.id === user.id);
  if (pending && now - pending.at < INVITE_TTL_MS) return result(party, false, 'already');
  const invited = party.invited.filter((i) => i.id !== user.id);
  if (party.members.length + invited.length >= MAX_MEMBERS) return result(party, false, 'full');
  return result(bump(party, { invited: [...invited, { id: user.id, name: cleanText(user.name) || '?', at: now }] }));
}

// errores: not_invited, expired, full (el último lugar lo ocupó otro antes)
export function acceptInvite(party, userId, name, now = Date.now()) {
  if (memberOf(party, userId)) return result(party, true, null); // aceptó dos veces: no cambia nada
  const inv = party.invited.find((i) => i.id === userId);
  if (!inv) return result(party, false, 'not_invited');
  const invited = party.invited.filter((i) => i.id !== userId);
  if (now - inv.at >= INVITE_TTL_MS) return result(bump(party, { invited }), false, 'expired');
  if (party.members.length >= MAX_MEMBERS) return result(bump(party, { invited }), false, 'full');
  const member = { id: userId, name: cleanText(name) || inv.name, ready: false, prep: 'unknown', online: true, leader: false, joinedAt: now };
  return result(bump(party, { invited, members: [...party.members, member] }));
}

export function declineInvite(party, userId) {
  if (!party.invited.some((i) => i.id === userId)) return result(party, false, 'not_invited');
  return result(bump(party, { invited: party.invited.filter((i) => i.id !== userId) }));
}
export const cancelInvite = declineInvite;

// Sale un miembro (el líder no "sale": disuelve el grupo con party-end)
export function leave(party, userId) {
  if (userId === party.leader) return result(party, false, 'leader');
  if (!memberOf(party, userId)) return result(party, false, 'not_member');
  return result(bump(party, { members: party.members.filter((m) => m.id !== userId) }));
}

export function kick(party, userId, byId = party.leader) {
  if (byId !== party.leader) return result(party, false, 'not_leader');
  if (userId === party.leader) return result(party, false, 'self');
  return leave(party, userId);
}

export function setReady(party, userId, ready, prep) {
  const m = memberOf(party, userId);
  if (!m || m.leader) return result(party, false, 'not_member');
  const next = { ...m, ready: Boolean(ready), prep: PREP.includes(prep) ? prep : m.prep };
  if (next.ready === m.ready && next.prep === m.prep) return result(party, true, null);
  return result(bump(party, { members: party.members.map((x) => (x.id === userId ? next : x)) }));
}

export function setOnline(party, userId, online) {
  const m = memberOf(party, userId);
  if (!m || m.online === Boolean(online)) return result(party, Boolean(m), m ? null : 'not_member');
  return result(bump(party, { members: party.members.map((x) => (x.id === userId ? { ...x, online: Boolean(online) } : x)) }));
}

// El plan cambia: los miembros vuelven a "no listo" (tienen que revisar la instancia de nuevo), salvo que solo
// cambie la dirección del mundo del líder (se abrió, se cerró o cambió el túnel).
export function setPlan(party, rawPlan) {
  const plan = rawPlan == null ? null : cleanPlan(rawPlan);
  if (rawPlan != null && !plan) return result(party, false, 'bad_plan');
  if (JSON.stringify(plan) === JSON.stringify(party.plan)) return result(party, true, null);
  const onlyAddress = plan && party.plan && JSON.stringify(plan.pack) === JSON.stringify(party.plan.pack) && plan.target?.kind === 'world' && party.plan.target?.kind === 'world';
  const members = onlyAddress ? party.members : party.members.map((m) => (m.leader ? m : { ...m, ready: false, prep: 'unknown' }));
  return result(bump(party, { plan, members }));
}

export function setVoice(party, code) {
  const voice = code == null ? null : isVoiceCode(code) ? code : undefined;
  if (voice === undefined) return result(party, false, 'bad_voice');
  if (voice === party.voice) return result(party, true, null);
  return result(bump(party, { voice }));
}

// "Jugar todos": hace falta un plan completo y al menos un miembro además del líder
export function startPlay(party, now = Date.now()) {
  if (!planComplete(party.plan)) return result(party, false, 'no_plan');
  if (party.members.length < 2) return result(party, false, 'alone');
  const seq = (party.play?.seq || 0) + 1;
  return result(bump(party, { play: { seq, at: now } }));
}

export function expireInvites(party, now = Date.now()) {
  const invited = party.invited.filter((i) => now - i.at < INVITE_TTL_MS);
  return invited.length === party.invited.length ? result(party, true, null) : result(bump(party, { invited }));
}

// Lo que viaja en party-state (sin fechas internas). Si no entra en 4 KB, se acortan los nombres.
export function toWire(party, leaderName) {
  const build = (max) => ({
    v: PROTOCOL,
    party: party.id,
    rev: party.rev,
    leaderName: cleanText(leaderName, max) || cleanText(memberOf(party, party.leader)?.name, max) || '?',
    members: party.members.map((m) => ({ id: m.id, name: cleanText(m.name, max) || '?', ready: Boolean(m.ready), prep: m.prep, online: Boolean(m.online) })),
    invited: party.invited.map((i) => ({ id: i.id, name: cleanText(i.name, max) || '?' })),
    plan: party.plan,
    voice: party.voice,
    play: party.play ? { seq: party.play.seq } : null,
  });
  for (const max of [40, 20, 10]) {
    const wire = build(max);
    if (fitsPayload(wire)) return wire;
  }
  return null;
}

// ---------- Validación de las señales que llegan ----------

const bool = (v) => v === true;
const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

function cleanMemberList(list, { full }) {
  if (!Array.isArray(list) || list.length > MAX_MEMBERS) return null;
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || !isUserId(raw.id) || seen.has(raw.id)) return null;
    seen.add(raw.id);
    const name = cleanText(raw.name) || '?';
    out.push(full ? { id: raw.id, name, ready: bool(raw.ready), prep: PREP.includes(raw.prep) ? raw.prep : 'unknown', online: raw.online !== false } : { id: raw.id, name });
  }
  return out;
}

// Devuelve el payload normalizado o null si no sirve. `type` es el tipo de la señal (party-*).
export function parseSignal(type, payload) {
  if (!SIGNAL_TYPES.includes(type)) return null;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (payload.v !== PROTOCOL || !isPartyId(payload.party)) return null;
  const base = { party: payload.party };
  switch (type) {
    case SIGNALS.invite:
      return { ...base, size: intIn(payload.size, 1, MAX_MEMBERS) ? payload.size : 1, game: cleanText(payload.game, 60), where: cleanText(payload.where, 60) };
    case SIGNALS.accept:
    case SIGNALS.decline:
    case SIGNALS.leave:
    case SIGNALS.kick:
      return base;
    case SIGNALS.end:
      return { ...base, reason: END_REASONS.includes(payload.reason) ? payload.reason : 'closed' };
    case SIGNALS.ready:
      return { ...base, ready: bool(payload.ready), prep: PREP.includes(payload.prep) ? payload.prep : 'unknown' };
    case SIGNALS.play: {
      const plan = cleanPlan(payload.plan);
      if (!planComplete(plan) || !intIn(payload.seq, 1, 1e6)) return null;
      return { ...base, seq: payload.seq, plan };
    }
    case SIGNALS.state: {
      if (!intIn(payload.rev, 1, 1e9)) return null;
      const members = cleanMemberList(payload.members, { full: true });
      const invited = payload.invited == null ? [] : cleanMemberList(payload.invited, { full: false });
      if (!members || !members.length || !invited || members.length + invited.length > MAX_MEMBERS) return null;
      if (invited.some((i) => members.some((m) => m.id === i.id))) return null;
      const plan = payload.plan == null ? null : cleanPlan(payload.plan);
      if (payload.plan != null && !plan) return null;
      const voice = isVoiceCode(payload.voice) ? payload.voice : null;
      const play = payload.play && intIn(payload.play.seq, 1, 1e6) ? { seq: payload.play.seq } : null;
      return { ...base, rev: payload.rev, leaderName: cleanText(payload.leaderName) || '?', members, invited, plan, voice, play };
    }
    default:
      return null;
  }
}

// ---------- Lado del miembro ----------

// El miembro guarda { id, leader, rev, ...estado } del grupo en el que está. evt = { fromId, payload ya validado }.
//   'ignore'  señal vieja, de otro grupo o de alguien que no es el líder
//   'update'  estado nuevo (party = estado para mostrar)
//   'removed' el líder ya no lo lista: lo sacaron (o el grupo se rearmó sin él)
export function applyState(local, fromId, parsed, myId) {
  if (!local || !parsed || fromId !== local.leader || parsed.party !== local.id) return { action: 'ignore', party: local };
  if (Number.isInteger(local.rev) && parsed.rev <= local.rev) return { action: 'ignore', party: local };
  if (!parsed.members.some((m) => m.id === myId)) return { action: 'removed', party: local };
  if (!parsed.members.some((m) => m.id === fromId)) return { action: 'ignore', party: local };
  return { action: 'update', party: { ...local, ...parsed, id: local.id, leader: local.leader } };
}

// Líder caído: hace demasiado que no manda el estado, o su presencia pasó a "desconectado" y tampoco llegó un
// estado reciente (un líder en Invisible se ve desconectado pero sigue mandando el estado cada minuto).
export function leaderLost({ lastStateAt, now = Date.now(), presence } = {}) {
  if (!Number.isFinite(lastStateAt)) return presence === 'offline';
  const age = now - lastStateAt;
  if (age > LEADER_TIMEOUT_MS) return true;
  return presence === 'offline' && age > PRESENCE_GRACE_MS;
}

// Lado del líder: miembros que dejaron de latir (party-ready cada minuto). seen = Map(id -> último latido).
// Un miembro sin ningún latido registrado cuenta desde que entró.
export function staleMembers(party, seen, now = Date.now()) {
  if (!party) return [];
  return party.members
    .filter((m) => m.id !== party.leader)
    .filter((m) => {
      const at = seen?.get?.(m.id) ?? m.joinedAt;
      return Number.isFinite(at) && now - at > LEADER_TIMEOUT_MS;
    })
    .map((m) => m.id);
}

// ¿Qué instancia de esta PC sirve para el plan? instances = store.instances.
//   shared: la vinculada al código (al día -> ok, atrasada -> update); si no hay -> missing
//   version: la jugada más recientemente con la misma versión y loader -> ok; si no hay -> missing
export function loaderKeyOf(inst) {
  return inst?.preset === 'iris' ? 'iris' : inst?.loader || 'vanilla';
}

export function prepFor(plan, instances = []) {
  const pack = plan?.pack;
  if (!pack) return { prep: 'unknown', instanceId: null };
  const list = Array.isArray(instances) ? instances : [];
  const recent = (a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0);
  if (pack.kind === 'shared') {
    const linked = list.filter((i) => i?.share?.code === pack.code).sort(recent);
    const best = linked.find((i) => (i.share.revision || 0) >= pack.revision) || linked[0];
    if (!best) return { prep: 'missing', instanceId: null };
    return { prep: (best.share.revision || 0) >= pack.revision ? 'ok' : 'update', instanceId: best.id };
  }
  const same = list.filter((i) => i && i.mcVersion === pack.mcVersion && loaderKeyOf(i) === pack.loader).sort(recent);
  return same.length ? { prep: 'ok', instanceId: same[0].id } : { prep: 'missing', instanceId: null };
}

// Plan que arma el líder a partir de una instancia suya: si está compartida (share.js), el código del modpack; si
// no, la versión de Minecraft y el loader.
export function packFromInstance(inst) {
  if (!inst || !isMcVersion(inst.mcVersion)) return null;
  const s = inst.share;
  if (s && isShareCode(s.code)) {
    return cleanPack({ kind: 'shared', code: s.code, name: s.name || inst.name, revision: Number.isInteger(s.revision) ? s.revision : 0, mcVersion: inst.mcVersion, loader: loaderKeyOf(inst) });
  }
  return cleanPack({ kind: 'version', name: inst.name, mcVersion: inst.mcVersion, loader: loaderKeyOf(inst) });
}

// Invitaciones que llegan: el mismo grupo del mismo amigo se ignora durante 30 s y cada amigo abre como mucho
// 3 avisos por minuto (igual que las invitaciones de share y netplay).
export function createInviteGate({ repeatMs = 30_000, windowMs = 60_000, max = 3 } = {}) {
  const log = new Map();
  return {
    allow(sender, key, now = Date.now()) {
      const recent = (log.get(sender) || []).filter((x) => now - x.at < windowMs);
      const ok = recent.length < max && !recent.some((x) => x.key === key && now - x.at < repeatMs);
      if (ok) recent.push({ at: now, key });
      log.set(sender, recent);
      if (log.size > 200) log.delete(log.keys().next().value);
      return ok;
    },
  };
}
