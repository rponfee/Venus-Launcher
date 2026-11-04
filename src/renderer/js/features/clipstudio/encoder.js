// Codificar con WebCodecs para el Montaje y el Timelapse. Corre en la ventana del launcher (los codificadores trabajan
// fuera del hilo de la interfaz) y manda los cuadros al proceso principal, que arma el WebM (modules/clipstudio/job.js).
import { api } from '../../store.js';
import { fitBox, videoBitrate, frameTimestamp, TITLE_SECONDS } from './logic.js';

const MAX_QUEUE = 6;
const BATCH_FRAMES = 24;
const BATCH_BYTES = 4 * 1024 * 1024;
const WEBCODECS = { V_VP9: 'vp09.00.41.08', V_VP8: 'vp8' };
// MediaRecorder no guarda el espacio de color en el WebM y un <video> lo muestra como BT.601: sin esto, VideoDecoder lo toma
// como BT.709 y un clip recodificado sale con los colores corridos (comprobado con clips de prueba de colores puros)
const SOURCE_COLOR = { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'smpte170m', fullRange: false };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export const canEncode = () => typeof VideoEncoder === 'function' && typeof VideoFrame === 'function';

function encoderConfig(track, width, height, fps) {
  return { codec: WEBCODECS[track], width, height, framerate: fps, bitrate: videoBitrate(width, height, fps), latencyMode: 'realtime', alpha: 'discard' };
}

// El mejor codec que este equipo codifica a ese tamanio: 'V_VP9', 'V_VP8' o null
export async function pickCodec(width, height, fps = 30, wanted = ['V_VP9', 'V_VP8']) {
  if (!canEncode()) return null;
  for (const track of wanted) {
    try {
      const res = await VideoEncoder.isConfigSupported(encoderConfig(track, width, height, fps));
      if (res?.supported) return track;
    } catch {
      /* se prueba el siguiente */
    }
  }
  return null;
}

/**
 * Codifica cuadros y los manda a un trabajo del proceso principal, de a tandas y en orden. Si el codificador o el envio
 * fallan, encode() y flush() lanzan el error.
 */
export class FrameEncoder {
  constructor({ jobId, track, width, height, fps }) {
    this.jobId = jobId;
    this.track = track;
    this.width = width;
    this.height = height;
    this.fps = fps;
    this.batch = [];
    this.batchBytes = 0;
    this.sending = Promise.resolve();
    this.backlog = 0;
    this.error = null;
    this.encoder = new VideoEncoder({
      output: (chunk) => this.onChunk(chunk),
      error: (err) => {
        this.error = this.error || err;
      },
    });
    this.encoder.configure(encoderConfig(track, width, height, fps));
    this.lastKey = -Infinity;
  }

  onChunk(chunk) {
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    this.batch.push({ time: chunk.timestamp / 1000, key: chunk.type === 'key', data });
    this.batchBytes += data.byteLength;
    if (this.batch.length >= BATCH_FRAMES || this.batchBytes >= BATCH_BYTES) this.send();
  }

  send() {
    if (!this.batch.length) return this.sending;
    const list = this.batch;
    const size = this.batchBytes;
    this.batch = [];
    this.batchBytes = 0;
    this.backlog += size;
    this.sending = this.sending.then(async () => {
      try {
        if (!this.error) await api.invoke('clipstudio:frames', this.jobId, list);
      } catch (err) {
        this.error = this.error || err;
      } finally {
        this.backlog -= size;
      }
    });
    return this.sending;
  }

  check() {
    if (this.error) throw this.error;
  }

  // Espera lugar: ni el codificador ni el envio juntan el video entero en memoria
  async room() {
    while (this.encoder.encodeQueueSize > MAX_QUEUE || this.backlog > BATCH_BYTES * 4) {
      this.check();
      await wait(4);
    }
    this.check();
  }

  // frame = VideoFrame (lo cierra quien lo creo). Un cuadro clave cada keyMs (y el primero, siempre).
  async encode(frame, keyMs = 2000) {
    await this.room();
    const at = frame.timestamp / 1000;
    const key = at - this.lastKey >= keyMs;
    if (key) this.lastKey = at;
    this.encoder.encode(frame, { keyFrame: key });
  }

  async flush() {
    await this.encoder.flush();
    this.send();
    await this.sending;
    this.check();
  }

  close() {
    try {
      if (this.encoder.state !== 'closed') this.encoder.close();
    } catch {
      /* ya estaba cerrado */
    }
  }
}

// ---------- Placa de titulo ----------

function wrapLines(ctx, text, maxWidth) {
  const out = [];
  let line = '';
  for (const word of String(text).split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > maxWidth) {
      out.push(line);
      line = word;
    } else line = next;
  }
  if (line) out.push(line);
  return out.slice(0, 3);
}

/** Dibuja la placa: titulo y linea de abajo sobre un fondo oscuro. alpha = fundido de entrada (0 a 1). */
export function drawTitleCard(ctx, W, H, { title, subtitle, alpha = 1 }) {
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#0d0a18');
  bg.addColorStop(1, '#2b1a4d');
  ctx.globalAlpha = 1;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const size = Math.round(Math.min(H * 0.09, W * 0.06));
  ctx.font = `700 ${size}px "Segoe UI", system-ui, sans-serif`;
  const lines = wrapLines(ctx, title, W * 0.82);
  const lead = size * 1.2;
  let y = H / 2 - ((lines.length - 1) * lead) / 2 - (subtitle ? size * 0.4 : 0);
  for (const l of lines) {
    ctx.fillText(l, W / 2, y, W * 0.9);
    y += lead;
  }
  if (subtitle) {
    ctx.font = `500 ${Math.round(size * 0.45)}px "Segoe UI", system-ui, sans-serif`;
    ctx.fillStyle = '#c9bfe6';
    ctx.fillText(subtitle, W / 2, y + size * 0.1, W * 0.9);
  }
  ctx.globalAlpha = 1;
}

// Codifica la placa desde el tiempo 0: 2,5 s a 30 cuadros por segundo
export async function encodeTitleCard(encoder, { title, subtitle, signal }) {
  const { width: W, height: H } = encoder;
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { alpha: false });
  const fps = 30;
  const frames = Math.round(TITLE_SECONDS * fps);
  for (let i = 0; i < frames; i++) {
    if (signal?.cancelled) return;
    drawTitleCard(ctx, W, H, { title, subtitle, alpha: Math.min(1, i / (fps * 0.4)) });
    const frame = new VideoFrame(canvas, { timestamp: frameTimestamp(i, fps), duration: Math.round(1e6 / fps) });
    try {
      await encoder.encode(frame, 2000);
    } finally {
      frame.close();
    }
  }
}

// ---------- Recodificar un tramo ----------

/**
 * Pide al proceso principal los cuadros de video del tramo i, los decodifica, los dibuja al tamanio de salida y los vuelve
 * a codificar con el mismo tiempo. onTime(ms) con el ultimo tiempo pasado.
 */
export async function transcodeSegment(encoder, jobId, index, { signal, onTime } = {}) {
  const info = await api.invoke('clipstudio:montageSegment', jobId, index);
  const W = encoder.width;
  const H = encoder.height;
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingQuality = 'high';
  let failure = null;
  let pending = Promise.resolve();
  const decoder = new VideoDecoder({
    output: (frame) => {
      // De a uno y en orden: encode() puede esperar lugar
      pending = pending.then(async () => {
        try {
          if (signal?.cancelled || failure) return;
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, W, H);
          const box = fitBox(frame.displayWidth, frame.displayHeight, W, H);
          ctx.drawImage(frame, box.dx, box.dy, box.dw, box.dh);
          const out = new VideoFrame(canvas, { timestamp: frame.timestamp });
          try {
            await encoder.encode(out, 2000);
          } finally {
            out.close();
          }
          onTime?.(frame.timestamp / 1000);
        } catch (err) {
          failure = failure || err;
        } finally {
          frame.close();
        }
      });
    },
    error: (err) => {
      failure = failure || err;
    },
  });
  try {
    decoder.configure({ codec: WEBCODECS[info.codec] || 'vp09.00.41.08', codedWidth: info.width, codedHeight: info.height, colorSpace: SOURCE_COLOR });
    for (;;) {
      if (signal?.cancelled) return;
      if (failure) throw failure;
      const { frames, done } = await api.invoke('clipstudio:montageRead', jobId, 16);
      for (const f of frames) {
        while (decoder.decodeQueueSize > MAX_QUEUE) await wait(4);
        decoder.decode(new EncodedVideoChunk({ type: f.key ? 'key' : 'delta', timestamp: Math.round(f.time * 1000), data: f.data }));
      }
      await pending;
      if (done) break;
    }
    await decoder.flush();
    await pending;
    if (failure) throw failure;
  } finally {
    try {
      if (decoder.state !== 'closed') decoder.close();
    } catch {
      /* ya estaba cerrado */
    }
  }
}
