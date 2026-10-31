// Amigos, presencia y mensajes privados sobre Supabase (tablas de supabase/migrations/0002_social.sql).
//
// Contrato (docs/arquitectura.md §6):
//   social.init()                          arranca solo; sin nube o sin sesion queda inactivo y emite 'ready'
//   social.on(evento, fn) -> off           'ready' ({ state }), 'unread' (no leidos + solicitudes recibidas),
//                                          'message' ({ chatId, from, fromId, text }), 'friends' (lista),
//                                          'presence' ({ userId, presence, activity, lastSeen }), 'requests' ({ incoming, outgoing })
//                                          Para la pagina de Mensajes: 'state', 'status', 'chat', 'typing', 'profile', 'outbox'
//   social.friends                         amigos aceptados (perfil + presencia + actividad + conversacion)
//   social.activeChat                      conversacion abierta en Mensajes (o null)
//   social.presenceOf(userId)              { presence, activity, lastSeen, statusText }
//   social.openChat(userId)                abre Mensajes con ese amigo y devuelve el id de la conversacion
//   social.sendMessage(chatId, texto)      envia; sin conexion queda en cola y se reintenta solo
//   social.sendSignal(userId, tipo, datos) / social.onSignal(tipo, fn)
//                                          señales efimeras por el buzon Realtime "inbox:<userId>" (solo lo escucha este modulo)
//   social.moderation                      { muted, mutedUntil, banned, bannedUntil } de la cuenta (rpc my_moderation, 0012)
//                                          o null si no se sabe; evento 'moderation' cuando cambia
import { store, api } from './store.js';
import { cloud } from './cloud.js';
import { t, loadNs } from './i18n.js';
import { toast } from './ui.js';
import { createSupabaseBackend, SocialError } from './social/backend.js';
import { sanitizeActivity, publicAddress, displayName, isOnline } from './social/cosmetics.js';

const HEARTBEAT_MS = 60_000;
const STALE_MS = 150_000;
const RESYNC_MS = 180_000;
const IDLE_MS = 10 * 60_000;
const TYPING_SEND_MS = 3000;
const TYPING_SHOW_MS = 6500;
const PAGE = 40;
export const MAX_MESSAGE = 2000;

const DEFAULT_PREFS = { shareActivity: true, status: 'online', autoAway: true, notifications: true };
const KNOWN_ERRORS = new Set([
  'user_not_found',
  'cannot_add_self',
  'user_blocked',
  'too_many_requests',
  'request_not_found',
  'not_friends',
  'invalid_query',
  'invalid_signal',
  'not_authenticated',
  'conversation_not_found',
  'message_not_found',
  'too_many_reactions',
  'rate_limited',
  'user_muted', // moderacion (0012_admin.sql)
  'user_banned',
]);
const CODE_RE = /^venus-?[a-z0-9]{6}$/i;
const USER_RE = /^@?[A-Za-z0-9_]{3,20}$/;

const ts = (v) => (v ? Date.parse(v) || 0 : 0);

function summary(row) {
  if (!row) return null;
  return { id: row.id, senderId: row.sender_id, body: row.deleted ? '' : String(row.body || '').slice(0, 200), deleted: Boolean(row.deleted), at: row.created_at, local: Boolean(row._local) };
}

class Social {
  constructor() {
    this.listeners = new Map();
    this.signalListeners = new Map();
    this.state = 'idle'; // idle | disabled | signedOut | loading | ready | missingSchema | error
    this.status = 'offline'; // conexion en vivo: offline | connecting | online
    this.error = null;
    this.userId = null;
    this.me = null;
    this.friends = [];
    this.requests = { incoming: [], outgoing: [] };
    this.blocked = [];
    this.activeChat = null;
    this.activeUser = null;
    this.unreadMessages = 0;
    this.unreadTotal = 0;
    this.typing = new Map(); // chatId -> momento del ultimo "escribiendo"
    this.outbox = [];
    this.moderation = null; // { muted, mutedUntil, banned, bannedUntil } (0012_admin.sql) o null

    this._chats = new Map();
    this._friendships = new Map();
    this._profiles = new Map();
    this._activity = new Map();
    this._presenceKeys = new Map();
    this._reactionIndex = new Map();
    this._typingSent = new Map();
    this._games = new Map();
    this._channels = {};
    this._timers = [];
    this._backend = null;
    this._sub = null;
    this._gen = 0;
    this._initDone = false;
    this._mock = false;
    this._clockOffset = 0;
    this._lastInput = Date.now();
    this._wasIdle = false;
    this._lastBeatKey = null;
    this._lastSync = 0;
    this._requestsKey = '';
    this._signalsOk = true;
    this._retries = 0;
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
        console.error('[social]', evt, err);
      }
    }
  }

  // ---------- Arranque ----------
  async init() {
    if (this._initDone) return;
    this._initDone = true;
    await loadNs('social').catch(() => {});
    cloud.on('auth', (s) => {
      if (!this._mock && (s?.user?.id || null) !== this.userId) this._restart();
    });
    cloud.on('config', () => !this._mock && this._restart());
    cloud.on('profile', (p) => {
      if (this._mock || !p || p.id !== this.userId) return;
      this.me = p;
      this._profiles.set(p.id, p);
      this.emit('profile', p);
    });
    api.on('game:state', (id, st) => this._onGameState(id, st));
    api.on('game:activity', (id, act) => this._onGameActivity(id, act));
    store.on('settings', () => this._presenceChanged());
    store.on('instances', () => this._presenceChanged());
    for (const ev of ['mousemove', 'mousedown', 'keydown', 'wheel']) window.addEventListener(ev, () => this._onInput(), { passive: true, capture: true });
    window.addEventListener('focus', () => this._onFocus());
    window.addEventListener('online', () => this._onNetwork(true));
    window.addEventListener('offline', () => this._onNetwork(false));
    window.addEventListener('beforeunload', () => {
      if (this.state === 'ready' && this._myStatus() !== 'offline') this._backend?.goOfflineBeacon?.();
    });
    this._loadGames();
    this._restart(); // no se espera: la red no frena el arranque del launcher
  }

  async _restart() {
    const gen = ++this._gen;
    await this._teardown();
    if (gen !== this._gen) return;
    if (!cloud.isConfigured()) return this._setIdle('disabled');
    if (!cloud.isSignedIn()) return this._setIdle('signedOut');
    const backend = createSupabaseBackend(cloud.client, cloud.user.id, () => ({ url: cloud.config.url, key: cloud.config.anonKey, token: cloud.session?.access_token }));
    await this._start(backend, cloud.profile, gen);
  }

  // Reintento manual (estado 'error' o 'missingSchema' despues de aplicar la migracion).
  async retry() {
    if (!this._mock) return this._restart();
    const backend = this._backend;
    const me = this.me;
    if (!backend) return;
    const gen = ++this._gen;
    await this._teardown();
    return this._start(backend, me, gen);
  }

  // Reconectar a mano (lo usaba la pagina de Ajustes vieja; equivale a retry()).
  connect() {
    return this.retry();
  }

  // Solo para pruebas visuales (devshot): usa otro backend con la misma interfaz (ver social/devmock.js).
  async _attachBackend(backend, profile) {
    this._mock = true;
    const gen = ++this._gen;
    await this._teardown();
    await this._start(backend, profile, gen);
  }

  _setIdle(state) {
    this.moderation = null;
    this._setState(state);
    this._setStatus('offline');
    this.emit('friends', this.friends);
    this.emit('requests', this.requests);
    this._recountUnread(true);
    this.emit('ready', { state });
  }

  _setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', state);
  }

  _setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }

  async _start(backend, profile, gen) {
    this._backend = backend;
    this.userId = backend.userId;
    this.me = profile || null;
    if (profile) this._profiles.set(profile.id, profile);
    this.error = null;
    this.moderation = null;
    this._setState('loading');
    this._setStatus('connecting');
    this.outbox = await this._loadOutbox();
    if (gen !== this._gen) return;
    try {
      await this._syncAll();
    } catch (raw) {
      if (gen !== this._gen) return;
      const err = raw instanceof SocialError || !raw || typeof raw !== 'object' || !('code' in raw) ? raw : new SocialError(raw);
      this.error = this._userError(err);
      const missing = err instanceof SocialError && err.missingSchema;
      this._setState(missing ? 'missingSchema' : 'error');
      this._setStatus('offline');
      if (!missing) console.warn('[social] no se pudo cargar', err?.message || err);
      this.emit('ready', { state: this.state });
      if (!missing) this._scheduleRetry(gen);
      return;
    }
    if (gen !== this._gen) return;
    this._retries = 0;
    this._setState('ready');
    this._subscribe(gen);
    this._timers.push(setInterval(() => this._beat(), HEARTBEAT_MS));
    this._timers.push(setInterval(() => this._resync('timer'), RESYNC_MS));
    this._timers.push(setInterval(() => this._tick(), 15_000));
    this._timers.push(setInterval(() => this._flushOutbox(), 20_000));
    this._beat();
    this._flushOutbox();
    this._loadModeration(gen);
    this.emit('ready', { state: 'ready' });
  }

  // Silencio o baneo de la cuenta (rpc my_moderation de 0012): Mensajes lo avisa antes de que el usuario escriba.
  // Sin la migracion 0012 (o sin red) no hay aviso previo: el servidor igual rechaza con user_muted / user_banned.
  async _loadModeration(gen = this._gen) {
    const backend = this._backend;
    if (!backend || typeof backend.myModeration !== 'function') return;
    let raw;
    try {
      raw = await backend.myModeration();
    } catch (err) {
      if (!(err instanceof SocialError && (err.missingSchema || err.network))) console.warn('[social] moderacion', err?.message || err);
      return;
    }
    if (gen !== this._gen) return;
    const m = Array.isArray(raw) ? raw[0] : raw;
    const next = m && typeof m === 'object' ? { muted: Boolean(m.muted), mutedUntil: m.mutedUntil || m.muted_until || null, banned: Boolean(m.banned), bannedUntil: m.bannedUntil || m.banned_until || null } : null;
    if (JSON.stringify(next) === JSON.stringify(this.moderation)) return;
    this.moderation = next;
    this.emit('moderation', next);
  }

  _scheduleRetry(gen) {
    const delay = Math.min(120_000, 5000 * 2 ** Math.min(this._retries++, 5));
    const timer = setTimeout(() => {
      if (gen === this._gen && this.state === 'error') this._start(this._backend, this.me, gen);
    }, delay);
    this._timers.push(timer);
  }

  async _teardown() {
    for (const timer of this._timers) {
      clearInterval(timer);
      clearTimeout(timer);
    }
    this._timers = [];
    clearTimeout(this._presenceTimer);
    clearTimeout(this._friendsTimer);
    clearTimeout(this._saveTimer);
    const sub = this._sub;
    const backend = this._backend;
    const wasReady = this.state === 'ready';
    this._sub = null;
    this._backend = null;
    this._channels = {};
    if (backend && wasReady && cloud.isSignedIn()) backend.heartbeat('offline', null).catch(() => {});
    if (sub) await sub.close().catch(() => {});
    this.userId = null;
    this.me = null;
    this.friends = [];
    this.requests = { incoming: [], outgoing: [] };
    this.blocked = [];
    this.activeChat = null;
    this.outbox = [];
    this.typing.clear();
    this._chats.clear();
    this._friendships.clear();
    this._profiles.clear();
    this._activity.clear();
    this._presenceKeys.clear();
    this._reactionIndex.clear();
    this._typingSent.clear();
    this._lastBeatKey = null;
    this._requestsKey = '';
    this._signalsOk = true;
    this._resyncing = false;
    this._flushing = false;
    this._setStatus('offline');
  }

  // ---------- Sincronizacion completa ----------
  async _syncAll() {
    const b = this._backend;
    const gen = this._gen;
    const me = this.userId;
    const [rows, convs] = await Promise.all([b.friendships(), b.conversations()]);
    if (gen !== this._gen) return false;
    const other = (r) => (r.requester === me ? r.addressee : r.requester);
    const friendIds = rows.filter((r) => r.status === 'accepted').map(other);
    const ids = new Set([...rows.map(other), ...convs.map((c) => c.other_user)]);
    if (!this.me) ids.add(me);
    ids.delete(null);
    ids.delete(undefined);
    const [profiles, acts] = await Promise.all([b.profiles([...ids]), b.activities(friendIds)]);
    if (gen !== this._gen) return false;

    for (const p of profiles) this._profiles.set(p.id, p);
    if (!this.me && this._profiles.has(me)) this.me = this._profiles.get(me);
    this._friendships = new Map(rows.map((r) => [r.id, r]));
    const friendSet = new Set(friendIds);
    for (const id of [...this._activity.keys()]) if (!friendSet.has(id)) this._activity.delete(id);
    for (const a of acts) this._mergeActivity(a);

    const seen = new Set();
    for (const c of convs) {
      const chat = this._ensureChat(c.conv_id, c.other_user);
      seen.add(chat.id);
      chat.createdAt = c.conv_created_at;
      chat.myLastRead = c.my_last_read_at;
      chat.otherLastRead = c.other_last_read_at;
      chat.unread = this._isViewing(chat.id) ? 0 : Number(c.unread_count) || 0;
      const server = c.last_id ? { id: c.last_id, senderId: c.last_sender, body: c.last_deleted ? '' : String(c.last_body || ''), deleted: Boolean(c.last_deleted), at: c.last_created_at, local: false } : null;
      const pending = this.outbox.filter((o) => o.chatId === chat.id).at(-1);
      chat.lastMessage = pending && (!server || pending.createdAt > ts(server.at)) ? summary(this._outboxMessage(pending)) : server;
      chat.lastMessageAt = chat.lastMessage?.at || c.conv_last_message_at || null;
    }
    for (const [id] of this._chats) if (!seen.has(id) && !this.outbox.some((o) => o.chatId === id)) this._chats.delete(id);

    this._lastSync = Date.now();
    this._rebuildFriends();
    this._presenceDiff();
    this._emitFriendsSoon(true);
    this._recountUnread(true);
    this._sub?.setPresenceFilter(friendIds);
    if (this.activeUser && !this.activeChat) this.activeChat = this._chatFor(this.activeUser)?.id || null;
    if (this.activeChat && this._isViewing(this.activeChat)) this.markRead(this.activeChat);
    return true;
  }

  async _resync(reason) {
    if (!this._backend || this.state !== 'ready' || this._resyncing) return;
    this._resyncing = true;
    const gen = this._gen;
    try {
      await this._syncAll();
      this._loadModeration(gen);
      for (const chat of this._chats.values()) {
        if (gen !== this._gen) break;
        if (chat.loaded) await this._catchUp(chat);
      }
    } catch (err) {
      if (gen !== this._gen) return;
      if (err instanceof SocialError && err.network) this._setStatus('offline');
      else console.warn('[social] resync', reason, err?.message || err);
    } finally {
      this._resyncing = false;
    }
  }

  // Trae lo ultimo de una conversacion abierta y lo une con lo que ya estaba (eventos perdidos sin conexion).
  async _catchUp(chat) {
    const rows = (await this._backend.messages(chat.id, { limit: PAGE })).reverse();
    const known = chat.messages.filter((m) => !m._local);
    const newest = known.at(-1);
    if (rows.length >= PAGE && newest && ts(rows[0].created_at) > ts(newest.created_at)) {
      // hubo un hueco: se empieza de nuevo desde lo ultimo
      chat.messages = chat.messages.filter((m) => m._local);
      chat.byId = new Map(chat.messages.map((m) => [m.id, m]));
      chat.hasMore = true;
    }
    for (const r of rows) this._upsertMessage(chat, r, false);
    this._sortChat(chat);
    await this._loadReactions(chat, rows.map((r) => r.id), true);
    this.emit('chat', { chatId: chat.id, kind: 'loaded' });
  }

  // ---------- Tiempo real ----------
  _subscribe(gen) {
    this._sub = this._backend.subscribe({
      onStatus: (name, status, err) => this._onChannelStatus(gen, name, status, err),
      onMessage: (ev, row) => gen === this._gen && this._onMessageRow(ev, row),
      onReaction: (ev, row) => gen === this._gen && this._onReactionRow(ev, row),
      onMember: (ev, row) => gen === this._gen && this._onMemberRow(ev, row),
      onFriendship: (ev, row, old) => gen === this._gen && this._onFriendshipRow(ev, row, old),
      onActivity: (row) => gen === this._gen && this._onActivityRow(row),
      onSignal: (payload) => gen === this._gen && this._onSignal(payload),
    });
    this._sub.setPresenceFilter(this.friends.map((f) => f.id));
  }

  _onChannelStatus(gen, name, status, err) {
    if (gen !== this._gen) return;
    const prev = this._channels[name];
    this._channels[name] = status;
    if (name === 'db') {
      if (status === 'SUBSCRIBED') {
        this._dbDownSince = 0;
        this._setStatus('online');
        if (prev && prev !== 'SUBSCRIBED') this._resync('reconnect');
        this._flushOutbox();
      } else {
        this._setStatus(navigator.onLine ? 'connecting' : 'offline');
        if ((status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') && !this._dbWarned) {
          this._dbWarned = true;
          console.warn('[social] tiempo real sin conexion', status, err?.message || '');
        }
      }
    } else if (name === 'inbox' && status === 'CHANNEL_ERROR' && !this._inboxWarned) {
      this._inboxWarned = true;
      console.warn('[social] buzon privado no disponible (revisá la migracion 0002)', err?.message || '');
    }
  }

  async _resubscribe() {
    const gen = this._gen;
    const old = this._sub;
    this._sub = null;
    this._channels = {};
    await old?.close().catch(() => {});
    if (gen !== this._gen || this.state !== 'ready') return;
    this._subscribe(gen);
    this._resync('resubscribe');
  }

  _watchdog() {
    if (!this._sub || this.state !== 'ready') return;
    if (this._channels.db === 'SUBSCRIBED') {
      this._dbDownSince = 0;
      return;
    }
    if (!this._dbDownSince) this._dbDownSince = Date.now();
    else if (Date.now() - this._dbDownSince > 120_000 && navigator.onLine) {
      this._dbDownSince = 0;
      this._resubscribe();
    }
  }

  _onMessageRow(ev, row) {
    if (!row?.id || !row.conversation_id) return;
    const mine = row.sender_id === this.userId;
    let chat = this._chats.get(row.conversation_id);
    if (!chat) {
      chat = this._ensureChat(row.conversation_id, mine ? null : row.sender_id);
      if (mine) this._resync('newchat');
      if (this.activeUser && chat.otherId === this.activeUser) this.activeChat = chat.id;
    }
    if (ev === 'INSERT') {
      const existed = chat.byId.has(row.id) && !chat.byId.get(row.id)._local;
      this._dropOutbox(row.id);
      if (chat.loaded) this._upsertMessage(chat, row);
      if (!chat.lastMessage || ts(row.created_at) >= ts(chat.lastMessage.at) || chat.lastMessage.id === row.id) {
        chat.lastMessage = summary(row);
        chat.lastMessageAt = row.created_at;
      }
      if (!mine && !existed) {
        this._clearTyping(chat.id);
        if (this._isViewing(chat.id)) this._markReadSoon(chat.id);
        else {
          chat.unread += 1;
          this._recountUnread();
        }
        if (!row.deleted) {
          const name = this.nameOf(row.sender_id);
          this.emit('message', { chatId: chat.id, from: name, fromId: row.sender_id, text: row.body, id: row.id, message: row });
          this._notifyDesktop(chat, name, row.body);
        }
      }
      this.emit('chat', { chatId: chat.id, kind: 'insert', message: chat.byId.get(row.id) || row });
    } else {
      if (chat.loaded && chat.byId.has(row.id)) this._upsertMessage(chat, row);
      if (chat.lastMessage?.id === row.id) chat.lastMessage = summary(row);
      this.emit('chat', { chatId: chat.id, kind: 'update', message: chat.byId.get(row.id) || row });
    }
    this._rebuildFriends();
    this._emitFriendsSoon();
  }

  _onReactionRow(ev, row) {
    if (ev === 'DELETE') {
      if (row?.id) this._removeReactionById(row.id);
      return;
    }
    const chat = row?.conversation_id && this._chats.get(row.conversation_id);
    if (chat?.loaded && chat.byId.has(row.message_id)) this._addReaction(chat, row);
  }

  _onMemberRow(ev, row) {
    if (!row?.conversation_id) return;
    const chat = this._chats.get(row.conversation_id);
    if (!chat) {
      if (ev === 'INSERT') this._resync('newchat');
      return;
    }
    if (row.user_id === this.userId) {
      chat.myLastRead = row.last_read_at;
      // leido desde otro dispositivo
      if (chat.unread && chat.lastMessage && ts(row.last_read_at) >= ts(chat.lastMessage.at)) {
        chat.unread = 0;
        this._recountUnread();
        this._rebuildFriends();
        this._emitFriendsSoon();
      }
    } else if (ts(row.last_read_at) > ts(chat.otherLastRead)) {
      chat.otherLastRead = row.last_read_at;
      this.emit('chat', { chatId: chat.id, kind: 'read' });
    }
  }

  async _onFriendshipRow(ev, row, old) {
    if (ev === 'DELETE') {
      const id = old?.id;
      if (id && this._friendships.has(id)) {
        this._friendships.delete(id);
        this._afterFriendshipChange();
      }
      return;
    }
    if (!row?.id) return;
    const prev = this._friendships.get(row.id);
    this._friendships.set(row.id, row);
    const otherId = row.requester === this.userId ? row.addressee : row.requester;
    const gen = this._gen;
    try {
      const need = !this._profiles.has(otherId);
      const [profiles, acts] = await Promise.all([
        need ? this._backend.profiles([otherId]) : [],
        row.status === 'accepted' ? this._backend.activities([otherId]) : [],
      ]);
      if (gen !== this._gen) return;
      for (const p of profiles) this._profiles.set(p.id, p);
      for (const a of acts) this._mergeActivity(a);
    } catch {
      /* se completa en la proxima sincronizacion */
    }
    const name = this.nameOf(otherId);
    if (ev === 'INSERT' && row.status === 'pending' && row.addressee === this.userId) {
      toast('info', t('social.toastRequest', { name }), t('social.toastRequestText'), 7000);
    } else if (row.status === 'accepted' && prev?.status === 'pending' && row.requester === this.userId) {
      toast('good', t('social.toastAccepted', { name }), t('social.toastAcceptedText'), 6000);
    }
    this._afterFriendshipChange();
  }

  _afterFriendshipChange() {
    this._rebuildFriends();
    this._presenceDiff();
    this._emitFriendsSoon(true);
    this._recountUnread();
    this._sub?.setPresenceFilter(this.friends.map((f) => f.id));
  }

  _onActivityRow(row) {
    if (!row?.user_id || row.user_id === this.userId) return;
    if (!this._mergeActivity(row)) return;
    this._presenceDiff();
  }

  _mergeActivity(row) {
    if (!row?.user_id || row.user_id === this.userId) return false;
    const prev = this._activity.get(row.user_id);
    if (prev && ts(prev.updated_at) > ts(row.updated_at)) return false;
    this._activity.set(row.user_id, row);
    return true;
  }

  // ---------- Señales (buzon personal) ----------
  _onSignal(msg) {
    if (!msg || typeof msg !== 'object') return;
    const fromId = typeof msg.from === 'string' ? msg.from : null;
    const kind = typeof msg.kind === 'string' ? msg.kind : '';
    if (!fromId || !kind || fromId === this.userId) return;
    const payload = msg.payload && typeof msg.payload === 'object' && !Array.isArray(msg.payload) ? msg.payload : {};
    if (kind === '_typing') return this._onTyping(fromId, payload);
    if (kind.startsWith('_')) return;
    const evt = { type: kind, from: this.nameOf(fromId), fromId, profile: this._profiles.get(fromId) || null, payload, at: typeof msg.at === 'string' ? msg.at : new Date().toISOString() };
    const fns = [...(this.signalListeners.get(kind) || []), ...(this.signalListeners.get('*') || [])];
    for (const fn of fns) {
      try {
        fn(evt);
      } catch (err) {
        console.error('[social] señal', kind, err);
      }
    }
  }

  async sendSignal(userId, type, payload = {}) {
    this._requireReady();
    if (typeof type !== 'string' || !/^[A-Za-z][\w.:-]{0,39}$/.test(type)) throw new Error(t('social.err_invalid_signal'));
    if (!this.isFriend(userId)) throw new Error(t('social.err_not_friends'));
    const data = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : { value: payload ?? null };
    try {
      await this._backend.sendSignal(userId, type, data);
      return true;
    } catch (err) {
      throw this._userError(err);
    }
  }

  onSignal(type, fn) {
    const key = String(type || '*');
    if (!this.signalListeners.has(key)) this.signalListeners.set(key, new Set());
    this.signalListeners.get(key).add(fn);
    return () => this.signalListeners.get(key)?.delete(fn);
  }

  // ---------- Escribiendo... ----------
  sendTyping(chatId) {
    const chat = this._chats.get(chatId);
    if (!chat?.otherId || !this._backend || this.state !== 'ready' || !this._signalsOk) return;
    if (this._prefs().status === 'invisible') return;
    const now = Date.now();
    if (now - (this._typingSent.get(chatId) || 0) < TYPING_SEND_MS) return;
    this._typingSent.set(chatId, now);
    if (!isOnline(this._presence(chat.otherId).presence)) return;
    this._backend.sendSignal(chat.otherId, '_typing', { chat: chatId }).catch((err) => {
      if (err instanceof SocialError && (err.missingSchema || err.code === '42883')) this._signalsOk = false;
    });
  }

  _onTyping(fromId, payload) {
    let chat = typeof payload.chat === 'string' ? this._chats.get(payload.chat) : null;
    if (!chat || chat.otherId !== fromId) chat = this._chatFor(fromId);
    if (!chat) return;
    if (payload.stop) return this._clearTyping(chat.id);
    this.typing.set(chat.id, Date.now());
    this.emit('typing', { chatId: chat.id, userId: fromId, typing: true });
    this._rebuildFriends();
    this._emitFriendsSoon();
    setTimeout(() => {
      if (this.typing.has(chat.id) && !this.isTyping(chat.id)) this._clearTyping(chat.id);
    }, TYPING_SHOW_MS + 100);
  }

  _clearTyping(chatId) {
    if (!this.typing.delete(chatId)) return;
    const chat = this._chats.get(chatId);
    this.emit('typing', { chatId, userId: chat?.otherId || null, typing: false });
    this._rebuildFriends();
    this._emitFriendsSoon();
  }

  isTyping(chatId) {
    const at = this.typing.get(chatId);
    return Boolean(at && Date.now() - at < TYPING_SHOW_MS);
  }

  // ---------- Presencia ----------
  _prefs() {
    return { ...DEFAULT_PREFS, ...(store.settings?.social || {}) };
  }

  prefs() {
    return this._prefs();
  }

  async setPrefs(patch) {
    await store.setSettings({ social: { ...this._prefs(), ...patch } });
    this._presenceChanged(true);
    this.emit('profile', this.me);
  }

  setStatus(status) {
    return this.setPrefs({ status: ['online', 'away', 'busy', 'invisible'].includes(status) ? status : 'online' });
  }

  _isIdle() {
    return Date.now() - this._lastInput > IDLE_MS;
  }

  _playing() {
    for (const g of this._games.values()) if (g.state === 'running') return true;
    return false;
  }

  // Estado que ven los amigos: invisible = desconectado; ausente automatico tras 10 min sin uso (salvo jugando).
  _myStatus() {
    const p = this._prefs();
    if (p.status === 'invisible') return 'offline';
    if (p.status === 'online' && p.autoAway && this._isIdle() && !this._playing()) return 'away';
    return ['online', 'away', 'busy'].includes(p.status) ? p.status : 'online';
  }

  _myActivity() {
    if (!this._prefs().shareActivity) return null;
    let best = null;
    for (const [id, g] of this._games) {
      if (g.state !== 'running') continue;
      const since = g.activity?.since || g.startedAt || 0;
      if (!best || since > best.since) best = { id, g, since };
    }
    if (!best) return null;
    const inst = store.instances.find((i) => i.id === best.id);
    const act = best.g.activity || { type: 'menu' };
    const out = {
      type: ['menu', 'singleplayer', 'server'].includes(act.type) ? act.type : 'menu',
      instanceName: String(inst?.name || '').slice(0, 48),
      mcVersion: String(inst?.mcVersion || '').slice(0, 24),
      loader: inst ? (inst.preset === 'iris' ? 'iris' : inst.loader || 'vanilla') : '',
      since: Math.round(best.g.startedAt || Date.now()),
    };
    if (out.type === 'server') {
      const address = publicAddress(act.address);
      if (address) out.address = address;
    }
    if (out.type === 'singleplayer' && act.world) out.world = String(act.world).slice(0, 48);
    return out;
  }

  _presence(userId) {
    const row = this._activity.get(userId);
    if (!row) return { presence: 'offline', activity: null, lastSeen: null };
    const at = ts(row.updated_at);
    const age = Date.now() + this._clockOffset - at;
    if (row.status === 'offline' || age > STALE_MS) return { presence: 'offline', activity: null, lastSeen: at || null };
    return { presence: ['online', 'away', 'busy'].includes(row.status) ? row.status : 'online', activity: sanitizeActivity(row.activity), lastSeen: at };
  }

  presenceOf(userId) {
    if (userId && userId === this.userId) {
      const status = this._prefs().status === 'invisible' ? 'invisible' : this._myStatus();
      return { presence: status, activity: this._myActivity(), lastSeen: Date.now(), statusText: this.me?.status_text || '' };
    }
    return { ...this._presence(userId), statusText: this._profiles.get(userId)?.status_text || '' };
  }

  _presenceDiff() {
    let changed = false;
    for (const f of this.friends) {
      const p = this._presence(f.id);
      const key = `${p.presence}|${JSON.stringify(p.activity)}`;
      if (this._presenceKeys.get(f.id) === key) continue;
      this._presenceKeys.set(f.id, key);
      changed = true;
      this.emit('presence', { userId: f.id, presence: p.presence, activity: p.activity, lastSeen: p.lastSeen });
    }
    if (changed) {
      this._rebuildFriends();
      this._emitFriendsSoon();
    }
    return changed;
  }

  _presenceChanged(now = false) {
    clearTimeout(this._presenceTimer);
    this._presenceTimer = setTimeout(
      () => {
        this.emit('profile', this.me);
        const status = this._myStatus();
        const key = `${status}|${JSON.stringify(status === 'offline' ? null : this._myActivity())}`;
        if (key !== this._lastBeatKey) this._beat();
      },
      now ? 0 : 1200,
    );
  }

  async _beat() {
    const b = this._backend;
    if (!b || this.state !== 'ready') return;
    this._watchdog();
    const status = this._myStatus();
    const activity = status === 'offline' ? null : this._myActivity();
    const key = `${status}|${JSON.stringify(activity)}`;
    // Invisible: se avisa una sola vez (un latido periodico delataria que esta conectado).
    if (status === 'offline' && key === this._lastBeatKey) return;
    this._lastBeatKey = key;
    const t0 = Date.now();
    try {
      const at = await b.heartbeat(status, activity);
      const server = ts(at);
      if (server) this._clockOffset = server - (t0 + Date.now()) / 2;
    } catch (err) {
      this._lastBeatKey = null;
      if (err instanceof SocialError && err.network) this._setStatus('offline');
      else if (!this._beatWarned) {
        this._beatWarned = true;
        console.warn('[social] presencia', err?.message || err);
      }
    }
  }

  _tick() {
    const idle = this._isIdle();
    if (idle !== this._wasIdle) {
      this._wasIdle = idle;
      this._presenceChanged();
    }
    this._presenceDiff();
    for (const chatId of [...this.typing.keys()]) if (!this.isTyping(chatId)) this._clearTyping(chatId);
  }

  // ---------- Juego en curso (para la actividad) ----------
  async _loadGames() {
    try {
      const [status, acts] = await Promise.all([api.instances.status(), api.invoke('game:activity').catch(() => ({}))]);
      for (const [id, st] of Object.entries(status || {})) {
        this._games.set(id, { state: st.state, startedAt: st.startedAt || Date.now(), activity: acts?.[id] || null });
      }
    } catch {
      /* sin juegos en ejecucion */
    }
    this._presenceChanged();
  }

  _onGameState(id, st) {
    if (st?.state === 'running' || st?.state === 'preparing') {
      const g = this._games.get(id) || {};
      this._games.set(id, { ...g, state: st.state, startedAt: st.startedAt || g.startedAt || Date.now() });
    } else {
      this._games.delete(id);
    }
    this._presenceChanged();
  }

  _onGameActivity(id, act) {
    const g = this._games.get(id);
    if (!act) {
      if (g) g.activity = null;
    } else {
      this._games.set(id, { state: g?.state || 'running', startedAt: g?.startedAt || Date.now(), activity: act });
    }
    this._presenceChanged();
  }

  _onInput() {
    const wasIdle = this._isIdle();
    this._lastInput = Date.now();
    if (wasIdle) {
      this._wasIdle = false;
      this._presenceChanged();
    }
  }

  _onFocus() {
    this._onInput();
    if (this.activeChat) this.markRead(this.activeChat);
    if (this.state === 'ready' && Date.now() - this._lastSync > 60_000) this._resync('focus');
  }

  _onNetwork(online) {
    if (!online) {
      this._setStatus('offline');
      return;
    }
    if (this.state === 'error') {
      this.retry();
      return;
    }
    if (this.state !== 'ready') return;
    this._setStatus(this._channels.db === 'SUBSCRIBED' ? 'online' : 'connecting');
    this._resync('online');
    this._flushOutbox();
    this._beat();
  }

  // ---------- Amigos ----------
  _rebuildFriends() {
    const me = this.userId;
    const friends = [];
    const incoming = [];
    const outgoing = [];
    const blocked = [];
    for (const r of this._friendships.values()) {
      const otherId = r.requester === me ? r.addressee : r.requester;
      const profile = this._profiles.get(otherId) || { id: otherId, username: '' };
      if (r.status === 'accepted') friends.push(this._friendEntry(otherId, r, profile));
      else {
        const entry = { id: otherId, userId: otherId, friendshipId: r.id, profile, name: displayName(profile) || t('social.someone'), at: r.created_at };
        if (r.status === 'pending') (r.requester === me ? outgoing : incoming).push(entry);
        else if (r.status === 'blocked' && r.requester === me) blocked.push(entry);
      }
    }
    friends.sort((a, b) => {
      const ga = isOnline(a.presence) ? 0 : 1;
      const gb = isOnline(b.presence) ? 0 : 1;
      if (ga !== gb) return ga - gb;
      const d = ts(b.lastAt) - ts(a.lastAt);
      return d || a.name.localeCompare(b.name);
    });
    const byDate = (a, b) => ts(b.at) - ts(a.at);
    this.friends = friends;
    this.requests = { incoming: incoming.sort(byDate), outgoing: outgoing.sort(byDate) };
    this.blocked = blocked;
    const reqKey = [...incoming, ...outgoing].map((r) => r.friendshipId).join(',');
    if (reqKey !== this._requestsKey) {
      this._requestsKey = reqKey;
      this.emit('requests', this.requests);
      this._recountUnread();
    }
  }

  _friendEntry(userId, row, profile) {
    const p = this._presence(userId);
    const chat = this._chatFor(userId);
    return {
      id: userId,
      userId,
      friendshipId: row.id,
      since: row.updated_at || row.created_at,
      profile,
      name: displayName(profile) || t('social.someone'),
      presence: p.presence,
      activity: p.activity,
      lastSeen: p.lastSeen,
      statusText: profile.status_text || '',
      chatId: chat?.id || null,
      unread: chat?.unread || 0,
      lastMessage: chat?.lastMessage || null,
      lastAt: chat?.lastMessage?.at || chat?.lastMessageAt || null,
      typing: chat ? this.isTyping(chat.id) : false,
    };
  }

  _emitFriendsSoon(now = false) {
    clearTimeout(this._friendsTimer);
    if (now) this.emit('friends', this.friends);
    else this._friendsTimer = setTimeout(() => this.emit('friends', this.friends), 30);
  }

  friendById(userId) {
    return this.friends.find((f) => f.id === userId) || null;
  }

  isFriend(userId) {
    return this.friends.some((f) => f.id === userId);
  }

  profileOf(userId) {
    if (userId && userId === this.userId) return this.me;
    return this._profiles.get(userId) || null;
  }

  nameOf(userId) {
    if (userId && userId === this.userId) return displayName(this.me) || t('social.you');
    return displayName(this._profiles.get(userId)) || t('social.someone');
  }

  _requireReady() {
    if (this.state !== 'ready' || !this._backend) throw new Error(t('common.requiresCloud'));
  }

  async _friendAction(run) {
    this._requireReady();
    let out;
    try {
      out = await run(this._backend);
    } catch (err) {
      throw this._userError(err);
    }
    await this._syncAll().catch((err) => console.warn('[social] amigos', err?.message || err));
    return out;
  }

  // Codigo VENUS-XXXXXX o nombre de usuario. Devuelve { result: 'sent' | 'accepted' | 'already_sent' | 'already_friends', user_id }.
  addFriend(query) {
    const q = String(query || '').trim();
    if (!CODE_RE.test(q) && !USER_RE.test(q)) return Promise.reject(new Error(t('social.err_invalid_query')));
    const myCode = this.me?.friend_code || '';
    if (myCode && q.replace(/-/g, '').toUpperCase() === myCode.replace(/-/g, '').toUpperCase()) return Promise.reject(new Error(t('social.err_cannot_add_self')));
    return this._friendAction((b) => b.sendFriendRequest(q));
  }

  acceptRequest(userId) {
    return this._friendAction((b) => b.respondRequest(userId, true));
  }

  declineRequest(userId) {
    return this._friendAction((b) => b.respondRequest(userId, false));
  }

  cancelRequest(userId) {
    return this._friendAction((b) => b.removeFriend(userId));
  }

  removeFriend(userId) {
    return this._friendAction((b) => b.removeFriend(userId));
  }

  blockUser(userId) {
    return this._friendAction((b) => b.block(userId));
  }

  unblockUser(userId) {
    return this._friendAction((b) => b.unblock(userId));
  }

  // ---------- Perfil propio ----------
  async updateProfile(patch) {
    this._requireReady();
    try {
      const p = this._mock ? await this._backend.updateProfile(patch) : await cloud.updateProfile(patch);
      this.me = p;
      this._profiles.set(p.id, p);
      this.emit('profile', p);
      return p;
    } catch (err) {
      throw this._userError(err instanceof SocialError ? err : new SocialError(err));
    }
  }

  // ---------- Conversaciones ----------
  _ensureChat(id, otherId) {
    let chat = this._chats.get(id);
    if (!chat) {
      chat = {
        id,
        otherId: otherId || null,
        messages: [],
        byId: new Map(),
        extra: new Map(), // mensajes citados que no estan cargados
        reactions: new Map(),
        loaded: false,
        loading: null,
        loadingOlder: false,
        hasMore: true,
        unread: 0,
        myLastRead: null,
        otherLastRead: null,
        lastMessage: null,
        lastMessageAt: null,
        createdAt: null,
      };
      this._chats.set(id, chat);
    } else if (otherId && !chat.otherId) chat.otherId = otherId;
    return chat;
  }

  _chatFor(userId) {
    if (!userId) return null;
    for (const c of this._chats.values()) if (c.otherId === userId) return c;
    return null;
  }

  chat(chatId) {
    return this._chats.get(chatId) || null;
  }

  chatIdFor(userId) {
    return this._chatFor(userId)?.id || null;
  }

  // Crea (si hace falta) la conversacion con un amigo y devuelve su id.
  async ensureChat(userId) {
    const existing = this._chatFor(userId);
    if (existing) return existing.id;
    this._requireReady();
    let id;
    try {
      id = await this._backend.getOrCreateConversation(userId);
    } catch (err) {
      throw this._userError(err);
    }
    const chat = this._ensureChat(id, userId);
    chat.createdAt = chat.createdAt || new Date().toISOString();
    if (this.activeUser === userId) this.activeChat = id;
    this._rebuildFriends();
    this._emitFriendsSoon();
    return id;
  }

  // Contrato: abre la pagina de Mensajes con ese amigo.
  async openChat(userId) {
    if (!userId) return null;
    let chatId = this.chatIdFor(userId);
    if (!chatId && this.state === 'ready' && this.isFriend(userId)) chatId = await this.ensureChat(userId).catch(() => null);
    const route = `messages/${encodeURIComponent(userId)}`;
    try {
      const { navigate } = await import('./app.js');
      navigate(route);
    } catch {
      location.hash = `#/${route}`;
    }
    return chatId;
  }

  // La pagina de Mensajes avisa que chat se esta mirando (null al salir).
  setActive(userId) {
    this.activeUser = userId || null;
    this.activeChat = userId ? this._chatFor(userId)?.id || null : null;
    if (this.activeChat) this.markRead(this.activeChat);
  }

  _isViewing(chatId) {
    return Boolean(chatId && this.activeChat === chatId && location.hash.startsWith('#/messages') && document.hasFocus() && !document.hidden);
  }

  async loadMessages(chatId) {
    const chat = this._chats.get(chatId);
    if (!chat) return null;
    if (chat.loaded) return chat;
    if (chat.loading) return chat.loading;
    this._requireReady();
    chat.loading = (async () => {
      const rows = (await this._backend.messages(chatId, { limit: PAGE })).reverse();
      for (const r of rows) this._upsertMessage(chat, r, false);
      chat.hasMore = rows.length >= PAGE;
      for (const o of this.outbox) if (o.chatId === chatId) this._upsertMessage(chat, this._outboxMessage(o), false);
      this._sortChat(chat);
      await this._loadReactions(chat, rows.map((r) => r.id));
      await this._loadQuoted(chat);
      chat.loaded = true;
      this.emit('chat', { chatId, kind: 'loaded' });
      return chat;
    })();
    try {
      return await chat.loading;
    } catch (err) {
      throw this._userError(err);
    } finally {
      chat.loading = null;
    }
  }

  async loadOlder(chatId) {
    const chat = this._chats.get(chatId);
    if (!chat?.loaded || !chat.hasMore || chat.loadingOlder || !this._backend) return 0;
    const oldest = chat.messages.find((m) => !m._local);
    if (!oldest) {
      chat.hasMore = false;
      return 0;
    }
    chat.loadingOlder = true;
    try {
      const rows = (await this._backend.messages(chatId, { before: oldest.created_at, limit: PAGE })).reverse();
      for (const r of rows) this._upsertMessage(chat, r, false);
      chat.hasMore = rows.length >= PAGE;
      this._sortChat(chat);
      await this._loadReactions(chat, rows.map((r) => r.id));
      await this._loadQuoted(chat);
      this.emit('chat', { chatId, kind: 'older', count: rows.length });
      return rows.length;
    } catch (err) {
      throw this._userError(err);
    } finally {
      chat.loadingOlder = false;
    }
  }

  // Mensaje citado (respuesta): cargado o traido aparte.
  quoted(chatId, messageId) {
    const chat = this._chats.get(chatId);
    if (!chat || !messageId) return null;
    return chat.byId.get(messageId) || chat.extra.get(messageId) || null;
  }

  async _loadQuoted(chat) {
    const missing = [...new Set(chat.messages.map((m) => m.reply_to).filter((id) => id && !chat.byId.has(id) && !chat.extra.has(id)))];
    if (!missing.length) return;
    const rows = await this._backend.messagesByIds(missing).catch(() => []);
    for (const r of rows) if (r.conversation_id === chat.id) chat.extra.set(r.id, r);
  }

  _upsertMessage(chat, row, sort = true) {
    const cur = chat.byId.get(row.id);
    if (cur) {
      if (row._local && !cur._local) return cur; // la copia local no pisa la del servidor
      if (!row._local) {
        delete cur._local;
        delete cur._error;
      }
      Object.assign(cur, row);
      if (sort) this._sortChat(chat);
      return cur;
    }
    const msg = { ...row };
    chat.messages.push(msg);
    chat.byId.set(msg.id, msg);
    chat.extra.delete(msg.id);
    if (sort) this._sortChat(chat);
    return msg;
  }

  _sortChat(chat) {
    chat.messages.sort((a, b) => ts(a.created_at) - ts(b.created_at) || (a.id < b.id ? -1 : 1));
  }

  // true si el otro ya leyo este mensaje (para las tildes).
  isRead(chatId, message) {
    const chat = this._chats.get(chatId);
    return Boolean(chat?.otherLastRead && message && !message._local && ts(message.created_at) <= ts(chat.otherLastRead));
  }

  markRead(chatId) {
    const chat = this._chats.get(chatId);
    if (!chat || !this._backend || this.state !== 'ready') return;
    const had = chat.unread;
    if (had) {
      chat.unread = 0;
      this._recountUnread();
      this._rebuildFriends();
      this._emitFriendsSoon();
    }
    const last = chat.lastMessage;
    const behind = last && last.senderId !== this.userId && !last.local && ts(last.at) > ts(chat.myLastRead);
    if (!had && !behind) return;
    chat.myLastRead = new Date(Date.now() + this._clockOffset).toISOString();
    this._backend
      .markRead(chatId)
      .then((at) => {
        if (at) chat.myLastRead = at;
      })
      .catch(() => {});
  }

  _markReadSoon(chatId) {
    clearTimeout(this._readTimer);
    this._readTimer = setTimeout(() => this.markRead(chatId), 400);
  }

  _recountUnread(force = false) {
    let n = 0;
    for (const c of this._chats.values()) n += c.unread || 0;
    const total = n + this.requests.incoming.length;
    if (!force && n === this.unreadMessages && total === this.unreadTotal) return;
    this.unreadMessages = n;
    this.unreadTotal = total;
    this.emit('unread', total);
  }

  // ---------- Enviar, editar, borrar ----------
  async sendMessage(chatId, text, opts = {}) {
    const body = String(text ?? '')
      .replace(/\r\n?/g, '\n')
      .trim();
    if (!body) return null;
    if (body.length > MAX_MESSAGE) throw new Error(t('social.errTooLong', { max: MAX_MESSAGE }));
    this._requireReady();
    const chat = this._chats.get(chatId);
    if (!chat) throw new Error(t('social.err_conversation_not_found'));
    const replyTo = opts.replyTo && chat.byId.has(opts.replyTo) && !chat.byId.get(opts.replyTo)._local ? opts.replyTo : null;
    const item = { id: crypto.randomUUID(), chatId, body, replyTo, createdAt: Date.now(), state: 'pending', attempts: 0, error: null };
    this.outbox.push(item);
    this._saveOutbox();
    const msg = this._outboxMessage(item);
    if (chat.loaded) this._upsertMessage(chat, msg);
    chat.lastMessage = summary(msg);
    chat.lastMessageAt = msg.created_at;
    this._typingSent.delete(chatId);
    this.emit('chat', { chatId, kind: 'insert', message: chat.byId.get(msg.id) || msg });
    this.emit('outbox', this.outbox.length);
    this._rebuildFriends();
    this._emitFriendsSoon();
    this._flushOutbox();
    return msg;
  }

  _outboxMessage(o) {
    return {
      id: o.id,
      conversation_id: o.chatId,
      sender_id: this.userId,
      body: o.body,
      reply_to: o.replyTo || null,
      created_at: new Date(o.createdAt).toISOString(),
      edited_at: null,
      deleted: false,
      _local: o.state === 'failed' ? 'failed' : 'pending',
      _error: o.error || null,
    };
  }

  async _flushOutbox() {
    if (this._flushing || !this._backend || this.state !== 'ready' || !this.outbox.length || !navigator.onLine) return;
    this._flushing = true;
    const gen = this._gen;
    try {
      for (const item of [...this.outbox]) {
        if (gen !== this._gen) return;
        if (item.state === 'failed' || !this.outbox.includes(item)) continue;
        item.state = 'sending';
        item.attempts += 1;
        try {
          const row = await this._backend.insertMessage({ id: item.id, conversation_id: item.chatId, sender_id: this.userId, body: item.body, reply_to: item.replyTo || null });
          this._resolveOutbox(item, row);
        } catch (err) {
          const e = err instanceof SocialError ? err : new SocialError(err);
          if (e.code === '23505') {
            // ya se habia guardado en un intento anterior
            const [row] = await this._backend.messagesByIds([item.id]).catch(() => []);
            if (row) {
              this._resolveOutbox(item, row);
              continue;
            }
          }
          if (e.retryable) {
            item.state = 'pending';
            if (e.network) this._setStatus('offline');
            break; // se reintenta despues, respetando el orden
          }
          item.state = 'failed';
          item.error = this._userError(e).message;
          this._refreshOutboxMessage(item);
          if (e.code === '42501') this._resync('friends'); // ya no son amigos: actualizar la lista
        }
      }
    } finally {
      this._flushing = false;
      this._saveOutbox();
    }
  }

  _resolveOutbox(item, row) {
    this.outbox = this.outbox.filter((o) => o !== item);
    const chat = this._chats.get(item.chatId);
    if (chat && row) {
      if (chat.loaded) this._upsertMessage(chat, row);
      if (!chat.lastMessage || chat.lastMessage.id === row.id || ts(row.created_at) >= ts(chat.lastMessage.at)) {
        chat.lastMessage = summary(row);
        chat.lastMessageAt = row.created_at;
      }
      this.emit('chat', { chatId: chat.id, kind: 'update', message: chat.byId.get(row.id) || row });
    }
    this.emit('outbox', this.outbox.length);
    this._rebuildFriends();
    this._emitFriendsSoon();
  }

  _refreshOutboxMessage(item) {
    const chat = this._chats.get(item.chatId);
    if (!chat) return;
    const msg = chat.byId.get(item.id);
    if (msg?._local) {
      msg._local = item.state === 'failed' ? 'failed' : 'pending';
      msg._error = item.error || null;
      this.emit('chat', { chatId: chat.id, kind: 'update', message: msg });
    }
    this.emit('outbox', this.outbox.length);
  }

  _dropOutbox(id) {
    const before = this.outbox.length;
    this.outbox = this.outbox.filter((o) => o.id !== id);
    if (this.outbox.length !== before) {
      this._saveOutbox();
      this.emit('outbox', this.outbox.length);
    }
  }

  retryMessage(messageId) {
    const item = this.outbox.find((o) => o.id === messageId);
    if (!item) return;
    item.state = 'pending';
    item.error = null;
    this._refreshOutboxMessage(item);
    this._flushOutbox();
  }

  discardMessage(chatId, messageId) {
    this._dropOutbox(messageId);
    const chat = this._chats.get(chatId);
    if (!chat) return;
    const msg = chat.byId.get(messageId);
    if (!msg?._local) return;
    chat.byId.delete(messageId);
    chat.messages = chat.messages.filter((m) => m.id !== messageId);
    const last = chat.messages.at(-1);
    chat.lastMessage = summary(last);
    chat.lastMessageAt = last?.created_at || chat.lastMessageAt;
    this.emit('chat', { chatId, kind: 'remove', messageId });
    this._rebuildFriends();
    this._emitFriendsSoon();
  }

  async editMessage(chatId, messageId, text) {
    const chat = this._chats.get(chatId);
    const msg = chat?.byId.get(messageId);
    if (!msg || msg.sender_id !== this.userId || msg.deleted) return;
    const body = String(text ?? '')
      .replace(/\r\n?/g, '\n')
      .trim();
    if (!body) return this.deleteMessage(chatId, messageId);
    if (body.length > MAX_MESSAGE) throw new Error(t('social.errTooLong', { max: MAX_MESSAGE }));
    if (body === msg.body) return;
    if (msg._local) {
      // todavia esta en la cola: se cambia antes de enviarlo
      const item = this.outbox.find((o) => o.id === messageId);
      if (item && item.state !== 'sending') {
        item.body = body;
        msg.body = body;
        this._saveOutbox();
        this.emit('chat', { chatId, kind: 'update', message: msg });
      }
      return;
    }
    this._requireReady();
    const before = { body: msg.body, edited_at: msg.edited_at };
    msg.body = body;
    msg.edited_at = new Date().toISOString();
    this.emit('chat', { chatId, kind: 'update', message: msg });
    try {
      const row = await this._backend.editMessage(messageId, body);
      if (row) this._upsertMessage(chat, row);
      if (chat.lastMessage?.id === messageId) chat.lastMessage = summary(msg);
      this.emit('chat', { chatId, kind: 'update', message: msg });
    } catch (err) {
      Object.assign(msg, before);
      this.emit('chat', { chatId, kind: 'update', message: msg });
      throw this._userError(err);
    }
  }

  async deleteMessage(chatId, messageId) {
    const chat = this._chats.get(chatId);
    const msg = chat?.byId.get(messageId);
    if (!msg || msg.sender_id !== this.userId || msg.deleted) return;
    if (msg._local) return this.discardMessage(chatId, messageId);
    this._requireReady();
    const before = { body: msg.body, deleted: msg.deleted, edited_at: msg.edited_at };
    Object.assign(msg, { body: '', deleted: true });
    this.emit('chat', { chatId, kind: 'update', message: msg });
    try {
      const row = await this._backend.deleteMessage(messageId);
      if (row) this._upsertMessage(chat, row);
      if (chat.lastMessage?.id === messageId) chat.lastMessage = summary(msg);
      this.emit('chat', { chatId, kind: 'update', message: msg });
      this._rebuildFriends();
      this._emitFriendsSoon();
    } catch (err) {
      Object.assign(msg, before);
      this.emit('chat', { chatId, kind: 'update', message: msg });
      throw this._userError(err);
    }
  }

  // ---------- Reacciones ----------
  async _loadReactions(chat, ids, replace = false) {
    if (!ids.length) return;
    const rows = await this._backend.reactions(ids).catch(() => null);
    if (!rows) return;
    if (replace) {
      for (const id of ids) {
        for (const r of chat.reactions.get(id) || []) if (!r._local) this._reactionIndex.delete(r.id);
        chat.reactions.set(id, (chat.reactions.get(id) || []).filter((r) => r._local));
      }
    }
    for (const r of rows) this._addReaction(chat, r, false);
  }

  _addReaction(chat, row, emit = true) {
    if (!row?.id || !row.message_id) return false;
    const list = chat.reactions.get(row.message_id) || [];
    if (list.some((r) => r.id === row.id)) return false;
    const i = list.findIndex((r) => r._local && r.user_id === row.user_id && r.emoji === row.emoji);
    if (i >= 0) {
      this._reactionIndex.delete(list[i].id);
      list.splice(i, 1);
    }
    list.push({ id: row.id, message_id: row.message_id, user_id: row.user_id, emoji: String(row.emoji || '').slice(0, 16), created_at: row.created_at, _local: row._local || undefined });
    chat.reactions.set(row.message_id, list);
    this._reactionIndex.set(row.id, { chatId: chat.id, messageId: row.message_id });
    if (emit) this.emit('chat', { chatId: chat.id, kind: 'reaction', messageId: row.message_id });
    return true;
  }

  _removeReactionById(id) {
    const ref = this._reactionIndex.get(id);
    if (!ref) return;
    this._reactionIndex.delete(id);
    const chat = this._chats.get(ref.chatId);
    if (!chat) return;
    chat.reactions.set(
      ref.messageId,
      (chat.reactions.get(ref.messageId) || []).filter((r) => r.id !== id),
    );
    this.emit('chat', { chatId: chat.id, kind: 'reaction', messageId: ref.messageId });
  }

  // [{ emoji, count, mine, names }] en orden de aparicion.
  reactionsOf(chatId, messageId) {
    const list = this._chats.get(chatId)?.reactions.get(messageId) || [];
    const groups = new Map();
    for (const r of list) {
      const g = groups.get(r.emoji) || { emoji: r.emoji, count: 0, mine: false, names: [] };
      g.count += 1;
      if (r.user_id === this.userId) g.mine = true;
      g.names.push(this.nameOf(r.user_id));
      groups.set(r.emoji, g);
    }
    return [...groups.values()];
  }

  async toggleReaction(chatId, messageId, emoji) {
    const chat = this._chats.get(chatId);
    const msg = chat?.byId.get(messageId);
    if (!msg || msg._local || msg.deleted) return;
    this._requireReady();
    const list = chat.reactions.get(messageId) || [];
    const mine = list.find((r) => r.user_id === this.userId && r.emoji === emoji);
    if (mine) {
      if (mine._local) return;
      this._removeReactionById(mine.id);
      try {
        await this._backend.removeReaction(mine.id);
      } catch (err) {
        this._addReaction(chat, mine);
        throw this._userError(err);
      }
      return;
    }
    const temp = { id: `tmp-${crypto.randomUUID()}`, message_id: messageId, user_id: this.userId, emoji, _local: true };
    this._addReaction(chat, temp);
    try {
      const row = await this._backend.addReaction(messageId, chatId, emoji);
      this._addReaction(chat, row);
    } catch (err) {
      this._removeReactionById(temp.id);
      const e = err instanceof SocialError ? err : new SocialError(err);
      if (e.code !== '23505') throw this._userError(e);
    }
  }

  // ---------- Cola de salida (cifrada en el almacen seguro) ----------
  _outboxKey() {
    return `social.outbox.${this.userId}`;
  }

  async _loadOutbox() {
    if (this._mock || !this.userId) return [];
    try {
      const raw = await api.invoke('secure:get', this._outboxKey());
      if (!Array.isArray(raw)) return [];
      return raw
        .filter((o) => o && typeof o.id === 'string' && typeof o.chatId === 'string' && typeof o.body === 'string' && o.body.length <= MAX_MESSAGE)
        .slice(0, 200)
        .map((o) => ({ id: o.id, chatId: o.chatId, body: o.body, replyTo: o.replyTo || null, createdAt: Number(o.createdAt) || Date.now(), state: o.state === 'failed' ? 'failed' : 'pending', attempts: Number(o.attempts) || 0, error: o.error || null }));
    } catch {
      return [];
    }
  }

  _saveOutbox() {
    if (this._mock || !this.userId) return;
    clearTimeout(this._saveTimer);
    const key = this._outboxKey();
    const data = this.outbox.map(({ id, chatId, body, replyTo, createdAt, state, attempts, error }) => ({ id, chatId, body, replyTo, createdAt, state: state === 'sending' ? 'pending' : state, attempts, error }));
    this._saveTimer = setTimeout(() => {
      api.invoke('secure:set', key, data.length ? data : null).catch(() => {});
    }, 300);
  }

  // ---------- Avisos ----------
  _notifyDesktop(chat, name, text) {
    const p = this._prefs();
    if (!p.notifications || p.status === 'busy') return;
    if (document.hasFocus() && !document.hidden) return; // adentro de la app ya se ve el aviso
    try {
      if (typeof Notification === 'undefined' || Notification.permission === 'denied') return;
      const n = new Notification(t('common.messageFrom', { name }), { body: String(text || '').slice(0, 180), icon: 'assets/logo-64.png', tag: `venus-dm-${chat.id}` });
      n.onclick = () => {
        window.focus();
        if (chat.otherId) location.hash = `#/messages/${encodeURIComponent(chat.otherId)}`;
      };
    } catch {
      /* notificaciones no disponibles */
    }
  }

  // Error de Supabase -> mensaje para el usuario (ya traducido).
  _userError(input) {
    const coded = input && typeof input === 'object' && ('code' in input || 'status' in input);
    const err = input instanceof SocialError ? input : coded ? new SocialError(input) : null;
    if (!err) return input instanceof Error ? input : new Error(String(input));
    const raw = String(err.message || '').trim();
    let msg;
    if (KNOWN_ERRORS.has(raw)) msg = t(`social.err_${raw}`);
    else if (err.missingSchema) {
      // Falta la migracion 0002_social.sql en el servidor: el detalle queda en el log
      console.warn('[social] falta el esquema social (0002_social.sql):', err.code, raw);
      msg = t('social.errService');
    }
    else if (err.network) msg = t('social.errNetwork');
    else if (err.code === '42501' || /row-level security/i.test(raw)) msg = t('social.err_not_friends');
    else if (err.code === '23505') msg = /username/i.test(`${raw} ${err.details}`) ? t('social.errUsernameTaken') : t('social.errDuplicate');
    else if (err.code === '23514' || err.code === '22001' || err.code === '22023') msg = t('social.errInvalid');
    else msg = t('social.errGeneric', { error: raw });
    // Un silencio o un baneo recien aplicado: Mensajes lo muestra enseguida
    if (raw === 'user_muted' || raw === 'user_banned') this._loadModeration();
    const out = new Error(msg);
    out.code = err.code;
    out.cause = err;
    return out;
  }
}

export const social = new Social();
