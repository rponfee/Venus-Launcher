// Acceso a datos de la app: las mismas tablas, RPC y políticas que usa el launcher (src/renderer/js/social/backend.js), más lo
// de 0035. No hay heartbeat: el celular no publica presencia ni pisa la actividad que publica el launcher.
import { isMissing } from './logic.js';

const PROFILE_COLS = 'id,username,display_name,friend_code,status_text';
const MSG_COLS = 'id,conversation_id,sender_id,body,reply_to,created_at,edited_at,deleted';
const ACTIVITY_COLS = 'user_id,status,activity,updated_at';
const MEDIA_COLS = 'id,kind,bucket,path,file_name,world,instance_name,size_bytes,taken_at,created_at,expires_at,url';
const CHUNK = 80;

export class ApiError extends Error {
  constructor(raw, status) {
    super(raw?.message || String(raw || 'error'));
    this.name = 'ApiError';
    this.code = String(raw?.code || '');
    this.status = typeof status === 'number' ? status : typeof raw?.status === 'number' ? raw.status : null;
  }

  get retryable() {
    const s = this.status;
    return s === 0 || s === 401 || s === 408 || s === 429 || (s || 0) >= 500 || /failed to fetch|networkerror|fetch failed|network request failed|load failed|timed? ?out/i.test(this.message);
  }
}

function unwrap(res) {
  if (res.error) throw new ApiError(res.error, res.status);
  return res.data;
}

function chunks(list, size = CHUNK) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export function createBackend(client, userId) {
  const rpc = async (fn, args) => unwrap(await client.rpc(fn, args));
  const inChunks = async (ids, run) => {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return [];
    return (await Promise.all(chunks(unique).map(run))).flat();
  };
  let withUntil = null;

  return {
    userId,

    // ---------- Lecturas ----------
    async friendships() {
      return unwrap(await client.from('friendships').select('id,requester,addressee,status,created_at,updated_at')) || [];
    },

    // Con la 0027 trae status_until; sin esa columna, las de siempre.
    profiles(ids) {
      return inChunks(ids, async (part) => {
        if (withUntil !== false) {
          const res = await client.from('profiles').select(`${PROFILE_COLS},status_until`).in('id', part);
          if (res.error && (res.error.code === '42703' || /status_until/.test(res.error.message || ''))) withUntil = false;
          else return unwrap(res) || [];
        }
        return unwrap(await client.from('profiles').select(PROFILE_COLS).in('id', part)) || [];
      });
    },

    activities(ids) {
      return inChunks(ids, async (part) => unwrap(await client.from('user_activity').select(ACTIVITY_COLS).in('user_id', part)) || []);
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
      return inChunks(ids, async (part) => unwrap(await client.from('messages').select(MSG_COLS).in('id', part)) || []);
    },

    // ---------- Amigos ----------
    sendFriendRequest: (target) => rpc('social_send_friend_request', { target }),
    respondRequest: (other, accept) => rpc('social_respond_friend_request', { other, accept }),
    removeFriend: (other) => rpc('social_remove_friend', { other }),

    // ---------- Mensajes ----------
    getOrCreateConversation: (other) => rpc('social_get_or_create_conversation', { other }),
    markRead: (chatId) => rpc('social_mark_read', { conv: chatId }),
    async insertMessage(row) {
      return unwrap(await client.from('messages').insert(row).select(MSG_COLS).single());
    },
    sendSignal: (target, kind, payload) => rpc('social_send_signal', { target, kind, payload: payload ?? {} }),
    myModeration: () => rpc('my_moderation'),

    // Stickers (0030). undefined = la función no está: los mensajes se ven como texto.
    async stickersAlive(ids) {
      try {
        const rows = await rpc('sticker_resolve', { p_ids: ids });
        return new Set((Array.isArray(rows) ? rows : []).map((r) => r.id));
      } catch (err) {
        if (isMissing(err)) return undefined;
        throw err;
      }
    },

    // ---------- Avisos y clips (0035) ----------
    inbox: (preview = false) => rpc('app_inbox', { p_preview: preview }),
    receivedMedia: ({ before = null, limit = 30 } = {}) => rpc('media_received_list', { p_before: before, p_limit: limit }),
    seenMedia: (ids = null) => rpc('media_received_seen', { p_ids: ids }),
    removeReceived: (id) => rpc('media_received_remove', { p_id: id }),
    async myMedia({ before = null, limit = 30 } = {}) {
      let q = client.from('shared_media').select(MEDIA_COLS).eq('owner', userId).order('created_at', { ascending: false }).limit(limit);
      if (before) q = q.lt('created_at', before);
      return unwrap(await q) || [];
    },
    // Link corto para ver lo propio cuando el del launcher venció. No toca la fila: el año de vigencia lo maneja el launcher.
    async signOwn(bucket, path) {
      const res = await client.storage.from(bucket).createSignedUrl(path, 3600);
      if (res.error) throw new ApiError(res.error, res.error?.statusCode ? Number(res.error.statusCode) : null);
      return res.data?.signedUrl || null;
    },
    // Galería pública (0032): si la función no está, no hay pestaña.
    async gallery({ sort = 'recent', offset = 0, limit = 24 } = {}) {
      try {
        return await rpc('gallery_list', { p_sort: sort, p_offset: offset, p_limit: limit });
      } catch (err) {
        if (isMissing(err)) return undefined;
        throw err;
      }
    },

    // ---------- Tiempo real ----------
    subscribe(handlers) {
      const h = handlers || {};
      const stamp = Date.now().toString(36);
      let closed = false;
      const db = client
        .channel(`app:${userId}:${stamp}`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (p) => h.onMessage?.('INSERT', p.new))
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, (p) => h.onMessage?.('UPDATE', p.new))
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'conversation_members' }, (p) => h.onMember?.('INSERT', p.new))
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'conversation_members' }, (p) => h.onMember?.('UPDATE', p.new))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships' }, (p) => h.onFriendship?.(p.eventType, p.new, p.old));
      db.subscribe((status, err) => !closed && h.onStatus?.('db', status, err));

      // Buzón personal (Broadcast privado): lo escucha solo su dueño; se manda con social_send_signal.
      const inbox = client
        .channel(`inbox:${userId}`, { config: { private: true } })
        .on('broadcast', { event: 'signal' }, (msg) => h.onSignal?.(msg?.payload));
      inbox.subscribe((status, err) => !closed && h.onStatus?.('inbox', status, err));

      let presence = null;
      let presenceKey = null;
      let presenceGen = 0;
      const dropPresence = async () => {
        const old = presence;
        presence = null;
        if (old) await Promise.resolve(client.removeChannel(old)).catch(() => {});
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
            .channel(`app:${userId}:presence:${stamp}:${gen}`)
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'user_activity', ...filter }, (p) => h.onActivity?.(p.new))
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'user_activity', ...filter }, (p) => h.onActivity?.(p.new));
          presence.subscribe((status, err) => !closed && gen === presenceGen && h.onStatus?.('presence', status, err));
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
