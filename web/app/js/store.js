// Estado de la app con sesión: amigos, conversaciones, mensajes y lo nuevo. Sigue la misma lógica que social.js del launcher,
// sin lo que depende de la PC y sin guardar nada en el celular: todo vive en memoria y se pide de nuevo al abrir.
//
//   store.on(evento, fn) -> off     'state', 'live', 'friends', 'chats', 'chat' ({ chatId, kind }), 'typing', 'inbox', 'moderation'
//   store.start() / store.stop()
import { ApiError } from './backend.js';
import { MAX_MESSAGE, PAGE, buildLists, cleanBody, isMissing, isOnline, lastFromConversation, presenceOf, summary, ts, upsertMessage, validFriendQuery } from './logic.js';

const RESYNC_MS = 180_000;
const TYPING_SEND_MS = 3000;
const TYPING_SHOW_MS = 6500;

export class Store {
  constructor({ backend, profile = null, someone = '', doc = globalThis.document, net = globalThis.navigator, uuid = () => crypto.randomUUID() }) {
    this.backend = backend;
    this.userId = backend.userId;
    this.me = profile;
    this.someone = someone;
    this.doc = doc;
    this.net = net;
    this.uuid = uuid;
    this.listeners = new Map();
    this.state = 'idle'; // idle | loading | ready | error
    this.live = 'offline'; // offline | connecting | online
    this.friends = [];
    this.incoming = [];
    this.outgoing = [];
    this.inbox = { messages: [], requests: [], clips: [] };
    this.inboxAvailable = true; // sin 0035 la bandeja se arma con lo que hay y no hay clips recibidos
    this.moderation = null;
    this.activeUser = null;
    this.typing = new Map();
    this.clockOffset = 0;
    this._friendships = new Map();
    this._profiles = new Map();
    this._activity = new Map();
    this._chats = new Map();
    this._channels = {};
    this._timers = [];
    this._queue = [];
    this._typingSent = new Map();
    this._stickers = new Map();
    this._stickerWaiters = new Map();
    this._stickersOk = true;
    this._gen = 0;
    if (profile) this._profiles.set(profile.id, profile);
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
        console.error('[app]', evt, err);
      }
    }
  }

  _setState(state) {
    if (this.state !== state) {
      this.state = state;
      this.emit('state', state);
    }
  }

  _setLive(live) {
    if (this.live !== live) {
      this.live = live;
      this.emit('live', live);
    }
  }

  now() {
    return Date.now() + this.clockOffset;
  }

  // ---------- Arranque ----------
  async start() {
    const gen = ++this._gen;
    this._setState('loading');
    this._setLive('connecting');
    try {
      await this._syncAll();
    } catch (err) {
      if (gen !== this._gen) return;
      console.warn('[app] no se pudo cargar', err?.message || err);
      this.error = err;
      this._setState('error');
      this._setLive('offline');
      return;
    }
    if (gen !== this._gen) return;
    this._setState('ready');
    this._subscribe(gen);
    this._timers.push(setInterval(() => this.resync('timer'), RESYNC_MS));
    this._timers.push(setInterval(() => this._tick(), 15_000));
    this._timers.push(setInterval(() => this._flush(), 20_000));
    this._loadModeration(gen);
    this.refreshInbox();
  }

  async stop() {
    this._gen++;
    for (const timer of this._timers) {
      clearInterval(timer);
      clearTimeout(timer);
    }
    this._timers = [];
    const sub = this._sub;
    this._sub = null;
    if (sub) await sub.close().catch(() => {});
    this._setState('idle');
    this._setLive('offline');
    this.listeners.clear();
  }

  // ---------- Sincronización ----------
  async _syncAll() {
    const b = this.backend;
    const me = this.userId;
    const [rows, convs] = await Promise.all([b.friendships(), b.conversations()]);
    const other = (r) => (r.requester === me ? r.addressee : r.requester);
    const friendIds = rows.filter((r) => r.status === 'accepted').map(other);
    const ids = new Set([...rows.map(other), ...convs.map((c) => c.other_user), me]);
    ids.delete(null);
    ids.delete(undefined);
    const [profiles, acts] = await Promise.all([b.profiles([...ids]), b.activities(friendIds)]);
    for (const p of profiles) this._profiles.set(p.id, p);
    if (this._profiles.has(me)) this.me = this._profiles.get(me);
    this._friendships = new Map(rows.map((r) => [r.id, r]));
    const friendSet = new Set(friendIds);
    for (const id of [...this._activity.keys()]) if (!friendSet.has(id)) this._activity.delete(id);
    for (const a of acts) this._mergeActivity(a);

    const seen = new Set();
    for (const c of convs) {
      const chat = this._ensureChat(c.conv_id, c.other_user);
      seen.add(chat.id);
      chat.myLastRead = c.my_last_read_at;
      chat.otherLastRead = c.other_last_read_at;
      chat.unread = this._isViewing(chat.id) ? 0 : Number(c.unread_count) || 0;
      const pending = this._queue.filter((o) => o.conversation_id === chat.id).at(-1);
      const server = lastFromConversation(c);
      chat.lastMessage = pending && (!server || ts(pending.created_at) > ts(server.at)) ? summary(pending) : server;
      chat.lastMessageAt = chat.lastMessage?.at || c.conv_last_message_at || null;
    }
    for (const [id] of this._chats) if (!seen.has(id) && !this._queue.some((o) => o.conversation_id === id)) this._chats.delete(id);
    this._rebuild();
    this._sub?.setPresenceFilter(this.friends.map((f) => f.id));
    if (this.activeUser) this.markRead(this.chatIdFor(this.activeUser));
  }

  async resync(reason) {
    if (this.state !== 'ready' || this._resyncing) return;
    this._resyncing = true;
    const gen = this._gen;
    try {
      await this._syncAll();
      if (gen !== this._gen) return;
      for (const chat of this._chats.values()) if (chat.loaded) await this._catchUp(chat);
      this._loadModeration(gen);
      await this.refreshInbox();
    } catch (err) {
      if (gen !== this._gen) return;
      console.warn('[app] sincronizar', reason, err?.message || err);
      if (err instanceof ApiError && err.retryable) this._setLive('offline');
    } finally {
      this._resyncing = false;
    }
  }

  // Lo último de una conversación abierta, unido a lo que ya estaba
  async _catchUp(chat) {
    const rows = (await this.backend.messages(chat.id, { limit: PAGE })).reverse();
    const known = chat.messages.filter((m) => !m._local);
    const newest = known.at(-1);
    if (rows.length >= PAGE && newest && ts(rows[0].created_at) > ts(newest.created_at)) {
      chat.messages = chat.messages.filter((m) => m._local);
      chat.hasMore = true;
    }
    for (const r of rows) chat.messages = upsertMessage(chat.messages, r);
    this.emit('chat', { chatId: chat.id, kind: 'loaded' });
  }

  async refreshInbox() {
    if (this.state !== 'ready' && this.state !== 'loading') return;
    if (!this.inboxAvailable) return this._localInbox();
    try {
      const box = await this.backend.inbox(false);
      if (box?.at) this.clockOffset = Date.parse(box.at) - Date.now();
      this.inbox = { messages: box?.messages || [], requests: box?.requests || [], clips: box?.clips || [] };
      this.emit('inbox', this.inbox);
    } catch (err) {
      if (isMissing(err)) {
        this.inboxAvailable = false;
        this._localInbox();
      } else {
        console.warn('[app] avisos', err?.message || err);
      }
    }
  }

  // Sin la migración 0035: lo mismo con lo que ya se sabe (sin clips)
  _localInbox() {
    const messages = [...this._chats.values()]
      .filter((c) => c.unread > 0)
      .map((c) => ({ conv: c.id, userId: c.otherId, name: this.nameOf(c.otherId), unread: c.unread, at: c.lastMessage?.at || c.lastMessageAt }));
    const requests = this.incoming.map((r) => ({ userId: r.id, name: r.name, at: r.at }));
    this.inbox = { messages, requests, clips: [] };
    this.emit('inbox', this.inbox);
  }

  get badges() {
    let messages = 0;
    for (const c of this._chats.values()) messages += c.unread || 0;
    const requests = this.incoming.length;
    const clips = this.inbox.clips.length;
    return { messages, requests, clips, total: messages + requests + clips };
  }

  async _loadModeration(gen = this._gen) {
    try {
      const raw = await this.backend.myModeration();
      if (gen !== this._gen) return;
      const m = Array.isArray(raw) ? raw[0] : raw;
      const live = (flag, until) => Boolean(flag) && (!until || Date.parse(until) > Date.now());
      const next = m ? { muted: live(m.muted, m.mutedUntil || m.muted_until), banned: live(m.banned, m.bannedUntil || m.banned_until) } : null;
      if (JSON.stringify(next) !== JSON.stringify(this.moderation)) {
        this.moderation = next;
        this.emit('moderation', next);
      }
    } catch {
      /* sin aviso previo: el servidor igual rechaza con user_muted o user_banned */
    }
  }

  // ---------- Tiempo real ----------
  _subscribe(gen) {
    this._sub = this.backend.subscribe({
      onStatus: (name, status) => gen === this._gen && this._onStatus(name, status),
      onMessage: (ev, row) => gen === this._gen && this._onMessage(ev, row),
      onMember: (ev, row) => gen === this._gen && this._onMember(ev, row),
      onFriendship: (ev, row, old) => gen === this._gen && this._onFriendship(ev, row, old),
      onActivity: (row) => gen === this._gen && this._onActivity(row),
      onSignal: (payload) => gen === this._gen && this._onSignal(payload),
    });
    this._sub.setPresenceFilter(this.friends.map((f) => f.id));
  }

  _onStatus(name, status) {
    const prev = this._channels[name];
    this._channels[name] = status;
    if (name !== 'db') return;
    if (status === 'SUBSCRIBED') {
      this._setLive('online');
      if (prev && prev !== 'SUBSCRIBED') this.resync('reconnect');
      this._flush();
    } else {
      this._setLive(this.net?.onLine === false ? 'offline' : 'connecting');
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
  }

  // El celular duerme las conexiones: al volver se pone al día y, si el canal quedó caído, se rehace.
  onResume() {
    if (this.state === 'error') {
      this.start();
      return;
    }
    if (this.state !== 'ready') return;
    this.resync('resume');
    if (this.activeUser) this.markRead(this.chatIdFor(this.activeUser));
    this._flush();
    this._timers.push(setTimeout(() => {
      if (this.state === 'ready' && this._channels.db !== 'SUBSCRIBED' && this.net?.onLine !== false) this._resubscribe();
    }, 5000));
  }

  onNetwork(online) {
    if (!online) {
      this._setLive('offline');
      return;
    }
    this.onResume();
  }

  _onMessage(ev, row) {
    if (!row?.id || !row.conversation_id) return;
    const mine = row.sender_id === this.userId;
    let chat = this._chats.get(row.conversation_id);
    if (!chat) {
      chat = this._ensureChat(row.conversation_id, mine ? null : row.sender_id);
      if (mine) this.resync('newchat');
    }
    if (ev === 'INSERT') {
      const existed = chat.messages.some((m) => m.id === row.id && !m._local);
      this._queue = this._queue.filter((o) => o.id !== row.id);
      if (chat.loaded) chat.messages = upsertMessage(chat.messages, row);
      if (!chat.lastMessage || ts(row.created_at) >= ts(chat.lastMessage.at) || chat.lastMessage.id === row.id) {
        chat.lastMessage = summary(row);
        chat.lastMessageAt = row.created_at;
      }
      if (!mine && !existed) {
        this._clearTyping(chat.id);
        if (this._isViewing(chat.id)) this.markRead(chat.id);
        else chat.unread += 1;
        if (!this._profiles.has(row.sender_id)) this.resync('newchat');
        this.refreshInbox();
      }
      this.emit('chat', { chatId: chat.id, kind: 'insert', id: row.id });
    } else {
      if (chat.loaded && chat.messages.some((m) => m.id === row.id)) chat.messages = upsertMessage(chat.messages, row);
      if (chat.lastMessage?.id === row.id) chat.lastMessage = summary(row);
      this.emit('chat', { chatId: chat.id, kind: 'update', id: row.id });
    }
    this._rebuild();
  }

  _onMember(ev, row) {
    if (!row?.conversation_id) return;
    const chat = this._chats.get(row.conversation_id);
    if (!chat) {
      if (ev === 'INSERT') this.resync('newchat');
      return;
    }
    if (row.user_id === this.userId) {
      chat.myLastRead = row.last_read_at;
      // Leído desde otro dispositivo (el launcher, por ejemplo)
      if (chat.unread && chat.lastMessage && ts(row.last_read_at) >= ts(chat.lastMessage.at)) {
        chat.unread = 0;
        this._rebuild();
        this.refreshInbox();
      }
    } else if (ts(row.last_read_at) > ts(chat.otherLastRead)) {
      chat.otherLastRead = row.last_read_at;
      this.emit('chat', { chatId: chat.id, kind: 'read' });
    }
  }

  async _onFriendship(ev, row, old) {
    if (ev === 'DELETE') {
      if (old?.id && this._friendships.delete(old.id)) this._afterFriendship();
      return;
    }
    if (!row?.id) return;
    this._friendships.set(row.id, row);
    const otherId = row.requester === this.userId ? row.addressee : row.requester;
    const gen = this._gen;
    try {
      const need = !this._profiles.has(otherId);
      const [profiles, acts] = await Promise.all([need ? this.backend.profiles([otherId]) : [], row.status === 'accepted' ? this.backend.activities([otherId]) : []]);
      if (gen !== this._gen) return;
      for (const p of profiles) this._profiles.set(p.id, p);
      for (const a of acts) this._mergeActivity(a);
    } catch {
      /* se completa en la próxima sincronización */
    }
    this._afterFriendship();
  }

  _afterFriendship() {
    this._rebuild();
    this._sub?.setPresenceFilter(this.friends.map((f) => f.id));
    this.refreshInbox();
  }

  _onActivity(row) {
    if (this._mergeActivity(row)) this._rebuild();
  }

  _mergeActivity(row) {
    if (!row?.user_id || row.user_id === this.userId) return false;
    const prev = this._activity.get(row.user_id);
    if (prev && ts(prev.updated_at) > ts(row.updated_at)) return false;
    this._activity.set(row.user_id, row);
    return true;
  }

  // Señales del buzón: "escribiendo..." y un clip que acaba de llegar
  _onSignal(msg) {
    if (!msg || typeof msg !== 'object' || typeof msg.from !== 'string' || msg.from === this.userId) return;
    const payload = msg.payload && typeof msg.payload === 'object' && !Array.isArray(msg.payload) ? msg.payload : {};
    if (msg.kind === '_typing') {
      const chat = this._chatForUser(msg.from);
      if (!chat) return;
      if (payload.stop) return this._clearTyping(chat.id);
      this.typing.set(chat.id, Date.now());
      this.emit('typing', { chatId: chat.id, typing: true });
      this._timers.push(setTimeout(() => {
        if (this.typing.has(chat.id) && !this.isTyping(chat.id)) this._clearTyping(chat.id);
      }, TYPING_SHOW_MS + 100));
    } else if (msg.kind === 'media-share') {
      this.refreshInbox();
      this.emit('media', {});
    }
  }

  _clearTyping(chatId) {
    if (this.typing.delete(chatId)) this.emit('typing', { chatId, typing: false });
  }

  isTyping(chatId) {
    const at = this.typing.get(chatId);
    return Boolean(at && Date.now() - at < TYPING_SHOW_MS);
  }

  sendTyping(chatId) {
    const chat = this._chats.get(chatId);
    if (!chat?.otherId || this.state !== 'ready') return;
    const now = Date.now();
    if (now - (this._typingSent.get(chatId) || 0) < TYPING_SEND_MS) return;
    this._typingSent.set(chatId, now);
    if (!isOnline(presenceOf(this._activity.get(chat.otherId), this.now()).presence)) return;
    this.backend.sendSignal(chat.otherId, '_typing', { chat: chatId }).catch(() => {});
  }

  _tick() {
    this._rebuild();
    for (const chatId of [...this.typing.keys()]) if (!this.isTyping(chatId)) this._clearTyping(chatId);
  }

  // ---------- Listas ----------
  _rebuild() {
    const { friends, incoming, outgoing } = buildLists({
      friendships: [...this._friendships.values()],
      profiles: this._profiles,
      activity: this._activity,
      chatFor: (id) => this._chatForUser(id),
      me: this.userId,
      nowMs: this.now(),
      someone: this.someone,
    });
    this.friends = friends;
    this.incoming = incoming;
    this.outgoing = outgoing;
    this.emit('friends', friends);
    this.emit('chats', this.conversations());
  }

  // Conversaciones con al menos un mensaje, de la más nueva a la más vieja
  conversations() {
    return [...this._chats.values()]
      .filter((c) => c.lastMessage && c.otherId)
      .sort((a, b) => ts(b.lastMessage?.at) - ts(a.lastMessage?.at));
  }

  profileOf(userId) {
    return this._profiles.get(userId) || null;
  }

  nameOf(userId) {
    const p = this._profiles.get(userId);
    return (typeof p?.display_name === 'string' && p.display_name.trim()) || p?.username || this.someone;
  }

  isFriend(userId) {
    return this.friends.some((f) => f.id === userId);
  }

  presenceOf(userId) {
    return presenceOf(this._activity.get(userId), this.now());
  }

  // ---------- Amigos ----------
  async addFriend(query) {
    const check = validFriendQuery(query, this.me?.friend_code);
    if (!check.ok) throw Object.assign(new Error(check.error), { code: 'P0001' });
    const out = await this.backend.sendFriendRequest(check.query);
    await this._syncAll().catch(() => {});
    return out;
  }

  async respond(userId, accept) {
    await this.backend.respondRequest(userId, accept);
    await this._syncAll().catch(() => {});
    this.refreshInbox();
  }

  async cancelRequest(userId) {
    await this.backend.removeFriend(userId);
    await this._syncAll().catch(() => {});
  }

  // ---------- Conversaciones ----------
  _ensureChat(id, otherId) {
    let chat = this._chats.get(id);
    if (!chat) {
      chat = { id, otherId: otherId || null, messages: [], loaded: false, hasMore: true, unread: 0, myLastRead: null, otherLastRead: null, lastMessage: null, lastMessageAt: null };
      this._chats.set(id, chat);
    } else if (otherId && !chat.otherId) chat.otherId = otherId;
    return chat;
  }

  _chatForUser(userId) {
    if (!userId) return null;
    for (const c of this._chats.values()) if (c.otherId === userId) return c;
    return null;
  }

  chat(chatId) {
    return this._chats.get(chatId) || null;
  }

  chatIdFor(userId) {
    return this._chatForUser(userId)?.id || null;
  }

  // La conversación con este amigo (se crea la primera vez)
  async ensureChat(userId) {
    const existing = this._chatForUser(userId);
    if (existing) return existing.id;
    const id = await this.backend.getOrCreateConversation(userId);
    this._ensureChat(id, userId);
    return id;
  }

  setActive(userId) {
    this.activeUser = userId || null;
    if (userId) this.markRead(this.chatIdFor(userId));
  }

  _isViewing(chatId) {
    if (!chatId || !this.activeUser || this.chatIdFor(this.activeUser) !== chatId) return false;
    return !this.doc?.hidden;
  }

  async loadMessages(chatId) {
    const chat = this._chats.get(chatId);
    if (!chat) return null;
    if (chat.loaded) return chat;
    if (chat.loading) return chat.loading;
    chat.loading = (async () => {
      const rows = (await this.backend.messages(chatId, { limit: PAGE })).reverse();
      for (const r of rows) chat.messages = upsertMessage(chat.messages, r);
      chat.hasMore = rows.length >= PAGE;
      for (const o of this._queue) if (o.conversation_id === chatId) chat.messages = upsertMessage(chat.messages, o);
      chat.loaded = true;
      this.emit('chat', { chatId, kind: 'loaded' });
      return chat;
    })();
    try {
      return await chat.loading;
    } finally {
      chat.loading = null;
    }
  }

  async loadOlder(chatId) {
    const chat = this._chats.get(chatId);
    if (!chat?.loaded || !chat.hasMore || chat.loadingOlder) return 0;
    const oldest = chat.messages.find((m) => !m._local);
    if (!oldest) {
      chat.hasMore = false;
      return 0;
    }
    chat.loadingOlder = true;
    try {
      const rows = (await this.backend.messages(chatId, { before: oldest.created_at, limit: PAGE })).reverse();
      for (const r of rows) chat.messages = upsertMessage(chat.messages, r);
      chat.hasMore = rows.length >= PAGE;
      this.emit('chat', { chatId, kind: 'older', count: rows.length });
      return rows.length;
    } finally {
      chat.loadingOlder = false;
    }
  }

  isRead(chatId, message) {
    const chat = this._chats.get(chatId);
    return Boolean(chat?.otherLastRead && message && !message._local && ts(message.created_at) <= ts(chat.otherLastRead));
  }

  markRead(chatId) {
    const chat = chatId && this._chats.get(chatId);
    if (!chat || this.state !== 'ready') return;
    const had = chat.unread;
    if (had) {
      chat.unread = 0;
      this._rebuild();
    }
    const last = chat.lastMessage;
    const behind = last && last.senderId !== this.userId && !last.local && ts(last.at) > ts(chat.myLastRead);
    if (!had && !behind) return;
    const readAt = new Date(this.now()).toISOString();
    this.backend
      .markRead(chatId)
      .then((at) => {
        const confirmed = at || readAt;
        if (ts(confirmed) > ts(chat.myLastRead)) chat.myLastRead = confirmed;
        this.refreshInbox();
      })
      .catch(() => {});
  }

  // ---------- Enviar ----------
  // La cola vive solo en memoria: se reintenta sola mientras la app esté abierta y, si no sale, lo dice.
  send(chatId, text) {
    const body = cleanBody(text);
    if (!body) return null;
    if (body.length > MAX_MESSAGE) throw new Error('too_long');
    const chat = this._chats.get(chatId);
    if (!chat) throw new Error('conversation_not_found');
    const row = { id: this.uuid(), conversation_id: chatId, sender_id: this.userId, body, reply_to: null, created_at: new Date(this.now()).toISOString(), edited_at: null, deleted: false, _local: 'pending', _error: null };
    this._queue.push(row);
    if (chat.loaded) chat.messages = upsertMessage(chat.messages, row);
    chat.lastMessage = summary(row);
    chat.lastMessageAt = row.created_at;
    this._typingSent.delete(chatId);
    this.emit('chat', { chatId, kind: 'insert', id: row.id });
    this._rebuild();
    this._flush();
    return row;
  }

  retry(messageId) {
    const row = this._queue.find((o) => o.id === messageId);
    if (!row) return;
    row._local = 'pending';
    row._error = null;
    this._touchLocal(row);
    this._flush();
  }

  discard(chatId, messageId) {
    this._queue = this._queue.filter((o) => o.id !== messageId);
    const chat = this._chats.get(chatId);
    if (!chat) return;
    chat.messages = chat.messages.filter((m) => m.id !== messageId || !m._local);
    const last = chat.messages.at(-1);
    chat.lastMessage = summary(last);
    this.emit('chat', { chatId, kind: 'remove', id: messageId });
    this._rebuild();
  }

  _touchLocal(row) {
    const chat = this._chats.get(row.conversation_id);
    if (!chat) return;
    if (chat.loaded) chat.messages = upsertMessage(chat.messages, row);
    this.emit('chat', { chatId: chat.id, kind: 'update', id: row.id });
  }

  async _flush() {
    if (this._flushing || this.state !== 'ready' || !this._queue.length || this.net?.onLine === false) return;
    this._flushing = true;
    const gen = this._gen;
    try {
      for (const row of [...this._queue]) {
        if (gen !== this._gen) return;
        if (row._local === 'failed' || !this._queue.includes(row)) continue;
        try {
          const saved = await this.backend.insertMessage({ id: row.id, conversation_id: row.conversation_id, sender_id: this.userId, body: row.body, reply_to: null });
          this._resolved(row, saved);
        } catch (raw) {
          const err = raw instanceof ApiError ? raw : new ApiError(raw);
          if (err.code === '23505') {
            // Ya se había guardado en un intento anterior
            const [saved] = await this.backend.messagesByIds([row.id]).catch(() => []);
            if (saved) {
              this._resolved(row, saved);
              continue;
            }
          }
          if (err.retryable) break; // se reintenta después, respetando el orden
          row._local = 'failed';
          row._error = err;
          this._touchLocal(row);
          if (err.code === '42501') this.resync('friends');
        }
      }
    } finally {
      this._flushing = false;
    }
  }

  _resolved(row, saved) {
    this._queue = this._queue.filter((o) => o !== row);
    const chat = this._chats.get(row.conversation_id);
    if (!chat || !saved) return;
    if (chat.loaded) chat.messages = upsertMessage(chat.messages, saved);
    if (!chat.lastMessage || chat.lastMessage.id === saved.id || ts(saved.created_at) >= ts(chat.lastMessage.at)) {
      chat.lastMessage = summary(saved);
      chat.lastMessageAt = saved.created_at;
    }
    this.emit('chat', { chatId: chat.id, kind: 'update', id: saved.id });
    this._rebuild();
  }

  // ---------- Stickers ----------
  // true: existe; false: se borró; undefined: el servidor no tiene stickers (se ve como texto). Se junta de a tandas.
  stickerStatus(id) {
    if (!this._stickersOk) return Promise.resolve(undefined);
    if (this._stickers.has(id)) return Promise.resolve(this._stickers.get(id));
    return new Promise((resolve) => {
      if (!this._stickerWaiters.has(id)) this._stickerWaiters.set(id, []);
      this._stickerWaiters.get(id).push(resolve);
      clearTimeout(this._stickerTimer);
      this._stickerTimer = setTimeout(() => this._resolveStickers(), 60);
    });
  }

  async _resolveStickers() {
    const waiting = new Map(this._stickerWaiters);
    this._stickerWaiters.clear();
    const ids = [...waiting.keys()].slice(0, 60);
    for (const id of [...waiting.keys()].slice(60)) {
      this._stickerWaiters.set(id, waiting.get(id));
      this._stickerTimer = setTimeout(() => this._resolveStickers(), 60);
    }
    let alive = null;
    try {
      alive = await this.backend.stickersAlive(ids);
    } catch {
      alive = null; // sin red: no se afirma nada, se intenta dibujar
    }
    if (alive === undefined) this._stickersOk = false;
    for (const id of ids) {
      const value = alive === undefined ? undefined : alive === null ? true : alive.has(id);
      if (alive !== null && alive !== undefined) this._stickers.set(id, value);
      for (const resolve of waiting.get(id) || []) resolve(value);
    }
  }
}
