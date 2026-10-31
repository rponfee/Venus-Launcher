// Microfono local: captura con los filtros del sistema (eco, ruido, ganancia automatica), volumen de
// entrada, medidor de nivel y compuerta por deteccion de voz (VAD). La pista que se envia a los demas
// sale de un MediaStreamDestination, asi que cambiar de microfono o de filtros no obliga a renegociar.
export const FLOOR_DB = -100;

export function rmsDb(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  const rms = Math.sqrt(sum / buf.length);
  return rms > 0 ? Math.max(FLOOR_DB, 20 * Math.log10(rms)) : FLOOR_DB;
}

// dB -> 0..1 para medidores (-80 dB = vacio, 0 dB = lleno)
export const dbToUnit = (db) => Math.min(1, Math.max(0, (db + 80) / 80));
export const unitToDb = (u) => Math.round(u * 80 - 80);

// Traduce errores de getUserMedia a un codigo estable
export function micErrorCode(err) {
  const name = err?.name || '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'micDenied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'noMic';
  if (name === 'NotReadableError' || name === 'AbortError') return 'micBusy';
  return 'micFailed';
}

const CAPTURE_KEYS = ['inputDevice', 'echoCancellation', 'noiseSuppression', 'autoGainControl'];

export class LocalMic {
  constructor(ctx) {
    this.ctx = ctx;
    this.raw = null;
    this.source = null;
    this.opts = {};
    this.input = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0;
    this.gate = ctx.createGain();
    this.gate.gain.value = 0;
    this.dest = ctx.createMediaStreamDestination();
    this.input.connect(this.analyser);
    this.input.connect(this.gate);
    this.gate.connect(this.dest);
    this.track = this.dest.stream.getAudioTracks()[0];
    try {
      this.track.contentHint = 'speech';
    } catch {
      /* sin soporte */
    }
    this.buf = new Float32Array(this.analyser.fftSize);
    this.db = FLOOR_DB;
    this.floor = -62;
    this.holdUntil = 0;
    this.gateOpen = false;
    this.speaking = false;
    this.monitor = null;
    this.fellBack = false;
    this.onEnded = null;
  }

  get stream() {
    return this.dest.stream;
  }

  get hasInput() {
    return Boolean(this.raw);
  }

  async start(opts) {
    this.opts = { ...opts };
    this.input.gain.value = clampVolume(opts.inputVolume);
    await this.capture();
  }

  async capture() {
    const o = this.opts;
    const audio = {
      echoCancellation: o.echoCancellation !== false,
      noiseSuppression: o.noiseSuppression !== false,
      autoGainControl: o.autoGainControl !== false,
      channelCount: 1,
    };
    if (o.inputDevice && o.inputDevice !== 'default') audio.deviceId = { exact: o.inputDevice };
    let stream;
    this.fellBack = false;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
    } catch (err) {
      if (!audio.deviceId || !['OverconstrainedError', 'NotFoundError'].includes(err?.name)) throw err;
      // El microfono elegido ya no esta: usar el predeterminado
      delete audio.deviceId;
      stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
      this.fellBack = true;
    }
    this.release();
    this.raw = stream;
    this.source = this.ctx.createMediaStreamSource(stream);
    this.source.connect(this.input);
    const track = stream.getAudioTracks()[0];
    track?.addEventListener('ended', () => {
      if (this.raw === stream) this.onEnded?.();
    });
  }

  // Aplica ajustes nuevos; vuelve a capturar solo si cambio el dispositivo o los filtros.
  async update(opts) {
    const recapture = this.raw && CAPTURE_KEYS.some((k) => (opts[k] ?? null) !== (this.opts[k] ?? null));
    this.opts = { ...opts };
    this.input.gain.setTargetAtTime(clampVolume(opts.inputVolume), this.ctx.currentTime, 0.02);
    if (recapture) await this.capture();
  }

  // Escucharse a uno mismo (prueba de microfono)
  setMonitor(on) {
    if (on && !this.monitor) {
      this.monitor = this.ctx.createGain();
      this.monitor.gain.value = 1;
      this.gate.connect(this.monitor);
      this.monitor.connect(this.ctx.destination);
    } else if (!on && this.monitor) {
      this.gate.disconnect(this.monitor);
      this.monitor.disconnect();
      this.monitor = null;
    }
  }

  // Mide el nivel y abre o cierra la compuerta.
  // p: { vad: bool (deteccion de voz; false = pulsar para hablar), auto: bool, threshold: dB, transmit: bool, now: ms }
  tick(p) {
    if (this.raw) {
      this.analyser.getFloatTimeDomainData(this.buf);
      this.db = rmsDb(this.buf);
    } else {
      this.db = FLOOR_DB;
    }
    // Piso de ruido: baja rapido, sube muy lento (para la sensibilidad automatica)
    if (this.db > FLOOR_DB + 1) this.floor += (this.db - this.floor) * (this.db < this.floor ? 0.25 : 0.004);
    const threshold = this.threshold(p);
    const above = this.db > threshold;
    if (above) this.holdUntil = p.now + 320;
    const voiced = above || p.now < this.holdUntil;
    const open = p.transmit && (p.vad ? voiced : true);
    if (open !== this.gateOpen) {
      this.gateOpen = open;
      this.gate.gain.setTargetAtTime(open ? 1 : 0, this.ctx.currentTime, open ? 0.004 : 0.045);
    }
    this.speaking = p.transmit && voiced && this.db > FLOOR_DB + 1;
    return { db: this.db, threshold, voiced, open };
  }

  threshold(p) {
    if (!p.vad || !p.auto) return p.threshold;
    return Math.min(-28, Math.max(-62, this.floor + 13));
  }

  release() {
    try {
      this.source?.disconnect();
    } catch {
      /* ya desconectado */
    }
    for (const tr of this.raw?.getTracks() || []) tr.stop();
    this.raw = null;
    this.source = null;
  }

  stop() {
    this.setMonitor(false);
    this.release();
    try {
      this.input.disconnect();
      this.gate.disconnect();
    } catch {
      /* ya desconectado */
    }
    this.track.stop();
  }
}

function clampVolume(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(2, n)) : 1;
}
