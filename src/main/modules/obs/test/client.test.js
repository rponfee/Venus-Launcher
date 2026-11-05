'use strict';
// Cliente de obs-websocket v5 con un socket falso: autenticacion, identificacion, pedidos y eventos. Y las reglas.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { ObsClient, OP, SUBPROTOCOL, SUBSCRIPTIONS, CLOSE_AUTH_FAILED, CLOSE_RPC_UNSUPPORTED, authResponse } = require('../client');
const logic = require('../logic');

// Hace de OBS. script(socket, msg) contesta los mensajes.
function fakeWs({ hello = { obsWebSocketVersion: '5.5.0', rpcVersion: 1 }, onMessage } = {}) {
  const sockets = [];
  class FakeSocket {
    constructor(url, protocol) {
      this.url = url;
      this.protocol = protocol;
      this.sent = [];
      this.closed = false;
      sockets.push(this);
      setImmediate(() => this.fromServer({ op: OP.Hello, d: hello }));
    }

    fromServer(msg) {
      this.onmessage?.({ data: JSON.stringify(msg) });
    }

    closeFromServer(code, reason = '') {
      this.closed = true;
      this.onclose?.({ code, reason });
    }

    send(text) {
      const msg = JSON.parse(text);
      this.sent.push(msg);
      if (onMessage) onMessage(this, msg);
      else if (msg.op === OP.Identify) this.fromServer({ op: OP.Identified, d: { negotiatedRpcVersion: 1 } });
    }

    close() {
      if (this.closed) return;
      this.closeFromServer(1000);
    }
  }
  return { FakeSocket, sockets };
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('base64');

test('la autenticacion es la del protocolo v5', () => {
  // Doble SHA-256 en base64: contraseña + salt, y ese resultado + challenge
  const expected = sha(sha('supersecret' + 'PZVbYpvAnZut2SS6JNJytDm9') + 'ztTBnnuqrqaKDzRM3xcVdbYm');
  assert.equal(authResponse('supersecret', 'PZVbYpvAnZut2SS6JNJytDm9', 'ztTBnnuqrqaKDzRM3xcVdbYm'), expected);
});

test('se conecta con el subprotocolo, se identifica y se suscribe', async () => {
  const { FakeSocket, sockets } = fakeWs();
  const c = new ObsClient({ host: '127.0.0.1', port: 4455, WebSocketImpl: FakeSocket });
  const hello = await c.connect();
  assert.equal(hello.obsWebSocketVersion, '5.5.0');
  assert.equal(sockets[0].url, 'ws://127.0.0.1:4455');
  assert.equal(sockets[0].protocol, SUBPROTOCOL);
  const identify = sockets[0].sent[0];
  assert.equal(identify.op, OP.Identify);
  assert.equal(identify.d.rpcVersion, 1);
  assert.equal(identify.d.eventSubscriptions, SUBSCRIPTIONS);
  assert.equal(identify.d.authentication, undefined, 'sin autenticacion no se manda');
  assert.equal(c.identified, true);
  c.close();
});

test('si OBS pide contraseña, la responde sin mandarla', async () => {
  const authentication = { salt: 'lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=', challenge: '+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY=' };
  const { FakeSocket, sockets } = fakeWs({ hello: { obsWebSocketVersion: '5.1.0', rpcVersion: 1, authentication } });
  const c = new ObsClient({ password: 'hunter2', WebSocketImpl: FakeSocket });
  await c.connect();
  const sent = sockets[0].sent[0];
  assert.equal(sent.d.authentication, sha(sha('hunter2' + authentication.salt) + authentication.challenge));
  assert.ok(!JSON.stringify(sockets[0].sent).includes('hunter2'));
  c.close();
});

test('sin contraseña cuando la pide: error y cierra', async () => {
  const { FakeSocket, sockets } = fakeWs({ hello: { authentication: { salt: 's', challenge: 'c' } } });
  const c = new ObsClient({ WebSocketImpl: FakeSocket });
  await assert.rejects(c.connect(), (e) => e.code === 'authRequired');
  assert.equal(sockets[0].closed, true);
});

test('contraseña mal y version vieja llegan con su codigo', async () => {
  const bad = fakeWs({ onMessage: (s, m) => m.op === OP.Identify && s.closeFromServer(CLOSE_AUTH_FAILED, 'Authentication failed.') });
  await assert.rejects(new ObsClient({ WebSocketImpl: bad.FakeSocket }).connect(), (e) => e.code === 'auth');
  const old = fakeWs({ onMessage: (s, m) => m.op === OP.Identify && s.closeFromServer(CLOSE_RPC_UNSUPPORTED) });
  await assert.rejects(new ObsClient({ WebSocketImpl: old.FakeSocket }).connect(), (e) => e.code === 'version');
});

test('OBS cerrado: rechaza sin colgarse', async () => {
  class Refused {
    constructor() {
      setImmediate(() => {
        this.onerror?.({});
        this.onclose?.({ code: 1006 });
      });
    }

    close() {}
  }
  await assert.rejects(new ObsClient({ WebSocketImpl: Refused }).connect(), (e) => e.code === 'refused');
  class Silent {
    close() {}
  }
  await assert.rejects(new ObsClient({ WebSocketImpl: Silent, connectTimeout: 20 }).connect(), (e) => e.code === 'timeout');
});

test('pedidos: cada respuesta le llega a su pedido', async () => {
  const replies = {
    GetSceneList: { currentProgramSceneName: 'Juego', scenes: [{ sceneIndex: 0, sceneName: 'Fin' }, { sceneIndex: 1, sceneName: 'Juego' }] },
    GetStreamStatus: { outputActive: true },
    GetRecordStatus: { outputActive: false },
    SetCurrentProgramScene: {},
  };
  const { FakeSocket, sockets } = fakeWs({
    onMessage: (s, m) => {
      if (m.op === OP.Identify) s.fromServer({ op: OP.Identified, d: { negotiatedRpcVersion: 1 } });
      else if (m.op === OP.Request) {
        // Contesta en otro turno y fuera de orden
        setImmediate(() => s.fromServer({ op: OP.RequestResponse, d: { requestType: m.d.requestType, requestId: m.d.requestId, requestStatus: { result: true, code: 100 }, responseData: replies[m.d.requestType] } }));
      }
    },
  });
  const c = new ObsClient({ WebSocketImpl: FakeSocket });
  await c.connect();
  const [scenes, outputs] = await Promise.all([c.sceneList(), c.outputs()]);
  assert.deepEqual(scenes, { scenes: ['Juego', 'Fin'], current: 'Juego' }, 'en el orden de la lista de OBS');
  assert.deepEqual(outputs, { streaming: true, recording: false });
  await c.setScene('Juego');
  const set = sockets[0].sent.find((m) => m.d?.requestType === 'SetCurrentProgramScene');
  assert.equal(set.op, OP.Request);
  assert.deepEqual(set.d.requestData, { sceneName: 'Juego' });
  const ids = sockets[0].sent.filter((m) => m.op === OP.Request).map((m) => m.d.requestId);
  assert.equal(new Set(ids).size, ids.length, 'ids distintos');
  c.close();
});

test('un pedido rechazado trae el motivo, y uno sin respuesta vence', async () => {
  const { FakeSocket } = fakeWs({
    onMessage: (s, m) => {
      if (m.op === OP.Identify) s.fromServer({ op: OP.Identified, d: {} });
      else if (m.d.requestType === 'SetCurrentProgramScene') s.fromServer({ op: OP.RequestResponse, d: { requestId: m.d.requestId, requestStatus: { result: false, code: 600, comment: 'No source' } } });
    },
  });
  const c = new ObsClient({ WebSocketImpl: FakeSocket, requestTimeout: 20 });
  await c.connect();
  await assert.rejects(c.setScene('No existe'), (e) => e.code === 'request' && e.status === 600 && /No source/.test(e.message));
  await assert.rejects(c.request('GetVersion'), (e) => e.code === 'timeout');
  c.close();
  await assert.rejects(c.request('GetVersion'), (e) => e.code === 'closed');
});

test('eventos y cierre', async () => {
  const { FakeSocket, sockets } = fakeWs();
  const c = new ObsClient({ WebSocketImpl: FakeSocket });
  const events = [];
  const closes = [];
  c.on('event', (type, data) => events.push([type, data]));
  c.on('close', (e) => closes.push(e));
  await c.connect();
  sockets[0].fromServer({ op: OP.Event, d: { eventType: 'StreamStateChanged', eventIntent: 64, eventData: { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED' } } });
  sockets[0].fromServer({ op: OP.Event, d: { eventType: 'RecordStateChanged', eventData: { outputActive: false } } });
  assert.equal(events.length, 2);
  assert.equal(events[0][0], 'StreamStateChanged');
  assert.equal(events[0][1].outputActive, true);
  // Un pedido en curso falla si se corta
  const pending = c.request('GetVersion');
  sockets[0].closeFromServer(1006);
  await assert.rejects(pending, (e) => e.code === 'closed');
  assert.equal(closes.length, 1);
  assert.equal(closes[0].code, 1006);
  assert.equal(c.identified, false);
});

test('direccion: IPv6 entre corchetes', async () => {
  const { FakeSocket, sockets } = fakeWs();
  const c = new ObsClient({ host: '::1', port: 4444, WebSocketImpl: FakeSocket });
  await c.connect();
  assert.equal(sockets[0].url, 'ws://[::1]:4444');
  c.close();
});

// ---------- Reglas ----------

test('solo esta PC o la red local', () => {
  for (const ok of ['127.0.0.1', 'localhost', '::1', '192.168.1.20', '10.0.0.5', '172.16.0.1', '172.31.255.1', 'pc-stream.local']) assert.equal(logic.isLocalHost(ok), true, ok);
  for (const bad of ['8.8.8.8', 'obs.example.com', '172.32.0.1', '192.169.0.1', '256.1.1.1', '', null, 'ws://127.0.0.1']) assert.equal(logic.isLocalHost(bad), false, String(bad));
});

test('ajustes: apagado por defecto y valores validos', () => {
  const d = logic.normalizeSettings(undefined);
  assert.equal(d.enabled, false);
  assert.equal(d.host, '127.0.0.1');
  assert.equal(d.port, 4455);
  assert.equal(d.streamerWhileLive, undefined);
  assert.equal(d.streamerOwned, undefined);
  const s = logic.normalizeSettings({ enabled: true, host: 'obs.example.com', port: 99999, sceneOnOpen: ' Juego ', streamerWhileLive: false });
  assert.equal(s.host, '127.0.0.1', 'una direccion de internet no se acepta');
  assert.equal(s.port, 4455);
  assert.equal(s.sceneOnOpen, 'Juego');
  assert.equal(s.streamerWhileLive, undefined);
});

test('la espera entre reintentos crece hasta 5 minutos', () => {
  assert.equal(logic.backoff(0), 3000);
  assert.equal(logic.backoff(1), 6000);
  assert.equal(logic.backoff(3), 24000);
  assert.equal(logic.backoff(50), 300000);
  assert.equal(logic.backoff(undefined), 3000);
});

test('escenas: la de cerrar no se pone si queda otro juego abierto', () => {
  const cfg = { sceneOnOpen: 'Juego', sceneOnClose: 'Charla' };
  assert.equal(logic.sceneFor('open', cfg), 'Juego');
  assert.equal(logic.sceneFor('close', cfg), 'Charla');
  assert.equal(logic.sceneFor('close', cfg, { othersRunning: true }), null);
  assert.equal(logic.sceneFor('open', { sceneOnOpen: '' }), null);
  assert.equal(logic.sceneFor('otro', cfg), null);
});


test('cerrar antes de Hello termina la conexion y descarta mensajes tardios', async () => {
  let socket;
  class Silent {
    constructor() { socket = this; }
    close() {}
    send() { assert.fail('un cliente cerrado no debe identificarse'); }
  }
  const c = new ObsClient({ WebSocketImpl: Silent });
  const pending = c.connect();
  c.close();
  await assert.rejects(pending, { code: 'closed' });
  socket.onmessage({ data: JSON.stringify({ op: OP.Hello, d: {} }) });
  socket.onmessage({ data: JSON.stringify({ op: OP.Identified, d: {} }) });
  assert.equal(c.identified, false);
});

test('si el socket se cierra al enviar Identify, connect rechaza', async () => {
  let socket;
  class Closing {
    constructor() { socket = this; }
    close() {}
    send() { throw new Error('socket cerrado'); }
  }
  const c = new ObsClient({ WebSocketImpl: Closing });
  const pending = c.connect();
  socket.onmessage({ data: JSON.stringify({ op: OP.Hello, d: {} }) });
  await assert.rejects(pending, { code: 'refused' });
  c.close();
});
