// Cambio de tono en tiempo real para los efectos de voz: una linea de demora con dos lecturas que avanzan a otra velocidad
// y se cruzan con una ventana seno cuadrado (cada una suena mas fuerte justo cuando la otra salta). Cuando una lectura
// salta, busca el punto que mejor coincide con la que esta sonando: sin eso, en las voces graves las dos se cancelan y
// el tono oscila. Es logica pura: la usa voice/pitch-worklet.js en el hilo de audio y las pruebas en Node. No genera
// basura y la demora que agrega nunca pasa de la ventana mas la busqueda (40 ms; en promedio, la mitad).
export const PITCH_WINDOW_MS = 30;
export const PITCH_SEARCH_MS = 10; // un periodo de una voz de 100 Hz
const CORRELATE_MS = 5;

export class PitchShifter {
  // ratio: 0.75 baja una cuarta (440 Hz -> 330 Hz), 1 no cambia nada
  constructor({ sampleRate, ratio = 1, windowMs = PITCH_WINDOW_MS, searchMs = PITCH_SEARCH_MS } = {}) {
    const rate = sampleRate || 48000;
    this.window = Math.max(16, Math.round((rate * windowMs) / 1000));
    this.search = Math.max(0, Math.round((rate * searchMs) / 1000));
    this.corr = Math.max(8, Math.round((rate * CORRELATE_MS) / 1000));
    let size = 1;
    while (size < this.window + this.search + this.corr + 8) size *= 2;
    this.mask = size - 1;
    this.line = new Float32Array(size);
    this.setRatio(ratio);
    this.reset();
  }

  setRatio(ratio) {
    const r = Number(ratio);
    this.ratio = Number.isFinite(r) && r > 0 ? Math.max(0.25, Math.min(4, r)) : 1;
    // Por cada muestra nueva la lectura avanza "ratio" muestras: la demora crece (grave) o se achica (agudo) esto por ventana
    this.step = (1 - this.ratio) / this.window;
  }

  reset() {
    this.line.fill(0);
    this.write = 0;
    this.phase = 0;
    this.phase2 = 0.5;
    this.offset = 0;
    this.offset2 = 0;
  }

  read(delay) {
    const pos = this.write - delay;
    const base = Math.floor(pos);
    const frac = pos - base;
    const a = this.line[base & this.mask];
    const b = this.line[(base + 1) & this.mask];
    return a + (b - a) * frac;
  }

  // Cuanto correr la lectura que salta para que coincida con la otra (producto punto, salteando de a dos muestras)
  align(delay, otherDelay) {
    const { line, mask, write, search, corr } = this;
    const other = write - Math.round(otherDelay);
    const base = write - Math.round(delay);
    let best = 0;
    let bestOffset = 0;
    for (let o = 0; o <= search; o += 2) {
      let c = 0;
      for (let k = 0; k < corr; k += 2) c += line[(other - k) & mask] * line[(base - o - k) & mask];
      if (c > best) {
        best = c;
        bestOffset = o;
      }
    }
    return bestOffset;
  }

  // Procesa un bloque; input y output pueden ser el mismo arreglo
  process(input, output) {
    const n = output.length;
    const win = this.window;
    const step = this.step;
    const line = this.line;
    const mask = this.mask;
    for (let i = 0; i < n; i++) {
      line[this.write & mask] = input ? input[i] : 0;
      // sin^2 de las dos lecturas suma siempre 1: el volumen no ondula por la ventana
      const s1 = Math.sin(Math.PI * this.phase);
      const s2 = Math.sin(Math.PI * this.phase2);
      output[i] = this.read(this.phase * win + this.offset) * s1 * s1 + this.read(this.phase2 * win + this.offset2) * s2 * s2;
      this.phase += step;
      this.phase2 += step;
      if (this.phase >= 1 || this.phase < 0) {
        this.phase -= Math.floor(this.phase);
        this.offset = this.align(this.phase * win, this.phase2 * win + this.offset2);
      }
      if (this.phase2 >= 1 || this.phase2 < 0) {
        this.phase2 -= Math.floor(this.phase2);
        this.offset2 = this.align(this.phase2 * win, this.phase * win + this.offset);
      }
      this.write = (this.write + 1) & mask;
    }
  }
}

// Frecuencia dominante de una señal entre dos limites (DFT por barrido). Para las pruebas y para diagnosticar.
export function dominantFrequency(samples, sampleRate, minHz = 50, maxHz = 4000, stepHz = 1) {
  let best = 0;
  let bestHz = 0;
  for (let hz = minHz; hz <= maxHz; hz += stepHz) {
    const w = (2 * Math.PI * hz) / sampleRate;
    const coef = 2 * Math.cos(w);
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < samples.length; i++) {
      // Goertzel con ventana de Hann para que el pico sea limpio
      const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (samples.length - 1));
      const s = samples[i] * win + coef * s1 - s2;
      s2 = s1;
      s1 = s;
    }
    const power = s1 * s1 + s2 * s2 - coef * s1 * s2;
    if (power > best) {
      best = power;
      bestHz = hz;
    }
  }
  return bestHz;
}
