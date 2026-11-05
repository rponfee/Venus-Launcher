// Camino de respaldo del Voice Chat: la señalizacion (ofertas, respuestas, candidatos ICE, chat, presencia...) viaja
// cifrada y firmada por brokers MQTT publicos cuando el servidor de Venus no responde. El audio nunca pasa por aca:
// sigue yendo directo entre las personas por WebRTC.
//
// Cada sala usa dos conexiones a la vez, a brokers distintos elegidos con un hash del tema (todos los miembros
// eligen los mismos), y publica por las dos: si uno se cae, se bloquea o esta lento, el otro sigue y nadie queda
// separado. Los marcos repetidos (llegan por las dos) se descartan por su IV.
import { MqttClient } from './mqtt.js';
import { deriveRoom, sealFrame, openFrame } from './seal.js';

// Brokers publicos gratuitos con MQTT sobre WebSocket seguro (probados el 5/11/2026, ver docs/voice-turn.md).
// El orden de preferencia sale del tema, asi que no hay uno "principal" que concentre todo el trafico; los "spare" solo
// se usan si los demas no contestan. test.mosquitto.org:8081 y mqtt.eclipseprojects.io no respondian ese dia.
// "public"/"public" son las credenciales abiertas que publica shiftr.io para su instancia publica (no es un secreto).
export const BROKERS = [
  { url: 'wss://broker.emqx.io:8084/mqtt' },
  { url: 'wss://broker.hivemq.com:8884/mqtt' },
  { url: 'wss://public.cloud.shiftr.io', username: 'public', password: 'public' },
  { url: 'wss://broker-cn.emqx.io:8084/mqtt', spare: true },
];
export const DEFAULT_LINES = 2;
export const BACKOFF = [1000, 2000, 4000, 8000, 15000];
const SEEN_MAX = 1500;
const RX_PER_SECOND = 400; // mas marcos que esto por segundo se descartan sin abrirlos (un broker o un intruso que inunda)
const asBroker = (b) => (typeof b === 'string' ? { url: b } : b);

const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');

// Entero estable a partir del tema (todos los clientes de la sala obtienen el mismo orden de brokers)
function topicHash(topic) {
  let h = 2166136261;
  for (let i = 0; i < topic.length; i++) h = Math.imul(h ^ topic.charCodeAt(i), 16777619) >>> 0;
  return h;
}

export class BackupLine {
  // opts: { secret, brokers, lines, WebSocketCtor, timers, now, onFrame({ event, env, t, line }), onState(state), connectTimeout }
  constructor(opts) {
    this.secret = opts.secret;
    this.brokers = (opts.brokers?.length ? opts.brokers : BROKERS).map(asBroker);
    this.want = Math.max(1, Math.min(opts.lines || DEFAULT_LINES, this.brokers.length));
    this.WS = opts.WebSocketCtor;
    this.timers = opts.timers || globalThis;
    this.now = opts.now || (() => Date.now());
    this.onFrame = opts.onFrame;
    this.onStateCb = opts.onState;
    this.connectTimeout = opts.connectTimeout || 9000; // HiveMQ tarda entre 1 y 6 s en aceptar
    this.room = null;
    this.order = [];
    this.lines = [];
    this.seen = new Set();
    this.rxAt = 0;
    this.rxCount = 0;
    this.stopped = true;
    this.state = 'off';
  }

  async start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.room = await deriveRoom(this.secret);
    if (this.stopped) return;
    // Los habituales se rotan segun el tema (todos los miembros de la sala eligen igual); los de reserva van al final
    const core = this.brokers.filter((b) => !b.spare);
    const shift = topicHash(this.room.topic) % (core.length || 1);
    this.order = [...core.map((_, i) => core[(i + shift) % core.length]), ...this.brokers.filter((b) => b.spare)];
    this.lines = Array.from({ length: this.want }, (_, i) => ({ idx: i, cursor: i, url: this.order[i].url, client: null, state: 'idle', tries: 0, timer: null, since: 0 }));
    this.setState('connecting');
    for (const line of this.lines) this.connect(line);
  }

  stop() {
    this.stopped = true;
    for (const line of this.lines) {
      this.timers.clearTimeout(line.timer);
      line.timer = null;
      const c = line.client;
      line.client = null;
      line.state = 'idle';
      if (c) {
        c.onClose = null;
        c.onMessage = null;
        c.close();
      }
    }
    this.lines = [];
    this.setState('off');
  }

  setState(next) {
    if (next === this.state) return;
    this.state = next;
    try {
      this.onStateCb?.(next);
    } catch (err) {
      console.warn('[voice] respaldo', err);
    }
  }

  // 'on' en cuanto una de las conexiones esta suscripta; 'connecting' si ninguna lo esta todavia
  refresh() {
    if (this.stopped) return this.setState('off');
    this.setState(this.lines.some((l) => l.state === 'on') ? 'on' : 'connecting');
  }

  connect(line) {
    if (this.stopped || line.client) return;
    const broker = this.order[line.cursor % this.order.length];
    line.url = broker.url;
    line.state = 'connecting';
    const client = new MqttClient({ url: broker.url, username: broker.username, password: broker.password, clientId: `vv-${hex(8)}`, keepAlive: 30, connectTimeout: this.connectTimeout, WebSocketCtor: this.WS, timers: this.timers, now: this.now });
    line.client = client;
    client.onMessage = (topic, bytes) => this.receive(line, topic, bytes);
    client.onClose = () => this.lost(line, client);
    client
      .connect()
      .then(() => client.subscribe(this.room.topic))
      .then(() => {
        if (this.stopped || line.client !== client) return;
        line.state = 'on';
        line.since = this.now();
        this.refresh();
      })
      .catch(() => this.lost(line, client));
  }

  // Se cayo o no pudo conectar: espera (cada vez mas) y reintenta; despues de dos fallos seguidos prueba otro broker
  lost(line, client) {
    if (this.stopped || line.client !== client) return;
    line.client = null;
    client.onClose = null;
    client.onMessage = null;
    client.close();
    const stable = line.state === 'on' && this.now() - line.since > 30000;
    line.state = 'wait';
    line.tries = stable ? 1 : line.tries + 1;
    if (line.tries > 2) line.cursor = this.nextCursor(line);
    this.refresh();
    const wait = BACKOFF[Math.min(line.tries - 1, BACKOFF.length - 1)];
    this.timers.clearTimeout(line.timer);
    line.timer = this.timers.setTimeout(() => {
      line.timer = null;
      this.connect(line);
    }, wait);
  }

  // Siguiente broker de la lista que ninguna otra conexion este usando (si hay alguno libre)
  nextCursor(line) {
    const used = new Set(this.lines.filter((l) => l !== line).map((l) => this.order[l.cursor % this.order.length].url));
    for (let step = 1; step <= this.order.length; step++) {
      const c = (line.cursor + step) % this.order.length;
      if (!used.has(this.order[c].url)) return c;
    }
    return line.cursor;
  }

  remember(id) {
    this.seen.add(id);
    if (this.seen.size > SEEN_MAX) {
      let drop = this.seen.size - Math.floor(SEEN_MAX * 0.7);
      for (const k of this.seen) {
        if (drop-- <= 0) break;
        this.seen.delete(k);
      }
    }
  }

  async receive(line, topic, bytes) {
    if (this.stopped || topic !== this.room.topic) return;
    const sec = Math.floor(this.now() / 1000);
    if (sec !== this.rxAt) {
      this.rxAt = sec;
      this.rxCount = 0;
    }
    if (++this.rxCount > RX_PER_SECOND) return;
    const frame = await openFrame(this.room, bytes, { now: this.now() });
    if (!frame || this.stopped || this.seen.has(frame.id)) return;
    this.remember(frame.id);
    const { e, v, t } = frame.obj;
    if (typeof e !== 'string' || e.length > 16 || !v || typeof v !== 'object') return;
    try {
      this.onFrame?.({ event: e, env: v, t, line: line.idx });
    } catch (err) {
      console.warn('[voice] respaldo', err?.message || err);
    }
  }

  // Cifra una vez y publica por todas las conexiones abiertas. Devuelve cuantas lo aceptaron (0 = no salio por ninguna).
  async send(event, env) {
    if (this.stopped || !this.room) return 0;
    const frame = await sealFrame(this.room, { e: event, v: env }, { now: this.now() });
    if (this.stopped) return 0;
    this.remember(
      [...frame.subarray(1, 13)]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(''),
    );
    let sent = 0;
    for (const line of this.lines) if (line.state === 'on' && line.client?.publish(this.room.topic, frame)) sent++;
    return sent;
  }

  info() {
    return this.lines.map((l) => ({ url: l.url, state: l.state }));
  }
}
