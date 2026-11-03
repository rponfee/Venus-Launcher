// Microfono local: captura con los filtros del sistema (eco, ganancia automatica y ruido si no hay RNNoise), volumen
// de entrada, supresion de ruido con RNNoise, medidor de nivel y compuerta por deteccion de voz (VAD). La pista que se
// envia a los demas sale de un MediaStreamDestination, asi que cambiar de microfono o de filtros no obliga a renegociar.
//
// Camino normal:   microfono -> volumen -> AudioWorklet (RNNoise + medidor + compuerta) -> salida
// Sin AudioWorklet: microfono -> volumen -> compuerta (GainNode manejado desde tick()) -> salida
// Si RNNoise no carga o se rompe, la llamada sigue con la supresion del navegador: nunca se corta por esto.
import { FLOOR_DB, rmsDb, VoiceGate } from './gate.js';
import { RNNOISE_RATE } from './rnnoise-core.js';

export { FLOOR_DB, rmsDb };

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

const LOAD_TIMEOUT_MS = 5000; // entrar a una sala no espera mas que esto por la supresion de ruido
const WORKLET_URL = new URL('./mic-worklet.js', import.meta.url);
const WASM_URL = new URL('../../vendor/rnnoise/rnnoise.wasm', import.meta.url);

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('tiempo de espera agotado')), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

// El binario se lee una sola vez; si falla, se reintenta la proxima vez que haga falta. Lo compila el worklet: desde
// una pagina file:// no se le puede pasar un WebAssembly.Module ya compilado.
let rnnoiseBytes = null;
export function loadRnnoiseBytes() {
  if (!rnnoiseBytes) {
    rnnoiseBytes = (async () => {
      const res = await fetch(WASM_URL);
      if (!res.ok) throw new Error(`rnnoise.wasm: ${res.status}`);
      return res.arrayBuffer();
    })();
    rnnoiseBytes.catch(() => {
      rnnoiseBytes = null;
    });
  }
  return rnnoiseBytes;
}

const workletLoads = new WeakMap();
function loadWorklet(ctx) {
  if (!workletLoads.has(ctx)) {
    const load = ctx.audioWorklet.addModule(WORKLET_URL);
    workletLoads.set(ctx, load);
    load.catch(() => workletLoads.delete(ctx));
  }
  return workletLoads.get(ctx);
}

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
    this.gateNode = ctx.createGain();
    this.gateNode.gain.value = 0;
    this.out = ctx.createGain();
    this.dest = ctx.createMediaStreamDestination();
    this.dest.channelCount = 1; // voz en mono: Opus no tiene que mezclar nada
    this.out.connect(this.dest);
    this.connectFallback();
    this.track = this.dest.stream.getAudioTracks()[0];
    try {
      this.track.contentHint = 'speech';
    } catch {
      /* sin soporte */
    }
    this.buf = new Float32Array(this.analyser.fftSize);
    this.gate = new VoiceGate();
    this.node = null; // AudioWorkletNode
    this.report = null; // ultimo nivel que aviso el worklet
    this.sentParams = '';
    this.denoising = false; // RNNoise esta limpiando el audio ahora
    this.rnnoiseReady = false;
    this.rnnoiseFailed = false;
    this.rnnoiseLoad = null;
    this.rnnoiseReply = null;
    this.capturedFilters = null;
    this.stopped = false;
    this.db = FLOOR_DB;
    this.gateOpen = false;
    this.speaking = false;
    this.monitor = null;
    this.recorder = null;
    this.fellBack = false;
    this.onEnded = null;
    this.onNoiseChange = null; // el motor de supresion cambio solo (RNNoise se rompio)
  }

  get stream() {
    return this.dest.stream;
  }

  get hasInput() {
    return Boolean(this.raw);
  }

  // Que supresion de ruido esta funcionando de verdad: 'rnnoise' | 'browser' | 'off'
  get noiseEngine() {
    if (this.opts.noiseMode === 'off') return 'off';
    return this.denoising ? 'rnnoise' : 'browser';
  }

  // Se pidio RNNoise pero no se pudo: se esta usando la del navegador
  get noiseFallback() {
    return this.opts.noiseMode === 'rnnoise' && !this.denoising;
  }

  async start(opts) {
    this.opts = { ...opts };
    this.input.gain.value = clampVolume(opts.inputVolume);
    await this.setupProcessor();
    await this.applyNoise();
    await this.capture();
  }

  connectFallback() {
    this.input.connect(this.analyser);
    this.input.connect(this.gateNode);
    this.gateNode.connect(this.out);
  }

  // Pasa el audio por el AudioWorklet; si no carga, queda el camino de respaldo y la voz funciona igual
  async setupProcessor() {
    if (this.node || !this.ctx.audioWorklet) return;
    try {
      await withTimeout(loadWorklet(this.ctx), LOAD_TIMEOUT_MS);
      if (this.stopped) return;
      const node = new AudioWorkletNode(this.ctx, 'venus-mic', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit' });
      node.port.onmessage = (e) => this.onProcessorMessage(e.data);
      node.onprocessorerror = () => this.onProcessorError();
      this.input.disconnect();
      this.gateNode.disconnect();
      this.gateNode.gain.value = 0;
      this.input.connect(node);
      node.connect(this.out);
      this.node = node;
    } catch (err) {
      console.warn('[voice] AudioWorklet no disponible, se usa la compuerta simple:', err?.message || err);
    }
  }

  onProcessorMessage(msg) {
    if (msg.type === 'level') this.report = msg;
    else if (msg.type === 'rnnoise') {
      if (this.rnnoiseReply) {
        const reply = this.rnnoiseReply;
        this.rnnoiseReply = null;
        reply(msg);
      } else if (!msg.ok) this.onDenoiserLost(msg.error);
    }
  }

  // El worklet murio: vuelve el camino de respaldo sin cortar la pista que reciben los demas
  onProcessorError() {
    console.warn('[voice] el AudioWorklet del micrófono falló');
    const node = this.node;
    this.node = null;
    this.report = null;
    this.gateOpen = false;
    try {
      this.input.disconnect();
      node?.disconnect();
    } catch {
      /* ya desconectado */
    }
    this.connectFallback();
    this.onDenoiserLost();
  }

  onDenoiserLost(detail) {
    if (detail) console.warn('[voice] RNNoise dejó de funcionar:', detail);
    this.rnnoiseReady = false;
    this.rnnoiseFailed = true;
    this.denoising = false;
    if (this.raw) this.capture().catch((err) => console.warn('[voice] microfono', err));
    this.onNoiseChange?.();
  }

  // Carga RNNoise en el worklet una sola vez. Devuelve si quedo listo; un fallo no tira error.
  loadDenoiser() {
    if (this.rnnoiseReady) return Promise.resolve(true);
    if (!this.node || this.rnnoiseFailed) return Promise.resolve(false);
    if (!this.rnnoiseLoad) {
      this.rnnoiseLoad = (async () => {
        if (this.ctx.sampleRate !== RNNOISE_RATE) throw new Error(`RNNoise necesita ${RNNOISE_RATE} Hz y el audio va a ${this.ctx.sampleRate} Hz`);
        const bytes = await withTimeout(loadRnnoiseBytes(), LOAD_TIMEOUT_MS);
        const reply = await withTimeout(
          new Promise((resolve) => {
            this.rnnoiseReply = resolve;
            this.node.port.postMessage({ type: 'rnnoise', bytes });
          }),
          LOAD_TIMEOUT_MS,
        );
        if (!reply.ok) throw new Error(reply.error);
        this.rnnoiseReady = true;
        return true;
      })()
        .catch((err) => {
          console.warn('[voice] RNNoise no disponible, se usa la supresión del navegador:', err?.message || err);
          this.rnnoiseFailed = true;
          this.rnnoiseReply = null;
          return false;
        })
        .finally(() => {
          this.rnnoiseLoad = null;
        });
    }
    return this.rnnoiseLoad;
  }

  async applyNoise() {
    const on = this.opts.noiseMode === 'rnnoise' && (await this.loadDenoiser());
    this.denoising = Boolean(on && this.node);
    this.node?.port.postMessage({ type: 'denoise', on: this.denoising });
  }

  // Con RNNoise activo se apaga la del navegador: dos supresores seguidos deforman la voz
  get browserNoise() {
    return this.opts.noiseMode === 'browser' || (this.opts.noiseMode === 'rnnoise' && !this.denoising);
  }

  // Los filtros que se le piden al navegador
  filtersKey() {
    const o = this.opts;
    return [o.echoCancellation !== false, this.browserNoise, o.autoGainControl !== false].join('|');
  }

  captureKey() {
    return `${this.opts.inputDevice ?? null}|${this.filtersKey()}`;
  }

  async capture() {
    const o = this.opts;
    const audio = {
      // 'all' cancela todo lo que suena en la PC. Con true, Chromium no tiene en cuenta lo que se reproduce por WebAudio
      // (la nivelacion de voces y el volumen de mas de 100 %), y los demas se escucharian a si mismos.
      echoCancellation: o.echoCancellation !== false ? { ideal: 'all' } : false,
      noiseSuppression: this.browserNoise,
      autoGainControl: o.autoGainControl !== false,
      channelCount: 1,
    };
    if (o.inputDevice && o.inputDevice !== 'default') audio.deviceId = { exact: o.inputDevice };
    // Mientras el microfono siga abierto, Chromium reusa esa captura con sus filtros de entonces: hay que soltarla antes.
    // Al cambiar de dispositivo no hace falta, y si el nuevo falla queda funcionando el anterior.
    if (this.raw && this.capturedFilters !== this.filtersKey()) this.release();
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
    this.capturedFilters = this.filtersKey();
    this.source = this.ctx.createMediaStreamSource(stream);
    this.source.connect(this.input);
    const track = stream.getAudioTracks()[0];
    track?.addEventListener('ended', () => {
      if (this.raw === stream) this.onEnded?.();
    });
  }

  // Aplica ajustes nuevos; vuelve a capturar solo si cambio el dispositivo o los filtros.
  async update(opts) {
    const before = this.captureKey();
    if (opts.noiseMode !== this.opts.noiseMode) this.rnnoiseFailed = false; // cambiar de modo es otra oportunidad
    this.opts = { ...opts };
    this.input.gain.setTargetAtTime(clampVolume(opts.inputVolume), this.ctx.currentTime, 0.02);
    await this.applyNoise();
    if (this.raw && this.captureKey() !== before) await this.capture();
  }

  // Escucharse a uno mismo (prueba de microfono): lo mismo que reciben los demas
  setMonitor(on) {
    if (on && !this.monitor) {
      this.monitor = this.ctx.createGain();
      this.monitor.gain.value = 1;
      this.out.connect(this.monitor);
      this.monitor.connect(this.ctx.destination);
    } else if (!on && this.monitor) {
      this.out.disconnect(this.monitor);
      this.monitor.disconnect();
      this.monitor = null;
    }
  }

  // Graba unos segundos de lo que reciben los demas (con RNNoise y compuerta). Devuelve un Blob.
  recordClip(ms) {
    return new Promise((resolve, reject) => {
      const mimeType = 'audio/webm;codecs=opus';
      const rec = new MediaRecorder(this.dest.stream, MediaRecorder.isTypeSupported(mimeType) ? { mimeType, audioBitsPerSecond: 128000 } : {});
      const chunks = [];
      const timer = setTimeout(() => this.stopRecording(), ms);
      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      rec.onerror = (e) => {
        clearTimeout(timer);
        reject(e.error || new Error('MediaRecorder'));
      };
      rec.onstop = () => {
        clearTimeout(timer);
        this.recorder = null;
        resolve(new Blob(chunks, { type: rec.mimeType }));
      };
      this.recorder = rec;
      rec.start();
    });
  }

  stopRecording() {
    if (this.recorder?.state === 'recording') this.recorder.stop();
  }

  // Mide el nivel y abre o cierra la compuerta.
  // p: { vad: bool (deteccion de voz; false = pulsar para hablar), auto: bool, threshold: dB, transmit: bool, now: ms }
  tick(p) {
    if (this.node) {
      const key = `${p.vad}|${p.auto}|${p.threshold}|${p.transmit}`;
      if (key !== this.sentParams) {
        this.sentParams = key;
        this.node.port.postMessage({ type: 'params', vad: p.vad, auto: p.auto, threshold: p.threshold, transmit: p.transmit });
      }
      const r = this.report;
      this.db = this.raw && r ? r.db : FLOOR_DB;
      this.gateOpen = Boolean(r?.open);
      this.speaking = Boolean(r?.speaking && this.raw);
      return { db: this.db, threshold: r ? r.threshold : p.threshold, voiced: Boolean(r?.voiced), open: this.gateOpen };
    }
    // Sin worklet: la misma logica desde el hilo principal
    if (this.raw) {
      this.analyser.getFloatTimeDomainData(this.buf);
      this.db = rmsDb(this.buf);
    } else {
      this.db = FLOOR_DB;
    }
    const g = this.gate.update(this.db, p.now, p);
    if (g.open !== this.gateOpen) {
      this.gateOpen = g.open;
      this.gateNode.gain.setTargetAtTime(g.open ? 1 : 0, this.ctx.currentTime, g.open ? 0.004 : 0.045);
    }
    this.speaking = g.speaking;
    return { db: this.db, threshold: g.threshold, voiced: g.voiced, open: g.open };
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
    this.stopped = true;
    this.stopRecording();
    this.setMonitor(false);
    this.release();
    this.rnnoiseReply?.({ ok: false, error: 'detenido' });
    this.rnnoiseReply = null;
    if (this.node) {
      this.node.port.postMessage({ type: 'stop' });
      this.node.port.onmessage = null;
      this.node.onprocessorerror = null;
    }
    try {
      this.input.disconnect();
      this.gateNode.disconnect();
      this.node?.disconnect();
      this.out.disconnect();
    } catch {
      /* ya desconectado */
    }
    this.node = null;
    this.track.stop();
  }
}

function clampVolume(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(2, n)) : 1;
}
