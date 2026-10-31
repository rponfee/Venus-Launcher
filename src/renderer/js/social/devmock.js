// Backend falso del modulo social, en memoria. Solo para pruebas visuales (scripts/devshot.js) y para
// desarrollar la pagina de Mensajes sin un proyecto de Supabase. Implementa la misma interfaz que
// createSupabaseBackend (social/backend.js) y simula los eventos en tiempo real.
//   import('./js/social/devmock.js').then((m) => m.install())
// Nunca se carga en el uso normal del launcher.

const ME = 'mock-me';
const iso = (ms) => new Date(ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function seed(now) {
  const profile = (id, username, display, extra = {}) => ({
    id,
    username,
    display_name: display,
    friend_code: `VENUS-${`${username.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}XXXXXX`.slice(0, 6)}`,
    mc_name: username,
    mc_uuid: null,
    bio: null,
    banner: 'venus',
    badges: [],
    status_text: null,
    created_at: iso(now - 90 * DAY),
    ...extra,
  });
  const profiles = [
    profile(ME, 'Ringo', 'Ringo', { friend_code: 'VENUS-R1NG0X', banner: 'venus', badges: ['founder', 'early'], status_text: 'Armando la base del server', bio: 'Constructor de castillos y granjas de hierro. Siempre con ganas de un survival nuevo.' }),
    profile('mock-tomas', 'TomiCraft', 'Tomás', { banner: 'ocean', badges: ['supporter'], status_text: 'Bedwars toda la noche', bio: 'Main bedwars. Si me ves conectado, sumate.' }),
    profile('mock-luli', 'Luli_mc', 'Luli', { banner: 'cherry', mc_name: 'Luli_mc' }),
    profile('mock-nico', 'NicoRedstone', 'Nico', { banner: 'redstone', badges: ['dev'], status_text: 'Haciendo una CPU en redstone' }),
    profile('mock-sofi', 'SofiBuilds', 'Sofi', { banner: 'amethyst', badges: ['creator'] }),
    profile('mock-martu', 'Martu', 'Martina', { banner: 'end' }),
    profile('mock-fede', 'FedeGG', 'Fede', { banner: 'nether' }),
    profile('mock-juan', 'Juancito_77', 'Juancito', { banner: 'forest' }),
    profile('mock-valen', 'ValenPvP', 'Valen', { banner: 'gold' }),
    profile('mock-lucas', 'LucasXD', 'Lucas', { banner: 'midnight' }),
    profile('mock-troll', 'TrollMaster', 'TrollMaster', { banner: 'stone' }),
  ];
  const fr = (id, other, status, ago, requesterIsMe = true) => ({
    id,
    requester: requesterIsMe ? ME : other,
    addressee: requesterIsMe ? other : ME,
    status,
    created_at: iso(now - ago),
    updated_at: iso(now - ago + HOUR),
  });
  const friendships = [
    fr('f1', 'mock-tomas', 'accepted', 120 * DAY),
    fr('f2', 'mock-luli', 'accepted', 60 * DAY, false),
    fr('f3', 'mock-nico', 'accepted', 40 * DAY),
    fr('f4', 'mock-sofi', 'accepted', 30 * DAY, false),
    fr('f5', 'mock-martu', 'accepted', 20 * DAY),
    fr('f6', 'mock-fede', 'accepted', 10 * DAY),
    fr('f7', 'mock-juan', 'pending', 2 * HOUR, false),
    fr('f8', 'mock-valen', 'pending', 26 * HOUR, false),
    fr('f9', 'mock-lucas', 'pending', 3 * DAY),
    fr('f10', 'mock-troll', 'blocked', 15 * DAY),
  ];
  const act = (user, status, activity, ago = 20_000) => ({ user_id: user, status, activity, updated_at: iso(now - ago) });
  const activity = [
    act('mock-tomas', 'online', { type: 'server', instanceName: 'Bedwars PvP', mcVersion: '1.21.1', loader: 'fabric', address: 'mc.hypixel.net', since: now - 47 * MIN }),
    act('mock-luli', 'online', null),
    act('mock-nico', 'away', { type: 'menu', instanceName: 'Redstone Lab', mcVersion: '1.20.4', loader: 'vanilla', since: now - 3 * HOUR }),
    act('mock-sofi', 'busy', { type: 'singleplayer', instanceName: 'Creativo', mcVersion: '1.21.4', loader: 'neoforge', world: 'Isla de los Cerezos', since: now - 25 * MIN }),
    act('mock-martu', 'offline', null, 2 * HOUR),
    act('mock-fede', 'online', null, 10 * MIN), // vencido: se ve desconectado
  ];
  const conversations = [
    { id: 'c-tomas', user_lo: ME, user_hi: 'mock-tomas', created_at: iso(now - 30 * DAY), last_message_at: null },
    { id: 'c-luli', user_lo: ME, user_hi: 'mock-luli', created_at: iso(now - 20 * DAY), last_message_at: null },
    { id: 'c-sofi', user_lo: ME, user_hi: 'mock-sofi', created_at: iso(now - 10 * DAY), last_message_at: null },
    { id: 'c-martu', user_lo: ME, user_hi: 'mock-martu', created_at: iso(now - 9 * DAY), last_message_at: null },
  ];
  const members = [];
  for (const c of conversations) {
    members.push({ id: `m-${c.id}-a`, conversation_id: c.id, user_id: c.user_lo, last_read_at: iso(now - 2 * MIN), joined_at: c.created_at });
    members.push({ id: `m-${c.id}-b`, conversation_id: c.id, user_id: c.user_hi, last_read_at: iso(now - 5 * MIN), joined_at: c.created_at });
  }
  let n = 0;
  const messages = [];
  const msg = (conv, sender, body, ago, extra = {}) => {
    const row = { id: `msg-${++n}`, conversation_id: conv, sender_id: sender, body, reply_to: null, created_at: iso(now - ago), edited_at: null, deleted: false, ...extra };
    messages.push(row);
    return row;
  };
  // Tomás: dos dias de charla con respuestas, editados, borrados, links y reacciones
  for (let i = 0; i < 46; i++) msg('c-tomas', i % 2 ? ME : 'mock-tomas', i % 2 ? `Mensaje viejo ${i}` : `¿Te acordás de la partida ${i}?`, 4 * DAY + (46 - i) * 7 * MIN);
  const a1 = msg('c-tomas', 'mock-tomas', '¿Jugamos esta noche? Abro el server a las 22', DAY + 3 * HOUR);
  msg('c-tomas', ME, 'Dale, yo llevo las camas 🛏️', DAY + 3 * HOUR - 2 * MIN, { reply_to: a1.id });
  msg('c-tomas', ME, 'Mirá este mod: https://modrinth.com/mod/sodium', DAY + 3 * HOUR - 3 * MIN, { edited_at: iso(now - DAY - 2 * HOUR) });
  msg('c-tomas', 'mock-tomas', '', DAY + 2 * HOUR, { deleted: true });
  const a2 = msg('c-tomas', 'mock-tomas', 'Estoy en Hypixel, entrá que armamos equipo para bedwars', 14 * MIN);
  msg('c-tomas', 'mock-tomas', 'Te guardo lugar 😄', 13 * MIN);
  msg('c-tomas', ME, 'Voy en 5, estoy terminando la granja', 9 * MIN, { reply_to: a2.id });
  msg('c-tomas', ME, '⛏️💎', 8 * MIN);
  // Luli: dos sin leer
  msg('c-luli', ME, '¿Viste la 1.21.4? Tiene el bosque pálido', 3 * HOUR);
  msg('c-luli', 'mock-luli', '¡Sí! Quiero hacer una casa ahí', 4 * MIN);
  msg('c-luli', 'mock-luli', 'Pasame el mundo cuando puedas', 3 * MIN);
  // Sofi: uno sin leer
  msg('c-sofi', 'mock-sofi', 'Terminé la isla, ¿la querés ver?', 40 * MIN);
  // Martina: vieja
  msg('c-martu', 'mock-martu', 'Gracias por la ayuda con el modpack', 5 * DAY);
  msg('c-martu', ME, 'De nada, cualquier cosa avisame', 5 * DAY - 10 * MIN);
  for (const c of conversations) {
    const last = messages.filter((m) => m.conversation_id === c.id).at(-1);
    c.last_message_at = last?.created_at || null;
  }
  // lecturas: Tomás leyo todo; Luli y Sofi tienen mensajes nuevos para mi
  members.find((m) => m.conversation_id === 'c-tomas' && m.user_id === 'mock-tomas').last_read_at = iso(now - 8 * MIN + 1000);
  members.find((m) => m.conversation_id === 'c-luli' && m.user_id === ME).last_read_at = iso(now - 3 * HOUR);
  members.find((m) => m.conversation_id === 'c-sofi' && m.user_id === ME).last_read_at = iso(now - 2 * HOUR);
  const reactions = [
    { id: 'r1', message_id: a1.id, conversation_id: 'c-tomas', user_id: ME, emoji: '🔥', created_at: iso(now - DAY) },
    { id: 'r2', message_id: a1.id, conversation_id: 'c-tomas', user_id: 'mock-tomas', emoji: '🔥', created_at: iso(now - DAY) },
    { id: 'r3', message_id: a2.id, conversation_id: 'c-tomas', user_id: ME, emoji: '👍', created_at: iso(now - 12 * MIN) },
  ];
  return { profiles, friendships, activity, conversations, members, messages, reactions };
}

function fail(message, code = 'P0001') {
  const err = new Error(message);
  err.code = code;
  err.status = 400;
  return err;
}

// moderation: { muted, mutedUntil, banned, bannedUntil } para ver los avisos de una cuenta silenciada o baneada
export function createMockBackend({ latency = 120, autoReply = true, moderation = null } = {}) {
  const db = seed(Date.now());
  const wait = (ms = latency) => new Promise((r) => setTimeout(r, ms));
  const clone = (x) => JSON.parse(JSON.stringify(x));
  let handlers = {};
  const otherOf = (c) => (c.user_lo === ME ? c.user_hi : c.user_lo);
  const fire = (fn, ...args) => setTimeout(() => handlers[fn]?.(...args), 60);

  const conversationsSummary = () =>
    db.conversations.map((c) => {
      const mine = db.members.find((m) => m.conversation_id === c.id && m.user_id === ME);
      const theirs = db.members.find((m) => m.conversation_id === c.id && m.user_id !== ME);
      const list = db.messages.filter((m) => m.conversation_id === c.id).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
      const last = list.at(-1);
      return {
        conv_id: c.id,
        other_user: otherOf(c),
        conv_created_at: c.created_at,
        conv_last_message_at: c.last_message_at,
        my_last_read_at: mine.last_read_at,
        other_last_read_at: theirs.last_read_at,
        unread_count: list.filter((m) => m.sender_id !== ME && !m.deleted && Date.parse(m.created_at) > Date.parse(mine.last_read_at)).length,
        last_id: last?.id || null,
        last_sender: last?.sender_id || null,
        last_body: last?.body || null,
        last_deleted: last?.deleted ?? null,
        last_created_at: last?.created_at || null,
      };
    });

  const replyFrom = (conv, sender, text, delay) => {
    setTimeout(() => handlers.onSignal?.({ from: sender, kind: '_typing', payload: { chat: conv }, at: new Date().toISOString() }), delay * 0.35);
    setTimeout(() => {
      const row = { id: `msg-r${Date.now()}`, conversation_id: conv, sender_id: sender, body: text, reply_to: null, created_at: new Date().toISOString(), edited_at: null, deleted: false };
      db.messages.push(row);
      handlers.onMessage?.('INSERT', clone(row));
    }, delay);
  };

  return {
    userId: ME,
    me: clone(db.profiles.find((p) => p.id === ME)),

    async friendships() {
      await wait();
      return clone(db.friendships);
    },
    async profiles(ids) {
      await wait(40);
      return clone(db.profiles.filter((p) => ids.includes(p.id)));
    },
    async activities(ids) {
      await wait(40);
      return clone(db.activity.filter((a) => ids.includes(a.user_id)));
    },
    async conversations() {
      await wait();
      return conversationsSummary();
    },
    async messages(chatId, { before = null, limit = 40 } = {}) {
      await wait();
      return clone(
        db.messages
          .filter((m) => m.conversation_id === chatId && (!before || Date.parse(m.created_at) < Date.parse(before)))
          .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
          .slice(0, limit),
      );
    },
    async messagesByIds(ids) {
      await wait(40);
      return clone(db.messages.filter((m) => ids.includes(m.id)));
    },
    async reactions(ids) {
      await wait(40);
      return clone(db.reactions.filter((r) => ids.includes(r.message_id)));
    },

    async sendFriendRequest(target) {
      await wait();
      const q = String(target || '').replace(/^@/, '').toLowerCase();
      const p = db.profiles.find((x) => x.friend_code.toLowerCase() === q || x.username.toLowerCase() === q);
      if (!p) throw fail('user_not_found', 'P0002');
      if (p.id === ME) throw fail('cannot_add_self', '22023');
      const row = db.friendships.find((f) => (f.requester === p.id && f.addressee === ME) || (f.requester === ME && f.addressee === p.id));
      if (row?.status === 'accepted') return { result: 'already_friends', user_id: p.id };
      if (row?.status === 'pending' && row.requester === ME) return { result: 'already_sent', user_id: p.id };
      if (row?.status === 'pending') {
        row.status = 'accepted';
        return { result: 'accepted', user_id: p.id };
      }
      const f = { id: `f-${Date.now()}`, requester: ME, addressee: p.id, status: 'pending', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      db.friendships.push(f);
      return { result: 'sent', user_id: p.id };
    },
    async respondRequest(other, accept) {
      await wait();
      const row = db.friendships.find((f) => f.requester === other && f.addressee === ME && f.status === 'pending');
      if (!row) throw fail('request_not_found', 'P0002');
      if (accept) {
        row.status = 'accepted';
        row.updated_at = new Date().toISOString();
        if (!db.activity.some((a) => a.user_id === other)) db.activity.push({ user_id: other, status: 'online', activity: null, updated_at: new Date().toISOString() });
      } else db.friendships.splice(db.friendships.indexOf(row), 1);
      return true;
    },
    async removeFriend(other) {
      await wait();
      const i = db.friendships.findIndex((f) => (f.requester === other || f.addressee === other) && f.status !== 'blocked');
      if (i >= 0) db.friendships.splice(i, 1);
      return i >= 0;
    },
    async block(other) {
      await wait();
      const row = db.friendships.find((f) => f.requester === other || f.addressee === other);
      if (row) Object.assign(row, { requester: ME, addressee: other, status: 'blocked' });
      else db.friendships.push({ id: `f-${Date.now()}`, requester: ME, addressee: other, status: 'blocked', created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      return true;
    },
    async unblock(other) {
      await wait();
      const i = db.friendships.findIndex((f) => f.requester === ME && f.addressee === other && f.status === 'blocked');
      if (i >= 0) db.friendships.splice(i, 1);
      return i >= 0;
    },

    async getOrCreateConversation(other) {
      await wait();
      let c = db.conversations.find((x) => otherOf(x) === other);
      if (!c) {
        c = { id: `c-${other}`, user_lo: ME, user_hi: other, created_at: new Date().toISOString(), last_message_at: null };
        db.conversations.push(c);
        db.members.push({ id: `m-${c.id}-a`, conversation_id: c.id, user_id: ME, last_read_at: c.created_at, joined_at: c.created_at });
        db.members.push({ id: `m-${c.id}-b`, conversation_id: c.id, user_id: other, last_read_at: c.created_at, joined_at: c.created_at });
      }
      return c.id;
    },
    async markRead(chatId) {
      await wait(40);
      const m = db.members.find((x) => x.conversation_id === chatId && x.user_id === ME);
      if (m) m.last_read_at = new Date().toISOString();
      return m?.last_read_at || null;
    },
    async insertMessage(row) {
      await wait(250);
      if (db.messages.some((m) => m.id === row.id)) throw fail('duplicate key value violates unique constraint "messages_pkey"', '23505');
      const out = { ...row, created_at: new Date().toISOString(), edited_at: null, deleted: false };
      db.messages.push(out);
      const c = db.conversations.find((x) => x.id === row.conversation_id);
      if (c) c.last_message_at = out.created_at;
      fire('onMessage', 'INSERT', clone(out));
      // el amigo lo lee al rato
      const other = c ? otherOf(c) : null;
      const member = db.members.find((x) => x.conversation_id === row.conversation_id && x.user_id === other);
      if (member) {
        setTimeout(() => {
          member.last_read_at = new Date().toISOString();
          handlers.onMember?.('UPDATE', clone(member));
        }, 1500);
      }
      if (autoReply && other === 'mock-tomas') replyFrom(row.conversation_id, other, '¡Dale! Te espero en el lobby 🎮', 2600);
      return clone(out);
    },
    async editMessage(id, body) {
      await wait();
      const m = db.messages.find((x) => x.id === id && x.sender_id === ME && !x.deleted);
      if (!m) return null;
      Object.assign(m, { body, edited_at: new Date().toISOString() });
      fire('onMessage', 'UPDATE', clone(m));
      return clone(m);
    },
    async deleteMessage(id) {
      await wait();
      const m = db.messages.find((x) => x.id === id && x.sender_id === ME && !x.deleted);
      if (!m) return null;
      Object.assign(m, { body: '', deleted: true, edited_at: new Date().toISOString() });
      fire('onMessage', 'UPDATE', clone(m));
      return clone(m);
    },
    async addReaction(messageId, conversationId, emoji) {
      await wait();
      if (db.reactions.some((r) => r.message_id === messageId && r.user_id === ME && r.emoji === emoji)) throw fail('duplicate key', '23505');
      const row = { id: `r-${Date.now()}`, message_id: messageId, conversation_id: conversationId, user_id: ME, emoji, created_at: new Date().toISOString() };
      db.reactions.push(row);
      fire('onReaction', 'INSERT', clone(row));
      return clone(row);
    },
    async removeReaction(id) {
      await wait();
      const i = db.reactions.findIndex((r) => r.id === id && r.user_id === ME);
      if (i >= 0) db.reactions.splice(i, 1);
      fire('onReaction', 'DELETE', { id });
      return true;
    },
    async heartbeat() {
      await wait(40);
      return new Date().toISOString();
    },
    async myModeration() {
      await wait(40);
      return clone(moderation || { muted: false, mutedUntil: null, banned: false, bannedUntil: null });
    },
    async sendSignal(target, kind) {
      await wait(40);
      if (!db.friendships.some((f) => f.status === 'accepted' && (f.requester === target || f.addressee === target))) throw fail('not_friends', '42501');
      if (kind === '_typing') return true;
      return true;
    },
    async updateProfile(patch) {
      await wait();
      const p = db.profiles.find((x) => x.id === ME);
      Object.assign(p, patch);
      return clone(p);
    },
    goOfflineBeacon() {},

    subscribe(h) {
      handlers = h || {};
      setTimeout(() => {
        handlers.onStatus?.('db', 'SUBSCRIBED');
        handlers.onStatus?.('inbox', 'SUBSCRIBED');
      }, 80);
      return {
        setPresenceFilter() {
          setTimeout(() => handlers.onStatus?.('presence', 'SUBSCRIBED'), 80);
        },
        async close() {
          handlers = {};
        },
      };
    },
  };
}

// Conecta el modulo social a este backend falso (la pagina de Mensajes se actualiza sola).
export async function install(opts = {}) {
  const { social } = await import('../social.js');
  const backend = createMockBackend(opts);
  await social._attachBackend(backend, backend.me);
  return social;
}
