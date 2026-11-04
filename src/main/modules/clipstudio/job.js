'use strict';
// Un video que se esta armando (montaje o timelapse): escribe a <archivo>.part con RecordingFile y al terminar lo
// renombra, asi un corte a la mitad nunca aparece como un clip en la galeria. Sin Electron: se prueba con node:test.
//   - Unir sin recodificar: copyAll() pasa los tramos de los clips al archivo, de a pedazos.
//   - Recodificar: la interfaz pide los cuadros de video de cada tramo (openSegment + readVideo), los decodifica y los
//     vuelve a codificar, y los devuelve con addEncoded. El audio no se toca: queda aca y se mezcla por tiempo.
//   - Lo que sale de un VideoEncoder sin clips detras (timelapse, placa de titulo) tambien entra por addEncoded.
const fsp = require('fs/promises');
const { RecordingFile } = require('../capture/recording');
const join = require('./webmjoin');

const RESERVE = 128 * 1024; // Info, Tracks y mas de 4000 puntos del indice
const MAX_READ_BYTES = 8 * 1024 * 1024;

function sameAudio(a, b) {
  return Boolean(a && b) && a.codec === b.codec && a.channels === b.channels && a.rate === b.rate && a.priv === b.priv;
}

class VideoJob {
  /**
   * file = ruta final; header = el de WebmReader o el de encodedHeader; tracks = { video, audio }.
   * segments = [{ path, start, length, probe }] (solo un montaje). template = el clip de donde sale el audio.
   */
  constructor({ file, header, tracks, segments = [], template = null, frameDur = join.FRAME_MS }) {
    this.file = file;
    this.part = `${file}.part`;
    this.header = header;
    this.tracks = tracks;
    this.segments = segments;
    this.template = template;
    this.rec = new RecordingFile(this.part, header, { reserve: RESERVE, frameDur });
    this.end = 0; // donde termina lo escrito hasta ahora (ms)
    this.lastVideo = 0;
    this.audio = []; // audio del tramo que se esta recodificando, esperando su lugar
    this.reading = null; // { iter, pendingFrame, done }
    this.controller = new AbortController();
    this.closed = false;
    this.touched = Date.now();
  }

  get cancelled() {
    return this.controller.signal.aborted;
  }

  async open() {
    await this.rec.open();
  }

  check() {
    if (this.rec.error) throw this.rec.error;
  }

  // Cuadros ya codificados: [{ time (ms), key, data }]. Antes de cada uno entra el audio que le toca.
  async addEncoded(frames) {
    this.touched = Date.now();
    this.check();
    for (const f of Array.isArray(frames) ? frames : []) {
      const time = Math.max(0, Math.round(Number(f?.time) || 0));
      if (!f?.data?.byteLength) continue;
      while (this.audio.length && this.audio[0].time <= time) this.rec.add(this.audio.shift());
      this.rec.add(join.encodedFrame(this.tracks.video, time, f.key === true, f.data));
      if (time > this.lastVideo) this.lastVideo = time;
      if (time + join.FRAME_MS > this.end) this.end = time + join.FRAME_MS;
    }
    await this.rec.drain();
    this.check();
  }

  flushAudio() {
    while (this.audio.length) this.rec.add(this.audio.shift());
  }

  // ---------- Unir sin recodificar ----------

  // Copia todos los tramos. onProgress({ done, total }) en segundos.
  async copyAll(onProgress) {
    const total = this.segments.reduce((sum, s) => sum + (s.length ?? s.probe?.duration ?? 0), 0);
    let before = 0;
    for (const seg of this.segments) {
      if (this.cancelled) return;
      this.touched = Date.now();
      this.end = await join.copySegment(this.rec, seg, {
        offset: this.end,
        tracks: this.tracks,
        signal: this.controller.signal,
        onProgress: (sec) => {
          this.touched = Date.now();
          onProgress?.({ done: before + sec, total });
        },
      });
      before += seg.length ?? seg.probe?.duration ?? 0;
    }
    onProgress?.({ done: total, total });
  }

  // ---------- Recodificar ----------

  // Abre el tramo i: lo anterior ya termino, asi que su audio entra entero y este arranca despues
  openSegment(i) {
    this.touched = Date.now();
    this.flushAudio();
    const seg = this.segments[i];
    if (!seg) throw new Error('segment');
    this.reading = {
      iter: join.segmentFrames(seg.path, { start: seg.start, length: seg.length, signal: this.controller.signal })[Symbol.asyncIterator](),
      offset: this.end,
      seg,
      useAudio: sameAudio(seg.probe?.audio, this.template?.audio),
    };
    return { codec: seg.probe?.codec, width: seg.probe?.width, height: seg.probe?.height, offset: this.reading.offset, length: seg.length ?? seg.probe?.duration ?? 0 };
  }

  // Los proximos cuadros de video del tramo: { frames: [{ time, key, data }], done }. El audio se queda aca.
  async readVideo(max = 24) {
    this.touched = Date.now();
    const r = this.reading;
    if (!r) return { frames: [], done: true };
    const frames = [];
    let bytes = 0;
    while (frames.length < max && bytes < MAX_READ_BYTES) {
      const { value: f, done } = await r.iter.next();
      if (done) {
        this.reading = null;
        return { frames, done: true };
      }
      const time = r.offset + f.time;
      if (f.video) {
        const data = join.framePayload(f);
        frames.push({ time, key: f.key === true, data });
        bytes += data.length;
        if (time + join.FRAME_MS > this.end) this.end = time + join.FRAME_MS;
      } else if (r.useAudio && this.tracks.audio) {
        const out = join.withTrack(f, this.tracks.audio);
        this.audio.push({ ...out, bytes: Buffer.from(out.bytes), time });
        if (time + join.FRAME_MS > this.end) this.end = time + join.FRAME_MS;
      }
    }
    return { frames, done: false };
  }

  // ---------- Terminar ----------

  // { file, duration (segundos) } o lanza. empty: no llego ningun cuadro clave.
  async finish() {
    this.flushAudio();
    const res = await this.rec.finish();
    this.closed = true;
    if (res.error) {
      await fsp.rm(this.part, { force: true }).catch(() => {});
      throw res.error;
    }
    if (res.empty) {
      await fsp.rm(this.part, { force: true }).catch(() => {});
      throw Object.assign(new Error('empty'), { code: 'empty' });
    }
    await fsp.rename(this.part, this.file);
    return { file: this.file, duration: Math.round((res.duration / 1000) * 10) / 10 };
  }

  async abort() {
    this.controller.abort();
    if (!this.closed) {
      this.closed = true;
      await this.rec.finish().catch(() => {});
    }
    await fsp.rm(this.part, { force: true }).catch(() => {});
  }
}

module.exports = { VideoJob, RESERVE, sameAudio };
