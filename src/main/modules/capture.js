'use strict';
// Clips y capturas del juego: repeticion instantanea (guarda los ultimos 30 s a 30 minutos, lo que elija el usuario,
// al apretar el atajo o sola al morir, conseguir un logro o matar un jefe), grabacion (empezar/parar, sin limite o
// con el que se elija) y capturas de pantalla de la ventana del juego, con atajos globales.
// Graba una ventana oculta (capture/host.js + renderer/recorder.html) con desktopCapturer + MediaRecorder (WebM VP9
// o VP8 + Opus); capture/webm.js recorta y rearma el WebM con duracion e indice. El buffer de la repeticion va al
// disco (capture/ring.js, en cache/capture-replay: se borra al cerrar y al arrancar), no a la memoria. Nada se graba
// sin pedirlo: la repeticion esta apagada por defecto y solo corre mientras hay un juego abierto; los atajos tambien
// se registran solo con un juego abierto (asi no le quitan esas teclas a otras aplicaciones).
// Calidad: resolucion (720p a 4K o nativa, nunca se agranda), 30 a 120 fps y Baja/Media/Alta; capture/logic.js decide
// el bitrate y el codec, cuanto disco ocupa y que hacer si la PC no llega (baja sola un paso y lo avisa). Nunca se
// llena el disco: la repeticion y la grabacion no arrancan (o se cortan guardando lo hecho) si quedaria menos de 1 GB.
// Clips automaticos: capture/gamelog.js lee la salida del juego (game.events 'log') y capture/autoclip.js decide;
// apagados por defecto, solo con la repeticion prendida y solo para la cuenta con la que se lanzo el juego.
// Donde se guarda (dentro de la carpeta de la instancia, ver capture/logic.js): screenshots/ (capturas, junto a las
// del F2 de Minecraft), clips/ (repeticiones y lo que exporta el editor) y recordings/ (grabaciones). Asi los ven
// la pagina de Clips, la de Mundos y la linea de tiempo de cada mundo por los canales worlds:* que ya existen.
//
// Canales:
//   capture:status() -> estado (juego y ventana, repeticion, grabacion, atajos, ajustes normalizados)
//   capture:saveReplay() -> { path, instanceId, duration } · capture:screenshot() -> { path, instanceId }
//   capture:startRecording() -> { active, instanceId, startedAt } · capture:stopRecording() -> { path, instanceId, duration }
//   capture:toggleRecording()
//   capture:testShortcut(acelerador, accion) -> { ok, accel, reason?: 'invalid' | 'duplicate' | 'inUse' }
//   capture:openFolder({ instanceId?, kind: 'screenshot' | 'clip' | 'recording' })
//   capture:saveExport({ instanceId, sourceName, mode: 'vertical' | 'horizontal' }, bytes WebM) -> { path, name, duration }
//   capture:aiStatus() -> { available } · capture:aiIndex() -> { clave: descripcion }
//   capture:aiDescribe([{ key, path }]) -> { described, skipped, errorCode?, error? } (IA solo a pedido; capture/describe.js)
// Eventos: capture:saved ({ type: 'screenshot' | 'clip' | 'recording', path, instanceId, duration? (segundos),
//          reason? ('death' | 'advancement' | 'boss': clip automatico) }),
//          capture:state (lo mismo que capture:status), capture:notice ({ level: 'error' | 'info', message })
// Tambien manda worlds:updated ({ kind: 'media', instanceId }) para que Mundos refresque su galeria.
const fsp = require('fs/promises');
const path = require('path');
const settings = require('../core/settings');
const game = require('../core/game');
const instances = require('../core/instances');
const { t } = require('../core/i18n');
const { exists } = require('../core/util');
const paths = require('../core/paths');
const logic = require('./capture/logic');
const webm = require('./capture/webm');
const { ReplayRing, cleanRoot } = require('./capture/ring');
const { RecordingFile } = require('./capture/recording');
const { GameLogReader } = require('./capture/gamelog');
const gamelang = require('./capture/gamelang');
const { AutoClipGate } = require('./capture/autoclip');
const windowFind = require('./capture/window-find');
const describe = require('./capture/describe');

const MAX_EXPORT = 1536 * 1024 * 1024;
const SHORTCUT_DEBOUNCE_MS = 700;
const CLIP_RESERVE = 64 * 1024; // lugar para Info, Tracks y el indice de un clip (sobra para 5 minutos)
const LANG_RELOAD_MS = 3000; // el juego guarda options.txt un rato despues de cambiar de idioma

let ctx = null;
let cfg = logic.normalizeSettings({});
const support = logic.platformSupport();
let host = null;
let target = null; // { instanceId, pid, hwnd, finder }
let session = null; // { id, purposes: Set, reader, header, headerWaiters, ready }
let ring = null;
let ringSeq = 0;
let replayBlocked = null; // 'noRoom' | 'disk': la repeticion se paro por falta de disco
let saveChain = Promise.resolve(); // las repeticiones se guardan de a una
const gate = new AutoClipGate();
let gatePid = null; // partida de la que cuenta el limite de clips automaticos
let autoTimer = null;
const plays = new Map(); // instancia -> { reader, dir, assetIndex, rootId, lang, langTimer } de la partida abierta
let recording = null; // { file: RecordingFile, instanceId, path, startedAt, dir }
let degrade = null; // { quality, fps }: la PC no llegaba y se bajo un paso (hasta que cambien los ajustes o el juego)
let degradeCount = 0;
let diskFree = null; // bytes libres donde va el buffer de la repeticion (null = no se sabe)
let diskTick = 0;
let pendingRestart = false;
const registered = new Map(); // accion -> acelerador registrado por este modulo
const lastPress = new Map();
let stateTimer = null;
let retargetTimer = null;
let quitting = false;

const send = (...a) => ctx?.send?.(...a);

function coded(key, code, vars) {
  const err = new Error(t(`capture.${key}`, vars));
  err.code = code;
  return err;
}

function guard(p) {
  return ctx?.safePath ? ctx.safePath(p) : path.resolve(p);
}

// ---------- Overlay (agente B) y estado ----------

let overlayMissingUntil = 0;
function overlay(evt) {
  if (Date.now() < overlayMissingUntil) return;
  try {
    const o = require('./overlay');
    if (typeof o?.push === 'function') o.push(evt);
  } catch (err) {
    if (err?.code === 'MODULE_NOT_FOUND') overlayMissingUntil = Date.now() + 60000;
    else console.warn('[capture] overlay:', err?.message || err);
  }
}

function shortcutsState() {
  const out = {};
  for (const a of logic.ACTIONS) {
    const accel = cfg.shortcuts[a];
    out[a] = { accel, registered: registered.get(a) === accel && Boolean(accel), active: Boolean(target) };
  }
  return out;
}

// Pantalla principal en pixeles reales y su frecuencia ({ width, height, hz }; null antes de que arranque la app)
function display() {
  try {
    const d = require('electron').screen.getPrimaryDisplay();
    const k = d.scaleFactor || 1;
    return { width: Math.round(d.size.width * k), height: Math.round(d.size.height * k), hz: Math.round(d.displayFrequency || 0) };
  } catch {
    return null;
  }
}

// Ajustes con lo que se bajo porque la PC no llegaba
const current = () => (degrade ? { ...cfg, ...degrade } : cfg);

// Lo que se graba de verdad: con la captura andando, al tamanio y con el codec que entrego la grabadora
function plan(d = display()) {
  const live = session?.info;
  return logic.effective(current(), { display: d, window: live ? { width: live.width, height: live.height } : null, codec: live?.codec, hardware: live?.hardware });
}

function liveState() {
  const s = session;
  if (!s?.info) return null;
  const r = s.rate || {};
  // Lo que se espera que ocupe, no lo pedido: a la placa de video se le pide menos porque gasta de mas (logic.bitrateFor)
  const bitrate = s.info.hardware ? Math.round(s.info.bitrate * logic.hwOvershoot(s.info.fps)) : s.info.bitrate;
  return { width: s.info.width, height: s.info.height, codec: s.info.codec, hardware: Boolean(s.info.hardware), bitrate, fps: r.encoded ?? null, delivered: r.delivered ?? null };
}

function status() {
  const d = display();
  const p = plan(d);
  const disk = logic.replayDisk(cfg.replaySeconds, p, cfg.audio);
  const presets = logic.PRESET_IDS.map((id) => {
    const values = logic.presetValues(id, d);
    const pp = logic.effective({ ...cfg, ...values }, { display: d });
    return { id, ...values, fps: pp.fps, width: pp.width, height: pp.height, disk: logic.replayDisk(cfg.replaySeconds, pp, cfg.audio) };
  });
  return {
    settings: cfg,
    available: support.capture,
    audioAvailable: support.audio,
    replaySeconds: cfg.replaySeconds,
    diskEstimate: disk,
    diskFree,
    // Lo que ya ocupa el buffer andando cuenta como propio
    diskOk: logic.hasDiskRoom(diskFree === null ? null : diskFree + (ring ? ring.bytes : 0), disk),
    // Y con el buffer lleno queda lugar para guardar el clip entero
    diskSaveOk: logic.hasDiskRoom(diskFree === null ? null : diskFree + (ring ? ring.bytes : 0), 2 * disk),
    recordPerMinute: logic.estimateBytes(60, p, cfg.audio),
    plan: p,
    display: d,
    preset: logic.activePreset(cfg, d),
    presets,
    heavy: logic.load(logic.effective(cfg, { display: d })) > logic.BALANCED_LOAD,
    degraded: degrade ? { ...degrade } : null,
    live: liveState(),
    options: { replayLengths: logic.REPLAY_LENGTHS, qualities: logic.QUALITIES, fps: logic.FPS, levels: logic.LEVELS, recordLimits: logic.RECORD_LIMITS },
    game: target ? { instanceId: target.instanceId, window: target.found, searching: !target.found } : null,
    replay: { enabled: cfg.replay, active: Boolean(session && ring), buffered: ring ? Math.round(ring.buffered) : 0, disk: ring ? ring.bytes : 0, error: replayBlocked },
    auto: { saved: gate.count, limit: cfg.auto.maxPerSession },
    recording: recording ? { active: true, instanceId: recording.instanceId, startedAt: recording.startedAt, duration: recording.file.duration, limit: cfg.recordLimit } : { active: false },
    shortcuts: shortcutsState(),
    folders: logic.KIND_DIR,
  };
}

function emitState() {
  clearTimeout(stateTimer);
  stateTimer = setTimeout(() => send('capture:state', status()), 80);
}

function notice(level, message) {
  send('capture:notice', { level, message: String(message || '') });
  if (level === 'error') overlay({ kind: 'alert', title: t('capture.overlayErrorTitle'), body: String(message || ''), icon: 'capture', ttl: 5000 });
}

// ---------- Ventana del juego ----------

async function resolveSource() {
  const { desktopCapturer } = require('electron');
  let sources = [];
  try {
    sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
  } catch (err) {
    console.warn('[capture] fuentes:', err?.message || err);
  }
  const byId = target?.hwnd ? sources.find((s) => s.id === windowFind.sourceId(target.hwnd)) : null;
  const src = byId || windowFind.matchByTitle(sources);
  if (!src) throw coded('errNoWindow', 'noWindow');
  return src;
}

function clearTarget() {
  if (!target) return;
  degrade = null;
  degradeCount = 0;
  target.finder?.cancel();
  clearInterval(target.poll);
  target = null;
  unregisterShortcuts();
  emitState();
}

// La ventana del juego aparecio (por el pid o por el titulo): arranca la repeticion si esta prendida
function onFound(cur, hwnd) {
  if (target !== cur) return;
  if (hwnd) cur.hwnd = hwnd;
  if (cur.found) return;
  cur.found = true;
  clearInterval(cur.poll);
  emitState();
  if (cfg.replay) ensureSession('replay').catch((err) => console.warn('[capture] repeticion:', err?.message || err));
}

// Elige el juego abierto mas reciente y busca su ventana: por el pid (PowerShell, capture/window-find.js) y, en
// paralelo, por el titulo cada 3 s (fuera de Windows o si el proceso no es el dueño de la ventana)
function refreshTarget() {
  const g = logic.pickGame(game.status());
  if (!g) return clearTarget();
  if (target && target.pid === g.pid) return;
  clearTarget();
  if (gatePid !== g.pid) {
    // Otra partida (no la misma con la ventana recreada): el limite de clips automaticos vuelve a cero
    gatePid = g.pid;
    clearTimeout(autoTimer);
    gate.reset();
  }
  const cur = { instanceId: g.instanceId, pid: g.pid, hwnd: null, found: false, finder: null, poll: null };
  target = cur;
  cur.finder = windowFind.findWindow({ pid: g.pid });
  cur.finder.promise.then((hwnd) => hwnd && onFound(cur, hwnd));
  const until = Date.now() + windowFind.WAIT_MIN * 60000;
  cur.poll = setInterval(() => {
    if (target !== cur || cur.found || Date.now() > until) return clearInterval(cur.poll);
    resolveSource().then(
      () => onFound(cur, null),
      () => {},
    );
  }, 3000);
  cur.poll.unref?.();
  registerShortcuts();
  emitState();
}

async function onGameState(id, st) {
  if (!st || st.quiet) return;
  if (st.state === 'running') {
    refreshTarget();
    return;
  }
  if (st.state !== 'stopped' && st.state !== 'crashed') return;
  clearTimeout(plays.get(id)?.langTimer);
  plays.delete(id);
  if (target && target.instanceId === id) {
    if (recording?.instanceId === id) await stopRecording().catch((err) => console.warn('[capture] grabacion al cerrar:', err?.message || err));
    await stopSession();
    clearTarget();
  }
  refreshTarget();
}

// ---------- Sesion de captura ----------

function streamOptions() {
  const s = current();
  const d = display();
  const p = logic.effective(s, { display: d });
  // Tope sin la pantalla principal: "nativa" es la ventana con tope en 4K aunque este en otra pantalla mas grande
  return { box: logic.qualityBox(s.quality), fps: p.fps, audio: cfg.audio && support.audio, bitrate: logic.bitrateModel(s.level), codecs: logic.codecOrder(p), hardware: logic.HW_CODECS, keyframeMs: logic.KEYFRAME_MS };
}

// Arranca (o reusa) la captura de la ventana del juego. purpose = 'replay' | 'record'
async function ensureSession(purpose) {
  if (session) {
    session.purposes.add(purpose);
    if (purpose === 'replay' && !ring) ring = makeRing(session.header);
    await session.ready;
    return session;
  }
  if (!target) throw coded('errNoGame', 'noGame');
  const s = { id: null, purposes: new Set([purpose]), reader: new webm.WebmReader(), header: null, headerWaiters: [], ready: null, broken: false, info: null, startedAt: 0, frames: 0, samples: [], rate: null, strikes: 0 };
  session = s;
  if (purpose === 'replay') ring = makeRing(null);
  s.ready = (async () => {
    const src = await resolveSource();
    const info = await host.start(src, streamOptions());
    s.id = info.session;
    s.info = info;
    s.startedAt = Date.now();
    if (info.audioFailed) console.warn('[capture] sin el sonido del equipo: se graba solo el video');
    if (session !== s || !s.purposes.size) {
      if (session === s) session = null;
      await host.stop(info.session);
      return s;
    }
    emitState();
    return s;
  })();
  s.ready.catch(() => {
    if (session === s) {
      session = null;
      dropRing();
      emitState();
    }
  });
  await s.ready;
  return s;
}

// ---------- Buffer de la repeticion (en disco) ----------

const ringRoot = () => paths.cache('capture-replay');

// Lo que ocupa el buffer con los ajustes de ahora
const replayNeed = () => logic.replayDisk(cfg.replaySeconds, plan(), cfg.audio);

function makeRing(header) {
  const r = new ReplayRing({ dir: path.join(ringRoot(), `r${Date.now().toString(36)}${++ringSeq}`), seconds: cfg.replaySeconds, maxBytes: logic.ringMaxBytes(replayNeed(), diskFree), onError: (err) => onRingError(r, err) });
  if (header) r.header = header;
  replayBlocked = null;
  checkDiskRoom(r);
  return r;
}

// Deja de usar el buffer: guarda el clip automatico que estaba esperando y borra su carpeta (lo que se este
// guardando la retiene hasta terminar)
function dropRing() {
  const r = ring;
  ring = null;
  if (!r) return Promise.resolve();
  clearTimeout(autoTimer);
  const p = gate.take();
  const saved = p ? saveAuto(r, p) : Promise.resolve();
  return saved.finally(() => r.dispose());
}

// La repeticion se para por falta de disco: el juego no se entera y el atajo avisa que no esta lista
function blockReplay(code, message) {
  replayBlocked = code;
  notice('error', message);
  releaseSession('replay').catch(() => {});
}

// La repeticion estaba en pausa por falta de disco: si con los ajustes de ahora y el lugar libre entra, vuelve a
// arrancar (makeRing limpia replayBlocked y vuelve a chequear el disco). Si tampoco entra no se insiste ni se avisa
// de nuevo: Ajustes ya lo dice.
function retryReplay() {
  if (!cfg.replay || !replayBlocked || ring || !target?.found) return;
  refreshDisk().then((free) => {
    if (cfg.replay && replayBlocked && !ring && target?.found && logic.hasDiskRoom(free, replayNeed())) {
      ensureSession('replay').catch((err) => console.warn('[capture] repeticion:', err?.message || err));
    }
  });
}

function onRingError(r, err) {
  if (ring !== r) return;
  console.warn('[capture] buffer de la repeticion:', err?.message || err);
  blockReplay('disk', t(err?.code === 'ENOSPC' ? 'capture.errNoSpace' : 'capture.errWrite'));
}

// Bytes libres en el disco de esa carpeta (null = no se sabe)
async function freeAt(dir) {
  try {
    await fsp.mkdir(dir, { recursive: true });
    const st = await fsp.statfs(dir);
    return st.bavail * st.bsize;
  } catch {
    return null;
  }
}

async function refreshDisk() {
  const free = await freeAt(ringRoot());
  const changed = (free === null) !== (diskFree === null) || Math.abs((free || 0) - (diskFree || 0)) > 64 * 1024 * 1024;
  diskFree = free;
  if (changed) emitState();
  return free;
}

// No arranca si dejaria el disco casi lleno (el juego tambien necesita lugar para guardar el mundo). Lo que ya
// ocupa este buffer cuenta como propio.
async function checkDiskRoom(r) {
  const free = await refreshDisk(); // sin saberlo se deja pasar y, si se llena, avisa la escritura
  if (ring !== r) return;
  const need = Math.max(0, replayNeed() - r.bytes);
  if (!logic.hasDiskRoom(free, need)) {
    blockReplay('noRoom', t('capture.errReplayNoRoomNeed', { need: fmtSize(replayNeed()) }));
    return;
  }
  r.maxBytes = logic.ringMaxBytes(replayNeed(), free === null ? null : free + r.bytes);
  // Guardar copia el tramo a clips/ (el mismo disco) mientras el buffer sigue ocupando lo suyo: se avisa una vez por
  // buffer si con el buffer lleno no quedaria lugar para el clip entero (no se bloquea: la estimacion es un tope)
  if (!r.saveTightNoted && !logic.hasDiskRoom(free === null ? null : free + r.bytes, 2 * replayNeed())) {
    r.saveTightNoted = true;
    notice('info', t('capture.replaySaveTight', { need: fmtSize(replayNeed()) }));
  }
}

// "1,2 GB" para los avisos
function fmtSize(bytes) {
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

async function stopSession() {
  const s = session;
  session = null;
  pendingRestart = false; // una sesion parada no tiene nada que reiniciar: la proxima arranca con current()
  const dropped = dropRing();
  // Solo la suya: si todavia no arranco (sin id), la para su propio arranque al ver que ya no es la sesion actual
  if (s?.id) await host?.stop(s.id).catch(() => {});
  await dropped;
  emitState();
}

// Deja de usar la sesion para algo; si ya no se usa para nada, se para
async function releaseSession(purpose) {
  const s = session;
  if (!s) return;
  s.purposes.delete(purpose);
  if (purpose === 'replay') dropRing();
  if (!s.purposes.size) await stopSession();
  else if (pendingRestart && !recording) await restartSession();
  emitState();
}

async function restartSession() {
  pendingRestart = false;
  const purposes = session ? [...session.purposes] : [];
  await stopSession();
  for (const p of purposes) await ensureSession(p).catch((err) => console.warn('[capture] reinicio:', err?.message || err));
}

function onChunk({ session: id, data }) {
  const s = session;
  if (!s || s.broken || (s.id && s.id !== id)) return;
  let out;
  try {
    out = s.reader.push(data);
  } catch (err) {
    // Un flujo roto no se puede recortar: se vuelve a empezar la captura
    console.warn('[capture] webm:', err?.message || err);
    s.broken = true;
    restartSession().catch(() => {});
    return;
  }
  if (out.header) {
    s.header = out.header;
    ring?.setHeader(out.header);
    s.headerWaiters.splice(0).forEach((fn) => fn(out.header));
  }
  for (const f of out.frames) {
    if (f.video) s.frames++;
    ring?.add(f);
    recording?.file.add(f);
  }
}

// "4K", "1440p (2K)", "nativa" para los avisos
const qualityName = (q) => (q === 'native' ? t('capture.native') : { '2160p': '4K', '1440p': '1440p (2K)' }[q] || q);

// Cuadros que entrego la captura (estadisticas de la pista, cada 2 s desde la grabadora)
function onStats({ session: id, delivered }) {
  const s = session;
  if (!s || !s.id || s.id !== id || !Number.isFinite(delivered)) return;
  s.delivered = delivered;
}

// Cuadros por segundo de los ultimos segundos tomando la mediana de cada segundo: un tiron suelto (pantalla de
// carga, guardado del mundo) no la mueve; un codificador que no da abasto la deja baja en todos
function medianRate(samples) {
  const rates = [];
  for (let i = 1; i < samples.length; i++) {
    const secs = (samples[i].at - samples[i - 1].at) / 1000;
    if (secs > 0) rates.push((samples[i].frames - samples[i - 1].frames) / secs);
  }
  if (!rates.length) return 0;
  rates.sort((a, b) => a - b);
  const m = rates.length >> 1;
  return rates.length % 2 ? rates[m] : (rates[m - 1] + rates[m]) / 2;
}

/**
 * Cada segundo se anota cuantos cuadros salieron codificados (y cuantos entrego la captura, si se sabe); con los
 * ultimos 8 s se decide (logic.assessRate). Si la PC no da abasto dos veces seguidas (cada 4 s), se baja un paso
 * (logic.stepDown) y se vuelve a empezar la captura, con un aviso. Si el juego o la pantalla dan menos cuadros, solo
 * se informa (en Ajustes). Con una grabacion en curso no se corta: se aplica al terminarla (un solo paso).
 * Solo se decide en los primeros RATE_JUDGE_MS de cada captura: un codificador que no llega se nota enseguida, y una
 * caida despues es el juego (un tiron, la ventana sin cuadros); reiniciar ahi tiraria el buffer de la repeticion.
 */
const RATE_JUDGE_MS = 30000;
function checkRate() {
  const s = session;
  if (!s?.info) return;
  const now = Date.now();
  s.samples.push({ at: now, frames: s.frames, delivered: Number.isFinite(s.delivered) ? s.delivered : null });
  if (s.samples.length > 9) s.samples.shift();
  if (now - s.startedAt < 6000 || s.samples.length < 5) return;
  const a = s.samples[0];
  const b = s.samples[s.samples.length - 1];
  const secs = (b.at - a.at) / 1000;
  if (secs < 3) return;
  const encoded = Math.round(((b.frames - a.frames) / secs) * 10) / 10;
  const delivered = a.delivered !== null && b.delivered !== null ? Math.round(((b.delivered - a.delivered) / secs) * 10) / 10 : null;
  s.rate = { encoded, delivered };
  // Ya hay un paso anotado esperando que termine la grabacion, o la captura ya paso su arranque: no se juzga
  if (pendingRestart || now - s.startedAt > RATE_JUDGE_MS) {
    s.strikes = 0;
    return;
  }
  if (now - (s.lastJudge || 0) < 4000) return;
  s.lastJudge = now;
  const verdict = logic.assessRate({ target: s.info.fps, delivered, encoded: medianRate(s.samples), hardware: Boolean(s.info.hardware) });
  s.strikes = verdict === 'encoder' ? s.strikes + 1 : 0;
  if (s.strikes < 2 || degradeCount >= 4) return;
  const next = logic.stepDown(current(), s.info.height);
  if (!next) return;
  s.strikes = 0;
  degrade = next;
  degradeCount++;
  console.warn(`[capture] la PC no llega (${encoded} de ${s.info.fps} fps codificados, ${delivered} capturados): se baja a ${next.quality} ${next.fps} fps`);
  notice('info', t(recording ? 'capture.degradedAfterRecording' : 'capture.degraded', { quality: qualityName(next.quality), fps: next.fps }));
  if (recording) pendingRestart = true;
  else restartSession().catch(() => {});
}

function onEnded({ session: id, reason }) {
  const s = session;
  // Solo la sesion que esta andando: el fin de una anterior (parar y volver a empezar seguidos) llega cuando la nueva
  // todavia no sabe su id, y no la tiene que cortar
  if (!s || !s.id || s.id !== id) return;
  session = null;
  pendingRestart = false; // la proxima arranca con current()
  dropRing();
  if (recording) {
    stopRecording().catch((err) => console.warn('[capture] grabacion cortada:', err?.message || err));
  }
  emitState();
  // El codificador fallo enseguida (la combinacion no es viable en esta PC): un paso abajo y otra vez
  const next = reason === 'error' && !quitting && target && Date.now() - s.startedAt < 20000 && degradeCount < 4 ? logic.stepDown(current(), s.info?.height) : null;
  if (next) {
    degrade = next;
    degradeCount++;
    notice('info', t('capture.degraded', { quality: qualityName(next.quality), fps: next.fps }));
    for (const p of [...s.purposes].filter((x) => x !== 'record')) ensureSession(p).catch((err) => console.warn('[capture] reinicio:', err?.message || err));
    return;
  }
  // La ventana del juego se cerro o se volvio a crear: buscarla de nuevo y seguir con la repeticion
  if (!quitting && target && cfg.replay && reason !== 'stopped') {
    clearTimeout(retargetTimer);
    retargetTimer = setTimeout(() => {
      if (!target) return;
      clearTarget();
      refreshTarget();
    }, 3000);
  }
}

function waitHeader(s, ms) {
  if (s.header) return Promise.resolve(s.header);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(coded('errNotReady', 'notReady')), ms);
    s.headerWaiters.push((hd) => {
      clearTimeout(timer);
      resolve(hd);
    });
  });
}

// ---------- Guardar ----------

function toSeconds(units, header) {
  return Math.round(((units * (header?.timecodeScale || 1000000)) / 1e9) * 10) / 10;
}

async function instanceDir(instanceId) {
  try {
    return guard(instances.dir(instanceId));
  } catch {
    throw coded('errInstance', 'instance');
  }
}

// Escribe las partes en <instancia>/<carpeta del tipo>/<nombre unico> y devuelve la ruta
async function writeOut(instanceId, kind, parts, name) {
  const dir = guard(logic.folderFor(await instanceDir(instanceId), kind));
  try {
    await fsp.mkdir(dir, { recursive: true });
    const file = await logic.uniqueName(dir, name || logic.fileName(kind), exists);
    const full = guard(path.join(dir, file));
    const fh = await fsp.open(full, 'wx');
    try {
      for (const p of parts) await fh.write(p, 0, p.length);
    } finally {
      await fh.close();
    }
    return full;
  } catch (err) {
    console.warn('[capture] no se pudo guardar:', err?.message || err);
    throw coded(err?.code === 'ENOSPC' ? 'errNoSpace' : 'errWrite', 'write');
  }
}

async function copyToExtra(file) {
  if (!cfg.copyTo) return;
  try {
    await fsp.mkdir(cfg.copyTo, { recursive: true });
    const name = await logic.uniqueName(cfg.copyTo, path.basename(file), exists);
    await fsp.copyFile(file, path.join(cfg.copyTo, name));
  } catch (err) {
    console.warn('[capture] copia extra:', err?.message || err);
  }
}

async function afterSave({ type, overlayType, file, instanceId, duration, thumb, reason }) {
  await copyToExtra(file);
  const evt = { type, path: file, instanceId };
  if (duration !== undefined) evt.duration = duration;
  if (reason) evt.reason = reason;
  send('capture:saved', evt);
  send('worlds:updated', { kind: 'media', instanceId });
  if (overlayType && cfg.notify) {
    const o = { kind: 'capture', type: overlayType, path: file };
    if (thumb) o.thumb = thumb;
    if (duration !== undefined) o.duration = duration;
    overlay(o);
  }
  emitState();
}

// Pasa del buffer en disco al archivo final de a un segmento por vez: un clip de 5 minutos no entra entero en memoria
async function writeReplay(instanceId, header, snap, reason) {
  const dir = guard(logic.folderFor(await instanceDir(instanceId), 'clip'));
  let rec = null;
  let full = null;
  let res;
  try {
    await fsp.mkdir(dir, { recursive: true });
    const name = await logic.uniqueName(dir, logic.fileName('clip', new Date(), reason), exists);
    full = guard(path.join(dir, name));
    rec = new RecordingFile(full, header, { reserve: CLIP_RESERVE, frameDur: Math.round(1000 / cfg.fps) });
    await rec.open();
    for await (const batch of snap.batches()) {
      for (const f of batch) rec.add(f);
      await rec.drain();
      if (rec.error) break;
    }
    res = await rec.finish();
    if (res.error) throw res.error;
  } catch (err) {
    await rec?.finish().catch(() => {});
    if (rec?.started) await fsp.rm(full, { force: true }).catch(() => {});
    console.warn('[capture] no se pudo guardar:', err?.message || err);
    throw coded(err?.code === 'ENOSPC' ? 'errNoSpace' : 'errWrite', 'write');
  }
  if (res.empty) {
    await fsp.rm(full, { force: true }).catch(() => {});
    throw coded('errReplayEmpty', 'empty');
  }
  return { file: full, duration: toSeconds(res.duration, header) };
}

async function saveFromRing(r, { instanceId, reason = null, seconds }) {
  await host.flush();
  const snap = await r.snapshot(seconds);
  if (!r.header || !snap) {
    snap?.release();
    throw coded('errReplayEmpty', 'empty');
  }
  try {
    // El clip ocupa lo mismo que su parte del buffer: sin ese lugar (y un margen) no se empieza a escribir
    const bytes = snap.parts.reduce((a, p) => a + p.size, 0);
    const free = await freeAt(logic.folderFor(await instanceDir(instanceId), 'clip'));
    if (free !== null && free < bytes + 64 * 1024 * 1024) throw coded('errNoSpace', 'write');
    const thumb = await host.thumb();
    const { file, duration } = await writeReplay(instanceId, r.header, snap, reason);
    await afterSave({ type: 'clip', overlayType: 'replay-saved', file, instanceId, duration, thumb, reason });
    return reason ? { path: file, instanceId, duration, reason } : { path: file, instanceId, duration };
  } finally {
    snap.release();
  }
}

// De a una, reteniendo el buffer: aunque se cierre el juego mientras tanto, el guardado termina
function queueSave(r, opts) {
  const release = r.retain();
  const run = saveChain.then(() => saveFromRing(r, opts)).finally(release);
  saveChain = run.catch(() => {});
  return run;
}

function saveReplay() {
  if (!cfg.replay) return Promise.reject(coded('errReplayOff', 'replayOff'));
  if (!target) return Promise.reject(coded('errNoGame', 'noGame'));
  if (!session || !ring) return Promise.reject(coded('errNotReady', 'notReady'));
  return queueSave(ring, { instanceId: target.instanceId });
}

// ---------- Clips automaticos ----------

const autoWanted = () => cfg.replay && cfg.auto.enabled;

function saveAuto(r, p) {
  return queueSave(r, { instanceId: p.ctx.instanceId, reason: p.reason, seconds: logic.autoSeconds(cfg.auto, cfg.replaySeconds) }).catch((err) => {
    console.warn('[capture] clip automatico:', err?.message || err);
    if (err?.code === 'write') notice('error', err.message);
  });
}

function onGameEvent(id, ev) {
  if (!cfg.replay || !target || target.instanceId !== id || !session || !ring) return;
  const res = gate.offer(ev.reason, cfg.auto, { instanceId: id });
  if (res.action === 'ignore') {
    if (res.why === 'limit' && gate.noteLimit()) notice('info', t('capture.autoLimitReached', { count: cfg.auto.maxPerSession }));
    return;
  }
  clearTimeout(autoTimer);
  autoTimer = setTimeout(() => {
    const r = ring;
    const p = gate.take();
    if (p && r) saveAuto(r, p);
  }, res.delay);
  autoTimer.unref?.();
  emitState();
}

// Plantillas de mensajes del juego para esta partida (en su version e idioma), solo si los clips automaticos estan prendidos
async function loadPlayLang(play) {
  if (!autoWanted()) return;
  const lang = await gamelang.readLanguage(play.dir);
  if (play.lang === lang) return;
  play.lang = lang;
  const rootId = play.rootId && /^[\w.+-]+$/.test(play.rootId) ? play.rootId : null;
  const tables = await gamelang.loadTables({
    assetsDir: paths.assets(),
    indexId: play.assetIndex,
    lang,
    jarPath: rootId ? paths.versionJar(rootId) : null,
    cacheFile: rootId ? paths.cache('capture-lang', `${rootId}.json`) : null,
  });
  play.reader.setTables(tables);
  if (!tables.length) console.warn('[capture] clips automaticos: no se pudieron leer los textos del juego');
}

function reloadPlayLang(play) {
  loadPlayLang(play).catch((err) => console.warn('[capture] idioma del juego:', err?.message || err));
}

// Antes de lanzar: la cuenta de la partida (la del log, si la dice, manda despues) y de donde sacar sus textos
function onBeforeLaunch({ id, instance, resolved, account, quiet }) {
  if (quiet) {
    plays.delete(id);
    return;
  }
  const play = { reader: new GameLogReader({ player: account?.name }), dir: instance?.dir || null, assetIndex: resolved?.assetIndex?.id || null, rootId: resolved?.rootId || null, lang: null, langTimer: null };
  plays.set(id, play);
  reloadPlayLang(play);
}

function onGameLog(id, lines) {
  const play = plays.get(id);
  if (!play || !Array.isArray(lines)) return;
  for (const l of lines) {
    const ev = play.reader.read(l?.text);
    if (!ev) continue;
    if (ev.reason) onGameEvent(id, ev);
    else if (ev.setup === 'reload') {
      clearTimeout(play.langTimer);
      play.langTimer = setTimeout(() => reloadPlayLang(play), LANG_RELOAD_MS);
      play.langTimer.unref?.();
    }
  }
}

function smallThumb(png) {
  try {
    const { nativeImage } = require('electron');
    const img = nativeImage.createFromBuffer(png);
    if (img.isEmpty()) return null;
    const small = img.getSize().width > 320 ? img.resize({ width: 320, quality: 'good' }) : img;
    return `data:image/jpeg;base64,${small.toJPEG(78).toString('base64')}`;
  } catch {
    return null;
  }
}

// Un cuadro de la ventana del juego para otro modulo (timelapse): no se guarda ni avisa y, si hay una captura andando,
// sale de esa misma (asi no se abre otra). opts = { mime, quality, maxHeight }. Solo la ventana del juego: nunca la pantalla.
async function grabFrame(instanceId, opts = {}) {
  if (!target || target.instanceId !== instanceId || !target.found) throw coded('errNoGame', 'noGame');
  const src = await resolveSource();
  return host.grab(src, { ...opts, reuse: true });
}

// Lo que guarda otro modulo en clips/ (montaje, timelapse): la misma copia extra y los mismos avisos que un clip
function savedElsewhere({ file, instanceId, duration }) {
  return afterSave({ type: 'clip', file, instanceId, duration });
}

async function screenshot() {
  if (!target) throw coded('errNoGame', 'noGame');
  const instanceId = target.instanceId;
  const src = await resolveSource();
  let shot;
  try {
    shot = await host.grab(src);
  } catch (err) {
    console.warn('[capture] captura:', err?.message || err);
    throw coded('errCapture', 'capture');
  }
  const file = await writeOut(instanceId, 'screenshot', [shot.data]);
  await afterSave({ type: 'screenshot', overlayType: 'screenshot', file, instanceId, thumb: smallThumb(shot.data) });
  return { path: file, instanceId, width: shot.width, height: shot.height };
}

function recordingInfo() {
  return recording ? { active: true, instanceId: recording.instanceId, startedAt: recording.startedAt, path: recording.path } : { active: false };
}

async function startRecording() {
  if (recording) return recordingInfo();
  if (!target) throw coded('errNoGame', 'noGame');
  const instanceId = target.instanceId;
  const s = await ensureSession('record');
  let file = null;
  try {
    const header = await waitHeader(s, 10000);
    const dir = guard(logic.folderFor(await instanceDir(instanceId), 'recording'));
    await fsp.mkdir(dir, { recursive: true });
    // Al menos un par de minutos y el margen de siempre: si no, ni empieza
    const free = await freeAt(dir);
    if (!logic.hasDiskRoom(free, 2 * logic.estimateBytes(60, plan(), cfg.audio))) throw coded('errRecordNoRoom', 'noRoom');
    const name = await logic.uniqueName(dir, logic.fileName('recording'), exists);
    const full = guard(path.join(dir, name));
    file = new RecordingFile(full, header, { frameDur: Math.round(1000 / cfg.fps) });
    await file.open();
    recording = { file, instanceId, path: full, startedAt: Date.now(), dir };
  } catch (err) {
    await releaseSession('record');
    if (err?.code) throw err;
    console.warn('[capture] no se pudo empezar a grabar:', err?.message || err);
    throw coded('errWrite', 'write');
  }
  if (cfg.notify) overlay({ kind: 'capture', type: 'recording-start' });
  emitState();
  return recordingInfo();
}

async function stopRecording() {
  const rec = recording;
  if (!rec) return null;
  await host.flush(); // los ultimos cuadros todavia van a la grabacion
  if (recording !== rec) return null;
  recording = null;
  const res = await rec.file.finish();
  releaseSession('record').catch(() => {});
  if (res.empty || res.error) {
    await fsp.rm(rec.path, { force: true }).catch(() => {});
    emitState();
    if (res.error) {
      console.warn('[capture] grabacion:', res.error?.message || res.error);
      throw coded('errWrite', 'write');
    }
    throw coded('errRecordingEmpty', 'empty');
  }
  const duration = toSeconds(res.duration, rec.file.header);
  await afterSave({ type: 'recording', overlayType: 'recording-stop', file: rec.path, instanceId: rec.instanceId, duration });
  return { path: rec.path, instanceId: rec.instanceId, duration };
}

function toggleRecording() {
  return recording ? stopRecording() : startRecording();
}

// Cada segundo con una grabacion: corta (guardando) al llegar al limite elegido o si el disco se queda sin lugar
async function watchRecording() {
  const rec = recording;
  if (!rec) return;
  const reason = cfg.recordLimit && rec.file.duration >= cfg.recordLimit * 60 ? 'limit' : null;
  let low = false;
  if (!reason && ++diskTick % 5 === 0) {
    const free = await freeAt(rec.dir);
    low = free !== null && free < logic.DISK_MARGIN / 2;
  }
  if ((!reason && !low) || recording !== rec) return;
  try {
    await stopRecording();
    notice('info', reason === 'limit' ? t('capture.recordLimitReached', { minutes: cfg.recordLimit }) : t('capture.recordStoppedDisk'));
  } catch (err) {
    notice('error', err?.message || err);
  }
}

// Lo que exporta el editor de la interfaz (WebM de MediaRecorder): se rearma con duracion e indice y va a clips/
async function saveExport(meta, bytes) {
  const m = meta && typeof meta === 'object' ? meta : {};
  const instanceId = String(m.instanceId || '');
  try {
    await instances.get(instanceId);
  } catch {
    throw coded('errInstance', 'instance');
  }
  const size = bytes?.byteLength || 0;
  if (!size) throw coded('errExportEmpty', 'empty');
  if (size > MAX_EXPORT) throw coded('errExportTooBig', 'tooBig');
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let built;
  try {
    built = webm.remux(buf);
  } catch (err) {
    console.warn('[capture] exportar:', err?.message || err);
    throw coded('errExportBad', 'badWebm');
  }
  const name = logic.exportName(m.sourceName, m.mode === 'vertical' ? 'vertical' : 'edit');
  const file = await writeOut(instanceId, 'clip', built.parts, name);
  const duration = toSeconds(built.duration, built.header);
  await afterSave({ type: 'clip', file, instanceId, duration });
  return { path: file, name: path.basename(file), duration };
}

// ---------- Atajos globales ----------

function runShortcut(action) {
  const now = Date.now();
  if (now - (lastPress.get(action) || 0) < SHORTCUT_DEBOUNCE_MS) return;
  lastPress.set(action, now);
  const fn = action === 'replay' ? saveReplay : action === 'record' ? toggleRecording : screenshot;
  Promise.resolve()
    .then(fn)
    .catch((err) => notice('error', err?.message || err));
}

function unregisterShortcuts() {
  if (!registered.size) return;
  const { globalShortcut } = require('electron');
  for (const accel of registered.values()) {
    try {
      globalShortcut.unregister(accel);
    } catch {
      /* ya no estaba */
    }
  }
  registered.clear();
}

// Solo con un juego abierto (y solo los atajos de este modulo: nunca unregisterAll)
function registerShortcuts() {
  unregisterShortcuts();
  if (!target) return;
  const { globalShortcut } = require('electron');
  for (const action of logic.ACTIONS) {
    const accel = cfg.shortcuts[action];
    if (!accel) continue;
    let ok = false;
    try {
      ok = !globalShortcut.isRegistered(accel) && globalShortcut.register(accel, () => runShortcut(action));
    } catch {
      ok = false;
    }
    if (ok) registered.set(action, accel);
    else console.warn(`[capture] no se pudo registrar el atajo ${accel} (${action})`);
  }
  emitState();
}

function testShortcut(raw, action) {
  const accel = logic.normalizeAccelerator(raw);
  if (!accel) return { ok: false, reason: 'invalid' };
  const other = logic.ACTIONS.find((a) => a !== action && cfg.shortcuts[a] && cfg.shortcuts[a].toLowerCase() === accel.toLowerCase());
  if (other) return { ok: false, accel, reason: 'duplicate', other };
  if (registered.get(action) === accel) return { ok: true, accel };
  const { globalShortcut } = require('electron');
  try {
    if (globalShortcut.isRegistered(accel)) return { ok: false, accel, reason: 'inUse' };
    const ok = globalShortcut.register(accel, () => {});
    if (ok) globalShortcut.unregister(accel);
    return ok ? { ok: true, accel } : { ok: false, accel, reason: 'inUse' };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}

// ---------- Ajustes ----------

function applySettings(raw) {
  const prev = cfg;
  cfg = logic.normalizeSettings(raw);
  if (JSON.stringify(prev.shortcuts) !== JSON.stringify(cfg.shortcuts)) registerShortcuts();
  const streamChanged = prev.quality !== cfg.quality || prev.fps !== cfg.fps || prev.level !== cfg.level || prev.audio !== cfg.audio;
  if (streamChanged) {
    // Ajustes nuevos: se vuelve a probar lo que eligio el usuario
    degrade = null;
    degradeCount = 0;
  }
  if (ring && prev.replaySeconds !== cfg.replaySeconds) {
    ring.setSeconds(cfg.replaySeconds);
    checkDiskRoom(ring);
  }
  if (cfg.replay && (!prev.replay || prev.replaySeconds !== cfg.replaySeconds || streamChanged)) refreshDisk();
  if (!cfg.auto.enabled) {
    clearTimeout(autoTimer);
    gate.take();
  }
  if (autoWanted()) for (const play of plays.values()) reloadPlayLang(play);
  if (prev.replay && !cfg.replay) releaseSession('replay').catch(() => {});
  else if (!prev.replay && cfg.replay) {
    if (target?.found) ensureSession('replay').catch((err) => console.warn('[capture] repeticion:', err?.message || err));
  } else if (streamChanged && session) {
    if (recording) pendingRestart = true;
    else restartSession().catch(() => {});
  }
  // En pausa por falta de disco y cambio lo que ocupa: se vuelve a probar
  if (prev.replay && cfg.replay && (prev.replaySeconds !== cfg.replaySeconds || streamChanged)) retryReplay();
  emitState();
}

async function openFolder(opts = {}) {
  const { shell } = require('electron');
  const o = opts && typeof opts === 'object' ? opts : {};
  const kind = logic.KIND_DIR[o.kind] ? o.kind : 'clip';
  let id = o.instanceId ? String(o.instanceId) : target?.instanceId || (await settings.get()).selectedInstance || null;
  let dir;
  if (id) {
    try {
      await instances.get(id);
      dir = guard(logic.folderFor(await instanceDir(id), kind));
    } catch {
      id = null;
    }
  }
  if (!dir) dir = guard(require('../core/paths').instances());
  await fsp.mkdir(dir, { recursive: true });
  const err = await shell.openPath(dir);
  if (err) throw new Error(err);
  return { path: dir };
}

// ---------- Busqueda con IA (solo a pedido del usuario) ----------

function aiModule() {
  try {
    return require('./ai');
  } catch {
    return null;
  }
}

async function aiStatus() {
  const ai = aiModule();
  try {
    return { available: Boolean(ai && (await ai.available())) };
  } catch {
    return { available: false };
  }
}

// list = [{ key, path }] (hasta 20 capturas); devuelve { described, skipped, errorCode?, error? }
async function aiDescribe(list) {
  const root = require('../core/paths').instances();
  const valid = [];
  for (const it of Array.isArray(list) ? list.slice(0, describe.MAX_PER_RUN) : []) {
    const key = typeof it?.key === 'string' && it.key.length <= 600 ? it.key : null;
    const full = logic.screenshotPath(it?.path, root);
    if (key && full) valid.push({ key, path: guard(full) });
  }
  if (!valid.length) return { described: 0, skipped: 0 };
  const ai = aiModule();
  if (!ai || !(await ai.available().catch(() => false))) throw coded('errAiUnavailable', 'unavailable');
  const { nativeImage } = require('electron');
  const encode = async (p) => {
    const img = nativeImage.createFromPath(p);
    if (img.isEmpty()) return null;
    const small = img.getSize().width > 448 ? img.resize({ width: 448, quality: 'good' }) : img;
    return small.toJPEG(62).toString('base64');
  };
  const language = (await settings.get()).language || 'es';
  const res = await describe.describe(valid, { ai, encode, language });
  if (res.error && !res.described) throw res.error; // ya trae el mensaje traducido y err.code de ai.js
  return { described: res.described, skipped: res.skipped, errorCode: res.error?.code || null, error: res.error?.message || null };
}

// ---------- Registro ----------

function register(c) {
  ctx = c;
  const { handle, onQuit } = c;
  if (!support.capture) {
    // Plataforma sin grabacion (logic.platformSupport): Ajustes lo dice; el editor y la galeria siguen andando
    handle('capture:status', () => status());
    for (const ch of ['capture:saveReplay', 'capture:screenshot', 'capture:startRecording', 'capture:stopRecording', 'capture:toggleRecording', 'capture:testShortcut']) {
      handle(ch, () => {
        throw coded('errPlatform', 'unavailable');
      });
    }
    handle('capture:openFolder', (opts) => openFolder(opts));
    handle('capture:saveExport', (meta, bytes) => saveExport(meta, bytes));
    handle('capture:aiStatus', () => aiStatus());
    handle('capture:aiIndex', () => describe.index());
    handle('capture:aiDescribe', (list) => aiDescribe(list));
    // Los ajustes igual se cargan (el panel los muestra y la copia extra se usa al exportar), sin applySettings: no
    // hay atajos, ni sesion, ni buffer
    const load = (s) => {
      cfg = logic.normalizeSettings(s?.capture);
      emitState();
    };
    settings.get().then(load).catch(() => {});
    settings.onChange((s, patch) => {
      if (patch && Object.prototype.hasOwnProperty.call(patch, 'capture')) load(s);
    });
    return;
  }
  const { RecorderHost } = require('./capture/host');
  host = new RecorderHost({ getMainWindow: () => c.getWindow?.() });
  host.on('chunk', onChunk);
  host.on('ended', onEnded);
  host.on('stats', onStats);
  // Lo que haya dejado un cierre de golpe (todavia no hay ningun juego abierto)
  cleanRoot(ringRoot()).then(() => refreshDisk());

  settings
    .get()
    .then((s) => applySettings(s.capture))
    .catch(() => {});
  settings.onChange((s, patch) => {
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'capture')) applySettings(s.capture);
  });
  game.events.on('state', (id, st) => {
    onGameState(id, st).catch((err) => console.warn('[capture] juego:', err?.message || err));
  });
  game.addBeforeLaunch(onBeforeLaunch);
  game.events.on('log', onGameLog);

  handle('capture:status', () => status());
  handle('capture:saveReplay', () => saveReplay());
  handle('capture:screenshot', () => screenshot());
  handle('capture:startRecording', () => startRecording());
  handle('capture:stopRecording', () => stopRecording());
  handle('capture:toggleRecording', () => toggleRecording());
  handle('capture:testShortcut', (accel, action) => testShortcut(accel, logic.ACTIONS.includes(action) ? action : null));
  handle('capture:openFolder', (opts) => openFolder(opts));
  handle('capture:saveExport', (meta, bytes) => saveExport(meta, bytes));
  handle('capture:aiStatus', () => aiStatus());
  handle('capture:aiIndex', () => describe.index());
  handle('capture:aiDescribe', (list) => aiDescribe(list));

  // Mientras graba, el estado (duracion y buffer) se actualiza cada segundo; tambien se mira la velocidad, el limite
  // de la grabacion y el disco (el buffer se pausa si el disco se queda sin lugar por otra cosa)
  let tick = 0;
  setInterval(() => {
    tick++;
    if (session) checkRate();
    if (recording) watchRecording().catch(() => {});
    if (ring && tick % 15 === 0) {
      const r = ring;
      refreshDisk().then((free) => {
        if (ring === r && free !== null && free < logic.DISK_MARGIN / 2) blockReplay('noRoom', t('capture.errReplayNoRoomNeed', { need: fmtSize(replayNeed()) }));
      });
    }
    // En pausa por falta de disco: si se libero lugar, vuelve sola (no oscila: se pausa con menos de medio margen
    // libre y vuelve recien con el buffer entero y el margen)
    if (!ring && replayBlocked === 'noRoom' && tick % 15 === 0) retryReplay();
    if (recording || ring) emitState();
  }, 1000).unref?.();

  onQuit(async () => {
    quitting = true;
    clearTimeout(retargetTimer);
    unregisterShortcuts();
    if (recording) {
      const rec = recording;
      recording = null;
      await rec.file.finish().catch(() => {});
    }
    clearTarget();
    const dropped = dropRing();
    host?.destroy();
    await dropped;
    await saveChain;
    await cleanRoot(ringRoot());
  });
}

module.exports = { register, status, saveReplay, screenshot, startRecording, stopRecording, grabFrame, savedElsewhere };
