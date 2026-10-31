// Motor del Voice Chat: salas con codigo de 6 letras guardadas en Supabase y voz/pantalla por WebRTC en
// malla (hasta 8 personas). La señalizacion va por el canal privado de Realtime "voice:<codigo>" (las
// politicas RLS de supabase/migrations/0003_voice.sql solo dejan entrar a miembros admitidos):
//   - Presencia: quien esta, silenciado, ensordecido, hablando, compartiendo pantalla.
//   - Broadcast: ofertas/respuestas/candidatos ICE dirigidos a un miembro, chat, soundboard y moderacion.
// Cada mensaje va firmado con la clave de la sesion (ECDSA) que el servidor asocio al usuario autenticado,
// asi nadie puede hacerse pasar por otro miembro ni por el anfitrion.
//
//   import { voice } from './voice.js';
//   voice.on('room', (room) => ...)        // sala actual o null
//   voice.on('members', (list) => ...)     // miembros (incluido uno mismo)
//   voice.on('state', (st) => ...)         // estado propio: silenciado, ensordecido, conexion...
//   voice.on('invite', ({ name, room, from }) => ...)
//   await voice.createRoom({ name, private, password, maxMembers }); await voice.joinRoom('ABC123', { password });
import { store, api } from './store.js';
import { cloud } from './cloud.js';
import { social } from './social.js';
import { t, loadNs, has } from './i18n.js';
import { toast } from './ui.js';
import { createIdentity, importPublicKey, signText, verifyText, randomId } from './voice/sign.js';
import { LocalMic, FLOOR_DB, rmsDb, dbToUnit, micErrorCode } from './voice/mic.js';
import { Peer } from './voice/rtc.js';
import { SOUNDS, SOUND_IDS, playSound, playChime } from './voice/sfx.js';
import { isModifierCode, isTypingTarget } from './voice/keys.js';

// Valores por defecto de settings.voice (los que no estan en el archivo de ajustes)
export const VOICE_DEFAULTS = {
  inputDevice: 'default',
  outputDevice: 'default',
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  inputVolume: 1,
  muteShortcut: 'CommandOrControl+Shift+M',
  pushToTalk: false,
  pttKey: 'KeyV',
  pttReleaseDelay: 200,
  vadAuto: true,
  vadThreshold: -50,
  notifySounds: true,
  soundboardEnabled: true,
  soundboardVolume: 0.7,
  relayOnly: false, // solo con TURN: toda la voz pasa por el servidor del launcher (oculta la IP)
  userVolumes: {},
};

export const MAX_MEMBERS = 8;
export const SVC_PROJECT = '9eGKb6K1'; // Simple Voice Chat en Modrinth

const CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;
const HEARTBEAT_MS = 30000;
const STATS_MS = 4000;
const TICK_MS = 40;
const LEVELS_MS = 80;
const AWAY_GRACE_MS = 15000;
const MSG_MAX_AGE = 120000;
const STUN = { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] };
const ROOM_COLS = 'id,owner,name,code,is_private,has_password,max_members,is_locked,created_at,last_active';
const SIGNAL_KINDS = new Set(['desc', 'ice', 'reset', 'bye']);

export class VoiceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Error traducido a partir de un codigo (los mismos que devuelven las funciones SQL)
function verr(code, vars) {
  const key = `voice.err_${code}`;
  if (code === 'auth') return new VoiceError(code, t('common.requiresCloud'));
  return new VoiceError(code, has(key) ? t(key, vars) : t('voice.err_generic', { error: code }));
}

function isMissingSchema(error) {
  const code = String(error?.code || '');
  return ['PGRST202', 'PGRST205', '42883', '42P01'].includes(code) || /could not find the (function|table)|does not exist/i.test(error?.message || '');
}

function pgError(error) {
  if (isMissingSchema(error)) {
    // Falta la migracion 0003_voice.sql en el servidor: el usuario ve "no disponible", el detalle queda en el log
    console.warn('[voice] falta el esquema del Voice Chat (0003_voice.sql):', error?.code, error?.message);
    return verr('not_installed');
  }
  if (error?.code === '42501') return verr('not_owner');
  return new VoiceError('server', error?.message || String(error));
}

async function rpc(engine, name, args) {
  const client = engine.client;
  if (!client || !engine.signedIn()) throw verr('auth');
  const { data, error } = await client.rpc(name, args);
  if (error) throw pgError(error);
  if (data && typeof data === 'object' && data.error) throw verr(data.error, { max: data.max });
  return data || {};
}

export function normalizeCode(input) {
  const c = String(input || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  return CODE_RE.test(c) ? c : null;
}

function cleanName(v) {
  return String(v ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 32);
}

function cleanAvatar(v) {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{1,36}$/.test(v) ? v : null;
}

function clamp(v, min, max, def) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

function readCfg(v) {
  const s = v && typeof v === 'object' ? v : {};
  return {
    ...VOICE_DEFAULTS,
    ...s,
    userVolumes: { ...(s.userVolumes || {}) },
  };
}

function mapRoom(r, me = null) {
  if (!r || typeof r !== 'object') return null;
  return {
    id: r.id,
    code: r.code,
    name: cleanName(r.name) || r.code,
    ownerId: r.owner,
    ownerName: cleanName(r.owner_name) || null,
    ownerAvatar: cleanAvatar(r.owner_avatar),
    isOwner: typeof r.is_owner === 'boolean' ? r.is_owner : Boolean(me) && r.owner === me,
    isPrivate: Boolean(r.is_private),
    hasPassword: Boolean(r.has_password),
    maxMembers: clamp(r.max_members, 2, MAX_MEMBERS, MAX_MEMBERS),
    locked: Boolean(r.is_locked),
    createdAt: Date.parse(r.created_at) || null,
    lastActive: Date.parse(r.last_active) || null,
    active: Number(r.active) || 0,
    people: Array.isArray(r.people) ? r.people.slice(0, MAX_MEMBERS).map((p) => ({ id: p?.id || null, name: cleanName(p?.name), avatar: cleanAvatar(p?.avatar) })) : [],
    admitted: typeof r.admitted === 'boolean' ? r.admitted : null,
    banned: Boolean(r.banned),
  };
}

function envelopeText(event, roomId, e) {
  return `${event}|${roomId}|${e.f}|${e.fs}|${e.to || ''}|${e.tos || ''}|${e.ts}|${e.n}|${e.d}`;
}

// Sobre de un mensaje del chat (a toda la sala) con su firma original, para reenviarlo tal cual en el historial
function chatEnvelope(e) {
  return e && typeof e === 'object' && !e.to && !e.tos ? { f: e.f, fs: e.fs, ts: e.ts, n: e.n, d: e.d, sig: e.sig } : null;
}

function presenceText(roomId, userId, st) {
  return `p|${roomId}|${userId}|${st.s}|${st.j}|${st.m ? 1 : 0}${st.d ? 1 : 0}${st.sp ? 1 : 0}${st.sh ? 1 : 0}`;
}

// Audio de otro miembro: un <audio> por pista (asi funciona la cancelacion de eco de Chromium) +
// analizador para el indicador de "hablando" + camino WebAudio para subir el volumen por encima de 100 %.
class RemoteAudio {
  constructor(engine, userId) {
    this.engine = engine;
    this.userId = userId;
    this.items = new Map();
    const ctx = engine.audioCtx();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0;
    this.boost = ctx.createGain();
    this.boost.gain.value = 0;
    this.boost.connect(ctx.destination);
    this.buf = new Float32Array(this.analyser.fftSize);
    this.speakingUntil = 0;
  }

  add(track) {
    if (this.items.has(track.id)) return;
    const ctx = this.engine.audioCtx();
    const stream = new MediaStream([track]);
    const el = new Audio();
    el.autoplay = true;
    el.srcObject = stream;
    const src = ctx.createMediaStreamSource(stream);
    src.connect(this.analyser);
    src.connect(this.boost);
    this.items.set(track.id, { el, src });
    track.addEventListener('ended', () => this.remove(track.id));
    const sink = this.engine.sinkId();
    if (sink && el.setSinkId) el.setSinkId(sink).catch(() => {});
    this.apply();
    el.play().catch(() => {});
  }

  remove(id) {
    const it = this.items.get(id);
    if (!it) return;
    it.el.pause();
    it.el.srcObject = null;
    try {
      it.src.disconnect();
    } catch {
      /* ya desconectado */
    }
    this.items.delete(id);
  }

  apply() {
    const { volume, muted } = this.engine.userAudio(this.userId);
    const silent = muted || this.engine.deafened;
    const boost = volume > 1;
    for (const it of this.items.values()) {
      it.el.muted = silent || boost;
      it.el.volume = Math.max(0, Math.min(1, volume));
    }
    const ctx = this.engine.ctx;
    if (ctx) this.boost.gain.setTargetAtTime(!silent && boost ? volume : 0, ctx.currentTime, 0.02);
  }

  setSink(id) {
    for (const it of this.items.values()) it.el.setSinkId?.(id).catch(() => {});
  }

  level(now) {
    if (!this.items.size) return 0;
    this.analyser.getFloatTimeDomainData(this.buf);
    const db = rmsDb(this.buf);
    if (db > -52) this.speakingUntil = now + 260;
    return dbToUnit(db);
  }

  get speaking() {
    return performance.now() < this.speakingUntil;
  }

  close() {
    for (const id of [...this.items.keys()]) this.remove(id);
    try {
      this.analyser.disconnect();
      this.boost.disconnect();
    } catch {
      /* ya desconectado */
    }
  }
}

export class VoiceEngine {
  // backend (solo para pruebas): { client, user, profile } en lugar de la cuenta de cloud.js
  constructor({ backend = null } = {}) {
    this.backend = backend;
    this.listeners = new Map();
    this.cfg = readCfg(null);
    this.session = null;
    this.ctx = null;
    this.status = 'idle';
    this.muted = false;
    this.deafened = false;
    this.pttDown = false;
    this.pttTimer = null;
    this.capturingKeys = false;
    this.iceServers = []; // servidores TURN que trae el launcher (core/app-config.js, canal voice:iceServers)
    this.inviteSeen = new Map();
    this.test = null;
    this.tickTimer = null;
    this.lastLevels = 0;
    this.lastSfx = 0;
    this.joining = null;
    this.socialHooked = false;
    this.levels = { self: 0, selfDb: FLOOR_DB, threshold: -50, open: false, voiced: false, users: {} };
    this.SOUNDS = SOUNDS;
  }

  // ---------- Cuenta / Supabase ----------
  get client() {
    return this.backend ? this.backend.client : cloud.client;
  }

  get user() {
    return this.backend ? this.backend.user : cloud.user;
  }

  get profile() {
    return this.backend ? this.backend.profile : cloud.profile;
  }

  signedIn() {
    return this.backend ? Boolean(this.backend.user) : cloud.isSignedIn();
  }

  configured() {
    return this.backend ? true : cloud.isConfigured();
  }

  rpc(name, args) {
    return rpc(this, name, args);
  }

  // ---------- Eventos ----------
  on(evt, fn) {
    if (!this.listeners.has(evt)) this.listeners.set(evt, new Set());
    this.listeners.get(evt).add(fn);
    return () => this.listeners.get(evt)?.delete(fn);
  }

  emit(evt, data) {
    for (const fn of this.listeners.get(evt) || []) {
      try {
        fn(data);
      } catch (err) {
        console.error('[voice]', err);
      }
    }
  }

  emitRoom() {
    this.emit('room', this.room);
  }

  emitState() {
    this.emit('state', this.state);
  }

  emitMembers() {
    clearTimeout(this.membersTimer);
    this.membersTimer = null;
    this.emit('members', this.members);
  }

  emitMembersSoon() {
    if (this.membersTimer) return;
    this.membersTimer = setTimeout(() => this.emitMembers(), 60);
  }

  emitScreens() {
    clearTimeout(this.screensTimer);
    this.screensTimer = null;
    this.emit('screens', this.screens);
  }

  emitScreensSoon() {
    if (this.screensTimer) return;
    this.screensTimer = setTimeout(() => this.emitScreens(), 80);
  }

  // ---------- Inicio ----------
  init() {
    if (!this.initPromise) this.initPromise = this.doInit().catch((err) => console.warn('[voice] init', err));
    return this.initPromise;
  }

  async doInit() {
    await loadNs('voice').catch(() => {});
    this.cfg = readCfg(store.settings?.voice);
    store.on('settings', (s) => this.onSettings(s?.voice));
    try {
      api.on('voice:toggle-mute', () => this.onGlobalMute());
    } catch (err) {
      console.warn('[voice] atajo global', err);
    }
    window.addEventListener('keydown', (e) => this.onKey(e, true), true);
    window.addEventListener('keyup', (e) => this.onKey(e, false), true);
    window.addEventListener('mousedown', (e) => this.onMouse(e, true), true);
    window.addEventListener('mouseup', (e) => this.onMouse(e, false), true);
    window.addEventListener('blur', () => this.setPtt(false, true));
    window.addEventListener('beforeunload', () => this.teardownSync());
    navigator.mediaDevices?.addEventListener?.('devicechange', () => this.onDeviceChange());
    if (this.backend) return;
    cloud.on('auth', (session) => {
      const s = this.session;
      if (s && !s.demo && session?.user?.id !== s.userId) this.leaveRoom({ silent: true });
    });
    cloud.on('config', () => {
      if (this.session && !this.session.demo) this.leaveRoom({ silent: true });
    });
    this.hookSocial();
    // social.js se construye en paralelo: reintentar el enganche de invitaciones un rato
    let tries = 0;
    const retry = setInterval(() => {
      if (this.hookSocial() || ++tries > 12) clearInterval(retry);
    }, 5000);
    // Servidores TURN del launcher (core/app-config.js): sin ellos, solo STUN
    const ice = api.invoke('voice:iceServers');
    ice
      .then((list) => {
        this.iceServers = Array.isArray(list) ? list.filter((x) => x && Array.isArray(x.urls) && x.urls.length) : [];
        this.emit('settings', this.cfg);
      })
      .catch(() => {});
  }

  hookSocial() {
    if (this.socialHooked) return true;
    if (typeof social?.onSignal !== 'function') return false;
    try {
      social.onSignal('voice-invite', (...args) => this.onInviteSignal(...args));
      this.socialHooked = true;
    } catch (err) {
      console.warn('[voice] invitaciones', err);
    }
    return this.socialHooked;
  }

  // social.js entrega { type, from: <nombre>, fromId, profile, payload } (el remitente lo pone el servidor).
  // Tambien se acepta la forma (payload, fromId) por compatibilidad.
  onInviteSignal(a, b) {
    let payload = a;
    let from = typeof b === 'string' ? b : null;
    let trustedName = '';
    if (a && typeof a === 'object' && a.payload && typeof a.payload === 'object') {
      payload = a.payload;
      from = a.fromId ?? a.userId ?? a.user_id ?? from;
      trustedName = cleanName(a.profile?.display_name || a.profile?.username || a.from);
    }
    if (from && typeof from === 'object') from = from.id ?? from.userId ?? null;
    const code = normalizeCode(payload?.room ?? payload?.code);
    if (!code || this.session?.room.code === code) return;
    const key = `${from || '?'}:${code}`;
    if (Date.now() - (this.inviteSeen.get(key) || 0) < 15000) return;
    this.inviteSeen.set(key, Date.now());
    const name = trustedName || cleanName(payload?.name) || t('voice.someone');
    this.emit('invite', { name, room: code, from: typeof from === 'string' ? from : null });
  }

  // ---------- Ajustes ----------
  get settings() {
    return this.cfg;
  }

  saveSettings(patch) {
    return store.setSettings({ voice: patch });
  }

  onSettings(v) {
    const prev = this.cfg;
    this.cfg = readCfg(v);
    const mic = this.mic;
    if (mic) {
      mic
        .update(this.micOpts())
        .then(() => this.afterCapture())
        .catch((err) => console.warn('[voice] microfono', err));
    }
    if (prev.outputDevice !== this.cfg.outputDevice) this.applyOutput();
    if (prev.pushToTalk !== this.cfg.pushToTalk || prev.pttKey !== this.cfg.pttKey) {
      this.pttDown = false;
      this.updateTransmit();
    }
    if (prev.relayOnly !== this.cfg.relayOnly) this.applyRtcConfig();
    this.applyRemoteAudio();
    this.emitState();
    this.emit('settings', this.cfg);
  }

  micOpts() {
    const c = this.cfg;
    return { inputDevice: c.inputDevice, echoCancellation: c.echoCancellation, noiseSuppression: c.noiseSuppression, autoGainControl: c.autoGainControl, inputVolume: c.inputVolume };
  }

  // Hay un servidor TURN del launcher (entonces se puede ocultar la IP con relayOnly)
  get hasTurn() {
    return this.iceServers.some((s) => s.urls.some((u) => /^turns?:/i.test(u)));
  }

  rtcConfig() {
    const servers = [STUN, ...this.iceServers];
    return { iceServers: servers, iceTransportPolicy: this.cfg.relayOnly && this.hasTurn ? 'relay' : 'all', bundlePolicy: 'max-bundle' };
  }

  applyRtcConfig() {
    const s = this.session;
    if (!s || s.demo) return;
    const conf = this.rtcConfig();
    for (const p of s.peers.values()) {
      try {
        p.pc.setConfiguration(conf);
        p.restartIce();
      } catch (err) {
        console.warn('[voice] configuracion ICE', err);
      }
    }
  }

  async setShortcut(accel) {
    const value = String(accel || '');
    await this.saveSettings({ muteShortcut: value });
    try {
      await api.voice?.setShortcut?.(value);
    } catch (err) {
      console.warn('[voice] atajo', err);
    }
  }

  // ---------- Audio ----------
  audioCtx() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.applyOutput();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  sinkId() {
    const id = this.cfg.outputDevice;
    return id && id !== 'default' ? id : '';
  }

  async applyOutput() {
    const id = this.sinkId();
    if (this.ctx?.setSinkId) await this.ctx.setSinkId(id).catch((err) => console.warn('[voice] salida de audio', err?.message || err));
    for (const r of this.session?.audio?.values() || []) r.setSink(id);
  }

  get mic() {
    return this.session?.mic || this.test?.mic || null;
  }

  // Volumen y silencio local de un miembro (el volumen se recuerda entre sesiones)
  userAudio(userId) {
    const volume = clamp(this.cfg.userVolumes?.[userId], 0, 2, 1);
    return { volume, muted: Boolean(this.session?.localMutes.has(userId)) };
  }

  applyRemoteAudio() {
    for (const r of this.session?.audio?.values() || []) r.apply();
  }

  remoteAudio(s, userId) {
    let r = s.audio.get(userId);
    if (!r) {
      r = new RemoteAudio(this, userId);
      s.audio.set(userId, r);
    }
    return r;
  }

  chime(kind) {
    if (!this.cfg.notifySounds) return;
    if (this.deafened && !['mute', 'unmute'].includes(kind)) return;
    try {
      this.lastSfx = Date.now();
      playChime(this.audioCtx(), kind, { volume: 0.55 });
      this.maybeSuspend();
    } catch {
      /* sin audio */
    }
  }

  maybeSuspend() {
    clearTimeout(this.suspendTimer);
    this.suspendTimer = setTimeout(() => {
      if (!this.session && !this.test && this.ctx?.state === 'running' && Date.now() - this.lastSfx > 2500) this.ctx.suspend().catch(() => {});
    }, 3500);
  }

  get transmitting() {
    const s = this.session;
    return Boolean(s && s.mic?.hasInput && !this.muted && !this.deafened && (!this.cfg.pushToTalk || this.pttDown));
  }

  updateTransmit() {
    const s = this.session;
    if (s?.mic) s.mic.track.enabled = this.transmitting;
    if (s) this.trackPresenceSoon();
  }

  async startMic(s) {
    const mic = new LocalMic(this.audioCtx());
    mic.onEnded = () => this.recoverMic(mic);
    s.mic = mic;
    try {
      await mic.start(this.micOpts());
      if (mic.fellBack) toast('info', t('voice.noticeMicFallbackTitle'), t('voice.noticeMicFallback'));
    } catch (err) {
      s.micError = micErrorCode(err);
      toast('info', t('voice.noticeNoMicTitle'), t(`voice.err_${s.micError}`));
    }
    mic.track.enabled = this.transmitting;
  }

  async recoverMic(mic) {
    if (this.mic !== mic) return;
    try {
      await mic.capture();
      this.afterCapture();
    } catch (err) {
      if (this.session?.mic === mic) this.session.micError = micErrorCode(err);
      this.emitState();
    }
  }

  afterCapture() {
    const s = this.session;
    if (s?.mic) {
      s.micError = s.mic.hasInput ? null : s.micError;
      s.mic.track.enabled = this.transmitting;
    }
    this.emitState();
  }

  async onDeviceChange() {
    this.emit('devices');
    const mic = this.mic;
    const track = mic?.raw?.getAudioTracks()[0];
    if (mic && (!track || track.readyState === 'ended')) this.recoverMic(mic);
  }

  async listDevices({ unlock = false } = {}) {
    if (!navigator.mediaDevices?.enumerateDevices) return { inputs: [], outputs: [] };
    let devs = await navigator.mediaDevices.enumerateDevices();
    if (unlock && !devs.some((d) => d.kind === 'audioinput' && d.label)) {
      try {
        const st = await navigator.mediaDevices.getUserMedia({ audio: true });
        st.getTracks().forEach((tr) => tr.stop());
        devs = await navigator.mediaDevices.enumerateDevices();
      } catch {
        /* sin permiso: etiquetas genericas */
      }
    }
    const map = (kind) => devs.filter((d) => d.kind === kind && d.deviceId !== 'communications').map((d) => ({ id: d.deviceId, label: d.label || '', isDefault: d.deviceId === 'default' }));
    return { inputs: map('audioinput'), outputs: map('audiooutput') };
  }

  // Prueba de microfono (fuera de una sala abre el micro; dentro usa el de la sala)
  async startMicTest({ monitor = false } = {}) {
    await this.init();
    if (this.session?.mic) {
      this.session.mic.setMonitor(monitor);
      this.startTick();
      return () => this.session?.mic?.setMonitor(false);
    }
    if (!this.test) {
      const mic = new LocalMic(this.audioCtx());
      try {
        await mic.start(this.micOpts());
      } catch (err) {
        mic.stop();
        throw verr(micErrorCode(err));
      }
      mic.onEnded = () => this.recoverMic(mic);
      this.test = { mic };
    }
    this.test.mic.setMonitor(monitor);
    this.startTick();
    this.emitState();
    return () => this.stopMicTest();
  }

  setMonitor(on) {
    this.mic?.setMonitor(Boolean(on));
  }

  stopMicTest() {
    if (this.test) {
      this.test.mic.stop();
      this.test = null;
      this.emitState();
    }
    this.session?.mic?.setMonitor(false);
    this.maybeStopTick();
  }

  playTestSound() {
    this.lastSfx = Date.now();
    playSound(this.audioCtx(), 'ding', { volume: Math.max(0.3, this.cfg.soundboardVolume) });
    this.maybeSuspend();
  }

  // ---------- Bucle de niveles / deteccion de voz ----------
  startTick() {
    if (!this.tickTimer) this.tickTimer = setInterval(() => this.tick(), TICK_MS);
  }

  maybeStopTick() {
    if (this.session || this.test) return;
    clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.levels = { self: 0, selfDb: FLOOR_DB, threshold: this.cfg.vadThreshold, open: false, voiced: false, users: {} };
    this.emit('levels', this.levels);
    this.maybeSuspend();
  }

  tick() {
    const now = performance.now();
    const s = this.session;
    const mic = this.mic;
    const vad = !this.cfg.pushToTalk;
    let r = { db: FLOOR_DB, threshold: this.cfg.vadThreshold, voiced: false, open: false };
    if (mic) {
      const transmit = s ? this.transmitting : !this.cfg.pushToTalk || this.pttDown;
      r = mic.tick({ now, vad, auto: this.cfg.vadAuto, threshold: vad ? this.cfg.vadThreshold : -55, transmit });
    }
    const users = {};
    if (s && !s.demo) {
      for (const [uid, a] of s.audio) users[uid] = a.level(now);
      // Hablando con el micro silenciado: aviso suave en los controles
      const talkingMuted = this.muted && !this.deafened && r.voiced && mic?.hasInput;
      if (talkingMuted) s.mutedTalk = (s.mutedTalk || 0) + TICK_MS;
      else s.mutedTalk = Math.max(0, (s.mutedTalk || 0) - TICK_MS / 3);
      const warn = s.mutedTalk > 1200;
      if (warn !== Boolean(s.talkingMuted)) {
        s.talkingMuted = warn;
        this.emitState();
      }
      const speaking = Boolean(mic?.speaking && this.transmitting);
      if (speaking !== s.lastSpeaking) {
        s.lastSpeaking = speaking;
        this.emitMembersSoon();
        this.trackPresenceSoon();
      }
    } else if (s?.demo) {
      for (const m of s.members.values()) {
        const wave = Math.max(0, Math.sin(now / (380 + m.seed * 90) + m.seed * 2.1));
        users[m.userId] = m.demoTalk ? 0.45 + wave * 0.4 : 0;
        s.demoSpeaking.set(m.userId, Boolean(m.demoTalk));
      }
    }
    if (now - this.lastLevels >= LEVELS_MS) {
      this.lastLevels = now;
      this.levels = { self: dbToUnit(r.db), selfDb: r.db, threshold: r.threshold, open: r.open, voiced: r.voiced, speaking: Boolean(mic?.speaking && (s ? this.transmitting : true)), users };
      this.emit('levels', this.levels);
    }
  }

  // ---------- Pulsar para hablar / atajo global ----------
  onKey(e, down) {
    if (this.capturingKeys || !this.cfg.pushToTalk || (!this.session && !this.test)) return;
    if (e.code !== this.cfg.pttKey) return;
    if (down && e.repeat) return;
    if (down && !isModifierCode(e.code) && isTypingTarget(e.target)) return;
    this.setPtt(down);
  }

  onMouse(e, down) {
    if (this.capturingKeys || !this.cfg.pushToTalk || (!this.session && !this.test)) return;
    if (`Mouse${e.button}` !== this.cfg.pttKey) return;
    this.setPtt(down);
  }

  setPtt(down, immediate = false) {
    clearTimeout(this.pttTimer);
    if (down) {
      if (this.pttDown) return;
      this.pttDown = true;
      this.updateTransmit();
      this.emitState();
      return;
    }
    if (!this.pttDown) return;
    const release = () => {
      this.pttDown = false;
      this.updateTransmit();
      this.emitState();
    };
    const delay = immediate ? 0 : clamp(this.cfg.pttReleaseDelay, 0, 1500, 200);
    if (delay) this.pttTimer = setTimeout(release, delay);
    else release();
  }

  onGlobalMute() {
    if (this.session) this.toggleMute();
  }

  // ---------- Estado propio ----------
  setMuted(on) {
    const next = Boolean(on);
    const undeafen = !next && this.deafened;
    if (this.muted === next && !undeafen) return;
    this.muted = next;
    if (undeafen) this.deafened = false;
    this.updateTransmit();
    this.applyRemoteAudio();
    this.chime(next ? 'mute' : 'unmute');
    this.emitState();
    this.emitMembersSoon();
  }

  toggleMute() {
    this.setMuted(!(this.muted || this.deafened));
  }

  setDeafened(on) {
    const next = Boolean(on);
    if (this.deafened === next) return;
    this.deafened = next;
    this.updateTransmit();
    this.applyRemoteAudio();
    this.chime(next ? 'mute' : 'unmute');
    this.emitState();
    this.emitMembersSoon();
  }

  toggleDeafen() {
    this.setDeafened(!this.deafened);
  }

  setVolume(userId, v) {
    const volume = clamp(v, 0, 2, 1);
    this.cfg.userVolumes = { ...this.cfg.userVolumes, [userId]: volume };
    this.session?.audio.get(userId)?.apply();
    clearTimeout(this.volSaveTimer);
    this.volSaveTimer = setTimeout(() => this.saveSettings({ userVolumes: { [userId]: volume } }).catch(() => {}), 500);
    this.emitMembersSoon();
  }

  setLocalMute(userId, on) {
    const s = this.session;
    if (!s) return;
    if (on) s.localMutes.add(userId);
    else s.localMutes.delete(userId);
    s.audio.get(userId)?.apply();
    this.emitMembersSoon();
  }

  get state() {
    const s = this.session;
    return {
      status: s ? s.status : this.status,
      inRoom: Boolean(s),
      demo: Boolean(s?.demo),
      muted: this.muted,
      deafened: this.deafened,
      pushToTalk: this.cfg.pushToTalk,
      pttKey: this.cfg.pttKey,
      pttDown: this.pttDown,
      transmitting: this.transmitting,
      sharing: Boolean(s?.screen),
      hasMic: s ? Boolean(s.demo || s.mic?.hasInput) : true,
      micError: s?.micError || null,
      talkingMuted: Boolean(s?.talkingMuted),
      testing: Boolean(this.test),
    };
  }

  // ---------- Sala actual ----------
  get room() {
    const s = this.session;
    if (!s) return null;
    return { ...s.room, isOwner: s.room.ownerId === s.userId, status: s.status, demo: Boolean(s.demo), members: this.members };
  }

  selfMember(s) {
    return {
      userId: s.userId,
      name: s.name,
      avatar: s.avatar,
      self: true,
      isOwner: s.room.ownerId === s.userId,
      muted: this.muted || (!s.demo && !s.mic?.hasInput),
      deafened: this.deafened,
      ptt: this.cfg.pushToTalk && !this.pttDown && !this.muted,
      sharing: Boolean(s.screen),
      speaking: s.demo ? Boolean(s.demoSpeaking?.get('self')) : Boolean(s.mic?.speaking && this.transmitting),
      connection: s.status === 'connected' ? 'connected' : 'connecting',
      ping: null,
      relay: false,
      volume: 1,
      localMute: false,
      joinedAt: s.joinedAt,
    };
  }

  get members() {
    const s = this.session;
    if (!s) return [];
    const list = [this.selfMember(s)];
    for (const m of s.members.values()) {
      const peer = s.peers.get(m.userId);
      const audio = s.audio.get(m.userId);
      const ua = this.userAudio(m.userId);
      list.push({
        userId: m.userId,
        name: m.name,
        avatar: m.avatar,
        self: false,
        isOwner: m.userId === s.room.ownerId,
        muted: m.muted,
        deafened: m.deafened,
        ptt: false,
        sharing: m.sharing,
        speaking: s.demo ? Boolean(s.demoSpeaking?.get(m.userId)) : audio?.items.size ? audio.speaking : m.speakingHint,
        connection: s.demo ? m.demoConn || 'connected' : m.away ? 'away' : peer ? peer.state : 'connecting',
        ping: s.demo ? m.demoPing : (peer?.ping ?? null),
        relay: Boolean(peer?.relay),
        volume: ua.volume,
        localMute: ua.muted,
        joinedAt: m.joinedAt,
      });
    }
    return list.sort((a, b) => (b.isOwner ? 1 : 0) - (a.isOwner ? 1 : 0) || a.joinedAt - b.joinedAt);
  }

  get chat() {
    return this.session ? [...this.session.chat] : [];
  }

  get screens() {
    const s = this.session;
    if (!s) return [];
    const out = [];
    if (s.screen) out.push({ userId: s.userId, name: s.name, stream: s.screen.stream, self: true });
    for (const [uid, p] of s.peers) {
      const m = s.members.get(uid);
      if (m && !m.away && m.sharing && p.sharingVideo) out.push({ userId: uid, name: m.name, stream: p.screenStream, self: false });
    }
    if (s.demo && s.demoScreen) out.push(s.demoScreen);
    return out;
  }

  setStatus(status) {
    this.status = status;
    this.emitState();
  }

  setSessionStatus(s, status) {
    if (s.status === status) return;
    s.status = status;
    this.emitState();
    this.emitRoom();
  }

  myIdentity() {
    const p = this.profile;
    const acc = store.selectedAccount?.();
    const name = cleanName(p?.display_name || p?.username || acc?.name) || t('voice.you');
    const avatar = cleanAvatar(p?.mc_uuid) || cleanAvatar(p?.mc_name) || cleanAvatar(acc?.type === 'msa' ? acc?.uuid : acc?.name) || cleanAvatar(p?.username);
    return { name, avatar };
  }

  defaultRoomName() {
    return t('voice.defaultRoomName', { name: this.myIdentity().name }).slice(0, 40);
  }

  // ---------- Salas (base de datos) ----------
  async listRooms() {
    const res = await this.rpc('voice_list_rooms', {});
    const map = (l) => (Array.isArray(l) ? l.map((r) => mapRoom(r, this.user?.id)).filter(Boolean) : []);
    return { mine: map(res.mine), recent: map(res.recent), friends: map(res.friends), friendsSupported: res.friends_supported !== false };
  }

  async roomInfo(input) {
    const code = normalizeCode(input);
    if (!code) throw verr('code_format');
    const res = await this.rpc('voice_room_by_code', { p_code: code });
    return mapRoom(res.room, this.user?.id);
  }

  async createRoom(opts = {}) {
    await this.init();
    if (!this.signedIn()) throw verr('auth');
    const name = cleanName(opts.name).slice(0, 40) || this.defaultRoomName();
    const password = String(opts.password || '');
    if (password && (password.length < 4 || password.length > 64)) throw verr('bad_password_format');
    const res = await this.rpc('voice_create_room', {
      p_name: name,
      p_private: Boolean(opts.private ?? opts.isPrivate),
      p_password: password || null,
      p_max_members: clamp(opts.maxMembers, 2, MAX_MEMBERS, MAX_MEMBERS),
    });
    const room = mapRoom(res.room, this.user?.id);
    if (opts.join === false) return room;
    await this.joinRoom(room.code);
    return this.room;
  }

  async updateRoom(id, patch = {}) {
    if (!this.signedIn()) throw verr('auth');
    const row = {};
    if (patch.name !== undefined) {
      const name = cleanName(patch.name).slice(0, 40);
      if (!name) throw verr('bad_name');
      row.name = name;
    }
    if (patch.isPrivate !== undefined) row.is_private = Boolean(patch.isPrivate);
    if (patch.maxMembers !== undefined) row.max_members = clamp(patch.maxMembers, 2, MAX_MEMBERS, MAX_MEMBERS);
    if (patch.locked !== undefined) row.is_locked = Boolean(patch.locked);
    let room = null;
    if (Object.keys(row).length) {
      const { data, error } = await this.client.from('voice_rooms').update(row).eq('id', id).select(ROOM_COLS).maybeSingle();
      if (error) throw pgError(error);
      if (!data) throw verr('not_owner');
      room = mapRoom(data, this.user?.id);
    }
    if (patch.password !== undefined) {
      const pw = String(patch.password || '');
      if (pw && (pw.length < 4 || pw.length > 64)) throw verr('bad_password_format');
      room = mapRoom((await this.rpc('voice_set_password', { p_room: id, p_password: pw || null })).room, this.user?.id);
    }
    const s = this.session;
    if (s && !s.demo && s.room.id === id && room) {
      Object.assign(s.room, { name: room.name, isPrivate: room.isPrivate, hasPassword: room.hasPassword, maxMembers: room.maxMembers, locked: room.locked });
      if (row.is_locked !== undefined) this.send(s, 'mod', { a: 'lock', l: row.is_locked });
      this.send(s, 'mod', { a: 'update' });
      this.emitRoom();
    }
    return room;
  }

  async deleteRoom(id) {
    if (!this.signedIn()) throw verr('auth');
    const s = this.session;
    if (s && !s.demo && s.room.id === id) await this.endRoom().catch(() => this.leaveRoom({ silent: true }));
    const { error } = await this.client.from('voice_rooms').delete().eq('id', id);
    if (error) throw pgError(error);
  }

  async forgetRoom(id) {
    if (!this.signedIn()) throw verr('auth');
    const { error } = await this.client.from('voice_members').delete().eq('room_id', id).eq('user_id', this.user.id);
    if (error) throw pgError(error);
  }

  // ---------- Entrar / salir ----------
  async joinRoom(input, opts = {}) {
    await this.init();
    const code = normalizeCode(input);
    if (!code) throw verr('code_format');
    if (this.session && !this.session.demo && this.session.room.code === code) return this.room;
    if (!this.configured() || !this.signedIn()) throw verr('auth');
    if (this.joining) throw verr('busy');
    this.joining = code;
    let s = null;
    try {
      if (this.session) await this.leaveRoom({ silent: true });
      this.stopMicTest();
      this.setStatus('joining');
      const identity = await createIdentity();
      const sessionId = randomId(20);
      const res = await this.rpc('voice_join', { p_code: code, p_password: opts.password || null, p_session: sessionId, p_key: identity.publicJwk });
      s = this.newSession(mapRoom(res.room, this.user?.id), sessionId, identity);
      this.session = s;
      await this.startMic(s);
      await this.openChannel(s);
      s.status = 'connected';
      this.startTick();
      s.timers.heartbeat = setInterval(() => this.heartbeat(s), HEARTBEAT_MS);
      s.timers.stats = setInterval(() => {
        for (const p of s.peers.values()) p.updateStats();
      }, STATS_MS);
      this.refreshKeys(s, true);
      this.status = 'idle';
      this.chime('join');
      this.emitRoom();
      this.emitMembers();
      this.emitState();
      this.emitScreens();
      return this.room;
    } catch (err) {
      if (s) {
        if (this.session === s) this.session = null;
        s.left = true;
        await this.teardown(s, { bye: false, rpcLeave: true });
      }
      this.setStatus('idle');
      this.emitRoom();
      this.maybeStopTick();
      throw err;
    } finally {
      this.joining = null;
    }
  }

  newSession(room, sessionId, identity) {
    const me = this.myIdentity();
    return {
      demo: false,
      room,
      userId: this.user?.id || null,
      sessionId,
      identity,
      joinedAt: Date.now(),
      name: me.name,
      avatar: me.avatar,
      status: 'joining',
      channel: null,
      channelReady: false,
      mic: null,
      micError: null,
      members: new Map(),
      keys: new Map(),
      keyMisses: new Map(),
      keysAt: 0,
      keysPromise: null,
      peers: new Map(),
      audio: new Map(),
      localMutes: new Set(),
      chat: [],
      seen: new Map(),
      lastTs: new Map(),
      pending: [],
      inbox: new Map(),
      outChain: Promise.resolve(),
      sendQueue: [],
      screen: null,
      timers: {},
      presenceAt: 0,
      presenceKey: '',
      presenceTimer: null,
      reconcileChain: Promise.resolve(),
      reconcileQueued: false,
      sfxAt: 0,
      sfxFrom: new Map(),
      chatTimes: [],
      chatFrom: new Map(),
      histFrom: new Set(),
      byeSessions: new Set(),
      left: false,
    };
  }

  async openChannel(s) {
    const client = this.client;
    const topic = `voice:${s.room.code}`;
    for (const ch of client.getChannels()) {
      if (ch.topic === `realtime:${topic}`) await client.removeChannel(ch).catch(() => {});
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(() => finish(verr('channel_timeout')), 15000);
      this.buildChannel(s, topic, (status, error) => {
        if (status === 'SUBSCRIBED') finish();
        else if (status === 'CHANNEL_ERROR') finish(/unauthori|permission|denied|not allowed|rls/i.test(String(error?.message || error || '')) ? verr('channel_denied') : verr('channel_timeout'));
        else if (status === 'TIMED_OUT' || status === 'CLOSED') finish(verr('channel_timeout'));
        return settled;
      });
    });
  }

  buildChannel(s, topic, onFirst) {
    const ch = this.client.channel(topic, { config: { private: true, broadcast: { self: false, ack: false }, presence: { key: s.userId, enabled: true } } });
    s.channel = ch;
    ch.on('presence', { event: 'sync' }, () => {
      if (this.session !== s || s.channel !== ch) return;
      s.presenceSnapshot = ch.presenceState();
      this.reconcileSoon(s);
    });
    for (const ev of ['sig', 'chat', 'hist', 'sfx', 'mod']) {
      ch.on('broadcast', { event: ev }, (msg) => {
        if (this.session === s && s.channel === ch) this.onBroadcast(s, ev, msg?.payload);
      });
    }
    let first = true;
    ch.subscribe((status, error) => {
      if (s.left || s.channel !== ch) return;
      if (first && onFirst) {
        const done = onFirst(status, error);
        if (status !== 'SUBSCRIBED' && done) return;
      }
      if (status === 'SUBSCRIBED') {
        const rejoin = !first;
        first = false;
        s.channelReady = true;
        this.trackPresence(s, true);
        this.flushSendQueue(s);
        if (rejoin) {
          this.setSessionStatus(s, 'connected');
          this.refreshKeys(s, true);
        }
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        s.channelReady = false;
        if (!first) this.setSessionStatus(s, 'reconnecting');
      } else if (status === 'CLOSED') {
        s.channelReady = false;
        if (!first && this.session === s) {
          this.setSessionStatus(s, 'reconnecting');
          this.scheduleReopen(s);
        }
      }
    });
    return ch;
  }

  // El canal se cerro sin que salieramos (por ejemplo, el cliente de Realtime se reinicio): reabrirlo
  scheduleReopen(s) {
    clearTimeout(s.timers.reopen);
    s.timers.reopen = setTimeout(async () => {
      if (this.session !== s || s.left || s.channelReady || !this.client) return;
      const topic = `voice:${s.room.code}`;
      const old = s.channel;
      s.channel = null;
      if (old) await this.client.removeChannel(old).catch(() => {});
      if (this.session !== s || s.left) return;
      this.buildChannel(s, topic, null);
    }, 3000);
  }

  async heartbeat(s) {
    if (this.session !== s || s.demo) return;
    try {
      const res = await this.rpc('voice_heartbeat', { p_room: s.room.id, p_session: s.sessionId });
      if (this.session !== s) return;
      const room = mapRoom(res.room, this.user?.id);
      if (room) {
        const changed = ['name', 'isPrivate', 'hasPassword', 'maxMembers', 'locked'].some((k) => s.room[k] !== room[k]);
        Object.assign(s.room, { name: room.name, isPrivate: room.isPrivate, hasPassword: room.hasPassword, maxMembers: room.maxMembers, locked: room.locked, ownerName: room.ownerName });
        if (changed) this.emitRoom();
      }
    } catch (err) {
      if (this.session !== s) return;
      // locked: la sesión venció con la sala cerrada (0014_security.sql) y ya no se puede volver a entrar
      const notices = { kicked: 'noticeKicked', banned: 'noticeBanned', replaced: 'noticeReplaced', gone: 'noticeGone', locked: 'noticeLocked' };
      if (notices[err.code]) {
        await this.leaveRoom({ silent: true });
        toast(err.code === 'replaced' ? 'info' : 'bad', t('voice.noticeLeftTitle'), t(`voice.${notices[err.code]}`), 8000);
      }
    }
  }

  async leaveRoom({ silent = false } = {}) {
    const s = this.session;
    if (!s) return;
    this.session = null;
    s.left = true;
    await this.teardown(s, { bye: !s.demo, rpcLeave: !s.demo });
    clearTimeout(this.pttTimer);
    this.pttDown = false;
    this.status = 'idle';
    if (!silent) this.chime('leave');
    this.emitRoom();
    this.emitMembers();
    this.emitScreens();
    this.emitState();
    this.emit('chat', null);
    this.maybeStopTick();
  }

  async teardown(s, { bye, rpcLeave }) {
    for (const k of Object.keys(s.timers)) {
      clearInterval(s.timers[k]);
      clearTimeout(s.timers[k]);
    }
    clearTimeout(s.presenceTimer);
    if (bye && s.channelReady && s.identity) await this.sendNow(s, 'sig', { k: 'bye' }).catch(() => {});
    if (s.screen) {
      s.screen.stream.getTracks().forEach((tr) => tr.stop());
      s.screen = null;
    }
    s.demoScreen?.stream.getTracks().forEach((tr) => tr.stop());
    for (const p of s.peers.values()) p.close();
    s.peers.clear();
    for (const a of s.audio.values()) a.close();
    s.audio.clear();
    const ch = s.channel;
    s.channel = null;
    s.channelReady = false;
    // Sin esperar respuestas: sin conexion, untrack/removeChannel tardarian lo que dura el timeout
    if (ch) {
      ch.untrack().catch(() => {});
      this.client?.removeChannel(ch).catch(() => {});
    }
    s.mic?.stop();
    if (rpcLeave && this.client) this.rpc('voice_leave', { p_room: s.room.id, p_session: s.sessionId }).catch(() => {});
  }

  // Cierre de la ventana: lo que se pueda sin esperar
  teardownSync() {
    const s = this.session;
    if (!s || s.demo) return;
    this.session = null;
    s.left = true;
    for (const p of s.peers.values()) p.close();
    s.screen?.stream.getTracks().forEach((tr) => tr.stop());
    s.mic?.stop();
    try {
      s.channel?.untrack();
      this.client?.removeChannel(s.channel);
    } catch {
      /* cerrando */
    }
    this.rpc('voice_leave', { p_room: s.room.id, p_session: s.sessionId }).catch(() => {});
  }

  // ---------- Presencia ----------
  presenceState(s) {
    return { s: s.sessionId, j: s.joinedAt, m: this.muted ? 1 : 0, d: this.deafened ? 1 : 0, sp: s.lastSpeaking ? 1 : 0, sh: s.screen ? 1 : 0 };
  }

  trackPresenceSoon() {
    const s = this.session;
    if (s && !s.demo) this.trackPresence(s, false);
  }

  async trackPresence(s, force) {
    if (this.session !== s || !s.channel || !s.channelReady) return;
    const st = this.presenceState(s);
    const key = `${st.m}${st.d}${st.sp}${st.sh}`;
    if (!force && key === s.presenceKey) return;
    // Cambios de "hablando" muy espaciados; el resto rapido (el indicador real sale del audio)
    const onlySpeaking = s.presenceKey && key[0] === s.presenceKey[0] && key[1] === s.presenceKey[1] && key[3] === s.presenceKey[3];
    const gap = onlySpeaking ? 3000 : 250;
    const wait = force ? 0 : gap - (Date.now() - s.presenceAt);
    if (wait > 0) {
      clearTimeout(s.presenceTimer);
      s.presenceTimer = setTimeout(() => this.trackPresence(s, false), wait);
      return;
    }
    s.presenceAt = Date.now();
    s.presenceKey = key;
    try {
      st.sig = await signText(s.identity.privateKey, presenceText(s.room.id, s.userId, st));
      if (this.session === s && s.channelReady) await s.channel.track(st);
    } catch (err) {
      console.warn('[voice] presencia', err?.message || err);
    }
  }

  reconcileSoon(s) {
    if (s.reconcileQueued) return;
    s.reconcileQueued = true;
    queueMicrotask(() => {
      s.reconcileQueued = false;
      s.reconcileChain = s.reconcileChain.then(() => this.reconcile(s)).catch((err) => console.warn('[voice] presencia', err));
    });
  }

  async reconcile(s) {
    if (this.session !== s || s.demo) return;
    const state = s.presenceSnapshot || {};
    const latest = new Map();
    for (const [uid, metas] of Object.entries(state)) {
      if (!Array.isArray(metas)) continue;
      for (const meta of metas) {
        if (!meta || typeof meta.s !== 'string' || typeof meta.sig !== 'string' || s.byeSessions.has(meta.s)) continue;
        if (uid === s.userId) {
          // Otra sesion mia mas nueva en esta sala: confirmarlo con el servidor
          if (meta.s !== s.sessionId && Number(meta.j) > s.joinedAt) this.heartbeat(s);
          continue;
        }
        const prev = latest.get(uid);
        if (!prev || Number(meta.j) > Number(prev.j)) latest.set(uid, meta);
      }
    }
    const now = Date.now();
    let missing = false;
    for (const [uid, meta] of latest) {
      const key = await this.keyFor(s, uid, meta.s);
      if (this.session !== s) return;
      if (!key) {
        missing = this.noteMissingKey(s, uid, meta.s) || missing;
        continue;
      }
      if (!(await verifyText(key, presenceText(s.room.id, uid, meta), meta.sig))) continue;
      const info = s.keys.get(uid);
      let m = s.members.get(uid);
      if (m && m.session !== meta.s) {
        this.dropPeer(s, uid);
        m = null;
      }
      const isNew = !m;
      m = m || { userId: uid, joinedAt: Number(meta.j) || now };
      Object.assign(m, {
        session: meta.s,
        name: info?.name || t('voice.unknownUser'),
        avatar: info?.avatar || null,
        muted: Boolean(meta.m),
        deafened: Boolean(meta.d),
        speakingHint: Boolean(meta.sp),
        sharing: Boolean(meta.sh),
        away: false,
        awaySince: 0,
      });
      if (isNew) m.joinedAt = Number(meta.j) || now;
      s.members.set(uid, m);
      if (isNew) this.onMemberJoined(s, m);
      this.ensurePeer(s, uid, meta.s);
    }
    for (const m of [...s.members.values()]) {
      if (latest.has(m.userId)) continue;
      if (!m.away) {
        m.away = true;
        m.awaySince = now;
        setTimeout(() => this.reconcileSoon(s), AWAY_GRACE_MS + 200);
      }
      const peer = s.peers.get(m.userId);
      // Si la conexion directa sigue viva, esperar un poco (corte breve de Realtime)
      if (now - m.awaySince >= AWAY_GRACE_MS || !peer || peer.state !== 'connected') this.removeMember(s, m.userId, true);
    }
    if (missing) this.refreshKeys(s);
    this.emitMembersSoon();
    this.emitScreensSoon();
  }

  noteMissingKey(s, uid, session) {
    const k = `${uid}:${session}`;
    const n = (s.keyMisses.get(k) || 0) + 1;
    s.keyMisses.set(k, n);
    return n <= 4;
  }

  async keyFor(s, uid, session) {
    const k = s.keys.get(uid);
    if (!k || k.session !== session || !k.keyText) return null;
    if (!k.key) {
      try {
        k.key = await importPublicKey(k.keyText);
      } catch {
        k.keyText = null;
        return null;
      }
    }
    return k.key;
  }

  refreshKeys(s, force = false) {
    if (s.demo) return Promise.resolve();
    if (s.keysPromise) {
      s.keysAgain = true;
      return s.keysPromise;
    }
    const wait = force ? 0 : Math.max(0, 1500 - (Date.now() - s.keysAt));
    s.keysPromise = new Promise((r) => setTimeout(r, wait))
      .then(async () => {
        if (this.session !== s) return;
        s.keysAt = Date.now();
        const res = await this.rpc('voice_member_keys', { p_room: s.room.id });
        for (const row of Array.isArray(res.members) ? res.members : []) {
          if (!row?.user_id || row.user_id === s.userId || typeof row.session !== 'string' || typeof row.key !== 'string') continue;
          const prev = s.keys.get(row.user_id);
          const name = cleanName(row.name) || t('voice.unknownUser');
          const avatar = cleanAvatar(row.avatar);
          if (prev && prev.session === row.session && prev.keyText === row.key) {
            prev.name = name;
            prev.avatar = avatar;
          } else {
            s.keys.set(row.user_id, { session: row.session, keyText: row.key, key: null, name, avatar });
          }
        }
      })
      .catch((err) => console.warn('[voice] claves de la sala', err?.message || err))
      .finally(() => {
        s.keysPromise = null;
        if (this.session !== s) return;
        this.reconcileSoon(s);
        this.retryPending(s);
        if (s.keysAgain) {
          s.keysAgain = false;
          this.refreshKeys(s);
        }
      });
    return s.keysPromise;
  }

  onMemberJoined(s, m) {
    // Los que ya estaban cuando entre no generan aviso
    if (m.joinedAt < s.joinedAt) return;
    this.pushChat(s, { id: randomId(10), system: 'join', name: m.name, ts: Date.now() });
    this.chime('join');
    // El miembro mas antiguo le pasa el historial del chat al recien llegado: los sobres firmados originales,
    // asi el que entra verifica cada mensaje con la clave de quien lo escribio
    const senior = [...s.members.values()].filter((x) => x.userId !== m.userId && !x.away).every((x) => x.joinedAt > s.joinedAt);
    const history = s.chat.filter((x) => x.env).slice(-40);
    if (senior && history.length) {
      this.send(s, 'hist', { list: history.map((x) => x.env) }, m.userId, m.session);
    }
  }

  removeMember(s, uid, notify) {
    const m = s.members.get(uid);
    if (!m) return;
    s.members.delete(uid);
    this.dropPeer(s, uid);
    if (notify) {
      this.pushChat(s, { id: randomId(10), system: 'leave', name: m.name, ts: Date.now() });
      this.chime('leave');
    }
    this.emitMembersSoon();
    this.emitScreensSoon();
  }

  // ---------- WebRTC ----------
  ensurePeer(s, uid, session) {
    if (!session || this.session !== s || s.demo || uid === s.userId) return null;
    let peer = s.peers.get(uid);
    if (peer && peer.session === session && !peer.closed) return peer;
    if (peer) this.dropPeer(s, uid);
    if (s.peers.size >= MAX_MEMBERS + 2) return null;
    peer = new Peer({
      id: uid,
      session,
      polite: s.userId < uid,
      rtcConfig: this.rtcConfig(),
      audioTrack: s.mic.track,
      audioStream: s.mic.stream,
      screen: s.screen,
      videoBitrate: this.videoBitrate(s.peers.size + 1),
      send: (kind, data) => this.send(s, 'sig', { k: kind, ...data }, uid, session),
      onTrack: (p, track) => {
        if (track.kind === 'audio' && s.peers.get(uid) === p) this.remoteAudio(s, uid).add(track);
      },
      onChange: () => {
        this.emitMembersSoon();
        this.emitScreensSoon();
      },
    });
    s.peers.set(uid, peer);
    this.updateVideoBitrates(s);
    return peer;
  }

  dropPeer(s, uid) {
    const p = s.peers.get(uid);
    if (p) {
      p.close();
      s.peers.delete(uid);
    }
    const a = s.audio.get(uid);
    if (a) {
      a.close();
      s.audio.delete(uid);
    }
    this.updateVideoBitrates(s);
  }

  videoBitrate(n) {
    return Math.round(Math.max(400000, Math.min(2500000, 4000000 / Math.max(1, n))));
  }

  updateVideoBitrates(s) {
    if (!s.screen) return;
    const bps = this.videoBitrate(s.peers.size);
    for (const p of s.peers.values()) p.setVideoBitrate(bps);
  }

  // ---------- Mensajes firmados ----------
  send(s, event, body, to = null, toSession = null) {
    if (s.demo || s.left) return Promise.resolve();
    s.outChain = s.outChain.then(() => this.sendNow(s, event, body, to, toSession)).catch((err) => console.warn('[voice] envio', err?.message || err));
    return s.outChain;
  }

  async sendNow(s, event, body, to = null, toSession = null) {
    const env = { f: s.userId, fs: s.sessionId, to, tos: toSession, ts: Date.now(), n: randomId(14), d: JSON.stringify(body) };
    env.sig = await signText(s.identity.privateKey, envelopeText(event, s.room.id, env));
    if (!s.channel || !s.channelReady) {
      if (s.left) return null;
      s.sendQueue.push({ event, env });
      if (s.sendQueue.length > 300) s.sendQueue.shift();
      return env;
    }
    await s.channel.send({ type: 'broadcast', event, payload: env });
    return env;
  }

  flushSendQueue(s) {
    const items = s.sendQueue.splice(0);
    for (const { event, env } of items) {
      if (Date.now() - env.ts < 30000) s.channel?.send({ type: 'broadcast', event, payload: env }).catch(() => {});
    }
  }

  onBroadcast(s, event, env) {
    if (!env || typeof env !== 'object' || typeof env.f !== 'string' || env.f === s.userId) return;
    if (env.to && env.to !== s.userId) return;
    if (env.tos && env.tos !== s.sessionId) return;
    const prev = s.inbox.get(env.f) || Promise.resolve();
    const next = prev.then(() => this.processEnvelope(s, event, env)).catch((err) => console.warn('[voice] mensaje', err?.message || err));
    s.inbox.set(env.f, next);
  }

  async processEnvelope(s, event, env) {
    if (this.session !== s) return;
    const { f, fs, ts, n, d, sig } = env;
    if (typeof fs !== 'string' || typeof n !== 'string' || typeof d !== 'string' || typeof sig !== 'string' || n.length > 40 || d.length > 120000) return;
    // Repeticiones: nonce ya visto o mucho mas viejo que lo ultimo de esa sesion (con el reloj del que manda,
    // asi una PC con la hora corrida no queda afuera)
    const clockKey = `${f}:${fs}`;
    if (!Number.isFinite(ts) || s.seen.has(n) || ts < (s.lastTs.get(clockKey) || 0) - MSG_MAX_AGE) return;
    const key = await this.keyFor(s, f, fs);
    if (!key) {
      s.pending.push({ event, env, at: Date.now() });
      if (s.pending.length > 120) s.pending.shift();
      if (this.noteMissingKey(s, f, fs)) this.refreshKeys(s);
      return;
    }
    if (!(await verifyText(key, envelopeText(event, s.room.id, env), sig))) return;
    s.seen.set(n, ts);
    s.lastTs.set(clockKey, Math.max(s.lastTs.get(clockKey) || 0, ts));
    if (s.seen.size > 4000) {
      // Se descartan los nonces mas viejos (el Map conserva el orden de llegada)
      let drop = s.seen.size - 3000;
      for (const k of s.seen.keys()) {
        if (drop-- <= 0) break;
        s.seen.delete(k);
      }
    }
    let body;
    try {
      body = JSON.parse(d);
    } catch {
      return;
    }
    if (!body || typeof body !== 'object') return;
    return this.dispatch(s, event, f, fs, body, env);
  }

  retryPending(s) {
    const items = s.pending.splice(0).filter((p) => Date.now() - p.at < 12000);
    for (const p of items) this.onBroadcast(s, p.event, p.env);
  }

  dispatch(s, event, from, fromSession, body, env = null) {
    if (event === 'sig') this.onSignalMsg(s, from, fromSession, body);
    else if (event === 'chat') this.onChatMsg(s, from, body, env);
    else if (event === 'hist') return this.onHistory(s, from, body);
    else if (event === 'sfx') this.onSfx(s, from, body);
    else if (event === 'mod') this.onMod(s, from, body);
  }

  onSignalMsg(s, from, fromSession, body) {
    const kind = body.k;
    if (!SIGNAL_KINDS.has(kind)) return;
    if (kind === 'bye') {
      // La presencia puede tardar en enterarse: ignorar esa sesion desde ya
      s.byeSessions.add(fromSession);
      this.removeMember(s, from, true);
      this.dropPeer(s, from);
      return;
    }
    if (kind === 'reset') {
      this.dropPeer(s, from);
      this.ensurePeer(s, from, fromSession);
      return;
    }
    const peer = this.ensurePeer(s, from, fromSession);
    peer?.handle(kind, body);
  }

  // ---------- Chat ----------
  async sendChat(text) {
    const s = this.session;
    if (!s) throw verr('not_in_room');
    const clean = String(text || '')
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
      .trim()
      .slice(0, 500);
    if (!clean) return null;
    const now = Date.now();
    s.chatTimes = s.chatTimes.filter((x) => now - x < 5000);
    if (s.chatTimes.length >= 5) throw verr('chat_fast');
    s.chatTimes.push(now);
    const msg = { id: randomId(14), from: s.userId, name: s.name, avatar: s.avatar, text: clean, ts: now, self: true };
    this.pushChat(s, msg);
    // El sobre firmado queda guardado para pasarlo en el historial a los que entren despues
    this.send(s, 'chat', { id: msg.id, text: clean }).then((env) => (msg.env = chatEnvelope(env)));
    return msg;
  }

  pushChat(s, msg) {
    s.chat.push(msg);
    if (s.chat.length > 250) s.chat.splice(0, s.chat.length - 250);
    this.emit('chat', msg);
  }

  onChatMsg(s, from, body, env = null) {
    const text = typeof body.text === 'string' ? body.text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, 500) : '';
    if (!text) return;
    const id = typeof body.id === 'string' ? body.id.slice(0, 24) : randomId(14);
    if (s.chat.some((m) => m.id === id)) return;
    const now = Date.now();
    const times = (s.chatFrom.get(from) || []).filter((x) => now - x < 5000);
    if (times.length >= 8) return;
    times.push(now);
    s.chatFrom.set(from, times);
    const info = s.members.get(from) || s.keys.get(from);
    this.pushChat(s, { id, from, name: info?.name || t('voice.unknownUser'), avatar: info?.avatar || null, text, ts: now, self: false, env: chatEnvelope(env) });
    if (!s.localMutes.has(from)) this.chime('message');
  }

  // Historial al entrar: cada mensaje tiene que venir en su sobre de 'chat' con la firma de quien lo escribio
  // (un miembro que sigue en la sala con esa sesion). Quien lo reenvia no puede inventar ni cambiar autor, texto
  // u hora; el nombre sale de las claves del servidor y lo que no se puede verificar se descarta.
  async onHistory(s, from, body) {
    if (s.histFrom.has(from) || !Array.isArray(body.list)) return;
    s.histFrom.add(from);
    const ids = new Set();
    const items = [];
    for (const it of body.list.slice(-60)) {
      const env = chatEnvelope(it);
      if (!env || typeof env.f !== 'string' || typeof env.fs !== 'string' || typeof env.n !== 'string' || typeof env.d !== 'string' || env.d.length > 4000 || !Number.isFinite(env.ts)) continue;
      const key = await this.keyFor(s, env.f, env.fs);
      if (this.session !== s) return;
      if (!key || !(await verifyText(key, envelopeText('chat', s.room.id, env), env.sig))) continue;
      let msg;
      try {
        msg = JSON.parse(env.d);
      } catch {
        continue;
      }
      const text = typeof msg?.text === 'string' ? msg.text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, 500) : '';
      const id = typeof msg?.id === 'string' ? msg.id.slice(0, 24) : '';
      if (!text || !id || ids.has(id)) continue;
      ids.add(id);
      const info = s.members.get(env.f) || s.keys.get(env.f);
      items.push({ id, from: env.f, name: info?.name || t('voice.unknownUser'), avatar: info?.avatar || null, text, ts: Math.min(env.ts, Date.now()), self: false, history: true, env });
    }
    if (this.session !== s) return;
    const known = new Set(s.chat.map((m) => m.id));
    const fresh = items.filter((m) => !known.has(m.id));
    if (!fresh.length) return;
    s.chat = [...fresh, ...s.chat].sort((a, b) => a.ts - b.ts).slice(-250);
    this.emit('chat', { history: true });
  }

  // ---------- Soundboard ----------
  playSound(id) {
    if (!SOUND_IDS.has(id)) return false;
    const s = this.session;
    const now = Date.now();
    if (s) {
      if (now - s.sfxAt < 1500) return false;
      s.sfxAt = now;
      this.send(s, 'sfx', { id });
    }
    if (!this.deafened) this.sfxLocal(id);
    return true;
  }

  previewSound(id) {
    if (SOUND_IDS.has(id)) this.sfxLocal(id);
  }

  sfxLocal(id) {
    try {
      this.lastSfx = Date.now();
      playSound(this.audioCtx(), id, { volume: clamp(this.cfg.soundboardVolume, 0, 1, 0.7) });
      this.maybeSuspend();
    } catch {
      /* sin audio */
    }
  }

  get soundCooldown() {
    const s = this.session;
    return s ? Math.max(0, 1500 - (Date.now() - s.sfxAt)) : 0;
  }

  onSfx(s, from, body) {
    if (!SOUND_IDS.has(body.id)) return;
    const now = Date.now();
    if (now - (s.sfxFrom.get(from) || 0) < 1200) return;
    s.sfxFrom.set(from, now);
    const info = s.members.get(from);
    this.emit('sound', { from, id: body.id, name: info?.name || '' });
    if (!this.cfg.soundboardEnabled || this.deafened || s.localMutes.has(from)) return;
    this.sfxLocal(body.id);
  }

  // ---------- Moderacion (solo el dueño de la sala) ----------
  requireOwner() {
    const s = this.session;
    if (!s) throw verr('not_in_room');
    if (s.room.ownerId !== s.userId) throw verr('not_owner');
    return s;
  }

  onMod(s, from, body) {
    if (from !== s.room.ownerId) return;
    const a = body.a;
    if (a === 'mute' && body.t === s.userId) {
      if (!this.muted) {
        this.setMuted(true);
        toast('info', t('voice.noticeMutedTitle'), t('voice.noticeMutedByHost'), 6000);
      }
    } else if (a === 'kick' && typeof body.t === 'string') {
      if (body.t === s.userId) {
        this.leaveRoom({ silent: true });
        toast('bad', t('voice.noticeLeftTitle'), t(body.b ? 'voice.noticeBanned' : 'voice.noticeKicked'), 8000);
      } else this.removeMember(s, body.t, false);
    } else if (a === 'lock') {
      s.room.locked = Boolean(body.l);
      this.emitRoom();
    } else if (a === 'update') {
      this.heartbeat(s);
    } else if (a === 'end') {
      this.leaveRoom({ silent: true });
      toast('info', t('voice.noticeLeftTitle'), t('voice.noticeEnded'), 8000);
    }
  }

  async requestMute(userId) {
    const s = this.requireOwner();
    if (s.demo) return;
    await this.send(s, 'mod', { a: 'mute', t: userId });
  }

  async kick(userId, { ban = false } = {}) {
    const s = this.requireOwner();
    if (!s.demo) {
      await this.rpc('voice_kick', { p_room: s.room.id, p_user: userId, p_ban: Boolean(ban) });
      await this.send(s, 'mod', { a: 'kick', t: userId, b: Boolean(ban) });
    }
    this.removeMember(s, userId, false);
  }

  async setLocked(locked) {
    const s = this.requireOwner();
    if (s.demo) {
      s.room.locked = Boolean(locked);
      this.emitRoom();
      return;
    }
    await this.updateRoom(s.room.id, { locked: Boolean(locked) });
  }

  async endRoom() {
    const s = this.requireOwner();
    if (!s.demo) await this.send(s, 'mod', { a: 'end' });
    await this.leaveRoom();
  }

  // ---------- Pantalla compartida ----------
  // opts.stream: compartir un MediaStream ya creado (pruebas automaticas) en vez de pedir la pantalla
  async startScreenShare(opts = {}) {
    const s = this.session;
    if (!s || s.demo) throw verr('not_in_room');
    if (s.screen) return true;
    let stream = opts.stream instanceof MediaStream ? opts.stream : null;
    try {
      stream = stream || (await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 }, width: { max: 1920 }, height: { max: 1080 } }, audio: false }));
    } catch (err) {
      if (err?.name === 'NotAllowedError' || err?.name === 'AbortError') return false;
      throw verr('screen');
    }
    const track = stream.getVideoTracks()[0];
    if (this.session !== s || !track) {
      stream.getTracks().forEach((tr) => tr.stop());
      if (!track) throw verr('screen');
      return false;
    }
    try {
      track.contentHint = 'detail';
    } catch {
      /* sin soporte */
    }
    track.addEventListener('ended', () => {
      if (s.screen?.track === track) this.stopScreenShare();
    });
    s.screen = { stream, track };
    for (const p of s.peers.values()) p.setScreen(track, stream);
    this.updateVideoBitrates(s);
    this.trackPresence(s, true);
    this.emitState();
    this.emitScreens();
    this.emitMembersSoon();
    return true;
  }

  stopScreenShare() {
    const s = this.session;
    if (!s?.screen) return;
    const { stream } = s.screen;
    s.screen = null;
    stream.getTracks().forEach((tr) => tr.stop());
    for (const p of s.peers.values()) p.clearScreen();
    this.trackPresence(s, true);
    this.emitState();
    this.emitScreens();
    this.emitMembersSoon();
  }

  // ---------- Invitar ----------
  async inviteFriend(userId, { openPage = true } = {}) {
    await this.init();
    if (!userId || typeof userId !== 'string') throw verr('bad_request');
    if (typeof social?.sendSignal !== 'function') throw verr('invite_unavailable');
    let created = false;
    if (!this.session || this.session.demo) {
      await this.createRoom({ private: true });
      created = true;
    }
    const s = this.session;
    await this.rpc('voice_invite', { p_room: s.room.id, p_user: userId });
    await social.sendSignal(userId, 'voice-invite', { room: s.room.code, name: s.name });
    if (created && openPage) {
      import('./app.js')
        .then((m) => m.navigate('voice'))
        .catch(() => {});
    }
    return s.room.code;
  }

  // ---------- Vista previa para capturas de desarrollo (VENUS_DEVSHOT) ----------
  demoScreenStream() {
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const g = canvas.getContext('2d');
    const sky = g.createLinearGradient(0, 0, 0, 720);
    sky.addColorStop(0, '#2b1a3d');
    sky.addColorStop(0.55, '#c8642a');
    sky.addColorStop(1, '#f2a65a');
    g.fillStyle = sky;
    g.fillRect(0, 0, 1280, 720);
    g.fillStyle = '#ffd27a';
    g.fillRect(900, 230, 120, 120);
    for (let x = 0; x < 1280; x += 40) {
      const h = 470 + Math.round(Math.sin(x / 140) * 40 + Math.cos(x / 61) * 18) - ((x / 40) % 3) * 6;
      g.fillStyle = '#4f8a2b';
      g.fillRect(x, h, 40, 40);
      g.fillStyle = '#6b4a2e';
      g.fillRect(x, h + 40, 40, 720 - h);
      g.fillStyle = 'rgba(0,0,0,.12)';
      for (let y = h + 40; y < 720; y += 40) g.fillRect(x + ((y / 40) % 2) * 20, y, 20, 20);
    }
    g.fillStyle = 'rgba(0,0,0,.45)';
    g.fillRect(24, 24, 330, 54);
    g.fillStyle = '#fff3e3';
    g.font = 'bold 26px sans-serif';
    g.fillText('Minecraft 1.21 · Survival', 40, 60);
    return canvas.captureStream(2);
  }

  async demo({ screen = false } = {}) {
    if (!store.info?.devshot) return false;
    await this.init();
    if (this.session) await this.leaveRoom({ silent: true });
    const me = this.myIdentity();
    if (!this.profile) me.name = cleanName(store.selectedAccount?.()?.name) || 'Steve';
    const now = Date.now();
    const people = [
      { userId: 'demo-luna', name: 'Luna', avatar: 'Notch', demoTalk: true, seed: 1, demoPing: 38 },
      { userId: 'demo-tomi', name: 'Tomi_MC', avatar: 'jeb_', muted: true, seed: 2, demoPing: 64 },
      { userId: 'demo-sofi', name: 'Sofi', avatar: 'Dinnerbone', sharing: false, demoTalk: true, seed: 3, demoPing: 112, demoConn: 'connected' },
      { userId: 'demo-bauti', name: 'Bauti', avatar: 'Grumm', deafened: true, muted: true, seed: 4, demoConn: 'reconnecting' },
    ];
    const s = this.newSession({ id: 'demo', code: 'VN7K2Q', name: t('voice.defaultRoomName', { name: me.name }), ownerId: 'demo-self', ownerName: me.name, isPrivate: false, hasPassword: true, maxMembers: 8, locked: false, active: 5, people: [] }, 'demo-session', null);
    Object.assign(s, { demo: true, userId: 'demo-self', status: 'connected', demoSpeaking: new Map(), name: me.name, avatar: me.avatar || 'Steve' });
    s.joinedAt = now - 60000;
    people.forEach((p, i) => s.members.set(p.userId, { muted: false, deafened: false, sharing: false, speakingHint: false, away: false, joinedAt: now - 50000 + i * 1000, session: 'demo', ...p }));
    const lines = [
      ['demo-luna', 'Luna', 'voice.demoChat1'],
      ['demo-tomi', 'Tomi_MC', 'voice.demoChat2'],
      ['demo-self', me.name, 'voice.demoChat3'],
      ['demo-sofi', 'Sofi', 'voice.demoChat4'],
    ];
    lines.forEach(([from, name, key], i) => s.chat.push({ id: `d${i}`, from, name, text: t(key), ts: now - (lines.length - i) * 45000, self: from === 'demo-self' }));
    s.chat.splice(2, 0, { id: 'dj', system: 'join', name: 'Bauti', ts: now - 100000 });
    if (screen) {
      s.members.get('demo-sofi').sharing = true;
      s.demoScreen = { userId: 'demo-sofi', name: 'Sofi', stream: this.demoScreenStream(), self: false };
    }
    s.mic = new LocalMic(this.audioCtx());
    this.session = s;
    this.startTick();
    this.emitRoom();
    this.emitMembers();
    this.emitState();
    this.emitScreens();
    return true;
  }
}

export const voice = new VoiceEngine();
export { SOUNDS };
