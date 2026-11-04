'use strict';
// Unir WebM sin recodificar (para el Montaje de la semana) y armar un WebM con cuadros ya codificados (timelapse y
// montaje recodificado), con capture/webm.js. Sin Electron: se prueba con node:test.
//   probeFile(ruta) -> { ok, codec, width, height, audio, duration, ... }: lo que hace falta para decidir
//   planJoin(probes) -> { mode: 'copy' | 'encode', width, height, codec, template, reason }
//   readFrames(ruta) -> iterador asincrono: lee el archivo de a pedazos y devuelve los cuadros (nunca entero en memoria)
//   segmentFrames(ruta, { start, length }) -> los cuadros del tramo, desde el cuadro clave anterior a start
//   copySegment(rec, seg, ...) -> escribe el tramo con los tiempos corridos y las pistas del archivo final
//   encodedHeader() / encodedFrame(): encabezado y cuadros para lo que sale de un VideoEncoder
const fsp = require('fs/promises');
const webm = require('../capture/webm');

const { ID, element, uintEl } = webm;
const READ_SIZE = 1024 * 1024;
const PROBE_LIMIT = 8 * 1024 * 1024; // el encabezado de un WebM entra de sobra aca
const FRAME_MS = 33; // duracion estimada del ultimo cuadro de un tramo
const TIME_SCALE = 1000000; // MediaRecorder y este escritor usan 1 ms
const COPY_CODECS = new Set(['V_VP8', 'V_VP9']);
const MAX_SIZE = { width: 1920, height: 1080 }; // tope al recodificar

// ---------- Encabezado ----------

function textEl(id, s) {
  return element(id, Buffer.from(s, 'latin1'));
}

function floatOf(buf, c) {
  const n = c.end - c.start;
  if (n === 4) return buf.readFloatBE(c.start);
  if (n === 8) return buf.readDoubleBE(c.start);
  return 0;
}

// Lo que importa de cada pista, ademas de lo que da describeHeader: canales, frecuencia y datos privados del codec
function trackDetails(tracksEl) {
  const th = webm.readHeader(tracksEl, 0);
  const out = [];
  for (const entry of webm.children(tracksEl, th.head, th.head + th.size)) {
    if (entry.id !== ID.TrackEntry) continue;
    const tr = { number: 0, type: 0, codec: '', width: 0, height: 0, rate: 0, channels: 0, priv: '', raw: tracksEl.subarray(entry.from, entry.end) };
    for (const c of webm.children(tracksEl, entry.start, entry.end)) {
      if (c.id === ID.TrackNumber) tr.number = webm.readUint(tracksEl, c.start, c.end);
      else if (c.id === ID.TrackType) tr.type = webm.readUint(tracksEl, c.start, c.end);
      else if (c.id === ID.CodecID) tr.codec = tracksEl.toString('latin1', c.start, c.end).replace(/\0+$/, '');
      else if (c.id === 0x63a2) tr.priv = tracksEl.toString('hex', c.start, c.end);
      else if (c.id === ID.Video) {
        for (const v of webm.children(tracksEl, c.start, c.end)) {
          if (v.id === ID.PixelWidth) tr.width = webm.readUint(tracksEl, v.start, v.end);
          else if (v.id === ID.PixelHeight) tr.height = webm.readUint(tracksEl, v.start, v.end);
        }
      } else if (c.id === 0xe1) {
        for (const a of webm.children(tracksEl, c.start, c.end)) {
          if (a.id === 0xb5) tr.rate = floatOf(tracksEl, a);
          else if (a.id === 0x9f) tr.channels = webm.readUint(tracksEl, a.start, a.end);
        }
      }
    }
    out.push(tr);
  }
  return out;
}

// La pista de audio de un archivo con otro numero (para armar el encabezado del archivo final)
function audioEntryAs(raw, number) {
  const eh = webm.readHeader(raw, 0);
  const kids = webm.children(raw, eh.head, eh.head + eh.size).map((c) => (c.id === ID.TrackNumber ? uintEl(ID.TrackNumber, number) : raw.subarray(c.from, c.end)));
  return element(ID.TrackEntry, kids);
}

/**
 * Encabezado de un WebM cuyos cuadros salen de un VideoEncoder: video en la pista 1 y, si se pasa, el audio de un clip
 * (audioRaw = su TrackEntry crudo) en la pista 2. Lleva la misma forma que el de WebmReader.
 */
function encodedHeader({ width, height, codec = 'V_VP9', audioRaw = null }) {
  const ebml = element(ID.EBML, [uintEl(0x4286, 1), uintEl(0x42f7, 1), uintEl(0x42f2, 4), uintEl(0x42f3, 8), textEl(0x4282, 'webm'), uintEl(0x4287, 4), uintEl(0x4285, 2)]);
  const info = element(ID.Info, [uintEl(ID.TimecodeScale, TIME_SCALE), textEl(0x4d80, 'Venus Launcher'), textEl(0x5741, 'Venus Launcher')]);
  const video = element(ID.TrackEntry, [uintEl(ID.TrackNumber, 1), uintEl(0x73c5, 1), uintEl(ID.TrackType, 1), textEl(ID.CodecID, codec), element(ID.Video, [uintEl(ID.PixelWidth, width), uintEl(ID.PixelHeight, height)])]);
  const list = [video];
  if (audioRaw) list.push(audioEntryAs(audioRaw, 2));
  const tracks = element(ID.Tracks, list);
  const d = webm.describeHeader(info, tracks);
  return { ebml, info, tracks, timecodeScale: TIME_SCALE, videoTrack: 1, width, height, tracksInfo: d.tracks };
}

// Cuadro listo para RecordingFile a partir de los bytes de un codificador
function encodedFrame(track, time, key, data, video = true) {
  const head = Buffer.alloc(4);
  head[0] = 0x80 | track;
  head[3] = key ? 0x80 : 0;
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const bytes = element(ID.SimpleBlock, [head, payload]);
  return { track, time, key: video ? Boolean(key) : true, video, bytes, tcPos: bytes.length - payload.length - 3 };
}

// ---------- Lectura ----------

async function* readChunks(file, { signal, limit = Infinity } = {}) {
  const fh = await fsp.open(file, 'r');
  try {
    let pos = 0;
    while (pos < limit) {
      if (signal?.aborted) return;
      // Un Buffer nuevo por lectura: los cuadros siguen apuntando a el mientras se escriben
      const buf = Buffer.allocUnsafe(READ_SIZE);
      const { bytesRead } = await fh.read(buf, 0, READ_SIZE, pos);
      if (!bytesRead) return;
      pos += bytesRead;
      yield buf.subarray(0, bytesRead);
    }
  } finally {
    await fh.close().catch(() => {});
  }
}

// Lee el archivo de a pedazos: { header } y despues cuadros, en el orden del archivo
async function* readFrames(file, opts = {}) {
  const reader = new webm.WebmReader();
  for await (const chunk of readChunks(file, opts)) {
    const out = reader.push(chunk);
    if (out.header) yield { header: out.header };
    for (const f of out.frames) yield f;
  }
}

/**
 * Datos de un clip sin leerlo entero. Si el archivo no dice su duracion (no lo guardo Venus), lo recorre.
 * { ok, path, codec, width, height, videoTrack, audio: { number, codec, rate, channels, priv, raw } | null, duration (s), scale, header }
 */
async function probeFile(file, opts = {}) {
  let header = null;
  try {
    const reader = new webm.WebmReader();
    for await (const chunk of readChunks(file, { ...opts, limit: PROBE_LIMIT })) {
      const out = reader.push(chunk);
      if (out.header) {
        header = out.header;
        break;
      }
    }
    if (!header) return { ok: false, path: file, reason: 'noHeader' };
    const details = trackDetails(header.tracks);
    const video = details.find((t) => t.number === header.videoTrack) || null;
    const audio = details.find((t) => t.type === 2) || null;
    if (!video) return { ok: false, path: file, reason: 'noVideo' };
    const info = webm.describeHeader(header.info, header.tracks);
    let duration = info.duration ? (info.duration * info.timecodeScale) / 1e9 : 0;
    if (!duration) duration = await scanDuration(file, opts);
    return {
      ok: true,
      path: file,
      codec: video.codec,
      width: video.width,
      height: video.height,
      videoTrack: video.number,
      videoPriv: video.priv,
      audio: audio ? { number: audio.number, codec: audio.codec, rate: audio.rate, channels: audio.channels, priv: audio.priv, raw: audio.raw } : null,
      duration,
      scale: info.timecodeScale,
      header,
    };
  } catch (err) {
    return { ok: false, path: file, reason: err?.code === 'badWebm' ? 'badWebm' : 'read', message: err?.message };
  }
}

async function scanDuration(file, opts) {
  let first = null;
  let last = 0;
  for await (const f of readFrames(file, opts)) {
    if (f.header) continue;
    if (first === null || f.time < first) first = f.time;
    if (f.time > last) last = f.time;
  }
  return first === null ? 0 : (last - first + FRAME_MS) / 1000;
}

// ---------- Decidir ----------

const sameAudio = (a, b) => a.codec === b.codec && a.channels === b.channels && a.rate === b.rate && a.priv === b.priv;

/**
 * Se puede unir sin recodificar si todos tienen el mismo codec y tamanio de video y el mismo audio (quien no tenga
 * audio queda en silencio en su tramo). Si no, se recodifica el video al tamanio del mas grande (con tope en 1080p).
 * template = el clip cuyo encabezado se usa (el primero con audio).
 */
function planJoin(probes) {
  const list = probes.filter((p) => p && p.ok);
  if (!list.length) return null;
  const first = list[0];
  const audios = list.filter((p) => p.audio);
  const template = audios[0] || first;
  let reason = null;
  if (!COPY_CODECS.has(first.codec)) reason = 'codec';
  else if (list.some((p) => p.codec !== first.codec || p.videoPriv !== first.videoPriv)) reason = 'codec';
  else if (list.some((p) => p.width !== first.width || p.height !== first.height)) reason = 'size';
  else if (audios.some((p) => !sameAudio(p.audio, template.audio))) reason = 'audio';
  else if (list.some((p) => p.scale !== TIME_SCALE)) reason = 'scale';
  else if (list.some((p) => p.videoTrack > 126 || (p.audio && p.audio.number > 126))) reason = 'tracks';
  if (!reason) return { mode: 'copy', width: first.width, height: first.height, codec: first.codec, template, reason: null };
  return { mode: 'encode', ...encodeSize(list), codec: 'V_VP9', template, reason };
}

// Tamanio al recodificar: el del clip mas grande, sin pasarse de 1080p y con lados pares
function encodeSize(list) {
  let w = 2;
  let h = 2;
  for (const p of list) {
    if ((p.width || 0) * (p.height || 0) > w * h) {
      w = p.width;
      h = p.height;
    }
  }
  const k = Math.min(1, MAX_SIZE.width / w, MAX_SIZE.height / h);
  const even = (n) => Math.max(2, Math.floor(n / 2) * 2);
  return { width: even(w * k), height: even(h * k) };
}

// ---------- Tramos ----------

/**
 * Cuadros del tramo [start, start + length) de un archivo: empieza en el ultimo cuadro clave de video que no se pase
 * de start (o el primero que haya) y corta length despues de ese cuadro. Cada cuadro sale con time relativo al tramo.
 * start y length en segundos; length null = hasta el final.
 */
async function* segmentFrames(file, { start = 0, length = null, signal } = {}) {
  const startMs = Math.max(0, Number(start) || 0) * 1000;
  let origin = null; // tiempo del primer cuadro del archivo (un flujo sin rearmar puede no empezar en cero)
  let candidate = null; // ultimo cuadro clave que no se pasa de start
  let pending = []; // lo que vino desde ese cuadro clave
  let base = null;
  let stopAt = Infinity;
  const inside = (f) => (f.video || f.time >= base) && f.time < stopAt;
  const emit = (f) => ({ ...f, time: f.time - base });
  const open = () => {
    base = candidate;
    stopAt = length === null || length === undefined ? Infinity : base + length * 1000;
    const out = pending.filter(inside).map(emit);
    pending = [];
    return out;
  };
  for await (const f of readFrames(file, { signal })) {
    if (f.header) continue;
    if (origin === null) origin = f.time;
    if (base === null) {
      const rel = f.time - origin;
      if (f.video && f.key && rel <= startMs) {
        candidate = f.time;
        pending = [f];
        continue;
      }
      if (candidate === null) {
        if (!(f.video && f.key)) continue; // hasta el primer cuadro clave no se puede empezar
        candidate = f.time;
      }
      pending.push(f);
      if (rel < startMs) continue;
      yield* open();
      continue;
    }
    if (f.time >= stopAt) {
      if (f.video) return; // pasado el final: lo que queda del archivo no hace falta
      continue;
    }
    if (inside(f)) yield emit(f);
  }
  // Se termino el archivo sin pasar de start (un clip corto)
  if (base === null && candidate !== null) yield* open();
}

// Copia del cuadro con otro numero de pista (todas las pistas de estos archivos entran en un byte)
function withTrack(frame, track) {
  if (frame.track === track) return frame;
  const at = frame.tcPos - 1;
  if (frame.bytes[at] !== (0x80 | frame.track)) throw Object.assign(new Error('webm: track'), { code: 'badWebm' });
  const bytes = Buffer.from(frame.bytes);
  bytes[at] = 0x80 | track;
  return { ...frame, track, bytes };
}

/**
 * Escribe un tramo en rec (RecordingFile) con los tiempos corridos: el primer cuadro queda en offset (ms). Las pistas
 * se pasan a las del archivo final (tracks = { video, audio }). Devuelve donde termina el tramo (ms).
 */
async function copySegment(rec, seg, { offset = 0, tracks, signal, onProgress } = {}) {
  let last = offset;
  let n = 0;
  for await (const f of segmentFrames(seg.path, { start: seg.start, length: seg.length, signal })) {
    if (signal?.aborted) return last;
    const dest = f.video ? tracks.video : tracks.audio;
    if (!dest) continue; // el archivo final no tiene esa pista
    const out = withTrack(f, dest);
    const time = offset + f.time;
    rec.add({ ...out, time });
    if (time > last) last = time;
    onProgress?.(f.time / 1000);
    if (++n % 256 === 0) {
      await rec.drain(); // no juntar el clip entero en memoria
      if (rec.error) throw rec.error;
    }
  }
  await rec.drain();
  if (rec.error) throw rec.error;
  return last + FRAME_MS;
}

// Pistas del archivo final segun el clip que se usa de encabezado
function tracksOf(template) {
  return { video: template.videoTrack, audio: template.audio ? template.audio.number : 0 };
}

/**
 * Lo que hay adentro de un cuadro (sin la cabecera del bloque): para pasarselo a un VideoDecoder.
 * Sirve para SimpleBlock y para BlockGroup. Estos archivos no usan lacing.
 */
function framePayload(frame) {
  const h = webm.readHeader(frame.bytes, 0);
  if (h.id === ID.SimpleBlock) return frame.bytes.subarray(frame.tcPos + 3);
  for (const c of webm.children(frame.bytes, h.head, h.head + h.size)) {
    if (c.id === ID.Block) return frame.bytes.subarray(frame.tcPos + 3, c.end);
  }
  throw Object.assign(new Error('webm: block'), { code: 'badWebm' });
}

module.exports = { FRAME_MS, TIME_SCALE, MAX_SIZE, trackDetails, encodedHeader, encodedFrame, readFrames, probeFile, planJoin, encodeSize, segmentFrames, withTrack, copySegment, tracksOf, framePayload };
