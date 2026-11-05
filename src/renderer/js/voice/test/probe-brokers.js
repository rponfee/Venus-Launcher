// Herramienta para quien mantiene el respaldo: dice cuales de los brokers publicos de voice/backup.js contestan hoy
// (conectar, suscribir, publicar 300 B y 60 KB y recibirlos). Los brokers gratuitos aparecen y desaparecen: correr esto antes de
// cada version y cambiar BROKERS si alguno dejo de andar. No es una prueba automatica (usa la red de verdad).
//   node src/renderer/js/voice/test/probe-brokers.js
import { MqttClient } from '../mqtt.js';
import { BROKERS } from '../backup.js';

const topic = `vv1/sonda-${Math.random().toString(16).slice(2, 12)}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe(b) {
  const t0 = Date.now();
  const make = (name) => new MqttClient({ url: b.url, username: b.username, password: b.password, clientId: `vv-sonda-${name}-${Math.random().toString(16).slice(2, 8)}`, connectTimeout: 10000 });
  const a = make('a');
  const c = make('b');
  try {
    await a.connect();
    const connectMs = Date.now() - t0;
    await c.connect();
    await a.subscribe(topic);
    const out = { url: b.url, spare: Boolean(b.spare), connectMs };
    for (const size of [300, 60000]) {
      const got = new Promise((res) => (a.onMessage = (_t, bytes) => res(bytes.length)));
      const t1 = Date.now();
      c.publish(topic, new Uint8Array(size).fill(7));
      const n = await Promise.race([got, wait(6000).then(() => null)]);
      out[`b${size}`] = n === size ? `${Date.now() - t1} ms` : 'no llego';
    }
    return out;
  } catch (err) {
    return { url: b.url, spare: Boolean(b.spare), error: `${err.code || ''} ${err.message}`.trim() };
  } finally {
    a.close();
    c.close();
  }
}

for (const b of BROKERS) console.log(JSON.stringify(await probe(b)));
process.exit(0);
