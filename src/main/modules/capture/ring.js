'use strict';
// Buffer circular de la repeticion instantanea: guarda los cuadros (de webm.js) de los ultimos N segundos y siempre
// desde un cuadro clave de video, asi lo que se guarda se puede reproducir desde el principio. Vive en memoria
// del proceso principal (Buffers fuera del heap de V8) y nunca toca el disco hasta que se guarda.
const { fromKeyframe } = require('./webm');

class ReplayRing {
  /**
   * seconds = largo de la repeticion; unitsPerSecond = unidades de tiempo por segundo (MediaRecorder: 1000).
   */
  constructor({ seconds = 30, unitsPerSecond = 1000 } = {}) {
    this.unitsPerSecond = unitsPerSecond;
    this.setSeconds(seconds);
    this.clear();
  }

  setSeconds(seconds) {
    this.seconds = Math.max(1, Number(seconds) || 30);
    this.window = this.seconds * this.unitsPerSecond;
  }

  clear() {
    this.frames = [];
    this.head = 0; // primer cuadro vigente (los anteriores se compactan de a ratos)
    this.bytes = 0;
    this.newest = -Infinity;
    this.header = null;
  }

  // Encabezado del flujo actual (si cambia, lo guardado ya no sirve)
  setHeader(header) {
    this.clear();
    this.header = header;
  }

  get length() {
    return this.frames.length - this.head;
  }

  // Segundos que hay guardados desde el primer cuadro clave
  get buffered() {
    const k = this.firstKey(this.head);
    if (k < 0 || !Number.isFinite(this.newest)) return 0;
    return Math.max(0, (this.newest - this.frames[k].time) / this.unitsPerSecond);
  }

  firstKey(from) {
    for (let i = from; i < this.frames.length; i++) if (this.frames[i].video && this.frames[i].key) return i;
    return -1;
  }

  add(frame) {
    this.frames.push(frame);
    this.bytes += frame.bytes.length;
    if (frame.time > this.newest) this.newest = frame.time;
    this.trim();
  }

  // Descarta lo que sobra: se queda desde el ultimo cuadro clave que esta antes del corte (asi siempre hay N s)
  trim() {
    const cut = this.newest - this.window;
    let keep = -1;
    for (let i = this.head; i < this.frames.length; i++) {
      const f = this.frames[i];
      if (f.time > cut) break;
      if (f.video && f.key) keep = i;
    }
    if (keep > this.head) {
      for (let i = this.head; i < keep; i++) {
        this.bytes -= this.frames[i].bytes.length;
        this.frames[i] = null;
      }
      this.head = keep;
    }
    // Sin cuadros clave por mucho tiempo (video quieto): tope duro de 4 veces el largo pedido
    const hardCut = this.newest - this.window * 4;
    while (this.length > 1 && this.frames[this.head].time < hardCut) {
      this.bytes -= this.frames[this.head].bytes.length;
      this.frames[this.head] = null;
      this.head++;
    }
    if (this.head > 4096 && this.head > this.frames.length / 2) {
      this.frames = this.frames.slice(this.head);
      this.head = 0;
    }
  }

  /**
   * Cuadros para guardar los ultimos `seconds` (por defecto los del buffer): desde el ultimo cuadro clave que
   * queda antes del corte, o el primero que haya si todavia no se junto tanto. [] si no hay cuadros clave.
   */
  snapshot(seconds = this.seconds) {
    const list = this.frames.slice(this.head);
    if (!list.length) return [];
    const cut = this.newest - Math.max(1, seconds) * this.unitsPerSecond;
    let from = -Infinity;
    for (const f of list) {
      if (f.time > cut) break;
      if (f.video && f.key) from = f.time;
    }
    return fromKeyframe(list, from);
  }
}

module.exports = { ReplayRing };
