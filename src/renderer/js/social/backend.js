// Acceso a datos del modulo social en Supabase (tablas y funciones de supabase/migrations/0002_social.sql).
// social.js habla solo con esta interfaz, asi que en pruebas se puede reemplazar por otra (ver devmock.js).

export const PROFILE_COLS = 'id,username,display_name,friend_code,mc_name,mc_uuid,bio,banner,badges,status_text,created_at';
const MSG_COLS = 'id,conversation_id,sender_id,body,reply_to,created_at,edited_at,deleted';
const REACTION_COLS = 'id,message_id,conversation_id,user_id,emoji,created_at';
const ACTIVITY_COLS = 'user_id,status,activity,updated_at';

// Errores de PostgREST cuando falta una tabla o una funcion (no se aplico la migracion 0002).
const MISSING_CODES = new Set(['PGRST202', 'PGRST205', '42P01', '42883']);
const CHUNK = 80;

export class SocialError extends Error {
  constructor(raw, status) {
    super(raw?.message || String(raw || 'error'));
    this.name = 'SocialError';
    this.code = String(raw?.code || '');
    this.status = typeof status === 'number' ? status : typeof raw?.status === 'number' ? raw.status : null;
    this.details = raw?.details || '';
  }

  get network() {
    return this.status === 0 || /failed to fetch|networkerror|fetch failed|network request failed|load failed|err_internet|err_network|timed? ?out/i.test(this.message);
  }

  get missingSchema() {
    return MISSING_CODES.has(this.code) || /could not find the (function|table)/i.test(this.message);
  }

  // Vale la pena reintentar mas tarde (sin red, servidor caido, limite de pedidos, token vencido).
  get retryable() {
    return this.network || this.status === 401 || this.status === 408 || this.status === 429 || (this.status || 0) >= 500;
  }
}

function unwrap(res) {
  if (res.error) throw new SocialError(res.error, res.status);
  return res.data;
}

function chunks(list, size = CHUNK) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * client: cliente de supabase-js (cloud.client). userId: usuario con sesion.
 * auth(): { url, key, token } para el aviso de desconexion al cerrar la ventana.
 */
export function createSupabaseBackend(client, userId, auth) {
  const rpc = async (fn, args) => unwrap(await client.rpc(fn, args));

  const inChunks = async (ids, run) => {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return [];
    const parts = await Promise.all(chunks(unique).map(run));
    return parts.flat();
  };

  return {
    userId,

    // ---------- Lecturas ----------
    async friendships() {
      return unwrap(await client.from('friendships').select('id,requester,addressee,status,created_at,updated_at'));
    },

    profiles(ids) {
      return inChunks(ids, async (part) => unwrap(await client.from('profiles').select(PROFILE_COLS).in('id', part)));
    },

    activities(ids) {
      return inChunks(ids, async (part) => unwrap(await client.from('user_activity').select(ACTIVITY_COLS).in('user_id', part)));
    },

    async conversations() {
      return (await rpc('social_conversations')) || [];
    },

    async messages(chatId, { before = null, limit = 40 } = {}) {
      let q = client.from('messages').select(MSG_COLS).eq('conversation_id', chatId).order('created_at', { ascending: false }).limit(limit);
      if (before) q = q.lt('created_at', before);
      return unwrap(await q) || [];
    },

    messagesByIds(ids) {
      return inChunks(ids, async (part) => unwrap(await client.from('messages').select(MSG_COLS).in('id', part)));
    },

    reactions(messageIds) {
      return inChunks(messageIds, async (part) => unwrap(await client.from('message_reactions').select(REACTION_COLS).in('message_id', part)));
    },

    // ---------- Amigos ----------
    sendFriendRequest: (target) => rpc('social_send_friend_request', { target }),
    respondRequest: (other, accept) => rpc('social_respond_friend_request', { other, accept }),
    removeFriend: (other) => rpc('social_remove_friend', { other }),
    block: (other) => rpc('social_block_user', { other }),
    unblock: (other) => rpc('social_unblock_user', { other }),

    // ---------- Conversaciones y mensajes ----------
    getOrCreateConversation: (other) => rpc('social_get_or_create_conversation', { other }),
    markRead: (chatId) => rpc('social_mark_read', { conv: chatId }),

    async insertMessage(row) {
      return unwrap(await client.from('messages').insert(row).select(MSG_COLS).single());
    },

    async editMessage(id, body) {
      return unwrap(await client.from('messages').update({ body }).eq('id', id).eq('sender_id', userId).select(MSG_COLS).maybeSingle());
    },

    async deleteMessage(id) {
      return unwrap(await client.from('messages').update({ deleted: true }).eq('id', id).eq('sender_id', userId).select(MSG_COLS).maybeSingle());
    },

    async addReaction(messageId, conversationId, emoji) {
      return unwrap(
        await client.from('message_reactions').insert({ message_id: messageId, conversation_id: conversationId, user_id: userId, emoji }).select(REACTION_COLS).single(),
      );
    },

    async removeReaction(id) {
      unwrap(await client.from('message_reactions').delete().eq('id', id).eq('user_id', userId));
      return true;
    },

    // ---------- Presencia y señales ----------
    heartbeat: (status, activity) => rpc('social_heartbeat', { p_status: status, p_activity: activity ?? null }),
    sendSignal: (target, kind, payload) => rpc('social_send_signal', { target, kind, payload: payload ?? {} }),

    // ---------- Moderacion (0012_admin.sql) ----------
    // Silencio o baneo propio: { muted, mutedUntil, banned, bannedUntil } (sin motivos ni notas)
    myModeration: () => rpc('my_moderation'),

    // Ultimo aviso de "desconectado" al cerrar la ventana (fetch keepalive: sobrevive a la descarga de la pagina).
    goOfflineBeacon() {
      try {
        const { url, key, token } = auth?.() || {};
        if (!url || !key || !token) return;
        fetch(`${url}/rest/v1/rpc/social_heartbeat`, {
          method: 'POST',
          keepalive: true,
          headers: { apikey: key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ p_status: 'offline', p_activity: null }),
        }).catch(() => {});
      } catch {
        /* la ventana se esta cerrando */
      }
    },

    // ---------- Tiempo real ----------
    // handlers: onStatus(canal, estado, err), onMessage(evento, fila), onReaction(evento, fila),
    // onMember(evento, fila), onFriendship(evento, nueva, vieja), onActivity(fila), onSignal(datos)
    subscribe(handlers) {
      const h = handlers || {};
      const stamp = Date.now().toString(36);
      let closed = false;
      const pg = (table, event, fn) => ['postgres_changes', { event, schema: 'public', table }, fn];
      const db = client.channel(`social:${userId}:${stamp}`);
      for (const args of [
        pg('messages', 'INSERT', (p) => h.onMessage?.('INSERT', p.new)),
        pg('messages', 'UPDATE', (p) => h.onMessage?.('UPDATE', p.new)),
        pg('message_reactions', 'INSERT', (p) => h.onReaction?.('INSERT', p.new)),
        pg('message_reactions', 'DELETE', (p) => h.onReaction?.('DELETE', p.old)),
        pg('conversation_members', 'INSERT', (p) => h.onMember?.('INSERT', p.new)),
        pg('conversation_members', 'UPDATE', (p) => h.onMember?.('UPDATE', p.new)),
        pg('friendships', '*', (p) => h.onFriendship?.(p.eventType, p.new, p.old)),
      ]) {
        db.on(...args);
      }
      db.subscribe((status, err) => !closed && h.onStatus?.('db', status, err));

      // Buzon personal (Broadcast privado): solo lo escucha su dueño.
      const inbox = client
        .channel(`inbox:${userId}`, { config: { private: true } })
        .on('broadcast', { event: 'signal' }, (msg) => h.onSignal?.(msg?.payload))
        .subscribe((status, err) => !closed && h.onStatus?.('inbox', status, err));

      // Presencia de los amigos: un canal aparte con filtro por ids (se rehace cuando cambia la lista).
      let presence = null;
      let presenceKey = null;
      let presenceGen = 0;
      const dropPresence = async () => {
        const old = presence;
        presence = null;
        if (old) await client.removeChannel(old).catch(() => {});
      };

      return {
        async setPresenceFilter(ids) {
          const list = [...new Set(ids)].sort();
          const key = list.join(',');
          if (closed || key === presenceKey) return;
          presenceKey = key;
          const gen = ++presenceGen;
          await dropPresence();
          if (closed || gen !== presenceGen || !list.length) return;
          const filter = list.length <= 100 ? { filter: `user_id=in.(${list.join(',')})` } : {};
          presence = client
            .channel(`social:${userId}:presence:${stamp}:${gen}`)
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'user_activity', ...filter }, (p) => h.onActivity?.(p.new))
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'user_activity', ...filter }, (p) => h.onActivity?.(p.new))
            .subscribe((status, err) => !closed && gen === presenceGen && h.onStatus?.('presence', status, err));
        },
        async close() {
          closed = true;
          presenceGen++;
          await Promise.allSettled([client.removeChannel(db), client.removeChannel(inbox), dropPresence()]);
        },
      };
    },
  };
}
