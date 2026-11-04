// AudioWorklet del cambio de tono de los efectos de voz (voice/fx.js). Mismo patron que mic-worklet.js: un modulo propio
// de la app (la CSP solo deja cargar scripts de 'self') que importa la logica pura de pitch-core.js.
import { PitchShifter } from './pitch-core.js';

class VenusPitchProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.shifter = new PitchShifter({ sampleRate, ratio: options?.processorOptions?.ratio ?? 1 });
    this.silence = null;
    this.stopped = false;
    this.port.onmessage = (e) => {
      if (e.data?.type === 'ratio') this.shifter.setRatio(e.data.ratio);
      else if (e.data?.type === 'stop') this.stopped = true;
    };
  }

  process(inputs, outputs) {
    if (this.stopped) return false;
    const out = outputs[0]?.[0];
    if (!out) return true;
    let src = inputs[0]?.[0];
    if (!src) src = this.silence?.length === out.length ? this.silence : (this.silence = new Float32Array(out.length));
    this.shifter.process(src, out);
    return true;
  }
}

registerProcessor('venus-pitch', VenusPitchProcessor);
