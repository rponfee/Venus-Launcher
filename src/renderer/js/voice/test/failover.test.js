// Cambio de camino: dos personas con el servidor principal falso (se puede cortar a medias o del todo) y brokers MQTT
// falsos. Se mide en qué tiempo se pasa al respaldo, que ningun mensaje se pierda ni llegue dos veces, que los mensajes
// falsos, repetidos o viejos no entren, y la vuelta al principal sin cortes.
// node --test "src/renderer/js/voice/test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';
import { Paths, PATHS } from '../paths.js';
import { Health, HEALTH } from '../health.js';
import { BackupLine } from '../backup.js';
import { createIdentity, importPublicKey, signText, verifyText, randomId } from '../sign.js';
import { envelopeText } from '../envelope.js';
import { deriveRoom, sealFrame } from '../seal.js';
import { MqttClient } from '../mqtt.js';
import { FakeBrokers, manualClock, settle, settled } from './fake-net.js';

const SECRET = 'KQ7MXT2PRN9WHJ4EC5VDB8YF';
const ROOM_ID = 'room-1';
const MAX_AGE = 120000; // igual que MSG_MAX_AGE de voice.js

// Servidor principal falso: 'ok' | 'down' (socket caido, todo falla) | 'silent' (el socket parece conectado pero nada contesta)
class Server {
  constructor() {
    this.mode = 'ok';
    this.nodes = new Set();
  }

  // Cambiar el estado avisa a cada cliente lo que veria el canal de Realtime
  set(mode) {
    this.mode = mode;
    for (const node of this.nodes) {
      if (mode === 'down') node.paths.channelStatus('CLOSED');
      else if (mode === 'ok') {
        node.paths.channelStatus('SUBSCRIBED');
        node.paths.primaryOpened();
      }
    }
  }
}

class Node {
  constructor(name, world, { secret = SECRET, backupOnly = false } = {}) {
    this.id = name;
    this.world = world;
    this.accepted = [];
    this.heard = new Set();
    this.rejected = [];
    this.snaps = [];
    this.seen = new Set();
    this.lastTs = new Map();
    this.secret = secret;
    const server = world.server;
    this.paths = new Paths({
      clock: world.clock,
      health: new Health(),
      backupOnly,
      primary: {
        ready: () => server.mode !== 'down',
        connected: () => server.mode !== 'down',
        send: async (event, env) => {
          if (server.mode !== 'ok') return 'error';
          for (const other of server.nodes) if (other !== this) setImmediate(() => other.deliver('primary', event, env));
          return 'ok';
        },
        probe: async () => server.mode === 'ok',
      },
      makeLine: (sec, hooks) => new BackupLine({ secret: sec, WebSocketCtor: world.brokers.WebSocket, timers: world.clock, now: world.clock.now, onFrame: hooks.onFrame, onState: hooks.onState }),
      getSecret: () => this.secret,
      needBackup: () => this.needBackup || false,
      beacon: async () => {
        const env = await this.sign('pres', { hello: this.id });
        return { event: 'pres', env };
      },
      onFrame: ({ path, event, env }) => this.deliver(path, event, env),
      onChange: (snap) => this.snaps.push(snap),
    });
  }

  async init() {
    this.identity = await createIdentity();
    this.session = randomId(20);
    this.world.keys.set(this.id, { session: this.session, key: await importPublicKey(this.identity.publicJwk) });
    this.world.server.nodes.add(this);
  }

  async sign(event, body, over = {}) {
    const env = { f: this.id, fs: this.session, to: null, tos: null, ts: this.world.clock.now(), n: randomId(14), d: JSON.stringify(body), ...over };
    env.sig = await signText(this.identity.privateKey, envelopeText(event, ROOM_ID, env));
    return env;
  }

  async say(text) {
    const env = await this.sign('chat', { text });
    const r = await this.paths.send('chat', env);
    return { env, r };
  }

  // Lo mismo que hace VoiceEngine.processEnvelope: repeticiones, antiguedad y firma con la clave que el servidor asocio
  deliver(path, event, env) {
    if (path === 'primary') this.paths.heardPrimary();
    if (env.f === this.id) return;
    return (this.chain = (this.chain || Promise.resolve()).then(async () => {
      const { f, fs, ts, n, d, sig } = env;
      const clockKey = `${f}:${fs}`;
      if (!Number.isFinite(ts) || this.seen.has(n)) return this.rejected.push(['repetido', n]);
      if (ts < (this.lastTs.get(clockKey) || 0) - MAX_AGE) return this.rejected.push(['viejo', n]);
      const known = this.world.keys.get(f);
      if (!known || known.session !== fs) return this.rejected.push(['clave desconocida', n]);
      if (!(await verifyText(known.key, envelopeText(event, ROOM_ID, env), sig))) return this.rejected.push(['firma', n]);
      this.seen.add(n);
      this.lastTs.set(clockKey, Math.max(this.lastTs.get(clockKey) || 0, ts));
      if (event === 'pres' && path === 'backup' && !this.heard.has(f)) {
        this.heard.add(f);
        this.paths.peerAppeared(f);
      }
      this.accepted.push({ path, event, from: f, text: JSON.parse(d).text, n });
    }));
  }

  chats() {
    return this.accepted.filter((m) => m.event === 'chat').map((m) => m.text);
  }
}

async function world() {
  const w = { clock: manualClock(), brokers: new FakeBrokers(), server: new Server(), keys: new Map() };
  w.pair = async (opts) => {
    const a = new Node('A', w, opts);
    const b = new Node('B', w, opts);
    await a.init();
    await b.init();
    for (const n of [a, b]) {
      n.paths.channelStatus('SUBSCRIBED');
      n.paths.start();
    }
    return { a, b };
  };
  return w;
}

const open = (w) => [...w.brokers.hosts.keys()].reduce((n, u) => n + w.brokers.count(u), 0);

test('con el servidor andando no se abre ninguna conexion a los brokers publicos', async () => {
  const w = await world();
  const { a, b } = await w.pair();
  for (let i = 1; i <= 5; i++) {
    await a.say(`m${i}`);
    await w.clock.advance(2000);
  }
  await settled();
  assert.deepEqual(b.chats(), ['m1', 'm2', 'm3', 'm4', 'm5']);
  assert.equal(open(w), 0, 'sin conexiones a brokers');
  assert.equal(a.paths.route, 'primary');
  assert.equal(a.paths.snapshot().backup, 'off');
  a.paths.stop();
  b.paths.stop();
});

test('corte total del servidor: pasa solo al respaldo en pocos segundos y la charla sigue', async () => {
  const w = await world();
  const { a, b } = await w.pair();
  await a.say('antes');
  await w.clock.advance(1000);
  const t0 = w.clock.now();
  w.server.set('down');
  let switched = null;
  for (let ms = 0; ms < 20000 && switched === null; ms += 100) {
    await w.clock.advance(100);
    if (a.paths.snapshot().backup === 'on' && b.paths.snapshot().backup === 'on') switched = w.clock.now() - t0;
  }
  assert.ok(switched !== null, 'las dos terminan en el respaldo');
  assert.ok(switched <= 8000, `cambio en ${switched} ms (tiene que ser de pocos segundos)`);
  assert.equal(a.paths.route, 'backup');
  assert.equal(a.paths.snapshot().primary, 'down');
  await a.say('durante');
  await b.say('respuesta');
  await w.clock.advance(500);
  await settled();
  assert.deepEqual(b.chats(), ['antes', 'durante']);
  assert.deepEqual(a.chats(), ['respuesta']);
  // la presencia de respaldo se publica y se escucha
  assert.ok(a.accepted.some((m) => m.event === 'pres' && m.from === 'B'), 'A vio el aviso de presencia de B');
  a.paths.stop();
  b.paths.stop();
});

test('corte silencioso (el socket parece vivo pero nada contesta): las pruebas lo detectan y se pasa al respaldo', async () => {
  const w = await world();
  const { a, b } = await w.pair();
  await w.clock.advance(5000);
  const t0 = w.clock.now();
  w.server.set('silent');
  let switched = null;
  for (let ms = 0; ms < 30000 && switched === null; ms += 100) {
    await w.clock.advance(100);
    if (a.paths.snapshot().backup === 'on' && b.paths.snapshot().backup === 'on') switched = w.clock.now() - t0;
  }
  assert.ok(switched !== null && switched <= PATHS.PROBE_MS * 2 + PATHS.PROBE_TIMEOUT_MS + 1500, `detectado en ${switched} ms`);
  await a.say('por el respaldo');
  await settled();
  assert.deepEqual(b.chats(), ['por el respaldo']);
  a.paths.stop();
  b.paths.stop();
});

test('ningun mensaje se pierde ni llega dos veces en el cambio, ni en la vuelta', async () => {
  const w = await world();
  const { a, b } = await w.pair();
  const sent = [];
  const send = async (i) => {
    sent.push(`m${i}`);
    await a.say(`m${i}`);
  };
  let n = 0;
  for (let i = 0; i < 6; i++) { await send(n++); await w.clock.advance(500); }
  w.server.set('down');
  // un mensaje por segundo mientras cae, se abre el respaldo, se normaliza
  for (let i = 0; i < 20; i++) { await send(n++); await w.clock.advance(1000); }
  w.server.set('ok'); // vuelve el servidor
  for (let i = 0; i < 50; i++) { await send(n++); await w.clock.advance(1000); }
  await settled();
  const got = b.chats();
  const lost = sent.filter((m) => !got.includes(m));
  // Lo que se dice mientras el principal ya no anda y el respaldo aun no abrio se guarda y sale apenas hay camino
  assert.deepEqual(lost, [], 'no se perdio ninguno');
  assert.equal(new Set(got).size, got.length, 'ninguno repetido');
  assert.ok(got.includes('m0') && got.includes('m6') && got.includes(`m${n - 1}`), 'llegan los de antes, durante y despues');
  assert.equal(a.paths.snapshot().primary, 'up', 'volvio al principal');
  a.paths.stop();
  b.paths.stop();
});

test('lo que se dice sin ningun camino (principal y respaldo caidos) se guarda y sale cuando vuelve uno', async () => {
  const w = await world();
  const { a, b } = await w.pair();
  w.server.set('down');
  await w.clock.advance(7000);
  assert.equal(a.paths.snapshot().backup, 'on');
  const urls = [...w.brokers.hosts.keys()];
  for (const u of urls) w.brokers.mode(u, 'down'); // los brokers tambien caen un rato
  await w.clock.advance(1500);
  const { r } = await a.say('guardado');
  assert.equal(Paths.delivered(r), false, 'no salio por ningun lado');
  assert.equal(a.paths.snapshot().queued, 1, 'quedo en la cola');
  for (const u of urls) w.brokers.mode(u, 'ok');
  await w.clock.advance(45000);
  await settled();
  assert.deepEqual(b.chats(), ['guardado']);
  assert.equal(a.paths.snapshot().queued, 0);
  a.paths.stop();
  b.paths.stop();
});

test('lo guardado se tira si pasa mas de 30 s sin camino (no se entrega algo viejo de golpe)', async () => {
  const w = await world();
  const { a, b } = await w.pair({ secret: null }); // sin clave de respaldo: no hay forma de que salga
  w.server.set('down');
  await w.clock.advance(3000);
  await a.say('viejo');
  assert.equal(a.paths.snapshot().queued, 1);
  await w.clock.advance(PATHS.QUEUE_AGE_MS + 2000);
  a.secret = SECRET; // ahora si hay respaldo
  b.secret = SECRET;
  await w.clock.advance(15000);
  await settled();
  assert.deepEqual(b.chats(), [], 'lo de hace mas de 30 s no se entrega');
  a.paths.stop();
  b.paths.stop();
});

test('el cambio es de a uno: un mensaje que sale por los dos caminos a la vez se acepta una sola vez', async () => {
  const w = await world();
  const { a, b } = await w.pair();
  // principal "a medias": el canal anda pero tambien se abrio el respaldo
  a.paths.setBackupOnly(false);
  b.needBackup = true;
  a.needBackup = true;
  await w.clock.advance(3000);
  assert.equal(a.paths.snapshot().backup, 'on');
  const { r } = await a.say('doble');
  assert.equal(r.primary, 'ok');
  assert.ok(r.backup >= 1);
  await w.clock.advance(300);
  await settled();
  assert.deepEqual(b.chats(), ['doble']);
  assert.ok(b.rejected.some(([why]) => why === 'repetido'), 'la copia sobrante se descarto');
  a.paths.stop();
  b.paths.stop();
});

test('mensajes falsos, manipulados, repetidos y viejos no entran por el respaldo', async () => {
  const w = await world();
  const { a, b } = await w.pair();
  w.server.set('down');
  await w.clock.advance(6000);
  assert.equal(b.paths.snapshot().backup, 'on');
  const room = await deriveRoom(SECRET);
  const ghost = new MqttClient({ url: b.paths.line.info()[0].url, clientId: 'ghost', WebSocketCtor: w.brokers.WebSocket, timers: w.clock, now: w.clock.now });
  const p = ghost.connect();
  await w.clock.advance(300);
  await p;
  const publish = async (env, event = 'chat') => ghost.publish(room.topic, await sealFrame(room, { e: event, v: env }, { now: w.clock.now() }));

  // 1) un miembro de la sala (con la clave del respaldo) que firma con SU propia clave y se hace pasar por A
  const intruder = await createIdentity();
  const forged = { f: 'A', fs: a.session, to: null, tos: null, ts: w.clock.now(), n: randomId(14), d: JSON.stringify({ text: 'soy A' }) };
  forged.sig = await signText(intruder.privateKey, envelopeText('chat', ROOM_ID, forged));
  await publish(forged);
  // 2) un mensaje de A bien firmado pero con el texto cambiado en el camino
  const real = await a.sign('chat', { text: 'hola' });
  await publish({ ...real, d: JSON.stringify({ text: 'cambiado' }) });
  // 3) una firma de otro tipo de evento (firmada como chat, entregada como sig)
  await publish(real, 'sig');
  // 4) de una sala distinta (mismo mensaje firmado para otra sala)
  const otherRoom = await a.sign('chat', { text: 'otra sala' });
  otherRoom.sig = await signText(a.identity.privateKey, envelopeText('chat', 'otra-sala', otherRoom));
  await publish(otherRoom);
  // 5) un sobre sin firma y basura que no es JSON de sobre
  await publish({ f: 'A', fs: a.session, ts: w.clock.now(), n: 'x1', d: '{}' });
  ghost.publish(room.topic, new Uint8Array(300));
  await w.clock.advance(500);
  await settled();
  assert.deepEqual(b.chats(), [], 'nada de lo falso se acepto');
  assert.ok(b.rejected.length >= 4, `se rechazaron ${b.rejected.length}`);

  // lo verdadero entra una vez, y reenviarlo identico (repeticion) no lo duplica
  await publish(real);
  await publish(real);
  await w.clock.advance(500);
  await settled();
  assert.deepEqual(b.chats(), ['hola']);

  // un mensaje viejo de esa misma sesion (mucho antes del ultimo) se descarta, aunque este bien firmado
  const old = await a.sign('chat', { text: 'viejo' }, { ts: real.ts - MAX_AGE - 5000 });
  await publish(old);
  await w.clock.advance(300);
  await settled();
  assert.deepEqual(b.chats(), ['hola']);
  assert.ok(b.rejected.some(([why]) => why === 'viejo'));

  // un marco grabado hace mas de 5 minutos (el broker lo repite) ni siquiera se abre
  const stale = await sealFrame(room, { e: 'chat', v: await a.sign('chat', { text: 'grabado' }) }, { now: w.clock.now() - 6 * 60 * 1000 });
  const before = b.rejected.length;
  ghost.publish(room.topic, stale);
  await w.clock.advance(300);
  await settled();
  assert.deepEqual(b.chats(), ['hola']);
  assert.equal(b.rejected.length, before, 'cortado antes de llegar al motor');
  ghost.close();
  a.paths.stop();
  b.paths.stop();
});

test('vuelta al principal: el respaldo sigue un rato abierto y despues se cierra solo, sin cortes', async () => {
  const w = await world();
  const { a, b } = await w.pair();
  w.server.set('down');
  await w.clock.advance(7000);
  assert.equal(a.paths.snapshot().backup, 'on');
  w.server.set('ok');
  // el servidor vuelve; hasta que no lleve un rato estable se queda en el respaldo
  await w.clock.advance(HEALTH.UP_STABLE - 1500);
  assert.equal(a.paths.snapshot().primary, 'down', 'todavia no se confia');
  await w.clock.advance(PATHS.PROBE_MS * HEALTH.UP_PROBES + 2000);
  assert.equal(a.paths.snapshot().primary, 'up');
  assert.equal(a.paths.route, 'both', 'principal sano y respaldo todavia abierto');
  assert.ok(open(w) > 0);
  // en esa ventana los mensajes salen por los dos caminos
  const { r } = await a.say('en la vuelta');
  assert.equal(r.primary, 'ok');
  assert.ok(r.backup >= 1);
  await w.clock.advance(PATHS.LINGER_MS + 3000);
  assert.equal(a.paths.snapshot().backup, 'off');
  assert.equal(a.paths.route, 'primary');
  assert.equal(open(w), 0, 'ya no hay conexiones a brokers');
  await a.say('ya normal');
  await w.clock.advance(300);
  await settled();
  assert.deepEqual(b.chats(), ['en la vuelta', 'ya normal']);
  a.paths.stop();
  b.paths.stop();
});

test('si alguien solo llega por el respaldo, el respaldo no se cierra al volver el principal', async () => {
  const w = await world();
  const { a, b } = await w.pair();
  a.needBackup = true;
  w.server.set('down');
  await w.clock.advance(7000);
  w.server.set('ok');
  await w.clock.advance(HEALTH.UP_STABLE + PATHS.PROBE_MS * 3 + PATHS.LINGER_MS + 5000);
  assert.equal(a.paths.snapshot().primary, 'up');
  assert.equal(a.paths.snapshot().backup, 'on', 'sigue abierto mientras haga falta');
  a.needBackup = false;
  await w.clock.advance(PATHS.POLL_MS * 3);
  assert.equal(a.paths.snapshot().backup, 'off');
  a.paths.stop();
  b.paths.stop();
});

test('un servidor que va y viene no abre y cierra el respaldo a cada rato', async () => {
  const w = await world();
  const { a, b } = await w.pair();
  for (let i = 0; i < 6; i++) {
    w.server.set('down');
    await w.clock.advance(2500);
    w.server.set('ok');
    await w.clock.advance(2500);
  }
  const opens = a.snaps.filter((s, i) => s.backup === 'connecting' && a.snaps[i - 1]?.backup === 'off').length;
  assert.ok(opens <= 2, `el respaldo se abrio ${opens} veces`);
  a.paths.stop();
  b.paths.stop();
});

test('sin clave de respaldo (servidor sin la migracion) no se puede cambiar, y se sabe', async () => {
  const w = await world();
  const { a, b } = await w.pair({ secret: null });
  w.server.set('down');
  await w.clock.advance(8000);
  const snap = a.paths.snapshot();
  assert.equal(snap.primary, 'down');
  assert.equal(snap.backup, 'off');
  assert.equal(snap.canBackup, false);
  assert.equal(open(w), 0);
  const { r } = await a.say('nadie lo oye');
  assert.equal(Paths.delivered(r), false, 'el motor lo guarda en su cola');
  a.paths.stop();
  b.paths.stop();
});

test('lo dicho justo antes de que el otro entre al respaldo le llega igual (se reenvia al aparecer)', async () => {
  const w = await world();
  const { a, b } = await w.pair();
  w.server.set('down');
  // A se entera primero (B todavia no se dio cuenta): lo que A dice ahora sale al respaldo sin que B este escuchando
  a.paths.health.force('down', w.clock.now());
  a.paths.evaluate(true);
  await w.clock.advance(1800);
  assert.equal(a.paths.snapshot().backup, 'on');
  assert.equal(b.paths.snapshot().backup, 'off');
  await a.say('dicho antes');
  await w.clock.advance(300);
  assert.deepEqual(b.chats(), []);
  // B abre el respaldo, avisa que esta y A le reenvia lo reciente
  await w.clock.advance(6000);
  assert.equal(b.paths.snapshot().backup, 'on');
  await w.clock.advance(3000);
  await settled();
  assert.deepEqual(b.chats(), ['dicho antes']);
  assert.equal(new Set(b.chats()).size, b.chats().length);
  a.paths.stop();
  b.paths.stop();
});

test('una sala de emergencia (solo respaldo) no toca el principal ni espera el cambio', async () => {
  const w = await world();
  const { a, b } = await w.pair({ backupOnly: true });
  await w.clock.advance(3000);
  assert.equal(a.paths.snapshot().backup, 'on');
  assert.equal(a.paths.snapshot().primary, 'down');
  const { r } = await a.say('sin servidor');
  assert.equal(r.primary, 'skip', 'nunca intenta el principal');
  await w.clock.advance(300);
  await settled();
  assert.deepEqual(b.chats(), ['sin servidor']);
  w.server.set('ok');
  await w.clock.advance(60000);
  assert.equal(a.paths.snapshot().backup, 'on', 'sigue en el respaldo aunque el servidor ande');
  a.paths.stop();
  b.paths.stop();
});

test('cambiar la clave de la sala (bloqueo, contraseña) reabre el respaldo con la nueva y deja afuera a quien no la tenga', async () => {
  const w = await world();
  const { a, b } = await w.pair({ backupOnly: true });
  await w.clock.advance(3000);
  a.secret = 'NNNNNNNNNNNNNNNNNNNNNNNN'; // A recibio la clave nueva; B (expulsado) sigue con la vieja
  await w.clock.advance(PATHS.POLL_MS * 2 + 3000);
  assert.equal(a.paths.snapshot().backup, 'on');
  await a.say('con la clave nueva');
  await w.clock.advance(500);
  await settled();
  assert.deepEqual(b.chats(), [], 'el que tiene la clave vieja no oye nada');
  a.paths.stop();
  b.paths.stop();
});
