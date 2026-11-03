// Cancion del perfil (3.1): el archivo elegido se decodifica en la PC (AudioContext.decodeAudioData), se recortan
// 30 s desde el punto elegido y se vuelven a codificar con MediaRecorder (audio/webm;codecs=opus, ~96 kbps) en un
// blob de hasta 1 MB que se sube al bucket publico profile-audio (<uid>/song.webm). El original nunca sale de la PC.
// Los errores llevan err.code: 'type', 'too_big', 'decode', 'unsupported', 'cancelled', 'denied', 'unavailable',
// 'network', 'session' (MediaError de media.js).
import { LIMITS, AUDIO_FILE, audioSourceError, audioUrlWithVersion } from './model.js';
import { MediaError, storageError, requireSession } from './media.js';

const BUCKET = 'profile-audio';
const MIME = 'audio/webm;codecs=opus';
const BITRATE = 96_000;

export function audioSupported() {
  return typeof AudioContext === 'function' && typeof MediaRecorder === 'function' && Boolean(MediaRecorder.isTypeSupported?.(MIME));
}

// Archivo elegido -> AudioBuffer completo (para elegir el punto de inicio sin volver a leerlo)
export async function decodeAudio(file) {
  const code = audioSourceError(file);
  if (code) throw new MediaError(code);
  const bytes = await file.arrayBuffer();
  const ctx = new AudioContext();
  try {
    const buffer = await ctx.decodeAudioData(bytes);
    if (!(buffer.duration > 0) || !buffer.numberOfChannels) throw new MediaError('decode');
    return buffer;
  } catch (err) {
    throw err instanceof MediaError ? err : new MediaError('decode');
  } finally {
    ctx.close().catch(() => {});
  }
}

// Recorte: desde start (segundos) hasta 30 s o el final; como mucho dos canales
export function clipBuffer(buffer, start = 0, seconds = LIMITS.songSeconds) {
  const sr = buffer.sampleRate;
  const from = Math.max(0, Math.min(buffer.duration, Number(start) || 0));
  const len = Math.max(1, Math.min(Math.round(seconds * sr), Math.round((buffer.duration - from) * sr)));
  const channels = Math.max(1, Math.min(2, buffer.numberOfChannels));
  const out = new AudioBuffer({ length: len, numberOfChannels: channels, sampleRate: sr });
  const offset = Math.round(from * sr);
  for (let c = 0; c < channels; c++) {
    const data = new Float32Array(len);
    buffer.copyFromChannel(data, Math.min(c, buffer.numberOfChannels - 1), offset);
    out.copyToChannel(data, c);
  }
  return out;
}

// Codifica en tiempo real (MediaRecorder no tiene modo sin conexion, asi que 30 s tardan 30 s): onProgress(0..1)
export function encodeWebm(buffer, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (!audioSupported()) return reject(new MediaError('unsupported'));
    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(dest);
    const rec = new MediaRecorder(dest.stream, { mimeType: MIME, audioBitsPerSecond: BITRATE });
    const chunks = [];
    let timer = 0;
    let done = false;
    const finish = () => {
      clearInterval(timer);
      ctx.close().catch(() => {});
    };
    const fail = (code) => {
      if (done) return;
      done = true;
      finish();
      reject(new MediaError(code));
    };
    rec.ondataavailable = (e) => {
      if (e.data?.size) chunks.push(e.data);
    };
    rec.onerror = () => fail('decode');
    rec.onstop = () => {
      if (done) return;
      done = true;
      finish();
      const blob = new Blob(chunks, { type: 'audio/webm' });
      if (!blob.size) return reject(new MediaError('decode'));
      if (blob.size > LIMITS.songBytes) return reject(new MediaError('too_big'));
      resolve(blob);
    };
    const t0 = performance.now();
    const total = Math.max(1, buffer.duration * 1000);
    timer = setInterval(() => onProgress?.(Math.min(1, (performance.now() - t0) / total)), 200);
    signal?.addEventListener(
      'abort',
      () => {
        try {
          src.stop();
          if (rec.state !== 'inactive') rec.stop();
        } catch {
          /* ya termino */
        }
        fail('cancelled');
      },
      { once: true },
    );
    // Un poco de margen para que el ultimo trozo llegue entero
    src.onended = () => setTimeout(() => rec.state !== 'inactive' && rec.stop(), 200);
    rec.start(1000);
    src.start();
  });
}

// Todo junto: archivo -> blob webm de 30 s desde start
export async function prepareSong(file, { start = 0, onProgress, signal } = {}) {
  const buffer = await decodeAudio(file);
  return { blob: await encodeWebm(clipBuffer(buffer, start), { onProgress, signal }), duration: buffer.duration };
}

// ---------- Bucket profile-audio ----------
export async function uploadSong(blob) {
  const { client, uid } = requireSession();
  if (!blob || blob.size > LIMITS.songBytes) throw new MediaError('too_big');
  const path = `${uid}/${AUDIO_FILE}`;
  const { error } = await client.storage.from(BUCKET).upload(path, blob, { contentType: 'audio/webm', cacheControl: '3600', upsert: true });
  if (error) throw storageError(error);
  const { data } = client.storage.from(BUCKET).getPublicUrl(path);
  if (!data?.publicUrl) throw new MediaError('unavailable');
  return audioUrlWithVersion(data.publicUrl);
}

export async function removeSong() {
  const { client, uid } = requireSession();
  const { error } = await client.storage.from(BUCKET).remove([`${uid}/${AUDIO_FILE}`]);
  if (error) throw storageError(error);
}
