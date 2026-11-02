// Grupos para jugar: armar un grupo con amigos (hasta 8 con el líder), elegir qué jugar (una instancia del líder:
// el código del modpack compartido o la versión y el loader) y dónde (un servidor o el mundo del líder abierto a
// amigos), ver quién está listo, crear una sala de voz para todos y "Jugar todos".
// Sin base de datos: todo viaja por las señales entre amigos de social (party-*, sección 6.6 de la arquitectura).
// El líder tiene el estado y lo manda a cada miembro; los miembros solo le hablan al líder (topología en estrella).
//
// Contrato:
//   startup()               escucha las señales party-*, la presencia y los eventos de netplay (idempotente)
//   openParty()             panel del grupo (diálogo); sin sesión de Venus lleva a Ajustes > Cuenta y nube
//   partyButton() -> Element  botón para la barra de título o el menú lateral (con .destroy())
//   partyCard() -> Element    tarjeta para Multijugador o Inicio (con .destroy())
// Extras: onPartyChange(fn) -> off, partySnapshot(), inviteToParty(userId) (desde Mensajes o un perfil).
import { h, icon, mount, toast, ok, fail, ensureCss, registerIcons } from '../ui.js';
import { store, api } from '../store.js';
import { t, loadNs, onLanguageChange } from '../i18n.js';
import { cloud } from '../cloud.js';
import { social } from '../social.js';
import { navigate } from '../app.js';
import * as L from './party/logic.js';
import { actionToast, pushOverlay } from './party/toasts.js';

registerIcons({
  ptCrown: '<path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z"/>',
  ptPartyUsers: '<path d="M18 21a8 8 0 0 0-16 0"/><circle cx="10" cy="8" r="5"/><path d="M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3"/>',
});

const NS = 'party';
const ACHIEVEMENT = 'first_party';
let readyPromise = null;

export function prepare() {
  ensureCss('features/party');
  ensureCss('features/notify');
  if (!readyPromise) readyPromise = loadNs(NS).catch((err) => console.warn('[party] textos', err));
  return readyPromise;
}

// ---------- Estado de esta PC ----------
// role: null | 'leader' | 'member'
// party: líder -> estado interno de logic.js; miembro -> último estado del líder + { lastStateAt }
const S = {
  started: false,
  owner: null, // cuenta de Venus con la que se armó o se entró al grupo
  role: null,
  party: null,
  instanceId: null, // instancia elegida por el líder
  joining: null, // miembro que aceptó y espera el primer estado: { party, leader, leaderName, at }
  invites: new Map(), // amigo -> invitación recibida { party, leader, name, at, size, game, where }
  seen: new Map(), // líder: miembro -> último latido
  myReady: false,
  myPrep: { prep: 'unknown', instanceId: null },
  playedSeq: 0,
  pendingPlay: null, // miembro: plan de "Jugar todos" esperando la dirección del mundo del líder
  achieved: false,
  timers: [],
};
const listeners = new Set();
const gate = L.createInviteGate();
let broadcastTimer = null;
let joinTimer = null;

// Avisa a la interfaz solo si algo visible cambió (el tick de cada 20 s no redibuja de más)
let lastEmitted = '';
function emit(force = false) {
  const snap = partySnapshot();
  const key = JSON.stringify(snap);
  if (key === lastEmitted && !force) return;
  lastEmitted = key;
  for (const fn of [...listeners]) {
    try {
      fn(snap);
    } catch (err) {
      console.error('[party]', err);
    }
  }
}

export function onPartyChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const myId = () => social.userId || cloud.user?.id || null;
function myName() {
  const p = cloud.profile || social.me;
  return L.cleanText(p?.display_name || p?.username || store.selectedAccount()?.name || '') || '?';
}
const nameOf = (id) => L.cleanText(social.friendById?.(id)?.name || '') || L.cleanText(social.nameOf?.(id) || '') || '?';

// Vista para la interfaz (panel, botón y tarjeta). No se modifica desde afuera.
export function partySnapshot() {
  const p = S.party;
  const me = myId();
  const base = { role: S.role, me, joining: S.joining ? { leaderName: S.joining.leaderName } : null, invites: [...S.invites.values()].filter((i) => Date.now() - i.at < L.INVITE_TTL_MS), gate: gateState() };
  if (!p) return { ...base, party: null };
  const leaderName = S.role === 'leader' ? myName() : p.leaderName;
  return {
    ...base,
    party: {
      id: p.id,
      leader: p.leader,
      leaderName,
      members: p.members.map((m) => ({ ...m, leader: m.id === p.leader, self: m.id === me, online: S.role === 'leader' && m.id !== me ? memberOnline(m.id) : m.online })),
      invited: p.invited.map((i) => ({ id: i.id, name: i.name })),
      plan: p.plan,
      voice: p.voice,
      play: p.play,
      instanceId: S.role === 'leader' ? S.instanceId : null,
      myReady: S.myReady,
      myPrep: S.myPrep,
      pendingPlay: Boolean(S.pendingPlay),
      slots: L.MAX_MEMBERS - p.members.length - p.invited.length,
    },
  };
}

// Qué falta para poder usar los grupos: 'cloud' (sin nube), 'signin', 'service' (servicio caído o sin esquema),
// 'loading' o null (todo listo)
function gateState() {
  const st = social.state;
  if (st === 'ready') return null;
  if (!cloud.isConfigured()) return 'cloud';
  if (!cloud.isSignedIn()) return 'signin';
  if (st === 'missingSchema' || st === 'error' || st === 'disabled') return 'service';
  if (st === 'signedOut') return 'signin';
  return 'loading';
}

// ---------- Envío de señales ----------

async function send(userId, type, payload) {
  const body = { v: L.PROTOCOL, ...payload };
  if (!L.fitsPayload(body)) throw new Error(t('party.errTooBig'));
  return social.sendSignal(userId, type, body);
}

function sendQuiet(userId, type, payload) {
  return send(userId, type, payload).catch((err) => {
    console.warn('[party] señal', type, err?.message || err);
    return false;
  });
}

function overlay(title, body) {
  pushOverlay({ kind: 'alert', title, body: body || undefined, icon: 'party', ttl: 6000 });
}

function achievement() {
  if (S.achieved) return;
  S.achieved = true;
  try {
    window.dispatchEvent(new CustomEvent('venus:achievement', { detail: { id: ACHIEVEMENT } }));
  } catch {
    /* sin logros */
  }
}

// ---------- Líder ----------

function leaderParty() {
  return S.role === 'leader' ? S.party : null;
}

// Aplica una transición de logic.js; si cambió algo, avisa a la interfaz y manda el estado a los miembros
function commit(res, { quiet = false } = {}) {
  if (!res || res.party === S.party) return res;
  S.party = res.party;
  if (!quiet) scheduleBroadcast();
  emit();
  return res;
}

function scheduleBroadcast(now = false) {
  clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(broadcast, now ? 0 : 250);
}

async function broadcast() {
  const p = leaderParty();
  if (!p) return;
  const wire = L.toWire(p, myName());
  if (!wire) {
    console.warn('[party] el estado no entra en una señal');
    return;
  }
  const others = p.members.filter((m) => m.id !== p.leader);
  await Promise.all(
    others.map((m) =>
      send(m.id, L.SIGNALS.state, wire).catch((err) => {
        // Ya no son amigos (o el servidor lo rechazó): se lo saca del grupo
        if (!social.isFriend(m.id)) removeMember(m.id, 'gone');
        else console.warn('[party] estado', err?.message || err);
      }),
    ),
  );
}

export async function createParty() {
  await prepare();
  const g = gateState();
  if (g === 'signin' || g === 'cloud') {
    navigate('settings/cloud');
    return false;
  }
  if (g) {
    toast('info', t('party.serviceDown'), t('party.serviceDownText'));
    return false;
  }
  if (S.role === 'leader') return true;
  if (S.role === 'member') await leaveParty({ silent: true });
  S.party = L.createParty({ id: L.newPartyId(), leader: { id: myId(), name: myName() } });
  S.role = 'leader';
  S.owner = myId();
  S.seen.clear();
  const inst = store.selectedInstance();
  if (inst) setLeaderInstance(inst.id, { quiet: true });
  emit();
  return true;
}

// Invitar a un amigo (crea el grupo si todavía no hay uno)
export async function inviteToParty(userId) {
  await prepare();
  if (S.role === 'member') {
    toast('info', t('party.onlyLeaderInvites'), t('party.onlyLeaderInvitesText', { name: S.party?.leaderName || '' }));
    return false;
  }
  if (!S.role && !(await createParty())) return false;
  const p = leaderParty();
  const friend = social.friendById?.(userId);
  if (!friend) {
    fail(t('party.inviteFailed'), t('party.notFriend'));
    return false;
  }
  const res = L.invite(p, { id: userId, name: friend.name });
  if (!res.ok) {
    if (res.error === 'full') toast('info', t('party.full'), t('party.fullText', { max: L.MAX_MEMBERS }));
    else if (res.error === 'already') toast('info', t('party.alreadyInvited', { name: friend.name }));
    return false;
  }
  commit(res, { quiet: true });
  try {
    await send(userId, L.SIGNALS.invite, { party: p.id, size: res.party.members.length, game: planGame(res.party.plan), where: planWhere(res.party.plan) });
    ok(t('party.invited', { name: friend.name }));
    return true;
  } catch (err) {
    commit(L.cancelInvite(S.party, userId), { quiet: true });
    fail(t('party.inviteFailed'), err);
    return false;
  }
}

export async function cancelInvite(userId) {
  const p = leaderParty();
  if (!p) return;
  const res = L.cancelInvite(p, userId);
  if (!res.ok) return;
  commit(res, { quiet: true });
  sendQuiet(userId, L.SIGNALS.end, { party: p.id, reason: 'closed' });
}

function removeMember(userId, why) {
  const p = leaderParty();
  if (!p) return;
  const name = p.members.find((m) => m.id === userId)?.name || nameOf(userId);
  const res = L.leave(p, userId);
  if (!res.ok) return;
  S.seen.delete(userId);
  commit(res);
  if (why === 'left') {
    toast('info', t('party.memberLeft', { name }));
    overlay(t('party.memberLeft', { name }));
  } else if (why === 'timeout' || why === 'gone') {
    toast('info', t('party.memberLost', { name }), t('party.memberLostText'));
  }
}

export async function kickMember(userId) {
  const p = leaderParty();
  if (!p) return;
  const name = p.members.find((m) => m.id === userId)?.name || nameOf(userId);
  const res = L.kick(p, userId, myId());
  if (!res.ok) return;
  S.seen.delete(userId);
  commit(res);
  await sendQuiet(userId, L.SIGNALS.kick, { party: p.id });
  toast('info', t('party.kicked', { name }));
}

// El líder elige una de sus instancias: el plan toma el código del modpack compartido o la versión y el loader
export function setLeaderInstance(instanceId, { quiet = false } = {}) {
  const p = leaderParty();
  if (!p) return;
  S.instanceId = instanceId || null;
  const inst = store.instances.find((i) => i.id === instanceId);
  const pack = L.packFromInstance(inst);
  if (!pack) {
    commit(L.setPlan(p, null), { quiet });
    return;
  }
  let target = p.plan?.target || null;
  // El mundo es el de la instancia elegida: al cambiar de instancia se olvida la dirección anterior
  if (target?.kind === 'world') target = { kind: 'world', name: inst.name, address: null };
  commit(L.setPlan(p, { pack, target }), { quiet });
  if (target?.kind === 'world') refreshWorldAddress();
}

// target: { kind: 'server', address, name } | { kind: 'world' } | null
export function setTarget(target) {
  const p = leaderParty();
  if (!p || !p.plan?.pack) return false;
  let next = null;
  if (target?.kind === 'world') {
    const inst = store.instances.find((i) => i.id === S.instanceId);
    next = { kind: 'world', name: inst?.name || '', address: null };
  } else if (target?.kind === 'server') {
    next = L.cleanTarget(target);
    if (!next) return false;
  }
  const res = commit(L.setPlan(p, { pack: p.plan.pack, target: next }));
  if (next?.kind === 'world') refreshWorldAddress();
  return Boolean(res?.ok);
}

// Dirección del mundo del líder (e4mc o túnel de netplay) para la instancia elegida
function worldAddressOf(snap) {
  if (!snap) return null;
  if (snap.domain) return L.cleanAddress(snap.domain);
  const tun = snap.tunnel;
  if (tun && (tun.status === 'online' || tun.status === 'reconnecting') && tun.publicAddress) return L.cleanAddress(tun.publicAddress);
  return null;
}

function setWorldAddress(address) {
  const p = leaderParty();
  if (!p || p.plan?.target?.kind !== 'world') return;
  const next = address ? L.cleanAddress(address) : null;
  if ((p.plan.target.address || null) === next) return;
  commit(L.setPlan(p, { pack: p.plan.pack, target: { ...p.plan.target, address: next } }));
  if (next && p.members.length > 1) overlay(t('party.worldOpenTitle'), next);
}

async function refreshWorldAddress() {
  const id = S.instanceId;
  if (!id) return;
  try {
    const snap = await api.invoke('netplay:worldStatus', id);
    if (S.instanceId === id) setWorldAddress(worldAddressOf(snap));
  } catch {
    /* netplay no disponible: la dirección llega por los eventos */
  }
}

export async function createVoiceRoom() {
  const p = leaderParty();
  if (!p) return false;
  try {
    const { voice, MAX_MEMBERS } = await import('../voice.js');
    let code = voice.room?.code || null;
    if (!code) {
      const room = await voice.createRoom({ name: t('party.voiceRoomName', { name: myName() }), private: true, maxMembers: Math.min(MAX_MEMBERS || 8, L.MAX_MEMBERS) });
      code = room?.code || voice.room?.code || null;
    }
    if (!code) throw new Error(t('party.voiceFailedText'));
    commit(L.setVoice(S.party, code));
    const others = S.party.members.filter((m) => m.id !== S.party.leader);
    await Promise.all(others.map((m) => voice.inviteFriend(m.id, { openPage: false }).catch((err) => console.warn('[party] voz', err?.message || err))));
    ok(t('party.voiceCreated'), t('party.voiceCreatedText'));
    return true;
  } catch (err) {
    fail(t('party.voiceFailed'), err);
    return false;
  }
}

// "Jugar todos": manda el plan a cada miembro y el líder entra también
export async function playAll() {
  const p = leaderParty();
  if (!p) return false;
  const res = L.startPlay(p);
  if (!res.ok) {
    toast('info', t(res.error === 'alone' ? 'party.playAlone' : 'party.playNoPlan'), t(res.error === 'alone' ? 'party.playAloneText' : 'party.playNoPlanText'));
    return false;
  }
  commit(res);
  const { plan, play } = S.party;
  const others = S.party.members.filter((m) => m.id !== S.party.leader);
  await Promise.all(others.map((m) => sendQuiet(m.id, L.SIGNALS.play, { party: S.party.id, seq: play.seq, plan })));
  overlay(t('party.playingTitle'), planWhere(plan));
  achievement();
  const { leaderPlay } = await import('./party/play.js');
  await leaderPlay({ plan, instanceId: S.instanceId });
  return true;
}

export async function disband({ silent = false, reason = 'closed' } = {}) {
  const p = leaderParty();
  if (!p) return;
  const targets = [...p.members.filter((m) => m.id !== p.leader).map((m) => m.id), ...p.invited.map((i) => i.id)];
  clearParty();
  await Promise.all(targets.map((id) => sendQuiet(id, L.SIGNALS.end, { party: p.id, reason })));
  if (!silent) toast('info', t('party.disbanded'));
}

// ---------- Miembro ----------

export async function acceptInvite(fromId) {
  await prepare();
  const inv = S.invites.get(fromId);
  if (!inv || Date.now() - inv.at >= L.INVITE_TTL_MS) {
    S.invites.delete(fromId);
    emit();
    toast('info', t('party.inviteExpired'));
    return false;
  }
  if (S.role === 'leader') await disband({ silent: true, reason: 'closed' });
  else if (S.role === 'member') await leaveParty({ silent: true });
  S.invites.delete(fromId);
  S.joining = { party: inv.party, leader: fromId, leaderName: inv.name, at: Date.now() };
  emit();
  try {
    await send(fromId, L.SIGNALS.accept, { party: inv.party });
  } catch (err) {
    S.joining = null;
    emit();
    fail(t('party.joinFailed'), err);
    return false;
  }
  clearTimeout(joinTimer);
  joinTimer = setTimeout(() => {
    if (S.joining?.party !== inv.party) return;
    S.joining = null;
    emit();
    toast('info', t('party.joinTimeout', { name: inv.name }), t('party.joinTimeoutText'));
  }, L.JOIN_TIMEOUT_MS);
  return true;
}

export async function declineInvite(fromId) {
  const inv = S.invites.get(fromId);
  S.invites.delete(fromId);
  emit();
  if (inv) await sendQuiet(fromId, L.SIGNALS.decline, { party: inv.party });
}

export async function leaveParty({ silent = false } = {}) {
  if (S.role !== 'member' || !S.party) return;
  const { id, leader } = S.party;
  clearParty();
  await sendQuiet(leader, L.SIGNALS.leave, { party: id });
  if (!silent) toast('info', t('party.youLeft'));
}

export function setMyReady(ready) {
  if (S.role !== 'member' || !S.party) return;
  S.myReady = Boolean(ready);
  emit();
  sendReady();
}

function sendReady() {
  if (S.role !== 'member' || !S.party) return;
  sendQuiet(S.party.leader, L.SIGNALS.ready, { party: S.party.id, ready: S.myReady, prep: S.myPrep.prep });
}

// Recalcula si esta PC tiene la instancia del plan; si cambió, se lo cuenta al líder
function recomputePrep({ announce = true } = {}) {
  if (S.role !== 'member' || !S.party) return;
  const next = L.prepFor(S.party.plan, store.instances);
  const changed = next.prep !== S.myPrep.prep || next.instanceId !== S.myPrep.instanceId;
  S.myPrep = next;
  if (changed) {
    if (next.prep !== 'ok' && S.myReady) S.myReady = false;
    emit();
    if (announce) sendReady();
  }
}

// Prepara la instancia del plan (actualizar el modpack, importarlo o crear una compatible) sin entrar a jugar
export async function prepareMine() {
  if (S.role !== 'member' || !S.party?.plan) return false;
  const { prepareInstance } = await import('./party/play.js');
  const id = await prepareInstance(S.party.plan, { prep: S.myPrep });
  recomputePrep();
  return Boolean(id);
}

// Unirse a la partida del grupo a mano (por ejemplo, si se dijo "Ahora no" o se llegó tarde)
export async function joinPartyGame() {
  if (S.role !== 'member' || !S.party?.plan) return false;
  return memberPlay(S.party.plan, { manual: true });
}

export async function joinPartyVoice() {
  const code = S.party?.voice;
  if (!code) return false;
  try {
    const { voice } = await import('../voice.js');
    await voice.joinRoom(code);
    navigate('voice');
    return true;
  } catch (err) {
    if (err?.code === 'password_required' || err?.code === 'bad_password') navigate(`voice/join/${encodeURIComponent(code)}`);
    else fail(t('party.voiceJoinFailed'), err);
    return false;
  }
}

async function memberPlay(plan, { manual = false } = {}) {
  if (plan.target?.kind === 'world' && !plan.target.address) {
    S.pendingPlay = { plan };
    emit();
    toast('info', t('party.waitingWorld', { name: S.party?.leaderName || '' }), t('party.waitingWorldText'));
    return false;
  }
  S.pendingPlay = null;
  emit();
  const { memberJoin } = await import('./party/play.js');
  const launched = await memberJoin(plan, { prep: L.prepFor(plan, store.instances), manual });
  if (launched) achievement();
  recomputePrep();
  return launched;
}

// "Jugar todos" del líder: si estaba listo entra solo en unos segundos (con Cancelar); si no, se le pregunta
function onPlay(parsed) {
  if (parsed.seq <= S.playedSeq) return;
  S.playedSeq = parsed.seq;
  const samePlan = JSON.stringify(S.party.plan) === JSON.stringify(parsed.plan);
  S.party = { ...S.party, plan: parsed.plan };
  if (!samePlan) recomputePrep();
  emit();
  const leaderName = S.party.leaderName;
  const where = planWhere(parsed.plan);
  overlay(t('party.playingTitle'), t('party.playingBody', { name: leaderName, where }));
  let cancelled = false;
  let timer = null;
  const go = () => {
    clearTimeout(timer);
    if (cancelled) return;
    cancelled = true;
    memberPlay(parsed.plan).catch((err) => fail(t('party.playFailed'), err));
  };
  const auto = S.myReady && S.myPrep.prep === 'ok';
  const tst = actionToast({
    kind: 'info',
    icon: 'ptPartyUsers',
    title: t('party.playingToast', { name: leaderName }),
    msg: auto ? t('party.playingAuto', { where }) : t('party.playingAsk', { where }),
    ms: auto ? 9000 : 30000,
    key: `party-play:${S.party.id}`,
    actions: [
      { label: t('party.playNow'), icon: 'play', primary: true, run: go },
      { label: t('party.notNow'), run: () => { cancelled = true; clearTimeout(timer); } },
    ],
  });
  if (auto) {
    timer = setTimeout(() => {
      tst.close();
      go();
    }, 5000);
  }
}

// ---------- Señales que llegan ----------

function onInvite(fromId, fromName, parsed) {
  if (!social.isFriend?.(fromId)) return;
  if (S.party?.id === parsed.party) return;
  if (!gate.allow(fromId, parsed.party)) return;
  const name = L.cleanText(fromName) || nameOf(fromId);
  S.invites.set(fromId, { party: parsed.party, leader: fromId, name, at: Date.now(), size: parsed.size, game: parsed.game, where: parsed.where });
  emit();
  const busy = S.role ? (S.role === 'leader' ? t('party.inviteWhileLeader') : t('party.inviteWhileMember')) : '';
  const detail = parsed.game ? (parsed.where ? t('party.inviteGameWhere', { game: parsed.game, where: parsed.where }) : parsed.game) : t('party.inviteNoPlan');
  actionToast({
    kind: 'info',
    icon: 'ptPartyUsers',
    title: t('party.inviteTitle', { name }),
    msg: busy ? `${detail} · ${busy}` : detail,
    ms: 30000,
    key: `party-invite:${fromId}`,
    actions: [
      { label: t('party.accept'), icon: 'check', primary: true, run: () => acceptInvite(fromId) },
      { label: t('party.decline'), run: () => declineInvite(fromId) },
    ],
  });
  overlay(t('party.ovInviteTitle'), t('party.ovInviteBody', { name }));
}

function onState(fromId, parsed) {
  const me = myId();
  // Primer estado después de aceptar: pasa a ser miembro
  if (S.joining && parsed.party === S.joining.party && fromId === S.joining.leader) {
    if (!parsed.members.some((m) => m.id === me)) return;
    clearTimeout(joinTimer);
    S.role = 'member';
    S.owner = me;
    S.party = { id: parsed.party, leader: fromId, rev: 0, leaderName: parsed.leaderName, members: [], invited: [], plan: null, voice: null, play: null, lastStateAt: Date.now() };
    S.joining = null;
    S.myReady = false;
    S.myPrep = { prep: 'unknown', instanceId: null };
    S.playedSeq = parsed.play?.seq || 0;
    ok(t('party.joined', { name: parsed.leaderName }));
    overlay(t('party.joined', { name: parsed.leaderName }));
  }
  if (S.role !== 'member' || !S.party) return;
  const res = L.applyState(S.party, fromId, parsed, me);
  if (res.action === 'ignore') return;
  if (res.action === 'removed') {
    dissolveLocal(t('party.removedTitle'), t('party.removedText', { name: S.party.leaderName }));
    return;
  }
  const prevPlan = JSON.stringify(S.party.plan);
  S.party = { ...res.party, lastStateAt: Date.now() };
  if (JSON.stringify(S.party.plan) !== prevPlan) recomputePrep();
  emit();
  // El mundo del líder ya tiene dirección: los que estaban esperando entran
  if (S.pendingPlay && S.party.plan?.target?.kind === 'world' && S.party.plan.target.address) {
    memberPlay(S.party.plan).catch((err) => fail(t('party.playFailed'), err));
  }
}

function handleSignal(type, evt) {
  const parsed = L.parseSignal(type, evt?.payload);
  const fromId = evt?.fromId;
  if (!parsed || !L.isUserId(fromId) || fromId === myId()) return;
  const p = S.party;
  switch (type) {
    case L.SIGNALS.invite:
      onInvite(fromId, evt.from, parsed);
      return;
    case L.SIGNALS.accept:
      if (S.role !== 'leader' || parsed.party !== p.id) {
        // Grupo que ya no existe: se le avisa para que no espere
        sendQuiet(fromId, L.SIGNALS.end, { party: parsed.party, reason: 'closed' });
        return;
      }
      onAccept(fromId, evt.from);
      return;
    case L.SIGNALS.decline:
      if (S.role === 'leader' && parsed.party === p.id) {
        const name = p.invited.find((i) => i.id === fromId)?.name || nameOf(fromId);
        if (commit(L.declineInvite(p, fromId), { quiet: true })?.ok) toast('info', t('party.declined', { name }));
      }
      return;
    case L.SIGNALS.leave:
      if (S.role === 'leader' && parsed.party === p.id) removeMember(fromId, 'left');
      return;
    case L.SIGNALS.ready:
      if (S.role === 'leader' && parsed.party === p.id && p.members.some((m) => m.id === fromId)) {
        S.seen.set(fromId, Date.now());
        commit(L.setReady(p, fromId, parsed.ready, parsed.prep));
        emit();
      }
      return;
    case L.SIGNALS.state:
      onState(fromId, parsed);
      return;
    case L.SIGNALS.play:
      if (S.role === 'member' && p && fromId === p.leader && parsed.party === p.id) onPlay(parsed);
      return;
    case L.SIGNALS.kick:
      if (S.role === 'member' && p && fromId === p.leader && parsed.party === p.id) dissolveLocal(t('party.removedTitle'), t('party.removedText', { name: p.leaderName }));
      return;
    case L.SIGNALS.end:
      if (S.joining?.party === parsed.party && S.joining.leader === fromId) {
        clearTimeout(joinTimer);
        S.joining = null;
        emit();
        toast('info', t('party.endedTitle'), t('party.joinGoneText'));
      } else if (S.role === 'member' && p && fromId === p.leader && parsed.party === p.id) {
        dissolveLocal(t('party.endedTitle'), t('party.endedText', { name: p.leaderName }));
      } else if (S.invites.get(fromId)?.party === parsed.party) {
        S.invites.delete(fromId);
        emit();
      }
      return;
    default:
  }
}

function onAccept(fromId, fromName) {
  const p = leaderParty();
  const res = L.acceptInvite(p, fromId, L.cleanText(fromName) || nameOf(fromId));
  if (!res.ok) {
    if (res.party !== p) commit(res, { quiet: true });
    sendQuiet(fromId, L.SIGNALS.end, { party: p.id, reason: 'closed' });
    if (res.error === 'full') toast('info', t('party.full'), t('party.fullText', { max: L.MAX_MEMBERS }));
    return;
  }
  const isNew = res.party !== p;
  S.seen.set(fromId, Date.now());
  commit(res);
  scheduleBroadcast(true);
  if (!isNew) return;
  const name = res.party.members.find((m) => m.id === fromId)?.name || nameOf(fromId);
  ok(t('party.memberJoined', { name }));
  overlay(t('party.memberJoined', { name }));
  // Si el grupo ya tiene sala de voz y el líder está adentro, se invita también al nuevo
  if (res.party.voice) {
    import('../voice.js')
      .then(({ voice }) => (voice.room?.code === res.party.voice ? voice.inviteFriend(fromId, { openPage: false }) : null))
      .catch((err) => console.warn('[party] voz', err?.message || err));
  }
}

// ---------- Fin del grupo ----------

function clearParty() {
  clearTimeout(broadcastTimer);
  clearTimeout(joinTimer);
  S.role = null;
  S.owner = null;
  S.party = null;
  S.instanceId = null;
  S.joining = null;
  S.seen.clear();
  S.myReady = false;
  S.myPrep = { prep: 'unknown', instanceId: null };
  S.pendingPlay = null;
  S.playedSeq = 0;
  emit();
}

function dissolveLocal(title, text) {
  clearParty();
  actionToast({ kind: 'info', icon: 'ptPartyUsers', title, msg: text, ms: 9000 });
  overlay(title, text);
}

// El miembro revisa si el líder sigue (con presencia en "desconectado" se espera un poco por si está Invisible)
function checkLeader(now = Date.now()) {
  if (S.role !== 'member' || !S.party) return false;
  const presence = social.presenceOf?.(S.party.leader)?.presence;
  if (!L.leaderLost({ lastStateAt: S.party.lastStateAt, now, presence })) return false;
  dissolveLocal(t('party.leaderLostTitle'), t('party.leaderLostText', { name: S.party.leaderName }));
  return true;
}

// Cada 20 s: líder caído, latido del miembro, miembros que dejaron de latir, invitaciones vencidas y el estado
// que el líder reenvía cada minuto
function tick() {
  const now = Date.now();
  if (checkLeader(now)) return;
  if (S.role === 'member' && S.party && now - (S.lastBeat || 0) >= L.STATE_EVERY_MS) {
    S.lastBeat = now;
    sendReady();
  }
  if (S.role === 'leader' && S.party) {
    for (const id of L.staleMembers(S.party, S.seen, now)) removeMember(id, 'timeout');
    if (S.party) commit(L.expireInvites(S.party, now), { quiet: true });
    if (S.party && now - (S.lastBroadcast || 0) >= L.STATE_EVERY_MS) {
      S.lastBroadcast = now;
      if (S.party.members.length > 1) broadcast();
    }
  }
  if (S.joining && now - S.joining.at > L.JOIN_TIMEOUT_MS + 5000) S.joining = null;
  for (const [id, inv] of S.invites) if (now - inv.at >= L.INVITE_TTL_MS) S.invites.delete(id);
  emit(); // refresca "en línea" y los vencimientos en la interfaz
}

// En línea = latió hace poco (el miembro late cada minuto; se deja margen para dos latidos)
function memberOnline(id) {
  const at = S.seen.get(id);
  return Number.isFinite(at) && Date.now() - at < L.STATE_EVERY_MS * 2 + 5000;
}

// ---------- Textos del plan ----------

export function planGame(plan) {
  const pack = plan?.pack;
  if (!pack) return '';
  return pack.kind === 'shared' ? pack.name || pack.code : t('party.versionLabel', { version: pack.mcVersion, loader: loaderName(pack.loader) });
}

export function planWhere(plan) {
  const tg = plan?.target;
  if (!tg) return '';
  if (tg.kind === 'server') return tg.name || tg.address;
  return t('party.worldOf', { name: S.role === 'member' ? S.party?.leaderName || '' : myName() });
}

const LOADER_NAMES = { vanilla: 'Vanilla', fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', quilt: 'Quilt', optifine: 'OptiFine', iris: 'Iris', legacyfabric: 'Legacy Fabric', babric: 'Babric' };
export const loaderName = (k) => LOADER_NAMES[k] || k || '';

// ---------- Arranque ----------

export async function startup() {
  if (S.started) return;
  S.started = true;
  await prepare();
  try {
    for (const type of L.SIGNAL_TYPES) social.onSignal(type, (evt) => handleSignal(type, evt));
  } catch (err) {
    console.warn('[party] señales', err?.message || err);
  }
  // Presencia: el líder que se desconecta disuelve el grupo (con margen por si está Invisible)
  social.on('presence', ({ userId, presence } = {}) => {
    if (S.role === 'member' && S.party && userId === S.party.leader && presence === 'offline') checkLeader();
  });
  // Sin sesión o con otra cuenta: el grupo deja de existir en esta PC. Un corte de red pasajero ('error',
  // 'loading') no lo disuelve: si dura, lo resuelve el tiempo límite del líder.
  social.on('state', (st) => {
    const other = S.owner && social.userId && social.userId !== S.owner;
    if ((S.role || S.joining) && (st === 'signedOut' || st === 'disabled' || other)) {
      clearParty();
      toast('info', t('party.endedTitle'), t('party.sessionEnded'));
    }
    emit();
  });
  social.on('friends', () => {
    const p = leaderParty();
    if (p) for (const m of p.members) if (m.id !== p.leader && !social.isFriend(m.id)) removeMember(m.id, 'gone');
    emit();
  });
  cloud.on('auth', () => emit(true));
  store.on('instances', () => {
    if (S.role === 'member') recomputePrep();
    // El líder compartió su instancia (o cambió su versión): el plan se actualiza solo
    if (S.role === 'leader' && S.instanceId) {
      const pack = L.packFromInstance(store.instances.find((i) => i.id === S.instanceId));
      if (pack && JSON.stringify(pack) !== JSON.stringify(S.party.plan?.pack)) setLeaderInstance(S.instanceId);
    }
  });
  // Mundo del líder abierto a amigos (netplay): la dirección viaja en el estado
  const onWorld = (id, snap) => {
    if (S.role === 'leader' && id && id === S.instanceId && S.party?.plan?.target?.kind === 'world') setWorldAddress(worldAddressOf(snap));
  };
  api.on('netplay:world', (snap) => onWorld(snap?.instanceId, snap));
  api.on('netplay:e4mcDomain', (id, domain) => onWorld(id, { domain }));
  api.on('netplay:tunnel', (snap) => {
    if (snap?.instanceId && snap.instanceId === S.instanceId) refreshWorldAddress();
  });
  onLanguageChange(() => loadNs(NS).then(() => emit(true)).catch(() => {}));
  // Al cerrar el launcher, el líder avisa que el grupo terminó (lo que alcance a salir)
  window.addEventListener('beforeunload', () => {
    const p = leaderParty();
    if (!p) return;
    for (const m of p.members) if (m.id !== p.leader) sendQuiet(m.id, L.SIGNALS.end, { party: p.id, reason: 'leader' });
  });
  S.timers.push(setInterval(tick, 20_000));
}

// ---------- Panel, botón y tarjeta ----------

export async function openParty() {
  await prepare();
  await Promise.resolve(cloud.ready()).catch(() => {});
  const g = gateState();
  if (g === 'signin' || g === 'cloud') {
    navigate('settings/cloud');
    return null;
  }
  const { openPartyPanel } = await import('./party/panel.js');
  return openPartyPanel(controller);
}

// Lo que usan el panel y la tarjeta (sin exponer el estado interno)
export const controller = {
  open: () => openParty(),
  snapshot: partySnapshot,
  onChange: onPartyChange,
  createParty,
  inviteToParty,
  cancelInvite,
  kickMember,
  setLeaderInstance,
  setTarget,
  createVoiceRoom,
  playAll,
  disband,
  acceptInvite,
  declineInvite,
  leaveParty,
  setMyReady,
  prepareMine,
  joinPartyGame,
  joinPartyVoice,
  planGame,
  planWhere,
  loaderName,
  myName,
};

export function partyButton() {
  const btn = h('button', { class: 'pt-btn', type: 'button' });
  const offs = [];
  const paint = () => {
    const snap = partySnapshot();
    const count = snap.party ? snap.party.members.length : 0;
    const invites = snap.invites.length;
    const label = snap.party ? t('party.buttonIn', { count }) : t('party.button');
    const tip = snap.gate === 'signin' || snap.gate === 'cloud' ? t('party.buttonSignIn') : snap.party ? t('party.buttonOpenIn', { count, max: L.MAX_MEMBERS }) : invites ? t('party.buttonInvites', { count: invites }) : t('party.buttonOpen');
    btn.title = tip;
    btn.setAttribute('aria-label', tip);
    btn.classList.toggle('active', Boolean(snap.party));
    mount(btn, icon('ptPartyUsers'), h('span', { class: 'pt-btn-label' }, label), invites && !snap.party ? h('span', { class: 'pt-btn-dot', 'aria-hidden': 'true' }) : null);
  };
  btn.addEventListener('click', () => {
    const g = gateState();
    if (g === 'signin' || g === 'cloud') navigate('settings/cloud');
    else openParty();
  });
  btn.addEventListener('dblclick', (e) => e.stopPropagation());
  offs.push(onPartyChange(paint), cloud.on('auth', paint));
  prepare().then(paint);
  paint();
  btn.destroy = () => offs.splice(0).forEach((off) => off());
  return btn;
}

export function partyCard() {
  const root = h('section', { class: 'card pt-card', 'aria-busy': 'true' });
  let off = null;
  let disposed = false;
  root.destroy = () => {
    disposed = true;
    off?.();
    off = null;
  };
  Promise.all([prepare(), import('./party/panel.js')])
    .then(([, mod]) => {
      if (disposed) return;
      root.removeAttribute('aria-busy');
      off = mod.mountPartyCard(root, controller);
    })
    .catch((err) => {
      console.warn('[party] tarjeta', err);
      if (!disposed) mount(root, h('div', { class: 'notice bad' }, icon('alert'), h('div', {}, t('party.serviceDownText'))));
    });
  return root;
}
