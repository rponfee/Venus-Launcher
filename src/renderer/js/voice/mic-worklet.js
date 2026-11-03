// AudioWorklet del microfono: RNNoise (si esta activo), medidor y puerta de ruido en el hilo de audio. Asi la puerta
// reacciona dentro del bloque en el que empieza la voz (no se come el comienzo de las palabras) y no depende de que
// el hilo principal este libre. Sin RNNoise, el audio pasa sin ninguna demora.
import { createRnnoise, RNNOISE_FRAME } from './rnnoise-core.js';
import { FrameBridge } from './frames.js';
import { VoiceGate, LevelFollower } from './gate.js';

const REPORT_MS = 40; // cada cuanto se avisa el nivel al hilo principal
const ATTACK_S = 0.004; // la puerta abre casi al instante y cierra suave (los mismos tiempos de siempre)
const RELEASE_S = 0.045;

class VenusMicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.denoiser = null;
    this.denoiseOn = false;
    this.bridge = new FrameBridge(RNNOISE_FRAME);
    this.voiceProb = 0;
    this.onFrame = (frame) => {
      this.voiceProb = this.denoiser.process(frame);
    };
    this.gate = new VoiceGate();
    this.follower = null;
    this.gain = 0;
    this.attack = 1 - Math.exp(-1 / (ATTACK_S * sampleRate));
    this.release = 1 - Math.exp(-1 / (RELEASE_S * sampleRate));
    this.params = { vad: true, auto: true, threshold: -50, transmit: false, voiceProb: null };
    this.silence = null;
    this.sinceReport = 0;
    this.stopped = false;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(msg) {
    if (msg.type === 'params') {
      this.params.vad = msg.vad;
      this.params.auto = msg.auto;
      this.params.threshold = msg.threshold;
      this.params.transmit = msg.transmit;
    } else if (msg.type === 'rnnoise') {
      this.loadDenoiser(msg.bytes);
    } else if (msg.type === 'denoise') {
      const on = Boolean(msg.on && this.denoiser);
      if (on !== this.denoiseOn) this.bridge.reset();
      this.denoiseOn = on;
    } else if (msg.type === 'stop') {
      this.stopped = true;
      this.denoiser?.destroy();
      this.denoiser = null;
    }
  }

  async loadDenoiser(bytes) {
    try {
      if (!this.denoiser) {
        const module = await WebAssembly.compile(bytes);
        if (this.stopped) return;
        this.denoiser = createRnnoise(module);
      }
      this.bridge.reset();
      this.port.postMessage({ type: 'rnnoise', ok: true });
    } catch (err) {
      this.denoiser = null;
      this.denoiseOn = false;
      this.port.postMessage({ type: 'rnnoise', ok: false, error: String(err?.message || err) });
    }
  }

  process(inputs, outputs) {
    if (this.stopped) return false;
    const out = outputs[0]?.[0];
    if (!out) return true;
    const n = out.length;
    let src = inputs[0]?.[0];
    if (!src) src = this.silence?.length === n ? this.silence : (this.silence = new Float32Array(n));
    if (this.denoiseOn && this.denoiser) {
      try {
        this.bridge.process(src, out, this.onFrame);
      } catch (err) {
        // RNNoise se rompio en plena llamada: el audio sigue sin el y el hilo principal vuelve al filtro del navegador
        this.denoiser = null;
        this.denoiseOn = false;
        out.set(src);
        this.port.postMessage({ type: 'rnnoise', ok: false, error: String(err?.message || err) });
      }
    } else {
      out.set(src);
    }
    let sum = 0;
    for (let i = 0; i < n; i++) sum += out[i] * out[i];
    if (!this.follower) this.follower = new LevelFollower((n / sampleRate) * 1000);
    const db = this.follower.update(sum / n);
    this.params.voiceProb = this.denoiseOn && this.denoiser ? this.voiceProb : null;
    const g = this.gate.update(db, currentTime * 1000, this.params);
    const target = g.open ? 1 : 0;
    const coef = target > this.gain ? this.attack : this.release;
    let gain = this.gain;
    for (let i = 0; i < n; i++) {
      gain += (target - gain) * coef;
      out[i] *= gain;
    }
    this.gain = gain;
    this.sinceReport += (n / sampleRate) * 1000;
    if (this.sinceReport >= REPORT_MS) {
      this.sinceReport = 0;
      this.port.postMessage({ type: 'level', db, threshold: g.threshold, voiced: g.voiced, open: g.open, speaking: g.speaking });
    }
    return true;
  }
}

registerProcessor('venus-mic', VenusMicProcessor);
