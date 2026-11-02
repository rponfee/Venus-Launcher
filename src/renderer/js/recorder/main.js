// Grabadora oculta de clips y capturas. La abre el proceso principal (modules/capture/host.js) en una ventana que
// nunca se muestra: captura la ventana del juego (la elige el proceso principal en su manejador de
// getDisplayMedia) y graba con MediaRecorder (WebM VP9 o VP8 + Opus) en pedazos de 1 s que manda al proceso
// principal, que arma la repeticion instantanea y las grabaciones. Tambien saca capturas al tamanio real.
const bridge = window.venusRecorder;

const CHUNK_MS = 1000;
let current = null; // { session, stream, recorder, queue, flushWaiters, track }

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

function pickMime(withAudio) {
  const list = withAudio ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'] : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return list.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

function bitrateFor(width, height, fps, b) {
  const pixels = Math.max(1, width || 0) * Math.max(1, height || 0);
  const rate = fps >= 60 ? 45 : 30;
  return Math.round(Math.min(b?.max || 25e6, Math.max(b?.min || 2e6, pixels * rate * (b?.bpp || 0.11))));
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
  const s = track.getSettings();
  const mimeType = pickMime(stream.getAudioTracks().length > 0);
  const width = s.width || cmd.box?.width || 1280;
  const height = s.height || cmd.box?.height || 720;
  const options = { videoBitsPerSecond: bitrateFor(width, height, cmd.fps, cmd.bitrate), audioBitsPerSecond: 128000, videoKeyFrameIntervalDuration: cmd.keyframeMs || 2000 };
  if (mimeType) options.mimeType = mimeType;
  const recorder = new MediaRecorder(stream, options);
  const sess = { session: cmd.session, stream, recorder, track, queue: Promise.resolve(), flushWaiters: [], stopped: false };
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
  recorder.start(CHUNK_MS);
  current = sess;
  return { width, height, mimeType: recorder.mimeType || mimeType, audio: stream.getAudioTracks().length > 0, audioFailed: Boolean(opened.audioFailed), fps: s.frameRate || cmd.fps };
}

// Termina la sesion: espera los ultimos pedazos y avisa
function end(sess, reason) {
  if (sess.stopped) return sess.done;
  sess.stopped = true;
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

// Captura de pantalla al tamanio real de la ventana (PNG)
async function grab(cmd) {
  const { stream } = await openStream({ fps: 30, box: null, audio: false, sourceId: cmd.sourceId });
  try {
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error('no video');
    const bmp = await frameOf(track, stream);
    const blob = await encode(bmp, bmp.width, bmp.height, 'image/png');
    const out = { data: new Uint8Array(await blob.arrayBuffer()), width: bmp.width, height: bmp.height };
    bmp.close?.();
    return out;
  } finally {
    stopTracks(stream);
  }
}

// ---------- Ordenes ----------

const HANDLERS = {
  start: (cmd) => start(cmd),
  stop: () => stop().then(() => true),
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
