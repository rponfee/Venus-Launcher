'use strict';
// WebM (Matroska) minimo para clips y grabaciones, sin dependencias ni Electron.
// MediaRecorder escribe un WebM "en vivo": Segment y Clusters de tamanio desconocido, sin duracion ni indice (Cues),
// asi que no se puede cortar un pedazo cualquiera (sin el encabezado no se reproduce) ni adelantar el video. Aca:
//   - WebmReader lee ese flujo de a pedazos y devuelve el encabezado (EBML, Info y Tracks crudos) y cada cuadro
//     (SimpleBlock o BlockGroup) con su pista, su tiempo absoluto y si es un cuadro clave.
//   - Muxer arma Clusters nuevos (uno por cada cuadro clave de video) con los tiempos corridos para empezar en cero.
//   - buildHead arma el encabezado final: Segment con tamanio, SeekHead, Info con la duracion, Tracks y Cues (un
//     indice por cuadro clave para poder adelantar). Con `reserve` ocupa siempre lo mismo (relleno Void), asi una
//     grabacion larga se escribe directo en el archivo final y al terminar solo se reescribe el principio.
// Los tiempos van en unidades de TimecodeScale (MediaRecorder usa 1 ms).

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  ReferenceBlock: 0xfb,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
  Void: 0xec,
};

const UNKNOWN_SIZE = Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
const MAX_REL = 32767; // los tiempos de cada cuadro son relativos al Cluster en un int16
const MAX_CLUSTER_SPAN = 30000; // sin cuadros clave, cortar el Cluster igual antes de pasarse del int16
const MAX_ELEMENT = 256 * 1024 * 1024; // un cuadro o un encabezado de mas de esto es un archivo roto

function bad(msg) {
  const err = new Error(`webm: ${msg}`);
  err.code = 'badWebm';
  return err;
}

// ---------- Lectura de numeros EBML ----------

// ID de elemento (1 a 4 bytes, con los bits de largo incluidos). null = faltan bytes.
function readId(buf, pos) {
  if (pos >= buf.length) return null;
  const b = buf[pos];
  const len = b & 0x80 ? 1 : b & 0x40 ? 2 : b & 0x20 ? 3 : b & 0x10 ? 4 : 0;
  if (!len) throw bad('id');
  if (pos + len > buf.length) return null;
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + buf[pos + i];
  return { id, len };
}

// Entero de largo variable (tamanio o numero de pista). size -1 = desconocido. null = faltan bytes.
function readVint(buf, pos) {
  if (pos >= buf.length) return null;
  const b = buf[pos];
  let len = 1;
  let mask = 0x80;
  while (len <= 8 && !(b & mask)) {
    len++;
    mask >>= 1;
  }
  if (len > 8) throw bad('vint');
  if (pos + len > buf.length) return null;
  let value = b & (mask - 1);
  let allOnes = value === mask - 1;
  for (let i = 1; i < len; i++) {
    const x = buf[pos + i];
    value = value * 256 + x;
    if (x !== 0xff) allOnes = false;
  }
  return { value: allOnes ? -1 : value, len };
}

// Cabecera de un elemento: { id, size, head } (head = bytes de ID + tamanio). null = faltan bytes.
function readHeader(buf, pos) {
  const id = readId(buf, pos);
  if (!id) return null;
  const size = readVint(buf, pos + id.len);
  if (!size) return null;
  return { id: id.id, size: size.value, head: id.len + size.len };
}

function readUint(buf, start, end) {
  let v = 0;
  for (let i = start; i < end; i++) v = v * 256 + buf[i];
  return v;
}

function readFloat(buf, start, end) {
  if (end - start === 4) return buf.readFloatBE(start);
  if (end - start === 8) return buf.readDoubleBE(start);
  return 0;
}

// Hijos de un elemento maestro de tamanio conocido: [{ id, start, end, from }] (start/end = datos, from = inicio)
function children(buf, start = 0, end = buf.length) {
  const out = [];
  let pos = start;
  while (pos < end) {
    const h = readHeader(buf, pos);
    if (!h || h.size < 0 || pos + h.head + h.size > end) throw bad('child');
    out.push({ id: h.id, start: pos + h.head, end: pos + h.head + h.size, from: pos });
    pos += h.head + h.size;
  }
  return out;
}

// ---------- Escritura ----------

function idBytes(id) {
  const out = [];
  let v = id;
  while (v > 0) {
    out.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return Buffer.from(out);
}

// Tamanio EBML (con el bit de largo). Sin len, el mas corto posible.
function sizeBytes(n, len) {
  let l = len;
  if (l === undefined) {
    l = 1;
    while (l < 8 && n > 2 ** (7 * l) - 2) l++;
  }
  if (n > 2 ** (7 * l) - 2) throw bad('size');
  const out = Buffer.alloc(l);
  let v = n;
  for (let i = l - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  out[0] |= 0x80 >> (l - 1);
  return out;
}

function uintBytes(n, len) {
  let l = len;
  if (l === undefined) {
    l = 1;
    while (l < 8 && n >= 2 ** (8 * l)) l++;
  }
  const out = Buffer.alloc(l);
  let v = Math.max(0, Math.floor(n));
  for (let i = l - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  return out;
}

function element(id, payload) {
  const body = Array.isArray(payload) ? Buffer.concat(payload) : payload;
  return Buffer.concat([idBytes(id), sizeBytes(body.length), body]);
}

const uintEl = (id, n, len) => element(id, uintBytes(n, len));

function floatEl(id, x) {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(x);
  return element(id, b);
}

// Relleno Void de exactamente n bytes (n >= 2)
function voidEl(n) {
  if (n < 2) throw bad('void');
  if (n - 2 <= 126) return Buffer.concat([idBytes(ID.Void), sizeBytes(n - 2, 1), Buffer.alloc(n - 2)]);
  return Buffer.concat([idBytes(ID.Void), sizeBytes(n - 9, 8), Buffer.alloc(n - 9)]);
}

// ---------- Encabezado ----------

// Datos de Info y Tracks: escala de tiempo, duracion y pistas (numero, tipo, codec, tamanio del video)
function describeHeader(infoEl, tracksEl) {
  let timecodeScale = 1000000;
  let duration = null;
  const ih = readHeader(infoEl, 0);
  for (const c of children(infoEl, ih.head, ih.head + ih.size)) {
    if (c.id === ID.TimecodeScale) timecodeScale = readUint(infoEl, c.start, c.end) || 1000000;
    else if (c.id === ID.Duration) duration = readFloat(infoEl, c.start, c.end);
  }
  const tracks = [];
  const th = readHeader(tracksEl, 0);
  for (const entry of children(tracksEl, th.head, th.head + th.size)) {
    if (entry.id !== ID.TrackEntry) continue;
    const tr = { number: 0, type: 0, codec: '', width: 0, height: 0 };
    for (const c of children(tracksEl, entry.start, entry.end)) {
      if (c.id === ID.TrackNumber) tr.number = readUint(tracksEl, c.start, c.end);
      else if (c.id === ID.TrackType) tr.type = readUint(tracksEl, c.start, c.end);
      else if (c.id === ID.CodecID) tr.codec = tracksEl.toString('latin1', c.start, c.end).replace(/\0+$/, '');
      else if (c.id === ID.Video) {
        for (const v of children(tracksEl, c.start, c.end)) {
          if (v.id === ID.PixelWidth) tr.width = readUint(tracksEl, v.start, v.end);
          else if (v.id === ID.PixelHeight) tr.height = readUint(tracksEl, v.start, v.end);
        }
      }
    }
    tracks.push(tr);
  }
  const video = tracks.find((t) => t.type === 1) || null;
  return { timecodeScale, duration, tracks, videoTrack: video ? video.number : 0, width: video?.width || 0, height: video?.height || 0 };
}

// Info con la duracion (en unidades de TimecodeScale) en lugar de la que tenia. duration null = sin duracion.
function infoWithDuration(infoEl, duration) {
  const ih = readHeader(infoEl, 0);
  const keep = children(infoEl, ih.head, ih.head + ih.size)
    .filter((c) => c.id !== ID.Duration && c.id !== ID.Void)
    .map((c) => infoEl.subarray(c.from, c.end));
  if (duration !== null && duration !== undefined) keep.push(floatEl(ID.Duration, Math.max(0, duration)));
  return element(ID.Info, keep);
}

function cuesEl(cues, track) {
  return element(
    ID.Cues,
    cues.map((c) => element(ID.CuePoint, [uintEl(ID.CueTime, c.time, 8), element(ID.CueTrackPositions, [uintEl(ID.CueTrack, track), uintEl(ID.CueClusterPosition, c.pos, 8)])])),
  );
}

function seekHeadEl(entries) {
  return element(
    ID.SeekHead,
    entries.map(([id, pos]) => element(ID.Seek, [element(ID.SeekID, idBytes(id)), uintEl(ID.SeekPosition, pos, 8)])),
  );
}

// Deja como mucho `max` puntos del indice repartidos parejo (si no entran en el lugar reservado)
function thinCues(cues, max) {
  if (cues.length <= max) return cues;
  if (max <= 0) return [];
  const out = [];
  const step = cues.length / max;
  for (let i = 0; i < max; i++) out.push(cues[Math.floor(i * step)]);
  return out;
}

const CUE_POINT_BYTES = 27; // CuePoint con CueTime y CueClusterPosition de 8 bytes y pista < 256

/**
 * Encabezado del archivo: EBML + Segment + SeekHead + Info (con duracion) + Tracks + Cues (+ relleno).
 * header = { ebml, info, tracks, videoTrack } (de WebmReader). cues = [{ time, offset }] (offset desde el primer
 * Cluster). clusterBytes = bytes de todos los Clusters (null = tamanio desconocido, para una grabacion en curso).
 * reserve = bytes fijos que ocupa todo lo que va dentro del Segment antes del primer Cluster (0 = lo justo).
 */
function buildHead({ header, cues = [], duration = null, clusterBytes = null, reserve = 0 }) {
  const info = infoWithDuration(header.info, duration);
  const tracks = header.tracks;
  const track = header.videoTrack || 1;
  let list = cues.filter((c) => Number.isFinite(c.time) && Number.isFinite(c.offset));
  const seekLen = (n) => seekHeadEl(Array.from({ length: n }, () => [ID.Info, 0])).length;
  const fixedWith = (hasCues) => seekLen(hasCues ? 3 : 2) + info.length + tracks.length;
  if (reserve) {
    // Lo que entra del indice en el lugar reservado (dejando lugar para el relleno)
    const room = reserve - fixedWith(true) - 16 - 9;
    list = thinCues(list, Math.max(0, Math.floor(room / CUE_POINT_BYTES)));
    if (fixedWith(false) + 9 > reserve) throw bad('reserve');
  }
  const hasCues = list.length > 0;
  const fixed = fixedWith(hasCues);
  const cuesLen = hasCues ? cuesEl(list.map((c) => ({ time: c.time, pos: 0 })), track).length : 0;
  const headLen = reserve || fixed + cuesLen;
  const seekLenNow = seekLen(hasCues ? 3 : 2);
  const entries = [
    [ID.Info, seekLenNow],
    [ID.Tracks, seekLenNow + info.length],
  ];
  if (hasCues) entries.push([ID.Cues, seekLenNow + info.length + tracks.length]);
  const parts = [seekHeadEl(entries), info, tracks];
  if (hasCues) parts.push(cuesEl(list.map((c) => ({ time: c.time, pos: headLen + c.offset })), track));
  if (reserve) parts.push(voidEl(reserve - fixed - cuesLen));
  const segSize = clusterBytes === null || clusterBytes === undefined ? UNKNOWN_SIZE : sizeBytes(headLen + clusterBytes, 8);
  const out = Buffer.concat([header.ebml, idBytes(ID.Segment), segSize, ...parts]);
  return { data: out, headLen, cues: list.length };
}

// ---------- Lector incremental ----------

const LEVEL1 = new Set([ID.SeekHead, ID.Info, ID.Tracks, ID.Cluster, ID.Cues, 0x1254c367 /* Tags */, 0x1941a469 /* Attachments */, 0x1043a770 /* Chapters */]);

/**
 * Lee el WebM de MediaRecorder de a pedazos. push(chunk) -> { header?, frames }:
 *   header (una sola vez) = { ebml, info, tracks (Buffers crudos), timecodeScale, videoTrack, width, height, tracksInfo }
 *   frames = [{ track, time, key, video, bytes, tcPos }] (bytes = elemento entero; tcPos = donde esta su int16)
 */
class WebmReader {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.pos = 0;
    this.state = 'ebml';
    this.skip = 0;
    this.ebml = null;
    this.info = null;
    this.tracks = null;
    this.header = null;
    this.clusterTime = 0;
    this.inCluster = false;
  }

  push(chunk) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength) : chunk);
    const rest = this.buf.subarray(this.pos);
    this.buf = rest.length ? Buffer.concat([rest, data]) : data;
    this.pos = 0;
    const out = { header: null, frames: [] };
    if (this.skip) {
      const n = Math.min(this.skip, this.buf.length);
      this.skip -= n;
      this.pos = n;
    }
    while (this.step(out));
    return out;
  }

  // Un paso del lector: true si avanzo y puede seguir
  step(out) {
    const buf = this.buf;
    const h = readHeader(buf, this.pos);
    if (!h) return false;
    const full = h.size >= 0 ? this.pos + h.head + h.size : -1;
    // El Segment y los Cluster no se juntan enteros en memoria (sus hijos se leen de a uno): un clip largo los pasa
    if (h.size > MAX_ELEMENT && h.id !== ID.Segment && h.id !== ID.Cluster) throw bad('too large');
    const have = full >= 0 && full <= buf.length;
    if (this.state === 'ebml') {
      if (h.id !== ID.EBML || h.size < 0) throw bad('not webm');
      if (!have) return false;
      this.ebml = Buffer.from(buf.subarray(this.pos, full));
      this.pos = full;
      this.state = 'segment';
      return true;
    }
    if (this.state === 'segment') {
      if (h.id !== ID.Segment) throw bad('no segment');
      this.pos += h.head;
      this.state = 'top';
      return true;
    }
    if (this.state === 'top') {
      if (h.id === ID.Cluster) {
        if (!this.info || !this.tracks) throw bad('no tracks');
        const d = describeHeader(this.info, this.tracks);
        this.header = { ebml: this.ebml, info: this.info, tracks: this.tracks, timecodeScale: d.timecodeScale, videoTrack: d.videoTrack, width: d.width, height: d.height, tracksInfo: d.tracks };
        out.header = this.header;
        this.state = 'body';
        return true;
      }
      if (h.size < 0) throw bad('unknown size');
      if (h.id === ID.Info || h.id === ID.Tracks) {
        if (!have) return false;
        const raw = Buffer.from(buf.subarray(this.pos, full));
        if (h.id === ID.Info) this.info = raw;
        else this.tracks = raw;
        this.pos = full;
        return true;
      }
      return this.skipElement(h);
    }
    // Cuerpo: Clusters y sus hijos
    if (h.id === ID.Cluster) {
      this.pos += h.head; // los hijos se leen uno por uno (el tamanio suele ser desconocido)
      this.inCluster = true;
      this.clusterTime = 0;
      return true;
    }
    if (h.size < 0) throw bad('unknown size');
    if (h.id === ID.Timecode) {
      if (!have) return false;
      this.clusterTime = readUint(buf, this.pos + h.head, full);
      this.pos = full;
      return true;
    }
    if (h.id === ID.SimpleBlock || h.id === ID.BlockGroup) {
      if (!have) return false;
      const frame = this.frameOf(buf, this.pos, h, full);
      if (frame) out.frames.push(frame);
      this.pos = full;
      return true;
    }
    if (LEVEL1.has(h.id)) this.inCluster = false;
    return this.skipElement(h);
  }

  skipElement(h) {
    const total = h.head + h.size;
    if (this.pos + total <= this.buf.length) this.pos += total;
    else {
      this.skip = this.pos + total - this.buf.length;
      this.pos = this.buf.length;
    }
    return true;
  }

  frameOf(buf, from, h, end) {
    let blockStart = from + h.head;
    let blockEnd = end;
    let key = false;
    if (h.id === ID.BlockGroup) {
      let block = null;
      let ref = false;
      for (const c of children(buf, from + h.head, end)) {
        if (c.id === ID.Block) block = c;
        else if (c.id === ID.ReferenceBlock) ref = true;
      }
      if (!block) return null;
      blockStart = block.start;
      blockEnd = block.end;
      key = !ref;
    }
    const tr = readVint(buf, blockStart);
    if (!tr || blockStart + tr.len + 3 > blockEnd) throw bad('block');
    const tcAt = blockStart + tr.len;
    const rel = buf.readInt16BE(tcAt);
    if (h.id === ID.SimpleBlock) key = (buf[tcAt + 2] & 0x80) !== 0;
    const video = tr.value === this.header?.videoTrack;
    return { track: tr.value, time: this.clusterTime + rel, key: video ? key : true, video, bytes: buf.subarray(from, end), tcPos: tcAt - from };
  }
}

// ---------- Armado de Clusters ----------

/**
 * Arma Clusters con tiempos corridos (`base` = tiempo del primer cuadro). add(frame) devuelve los Clusters que
 * quedaron cerrados: [{ time, key, bytes }] (key = empieza con un cuadro clave de video, va al indice).
 */
class Muxer {
  constructor({ base = 0 } = {}) {
    this.base = base;
    this.frames = [];
    this.start = 0;
    this.bytes = 0;
    this.last = 0; // ultimo tiempo (ya corrido)
  }

  add(frame) {
    const time = frame.time - this.base;
    const out = [];
    if (this.frames.length) {
      const rel = time - this.start;
      if ((frame.video && frame.key) || rel > MAX_CLUSTER_SPAN || rel < -MAX_REL || this.bytes > 32 * 1024 * 1024) out.push(this.close());
    }
    if (!this.frames.length) this.start = Math.max(0, time);
    this.frames.push({ frame, time });
    this.bytes += frame.bytes.length;
    if (time > this.last) this.last = time;
    return out;
  }

  close() {
    const list = this.frames;
    this.frames = [];
    this.bytes = 0;
    const parts = [uintEl(ID.Timecode, this.start)];
    for (const { frame, time } of list) {
      const copy = Buffer.from(frame.bytes);
      copy.writeInt16BE(Math.max(-MAX_REL - 1, Math.min(MAX_REL, time - this.start)), frame.tcPos);
      parts.push(copy);
    }
    const first = list[0]?.frame;
    return { time: this.start, key: Boolean(first?.video && first.key), bytes: element(ID.Cluster, parts) };
  }

  flush() {
    return this.frames.length ? this.close() : null;
  }
}

/**
 * Elige desde que cuadro empezar: el primer cuadro clave de video desde `from` (tiempo absoluto). Devuelve los
 * cuadros a escribir (sin el audio de antes de ese cuadro clave) o [] si no hay ningun cuadro clave.
 */
function fromKeyframe(frames, from = -Infinity) {
  let k = frames.findIndex((f) => f.video && f.key && f.time >= from);
  if (k < 0) return [];
  const base = frames[k].time;
  return frames.slice(k).filter((f) => f.video || f.time >= base);
}

/**
 * Archivo completo en memoria a partir de cuadros (ya ordenados y empezando en un cuadro clave).
 * frameDur = duracion estimada del ultimo cuadro. Devuelve { parts: [Buffer], bytes, duration }.
 */
function buildFile(header, frames, { frameDur = 0 } = {}) {
  if (!frames.length) throw bad('empty');
  const mux = new Muxer({ base: frames[0].time });
  const clusters = [];
  for (const f of frames) clusters.push(...mux.add(f));
  const tail = mux.flush();
  if (tail) clusters.push(tail);
  let offset = 0;
  const cues = [];
  for (const c of clusters) {
    if (c.key) cues.push({ time: c.time, offset });
    offset += c.bytes.length;
  }
  const duration = mux.last + frameDur;
  const head = buildHead({ header, cues, duration, clusterBytes: offset });
  const parts = [head.data, ...clusters.map((c) => c.bytes)];
  return { parts, bytes: head.data.length + offset, duration };
}

// Lee un WebM entero (por ejemplo lo que exporta el editor) y lo rearma con duracion e indice.
function remux(buffer, opts = {}) {
  const reader = new WebmReader();
  const { header, frames } = reader.push(buffer);
  const head = header || reader.header;
  if (!head) throw bad('no header');
  const list = fromKeyframe(frames);
  if (!list.length) throw bad('no keyframe');
  return { ...buildFile(head, list, opts), header: head };
}

module.exports = {
  ID,
  UNKNOWN_SIZE,
  readId,
  readVint,
  readHeader,
  readUint,
  children,
  idBytes,
  sizeBytes,
  uintBytes,
  element,
  uintEl,
  floatEl,
  voidEl,
  describeHeader,
  infoWithDuration,
  buildHead,
  thinCues,
  WebmReader,
  Muxer,
  fromKeyframe,
  buildFile,
  remux,
};
