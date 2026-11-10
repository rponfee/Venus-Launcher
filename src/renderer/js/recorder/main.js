// Grabadora oculta de clips y capturas. La abre el proceso principal (modules/capture/host.js) en una ventana que
// nunca se muestra: captura la ventana del juego (la elige el proceso principal en su manejador de
// getDisplayMedia) y graba con MediaRecorder (WebM VP9 o VP8 + Opus) en pedazos de 1 s que manda al proceso
// principal, que arma la repeticion instantanea y las grabaciones. Tambien saca capturas al tamanio real.
// El codec lo elige el proceso principal (lista en orden de preferencia, logic.codecOrder); aca se usa el primero
// que este MediaRecorder acepte y arranque. Cada STATS_MS avisa cuantos cuadros entrego la captura, para que el
// proceso principal sepa si la PC no llega a los fps pedidos (y por que).
import { bitrateFor } from './bitrate.js';

const bridge = window.venusRecorder;

const CHUNK_MS = 1000;
const STATS_MS = 2000;
let current = null; // { session, stream, recorder, queue, flushWaiters, track, statsTimer }

const send = (msg) => bridge?.send(msg);
const reply = (id, value) => send({ type: 'reply', id, value });
const replyError = (id, err) => send({ type: 'reply', id, error: String(err?.message || err || 'error'), name: err?.name || 'Error', code: err?.code || 'recorder' });

function videoConstraints({ fps, box }) {
  const v = { frameRate: { ideal: fps || 30, max: fps || 30 } };
  if (box?.width && box?.height) {
    v.width = { max: box.width };
    v.height = { max: box.height };
  }
  return v;
}

// Pide la ventana. Primero getDisplayMedia (con el sonido del equipo si se pidio); si falla el sonido, sin sonido;
// si falla todo, la forma vieja de Electron con el id de la fuente.
async function openStream({ fps, box, audio, sourceId }) {
  const video = videoConstraints({ fps, box });
  if (audio) {
    try {
      return { stream: await navigator.mediaDevices.getDisplayMedia({ video, audio: true }), audio: true };
    } catch (err) {
      send({ type: 'warning', message: `sin audio: ${err?.name}: ${err?.message}` });
    }
  }
  try {
    return { stream: await navigator.mediaDevices.getDisplayMedia({ video, audio: false }), audio: false, audioFailed: Boolean(audio) };
  } catch (err) {
    if (!sourceId) throw err;
    send({ type: 'warning', message: `getDisplayMedia: ${err?.name}: ${err?.message}` });
    const mandatory = { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxFrameRate: fps || 30 };
    if (box?.width) Object.assign(mandatory, { maxWidth: box.width, maxHeight: box.height });
    return { stream: await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory } }), audio: false, audioFailed: Boolean(audio) };
  }
}

const CODECS = new Set(['vp9', 'vp8', 'av1', 'h264']);
const mimeOf = (codec, withAudio) => `video/webm;codecs=${codec}${withAudio ? ',opus' : ''}`;

// Codecs de la lista que esta PC codifica por hardware a ese tamanio y fps. MediaRecorder no lo dice y
// mediaCapabilities.encodingInfo no acepta 'record' en este Chromium (y con 'webrtc' nunca dice powerEfficient):
// se pregunta a WebCodecs con prefer-hardware, que usa los mismos codificadores de la GPU.
const WEBCODECS = { av1: 'av01.0.13M.08', h264: 'avc1.640034', vp9: 'vp09.00.51.08', vp8: 'vp8' };
async function hardwareCodecs(list, { width, height }) {
  const out = [];
  if (typeof VideoEncoder !== 'function' || !VideoEncoder.isConfigSupported) return out;
  for (const codec of list) {
    try {
      // Solo codec y tamanio: con framerate y bitrate, este Chromium dice que no a 1440p60 o 4K60 aunque la GPU los
      // codifica (medido: AV1 y H.264 a 4K60 con menos del 10 % de CPU)
      const res = await VideoEncoder.isConfigSupported({ codec: WEBCODECS[codec], width, height, hardwareAcceleration: 'prefer-hardware' });
      if (res?.supported) out.push(codec);
    } catch {
      /* no se sabe: no cuenta como hardware */
    }
  }
  return out;
}

// Formatos a probar: primero los de cmd.hardware que anden por hardware, despues cmd.codecs (siempre WebM; al
// final, el que elija el navegador). [{ codec, mime, hardware }]
async function mimeCandidates(withAudio, cmd, size) {
  const valid = (l) => (Array.isArray(l) ? l : []).filter((c) => CODECS.has(c) && MediaRecorder.isTypeSupported(mimeOf(c, withAudio)));
  const hw = await hardwareCodecs(valid(cmd.hardware), size);
  const sw = valid(cmd.codecs?.length ? cmd.codecs : ['vp9', 'vp8']);
  const out = [...hw.map((codec) => ({ codec, hardware: true })), ...sw.filter((c) => !hw.includes(c)).map((codec) => ({ codec, hardware: false }))].map((c) => ({ ...c, mime: mimeOf(c.codec, withAudio) }));
  out.push({ codec: 'vp8', hardware: false, mime: MediaRecorder.isTypeSupported('video/webm') ? 'video/webm' : '' });
  return out;
}

// Tamanio real de los cuadros (getSettings() de una captura puede decir el tope pedido y no el de la ventana)
async function frameSize(stream, fallback) {
  const v = document.createElement('video');
  v.muted = true;
  v.srcObject = stream;
  try {
    await Promise.race([v.play(), new Promise((resolve) => setTimeout(resolve, 3000))]);
    for (let i = 0; i < 30 && !v.videoWidth; i++) await new Promise((resolve) => setTimeout(resolve, 50));
    return v.videoWidth && v.videoHeight ? { width: v.videoWidth, height: v.videoHeight } : fallback;
  } catch {
    return fallback;
  } finally {
    v.pause();
    v.srcObject = null;
  }
}

// Cuadros que entrego la captura hasta ahora (MediaStreamTrack.stats, si este Chromium lo tiene) o null
function trackFrames(track) {
  try {
    const st = track.stats;
    if (st && Number.isFinite(st.deliveredFrames)) return { delivered: st.deliveredFrames, discarded: st.discardedFrames || 0, total: st.totalFrames || 0 };
  } catch {
    /* sin estadisticas */
  }
  return null;
}

function stopTracks(stream) {
  for (const t of stream?.getTracks?.() || []) {
    try {
      t.stop();
    } catch {
      /* ya estaba parada */
    }
  }
}

// ---------- Sesion ----------

async function start(cmd) {
  if (current) await stop();
  const opened = await openStream(cmd);
  const { stream } = opened;
  const track = stream.getVideoTracks()[0];
  if (!track) {
    stopTracks(stream);
    throw new Error('no video');
  }
  // Un juego se mueve: que la captura priorice los cuadros por segundo antes que el detalle
  try {
    track.contentHint = 'motion';
  } catch {
    /* sin contentHint */
  }
  const s = track.getSettings();
  const { width, height } = await frameSize(stream, { width: s.width || cmd.box?.width || 1280, height: s.height || cmd.box?.height || 720 });
  // El primer codec que MediaRecorder acepte y arranque (si uno falla al crear el codificador, el siguiente)
  let recorder = null;
  let chosen = null;
  let videoBitsPerSecond = 0;
  let lastErr = null;
  for (const cand of await mimeCandidates(stream.getAudioTracks().length > 0, cmd, { width, height })) {
    videoBitsPerSecond = bitrateFor(width, height, cmd.fps, cmd.bitrate, cand.codec, cand.hardware);
    const options = { videoBitsPerSecond, audioBitsPerSecond: 128000, videoKeyFrameIntervalDuration: cmd.keyframeMs || 2000 };
    if (cmd.bitrateMode) options.videoBitrateMode = cmd.bitrateMode;
    if (cand.mime) options.mimeType = cand.mime;
    try {
      const r = new MediaRecorder(stream, options);
      r.start(CHUNK_MS);
      recorder = r;
      chosen = cand;
      break;
    } catch (err) {
      lastErr = err;
      send({ type: 'warning', message: `${cand.mime}: ${err?.name}: ${err?.message}` });
    }
  }
  if (!recorder) {
    stopTracks(stream);
    throw lastErr || new Error('no recorder');
  }
  const sess = { session: cmd.session, stream, recorder, track, queue: Promise.resolve(), flushWaiters: [], stopped: false, statsTimer: null };
  recorder.ondataavailable = (e) => {
    const waiters = sess.flushWaiters.splice(0);
    sess.queue = sess.queue.then(async () => {
      if (e.data && e.data.size) send({ type: 'chunk', session: sess.session, data: new Uint8Array(await e.data.arrayBuffer()) });
      waiters.forEach((w) => w());
    });
  };
  recorder.onerror = (e) => {
    send({ type: 'warning', message: `MediaRecorder: ${e?.error?.name || ''} ${e?.error?.message || ''}` });
    end(sess, 'error');
  };
  // La ventana del juego se cerro (o dejo de poder capturarse)
  track.addEventListener('ended', () => end(sess, 'ended'));
  current = sess;
  // Cuantos cuadros llegan de la captura (el proceso principal los compara con los que salen codificados)
  if (trackFrames(track)) {
    sess.statsTimer = setInterval(() => {
      const f = trackFrames(track);
      if (f && current === sess) send({ type: 'stats', session: sess.session, at: performance.now(), ...f });
    }, STATS_MS);
  }
  return { width, height, mimeType: recorder.mimeType || chosen.mime, codec: chosen.codec, hardware: chosen.hardware, bitrate: videoBitsPerSecond, audio: stream.getAudioTracks().length > 0, audioFailed: Boolean(opened.audioFailed), fps: cmd.fps, sourceFps: s.frameRate || 0, stats: Boolean(sess.statsTimer) };
}

// Termina la sesion: espera los ultimos pedazos y avisa
function end(sess, reason) {
  if (sess.stopped) return sess.done;
  sess.stopped = true;
  clearInterval(sess.statsTimer);
  sess.done = new Promise((resolve) => {
    const finish = () =>
      sess.queue.then(() => {
        stopTracks(sess.stream);
        if (current === sess) current = null;
        send({ type: 'ended', session: sess.session, reason });
        resolve();
      });
    if (sess.recorder.state !== 'inactive') {
      sess.recorder.addEventListener('stop', () => setTimeout(finish, 0), { once: true });
      try {
        sess.recorder.stop();
      } catch {
        finish();
      }
    } else finish();
  });
  return sess.done;
}

async function stop() {
  if (current) await end(current, 'stopped');
}

// Entrega lo que el MediaRecorder tenia guardado (antes de recortar la repeticion)
function flush() {
  const sess = current;
  if (!sess || sess.recorder.state !== 'recording') return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 2000);
    sess.flushWaiters.push(() => {
      clearTimeout(timer);
      resolve(true);
    });
    try {
      sess.recorder.requestData();
    } catch {
      resolve(false);
    }
  });
}

// ---------- Cuadros ----------

// Un cuadro de la pista como ImageBitmap (ImageCapture o, si no hay, un <video>)
async function frameOf(track, stream) {
  if (typeof ImageCapture === 'function') {
    try {
      return await new ImageCapture(track).grabFrame();
    } catch {
      /* se prueba con un video */
    }
  }
  const v = document.createElement('video');
  v.muted = true;
  v.srcObject = stream;
  await v.play();
  await new Promise((resolve) => (typeof v.requestVideoFrameCallback === 'function' ? v.requestVideoFrameCallback(() => resolve()) : setTimeout(resolve, 200)));
  const bmp = await createImageBitmap(v);
  v.pause();
  v.srcObject = null;
  return bmp;
}

async function encode(bitmap, width, height, type, quality) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, width, height);
  return canvas.convertToBlob({ type, quality });
}

// Miniatura del cuadro actual de la sesion (data: JPEG)
async function thumb(width = 320) {
  const sess = current;
  if (!sess) return null;
  const bmp = await frameOf(sess.track, sess.stream);
  const w = Math.min(width, bmp.width);
  const h = Math.max(2, Math.round((bmp.height * w) / bmp.width));
  const blob = await encode(bmp, w, h, 'image/jpeg', 0.8);
  bmp.close?.();
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => resolve(null);
    r.readAsDataURL(blob);
  });
}

// Captura de pantalla al tamanio real de la ventana (PNG). Para el timelapse: otro formato (cmd.mime, cmd.quality),
// achicada (cmd.maxHeight) y, con cmd.reuse, del cuadro de la captura que este andando en vez de abrir otra.
async function grab(cmd) {
  const reused = cmd.reuse && current ? current : null;
  const opened = reused ? null : await openStream({ fps: 30, box: null, audio: false, sourceId: cmd.sourceId });
  const stream = reused ? reused.stream : opened.stream;
  try {
    const track = reused ? reused.track : stream.getVideoTracks()[0];
    if (!track) throw new Error('no video');
    const bmp = await frameOf(track, stream);
    const k = cmd.maxHeight && bmp.height > cmd.maxHeight ? cmd.maxHeight / bmp.height : 1;
    const width = Math.max(2, Math.round(bmp.width * k));
    const height = Math.max(2, Math.round(bmp.height * k));
    const blob = await encode(bmp, width, height, cmd.mime || 'image/png', cmd.quality);
    const out = { data: new Uint8Array(await blob.arrayBuffer()), width, height };
    bmp.close?.();
    return out;
  } finally {
    if (!reused) stopTracks(stream);
  }
}

// ---------- Ordenes ----------

// Empezar y parar de a uno, en el orden en que llegan: dos arranques seguidos no pueden dejar una captura huerfana
let lane = Promise.resolve();
function serial(fn) {
  const run = lane.then(fn, fn);
  lane = run.catch(() => {});
  return run;
}

const HANDLERS = {
  start: (cmd) => serial(() => start(cmd)),
  // Solo la sesion pedida: si el proceso principal ya arranco otra (parar y volver a empezar seguidos), esa sigue
  stop: (cmd) => serial(() => (!cmd.session || current?.session === cmd.session ? stop() : Promise.resolve()).then(() => true)),
  flush: () => flush(),
  thumb: (cmd) => thumb(cmd.width),
  grab: (cmd) => grab(cmd),
};

bridge?.onCommand(async (cmd) => {
  const fn = cmd && HANDLERS[cmd.type];
  if (!fn) return;
  try {
    reply(cmd.id, await fn(cmd));
  } catch (err) {
    replyError(cmd.id, err);
  }
});

send({ type: 'ready' });
