// Prueba de punta a punta del respaldo DENTRO de la ventana de Electron: tres VoiceEngine reales (con sus
// RTCPeerConnection de verdad, hablando entre si por la red local), una nube falsa que se corta y brokers MQTT falsos.
// No es una prueba de Node (por eso no termina en .test.js): necesita WebRTC, WebCrypto y AudioContext del navegador.
//
//   VENUS_DATA_DIR=<tmp> VENUS_DEVSHOT=<carpeta> VENUS_SKIP_ONBOARDING=1 VENUS_DEVSHOT_WAIT=2500 \
//   VENUS_DEVSHOT_ROUTES="voice|import('./js/voice/test/window-failover.js').then((m) => m.run())" ./node_modules/.bin/electron.cmd .
//
// Escribe una linea "[e2e] ..." por cada comprobacion y un "[e2e] RESULT {json}" al final en console.log.
// No abre el microfono (getUserMedia se reemplaza) ni habla con el servidor real ni con ningun broker.
import { VoiceEngine } from '../../voice.js';
import { FakeBrokers, FakeCloud } from './fake-net.js';
import { BROKERS } from '../backup.js';
import { MqttClient } from '../mqtt.js';
import { deriveRoom, sealFrame } from '../seal.js';
import { createIdentity, signText, randomId } from '../sign.js';
import { envelopeText } from '../envelope.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms, label) {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    try {
      const v = await fn();
      if (v) return Math.round(performance.now() - t0);
    } catch {
      /* todavia no */
    }
    await sleep(150);
  }
  throw new Error(`tiempo agotado: ${label}`);
}

export async function run() {
  const results = [];
  const log = (name, ok, info = '') => {
    results.push({ name, ok: Boolean(ok), info: String(info) });
    console.log(`[e2e] ${ok ? 'OK ' : 'MAL'} ${name}${info ? ` · ${info}` : ''}`);
  };
  const realGum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async () => {
    throw new DOMException('prueba sin microfono', 'NotFoundError');
  };
  const cloud = new FakeCloud();
  const brokers = new FakeBrokers();
  const engines = [];
  const make = (id, name) => {
    const user = { id, name };
    const e = new VoiceEngine({
      backend: { client: cloud.client(user), user, profile: { display_name: name, username: name.toLowerCase(), mc_name: name }, WebSocket: brokers.WebSocket, connected: () => !cloud.down, probe: async () => !cloud.down },
    });
    // Sin STUN ni TURN: las dos conexiones se encuentran por la red local sin tocar internet
    e.rtcConfig = () => ({ iceServers: [], iceTransportPolicy: 'all', bundlePolicy: 'max-bundle' });
    engines.push(e);
    return e;
  };
  const A = make('aaaaaaaa-0000-4000-8000-000000000001', 'Ana');
  const B = make('bbbbbbbb-0000-4000-8000-000000000002', 'Beto');
  const C = make('cccccccc-0000-4000-8000-000000000003', 'Cami');
  const D = make('dddddddd-0000-4000-8000-000000000004', 'Dani');
  const E = make('eeeeeeee-0000-4000-8000-000000000005', 'Eli');
  const connected = (e, uid) => e.session?.peers.get(uid)?.state === 'connected';
  const chats = (e) => e.chat.filter((m) => !m.system).map((m) => m.text);
  const brokerConns = () => [...brokers.hosts.keys()].reduce((n, u) => n + brokers.count(u), 0);

  try {
    // ---------- 1. Sala normal por el servidor ----------
    const created = await A.createRoom({ name: 'Prueba E2E', private: true });
    const code = created.code;
    await B.joinRoom(code);
    await waitFor(() => A.members.length === 2 && B.members.length === 2, 15000, 'A y B se ven');
    const tConn = await waitFor(() => connected(A, B.user.id) && connected(B, A.user.id), 30000, 'A y B conectan por WebRTC');
    log('A y B se ven y conectan por WebRTC con el servidor sano', true, `${tConn} ms`);
    const peerAB = A.session.peers.get(B.user.id);
    const pcBefore = peerAB.pc;

    await A.sendChat('hola por el principal');
    await waitFor(() => chats(B).includes('hola por el principal'), 6000, 'chat por el principal');
    log('el chat llega por el camino principal', true);
    log('con el servidor sano no hay ninguna conexion a brokers', brokerConns() === 0, `${brokerConns()} conexiones`);
    log('A recibio su clave de respaldo del servidor', Boolean(A.session.secret), A.session.secret ? 'si' : 'no');
    await waitFor(() => B.session.secret, 8000, 'B recibe su clave');

    // Un tono en la voz de A para comprobar que el audio llega de verdad
    const ctxA = A.audioCtx();
    const osc = ctxA.createOscillator();
    osc.frequency.value = 440;
    const gain = ctxA.createGain();
    gain.gain.value = 0.25;
    osc.connect(gain);
    gain.connect(A.session.mic.soundInput());
    osc.start();
    A.session.sfxHold = Date.now() + 3600e3;
    A.updateTransmit();
    const heard = (e, uid) => (e.session?.audio.get(uid)?.level(performance.now()) || 0) > 0.3;
    let audio1 = true;
    try {
      await waitFor(() => heard(B, A.user.id), 12000, 'B oye el tono de A');
    } catch {
      audio1 = false;
    }
    log('B oye el tono de A antes del corte', audio1, `contexto de audio: ${ctxA.state}`);

    // ---------- 2. Corte del servidor ----------
    const t0 = performance.now();
    cloud.setDown(true);
    const tSwitch = await waitFor(() => A.room?.backup && B.room?.backup && A.room.backupState === 'on' && B.room.backupState === 'on', 30000, 'A y B pasan al respaldo');
    log('se pasa al respaldo solo, sin que nadie haga nada', tSwitch <= 15000, `${tSwitch} ms`);
    log('la llamada no se corto: misma conexion WebRTC y sigue conectada', A.session.peers.get(B.user.id)?.pc === pcBefore && pcBefore.connectionState === 'connected', pcBefore.connectionState);
    log('el estado de la sala sigue "connected"', A.room.status === 'connected' && B.room.status === 'connected', `${A.room.status}/${B.room.status}`);
    let audio2 = true;
    try {
      await waitFor(() => heard(B, A.user.id), 8000, 'B sigue oyendo a A');
    } catch {
      audio2 = false;
    }
    log('B sigue oyendo a A durante el corte', audio2);

    await A.sendChat('hola por el respaldo');
    await B.sendChat('te leo por el respaldo');
    await waitFor(() => chats(B).includes('hola por el respaldo') && chats(A).includes('te leo por el respaldo'), 8000, 'chat por el respaldo');
    log('el chat se intercambia por el respaldo', true);
    A.setMuted(true);
    await waitFor(() => B.members.find((m) => m.userId === A.user.id)?.muted === true, 8000, 'presencia por el respaldo');
    A.setMuted(false);
    log('la presencia (silenciado) llega por el respaldo', true);
    log('la lista de miembros no cambio (nadie se fue)', A.members.length === 2 && B.members.length === 2, `${A.members.length}/${B.members.length}`);

    // ---------- 3. Alguien entra con el servidor caido ----------
    let err = null;
    try {
      await C.joinRoom(code);
    } catch (e) {
      err = e;
    }
    log('sin servidor y sin clave guardada, entrar da un error claro', err?.code === 'server_down_nobackup', err?.code || 'sin error');
    const backupCode = A.room.backupCode;
    log('A tiene un codigo de respaldo para compartir', /^[A-Z2-9]{6}(-[A-Z2-9]{4}){6}-R/.test(backupCode || ''), backupCode ? 'si' : 'no');
    await C.joinRoom(backupCode);
    await waitFor(() => C.members.length === 3 && A.members.length === 3 && B.members.length === 3, 20000, 'C aparece en A y B por el respaldo');
    const cOnA = A.members.find((m) => m.name === 'Cami');
    log('C entra por el respaldo y aparece como "sin verificar"', cOnA?.unverified === true && C.room.unverified === true, cOnA ? `id ${String(cOnA.userId).slice(0, 8)}` : 'no aparece');
    const cUid = cOnA.userId;
    const tC = await waitFor(() => connected(A, cUid) && connected(B, cUid) && C.session.peers.size === 2 && [...C.session.peers.values()].every((p) => p.state === 'connected'), 40000, 'C conecta con A y B por WebRTC');
    log('C se conecta por WebRTC con A y con B', true, `${tC} ms`);
    await C.sendChat('soy Cami, llegue sin servidor');
    await waitFor(() => chats(A).includes('soy Cami, llegue sin servidor') && chats(B).includes('soy Cami, llegue sin servidor'), 8000, 'chat de C');
    log('el chat de C llega a A y a B', true);
    log('A ve el nombre de C como lo eligio C (no hay otra fuente)', A.chat.find((m) => m.text?.startsWith('soy Cami'))?.name === 'Cami');

    // ---------- 4. Intentos de engaño por el respaldo ----------
    const room = await deriveRoom(A.session.secret);
    const url = A.session.paths.line.info()[0].url;
    const ghost = new MqttClient({ url, clientId: 'fantasma', WebSocketCtor: brokers.WebSocket });
    await ghost.connect();
    const rogue = await createIdentity();
    const forged = { f: A.user.id, fs: A.session.sessionId, to: null, tos: null, ts: Date.now(), n: randomId(14), d: JSON.stringify({ id: randomId(10), text: 'mensaje falso de A' }) };
    forged.sig = await signText(rogue.privateKey, envelopeText('chat', A.session.room.id, forged));
    ghost.publish(room.topic, await sealFrame(room, { e: 'chat', v: forged }));
    const real = await A.signEnvelope(A.session, 'chat', { id: randomId(10), text: 'texto original' });
    ghost.publish(room.topic, await sealFrame(room, { e: 'chat', v: { ...real, d: JSON.stringify({ id: randomId(10), text: 'texto cambiado' }) } }));
    // C (sin verificar) intenta sacar a B de la sala como si fuera el anfitrion
    await C.send(C.session, 'mod', { a: 'kick', t: B.user.id, b: false });
    await C.send(C.session, 'mod', { a: 'end' });
    await sleep(2500);
    log('el mensaje con firma ajena no se acepta', !chats(B).includes('mensaje falso de A') && !chats(A).includes('mensaje falso de A'));
    log('el mensaje con el texto cambiado no se acepta', !chats(B).includes('texto cambiado'));
    log('una persona sin verificar no puede sacar a nadie ni terminar la sala', Boolean(B.session) && Boolean(A.session) && B.members.length === 3, `B en sala: ${Boolean(B.session)}`);
    ghost.close();

    // ---------- 5. Vuelve el servidor ----------
    const tBack = performance.now();
    cloud.setDown(false);
    await waitFor(() => !A.room.backup && !B.room.backup, 90000, 'A y B vuelven al camino principal');
    log('vuelve al camino principal solo', true, `${Math.round(performance.now() - tBack)} ms`);
    log('sin cortar el audio: las conexiones son las mismas y siguen conectadas', A.session.peers.get(B.user.id)?.pc === pcBefore && pcBefore.connectionState === 'connected' && connected(A, cUid) && connected(B, cUid));
    await A.sendChat('ya volvio el servidor');
    await waitFor(() => chats(B).includes('ya volvio el servidor') && chats(C).includes('ya volvio el servidor'), 10000, 'chat despues de la vuelta');
    log('el chat funciona despues de la vuelta (tambien le llega a C, que solo esta en el respaldo)', true);
    log('el respaldo sigue abierto porque C solo llega por ahi', A.session.paths.snapshot().backup === 'on', A.session.paths.snapshot().backup);
    let audio3 = true;
    try {
      await waitFor(() => heard(B, A.user.id) && heard(C, A.user.id), 8000, 'B y C oyen a A');
    } catch {
      audio3 = false;
    }
    log('B y C oyen a A despues de la vuelta', audio3);
    osc.stop();

    // ---------- 6. Volver a entrar a una sala guardada con el servidor caido ----------
    cloud.setDown(true);
    await waitFor(() => A.room?.backup && B.room?.backup && C.room?.backup, 30000, 'otra vez en el respaldo');
    await A.leaveRoom({ silent: true });
    await waitFor(() => !B.members.some((m) => m.name === 'Ana'), 10000, 'B ve que A salio');
    log('A sale de la sala y B lo ve enseguida (aviso por el respaldo)', true);
    log('la clave de la sala quedo guardada en A', A.savedRooms().some((r) => r.code === code && !r.emergency), JSON.stringify(A.savedRooms().map((r) => r.code)));
    const back = await A.joinRoom(code);
    log('A vuelve a entrar con el servidor caido usando la clave guardada', back.code === code && A.room.unverified === true && A.room.backup === true);
    await waitFor(() => B.members.some((m) => m.name === 'Ana' && m.unverified) && A.members.length === 3, 20000, 'B ve a A (sin verificar)');
    log('B ve a A como "sin verificar" (su clave de sesion nueva no esta en el servidor)', true);
    await A.sendChat('volvi sin servidor');
    await waitFor(() => chats(B).includes('volvi sin servidor') && chats(C).includes('volvi sin servidor'), 10000, 'chat de A al volver');
    log('el chat de A llega a B y C', true);

    // ---------- 7. Sala de emergencia: crear y entrar sin servidor ----------
    const em = await D.createRoom({ name: 'Plan B' });
    log('crear una sala con el servidor caido arma una sala de emergencia', em.emergency === true && /^[A-Z2-9]{6}(-[A-Z2-9]{4}){6}$/.test(em.backupCode || ''), em.backupCode || 'sin codigo');
    await E.joinRoom(em.backupCode);
    await waitFor(() => D.members.length === 2 && E.members.length === 2, 20000, 'D y E se ven');
    await waitFor(() => connected(D, E.session.userId) && connected(E, D.session.userId), 40000, 'D y E conectan');
    await D.sendChat('hola Eli');
    await E.sendChat('hola Dani');
    await waitFor(() => chats(E).includes('hola Dani'.replace('Dani', 'Eli')) && chats(D).includes('hola Dani'), 8000, 'chat de emergencia');
    log('D y E se ven, conectan por WebRTC y chatean sin ningun servidor', true);
    log('no hay anfitrion en una sala de emergencia', D.room.isOwner === false && E.room.isOwner === false);
    // Lo unico que intentaron fue crear / entrar (y fallo, el servidor estaba caido): despues nada de latidos, claves ni salir
    const asked = cloud.rpcLog.filter((r) => r.user === D.user.id || r.user === E.user.id).map((r) => r.name);
    log('D y E solo intentaron crear / entrar al servidor y despues no le pidieron nada mas', asked.length <= 2 && asked.every((n) => ['voice_create_room', 'voice_join'].includes(n)), asked.join(','));
  } catch (err) {
    log('ERROR EN LA PRUEBA', false, err?.message || err);
  } finally {
    for (const e of engines) await e.leaveRoom({ silent: true }).catch(() => {});
    navigator.mediaDevices.getUserMedia = realGum;
  }
  const summary = { ok: results.every((r) => r.ok), total: results.length, failed: results.filter((r) => !r.ok).map((r) => r.name) };
  console.log(`[e2e] RESULT ${JSON.stringify(summary)}`);
  return summary;
}
