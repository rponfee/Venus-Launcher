// Puente entre los bloques del AudioWorklet (128 muestras) y los cuadros de RNNoise (480). Agrega la menor demora
// posible: con 128/480 alcanzan 512 muestras (10,7 ms) para que nunca falte audio a la salida.
function gcd(a, b) {
  return b ? gcd(b, a % b) : a;
}

export class FrameBridge {
  constructor(frameSize) {
    this.frameSize = frameSize;
    this.frame = new Float32Array(frameSize);
    this.quantum = 0;
    this.delay = 0;
    this.ring = null;
    this.reset();
  }

  reset() {
    this.fill = 0;
    this.seen = 0;
    this.started = false;
    this.readAt = 0;
    this.writeAt = 0;
    this.avail = 0;
  }

  // Demora mas chica que garantiza salida continua: el peor resto sin procesar, redondeado a bloques enteros
  configure(quantum) {
    this.quantum = quantum;
    const worstLeft = this.frameSize - gcd(this.frameSize, quantum);
    this.delay = Math.ceil(worstLeft / quantum) * quantum;
    this.ring = new Float32Array(this.frameSize * 2 + quantum * 2);
    this.reset();
  }

  // Entra input y sale output (mismo largo). onFrame(frame) procesa cada cuadro completo en el lugar.
  process(input, output, onFrame) {
    const n = input.length;
    if (n !== this.quantum) this.configure(n);
    const { frame, frameSize, ring } = this;
    for (let i = 0; i < n; i++) {
      frame[this.fill++] = input[i];
      if (this.fill === frameSize) {
        this.fill = 0;
        onFrame(frame);
        for (let k = 0; k < frameSize; k++) {
          ring[this.writeAt] = frame[k];
          if (++this.writeAt === ring.length) this.writeAt = 0;
        }
        this.avail += frameSize;
      }
    }
    this.seen += n;
    if (!this.started && this.seen > this.delay) this.started = true;
    for (let i = 0; i < n; i++) {
      if (this.started && this.avail > 0) {
        output[i] = ring[this.readAt];
        if (++this.readAt === ring.length) this.readAt = 0;
        this.avail--;
      } else {
        output[i] = 0;
      }
    }
  }
}
