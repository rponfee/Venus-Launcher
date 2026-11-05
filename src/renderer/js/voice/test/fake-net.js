// Piezas falsas para probar el camino de respaldo sin red: un reloj manual, un "broker MQTT" en memoria con su
// WebSocket falso y un servidor principal que se puede cortar. No son pruebas (no termina en .test.js): las usan
// backup.test.js, failover.test.js y la prueba de la ventana de Electron (voice/test/window-failover.js), por eso
// no importa nada de Node.
import { PacketReader, T, packet, concat, str, parsePublish, publishPacket } from '../mqtt.js';

// Reloj manual: setTimeout/setInterval que solo corren con advance(ms); now() es el mismo reloj
export function manualClock(start = 1_700_000_000_000) {
  let t = start;
  let seq = 0;
  const jobs = new Map();
  const clock = {
    now: () => t,
    setTimeout(fn, ms = 0) {
      const id = ++seq;
      jobs.set(id, { at: t + Math.max(0, ms), fn, every: 0 });
      return id;
    },
    setInterval(fn, ms) {
      const id = ++seq;
      jobs.set(id, { at: t + Math.max(1, ms), fn, every: Math.max(1, ms) });
      return id;
    },
    clearTimeout(id) {
      jobs.delete(id);
    },
    clearInterval(id) {
      jobs.delete(id);
    },
    // Avanza el reloj corriendo, en orden, lo que venza. Entre paso y paso deja correr las promesas.
    async advance(ms, step = 50) {
      const end = t + ms;
      while (t < end) {
        const next = Math.min(end, t + step);
        t = next;
        for (const [id, j] of [...jobs]) {
          if (!jobs.has(id) || j.at > t) continue;
          if (j.every) j.at = t + j.every;
          else jobs.delete(id);
          j.fn();
        }
        await settle();
      }
    },
    get pending() {
      return jobs.size;
    },
  };
  return clock;
}

// Deja correr las promesas y microtareas pendientes (varias vueltas: las cadenas de await son largas)
export async function settle(n = 12) {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediateOrTimeout(r));
}

// Igual, pero ademas espera un poco de tiempo real: el cifrado y las firmas (WebCrypto) corren fuera del hilo y no
// terminan en una vuelta. Para afirmar que algo llego (o que no llego) despues de mandarlo.
export async function settled(ms = 40) {
  await settle();
  await new Promise((r) => setTimeout(r, ms));
  await settle();
}
const setImmediateOrTimeout = (fn) => (typeof setImmediate === 'function' ? setImmediate(fn) : setTimeout(fn, 0));

// Broker MQTT en memoria. Cada URL es un "broker" distinto (no comparten nada, como los publicos de verdad).
// Se puede apagar (rechaza), dejar mudo (acepta pero no entrega) o cortar las conexiones abiertas.
export class FakeBrokers {
  constructor() {
    this.hosts = new Map(); // url -> { subs: Map<topic, Set<conn>>, conns: Set<conn>, mode: 'ok'|'down'|'mute' }
    this.log = []; // { url, topic, bytes }
    const self = this;
    this.WebSocket = class FakeWebSocket {
      constructor(url) {
        this.url = url;
        this.readyState = 0;
        this.binaryType = 'blob';
        this.onopen = this.onmessage = this.onclose = this.onerror = null;
        this.conn = { ws: this, subs: new Set(), reader: new PacketReader(), host: self.host(url), alive: true };
        setImmediateOrTimeout(() => self.open(this.conn));
      }

      send(bytes) {
        if (this.readyState !== 1) throw new Error('socket not open');
        self.receive(this.conn, bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes);
      }

      close() {
        if (this.readyState === 3) return;
        this.readyState = 3;
        self.drop(this.conn);
      }
    };
  }

  host(url) {
    if (!this.hosts.has(url)) this.hosts.set(url, { subs: new Map(), conns: new Set(), mode: 'ok' });
    return this.hosts.get(url);
  }

  mode(url, mode) {
    const h = this.host(url);
    h.mode = mode;
    if (mode === 'down') for (const c of [...h.conns]) this.kill(c);
  }

  // Corta todas las conexiones abiertas de un broker (el cliente ve un cierre)
  cut(url) {
    for (const c of [...this.host(url).conns]) this.kill(c);
  }

  cutAll() {
    for (const url of this.hosts.keys()) this.cut(url);
  }

  count(url) {
    return this.host(url).conns.size;
  }

  open(conn) {
    const ws = conn.ws;
    if (ws.readyState === 3) return;
    if (conn.host.mode === 'down') {
      ws.readyState = 3;
      ws.onerror?.({});
      ws.onclose?.({});
      return;
    }
    ws.readyState = 1;
    conn.host.conns.add(conn);
    ws.onopen?.({});
  }

  kill(conn) {
    const ws = conn.ws;
    this.drop(conn);
    if (ws.readyState !== 3) {
      ws.readyState = 3;
      ws.onclose?.({});
    }
  }

  drop(conn) {
    conn.alive = false;
    conn.host.conns.delete(conn);
    for (const t of conn.subs) conn.host.subs.get(t)?.delete(conn);
  }

  reply(conn, bytes) {
    if (!conn.alive || conn.ws.readyState !== 1) return;
    setImmediateOrTimeout(() => {
      if (conn.alive && conn.ws.readyState === 1) conn.ws.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
    });
  }

  receive(conn, bytes) {
    for (const p of conn.reader.push(bytes)) {
      if (p.type === T.CONNECT) this.reply(conn, packet(T.CONNACK, 0, Uint8Array.of(0, 0)));
      else if (p.type === T.SUBSCRIBE) {
        const id = [p.body[0], p.body[1]];
        let at = 2;
        const codes = [];
        while (at < p.body.length) {
          const len = (p.body[at] << 8) | p.body[at + 1];
          const topic = new TextDecoder().decode(p.body.subarray(at + 2, at + 2 + len));
          at += 2 + len + 1;
          if (!conn.host.subs.has(topic)) conn.host.subs.set(topic, new Set());
          conn.host.subs.get(topic).add(conn);
          conn.subs.add(topic);
          codes.push(0);
        }
        this.reply(conn, packet(T.SUBACK, 0, Uint8Array.of(...id, ...codes)));
      } else if (p.type === T.PUBLISH) {
        const m = parsePublish(p);
        this.log.push({ url: conn.ws.url, topic: m.topic, bytes: m.payload });
        if (conn.host.mode === 'mute') continue;
        for (const other of conn.host.subs.get(m.topic) || []) {
          if (other.alive) this.reply(other, publishPacket(m.topic, m.payload)); // el broker tambien le devuelve al que publica
        }
      } else if (p.type === T.PINGREQ) {
        if (conn.host.mode !== 'deaf') this.reply(conn, packet(T.PINGRESP, 0));
      } else if (p.type === T.DISCONNECT) this.drop(conn);
    }
  }
}

// Servidor principal falso (lo que hace la nube de Venus para la voz): salas con codigo, claves de sesion, un canal con
// presencia y broadcast entre clientes, RPC que responden o fallan y un corte total (setDown). Cada cliente es el
// "backend" de un VoiceEngine({ backend }) en la prueba de la ventana (voice/test/window-failover.js).
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export class FakeCloud {
  constructor() {
    this.down = false;
    this.rooms = new Map(); // codigo -> sala
    this.channels = new Set();
    this.rpcLog = [];
    this.seq = 0;
    this.secrets = true; // false = el servidor no tiene la migracion 0047
  }

  setDown(down) {
    this.down = down;
    for (const ch of this.channels) ch.serverState(down ? 'CLOSED' : 'SUBSCRIBED');
  }

  client(user) {
    const cloud = this;
    const client = {
      user,
      realtime: { isConnected: () => !cloud.down },
      functions: { invoke: async () => ({ data: { iceServers: [], expiresAt: null }, error: null }) },
      getChannels: () => [...cloud.channels].filter((c) => c.client === client),
      removeChannel: async (ch) => {
        ch.dispose();
        cloud.channels.delete(ch);
        return 'ok';
      },
      channel: (topic) => new FakeChannel(cloud, client, topic),
      rpc: async (name, args) => cloud.rpc(user, name, args || {}),
    };
    return client;
  }

  newCode() {
    let n = ++this.seq * 7919 + 13;
    let out = '';
    for (let i = 0; i < 6; i++) {
      out += ALPHA[n % 32];
      n = Math.floor(n / 32) + i * 5 + 3;
    }
    return out;
  }

  async rpc(user, name, args) {
    this.rpcLog.push({ user: user.id, name });
    if (this.down) return { data: null, error: { message: 'TypeError: Failed to fetch', code: '' }, status: 0 };
    const ok = (data) => ({ data, error: null, status: 200 });
    const byId = (id) => [...this.rooms.values()].find((r) => r.id === id);
    if (name === 'voice_create_room') {
      const code = this.newCode();
      const id = `00000000-0000-4000-8000-${String(this.seq).padStart(12, '0')}`;
      const room = { id, code, name: args.p_name, owner: user.id, members: new Map(), secret: Array.from({ length: 24 }, (_, i) => ALPHA[(this.seq * 31 + i * 7) % 32]).join('') };
      this.rooms.set(code, room);
      return ok({ room: this.json(room, user) });
    }
    if (name === 'voice_join') {
      const room = this.rooms.get(args.p_code);
      if (!room) return ok({ error: 'not_found' });
      room.members.set(user.id, { session: args.p_session, key: args.p_key, lastSeen: Date.now(), name: user.name, joinedAt: Date.now() });
      return ok({ room: this.json(room, user) });
    }
    if (name === 'voice_heartbeat') return ok({ room: this.json(byId(args.p_room), user) });
    if (name === 'voice_leave') return ok({});
    if (name === 'voice_member_keys') {
      const room = byId(args.p_room);
      return ok({ members: [...(room?.members || [])].map(([uid, m]) => ({ user_id: uid, session: m.session, key: m.key, name: m.name, avatar: null, joined_at: m.joinedAt })) });
    }
    if (name === 'voice_fallback_secret') {
      if (!this.secrets) return { data: null, error: { message: 'Could not find the function public.voice_fallback_secret', code: 'PGRST202' }, status: 404 };
      const room = byId(args.p_room);
      return ok(room && room.members.has(user.id) ? { secret: room.secret } : { error: 'not_member' });
    }
    return ok({});
  }

  json(room, user) {
    return { id: room.id, code: room.code, name: room.name, owner: room.owner, is_owner: room.owner === user.id, is_private: true, has_password: false, max_members: 8, is_locked: false, created_at: new Date().toISOString(), last_active: new Date().toISOString(), active: room.members.size, people: [] };
  }
}

class FakeChannel {
  constructor(cloud, client, topic) {
    this.cloud = cloud;
    this.client = client;
    this.topic = `realtime:${topic}`;
    this.sub = topic;
    this.handlers = { presence: [], broadcast: [] };
    this.cb = null;
    this.tracked = null;
    this.state = 'closed';
  }

  on(type, filter, fn) {
    this.handlers[type]?.push({ event: filter?.event, fn });
    return this;
  }

  subscribe(cb) {
    this.cb = cb;
    this.cloud.channels.add(this);
    setImmediateOrTimeout(() => {
      if (this.cloud.down) cb('CHANNEL_ERROR', new Error('socket down'));
      else {
        this.state = 'joined';
        cb('SUBSCRIBED');
      }
    });
    return this;
  }

  serverState(status) {
    if (!this.cb) return;
    this.state = status === 'SUBSCRIBED' ? 'joined' : 'closed';
    this.cb(status);
    if (status === 'SUBSCRIBED') this.cloud.presenceSync(this.sub);
  }

  async send({ type, event, payload }) {
    if (this.cloud.down) return 'error';
    if (type !== 'broadcast') return 'ok';
    for (const ch of this.cloud.channels) {
      if (ch === this || ch.sub !== this.sub || ch.state !== 'joined') continue;
      for (const h of ch.handlers.broadcast) if (h.event === event) setImmediateOrTimeout(() => h.fn({ payload: JSON.parse(JSON.stringify(payload)) }));
    }
    return 'ok';
  }

  async track(state) {
    if (this.cloud.down) return 'error';
    this.tracked = state;
    this.cloud.presenceSync(this.sub);
    return 'ok';
  }

  async untrack() {
    this.tracked = null;
    this.cloud.presenceSync(this.sub);
    return 'ok';
  }

  presenceState() {
    const out = {};
    for (const ch of this.cloud.channels) if (ch.sub === this.sub && ch.tracked && ch.state === 'joined') out[ch.client.user.id] = [JSON.parse(JSON.stringify(ch.tracked))];
    return out;
  }

  dispose() {
    this.cb = null;
    this.state = 'closed';
    this.tracked = null;
  }
}

FakeCloud.prototype.presenceSync = function presenceSync(sub) {
  for (const ch of this.channels) {
    if (ch.sub !== sub || ch.state !== 'joined') continue;
    for (const h of ch.handlers.presence) setImmediateOrTimeout(() => h.fn());
  }
};

export { concat, str };
