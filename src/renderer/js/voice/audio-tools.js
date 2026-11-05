// Ayudas de audio en la PC para el soundboard de la sala (voice/ui-board.js): decodificar un archivo
// (AudioContext.decodeAudioData), recortar un tramo y volver a codificarlo con MediaRecorder (audio/webm;codecs=opus, ~96 kbps).
// No se sube nada: el sonido se guarda en la PC. Antes vivian en features/profile-editor/audio.js (la cancion del perfil se
// elige ahora de Openverse y no se sube).
// Los errores llevan err.code: 'type', 'too_big', 'decode', 'unsupported', 'cancelled' (MediaError de media.js).
import { MediaError } from '../features/profile-editor/media.js';

const MIME = 'audio/webm;codecs=opus';
const BITRATE = 96_000;
const SECONDS = 30; // largo por defecto del recorte
const SOURCE_BYTES = 20 * 1024 * 1024; // archivo de origen de hasta 20 MB
const BLOB_BYTES = 1024 * 1024; // lo recodificado de hasta 1 MB
const TYPES = ['audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/webm', 'audio/aac'];
const EXTS = ['mp3', 'ogg', 'oga', 'wav', 'm4a', 'webm', 'aac'];

// Archivo de audio aceptable (por tipo o extension) y de hasta 20 MB. Devuelve null o un codigo de error.
function sourceError(file) {
  if (!file || typeof file !== 'object') return 'type';
  const name = String(file.name || '').toLowerCase();
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  const type = String(file.type || '').toLowerCase().split(';')[0];
  if (!(TYPES.includes(type) || (!type && EXTS.includes(ext)) || (type.startsWith('audio/') && EXTS.includes(ext)))) return 'type';
  if (!(file.size > 0)) return 'decode';
  if (file.size > SOURCE_BYTES) return 'too_big';
  return null;
}

export function audioSupported() {
  return typeof AudioContext === 'function' && typeof MediaRecorder === 'function' && Boolean(MediaRecorder.isTypeSupported?.(MIME));
}

// Archivo elegido -> AudioBuffer completo
export async function decodeAudio(file) {
  const code = sourceError(file);
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
export function clipBuffer(buffer, start = 0, seconds = SECONDS) {
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
      if (blob.size > BLOB_BYTES) return reject(new MediaError('too_big'));
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
