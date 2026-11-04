// Cliente falso de Supabase para ver y probar la app sin servidor. Solo se carga en localhost y con ?fake=1 (logic.js, fakeAllowed);
// nunca hace pedidos de red y todos los datos son inventados. Tiene la misma forma que supabase-js en lo que usa backend.js, así
// se prueba el código real. Parámetros: ?login=1 arranca sin sesión; ?gallery=1 simula que existe gallery_list.
const ME = '0a000000-0000-4000-8000-000000000001';
const LUNA = '0a000000-0000-4000-8000-000000000002';
const NICO = '0a000000-0000-4000-8000-000000000003';
const SOFI = '0a000000-0000-4000-8000-000000000004';
const TOMI = '0a000000-0000-4000-8000-000000000005';
const MAIA = '0a000000-0000-4000-8000-000000000006';
const PABLO = '0a000000-0000-4000-8000-000000000007';
const JULI = '0a000000-0000-4000-8000-000000000008';
const CONV_LUNA = '0b000000-0000-4000-8000-000000000001';
const CONV_NICO = '0b000000-0000-4000-8000-000000000002';
const STICKER = '0c000000-0000-4000-8000-000000000001';
const STICKER_GONE = '0c000000-0000-4000-8000-000000000002';
const BASE = 'https://dzchklzaxyygbvfpagvx.supabase.co';

const ago = (min, now) => new Date(now - min * 60_000).toISOString();
const missing = (name) => ({ data: null, error: { code: 'PGRST202', message: `Could not find the function public.${name}`, status: 404 } });

function seed(now) {
  const profile = (id, username, display_name, friend_code, extra = {}) => ({ id, username, display_name, friend_code, status_text: null, ...extra });
  const db = {
    profiles: [
      profile(ME, 'nova_mc', 'Nova', 'VENUS-A1B2C3'),
      profile(LUNA, 'luna_mc', 'Luna', 'VENUS-L0N4AA'),
      profile(NICO, 'nico', '', 'VENUS-N1C0AA'),
      profile(SOFI, 'sofi_builds', 'Sofi 🌸', 'VENUS-S0F1AA', { status_text: 'Construyendo un castillo' }),
      profile(TOMI, 'tomi_pvp', 'Tomi', 'VENUS-T0M1AA', { status_text: 'No molestar, torneo' }),
      profile(MAIA, 'maia', 'Maia', 'VENUS-MA1AAA'),
      profile(PABLO, 'pablito', 'Pablo', 'VENUS-PAB10A'),
      profile(JULI, 'juli', 'Juli', 'VENUS-JUL1AA'),
    ],
    friendships: [
      { id: 'f1', requester: ME, addressee: LUNA, status: 'accepted', created_at: ago(90000, now), updated_at: ago(90000, now) },
      { id: 'f2', requester: NICO, addressee: ME, status: 'accepted', created_at: ago(80000, now), updated_at: ago(80000, now) },
      { id: 'f3', requester: ME, addressee: SOFI, status: 'accepted', created_at: ago(70000, now), updated_at: ago(70000, now) },
      { id: 'f4', requester: TOMI, addressee: ME, status: 'accepted', created_at: ago(60000, now), updated_at: ago(60000, now) },
      { id: 'f5', requester: ME, addressee: MAIA, status: 'accepted', created_at: ago(50000, now), updated_at: ago(50000, now) },
      { id: 'f6', requester: PABLO, addressee: ME, status: 'pending', created_at: ago(30, now), updated_at: ago(30, now) },
      { id: 'f7', requester: ME, addressee: JULI, status: 'pending', created_at: ago(400, now), updated_at: ago(400, now) },
    ],
    user_activity: [
      { user_id: LUNA, status: 'online', activity: { type: 'server', mcVersion: '1.21.1', loader: 'fabric', address: 'mc.hypixel.net', instanceName: 'PvP' }, updated_at: ago(0.2, now) },
      { user_id: NICO, status: 'online', activity: { type: 'singleplayer', mcVersion: '1.20.4', loader: 'vanilla', world: 'Mundo de Nico' }, updated_at: ago(0.4, now) },
      { user_id: SOFI, status: 'away', activity: null, updated_at: ago(0.5, now) },
      { user_id: TOMI, status: 'busy', activity: null, updated_at: ago(1, now) },
      { user_id: MAIA, status: 'online', activity: null, updated_at: ago(600, now) },
    ],
    conversations: [
      { id: CONV_LUNA, other: LUNA, my_last_read_at: ago(9, now), other_last_read_at: ago(3, now), created_at: ago(5000, now) },
      { id: CONV_NICO, other: NICO, my_last_read_at: ago(5, now), other_last_read_at: ago(200, now), created_at: ago(4000, now) },
    ],
    messages: [
      { id: 'm1', conversation_id: CONV_LUNA, sender_id: LUNA, body: '¿Entrás a Hypixel?', reply_to: null, created_at: ago(1500, now), edited_at: null, deleted: false },
      { id: 'm2', conversation_id: CONV_LUNA, sender_id: ME, body: 'Dale, en un rato. Mirá este server https://example.org/servidor', reply_to: null, created_at: ago(1490, now), edited_at: null, deleted: false },
      { id: 'm3', conversation_id: CONV_LUNA, sender_id: LUNA, body: 'https://static.klipy.com/ii/demo/gif.gif', reply_to: null, created_at: ago(30, now), edited_at: null, deleted: false },
      { id: 'm4', conversation_id: CONV_LUNA, sender_id: ME, body: `${BASE}/storage/v1/object/public/stickers/${ME}/${STICKER}.png`, reply_to: null, created_at: ago(20, now), edited_at: null, deleted: false },
      { id: 'm5', conversation_id: CONV_LUNA, sender_id: LUNA, body: `${BASE}/storage/v1/object/public/stickers/${LUNA}/${STICKER_GONE}.png`, reply_to: null, created_at: ago(15, now), edited_at: null, deleted: false },
      { id: 'm6', conversation_id: CONV_LUNA, sender_id: LUNA, body: '', reply_to: null, created_at: ago(12, now), edited_at: null, deleted: true },
      { id: 'm7', conversation_id: CONV_LUNA, sender_id: ME, body: '¿Viste el clip que te mandé?', reply_to: null, created_at: ago(10, now), edited_at: null, deleted: false },
      { id: 'm8', conversation_id: CONV_LUNA, sender_id: LUNA, body: 'Sí, ¡buenísimo! <b>no</b> soy HTML', reply_to: null, created_at: ago(4, now), edited_at: ago(3, now), deleted: false },
      { id: 'm9', conversation_id: CONV_LUNA, sender_id: LUNA, body: 'Te mando otro cuando termine la partida', reply_to: null, created_at: ago(2, now), edited_at: null, deleted: false },
      { id: 'm20', conversation_id: CONV_NICO, sender_id: NICO, body: '¿Probaste el mundo nuevo?', reply_to: null, created_at: ago(300, now), edited_at: null, deleted: false },
      { id: 'm21', conversation_id: CONV_NICO, sender_id: ME, body: 'Todavía no, hoy a la noche', reply_to: null, created_at: ago(290, now), edited_at: null, deleted: false },
    ],
    shared_media: [
      { id: 'c1', owner: ME, kind: 'clip', bucket: 'clips', path: `${ME}/clip-1.webm`, file_name: '2026-11-01_18.03.09_replay.webm', world: 'Mundo de Nico', instance_name: 'Survival', size_bytes: 24_500_000, taken_at: ago(3000, now), created_at: ago(2900, now), expires_at: ago(-500000, now), url: `${BASE}/storage/v1/object/sign/clips/${ME}/clip-1.webm?token=demo` },
      { id: 'c2', owner: ME, kind: 'screenshot', bucket: 'screenshots', path: `${ME}/shot-1.png`, file_name: '2026-10-28_21.40.11_venus.png', world: 'Base', instance_name: 'Survival', size_bytes: 2_400_000, taken_at: ago(9000, now), created_at: ago(8900, now), expires_at: ago(10, now), url: null },
    ],
    media_received: [
      { id: 'r1', sender: LUNA, kind: 'clip', name: '2026-11-02_22.10.30_auto-death.webm', url: `${BASE}/storage/v1/object/sign/clips/${LUNA}/recibido-1.webm?token=demo`, created_at: ago(45, now), seen_at: null },
      { id: 'r2', sender: NICO, kind: 'screenshot', name: '2026-10-30_19.05.00_venus.png', url: `${BASE}/storage/v1/object/sign/screenshots/${NICO}/recibido-2.png?token=demo`, created_at: ago(4000, now), seen_at: ago(3900, now) },
    ],
    stickers_alive: new Set([STICKER]),
  };
  return db;
}

const nameOf = (db, id) => {
  const p = db.profiles.find((x) => x.id === id);
  return (p?.display_name || '').trim() || p?.username || null;
};

class Query {
  constructor(db, table, session) {
    this.db = db;
    this.table = table;
    this.session = session;
    this.filters = [];
    this.opts = {};
    this.mode = 'select';
  }
  select() { return this; }
  eq(col, val) { this.filters.push((r) => r[col] === val); return this; }
  in(col, vals) { this.filters.push((r) => vals.includes(r[col])); return this; }
  lt(col, val) { this.filters.push((r) => Date.parse(r[col]) < Date.parse(val)); return this; }
  order(col, { ascending = true } = {}) { this.opts.order = { col, ascending }; return this; }
  limit(n) { this.opts.limit = n; return this; }
  single() { this.opts.single = true; return this; }
  maybeSingle() { this.opts.single = true; return this; }
  insert(row) { this.mode = 'insert'; this.row = row; return this; }
  rows() {
    const tables = { friendships: this.db.friendships, profiles: this.db.profiles, user_activity: this.db.user_activity, messages: this.db.messages, shared_media: this.db.shared_media };
    return tables[this.table] || [];
  }
  run() {
    if (this.mode === 'insert') {
      const row = { edited_at: null, deleted: false, ...this.row, created_at: new Date().toISOString() };
      if (this.db.fail?.insert) return { data: null, ...this.db.fail.insert };
      const conv = this.db.conversations.find((c) => c.id === row.conversation_id);
      const friends = conv && this.db.friendships.some((f) => f.status === 'accepted' && (f.requester === conv.other || f.addressee === conv.other));
      if (!friends) return { data: null, error: { code: '42501', message: 'new row violates row-level security policy for table "messages"' }, status: 403 };
      this.db.messages.push(row);
      return { data: row, error: null, status: 201 };
    }
    let rows = this.rows().filter((r) => this.filters.every((f) => f(r)));
    if (this.opts.order) {
      const { col, ascending } = this.opts.order;
      rows = [...rows].sort((a, b) => (ascending ? 1 : -1) * ((Date.parse(a[col]) || 0) - (Date.parse(b[col]) || 0)));
    }
    if (this.opts.limit) rows = rows.slice(0, this.opts.limit);
    return { data: this.opts.single ? rows[0] || null : rows, error: null, status: 200 };
  }
  then(resolve, reject) {
    return Promise.resolve().then(() => this.run()).then(resolve, reject);
  }
}

export function createFakeClient({ signedIn = true, gallery = false, now = Date.now() } = {}) {
  const db = seed(now);
  const channels = new Set();
  const authListeners = new Set();
  const calls = [];
  const user = { id: ME, email: 'nova@example.invalid' };
  let session = signedIn ? { user, access_token: 'falso', expires_at: Math.floor(now / 1000) + 3600 } : null;
  const search = globalThis.location?.search || '';
  const hasGallery = gallery || new URLSearchParams(search).get('gallery') === '1';

  const setSession = (next, event) => {
    session = next;
    for (const fn of authListeners) fn(event, session);
  };

  const conversationRow = (c) => {
    const msgs = db.messages.filter((m) => m.conversation_id === c.id).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    const last = msgs.at(-1);
    return {
      conv_id: c.id,
      other_user: c.other,
      conv_created_at: c.created_at,
      conv_last_message_at: last?.created_at || null,
      my_last_read_at: c.my_last_read_at,
      other_last_read_at: c.other_last_read_at,
      unread_count: msgs.filter((m) => m.sender_id !== ME && !m.deleted && Date.parse(m.created_at) > Date.parse(c.my_last_read_at)).length,
      last_id: last?.id || null,
      last_sender: last?.sender_id || null,
      last_body: last ? last.body.slice(0, 200) : null,
      last_deleted: last?.deleted || false,
      last_created_at: last?.created_at || null,
    };
  };

  const rpcs = {
    social_conversations: () => db.conversations.map(conversationRow),
    my_moderation: () => ({ muted: false, banned: false }),
    social_mark_read: ({ conv }) => {
      const c = db.conversations.find((x) => x.id === conv);
      if (!c) return { error: { message: 'conversation_not_found', code: 'P0002' } };
      c.my_last_read_at = new Date().toISOString();
      return c.my_last_read_at;
    },
    social_get_or_create_conversation: ({ other }) => {
      let c = db.conversations.find((x) => x.other === other);
      if (!c) {
        c = { id: `0b000000-0000-4000-8000-0000000000${(10 + db.conversations.length).toString(16)}`, other, my_last_read_at: new Date().toISOString(), other_last_read_at: new Date().toISOString(), created_at: new Date().toISOString() };
        db.conversations.push(c);
      }
      return c.id;
    },
    social_send_friend_request: ({ target }) => {
      const t = String(target).trim().toUpperCase();
      if (t === 'VENUS-NOEXIS') return { error: { message: 'user_not_found', code: 'P0002' } };
      return { result: 'sent', user_id: PABLO };
    },
    social_respond_friend_request: ({ other, accept }) => {
      const i = db.friendships.findIndex((f) => f.requester === other && f.addressee === ME && f.status === 'pending');
      if (i < 0) return { error: { message: 'request_not_found', code: 'P0002' } };
      if (accept) db.friendships[i] = { ...db.friendships[i], status: 'accepted' };
      else db.friendships.splice(i, 1);
      return true;
    },
    social_remove_friend: ({ other }) => {
      const i = db.friendships.findIndex((f) => (f.requester === other && f.addressee === ME) || (f.addressee === other && f.requester === ME));
      if (i >= 0) db.friendships.splice(i, 1);
      return true;
    },
    social_send_signal: () => true,
    sticker_resolve: ({ p_ids }) => p_ids.filter((id) => db.stickers_alive.has(id)).map((id) => ({ id })),
    media_received_list: () =>
      db.media_received
        .map((r) => ({ id: r.id, userId: r.sender, from: nameOf(db, r.sender), kind: r.kind, name: r.name, url: r.url, at: r.created_at, seen: Boolean(r.seen_at) }))
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at)),
    media_received_seen: ({ p_ids }) => {
      let n = 0;
      for (const r of db.media_received) if (!r.seen_at && (!p_ids || p_ids.includes(r.id))) { r.seen_at = new Date().toISOString(); n++; }
      return n;
    },
    media_received_remove: ({ p_id }) => {
      const i = db.media_received.findIndex((r) => r.id === p_id);
      if (i >= 0) db.media_received.splice(i, 1);
      return i >= 0;
    },
    app_inbox: ({ p_preview }) => ({
      at: new Date().toISOString(),
      messages: db.conversations
        .map(conversationRow)
        .filter((c) => c.unread_count > 0)
        .map((c) => ({ conv: c.conv_id, userId: c.other_user, name: nameOf(db, c.other_user), unread: c.unread_count, at: c.last_created_at, messageId: c.last_id, text: p_preview ? c.last_body : null })),
      requests: db.friendships.filter((f) => f.addressee === ME && f.status === 'pending').map((f) => ({ userId: f.requester, name: nameOf(db, f.requester), at: f.created_at })),
      clips: db.media_received.filter((r) => !r.seen_at).map((r) => ({ id: r.id, userId: r.sender, from: nameOf(db, r.sender), kind: r.kind, name: r.name, at: r.created_at })),
    }),
    gallery_list: () => (hasGallery ? [{ id: 'g1', kind: 'clip', title: 'Mejor clip de la semana', author: 'Luna', created_at: ago(100, now), url: `${BASE}/storage/v1/object/public/gallery/${LUNA}/g1.webm` }] : undefined),
  };

  const client = {
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
      onAuthStateChange(fn) {
        authListeners.add(fn);
        return { data: { subscription: { unsubscribe: () => authListeners.delete(fn) } } };
      },
      async signInWithPassword({ password }) {
        if (password === 'mal') return { data: {}, error: { code: 'invalid_credentials', message: 'Invalid login credentials', status: 400 } };
        if (password === 'sinconfirmar') return { data: {}, error: { code: 'email_not_confirmed', message: 'Email not confirmed', status: 400 } };
        const next = { user, access_token: 'falso', expires_at: Math.floor(Date.now() / 1000) + 3600 };
        setSession(next, 'SIGNED_IN');
        return { data: { session: next, user }, error: null };
      },
      signUp: async () => ({ data: { user: { id: 'nuevo', identities: [{}] }, session: null }, error: null }),
      resend: async () => ({ data: {}, error: null }),
      resetPasswordForEmail: async () => ({ data: {}, error: null }),
      async verifyOtp({ token }) {
        if (token === '000000') return { data: {}, error: { code: 'otp_expired', message: 'Token has expired or is invalid', status: 403 } };
        const next = { user, access_token: 'falso', expires_at: Math.floor(Date.now() / 1000) + 3600 };
        setSession(next, 'SIGNED_IN');
        return { data: { session: next, user }, error: null };
      },
      updateUser: async () => ({ data: { user }, error: null }),
      async signOut() {
        setSession(null, 'SIGNED_OUT');
        return { error: null };
      },
    },
    from: (table) => new Query(db, table, () => session),
    async rpc(name, args = {}) {
      calls.push({ name, args });
      const fn = rpcs[name];
      if (!fn) return missing(name);
      const out = fn(args);
      if (out === undefined) return missing(name);
      if (out && typeof out === 'object' && out.error) return { data: null, error: out.error, status: 400 };
      return { data: out, error: null, status: 200 };
    },
    storage: {
      from: (bucket) => ({
        createSignedUrl: async (path) => ({ data: { signedUrl: `${BASE}/storage/v1/object/sign/${bucket}/${path}?token=corto` }, error: null }),
      }),
    },
    channel(name) {
      const ch = {
        name,
        handlers: [],
        on(type, filter, cb) {
          this.handlers.push({ type, filter, cb });
          return this;
        },
        subscribe(cb) {
          this.status = cb;
          queueMicrotask(() => cb?.('SUBSCRIBED'));
          return this;
        },
      };
      channels.add(ch);
      return ch;
    },
    async removeChannel(ch) {
      channels.delete(ch);
      return 'ok';
    },
  };

  const dispatch = (table, event, payload) => {
    for (const ch of channels) {
      for (const h of ch.handlers) {
        if (h.type === 'postgres_changes' && h.filter.table === table && (h.filter.event === event || h.filter.event === '*')) h.cb({ eventType: event, ...payload });
      }
    }
  };
  const signal = (msg) => {
    for (const ch of channels) for (const h of ch.handlers) if (h.type === 'broadcast') h.cb({ payload: msg });
  };

  // Lo que hacen los demás, para probar el tiempo real
  client.__fake = {
    db,
    calls,
    ids: { ME, LUNA, NICO, SOFI, TOMI, MAIA, PABLO, JULI, CONV_LUNA, CONV_NICO },
    receive(from, conv, body) {
      const row = { id: `m-${Math.random().toString(16).slice(2)}`, conversation_id: conv, sender_id: from, body, reply_to: null, created_at: new Date().toISOString(), edited_at: null, deleted: false };
      db.messages.push(row);
      dispatch('messages', 'INSERT', { new: row });
      return row;
    },
    deleteMessage(id) {
      const m = db.messages.find((x) => x.id === id);
      Object.assign(m, { body: '', deleted: true });
      dispatch('messages', 'UPDATE', { new: { ...m } });
    },
    typing(from, chat) {
      signal({ from, kind: '_typing', payload: { chat }, at: new Date().toISOString() });
    },
    share(from) {
      const row = { id: `r-${Math.random().toString(16).slice(2)}`, sender: from, kind: 'clip', name: 'clip-nuevo.webm', url: `${BASE}/storage/v1/object/sign/clips/${from}/nuevo.webm?token=demo`, created_at: new Date().toISOString(), seen_at: null };
      db.media_received.push(row);
      signal({ from, kind: 'media-share', payload: { url: row.url, kind: 'clip', name: row.name }, at: row.created_at });
    },
    request(from) {
      const row = { id: `f-${Math.random().toString(16).slice(2)}`, requester: from, addressee: ME, status: 'pending', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      db.friendships.push(row);
      dispatch('friendships', 'INSERT', { new: row, old: {} });
    },
    activity(row) {
      const i = db.user_activity.findIndex((a) => a.user_id === row.user_id);
      if (i >= 0) db.user_activity[i] = row;
      else db.user_activity.push(row);
      dispatch('user_activity', 'UPDATE', { new: row });
    },
    read(conv, at) {
      dispatch('conversation_members', 'UPDATE', { new: { conversation_id: conv, user_id: 'otro', last_read_at: at } });
    },
    dropChannels(status = 'CHANNEL_ERROR') {
      for (const ch of channels) ch.status?.(status);
    },
  };
  globalThis.__venusFake = client.__fake;
  return client;
}

// Los avisos, sin navegador real de por medio: solo para ver los estados de la tarjeta.
export function createFakePush() {
  const search = new URLSearchParams(globalThis.location?.search || '');
  const state = { support: search.get('push') || 'ok', permission: 'default', enabled: false };
  let preview = true;
  return {
    status: async () => ({ ...state }),
    enable: async () => {
      state.permission = 'granted';
      state.enabled = true;
    },
    disable: async () => {
      state.enabled = false;
    },
    refresh: async () => {},
    previewEnabled: async () => preview,
    setPreview: async (on) => {
      preview = on;
    },
  };
}
