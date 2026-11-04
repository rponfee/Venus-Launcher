'use strict';
// Clips y capturas del juego: repeticion instantanea (guarda los ultimos 60 s, o 5 minutos con Venus Premium, al
// apretar el atajo o sola al morir, conseguir un logro o matar un jefe), grabacion (empezar/parar) y capturas de
// pantalla de la ventana del juego, con atajos globales.
// Graba una ventana oculta (capture/host.js + renderer/recorder.html) con desktopCapturer + MediaRecorder (WebM VP9
// o VP8 + Opus); capture/webm.js recorta y rearma el WebM con duracion e indice. El buffer de la repeticion va al
// disco (capture/ring.js, en cache/capture-replay: se borra al cerrar y al arrancar), no a la memoria. Nada se graba
// sin pedirlo: la repeticion esta apagada por defecto y solo corre mientras hay un juego abierto; los atajos tambien
// se registran solo con un juego abierto (asi no le quitan esas teclas a otras aplicaciones).
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
//   capture:setPremium(bool)  (la interfaz avisa si la cuenta tiene Venus Premium: repeticion de 5 minutos)
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
let premium = false;
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
let recording = null; // { file: RecordingFile, instanceId, path, startedAt }
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

function status() {
  const seconds = logic.replaySeconds(premium);
  return {
    settings: cfg,
    premium,
    replaySeconds: seconds,
    diskEstimate: logic.replayDisk(seconds, cfg.quality, cfg.fps),
    game: target ? { instanceId: target.instanceId, window: target.found, searching: !target.found } : null,
    replay: { enabled: cfg.replay, active: Boolean(session && ring), buffered: ring ? Math.round(ring.buffered) : 0, disk: ring ? ring.bytes : 0, error: replayBlocked },
    auto: { saved: gate.count, limit: cfg.auto.maxPerSession },
    recording: recording ? { active: true, instanceId: recording.instanceId, startedAt: recording.startedAt, duration: recording.file.duration } : { active: false },
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
  return { box: logic.qualityBox(cfg.quality), fps: cfg.fps, audio: cfg.audio, bitrate: { bpp: logic.BPP, min: logic.MIN_BPS, max: logic.MAX_BPS }, keyframeMs: logic.KEYFRAME_MS };
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
  const s = { id: null, purposes: new Set([purpose]), reader: new webm.WebmReader(), header: null, headerWaiters: [], ready: null, broken: false };
  session = s;
  if (purpose === 'replay') ring = makeRing(null);
  s.ready = (async () => {
    const src = await resolveSource();
    const info = await host.start(src, streamOptions());
    s.id = info.session;
    if (info.audioFailed) console.warn('[capture] sin el sonido del equipo: se graba solo el video');
    if (session !== s || !s.purposes.size) {
      if (session === s) session = null;
      await host.stop();
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

function makeRing(header) {
  const r = new ReplayRing({ dir: path.join(ringRoot(), `r${Date.now().toString(36)}${++ringSeq}`), seconds: logic.replaySeconds(premium), onError: (err) => onRingError(r, err) });
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

function onRingError(r, err) {
  if (ring !== r) return;
  console.warn('[capture] buffer de la repeticion:', err?.message || err);
  blockReplay('disk', t(err?.code === 'ENOSPC' ? 'capture.errNoSpace' : 'capture.errWrite'));
}

// No arranca si dejaria el disco casi lleno (el juego tambien necesita lugar para guardar el mundo)
async function checkDiskRoom(r) {
  let free = null;
  try {
    await fsp.mkdir(ringRoot(), { recursive: true });
    const st = await fsp.statfs(ringRoot());
    free = st.bavail * st.bsize;
  } catch {
    /* no se sabe: se deja pasar y, si se llena, avisa la escritura */
  }
  if (ring === r && !logic.hasDiskRoom(free, logic.replayDisk(r.seconds, cfg.quality, cfg.fps))) blockReplay('noRoom', t('capture.errReplayNoRoom'));
}

async function stopSession() {
  const s = session;
  session = null;
  const dropped = dropRing();
  if (s) await host?.stop().catch(() => {});
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
    ring?.add(f);
    recording?.file.add(f);
  }
}

function onEnded({ session: id, reason }) {
  const s = session;
  if (!s || (s.id && s.id !== id)) return;
  session = null;
  dropRing();
  if (recording) {
    stopRecording().catch((err) => console.warn('[capture] grabacion cortada:', err?.message || err));
  }
  emitState();
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
  return queueSave(r, { instanceId: p.ctx.instanceId, reason: p.reason, seconds: logic.autoSeconds(cfg.auto, premium) }).catch((err) => {
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
    const name = await logic.uniqueName(dir, logic.fileName('recording'), exists);
    const full = guard(path.join(dir, name));
    file = new RecordingFile(full, header, { frameDur: Math.round(1000 / cfg.fps) });
    await file.open();
    recording = { file, instanceId, path: full, startedAt: Date.now() };
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
  const streamChanged = prev.quality !== cfg.quality || prev.fps !== cfg.fps || prev.audio !== cfg.audio;
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
  const { RecorderHost } = require('./capture/host');
  host = new RecorderHost({ getMainWindow: () => c.getWindow?.() });
  host.on('chunk', onChunk);
  host.on('ended', onEnded);
  // Lo que haya dejado un cierre de golpe (todavia no hay ningun juego abierto)
  cleanRoot(ringRoot());

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
  handle('capture:setPremium', (value) => {
    const next = value === true;
    if (next !== premium) {
      premium = next;
      if (ring) {
        ring.setSeconds(logic.replaySeconds(premium));
        checkDiskRoom(ring);
      }
      emitState();
    }
    return status();
  });
  handle('capture:testShortcut', (accel, action) => testShortcut(accel, logic.ACTIONS.includes(action) ? action : null));
  handle('capture:openFolder', (opts) => openFolder(opts));
  handle('capture:saveExport', (meta, bytes) => saveExport(meta, bytes));
  handle('capture:aiStatus', () => aiStatus());
  handle('capture:aiIndex', () => describe.index());
  handle('capture:aiDescribe', (list) => aiDescribe(list));

  // Mientras graba, el estado (duracion y buffer) se actualiza cada segundo
  setInterval(() => {
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
