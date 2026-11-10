'use strict';
// Buffer circular de la repeticion instantanea EN DISCO: con 30 minutos a 1080p son GB y en memoria le
// quitarian RAM al juego. Los cuadros (de webm.js) se escriben en segmentos rotativos dentro de una carpeta propia
// de la cache del launcher (cache/capture-replay/<id>) y en memoria solo queda un indice chico por segmento.
//
// Cada segmento empieza en un cuadro clave de video y dura unos segundos: descartar lo viejo es borrar archivos
// enteros (nunca se reescribe nada) y siempre queda desde el ultimo cuadro clave anterior al corte, asi lo que se
// guarda se puede reproducir desde el principio. El formato no sale de esta carpeta: una fila de registros
// [cabecera de 16 bytes][elemento de bloque tal como vino en el WebM]. Sin Electron (se prueba con node:test).
//
// La carpeta se borra con dispose() (al cerrar el juego o el launcher) y, por si el launcher se cerro de golpe,
// cleanRoot() borra lo que haya quedado al arrancar.
const fsp = require('fs/promises');
const path = require('path');

const RECORD_HEAD = 16; // tiempo (double), largo (uint32), pista (uint8), banderas (uint8), tcPos (uint16)
const FLAG_KEY = 1;
const FLAG_VIDEO = 2;
const SEGMENT_SECONDS = 10;
const MAX_WRITE = 8 * 1024 * 1024; // de a cuanto se junta lo que esta en fila para escribirlo de una vez
const MAX_QUEUE = 128 * 1024 * 1024; // si el disco no da abasto, en vez de juntar esto en memoria se saltean cuadros
const MAX_BYTES = 2 * 1024 * 1024 * 1024; // tope duro por defecto; capture.js pasa el de lo elegido (logic.ringMaxBytes: hasta 30 minutos a 4K)

function recordHead(frame) {
  const b = Buffer.allocUnsafe(RECORD_HEAD);
  b.writeDoubleLE(frame.time, 0);
  b.writeUInt32LE(frame.bytes.length, 8);
  b.writeUInt8(frame.track & 0xff, 12);
  b.writeUInt8((frame.key ? FLAG_KEY : 0) | (frame.video ? FLAG_VIDEO : 0), 13);
  b.writeUInt16LE(frame.tcPos & 0xffff, 14);
  return b;
}

// Cuadros de lo leido de un segmento (bytes apunta al mismo Buffer). Un registro cortado al final se ignora.
function parseRecords(buf) {
  const out = [];
  let pos = 0;
  while (pos + RECORD_HEAD <= buf.length) {
    const end = pos + RECORD_HEAD + buf.readUInt32LE(pos + 8);
    if (end > buf.length) break;
    const flags = buf[pos + 13];
    out.push({ time: buf.readDoubleLE(pos), track: buf[pos + 12], key: Boolean(flags & FLAG_KEY), video: Boolean(flags & FLAG_VIDEO), tcPos: buf.readUInt16LE(pos + 14), bytes: buf.subarray(pos + RECORD_HEAD, end) });
    pos = end;
  }
  return out;
}

/**
 * Lo que se va a guardar: los segmentos quedan retenidos (la rotacion no los borra) hasta release().
 * batches() entrega los cuadros de a un segmento por vez, para no tener el clip entero en memoria.
 */
class ReplaySnapshot {
  constructor(ring, parts, start) {
    this.ring = ring;
    this.parts = parts; // [{ seg, size }] (size = lo que estaba escrito al pedirlo)
    this.start = start; // tiempo del cuadro clave donde arranca
    this.released = false;
  }

  async *batches() {
    let started = false;
    for (const { seg, size } of this.parts) {
      if (!size) continue;
      const data = Buffer.allocUnsafe(size);
      let fh;
      try {
        fh = await fsp.open(seg.file, 'r');
      } catch (err) {
        if (err?.code === 'ENOENT') continue; // limpiaron la cache del launcher: se guarda lo que quede
        throw err;
      }
      let got = 0;
      try {
        while (got < size) {
          const { bytesRead } = await fh.read(data, got, size - got, got);
          if (!bytesRead) break;
          got += bytesRead;
        }
      } finally {
        await fh.close();
      }
      const out = [];
      for (const f of parseRecords(data.subarray(0, got))) {
        if (!started) {
          if (!(f.video && f.key && f.time >= this.start)) continue;
          started = true;
        }
        if (f.video || f.time >= this.start) out.push(f);
      }
      if (out.length) yield out;
    }
  }

  // Todos los cuadros juntos (para las pruebas)
  async frames() {
    const out = [];
    for await (const b of this.batches()) out.push(...b);
    return out;
  }

  release() {
    if (this.released) return;
    this.released = true;
    for (const { seg } of this.parts) {
      seg.pins--;
      this.ring.settle(seg);
    }
    this.ring.unretain();
  }
}

class ReplayRing {
  /**
   * dir = carpeta propia de este buffer (se crea sola y se borra con dispose()); seconds = largo de la repeticion;
   * unitsPerSecond = unidades de tiempo por segundo (MediaRecorder: 1000); onError(err) = fallo la escritura
   * (por ejemplo, disco lleno): el buffer deja de guardar y lo que tenia se puede guardar igual.
   */
  constructor({ dir, seconds = 60, unitsPerSecond = 1000, segmentSeconds = SEGMENT_SECONDS, maxBytes = MAX_BYTES, maxQueue = MAX_QUEUE, onError = null } = {}) {
    if (!dir) throw new Error('ring: falta la carpeta');
    this.dir = dir;
    this.unitsPerSecond = unitsPerSecond;
    this.segmentUnits = Math.max(1, segmentSeconds) * unitsPerSecond;
    this.maxBytes = maxBytes;
    this.maxQueue = maxQueue;
    this.onError = onError;
    this.seq = 0;
    this.queue = []; // [{ seg, head, bytes, size }] en orden de llegada
    this.queued = 0; // bytes en fila
    this.pump = null;
    this.error = null;
    this.closed = false;
    this.disposing = null;
    this.retained = 0; // guardados en curso: dispose() espera a que terminen
    this.retainWaiters = [];
    this.removals = new Set();
    this.skipping = false;
    this.skipped = 0;
    this.setSeconds(seconds);
    this.clear();
  }

  setSeconds(seconds) {
    this.seconds = Math.max(1, Number(seconds) || 60);
    this.window = this.seconds * this.unitsPerSecond;
    if (this.segments?.length) this.trim();
  }

  // Descarta todo lo guardado (los archivos se borran apenas nadie los este usando)
  clear() {
    for (const s of this.segments || []) this.drop(s);
    this.segments = [];
    this.current = null;
    this.bytes = 0;
    this.count = 0;
    this.newest = -Infinity;
    this.header = null;
  }

  // Encabezado del flujo actual (si cambia, lo guardado ya no sirve)
  setHeader(header) {
    this.clear();
    this.header = header;
  }

  get length() {
    return this.count;
  }

  // Segundos que hay guardados desde el primer cuadro clave
  get buffered() {
    const k = this.segments.find((s) => s.keys.length)?.keys[0];
    if (k === undefined || !Number.isFinite(this.newest)) return 0;
    return Math.max(0, (this.newest - k) / this.unitsPerSecond);
  }

  newSegment(start) {
    // El anterior ya no recibe nada: si no le queda nada en fila se cierra su archivo (si no, lo cierra la escritura)
    const prev = this.current;
    if (prev?.fh && !prev.jobs) {
      prev.fh.close().catch(() => {});
      prev.fh = null;
    }
    this.seq++;
    const seg = { file: path.join(this.dir, `seg-${String(this.seq).padStart(6, '0')}.bin`), start, end: start, keys: [], size: 0, written: 0, frames: 0, fh: null, jobs: 0, pins: 0, dropped: false, removed: false };
    this.segments.push(seg);
    this.current = seg;
    return seg;
  }

  add(frame) {
    if (this.closed || this.error) return;
    const isKey = Boolean(frame.video && frame.key);
    // El disco no da abasto: se saltea hasta el proximo cuadro clave en vez de juntarlo en memoria
    if (this.skipping || this.queued > this.maxQueue) {
      this.skipping = true;
      if (!isKey || this.queued > this.maxQueue / 2) {
        this.skipped++;
        return;
      }
      this.skipping = false;
    }
    if (frame.time > this.newest) this.newest = frame.time;
    let seg = this.current;
    const span = seg ? frame.time - seg.start : 0;
    // Se rota en un cuadro clave; sin cuadros clave (video quieto), igual cada tanto para poder descartar lo viejo
    if (!seg || (isKey && span >= this.segmentUnits) || span >= this.segmentUnits * 2) seg = this.newSegment(frame.time);
    if (isKey) seg.keys.push(frame.time);
    if (frame.time > seg.end) seg.end = frame.time;
    const size = RECORD_HEAD + frame.bytes.length;
    seg.size += size;
    seg.frames++;
    seg.jobs++;
    this.bytes += size;
    this.count++;
    this.queued += size;
    this.queue.push({ seg, head: recordHead(frame), bytes: frame.bytes, size });
    this.kick();
    this.trim();
  }

  // Descarta lo que sobra: se queda desde el segmento del ultimo cuadro clave anterior al corte (asi siempre hay N s)
  trim() {
    const cut = this.newest - this.window;
    let keep = 0;
    for (let i = 0; i < this.segments.length; i++) {
      const k = this.segments[i].keys[0];
      if (k === undefined) continue;
      if (k > cut) break;
      keep = i;
    }
    while (keep-- > 0) this.drop(this.segments.shift());
    // Sin cuadros clave por mucho tiempo (video quieto): tope duro de 4 veces el largo pedido; y tope de bytes
    const hardCut = this.newest - this.window * 4;
    while (this.segments.length > 1 && (this.segments[1].start <= hardCut || this.bytes > this.maxBytes)) this.drop(this.segments.shift());
  }

  drop(seg) {
    if (seg.dropped) return;
    seg.dropped = true;
    this.bytes -= seg.size;
    this.count -= seg.frames;
    this.settle(seg);
  }

  // Borra el archivo de un segmento descartado apenas nadie lo este escribiendo ni leyendo
  settle(seg) {
    if (!seg.dropped || seg.removed || seg.jobs > 0 || seg.pins > 0) return;
    seg.removed = true;
    const fh = seg.fh;
    seg.fh = null;
    const job = Promise.resolve(fh?.close())
      .catch(() => {})
      .then(() => fsp.rm(seg.file, { force: true, maxRetries: 2, retryDelay: 50 }))
      .catch((err) => console.warn('[capture] buffer:', err?.message || err))
      .finally(() => this.removals.delete(job));
    this.removals.add(job);
  }

  // ---------- Escritura (en fila, de a tandas) ----------

  kick() {
    if (this.pump || !this.queue.length || this.error) return;
    this.pump = this.drain().finally(() => {
      this.pump = null;
      this.kick();
    });
  }

  async drain() {
    try {
      await fsp.mkdir(this.dir, { recursive: true });
      while (this.queue.length && !this.error) {
        const seg = this.queue[0].seg;
        const parts = [];
        let size = 0;
        let n = 0;
        while (n < this.queue.length && this.queue[n].seg === seg && size < MAX_WRITE) {
          const q = this.queue[n++];
          parts.push(q.head, q.bytes);
          size += q.size;
        }
        this.queue.splice(0, n);
        this.queued -= size;
        try {
          // Si ya se descarto, no hace falta escribirlo
          if (!seg.dropped) await this.writeTo(seg, Buffer.concat(parts, size));
        } finally {
          seg.jobs -= n;
        }
        // Ya no le llega nada mas: se cierra el archivo (no queda un handle abierto por segmento)
        if (seg !== this.current && !seg.jobs && seg.fh) {
          const fh = seg.fh;
          seg.fh = null;
          await fh.close().catch(() => {});
        }
        this.settle(seg);
      }
    } catch (err) {
      this.fail(err);
    }
  }

  async writeTo(seg, buf) {
    if (!seg.fh) {
      try {
        seg.fh = await fsp.open(seg.file, 'a');
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
        // Limpiaron la cache del launcher mientras se jugaba: se vuelve a crear la carpeta
        await fsp.mkdir(this.dir, { recursive: true });
        seg.fh = await fsp.open(seg.file, 'a');
      }
    }
    let done = 0;
    while (done < buf.length) {
      const { bytesWritten } = await seg.fh.write(buf, done, buf.length - done);
      if (!bytesWritten) throw new Error('ring: no se pudo escribir');
      done += bytesWritten;
      seg.written += bytesWritten;
    }
  }

  // Fallo la escritura: lo que estaba en fila se pierde y no se guarda nada mas. Lo ya escrito sigue sirviendo.
  fail(err) {
    if (this.error) return;
    this.error = err;
    this.queued = 0;
    for (const q of this.queue.splice(0)) {
      q.seg.jobs--;
      this.settle(q.seg);
    }
    try {
      this.onError?.(err);
    } catch (e) {
      console.warn('[capture] buffer:', e?.message || e);
    }
  }

  // Espera a que este escrito todo lo que llego hasta ahora
  async sync() {
    while (this.pump) await this.pump;
  }

  // ---------- Guardar ----------

  /**
   * Lo necesario para guardar los ultimos `seconds` (por defecto los del buffer): desde el ultimo cuadro clave que
   * queda antes del corte, o el primero que haya si todavia no se junto tanto. null si no hay cuadros clave.
   * Hay que llamar a release() al terminar (si no, esos segmentos no se borran).
   */
  async snapshot(seconds = this.seconds) {
    await this.sync();
    if (!this.segments.length) return null;
    const cut = this.newest - Math.max(1, seconds) * this.unitsPerSecond;
    let start = null;
    let first = null;
    search: for (const s of this.segments) {
      for (const k of s.keys) {
        if (first === null) first = k;
        if (k > cut) break search;
        start = k;
      }
    }
    if (start === null) start = first;
    if (start === null) return null;
    const parts = this.segments.filter((s) => s.end >= start).map((seg) => ({ seg, size: seg.written }));
    for (const { seg } of parts) seg.pins++;
    this.retained++;
    return new ReplaySnapshot(this, parts, start);
  }

  // Mientras haya algo retenido, dispose() no borra nada (un guardado en curso termina aunque se cierre el juego)
  retain() {
    this.retained++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.unretain();
    };
  }

  unretain() {
    this.retained--;
    if (this.retained <= 0) this.retainWaiters.splice(0).forEach((fn) => fn());
  }

  // Deja de guardar, espera lo que se este guardando y borra la carpeta
  dispose() {
    if (this.disposing) return this.disposing;
    this.closed = true;
    this.disposing = (async () => {
      await this.sync();
      if (this.retained > 0) await new Promise((resolve) => this.retainWaiters.push(resolve));
      this.clear();
      await this.sync();
      await Promise.allSettled([...this.removals]);
      await fsp.rm(this.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch((err) => console.warn('[capture] buffer:', err?.message || err));
    })();
    return this.disposing;
  }
}

// Borra lo que haya quedado en la carpeta de los buffers (el launcher se cerro de golpe)
async function cleanRoot(root) {
  await fsp.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch((err) => console.warn('[capture] buffer:', err?.message || err));
}

module.exports = { ReplayRing, ReplaySnapshot, cleanRoot, parseRecords, recordHead, RECORD_HEAD, SEGMENT_SECONDS };
