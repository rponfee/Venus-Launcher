'use strict';
// Grabacion larga directo al archivo final: al empezar se escribe un encabezado provisorio que ocupa un lugar fijo
// (sin duracion ni indice, como lo deja MediaRecorder: si el launcher se cierra de golpe el video igual se
// reproduce), despues los Clusters a medida que llegan y al terminar se reescribe solo el principio con la
// duracion y el indice para poder adelantar. Asi terminar es instantaneo aunque el video pese varios GB.
// Sin Electron (se prueba con node:test).
const fsp = require('fs/promises');
const { Muxer, buildHead } = require('./webm');

const RESERVE = 512 * 1024; // lugar para Info, Tracks y el indice (~19.000 puntos: mas de 10 h con uno cada 2 s)

class RecordingFile {
  /**
   * file = ruta final; header = encabezado de WebmReader. Los cuadros anteriores al primer cuadro clave de video
   * se descartan (el video tiene que empezar en uno).
   */
  constructor(file, header, { reserve = RESERVE, frameDur = 0 } = {}) {
    this.file = file;
    this.header = header;
    this.reserve = reserve;
    this.frameDur = frameDur;
    this.fh = null;
    this.mux = null;
    this.offset = 0; // bytes de Clusters escritos
    this.cues = [];
    this.chain = Promise.resolve();
    this.error = null;
    this.started = false;
    this.base = null; // tiempo del primer cuadro clave (absoluto)
    this.finished = false;
  }

  get headSize() {
    return this.header.ebml.length + 4 + 8 + this.reserve;
  }

  async open() {
    this.fh = await fsp.open(this.file, 'wx');
    const head = buildHead({ header: this.header, reserve: this.reserve, clusterBytes: null });
    await this.fh.write(head.data, 0, head.data.length, 0);
    this.started = true;
  }

  // Agrega un cuadro (en orden de llegada). Las escrituras van en fila.
  add(frame) {
    if (this.finished || this.error) return;
    if (!this.mux) {
      if (!(frame.video && frame.key)) return; // esperando el primer cuadro clave
      this.base = frame.time;
      this.mux = new Muxer({ base: frame.time });
    } else if (!frame.video && frame.time < this.base) return;
    const closed = this.mux.add(frame);
    if (closed.length) this.queue(closed);
  }

  // Espera a que se escriba lo que esta en fila (para no juntar en memoria un clip entero mientras se guarda)
  drain() {
    return this.chain;
  }

  // Segundos grabados hasta ahora
  get duration() {
    return this.mux ? this.mux.last / 1000 : 0;
  }

  queue(clusters) {
    this.chain = this.chain.then(async () => {
      if (this.error) return;
      try {
        for (const c of clusters) {
          if (c.key) this.cues.push({ time: c.time, offset: this.offset });
          await this.fh.write(c.bytes, 0, c.bytes.length, this.headSize + this.offset);
          this.offset += c.bytes.length;
        }
      } catch (err) {
        this.error = err;
      }
    });
  }

  /**
   * Cierra el archivo: escribe lo que quedaba y el encabezado final. Devuelve { file, duration (ms), bytes, empty }.
   * empty = no llego ningun cuadro clave (el archivo queda vacio y conviene borrarlo).
   */
  async finish() {
    if (this.finished) return this.result;
    this.finished = true;
    const tail = this.mux?.flush();
    if (tail) this.queue([tail]);
    await this.chain;
    const duration = this.mux ? this.mux.last + this.frameDur : 0;
    try {
      if (this.fh && !this.error && this.offset > 0) {
        const head = buildHead({ header: this.header, cues: this.cues, duration, clusterBytes: this.offset, reserve: this.reserve });
        await this.fh.write(head.data, 0, head.data.length, 0);
      }
    } catch (err) {
      this.error = this.error || err;
    } finally {
      await this.fh?.close().catch(() => {});
      this.fh = null;
    }
    this.result = { file: this.file, duration, bytes: this.headSize + this.offset, empty: this.offset === 0, error: this.error };
    return this.result;
  }
}

module.exports = { RecordingFile, RESERVE };
