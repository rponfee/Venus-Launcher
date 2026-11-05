// Linea de respaldo: dos personas se encuentran por brokers MQTT (falsos, en memoria), con un broker caido, con cortes,
// con intrusos que no tienen la clave y con mensajes repetidos por las dos conexiones.
// node --test "src/renderer/js/voice/test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';
import { BackupLine, BROKERS, BACKOFF } from '../backup.js';
import { MqttClient } from '../mqtt.js';
import { deriveRoom, sealFrame } from '../seal.js';
import { FakeBrokers, manualClock, settle, settled } from './fake-net.js';

const SECRET = 'KQ7MXT2PRN9WHJ4EC5VDB8YF';
const URLS = BROKERS.map((b) => b.url);

function peer(world, name, secret = SECRET, extra = {}) {
  const got = [];
  const states = [];
  const line = new BackupLine({ secret, WebSocketCtor: world.brokers.WebSocket, timers: world.clock, now: world.clock.now, onFrame: (f) => got.push(f), onState: (s) => states.push(s), ...extra });
  return { name, line, got, states };
}

const world = () => ({ brokers: new FakeBrokers(), clock: manualClock() });

async function until(w, fn, ms = 30000) {
  for (let t = 0; t < ms; t += 250) {
    if (fn()) return true;
    await w.clock.advance(250);
  }
  return fn();
}

test('dos personas con la misma clave se encuentran; cada mensaje llega una sola vez aunque salga por dos brokers', async () => {
  const w = world();
  const a = peer(w, 'A');
  const b = peer(w, 'B');
  await a.line.start();
  await b.line.start();
  assert.ok(await until(w, () => a.line.state === 'on' && b.line.state === 'on'));
  assert.deepEqual(a.states, ['connecting', 'on']);
  // las dos eligen los mismos brokers (el orden sale del tema)
  assert.deepEqual(a.line.info().map((l) => l.url), b.line.info().map((l) => l.url));
  assert.equal(a.line.info().length, 2);

  const env = { f: 'a', fs: 's', ts: 1, n: 'n1', d: '{}', sig: 'x' };
  assert.equal(await a.line.send('sig', env), 2, 'salio por las dos conexiones');
  await settled();
  assert.equal(b.got.length, 1, 'llega una sola vez');
  assert.deepEqual(b.got[0].env, env);
  assert.equal(b.got[0].event, 'sig');
  assert.equal(a.got.length, 0, 'no se escucha a si mismo');
  await a.line.send('chat', { ...env, n: 'n2' });
  await b.line.send('chat', { ...env, f: 'b', n: 'n3' });
  await settled();
  assert.equal(b.got.length, 2);
  assert.equal(a.got.length, 1);
  a.line.stop();
  b.line.stop();
});

test('quien no tiene la clave no recibe nada, y lo que mete sin la clave se ignora', async () => {
  const w = world();
  const a = peer(w, 'A');
  const intruder = peer(w, 'X', 'ZZZZZZZZZZZZZZZZZZZZZZZZ');
  await a.line.start();
  await intruder.line.start();
  assert.ok(await until(w, () => a.line.state === 'on' && intruder.line.state === 'on'));
  await a.line.send('sig', { f: 'a', fs: 's', ts: 1, n: 'n1', d: '{}', sig: 'x' });
  await settled();
  assert.equal(intruder.got.length, 0, 'el intruso no ve nada');

  // el intruso conoce el tema (lo ve en el broker) pero no la clave: publica basura y un marco cifrado con otra clave
  const topic = (await deriveRoom(SECRET)).topic;
  const raw = new MqttClient({ url: a.line.info()[0].url, clientId: 'x', WebSocketCtor: w.brokers.WebSocket, timers: w.clock, now: w.clock.now });
  const p = raw.connect();
  await w.clock.advance(300);
  await p;
  raw.publish(topic, crypto.getRandomValues(new Uint8Array(400)));
  const foreign = await sealFrame(await deriveRoom('ZZZZZZZZZZZZZZZZZZZZZZZZ'), { e: 'sig', v: { f: 'x' } }, { now: w.clock.now() });
  raw.publish(topic, foreign);
  await settled();
  assert.equal(a.got.length, 0, 'ni basura ni marcos de otra clave llegan al motor');
  assert.ok(w.brokers.log.every((l) => !Buffer.from(l.bytes).toString('latin1').includes('"f":"a"')), 'el broker nunca ve el contenido');
  raw.close();
  a.line.stop();
  intruder.line.stop();
});

test('un broker apagado no separa a nadie: usan el siguiente y siguen encontrandose', async () => {
  const w = world();
  const probe = peer(w, 'P');
  await probe.line.start();
  const first = probe.line.info()[0].url;
  probe.line.stop();
  w.brokers.mode(first, 'down');
  const a = peer(w, 'A');
  const b = peer(w, 'B');
  await a.line.start();
  await b.line.start();
  assert.ok(await until(w, () => a.line.state === 'on' && b.line.state === 'on', 60000));
  assert.ok(await until(w, () => a.line.info().every((l) => l.state === 'on') && b.line.info().every((l) => l.state === 'on'), 60000), 'las dos conexiones terminan arriba, en brokers que andan');
  assert.ok(a.line.info().every((l) => l.url !== first));
  assert.deepEqual(a.line.info().map((l) => l.url).sort(), b.line.info().map((l) => l.url).sort(), 'terminan en los mismos');
  await a.line.send('sig', { f: 'a', fs: 's', ts: 1, n: 'n1', d: '{}', sig: 'x' });
  await settled();
  assert.equal(b.got.length, 1);
  a.line.stop();
  b.line.stop();
});

test('un corte de un broker no corta la señalizacion; al volver se reconecta solo', async () => {
  const w = world();
  const a = peer(w, 'A');
  const b = peer(w, 'B');
  await a.line.start();
  await b.line.start();
  assert.ok(await until(w, () => a.line.info().every((l) => l.state === 'on') && b.line.info().every((l) => l.state === 'on')));
  const [u0] = a.line.info().map((l) => l.url);
  w.brokers.mode(u0, 'down'); // se cae y corta lo abierto
  await settled();
  assert.equal(a.line.state, 'on', 'sigue por la otra conexion');
  await a.line.send('sig', { f: 'a', fs: 's', ts: 1, n: 'n1', d: '{}', sig: 'x' });
  await settled();
  assert.equal(b.got.length, 1, 'llega por la que queda');
  w.brokers.mode(u0, 'ok');
  assert.ok(await until(w, () => a.line.info().every((l) => l.state === 'on'), 60000), 'vuelve a tener las dos');
  assert.ok(BACKOFF.length >= 4);
  a.line.stop();
  b.line.stop();
});

test('con todos los brokers caidos queda en "connecting" reintentando, y al volver pasa a "on"', async () => {
  const w = world();
  for (const u of URLS) w.brokers.mode(u, 'down');
  const a = peer(w, 'A');
  await a.line.start();
  await w.clock.advance(20000);
  assert.equal(a.line.state, 'connecting');
  assert.equal(await a.line.send('sig', {}), 0, 'no hay por donde salir');
  for (const u of URLS) w.brokers.mode(u, 'ok');
  assert.ok(await until(w, () => a.line.state === 'on', 60000));
  assert.deepEqual(a.states, ['connecting', 'on']);
  a.line.stop();
});

test('detener cierra todo, no vuelve a avisar y se puede arrancar de nuevo', async () => {
  const w = world();
  const a = peer(w, 'A');
  await a.line.start();
  assert.ok(await until(w, () => a.line.state === 'on'));
  a.line.stop();
  assert.equal(a.line.state, 'off');
  assert.deepEqual(a.states, ['connecting', 'on', 'off']);
  assert.equal(URLS.reduce((n, u) => n + w.brokers.count(u), 0), 0, 'sin conexiones abiertas');
  assert.equal(await a.line.send('sig', {}), 0);
  await w.clock.advance(60000);
  assert.deepEqual(a.states, ['connecting', 'on', 'off'], 'sin reintentos despues de detener');
  await a.line.start();
  assert.ok(await until(w, () => a.line.state === 'on'));
  a.line.stop();
});

test('los brokers de una sala se reparten segun su clave (no hay uno solo que cargue con todo)', async () => {
  const w = world();
  const first = new Map();
  for (let i = 0; i < 24; i++) {
    const secret = `ABCDEFGHJKLMNPQRSTUVW${String(100 + i)}`.slice(0, 24);
    const p = peer(w, secret, secret);
    await p.line.start();
    const url = p.line.info()[0].url;
    first.set(url, (first.get(url) || 0) + 1);
    p.line.stop();
  }
  assert.ok(first.size >= 2, 'mas de un broker como primero');
  assert.ok(!first.has('wss://broker-cn.emqx.io:8084/mqtt'), 'el de reserva solo se usa si los demas fallan');
});

test('una inundacion de marcos se corta: pasan a lo sumo 400 por segundo y despues sigue andando', async () => {
  const w = world();
  const a = peer(w, 'A');
  await a.line.start();
  assert.ok(await until(w, () => a.line.state === 'on'));
  const room = await deriveRoom(SECRET);
  const raw = new MqttClient({ url: a.line.info()[0].url, clientId: 'flood', WebSocketCtor: w.brokers.WebSocket, timers: w.clock, now: w.clock.now });
  const p = raw.connect();
  await w.clock.advance(300);
  await p;
  for (let i = 0; i < 700; i++) raw.publish(room.topic, await sealFrame(room, { e: 'chat', v: { f: 'x', fs: 's', ts: 1, n: `n${i}`, d: '{}', sig: 'x' } }, { now: w.clock.now() }));
  await settled(120);
  assert.ok(a.got.length > 0 && a.got.length <= 400, `pasaron ${a.got.length}`);
  await w.clock.advance(1500);
  raw.publish(room.topic, await sealFrame(room, { e: 'chat', v: { f: 'x', fs: 's', ts: 1, n: 'despues', d: '{}', sig: 'x' } }, { now: w.clock.now() }));
  await settled();
  assert.ok(a.got.some((m) => m.env.n === 'despues'), 'al segundo siguiente vuelve a recibir');
  raw.close();
  a.line.stop();
});
